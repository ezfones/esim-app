import { requireAdmin } from "../../../lib/admin-auth";
import { shopifyAdminGraphql } from "../../../lib/shopify-admin";

export default async function handler(req, res) {
  try {
    const admin = requireAdmin(req);
    if (!admin) return res.status(401).json({ ok: false, error: "Admin not logged in" });

    const q = (req.query.q || "").trim();
    const query = `
      query Customers($first: Int!, $query: String) {
        customers(first: $first, query: $query) {
          edges {
            node {
              id
              email
              firstName
              lastName
              createdAt
            }
          }
        }
      }
    `;

    const data = await shopifyAdminGraphql(query, { first: 50, query: q || null });
    const customers = (data?.customers?.edges || []).map((e) => e.node);

    return res.status(200).json({ ok: true, customers });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "error" });
  }
}
