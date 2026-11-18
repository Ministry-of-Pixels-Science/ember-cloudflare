-- Puts every active person in the open rooms they aren't in, once (scope "workspace" in
-- src/migrations.ts). Until lifting a ban put someone in every open room, whoever's ban was lifted
-- stayed out of the rooms made, or opened to everyone, while they were banned, and nothing else leaves
-- anyone active out of one. Bots (role 2) are left out, since the people page bans none, and so are
-- @ember and the agents, which are bots too, an agent kept to the open rooms picked among them.
INSERT INTO memberships (room_id, user_id, created_at, updated_at)
  SELECT rooms.id, users.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM rooms, users WHERE rooms.kind = 'open' AND users.status = 0 AND users.role <> 2 ON CONFLICT DO NOTHING;
