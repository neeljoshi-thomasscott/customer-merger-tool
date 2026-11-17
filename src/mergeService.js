// Shared logic for finding past duplicates, rating their risk and merging them.
// Used by the dashboard (server.js) and the command-line cleanup (backfill.js).

import { config } from './config.js';
import { gql, previewMerge, mergeCustomers, numericId } from './shopify.js';
import { normalizePhone } from './phone.js';
import * as flits from './flits.js';
import { recordHistory, logAttention, getMovedPoints, addMovedPoints } from './store.js';
import { noteMerge } from './annotate.js';
import { replaceTempEmail, isTempEmail } from './email.js';

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
      addresses(first: 5) { phone firstName lastName city zip }
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
    zip: address?.zip || c.addresses?.find((a) => a.zip)?.zip || '',
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

  pairs.push(...noPhonePairs(customers, owners, dismissed));

  pairs.sort((a, b) => RANK[a.risk] - RANK[b.risk] || a.phone.localeCompare(b.phone));
  return pairs;
}

// ---------- Old accounts with no mobile number ----------
// Before mobile-number login, customers checked out with Shopify's email login, so the same person can
// have an old account with no phone at all and a newer account that logs in with their mobile number.
// No phone links them, so these are matched on name, pincode and email, and are never low risk.

const GENERIC_EMAILS = new Set(['contact', 'support', 'orders', 'order', 'customer', 'customers', 'sales', 'admin',
  'hello', 'info', 'test', 'testing', 'noreply', 'donotreply', 'account', 'accounts', 'office', 'shopping', 'mail']);

/** "Neel  Joshi" -> "neel joshi". Needs a first and a last name: one name alone matches too many people. */
function fullNameKey(c) {
  const a = c.addresses?.find((x) => x.firstName || x.lastName);
  const f = clean(c.firstName || a?.firstName);
  const l = clean(c.lastName || a?.lastName);
  return f && l ? `${f} ${l}` : '';
}

/** neel.joshi@thomasscott.in and neeljoshi12@gmail.com -> "neeljoshi". Temporary and generic emails give none. */
function emailKey(c) {
  const email = c.defaultEmailAddress?.emailAddress || '';
  if (!email || isTempEmail(email)) return '';
  const key = email.toLowerCase().split('@')[0].split('+')[0].replace(/[^a-z]/g, '');
  return key.length >= 6 && !GENERIC_EMAILS.has(key) ? key : '';
}

const pinOf = (a) => String(a?.zip || '').replace(/\s+/g, '');
const pins = (c) => new Set((c.addresses || []).map(pinOf).filter((z) => z.length >= 5));
const cities = (c) => new Set((c.addresses || []).map((a) => clean(a.city)).filter(Boolean));
const hasAnyPhone = (c) => Boolean(normalizePhone(c.defaultPhoneNumber?.phoneNumber, cc))
  || (c.addresses || []).some((a) => normalizePhone(a.phone, cc));

function index(list, keyOf) {
  const map = new Map();
  for (const c of list) {
    const k = keyOf(c);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(c);
  }
  return map;
}

/** What links an old account without a phone to an account with a login phone. */
function evidence(old, kept) {
  const oldPins = pins(old);
  const pin = [...pins(kept)].find((p) => oldPins.has(p)) || '';
  const oldCities = cities(old);
  const sameName = Boolean(fullNameKey(old)) && fullNameKey(old) === fullNameKey(kept);
  const sameEmail = Boolean(emailKey(old)) && emailKey(old) === emailKey(kept);
  const sameCity = [...cities(kept)].some((x) => oldCities.has(x));
  const strong = sameName && (Boolean(pin) || sameEmail);
  // Name and city, or a similar email, is suggested for review. A name alone is not suggested.
  const shown = strong || (sameName && sameCity) || sameEmail;
  const score = (sameName ? 4 : 0) + (pin ? 3 : 0) + (sameEmail ? 3 : 0) + (sameCity ? 1 : 0);
  return { sameName, sameEmail, pin, sameCity, strong, shown, score };
}

