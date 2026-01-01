import { getCookie, unseal, storefrontGraphql } from "../../../lib/storefront-auth";

export default async function handler(req, res) {
  try {
    const packed = getCookie(req, "sf_sess");
    const sess = unseal(packed);
    if (!sess?.accessToken) return res.status(401).json({ ok: false, error: "Not logged in" });

    const query = `
      query Me($token: String!) {
        customer(customerAccessToken: $token) {
          id
          firstName
          lastName
          email
        }
      }
    `;

    const data = await storefrontGraphql(query, { token: sess.accessToken });
    if (!data.customer) return res.status(401).json({ ok: false, error: "Session expired" });

    return res.status(200).json({ ok: true, customer: data.customer });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "error" });
  }
}
