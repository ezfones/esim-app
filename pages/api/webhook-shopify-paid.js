import crypto from "crypto";

const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const ESIMGO_API_KEY = process.env.ESIMGO_API_KEY;
const ESIMGO_BASE_URL = process.env.ESIMGO_BASE_URL || "https://api.esim-go.com/v2.4";
const PROVISION_ENABLED = (process.env.ESIM_PROVISION_ENABLED || "false").toLowerCase() === "true";

export const config = {
  api: { bodyParser: false }, // IMPORTANT for Shopify HMAC verification
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!WEBHOOK_SECRET) throw new Error("Missing SHOPIFY_WEBHOOK_SECRET");
  const digest = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || ""));
}

async function shopifyAdminGraphql(query, variables) {
  if (!SHOP_DOMAIN || !ADMIN_TOKEN) throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN");

  const r = await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await r.json();
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function setOrderMetafields(orderGid, pairs) {
  // pairs: [{namespace:"esim", key:"status", type:"single_line_text_field", value:"pending"}, ...]
  const mutation = `
    mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key type value }
        userErrors { field message }
      }
    }
  `;

  const metafields = pairs.map(p => ({
    ownerId: orderGid,
    namespace: p.namespace,
    key: p.key,
    type: p.type,
    value: p.value,
  }));

  const data = await shopifyAdminGraphql(mutation, { metafields });
  const errs = data.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(`metafieldsSet userErrors: ${JSON.stringify(errs)}`);
  return data.metafieldsSet?.metafields || [];
}

async function esimgoCreateOrder({ sku, quantity }) {
  // POST /orders with type=transaction, assign=true, item=bundle name (your SKU)
  // Returns orderReference. :contentReference[oaicite:3]{index=3}
  const payload = {
    type: "validate",
    assign: true,
    order: [
      {
        type: "bundle",
        quantity,
        item: sku,
        // IMPORTANT: if assign=true and you want a NEW eSIM, do not supply iccids. :contentReference[oaicite:4]{index=4}
      },
    ],
  };

  const r = await fetch(`${ESIMGO_BASE_URL}/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": ESIMGO_API_KEY, // eSIM Go auth :contentReference[oaicite:5]{index=5}
    },
    body: JSON.stringify(payload),
  });

  const json = await r.json();
  if (!r.ok) throw new Error(`eSIMGo /orders failed ${r.status}: ${JSON.stringify(json)}`);

  // Docs say you use orderReference to download install/QR details. :contentReference[oaicite:6]{index=6}
  const orderReference = json?.orderReference || json?.order_reference || json?.reference;
  if (!orderReference) throw new Error(`No orderReference in eSIMGo response: ${JSON.stringify(json)}`);

  return { orderReference, raw: json };
}

async function esimgoGetInstallDetails(orderReference) {
  // GET /esims/assignments?reference=... with Accept: application/json
  // Returns ICCID + smdpAddress + matchingId (+ appleInstallUrl if requested). :contentReference[oaicite:7]{index=7}
  const url = new URL(`${ESIMGO_BASE_URL}/esims/assignments`);
  url.searchParams.set("reference", orderReference);
  url.searchParams.set("additionalFields", "appleInstallUrl");

  const r = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-API-Key": ESIMGO_API_KEY,
      "Accept": "application/json",
    },
  });

  const json = await r.json();
  if (!r.ok) throw new Error(`eSIMGo /esims/assignments failed ${r.status}: ${JSON.stringify(json)}`);

  // Some accounts return an array; some return an object. Handle both.
  const first = Array.isArray(json) ? json[0] : json;
  if (!first?.iccid) throw new Error(`No ICCID in install details: ${JSON.stringify(json)}`);

  return {
    iccid: first.iccid,
    smdpAddress: first.smdpAddress,
    matchingId: first.matchingId,
    appleInstallUrl: first.appleInstallUrl || "",
    raw: json,
  };
}

export default async function handler(req, res) {
  try {
    const rawBody = await readRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];
    const topic = req.headers["x-shopify-topic"];

    if (!verifyShopifyHmac(rawBody, hmac)) {
      return res.status(401).json({ ok: false, error: "Invalid webhook signature" });
    }

    if (topic !== "orders/paid") {
      return res.status(200).json({ ok: true, ignored: `topic=${topic}` });
    }

    const order = JSON.parse(rawBody.toString("utf8"));

    // Shopify numeric id (REST) -> convert to GID
    const orderGid = `gid://shopify/Order/${order.id}`;

    const email = order.email || order.customer?.email || "";
    const orderName = order.name || "";

    const lineItems = order.line_items || [];
    const items = lineItems
      .map(li => ({
        title: li.title,
        sku: li.sku,
        quantity: li.quantity || 1,
      }))
      .filter(x => x.sku);

    if (!items.length) {
      await setOrderMetafields(orderGid, [
        { namespace: "esim", key: "status", type: "single_line_text_field", value: "no_sku" },
        { namespace: "esim", key: "provider", type: "single_line_text_field", value: "esimgo" },
      ]);
      return res.status(200).json({ ok: true, message: "No SKUs found; marked no_sku" });
    }

    // Write initial metafields
    await setOrderMetafields(orderGid, [
      { namespace: "esim", key: "status", type: "single_line_text_field", value: "pending" },
      { namespace: "esim", key: "provider", type: "single_line_text_field", value: "esimgo" },
      { namespace: "esim", key: "backend", type: "single_line_text_field", value: "vercel" },
      { namespace: "esim", key: "items", type: "json", value: JSON.stringify(items) },
    ]);

    // Safety switch
    if (!PROVISION_ENABLED) {
      return res.status(200).json({
        ok: true,
        message: "Provisioning disabled (ESIM_PROVISION_ENABLED=false). Metafields set to pending.",
      });
    }

    // For now: provision ONLY the first SKU (single item checkout). Expand later.
    const first = items[0];

    if (!ESIMGO_API_KEY) throw new Error("Missing ESIMGO_API_KEY");

    // 1) Create eSIMGo order -> orderReference :contentReference[oaicite:8]{index=8}
    const created = await esimgoCreateOrder({ sku: first.sku, quantity: first.quantity });

    // 2) Fetch install details + Apple install URL :contentReference[oaicite:9]{index=9}
    const install = await esimgoGetInstallDetails(created.orderReference);

    // 3) Write metafields
    await setOrderMetafields(orderGid, [
      { namespace: "esim", key: "orderReference", type: "single_line_text_field", value: created.orderReference },
      { namespace: "esim", key: "iccid", type: "single_line_text_field", value: install.iccid },
      { namespace: "esim", key: "smdpAddress", type: "single_line_text_field", value: install.smdpAddress || "" },
      { namespace: "esim", key: "matchingId", type: "single_line_text_field", value: install.matchingId || "" },
      { namespace: "esim", key: "appleInstallUrl", type: "url", value: install.appleInstallUrl || "" },
      { namespace: "esim", key: "status", type: "single_line_text_field", value: "provisioned" },
    ]);

    return res.status(200).json({
      ok: true,
      order: { name: orderName, email },
      provisioned: { sku: first.sku, orderReference: created.orderReference, iccid: install.iccid },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
