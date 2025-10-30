const express = require('express');
const router = express.Router();
const { db } = require('../db');

const searchStmt = db.prepare(`
SELECT d.id, d.title, d.course, d.school, d.grade_level, d.tags, d.created_at, u.status as uploader_status
FROM documents d
LEFT JOIN users u ON u.id = d.uploaded_by
WHERE
  d.status = 'approved' AND
  (COALESCE(@q, '') = '' OR d.title LIKE @q) AND
  (COALESCE(@school, '') = '' OR d.school LIKE @school)
ORDER BY datetime(d.created_at) DESC
LIMIT 100
`);

const leaderStmt = db.prepare(`
SELECT email, points
FROM users
WHERE status='active' AND is_admin=0
ORDER BY points DESC, datetime(created_at) ASC
LIMIT 10
`);

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const school = (req.query.school || '').trim();
  const likeQ = q ? `%${q}%` : '';
  const likeSchool = school ? `%${school}%` : '';
  const docs = searchStmt.all({ q: likeQ, school: likeSchool });
  const leaders = leaderStmt.all();

  res.render('index', {
    page: 'home',
    docs,
    leaders,
    query: q,
    school
  });
});

module.exports = router;