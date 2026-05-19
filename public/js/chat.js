// ── State ─────────────────────────────────────────────────────────────────────
let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let socket, currentRoom = 'global', currentDMUser = null;
let allUsers = {}, unreadCounts = {};
let typingTimers = {}, typingUsers = {};
let pendingAttachment = null; // { url, type, name }
let lastMsgSenderId = null, lastMsgDate = null;

if (!token || !currentUser) { window.location.href = '/'; }

// ── API helpers ───────────────────────────────────────────────────────────────
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

// ── Last seen helper ──────────────────────────────────────────────────────────
function formatLastSeen(ts) {
  if (!ts) return 'давно';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)   return 'только что';
  if (diff < 3600) return `${Math.floor(diff/60)} мин назад`;
  if (diff < 86400)return `${Math.floor(diff/3600)} ч назад`;
  if (diff < 604800)return `${Math.floor(diff/86400)} д назад`;
  return new Date(ts*1000).toLocaleDateString('ru-RU', { day:'numeric', month:'short' });
}
function userSubline(u) {
  if (u.status === 'online') return '● Онлайн';
  return 'был ' + formatLastSeen(u.last_seen);
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
}

function setupInput() {
  const input = document.getElementById('msg-input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener('input', () => {
    autoResize(input);
    handleTyping();
    const len = input.value.length;
    document.getElementById('char-count').textContent = len > 1700 ? `${len}/2000` : '';
  });

  // Search
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    document.getElementById('search-clear').classList.toggle('visible', q.length > 0);
    filterUsers(q);
  });
}
function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').classList.remove('visible');
  filterUsers('');
}
function filterUsers(q) {
  const items = document.querySelectorAll('.user-item');
  let visible = 0;
  items.forEach(item => {
    const name = item.querySelector('.u-name')?.textContent?.toLowerCase() || '';
    const match = !q || name.includes(q.toLowerCase());
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
  } else if (noRes) noRes.remove();
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 110) + 'px';
}

// ── Sidebar ────────────────────────────────────────────────────────────────────
function updateMySidebar() {
  document.getElementById('my-nickname').textContent = currentUser.nickname;
  const avEl = document.getElementById('my-avatar');
  setAvatar(avEl, currentUser.avatar, currentUser.nickname);
}

function setAvatar(container, avatarUrl, nickname) {
  const initial = nickname?.[0]?.toUpperCase() || '?';
  if (avatarUrl) {
    container.innerHTML = `<img src="${avatarUrl}" alt="">`;
  } else {
    container.innerHTML = `<span>${initial}</span>`;
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
    item.onclick = () => openDM(u.id);

    const avHtml = u.avatar
      ? `<img src="${u.avatar}" alt="">`
      : `<span>${u.nickname[0].toUpperCase()}</span>`;

    const unread = unreadCounts[u.id] || 0;
    const sub = userSubline(u);

    item.innerHTML = `
      <div class="u-av">
        <div class="av-inner">${avHtml}</div>
        <span class="status-dot ${u.status==='online'?'online':'offline'}"></span>
      </div>
      <div class="u-info">
        <div class="u-name">${escHtml(u.nickname)}</div>
        <div class="u-sub">${escHtml(sub)}</div>
      </div>
      ${unread > 0 ? `<span class="unread-badge">${unread > 9 ? '9+' : unread}</span>` : ''}
    `;
    list.appendChild(item);
  });
}

function updateUserInList(userId, updates) {
  if (allUsers[userId]) Object.assign(allUsers[userId], updates);
  const item = document.querySelector(`.user-item[data-user-id="${userId}"]`);
  if (!item) return;
  const dot = item.querySelector('.status-dot');
  if (dot && updates.status) {
    dot.className = 'status-dot ' + (updates.status==='online' ? 'online' : 'offline');
  }
  const sub = item.querySelector('.u-sub');
  if (sub) sub.textContent = userSubline(allUsers[userId]);
}

