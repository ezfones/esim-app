export default async function handler(req, res) {
  const body = req.body || {};

  // eSIM GO callback receiver
  res.status(200).json({
    ok: true,
    receivedCallback: body
  });
}
