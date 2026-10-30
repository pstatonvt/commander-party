# Commander Party Organizer

A single-page organizer for Magic: The Gathering Commander game nights. It tracks who's coming, their experience level, and what they're bringing to the potluck, then seats everyone into pods round by round.

Live site: https://commanderparty.com

## Features

- **Roster.** Each player has a name, an experience level (New, Learning, or Veteran), and a potluck dish. A potluck summary lists every dish.
- **Pods.** Add tables of 3 to 6 seats, then drag players into seats or tap a seat to assign one.
- **Hat Draw.** Seat everyone automatically with one of four strategies: pure random, grouped by skill, experienced players mixed with new players, or by tournament standings. Later rounds avoid repeating earlier pods where possible.
- **Locked pairs.** Partners who want to play together always land in the same pod.
- **Multiple rounds.** Each round keeps its own seating, with a round timer and chimes at the halfway point and at time.
- **Show Seating.** A full-screen display of the current pods for a TV or projector.
- **Tournament Mode.** Record life totals after each round and see running standings.
- **Saving.** A first visit starts with an empty event: no players, dishes, or pods. Everything autosaves in your browser. Export and Import move an event between devices as a JSON file.
- **Shareable party links.** The host can turn an event into a private link. Guests open it on their phones, add their name, experience, and dish, and see the seating. The event then saves to the cloud, and new guests appear in the host's roster.

## Sharing a party

1. Open the organizer and set up the event as usual.
2. Hover the top-left corner and click **Generate link**, or tap **Share link** under the save badge. The first time on each device, enter the host password. It stays unlocked on that device for 30 days.
3. Name the party and click **Generate link**. Copy the link and send it to your guests.
4. Guests open the link and add themselves. They show up in your roster, unseated, within about a minute. Seat them as usual.

The shared party saves to the cloud, so you can open the same link on another unlocked device and pick up where you left off. Only the site admin can delete a party: the Share panel has an **Admin sign-in** link for the admin's GitHub account. The event saved in your browser isn't changed. Links stop working 60 days after they're made. Import and Clear All Data only work on the event saved in your browser, so they're turned off while a shared party is open.

## Shareable links: build status

The design, security model, and setup steps are in [docs/azure-plan.md](docs/azure-plan.md).

| Step | What | Status |
|---|---|---|
| A | Database schema, hosting config, search-engine opt-out | Done |
| B | Guest API: read a party, join, edit your own entry | Done |
| C | Host API: create, save, and manage parties | Done |
| D | Guest view, join form, and expired-link page | Done |
| E | Generate-link button, cloud autosave, live roster | Done |
| F | Expired-party cleanup and limit testing | Done |


## Project layout

| Path | What it is |
|---|---|
| `index.html` | The whole front end: markup, styles, and script in one file |
| `api/` | Azure Functions API (Node.js 22) for shareable parties |
| `db/` | SQL Server scripts for the database schema and the API's limited database user |
| `docs/` | Architecture, security, and deployment notes |
| `staticwebapp.config.json` | Azure Static Web Apps routing, sign-in rules, and response headers. Only the files it allow-lists are served; add any new public file there. |
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
- **A guest's edit permission stays in their browser.** Joining saves a private token on that device, so the guest can change their own entry later. Nobody else can edit it, apart from the host.
- **Party links expire 60 days after they're created.** After that the link shows an expired page. A weekly cleanup deletes each party, with its guest list, 30 days after it expires.
- **Search engines are asked not to index the site.** Every page carries a `noindex` tag and header. `robots.txt` allows crawling on purpose, because search engines only obey `noindex` on pages they're allowed to read.

## Security

Party links are unguessable random IDs. Only hosts, who unlock with a shared host password, can make parties or change a party's seating and settings. The password is kept only on the server, never in this code. Only the admin, signed in with GitHub, can delete parties. Wrong host-password guesses are limited per visitor and overall. The API caps players per party, limits how often one visitor can join, rejects oversized or malformed requests, and never returns other guests' edit tokens. The full model, including its limits, is in [docs/azure-plan.md](docs/azure-plan.md).

If you find a security problem, please contact the maintainer through their GitHub profile instead of opening a public issue.
