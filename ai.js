// Hearth Chat — AI assistant engine.
// Runs inside the admin dashboard. Replies to incoming member messages as the
// matching profile, keeps replies varied (never identical), waits a human-like
// delay, and can proactively start conversations with new members (lead mode).
// Knowledge base first — AI providers are used to vary/personalize when reachable.

window.LC = window.LC || {};

LC.ai = (function () {
  "use strict";

  var TIMER = null;
  var TICK_MS = 2000;
  var handled = {};     // convKey -> ts of last message processed
  var scheduled = {};   // convKey -> true while a reply is pending its delay
  var lastReplies = {}; // profileId -> last reply text sent (variety guard)
  var leadNext = 0;
  var repliedAt = {};   // convKey -> ts of last AI reply (for the admin UI chip)

  function config() {
    return Object.assign({}, LC.db.aiConfig.defaults, LC.db.aiConfig.get());
  }

  function kbItems() {
    return LC.db.aiKb.get() || [];
  }

  function randomBetween(min, max) {
    min = Math.max(0, Number(min) || 0);
    max = Math.max(min, Number(max) || 0);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function delayMs(cfg) {
    return randomBetween(cfg.delayMin, cfg.delayMax) * 1000;
  }

  function firstName(name) {
    return String(name || "").trim().split(/\s+/)[0] || "";
  }

  function replaceTokens(text, profile, user) {
    return String(text || "")
      .replace(/\{name\}/g, firstName(user.fullName) || user.username || "")
      .replace(/\{username\}/g, (user.username || "") + "")
      .replace(/\{profileName\}/g, firstName(profile.fullName) || "")
      .replace(/\{about\}/g, (profile.about || "").slice(0, 90) || "a little bit of everything");
  }

  /* ---------------- sending as a profile ---------------- */

  function sendAsProfile(profile, user, text) {
    const key = LC.convKey({ id: profile.id, type: "profile" }, { id: user.id, type: "user" });
    const msg = {
      id: LC.db.uid(),
      conv: key,
      from: { id: profile.id, type: "profile", name: profile.fullName, avatar: profile.avatar },
      to: { id: user.id, type: "user" },
      text: String(text || "").slice(0, 600),
      image: null,
      ts: Date.now(),
      read: false
    };
    if (!msg.text.trim()) return;
    const msgs = LC.db.messages.get();
    msgs.push(msg);
    msgs.forEach(m => {
      if (m.conv === key && m.to.type === "profile" && m.to.id === profile.id && !m.read) m.read = true;
    });
    LC.db.messages.save(msgs);

    const profiles = LC.db.profiles.get();
    const p = profiles.find(x => x.id === profile.id);
    if (p) { p.online = true; p.lastActive = Date.now(); }
    LC.db.profiles.save(profiles);

    LC.notify({ id: user.id, type: "user" }, { id: profile.id, type: "profile", name: profile.fullName, avatar: profile.avatar }, "message", profile.fullName + " sent you a message");
    LC.rt.emit({ type: "message" });

    repliedAt[key] = msg.ts;
  }

  /* ---------------- knowledge base matching ---------------- */

  function matchKb(kb, text) {
    const t = " " + String(text || "").toLowerCase() + " ";
    let best = null, bestScore = 0;
    (kb || []).forEach(item => {
      const kws = (item.keywords || []).filter(k => String(k).trim());
      if (!kws.length) return;
      let score = 0;
      kws.forEach(k => {
        k = String(k).toLowerCase().trim();
        if (t.indexOf(" " + k + " ") !== -1) score += 2;
        else if (t.indexOf(k) !== -1) score += 1;
      });
      if (score > bestScore) { bestScore = score; best = item; }
    });
    return best;
  }

  function pickVariation(item, profileId) {
    const vs = (item && item.variations ? item.variations : []).filter(v => String(v).trim());
    if (!vs.length) return null;
    const used = lastReplies[profileId] || "";
    const pool = vs.filter(v => v !== used);
    const choice = (pool.length ? pool : vs);
    const picked = choice[Math.floor(Math.random() * choice.length)];
    lastReplies[profileId] = picked;
    return picked;
  }

  /* ---------------- AI provider calls ---------------- */

  function buildSystemPrompt(profile, user, msgs, kb) {
    const recent = msgs.slice(-10).map(m => {
      const who = (m.from.type === "profile" && m.from.id === profile.id) ? "you" : "them";
      return who + ": " + (m.text || "(photo)");
    }).join("\n");

    const topics = (kb || [])
      .filter(i => i.intent && i.intent !== "fallback" && i.intent !== "opener")
      .map(i => "- " + i.intent + (i.variations && i.variations.length ? " (sample tone: \"" + i.variations[0] + "\")" : ""))
      .join("\n");

    return "You are " + profile.fullName + ", a real person on a dating/friendship chat app talking to " + user.fullName + ".\n" +
      "Profile details: age " + profile.age + ", " + (profile.gender || "") + ", about: " + (profile.about || "") + ".\n" +
      "Rules:\n" +
      "- Reply as that person: warm, casual, natural, short (1-2 sentences).\n" +
      "- Never mention you are an AI, a bot, or an assistant.\n" +
      "- Never repeat a reply you already sent in this conversation.\n" +
      "- Stay in character and keep the conversation going by asking the other person a question.\n" +
      "- Use casual lowercase-friendly chat tone, no over-formal language, no long paragraphs.\n" +
      "Knowledge base topics (match their tone):\n" + topics + "\n" +
      "Conversation so far:\n" + recent;
  }

  function buildHistory(profile, msgs) {
    const hist = [];
    msgs.slice(-12).forEach(m => {
      const role = (m.from.type === "profile" && m.from.id === profile.id) ? "assistant" : "user";
      hist.push({ role: role, content: m.text || "(photo)" });
    });
    return hist;
  }

  function defaultModel(provider) {
    if (provider === "groq") return "llama-3.3-70b-versatile";
    if (provider === "gemini") return "gemini-1.5-flash";
    return "gpt-4o-mini";
  }

  async function callProvider(cfg, profile, user, msgs, kb) {
    const provider = String(cfg.provider || "").toLowerCase();
    const apiKey = String(cfg.apiKey || "").trim();
    if (!provider || !apiKey) return null;
    if (["openai", "groq", "gemini"].indexOf(provider) === -1) return null;

    const model = String(cfg.model || "").trim() || defaultModel(provider);
    const system = buildSystemPrompt(profile, user, msgs, kb);
    const history = buildHistory(profile, msgs);

    try {
      if (provider === "openai" || provider === "groq") {
        const base = provider === "openai" ? "https://api.openai.com/v1" : "https://api.groq.com/openai/v1";
        const res = await fetch(base + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: system }].concat(history),
            temperature: 0.9,
            max_tokens: 120
          })
        });
        if (!res.ok) return null;
        const data = await res.json();
        const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
        return String(text).trim();
      }
      if (provider === "gemini") {
        const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey);
        const contents = [{ role: "user", parts: [{ text: system }] }];
        history.forEach(h => contents.push({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.content }] }));
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: contents, generationConfig: { temperature: 0.9, maxOutputTokens: 120 } })
        });
        if (!res.ok) return null;
        const data = await res.json();
        const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts || []).map(p => p.text || "").join("");
        return String(text).trim();
      }
    } catch (e) {
      console.warn("Hearth AI: provider request failed, falling back to knowledge base.", e);
    }
    return null;
  }

  /* ---------------- reply generation ---------------- */

  async function generateReply(cfg, kb, profile, user, msgs) {
    const lastMsg = msgs[msgs.length - 1];
    const lastText = lastMsg && lastMsg.text ? lastMsg.text : "";
    if (!lastText) return null;

    const provider = String(cfg.provider || "").toLowerCase();
    const hasProvider = provider && String(cfg.apiKey || "").trim();
    if (hasProvider) {
      const aiText = await callProvider(cfg, profile, user, msgs, kb);
      if (aiText) {
        lastReplies[profile.id] = aiText;
        return aiText;
      }
    }

    const matched = matchKb(kb, lastText);
    const item = matched || (kb || []).find(i => i.intent === "fallback") || { variations: [] };
    const raw = pickVariation(item, profile.id);
    if (!raw) return null;
    return replaceTokens(raw, profile, user);
  }

  /* ---------------- lead mode ---------------- */

  function maybeLead(cfg) {
    if (!cfg.leadEnabled) return;
    const now = Date.now();
    if (now < leadNext) return;

    const kb = kbItems();
    const opener = (kb || []).find(i => i.intent === "opener") || { variations: [] };
    const openers = (opener.variations || []).filter(v => String(v).trim());
    if (!openers.length) { leadNext = now + 60000; return; }

    const profiles = LC.db.profiles.get().filter(p => p.listed === true);
    const users = LC.db.users.get().filter(u => u.listed === true);
    if (!profiles.length || !users.length) { leadNext = now + 60000; return; }

    const msgs = LC.db.messages.get();
    const candidates = users.filter(u =>
      !msgs.some(m => (m.from.type === "user" && m.from.id === u.id) || (m.to.type === "user" && m.to.id === u.id)));
    if (!candidates.length) { leadNext = now + 60000; return; }

    const user = candidates[Math.floor(Math.random() * candidates.length)];
    const profile = profiles[Math.floor(Math.random() * profiles.length)];
    const used = lastReplies[profile.id + "|opener"] || "";
    const pool = openers.filter(v => v !== used);
    const choice = (pool.length ? pool : openers);
    const picked = choice[Math.floor(Math.random() * choice.length)];
    lastReplies[profile.id + "|opener"] = picked;

    sendAsProfile(profile, user, replaceTokens(picked, profile, user));
    leadNext = now + randomBetween(cfg.leadIntervalMin, cfg.leadIntervalMax) * 60000;
  }

  /* ---------------- main tick ---------------- */

  function tick() {
    if (!LC.db || !LC.db.messages) return;
    const cfg = config();
    const msgs = LC.db.messages.get();
    const byConv = {};
    msgs.forEach(m => {
      if (m.from.type === "profile" || m.to.type === "profile") {
        byConv[m.conv] = byConv[m.conv] || [];
        byConv[m.conv].push(m);
      }
    });

    Object.keys(byConv).forEach(key => {
      const list = byConv[key].sort((a, b) => a.ts - b.ts);
      const last = list[list.length - 1];
      if (!last) return;
      if (handled[key] === undefined) { handled[key] = last.ts; return; }
      if (last.ts <= handled[key]) return;
      if (last.from.type === "profile") { handled[key] = last.ts; return; }
      if (!cfg.enabled) { handled[key] = last.ts; return; }
      if (scheduled[key]) return;

      const refs = LC.convFrom(key);
      const profPart = refs.a.type === "profile" ? refs.a : refs.b;
      const userPart = refs.a.type === "user" ? refs.a : refs.b;
      const profile = LC.db.profiles.byId(profPart.id);
      const user = LC.db.users.byId(userPart.id);
      if (!profile || !user) { handled[key] = last.ts; return; }

      scheduled[key] = true;
      setTimeout(() => {
        scheduled[key] = false;
        const cur = LC.db.messages.get().filter(m => m.conv === key).sort((a, b) => a.ts - b.ts);
        const curLast = cur[cur.length - 1];
        if (!curLast || curLast.from.type !== "user" || curLast.ts <= (handled[key] || 0)) return;
        generateReply(cfg, kbItems(), profile, user, cur).then(reply => {
          if (!reply) { handled[key] = curLast.ts; return; }
          sendAsProfile(profile, user, reply);
          handled[key] = Date.now();
        });
      }, delayMs(cfg));
    });

    if (cfg.enabled) maybeLead(cfg);
  }

  /* ---------------- lifecycle ---------------- */

  function start() {
    if (TIMER) return;
    leadNext = Date.now() + 10000;
    TIMER = setInterval(tick, TICK_MS);
  }

  function stop() {
    if (TIMER) { clearInterval(TIMER); TIMER = null; }
  }

  function isRunning() {
    return !!TIMER;
  }

  function isActive() {
    try { return !!config().enabled; } catch (e) { return false; }
  }

  function resetMemory() {
    handled = {};
    scheduled = {};
    lastReplies = {};
  }

  return {
    start: start,
    stop: stop,
    isRunning: isRunning,
    isActive: isActive,
    resetMemory: resetMemory,
    config: config,
    repliedAt: repliedAt,
    tick: tick
  };
})();
