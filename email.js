const nodemailer = require('nodemailer');

async function sendViaResend(to, subject, text) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.ALERT_FROM_EMAIL || 'LaunchDesk <alerts@mylaunchdesk.com>',
      to,
      subject,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend request failed (${res.status}): ${body}`);
  }
}

async function sendViaGmail(to, subject, text) {
  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.ALERT_GMAIL_USER, pass: process.env.ALERT_GMAIL_APP_PASSWORD },
  });
  await transport.sendMail({ from: process.env.ALERT_GMAIL_USER, to, subject, text });
}

// Tries whichever sender is configured - Gmail app password first since it
// needs no domain verification, falling back to Resend if that's set
// instead. No-ops silently if neither is configured, so callers never break
// on missing email config, they just don't send. Shared by the low-balance
// alert and the in-app Contact Support form so there's one sending path,
// not two copies to keep in sync.
async function sendEmail(to, subject, text) {
  if (!to) return;

  if (process.env.ALERT_GMAIL_USER && process.env.ALERT_GMAIL_APP_PASSWORD) {
    await sendViaGmail(to, subject, text);
  } else if (process.env.RESEND_API_KEY) {
    await sendViaResend(to, subject, text);
  }
}

module.exports = { sendEmail };
