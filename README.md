# Shopify duplicate customer merge (by phone)

When an order is created, Shopify notifies this tool (webhook). If the order's customer was just created and an
**older** customer already has the same phone number, it merges the new customer into the old one.
The order moves to the old customer, so your "points on delivery" Flow credits the right account.

## How it works: two stages

**Stage 1: merge, 10 minutes after the order**

1. Waits until the order is 10 minutes old, so other apps finish with the new customer first.
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

Nothing changes while the brand is in practice mode (see *Practice mode* below).

## Practice mode

Each brand is either in **practice mode** (merges are checked and simulated, nothing changes in Shopify or Flits) or
**live**. The banner at the top of the dashboard switches it for the brand that's selected: **Go live** asks for a tick
box confirmation; **Turn on practice mode** takes effect at once. The switch can't be used while a scan or merge is
running, it says who switched it and when, and it's saved with the brand's records on the Volume, so it survives
redeploys.

`DRY_RUN` (and `DOCKERS_DRY_RUN`) only set the **starting** mode of a brand nobody has switched yet, so new brands start
in practice mode. After the first switch, the dashboard decides. Command-line runs with `--dry-run` are always in
practice mode.

**When it runs.** The tool doesn't scan the store on a timer. On start it subscribes to Shopify's *order created*
webhook at `<PUBLIC_URL>/webhooks/orders-create` (on Railway the generated domain is used automatically). Each
webhook must carry Shopify's signature (made with the app's client secret); anything else is rejected. The order is
checked 10 minutes after it was placed (`MIN_ORDER_AGE_MINUTES`), so a customer who logs in with their mobile number
soon after ordering already sees the order in their real account.

Two safety nets cover a webhook that never arrives:

- **On start** (for example after a redeploy), orders from the last 48 hours (`LOOKBACK_HOURS`) that weren't
  handled yet are checked once.
- **Daily safety check at 11:00 am India time** (`DAILY_CHECK_TIME`, `HH:MM`; empty turns it off). Once a day the
  merger scans the last 72 hours (`DAILY_CHECK_LOOKBACK_HOURS`), merges any order that was missed, and re-checks
  orders where no duplicate was found the first time (no phone on the order yet, or no older customer with that
  phone yet). If the service was down at 11:00, it runs as soon as it's back that day, and never twice a day.

Stage 2 (Flits points) checks the merged orders waiting for delivery every `POLL_INTERVAL_MINUTES`; when no order is
waiting it makes no calls. The dashboard shows whether the webhook is connected, the orders waiting their 10
minutes, and a countdown to the daily safety check.

**Stage 1 is off by default.** Turn it on or off with the *Automatic merge after new orders* switch at the top
of the dashboard. The setting is saved on the Volume (`data/settings.json`), so it survives redeploys, and takes
effect on the next run without a redeploy. Only orders placed **after** it was last turned on are merged
automatically; orders placed earlier, or while it was off, are never merged automatically. Their duplicates show
up in the dashboard after a scan, for the team to review. Stage 2 (points after delivery) keeps running either way,
for merges that already happened.

## Several brands (Thomas Scott and Dockers)

One deployment serves every brand. The dashboard has a **brand dropdown** next to the title. Each brand has its
own Shopify store, Flits keys, practice/live mode, automatic merge switch, scan list, merge history and points
records. The brands share only the team's logins and the timing settings (`MIN_ORDER_AGE_MINUTES`,
`DAILY_CHECK_TIME`, ...).

- **Main brand (Thomas Scott)** uses the plain variables (`SHOPIFY_SHOP`, `FLITS_READ_API_KEY`, `DRY_RUN`, ...)
  and keeps its records at the top of the Volume, so an existing deployment keeps working unchanged. Set
  `BRAND_ID=thomasscott` and `BRAND_NAME=Thomas Scott` for the dropdown.
