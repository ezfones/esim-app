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

function getShopifyDomain() {
  return (
    process.env.SHOPIFY_STORE_DOMAIN ||
    process.env.SHOPIFY_SHOP_DOMAIN ||
    process.env.SHOPIFY_SHOP ||
    process.env.SHOP_DOMAIN ||
    ""
  ).replace(/^https?:\/\//, "").trim();
}

function getShopifyAdminToken() {
  return (
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || // your current var
    process.env.SHOPIFY_ADMIN_TOKEN ||
    process.env.SHOPIFY_ACCESS_TOKEN ||
    process.env.SHOPIFY_ADMIN_API_TOKEN ||
    ""
  ).trim();
}

function getShopifyApiVersion() {
  return (process.env.SHOPIFY_ADMIN_API_VERSION || "2024-07").trim();
}

async function shopifyGraphQL(query, variables) {
  const domain = getShopifyDomain();
  const token = getShopifyAdminToken();
  const apiVersion = getShopifyApiVersion();

  if (!domain || !token) {
    throw new Error(
      `Missing Shopify Admin credentials. domain=${!!domain} token=${!!token}`
    );
  }

  const resp = await fetch(`https://${domain}/admin/api/${apiVersion}/graphql.json`, {
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

async function getOrder(orderGid) {
  const query = `
    query GetOrder($id: ID!) {
      order(id: $id) {
        id
        name
        email
        customer { firstName lastName }
        lineItems(first: 50) {
          edges {
            node {
              title
              sku
              quantity
            }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { id: orderGid });
  return data.order;
}

/**
 * eSIM Go provisioning (replace endpoint/fields to match your account if needed)
 */
async function getEsimDetailsForOrder(order) {
  if (!process.env.ESIMGO_API_KEY) {
    throw new Error("Missing ESIMGO_API_KEY");
  }

  const firstItem = order?.lineItems?.edges?.[0]?.node;
  if (!firstItem?.sku) {
    throw new Error("Missing SKU for eSIM lookup");
  }

  // Provision eSIM with provider
  const resp = await fetch("https://api.esimgo.com/v1/esims/provision", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.ESIMGO_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      reference: order.name,
      sku: firstItem.sku,
      quantity: firstItem.quantity || 1,
    }),
  });

  const json = await resp.json();

  if (!resp.ok) {
    throw new Error(`eSIM Go error: ${JSON.stringify(json)}`);
  }

  const esim = json.esims?.[0];
  if (!esim) throw new Error("No eSIM returned from provider");

  return {
    productTitle: firstItem.title,
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

    const orderGid = `gid://shopify/Order/${payload.id}`;
    const order = await getOrder(orderGid);

    const esim = await getEsimDetailsForOrder(order);

    const customerName = [order?.customer?.firstName, order?.customer?.lastName]
      .filter(Boolean)
      .join(" ");

    await sendEsimEmail({
      to: order.email,
      subject: `Your eSIM is ready – ${order.name}`,
      payload: {
        customerName,
        productTitle: esim.productTitle,
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
