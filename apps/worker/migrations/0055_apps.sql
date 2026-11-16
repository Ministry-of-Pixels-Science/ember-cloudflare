-- The apps administrators connect, kept by the Workspace (scope "workspace" in src/migrations.ts): MCP
-- servers whose tools the AI agents may be given. Each is its name, its server's address, the token
-- Ember sends it, sealed under SESSION_SECRET for this app alone, or null for a server that takes none,
-- what the server calls itself, and the tools Ember read from it when an administrator last looked, a
-- JSON list of each one's name, title, description, the JSON Schema of what it takes and a fingerprint
-- of those, so that a tool whose server later describes it another way can be told apart from the one
-- the administrator saw. tools_left_out counts the tools the server has beyond those. One row holds
-- them all, as a statement binds at most 100 values and D1 runs few statements a request.
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  token TEXT,
  server_name TEXT,
  tools TEXT NOT NULL,
  tools_left_out INTEGER NOT NULL,
  tools_read_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users (id),
  updated_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
