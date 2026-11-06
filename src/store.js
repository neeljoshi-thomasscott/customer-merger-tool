import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const statePath = path.join(config.dataDir, 'state.json');

export function loadState() {
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
  fs.writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(statePath + '.tmp', statePath);
}

const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function appendCsv(file, header, row) {
  const p = path.join(config.dataDir, file);
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
const historyPath = path.join(config.dataDir, 'merge-history.jsonl');

export function recordHistory(entry) {
  fs.appendFileSync(historyPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

export function readHistory(limit = 2000) {
  if (!fs.existsSync(historyPath)) return [];
  const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).reverse().map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// ---------- Small JSON files (dismissed pairs, last scan) ----------
export function loadJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.dataDir, name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function saveJson(name, value) {
  const p = path.join(config.dataDir, name);
  fs.writeFileSync(p + '.tmp', JSON.stringify(value));
  fs.renameSync(p + '.tmp', p);
}

// ---------- Points already moved, per duplicate customer ----------
// Read fresh from disk and written back in the same synchronous step, so the automatic merger and
// the dashboard (same process) can never overwrite each other's record. This is what prevents
// the same points being moved twice, so it lives on the persistent volume.
const movedPath = path.join(config.dataDir, 'moved-points.json');

function readMoved() {
  try { return JSON.parse(fs.readFileSync(movedPath, 'utf8')); } catch { return {}; }
}
function writeMoved(moved) {
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
