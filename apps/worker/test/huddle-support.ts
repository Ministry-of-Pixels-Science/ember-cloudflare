import type { NewWorkspace, RoomId, UserId } from "@ember/protocol";
import { huddleSocketQuery, type HuddleClientFrame, type HuddleServerFrame, type HuddleSocketParams } from "@ember/protocol/huddles";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vitest";
import { ADDRESS_HEADER, AUTHORIZED_AT_HEADER, BANNED_HEADER, HUDDLE_HEADER, ROOM_HEADER, SESSION_HEADER, USER_HEADER } from "../src/chat-room";
import { api, closeOf, cookieOf, framesOf, roomStub, shown, upgrade, type Access, type Session } from "./support";

/** A Realtime SFU app's keys, as an administrator copies them from Cloudflare's dashboard. */
export const APP = { appId: "2a95132c15732412d22c1476fa83f27a", appSecret: "66bcf64aa8907b9f9d90ac17746a77ce394c393b92b3916633dc02846e608ad4" };
/** Another app's. */
export const OTHER_APP = { appId: "f".repeat(32), appSecret: "0123456789abcdef".repeat(4) };

const SECRETS = new Map([APP, OTHER_APP].map(({ appId, appSecret }) => [appId, appSecret]));

/** Where Cloudflare's Realtime SFU answers. */
const SFU = "https://rtc.live.cloudflare.com";

/** A request the stand-in SFU was sent. */
export interface AskedOfSfu {
  appId: string;
  method: string;
  /** What's asked of the app, as the address ends: `/sessions/new`, or `/sessions/<id>/tracks/new`. */
  path: string;
  /** The session it's about, unless it starts one. */
  sessionId?: string;
  body: unknown;
}

/** A track a session pulls: the session that publishes it, and its name there. */
interface Pulled {
  sessionId: string;
  trackName: string;
}

/** A session the stand-in started, with what it carries now. */
export interface StandInSession {
  appId: string;
  /** The name of each track it publishes, by the media section that carries it. */
  published: Map<string, string>;
  /** Each track it pulls, by the media section that carries it. */
  pulled: Map<string, Pulled>;
  /** Whether it has made an offer that's still to be answered. */
  offering: boolean;
  /** The answers it took to its offers. */
  answers: string[];
  /** The media sections it closed, in the order it was asked to. */
  closed: string[];
  /** How many media sections it has offered. */
  offered: number;
}

const refused = (status: number, errorCode: string) => Response.json({ errorCode, errorDescription: `The stand-in SFU's ${errorCode}` }, { status });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Stands in for Cloudflare's Realtime SFU as far as huddles ask it, by its HTTPS API: it starts
 * sessions, takes what one publishes, offers a session what others publish and takes its answer, and
 * closes tracks, refusing what the SFU refuses: an app or a secret it doesn't know, a session it never
 * started, a track nobody publishes, and anything asked of a session whose offer is still unanswered.
 * It keeps what it was asked, and never sees a session description beyond passing it on.
 */
