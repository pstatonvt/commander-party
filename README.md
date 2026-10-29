# Commander Party Organizer

A single-page organizer for Magic: The Gathering Commander game nights. It tracks who's coming, their experience level, and what they're bringing to the potluck, then seats everyone into pods round by round.

Live site: https://pstatonvt.github.io/commander-party/

## Features

- **Roster.** Each player has a name, an experience level (New, Learning, or Veteran), and a potluck dish. A potluck summary lists every dish.
- **Pods.** Add tables of 3 to 6 seats, then drag players into seats or tap a seat to assign one.
- **Hat Draw.** Seat everyone automatically with one of four strategies: pure random, grouped by skill, experienced players mixed with new players, or by tournament standings. Later rounds avoid repeating earlier pods where possible.
- **Locked pairs.** Partners who want to play together always land in the same pod.
- **Multiple rounds.** Each round keeps its own seating, with a round timer and chimes at the halfway point and at time.
- **Show Seating.** A full-screen display of the current pods for a TV or projector.
- **Tournament Mode.** Record life totals after each round and see running standings.
- **Saving.** Everything autosaves in your browser. Export and Import move an event between devices as a JSON file.

## In progress: shareable party links

The next version moves the site to Azure so a host can generate a private link for a party. Guests open the link, add their own name, experience, and dish, and see the seating. The design, security model, and setup steps are in [docs/azure-plan.md](docs/azure-plan.md).

| Step | What | Status |
|---|---|---|
| A | Database schema, hosting config, search-engine opt-out | Done |
| B | Guest API: read a party, join, edit your own entry | Done |
| C | Host API: create, save, and manage parties | Not started |
| D | Guest view, join form, and expired-link page | Not started |
| E | Generate-link button, cloud autosave, live roster | Not started |
| F | Expired-party cleanup and limit testing | Not started |

Until step E ships, the live site works as it always has, saving only in your browser.

## Project layout

| Path | What it is |
|---|---|
| `index.html` | The whole front end: markup, styles, and script in one file |
| `api/` | Azure Functions API (Node.js 22) for shareable parties |
| `db/` | SQL Server scripts for the database schema and the API's limited database user |
| `docs/` | Architecture, security, and deployment notes |
| `staticwebapp.config.json` | Azure Static Web Apps routing, sign-in rules, and response headers |
| `robots.txt` | Crawler rules; see Privacy below |

## Running it locally

The organizer has no build step. Open `index.html` in a browser.

To run the API tests:

```bash
cd api && npm install && npm test
```

The tests use a fake database. Running the API itself needs a SQL Server database and the Azure Static Web Apps CLI; [docs/azure-plan.md](docs/azure-plan.md) covers that setup.

## Privacy

- **The organizer stores nothing on a server today.** All event data stays in your browser until you export it.
- **Shareable parties will store only what guests type in**: a name, an experience level, and a dish. Guest IP addresses are never stored; the API keeps a salted hash for a short time to rate-limit joins.
- **Party links expire 60 days after they're created.** After that the link shows an expired page.
- **Search engines are asked not to index the site.** Every page carries a `noindex` tag and header. `robots.txt` allows crawling on purpose, because search engines only obey `noindex` on pages they're allowed to read.

## Security

Party links are unguessable random IDs, and only the host can change a party's seating or settings. The API caps players per party, limits how often one visitor can join, rejects oversized or malformed requests, and never returns other guests' edit tokens. The full model, including its limits, is in [docs/azure-plan.md](docs/azure-plan.md).

If you find a security problem, please contact the maintainer through their GitHub profile instead of opening a public issue.
