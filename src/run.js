import { config } from './config.js';
import { iterateOrders, sleep } from './shopify.js';
import { processOrder } from './processOrder.js';
import { processPendingPoints } from './points.js';
import { loadState, saveState, logAction, logAttention, recordHistory, getAutoMerge } from './store.js';
import { runStatus } from './status.js';

async function cycle() {
  const state = loadState();
  const now = Date.now();
  const auto = getAutoMerge();
  // Only orders placed after automatic merging was last turned on. Older orders are never merged
  // automatically; their duplicates are reviewed in the dashboard instead.
  const switchedOnAt = auto.at ? Date.parse(auto.at) : 0;
  const from = new Date(Math.max(now - config.lookbackHours * 3600 * 1000, switchedOnAt)).toISOString();
  const to = new Date(now - config.minOrderAgeMinutes * 60 * 1000).toISOString();
  const query = `created_at:>='${from}' AND created_at:<='${to}'`;

  const counts = { checked: 0, skipped: 0, acted: 0, merged: 0, errors: 0 };
  console.log(`\n[${new Date().toISOString()}] ${config.dryRun ? 'DRY RUN' : 'LIVE'}: orders ${from} -> ${to}`);

  // Stage 1 runs only while automatic merging is switched on in the dashboard.
  const autoOn = auto.enabled;
  if (!autoOn) console.log('  merge: automatic merging is OFF (turn it on in the dashboard)');
  else if (config.autoMergeOnlyPhones.length) console.log(`  merge: TEST MODE, only orders with phone ${config.autoMergeOnlyPhones.join(', ')}`);

  if (autoOn) for await (const order of iterateOrders(query)) {
    if (!getAutoMerge().enabled) { console.log('  merge: switched OFF during this run, stopping'); break; }
    if (state.processed[order.id]) continue;
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
        state.processed[order.id] = { at: new Date().toISOString(), status: r.status };
        if (r.pending && config.flits.enabled) state.pendingPoints[order.id] = r.pending;
        if (r.status === 'merged') {
          counts.merged++;
          recordHistory({
            actor: 'automatic', source: 'new order', status: 'merged', risk: 'low', phone: r.phone,
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

  console.log(`  merge: checked ${counts.checked}, no action ${counts.skipped}, actions ${counts.acted}, errors ${counts.errors}`);

  // Stage 2: move Flits points for merged orders that have been delivered.
  const pts = await processPendingPoints(state);
  if (!config.dryRun) saveState(state);
  console.log(`  points: waiting for delivery ${pts.waiting}, moved ${pts.moved}, closed ${pts.closed}, errors ${pts.errors}`);
  return { checked: counts.checked, merged: counts.merged, errors: counts.errors + pts.errors };
}

async function main() {
  if (process.argv.includes('--once')) {
    await cycle();
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
    const wait = config.pollIntervalMinutes * 60 * 1000;
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
