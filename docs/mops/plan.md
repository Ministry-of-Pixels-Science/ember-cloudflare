# Ember in the MoPS platform

A plan for replacing MoPS's Slack with Ember: one internal workspace for MoPS staff and their
chatbots, signed in to with platform accounts, with a native SwiftUI client in MoPS Manager on macOS
and iOS. It spans four repositories: this fork, `platform`, `manager` and `mops-swift-app-core`.

Status: proposal. Nothing below is built yet. Open decisions are listed at the end.

## Decisions taken

| | |
|---|---|
| Who it's for | MoPS staff, replacing Slack. Not a chat space for each customer organization. |
| Where Ember runs | Its own Worker, deployed from this fork's `mops` branch, beside the platform API Worker. |
| Clients | Native chat in Manager on macOS and iOS, built together. Ember's web app stays available. |
| Branches | `main` mirrors upstream. `mops` carries MoPS's changes and is what deploys. |

## Branches and upstream

- `main` is `NYLLON-SOFTWARE/ember-cloudflare`'s `main`, fast-forwarded only. Nothing of MoPS's is
  committed to it. Today it is upstream's `v0.5.0-beta.1`.
- `mops` is long-lived. Upstream arrives as a pull request that merges an upstream **release tag**
  into `mops`, never a rebase and never an arbitrary commit from `main`: upstream only promises that
  released migrations don't change (`docs/development.md#releasing`).
- Upstream's `update-ember.ts` does this three-way merge for copies already, keeping the deployer's
  `wrangler.jsonc` settings. Try it against `mops` first, and fall back to a plain
  `git merge v<version>` if its assumptions about a copy (default branch, Workers Builds) get in the way.
- Keeping merges clean is a design rule for everything MoPS adds here:
  - New code lives in new files under `apps/worker/src/mops/`, with one-line hooks in `index.ts`,
    `auth.ts` and `env.ts`.
  - **No migrations in the fork.** `MIGRATIONS` is an ordered list checked against the directory, and
    upstream will take the next numbers. The plan below needs none: identities reuse upstream's
    `identities` table, and device push tokens live in the platform.
  - MoPS's workflows are new files (`mops-ci.yml`, `mops-deploy.yml`). Upstream's `ci`, `perf` and
    `release` workflows only run in upstream's repository and are left alone.
  - Anything general (bearer sessions, a push transport hook) is offered upstream, so the fork shrinks.

## Architecture

```
Manager (macOS / iOS)                       Browser
  │  platform session (Bearer JWT)            │
  ├──────────────▶ api.mpixsci.app ◀──────────┤  sign in with MoPS
  │                 POST /chat/token (staff)   │
  │                 POST /chat/push  ◀─────────┼──── service binding ────┐
  │                 APNs ─▶ Manager            │                         │
  │  Ember session (Bearer)                    │  Ember session (cookie) │
  └──────────────▶ chat.mpixsci.app ◀──────────┘                         │
                    Worker `mops-chat` (this fork, `mops` branch) ───────┘
                    Workspace, ChatRoom, SearchIndex Durable Objects, R2 `mops-chat`
```

Ember stays one workspace per deploy, as upstream builds it. The platform stays the only place
people have accounts.

### Deploy

- Worker `mops-chat` at `chat.mpixsci.app`, and `mops-chat-dev` at `chat-dev.mpixsci.app`, each with
  its own Durable Objects and R2 bucket. `STORAGE_BACKEND=do-sqlite`.
- Deployed by GitHub Actions on a push to `mops` (dev on a passing pull request), matching the
  platform's rule that production only changes through Actions. Workers Builds is not connected.
- Upstream's own update notice in General settings is pointed at this fork or turned off, so
  administrators aren't offered upstream releases directly.

### Sign-in: platform accounts only

Ember today has cookie sessions and no bearer tokens for people. Its one outside identity path,
Memberful, is the model: `identities (issuer, subject)` links a person to an outside account, a
webhook reports lapses, and a daily catch-up suspends anyone missed.

