(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let currentView = "overview";
  let activeConv = null;   // { key, profile, user }
  let profileFilter = "";
  let convDirFilter = "";  // "", "in", "out"
  let adminWdFilter = "pending"; // "pending" | "all" | "paid" | "rejected"
  let adminPayFilter = "";      // "" | "pending" | "binance" | "binance-pending"
  let notifPickUsers = [];
  let notifPickSelected = new Set();

  /* ---------------- helpers ---------------- */

  function avatarFor(entity) {
    const src = entity.avatar || LC.avatar.make(entity.fullName || entity.name || "?");
    return '<img class="avatar" src="' + LC.fmt.esc(src) + '" alt="">';
  }

  function setHtml(el, html) {
    if (el._lcHtml === html) return;
    el._lcHtml = html;
    el.innerHTML = html;
  }

  function toast(msg, type) {
    const wrap = $("#admin-toasts");
    const t = document.createElement("div");
    t.className = "toast" + (type ? " " + type : "");
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.remove(); }, 3200);
  }

  function profileRef(p) { return { id: p.id, type: "profile", name: p.fullName, avatar: p.avatar }; }
  function userRef(u) { return { id: u.id, type: "user" }; }

  /* ---------------- profile conversations ---------------- */

  function adminConversations() {
    const msgs = LC.db.messages.get();
    const byConv = {};
    msgs.forEach(m => {
      const involvesProfile = m.from.type === "profile" || m.to.type === "profile";
      if (!involvesProfile) return;
      byConv[m.conv] = byConv[m.conv] || { key: m.conv, msgs: [], last: 0, unread: 0 };
      byConv[m.conv].msgs.push(m);
      byConv[m.conv].last = Math.max(byConv[m.conv].last, m.ts);
      if (m.to.type === "profile" && !m.read) byConv[m.conv].unread++;
    });
    return Object.values(byConv).sort((a, b) => b.last - a.last);
  }

  function convRefs(conv) {
    const { a, b } = LC.convFrom(conv);
    const userPart = a.type === "user" ? a : b;
    const profPart = a.type === "profile" ? a : b;
    const user = LC.db.users.byId(userPart.id) || { id: userPart.id, fullName: "User", username: "user" };
    const profile = LC.db.profiles.byId(profPart.id) || { id: profPart.id, fullName: "Profile" };
    return { user, profile };
  }

  function convLastDir(cv) {
    let last = null;
    cv.msgs.forEach(m => { if (!last || m.ts > last.ts) last = m; });
    return last && last.from.type === "profile" ? "out" : "in";
  }

  function convLastMsg(cv) {
    return cv.msgs.slice().sort((a, b) => b.ts - a.ts)[0] || null;
  }

  function renderAdminConversationList() {
    const el = $("#admin-conv-list");
    let convs = adminConversations().filter(c => {
      if (!profileFilter) return true;
      return convRefs(c.key).profile.id === profileFilter;
    });
    updateDirCounts(convs);
    if (convDirFilter) convs = convs.filter(c => convLastDir(c) === convDirFilter);
    if (!convs.length) {
      setHtml(el, '<div class="empty"><div class="big"><i class="fa-solid fa-comment-dots"></i></div><p>No ' + (convDirFilter ? (convDirFilter === "in" ? "incoming" : "outgoing") : "") + ' conversations yet.</p></div>');
      return;
    }
    setHtml(el, convs.map(cv => {
      const { user, profile } = convRefs(cv.key);
      const last = convLastMsg(cv);
      const preview = last.image ? '<i class="fa-solid fa-image"></i> Photo' : LC.fmt.esc(last.text || "");
      const dir = convLastDir(cv);
      const dirBadge = '<span class="dir-badge ' + dir + '"><i class="fa-solid fa-' + (dir === "out" ? "arrow-up" : "arrow-down") + '"></i> ' + (dir === "out" ? "Outgoing" : "Incoming") + '</span>';
      const aiLast = (window.LC && LC.ai && LC.ai.repliedAt[cv.key]) || 0;
      const aiChip = aiLast && cv.last <= aiLast
        ? '<span class="dir-badge ai"><i class="fa-solid fa-robot"></i> AI</span>'
        : "";
      return '<div class="conv-item' + (activeConv && activeConv.key === cv.key ? " active" : "") + '" data-conv="' + cv.key + '">' +
        avatarFor(user) +
        '<div class="conv-meta">' +
        '<div class="conv-top"><span class="conv-name">' + LC.fmt.esc(user.fullName) + '</span><span class="conv-time">' + LC.fmt.time(cv.last) + '</span></div>' +
        '<div class="conv-preview">' + dirBadge + aiChip + ' <span>' + preview + '</span></div>' +
        '<div class="conv-preview" style="font-size:11.5px;color:var(--primary);font-weight:600">as @' + LC.fmt.esc(profile.username || "profile") + '</div>' +
        '</div>' +
        (cv.unread ? '<span class="unread-dot">' + cv.unread + '</span>' : "") +
        '</div>';
    }).join(""));
  }

  function updateDirCounts(convs) {
    const seg = $("#conv-dir-seg");
    if (!seg) return;
    const bAll = seg.querySelector('button[data-dir=""]');
    const bIn = seg.querySelector('button[data-dir="in"]');
    const bOut = seg.querySelector('button[data-dir="out"]');
    if (bAll) bAll.innerHTML = 'All <span class="seg-count">' + convs.length + '</span>';
    if (bIn) bIn.innerHTML = 'Incoming <span class="seg-count">' + convs.filter(c => convLastDir(c) === "in").length + '</span>';
    if (bOut) bOut.innerHTML = 'Outgoing <span class="seg-count">' + convs.filter(c => convLastDir(c) === "out").length + '</span>';
  }

  function openAdminConversation(key) {
    const { user, profile } = convRefs(key);
    activeConv = { key, user, profile };
    markAdminConvRead(key);
    renderAdminConvHeader();
    renderAdminConvMessages();
    $("#aconv-chat-modal").classList.add("open");
    $("#acm-input").focus();
    renderAdminConversationList();
  }

  function markAdminConvRead(key) {
    const msgs = LC.db.messages.get();
    let changed = false;
    msgs.forEach(m => { if (m.conv === key && m.to.type === "profile" && !m.read) { m.read = true; changed = true; } });
    if (changed) { LC.db.messages.save(msgs); LC.rt.emit({ type: "read" }); }
  }

  function adminMessagesHtml(msgs) {
    let html = "";
    let lastDay = "";
    msgs.forEach(m => {
      const day = LC.fmt.day(m.ts);
      if (day !== lastDay) { html += '<div class="day-divider">' + day + '</div>'; lastDay = day; }
      const mine = m.from.type === "profile";
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

  function renderAdminConvHeader() {
    if (!activeConv) return;
    const { user, profile } = activeConv;
    $("#acm-avatar").src = user.avatar || LC.avatar.make(user.fullName || "?");
    $("#acm-title").textContent = user.fullName;
    $("#acm-sub").innerHTML = "Replying as <b>@" + LC.fmt.esc(profile.username) + "</b> (" + LC.fmt.esc(profile.fullName) + ")";
    $("#acm-input").placeholder = "Reply as @" + LC.fmt.esc(profile.username) + "...";
  }

  function renderAdminConvMessages() {
    const scroll = $("#acm-msgs");
    if (!scroll || !activeConv) return;
    const msgs = LC.db.messages.get().filter(m => m.conv === activeConv.key).sort((a, b) => a.ts - b.ts);
    const html = adminMessagesHtml(msgs) || '<div class="empty" style="padding:40px"><p>No messages yet — say hello on behalf of this profile.</p></div>';
    if (scroll._lcHtml === html) return;
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
    setHtml(scroll, html);
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  function sendAsProfile() {
    const input = $("#acm-input");
    const text = input.value.trim();
    if (!text || !activeConv) return;
    const { user, profile } = activeConv;
    const msg = {
      id: LC.db.uid(),
      conv: activeConv.key,
      from: profileRef(profile),
      to: userRef(user),
      text, image: null, ts: Date.now(), read: false
    };
    const msgs = LC.db.messages.get();
    msgs.push(msg);
    LC.db.messages.save(msgs);

    const profiles = LC.db.profiles.get();
    const p = profiles.find(x => x.id === profile.id);
    if (p) { p.online = true; p.lastActive = Date.now(); }
    LC.db.profiles.save(profiles);

    LC.notify({ id: user.id, type: "user" }, profileRef(profile), "message", profile.fullName + " sent you a message");
    LC.rt.emit({ type: "message" });

    input.value = "";
    renderAdminConvMessages();
    renderAdminConversationList();
  }

  /* ---------------- profiles management ---------------- */

  function profileStats(p) {
    const follows = LC.db.follows.get();
    const following = follows.filter(f => f.follower.type === "profile" && f.follower.id === p.id).length;
    const followers = follows.filter(f => f.target.type === "profile" && f.target.id === p.id).length;
    const msgs = LC.db.messages.get();
    const convs = new Set();
    msgs.forEach(m => {
      if ((m.from.type === "profile" && m.from.id === p.id) || (m.to.type === "profile" && m.to.id === p.id)) convs.add(m.conv);
    });
    return { following, followers, convs: convs.size };
  }

  function renderProfilesTable() {
    const profiles = LC.db.profiles.get();
    const tbody = $("#profiles-table");
    if (!profiles.length) {
      setHtml(tbody, '<tr><td colspan="8" class="empty">No profiles yet. Click "+ New Profile" to create one.</td></tr>');
      return;
    }
    setHtml(tbody, profiles.map(p => {
      const s = profileStats(p);
      const listed = p.listed === true;
      const toggleBtn = listed
        ? '<button class="btn btn-success btn-sm" data-act="toggle-list" data-id="' + p.id + '"><i class="fa-solid fa-eye"></i> In Discover</button>'
        : '<button class="btn btn-outline btn-sm" data-act="toggle-list" data-id="' + p.id + '"><i class="fa-solid fa-eye-slash"></i> Hidden</button>';
      return '<tr>' +
        '<td><div class="tbl-user">' + avatarFor(p) + '<div><div class="name">' + LC.fmt.esc(p.fullName) + (listed ? "" : ' <span class="hidden-badge">Admin only</span>') + '</div><div class="sub">@' + LC.fmt.esc(p.username) + ' · ' + LC.fmt.esc(p.email) + '</div></div></div></td>' +
        '<td>' + LC.fmt.esc(p.gender) + '</td>' +
        '<td>' + p.age + '</td>' +
        '<td>' + s.following + '</td>' +
        '<td>' + s.followers + '</td>' +
        '<td>' + s.convs + '</td>' +
        '<td>' + toggleBtn + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
        '<button class="btn btn-outline btn-sm" data-act="edit" data-id="' + p.id + '">Edit</button> ' +
        '<button class="btn btn-danger btn-sm" data-act="del" data-id="' + p.id + '">Delete</button>' +
        '</td></tr>';
    }).join(""));
  }

  function toggleProfileListed(id) {
    const profiles = LC.db.profiles.get();
    const p = profiles.find(x => x.id === id);
    if (!p) return;
    p.listed = p.listed === true ? false : true;
    if (p.listed) p.listedAt = Date.now();
    LC.db.profiles.save(profiles);
    LC.rt.emit({ type: "profiles" });
    toast(p.listed ? '@' + p.username + ' is now in Discover' : '@' + p.username + ' hidden from Discover');
    renderProfilesTable();
  }

  function openProfileModal(id) {
    const editing = id ? LC.db.profiles.byId(id) : null;
    $("#pm-title").textContent = editing ? "Edit Profile — " + editing.fullName : "New Profile";
    $("#pm-fullname").value = editing ? editing.fullName : "";
    $("#pm-username").value = editing ? editing.username : "";
    $("#pm-age").value = editing ? editing.age : "";
    $("#pm-gender").value = editing ? editing.gender : "Female";
    $("#pm-online").value = editing ? String(editing.online) : "true";
    $("#pm-email").value = editing ? editing.email : "";
    $("#pm-about").value = editing ? editing.about || "" : "";
    const pmListed = $("#pm-listed");
    if (pmListed) pmListed.checked = editing ? editing.listed !== false : false;
    $("#pm-avatar-url").value = editing ? (editing.avatar && editing.avatar.indexOf("http") === 0 ? editing.avatar : "") : "";
    $("#pm-avatar-preview").src = editing ? (editing.avatar || LC.avatar.make(editing.fullName)) : LC.avatar.make("+");
    $("#pm-error").classList.remove("show");
    $("#profile-form").dataset.editId = editing ? editing.id : "";
    $("#pm-avatar-file").value = "";
    $("#profile-modal").classList.add("open");
  }

  function saveProfileFromModal() {
    const fullName = $("#pm-fullname").value.trim();
    const username = $("#pm-username").value.trim().toLowerCase();
    const age = parseInt($("#pm-age").value, 10);
    const gender = $("#pm-gender").value;
    const online = $("#pm-online").value === "true";
    const email = $("#pm-email").value.trim().toLowerCase();
    const about = $("#pm-about").value.trim();
    const editId = $("#profile-form").dataset.editId;
    const err = $("#pm-error");

    const fail = (m) => { err.textContent = m; err.classList.add("show"); };
    if (fullName.length < 3) return fail("Full name must be at least 3 characters.");
    if (username.length < 3) return fail("Username must be at least 3 characters.");
    if (!age || age < 13 || age > 120) return fail("Enter a valid age (13-120).");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter a valid email.");

    const profiles = LC.db.profiles.get();
    const usernameTaken = profiles.some(p => p.username.toLowerCase() === username && p.id !== editId);
    if (usernameTaken) return fail("That username is already used.");
    if (LC.db.users.byUsername(username)) return fail("That username is already used by a member.");

    const listed = !!($("#pm-listed") && $("#pm-listed").checked);
    const data = {
      username, fullName, age, gender, email, about,
      avatar: $("#pm-avatar-url").value.trim() || LC.avatar.make(fullName),
      online, listed,
      listedAt: listed ? Date.now() : undefined,
      lastActive: Date.now()
    };

    if (editId) {
      const p = profiles.find(x => x.id === editId);
      if (p) Object.assign(p, data);
      LC.db.profiles.save(profiles);
      toast("Profile updated");
    } else {
      data.id = LC.db.uid();
      data.password = "profile123";
      data.createdAt = Date.now();
      profiles.push(data);
      LC.db.profiles.save(profiles);
      toast("Profile created");
    }
    LC.rt.emit({ type: "profiles" });
    $("#profile-modal").classList.remove("open");
    renderProfilesTable();
    populateProfileFilter();
  }

  function deleteProfile(id) {
    const p = LC.db.profiles.byId(id);
    if (!p) return;
    if (!confirm("Delete profile \"" + p.fullName + "\"?\nAll of its conversations, follows and notifications will be removed too.")) return;
    LC.db.profiles.save(LC.db.profiles.get().filter(x => x.id !== id));
    LC.db.messages.save(LC.db.messages.get().filter(m =>
      !((m.from.type === "profile" && m.from.id === id) || (m.to.type === "profile" && m.to.id === id))));
    LC.db.follows.save(LC.db.follows.get().filter(f => !((f.follower.type === "profile" && f.follower.id === id) || (f.target.type === "profile" && f.target.id === id))));
    LC.db.notifications.save(LC.db.notifications.get().filter(n => !((n.recipient.type === "profile" && n.recipient.id === id) || (n.from.type === "profile" && n.from.id === id))));
    if (activeConv && activeConv.profile.id === id) {
      activeConv = null;
      $("#aconv-chat-modal").classList.remove("open");
    }
    LC.rt.emit({ type: "profiles" });
    toast("Profile deleted");
    renderProfilesTable();
    populateProfileFilter();
    renderAdminConversationList();
  }

  function populateProfileFilter() {
    const sel = $("#conv-profile-filter");
    const current = sel.value;
    sel.innerHTML = '<option value="">All profiles</option>' +
      LC.db.profiles.get().map(p => '<option value="' + p.id + '">' + LC.fmt.esc(p.fullName) + '</option>').join("");
    const opts = Array.from(sel.options || []);
    if (opts.some(o => o.value === current)) sel.value = current;
  }

  /* ---------------- follow requests (notifications) ---------------- */

  function renderAdminNotifications() {
    const el = $("#admin-notif-list");
    const list = LC.db.notifications.get().filter(n => n.recipient.type === "profile" && n.kind === "follow");
    if (!list.length) {
      setHtml(el, '<div class="empty"><div class="big"><i class="fa-solid fa-bell"></i></div><p>No follow requests yet. When a user follows one of your profiles, it appears here.</p></div>');
      return;
    }
    setHtml(el, list.map(n => {
      const following = LC.db.follows.exists({ id: n.recipient.id, type: "profile" }, { id: n.from.id, type: "user" });
      const profile = LC.db.profiles.byId(n.recipient.id);
      const btn = following
        ? '<span class="btn btn-ghost btn-sm" style="cursor:default"><i class="fa-solid fa-check"></i> Following</span>'
        : '<button class="btn btn-primary btn-sm" data-act="followback" data-nid="' + n.id + '">Follow Back</button>';
      return '<div class="notif-item">' +
        avatarFor(n.from) +
        '<div class="notif-body"><div class="ntext"><b>' + LC.fmt.esc(n.from.name) + '</b> followed <b>@' + LC.fmt.esc((profile && profile.username) || "profile") + '</b></div>' +
        '<div class="ntime">' + LC.fmt.ago(n.ts) + '</div></div>' +
        btn +
        '</div>';
    }).join(""));
  }

  function followBack(nid) {
    const n = LC.db.notifications.get().find(x => x.id === nid);
    if (!n) return;
    const profile = LC.db.profiles.byId(n.recipient.id);
    const user = LC.db.users.byId(n.from.id);
    if (!profile || !user) return toast("User or profile no longer exists", "error");

    const follows = LC.db.follows.get();
    follows.push({ id: LC.db.uid(), follower: { id: profile.id, type: "profile", name: profile.fullName, avatar: profile.avatar }, target: { id: user.id, type: "user" }, ts: Date.now() });
    LC.db.follows.save(follows);
    LC.notify({ id: user.id, type: "user" }, profileRef(profile), "follow_back", profile.fullName + " followed you back");
    LC.rt.emit({ type: "follow" });
    n.read = true;
    const notifs = LC.db.notifications.get();
    const i = notifs.findIndex(x => x.id === n.id);
    if (i >= 0) { notifs[i] = n; LC.db.notifications.save(notifs); }
    toast("You followed back @" + user.username);
    renderAdminNotifications();
  }

  /* ---------------- members (sign-ups) ---------------- */

  function planBadgeHtml(u) {
    const st = LC.db.rewards.state(u);
    return st.activated
      ? '<span class="plan-badge proplus">Activated</span>'
      : '<span class="plan-badge free">Inactive</span>';
  }

  function renderMembersTable() {
    const users = LC.db.users.get().slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const tbody = $("#members-table");
    const count = $("#members-count");
    if (count) count.textContent = users.length + (users.length === 1 ? " member" : " members");
    if (!users.length) {
      setHtml(tbody, '<tr><td colspan="7" class="empty">No one has signed up yet. When someone creates an account in the app, they appear here.</td></tr>');
      return;
    }
    const sessNow = LC.db.session.get();
    setHtml(tbody, users.map(u => {
      const listed = u.listed === true;
      const isAdmin = u.role === "admin";
      const isSelf = !!(sessNow && sessNow.id === u.id);
      const st = LC.db.rewards.state(u);
      const roleBtn = isSelf ? "" : (isAdmin
        ? '<button class="btn btn-outline btn-sm" data-act="m-role" data-id="' + u.id + '" data-role="client"><i class="fa-solid fa-user"></i> Make client</button> '
        : '<button class="btn btn-outline btn-sm" data-act="m-role" data-id="' + u.id + '" data-role="admin"><i class="fa-solid fa-user-shield"></i> Make admin</button> ');
      const toggleBtn = listed
        ? '<button class="btn btn-success btn-sm" data-act="m-toggle" data-id="' + u.id + '"><i class="fa-solid fa-eye"></i> In Discover</button>'
        : '<button class="btn btn-outline btn-sm" data-act="m-toggle" data-id="' + u.id + '"><i class="fa-solid fa-eye-slash"></i> Hidden</button>';
      return '<tr>' +
        '<td><div class="tbl-user">' + avatarFor(u) + '<div><div class="name">' + LC.fmt.esc(u.fullName) + (isAdmin ? ' <span class="plan-badge proplus">Admin</span>' : '') + (isSelf ? ' <span class="hidden-badge">You</span>' : '') + (listed ? "" : ' <span class="hidden-badge">Hidden from Discover</span>') + '</div><div class="sub">@' + LC.fmt.esc(u.username) + ' · ' + LC.fmt.esc(u.email) + '</div></div></div></td>' +
        '<td>' + u.age + '</td>' +
        '<td>' + LC.fmt.esc(u.gender) + '</td>' +
        '<td><b>' + Math.round(st.points).toLocaleString() + '</b> pts</td>' +
        '<td>' + planBadgeHtml(u) + '</td>' +
        '<td>' + toggleBtn + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' + roleBtn +
        '<button class="btn btn-primary btn-sm" data-act="m-msg" data-id="' + u.id + '"><i class="fa-solid fa-paper-plane"></i> Message</button>' +
        '</td></tr>';
    }).join(""));
  }

  function toggleMemberListed(id) {
    const users = LC.db.users.get();
    const u = users.find(x => x.id === id);
    if (!u) return;
    u.listed = u.listed === true ? false : true;
    if (u.listed) u.listedAt = Date.now();
    LC.db.users.save(users);
    LC.rt.emit({ type: "profiles" });
    toast(u.listed ? '@' + u.username + ' is now in Discover' : '@' + u.username + ' hidden from Discover');
    renderMembersTable();
  }

  function setMemberRole(id, role) {
    if (role !== "admin" && role !== "client") return;
    const sess = LC.db.session.get();
    if (sess && sess.id === id) return toast("You can't change your own role.", "error");
    const users = LC.db.users.get();
    const u = users.find(x => x.id === id);
    if (!u || (u.role === "admin") === (role === "admin")) return;
    if (role === "client" && users.filter(x => x.role === "admin").length <= 1) {
      return toast("At least one admin is required.", "error");
    }
    const msg = role === "admin"
      ? "Make @" + u.username + " an admin? They will get full access to this dashboard."
      : "Make @" + u.username + " a client? They will lose access to this dashboard.";
    if (!confirm(msg)) return;
    u.role = role;
    LC.db.users.save(users);
    LC.rt.emit({ type: "admins" });
    toast("@" + u.username + " is now " + (role === "admin" ? "an admin" : "a client"));
    renderMembersTable();
    renderAdmins();
  }

  function openMemberChat(id) {
    const u = LC.db.users.byId(id);
    if (!u) return;
    const sel = $("#msg-as-profile");
    const listed = LC.db.profiles.get().filter(p => p.listed === true);
    if (!listed.length) {
      toast("Add a profile to Discover first, then you can message members as them.", "error");
      return;
    }
    sel.innerHTML = listed.map(p => '<option value="' + p.id + '">@' + LC.fmt.esc(p.username) + ' (' + LC.fmt.esc(p.fullName) + ')</option>').join("");
    $("#msg-target-name").textContent = "@" + u.username;
    $("#msg-error").classList.remove("show");
    $("#msg-modal").dataset.uid = u.id;
    $("#msg-modal").classList.add("open");
  }

  function startMemberChat() {
    const uid = $("#msg-modal").dataset.uid;
    const u = LC.db.users.byId(uid);
    const pid = $("#msg-as-profile").value;
    const p = LC.db.profiles.byId(pid);
    const err = $("#msg-error");
    if (!u || !p) { err.textContent = "Select a profile to message as."; err.classList.add("show"); return; }
    err.classList.remove("show");
    $("#msg-modal").classList.remove("open");
    const key = LC.convKey({ id: p.id, type: "profile" }, { id: u.id, type: "user" });
    showView("conversations");
    openAdminConversation(key);
    toast("Message @" + u.username + " as @" + p.username);
  }

  /* ---------------- member notifications ---------------- */

  function currentAdminRef() {
    const sess = LC.db.session.get();
    const admin = sess ? LC.db.users.byId(sess.id) : null;
    if (!admin) return { id: "admin", type: "user", name: "Hearth Admin", avatar: "" };
    return { id: admin.id, type: "user", name: admin.fullName || admin.username, avatar: admin.avatar };
  }

  function renderNotifPickList() {
    const wrap = $("#notif-pick-list");
    const q = ($("#notif-pick-search").value || "").trim().toLowerCase();
    const users = notifPickUsers.filter(u =>
      !q
      || (u.fullName || "").toLowerCase().indexOf(q) !== -1
      || (u.username || "").toLowerCase().indexOf(q) !== -1
      || (u.email || "").toLowerCase().indexOf(q) !== -1
    );
    if (!users.length) {
      setHtml(wrap, '<p class="muted" style="padding:10px;font-size:13px">' + (notifPickUsers.length ? "No members match your search." : "No members have signed up yet.") + '</p>');
      return;
    }
    setHtml(wrap, users.map(u =>
      '<label class="check notif-pick"><input type="checkbox" value="' + u.id + '"' + (notifPickSelected.has(u.id) ? " checked" : "") + '>' +
      avatarFor(u) +
      '<span>' + LC.fmt.esc(u.fullName) + ' <span class="muted">@' + LC.fmt.esc(u.username) + '</span></span></label>'
    ).join(""));
  }

  function openNotifModal() {
    const users = LC.db.users.get();
    notifPickUsers = users;
    notifPickSelected = new Set();
    $("#notif-pick-search").value = "";
    renderNotifPickList();
    $("#notif-message").value = "";
    $("#notif-error").classList.remove("show");
    $$("#notif-target-seg button").forEach(b => b.classList.toggle("active", b.dataset.target === "all"));
    $("#notif-pick-wrap").style.display = "none";
    $("#notif-modal").classList.add("open");
  }

  function sendNotification() {
    const text = $("#notif-message").value.trim();
    const err = $("#notif-error");
    if (!text) { err.textContent = "Write a message first."; err.classList.add("show"); return; }
    const users = LC.db.users.get();
    let recipients;
    const target = $("#notif-target-seg").querySelector(".active").dataset.target;
    if (target === "all") {
      recipients = users;
    } else {
      recipients = users.filter(u => notifPickSelected.has(u.id));
    }
    if (!recipients.length) { err.textContent = "Choose at least one member."; err.classList.add("show"); return; }
    const from = currentAdminRef();
    recipients.forEach(u => LC.notify({ id: u.id, type: "user" }, from, "announcement", text));
    $("#notif-modal").classList.remove("open");
    toast("Notification sent to " + recipients.length + (recipients.length === 1 ? " member" : " members"));
  }

  /* ---------------- payments & withdrawals ---------------- */

  function memberName(ref) {
    if (!ref) return "Member";
    if (ref.type === "profile") { const p = LC.db.profiles.byId(ref.id); return p ? p.fullName : (ref.name || "Profile"); }
    const u = LC.db.users.byId(ref.id);
    return u ? u.fullName : (ref.name || "Member");
  }

  function userName(ref) {
    if (!ref) return "?";
    if (ref.type === "profile") { const p = LC.db.profiles.byId(ref.id); return p ? p.username : "profile"; }
    const u = LC.db.users.byId(ref.id);
    return u ? u.username : "member";
  }

  function paymentAmountLabel(p) {
    if (p.method === "mpesa") return "Ksh " + Math.round(Number(p.amount || 0)).toLocaleString();
    return LC.db.rewards.moneyIn(Number(p.amount || 0), p.currency || LC.db.rewards.activationInfo().currency);
  }

  function activateMemberRecord(u) {
    if (!u) return;
    const st = LC.db.rewards.state(u);
    st.activated = true;
    st.activatedAt = Date.now();
    LC.db.rewards.setState(u, st);
    u.lastActive = Date.now();
  }

  function adminPaymentRow(p) {
    const st = p.status === "pending"
      ? '<span class="chip chip-go">Pending</span>'
      : p.status === "paid"
      ? '<span class="chip chip-done">Paid</span>'
      : '<span class="chip chip-open">Failed</span>';
    const actions = '<button class="btn btn-primary btn-sm" data-act="pay-upgrade" data-id="' + p.id + '"><i class="fa-solid fa-circle-check"></i> Activate</button> ' +
      (p.status === "pending"
        ? '<button class="btn btn-danger btn-sm" data-act="pay-reject" data-id="' + p.id + '">Reject</button>'
        : "");
    return '<tr>' +
      '<td><div class="tbl-user">' + avatarFor(p.user) + '<div><div class="name">' + LC.fmt.esc(memberName(p.user)) + '</div><div class="sub">@' + LC.fmt.esc(userName(p.user)) + '</div></div></div></td>' +
      '<td>' + LC.fmt.esc(p.methodName || p.method) + '</td>' +
      '<td>Account activation</td>' +
      '<td><b>' + paymentAmountLabel(p) + '</b></td>' +
      '<td style="max-width:200px;word-break:break-all">' + LC.fmt.esc(p.ref || "") + '</td>' +
      '<td class="muted">' + LC.fmt.ago(p.ts) + '</td>' +
      '<td>' + st + '</td>' +
      '<td style="text-align:right;white-space:nowrap">' + actions + '</td></tr>';
  }

  function verifyPayment(id) {
    const payments = LC.db.payments.get();
    const p = payments.find(x => x.id === id);
    if (!p || p.status !== "pending") return;
    const u = LC.db.users.byId(p.user.id);
    if (!u) return toast("Member no longer exists", "error");
    if (!confirm("Verify the " + p.methodName + " deposit from " + u.fullName + " and activate their account?")) return;
    const users = LC.db.users.get();
    const t = users.find(x => x.id === u.id);
    activateMemberRecord(t);
    LC.db.users.save(users);
    p.status = "paid";
    LC.db.payments.save(payments);
    LC.rt.emit({ type: "payments" });
    LC.rt.emit({ type: "profiles" });
    toast("Deposit verified \u2014 " + u.fullName + "'s account is now active");
    renderPayments();
    renderMembersTable();
  }

  function upgradeFromPayment(id) {
    const payments = LC.db.payments.get();
    const p = payments.find(x => x.id === id);
    if (!p) return;
    const u = LC.db.users.byId(p.user.id);
    if (!u) return toast("Member no longer exists", "error");
    if (!confirm("Activate " + u.fullName + "'s account for this payment via " + (p.methodName || p.method) + "?")) return;
    const users = LC.db.users.get();
    const t = users.find(x => x.id === u.id);
    activateMemberRecord(t);
    LC.db.users.save(users);
    if (p.status !== "paid") { p.status = "paid"; LC.db.payments.save(payments); }
    LC.rt.emit({ type: "payments" });
    LC.rt.emit({ type: "profiles" });
    toast(u.fullName + "'s account is now active");
    renderPayments();
    renderMembersTable();
  }

  function rejectPayment(id) {
    const payments = LC.db.payments.get();
    const p = payments.find(x => x.id === id);
    if (!p || p.status !== "pending") return;
    if (!confirm("Reject this deposit? The member will not be activated.")) return;
    p.status = "failed";
    LC.db.payments.save(payments);
    LC.rt.emit({ type: "payments" });
    toast("Deposit rejected");
    renderPayments();
  }

  function renderPayments() {
    const el = $("#admin-payments-body");
    const badge = $("#admin-pay-badge");
    const pending = LC.db.payments.get().filter(p => p.status === "pending").length;
    if (badge) { badge.classList.toggle("hidden", pending === 0); badge.textContent = pending; }

    let pays = LC.db.payments.get().slice();
    if (adminPayFilter === "pending") pays = pays.filter(p => p.status === "pending");
    if (adminPayFilter === "binance") pays = pays.filter(p => p.method === "binance");
    if (adminPayFilter === "binance-pending") pays = pays.filter(p => p.method === "binance" && p.status === "pending");
    // Sort Binance + pending first so what needs action sits on top.
    const pri = p => (p.method === "binance" && p.status === "pending" ? 0
      : p.method === "binance" ? 1
      : p.status === "pending" ? 2 : 3);
    pays = pays.sort((a, b) => pri(a) - pri(b) || b.ts - a.ts);

    setHtml(el, pays.length
      ? '<div style="overflow-x:auto"><table class="table"><thead><tr><th>Member</th><th>Method</th><th>Purpose</th><th>Amount</th><th>Reference</th><th>When</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>' +
        pays.map(adminPaymentRow).join("") + '</tbody></table></div>'
      : '<div class="empty" style="padding:40px"><div class="big"><i class="fa-solid fa-credit-card"></i></div><p>No payments here yet. Binance deposits appear below for you to verify and activate.</p></div>');
  }

  function markWithdrawalPaid(id) {
    const wds = LC.db.withdrawals.get();
    const w = wds.find(x => x.id === id);
    if (!w || w.status !== "pending") return;
    w.status = "paid";
    w.paidAt = Date.now();
    LC.db.withdrawals.save(wds);
    if (w.user && w.user.type === "user") {
      LC.notify({ id: w.user.id, type: "user" }, currentAdminRef(), "announcement",
        "Your withdrawal of " + LC.db.rewards.money(w.amount) + " via " + w.method + " has been paid.");
    }
    LC.rt.emit({ type: "withdrawals" });
    toast("Withdrawal marked as paid");
    renderWithdrawals();
  }

  function rejectWithdrawal(id) {
    const wds = LC.db.withdrawals.get();
    const w = wds.find(x => x.id === id);
    if (!w || w.status !== "pending") return;
    if (!confirm("Reject this " + LC.db.rewards.money(w.amount) + " withdrawal? The amount will be refunded to the member's balance.")) return;
    // The amount was taken off the balance when they requested it, so give it back.
    const users = LC.db.users.get();
    const u = users.find(x => x.id === (w.user && w.user.id));
    if (u) {
      u.balance = Math.round((Number(u.balance || 0) + w.amount) * 100) / 100;
      LC.db.users.save(users);
    }
    w.status = "rejected";
    w.rejectedAt = Date.now();
    LC.db.withdrawals.save(wds);
    if (u) {
      LC.notify({ id: u.id, type: "user" }, currentAdminRef(), "announcement",
        "Your withdrawal of " + LC.db.rewards.money(w.amount) + " was not approved. The amount was returned to your balance.");
    }
    LC.rt.emit({ type: "withdrawals" });
    toast(u ? "Withdrawal rejected \u2014 " + LC.db.rewards.money(w.amount) + " refunded" : "Withdrawal rejected (member account not found, nothing refunded)", u ? undefined : "error");
    renderWithdrawals();
  }

  function updateWithdrawalBadge() {
    const badge = $("#admin-wd-badge");
    if (!badge) return;
    const n = LC.db.withdrawals.get().filter(w => w.status === "pending").length;
    badge.classList.toggle("hidden", n === 0);
    badge.textContent = n;
  }

  function renderWithdrawals() {
    const el = $("#admin-withdrawals-body");
    if (!el) return;
    updateWithdrawalBadge();
    const all = LC.db.withdrawals.get();
    const pending = all.filter(w => w.status === "pending");
    const seg = $("#wd-filter-seg");
    if (seg) {
      const pb = seg.querySelector('button[data-wdfilter="pending"]');
      if (pb) pb.innerHTML = 'Pending <span class="seg-count">' + pending.length + '</span>';
    }
    let wds = all.slice();
    if (adminWdFilter !== "all") wds = wds.filter(w => w.status === adminWdFilter);
    // Oldest pending first (first come, first paid); everything else newest first.
    wds.sort((a, b) => adminWdFilter === "pending" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);
    if (!wds.length) {
      setHtml(el, '<div class="empty" style="padding:40px"><div class="big"><i class="fa-solid fa-money-bill-transfer"></i></div><p>' +
        (adminWdFilter === "pending" ? "No pending withdrawals." : "No withdrawals here.") + '</p></div>');
      return;
    }
    setHtml(el, '<div style="overflow-x:auto"><table class="table"><thead><tr><th>Member</th><th>Amount</th><th>Method</th><th>Requested</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>' +
      wds.map(w => {
        const st = w.status === "pending" ? '<span class="chip chip-go">Pending</span>'
          : w.status === "rejected" ? '<span class="chip chip-open">Rejected</span>'
          : '<span class="chip chip-done">Paid</span>';
        const actions = w.status === "pending"
          ? '<button class="btn btn-success btn-sm" data-act="wd-pay" data-id="' + w.id + '"><i class="fa-solid fa-check"></i> Mark paid</button> ' +
            '<button class="btn btn-danger btn-sm" data-act="wd-reject" data-id="' + w.id + '">Reject</button>'
          : "";
        return '<tr>' +
          '<td><div class="tbl-user">' + avatarFor(w.user) + '<div><div class="name">' + LC.fmt.esc(memberName(w.user)) + '</div><div class="sub">@' + LC.fmt.esc(userName(w.user)) + '</div></div></div></td>' +
          '<td><b>' + LC.db.rewards.money(w.amount) + '</b></td>' +
          '<td>' + LC.fmt.esc(w.method) + (w.details ? '<div class="sub" style="word-break:break-all;user-select:all">' + LC.fmt.esc(w.details) + '</div>' : '') + '</td>' +
          '<td class="muted">' + LC.fmt.ago(w.createdAt) + '</td>' +
          '<td>' + st + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' + actions + '</td></tr>';
      }).join("") + '</tbody></table></div>');
  }

  function onAdminPaymentAction(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "wd-pay") markWithdrawalPaid(btn.dataset.id);
    if (btn.dataset.act === "wd-reject") rejectWithdrawal(btn.dataset.id);
    if (btn.dataset.act === "pay-verify") verifyPayment(btn.dataset.id);
    if (btn.dataset.act === "pay-upgrade") upgradeFromPayment(btn.dataset.id);
    if (btn.dataset.act === "pay-reject") rejectPayment(btn.dataset.id);
  }

  /* ---------------- AI assistant ---------------- */

  function renderAiView() {
    const cfg = LC.db.aiConfig.get();
    $("#ai-enabled").checked = cfg.enabled === true;
    $("#ai-provider").value = cfg.provider || "";
    $("#ai-model").value = cfg.model || "";
    $("#ai-api-key").value = cfg.apiKey || "";
    $("#ai-delay-min").value = cfg.delayMin;
    $("#ai-delay-max").value = cfg.delayMax;
    $("#ai-lead-enabled").checked = cfg.leadEnabled === true;
    $("#ai-lead-min").value = cfg.leadIntervalMin;
    $("#ai-lead-max").value = cfg.leadIntervalMax;
    renderKbEditor();
    updateAiStatus();
  }

  function kbReplyRow(text) {
    const esc = LC.fmt.esc;
    return '<div class="kb-reply-row">' +
      '<input class="input kb-reply-input" type="text" value="' + esc(text || "") + '" placeholder="A reply the AI can send...">' +
      '<button type="button" class="btn btn-ghost btn-sm kb-reply-del" title="Remove reply"><i class="fa-solid fa-xmark"></i></button>' +
      '</div>';
  }

  function kbEditorCard(item) {
    const esc = LC.fmt.esc;
    return '<div class="kb-card" data-kbid="' + esc(item.id) + '">' +
      '<div class="kb-card-head">' +
      '<input class="input kb-intent" type="text" value="' + esc(item.intent || "") + '" placeholder="Topic name (e.g. greeting)">' +
      '<button class="btn btn-danger btn-sm kb-del" title="Delete topic"><i class="fa-solid fa-trash"></i></button>' +
      '</div>' +
      '<div class="field" style="margin-top:10px;margin-bottom:10px">' +
      '<label>Keywords (comma separated — matched against the member\u2019s message)</label>' +
      '<input class="input kb-keywords" type="text" value="' + esc((item.keywords || []).join(", ")) + '" placeholder="hello, hi, hey, good morning">' +
      '</div>' +
      '<div class="field" style="margin-bottom:0">' +
      '<label>Replies the AI can send (rotates so it never repeats)</label>' +
      '<div class="kb-replies">' + (item.variations || []).map(kbReplyRow).join("") + '</div>' +
      '<button type="button" class="btn btn-outline btn-sm kb-add-reply" style="margin-top:8px"><i class="fa-solid fa-plus"></i> Add reply</button>' +
      '<div class="hint">You can use {name}, {username}, {profileName} and {about} to personalize.</div>' +
      '</div>' +
      '</div>';
  }

  function renderKbEditor() {
    const wrap = $("#ai-kb-list");
    const kb = LC.db.aiKb.get();
    setHtml(wrap, kb.map(kbEditorCard).join("") ||
      '<div class="empty" style="padding:30px"><p>No topics yet. Add one using the form above.</p></div>');
  }

  function collectAiConfig() {
    return {
      enabled: $("#ai-enabled").checked,
      provider: $("#ai-provider").value,
      apiKey: ($("#ai-api-key").value || "").trim(),
      model: ($("#ai-model").value || "").trim(),
      delayMin: parseInt($("#ai-delay-min").value, 10) || 3,
      delayMax: parseInt($("#ai-delay-max").value, 10) || 7,
      leadEnabled: $("#ai-lead-enabled").checked,
      leadIntervalMin: parseInt($("#ai-lead-min").value, 10) || 30,
      leadIntervalMax: parseInt($("#ai-lead-max").value, 10) || 60
    };
  }

  function collectKb() {
    return $$("#ai-kb-list .kb-card").map(card => ({
      id: card.dataset.kbid || LC.db.uid(),
      intent: (card.querySelector(".kb-intent").value || "").trim(),
      keywords: (card.querySelector(".kb-keywords").value || "").split(",").map(k => k.trim()).filter(Boolean),
      variations: Array.from(card.querySelectorAll(".kb-reply-input")).map(i => i.value.trim()).filter(Boolean)
    })).filter(item => item.intent || item.variations.length);
  }

  function saveAiConfig() {
    const cfg = collectAiConfig();
    if (cfg.delayMin < 1) cfg.delayMin = 1;
    if (cfg.delayMax < cfg.delayMin) cfg.delayMax = cfg.delayMin;
    LC.db.aiConfig.save(cfg);
    LC.db.aiKb.save(collectKb());
    LC.rt.emit({ type: "ai" });
    toast("AI settings saved.");
    updateAiStatus();
  }

  function resetAiKb() {
    if (!confirm("Reset the knowledge base to the default topics? Your custom topics and replies will be replaced.")) return;
    LC.db.aiKb.save(JSON.parse(JSON.stringify(LC.db.aiKb.defaults)));
    renderKbEditor();
    LC.rt.emit({ type: "ai" });
    toast("Knowledge base reset to defaults.");
  }

  function updateAiStatus() {
    const el = $("#ai-status");
    if (!el) return;
    const cfg = LC.db.aiConfig.get();
    const provider = cfg.provider || "knowledge base";
    const active = LC.ai && LC.ai.isActive();
    const replied = (LC.ai && LC.ai.repliedAt ? Object.keys(LC.ai.repliedAt).length : 0);
    const hb = Number(LC.db.getSetting("ai_server_heartbeat", 0));
    const serverAi = hb > 0 && Date.now() - hb < 60000;
    const leads = cfg.leadEnabled ? " · lead mode on" : "";
    const runner = serverAi ? " · server worker online (replies with no browser open)" : "";
    el.innerHTML = active
      ? '<span class="ai-status-dot on"></span><div><b>AI is on</b><small>Replying as your profiles via <b>' + LC.fmt.esc(provider) + '</b>' + leads + runner + ' · ' + replied + ' conversation' + (replied === 1 ? "" : "s") + ' handled so far.</small></div>'
      : '<span class="ai-status-dot off"></span><div><b>AI is off</b><small>Toggle the switch above to let the AI reply to your profiles\u2019 messages.</small></div>';
    const badge = $("#admin-ai-badge");
    if (badge) badge.classList.toggle("hidden", !active);
  }

  /* ---------------- overview ---------------- */

  function renderOverview() {
    const users = LC.db.users.get().length;
    const profiles = LC.db.profiles.get().length;
    const msgs = LC.db.messages.get();
    const convs = new Set(msgs.map(m => m.conv));
    const unread = msgs.filter(m => m.to.type === "profile" && !m.read).length;
    $("#st-users").textContent = users;
    $("#st-profiles").textContent = profiles;
    $("#st-convs").textContent = convs.size;
    $("#st-msgs").textContent = msgs.length;
    $("#st-unread").textContent = unread;

    const recent = adminConversations().slice(0, 6);
    const tbody = $("#ov-convs");
    setHtml(tbody, recent.map(cv => {
      const { user, profile } = convRefs(cv.key);
      const last = cv.msgs[cv.msgs.length - 1];
      return '<tr>' +
        '<td><div class="tbl-user">' + avatarFor(user) + '<div><div class="name">' + LC.fmt.esc(user.fullName) + '</div><div class="sub">@' + LC.fmt.esc(user.username) + '</div></div></div></td>' +
        '<td><div class="tbl-user">' + avatarFor(profile) + '<div><div class="name">' + LC.fmt.esc(profile.fullName) + '</div><div class="sub">@' + LC.fmt.esc(profile.username) + '</div></div></div></td>' +
        '<td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + LC.fmt.esc((last.text || (last.image ? "Photo" : ""))) + '</td>' +
        '<td class="muted">' + LC.fmt.ago(cv.last) + '</td>' +
        '<td><button class="btn btn-outline btn-sm" data-conv="' + cv.key + '">Open</button></td>' +
        '</tr>';
    }).join("") || '<tr><td colspan="5" class="empty">No conversations yet.</td></tr>');
  }

  /* ---------------- profile import (JSON) ---------------- */

  function importProfilesFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const arr = Array.isArray(data) ? data
          : (data && Array.isArray(data.profiles) ? data.profiles : null);
        if (!arr) throw new Error("top level must be an array (or { \"profiles\": [...] }).");
        const profiles = LC.db.profiles.get();
        const users = LC.db.users.get();
        let added = 0, updated = 0, skipped = 0;
        arr.forEach(raw => {
          const fullName = String(raw.fullName || raw.name || "").trim();
          const username = String(raw.username || "").trim().toLowerCase();
          if (!fullName || !username) { skipped++; return; }
          const existing = profiles.find(p => p.username.toLowerCase() === username)
            || (raw.id ? profiles.find(p => p.id === raw.id) : null);
          const base = {
            age: parseInt(raw.age, 10) || 24,
            gender: raw.gender || "Prefer not to say",
            email: String(raw.email || "").trim().toLowerCase() || (username + "@hearth.chat"),
            about: String(raw.about || "").trim(),
            avatar: raw.avatar || LC.avatar.make(fullName),
            bio: raw.bio || raw.about || "",
            online: raw.online !== undefined ? !!raw.online : true,
            listed: raw.listed !== undefined ? !!raw.listed : true,
            listedAt: raw.listedAt || (raw.listed ? Date.now() : undefined),
            lastActive: raw.lastActive || Date.now()
          };
          if (existing) {
            Object.assign(existing, { fullName, age: base.age, gender: base.gender, email: base.email, about: base.about, avatar: base.avatar, bio: base.bio, online: base.online, lastActive: base.lastActive });
            if (base.listed && existing.listed !== true) { existing.listed = true; existing.listedAt = Date.now(); }
            if (!base.listed) existing.listed = false;
            updated++;
          } else {
            if (users.some(u => u.username === username)) { skipped++; return; }
            profiles.push(Object.assign({ id: raw.id || LC.db.uid(), username, fullName, password: raw.password || "profile123", createdAt: raw.createdAt || Date.now() }, base));
            added++;
          }
        });
        LC.db.profiles.save(profiles);
        LC.rt.emit({ type: "profiles" });
        renderProfilesTable();
        populateProfileFilter();
        toast("Imported: " + added + " added, " + updated + " updated" + (skipped ? ", " + skipped + " skipped" : "") + ".");
      } catch (err) {
        toast("Invalid JSON: " + err.message, "error");
      }
    };
    reader.readAsText(file);
  }

  function downloadProfileTemplate() {
    const template = [
      {
        fullName: "Maya Brooks",
        username: "maya",
        age: 24,
        gender: "Female",
        email: "maya@hearth.chat",
        about: "Psychology student & listener. I'm here for your bad days and your good ones.",
        avatar: "https://randomuser.me/api/portraits/women/68.jpg",
        online: true,
        listed: true
      }
    ];
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "profiles.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------------- view switching ---------------- */

  function openSettingsMenu() {
    const view = $("#view-settings");
    if (!view) return;
    view.classList.remove("detail-open");
    const menu = $("#settings-menu");
    if (menu) menu.classList.remove("hidden");
    const head = $("#settings-detail-head");
    if (head) head.classList.add("hidden");
    const title = view.querySelector(":scope > h1");
    const sub = view.querySelector(":scope > .page-sub");
    if (title) title.classList.remove("hidden");
    if (sub) sub.classList.remove("hidden");
    $$(".settings-section").forEach(el => el.classList.add("hidden"));
    window.scrollTo(0, 0);
  }

  function openSettingsSection(name) {
    const view = $("#view-settings");
    if (!view) return;
    const btn = $('#settings-menu [data-settings="' + name + '"]');
    const section = $('.settings-section[data-settings-section="' + name + '"]');
    if (!btn || !section) return;
    view.classList.add("detail-open");
    const menu = $("#settings-menu");
    if (menu) menu.classList.add("hidden");
    const head = $("#settings-detail-head");
    if (head) head.classList.remove("hidden");
    const title = view.querySelector(":scope > h1");
    const sub = view.querySelector(":scope > .page-sub");
    if (title) title.classList.add("hidden");
    if (sub) sub.classList.add("hidden");
    const heading = btn.querySelector("b");
    const desc = btn.querySelector("small");
    $("#settings-detail-title").textContent = heading ? heading.textContent : "Settings";
    $("#settings-detail-sub").textContent = desc ? desc.textContent : "";
    $$(".settings-section").forEach(el => el.classList.toggle("hidden", el !== section));
    window.scrollTo(0, 0);
  }

  function showView(view, fromHistory) {
    currentView = view;
    ["overview", "profiles", "members", "conversations", "ai", "notifications", "withdrawals", "referrals", "payments", "settings"].forEach(v => {
      $("#view-" + v).classList.toggle("hidden", v !== view);
    });
    $$(".admin-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    if (view === "overview") renderOverview();
    if (view === "profiles") renderProfilesTable();
    if (view === "members") renderMembersTable();
    if (view === "conversations") renderAdminConversationList();
    if (view === "ai") renderAiView();
    if (view === "notifications") renderAdminNotifications();
    if (view === "withdrawals") renderWithdrawals();
    if (view === "referrals") { populateReferralReward(); renderReferrals(); }
    if (view === "payments") renderPayments();
    if (view === "settings") { populateRewardsSettings(); populatePaymentSettings(); renderAdmins(); renderEmailPanel(); openSettingsMenu(); }
    // Record real (non-back-button-driven) navigation in the section history stack.
    if (!fromHistory && window.LC && LC.nav) LC.nav.go(view);
  }

  /* ---------------- settings ---------------- */

  function renderAdmins() {
    const wrap = $("#admin-admins-list");
    const admins = LC.db.users.get().filter(u => u.role === "admin");
    const sess = LC.db.session.get();
    wrap.innerHTML = admins.map(u => {
      const me = sess && sess.id === u.id;
      const canRemove = admins.length > 1 && !me;
      return '<div class="tbl-user" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line,#eee)">' +
        '<div style="display:flex;align-items:center;gap:10px">' + avatarFor(u) +
        '<div><div class="name">' + LC.fmt.esc(u.fullName) + (me ? ' <span class="hidden-badge">You</span>' : '') + '</div>' +
        '<div class="sub">@' + LC.fmt.esc(u.username) + ' · ' + LC.fmt.esc(u.email) + '</div></div></div>' +
        (canRemove ? '<button class="btn btn-danger btn-sm" data-act="del-admin" data-id="' + u.id + '"><i class="fa-solid fa-trash"></i> Remove</button>' : '') +
        '</div>';
    }).join("") || '<div class="empty" style="padding:14px"><p>No admins yet.</p></div>';
  }

  function addAdmin() {
    const fullName = $("#adm-fullname").value.trim();
    const username = $("#adm-username").value.trim().toLowerCase();
    const email = $("#adm-email").value.trim().toLowerCase();
    const password = $("#adm-password").value;
    if (fullName.length < 3) return toast("Enter the admin's full name.", "error");
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return toast("Username must be 3-20 characters (letters, numbers, underscore).", "error");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast("Enter a valid email address.", "error");
    if (password.length < 6) return toast("Password must be at least 6 characters.", "error");
    const users = LC.db.users.get();
    if (LC.db.users.byUsername(username)) return toast("That username is already taken.", "error");
    if (LC.db.users.byEmail(email)) return toast("That email is already registered.", "error");
    users.push({
      id: LC.db.uid(), username, fullName, age: 30, gender: "Prefer not to say", email, password,
      about: "", avatar: LC.avatar.make(fullName), bio: "", online: false, listed: false,
      listedAt: null, lastActive: null, plan: "free", balance: 0, role: "admin", msgQuota: null, createdAt: Date.now()
    });
    LC.db.users.save(users);
    LC.rt.emit({ type: "admins" });
    $("#adm-fullname").value = ""; $("#adm-username").value = ""; $("#adm-email").value = ""; $("#adm-password").value = "";
    renderAdmins();
    toast("Admin added \u2014 they can sign in with that email.");
  }

  function removeAdmin(id) {
    const sess = LC.db.session.get();
    if (sess && sess.id === id) return toast("You can't remove your own admin account.", "error");
    const users = LC.db.users.get();
    if (users.filter(u => u.role === "admin").length <= 1) return toast("At least one admin is required.", "error");
    if (!confirm("Remove this admin account? They will no longer be able to sign in.")) return;
    LC.db.users.save(users.filter(u => u.id !== id));
    LC.rt.emit({ type: "admins" });
    renderAdmins();
    toast("Admin removed.");
  }

  function populateRewardsSettings() {
    const c = LC.db.rewards.get();
    const set = (id, v) => { const el = $("#" + id); if (el) el.value = v; };
    set("set-min-chat", c.minChatMinutes);
    set("set-daily-points", c.dailyChatPoints);
    set("set-point-kes", c.pointValueKes);
    set("set-point-usd", c.pointValueUsd);
    set("set-currency", c.currency);
    set("set-usd-kes", c.usdToKes);
    set("set-activation-amount", c.activationAmount);
    set("set-activation-currency", c.activationCurrency);
    set("set-activation-note", c.activationNote);
  }

  function saveRewardsSettings() {
    const num = (id) => parseFloat($("#" + id).value);
    const minChatMinutes = num("set-min-chat");
    const dailyChatPoints = num("set-daily-points");
    const pointValueKes = num("set-point-kes");
    const pointValueUsd = num("set-point-usd");
    const usdToKes = num("set-usd-kes");
    const activationAmount = num("set-activation-amount");
    const vals = [minChatMinutes, dailyChatPoints, pointValueKes, pointValueUsd, usdToKes, activationAmount];
    if (vals.some(v => !isFinite(v) || v < 0)) {
      toast("Enter valid numbers (0 or more) for all fields.", "error");
      return;
    }
    if (minChatMinutes < 1) { toast("The daily chat goal must be at least 1 minute.", "error"); return; }
    const cfg = Object.assign({}, LC.db.rewards.get(), {
      minChatMinutes: Math.round(minChatMinutes),
      dailyChatPoints: Math.round(dailyChatPoints),
      pointValueKes: pointValueKes,
      pointValueUsd: pointValueUsd,
      usdToKes: usdToKes,
      activationAmount: activationAmount,
      currency: $("#set-currency").value,
      activationCurrency: $("#set-activation-currency").value,
      activationNote: ($("#set-activation-note").value || "").trim()
    });
    LC.db.rewards.save(cfg);
    LC.rt.emit({ type: "rewards" });
    toast("Points & earnings settings saved.");
  }

  function resetRewardsSettings() {
    LC.db.rewards.save(JSON.parse(JSON.stringify(LC.db.rewards.defaults)));
    populateRewardsSettings();
    LC.rt.emit({ type: "rewards" });
    toast("Points & earnings settings reset to defaults.");
  }

  function populateReferralReward() {
    $("#set-referral-reward").value = LC.db.rewards.get().referralPoints;
  }

  function saveReferralReward() {
    const v = parseFloat($("#set-referral-reward").value);
    if (!isFinite(v) || v < 0) { toast("Enter a valid number of points (0 or more).", "error"); return; }
    LC.db.rewards.save(Object.assign({}, LC.db.rewards.get(), { referralPoints: Math.round(v) }));
    LC.rt.emit({ type: "rewards" });
    toast("Referral reward saved — " + Math.round(v).toLocaleString() + " points per referral.");
  }

  function renderReferrals() {
    const el = $("#admin-referrals-body");
    if (!el) return;
    const list = LC.db.users.get().filter(u => LC.db.rewards.state(u).referredBy)
      .sort((a, b) => (LC.db.rewards.state(b).referredAt || 0) - (LC.db.rewards.state(a).referredAt || 0));
    const paid = list.reduce((s, u) => s + LC.db.rewards.state(u).referralPoints, 0);
    $("#ref-summary").textContent = list.length + " referral" + (list.length === 1 ? "" : "s") + " · " + paid.toLocaleString() + " points paid out";
    if (!list.length) {
      setHtml(el, '<div class="empty" style="padding:40px"><div class="big"><i class="fa-solid fa-gift"></i></div><p>No referrals yet.</p></div>');
      return;
    }
    setHtml(el, '<div style="overflow-x:auto"><table class="table"><thead><tr><th>Referrer</th><th>New member</th><th>Joined</th><th>Reward</th></tr></thead><tbody>' +
      list.map(u => {
        const st = LC.db.rewards.state(u);
        const r = LC.db.users.byId(st.referredBy);
        return '<tr>' +
          '<td>' + (r ? '<div class="tbl-user">' + avatarFor(r) + '<div><div class="name">' + LC.fmt.esc(r.fullName) + '</div><div class="sub">@' + LC.fmt.esc(r.username) + '</div></div></div>' : '<span class="muted">Removed member</span>') + '</td>' +
          '<td><div class="tbl-user">' + avatarFor(u) + '<div><div class="name">' + LC.fmt.esc(u.fullName) + '</div><div class="sub">@' + LC.fmt.esc(u.username) + '</div></div></div></td>' +
          '<td class="muted">' + LC.fmt.ago(st.referredAt || u.createdAt || Date.now()) + '</td>' +
          '<td><b>' + st.referralPoints.toLocaleString() + ' pts</b></td></tr>';
      }).join("") + '</tbody></table></div>');
  }

  function renderPaymentMethods() {
    const wrap = $("#admin-pay-methods");
    const methods = LC.db.paymentMethods.get();
    wrap.innerHTML = methods.map(m =>
      '<div class="pm-admin-row" data-id="' + LC.fmt.esc(m.id) + '">' +
      '<input class="input pm-name" value="' + LC.fmt.esc(m.name) + '" placeholder="Name">' +
      '<input class="input pm-desc" value="' + LC.fmt.esc(m.desc || "") + '" placeholder="Description (Kenya & Africa...)">' +
      '<input class="input pm-icon" value="' + LC.fmt.esc(m.icon || "") + '" placeholder="fa-solid fa-wallet">' +
      '<label class="pm-conn"><input type="checkbox" class="pm-connected" ' + (m.connected ? "checked" : "") + '> Connected</label>' +
      '<button class="btn btn-danger btn-sm pm-del" title="Remove method"><i class="fa-solid fa-trash"></i></button>' +
      '</div>'
    ).join("") ||
      '<div class="empty" style="padding:20px"><p>No payment methods. Add one below.</p></div>';
  }

  function collectPaymentMethods() {
    return $$("#admin-pay-methods .pm-admin-row").map(r => ({
      id: r.dataset.id || LC.db.uid(),
      name: (r.querySelector(".pm-name").value || "").trim() || "Payment",
      desc: (r.querySelector(".pm-desc").value || "").trim(),
      icon: (r.querySelector(".pm-icon").value || "").trim() || "fa-solid fa-wallet",
      connected: r.querySelector(".pm-connected").checked
    }));
  }

  function savePaymentMethods() {
    const methods = collectPaymentMethods();
    if (!methods.length) { toast("Add at least one payment method.", "error"); return; }
    LC.db.paymentMethods.save(methods);
    LC.db.paymentConfig.save({ binanceAddress: $("#set-binance-address").value.trim() });
    LC.db.mpesa.save({ baseUrl: $("#set-mpesa-url").value.trim() });
    LC.rt.emit({ type: "payments" });
    renderPaymentMethods();
    toast("Payment settings saved \u2014 the app updates instantly.");
  }

  function addPaymentMethod() {
    const methods = collectPaymentMethods();
    methods.push({ id: LC.db.uid(), name: "New method", desc: "", icon: "fa-solid fa-wallet", connected: false });
    LC.db.paymentMethods.save(methods);
    renderPaymentMethods();
  }

  function deletePaymentMethod(id) {
    const methods = collectPaymentMethods().filter(m => m.id !== id);
    LC.db.paymentMethods.save(methods);
    renderPaymentMethods();
  }

  function populatePaymentSettings() {
    $("#set-binance-address").value = LC.db.paymentConfig.get().binanceAddress || "";
    $("#set-mpesa-url").value = LC.db.mpesa.get().baseUrl || "";
    renderPaymentMethods();
  }

  /* ---------------- email notifications ---------------- */

  let emailPickUsers = [];
  let emailSelected = new Set();
  let emailUnsubscribed = {};   // userId -> unsubscribed timestamp
  let emailFilter = "all";

  function emailBaseUrl() {
    return (LC.db.email.get().baseUrl || LC.db.mpesa.get().baseUrl || "").trim().replace(/\/+$/, "");
  }

  function unreadCountForUser(id) {
    return LC.db.messages.get().filter(m => m.to && m.to.type === "user" && m.to.id === id && !m.read).length;
  }

  function emailMemberRows() {
    const q = ($("#email-member-search").value || "").trim().toLowerCase();
    return emailPickUsers.filter(u => {
      if (emailFilter === "unread" && unreadCountForUser(u.id) === 0) return false;
      if (!q) return true;
      return (u.fullName || "").toLowerCase().indexOf(q) !== -1
        || (u.username || "").toLowerCase().indexOf(q) !== -1
        || (u.email || "").toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderEmailPickList() {
    const wrap = $("#email-pick-list");
    const rows = emailMemberRows();
    if (!rows.length) {
      setHtml(wrap, '<p class="muted" style="padding:10px;font-size:13px">' +
        (emailPickUsers.length ? "No members match your search." : "No members have signed up yet.") + '</p>');
      updateEmailPickCount();
      return;
    }
    setHtml(wrap, rows.map(u => {
      const unread = unreadCountForUser(u.id);
      const off = !!emailUnsubscribed[u.id];
      const noEmail = !u.email;
      const disabled = off || noEmail;
      return '<label class="check notif-pick email-pick' + (disabled ? ' is-unsub' : '') + '">' +
        '<input type="checkbox" value="' + LC.fmt.esc(u.id) + '"' + (emailSelected.has(u.id) ? " checked" : "") + (disabled ? " disabled" : "") + '>' +
        avatarFor(u) +
        '<span class="email-pick-name">' + LC.fmt.esc(u.fullName) + ' <span class="muted">@' + LC.fmt.esc(u.username) + '</span></span>' +
        (unread ? '<span class="email-unread">' + unread + ' unread</span>' : '') +
        (off ? '<span class="hidden-badge">Unsubscribed</span>' : (noEmail ? '<span class="hidden-badge">No email</span>' : '')) +
        '</label>';
    }).join(""));
    updateEmailPickCount();
  }

  function updateEmailPickCount() {
    const n = Array.from(emailSelected).filter(id => !emailUnsubscribed[id]).length;
    const label = $("#email-pick-count");
    if (label) label.textContent = n + " selected";
    const shown = emailMemberRows().filter(u => u.email && !emailUnsubscribed[u.id]);
    const all = shown.length && shown.every(u => emailSelected.has(u.id));
    const box = $("#email-select-all");
    if (box) box.checked = !!all;
  }

  function renderEmailUnsubList() {
    const ids = Object.keys(emailUnsubscribed);
    $("#email-unsub-count").textContent = ids.length;
    const wrap = $("#email-unsub-list");
    if (!ids.length) {
      setHtml(wrap, '<p class="muted" style="font-size:13px;padding:10px 12px;background:var(--bg-soft);border-radius:10px;">No unsubscribes yet — everyone is still receiving emails.</p>');
      return;
    }
    const byId = {};
    LC.db.users.get().forEach(u => { byId[u.id] = u; });
    setHtml(wrap, ids.map(id => {
      const u = byId[id];
      const stamp = emailUnsubscribed[id];
      const when = stamp ? new Date(stamp).toLocaleDateString() : "";
      return '<div class="email-unsub-row">' +
        (u ? avatarFor(u) : '<span class="email-unsub-ph"><i class="fa-solid fa-envelope"></i></span>') +
        '<div style="flex:1;min-width:0"><div class="name">' + LC.fmt.esc(u ? u.fullName : "Unknown member") + '</div>' +
        '<div class="sub">' + LC.fmt.esc(u ? (u.email || "@" + u.username) : id) + (when ? ' · ' + when : '') + '</div></div>' +
        '<button class="btn btn-ghost btn-sm" data-resub="' + LC.fmt.esc(id) + '" type="button"><i class="fa-solid fa-rotate-left"></i> Turn back on</button>' +
        '</div>';
    }).join(""));
  }

  async function refreshEmailPrefs() {
    const base = emailBaseUrl();
    if (!base) { emailUnsubscribed = {}; renderEmailUnsubList(); return false; }
    try {
      const res = await fetch(base + "/api/email/prefs");
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.prefs)) {
        const map = {};
        data.prefs.forEach(p => { if (p.unsubscribed) map[p.user_id] = p.updated_at || 0; });
        emailUnsubscribed = map;
        return true;
      }
    } catch (e) { /* offline — keep the last known list */ }
    return false;
  }

  function renderEmailPanel() {
    emailPickUsers = LC.db.users.get().filter(u => u.role !== "admin")
      .slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    Array.from(emailSelected).forEach(id => { if (emailUnsubscribed[id]) emailSelected.delete(id); });
    renderEmailPickList();
    renderEmailUnsubList();
    refreshEmailPrefs().then(() => {
      Array.from(emailSelected).forEach(id => { if (emailUnsubscribed[id]) emailSelected.delete(id); });
      renderEmailPickList();
      renderEmailUnsubList();
    });
  }

  async function sendManualEmails() {
    const err = $("#email-error");
    const status = $("#email-status");
    err.classList.remove("show");
    status.textContent = "";
    const base = emailBaseUrl();
    if (!base) {
      err.textContent = "Set your Render backend URL under Payment methods first.";
      err.classList.add("show");
      return;
    }
    const ids = Array.from(emailSelected).filter(id => !emailUnsubscribed[id]);
    if (!ids.length) { err.textContent = "Choose at least one member."; err.classList.add("show"); return; }
    const message = $("#email-body").value.trim();
    if (!message) { err.textContent = "Write a message first."; err.classList.add("show"); return; }

    const btn = $("#btn-send-email");
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending...';
    try {
      const res = await fetch(base + "/api/email/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userIds: ids,
          subject: $("#email-subject").value.trim(),
          message: message,
          actionLabel: $("#email-action-label").value.trim(),
          includeUnread: $("#email-include-unread").checked
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not send the emails.");
      const parts = [data.sent + " sent"];
      if (data.unsubscribed) parts.push(data.unsubscribed + " unsubscribed skipped");
      if (data.noEmail) parts.push(data.noEmail + " without email skipped");
      if (data.failed) parts.push(data.failed + " failed");
      status.textContent = "Done — " + parts.join(", ") + ".";
      toast("Email sent to " + data.sent + (data.sent === 1 ? " member" : " members"));
      $("#email-body").value = "";
      emailSelected.clear();
      renderEmailPickList();
      refreshEmailPrefs().then(renderEmailUnsubList);
    } catch (e) {
      err.textContent = e && e.message ? e.message : "Could not send the emails.";
      err.classList.add("show");
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send email';
    }
  }

  async function resubscribeMember(id) {
    const base = emailBaseUrl();
    if (!base) return toast("Set your Render backend URL under Payment methods first.", "error");
    try {
      const res = await fetch(base + "/api/email/resubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: id })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not turn emails back on.");
      delete emailUnsubscribed[id];
      renderEmailPickList();
      renderEmailUnsubList();
      toast("Emails turned back on for that member.");
    } catch (e) {
      toast(e && e.message ? e.message : "Could not turn emails back on.", "error");
    }
  }

  function resetData() {
    if (!confirm("Reset ALL demo data in Supabase? This clears every user, profile, message and notification, then re-seeds fresh demo data. Cannot be undone.")) return;
    LC.db.resetAll().then(() => {
      toast("All data reset \u2014 fresh demo data loaded.");
      refresh();
    });
  }

  function deleteChats(ageMs) {
    const msgs = LC.db.messages.get();
    const before = ageMs === null ? null : (Date.now() - ageMs);
    const keep = before === null ? [] : msgs.filter(m => m.ts >= before);
    const removed = msgs.length - keep.length;
    if (removed === 0) return toast("No chats to delete for that range.", "warn");
    const label = before === null
      ? "ALL chat history"
      : ageMs === 86400000 ? "chats older than 24 hours"
      : ageMs === 604800000 ? "chats older than 1 week"
      : ageMs === 2592000000 ? "chats older than 1 month"
      : "chats in that range";
    if (!confirm("Delete " + removed + " message(s) (" + label + ")?\nThis removes them from Supabase permanently. Messages newer than the chosen age stay.")) return;
    LC.db.messages.save(keep);
    LC.rt.emit({ type: "messages" });
    toast("Deleted " + removed + " message(s) (" + label + ").");
    refresh();
  }

  /* ---------------- realtime ---------------- */

  function refresh() {
    renderAdminConversationList();
    if (activeConv) renderAdminConvMessages();
    const unread = LC.db.messages.get().filter(m => m.to.type === "profile" && !m.read).length;
    const followNotifs = LC.db.notifications.get().filter(n => n.recipient.type === "profile" && n.kind === "follow" && !n.read).length;
    $("#admin-msg-badge").classList.toggle("hidden", unread === 0);
    $("#admin-msg-badge").textContent = unread;
    $("#admin-notif-badge").classList.toggle("hidden", followNotifs === 0);
    $("#admin-notif-badge").textContent = followNotifs;
    const pendingPays = LC.db.payments.get().filter(p => p.status === "pending").length;
    $("#admin-pay-badge").classList.toggle("hidden", pendingPays === 0);
    $("#admin-pay-badge").textContent = pendingPays;
    updateWithdrawalBadge();
    updateAiStatus();
    if (currentView === "overview") renderOverview();
    if (currentView === "profiles") renderProfilesTable();
    if (currentView === "members") renderMembersTable();
    if (currentView === "notifications") renderAdminNotifications();
    if (currentView === "withdrawals") renderWithdrawals();
    if (currentView === "referrals") renderReferrals();
    if (currentView === "payments") renderPayments();
  }

  let pollTimer = null;
  let pulling = false;
  let lastFullPull = 0;

  // Silently re-fetch data from Supabase so conversations update in near real
  // time even if the realtime websocket isn't delivering. No spinner, no
  // flicker — the UI just re-renders when the fresh data arrives.
  function pullData() {
    if (pulling) return;
    pulling = true;
    const now = Date.now();
    const tables = ["messages"];
    if (now - lastFullPull > 3000) {
      tables.push("profiles", "users", "notifications", "sessions", "settings");
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
    window.addEventListener("storage", refresh);
  }

  /* ---------------- auth & boot ---------------- */

  function showAdmin() {
    const sess = LC.db.session.get();
    const admin = sess && sess.type === "user" ? LC.db.users.byId(sess.id) : null;
    if (admin) {
      $("#admin-name").textContent = admin.fullName || admin.username || "admin";
    }
    $("#admin-shell").classList.remove("hidden");
  }

  async function boot() {
    await LC.db.init();
    let sess = LC.db.session.get();
    let admin = sess && sess.type === "user" ? LC.db.users.byId(sess.id) : null;
    if (!admin) {
      const restored = await LC.auth.restoreSession().catch(() => null);
      sess = LC.db.session.get();
      admin = restored && restored.role === "admin" ? restored : (sess ? LC.db.users.byId(sess.id) : null);
    }
    if (!admin || admin.role !== "admin") {
      window.location.replace("index.html");
      return;
    }
    showAdmin();
    bindAdmin();
    if (window.LC && LC.ai) LC.ai.start();
  }

  function bindAdmin() {
    const aside = $("#admin-side");
    const backdrop = $("#admin-backdrop");
    const closeMenu = () => { aside.classList.remove("open"); backdrop.classList.remove("show"); };
    $("#btn-admin-menu").onclick = () => {
      if (aside.classList.contains("open")) closeMenu();
      else { aside.classList.add("open"); backdrop.classList.add("show"); }
    };
    backdrop.onclick = closeMenu;
    $$(".admin-item").forEach(b => b.onclick = () => { showView(b.dataset.view); closeMenu(); });
    const doLogout = async () => {
      if (window.LC && LC.nav) LC.nav.clear();
      await LC.db.session.save(null);
      window.location.href = "index.html";
    };
    $("#btn-admin-logout").onclick = doLogout;

    if (window.LC && LC.nav) {
      LC.nav.init({
        root: "overview",
        render: (v) => showView(v, true),
        onExit: () => LC.auth.exitApp(),
        onWarn: (msg) => toast(msg, "warn")
      });
    }

    $("#btn-new-profile").onclick = () => openProfileModal(null);
    $("#pm-close").onclick = () => $("#profile-modal").classList.remove("open");
    $("#profile-modal").addEventListener("click", e => { if (e.target.id === "profile-modal") $("#profile-modal").classList.remove("open"); });
    $("#profile-form").addEventListener("submit", e => { e.preventDefault(); saveProfileFromModal(); });

    $("#pm-avatar-file").addEventListener("change", e => {
      const file = e.target.files[0];
      if (!file) return;
      toast("Uploading to Cloudinary...");
      LC.cloudinary.uploadImage(file, (err, url) => {
        if (err) return toast(err.message || "Upload failed", "error");
        $("#pm-avatar-url").value = url;
        $("#pm-avatar-preview").src = url;
        toast("Photo uploaded");
      });
    });
    $("#pm-avatar-url").addEventListener("input", e => { if (e.target.value) $("#pm-avatar-preview").src = e.target.value; });

    $("#profiles-table").addEventListener("click", e => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "edit") openProfileModal(btn.dataset.id);
      if (btn.dataset.act === "del") deleteProfile(btn.dataset.id);
      if (btn.dataset.act === "toggle-list") toggleProfileListed(btn.dataset.id);
    });

    $("#members-table").addEventListener("click", e => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "m-toggle") toggleMemberListed(btn.dataset.id);
      if (btn.dataset.act === "m-msg") openMemberChat(btn.dataset.id);
      if (btn.dataset.act === "m-role") setMemberRole(btn.dataset.id, btn.dataset.role);
    });
    $("#msg-close").onclick = () => $("#msg-modal").classList.remove("open");
    $("#msg-modal").addEventListener("click", e => { if (e.target.id === "msg-modal") $("#msg-modal").classList.remove("open"); });
    $("#msg-go").onclick = startMemberChat;

    $("#btn-notif").onclick = openNotifModal;
    $("#notif-close").onclick = () => $("#notif-modal").classList.remove("open");
    $("#notif-modal").addEventListener("click", e => { if (e.target.id === "notif-modal") $("#notif-modal").classList.remove("open"); });
    $("#notif-target-seg").addEventListener("click", e => {
      const btn = e.target.closest("button[data-target]");
      if (!btn) return;
      $$("#notif-target-seg button").forEach(b => b.classList.toggle("active", b === btn));
      $("#notif-pick-wrap").style.display = btn.dataset.target === "pick" ? "" : "none";
      if (btn.dataset.target === "pick") $("#notif-pick-search").focus();
    });
    $("#notif-pick-search").addEventListener("input", renderNotifPickList);
    $("#notif-pick-list").addEventListener("change", e => {
      if (!e.target.matches('input[type="checkbox"]')) return;
      if (e.target.checked) notifPickSelected.add(e.target.value);
      else notifPickSelected.delete(e.target.value);
    });
    $("#notif-send").onclick = sendNotification;

    $("#admin-conv-list").addEventListener("click", e => {
      const item = e.target.closest("[data-conv]");
      if (item) openAdminConversation(item.dataset.conv);
    });
    $("#acm-close").onclick = () => $("#aconv-chat-modal").classList.remove("open");
    $("#aconv-chat-modal").addEventListener("click", e => { if (e.target.id === "aconv-chat-modal") $("#aconv-chat-modal").classList.remove("open"); });
    $("#acm-send").onclick = sendAsProfile;
    $("#acm-input").addEventListener("keydown", e => { if (e.key === "Enter") sendAsProfile(); });
    $("#ov-convs").addEventListener("click", e => {
      const btn = e.target.closest("[data-conv]");
      if (btn) { showView("conversations"); openAdminConversation(btn.dataset.conv); }
    });
    $("#conv-profile-filter").addEventListener("change", e => { profileFilter = e.target.value; renderAdminConversationList(); });
    $("#conv-dir-seg").addEventListener("click", e => {
      const btn = e.target.closest("button[data-dir]");
      if (!btn) return;
      convDirFilter = btn.dataset.dir;
      $$("#conv-dir-seg button").forEach(b => b.classList.toggle("active", b === btn));
      renderAdminConversationList();
    });

    $("#admin-notif-list").addEventListener("click", e => {
      const btn = e.target.closest("[data-act=followback]");
      if (btn) followBack(btn.dataset.nid);
    });

    $("#pay-filter-seg").addEventListener("click", e => {
      const btn = e.target.closest("button[data-payfilter]");
      if (!btn) return;
      adminPayFilter = btn.dataset.payfilter;
      $$("#pay-filter-seg button").forEach(b => b.classList.toggle("active", b === btn));
      renderPayments();
    });
    $("#admin-payments-body").addEventListener("click", onAdminPaymentAction);
    $("#wd-filter-seg").addEventListener("click", e => {
      const btn = e.target.closest("button[data-wdfilter]");
      if (!btn) return;
      adminWdFilter = btn.dataset.wdfilter;
      $$("#wd-filter-seg button").forEach(b => b.classList.toggle("active", b === btn));
      renderWithdrawals();
    });
    $("#admin-withdrawals-body").addEventListener("click", onAdminPaymentAction);

    $("#ai-kb-add").onclick = () => {
      const newForm = $("#kb-new-intent");
      if (newForm) { newForm.focus(); newForm.scrollIntoView({ block: "center", behavior: "smooth" }); }
    };
    $("#ai-kb-list").addEventListener("click", e => {
      const del = e.target.closest(".kb-del");
      if (del) { del.closest(".kb-card").remove(); return; }
      const replyDel = e.target.closest(".kb-reply-del");
      if (replyDel) { replyDel.closest(".kb-reply-row").remove(); return; }
      const addReply = e.target.closest(".kb-add-reply");
      if (addReply) {
        const box = addReply.closest(".kb-card").querySelector(".kb-replies");
        box.insertAdjacentHTML("beforeend", kbReplyRow(""));
        return;
      }
    });
    $("#kb-new-add-reply").onclick = () => {
      $("#kb-new-replies").insertAdjacentHTML("beforeend", kbReplyRow(""));
    };
    $("#kb-new-add").onclick = () => {
      const intent = ($("#kb-new-intent").value || "").trim();
      const keywords = ($("#kb-new-keywords").value || "").split(",").map(k => k.trim()).filter(Boolean);
      const variations = Array.from($$("#kb-new-replies .kb-reply-input")).map(i => i.value.trim()).filter(Boolean);
      if (!intent && !variations.length) return toast("Give the topic a name or at least one reply.", "error");
      const item = { id: LC.db.uid(), intent, keywords, variations };
      $("#ai-kb-list").insertAdjacentHTML("beforeend", kbEditorCard(item));
      $("#kb-new-intent").value = "";
      $("#kb-new-keywords").value = "";
      $("#kb-new-replies").innerHTML = kbReplyRow("");
      $("#kb-new-add").scrollIntoView({ block: "center", behavior: "smooth" });
      toast("Topic added — click Save knowledge base to keep it.");
    };
    $("#ai-kb-save").onclick = saveAiConfig;
    $("#ai-reset-kb").onclick = resetAiKb;
    $("#ai-enabled").addEventListener("change", saveAiConfig);
    $("#ai-lead-enabled").addEventListener("change", saveAiConfig);

    $("#settings-menu").addEventListener("click", e => {
      const btn = e.target.closest("[data-settings]");
      if (btn) openSettingsSection(btn.dataset.settings);
    });
    $("#settings-back").onclick = openSettingsMenu;

    $("#btn-reset-data").onclick = resetData;
    $("#admin-chat-actions").addEventListener("click", e => {
      const btn = e.target.closest("[data-age]");
      if (!btn) return;
      const age = btn.dataset.age;
      deleteChats(age === "all" ? null : parseInt(age, 10));
    });
    $("#btn-import-profiles").onclick = () => {
      const f = $("#profiles-import-file").files[0];
      if (!f) return toast("Choose a JSON file first.", "error");
      importProfilesFromFile(f);
      $("#profiles-import-file").value = "";
    };
    $("#btn-profile-template").onclick = downloadProfileTemplate;
    $("#btn-save-rewards").onclick = saveRewardsSettings;
    $("#btn-reset-rewards").onclick = resetRewardsSettings;
    $("#btn-save-referral").onclick = saveReferralReward;
    $("#btn-save-payments").onclick = savePaymentMethods;
    $("#btn-add-pay-method").onclick = addPaymentMethod;
    $("#admin-pay-methods").addEventListener("click", e => {
      const del = e.target.closest(".pm-del");
      if (del) deletePaymentMethod(del.closest(".pm-admin-row").dataset.id);
    });
    $("#btn-add-admin").onclick = addAdmin;
    $("#admin-admins-list").addEventListener("click", e => {
      const btn = e.target.closest("[data-act=del-admin]");
      if (btn) removeAdmin(btn.dataset.id);
    });
    $("#btn-email-refresh").onclick = () => {
      refreshEmailPrefs().then(() => {
        renderEmailPickList();
        renderEmailUnsubList();
        toast("Email preferences refreshed.");
      });
    };
    $("#email-member-search").addEventListener("input", renderEmailPickList);
    $("#email-member-filter").addEventListener("click", e => {
      const btn = e.target.closest("button[data-efilter]");
      if (!btn) return;
      emailFilter = btn.dataset.efilter;
      $$("#email-member-filter button").forEach(b => b.classList.toggle("active", b === btn));
      renderEmailPickList();
    });
    $("#email-pick-list").addEventListener("change", e => {
      if (!e.target.matches('input[type="checkbox"]')) return;
      if (e.target.checked) emailSelected.add(e.target.value);
      else emailSelected.delete(e.target.value);
      updateEmailPickCount();
    });
    $("#email-select-all").addEventListener("change", e => {
      const check = e.target.checked;
      emailMemberRows().forEach(u => {
        if (!u.email || emailUnsubscribed[u.id]) return;
        if (check) emailSelected.add(u.id);
        else emailSelected.delete(u.id);
      });
      renderEmailPickList();
    });
    $("#btn-send-email").onclick = sendManualEmails;
    $("#email-unsub-list").addEventListener("click", e => {
      const btn = e.target.closest("[data-resub]");
      if (btn) resubscribeMember(btn.dataset.resub);
    });

    populateProfileFilter();
    showView("overview");
    startRealtime();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
