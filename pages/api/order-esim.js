export default async function handler(req, res) {
  const orderId = req.query.orderId;
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const adminToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!orderId) return res.status(400).json({ ok: false, error: "Missing orderId" });
  if (!shopDomain || !adminToken) {
    return res.status(500).json({
      ok: false,
      error: "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN"
    });
  }

  const orderGid = `gid://shopify/Order/${orderId}`;

  const query = `
    query($id: ID!) {
      order(id: $id) {
        id
        name
        metafields(first: 50) {
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

  // If Shopify returns errors, surface them clearly
  if (json?.errors?.length) {
    return res.status(200).json({ ok: false, shopDomain, orderGid, shopifyErrors: json.errors });
  }

  const order = json?.data?.order;
  if (!order) {
    return res.status(200).json({
      ok: false,
      shopDomain,
      orderGid,
      error: "Order not found via Admin API (check domain/token/orderId)"
    });
  }

  const all = (order.metafields?.edges || []).map(e => e.node);
  const esim = all.filter(m => m.namespace === "esim");

  return res.status(200).json({
    ok: true,
    shopDomain,
    order: { id: order.id, name: order.name },
    metafields_all_count: all.length,
    metafields_esim: esim
  });
}
