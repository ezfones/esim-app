import crypto from "crypto";
import { sendEsimEmail } from "../../lib/send-esim-email";

export const config = {
  api: { bodyParser: false }, // required for Shopify HMAC verification
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function verifyShopifyWebhook(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) throw new Error("Missing SHOPIFY_WEBHOOK_SECRET");
  if (!hmacHeader) return false;

  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// --- eSIM Go helpers (adjust endpoint if your account uses a different base) ---
const ESIMGO_BASE_URL = "https://api.esim-go.com/v2.4";

function esimGoHeaders() {
  const key = process.env.ESIMGO_API_KEY;
  if (!key) throw new Error("Missing ESIMGO_API_KEY");
  return {
    "Content-Type": "application/json",
    "X-API-Key": key,
    Accept: "application/json",
  };
}

async function esimGoCreateOrder({ item, quantity }) {
  const url = `${ESIMGO_BASE_URL}/orders?includeIccids=true`;

  const body = {
    type: "transaction",
    assign: true,
    order: [
      {
        type: "bundle",
        quantity: quantity || 1,
        item,
      },
    ],
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: esimGoHeaders(),
    body: JSON.stringify(body),
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`eSIM Go /orders error: ${JSON.stringify(json)}`);
  return json;
}

async function esimGoGetAssignments(orderReference) {
  const url = `${ESIMGO_BASE_URL}/esims/assignments?reference=${encodeURIComponent(orderReference)}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: esimGoHeaders(),
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`eSIM Go /esims/assignments error: ${JSON.stringify(json)}`);
  return json;
}

function buildLpaString(smdpAddress, matchingId) {
  return `LPA:1$${smdpAddress}$${matchingId}`;
}

function buildAppleInstallLink(lpaString) {
  return `https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(lpaString)}`;
}

function buildQrImageUrl(lpaString) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(lpaString)}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const rawBody = await getRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];

    const valid = verifyShopifyWebhook(rawBody, hmac);
    if (!valid) return res.status(401).send("Invalid webhook signature");

    const payload = JSON.parse(rawBody.toString("utf8"));

    // --- Pull what we need directly from the webhook payload (no Admin API) ---
    const orderName = payload && payload.name ? payload.name : `Order ${payload && payload.id ? payload.id : ""}`;
    const toEmail = payload && payload.email ? payload.email : null;

    const firstName = payload && payload.customer ? payload.customer.first_name : "";
    const lastName = payload && payload.customer ? payload.customer.last_name : "";
    const customerName = `${firstName || ""} ${lastName || ""}`.trim() || "there";

    const firstItem = payload && payload.line_items && payload.line_items.length ? payload.line_items[0] : null;
    if (!firstItem) throw new Error("No line items on order payload");

    const productTitle = firstItem.title || "eSIM";
    const quantity = firstItem.quantity || 1;

    // We use SKU as the eSIM Go bundle name (your setup)
    const bundleName = firstItem.sku;
    if (!toEmail) throw new Error("Order payload missing customer email");
    if (!bundleName) throw new Error("Line item missing SKU (used as eSIM Go bundle name)");

    // --- eSIM Go provision ---
    const orderResp = await esimGoCreateOrder({ item: bundleName, quantity });

    const orderReference =
      orderResp.orderReference ||
      orderResp.reference ||
      orderResp.order_reference;

    if (!orderReference) {
      throw new Error(`eSIM Go response missing orderReference: ${JSON.stringify(orderResp)}`);
    }

    const assignResp = await esimGoGetAssignments(orderReference);

    const first =
      (assignResp.assignments && assignResp.assignments[0]) ||
      (assignResp.data && assignResp.data[0]) ||
      (Array.isArray(assignResp) ? assignResp[0] : null);

    if (!first) throw new Error(`No assignments returned: ${JSON.stringify(assignResp)}`);

    const iccid = first.iccid || first.ICCID;
    const smdpAddress = first.smdpAddress || first.smdp_address || first.smdp;
    const matchingId = first.matchingId || first.matching_id || first.matching;

    if (!iccid || !smdpAddress || !matchingId) {
      throw new Error(`Missing install fields from assignments: ${JSON.stringify(assignResp)}`);
    }

    const lpaString = buildLpaString(smdpAddress, matchingId);
    const iosInstallUrl = buildAppleInstallLink(lpaString);
    const qrCodeUrl = buildQrImageUrl(lpaString);

    await sendEsimEmail({
      to: toEmail,
      subject: `Your eSIM is ready – ${orderName}`,
      payload: {
        customerName,
        productTitle,
        iccid,
        qrCodeUrl,
        iosInstallUrl,
        smdpAddress,
        matchingId,
        lpaString,
      },
    });

    return res.status(200).json({ ok: true, orderReference, iccid });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