// ── Socket ─────────────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('online_count', n => document.getElementById('online-count').textContent = n);

  socket.on('user_status', ({ userId, status, last_seen }) => {
    updateUserInList(userId, { status, last_seen });
  });

  socket.on('global_message', msg => {
    if (currentRoom === 'global') { appendMessage(msg); scrollBottom(); }
  });

  socket.on('dm_message', msg => {
    const otherId = msg.sender_id === currentUser.id ? msg.toUserId : msg.sender_id;
    if (currentRoom === 'dm_'+otherId) { appendMessage(msg); scrollBottom(); }
    else if (msg.sender_id !== currentUser.id) {
      unreadCounts[msg.sender_id] = (unreadCounts[msg.sender_id]||0) + 1;
      renderUsers(Object.values(allUsers));
      const u = allUsers[msg.sender_id];
      if (u) showToast(`💬 ${u.nickname}: ${msg.content.substring(0,50)||'📷 фото'}`, 'info');
    }
  });

  socket.on('typing', ({ userId, nickname, room, isTyping }) => {
    if (userId === currentUser.id) return;
    const relevantRoom = currentRoom === 'global' ? 'global' : [currentUser.id, currentDMUser].sort().join('_');
    const msgRoom = room === 'global' ? 'global' : room;
    if (relevantRoom !== msgRoom) return;
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
  const el = document.getElementById('typing-indicator');
  const textEl = document.getElementById('typing-text');
  const names = Object.values(typingUsers);
  if (!names.length) { textEl.textContent = ''; return; }
  textEl.textContent = names.length === 1 ? `${names[0]} печатает...` : `${names.slice(0,2).join(', ')} печатают...`;
}

// ── Messages ──────────────────────────────────────────────────────────────────
async function loadGlobalMessages() {
  const msgs = await api('/api/messages/global');
  clearMessages(); lastMsgSenderId = null; lastMsgDate = null;
  msgs?.forEach(m => appendMessage(m));
  if (msgs?.length) scrollBottom();
}
async function loadDMMessages(userId) {
  const msgs = await api(`/api/messages/dm/${userId}`);
  clearMessages(); lastMsgSenderId = null; lastMsgDate = null;
  msgs?.forEach(m => appendMessage(m));
  if (msgs?.length) scrollBottom();
}
function clearMessages() {
  document.getElementById('messages-area').innerHTML = '';
  document.getElementById('welcome-banner')?.remove();
  const wb = document.createElement('div');
  if (currentRoom === 'global') {
    wb.id = 'welcome-banner'; wb.className = 'welcome-banner';
    wb.innerHTML = '<div class="welcome-icon">🌐</div><h2>Мировой чат</h2><p>Здесь собираются все.</p>';
    document.getElementById('messages-area').appendChild(wb);
  }
}

function appendMessage(msg) {
  const area = document.getElementById('messages-area');
  const wb = document.getElementById('welcome-banner');
  if (wb) wb.remove();

  const isOwn = msg.sender_id === currentUser.id;
  const date = new Date(msg.created_at * 1000);
  const dateStr = date.toLocaleDateString('ru-RU', { day:'numeric', month:'long' });

  if (dateStr !== lastMsgDate) {
    lastMsgDate = dateStr;
    lastMsgSenderId = null;
    const sep = document.createElement('div');
    sep.className = 'date-sep';
    sep.innerHTML = `<span>${dateStr}</span>`;
    area.appendChild(sep);
  }

  const continued = lastMsgSenderId === msg.sender_id;
  lastMsgSenderId = msg.sender_id;

  const timeStr = date.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });
  const avHtml = msg.avatar ? `<img src="${msg.avatar}" alt="">` : (msg.nickname?.[0]?.toUpperCase() || '?');

  const group = document.createElement('div');
  group.className = `msg-group${isOwn?' own':''}${continued?' continued':''}`;

  const metaHtml = !continued
    ? `<div class="msg-meta">
        ${!isOwn ? `<span class="msg-nick" onclick="viewUser('${msg.sender_id}')">${escHtml(msg.nickname)}</span>` : ''}
        <span class="msg-time">${timeStr}</span>
       </div>`
    : '';

  const bubbleHtml = msg.content
    ? `<div class="msg-bubble">${escHtml(msg.content)}</div>`
    : '';

  const imgHtml = msg.attachment_url && msg.attachment_type === 'image'
    ? `<img class="msg-image" src="${msg.attachment_url}" alt="фото" onclick="openLightbox('${msg.attachment_url}')" loading="lazy">`
    : '';

  group.innerHTML = `
    <div class="msg-av ${continued?'hidden':''}" onclick="viewUser('${msg.sender_id}')">${avHtml}</div>
    <div class="msg-body">
      ${metaHtml}
      ${imgHtml}
      ${bubbleHtml}
    </div>
  `;
  area.appendChild(group);
}

