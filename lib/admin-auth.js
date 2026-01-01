import { seal, unseal, getCookie, setCookie } from "./storefront-auth";

function isAllowedAdminEmail(email) {
  if (!email) return false;
  const e = String(email).trim().toLowerCase();
  return e.endsWith("@etravelsim.co.uk") || e === "matt_vairy@yahoo.co.uk";
}

export function requireAdmin(req) {
  const packed = getCookie(req, "admin_sess");
  const sess = unseal(packed);
  if (!sess?.email || !isAllowedAdminEmail(sess.email)) return null;
  return sess;
}

export function setAdminSession(res, email) {
  setCookie(res, "admin_sess", seal({ email: String(email).toLowerCase(), ts: Date.now() }), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 60 * 60 * 12,
  });
}

export function clearAdminSession(res) {
  setCookie(res, "admin_sess", "", { maxAge: 0 });
}
