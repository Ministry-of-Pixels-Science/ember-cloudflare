# Database

How Ember stores its data, and how its schema compares with Campfire's.

## Where the data lives

`STORAGE_BACKEND` in `wrangler.jsonc` picks the backend. With `do-sqlite` (the default), each room's
messages, boosts, recent revocations and deletions, its files' records, and the changes the
Workspace and the search index have yet to hear of live in that room's Durable Object SQLite
storage, and the account, people, their sessions and linked accounts elsewhere, browsers' push
subscriptions, bots' webhooks, bans and recent searches, rooms, memberships and the outbox of
revocations, purges and reindexes in the Workspace object's. With `d1`, all of them live in one D1
database. Both backends use the schema in `apps/worker/migrations/` and the queries in
`apps/worker/src/store.ts`, run through the driver in `apps/worker/src/db.ts`. The search index is
the exception: it keeps its tables in the `SearchIndex` object's own SQLite storage on either
backend, since D1 can't export a database that holds a virtual table, as its FTS5 table is. The
files themselves live in R2, in the bucket bound as `FILES`.

Each file in `apps/worker/migrations/` belongs to one kind of Durable Object, which `MIGRATIONS` in
`apps/worker/src/migrations.ts` names as its scope: `room` for messages, boosts, revocations, the
room's change log, its log of messages for the search index, its recent deletions, its files and the
calls of apps' tools that wait to be allowed, and
`workspace` for the workspace-wide tables (the account, people, sessions, linked accounts, push
subscriptions, webhooks, bans, recent searches, rooms, memberships, stars, pending revocations,
purges and reindexes, the rooms deleted, the apps connected, the tools picked for each agent, and the AI apps people connect to Ember). On DO SQLite, an object applies only its own scope's
files, so a room's storage never holds workspace tables. Wrangler applies every file to D1, where
all the tables share one database and each room's rows carry its `room_id`. The search index's
schema is in `apps/worker/search-migrations/`, which only the index applies, listed in
`SEARCH_MIGRATIONS`.

So far rooms keep `messages`, `boosts`, `revocations`, `room_events`, `unindexed_messages`,
`message_deletions`, `blobs` and `waiting_calls`, the Workspace keeps `accounts`, `users`, `sessions`, `identities`,
`pending_identities`, `membership_checks`, `membership_catch_ups`, `push_subscriptions`, `webhooks`,
`bans`, `email_links`, `email_link_requests`, `password_resets`, `searches`, `recent_searches`, `rooms`,
`memberships`, `favorites`, `pending_revocations`, `pending_purges`, `pending_reindexes`,
`deleted_rooms`, `apps`, `app_sign_ins`, `own_app_sign_ins`, `agent_tools`, `outside_clients`, `outside_connections` and `outside_spent_tokens`, and the search index keeps `search_messages`, `search_mentions`, `search_rooms` and the
FTS5 table `search_index`. A room's id also
names its Durable Object, and the Worker asks the Workspace whether someone is a member before it
wakes the room for their socket. First run creates the account and its administrator, who signs in
with an email address and password, found through the unique index on `users.email_address`, as do
the people who join with the join link; where it's allowed, anyone can sign in with just a display
name instead, and the members of a Memberful site sign in with Memberful, once an administrator lets
them, found through `identities`, and the people administrators invite, or who ask for a link with an
address at the workspace's email domains, join with that address. Presence and typing live in each
room object's memory.

## Compared with Campfire

