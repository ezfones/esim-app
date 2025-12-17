import crypto from "crypto";

export const config = { api: { bodyParser: false } };

function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

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

async function adminGraphql(shopDomain, adminToken, query, variables) {
  const url = `https://${shopDomain}/admin/api/2024-07/graphql.json`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": adminToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await r.json();
  if (!r.ok) throw new Error(`Admin GraphQL HTTP ${r.status}: ${JSON.stringify(json)}`);
  if (json.errors?.length) throw new Error(`Admin GraphQL errors: ${JSON.stringify(json.errors)}`);

  return json;
}

async function getOrderMetafield(shopDomain, adminToken, orderGid, namespace, key) {
  const q = `
    query ($id: ID!) {
      order(id: $id) {
        metafield(namespace: "${namespace}", key: "${key}") { id value }
      }
    }
  `;
  const json = await adminGraphql(shopDomain, adminToken, q, { id: orderGid });
  return json?.data?.order?.metafield || null;
}

async function setOrderMetafields(shopDomain, adminToken, orderGid, metafields) {
  const m = `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key value type }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: metafields.map((f) => ({
      ownerId: orderGid,
      namespace: f.namespace,
      key: f.key,
      type: f.type,
      value: f.value,
    })),
  };

  const json = await adminGraphql(shopDomain, adminToken, m, variables);
  const errs = json?.data?.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(`metafieldsSet userErrors: ${JSON.stringify(errs)}`);
  return json?.data?.metafieldsSet?.metafields || [];
}

// Placeholder: we’ll replace this with real eSIMGo call next
async function provisionEsimStub({ items }) {
  return {
    provider: "stub",
    provisionedAt: new Date().toISOString(),
    items,
    esim: {
      iccid: "0000000000000000000",
      smdpPlus: "smdp.example.com",
      activationCode: "ACTIVATION-CODE-STUB",
      qrText: "LPA:1$smdp.example.com$ACTIVATION-CODE-STUB",
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const adminToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!secret) return res.status(500).send("Missing SHOPIFY_WEBHOOK_SECRET");
  if (!adminToken) return res.status(500).send("Missing SHOPIFY_ADMIN_ACCESS_TOKEN");

  const rawBody = await readRawBody(req);

  const hmac = req.headers["x-shopify-hmac-sha256"];
  const topic = req.headers["x-shopify-topic"];
  const shop = req.headers["x-shopify-shop-domain"];

  if (!verifyShopifyHmac(rawBody, hmac, secret)) {
    console.log("❌ Invalid Shopify HMAC", { topic, shop });
    return res.status(401).send("Invalid HMAC");
  }

  const order = JSON.parse(rawBody);
  const orderId = order?.id; // numeric
  if (!orderId) return res.status(200).json({ ok: true, skipped: "no-order-id" });

  const orderGid = `gid://shopify/Order/${orderId}`;

  const items = (order?.line_items || []).map((li) => ({
    title: li.title,
    sku: li.sku,
    quantity: li.quantity,
  }));

  console.log("✅ Shopify webhook verified", { topic, shop, orderId, itemsCount: items.length });

  // ---- Idempotency: don’t provision twice ----
  const statusMf = await getOrderMetafield(shop, adminToken, orderGid, "esim", "status");
  if (statusMf?.value === "provisioned") {
    console.log("↩️ Already provisioned, skipping", { orderId });
    return res.status(200).json({ ok: true, skipped: "already-provisioned" });
  }

  // ---- Always write “pending” + items + backend marker ----
  await setOrderMetafields(shop, adminToken, orderGid, [
    { namespace: "esim", key: "backend", type: "single_line_text_field", value: "vercel" },
    { namespace: "esim", key: "status", type: "single_line_text_field", value: "pending" },
    { namespace: "esim", key: "items", type: "json", value: JSON.stringify(items) },
    { namespace: "esim", key: "provider", type: "single_line_text_field", value: process.env.ESIM_PROVIDER || "esimgo" },
  ]);

  const provisionEnabled = String(process.env.ESIM_PROVISION_ENABLED || "false").toLowerCase() === "true";

  if (!provisionEnabled) {
    console.log("🟡 Provisioning disabled (ESIM_PROVISION_ENABLED=false). Metafields set to pending.");
    return res.status(200).json({ ok: true, status: "pending", provisioned: false });
  }

  // ---- Provision (stub for now; next step we swap to real eSIMGo) ----
  try {
    const result = await provisionEsimStub({ items });

    await setOrderMetafields(shop, adminToken, orderGid, [
      { namespace: "esim", key: "status", type: "single_line_text_field", value: "provisioned" },
      { namespace: "esim", key: "result", type: "json", value: JSON.stringify(result) },
      { namespace: "esim", key: "error", type: "single_line_text_field", value: "" },
    ]);

    console.log("✅ Provisioned (stub) + metafields updated", { orderId });
    return res.status(200).json({ ok: true, status: "provisioned", provisioned: true });
  } catch (e) {
    await setOrderMetafields(shop, adminToken, orderGid, [
      { namespace: "esim", key: "status", type: "single_line_text_field", value: "failed" },
      { namespace: "esim", key: "error", type: "single_line_text_field", value: String(e) },
    ]);

    console.log("❌ Provision failed", String(e));
    return res.status(200).json({ ok: true, status: "failed" });
  }
}
