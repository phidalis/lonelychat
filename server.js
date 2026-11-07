"use strict";

/*
 * Hearth Chat — M-Pesa (PayHero) backend for Render
 * -------------------------------------------------
 * Environment variables (set in Render):
 *   PAYHERO_AUTH_TOKEN     — Basic Authorization token from your Pay Hero API Keys
 *   PAYHERO_CHANNEL_ID     — Your registered payment channel ID
 *   PAYHERO_PROVIDER       — Payment provider, e.g. "m-pesa" (optional)
 *   CALLBACK_URL           — Optional override; defaults to this app's /api/mpesa/callback
 *   PORT                   — set automatically by Render (default 3000)
 */

const express = require("express");
const cors = require("cors");
const emails = require("./emails");
const digest = require("./digest");
const aiWorker = require("./ai-server");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.PAYHERO_AUTH_TOKEN || "";
const CHANNEL_ID = process.env.PAYHERO_CHANNEL_ID || "";
const PROVIDER = process.env.PAYHERO_PROVIDER || "m-pesa";
const CALLBACK_OVERRIDE = process.env.CALLBACK_URL || "";

// Email / Resend (same Render app).
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const BASE = "https://backend.payhero.co.ke/api/v2";

// In-memory store of PayHero callback results, keyed by the transaction reference.
const callbacks = {};

function configured() {
  return !!(AUTH_TOKEN && CHANNEL_ID);
}

function emailConfigured() {
  return !!(process.env.RESEND_API_KEY && String(process.env.FROM_EMAIL || "").trim());
}

function supabaseConfigured() {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json"
  };
}

// Resolve the frontend origin so auth links point back at the site.
function appOrigin(req) {
  return String(process.env.APP_URL || req.headers.origin || "").replace(/\/+$/, "");
}

