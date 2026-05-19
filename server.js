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

// ── sql.js wrapper ─────────────────────────────────────────────────────────────
let sqlDb;
let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DB_PATH, Buffer.from(sqlDb.export())); }
    catch (e) { console.error('DB save error:', e); }
  }, 150);
}
const db = {
  exec(sql) { sqlDb.run(sql); scheduleSave(); },
  prepare(sql) {
    return {
      run(...args) {
        const p = Array.isArray(args[0]) ? args[0] : args;
        sqlDb.run(sql, p); scheduleSave();
      },
      get(...args) {
        const p = Array.isArray(args[0]) ? args[0] : args;
        const stmt = sqlDb.prepare(sql);
        try { if (p.length) stmt.bind(p); if (stmt.step()) return stmt.getAsObject(); return undefined; }
        finally { stmt.free(); }
      },
      all(...args) {
        const p = Array.isArray(args[0]) ? args[0] : args;
        const rows = []; const stmt = sqlDb.prepare(sql);
        try { if (p.length) stmt.bind(p); while (stmt.step()) rows.push(stmt.getAsObject()); }
        finally { stmt.free(); }
        return rows;
      }
    };
  }
};

async function initDB() {
  const SQL = await initSqlJs();
  sqlDb = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  sqlDb.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
    nickname TEXT NOT NULL, password TEXT NOT NULL,
    avatar TEXT DEFAULT NULL, bio TEXT DEFAULT '',
    status TEXT DEFAULT 'offline', last_seen INTEGER DEFAULT NULL,
    created_at INTEGER NOT NULL
  )`);
  sqlDb.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, sender_id TEXT NOT NULL,
    content TEXT NOT NULL, type TEXT DEFAULT 'global',
    room TEXT DEFAULT 'global', attachment_url TEXT DEFAULT NULL,
    attachment_type TEXT DEFAULT NULL, created_at INTEGER NOT NULL
  )`);

  // Safe migrations for existing DBs
  const migrations = [
    "ALTER TABLE users ADD COLUMN last_seen INTEGER DEFAULT NULL",
    "ALTER TABLE messages ADD COLUMN attachment_url TEXT DEFAULT NULL",
    "ALTER TABLE messages ADD COLUMN attachment_type TEXT DEFAULT NULL"
  ];
  for (const m of migrations) {
    try { sqlDb.run(m); } catch (_) {}
  }

  fs.writeFileSync(DB_PATH, Buffer.from(sqlDb.export()));
  console.log('✅ Database ready');
}

// ── Multer ─────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads/'),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /image\/(jpeg|jpg|png|gif|webp)|video\/mp4/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only images/videos allowed'));
  }
});

