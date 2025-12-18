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

/**
 * eSIM Go provisioning (adjust endpoint/fields to match your eSIM Go account)
 */
async function provisionEsimWithEsimGo({ reference, sku, quantity }) {
  if (!process.env.ESIMGO_API_KEY) throw new Error("Missing ESIMGO_API_KEY");
  if (!sku) throw new Error("Missing SKU for eSIM provisioning");

  const resp = await fetch("https://api.esimgo.com/v1/esims/provision", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.ESIMGO_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      reference,
      sku,
      quantity: quantity || 1,
    }),
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`eSIM Go error: ${JSON.stringify(json)}`);

  const esim = json?.esims?.[0];
  if (!esim) throw new Error("No eSIM returned from provider");

  return {
    iccid: esim.iccid,
    qrCodeUrl: esim.qr_code_url,
    iosInstallUrl: esim.ios_install_url,
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const rawBody = await getRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];

    const valid = verifyShopifyWebhook(rawBody, hmac);
    if (!valid) return res.status(401).send("Invalid webhook signature");

    const payload = JSON.parse(rawBody.toString("utf8"));

    // Pull everything we need directly from the webhook payload
    const orderName = payload?.name || `Order ${payload?.id || ""}`;
    const toEmail = payload?.email;
    const customerName =
      [payload?.customer?.first_name, payload?.customer?.last_name].filter(Boolean).join(" ") || "there";

    const firstItem = payload?.line_items?.[0];
    if (!firstItem) throw new Error("No line items on order payload");

    const sku = firstItem?.sku;
    const productTitle = firstItem?.title || "eSIM";
    const quantity = firstItem?.quantity || 1;

    if (!toEmail) throw new Error("Order payload missing customer email");
    if (!sku) throw new Error("Line item missing SKU (needed to provision eSIM)");

    // Provision eSIM
    const esim = await provisionEsimWithEsimGo({
      reference: orderName,
      sku,
      quantity,
    });

    // Email customer (backup channel)
    await sendEsimEmail({
      to: toEmail,
      subject: `Your eSIM is ready – ${orderName}`,
      payload: {
        customerName,
        productTitle,
        iccid: esim.iccid,
        qrCodeUrl: esim.qrCodeUrl,
        iosInstallUrl: esim.iosInstallUrl,
      },
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