Campfire keeps its Rails schema in one SQLite database
([`db/schema.rb`](https://github.com/basecamp/once-campfire/blob/main/db/schema.rb)): accounts,
users, sessions, rooms, memberships, messages with their bodies in `action_text_rich_texts`, boosts,
bans, webhooks, push subscriptions, searches, Active Storage tables for files, and an FTS5 search
index. Ember's tables keep its names and columns where they can, and depart from them where Durable
Objects, D1 or speed call for something else.

### Speed and integrity

- **History pages seek an index from the cursor.** The newest page and the pages before and after a
  message are separate statements, and the page around a message, which its permalink opens, is the
  message and the pages either side of it, read side by side. A single statement with
  `? IS NULL OR id < ?` walked the room from its newest message down to the cursor. In a
  100,000-message room, a page near the start took 8.1 ms and now takes 0.27 ms, the same as the
  newest page.
- **One round trip where there were two.** A page's boosts come from a subquery in the same
  statement, so a page or a message lookup is one D1 round trip, not two.
- **Stored sessions, refreshed hourly.** Each sign-in adds a `sessions` row with the browser and IP,
  and a request rewrites its `last_active_at`, browser and IP at most once an hour rather than every
  time, as Campfire's `Session#resume` does. Signing out deletes the row, and in the same batch
  queues closing the session's sockets (see the outbox below).
- **Memberships are found by room and person, or by person.** Campfire's unique `(room_id, user_id)`
  index is our primary key, which answers each socket upgrade's "is this person in this room?", and
  its `user_id` index is ours with `room_id` added, so listing someone's rooms reads only the index
  for their memberships. Its `room_id` index repeats the key's first column, and
  `(room_id, created_at)` orders a room's members, which nothing lists yet, so neither is here.
- **One account, kept to one by the database.** Campfire's `accounts` has a `singleton_guard` column
  with a unique index, so a second account can't be inserted. Ours has it too: the Workspace runs
  one first run at a time on DO SQLite, but on D1 two can overlap, and the index refuses the second.
  The account's columns are Campfire's: its name, its join code, its settings as JSON and its custom
  styles. Ember's custom domain and tagline are more of those settings (`custom_domain` and
  `tagline`), so they took no migration and are read with the rest of the account, and so are the
  address its email comes from (`email_from`), the keys of the Turnstile widget an administrator
  gave it (`turnstile_keys`, the secret key sealed), those of the Realtime SFU app huddles run
  through (`huddles`, the app's secret sealed) and those of the Memberful site whose members sign in
  (`memberful_keys`, its custom app's secret and API key and its webhook's secret sealed together).
- **Unread marks are a column of the membership.** `memberships.unread_at` is when a room was marked
  unread for someone, null while it isn't, and one `UPDATE` marks every member a message should. We
  skip Campfire's `connections` and `connected_at` columns: each room's object knows from its
  sockets who's viewing it, and sends that list with its messages. And ours writes only the rows it
  changes, so `unread_at` is the time of the first message since someone last read the room; nothing
  reads it but to ask whether it's set.
- **No unbounded lists of bound values.** Durable Object SQLite and D1 bind at most 100 values a
  statement, and binding a page's message ids made a 100-message page fail on both.
- **Tabs that connect again find what changed through an index on messages.** Campfire's
  `index_messages_on_room_id_and_updated_at` finds the messages changed since a time. Ours asks
  since a number rather than a time, which no clock can skew (room migration 0015): each room
  numbers the changes to its messages, and the statement that makes a change gives its message the
  number in `change_seq`, which `(room_id, change_seq)` indexes, a reaction setting its message's. A
  tab that connects again names the latest number it has heard of, and the room reads the messages
  changed since through that index, the same few rows however big the room. It hears of deletions
  too: a deleted message leaves its id with the deletion's number in `message_deletions`, and each
  deletion drops those more than 100 changes old. A tab more than 100 changes behind gets the newest
  page instead. Keeping every change as a row of its own, in a log of the latest 100, cost each new
  message two more statements and a room 13% of the messages it could take a second, so a new
  message writes no other row. The room is the only writer of its messages, so it counts from the
  latest number once it has read it, and reads it again after a batch fails, which D1 may have saved
  all the same. Our "(edited)" label reads `edited_at`, so a reaction leaves its message's times
  alone.
- **Search is one FTS5 table, read from its newest match.** As Campfire's `message_search_index` is,
  it's an FTS5 table with the porter tokenizer holding each message's plain text, and a search
  quotes each word, so that every word has to match and none is read as FTS5's syntax, such as `NOT`
  or `NEAR`. It walks the index's matches from the newest, wherever they are, keeps the ones in
  rooms the searcher is in, and stops at 100 and one more, which says there's another page: one
  statement, whatever the other rooms hold. It used to read the newest 1,000 matches and ask for
  just the searcher's rooms' only when those held too few, so a second query ran or not by how many
  matches were in rooms the searcher isn't in, and the time a search took told them whether a word
  was written there. It still passes over each match in another room, a row's read apiece, as the
  FTS5 table doesn't tell rooms apart. The rooms go to it as one
  JSON value. Campfire numbers the index's rows by message id, which grows with time. Ours are
  strings, and each room's messages reach the index on their own schedule, so the index numbers the
  messages it takes itself (`search_messages`): a message's time in milliseconds, times 1,024, plus
  its place among that millisecond's. Walking the index from its largest number then goes from the
  newest message, whichever room it's in and however late it came, with nothing to sort, which a
  test checks with `EXPLAIN QUERY PLAN`, and an edit keeps its number. Over 100,000 messages in 50
  rooms, a search for a word in a quarter of them takes 0.3 ms of SQLite for someone in every room,
  where reading all 1,000 matches took 1.2 ms; for someone in one of the 50, passing over the
  matches in the other 49 on the way to a page of theirs takes about 3 ms, where reading the 1,000
  and then their room's matches took about 12. A word in one message takes 0.03 ms.
- **Search filters are conditions on the index's own rows.** Slack narrows a search with modifiers
  such as `in:`, `from:` and `has:link`, which Campfire has none of. The index keeps what they narrow
  by beside each message (search migration 0003): who wrote it, the thread it's in, whether it has a
  link or a file, and, in `search_mentions`, whom it mentions. Includes me finds the messages that
  mention you, are in your DMs, or are in threads you've written in. A search's filters are
  conditions it checks as it walks the index, newest first or oldest, so they cost nothing while the
  first matches meet them. A search of filters alone has no words to walk, so it walks the messages
  of the searcher's rooms, and no other room's: each room's through an index that starts with the
  room (search migration 0004), of just someone's messages there, or the ones with files, with links
  or in threads, when the search has such a filter, and one recursive query takes whichever room's
  message comes next, so nothing is sorted and a room is read only as far as the page goes. Includes
  me has no index, so it's checked message by message. It used to walk every room's newest 1,000
  messages first, and then someone's in every room, so the time it took told a searcher how much was
  written in rooms they aren't in, and when: a test checks that it reads the same rows whatever
  those rooms hold. No search reads 0003's indexes on the person, links and files alone now, which
  run through every room. Over 300,000 messages in 50 rooms, a page of the messages with files takes
  0.9 ms of SQLite for someone in every room, where sorting their rooms' took 270 ms, and Includes
  me 4 ms for someone with five DMs; with nothing to find, it reads every message of their rooms,
  about 2 µs each. Show more starts past the number of the last match shown, so each page is read as
  the first was, and FTS5's `highlight` gives the words each match matched, as its text has them, for
  results to mark. Workspace migration 0047 had every room log its messages once more, for the index
  to take each with its filters.
- **Is there another page?** We fetch one more row than the page holds, rather than counting the
  room.
- **A created message answers with the row it stored** rather than reading it back.
- **Boosts are indexed by message**, as Campfire's are by `index_boosts_on_message_id`.

### Still to do

- **Names from the users table.** People have their own table now, but we still copy the sender's
  name into each message and boost. That's fine while names can't change, but renaming someone would
  leave the old name on their messages.

### Left out

- **Message bodies in their own table.** That's Rails' Action Text, and it costs a join or a second
  query on every page. Our bodies stay in `messages`.
- **Deleting a message's boosts in application code.** Rails deletes dependents itself; our foreign
  key cascades, so the database does it in the same statement.
- **SQLite tuning:** WAL checkpoints off the writer thread, the prepared-statement cache, no memory
  mapping. Cloudflare runs SQLite for both backends, so there's nothing for us to set.
- **Integer message ids.** Campfire's search index is numbered by message id, an integer. Ours
  numbers its messages itself (above), so ids stay 16-character sortable strings, which each room
  makes alone, where integers shared by every room's messages would need one counter they all ask.
  At 100,000 messages, `INTEGER PRIMARY KEY AUTOINCREMENT` made a room's storage 25% smaller (19.7
  MB against 26.2 MB), which isn't worth renumbering every stored message, its boosts and the links
  to it.

### Ember's own choices

- **Bodies are stored as they show, with their plain text and whom they mention.** Campfire keeps
  each body nearly as its sender wrote it, in `action_text_rich_texts`, and sanitizes it each time
  it renders one. Our clients render, so the room sanitizes once, as a message is written or edited
  (`prepareBody` in `packages/richtext`): `messages.body` holds the markup it shows, `plain_text`
  its plain text, which Campfire writes only to its search index, and `mentions` the ids of the
  people it mentions as a JSON array, so a page of history is sent without parsing anything. A
  paragraph of plain text, which is what the composer sends, is read without parsing it, in a few
  microseconds; parsing anything else costs a write about 0.1 ms of CPU, and up to 1 ms in a room
  that has just started. A body that can't be shown is refused rather than stored. `edited_at` is
  when a message's text last changed. Room migration 0012 turned the plain-text bodies from before
  it into the paragraph Lexxy sends for typed text, in SQL, and set `edited_at` from `updated_at`
  for the messages already edited.
- **Sessions keep a digest of their token.** Campfire stores each session's token as it is and signs
  the cookie that carries it. We store an HMAC of the token, keyed by `SESSION_SECRET`, so a leaked
  database or backup holds no live sessions; changing the secret still signs everyone out, as
  changing Campfire's does.
- **Sessions know which sign-in links they've ended.** Campfire's sign-in links are signed ids of
  their person, which work until they expire. Ours name the session that showed them too, and work
  only while it's signed in. A new password saved from a profile, and Disconnect Memberful, end the
  person's other sessions and keep the one that asked, so `sessions.transfers_since` (workspace
  migration 0064) holds when that was, and a link the session showed before then signs nobody in.
