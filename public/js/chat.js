// ── State ─────────────────────────────────────────────────────────────────────
let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let socket, currentRoom = 'global', currentDMUser = null;
let allUsers = {}, unreadCounts = {};
let typingTimers = {}, typingUsers = {};
let pendingAttachment = null;
let replyTo = null; // { id, preview, sender }
let ctxMsgId = null, ctxMsgOwnerId = null, ctxMsgContent = null;
let currentSearchQ = '';
let lastMsgSenderId = null, lastMsgDate = null;
let scrollUnreadCount = 0;
let currentStickerCategory = null;
let notifSound = null;

if (!token || !currentUser) { window.location.href = '/'; }

// ── Notification sound ────────────────────────────────────────────────────────
function playNotif() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; o.type = 'sine';
    g.gain.setValueAtTime(0.3, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o.start(ctx.currentTime); o.stop(ctx.currentTime + 0.3);
  } catch (_) {}
}

// ── API ───────────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers }
  });
  if (res.status === 401) { logout(); return null; }
  return res.json();
}
async function apiForm(path, fd) {
  const res = await fetch(path, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd });
  return res.json();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}
function formatLastSeen(ts) {
  if (!ts) return 'давно';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return 'только что';
  if (diff < 3600) return `${Math.floor(diff/60)} мин назад`;
  if (diff < 86400) return `${Math.floor(diff/3600)} ч назад`;
  if (diff < 604800) return `${Math.floor(diff/86400)} д назад`;
  return new Date(ts*1000).toLocaleDateString('ru-RU', { day:'numeric', month:'short' });
}
function userSubline(u) {
  return u.status === 'online' ? '● Онлайн' : 'был ' + formatLastSeen(u.last_seen);
}
function isEmojiOnly(str) {
  const s = str.trim();
  if (!s || s.length > 12) return false;
  return /^[\p{Emoji}\s]+$/u.test(s);
}
function linkify(text) {
  return escHtml(text).replace(
    /(https?:\/\/[^\s<>"]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="msg-link">$1</a>'
  );
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const me = await api('/api/me');
  if (me) { currentUser = me; localStorage.setItem('user', JSON.stringify(me)); }
  updateMySidebar();
  await loadUsers();
  connectSocket();
  await loadGlobalMessages();
  setupInput();
  initStickerPanel();
}

function setupInput() {
  const input = document.getElementById('msg-input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    if (e.key === 'Escape') { cancelReply(); hideStickerPanel(); }
  });
  input.addEventListener('input', () => {
    autoResize(input);
    handleTyping();
    const len = input.value.length;
    document.getElementById('char-count').textContent = len > 1700 ? `${len}/2000` : '';
  });

  // Search
  const si = document.getElementById('search-input');
  si.addEventListener('input', () => {
    currentSearchQ = si.value.trim();
    document.getElementById('search-clear').classList.toggle('visible', currentSearchQ.length > 0);
    applySearch();
  });

  // Scroll to bottom button visibility
  const area = document.getElementById('messages-area');
  area.addEventListener('scroll', () => {
    const fromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
    const btn = document.getElementById('scroll-btn');
    btn.style.display = fromBottom > 150 ? 'flex' : 'none';
    if (fromBottom < 50) {
      scrollUnreadCount = 0;
      document.getElementById('scroll-unread').style.display = 'none';
    }
  });

  // Close menus on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctx-menu') && !e.target.closest('.msg-group')) hideCtxMenu();
    if (!e.target.closest('#react-picker') && !e.target.closest('#ctx-menu')) hideReactPicker();
    if (!e.target.closest('#sticker-panel') && !e.target.closest('#sticker-btn')) hideStickerPanel();
  });
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 110) + 'px';
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').classList.remove('visible');
  currentSearchQ = '';
  applySearch();
}
function applySearch() {
  const q = currentSearchQ.toLowerCase();
  let visible = 0;
  document.querySelectorAll('.user-item').forEach(item => {
    const name = (item.dataset.nickname || '').toLowerCase();
    const uname = (item.dataset.username || '').toLowerCase();
    const match = !q || name.includes(q) || uname.includes(q);
    item.style.display = match ? '' : 'none';
    if (match) visible++;
  });
  let noRes = document.getElementById('no-results');
  if (!visible && q) {
    if (!noRes) {
      noRes = document.createElement('div');
      noRes.id = 'no-results'; noRes.className = 'no-results';
      noRes.textContent = 'Никого не найдено';
      document.getElementById('users-list').appendChild(noRes);
    }
  } else noRes?.remove();
}

