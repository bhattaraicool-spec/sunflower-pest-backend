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
const SHEET_ID    = process.env.GOOGLE_SHEET_ID;
const SHEET_RANGE = 'Sheet1!A:X';  // A-W = data columns, X = formula column

// Server-managed columns A-W (23 columns)
const SHEET_COLS = [
  'ID','Trap_ID','County','Visit_Date','Latitude','Longitude',
  'BSMoth_Count','Carthuri_Count','SunfMoth_Count','Pest_Zone',
  'Observer_Name','Trap_Type','Crop_Type','Crop_Stage',
  'Lure_Changed','Comments',
  'RedSFWeevil_Count','GraySFWeevil_Count','DectesSB_Count',
  'SoybeanAphid_Count','ECornBorer_Count','CornRootworm_Count','AlfWeevil_Count',
  // Column X: Avg_Pest_Per_Week_Per_Trap — Google Sheets formula only, server writes ''
];

const SHEET_POLL_MS = 15_000;
const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH       = path.join(DATA_DIR, 'visits.db');

// All 10 pest keys in order (maps to DB column prefix and SHEET_COLS positions)
const PEST_KEYS = [
  'bsmoth', 'carthuri', 'sunfmoth',
  'redsfweevil', 'graysfweevil', 'dctessb',
  'soybeanaphid', 'ecornborer', 'cornrootworm', 'alfweevil',
];

