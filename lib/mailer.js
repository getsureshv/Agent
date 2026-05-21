// Mail sender backed by the Resend HTTP API (https://resend.com).
//
// We use HTTP because Render's free tier blocks outbound SMTP (ports
// 25/465/587). Resend's API runs over port 443 which is always open.
//
// Configuration (env vars):
//   RESEND_API_KEY     — required to enable sending. Starts with "re_".
//   MAIL_FROM          — sender address. Defaults to "onboarding@resend.dev"
//                        which Resend lets you use without verifying a
//                        domain (useful for testing). Production should
//                        verify a real domain in Resend and set this.
//   MAIL_FROM_NAME     — display name. Defaults to "Cricket Scorer".
//
// We keep the legacy SMTP_USER / SMTP_PASS / SMTP_FROM_NAME env vars
// recognized for backward-compatible "isConfigured" reporting only —
// they don't actually send mail anymore (SMTP is blocked on Render).
//
// API surface preserved so callers don't change:
//   isConfigured(): boolean
//   sendMail({ to, subject, text, html, replyTo }): Promise<{ id }>
//   getTransporter(): legacy alias for callers that only need a truthy
//     check; returns null when !isConfigured() and a { sendMail } shim
//     otherwise.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

function fromHeader() {
  const addr = (process.env.MAIL_FROM || 'onboarding@resend.dev').trim();
  const name = (process.env.MAIL_FROM_NAME || process.env.SMTP_FROM_NAME || 'Cricket Scorer').trim();
  return `${name} <${addr}>`;
}

export async function sendMail({ to, subject, text, html, replyTo }) {
  if (!isConfigured()) {
    throw new Error('Mailer not configured (RESEND_API_KEY missing)');
  }
  const body = {
    from: fromHeader(),
    to: Array.isArray(to) ? to : [to],
    subject,
    text,
    html,
  };
  // Resend honours `reply_to` (snake_case) on the HTTP API. If the caller
  // passes a reply-to address (e.g. the captain who triggered the invite),
  // the player can hit Reply in their mail client and reach the captain
  // directly even when we're still sending from onboarding@resend.dev.
  if (replyTo) {
    body.reply_to = Array.isArray(replyTo) ? replyTo : [replyTo];
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  let resp;
  try {
    resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Mail send timed out after 15s');
    }
    throw new Error(`Mail send network error: ${err.message}`);
  } finally {
    clearTimeout(t);
  }
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = payload?.message || payload?.error || `HTTP ${resp.status}`;
    throw new Error(`Resend rejected mail: ${msg}`);
  }
  return { id: payload?.id || null };
}

// Legacy shim so existing nodemailer-style callers keep working without
// edits: const transporter = getTransporter(); await transporter.sendMail(opts).
// We ignore the nodemailer-only `from` field on incoming options and use
// fromHeader() internally, since Resend requires a verified sender and the
// caller's value (which used to be SMTP_USER) is no longer authoritative.
export function getTransporter() {
  if (!isConfigured()) return null;
  return {
    sendMail: async (opts) => sendMail(opts),
  };
}