export function standInSfu() {
  const asked: AskedOfSfu[] = [];
  const sessions = new Map<string, StandInSession>();
  const instead: Array<{ path: RegExp; answer: (request: AskedOfSfu) => Response | Promise<Response> }> = [];
  /** The sessions that have published, in the order they first did. */
  const publishers: string[] = [];
  let offers = 0;

  function publish(sessionId: string, session: StandInSession, body: Record<string, unknown>, tracks: Array<Record<string, unknown>>): Response {
    const offer = isRecord(body.sessionDescription) && body.sessionDescription.type === "offer" ? body.sessionDescription.sdp : null;
    if (typeof offer !== "string") return refused(400, "invalid_params");
    for (const { mid, trackName } of tracks) session.published.set(String(mid), String(trackName));
    if (!publishers.includes(sessionId)) publishers.push(sessionId);
    return Response.json({
      requiresImmediateRenegotiation: false,
      sessionDescription: { type: "answer", sdp: `answer to ${offer}` },
      tracks: tracks.map(({ mid, trackName }) => ({ mid, trackName })),
    });
  }

  function pull(session: StandInSession, tracks: Array<Record<string, unknown>>): Response {
    const results = tracks.map(({ sessionId, trackName }) => {
      const published = [...(sessions.get(String(sessionId))?.published.values() ?? [])].includes(String(trackName));
      if (!published) return { sessionId, trackName, errorCode: "not_found_track_error", errorDescription: "Track not found" };
      // A session numbers its own media sections, so two sessions carry different tracks in sections of one name.
      const mid = String(session.offered++);
      session.pulled.set(mid, { sessionId: String(sessionId), trackName: String(trackName) });
      return { sessionId, trackName, mid };
    });
    if (results.every((result) => "errorCode" in result)) return Response.json({ requiresImmediateRenegotiation: false, tracks: results });
    session.offering = true;
    return Response.json({ requiresImmediateRenegotiation: true, sessionDescription: { type: "offer", sdp: `offer ${++offers}` }, tracks: results });
  }

  function close(session: StandInSession, body: Record<string, unknown>): Response {
    if (body.force !== true || !Array.isArray(body.tracks)) return refused(400, "invalid_params");
    const tracks = (body.tracks as Array<{ mid: string }>).map(({ mid }) => {
      const carried = session.published.delete(mid) || session.pulled.delete(mid);
      if (!carried) return { mid, errorCode: "close_track_error", errorDescription: "Track doesn't exist or was already closed" };
      session.closed.push(mid);
      return { mid };
    });
    return Response.json({ requiresImmediateRenegotiation: false, tracks });
  }

  function answer({ appId, method, path, sessionId = "", body }: AskedOfSfu): Response {
    if (method === "POST" && path === "/sessions/new") {
      const id = crypto.randomUUID().replaceAll("-", "");
      sessions.set(id, { appId, published: new Map(), pulled: new Map(), offering: false, answers: [], closed: [], offered: 0 });
      return Response.json({ sessionId: id }, { status: 201 });
    }
    const session = sessions.get(sessionId);
    if (!session || session.appId !== appId) return refused(410, "session_error");
    const what = path.slice(`/sessions/${sessionId}`.length);
    if (!isRecord(body)) return refused(400, "decoding_error");
    if (method === "PUT" && what === "/renegotiate") {
      const sdp = isRecord(body.sessionDescription) && body.sessionDescription.type === "answer" ? body.sessionDescription.sdp : null;
      if (!session.offering || typeof sdp !== "string") return refused(406, "invalid_session_description");
      session.offering = false;
      session.answers.push(sdp);
      return Response.json({});
    }
    // Closing tracks without the browser's say takes no exchange with it.
    if (method === "PUT" && what === "/tracks/close") return close(session, body);
    // The SFU takes one change to a session at a time, and an offer is a change until it's answered.
    if (session.offering) return refused(406, "invalid_session_description");
    if (method === "POST" && what === "/tracks/new" && Array.isArray(body.tracks)) {
      const tracks = (body.tracks as unknown[]).filter(isRecord);
      if (tracks.length === 0 || tracks.length > 64) return refused(400, "invalid_params");
      if (tracks.every(({ location }) => location === "local")) return publish(sessionId, session, body, tracks);
      if (tracks.every(({ location }) => location === "remote")) return pull(session, tracks);
    }
    return refused(400, "invalid_params");
  }

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const [, appId, path] = /^\/v1\/apps\/([^/]+)(\/.*)$/.exec(url.pathname) ?? [];
    if (url.origin !== SFU || appId === undefined || path === undefined) throw new Error(`Not a request for the Realtime SFU: ${request.method} ${request.url}`);
    const text = await request.text();
    const sent: AskedOfSfu = { appId, method: request.method, path, sessionId: /^\/sessions\/([^/]+)\//.exec(path)?.[1], body: text === "" ? null : (JSON.parse(text) as unknown) };
    asked.push(sent);
    if (!SECRETS.has(appId)) return refused(404, "not_found");
    if (request.headers.get("Authorization") !== `Bearer ${SECRETS.get(appId)}`) return refused(401, "unauthorized");
    const index = instead.findIndex((one) => one.path.test(path));
    return index >= 0 ? instead.splice(index, 1)[0]!.answer(sent) : answer(sent);
  });

  /** Everything asked of the SFU whose address ends as `path` does, in order. */
  const askedTo = (path: RegExp) => asked.filter((request) => path.test(request.path));

  return {
    asked,
    askedTo,
    sessions,
    publishers,
    /** Has the SFU answer the next request whose address ends as `path` does with `answer`, doing nothing of what's asked. */
    answerInstead: (path: RegExp, answer: () => Response | Promise<Response>) => void instead.push({ path, answer }),
    /** Has the SFU refuse the next such request, with a status and an error code. */
    refuse: (path: RegExp, status = 500, errorCode = "internal_error") => void instead.push({ path, answer: () => refused(status, errorCode) }),
    /**
     * Has the SFU hold its answer to the next such request, which it then answers as it would have,
     * until the function this answers is called.
     */
    hold(path: RegExp): () => void {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      instead.push({ path, answer: async (request) => (await held, answer(request)) });
      return release;
    },
  };
}

export type StandInSfu = ReturnType<typeof standInSfu>;

/** A tab's socket to a room's huddle, which queues every frame it receives. */
function huddleSocket(ws: WebSocket) {
  const closed = closeOf(ws);
  const queued = framesOf<HuddleServerFrame>(ws);
  ws.accept();
  return {
    ws,
    ...queued,
    /** How the socket closes, once it does. */
    closed,
    // Any frame, the ones the protocol refuses included.
    send: (frame: HuddleClientFrame | { type: string; [field: string]: unknown }) => ws.send(JSON.stringify(frame)),
    sendRaw: (data: string | ArrayBuffer) => ws.send(data),
    /** Leaves the huddle, as a tab does: by closing its socket. */
    leave: () => ws.close(1000),
  };
}

export type HuddleSocket = ReturnType<typeof huddleSocket>;

