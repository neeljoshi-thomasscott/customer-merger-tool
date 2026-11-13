// Live status of the automatic merger, shared with the dashboard (both run in one process on Railway).
// When the dashboard runs on its own (npm run dashboard), nothing updates this and the status is hidden.

export const runStatus = {
  startedAt: null,       // when the merger started (null = merger not running in this process)
  webhook: { ok: false, uri: null, error: null, received: 0, lastAt: null, lastOrder: null },
  waiting: {},           // order name -> when it will be checked (orders wait MIN_ORDER_AGE_MINUTES)
  last: null,            // { at, order, status, details } for the last order handled
  lastDailyCheck: null,  // { at, checked, merged, errors } from the last daily safety check
};

// Set by the merger (run.js); called by the dashboard's webhook route.
export const hooks = { onOrderCreated: null, serverReady: false };
