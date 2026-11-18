-- When someone deleted their own account (Delete my account on their profile), kept by the Workspace
-- (scope "workspace" in src/migrations.ts), as an ISO time, or null for everyone else. Their row stays,
-- as a removed person's does, so the rooms and DMs they were in still name somebody, but with nothing
-- of them left: it's deactivated, named "Deleted person", and holds no email address, password, bio
-- or avatar. Neither a ban nor lifting one finds them, and the outbox has every room they could have
-- written in delete their reactions as well as their messages (src/workspace.ts `deleteAccount`).
ALTER TABLE users ADD COLUMN deleted_at TEXT;
