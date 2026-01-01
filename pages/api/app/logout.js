import { setCookie } from "../../../lib/storefront-auth";

export default function handler(req, res) {
  // clear customer session cookie
  setCookie(res, "sf_sess", "", { maxAge: 0 });
  return res.status(200).json({ ok: true });
}