async function supabaseFindUser(email) {
  const res = await fetch(SUPABASE_URL + "/auth/v1/admin/users?email=" + encodeURIComponent(email), { headers: supabaseHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.error_description || "Could not look up the user.");
  const arr = data.users || [];
  return arr.find(function (u) { return String(u.email).toLowerCase() === String(email).toLowerCase(); }) || null;
}

// Create an unconfirmed user (no email is sent by Supabase — we email them via Resend).
async function supabaseCreateUser({ email, password, data }) {
  const res = await fetch(SUPABASE_URL + "/auth/v1/admin/users", {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({ email: email, password: password, email_confirm: false, user_metadata: data || {} })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.msg || json.message || json.error_description || "Could not create the account.";
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return json;
}

async function supabaseDeleteUser(userId) {
  const res = await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + encodeURIComponent(userId), {
    method: "DELETE",
    headers: supabaseHeaders()
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.msg || json.message || "Could not remove the incomplete account.");
  }
}

// Mint an auth link without Supabase sending any email. The action_link is then
// emailed by us through Resend, so it always comes from your own domain.
async function supabaseGenerateLink(type, email, redirectTo) {
  const res = await fetch(SUPABASE_URL + "/auth/v1/admin/generate_link", {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({ type: type, email: email, options: { redirect_to: redirectTo } })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.msg || json.message || json.error_description || "Could not generate a link.";
    const e = new Error(msg); e.status = res.status; throw e;
  }
  const link = json.properties && json.properties.action_link;
  if (!link) throw new Error("No action link returned.");
  return link;
}

function authHeader() {
  const t = String(AUTH_TOKEN).trim();
  if (/^basic\s/i.test(t)) return t;
  return "Basic " + t;
}

// Accept 07XX…, 7XX…, 2547XX…, +2547XX… and return 2547XX…
function normalizePhone(input) {
  let s = String(input || "").replace(/[^\d+]/g, "");
  if (s.indexOf("+") === 0) s = s.slice(1);
  if (s.length === 9 && s[0] === "7") s = "254" + s;
  else if (s.length === 10 && s[0] === "0") s = "254" + s.slice(1);
  else if (s.length === 12 && s.indexOf("254") === 0) s = s;
  else if (s.length === 13 && s.indexOf("254") === 1) s = s.slice(1);
  return s;
}

function genReference() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Map a PayHero status response into success | failed | pending.
function parseStatus(data) {
  const root = data && typeof data === "object" ? data : {};
  const body = root.data && typeof root.data === "object" ? root.data : root;
  const resp = body.response && typeof body.response === "object" ? body.response : body;

  const statusRaw = String(resp.Status || resp.status || body.Status || body.status || root.status || "").toLowerCase();
  if (["success", "successful", "completed", "paid"].indexOf(statusRaw) !== -1) return "success";
  if (["failed", "failure", "error", "cancelled", "canceled", "timeout", "timed_out", "declined"].indexOf(statusRaw) !== -1) return "failed";
  if (["pending", "queued", "initiated", "processing", "in_progress", "waiting"].indexOf(statusRaw) !== -1) return "pending";

  const rc = resp.ResultCode !== undefined && resp.ResultCode !== null
    ? String(resp.ResultCode)
    : (body.ResultCode !== undefined && body.ResultCode !== null ? String(body.ResultCode) : "");
  if (rc === "0") {
    const desc = String(resp.ResultDesc || body.ResultDesc || "").toLowerCase();
    if (desc.indexOf("still") !== -1 || desc.indexOf("processing") !== -1 || desc.indexOf("pending") !== -1) return "pending";
    return "success";
  }
  if (rc !== "") return "failed";
  return "pending";
}

app.get("/", (req, res) => {
  res.json({ ok: true, name: "Hearth Chat M-Pesa (PayHero)", configured: configured(), email: emailConfigured(), ai: aiWorker.configured() });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, configured: configured(), email: emailConfigured(), ai: aiWorker.configured() });
});

// The default (and saved) email templates, so the admin panel can pre-fill the
// editors and offer "Reset to default". Nothing sensitive here.
app.get("/api/email/templates", (req, res) => {
  res.json({ ok: true, defaults: emails.templateDefaults() });
});

// Initiate an STK push.
// Body: { phone, amount, plan, userId, email }
app.post("/api/mpesa/stkpush", async (req, res) => {
  const { phone, amount, plan, userId, email } = req.body || {};
  if (!configured()) {
    return res.status(500).json({ message: "M-Pesa backend is not configured. Add PAYHERO_AUTH_TOKEN and PAYHERO_CHANNEL_ID as environment variables on Render." });
  }
  const msisdn = normalizePhone(phone);
  if (!/^254\d{9}$/.test(msisdn)) {
    return res.status(400).json({ message: "Enter a valid M-Pesa phone number." });
  }
  const amt = Math.round(Number(amount));
  if (!amt || amt <= 0) {
    return res.status(400).json({ message: "Invalid amount." });
  }
  const external_reference = genReference();
  const callback_url = CALLBACK_OVERRIDE || (req.protocol + "://" + req.get("host") + "/api/mpesa/callback");

  const payload = {
    amount: amt,
    phone_number: msisdn,
    channel_id: CHANNEL_ID,
    provider: PROVIDER,
    external_reference: external_reference,
    callback_url: callback_url
  };

  try {
    const res_ = await fetch(BASE + "/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader() },
      body: JSON.stringify(payload)
    });
    const data = await res_.json().catch(() => ({}));

    if (!res_.ok || data.success === false || (data.error && !data.success)) {
      const msg = (data.message || data.error || (data.detail && data.detail.message) || "STK push was rejected by PayHero.");
      return res.status(400).json({ message: msg });
    }

    // PayHero's transaction reference is what the status endpoint needs.
    const ref = data.reference || data.CheckoutRequestID || external_reference;
    res.json({
      success: true,
      CheckoutRequestID: ref,
      ref: ref,
      ExternalReference: external_reference,
      message: data.message || "STK push sent"
    });
  } catch (err) {
    res.status(500).json({ message: "Could not reach the PayHero API." });
  }
});

// Check the status of a previously sent STK push.
// GET /api/mpesa/status/:checkoutRequestId
app.get("/api/mpesa/status/:checkoutRequestId", async (req, res) => {
  const id = String(req.params.checkoutRequestId || "").trim();
  if (!id) return res.status(400).json({ message: "Missing transaction reference." });

  const cb = callbacks[id];
  if (cb && cb.status) {
    return res.json({ status: cb.status, resultCode: cb.resultCode || "", resultDesc: cb.resultDesc || "" });
  }

  if (!configured()) {
    return res.status(500).json({ message: "M-Pesa backend is not configured." });
  }

  try {
    const res_ = await fetch(BASE + "/transaction-status?reference=" + encodeURIComponent(id), {
      headers: { "Content-Type": "application/json", Authorization: authHeader() }
    });
    const data = await res_.json().catch(() => ({}));
    if (!res_.ok) {
      return res.status(502).json({ message: data.message || data.error || "Status query failed.", status: "pending" });
    }
    const status = parseStatus(data);
    const body = data.data && typeof data.data === "object" ? data.data : data;
    const resp = body.response && typeof body.response === "object" ? body.response : body;
    const rc = resp.ResultCode !== undefined && resp.ResultCode !== null ? String(resp.ResultCode) : "";
    res.json({ status, resultCode: rc, resultDesc: resp.ResultDesc || "" });
  } catch (err) {
    res.status(500).json({ message: "Could not query PayHero status.", status: "pending" });
  }
});

