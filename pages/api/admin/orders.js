import { requireAdmin } from "../../../lib/admin-auth";
import { shopifyAdminGraphql } from "../../../lib/shopify-admin";

export default async function handler(req, res) {
  try {
    const admin = requireAdmin(req);
    if (!admin) return res.status(401).json({ ok: false, error: "Admin not logged in" });

    const q = (req.query.q || "").trim();
    const query = `
      query Orders($first: Int!, $query: String) {
        orders(first: $first, query: $query, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { email firstName lastName }
            }
          }
        }
      }
    `;

    const data = await shopifyAdminGraphql(query, { first: 50, query: q || null });
    const orders = (data?.orders?.edges || []).map((e) => e.node);

    return res.status(200).json({ ok: true, orders });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "error" });
  }
}