/** Joins `room`'s huddle in `session`, as a tab does, with its microphone muted if `params` says so. */
export async function joinHuddle(room: string, session: Session, params: HuddleSocketParams = { muted: false }): Promise<HuddleSocket> {
  const response = await api(`/api/rooms/${room}/huddle${huddleSocketQuery(params)}`, upgrade(session.cookie, session.ip));
  if (!response.webSocket) throw new Error(`No socket: ${response.status} ${await response.text()}`);
  return huddleSocket(response.webSocket);
}

/** Joins `room`'s huddle as the Worker sends a tab's upgrade on to the room, once the Workspace has let it through. */
export async function forwardHuddle(room: RoomId, { user, sessionId, authorizedAt, address, banned = false }: Access): Promise<HuddleSocket> {
  const response = await roomStub(room).fetch(`https://room/${room}`, {
    headers: {
      Upgrade: "websocket",
      [USER_HEADER]: JSON.stringify(user),
      [ROOM_HEADER]: room,
      [SESSION_HEADER]: sessionId,
      [AUTHORIZED_AT_HEADER]: String(authorizedAt),
      [BANNED_HEADER]: String(banned),
      [HUDDLE_HEADER]: "true",
      ...(address ? { [ADDRESS_HEADER]: address } : {}),
    },
  });
  return huddleSocket(response.webSocket!);
}

/**
 * Lets what `clients` sent before reach the room: a ping with more than its type reaches the room
 * itself, which answers it once it has read whatever the socket sent before it.
 */
export async function reached(...clients: HuddleSocket[]): Promise<void> {
  for (const client of clients) {
    client.send({ type: "ping", nonce: crypto.randomUUID() });
    await client.next("pong");
  }
}

/** Publishes `client`'s microphone with the offer `sdp`, as a tab does once it has one, and says that its connection has connected. */
export async function publishMicrophone(client: HuddleSocket, sdp = "a microphone's offer"): Promise<void> {
  client.send({ type: "huddle.publish", sdp, tracks: [{ mid: "0", kind: "audio" }] });
  await client.next("huddle.published");
  client.send({ type: "huddle.connected" });
  await reached(client);
}

/**
 * Has `client` ask to hear everyone it doesn't, on a `fresh` connection if said, and answer the offer
 * it's made, which this answers: null when it's made none.
 */
export async function listen(client: HuddleSocket, fresh = false) {
  client.send(fresh ? { type: "huddle.listen", fresh: true } : { type: "huddle.listen" });
  const offer = await client.next("huddle.offer", "huddle.listening");
  if (offer.type === "huddle.listening") return null;
  client.send({ type: "huddle.answer", sdp: `answer to ${offer.sdp}` });
  await client.next("huddle.listening");
  return offer;
}

/** Publishes `client`'s camera with the offer `sdp`, on the connection a tab keeps for it, and says that the connection has connected. */
export async function publishCamera(client: HuddleSocket, sdp = "a camera's offer"): Promise<void> {
  client.send({ type: "huddle.publish", sdp, tracks: [{ mid: "0", kind: "video" }] });
  await client.next("huddle.published");
  client.send({ type: "huddle.connected", kind: "video" });
  await reached(client);
}

/**
 * Has `client` ask to watch the cameras of `people`, and nobody else's, on a `fresh` connection if said,
 * and answer the offer it's made, which this answers: null when it's made none.
 */
export async function watch(client: HuddleSocket, people: UserId[], fresh = false) {
  client.send({ type: "huddle.listen", kind: "video", watch: people, ...(fresh && { fresh: true }) });
  const offer = await client.next("huddle.offer", "huddle.listening");
  if (offer.type === "huddle.listening") return null;
  client.send({ type: "huddle.answer", kind: "video", sdp: `answer to ${offer.sdp}` });
  await client.next("huddle.listening");
  return offer;
}

const founder = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Sets Ember up with Ada as its administrator, signed in. */
export async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(founder) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Gives Ember `app`'s keys as `administrator`, as Set up huddles does. */
export async function giveKeys(administrator: Session, app = APP): Promise<void> {
  const response = await api("/api/account/huddles", { method: "PUT", headers: { Cookie: administrator.cookie }, body: JSON.stringify(app) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/**
 * Sets Ember up with huddles on: Ada, its administrator, has given it an SFU app's keys, which a
 * stand-in for the SFU took, and has been asked nothing since.
 */
export async function huddlesOn(): Promise<{ ada: Session; sfu: StandInSfu }> {
  const ada = await setUp();
  const sfu = standInSfu();
  await giveKeys(ada);
  sfu.asked.length = 0;
  sfu.sessions.clear();
  return { ada, sfu };
}

/** Joins `room`'s huddle in `session`, and waits to be welcomed. */
export async function welcomed(room: RoomId, session: Session, muted = false): Promise<HuddleSocket> {
  const socket = await joinHuddle(room, session, { muted });
  await socket.next("huddle.welcome");
  return socket;
}

/** When the room's alarm goes off, or null when it's not set. */
export const alarmOf = (room: RoomId) => runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => state.storage.getAlarm());

/** What the room's object keeps in its own storage under `key`. */
export const kept = (room: RoomId, key: string) => runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => state.storage.get(key));

/** Runs the room's alarm, which has to be set. */
export const ring = async (room: RoomId) => expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
