# Shopify duplicate customer merge (by phone)

Every few minutes this tool checks recent orders. If an order's customer was just created and an
**older** customer already has the same phone number, it merges the new customer into the old one.
The order moves to the old customer, so your "points on delivery" Flow credits the right account.

## How it works: two stages

**Stage 1: merge, about 10 minutes after the order**

1. Skips orders newer than 10 minutes, so other apps finish with the new customer first.
2. Skips the order if its customer was not created around the time of the order.
3. Reads every phone on the order and normalizes it to `+91XXXXXXXXXX`.
4. Looks for an older customer whose phone matches exactly.
5. Asks Shopify for a merge preview. If Shopify confirms it will keep the **old** customer, it merges.
   The order then shows under the customer's real account straight away, so a customer who logs in with
   their mobile number sees it.
6. If the merge is blocked, or Shopify would keep the new customer, it copies the shipping address to
   the old customer instead and lists the order in `data/needs-attention.csv`.

**Stage 2: move Flits points, after delivery**

Each run also checks merged orders that are waiting for delivery. When an order is marked **Delivered**
in Shopify and 60 minutes have passed (`POINTS_DELAY_AFTER_DELIVERY_MINUTES`, which gives your delivery
Flow time to credit the points), it:

1. reads the duplicate account's Flits points balance,
2. subtracts anything it already moved from that duplicate before,
3. adds the rest to the old customer's email through the Flits Add Loyalty Points API.

Cancelled orders are closed without moving points. Orders not delivered within 30 days
(`POINTS_MAX_WAIT_DAYS`) are listed in `needs-attention.csv`.

Nothing changes while `DRY_RUN=true`.

**Stage 1 runs once a day at 11:00 am India time** (`AUTO_MERGE_TIME`, `HH:MM`; set it to empty to merge on every
check instead). It handles all new orders since the previous run in one go; if the service was down at that time, it
runs as soon as it's back that day, and never twice a day. Stage 2 (Flits points) still runs every
`POLL_INTERVAL_MINUTES`. The dashboard shows a countdown to the next run.

**Stage 1 is off by default.** Turn it on or off with the *Automatic merge after new orders* switch at the top
of the dashboard. The setting is saved on the Volume (`data/settings.json`), so it survives redeploys, and takes
effect on the next run without a redeploy. Only orders placed **after** it was last turned on are merged
automatically; orders placed earlier, or while it was off, are never merged automatically. Their duplicates show
up in the dashboard after a scan, for the team to review. Stage 2 (points after delivery) keeps running either way,
for merges that already happened.

## Deploy on Railway

On Railway, the automatic merger and the dashboard run together as **one service** with **one Volume**.
They must stay one service: a Railway Volume can only be attached to one service, and the tool's records
(points already moved, merges waiting for delivery, merge history, dismissed pairs) live on that Volume.
Railway also never runs two copies of a service that has a Volume, so nothing can be merged twice.

1. **Put the code in a private GitHub repository.** `.gitignore` already keeps `.env` and `data/` out
   of it. Never commit API keys.
2. **Create the service.** In Railway, choose *New → GitHub Repo* and pick the repository.
   `railway.json` sets the start command (`npm run railway`), the health check (`/health`) and
   restarts on failure.
3. **Attach a Volume** to this service with mount path **`/data`**. The tool finds it automatically.
   If the Volume is missing, the tool refuses to start in live mode, because without it the record of
   points already moved would be wiped on every redeploy.
4. **Add the variables** under the service's *Variables* tab, copying the names from `.env.example`:
   - `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`
   - `FLITS_ENABLED=true`, `FLITS_READ_API_KEY`, `FLITS_ADD_API_KEY`
   - `DASHBOARD_USERS`: one `name:password` per team member, comma separated, with long passwords
   - `DRY_RUN=true` for now

   Don't set `PORT` or `DATA_DIR`: Railway provides them.
5. **Create a public address.** Under *Settings → Networking*, choose *Generate Domain*. The dashboard is
   then at `https://<name>.up.railway.app`, with HTTPS included.
6. **Deploy and check the logs.** You should see `Data folder: /data` and
   `Dashboard: ... (practice mode, DRY_RUN=true)`.
7. **Try it in practice mode.** Scan the store in the dashboard, and check the automatic merger's log
   lines after a few new orders.
8. **Go live.** Change `DRY_RUN` to `false`. Railway redeploys automatically.

Notes:

- A redeploy causes a few seconds of downtime, because of the Volume. The automatic merger looks back
  48 hours, so it catches up on any orders placed meanwhile.
- After 10 wrong passwords, logins from that address are blocked for 15 minutes.
- On Railway, use the dashboard for past duplicates. The command-line cleanup isn't needed there.

## Setup

For running on your own computer or server instead of Railway. Requires **Node.js 22**. There are no
packages to install.

### 1. Create the Shopify app

Since 1 January 2026, new custom apps are created in the **Shopify Dev Dashboard** (dev.shopify.com/dashboard),
not in the store admin.

1. Create an app in the Dev Dashboard of the organization that owns the store.
2. Under Versions, set these Admin API scopes:
   `read_orders, read_customers, write_customers, read_customer_merge, write_customer_merge`
3. Request **protected customer data** access for name, email, phone and address. Without it, phone numbers come back empty.
4. Release the version and install the app on your store.
5. Copy the **Client ID** and **Client secret** from the app's Settings page.

If you already have an older custom app with an Admin API token, you can use `SHOPIFY_ACCESS_TOKEN` instead.
It needs the same scopes.

### 2. Configure

```bash
cp .env.example .env
# fill in SHOPIFY_SHOP and the credentials; leave DRY_RUN=true
```

### 3. Dry run and review

```bash
npm run dry
```

