// Lazy Gmail SMTP transporter. Used by the v3 invite email endpoint.
// Returns null when SMTP_USER / SMTP_PASS are not set so callers can fall
// back to the "copy link" UX instead of crashing the request.
//
// IMPORTANT: Render's free tier (and many other PaaS providers) blocks
// outbound port 465. We use port 587 with STARTTLS instead, which is
// allowed. Connection / greeting / socket timeouts are short so a
// blocked-port failure surfaces in seconds rather than ~30s.

import nodemailer from 'nodemailer';

let transporter = null;

export function isConfigured() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS upgrade after EHLO
      requireTLS: true,
      auth: {
        user: process.env.SMTP_USER,
        // Gmail App Passwords are accepted with or without spaces; strip
        // them defensively so users can paste either format.
        pass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }
  return transporter;
}
