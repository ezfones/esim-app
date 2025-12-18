import crypto from "crypto";
import { sendEsimEmail } from "../../lib/send-esim-email";

export const config = {
  api: { bodyParser: false }, // REQUIRED for Shopify HMAC verification
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function verifyShopifyWebhook(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) throw new Error("Missing SHOPIFY_WEBHOOK_SECRET");

  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");

  // If header missing, fail safely
  if (!hmacHeader) return false;

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

async function shopifyGraphQL(query, variables) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN; // ✅ your existing var
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN; // ✅ your existing var
  const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || "2024-07"; // ✅ your existing var (or fallback)

  if (!domain || !token) {
    throw new Error(`Missing Shopify Admin credentials. domain=${!!domain} token=${!!token}`);
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
 * TODO: Replace this with your REAL eSIM Go lookup.
 * For now it's a placeholder so the webhook/email pipeline can be proven.
 */
async function getEsimDetailsForOrder(order) {
  const firstItem = order?.lineItems?.edges?.[0]?.node;

  return {
    productTitle: firstItem?.title || "eSIM",
    iccid: "8988XXXXXXXXXXXXXXX",
    qrCodeUrl: "https://example.com/qr-code.png",
    iosInstallUrl: "https://example.com/ios-install-link",
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

    // REST webhook payload.id is numeric; GraphQL needs a gid
    const orderGid = `gid://shopify/Order/${payload.id}`;

    const order = await getOrder(orderGid);

    const esim = await getEsimDetailsForOrder(order);

    const customerName = [order?.customer?.firstName, order?.customer?.lastName]
      .filter(Boolean)
      .join(" ");

    // Send email (backup channel)
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
