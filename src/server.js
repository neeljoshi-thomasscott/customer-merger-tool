// Dashboard for reviewing and merging past duplicate customers.
//   npm run dashboard   ->   http://127.0.0.1:3000
//
// Rules enforced here (not only in the browser):
//   - low and medium risk pairs can be merged in bulk
//   - high risk pairs only one at a time, with confirmHighRisk: true
//   - blocked pairs can't be merged from the dashboard

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { fetchAllCustomers, buildPlan, checkPairs, mergePair } from './mergeService.js';
import { readHistory, loadJson, saveJson, getAutoMerge, setAutoMerge, loadState } from './store.js';
import { runStatus, hooks } from './status.js';
import { WEBHOOK_PATH, validSignature } from './webhooks.js';
import { dailyTime, dailyTimeLabel, nextDailyCheckAt, lastDailyCheckAt } from './schedule.js';

// Automatic merges counted from the merge history, by Indian date.
const istDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
function autoStatus() {
  const auto = getAutoMerge();
  const merges = readHistory(5000).filter((h) => h.actor === 'automatic' && h.status === 'merged');
  const today = istDay(Date.now());
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  return {
    ...auto,
    merged: {
      today: merges.filter((h) => istDay(h.at) === today).length,
      week: merges.filter((h) => Date.parse(h.at) >= weekAgo).length,
      sinceOn: auto.at ? merges.filter((h) => Date.parse(h.at) >= Date.parse(auto.at)).length : 0,
      lastAt: merges[0]?.at || null,
    },
    run: runStatus,
    minOrderAgeMinutes: config.minOrderAgeMinutes,
    pollIntervalMinutes: config.pollIntervalMinutes,
    daily: dailyTime ? (() => {
      const next = nextDailyCheckAt();
      return {
        timeLabel: dailyTimeLabel(),
        lookbackHours: config.dailyCheckLookbackHours,
        nextAt: next,
        nextInMs: Math.max(0, Date.parse(next) - Date.now()),
        lastAt: lastDailyCheckAt(),
      };
    })() : null,
  };
}

const HTML_PATH = fileURLToPath(new URL('./dashboard.html', import.meta.url));
const MAX_BULK = 500;

// ---------- Logins ----------
const users = config.dashboard.users.split(',').map((u) => u.trim()).filter(Boolean).map((u) => {
  const i = u.indexOf(':');
  return { name: u.slice(0, i), hash: sha(u.slice(i + 1)) };
}).filter((u) => u.name && u.hash);
if (!users.length) throw new Error('Set DASHBOARD_USERS in .env, e.g. DASHBOARD_USERS=priya:long-password,rahul:other-password');

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

function authUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const name = decoded.slice(0, i);
  const given = sha(decoded.slice(i + 1));
  const user = users.find((u) => u.name === name);
  if (!user) { crypto.timingSafeEqual(given, given); return null; }
  return crypto.timingSafeEqual(given, user.hash) ? user.name : null;
}

// ---------- In-memory state ----------
let plan = loadJson('plan-latest.json', null); // { scannedAt, scannedBy, pairs }
let task = null; // the one running (or last finished) scan / merge job

function savePlan() { if (plan) saveJson('plan-latest.json', plan); }

function startTask(type, by, total, run) {
  task = { id: crypto.randomUUID(), type, by, status: 'running', phase: '', done: 0, total, results: [], error: '', startedAt: new Date().toISOString() };
  const t = task;
  run(t).then(() => { t.status = 'done'; }).catch((err) => { t.status = 'failed'; t.error = err.message; console.error(err); })
    .finally(() => { t.finishedAt = new Date().toISOString(); });
  return t;
}

function scan(by) {
  return startTask('scan', by, 0, async (t) => {
    t.phase = 'Loading customers';
    const customers = await fetchAllCustomers((n) => { t.done = n; });
    t.phase = 'Finding duplicates';
    const pairs = buildPlan(customers, loadJson('dismissed.json', {}));
    t.phase = 'Checking each pair with Shopify';
    t.done = 0;
    t.total = pairs.length;
    await checkPairs(pairs, (d) => { t.done = d; });
    plan = { scannedAt: new Date().toISOString(), scannedBy: by, customerCount: customers.length, pairs };
    savePlan();
  });
}

