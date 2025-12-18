function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emailHtml({
  brandName,
  orderNumber,
  destination,
  planName,
  iosUniversalLink,
  smdpAddress,
  activationCode,
  supportUrl,
}) {
  const hasIos = !!iosUniversalLink;

  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif; line-height: 1.4; color: #111;">
    <h2 style="margin:0 0 12px 0;">Your eSIM is ready to install</h2>
    <p style="margin:0 0 12px 0;">Thanks for your order with <b>${esc(brandName)}</b>.</p>

    <div style="padding:12px; border:1px solid #eee; border-radius:10px; margin: 12px 0;">
      <div><b>Order:</b> ${esc(orderNumber)}</div>
      <div><b>Destination:</b> ${esc(destination)}</div>
      <div><b>Plan:</b> ${esc(planName)}</div>
    </div>

    ${
      hasIos
        ? `
      <h3 style="margin:16px 0 8px 0;">Install on iPhone (recommended)</h3>
      <p style="margin:0 0 12px 0;">Open this email on your iPhone and tap:</p>
      <p style="margin:0 0 16px 0;">
        <a href="${esc(iosUniversalLink)}" style="display:inline-block; padding:12px 16px; background:#111; color:#fff; text-decoration:none; border-radius:10px;">
          Install eSIM
        </a>
      </p>
      `
        : `
      <p style="margin:0 0 12px 0;"><b>iPhone install link:</b> Not available for this eSIM. Use manual install below.</p>
      `
    }

    <h3 style="margin:16px 0 8px 0;">Manual installation (Android / fallback)</h3>
    <p style="margin:0 0 8px 0;">If prompted, enter:</p>
    <div style="padding:12px; border:1px solid #eee; border-radius:10px; margin: 8px 0 16px 0;">
      <div style="margin:0 0 8px 0;"><b>SM-DP+ Address:</b><br><code>${esc(smdpAddress)}</code></div>
      <div><b>Activation Code:</b><br><code>${esc(activationCode)}</code></div>
    </div>

    <p style="margin:0 0 6px 0;">Need help?</p>
    <p style="margin:0;">
      <a href="${esc(supportUrl)}">${esc(supportUrl)}</a>
    </p>
  </div>
  `;
}

/**
 * Sends the eSIM email via Resend REST API.
 * Required env vars:
 * - RESEND_API_KEY
 * - EMAIL_FROM (e.g. "eTravelSIM <noreply@etravelsim.co.uk>")
 */
export async function sendEsimEmail({
  to,
  orderNumber,
  destination,
  planName,
  iosUniversalLink,
  smdpAddress,
  activationCode,
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "eTravelSIM <onboarding@resend.dev>";

  if (!apiKey) throw new Error("Missing RESEND_API_KEY");
  if (!to) throw new Error("Missing recipient email 'to'");
  if (!smdpAddress || !activationCode) throw new Error("Missing SM-DP+ / activation code");

  const brandName = "eTravelSIM";
  const supportUrl = "https://etravelsim.co.uk/support";

  const subject = "📱 Your eSIM is ready to install";

  const html = emailHtml({
    brandName,
    orderNumber: orderNumber || "Your order",
    destination: destination || "Your destination",
    planName: planName || "Your plan",
    iosUniversalLink: iosUniversalLink || "",
    smdpAddress,
    activationCode,
    supportUrl,
  });

  const payload = {
    from,
    to,
    subject,
    html,
  };

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`Resend send failed ${r.status}: ${JSON.stringify(json)}`);
  }

  return json;
}
