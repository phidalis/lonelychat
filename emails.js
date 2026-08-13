"use strict";

/*
 * Hearth Chat — Resend email helpers + templates
 * ----------------------------------------------
 * Environment variables (set on Render):
 *   RESEND_API_KEY   — from your Resend dashboard (API Keys)
 *   FROM_EMAIL       — a verified sender, e.g. "Hearth Chat <noreply@yourdomain.com>"
 *   FROM_NAME        — display name used in the email footer, e.g. "Hearth Chat"
 *   APP_URL          — optional; falls back to the request Origin header.
 *                      e.g. https://yourdomain.com
 *   SUPABASE_URL             — project URL (needed to read saved templates)
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (needed to read saved templates)
 *
 * The templates can be edited in the admin panel (Settings > Email templates).
 * The saved versions are stored in the Supabase "settings" table under the
 * "email" key and override the defaults below. If nothing is saved (or the
 * Supabase env vars are missing) the defaults below are used.
 *
 * Placeholders (tokens) used in template bodies:
 *   reset / confirmation:  {{ appName }} {{ email }} {{ link }} {{ buttonText }}
 *   notification:          {{ appName }} {{ headline }} {{ senderName }}
 *                          {{ recipientName }} {{ text }} {{ actionUrl }}
 *                          {{ actionLabel }} {{ actionButton }}
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TEMPLATE_CACHE_MS = 60 * 1000; // refresh saved templates at most once a minute

const BUTTON_STYLE = "display:inline-block;background:#6c5ce7;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-size:14px;font-weight:700;";

const DEFAULT_TEMPLATES = {
  reset: {
    subject: "Reset your password",
    body: [
      '<h1 style="margin:0 0 6px;font-size:20px;font-weight:800;">Reset your password</h1>',
      '<p style="color:#8b92a9;font-size:13px;margin:0 0 16px;">We got a request to reset the password for {{ email }}.</p>',
      '<p style="margin:0 0 20px;font-size:15px;line-height:1.6;">Tap the button below to choose a new password. This link expires in one hour.</p>',
      '<p style="margin:0;"><a href="{{ link }}" style="' + BUTTON_STYLE + '">{{ buttonText }}</a></p>',
      '<p style="margin:22px 0 0;color:#8b92a9;font-size:12px;line-height:1.5;">If you didn\'t request this, you can safely ignore this email — your password won\'t change.</p>'
    ].join("\n")
  },
  confirmation: {
    subject: "Confirm your email",
    body: [
      '<h1 style="margin:0 0 6px;font-size:20px;font-weight:800;">Confirm your email</h1>',
      '<p style="color:#8b92a9;font-size:13px;margin:0 0 16px;">Almost done, {{ email }}.</p>',
      '<p style="margin:0 0 20px;font-size:15px;line-height:1.6;">Tap the button below to verify your email and finish creating your account.</p>',
      '<p style="margin:0;"><a href="{{ link }}" style="' + BUTTON_STYLE + '">{{ buttonText }}</a></p>',
      '<p style="margin:22px 0 0;color:#8b92a9;font-size:12px;line-height:1.5;">If the button doesn\'t work, paste this link in your browser:<br>{{ link }}</p>'
    ].join("\n")
  },
  notification: {
    subject: "{{ headline }}",
    body: [
      '<h1 style="margin:0 0 6px;font-size:20px;font-weight:800;">{{ headline }}</h1>',
      '<p style="color:#8b92a9;font-size:13px;margin:0 0 16px;">Hi {{ recipientName }},</p>',
      '<p style="margin:0 0 20px;font-size:15px;line-height:1.6;">{{ text }}</p>',
      '{{ actionButton }}',
      '<p style="margin:22px 0 0;color:#8b92a9;font-size:12px;line-height:1.5;">There\'s someone who wants to talk to you. We\'ll always reply.</p>'
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

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY || "";
  if (!key) {
    const e = new Error("RESEND_API_KEY is not configured on the Render app.");
    e.code = "RESEND_NOT_CONFIGURED";
    throw e;
  }
  const from = process.env.FROM_EMAIL || "Hearth Chat <onboarding@resend.dev>";
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from: from, to: [to], subject: subject, html: html })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.message || data.name || "Resend could not send the email.");
    e.code = "RESEND_REJECTED";
    throw e;
  }
  return data;
}

function layout({ title, body }) {
  const brand = appName();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5fb;font-family:Inter,'Segoe UI',Arial,sans-serif;color:#1e2537;">
  <div style="padding:32px 16px;">
    <div style="max-width:520px;margin:0 auto;">
      <div style="text-align:center;margin-bottom:18px;">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#6c5ce7,#2fa58f);color:#fff;font-size:20px;font-weight:800;">&#9829;</span>
        <div style="font-weight:800;font-size:17px;margin-top:8px;">${esc(brand)}</div>
      </div>
      <div style="background:#ffffff;border-radius:18px;box-shadow:0 10px 30px rgba(40,48,84,0.08);padding:28px 26px;">
        ${body}
      </div>
      <p style="text-align:center;color:#8b92a9;font-size:12px;margin-top:18px;">You received this email because you have an account with ${esc(brand)}.</p>
    </div>
  </div>
</body>
</html>`;
}

function button(href, label) {
  return `<a href="${esc(href)}" style="${BUTTON_STYLE}">${esc(label)}</a>`;
}

/* ---------------- saved template loading (Supabase settings) ---------------- */

