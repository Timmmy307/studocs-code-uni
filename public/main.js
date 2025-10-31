// Full file: public/main.js
// This version changes document viewer behavior so PDFs are fetched as ArrayBuffer and shown using a Blob URL.
// That avoids many viewer errors caused by direct iframe src to binary endpoints and lets us show a temporary
// viewer page (via blob) that browsers handle more consistently. It also revokes blob URLs when navigating away.

(function () {
  // Utilities
  function $(sel) { return document.querySelector(sel); }
  function setText(el, text) { if (el) el.textContent = text; }
  function show(el) { if (el) el) el.style.display = ''; }
  function hide(el) { if (el) el) el.style.display = 'none'; }
  function qsParam(name) { return new URLSearchParams(location.search).get(name); }
  function pathLast() { const parts = location.pathname.split('/').filter(Boolean); return parts[parts.length - 1] || ''; }

  // Safe wrappers for show/hide to avoid errors if element missing
  function safeShow(id) { const el = document.getElementById(id); if (el) el.style.display = ''; }
  function safeHide(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

  async function api(path, opts = {}) {
    const isForm = opts.body instanceof FormData;
    const headers = isForm ? {} : { 'Content-Type': 'application/json' };
    const res = await fetch(path, Object.assign({ headers }, opts));
    if (!res.ok) {
      let msg = await res.text().catch(() => '');
      try { const j = JSON.parse(msg); msg = j.error || msg; } catch {}
      throw new Error(msg || res.statusText);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res;
  }

  // Device ban helpers
  function getBanReason() {
    try { return localStorage.getItem('reasonforbanned') || localStorage.getItem('ressonforbanned') || ''; } catch { return ''; }
  }
  function isDeviceBanned() {
    try { return localStorage.getItem('userbanned') === 'true'; } catch { return false; }
  }
  function ensureUnbanButton() {
    const btn = document.getElementById('unban-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      const pin = prompt('Admin PIN to unban this device:');
      if (pin === '2529' || pin === '2520') {
        try {
          localStorage.removeItem('userbanned');
          localStorage.removeItem('reasonforbanned');
          localStorage.removeItem('ressonforbanned');
        } catch {}
        alert('Device unbanned. Reloading...');
        location.reload();
      } else if (pin !== null) {
        alert('Incorrect PIN.');
      }
    }, { once: true });
  }
  function showBanOverlay(reason) {
    const overlay = document.getElementById('ban-overlay');
    if (!overlay) return;
    const p = overlay.querySelector('.reason');
    if (p) p.textContent = 'Reason: ' + (reason || 'Violation of rules');
    overlay.classList.add('visible');
  }
  function initBanState(serverBanned, serverBanReason) {
    if (serverBanned) {
      try {
        localStorage.setItem('userbanned', 'true');
        localStorage.setItem('reasonforbanned', serverBanReason || 'Violation of rules');
        localStorage.setItem('ressonforbanned', serverBanReason || 'Violation of rules');
      } catch {}
    }
    if (isDeviceBanned()) {
      showBanOverlay(getBanReason());
    }
  }

  // Session / nav
  async function initSession() {
    try {
      const me = await api('/api/me');
      setText(document.getElementById('branding') || document.querySelector('#branding'), me.branding || 'Made by Firewall Freedom');
      const user = me.user;

      initBanState(me.serverBanned, me.serverBanReason);

      // Update nav if present
      const navIdentity = document.getElementById('nav-user-identity');
      const navPoints = document.getElementById('nav-user-points');
      const navUserInfo = document.getElementById('nav-user-info');
      const navLoginLinks = document.getElementById('nav-login-links');
      const navLogout = document.getElementById('nav-logout');
      const uploadLink = document.getElementById('upload-link');
      const settingsLink = document.getElementById('settings-link');
      const adminLink = document.getElementById('admin-link');

      if (user) {
        if (navIdentity) navIdentity.textContent = (user.username && user.username.trim()) ? user.username : user.email;
        if (navPoints) navPoints.textContent = String(user.points || 0);
        if (navUserInfo) navUserInfo.style.display = '';
        if (navLoginLinks) navLoginLinks.style.display = 'none';
        if (navLogout) navLogout.style.display = '';
        if (uploadLink) uploadLink.style.display = '';
        if (settingsLink) settingsLink.style.display = '';
        if (user.is_admin && adminLink) adminLink.style.display = '';
        // logout hook
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
          logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
            location.href = '/';
          });
        }
      } else {
        if (navUserInfo) navUserInfo.style.display = 'none';
        if (navLoginLinks) navLoginLinks.style.display = '';
        if (navLogout) navLogout.style.display = 'none';
        if (uploadLink) uploadLink.style.display = 'none';
        if (settingsLink) settingsLink.style.display = 'none';
        if (adminLink) adminLink.style.display = 'none';
      }

      return user;
    } catch (e) {
      console.error('initSession error', e);
      return null;
    }
  }

  // --- Document viewer: Fetch PDF as ArrayBuffer and display via blob URL ---
  // This solves "Failed to load PDF document" by ensuring the iframe has a blob URL that the browser can render.
  let currentBlobUrl = null;

  async function fetchPdfBlobUrl(docId) {
    // fetch binary with credentials (session cookie)
    const res = await fetch(`/api/docs/${docId}/view`, { credentials: 'same-origin' });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(txt || 'Failed to fetch PDF');
    }
    const arrayBuffer = await res.arrayBuffer();
    const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    return url;
  }

  // Clear previous blob URLs to avoid memory leaks
  function revokeCurrentBlob() {
    if (currentBlobUrl) {
      try { URL.revokeObjectURL(currentBlobUrl); } catch (e) {}
      currentBlobUrl = null;
    }
  }

  // Initialize document page: load metadata and create blob URL for iframe
  async function initDocument() {
    // Ensure user is signed in (me) — if not, redirect to login
    const me = await initSession();
    if (!me) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname);
      return;
    }

    const id = pathLast();
    const metaEl = document.getElementById('doc-meta');
    const descEl = document.getElementById('doc-desc');
    const badgesEl = document.getElementById('doc-badges');
    const iframe = document.getElementById('doc-iframe');
    const downloadLink = document.getElementById('download-link');
    const errorEl = document.getElementById('doc-error');

    try {
      const data = await api(`/api/docs/${id}`);
      const doc = data.doc;

      // Populate metadata
      if (metaEl) metaEl.textContent = `School: ${doc.school || '—'} | Grade: ${doc.grade_level || '—'} | Course: ${doc.course || '—'} | Tags: ${doc.tags || '—'} | Uploaded: ${new Date(doc.created_at).toLocaleString()}`;
      if (descEl) descEl.textContent = doc.description || '';

      // Badges
      if (badgesEl) {
        badgesEl.innerHTML = '';
        if (doc.uploader_status === 'banned') {
          const p1 = document.createElement('p'); p1.className = 'badge badge-warn'; p1.textContent = 'Uploader is banned'; badgesEl.appendChild(p1);
          if (doc.uploader_banned_at && new Date(doc.created_at) > new Date(doc.uploader_banned_at)) {
            const p2 = document.createElement('p'); p2.className = 'badge badge-warn'; p2.textContent = 'This was uploaded while the uploader was banned'; badgesEl.appendChild(p2);
          }
        }
        if (doc.status !== 'approved') {
          const p = document.createElement('p'); p.className = 'badge badge-info'; p.textContent = `Status: ${doc.status}`; badgesEl.appendChild(p);
        }
      }

      // Revoke any previous blob and fetch a new blob URL
      revokeCurrentBlob();
      currentBlobUrl = await fetchPdfBlobUrl(id);
      // Set iframe src to blob URL
      if (iframe) iframe.src = currentBlobUrl;

      // Configure download link to use same blob if possible (force download)
      if (downloadLink) {
        downloadLink.href = currentBlobUrl;
        const filename = (doc.title || 'document').replace(/[^a-zA-Z0-9._-]+/g, '-') + '.pdf';
        downloadLink.setAttribute('download', filename);
      }

      // Revoke blob when the user navigates away or unloads
      window.addEventListener('beforeunload', revokeCurrentBlob);
      window.addEventListener('pagehide', revokeCurrentBlob);

    } catch (err) {
      console.error('initDocument error', err);
      if (errorEl) {
        errorEl.style.display = '';
        errorEl.textContent = err.message || 'Unable to load document';
      } else {
        alert(err.message || 'Unable to load document');
      }
    }
  }

  // --- Other page initializers (home, login, register, upload, admin, settings) ---
  async function initHome() {
    const qInput = document.getElementById('q');
    const schoolInput = document.getElementById('school');
    const params = new URLSearchParams(location.search);
    if (qInput) qInput.value = params.get('q') || '';
    if (schoolInput) schoolInput.value = params.get('school') || '';

    async function runSearch() {
      const q = (qInput && qInput.value) ? qInput.value.trim() : '';
      const school = (schoolInput && schoolInput.value) ? schoolInput.value.trim() : '';
      const url = `/api/docs/search?q=${encodeURIComponent(q)}&school=${encodeURIComponent(school)}`;
      const data = await api(url);
      const list = document.getElementById('docs-list');
      if (!list) return;
      list.innerHTML = '';
      if (!data.docs || data.docs.length === 0) {
        const noDocs = document.getElementById('no-docs');
        if (noDocs) noDocs.style.display = '';
        return;
      }
      const noDocs = document.getElementById('no-docs');
      if (noDocs) noDocs.style.display = 'none';
      data.docs.forEach(doc => {
        const li = document.createElement('li');
        li.className = 'doc-item';
        li.innerHTML = `
          <h3><a href="/docs/${doc.id}">${doc.title}</a></h3>
          <p class="meta">
            <strong>School:</strong> ${doc.school || '—'}
            ${doc.grade_level ? ` | <strong>Grade:</strong> ${doc.grade_level}` : ''}
            ${doc.course ? ` | <strong>Course:</strong> ${doc.course}` : ''}
            ${doc.tags ? ` | <strong>Tags:</strong> ${doc.tags}` : ''}
          </p>
          ${doc.uploader_status === 'banned' ? `<p class="badge badge-warn">Uploader is banned</p>` : ''}
          <p class="time">${new Date(doc.created_at).toLocaleString()}</p>
        `;
        list.appendChild(li);
      });
    }

    const searchForm = document.getElementById('search-form');
    if (searchForm) {
      searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = (qInput && qInput.value) ? qInput.value.trim() : '';
        const school = (schoolInput && schoolInput.value) ? schoolInput.value.trim() : '';
        const newUrl = `/?q=${encodeURIComponent(q)}&school=${encodeURIComponent(school)}`;
        if (location.href !== newUrl) history.replaceState({}, '', newUrl);
        runSearch().catch(console.error);
      });
    }

    // Leaderboard
    try {
      const lb = await api('/api/leaderboard');
      const ol = document.getElementById('leaderboard');
      if (ol) {
        ol.innerHTML = '';
        (lb.leaders || []).forEach(l => {
          const name = (l.username && l.username.trim()) ? l.username : l.email;
          const li = document.createElement('li');
          li.textContent = `${name} | ${l.points} pts`;
          ol.appendChild(li);
        });
      }
    } catch (e) {
      console.error('leaderboard load error', e);
    }

    runSearch().catch(console.error);
  }

  async function initLogin() {
    const form = document.getElementById('login-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const payload = {
        email: fd.get('email'),
        password: fd.get('password'),
        client_banned: isDeviceBanned(),
        client_ban_reason: getBanReason() || 'Device banned'
      };
      try {
        await api('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
        location.href = '/';
      } catch (err) {
        const el = document.getElementById('error');
        if (el) { el.style.display = ''; el.textContent = err.message || 'Login failed'; }
      }
    });
  }

  async function initRegister() {
    const form = document.getElementById('register-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const payload = {
        email: fd.get('email'),
        username: fd.get('username'),
        password: fd.get('password'),
        confirm: fd.get('confirm'),
        client_banned: isDeviceBanned(),
        client_ban_reason: getBanReason() || 'Device banned'
      };
      try {
        await api('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) });
        location.href = '/';
      } catch (err) {
        const el = document.getElementById('error');
        if (el) { el.style.display = ''; el.textContent = err.message || 'Registration failed'; }
      }
    });
  }

  async function initUpload() {
    const user = await initSession();
    if (!user) {
      location.href = '/login?next=' + encodeURIComponent('/upload');
      return;
    }
    if (user.status === 'banned') {
      const el = document.getElementById('error');
      if (el) { el.style.display = ''; el.textContent = 'You are banned and cannot upload.'; }
      return;
    }
    const form = document.getElementById('upload-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const files = document.getElementById('pdfs')?.files;
      try {
        if (!files || files.length === 0) throw new Error('No files selected');
        const endpoint = (files.length === 1) ? '/api/docs/upload' : '/api/docs/uploads';
        const res = await fetch(endpoint, { method: 'POST', body: fd });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || 'Upload failed');
        }
        const j = await res.json();
        if (j.id) location.href = `/docs/${j.id}`;
        else if (j.ids && j.ids.length) location.href = `/docs/${j.ids[0]}`;
        else location.href = '/';
      } catch (err) {
        const el = document.getElementById('error');
        if (el) { el.style.display = ''; el.textContent = err.message || 'Upload failed'; }
      }
    });
  }

  async function initAdmin() {
    const user = await initSession();
    if (!user || !user.is_admin) {
      const gate = document.getElementById('admin-gate');
      if (gate) gate.style.display = '';
      return;
    }
    try {
      const data = await api('/api/admin/pending');
      const doc = data.doc;
      if (!doc) {
        const np = document.getElementById('no-pending'); if (np) np.style.display = '';
        return;
      }
      const card = document.getElementById('verify-card'); if (card) card.style.display = '';
      document.getElementById('doc-title').textContent = doc.title;
      document.getElementById('doc-meta-1').textContent = `Uploader: ${doc.uploader_username || doc.uploader_email || 'Unknown'} ${doc.uploader_status === 'banned' ? '(banned)' : ''}`;
      document.getElementById('doc-meta-2').textContent = `School: ${doc.school || '—'} | Grade: ${doc.grade_level || '—'} | Course: ${doc.course || '—'}`;
      document.getElementById('doc-desc').textContent = doc.description || '';
      document.getElementById('doc-iframe').src = `/api/docs/${doc.id}/view`; // admin preview can be direct
      document.getElementById('approve-btn').addEventListener('click', async () => {
        await api('/api/admin/approve', { method: 'POST', body: JSON.stringify({ doc_id: doc.id, uploader_id: doc.uploaded_by }) });
        location.reload();
      });
      document.getElementById('deny-btn').addEventListener('click', async () => {
        await api('/api/admin/deny', { method: 'POST', body: JSON.stringify({ doc_id: doc.id }) });
        location.reload();
      });
      document.getElementById('ban-btn').addEventListener('click', async () => {
        const reason = document.getElementById('ban-reason').value || 'Violation of rules';
        await api('/api/admin/block-user', { method: 'POST', body: JSON.stringify({ uploader_id: doc.uploaded_by, reason }) });
        location.reload();
      });
    } catch (e) {
      console.error('initAdmin error', e);
      const el = document.getElementById('admin-error'); if (el) { el.style.display = ''; el.textContent = e.message || 'Error loading pending doc'; }
    }
  }

  async function initSettings() {
    const user = await initSession();
    if (!user) {
      document.getElementById('settings-gate').style.display = '';
      document.getElementById('settings-form-wrap').style.display = 'none';
      return;
    }
    document.getElementById('settings-email').value = user.email || '';
    document.getElementById('settings-username').value = (user.username && user.username.trim()) ? user.username : user.email;
    document.getElementById('save-username-btn')?.addEventListener('click', async () => {
      const newUsername = document.getElementById('settings-username').value.trim();
      try {
        await api('/api/account/username', { method: 'PATCH', body: JSON.stringify({ username: newUsername }) });
        document.getElementById('settings-msg').textContent = 'Saved.';
        setTimeout(() => location.reload(), 600);
      } catch (e) {
        document.getElementById('settings-msg').textContent = e.message || 'Could not save';
      }
    });
    document.getElementById('delete-account-btn')?.addEventListener('click', async () => {
      const confirmText = prompt('Type DELETE to permanently delete your account and move your PDFs to banned-pdfs.');
      if (confirmText !== 'DELETE') return;
      try {
        await api('/api/account', { method: 'DELETE', body: JSON.stringify({}) });
        alert('Your account has been deleted.');
        location.href = '/';
      } catch (e) {
        alert(e.message || 'Could not delete account.');
      }
    });
  }

  async function initCommon() {
    await initSession().catch(console.error);
    ensureUnbanButton();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await initCommon();
    const page = document.body.getAttribute('data-page');
    if (page === 'home') initHome();
    else if (page === 'login') initLogin();
    else if (page === 'register') initRegister();
    else if (page === 'upload') initUpload();
    else if (page === 'admin') initAdmin();
    else if (page === 'document') initDocument();
    else if (page === 'settings') initSettings();
  });
})();
