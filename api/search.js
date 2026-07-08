// api/search.js
// Vercel serverless function — proxies job search across free/legitimate APIs.
// Keeps API keys server-side (never exposed to the browser).
//
// Required environment variables (set in Vercel dashboard → Settings → Environment Variables):
//   ADZUNA_APP_ID    - from https://developer.adzuna.com/
//   ADZUNA_APP_KEY   - from https://developer.adzuna.com/
//   JOOBLE_API_KEY   - from https://jooble.org/api/about
// Arbeitnow needs no key.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { keywords = '', location = 'Australia', country = 'au' } = req.query;

  if (!keywords.trim()) {
    return res.status(400).json({ error: 'Missing "keywords" query param' });
  }

  const results = [];
  const errors = [];

  // ---------- Adzuna ----------
  try {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    if (appId && appKey) {
      const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=15&what=${encodeURIComponent(keywords)}&where=${encodeURIComponent(location)}&content-type=application/json`;
      const r = await fetch(url);
      if (r.ok) {
        const data = await r.json();
        (data.results || []).forEach(job => {
          results.push({
            source: 'Adzuna',
            title: job.title,
            company: job.company?.display_name || 'Unknown',
            location: job.location?.display_name || location,
            description: (job.description || '').slice(0, 500),
            url: job.redirect_url,
            salary: job.salary_min ? `$${Math.round(job.salary_min)} - $${Math.round(job.salary_max || job.salary_min)}` : null,
            posted: job.created
          });
        });
      } else {
        errors.push(`Adzuna: ${r.status}`);
      }
    } else {
      errors.push('Adzuna: not configured (missing ADZUNA_APP_ID/APP_KEY env vars)');
    }
  } catch (e) {
    errors.push(`Adzuna: ${e.message}`);
  }

  // ---------- Jooble ----------
  try {
    const joobleKey = process.env.JOOBLE_API_KEY;
    if (joobleKey) {
      const r = await fetch(`https://jooble.org/api/${joobleKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords, location })
      });
      if (r.ok) {
        const data = await r.json();
        (data.jobs || []).slice(0, 15).forEach(job => {
          results.push({
            source: 'Jooble',
            title: job.title,
            company: job.company || 'Unknown',
            location: job.location || location,
            description: (job.snippet || '').slice(0, 500),
            url: job.link,
            salary: job.salary || null,
            posted: job.updated
          });
        });
      } else {
        errors.push(`Jooble: ${r.status}`);
      }
    } else {
      errors.push('Jooble: not configured (missing JOOBLE_API_KEY env var)');
    }
  } catch (e) {
    errors.push(`Jooble: ${e.message}`);
  }

  // ---------- Arbeitnow (no key required) ----------
  try {
    const r = await fetch(`https://www.arbeitnow.com/api/job-board-api`);
    if (r.ok) {
      const data = await r.json();
      const kwLower = keywords.toLowerCase();
      (data.data || [])
        .filter(job =>
          job.title.toLowerCase().includes(kwLower) ||
          (job.tags || []).some(t => t.toLowerCase().includes(kwLower))
        )
        .slice(0, 15)
        .forEach(job => {
          results.push({
            source: 'Arbeitnow',
            title: job.title,
            company: job.company_name || 'Unknown',
            location: job.location || (job.remote ? 'Remote' : location),
            description: (job.description || '').replace(/<[^>]+>/g, '').slice(0, 500),
            url: job.url,
            salary: null,
            posted: job.created_at
          });
        });
    } else {
      errors.push(`Arbeitnow: ${r.status}`);
    }
  } catch (e) {
    errors.push(`Arbeitnow: ${e.message}`);
  }

  return res.status(200).json({
    count: results.length,
    results,
    errors: errors.length ? errors : undefined,
    note: "Results come from public job aggregator APIs (Adzuna, Jooble, Arbeitnow). Seek, LinkedIn and Indeed do not offer public search APIs, so they are not queried directly — some of their listings may still appear here via the aggregators."
  });
}
