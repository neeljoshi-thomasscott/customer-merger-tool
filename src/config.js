// Reads settings from environment variables (.env) and command-line flags.

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

const shop = (process.env.SHOPIFY_SHOP || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
if (!shop) throw new Error('SHOPIFY_SHOP is required, e.g. your-store.myshopify.com');

const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || '';
const clientId = process.env.SHOPIFY_CLIENT_ID || '';
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';
if (!accessToken && !(clientId && clientSecret)) {
  throw new Error('Set SHOPIFY_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
}

export const config = {
  shop,
  accessToken,
  clientId,
  clientSecret,
  apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',

  // Safety: nothing is changed unless DRY_RUN=false and --dry-run is not passed.
  dryRun: process.argv.includes('--dry-run') || bool(process.env.DRY_RUN, true),

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

  // Flits points (stage 2) are checked this often.
  pollIntervalMinutes: num(process.env.POLL_INTERVAL_MINUTES, 5),

  // New orders are checked for duplicates this often, so a customer is merged about
  // MIN_ORDER_AGE_MINUTES after ordering (plus up to this many minutes).
  mergeCheckMinutes: num(process.env.MERGE_CHECK_MINUTES, 1),

  // Daily safety check (India time, HH:MM): once a day the merger looks back further and re-checks
  // orders where no duplicate was found the first time. Empty = no daily check.
  dailyCheckTime: String(process.env.DAILY_CHECK_TIME ?? process.env.AUTO_MERGE_TIME ?? '11:00').trim(),
  dailyCheckLookbackHours: num(process.env.DAILY_CHECK_LOOKBACK_HOURS, 72),

  // Testing: when set (comma separated), the automatic merger only acts on orders with one of these
  // phone numbers and skips every other order. Leave empty for normal use.
  autoMergeOnlyPhones: String(process.env.AUTO_MERGE_ONLY_PHONES || '').split(',').map((p) => p.trim()).filter(Boolean),

  // On Railway, the attached Volume's mount path is used automatically.
  dataDir: process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './data',
  onRailway: Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID),
  hasRailwayVolume: Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH),

  // Stage 2: move Flits points this many minutes after the order is marked Delivered
  // (gives your delivery Flow time to credit the points first).
  pointsDelayAfterDeliveryMinutes: num(process.env.POINTS_DELAY_AFTER_DELIVERY_MINUTES, 60),
  // Stop waiting for delivery after this many days and report the order instead.
  pointsMaxWaitDays: num(process.env.POINTS_MAX_WAIT_DAYS, 30),

  flits: {
    enabled: bool(process.env.FLITS_ENABLED, false),
    baseUrl: (process.env.FLITS_BASE_URL || 'https://l7dwmnkv4xwd2wytgus6eajvbq0xtkli.lambda-url.us-east-2.on.aws').replace(/\/+$/, ''),
    readApiKey: process.env.FLITS_READ_API_KEY || '',
    addApiKey: process.env.FLITS_ADD_API_KEY || '',
    addPointsActionId: process.env.FLITS_ADD_POINTS_ACTION_ID || 'Ns3x94kSXoZvgqDLLW11Kw',
    integrationAppName: process.env.FLITS_INTEGRATION_APP_NAME || 'flits-kwikpass',
    // Move the duplicate account's points balance to the old (permanent) account after merging.
    movePointsToOldCustomer: bool(process.env.FLITS_MOVE_POINTS_TO_OLD_CUSTOMER, true),
  },
};

if (config.flits.enabled && (!config.flits.readApiKey || !config.flits.addApiKey)) {
  throw new Error('FLITS_ENABLED=true needs FLITS_READ_API_KEY and FLITS_ADD_API_KEY in .env');
}