// ── Sidebar ────────────────────────────────────────────────────────────────────
function updateMySidebar() {
  document.getElementById('my-nickname').textContent = currentUser.nickname;
  const avEl = document.getElementById('my-avatar');
  if (currentUser.avatar) {
    avEl.innerHTML = `<img src="${currentUser.avatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    avEl.innerHTML = `<span>${currentUser.nickname[0].toUpperCase()}</span>`;
  }
}

async function loadUsers() {
  const users = await api('/api/users');
  if (!users) return;
  allUsers = {};
  users.forEach(u => allUsers[u.id] = u);
  renderUsers(users);
}

function renderUsers(users) {
  const list = document.getElementById('users-list');
  list.innerHTML = '';
  document.getElementById('users-count').textContent = `(${users.length})`;

  users.forEach(u => {
    const item = document.createElement('div');
    item.className = 'user-item' + (currentRoom === 'dm_'+u.id ? ' active-dm' : '');
    item.dataset.userId = u.id;
    item.dataset.nickname = u.nickname;
    item.dataset.username = u.username;
    item.onclick = () => openDM(u.id);

    const avHtml = u.avatar
      ? `<img src="${u.avatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
      : `<span>${u.nickname[0].toUpperCase()}</span>`;
    const unread = unreadCounts[u.id] || 0;

    item.innerHTML = `
      <div class="u-av">
        <div class="av-inner">${avHtml}</div>
        <span class="status-dot ${u.status==='online'?'online':'offline'}"></span>
      </div>
      <div class="u-info">
        <div class="u-name">${escHtml(u.nickname)}</div>
        <div class="u-sub">${escHtml(userSubline(u))}</div>
      </div>
      ${unread ? `<span class="unread-badge">${unread > 9 ? '9+' : unread}</span>` : ''}
    `;
    list.appendChild(item);
  });

  // Reapply current search filter after re-render
  if (currentSearchQ) applySearch();
}

function updateUserInList(userId, updates) {
  if (allUsers[userId]) Object.assign(allUsers[userId], updates);
  const item = document.querySelector(`.user-item[data-user-id="${userId}"]`);
  if (!item) return;
  const dot = item.querySelector('.status-dot');
  if (dot && updates.status) dot.className = 'status-dot ' + (updates.status==='online' ? 'online' : 'offline');
  const sub = item.querySelector('.u-sub');
  if (sub) sub.textContent = userSubline(allUsers[userId]);
}

// ── Socket ─────────────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('online_count', n => document.getElementById('online-count').textContent = n);
  socket.on('user_status', ({ userId, status, last_seen }) => updateUserInList(userId, { status, last_seen }));

  socket.on('global_message', msg => {
    if (currentRoom === 'global') { appendMessage(msg); maybeScroll(); }
  });

  socket.on('dm_message', msg => {
    const otherId = msg.sender_id === currentUser.id ? msg.toUserId : msg.sender_id;
    if (currentRoom === 'dm_'+otherId) {
      // Remove optimistic duplicate
      document.querySelectorAll('[data-tmp="1"]').forEach(el => el.remove());
      appendMessage(msg); maybeScroll();
    } else if (msg.sender_id !== currentUser.id) {
      unreadCounts[msg.sender_id] = (unreadCounts[msg.sender_id]||0) + 1;
      renderUsers(Object.values(allUsers));
      const u = allUsers[msg.sender_id];
      if (u) { showToast(`💬 ${u.nickname}: ${msg.content||'📷 фото'}`, 'info'); playNotif(); }
    }
  });

  socket.on('message_deleted', ({ id }) => {
    const el = document.querySelector(`[data-msg-id="${id}"]`);
    if (el) {
      el.style.opacity = '0';
      el.style.transform = 'scale(0.95)';
      el.style.transition = 'all 0.2s';
      setTimeout(() => el.remove(), 200);
    }
  });

  socket.on('reaction_update', ({ messageId, reactions }) => {
    const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (!msgEl) return;
    let reactEl = msgEl.querySelector('.reactions-row');
    const html = buildReactionsHtml(reactions, messageId);
    if (html) {
      if (!reactEl) {
        reactEl = document.createElement('div');
        reactEl.className = 'reactions-row';
        msgEl.querySelector('.msg-body').appendChild(reactEl);
      }
      reactEl.innerHTML = html;
    } else if (reactEl) reactEl.remove();
  });

  socket.on('typing', ({ userId, nickname, room, isTyping }) => {
    if (userId === currentUser.id) return;
    const relevantRoom = currentRoom === 'global' ? 'global' : [currentUser.id, currentDMUser].sort().join('_');
    if (relevantRoom !== (room === 'global' ? 'global' : room)) return;
    if (isTyping) typingUsers[userId] = nickname; else delete typingUsers[userId];
    updateTypingIndicator();
  });
}

