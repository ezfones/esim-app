export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Use POST" });
  }

  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;

  if (!domain || !token) {
    return res.status(500).json({
      ok: false,
      error: "Missing env vars: SHOPIFY_STORE_DOMAIN / SHOPIFY_STOREFRONT_ACCESS_TOKEN"
    });
  }

  const { variantId, quantity } = req.body || {};
  const qty = Number(quantity || 1);

  if (!variantId || typeof variantId !== "string") {
    return res.status(400).json({ ok: false, error: "Missing variantId" });
  }
  if (!Number.isFinite(qty) || qty < 1 || qty > 10) {
    return res.status(400).json({ ok: false, error: "Invalid quantity (1-10)" });
  }

  const query = `
    mutation CartCreate($lines: [CartLineInput!]!) {
      cartCreate(input: { lines: $lines }) {
        cart {
          id
          checkoutUrl
        }
        userErrors {
          field
          message
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
      body: JSON.stringify({
        query,
        variables: { lines: [{ merchandiseId: variantId, quantity: qty }] }
      })
    });

    const json = await r.json();

    const errs = json?.data?.cartCreate?.userErrors || [];
    if (errs.length) {
      return res.status(400).json({ ok: false, error: "Cart create failed", userErrors: errs });
    }

    const checkoutUrl = json?.data?.cartCreate?.cart?.checkoutUrl;
    if (!checkoutUrl) {
      return res.status(500).json({ ok: false, error: "No checkoutUrl returned", raw: json });
    }

    return res.status(200).json({ ok: true, checkoutUrl });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