- **Passwords are scrypt digests.** Campfire keeps bcrypt digests, which Workers could only make
  with bcrypt compiled to WebAssembly. `users.password_digest` holds
  `$scrypt$ln=15,r=8,p=3$<salt>$<hash>` (the PHC string format), made by Node's `crypto.scrypt`,
  which Workers run natively under `nodejs_compat`, at OWASP's cost, 32 MiB and under a quarter of a
  second of CPU, and memory-hard where bcrypt isn't. Since a digest names its scheme and cost, a
  stronger one takes over by rehashing at sign-in, which is how the PBKDF2-SHA256 digests Ember made
  before scrypt (`$pbkdf2-sha256$i=100000$<salt>$<hash>`, the most iterations Web Crypto allows on
  Workers) are replaced as their passwords sign in. A request on Workers Free gets 10 ms of CPU, so
  hashing runs in a `PasswordHasher` Durable Object made for it, whose requests get 30 seconds.
- **Guests are marked.** `users.guest` is 1 for people who signed in with just a name, which only
  Ember allows, so turning `EMBER_GUEST_SIGN_IN` off keeps them out without deleting anyone. Unless
  they're administrators, they aren't given the join link's code, since an account they made with it
  would stay.
- **Sessions are kept in memory.** Campfire looks up each request's session in its database. Ours
  live in the Workspace, which every request and socket upgrade calls, and on D1 the lookup would
  add a round trip to each. So the Workspace keeps the 10,000 sessions used most recently
  (`apps/worker/src/session-cache.ts`) and reads the table only for the others. It changes every
  session itself, so the copy stays current; a session deleted by hand stays signed in until the
  Workspace restarts, which every deploy does, and changing `SESSION_SECRET` still signs everyone
  out.
- **Revocations go through an outbox.** A change that ends someone's access closes their sockets,
  which are spread over rooms' Durable Objects, which the Workspace has to call, and any call can
  fail. So the change also writes a `pending_revocations` row for each room, in the same batch, and
  sends each room its own before it answers: the rows queued and not yet tried, the rooms queued
  last first and every row of each, in up to 40 rooms. The alarm sends what's due, up to 40 rows a
  run, six rooms at a time, and never alongside a change's delivery: one delivery at a time, since
  each settles the rows it read by id, and a deleted row's id can go to the next row queued. The
  change waits up to two seconds for the rooms, and leaves one that takes longer to the alarm, set
  as the rows were queued, which puts a failed row off for 1 second, then 2, 4 and so on up to 5
  minutes, and never gives it up: a revocation given up would leave the sockets it closes open, and
  able to write, and a room's deletion its messages stored. Its index on `due_at` finds the rows
  that are due. The change sets the alarm even when D1's answer to it is lost, since it may have
  been saved anyway, and a Workspace that starts sets it for any rows waiting, which one that
  stopped in between leaves. A room keeps the time of each revocation it has had in `revocations`
  for five minutes. It turns away a socket the Workspace let through at or before one of them, which
  was checked just before the change and slow to arrive, and any socket let through over a minute
  before it arrives, which a revocation the room has since forgotten could cover.
- **Bans are Campfire's `bans`.** Banning someone records each address on their sessions in a `bans`
  row (workspace migration 0018), with Campfire's indexes: by address, which a room socket's check
  reads, and by person, which lifting the ban deletes. They're written in the batch that ends the
  person's sessions, marks them banned and queues closing their sockets and deleting their messages,
  the addresses going to the `INSERT` as one JSON value, so it binds the same few values however
  many sessions there were. Someone banned keeps their memberships, but a room opened to everyone
  meanwhile leaves them out, as it does anyone not active, so the batch that lifts the ban puts them
  in every open room, as joining does.
- **Banned addresses are kept in memory.** Campfire reads `bans` for every request that would change
  something. Here the Worker asks the Workspace before each such request, and the Workspace answers
  from the set of banned addresses it keeps, so the check costs that call but never a database read,
  even on D1. It reads the set again after a ban or a lifted ban, and doesn't keep a read that one
  overtook. A room socket's check reads the address's ban in the statement that already reads the
  person's membership, so it costs nothing more and never waits on that set. Banning addresses, or
  lifting their ban, queues closing the sockets from each in every room: one `INSERT ... SELECT`
  joins `rooms` with the addresses, sent as one JSON value, writing a `pending_revocations` row for
  each.
