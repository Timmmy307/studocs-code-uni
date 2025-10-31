// Lightweight helper for syncing a file to GitHub (create or update as needed)
// Replace or adapt this to fit into your existing codebase.

import { Octokit } from "@octokit/rest";

/**
 * Sync a file to a GitHub repo path (create or update).
 *
 * @param {Object} options
 * @param {string} options.token - GitHub token with repo permissions
 * @param {string} options.owner - repo owner
 * @param {string} options.repo - repo name
 * @param {string} options.branch - branch name (eg "main")
 * @param {string} options.path - file path in repo (eg "data/app.db")
 * @param {string} options.contentBase64 - file content already base64 encoded
 * @param {string} options.message - commit message
 */
export async function syncFileToGitHub({
  token,
  owner,
  repo,
  branch = "main",
  path,
  contentBase64,
  message = "Sync file",
}) {
  if (!token) throw new Error("GitHub token is required");
  if (!owner || !repo || !path || !contentBase64) {
    throw new Error("owner, repo, path and contentBase64 are required");
  }

  const octokit = new Octokit({ auth: token });

  // Try to get the existing file to obtain the sha. If it doesn't exist (404) we will create it.
  let sha;
  try {
    const getResp = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref: branch, // check on the branch
    });
    // If found, response data is an object with .sha
    if (getResp && getResp.data && getResp.data.sha) {
      sha = getResp.data.sha;
      console.log(`[gitDataSync] Existing file found at ${path} (sha: ${sha}). Will update.`);
    } else {
      console.log(`[gitDataSync] GET returned without sha for ${path}; will create/update without sha.`);
    }
  } catch (err) {
    // If file not found, we'll create it (no sha). Re-throw other errors.
    if (err.status === 404) {
      console.log(`[gitDataSync] File ${path} not found on branch ${branch}. Will create it.`);
    } else {
      // Log and rethrow unexpected errors
      console.error("[gitDataSync] Error fetching file info:", err);
      throw err;
    }
  }

  // Build request body for create/update. Include sha only when updating.
  const putBody = {
    owner,
    repo,
    path,
    message,
    content: contentBase64,
    branch,
  };
  if (sha) putBody.sha = sha;

  try {
    const putResp = await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", putBody);
    console.log(`[gitDataSync] Successfully synced ${path} — commit: ${putResp.data && putResp.data.commit && putResp.data.commit.sha}`);
    return putResp.data;
  } catch (err) {
    // Bubble up but add a more helpful message for the common sha-missing case
    if (err.status === 422 && /sha/i.test(err.message || "")) {
      console.error("[gitDataSync] 422 from GitHub: missing or invalid sha. If the file exists, make sure we fetched the current sha before PUT.");
    }
    console.error("[gitDataSync] PUT error:", err);
    throw err;
  }
}
