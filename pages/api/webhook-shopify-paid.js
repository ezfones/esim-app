import crypto from "crypto";

function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || ""));
}

// IMPORTANT: We need raw body for HMAC verification
export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return res.status(500).send("Missing SHOPIFY_WEBHOOK_SECRET");

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");

  const hmac = req.headers["x-shopify-hmac-sha256"];
  const topic = req.headers["x-shopify-topic"];
  const shop = req.headers["x-shopify-shop-domain"];

  if (!verifyShopifyHmac(rawBody, hmac, secret)) {
    return res.status(401).send("Invalid HMAC");
  }

  const order = JSON.parse(rawBody);

  // Extract SKUs to provision
  const items = (order.line_items || []).map((li) => ({
    title: li.title,
    sku: li.sku,
    quantity: li.quantity
  }));

  // For now, just log and acknowledge
  console.log("✅ Shopify webhook verified", { topic, shop, orderId: order.id, items });

  // TODO next: call eSIM provider for each sku, store results, email customer

  return res.status(200).json({ ok: true });
}
