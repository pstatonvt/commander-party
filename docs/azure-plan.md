# Commander Party on Azure: shareable party links, API, and database

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
- **SWA built-in auth** lets us say "anything under `/api/host/*` requires the `host` role" in a config file. SWA rejects the request before the function even runs. That is what makes the API non-anonymous for every action that matters (Luke's point 3).
- **Azure SQL free offer** gives 100,000 vCore-seconds of compute and 32 GB per month, forever, with a setting that **auto-pauses the database for the rest of the month when the free amount is used up**. That is a true $0 ceiling for the database.
- **Managed Functions** inside SWA come with the Functions Consumption free grant (1M executions/month). A party site will not get near it.

### Honest limits of "only my front end can call my API"

A browser app cannot hold a secret. Anything the page can send, someone with the browser dev tools or `curl` can send too. So the real guarantees are:

| Luke's ask | What actually enforces it |
|---|---|
| Only my API can touch the database | SQL firewall allows only Azure services + your home IP for SSMS. The API uses a dedicated low-privilege SQL login that can only touch the app's tables. The connection string lives in SWA app settings (server side), never in the repo or the page. |
| Only my front end can call the API | Host endpoints require you to be signed in with the `host` role. Guest endpoints require a valid, unexpired party GUID, and are rate-limited and capped (below). CORS is locked to the site origin as a courtesy, not as security. |
| Nobody can fill my database | Hard caps in the API: max players per party, max parties per host, max field lengths, per-party join rate limit, nightly purge of expired parties. Even if every cap failed, the SQL free offer auto-pauses instead of billing. |
| $50 cap | A $50 Budget with alerts at 50 / 80 / 100%. **Budgets do not stop resources on pay-as-you-go**, so the ceiling really comes from: SWA Free (cannot bill), SQL auto-pause, and leaving the Functions free grant untouched. |
| Un-indexed | `X-Robots-Tag: noindex, nofollow` header on every response and `<meta name="robots">` in the page. `robots.txt` deliberately allows crawling, because Google only obeys noindex on pages it can fetch. Plus turn off the old GitHub Pages site. |

## 2. Data model

Keep the host's organizer state (tables, rounds, seating, results, settings) as the JSON snapshot the app already builds. Put the things guests touch in a real table so guests can never reach the seating.

```sql
CREATE TABLE dbo.Parties (
    Id            UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),  -- the GUID in the link
    HostUserId    NVARCHAR(128)    NOT NULL,   -- SWA userId of the signed-in host
    Name          NVARCHAR(80)     NOT NULL,
    StateJson     NVARCHAR(MAX)    NOT NULL,   -- host-only: event, tables, rounds, results, currentRound
    CreatedAt     DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt     DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    ExpiresAt     DATETIME2        NOT NULL,   -- CreatedAt + 60 days
    JoinCount     INT              NOT NULL DEFAULT 0
);

CREATE TABLE dbo.Players (
    Id            UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    PartyId       UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Parties(Id) ON DELETE CASCADE,
    Name          NVARCHAR(40)     NOT NULL,
    Experience    VARCHAR(10)      NOT NULL CHECK (Experience IN ('New','Learning','Veteran')),
    Dish          NVARCHAR(80)     NOT NULL DEFAULT '',
    PartnerId     UNIQUEIDENTIFIER NULL,
    EditToken     UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),  -- lets a guest edit only their own row
    AddedByHost   BIT              NOT NULL DEFAULT 0,
    CreatedAt     DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt     DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_Players_Party ON dbo.Players(PartyId);
CREATE INDEX IX_Parties_Expires ON dbo.Parties(ExpiresAt);

CREATE TABLE dbo.JoinAttempts (   -- rate limiting that survives function restarts
    PartyId     UNIQUEIDENTIFIER NOT NULL,
    IpHash      CHAR(64)         NOT NULL,       -- SHA-256 of client IP, no raw IPs stored
    AttemptedAt DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);
```

Limits enforced in the API (and as CHECK constraints where possible):

| Limit | Value |
|---|---|
| Players per party | 40 |
| Parties per host | 20 (oldest expired ones purged first) |
| Joins per party per IP per 10 minutes | 5 |
| Request body size | 16 KB (StateJson up to 64 KB for host saves) |
| Party lifetime | 60 days from creation, then the link shows the expired page |

The existing player `id` values are strings like `p_173...`. Switching to GUIDs is fine because `normalizeState` already coerces ids with `String(...)`.

## 3. API (Node.js Azure Functions under `api/`)

All responses JSON. `{guid}` is the party id.

| Method, route | Who | What |
|---|---|---|
| `POST /api/host/parties` | host | Create party from the current local snapshot. Returns `{ id, expiresAt }`. |
| `PUT /api/host/parties/{guid}` | host | Save StateJson (debounced autosave, replaces the localStorage save when a party is open). |
| `DELETE /api/host/parties/{guid}` | host | End a party early. |
| `GET /api/host/parties` | host | List my parties (for a small "my parties" picker). |
| `PUT /api/host/parties/{guid}/players/{id}`, `DELETE ...` | host | Host edits or removes any player. |
| `GET /api/parties/{guid}` | anyone with the link | Public view: party name, players (no edit tokens), current round seating, potluck list, `expiresAt`. 404 if unknown, 410 if expired. |
| `POST /api/parties/{guid}/players` | anyone with the link | Guest joins. Returns the player plus their `editToken`. |
| `PUT /api/parties/{guid}/players/{id}` | guest with matching `editToken` | Guest edits their own entry. |
| `POST /api/admin/purge` | GitHub Actions cron, secret header | Delete parties past `ExpiresAt` + 30 days. (Managed Functions only allow HTTP triggers, so the schedule lives in a GitHub workflow.) |

Each function validates and trims input, rejects unknown fields, checks the caps above, and talks to SQL through parameterised queries (`mssql` package). Host identity comes from the `x-ms-client-principal` header SWA injects, never from the body.

`staticwebapp.config.json` at the repo root does the gatekeeping:

```json
{
  "routes": [
    { "route": "/api/host/*",  "allowedRoles": ["host"] },
    { "route": "/api/*",       "allowedRoles": ["anonymous"] },
    { "route": "/.auth/login/github", "allowedRoles": ["anonymous"] },
    { "route": "/.auth/login/*", "statusCode": 404 }
  ],
  "globalHeaders": {
    "X-Robots-Tag": "noindex, nofollow, noarchive"
  }
}
```

API 401s are returned as-is, not redirected, so `fetch` gets a clean status and the front end sends the host to `/.auth/login/github` itself.

Only you get the `host` role: in the portal, SWA > Role management > Invite, GitHub provider, your username, role `host`. Nobody else can ever reach `/api/host/*` even if they sign in with GitHub.

## 4. Front end changes (`index.html`)

1. **Party mode detection.** On load, read `?party=<guid>`. No param: today's localStorage behaviour, unchanged. With a param: call `GET /api/parties/{guid}`. 404 shows "no such party", 410 shows the expired page.
2. **Host vs guest.** Call `/.auth/me`. If the user has the `host` role and owns the party, show the full organizer with cloud autosave (debounced `PUT`). Otherwise show the **guest view**.
3. **Guest view.** Party name, a join form (name, experience, dish, optional "I'm coming with" partner), the roster, the potluck summary, and the current round's seating read-only. After joining, the edit token is kept in localStorage so the guest sees "Edit my entry" on return. No Hat Draw, timer, results, export, or reset.
4. **Generate link.** A slide-out tab on the left edge (hover or tap) with: **Generate link** (host only; creates the party from the current state, switches the URL to `?party=...`), **Copy link**, the expiry date, and **My parties**. Also a small "Share link" button under the autosave badge so it is discoverable on tablets where hover does not exist.
5. **Live roster.** While a party is open, poll `GET /api/parties/{guid}` every 15 s (only when the tab is visible). New guest players are merged into `players` with `tableId: null` so they appear as unseated; the host seats them as usual.
6. **Expired page.** Simple full-page card: "This party link expired on <date>", with a link to the plain organizer.
7. **Save indicator.** The existing badge gains states: "Saved to cloud", "Saving...", "Offline, saved locally" (keeps writing to localStorage as a fallback and retries).
8. **noindex meta** in `<head>` (done in step A).
9. **Sign-in handling.** A 401 from `/api/host/*` sends the host to `/.auth/login/github?post_login_redirect_uri=<current URL>`.

## 5. Repo layout after the change

```
/
+-- index.html                  (front end, unchanged location)
+-- robots.txt
+-- staticwebapp.config.json
+-- api/                        (Azure Functions, Node 20)
|   +-- host.json
|   +-- package.json
|   +-- src/functions/*.js      (one file per route group)
|   +-- src/lib/db.js, auth.js, validate.js, limits.js
+-- db/
|   +-- 001_schema.sql
|   +-- 002_app_login.sql       (creates the low-privilege login + grants)
+-- docs/azure-plan.md          (this file)
+-- .github/workflows/
    +-- azure-static-web-apps.yml   (added by SWA when you link the repo)
    +-- purge-expired.yml           (nightly cron calling /api/admin/purge)
```

## 6. Azure setup, step by step (you do these in the portal, the code side is built alongside)

**Phase 0: account and guard rails** (about 30 min)
1. Create the Azure free account. It starts with 30 days of credit and a spending limit *on*. When the 30 days end, it converts to pay-as-you-go and that hard limit goes away, so the free-tier choices below are what protect you after that.
2. Cost Management > Budgets > Add: $50/month, alerts at 50%, 80%, 100% to your email.
3. Create a resource group, e.g. `rg-commander-party`, region `East US 2`.

**Phase 1: database** (about 30 min)
4. Create SQL server: `sql-commander-party-<something>`, authentication "Use SQL authentication" with a strong admin password (save it in a password manager; it is only for SSMS). Networking: public endpoint, **Allow Azure services and resources to access this server = Yes**, and add your current client IP.
5. Create database `commanderparty`: on the Basics page click **Apply free offer**, then set **Behavior when free limit reached = Auto-pause the database until next month**. Leave the rest default (General Purpose serverless, 32 GB).
6. Connect in SSMS with the server's full name (`...database.windows.net`), authentication "SQL Server Authentication", and in Options > Connection Properties set the database to `commanderparty`. Run `db/001_schema.sql`. Then open `db/002_app_login.sql`, replace the placeholder password locally (do not save it back to the repo), and run it. It creates a contained user `commander_api` with only SELECT / INSERT / UPDATE / DELETE on the three tables.
7. Copy the ADO.NET connection string from the portal, set `User ID=commander_api` and its password. Keep it out of the repo.

**Phase 2: static web app** (about 20 min)
8. Create Static Web App: plan **Free**, source GitHub, this repo, branch `main`, build preset Custom, app location `/`, api location `api`, output location empty. Azure commits the workflow file to the repo.
9. SWA > Settings > Environment variables: add `SQL_CONNECTION_STRING` and `PURGE_SECRET` (a long random string).
10. SWA > Role management > Invite: provider GitHub, your GitHub username, role `host`, expiry max. Accept the invite link.
11. Note the new URL (`https://<name>.azurestaticapps.net`). Optionally add a custom domain later (free on SWA).
12. In GitHub repo Settings > Secrets, add `PURGE_SECRET` with the same value for the nightly workflow.

**Phase 3: retire GitHub Pages**
13. Repo Settings > Pages > disable, or leave a tiny redirect page with noindex. Either way the old `pstatonvt.github.io` URL should stop serving the organizer so there is one home, indexed nowhere.

## 7. Build order (code)

| Step | Deliverable | Verifies with |
|---|---|---|
| A | `db/*.sql`, `staticwebapp.config.json`, `robots.txt`, noindex meta | Run SQL in SSMS; `curl -I` shows `X-Robots-Tag` |
| B | `api/` scaffold + `GET /api/parties/{guid}` + `POST .../players` with validation and caps | SWA CLI locally (`swa start . --api-location api`) against the Azure DB from home IP |
| C | Host routes + role enforcement | Signed-out `curl` to `/api/host/parties` returns 401; signed-in returns 200 |
| D | Front end: party-mode load, guest view, join form, expired page | Open a link in a private window as a guest |
| E | Generate-link slide-out, cloud autosave, roster polling | Host generates link on one device, guest joins on a phone, host sees them appear |
| F | Purge workflow, rate-limit table, budget alert test | Manually run the workflow; hammer the join endpoint and see 429 |

Local dev: the SWA CLI emulates auth (`/.auth/me` with a fake host user) and routes, so the whole flow runs on `http://localhost:4280` before anything is deployed.

## 8. Costs, worst case

| Resource | Plan | Normal cost | Worst case |
|---|---|---|---|
| Static Web Apps | Free | $0 | Cannot bill. Site stops serving if the 100 GB/mo bandwidth quota is hit. |
| Managed Functions | Consumption free grant | $0 | Only billable past 1M executions/mo; the caps make that unreachable. |
| Azure SQL | Free offer, auto-pause | $0 | Database pauses until next month. $0. |
| Budget | $50 alert | $0 | Email only, no enforcement. |

Sources: [Azure SQL free offer](https://learn.microsoft.com/en-us/azure/azure-sql/database/free-offer), [Static Web Apps plans](https://learn.microsoft.com/en-us/azure/static-web-apps/plans), [Static Web Apps pricing](https://azure.microsoft.com/en-us/pricing/details/app-service/static/), [Azure spending limit](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit).
