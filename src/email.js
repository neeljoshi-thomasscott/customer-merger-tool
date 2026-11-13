// Placeholder emails. Accounts created with only a mobile number get a made-up address such as
// 3725de03e137a62f604cca5d3af7178f@thomasscott.in. When such an account is kept in a merge and the
// duplicate has a real email, the real email replaces the placeholder (after the merge, so the older
// account keeps its ID, Flits points and phone login).

import { config } from './config.js';
import { gql, customerGid, sleep, appendCustomerNote } from './shopify.js';

const pattern = new RegExp(config.tempEmailPattern, 'i');

export const isTempEmail = (email) => Boolean(email) && pattern.test(String(email).trim());
export const isRealEmail = (email) => Boolean(email) && !isTempEmail(email);

const Q_EMAIL = `query Email($id: ID!) { customer(id: $id) { defaultEmailAddress { emailAddress } } }`;
const M_EMAIL = `
mutation SetEmail($input: CustomerInput!) {
  customerUpdate(input: $input) { customer { id } userErrors { field message } }
}`;

/**
 * After a merge: if the kept account still has a placeholder email and `realEmail` is a real one,
 * put the real email on the kept account. Returns the email set, or null when nothing changed.
 * Never throws: a failure is returned as { error } so the merge itself still counts as done.
 */
export async function replaceTempEmail(keepId, realEmail) {
  if (config.dryRun || !isRealEmail(realEmail)) return null;
  const id = customerGid(keepId);
  try {
    const current = (await gql(Q_EMAIL, { id })).customer?.defaultEmailAddress?.emailAddress || '';
    if (current && !isTempEmail(current)) return null; // already real (e.g. set by an earlier merge)
    // The duplicate that had this email was just deleted by the merge; Shopify can take a moment
    // to free the address, so try a few times.
    for (let attempt = 1; ; attempt++) {
      const r = (await gql(M_EMAIL, { input: { id, email: realEmail } })).customerUpdate;
      if (!r.userErrors?.length) break;
      const msg = r.userErrors.map((e) => e.message).join('; ');
      if (attempt >= 4 || !/taken|already/i.test(msg)) throw new Error(msg);
      await sleep(3000 * attempt);
    }
    await appendCustomerNote(id, `[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}] `
      + `Customer merger tool: email changed from temporary ${current || '(none)'} to ${realEmail} (from the merged duplicate account).`).catch(() => {});
    console.log(`  email: ${keepId} now uses ${realEmail} instead of the temporary ${current || '(none)'}`);
    return { email: realEmail, from: current };
  } catch (err) {
    console.error(`  email: could not replace temporary email on ${keepId}: ${err.message}`);
    return { error: err.message };
  }
}
