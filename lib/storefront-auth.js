import crypto from "crypto";

function b64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function getSessionKey() {
  const s = process.env.APP_SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("Missing/weak APP_SESSION_SECRET");
  return crypto.createHash("sha256").update(s).digest();
}

export function seal(obj) {
  const key = getSessionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return b64url(Buffer.concat([iv, tag, enc]));
}

export function unseal(token) {
  if (!token) return null;
  const raw = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const key = getSessionKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString("utf8"));
}

export function getCookie(req, name) {
  const cookie = req.headers.cookie || "";
  const parts = cookie.split(";").map((p) => p.trim());
  for (const p of parts) if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
  return null;
}

export function setCookie(res, name, value, opts = {}) {
  const {
    httpOnly = true,
    secure = true,
    sameSite = "Lax",
    path = "/",
    maxAge = 60 * 60 * 24 * 7,
  } = opts;

  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    `SameSite=${sameSite}`,
  ];
  if (httpOnly) bits.push("HttpOnly");
  if (secure) bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}

function getDomain() {
  const d = (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").trim();
  if (!d) throw new Error("Missing SHOPIFY_STORE_DOMAIN");
  return d;
}

function getStorefrontToken() {
  const t = (process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || "").trim();
  if (!t) throw new Error("Missing SHOPIFY_STOREFRONT_ACCESS_TOKEN");
  return t;
}

export async function storefrontGraphql(query, variables = {}) {
  const domain = getDomain();
  const token = getStorefrontToken();
  const resp = await fetch(`https://${domain}/api/2024-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await resp.json();
  if (!resp.ok || json.errors) throw new Error(`Storefront error: ${JSON.stringify(json.errors || json)}`);
  return json.data;
}
