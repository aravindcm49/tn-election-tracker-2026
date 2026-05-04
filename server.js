const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const cheerio = require('cheerio');

const PORT = 3456;
const DB_PATH = path.join(__dirname, 'elections.db');
const ECI_BASE = 'https://results.eci.gov.in/ResultAcGenMay2026/statewiseS22';
const ECI_PAGES = 12; // statewiseS221.htm through statewiseS2212.htm
const POLL_INTERVAL_MS = 120000; // 2 minutes — polite to ECI servers

// ─── Ensure DB exists ───
let db;
try {
  db = new DatabaseSync(DB_PATH);
} catch {
  fs.writeFileSync(DB_PATH, '');
  db = new DatabaseSync(DB_PATH);
}

// ─── Schema ───
db.exec(`
  CREATE TABLE IF NOT EXISTS constituencies (
    name TEXT PRIMARY KEY,
    const_no INTEGER,
    leading_candidate TEXT,
    leading_party TEXT,
    trailing_candidate TEXT,
    trailing_party TEXT,
    margin INTEGER,
    rounds_completed INTEGER,
    total_rounds INTEGER,
    status TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    leading_candidate TEXT,
    trailing_candidate TEXT,
    leading_party TEXT,
    trailing_party TEXT,
    margin INTEGER,
    rounds_completed INTEGER,
    total_rounds INTEGER,
    status TEXT,
    recorded_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_history_name ON history(name);
  CREATE INDEX IF NOT EXISTS idx_history_time ON history(recorded_at);
`);

const insertStmt = db.prepare(`
  INSERT INTO constituencies
    (name, const_no, leading_candidate, leading_party, trailing_candidate, trailing_party, margin, rounds_completed, total_rounds, status, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(name) DO UPDATE SET
    const_no = excluded.const_no,
    leading_candidate = excluded.leading_candidate,
    leading_party = excluded.leading_party,
    trailing_candidate = excluded.trailing_candidate,
    trailing_party = excluded.trailing_party,
    margin = excluded.margin,
    rounds_completed = excluded.rounds_completed,
    total_rounds = excluded.total_rounds,
    status = excluded.status,
    updated_at = excluded.updated_at
`);

const historyStmt = db.prepare(`
  INSERT INTO history (name, leading_candidate, trailing_candidate, leading_party, trailing_party, margin, rounds_completed, total_rounds, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ─── HTML Parser ───
function parseRows(html) {
  const rows = [];
  const $ = cheerio.load(html);

  // Find the main table (table-bordered distinguishes it from nested tooltip tables)
  let $mainTable = $('table.table.table-striped.table-bordered').first();
  if ($mainTable.length === 0) {
    console.log('WARN: main table not found, trying fallback selector');
    // Fallback: find table that contains the header "Constituency"
    $('table').each((i, el) => {
      if ($(el).find('th:contains("Constituency")').length > 0) {
        $mainTable = $(el);
        return false;
      }
    });
  }

  $mainTable.find('tbody > tr').each((i, tr) => {
    const $tds = $(tr).find('> td');
    if ($tds.length < 9) return;

    const name = $tds.eq(0).text().trim();
    const constNoText = $tds.eq(1).text().trim();
    const constNo = parseInt(constNoText, 10);
    if (isNaN(constNo)) return;

    const leadingCandidate = $tds.eq(2).text().trim();
    // Party cells contain nested tables; grab the first plain text td inside
    const leadingParty = $tds.eq(3).find('table td').first().text().trim();
    const trailingCandidate = $tds.eq(4).text().trim();
    const trailingParty = $tds.eq(5).find('table td').first().text().trim();
    const margin = parseInt($tds.eq(6).text().trim().replace(/,/g, ''), 10) || 0;
    const roundStr = $tds.eq(7).text().trim();
    const status = $tds.eq(8).text().trim();

    const [completed, total] = roundStr.split('/').map(s => parseInt(s.trim(), 10));

    rows.push({
      name, constNo, leadingCandidate, leadingParty,
      trailingCandidate, trailingParty, margin,
      roundsCompleted: completed || 0, totalRounds: total || 0, status
    });
  });

  return rows;
}

// ─── Fetch & Store ───
async function fetchPage(pageNum) {
  const url = `${ECI_BASE}${pageNum}.htm`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    return parseRows(html);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ERROR fetching page ${pageNum}:`, err.message);
    return [];
  }
}

