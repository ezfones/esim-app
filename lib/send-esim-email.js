const { Resend } = require("resend");

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildEmailHtml({
  customerName,
  productTitle,
  iccid,
  qrCodeUrl,
  iosInstallUrl,
  smdpAddress,
  matchingId,
  lpaString,
}) {
  return `
  <div style="font-family: Arial, sans-serif; max-width: 640px; line-height: 1.4;">
    <h2>Your eSIM is ready</h2>
    <p>Hi ${escapeHtml(customerName || "there")},</p>
    <p>Your <strong>${escapeHtml(productTitle || "eSIM")}</strong> is ready to install.</p>

    <h3>Install options</h3>

    ${iosInstallUrl ? `
      <p><strong>iPhone:</strong><br/>
      <a href="${escapeHtml(iosInstallUrl)}">Tap here to install eSIM</a></p>
    ` : ""}

    ${qrCodeUrl ? `
      <p><strong>QR Code (Android / manual):</strong><br/>
      <a href="${escapeHtml(qrCodeUrl)}">Open QR code</a></p>
    ` : ""}

    ${iccid ? `<p><strong>ICCID:</strong> ${escapeHtml(iccid)}</p>` : ""}

    ${(smdpAddress || matchingId || lpaString) ? `
      <h3>Manual install details (backup)</h3>
      ${smdpAddress ? `<p><strong>SM-DP+ Address:</strong> ${escapeHtml(smdpAddress)}</p>` : ""}
      ${matchingId ? `<p><strong>Activation Code:</strong> ${escapeHtml(matchingId)}</p>` : ""}
      ${lpaString ? `<p><strong>LPA String:</strong><br/><code>${escapeHtml(lpaString)}</code></p>` : ""}
    ` : ""}

    <p style="margin-top: 20px;">If you have any issues installing, reply to this email and we’ll help.</p>
    <p>Thanks,<br/>eTravelSIM</p>
  </div>`;
}

async function sendEsimEmail({ to, subject, payload }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;

  if (!apiKey) throw new Error("Missing RESEND_API_KEY");
  if (!from) throw new Error("Missing RESEND_FROM");
  if (!to) throw new Error("Missing recipient email (to)");

  const resend = new Resend(apiKey);

  return await resend.emails.send({
    from,
    to,
    subject,
    html: buildEmailHtml(payload),
  });
}

module.exports = { sendEsimEmail };
