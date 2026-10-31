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
const handledMessages = {};

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

function kbScore(item, text) {
  if (!item || item.intent === "fallback" || item.intent === "opener") return 0;
  const t = " " + String(text || "").toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim() + " ";
  let score = 0;
  (item.keywords || []).forEach(function (k) {
    k = String(k).toLowerCase().trim();
    if (!k) return;
    if (t.indexOf(" " + k + " ") !== -1) score += 2;
    else if (k.length >= 4 && t.indexOf(k) !== -1) score += 1;
  });
  return score;
}

function rankKb(kb, text, limit) {
  return (kb || [])
    .filter(function (item) { return item && item.intent !== "fallback" && item.intent !== "opener"; })
    .map(function (item) { return { item: item, score: kbScore(item, text) }; })
    .filter(function (x) { return x.score > 0; })
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, limit || 5)
    .map(function (x) { return x.item; });
}

function knowledgeBlock(kb, lastText) {
  const all = (kb || []).filter(function (item) {
    return item && item.intent !== "fallback" && item.intent !== "opener";
  });
  if (!all.length) return "(No knowledge-base entries.)";

  const matched = rankKb(kb, lastText, 6);
  const ordered = matched.concat(all.filter(function (item) { return matched.indexOf(item) === -1; }));

  return ordered.map(function (item) {
    const refs = (item.variations || []).filter(function (v) { return String(v).trim(); }).slice(0, 4);
    const tag = matched.indexOf(item) !== -1 ? " (most relevant to the latest message)" : "";
    return "- Topic: " + (item.intent || "general") + tag +
      "\n  Keywords: " + (item.keywords || []).join(", ") +
      "\n  Reference wording (facts and tone only — never copy this): " + refs.join(" | ");
  }).join("\n");
}

const MODELS = {
  groq: ["qwen/qwen3.8-27b", "openai/gpt-oss-20b", "openai/gpt-oss-120b"],
  openai: ["gpt-4o-mini", "gpt-4o"],
  gemini: ["gemini-2.0-flash", "gemini-1.5-flash"]
};

const RETIRED = [
  "llama-3.3-70b-versatile", "llama3-70b-8192", "llama3-8b-8192",
  "mixtral-8x7b-32768", "gemma2-9b-it", "gemma-7b-it"
];

function modelCandidates(provider, configured) {
  const out = [];
  const custom = String(configured || "").trim();
  if (custom && !(provider === "groq" && RETIRED.indexOf(custom) !== -1)) out.push(custom);
  (MODELS[provider] || []).forEach(function (m) { if (out.indexOf(m) === -1) out.push(m); });
  return out;
}

