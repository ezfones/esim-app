import crypto from "crypto";

// IMPORTANT: raw body needed for Shopify HMAC verification
export const config = {
  api: { bodyParser: false }
};

function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  // timingSafeEqual throws if lengths differ
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function addOrderNote({ shopDomain, adminToken, apiVersion, orderId, note }) {
  const url = `https://${shopDomain}/admin/api/${apiVersion}/orders/${orderId}.json`;

  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": adminToken
    },
    body: JSON.stringify({
      order: { id: orderId, note }
    })
  });

  const json = await r.json();
  if (!r.ok) {
    throw new Error(
      `Admin API update failed: ${r.status} ${JSON.stringify(json)}`
    );
  }
  return json;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return res.status(500).send("Missing SHOPIFY_WEBHOOK_SECRET");

  const rawBody = await readRawBody(req);

  const hmac = req.headers["x-shopify-hmac-sha256"];
  const topic = req.headers["x-shopify-topic"];
  const shop = req.headers["x-shopify-shop-domain"];

  // 1) Verify request is really Shopify
  if (!verifyShopifyHmac(rawBody, hmac, secret)) {
    console.log("❌ Invalid Shopify HMAC", { topic, shop });
    return res.status(401).send("Invalid HMAC");
  }

  // 2) Parse order payload
  let order;
  try {
    order = JSON.parse(rawBody);
  } catch (e) {
    console.log("❌ Invalid JSON body", String(e));
    return res.status(400).send("Invalid JSON");
  }

  const orderId = order?.id;
  const orderName = order?.name;
  const email = order?.email;

  const items = (order?.line_items || []).map((li) => ({
    title: li.title,
    sku: li.sku,
    quantity: li.quantity
  }));

  console.log("✅ Shopify webhook verified", {
    topic,
    shop,
    orderId,
    orderName,
    email,
    itemsCount: items.length
  });

  // 3) Write a note back to the order in Shopify (Admin API)
  //    This proves the end-to-end loop works.
  const adminToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || "2024-07";

  if (!adminToken) {
    console.log("⚠️ SHOPIFY_ADMIN_ACCESS_TOKEN not set, skipping order note update");
    return res.status(200).json({ ok: true, noteUpdated: false });
  }

  try {
    const note = [
      "eSIM provisioning pending.",
      `Order: ${orderName || orderId}`,
      `Email: ${email || "n/a"}`,
      `SKUs: ${items.map((i) => `${i.sku || "NO-SKU"}x${i.quantity}`).join(", ")}`
    ].join("\n");

    await addOrderNote({
      shopDomain: shop,
      adminToken,
      apiVersion,
      orderId,
      note
    });

    console.log("✅ Order note updated", { orderId });
    return res.status(200).json({ ok: true, noteUpdated: true });
  } catch (e) {
    console.log("❌ Failed to update order note", String(e));
    // Still return 200 so Shopify doesn't keep retrying while you're testing.
    // Once stable, you can return 500 here to trigger retries.
    return res.status(200).json({ ok: true, noteUpdated: false, error: String(e) });
  }
}