let typingTimeout;
function handleTyping() {
  const room = currentRoom === 'global' ? 'global' : [currentUser.id, currentDMUser].sort().join('_');
  socket.emit('typing', { room, isTyping: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('typing', { room, isTyping: false }), 2000);
}
function updateTypingIndicator() {
  const names = Object.values(typingUsers);
  document.getElementById('typing-text').textContent = names.length
    ? names.length === 1 ? `${names[0]} печатает...` : `${names.slice(0,2).join(', ')} печатают...`
    : '';
}

// ── Messages ──────────────────────────────────────────────────────────────────
async function loadGlobalMessages() {
  const msgs = await api('/api/messages/global');
  clearMessages(); lastMsgSenderId = null; lastMsgDate = null;
  msgs?.forEach(m => appendMessage(m, true));
  scrollBottom();
}
async function loadDMMessages(userId) {
  const msgs = await api(`/api/messages/dm/${userId}`);
  clearMessages(); lastMsgSenderId = null; lastMsgDate = null;
  msgs?.forEach(m => appendMessage(m, true));
  scrollBottom();
}
function clearMessages() {
  const area = document.getElementById('messages-area');
  area.innerHTML = currentRoom === 'global'
    ? '<div class="welcome-banner" id="welcome-banner"><div class="welcome-icon">🌐</div><h2>Мировой чат</h2><p>Здесь собираются все. Общайся, делись, создавай.</p></div>'
    : '';
}

function buildReactionsHtml(reactionsJson, msgId) {
  let reactions = {};
  try { reactions = typeof reactionsJson === 'string' ? JSON.parse(reactionsJson) : (reactionsJson || {}); } catch {}
  const entries = Object.entries(reactions).filter(([, users]) => users.length > 0);
  if (!entries.length) return '';
  return entries.map(([emoji, users]) => {
    const mine = users.includes(currentUser.id);
    return `<button class="react-pill${mine?' mine':''}" onclick="quickReact('${msgId}','${emoji}')" title="${users.length} чел.">${emoji} ${users.length}</button>`;
  }).join('');
}

function appendMessage(msg, silent = false) {
  const area = document.getElementById('messages-area');
  document.getElementById('welcome-banner')?.remove();

  const isOwn = msg.sender_id === currentUser.id;
  const date = new Date(msg.created_at * 1000);
  const dateStr = date.toLocaleDateString('ru-RU', { day:'numeric', month:'long' });

  if (dateStr !== lastMsgDate) {
    lastMsgDate = dateStr; lastMsgSenderId = null;
    const sep = document.createElement('div');
    sep.className = 'date-sep'; sep.innerHTML = `<span>${dateStr}</span>`;
    area.appendChild(sep);
  }

  const continued = lastMsgSenderId === msg.sender_id;
  lastMsgSenderId = msg.sender_id;

  const timeStr = date.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });
  const avHtml = msg.avatar ? `<img src="${msg.avatar}" alt="">` : (msg.nickname?.[0]?.toUpperCase()||'?');

  const group = document.createElement('div');
  group.className = `msg-group${isOwn?' own':''}${continued?' continued':''}`;
  group.dataset.msgId = msg.id;
  if (msg.id?.startsWith('tmp_')) group.dataset.tmp = '1';

  // Long press / right click context menu
  let pressTimer;
  group.addEventListener('contextmenu', (e) => { e.preventDefault(); showCtxMenu(e, msg, isOwn); });
  group.addEventListener('touchstart', (e) => { pressTimer = setTimeout(() => showCtxMenu(e.touches[0], msg, isOwn), 500); });
  group.addEventListener('touchend', () => clearTimeout(pressTimer));
  group.addEventListener('touchmove', () => clearTimeout(pressTimer));

  // Reply block
  const replyHtml = msg.reply_to_id
    ? `<div class="reply-quote" onclick="scrollToMsg('${msg.reply_to_id}')">
        <span class="reply-quote-sender">${escHtml(msg.reply_sender||'')}</span>
        <span class="reply-quote-text">${escHtml((msg.reply_preview||'').substring(0,80))}</span>
       </div>`
    : '';

  // Message content
  const emojiOnly = msg.content && isEmojiOnly(msg.content);
  const bubbleHtml = msg.content
    ? `<div class="msg-bubble${emojiOnly?' sticker':''}">${emojiOnly ? escHtml(msg.content) : linkify(msg.content)}</div>`
    : '';

  const imgHtml = msg.attachment_url && msg.attachment_type === 'image'
    ? `<img class="msg-image" src="${msg.attachment_url}" alt="" onclick="openLightbox('${msg.attachment_url}')" loading="lazy">`
    : '';

  const reactHtml = buildReactionsHtml(msg.reactions, msg.id);
  const reactionsRow = reactHtml ? `<div class="reactions-row">${reactHtml}</div>` : '';

  const metaHtml = !continued
    ? `<div class="msg-meta">
        ${!isOwn ? `<span class="msg-nick" onclick="viewUser('${msg.sender_id}')">${escHtml(msg.nickname)}</span>` : ''}
        <span class="msg-time">${timeStr}</span>
       </div>`
    : `<div class="msg-meta-time">${timeStr}</div>`;

  group.innerHTML = `
    <div class="msg-av ${continued?'hidden':''}" onclick="viewUser('${msg.sender_id}')">${avHtml}</div>
    <div class="msg-body">
      ${metaHtml}${replyHtml}${imgHtml}${bubbleHtml}${reactionsRow}
    </div>
  `;
  area.appendChild(group);
}

