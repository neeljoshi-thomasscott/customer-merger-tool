// Command-line cleanup of past duplicates. The dashboard (npm run dashboard) does the same with a screen.
//
//   npm run backfill:dry                   -> plan with Shopify checks and Flits points, nothing changes
//   npm run backfill -- --limit=20         -> merge the first 20 LOW-risk pairs (needs DRY_RUN=false)
//   npm run backfill                       -> merge all LOW-risk pairs
//   npm run backfill -- --include-medium   -> also merge MEDIUM-risk pairs
//
// HIGH-risk pairs are never merged from here: review them one by one in the dashboard.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { fetchAllCustomers, buildPlan, checkPairs, mergePair } from './mergeService.js';
import { loadJson } from './store.js';

const includeMedium = process.argv.includes('--include-medium');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

async function main() {
  console.log(`Cleanup ${config.dryRun ? 'DRY RUN (nothing will change)' : 'LIVE'}` +
    `${includeMedium ? ', low + medium risk' : ', low risk only'}${Number.isFinite(limit) ? `, limit ${limit}` : ''}`);

  const customers = await fetchAllCustomers((n) => process.stdout.write(`\r  loaded ${n} customers`));
  process.stdout.write('\n');
  const pairs = buildPlan(customers, loadJson('dismissed.json', {}));
  console.log(`  found ${pairs.length} duplicate pairs`);

  if (config.dryRun) {
    await checkPairs(pairs, (d, t) => process.stdout.write(`\r  checked ${d}/${t} with Shopify`));
    process.stdout.write('\n');
  }

  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, `backfill-plan-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const write = (row) => fs.appendFileSync(file, row.map(cell).join(',') + '\n');
  write(['risk', 'reasons', 'phone', 'duplicate_id', 'duplicate_name', 'duplicate_email', 'duplicate_orders',
    'keep_id', 'keep_name', 'keep_email', 'keep_orders', 'flits_points', 'result']);

  const allowed = new Set(['low', ...(includeMedium ? ['medium'] : [])]);
  let attempted = 0;
  const counts = {};

  for (const pair of pairs) {
    const out = (result) => {
      counts[result.split(':')[0]] = (counts[result.split(':')[0]] || 0) + 1;
      write([pair.risk, pair.reasons.map((r) => r.text).join('; '), pair.phone,
        pair.dup.id, pair.dup.name, pair.dup.email, pair.dup.orders,
        pair.keep.id, pair.keep.name, pair.keep.email, pair.keep.orders, pair.points ?? '', result]);
    };

    if (pair.risk === 'blocked') { out(`blocked: ${pair.check?.reason}`); continue; }
    if (!allowed.has(pair.risk)) { out(`skipped: ${pair.risk} risk, review in dashboard`); continue; }
    if (attempted >= limit) { out('not run: limit reached'); continue; }
    attempted++;

    if (config.dryRun) { out('would merge'); continue; }
    try {
      const r = await mergePair(pair, { actor: 'cleanup script', source: 'cleanup script' });
      out(`${r.status}: ${r.message}`);
      console.log(`  ${pair.dup.id} -> ${pair.keep.id}: ${r.message}`);
    } catch (err) {
      out(`error: ${err.message}`);
      console.error(`  ${pair.dup.id} -> ${pair.keep.id}: ERROR ${err.message}`);
    }
  }

  console.log('  results:', counts);
  console.log(`  details: ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
