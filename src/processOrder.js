import { config } from './config.js';
import { normalizePhone } from './phone.js';
import {
  searchCustomersByPhone, previewMerge, mergeCustomers, getAddresses, addAddress, numericId,
} from './shopify.js';
import { noteMerge } from './annotate.js';

const HOUR = 3600 * 1000;
const skipped = (details) => ({ status: 'skipped', details });
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

export async function processOrder(order) {
  const current = order.customer;
  if (!current) return skipped('order has no customer');

  // 1. Is the order's customer a freshly created account?
  const customerCreated = Date.parse(current.createdAt);
  if (Date.parse(order.createdAt) - customerCreated > config.newCustomerWindowHours * HOUR) {
    return skipped('customer is not new');
  }

  // 2. Collect every phone number on the order.
  const phones = [
    order.phone,
    order.shippingAddress?.phone,
    order.billingAddress?.phone,
    current.defaultPhoneNumber?.phoneNumber,
  ]
    .map((p) => normalizePhone(p, config.countryCode))
    .filter(Boolean);
  const uniquePhones = [...new Set(phones)];
  if (!uniquePhones.length) return skipped('no phone number on order');

  // Testing filter: only touch orders with one of the allowed phone numbers.
  if (config.autoMergeOnlyPhones.length) {
    const allowed = config.autoMergeOnlyPhones.map((p) => normalizePhone(p, config.countryCode));
    if (!uniquePhones.some((p) => allowed.includes(p))) return { ...skipped('not a test phone number'), retryLater: true };
  }

  // 3. Find an OLDER customer whose phone exactly matches.
  const matches = new Map();
  for (const phone of uniquePhones) {
    for (const c of await searchCustomersByPhone(phone, config.countryCode)) {
      const cPhone = normalizePhone(c.defaultPhoneNumber?.phoneNumber, config.countryCode);
      if (c.id !== current.id && cPhone === phone && Date.parse(c.createdAt) < customerCreated) {
        matches.set(c.id, { customer: c, phone });
      }
    }
  }
  if (!matches.size) return skipped('no existing customer with this phone');

  const [{ customer: keep, phone }] = [...matches.values()].sort(
    (a, b) => Date.parse(a.customer.createdAt) - Date.parse(b.customer.createdAt),
  );
  const base = { phone, newId: numericId(current.id), keepId: numericId(keep.id) };

  // 4. Ask Shopify what a merge would do. customerTwoId = old customer, and if the old
  //    customer has an email we explicitly tell Shopify to keep it.
  const override = keep.defaultEmailAddress?.emailAddress ? { customerIdOfEmailToKeep: keep.id } : null;
  const preview = await previewMerge(current.id, keep.id, override);
  const errors = preview.customerMergeErrors || [];
  const keepsOld = preview.resultingCustomerId === keep.id;

  if (!errors.length && keepsOld) {
    return doMerge(order, current, keep, override, base);
  }

  const reason = errors.length
    ? `merge blocked: ${errors.map((e) => e.message).join('; ')}`
    : 'Shopify would keep the NEW customer (old customer has no email), so merge skipped';
  return doAddressOnly(order, keep, base, reason);
}

async function doMerge(order, current, keep, override, base) {
  if (config.dryRun) {
    return { ...base, status: 'would-merge', details: 'points will be moved after delivery' };
  }

  let result;
  try {
    result = await mergeCustomers(current.id, keep.id, override);
  } catch (err) {
    return {
      ...base,
      status: 'needs-attention',
      details: `merge failed: ${err.message}`,
      attention: `Merge failed. Order stays on ${base.newId}; delivery points will go there. Move them to ${base.keepId} in Flits.`,
    };
  }

  if (result.resultingCustomerId && result.resultingCustomerId !== keep.id) {
    return {
      ...base,
      status: 'needs-attention',
      details: 'merged, but Shopify kept the new customer ID',
      attention: `Shopify kept the NEW customer ID ${numericId(result.resultingCustomerId)}. Check Flits points manually.`,
    };
  }

  await noteMerge({
    orderName: order.name,
    dupId: base.newId, dupLabel: current.defaultEmailAddress?.emailAddress || '',
    keepId: base.keepId, by: 'automatic merge',
    pointsText: config.flits.enabled ? `Flits points are checked ${config.pointsDelayAfterDeliveryMinutes} minutes after delivery.` : '',
  });

  // Remember this merge so stage 2 moves the duplicate's Flits points after delivery.
  const pending = {
    orderId: order.id,
    orderName: order.name,
    duplicateId: base.newId,
    oldId: base.keepId,
    oldEmail: keep.defaultEmailAddress?.emailAddress || null,
    mergedAt: new Date().toISOString(),
    errors: 0,
  };
  return {
    ...base,
    status: 'merged',
    details: `${result.jobDone ? 'merged' : 'merge job still running'}; points will be moved after delivery`,
    pending,
  };
}

async function doAddressOnly(order, keep, base, reason) {
  const attention = `${reason}. Order stays on duplicate ${base.newId}: delivery points will go there, move them to ${base.keepId} in Flits (or merge manually in Shopify admin).`;
  const ship = order.shippingAddress;
  if (!ship?.address1) {
    return { ...base, status: 'needs-attention', details: `${reason}; no shipping address to copy`, attention };
  }

  const existing = await getAddresses(keep.id);
  const already = existing.some((a) => norm(a.address1) === norm(ship.address1) && norm(a.zip) === norm(ship.zip));
  if (already) {
    return { ...base, status: 'needs-attention', details: `${reason}; address already on old customer`, attention };
  }

  if (config.dryRun) {
    return { ...base, status: 'would-add-address', details: reason, attention };
  }

  await addAddress(keep.id, {
    firstName: ship.firstName,
    lastName: ship.lastName,
    company: ship.company,
    address1: ship.address1,
    address2: ship.address2,
    city: ship.city,
    provinceCode: ship.provinceCode,
    countryCode: ship.countryCodeV2,
    zip: ship.zip,
    phone: ship.phone,
  });
  return { ...base, status: 'address-added', details: reason, attention };
}
