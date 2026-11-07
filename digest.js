"use strict";

/*
 * Hearth Chat — "unread for 24 hours" email reminders + unsubscribe
 * ------------------------------------------------------------------
 * A member gets ONE email when they have messages that have sat unread for
 * 24+ hours. Nothing is sent for newer messages, and never for messages older
 * than 72 hours (so the first run can't blast people about ancient chats).
 *
 * Environment variables (Render):
 *   RESEND_API_KEY, FROM_EMAIL, FROM_NAME      — see emails.js
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY    — to read messages/users and store opt-outs
 *   APP_URL            — your site, e.g. https://yourdomain.com (button target)
 *   CRON_SECRET        — secret for the /api/email/run-digest trigger endpoint
 *   UNSUBSCRIBE_SECRET — optional; signs unsubscribe links (defaults to the service key)
 *   DIGEST_ENABLED     — set to "false" to switch the reminders off
 *
 * Supabase table (run schema.sql once):  email_prefs
 */

const crypto = require("crypto");
const emails = require("./emails");

const HOUR = 60 * 60 * 1000;
const UNREAD_AFTER_MS = 24 * HOUR;   // a message must be unread this long...
const MAX_AGE_MS = 72 * HOUR;        // ...but not older than this
const MAX_EMAILS_PER_RUN = 200;
const SEND_GAP_MS = 600;             // stay under Resend's rate limit (2 req/s on the free plan)

let running = false;

function sbUrl() { return String(process.env.SUPABASE_URL || "").replace(/\/+$/, ""); }
function sbKey() { return process.env.SUPABASE_SERVICE_ROLE_KEY || ""; }
function configured() {
  return !!(sbUrl() && sbKey() && process.env.RESEND_API_KEY && String(process.env.FROM_EMAIL || "").trim());
}

async function sb(path, opts) {
  const res = await fetch(sbUrl() + "/rest/v1/" + path, Object.assign({}, opts, {
    headers: Object.assign({
      apikey: sbKey(),
      Authorization: "Bearer " + sbKey(),
      "Content-Type": "application/json"
    }, (opts && opts.headers) || {})
  }));
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) {
    const e = new Error((data && (data.message || data.hint)) || ("Supabase " + res.status));
    e.status = res.status;
    throw e;
  }
  return data;
}