export function assessNoPhone({ dup, keep, ev, others }) {
  const reasons = [{ level: 'medium', text: 'No mobile number on the old account' }];
  if (ev.sameName) reasons.push({ level: 'low', text: 'Same full name' });
  else if (firstWord(dup.firstName) && firstWord(keep.firstName) && firstWord(dup.firstName) !== firstWord(keep.firstName)) {
    reasons.push({ level: 'high', text: 'First names differ' });
  } else reasons.push({ level: 'high', text: 'Name missing or different' });
  if (ev.pin) reasons.push({ level: 'low', text: `Same pincode ${ev.pin}` });
  if (ev.sameEmail) reasons.push({ level: 'low', text: 'Similar email' });
  if (ev.sameCity && !ev.pin) reasons.push({ level: 'low', text: 'Same city' });
  if (ev.sameName && !ev.strong) reasons.push({ level: 'high', text: 'Only name and city match' });
  if (others > 0) reasons.push({ level: 'high', text: `Also matches ${others} other customer${others > 1 ? 's' : ''}` });
  if (dup.orders >= 5) reasons.push({ level: 'medium', text: `Old account has ${dup.orders} orders` });
  const level = reasons.some((r) => r.level === 'high') ? 'high' : 'medium';
  return { level, reasons };
}

function noPhonePairs(customers, owners, dismissed) {
  // Accounts that log in with a mobile number are the ones kept.
  const keepers = [...owners.values()];
  const byName = index(keepers, fullNameKey);
  const byEmail = index(keepers, emailKey);
  const pairs = [];

  for (const c of customers) {
    if (hasAnyPhone(c)) continue;
    const candidates = new Set([...(byName.get(fullNameKey(c)) || []), ...(byEmail.get(emailKey(c)) || [])]);
    const matches = [...candidates]
      .filter((k) => k.id !== c.id)
      .map((k) => ({ k, ev: evidence(c, k) }))
      .filter((m) => m.ev.shown)
      .sort((a, b) => b.ev.score - a.ev.score || Date.parse(a.k.createdAt) - Date.parse(b.k.createdAt));
    if (!matches.length) continue;

    // One suggestion per old account: the best match. Any other match makes it high risk.
    const { k, ev } = matches[0];
    const address = (ev.pin && c.addresses?.find((a) => pinOf(a) === ev.pin)) || c.addresses?.[0];
    const dup = summary(c, address);
    const keep = summary(k);
    const key = `${dup.id}:${keep.id}`;
    if (dismissed[key]) continue;
    const { level, reasons } = assessNoPhone({ dup, keep, ev, others: matches.length - 1 });
    pairs.push({
      key, type: 'no-phone', phone: normalizePhone(k.defaultPhoneNumber?.phoneNumber, cc) || '',
      matchedOn: [ev.sameName && 'name', ev.pin && 'pincode', ev.sameEmail && 'email', ev.sameCity && !ev.pin && 'city'].filter(Boolean),
      risk: level, baseRisk: level, reasons, dup, keep, points: null, check: null,
    });
  }
  return pairs;
}