- **A ban deletes messages through the outbox, a page at a time.** Campfire's
  `RemoveBannedContentJob` finds a banned person's messages through `index_messages_on_creator_id`
  and deletes them one by one. Ours are spread over rooms, so the batch that bans someone writes a
  `pending_purges` row for every room they could have written in: every shared room, since they may
  have left one, and each DM of theirs. The Workspace's alarm asks each room to delete 100 of their
  messages at a time, each deletion a change of its own that tabs catch up on, and asks again at
  once while the room has more, so a big room never holds the room's object for long. It delivers
  revocations first, and 40 rows a run in all, and puts off a room it can't reach as it does a
  revocation, never giving up, which would leave the messages up. Nor does it ask a room while that
  room has sockets left to close, so a banned person can't write through one after their purge there
  is done; the room's purges wait for its revocations, and are due no sooner. Deleting a room drops
  its purges, since its messages all go anyway, so their ids are `AUTOINCREMENT`, never handed out
  again: the alarm settles a purge by its id once the room has answered, and a ban meanwhile could
  otherwise give a new purge the id of one deleted with its room. Lifting the ban records when on
  each purge still waiting, and the room then deletes only what they wrote by then. What they write
  once they're back stays however late a room answers, and what a socket of theirs sent before the
  room closed it still goes.
- **Deleting your account purges as a ban does, and keeps the row.** Apple asks that deleting an
  account delete what it shared, so the batch that deletes someone's account ends their sessions,
  queues closing their sockets by their person tag, which also turns away an AI app's message
  already on its way, queues a purge in every room they could have written in, as a ban does, takes
  them out of every shared room, forgets their stars, recent searches, push subscriptions, sign-ins
  and connected apps, queues deleting their photo, and empties their row: named "Deleted person",
  with no email address, password, bio or photo, deactivated, and `users.deleted_at` (workspace
  migration 0068) saying why, which no ban or lifted ban can change. The row stays, since what's
  left in rooms keeps their id, such as a thread's first message, kept for its replies. Their purge
  deletes all their messages, 100 at a time, then their boosts on others' messages, through
  `index_boosts_on_room_id_and_booster_id` (room migration 0069), then renames them on what's left
  in one `UPDATE` through the index by creator.
- **Granting rooms is one statement.** Campfire's `grant_to` binds the ids of everyone a room takes
  in, which our bound-value limit would cut to a few dozen rows a statement, and reading them first
  would cost D1 a round trip of its own, so each grant selects from `users` or `rooms` inside its
  `INSERT`, one statement however many there are.
- **Changing a room is one batch.** Campfire saves a room's name and kind, then revises its members
  in a second write (`Rooms::ClosedsController#update`), so a failure between the two leaves a
  private room with its old members. Ours renames the room, changes its kind, adds and takes out its
  people and queues closing the sockets of everyone taken out in one batch, which passes the members
  as one JSON value, so it binds the same few values however many there are.
- **Deleting a room takes two steps, and leaves its id behind.** A room's members and its messages
  live in different objects, so the Workspace deletes the room and its members, and queues closing
  every socket in it, in one batch, and the room's object deletes its messages, their boosts going
  through the foreign key, when that reaches it. The object keeps the time of the deletion for five
  minutes, as it keeps any revocation, then its alarm erases what's left; on DO SQLite that's all
  its storage, and an object with none ceases to exist. The Workspace records the room's id in
  `deleted_rooms`, since registering `LEGACY_ROOMS` would otherwise bring a deleted legacy room
  back.
- **A room's icon is a column of the room**, `rooms.icon` (workspace migration 0009), null for the
  default `#`, read with the room and saved in the same batch as its name and access. Saving the
  icon a room already has leaves `updated_at` alone.
- **Stars are rows of their own**, a `favorites` row for each star (workspace migration 0013), keyed
  by person and room, whose `position` orders them, so a star or unstar writes its row and bumps its
  person's `users.favorites_version`, in one batch. That version is how a tab keeps the newer of two
  lists of their stars, which can reach it in either order. Reordering them sets every `position` in
  one `UPDATE ... FROM json_each`, given the new order as one JSON value, so it binds the same few
  values however many stars there are, and changes nothing unless the order holds exactly their
  stars. A star outlives its person's membership: it's left out while they can't star the room, and
  dropped at their next star, unstar or reorder.
- **A room's place in the shared order is a column of the room**, `rooms.shared_position` (workspace
  migration 0020), so the sidebar's statement reads each room's place with the room, and listing the
  order costs nothing more, nor reads the places of rooms someone isn't in. Saving it reads the
  order, with whether the administrator could order each room in it, merges their list in, then
  numbers every room it ranks in one `UPDATE ... FROM json_each`, skipping those already in place,
  and unranks the rest in another, given the merged order as one JSON value, so it binds the same
  few values however many rooms it ranks. The Workspace saves it one at a time with the changes that
  decide who can see a room, so nothing comes between the read and the writes. A deleted room leaves
  the order with its row. Whether only administrators create rooms stays in the account's settings,
  as in Campfire, and the Workspace keeps it with the rest of the account it has read.
- **A room's huddle is columns of the room.** A huddle's sockets are its room's object's, which
  alone knows who's in it, and Campfire has nothing like one. For everyone in the room to see it, in
  the huddle or not, the Workspace keeps who's in it, a JSON list of their ids in the order they
  joined, and when it started, in `rooms.huddle_user_ids` and `rooms.huddle_started_at` (workspace
  migration 0051), so the sidebar's statement reads each room's huddle with the room, and listing
  them costs nothing more. The room tells the Workspace whenever who's in its huddle changes, one
  call at a time, so the changes made while a call is out go together in the next, and the Workspace
  tells everyone in the room on their workspace sockets. Each report carries the room's own time for
  it, kept in `rooms.huddle_reported_at`, and one no later than that changes nothing: of two that
  arrive out of order the later stands, one from before a huddle ended can't bring it back, and a
  room that was too late is told so, and reports again after it. While a huddle goes on the room's
  alarm rings every half a minute and says who's in it again, which is what makes up for a call that
  failed. A report that says what's kept reads no memberships, but its time is kept all the same,
  since a call the room gave up waiting for can still arrive after it: made earlier, that call then
  changes nothing, where it would otherwise show the wrong people until the room's next report, or
  start a huddle that's over again, with nobody left in it to say it's over (as when the Workspace
  never heard of the huddle). From before the Workspace hears of anyone until it has heard that the
  huddle is over, the room's object keeps the room's id in its own storage (`huddleRoom`), so the
  alarm can say so with nobody left in it, whatever became of the object meanwhile. The tracks
  Cloudflare's Realtime SFU didn't close when asked wait there too (`huddleUnclosed`), for the alarm
  to ask about again, and since the alarm then rings far more often than a failed log is sent again,
  the room keeps when its logs are next due (`logsDue`).
