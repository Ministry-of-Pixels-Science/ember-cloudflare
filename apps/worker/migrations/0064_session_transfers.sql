-- Since when the sign-in links each session shows work, kept by the Workspace (scope "workspace" in
-- src/migrations.ts): a time in milliseconds, before which a link the session showed signs nobody in
-- anymore, or 0 for a session whose every link works until it expires. A new password saved from a
-- profile, and Disconnect Memberful, end their person's other sessions and keep the one that asked,
-- so they set it to then for that one, whose links would otherwise outlast them: a link works while
-- the session that showed it does (src/transfers.ts), and that session never ended.
ALTER TABLE sessions ADD COLUMN transfers_since INTEGER NOT NULL DEFAULT 0;
