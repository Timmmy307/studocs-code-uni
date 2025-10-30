(function () {
  // Utilities
  function $(sel) { return document.querySelector(sel); }
  function setText(el, text) { if (el) el.textContent = text; }
  function show(el) { if (el) el.style.display = ''; }
  function hide(el) { if (el) el.style.display = 'none'; }
  function qsParam(name) { return new URLSearchParams(location.search).get(name); }
  function pathLast() { const parts = location.pathname.split('/').filter(Boolean); return parts[parts.length - 1] || ''; }

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

  // Ban overlay and device-ban helpers
  function getBanReason() {
    try { return localStorage.getItem('reasonforbanned') || localStorage.getItem('ressonforbanned') || ''; } catch { return ''; }
  }
  function isDeviceBanned() {
    try { return localStorage.getItem('userbanned') === 'true'; } catch { return false; }
  }
  function ensureBanOverlay() {
    const overlay = $('#ban-overlay');
    if (!overlay) return null;
    return overlay;
  }
  function ensureUnbanButton() {
    const btn = $('#unban-btn');
    if (!btn) return null;
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
    return btn;
  }
  function showBan(reason) {
    const overlay = ensureBanOverlay();
    if (!overlay) return;
    overlay.querySelector('.reason').textContent = 'Reason: ' + (reason || 'Violation of rules');
    overlay.classList.add('visible');
    ensureUnbanButton();
  }

  // Nav/user info setup + ban sync
  async function initSession() {
    try {
      const me = await api('/api/me');
      setText($('#branding'), me.branding || 'Made by Firewall Freedom');
      const user = me.user;

      if (me.serverBanned) {
        try {
          localStorage.setItem('userbanned', 'true');
          localStorage.setItem('reasonforbanned', me.serverBanReason || 'Violation of rules');
          localStorage.setItem('ressonforbanned', me.serverBanReason || 'Violation of rules');
        } catch {}
      }

      if (isDeviceBanned()) {
        showBan(getBanReason());
      }

      if ($('#nav-user-info') || $('#logout-btn') || $('#admin-link') || $('#upload-link') || $('#nav-login-links') || $('#settings-link')) {
        if (user) {
          const identity = user.username && user.username.trim() ? user.username : user.email;
          setText($('#nav-user-identity'), identity);
          setText($('#nav-user-points'), String(user.points || 0));
          show($('#nav-user-info'));
          hide($('#nav-login-links'));
          show($('#nav-logout'));
          show($('#upload-link'));
          show($('#settings-link'));
          if (user.is_admin) show($('#admin-link'));
        } else {
          hide($('#nav-user-info'));
          hide($('#admin-link'));
          hide($('#upload-link'));
          hide($('#settings-link'));
          show($('#nav-login-links'));
          hide($('#nav-logout'));
        }

        $('#logout-btn')?.addEventListener('click', async (e) => {
          e.preventDefault();
          await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
          location.href = '/';
        });
      }

      return user;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // Page-specific initializers
  async function initHome() {
    const qInput = $('#q');
    const schoolInput = $('#school');
    const params = new URLSearchParams(location.search);
    if (qInput) qInput.value = params.get('q') || '';
    if (schoolInput) schoolInput.value = params.get('school') || '';

    async function runSearch() {
      const q = qInput?.value?.trim() || '';
      const school = schoolInput?.value?.trim() || '';
      const url = `/api/docs/search?q=${encodeURIComponent(q)}&school=${encodeURIComponent(school)}`;
      const data = await api(url);
      const list = $('#docs-list');
      list.innerHTML = '';
      if (!data.docs || data.docs.length === 0) {
        show($('#no-docs'));
        return;
      }
      hide($('#no-docs'));
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

    $('#search-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = qInput?.value?.trim() || '';
      const school = schoolInput?.value?.trim() || '';
      const newUrl = `/?q=${encodeURIComponent(q)}&school=${encodeURIComponent(school)}`;
      if (location.href !== newUrl) history.replaceState({}, '', newUrl);
      runSearch().catch(console.error);
    });

    api('/api/leaderboard').then(data => {
      const ol = $('#leaderboard');
      ol.innerHTML = '';
      (data.leaders || []).forEach(l => {
        const name = l.username && l.username.trim() ? l.username : l.email;
        const li = document.createElement('li');
        li.innerHTML = `<span class="name">${name}</span><span class="points">${l.points} pts</span>`;
        ol.appendChild(li);
      });
    }).catch(console.error);

    runSearch().catch(console.error);
  }

  async function initLogin() {
    $('#login-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
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
        const msg = err.message || 'Login failed';
        const el = $('#error');
        setText(el, msg);
        show(el);
      }
    });
  }

  async function initRegister() {
    $('#register-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
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
        const el = $('#error');
        setText(el, err.message || 'Registration failed');
        show(el);
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
      const el = $('#error');
      setText(el, 'You are banned and cannot upload.');
      show(el);
      return;
    }

    $('#upload-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const files = $('#pdfs').files;
      try {
        if (!files || files.length === 0) throw new Error('No files selected');
        if (files.length === 1) {
          // Single upload endpoint
          const res = await fetch('/api/docs/upload', { method: 'POST', body: fd });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.error || 'Upload failed');
          }
          const j = await res.json();
          location.href = `/docs/${j.id}`;
        } else {
          // Batch upload endpoint
          const res = await fetch('/api/docs/uploads', { method: 'POST', body: fd });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.error || 'Batch upload failed');
          }
          const j = await res.json();
          // Go to first doc or home
          if (j.ids && j.ids.length > 0) {
            location.href = `/docs/${j.ids[0]}`;
          } else {
            location.href = '/';
          }
        }
      } catch (err) {
        const el = $('#error');
        setText(el, err.message || 'Upload failed');
        show(el);
      }
    });
  }

  async function initAdmin() {
    const user = await initSession();
    if (!user || !user.is_admin) {
      show($('#admin-gate'));
      return;
    }
    try {
      const data = await api('/api/admin/pending');
      const doc = data.doc;
      if (!doc) {
        show($('#no-pending'));
        return;
      }
      show($('#verify-card'));
      setText($('#doc-title'), doc.title);
      setText($('#doc-meta-1'), `Uploader: ${doc.uploader_username || doc.uploader_email || 'Unknown'} ${doc.uploader_status === 'banned' ? '(banned)' : ''}`);
      setText($('#doc-meta-2'), `School: ${doc.school || '—'} | Grade: ${doc.grade_level || '—'} | Course: ${doc.course || '—'}`);
      setText($('#doc-desc'), doc.description || '');
      $('#doc-iframe').src = `/api/docs/${doc.id}/view`;

      $('#approve-btn').addEventListener('click', async () => {
        await api('/api/admin/approve', { method: 'POST', body: JSON.stringify({ doc_id: doc.id, uploader_id: doc.uploaded_by }) });
        location.reload();
      });

      $('#deny-btn').addEventListener('click', async () => {
        await api('/api/admin/deny', { method: 'POST', body: JSON.stringify({ doc_id: doc.id }) });
        location.reload();
      });

      $('#ban-btn').addEventListener('click', async () => {
        const reason = $('#ban-reason').value || 'Violation of rules';
        await api('/api/admin/block-user', { method: 'POST', body: JSON.stringify({ uploader_id: doc.uploaded_by, reason }) });
        location.reload();
      });

    } catch (e) {
      const el = $('#admin-error');
      setText(el, e.message || 'Error loading pending doc');
      show(el);
    }
  }

  async function initDocument() {
    const user = await initSession();
    if (!user) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname);
      return;
    }
    const id = pathLast();
    const metaEl = $('#doc-meta');
    const descEl = $('#doc-desc');
    const badgesEl = $('#doc-badges');
    const iframe = $('#doc-iframe');
    const download = $('#download-link');
    const errorEl = $('#doc-error');

    try {
      const data = await api(`/api/docs/${id}`);
      const doc = data.doc;
      setText($('#doc-title'), doc.title);
      setText(metaEl, `School: ${doc.school || '—'} | Grade: ${doc.grade_level || '—'} | Course: ${doc.course || '—'} | Tags: ${doc.tags || '—'} | Uploaded: ${new Date(doc.created_at).toLocaleString()}`);
      setText(descEl, doc.description || '');
      badgesEl.innerHTML = '';
      if (doc.uploader_status === 'banned') {
        const p1 = document.createElement('p'); p1.className = 'badge badge-warn'; p1.textContent = 'Uploader is banned'; badgesEl.appendChild(p1);
        if (doc.uploader_banned_at && new Date(doc.created_at) > new Date(doc.uploader_banned_at)) {
          const p2 = document.createElement('p'); p2.className = 'badge badge-warn'; p2.textContent = 'This was uploaded while the uploader was banned'; badgesEl.appendChild(p2);
        }
      }
      iframe.src = `/api/docs/${id}/view`;
      download.href = `/api/docs/${id}/download`;
      download.setAttribute('download', doc.title.replace(/[^a-zA-Z0-9._-]+/g, '-') + '.pdf');

      if (doc.status !== 'approved') {
        const p = document.createElement('p'); p.className = 'badge badge-info'; p.textContent = `Status: ${doc.status}`;
        badgesEl.appendChild(p);
      }
    } catch (err) {
      setText(errorEl, err.message || 'Unable to load document');
      show(errorEl);
    }
  }

  async function initSettings() {
    const user = await initSession();
    if (!user) {
      show($('#settings-gate'));
      hide($('#settings-form-wrap'));
      return;
    }
    $('#settings-email').value = user.email || '';
    $('#settings-username').value = (user.username && user.username.trim()) ? user.username : user.email;

    $('#save-username-btn')?.addEventListener('click', async () => {
      const newUsername = $('#settings-username').value.trim();
      try {
        await api('/api/account/username', { method: 'PATCH', body: JSON.stringify({ username: newUsername }) });
        setText($('#settings-msg'), 'Saved.');
        setTimeout(() => location.reload(), 600);
      } catch (e) {
        setText($('#settings-msg'), e.message || 'Could not save');
      }
    });

    $('#delete-account-btn')?.addEventListener('click', async () => {
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
    if (page === 'home') {
      initHome();
    } else if (page === 'login') {
      initLogin();
    } else if (page === 'register') {
      initRegister();
    } else if (page === 'upload') {
      initUpload();
    } else if (page === 'admin') {
      initAdmin();
    } else if (page === 'document') {
      initDocument();
    } else if (page === 'settings') {
      initSettings();
    }
  });
})();