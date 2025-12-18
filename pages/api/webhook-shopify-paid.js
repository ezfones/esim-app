import crypto from "crypto";

export const config = {
  api: { bodyParser: false }, // required for Shopify HMAC verification
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function verifyShopifyHmac(rawBodyBuffer, hmacHeader, secret) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBodyBuffer)
    .digest("base64");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(hmacHeader || "", "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function shopifyAdminGraphql(shopDomain, adminToken, query, variables) {
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
  if (!r.ok) {
    throw new Error(`Shopify Admin API HTTP ${r.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function setOrderMetafields(shopDomain, adminToken, orderGid, pairs) {
  const mutation = `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key value type }
        userErrors { field message }
      }
    }
  `;

  const metafields = pairs.map((p) => ({
    ownerId: orderGid,
    namespace: p.namespace,
    key: p.key,
    type: p.type,
    value: p.value,
  }));

  const data = await shopifyAdminGraphql(shopDomain, adminToken, mutation, { metafields });
  const errs = data.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(`metafieldsSet userErrors: ${JSON.stringify(errs)}`);
  return data.metafieldsSet?.metafields || [];
}

function cleanBaseUrl(u) {
  // remove trailing slash to avoid //orders
  return String(u || "").replace(/\/+$/, "");
}

async function esimgoCreateOrder({ baseUrl, apiKey, sku, quantity, orderType }) {
  const url = `${cleanBaseUrl(baseUrl)}/orders`;

  const payload = {
    type: orderType, // "validate" (no credits) OR "transaction" (real)
    assign: true,
    order: [
      {
        type: "bundle",
        quantity,
        item: sku,
      },
    ],
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const json = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error(`eSIMGo /orders failed ${r.status}: ${JSON.stringify(json)}`);
  }

  // In validate mode, eSIMGo may not return orderReference. That's OK.
  const orderReference =
    json?.orderReference ||
    json?.order_reference ||
    json?.reference ||
    json?.data?.orderReference ||
    "";

  if (orderType !== "validate" && !orderReference) {
    throw new Error(`No orderReference in eSIMGo response: ${JSON.stringify(json)}`);
  }

  return { orderReference, raw: json };
}

async function esimgoGetAssignments({ baseUrl, apiKey, orderReference }) {
  const u = new URL(`${cleanBaseUrl(baseUrl)}/esims/assignments`);
  u.searchParams.set("reference", orderReference);
  u.searchParams.set("additionalFields", "appleInstallUrl");

  const r = await fetch(u.toString(), {
    method: "GET",
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
  });

  const json = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error(`eSIMGo /esims/assignments failed ${r.status}: ${JSON.stringify(json)}`);
  }

  const first = Array.isArray(json) ? json[0] : json;
  if (!first) throw new Error(`eSIMGo assignments empty: ${JSON.stringify(json)}`);

  return {
    iccid: first.iccid || "",
    smdpAddress: first.smdpAddress || first.smdp_address || "",
    matchingId: first.matchingId || first.activationCode || first.matching_id || "",
    appleInstallUrl: first.appleInstallUrl || "",
    raw: json,
  };
}

export default async function handler(req, res) {
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN; // qrrmee-m0.myshopify.com
  const adminToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN; // shpat_...
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;

  const provisionEnabled = String(process.env.ESIM_PROVISION_ENABLED || "false").toLowerCase() === "true";
  const esimgoBaseUrl = process.env.ESIMGO_BASE_URL || "https://api.esim-go.com/v2.4";
  const esimgoApiKey = process.env.ESIMGO_API_KEY || "";
  const orderType = (process.env.ESIMGO_ORDER_TYPE || "validate").toLowerCase(); // validate | transaction

  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    if (!shopDomain) return res.status(500).json({ ok: false, error: "Missing SHOPIFY_STORE_DOMAIN" });
    if (!adminToken) return res.status(500).json({ ok: false, error: "Missing SHOPIFY_ADMIN_ACCESS_TOKEN" });
    if (!webhookSecret) return res.status(500).json({ ok: false, error: "Missing SHOPIFY_WEBHOOK_SECRET" });

    const rawBody = await readRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];
    const topic = req.headers["x-shopify-topic"];

    if (!verifyShopifyHmac(rawBody, hmac, webhookSecret)) {
      return res.status(401).json({ ok: false, error: "Invalid Shopify HMAC" });
    }

    // Only act on orders/paid
    if (topic && String(topic) !== "orders/paid") {
      return res.status(200).json({ ok: true, ignored: `topic=${topic}` });
    }

    const order = JSON.parse(rawBody.toString("utf8"));
    const orderId = order?.id; // long numeric ID
    if (!orderId) return res.status(200).json({ ok: true, skipped: "no order id" });

    const orderName = order?.name || "";
    const email = order?.email || order?.customer?.email || "";
    const orderGid = `gid://shopify/Order/${orderId}`;

    const items = (order?.line_items || [])
      .map((li) => ({
        title: li?.title || "",
        sku: li?.sku || "",
        quantity: li?.quantity || 1,
      }))
      .filter((x) => x.sku);

    // Always set basic metafields
    await setOrderMetafields(shopDomain, adminToken, orderGid, [
      { namespace: "esim", key: "status", type: "single_line_text_field", value: "pending" },
      { namespace: "esim", key: "provider", type: "single_line_text_field", value: "esimgo" },
      { namespace: "esim", key: "backend", type: "single_line_text_field", value: "vercel" },
      { namespace: "esim", key: "items", type: "json", value: JSON.stringify(items) },
      { namespace: "esim", key: "error", type: "single_line_text_field", value: "" },
    ]);

    if (!items.length) {
      await setOrderMetafields(shopDomain, adminToken, orderGid, [
        { namespace: "esim", key: "status", type: "single_line_text_field", value: "no_sku" },
        { namespace: "esim", key: "error", type: "single_line_text_field", value: "No SKU found on line items" },
      ]);
      return res.status(200).json({ ok: true, status: "no_sku" });
    }

    // Safety switch
    if (!provisionEnabled) {
      return res.status(200).json({
        ok: true,
        status: "pending",
        message: "Provisioning disabled (ESIM_PROVISION_ENABLED=false)",
      });
    }

    if (!esimgoApiKey) {
      await setOrderMetafields(shopDomain, adminToken, orderGid, [
        { namespace: "esim", key: "status", type: "single_line_text_field", value: "failed" },
        { namespace: "esim", key: "error", type: "single_line_text_field", value: "Missing ESIMGO_API_KEY" },
      ]);
      return res.status(500).json({ ok: false, error: "Missing ESIMGO_API_KEY" });
    }

    // For now: provision/validate first SKU only
    const first = items[0];

    // 1) Create order (validate or transaction)
    const created = await esimgoCreateOrder({
      baseUrl: esimgoBaseUrl,
      apiKey: esimgoApiKey,
      sku: first.sku,
      quantity: first.quantity,
      orderType,
    });

    // If validate: stop here, mark validated (no credits consumed)
    if (orderType === "validate") {
      await setOrderMetafields(shopDomain, adminToken, orderGid, [
        { namespace: "esim", key: "status", type: "single_line_text_field", value: "validated" },
      ]);
      return res.status(200).json({
        ok: true,
        status: "validated",
        sku: first.sku,
        orderName,
        email,
      });
    }

    // 2) Fetch assignment/install details using orderReference
    await setOrderMetafields(shopDomain, adminToken, orderGid, [
      { namespace: "esim", key: "orderReference", type: "single_line_text_field", value: created.orderReference },
    ]);

    const assignment = await esimgoGetAssignments({
      baseUrl: esimgoBaseUrl,
      apiKey: esimgoApiKey,
      orderReference: created.orderReference,
    });

    // 3) Write details to metafields
    await setOrderMetafields(shopDomain, adminToken, orderGid, [
      { namespace: "esim", key: "iccid", type: "single_line_text_field", value: assignment.iccid || "" },
      { namespace: "esim", key: "smdpAddress", type: "single_line_text_field", value: assignment.smdpAddress || "" },
      { namespace: "esim", key: "matchingId", type: "single_line_text_field", value: assignment.matchingId || "" },
      { namespace: "esim", key: "appleInstallUrl", type: "url", value: assignment.appleInstallUrl || "" },
      { namespace: "esim", key: "status", type: "single_line_text_field", value: "provisioned" },
    ]);

    return res.status(200).json({
      ok: true,
      status: "provisioned",
      sku: first.sku,
      orderReference: created.orderReference,
      iccid: assignment.iccid,
    });
  } catch (e) {
    const msg = e?.message || String(e);

    // Best-effort: write failure into metafields (only if we can infer order id)
    try {
      const rawBody = req?.body ? Buffer.from(req.body) : null; // usually null because bodyParser false
      // We can't reliably parse order here without re-reading stream; so only return error.
    } catch (_) {}

    console.error("❌ webhook error:", msg);
    return res.status(500).json({ ok: false, error: msg });
  }
}
