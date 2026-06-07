// server.js — AI Targetolog Backend (PostgreSQL + Admin)
// Hosting: Render | DB: Neon/Render PostgreSQL (DATABASE_URL kerak)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// =====================================================================
// DATABASE (PostgreSQL)
// =====================================================================
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL yo\'q! Neon/Postgres connection string\'ni Render env\'ga qo\'ying.');
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon/Render uchun
  max: 5,
});
const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const many = async (text, params) => (await pool.query(text, params)).rows;

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      phone TEXT UNIQUE,
      password_hash TEXT,
      google_id TEXT UNIQUE,
      avatar TEXT,
      fb_acc_id TEXT,
      bm_id TEXT,
      page_name TEXT,
      role TEXT DEFAULT 'user',
      created_at TIMESTAMPTZ DEFAULT now(),
      last_login TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS otp_codes (
      id SERIAL PRIMARY KEY,
      contact TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      nisha TEXT, budget REAL, geo TEXT, goal TEXT, offer TEXT,
      conversion REAL DEFAULT 4, status TEXT DEFAULT 'active', fb_campaign_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS daily_reports (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      report_date DATE NOT NULL,
      spend REAL DEFAULT 0, reach INTEGER DEFAULT 0, impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0, ctr REAL DEFAULT 0, cpc REAL DEFAULT 0,
      leads INTEGER DEFAULT 0, cpl REAL DEFAULT 0, sales INTEGER DEFAULT 0, roas REAL DEFAULT 0,
      ai_comment TEXT, created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('✅ DB jadvallari tayyor');
}

// =====================================================================
// AUTH
// =====================================================================
const JWT_SECRET = process.env.JWT_SECRET || 'ai-targetolog-secret-2024';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
function signToken(userId) { return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' }); }
function roleFor(email) { return (email && ADMIN_EMAIL && email.toLowerCase() === ADMIN_EMAIL) ? 'admin' : 'user'; }

async function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Token kerak' });
  try {
    const p = jwt.verify(h.slice(7), JWT_SECRET);
    const u = await one('SELECT id, name, email, phone, role, fb_acc_id, bm_id, page_name FROM users WHERE id=$1', [p.userId]);
    if (!u) return res.status(401).json({ error: 'Foydalanuvchi topilmadi' });
    req.user = u; next();
  } catch (e) { return res.status(401).json({ error: 'Token yaroqsiz' }); }
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin huquqi kerak' });
  next();
}

// =====================================================================
// ESKIZ SMS (ixtiyoriy)
// =====================================================================
let eskizToken = process.env.ESKIZ_TOKEN || '';
const smsConfigured = !!(process.env.ESKIZ_TOKEN || (process.env.ESKIZ_EMAIL && process.env.ESKIZ_PASSWORD));
async function getEskizToken() {
  if (eskizToken) return eskizToken;
  const email = process.env.ESKIZ_EMAIL, password = process.env.ESKIZ_PASSWORD;
  if (!email || !password) return '';
  try {
    const r = await fetch('https://notify.eskiz.uz/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const d = await r.json(); eskizToken = d?.data?.token || ''; return eskizToken;
  } catch (e) { console.error('[eskiz]', e.message); return ''; }
}
async function sendOTP(contact, code) {
  const message = `AI Targetolog tasdiqlash kodi: ${code}`;
  let token = await getEskizToken();
  if (!token) { console.log(`\n📱 OTP [${contact}]: ${code} (konsol)\n`); return; }
  const trySend = (t) => fetch('https://notify.eskiz.uz/api/message/sms/send', { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile_phone: contact, message, from: process.env.ESKIZ_FROM || '4546' }) });
  try {
    let r = await trySend(token);
    if (r.status === 401 && process.env.ESKIZ_EMAIL) { eskizToken=''; token=await getEskizToken(); if(token) r=await trySend(token); }
    if (!r.ok) console.log(`\n📱 OTP [${contact}]: ${code} (fallback)\n`); else console.log('[eskiz] yuborildi');
  } catch (e) { console.log(`\n📱 OTP [${contact}]: ${code} (fallback)\n`); }
}

