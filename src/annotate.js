// Leaves a comment in Shopify (order note, order tag, customer note) whenever the tool merges
// customers or moves Flits points, so the team can see what happened from Shopify admin.
// A comment that fails (for example a missing permission) is logged and never stops a merge.

import { config } from './config.js';
import { appendNote, addTags, customerGid } from './shopify.js';

export const MERGE_TAG = 'merged-by-tool';

const stamp = () => new Date().toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
});
const line = (text) => `[${stamp()}] Customer merger tool: ${text}`;

async function attempt(what, fn) {
  try {
    await fn();
  } catch (err) {
    const hint = /access denied|write_orders|ACCESS_DENIED/i.test(err.message)
      ? ' (add the write_orders permission to the Shopify app)' : '';
    console.warn(`  comment: could not ${what}${hint}: ${err.message.slice(0, 200)}`);
  }
}

/** After a merge. `orderId`/`orderName` are set for automatic merges, empty for dashboard merges. */
export async function noteMerge({ orderId, orderName, dupId, dupLabel, keepId, by, pointsText }) {
  if (config.dryRun) return;
  const from = `duplicate account ${dupId}${dupLabel ? ` (${dupLabel})` : ''}`;
  const after = orderName ? ` after order ${orderName}` : '';
  const who = by ? ` by ${by}` : '';
  const pts = pointsText ? ` ${pointsText}` : '';

  if (orderId) {
    await attempt('add order note', () => appendNote(orderId,
      line(`order moved from ${from} to account ${keepId}${who}.${pts}`)));
    await attempt('add order tag', () => addTags(orderId, [MERGE_TAG]));
  }
  await attempt('add customer note', () => appendNote(customerGid(keepId),
    line(`merged ${from} into this account${after}${who}.${pts}`)));
}

/** After the points step for a merged order has finished. */
export async function notePoints({ orderId, orderName, dupId, keepId, text }) {
  if (config.dryRun) return;
  const msg = `Flits points for order ${orderName}: ${text} (from duplicate ${dupId}).`;
  if (orderId) await attempt('add order note', () => appendNote(orderId, line(msg)));
  await attempt('add customer note', () => appendNote(customerGid(keepId), line(msg)));
}
