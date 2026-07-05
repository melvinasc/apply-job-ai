# AutoApply — AI Job Application Agent

Upload your CV once. The AI finds matching jobs, writes personalised cover letters, and prepares your applications — automatically, every 12 hours.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Add your Gemini API key
cp .env.example .env
# Edit .env → add GEMINI_API_KEY (free at https://aistudio.google.com/app/apikey)

# 3. Start the server
npm start

# 4. Open in your browser
# → http://localhost:3000
```

That's it. Upload your CV and the agent starts working.

---

## What it does

1. **Parses your CV** using Gemini AI — extracts skills, experience, target role
2. **Searches job boards** every 12 hours automatically:
   - Remotive, Arbeitnow, Jobicy, Remote OK — all free, no API key needed
   - Optionally: LinkedIn, Indeed, Glassdoor via JSearch (free RapidAPI tier)
3. **Scores each job** 0–100 against your CV with a reason
4. **Writes a cover letter** for every top match (score ≥ 65)
5. **Tracks everything** — you review, edit if needed, and click Apply

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Free at [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| `JSEARCH_API_KEY` | No | Adds LinkedIn/Indeed/Glassdoor. Free tier at [rapidapi.com](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch) |
| `PORT` | No | Default: `3000` |

---

## Deploy to GitHub + a host

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-username/job-auto-apply.git
git push -u origin main
```

Then deploy to **Railway**, **Render**, or **Fly.io** — just set `GEMINI_API_KEY` as an environment variable in their dashboard and point them at `npm start`.

---

## Project structure

```
├── index.html     ← Complete frontend (single HTML file, no build step)
├── server.js      ← Express backend (single JS file, no compilation)
├── package.json
├── .env.example
└── data/          ← Created automatically (SQLite DB + uploaded CVs)
```

## Tech

- **Frontend:** Single `index.html` — Tailwind CSS CDN, vanilla JavaScript
- **Backend:** Single `server.js` — Express, better-sqlite3, node-cron
- **AI:** Google Gemini 1.5 Flash — CV parsing, job scoring, cover letters
- **Scheduling:** node-cron — runs at midnight and noon every day
