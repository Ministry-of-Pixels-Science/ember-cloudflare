-- The tools of connected apps an administrator picked for @ember and for each agent, kept by the
-- Workspace (scope "workspace" in src/migrations.ts): one row an agent, by its user's id, holding a JSON
-- list of each tool's app, its name there, and its fingerprint when it was picked. An agent is given a
-- tool only while its app is connected and still has a tool by that name with that fingerprint, so one
-- whose server describes it another way since is set aside until an administrator picks it again, and
-- the picks of an app that's removed open nothing. An agent's row goes when it's deleted. One row holds
-- an agent's picks, as a statement binds at most 100 values.
CREATE TABLE IF NOT EXISTS agent_tools (
  agent_id TEXT PRIMARY KEY,
  tools TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users (id),
  updated_at TEXT NOT NULL
);
