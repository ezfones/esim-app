// pages/api/admin/me.js
import { requireAdmin } from "../../../lib/admin-auth";

export default function handler(req, res) {
  const admin = requireAdmin(req);
  if (!admin) {
    return res.status(401).json({ ok: false, error: "Admin not logged in" });
  }
  return res.status(200).json({
    ok: true,
    admin: { email: admin.email }
  });
}
