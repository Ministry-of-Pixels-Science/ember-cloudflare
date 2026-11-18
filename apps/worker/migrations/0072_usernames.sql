-- Usernames, kept by the Workspace (scope "workspace" in src/migrations.ts): the one each person
-- picked, by which typing @ finds them, or null while they have none. The Worker keeps them in
-- lowercase (`usernameOf` in the protocol), so the unique index tells apart only usernames people
-- would, and it takes any number of nulls.
ALTER TABLE users ADD COLUMN username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS index_users_on_username ON users (username);
