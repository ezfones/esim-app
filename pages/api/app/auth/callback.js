import { exchangeToken, getCookie, seal, setCookie, unseal } from "../../../lib/customer-account";

export default async function handler(req, res) {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) throw new Error(`${error}: ${error_description || ""}`);
    if (!code || !state) throw new Error("Missing code/state");

    const packed = getCookie(req, "ca_auth");
    const auth = unseal(packed);
    if (!auth) throw new Error("Missing auth cookie");
    if (auth.state !== state) throw new Error("Invalid state");

    const token = await exchangeToken({
      code,
      codeVerifier: auth.verifier,
      redirectUri: auth.redirectUri,
    });

    // Store access token in encrypted cookie (MVP). Later: move to DB + refresh rotation.
    setCookie(res, "ca_sess", seal({ accessToken: token.access_token, scope: token.scope, ts: Date.now() }), {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: Math.max(300, token.expires_in || 3600),
    });

    // send user back to app – you can replace this with a deep link later
    return res.redirect(302, "/");
  } catch (e) {
    return res.status(500).send(`Auth callback error: ${e.message || "error"}`);
  }
}
