# Commander Party on Azure: shareable party links, API, and database

This is the design and deployment guide for shareable party links. The [README](../README.md) has the feature overview and current status. Keep both up to date with every change.

Goal: a host clicks **Generate link**, gets `https://<site>/?party=<GUID>`, and shares it. Guests open the link, add their own name, experience level, and potluck dish, and can see the seating. Everything is stored in an Azure SQL database behind a small API, and the whole thing costs $0/month in normal use with hard stops before it can run up a bill.

## 1. The shape of it

```
Browser (host or guest)
   |  HTTPS, same origin
   v
Azure Static Web Apps (Free)  -- serves index.html, enforces auth + roles, adds noindex headers
   |  /api/*  (managed Azure Functions, Node.js, HTTP triggers only)
   v
Azure SQL Database (Free offer, auto-pause at limit)
```

Why this layout:

- **Static Web Apps (SWA) Free** hosts the page *and* the API on one origin, so the browser never deals with CORS, and the API is not reachable under a separate public hostname with its own keys. It deploys straight from this GitHub repo with a GitHub Action, like Pages does today.
- **SWA built-in auth** lets us say "anything under `/api/host/*` requires the `host` role" in a config file. SWA rejects the request before the function even runs. That is what keeps the API from being anonymous for every action that changes a party.
- **Azure SQL free offer** gives 100,000 vCore-seconds of compute and 32 GB per month, forever, with a setting that **auto-pauses the database for the rest of the month when the free amount is used up**. That is a true $0 ceiling for the database.
- **Managed Functions** inside SWA come with the Functions Consumption free grant (1M executions/month). A party site will not get near it.

### Security requirements and what enforces them

A browser app cannot hold a secret. Anything the page can send, someone with the browser dev tools or `curl` can send too. So the real guarantees are:

| Requirement | What enforces it |
|---|---|
| Only the API can touch the database | The SQL firewall allows only Azure services, plus the maintainer's IP for SSMS. The API uses a dedicated low-privilege SQL login that can only touch the app's tables. The connection string lives in SWA app settings (server side), never in the repo or the page. |
| Only the front end can call the API | Host endpoints require sign-in with the `host` role. Guest endpoints require a valid, unexpired party GUID, and are rate-limited and capped (below). The API sends no CORS headers, so other websites can't read its responses from a visitor's browser; that is a courtesy, not a security boundary. |
| Nobody can fill the database | Hard caps in the API: max players per party, max field lengths, a per-party join rate limit (step B), a per-host party cap (step C), and a weekly purge of long-expired parties (step F). Even if every cap failed, the SQL free offer auto-pauses instead of billing. |
| Spending stays under $50/month | A $50 Budget with alerts at 50 / 80 / 100%. **Budgets do not stop resources on pay-as-you-go**, so the ceiling really comes from: SWA Free (cannot bill), SQL auto-pause, and leaving the Functions free grant untouched. |
| Un-indexed | `X-Robots-Tag: noindex, nofollow` header on every response and `<meta name="robots">` in the page. `robots.txt` deliberately allows crawling, because Google only obeys noindex on pages it can fetch. Plus turn off the old GitHub Pages site. |

## 2. Data model

The host's organizer state (tables, rounds, seating, results, settings) is stored as the JSON snapshot the app already builds. The things guests touch live in a real table, so guests can never reach the seating.

The schema is in [db/001_schema.sql](../db/001_schema.sql), which is the source of truth. In short:

| Table | Holds |
|---|---|
| `Parties` | One row per party. Its `Id` is the GUID in the share link. Also the host's user id, the party name, the host's saved state as JSON (64 KB max), and `ExpiresAt`. |
| `Players` | One row per guest: name, experience, dish, optional partner, and a private `EditToken` that lets a guest edit only their own row. |
| `JoinAttempts` | Recent join attempts per party, keyed by a salted SHA-256 of the visitor's IP, for rate limiting. Raw IPs are never stored. |

Limits, enforced in the API and as CHECK constraints where possible. The values live in [api/src/lib/limits.js](../api/src/lib/limits.js).

| Limit | Value |
|---|---|
| Players per party | 40 |
| Parties per host | 20; at the cap, the host's expired parties are deleted to make room |
| Joins per party per IP per 10 minutes | 5 |
| Request body size | 16 KB (StateJson up to 64 KB for host saves) |
| Party lifetime | 60 days from creation, then the link shows the expired page |

The existing player `id` values are strings like `p_173...`. Switching to GUIDs is fine because `normalizeState` already coerces ids with `String(...)`.

## 3. API (Node.js Azure Functions under `api/`)

