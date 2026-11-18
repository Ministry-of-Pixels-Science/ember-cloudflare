-- Reports, kept by the Workspace (scope "workspace" in src/migrations.ts): reporter_id reported someone,
-- subject_id, for one of their messages, message_id in room_id, or for themselves when those are null, at
-- created_at, an ISO time, for reason, with a few words, note. subject holds, as JSON, the message or the
-- person as they were then, which the report shows the administrators whatever becomes of them. Once an
-- administrator handles it, handler_id did at handled_at, and outcome says how: "deleted" the message,
-- "removed" or "banned" whoever it reports, or "dismissed" it. Nobody else sees reports, so the person
-- reported is never told who reported them, and an administrator isn't shown the reports of themselves.
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users (id),
  subject_id TEXT NOT NULL REFERENCES users (id),
  room_id TEXT,
  message_id TEXT,
  subject TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  handler_id TEXT REFERENCES users (id),
  handled_at TEXT,
  outcome TEXT
);
-- For the open reports, newest first, and the ones handled last.
CREATE INDEX IF NOT EXISTS index_reports_on_handled_at_and_created_at ON reports (handled_at, created_at);
-- For a message's reports, which deleting it closes.
CREATE INDEX IF NOT EXISTS index_reports_on_message_id ON reports (message_id);
-- For someone's reports, which removing or banning them closes.
CREATE INDEX IF NOT EXISTS index_reports_on_subject_id ON reports (subject_id);