let savedTemplatesCache = null;
let savedTemplatesAt = 0;

async function loadSavedTemplates() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) return null;
  if (savedTemplatesCache && Date.now() - savedTemplatesAt < TEMPLATE_CACHE_MS) return savedTemplatesCache;

  let out = null;
  try {
    const res = await fetch(url + "/rest/v1/settings?key=eq.email&select=value", {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    const rows = await res.json().catch(() => []);
    const value = (Array.isArray(rows) && rows[0] && rows[0].value) || null;
    if (value && typeof value === "object" && value.templates && typeof value.templates === "object") {
      out = value.templates;
    }
  } catch (e) {
    console.error("[email] loadSavedTemplates", e && e.message);
  }
  savedTemplatesCache = out;
  savedTemplatesAt = Date.now();
  return out;
}

async function getTemplate(kind) {
  const def = DEFAULT_TEMPLATES[kind] || { subject: "", body: "" };
  const saved = await loadSavedTemplates();
  const s = (saved && saved[kind]) || null;
  return {
    subject: s && s.subject ? String(s.subject) : def.subject,
    body: s && s.body ? String(s.body) : def.body
  };
}

function templateDefaults() {
  return Object.keys(DEFAULT_TEMPLATES).reduce(function (out, k) {
    out[k] = { subject: DEFAULT_TEMPLATES[k].subject, body: DEFAULT_TEMPLATES[k].body };
    return out;
  }, {});
}

function headlineFor(kind, senderName) {
  const who = senderName || "Someone";
  if (kind === "follow") return who + " followed you";
  if (kind === "message") return who + " sent you a message";
  return "You have a new notification";
}

/* ---------------- Reset password template ---------------- */

async function resetPasswordTemplate({ link, email }) {
  const t = await getTemplate("reset");
  const tokens = {
    appName: esc(appName()),
    email: esc(email),
    link: esc(link),
    buttonText: "Reset password"
  };
  return layout({
    title: renderTemplate(t.subject, tokens),
    body: renderTemplate(t.body, tokens)
  });
}

/* ---------------- Email confirmation template ---------------- */

async function confirmationTemplate({ link, email }) {
  const t = await getTemplate("confirmation");
  const tokens = {
    appName: esc(appName()),
    email: esc(email),
    link: esc(link),
    buttonText: "Confirm email"
  };
  return layout({
    title: renderTemplate(t.subject, tokens),
    body: renderTemplate(t.body, tokens)
  });
}

/* ---------------- Notification template ---------------- */

async function notificationSubject({ senderName, kind }) {
  const t = await getTemplate("notification");
  const tokens = {
    appName: esc(appName()),
    headline: esc(headlineFor(kind, senderName)),
    senderName: esc(senderName || "Someone"),
    recipientName: "",
    text: "",
    actionUrl: "",
    actionLabel: "",
    actionButton: ""
  };
  return renderTemplate(t.subject, tokens);
}

async function notificationTemplate({ recipientName, senderName, kind, text, actionLabel, actionUrl }) {
  const t = await getTemplate("notification");
  const tokens = {
    appName: esc(appName()),
    headline: esc(headlineFor(kind, senderName)),
    senderName: esc(senderName || "Someone"),
    recipientName: esc(recipientName || "there"),
    text: esc(text || ""),
    actionUrl: esc(actionUrl || ""),
    actionLabel: esc(actionLabel || "Open Hearth Chat"),
    actionButton: actionUrl
      ? '<p style="margin:0;">' + button(actionUrl, actionLabel || "Open Hearth Chat") + "</p>"
      : ""
  };
  return layout({
    title: renderTemplate(t.subject, tokens),
    body: renderTemplate(t.body, tokens)
  });
}

module.exports = {
  appName: appName,
  sendEmail: sendEmail,
  templateDefaults: templateDefaults,
  resetPasswordTemplate: resetPasswordTemplate,
  confirmationTemplate: confirmationTemplate,
  notificationSubject: notificationSubject,
  notificationTemplate: notificationTemplate
};