All responses JSON. `{guid}` is the party id.

| Method, route | Who | What | Status |
|---|---|---|---|
| `POST /api/host/parties` | host | Create a party from the organizer's current event and roster. Players get new GUIDs; the seating is rewritten to match and the old-to-new `idMap` is returned with the party. | Built (C) |
| `GET /api/host/parties/{guid}` | host | Full party for its owner: saved state plus the roster, including who the host added. Never edit tokens. | Built (C) |
| `PUT /api/host/parties/{guid}` | host | Autosave the event state and optionally the name. Does not touch players. | Built (C) |
| `DELETE /api/host/parties/{guid}` | host | Delete a party and its players. | Built (C) |
| `GET /api/host/parties` | host | List the host's parties for a "my parties" picker, with player counts and expiry. | Built (C) |
| `POST /api/host/parties/{guid}/players` | host | Host adds a player. | Built (C) |
| `PUT /api/host/parties/{guid}/players/{id}` | host | Host edits any player. `partnerId` locks a pair (both sides updated), `null` unlocks it, leaving it out keeps it. | Built (C) |
| `DELETE /api/host/parties/{guid}/players/{id}` | host | Host removes a player and unlocks their partner. | Built (C) |
| `GET /api/parties/{guid}` | anyone with the link | Public view: party name, players (no edit tokens), current round seating, potluck list, `expiresAt`. 404 if unknown, 410 if expired. | Built (B) |
| `POST /api/parties/{guid}/players` | anyone with the link | Guest joins. Returns the player plus their `editToken`. | Built (B) |
| `PUT /api/parties/{guid}/players/{id}` | guest with matching `editToken` | Guest edits their own entry. | Built (B) |
| `POST /api/maintenance/purge` | GitHub Actions schedule, `x-purge-secret` header | Delete parties more than 30 days past `ExpiresAt` (players go with them) and join-rate-limit records older than an hour or for deleted parties. Returns the counts. A wrong or missing secret gets the same 404 as an unknown route, before the database is touched, and a `PURGE_SECRET` shorter than 16 characters turns the route off. Not under `/api/admin` because Azure Functions reserves routes starting with `admin`. Managed Functions only allow HTTP triggers, so the schedule lives in a GitHub workflow. | Built (F) |

Each function validates and trims input, rejects unknown fields, checks the caps above, and talks to SQL through parameterised queries (`mssql` package). Host identity comes from the `x-ms-client-principal` header SWA injects, never from the body.

[staticwebapp.config.json](../staticwebapp.config.json) at the repo root does the gatekeeping. It allows only the `host` role on `/api/host/*`, offers GitHub as the only sign-in provider, pins the API to Node 22, and adds `X-Robots-Tag: noindex` plus basic security headers to every response.

Because the app location is the repo root, Azure uploads every file in the repo as static content. The config therefore works as an allow-list: it serves only `/`, `/index.html`, `/robots.txt`, `/api/*`, and `/.auth/*`, and returns 404 for everything else, including the docs, SQL scripts, workflows, and API source. **Any new file the site needs to serve must be added to the allow-list.**

Azure ignores the `/.auth/login/*` wildcard for its built-in sign-in providers, so Microsoft (`aad`) and X (`twitter`) sign-in are each blocked by name. Only GitHub sign-in is open, and only the invited GitHub account gets the `host` role.

API 401s are returned as-is, not redirected, so `fetch` gets a clean status and the front end sends the host to `/.auth/login/github` itself.

Only the maintainer gets the `host` role: in the portal, SWA > Role management > Invite, GitHub provider, your username, role `host`. Nobody else can ever reach `/api/host/*` even if they sign in with GitHub.

## 4. Front end changes (`index.html`)

