-- Who can ask an AI agent, kept by the Workspace (scope "workspace" in src/migrations.ts) on the agent's
-- user, where the people directory reads it with everyone else: null for an agent anyone can ask, as
-- every agent was until now, and for everyone who isn't an agent, 'admins' for one only administrators
-- can ask, which everyone else still reads in its rooms, and 'admin-dms' for one only administrators
-- can ask, in their direct messages with it. That one is in no other room, and nobody but administrators
-- is told of it. It's on the user, not in agents, so that it outlasts the agent: deleting an agent
-- deletes its row there and keeps its user, whose answers stay, and one that only administrators were
-- told of stays untold.
ALTER TABLE users ADD COLUMN agent_access TEXT;
