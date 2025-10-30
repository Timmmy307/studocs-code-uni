const { db } = require('./db');
const { moveToBannedFolder } = require('./githubStorage');
const { markDataDirty } = require('./gitDataSync');

function startBanCleanupJob() {
  setInterval(async () => {
    try {
      const threshold = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

      const bannedUsers = db.prepare(`
        SELECT * FROM users
        WHERE status='banned' AND banned_at IS NOT NULL AND banned_at < ?
      `).all(threshold);

      const userDocsStmt = db.prepare(`SELECT * FROM documents WHERE uploaded_by = ?`);
      const deleteDocStmt = db.prepare(`DELETE FROM documents WHERE id = ?`);
      const deleteUserStmt = db.prepare(`DELETE FROM users WHERE id = ?`);

      for (const user of bannedUsers) {
        const docs = userDocsStmt.all(user.id);
        for (const doc of docs) {
          try {
            await moveToBannedFolder(doc.github_path, doc.github_sha, doc.id);
          } catch (e) {
            console.error('Error moving file to banned-pdfs for doc', doc.id, e.message);
          }
          deleteDocStmt.run(doc.id);
          markDataDirty();
        }
        deleteUserStmt.run(user.id);
        markDataDirty();
        console.log(`Purged banned user ${user.email} and relocated ${docs.length} PDFs`);
      }
    } catch (e) {
      console.error('Ban cleanup error', e);
    }
  }, 60 * 60 * 1000).unref(); // hourly
}

module.exports = {
  startBanCleanupJob
};