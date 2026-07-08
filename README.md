# Pursuit — AI Job Application Assistant

A free, client-side AI agent that helps you apply for jobs. Upload your CV, paste a job ad,
and get a fit score, tailored resume bullets, a cover letter, and application Q&A answers —
all generated in your browser.

## Why paste-only, no scraping/auto-apply?

Seek, LinkedIn, and Indeed actively block scraping and automated form submission, and doing
either risks your account getting flagged or banned. So this tool **never touches those sites
directly**:

- You paste the job description text yourself → no scraping, nothing to block
- The tool generates content for you to copy into the real application yourself → no
  auto-submission, no ToS violation, no bot detection risk

This is slower than full automation, but it's the only version of this idea that keeps working
long-term instead of getting your accounts banned after a week.

## How it works

1. **CV upload** — PDF.js / Mammoth.js parse your file entirely in-browser. Nothing is uploaded
   to any server.
2. **Job ad** — paste the text of the listing.
3. **AI model** — WebLLM loads a small open model (Llama 3.2 3B / Phi-3.5-mini / Qwen2.5 3B)
   directly in your browser via WebGPU. Free, no API key, no signup. First load downloads
   ~1-2GB, cached afterward.
4. **Pursuit** — the model generates:
   - A fit score (0-100) with honest strengths/gaps
   - Tailored resume bullets (reframing your real experience, never inventing anything)
   - A cover letter
   - Draft answers to common application questions

## Requirements

- A browser with **WebGPU support** (Chrome/Edge 113+, or recent Chromium browsers). Safari and
  Firefox support is limited/experimental as of mid-2026 — check before relying on it.
- No installs, no accounts, no API keys.

## Job search (new)

The app can now search for jobs automatically, using free/legitimate aggregator APIs:

- **Adzuna** — best Australian coverage. Sign up free at https://developer.adzuna.com/ to get an `app_id` and `app_key`.
- **Jooble** — sign up free at https://jooble.org/api/about to get an API key.
- **Arbeitnow** — no signup needed, used automatically.

**Important:** Seek, LinkedIn, and Indeed do not offer public search APIs. This app does not
scrape them — doing so risks getting your account or IP blocked. Instead, aggregators like
Adzuna often surface listings that originated on those sites, and you can always paste a listing
in manually if you find it directly on Seek/LinkedIn/Indeed yourself.

### Deploying the search backend (Vercel)

The `/api/search.js` file is a Vercel serverless function that keeps your API keys secret
(a static GitHub Pages site can't hide keys — anything in its JS is public).

```bash
npm install -g vercel
vercel login
vercel
```

Then in the Vercel dashboard for the new project: **Settings → Environment Variables**, add:

| Key | Value |
|---|---|
| `ADZUNA_APP_ID` | from developer.adzuna.com |
| `ADZUNA_APP_KEY` | from developer.adzuna.com |
| `JOOBLE_API_KEY` | from jooble.org/api |

Redeploy after adding env vars (`vercel --prod`).

### Connecting the frontend to the backend

If you keep the frontend on GitHub Pages (separate domain from Vercel), open `index.html` and
change this line near the top of the `<script>`:

```js
const SEARCH_API_BASE = "/api/search";
```

to your deployed Vercel URL, e.g.:

```js
const SEARCH_API_BASE = "https://your-project.vercel.app/api/search";
```

(If you deploy the whole app — frontend and `/api` folder together — on Vercel instead of GitHub
Pages, the relative path works as-is with no change needed.)

## Deploying to GitHub Pages

```bash
git init
git add .
git commit -m "Initial commit: Pursuit job application assistant"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Source → Deploy from branch → main → / (root)**.
Your app will be live at `https://<your-username>.github.io/<repo-name>/`.

## Limitations / honest notes

- WebLLM models are small (3B params) — good for drafting, not perfect. Always read before
  submitting.
- The fit score is a heuristic from the model, not a guarantee of anything real recruiters use.
- This won't work well on older phones or laptops without a discrete/modern integrated GPU —
  WebGPU + a 3B model needs real horsepower.
- If you'd rather not wait for local model downloads, the same UI could be pointed at the
  Claude API instead of WebLLM — happy to add that as a toggle if you want higher quality output
  at the cost of needing an API key.

## Possible next steps

- Add a "job tracker" (localStorage or a Cloudflare D1 backend, like your Belle & Occasion site)
  to log which jobs you've applied to and their status
- Support multiple job ads at once, compare fit scores side by side
- Add an optional Claude API mode (toggle between free-local and higher-quality-paid)