function maybeScroll() {
  const area = document.getElementById('messages-area');
  const fromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
  if (fromBottom < 120) {
    scrollBottom();
  } else {
    scrollUnreadCount++;
    const unEl = document.getElementById('scroll-unread');
    unEl.textContent = scrollUnreadCount > 9 ? '9+' : scrollUnreadCount;
    unEl.style.display = 'flex';
    document.getElementById('scroll-btn').style.display = 'flex';
  }
}

function scrollBottom() {
  const area = document.getElementById('messages-area');
  area.scrollTop = area.scrollHeight;
  scrollUnreadCount = 0;
  document.getElementById('scroll-unread').style.display = 'none';
}

function scrollToMsg(msgId) {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('highlight'); setTimeout(() => el.classList.remove('highlight'), 1500); }
}

// ── Send ──────────────────────────────────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content && !pendingAttachment) return;

  const payload = {
    content,
    attachment_url: pendingAttachment?.url || null,
    attachment_type: pendingAttachment?.type || null,
    reply_to_id: replyTo?.id || null,
    reply_preview: replyTo ? (replyTo.preview || '').substring(0, 100) : null,
    reply_sender: replyTo?.sender || null,
  };

  if (currentRoom === 'global') {
    socket.emit('global_message', payload);
  } else if (currentDMUser) {
    const now = Math.floor(Date.now() / 1000);
    appendMessage({ ...payload, id: 'tmp_'+now, sender_id: currentUser.id,
      nickname: currentUser.nickname, username: currentUser.username,
      avatar: currentUser.avatar, created_at: now, reactions: '{}' });
    maybeScroll();
    socket.emit('dm_message', { toUserId: currentDMUser, ...payload });
  }

  input.value = ''; input.style.height = 'auto';
  document.getElementById('char-count').textContent = '';
  removeAttachment(); cancelReply();
  clearTimeout(typingTimeout);
  socket.emit('typing', { room: currentRoom==='global'?'global':[currentUser.id,currentDMUser].sort().join('_'), isTyping: false });
}

