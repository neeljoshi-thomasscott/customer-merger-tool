// Shared logic for finding past duplicates, rating their risk and merging them.
// Used by the dashboard (server.js) and the command-line cleanup (backfill.js).

import { config } from './config.js';
import { gql, previewMerge, mergeCustomers, numericId } from './shopify.js';
import { normalizePhone } from './phone.js';
import * as flits from './flits.js';
import { recordHistory, logAttention, getMovedPoints, addMovedPoints } from './store.js';
import { noteMerge } from './annotate.js';

const cc = config.countryCode;
const round2 = (n) => Math.round(n * 100) / 100;
const firstWord = (s) => String(s || '').trim().toLowerCase().split(/\s+/)[0] || '';
const clean = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const RANK = { low: 0, medium: 1, high: 2, blocked: 3 };

// ---------- Fetch every customer ----------
const customersQuery = (n) => `
query AllCustomers($after: String) {
  customers(first: ${n}, after: $after, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id createdAt firstName lastName numberOfOrders
      defaultPhoneNumber { phoneNumber }
      defaultEmailAddress { emailAddress }
      addresses(first: 5) { phone firstName lastName city }
    }
  }
}`;

export async function fetchAllCustomers(onProgress = () => {}) {
  const all = [];
  let after = null;
  let size = config.backfillPageSize;
  for (;;) {
    let data;
    try {
      data = await gql(customersQuery(size), { after });
    } catch (err) {
      if (/MAX_COST_EXCEEDED|cost/i.test(err.message) && size > 10) {
        size = Math.floor(size / 2);
        continue;
      }
      throw err;
    }
    all.push(...data.customers.nodes);
    onProgress(all.length);
    if (!data.customers.pageInfo.hasNextPage) break;
    after = data.customers.pageInfo.endCursor;
  }
  return all;
}

// ---------- Plan ----------
function summary(c, address) {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ')
    || [address?.firstName, address?.lastName].filter(Boolean).join(' ');
  return {
    gid: c.id,
    id: numericId(c.id),
    name,
    firstName: c.firstName || address?.firstName || '',
    lastName: c.lastName || address?.lastName || '',
    email: c.defaultEmailAddress?.emailAddress || '',
    loginPhone: c.defaultPhoneNumber?.phoneNumber || '',
    orders: Number(c.numberOfOrders || 0),
    createdAt: c.createdAt,
    city: address?.city || c.addresses?.find((a) => a.city)?.city || '',
  };
}

export function assessRisk({ type, dup, keep, conflicts = 0 }) {
  const reasons = [];
  let level = 'low';
  const add = (lvl, text) => {
    reasons.push({ level: lvl, text });
    if (RANK[lvl] > RANK[level]) level = lvl;
  };

  const dF = firstWord(dup.firstName);
  const kF = firstWord(keep.firstName);
  if (conflicts > 0) add('high', `Address phones also match ${conflicts} other customer${conflicts > 1 ? 's' : ''}`);
  if (!dF || !kF) add('medium', 'Name missing on one account');
  else if (dF !== kF) add('high', 'First names differ, could be a gift or family delivery');
  else add('low', 'Same first name');

  const dL = clean(dup.lastName);
  const kL = clean(keep.lastName);
  if (dF && dF === kF && dL && kL && dL !== kL) add('medium', 'Last names differ');

  if (type === 'shared-address-phone') add('medium', 'Neither account logs in with this phone');
  else add('low', 'Kept account logs in with this phone');

  if (dup.orders >= 5) add('medium', `Duplicate has ${dup.orders} orders of its own`);

  return { level, reasons };
}

