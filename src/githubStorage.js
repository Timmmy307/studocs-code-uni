// Uses the shared GitHub client to store PDFs
const path = require('path');
const { octokit, GH_OWNER, GH_REPO, GH_BRANCH } = require('./githubClient');

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

async function uploadPdf(buffer, originalName, id) {
  const safeName = sanitizeName(originalName || `document-${id}.pdf`) || `document-${id}.pdf`;
  const relPath = path.posix.join('pdfs', id, safeName);

  const contentBase64 = buffer.toString('base64');
  const message = `Add PDF ${safeName} (${id})`;

  const { data } = await octokit.repos.createOrUpdateFileContents({
    owner: GH_OWNER,
    repo: GH_REPO,
    path: relPath,
    message,
    content: contentBase64,
    branch: GH_BRANCH
  });

  return {
    path: data.content.path,
    sha: data.content.sha
  };
}

async function fetchBlobBySha(sha) {
  const response = await octokit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', {
    owner: GH_OWNER,
    repo: GH_REPO,
    file_sha: sha,
    headers: { accept: 'application/vnd.github.raw' }
  });

  const body = response.data;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'binary');
  if (body && body.content && body.encoding === 'base64') return Buffer.from(body.content, 'base64');
  throw new Error('Unable to fetch blob content');
}

async function moveToBannedFolder(currentPath, sha, docId) {
  const rawBuf = await fetchBlobBySha(sha);
  const filename = currentPath.split('/').pop();
  const newPath = `banned-pdfs/${docId}/${filename}`;

  await octokit.repos.createOrUpdateFileContents({
    owner: GH_OWNER,
    repo: GH_REPO,
    path: newPath,
    message: `Move PDF to banned-pdfs (${docId})`,
    content: rawBuf.toString('base64'),
    branch: GH_BRANCH
  });

  await octokit.repos.deleteFile({
    owner: GH_OWNER,
    repo: GH_REPO,
    path: currentPath,
    message: `Remove original after moving to banned-pdfs (${docId})`,
    sha,
    branch: GH_BRANCH
  });

  return newPath;
}

module.exports = {
  uploadPdf,
  fetchBlobBySha,
  moveToBannedFolder
};