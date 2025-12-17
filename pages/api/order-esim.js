export default async function handler(req, res) {
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const adminToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  const orderName = req.query.orderName; // e.g. "#1082"
  const orderId = req.query.orderId;     // real numeric Shopify order ID (long)

  if (!shopDomain || !adminToken) {
    return res.status(500).json({
      ok: false,
      error: "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN"
    });
  }

  const adminFetch = async (query, variables) => {
    const r = await fetch(`https://${shopDomain}/admin/api/2024-07/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": adminToken
      },
      body: JSON.stringify({ query, variables })
    });

    const json = await r.json();
    if (json?.errors?.length) {
      return { ok: false, shopifyErrors: json.errors };
    }
    return { ok: true, json };
  };

  let orderGid = null;

  // If user passed a real Shopify numeric orderId
  if (orderId) {
    orderGid = `gid://shopify/Order/${orderId}`;
  }

  // Otherwise look up by orderName like "#1082"
  if (!orderGid) {
    if (!orderName) {
      return res.status(400).json({
        ok: false,
        error: "Provide orderName (e.g. #1082) or a real orderId (long number)"
      });
    }

    const q = `
      query($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    `;

    const lookup = await adminFetch(q, { query: `name:${orderName}` });
    if (!lookup.ok) return res.status(200).json({ ok: false, ...lookup });

    const found = lookup.json?.data?.orders?.edges?.[0]?.node;
    if (!found?.id) {
      return res.status(200).json({
        ok: false,
        error: `No order found for name:${orderName}`,
        shopDomain
      });
    }

    orderGid = found.id;
  }

  // Fetch metafields
  const q2 = `
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

  const result = await adminFetch(q2, { id: orderGid });
  if (!result.ok) return res.status(200).json({ ok: false, ...result });

  const order = result.json?.data?.order;
  const all = (order?.metafields?.edges || []).map(e => e.node);
  const esim = all.filter(m => m.namespace === "esim");

  return res.status(200).json({
    ok: true,
    shopDomain,
    order: { id: order?.id, name: order?.name },
    metafields_esim: esim
  });
}