/** Finds duplicate pairs. `dismissed` is an object keyed by pair key ("dupId:keepId"). */
export function buildPlan(customers, dismissed = {}) {
  const owners = new Map();
  for (const c of customers) {
    const p = normalizePhone(c.defaultPhoneNumber?.phoneNumber, cc);
    if (p) owners.set(p, c);
  }

  const pairs = [];
  const dupIds = new Set();
  const primaryIds = new Set();
  const sharedOnly = new Map();

  const addPair = (type, phone, dupC, address, keepC, conflicts = 0) => {
    const dup = summary(dupC, address);
    const keep = summary(keepC);
    const key = `${dup.id}:${keep.id}`;
    if (dismissed[key]) return;
    const { level, reasons } = assessRisk({ type, dup, keep, conflicts });
    pairs.push({ key, type, phone, risk: level, baseRisk: level, reasons, dup, keep, points: null, check: null });
  };

  for (const c of customers) {
    if (c.defaultPhoneNumber?.phoneNumber) continue; // owns a login phone: a separate person, never a duplicate

    const phones = new Map();
    for (const a of c.addresses || []) {
      const p = normalizePhone(a.phone, cc);
      if (p && !phones.has(p)) phones.set(p, a);
    }

    const matched = [...phones.keys()].filter((p) => owners.has(p));
    const ownerPhones = new Map(matched.map((p) => [owners.get(p).id, p]));
    if (ownerPhones.size >= 1) {
      for (const [, p] of ownerPhones) {
        addPair('phone-owner', p, c, phones.get(p), owners.get(p), ownerPhones.size - 1);
        primaryIds.add(owners.get(p).id);
      }
      dupIds.add(c.id);
      continue;
    }
    for (const [p, address] of phones) {
      if (!sharedOnly.has(p)) sharedOnly.set(p, []);
      sharedOnly.get(p).push({ c, address });
    }
  }

  for (const [p, list] of sharedOnly) {
    const members = list.filter((m) => !dupIds.has(m.c.id));
    if (members.length < 2) continue;
    members.sort((a, b) => Date.parse(a.c.createdAt) - Date.parse(b.c.createdAt));
    const primary = members[0].c;
    primaryIds.add(primary.id);
    for (const m of members.slice(1)) {
      if (primaryIds.has(m.c.id) || dupIds.has(m.c.id)) continue;
      addPair('shared-address-phone', p, m.c, m.address, primary);
      dupIds.add(m.c.id);
    }
  }

  pairs.sort((a, b) => RANK[a.risk] - RANK[b.risk] || a.phone.localeCompare(b.phone));
  return pairs;
}

// ---------- Check each pair with Shopify (and Flits) ----------
async function checkWithShopify(pair) {
  const override = pair.keep.email ? { customerIdOfEmailToKeep: pair.keep.gid } : null;
  const preview = await previewMerge(pair.dup.gid, pair.keep.gid, override);
  const errors = preview.customerMergeErrors || [];
  if (errors.length) return { ok: false, reason: `Shopify blocks this merge: ${errors.map((e) => e.message).join('; ')}`, override };
  if (preview.resultingCustomerId !== pair.keep.gid) {
    return { ok: false, reason: 'Shopify would keep the duplicate instead (it has an email, the account to keep has none)', override };
  }
  return { ok: true, override };
}

async function pointsToMove(dupId) {
  if (!config.flits.enabled) return null;
  const f = await flits.getCustomer(dupId);
  const already = getMovedPoints(dupId);
  return Math.max(0, round2((f?.balance || 0) - already));
}

/** Adds Shopify merge checks and Flits points to each pair. Blocked pairs get risk "blocked". */
export async function checkPairs(pairs, onProgress = () => {}) {
  let done = 0;
  for (const pair of pairs) {
    try {
      const check = await checkWithShopify(pair);
      pair.check = { ok: check.ok, reason: check.reason || '' };
      if (!check.ok) pair.risk = 'blocked';
      pair.points = await pointsToMove(pair.dup.id);
    } catch (err) {
      pair.check = { ok: false, reason: `Could not check: ${err.message}` };
      pair.risk = 'blocked';
    }
    onProgress(++done, pairs.length);
  }
  pairs.sort((a, b) => RANK[a.risk] - RANK[b.risk] || a.phone.localeCompare(b.phone));
  return pairs;
}

