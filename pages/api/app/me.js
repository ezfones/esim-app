import { customerApiFetch, getCookie, unseal } from "../../../lib/customer-account";

export default async function handler(req, res) {
  try {
    const sess = unseal(getCookie(req, "ca_sess"));
    if (!sess?.accessToken) return res.status(401).json({ ok: false, error: "Not logged in" });

    const query = `
      query Me {
        customer {
          id
          emailAddress { emailAddress }
          firstName
          lastName
        }
      }
    `;

    const data = await customerApiFetch(sess.accessToken, query);
    return res.status(200).json({ ok: true, customer: data.customer });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "error" });
  }
}
