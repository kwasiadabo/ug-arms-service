/**
 * Email delivery through SMTP with a branded HTML template and a plain-text alternative.
 *
 * All text placed into the HTML is escaped, so content such as a record title cannot inject markup into an email.
 * Emails are normally sent by the notifications queue rather than directly from a request.
 *
 * @author Kwasi Adabo Boakye
 */

import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

let transport;

/**
 * Returns the shared Nodemailer transport, creating it on first use from the SMTP settings.
 *
 * @returns {import('nodemailer').Transporter}
 */
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
  }
  return transport;
}

/**
 * Escapes the characters that have a special meaning in HTML.
 *
 * @param {*} s Text to escape; null and undefined become an empty string.
 * @returns {string}
 */
const escape = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * Builds the HTML and plain-text versions of a notification email.
 *
 * The HTML version shows the crest (from an absolute URL, because email clients cannot resolve relative paths), the
 * title, the body and an optional action button in the University colours. The plain-text version contains the same
 * information for clients that do not display HTML.
 *
 * @param {{ title: string, body: string, actionUrl?: string, actionLabel?: string }} message Content of the email.
 * @returns {{ html: string, text: string }}
 */
export function renderEmail({ title, body, actionUrl, actionLabel }) {
  // Absolute URL: email clients cannot resolve relative paths. Many clients block images until allowed, hence the alt text.
  const crestUrl = `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/brand/ug-crest.png`;
  const html = `<!doctype html><html><body style="font-family:Manrope,Arial,sans-serif;background:#f7f6fa;padding:24px;color:#1e1c2b">
  <div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">
  <div style="border-top:4px solid #dfb725;margin:-28px -28px 20px;border-radius:12px 12px 0 0"></div>
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
  <td style="padding-right:10px"><img src="${escape(crestUrl)}" width="40" height="40" alt="University of Ghana crest" style="display:block"></td>
  <td style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#2b1471;font-weight:700">University of Ghana Archives</td>
  </tr></table>
  <h1 style="font-size:20px;margin:12px 0">${escape(title)}</h1>
  <p style="line-height:1.6;white-space:pre-line">${escape(body)}</p>
  ${actionUrl ? `<p><a href="${escape(actionUrl)}" style="display:inline-block;background:#2b1471;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${escape(actionLabel || 'Open')}</a></p>` : ''}
  <p style="font-size:12px;color:#6b7280;margin-top:24px">This is an automated message from UG-ARMS.</p></div></body></html>`;
  const textBody = `${title}\n\n${body}${actionUrl ? `\n\n${actionLabel || 'Open'}: ${actionUrl}` : ''}`;
  return { html, text: textBody };
}

/**
 * Sends an email.
 *
 * @param {{ to: string, subject: string, title?: string, body: string, actionUrl?: string, actionLabel?: string }}
 *   message Recipient and content; the title defaults to the subject.
 * @returns {Promise<true>}
 * @throws {Error} When the SMTP server refuses the message, so the queue can retry it.
 */
export async function sendMail({ to, subject, title, body, actionUrl, actionLabel }) {
  const { html, text } = renderEmail({ title: title || subject, body, actionUrl, actionLabel });
  try {
    await getTransport().sendMail({ from: env.MAIL_FROM, to, subject, html, text });
    return true;
  } catch (err) {
    logger.warn({ err: err.message, to }, 'Email delivery failed');
    throw err;
  }
}
