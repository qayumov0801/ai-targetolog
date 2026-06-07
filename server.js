// server.js — AI Targetolog Backend (bitta faylga jamlangan — Render/Railway uchun)
// Hosting: Render (root dir = repo, build = npm install, start = node server.js)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

// =====================================================================
// DATABASE (SQLite)
// =====================================================================
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, email TEXT UNIQUE, phone TEXT UNIQUE,
    password_hash TEXT, google_id TEXT UNIQUE, avatar TEXT,
    fb_acc_id TEXT, bm_id TEXT, page_name TEXT, role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_login DATETIME
  );
  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, contact TEXT NOT NULL, code TEXT NOT NULL,
    expires_at DATETIME NOT NULL, used INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
    nisha TEXT, budget REAL, geo TEXT, goal TEXT, offer TEXT, conversion REAL DEFAULT 4,
    status TEXT DEFAULT 'active', fb_campaign_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    report_date DATE NOT NULL, spend REAL DEFAULT 0, reach INTEGER DEFAULT 0,
    impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, ctr REAL DEFAULT 0, cpc REAL DEFAULT 0,
    leads INTEGER DEFAULT 0, cpl REAL DEFAULT 0, sales INTEGER DEFAULT 0, roas REAL DEFAULT 0,
    ai_comment TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id), FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);
function ensureColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
ensureColumn('daily_reports', 'impressions', 'INTEGER DEFAULT 0');
ensureColumn('daily_reports', 'ctr', 'REAL DEFAULT 0');

// =====================================================================
// AUTH HELPERS
// =====================================================================
const JWT_SECRET = process.env.JWT_SECRET || 'ai-targetolog-secret-2024';
function signToken(userId) { return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' }); }
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Token kerak' });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    const user = db.prepare('SELECT id, name, email, phone, role, fb_acc_id, bm_id, page_name FROM users WHERE id = ?').get(payload.userId);
    if (!user) return res.status(401).json({ error: 'Foydalanuvchi topilmadi' });
    req.user = user; next();
  } catch (e) { return res.status(401).json({ error: 'Token yaroqsiz' }); }
}

