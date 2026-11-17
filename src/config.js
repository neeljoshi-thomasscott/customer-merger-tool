// Reads settings from environment variables (.env) and command-line flags.
//
// One deployment can serve several brands (Shopify stores). Settings that differ per store (Shopify
// credentials, Flits keys, practice mode, temporary email pattern, data folder) live on a brand.
// Everything else is shared.
//
//   - The main brand uses the plain variables (SHOPIFY_SHOP, FLITS_READ_API_KEY, DRY_RUN, ...), and its
//     records stay at the top of the data folder.
//   - More brands are listed in EXTRA_BRANDS (e.g. EXTRA_BRANDS=newbrand) and use the same variables
//     with the brand's ID in front (NEWBRAND_SHOPIFY_SHOP, NEWBRAND_FLITS_READ_API_KEY, NEWBRAND_DRY_RUN, ...).
//     Their records live in <data folder>/brands/<id>.
//
// Code reads brand settings through `config` as before (config.shop, config.flits, config.dryRun, ...).
// They come from the brand the current request or job runs for (see withBrand). Reading one with no
// brand selected is a bug and throws, so a job can never quietly use another brand's store or keys.

import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`Invalid number in config: ${value}`);
  return n;
}

function arg(name) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : undefined;
}

const shared = {
  apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',

  // Country calling code used for numbers typed without one (India = 91).
  countryCode: String(process.env.DEFAULT_COUNTRY_CALLING_CODE || '91'),

  // Only look at orders at least this old, so other apps finish with the new customer first.
  minOrderAgeMinutes: num(process.env.MIN_ORDER_AGE_MINUTES, 10),

  // How far back each run looks. Override once with --lookback-hours=720 to clean up old duplicates.
  lookbackHours: num(arg('lookback-hours') ?? process.env.LOOKBACK_HOURS, 48),

  // The order's customer counts as "new" only if created within this many hours before the order.
  newCustomerWindowHours: num(process.env.NEW_CUSTOMER_WINDOW_HOURS, 24),

  // Backfill: customers fetched per API page (halved automatically if Shopify says the query is too expensive).
  backfillPageSize: num(process.env.BACKFILL_PAGE_SIZE, 100),

  dashboard: {
    // Railway gives the port in PORT and needs the app to listen on all interfaces.
    host: process.env.DASHBOARD_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1'),
    port: num(process.env.DASHBOARD_PORT || process.env.PORT, 3000),
    // "name:password,name2:password2" - each team member logs in with their own name, shown in history.
    users: process.env.DASHBOARD_USERS || '',
  },

  // Flits points (stage 2): merged orders waiting for delivery are checked this often.
  // Nothing is fetched when no order is waiting.
  pollIntervalMinutes: num(process.env.POLL_INTERVAL_MINUTES, 5),

  // Public address of this tool, for Shopify's "order created" webhook. On Railway the generated
  // domain is used automatically.
  publicUrl: (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, ''),

  // Daily safety check (India time, HH:MM): once a day the merger scans recent orders, in case a
  // webhook was missed, and re-checks orders where no duplicate was found the first time. Empty = off.
  dailyCheckTime: String(process.env.DAILY_CHECK_TIME ?? process.env.AUTO_MERGE_TIME ?? '11:00').trim(),
  dailyCheckLookbackHours: num(process.env.DAILY_CHECK_LOOKBACK_HOURS, 72),

  // Testing: when set (comma separated), the automatic merger only acts on orders with one of these
  // phone numbers and skips every other order. Leave empty for normal use.
  autoMergeOnlyPhones: String(process.env.AUTO_MERGE_ONLY_PHONES || '').split(',').map((p) => p.trim()).filter(Boolean),

  // On Railway, the attached Volume's mount path is used automatically.
  rootDataDir: process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './data',
  onRailway: Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID),
  hasRailwayVolume: Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH),

  // Stage 2: move Flits points this many minutes after the order is marked Delivered
  // (gives your delivery Flow time to credit the points first).
  pointsDelayAfterDeliveryMinutes: num(process.env.POINTS_DELAY_AFTER_DELIVERY_MINUTES, 60),
  // Stop waiting for delivery after this many days and report the order instead.
  pointsMaxWaitDays: num(process.env.POINTS_MAX_WAIT_DAYS, 30),
};

