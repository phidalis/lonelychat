window.LC = window.LC || {};

(function () {
  "use strict";

  var sb = LC.supabaseClient;
  var CACHE = {};      // key -> array of JS objects (in-memory snapshot)
  var SYNCED = {};     // key -> deep copy of last-persisted state (for diffing)
  var SETTINGS = {};   // settings table: key -> value
  var PAYCONF = {};    // payment_config row

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
      columns: ["id", "conv", "from_ref", "to_ref", "text", "image", "ts", "read"],
      renames: { from: "from_ref", to: "to_ref" }
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

  var AI_KB_DEFAULT = [
    { id: "kb_greeting", intent: "greeting", keywords: ["hello", "hi", "hey", "hiya", "howdy", "yo", "good morning", "good afternoon", "good evening", "sup", "greetings"], variations: [
      "Hey! So good to hear from you. How's your day going so far?",
      "Hi there! I was just thinking about you. How are you today?",
      "Hey hey! Your message just made my day. What's up?",
      "Hello! Thanks for reaching out. I'm really glad you did — how have you been?"
    ] },
    { id: "kb_how_are_you", intent: "how_are_you", keywords: ["how are you", "how you doing", "how's it going", "how are things", "how r u", "hru", "how ya doing", "how are you doing", "you ok", "you okay"], variations: [
      "I'm doing really well, thank you for asking! How about you?",
      "Pretty good actually — it's one of those calm, quiet days. What about you?",
      "Can't complain! I've been thinking a lot lately. How are you doing?",
      "I'm good, just taking it easy. But more importantly — how are you?"
    ] },
    { id: "kb_what_do_you_do", intent: "what_do_you_do", keywords: ["what do you do", "what do you work", "your job", "your work", "what are you studying", "your career", "what do you study", "what do you work as"], variations: [
      "I spend most of my time on {about}. And you — what fills your days?",
      "A little bit of everything, honestly. I love hearing about people more. What do you do?",
      "Honestly? {about}. But I'm way more interested in you — what do you love doing?"
    ] },
    { id: "kb_where_from", intent: "where_are_you_from", keywords: ["where are you from", "where do you live", "where are you based", "what country", "what city", "your location", "where you from"], variations: [
      "I'm from a pretty quiet corner of the world. What about you?",
      "I move around a lot, but home is wherever the good people are. Where are you from?",
      "That's a story for another day. Tell me where you're from!"
    ] },
    { id: "kb_age", intent: "age", keywords: ["how old are you", "your age", "how old", "what's your age"], variations: [
      "Haha, a lady never tells. How old are you?",
      "I'm in my twenties, if that counts. Your turn!",
      "Let's just say I was born in the 90s. What about you?"
    ] },
    { id: "kb_compliment", intent: "compliment", keywords: ["pretty", "beautiful", "handsome", "cute", "gorgeous", "lovely", "amazing", "stunning", "wonderful"], variations: [
      "You're making me blush! Thank you, that's really sweet.",
      "Aww, that's kind of you to say. I like how thoughtful you are.",
      "Careful — you'll make me smile all day. Thank you!"
    ] },
    { id: "kb_thanks", intent: "thanks", keywords: ["thank you", "thanks", "thank u", "appreciate it", "thx", "much appreciated"], variations: [
      "Anytime! That's what I'm here for.",
      "You're welcome. I meant every word.",
      "Of course! It was my pleasure, honestly."
    ] },
    { id: "kb_bye", intent: "bye", keywords: ["bye", "goodbye", "good night", "goodnight", "gotta go", "see you", "later", "ttyl", "gtg", "have to go", "going to sleep"], variations: [
      "Aww, okay! It was lovely talking to you. Come back soon.",
      "Alright, take care of yourself. Message me anytime you need a chat.",
      "Goodnight! I hope you dream about something nice.",
      "See you soon. I'll be right here whenever you want to talk."
    ] },
    { id: "kb_weather", intent: "weather", keywords: ["weather", "rain", "raining", "sunny", "hot today", "cold", "freezing", "forecast", "outside"], variations: [
      "It's been raining here on and off. I love the sound of it, honestly. How's the weather where you are?",
      "Sunny but breezy — perfect for a long walk. What's it like on your side?",
      "I've barely left the house today. Tell me about the weather there!"
    ] },
    { id: "kb_bored", intent: "bored", keywords: ["bored", "boring", "nothing to do", "lonely", "alone", "sad", "down", "depressed", "tired of everything", "no one to talk to"], variations: [
      "Bored? Well, now you have me to talk to. What's on your mind?",
      "I get that feeling. But your message just made my evening better — what's going on?",
      "Let's fix that! Tell me something about you — anything at all.",
      "That sounds heavy. Do you want a light distraction or a proper deep chat?"
    ] },
    { id: "kb_how_was_day", intent: "how_was_day", keywords: ["how was your day", "how's your day", "how did your day go", "how was today", "how's today been"], variations: [
      "It was okay, a little quiet. But talking to you is already the best part of it.",
      "Pretty steady! A few small wins. How did your day go?",
      "Busy but good. I was honestly hoping you'd message. What about yours?"
    ] },
    { id: "kb_hobbies", intent: "hobbies", keywords: ["hobby", "hobbies", "what do you like", "your interests", "music", "movies", "books", "games", "gaming", "sports", "what are you into"], variations: [
      "I love a good book and long talks. What do you do for fun?",
      "Music, long walks and great conversations. What's your thing?",
      "I've got a few little hobbies, but I'd rather hear about yours first."
    ] },
    { id: "kb_relationship", intent: "relationship", keywords: ["single", "boyfriend", "girlfriend", "dating", "relationship", "love", "crush", "married", "partner", "do you have a"], variations: [
      "I'm single and just taking things one day at a time. What about you?",
      "No one special right now — but I do love meeting interesting people. Like you.",
      "That's a loaded question! Why do you ask?"
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

  function toRow(key, obj) {
    var cfg = CONFIGS[key];
    var dbToJs = invert(cfg.renames);
    var row = {};
    cfg.columns.forEach(function (col) {
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

  function deepCopy(v) {
    try { return JSON.parse(JSON.stringify(v)); }
    catch (e) { return Array.isArray(v) ? v.slice() : v; }
  }

  async function loadTable(key) {
    var cfg = CONFIGS[key];
    if (!cfg) return;
    if (!sb) return;
    var res = await sb.from(cfg.table).select("*");
    if (res.error) { console.error("load " + key, res.error); return; }
    CACHE[key] = (res.data || []).map(function (r) { return fromRow(key, r); });
    SYNCED[key] = deepCopy(CACHE[key]);
  }

  async function loadSettings() {
    if (!sb) return;
    var res = await sb.from("settings").select("*");
    SETTINGS = {};
    (res.data || []).forEach(function (r) { SETTINGS[r.key] = r.value; });
  }

  async function loadPayConf() {
    if (!sb) return;
    var res = await sb.from("payment_config").select("*").eq("id", "main").maybeSingle();
    PAYCONF = res.data ? { binanceAddress: res.data.binance_address || "" } : { binanceAddress: "" };
  }

  async function persist(key, arr) {
    var cfg = CONFIGS[key];
    if (!cfg || !sb) return;
    var prev = SYNCED[key] || [];
    var prevMap = {};
    prev.forEach(function (r) { prevMap[r.id] = r; });
    var ids = {};
    var upserts = [];
    (arr || []).forEach(function (o) {
      if (!o || o.id === undefined) return;
      ids[o.id] = true;
      var row = toRow(key, o);
      var before = prevMap[o.id];
      if (!before || JSON.stringify(before) !== JSON.stringify(row)) upserts.push(row);
    });
    var removals = prev.filter(function (r) { return !ids[r.id]; }).map(function (r) { return r.id; });
    if (upserts.length) {
      var up = await sb.from(cfg.table).upsert(upserts, { onConflict: "id" });
      if (up.error) console.error("upsert " + key, up.error);
    }
    if (removals.length) {
      var del = await sb.from(cfg.table).delete().in("id", removals);
      if (del.error) console.error("delete " + key, del.error);
    }
    SYNCED[key] = deepCopy(arr || []);
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
      await LC.db._load(keys);
      LC.db.setupRealtime();
      return true;
    },

    reload: async function () {
      await LC.db._load();
    },

    // Silent re-fetch of specific tables from Supabase (no UI changes here).
    // Used by the pages to keep messages/conversations fresh in near real time.
    refresh: async function (keys) {
      if (!sb || !keys || !keys.length) return;
      await LC.db._load(keys);
    },

    setupRealtime: function () {
      if (!sb || LC.db._rtSetup) return;
      LC.db._rtSetup = true;
      try {
        var ch = sb.channel("lc-live-" + Math.random().toString(36).slice(2, 8));
        Object.keys(CONFIGS).forEach(function (key) {
          var table = CONFIGS[key].table;
          ch.on("postgres_changes", { event: "*", schema: "public", table: table }, function () {
            loadTable(key).then(function () { LC.rt.emit({ type: "rt" }); });
          });
        });
        ch.subscribe();
      } catch (e) { console.error("realtime", e); }
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
    aiConfig: {
      defaults: AI_CONFIG_DEFAULT,
      get: function () { return Object.assign({}, AI_CONFIG_DEFAULT, SETTINGS.ai_config || {}); },
      save: function (c) { LC.db.setSetting("ai_config", c); }
    },
    aiKb: {
      defaults: AI_KB_DEFAULT,
      get: function () { return (SETTINGS.ai_kb && Array.isArray(SETTINGS.ai_kb) && SETTINGS.ai_kb.length) ? SETTINGS.ai_kb : AI_KB_DEFAULT; },
      save: function (k) { LC.db.setSetting("ai_kb", k); }
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
        return s ? { id: s.userId, type: s.userType } : null;
      },
      save: async function (sess) {
        if (!sess || !sess.id) {
          var old = LC.auth.getToken();
          LC.auth.clearToken();
          if (old && sb) await sb.from("sessions").delete().eq("id", old);
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
    getToken: function () {
      var m = document.cookie.match(/(?:^|;\s*)lc_session=([^;]*)/);
      return m ? decodeURIComponent(m[1]) : null;
    },
    setToken: function (t) {
      document.cookie = "lc_session=" + encodeURIComponent(t) + "; path=/; max-age=" + (60 * 60 * 24 * 90) + "; SameSite=Lax";
    },
    clearToken: function () {
      document.cookie = "lc_session=; path=/; max-age=0; SameSite=Lax";
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
    on: function (cb) { if (this.ch) this.ch.onmessage = function (e) { cb(e.data || {}); }; }
  };

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
      { key: "ai_kb", value: JSON.parse(JSON.stringify(AI_KB_DEFAULT)) }
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
