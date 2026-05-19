const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = 'ermentorna_secret_2024';
const PORT = 3000;
const DB_PATH = './chat.db';

// ── sql.js wrapper (mimics better-sqlite3 sync API) ──────────────────────────
let sqlDb;
let saveTimer;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DB_PATH, Buffer.from(sqlDb.export()));
    } catch (e) { console.error('DB save error:', e); }
  }, 150);
}

const db = {
  exec(sql) {
    sqlDb.run(sql);
    scheduleSave();
  },
  prepare(sql) {
    return {
      run(...args) {
        const p = Array.isArray(args[0]) ? args[0] : args;
        sqlDb.run(sql, p);
        scheduleSave();
      },
      get(...args) {
        const p = Array.isArray(args[0]) ? args[0] : args;
        const stmt = sqlDb.prepare(sql);
        try {
          if (p.length) stmt.bind(p);
          if (stmt.step()) return stmt.getAsObject();
          return undefined;
        } finally { stmt.free(); }
      },
      all(...args) {
        const p = Array.isArray(args[0]) ? args[0] : args;
        const rows = [];
        const stmt = sqlDb.prepare(sql);
        try {
          if (p.length) stmt.bind(p);
          while (stmt.step()) rows.push(stmt.getAsObject());
        } finally { stmt.free(); }
        return rows;
      }
    };
  }
};

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    sqlDb = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    sqlDb = new SQL.Database();
  }

  sqlDb.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    nickname TEXT NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT DEFAULT NULL,
    bio TEXT DEFAULT '',
    status TEXT DEFAULT 'offline',
    created_at INTEGER NOT NULL
  )`);
  sqlDb.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'global',
    room TEXT DEFAULT 'global',
    created_at INTEGER NOT NULL
  )`);
  // Force save after schema creation
  fs.writeFileSync(DB_PATH, Buffer.from(sqlDb.export()));
  console.log('✅ Database ready');
}

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads/'),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

// ── Express setup ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

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

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  try {
    const { username, nickname, password } = req.body;
    if (!username || !nickname || !password)
      return res.status(400).json({ error: 'Все поля обязательны' });
    if (username.length < 3)
      return res.status(400).json({ error: 'Логин минимум 3 символа' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Логин уже занят' });

    const hash = bcrypt.hashSync(password, 10);
    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO users (id, username, nickname, password, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, username.toLowerCase(), nickname, hash, now);

    const token = jwt.sign({ id, username: username.toLowerCase(), nickname }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id, username: username.toLowerCase(), nickname, avatar: null, bio: '' } });
  } catch (e) {
    console.error('register error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Введи логин и пароль' });

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase());
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Неверный логин или пароль' });

    const token = jwt.sign({ id: user.id, username: user.username, nickname: user.nickname }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar || null, bio: user.bio || '' } });
  } catch (e) {
    console.error('login error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── User routes ───────────────────────────────────────────────────────────────
app.get('/api/me', authMiddleware, (req, res) => {
  try {
    const user = db.prepare('SELECT id, username, nickname, avatar, bio, status FROM users WHERE id = ?').get(req.user.id);
    res.json(user);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/me', authMiddleware, (req, res) => {
  try {
    const { nickname, bio } = req.body;
    db.prepare('UPDATE users SET nickname = ?, bio = ? WHERE id = ?')
      .run(nickname || req.user.nickname, bio || '', req.user.id);
    const user = db.prepare('SELECT id, username, nickname, avatar, bio FROM users WHERE id = ?').get(req.user.id);
    res.json(user);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/me/avatar', authMiddleware, upload.single('avatar'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не найден' });
    const avatarUrl = '/uploads/' + req.file.filename;
    const old = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.user.id);
    if (old?.avatar?.startsWith('/uploads/')) {
      const oldPath = '.' + old.avatar;
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);
    res.json({ avatar: avatarUrl });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/users', authMiddleware, (req, res) => {
  try {
    const users = db.prepare('SELECT id, username, nickname, avatar, status FROM users WHERE id != ?').all(req.user.id);
    res.json(users);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/users/:id', authMiddleware, (req, res) => {
  try {
    const user = db.prepare('SELECT id, username, nickname, avatar, bio, status FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Не найден' });
    res.json(user);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Message routes ────────────────────────────────────────────────────────────
app.get('/api/messages/global', authMiddleware, (req, res) => {
  try {
    const messages = db.prepare(`
      SELECT m.id, m.content, m.created_at, m.sender_id,
             u.nickname, u.username, u.avatar
      FROM messages m JOIN users u ON m.sender_id = u.id
      WHERE m.room = 'global'
      ORDER BY m.created_at DESC LIMIT 100
    `).all();
    res.json(messages.reverse());
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/messages/dm/:userId', authMiddleware, (req, res) => {
  try {
    const room = [req.user.id, req.params.userId].sort().join('_');
    const messages = db.prepare(`
      SELECT m.id, m.content, m.created_at, m.sender_id,
             u.nickname, u.username, u.avatar
      FROM messages m JOIN users u ON m.sender_id = u.id
      WHERE m.room = ?
      ORDER BY m.created_at DESC LIMIT 100
    `).all(room);
    res.json(messages.reverse());
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
const onlineUsers = new Map();

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

  onlineUsers.set(socket.id, { userId, nickname });
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', userId);
  socket.join('global');
  io.emit('online_count', getOnlineCount());
  io.emit('user_status', { userId, status: 'online' });

  socket.on('global_message', ({ content }) => {
    if (!content?.trim() || content.length > 2000) return;
    const msgId = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    const user = db.prepare('SELECT nickname, username, avatar FROM users WHERE id = ?').get(userId);
    db.prepare('INSERT INTO messages (id, sender_id, content, room, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(msgId, userId, content.trim(), 'global', now);
    io.to('global').emit('global_message', {
      id: msgId, content: content.trim(), sender_id: userId,
      nickname: user.nickname, username: user.username, avatar: user.avatar,
      created_at: now
    });
  });

  socket.on('dm_message', ({ toUserId, content }) => {
    if (!content?.trim() || content.length > 2000) return;
    const room = [userId, toUserId].sort().join('_');
    const msgId = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    const user = db.prepare('SELECT nickname, username, avatar FROM users WHERE id = ?').get(userId);
    db.prepare('INSERT INTO messages (id, sender_id, content, type, room, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(msgId, userId, content.trim(), 'dm', room, now);
    const msg = {
      id: msgId, content: content.trim(), sender_id: userId,
      nickname: user.nickname, username: user.username, avatar: user.avatar,
      created_at: now, room
    };
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
    const stillOnline = [...onlineUsers.values()].some(u => u.userId === userId);
    if (!stillOnline) {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', userId);
      io.emit('user_status', { userId, status: 'offline' });
    }
    io.emit('online_count', getOnlineCount());
  });
});

function getOnlineCount() {
  return new Set([...onlineUsers.values()].map(u => u.userId)).size;
}

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 ERMENTORNA running at http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