// =====================================================================
// ESKIZ SMS (ixtiyoriy)
// =====================================================================
let eskizToken = process.env.ESKIZ_TOKEN || '';
async function getEskizToken() {
  if (eskizToken) return eskizToken;
  const email = process.env.ESKIZ_EMAIL, password = process.env.ESKIZ_PASSWORD;
  if (!email || !password) return '';
  try {
    const r = await fetch('https://notify.eskiz.uz/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const d = await r.json(); eskizToken = d?.data?.token || ''; return eskizToken;
  } catch (e) { console.error('[eskiz] token xato:', e.message); return ''; }
}
async function sendOTP(contact, code) {
  const message = `AI Targetolog tasdiqlash kodi: ${code}`;
  let token = await getEskizToken();
  if (!token) { console.log(`\n📱 OTP [${contact}]: ${code}  (konsol rejimi)\n`); return; }
  const trySend = (tkn) => fetch('https://notify.eskiz.uz/api/message/sms/send', { method: 'POST', headers: { Authorization: `Bearer ${tkn}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile_phone: contact, message, from: process.env.ESKIZ_FROM || '4546' }) });
  try {
    let r = await trySend(token);
    if (r.status === 401 && process.env.ESKIZ_EMAIL && process.env.ESKIZ_PASSWORD) { eskizToken = ''; token = await getEskizToken(); if (token) r = await trySend(token); }
    if (!r.ok) console.log(`\n📱 OTP [${contact}]: ${code} (fallback)\n`); else console.log('[eskiz] OTP yuborildi');
  } catch (e) { console.log(`\n📱 OTP [${contact}]: ${code} (fallback)\n`); }
}

// =====================================================================
// AI (LLM) — Anthropic / OpenAI, kalitsiz bo'lsa shablon
// =====================================================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SYSTEM_PROMPT = `Siz — "Energiya AI Targetolog", Meta Ads (Instagram/Facebook) bo'yicha tajribali targetologsiz.
Ish tilingiz — o'zbek (lotin). Linzalar: Hormozi (Offer/Value Equation), Suby (auditoriya harorati),
Brunson (funnel/Value Ladder), DeMarco (CENTS), Isaev (lokal tayyorlik), Kern (offer 7P), Edwards (copy/WHY).
Aniq raqamlar va formulalar; O'zbekiston/MDH lokal bozori; test→o'lchov→masshtab; qisqa va tarkibli.
KPI yashil zonalari: CTR>1.5%, CPC<$1.5, CPM<$3, Frequency<2.5. Meta policy: tibbiy va'da/kafolat/shaxsiy xususiyat yo'q.
Javob oxirida "Keyingi qadam" punkti bo'lsin.`;
function activeProvider() { if (ANTHROPIC_API_KEY) return 'anthropic'; if (OPENAI_API_KEY) return 'openai'; return null; }
async function callAnthropic(p, mt = 1200) {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: mt, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: p }] }) });
  if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json(); return (d.content || []).map((c) => c.text).join('').trim();
}
async function callOpenAI(p, mt = 1200) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify({ model: OPENAI_MODEL, max_tokens: mt, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: p }] }) });
  if (!r.ok) throw new Error('OpenAI ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json(); return (d.choices?.[0]?.message?.content || '').trim();
}
async function runLLM(p, mt) {
  const prov = activeProvider();
  if (prov === 'anthropic') return { text: await callAnthropic(p, mt), provider: prov };
  if (prov === 'openai') return { text: await callOpenAI(p, mt), provider: prov };
  return { text: null, provider: null };
}
function analysisPrompt(d) {
  return `Yangi loyiha uchun qisqa strategik tahlil ber.
Biznes: ${d.bizName || '—'} | Nisha: ${d.nisha || '—'} | Offer: ${d.offer || '—'} | Budjet: $${d.budget || '—'}/oy
Geo: ${d.geo || '—'} | Maqsad: ${d.goal || '—'} | Konversiya: ${d.conversion || '—'}% | Og'riq: ${d.pain || '—'} | Orzu: ${d.dream || '—'}
Tuzilish: 1) Offer auditi (Hormozi) 2) 2 segment avatar 3) 3 kreativ hook 4) Test budjeti va struktura 5) KPI maqsadlari 6) Keyingi qadam. Qisqa, aniq raqamlar bilan, o'zbekcha.`;
}
function optimizePrompt(d, reports) {
  const rows = (reports || []).map(r => `  ${r.report_date}: spend $${r.spend}, CTR ${r.ctr}%, CPC $${r.cpc}, leads ${r.leads}, CPL $${r.cpl}`).join('\n');
  return `Ishlab turgan kampaniya optimizatsiyasi. Loyiha: ${d.bizName || '—'} | ${d.nisha || '—'} | $${d.budget || '—'} | ${d.geo || '—'}.
Hisobotlar:\n${rows || '  (yo\'q)'}\nO'zbekcha qisqa: 1) Diagnoz 2) 3 amal (ustuvorlik) 3) Scale/to'xtatish qarori 4) Keyingi qadam. Aniq mezon bilan.`;
}
function templateAnalysis(d) {
  const budget = Number(d.budget) || 100, daily = (budget / 30).toFixed(1), conv = Number(d.conversion) || 4;
  const cr = budget < 300 ? 3 : budget < 700 ? 6 : 10, tsh = (d.geo || '').toLowerCase().includes('tosh');
  return `**Offer auditi (Hormozi):** "${d.offer || d.nisha || 'mahsulot'}" — Value Equation: orzu natija aniqmi, kafolat/keys bormi, vaqt va kuch kammi? Kafolat va ijtimoiy isbot qo'shing.

**Auditoriya (Suby):** Byudjetning 60–70% sovuqqa. 2 segment:
• A: asosiy og'riq egasi (${d.pain || "og'riq"}) — keng interes + ${d.geo || 'Toshkent'}.
• B: broad (geo+yosh+jins) — algoritm o'zi topadi.

**3 kreativ hook:**
1. "${d.pain || 'Shu muammo'} sizda ham bormi?" (Curiosity)
2. Aniq raqam + vaqt (Demonstration)
3. Mijoz guvohligi UGC (Before-After)

**Budjet (test, 1-hafta):** kunlik ~$${daily}, ABO, 2–3 adset, har birida ${cr >= 6 ? 3 : cr} kreativ, optimizatsiya: Lead.

**KPI:** CTR>1.5%, CPC<$1.5, CPL ${tsh ? '$2–5' : '$3–8'}, Frequency<2.5. Konversiya ${conv}% past bo'lsa — landing/skript muammosi.

**Keyingi qadam:** 2 segment × 3 kreativ test kampaniyasini yoqing, 7 kun kuzating.

_(ℹ️ Shablon tahlil. Real AI uchun serverga ANTHROPIC_API_KEY yoki OPENAI_API_KEY qo'shing.)_`;
}
function templateOptimize(d, reports) {
  const last = (reports || [])[0]; let diag = 'Ma\'lumot yetarli emas — algoritmga 7 kun (≈50 konversiya) bering.';
  if (last) { const ctr = +last.ctr || 0, cpl = +last.cpl || 0; if (ctr && ctr < 0.8) diag = `CTR past (${ctr}%) — hook/kreativ muammosi.`; else if (cpl) diag = `CPL $${cpl} — landing va offerni tekshiring, yaxshilarni masshtablang.`; }
  return `**Diagnoz:** ${diag}

**3 amal:** 1) Yutqazgan kreativni o'chiring (CTR<0.8% yoki CPL 1.5× yuqori). 2) Yutgan budjetini har 2 kunda 20% oshiring. 3) Eng yaxshi adsetdan 1% Lookalike.

**Scale:** CPL maqsadda/past — masshtab; Frequency>2.5 — yangi kreativ (fatigue).

**Keyingi qadam:** 2 kundan keyin CTR/CPL qayta ko'rib chiqing.

_(ℹ️ Shablon tavsiya. Real AI uchun API kalit qo'shing.)_`;
}

