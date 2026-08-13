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

const app = express();
app.use(cors());
app.use(express.json());

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
  return !!(process.env.RESEND_API_KEY && process.env.FROM_EMAIL);
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
  res.json({ ok: true, name: "Hearth Chat M-Pesa (PayHero)", configured: configured(), email: emailConfigured() });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, configured: configured(), email: emailConfigured() });
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
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ message: "Email service is not configured yet. Add RESEND_API_KEY to the Render app." });
  }
  const origin = appOrigin(req);
  if (!origin) {
    return res.status(500).json({ message: "Could not determine the app URL. Set APP_URL on Render." });
  }
  try {
    if (!supabaseConfigured()) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing on Render.");
    const link = await supabaseGenerateLink("recovery", email, origin + "/reset.html");
    await emails.sendEmail({
      to: email,
      subject: "Reset your password",
      html: await emails.resetPasswordTemplate({ link: link, email: email })
    });
  } catch (err) {
    // Never reveal whether the address has an account (prevents enumeration).
    console.error("[email] reset-password", err && err.message);
  }
  res.json({ ok: true });
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
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ message: "Email service is not configured yet. Add RESEND_API_KEY to the Render app." });
  const origin = appOrigin(req);
  if (!origin) return res.status(500).json({ message: "Could not determine the app URL. Set APP_URL on Render." });

  try {
    const existing = await supabaseFindUser(em);
    if (existing) return res.status(400).json({ message: "That email is already registered." });
    await supabaseCreateUser({ email: em, password: pw, data: { username: username, fullName: fullName, age: age, gender: gender } });
    const link = await supabaseGenerateLink("signup", em, origin + "/confirm.html");
    await emails.sendEmail({
      to: em,
      subject: "Confirm your email",
      html: await emails.confirmationTemplate({ link: link, email: em })
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[email] send-confirmation", err && err.message);
    const m = err && err.message ? err.message : "Could not create your account.";
    if (/already registered/i.test(m)) return res.status(400).json({ message: "That email is already registered." });
    if (err && err.code === "RESEND_NOT_CONFIGURED") {
      return res.status(500).json({ message: "Email service is not configured yet. Add RESEND_API_KEY to the Render app." });
    }
    res.status(500).json({ message: m });
  }
});

// Send a notification email to a user's inbox.
// Body: { to, recipientName, senderName, kind, text, actionLabel, actionUrl }
app.post("/api/email/notification", async (req, res) => {
  const { to, recipientName, senderName, kind, text, actionLabel, actionUrl } = req.body || {};
  const em = String(to || "").trim();
  if (!em) return res.status(400).json({ message: "Recipient email is required." });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ message: "Email service is not configured yet. Add RESEND_API_KEY to the Render app." });
  try {
    await emails.sendEmail({
      to: em,
      subject: await emails.notificationSubject({ senderName: senderName, kind: kind }),
      html: await emails.notificationTemplate({
        recipientName: recipientName,
        senderName: senderName,
        kind: kind,
        text: text,
        actionLabel: actionLabel,
        actionUrl: actionUrl
      })
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[email] notification", err && err.message);
    res.status(500).json({ message: err && err.message ? err.message : "Could not send the email." });
  }
});

app.listen(PORT, () => {
  console.log("Hearth Chat M-Pesa (PayHero) listening on port " + PORT + (configured() ? "" : " — set PAYHERO_AUTH_TOKEN and PAYHERO_CHANNEL_ID"));
});
