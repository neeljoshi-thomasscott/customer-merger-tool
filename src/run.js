// The automatic merger. It doesn't scan the store on a timer: Shopify calls the tool's webhook when an
// order is created, and the order is checked MIN_ORDER_AGE_MINUTES later (so other apps finish with
// the new customer first). Two safety nets cover webhooks that never arrive:
//   - on start, orders from the last LOOKBACK_HOURS that were not handled yet (e.g. while redeploying)
//   - the daily safety check at DAILY_CHECK_TIME (11:00 am India time)
// Flits points for merged orders are checked every POLL_INTERVAL_MINUTES, only while an order waits.
//
//   node src/run.js --once   one catch-up scan + points check, then exit (no webhook)

import { config } from './config.js';
import { iterateOrders, numericId } from './shopify.js';
import { processOrder } from './processOrder.js';
import { processPendingPoints } from './points.js';
import { loadState, saveState, logAction, logAttention, recordHistory, getAutoMerge } from './store.js';
import { runStatus, hooks } from './status.js';
import { dailyCheckDue, markDailyCheck, nextDailyCheckAt, dailyTimeLabel } from './schedule.js';
import { registerOrderWebhook } from './webhooks.js';

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;
// Orders skipped for these reasons are checked again by the daily safety check, because the
// answer can change later (for example the phone is added to the customer after the order).
const RECHECK_DAILY = new Set(['no phone number on order', 'no existing customer with this phone']);

// Everything that reads or writes the state file runs one at a time.
let chain = Promise.resolve();
const serial = (label, fn) => (chain = chain.then(fn).catch((err) => console.error(`${label} failed: ${err.message}`)));

const stamp = () => `[${new Date().toISOString()}] ${config.dryRun ? 'DRY RUN' : 'LIVE'}`;

/** Checks one order and records the result. Returns 'merged', 'skipped', 'acted' or 'error'. */
async function handleOrder(state, order, source) {
  try {
    const r = await processOrder(order);
    runStatus.last = { at: new Date().toISOString(), order: order.name, status: r.status, details: r.details };
    if (r.status !== 'skipped') {
      console.log(`  ${order.name}: ${r.status} | phone ${r.phone} | duplicate ${r.newId} -> old ${r.keepId} | ${r.details}`);
      logAction(order, r);
      if (r.attention) logAttention(order, r);
    }
    // In dry run nothing is remembered, so the live run re-checks the same orders.
    // Orders skipped only by the test filter stay unhandled, so they're merged once test mode is removed.
    if (!config.dryRun && !r.retryLater) {
      state.processed[order.id] = {
        at: new Date().toISOString(), status: r.status, ...(r.status === 'skipped' ? { why: r.details } : {}),
      };
      if (r.pending && config.flits.enabled) state.pendingPoints[order.id] = r.pending;
      if (r.status === 'merged') {
        recordHistory({
          actor: 'automatic', source, status: 'merged', risk: 'low', phone: r.phone,
          message: `Merged after order ${order.name}; points move after delivery`, pointsMoved: 0,
          dup: { id: r.newId, ...r.dupInfo }, keep: { id: r.keepId, ...r.keepInfo },
        });
      }
      saveState(state);
    }
    return r.status === 'merged' ? 'merged' : r.status === 'skipped' ? 'skipped' : 'acted';
  } catch (err) {
    console.error(`  ${order.name}: ERROR ${err.message}`);
    logAttention(order, { attention: `Error, will retry in the daily safety check: ${err.message}` });
    runStatus.last = { at: new Date().toISOString(), order: order.name, status: 'error', details: err.message };
    return 'error';
  }
}

/** Orders placed after automatic merging was last turned on (older ones are reviewed in the dashboard). */
function placedWhileOn(createdAt) {
  const auto = getAutoMerge();
  return auto.enabled && Date.parse(createdAt) >= (auto.at ? Date.parse(auto.at) : 0);
}

