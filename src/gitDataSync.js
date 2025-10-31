/**
 * gitDataSync.js
 *
 * Responsibilities:
 * - On startup, pull data/app.db from the configured GitHub repo/branch if it exists.
 *   If the remote file is not present, create it by uploading the local DB (or an empty DB file).
 * - Expose:
 *     initDataSync()  // called at startup to hydrate local DB
 *     markDataDirty() // mark DB as changed; schedules a near-immediate sync
 *     syncNow(force)  // perform immediate sync (force=true will push even if not dirty)
 *
 * - If the DB is large, attempt to upload using the git blob + tree + commit API (safer for larger payloads).
 *   The GitHub REST "create or update file contents" endpoint expects the `sha` when updating.
 *   We handle the "sha wasn't supplied" case by fetching sha and retrying.
 *
 * Notes and limits:
 * - The git data API and contents API both have size limits (practical ~100MB). If your DB or file exceeds
 *   that, you should use an external object store (S3/GCS) or Git LFS. This module will attempt a blob+commit
 *   flow for larger payloads, but it may still fail on very large files.
 * - All errors that indicate misconfiguration are surfaced via configError() (from githubClient.js).
 *
 * Usage:
 *   const { initDataSync, markDataDirty, syncNow } = require('./gitDataSync');
 *   await initDataSync();
 *   // whenever DB is changed:
 *   markDataDirty();
 */

const fs = require('fs');
const path = require('path');
const { octokit, GH_OWNER, GH_REPO, GH_BRANCH, configError } = require('./githubClient');

const LOCAL_DB_PATH = process.env.DATABASE_URL || './data/app.db';
const REMOTE_DB_PATH = 'data/app.db';

// When we mark dirty, we schedule a sync after short debounce. We also expose syncNow for immediate push.
let lastKnownSha = null;
let dirty = false;
let timer = null;
const DEBOUNCE_MS = 3000; // short debounce for near-immediate sync
const SIZE_WARN_LIMIT = 90 * 1024 * 1024; // 90 MB - leave headroom under the API practical limit

/* ---------- Helpers ---------- */