function merge(keys, by) {
  return startTask('merge', by, keys.length, async (t) => {
    t.phase = config.dryRun ? 'Practice merge' : 'Merging';
    for (const key of keys) {
      const pair = plan.pairs.find((p) => p.key === key);
      t.current = pair ? { dup: pair.dup.name || pair.dup.email, keep: pair.keep.name || pair.keep.email } : null;
      let r;
      if (!pair) {
        r = { ok: false, status: 'skipped', message: 'No longer in the list (merged or rescanned)' };
      } else {
        try {
          r = await mergePair(pair, { actor: by, source: 'dashboard' });
        } catch (err) {
          r = { ok: false, status: 'failed', message: err.message };
        }
        if (r.status === 'merged' || r.status === 'needs-attention') {
          // The duplicate no longer exists: drop every pair that involves it.
          plan.pairs = plan.pairs.filter((p) => p.dup.id !== pair.dup.id && p.keep.id !== pair.dup.id);
          savePlan();
        } else if (r.status === 'blocked') {
          pair.risk = 'blocked';
          pair.check = { ok: false, reason: r.message };
          savePlan();
        }
      }
      t.results.push({ key, dup: pair?.dup.name || '', keep: pair?.keep.name || '', ...r });
      t.done++;
    }
    t.current = null;
  });
}

// ---------- HTTP helpers ----------
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error('Request too large')); req.destroy(); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Shopify's "order created" webhook: no dashboard login, but it must carry Shopify's signature.
async function orderWebhook(req, res) {
  const raw = await readRaw(req);
  if (!validSignature(raw, req.headers['x-shopify-hmac-sha256'])) {
    console.warn(`webhook: rejected a request without a valid Shopify signature from ${clientIp(req)}`);
    return send(res, 401, { error: 'Invalid signature' });
  }
  send(res, 200, { ok: true }); // answer at once; Shopify retries if it waits more than 5 seconds
  let order;
  try { order = JSON.parse(raw.toString('utf8')); } catch { return console.warn('webhook: body is not JSON'); }
  if (!order.admin_graphql_api_id) return;
  if (!hooks.onOrderCreated) return console.warn(`webhook: ${order.name} received but the merger isn't running here`);
  hooks.onOrderCreated({ id: order.admin_graphql_api_id, name: order.name || `order ${order.id}`, createdAt: order.created_at });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error('Request too large')); req.destroy(); }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}

const shopHandle = config.shop.replace('.myshopify.com', '');

