-- Each room's boosts by who gave them (scope "room" in src/migrations.ts), which the room finds when
-- someone who deleted their account takes theirs with them, a page at a time (src/chat-room.ts
-- `removeEverythingBy`). Rooms keep their boosts in D1 all together, and in a room's own storage there
-- may be many of them, so without it each page would read them all.
CREATE INDEX IF NOT EXISTS index_boosts_on_room_id_and_booster_id ON boosts (room_id, booster_id);
