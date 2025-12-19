import { getDiscovery, makeNonce, makePkce, makeState, seal, setCookie } from "../../../lib/customer-account";

export default async function handler(req, res) {
  try {
    const { openid } = await getDiscovery();

    const clientId = process.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID;
    if (!clientId) throw new Error("Missing SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID");

    const redirectUri =
      process.env.CUSTOMER_AUTH_REDIRECT_URI ||
      `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}/api/app/auth/callback`;

    const state = makeState();
    const nonce = makeNonce();
    const pkce = makePkce();

    // store verifier/state/nonce in encrypted cookie
    setCookie(res, "ca_auth", seal({ state, nonce, verifier: pkce.verifier, redirectUri }), {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 10 * 60,
    });

    const url = new URL(openid.authorization_endpoint);
    url.searchParams.set("scope", "openid email customer-account-api:full");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", pkce.method);

    return res.status(200).json({ ok: true, authorizeUrl: url.toString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "error" });
  }
}