1. **Platform** adds `POST /chat/token` behind `requireStaff`. It answers a 60-second JWT naming the
   chat host as audience, with the user's id, verified email, name and avatar. It is signed with a
   key derived from `JWT_SECRET` for this purpose, as the MCP access tokens are, so it never passes
   as a platform session and the platform's secret is never shared.
2. **Ember** adds `POST /api/session/mops` (`apps/worker/src/mops/session.ts`). It verifies the token
   through a service binding to the platform (`GET /chat/keys` or a verify call), finds or creates
   the member under issuer `https://api.mpixsci.app`, adds a new member to every open room as
   Memberful's path does, and answers Ember's own session.
3. **Bearer sessions.** `credentialsOf` also reads `Authorization: Bearer <session token>`. A request
   that authenticates that way skips `isCrossSite` and the WebSocket `Origin` check, since no
   browser sends that header on its own. Without this a native client would have to forge
   `Sec-Fetch-Site: same-origin` and `Origin` on every write.
4. **Web.** `GET /auth/mops` sends the browser to a page on `mpixsci.app` that fetches a chat token
   and returns it to `/auth/mops/callback`, which sets the cookie. Password sign-in, join links and
   open sign-up are switched off, so the platform is the only way in.
5. **Leaving.** When a person's platform account is disabled, loses its staff domain, or has its
   tokens revoked, the platform posts a signed notice to `POST /webhooks/mops`, and Ember suspends
   them, ending their sessions and sockets as a Memberful lapse does. A daily catch-up asks the
   platform about every linked member.
6. **Administrators.** Platform admins (`users.is_admin`) are Ember administrators, set on sign-in.

### Push notifications

Ember sends Web Push only. Manager needs APNs, and the platform already speaks it
(`services/apns.ts`).

- **Platform** stores Manager's device tokens (`user_push_tokens`, a platform migration) from
  `PUT /user/push-token`, and adds `POST /chat/push`, reachable only over the service binding, which
  takes `{ subjects, title, body, path, badge }` and sends alert pushes to topic
  `app.mpixsci.Manager`. `apns.ts` sends silent pushes to fixtures today, so it gains alerts and a
  topic per app.
