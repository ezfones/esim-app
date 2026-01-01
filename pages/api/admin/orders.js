import { requireAdmin } from "../../../lib/admin-auth";

export default async function handler(req, res) {
  try {
    const admin = requireAdmin(req);
    if (!admin) return res.status(401).json({ ok: false, error: "Admin not logged in" });

    const { q = "" } = req.query;

    // We call your internal endpoint that already has Admin API access token configured.
    const resp = await fetch(`${process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : ""}/api/shopify-graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `
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
        `,
        variables: { first: 50, query: q || null },
      }),
    });

    const json = await resp.json();
    if (!resp.ok || json.errors) {
      return res.status(500).json({ ok: false, error: JSON.stringify(json.errors || json) });
    }

    const orders = (json.data?.orders?.edges || []).map((e) => e.node);
    return res.status(200).json({ ok: true, orders });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "error" });
  }
}
