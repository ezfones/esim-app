import { requireAdmin } from "../../../lib/admin-auth";

export default async function handler(req, res) {
  try {
    const admin = requireAdmin(req);
    if (!admin) return res.status(401).json({ ok: false, error: "Admin not logged in" });

    const { q = "" } = req.query;

    const resp = await fetch(`${process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : ""}/api/shopify-graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `
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
        `,
        variables: { first: 50, query: q || null },
      }),
    });

    const json = await resp.json();
    if (!resp.ok || json.errors) {
      return res.status(500).json({ ok: false, error: JSON.stringify(json.errors || json) });
    }

    const customers = (json.data?.customers?.edges || []).map((e) => e.node);
    return res.status(200).json({ ok: true, customers });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "error" });
  }
}
