-- People's own sign-ins to the apps Ember is signed in to, kept by the Workspace (scope "workspace" in
-- src/migrations.ts): in a conversation between one person and an agent, the agent's calls of an app's
-- tools go with that person's sign-in to it, once they've made one, in place of the one an
-- administrator made for every agent. A row is someone's sign-in to an app: sign_in holds it as
-- apps.sign_in holds Ember's, sealed for that app and that person alone, and is null once it has
-- ended, signed_in_at says when they signed in, and scope_wanted what the app's server has asked for
-- beyond it since, as apps.scope_wanted does.
CREATE TABLE IF NOT EXISTS own_app_sign_ins (
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  sign_in TEXT,
  signed_in_at TEXT NOT NULL,
  scope_wanted TEXT,
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS own_app_sign_ins_user ON own_app_sign_ins (user_id);

-- Whether a sign-in under way is someone's own, to a connected app, rather than Ember's.
ALTER TABLE app_sign_ins ADD COLUMN own INTEGER NOT NULL DEFAULT 0;
