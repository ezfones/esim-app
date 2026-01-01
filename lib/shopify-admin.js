function getDomain() {
  const d = (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").trim();
  if (!d) throw new Error("Missing SHOPIFY_STORE_DOMAIN");
  return d;
}

function getAdminToken() {
  const t = (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim();
  if (!t) throw new Error("Missing SHOPIFY_ADMIN_ACCESS_TOKEN");
  return t;
}

export async function shopifyAdminGraphql(query, variables = {}) {
  const domain = getDomain();
  const token = getAdminToken();

  const resp = await fetch(`https://${domain}/admin/api/2024-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json();
  if (!resp.ok || json.errors) {
    throw new Error(JSON.stringify(json.errors || json));
  }
  return json.data;
}
