import { APP_ID_UNKNOWN, APP_SECRET_UNKNOWN, HUDDLES_UNCHECKED, type HuddlesField, type HuddlesSetup } from "@ember/protocol/huddles";
import type { Env } from "../env";
import { isLoopback } from "../loopback";
import type { RelayKey } from "./relay";

// Cloudflare's Realtime SFU, which huddles run through, by its HTTPS API
// (https://developers.cloudflare.com/realtime/sfu/https-api/). A request names an SFU app by its ID and
// carries the app's secret as its bearer token, so only the Worker asks, and the secret never leaves it.
// What the SFU answers is logged by its status and error code alone.
//
// A session is one WebRTC connection between a browser and the SFU. A browser publishes a track on its
// session with an offer, which the SFU answers. Another pulls that track into its own session by the
// publisher's session and the track's name, which the SFU offers, and the browser answers
// (`acceptAnswer`). A session's ID finds what's published on it, so the room keeps them to itself.
// A track published in several sizes at once (simulcast) is pulled in one of them, by the name its
// publisher gave that size, its RID, and sent in another from when the SFU is asked (`resizeTracks`).

/** Where the SFU's API is. */
const SFU_API = "https://rtc.live.cloudflare.com/v1";
/** How long the SFU has to answer. */
const SFU_TIMEOUT_MS = 10_000;
/** The most of an error code of the SFU's that's logged. */
const MAX_LOGGED_CODE_LENGTH = 40;

/** A Realtime SFU app's keys: its ID and its secret, as Cloudflare's dashboard shows them when the app is made. */
export type SfuApp = HuddlesSetup;

/**
 * The app huddles run through as the Workspace tells a room of it: its keys, whether cameras may go on
 * in a huddle, and screens be shared, and the TURN key huddles' relay goes by, or null without a relay.
 */
export interface HuddleApp extends SfuApp {
  cameras: boolean;
  screens: boolean;
  relay: RelayKey | null;
}

/**
 * What the Workspace tells a room of huddles in it: the app they run through, or null while they're
 * off, and whether the room's own settings allow them. A room whose settings don't is told the app all
 * the same, which it asks the SFU as to close what a huddle there left open.
 */
export interface RoomHuddles {
  app: HuddleApp | null;
  allowed: boolean;
}

/**
 * Where the SFU's API is, and the TURN keys' beside it: the browser tests' stand-in, which
 * `REALTIME_SFU_URL` names at a loopback address, or Cloudflare's own.
 */
