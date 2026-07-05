require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const fetch = require("node-fetch");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Auth ──────────────────────────────────────────────────────────────────────
// Derive a stable session token from the password so no session store is needed.
// Changing APP_PASSWORD automatically invalidates all existing cookies.
function sessionToken() {
  const pwd = process.env.APP_PASSWORD;
  if (!pwd) return null;
  return crypto.createHmac("sha256", pwd).update("autoapply-v1").digest("hex");
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || "").split(";").forEach(part => {
    const [k, ...v] = part.trim().split("=");
    if (k) cookies[k.trim()] = decodeURIComponent(v.join("=").trim());
  });
  return cookies;
}

function requireAuth(req, res, next) {
  const token = sessionToken();
  if (!token) return next(); // APP_PASSWORD not set → open access
  if (parseCookies(req)["auth"] === token) return next();
  // API calls get 401, browser requests get redirect to login
  if (req.path.startsWith("/api")) return res.status(401).json({ error: "Unauthorised" });
  res.redirect("/login");
}

const LOGIN_PAGE = (error = "") => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoApply — Login</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 min-h-screen flex items-center justify-center">
  <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 w-full max-w-sm space-y-6">
    <div class="flex items-center gap-2">
      <div class="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
        <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
      </div>
      <span class="font-bold text-slate-900 text-lg">AutoApply</span>
    </div>
    <div>
      <h1 class="text-xl font-bold text-slate-900">Welcome back</h1>
      <p class="text-sm text-slate-500 mt-1">Enter your password to continue</p>
    </div>
    ${error ? `<div class="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">${error}</div>` : ""}
    <form method="POST" action="/login" class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-slate-700 mb-1.5">Password</label>
        <input name="password" type="password" autofocus required
          class="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          placeholder="Enter your app password">
      </div>
      <button type="submit" class="w-full py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">
        Sign in
      </button>
    </form>
  </div>
</body>
</html>`;

// Login routes (exempt from auth)
app.get("/login", (req, res) => {
  if (!sessionToken()) return res.redirect("/"); // no password set, skip login
  res.send(LOGIN_PAGE());
});

app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === process.env.APP_PASSWORD) {
    const token = sessionToken();
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie",
      `auth=${token}; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? "; Secure" : ""}`
    );
    return res.redirect("/");
  }
  res.status(401).send(LOGIN_PAGE("Incorrect password — please try again."));
});

app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "auth=; HttpOnly; Max-Age=0");
  res.redirect("/login");
});

// Apply auth to everything after this point
app.use(requireAuth);

// ── Dirs ─────────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
[DATA_DIR, UPLOAD_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, "jobs.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS resumes (
    id TEXT PRIMARY KEY, filename TEXT, original_name TEXT,
    content_text TEXT, parsed_data TEXT, target_title TEXT,
    target_location TEXT, active INTEGER DEFAULT 1, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, resume_id TEXT, title TEXT, company TEXT,
    location TEXT, url TEXT UNIQUE, description TEXT, board TEXT,
    match_score REAL DEFAULT 0, match_reason TEXT,
    status TEXT DEFAULT 'pending', found_at TEXT
  );
  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY, job_id TEXT UNIQUE, resume_id TEXT,
    cover_letter TEXT, status TEXT DEFAULT 'draft',
    created_at TEXT, submitted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, resume_id TEXT, status TEXT,
    jobs_found INTEGER DEFAULT 0, jobs_matched INTEGER DEFAULT 0,
    error TEXT, started_at TEXT, completed_at TEXT
  );
`);

// ── AI ────────────────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = () => genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function aiJSON(prompt) {
  const r = await model().generateContent(prompt);
  const t = r.response.text().trim().replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(t);
}

async function aiText(prompt) {
  const r = await model().generateContent(prompt);
  return r.response.text().trim();
}

// ── File parsing ──────────────────────────────────────────────────────────────
async function extractText(filePath, mimetype) {
  if (mimetype === "application/pdf") {
    const pdfParse = require("pdf-parse");
    return (await pdfParse(fs.readFileSync(filePath))).text;
  }
  if (mimetype.includes("wordprocessingml") || mimetype === "application/msword") {
    const mammoth = require("mammoth");
    return (await mammoth.extractRawText({ path: filePath })).value;
  }
  if (mimetype === "text/plain") return fs.readFileSync(filePath, "utf-8");
  throw new Error("Unsupported file type. Use PDF, DOCX, or TXT.");
}

