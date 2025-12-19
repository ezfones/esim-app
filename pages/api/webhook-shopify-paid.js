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

function esimGoBaseUrl() {
  // eSIM Go docs use https://api.esim-go.com/v2.4 (or newer). :contentReference[oaicite:3]{index=3}
  return "https://api.esim-go.com/v2.4";
}

function esimGoHeaders() {
  const key = process.env.ESIMGO_API_KEY;
  if (!key) throw new Error("Missing ESIMGO_API_KEY");
  return {
    "Content-Type": "application/json",
    "X-API-Key": key, // eSIM Go auth header :contentReference[oaicite:4]{index=4}
  };
}

/**
 * Step 1: Create an order (buy + assign bundle to a new eSIM)
 * Uses /orders as per eSIM Go ordering guide. :contentReference[oaicite:5]{index=5}
 */
async function esimGoCreateOrder({ item, quantity }) {
  const url = `${esimGoBaseUrl()}/orders?includeIccids=true`;
  const body = {
    type: "transaction",
    assign: true,
    order: [
      {
        type: "bundle",
        quantity: quantity || 1,
        item, // bundle name (case sensitive) :contentReference[oaicite:6]{index=6}
        // No ICCIDs provided => auto-assign to new eSIM(s) :contentReference[oaicite:7]{index=7}
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

/**
 * Step 2: Get install details from order reference
 * /esims/assignments returns ICCID + SMDP+ + MatchingID. :contentReference[oaicite:8]{index=8}
 */
async function esimGoGetAssignments(orderReference) {
  const url = `${esimGoBaseUrl()}/esims/assignments?reference=${encodeURIComponent(
    orderReference
  )}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      ...esimGoHeaders(),
      Accept: "application/json",
    },
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`eSIM Go /esims/assignments error: ${JSON.stringify(json)}`);
  return json;
}

function buildAppleUniversalLink(lpaString) {
  // Apple universal link format for eSIM install (iOS 17.4+) :contentReference[oaicite:9]{index=9}
  return `https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(
    lpaString
  )}`;
}

function buildQrImageUrl(lpaString) {
  // QR image hosted externally (no file storage needed)
  return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(
    lpaString
  )}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const rawBody = await getRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];

    const valid = verifyShopifyWebhook(rawBody, hmac);
    if (!valid) return res.status(401).send("Invalid webhook signature");

    const payload = JSON.parse(rawBody.toString("utf8"));

    // Use webhook payload (no Shopify Admin API)
    const orderName = payload?.name || `Order ${payload?.id || ""}`;
    const toEmail = payload?.email;
    const customerName =
      [payload?.customer?.first_name, payload?.customer?.last_name].filter(Boolean).join(" ") ||
      "there";

    const firstItem = payload?.line_items?.[0];
    if (!firstItem) throw new Error("No line
