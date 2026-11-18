-- The IP addresses each session's room sockets have come from, kept by the Workspace (scope "workspace"
-- in src/migrations.ts). Banning an address, or lifting the ban, tells the sockets from it to connect
-- again, and a room lets in only its members, so only the rooms of the people whose sessions came from
-- the address can hold one (src/workspace-store.ts), where every room once heard of it, more of them the
-- more people there are, since each has a DM with everyone. The Workspace records an address as it lets
-- a socket or an upload in from it, before it reads whether a ban blocks it, so a ban saved meanwhile
-- finds the session. A session's addresses go with it.
CREATE TABLE IF NOT EXISTS session_addresses (
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  ip_address TEXT NOT NULL,
  PRIMARY KEY (session_id, ip_address)
);
-- For the sessions that came from an address, which a ban finds.
CREATE INDEX IF NOT EXISTS index_session_addresses_on_ip_address_and_session_id ON session_addresses (ip_address, session_id);

-- The sockets let in before addresses were recorded may still be open, since a deploy no longer closes
-- them, so the address each session was last seen at stands in for theirs.
INSERT INTO session_addresses (session_id, ip_address)
  SELECT id, ip_address FROM sessions WHERE trim(ip_address) <> '' ON CONFLICT DO NOTHING;
