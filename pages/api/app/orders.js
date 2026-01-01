import { getCookie, unseal, storefrontGraphql } from "../../../lib/storefront-auth";

export default async function handler(req, res) {
  try {
    const packed = getCookie(req, "sf_sess");
    const sess = unseal(packed);
    if (!sess?.accessToken) return res.status(401).json({ ok: false, error: "Not logged in" });

    const query = `
      query Orders($token: String!, $first: Int!) {
        customer(customerAccessToken: $token) {
          orders(first: $first, sortKey: PROCESSED_AT, reverse: true) {
            nodes {
              id
              name
              processedAt
              financialStatus
              fulfillmentStatus
              totalPriceV2 { amount currencyCode }
              lineItems(first: 50) {
                nodes {
                  title
                  quantity
                }
              }
            }
          }
        }
      }
    `;

    const data = await storefrontGraphql(query, { token: sess.accessToken, first: 50 });
    const orders = data?.customer?.orders?.nodes || [];

    return res.status(200).json({ ok: true, orders });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "error" });
  }
}
