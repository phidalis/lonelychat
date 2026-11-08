"use strict";

/*
 * Hearth Chat — Resend email helpers + templates
 * ----------------------------------------------
 * Environment variables (set on Render):
 *   RESEND_API_KEY   — from your Resend dashboard (API Keys)
 *   FROM_EMAIL       — a verified sender, e.g. "Hearth Chat <noreply@yourdomain.com>"
 *   FROM_NAME        — display name used in the email footer, e.g. "Hearth Chat"
 *   APP_URL          — public frontend URL; required for unread-message digests.
 *                      Auth-email routes can fall back to the request Origin.
 *   SUPABASE_URL             — project URL (needed for auth links)
 *   SUPABASE_SERVICE_ROLE_KEY — service role key for auth links
 *
 * Templates are built into the app and are no longer editable from the admin
 * panel. The admin can send one-off email notifications to selected members
 * instead (see server.js /api/email/notify).
 *
 * Placeholders (tokens) used in template bodies:
 *   reset / confirmation:  {{ appName }} {{ email }} {{ link }} {{ buttonText }}
 *   notification:          {{ appName }} {{ headline }} {{ senderName }}
 *                          {{ recipientName }} {{ text }} {{ actionUrl }}
 *                          {{ actionLabel }} {{ actionButton }}
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const BUTTON_STYLE = "display:inline-block;background:#6c5ce7;color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:10px;font-size:14px;font-weight:700;";

const TEXT = "margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d4560;";

const DEFAULT_TEMPLATES = {
  reset: {
    subject: "Reset your {{ appName }} password",
    body: [
      '<h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;font-weight:800;color:#1e2537;">Reset your password</h1>',
      '<p style="' + TEXT + '">Hi,</p>',
      '<p style="' + TEXT + '">We received a request to reset the password for <b style="color:#1e2537;">{{ email }}</b>. Tap the button below to choose a new password.</p>',
      '<p style="margin:0 0 22px;"><a href="{{ link }}" style="' + BUTTON_STYLE + '">{{ buttonText }}</a></p>',
      '<p style="margin:0;color:#8b92a9;font-size:13px;line-height:1.6;">This link expires in one hour. If you didn\'t request a password reset, you can safely ignore this email — your password won\'t change.</p>'
    ].join("\n")
  },
  confirmation: {
    subject: "Confirm your email for {{ appName }}",
    body: [
      '<h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;font-weight:800;color:#1e2537;">Confirm your email</h1>',
      '<p style="' + TEXT + '">Welcome to {{ appName }} — you\'re almost there.</p>',
      '<p style="' + TEXT + '">Tap the button below to confirm <b style="color:#1e2537;">{{ email }}</b> and finish setting up your account.</p>',
      '<p style="margin:0 0 22px;"><a href="{{ link }}" style="' + BUTTON_STYLE + '">{{ buttonText }}</a></p>',
      '<p style="margin:0;color:#8b92a9;font-size:13px;line-height:1.6;">This link expires in 24 hours. If you didn\'t create an account, you can safely ignore this email.</p>'
    ].join("\n")
  },
  notification: {
    subject: "{{ headline }}",
    body: [
      '<h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;font-weight:800;color:#1e2537;">{{ headline }}</h1>',
      '<p style="margin:0 0 14px;color:#8b92a9;font-size:14px;line-height:1.6;">Hi {{ recipientName }},</p>',
      '<p style="' + TEXT + '">{{ text }}</p>',
      '{{ actionButton }}'
    ].join("\n")
  }
};

function appName() {
  return process.env.FROM_NAME || "Hearth Chat";
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Replace {{ token }} placeholders with the given values. Values are already
// escaped by the caller; unknown tokens are left untouched.
function renderTemplate(src, tokens) {
  return String(src || "").replace(/\{\{\s*([\w]+)\s*\}\}/g, function (m, name) {
    return name in tokens ? tokens[name] : m;
  });
}

async function sendEmail({ to, subject, html, headers }) {
  const key = process.env.RESEND_API_KEY || "";
  if (!key) {
    const e = new Error("RESEND_API_KEY is not configured on the Render app.");
    e.code = "RESEND_NOT_CONFIGURED";
    throw e;
  }
  const from = String(process.env.FROM_EMAIL || "").trim();
  if (!from) {
    const e = new Error("FROM_EMAIL is not configured on the Render app.");
    e.code = "FROM_EMAIL_NOT_CONFIGURED";
    throw e;
  }
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ from: from, to: [to], subject: subject, html: html }, headers ? { headers: headers } : {}))
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.message || data.name || "Resend could not send the email.");
    e.code = "RESEND_REJECTED";
    throw e;
  }
  return data;
}

function logoMarkup(brand, baseOverride) {
  const base = String(baseOverride || process.env.APP_URL || "").replace(/\/+$/, "");
  if (base) {
    return '<img src="' + esc(base) + '/icon-512.png" width="48" height="48" alt="' + esc(brand) + '" ' +
      'style="display:block;margin:0 auto 10px;width:48px;height:48px;border-radius:13px;border:0;outline:none;text-decoration:none;">';
  }
  return '<div style="width:48px;height:48px;margin:0 auto 10px;border-radius:13px;background:#6c5ce7;color:#fff;' +
    'font-size:24px;line-height:48px;font-weight:800;text-align:center;">&#9829;</div>';
}

function layout({ title, body, preheader, unsubscribeUrl, logoBase }) {
  const brand = appName();
  const pre = preheader
    ? '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">' + esc(preheader) + '</div>'
    : "";
  const footerParts = [
    'You\'re receiving this email because you have an account with ' + esc(brand) + '.'
  ];
  if (unsubscribeUrl) {
    footerParts.push('<a href="' + esc(unsubscribeUrl) + '" style="color:#8b92a9;text-decoration:underline;">Unsubscribe from these emails</a>');
  }
  footerParts.push('&copy; ' + new Date().getFullYear() + ' ' + esc(brand) + '. All rights reserved.');
  const footer = footerParts.join('<br>');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5fb;font-family:Inter,'Segoe UI',Arial,sans-serif;color:#1e2537;">
  ${pre}
  <div style="padding:36px 16px;">
    <div style="max-width:520px;margin:0 auto;">
      <div style="text-align:center;margin-bottom:20px;">
        ${logoMarkup(brand, logoBase)}
        <div style="font-weight:800;font-size:18px;letter-spacing:-0.2px;color:#1e2537;">${esc(brand)}</div>
      </div>
      <div style="background:#ffffff;border:1px solid #e8eaf3;border-radius:18px;box-shadow:0 12px 32px rgba(40,48,84,0.07);padding:32px 30px;">
        ${body}
      </div>
      <p style="text-align:center;color:#8b92a9;font-size:12px;line-height:1.7;margin:20px 0 0;">${footer}</p>
    </div>
  </div>
</body>
</html>`;
}

function button(href, label) {
  return `<a href="${esc(href)}" style="${BUTTON_STYLE}">${esc(label)}</a>`;
}

function getTemplate(kind) {
  const def = DEFAULT_TEMPLATES[kind] || { subject: "", body: "" };
  return { subject: def.subject, body: def.body };
}

function headlineFor(kind, senderName, override) {
  if (override) return override;
  const who = senderName || "Someone";
  if (kind === "follow") return who + " followed you";
  if (kind === "message") return who + " sent you a message";
  return "You have a new notification";
}

/* ---------------- Reset password template ---------------- */

