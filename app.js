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

  /* ---------------- helpers ---------------- */

  function meRef() { return { id: me.id, type: "user", name: me.fullName, avatar: me.avatar }; }

  /* ---------------- plans & quota ---------------- */

  const PLAN_FREE = "free", PLAN_PRO = "pro", PLAN_PROPLUS = "proplus";
  const FREE_DAILY_LIMIT = 10;
  const PLAN_META = {
    free: { name: "Free", price: "$0", desc: "Get started" },
    pro: { name: "Pro", price: "$4.99/mo", desc: "Unlimited messages" },
    proplus: { name: "Pro Plus", price: "$9.99/mo", desc: "Unlimited messages + Discover" }
  };

  function planOf(u) { return (u && u.plan) || PLAN_FREE; }
  function isProUser(u) { const p = planOf(u); return p === PLAN_PRO || p === PLAN_PROPLUS; }
  function todayKey() { return new Date().toISOString().slice(0, 10); }

  function saveUser(u) {
    const users = LC.db.users.get();
    const i = users.findIndex(x => x.id === u.id);
    if (i >= 0) users[i] = u; else users.push(u);
    LC.db.users.save(users);
  }

  function consumeQuota(u) {
    if (isProUser(u)) return true;
    let q = u.msgQuota;
    const today = todayKey();
    if (!q || q.date !== today) { q = u.msgQuota = { date: today, used: 0 }; }
    if (q.used >= FREE_DAILY_LIMIT) return false;
    q.used++;
    saveUser(u);
    return true;
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

  // Best-effort email to a user's inbox when something happens (follow, message).
  // Requires the Render backend base URL. Never blocks the UI.
  function sendNotificationEmail(opts) {
    const base = ((LC.db.email.get().baseUrl || "") + "").trim().replace(/\/+$/, "");
    if (!base) return;
    const target = opts.toType === "user" ? LC.db.users.byId(opts.toId) : null;
    if (!target || !target.email) return;
    const appName = (LC.config && LC.config.appName) || "Hearth Chat";
    const text = opts.kind === "follow"
      ? opts.senderName + " followed you on " + appName + "."
      : opts.kind === "message"
      ? opts.senderName + " sent you a message: \"" + (opts.text || "") + "\""
      : "You have a new notification on " + appName + ".";
    fetch(base + "/api/email/notification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: target.email,
        recipientName: target.fullName || target.username,
        senderName: opts.senderName,
        kind: opts.kind,
        text: text,
        actionUrl: location.origin + location.pathname.replace(/[^/]*$/, "") + "app.html?view=messages"
      })
    }).catch(() => {});
  }

  function isFollowing(target) {
    return LC.db.follows.exists(meRef(), { id: target.id, type: target.type });
  }

  function followsMe(ent) {
    return LC.db.follows.exists({ id: ent.id, type: ent.type }, meRef());
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
      follows.push({ id: LC.db.uid(), follower: mRef, target: tRef, ts: Date.now() });
      LC.db.follows.save(follows);
      LC.notify(tRef, mRef, "follow", mRef.name + " followed you");
      sendNotificationEmail({ toId: tRef.id, toType: tRef.type, kind: "follow", senderName: mRef.name });
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

  function discoverEntities() {
    const all = [];
    LC.db.profiles.get().filter(p => p.listed === true).forEach(p => all.push({ type: "profile", ...p }));
    LC.db.users.get().filter(u => u.id !== me.id && u.listed === true).forEach(u => all.push({ type: "user", ...u }));
    const q = discoverSearch.toLowerCase();
    return all.filter(e => {
      if (genderFilter && e.gender !== genderFilter) return false;
      if (!q) return true;
      return (e.fullName + " " + e.username + " " + (e.about || "")).toLowerCase().includes(q);
    }).sort((a, b) => (b.listedAt || 0) - (a.listedAt || 0));
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
    if (btn.dataset.action === "follow" || btn.dataset.action === "unfollow") toggleFollow(ent);
    else {
      openConversation({ id: ent.id, type, name: ent.fullName, avatar: ent.avatar });
      showView("messages");
    }
  }

  /* ---------------- conversations & chat ---------------- */

  function myConversations() {
    const msgs = LC.db.messages.get();
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
        '</div>';
    }).join("");
    setHtml(el, html || '<div class="empty"><div class="big"><i class="fa-solid fa-comment-dots"></i></div><p style="margin-bottom:14px">No conversations yet.<br>Find someone kind and say hello.</p><button class="btn btn-primary btn-sm" data-action="go-discover"><i class="fa-solid fa-compass"></i> Discover people</button></div>');
  }

  function openConversation(peer) {
    const key = LC.convKey(meRef(), { id: peer.id, type: peer.type });
    activeConv = { key, other: peer };
    markConvRead(key);
    renderChat();
    renderConversationList2(myConversations());
    $("#chat-wrap").classList.add("mobile-chat-open");
  }

  function markConvRead(key) {
    const msgs = LC.db.messages.get();
    let changed = false;
    msgs.forEach(m => { if (m.conv === key && m.to.type === "user" && m.to.id === me.id && !m.read) { m.read = true; changed = true; } });
    if (changed) { LC.db.messages.save(msgs); LC.rt.emit({ type: "read" }); }
  }

  function buildMessagesHtml(msgs) {
    let html = "";
    let lastDay = "";
    msgs.forEach(m => {
      const day = LC.fmt.day(m.ts);
      if (day !== lastDay) { html += '<div class="day-divider">' + day + '</div>'; lastDay = day; }
      const mine = m.from.type === "user" && m.from.id === me.id;
      html += '<div class="msg-row ' + (mine ? "me" : "other") + '">' +
        (mine ? "" : '<img class="m-avatar" src="' + LC.fmt.esc(m.from.avatar || LC.avatar.make(m.from.name)) + '" alt="" onerror="this.remove()">') +
        '<div class="msg">' +
        (m.image ? '<img class="m-img" src="' + LC.fmt.esc(m.image) + '" alt="">' : "") +
        (m.text ? LC.fmt.esc(m.text) : "") +
        '<span class="m-tail">' + LC.fmt.time(m.ts) + '</span>' +
        '</div>' +
        '</div>';
    });
    return html;
  }

  function updateChatMessages() {
    const scroll = $("#msg-scroll");
    if (!scroll || !activeConv) return;
    const msgs = LC.db.messages.get().filter(m => m.conv === activeConv.key).sort((a, b) => a.ts - b.ts);
    const html = buildMessagesHtml(msgs) || '<div class="empty" style="padding:40px"><p>Say hello — this is the start of a conversation.</p></div>';
    if (scroll._lcHtml === html) return;
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
    setHtml(scroll, html);
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  function renderChat() {
    const main = $("#chat-main");
    if (!activeConv) return;
    const peer = activeConv.other;
    const msgs = LC.db.messages.get().filter(m => m.conv === activeConv.key).sort((a, b) => a.ts - b.ts);
    const ent = LC.entity.get({ id: peer.id, type: peer.type });

    let html = '<div class="chat-head">' +
      avatarFor(peer) +
      '<div style="flex:1;min-width:0">' +
      '<div class="ch-name">' + LC.fmt.esc(peer.name) + '</div>' +
      '<div class="ch-status' + (ent && ent.online ? ' online-now' : '') + '">' + (ent && ent.online ? '<i class="fa-solid fa-circle"></i> online' : LC.fmt.ago((ent && ent.lastActive) || Date.now())) + '</div>' +
      '</div>' +
      '<button class="btn btn-ghost btn-sm chat-back"><i class="fa-solid fa-arrow-left"></i> List</button>' +
      '</div>';

    html += '<div class="messages" id="msg-scroll">' +
      (buildMessagesHtml(msgs) || '<div class="empty" style="padding:40px"><p>Say hello — this is the start of a conversation.</p></div>') +
      '</div>' +
      '<div class="msg-input">' +
      '<input class="input" id="chat-input" type="text" placeholder="Write a message..." autocomplete="off">' +
      '<button class="btn btn-primary" id="btn-send">Send</button>' +
      '</div>';

    if (main._lcHtml === html) return;
    main._lcHtml = html;
    main.innerHTML = html;
    const scroll = $("#msg-scroll");
    scroll.scrollTop = scroll.scrollHeight;
    $("#chat-input").focus();

    $("#btn-send").onclick = () => sendMessage();
    $("#chat-input").addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(); });
    main.querySelector(".chat-back").onclick = () => {
      $("#chat-wrap").classList.remove("mobile-chat-open");
      activeConv = null;
      renderChat();
    };
  }

  function unAnsweredStreak(convKey) {
    const msgs = LC.db.messages.get().filter(m => m.conv === convKey).sort((a, b) => a.ts - b.ts);
    let streak = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.from.type === "user" && m.from.id === me.id) streak++;
      else break;
    }
    return streak;
  }

  function sendMessage() {
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text) return;
    if (!consumeQuota(me)) {
      banner("fa-crown", "Daily message limit reached",
        "You've reached your free daily limit. Upgrade to Pro or Pro Plus to keep chatting.", () => showView("profile"));
      renderProfile();
      return;
    }
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
    const msgs = LC.db.messages.get();
    msgs.push(msg);
    LC.db.messages.save(msgs);
    LC.rt.emit({ type: "message" });
    if (activeConv.other.type === "user") {
      const other = LC.db.users.byId(activeConv.other.id);
      if (other) {
        LC.notify({ id: other.id, type: "user" }, meRef(), "message", meRef().name + " sent you a message");
        sendNotificationEmail({ toId: other.id, toType: "user", kind: "message", senderName: meRef().name, text });
      }
    }
    input.value = "";
    renderChat();
    renderConversationList2(myConversations());
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
      showView("messages");
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

    renderPlans();
    renderEarnings();
  }

  /* ---------------- plans UI ---------------- */

  function planLabel(p) { return p === PLAN_PRO ? "Pro" : p === PLAN_PROPLUS ? "Pro Plus" : "Free"; }

  function planPrice(key) {
    if (key === PLAN_FREE) return "$0";
    const p = LC.db.pricing.get();
    const v = parseFloat(p[key]);
    return "$" + (isFinite(v) ? v.toFixed(2) : p[key]);
  }

  const KES_RATE = 129; // 1 USD = 129 KES

  function usdToKes(usd) {
    const v = parseFloat(usd);
    return isFinite(v) ? Math.round(v * KES_RATE) : 0;
  }

  function planPriceKes(key) {
    if (key === PLAN_FREE) return "Ksh 0";
    return "Ksh " + usdToKes(planPrice(key).replace(/[^0-9.]/g, ""));
  }

  function renderPlans() {
    const cur = planOf(me);
    const badge = $("#pf-plan-badge");
    if (badge) { badge.textContent = planLabel(cur); badge.className = "plan-badge " + cur; }

    const note = $("#pf-plan-note");
    if (note) {
      note.textContent = cur === PLAN_FREE
        ? "You're on the Free plan."
        : cur === PLAN_PRO
        ? "You're on Pro: send unlimited messages."
        : "You're on Pro Plus: unlimited messages, your profile in Discover, and paid Tasks you can claim.";
    }

    const wrap = $("#plans-list");
    if (!wrap) return;
    const featured = cur !== PLAN_PROPLUS ? PLAN_PROPLUS : PLAN_PRO;
    const featsFor = (key) => key === PLAN_PRO
      ? '<div class="plan-feats">' +
        '<div><i class="fa-solid fa-check"></i> Unlimited messages</div>' +
        '<div><i class="fa-solid fa-check"></i> No daily message limit</div>' +
        '<div><i class="fa-solid fa-check"></i> Pro profile badge</div>' +
        '</div>'
      : '<div class="plan-feats">' +
        '<div><i class="fa-solid fa-check"></i> Everything in Pro</div>' +
        '<div><i class="fa-solid fa-check"></i> Your profile in Discover</div>' +
        '<div><i class="fa-solid fa-check"></i> Claim paid helping tasks</div>' +
        '<div><i class="fa-solid fa-check"></i> Get paid to your account</div>' +
        '</div>';
    setHtml(wrap,
      ["free", "pro", "proplus"].sort((a, b) => (a === featured ? 1 : 0) - (b === featured ? 1 : 0)).map(key => {
        const m = PLAN_META[key];
        const isCur = key === cur;
        const isFeat = key === featured;
        const feat = key === PLAN_FREE ? "Get started today" : "";
        const cta = isCur
          ? '<span class="plan-cur">Current plan</span>'
          : '<button class="btn ' + (key === PLAN_PRO ? "btn-outline" : "btn-primary") + ' btn-sm" data-plan="' + key + '">Upgrade to ' + m.name + '</button>';
        return '<div class="plan-card' + (isFeat ? " featured" : "") + (isCur ? " current" : "") + '">' +
          '<div class="plan-name">' + m.name + (isFeat ? ' <span class="plan-pop">Best value</span>' : "") + '</div>' +
          '<div class="plan-price">' + planPrice(key) + '</div>' +
          (key === PLAN_FREE ? '<div class="plan-feat">' + feat + '</div>' : featsFor(key)) +
          cta +
          '</div>';
      }).join(""));
  }

  function upgradePlan(key) {
    if (!PLAN_META[key] || planOf(me) === key) return;
    const u = me;
    u.plan = key;
    saveUser(u);
    me = u;
    renderProfile();
    renderDiscover();
    toast("You're now on " + PLAN_META[key].name + "!");
  }

  let pendingPlan = null;
  let payMethod = null;

  function payMethodById(id) {
    return LC.db.paymentMethods.get().find(m => m.id === id) || null;
  }

  function openPayModal(key) {
    if (!PLAN_META[key]) return;
    pendingPlan = key;
    const methods = LC.db.paymentMethods.get();
    const connected = methods.find(m => m.connected && m.id !== "card");
    payMethod = connected ? connected.id : (methods.find(m => m.id !== "card") ? methods.find(m => m.id !== "card").id : null);
    $("#pay-title").textContent = "Upgrade to " + PLAN_META[key].name;
    $("#pay-sub").textContent = payMethod === "mpesa"
      ? "Pay " + planPriceKes(key) + " (" + planPrice(key) + ") to activate " + PLAN_META[key].name + " via M-Pesa."
      : "Pay " + planPrice(key) + " to activate " + PLAN_META[key].name + ".";
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
        '<div class="hint">You will receive an STK push prompt on this phone to approve a payment of ' + planPriceKes(pendingPlan) + ' (' + planPrice(pendingPlan) + ').</div>';
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
        '<div class="hint">Send the amount for this plan to the address above, then paste the transaction hash. An admin will verify your deposit and activate your plan.</div>';
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
    const key = pendingPlan;
    const usd = parseFloat(planPrice(key).replace(/[^0-9.]/g, ""));
    const amount = m.id === "mpesa" ? usdToKes(usd) : usd;
    const payments = LC.db.payments.get();
    const rec = { id: LC.db.uid(), user: meRef(), method: m.id, methodName: m.name, plan: key, amount, ref, status: status || "paid", ts: Date.now() };
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

  function pollMpesaStatus(base, checkoutId, planKey, paymentId, attempt) {
    fetch(base.replace(/\/+$/, "") + "/api/mpesa/status/" + encodeURIComponent(checkoutId))
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        const status = ok ? d.status : null;
        if (status === "success") {
          setPaymentStatus(paymentId, "paid");
          upgradePlan(planKey);
          $("#pay-modal").classList.remove("open");
          pendingPlan = null;
          toast("Payment received — your plan is active!");
          return;
        }
        if (status === "failed") {
          setPaymentStatus(paymentId, "failed");
          $("#pay-modal").classList.remove("open");
          pendingPlan = null;
          toast("STK push rejected — contact support.", "error");
          return;
        }
        if ((attempt || 0) >= 30) {
          setPaymentStatus(paymentId, "failed");
          $("#pay-modal").classList.remove("open");
          pendingPlan = null;
          toast("Payment confirmation timed out. If you were charged, contact support.", "error");
          return;
        }
        setTimeout(() => pollMpesaStatus(base, checkoutId, planKey, paymentId, (attempt || 0) + 1), 4000);
      })
      .catch(() => {
        if ((attempt || 0) >= 30) {
          setPaymentStatus(paymentId, "failed");
          $("#pay-modal").classList.remove("open");
          pendingPlan = null;
          toast("Payment confirmation timed out. If you were charged, contact support.", "error");
          return;
        }
        setTimeout(() => pollMpesaStatus(base, checkoutId, planKey, paymentId, (attempt || 0) + 1), 4000);
      });
  }

  // Re-check any M-Pesa payments still marked pending (e.g. after a page
  // refresh, or when the confirmation arrives later) and apply the plan.
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
            const wasFree = planOf(me) === PLAN_FREE || planOf(me) !== rec.plan;
            setPaymentStatus(rec.id, "paid");
            if (PLAN_META[rec.plan] && planOf(me) !== rec.plan) {
              upgradePlan(rec.plan);
              toast("Payment received — your " + PLAN_META[rec.plan].name + " plan is active!");
            } else if (wasFree) {
              toast("Payment received — your plan is active!");
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
    if (!pendingPlan) return;
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
      const key = pendingPlan;
      const amount = usdToKes(planPrice(key).replace(/[^0-9.]/g, ""));
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending STK push...';
      fetch(base.replace(/\/+$/, "") + "/api/mpesa/stkpush", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, amount, plan: key, userId: me.id, email: me.email })
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
          banner("fa-mobile-screen-button", "Approve the payment", "Enter your M-Pesa PIN when prompted. We'll upgrade you as soon as it's confirmed.", () => {});
          pendingPlan = null;
          btn.disabled = false;
          pollMpesaStatus(base, checkoutId, key, rec.id, 0);
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
      toast("Deposit submitted — an admin will verify it and activate your plan.");
      pendingPlan = null;
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

  /* ---------------- tasks & earnings ---------------- */

  let activeTaskId = null;

  function balanceOf(u) { return Math.round((Number((u && u.balance) || 0)) * 100) / 100; }
  function money(n) { return "$" + (Math.round(n * 100) / 100).toFixed(2); }

  function showTasksView() {
    $("#tasks-gate").classList.add("hidden");
    $("#tasks-content").classList.remove("hidden");
    renderTasks();
  }

  function taskCardHtml(t) {
    const sub = t.subject;
    const hidden = planOf(me) !== PLAN_PROPLUS;
    const head = '<div class="tbl-user">' + avatarFor(sub, hidden) +
      '<div><div class="name' + (hidden ? " blurred" : "") + '">' + LC.fmt.esc(sub.name) + '</div><div class="sub">' + LC.fmt.esc(t.category) + '</div></div></div>';
    const reward = '<span class="task-reward">' + money(t.reward) + '</span>';
    if (t.status === "open") {
      return '<div class="task-card">' +
        '<div class="task-head">' + head + reward + '</div>' +
        '<div class="task-title">' + LC.fmt.esc(t.title) + '</div>' +
        '<p class="task-desc">' + LC.fmt.esc(t.description) + '</p>' +
        '<div class="task-foot"><span class="chip chip-open">Available</span>' +
        '<button class="btn btn-primary btn-sm" data-task="claim" data-id="' + t.id + '"><i class="fa-solid fa-hand"></i> Claim task</button></div>' +
        '</div>';
    }
    const mine = t.claimedBy && t.claimedBy.id === me.id;
    const status = t.status === "completed" ? '<span class="chip chip-done">Completed</span>' : '<span class="chip chip-go">In progress</span>';
    const actions = mine
      ? (t.status === "in_progress"
        ? '<button class="btn btn-outline btn-sm" data-task="chat" data-id="' + t.id + '"><i class="fa-solid fa-comment-dots"></i> Chat</button>' +
          '<button class="btn btn-primary btn-sm" data-task="complete" data-id="' + t.id + '"><i class="fa-solid fa-check"></i> Complete</button>'
        : '<button class="btn btn-outline btn-sm" data-task="chat" data-id="' + t.id + '"><i class="fa-solid fa-comment-dots"></i> Chat</button>')
      : "";
    return '<div class="task-card">' +
      '<div class="task-head">' + head + reward + '</div>' +
      '<div class="task-title">' + LC.fmt.esc(t.title) + '</div>' +
      '<p class="task-desc">' + LC.fmt.esc(t.description) + '</p>' +
      '<div class="task-foot">' + status + actions + '</div>' +
      '</div>';
  }

  function renderTasks() {
    const all = LC.db.tasks.get();
    const open = all.filter(t => t.status === "open");
    const mine = all.filter(t => t.claimedBy && t.claimedBy.id === me.id);
    $("#tasks-open-count").textContent = open.length + (open.length === 1 ? " task" : " tasks");
    $("#tasks-mine-count").textContent = mine.length + (mine.length === 1 ? " task" : " tasks");
    setHtml($("#tasks-open-list"), open.length
      ? '<div class="task-grid">' + open.map(taskCardHtml).join("") + '</div>'
      : '<div class="empty"><div class="big"><i class="fa-solid fa-list-check"></i></div><p>No open tasks right now. Check back soon.</p></div>');
    setHtml($("#tasks-mine-list"), mine.length
      ? '<div class="task-grid">' + mine.map(taskCardHtml).join("") + '</div>'
      : '<div class="empty"><div class="big"><i class="fa-solid fa-user-check"></i></div><p>You haven\'t claimed any tasks yet. Pick one above and start earning.</p></div>');
  }

  function claimTask(id) {
    if (planOf(me) !== PLAN_PROPLUS) {
      showClaimLocked();
      return;
    }
    const tasks = LC.db.tasks.get();
    const active = tasks.some(x => x.claimedBy && x.claimedBy.id === me.id && x.status === "in_progress");
    if (active) {
      toast("You already have a task in progress — complete it before claiming another.");
      return;
    }
    const t = tasks.find(x => x.id === id);
    if (!t || t.status !== "open") return;
    t.claimedBy = meRef();
    t.claimedAt = Date.now();
    t.status = "in_progress";
    LC.db.tasks.save(tasks);
    LC.rt.emit({ type: "tasks" });
    toast("Task claimed — chat with " + t.subject.name + " to get started.");
    renderTasks();
  }

  function showClaimLocked() {
    $("#claim-locked-modal").classList.add("open");
  }

  function completeTask(id) {
    const tasks = LC.db.tasks.get();
    const t = tasks.find(x => x.id === id);
    if (!t || t.status !== "in_progress" || !(t.claimedBy && t.claimedBy.id === me.id)) return;
    t.status = "completed";
    t.completedAt = Date.now();
    LC.db.tasks.save(tasks);
    me.balance = balanceOf(me) + t.reward;
    saveUser(me);
    LC.rt.emit({ type: "tasks" });
    toast(money(t.reward) + " paid into your account for \"" + t.title + "\".");
    renderTasks();
    renderEarnings();
  }

  function openTaskChat(id) {
    const t = LC.db.tasks.byId(id);
    if (!t) return;
    activeTaskId = id;
    $("#tc-title").textContent = "Chat with " + t.subject.name;
    $("#tc-sub").textContent = t.title + " \u00b7 " + t.category;
    markTaskRead(id);
    renderTaskChat();
    $("#task-chat-modal").classList.add("open");
  }

  function markTaskRead(id) {
    const msgs = LC.db.taskMessages.get();
    let changed = false;
    msgs.forEach(m => { if (m.conv === id && m.from.id !== me.id && !m.read) { m.read = true; changed = true; } });
    if (changed) LC.db.taskMessages.save(msgs);
  }

  function taskMsgs(id) {
    return LC.db.taskMessages.get().filter(m => m.conv === id).sort((a, b) => a.ts - b.ts);
  }

  function renderTaskChat() {
    if (!activeTaskId) return;
    const t = LC.db.tasks.byId(activeTaskId);
    const el = $("#tc-msgs");
    if (!el || !t) return;
    setHtml(el, buildMessagesHtml(taskMsgs(activeTaskId)) ||
      '<div class="empty" style="padding:30px"><p>Start the conversation \u2014 say hi to ' + LC.fmt.esc(t.subject.name) + '.</p></div>');
    el.scrollTop = el.scrollHeight;
  }

  function updateTaskChat() {
    if (!activeTaskId || !$("#task-chat-modal").classList.contains("open")) return;
    markTaskRead(activeTaskId);
    renderTaskChat();
  }

  function sendTaskMessage() {
    const input = $("#tc-input");
    const text = input.value.trim();
    if (!text || !activeTaskId) return;
    const t = LC.db.tasks.byId(activeTaskId);
    if (!t) return;
    const msgs = LC.db.taskMessages.get();
    msgs.push({
      id: LC.db.uid(),
      conv: activeTaskId,
      from: meRef(),
      to: { id: t.subject.id, type: t.subject.type, name: t.subject.name, avatar: t.subject.avatar },
      text, image: null, ts: Date.now(), read: false
    });
    LC.db.taskMessages.save(msgs);
    LC.rt.emit({ type: "task_msg" });
    if (t.subject.type === "user") {
      LC.notify({ id: t.subject.id, type: "user" }, meRef(), "message", meRef().name + " messaged you about your task");
    }
    input.value = "";
    renderTaskChat();
  }

  function openApplyModal() {
    const sel = $("#apply-service");
    if (sel.options.length === 0) LC.TASK_CATEGORIES.forEach(c => sel.add(new Option(c, c)));
    $("#apply-message").value = "";
    $("#apply-error").textContent = "";
    $("#apply-error").classList.remove("show");
    $("#apply-modal").classList.add("open");
    $("#apply-message").focus();
  }

  function submitApplication() {
    const service = $("#apply-service").value;
    const message = $("#apply-message").value.trim();
    if (!message) {
      $("#apply-error").textContent = "Please tell us a little about what you need.";
      $("#apply-error").classList.add("show");
      return;
    }
    const apps = LC.db.applications.get();
    apps.push({ id: LC.db.uid(), applicant: meRef(), service, message, status: "pending", createdAt: Date.now() });
    LC.db.applications.save(apps);
    LC.rt.emit({ type: "tasks" });
    $("#apply-modal").classList.remove("open");
    toast("Application submitted. An admin will review it and create a task for you.");
  }

  function renderEarnings() {
    const bal = balanceOf(me);
    $("#pf-balance").textContent = money(bal);
    const wd = LC.db.withdrawals.get().filter(w => w.user && w.user.id === me.id).sort((a, b) => b.createdAt - a.createdAt);
    const hist = $("#wd-history");
    if (!hist) return;
    hist.textContent = wd.length
      ? "Recent: " + wd.slice(0, 4).map(w => money(w.amount) + " via " + w.method + " (" + w.status + ")").join(" \u00b7 ")
      : "No withdrawals yet.";
  }

  function withdraw() {
    const amt = Math.round(parseFloat($("#wd-amount").value || "0") * 100) / 100;
    const method = $("#wd-method").value;
    if (!amt || amt <= 0) return toast("Enter an amount to withdraw", "error");
    if (amt > balanceOf(me)) return toast("Amount exceeds your balance", "error");
    const wds = LC.db.withdrawals.get();
    wds.push({ id: LC.db.uid(), user: meRef(), amount: amt, method, status: "pending", createdAt: Date.now() });
    LC.db.withdrawals.save(wds);
    me.balance = balanceOf(me) - amt;
    saveUser(me);
    LC.rt.emit({ type: "tasks" });
    $("#wd-amount").value = "";
    toast("Withdrawal requested \u2014 " + money(amt) + " via " + method + ".");
    renderEarnings();
  }

  function onTaskAction(e) {
    const btn = e.target.closest("[data-task]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.task === "claim") claimTask(id);
    else if (btn.dataset.task === "complete") completeTask(id);
    else if (btn.dataset.task === "chat") openTaskChat(id);
  }

  /* ---------------- view switching ---------------- */

  function showView(view, fromHistory) {
    currentView = view;
    ["discover", "tasks", "messages", "notifications", "profile"].forEach(v => {
      $("#view-" + v).classList.toggle("hidden", v !== view);
    });
    $$(".tab-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    const navMap = { discover: "nav-discover", tasks: "nav-tasks", messages: "nav-messages", notifications: "nav-notifications", profile: "nav-profile" };
    $$(".nav-links a").forEach(a => a.classList.remove("active"));
    if (navMap[view]) $("#" + navMap[view]).classList.add("active");
    if (view === "discover") { renderDiscover(); }
    if (view === "tasks") { showTasksView(); }
    if (view === "messages") { renderConversationList2(myConversations()); renderChat(); renderMsgBanner(); }
    if (view === "notifications") { markAllNotifsRead(); }
    if (view === "profile") renderProfile();
    // Record real (non-back-button-driven) navigation in the section history stack.
    if (!fromHistory && window.LC && LC.nav) LC.nav.go(view);
  }

  /* ---------------- realtime ---------------- */

  function refresh() {
    if (!me) return;
    me = LC.db.users.byId(me.id) || me;
    reconcilePendingPayments(false);
    if (currentView === "discover") { renderDiscover(); }
    if (currentView === "tasks") { renderTasks(); }
    if (currentView === "messages") {
      renderConversationList2(myConversations());
      if (activeConv) updateChatMessages();
    }
    if (currentView === "notifications") renderNotifications();
    if (currentView === "profile") { renderProfile(); }
    updateTaskChat();
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
  let lastFullPull = 0;

  // Silently re-fetch data from Supabase so messages arrive in near real time
  // even if the realtime websocket isn't delivering. No spinner, no flicker.
  function pullData() {
    if (pulling) return;
    pulling = true;
    const now = Date.now();
    const tables = ["messages"];
    if (now - lastFullPull > 6000) {
      tables.push("profiles", "users", "notifications", "sessions");
      lastFullPull = now;
    }
    Promise.resolve(LC.db.refresh(tables)).then(() => {
      pulling = false;
      refresh();
    }).catch(() => { pulling = false; });
  }

  function startRealtime() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pullData, 1500);
    LC.rt.on(() => refresh());
    window.addEventListener("focus", refresh);
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

    $("#top-avatar").src = me.avatar || LC.avatar.make(me.fullName);

    const doLogout = async () => {
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
        render: (v) => showView(v, true),
        onExit: doLogout,
        onWarn: (msg) => toast(msg, "warn")
      });
    }

    $("#nav-discover").onclick = (e) => { e.preventDefault(); showView("discover"); };
    $("#nav-messages").onclick = (e) => { e.preventDefault(); showView("messages"); };
    $("#nav-tasks").onclick = (e) => { e.preventDefault(); showView("tasks"); };
    $("#nav-notifications").onclick = (e) => { e.preventDefault(); showView("notifications"); };
    $("#nav-profile").onclick = (e) => { e.preventDefault(); showView("profile"); };
    $("#btn-profile").onclick = () => showView("profile");

    $$(".tab-item").forEach(b => b.onclick = () => showView(b.dataset.view));

    $("#discover-search").addEventListener("input", e => { discoverSearch = e.target.value; renderDiscover(); });
    $("#discover-gender").addEventListener("change", e => { genderFilter = e.target.value; renderDiscover(); });
    $("#discover-grid").addEventListener("click", onDiscoverAction);
    $("#btn-go-discover").onclick = () => showView("discover");
    $("#conv-list").addEventListener("click", e => {
      const go = e.target.closest("[data-action=go-discover]");
      if (go) { showView("discover"); return; }
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
    $("#pf-avatar-file").addEventListener("change", e => handleAvatarFile(e.target.files[0]));
    $("#plans-list").addEventListener("click", e => {
      const b = e.target.closest("[data-plan]");
      if (b) openPayModal(b.dataset.plan);
    });
    $("#pay-close").onclick = () => { $("#pay-modal").classList.remove("open"); pendingPlan = null; };
    $("#pay-modal").addEventListener("click", e => { if (e.target.id === "pay-modal") { $("#pay-modal").classList.remove("open"); pendingPlan = null; } });
    $("#pay-methods").addEventListener("click", e => {
      const b = e.target.closest("[data-method]");
      if (b) selectPayMethod(b.dataset.method);
    });
    $("#pay-submit").onclick = submitPayment;

    $("#btn-tasks-upgrade").onclick = () => showView("profile");
    $("#btn-apply-gate").onclick = openApplyModal;
    $("#btn-apply-service").onclick = openApplyModal;
    $("#apply-close").onclick = () => $("#apply-modal").classList.remove("open");
    $("#apply-modal").addEventListener("click", e => { if (e.target.id === "apply-modal") $("#apply-modal").classList.remove("open"); });
    $("#apply-submit").onclick = submitApplication;
    $("#tasks-open-list").addEventListener("click", onTaskAction);
    $("#tasks-mine-list").addEventListener("click", onTaskAction);
    $("#tc-close").onclick = () => $("#task-chat-modal").classList.remove("open");
    $("#task-chat-modal").addEventListener("click", e => { if (e.target.id === "task-chat-modal") $("#task-chat-modal").classList.remove("open"); });
    $("#tc-send").onclick = sendTaskMessage;
    $("#tc-input").addEventListener("keydown", e => { if (e.key === "Enter") sendTaskMessage(); });
    $("#btn-withdraw").onclick = withdraw;
    $("#cl-close").onclick = () => $("#claim-locked-modal").classList.remove("open");
    $("#claim-locked-modal").addEventListener("click", e => { if (e.target.id === "claim-locked-modal") $("#claim-locked-modal").classList.remove("open"); });
    $("#cl-upgrade").onclick = () => { $("#claim-locked-modal").classList.remove("open"); showView("profile"); };
    $("#cl-apply").onclick = () => { $("#claim-locked-modal").classList.remove("open"); openApplyModal(); };

    const params = new URLSearchParams(window.location.search);
    const requestedView = params.get("view");
    const setupMode = params.get("setup") === "1";
    const validViews = ["discover", "messages", "tasks", "notifications", "profile"];
    const initialView = validViews.includes(requestedView) ? requestedView : (setupMode ? "profile" : "discover");
    showView(initialView);
    if (setupMode) {
      if (window.history && history.replaceState) {
        history.replaceState(null, "", window.location.pathname + (initialView !== "discover" ? "?view=" + initialView : ""));
      }
      banner("fa-user-pen", "Complete your profile",
        "Pick a username, your age and gender so people know who they're talking to.", () => {});
    }
    startRealtime();
    reconcilePendingPayments(true);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
