import crypto from "crypto";
import { sendEsimEmail } from "../../lib/send-esim-email";

export const config = {
  api: {
    bodyParser: false, // REQUIRED for Shopify signature verification
  },
};

/**
 * Read raw request body
 */
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Verify Shopify webhook signature
 */
function verifyShopifyWebhook(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) throw new Error("Missing SHOPIFY_WEBHOOK_SECRET");

  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(hash),
    Buffer.from(hmacHeader || "", "utf8")
  );
}

/**
 * Shopify Admin GraphQL helper
 */
async function shopifyGraphQL(query, variables) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!domain || !token) {
    throw new Error("Missing Shopify Admin credentials");
  }

  const res = await fetch(
    `https://${domain}/admin/api/2024-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const json = await res.json();
  if (json.errors) {
    throw new Error(JSON.stringify(json.errors));
  }

  return json.data;
}

/**
 * Fetch order details
 */
async function getOrder(orderGid) {
  const query = `
    query ($id: ID!) {
      order(id: $id) {
        id
        name
        email
        customer {
          firstName
          lastName
        }
        lineItems(first: 10) {
          edges {
            node {
              title
              sku
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
 * TODO: Replace with REAL eSIM Go lookup
 */
async function getEsimDetails(order) {
  const item = order.lineItems.edges[0]?.node;

  return {
    productTitle: item?.title || "eSIM",
    iccid: "8988XXXXXXXXXXXXXXX",
    qrCodeUrl: "https://example.com/qr-code.png",
    iosInstallUrl: "https://example.com/ios-install",
  };
}

/**
 * Webhook handler
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).end("Method Not Allowed");
    }

    const rawBody = await getRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];

    if (!verifyShopifyWebhook(rawBody, hmac)) {
      return res.status(401).end("Invalid signature");
    }

    const payload = JSON.parse(rawBody.toString("utf8"));
    const orderGid = `gid://shopify/Order/${payload.id}`;

    const order = await getOrder(orderGid);
    const esim = await getEsimDetails(order);

    const customerName = [
      order.customer?.firstName,
      order.customer?.lastName,
    ]
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
    return res.status(500).json({ error: err.message });
  }
}