function inList(ids) {
  return "in.(" + ids.map(function (id) { return '"' + String(id).replace(/"/g, "") + '"'; }).join(",") + ")";
}

/* ---------------- signed unsubscribe links ---------------- */

function secret() { return process.env.UNSUBSCRIBE_SECRET || sbKey(); }

function tokenFor(userId) {
  return crypto.createHmac("sha256", secret()).update("unsub:" + String(userId)).digest("hex").slice(0, 32);
}

function tokenValid(userId, token) {
  const a = Buffer.from(tokenFor(userId));
  const b = Buffer.from(String(token || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function backendUrl() {
  return String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
}

function unsubscribeUrl(userId) {
  return backendUrl() + "/unsubscribe?u=" + encodeURIComponent(userId) + "&t=" + tokenFor(userId);
}

async function setUnsubscribed(userId, value) {
  await sb("email_prefs?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: String(userId), unsubscribed: !!value, updated_at: Date.now() })
  });
}

async function isUnsubscribed(userId) {
  const rows = await sb("email_prefs?user_id=eq." + encodeURIComponent(userId) + "&select=unsubscribed");
  return !!(rows && rows[0] && rows[0].unsubscribed);
}

/* ---------------- the job ---------------- */

function firstName(u) {
  const n = String(u.full_name || u.username || "").trim();
  return n ? n.split(/\s+/)[0] : "there";
}

function sendersText(senders) {
  const names = senders.map(function (s) { return s.name; });
  if (names.length === 1) return names[0] + " is waiting to hear from you.";
  if (names.length === 2) return names[0] + " and " + names[1] + " are waiting to hear from you.";
  const rest = names.length - 2;
  return names[0] + ", " + names[1] + " and " + rest + " other" + (rest === 1 ? "" : "s") + " are waiting to hear from you.";
}

async function runDigest() {
  if (process.env.DIGEST_ENABLED === "false") return { skipped: "disabled" };
  if (!configured()) return { skipped: "not configured" };
  const appUrl = String(process.env.APP_URL || "").replace(/\/+$/, "");
  if (!appUrl || !backendUrl()) {
    console.error("[digest] APP_URL (and the Render URL) must be set; skipping.");
    return { skipped: "missing APP_URL" };
  }
  if (running) return { skipped: "already running" };
  running = true;

  const stats = { checked: 0, sent: 0, failed: 0 };
  try {
    const now = Date.now();
    const to = now - UNREAD_AFTER_MS;     // newest message that counts
    const from = now - MAX_AGE_MS;        // oldest message that counts

    const msgs = await sb("messages?read=eq.false&ts=gt." + from + "&ts=lte." + to +
      "&select=id,from_ref,to_ref,ts&order=ts.asc&limit=5000") || [];

    // Group by recipient (members only — not AI profiles/admin refs).
    const byUser = {};
    msgs.forEach(function (m) {
      const r = m.to_ref;
      if (!r || r.type !== "user" || !r.id) return;
      (byUser[r.id] = byUser[r.id] || []).push(m);
    });
    const ids = Object.keys(byUser);
    stats.checked = ids.length;
    if (!ids.length) return stats;

    const users = {};
    const prefs = {};
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      (await sb("users?id=" + inList(chunk) + "&select=id,email,full_name,username,role") || [])
        .forEach(function (u) { users[u.id] = u; });
      (await sb("email_prefs?user_id=" + inList(chunk) + "&select=user_id,unsubscribed,notified_through") || [])
        .forEach(function (p) { prefs[p.user_id] = p; });
    }

    let sentThisRun = 0;
    for (const id of ids) {
      if (sentThisRun >= MAX_EMAILS_PER_RUN) break;
      const user = users[id];
      const pref = prefs[id] || {};
      if (!user || !user.email || user.role === "admin" || pref.unsubscribed) continue;

      // Only messages we haven't already emailed about.
      const already = Number(pref.notified_through || 0);
      const fresh = byUser[id].filter(function (m) { return Number(m.ts) > already; });
      if (!fresh.length) continue;

      // Distinct senders, most recent first.
      const seen = {};
      const senders = [];
      fresh.slice().reverse().forEach(function (m) {
        const f = m.from_ref || {};
        const key = f.id || f.name || m.id;
        if (seen[key]) return;
        seen[key] = true;
        senders.push({ name: f.name || "Someone" });
      });

      const count = fresh.length;
      const headline = count === 1
        ? senders[0].name + " sent you a message"
        : "You have " + count + " unread messages";
      const unsubUrl = unsubscribeUrl(id);

      try {
        await emails.sendEmail({
          to: user.email,
          subject: await emails.notificationSubject({ kind: "unread", headline: headline }),
          html: await emails.notificationTemplate({
            kind: "unread",
            headline: headline,
            recipientName: firstName(user),
            text: sendersText(senders) + " A reply from you could make their day.",
            actionLabel: "Open my messages",
            actionUrl: appUrl + "/app.html?view=messages",
            unsubscribeUrl: unsubUrl
          }),
          headers: {
            "List-Unsubscribe": "<" + unsubUrl + ">",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
          }
        });
        // Remember how far we've notified, so these messages are never emailed twice.
        await sb("email_prefs?on_conflict=user_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ user_id: String(id), notified_through: to, updated_at: Date.now() })
        });
        stats.sent++;
        sentThisRun++;
        await new Promise(function (r) { setTimeout(r, SEND_GAP_MS); });
      } catch (err) {
        stats.failed++;
        console.error("[digest] send failed for " + id + ":", err && err.message);
      }
    }
    return stats;
  } catch (err) {
    console.error("[digest] run failed:", err && err.message);
    return Object.assign(stats, { error: err && err.message });
  } finally {
    running = false;
  }
}

// In-process scheduler. On Render's free plan the service sleeps when idle, so
// also point an external cron at /api/email/run-digest (see setup notes).
function start() {
  const EVERY = 30 * 60 * 1000;
  setTimeout(function () { runDigest().then(function (s) { console.log("[digest]", JSON.stringify(s)); }); }, 2 * 60 * 1000);
  setInterval(function () { runDigest().then(function (s) { console.log("[digest]", JSON.stringify(s)); }); }, EVERY);
}

module.exports = {
  configured: configured,
  runDigest: runDigest,
  start: start,
  tokenValid: tokenValid,
  setUnsubscribed: setUnsubscribed,
  isUnsubscribed: isUnsubscribed
};