- **Ember** adds one hook where the room calls `sendPushes`: for recipients linked to a platform
  account, also call `/chat/push`. Recipient choice (`MESSAGE_PUSHES`: not the author, not viewing,
  by each room's bell) is unchanged. Web Push keeps working for browsers.

### Chatbots

- **@ember and agents.** Turn on Ember AI through AI Gateway with Claude models. Staff-defined
  agents (instructions, model, rooms) need no code.
- **Agent MoPR in chat.** A bot whose webhook is a platform route, `POST /chat/bots/mopr`. Ember
  calls it when the bot is mentioned or DM'd; the platform runs the model with the staff MCP tools
  (devices, diagnostics, logs, organizations) and answers. Limits to design for: Ember waits 60
  seconds, sends no history beyond the message, and doesn't stream, so the route answers quickly
  with a first message and posts the rest through the bot API.
- **Alerts.** Deploys, GitHub and fixture error alerts post through Ember's Slack-compatible
  incoming webhooks, so whatever posts to Slack today only needs its URL changed.

## Manager: native chat

Chat is not scoped to an organization, while `MainView` is rebuilt for each one. Chat's stores live
at the session level beside `SessionStore`, so sockets survive switching organizations.

### Layers

| Layer | Where | What |
|---|---|---|
| Client | `Shared/Chat/` | `ChatSession` (exchanges the platform token, keeps Ember's in the Keychain), HTTP client, `WorkspaceSocket`, `RoomSocket` over `URLSessionWebSocketTask`: ping every 25 s, reconnect with `since=<seq>`, `message.check` after a drop. |
| Protocol | `Shared/Chat/Protocol/` | `Codable` mirrors of `packages/protocol` frames at `ROOM_PROTOCOL = 4`. Unknown frame types and fields are ignored. |
| Rich text | `Shared/Chat/RichText/` | Bodies are sanitized Action Text HTML. A Swift port of `displayBody`'s tree (text, element, mention, preview), rendered as SwiftUI text and blocks; a composer that writes the same markup. |
| Stores | `Shared/Features/Chat/` | `@Observable` stores: sidebar and unread, room timeline, thread, directory, search, uploads. |
| Views | `Shared/Features/Chat/` | Sidebar, timeline, thread pane, composer, search, profiles. macOS: a rail tab (`ManagerTab.chat`). iOS: a tab beside Now Playing. Shown only when `/chat/token` succeeds, as Feedback checks `/assistant`. |

### Contract tests

The fork generates `contract/frames.json` (every frame type, with samples) and reuses
`packages/richtext`'s golden corpus; Manager's tests decode and render them. A protocol change in an
upstream merge then fails in CI rather than in the app. This is the schedule-vectors pattern the
fixtures use.

### Scope of the first release

Rooms, private rooms and DMs; threads; mentions; reactions; edit and delete; files and pictures
(upload in 10 MiB parts, with a client-made preview); link previews; bot cards; unread marks and
per-room bells; presence and typing; search; push; an offline send queue.

Left for later: huddles (WebRTC has no system framework on Apple platforms), workspace
administration (use the web app), custom CSS and room icons from the pickers.

## Phases

| | Work | Repositories | Done when |
|---|---|---|---|
| 0 | `mops` branch, CI, dev and production deploys | fork | `chat-dev.mpixsci.app` serves upstream Ember, deployed by Actions |
| 1 | Chat tokens, `/api/session/mops`, bearer sessions, web sign-in, suspension | fork, platform | Staff sign in on the web with their platform account; nobody else can |
| 2 | Swift client, protocol and rich text, with contract tests | manager, fork | Tests decode every frame and render the corpus; a command-line send and receive works |
| 3 | Chat in Manager: sidebar, timeline, threads, composer, files, search | manager | Staff can work a day in Manager without opening the web app |
| 4 | APNs push, badges, deep links | platform, fork, manager | A mention reaches a locked iPhone and opens its message |
| 5 | Agent MoPR bot, agents, alert webhooks | platform, fork | The alerts in Slack today arrive in Ember |
| 6 | Cut over from Slack | — | Slack is read-only |

Phases 2 and 3 can start as soon as phase 0 is up, against a dev deploy with guest sign-in, in
parallel with phase 1.

## Open decisions

1. **Customer support.** Recommended: a second deploy of the same branch (`support.mpixsci.app`),
   not rooms in the staff workspace. Ember has no guests: every member sees the whole directory,
   joins every open room and searches them, so customers in the staff workspace would rely on every
   room being made private by hand. A second Worker costs a `wrangler` environment, and its
   `/chat/token` rule becomes "staff, or a member of a customer organization". To keep it cheap
   later, Manager's client takes a list of workspaces from the start rather than one host.
2. **Slack history.** Start fresh, or import. Ember has no importer, and its bot API can't backdate
   messages or post as people, so an import is a script against the Durable Objects in the manner of
   `apps/worker/scripts/seed.ts`. Recommended: start fresh and keep Slack's export as an archive.
3. **The web app.** Keep `chat.mpixsci.app` open to staff as a fallback and for administration
   (recommended), or close it once Manager is complete.
4. **Where the Swift client lives.** In `manager/Shared/Chat` (recommended, simplest), or as a
   library in `mops-swift-app-core` if another MoPS app will want chat.

## To verify before building

- Whether `URLSession`'s default User-Agent reaches Ember's unsupported-browser page on plain HTTP
  requests (bearer requests can skip it in the same hook).
- Avatars are served only to a session cookie today; the bearer hook must cover `/users/<token>/avatar`.
- How `update-ember.ts` behaves when the branch it updates isn't the repository's default.
- Whether the platform's APNs key is allowed to send to `app.mpixsci.Manager` as well as the fixture app.
