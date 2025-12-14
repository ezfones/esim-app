export default async function handler(req, res) {
  const query = `
    query Products($first: Int!) {
      products(first: $first) {
        edges {
          node {
            id
            title
            handle
          }
        }
      }
    }
  `;

  const r = await fetch(`${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}/api/shopify-graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { first: 50 } })
  });

  const json = await r.json();
  if (!r.ok) return res.status(r.status).json(json);

  const products = (json?.data?.products?.edges || []).map(e => e.node);
  res.status(200).json({ ok: true, products });
}
