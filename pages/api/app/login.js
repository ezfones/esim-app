import { seal, setCookie, storefrontGraphql } from "../../../lib/storefront-auth";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: "Missing email/password" });

    const query = `
      mutation Login($input: CustomerAccessTokenCreateInput!) {
        customerAccessTokenCreate(input: $input) {
          customerAccessToken { accessToken expiresAt }
          customerUserErrors { field message }
        }
      }
    `;

    const data = await storefrontGraphql(query, { input: { email, password } });
    const out = data.customerAccessTokenCreate;

    if (out.customerUserErrors?.length) {
      return res.status(401).json({ ok: false, error: out.customerUserErrors[0].message });
    }

    const token = out.customerAccessToken?.accessToken;
    const expiresAt = out.customerAccessToken?.expiresAt;
    if (!token) return res.status(401).json({ ok: false, error: "Login failed" });

    setCookie(res, "sf_sess", seal({ accessToken: token, expiresAt }), {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 7,
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "error" });
  }
}
