// Live status of the automatic merger, shared with the dashboard (both run in one process on Railway).
// When the dashboard runs on its own (npm run dashboard), nothing updates this and the timer is hidden.

export const runStatus = {
  running: false,
  lastRunAt: null,   // when the last check finished
  nextRunAt: null,   // when the next check starts
  last: null,        // { checked, merged, errors } from the last check
  lastDailyCheck: null, // { at, checked, merged, errors } from the last daily safety check
};