// PayHero posts the final result here when the user completes (or cancels) the STK push.
app.post("/api/mpesa/callback", (req, res) => {
  try {
    const body = req.body || {};
    const resp = (body.response && typeof body.response === "object") ? body.response : body;
    const ref = resp.ExternalReference || resp.CheckoutRequestID || resp.reference || "";
    const status = parseStatus(body);
    if (ref) {
      callbacks[ref] = {
        status,
        resultCode: resp.ResultCode !== undefined && resp.ResultCode !== null ? String(resp.ResultCode) : "",
        resultDesc: resp.ResultDesc || ""
      };
      // Also index by any alternate identifier so either key can be queried.
      if (resp.CheckoutRequestID && resp.CheckoutRequestID !== ref) {
        callbacks[resp.CheckoutRequestID] = callbacks[ref];
      }
    }
    res.json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (e) {
    res.json({ ResultCode: 0, ResultDesc: "Success" });
  }
});

/* ---------------- Email (Resend) ---------------- */

// Send a password reset email via Resend. The recovery link is minted by
// Supabase but emailed by us, so it comes from your domain — not Supabase.
// Body: { email }
app.post("/api/email/reset-password", async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ message: "Enter a valid email address." });
  }
  if (!emailConfigured()) {
    return res.status(500).json({ message: "Email service is not configured. Set RESEND_API_KEY and FROM_EMAIL on Render." });
  }
  if (!supabaseConfigured()) {
    return res.status(500).json({ message: "Supabase is not configured on the Render app." });
  }
  const origin = appOrigin(req);
  if (!origin) {
    return res.status(500).json({ message: "Could not determine the app URL. Set APP_URL on Render." });
  }
  try {
    const existing = await supabaseFindUser(email);
    if (!existing) return res.json({ ok: true });
    const link = await supabaseGenerateLink("recovery", email, origin + "/reset.html");
    await emails.sendEmail({
      to: email,
      subject: "Reset your password",
      html: await emails.resetPasswordTemplate({ link: link, email: email })
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[email] reset-password", err && err.message);
    return res.status(502).json({ message: "Could not send the reset email. Please try again later." });
  }
});

// Create the account (unconfirmed) and email the confirmation link via Resend.
// Body: { email, password, username, fullName, age, gender }
app.post("/api/email/send-confirmation", async (req, res) => {
  const { email, password, username, fullName, age, gender } = req.body || {};
  const em = String(email || "").trim().toLowerCase();
  const pw = String(password || "");
  if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ message: "Enter a valid email address." });
  if (pw.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters." });
  if (!supabaseConfigured()) return res.status(500).json({ message: "Supabase is not configured on the Render app." });
  if (!emailConfigured()) return res.status(500).json({ message: "Email service is not configured. Set RESEND_API_KEY and FROM_EMAIL on Render." });
  const origin = appOrigin(req);
  if (!origin) return res.status(500).json({ message: "Could not determine the app URL. Set APP_URL on Render." });

  let createdUser = null;
  try {
    const existing = await supabaseFindUser(em);
    if (existing) return res.status(400).json({ message: "That email is already registered." });
    createdUser = await supabaseCreateUser({ email: em, password: pw, data: { username: username, fullName: fullName, age: age, gender: gender } });
    const link = await supabaseGenerateLink("signup", em, origin + "/confirm.html");
    await emails.sendEmail({
      to: em,
      subject: "Confirm your email",
      html: await emails.confirmationTemplate({ link: link, email: em })
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[email] send-confirmation", err && err.message);
    if (createdUser && createdUser.id) {
      try {
        await supabaseDeleteUser(createdUser.id);
      } catch (rollbackErr) {
        console.error("[email] send-confirmation rollback", rollbackErr && rollbackErr.message);
      }
    }
    const m = err && err.message ? err.message : "Could not create your account.";
    if (/already registered/i.test(m)) return res.status(400).json({ message: "That email is already registered." });
    if (err && (err.code === "RESEND_NOT_CONFIGURED" || err.code === "FROM_EMAIL_NOT_CONFIGURED")) {
      return res.status(500).json({ message: "Email service is not configured. Set RESEND_API_KEY and FROM_EMAIL on Render." });
    }
    res.status(500).json({ message: m });
  }
});

/* ---------------- Unread-message reminders + unsubscribe ---------------- */

function pageHtml(title, inner) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title></head>' +
    '<body style="margin:0;background:#f4f5fb;font-family:Inter,\'Segoe UI\',Arial,sans-serif;color:#1e2537;">' +
    '<div style="max-width:440px;margin:60px auto;padding:0 16px;"><div style="background:#fff;border-radius:18px;box-shadow:0 10px 30px rgba(40,48,84,.08);padding:32px 28px;text-align:center;">' +
    '<div style="width:44px;height:44px;margin:0 auto 10px;border-radius:12px;background:linear-gradient(135deg,#6c5ce7,#2fa58f);color:#fff;font-size:20px;line-height:44px;font-weight:800;">&#9829;</div>' +
    inner + '</div></div></body></html>';
}

