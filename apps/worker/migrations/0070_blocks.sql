-- Who has blocked whom, kept by the Workspace (scope "workspace" in src/migrations.ts): user_id blocked
-- blocked_id at created_at, an ISO time. The person blocked is never told. Their messages collapse for
-- whoever blocked them, don't mark rooms unread for them or push to them, their huddle invitations
-- don't reach them, and they can't start a DM with them. Blocking hides the DM between the two of them
-- from the sidebar of whoever blocked, and direct_involvement keeps the level that DM had before, which
-- unblocking gives it back, or is null when there was no DM to hide (src/workspace.ts `block`).
CREATE TABLE IF NOT EXISTS blocks (
  user_id TEXT NOT NULL REFERENCES users (id),
  blocked_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  direct_involvement TEXT,
  PRIMARY KEY (user_id, blocked_id)
);
-- For deleting an account's blocks, the ones of it as well as its own.
CREATE INDEX IF NOT EXISTS index_blocks_on_blocked_id ON blocks (blocked_id);

-- How many times each person's blocks have changed, so that of two lists of them, a tab keeps the newer.
ALTER TABLE users ADD COLUMN blocks_version INTEGER NOT NULL DEFAULT 0;