// =====================================================================
// HISOBOT METRIKALARI
// =====================================================================
function deriveMetrics(b) {
  const spend = +b.spend || 0, reach = +b.reach || 0, impressions = +b.impressions || 0, clicks = +b.clicks || 0, leads = +b.leads || 0, sales = +b.sales || 0;
  const base = impressions > 0 ? impressions : reach;
  const ctr = base > 0 ? +((clicks / base) * 100).toFixed(2) : 0;
  const cpc = clicks > 0 ? +(spend / clicks).toFixed(2) : 0;
  const cpl = leads > 0 ? +(spend / leads).toFixed(2) : 0;
  return { spend, reach, impressions, clicks, leads, sales, ctr, cpc, cpl };
}
function aiComment({ cpl, cpaTarget, ctr, leads }) {
  if (!cpl || !leads) return 'ℹ️ Ma\'lumot yetarli emas.';
  const ratio = cpl / (cpaTarget || 10); let m;
  if (ratio < 0.8) m = '🟢 CPL past — scale.'; else if (ratio < 1.0) m = '✅ CPL maqsadda.';
  else if (ratio < 1.5) m = '🟡 CPL biroz yuqori.'; else m = '🔴 CPL yuqori — fatigue.';
  if (ctr > 0) { if (ctr < 0.8) m += ' CTR past.'; else if (ctr > 1.5) m += ' CTR kuchli.'; }
  return m;
}

// =====================================================================
// APP
// =====================================================================
const app = express();
const PORT = process.env.PORT || 3001;
app.set('trust proxy', 1); // Render/hosting proxy ortida — rate-limit X-Forwarded-For uchun
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: 'Ko\'p so\'rov.' } }));
app.use('/api/auth/', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Juda ko\'p urinish.' } }));

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0', llm: !!activeProvider(), time: new Date().toISOString() }));