// ---------- Brands ----------
const FLITS_BASE_URL = (process.env.FLITS_BASE_URL || 'https://l7dwmnkv4xwd2wytgus6eajvbq0xtkli.lambda-url.us-east-2.on.aws').replace(/\/+$/, '');
const forceDryRun = process.argv.includes('--dry-run');
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Reads one brand's settings. `prefix` is '' for the main brand and e.g. 'NEWBRAND_' for an extra one.
 * Extra brands get no Thomas Scott defaults: their temporary email pattern and Flits action ID must be set.
 */
function readBrand(id, prefix, main) {
  const env = (name) => process.env[prefix + name];
  const label = prefix ? `${prefix}*` : 'the plain variables';
  const shop = String(env('SHOPIFY_SHOP') || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!shop) throw new Error(`${prefix}SHOPIFY_SHOP is required, e.g. your-store.myshopify.com`);
  const handle = shop.replace(/\.myshopify\.com$/, '');

  const brand = {
    id,
    name: String(env('BRAND_NAME') || handle).trim(),
    shop,
    adminBase: `https://admin.shopify.com/store/${handle}`,
    accessToken: env('SHOPIFY_ACCESS_TOKEN') || '',
    clientId: env('SHOPIFY_CLIENT_ID') || '',
    clientSecret: env('SHOPIFY_CLIENT_SECRET') || '',
    // Only if Shopify signs webhooks with a different secret than the client secret.
    webhookSecret: env('SHOPIFY_WEBHOOK_SECRET') || '',

    // Practice mode until someone switches it on the dashboard (see isPractice). DRY_RUN only sets
    // the starting mode; --dry-run on the command line always forces practice mode.
    envDryRun: bool(env('DRY_RUN'), true),

    // Placeholder emails given to accounts created with only a mobile number (regular expression).
    // In a merge, a real email from the duplicate replaces such an email on the kept account. Empty = off.
    tempEmailPattern: env('TEMP_EMAIL_PATTERN') ?? (main ? String.raw`^[0-9a-f]{32}@thomasscott\.in$` : ''),

    // Records of this brand (state, history, points moved, last scan). The main brand keeps the top
    // folder, so an existing single-brand deployment keeps its records where they are.
    dataDir: main ? shared.rootDataDir : path.join(shared.rootDataDir, 'brands', id),

    flits: {
      enabled: bool(env('FLITS_ENABLED'), false),
      baseUrl: FLITS_BASE_URL,
      readApiKey: env('FLITS_READ_API_KEY') || '',
      addApiKey: env('FLITS_ADD_API_KEY') || '',
      addPointsActionId: env('FLITS_ADD_POINTS_ACTION_ID') || (main ? 'Ns3x94kSXoZvgqDLLW11Kw' : ''),
      integrationAppName: env('FLITS_INTEGRATION_APP_NAME') || 'flits-kwikpass',
      // Move the duplicate account's points balance to the old (permanent) account after merging.
      movePointsToOldCustomer: bool(env('FLITS_MOVE_POINTS_TO_OLD_CUSTOMER'), true),
    },
  };

  if (!brand.accessToken && !(brand.clientId && brand.clientSecret)) {
    throw new Error(`Brand "${brand.name}": set ${prefix}SHOPIFY_ACCESS_TOKEN, or ${prefix}SHOPIFY_CLIENT_ID + ${prefix}SHOPIFY_CLIENT_SECRET`);
  }
  if (brand.flits.enabled && (!brand.flits.readApiKey || !brand.flits.addApiKey || !brand.flits.addPointsActionId)) {
    throw new Error(`Brand "${brand.name}": ${prefix}FLITS_ENABLED=true needs ${prefix}FLITS_READ_API_KEY, `
      + `${prefix}FLITS_ADD_API_KEY and ${prefix}FLITS_ADD_POINTS_ACTION_ID (settings: ${label})`);
  }
  try { new RegExp(brand.tempEmailPattern || '$^'); } catch (err) {
    throw new Error(`Brand "${brand.name}": ${prefix}TEMP_EMAIL_PATTERN is not a valid regular expression: ${err.message}`);
  }
  return Object.freeze(brand);
}