async function parseCV(text) {
  try {
    return await aiJSON(`Analyze this CV and return ONLY valid JSON (no markdown):
{
  "skills": ["list of skills"],
  "experience_years": <number>,
  "job_titles": ["past job titles, newest first"],
  "education": ["qualifications"],
  "summary": "2-sentence professional summary",
  "languages": ["programming languages / frameworks"],
  "target_title": "best job title to search for",
  "target_location": "preferred location or Remote"
}
CV: ${text.slice(0, 6000)}`);
  } catch {
    return { skills: [], experience_years: 0, job_titles: [], education: [], summary: "", languages: [], target_title: "Professional", target_location: "Remote" };
  }
}

// ── Job search ────────────────────────────────────────────────────────────────
async function fetchJSON(url, headers = {}) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "AutoApply/1.0", ...headers } });
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

async function searchRemotive(terms) {
  const data = await fetchJSON(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(terms.slice(0,3).join(" "))}&limit=20`);
  return (data.jobs || []).map(j => ({ id: `rm-${j.id}`, title: j.title, company: j.company_name, location: j.candidate_required_location || "Remote", url: j.url, description: (j.description||"").replace(/<[^>]*>/g,"").slice(0,1500), board: "Remotive", found_at: new Date().toISOString() }));
}

async function searchArbeitnow(terms) {
  const data = await fetchJSON(`https://www.arbeitnow.com/api/job-board-api?search=${encodeURIComponent(terms.slice(0,2).join(" "))}`);
  return (data.data || []).slice(0,20).map(j => ({ id: `an-${j.slug}`, title: j.title, company: j.company_name, location: j.location||"Remote", url: j.url, description: (j.description||"").replace(/<[^>]*>/g,"").slice(0,1500), board: "Arbeitnow", found_at: new Date().toISOString() }));
}

async function searchJobicy(terms) {
  const tag = (terms[0]||"developer").toLowerCase().replace(/\s+/g,"-");
  const data = await fetchJSON(`https://jobicy.com/api/v2/remote-jobs?tag=${encodeURIComponent(tag)}&count=20`);
  return (data.jobs||[]).map(j => ({ id: `jy-${j.id}`, title: j.jobTitle, company: j.companyName, location: j.jobGeo||"Remote", url: j.url, description: (j.jobDescription||"").replace(/<[^>]*>/g,"").slice(0,1500), board: "Jobicy", found_at: new Date().toISOString() }));
}

async function searchRemoteOK(terms) {
  const data = await fetchJSON(`https://remoteok.com/api?tags=${encodeURIComponent(terms.slice(0,2).join(","))}`);
  return (Array.isArray(data)?data:[]).filter(j=>j.id&&j.position).slice(0,20).map(j => ({ id: `rok-${j.id}`, title: j.position, company: j.company||"", location: j.location||"Remote", url: j.url||`https://remoteok.com/remote-jobs/${j.id}`, description: (j.description||"").replace(/<[^>]*>/g,"").slice(0,1500), board: "Remote OK", found_at: new Date().toISOString() }));
}

async function searchJSearch(terms, location) {
  if (!process.env.JSEARCH_API_KEY) return [];
  const data = await fetchJSON(`https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(terms.slice(0,3).join(" ")+" "+location)}&num_pages=1`, { "X-RapidAPI-Key": process.env.JSEARCH_API_KEY, "X-RapidAPI-Host": "jsearch.p.rapidapi.com" });
  return (data.data||[]).slice(0,20).map(j => ({ id: `js-${j.job_id}`, title: j.job_title, company: j.employer_name, location: [j.job_city,j.job_country].filter(Boolean).join(", ")||"Remote", url: j.job_apply_link||j.job_google_link, description: (j.job_description||"").slice(0,1500), board: j.job_publisher||"JSearch", found_at: new Date().toISOString() }));
}

async function searchAllBoards(keywords, targetTitle, location) {
  const terms = [targetTitle, ...keywords].filter(Boolean);
  const results = await Promise.allSettled([searchRemotive(terms), searchArbeitnow(terms), searchJobicy(terms), searchRemoteOK(terms), searchJSearch(terms, location)]);
  const all = results.flatMap(r => r.status==="fulfilled" ? r.value : []);
  const seen = new Set();
  return all.filter(j => { if(!j.url||seen.has(j.url)) return false; seen.add(j.url); return true; });
}