async function resetPasswordTemplate({ link, email, appUrl }) {
  const t = getTemplate("reset");
  const tokens = {
    appName: esc(appName()),
    email: esc(email),
    link: esc(link),
    buttonText: "Reset password"
  };
  return layout({
    title: renderTemplate(t.subject, tokens),
    body: renderTemplate(t.body, tokens),
    preheader: "Choose a new password for your " + appName() + " account. This link expires in one hour.",
    logoBase: appUrl
  });
}

/* ---------------- Email confirmation template ---------------- */

async function confirmationTemplate({ link, email, appUrl }) {
  const t = getTemplate("confirmation");
  const tokens = {
    appName: esc(appName()),
    email: esc(email),
    link: esc(link),
    buttonText: "Confirm email"
  };
  return layout({
    title: renderTemplate(t.subject, tokens),
    body: renderTemplate(t.body, tokens),
    preheader: "Confirm your email to finish setting up your " + appName() + " account.",
    logoBase: appUrl
  });
}

/* ---------------- Notification template ---------------- */

async function notificationSubject({ senderName, kind, headline }) {
  const t = getTemplate("notification");
  const tokens = {
    appName: esc(appName()),
    headline: esc(headlineFor(kind, senderName, headline)),
    senderName: esc(senderName || "Someone"),
    recipientName: "",
    text: "",
    actionUrl: "",
    actionLabel: "",
    actionButton: ""
  };
  return renderTemplate(t.subject, tokens);
}

async function notificationTemplate({ recipientName, senderName, kind, text, actionLabel, actionUrl, headline, unsubscribeUrl, appUrl }) {
  const t = getTemplate("notification");
  const tokens = {
    appName: esc(appName()),
    headline: esc(headlineFor(kind, senderName, headline)),
    senderName: esc(senderName || "Someone"),
    recipientName: esc(recipientName || "there"),
    text: esc(text || "").replace(/\n/g, "<br>"),
    actionUrl: esc(actionUrl || ""),
    actionLabel: esc(actionLabel || "Open Hearth Chat"),
    actionButton: actionUrl
      ? '<p style="margin:22px 0 0;">' + button(actionUrl, actionLabel || "Open Hearth Chat") + "</p>"
      : ""
  };
  return layout({
    title: renderTemplate(t.subject, tokens),
    body: renderTemplate(t.body, tokens),
    preheader: headlineFor(kind, senderName, headline),
    unsubscribeUrl: unsubscribeUrl,
    logoBase: appUrl
  });
}

module.exports = {
  appName: appName,
  sendEmail: sendEmail,
  resetPasswordTemplate: resetPasswordTemplate,
  confirmationTemplate: confirmationTemplate,
  notificationSubject: notificationSubject,
  notificationTemplate: notificationTemplate
};
