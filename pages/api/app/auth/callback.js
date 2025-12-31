import {
  exchangeToken,
  getCookie,
  seal,
  setCookie,
  unseal,
} from "../../../../lib/customer-account";

export default async function handler(req, res) {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      throw new Error(`${error}: ${error_description || ""}`);
    }

    if (!code || !state) {
      throw new Error("Missing code or state");
    }

    const packed = getCookie(req, "ca_auth");
    const auth = unseal(packed);

    if (!auth) {
      throw new Error("Missing auth cookie");
    }

    if (auth.state !== state) {
      throw new Error("Invalid OAuth state");
    }

    const token = await exchangeToken({
      code,
      codeVerifier: auth.verifier,
      redirectUri: auth.redirectUri,
    });

    setCookie(
      res,
      "ca_sess",
      seal({
        accessToken: token.access_token,
        scope: token.scope,
        ts: Date.now(),
      }),
      {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        maxAge: token.expires_in || 3600,
      }
    );

    res.redirect(302, "/");
  } catch (err) {
    res.status(500).send(`Auth callback error: ${err.message}`);
  }
}