- **A huddle's message is a message's row.** The message a huddle has in its room is a row of
  `messages` like any other, in the name of whoever started the huddle, so its time, link,
  reactions and thread are a message's. What it says of its huddle is JSON in `messages.huddle`
  (room migration 0066), as a file is in `attachment` and a bot's cards in `cards`: when the huddle
  started, and once it's over, when it ended and who was in it, by the names and pictures they had
  then. Who's in it meanwhile isn't kept there, since a tab has that from the room's huddle in its
  sidebar, so the row is written twice for most huddles, however many come and go. Each write takes
  the room's next `change_seq`, so a tab that connects again catches up on it, and is logged for the
  search index, but the row has no `room_events` row: it marks the room unread for nobody, isn't its
  latest activity, and reaches no push or webhook. The room's object keeps the message's id in its
  own storage (`huddleMessage`) from before it writes the row, so a write whose answer it never had
  isn't made twice, and with it when the huddle started, everyone who has been in it, since the
  huddle's sockets only say who's in it now, and when it was found over. The id is the huddle's to
  give as it starts, and its sockets carry it, so that each tab that joins is told which message's
  thread is the huddle's, to show beside the people in it. The alarm that says who's in the huddle
  again brings the message in step with it too, which makes up for a write that failed, and for an
  object that came back with nobody left in its huddle. A row still unwritten as its huddle ends is
  written then, saying that it's over, and one deleted before the room heard that it was written
  stays deleted.
- **Rooms are named by their ids, and some have no creator.** A room's id names its Durable Object
  too, so it's a 16-character sortable string like a message's rather than an integer, and its kind
  is `open`, `closed` or `direct` rather than Rails' class name. The rooms from before the Workspace
  kept a list, which `LEGACY_ROOMS` registers, keep their old addresses as ids and have no creator.
- **The first room is found through an index.** The workspace's first room, where the welcome card
  shows, is its oldest, as Campfire's `Room.original` is, which sorts every room by `created_at` to
  find it. Every sidebar here asks, so `index_rooms_on_created_at_and_id` (workspace migration 0014)
  finds it at once. Our ids sort by time too, but not the old addresses of the rooms `LEGACY_ROOMS`
  registers.
- **The welcome card is dismissed in a column of the person.** Only active administrators are given
  it, until they dismiss it, which `users.invitation_dismissed_at` records (workspace migration
  0036), so it stays dismissed on every device they sign in on, whatever their role later. The
  sidebar reads it in the statement that already reads the version of their stars, so it costs no
  statement more.
- **Each group of people has one DM, found by its key.** Ember keeps each DM's members' ids, sorted,
  as a JSON array in `rooms.direct_key` (workspace migration 0016), under a unique index. Starting a
  DM is one batch: it adds the room unless the key has one (`ON CONFLICT DO NOTHING`), puts the
  group in it only if it was added, and reads the DM the key names. So it costs the same however
  many DMs there are, and two people starting the same DM at once get one between them. A DM's
  members never change, so its key stays true.
- **A DM's place is the time of its latest message, which the Workspace writes as it applies it.**
  The Workspace keeps when a DM's latest message came in `rooms.last_message_at` (workspace
  migration 0017), set by the statement that records the events a room sent (`applied_seq`, below)
  when they hold a message, and never moved back, so events sent again or late change nothing. Until
  a DM has one, it goes by `created_at`. The sidebar's statement reads the time with each room, so
  listing DMs in order costs nothing more.
- **Rooms send the Workspace their change logs.** Unread marks are the Workspace's and messages
  their rooms', so a room logs each new message in `room_events`, in the batch that stores it, and
  each time someone opens it in a shown tab, then sends the Workspace its oldest events, up to 50 a
  call, and deletes them once they're applied. One call is out at a time, and after each the room
  waits up to 250 ms for more, less if the call was full or 50 more are logged sooner, so a room
  makes at most four calls a second until its calls fill. On D1 a call is three queries: reading the
  log, the Workspace's batch and the delete, all in the one database every room writes to. A call
  that fails is tried again by the room's alarm, after 1 second, then 2, 4 and so on up to 5
  minutes, and the room makes no other call meanwhile, however busy it is. The Workspace applies a
  call's events in one transaction and records the last in `rooms.applied_seq`, so events sent
  again, as when the room's answer is lost, change nothing; the log's `AUTOINCREMENT` keeps a number
  from coming back once its event is deleted. Reads go through the log too, so a read can't overtake
  the message before it.
- **Messages are indexed by `(room_id, creator_id, client_message_id)`.** Campfire posts each
  message over HTTP and knows one wasn't stored when its request fails. Ours go over the room's
  WebSocket, which can close after the room stored a message but before its confirmation arrived, so
  after a reconnect the client asks the room which of its unconfirmed messages it has
  (`message.check`). The index keeps that lookup at about 0.05 ms however big the room gets, where
  reading every message took 12 ms at 100,000 messages. Banning someone finds their messages through
  it too, as Campfire's `index_messages_on_creator_id` does: a page of one person's messages in a
  100,000-message room takes 0.06 ms, where room migration 0002's `(room_id, client_message_id)`
  would read the whole room's, 7.8 ms. Room migration 0019 put it in that index's place, so a new
  message writes one index, as before: about 80 bytes of it, 20 more than before, in the same 4 µs.