// ---------- Merge one pair ----------
/**
 * Merges pair.dup into pair.keep and moves the duplicate's Flits points.
 * Re-checks with Shopify first, so a stale plan can never merge the wrong way.
 * Returns { ok, status, message, pointsMoved }.
 */
export async function mergePair(pair, { actor = 'system', source = 'dashboard' } = {}) {
  const history = (status, message, pointsMoved = 0) => {
    if (status === 'would-merge') return;
    recordHistory({
      actor, source, status, message, pointsMoved,
      risk: pair.baseRisk || pair.risk, phone: pair.phone, dup: pair.dup, keep: pair.keep,
    });
  };

  let check;
  try {
    check = await checkWithShopify(pair);
  } catch (err) {
    const message = /not exist|invalid id|not found/i.test(err.message)
      ? 'One of the accounts no longer exists (already merged or deleted)'
      : `Check failed: ${err.message}`;
    return { ok: false, status: 'failed', message };
  }
  if (!check.ok) return { ok: false, status: 'blocked', message: check.reason };

  const toMove = await pointsToMove(pair.dup.id);

  if (config.dryRun) {
    return { ok: true, status: 'would-merge', message: `Practice mode: would merge${toMove ? ` and move ${toMove} points` : ''}`, pointsMoved: 0 };
  }

  const result = await mergeCustomers(pair.dup.gid, pair.keep.gid, check.override);
  if (result.resultingCustomerId && result.resultingCustomerId !== pair.keep.gid) {
    const message = 'Merged, but Shopify kept the duplicate ID. Points not moved; check both accounts in Flits.';
    logAttention({ name: 'dashboard' }, { phone: pair.phone, newId: pair.dup.id, keepId: pair.keep.id, attention: message });
    history('needs-attention', message);
    return { ok: false, status: 'needs-attention', message };
  }

  // Comment on the kept customer in Shopify (never stops the merge if it fails).
  const note = (pointsText) => noteMerge({
    dupId: pair.dup.id, dupLabel: [pair.dup.name, pair.dup.email].filter(Boolean).join(', '),
    keepId: pair.keep.id, by: `${actor} (${source})`, pointsText,
  });

  if (!toMove || !config.flits.movePointsToOldCustomer) {
    await note(toMove ? `${toMove} Flits points were not moved (moving is turned off).` : 'No Flits points to move.');
    history('merged', 'Merged');
    return { ok: true, status: 'merged', message: 'Merged', pointsMoved: 0 };
  }

  const target = pair.keep.email || (await flits.getCustomer(pair.keep.id))?.email;
  if (!target) {
    const message = `Merged. ${toMove} points not moved: the kept account has no email. Add them in Flits by hand.`;
    await note(`${toMove} Flits points NOT moved: this account has no email. Add them in Flits by hand.`);
    logAttention({ name: 'dashboard' }, { phone: pair.phone, newId: pair.dup.id, keepId: pair.keep.id, attention: message });
    history('needs-attention', message);
    return { ok: true, status: 'needs-attention', message };
  }

  try {
    await flits.addLoyaltyPoints(target, toMove, `Customer merger tool: points moved from duplicate account ${pair.dup.id} (customer merge)`);
    addMovedPoints(pair.dup.id, toMove);
    await note(`${toMove} Flits points moved to ${target}.`);
    history('merged', `Merged, ${toMove} points moved`, toMove);
    return { ok: true, status: 'merged', message: `Merged, ${toMove} points moved to ${target}`, pointsMoved: toMove };
  } catch (err) {
    const message = `Merged, but moving ${toMove} points failed: ${err.message}. Add them in Flits by hand.`;
    await note(`moving ${toMove} Flits points FAILED. Add them in Flits by hand.`);
    logAttention({ name: 'dashboard' }, { phone: pair.phone, newId: pair.dup.id, keepId: pair.keep.id, attention: message });
    history('needs-attention', message);
    return { ok: true, status: 'needs-attention', message };
  }
}
