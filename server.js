const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = 'nexus_chat_secret_2024';
const PORT = 3000;

// Database setup
const db = new Database('./chat.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    nickname TEXT NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT DEFAULT NULL,
    bio TEXT DEFAULT '',
    status TEXT DEFAULT 'online',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'global',
    room TEXT DEFAULT 'global',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(sender_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS dm_rooms (
    id TEXT PRIMARY KEY,
    user1_id TEXT NOT NULL,
    user2_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS friends (
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    PRIMARY KEY(user_id, friend_id)
  );
`);

// Multer storage for avatars
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// --- AUTH ROUTES ---
app.post('/api/register', (req, res) => {
  const { username, nickname, password } = req.body;
  if (!username || !nickname || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (username.length < 3 || password.length < 6)
    return res.status(400).json({ error: 'Username min 3 chars, password min 6 chars' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username already taken' });

  const hash = bcrypt.hashSync(password, 10);
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, username, nickname, password) VALUES (?, ?, ?, ?)')
    .run(id, username.toLowerCase(), nickname, hash);

  const token = jwt.sign({ id, username: username.toLowerCase(), nickname }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id, username: username.toLowerCase(), nickname, avatar: null, bio: '' } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username?.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, username: user.username, nickname: user.nickname }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar, bio: user.bio } });
});

// --- USER ROUTES ---
app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, nickname, avatar, bio, status FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

app.put('/api/me', authMiddleware, (req, res) => {
  const { nickname, bio } = req.body;
  db.prepare('UPDATE users SET nickname = ?, bio = ? WHERE id = ?')
    .run(nickname || req.user.nickname, bio || '', req.user.id);
  const user = db.prepare('SELECT id, username, nickname, avatar, bio FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

app.post('/api/me/avatar', authMiddleware, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const avatarUrl = '/uploads/' + req.file.filename;
  const old = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.user.id);
  if (old?.avatar && old.avatar.startsWith('/uploads/')) {
    const oldPath = '.' + old.avatar;
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);
  res.json({ avatar: avatarUrl });
});

app.get('/api/users', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, nickname, avatar, status FROM users WHERE id != ?').all(req.user.id);
  res.json(users);
});

app.get('/api/users/:id', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, nickname, avatar, bio, status FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

// --- MESSAGES ROUTES ---
app.get('/api/messages/global', authMiddleware, (req, res) => {
  const messages = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.sender_id,
           u.nickname, u.username, u.avatar
    FROM messages m JOIN users u ON m.sender_id = u.id
    WHERE m.room = 'global'
    ORDER BY m.created_at DESC LIMIT 100
  `).all();
  res.json(messages.reverse());
});

app.get('/api/messages/dm/:userId', authMiddleware, (req, res) => {
  const other = req.params.userId;
  const room = [req.user.id, other].sort().join('_');
  const messages = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.sender_id,
           u.nickname, u.username, u.avatar
    FROM messages m JOIN users u ON m.sender_id = u.id
    WHERE m.room = ?
    ORDER BY m.created_at DESC LIMIT 100
  `).all(room);
  res.json(messages.reverse());
});

// Socket.io connected users map
const onlineUsers = new Map(); // socketId -> user

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const { id: userId, nickname } = socket.user;

  onlineUsers.set(socket.id, { userId, nickname, socketId: socket.id });
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', userId);

  socket.join('global');
  io.emit('online_count', getOnlineCount());
  io.emit('user_status', { userId, status: 'online' });

  socket.on('global_message', ({ content }) => {
    if (!content?.trim() || content.length > 2000) return;
    const msgId = uuidv4();
    const user = db.prepare('SELECT nickname, username, avatar FROM users WHERE id = ?').get(userId);
    const ts = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO messages (id, sender_id, content, room) VALUES (?, ?, ?, ?)').run(msgId, userId, content.trim(), 'global');
    io.to('global').emit('global_message', {
      id: msgId, content: content.trim(), sender_id: userId,
      nickname: user.nickname, username: user.username, avatar: user.avatar,
      created_at: ts
    });
  });

  socket.on('dm_message', ({ toUserId, content }) => {
    if (!content?.trim() || content.length > 2000) return;
    const room = [userId, toUserId].sort().join('_');
    const msgId = uuidv4();
    const user = db.prepare('SELECT nickname, username, avatar FROM users WHERE id = ?').get(userId);
    const ts = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO messages (id, sender_id, content, type, room) VALUES (?, ?, ?, ?, ?)').run(msgId, userId, content.trim(), 'dm', room);

    const msg = {
      id: msgId, content: content.trim(), sender_id: userId,
      nickname: user.nickname, username: user.username, avatar: user.avatar,
      created_at: ts, room
    };

    // Send to all sockets of both users
    for (const [sid, u] of onlineUsers) {
      if (u.userId === toUserId || u.userId === userId) {
        io.to(sid).emit('dm_message', { ...msg, toUserId });
      }
    }
  });

  socket.on('typing', ({ room, isTyping }) => {
    socket.to(room === 'global' ? 'global' : room).emit('typing', {
      userId, nickname, room, isTyping
    });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    // Check if user has other sockets
    const stillOnline = [...onlineUsers.values()].some(u => u.userId === userId);
    if (!stillOnline) {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', userId);
      io.emit('user_status', { userId, status: 'offline' });
    }
    io.emit('online_count', getOnlineCount());
  });
});

function getOnlineCount() {
  const unique = new Set([...onlineUsers.values()].map(u => u.userId));
  return unique.size;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 NEXUS CHAT running at http://localhost:${PORT}\n`);
});
