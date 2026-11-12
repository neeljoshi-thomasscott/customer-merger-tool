// Leaves a comment on the kept customer's note in Shopify whenever the tool merges customers or
// moves Flits points, so the team can see what happened from Shopify admin.
// A comment that fails is logged and never stops a merge.

import { config } from './config.js';
import { appendCustomerNote, customerGid } from './shopify.js';

const stamp = () => new Date().toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
});
const line = (text) => `[${stamp()}] Customer merger tool: ${text}`;

async function addNote(customerId, text) {
  if (config.dryRun) return;
  try {
    await appendCustomerNote(customerGid(customerId), line(text));
  } catch (err) {
    console.warn(`  comment: could not add customer note to ${customerId}: ${err.message.slice(0, 200)}`);
  }
}

/** After a merge. `orderName` is set for automatic merges, empty for dashboard merges. */
export async function noteMerge({ orderName, dupId, dupLabel, keepId, by, pointsText }) {
  const from = `duplicate account ${dupId}${dupLabel ? ` (${dupLabel})` : ''}`;
  const after = orderName ? ` after order ${orderName}` : '';
  const who = by ? ` by ${by}` : '';
  const pts = pointsText ? ` ${pointsText}` : '';
  await addNote(keepId, `merged ${from} into this account${after}${who}.${pts}`);
}

/** After the points step for a merged order has finished. */
export async function notePoints({ orderName, dupId, keepId, text }) {
  await addNote(keepId, `Flits points for order ${orderName}: ${text} (from duplicate ${dupId}).`);
}
