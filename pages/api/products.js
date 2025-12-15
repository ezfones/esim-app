export default async function handler(req, res) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN; // qrrmee-m0.myshopify.com
  const token = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;

  if (!domain || !token) {
    return res.status(500).json({
      ok: false,
      error: "Missing env vars: SHOPIFY_STORE_DOMAIN / SHOPIFY_STOREFRONT_ACCESS_TOKEN"
    });
  }

  const first = Number(req.query.first || 50);

  const query = `
    query Products($first: Int!) {
      products(first: $first) {
        edges {
          node {
            id
            title
            handle
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  sku
                  price {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const r = await fetch(`https://${domain}/api/2024-07/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token
      },
      body: JSON.stringify({ query, variables: { first } })
    });

    const json = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: "Shopify request failed",
        shopify: json
      });
    }

    const products = (json?.data?.products?.edges || []).map((e) => ({
      ...e.node,
      variants: (e.node.variants?.edges || []).map((v) => v.node)
    }));

    return res.status(200).json({ ok: true, products });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