- **The search index is a Durable Object of its own, with its own storage.** Campfire's index is a
  table in its one database. Ours is the `SearchIndex` object, as an FTS5 query over a big index can
  take milliseconds that no room or the Workspace should wait for, and its tables stay in that
  object's SQLite storage on either backend: D1 can't export a database that holds a virtual table,
  which would leave a D1 deployment with no export. So its schema is in
  `apps/worker/search-migrations/`, which wrangler never applies to D1, listed in
  `SEARCH_MIGRATIONS`.
- **Rooms send the search index their changes through a log of their own.** Campfire writes its
  index after the transaction that changes a message commits. Ours is in another object, so the
  batch that writes, edits, boosts or deletes a message logs its id in `unindexed_messages` (room
  migration 0021), and the room sends the index those messages as they are by then, the same way it
  sends the Workspace its change log (above): 50 at a time, one call out, and its alarm trying a
  failed call again, deleting them once the index has them. But it waits its 250 ms before each call
  rather than after, so a search finds a new message about a quarter of a second after it's written,
  rather than as the Workspace hears of it. With the index's calls going at once, timing each step
  of the perf suite's `unread` scenario on D1 showed the Workspace's call for a quiet room's first
  message starting 8 ms later, behind the index's. With them waiting, it starts as it did before the
  index, and the first unread mark took 28 ms (median of eight runs) against 25 before, inside the
  20 to 40 ms it spreads over between runs of either. The index takes a call in one batch and
  records the last entry it took from each room in `search_rooms`, so a call that arrives after a
  later one changes nothing, and a deleted room's is set past any number, so a late call can't bring
  its messages back. A message the room no longer has leaves the index.
- **Messages from before the index are logged once, through the Workspace's outbox.** Workspace
  migration 0022 queues a `pending_reindexes` row for every room, as registering a legacy room does,
  and the Workspace's alarm asks each room to log all its messages, after the revocations and purges
  it delivers, putting off a room it can't reach as it does a purge, but never giving up. Workspace
  migration 0040 does it once more, for the index to keep what results show of every message (below).
- **Search results come from the index.** Campfire reads the matching messages in the query that
  finds them. Ours live in their rooms, so the index keeps each message's row as its room sent it,
  boosts and all, as JSON in `search_messages.message` (search migration 0002), and a search answers
  from that alone. A search reads it only for the matches on its page. Results show a
  message as the index last took it, so an edit, a boost or a deletion shows once the room's log
  reaches the index, as a new message is found, where Campfire's are as of the search. Before, on DO
  SQLite the Worker asked each room with matches for its own, six rooms at a time, waking every room
  a search matched, and on D1 it read them all in one query, by id. It still does for a match the
  index has no row for: one it took before it kept them, or one longer than 600,000 characters as
  JSON (a row of DO SQLite takes 2 MB), as a bot's cards can make one. In the perf suite's `search`
  scenario, 20 rooms of 250 messages, searching for a word in a quarter of them took 6.6 ms (p50) on
  DO SQLite, against 13.8 ms when it asked the rooms, and 5.4 ms for a word in none; on D1, 7.2 ms
  against 8.5.
- **Each person has a recent search once, ordered by a number.** Campfire's `searches` gives each a
  row id, looks a search up before touching it or adding it, and orders them by when they were last
  searched for (`Search.record`). Ours are keyed by person and search (workspace migration 0023), so
  recording one is one upsert that numbers it one past the person's highest, and two searches can't
  tie, as two in the same instant could by time. The batch that records it also forgets all but the
  newest 10 and reads them back with the rooms the search needs, so searching takes the Workspace
  one round trip, as it did before searches were recorded. A search with filters is the JSON of its
  words and the filters it has on (`searchKey`) in `recent_searches` (workspace migration 0048),
  which started as a copy of `searches`, trimmed with each run of spaces made one as `searchKey` makes
  them, so the same search isn't kept twice, and whose rows stay for the release before.
- **Each browser's subscription is saved once, in one batch, and each person keeps ten.** Campfire
  looks a subscription up by its endpoint and keys before adding it or touching it, with an index on
  those three in `push_subscriptions` and another on the person, so two saves at once can add it
  twice, a browser saving other keys adds another, and a person can keep any number, each of which
  every message that notifies them is pushed to. Ours requires the endpoint and keys, which its
  columns don't, and has one unique index on the person and the endpoint (workspace migration 0035,
  which replaced 0024's on the person, the endpoint and the keys), since a push service's endpoint
  names one browser's subscription: saving is one upsert that replaces a browser's keys, and the
  same index, led by the person, lists someone's subscriptions and finds the one a browser names as
  it signs out. The batch that saves one forgets the person's past the ten they saved most recently
  (`MAX_PUSH_SUBSCRIPTIONS`), so no message is pushed to anyone more often than that, however many
  they save. The web app saves a browser's again each time the workspace opens there with
  notifications on, so the ten are the browsers opened most recently, and one pushed out comes back
  when it's next opened. Like Campfire's, they're numbered with `AUTOINCREMENT` (workspace migration
  0026), since a push service answers that a subscription is gone only after the push to it went
  out, and the Workspace then forgets it by its number, which SQLite would otherwise give the next
  subscription saved once the newest is deleted. A subscription belongs to one address's service
  worker, and ours can answer at several, so a save can name, by its P-256 key, the subscription the
  same browser had at the address its page moved from, and the same batch forgets that person's with
  that key, reading only their rows through the same index.
- **A message's pushes are found as the Workspace applies its event.** A room names the message in
  its `room_events` row (room migration 0025), so the query that reads the room's log reads each
  message's plain text and mentions with it, by the message's key, as they are then; a message
  deleted since has none, and isn't pushed. The Workspace finds a message's recipients and badges in
  one query, in the batch that applies the room's events, just after the message's unread marks,
  through the memberships' key, the subscriptions' index led by the person and, for the badge,
  `index_memberships_on_user_id_and_room_id`. So pushes add no round trip to either object. An
  invitation into a huddle is pushed by one more statement of that shape, in the call by which its
  room has the Workspace invite people: it reads the memberships of the people invited by their key,
  however many the room has, and their subscriptions and badges as a message's does. Nothing is
  stored of who has Ember in view, which decides who is pushed one: each workspace socket keeps
  whether its tab is shown in its attachment, as a room's socket does.