// =====================================================================
// AI (LLM)
// =====================================================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SYSTEM_PROMPT = `Siz — "Energiya AI Targetolog", Meta Ads bo'yicha tajribali targetologsiz. O'zbek (lotin) tilida.
Linzalar: Hormozi, Suby, Brunson, DeMarco, Isaev, Kern, Edwards. Aniq raqamlar, lokal bozor, test→o'lchov→masshtab, qisqa.
KPI yashil: CTR>1.5%, CPC<$1.5, CPM<$3, Frequency<2.5. Meta policy buzilmasin. Oxirida "Keyingi qadam".`;
function activeProvider() { if (ANTHROPIC_API_KEY) return 'anthropic'; if (OPENAI_API_KEY) return 'openai'; return null; }
async function callAnthropic(p, mt=1200) {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{'content-type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'}, body: JSON.stringify({ model:ANTHROPIC_MODEL, max_tokens:mt, system:SYSTEM_PROMPT, messages:[{role:'user',content:p}] }) });
  if (!r.ok) throw new Error('Anthropic '+r.status); const d=await r.json(); return (d.content||[]).map(c=>c.text).join('').trim();
}
async function callOpenAI(p, mt=1200) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', { method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${OPENAI_API_KEY}`}, body: JSON.stringify({ model:OPENAI_MODEL, max_tokens:mt, messages:[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:p}] }) });
  if (!r.ok) throw new Error('OpenAI '+r.status); const d=await r.json(); return (d.choices?.[0]?.message?.content||'').trim();
}
async function runLLM(p, mt) { const pr=activeProvider(); if(pr==='anthropic') return {text:await callAnthropic(p,mt),provider:pr}; if(pr==='openai') return {text:await callOpenAI(p,mt),provider:pr}; return {text:null,provider:null}; }
function analysisPrompt(d){ return `Yangi loyiha strategik tahlili. Biznes: ${d.bizName||'—'} | Nisha: ${d.nisha||'—'} | Offer: ${d.offer||'—'} | Budjet: $${d.budget||'—'}/oy | Geo: ${d.geo||'—'} | Maqsad: ${d.goal||'—'} | Konversiya: ${d.conversion||'—'}% | Og'riq: ${d.pain||'—'}. Tuzilish: 1) Offer auditi 2) 2 segment 3) 3 hook 4) Test budjeti 5) KPI 6) Keyingi qadam. Qisqa, o'zbekcha.`; }
function optimizePrompt(d,reports){ const rows=(reports||[]).map(r=>`  ${r.report_date}: $${r.spend}, CTR ${r.ctr}%, CPC $${r.cpc}, leads ${r.leads}, CPL $${r.cpl}`).join('\n'); return `Optimizatsiya. ${d.bizName||'—'} | ${d.nisha||'—'} | $${d.budget||'—'}.\nHisobotlar:\n${rows||'  yo\'q'}\nQisqa: 1) Diagnoz 2) 3 amal 3) Scale qarori 4) Keyingi qadam.`; }
function templateAnalysis(d){ const b=+d.budget||100, daily=(b/30).toFixed(1), conv=+d.conversion||4, cr=b<300?3:b<700?6:10, tsh=(d.geo||'').toLowerCase().includes('tosh');
  return `**Offer auditi (Hormozi):** "${d.offer||d.nisha||'mahsulot'}" — Value Equation: orzu natija, kafolat/keys, vaqt, kuch. Kafolat va ijtimoiy isbot qo'shing.\n\n**Auditoriya (Suby):** byudjetning 60–70% sovuqqa. 2 segment:\n• A: og'riq egasi (${d.pain||"og'riq"}) — keng interes + ${d.geo||'Toshkent'}.\n• B: broad (geo+yosh+jins).\n\n**3 hook:**\n1. "${d.pain||'Shu muammo'} sizda bormi?" (Curiosity)\n2. Aniq raqam+vaqt (Demonstration)\n3. Mijoz guvohligi UGC (Before-After)\n\n**Budjet (test):** kunlik ~$${daily}, ABO, 2–3 adset, har birida ${cr>=6?3:cr} kreativ, Lead.\n\n**KPI:** CTR>1.5%, CPC<$1.5, CPL ${tsh?'$2–5':'$3–8'}, Frequency<2.5. Konversiya ${conv}% past bo'lsa — landing muammosi.\n\n**Keyingi qadam:** 2 segment × 3 kreativ test, 7 kun kuzating.\n\n_(ℹ️ Shablon. Real AI uchun ANTHROPIC_API_KEY yoki OPENAI_API_KEY qo'shing.)_`; }
