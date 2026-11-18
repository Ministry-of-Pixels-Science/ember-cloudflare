import {
  hasWords,
  isSearchable,
  MAX_SEARCH_LENGTH,
  normalizedSearch,
  parseSearch,
  sanitizeSearch,
  SEARCH_TOO_LONG,
  searchKey,
  searchOfQuery,
  searchTerms,
  type Message,
  type Search,
  type SearchMatch,
  type SearchResults,
  type SearchSort,
} from "@ember/protocol";
import { eachAtMost, ROOMS_AT_ONCE } from "./at-once";
import { credentialsOf } from "./auth";
import { jsonBodyOf } from "./bodies";
import { sharedDb } from "./db";
import type { Env } from "./env";
import { urlOf } from "./request-url";
import { searchIndex, type IndexSearch, type SearchHit } from "./search-index";
import { indexedMessages, messagesAnywhereWithIds } from "./store";
import { workspace, type Searcher } from "./workspace";

// Searching messages, and recent searches.

const problem = (status: number, message: string) => Response.json({ error: message }, { status });

const NOT_SIGNED_IN = "Not signed in";

/**
 * `GET /api/searches?q=`: a page of the messages with every word of `q` that meet the search's filters,
 * as its address names them (`searchQuery`), in the rooms you're in, the ones you've hidden and DMs too,
 * newest first unless `sort=oldest`, from `cursor` on, with those rooms, and your recent searches. Only a
 * search with a word left once it's sanitized, or a filter, is run, and none is recorded.
 */
export async function searchMessages(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const searcher = credentials && (await workspace(env).searcher(credentials, null));
  if (!searcher) return problem(401, NOT_SIGNED_IN);
  const { search, sort, cursor } = searchOfQuery(urlOf(request).searchParams);
  if (search.q.length > MAX_SEARCH_LENGTH) return problem(422, SEARCH_TOO_LONG);
  return answer(env, normalizedSearch(search), sort, cursor, searcher);
}

/**
 * `POST /api/searches`, a `Search` and maybe its `sort`: records the search, normalized, as your newest
 * recent search, as the search page's form does in Campfire (`searches#create`), and answers its first
 * page as `GET` does. A search with no word left once it's sanitized and no filter isn't recorded.
 */
export async function recordSearch(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const asked = parseSearch(await jsonBodyOf(request));
  const search = typeof asked === "string" ? null : normalizedSearch(asked.search);
  // Asked even for a search that's refused, so that someone signed out hears that first.
  const searcher = credentials && (await workspace(env).searcher(credentials, search && isSearchable(search) ? searchKey(search) : null));
  if (!searcher) return problem(401, NOT_SIGNED_IN);
  if (typeof asked === "string") return problem(422, asked);
  return answer(env, search!, asked.sort, null, searcher);
}

/** `DELETE /api/searches`: forgets your recent searches. */
export async function clearSearches(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials || !(await workspace(env).clearSearches(credentials))) return problem(401, NOT_SIGNED_IN);
  return new Response(null, { status: 204 });
}

/** What `search` answers: the page of what it finds from `cursor` on, if it has a word or a filter, and the searcher's recent searches. */
async function answer(env: Env, search: Search, sort: SearchSort, cursor: number | null, searcher: Searcher): Promise<Response> {
  const found = isSearchable(search) ? await find(env, search, sort, cursor, searcher) : { search: null, matches: [], next: null, rooms: [] };
  return Response.json({ ...found, recent: searcher.recent } satisfies SearchResults, { headers: { "Cache-Control": "no-store" } });
}

/** The page of messages `search`, which has a word or a filter, finds from `cursor` on, in the rooms `searcher` can search. */
async function find(env: Env, search: Search, sort: SearchSort, cursor: number | null, searcher: Searcher): Promise<Omit<SearchResults, "recent">> {
  const { hits, next } = await searchIndex(env).search(indexSearchOf(search, sort, cursor, searcher));
  const matches = await matchesOf(env, hits);
  const found = new Set(matches.map(({ message }) => message.roomId));
  return { search, matches, next, rooms: searcher.rooms.filter(({ id }) => found.has(id)) };
}

/** What the index is asked for `search`: its words as FTS5's, the rooms it looks in, and its filters, with the searcher's DMs for "Includes me". */
function indexSearchOf(search: Search, sort: SearchSort, cursor: number | null, { userId, rooms }: Searcher): IndexSearch {
  const directIds = rooms.flatMap(({ id, kind }) => (kind === "direct" ? [id] : []));
  return {
    terms: hasWords(search.q) ? searchTerms(sanitizeSearch(search.q)) : "",
    roomIds: rooms.flatMap(({ id }) => (search.in === undefined || id === search.in ? [id] : [])),
    ...(search.from !== undefined && { creatorId: search.from }),
    ...(search.withMe && { includes: { userId, directIds } }),
    ...(search.hasLink && { hasLink: true }),
    ...(search.hasFile && { hasFile: true }),
    ...(search.inThread && { inThread: true }),
    sort,
    after: cursor,
  };
}

/**
 * The messages `hits` names, in the same order, with the words each matched, as the index last took
 * them, so a search asks no room: an edit or a boost shows, and a deleted message goes, once its room has
 * sent it, as a match does. A hit the index has no message for, from before it kept them or too big to
 * keep, is read from its room as it is now, and left out if its room no longer has it.
 */
export async function matchesOf(env: Env, hits: SearchHit[]): Promise<SearchMatch[]> {
  const kept = hits.flatMap(({ message }) => message ?? []);
  const [indexed, read] = await Promise.all([indexedMessages(kept, env.SESSION_SECRET), readNow(env, hits.filter(({ message }) => message === null))]);
  const found = new Map<string, Message>([...indexed, ...read].map((message) => [message.id, message]));
  return hits.flatMap(({ messageId, words }) => {
    const message = found.get(messageId);
    return message ? [{ message, words }] : [];
  });
}

/** The messages `hits` names that are still there: from D1 at once, where every room keeps them, or else from each room once. */
async function readNow(env: Env, hits: SearchHit[]): Promise<Message[]> {
  if (hits.length === 0) return [];
  const db = sharedDb(env);
  if (db) return messagesAnywhereWithIds(db, hits.map(({ messageId }) => messageId), env.SESSION_SECRET);
  const messages: Message[] = [];
  await eachAtMost([...Map.groupBy(hits, ({ roomId }) => roomId)], ROOMS_AT_ONCE, async ([roomId, inRoom]) => {
    messages.push(...(await env.CHAT_ROOM.getByName(roomId).messagesWithIds(roomId, inRoom.map(({ messageId }) => messageId))));
  });
  return messages;
}