// ---------- Check each pair with Shopify (and Flits) ----------
async function checkWithShopify(pair) {
  // Shopify keeps the account whose email is kept, so the kept account's email is always chosen.
  // If only the other account logs in with the phone, its phone number comes along.
  const override = {
    ...(pair.keep.email ? { customerIdOfEmailToKeep: pair.keep.gid } : {}),
    ...(pair.dup.loginPhone && !pair.keep.loginPhone ? { customerIdOfPhoneNumberToKeep: pair.dup.gid } : {}),
  };
  const o = Object.keys(override).length ? override : null;
  const preview = await previewMerge(pair.dup.gid, pair.keep.gid, o);
  const errors = preview.customerMergeErrors || [];
  if (errors.length) return { ok: false, reason: `Shopify blocks this merge: ${errors.map((e) => e.message).join('; ')}`, override: o };
  if (preview.resultingCustomerId !== pair.keep.gid) {
    return { ok: false, reason: 'Shopify would keep the other account instead (the account to keep has no email)', override: o };
  }
  return { ok: true, override: o };
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
export async function mergePair(pair, { actor = 'system', source = 'dashboard', useRealEmail = true, keepNewer = false } = {}) {
  // The team chose to keep the newer account: merge the older one into it instead. Its Flits points
  // then move to the newer account, and its login phone comes along (see checkWithShopify).
  if (keepNewer) pair = { ...pair, dup: pair.keep, keep: pair.dup, flipped: true };
  const deletedId = pair.dup.id;
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
    if (/not exist|invalid id|not found/i.test(err.message)) {
      // Merged or deleted somewhere else (e.g. in Shopify admin) since the last scan.
      return { ok: false, status: 'gone', message: 'Already merged or deleted in Shopify since the last scan; removed from the list' };
    }
    return { ok: false, status: 'failed', message: `Check failed: ${err.message}` };
  }
  if (!check.ok) return { ok: false, status: 'blocked', message: check.reason };

  const toMove = await pointsToMove(pair.dup.id);

  if (config.dryRun) {
    return { deletedId, ok: true, status: 'would-merge', message: `Practice mode: would merge${toMove ? ` and move ${toMove} points` : ''}`, pointsMoved: 0 };
  }

  const result = await mergeCustomers(pair.dup.gid, pair.keep.gid, check.override);
  if (result.resultingCustomerId && result.resultingCustomerId !== pair.keep.gid) {
    const message = 'Merged, but Shopify kept the duplicate ID. Points not moved; check both accounts in Flits.';
    logAttention({ name: 'dashboard' }, { phone: pair.phone, newId: pair.dup.id, keepId: pair.keep.id, attention: message });
    history('needs-attention', message);
    return { deletedId, ok: false, status: 'needs-attention', message };
  }

  // A temporary email on the kept account is replaced by the duplicate's real email (unless turned off).
  const swapped = useRealEmail ? await replaceTempEmail(pair.keep.gid, pair.dup.email) : null;
  const emailMsg = swapped?.email ? `; email changed to ${swapped.email}` : swapped?.error ? `; email NOT changed: ${swapped.error}` : '';

  // Comment on the kept customer in Shopify (never stops the merge if it fails).
  const note = (pointsText) => noteMerge({
    dupId: pair.dup.id, dupLabel: [pair.dup.name, pair.dup.email].filter(Boolean).join(', '),
    keepId: pair.keep.id, by: `${actor} (${source})`, pointsText,
  });

  if (!toMove || !config.flits.movePointsToOldCustomer) {
    await note(toMove ? `${toMove} Flits points were not moved (moving is turned off).` : 'No Flits points to move.');
    history('merged', `Merged${emailMsg}`);
    return { deletedId, ok: true, status: 'merged', message: `Merged${emailMsg}`, pointsMoved: 0 };
  }

  // The email Flits has for the kept account (Flits knows customers by Shopify ID).
  const target = (await flits.getCustomer(pair.keep.id))?.email || pair.keep.email;
  if (!target) {
    const message = `Merged. ${toMove} points not moved: the kept account has no email. Add them in Flits by hand.`;
    await note(`${toMove} Flits points NOT moved: this account has no email. Add them in Flits by hand.`);
    logAttention({ name: 'dashboard' }, { phone: pair.phone, newId: pair.dup.id, keepId: pair.keep.id, attention: message });
    history('needs-attention', message);
    return { deletedId, ok: true, status: 'needs-attention', message };
  }

  try {
    await flits.addLoyaltyPoints(target, toMove, `Customer merger tool: points moved from duplicate account ${pair.dup.id} (customer merge)`);
    addMovedPoints(pair.dup.id, toMove);
    await note(`${toMove} Flits points moved to ${target}.`);
    history('merged', `Merged, ${toMove} points moved${emailMsg}`, toMove);
    return { deletedId, ok: true, status: 'merged', message: `Merged, ${toMove} points moved to ${target}${emailMsg}`, pointsMoved: toMove };
  } catch (err) {
    const message = `Merged, but moving ${toMove} points failed: ${err.message}. Add them in Flits by hand.`;
    await note(`moving ${toMove} Flits points FAILED. Add them in Flits by hand.`);
    logAttention({ name: 'dashboard' }, { phone: pair.phone, newId: pair.dup.id, keepId: pair.keep.id, attention: message });
    history('needs-attention', message);
    return { deletedId, ok: true, status: 'needs-attention', message };
  }
}