// ── Express ────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── Auth ───────────────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  try {
    const { username, nickname, password } = req.body;
    if (!username || !nickname || !password) return res.status(400).json({ error: 'Все поля обязательны' });
    if (username.length < 3) return res.status(400).json({ error: 'Логин минимум 3 символа' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase()))
      return res.status(409).json({ error: 'Логин уже занят' });
    const id = uuidv4(); const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO users (id,username,nickname,password,created_at) VALUES (?,?,?,?,?)')
      .run(id, username.toLowerCase(), nickname, bcrypt.hashSync(password, 10), now);
    const token = jwt.sign({ id, username: username.toLowerCase(), nickname }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id, username: username.toLowerCase(), nickname, avatar: null, bio: '' } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Введи логин и пароль' });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase());
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    const token = jwt.sign({ id: user.id, username: user.username, nickname: user.nickname }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar || null, bio: user.bio || '' } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Users ──────────────────────────────────────────────────────────────────────
app.get('/api/me', auth, (req, res) => {
  try {
    res.json(db.prepare('SELECT id,username,nickname,avatar,bio,status,last_seen FROM users WHERE id=?').get(req.user.id));
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/me', auth, (req, res) => {
  try {
    const { nickname, bio } = req.body;
    db.prepare('UPDATE users SET nickname=?,bio=? WHERE id=?').run(nickname || req.user.nickname, bio || '', req.user.id);
    res.json(db.prepare('SELECT id,username,nickname,avatar,bio FROM users WHERE id=?').get(req.user.id));
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/me/avatar', auth, upload.single('avatar'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не найден' });
    const avatarUrl = '/uploads/' + req.file.filename;
    const old = db.prepare('SELECT avatar FROM users WHERE id=?').get(req.user.id);
    if (old?.avatar?.startsWith('/uploads/')) {
      const p = '.' + old.avatar; if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    db.prepare('UPDATE users SET avatar=? WHERE id=?').run(avatarUrl, req.user.id);
    res.json({ avatar: avatarUrl });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/users', auth, (req, res) => {
  try {
    res.json(db.prepare('SELECT id,username,nickname,avatar,status,last_seen FROM users WHERE id!=?').all(req.user.id));
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/users/:id', auth, (req, res) => {
  try {
    const u = db.prepare('SELECT id,username,nickname,avatar,bio,status,last_seen FROM users WHERE id=?').get(req.params.id);
    if (!u) return res.status(404).json({ error: 'Не найден' });
    res.json(u);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Upload attachment ──────────────────────────────────────────────────────────
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не найден' });
    const url = '/uploads/' + req.file.filename;
    const type = req.file.mimetype.startsWith('image/') ? 'image' : 'video';
    res.json({ url, type });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Messages ───────────────────────────────────────────────────────────────────
app.get('/api/messages/global', auth, (req, res) => {
  try {
    const msgs = db.prepare(`SELECT m.id,m.content,m.created_at,m.sender_id,m.attachment_url,m.attachment_type,
      u.nickname,u.username,u.avatar FROM messages m JOIN users u ON m.sender_id=u.id
      WHERE m.room='global' ORDER BY m.created_at DESC LIMIT 100`).all();
    res.json(msgs.reverse());
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/messages/dm/:userId', auth, (req, res) => {
  try {
    const room = [req.user.id, req.params.userId].sort().join('_');
    const msgs = db.prepare(`SELECT m.id,m.content,m.created_at,m.sender_id,m.attachment_url,m.attachment_type,
      u.nickname,u.username,u.avatar FROM messages m JOIN users u ON m.sender_id=u.id
      WHERE m.room=? ORDER BY m.created_at DESC LIMIT 100`).all(room);
    res.json(msgs.reverse());
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Socket.io ──────────────────────────────────────────────────────────────────
const onlineUsers = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));
  try { socket.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { next(new Error('Invalid token')); }
});

io.on('connection', (socket) => {
  const { id: userId, nickname } = socket.user;
  onlineUsers.set(socket.id, { userId, nickname });
  db.prepare('UPDATE users SET status=? WHERE id=?').run('online', userId);
  socket.join('global');
  io.emit('online_count', getOnlineCount());
  io.emit('user_status', { userId, status: 'online' });

  socket.on('global_message', ({ content, attachment_url, attachment_type }) => {
    if (!content?.trim() && !attachment_url) return;
    if (content?.length > 2000) return;
    const msgId = uuidv4(); const now = Math.floor(Date.now() / 1000);
    const user = db.prepare('SELECT nickname,username,avatar FROM users WHERE id=?').get(userId);
    db.prepare('INSERT INTO messages (id,sender_id,content,room,attachment_url,attachment_type,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(msgId, userId, content?.trim() || '', 'global', attachment_url || null, attachment_type || null, now);
    io.to('global').emit('global_message', {
      id: msgId, content: content?.trim() || '', sender_id: userId,
      nickname: user.nickname, username: user.username, avatar: user.avatar,
      attachment_url: attachment_url || null, attachment_type: attachment_type || null, created_at: now
    });
  });

  socket.on('dm_message', ({ toUserId, content, attachment_url, attachment_type }) => {
    if (!content?.trim() && !attachment_url) return;
    if (content?.length > 2000) return;
    const room = [userId, toUserId].sort().join('_');
    const msgId = uuidv4(); const now = Math.floor(Date.now() / 1000);
    const user = db.prepare('SELECT nickname,username,avatar FROM users WHERE id=?').get(userId);
    db.prepare('INSERT INTO messages (id,sender_id,content,type,room,attachment_url,attachment_type,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(msgId, userId, content?.trim() || '', 'dm', room, attachment_url || null, attachment_type || null, now);
    const msg = { id: msgId, content: content?.trim() || '', sender_id: userId,
      nickname: user.nickname, username: user.username, avatar: user.avatar,
      attachment_url: attachment_url || null, attachment_type: attachment_type || null,
      created_at: now, room };
    for (const [sid, u] of onlineUsers) {
      if (u.userId === toUserId || u.userId === userId)
        io.to(sid).emit('dm_message', { ...msg, toUserId });
    }
  });

  socket.on('typing', ({ room, isTyping }) => {
    socket.to(room === 'global' ? 'global' : room).emit('typing', { userId, nickname, room, isTyping });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    const stillOnline = [...onlineUsers.values()].some(u => u.userId === userId);
    if (!stillOnline) {
      const now = Math.floor(Date.now() / 1000);
      db.prepare('UPDATE users SET status=?,last_seen=? WHERE id=?').run('offline', now, userId);
      io.emit('user_status', { userId, status: 'offline', last_seen: now });
    }
    io.emit('online_count', getOnlineCount());
  });
});

function getOnlineCount() {
  return new Set([...onlineUsers.values()].map(u => u.userId)).size;
}

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 ERMENTORNA running at http://localhost:${PORT}\n`);
  });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