// ── Attachment ────────────────────────────────────────────────────────────────
async function handleFileSelect(input) {
  const file = input.files[0]; if (!file) return; input.value = '';
  const fd = new FormData(); fd.append('file', file);
  showToast('⏳ Загрузка...', 'info');
  const res = await apiForm('/api/upload', fd);
  if (res?.url) {
    pendingAttachment = { url: res.url, type: res.type, name: file.name };
    document.getElementById('attach-preview-img').src = res.url;
    document.getElementById('attach-preview-name').textContent = file.name;
    document.getElementById('attach-preview').style.display = 'flex';
    showToast('✅ Готово', 'success');
  } else showToast('❌ Ошибка загрузки', 'error');
}
function removeAttachment() {
  pendingAttachment = null;
  document.getElementById('attach-preview').style.display = 'none';
  document.getElementById('attach-preview-img').src = '';
}

// ── Reply ─────────────────────────────────────────────────────────────────────
function setReply(msgId, sender, preview) {
  replyTo = { id: msgId, sender, preview };
  document.getElementById('reply-bar-sender').textContent = sender;
  document.getElementById('reply-bar-text').textContent = (preview || '').substring(0, 80);
  document.getElementById('reply-bar').style.display = 'flex';
  document.getElementById('msg-input').focus();
}
function cancelReply() {
  replyTo = null;
  document.getElementById('reply-bar').style.display = 'none';
}

// ── Context menu ──────────────────────────────────────────────────────────────
function showCtxMenu(e, msg, isOwn) {
  hideReactPicker();
  ctxMsgId = msg.id; ctxMsgOwnerId = msg.sender_id; ctxMsgContent = msg.content;
  const menu = document.getElementById('ctx-menu');
  menu.style.display = 'flex';
  document.getElementById('ctx-delete').style.display = isOwn ? '' : 'none';
  // Position
  const x = e.clientX || (e.pageX || 0);
  const y = e.clientY || (e.pageY || 0);
  menu.style.left = Math.min(x, window.innerWidth - 160) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 160) + 'px';
}
function hideCtxMenu() { document.getElementById('ctx-menu').style.display = 'none'; }

function ctxReply() {
  hideCtxMenu();
  const msg = document.querySelector(`[data-msg-id="${ctxMsgId}"]`);
  const sender = msg?.querySelector('.msg-nick')?.textContent || (ctxMsgOwnerId === currentUser.id ? currentUser.nickname : '?');
  setReply(ctxMsgId, sender, ctxMsgContent || '📷 фото');
}
function ctxReact() {
  hideCtxMenu();
  const msgEl = document.querySelector(`[data-msg-id="${ctxMsgId}"]`);
  if (!msgEl) return;
  const rect = msgEl.getBoundingClientRect();
  const picker = document.getElementById('react-picker');
  picker.style.display = 'flex';
  picker.style.top = Math.max(8, rect.top - 60) + 'px';
  picker.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
}
function ctxCopy() {
  hideCtxMenu();
  if (ctxMsgContent) {
    navigator.clipboard.writeText(ctxMsgContent).then(() => showToast('📋 Скопировано', 'success'));
  }
}
async function ctxDelete() {
  hideCtxMenu();
  if (!ctxMsgId) return;
  const res = await api(`/api/messages/${ctxMsgId}`, { method: 'DELETE' });
  if (res?.ok) showToast('🗑️ Удалено', 'info');
  else showToast('❌ Ошибка', 'error');
}

// ── Reactions ─────────────────────────────────────────────────────────────────
function hideReactPicker() { document.getElementById('react-picker').style.display = 'none'; }
async function sendReaction(emoji) {
  hideReactPicker();
  if (!ctxMsgId) return;
  await api(`/api/messages/${ctxMsgId}/react`, { method: 'POST', body: JSON.stringify({ emoji }) });
}
async function quickReact(msgId, emoji) {
  ctxMsgId = msgId;
  await api(`/api/messages/${msgId}/react`, { method: 'POST', body: JSON.stringify({ emoji }) });
}

