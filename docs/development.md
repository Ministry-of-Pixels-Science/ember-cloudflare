# Developing Ember

Ember is a React app served by a Worker, with one Durable Object per room holding its WebSockets,
presence, typing state and messages. This is how its code is laid out, how to run it on your machine,
and how it's tested. The [self-hosting guide](self-hosting.md) covers deploying it, and
[`AGENTS.md`](../AGENTS.md) the conventions changes follow.

## Layout

| Path | Package | What |
|---|---|---|
| `apps/web` | `@ember/web` | React + Vite + Tailwind CSS v4 + shadcn/ui. The workspace UI. |
| `apps/worker` | `@ember/worker` | The Worker (`/api/*`, `/up`, the app's pages with Campfire's headers and error pages, the web app manifest, static assets) and the `ChatRoom`, `Workspace`, `SearchIndex`, `PasswordHasher`, `Unfurler`, `AppConnector` and `OutsideAi` Durable Objects. |
| `packages/protocol` | `@ember/protocol` | WebSocket frame types and validation shared by both, and the addresses of the app's pages. |
| `packages/richtext` | `@ember/richtext` | Message bodies as Campfire's Action Text reads them: sanitizing, plain text, mentions and emoji-only bodies, golden-tested against a corpus of Campfire's Rails outputs. |

```
browser ──HTTP──▶ Worker ──▶ static assets (apps/web/dist)
   │                ├─────▶ Workspace Durable Object (one: the account, people, sessions, rooms, memberships,
   │                │        each tab's workspace socket, and the outbox that closes sockets in every room
   │                │        when access ends)
   │                ├─────▶ SearchIndex Durable Object (one: every message's plain text in an FTS5 table,
   │                │        in its own SQLite storage, which each room sends its changes)
   │                │
   └──WebSocket─────┴──▶ ChatRoom Durable Object (one per room, by id)
                            ├─ sockets, presence, typing (hibernation API)
                            └─ messages + boosts ─▶ DO SQLite (default) or D1
```

## Getting started