Open `data/actions.csv` and check each row in Shopify admin to confirm the duplicate and the old customer
really are the same person. To also check older orders, run once with a longer window:

```bash
node --env-file=.env src/run.js --once --dry-run --lookback-hours=720
```

(Without the `read_all_orders` scope, Shopify only returns the last 60 days of orders.)

### 4. Go live

Set `DRY_RUN=false` in `.env`, then run it continuously:

```bash
npm start                 # loops every POLL_INTERVAL_MINUTES
# or keep it running with pm2:
pm2 start "npm start" --name customer-merge
```

Or run it from cron instead of looping:

```
*/5 * * * * cd /path/to/customer-merge-tool && node --env-file=.env src/run.js --once >> data/run.log 2>&1
```

## Dashboard for past duplicates (`npm run dashboard`)

The dashboard is where your team reviews and merges duplicates that already exist. It runs on your
server alongside the tool, because it uses your Shopify and Flits keys, which must never be in a browser page.

```bash
# in .env: one login per person (names show in the merge history)
DASHBOARD_USERS=priya:a-long-password,rahul:another-long-password
npm run dashboard          # then open http://127.0.0.1:3000
```

**Scan store** loads every customer, finds duplicate accounts by phone number, checks each pair with
Shopify's merge preview and reads the Flits points to move. Pairs are rated:

| Risk | When | What the team can do |
|---|---|---|
| Low | Same first name, and the account kept logs in with this phone | Select and merge in bulk |
| Medium | Same first name, but last names differ, a name is missing, the duplicate has 5+ orders, or neither account logs in with this phone | Check, then select and merge in bulk |
| High | First names differ (often a gift or family delivery), or the duplicate matches several customers | One at a time, from a side-by-side review with a confirmation tick box |
| Blocked | Shopify refuses the merge, or would keep the duplicate instead | Not from the dashboard: a button opens the customer in Shopify admin |

These rules are enforced by the server too, not just hidden in the screen.

Other things the dashboard does:

- **Not the same person** removes a pair for good (restorable from the *Not duplicates* tab).
- The **Merged** tab shows every merge, with who did it, from where (dashboard, cleanup script or
  automatic), the risk level and the points moved.
- Each pair is checked with Shopify again right before merging, so a list that's out of date can't merge
  the wrong way.
- With `DRY_RUN=true` the dashboard runs in practice mode: merges are checked and simulated only. This is
  useful for training the team.

**Sharing with the team:** by default the dashboard only listens on the server itself (`127.0.0.1`). To
open it from other computers, put it behind HTTPS (for example Nginx or Caddy as a reverse proxy) and
restrict access to your office or VPN. Don't expose it over plain HTTP, because the logins would travel
unencrypted.

## One-time cleanup from the command line (`src/backfill.js`)

The same rules without a screen. It merges **low** risk pairs only (add `--include-medium` for medium);
high risk pairs are left for the dashboard.

```bash
npm run backfill:dry                   # plan with Shopify checks and Flits points; nothing changes
npm run backfill -- --limit=20         # with DRY_RUN=false: merge 20 low risk pairs, then check them
npm run backfill                       # all low risk pairs
npm run backfill -- --include-medium   # also medium risk pairs
```

## Comments in Shopify and Flits

Every merge and points transfer leaves a comment starting with *Customer merger tool:*:

| Where | Written when |
|---|---|
| Kept customer's note in Shopify (added after any existing text) | Every merge (automatic or dashboard) and every points result after delivery |
| Flits points entry | Whenever points are actually moved |

Orders themselves are not changed, so the app only needs `read_orders`.

## Files written in `data/`

| File | Contents |
|---|---|
| `actions.csv` | Every merge or address copy, done or planned (dry run) |
| `points.csv` | Every Flits points transfer after delivery (or why none was needed) |
| `needs-attention.csv` | Merges that were blocked, errors, Flits points to move manually |
| `merge-history.jsonl` | Every merge from the dashboard, cleanup script and automatic tool (shown in the Merged tab) |
| `dismissed.json` | Pairs marked "Not the same person" |
| `plan-latest.json` | The dashboard's last scan |
| `state.json` | Orders already handled, merges waiting for delivery, and points already moved per duplicate. **Keep this file**: it's what prevents points being moved twice. |

## Flits

The tool uses the two endpoints Flits support provided:

- **Get customer** (`GET /customer?shopify_customer_id=`) reads the duplicate's `loyalty_points_balance`.
- **Add loyalty points** (`POST /custom_action/...`, `credit_type: 1`) credits the old customer by email.

Points are moved only after the merge has succeeded and the order is delivered. The tool records how many
points it has moved from each duplicate, so running it again never moves the same points twice. Any
failure is written to `data/needs-attention.csv` with the exact number of points to fix by hand.

Put the two API keys in `.env` (`FLITS_READ_API_KEY`, `FLITS_ADD_API_KEY`). Never put them in the code.

Because the merge happens before delivery, your delivery Flow will usually credit the order's points to the
old customer directly. Stage 2 is the safety net for points that still land on the duplicate (for example
a sign-up bonus, or if Flits credits the customer from the time of the order).

## Known limits

- Flits has no "remove points" endpoint, so points are added to the old account but not removed from the
  duplicate. After the merge the duplicate's Shopify ID is gone, so those points can't be spent, but they may
  still show in Flits reports.
- The Flits add-points API works by email. If the old customer has no email in Shopify or Flits, the points are
  listed in `needs-attention.csv` instead.

- When the old customer has **no email** and the new one has one, Shopify always keeps the new customer, so
  the tool doesn't merge. These cases go to `needs-attention.csv`.
- An old customer is found only if the phone is saved as their **customer phone**. A phone that exists only on
  one of their addresses isn't searched.
- Family members who share one phone number will be merged into one account. Review the dry run with this in mind.