// ── 2. Helpers ────────────────────────────────────────────────────────────────
function calcZone(totalCount) {
  if (totalCount >= 5) return 'High';
  if (totalCount >= 2) return 'Medium';
  return 'Low';
}

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
      const entry = {
        trap_id:   id,
        county:    r.county    || '',
        latitude:  parseFloat(r.latitude)  || 0,
        longitude: parseFloat(r.longitude) || 0,
        n_visits:  0,
        pest_zone: 'Low',
      };
      for (const k of PEST_KEYS) {
        entry[`cum_${k}`]  = 0;
        entry[`peak_${k}`] = 0;
      }
      map.set(id, entry);
    }
    const t = map.get(id);
    let visitTotal = 0;
    for (const k of PEST_KEYS) {
      const cnt = parseFloat(r[`${k}_count`]) || 0;
      t[`cum_${k}`] += cnt;
      if (cnt > t[`peak_${k}`]) t[`peak_${k}`] = cnt;
      visitTotal += cnt;
    }
    t.n_visits++;
    if (r.pest_zone) {
      t.pest_zone = maxZone(t.pest_zone, r.pest_zone);
    } else {
      t.pest_zone = maxZone(t.pest_zone, calcZone(visitTotal));
    }
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
      id                  TEXT PRIMARY KEY,
      trap_id             TEXT,
      county              TEXT,
      visit_date          TEXT,
      latitude            REAL,
      longitude           REAL,
      bsmoth_count        REAL DEFAULT 0,
      carthuri_count      REAL DEFAULT 0,
      sunfmoth_count      REAL DEFAULT 0,
      pest_zone           TEXT,
      observer_name       TEXT,
      trap_type           TEXT,
      crop_type           TEXT,
      crop_stage          TEXT,
      lure_changed        TEXT,
      comments            TEXT,
      submitted_at        TEXT,
      redsfweevil_count   REAL DEFAULT 0,
      graysfweevil_count  REAL DEFAULT 0,
      dctessb_count       REAL DEFAULT 0,
      soybeanaphid_count  REAL DEFAULT 0,
      ecornborer_count    REAL DEFAULT 0,
      cornrootworm_count  REAL DEFAULT 0,
      alfweevil_count     REAL DEFAULT 0
    )
  `);

  // Non-destructive migration: add new columns to existing DBs
  const newCols = [
    'redsfweevil_count REAL DEFAULT 0',
    'graysfweevil_count REAL DEFAULT 0',
    'dctessb_count REAL DEFAULT 0',
    'soybeanaphid_count REAL DEFAULT 0',
    'ecornborer_count REAL DEFAULT 0',
    'cornrootworm_count REAL DEFAULT 0',
    'alfweevil_count REAL DEFAULT 0',
  ];
  for (const colDef of newCols) {
    try { db.exec(`ALTER TABLE visits ADD COLUMN ${colDef}`); } catch (_) { /* already exists */ }
  }

  insertVisit = db.prepare(`
    INSERT OR IGNORE INTO visits VALUES (
      @id, @trap_id, @county, @visit_date, @latitude, @longitude,
      @bsmoth_count, @carthuri_count, @sunfmoth_count, @pest_zone,
      @observer_name, @trap_type, @crop_type, @crop_stage,
      @lure_changed, @comments, @submitted_at,
      @redsfweevil_count, @graysfweevil_count, @dctessb_count,
      @soybeanaphid_count, @ecornborer_count, @cornrootworm_count, @alfweevil_count
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
    csvTraps = trapsRaw.map(t => {
      const entry = {
        trap_id:        t.trap_id,
        county:         t.county,
        longitude:      t.longitude,
        latitude:       t.latitude,
        n_visits:       t.n_visits       || 0,
        combined_score: t.combined_score || 0,
        pest_zone:      t.pest_zone      || 'Low',
      };
      for (const k of PEST_KEYS) {
        entry[`cum_${k}`]  = t[`total_${k}`] || t[`cum_${k}`] || 0;
        entry[`peak_${k}`] = t[`peak_${k}`]  || 0;
      }
      // Legacy CSV field names
      entry.cum_bsmoth    = t.total_bsmoth   || 0;
      entry.cum_carthuri  = t.total_carthuri || 0;
      entry.cum_sunfmoth  = t.total_sunfmoth || 0;
      entry.peak_bsmoth   = t.peak_bsmoth    || 0;
      entry.peak_carthuri = t.peak_carthuri  || 0;
      return entry;
    });

    const visRaw = parseCSV(path.join(__dirname, 'backend', 'data', 'sunflower_timeseries_clean.csv'));
    csvZoneMap = {};
    for (const t of csvTraps) csvZoneMap[t.trap_id] = t.pest_zone;
    csvVisits = visRaw.map(v => {
      const visit = {
        trap_id:      v.trap_id,
        county:       v.county,
        visit_date:   v.visit_date,
        longitude:    v.longitude,
        latitude:     v.latitude,
        crop_stage:   v.crop_stage  || '',
        pest_zone:    csvZoneMap[v.trap_id] || 'Low',
        lure_changed: v.lure_changed || '',
        comments:     v.comments    || '',
      };
      for (const k of PEST_KEYS) {
        visit[`${k}_count`] = v[`${k}_count`] || 0;
      }
      // Legacy field names
      visit.bsmoth_count   = v.bsmoth_count   || 0;
      visit.carthuri_count = v.carthuri_count || 0;
      visit.sunfmoth_count = v.sunfmoth_count || 0;
      return visit;
    });
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
    if (raw.length <= 1) return;
    const header = raw[0].map(h => h.toLowerCase().replace(/ /g, '_'));
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
    // Write header (23 data cols + formula col X)
    const headerRow = [...SHEET_COLS, 'Avg_Pest_Per_Week_Per_Trap'];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [headerRow] },
    });
    // Write CSV visits with new pest cols as 0
    const dataRows = csvVisits.map((v, i) => [
      i + 1,
      v.trap_id, v.county, v.visit_date, v.latitude, v.longitude,
      v.bsmoth_count || 0, v.carthuri_count || 0, v.sunfmoth_count || 0, v.pest_zone,
      '', '', '', v.crop_stage, v.lure_changed, v.comments,
      0, 0, 0, 0, 0, 0, 0,  // new pest counts (cols Q-W)
      '',                    // formula col X — blank, user adds formula
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
app.get('/',            (_req, res) => res.redirect('/dashboard'));
app.get('/dashboard',   (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html')));
app.get('/field-entry', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'field-entry', 'index.html')));

// Serve uploaded images from public/images/
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));

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
  const { county, pest_zone, pest } = req.query;
  if (county)    trapList = trapList.filter(t => t.county.toLowerCase() === county.toLowerCase());
  if (pest_zone) trapList = trapList.filter(t => t.pest_zone === pest_zone);
  const pestKey    = pest && PEST_KEYS.includes(pest) ? pest : 'bsmoth';
  const totalCount = trapList.reduce((s, t) => s + (t[`cum_${pestKey}`] || 0), 0);
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
    source:       sheetEnabled ? 'google_sheets' : 'csv_fallback',
    last_fetched: new Date(cache.lastFetch).toISOString(),
    rows:         cache.rows.length,
    trap_count:   cache.aggregated.length,
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

  // Calculate zone from total pest count if not provided by client
  if (!visit.pest_zone) {
    let total = 0;
    for (const k of PEST_KEYS) total += parseFloat(visit[`${k}_count`]) || 0;
    visit.pest_zone = calcZone(total);
  }

  // SQLite backup (always)
  try {
    insertVisit.run({
      id:                 visit.id,
      trap_id:            visit.trap_id            || null,
      county:             visit.county             || null,
      visit_date:         visit.visit_date         || null,
      latitude:           visit.latitude           || null,
      longitude:          visit.longitude          || null,
      bsmoth_count:       visit.bsmoth_count       || 0,
      carthuri_count:     visit.carthuri_count     || 0,
      sunfmoth_count:     visit.sunfmoth_count     || 0,
      pest_zone:          visit.pest_zone          || null,
      observer_name:      visit.observer_name      || null,
      trap_type:          visit.trap_type          || null,
      crop_type:          visit.crop_type          || null,
      crop_stage:         visit.crop_stage         || null,
      lure_changed:       visit.lure_changed       || null,
      comments:           visit.comments           || null,
      submitted_at:       now,
      redsfweevil_count:  visit.redsfweevil_count  || 0,
      graysfweevil_count: visit.graysfweevil_count || 0,
      dctessb_count:      visit.dctessb_count      || 0,
      soybeanaphid_count: visit.soybeanaphid_count || 0,
      ecornborer_count:   visit.ecornborer_count   || 0,
      cornrootworm_count: visit.cornrootworm_count || 0,
      alfweevil_count:    visit.alfweevil_count    || 0,
    });
  } catch (e) {
    console.error('SQLite insert failed:', e.message);
  }

  // Google Sheet append (with timeout)
  if (sheetEnabled) {
    const row = [
      visit.id,
      visit.trap_id, visit.county, visit.visit_date, visit.latitude, visit.longitude,
      visit.bsmoth_count       || 0,
      visit.carthuri_count     || 0,
      visit.sunfmoth_count     || 0,
      visit.pest_zone,
      visit.observer_name, visit.trap_type, visit.crop_type, visit.crop_stage,
      visit.lure_changed, visit.comments,
      visit.redsfweevil_count  || 0,
      visit.graysfweevil_count || 0,
      visit.dctessb_count      || 0,
      visit.soybeanaphid_count || 0,
      visit.ecornborer_count   || 0,
      visit.cornrootworm_count || 0,
      visit.alfweevil_count    || 0,
      '',  // Avg_Pest_Per_Week_Per_Trap: formula column — left blank for Google Sheets formula
    ];
    try {
      await Promise.race([
        appendToSheet(row),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000)),
      ]);
      await fetchSheetData(true);
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
    console.log(`SD Pest Monitoring Network running → http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});
