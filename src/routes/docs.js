const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { uploadPdf, fetchBlobBySha } = require('../githubStorage');
const mime = require('mime-types');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB

const insertDoc = db.prepare(`
INSERT INTO documents
(id, title, description, course, tags, content_type, size, github_path, github_sha, uploaded_by, created_at, status, school, grade_level)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
`);

const getDoc = db.prepare(`
SELECT d.*, u.status as uploader_status, u.banned_at as uploader_banned_at, u.ban_reason as uploader_ban_reason
FROM documents d
LEFT JOIN users u ON u.id = d.uploaded_by
WHERE d.id = ?
`);

function isValidGradeLevel(val) {
  if (!val) return false;
  const trimmed = String(val).trim();
  if (trimmed.toLowerCase() === 'college') return true;
  const num = Number(trimmed);
  return Number.isInteger(num) && num >= 1 && num <= 14;
}

router.get('/upload', (req, res) => {
  if (res.locals.currentUser && res.locals.currentUser.status === 'banned') {
    return res.status(403).render('message', { page: 'Forbidden', message: 'You are banned and cannot upload.' });
  }
  res.render('upload', { page: 'upload', error: null });
});

router.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!res.locals.currentUser || res.locals.currentUser.status === 'banned') {
      throw new Error('You are banned and cannot upload.');
    }
    const { title, description, course, tags, school, grade_level } = req.body;
    if (!req.file) throw new Error('No file uploaded');
    const contentType = req.file.mimetype || mime.lookup(req.file.originalname) || 'application/pdf';
    if (contentType !== 'application/pdf') {
      throw new Error('Only PDF files are allowed');
    }
    if (!title || !title.trim()) throw new Error('Title is required');
    if (!school || !school.trim()) throw new Error('School is required');
    if (!isValidGradeLevel(grade_level)) throw new Error('Grade level must be 1–14 or College');

    const id = uuidv4();
    const gh = await uploadPdf(req.file.buffer, req.file.originalname, id);

    insertDoc.run(
      id,
      title.trim(),
      description ? description.trim() : '',
      course ? course.trim() : '',
      tags ? tags.trim() : '',
      contentType,
      req.file.size,
      gh.path,
      gh.sha,
      req.session.userId,
      new Date().toISOString(),
      school.trim(),
      String(grade_level).trim()
    );

    res.redirect(`/docs/${id}`);
  } catch (e) {
    res.status(400).render('upload', { page: 'upload', error: e.message || 'Upload failed' });
  }
});

router.get('/:id', (req, res) => {
  const doc = getDoc.get(req.params.id);
  if (!doc) return res.status(404).render('message', { page: 'Not Found', message: 'Document not found.' });

  const isAdmin = res.locals.currentUser && res.locals.currentUser.is_admin;
  const isOwner = res.locals.currentUser && res.locals.currentUser.id === doc.uploaded_by;

  if (doc.status !== 'approved' && !isAdmin && !isOwner) {
    return res.status(403).render('message', { page: 'Pending', message: 'This document is pending review.' });
  }

  res.render('document', { page: 'document', doc });
});

router.get('/:id/view', async (req, res) => {
  const doc = getDoc.get(req.params.id);
  if (!doc) return res.status(404).send('Not found');

  const isAdmin = res.locals.currentUser && res.locals.currentUser.is_admin;
  const isOwner = res.locals.currentUser && res.locals.currentUser.id === doc.uploaded_by;
  if (doc.status !== 'approved' && !isAdmin && !isOwner) {
    return res.status(403).send('Pending review');
  }

  res.setHeader('Content-Type', 'application/pdf');
  try {
    const buf = await fetchBlobBySha(doc.github_sha);
    res.send(buf);
  } catch (e) {
    res.status(500).send('Error fetching PDF');
  }
});

router.get('/:id/download', async (req, res) => {
  const doc = getDoc.get(req.params.id);
  if (!doc) return res.status(404).send('Not found');

  const isAdmin = res.locals.currentUser && res.locals.currentUser.is_admin;
  const isOwner = res.locals.currentUser && res.locals.currentUser.id === doc.uploaded_by;
  if (doc.status !== 'approved' && !isAdmin && !isOwner) {
    return res.status(403).send('Pending review');
  }

  const filename = doc.title.replace(/[^a-zA-Z0-9._-]+/g, '-') + '.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  try {
    const buf = await fetchBlobBySha(doc.github_sha);
    res.send(buf);
  } catch (e) {
    res.status(500).send('Error fetching PDF');
  }
});

module.exports = router;