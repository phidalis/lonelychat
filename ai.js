// Hearth Chat — AI assistant engine.
// Runs inside the admin dashboard. Replies to incoming member messages as the
// matching profile, keeps replies varied (never identical), waits a human-like
// delay, and can proactively start conversations with new members (lead mode).
// AI providers compose replies using the knowledge base as reference context.

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
  var ownerUserId = null; // when set, only handle conversations for this client user

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
    const t = " " + String(text || "").toLowerCase()
      .replace(/[^\w\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim() + " ";
    let best = null, bestScore = 0;
    (kb || []).forEach(item => {
      if (!item || item.intent === "fallback" || item.intent === "opener") return;
      const kws = (item.keywords || []).map(k => String(k).toLowerCase().trim()).filter(Boolean);
      if (!kws.length) return;
      let score = 0;
      kws.forEach(k => {
        if (t.indexOf(" " + k + " ") !== -1) score += 2;
        else if (k.length >= 4 && t.indexOf(k) !== -1) score += 1;
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

  function kbScore(item, text) {
    if (!item || item.intent === "fallback" || item.intent === "opener") return 0;
    const t = " " + String(text || "").toLowerCase()
      .replace(/[^\w\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim() + " ";
    let score = 0;
    (item.keywords || []).forEach(k => {
      k = String(k).toLowerCase().trim();
      if (!k) return;
      if (t.indexOf(" " + k + " ") !== -1) score += 2;
      else if (k.length >= 4 && t.indexOf(k) !== -1) score += 1;
    });
    return score;
  }

  // Search the whole knowledge base, not only the first matching topic. The
  // best matches are shown to the AI as reference material; the AI rewrites
  // the answer in its own words instead of sending a saved line.
  function rankKb(kb, text, limit) {
    return (kb || [])
      .filter(item => item && item.intent !== "fallback" && item.intent !== "opener")
      .map(item => ({ item: item, score: kbScore(item, text) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit || 5)
      .map(x => x.item);
  }

  function knowledgeBlock(kb, lastText) {
    const all = (kb || []).filter(item => item && item.intent !== "fallback" && item.intent !== "opener");
    if (!all.length) return "(No knowledge-base entries.)";

    const matched = rankKb(kb, lastText, 6);
    const ordered = matched.concat(all.filter(item => matched.indexOf(item) === -1));

    return ordered.map(item => {
      const refs = (item.variations || []).filter(v => String(v).trim()).slice(0, 4);
      const tag = matched.indexOf(item) !== -1 ? " (most relevant to the latest message)" : "";
      return "- Topic: " + (item.intent || "general") + tag +
        "\n  Keywords: " + (item.keywords || []).join(", ") +
        "\n  Reference wording (facts and tone only — never copy this): " + refs.join(" | ");
    }).join("\n");
  }

  /* ---------------- AI provider calls ---------------- */

  function buildSystemPrompt(profile, user, msgs, kb, lastText) {
    const recent = msgs.slice(-10).map(m => {
      const who = (m.from.type === "profile" && m.from.id === profile.id) ? "you" : "them";
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

  function buildHistory(profile, msgs) {
    const hist = [];
    msgs.slice(-12).forEach(m => {
      const role = (m.from.type === "profile" && m.from.id === profile.id) ? "assistant" : "user";
      hist.push({ role: role, content: m.text || "(photo)" });
    });
    return hist;
  }

  const MODELS = {
    groq: ["qwen/qwen3.8-27b", "openai/gpt-oss-20b", "openai/gpt-oss-120b"],
    openai: ["gpt-4o-mini", "gpt-4o"],
    gemini: ["gemini-2.0-flash", "gemini-1.5-flash"]
  };

  // Groq retired these; skip them so a stale saved setting still works.
  const RETIRED = [
    "llama-3.3-70b-versatile", "llama3-70b-8192", "llama3-8b-8192",
    "mixtral-8x7b-32768", "gemma2-9b-it", "gemma-7b-it"
  ];

  function defaultModel(provider) {
    return (MODELS[provider] && MODELS[provider][0]) || "gpt-4o-mini";
  }

  function modelCandidates(provider, configured) {
    const out = [];
    const custom = String(configured || "").trim();
    if (custom && !(provider === "groq" && RETIRED.indexOf(custom) !== -1)) out.push(custom);
    (MODELS[provider] || []).forEach(m => { if (out.indexOf(m) === -1) out.push(m); });
    return out;
  }

  function cleanReply(text) {
    let s = String(text || "")
      .replace(/<think[\s\S]*?<\/think>/gi, "")
      .replace(/```[\s\S]*?```/g, m => m.replace(/```[a-z]*\n?/gi, "").replace(/```/g, ""))
      .trim();
    s = s.replace(/^(you|assistant|ai|reply)\s*:\s*/i, "");
    s = s.replace(/^["'“”‘’]([\s\S]*)["'“”‘’]$/, "$1").trim();
    s = s.replace(/\s+/g, " ").trim();
    if (!s) return "";
    return s.length > 500 ? s.slice(0, 500).trim() : s;
  }

  async function callProvider(cfg, profile, user, msgs, kb) {
    const provider = String(cfg.provider || "").toLowerCase();
    const apiKey = String(cfg.apiKey || "").trim();
    if (!provider || !apiKey) return null;
    if (["openai", "groq", "gemini"].indexOf(provider) === -1) return null;

    const lastText = msgs.length ? (msgs[msgs.length - 1].text || "") : "";
    const system = buildSystemPrompt(profile, user, msgs, kb, lastText);
    const history = buildHistory(profile, msgs);
    const models = modelCandidates(provider, cfg.model);

    for (const model of models) {
      try {
        if (provider === "openai" || provider === "groq") {
          const base = provider === "openai" ? "https://api.openai.com/v1" : "https://api.groq.com/openai/v1";
          const payload = {
            model: model,
            messages: [{ role: "system", content: system }].concat(history),
            temperature: 0.85,
            max_tokens: 400
          };
          if (provider === "groq" && /gpt-oss/i.test(model)) payload.reasoning_effort = "low";
          const res = await fetch(base + "/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
            body: JSON.stringify(payload)
          });
          if (!res.ok) {
            const detail = (await res.text()).slice(0, 300);
            console.error("Hearth AI provider request failed (" + provider + "/" + model + ", HTTP " + res.status + "): " + detail);
            if (res.status === 404 || res.status === 400) continue;
            return null;
          }
          const data = await res.json();
          const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
          const clean = cleanReply(text);
          if (clean) return clean;
          continue;
        }
        if (provider === "gemini") {
          const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
            encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey);
          const contents = [{ role: "user", parts: [{ text: system }] }];
          history.forEach(h => contents.push({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.content }] }));
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: contents, generationConfig: { temperature: 0.85, maxOutputTokens: 400 } })
          });
          if (!res.ok) {
            const detail = (await res.text()).slice(0, 300);
            console.error("Hearth AI provider request failed (" + provider + "/" + model + ", HTTP " + res.status + "): " + detail);
            if (res.status === 404 || res.status === 400) continue;
            return null;
          }
          const data = await res.json();
          const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
            data.candidates[0].content.parts || []).map(p => p.text || "").join("");
          const clean = cleanReply(text);
          if (clean) return clean;
          continue;
        }
      } catch (e) {
        console.error("Hearth AI: provider request failed (" + provider + "/" + model + ").", e);
      }
    }
    return null;
  }

  /* ---------------- reply generation ---------------- */

  async function generateReply(cfg, kb, profile, user, msgs) {
    const lastMsg = msgs[msgs.length - 1];
    const lastText = lastMsg && lastMsg.text ? lastMsg.text : "";
    if (!lastText) return null;

    const provider = String(cfg.provider || "").toLowerCase();
    if (provider) {
      if (!String(cfg.apiKey || "").trim()) {
        console.error("Hearth AI: a provider is selected, but its API key is missing.");
        return null;
      }
      const aiText = await callProvider(cfg, profile, user, msgs, kb);
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

    const item = (kb || []).find(i => i.intent === "fallback") || { variations: [] };
    const raw = pickVariation(item, profile.id);
    if (!raw) return null;
    return replaceTokens(raw, profile, user);
  }

  /* ---------------- lead mode ---------------- */

  function maybeLead(cfg) {
    if (!cfg.leadEnabled || ownerUserId) return;
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

    const hb = Number(LC.db.getSetting ? LC.db.getSetting("ai_server_heartbeat", 0) : 0);
    const serverActive = hb > 0 && Date.now() - hb < 60000;

    if (!serverActive) {
      Object.keys(byConv).forEach(key => {
        const refs = LC.convFrom(key);
        const profPart = refs.a.type === "profile" ? refs.a : refs.b;
        const userPart = refs.a.type === "user" ? refs.a : refs.b;
        if (ownerUserId && userPart.id !== ownerUserId) return;

        const list = byConv[key].sort((a, b) => a.ts - b.ts);
        const last = list[list.length - 1];
        if (!last) return;
        if (handled[key] === undefined) {
          const recent = Date.now() - last.ts < 10 * 60 * 1000;
          if (last.from.type === "profile" || !recent) { handled[key] = last.ts; return; }
          handled[key] = 0;
        }
        if (last.ts <= handled[key]) return;
        if (last.from.type === "profile") { handled[key] = last.ts; return; }
        if (!cfg.enabled) { handled[key] = last.ts; return; }
        if (scheduled[key]) return;

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
    }

    if (cfg.enabled) maybeLead(cfg);
  }

  /* ---------------- lifecycle ---------------- */

  function start(opts) {
    if (opts && opts.userId) ownerUserId = String(opts.userId);
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