// ---------- Webhook: one new order ----------
function onOrderCreated({ id, name, createdAt }) {
  const wh = runStatus.webhook;
  wh.received++;
  wh.lastAt = new Date().toISOString();
  wh.lastOrder = name;
  if (!getAutoMerge().enabled) {
    console.log(`${stamp()} webhook: ${name} received; automatic merging is OFF, ignored`);
    return;
  }
  const dueAt = Date.parse(createdAt || wh.lastAt) + config.minOrderAgeMinutes * MINUTE;
  const wait = Math.max(0, dueAt - Date.now());
  runStatus.waiting[name] = new Date(Date.now() + wait).toISOString();
  console.log(`${stamp()} webhook: ${name} received, checking it in ${Math.round(wait / MINUTE)} min`);
  setTimeout(() => serial(`order ${name}`, async () => {
    delete runStatus.waiting[name];
    const state = loadState();
    if (state.processed[id]) return;
    let order = null;
    for await (const o of iterateOrders(`id:${numericId(id)}`)) if (o.id === id) order = o;
    if (!order) { console.warn(`  ${name}: not found in Shopify, left for the daily safety check`); return; }
    if (!placedWhileOn(order.createdAt)) { console.log(`  ${name}: automatic merging is OFF, skipped`); return; }
    const result = await handleOrder(state, order, 'new order');
    console.log(`${stamp()} ${name}: ${result === 'skipped' ? `no action (${runStatus.last?.details})` : result}`);
  }), wait);
}

// ---------- Scan: start-up catch-up and the daily safety check ----------
async function scan(daily) {
  const auto = getAutoMerge();
  if (!auto.enabled) return null;
  const now = Date.now();
  const switchedOnAt = auto.at ? Date.parse(auto.at) : 0;
  const hours = daily ? Math.max(config.lookbackHours, config.dailyCheckLookbackHours) : config.lookbackHours;
  const from = new Date(Math.max(now - hours * HOUR, switchedOnAt)).toISOString();
  const to = new Date(now - config.minOrderAgeMinutes * MINUTE).toISOString();
  const state = loadState();
  const counts = { checked: 0, merged: 0, errors: 0 };
  console.log(`${stamp()} ${daily ? 'daily safety check' : 'start-up catch-up'}: orders ${from} -> ${to}`);
  if (config.autoMergeOnlyPhones.length) console.log(`  TEST MODE, only orders with phone ${config.autoMergeOnlyPhones.join(', ')}`);

  for await (const order of iterateOrders(`created_at:>='${from}' AND created_at:<='${to}'`)) {
    if (!getAutoMerge().enabled) { console.log('  switched OFF during this run, stopping'); break; }
    const done = state.processed[order.id];
    if (done && !(daily && done.status === 'skipped' && RECHECK_DAILY.has(done.why))) continue;
    counts.checked++;
    const result = await handleOrder(state, order, daily ? 'daily check' : 'new order');
    if (result === 'merged') counts.merged++;
    if (result === 'error') counts.errors++;
  }
  console.log(`  checked ${counts.checked}, merged ${counts.merged}, errors ${counts.errors}`);
  return counts;
}

async function dailyIfDue() {
  if (!getAutoMerge().enabled || !dailyCheckDue()) return;
  const at = new Date();
  const counts = await scan(true);
  if (!counts || !getAutoMerge().enabled) return;
  markDailyCheck(at);
  runStatus.lastDailyCheck = { at: at.toISOString(), ...counts };
  console.log(`  next daily safety check ${dailyTimeLabel()} India time (${nextDailyCheckAt()})`);
}

// ---------- Flits points for merged orders, after delivery ----------
async function points() {
  const state = loadState();
  if (!Object.keys(state.pendingPoints).length) return; // nothing waiting: no calls at all
  const pts = await processPendingPoints(state);
  if (!config.dryRun) saveState(state);
  console.log(`${stamp()} points: waiting for delivery ${pts.waiting}, moved ${pts.moved}, closed ${pts.closed}, errors ${pts.errors}`);
}

async function main() {
  if (process.argv.includes('--once')) {
    await scan(false);
    await points();
    return;
  }
  runStatus.startedAt = new Date().toISOString();
  hooks.onOrderCreated = onOrderCreated;
  // The webhook is served by the dashboard's server (src/main.js runs both); alone, rely on the scans.
  for (let i = 0; i < 20 && !hooks.serverReady; i++) await new Promise((r) => setTimeout(r, 250));
  if (hooks.serverReady) await registerOrderWebhook();
  else console.warn('webhook: dashboard server not running in this process, so new orders are only found by the daily safety check');
  console.log(`${stamp()} automatic merging is ${getAutoMerge().enabled ? 'ON' : 'OFF'}; `
    + `next daily safety check ${dailyTimeLabel() || 'off'} (${nextDailyCheckAt() || '-'})`);

  serial('catch-up', () => scan(false));
  // A local clock, no Shopify calls: starts the daily check at its time.
  setInterval(() => serial('daily check', dailyIfDue), MINUTE);
  setInterval(() => serial('points', points), config.pollIntervalMinutes * MINUTE);
  serial('points', points);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
