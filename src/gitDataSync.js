const fs = require('fs');
const path = require('path');
const { octokit, GH_OWNER, GH_REPO, GH_BRANCH, configError } = require('./githubClient');

const LOCAL_DB_PATH = process.env.DATABASE_URL || './data/app.db';
const REMOTE_DB_PATH = 'data/app.db';

let lastKnownSha = null;
let dirty = false;
let timer = null;

async function getRemoteSha() {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GH_OWNER,
      repo: GH_REPO,
      path: REMOTE_DB_PATH,
      ref: GH_BRANCH
    });
    if (Array.isArray(data)) throw new Error('Expected file, found directory');
    return data.sha || null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function fetchRemoteDbBuffer() {
  const sha = await getRemoteSha();
  if (!sha) return null;

  const resp = await octokit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', {
    owner: GH_OWNER,
    repo: GH_REPO,
    file_sha: sha,
    headers: { accept: 'application/vnd.github.raw' }
  });

  const body = resp.data;
  if (Buffer.isBuffer(body)) return { buf: body, sha };
  if (typeof body === 'string') return { buf: Buffer.from(body, 'binary'), sha };
  if (body && body.content && body.encoding === 'base64') return { buf: Buffer.from(body.content, 'base64'), sha };
  throw new Error('Unable to fetch DB blob content');
}

async function initDataSync() {
  // Try to pull remote DB
  let remote = null;
  try {
    remote = await fetchRemoteDbBuffer();
  } catch (e) {
    if (e.status && e.status !== 404) throw e;
  }

  if (remote && remote.buf) {
    const localDir = path.dirname(LOCAL_DB_PATH);
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(LOCAL_DB_PATH, remote.buf);
    lastKnownSha = remote.sha;
    console.log('Pulled data/app.db from remote.');
  } else {
    const localDir = path.dirname(LOCAL_DB_PATH);
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    if (!fs.existsSync(LOCAL_DB_PATH)) {
      fs.writeFileSync(LOCAL_DB_PATH, Buffer.alloc(0));
    }
    await syncNow(true);
    console.log('Initialized remote data/app.db (created new file).');
  }

  setInterval(() => {
    if (dirty) syncNow().catch(e => console.error('Periodic sync error:', e.message));
  }, 60 * 1000).unref();

  const shutdown = async () => {
    if (dirty) {
      try { await syncNow(true); } catch (e) { console.error('Final sync error:', e.message); }
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function markDataDirty() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    syncNow().catch(e => console.error('Sync error:', e.message));
    timer = null;
  }, 5000);
}

async function syncNow(force = false) {
  if (!dirty && !force) return;

  const buf = fs.readFileSync(LOCAL_DB_PATH);
  const contentBase64 = buf.toString('base64');

  if (!lastKnownSha && !force) {
    lastKnownSha = await getRemoteSha();
  }

  const params = {
    owner: GH_OWNER,
    repo: GH_REPO,
    path: REMOTE_DB_PATH,
    message: 'Sync data/app.db',
    content: contentBase64,
    branch: GH_BRANCH
  };
  if (lastKnownSha) params.sha = lastKnownSha;

  try {
    const { data } = await octokit.repos.createOrUpdateFileContents(params);
    lastKnownSha = data.content.sha || null;
    dirty = false;
  } catch (e) {
    if (e.status === 404) {
      throw configError(
        'Remote write failed with 404 (Not Found). Ensure the repository and branch exist and the token has contents:write.'
      );
    }
    throw e;
  }
}

module.exports = {
  initDataSync,
  markDataDirty,
  syncNow
};