// ---------- AUTH ----------
const auth = express.Router();
const genOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
auth.post('/google', (req, res) => {
  const { googleId, name, email, avatar } = req.body;
  if (!googleId || !email) return res.status(400).json({ error: "Google ma'lumotlari yetarli emas" });
  try {
    let u = db.prepare('SELECT * FROM users WHERE google_id = ? OR email = ?').get(googleId, email);
    if (!u) { const r = db.prepare('INSERT INTO users (name, email, google_id, avatar) VALUES (?,?,?,?)').run(name, email, googleId, avatar || null); u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid); }
    else db.prepare('UPDATE users SET google_id=?, name=?, avatar=?, last_login=CURRENT_TIMESTAMP WHERE id=?').run(googleId, name, avatar || u.avatar, u.id);
    res.json({ token: signToken(u.id), user: { id: u.id, name: u.name, email: u.email, avatar: u.avatar } });
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});
auth.post('/send-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length < 9) return res.status(400).json({ error: "To'g'ri telefon raqam kiriting" });
  const cp = phone.replace(/\D/g, ''), code = genOTP(), exp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare('UPDATE otp_codes SET used=1 WHERE contact=? AND used=0').run(cp);
  db.prepare('INSERT INTO otp_codes (contact, code, expires_at) VALUES (?,?,?)').run(cp, code, exp);
  sendOTP(cp, code);
  res.json({ success: true, message: 'OTP yuborildi', debug_code: process.env.NODE_ENV !== 'production' ? code : undefined });
});
auth.post('/verify-otp', (req, res) => {
  const { phone, code, name } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Telefon va OTP kerak' });
  const cp = phone.replace(/\D/g, '');
  const o = db.prepare("SELECT * FROM otp_codes WHERE contact=? AND code=? AND used=0 AND expires_at>datetime('now') ORDER BY id DESC LIMIT 1").get(cp, code);
  if (!o) return res.status(400).json({ error: "OTP noto'g'ri yoki muddati o'tgan" });
  db.prepare('UPDATE otp_codes SET used=1 WHERE id=?').run(o.id);
  try {
    let u = db.prepare('SELECT * FROM users WHERE phone=?').get(cp);
    if (!u) { const r = db.prepare('INSERT INTO users (name, phone) VALUES (?,?)').run(name || 'Foydalanuvchi', cp); u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid); }
    else db.prepare('UPDATE users SET last_login=CURRENT_TIMESTAMP WHERE id=?').run(u.id);
    res.json({ token: signToken(u.id), user: { id: u.id, name: u.name, phone: u.phone } });
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});
auth.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Ism, email va parol kerak' });
  if (password.length < 6) return res.status(400).json({ error: 'Parol kamida 6 ta belgi' });
  try {
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return res.status(400).json({ error: 'Bu email allaqachon ro\'yxatdan o\'tgan' });
    const hash = await bcrypt.hash(password, 10);
    const r = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?,?,?)').run(name, email, hash);
    const u = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(r.lastInsertRowid);
    res.json({ token: signToken(u.id), user: u });
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});
auth.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email va parol kerak' });
  try {
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u || !u.password_hash) return res.status(401).json({ error: "Email yoki parol noto'g'ri" });
    if (!(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: "Email yoki parol noto'g'ri" });
    db.prepare('UPDATE users SET last_login=CURRENT_TIMESTAMP WHERE id=?').run(u.id);
    res.json({ token: signToken(u.id), user: { id: u.id, name: u.name, email: u.email } });
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});
auth.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));
auth.patch('/update-fb', requireAuth, (req, res) => {
  const { fb_acc_id, bm_id, page_name } = req.body;
  db.prepare('UPDATE users SET fb_acc_id=?, bm_id=?, page_name=? WHERE id=?').run(fb_acc_id || null, bm_id || null, page_name || null, req.user.id);
  res.json({ success: true });
});
app.use('/api/auth', auth);

