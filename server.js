'use strict';
require('dotenv').config();

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { google } = require('googleapis');
const Database = require('better-sqlite3');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ── 1. Config constants ───────────────────────────────────────────────────────
const SHEET_ID   = process.env.GOOGLE_SHEET_ID;
const SHEET_RANGE = 'Sheet1!A:P';
const SHEET_COLS  = [
  'ID','Trap_ID','County','Visit_Date','Latitude','Longitude',
  'BSMoth_Count','Carthuri_Count','SunfMoth_Count','Pest_Zone',
  'Observer_Name','Trap_Type','Crop_Type','Crop_Stage',
  'Lure_Changed','Comments',
];
const SHEET_POLL_MS = 15_000;
const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH       = path.join(DATA_DIR, 'visits.db');

// ── 2. Helpers ────────────────────────────────────────────────────────────────
function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines   = content.trim().split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const numCols = headers.length;
  return lines.slice(1).map(line => {
    const parts = line.split(',');
    const vals  = parts.length > numCols
      ? [...parts.slice(0, numCols - 1), parts.slice(numCols - 1).join(',')]
      : parts;
    const obj = {};
    headers.forEach((h, i) => {
      const v = (vals[i] || '').trim();
      obj[h] = v !== '' && !isNaN(v) ? parseFloat(v) : v;
    });
    return obj;
  });
}

const ZONE_RANK = { Low: 1, Medium: 2, High: 3 };
function maxZone(a, b) {
  return (ZONE_RANK[a] || 0) >= (ZONE_RANK[b] || 0) ? a : b;
}

function aggregateByTrap(rows) {
  const map = new Map();
  for (const r of rows) {
    const id = r.trap_id;
    if (!id) continue;
    if (!map.has(id)) {
      map.set(id, {
        trap_id:        id,
        county:         r.county      || '',
        latitude:       parseFloat(r.latitude)  || 0,
        longitude:      parseFloat(r.longitude) || 0,
        cum_bsmoth:     0, total_bsmoth:    0,
        cum_carthuri:   0, total_carthuri:  0,
        cum_sunfmoth:   0, total_sunfmoth:  0,
        peak_bsmoth:    0, peak_carthuri:   0, peak_sunfmoth: 0,
        n_visits:       0,
        pest_zone:      'Low',
      });
    }
    const t = map.get(id);
    const bs = parseFloat(r.bsmoth_count)   || 0;
    const ca = parseFloat(r.carthuri_count) || 0;
    const sf = parseFloat(r.sunfmoth_count) || 0;
    t.cum_bsmoth    += bs; t.total_bsmoth    = t.cum_bsmoth;
    t.cum_carthuri  += ca; t.total_carthuri  = t.cum_carthuri;
    t.cum_sunfmoth  += sf; t.total_sunfmoth  = t.cum_sunfmoth;
    if (bs > t.peak_bsmoth)   t.peak_bsmoth   = bs;
    if (ca > t.peak_carthuri) t.peak_carthuri = ca;
    if (sf > t.peak_sunfmoth) t.peak_sunfmoth = sf;
    t.n_visits++;
    if (r.pest_zone) t.pest_zone = maxZone(t.pest_zone, r.pest_zone);
  }
  return [...map.values()];
}

// ── 3. SQLite ─────────────────────────────────────────────────────────────────
let db;
let insertVisit;

