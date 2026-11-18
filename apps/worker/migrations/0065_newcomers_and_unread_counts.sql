-- DMs that welcome someone new, and how many messages wait unread in a DM, kept by the Workspace (scope
-- "workspace" in src/migrations.ts).
--
-- As someone joins, everyone already here gets a DM with them, as Slack starts one, which names them in
-- newcomer_id: its timeline opens with their having joined, and their own sidebar leaves it out until a
-- message comes in it, so that someone new isn't shown everyone at once. It's null for every other room.
ALTER TABLE rooms ADD COLUMN newcomer_id TEXT REFERENCES users (id);

-- How many messages have come in a DM since its person last read it, which their sidebar shows in place
-- of the unread dot, as Slack's does. Only DMs count, since a message in a room writes only the
-- memberships it marks unread, and counting would write every member's. Marks from before this count
-- none, which the sidebar shows as one.
ALTER TABLE memberships ADD COLUMN unread_count INTEGER NOT NULL DEFAULT 0;
