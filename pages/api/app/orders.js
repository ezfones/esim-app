import { customerApiFetch, getCookie, unseal } from "../../../lib/customer-account";

export default async function handler(req, res) {
  try {
    const sess = unseal(getCookie(req, "ca_sess"));
    if (!sess?.accessToken) return res.status(401).json({ ok: false, error: "Not logged in" });

    const query = `
      query Orders($first: Int!) {
        customer {
          orders(first: $first) {
            nodes {
              id
              name
              processedAt
              financialStatus
              fulfillmentStatus
              totalPrice { amount currencyCode }
              lineItems(first: 50) {
                nodes {
                  title
                  quantity
                  sku
                }
              }
            }
          }
        }
      }
    `;

    const data = await customerApiFetch(sess.accessToken, query, { first: 25 });
    return res.status(200).json({ ok: true, orders: data.customer?.orders?.nodes || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "error" });
  }
}
