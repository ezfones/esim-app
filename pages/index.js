import { useEffect, useState } from "react";

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [products, setProducts] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setErr("");

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

        const r = await fetch("/api/shopify-graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, variables: { first: 25 } })
        });

        const json = await r.json();

        if (!r.ok) {
          const msg =
            json?.errors?.[0]?.message || json?.error || `HTTP ${r.status}`;
          throw new Error(msg);
        }

        const edges = json?.data?.products?.edges || [];
        setProducts(edges.map((e) => e.node));
      } catch (e) {
        setErr(e.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>NeedeSIM Products</h1>

      <p>
        Health check: <a href="/api/ping">/api/ping</a>
      </p>

      {loading && <p>Loading products…</p>}
      {err && <p style={{ color: "crimson" }}>Error: {err}</p>}

      {!loading && !err && (
        <ul>
          {products.map((p) => (
            <li key={p.id}>
              <strong>{p.title}</strong> — <code>{p.handle}</code>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
