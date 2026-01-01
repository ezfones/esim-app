import { setAdminSession } from "../../../lib/admin-auth";

function isAllowedAdminEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return e.endsWith("@etravelsim.co.uk") || e === "matt_vairy@yahoo.co.uk";
}

export default function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: "Missing email/password" });

    if (!isAllowedAdminEmail(email)) return res.status(403).json({ ok: false, error: "Not allowed" });

    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) return res.status(500).json({ ok: false, error: "Missing ADMIN_PASSWORD" });

    if (String(password) !== String(adminPassword)) {
      return res.status(401).json({ ok: false, error: "Invalid password" });
    }

    setAdminSession(res, email);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "error" });
  }
}
