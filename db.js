window.LC = window.LC || {};

(function () {
  "use strict";

  var sb = LC.supabaseClient;
  var CACHE = {};      // key -> array of JS objects (in-memory snapshot)
  var SYNCED = {};     // key -> deep copy of last-persisted state (for diffing)
  var SETTINGS = {};   // settings table: key -> value
  var PAYCONF = {};    // payment_config row
  // Local writes that a server fetch may not show yet. Without these, a fetch that started
  // before an upsert committed wipes the just-sent message from CACHE until the next poll.
  var INFLIGHT = {};   // key -> id -> { obj, done, until }
  var GONE = {};       // key -> id -> until   (local deletes not yet visible in a fetch)
  var LOADSEQ = {};    // key -> number of the latest fetch started
  var LOADAPPLIED = {};// key -> number of the latest fetch applied (older responses are dropped)
  var OPT_OK = {};     // key -> false once a write proved the optional columns are missing
  var GRACE_MS = 5000;

  var CONFIGS = {
    users: {
      table: "users",
      columns: ["id", "username", "full_name", "age", "gender", "email", "password", "about", "avatar", "bio", "online", "listed", "listed_at", "last_active", "plan", "balance", "role", "msg_quota", "created_at"],
      renames: { fullName: "full_name", listedAt: "listed_at", lastActive: "last_active", msgQuota: "msg_quota", createdAt: "created_at" }
    },
    profiles: {
      table: "profiles",
      columns: ["id", "username", "full_name", "age", "gender", "email", "password", "about", "avatar", "bio", "online", "listed", "listed_at", "last_active", "created_at"],
      renames: { fullName: "full_name", listedAt: "listed_at", lastActive: "last_active", createdAt: "created_at" }
    },
    messages: {
      table: "messages",
      columns: ["id", "conv", "from_ref", "to_ref", "text", "image", "ts", "read", "reactions", "reply_to", "edited"],
      renames: { from: "from_ref", to: "to_ref", replyTo: "reply_to" },
      // Columns added in schema-message-actions.sql. If they don't exist yet the
      // client strips them from writes and keeps them locally, so chats keep working.
      optional: ["reactions", "reply_to", "edited"],
      fullSelect: true
    },
    follows: {
      table: "follows",
      columns: ["id", "follower", "target", "ts"],
      renames: {}
    },
    notifications: {
      table: "notifications",
      columns: ["id", "recipient", "from_ref", "kind", "text", "ts", "read"],
      renames: { from: "from_ref" }
    },
    tasks: {
      table: "tasks",
      columns: ["id", "title", "category", "description", "reward", "subject", "status", "claimed_by", "claimed_at", "completed_at", "created_at"],
      renames: { claimedBy: "claimed_by", claimedAt: "claimed_at", completedAt: "completed_at", createdAt: "created_at" }
    },
    taskMessages: {
      table: "task_messages",
      columns: ["id", "conv", "from_ref", "to_ref", "text", "image", "ts", "read"],
      renames: { from: "from_ref", to: "to_ref" }
    },
    applications: {
      table: "applications",
      columns: ["id", "applicant", "service", "message", "status", "created_at", "reviewed_at"],
      renames: { createdAt: "created_at", reviewedAt: "reviewed_at" }
    },
    withdrawals: {
      table: "withdrawals",
      columns: ["id", "user_ref", "amount", "method", "status", "created_at", "paid_at"],
      renames: { user: "user_ref", createdAt: "created_at", paidAt: "paid_at" }
    },
    paymentMethods: {
      table: "payment_methods",
      columns: ["id", "name", "description", "icon", "connected", "sort"],
      renames: { desc: "description" }
    },
    payments: {
      table: "payments",
      columns: ["id", "user_ref", "method", "method_name", "plan", "amount", "ref", "ts", "status"],
      renames: { user: "user_ref", methodName: "method_name" }
    },
    sessions: {
      table: "sessions",
      columns: ["id", "user_id", "user_type", "created_at"],
      renames: { userId: "user_id", userType: "user_type", createdAt: "created_at" }
    }
  };

  var AI_CONFIG_DEFAULT = {
    enabled: false,
    provider: "",       // "" | "openai" | "groq" | "gemini"
    apiKey: "",
    model: "",
    delayMin: 3,        // reply delay range (seconds)
    delayMax: 7,
    leadEnabled: false, // AI starts conversations with members who have none yet
    leadIntervalMin: 30,
    leadIntervalMax: 60
  };

  var AI_KB_VERSION = 2;

  var AI_KB_DEFAULT = [
    { id: "kb_greeting", intent: "greeting", keywords: ["hello", "hi", "hey", "hiya", "howdy", "yo", "good morning", "good afternoon", "good evening", "morning", "evening", "sup", "greetings"], variations: [
      "Hi! I'm good — how are you? What about you?",
      "Hey! So nice to hear from you. How's your day going?",
      "Hello! I was hoping someone would say hi. How are you doing?",
      "Hey there! I'm doing pretty good, just relaxing. How about you?",
      "Hi! You just made my day a little better. How are you?"
    ] },
    { id: "kb_how_are_you", intent: "how_are_you", keywords: ["how are you", "how you doing", "how's it going", "how are things", "how r u", "hru", "how ya doing", "how are you doing", "you ok", "you okay", "how do you feel"], variations: [
      "I'm good, thanks for asking. How are you doing? What about you?",
      "Pretty good actually — quiet day, but I can't complain. What about you?",
      "I'm doing well. A little tired, but good. How's everything with you?",
      "Honestly, I'm okay. Some days are better than others, you know? How are you?"
    ] },
    { id: "kb_whats_up", intent: "whats_up", keywords: ["what's up", "whats up", "what are you doing", "what you doing", "what are you up to", "wyd", "you busy", "what's new", "whats new"], variations: [
      "Not much, just chilling at home. What are you up to?",
      "Honestly, nothing exciting. I was hoping to hear from someone. What's new with you?",
      "Just taking it easy today. What are you doing right now?",
      "I'm here, talking to you now. What's on your mind?"
    ] },
    { id: "kb_how_was_day", intent: "how_was_day", keywords: ["how was your day", "how's your day", "how did your day go", "how was today", "how's today been", "how has your day been"], variations: [
      "It was okay, a little quiet. But talking to you is already the best part of it.",
      "Pretty steady! A few small wins. How did your day go?",
      "Busy but good. I was honestly hoping you'd message. What about yours?",
      "It had its ups and downs. I'm glad it's winding down though. How about you?"
    ] },
    { id: "kb_name", intent: "name", keywords: ["what's your name", "whats your name", "your name", "who are you", "may i know your name"], variations: [
      "I'm {profileName}. And you? {name}, right? I like that name.",
      "It's {profileName}. What should I call you?",
      "People call me {profileName}. What's your name?",
      "I'm {profileName} — nice to finally talk to you. What's your name?"
    ] },
    { id: "kb_age", intent: "age", keywords: ["how old are you", "your age", "how old", "what's your age", "whats your age"], variations: [
      "Haha, a lady never tells. How old are you?",
      "I'm in my twenties, if that counts. Your turn!",
      "Let's just say I was born in the 90s. What about you?",
      "Old enough to know better, young enough to still have fun. How old are you?"
    ] },
    { id: "kb_where_from", intent: "where_are_you_from", keywords: ["where are you from", "where do you live", "where are you based", "what country", "what city", "your location", "where you from"], variations: [
      "I'm from a pretty quiet corner of the world. What about you?",
      "I move around a lot, but home is wherever the good people are. Where are you from?",
      "That's a story for another day. Tell me where you're from!",
      "I grew up somewhere small and calm. Where are you from?"
    ] },
    { id: "kb_what_do_you_do", intent: "what_do_you_do", keywords: ["what do you do", "what do you work", "your job", "your work", "what are you studying", "your career", "what do you study", "what do you work as", "are you working", "are you in school"], variations: [
      "I spend most of my time on {about}. And you — what fills your days?",
      "A little bit of everything, honestly. I love hearing about people more. What do you do?",
      "Honestly? {about}. But I'm way more interested in you — what do you love doing?",
      "Work keeps me busy, but I'd rather talk about you. What do you do?"
    ] },
    { id: "kb_hobbies", intent: "hobbies", keywords: ["hobby", "hobbies", "what do you like", "your interests", "what are you into", "free time", "for fun", "what do you enjoy"], variations: [
      "I love a good book and long talks. What do you do for fun?",
      "Music, long walks and great conversations. What's your thing?",
      "I've got a few little hobbies, but I'd rather hear about yours first.",
      "I like anything that feels real — good music, honest talks, quiet evenings. What about you?"
    ] },
    { id: "kb_music", intent: "music", keywords: ["music", "song", "songs", "singer", "artist", "album", "playlist", "listen to"], variations: [
      "I listen to almost anything, depends on my mood. What are you playing lately?",
      "I love music that makes you feel something. What's your favourite song right now?",
      "My playlist is all over the place, honestly. What kind of music do you like?",
      "Music is my escape. Who's your favourite artist?"
    ] },
    { id: "kb_movies", intent: "movies", keywords: ["movie", "movies", "film", "series", "netflix", "show", "watch", "watching"], variations: [
      "I love a good movie night. What have you watched lately?",
      "I'm more of a series person, honestly. What are you watching?",
      "I can get lost in a good film for hours. What's your favourite?",
      "I watched something last night and stayed up way too late. What about you?"
    ] },
    { id: "kb_food", intent: "food", keywords: ["food", "eat", "eating", "hungry", "cook", "cooking", "dinner", "lunch", "breakfast", "favourite meal"], variations: [
      "I could eat anything right now, honestly. What's your favourite food?",
      "I love a good home-cooked meal. Do you cook?",
      "Food is one of the simple joys in life. What did you eat today?",
      "I'm a sucker for a good dinner. What do you like to eat?"
    ] },
    { id: "kb_relationship", intent: "relationship", keywords: ["single", "boyfriend", "girlfriend", "dating", "relationship", "crush", "married", "partner", "do you have a", "are you taken"], variations: [
      "I'm single and just taking things one day at a time. What about you?",
      "No one special right now — but I do love meeting interesting people. Like you.",
      "That's a loaded question! Why do you ask?",
      "I'm not seeing anyone at the moment. What about you?"
    ] },
    { id: "kb_compliment", intent: "compliment", keywords: ["pretty", "beautiful", "handsome", "cute", "gorgeous", "lovely", "amazing", "stunning", "wonderful", "nice smile", "look good"], variations: [
      "You're making me blush! Thank you, that's really sweet.",
      "Aww, that's kind of you to say. I like how thoughtful you are.",
      "Careful — you'll make me smile all day. Thank you!",
      "That's really sweet of you. You're not so bad yourself, you know."
    ] },
    { id: "kb_thanks", intent: "thanks", keywords: ["thank you", "thanks", "thank u", "appreciate it", "thx", "much appreciated", "means a lot"], variations: [
      "Anytime! I'm glad I could help.",
      "You're welcome. I meant every word.",
      "Of course! It was my pleasure, honestly.",
      "No need to thank me. That's what friends are for."
    ] },
    { id: "kb_apology", intent: "apology", keywords: ["sorry", "i apologise", "i apologize", "my bad", "didn't mean", "didnt mean", "forgive me"], variations: [
      "Don't worry about it, really. It's fine.",
      "No hard feelings at all. We're good.",
      "It's okay, we all have those moments. Don't beat yourself up.",
      "Honestly, you don't need to apologise. I get it."
    ] },
    { id: "kb_bye", intent: "bye", keywords: ["bye", "goodbye", "good night", "goodnight", "gotta go", "got to go", "see you", "later", "ttyl", "gtg", "have to go", "going to sleep", "talk later", "talk soon"], variations: [
      "Aww, okay! It was lovely talking to you. Come back soon.",
      "Alright, take care of yourself. Message me anytime you need a chat.",
      "Goodnight! I hope you dream about something nice.",
      "See you soon. I'll be right here whenever you want to talk.",
      "Bye for now! Don't be a stranger, okay?"
    ] },
    { id: "kb_bored", intent: "bored", keywords: ["bored", "boring", "nothing to do", "lonely", "alone", "no one to talk to", "no one to talk", "nothing interesting"], variations: [
      "Bored? Well, now you have me to talk to. What's on your mind?",
      "I get that feeling. But your message just made my evening better — what's going on?",
      "Let's fix that! Tell me something about you — anything at all.",
      "I know that feeling. Want to talk about something random to pass the time?"
    ] },
    { id: "kb_sad", intent: "sad", keywords: ["sad", "depressed", "down", "feeling low", "feel low", "crying", "hurt", "heartbroken", "upset", "tired of everything"], variations: [
      "I'm sorry you're feeling that way. I'm here if you want to talk about it.",
      "That sounds heavy. Do you want a light distraction or a proper deep chat?",
      "You don't have to deal with it alone. What's going on?",
      "I'm listening, and I'm not going anywhere. Take your time."
    ] },
    { id: "kb_tired", intent: "tired", keywords: ["tired", "exhausted", "sleepy", "no energy", "worn out", "drained"], variations: [
      "Sounds like you need a proper rest. Have you been sleeping okay?",
      "Aww, I hope you get to slow down soon. What's been draining you?",
      "I feel you. Some days just take it out of you. What happened?",
      "Make sure you take care of yourself. Have you eaten and rested today?"
    ] },
    { id: "kb_love", intent: "love", keywords: ["i love you", "love you", "i like you", "i miss you", "miss you", "thinking of you", "adore you"], variations: [
      "That's really sweet. You just made me smile.",
      "Aww, stop it. You're going to make me blush.",
      "I like talking to you too, you know. More than I expected.",
      "That means a lot, honestly. Thank you."
    ] },
    { id: "kb_weekend", intent: "weekend", keywords: ["weekend", "plans", "what are you doing this weekend", "any plans", "plans today", "plans tomorrow", "holiday"], variations: [
      "No big plans yet, just taking it easy. What about you?",
      "I'm hoping for a quiet one, maybe a walk and good food. What are you up to?",
      "Nothing set in stone. I'm open to suggestions, honestly. What are your plans?",
      "I might meet a friend or just stay in. What about you?"
    ] },
    { id: "kb_weather", intent: "weather", keywords: ["weather", "rain", "raining", "sunny", "hot today", "cold", "freezing", "forecast", "outside"], variations: [
      "It's been raining here on and off. I love the sound of it, honestly. How's the weather where you are?",
      "Sunny but breezy — perfect for a long walk. What's it like on your side?",
      "I've barely left the house today. Tell me about the weather there!",
      "It's the kind of weather that makes you want to stay in with a cup of tea. How is it there?"
    ] },
    { id: "kb_joke", intent: "joke", keywords: ["joke", "funny", "make me laugh", "tell me something funny", "laugh"], variations: [
      "Okay, give me a second... Why did the scarecrow win an award? Because he was outstanding in his field.",
      "I'm terrible at jokes, but I'll try. What do you call a fake noodle? An impasta.",
      "Hmm, my jokes are usually better in person. How about you tell me one?",
      "I laugh at the silliest things, honestly. What's the last thing that made you laugh?"
    ] },
    { id: "kb_opener", intent: "opener", keywords: [], variations: [
      "Hey {name}! I kept seeing your profile and finally had to say hi. How's your day going?",
      "Hi {name}, this might be a little random, but you have such a kind vibe. How are you?",
      "{name}! I'm {profileName}. I was really hoping I'd get to talk to you today. What are you up to?",
      "Hey {name}, I'm {profileName} — it's a pleasure. What's something you're really into right now?"
    ] },
    { id: "kb_fallback", intent: "fallback", keywords: [], variations: [
      "Tell me more — I'm all ears.",
      "Interesting... what makes you say that?",
      "I like how your mind works. Go on.",
      "Hmm, I've never thought of it that way. Say more?",
      "That's something I'd love to hear more about."
    ] }
  ];

  function invert(map) {
    var out = {};
    Object.keys(map).forEach(function (k) { out[map[k]] = k; });
    return out;
  }

  function optionalDisabled(key) {
    var cfg = CONFIGS[key];
    return !!(cfg && cfg.optional && OPT_OK[key] === false);
  }

  function toRow(key, obj) {
    var cfg = CONFIGS[key];
    var dbToJs = invert(cfg.renames);
    var skip = optionalDisabled(key) ? cfg.optional : null;
    var row = {};
    cfg.columns.forEach(function (col) {
      if (skip && skip.indexOf(col) >= 0) return;
      var js = dbToJs[col] || col;
      var v = obj[js];
      row[col] = (v === undefined || v === null) ? null : v;
    });
    return row;
  }

  function fromRow(key, row) {
    var cfg = CONFIGS[key];
    var dbToJs = invert(cfg.renames);
    var obj = {};
    cfg.columns.forEach(function (col) {
      obj[dbToJs[col] || col] = row[col];
    });
    return obj;
  }

  // Optional columns (message reactions / replies / edited flag) may not exist on
  // the server yet. Keep the values we already hold locally instead of wiping them
  // when a fetch returns rows without those columns. An explicit empty string /
  // false from the server always wins, so clearing a reaction still works.
  function preserveOptional(key, raw, old) {
    var cfg = CONFIGS[key];
    if (!cfg || !cfg.optional || !old) return raw;
    var dbToJs = invert(cfg.renames);
    var out = null;
    cfg.optional.forEach(function (col) {
      var js = dbToJs[col] || col;
      var v = raw[js];
      var had = old[js];
      // undefined = the column isn't in the table yet. null/false/"" are real
      // server values (cleared reaction, unedited message) and must win.
      if (v === undefined && had !== undefined && had !== null) {
        if (!out) out = Object.assign({}, raw);
        out[js] = had;
      }
    });
    return out || raw;
  }

  function deepCopy(v) {
    try { return JSON.parse(JSON.stringify(v)); }
    catch (e) { return Array.isArray(v) ? v.slice() : v; }
  }


  /* ---------------- offline snapshot (IndexedDB) + query-saving state ---------------- */

  var CURSOR_OVERLAP_MS = 120000;  // re-read the last 2 min on incremental pulls (clock skew safety)
  var FULL_RECONCILE_MS = 300000;  // full re-fetch of messages/notifications every 5 min
  var RT_SKIP_MS = 600000;         // when realtime is live, skip full table polls for 10 min
  var LASTFULL = {};               // key -> last full fetch time
  var RT_OK = false;               // realtime channel is subscribed
  var snapTimer = null;

  function idbOpen() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error("no idb"));
      var r = indexedDB.open("hearth-data", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbGet(k) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var q = db.transaction("kv", "readonly").objectStore("kv").get(k);
        q.onsuccess = function () { res(q.result); };
        q.onerror = function () { rej(q.error); };
      });
    });
  }
  function idbSet(k, v) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(v, k);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function idbDel(k) {
    return idbOpen().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").delete(k);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { res(); };
      });
    }).catch(function () {});
  }

  // Save what we have so the next open (even offline) can show it instantly.
  function scheduleSnapshot() {
    if (snapTimer) return;
    snapTimer = setTimeout(function () {
      snapTimer = null;
      if (!LC.auth || !LC.auth.getToken()) return;           // nobody logged in: store nothing
      idbSet("snapshot", {
        v: 1, savedAt: Date.now(), token: LC.auth.getToken(),
        cache: CACHE, synced: SYNCED, settings: SETTINGS, payconf: PAYCONF
      }).catch(function () {});
    }, 1500);
  }

  // Restore the last snapshot, but only for the same logged-in session token.
  async function hydrate() {
    try {
      var tok = LC.auth.getToken();
      if (!tok) return false;
      var snap = await idbGet("snapshot");
      if (!snap || snap.v !== 1 || snap.token !== tok || !snap.cache || !(snap.cache.users || []).length) return false;
      CACHE = snap.cache; SYNCED = snap.synced || {}; SETTINGS = snap.settings || {};
      PAYCONF = snap.payconf || {};
      return true;
    } catch (e) { return false; }
  }

  function baseQuery(key) {
    var cfg = CONFIGS[key];
    var cols = cfg.fullSelect ? "*" : cfg.columns.join(",");
    return sb.from(cfg.table).select(cols);
  }

  function mergeRows(key, rows) {
    var map = {};
    (CACHE[key] || []).forEach(function (r) { map[r.id] = r; });
    var fl = INFLIGHT[key];
    rows.forEach(function (r) {
      var e = fl && fl[r.id];
      if (e && !e.done) return;                            // local write still running: keep it
      map[r.id] = preserveOptional(key, r, map[r.id]);
    });
    CACHE[key] = Object.keys(map).map(function (id) { return map[id]; });
    var sm = {};
    (SYNCED[key] || []).forEach(function (r) { sm[r.id] = r; });
    rows.forEach(function (r) { sm[r.id] = deepCopy(r); });
    SYNCED[key] = Object.keys(sm).map(function (id) { return sm[id]; });
  }

  // Fetch ONLY rows newer than what we already hold (messages, notifications).
  async function loadIncremental(key) {
    var have = CACHE[key] || [];
    if (!have.length || !LASTFULL[key]) return loadTable(key);
    var maxTs = 0;
    have.forEach(function (r) { if (r.ts > maxTs) maxTs = r.ts; });
    var q = baseQuery(key);
    var res = await q.gt("ts", Math.max(0, maxTs - CURSOR_OVERLAP_MS)).order("ts", { ascending: true });
    if (res.error) { console.error("pull " + key, res.error); return; }
    var rows = (res.data || []).map(function (r) { return fromRow(key, r); });
    if (rows.length) { mergeRows(key, rows); scheduleSnapshot(); }
  }

  // Apply one realtime event straight to the cache (no table re-download).
  function applyChange(key, payload) {
    var t = payload && payload.eventType;
    if (t === "DELETE") {
      var did = payload.old && payload.old.id;
      if (did === undefined || did === null) return loadTable(key);
      CACHE[key] = (CACHE[key] || []).filter(function (r) { return r.id !== did; });
      SYNCED[key] = (SYNCED[key] || []).filter(function (r) { return r.id !== did; });
      scheduleSnapshot();
      return;
    }
    if (!payload || !payload.new) return loadTable(key);
    var o = fromRow(key, payload.new);
    mergeRows(key, [o]);
    scheduleSnapshot();
  }

  async function loadTable(key) {
    var cfg = CONFIGS[key];
    if (!cfg) return;
    if (!sb) return;
    var seq = LOADSEQ[key] = (LOADSEQ[key] || 0) + 1;
    var q = baseQuery(key);
    var res = await q;
    if (res.error) { console.error("load " + key, res.error); return; }
    if (seq < (LOADAPPLIED[key] || 0)) return; // a newer fetch was already applied
    LOADAPPLIED[key] = seq;
    var rows = (res.data || []).map(function (r) { return fromRow(key, r); });
    var oldById = {};
    (CACHE[key] || []).forEach(function (r) { oldById[r.id] = r; });
    SYNCED[key] = deepCopy(rows);
    CACHE[key] = mergeLocal(key, rows).map(function (r) {
      return preserveOptional(key, r, oldById[r.id]);
    });
    LASTFULL[key] = Date.now();
    scheduleSnapshot();
  }

  // Server rows + local writes the server hasn't returned yet (and minus local deletes in flight).
  function mergeLocal(key, rows) {
    var now = Date.now();
    var fl = INFLIGHT[key], gone = GONE[key];
    if (gone) Object.keys(gone).forEach(function (id) { if (gone[id] < now) delete gone[id]; });
    if (fl) Object.keys(fl).forEach(function (id) { if (fl[id].done && fl[id].until < now) delete fl[id]; });
    var out = gone ? rows.filter(function (r) { return !Object.prototype.hasOwnProperty.call(gone, r.id); }) : rows;
    if (!fl) return out;
    var seen = {};
    out = out.map(function (r) {
      seen[r.id] = true;
      var e = fl[r.id];
      return (e && !e.done) ? e.obj : r;   // local copy wins only while its upsert is still running
    });
    Object.keys(fl).forEach(function (id) { if (!seen[id]) out.push(fl[id].obj); });
    return out;
  }

  async function loadSettings() {
    if (!sb) return;
    var res = await sb.from("settings").select("*");
    if (res.error || !res.data) return;                    // offline/failed: keep what we have
    SETTINGS = {};
    (res.data || []).forEach(function (r) { SETTINGS[r.key] = r.value; });
    scheduleSnapshot();
  }

  async function loadPayConf() {
    if (!sb) return;
    var res = await sb.from("payment_config").select("*").eq("id", "main").maybeSingle();
    if (res.error) return;
    PAYCONF = res.data ? { binanceAddress: res.data.binance_address || "" } : { binanceAddress: "" };
  }

  async function persist(key, arr) {
    var cfg = CONFIGS[key];
    if (!cfg || !sb) return;
    scheduleSnapshot();
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;  // stays unsynced; LC.db.flush() sends it later
    var prev = SYNCED[key] || [];
    var prevMap = {};
    prev.forEach(function (r) { prevMap[r.id] = r; });
    var ids = {};
    var upserts = [];
    var upObjs = [];
    (arr || []).forEach(function (o) {
      if (!o || o.id === undefined) return;
      ids[o.id] = true;
      var row = toRow(key, o);
      var before = prevMap[o.id];
      // compare in row form (before is a JS object, row uses DB column names)
      if (!before || JSON.stringify(toRow(key, before)) !== JSON.stringify(row)) { upserts.push(row); upObjs.push(o); }
    });
    var removals = prev.filter(function (r) { return !ids[r.id]; }).map(function (r) { return r.id; });

    var fl = INFLIGHT[key] = INFLIGHT[key] || {};
    var gone = GONE[key] = GONE[key] || {};
    var mine = upObjs.map(function (o) { var e = { obj: o, done: false, until: 0 }; fl[o.id] = e; return e; });
    removals.forEach(function (id) { gone[id] = Infinity; });
    try {
      if (upserts.length) {
        var up = await sb.from(cfg.table).upsert(upserts, { onConflict: "id" });
        // Older databases may not have the optional message columns yet. Retry
        // without them once, then remember to skip them until the next reload.
        if (up.error && cfg.optional && OPT_OK[key] !== false) {
          OPT_OK[key] = false;
          var baseRows = upserts.map(function (r) {
            var o = {};
            Object.keys(r).forEach(function (c) { if (cfg.optional.indexOf(c) < 0) o[c] = r[c]; });
            return o;
          });
          up = await sb.from(cfg.table).upsert(baseRows, { onConflict: "id" });
        }
        if (up.error) console.error("upsert " + key, up.error);
      }
      if (removals.length) {
        var del = await sb.from(cfg.table).delete().in("id", removals);
        if (del.error) console.error("delete " + key, del.error);
      }
    } finally {
      var until = Date.now() + GRACE_MS;
      mine.forEach(function (e) { e.done = true; e.until = until; });
      removals.forEach(function (id) { gone[id] = until; });
    }
    // Update only what we wrote; a fetch may have replaced SYNCED while we were awaiting.
    var byId = {};
    (SYNCED[key] || []).forEach(function (r) { byId[r.id] = r; });
    upObjs.forEach(function (o) { byId[o.id] = deepCopy(o); });
    removals.forEach(function (id) { delete byId[id]; });
    SYNCED[key] = Object.keys(byId).map(function (id) { return byId[id]; });
  }

  /* ---------------- public API ---------------- */

  LC.db = {
    prefix: "lc_",
    ready: null,

    read: function (key, fallback) { return fallback; },
    write: function () {},
    remove: function () {},

    uid: function () {
      return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
    },
    now: function () { return Date.now(); },

    _load: async function (keys) {
      var list = keys || Object.keys(CONFIGS);
      await Promise.all(list.map(function (key) {
        return CONFIGS[key] ? loadTable(key) : Promise.resolve();
      }));
      if (!keys) await Promise.all([loadSettings(), loadPayConf()]);
    },

    init: async function (keys) {
      if (LC.db._inited) return true;
      LC.db._inited = true;
      var fromSnapshot = await hydrate();
      LC.db.hydrated = fromSnapshot;
      var online = !(typeof navigator !== "undefined" && navigator.onLine === false);
      if (fromSnapshot) {
        // Instant start from the saved copy; fetch only what changed in the background.
        if (online) {
          LC.db._load(keys).then(function () {
            LC.db.setupRealtime();
            LC.rt.local({ type: "rt" });
          }).catch(function () {});
        }
        return true;
      }
      if (online) { await LC.db._load(keys); LC.db.setupRealtime(); }
      return true;
    },

    reload: async function () {
      await LC.db._load();
    },

    // Silent re-fetch of specific tables from Supabase (no UI changes here).
    // Used by the pages to keep messages/conversations fresh in near real time.
    refresh: async function (keys) {
      if (!sb || !keys || !keys.length) return;
      var jobs = [];
      var wantSettings = false;
      var wantPay = false;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;   // offline: use the saved copy
      var now = Date.now();
      keys.forEach(function (key) {
        var age = now - (LASTFULL[key] || 0);
        if (key === "settings") { if (!RT_OK || age > RT_SKIP_MS) { wantSettings = true; } }
        else if (key === "payment_config") wantPay = true;
        else if (key === "messages" || key === "notifications") {
          // New rows only; a full re-fetch just every few minutes to catch deletes/read-flags.
          jobs.push(age > FULL_RECONCILE_MS || !(CACHE[key] || []).length ? loadTable(key) : loadIncremental(key));
        }
        else if (CONFIGS[key]) {
          // Realtime already applies every change; only poll these when realtime is not live.
          if (key === "sessions" ? age > FULL_RECONCILE_MS : (!RT_OK || age > RT_SKIP_MS)) jobs.push(loadTable(key));
        }
      });
      if (wantSettings) { LASTFULL.settings = now; jobs.push(loadSettings()); }
      if (wantPay) jobs.push(loadPayConf());
      await Promise.all(jobs);
    },

    setupRealtime: function () {
      if (!sb || LC.db._rtSetup) return;
      LC.db._rtSetup = true;
      try {
        var ch = sb.channel("lc-live-" + Math.random().toString(36).slice(2, 8));
        Object.keys(CONFIGS).forEach(function (key) {
          if (key === "sessions") return;   // other people's logins are none of our business (and cost a reload each)
          var table = CONFIGS[key].table;
          ch.on("postgres_changes", { event: "*", schema: "public", table: table }, function (payload) {
            // Apply the changed row directly instead of re-downloading the whole table.
            Promise.resolve(applyChange(key, payload)).then(function () {
              LC.rt.emit({ type: "rt" });   // other tabs
              LC.rt.local({ type: "rt" });  // this tab (BroadcastChannel never delivers to the sender)
            });
          });
        });
        ch.subscribe(function (status) { RT_OK = (status === "SUBSCRIBED"); });
      } catch (e) { console.error("realtime", e); }
    },

    // Send changes made while offline (persist() diffs CACHE against the last synced copy).
    flush: async function () {
      if (!sb || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
      var keys = Object.keys(CACHE).filter(function (k) { return CONFIGS[k] && k !== "sessions"; });
      for (var i = 0; i < keys.length; i++) {
        try { await persist(keys[i], CACHE[keys[i]]); } catch (e) { console.error("flush " + keys[i], e); }
      }
    },

    resetAll: async function () {
      if (!sb) return;
      var tables = ["users", "profiles", "messages", "follows", "notifications", "tasks", "task_messages", "applications", "withdrawals", "payment_methods", "payment_config", "payments", "settings"];
      for (var i = 0; i < tables.length; i++) {
        await sb.from(tables[i]).delete().neq("id", "__never__");
      }
      await LC.seedAll();
      await LC.db.reload();
    },

    setSetting: async function (key, value) {
      SETTINGS[key] = value;
      if (sb) await sb.from("settings").upsert({ key: key, value: value }, { onConflict: "key" });
    },
    getSetting: function (key, fallback) {
      return SETTINGS[key] !== undefined ? SETTINGS[key] : fallback;
    },

    users: {
      get: function () { return CACHE.users || []; },
      save: function (u) { CACHE.users = u || []; persist("users", CACHE.users); },
      byId: function (id) { return (CACHE.users || []).find(function (u) { return u.id === id; }) || null; },
      byUsername: function (n) { return (CACHE.users || []).find(function (u) { return String(u.username).toLowerCase() === String(n).toLowerCase(); }) || null; },
      byEmail: function (e) { return (CACHE.users || []).find(function (u) { return String(u.email).toLowerCase() === String(e).toLowerCase(); }) || null; }
    },
    profiles: {
      get: function () { return CACHE.profiles || []; },
      save: function (p) { CACHE.profiles = p || []; persist("profiles", CACHE.profiles); },
      byId: function (id) { return (CACHE.profiles || []).find(function (p) { return p.id === id; }) || null; }
    },
    messages: {
      get: function () { return CACHE.messages || []; },
      save: function (m) { CACHE.messages = m || []; persist("messages", CACHE.messages); }
    },
    follows: {
      get: function () { return CACHE.follows || []; },
      save: function (f) { CACHE.follows = f || []; persist("follows", CACHE.follows); },
      exists: function (a, b) {
        return (CACHE.follows || []).some(function (f) {
          return f.follower && f.target &&
            f.follower.id === a.id && f.follower.type === a.type &&
            f.target.id === b.id && f.target.type === b.type;
        });
      }
    },
    notifications: {
      get: function () { return CACHE.notifications || []; },
      save: function (n) { CACHE.notifications = n || []; persist("notifications", CACHE.notifications); }
    },
    tasks: {
      get: function () { return CACHE.tasks || []; },
      save: function (t) { CACHE.tasks = t || []; persist("tasks", CACHE.tasks); },
      byId: function (id) { return (CACHE.tasks || []).find(function (t) { return t.id === id; }) || null; }
    },
    taskMessages: {
      get: function () { return CACHE.taskMessages || []; },
      save: function (m) { CACHE.taskMessages = m || []; persist("taskMessages", CACHE.taskMessages); }
    },
    applications: {
      get: function () { return CACHE.applications || []; },
      save: function (a) { CACHE.applications = a || []; persist("applications", CACHE.applications); }
    },
    withdrawals: {
      get: function () { return CACHE.withdrawals || []; },
      save: function (w) { CACHE.withdrawals = w || []; persist("withdrawals", CACHE.withdrawals); }
    },
    paymentMethods: {
      defaults: [
        { id: "mpesa", name: "M-Pesa", desc: "Kenya & Africa", icon: "fa-solid fa-mobile-screen-button", connected: false },
        { id: "card", name: "Card", desc: "Visa, Mastercard", icon: "fa-solid fa-credit-card", connected: false },
        { id: "binance", name: "Binance", desc: "Crypto deposit", icon: "fa-solid fa-money-bill-transfer", connected: true }
      ],
      get: function () {
        var a = CACHE.paymentMethods || [];
        return a.length ? a : JSON.parse(JSON.stringify(LC.db.paymentMethods.defaults));
      },
      save: function (m) { CACHE.paymentMethods = m || []; persist("paymentMethods", CACHE.paymentMethods); }
    },
    paymentConfig: {
      get: function () { return Object.assign({ binanceAddress: "" }, PAYCONF); },
      save: async function (c) {
        PAYCONF = Object.assign({}, c);
        if (sb) await sb.from("payment_config").upsert({ id: "main", binance_address: c.binanceAddress || "" }, { onConflict: "id" });
      }
    },
    payments: {
      get: function () { return CACHE.payments || []; },
      save: function (p) { CACHE.payments = p || []; persist("payments", CACHE.payments); }
    },
    config: {
      get: function () {
        var base = LC.config.cloudinary || {};
        var saved = SETTINGS.cloudinary || {};
        var merged = Object.assign({}, base, saved);
        if (!merged.cloudName || String(merged.cloudName).indexOf("YOUR") === 0) merged.cloudName = base.cloudName;
        if (!merged.uploadPreset || String(merged.uploadPreset).indexOf("YOUR") === 0) merged.uploadPreset = base.uploadPreset;
        return merged;
      },
      save: function (c) { LC.db.setSetting("cloudinary", c); }
    },
    pricing: {
      defaults: { pro: "4.99", proplus: "9.99" },
      get: function () { return Object.assign({}, LC.db.pricing.defaults, SETTINGS.pricing || {}); },
      save: function (p) { LC.db.setSetting("pricing", p); }
    },
    mpesa: {
      defaults: { baseUrl: (LC.config.mpesa && LC.config.mpesa.baseUrl) || "" },
      get: function () { return Object.assign({}, LC.db.mpesa.defaults, SETTINGS.mpesa || {}); },
      save: function (c) { LC.db.setSetting("mpesa", c); }
    },
    email: {
      defaults: { baseUrl: (LC.config.email && LC.config.email.baseUrl) || "" },
      get: function () {
        var cfg = Object.assign({}, LC.db.email.defaults, SETTINGS.email || {});
        if (!cfg.baseUrl) {
          var m = LC.db.mpesa.get();
          if (m && m.baseUrl) cfg.baseUrl = m.baseUrl;
        }
        return cfg;
      },
      save: function (c) { LC.db.setSetting("email", c); }
    },
    aiConfig: {
      defaults: AI_CONFIG_DEFAULT,
      get: function () { return Object.assign({}, AI_CONFIG_DEFAULT, SETTINGS.ai_config || {}); },
      save: function (c) { LC.db.setSetting("ai_config", c); }
    },
    aiKb: {
      defaults: AI_KB_DEFAULT,
      get: function () {
        if (SETTINGS.ai_kb_version !== AI_KB_VERSION) {
          var fresh = JSON.parse(JSON.stringify(AI_KB_DEFAULT));
          SETTINGS.ai_kb = fresh;
          SETTINGS.ai_kb_version = AI_KB_VERSION;
          LC.db.setSetting("ai_kb", fresh);
          LC.db.setSetting("ai_kb_version", AI_KB_VERSION);
          return fresh;
        }
        return (SETTINGS.ai_kb && Array.isArray(SETTINGS.ai_kb) && SETTINGS.ai_kb.length) ? SETTINGS.ai_kb : AI_KB_DEFAULT;
      },
      save: function (k) {
        SETTINGS.ai_kb_version = AI_KB_VERSION;
        LC.db.setSetting("ai_kb", k);
        LC.db.setSetting("ai_kb_version", AI_KB_VERSION);
      }
    },
    admin: {
      get: function () { return (CACHE.users || []).find(function (u) { return u.role === "admin"; }) || null; },
      save: function () {}
    },
    seeded: {
      get: function () { return (CACHE.users || []).length > 0 || (CACHE.profiles || []).length > 0; },
      save: function () {}
    },
    session: {
      get: function () {
        var tok = LC.auth.getToken();
        if (!tok) return null;
        var s = (CACHE.sessions || []).find(function (x) { return x.id === tok; });
        if (s) LC.auth.keepAlive(tok);
        return s ? { id: s.userId, type: s.userType } : null;
      },
      save: async function (sess) {
        if (!sess || !sess.id) {
          var old = LC.auth.getToken();
          LC.auth.clearToken();
          idbDel("snapshot");               // never leave one person's chats on a shared device
          // Logging out must always work, even if the network call fails.
          try { if (old && sb) await sb.from("sessions").delete().eq("id", old); } catch (e) { /* ignore */ }
          if (sb && sb.auth) { try { await sb.auth.signOut(); } catch (e) { /* ignore */ } }
          return null;
        }
        var token = LC.db.uid();
        if (sb) await sb.from("sessions").upsert({ id: token, user_id: sess.id, user_type: sess.type || "user", created_at: Date.now() }, { onConflict: "id" });
        CACHE.sessions = CACHE.sessions || [];
        CACHE.sessions.push({ id: token, userId: sess.id, userType: sess.type || "user", createdAt: Date.now() });
        LC.auth.setToken(token);
        return { id: sess.id, type: sess.type };
      }
    }
  };

  /* ---------------- auth (cookie token, session lives in Supabase) ---------------- */

  LC.auth = {
    cookieName: "lc_session",
    // Persistent login: the token lives in a long-lived cookie AND localStorage, so if
    // the browser/PWA drops one of them the other restores it. It is only removed by logout.
    getToken: function () {
      var m = document.cookie.match(/(?:^|;\s*)lc_session=([^;]*)/);
      if (m) return decodeURIComponent(m[1]);
      try {
        var t = localStorage.getItem("lc_session");
        if (t) { LC.auth.setToken(t); return t; }
      } catch (e) {}
      return null;
    },
    setToken: function (t) {
      // 400 days is the maximum lifetime browsers allow for a cookie
      document.cookie = "lc_session=" + encodeURIComponent(t) + "; path=/; max-age=" + (60 * 60 * 24 * 400) + "; SameSite=Lax";
      try { localStorage.setItem("lc_session", t); } catch (e) {}
    },
    clearToken: function () {
      document.cookie = "lc_session=; path=/; max-age=0; SameSite=Lax";
      try { localStorage.removeItem("lc_session"); } catch (e) {}
    },
    // Once per page load, push the cookie expiry forward so active users never expire.
    keepAlive: function (t) {
      if (LC.auth._kept) return;
      LC.auth._kept = true;
      LC.auth.setToken(t);
    },
    // Cheap synchronous check: is there anything that could be a saved login?
    hasHint: function () {
      try {
        if (/(?:^|;\s*)lc_session=/.test(document.cookie)) return true;
        if (localStorage.getItem("lc_session")) return true;
        for (var i = 0; i < localStorage.length; i++) {
          if (/^sb-.+-auth-token$/.test(localStorage.key(i))) return true;
        }
      } catch (e) {}
      return false;
    },
    // Verify a saved login and return the user row (or null). Used by the landing,
    // login and signup pages to send logged-in people straight into the app.
    autoLogin: async function (extraKeys) {
      try {
        await LC.db.init(["users", "sessions"].concat(extraKeys || []));
        var s = LC.db.session.get();
        var u = s && s.type === "user" ? LC.db.users.byId(s.id) : null;
        if (!u) u = await LC.auth.restoreSession();
        return u || null;
      } catch (e) { return null; }
    },
    home: function (u) { return u && u.role === "admin" ? "admin.html" : "app.html"; },
    // "Back" at the root screen: leave the app WITHOUT logging out. nav.js has already
    // used up its history buffer entry, so one more history.back() is the native exit
    // (closes the installed PWA, or returns to the previous page in a browser tab).
    exitApp: function () {
      try { window.close(); } catch (e) {}
      setTimeout(function () { if (!document.hidden) { try { history.back(); } catch (e) {} } }, 200);
    },

    // Pull the logged-in Supabase Auth user into the app's `users` table so the
    // rest of the app (conversations, members, admin) keeps working unchanged.
    // Returns the custom user row, or null when no Supabase session is active.
    syncSupabaseSession: async function () {
      if (!sb || !sb.auth) return null;
      var got = await sb.auth.getSession();
      var sa = got && got.data ? got.data.session : null;
      if (!sa || !sa.user) return null;

      var users = CACHE.users || [];
      var meta = sa.user.user_metadata || {};
      var u = users.find(function (x) { return x.email === sa.user.email; });
      if (!u) {
        var email = (sa.user.email || "").toLowerCase();
        var name = meta.fullName || meta.full_name || meta.name || meta.username || (email.split("@")[0]) || "User";
        u = {
          id: sa.user.id,
          username: String(meta.username || (email.split("@")[0]) || "user").toLowerCase().slice(0, 20),
          fullName: name,
          age: parseInt(meta.age, 10) || 21,
          gender: meta.gender || "Prefer not to say",
          email: email,
          password: "supabase",
          about: "",
          avatar: meta.avatar || meta.avatar_url || meta.picture || LC.avatar.make(name),
          bio: "",
          online: true,
          listed: false,
          listedAt: null,
          lastActive: Date.now(),
          plan: "free",
          balance: 0,
          role: email === LC.config.adminDefault.email ? "admin" : "user",
          msgQuota: null,
          createdAt: Date.now()
        };
        users.push(u);
        LC.db.users.save(users);
      } else {
        u.online = true;
        u.lastActive = Date.now();
        LC.db.users.save(users);
      }
      return u;
    },

    // If there is a persisted Supabase Auth session, restore the app session.
    // Returns the custom user row or null.
    restoreSession: async function () {
      var u = await LC.auth.syncSupabaseSession();
      if (!u) return null;
      await LC.db.session.save({ id: u.id, type: "user" });
      return u;
    }
  };

  /* ---------------- legacy rt / avatar / fmt helpers ---------------- */

  LC.rt = {
    ch: (function () {
      try {
        if (typeof BroadcastChannel !== "undefined") return new BroadcastChannel("lonely_chat");
      } catch (e) {}
      return null;
    })(),
    emit: function (data) { try { if (this.ch) this.ch.postMessage(data || {}); } catch (e) {} },
    on: function (cb) { this._cb = cb; if (this.ch) this.ch.onmessage = function (e) { cb(e.data || {}); }; },
    local: function (data) { try { if (this._cb) this._cb(data || {}); } catch (e) {} }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("online", function () {
      try { LC.db.setupRealtime(); } catch (e) {}
      LC.db.flush().then(function () { return LC.db.refresh(["messages", "notifications"]); }).then(function () {
        LC.rt.local({ type: "rt" });
      }).catch(function () {});
    });
  }

  LC.convKey = function (a, b) {
    return "conv_" + [a.type + ":" + a.id, b.type + ":" + b.id].sort().join("|");
  };

  LC.convFrom = function (key) {
    var parts = key.replace("conv_", "").split("|").map(function (p) {
      var i = p.indexOf(":");
      return { type: p.slice(0, i), id: p.slice(i + 1) };
    });
    return { a: parts[0], b: parts[1] };
  };

  LC.entity = {
    get: function (ref) {
      if (ref.type === "user") return LC.db.users.byId(ref.id);
      if (ref.type === "profile") return LC.db.profiles.byId(ref.id);
      return null;
    }
  };

  LC.notify = function (recipient, from, kind, text) {
    var n = LC.db.notifications.get();
    n.unshift({ id: LC.db.uid(), recipient: { id: recipient.id, type: recipient.type }, from: { id: from.id, type: from.type, name: from.name, avatar: from.avatar }, kind: kind, text: text, ts: Date.now(), read: false });
    LC.db.notifications.save(n);
    LC.rt.emit({ type: "notify" });
  };

  LC.TASK_CATEGORIES = ["Therapy Companion", "Advice", "Chat Buddy", "Emotional Support", "Life Coaching", "Wellness Check-in"];

  /* ---------------- seeding (matches schema.sql) ---------------- */

  LC.seedAll = async function () {
    if (!sb) return;
    var admin = {
      id: "admin", username: "admin", fullName: "Hearth Admin", age: 30, gender: "Prefer not to say",
      email: "phidaliskipyego@gmail.com", password: "Phid@3630", about: "", avatar: "", bio: "",
      online: false, listed: false, listedAt: null, lastActive: null, plan: "free", balance: 0, role: "admin", msgQuota: null, createdAt: 0
    };
    var profiles = [
      { id: "p_maya", username: "maya", fullName: "Maya Brooks", age: 24, gender: "Female", email: "maya@hearth.chat", about: "Psychology student & listener. I'm here for your bad days and your good ones.", avatar: "https://randomuser.me/api/portraits/women/68.jpg", online: true },
      { id: "p_lucas", username: "lucas", fullName: "Lucas Chen", age: 27, gender: "Male", email: "lucas@hearth.chat", about: "Night owl. Ask me about music, books, or just tell me how your day went.", avatar: "https://randomuser.me/api/portraits/men/32.jpg", online: false },
      { id: "p_sofia", username: "sofia", fullName: "Sofia Reyes", age: 22, gender: "Female", email: "sofia@hearth.chat", about: "Coffee, poetry and long walks. Let's have a real conversation.", avatar: "https://randomuser.me/api/portraits/women/44.jpg", online: true },
      { id: "p_ethan", username: "ethan", fullName: "Ethan Park", age: 26, gender: "Male", email: "ethan@hearth.chat", about: "Quiet guy who loves deep talks. No small talk, please.", avatar: "https://randomuser.me/api/portraits/men/85.jpg", online: false },
      { id: "p_amara", username: "amara", fullName: "Amara Okafor", age: 25, gender: "Female", email: "amara@hearth.chat", about: "I believe everyone deserves to be heard. Talk to me.", avatar: "https://randomuser.me/api/portraits/women/26.jpg", online: true },
      { id: "p_noah", username: "noah", fullName: "Noah Williams", age: 28, gender: "Male", email: "noah@hearth.chat", about: "Gym, gaming and good company. I keep it real.", avatar: "https://randomuser.me/api/portraits/men/14.jpg", online: false },
      { id: "p_lily", username: "lily", fullName: "Lily Nguyen", age: 23, gender: "Female", email: "lily@hearth.chat", about: "Art student. I'll draw things while you talk.", avatar: "https://randomuser.me/api/portraits/women/21.jpg", online: true },
      { id: "p_omar", username: "omar", fullName: "Omar Hassan", age: 24, gender: "Male", email: "omar@hearth.chat", about: "Here to listen without judgment. Your secrets are safe with me.", avatar: "https://randomuser.me/api/portraits/men/44.jpg", online: false }
    ].map(function (p, i) {
      return { id: p.id, username: p.username, fullName: p.fullName, age: p.age, gender: p.gender, email: p.email, password: "profile123", about: p.about, avatar: p.avatar, bio: p.about, online: p.online, listed: true, listedAt: Date.now() - i * 3600000, lastActive: Date.now() - i * 3600000, createdAt: Date.now() };
    });
    var tasks = [
      { c: 0, r: 15, t: "Late-night talk", d: "They can't sleep and need someone to listen. Be a calm presence for a 30-minute conversation." },
      { c: 0, r: 20, t: "Therapy-style check-in", d: "Offer a supportive, judgment-free session. Ask how they've been and really listen." },
      { c: 1, r: 12, t: "Career advice", d: "They're stuck choosing between two paths. Help them think it through." },
      { c: 1, r: 10, t: "Breakup advice", d: "They just went through a breakup. Be kind, practical, and honest." },
      { c: 2, r: 8, t: "Buddy for the day", d: "Just friendly company and light conversation. Make them smile." },
      { c: 2, r: 9, t: "Gaming chat buddy", d: "They want to talk about games they love. Share the excitement." },
      { c: 3, r: 18, t: "Grief support", d: "They lost someone important. Sit with them in it — don't fix, just be present." },
      { c: 3, r: 16, t: "Anxiety companion", d: "They're anxious about the future. Help them ground themselves with gentle reassurance." },
      { c: 4, r: 22, t: "Goal-setting session", d: "They want a simple plan for the next month. Help them break one goal into steps." },
      { c: 4, r: 25, t: "Confidence coaching", d: "They doubt themselves before an interview. Build them up with real talk." },
      { c: 5, r: 11, t: "Morning check-ins", d: "A few encouraging messages across the day to help them stay steady." },
      { c: 5, r: 14, t: "Exercise accountability", d: "They want to start moving more. Cheer them on and keep them honest." }
    ].map(function (d, i) {
      var s = profiles[i % profiles.length];
      return { id: "t" + (i + 1), title: d.t, category: LC.TASK_CATEGORIES[d.c], description: d.d, reward: d.r, subject: { id: s.id, type: "profile", name: s.fullName, avatar: s.avatar }, status: "open", claimedBy: null, claimedAt: null, completedAt: null, createdAt: Date.now() - i * 3600000 };
    });

    await sb.from("users").upsert(toRow("users", admin), { onConflict: "id" });
    await sb.from("profiles").upsert(profiles.map(function (p) { return toRow("profiles", p); }), { onConflict: "id" });
    await sb.from("tasks").upsert(tasks.map(function (t) { return toRow("tasks", t); }), { onConflict: "id" });
    await sb.from("payment_methods").upsert(LC.db.paymentMethods.defaults.map(function (m) { return toRow("paymentMethods", m); }), { onConflict: "id" });
    await sb.from("payment_config").upsert({ id: "main", binance_address: "" }, { onConflict: "id" });
    await sb.from("settings").upsert([
      { key: "pricing", value: { pro: "4.99", proplus: "9.99" } },
      { key: "cloudinary", value: { cloudName: "dzylr1wkd", uploadPreset: "glowandflawless" } },
      { key: "ai_config", value: JSON.parse(JSON.stringify(AI_CONFIG_DEFAULT)) },
      { key: "ai_kb", value: JSON.parse(JSON.stringify(AI_KB_DEFAULT)) },
      { key: "ai_kb_version", value: AI_KB_VERSION }
    ], { onConflict: "key" });
  };

  LC.avatar = {
    colors: ["#7c6cd8", "#3fb57c", "#f2a33c", "#e2708a", "#4aa3c7", "#9b6bd8", "#5b8d9e", "#c77db0"],
    initials: function (name) {
      var parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
      var ini = ((parts[0] && parts[0][0]) || "") + (parts.length > 1 ? (parts[parts.length - 1][0] || "") : "");
      return (ini || "?").toUpperCase();
    },
    make: function (name) {
      var s = String(name || "?");
      var h = 0;
      for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      var c = this.colors[h % this.colors.length];
      var ini = this.initials(s);
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="' + c + '"/><text x="100" y="128" font-family="Segoe UI, Arial, sans-serif" font-size="76" font-weight="600" fill="#fff" text-anchor="middle">' + ini + '</text></svg>';
      return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
    },
    colorForSeed: function (i) { return this.colors[i % this.colors.length]; }
  };

  LC.fmt = {
    time: function (ts) {
      var d = new Date(ts), now = new Date();
      var sameDay = d.toDateString() === now.toDateString();
      var hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (sameDay) return hm;
      var yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
      if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    },
    ago: function (ts) {
      var s = Math.floor((Date.now() - ts) / 1000);
      if (s < 60) return "just now";
      var m = Math.floor(s / 60); if (m < 60) return m + "m ago";
      var h = Math.floor(m / 60); if (h < 24) return h + "h ago";
      var d = Math.floor(h / 24); if (d < 7) return d + "d ago";
      return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
    },
    day: function (ts) {
      var d = new Date(ts), now = new Date();
      var y = new Date(now); y.setDate(now.getDate() - 1);
      if (d.toDateString() === now.toDateString()) return "Today";
      if (d.toDateString() === y.toDateString()) return "Yesterday";
      return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    },
    esc: function (str) {
      return String(str == null ? "" : str)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
  };
})();