function templateOptimize(d,reports){ const last=(reports||[])[0]; let diag='Ma\'lumot yetarli emas — 7 kun (≈50 konversiya) bering.'; if(last){const ctr=+last.ctr||0,cpl=+last.cpl||0; if(ctr&&ctr<0.8)diag=`CTR past (${ctr}%) — hook muammosi.`; else if(cpl)diag=`CPL $${cpl} — landing/offerni tekshiring.`;}
  return `**Diagnoz:** ${diag}\n\n**3 amal:** 1) Yutqazgan kreativni o'chiring. 2) Yutgan budjetini 2 kunda 20% oshiring. 3) 1% Lookalike.\n\n**Scale:** CPL maqsadda — masshtab; Frequency>2.5 — yangi kreativ.\n\n**Keyingi qadam:** 2 kundan keyin CTR/CPL ko'ring.\n\n_(ℹ️ Shablon. Real AI uchun API kalit qo'shing.)_`; }

function deriveMetrics(b){ const spend=+b.spend||0,reach=+b.reach||0,impr=+b.impressions||0,clicks=+b.clicks||0,leads=+b.leads||0,sales=+b.sales||0; const base=impr>0?impr:reach; const ctr=base>0?+((clicks/base)*100).toFixed(2):0; const cpc=clicks>0?+(spend/clicks).toFixed(2):0; const cpl=leads>0?+(spend/leads).toFixed(2):0; return {spend,reach,impressions:impr,clicks,leads,sales,ctr,cpc,cpl}; }
function aiComment({cpl,cpaTarget,ctr,leads}){ if(!cpl||!leads) return 'ℹ️ Ma\'lumot yetarli emas.'; const r=cpl/(cpaTarget||10); let m; if(r<0.8)m='🟢 CPL past — scale.'; else if(r<1)m='✅ CPL maqsadda.'; else if(r<1.5)m='🟡 CPL biroz yuqori.'; else m='🔴 CPL yuqori — fatigue.'; if(ctr>0){if(ctr<0.8)m+=' CTR past.'; else if(ctr>1.5)m+=' CTR kuchli.';} return m; }
const genOTP = () => Math.floor(100000 + Math.random()*900000).toString();

// =====================================================================
// APP
// =====================================================================
const app = express();
const PORT = process.env.PORT || 3001;
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 300, message: { error: "Ko'p so'rov." } }));
app.use('/api/auth/', rateLimit({ windowMs: 15*60*1000, max: 40, message: { error: 'Juda ko\'p urinish.' } }));

app.get('/api/health', async (req, res) => {
  let db = false; try { await q('SELECT 1'); db = true; } catch (e) {}
  res.json({ status: 'ok', version: '2.0.0', db, llm: !!activeProvider(), sms: smsConfigured, time: new Date().toISOString() });
});