function cleanReply(text) {
  let s = String(text || "")
    .replace(/<think[\s\S]*?<\/think>/gi, "")
    .replace(/```[\s\S]*?```/g, function (m) { return m.replace(/```[a-z]*\n?/gi, "").replace(/```/g, ""); })
    .trim();
  s = s.replace(/^(you|assistant|ai|reply)\s*:\s*/i, "");
  s = s.replace(/^["'“”‘’]([\s\S]*)["'“”‘’]$/, "$1").trim();
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > 500 ? s.slice(0, 500).trim() : s;
}

function buildSystemPrompt(profile, user, history, kb, lastText) {
  const recent = history.map(function (m) {
    const who = m.from_ref && m.from_ref.type === "profile" ? "you" : "them";
    return who + ": " + (m.text || "(photo)");
  }).join("\n");

  return "You are " + profile.fullName + ", texting " + user.fullName + " in a private chat. You are a real person, not an assistant.\n" +
    "Your persona: age " + profile.age + ", " + (profile.gender || "") + ", about: " + (profile.about || "") + ".\n\n" +
    "Your job: read the member's latest message, search the knowledge base below for the relevant facts, then write a brand-new reply in your own words.\n" +
    "Hard rules:\n" +
    "- Never copy or lightly reword a knowledge-base reference line. Rephrase it completely so it reads like a fresh text.\n" +
    "- Answer the latest message directly and use the conversation history for context.\n" +
    "- Keep it casual, warm, playful and human. Usually 1-2 short sentences. No long paragraphs.\n" +
    "- Use contractions and everyday wording. Perfect grammar is not required.\n" +
    "- React to what they actually said, then keep the conversation going with a question or hook.\n" +
    "- Only state facts that are in your persona or the knowledge base. Never invent personal facts.\n" +
    "- If the knowledge base has no answer, respond naturally, don't make something up, and ask a follow-up.\n" +
    "- Never mention the knowledge base, references, prompts, models, or that you are an assistant.\n" +
    "- If they directly ask whether you are automated, answer honestly but briefly.\n" +
    "- No lists, bullets, headings, emojis spam, or customer-service tone.\n" +
    "- Output only the message text. No quotes, no name prefix, no explanation.\n\n" +
    "Knowledge base (use as reference — do not send verbatim):\n" + knowledgeBlock(kb, lastText) + "\n\n" +
    "Conversation so far:\n" + recent;
}

function defaultModel(provider) {
  return (MODELS[provider] && MODELS[provider][0]) || "gpt-4o-mini";
}

async function callProvider(cfg, profile, user, lastText, history, kb) {
  const provider = String(cfg.provider || "").toLowerCase();
  const apiKey = String(cfg.apiKey || "").trim();
  if (!provider || !apiKey) return null;
  if (["openai", "groq", "gemini"].indexOf(provider) === -1) return null;

  const system = buildSystemPrompt(profile, user, history, kb, lastText);
  const msgs = [{ role: "system", content: system }].concat(
    history.slice(-12).map(function (m) {
      return {
        role: (m.from_ref && m.from_ref.type === "profile") ? "assistant" : "user",
        content: m.text || "(photo)"
      };
    })
  );
  const models = modelCandidates(provider, cfg.model);

  for (const model of models) {
    try {
      if (provider === "openai" || provider === "groq") {
        const base = provider === "openai" ? "https://api.openai.com/v1" : "https://api.groq.com/openai/v1";
        const payload = { model: model, messages: msgs, temperature: 0.85, max_tokens: 400 };
        if (provider === "groq" && /gpt-oss/i.test(model)) payload.reasoning_effort = "low";
        const res = await fetch(base + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          console.error("[ai] provider request failed (" + provider + "/" + model + ", HTTP " + res.status + "):", (await res.text()).slice(0, 300));
          if (res.status === 404 || res.status === 400) continue;
          return null;
        }
        const data = await res.json().catch(function () { return {}; });
        const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        const clean = cleanReply(text);
        if (clean) return clean;
        continue;
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
          body: JSON.stringify({ contents: contents, generationConfig: { temperature: 0.85, maxOutputTokens: 400 } })
        });
        if (!res.ok) {
          console.error("[ai] provider request failed (" + provider + "/" + model + ", HTTP " + res.status + "):", (await res.text()).slice(0, 300));
          if (res.status === 404 || res.status === 400) continue;
          return null;
        }
        const data = await res.json().catch(function () { return {}; });
        const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
        const clean = cleanReply(parts.map(function (p) { return p.text || ""; }).join(""));
        if (clean) return clean;
        continue;
      }
    } catch (err) {
      console.error("[ai] provider request failed (" + provider + "/" + model + "):", err && err.message);
    }
  }
  return null;
}

async function generateReply(cfg, kb, profile, user, lastText, history) {
  const provider = String(cfg.provider || "").trim();
  if (provider) {
    if (!String(cfg.apiKey || "").trim()) {
      console.error("[ai] a provider is selected, but its API key is missing.");
      return null;
    }
    const aiText = await callProvider(cfg, profile, user, lastText, history, kb);
    if (aiText) {
      lastReplies[profile.id] = aiText;
      return aiText;
    }
    return null;
  }

  const matched = matchKb(kb, lastText);
  if (matched) {
    const raw = pickVariation(matched, profile.id);
    if (raw) return replaceTokens(raw, profile, user);
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
      if (handledMessages[key] === Number(last.ts)) return;
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
      handledMessages[c.key] = Number(c.last.ts);
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