1. **Party mode detection** (done in step D). On load, read `?party=<guid>`. No param: today's localStorage behaviour, unchanged. With a param, the organizer never loads or saves anything in that browser; the page calls `GET /api/parties/{guid}` instead. A malformed id shows "couldn't find that party" without calling the API, 404 shows the same, and 410 shows the expired page. The screen wake lock and chime unlock are off in party mode so guests' phones behave normally.
2. **Host vs guest** (done in step E). Call `/.auth/me`. If the user has the `host` role and `GET /api/host/parties/{guid}` returns the party unexpired, show the full organizer in cloud mode. Otherwise show the **guest view**. Adding `&view=guest` to the link forces the guest view, which the Share panel uses for "Preview as a guest".
3. **Guest view** (done in step D). Party name and expiry, a join form (name, experience, dish), the roster, the potluck list, and the current round's seating, read-only. The guest's own seat and pod are highlighted. After joining, the edit token is kept in localStorage under `commander_party_guest_entries_v1`, so the guest sees "Edit my entry" on return. If the host removed them, the token is dropped and the join form comes back with a notice. No Hat Draw, timer, results, export, or reset. Every name and dish is HTML-escaped.
4. **Generate link** (done in step E). A tab peeks out of the left edge and slides out when you hover the top-left corner; hovering opens the Share panel as a peek, without dimming the page, and it closes when the pointer moves away. Clicking or tapping the tab, or pressing anywhere inside a peeked panel, pins it open and dims the page behind it; the X, Escape, or a click on the dimmed area closes it. The panel's IDs and classes deliberately avoid the word "share" (`linkDrawer`, `drawer-tab`, `partyLinkBtn`): ad and social blockers hide elements named like share widgets. AdGuard's Social Media list hides any `.share-panel`, and Fanboy's Social list hides `#shareBtn` and `#shareTab`. With such a blocker on, the page dimmed but the panel never appeared. Keep new UI names neutral too. A **Share link** button under the autosave badge opens the same panel on tablets and phones. Signed out, the panel offers GitHub sign-in. Signed in as host, it offers a party name and **Generate link**, which creates the party from the event on screen and switches the URL to `?party=...`. With a party open, it shows the guest link with **Copy** (and the phone's share sheet where available), the expiry date, the save status, "Preview as a guest", "My saved event", **Delete this party**, and a list of the host's parties.
5. **Live roster.** While a party is open, poll `GET /api/parties/{guid}`. New guest players are merged into `players` with `tableId: null` so they appear as unseated; the host seats them as usual. Every poll wakes the free-tier database, and a database that never sleeps burns the monthly free compute. So polling runs every 45 s only while the tab is visible, pauses after 20 minutes without a tap or key press, and resumes on the next one. The guest page and the host organizer both work this way. Neither redraws while someone is typing, and the host page also waits while a dialog is open or a player is being dragged. On the host page, a poll that finds a newer save from another device takes that device's event as well as the roster; otherwise it only merges roster changes. New guests trigger a "<name> joined the party" notice.
6. **Expired page** (done in step D). Full-page card: "This party has ended. This link expired on <date>", with a link to the plain organizer. Loading, "waking up the party server", not-found, and connection-error states use the same card.
7. **Save indicator** (done in step E). In cloud mode the badge shows "Saving...", "Saved to cloud", "Not saved yet, retrying...", "Sign in again to save", or that the party expired or was deleted. Changes save 1.2 s after the last edit. A failed save retries after 5, 10, 20, then every 30 seconds, and leaving the page with unsaved changes asks for confirmation. There is no offline copy in the browser: cloud-mode changes are kept in the open page until a save succeeds.
8. **noindex meta** in `<head>` (done in step A).
9. **Sign-in handling** (done in step E). The Share panel links to `/.auth/login/github?post_login_redirect_uri=<current URL>`. A 401 or 403 while saving shows "Sign in again to save" instead of redirecting, so unsaved changes on screen aren't lost.
10. **Cloud mode limits** (step E). Roster changes (add, edit including locked pairs, remove) call the host player routes and redraw from the roster the API returns. Import and Clear All Data are turned off in cloud mode, because they act on the event saved in this browser. The round timer stays per device.

## 5. Repo layout after the change

```
/
+-- README.md                   (overview and status; keep current)
+-- .gitignore
+-- index.html                  (front end, unchanged location)
+-- robots.txt
+-- staticwebapp.config.json
+-- api/                        (Azure Functions, Node 22)
|   +-- host.json
|   +-- package.json
|   +-- src/functions/*.js      (one file per route group)
|   +-- src/lib/db.js, http.js, validate.js, limits.js, partyView.js, auth.js, hostState.js
|   +-- test/                   (node:test unit tests, `npm test`)
+-- db/
|   +-- 001_schema.sql
|   +-- 002_app_login.sql       (creates the low-privilege login + grants)
+-- docs/azure-plan.md          (this file)
+-- .github/workflows/
    +-- azure-static-web-apps-*.yml (added by Azure when the repo is linked)
    +-- purge-expired.yml           (weekly schedule calling /api/maintenance/purge)
```

## 6. Azure setup, step by step (portal work, done alongside the code)

**Phase 0: account and guard rails** (about 30 min)
1. Create the Azure free account. It starts with 30 days of credit and a spending limit *on*. When the 30 days end, it converts to pay-as-you-go and that hard limit goes away, so the free-tier choices below are what protect you after that.
2. Cost Management > Budgets > Add: $50/month, alerts at 50%, 80%, 100% to your email.
3. Create a resource group, e.g. `rg-commander-party`. Pick a nearby region. New subscriptions are sometimes blocked from busy regions such as East US and East US 2; Central US worked for this project. Use the same region for the SQL server and the Static Web App's Functions.

