export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      ok: false,
      error: "Use POST with JSON body: { query, variables }"
    });
  }

  const domain = process.env.SHOPIFY_STORE_DOMAIN; // qrrmee-m0.myshopify.com
  const token = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;

  if (!domain || !token) {
    return res.status(500).json({
      ok: false,
      error:
        "Missing env vars: SHOPIFY_STORE_DOMAIN and/or SHOPIFY_STOREFRONT_ACCESS_TOKEN"
    });
  }

  try {
    const { query, variables } = req.body || {};
    if (!query) {
      return res.status(400).json({ ok: false, error: "Missing 'query' in body" });
    }

    const r = await fetch(`https://${domain}/api/2024-07/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token
      },
      body: JSON.stringify({ query, variables: variables || {} })
    });

    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