function initSQLite() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS visits (
      id            TEXT PRIMARY KEY,
      trap_id       TEXT,
      county        TEXT,
      visit_date    TEXT,
      latitude      REAL,
      longitude     REAL,
      bsmoth_count  REAL,
      carthuri_count REAL,
      sunfmoth_count REAL,
      pest_zone     TEXT,
      observer_name TEXT,
      trap_type     TEXT,
      crop_type     TEXT,
      crop_stage    TEXT,
      lure_changed  TEXT,
      comments      TEXT,
      submitted_at  TEXT
    )
  `);
  insertVisit = db.prepare(`
    INSERT OR IGNORE INTO visits VALUES (
      @id, @trap_id, @county, @visit_date, @latitude, @longitude,
      @bsmoth_count, @carthuri_count, @sunfmoth_count, @pest_zone,
      @observer_name, @trap_type, @crop_type, @crop_stage,
      @lure_changed, @comments, @submitted_at
    )
  `);
  console.log(`✓ SQLite ready at ${DB_PATH}`);
}

// ── 4. CSV fallback ───────────────────────────────────────────────────────────
let csvTraps   = [];
let csvVisits  = [];
let csvZoneMap = {};

function loadCSV() {
  try {
    const trapsRaw = parseCSV(path.join(__dirname, 'backend', 'data', 'sunflower_traps_arcgis.csv'));
    csvTraps = trapsRaw.map(t => ({
      trap_id:       t.trap_id,
      county:        t.county,
      longitude:     t.longitude,
      latitude:      t.latitude,
      cum_bsmoth:    t.total_bsmoth   || 0,
      total_bsmoth:  t.total_bsmoth   || 0,
      cum_carthuri:  t.total_carthuri || 0,
      total_carthuri: t.total_carthuri || 0,
      cum_sunfmoth:  0,
      total_sunfmoth: 0,
      peak_bsmoth:   t.peak_bsmoth    || 0,
      peak_carthuri: t.peak_carthuri  || 0,
      n_visits:      t.n_visits       || 0,
      combined_score: t.combined_score || 0,
      pest_zone:     t.pest_zone      || 'Low',
    }));

    const visRaw = parseCSV(path.join(__dirname, 'backend', 'data', 'sunflower_timeseries_clean.csv'));
    csvZoneMap = {};
    for (const t of csvTraps) csvZoneMap[t.trap_id] = t.pest_zone;
    csvVisits = visRaw.map(v => ({
      trap_id:        v.trap_id,
      county:         v.county,
      visit_date:     v.visit_date,
      longitude:      v.longitude,
      latitude:       v.latitude,
      crop_stage:     v.crop_stage    || '',
      bsmoth_count:   v.bsmoth_count   || 0,
      carthuri_count: v.carthuri_count || 0,
      sunfmoth_count: v.sunfmoth_count || 0,
      pest_zone:      csvZoneMap[v.trap_id] || 'Low',
      lure_changed:   v.lure_changed   || '',
      comments:       v.comments       || '',
    }));
    console.log(`✓ CSV loaded: ${csvTraps.length} traps, ${csvVisits.length} visits`);
  } catch (e) {
    console.error('⚠ CSV load failed:', e.message);
  }
}

// ── 5. Google Sheets auth ─────────────────────────────────────────────────────
let sheets;
let sheetEnabled = false;

async function initSheets() {
  const credsEnv = process.env.GOOGLE_SHEETS_CREDENTIALS;
  if (!SHEET_ID || !credsEnv) {
    console.warn('⚠ Google Sheets not configured — using CSV data');
    return;
  }
  try {
    // Render and some hosts expand \n inside env var values into real newlines,
    // which breaks JSON.parse. Try as-is first; if that fails, re-escape newlines.
    let creds;
    try {
      creds = JSON.parse(credsEnv);
    } catch (_) {
      creds = JSON.parse(credsEnv.replace(/\n/g, '\\n'));
    }
    const auth  = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheets = google.sheets({ version: 'v4', auth });
    sheetEnabled = true;
    console.log('✓ Google Sheets auth initialized');
  } catch (e) {
    console.error('⚠ Google Sheets auth failed:', e.message, '— falling back to CSV');
  }
}

// ── 6. Cache + sheet polling ──────────────────────────────────────────────────
let cache = { rows: [], aggregated: [], lastFetch: 0 };

async function fetchSheetData(force = false) {
  if (!sheetEnabled) return;
  const age = Date.now() - cache.lastFetch;
  if (!force && age < SHEET_POLL_MS) return;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_RANGE,
    });
    const raw = resp.data.values || [];
    if (raw.length <= 1) return; // empty or header-only
    const header = raw[0].map(h => h.toLowerCase());
    const rows = raw.slice(1).map(row => {
      const obj = {};
      header.forEach((h, i) => {
        const v = (row[i] || '').trim();
        obj[h] = v !== '' && !isNaN(v) ? parseFloat(v) : v;
      });
      return obj;
    });
    cache.rows       = rows;
    cache.aggregated = aggregateByTrap(rows);
    cache.lastFetch  = Date.now();
  } catch (e) {
    console.error('Sheet fetch error:', e.message);
  }
}

async function seedSheetFromCSV() {
  if (!sheetEnabled || csvVisits.length === 0) return;
  try {
    const check = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_RANGE,
    });
    const existing = check.data.values || [];
    if (existing.length > 1) {
      console.log(`Sheet already has ${existing.length - 1} rows — skipping seed`);
      return;
    }
    // Write header
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_COLS] },
    });
    // Write all CSV visits
    const dataRows = csvVisits.map((v, i) => [
      i + 1,
      v.trap_id, v.county, v.visit_date, v.latitude, v.longitude,
      v.bsmoth_count, v.carthuri_count, v.sunfmoth_count, v.pest_zone,
      '', '', '', v.crop_stage, v.lure_changed, v.comments,
    ]);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A2',
      valueInputOption: 'RAW',
      requestBody: { values: dataRows },
    });
    console.log(`✓ Seeded ${dataRows.length} rows to Google Sheet`);
  } catch (e) {
    console.error('Seed failed:', e.message);
  }
}

async function appendToSheet(rowArray) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: 'RAW',
    requestBody: { values: [rowArray] },
  });
}

// ── 7. Source selector ────────────────────────────────────────────────────────
function getTraps()     { return cache.aggregated.length ? cache.aggregated : csvTraps; }
function getRawVisits() { return cache.rows.length       ? cache.rows       : csvVisits; }

// ── 8. Routes ─────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.redirect('/dashboard'));
app.get('/dashboard',   (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html')));
app.get('/field-entry', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'field-entry', 'index.html')));

app.get('/api/traps', (req, res) => {
  let result = [...getTraps()];
  const { county, pest_zone, year } = req.query;
  if (county)    result = result.filter(t => t.county.toLowerCase() === county.toLowerCase());
  if (pest_zone) result = result.filter(t => t.pest_zone === pest_zone);
  if (year) {
    const trapsInYear = new Set(
      getRawVisits().filter(v => v.visit_date && v.visit_date.startsWith(year)).map(v => v.trap_id)
    );
    result = result.filter(t => trapsInYear.has(t.trap_id));
  }
  res.json(result);
});

app.get('/api/visits', (req, res) => {
  let result = [...getRawVisits()];
  const { trap_id, county, year } = req.query;
  if (trap_id) result = result.filter(v => String(v.trap_id) === String(trap_id));
  if (county)  result = result.filter(v => v.county === county);
  if (year)    result = result.filter(v => v.visit_date && v.visit_date.startsWith(year));
  res.json(result);
});

app.get('/api/summary', (req, res) => {
  let trapList = [...getTraps()];
  const { county, pest_zone } = req.query;
  if (county)    trapList = trapList.filter(t => t.county.toLowerCase() === county.toLowerCase());
  if (pest_zone) trapList = trapList.filter(t => t.pest_zone === pest_zone);
  const totalCount  = trapList.reduce((s, t) => s + (t.total_bsmoth || 0), 0);
  const peakPerTrap = trapList.length > 0 ? Math.round(totalCount / trapList.length) : 0;
  const highZones   = trapList.filter(t => t.pest_zone === 'High').length;
  res.json({
    trap_sites:    trapList.length,
    total_count:   Math.round(totalCount),
    peak_per_trap: peakPerTrap,
    high_zones:    highZones,
  });
});

app.get('/api/counties', (_req, res) => {
  const counties = [...new Set(getTraps().map(t => t.county))].filter(Boolean).sort();
  res.json(counties);
});

app.get('/api/years', (_req, res) => {
  const years = [...new Set(
    getRawVisits().map(v => v.visit_date && v.visit_date.substring(0, 4)).filter(Boolean)
  )].sort();
  res.json(years);
});

app.get('/api/sheet-data', async (req, res) => {
  if (sheetEnabled) await fetchSheetData(true);
  res.json({
    source:      sheetEnabled ? 'google_sheets' : 'csv_fallback',
    last_fetched: new Date(cache.lastFetch).toISOString(),
    rows:        cache.rows.length,
    trap_count:  cache.aggregated.length,
  });
});

app.get('/api/status', (_req, res) => {
  res.json({
    sheet_enabled: sheetEnabled,
    cache_rows:    cache.rows.length,
    cache_age_s:   Math.round((Date.now() - cache.lastFetch) / 1000),
    csv_traps:     csvTraps.length,
    db_path:       DB_PATH,
  });
});

app.post('/api/visits', async (req, res) => {
  const now   = new Date().toISOString();
  const visit = { ...req.body, id: String(Date.now()), submitted_at: now };

  // SQLite backup (always)
  try {
    insertVisit.run({
      id:             visit.id,
      trap_id:        visit.trap_id        || null,
      county:         visit.county         || null,
      visit_date:     visit.visit_date     || null,
      latitude:       visit.latitude       || null,
      longitude:      visit.longitude      || null,
      bsmoth_count:   visit.bsmoth_count   || 0,
      carthuri_count: visit.carthuri_count || 0,
      sunfmoth_count: visit.sunfmoth_count || 0,
      pest_zone:      visit.pest_zone      || null,
      observer_name:  visit.observer_name  || null,
      trap_type:      visit.trap_type      || null,
      crop_type:      visit.crop_type      || null,
      crop_stage:     visit.crop_stage     || null,
      lure_changed:   visit.lure_changed   || null,
      comments:       visit.comments       || null,
      submitted_at:   now,
    });
  } catch (e) {
    console.error('SQLite insert failed:', e.message);
  }

  // Google Sheet append (with timeout)
  if (sheetEnabled) {
    const row = [
      visit.id,
      visit.trap_id, visit.county, visit.visit_date, visit.latitude, visit.longitude,
      visit.bsmoth_count, visit.carthuri_count, visit.sunfmoth_count, visit.pest_zone,
      visit.observer_name, visit.trap_type, visit.crop_type, visit.crop_stage,
      visit.lure_changed, visit.comments,
    ];
    try {
      await Promise.race([
        appendToSheet(row),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000)),
      ]);
      await fetchSheetData(true); // force-refresh cache
    } catch (e) {
      console.error('Sheet append failed:', e.message);
    }
  }

  res.json({ success: true, id: visit.id });
});

// ── 9. Startup sequence ───────────────────────────────────────────────────────
async function start() {
  loadCSV();
  initSQLite();
  await initSheets();
  if (sheetEnabled) {
    await seedSheetFromCSV();
    await fetchSheetData(true);
    setInterval(() => fetchSheetData(), SHEET_POLL_MS);
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sunflower Pest Monitor running → http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});