**Phase 1: database** (about 30 min)
4. Create SQL server: `sql-commander-party-<something>`, authentication "Use SQL authentication" with a strong admin password (save it in a password manager; it is only for SSMS). Networking: public endpoint, **Allow Azure services and resources to access this server = Yes**, and add your current client IP.
5. Create database `commanderparty`: on the Basics page click **Apply free offer**, then set **Behavior when free limit reached = Auto-pause the database until next month**. Leave the rest default (General Purpose serverless, 32 GB).
6. Connect in SSMS with the server's full name (`...database.windows.net`), authentication "SQL Server Authentication", and in Options > Connection Properties set the database to `commanderparty`. Run `db/001_schema.sql`. Then open `db/002_app_login.sql`, replace the placeholder password locally (do not save it back to the repo), and run it. It creates a contained user `commander_api` with only SELECT / INSERT / UPDATE / DELETE on the three tables.
7. Copy the ADO.NET connection string from the portal, set `User ID=commander_api` and its password. Keep it out of the repo.

**Phase 2: static web app** (about 20 min)
8. Create Static Web App: plan **Free**, source GitHub, this repo, branch `main`, build preset Custom, app location `/`, api location `api`, output location `.`. Azure commits the workflow file to the repo, so run `git pull --rebase` before your next push. The first Actions run may fail or deploy without the API until `api/` is on `main`.
9. SWA > Settings > Environment variables: add `SQL_CONNECTION_STRING`, `IP_HASH_SALT` (a long random string, used to hash guest IPs for rate limiting), and `PURGE_SECRET` (another long random string).
10. SWA > Role management > Invite: provider GitHub, your GitHub username, role `host`, expiry max. Accept the invite link.
11. Note the new URL (`https://<name>.azurestaticapps.net`). Optionally add a custom domain (free on SWA). This project uses https://commanderparty.com: the domain is registered at Cloudflare with DNS-only CNAME records for the apex (flattened) and `www`, both pointing at the `azurestaticapps.net` hostname, and Azure issues the certificates. In the Static Web App's Custom domains page, set it as the default domain so the `www` and `azurestaticapps.net` addresses redirect to it with a 301, keeping the `?party=` query string. Share links use whatever address the organizer is open on, so open it at the custom domain before generating links.
12. In GitHub repo Settings > Secrets and variables > Actions, add `PURGE_SECRET` with the same value, for the weekly cleanup workflow.

**Phase 3: retire GitHub Pages** (done)
13. Repo Settings > Pages > disable, or leave a tiny redirect page with noindex. Either way the old GitHub Pages URL should stop serving the organizer so there is one home, indexed nowhere.

## 7. Build order (code)

| Step | Deliverable | Verifies with |
|---|---|---|
| A (done) | `db/*.sql`, `staticwebapp.config.json`, `robots.txt`, noindex meta | Run SQL in SSMS; `curl -I` shows `X-Robots-Tag` |
| B (done) | `api/` scaffold + `GET /api/parties/{guid}` + `POST .../players` + guest `PUT .../players/{id}` with validation and caps | `npm test` in `api/` (fake DB); the SQL batches were also run against a local SQL Server 2025 scratch database |
| C (done) | Host routes + role enforcement | `npm test` (fake DB, including 401/403 on every host route); host SQL run against a local SQL Server scratch database; live `/api/host/parties` returns 401 signed out |
| D (done) | Front end: party-mode load, guest view, join form, expired page | Tested in a browser against a stand-in API that mimics the real responses, including a sleeping database (503, then a gateway timeout) and a host removing the guest. Checked at phone width. |
| E (done) | Generate-link slide-out, cloud autosave, roster polling | Tested in a browser with the real API handlers against a local SQL Server scratch database, behind a stand-in for Azure's sign-in and routing: sign in, generate (seats carried over), autosave, a guest joining and appearing, host add/edit/pair/remove, reload as host, guest preview, a non-host account getting the guest page, a save from another device, a failed save recovering, and deleting the party |
| F (done) | Purge workflow, rate-limit table, budget alert test | Unit tests for the secret check; the purge SQL run against a local SQL Server scratch database (deletes only parties 30+ days past expiry, their players, and stale rate-limit rows; a second run deletes nothing). Live on commanderparty.com: 413 for a 20 KB body, 415 for the wrong content type, 400 for broken JSON, an empty or 41-character name, an unknown field, or a bad experience level, 404 for a malformed party id, and 401 for host routes signed out or with a forged identity header. The per-IP join limit and 40-player cap were verified against SQL Server in steps B and C; checking them live needs a real party link. |

