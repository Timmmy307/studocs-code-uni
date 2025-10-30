const express = require('express');
const { db } = require('../db');

const router = express.Router();

function ensureAdmin(req, res, next) {
  if (!res.locals.currentUser || !res.locals.currentUser.is_admin) {
    return res.status(403).render('message', { page: 'Forbidden', message: 'Admins only.' });
  }
  next();
}

const latestPendingStmt = db.prepare(`
SELECT d.*, u.email as uploader_email, u.status as uploader_status
FROM documents d
LEFT JOIN users u ON u.id = d.uploaded_by
WHERE d.status='pending'
ORDER BY datetime(d.created_at) DESC
LIMIT 1
`);

const approveStmt = db.prepare(`UPDATE documents SET status='approved' WHERE id=?`);
const denyStmt = db.prepare(`UPDATE documents SET status='denied' WHERE id=?`);
const addPointsStmt = db.prepare(`UPDATE users SET points = points + 5 WHERE id=?`);
const banUserStmt = db.prepare(`UPDATE users SET status='banned', banned_at=?, ban_reason=? WHERE id=?`);

router.get('/verify', ensureAdmin, (req, res) => {
  const doc = latestPendingStmt.get();
  res.render('admin_verify', { page: 'verify', doc, error: null, success: null });
});

router.post('/approve', ensureAdmin, (req, res) => {
  const { doc_id, uploader_id } = req.body;
  try {
    approveStmt.run(doc_id);
    if (uploader_id) addPointsStmt.run(uploader_id); // +5 points on approval
    res.redirect('/admin/verify');
  } catch (e) {
    const doc = latestPendingStmt.get();
    res.status(400).render('admin_verify', { page: 'verify', doc, error: e.message || 'Approve failed', success: null });
  }
});

router.post('/deny', ensureAdmin, (req, res) => {
  const { doc_id } = req.body;
  try {
    denyStmt.run(doc_id);
    res.redirect('/admin/verify');
  } catch (e) {
    const doc = latestPendingStmt.get();
    res.status(400).render('admin_verify', { page: 'verify', doc, error: e.message || 'Deny failed', success: null });
  }
});

router.post('/block-user', ensureAdmin, (req, res) => {
  const { uploader_id, reason } = req.body;
  try {
    if (!uploader_id) throw new Error('No uploader id');
    const banReason = reason && reason.trim() ? reason.trim() : 'Violation of rules';
    banUserStmt.run(new Date().toISOString(), banReason, uploader_id);
    res.redirect('/admin/verify');
  } catch (e) {
    const doc = latestPendingStmt.get();
    res.status(400).render('admin_verify', { page: 'verify', doc, error: e.message || 'Block user failed', success: null });
  }
});

module.exports = router;