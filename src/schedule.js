// The daily safety check. New orders are merged within minutes (every MERGE_CHECK_MINUTES); once a day
// at DAILY_CHECK_TIME (India time, HH:MM, default 11:00) the merger also looks back further and
// re-checks orders where no duplicate was found the first time, in case one was missed.
// The time of the last daily check is kept on the Volume, so a restart around that time neither
// skips the day nor runs it twice.

import { config } from './config.js';
import { loadJson, saveJson } from './store.js';

const IST_OFFSET = 5.5 * 3600 * 1000; // India has no daylight saving

function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

export const dailyTime = parseTime(config.dailyCheckTime);
if (config.dailyCheckTime && !dailyTime) throw new Error(`DAILY_CHECK_TIME must look like 11:00, got "${config.dailyCheckTime}"`);

/** The scheduled time on the India-time day containing `ms`, as a timestamp. */
function slotOnDay(ms) {
  const ist = new Date(ms + IST_OFFSET);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), dailyTime.h, dailyTime.m) - IST_OFFSET;
}

/** The latest scheduled time that has already passed. */
function lastSlot(now) {
  const today = slotOnDay(now);
  return today <= now ? today : today - 24 * 3600 * 1000;
}

export function lastDailyCheckAt() {
  return loadJson('schedule.json', {}).lastMergeRunAt || null;
}

export function markDailyCheck(at = new Date()) {
  saveJson('schedule.json', { lastMergeRunAt: at.toISOString() });
}

/** True when the daily safety check should run in this check. */
export function dailyCheckDue(now = Date.now()) {
  if (!dailyTime) return false;
  const last = lastDailyCheckAt();
  if (!last) {
    // First start with a schedule: wait for the next scheduled time.
    markDailyCheck(new Date(now));
    return false;
  }
  return Date.parse(last) < lastSlot(now);
}

/** When the next daily check starts (ISO), or null when there is none. */
export function nextDailyCheckAt(now = Date.now()) {
  if (!dailyTime) return null;
  if (dailyCheckDue(now)) return new Date(now).toISOString(); // due now: runs on the next check
  return new Date(lastSlot(now) + 24 * 3600 * 1000).toISOString();
}

export function dailyTimeLabel() {
  if (!dailyTime) return null;
  const h12 = dailyTime.h % 12 || 12;
  return `${h12}:${String(dailyTime.m).padStart(2, '0')} ${dailyTime.h < 12 ? 'am' : 'pm'}`;
}