async function getRemoteSha() {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GH_OWNER,
      repo: GH_REPO,
      path: REMOTE_DB_PATH,
      ref: GH_BRANCH
    });
    if (Array.isArray(data)) throw new Error('Expected file, got directory: ' + REMOTE_DB_PATH);
    return data.sha || null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function fetchRemoteDbBuffer() {
  const sha = await getRemoteSha();
  if (!sha) return null;

  // Fetch as raw blob
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
 * Create or update file using the Contents API.
 * If sha is provided we include it (update), otherwise create. On 422 complaining about sha we retry.
 */
async function putFileContents(contentBase64, message, sha = null) {
  const params = {
    owner: GH_OWNER,
    repo: GH_REPO,
    path: REMOTE_DB_PATH,
    message,
    content: contentBase64,
    branch: GH_BRANCH
  };
  if (sha) params.sha = sha;

  try {
    const { data } = await octokit.repos.createOrUpdateFileContents(params);
    return data;
  } catch (e) {
    // If GitHub says "sha wasn't supplied" or similar, try fetch sha and retry once.
    if (e.status === 422 && e.message && e.message.includes(`"sha" wasn't supplied`)) {
      const remoteSha = await getRemoteSha();
      if (remoteSha) {
        params.sha = remoteSha;
        const { data } = await octokit.repos.createOrUpdateFileContents(params);
        return data;
      }
    }
    // rethrow for caller to handle
    throw e;
  }
}

/**
 * For larger files, attempt to use the Git Data API: createBlob -> createTree -> createCommit -> updateRef
 * This bypasses the contents API's createOrUpdateFileContents, and can be used to commit large blobs.
 * Note: GitHub still has size limits for blobs; this is best-effort.
 */
async function commitRawBlob(buffer, message) {
  // Create a blob from the file content (base64)
  const contentBase64 = buffer.toString('base64');
  const blob = await octokit.git.createBlob({
    owner: GH_OWNER,
    repo: GH_REPO,
    content: contentBase64,
    encoding: 'base64'
  });

  // Get current commit of the branch
  const ref = await octokit.git.getRef({ owner: GH_OWNER, repo: GH_REPO, ref: `heads/${GH_BRANCH}` });
  const baseCommitSha = ref.data.object.sha;
  const baseCommit = await octokit.git.getCommit({ owner: GH_OWNER, repo: GH_REPO, commit_sha: baseCommitSha });

  // Create a new tree entry that writes our blob to the desired path
  const tree = await octokit.git.createTree({
    owner: GH_OWNER,
    repo: GH_REPO,
    base_tree: baseCommit.data.tree.sha,
    tree: [
      {
        path: REMOTE_DB_PATH,
        mode: '100644',
        type: 'blob',
        sha: blob.data.sha
      }
    ]
  });

  // Create the commit
  const newCommit = await octokit.git.createCommit({
    owner: GH_OWNER,
    repo: GH_REPO,
    message,
    tree: tree.data.sha,
    parents: [baseCommitSha]
  });

  // Update the branch reference to point to our new commit
  await octokit.git.updateRef({
    owner: GH_OWNER,
    repo: GH_REPO,
    ref: `heads/${GH_BRANCH}`,
    sha: newCommit.data.sha
  });

  // Return the new commit SHA (and new blob sha) for bookkeeping
  return { commitSha: newCommit.data.sha, blobSha: blob.data.sha };
}

/* ---------- Public API ---------- */

/**
 * initDataSync
 * - If remote file exists, pull and overwrite local DB.
 * - Otherwise ensure local DB exists and push it up (create remote file).
 * - Sets up periodic flush and shutdown sync flush.
 */
async function initDataSync() {
  // Ensure local dir exists
  const localDir = path.dirname(LOCAL_DB_PATH);
  if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

  // Try pull
  let remote = null;
  try {
    remote = await fetchRemoteDbBuffer();
  } catch (e) {
    if (e.status && e.status !== 404) throw e;
  }

  if (remote && remote.buf) {
    fs.writeFileSync(LOCAL_DB_PATH, remote.buf);
    lastKnownSha = remote.sha;
    console.log('Pulled data/app.db from remote (sha=%s).', lastKnownSha);
  } else {
    // No remote file. Ensure a local DB file exists (migrations will populate if empty).
    if (!fs.existsSync(LOCAL_DB_PATH)) {
      fs.writeFileSync(LOCAL_DB_PATH, Buffer.alloc(0));
      console.log('Created blank local data/app.db');
    }

    // Now attempt to push the local DB to remote. Use syncNow(force).
    try {
      await syncNow(true);
      console.log('Initialized remote data/app.db (created new file).');
    } catch (e) {
      // Provide helpful guidance for common failure modes
      if (e.status === 404) {
        throw configError('Remote write failed with 404 while initializing file. Ensure repo/branch/token are correct.');
      }
      throw e;
    }
  }

  // Periodic flush: if dirty, sync every 60s
  setInterval(() => {
    if (dirty) {
      syncNow().catch(err => console.error('Periodic sync error:', err.message));
    }
  }, 60 * 1000).unref();

  // Final flush on shutdown
  const shutdown = async () => {
    if (dirty) {
      try {
        await syncNow(true);
      } catch (e) {
        console.error('Final sync error:', e.message);
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * markDataDirty
 * - Mark DB changed and schedule a near-immediate sync (debounced).
 */
function markDataDirty() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    syncNow().catch(err => console.error('Sync error:', err.message));
    timer = null;
  }, DEBOUNCE_MS);
}

/**
 * syncNow
 * - Attempt to push the local DB to the remote repo.
 * - If the file is under SIZE_WARN_LIMIT, prefer the Contents API (simpler).
 * - If the file is larger, attempt the blob+tree+commit flow; if that fails, retry with contents API including sha (if available).
 */
async function syncNow(force = false) {
  if (!dirty && !force) return;

  if (!fs.existsSync(LOCAL_DB_PATH)) {
    console.warn('Local DB missing; skipping sync.');
    return;
  }

  const buf = fs.readFileSync(LOCAL_DB_PATH);
  const size = buf.length;
  const baseMessage = 'Sync data/app.db';

  // If file small enough, try Contents API first (less hassle)
  if (size <= SIZE_WARN_LIMIT) {
    const contentBase64 = buf.toString('base64');

    // Ensure we have latest sha if needed
    if (!lastKnownSha && !force) {
      lastKnownSha = await getRemoteSha();
    }

    try {
      // Try putFileContents; this will retry with sha internally if necessary
      const data = await putFileContents(contentBase64, baseMessage, lastKnownSha);
      lastKnownSha = data.content.sha || null;
      dirty = false;
      console.log('Synced data/app.db to remote via Contents API (sha=%s).', lastKnownSha);
      return;
    } catch (e) {
      // If 422 about sha missing, we attempt to re-fetch sha and retry (putFileContents handles that),
      // but if it still fails, fall through to try blob+commit for robustness.
      console.warn('Contents API push failed:', e.message || e);
      // continue to blob approach
    }
  }

  // For larger files or fallback after Contents API failure, attempt blob+tree+commit
  try {
    const { commitSha, blobSha } = await commitRawBlob(buf, baseMessage);
    lastKnownSha = await getRemoteSha(); // update sha after commit
    dirty = false;
    console.log('Synced data/app.db to remote via git blob commit (commit=%s, blob=%s).', commitSha, blobSha);
    return;
  } catch (e) {
    // If the blob+commit flow failed, try a final retry with Contents API including sha if available.
    console.warn('Blob+commit push failed:', e.message || e);

    const contentBase64 = buf.toString('base64');
    try {
      const remoteSha = await getRemoteSha();
      const data = await putFileContents(contentBase64, baseMessage, remoteSha || lastKnownSha);
      lastKnownSha = data.content.sha || null;
      dirty = false;
      console.log('Synced data/app.db to remote via Contents API (retry) (sha=%s).', lastKnownSha);
      return;
    } catch (finalErr) {
      // If finalErr is 404 or 422, raise a helpful config error
      if (finalErr.status === 404) {
        throw configError('Remote write failed with 404. Ensure repository and branch exist and token has proper scopes.');
      }
      if (finalErr.status === 422) {
        throw new Error(`Remote write failed with 422 (invalid request): ${finalErr.message}`);
      }
      throw finalErr;
    }
  }
}

module.exports = {
  initDataSync,
  markDataDirty,
  syncNow
};