Requires Node 22.22.2+, 24.15+ or 26+ (jsdom's supported versions) and pnpm 10.

```sh
pnpm install
pnpm build          # once: wrangler dev serves the app's files from apps/web/dist
pnpm dev            # wrangler dev on :8787 and Vite on :5173 (proxies /api)
```

`pnpm dev` sets a `SESSION_SECRET` for your machine and lets anyone sign in with just a name. The
optional settings, such as push notifications' keys, go in a `.dev.vars` beside `wrangler.jsonc`:
`.dev.vars.example` lists them.

Open http://localhost:5173 and set up Ember: the first visitor creates the workspace's administrator
and its rooms, general and random. Then open a second browser, pick a name, and chat with yourself.
On localhost setup is open to whoever's there; a deployed Worker takes its setup password, or the
setup link its deploy prints ([Deploying](self-hosting.md#deploying)).

Or, before setting it up, run `pnpm seed` to have a made-up team set it up and fill its rooms and DMs
with conversations that use everything a message can: threads, quotes, mentions, reactions, pictures,
files, link previews and bots. It prints how to sign in as each of them (`apps/worker/scripts/seed.ts` says more).

```sh
pnpm typecheck
pnpm test           # unit tests; worker tests run in workerd, once per storage backend
pnpm build
```

## Storage

Where messages live, each room's Durable Object SQLite or one D1 database, is a deploy's choice:
[Storage](self-hosting.md#storage-durable-object-sqlite-or-d1) in the self-hosting guide says how each
works, and [`docs/database.md`](database.md) compares the schema with Campfire's.

## Browser tests

`e2e/` drives the production build in Chromium, against `wrangler dev` on :8788 with its own
state in `e2e/.wrangler`. Every suite shares `e2e/playwright.config.ts` and `e2e/fixtures.ts`
(sign in, an isolated room, other participants over a real WebSocket); each adds its projects
from `e2e/projects/` and its specs under `e2e/tests/<suite>/`.

```sh
pnpm --filter @ember/e2e exec playwright install chromium   # once
pnpm test:e2e       # every suite
pnpm test:features  # just the feature-by-feature suite, on a desktop browser
pnpm test:mobile    # just the phones
pnpm screenshots    # remakes the web app manifest's screenshots
```

Before the other suites start, the `first-run` project sets up the test server through the Set up
Ember page, as its first visitor would. The `workspace-settings` suites, which change the whole
workspace, get a second server, over HTTPS, which the same first run sets up. Their browsers have a
made-up microphone, for the huddles spec, whose stand-in for Cloudflare's Realtime SFU
(`e2e/tests/workspace-settings/fake-sfu.ts`) passes what each browser says on to the others through
a page of its own, so a huddle there is heard for real.

The features suite (`e2e/tests/features/`) has a spec per area of the app. Each test gets rooms of
its own, and `members.signIn` opens a browser per person, so tests can chat, react and watch
each other type without seeing another test's messages.

The mobile suite (`e2e/tests/mobile/`) emulates seven phones, from a 320px iPhone SE to an iPhone
17 Pro Max on its side, with their notches, home indicators and on-screen keyboards. On every
screen it checks that nothing overflows sideways or sits under the notch, that every control is a
44px tap target, and that text fields are 16px so iOS doesn't zoom in on focus. Where a browser is
already installed, point Playwright at it with `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome`.

The screenshots suite (`e2e/tests/screenshots/`) makes the screenshots the web app manifest lists,
which an install prompt shows: a few people chatting, on a phone. `pnpm screenshots` saves them over
`apps/web/public/screenshots/`, and every other run with the test's results, so they keep working.

## Releasing

Ember's version is `version` in `apps/worker/package.json`, which the Worker reports in its
`X-Version` header. A pull request that raises it is a release: once it's merged, the Release workflow
(`.github/workflows/release.yml`) tags the commit `v<version>` and publishes the release, with notes
listing the pull requests merged since the last, and every copy's Update Ember workflow offers it
within a week ([Updating](self-hosting.md#updating)), as General settings tells their administrators,
going by GitHub's latest release. Copies move from release to release, never to `main` between them,
and may skip any number of releases or go back one, so:

- A released migration never changes, a beta's included, since copies that update have applied it
  already: CI fails a pull request that changes one. A schema change goes in a new migration.
- A migration adds to the tables rather than takes away, so the release before still runs on what it
  leaves: drop a column or table a release after the code stops using it.
- `.github/workflows/update-ember.yml` stays thin, since an update can't change a copy's
  workflows: change `apps/worker/scripts/update-ember.ts`, which updates bring, instead, and add to
  the workflow only what a copy with the one before can do without, as the box for a beta is. Its copy
  beside that script, which the deploy and General's release card offer copies without the
  workflow, as Deploy to Cloudflare's are, is the same file, as CI checks. The tests read that
  copy, never `.github`, since a copy's `.github` keeps its own workflow, or none, and a copy's
  owner may run them.
- Ember's other workflows run only in its own repository, and `pnpm run deploy` stays the deploy
  command, which every copy's Workers Builds runs.

A beta of the next release, for trying it before it's out, is a pull request that sets the version
to that release's with `-beta.1`, such as `0.5.0-beta.1`, then `-beta.2` and so on. The Release
workflow publishes it as a pre-release, "Ember 0.5.0 beta 1", whose notes start with a Deploy to
Cloudflare button for it and list what's changed since the release or beta before, and no copy is
offered it unless it asks for one, or runs an earlier beta ([Betas](self-hosting.md#betas)). The
tests that name the release expect it named "0.5 beta 1". The release itself then sets `0.5.0`, and
its notes list what's changed since the release before, as the copies it's offered come from there.
Ember's version is a release's or a beta's, which the Release workflow checks, since copies tell
them apart by their tags and know no other kind.

## Performance

`pnpm perf` load-tests the Worker under `wrangler dev` on both storage backends (latency,
throughput, fan-out, room size, history paging, search) and measures how the web app loads and renders a
busy room. `perf/README.md` explains the scenarios and how to compare two runs; the numbers the
suite started with are in `perf/baseline/report.md`.
