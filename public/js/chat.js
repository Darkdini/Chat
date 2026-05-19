// State
let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let socket;
let currentRoom = 'global';
let currentDMUser = null;
let allUsers = {};
let unreadCounts = {};
let typingTimers = {};
let typingUsers = {};
let isMyProfile = false;

if (!token || !currentUser) {
  window.location.href = '/';
}

// Fetch helpers
async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers }
  });
  if (res.status === 401) { logout(); return; }
  return res.json();
}

async function apiFetchForm(path, formData) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData
  });
  return res.json();
}

// Init
async function init() {
  // Update my info
  const me = await apiFetch('/api/me');
  if (me) {
    currentUser = me;
    localStorage.setItem('user', JSON.stringify(me));
  }
  updateMySidebar();

  // Load users
  await loadUsers();

  // Connect socket
  socket = io({ auth: { token } });
  setupSocket();

  // Load global messages
  await loadGlobalMessages();

  // Input listeners
  const input = document.getElementById('msg-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', () => {
    autoResize(input);
    handleTyping();
    const len = input.value.length;
    const counter = document.getElementById('char-count');
    counter.textContent = len > 1800 ? `${len}/2000` : '';
  });
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function updateMySidebar() {
  document.getElementById('my-nickname').textContent = currentUser.nickname;
  document.getElementById('my-username').textContent = '@' + currentUser.username;
  const avatarEl = document.getElementById('my-avatar');
  const initEl = document.getElementById('my-avatar-initial');
  if (currentUser.avatar) {
    let img = avatarEl.querySelector('img');
    if (!img) { img = document.createElement('img'); avatarEl.appendChild(img); }
    img.src = currentUser.avatar;
    img.style.display = 'block';
    initEl.style.display = 'none';
  } else {
    initEl.textContent = currentUser.nickname[0].toUpperCase();
    initEl.style.display = 'block';
    const img = avatarEl.querySelector('img');
    if (img) img.style.display = 'none';
  }
}

async function loadUsers() {
  const users = await apiFetch('/api/users');
  if (!users) return;
  allUsers = {};
  users.forEach(u => { allUsers[u.id] = u; });
  renderUsersList(users);
}

function renderUsersList(users) {
  const container = document.getElementById('users-list');
  container.innerHTML = '';
  users.forEach(u => {
    const div = document.createElement('div');
    div.className = 'user-item' + (currentRoom === 'dm_' + u.id ? ' active-dm' : '');
    div.dataset.userId = u.id;
    div.onclick = () => openDM(u.id);

    const avatarHtml = u.avatar
      ? `<img src="${u.avatar}" alt="">`
      : `<span>${u.nickname[0].toUpperCase()}</span>`;

    const unread = unreadCounts[u.id] || 0;
    const badgeHtml = unread > 0 ? `<span class="unread-badge">${unread > 9 ? '9+' : unread}</span>` : '';

    div.innerHTML = `
      <div class="user-avatar">
        ${avatarHtml}
        <span class="status-dot ${u.status === 'online' ? 'online' : 'offline'}"></span>
      </div>
      <span class="user-name">${escHtml(u.nickname)}</span>
      ${badgeHtml}
    `;
    container.appendChild(div);
  });
}

function updateUserStatus(userId, status) {
  if (allUsers[userId]) allUsers[userId].status = status;
  const item = document.querySelector(`.user-item[data-user-id="${userId}"]`);
  if (item) {
    const dot = item.querySelector('.status-dot');
    if (dot) {
      dot.className = 'status-dot ' + (status === 'online' ? 'online' : 'offline');
    }
  }
}

// Socket setup
function setupSocket() {
  socket.on('connect', () => console.log('Connected'));

  socket.on('online_count', (count) => {
    document.getElementById('online-count').textContent = count;
  });

  socket.on('user_status', ({ userId, status }) => {
    updateUserStatus(userId, status);
  });

  socket.on('global_message', (msg) => {
    if (currentRoom === 'global') {
      appendMessage(msg, 'global');
      scrollToBottom();
    }
  });

  socket.on('dm_message', (msg) => {
    const otherId = msg.sender_id === currentUser.id ? msg.toUserId : msg.sender_id;
    const room = 'dm_' + otherId;
    if (currentRoom === room) {
      appendMessage(msg, 'dm');
      scrollToBottom();
    } else if (msg.sender_id !== currentUser.id) {
      // Unread notification
      unreadCounts[msg.sender_id] = (unreadCounts[msg.sender_id] || 0) + 1;
      renderUsersList(Object.values(allUsers));
      if (allUsers[msg.sender_id]) {
        showToast(`💬 ${allUsers[msg.sender_id].nickname}: ${msg.content.substring(0, 50)}`, 'info');
      }
    }
  });

  socket.on('typing', ({ userId, nickname, room, isTyping }) => {
    if (userId === currentUser.id) return;
    const relevantRoom = currentRoom === 'global' ? 'global' : currentRoom;
    const msgRoom = room === 'global' ? 'global' : room;
    if (relevantRoom !== msgRoom && msgRoom !== [currentUser.id, userId].sort().join('_')) return;

    if (isTyping) {
      typingUsers[userId] = nickname;
    } else {
      delete typingUsers[userId];
    }
    updateTypingIndicator();
  });
}

let typingTimeout;
function handleTyping() {
  const room = currentRoom === 'global' ? 'global' : [currentUser.id, currentDMUser].sort().join('_');
  socket.emit('typing', { room, isTyping: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    socket.emit('typing', { room, isTyping: false });
  }, 2000);
}

function updateTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  const textEl = document.getElementById('typing-text');
  const names = Object.values(typingUsers);
  if (names.length === 0) {
    el.style.display = 'none';
  } else {
    el.style.display = 'flex';
    if (names.length === 1) textEl.textContent = `${names[0]} печатает...`;
    else textEl.textContent = `${names.slice(0, 2).join(', ')} печатают...`;
  }
}

