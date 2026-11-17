-- A huddle's message (scope "room" in src/migrations.ts): the message a room keeps of each huddle in
-- it, as Slack has one, which the room writes as the huddle starts, in the name of whoever started it
-- (src/huddles/message.ts), and whose thread is the huddle's. `huddle` is what it says of the huddle, a
-- JSON `MessageHuddle` (packages/protocol/src/huddles.ts): when the huddle started, and once it's over,
-- when it ended and who was in it. Other messages have none.
ALTER TABLE messages ADD COLUMN huddle TEXT;
