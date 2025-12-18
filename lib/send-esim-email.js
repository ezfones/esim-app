const { Resend } = require("resend");

/**
 * Escape HTML to avoid broken emails / injection
 */
function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Build the email HTML
 */
function buildEmailHtml({
  customerName,
  productTitle,
  iccid,
  qrCodeUrl,
  iosInstallUrl,
}) {
  return `
  <div style="font-family: Arial, sans-serif; max-width: 600px">
    <h2>Your eSIM is ready</h2>

    <p>Hi ${escapeHtml(customerName || "there")},</p>

    <p>
      Your <strong>${escapeHtml(productTitle || "eSIM")}</strong> has been
      activated and is ready to install.
    </p>

    <h3>Install your eSIM</h3>

    ${
      iosInstallUrl
        ? `<p><strong>iPhone:</strong><br />
           <a href="${escapeHtml(
             iosInstallUrl
           )}">Tap here to install eSIM</a></p>`
        : ""
    }

    ${
      qrCodeUrl
        ? `<p><strong>QR Code (Android / manual install):</strong><br />
           <a href="${escapeHtml(qrCodeUrl)}">View QR code</a></p>`
        : ""
    }

    ${
      iccid
        ? `<p><strong>ICCID:</strong> ${escapeHtml(iccid)}</p>`
        : ""
    }

    <p style="margin-top: 24px">
      If you have any issues installing your eSIM, simply reply to this email
      and our support team will help.
    </p>

    <p>Thank you,<br />eTravelSIM</p>
  </div>
  `;
}

/**
 * Send the eSIM email via Resend
 */
async function sendEsimEmail({ to, subject, payload }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not set");
  }
  if (!process.env.RESEND_FROM) {
    throw new Error("RESEND_FROM is not set");
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  return await resend.emails.send({
    from: process.env.RESEND_FROM,
    to,
    subject,
    html: buildEmailHtml(payload),
  });
}

module.exports = { sendEsimEmail };
