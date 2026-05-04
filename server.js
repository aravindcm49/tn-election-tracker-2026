const http = require('http');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 3456;
const ECI_BASE = 'https://results.eci.gov.in/ResultAcGenMay2026/statewiseS22';
const ECI_PAGES = 12;
const POLL_INTERVAL_MS = 120000;

// ─── In-Memory Store ───
const constituencies = new Map();
const history = [];
const MAX_HISTORY = 5000;
let isFetching = false;

async function ensureData() {
  if (constituencies.size === 0 && !isFetching) {
    isFetching = true;
    await fetchAndStore();
    isFetching = false;
  }
}

// ─── HTML Parser ───
function parseRows(html) {
  const rows = [];
  const $ = cheerio.load(html);
  let $mainTable = $('table.table.table-striped.table-bordered').first();

  if ($mainTable.length === 0) {
    $('table').each((i, el) => {
      if ($(el).find('th:contains("Constituency")').length > 0) {
        $mainTable = $(el);
        return false;
      }
    });
  }

  $mainTable.children('tbody').children('tr').each((i, tr) => {
    const $tds = $(tr).find('> td');
    if ($tds.length < 9) return;

    const name = $tds.eq(0).text().trim();
    const constNo = parseInt($tds.eq(1).text().trim(), 10);
    if (isNaN(constNo)) return;

    const leadingCandidate = $tds.eq(2).text().trim();
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

// ─── Win Estimate ───
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

// ─── Fetch & Store ───
async function fetchPage(pageNum, retries = 2) {
  const url = `${ECI_BASE}${pageNum}.htm`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const rows = parseRows(html);
      if (rows.length > 0) return rows;
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR fetching page ${pageNum} (attempt ${attempt + 1}):`, err.message);
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return [];
}

async function fetchAndStore() {
  try {
    const allRows = [];
    for (let i = 1; i <= ECI_PAGES; i++) {
      const rows = await fetchPage(i);
      allRows.push(...rows);
      if (i < ECI_PAGES) await new Promise(r => setTimeout(r, 300));
    }

    if (allRows.length === 0) {
      console.log(`[${new Date().toISOString()}] WARN: no rows parsed`);
      return;
    }

    for (const r of allRows) {
      const now = new Date().toISOString();
      constituencies.set(r.name, {
        name: r.name,
        const_no: r.constNo,
        leading_candidate: r.leadingCandidate,
        leading_party: r.leadingParty,
        trailing_candidate: r.trailingCandidate,
        trailing_party: r.trailingParty,
        margin: r.margin,
        rounds_completed: r.roundsCompleted,
        total_rounds: r.totalRounds,
        status: r.status,
        updated_at: now
      });
      history.push({
        name: r.name,
        leading_candidate: r.leadingCandidate,
        trailing_candidate: r.trailingCandidate,
        leading_party: r.leadingParty,
        trailing_party: r.trailingParty,
        margin: r.margin,
        rounds_completed: r.roundsCompleted,
        total_rounds: r.totalRounds,
        status: r.status,
        recorded_at: now
      });
    }

    while (history.length > MAX_HISTORY) history.shift();

    console.log(`[${new Date().toISOString()}] Stored ${allRows.length} rows`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
  }
}

// ─── NL → SQL Mapper (kept for legacy /api/query) ───
function nlToSql(query) {
  const q = query.toLowerCase();
  const params = [];
  let sql = '';

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

// ─── In-Memory Filter Engine ───
function filterConstituencies(f) {
  let rows = Array.from(constituencies.values());

  if (f.party) {
    if (f.side === 'trailing') {
      rows = rows.filter(r => r.trailing_party === f.party);
    } else if (f.side === 'either') {
      rows = rows.filter(r => r.leading_party === f.party || r.trailing_party === f.party);
    } else {
      rows = rows.filter(r => r.leading_party === f.party);
    }
  }

  if (f.margin) {
    if (f.margin === 'close') rows = rows.filter(r => r.margin < 3000);
    else if (f.margin === 'competitive') rows = rows.filter(r => r.margin >= 3000 && r.margin < 10000);
    else if (f.margin === 'comfortable') rows = rows.filter(r => r.margin >= 10000 && r.margin < 20000);
    else if (f.margin === 'safe') rows = rows.filter(r => r.margin >= 20000);
  }

  if (f.progress) {
    if (f.progress === 'early') {
      rows = rows.filter(r => (r.rounds_completed / Math.max(r.total_rounds, 1)) < 0.4);
    } else if (f.progress === 'mid') {
      rows = rows.filter(r => {
        const pct = r.rounds_completed / Math.max(r.total_rounds, 1);
        return pct >= 0.4 && pct < 0.7;
      });
    } else if (f.progress === 'nearly_done') {
      rows = rows.filter(r => (r.rounds_completed / Math.max(r.total_rounds, 1)) >= 0.7);
    } else if (f.progress === 'declared') {
      rows = rows.filter(r => r.status === 'Result Declared');
    }
  }

  rows.sort((a, b) => b.margin - a.margin);
  return rows;
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

const server = http.createServer(async (req, res) => {
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

  // API: health check
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hasData: constituencies.size > 0,
      count: constituencies.size,
      lastFetch: Array.from(constituencies.values())[0]?.updated_at || null,
      isFetching
    }));
    return;
  }

  // Lazy fetch on first data request
  if (pathname.startsWith('/api/') && pathname !== '/') {
    await ensureData();
  }

  // API: all constituencies
  if (pathname === '/api/constituencies') {
    const rows = Array.from(constituencies.values()).sort((a, b) => b.margin - a.margin);
    const enriched = rows.map(r => {
      const completion_pct = r.total_rounds > 0 ? Math.round((r.rounds_completed / r.total_rounds) * 1000) / 10 : 0;
      return { ...r, completion_pct, estimate: winEstimate(r) };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(enriched));
    return;
  }

  // API: party summary
  if (pathname === '/api/parties') {
    const groups = {};
    for (const r of constituencies.values()) {
      const p = r.leading_party;
      if (!groups[p]) groups[p] = { party: p, seats: 0, total_margin: 0, total_completion: 0 };
      groups[p].seats++;
      groups[p].total_margin += r.margin;
      groups[p].total_completion += r.total_rounds > 0 ? (r.rounds_completed / r.total_rounds) * 100 : 0;
    }
    const rows = Object.values(groups).map(g => ({
      party: g.party,
      seats: g.seats,
      avg_margin: Math.round(g.total_margin / g.seats),
      avg_completion: Math.round((g.total_completion / g.seats) * 10) / 10
    })).sort((a, b) => b.seats - a.seats);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }

  // API: history for one constituency
  if (pathname.startsWith('/api/history/')) {
    const name = decodeURIComponent(pathname.slice('/api/history/'.length));
    const rows = history.filter(h => h.name === name).sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at)).slice(0, 30);
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
        const rows = filterConstituencies(f);
        const enriched = rows.map(r => {
          const completion_pct = r.total_rounds > 0 ? Math.round((r.rounds_completed / r.total_rounds) * 1000) / 10 : 0;
          return { ...r, completion_pct, estimate: winEstimate(r) };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sql: 'in-memory filter', count: enriched.length, rows: enriched }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: natural language query (legacy)
  if (pathname === '/api/query' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { query } = JSON.parse(body);
        const { sql } = nlToSql(query || '');
        // Simulate the old SQL responses using in-memory data
        let rows = Array.from(constituencies.values());
        if (query.toLowerCase().includes('party') && query.toLowerCase().includes('summary')) {
          const groups = {};
          for (const r of rows) {
            const p = r.leading_party;
            if (!groups[p]) groups[p] = { party: p, seats: 0, total_margin: 0, total_completion: 0 };
            groups[p].seats++;
            groups[p].total_margin += r.margin;
            groups[p].total_completion += r.total_rounds > 0 ? (r.rounds_completed / r.total_rounds) * 100 : 0;
          }
          rows = Object.values(groups).map(g => ({
            party: g.party,
            seats: g.seats,
            total_margin: g.total_margin,
            avg_completion: Math.round((g.total_completion / g.seats) * 10) / 10
          })).sort((a, b) => b.seats - a.seats);
        } else {
          rows = rows.sort((a, b) => b.margin - a.margin).slice(0, 30);
          rows = rows.map(r => {
            const completion_pct = r.total_rounds > 0 ? Math.round((r.rounds_completed / r.total_rounds) * 1000) / 10 : 0;
            return { ...r, completion_pct };
          });
        }
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