// ---------- CAMPAIGNS ----------
const camp = express.Router(); camp.use(requireAuth);
camp.get('/', (req, res) => res.json({ campaigns: db.prepare('SELECT * FROM campaigns WHERE user_id=? ORDER BY created_at DESC').all(req.user.id) }));
camp.post('/', (req, res) => {
  const { name, nisha, budget, geo, goal, offer, conversion } = req.body;
  if (!name || !nisha || !budget) return res.status(400).json({ error: 'Ism, nisha va budjet kerak' });
  const r = db.prepare('INSERT INTO campaigns (user_id, name, nisha, budget, geo, goal, offer, conversion) VALUES (?,?,?,?,?,?,?,?)').run(req.user.id, name, nisha, budget, geo || 'Toshkent', goal || "Lead yig'ish", offer || '', conversion || 4);
  res.json({ campaign: db.prepare('SELECT * FROM campaigns WHERE id=?').get(r.lastInsertRowid) });
});
camp.get('/:id', (req, res) => { const c = db.prepare('SELECT * FROM campaigns WHERE id=? AND user_id=?').get(req.params.id, req.user.id); if (!c) return res.status(404).json({ error: 'Topilmadi' }); res.json({ campaign: c }); });
camp.put('/:id', (req, res) => {
  const { name, nisha, budget, geo, goal, offer, conversion, status, fb_campaign_id } = req.body;
  const c = db.prepare('SELECT id FROM campaigns WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'Topilmadi' });
  db.prepare(`UPDATE campaigns SET name=COALESCE(?,name), nisha=COALESCE(?,nisha), budget=COALESCE(?,budget), geo=COALESCE(?,geo), goal=COALESCE(?,goal), offer=COALESCE(?,offer), conversion=COALESCE(?,conversion), status=COALESCE(?,status), fb_campaign_id=COALESCE(?,fb_campaign_id), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(name ?? null, nisha ?? null, budget ?? null, geo ?? null, goal ?? null, offer ?? null, conversion ?? null, status ?? null, fb_campaign_id ?? null, req.params.id);
  res.json({ success: true });
});
camp.delete('/:id', (req, res) => { db.prepare('DELETE FROM campaigns WHERE id=? AND user_id=?').run(req.params.id, req.user.id); res.json({ success: true }); });
app.use('/api/campaigns', camp);

// ---------- REPORTS ----------
const rep = express.Router(); rep.use(requireAuth);
rep.get('/', (req, res) => {
  const { campaign_id, limit = 30 } = req.query;
  let q = 'SELECT * FROM daily_reports WHERE user_id=?'; const p = [req.user.id];
  if (campaign_id) { q += ' AND campaign_id=?'; p.push(campaign_id); }
  q += ' ORDER BY report_date DESC LIMIT ?'; p.push(parseInt(limit));
  res.json({ reports: db.prepare(q).all(...p) });
});
rep.post('/', (req, res) => {
  const { campaign_id, report_date, roas } = req.body;
  if (!campaign_id || !report_date) return res.status(400).json({ error: 'campaign_id va report_date kerak' });
  const c = db.prepare('SELECT * FROM campaigns WHERE id=? AND user_id=?').get(campaign_id, req.user.id);
  if (!c) return res.status(403).json({ error: 'Ruxsat yo\'q' });
  const m = deriveMetrics(req.body), roasVal = +roas || 0;
  const daily = (c.budget || 0) / 30, exp = Math.max(1, Math.round((daily / 1.8) * 1000 * 1.5 / 100));
  const cpaTarget = daily > 0 ? +(daily / exp).toFixed(2) : 10;
  const ac = aiComment({ cpl: m.cpl, cpaTarget, ctr: m.ctr, leads: m.leads });
  const ex = db.prepare('SELECT id FROM daily_reports WHERE campaign_id=? AND report_date=?').get(campaign_id, report_date);
  if (ex) db.prepare('UPDATE daily_reports SET spend=?, reach=?, impressions=?, clicks=?, ctr=?, cpc=?, leads=?, cpl=?, sales=?, roas=?, ai_comment=? WHERE id=?').run(m.spend, m.reach, m.impressions, m.clicks, m.ctr, m.cpc, m.leads, m.cpl, m.sales, roasVal, ac, ex.id);
  else db.prepare('INSERT INTO daily_reports (campaign_id, user_id, report_date, spend, reach, impressions, clicks, ctr, cpc, leads, cpl, sales, roas, ai_comment) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(campaign_id, req.user.id, report_date, m.spend, m.reach, m.impressions, m.clicks, m.ctr, m.cpc, m.leads, m.cpl, m.sales, roasVal, ac);
  res.json({ success: true, ai_comment: ac, metrics: { ...m, roas: roasVal, cpaTarget } });
});
rep.get('/summary/:campaign_id', (req, res) => {
  const c = db.prepare('SELECT * FROM campaigns WHERE id=? AND user_id=?').get(req.params.campaign_id, req.user.id);
  if (!c) return res.status(404).json({ error: 'Topilmadi' });
  const s = db.prepare(`SELECT COUNT(*) as days, COALESCE(SUM(spend),0) total_spend, COALESCE(SUM(reach),0) total_reach, COALESCE(SUM(clicks),0) total_clicks, COALESCE(SUM(leads),0) total_leads, COALESCE(SUM(sales),0) total_sales, COALESCE(AVG(cpl),0) avg_cpl, COALESCE(AVG(cpc),0) avg_cpc, COALESCE(AVG(ctr),0) avg_ctr, COALESCE(MAX(leads),0) best_leads_day FROM daily_reports WHERE campaign_id=?`).get(req.params.campaign_id);
  res.json({ summary: s, campaign: c });
});
rep.delete('/:id', (req, res) => { db.prepare('DELETE FROM daily_reports WHERE id=? AND user_id=?').run(req.params.id, req.user.id); res.json({ success: true }); });
app.use('/api/reports', rep);

// ---------- AI ----------
const ai = express.Router();
ai.get('/status', (req, res) => res.json({ provider: activeProvider(), llm: !!activeProvider() }));
ai.post('/analyze', async (req, res) => {
  const d = req.body || {};
  if (!d.nisha && !d.offer) return res.status(400).json({ error: 'nisha yoki offer kerak' });
  try { const { text, provider } = await runLLM(analysisPrompt(d), 1300); if (text) return res.json({ source: provider, text }); return res.json({ source: 'template', text: templateAnalysis(d) }); }
  catch (e) { console.error('[ai/analyze]', e.message); return res.json({ source: 'template', text: templateAnalysis(d), warning: 'LLM xatosi' }); }
});
ai.post('/optimize', async (req, res) => {
  const { biz = {}, reports = [] } = req.body || {};
  try { const { text, provider } = await runLLM(optimizePrompt(biz, reports), 1100); if (text) return res.json({ source: provider, text }); return res.json({ source: 'template', text: templateOptimize(biz, reports) }); }
  catch (e) { console.error('[ai/optimize]', e.message); return res.json({ source: 'template', text: templateOptimize(biz, reports), warning: 'LLM xatosi' }); }
});
ai.post('/chat', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message kerak' });
  try { const { text, provider } = await runLLM(message, 1000); if (text) return res.json({ source: provider, text }); return res.json({ source: 'template', text: 'ℹ️ Real AI uchun API kalit qo\'shing.' }); }
  catch (e) { res.status(500).json({ error: 'AI xatosi' }); }
});
app.use('/api/ai', ai);

app.get('/', (req, res) => res.json({ service: 'AI Targetolog Backend', health: '/api/health' }));
app.use((err, req, res, next) => { console.error(err.stack); res.status(500).json({ error: 'Ichki server xatosi' }); });
app.listen(PORT, () => console.log(`AI Targetolog Backend running on port ${PORT} (mode: ${process.env.NODE_ENV || 'development'}, llm: ${activeProvider() || 'template'})`));
module.exports = app;
