// Stage 2: after a merged order is delivered, move any Flits points still sitting on the
// duplicate account to the permanent (old) account.
//
// Flits has no "remove points" API, so the tool remembers how many points it already moved
// from each duplicate (moved-points.json) and only ever moves the difference. Running it
// twice can never double the points.

import { config } from './config.js';
import { getOrderDelivery } from './shopify.js';
import * as flits from './flits.js';
import { logPoints, logAttention, getMovedPoints, addMovedPoints } from './store.js';
import { notePoints } from './annotate.js';

// What the comment in Shopify says for each outcome of the points step.
function commentFor(status, points, details) {
  switch (status) {
    case 'moved': return `${points} points ${details}`;
    case 'nothing-to-move': return '0 points to move, none were left on the duplicate account';
    case 'cancelled': return 'none moved, the order was cancelled';
    case 'not-moved': return `${points} points on the duplicate were not moved (moving is turned off)`;
    case 'closed': return null; // order no longer exists: nowhere to write
    default: return `not moved automatically, needs attention: ${details}`;
  }
}

const DAY = 24 * 3600 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;

export async function processPendingPoints(state) {
  const counts = { waiting: 0, moved: 0, closed: 0, errors: 0 };
  if (!config.flits.enabled) return counts;

  for (const [orderId, p] of Object.entries(state.pendingPoints)) {
    const done = async (status, points, details, attention) => {
      logPoints(p, status, points, details);
      const text = commentFor(status, points, details);
      if (text) await notePoints({ orderId, orderName: p.orderName, dupId: p.duplicateId, keepId: p.oldId, text });
      if (attention) {
        logAttention({ name: p.orderName }, {
          phone: '', newId: p.duplicateId, keepId: p.oldId, attention,
        });
      }
      delete state.pendingPoints[orderId];
      counts.closed++;
    };

    try {
      const { order, deliveredAt } = await getOrderDelivery(orderId);

      if (!order) { await done('closed', 0, 'order not found'); continue; }
      if (order.cancelledAt) { await done('cancelled', 0, 'order cancelled; no points moved'); continue; }

      if (!deliveredAt) {
        if (Date.now() - Date.parse(p.mergedAt) > config.pointsMaxWaitDays * DAY) {
          await done('timeout', 0, `not delivered after ${config.pointsMaxWaitDays} days`,
            `Order not delivered after ${config.pointsMaxWaitDays} days. Check Flits points on ${p.duplicateId} manually.`);
        } else {
          counts.waiting++;
        }
        continue;
      }
      if (Date.now() - Date.parse(deliveredAt) < config.pointsDelayAfterDeliveryMinutes * 60 * 1000) {
        counts.waiting++;
        continue;
      }

      // Delivered and the Flow has had time to credit points. How much is on the duplicate?
      const dup = await flits.getCustomer(p.duplicateId);
      if (!dup) { await done('nothing-to-move', 0, 'duplicate not found in Flits'); continue; }

      const already = getMovedPoints(p.duplicateId);
      const toMove = round2(dup.balance - already);
      if (toMove <= 0) {
        await done('nothing-to-move', 0, `duplicate balance ${dup.balance}, already moved ${already}`);
        continue;
      }
      if (!config.flits.movePointsToOldCustomer) {
        await done('not-moved', toMove, 'FLITS_MOVE_POINTS_TO_OLD_CUSTOMER=false');
        continue;
      }

      const email = p.oldEmail || (await flits.getCustomer(p.oldId))?.email || null;
      if (!email) {
        await done('needs-attention', toMove, 'old customer has no email',
          `${toMove} points on duplicate ${p.duplicateId} could not be moved: old customer ${p.oldId} has no email. Add them manually.`);
        continue;
      }

      if (config.dryRun) {
        logPoints({ ...p, oldEmail: email }, 'would-move', toMove, 'dry run');
        counts.waiting++;
        continue;
      }

      await flits.addLoyaltyPoints(email, toMove,
        `Customer merger tool: points moved from duplicate account ${p.duplicateId} (order ${p.orderName})`);
      addMovedPoints(p.duplicateId, toMove);
      console.log(`  ${p.orderName}: moved ${toMove} points ${p.duplicateId} -> ${email}`);
      await done('moved', toMove, `moved to ${email}`);
      counts.moved++;
    } catch (err) {
      counts.errors++;
      p.errors = (p.errors || 0) + 1;
      console.error(`  ${p.orderName}: points ERROR ${err.message}`);
      if (p.errors >= 20) {
        await done('failed', 0, err.message, `Points transfer failed 20 times: ${err.message}. Move points from ${p.duplicateId} to ${p.oldId} manually.`);
      }
    }
  }
  return counts;
}
