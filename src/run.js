import { config } from './config.js';
import { iterateOrders, sleep } from './shopify.js';
import { processOrder } from './processOrder.js';
import { processPendingPoints } from './points.js';
import { loadState, saveState, logAction, logAttention, recordHistory, getAutoMerge } from './store.js';
import { runStatus } from './status.js';
import { dailyCheckDue, markDailyCheck, nextDailyCheckAt, dailyTimeLabel } from './schedule.js';

const HOUR = 3600 * 1000;
// Orders skipped for these reasons are checked again by the daily safety check, because the
// answer can change later (for example the phone is added to the customer after the order).
const RECHECK_DAILY = new Set(['no phone number on order', 'no existing customer with this phone']);

let lastTo = 0;          // end of the previous check's order window (in memory; 0 after a restart)
let lastPointsAt = 0;    // when Flits points were last checked

/** Stage 1: merge new customers from recent orders. */
async function mergeStage(state, now, daily) {
  const auto = getAutoMerge();
  // Only orders placed after automatic merging was last turned on. Older orders are never merged
  // automatically; their duplicates are reviewed in the dashboard instead.
  const switchedOnAt = auto.at ? Date.parse(auto.at) : 0;
  // After a restart (and in the daily check) look back far; otherwise only since the previous check,
  // with an hour of overlap in case Shopify lists an order late.
  const back = daily
    ? Math.max(config.lookbackHours, config.dailyCheckLookbackHours) * HOUR
    : lastTo ? now - lastTo + HOUR : config.lookbackHours * HOUR;
  const toMs = now - config.minOrderAgeMinutes * 60 * 1000;
  const from = new Date(Math.max(now - back, switchedOnAt)).toISOString();
  const to = new Date(toMs).toISOString();
  const query = `created_at:>='${from}' AND created_at:<='${to}'`;
  const counts = { checked: 0, skipped: 0, acted: 0, merged: 0, errors: 0 };
  if (daily) console.log(`  daily check: orders ${from} -> ${to}`);
  if (config.autoMergeOnlyPhones.length) console.log(`  merge: TEST MODE, only orders with phone ${config.autoMergeOnlyPhones.join(', ')}`);

  for await (const order of iterateOrders(query)) {
    if (!getAutoMerge().enabled) { console.log('  merge: switched OFF during this run, stopping'); break; }
    const done = state.processed[order.id];
    if (done && !(daily && done.status === 'skipped' && RECHECK_DAILY.has(done.why))) continue;
    counts.checked++;
    try {
      const r = await processOrder(order);
      if (r.status === 'skipped') {
        counts.skipped++;
      } else {
        counts.acted++;
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
          counts.merged++;
          recordHistory({
            actor: 'automatic', source: daily ? 'daily check' : 'new order', status: 'merged', risk: 'low', phone: r.phone,
            message: `Merged after order ${order.name}; points move after delivery`, pointsMoved: 0,
            dup: { id: r.newId, ...r.dupInfo }, keep: { id: r.keepId, ...r.keepInfo },
          });
        }
        saveState(state);
      }
    } catch (err) {
      counts.errors++;
      console.error(`  ${order.name}: ERROR ${err.message}`);
      logAttention(order, { attention: `Error, will retry next run: ${err.message}` });
    }
  }
  lastTo = toMs;
  return counts;
}

async function cycle({ forcePoints = false } = {}) {
  const state = loadState();
  const now = Date.now();
  const pointsDue = forcePoints || now - lastPointsAt >= config.pollIntervalMinutes * 60 * 1000 - 5000;
  const result = { checked: 0, merged: 0, errors: 0 };
  const stamp = `[${new Date(now).toISOString()}] ${config.dryRun ? 'DRY RUN' : 'LIVE'}`;

  // Stage 1 runs only while automatic merging is switched on in the dashboard.
  if (getAutoMerge().enabled) {
    const daily = dailyCheckDue(now);
    const c = await mergeStage(state, now, daily);
    Object.assign(result, { checked: c.checked, merged: c.merged, errors: c.errors });
    if (daily && getAutoMerge().enabled) {
      markDailyCheck(new Date(now));
      runStatus.lastDailyCheck = { at: new Date(now).toISOString(), checked: c.checked, merged: c.merged, errors: c.errors };
    }
    // Quiet when nothing happened, so the log isn't one line a minute.
    if (c.checked || c.errors || daily || pointsDue) {
      console.log(`${stamp} merge: checked ${c.checked}, no action ${c.skipped}, actions ${c.acted}, errors ${c.errors}`
        + `${daily ? ' (daily check)' : ''}; next daily check ${dailyTimeLabel() || 'off'} (${nextDailyCheckAt(now)})`);
    }
  } else {
    lastTo = 0; // when switched back on, look back fully (still only orders placed after switch-on)
    if (pointsDue) console.log(`${stamp} merge: automatic merging is OFF (turn it on in the dashboard)`);
  }

  // Stage 2: move Flits points for merged orders that have been delivered.
  if (pointsDue) {
    lastPointsAt = now;
    const pts = await processPendingPoints(state);
    if (!config.dryRun) saveState(state);
    console.log(`${stamp} points: waiting for delivery ${pts.waiting}, moved ${pts.moved}, closed ${pts.closed}, errors ${pts.errors}`);
    result.errors += pts.errors;
  }
  return result;
}

async function main() {
  if (process.argv.includes('--once')) {
    await cycle({ forcePoints: true });
    return;
  }
  for (;;) {
    runStatus.running = true;
    runStatus.nextRunAt = null;
    try {
      runStatus.last = await cycle();
    } catch (err) {
      console.error('Run failed:', err.message);
      runStatus.last = { checked: 0, merged: 0, errors: 1 };
    }
    const wait = config.mergeCheckMinutes * 60 * 1000;
    runStatus.running = false;
    runStatus.lastRunAt = new Date().toISOString();
    runStatus.nextRunAt = new Date(Date.now() + wait).toISOString();
    await sleep(wait);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
