# Performance tests

`pnpm perf` puts the chat backend and the web app under load on your machine and writes a report:
WebSocket latency, throughput and fan-out for each storage backend, how big one room can get, how
fast history pages, what someone joining a huddle costs its room, and how the web app loads and
renders a busy room.

```sh
pnpm perf --quick                  # a smoke run, about 3 minutes
pnpm perf                          # the full suite, about 13 minutes (what baseline/ holds)
pnpm perf backend --storage d1     # one suite, one storage backend
pnpm perf backend --scenario fanout,connections
pnpm perf web
```

Each run writes `perf/results/<time>/report.md` and `results.json` (or wherever `--out` says) and
prints the report. It needs Node 22.19 or later, which runs this package's TypeScript directly, and
Chrome for the web suite: an installed Chrome is found automatically, or set `CHROME_PATH`. Server
CPU and memory come from `/proc`, so they show as "–" outside Linux.

## Did my change make it slower?

Run the same profile on both sides, on the same machine, then compare:

```sh
git switch main && pnpm perf --quick --out /tmp/before
git switch my-branch && pnpm perf --quick --out /tmp/after
pnpm perf compare /tmp/before/results.json /tmp/after/results.json
```

`compare` prints the headline metrics side by side and exits with 1 if any got worse, or if the
second run is missing something the first measured, such as a room size it no longer reaches. To
count as worse, a metric has to move by more than `--threshold` percent (10 by default), by more
than its floor (1 ms for most latencies, 4 ms for fan-out tails, one frame for paint timings, 200 ms
for Lighthouse's Total Blocking Time), and by more than it moved between runs of the same commit,
which `src/compare.ts` records per metric: 10 to 25% for most, 40% for tail latencies, history reads
and joins into a saturated room, and 60% for a huddle and someone who joins it hearing each other.
Lost or missing messages and errors count from the first one, as does one request more or fewer to
the SFU for someone to join a huddle, which every run of the same code counts alike.

On a pull request, adding the `perf` label runs the quick suite in CI on every push. The report
shows in the run's summary and both files are attached to the run. Running the Performance workflow
by hand offers the full profile too. GitHub's runners have 2 cores, half what the baseline had, and
it shows: Lighthouse scored the room page 75 on mobile there, against 96 in the baseline. Compare a
CI run only with another CI run.

## What it measures

### Backend

Every scenario, and every fan-out room size, starts its own `wrangler dev` with empty storage. Its
config is generated from the root `wrangler.jsonc` with `STORAGE_BACKEND` switched and, for D1,
a local database migrated from `apps/worker/migrations/`. Clients sign in through `/api/session`
and talk to rooms over real WebSockets, sending the same frames as the web app.

| Scenario | What happens | What it shows |
| --- | --- | --- |
| `latency` | Two members, one posting 20 messages a second | The floor: one write and broadcast with nothing else going on |
| `throughput` | Four members posting as fast as acknowledgements come back, 8 in flight each | The most one room, which is one Durable Object, can write per second |
| `fanout` | One member posting 10 a second into rooms of 10, 100, 250 and 500 | What each extra member costs a broadcast, and when the last one gets it |
| `connections` | One room grown in steps from 100 to 1,000 members until p95 time-to-welcome passes 2 s | How many sockets one room holds well, and the presence traffic each join causes |
| `tabs` | Tabs opened as the web app opens them, in steps from 250 to 1,000, each someone else with a room's socket, the workspace socket, the sidebar and the people directory; then every tab reconnecting as after a deploy, its room socket naming the latest change it heard of | How many tabs the Workspace, one Durable Object that every tab's sockets, sidebar and directory ask, holds well, and how long a deploy's reconnects take |
| `unread` | One member posting in rooms of 100, 500 and 1,000 people away from them, each with only the workspace socket open: one message, then 100 more at 10 a second | How long the Workspace takes to mark a room unread for everyone away and tell them, and what each message after costs once they're marked |
| `history` | A 2,000-message room: 30 fresh joins, then paging back to the start three times | The read path, where DO SQLite and D1 differ most |
| `search` | 250 messages written in each of 20 rooms at once, then someone in all of them searching: until they find the last, then for each of 30 new messages in quiet rooms until they find it, then for a word in a quarter of the messages, one in a message in each room, and one in none, 50 times each | How far behind a burst leaves the search index, how soon a new message can be found, and what a search costs |
| `huddle` | One huddle grown a person at a time to 10, 25 and 50, the most it takes, each joining with their voice once the last is heard by everyone; at each size, 100 reactions at 10 a second from the people in turn | What someone joining costs a huddle's room: how long until they're welcomed, hear everyone and are heard by everyone, and how many requests the room makes of the SFU for it; and what a reaction costs |

Alongside each measurement it records the CPU used by the `wrangler` and `workerd` processes. A
room's Durable Object runs on one thread, so "busiest process" near 100% means the room itself is
the bottleneck. It also records the load generator's own event-loop delay: when that's more than a
few milliseconds, the latencies include time the client spent queued rather than the server.

The `tabs` scenario's reconnect closes the sockets from the client and waits for their goodbyes to
finish, since a deploy drops sockets without any. The Workspace keeps the sessions it has looked up in
memory, which a deploy would clear, so its checks after the reconnect read less than they would.

The `huddle` scenario's SFU is a stand-in on this machine (`src/sfu.ts`), which its `wrangler dev`
is told of as `REALTIME_SFU_URL`. It answers what the room asks at once, with session descriptions as
long as a browser's, and carries no sound. What people say in a huddle goes between their browsers
and Cloudflare's SFU, never through Ember, so the scenario times the room's own work and counts its
requests, to which a real SFU adds however long it takes to answer each. `--url` leaves the scenario
out: it sets a new server up to turn huddles on, with a stand-in that only the `wrangler dev` it
starts is told of.

Receivers check that messages arrive in id order. Ids are assigned in arrival order, so "out of
order" means writes finished in a different order than they started.

### Frontend

- **Bundle**: every file in `apps/web/dist`, raw, gzip and brotli.
- **Lighthouse**: cold loads of the sign-in page and of a signed-in room with history, using
  Lighthouse's mobile (slow 4G, 4x slower CPU) and desktop settings. Median of three runs.
- **Live rendering**: headless Chrome sits at the bottom of `#general` while another member posts
  bursts of messages. For each message it times the WebSocket frame landing, its row entering the
  DOM, and the next paint, and it reads Chrome's main-thread time per message (split into script,
  style and layout), long tasks, idle main-thread time and heap size. It does this with the newest
  page of 40 messages loaded and again after scrolling back until it holds 300, the most paging back
  leaves it, since a page that takes it past 320 cuts it back to 300, at normal speed and with the CPU slowed 4x like a mid-range phone.

