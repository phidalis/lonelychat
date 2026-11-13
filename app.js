(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let me = null;
  let currentView = "discover";
  let activeConv = null;   // { key, other }
  let discoverSearch = "";
  let genderFilter = "";
  let seenNotifIds = null;

  // Message tools state
  let composer = { replyTo: null, editId: null, beforeEdit: "" };
  let menuMsgId = null;
  let menuConvKey = null;
  let typingTimer = null;
  const TYPING_START_MS = 5000; // read/think pause before the typing bubble appears
  const TYPING_MAX_MS = 40000;
  const REACTIONS = ["\uD83D\uDC4D", "\u2764\uFE0F", "\uD83D\uDE02", "\uD83D\uDE2E", "\uD83D\uDE22", "\uD83D\uDE4F"];
  // Used by linkifyText: bare domains are only turned into links when the last
  // label is a real generic domain ending (or a 2-letter country code) and is
  // not a filename extension such as .js / .pdf / .png.
  const LINK_GTLDS = new Set(("com org net edu gov mil int info biz name pro mobi asia app dev page tech online site website " +
    "store shop blog news media agency studio design digital email cloud host space world life live today club group company " +
    "solutions services systems network software codes game games fun art photo photos video music audio film tv radio health " +
    "care clinic dental doctor hospital pharmacy law legal finance financial bank money capital invest insurance realestate " +
    "properties rentals construction builders plumbing electrician cleaning repair auto cars motorcycle bikes travel tours flights " +
    "hotel restaurant cafe food recipes fitness gym yoga coach education school university academy courses training church charity " +
    "foundation community social dating family kids toys fashion shoes jewelry beauty salon spa wedding events party gifts flowers " +
    "photography graphics marketing advertising consulting management enterprise business ventures holdings partners associates " +
    "tax credit loans mortgage exchange trade market deals discount coupons sale auction shopping delivery logistics transport " +
    "shipping farm agriculture garden land eco green energy solar power water city town village house home apartments estate wiki " +
    "xyz top buzz click link one run win bid download review reviews support help center centre direct global international africa " +
    "kenya nairobi uganda tanzania rwanda nigeria ghana southafrica").split(/\s+/));
  const LINK_FILE_EXTS = new Set(("js ts jsx tsx css scss sass less html htm xhtml xml json jsonp txt md markdown pdf png jpg " +
    "jpeg gif svg webp bmp tif tiff ico mp3 mp4 m4a wav ogg flac avi mov mkv webm zip rar gz tar bz2 7z exe msi apk ipa dmg iso " +
    "bin csv tsv xls xlsx doc docx ppt pptx odt ods psd eps log sql py rb php rs java class jar c cc h hpp cpp cs swift kt sh " +
    "bash zsh bat cmd ps1 env lock yml yaml toml ini cfg conf db sqlite bak tmp").split(/\s+/));

  /* ---------------- helpers ---------------- */

  function meRef() { return { id: me.id, type: "user", name: me.fullName, avatar: me.avatar }; }

  /* ---------------- rewards & chat tracking ---------------- */

  const FOLLOW_DAILY_LIMIT = 20;
  let chatSaveAt = 0;

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function saveUser(u) {
    const users = LC.db.users.get();
    const i = users.findIndex(x => x.id === u.id);
    if (i >= 0) users[i] = u; else users.push(u);
    LC.db.users.save(users);
  }

  function currentUser() {
    const u = LC.db.users.byId(me.id) || me;
    me = u;
    return u;
  }

  function rewardState(u) { return LC.db.rewards.ensureChatDay(u || currentUser()); }

  function fmtDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }

  function chatTimeEligible() {
    return !!(me && currentView === "messages" && activeConv && activeConv.other &&
      activeConv.other.type === "profile" && !document.hidden);
  }

  function persistChatProgress(force) {
    if (!me) return;
    const now = Date.now();
    if (!force && now - chatSaveAt < 20000) return;
    chatSaveAt = now;
    saveUser(currentUser());
  }

  function tickChatTime() {
    if (!chatTimeEligible()) return;
    const u = currentUser();
    const st = LC.db.rewards.ensureChatDay(u);
    if (st.dayClaimed) return;
    st.chatSeconds += 1;
    const cfg = LC.db.rewards.get();
    const need = Math.max(1, Number(cfg.minChatMinutes) || 20) * 60;
    if (st.chatSeconds >= need) {
      st.dayClaimed = true;
      const pts = Math.max(0, Math.round(Number(cfg.dailyChatPoints) || 0));
      st.points += pts;
      LC.db.rewards.setState(u, st);
      saveUser(u);
      toast("Daily chat goal reached — " + pts + " points added.");
      banner("fa-coins", "You earned " + pts + " points", "Keep chatting with profiles; your next reward unlocks tomorrow.", () => { showView("profile"); openProfileSection("rewards"); });
    } else {
      LC.db.rewards.setState(u, st);
      persistChatProgress(false);
    }
    const section = $("#pf-sec-rewards");
    if (section && !section.classList.contains("hidden")) updateRewardProgress();
    const badge = $("#pf-menu-points");
    if (badge) badge.textContent = Math.round(LC.db.rewards.state(u).points).toLocaleString() + " pts";
  }

  function avatarFor(entity, blurred) {
    const src = entity.avatar || LC.avatar.make(entity.fullName || entity.name || "?");
    return '<img class="avatar' + (blurred ? " blurred" : "") + '" src="' + LC.fmt.esc(src) + '" alt="" onerror="this.src=\'' + LC.avatar.make("?") + '\'">';
  }

  function setHtml(el, html) {
    if (el._lcHtml === html) return;
    el._lcHtml = html;
    el.innerHTML = html;
  }

  function toast(msg, type) {
    const wrap = $("#toasts");
    const t = document.createElement("div");
    t.className = "toast" + (type ? " " + type : "");
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.remove(); }, 3200);
  }

  function banner(icon, title, sub, onClick) {
    const wrap = $("#toasts");
    const t = document.createElement("div");
    t.className = "toast banner";
    t.innerHTML = '<span class="banner-ico"><i class="fa-solid ' + icon + '"></i></span>' +
      '<span class="banner-body"><b>' + LC.fmt.esc(title) + '</b><small>' + LC.fmt.esc(sub) + '</small></span>';
    t.onclick = () => { try { onClick(); } catch (e) {} t.remove(); };
    wrap.appendChild(t);
    setTimeout(() => { t.remove(); }, 4200);
  }

  function isFollowing(target) {
    return LC.db.follows.exists(meRef(), { id: target.id, type: target.type });
  }

  function followsMe(ent) {
    return LC.db.follows.exists({ id: ent.id, type: ent.type }, meRef());
  }

  // Follows made today. Counted from both a saved counter and today's follow records,
  // so unfollowing doesn't hand the allowance back.
  function followsUsedToday(follows) {
    const today = todayKey();
    const q = me.followQuota;
    const fromQuota = q && q.date === today ? q.used : 0;
    const fromRecords = follows.filter(f =>
      f.follower.type === "user" && f.follower.id === me.id && f.ts &&
      new Date(f.ts).toISOString().slice(0, 10) === today).length;
    return Math.max(fromQuota, fromRecords);
  }

  function toggleFollow(target) {
    const tRef = { id: target.id, type: target.type, name: target.fullName || target.name, avatar: target.avatar };
    const mRef = meRef();
    const follows = LC.db.follows.get();
    const existing = follows.find(f =>
      f.follower.id === mRef.id && f.follower.type === "user" &&
      f.target.id === tRef.id && f.target.type === tRef.type);
    if (existing) {
      LC.db.follows.save(follows.filter(f => f.id !== existing.id));
      toast("You unfollowed " + tRef.name);
    } else {
      const used = followsUsedToday(follows);
      if (used >= FOLLOW_DAILY_LIMIT) {
        toast("Daily limit reached: you can follow up to " + FOLLOW_DAILY_LIMIT + " people per day. Try again tomorrow.", "error");
        return;
      }
      me.followQuota = { date: todayKey(), used: used + 1 };
      saveUser(me);
      follows.push({ id: LC.db.uid(), follower: mRef, target: tRef, ts: Date.now() });
      LC.db.follows.save(follows);
      LC.notify(tRef, mRef, "follow", mRef.name + " followed you");
      LC.rt.emit({ type: "follow" });
      toast("You followed " + tRef.name);
    }
    renderDiscover();
  }

  /* ---------------- unread counts ---------------- */

  function unreadCounts() {
    const msgs = LC.db.messages.get();
    let convUnread = 0;
    const perConv = {};
    msgs.forEach(m => {
      if (m.to.type === "user" && m.to.id === me.id && !m.read) {
        convUnread++;
        perConv[m.conv] = (perConv[m.conv] || 0) + 1;
      }
    });
    const notifs = LC.db.notifications.get().filter(n =>
      n.recipient.type === "user" && n.recipient.id === me.id && n.kind !== "message" && !n.read).length;
    return { convUnread, perConv, notifs };
  }

  function renderBadges() {
    const c = unreadCounts();
    [["nav-msg-badge", c.convUnread], ["nav-notif-badge", c.notifs],
     ["mb-messages", c.convUnread], ["mb-notifications", c.notifs]].forEach(([id, n]) => {
      const el = $("#" + id);
      if (el) { el.classList.toggle("hidden", n === 0); el.textContent = n; }
    });
  }

  /* ---------------- discover ---------------- */

  // Random order, fixed per page load: new on every login/refresh, but stable
  // while the user searches, follows or receives realtime updates.
  const discoverRank = new Map();
  function rankOf(e) {
    const k = e.type + ":" + e.id;
    if (!discoverRank.has(k)) discoverRank.set(k, Math.random());
    return discoverRank.get(k);
  }

  function discoverEntities() {
    const all = [];
    LC.db.profiles.get().filter(p => p.listed === true).forEach(p => all.push({ type: "profile", ...p }));
    LC.db.users.get().filter(u => u.id !== me.id && u.listed === true).forEach(u => all.push({ type: "user", ...u }));
    const q = discoverSearch.toLowerCase();
    return all.filter(e => {
      if (genderFilter && e.gender !== genderFilter) return false;
      if (!q) return true;
      return (e.fullName + " " + e.username + " " + (e.about || "")).toLowerCase().includes(q);
    }).sort((a, b) => rankOf(a) - rankOf(b));
  }

  function renderDiscover() {
    const grid = $("#discover-grid");
    const list = discoverEntities();

    if (!list.length) {
      setHtml(grid, '<div class="empty"><div class="big"><i class="fa-solid fa-magnifying-glass"></i></div><p>No matches. Try a different search.</p></div>');
      return;
    }

    setHtml(grid, list.map((e, i) => {
      const following = isFollowing(e);
      const followsYou = followsMe(e);
      const msgBtn = '<button class="btn btn-primary btn-sm" data-action="msg" data-id="' + e.type + ":" + e.id + '">Message</button>';
      const followBtn = following
        ? '<button class="btn btn-ghost btn-sm" data-action="unfollow" data-id="' + e.type + ":" + e.id + '"><i class="fa-solid fa-check"></i> Following</button>'
        : '<button class="btn btn-outline btn-sm" data-action="follow" data-id="' + e.type + ":" + e.id + '">+ Follow</button>';
      return '<div class="profile-card" style="animation-delay:' + (i * 30) + 'ms">' +
        (followsYou ? '<span class="follows-you">Follows you</span>' : "") +
        '<div class="avatar-wrap">' +
        avatarFor(e) +
        (e.online ? '<span class="online-dot"></span>' : "") +
        '</div>' +
        '<div class="pc-name">' + LC.fmt.esc(e.fullName) + '</div>' +
        '<div class="pc-sub">@' + LC.fmt.esc(e.username) + '</div>' +
        '<div class="pc-chips">' +
        '<span class="pc-chip">' + LC.fmt.esc(e.age) + '</span>' +
        '<span class="pc-chip">' + LC.fmt.esc(e.gender) + '</span>' +
        '</div>' +
        '<p class="pc-about">' + LC.fmt.esc(e.about || "Just here to talk.") + '</p>' +
        '<div class="pc-actions">' + msgBtn + followBtn + '</div>' +
        '</div>';
    }).join(""));
  }

  function onDiscoverAction(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const [type, id] = btn.dataset.id.split(":");
    const ent = type === "profile" ? LC.db.profiles.byId(id) : LC.db.users.byId(id);
    if (!ent) return;
    // byId() returns the raw record, which has no "type" - pass it in so the follow
    // and its admin notification are saved against "profile" / "user" correctly.
    if (btn.dataset.action === "follow" || btn.dataset.action === "unfollow") toggleFollow({ ...ent, type });
    else {
      openConversation({ id: ent.id, type, name: ent.fullName, avatar: ent.avatar });
    }
  }

  /* ---------------- conversations & chat ---------------- */

  // Messages just sent from this device. They are shown immediately and kept until the
  // server copy comes back, so a background refresh can't make them (or a brand-new
  // conversation) disappear until a manual reload.
  const pendingMsgs = new Map();
  function allMessages() {
    const msgs = LC.db.messages.get();
    if (!pendingMsgs.size) return msgs;
    const ids = new Set(msgs.map(m => m.id));
    const extra = [];
    pendingMsgs.forEach((m, id) => {
      if (ids.has(id) || Date.now() - m.ts > 60000) pendingMsgs.delete(id);
      else extra.push(m);
    });
    return extra.length ? msgs.concat(extra) : msgs;
  }

  function myConversations() {
    const msgs = allMessages();
    const byConv = {};
    msgs.forEach(m => {
      const involved = m.from.type === "user" && m.from.id === me.id;
      const received = m.to.type === "user" && m.to.id === me.id;
      if (!involved && !received) return;
      byConv[m.conv] = byConv[m.conv] || { key: m.conv, msgs: [], last: 0, unread: 0 };
      byConv[m.conv].msgs.push(m);
      byConv[m.conv].last = Math.max(byConv[m.conv].last, m.ts);
      if (received && !m.read) byConv[m.conv].unread++;
    });
    return Object.values(byConv).sort((a, b) => b.last - a.last);
  }

  function convPeer(conv) {
    const { a, b } = LC.convFrom(conv);
    const meType = "user";
    const peer = (a.type === meType && a.id === me.id) ? b : a;
    const ent = LC.entity.get(peer);
    return { id: peer.id, type: peer.type, name: (ent && (ent.fullName || ent.name)) || "User", avatar: ent && ent.avatar };
  }

  function renderConversationList() {
    renderConversationList2(myConversations());
  }

  function renderConversationList2(convs) {
    const el = $("#conv-list");
    const html = convs.map(cv => {
      const key = cv.key;
      const peer = convPeer(key);
      const last = cv.msgs[cv.msgs.length - 1];
      const preview = (last.image ? '<i class="fa-solid fa-image"></i> Photo' : last.text) || "";
      const time = LC.fmt.time(cv.last);
      return '<div class="conv-item' + (activeConv && activeConv.key === key ? " active" : "") + '" data-conv="' + key + '">' +
        avatarFor(peer) +
        '<div class="conv-meta">' +
        '<div class="conv-top"><span class="conv-name">' + LC.fmt.esc(peer.name) + '</span><span class="conv-time">' + time + '</span></div>' +
        '<div class="conv-preview">' + LC.fmt.esc(preview) + '</div>' +
        '</div>' +
        (cv.unread ? '<span class="unread-dot">' + cv.unread + '</span>' : "") +
        '<button type="button" class="conv-more" data-conv-menu="' + LC.fmt.esc(key) + '" title="Conversation options"><i class="fa-solid fa-ellipsis-vertical"></i></button>' +
        '</div>';
    }).join("");
    setHtml(el, html || '<div class="empty"><div class="big"><i class="fa-solid fa-comment-dots"></i></div><p style="margin-bottom:14px">No conversations yet.<br>Find someone kind and say hello.</p><button class="btn btn-primary btn-sm" data-action="go-discover"><i class="fa-solid fa-compass"></i> Discover people</button></div>');
  }

  // Hide the mobile tab bar while a conversation is open so the message box sits
  // right above the keyboard. The tab bar comes back on the conversation list.
  function syncChatChrome() {
    document.body.classList.toggle("chat-open", currentView === "messages" && !!activeConv);
    syncChatViewport();
  }

  // Keep the open chat exactly as tall as the visible area, so the message box
  // stays glued above the keyboard and does not move while scrolling messages.
  function syncChatViewport() {
    const root = document.documentElement;
    const vv = window.visualViewport;
    if (!vv || !document.body.classList.contains("chat-open")) {
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvt");
      return;
    }
    root.style.setProperty("--vvh", vv.height + "px");
    root.style.setProperty("--vvt", vv.offsetTop + "px");
    if (window.scrollY) window.scrollTo(0, 0);
    const ms = document.getElementById("msg-scroll");
    if (ms && document.activeElement && document.activeElement.id === "chat-input") ms.scrollTop = ms.scrollHeight;
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncChatViewport);
    window.visualViewport.addEventListener("scroll", syncChatViewport);
  }

  /* ---------------- back-button history (sections, open chat, profile pages) ---------------- */

  // Entries: "messages", "profile#rewards", "messages#chat:<type>:<id>"
  let navRestoring = false;   // true while the back button re-draws a screen (must not record it again)
  function navGo(entry) {
    if (!navRestoring && window.LC && LC.nav) LC.nav.go(entry);
  }
  function navTop() {
    return (window.LC && LC.nav && LC.nav.top && LC.nav.top()) || "";
  }
  // On-screen back buttons: step back through the same history as the phone's back button.
  function navBackOr(prefix, fallback) {
    if (navTop().indexOf(prefix) === 0 && LC.nav.back()) return;
    fallback();
  }
  function closeChat() {
    $("#chat-wrap").classList.remove("mobile-chat-open");
    activeConv = null;
    resetComposer();
    closeMsgMenu();
    renderChat();
    syncChatChrome();
  }
  function navRender(entry) {
    navRestoring = true;
    try {
      const i = entry.indexOf("#");
      const view = i < 0 ? entry : entry.slice(0, i);
      const sub = i < 0 ? "" : entry.slice(i + 1);
      showView(view, true);
      if (view === "messages") {
        if (sub.indexOf("chat:") === 0) {
          const parts = sub.split(":");
          const type = parts[1];
          const id = parts.slice(2).join(":");
          const ent = LC.entity.get({ type, id });
          if (ent) openConversation({ id, type, name: ent.fullName || ent.name || "User", avatar: ent.avatar });
          else if (activeConv) closeChat();
        } else if (activeConv) {
          closeChat();
        }
      }
      if (view === "profile") openProfileSection(sub);
    } finally {
      navRestoring = false;
    }
  }

  function openConversation(peer) {
    if (currentView !== "messages") showView("messages");
    const key = LC.convKey(meRef(), { id: peer.id, type: peer.type });
    activeConv = { key, other: peer };
    resetComposer();
    closeMsgMenu();
    navGo("messages#chat:" + peer.type + ":" + peer.id);
    markConvRead(key);
    renderChat();
    renderConversationList2(myConversations());
    $("#chat-wrap").classList.add("mobile-chat-open");
    syncChatChrome();
  }

  function markConvRead(key) {
    const msgs = LC.db.messages.get();
    let changed = false;
    msgs.forEach(m => { if (m.conv === key && m.to.type === "user" && m.to.id === me.id && !m.read) { m.read = true; changed = true; } });
    if (changed) { LC.db.messages.save(msgs); LC.rt.emit({ type: "read" }); }
  }

  function myRefKey() { return "user:" + me.id; }

  function parseReactions(v) {
    if (!v) return {};
    if (typeof v === "string") {
      try { v = JSON.parse(v); } catch (e) { return {}; }
    }
    if (!v || typeof v !== "object") return {};
    const out = {};
    Object.keys(v).forEach(k => { if (Array.isArray(v[k])) out[k] = v[k]; });
    return out;
  }

  function replyPreview(m) {
    if (!m) return "";
    return m.image ? "Photo" : (m.text || "");
  }

  // Escape a message and turn full URLs and bare domain names into tappable
  // links that open in the device's own browser.
  function linkifyText(text) {
    const src = String(text || "");
    const re = /(?:https?:\/\/|www\.)[^\s<]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{2,5})?(?:\/[^\s<]*)?/gi;
    let out = "", last = 0, m;
    const keepPlain = (end) => { out += LC.fmt.esc(src.slice(last, end)); last = end; };
    while ((m = re.exec(src))) {
      const match = m[0];
      const explicit = /^(?:https?:\/\/|www\.)/i.test(match);
      const before = m.index > 0 ? src.charAt(m.index - 1) : "";
      // Do not turn the domain part of an email into a link.
      if (/[a-z0-9@._-]/i.test(before)) { keepPlain(m.index + match.length); continue; }
      if (!explicit) {
        const host = match.split(/[/:]/)[0];
        const tldRaw = host.slice(host.lastIndexOf(".") + 1);
        // "Monday.Today" etc. shouldn't become a link; real domains are typed
        // with a lowercase ending. Bare domains need a known ending or a
        // 2-letter country code that isn't also a file extension.
        if (/[A-Z]/.test(tldRaw)) { keepPlain(m.index + match.length); continue; }
        const tld = tldRaw.toLowerCase();
        const known = tld.length === 2 ? !LINK_FILE_EXTS.has(tld) : LINK_GTLDS.has(tld);
        if (!known) { keepPlain(m.index + match.length); continue; }
      }
      out += LC.fmt.esc(src.slice(last, m.index));
      let url = match;
      let trail = "";
      const pairs = { ")": "(", "]": "[", "}": "{" };
      while (url.length > 1) {
        const ch = url.slice(-1);
        if (/[.,!?;:'"]/.test(ch)) { trail = ch + trail; url = url.slice(0, -1); continue; }
        const open = pairs[ch];
        if (open && url.split(ch).length > url.split(open).length) {
          trail = ch + trail; url = url.slice(0, -1); continue;
        }
        break;
      }
      const href = /^https?:\/\//i.test(url) ? url : "https://" + url;
      out += '<a class="msg-link" href="' + LC.fmt.esc(href) + '" target="_blank" rel="noopener noreferrer">' +
        LC.fmt.esc(url) + "</a>" + LC.fmt.esc(trail);
      last = m.index + match.length;
    }
    out += LC.fmt.esc(src.slice(last));
    return out;
  }

  function buildMessagesHtml(msgs, opts) {
    const tools = !opts || opts.tools !== false;
    const byId = {};
    msgs.forEach(m => { byId[m.id] = m; });
    let html = "";
    let lastDay = "";
    msgs.forEach(m => {
      const day = LC.fmt.day(m.ts);
      if (day !== lastDay) { html += '<div class="day-divider">' + day + '</div>'; lastDay = day; }
      const mine = m.from.type === "user" && m.from.id === me.id;
      const rep = m.replyTo ? byId[m.replyTo] : null;
      const reacts = parseReactions(m.reactions);
      const reactHtml = Object.keys(reacts).filter(e => (reacts[e] || []).length).map(e => {
        const on = reacts[e].indexOf(myRefKey()) >= 0;
        return '<button type="button" class="m-react' + (on ? " mine" : "") + '" data-react="' + LC.fmt.esc(e) + '" data-mid="' + LC.fmt.esc(m.id) + '" title="React ' + LC.fmt.esc(e) + '">' +
          e + ' <span>' + reacts[e].length + '</span></button>';
      }).join("");
      const replyHtml = rep
        ? '<span class="m-reply" data-jump="' + LC.fmt.esc(rep.id) + '"><b>' +
          LC.fmt.esc((rep.from.type === "user" && rep.from.id === me.id) ? "You" : (rep.from.name || "User")) +
          '</b><span>' + LC.fmt.esc(replyPreview(rep)) + '</span></span>'
        : "";
      html += '<div class="msg-row ' + (mine ? "me" : "other") + '" data-mid="' + LC.fmt.esc(m.id) + '">' +
        (mine ? "" : '<img class="m-avatar" src="' + LC.fmt.esc(m.from.avatar || LC.avatar.make(m.from.name)) + '" alt="" onerror="this.remove()">') +
        '<div class="msg-col">' +
        '<div class="msg">' +
        replyHtml +
        (m.image ? '<img class="m-img" src="' + LC.fmt.esc(m.image) + '" alt="">' : "") +
        (m.text ? linkifyText(m.text) : "") +
        '<span class="m-tail">' + LC.fmt.time(m.ts) + (m.edited ? " \u00b7 edited" : "") + '</span>' +
        '</div>' +
        (reactHtml ? '<div class="m-reacts">' + reactHtml + '</div>' : "") +
        '</div>' +
        (tools ? '<button type="button" class="msg-quick" data-msg-open="' + LC.fmt.esc(m.id) + '" title="Message options"><i class="fa-solid fa-ellipsis"></i></button>' : "") +
        '</div>';
    });
    return html;
  }

  // True while a profile/AI is expected to answer the last message. Drives the
  // "typing…" bubble; it starts shortly after sending and expires on its own so
  // a failed AI request can never leave it stuck forever.
  function aiTypingActive() {
    if (!activeConv || activeConv.other.type !== "profile" || !me) return false;
    const cfg = (window.LC && LC.db.aiConfig && LC.db.aiConfig.get) ? LC.db.aiConfig.get() : null;
    if (!cfg || !cfg.enabled) return false;
    const hb = Number(LC.db.getSetting ? LC.db.getSetting("ai_server_heartbeat", 0) : 0);
    const serverActive = hb > 0 && Date.now() - hb < 60000;
    const clientActive = !!(window.LC && LC.ai && LC.ai.isRunning && LC.ai.isRunning());
    if (!serverActive && !clientActive) return false;
    const msgs = allMessages().filter(m => m.conv === activeConv.key).sort((a, b) => a.ts - b.ts);
    const last = msgs[msgs.length - 1];
    if (!last || last.from.type !== "user" || last.from.id !== me.id) return false;
    const age = Date.now() - last.ts;
    return age > TYPING_START_MS && age < TYPING_MAX_MS;
  }

  function typingRowHtml() {
    if (!aiTypingActive()) return "";
    const peer = activeConv.other;
    const ent = LC.entity.get({ id: peer.id, type: peer.type });
    const name = (ent && (ent.fullName || ent.name)) || peer.name || "User";
    const src = (ent && ent.avatar) || peer.avatar || LC.avatar.make(name);
    return '<div class="msg-row other typing-row" aria-live="polite">' +
      '<img class="m-avatar" src="' + LC.fmt.esc(src) + '" alt="" onerror="this.remove()">' +
      '<div class="msg-col"><div class="msg typing-bubble" aria-label="typing">' +
      '<span class="tdot"></span><span class="tdot"></span><span class="tdot"></span>' +
      '</div></div>' +
      '</div>';
  }

  function scheduleTypingRefresh() {
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
    if (!activeConv || activeConv.other.type !== "profile" || !me) return;
    const msgs = allMessages().filter(m => m.conv === activeConv.key).sort((a, b) => a.ts - b.ts);
    const last = msgs[msgs.length - 1];
    if (!last || last.from.type !== "user" || last.from.id !== me.id) return;
    const age = Date.now() - last.ts;
    if (age < TYPING_START_MS) {
      typingTimer = setTimeout(() => { typingTimer = null; updateChatMessages(); }, TYPING_START_MS - age + 30);
    } else if (age < TYPING_MAX_MS && aiTypingActive()) {
      typingTimer = setTimeout(() => { typingTimer = null; updateChatMessages(); }, TYPING_MAX_MS - age + 50);
    }
  }

  function updateChatMessages() {
    const scroll = $("#msg-scroll");
    if (!scroll || !activeConv) return;
    const msgs = allMessages().filter(m => m.conv === activeConv.key).sort((a, b) => a.ts - b.ts);
    const html = (buildMessagesHtml(msgs) || '<div class="empty" style="padding:40px"><p>Say hello — this is the start of a conversation.</p></div>') + typingRowHtml();
    scheduleTypingRefresh();
    if (scroll._lcHtml === html) return;
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
    setHtml(scroll, html);
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  function renderChat() {
    const main = $("#chat-main");
    if (!activeConv) {
      if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
      // Back/close: wipe the old chat so the list isn't shown next to a stale conversation
      if (main._lcHtml !== "__empty__") {
        main._lcHtml = "__empty__";
        main.innerHTML = '<div class="empty chat-empty" style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center">' +
          '<div class="big"><i class="fa-solid fa-comment-dots"></i></div>' +
          '<p style="margin-bottom:16px">No conversation selected.<br>Pick a chat on the left to start talking.</p>' +
          '<button class="btn btn-primary btn-sm" data-action="go-discover"><i class="fa-solid fa-compass"></i> Find someone to talk to</button></div>';
      }
      return;
    }
    const peer = activeConv.other;
    const msgs = allMessages().filter(m => m.conv === activeConv.key).sort((a, b) => a.ts - b.ts);
    const ent = LC.entity.get({ id: peer.id, type: peer.type });

    let html = '<div class="chat-head">' +
      avatarFor(peer) +
      '<div style="flex:1;min-width:0">' +
      '<div class="ch-name">' + LC.fmt.esc(peer.name) + '</div>' +
      '<div class="ch-status' + (ent && ent.online ? ' online-now' : '') + '">' + (ent && ent.online ? '<i class="fa-solid fa-circle"></i> online' : LC.fmt.ago((ent && ent.lastActive) || Date.now())) + '</div>' +
      '</div>' +
      '<button class="btn btn-ghost btn-sm chat-tools" type="button" data-chat-menu="1" title="Chat options"><i class="fa-solid fa-ellipsis-vertical"></i></button>' +
      '<button class="btn btn-ghost btn-sm chat-back" type="button"><i class="fa-solid fa-arrow-left"></i> List</button>' +
      '</div>';

    html += '<div class="messages" id="msg-scroll">' +
      (buildMessagesHtml(msgs) || '<div class="empty" style="padding:40px"><p>Say hello — this is the start of a conversation.</p></div>') +
      typingRowHtml() +
      '</div>' +
      '<div class="msg-compose">' +
      '<div id="composer-extra"></div>' +
      '<div class="msg-input">' +
      '<input class="input" id="chat-input" type="text" placeholder="Write a message..." autocomplete="off">' +
      '<button class="btn btn-primary" id="btn-send">Send</button>' +
      '</div>' +
      '</div>';

    scheduleTypingRefresh();
    if (main._lcHtml === html) { renderComposerExtra(); return; }
    main._lcHtml = html;
    main.innerHTML = html;
    const scroll = $("#msg-scroll");
    scroll.scrollTop = scroll.scrollHeight;
    $("#chat-input").focus();
    renderComposerExtra();

    $("#btn-send").onclick = () => sendMessage();
    $("#chat-input").addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(); });
    main.querySelector(".chat-back").onclick = () => navBackOr("messages#chat:", closeChat);
  }

  function unAnsweredStreak(convKey) {
    const msgs = allMessages().filter(m => m.conv === convKey).sort((a, b) => a.ts - b.ts);
    let streak = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.from.type === "user" && m.from.id === me.id) streak++;
      else break;
    }
    return streak;
  }

  /* ---------------- message tools (reply / edit / react / delete) ---------------- */

  function resetComposer() {
    composer = { replyTo: null, editId: null, beforeEdit: "" };
  }

  function findMsg(id) {
    return allMessages().find(m => m.id === id) || null;
  }

  function renderComposerExtra() {
    const el = $("#composer-extra");
    if (!el) return;
    const sendBtn = $("#btn-send");
    let html = "";
    if (composer.editId) {
      const m = findMsg(composer.editId);
      html = '<div class="compose-bar">' +
        '<i class="fa-solid fa-pen ci"></i>' +
        '<div class="cb-body"><b>Editing message</b><span>' + LC.fmt.esc(replyPreview(m)) + '</span></div>' +
        '<button type="button" data-compose-cancel="1" title="Cancel edit">&times;</button>' +
        '</div>';
    } else if (composer.replyTo) {
      const m = findMsg(composer.replyTo);
      const who = m ? ((m.from.type === "user" && m.from.id === me.id) ? "yourself" : (m.from.name || "User")) : "message";
      html = '<div class="compose-bar">' +
        '<i class="fa-solid fa-reply ci"></i>' +
        '<div class="cb-body"><b>Replying to ' + LC.fmt.esc(who) + '</b><span>' + LC.fmt.esc(replyPreview(m)) + '</span></div>' +
        '<button type="button" data-compose-cancel="1" title="Cancel reply">&times;</button>' +
        '</div>';
    }
    el.innerHTML = html;
    if (sendBtn) sendBtn.textContent = composer.editId ? "Save" : "Send";
  }

  function startReply(id) {
    composer.editId = null;
    composer.replyTo = id;
    renderComposerExtra();
    const input = $("#chat-input");
    if (input) input.focus();
  }

  function startEdit(id) {
    const m = findMsg(id);
    if (!m || !m.text) return;
    const input = $("#chat-input");
    composer.beforeEdit = input ? input.value : "";
    composer.replyTo = null;
    composer.editId = id;
    renderComposerExtra();
    if (input) {
      input.value = m.text;
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
    }
  }

  function cancelComposer() {
    const input = $("#chat-input");
    if (composer.editId && input) input.value = composer.beforeEdit || "";
    resetComposer();
    renderComposerExtra();
    if (input) input.focus();
  }

  function toggleReaction(id, emoji) {
    const msgs = LC.db.messages.get();
    const m = msgs.find(x => x.id === id);
    if (!m) return;
    const r = parseReactions(m.reactions);
    const key = myRefKey();
    const arr = (r[emoji] || []).slice();
    const i = arr.indexOf(key);
    if (i >= 0) arr.splice(i, 1); else arr.push(key);
    if (arr.length) r[emoji] = arr; else delete r[emoji];
    m.reactions = Object.keys(r).length ? JSON.stringify(r) : "";
    if (pendingMsgs.has(id)) pendingMsgs.set(id, m);
    LC.db.messages.save(msgs);
    LC.rt.emit({ type: "message" });
    updateChatMessages();
  }

  function openMsgMenu(id) {
    const m = findMsg(id);
    if (!m) return;
    menuMsgId = id;
    const mine = m.from.type === "user" && m.from.id === me.id;
    const r = parseReactions(m.reactions);
    const key = myRefKey();
    $("#msg-react-bar").innerHTML = REACTIONS.map(e =>
      '<button type="button" data-react-pick="' + LC.fmt.esc(e) + '" class="' + ((r[e] || []).indexOf(key) >= 0 ? "on" : "") + '">' + e + '</button>'
    ).join("");
    $("#msg-menu-edit").classList.toggle("hidden", !(mine && m.text));
    $("#msg-menu-delete").classList.toggle("hidden", !mine);
    $("#msg-menu-modal").classList.add("open");
  }

  function closeMsgMenu() {
    menuMsgId = null;
    const el = $("#msg-menu-modal");
    if (el) el.classList.remove("open");
  }

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done();
    } catch (e) { toast("Could not copy.", "error"); }
  }

  function copyMessage(m) {
    const text = m && (m.text || m.image || "");
    if (!text) { toast("There is nothing to copy.", "warn"); return; }
    const done = () => toast("Copied to clipboard.");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }

  function deleteMessage(id) {
    if (!confirm("Delete this message for everyone? This cannot be undone.")) return;
    LC.db.messages.save(LC.db.messages.get().filter(m => m.id !== id));
    pendingMsgs.delete(id);
    LC.rt.emit({ type: "message" });
    closeMsgMenu();
    if (composer.replyTo === id || composer.editId === id) cancelComposer();
    updateChatMessages();
    renderConversationList2(myConversations());
    toast("Message deleted.");
  }

  function jumpToMessage(id) {
    const scroll = $("#msg-scroll");
    if (!scroll) return;
    const row = scroll.querySelector('.msg-row[data-mid="' + id + '"]');
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    const bubble = row.querySelector(".msg");
    if (bubble) {
      bubble.classList.add("msg-highlight");
      setTimeout(() => bubble.classList.remove("msg-highlight"), 1400);
    }
  }

  function openChatTools(key) {
    menuConvKey = key || null;
    const specific = !!menuConvKey;
    $("#ct-clear-chat").classList.toggle("hidden", !specific);
    $("#ct-title").textContent = specific ? "Chat options" : "Conversations";
    $("#ct-sub").textContent = specific
      ? "Manage your chat with " + convPeer(menuConvKey).name + "."
      : "Manage all of your conversations.";
    $("#chat-tools-modal").classList.add("open");
  }

  function closeChatTools() {
    menuConvKey = null;
    const el = $("#chat-tools-modal");
    if (el) el.classList.remove("open");
  }

  function clearChatByKey(key) {
    if (!key) return;
    const peer = convPeer(key);
    if (!confirm("Delete all messages with " + peer.name + "? This cannot be undone and removes them for both of you.")) return;
    LC.db.messages.save(LC.db.messages.get().filter(m => m.conv !== key));
    pendingMsgs.forEach((v, k) => { if (v.conv === key) pendingMsgs.delete(k); });
    LC.rt.emit({ type: "message" });
    closeChatTools();
    if (activeConv && activeConv.key === key) closeChat();
    renderConversationList2(myConversations());
    renderBadges();
    toast("Chat cleared.");
  }

  function clearAllConversations() {
    if (!confirm("Delete ALL messages in all your conversations? This cannot be undone and removes them for both sides.")) return;
    const left = LC.db.messages.get().filter(m =>
      !(m.from.type === "user" && m.from.id === me.id) &&
      !(m.to.type === "user" && m.to.id === me.id));
    LC.db.messages.save(left);
    pendingMsgs.clear();
    LC.rt.emit({ type: "message" });
    closeChatTools();
    if (activeConv) closeChat();
    renderConversationList2(myConversations());
    renderBadges();
    toast("All conversations cleared.");
  }

  function sendMessage() {
    if (composer.editId) return saveEditedMessage();
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text) return;
    if (unAnsweredStreak(activeConv.key) >= 3) {
      const peerName = activeConv.other.name;
      toast("You can't send more than 3 messages before " + peerName + " replies.", "error");
      LC.notify(meRef(), { id: "hearth", type: "system", name: "Hearth Chat", avatar: "" }, "warning", "Spam guard: wait for " + peerName + " to reply before sending more messages.");
      renderBadges();
      return;
    }
    const msg = {
      id: LC.db.uid(),
      conv: activeConv.key,
      from: meRef(),
      to: { id: activeConv.other.id, type: activeConv.other.type },
      text, image: null, ts: Date.now(), read: false
    };
    if (composer.replyTo) msg.replyTo = composer.replyTo;
    const msgs = LC.db.messages.get();
    msgs.push(msg);
    LC.db.messages.save(msgs);
    pendingMsgs.set(msg.id, msg);
    LC.rt.emit({ type: "message" });
    lastPulled.messages = 0; setTimeout(() => pullData(), 400);
    if (activeConv.other.type === "user") {
      const other = LC.db.users.byId(activeConv.other.id);
      if (other) {
        LC.notify({ id: other.id, type: "user" }, meRef(), "message", meRef().name + " sent you a message");
      }
    }
    input.value = "";
    resetComposer();
    renderChat();
    renderConversationList2(myConversations());
  }

  function saveEditedMessage() {
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text) { toast("Message can't be empty.", "error"); return; }
    const msgs = LC.db.messages.get();
    const m = msgs.find(x => x.id === composer.editId);
    if (!m) { resetComposer(); renderComposerExtra(); return; }
    m.text = text;
    m.edited = true;
    if (pendingMsgs.has(m.id)) pendingMsgs.set(m.id, m);
    LC.db.messages.save(msgs);
    LC.rt.emit({ type: "message" });
    input.value = "";
    resetComposer();
    renderComposerExtra();
    updateChatMessages();
    renderConversationList2(myConversations());
    toast("Message updated.");
  }

  /* ---------------- notifications ---------------- */

  function renderNotifications() {
    const el = $("#notif-list");
    const list = LC.db.notifications.get().filter(n => n.recipient.type === "user" && n.recipient.id === me.id && n.kind !== "message");
    if (!list.length) {
      setHtml(el, '<div class="empty"><div class="big"><i class="fa-solid fa-bell"></i></div><p>No notifications yet.</p></div>');
      return;
    }
    setHtml(el, list.map(n => {
      const isAnn = n.kind === "announcement";
      const text = isAnn ? n.text
        : n.kind === "follow" ? n.from.name + " followed you"
        : n.kind === "follow_back" ? n.from.name + " followed you back"
        : n.text || n.from.name;
      const av = isAnn
        ? '<div class="avatar notif-ann-av"><i class="fa-solid fa-bell"></i></div>'
        : avatarFor({ avatar: n.from.avatar, name: n.from.name });
      return '<div class="notif-item' + (n.read ? "" : " unread") + '">' +
        av +
        '<div class="notif-body"><div class="ntext">' +
        (isAnn ? '<span class="notif-tag">Announcement</span>' : "") +
        LC.fmt.esc(text) + '</div>' +
        (isAnn && n.from.name ? '<div class="ntime">From ' + LC.fmt.esc(n.from.name) + ' · ' + LC.fmt.ago(n.ts) + '</div>' : '<div class="ntime">' + LC.fmt.ago(n.ts) + '</div>') +
        '</div>' +
        '</div>';
    }).join(""));
  }

  function markAllNotifsRead() {
    const list = LC.db.notifications.get();
    list.forEach(n => { if (n.recipient.type === "user" && n.recipient.id === me.id && n.kind !== "message") n.read = true; });
    LC.db.notifications.save(list);
    renderNotifications();
    renderBadges();
  }

  function onNotifAction(e) {
    const btn = e.target.closest("[data-action=reply]");
    if (!btn) return;
    const n = LC.db.notifications.get().find(x => x.id === btn.dataset.nid);
    if (!n) return;
    const ent = LC.entity.get(n.from);
    if (ent) {
      const notifs = LC.db.notifications.get();
      const nn = notifs.find(x => x.id === n.id);
      if (nn) nn.read = true;
      LC.db.notifications.save(notifs);
      openConversation({ id: ent.id, type: n.from.type, name: ent.fullName || ent.name, avatar: ent.avatar });
    }
  }

  /* ---------------- profile ---------------- */

  function renderProfile() {
    const u = LC.db.users.byId(me.id) || me;
    me = u;
    $("#top-avatar").src = u.avatar || LC.avatar.make(u.fullName);
    $("#pf-avatar").src = u.avatar || LC.avatar.make(u.fullName);
    $("#up-preview").src = u.avatar || LC.avatar.make(u.fullName);
    $("#pf-name").textContent = u.fullName;
    $("#pf-username").textContent = "@" + u.username + "  \u00b7  " + u.age + "  \u00b7  " + u.gender;
    $("#pf-username-input").value = u.username;
    $("#pf-fullname").value = u.fullName;
    $("#pf-age").value = u.age;
    $("#pf-gender").value = u.gender;
    $("#pf-email").value = u.email;
    $("#pf-about").value = u.about || "";

    const follows = LC.db.follows.get();
    const following = follows.filter(f => f.follower.type === "user" && f.follower.id === me.id).length;
    const followers = follows.filter(f => f.target.type === "user" && f.target.id === me.id).length;
    const msgs = LC.db.messages.get().filter(m => m.from.type === "user" && m.from.id === me.id).length;
    $("#pf-following").textContent = following;
    $("#pf-followers").textContent = followers;
    $("#pf-messages").textContent = msgs;

    renderRewards();
    renderReferral();
  }

  /* ---------------- followers / following list ---------------- */

  // Resolve a follow reference to the live profile/member (type may be missing on old records).
  function resolveFollowRef(ref) {
    if (!ref) return null;
    if (ref.type === "profile") { const p = LC.db.profiles.byId(ref.id); return p ? { type: "profile", ent: p } : null; }
    if (ref.type === "user") { const u = LC.db.users.byId(ref.id); return u ? { type: "user", ent: u } : null; }
    const p = LC.db.profiles.byId(ref.id);
    if (p) return { type: "profile", ent: p };
    const u = LC.db.users.byId(ref.id);
    return u ? { type: "user", ent: u } : null;
  }

  function openFollowList(kind) {
    const follows = LC.db.follows.get();
    const seen = new Set();
    const people = [];
    follows.forEach(f => {
      let ref;
      if (kind === "following") { if (!(f.follower.type === "user" && f.follower.id === me.id)) return; ref = f.target; }
      else { if (!(f.target.id === me.id && (f.target.type === "user" || !f.target.type))) return; ref = f.follower; }
      const r = resolveFollowRef(ref);
      if (!r || (r.type === "user" && r.ent.id === me.id)) return;
      const key = r.type + ":" + r.ent.id;
      if (seen.has(key)) return;
      seen.add(key);
      people.push({ type: r.type, ent: r.ent, ts: f.ts || 0 });
    });
    people.sort((a, b) => b.ts - a.ts);

    $("#fl-title").textContent = (kind === "following" ? "Following" : "Followers") + " \u00b7 " + people.length;
    const body = $("#fl-body");
    body.innerHTML = people.length
      ? people.map(p =>
          '<div class="notif-item">' + avatarFor(p.ent) +
          '<div class="notif-body"><div class="ntext"><b>' + LC.fmt.esc(p.ent.fullName) + '</b></div>' +
          '<div class="ntime">@' + LC.fmt.esc(p.ent.username) + '</div></div>' +
          '<button class="btn btn-primary btn-sm" data-fl-msg="' + p.type + ":" + p.ent.id + '">Message</button></div>').join("")
      : '<div class="empty"><p>' + (kind === "following" ? "You aren't following anyone yet." : "No followers yet.") + '</p></div>';
    $("#follow-list-modal").classList.add("open");
  }

  function onFollowListClick(e) {
    const btn = e.target.closest("[data-fl-msg]");
    if (!btn) return;
    const [type, id] = btn.dataset.flMsg.split(":");
    const ent = type === "profile" ? LC.db.profiles.byId(id) : LC.db.users.byId(id);
    if (!ent) return;
    $("#follow-list-modal").classList.remove("open");
    openConversation({ id: ent.id, type, name: ent.fullName, avatar: ent.avatar });
  }

  /* ---------------- rewards UI ---------------- */

  function renderRewards() {
    if (!me) return;
    const u = currentUser();
    const st = rewardState(u);
    const cfg = LC.db.rewards.get();
    const points = Math.round(st.points);
    const bal = Number(u.balance) || 0;

    const menu = $("#pf-menu-points");
    if (menu) menu.textContent = points.toLocaleString() + " pts";

    const badge = $("#rw-status-badge");
    if (badge) {
      badge.textContent = st.activated ? "Active" : "Inactive";
      badge.className = "plan-badge " + (st.activated ? "proplus" : "free");
    }
    const pointsEl = $("#rw-points");
    if (pointsEl) pointsEl.textContent = points.toLocaleString();
    const otherCur = cfg.currency === "USD" ? "KES" : "USD";
    const valueEl = $("#rw-points-value");
    if (valueEl) valueEl.textContent = "≈ " + LC.db.rewards.money(LC.db.rewards.pointsToMoney(points, cfg.currency)) +
      " (" + LC.db.rewards.moneyIn(LC.db.rewards.pointsToMoney(points, otherCur), otherCur) + ")";
    const balEl = $("#pf-balance");
    if (balEl) balEl.textContent = LC.db.rewards.money(bal);
    const rateEl = $("#rw-rate-note");
    if (rateEl) rateEl.textContent = LC.db.rewards.rateLabel();

    const goalNote = $("#rw-goal-note");
    if (goalNote) goalNote.textContent = "Chat with profiles for " + cfg.minChatMinutes + " minutes today to earn " + cfg.dailyChatPoints + " points. Time counts while a profile chat is open.";
    const goalReward = $("#rw-goal-reward");
    if (goalReward) goalReward.textContent = "+" + cfg.dailyChatPoints + " points";

    const act = LC.db.rewards.activationInfo();
    const actBox = $("#rw-activation-box");
    if (actBox) actBox.classList.toggle("hidden", st.activated);
    const wdWrap = $("#rw-withdraw-wrap");
    if (wdWrap) wdWrap.classList.toggle("hidden", !st.activated);
    const actNote = $("#rw-activation-note");
    if (actNote) actNote.textContent = (act.note ? act.note + " " : "") + "Activation fee: " + LC.db.rewards.moneyIn(act.amount, act.currency) + ".";
    const amtLabel = $("#wd-amount-label");
    if (amtLabel) amtLabel.textContent = "Amount (" + (cfg.currency === "USD" ? "$" : "Ksh") + ")";

    updateRewardProgress();
    renderWithdrawalHistory();
  }

  function updateRewardProgress() {
    if (!me) return;
    const u = currentUser();
    const st = rewardState(u);
    const cfg = LC.db.rewards.get();
    const need = Math.max(1, Number(cfg.minChatMinutes) || 20) * 60;
    const secs = Math.min(st.chatSeconds, need);
    const pct = st.dayClaimed ? 100 : Math.min(100, Math.round((secs / need) * 100));
    const bar = $("#rw-goal-bar");
    if (bar) bar.style.width = pct + "%";
    const time = $("#rw-goal-time");
    if (time) time.textContent = fmtDuration(secs) + " / " + fmtDuration(need);
    const state = $("#rw-goal-state");
    if (state) state.textContent = st.dayClaimed ? "Goal complete — points added" : pct + "% complete";
    const chip = $("#rw-goal-reward");
    if (chip) chip.className = "chip " + (st.dayClaimed ? "chip-done" : "chip-open");
  }

  function convertPoints() {
    if (!me) return;
    const u = currentUser();
    const st = rewardState(u);
    const points = Math.round(st.points);
    if (points <= 0) return toast("You have no points to convert yet.", "error");
    const cfg = LC.db.rewards.get();
    const value = LC.db.rewards.pointsToMoney(points, cfg.currency);
    if (!confirm("Convert " + points.toLocaleString() + " points to " + LC.db.rewards.money(value) + "?\n\nThe value moves to your actual balance, which you can withdraw once your account is activated.")) return;
    st.points = 0;
    LC.db.rewards.setState(u, st);
    u.balance = (Number(u.balance) || 0) + value;
    saveUser(u);
    toast(points.toLocaleString() + " points converted — " + LC.db.rewards.money(value) + " added to your balance.");
    renderRewards();
  }

  function activateAccount() {
    if (!me) return;
    const u = currentUser();
    const st = LC.db.rewards.state(u);
    if (st.activated) return renderRewards();
    st.activated = true;
    st.activatedAt = Date.now();
    LC.db.rewards.setState(u, st);
    saveUser(u);
    renderRewards();
    LC.rt.emit({ type: "profiles" });
  }

  function completeActivation(paymentId) {
    if (paymentId) setPaymentStatus(paymentId, "paid");
    activateAccount();
    $("#pay-modal").classList.remove("open");
    pendingActivation = false;
    toast("Account activated — you can now withdraw your balance.");
  }

  let pendingActivation = false;
  let payMethod = null;

  function payMethodById(id) {
    return LC.db.paymentMethods.get().find(m => m.id === id) || null;
  }

  function openActivationModal() {
    const info = LC.db.rewards.activationInfo();
    if (info.amount <= 0) {
      if (confirm("Activation is free. Activate your account now?")) activateAccount();
      return;
    }
    pendingActivation = true;
    const methods = LC.db.paymentMethods.get();
    const connected = methods.find(m => m.connected && m.id !== "card");
    payMethod = connected ? connected.id : (methods.find(m => m.id !== "card") ? methods.find(m => m.id !== "card").id : null);
    $("#pay-title").textContent = "Activate your account";
    $("#pay-sub").textContent = "Pay " + LC.db.rewards.moneyIn(info.amount, info.currency) + " to unlock withdrawals. Your points and balance stay yours.";
    renderPayMethods();
    renderPayForm();
    $("#pay-error").textContent = "";
    $("#pay-error").classList.remove("show");
    $("#pay-submit").disabled = false;
    $("#pay-modal").classList.add("open");
  }

  function renderPayMethods() {
    const wrap = $("#pay-methods");
    const methods = LC.db.paymentMethods.get();
    wrap.innerHTML = methods.map(m =>
      '<button class="pay-method' + (m.id === payMethod ? " active" : "") + '" data-method="' + m.id + '">' +
      '<span class="pm-ico"><i class="' + LC.fmt.esc(m.icon || "fa-solid fa-wallet") + '"></i></span>' +
      '<span><b>' + LC.fmt.esc(m.name) + '</b><small>' + LC.fmt.esc(m.desc || "") + '</small></span>' +
      (m.connected && m.id !== "card"
        ? '<span class="pm-status ok"><i class="fa-solid fa-circle-check"></i></span>'
        : '<span class="pm-status"><i class="fa-solid fa-hourglass-half"></i> Coming soon</span>') +
      '</button>'
    ).join("");
  }

  function renderPayForm() {
    const f = $("#pay-form");
    const payBtn = $("#pay-submit");
    const err = $("#pay-error");
    err.classList.remove("show");
    err.textContent = "";
    const m = payMethodById(payMethod);
    const info = LC.db.rewards.activationInfo();
    if (!m) { f.innerHTML = ""; payBtn.classList.add("hidden"); return; }
    if (!m.connected || m.id === "card") {
      f.innerHTML = '<div class="pay-soon">' +
        '<div class="big"><i class="fa-solid fa-hourglass-half"></i></div>' +
        '<b>' + LC.fmt.esc(m.name) + ' is coming soon</b>' +
        '<p class="muted">This payment method is not available yet. Pick another method or check back later.</p>' +
        '</div>';
      payBtn.classList.add("hidden");
      return;
    }
    payBtn.classList.remove("hidden");
    if (m.id === "mpesa") {
      const base = LC.db.mpesa.get().baseUrl || "";
      if (!base) {
        f.innerHTML = '<div class="pay-soon">' +
          '<div class="big"><i class="fa-solid fa-mobile-screen-button"></i></div>' +
          '<b>M-Pesa is being connected</b>' +
          '<p class="muted">The payment backend is being set up. Check back soon or use Binance.</p>' +
          '</div>';
        payBtn.classList.add("hidden");
        return;
      }
      f.innerHTML =
        '<div class="field">' +
        '<label>M-Pesa phone number</label>' +
        '<input class="input" id="pay-phone" type="tel" placeholder="07XX XXX XXX or 2547XX...">' +
        '</div>' +
        '<div class="hint">You will receive an STK push prompt on this phone to approve a payment of Ksh ' + info.kes.toFixed(2) + '.</div>';
      payBtn.innerHTML = '<i class="fa-solid fa-mobile-screen-button"></i> Request payment prompt';
    } else if (m.id === "binance") {
      const addr = LC.db.paymentConfig.get().binanceAddress || "";
      f.innerHTML =
        '<div class="pay-addr">' +
        '<b>Deposit to this Binance address</b>' +
        '<div class="addr-box">' + (addr ? LC.fmt.esc(addr) : '<span class="muted">No deposit address set yet.</span>') + '</div>' +
        (addr ? '<button type="button" class="btn btn-outline btn-sm" id="pay-copy-addr"><i class="fa-solid fa-copy"></i> Copy address</button>' : "") +
        '</div>' +
        '<div class="field" style="margin-top:12px">' +
        '<label>Transaction hash / reference</label>' +
        '<input class="input" id="pay-ref" type="text" placeholder="Paste the TXID or deposit reference">' +
        '</div>' +
        '<div class="hint">Send ' + LC.db.rewards.moneyIn(info.amount, info.currency) + ' to the address above, then paste the transaction hash. An admin will verify your deposit and activate your account.</div>';
      payBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit deposit for verification';
      const copy = $("#pay-copy-addr");
      if (copy) copy.onclick = () => {
        try { navigator.clipboard.writeText(addr); toast("Deposit address copied."); }
        catch (e) { toast("Could not copy address.", "error"); }
      };
    } else {
      f.innerHTML = '<div class="pay-soon">' +
        '<div class="big"><i class="fa-solid fa-hourglass-half"></i></div>' +
        '<b>' + LC.fmt.esc(m.name) + ' is coming soon</b>' +
        '<p class="muted">Checkout for this method is being set up. Pick another method or check back later.</p>' +
        '</div>';
      payBtn.classList.add("hidden");
    }
  }

  function selectPayMethod(m) {
    payMethod = m;
    $$("#pay-methods .pay-method").forEach(b => b.classList.toggle("active", b.dataset.method === m));
    renderPayForm();
  }

  function recordPayment(m, ref, status) {
    const info = LC.db.rewards.activationInfo();
    const amount = m.id === "mpesa" ? info.kes : info.amount;
    const payments = LC.db.payments.get();
    const rec = { id: LC.db.uid(), user: meRef(), method: m.id, methodName: m.name, plan: "activation", amount, ref, status: status || "paid", ts: Date.now() };
    payments.unshift(rec);
    LC.db.payments.save(payments);
    LC.rt.emit({ type: "payments" });
    return rec;
  }

  function setPaymentStatus(paymentId, status) {
    const payments = LC.db.payments.get();
    const rec = payments.find(p => p.id === paymentId);
    if (!rec) return;
    rec.status = status;
    LC.db.payments.save(payments);
    LC.rt.emit({ type: "payments" });
  }

  function pollMpesaStatus(base, checkoutId, paymentId, attempt) {
    fetch(base.replace(/\/+$/, "") + "/api/mpesa/status/" + encodeURIComponent(checkoutId))
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        const status = ok ? d.status : null;
        if (status === "success") {
          completeActivation(paymentId);
          return;
        }
        if (status === "failed") {
          setPaymentStatus(paymentId, "failed");
          $("#pay-modal").classList.remove("open");
          pendingActivation = false;
          toast("STK push rejected — contact support.", "error");
          return;
        }
        if ((attempt || 0) >= 30) {
          setPaymentStatus(paymentId, "failed");
          $("#pay-modal").classList.remove("open");
          pendingActivation = false;
          toast("Payment confirmation timed out. If you were charged, contact support.", "error");
          return;
        }
        setTimeout(() => pollMpesaStatus(base, checkoutId, paymentId, (attempt || 0) + 1), 4000);
      })
      .catch(() => {
        if ((attempt || 0) >= 30) {
          setPaymentStatus(paymentId, "failed");
          $("#pay-modal").classList.remove("open");
          pendingActivation = false;
          toast("Payment confirmation timed out. If you were charged, contact support.", "error");
          return;
        }
        setTimeout(() => pollMpesaStatus(base, checkoutId, paymentId, (attempt || 0) + 1), 4000);
      });
  }

  // Re-check any M-Pesa payments still marked pending (e.g. after a page
  // refresh, or when the confirmation arrives later) and activate the account.
  let lastMpesaReconcile = 0;

  function reconcilePendingPayments(force) {
    if (!me) return;
    const base = LC.db.mpesa.get().baseUrl || "";
    if (!base) return;
    const now = Date.now();
    if (!force && now - lastMpesaReconcile < 20000) return;
    lastMpesaReconcile = now;

    LC.db.payments.get().filter(p =>
      p.user && p.user.id === me.id && p.method === "mpesa" && p.status === "pending" && p.ref
    ).forEach(rec => {
      fetch(base.replace(/\/+$/, "") + "/api/mpesa/status/" + encodeURIComponent(rec.ref))
        .then(r => r.json().then(d => ({ ok: r.ok, d })))
        .then(({ ok, d }) => {
          if (!ok || !d || !d.status) return;
          if (d.status === "success") {
            setPaymentStatus(rec.id, "paid");
            const st = LC.db.rewards.state(currentUser());
            if (!st.activated) {
              activateAccount();
              toast("Payment received — your account is now active!");
            }
          } else if (d.status === "failed") {
            setPaymentStatus(rec.id, "failed");
            toast("STK push rejected — contact support.", "error");
          }
        })
        .catch(() => {});
    });
  }

  function submitPayment() {
    if (!pendingActivation) return;
    const m = payMethodById(payMethod);
    if (!m || !m.connected || m.id === "card") return;
    const err = $("#pay-error");
    const fail = (x) => { err.textContent = x; err.classList.add("show"); };
    err.classList.remove("show");

    const btn = $("#pay-submit");
    btn.disabled = true;

    if (m.id === "mpesa") {
      const base = LC.db.mpesa.get().baseUrl || "";
      const phone = (($("#pay-phone") && $("#pay-phone").value) || "").trim();
      if (!base) { btn.disabled = false; return fail("M-Pesa is not connected yet. Contact support."); }
      if (!phone) { btn.disabled = false; return fail("Enter your M-Pesa phone number."); }
      const amount = LC.db.rewards.activationInfo().kes;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending STK push...';
      fetch(base.replace(/\/+$/, "") + "/api/mpesa/stkpush", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, amount, plan: "activation", userId: me.id, email: me.email })
      })
        .then(r => r.json().then(d => ({ ok: r.ok, d })))
        .then(({ ok, d }) => {
          if (!ok) {
            const e = new Error((d && d.message) || "STK push rejected by M-Pesa.");
            e.rejected = true;
            throw e;
          }
          const checkoutId = (d && (d.CheckoutRequestID || d.ref)) || "";
          if (!checkoutId) throw new Error("No checkout request id returned.");
          const rec = recordPayment(m, checkoutId, "pending");
          $("#pay-modal").classList.remove("open");
          toast("STK push sent — approve it on your phone.");
          banner("fa-mobile-screen-button", "Approve the payment", "Enter your M-Pesa PIN when prompted. We'll activate your account as soon as it's confirmed.", () => {});
          pendingActivation = false;
          btn.disabled = false;
          pollMpesaStatus(base, checkoutId, rec.id, 0);
        })
        .catch(err => {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-mobile-screen-button"></i> Request payment prompt';
          if (err && err.rejected) {
            const reason = (err.message && err.message.indexOf("STK push rejected by M-Pesa") === 0) ? "" : err.message;
            fail("STK push was rejected — contact support." + (reason ? " (" + reason + ")" : ""));
          } else {
            fail(err.message || "Could not reach the payment backend.");
          }
        });
      return;
    }

    let ref = "";
    if (m.id === "binance") {
      ref = (($("#pay-ref") && $("#pay-ref").value) || "").trim();
      if (!ref) { btn.disabled = false; return fail("Paste the transaction hash or deposit reference."); }
    }

    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting deposit...';
    setTimeout(() => {
      recordPayment(m, ref, "pending");
      $("#pay-modal").classList.remove("open");
      toast("Deposit submitted — an admin will verify it and activate your account.");
      pendingActivation = false;
      btn.disabled = false;
    }, 600);
  }

  function saveProfile() {
    const username = $("#pf-username-input").value.trim();
    const fullName = $("#pf-fullname").value.trim();
    const age = parseInt($("#pf-age").value, 10);
    const gender = $("#pf-gender").value;
    const email = $("#pf-email").value.trim().toLowerCase();
    const about = $("#pf-about").value.trim();
    if (username.length < 3) return toast("Username must be at least 3 characters", "error");
    if (!/^[a-z0-9_]+$/i.test(username)) return toast("Username can only contain letters, numbers and underscores", "error");
    if (fullName.length < 3) return toast("Please enter your full names", "error");
    if (!age || age < 13) return toast("Please enter a valid age", "error");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast("Please enter a valid email", "error");
    const lower = username.toLowerCase();
    const unameDup = LC.db.users.get().find(u => u.id !== me.id && String(u.username).toLowerCase() === lower);
    if (unameDup) return toast("That username is already taken", "error");
    const profDup = LC.db.profiles.get().find(p => String(p.username).toLowerCase() === lower);
    if (profDup) return toast("That username is already taken", "error");
    const users = LC.db.users.get();
    const u = users.find(x => x.id === me.id);
    if (u) { u.username = username; u.fullName = fullName; u.age = age; u.gender = gender; u.about = about; }
    LC.db.users.save(users);
    me = u || me;
    renderProfile();
    toast("Profile updated");
  }

  function handleAvatarFile(file) {
    if (!file) return;
    toast("Uploading to Cloudinary...");
    LC.cloudinary.uploadImage(file, (err, url) => {
      if (err) return toast(err.message || "Upload failed", "error");
      const users = LC.db.users.get();
      const u = users.find(x => x.id === me.id);
      if (u) u.avatar = url;
      LC.db.users.save(users);
      me = u || me;
      renderProfile();
      toast("Profile photo updated");
    });
  }

  /* ---------------- earnings ---------------- */

  function balanceOf(u) { return Math.round((Number((u && u.balance) || 0)) * 100) / 100; }
  function money(n) { return LC.db.rewards.money(n); }

  function renderWithdrawalHistory() {
    if (!me) return;
    const wd = LC.db.withdrawals.get().filter(w => w.user && w.user.id === me.id).sort((a, b) => b.createdAt - a.createdAt);
    const hist = $("#wd-history");
    if (!hist) return;
    hist.textContent = wd.length
      ? "Recent: " + wd.slice(0, 4).map(w => money(w.amount) + " via " + w.method + " (" + w.status + ")").join(" \u00b7 ")
      : "No withdrawals yet.";
  }

  const WD_DETAILS = {
    "PayPal": { label: "PayPal email", ph: "you@example.com", hint: "We'll send your payment to this PayPal account." },
    "Bank Transfer": { label: "Bank account details", ph: "Bank name, account name and account number", hint: "Include the bank name, account name and account number." },
    "Mobile Money": { label: "M-Pesa / mobile money number", ph: "e.g. 0712345678", hint: "The phone number registered for M-Pesa or mobile money." },
    "Cryptocurrency": { label: "Wallet address", ph: "Your wallet address", hint: "Include the network (e.g. USDT TRC20) if it matters. Double-check the address." }
  };

  function updateWithdrawDetails() {
    const d = WD_DETAILS[$("#wd-method").value] || WD_DETAILS["PayPal"];
    $("#wd-details-label").textContent = d.label;
    $("#wd-details").placeholder = d.ph;
    $("#wd-details-hint").textContent = d.hint;
  }

  function withdraw() {
    const u = currentUser();
    if (!LC.db.rewards.state(u).activated) {
      toast("Activate your account before withdrawing.", "error");
      openActivationModal();
      return;
    }
    const amt = Math.round(parseFloat($("#wd-amount").value || "0") * 100) / 100;
    const method = $("#wd-method").value;
    const details = $("#wd-details").value.trim();
    if (!amt || amt <= 0) return toast("Enter an amount to withdraw", "error");
    if (amt > balanceOf(u)) return toast("Amount exceeds your balance", "error");
    if (!details) return toast("Enter your " + WD_DETAILS[method].label.toLowerCase(), "error");
    const wds = LC.db.withdrawals.get();
    wds.push({ id: LC.db.uid(), user: meRef(), amount: amt, method, details, status: "pending", createdAt: Date.now() });
    LC.db.withdrawals.save(wds);
    u.balance = balanceOf(u) - amt;
    saveUser(u);
    LC.rt.emit({ type: "withdrawals" });
    $("#wd-amount").value = "";
    $("#wd-details").value = "";
    toast("Withdrawal requested \u2014 " + money(amt) + " via " + method + ".");
    renderRewards();
  }

  /* ---------------- refer & earn ---------------- */

  function referralPoints() {
    const v = Number((LC.db.rewards.get() || {}).referralPoints);
    return isFinite(v) && v > 0 ? Math.round(v) : 0;
  }

  function ensureRefCode() {
    const u = currentUser();
    const st = LC.db.rewards.state(u);
    if (st.refCode) return st.refCode;
    const users = LC.db.users.get();
    const abc = "abcdefghjkmnpqrstuvwxyz23456789";
    let code;
    do {
      code = "";
      for (let i = 0; i < 7; i++) code += abc[Math.floor(Math.random() * abc.length)];
    } while (users.some(x => LC.db.rewards.state(x).refCode === code));
    st.refCode = code;
    LC.db.rewards.setState(u, st);
    saveUser(u);
    return code;
  }

  function referralLink() {
    return location.origin + location.pathname.replace(/[^/]*$/, "") + "signup.html?ref=" + encodeURIComponent(ensureRefCode());
  }

  function renderReferral() {
    if (!me) return;
    const reward = referralPoints();
    const users = LC.db.users.get();
    const friends = users.filter(u => LC.db.rewards.state(u).referredBy === me.id)
      .sort((a, b) => (LC.db.rewards.state(b).referredAt || 0) - (LC.db.rewards.state(a).referredAt || 0));
    const earned = friends.reduce((s, u) => s + LC.db.rewards.state(u).referralPoints, 0);
    $("#rf-note").textContent = reward > 0
      ? "Earn " + reward.toLocaleString() + " points for every friend who joins with your link. Points are added to your rewards balance."
      : "Share your link with friends. Referral rewards aren't active right now.";
    $("#rf-link").value = referralLink();
    $("#rf-count").textContent = friends.length;
    $("#rf-earned").textContent = earned.toLocaleString() + " pts";
    setHtml($("#rf-list"), friends.length
      ? friends.map(u => {
        const st = LC.db.rewards.state(u);
        return '<div class="notif-item">' + avatarFor(u) +
          '<div class="notif-body"><div class="ntext"><b>' + LC.fmt.esc(u.fullName) + '</b></div>' +
          '<div class="ntime">@' + LC.fmt.esc(u.username) + ' \u00b7 ' + LC.fmt.ago(st.referredAt || u.createdAt || Date.now()) + '</div></div>' +
          '<b>' + (st.referralPoints > 0 ? "+" + st.referralPoints.toLocaleString() + " pts" : "\u2014") + '</b></div>';
      }).join("")
      : '<div class="empty" style="padding:26px 20px"><p>No one has joined with your link yet.</p></div>');
  }

  function copyReferralLink() {
    const link = referralLink();
    const done = () => toast("Referral link copied.");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, () => { $("#rf-link").select(); toast("Press copy on the selected link.", "warn"); });
    else { $("#rf-link").select(); toast("Press copy on the selected link.", "warn"); }
  }

  function shareReferralLink() {
    const link = referralLink();
    if (navigator.share) {
      navigator.share({ title: "Hearth Chat", text: "Join me on Hearth Chat.", url: link }).catch(() => {});
    } else copyReferralLink();
  }

  // A new account that arrived through a referral link gets linked to the referrer (once) and the referrer earns points.
  function applyPendingReferral() {
    let code = "";
    try { code = localStorage.getItem("lc_ref") || ""; } catch (e) {}
    if (!code) return;
    const clear = () => { try { localStorage.removeItem("lc_ref"); } catch (e) {} };
    const users = LC.db.users.get();
    const mine = users.find(u => u.id === me.id);
    if (!mine) return clear();
    const mineState = LC.db.rewards.state(mine);
    if (mineState.referredBy || mineState.refCode === code) return clear();
    // Only brand-new accounts (first week) can be referred.
    if (mine.createdAt && Date.now() - mine.createdAt > 7 * 24 * 3600 * 1000) return clear();
    const referrer = users.find(u => u.id !== mine.id && LC.db.rewards.state(u).refCode === code);
    if (!referrer) return clear();
    const pts = referralPoints();
    mineState.referredBy = referrer.id;
    mineState.referredAt = Date.now();
    mineState.referralPoints = pts;
    LC.db.rewards.setState(mine, mineState);
    if (pts > 0) {
      const refState = LC.db.rewards.state(referrer);
      refState.points += pts;
      LC.db.rewards.setState(referrer, refState);
    }
    LC.db.users.save(users);
    me = mine;
    LC.notify({ id: referrer.id, type: "user" }, meRef(), "announcement",
      me.fullName + " joined with your referral link" + (pts > 0 ? " \u2014 " + pts.toLocaleString() + " points were added." : "."));
    LC.rt.emit({ type: "rewards" });
    clear();
  }

  /* ---------------- profile menu ---------------- */

  // Profile opens as a menu; picking an item shows just that section (name = edit | rewards | referral), "" = back to the menu.
  function openProfileSection(name) {
    if (name) navGo("profile#" + name);
    $("#pf-menu").classList.toggle("hidden", !!name);
    $$(".pf-section").forEach(el => el.classList.toggle("hidden", el.id !== "pf-sec-" + name));
    $("#profile-page").classList.toggle("pf-open", !!name);
    if (name === "rewards") renderRewards();
    if (name === "referral") renderReferral();
    window.scrollTo(0, 0);
  }

  /* ---------------- view switching ---------------- */

  function showView(view, fromHistory) {
    const currentViewBefore = currentView;
    currentView = view;
    ["discover", "messages", "notifications", "profile"].forEach(v => {
      $("#view-" + v).classList.toggle("hidden", v !== view);
    });
    $$(".tab-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    const navMap = { discover: "nav-discover", messages: "nav-messages", notifications: "nav-notifications", profile: "nav-profile" };
    $$(".nav-links a").forEach(a => a.classList.remove("active"));
    if (navMap[view]) $("#" + navMap[view]).classList.add("active");
    if (view === "discover") { renderDiscover(); }
    if (view === "messages") { renderConversationList2(myConversations()); renderChat(); renderMsgBanner(); }
    if (view === "notifications") { markAllNotifsRead(); }
    if (view === "profile") { if (currentViewBefore !== "profile") openProfileSection(""); renderProfile(); }
    syncChatChrome();
    // Record real (non-back-button-driven) navigation in the section history stack.
    if (!fromHistory && window.LC && LC.nav) LC.nav.go(view);
  }

  /* ---------------- realtime ---------------- */

  function refresh() {
    if (!me) return;
    me = LC.db.users.byId(me.id) || me;
    reconcilePendingPayments(false);
    if (currentView === "discover") { renderDiscover(); }
    if (currentView === "messages") {
      renderConversationList2(myConversations());
      if (activeConv) updateChatMessages();
    }
    if (currentView === "notifications") renderNotifications();
    if (currentView === "profile") { renderProfile(); }
    renderMsgBanner();
    renderBadges();
    checkBanners();
  }

  function renderMsgBanner() {
    const el = $("#msg-banner");
    if (!el) return;
    const n = unreadCounts().convUnread;
    if (n === 0) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    $("#msg-banner-text").textContent = "You have " + n + " new message" + (n === 1 ? "" : "s");
  }

  function checkBanners() {
    const notifs = LC.db.notifications.get();
    const nowNotifIds = new Set(notifs.filter(n => n.recipient.type === "user" && n.recipient.id === me.id).map(n => n.id));
    if (seenNotifIds === null) {
      seenNotifIds = nowNotifIds;
      return;
    }
    nowNotifIds.forEach(id => {
      if (seenNotifIds.has(id)) return;
      const n = notifs.find(x => x.id === id);
      if (!n || n.kind === "message") return;
      const text = n.kind === "follow" ? n.from.name + " followed you"
        : n.kind === "follow_back" ? n.from.name + " followed you back"
        : n.text || n.from.name;
      banner("fa-bell", "New notification", text, () => showView("notifications"));
    });
    seenNotifIds = nowNotifIds;
  }

  let pollTimer = null;
  let pulling = false;
  const lastPulled = {};   // table -> last fetch time

  // How often each table really needs re-fetching, per screen. Realtime (LC.rt)
  // delivers most changes instantly; polling is only a slow safety net.
  function pollPlan() {
    const chatOpen = currentView === "messages" && !!activeConv;
    const msgs = chatOpen ? 2500 : currentView === "messages" ? 6000 : 20000;
    const plan = { messages: msgs, notifications: 20000, sessions: 60000, settings: 120000 };
    if (currentView === "discover" || currentView === "profile") { plan.users = 30000; plan.profiles = 30000; }
    else { plan.users = 90000; plan.profiles = 90000; }
    return plan;
  }

  // Re-fetch only tables that are stale, only when the tab is visible and online.
  function pullData(force) {
    if (pulling || !me) return Promise.resolve();
    if (document.hidden || navigator.onLine === false) return Promise.resolve();
    const now = Date.now();
    const plan = pollPlan();
    const tables = Object.keys(plan).filter(t => force || now - (lastPulled[t] || 0) >= plan[t]);
    if (!tables.length) return Promise.resolve();
    pulling = true;
    tables.forEach(t => { lastPulled[t] = now; });
    return Promise.resolve(LC.db.refresh(tables)).then(() => {
      pulling = false;
      refresh();
    }).catch(() => { pulling = false; });
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { pullData().finally(schedulePoll); }, 2000);
  }

  function startRealtime() {
    schedulePoll();
    LC.rt.on(() => refresh());
    window.addEventListener("focus", refresh);
    // Catch up once when the user comes back to the tab or the network returns.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pullData(true); });
    window.addEventListener("online", () => pullData(true));
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    await LC.db.init();
    let session = LC.db.session.get();
    if (!session || session.type !== "user") {
      const restored = await LC.auth.restoreSession().catch(() => null);
      session = LC.db.session.get();
      if (restored) me = restored;
    }
    if (!session || session.type !== "user") { window.location.href = "login.html"; return; }
    if (!me) me = LC.db.users.byId(session.id);
    if (!me) { window.location.href = "login.html"; return; }

    applyPendingReferral();
    $("#top-avatar").src = me.avatar || LC.avatar.make(me.fullName);

    const doLogout = async () => {
      if (window.LC && LC.ai) LC.ai.stop();
      if (window.LC && LC.nav) LC.nav.clear();
      const users = LC.db.users.get();
      const u = users.find(x => x.id === me.id);
      if (u) u.online = false;
      LC.db.users.save(users);
      await LC.db.session.save(null);
      window.location.href = "index.html";
    };
    $("#btn-logout").onclick = doLogout;

    if (window.LC && LC.nav) {
      LC.nav.init({
        root: "discover",
        render: navRender,
        onExit: () => LC.auth.exitApp(),
        onWarn: (msg) => toast(msg, "warn")
      });
    }

    $("#nav-discover").onclick = (e) => { e.preventDefault(); showView("discover"); };
    $("#nav-messages").onclick = (e) => { e.preventDefault(); showView("messages"); };
    $("#nav-notifications").onclick = (e) => { e.preventDefault(); showView("notifications"); };
    $("#nav-profile").onclick = (e) => { e.preventDefault(); showView("profile"); };
    $("#btn-profile").onclick = () => showView("profile");

    $$(".tab-item").forEach(b => b.onclick = () => showView(b.dataset.view));

    $("#discover-search").addEventListener("input", e => { discoverSearch = e.target.value; renderDiscover(); });
    $("#discover-gender").addEventListener("change", e => { genderFilter = e.target.value; renderDiscover(); });
    $("#discover-grid").addEventListener("click", onDiscoverAction);
    const chatMain = $("#chat-main");
    let suppressClickUntil = 0;
    chatMain.addEventListener("click", e => {
      if (Date.now() < suppressClickUntil) return;
      if (e.target.closest("[data-action=go-discover]")) { showView("discover"); return; }
      if (e.target.closest("[data-compose-cancel]")) { cancelComposer(); return; }
      const quick = e.target.closest("[data-msg-open]");
      if (quick) { openMsgMenu(quick.dataset.msgOpen); return; }
      const react = e.target.closest("[data-react]");
      if (react) { toggleReaction(react.dataset.mid, react.dataset.react); return; }
      const jump = e.target.closest("[data-jump]");
      if (jump) { jumpToMessage(jump.dataset.jump); return; }
      if (e.target.closest("a")) return; // let the device open the link
      const bubble = e.target.closest(".msg-row .msg");
      if (bubble) {
        const sel = window.getSelection ? String(window.getSelection()) : "";
        const row = bubble.closest(".msg-row");
        // Clicking one of your own messages opens edit/delete; other people's
        // messages stay selectable and use long-press / right-click instead.
        if (!sel && row && row.classList.contains("me")) openMsgMenu(row.dataset.mid);
        return;
      }
      if (e.target.closest("[data-chat-menu]")) { openChatTools(activeConv && activeConv.key); return; }
    });

    // Long-press a message (or right-click on desktop) to open its tools.
    let pressTimer = null, pressStart = null, pressRow = null;
    const clearPress = () => {
      clearTimeout(pressTimer);
      pressTimer = null;
      pressStart = null;
      pressRow = null;
    };
    chatMain.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest("button, a, input, textarea")) return;
      const row = e.target.closest(".msg-row");
      if (!row) return;
      pressStart = { x: e.clientX, y: e.clientY };
      pressRow = row;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        if (!pressRow) return;
        const id = pressRow.dataset.mid;
        pressRow = null;
        suppressClickUntil = Date.now() + 600;
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
        openMsgMenu(id);
      }, 520);
    });
    chatMain.addEventListener("pointermove", e => {
      if (!pressStart) return;
      if (Math.abs(e.clientX - pressStart.x) > 10 || Math.abs(e.clientY - pressStart.y) > 10) clearPress();
    });
    chatMain.addEventListener("pointerup", clearPress);
    chatMain.addEventListener("pointercancel", clearPress);
    chatMain.addEventListener("pointerleave", clearPress);
    chatMain.addEventListener("contextmenu", e => {
      if (e.target.closest("a")) return; // keep the browser's link menu
      const row = e.target.closest(".msg-row");
      if (!row) return;
      e.preventDefault();
      openMsgMenu(row.dataset.mid);
    });

    $("#conv-list-menu").onclick = () => openChatTools(null);
    $("#ct-close").onclick = closeChatTools;
    $("#ct-clear-chat").onclick = () => clearChatByKey(menuConvKey || (activeConv && activeConv.key));
    $("#ct-clear-all").onclick = clearAllConversations;
    $("#chat-tools-modal").addEventListener("click", e => { if (e.target.id === "chat-tools-modal") closeChatTools(); });
    $("#msg-menu-close").onclick = closeMsgMenu;
    $("#msg-menu-modal").addEventListener("click", e => { if (e.target.id === "msg-menu-modal") closeMsgMenu(); });
    $("#msg-react-bar").addEventListener("click", e => {
      const b = e.target.closest("[data-react-pick]");
      if (!b || !menuMsgId) return;
      toggleReaction(menuMsgId, b.dataset.reactPick);
      closeMsgMenu();
    });
    $("#msg-menu-panel").addEventListener("click", e => {
      const b = e.target.closest("[data-msg-act]");
      if (!b || !menuMsgId) return;
      const id = menuMsgId;
      const m = findMsg(id);
      if (!m) { closeMsgMenu(); return; }
      if (b.dataset.msgAct === "reply") { startReply(id); closeMsgMenu(); }
      else if (b.dataset.msgAct === "copy") { copyMessage(m); closeMsgMenu(); }
      else if (b.dataset.msgAct === "edit") { startEdit(id); closeMsgMenu(); }
      else if (b.dataset.msgAct === "delete") { deleteMessage(id); }
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") { closeMsgMenu(); closeChatTools(); }
    });
    $("#conv-list").addEventListener("click", e => {
      const go = e.target.closest("[data-action=go-discover]");
      if (go) { showView("discover"); return; }
      const more = e.target.closest("[data-conv-menu]");
      if (more) { e.stopPropagation(); openChatTools(more.dataset.convMenu); return; }
      const item = e.target.closest("[data-conv]");
      if (!item) return;
      const { a, b } = LC.convFrom(item.dataset.conv);
      const peer = (a.type === "user" && a.id === me.id) ? b : a;
      const ent = LC.entity.get(peer);
      openConversation({ id: peer.id, type: peer.type, name: (ent && (ent.fullName || ent.name)) || "User", avatar: ent && ent.avatar });
    });
    $("#notif-list").addEventListener("click", onNotifAction);
    $("#btn-mark-read").onclick = markAllNotifsRead;
    $("#btn-save-profile").onclick = saveProfile;
    $("#pf-menu").addEventListener("click", e => {
      const b = e.target.closest("[data-pf-open]");
      if (b) openProfileSection(b.dataset.pfOpen);
    });
    $$(".pf-back").forEach(b => b.onclick = () => navBackOr("profile#", () => openProfileSection("")));
    $("#rf-copy").onclick = copyReferralLink;
    $("#rf-share").onclick = shareReferralLink;
    $("#pf-avatar-file").addEventListener("change", e => handleAvatarFile(e.target.files[0]));
    $("#btn-activate").onclick = openActivationModal;
    $("#btn-convert-points").onclick = convertPoints;
    $("#pay-close").onclick = () => { $("#pay-modal").classList.remove("open"); pendingActivation = false; };
    $("#pay-modal").addEventListener("click", e => { if (e.target.id === "pay-modal") { $("#pay-modal").classList.remove("open"); pendingActivation = false; } });
    $("#pay-methods").addEventListener("click", e => {
      const b = e.target.closest("[data-method]");
      if (b) selectPayMethod(b.dataset.method);
    });
    $("#pay-submit").onclick = submitPayment;

    $$(".pb-stat[data-follow-list]").forEach(el => {
      el.addEventListener("click", () => openFollowList(el.dataset.followList));
      el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFollowList(el.dataset.followList); } });
    });
    $("#fl-close").onclick = () => $("#follow-list-modal").classList.remove("open");
    $("#follow-list-modal").addEventListener("click", e => { if (e.target.id === "follow-list-modal") $("#follow-list-modal").classList.remove("open"); });
    $("#fl-body").addEventListener("click", onFollowListClick);
    $("#btn-withdraw").onclick = withdraw;
    $("#wd-method").addEventListener("change", updateWithdrawDetails);
    updateWithdrawDetails();

    const params = new URLSearchParams(window.location.search);
    const requestedView = params.get("view");
    const setupMode = params.get("setup") === "1";
    const validViews = ["discover", "messages", "notifications", "profile"];
    const initialView = validViews.includes(requestedView) ? requestedView : (setupMode ? "profile" : "discover");
    showView(initialView);
    if (setupMode) {
      openProfileSection("edit");
      if (window.history && history.replaceState) {
        history.replaceState(null, "", window.location.pathname + (initialView !== "discover" ? "?view=" + initialView : ""));
      }
      banner("fa-user-pen", "Complete your profile",
        "Pick a username, your age and gender so people know who they're talking to.", () => {});
    }
    startRealtime();
    setInterval(tickChatTime, 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) persistChatProgress(true);
    });
    window.addEventListener("beforeunload", () => { if (me) saveUser(currentUser()); });
    if (window.LC && LC.ai) LC.ai.start({ userId: me.id });
    reconcilePendingPayments(true);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
