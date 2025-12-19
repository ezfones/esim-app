import crypto from "crypto";
import { sendEsimEmail } from "../../lib/send-esim-email";

export const config = {
  api: { bodyParser: false },
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

// -------------------- Shopify Admin GraphQL (WRITE ONLY) --------------------

function getShopifyDomain() {
  return (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").trim();
}

function getShopifyToken() {
  return (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim();
}

function getShopifyApiVersion() {
  return (process.env.SHOPIFY_ADMIN_API_VERSION || "2024-07").trim();
}

async function shopifyGraphQL(query, variables) {
  const domain = getShopifyDomain();
  const token = getShopifyToken();
  const version = getShopifyApiVersion();

  if (!domain || !token) {
    throw new Error(`Missing Shopify Admin credentials. domain=${!!domain} token=${!!token}`);
  }

  const resp = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json();

  if (!resp.ok || json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors || json)}`);
  }

  return json.data;
}

async function writeOrderMetafields(orderGid, fields) {
  const mutation = `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key type value }
        userErrors { field message }
      }
    }
  `;

  const metafields = [
    { namespace: "esim", key: "iccid", type: "single_line_text_field", value: fields.iccid || "" },
    { namespace: "esim", key: "smdp_address", type: "single_line_text_field", value: fields.smdpAddress || "" },
    { namespace: "esim", key: "matching_id", type: "single_line_text_field", value: fields.matchingId || "" },
    { namespace: "esim", key: "lpa", type: "single_line_text_field", value: fields.lpaString || "" },
    { namespace: "esim", key: "order_reference", type: "single_line_text_field", value: fields.orderReference || "" },
    { namespace: "esim", key: "bundle", type: "single_line_text_field", value: fields.bundleName || "" },

    // URLs
    { namespace: "esim", key: "qr_url", type: "url", value: fields.qrCodeUrl || "" },
    { namespace: "esim", key: "ios_install_url", type: "url", value: fields.iosInstallUrl || "" },
  ].map((m) => ({ ...m, ownerId: orderGid }));

  const data = await shopifyGraphQL(mutation, { metafields });

  const errors = data?.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(`Shopify metafieldsSet userErrors: ${JSON.stringify(errors)}`);
  }

  return data.metafieldsSet.metafields;
}

// -------------------- eSIM Go --------------------

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
        item, // bundle name
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

// -------------------- Handler --------------------

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const rawBody = await getRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];

    const valid = verifyShopifyWebhook(rawBody, hmac);
    if (!valid) return res.status(401).send("Invalid webhook signature");

    const payload = JSON.parse(rawBody.toString("utf8"));

    // Shopify Order GID (no read needed)
    const orderIdNumeric = payload?.id;
    if (!orderIdNumeric) throw new Error("Webhook payload missing order id");

    const orderGid = `gid://shopify/Order/${orderIdNumeric}`;

    const orderName = payload?.name || `Order ${orderIdNumeric}`;
    const toEmail = payload?.email || null;

    const firstName = payload?.customer?.first_name || "";
    const lastName = payload?.customer?.last_name || "";
    const customerName = `${firstName} ${lastName}`.trim() || "there";

    const firstItem = payload?.line_items?.[0] || null;
    if (!firstItem) throw new Error("No line items on order payload");

    const productTitle = firstItem.title || "eSIM";
    const quantity = firstItem.quantity || 1;

    // Using SKU as eSIM Go bundle name (your setup)
    const bundleName = firstItem.sku;
    if (!bundleName) throw new Error("Line item missing SKU (used as eSIM Go bundle name)");
    if (!toEmail) throw new Error("Order payload missing customer email");

    // 1) Provision via eSIM Go
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
      (assignResp?.assignments && assignResp.assignments[0]) ||
      (assignResp?.data && assignResp.data[0]) ||
      (Array.isArray(assignResp) ? assignResp[0] : null);

    if (!first) throw new Error(`No assignments returned: ${JSON.stringify(assignResp)}`);

    const iccid = first.iccid || first.ICCID;
    const matchingId = first.matchingId || first.matching_id || first.matching;

    // Your response uses rspUrl as the SM-DP+/RSP address
    const smdpAddress =
      first.rspUrl || first.rsp_url || first.smdpAddress || first.smdp_address || first.smdp;

    if (!iccid || !smdpAddress || !matchingId) {
      throw new Error(`Missing install fields: ${JSON.stringify(first)}`);
    }

    const lpaString = buildLpaString(smdpAddress, matchingId);
    const iosInstallUrl = buildAppleInstallLink(lpaString);
    const qrCodeUrl = buildQrImageUrl(lpaString);

    // 2) Write metafields to Shopify order ✅
    await writeOrderMetafields(orderGid, {
      iccid,
      smdpAddress,
      matchingId,
      lpaString,
      qrCodeUrl,
      iosInstallUrl,
      orderReference,
      bundleName,
    });

    // 3) Email (backup)
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