- **A bot is found by its id, so its token needs no index.** Campfire keeps a bot's token in
  `users.bot_token` under a unique index, and finds the bot a key names by its id and token together
  (`User.authenticate_bot`). Ours keeps the token in the same column (workspace migration 0027)
  without the index: a key is the bot's id and its token, so the primary key finds the bot, and two
  bots with the same token would still have different keys. A bot has at most one webhook, so
  `webhooks` is keyed by the bot, where Campfire's numbers its rows and indexes their `user_id`, and
  a bot has a row only while it has a URL to deliver to.
- **A file's record lives in its room, and R2 keeps what serving it needs.** Campfire keeps every
  file in Active Storage's `active_storage_blobs`, numbered, with its key under a unique index and
  an MD5 checksum, and finds a blob by its signed id to serve it. Ours keeps the room's files in its
  own `blobs` (room migration 0028), keyed by Active Storage's 28-character key, which R2 names the
  file by too (`files/<key>`). R2 keeps the file's type and name with it, and its address is signed
  with its key, so serving a file reads nothing but R2. `metadata` is the JSON Active Storage
  writes, and R2's ETags stand in for the checksum. A file goes up in parts
  (`apps/worker/src/files/uploads.ts`), so the row also keeps R2's multipart upload and the parts it
  has, as JSON, until `completed_at` says R2 has put them together. Deleting a room deletes its
  rows; its files in R2 go with plan 7.6.
- **A message's file is part of its row.** Campfire attaches a file to its message through Active
  Storage's `active_storage_attachments`, a table of its own, which on D1 would cost a page of
  messages another round trip. A message has at most one file, so ours keeps it as the message shows
  it, as JSON in `messages.attachment` (room migration 0029): its key, name, type, size, and an
  image's width and height. A page of messages reads no other table for it, and its addresses are
  signed as the page is answered. An upload's row in `blobs` keeps the id the app gave its message
  and, once the room posts it, the message's, so a part sent again answers with the same message.
- **Accounts elsewhere are linked by their issuer and subject.** Signing in with Memberful links
  someone here to a member of a Memberful site in `identities` (workspace migration 0037), keyed by
  the issuer, the site's origin, and the subject, the member's id there, so a member of another site
  never signs in as anyone here; a unique index on `(user_id, issuer)` links each person to one
  account a site at most. Email addresses never link accounts, since Memberful makes an account for
  whoever registers an address, without checking it's theirs: someone new whose Memberful email
  address someone here has is refused by `users.email_address`'s unique index, and their person,
  identity, session and open rooms are one batch, so nothing is left behind. Whether Memberful's
  members join with it, and whether only they sign in, are two more of the account's settings
  (`memberful_join` and `memberful_sign_in`, the first read as the second while it's absent, as in a
  workspace saved before it), and so are the site's keys an administrator gave in Set up Memberful
  (`memberful_keys`, above), whose secrets are sealed, unless Worker secrets take their place. The
  table names no provider but by its issuer, so another provider would need no
  migration. People who sign in this way have no `password_digest`. Someone with an account from
  before connects one once their password checks out: `pending_identities` (workspace migration
  0039) keeps the connection's OAuth state, as its HMAC under SESSION_SECRET, whose account it's
  for, and the digest of the password that checked out, for ten minutes, and the callback takes the
  row with `DELETE … RETURNING` before Memberful is asked anything, so each is good for one try. A
  new password deletes that person's rows, and the identity is inserted only while
  `users.password_digest` is still the one the row kept, so a new password while the callback waits
  on Memberful connects nothing either. That insert, which `identities`' unique indexes guard, runs
  one at a time with sign-ins, then a session starts unless the browser is signed in as them. A new
  password that replaces one deletes the person's `identities` rows too, in the same batch, before
  the statement that saves it, so that a reset ends every way in, while a first password keeps them,
  as does one saved without an email address, which signing in with a password takes; Disconnect
  Memberful deletes one, with the person's other sessions, push subscriptions and
  `pending_identities` rows, each statement checking that the row is still there, `password_digest`
  is still the one the Worker checked and `email_address` is one. Each row keeps the account's name and email address as Memberful last described it
  (workspace migration 0049), refreshed as it signs them in, only so their profile can name it.
- **Memberships are asked about, not taken from webhooks.** Memberful sends its webhooks in no
  particular order, so one only queues a check of a linked member in `membership_checks` (workspace
  migration 0038), keyed by issuer and subject, as `identities` is, which the Workspace's alarm asks
  Memberful's API about, up to 25 members a request, putting off those it couldn't ask as the outbox
  puts off a delivery. A webhook during a check moves the row's `queued_at` past the check's start,
  so settling the check keeps it to ask again, and `identities.checked_at` keeps when the membership
  the Workspace went by was read, by its own clock as the read began, so an older answer, a check's
  or a sign-in's, changes nothing. `membership_catch_ups` keeps when everyone linked to a site is
  next checked, once a day, while anyone is linked there: the statements that start one check
  `identities` first, and the alarm forgets one with nobody to check. The Workspace makes one due as
  it starts if none is, whether Memberful is on or not. Someone whose membership lapsed is
  suspended, `users.status` 3, in one batch that queues closing their sockets and ends their
  sessions and push subscriptions, but keeps their memberships, which saving a private room's
  settings leaves too, since they list only people active, so a renewal brings them back with their
  rooms, and grants them the open rooms made meanwhile. Making an open room private takes them out,
  as it does anyone else nobody chose, so that statement reads the room's kind before it changes.