// Messages rendering
async function loadGlobalMessages() {
  const msgs = await apiFetch('/api/messages/global');
  clearMessages();
  if (msgs?.length) {
    msgs.forEach(m => appendMessage(m, 'global'));
    scrollToBottom();
  }
}

async function loadDMMessages(userId) {
  const msgs = await apiFetch(`/api/messages/dm/${userId}`);
  clearMessages();
  if (msgs?.length) {
    msgs.forEach(m => appendMessage(m, 'dm'));
    scrollToBottom();
  }
}

function clearMessages() {
  const area = document.getElementById('messages-area');
  area.innerHTML = '';
}

let lastMsgDate = null;

function appendMessage(msg, type) {
  const area = document.getElementById('messages-area');
  const isOwn = msg.sender_id === currentUser.id;

  // Date separator
  const date = new Date(msg.created_at * 1000);
  const dateStr = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  if (dateStr !== lastMsgDate) {
    lastMsgDate = dateStr;
    const sep = document.createElement('div');
    sep.className = 'system-msg';
    sep.textContent = dateStr;
    area.appendChild(sep);
  }

  const group = document.createElement('div');
  group.className = `message-group${isOwn ? ' own' : ''}`;

  const avatarHtml = msg.avatar
    ? `<img src="${msg.avatar}" alt="">`
    : `<span>${msg.nickname[0].toUpperCase()}</span>`;

  const timeStr = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  group.innerHTML = `
    <div class="msg-avatar" onclick="viewUser('${msg.sender_id}')" title="${escHtml(msg.nickname)}">${avatarHtml}</div>
    <div class="msg-body">
      ${!isOwn ? `<div class="msg-meta">
        <span class="msg-nick" onclick="viewUser('${msg.sender_id}')">${escHtml(msg.nickname)}</span>
        <span class="msg-time">${timeStr}</span>
      </div>` : `<div class="msg-meta" style="justify-content:flex-end">
        <span class="msg-time">${timeStr}</span>
      </div>`}
      <div class="msg-bubble">${escHtml(msg.content)}</div>
    </div>
  `;
  area.appendChild(group);
}