// ── AI matching & cover letter ────────────────────────────────────────────────
async function scoreJob(job, cv) {
  try {
    return await aiJSON(`Score this job match (0-100) against the candidate. Return ONLY JSON:
{"score":<0-100>,"reason":"1-sentence explanation","relevant":<true if score>=50>}
JOB: ${job.title} at ${job.company} — ${job.description.slice(0,800)}
CANDIDATE: ${cv.target_title}, ${cv.experience_years}yrs, skills: ${cv.skills.slice(0,15).join(", ")}`);
  } catch {
    const t = `${job.title} ${job.description}`.toLowerCase();
    const hits = (cv.skills||[]).filter(s=>t.includes(s.toLowerCase()));
    const score = Math.min(100, hits.length / Math.max((cv.skills||[]).length,1) * 100);
    return { score: Math.round(score), reason: `Matched ${hits.length} skills`, relevant: score>=50 };
  }
}

async function generateCoverLetter(job, cv) {
  return aiText(`Write a professional cover letter (3-4 paragraphs, under 400 words) for this application.
Do NOT include "Dear Hiring Manager", date, address, or signature — start directly.
Be specific to this role and company. Sound genuine, not generic.
JOB: ${job.title} at ${job.company} — ${job.description.slice(0,1000)}
CANDIDATE: ${cv.summary} | Skills: ${cv.skills.slice(0,12).join(", ")} | ${cv.experience_years} years experience | Past roles: ${(cv.job_titles||[]).slice(0,3).join(", ")}`);
}

// ── Scheduler cycle ───────────────────────────────────────────────────────────
let running = false;

async function runCycle(resumeId) {
  if (running) return { error: "Already running" };
  running = true;
  const runId = uuidv4();
  const now = new Date().toISOString();

  try {
    const resume = resumeId
      ? db.prepare("SELECT * FROM resumes WHERE id=?").get(resumeId)
      : db.prepare("SELECT * FROM resumes WHERE active=1 ORDER BY created_at DESC LIMIT 1").get();

    db.prepare("INSERT INTO runs(id,resume_id,status,started_at) VALUES(?,?,?,?)").run(runId, resume?.id||null, "running", now);

    if (!resume) {
      db.prepare("UPDATE runs SET status='failed',error=?,completed_at=? WHERE id=?").run("No resume found", new Date().toISOString(), runId);
      return { error: "No resume" };
    }

    const cv = resume.parsed_data ? JSON.parse(resume.parsed_data) : {};
    const keywords = cv.skills?.slice(0,10) || [];
    const title = resume.target_title || cv.target_title || "Professional";
    const location = resume.target_location || cv.target_location || "Remote";
    const existingUrls = new Set(db.prepare("SELECT url FROM jobs WHERE resume_id=?").all(resume.id).map(j=>j.url));

    const allJobs = await searchAllBoards(keywords, title, location);
    const newJobs = allJobs.filter(j=>!existingUrls.has(j.url));
    let matched = 0;

    // Score in batches of 5 to avoid AI rate limits
    for (let i=0; i<newJobs.length; i+=5) {
      const batch = newJobs.slice(i,i+5);
      const scored = await Promise.all(batch.map(j=>scoreJob(j,cv).then(m=>({...j,...m})).catch(()=>({...j,score:0,reason:"",relevant:false}))));
      for (const job of scored) {
        if (job.score < 50) continue;
        const jobId = uuidv4();
        // Only proceed if the row was actually inserted (not a duplicate URL)
        const inserted = db.prepare("INSERT OR IGNORE INTO jobs(id,resume_id,title,company,location,url,description,board,match_score,match_reason,status,found_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)").run(jobId,resume.id,job.title,job.company,job.location,job.url,job.description,job.board,job.score,job.reason,job.found_at);
        if (inserted.changes !== 1) continue; // URL already existed — skip application creation
        if (job.score >= 65) {
          try {
            const cl = await generateCoverLetter(job, cv);
            db.prepare("INSERT INTO applications(id,job_id,resume_id,cover_letter,status,created_at) VALUES(?,?,?,?,'ready',?)").run(uuidv4(),jobId,resume.id,cl,new Date().toISOString());
          } catch { db.prepare("INSERT INTO applications(id,job_id,resume_id,status,created_at) VALUES(?,?,?,'draft',?)").run(uuidv4(),jobId,resume.id,new Date().toISOString()); }
        }
        matched++;
      }
      if (i+5 < newJobs.length) await new Promise(r=>setTimeout(r,800));
    }

    db.prepare("UPDATE runs SET status='completed',jobs_found=?,jobs_matched=?,completed_at=? WHERE id=?").run(allJobs.length, matched, new Date().toISOString(), runId);
    return { jobsFound: allJobs.length, jobsMatched: matched };
  } catch(e) {
    db.prepare("UPDATE runs SET status='failed',error=?,completed_at=? WHERE id=?").run(e.message, new Date().toISOString(), runId);
    return { error: e.message };
  } finally {
    running = false; // always reset, even if an unexpected error escapes the catch
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
// Serve only index.html — do NOT use static(__dirname) which would expose server.js, .env, etc.
app.get("/", (_,res) => res.sendFile(path.join(__dirname, "index.html")));

// ── File upload ───────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (_,f,cb)=>cb(null,`${uuidv4()}${path.extname(f.originalname)}`) }),
  limits: { fileSize: 10*1024*1024 },
  fileFilter: (_,f,cb) => ["application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/msword","text/plain"].includes(f.mimetype) ? cb(null,true) : cb(new Error("PDF, DOCX or TXT only"))
});

