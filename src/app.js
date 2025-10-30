require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const { migrate } = require('./db');
const { startBanCleanupJob } = require('./banCleanup');
const { initDataSync } = require('./gitDataSync');
const { logConfigSummary, verifyRepoAccess } = require('./githubClient');

const app = express();

async function bootstrap() {
  // Basic sanity log (masked)
  logConfigSummary('Startup GitHub config');

  // Ensure data dir exists
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Verify repo/branch/token before any sync
  await verifyRepoAccess();

  // Pull data/app.db from remote repo (if present)
  await initDataSync();

  // Run migrations (local file is now hydrated)
  migrate();

  // Defer requiring API until after DB is ready
  const api = require('./api');

  // Static files
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  // Body parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Sessions (MemoryStore for demo only; use a persistent store in production)
  app.use(session({
    secret: process.env.SESSION_SECRET || 'change_me',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // set true with HTTPS + proxy
  }));

  // API
  app.use('/api', api);

  // HTML pages
  function sendPage(res, file) {
    res.sendFile(path.join(publicDir, file));
  }

  app.get('/', (req, res) => sendPage(res, 'index.html'));
  app.get('/login', (req, res) => sendPage(res, 'login.html'));
  app.get('/register', (req, res) => sendPage(res, 'register.html'));
  app.get('/upload', (req, res) => sendPage(res, 'upload.html'));
  app.get('/admin', (req, res) => sendPage(res, 'admin.html'));
  app.get('/docs/:id', (req, res) => sendPage(res, 'document.html'));
  app.get('/settings', (req, res) => sendPage(res, 'settings.html'));

  // 404
  app.use((req, res) => res.status(404).send('Not Found'));

  // Start cleanup job (runs hourly)
  startBanCleanupJob();

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Firewall Freedom Docs running on http://localhost:${port}`);
  });
}

bootstrap().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});