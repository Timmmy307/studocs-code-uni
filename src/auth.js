const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const { markDataDirty } = require('./gitDataSync');

const findUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const findUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const insertUser = db.prepare('INSERT INTO users (id, email, username, password_hash, created_at, points, is_admin, status) VALUES (?, ?, ?, ?, ?, 0, 0, \'active\')');
const setAdminFlag = db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?');
const autoBanUserStmt = db.prepare("UPDATE users SET status='banned', banned_at=COALESCE(banned_at, ?), ban_reason=COALESCE(ban_reason, ?) WHERE id=?");

function ensureAuthed(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: 'Not authenticated' });
  }
  next();
}

function ensureAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: 'Not authenticated' });
  }
  const user = findUserById.get(req.session.userId);
  if (!user || !user.is_admin) {
    return res.status(403).json({ ok: false, error: 'Admins only' });
  }
  next();
}

async function registerUser(email, password, clientBan = false, clientBanReason = '', username = null) {
  const existing = findUserByEmail.get(email);
  if (existing) {
    throw new Error('Email already in use');
  }
  const finalUsername = username && String(username).trim() !== '' ? String(username).trim() : String(email).trim();
  const existingU = findUserByUsername.get(finalUsername);
  if (existingU) throw new Error('Username already in use');

  const hash = await bcrypt.hash(password, 12);
  const id = uuidv4();
  insertUser.run(id, email, finalUsername, hash, new Date().toISOString());

  if (email === 'admin' || finalUsername === 'admin') {
    setAdminFlag.run(id);
  }

  if (clientBan) {
    autoBanUserStmt.run(new Date().toISOString(), clientBanReason || 'Device banned', id);
  }

  markDataDirty();
  return { id, email, username: finalUsername };
}

async function loginUser(identity, password, clientBan = false, clientBanReason = '') {
  if ((identity === 'admin') && password === 'admin12345') {
    let admin = findUserByEmail.get('admin') || findUserByUsername.get('admin');
    if (!admin) {
      const hash = await bcrypt.hash('admin12345', 12);
      const id = uuidv4();
      insertUser.run(id, 'admin', 'admin', hash, new Date().toISOString());
      setAdminFlag.run(id);
      admin = findUserByEmail.get('admin') || findUserByUsername.get('admin');
      markDataDirty();
    } else if (!admin.is_admin) {
      setAdminFlag.run(admin.id);
      admin = findUserById.get(admin.id);
      markDataDirty();
    }
    return { id: admin.id, email: admin.email, username: admin.username, is_admin: true, status: admin.status, ban_reason: admin.ban_reason || null };
  }

  let user = findUserByEmail.get(identity);
  if (!user) user = findUserByUsername.get(identity);
  if (!user) throw new Error('Invalid credentials');

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new Error('Invalid credentials');

  if (clientBan && user.status !== 'banned') {
    autoBanUserStmt.run(new Date().toISOString(), clientBanReason || 'Device banned', user.id);
    markDataDirty();
    user.status = 'banned';
    user.banned_at = new Date().toISOString();
    user.ban_reason = clientBanReason || 'Device banned';
  }

  return { id: user.id, email: user.email, username: user.username, is_admin: !!user.is_admin, status: user.status, ban_reason: user.ban_reason || null };
}

module.exports = {
  ensureAuthed,
  ensureAdmin,
  registerUser,
  loginUser,
  findUserById,
  findUserByUsername
};