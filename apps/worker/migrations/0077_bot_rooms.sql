-- Whether a chat bot is kept to the open rooms an administrator picked, as an AI agent can be
-- (every_open_room in 0050_agents.sql), kept by the Workspace (scope "workspace" in src/migrations.ts)
-- on the bot's user: 1 for one that is, which an open room made, or opened to everyone, later leaves
-- out, and null for one in every open room, as every chat bot was until now, and for everyone who isn't
-- a chat bot. The private rooms a bot was put in keep it either way.
ALTER TABLE users ADD COLUMN rooms_picked INTEGER;
