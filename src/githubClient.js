// Centralized GitHub client + config verification and masked logging

const { Octokit } = require('@octokit/rest');

const GH_OWNER = process.env.GITHUB_REPO_OWNER || '';
const GH_REPO = process.env.GITHUB_REPO_NAME || '';
const GH_BRANCH = process.env.GITHUB_REPO_BRANCH || 'main';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';

function maskToken(token) {
  if (!token) return '(unset)';
  if (token.length <= 8) return '********';
  return token.slice(0, 4) + '...' + token.slice(-4);
}

function assertBasicConfig() {
  const problems = [];
  if (!GH_OWNER) problems.push('GITHUB_REPO_OWNER is not set');
  if (!GH_REPO) problems.push('GITHUB_REPO_NAME is not set');
  if (!GH_BRANCH) problems.push('GITHUB_REPO_BRANCH is not set');
  if (!GH_TOKEN) problems.push('GITHUB_TOKEN is not set');
  if (problems.length) {
    const err = new Error('Missing GitHub configuration:\n- ' + problems.join('\n- '));
    err.isConfigError = true;
    throw err;
  }
}

function logConfigSummary(prefix = 'GitHub config') {
  const summary = [
    `${prefix}:`,
    `- owner: ${GH_OWNER || '(unset)'}`,
    `- repo: ${GH_REPO || '(unset)'}`,
    `- branch: ${GH_BRANCH || '(unset)'}`,
    `- token: ${maskToken(GH_TOKEN)}`
  ].join('\n');
  console.log(summary);
}

function configError(message) {
  const details = [
    `- GITHUB_REPO_OWNER=${GH_OWNER || '(unset)'}`,
    `- GITHUB_REPO_NAME=${GH_REPO || '(unset)'}`,
    `- GITHUB_REPO_BRANCH=${GH_BRANCH || '(unset)'}`,
    `- GITHUB_TOKEN=${GH_TOKEN ? '(set)' : '(unset)'}`
  ].join('\n');
  const help = `
${message}

Check your .env values:
${details}

Requirements:
- The repository must exist and be accessible by your token.
- The branch must already exist in the repository (create it or use the repo's default branch).
- For a private repository, the token must have "Contents: Read and write" permission (classic "repo" scope or fine‑grained with contents write to this repo).
`.trim();
  const err = new Error(help);
  err.isConfigError = true;
  return err;
}

const octokit = new Octokit({
  auth: GH_TOKEN,
  userAgent: 'FirewallFreedomDocs/2.x (+Node)',
  request: { timeout: 15000 }
});

async function verifyRepoAccess() {
  assertBasicConfig();
  // Does the repo exist and is it accessible?
  let repo;
  try {
    const { data } = await octokit.repos.get({ owner: GH_OWNER, repo: GH_REPO });
    repo = data;
  } catch (e) {
    if (e.status === 404) throw configError('Repository not found or token does not have access.');
    throw e;
  }
  // Does the branch exist?
  try {
    await octokit.repos.getBranch({ owner: GH_OWNER, repo: GH_REPO, branch: GH_BRANCH });
  } catch (e) {
    if (e.status === 404) {
      const defaultBranch = repo?.default_branch || 'main';
      throw configError(
        `Configured branch "${GH_BRANCH}" does not exist. Create it or set GITHUB_REPO_BRANCH=${defaultBranch}.`
      );
    }
    throw e;
  }
}

module.exports = {
  octokit,
  GH_OWNER,
  GH_REPO,
  GH_BRANCH,
  maskToken,
  logConfigSummary,
  verifyRepoAccess,
  configError
};