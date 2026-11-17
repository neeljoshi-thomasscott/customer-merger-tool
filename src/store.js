import fs from 'node:fs';
import path from 'node:path';
import { config, brands, withBrand, currentBrand, setPracticeSwitch } from './config.js';

// Every file is in the data folder of the brand the current request or job is for.
const made = new Set();
function file(name) {
  const dir = config.dataDir;
  if (!made.has(dir)) { fs.mkdirSync(dir, { recursive: true }); made.add(dir); }
  return path.join(dir, name);
}

export function loadState() {
  const statePath = file('state.json');
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.movedPoints) migrateMovedPoints(state.movedPoints);
    delete state.movedPoints;
    return { processed: {}, pendingPoints: {}, ...state };
  } catch {
    return { processed: {}, pendingPoints: {} };
  }
}

export function saveState(state) {
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  for (const [orderId, entry] of Object.entries(state.processed)) {
    if (Date.parse(entry.at) < cutoff) delete state.processed[orderId];
  }
  delete state.movedPoints; // kept in moved-points.json now
  const statePath = file('state.json');
  fs.writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(statePath + '.tmp', statePath);
}

const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function appendCsv(name, header, row) {
  const p = file(name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, header.map(cell).join(',') + '\n');
  fs.appendFileSync(p, row.map(cell).join(',') + '\n');
}

// Everything the tool did (or would do in dry run).
export function logAction(order, r) {
  appendCsv(
    'actions.csv',
    ['time', 'dry_run', 'order', 'status', 'phone', 'duplicate_customer', 'kept_customer', 'details'],
    [new Date().toISOString(), config.dryRun, order.name, r.status, r.phone, r.newId, r.keepId, r.details],
  );
}

// Cases a person should look at (merge blocked, Flits points to move by hand, errors).
export function logAttention(order, r) {
  appendCsv(
    'needs-attention.csv',
    ['time', 'dry_run', 'order', 'phone', 'duplicate_customer', 'old_customer', 'what_to_do'],
    [new Date().toISOString(), config.dryRun, order.name, r.phone, r.newId, r.keepId, r.attention],
  );
}

// Stage 2: every points transfer (or why none happened).
export function logPoints(p, status, points, details) {
  appendCsv(
    'points.csv',
    ['time', 'dry_run', 'order', 'status', 'points', 'duplicate_customer', 'old_customer', 'old_email', 'details'],
    [new Date().toISOString(), config.dryRun, p.orderName, status, points, p.duplicateId, p.oldId, p.oldEmail, details],
  );
}

// ---------- Merge history (shared by dashboard, cleanup script and automatic merges) ----------
const historyFile = () => file('merge-history.jsonl');

export function recordHistory(entry) {
  fs.appendFileSync(historyFile(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

/** Updates the newest history entry matching `match` (e.g. once the points step has finished). */
export function updateHistory(match, patch) {
  const historyPath = historyFile();
  if (!fs.existsSync(historyPath)) return false;
  const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (!match(entry)) continue;
    lines[i] = JSON.stringify({ ...entry, ...patch });
    fs.writeFileSync(historyPath + '.tmp', lines.join('\n') + '\n');
    fs.renameSync(historyPath + '.tmp', historyPath);
    return true;
  }
  return false;
}

export function readHistory(limit = 2000) {
  const historyPath = historyFile();
  if (!fs.existsSync(historyPath)) return [];
  const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).reverse().map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// ---------- Small JSON files (dismissed pairs, last scan) ----------
export function loadJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function saveJson(name, value) {
  const p = file(name);
  fs.writeFileSync(p + '.tmp', JSON.stringify(value));
  fs.renameSync(p + '.tmp', p);
}

// ---------- Settings changed from the dashboard ----------
// Automatic merging is OFF unless someone turned it on in the dashboard.
export function getAutoMerge() {
  const s = loadJson('settings.json', {}).autoMerge;
  return { enabled: s?.enabled === true, by: s?.by || '', at: s?.at || '' };
}

export function setAutoMerge(enabled, by) {
  const settings = loadJson('settings.json', {});
  settings.autoMerge = { enabled: enabled === true, by, at: new Date().toISOString() };
  saveJson('settings.json', settings);
  return settings.autoMerge;
}

// ---------- Practice mode, switched from the dashboard ----------
// null until someone uses the switch; the brand's DRY_RUN variable applies until then.
export function getPractice() {
  const s = loadJson('settings.json', {}).practice;
  return typeof s?.enabled === 'boolean' ? { enabled: s.enabled, by: s.by || '', at: s.at || '' } : null;
}

export function setPractice(enabled, by) {
  const settings = loadJson('settings.json', {});
  settings.practice = { enabled: enabled === true, by, at: new Date().toISOString() };
  saveJson('settings.json', settings);
  setPracticeSwitch(currentBrand().id, settings.practice.enabled);
  return settings.practice;
}

// At start, every brand gets the mode it was last switched to.
for (const b of brands) {
  withBrand(b, () => {
    const p = getPractice();
    if (p) setPracticeSwitch(b.id, p.enabled);
  });
}

// ---------- Points already moved, per duplicate customer ----------
// Read fresh from disk and written back in the same synchronous step, so the automatic merger and
// the dashboard (same process) can never overwrite each other's record. This is what prevents
// the same points being moved twice, so it lives on the persistent volume.
const movedFile = () => file('moved-points.json');

function readMoved() {
  try { return JSON.parse(fs.readFileSync(movedFile(), 'utf8')); } catch { return {}; }
}
function writeMoved(moved) {
  const movedPath = movedFile();
  fs.writeFileSync(movedPath + '.tmp', JSON.stringify(moved));
  fs.renameSync(movedPath + '.tmp', movedPath);
}

export function getMovedPoints(dupId) {
  return readMoved()[dupId]?.points || 0;
}

export function addMovedPoints(dupId, points) {
  const moved = readMoved();
  const total = Math.round(((moved[dupId]?.points || 0) + points) * 100) / 100;
  moved[dupId] = { points: total, at: new Date().toISOString() };
  writeMoved(moved);
  return total;
}

function migrateMovedPoints(old) {
  const moved = readMoved();
  for (const [dupId, entry] of Object.entries(old)) {
    if ((entry?.points || 0) > (moved[dupId]?.points || 0)) moved[dupId] = entry;
  }
  writeMoved(moved);
}
