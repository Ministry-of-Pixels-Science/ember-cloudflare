-- The huddles that are over, kept by the Workspace (scope "workspace" in src/migrations.ts) for the
-- Huddles page, which lists the latest in the rooms someone is in, as Slack's lists its recent huddles:
-- each by its message in its room, whose thread is the huddle's, with when it started and ended,
-- everyone who was in it, and how many replies its thread has. Its room sends each as its message comes
-- to say the huddle is over, and again as its thread gains or loses a reply (src/room-log.ts). One whose
-- message is deleted goes, as does one that goes on after all, and the huddles of a deleted room go
-- with it. A huddle nobody else joined is kept only while its thread has replies, as Slack keeps
-- nothing of one that left nothing behind.
CREATE TABLE IF NOT EXISTS past_huddles (
  -- A message's id sorts by when it was written, so the latest huddles to have started are the last rows.
  message_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  -- ISO times.
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  -- A JSON array of the ids of everyone who was in it, in the order they first joined.
  user_ids TEXT NOT NULL,
  replies INTEGER NOT NULL DEFAULT 0
);
-- For a room's latest huddles, which is how the page reads them: each of someone's rooms in turn.
CREATE INDEX IF NOT EXISTS index_past_huddles_on_room_id_and_message_id ON past_huddles (room_id, message_id);
