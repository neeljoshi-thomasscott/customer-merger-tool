// Shopify "order created" webhook. On startup the tool subscribes itself (once) to ORDERS_CREATE,
// pointing at <PUBLIC_URL>/webhooks/orders-create. Shopify signs every webhook with the app's
// client secret; anything without a valid signature is rejected.

import crypto from 'node:crypto';
import { config } from './config.js';
import { gql } from './shopify.js';
import { runStatus } from './status.js';

export const WEBHOOK_PATH = '/webhooks/orders-create';

const Q_SUBS = `
query Subs {
  webhookSubscriptions(first: 50, topics: [ORDERS_CREATE]) { nodes { id uri } }
}`;

const M_SUB = `
mutation Sub($sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: $sub) {
    webhookSubscription { id uri }
    userErrors { field message }
  }
}`;

/** True when the X-Shopify-Hmac-Sha256 header matches the raw request body. */
export function validSignature(rawBody, header) {
  if (!header) return false;
  const given = Buffer.from(String(header), 'base64');
  // SHOPIFY_WEBHOOK_SECRET only if Shopify signs with a different secret than the client secret.
  const secrets = [...new Set([process.env.SHOPIFY_WEBHOOK_SECRET, config.clientSecret, config.clientSecret.trim()]
    .filter(Boolean))];
  return secrets.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

/** What a rejected request looked like (no secrets), to find out why a signature didn't match. */
export function describeRequest(req, rawBody) {
  const h = req.headers;
  return `topic ${h['x-shopify-topic'] || '-'}, shop ${h['x-shopify-shop-domain'] || '-'}, `
    + `api ${h['x-shopify-api-version'] || '-'}, signature ${h['x-shopify-hmac-sha256'] ? `${String(h['x-shopify-hmac-sha256']).length} chars` : 'missing'}, `
    + `body ${rawBody.length} bytes, encoding ${h['content-encoding'] || 'none'}, `
    + `secret ${config.clientSecret.length} chars${config.clientSecret !== config.clientSecret.trim() ? ' (has spaces)' : ''}`;
}

/** Makes sure Shopify sends new orders to this tool. Safe to run on every start. */
export async function registerOrderWebhook() {
  const wh = runStatus.webhook;
  if (!config.clientSecret) {
    wh.error = 'Webhooks need SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (to check Shopify\'s signature).';
  } else if (!config.publicUrl) {
    wh.error = 'No public address: set PUBLIC_URL, or generate a Railway domain.';
  }
  if (wh.error) { console.warn(`webhook: ${wh.error}`); return; }

  const uri = `${config.publicUrl}${WEBHOOK_PATH}`;
  wh.uri = uri;
  try {
    const existing = (await gql(Q_SUBS)).webhookSubscriptions.nodes;
    if (existing.some((s) => s.uri === uri)) {
      wh.ok = true;
      console.log(`webhook: Shopify sends new orders to ${uri}`);
      return;
    }
    const r = (await gql(M_SUB, {
      // Only the fields the tool needs; it reads the rest of the order from Shopify itself.
      sub: { uri, format: 'JSON', includeFields: ['id', 'admin_graphql_api_id', 'name', 'created_at'] },
    })).webhookSubscriptionCreate;
    if (r.userErrors?.length) throw new Error(r.userErrors.map((e) => e.message).join('; '));
    wh.ok = true;
    console.log(`webhook: subscribed, Shopify now sends new orders to ${uri}`);
  } catch (err) {
    wh.error = `Could not subscribe to new orders: ${err.message}`;
    console.error(`webhook: ${wh.error}`);
  }
}