## Reading the numbers

- Everything runs on one machine, client and server alike. Absolute numbers depend on that machine,
  so compare runs from the same one; the baseline here came from a 4-core cloud container.
- `wrangler dev` passes every request and WebSocket frame through a local proxy Worker, a hop
  production doesn't have. Production adds real network distance instead.
- Local storage lives in memory (`/dev/shm`) where Linux offers it, so disk flush speed doesn't
  decide write numbers. What durability costs in production isn't measured here: DO SQLite
  replicates each write before confirming it, and D1 is a network round trip to its primary.
- Local D1 is simulated inside the same `workerd` process. Local D1 numbers are therefore a floor:
  in production every D1 read and write also pays that round trip, which can cross regions.
- `pnpm perf backend --url https://<worker> --storage do-sqlite` runs the backend scenarios, but for
  `huddle`, against a deployed Worker to get real network numbers; `--storage` names its backend, or `/api/health`
  tells it when `EMBER_RECOVERY_TOKEN` in the environment is the Worker's. It creates users and
  messages there and generates real load, so use a staging deployment, never production. CPU and
  memory aren't available remotely.

## Layout

| Path | What |
| --- | --- |
| `src/main.ts` | The command line |
| `src/server.ts` | Starts `wrangler dev` per storage backend and samples its CPU and memory |
| `src/room-client.ts` | A minimal room participant over one WebSocket |
| `src/tab-client.ts` | A tab as the web app opens one: a room's socket, the workspace socket, the sidebar and the people directory |
| `src/huddle-client.ts` | A tab in a huddle: its socket, its voice, and the rounds it asks to hear the others in |
| `src/sfu.ts` | A stand-in for Cloudflare's Realtime SFU, which the `huddle` scenario's room asks |
| `src/load.ts` | Shared helpers: joining, rate control, seeding, measurement windows |
| `src/scenarios/` | The backend scenarios |
| `src/web/` | Bundle sizes, Lighthouse, and the in-browser render timing |
| `src/profiles.ts` | How hard each scenario pushes in the full and quick profiles |
| `src/report.ts`, `src/compare.ts` | The Markdown report and run comparison |
| `baseline/` | The full run this suite was introduced with |
