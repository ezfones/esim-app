export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    message: "SHOPIFY GRAPHQL UPDATED - v2",
    method: req.method,
    ts: new Date().toISOString()
  });
}
