-- Outside AI: the AI apps, such as Claude and ChatGPT, that people connect to Ember over the Model
-- Context Protocol, to read it as them. Each signs in with OAuth, where Ember is the authorization
-- server, which the Workspace keeps (scope "workspace" in src/migrations.ts).
--
-- outside_clients holds the apps that registered themselves (RFC 7591): the id Ember gave each, the
-- name it gave itself, and the addresses it may have a browser sent back to, a JSON array. An app
-- whose id is the address of a document about it has no row: Ember reads the document when it's asked.
CREATE TABLE IF NOT EXISTS outside_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outside_clients_created ON outside_clients (created_at);

-- A row of outside_connections is an app connected as one person: client_id and client_name say
-- which, redirect_uri where it had their browser sent back, scope what they allowed it, by scopes'
-- names with spaces between, and resource the address it said it connects to, if it said. A row
-- starts when its person allows the app, with the digest of the code the app is sent back with, the
-- challenge the app proves it began with, and when the code expires. Once the app has exchanged the
-- code, the row holds the digests of its access and refresh tokens, with when each expires. used_at
-- says when the app last asked Ember anything, to the hour. No token is kept, only its HMAC under
-- SESSION_SECRET.
CREATE TABLE IF NOT EXISTS outside_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT,
  code_digest TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_expires_at TEXT NOT NULL,
  access_digest TEXT,
  access_expires_at TEXT,
  refresh_digest TEXT,
  refresh_expires_at TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS outside_connections_code ON outside_connections (code_digest);
CREATE UNIQUE INDEX IF NOT EXISTS outside_connections_access ON outside_connections (access_digest) WHERE access_digest IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS outside_connections_refresh ON outside_connections (refresh_digest) WHERE refresh_digest IS NOT NULL;
CREATE INDEX IF NOT EXISTS outside_connections_user ON outside_connections (user_id);
CREATE INDEX IF NOT EXISTS outside_connections_client ON outside_connections (client_id);

-- outside_spent_tokens holds the digest of each refresh token a connection has replaced, which
-- nothing but a copy presents again, so one that comes ends its connection. A row is kept until the
-- token it's of would have expired anyway, or its connection ends.
CREATE TABLE IF NOT EXISTS outside_spent_tokens (
  digest TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outside_spent_tokens_connection ON outside_spent_tokens (connection_id, expires_at);