- **Invitations are links kept by their digest.** An administrator's invitation is a row in
  `email_links` (workspace migration 0041), found by the HMAC of its link's secret under
  SESSION_SECRET, as a session is by its token's, with the address it's for, who sent it last, when
  it stops working, and whether it was emailed or why not, so no link is stored, and a lost one is
  replaced rather than shown again. A unique index on `(kind, lower(email_address))` gives an
  address one invitation whatever its case, which inviting it again gives a new link with
  `ON CONFLICT … DO UPDATE`. Looking a link up spends nothing, since mail filters open the links in
  incoming mail; joining by any way deletes the address's invitation in the batch that adds the
  person, and joins run one at a time, so two with one link add one person. `users.invited_by` keeps
  who invited someone, which lets them sign in with a password while Memberful is members only, and
  an index on `lower(users.email_address)` finds the accounts an invitation skips, since the unique
  index tells the cases apart. A request's addresses are one JSON parameter read with `json_each`,
  so it binds one value however many there are. The links someone asks for with an address at the
  email domains are rows of kind `email_domain` in the same table, one an address, which asking
  again replaces once the provider has the email, and joining by any way deletes the address's links
  of both kinds, in one statement. Saving one deletes, in its batch, those that have expired, which
  nobody joined with, through an index on `(kind, expires_at)` (workspace migration 0042), while
  expired invitations stay for administrators to send again. How often each address was asked for in
  the last hour is a row in `email_link_requests` (the same migration), by its lowercase: asking
  counts it in one batch with deleting the counts whose hour is over, through the index on
  `counted_since`, so the table holds only the last hour's addresses. An ask past the limit, or an
  email the provider refuses, is taken off the count it was added to, so that it counts the emails
  sent or being sent. The codes that reset a forgotten password count there too, and each is a row
  in `password_resets` (workspace migration 0043), one a person, by the HMAC of the code, with the
  address it was sent to and the password digest the person had then, so that changing either ends
  it: trying it is one `UPDATE … RETURNING` that counts the try only while the address, the password
  and the expiry still match and it has tries left. Using it reads it with the same conditions and
  the digest, one at a time with the Workspace's other changes that end sessions, then spends it in
  the batch that resets the password, which deletes the person's as the recovery script's reset
  does, so two at once spend it once and a password that can't be saved leaves it working. Their
  subqueries find the person through the unique index on `users.email_address`, and saving one
  deletes those that have expired, through the index on `expires_at`. Asking for a code looks for
  the account, and trying one counts the try, in a batch that first counts a time nobody was asked
  for in `email_link_requests`, under a name no address is counted under, and deletes it: a Durable
  Object keeps an answer back until what it wrote is stored for good, so writing only for an
  address with an account, or a code, would answer later for it.
- **A bot's cards are part of its message's row.** Cards, what a Slack-compatible webhook's legacy
  attachments show, are kept as JSON in `messages.cards` (room migration 0034), as a file is, rather
  than in the body as Action Text attachments, which the rich text pipeline would sanitize as
  markup, an administrator's edit would drop and outgoing webhooks would hand to bots. Their text is
  rich text in the stored form, and their plain text follows the body's in `plain_text`, so search,
  pushes and webhooks read it with no other column. A page of messages reads no other table for
  them.
- **A reply names its thread's message.** Campfire has no threads. A reply in one keeps the message it
  replies to in `messages.parent_id` (room migration 0044), and `messages.in_room` is 0 for a reply
  sent only to its thread, which the room's pages, its count and what a tab that connects again
  catches up on leave out, through an index on `(room_id, in_room, id)`. A thread's replies are read
  through a partial index on `(parent_id, id)`, which holds only replies, and so is the summary under
  a message with replies, read with the message: how many there are, when the newest came, and the
  `THREAD_FACES` people who wrote the newest, so nothing has to keep it up to date as replies come and
  go. A message deleted while its thread has replies stays, emptied, with `deleted` set, until its
  last reply goes too. `room_events.in_room` is 0 for a reply sent only to its thread, which marks
  the room unread for nobody and isn't its latest activity, and an upload's row in `blobs` keeps the
  thread it goes to in `parent_id`, and in `also_sent` whether it goes to the room too.
- **@ember's levels and model are columns of the person, and the most of each level, and the models
  people can pick, are settings.** Campfire has no AI assistant. The levels someone picks of @ember's
  Thinking and Answer length are `users.assistant_thinking` and `users.assistant_answer_length`
  (workspace migration 0045), null for a dial they haven't picked, and the model they pick is
  `users.assistant_model` (workspace migration 0046), null to follow the administrators' default.
  Their profile reads them in the statement that already reads it, and a question for @ember in a
  statement of its own, in parallel with the account and @ember's membership of the room. The most
  administrators allow is `assistant_limits` in the account's settings, kept while Ember AI is off.
  The models people can pick, each its ID, name and the format AI Gateway takes it in, are `models`
  in the `assistant` setting, beside the API token, at most 20 of them, so they're forgotten with
  the token when Ember AI is turned off. A pick that's no longer among them is kept, and followed
  again once the model is added back.
- **Who can ask an AI agent is a column of its person.** Campfire has no AI agents.
  `users.agent_access` (workspace migration 0063) is null for an agent anyone can ask, and for
  everyone who isn't an agent, `'admins'` for one only administrators can ask, and `'admin-dms'` for
  one only their direct messages reach, which is in no other room. It's on `users` rather than
  `agents` so that it outlasts the agent: deleting an agent deletes its row in `agents` and keeps its
  person, whose answers stay, and one that only administrators were told of stays untold. The
  statements that list people, such as the directory's and the mention prompt's, and the one that
  finds who answers a question, check it against the asker's role in SQL, so nobody is sent a person
  they aren't told of.

## Writing SQL here

- A write that has to be atomic is one `db.batch([...])`: it runs inside `transactionSync` on DO
  SQLite and is D1's `batch()`, so its statements all take effect or none do. D1 has no other kind
  of transaction, so don't read, decide in code and then write. Make each statement check its own
  conditions instead, with a unique index, `INSERT … SELECT … WHERE NOT EXISTS` or
  `UPDATE … WHERE … RETURNING`.
- Use one statement per query shape. SQLite can't use an index through an optional filter like
  `? IS NULL OR id < ?`.
- Never bind a list whose length depends on the data. Both backends bind at most 100 values a
  statement; use a subquery, or JSON built in SQL, instead.
- When a query has to stay fast as a room grows, check its plan with `EXPLAIN QUERY PLAN` in a test,
  as `apps/worker/test/messages.test.ts` does for history pages.
