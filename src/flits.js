// Flits adapter, using the endpoints Flits support provided.
//
// 1. GET  {base}/customer?shopify_customer_id=ID       -> data.loyalty_points_balance, data.customer_email
// 2. POST {base}/custom_action/{actionId}              -> adds loyalty points, identified by customer_email
//
// The two endpoints use DIFFERENT API keys (FLITS_READ_API_KEY and FLITS_ADD_API_KEY).
// Flits has not given a "deduct" endpoint; see README.

import { config } from './config.js';

const f = () => config.flits;

/**
 * Returns { balance, email } for a Shopify customer (numeric ID),
 * or null if Flits has no record of that customer.
 */
export async function getCustomer(shopifyCustomerId) {
  const url = `${f().baseUrl}/customer?shopify_customer_id=${encodeURIComponent(shopifyCustomerId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'x-api-key': f().readApiKey, 'x-integration-app-name': f().integrationAppName },
  });
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`Flits GET customer ${res.status}: ${text.slice(0, 300)}`);

  const json = JSON.parse(text);
  if (json.status !== 'success' || !json.data) {
    if (/not found/i.test(json.message || '')) return null;
    throw new Error(`Flits GET customer unexpected response: ${text.slice(0, 300)}`);
  }
  const balance = Number(json.data.loyalty_points_balance ?? 0);
  if (Number.isNaN(balance)) throw new Error(`Flits balance is not a number: ${text.slice(0, 300)}`);
  return { balance, email: json.data.customer_email || null };
}

/** Adds loyalty points (credit_type 1) to the customer with this email. */
export async function addLoyaltyPoints(customerEmail, points, comment) {
  const res = await fetch(`${f().baseUrl}/custom_action/${f().addPointsActionId}`, {
    method: 'POST',
    headers: { 'x-api-key': f().addApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_email: customerEmail,
      credit_details: { credit_value: points, comment_text: comment, credit_type: 1 },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Flits add points ${res.status}: ${text.slice(0, 300)}`);
  try {
    const json = JSON.parse(text);
    if (json.status && json.status !== 'success') throw new Error(`Flits add points failed: ${text.slice(0, 300)}`);
  } catch (e) {
    if (e.message.startsWith('Flits')) throw e; // non-JSON success body is fine
  }
  return true;
}
