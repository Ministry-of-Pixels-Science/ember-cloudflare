-- Which of a huddle's own sounds each person hears, kept by the Workspace (scope "workspace" in
-- src/migrations.ts) with the person, so that what they choose on their profile holds in every browser
-- they're signed in on, as Slack keeps its preferences with the account: the music that plays to
-- whoever is the only one in a huddle, the sounds of someone joining a huddle and of someone leaving
-- it, and the ring of an invitation into one. Each is 1 until they turn it off, which is 0.
ALTER TABLE users ADD COLUMN huddle_music INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN huddle_chimes INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN huddle_ring INTEGER NOT NULL DEFAULT 1;