const BTN = 'border:0;border-radius:10px;background:#6c5ce7;color:#fff;padding:12px 22px;font-size:14px;font-weight:700;cursor:pointer;';

// Landing page from the email link. Shows a confirm button (a plain GET never
// unsubscribes, so mail scanners that pre-open links can't do it by accident).
app.get("/unsubscribe", (req, res) => {
  const u = String(req.query.u || ""), t = String(req.query.t || "");
  if (!u || !digest.tokenValid(u, t)) {
    return res.status(400).send(pageHtml("Invalid link", '<h1 style="font-size:20px;">This link isn\'t valid</h1><p style="color:#8b92a9;font-size:14px;">Please use the link from your most recent email.</p>'));
  }
  const action = "/unsubscribe?u=" + encodeURIComponent(u) + "&t=" + encodeURIComponent(t);
  res.send(pageHtml("Unsubscribe", '<h1 style="font-size:20px;margin:6px 0;">Unsubscribe from reminders?</h1>' +
    '<p style="color:#8b92a9;font-size:14px;line-height:1.55;">You will stop getting emails about messages you haven\'t opened. You can still read everything in the app.</p>' +
    '<form method="POST" action="' + action + '"><button style="' + BTN + '" type="submit">Yes, unsubscribe me</button></form>'));
});

// Handles both the button above and the mail client's one-click unsubscribe.
// A form field action=resubscribe turns reminders back on.
app.post("/unsubscribe", async (req, res) => {
  const u = String(req.query.u || ""), t = String(req.query.t || "");
  if (!u || !digest.tokenValid(u, t)) return res.status(400).send(pageHtml("Invalid link", "<p>This link isn't valid.</p>"));
  const resub = (req.body || {}).action === "resubscribe";
  try {
    await digest.setUnsubscribed(u, !resub);
  } catch (err) {
    console.error("[email] unsubscribe", err && err.message);
    return res.status(500).send(pageHtml("Error", '<p style="color:#8b92a9;">Something went wrong. Please try again in a moment.</p>'));
  }
  const action = "/unsubscribe?u=" + encodeURIComponent(u) + "&t=" + encodeURIComponent(t);
  if (resub) {
    return res.send(pageHtml("Subscribed", '<h1 style="font-size:20px;margin:6px 0;">Reminders are back on</h1><p style="color:#8b92a9;font-size:14px;">We\'ll let you know when messages are waiting for you.</p>'));
  }
  res.send(pageHtml("Unsubscribed", '<h1 style="font-size:20px;margin:6px 0;">You\'re unsubscribed</h1>' +
    '<p style="color:#8b92a9;font-size:14px;line-height:1.55;">You won\'t receive unread-message reminders anymore.</p>' +
    '<form method="POST" action="' + action + '"><input type="hidden" name="action" value="resubscribe"><button style="background:none;border:0;color:#6c5ce7;font-size:13px;text-decoration:underline;cursor:pointer;" type="submit">Changed your mind? Turn reminders back on</button></form>'));
});

// Trigger the reminder run from an external cron (Render sleeps on free plans).
// Auth: header "x-cron-secret: <CRON_SECRET>" or ?key=<CRON_SECRET>.
app.all("/api/email/run-digest", async (req, res) => {
  const secret = process.env.CRON_SECRET || "";
  const given = String(req.get("x-cron-secret") || req.query.key || "");
  if (!secret || given !== secret) return res.status(401).json({ message: "Unauthorized." });
  res.json(await digest.runDigest());
});

app.listen(PORT, () => {
  console.log("Hearth Chat M-Pesa (PayHero) listening on port " + PORT + (configured() ? "" : " — set PAYHERO_AUTH_TOKEN and PAYHERO_CHANNEL_ID"));
  aiWorker.start();
  digest.start();
});