- **More brands** are listed in `EXTRA_BRANDS` and use the same variable names with their ID in front. For Dockers:

  | Variable | Value |
  |---|---|
  | `EXTRA_BRANDS` | `dockers` |
  | `DOCKERS_BRAND_NAME` | `Dockers` |
  | `DOCKERS_SHOPIFY_SHOP` | Dockers' `….myshopify.com` address |
  | `DOCKERS_SHOPIFY_CLIENT_ID`, `DOCKERS_SHOPIFY_CLIENT_SECRET` | From an app installed on the Dockers store (see Setup) |
  | `DOCKERS_DRY_RUN` | Starting mode: `true` (practice, the default). Go live later with the dashboard's switch |
  | `DOCKERS_TEMP_EMAIL_PATTERN` | Dockers' made-up email format, e.g. `^[0-9a-f]{32}@dockers\.in$`. Empty: no temporary emails |
  | `DOCKERS_FLITS_ENABLED`, `DOCKERS_FLITS_READ_API_KEY`, `DOCKERS_FLITS_ADD_API_KEY`, `DOCKERS_FLITS_ADD_POINTS_ACTION_ID` | Dockers' Flits keys and action ID, from Flits support |

  Nothing falls back to Thomas Scott's values, so a missing setting can never send a Dockers merge or points
  to the Thomas Scott store or Flits account. Dockers' records live in `/data/brands/dockers`.

Each brand's store sends new orders to the same webhook address. The tool tells the stores apart by their shop
domain and checks each signature with that brand's secret. Log lines start with the brand's name. The
command-line tools take `--brand=<id>` (for example `npm run backfill:dry -- --brand=dockers`), and the cleanup
script requires it when there are several brands.

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
8. **Go live.** Click **Go live** in the dashboard's banner, for each brand. No redeploy is needed.

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

Set `DRY_RUN=false` in `.env`, and set `PUBLIC_URL` to the HTTPS address where Shopify can reach the tool
(for example behind Nginx or Caddy). Then keep it running:

```bash
npm start                 # dashboard + webhook + automatic merger
# or keep it running with pm2:
pm2 start "npm start" --name customer-merge
```

`npm run once` runs a single catch-up scan of the last 48 hours and exits, without the webhook.

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

**Old accounts without a mobile number (the *No mobile number* tab).** Before mobile-number login, customers checked
out with Shopify's email login, so one person can have an old account with **no phone at all** and a newer account that
logs in with their mobile number. No phone links the two, so the same scan matches each such old account to a
mobile-number account on:

- the **same full name** (first and last name),
- the **same pincode** on a saved address,
- a **similar email**: the letters before the `@`, without dots, digits or the domain (`neel.joshi@thomasscott.in`
  and `neeljoshi12@gmail.com` both give `neeljoshi`). Temporary emails and generic ones like `support@` don't count,
- the **same city**, as weak support only.

| Risk | When |
|---|---|
| Medium (select and bulk merge) | Same name and same pincode, or same name and similar email |
| High (one at a time, side-by-side review) | Only name and city match, only the email is similar, the names differ, or the old account matches more than one customer |

A matching name alone isn't suggested, because common names would bring in strangers. Each old account gets one
suggestion: its best match. The mobile-number account is kept, so the customer keeps logging in with their mobile
number. Its temporary email is replaced by the old account's real email, and the old account's Flits points move to
it, as with other merges. These pairs are never low risk and the command-line cleanup never merges them.

**Choosing the account to keep.** By default the older account is kept. When merging one pair, the dialog lets the
team keep the **newer** account instead: the older account is then merged into it, its login phone is carried over
(so the customer still logs in with their mobile number), and its Flits points are moved to the newer account's
email. Shopify always keeps the account whose email is kept, so the kept account's email stays. If the newer account
isn't known to Flits yet, the points can't be added and are listed in `needs-attention.csv` to add by hand.

Other things the dashboard does:

- **Not the same person** removes a pair for good (restorable from the *Not duplicates* tab).
- The **Merged** tab shows every merge, with who did it, from where (dashboard, cleanup script or
  automatic), the risk level and the points moved.
- Each pair is checked with Shopify again right before merging, so a list that's out of date can't merge
  the wrong way.
- In practice mode (the banner's switch) merges are checked and simulated only. This is
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

## Temporary emails

Accounts created with only a mobile number get a made-up email such as
`3725de03e137a62f604cca5d3af7178f@thomasscott.in` (32 letters and digits; set by `TEMP_EMAIL_PATTERN`). Staff
emails like `name@thomasscott.in` don't match.

When the account kept has such an email and the duplicate has a real one, the real email goes on the kept account:

- **Automatic merges:** always, right after the merge.
- **Dashboard merges:** the merge dialog asks which email to keep (the duplicate's real email is selected; with
  several duplicates, each real email is an option, or keep the temporary one). For more than three kept accounts at
  once it's a single tick box.

The merge itself always keeps the **older** account (its customer ID, Flits points and phone login). Asking Shopify to
keep the duplicate's email during the merge would make it keep the duplicate's account instead, so the email is
changed with a separate update straight after the merge, and a line is added to the customer's note. Flits points
are always sent to the email Flits has for the kept account.

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
