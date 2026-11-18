import { setTimeout as sleep } from "node:timers/promises";
import type { Message, SearchResults } from "@ember/protocol";
import { closeAll, joinMany, newRoom, seedRoom } from "../load.ts";
import { signIn, type RoomClient, type Session } from "../room-client.ts";
import type { Server } from "../server.ts";
import { summarize, type Summary } from "../stats.ts";

export interface SearchOptions {
  /** Rooms the messages are spread over, all of which the searcher is in. */
  rooms: number;
  /** Messages written in each room, in all of them at once. */
  messages: number;
  /** Times to run each search. */
  searches: number;
  /** New messages to time until a search finds them. */
  newMessages: number;
}

export interface SearchResult extends SearchOptions {
  /** From the last of the messages being acknowledged until a search finds it: how far behind a burst leaves the index. */
  catchUpMs: number;
  /** From a new message being acknowledged, in a quiet room, until a search finds it. */
  newMessage: Summary | null;
  /** A word in a quarter of the messages: the newest 100, from every room. */
  common: Summary | null;
  /** A word in one message in each room. */
  rare: Summary | null;
  /** A word in none: everything a search costs but its matches. */
  none: Summary | null;
}

/** How often a search looks again for a message the index doesn't have yet. */
const POLL_MS = 10;
const FIND_TIMEOUT_MS = 60_000;

/**
 * Searches as `session`'s person, and answers what it found in `rooms` and how long it took. A server
 * that was running already has other rooms, which its person is in too, with messages that match.
 */
async function search(server: Server, session: Session, rooms: Set<string>, q: string): Promise<{ messages: Message[]; ms: number }> {
  const started = performance.now();
  const response = await fetch(new URL(`/api/searches?q=${encodeURIComponent(q)}`, server.url), { headers: { Cookie: session.cookie } });
  if (!response.ok) throw new Error(`Searching for "${q}" failed (${response.status}): ${await response.text()}`);
  const { matches } = (await response.json()) as SearchResults;
  return { messages: matches.map(({ message }) => message).filter(({ roomId }) => rooms.has(roomId)), ms: performance.now() - started };
}

/** Searches every `POLL_MS` until `found` holds, and answers when it did. */
async function searchUntil(server: Server, session: Session, rooms: Set<string>, q: string, found: (messages: Message[]) => boolean): Promise<number> {
  const deadline = performance.now() + FIND_TIMEOUT_MS;
  for (;;) {
    const { messages } = await search(server, session, rooms, q);
    if (found(messages)) return performance.now();
    if (performance.now() > deadline) throw new Error(`Searching for "${q}" found ${messages.length} messages after ${FIND_TIMEOUT_MS}ms`);
    await sleep(POLL_MS);
  }
}

/** Runs a search `times` times, one after another, checking each finds `expected` messages. */
async function time(server: Server, session: Session, rooms: Set<string>, q: string, times: number, expected: number): Promise<Summary | null> {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) {
    const { messages, ms } = await search(server, session, rooms, q);
    // A search that comes back short would pass for a faster one.
    if (messages.length !== expected) throw new Error(`Searching for "${q}" found ${messages.length} messages, not ${expected}`);
    samples.push(ms);
  }
  return summarize(samples);
}

/** Posts a message and resolves when its sender sees it come back. */
function post(writer: RoomClient, clientMessageId: string, body: string): Promise<number> {
  return new Promise((resolve) => {
    writer.onMessage = (message, at) => {
      if (message.clientMessageId !== clientMessageId) return;
      writer.onMessage = null;
      resolve(at);
    };
    writer.send({ type: "message.create", clientMessageId, body });
  });
}

/**
 * Messages written in many rooms at once, then searched for by someone in all of them: how far behind
 * the index falls, how soon a new message can be found, and how long searches take.
 */
export async function searchAt(server: Server, options: SearchOptions): Promise<SearchResult> {
  const rooms = await Promise.all(Array.from({ length: options.rooms }, (_, i) => newRoom(server, `search ${i}`)));
  const writers: RoomClient[] = [];
  for (const [i, room] of rooms.entries()) writers.push(...(await joinMany(server, room, 1, { name: `writer ${i}` })).clients);
  // Signed in after the rooms were made, so in every one.
  const searcher = await signIn(server.url, "searcher");

  // Each room's messages are numbered from 0, so "(#7)" is in one message in each.
  await Promise.all(writers.map((writer) => seedRoom([writer], options.messages, 10)));
  const seeded = performance.now();
  const last = String(options.messages - 1);
  const own = new Set(rooms);
  const caughtUp = await searchUntil(server, searcher, own, last, (messages) => messages.length === options.rooms);

  const newMessage: number[] = [];
  for (let i = 0; i < options.newMessages; i++) {
    // Long enough for the room to stop gathering what follows a call to the index, so each is sent alone.
    await sleep(300);
    const word = `fresh${i}`;
    const acknowledged = await post(writers[i % writers.length]!, `search-${i}`, `<p>Has anyone seen ${word}?</p>`);
    newMessage.push((await searchUntil(server, searcher, own, word, (messages) => messages.length === 1)) - acknowledged);
  }

  const common = await time(server, searcher, own, "deploy", options.searches, Math.min(100, options.rooms * Math.ceil(options.messages / 4)));
  const rare = await time(server, searcher, own, "7", options.searches, options.rooms);
  const none = await time(server, searcher, own, "zebra", options.searches, 0);
  closeAll(writers);

  return { ...options, catchUpMs: Math.round(caughtUp - seeded), newMessage: summarize(newMessage), common, rare, none };
}
