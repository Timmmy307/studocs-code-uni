const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DATABASE_URL || './data/app.db';
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);

db.exec(`PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active|banned
  banned_at TEXT,
  ban_reason TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  course TEXT,
  tags TEXT,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  github_path TEXT NOT NULL,
  github_sha TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|denied
  school TEXT,
  grade_level TEXT,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_users_points ON users(points);
CREATE INDEX IF NOT EXISTS idx_documents_school ON documents(school);
CREATE INDEX IF NOT EXISTS idx_documents_grade_level ON documents(grade_level);
`);

function ensureColumn(table, column, defSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some(c => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${defSql}`);
  }
}

function ensureIndex(name, sql) {
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
  if (!idx) db.exec(sql);
}

function migrate() {
  // Users
  ensureColumn('users', 'username', 'username TEXT');
  ensureColumn('users', 'points', "points INTEGER NOT NULL DEFAULT 0");
  ensureColumn('users', 'is_admin', "is_admin INTEGER NOT NULL DEFAULT 0");
  ensureColumn('users', 'status', "status TEXT NOT NULL DEFAULT 'active'");
  ensureColumn('users', 'banned_at', "banned_at TEXT");
  ensureColumn('users', 'ban_reason', "ban_reason TEXT");
  ensureIndex('uniq_users_username', "CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_username ON users(username)");

  // Documents
  ensureColumn('documents', 'status', "status TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn('documents', 'school', "school TEXT");
  ensureColumn('documents', 'grade_level', "grade_level TEXT");
  ensureIndex('idx_documents_school', "CREATE INDEX IF NOT EXISTS idx_documents_school ON documents(school)");
  ensureIndex('idx_documents_grade_level', "CREATE INDEX IF NOT EXISTS idx_documents_grade_level ON documents(grade_level)");
}

module.exports = {
  db,
  migrate
};