async function fetchAndStore() {
  try {
    const allRows = [];
    for (let i = 1; i <= ECI_PAGES; i++) {
      const rows = await fetchPage(i);
      allRows.push(...rows);
      // Small delay between pages to be polite
      if (i < ECI_PAGES) await new Promise(r => setTimeout(r, 300));
    }

    if (allRows.length === 0) {
      console.log(`[${new Date().toISOString()}] WARN: no rows parsed`);
      return;
    }

    for (const r of allRows) {
      insertStmt.run(
        r.name, r.constNo, r.leadingCandidate, r.leadingParty,
        r.trailingCandidate, r.trailingParty, r.margin,
        r.roundsCompleted, r.totalRounds, r.status
      );
      historyStmt.run(
        r.name, r.leadingCandidate, r.trailingCandidate, r.leadingParty, r.trailingParty,
        r.margin, r.roundsCompleted, r.totalRounds, r.status
      );
    }

    console.log(`[${new Date().toISOString()}] Stored ${allRows.length} rows`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
  }
}

// ─── Win Estimate Helper ───
function winEstimate(row) {
  const rc = row.rounds_completed ?? row.roundsCompleted ?? 0;
  const tr = row.total_rounds ?? row.totalRounds ?? 1;
  const completion = tr > 0 ? rc / tr : 0;
  const m = row.margin || 0;

  if (row.status === 'Won' || row.status === 'Result Declared') {
    return { label: 'Declared', confidence: 100, color: '#052e16' };
  }
  if (completion >= 0.90 && m > 25000) return { label: 'Certain', confidence: 99, color: '#15803d' };
  if (completion >= 0.85 && m > 15000) return { label: 'Very Likely', confidence: 95, color: '#16a34a' };
  if (completion >= 0.75 && m > 10000) return { label: 'Likely', confidence: 88, color: '#65a30d' };
  if (completion >= 0.65 && m > 5000)  return { label: 'Leaning', confidence: 75, color: '#84cc16' };
  if (completion >= 0.55 && m > 2000)  return { label: 'Edge', confidence: 60, color: '#eab308' };
  if (completion < 0.40)               return { label: 'Early', confidence: 25, color: '#9ca3af' };
  if (m < 1000)                        return { label: 'Too Close', confidence: 45, color: '#ef4444' };
  return { label: 'Competitive', confidence: 50, color: '#3b82f6' };
}

// ─── NL → SQL Mapper ───
function nlToSql(query) {
  const q = query.toLowerCase();
  const params = [];
  let sql = '';

  // Exact-match parties (DMK/ADMK names overlap — LIKE would match both)
  const exactParties = [
    { keys: ['dmk'], name: 'Dravida Munnetra Kazhagam' },
    { keys: ['admk', 'aiadmk'], name: 'All India Anna Dravida Munnetra Kazhagam' },
    { keys: ['tvk', 'tamilaga vettri'], name: 'Tamilaga Vettri Kazhagam' },
  ];

  const likeParties = {
    'pmk': "%Pattali Makkal%",
    'inc': "%Indian National Congress%",
    'congress': "%Indian National Congress%",
    'bjp': "%Bharatiya Janata%",
    'cpi': "%Communist Party of India%",
    'cpi(m)': "%Communist Party of India (Marxist)%",
    'cpim': "%Communist Party of India (Marxist)%",
    'vck': "%Viduthalai Chiruthaigal%",
    'dmdk': "%Desiya Murpokku%",
    'iuml': "%Indian Union Muslim%",
    'ammk': "%Amma Makkal%",
  };

  let partyExact = null;
  // Sort keys longest-first so "admk" is checked before "dmk"
  const sortedExact = [...exactParties].sort((a, b) =>
    Math.max(...b.keys.map(k => k.length)) - Math.max(...a.keys.map(k => k.length))
  );
  for (const p of sortedExact) {
    if (p.keys.some(k => q.includes(k))) { partyExact = p.name; break; }
  }

  let partyLike = null;
  if (!partyExact) {
    for (const [key, val] of Object.entries(likeParties)) {
      if (q.includes(key)) { partyLike = val; break; }
    }
  }

  const isLeading = !q.includes('trailing') && !q.includes('losing');
  const partyCol = isLeading ? 'leading_party' : 'trailing_party';

  if (q.includes('party') && (q.includes('count') || q.includes('how many') || q.includes('seats') || q.includes('leading') || q.includes('summary'))) {
    sql = `SELECT leading_party as party, COUNT(*) as seats, SUM(margin) as total_margin,
             ROUND(AVG(CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) * 100),1) as avg_completion
           FROM constituencies GROUP BY leading_party ORDER BY seats DESC`;
  }
  else if (partyExact) {
    sql = `SELECT *, ROUND(CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) * 100,1) as completion_pct
           FROM constituencies WHERE ${partyCol} = ? ORDER BY margin DESC`;
    params.push(partyExact);
  }
  else if (partyLike) {
    sql = `SELECT *, ROUND(CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) * 100,1) as completion_pct
           FROM constituencies WHERE ${partyCol} LIKE ? ORDER BY margin DESC`;
    params.push(partyLike);
  }
  else if (q.includes('close') || q.includes('narrow') || q.includes('tight')) {
    sql = `SELECT *, ROUND(CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) * 100,1) as completion_pct
           FROM constituencies WHERE margin < 3000 ORDER BY margin ASC`;
  }
  else if (q.includes('safe') || q.includes('high margin') || q.includes('big lead')) {
    sql = `SELECT *, ROUND(CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) * 100,1) as completion_pct
           FROM constituencies WHERE margin > 20000 ORDER BY margin DESC`;
  }
  else if (q.includes('complete') || q.includes('finished') || q.includes('almost done') || q.includes('nearly')) {
    sql = `SELECT *, ROUND(CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) * 100,1) as completion_pct
           FROM constituencies WHERE CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) >= 0.85 ORDER BY completion_pct DESC`;
  }
  else if (q.includes('early') || q.includes('just started') || q.includes('beginning')) {
    sql = `SELECT *, ROUND(CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) * 100,1) as completion_pct
           FROM constituencies WHERE CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) <= 0.4 ORDER BY completion_pct ASC`;
  }
  else if (q.includes('history') || q.includes('trend') || q.includes('change') || q.includes('over time')) {
    sql = `SELECT name, margin, rounds_completed, total_rounds, recorded_at
           FROM history ORDER BY recorded_at DESC LIMIT 50`;
  }
  else {
    sql = `SELECT *, ROUND(CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) * 100,1) as completion_pct
           FROM constituencies ORDER BY margin DESC LIMIT 30`;
  }

  return { sql, params };
}

// ─── HTTP Server ───
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

function serveStatic(filePath, res) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API: all constituencies
  if (pathname === '/api/constituencies') {
    const rows = db.prepare(`
      SELECT *, ROUND(CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) * 100,1) as completion_pct
      FROM constituencies ORDER BY margin DESC
    `).all();
    const enriched = rows.map(r => ({ ...r, estimate: winEstimate(r) }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(enriched));
    return;
  }

  // API: party summary
  if (pathname === '/api/parties') {
    const rows = db.prepare(`
      SELECT leading_party as party, COUNT(*) as seats,
        ROUND(AVG(margin),0) as avg_margin,
        ROUND(AVG(CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) * 100),1) as avg_completion
      FROM constituencies GROUP BY leading_party ORDER BY seats DESC
    `).all();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }

  // API: history for one constituency
  if (pathname.startsWith('/api/history/')) {
    const name = decodeURIComponent(pathname.slice('/api/history/'.length));
    const rows = db.prepare(`
      SELECT * FROM history WHERE name = ? ORDER BY recorded_at DESC LIMIT 30
    `).all(name);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }

  // API: structured filter query
  if (pathname === '/api/filter' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const f = JSON.parse(body);
        const conditions = [];
        const params = [];

        if (f.party) {
          if (f.side === 'trailing') {
            conditions.push('trailing_party = ?');
            params.push(f.party);
          } else if (f.side === 'either') {
            conditions.push('(leading_party = ? OR trailing_party = ?)');
            params.push(f.party, f.party);
          } else {
            conditions.push('leading_party = ?');
            params.push(f.party);
          }
        }

        if (f.margin) {
          if (f.margin === 'close') conditions.push('margin < 3000');
          else if (f.margin === 'competitive') conditions.push('margin >= 3000 AND margin < 10000');
          else if (f.margin === 'comfortable') conditions.push('margin >= 10000 AND margin < 20000');
          else if (f.margin === 'safe') conditions.push('margin >= 20000');
        }

        if (f.progress) {
          if (f.progress === 'early') conditions.push('CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) < 0.4');
          else if (f.progress === 'mid') conditions.push('CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) >= 0.4 AND CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) < 0.7');
          else if (f.progress === 'nearly_done') conditions.push('CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) >= 0.7');
          else if (f.progress === 'declared') conditions.push("status = 'Result Declared'");
        }

        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const sql = `SELECT *, ROUND(CAST(rounds_completed AS REAL) / NULLIF(total_rounds,0) * 100,1) as completion_pct FROM constituencies ${where} ORDER BY margin DESC`;
        const rows = db.prepare(sql).all(...params);
        const enriched = rows.map(r => ({ ...r, estimate: winEstimate(r) }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sql, count: enriched.length, rows: enriched }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: natural language query
  if (pathname === '/api/query' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { query } = JSON.parse(body);
        const { sql, params } = nlToSql(query || '');
        const rows = db.prepare(sql).all(...params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sql, count: rows.length, rows }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Static files
  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(path.join(__dirname, 'public', 'index.html'), res);
    return;
  }
  const staticPath = path.join(__dirname, 'public', pathname);
  if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    serveStatic(staticPath, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ─── Start ───
fetchAndStore();
setInterval(fetchAndStore, POLL_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`TN Election Tracker running at http://localhost:${PORT}`);
});
