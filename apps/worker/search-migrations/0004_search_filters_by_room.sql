-- A search of filters alone reads each room it looks in through an index that starts with the room,
-- so it never reads a row of a room it isn't looking in (src/search-index.ts `filtersStatement`).
-- 0001's holds all of a room's messages by number. These hold only those that meet a filter, so a
-- search with one walks just them: someone's, the ones with links, or files, and the ones in threads.
CREATE INDEX IF NOT EXISTS index_search_messages_on_room_id_and_creator_id_and_id ON search_messages (room_id, creator_id, id);
CREATE INDEX IF NOT EXISTS index_search_messages_with_links_on_room_id_and_id ON search_messages (room_id, id) WHERE has_link = 1;
CREATE INDEX IF NOT EXISTS index_search_messages_with_files_on_room_id_and_id ON search_messages (room_id, id) WHERE has_file = 1;
CREATE INDEX IF NOT EXISTS index_search_messages_in_threads_on_room_id_and_id ON search_messages (room_id, id) WHERE thread_id IS NOT NULL;