function scrollToBottom() {
  const area = document.getElementById('messages-area');
  area.scrollTop = area.scrollHeight;
}

// Send message
function sendMessage() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content) return;

  if (currentRoom === 'global') {
    socket.emit('global_message', { content });
  } else if (currentDMUser) {
    socket.emit('dm_message', { toUserId: currentDMUser, content });
    // Optimistic render
    const me = currentUser;
    const now = Math.floor(Date.now() / 1000);
    appendMessage({ id: 'tmp_' + now, sender_id: me.id, content, nickname: me.nickname, username: me.username, avatar: me.avatar, created_at: now }, 'dm');
    scrollToBottom();
  }

  input.value = '';
  input.style.height = 'auto';
  document.getElementById('char-count').textContent = '';

  // Stop typing
  clearTimeout(typingTimeout);
  const room = currentRoom === 'global' ? 'global' : [currentUser.id, currentDMUser].sort().join('_');
  socket.emit('typing', { room, isTyping: false });
}

// Room switching
function switchRoom(room) {
  currentRoom = 'global';
  currentDMUser = null;
  lastMsgDate = null;
  typingUsers = {};
  updateTypingIndicator();

  // Update nav
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-room="global"]').classList.add('active');
  document.querySelectorAll('.user-item').forEach(i => i.classList.remove('active-dm'));

  document.getElementById('header-avatar').textContent = '🌐';
  document.getElementById('header-avatar').innerHTML = '🌐';
  document.getElementById('header-name').textContent = 'Мировой чат';
  document.getElementById('header-sub').textContent = 'Глобальный канал';
  document.getElementById('view-profile-btn').style.display = 'none';
  document.getElementById('msg-input').placeholder = 'Напиши что-нибудь...';

  clearMessages();
  loadGlobalMessages();
}

