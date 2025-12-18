import { Resend } from "resend";

function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function sendEsimEmail({
  to,
  from,
  orderName,
  shopDomain,
  itemsJson,
  iccid,
  smdpAddress,
  activationCode,
  iosUniversalLink,
  qrPngUrl,
}) {
  if (!to) throw new Error("Missing customer email (to)");
  if (!from) throw new Error("Missing EMAIL_FROM env var");
  if (!smdpAddress || !activationCode) {
    throw new Error("Missing SM-DP+ / activation code");
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  const subject = `Your eSIM details for ${orderName || "your order"} (${shopDomain})`;

  const itemsPretty = (() => {
    try {
      const items = JSON.parse(itemsJson || "[]");
      if (!Array.isArray(items) || items.length === 0) return "";
      return items
        .map((i) => `• ${i.title || ""} — ${i.sku || ""} ×${i.quantity || 1}`)
        .join("\n");
    } catch {
      return "";
    }
  })();

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5">
    <h2>Your eSIM is ready ✅</h2>
    <p><b>Order:</b> ${esc(orderName || "")}</p>
    ${itemsPretty ? `<pre style="background:#f6f6f6;padding:12px;border-radius:8px">${esc(itemsPretty)}</pre>` : ""}

    <h3>Install details</h3>
    <p><b>SM-DP+ Address:</b> ${esc(smdpAddress)}</p>
    <p><b>Activation Code:</b> ${esc(activationCode)}</p>
    ${iccid ? `<p><b>ICCID:</b> ${esc(iccid)}</p>` : ""}

    ${iosUniversalLink ? `<p><b>iPhone install link:</b><br/><a href="${esc(iosUniversalLink)}">${esc(iosUniversalLink)}</a></p>` : ""}

    ${qrPngUrl ? `<p><b>QR code (PNG):</b><br/><a href="${esc(qrPngUrl)}">${esc(qrPngUrl)}</a></p>` : ""}

    <p style="margin-top:24px;color:#666;font-size:13px">
      If you need help installing: open Settings → Mobile Data/Cellular → Add eSIM.
    </p>
  </div>
  `;

  const result = await resend.emails.send({
    from,
    to,
    subject,
    html,
  });

  return result;
}
