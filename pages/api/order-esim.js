export default async function handler(req, res) {
  const orderId = req.query.orderId;
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const adminToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!orderId) return res.status(400).json({ ok: false, error: "Missing orderId" });
  if (!shopDomain || !adminToken) {
    return res.status(500).json({ ok: false, error: "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN" });
  }

  const orderGid = `gid://shopify/Order/${orderId}`;

  const query = `
    query($id: ID!) {
      order(id: $id) {
        id
        name
        metafields(first: 20, namespace: "esim") {
          edges {
            node {
              id
              namespace
              key
              type
              value
            }
          }
        }
      }
    }
  `;

  const r = await fetch(`https://${shopDomain}/admin/api/2024-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": adminToken
    },
    body: JSON.stringify({ query, variables: { id: orderGid } })
  });

  const json = await r.json();
  if (!r.ok) return res.status(r.status).json({ ok: false, shopify: json });

  const mfs = json?.data?.order?.metafields?.edges?.map(e => e.node) || [];
  return res.status(200).json({
    ok: true,
    order: { id: json?.data?.order?.id, name: json?.data?.order?.name },
    metafields: mfs
  });
}
