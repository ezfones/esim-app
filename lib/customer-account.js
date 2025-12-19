import crypto from "crypto";

const CACHE = { openid: null, customerApi: null, ts: 0 };
const CACHE_TTL_MS = 10 * 60 * 1000;

function b64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256base64url(input) {
  return b64url(crypto.createHash("sha256").update(input).digest());
}

export function makePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = sha256base64url(verifier);
  return { verifier, challenge, method: "S256" };
}

export function makeState() {
  return b64url(crypto.randomBytes(24));
}

export function makeNonce() {
  return b64url(crypto.randomBytes(24));
}

function getStoreDomain() {
  const d = (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").trim();
  if (!d) throw new Error("Missing SHOPIFY_STORE_DOMAIN");
  return d;
}

export async function getDiscovery() {
  const now = Date.now();
  if (CACHE.openid && CACHE.customerApi && now - CACHE.ts < CACHE_TTL_MS) {
    return { openid: CACHE.openid, customerApi: CACHE.customerApi };
  }

  const domain = getStoreDomain();
  const openidResp = await fetch(`https://${domain}/.well-known/openid-configuration`);
  if (!openidResp.ok) throw new Error(`OpenID discovery failed: ${openidResp.status}`);
  const openid = await openidResp.json();

  const custResp = await fetch(`https://${domain}/.well-known/customer-account-api`);
  if (!custResp.ok) throw new Error(`Customer API discovery failed: ${custResp.status}`);
  const customerApi = await custResp.json();

  CACHE.openid = openid;
  CACHE.customerApi = customerApi;
  CACHE.ts = now;

  return { openid, customerApi };
}

// --- simple encrypted cookie payload (AES-256-GCM) ---
function getSessionKey() {
  const s = process.env.APP_SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("Missing/weak APP_SESSION_SECRET");
  return crypto.createHash("sha256").update(s).digest(); // 32 bytes
}

export function seal(obj) {
  const key = getSessionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
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
  for (const p of parts) {
    if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
  }
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

export async function exchangeToken({ code, codeVerifier, redirectUri }) {
  const { openid } = await getDiscovery();
  const tokenUrl = openid.token_endpoint;

  const clientId = process.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID;
  if (!clientId) throw new Error("Missing SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID");

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", clientId);
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  body.set("code_verifier", codeVerifier);

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };

  // If you have a confidential client secret, use Basic auth
  const secret = process.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET;
  if (secret) {
    const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
    headers["Authorization"] = `Basic ${basic}`;
  }

  const resp = await fetch(tokenUrl, { method: "POST", headers, body });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Token exchange failed: ${JSON.stringify(json)}`);
  return json; // access_token, refresh_token (maybe), expires_in, id_token, scope
}

export async function customerApiFetch(accessToken, query, variables = {}) {
  const { customerApi } = await getDiscovery();

  // Shopify discovery includes GraphQL endpoint info (do not hardcode)
  // Common fields: customerApi.graphql_endpoint or customerApi.customer_account_api.graphql (varies by version)
  const graphqlEndpoint =
    customerApi?.graphql_endpoint ||
    customerApi?.endpoints?.graphql ||
    customerApi?.customer_account_api?.graphql ||
    customerApi?.graphql?.url;

  if (!graphqlEndpoint) {
    throw new Error(`Could not find GraphQL endpoint in customer-account-api discovery: ${JSON.stringify(customerApi)}`);
  }

  const resp = await fetch(graphqlEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json();
  if (!resp.ok || json.errors) {
    throw new Error(`Customer API GraphQL error: ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}