function scrollBottom() {
  const area = document.getElementById('messages-area');
  area.scrollTop = area.scrollHeight;
}

// ── Send ──────────────────────────────────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content && !pendingAttachment) return;

  const payload = {
    content,
    attachment_url: pendingAttachment?.url || null,
    attachment_type: pendingAttachment?.type || null
  };

  if (currentRoom === 'global') {
    socket.emit('global_message', payload);
  } else if (currentDMUser) {
    // optimistic render
    const now = Math.floor(Date.now() / 1000);
    appendMessage({ ...payload, id: 'tmp_'+now, sender_id: currentUser.id,
      nickname: currentUser.nickname, username: currentUser.username,
      avatar: currentUser.avatar, created_at: now });
    scrollBottom();
    socket.emit('dm_message', { toUserId: currentDMUser, ...payload });
  }

  input.value = '';
  input.style.height = 'auto';
  document.getElementById('char-count').textContent = '';
  removeAttachment();
  clearTimeout(typingTimeout);
  socket.emit('typing', {
    room: currentRoom === 'global' ? 'global' : [currentUser.id, currentDMUser].sort().join('_'),
    isTyping: false
  });
}

// ── Attachment ────────────────────────────────────────────────────────────────
async function handleFileSelect(input) {
  const file = input.files[0]; if (!file) return;
  input.value = '';

  const fd = new FormData();
  fd.append('file', file);
  showToast('⏳ Загрузка...', 'info');
  const res = await apiForm('/api/upload', fd);
  if (res?.url) {
    pendingAttachment = { url: res.url, type: res.type, name: file.name };
    document.getElementById('attach-preview-img').src = res.url;
    document.getElementById('attach-preview-name').textContent = file.name;
    document.getElementById('attach-preview').style.display = 'flex';
    showToast('✅ Файл готов', 'success');
  } else {
    showToast('❌ Ошибка загрузки', 'error');
  }
}
function removeAttachment() {
  pendingAttachment = null;
  document.getElementById('attach-preview').style.display = 'none';
  document.getElementById('attach-preview-img').src = '';
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
}

// ── Room switching ─────────────────────────────────────────────────────────────
async function switchRoom(room) {
  currentRoom = 'global'; currentDMUser = null;
  lastMsgSenderId = null; lastMsgDate = null;
  typingUsers = {}; updateTypingIndicator();

  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-room="global"]').classList.add('active');
  document.querySelectorAll('.user-item').forEach(i => i.classList.remove('active-dm'));
  document.getElementById('header-avatar').innerHTML = '🌐';
  document.getElementById('header-name').textContent = 'Мировой чат';
  document.getElementById('header-sub').textContent = 'Глобальный канал';
  document.getElementById('view-profile-btn').style.display = 'none';
  document.getElementById('msg-input').placeholder = 'Написать сообщение...';
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');

  clearMessages();
  await loadGlobalMessages();
}

