// Daily update of the Trade-it report site (daily.json) straight from BO data.
// Runs on GitHub Actions (see .github/workflows/daily-update.yml), so it does not need any computer.
//
// Same rules as the BO screen "רכבים":
//   rep = "נוצר על ידי" (users.fullName || displayName), branch = "סניף" (branches.branchName),
//   day = "נוצר" (createdAt, Israel time), closed = 1 unless the sale status is active / inactive /
//   phase 2 active / fast path / deal not closed.
// Only branch cars (ALLOWED). Never "הנהלה". A car whose branch is an unknown internal id gets the
// rep's usual branch. Every day in the last WINDOW days whose cars differ from what the site shows
// is replaced in daily.json (days + rows). data.json is never touched.
//
// env: BO_EMAIL, BO_PASSWORD (repo secrets), FORCE=true to skip the time-of-day guard.

import { readFileSync, writeFileSync } from 'node:fs';

const API_KEY = 'AIzaSyAi9czXc4VFqC10-BgEbPiHcPzjvBPWAfk'; // public web key of the TradeIT Firebase project
const BASE = 'https://firestore.googleapis.com/v1/projects/tradehit-aee72/databases/(default)/documents';
const WINDOW = 30;
const RUN_FROM_HOUR = 19; // Israel time
const ALLOWED = ['רעננה', 'הרצליה', 'חיפה', 'נתניה', 'ראשון לציון', 'תל אביב', 'חולון', 'ירושלים', 'פתח תקווה', 'באר שבע', 'טבריה', 'מודיעין', 'חדרה', 'עכו'];

// BO sale-status labels (from the BO app) and the user's "open" rule applied to the label
const STATUS = { active: 'פעיל', phase2_active: 'שלב 2 - מכירה פעילה', waiting_for_test_file: 'ממתין לקובץ בדיקה', auction_closed: 'מכירה נסגרה', quality_check: 'בדיקת איכות', trader_selected: 'זוכה אושר', contract_requested: 'נדרש הסכם', purchased: 'נרכש', paid: 'שולם', delivered: 'הועבר', sold: 'נמכר', failed: 'נכשל', inactive: 'לא פעיל', pending: 'בהמתנה', draft: 'טיוטה', deal_not_closed: 'עסקה לא נסגרה' };
const statusLabel = s => (s ? STATUS[s] ?? s.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim() : '—');
const OPEN = s => /פעיל|active|fast|phase|לא נסגר/i.test(s || '');
const isId = b => /^[A-Za-z0-9]{15,}$/.test(b || '');
const clean = s => String(s ?? '').trim().replace(/\s+/g, ' ');

const ilDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const ilParts = d => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));

const val = f => (f ? f.stringValue ?? f.integerValue ?? f.doubleValue ?? f.timestampValue ?? f.booleanValue ?? null : null);

async function signIn(email, password) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('bo_sign_in_failed: ' + (j.error?.message || r.status));
  return j.idToken;
}

export async function fetchBoRows(token, fromDay) {
  const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const list = async (col, fields) => {
    const out = new Map(); let tok = '';
    do {
      const q = new URLSearchParams({ pageSize: '300' }); fields.forEach(f => q.append('mask.fieldPaths', f)); if (tok) q.set('pageToken', tok);
      const r = await fetch(`${BASE}/${col}?${q}`, { headers: H }); const j = await r.json();
      if (!r.ok) throw new Error(`bo_read_${col}_failed: ${j.error?.message || r.status}`);
      for (const d of j.documents || []) out.set(d.name.split('/').pop(), Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, val(v)])));
      tok = j.nextPageToken || '';
    } while (tok);
    return out;
  };
  const users = await list('users', ['fullName', 'displayName']);
  const branches = await list('branches', ['branchName']);
  const repName = id => { const u = users.get(id); return u ? (u.fullName || u.displayName || id) : id; };
  const branchName = id => branches.get(id)?.branchName ?? id;

  const since = new Date(new Date(fromDay + 'T00:00:00Z').getTime() - 86400000).toISOString(); // a day of slack; filtered by Israel day below
  const r = await fetch(`${BASE}:runQuery`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'cars' }],
      select: { fields: ['carNumber', 'auctionStatus', 'createdBy', 'createdByBranchId', 'createdAt'].map(fieldPath => ({ fieldPath })) },
      where: { fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: since } } },
      orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
    } }),
  });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j)) throw new Error('bo_read_cars_failed: ' + (j.error?.message || j[0]?.error?.message || r.status));
  return j.filter(x => x.document).map(x => {
    const f = Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, val(v)]));
    return {
      plate: clean(f.carNumber ?? x.document.name.split('/').pop()),
      day: f.createdAt ? ilDay(new Date(f.createdAt)) : null,
      rep: clean(f.createdBy ? repName(f.createdBy) : '—'),
      branch: clean(f.createdByBranchId ? branchName(f.createdByBranchId) : '—'),
      status: statusLabel(f.auctionStatus),
    };
  });
}

