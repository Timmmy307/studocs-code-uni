# Firewall Freedom Docs — Static Frontend + JSON API Backend

Made by Firewall Freedom

A public, moderated course document sharing app. The frontend is static HTML/CSS/JS. The backend is a Node.js (Express) JSON API with sessions, moderation, bans, a points leaderboard, usernames, settings, and a modern UI. Users must sign in to view/download PDFs.

Key features
- Static frontend: plain HTML + JS + CSS (no server templates).
- Backend API (Express + SQLite): auth, uploads, moderation, bans, search, leaderboard.
- Usernames: Choose a username at registration (or default to your email). Edit your username anytime in Settings.
- Settings: Top-right button when signed in to change your username or delete your account.
- Delete account: Moves all your PDFs to the “banned-pdfs” area and removes your account.
- Moderation and points:
  - Admin verification queue; Approve (+5 points), Deny
  - Admin can ban users with a reason
- Bans:
  - Server-enforced account bans
  - Device ban via localStorage keys (userbanned, reasonforbanned/ressonforbanned)
  - Invisible “unbann” button (PIN 2529 or 2520) to clear device ban keys
  - Auto-purge banned accounts after 10 days; their PDFs are relocated to a “banned” area and removed from the catalog
- Discovery:
  - Search by PDF title and School
  - Metadata: Title, School, Grade (1–14 or College), Course, Tags
- Viewing:
  - Sign-in required to view or download
  - In-browser PDF preview
- Leaderboard:
  - +5 points for approved uploads
- Data sync
  - PDFs stored remotely
  - The SQLite database file (data/app.db) is synced with the remote repository:
    - Pulled on server start
    - Pushed in batched commits after any changes

Requirements
- Node 18+

Environment (.env)
- PORT=3000
- SESSION_SECRET=change_me
- DATABASE_URL=./data/app.db
- GITHUB_TOKEN=
- GITHUB_REPO_OWNER=
- GITHUB_REPO_NAME=
- GITHUB_REPO_BRANCH=main
- BRANDING_TEXT=Made by Firewall Freedom

Install
1) npm install
2) npm run dev
3) Visit http://localhost:3000
4) Register and upload (uploads go to admin review).
5) Admin login: username/email "admin", password "admin12345" → Verification dashboard at /admin.

Security/Production
- Use HTTPS and a persistent session store (e.g., Redis-compatible store) in production.
- Add CSRF protection, input validation, rate limiting, and logging.
- Replace hardcoded admin credentials with proper roles + MFA.

License
- MIT