async function openDM(userId) {
  currentRoom = 'dm_'+userId; currentDMUser = userId;
  lastMsgSenderId = null; lastMsgDate = null;
  typingUsers = {}; updateTypingIndicator();

  delete unreadCounts[userId];
  renderUsers(Object.values(allUsers));

  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.user-item').forEach(i => i.classList.remove('active-dm'));
  const item = document.querySelector(`.user-item[data-user-id="${userId}"]`);
  if (item) item.classList.add('active-dm');

  const u = allUsers[userId] || {};
  const hav = document.getElementById('header-avatar');
  if (u.avatar) hav.innerHTML = `<img src="${u.avatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  else hav.textContent = u.nickname?.[0]?.toUpperCase() || '?';
  document.getElementById('header-name').textContent = u.nickname || 'DM';
  document.getElementById('header-sub').textContent = u.status==='online' ? '● Онлайн' : 'был '+formatLastSeen(u.last_seen);
  document.getElementById('view-profile-btn').style.display = 'flex';
  document.getElementById('msg-input').placeholder = `Написать ${u.nickname || ''}...`;
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');

  clearMessages();
  await loadDMMessages(userId);
}

// ── Sidebar mobile ────────────────────────────────────────────────────────────
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebar-overlay');
  sb.classList.toggle('open');
  ov.classList.toggle('visible', sb.classList.contains('open'));
}

// ── Profile modal ─────────────────────────────────────────────────────────────
function openMyProfile() { showProfile(currentUser, true); }
function viewCurrentProfile() { if (currentDMUser) viewUser(currentDMUser); }
function viewUser(userId) {
  if (userId === currentUser.id) { openMyProfile(); return; }
  api(`/api/users/${userId}`).then(u => { if (u) showProfile(u, false); });
}

function showProfile(u, isOwn) {
  document.getElementById('modal-nickname').textContent = u.nickname;
  document.getElementById('modal-nickname').contentEditable = 'false';
  document.getElementById('modal-username').textContent = '@' + u.username;
  document.getElementById('modal-bio').value = u.bio || '';
  document.getElementById('modal-bio').readOnly = true;

  const avEl = document.getElementById('modal-avatar');
  const initEl = document.getElementById('modal-avatar-initial');
  const imgEl = document.getElementById('modal-avatar-img');
  if (u.avatar) {
    imgEl.src = u.avatar; imgEl.style.display = 'block'; initEl.style.display = 'none';
  } else {
    initEl.textContent = u.nickname?.[0]?.toUpperCase() || '?';
    initEl.style.display = 'block'; imgEl.style.display = 'none';
  }

  const statusBadge = document.getElementById('modal-status-badge');
  const online = u.status === 'online';
  statusBadge.textContent = online ? '● Онлайн' : '● был ' + formatLastSeen(u.last_seen);
  statusBadge.className = 'status-badge ' + (online ? 'is-online' : 'is-offline');

  document.getElementById('avatar-edit-btn').classList.toggle('visible', isOwn);
  document.getElementById('edit-profile-btn').style.display = isOwn ? '' : 'none';
  document.getElementById('save-profile-btn').style.display = 'none';
  document.getElementById('dm-btn').style.display = isOwn ? 'none' : '';
  document.getElementById('dm-btn').dataset.userId = u.id;
  document.getElementById('logout-btn').style.display = isOwn ? '' : 'none';

  // Stats - joined date
  if (u.created_at) {
    const d = new Date(u.created_at * 1000);
    document.getElementById('stat-joined').textContent = d.toLocaleDateString('ru-RU', { month:'short', year:'numeric' });
  }

  document.getElementById('profile-modal').classList.add('open');
}

function toggleEditProfile() {
  const nickEl = document.getElementById('modal-nickname');
  const bioEl = document.getElementById('modal-bio');
  const editing = nickEl.contentEditable !== 'true';
  nickEl.contentEditable = editing ? 'true' : 'false';
  bioEl.readOnly = !editing;
  document.getElementById('edit-profile-btn').style.display = editing ? 'none' : '';
  document.getElementById('save-profile-btn').style.display = editing ? '' : 'none';
  if (editing) nickEl.focus();
}

async function saveProfile() {
  const nickname = document.getElementById('modal-nickname').textContent.trim();
  const bio = document.getElementById('modal-bio').value.trim();
  if (!nickname) return;
  const updated = await api('/api/me', { method:'PUT', body: JSON.stringify({ nickname, bio }) });
  if (updated) {
    currentUser = { ...currentUser, nickname: updated.nickname, bio: updated.bio };
    localStorage.setItem('user', JSON.stringify(currentUser));
    updateMySidebar();
    toggleEditProfile();
    showToast('✅ Профиль обновлён', 'success');
  }
}

async function uploadAvatar(input) {
  const file = input.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('avatar', file);
  const res = await apiForm('/api/me/avatar', fd);
  if (res?.avatar) {
    currentUser.avatar = res.avatar;
    localStorage.setItem('user', JSON.stringify(currentUser));
    updateMySidebar();
    const imgEl = document.getElementById('modal-avatar-img');
    const initEl = document.getElementById('modal-avatar-initial');
    imgEl.src = res.avatar; imgEl.style.display = 'block'; initEl.style.display = 'none';
    showToast('🖼 Аватар обновлён', 'success');
  }
  input.value = '';
}

function startDM() {
  const userId = document.getElementById('dm-btn').dataset.userId;
  closeModal('profile-modal');
  openDM(userId);
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }

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
  }, 3200);
}

function escHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}

// Click outside modal
document.getElementById('profile-modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal('profile-modal');
});

init();