// ── Sticker panel ─────────────────────────────────────────────────────────────
function initStickerPanel() {
  const tabs = document.getElementById('sticker-tabs');
  const categories = Object.keys(STICKER_PACKS);
  currentStickerCategory = categories[0];
  tabs.innerHTML = categories.map(cat =>
    `<button class="sticker-tab${cat===currentStickerCategory?' active':''}" onclick="selectStickerTab('${cat}')">${cat}</button>`
  ).join('');
  renderStickerGrid(currentStickerCategory);
}
function selectStickerTab(cat) {
  currentStickerCategory = cat;
  document.querySelectorAll('.sticker-tab').forEach(b => b.classList.toggle('active', b.textContent === cat));
  renderStickerGrid(cat);
}
function renderStickerGrid(cat) {
  const grid = document.getElementById('sticker-grid');
  grid.innerHTML = STICKER_PACKS[cat].map(e =>
    `<button class="sticker-item" onclick="sendSticker('${e}')">${e}</button>`
  ).join('');
}
function toggleStickerPanel() {
  const panel = document.getElementById('sticker-panel');
  const shown = panel.style.display !== 'none';
  panel.style.display = shown ? 'none' : 'flex';
  if (!shown) document.getElementById('msg-input').focus();
}
function hideStickerPanel() { document.getElementById('sticker-panel').style.display = 'none'; }
function sendSticker(emoji) {
  hideStickerPanel();
  // Insert into input or send immediately if input is empty
  const input = document.getElementById('msg-input');
  if (input.value.trim() === '') {
    input.value = emoji;
    sendMessage();
  } else {
    const pos = input.selectionStart;
    input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
    input.setSelectionRange(pos + emoji.length, pos + emoji.length);
    input.focus();
  }
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() { document.getElementById('lightbox').classList.remove('open'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLightbox(); hideCtxMenu(); hideReactPicker(); hideStickerPanel(); } });

// ── Room switching ─────────────────────────────────────────────────────────────
async function switchRoom(room) {
  currentRoom = 'global'; currentDMUser = null;
  lastMsgSenderId = null; lastMsgDate = null;
  typingUsers = {}; updateTypingIndicator(); cancelReply(); removeAttachment();
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-room="global"]').classList.add('active');
  document.querySelectorAll('.user-item').forEach(i => i.classList.remove('active-dm'));
  document.getElementById('header-avatar').innerHTML = '🌐';
  document.getElementById('header-name').textContent = 'Мировой чат';
  document.getElementById('header-sub').textContent = 'Глобальный канал';
  document.getElementById('msg-input').placeholder = 'Написать сообщение...';
  closeSidebar();
  clearMessages(); await loadGlobalMessages();
}

