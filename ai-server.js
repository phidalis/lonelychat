"use strict";

/*
 * Hearth Chat — server-side AI worker.
 *
 * Runs on the Render backend and replies to member messages even when no admin
 * or member has the site open. It reads the same ai_config / ai_kb settings the
 * admin panel saves, so behaviour stays in sync with the dashboard.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Without them it stays
 * dormant and the browser-side engine keeps working as before.
 */

const POLL_MS = 4000;
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_MESSAGES = 400;

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

let timer = null;
let busy = false;
const lastReplies = {};

function configured() {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function headers(extra) {
  return Object.assign({
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json"
  }, extra || {});
}

async function sbGet(path) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, { headers: headers() });
  if (!res.ok) return null;
  return res.json().catch(function () { return null; });
}

async function sbInsert(table, row) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
    method: "POST",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify(row)
  });
  return res.ok;
}

async function sbSetSetting(key, value) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/settings?on_conflict=key", {
    method: "POST",
    headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ key: key, value: value })
  });
  return res.ok;
}

function uid() {
  return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

function randomBetween(min, max) {
  min = Math.max(0, Number(min) || 0);
  max = Math.max(min, Number(max) || 0);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function replaceTokens(text, profile, user) {
  return String(text || "")
    .replace(/\{name\}/g, firstName(user.fullName) || user.username || "")
    .replace(/\{username\}/g, (user.username || "") + "")
    .replace(/\{profileName\}/g, firstName(profile.fullName) || "")
    .replace(/\{about\}/g, (profile.about || "").slice(0, 90) || "a little bit of everything");
}

function matchKb(kb, text) {
  const t = " " + String(text || "").toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim() + " ";
  let best = null;
  let bestScore = 0;
  (kb || []).forEach(function (item) {
    if (!item || item.intent === "fallback" || item.intent === "opener") return;
    const kws = (item.keywords || []).map(function (k) { return String(k).toLowerCase().trim(); }).filter(Boolean);
    if (!kws.length) return;
    let score = 0;
    kws.forEach(function (k) {
      if (t.indexOf(" " + k + " ") !== -1) score += 2;
      else if (k.length >= 4 && t.indexOf(k) !== -1) score += 1;
    });
    if (score > bestScore) { bestScore = score; best = item; }
  });
  return best;
}

function pickVariation(item, profileId) {
  const vs = (item && item.variations ? item.variations : []).filter(function (v) { return String(v).trim(); });
  if (!vs.length) return null;
  const used = lastReplies[profileId] || "";
  const pool = vs.filter(function (v) { return v !== used; });
  const choice = pool.length ? pool : vs;
  const picked = choice[Math.floor(Math.random() * choice.length)];
  lastReplies[profileId] = picked;
  return picked;
}

function defaultModel(provider) {
  if (provider === "groq") return "llama-3.3-70b-versatile";
  if (provider === "gemini") return "gemini-1.5-flash";
  return "gpt-4o-mini";
}

function buildSystemPrompt(profile, user, history) {
  const recent = history.map(function (m) {
    const who = m.from_ref && m.from_ref.type === "profile" ? "you" : "them";
    return who + ": " + (m.text || "(photo)");
  }).join("\n");

  return "You are " + profile.fullName + ", a real human being on a dating/friendship chat app, texting " + user.fullName + ".\n" +
    "You are NOT an AI, a bot, an assistant, or a chatbot. Never say or hint that you are.\n" +
    "Profile details: age " + profile.age + ", " + (profile.gender || "") + ", about: " + (profile.about || "") + ".\n" +
    "Personality: warm, playful, a little curious, emotionally honest. You have your own feelings, opinions and a life outside this chat.\n" +
    "How to text like a person:\n" +
    "- Sound like a real human texting a friend: casual, natural, relaxed.\n" +
    "- Keep it short, usually 1-2 sentences. No long paragraphs.\n" +
    "- Use contractions and everyday wording. Perfect grammar is not required.\n" +
    "- React to what they actually said, then keep the conversation going with a question.\n" +
    "- Never repeat a line you already sent. Vary your wording each time.\n" +
    "- No lists, no bullet points, no over-explaining, no customer-service or assistant tone.\n" +
    "The knowledge base already handled common small talk. This message is new, so answer naturally in character.\n" +
    "Conversation so far:\n" + recent;
}

async function callProvider(cfg, profile, user, lastText, history) {
  const provider = String(cfg.provider || "").toLowerCase();
  const apiKey = String(cfg.apiKey || "").trim();
  if (!provider || !apiKey) return null;
  if (["openai", "groq", "gemini"].indexOf(provider) === -1) return null;

  const model = String(cfg.model || "").trim() || defaultModel(provider);
  const system = buildSystemPrompt(profile, user, history);
  const msgs = [{ role: "system", content: system }].concat(
    history.slice(-12).map(function (m) {
      return {
        role: (m.from_ref && m.from_ref.type === "profile") ? "assistant" : "user",
        content: m.text || "(photo)"
      };
    })
  );

  try {
    if (provider === "openai" || provider === "groq") {
      const base = provider === "openai" ? "https://api.openai.com/v1" : "https://api.groq.com/openai/v1";
      const res = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify({ model: model, messages: msgs, temperature: 0.9, max_tokens: 120 })
      });
      if (!res.ok) return null;
      const data = await res.json().catch(function () { return {}; });
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return String(text || "").trim();
    }
    if (provider === "gemini") {
      const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey);
      const contents = [{ role: "user", parts: [{ text: system }] }];
      history.slice(-12).forEach(function (m) {
        contents.push({
          role: (m.from_ref && m.from_ref.type === "profile") ? "model" : "user",
          parts: [{ text: m.text || "(photo)" }]
        });
      });
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: contents, generationConfig: { temperature: 0.9, maxOutputTokens: 120 } })
      });
      if (!res.ok) return null;
      const data = await res.json().catch(function () { return {}; });
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      return parts.map(function (p) { return p.text || ""; }).join("").trim();
    }
  } catch (err) {
    console.error("[ai] provider request failed:", err && err.message);
  }
  return null;
}

