import { config } from './config.js';
import { iterateOrders, sleep } from './shopify.js';
import { processOrder } from './processOrder.js';
import { processPendingPoints } from './points.js';
import { loadState, saveState, logAction, logAttention, recordHistory, getAutoMerge } from './store.js';

async function cycle() {
  const state = loadState();
  const now = Date.now();
  const from = new Date(now - config.lookbackHours * 3600 * 1000).toISOString();
  const to = new Date(now - config.minOrderAgeMinutes * 60 * 1000).toISOString();
  const query = `created_at:>='${from}' AND created_at:<='${to}'`;

  const counts = { checked: 0, skipped: 0, acted: 0, errors: 0 };
  console.log(`\n[${new Date().toISOString()}] ${config.dryRun ? 'DRY RUN' : 'LIVE'}: orders ${from} -> ${to}`);

  // Stage 1 runs only while automatic merging is switched on in the dashboard.
  // Orders are not marked as handled while it's off, so they're picked up once it's on again.
  if (!getAutoMerge().enabled) {
    console.log('  merge: automatic merging is OFF (turn it on in the dashboard)');
  } else for await (const order of iterateOrders(query)) {
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
      if (!config.dryRun) {
        state.processed[order.id] = { at: new Date().toISOString(), status: r.status };
        if (r.pending && config.flits.enabled) state.pendingPoints[order.id] = r.pending;
        if (r.status === 'merged') {
          recordHistory({
            actor: 'automatic', source: 'new order', status: 'merged', risk: 'low', phone: r.phone,
            message: `Merged after order ${order.name}; points move after delivery`, pointsMoved: 0,
            dup: { id: r.newId, name: '', email: '' }, keep: { id: r.keepId, name: '', email: '' },
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
}

async function main() {
  if (process.argv.includes('--once')) {
    await cycle();
    return;
  }
  for (;;) {
    try {
      await cycle();
    } catch (err) {
      console.error('Run failed:', err.message);
    }
    await sleep(config.pollIntervalMinutes * 60 * 1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
