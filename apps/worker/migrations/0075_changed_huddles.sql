-- Each room's log of its huddles' messages that the Workspace's list of the huddles that are over has
-- yet to hear of (scope "room" in src/migrations.ts): one that came to say its huddle is over, or that
-- it goes on after all, one whose thread gained or lost a reply, and one deleted, logged in the same
-- transaction as the change. The room sends the Workspace each one as it is when it sends it, and
-- forgets what the Workspace has taken (src/room-log.ts).
CREATE TABLE IF NOT EXISTS changed_huddles (
  -- Numbered as room_events are.
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS index_changed_huddles_on_room_id_and_seq ON changed_huddles (room_id, seq);

-- The huddles there have been so far, oldest first, so that the list has them too: each goes to the
-- Workspace when its room is next opened.
INSERT INTO changed_huddles (room_id, message_id) SELECT room_id, id FROM messages WHERE huddle IS NOT NULL ORDER BY id;