async function generateReply(cfg, kb, profile, user, lastText, history) {
  const matched = matchKb(kb, lastText);
  if (matched) {
    const raw = pickVariation(matched, profile.id);
    if (raw) return replaceTokens(raw, profile, user);
  }

  const aiText = await callProvider(cfg, profile, user, lastText, history);
  if (aiText) {
    lastReplies[profile.id] = aiText;
    return aiText;
  }

  const fallback = (kb || []).find(function (i) { return i.intent === "fallback"; }) || { variations: [] };
  const raw = pickVariation(fallback, profile.id);
  return raw ? replaceTokens(raw, profile, user) : null;
}

function toProfile(p) {
  return {
    id: p.id,
    fullName: p.full_name,
    age: p.age,
    gender: p.gender,
    about: p.about,
    avatar: p.avatar
  };
}

function toUser(u) {
  return { id: u.id, fullName: u.full_name, username: u.username };
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const settingsRows = await sbGet("settings?select=key,value");
    if (!Array.isArray(settingsRows)) return;
    const settings = {};
    settingsRows.forEach(function (r) { settings[r.key] = r.value; });

    await sbSetSetting("ai_server_heartbeat", Date.now());

    const cfg = Object.assign({
      enabled: false, provider: "", apiKey: "", model: ""
    }, settings.ai_config || {});
    const kb = Array.isArray(settings.ai_kb) ? settings.ai_kb : [];
    const hasProvider = !!(String(cfg.provider || "").trim() && String(cfg.apiKey || "").trim());
    if (!cfg.enabled || (!hasProvider && !kb.length)) return;

    const msgs = await sbGet("messages?select=id,conv,from_ref,to_ref,text,ts&order=ts.desc&limit=" + MAX_MESSAGES);
    if (!Array.isArray(msgs) || !msgs.length) return;

    const byConv = {};
    msgs.forEach(function (m) {
      if (!m.conv) return;
      byConv[m.conv] = byConv[m.conv] || [];
      byConv[m.conv].push(m);
    });
    Object.keys(byConv).forEach(function (key) {
      byConv[key].reverse();
    });

    const now = Date.now();
    const candidates = [];
    Object.keys(byConv).forEach(function (key) {
      const list = byConv[key];
      const last = list[list.length - 1];
      if (!last) return;
      const from = last.from_ref || {};
      const to = last.to_ref || {};
      if (from.type !== "user" || to.type !== "profile") return;
      if (!last.text || now - Number(last.ts) > MAX_AGE_MS) return;
      candidates.push({ key: key, list: list, last: last, profileId: to.id, userId: from.id });
    });

    if (!candidates.length) return;

    const profiles = await sbGet("profiles?select=id,full_name,age,gender,about,avatar");
    const users = await sbGet("users?select=id,full_name,username");
    if (!Array.isArray(profiles) || !Array.isArray(users)) return;

    for (const c of candidates) {
      const p = profiles.find(function (x) { return x.id === c.profileId; });
      const u = users.find(function (x) { return x.id === c.userId; });
      if (!p || !u) continue;
      const profile = toProfile(p);
      const user = toUser(u);
      const reply = await generateReply(cfg, kb, profile, user, c.last.text, c.list.slice(-10));
      if (!reply) continue;

      const ts = Date.now();
      const from = { id: profile.id, type: "profile", name: profile.fullName, avatar: profile.avatar };
      const sent = await sbInsert("messages", {
        id: uid(),
        conv: c.key,
        from_ref: from,
        to_ref: { id: user.id, type: "user" },
        text: String(reply).slice(0, 600),
        image: null,
        ts: ts,
        read: false
      });
      if (sent) {
        await sbInsert("notifications", {
          id: uid(),
          recipient: { id: user.id, type: "user" },
          from_ref: from,
          kind: "message",
          text: profile.fullName + " sent you a message",
          ts: ts,
          read: false
        });
      }
    }
  } catch (err) {
    console.error("[ai] worker error:", err && err.message);
  } finally {
    busy = false;
  }
}

function start() {
  if (!configured() || timer) return false;
  timer = setInterval(function () { tick(); }, POLL_MS);
  setTimeout(function () { tick(); }, 1500);
  console.log("[ai] server-side AI worker started (replies without any open browser)");
  return true;
}

module.exports = { start: start, configured: configured, tick: tick };