async function openDM(userId) {
  currentRoom = 'dm_' + userId;
  currentDMUser = userId;
  lastMsgDate = null;
  typingUsers = {};
  updateTypingIndicator();

  // Clear unread
  if (unreadCounts[userId]) {
    delete unreadCounts[userId];
    renderUsersList(Object.values(allUsers));
  }

  // Update nav
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.user-item').forEach(i => i.classList.remove('active-dm'));
  const item = document.querySelector(`.user-item[data-user-id="${userId}"]`);
  if (item) item.classList.add('active-dm');

  const user = allUsers[userId];
  const headerAv = document.getElementById('chat-header-avatar') || document.getElementById('header-avatar');
  if (user?.avatar) {
    document.getElementById('header-avatar').innerHTML = `<img src="${user.avatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    document.getElementById('header-avatar').textContent = user?.nickname?.[0]?.toUpperCase() || '?';
  }
  document.getElementById('header-name').textContent = user?.nickname || 'DM';
  document.getElementById('header-sub').textContent = '@' + (user?.username || '');
  document.getElementById('view-profile-btn').style.display = 'flex';
  document.getElementById('msg-input').placeholder = `Написать ${user?.nickname || ''}...`;

  // Close sidebar on mobile
  document.getElementById('sidebar').classList.remove('open');

  clearMessages();
  await loadDMMessages(userId);
}

// Sidebar mobile
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// Profile modal
function openMyProfile() {
  isMyProfile = true;
  const u = currentUser;
  fillProfileModal(u, true);
  document.getElementById('profile-modal').classList.add('open');
}

function viewUser(userId) {
  if (userId === currentUser.id) { openMyProfile(); return; }
  apiFetch(`/api/users/${userId}`).then(u => {
    if (!u) return;
    isMyProfile = false;
    fillProfileModal(u, false);
    document.getElementById('profile-modal').classList.add('open');
    document.getElementById('dm-btn').dataset.userId = userId;
  });
}

function viewCurrentProfile() {
  if (currentDMUser) viewUser(currentDMUser);
}

function fillProfileModal(u, isOwn) {
  document.getElementById('modal-nickname').textContent = u.nickname;
  document.getElementById('modal-nickname').contentEditable = 'false';
  document.getElementById('modal-username').textContent = '@' + u.username;
  document.getElementById('modal-bio').value = u.bio || '';
  document.getElementById('modal-bio').readOnly = true;

  const avatarEl = document.getElementById('modal-avatar');
  const initEl = document.getElementById('modal-avatar-initial');
  const imgEl = document.getElementById('modal-avatar-img');
  if (u.avatar) {
    imgEl.src = u.avatar;
    imgEl.style.display = 'block';
    initEl.style.display = 'none';
  } else {
    initEl.textContent = u.nickname[0].toUpperCase();
    initEl.style.display = 'block';
    imgEl.style.display = 'none';
  }

  // Edit button visibility
  document.getElementById('avatar-edit-btn').classList.toggle('visible', isOwn);
  document.getElementById('edit-profile-btn').style.display = isOwn ? '' : 'none';
  document.getElementById('save-profile-btn').style.display = 'none';
  document.getElementById('dm-btn').style.display = isOwn ? 'none' : '';
  const logoutBtn = document.querySelector('.btn-logout');
  if (logoutBtn) logoutBtn.style.display = isOwn ? '' : 'none';

  // Status
  const statusBadge = document.querySelector('.status-badge');
  if (!isOwn) {
    statusBadge.style.display = '';
    const online = u.status === 'online';
    statusBadge.textContent = online ? '● Online' : '● Offline';
    statusBadge.style.color = online ? 'var(--green)' : 'var(--muted)';
  } else {
    statusBadge.style.display = '';
    statusBadge.textContent = '● Online';
    statusBadge.style.color = 'var(--green)';
  }
}

function toggleEditProfile() {
  const nickEl = document.getElementById('modal-nickname');
  const bioEl = document.getElementById('modal-bio');
  const editBtn = document.getElementById('edit-profile-btn');
  const saveBtn = document.getElementById('save-profile-btn');

  const editing = nickEl.contentEditable !== 'true';
  nickEl.contentEditable = editing ? 'true' : 'false';
  bioEl.readOnly = !editing;
  editBtn.style.display = editing ? 'none' : '';
  saveBtn.style.display = editing ? '' : 'none';
  if (editing) { nickEl.focus(); }
}

async function saveProfile() {
  const nickname = document.getElementById('modal-nickname').textContent.trim();
  const bio = document.getElementById('modal-bio').value.trim();
  if (!nickname) return;

  const updated = await apiFetch('/api/me', {
    method: 'PUT',
    body: JSON.stringify({ nickname, bio })
  });
  if (updated) {
    currentUser = { ...currentUser, nickname: updated.nickname, bio: updated.bio };
    localStorage.setItem('user', JSON.stringify(currentUser));
    updateMySidebar();
    toggleEditProfile();
    showToast('✅ Профиль обновлён!', 'success');
  }
}

async function uploadAvatar(input) {
  const file = input.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('avatar', file);
  const res = await apiFetchForm('/api/me/avatar', fd);
  if (res?.avatar) {
    currentUser.avatar = res.avatar;
    localStorage.setItem('user', JSON.stringify(currentUser));
    updateMySidebar();
    // Update modal
    const imgEl = document.getElementById('modal-avatar-img');
    const initEl = document.getElementById('modal-avatar-initial');
    imgEl.src = res.avatar;
    imgEl.style.display = 'block';
    initEl.style.display = 'none';
    showToast('🖼 Аватар обновлён!', 'success');
  }
  input.value = '';
}

function startDM() {
  const userId = document.getElementById('dm-btn').dataset.userId;
  closeModal('profile-modal');
  openDM(userId);
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  if (socket) socket.disconnect();
  window.location.href = '/';
}

// Toast notifications
function showToast(text, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = text;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Close modal on overlay click
document.getElementById('profile-modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal('profile-modal');
});

// XSS protection
function escHtml(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

// Start
init();
