-- An answer waiting at a call of a connected app's tool (scope "room" in src/migrations.ts): @ember or
-- an agent called one, and each such call asks first, on a card the room posts. The row is keyed by the
-- card's message, and `call` is JSON: the question, who asked, what the card shows, the tools the model
-- was given, and its answer as far as it got (src/apps/waiting-calls.ts). A click on the card takes the
-- row, and the room's alarm takes one nobody clicks once it has waited too long to allow.
CREATE TABLE waiting_calls (
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  call TEXT NOT NULL,
  asked_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, message_id)
);
