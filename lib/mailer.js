// Lazy Gmail SMTP transporter. Used by the v3 invite email endpoint.
// Returns null when SMTP_USER / SMTP_PASS are not set so callers can fall
// back to the "copy link" UX instead of crashing the request.

import nodemailer from 'nodemailer';

let transporter = null;

export function isConfigured() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}