function readBrands() {
  const mainShop = String(process.env.SHOPIFY_SHOP || '').replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '');
  const list = [readBrand(slug(process.env.BRAND_ID) || slug(mainShop) || 'main', '', true)];
  for (const raw of String(process.env.EXTRA_BRANDS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const id = slug(raw);
    if (!id) throw new Error(`EXTRA_BRANDS: "${raw}" is not a valid brand ID (use letters and digits)`);
    list.push(readBrand(id, `${id.toUpperCase().replace(/-/g, '_')}_`, false));
  }
  const seen = new Map();
  for (const b of list) {
    for (const key of [`id ${b.id}`, `shop ${b.shop}`]) {
      if (seen.has(key)) throw new Error(`Two brands use the same ${key} ("${seen.get(key)}" and "${b.name}")`);
      seen.set(key, b.name);
    }
  }
  return list;
}

export const brands = readBrands();
export const mainBrand = brands[0];
export const findBrand = (id) => brands.find((b) => b.id === String(id || '').trim().toLowerCase()) || null;
export const brandByShop = (shop) => brands.find((b) => b.shop === String(shop || '').trim().toLowerCase()) || null;
// ---------- Practice mode ----------
// Switched per brand on the dashboard and saved with the brand's records (store.js applies the saved
// choice at start). A brand nobody has switched yet uses its DRY_RUN variable.
const practiceSwitch = new Map(); // brand id -> true (practice) / false (live)
export const forcedPractice = forceDryRun;
export function setPracticeSwitch(id, practice) { practiceSwitch.set(id, practice === true); }
export function isPractice(brand) {
  if (forceDryRun) return true;
  return practiceSwitch.has(brand.id) ? practiceSwitch.get(brand.id) : brand.envDryRun;
}
export const anyLive = () => brands.some((b) => !isPractice(b));

const current = new AsyncLocalStorage();

/** Runs fn for one brand. Everything it starts (awaits, timers) stays on that brand. */
export const withBrand = (brand, fn) => current.run(brand, fn);

/** The brand the running request or job is for. */
export function currentBrand() {
  const b = current.getStore();
  if (!b) throw new Error('Internal error: no brand selected for this request or job');
  return b;
}

/** Brands picked with --brand=id on the command line, or all of them. */
export function brandsFromArgs() {
  const want = arg('brand');
  if (!want) return brands;
  const b = findBrand(want);
  if (!b) throw new Error(`--brand=${want}: no such brand. Brands: ${brands.map((x) => x.id).join(', ')}`);
  return [b];
}

const BRAND_KEYS = new Set(['shop', 'accessToken', 'clientId', 'clientSecret', 'webhookSecret', 'tempEmailPattern', 'flits', 'dataDir']);

export const config = new Proxy(shared, {
  get(target, key) {
    // Read on every use, so a switch on the dashboard applies to the very next merge.
    if (key === 'dryRun') return isPractice(currentBrand());
    return BRAND_KEYS.has(key) ? currentBrand()[key] : target[key];
  },
  set() { throw new Error('config is read-only'); },
});

// With several brands, each log line from a brand's request or job starts with the brand's name.
if (brands.length > 1) {
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const b = current.getStore();
      if (b && typeof args[0] === 'string') args[0] = `[${b.name}] ${args[0]}`;
      else if (b) args.unshift(`[${b.name}]`);
      original(...args);
    };
  }
}
