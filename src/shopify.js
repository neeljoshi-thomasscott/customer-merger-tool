import { config } from './config.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Auth ----------
// Either a static Admin API token (older custom apps), or a Dev Dashboard app's
// client ID + secret exchanged for a 24-hour token (client credentials grant).
let token = config.accessToken || null;
let tokenExpiresAt = config.accessToken ? Number.POSITIVE_INFINITY : 0;

async function getToken(force = false) {
  if (!config.clientId) return token;
  if (!force && token && Date.now() < tokenExpiresAt - 5 * 60 * 1000) return token;

  const res = await fetch(`https://${config.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  token = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in ? json.expires_in * 1000 : 23 * 3600 * 1000);
  return token;
}

// ---------- GraphQL with retries ----------
export async function gql(query, variables = {}) {
  const url = `https://${config.shop}/admin/api/${config.apiVersion}/graphql.json`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401 && config.clientId && attempt === 1) {
      await getToken(true);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);

    const json = await res.json();
    if (json.errors?.length) {
      const throttled = json.errors.some((e) => e.extensions?.code === 'THROTTLED');
      if (throttled && attempt < 6) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors).slice(0, 1000)}`);
    }
    return json.data;
  }
}

// ---------- Queries ----------
const CUSTOMER_FIELDS = `
  id
  createdAt
  numberOfOrders
  defaultPhoneNumber { phoneNumber }
  defaultEmailAddress { emailAddress }
`;

const Q_ORDERS = `
query RecentOrders($q: String!, $after: String) {
  orders(first: 50, after: $after, sortKey: CREATED_AT, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      phone
      shippingAddress {
        firstName lastName company address1 address2 city provinceCode countryCodeV2 zip phone
      }
      billingAddress { phone }
      customer { ${CUSTOMER_FIELDS} }
    }
  }
}`;

const Q_FIND_CUSTOMERS = `
query FindCustomers($q: String!) {
  customers(first: 10, query: $q) {
    nodes { ${CUSTOMER_FIELDS} }
  }
}`;

const Q_MERGE_PREVIEW = `
query MergePreview($one: ID!, $two: ID!, $override: CustomerMergeOverrideFields) {
  customerMergePreview(customerOneId: $one, customerTwoId: $two, overrideFields: $override) {
    resultingCustomerId
    customerMergeErrors { errorFields message }
  }
}`;

const M_MERGE = `
mutation Merge($one: ID!, $two: ID!, $override: CustomerMergeOverrideFields) {
  customerMerge(customerOneId: $one, customerTwoId: $two, overrideFields: $override) {
    resultingCustomerId
    job { id done }
    userErrors { code field message }
  }
}`;

const Q_JOB = `query Job($id: ID!) { job(id: $id) { id done } }`;

const Q_ADDRESSES = `
query Addresses($id: ID!) {
  customer(id: $id) { addresses(first: 50) { address1 zip } }
}`;

const M_ADD_ADDRESS = `
mutation AddAddress($customerId: ID!, $address: MailingAddressInput!) {
  customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: false) {
    address { id }
    userErrors { field message }
  }
}`;

const Q_ORDER_DELIVERY = `
query OrderDelivery($id: ID!) {
  order(id: $id) {
    id
    name
    cancelledAt
    fulfillments(first: 20) { displayStatus deliveredAt }
  }
}`;

// ---------- Helpers ----------
export async function* iterateOrders(searchQuery) {
  let after = null;
  do {
    const data = await gql(Q_ORDERS, { q: searchQuery, after });
    for (const order of data.orders.nodes) yield order;
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after);
}

// Searches with the full E.164 number and the national number, then de-duplicates.
export async function searchCustomersByPhone(e164, countryCode) {
  const searches = [`phone:"${e164}"`];
  const prefix = '+' + countryCode;
  if (e164.startsWith(prefix)) searches.push(`phone:"${e164.slice(prefix.length)}"`);

  const found = new Map();
  for (const q of searches) {
    const data = await gql(Q_FIND_CUSTOMERS, { q });
    for (const c of data.customers.nodes) found.set(c.id, c);
  }
  return [...found.values()];
}

export async function previewMerge(oneId, twoId, override) {
  const data = await gql(Q_MERGE_PREVIEW, { one: oneId, two: twoId, override });
  return data.customerMergePreview;
}

export async function mergeCustomers(oneId, twoId, override) {
  const data = await gql(M_MERGE, { one: oneId, two: twoId, override });
  const result = data.customerMerge;
  if (result.userErrors?.length) {
    throw new Error(`customerMerge failed: ${JSON.stringify(result.userErrors)}`);
  }
  // The merge runs as a background job; wait (up to ~60s) for it to finish.
  let job = result.job;
  for (let i = 0; job && !job.done && i < 30; i++) {
    await sleep(2000);
    job = (await gql(Q_JOB, { id: job.id })).job;
  }
  return { resultingCustomerId: result.resultingCustomerId, jobDone: !job || job.done };
}

export async function getAddresses(customerId) {
  const data = await gql(Q_ADDRESSES, { id: customerId });
  return data.customer?.addresses || [];
}

export async function addAddress(customerId, address) {
  const data = await gql(M_ADD_ADDRESS, { customerId, address });
  const result = data.customerAddressCreate;
  if (result.userErrors?.length) {
    throw new Error(`customerAddressCreate failed: ${JSON.stringify(result.userErrors)}`);
  }
  return result.address;
}

/** Returns { order, deliveredAt } where deliveredAt is null until a fulfillment is Delivered. */
export async function getOrderDelivery(orderId) {
  const order = (await gql(Q_ORDER_DELIVERY, { id: orderId })).order;
  if (!order) return { order: null, deliveredAt: null };
  const delivered = (order.fulfillments || []).filter((f) => f.displayStatus === 'DELIVERED' || f.deliveredAt);
  const times = delivered.map((f) => (f.deliveredAt ? Date.parse(f.deliveredAt) : Date.now()));
  return { order, deliveredAt: times.length ? new Date(Math.max(...times)).toISOString() : null };
}

// ---------- Notes and tags (comments left by the tool) ----------
const Q_NOTE = `query Note($id: ID!) { node(id: $id) { ... on Order { note } ... on Customer { note } } }`;

const M_ORDER_NOTE = `
mutation OrderNote($input: OrderInput!) {
  orderUpdate(input: $input) { order { id } userErrors { field message } }
}`;

const M_CUSTOMER_NOTE = `
mutation CustomerNote($input: CustomerInput!) {
  customerUpdate(input: $input) { customer { id } userErrors { field message } }
}`;

const M_TAGS_ADD = `
mutation TagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
}`;

/** Adds a line to the end of an order's or customer's note, keeping what's already there. */
export async function appendNote(id, line) {
  const current = (await gql(Q_NOTE, { id })).node?.note || '';
  const note = current.trim() ? `${current.trimEnd()}\n${line}` : line;
  const isOrder = String(id).includes('/Order/');
  const data = await gql(isOrder ? M_ORDER_NOTE : M_CUSTOMER_NOTE, { input: { id, note } });
  const result = isOrder ? data.orderUpdate : data.customerUpdate;
  if (result.userErrors?.length) throw new Error(JSON.stringify(result.userErrors));
}

export async function addTags(id, tags) {
  const result = (await gql(M_TAGS_ADD, { id, tags })).tagsAdd;
  if (result.userErrors?.length) throw new Error(JSON.stringify(result.userErrors));
}

export const numericId = (gid) => String(gid).split('/').pop();
export const customerGid = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/Customer/${id}`);
