-- Whether a room allows huddles, kept by the Workspace (scope "workspace" in src/migrations.ts) with the
-- room, as a Slack channel's settings keep it: 1 in every room until whoever can change the room turns
-- huddles off in its settings, which is 0, and then nobody starts or joins a huddle there, where
-- huddles are on. A direct message has no settings, so its is always 1.
ALTER TABLE rooms ADD COLUMN huddles_allowed INTEGER NOT NULL DEFAULT 1;