// ── Routes ────────────────────────────────────────────────────────────────────

// Health
app.get("/api/health", (_,res)=>res.json({ ok:true, gemini: !!process.env.GEMINI_API_KEY }));

// Resumes
app.get("/api/resumes", (_,res)=>res.json(db.prepare("SELECT * FROM resumes ORDER BY created_at DESC").all()));

app.post("/api/resumes", upload.single("file"), async(req,res)=>{
  if(!req.file) return res.status(400).json({error:"No file"});
  try {
    const text = await extractText(req.file.path, req.file.mimetype);
    if(text.trim().length<50){ fs.unlinkSync(req.file.path); return res.status(400).json({error:"Could not read file — check it isn't corrupted or password-protected"}); }
    const parsed = await parseCV(text);
    const id = uuidv4();
    db.prepare("UPDATE resumes SET active=0").run();
    db.prepare("INSERT INTO resumes(id,filename,original_name,content_text,parsed_data,target_title,target_location,active,created_at) VALUES(?,?,?,?,?,?,?,1,?)").run(id,req.file.filename,req.file.originalname,text,JSON.stringify(parsed),parsed.target_title,parsed.target_location,new Date().toISOString());
    res.status(201).json({ id, parsed });
    runCycle(id).catch(console.error); // kick off first search
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete("/api/resumes/:id", (req,res)=>{
  const r=db.prepare("SELECT * FROM resumes WHERE id=?").get(req.params.id);
  if(!r) return res.status(404).json({error:"Not found"});
  try{ fs.unlinkSync(path.join(UPLOAD_DIR,r.filename)); }catch{}
  // Cascade: delete applications then jobs then resume
  const jobIds = db.prepare("SELECT id FROM jobs WHERE resume_id=?").all(req.params.id).map(j=>j.id);
  if(jobIds.length){
    const placeholders = jobIds.map(()=>"?").join(",");
    db.prepare(`DELETE FROM applications WHERE job_id IN (${placeholders})`).run(...jobIds);
  }
  db.prepare("DELETE FROM jobs WHERE resume_id=?").run(req.params.id);
  db.prepare("DELETE FROM resumes WHERE id=?").run(req.params.id);
  res.json({ok:true});
});

// Jobs
app.get("/api/jobs", (req,res)=>{
  const {status,board,resume_id,min_score="0"}=req.query;
  let q="SELECT j.*,a.cover_letter,a.id as app_id,a.status as app_status FROM jobs j LEFT JOIN applications a ON j.id=a.job_id WHERE j.match_score>=?";
  const p=[Number(min_score)];
  if(status){q+=" AND j.status=?";p.push(status);}
  if(board){q+=" AND j.board=?";p.push(board);}
  if(resume_id){q+=" AND j.resume_id=?";p.push(resume_id);}
  q+=" ORDER BY j.match_score DESC,j.found_at DESC LIMIT 100";
  res.json(db.prepare(q).all(...p));
});

app.post("/api/jobs/:id/prepare", async(req,res)=>{
  const job=db.prepare("SELECT j.*,r.content_text,r.parsed_data FROM jobs j JOIN resumes r ON j.resume_id=r.id WHERE j.id=?").get(req.params.id);
  if(!job) return res.status(404).json({error:"Not found"});
  try {
    const cv=job.parsed_data?JSON.parse(job.parsed_data):{};
    const cl = await generateCoverLetter(job,cv);
    const exists = db.prepare("SELECT id FROM applications WHERE job_id=?").get(job.id);
    if(exists) db.prepare("UPDATE applications SET cover_letter=?,status='ready' WHERE job_id=?").run(cl,job.id);
    else db.prepare("INSERT INTO applications(id,job_id,resume_id,cover_letter,status,created_at) VALUES(?,?,?,?,'ready',?)").run(uuidv4(),job.id,job.resume_id,cl,new Date().toISOString());
    res.json({cover_letter:cl});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/jobs/:id/apply", (req,res)=>{
  db.prepare("UPDATE jobs SET status='applied' WHERE id=?").run(req.params.id);
  db.prepare("UPDATE applications SET status='submitted',submitted_at=? WHERE job_id=?").run(new Date().toISOString(),req.params.id);
  const job=db.prepare("SELECT * FROM jobs WHERE id=?").get(req.params.id);
  res.json({ok:true,url:job?.url});
});

app.post("/api/jobs/:id/skip", (req,res)=>{
  db.prepare("UPDATE jobs SET status='skipped' WHERE id=?").run(req.params.id);
  res.json({ok:true});
});

// Applications
app.get("/api/applications", (req,res)=>{
  const {resume_id,status}=req.query;
  let q="SELECT a.*,j.title,j.company,j.location,j.url,j.board,j.match_score FROM applications a JOIN jobs j ON a.job_id=j.id WHERE 1=1";
  const p=[];
  if(resume_id){q+=" AND a.resume_id=?";p.push(resume_id);}
  if(status){q+=" AND a.status=?";p.push(status);}
  q+=" ORDER BY a.created_at DESC";
  res.json(db.prepare(q).all(...p));
});

app.put("/api/applications/:id/cover-letter", (req,res)=>{
  db.prepare("UPDATE applications SET cover_letter=? WHERE id=?").run(req.body.cover_letter,req.params.id);
  res.json({ok:true});
});

// Dashboard
app.get("/api/dashboard", (req,res)=>{
  const {resume_id}=req.query;
  const w=resume_id?"WHERE resume_id=?":"";
  const p=resume_id?[resume_id]:[];
  const jobs=db.prepare(`SELECT COUNT(*) total,SUM(status='pending') pending,SUM(status='applied') applied,SUM(status='skipped') skipped,ROUND(AVG(match_score)) avg_score,MAX(match_score) top_score FROM jobs ${w}`).get(...p);
  const apps=db.prepare(`SELECT COUNT(*) total,SUM(status='submitted') submitted,SUM(status='ready') ready,SUM(status='draft') draft FROM applications a ${resume_id?"WHERE a.resume_id=?":""}`).get(...p);
  const today=db.prepare(`SELECT COUNT(*) n FROM jobs WHERE date(found_at)=date('now') ${resume_id?"AND resume_id=?":""}`).get(...p);
  const top=db.prepare(`SELECT id,title,company,location,board,match_score,status,url FROM jobs ${w} ORDER BY match_score DESC LIMIT 5`).all(...p);
  const boards=db.prepare(`SELECT board,COUNT(*) n FROM jobs ${w} GROUP BY board ORDER BY n DESC`).all(...p);
  const lastRun=db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").get();
  res.json({jobs,apps,todayNew:today?.n||0,top,boards,lastRun,running});
});

// Scheduler
app.get("/api/scheduler", (_,res)=>{
  const last=db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 5").all();
  const now=new Date(); const next=new Date(now); const h=now.getHours();
  if(h<12) next.setHours(12,0,0,0); else{next.setDate(next.getDate()+1);next.setHours(0,0,0,0);}
  res.json({running,nextRun:next.toISOString(),history:last});
});

app.post("/api/scheduler/trigger", (req,res)=>{
  res.json({ok:true,message:"Search started"});
  runCycle(req.body?.resume_id).catch(console.error);
});

// ── Multer error handler ──────────────────────────────────────────────────────
// Must be defined before the cron/listen block so Express picks it up
app.use((err,req,res,next)=>{
  if(err.code==="LIMIT_FILE_SIZE") return res.status(400).json({error:"File too large — max 10MB"});
  if(err.message) return res.status(400).json({error:err.message});
  next(err);
});

// ── Cron ──────────────────────────────────────────────────────────────────────
cron.schedule("0 0,12 * * *", ()=>{ console.log("[Cron] Starting 12-hour job search cycle"); runCycle().catch(console.error); });

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, ()=>{
  console.log(`\n✅ AutoApply running → http://localhost:${PORT}`);
  if(!process.env.GEMINI_API_KEY) console.warn("⚠️  Set GEMINI_API_KEY in .env for AI features");
});