export function sfuApiOf(env: Env): string {
  const standIn = URL.parse(env.REALTIME_SFU_URL?.trim() ?? "");
  return standIn && isLoopback(standIn) ? `${standIn.origin}/v1` : SFU_API;
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What the SFU answers a request, and says in it, giving it `SFU_TIMEOUT_MS` to, or whatever else
 * `patienceMs` gives it. The timer goes once it has answered, where `AbortSignal.timeout`'s would run
 * on, and keep a room's object from hibernating until it rang.
 */
export async function answerOf(url: string, init: RequestInit, patienceMs = SFU_TIMEOUT_MS): Promise<{ answer: Response; said: unknown }> {
  const patience = new AbortController();
  const timer = setTimeout(() => patience.abort(), patienceMs);
  try {
    const answer = await fetch(url, { ...init, redirect: "manual", signal: patience.signal });
    return { answer, said: await answer.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

/** The error code the SFU refuses a request with, if it answers one, as far as it's logged. */
function errorCodeOf(said: unknown): string | null {
  const code = isRecord(said) ? said.errorCode : null;
  return typeof code === "string" ? code.slice(0, MAX_LOGGED_CODE_LENGTH) : null;
}

/**
 * Why `app`'s keys aren't kept, as the SFU answers a request to start a session with them: the field
 * it's about and the status to refuse them with, or null once it has started one, which says that the
 * app is there and that the secret is its own. Nobody connects to that session, so the SFU drops it by
 * itself.
 */
export async function refusalOfApp(env: Env, app: SfuApp): Promise<{ error: string; field?: HuddlesField; status: number } | null> {
  let answer: Response;
  let said: unknown;
  try {
    ({ answer, said } = await answerOf(`${sfuApiOf(env)}/apps/${app.appId}/sessions/new`, { method: "POST", headers: { Authorization: `Bearer ${app.appSecret}` } }));
  } catch (error) {
    console.error("Asking the Realtime SFU to start a session failed:", error instanceof Error ? error.name : "unknown error");
    return { error: HUDDLES_UNCHECKED, status: 502 };
  }
  if (answer.ok && isRecord(said) && typeof said.sessionId === "string") return null;
  const code = errorCodeOf(said);
  console.warn("The Realtime SFU didn't start a session:", answer.status, code);
  if (answer.status === 404 || code === "not_found") return { error: APP_ID_UNKNOWN, field: "appId", status: 422 };
  if (answer.status === 401 || answer.status === 403 || code === "unauthorized") return { error: APP_SECRET_UNKNOWN, field: "appSecret", status: 422 };
  return { error: HUDDLES_UNCHECKED, status: 502 };
}

/** What the SFU answered instead of doing what it was asked, by its status and its error code, or neither when it didn't answer. */
export class SfuError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(`The Realtime SFU answered ${status ?? "nothing"}${code === null ? "" : ` (${code})`}`);
  }
}

/** The most tracks the SFU takes in one request. */
export const TRACKS_PER_REQUEST = 64;

/** What the SFU answers when a track it's asked to close isn't there, or is closed already. */
const ALREADY_CLOSED = "close_track_error";

/** A session's ID as the SFU gives them, which goes into the address of every request about the session. */
const isSessionId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/**
 * Asks the SFU, as `app`, to do what `path` says to `body`, and answers what it said: an `SfuError`
 * unless it did, as its status and the error code at the top of its answer say. A request can do part
 * of what it's asked, so each caller reads the rest of the answer for itself.
 */
async function ask(env: Env, app: SfuApp, method: "POST" | "PUT", path: string, body?: unknown): Promise<Record<string, unknown>> {
  let answer: Response;
  let said: unknown;
  try {
    ({ answer, said } = await answerOf(`${sfuApiOf(env)}/apps/${app.appId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${app.appSecret}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }));
  } catch {
    throw new SfuError(null, null);
  }
  const code = errorCodeOf(said);
  if (!answer.ok || code !== null || !isRecord(said)) throw new SfuError(answer.status, code);
  return said;
}

/** The session description of `type` in what the SFU `said`, or null without one. */
function descriptionIn(said: Record<string, unknown>, type: "offer" | "answer"): string | null {
  const description = said.sessionDescription;
  return isRecord(description) && description.type === type && typeof description.sdp === "string" ? description.sdp : null;
}

/** What the SFU `said` of each track it was asked about. */
const tracksIn = (said: Record<string, unknown>): Array<Record<string, unknown>> => (Array.isArray(said.tracks) ? said.tracks.filter(isRecord) : []);

/** Starts a session for a browser's connection, answering its ID. One nobody connects to, the SFU drops by itself. */
export async function startSession(env: Env, app: SfuApp): Promise<string> {
  const { sessionId } = await ask(env, app, "POST", "/sessions/new");
  if (!isSessionId(sessionId)) throw new SfuError(200, null);
  return sessionId;
}

/** A track a browser publishes: the media section of its offer that carries it, and the name others pull it by. */
export interface PublishedTrack {
  mid: string;
  trackName: string;
}

/**
 * Publishes `tracks` on a session with the `offer` its browser made for them, answering the SFU's answer
 * for the browser to apply. An `SfuError` unless the SFU took every one.
 */
export async function publishTracks(env: Env, app: SfuApp, sessionId: string, offer: string, tracks: PublishedTrack[]): Promise<string> {
  const said = await ask(env, app, "POST", `/sessions/${sessionId}/tracks/new`, {
    sessionDescription: { type: "offer", sdp: offer },
    tracks: tracks.map(({ mid, trackName }) => ({ location: "local", mid, trackName })),
  });
  const results = tracksIn(said);
  const refused = results.find((track) => errorCodeOf(track) !== null);
  const answer = descriptionIn(said, "answer");
  if (refused || answer === null || !tracks.every(({ mid }) => results.some((track) => track.mid === mid))) throw new SfuError(200, refused ? errorCodeOf(refused) : null);
  return answer;
}

/** A track another session publishes, as a session pulls it. */
export interface RemoteTrack {
  /** The session that publishes it. */
  sessionId: string;
  trackName: string;
  /** The size of it to send, by that size's RID, of a track published in several. One pulled without is sent in whichever the SFU chooses. */
  rid?: string;
}

/**
 * How the SFU chooses among a track's sizes: the one `rid` names, or while that one isn't sent, or is
 * more than the connection has the bandwidth for, the next in the alphabet's order.
 */
const sizeChosen = (rid: string) => ({ preferredRid: rid, priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" });

/** A track another session publishes, as the SFU is asked for it. */
const remote = ({ sessionId, trackName, rid }: RemoteTrack) => ({ location: "remote", sessionId, trackName, ...(rid !== undefined && { simulcast: sizeChosen(rid) }) });

/** What pulling tracks into a session came to. */
export interface Pulled {
  /** The SFU's offer for the session's browser to answer, or null when it made none. */
  offer: string | null;
  /** The tracks it offers, each with the media section of the offer that carries it. */
  tracks: Array<RemoteTrack & { mid: string }>;
  /** The tracks it didn't find or couldn't add, each with the SFU's error code for it. */
  missing: Array<RemoteTrack & { code: string }>;
}

/**
 * Pulls `tracks`, at most `TRACKS_PER_REQUEST` of them, into a session, answering the SFU's offer of
 * those it found, which the session's browser answers before anything else is asked of the session
 * (`acceptAnswer`). An `SfuError` when the request itself is refused.
 */
export async function pullTracks(env: Env, app: SfuApp, sessionId: string, tracks: RemoteTrack[]): Promise<Pulled> {
  const said = await ask(env, app, "POST", `/sessions/${sessionId}/tracks/new`, { tracks: tracks.map(remote) });
  const results = tracksIn(said);
  const pulled: Pulled = { offer: descriptionIn(said, "offer"), tracks: [], missing: [] };
  for (const track of tracks) {
    const result = results.find((result) => result.sessionId === track.sessionId && result.trackName === track.trackName);
    const code = result ? errorCodeOf(result) : "missing";
    if (result && code === null && typeof result.mid === "string") pulled.tracks.push({ ...track, mid: result.mid });
    else pulled.missing.push({ ...track, code: code ?? "missing" });
  }
  // An offer is what carries the tracks to the browser, so without one it found none.
  if (pulled.offer === null && pulled.tracks.length > 0) throw new SfuError(200, null);
  return pulled;
}

/** A track a session has pulled, in the media section of it that carries the track, and the size of it to send from now. */
export type ResizedTrack = RemoteTrack & { mid: string; rid: string };

/** What asking for tracks in other sizes came to. */
export interface Resized {
  /** The SFU's offer for the session's browser to answer, should the change take one, or null. */
  offer: string | null;
  /** The media sections whose tracks stay in the size they were, each with the SFU's error code for it. */
  refused: Array<{ mid: string; code: string }>;
}

/**
 * Has the SFU send a session `tracks`, which it has pulled, at most `TRACKS_PER_REQUEST` of them, each
 * in the size its `rid` names from now. An `SfuError` when the request itself is refused.
 */
export async function resizeTracks(env: Env, app: SfuApp, sessionId: string, tracks: ResizedTrack[]): Promise<Resized> {
  const said = await ask(env, app, "PUT", `/sessions/${sessionId}/tracks/update`, { tracks: tracks.map((track) => ({ ...remote(track), mid: track.mid })) });
  const results = tracksIn(said);
  const refused = tracks.flatMap(({ mid }) => {
    const result = results.find((result) => result.mid === mid);
    const code = result ? errorCodeOf(result) : "missing";
    return code === null ? [] : [{ mid, code }];
  });
  return { offer: descriptionIn(said, "offer"), refused };
}

/** Gives the SFU the `answer` a session's browser made to its offer, which finishes what the offer began. */
export async function acceptAnswer(env: Env, app: SfuApp, sessionId: string, answer: string): Promise<void> {
  await ask(env, app, "PUT", `/sessions/${sessionId}/renegotiate`, { sessionDescription: { type: "answer", sdp: answer } });
}

/**
 * Closes the tracks a session carries in the media sections `mids`, published or pulled, without its
 * browser's say, so the SFU stops taking or sending them at once. Answers the ones it couldn't close,
 * none of which are those it says were closed already.
 */
export async function closeTracks(env: Env, app: SfuApp, sessionId: string, mids: string[]): Promise<string[]> {
  const open: string[] = [];
  for (let from = 0; from < mids.length; from += TRACKS_PER_REQUEST) {
    const asked = mids.slice(from, from + TRACKS_PER_REQUEST);
    try {
      const results = tracksIn(await ask(env, app, "PUT", `/sessions/${sessionId}/tracks/close`, { tracks: asked.map((mid) => ({ mid })), force: true }));
      open.push(...asked.filter((mid) => ![null, ALREADY_CLOSED].includes(errorCodeOf(results.find((track) => track.mid === mid) ?? { errorCode: "missing" }))));
    } catch (error) {
      if (!(error instanceof SfuError)) throw error;
      open.push(...asked);
    }
  }
  return open;
}
