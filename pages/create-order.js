export default async function handler(req, res) {
  const body = req.body || {};

  // This will later call eSIM GO
  res.status(200).json({
    ok: true,
    receivedOrder: body,
    message: "Order received, eSIM creation will go here"
  });
}
