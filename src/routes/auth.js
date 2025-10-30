const express = require('express');
const router = express.Router();
const { registerUser, loginUser } = require('../auth');

router.get('/login', (req, res) => {
  res.render('login', { page: 'login', error: null, next: req.query.next || '/' });
});

router.post('/login', async (req, res) => {
  try {
    const { email, password, next, client_banned, client_ban_reason } = req.body;
    const user = await loginUser(email, password, client_banned === 'true', client_ban_reason || '');
    req.session.userId = user.id;
    if (user.is_admin) {
      return res.redirect('/admin/verify');
    }
    res.redirect(next || '/');
  } catch (e) {
    res.status(400).render('login', { page: 'login', error: e.message || 'Login failed', next: req.body.next || '/' });
  }
});

router.get('/register', (req, res) => {
  res.render('register', { page: 'register', error: null });
});

router.post('/register', async (req, res) => {
  try {
    const { email, password, confirm, client_banned, client_ban_reason } = req.body;
    if (!email || !password) throw new Error('Email and password required');
    if (password !== confirm) throw new Error('Passwords do not match');
    const user = await registerUser(email.trim().toLowerCase(), password, client_banned === 'true', client_ban_reason || '');
    req.session.userId = user.id;
    res.redirect('/');
  } catch (e) {
    res.status(400).render('register', { page: 'register', error: e.message || 'Registration failed' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

module.exports = router;