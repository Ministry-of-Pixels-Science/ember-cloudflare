-- Signing in to an app whose server asks for a sign-in, with OAuth, kept by the Workspace (scope
-- "workspace" in src/migrations.ts). apps.sign_in holds the sign-in as Ember keeps it: who Ember is to
-- the app's authorization server, what was found of it, and its tokens, as JSON sealed under
-- SESSION_SECRET for that app alone. It's null for an app nobody signed in to, and for one whose
-- sign-in has ended. signed_in_by and signed_in_at say who signed in, and when, and stay once the
-- sign-in has ended, which is how an app that wants signing in to again is told from one that never
-- was.
ALTER TABLE apps ADD COLUMN sign_in TEXT;
ALTER TABLE apps ADD COLUMN signed_in_by TEXT REFERENCES users (id);
ALTER TABLE apps ADD COLUMN signed_in_at TEXT;

-- The sign-ins under way: a row from when an administrator is sent to an app's authorization server
-- until their browser comes back, by the state it comes back with, which only the administrator who
-- began it finishes, before it expires. Each is for the connected app app_id, or with null for one to
-- connect by name at url once it's done, and holds what the sign-in needs to finish, sealed for it
-- alone.
CREATE TABLE IF NOT EXISTS app_sign_ins (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  app_id TEXT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  sign_in TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
