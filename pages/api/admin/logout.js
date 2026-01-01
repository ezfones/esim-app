import { clearAdminSession } from "../../../lib/admin-auth";

export default function handler(req, res) {
  clearAdminSession(res);
  return res.status(200).json({ ok: true });
}