// ---------- Too many wrong passwords: lock that address for 15 minutes ----------
const failures = new Map(); // ip -> { count, until }
const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60 * 1000;

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ---------- Routes ----------
async function handle(req, res) {
  if (req.url === '/health') return send(res, 200, { ok: true });
  if (req.method === 'POST' && req.url === WEBHOOK_PATH) return orderWebhook(req, res);

  const ip = clientIp(req);
  const f = failures.get(ip);
  if (f && f.until > Date.now()) return send(res, 429, { error: 'Too many failed logins. Try again in 15 minutes.' });

  const user = authUser(req);
  if (!user) {
    if (req.headers.authorization) {
      const now = Date.now();
      const entry = f && now - f.first < LOCK_MS ? f : { count: 0, first: now, until: 0 };
      entry.count++;
      if (entry.count >= LOCK_AFTER) { entry.until = now + LOCK_MS; entry.count = 0; entry.first = now; console.warn(`Locked dashboard logins from ${ip} for 15 minutes`); }
      failures.set(ip, entry);
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Duplicate customers", charset="UTF-8"' });
    return res.end('Login required');
  }
  failures.delete(ip);
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  // Block cross-site form posts: every change must come from the dashboard's own script.
  if (req.method === 'POST' && req.headers['x-requested-by'] !== 'dashboard') {
    return send(res, 403, { error: 'Missing dashboard header' });
  }

  switch (route) {
    case 'GET /':
      return send(res, 200, fs.readFileSync(HTML_PATH, 'utf8'), 'text/html; charset=utf-8');

    case 'GET /api/meta':
      return send(res, 200, {
        user,
        shop: config.shop,
        adminBase: `https://admin.shopify.com/store/${shopHandle}`,
        dryRun: config.dryRun,
        flitsEnabled: config.flits.enabled,
        autoMerge: autoStatus(),
        lookbackHours: config.lookbackHours,
        autoMergeOnlyPhones: config.autoMergeOnlyPhones,
      });

    case 'POST /api/auto-merge': {
      const body = await readBody(req);
      if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'enabled must be true or false' });
      const s = setAutoMerge(body.enabled, user);
      console.log(`Automatic merging turned ${s.enabled ? 'ON' : 'OFF'} by ${user}`);
      return send(res, 200, autoStatus());
    }

    case 'GET /api/auto-status':
      return send(res, 200, autoStatus());

    case 'GET /api/plan':
      return send(res, 200, plan || { scannedAt: null, pairs: [] });

    case 'GET /api/task':
      return send(res, 200, task || {});

    case 'GET /api/history': {
      // Automatic merges whose points step hasn't finished yet are still waiting for delivery.
      const waiting = new Set(Object.values(loadState().pendingPoints || {}).map((p) => String(p.duplicateId)));
      return send(res, 200, readHistory().map((h) => (h.actor === 'automatic' && !h.pointsStatus
        ? { ...h, pointsStatus: waiting.has(String(h.dup?.id)) ? 'waiting' : 'finished' }
        : h)));
    }

    case 'GET /api/dismissed': {
      const d = loadJson('dismissed.json', {});
      return send(res, 200, Object.entries(d).map(([key, v]) => ({ key, ...v })).sort((a, b) => b.at.localeCompare(a.at)));
    }

    case 'POST /api/scan':
      if (task?.status === 'running') return send(res, 409, { error: 'Another task is still running' });
      return send(res, 202, scan(user));

    case 'POST /api/merge': {
      if (task?.status === 'running') return send(res, 409, { error: 'Another task is still running' });
      if (!plan) return send(res, 400, { error: 'Scan the store first' });
      const body = await readBody(req);
      const keys = [...new Set(Array.isArray(body.keys) ? body.keys : [])];
      if (!keys.length) return send(res, 400, { error: 'Select at least one pair' });
      if (keys.length > MAX_BULK) return send(res, 400, { error: `Merge at most ${MAX_BULK} pairs at a time` });

      const selected = keys.map((k) => plan.pairs.find((p) => p.key === k));
      if (selected.some((p) => !p)) return send(res, 400, { error: 'Some pairs are no longer in the list. Refresh and try again.' });
      if (selected.some((p) => p.risk === 'blocked')) return send(res, 400, { error: 'Blocked pairs can only be merged in Shopify admin' });
      const highRisk = selected.filter((p) => p.risk === 'high');
      if (highRisk.length && keys.length > 1) return send(res, 400, { error: 'High risk pairs must be merged one at a time' });
      if (highRisk.length && body.confirmHighRisk !== true) return send(res, 400, { error: 'Confirm that both accounts belong to the same person' });

      return send(res, 202, merge(keys, user));
    }

    case 'POST /api/dismiss': {
      const body = await readBody(req);
      const pair = plan?.pairs.find((p) => p.key === body.key);
      if (!pair) return send(res, 404, { error: 'Pair not found' });
      const dismissed = loadJson('dismissed.json', {});
      dismissed[pair.key] = {
        by: user, at: new Date().toISOString(), reason: String(body.reason || 'Not the same person').slice(0, 200),
        phone: pair.phone, dup: pair.dup, keep: pair.keep, risk: pair.risk,
      };
      saveJson('dismissed.json', dismissed);
      plan.pairs = plan.pairs.filter((p) => p.key !== pair.key);
      savePlan();
      return send(res, 200, { ok: true });
    }

    case 'POST /api/restore': {
      const body = await readBody(req);
      const dismissed = loadJson('dismissed.json', {});
      if (!dismissed[body.key]) return send(res, 404, { error: 'Not found' });
      delete dismissed[body.key];
      saveJson('dismissed.json', dismissed);
      return send(res, 200, { ok: true, message: 'Restored. It will show again after the next scan.' });
    }

    default:
      return send(res, 404, { error: 'Not found' });
  }
}

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: err.message });
  });
}).listen(config.dashboard.port, config.dashboard.host, () => {
  hooks.serverReady = true;
  console.log(`Dashboard: http://${config.dashboard.host}:${config.dashboard.port}  (${config.dryRun ? 'practice mode, DRY_RUN=true' : 'LIVE'})`);
});