// all = BO rows; base = data.json; daily = daily.json. Returns the new daily.json object + a report.
export function computeUpdate(all, base, daily, now = new Date()) {
  const TODAY = ilDay(now), FROM = ilDay(new Date(now.getTime() - WINDOW * 86400000));
  const dr = daily.rows || []; const rep = new Set((daily.days || []).concat(dr.map(r => r[0])));
  const eff = (base.rows || []).filter(r => !rep.has(r[0])).concat(dr).filter(r => ALLOWED.includes(r[2]));
  const home = {};
  eff.concat(all.filter(r => !isId(r.branch)).map(r => [r.day, r.rep, r.branch])).forEach(r => { (home[r[1]] = home[r[1]] || {}); home[r[1]][r[2]] = (home[r[1]][r[2]] || 0) + 1; });
  const homeOf = p => { const o = home[p] || {}; return Object.keys(o).sort((a, b) => o[b] - o[a])[0] || null; };
  const fixed = [];
  const bo = all.filter(r => r.day && r.day >= FROM && r.day <= TODAY).map(r => {
    let b = r.branch; if (isId(b)) { b = homeOf(r.rep); fixed.push(r.plate + ':' + r.rep + '->' + b); }
    return [r.day, r.rep, b, OPEN(r.status) ? 0 : 1];
  }).filter(r => ALLOWED.includes(r[2]));
  const key = a => a.map(r => r[1] + '|' + r[2] + '|' + r[3]).sort().join(';');
  const changed = [];
  for (let t = new Date(FROM + 'T12:00:00Z'); ilDay(t) <= TODAY; t = new Date(t.getTime() + 86400000)) {
    const d = ilDay(t);
    if (key(bo.filter(r => r[0] === d)) !== key(eff.filter(r => r[0] === d))) changed.push(d);
  }
  const C = new Set(changed);
  const add = bo.filter(r => C.has(r[0])).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[3] - b[3]);
  const p = ilParts(now);
  const updated = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  const rows = dr.filter(r => !C.has(r[0])).concat(add).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const days = [...new Set((daily.days || []).concat(changed))].sort();
  const detail = changed.map(d => { const e = eff.filter(r => r[0] === d), b = bo.filter(r => r[0] === d); return `${d}: ${e.length}/${e.reduce((a, r) => a + Number(r[3]), 0)} -> ${b.length}/${b.reduce((a, r) => a + r[3], 0)}`; });
  return { next: { updated, days, rows }, report: { TODAY, FROM, loaded: all.length, inWindow: bo.length, closedInWindow: bo.reduce((a, r) => a + r[3], 0), changedDays: changed.length, detail, fixed } };
}

async function main() {
  const now = new Date();
  const daily = JSON.parse(readFileSync('daily.json', 'utf8'));
  const p = ilParts(now);
  if (process.env.FORCE !== 'true') {
    // two schedules (summer/winter time); run once a day from 19:00 Israel time
    if (+p.hour < RUN_FROM_HOUR) { console.log(`skip: ${p.hour}:${p.minute} Israel time is before ${RUN_FROM_HOUR}:00`); return; }
    const today = `${p.year}-${p.month}-${p.day}`;
    if (String(daily.updated || '') >= `${today}T${String(RUN_FROM_HOUR).padStart(2, '0')}:00`) { console.log('skip: already updated this evening (' + daily.updated + ')'); return; }
  }
  if (!process.env.BO_EMAIL || !process.env.BO_PASSWORD) {
    if (process.env.FORCE === 'true') throw new Error('missing BO_EMAIL / BO_PASSWORD repository secrets');
    console.log('::warning::BO_EMAIL / BO_PASSWORD repository secrets are not set yet - skipped'); return;
  }
  const token = await signIn(process.env.BO_EMAIL, process.env.BO_PASSWORD);
  const base = JSON.parse(readFileSync('data.json', 'utf8'));
  const from = ilDay(new Date(now.getTime() - WINDOW * 86400000));
  const all = await fetchBoRows(token, from);
  if (!all.length) throw new Error('bo_returned_no_cars');
  const { next, report } = computeUpdate(all, base, daily, now);
  writeFileSync('daily.json', JSON.stringify(next, null, 1) + '\n');
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `updated=${next.updated}\n`, { flag: 'a' });
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.message || e); process.exit(1); });