// ---------- AUTH ----------
const auth = express.Router();
auth.post('/google', async (req, res) => {
  const { googleId, name, email, avatar } = req.body;
  if (!googleId || !email) return res.status(400).json({ error: "Google ma'lumotlari yetarli emas" });
  try {
    let u = await one('SELECT * FROM users WHERE google_id=$1 OR email=$2', [googleId, email]);
    if (!u) u = await one('INSERT INTO users (name,email,google_id,avatar,role) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, email, googleId, avatar||null, roleFor(email)]);
    else await q('UPDATE users SET google_id=$1, name=$2, avatar=$3, role=$4, last_login=now() WHERE id=$5', [googleId, name, avatar||u.avatar, roleFor(email), u.id]);
    res.json({ token: signToken(u.id), user: { id:u.id, name:u.name, email:u.email, avatar:u.avatar, role: roleFor(email) } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server xatosi' }); }
});
auth.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length < 9) return res.status(400).json({ error: "To'g'ri telefon raqam kiriting" });
  const cp = phone.replace(/\D/g,''), code = genOTP(), exp = new Date(Date.now()+5*60*1000).toISOString();
  try {
    await q('UPDATE otp_codes SET used=1 WHERE contact=$1 AND used=0', [cp]);
    await q('INSERT INTO otp_codes (contact,code,expires_at) VALUES ($1,$2,$3)', [cp, code, exp]);
    sendOTP(cp, code);
    res.json({ success: true, sms: smsConfigured, message: 'OTP yuborildi', dev_code: smsConfigured ? undefined : code });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server xatosi' }); }
});
auth.post('/verify-otp', async (req, res) => {
  const { phone, code, name } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Telefon va OTP kerak' });
  const cp = phone.replace(/\D/g,'');
  try {
    const o = await one("SELECT * FROM otp_codes WHERE contact=$1 AND code=$2 AND used=0 AND expires_at>now() ORDER BY id DESC LIMIT 1", [cp, code]);
    if (!o) return res.status(400).json({ error: "OTP noto'g'ri yoki muddati o'tgan" });
    await q('UPDATE otp_codes SET used=1 WHERE id=$1', [o.id]);
    let u = await one('SELECT * FROM users WHERE phone=$1', [cp]);
    if (!u) u = await one('INSERT INTO users (name,phone) VALUES ($1,$2) RETURNING *', [name||'Foydalanuvchi', cp]);
    else await q('UPDATE users SET last_login=now() WHERE id=$1', [u.id]);
    res.json({ token: signToken(u.id), user: { id:u.id, name:u.name, phone:u.phone } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server xatosi' }); }
});
auth.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Ism, email va parol kerak' });
  if (password.length < 6) return res.status(400).json({ error: 'Parol kamida 6 ta belgi' });
  try {
    if (await one('SELECT id FROM users WHERE email=$1', [email])) return res.status(400).json({ error: 'Bu email allaqachon ro\'yxatdan o\'tgan' });
    const hash = await bcrypt.hash(password, 10);
    const u = await one('INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,name,email,role', [name, email, hash, roleFor(email)]);
    res.json({ token: signToken(u.id), user: u });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server xatosi' }); }
});
auth.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email va parol kerak' });
  try {
    const u = await one('SELECT * FROM users WHERE email=$1', [email]);
    if (!u || !u.password_hash) return res.status(401).json({ error: "Email yoki parol noto'g'ri" });
    if (!(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: "Email yoki parol noto'g'ri" });
    // admin emailini har kirishda rolini yangilaymiz
    const role = roleFor(email);
    if (role !== u.role) await q('UPDATE users SET role=$1 WHERE id=$2', [role, u.id]);
    await q('UPDATE users SET last_login=now() WHERE id=$1', [u.id]);
    res.json({ token: signToken(u.id), user: { id:u.id, name:u.name, email:u.email, role } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server xatosi' }); }
});
auth.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));
auth.patch('/update-fb', requireAuth, async (req, res) => {
  const { fb_acc_id, bm_id, page_name } = req.body;
  await q('UPDATE users SET fb_acc_id=$1, bm_id=$2, page_name=$3 WHERE id=$4', [fb_acc_id||null, bm_id||null, page_name||null, req.user.id]);
  res.json({ success: true });
});
app.use('/api/auth', auth);

// ---------- CAMPAIGNS ----------
const camp = express.Router(); camp.use(requireAuth);
camp.get('/', async (req, res) => res.json({ campaigns: await many('SELECT * FROM campaigns WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]) }));
camp.post('/', async (req, res) => {
  const { name, nisha, budget, geo, goal, offer, conversion } = req.body;
  if (!name || !nisha || !budget) return res.status(400).json({ error: 'Ism, nisha va budjet kerak' });
  const c = await one('INSERT INTO campaigns (user_id,name,nisha,budget,geo,goal,offer,conversion) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [req.user.id, name, nisha, budget, geo||'Toshkent', goal||"Lead yig'ish", offer||'', conversion||4]);
  res.json({ campaign: c });
});
camp.get('/:id', async (req, res) => { const c = await one('SELECT * FROM campaigns WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); if (!c) return res.status(404).json({ error: 'Topilmadi' }); res.json({ campaign: c }); });
camp.put('/:id', async (req, res) => {
  const { name, nisha, budget, geo, goal, offer, conversion, status, fb_campaign_id } = req.body;
  const c = await one('SELECT id FROM campaigns WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!c) return res.status(404).json({ error: 'Topilmadi' });
  await q(`UPDATE campaigns SET name=COALESCE($1,name), nisha=COALESCE($2,nisha), budget=COALESCE($3,budget), geo=COALESCE($4,geo), goal=COALESCE($5,goal), offer=COALESCE($6,offer), conversion=COALESCE($7,conversion), status=COALESCE($8,status), fb_campaign_id=COALESCE($9,fb_campaign_id), updated_at=now() WHERE id=$10`,
    [name??null, nisha??null, budget??null, geo??null, goal??null, offer??null, conversion??null, status??null, fb_campaign_id??null, req.params.id]);
  res.json({ success: true });
});
camp.delete('/:id', async (req, res) => { await q('DELETE FROM daily_reports WHERE campaign_id=$1 AND user_id=$2', [req.params.id, req.user.id]); await q('DELETE FROM campaigns WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); res.json({ success: true }); });
app.use('/api/campaigns', camp);

// ---------- REPORTS ----------
const rep = express.Router(); rep.use(requireAuth);
rep.get('/', async (req, res) => {
  const { campaign_id, limit = 30 } = req.query;
  if (campaign_id) return res.json({ reports: await many('SELECT * FROM daily_reports WHERE user_id=$1 AND campaign_id=$2 ORDER BY report_date DESC LIMIT $3', [req.user.id, campaign_id, parseInt(limit)]) });
  res.json({ reports: await many('SELECT * FROM daily_reports WHERE user_id=$1 ORDER BY report_date DESC LIMIT $2', [req.user.id, parseInt(limit)]) });
});
rep.post('/', async (req, res) => {
  const { campaign_id, report_date, roas } = req.body;
  if (!campaign_id || !report_date) return res.status(400).json({ error: 'campaign_id va report_date kerak' });
  const c = await one('SELECT * FROM campaigns WHERE id=$1 AND user_id=$2', [campaign_id, req.user.id]);
  if (!c) return res.status(403).json({ error: 'Ruxsat yo\'q' });
  const m = deriveMetrics(req.body), roasVal = +roas||0;
  const daily=(c.budget||0)/30, exp=Math.max(1,Math.round((daily/1.8)*1000*1.5/100)), cpaTarget=daily>0?+(daily/exp).toFixed(2):10;
  const ac = aiComment({ cpl:m.cpl, cpaTarget, ctr:m.ctr, leads:m.leads });
  const ex = await one('SELECT id FROM daily_reports WHERE campaign_id=$1 AND report_date=$2', [campaign_id, report_date]);
  if (ex) await q('UPDATE daily_reports SET spend=$1,reach=$2,impressions=$3,clicks=$4,ctr=$5,cpc=$6,leads=$7,cpl=$8,sales=$9,roas=$10,ai_comment=$11 WHERE id=$12', [m.spend,m.reach,m.impressions,m.clicks,m.ctr,m.cpc,m.leads,m.cpl,m.sales,roasVal,ac,ex.id]);
  else await q('INSERT INTO daily_reports (campaign_id,user_id,report_date,spend,reach,impressions,clicks,ctr,cpc,leads,cpl,sales,roas,ai_comment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', [campaign_id,req.user.id,report_date,m.spend,m.reach,m.impressions,m.clicks,m.ctr,m.cpc,m.leads,m.cpl,m.sales,roasVal,ac]);
  res.json({ success: true, ai_comment: ac, metrics: { ...m, roas: roasVal, cpaTarget } });
});
rep.get('/summary/:campaign_id', async (req, res) => {
  const c = await one('SELECT * FROM campaigns WHERE id=$1 AND user_id=$2', [req.params.campaign_id, req.user.id]);
  if (!c) return res.status(404).json({ error: 'Topilmadi' });
  const s = await one(`SELECT COUNT(*)::int days, COALESCE(SUM(spend),0) total_spend, COALESCE(SUM(reach),0) total_reach, COALESCE(SUM(clicks),0) total_clicks, COALESCE(SUM(leads),0) total_leads, COALESCE(SUM(sales),0) total_sales, COALESCE(AVG(cpl),0) avg_cpl, COALESCE(AVG(cpc),0) avg_cpc, COALESCE(AVG(ctr),0) avg_ctr, COALESCE(MAX(leads),0) best_leads_day FROM daily_reports WHERE campaign_id=$1`, [req.params.campaign_id]);
  res.json({ summary: s, campaign: c });
});
app.use('/api/reports', rep);

// ---------- AI ----------
const ai = express.Router();
ai.get('/status', (req, res) => res.json({ provider: activeProvider(), llm: !!activeProvider() }));
ai.post('/analyze', async (req, res) => {
  const d = req.body || {};
  if (!d.nisha && !d.offer) return res.status(400).json({ error: 'nisha yoki offer kerak' });
  try { const { text, provider } = await runLLM(analysisPrompt(d), 1300); return res.json(text ? { source: provider, text } : { source: 'template', text: templateAnalysis(d) }); }
  catch (e) { return res.json({ source: 'template', text: templateAnalysis(d), warning: 'LLM xatosi' }); }
});
ai.post('/optimize', async (req, res) => {
  const { biz = {}, reports = [] } = req.body || {};
  try { const { text, provider } = await runLLM(optimizePrompt(biz, reports), 1100); return res.json(text ? { source: provider, text } : { source: 'template', text: templateOptimize(biz, reports) }); }
  catch (e) { return res.json({ source: 'template', text: templateOptimize(biz, reports), warning: 'LLM xatosi' }); }
});
app.use('/api/ai', ai);

// ---------- ADMIN ----------
const admin = express.Router(); admin.use(requireAuth, requireAdmin);
admin.get('/stats', async (req, res) => {
  const u = await one('SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE created_at > now() - interval \'7 days\')::int last7, COUNT(*) FILTER (WHERE created_at::date = now()::date)::int today FROM users');
  const c = await one('SELECT COUNT(*)::int total FROM campaigns');
  const r = await one('SELECT COUNT(*)::int total FROM daily_reports');
  res.json({ users: u, campaigns: c, reports: r });
});
admin.get('/users', async (req, res) => {
  const users = await many(`SELECT u.id, u.name, u.email, u.phone, u.role, u.created_at, u.last_login,
    (SELECT COUNT(*)::int FROM campaigns c WHERE c.user_id=u.id) AS campaigns
    FROM users u ORDER BY u.created_at DESC`);
  res.json({ users });
});
admin.get('/campaigns', async (req, res) => {
  const campaigns = await many(`SELECT c.*, u.name AS user_name, u.email AS user_email FROM campaigns c JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC LIMIT 200`);
  res.json({ campaigns });
});
app.use('/api/admin', admin);

app.get('/', (req, res) => res.json({ service: 'AI Targetolog Backend v2', health: '/api/health' }));
app.use((err, req, res, next) => { console.error(err.stack); res.status(500).json({ error: 'Ichki server xatosi' }); });

initDb()
  .then(() => app.listen(PORT, () => console.log(`AI Targetolog Backend v2 on port ${PORT} (db: postgres, llm: ${activeProvider()||'template'}, admin: ${ADMIN_EMAIL||'sozlanmagan'})`)))
  .catch((e) => { console.error('DB init xatosi:', e.message); app.listen(PORT, () => console.log(`Server ishladi (DB ulanmadi!) port ${PORT}`)); });

module.exports = app;