### Cleanup and cost notes (from step F)

- The cleanup job (`.github/workflows/purge-expired.yml`) runs Sundays at 09:17 UTC and can be started by hand from the Actions tab with **Run workflow**. It retries server errors five times, 30 seconds apart, to ride out a sleeping database, and fails loudly if the secret is missing or refused.
- It runs weekly rather than nightly because every call wakes the free-tier database, and a woken database stays on until its auto-pause delay passes, using free compute the whole time. Waking it once a day could use a large share of the monthly allowance; once a week barely registers.
- Expired parties stay readable as "this party has ended" for 30 days before the purge removes them. A host at the 20-party cap also clears their own expired parties when creating a new one.
- Budget alerts can't be tested from code. In the portal, Cost Management > Budgets should show the $50 budget with alerts at 50, 80, and 100%.

Local dev: the SWA CLI emulates auth (`/.auth/me` with a fake host user) and routes, so the whole flow runs on `http://localhost:4280` before anything is deployed.

```bash
npm install -g @azure/static-web-apps-cli azure-functions-core-tools@4
```

Copy `api/local.settings.example.json` to `api/local.settings.json` (git-ignored), fill in the connection string, then run `swa start . --api-location api` from the repo root. The local SQL Server Developer instance works as a stand-in database if SQL authentication is enabled on it.

On Node 24, the SWA CLI refuses to start the API itself. Run the Functions host and the emulator separately instead:

```bash
cd api && func start --port 7071
```

```bash
swa start . --api-devserver-url http://localhost:7071
```

### API behaviour notes (from step B)

- Requests with a malformed GUID or invalid body are rejected **before** connecting to SQL, so junk traffic never wakes a paused database.
- A paused or resuming database returns `503` with `Retry-After: 30`; the front end should show "waking up, retrying" and retry.
- A cold start can take longer than the roughly 45 seconds Static Web Apps waits for the API. Azure then answers `500` with the plain-text body `Backend call failure`, before the API can reply. This was seen on the first live request after deploying. The guest page retries reads on both, waiting 4, 10, 20, then 30 seconds. Writes retry only on `503`: after a gateway timeout the write may already have gone through, so the page asks the guest to refresh and check instead of joining twice.
- Join outcomes: `201` joined, `400` bad input, `404` unknown link, `409` party full or duplicate name (case-insensitive), `410` expired, `413` body too large, `415` not JSON, `429` rate-limited.
- Guests cannot set partners. Locked pairs are a host action.

### Host API behaviour notes (from step C)

- Every host route checks the `host` role in code as well as in the routing config, and every query is scoped to the signed-in host's user id. Another account gets 404 for a party it doesn't own.
- Players and the event state are saved separately. Autosave (`PUT /api/host/parties/{guid}`) only replaces the state; roster changes go through the player routes one at a time. A whole-roster save could delete a guest who joined a moment before the save landed.
- The saved state is cleaned on the server to a fixed shape: event settings, tables, per-round seating, per-round life totals, and the current round. Unknown fields are dropped, numbers are clamped, and over-size input is refused.
- Expired parties are read-only: saves and roster changes return `410`.
- Two devices autosaving the same party: the last save wins. That's fine for one host; revisit if parties ever get co-hosts.
- `npm audit` reports a high-severity advisory in `@azure/msal-node`, pulled in by `mssql` > `tedious` > `@azure/identity`. It affects the Entra ID authorization-code flow, which this API never uses (it signs in with a SQL password), and no compatible fix is published yet. Re-run `npm audit` before deploying.

## 8. Costs, worst case

| Resource | Plan | Normal cost | Worst case |
|---|---|---|---|
| Static Web Apps | Free | $0 | Cannot bill. Site stops serving if the 100 GB/mo bandwidth quota is hit. |
| Managed Functions | Consumption free grant | $0 | Only billable past 1M executions/mo; the caps make that unreachable. |
| Azure SQL | Free offer, auto-pause | $0 | Database pauses until next month. $0. |
| Budget | $50 alert | $0 | Email only, no enforcement. |

Sources: [Azure SQL free offer](https://learn.microsoft.com/en-us/azure/azure-sql/database/free-offer), [Static Web Apps plans](https://learn.microsoft.com/en-us/azure/static-web-apps/plans), [Static Web Apps pricing](https://azure.microsoft.com/en-us/pricing/details/app-service/static/), [Azure spending limit](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit).