async function openDM(userId) {
  currentRoom = 'dm_'+userId; currentDMUser = userId;
  lastMsgSenderId = null; lastMsgDate = null;
  typingUsers = {}; updateTypingIndicator(); cancelReply(); removeAttachment();
  delete unreadCounts[userId];
  renderUsers(Object.values(allUsers));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.user-item').forEach(i => i.classList.remove('active-dm'));
  document.querySelector(`.user-item[data-user-id="${userId}"]`)?.classList.add('active-dm');
  const u = allUsers[userId] || {};
  const hav = document.getElementById('header-avatar');
  hav.innerHTML = u.avatar
    ? `<img src="${u.avatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
    : u.nickname?.[0]?.toUpperCase() || '?';
  document.getElementById('header-name').textContent = u.nickname || 'DM';
  document.getElementById('header-sub').textContent = userSubline(u);
  document.getElementById('msg-input').placeholder = `Написать ${u.nickname||''}...`;
  closeSidebar();
  clearMessages(); await loadDMMessages(userId);
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('visible',
    document.getElementById('sidebar').classList.contains('open'));
}
function viewCurrentProfile() { if (currentDMUser) viewUser(currentDMUser); }

// ── Profile ────────────────────────────────────────────────────────────────────
function openMyProfile() { showProfile(currentUser, true); }
function viewUser(userId) {
  if (userId === currentUser.id) { openMyProfile(); return; }
  api(`/api/users/${userId}`).then(u => { if (u) showProfile(u, false); });
}

function showProfile(u, isOwn) {
  // Nickname input (not contenteditable anymore — use regular input)
  const nickInput = document.getElementById('modal-nickname-input');
  nickInput.value = u.nickname;
  nickInput.disabled = true;

  document.getElementById('modal-username').textContent = '@' + u.username;

  // Bio — always writable when editing, disable when viewing
  const bioEl = document.getElementById('modal-bio');
  bioEl.value = u.bio || '';
  bioEl.disabled = true;

  // Avatar
  const imgEl = document.getElementById('modal-avatar-img');
  const initEl = document.getElementById('modal-avatar-initial');
  if (u.avatar) { imgEl.src = u.avatar; imgEl.style.display = 'block'; initEl.style.display = 'none'; }
  else { initEl.textContent = u.nickname?.[0]?.toUpperCase()||'?'; initEl.style.display = 'block'; imgEl.style.display = 'none'; }

  // Status
  const badge = document.getElementById('modal-status-badge');
  const online = u.status === 'online';
  badge.textContent = online ? '● Онлайн' : '● был ' + formatLastSeen(u.last_seen);
  badge.className = 'status-badge ' + (online ? 'is-online' : 'is-offline');

  // Stats
  if (u.created_at) {
    document.getElementById('stat-joined').textContent =
      new Date(u.created_at * 1000).toLocaleDateString('ru-RU', { month:'short', year:'numeric' });
  }
  if (u.message_count !== undefined) document.getElementById('stat-messages').textContent = u.message_count;

  // Buttons
  document.getElementById('avatar-edit-btn').classList.toggle('visible', isOwn);
  document.getElementById('edit-profile-btn').style.display = isOwn ? '' : 'none';
  document.getElementById('save-profile-btn').style.display = 'none';
  document.getElementById('dm-btn').style.display = isOwn ? 'none' : '';
  document.getElementById('dm-btn').dataset.userId = u.id;
  document.getElementById('logout-btn').style.display = isOwn ? '' : 'none';

  // Reset edit state visuals
  document.getElementById('modal-bio').classList.remove('editing');
  nickInput.classList.remove('editing');

  document.getElementById('profile-modal').classList.add('open');
}

function toggleEditProfile() {
  const nickInput = document.getElementById('modal-nickname-input');
  const bioEl = document.getElementById('modal-bio');
  const isEditing = !nickInput.disabled; // currently editing?

  if (isEditing) {
    // Save mode — switch back to view
    nickInput.disabled = true; bioEl.disabled = true;
    nickInput.classList.remove('editing'); bioEl.classList.remove('editing');
    document.getElementById('edit-profile-btn').style.display = '';
    document.getElementById('save-profile-btn').style.display = 'none';
  } else {
    // Enter edit mode
    nickInput.disabled = false; bioEl.disabled = false;
    nickInput.classList.add('editing'); bioEl.classList.add('editing');
    document.getElementById('edit-profile-btn').style.display = 'none';
    document.getElementById('save-profile-btn').style.display = '';
    bioEl.focus();
  }
}

async function saveProfile() {
  const nickname = document.getElementById('modal-nickname-input').value.trim();
  const bio = document.getElementById('modal-bio').value.trim();
  if (!nickname) return showToast('❌ Ник не может быть пустым', 'error');
  const updated = await api('/api/me', { method:'PUT', body: JSON.stringify({ nickname, bio }) });
  if (updated) {
    currentUser = { ...currentUser, nickname: updated.nickname, bio: updated.bio };
    localStorage.setItem('user', JSON.stringify(currentUser));
    updateMySidebar();
    toggleEditProfile();
    showToast('✅ Профиль сохранён', 'success');
  }
}

async function uploadAvatar(input) {
  const file = input.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('avatar', file);
  showToast('⏳ Загружаю...', 'info');
  const res = await apiForm('/api/me/avatar', fd);
  if (res?.avatar) {
    currentUser.avatar = res.avatar;
    localStorage.setItem('user', JSON.stringify(currentUser));
    updateMySidebar();
    const imgEl = document.getElementById('modal-avatar-img');
    const initEl = document.getElementById('modal-avatar-initial');
    imgEl.src = res.avatar; imgEl.style.display = 'block'; initEl.style.display = 'none';
    showToast('🖼 Аватар обновлён', 'success');
  } else showToast('❌ Ошибка', 'error');
  input.value = '';
}

function startDM() {
  const userId = document.getElementById('dm-btn').dataset.userId;
  closeModal('profile-modal');
  openDM(userId);
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.getElementById('profile-modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal('profile-modal');
});

function logout() {
  localStorage.removeItem('token'); localStorage.removeItem('user');
  if (socket) socket.disconnect();
  window.location.href = '/';
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(text, type = 'info') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = text;
  c.appendChild(t);
  setTimeout(() => {
    t.style.cssText += 'opacity:0;transform:translateX(14px);transition:all 0.3s;';
    setTimeout(() => t.remove(), 320);
  }, 3000);
}

init();
