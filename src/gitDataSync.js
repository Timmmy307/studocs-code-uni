const fs = require('fs');
const path = require('path');
const { octokit, GH_OWNER, GH_REPO, GH_BRANCH, configError } = require('./githubClient');

const LOCAL_DB_PATH = process.env.DATABASE_URL || './data/app.db';
const REMOTE_DB_PATH = 'data/app.db';

let lastKnownSha = null;
let dirty = false;
let timer = null;

/**
 * Get the remote file SHA for data/app.db if it exists.
 * Returns sha string or null.
 */
async function getRemoteSha() {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GH_OWNER,
      repo: GH_REPO,
      path: REMOTE_DB_PATH,
      ref: GH_BRANCH
    });
    if (Array.isArray(data)) throw new Error('Expected file, found directory: ' + REMOTE_DB_PATH);
    return data.sha || null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/**
 * Fetch remote DB content as a Buffer. Returns { buf, sha } or null if not present.
 */
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

/**
 * Initialize data sync at startup:
 * - If remote file exists, pull it to LOCAL_DB_PATH.
 * - Otherwise ensure LOCAL_DB_PATH exists and push an initial file up.
 */
async function initDataSync() {
  // Pull remote db if present
  let remote = null;
  try {
    remote = await fetchRemoteDbBuffer();
  } catch (e) {
    // For non-404 errors, surface
    if (e.status && e.status !== 404) throw e;
  }

  const localDir = path.dirname(LOCAL_DB_PATH);
  if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

  if (remote && remote.buf) {
    fs.writeFileSync(LOCAL_DB_PATH, remote.buf);
    lastKnownSha = remote.sha;
    console.log('Pulled data/app.db from remote.');
  } else {
    // If local DB doesn't exist, create an empty file (migrations will populate schema)
    if (!fs.existsSync(LOCAL_DB_PATH)) {
      fs.writeFileSync(LOCAL_DB_PATH, Buffer.alloc(0));
    }
    // Push initial file to remote repo (create or update)
    await syncNow(true);
    console.log('Initialized remote data/app.db (created new file).');
  }

  // Periodic flush: if dirty, sync every minute
  setInterval(() => {
    if (dirty) syncNow().catch(err => console.error('Periodic sync error:', err.message));
  }, 60 * 1000).unref();

  // Ensure we attempt a final sync on shutdown
  const shutdown = async () => {
    if (dirty) {
      try { await syncNow(true); } catch (e) { console.error('Final sync error:', e.message); }
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Mark the local DB as dirty and schedule a batched push.
 */
function markDataDirty() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    syncNow().catch(e => console.error('Sync error:', e.message));
    timer = null;
  }, 5000);
}

/**
 * Sync local DB to remote now. If force=true, push even if not dirty.
 * This function is defensive: if GitHub returns a 422 complaining "sha wasn't supplied"
 * we re-fetch the remote sha and retry with that sha.
 */
async function syncNow(force = false) {
  if (!dirty && !force) return;

  if (!fs.existsSync(LOCAL_DB_PATH)) {
    console.warn('Local DB does not exist; skipping sync.');
    return;
  }

  const buf = fs.readFileSync(LOCAL_DB_PATH);
  const contentBase64 = buf.toString('base64');

  // Ensure we have latest sha if not set
  if (!lastKnownSha && !force) {
    lastKnownSha = await getRemoteSha();
  }

  let params = {
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
    console.log('Synced data/app.db to remote.');
    return;
  } catch (e) {
    // If GitHub complains "sha wasn't supplied", it means a file exists but our params lacked sha.
    // Re-fetch remote sha and retry once.
    if (e.status === 422 && e.message && e.message.includes('"sha"')) {
      try {
        const remoteSha = await getRemoteSha();
        if (remoteSha) {
          params.sha = remoteSha;
          const { data } = await octokit.repos.createOrUpdateFileContents(params);
          lastKnownSha = data.content.sha || null;
          dirty = false;
          console.log('Synced data/app.db to remote (retry with sha).');
          return;
        }
        // remoteSha not present despite 422 - fall through to error handling below
      } catch (retryErr) {
        // If retry failed, include both errors in log and throw the original for clarity
        console.error('Retry to sync with fetched sha failed:', retryErr.message);
        throw e;
      }
    }
    // For other errors or if retry not applicable, transform 404/422 into config guidance
    if (e.status === 404) {
      throw configError(
        'Remote write failed with 404 (Not Found). Ensure the repository and branch exist and the token has contents:write.'
      );
    }
    if (e.status === 422) {
      // Provide more precise guidance about the 422
      throw new Error(`Remote write failed with 422 (Invalid request): ${e.message}`);
    }
    throw e;
  }
}

module.exports = {
  initDataSync,
  markDataDirty,
  syncNow
};
