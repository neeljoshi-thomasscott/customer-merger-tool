// When the automatic merger runs. AUTO_MERGE_TIME (India time, HH:MM, default 11:00) makes it merge
// once a day; set it to empty to merge on every check (every POLL_INTERVAL_MINUTES) instead.
// The time of the last merge run is kept on the Volume, so a restart around that time neither
// skips the day nor runs it twice.

import { config } from './config.js';
import { loadJson, saveJson } from './store.js';

const IST_OFFSET = 5.5 * 3600 * 1000; // India has no daylight saving

function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

export const mergeTime = parseTime(config.autoMergeTime);
if (config.autoMergeTime && !mergeTime) throw new Error(`AUTO_MERGE_TIME must look like 11:00, got "${config.autoMergeTime}"`);

/** The scheduled merge time on the India-time day containing `ms`, as a timestamp. */
function slotOnDay(ms) {
  const ist = new Date(ms + IST_OFFSET);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), mergeTime.h, mergeTime.m) - IST_OFFSET;
}

/** The latest scheduled time that has already passed. */
function lastSlot(now) {
  const today = slotOnDay(now);
  return today <= now ? today : today - 24 * 3600 * 1000;
}

export function lastMergeRunAt() {
  return loadJson('schedule.json', {}).lastMergeRunAt || null;
}

export function markMergeRun(at = new Date()) {
  saveJson('schedule.json', { lastMergeRunAt: at.toISOString() });
}

/** True when the merge stage should run in this check. */
export function mergeDue(now = Date.now()) {
  if (!mergeTime) return true;
  const last = lastMergeRunAt();
  if (!last) {
    // First start with a schedule: wait for the next scheduled time instead of merging straight away.
    markMergeRun(new Date(now));
    return false;
  }
  return Date.parse(last) < lastSlot(now);
}

/** When the next scheduled merge run starts (ISO), or null when merging on every check. */
export function nextMergeAt(now = Date.now()) {
  if (!mergeTime) return null;
  if (mergeDue(now)) return new Date(now).toISOString(); // due now: runs on the next check
  return new Date(lastSlot(now) + 24 * 3600 * 1000).toISOString();
}

export function mergeTimeLabel() {
  if (!mergeTime) return null;
  const h12 = mergeTime.h % 12 || 12;
  return `${h12}:${String(mergeTime.m).padStart(2, '0')} ${mergeTime.h < 12 ? 'am' : 'pm'}`;
}
