import type { NewWorkspace, RoomId, UserId } from "@ember/protocol";
import { huddleSocketQuery, type HuddleClientFrame, type HuddleIceServer, type HuddleServerFrame, type HuddleSocketParams } from "@ember/protocol/huddles";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vitest";
import { ADDRESS_HEADER, AUTHORIZED_AT_HEADER, BANNED_HEADER, HUDDLE_HEADER, ROOM_HEADER, SESSION_HEADER, USER_HEADER } from "../src/chat-room";
import { api, closeOf, cookieOf, framesOf, roomStub, shown, upgrade, type Access, type Session } from "./support";

/** A Realtime SFU app's keys, as an administrator copies them from Cloudflare's dashboard. */
export const APP = { appId: "2a95132c15732412d22c1476fa83f27a", appSecret: "66bcf64aa8907b9f9d90ac17746a77ce394c393b92b3916633dc02846e608ad4" };
/** Another app's. */
export const OTHER_APP = { appId: "f".repeat(32), appSecret: "0123456789abcdef".repeat(4) };

const SECRETS = new Map([APP, OTHER_APP].map(({ appId, appSecret }) => [appId, appSecret]));

/** A TURN key, as an administrator copies it from Cloudflare's dashboard. */
export const RELAY = { keyId: "5b1e9a0c7d3f4e2a8b6c1d0e9f7a3b5c", apiToken: "9f3c5a7e1b2d4f6a8c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b9d2f4a" };
/** Another. */
export const OTHER_RELAY = { keyId: "e".repeat(32), apiToken: "0f1e2d3c4b5a6978".repeat(4) };

const TOKENS = new Map([RELAY, OTHER_RELAY].map(({ keyId, apiToken }) => [keyId, apiToken]));

/** Where Cloudflare's Realtime SFU answers, and its TURN service beside it. */
const SFU = "https://rtc.live.cloudflare.com";

/** Where the TURN service is asked for a relay's servers, by a TURN key's ID. */
const RELAY_SERVERS = /^\/v1(\/turn\/keys\/([^/]+)\/credentials\/generate-ice-servers)$/;

/**
 * The servers a tab's connections go by as Cloudflare's TURN service answers them
 * (https://developers.cloudflare.com/realtime/turn/generate-credentials/), with the name and the
 * credential it made the `nth` time it was asked, and with the addresses on port 53, which it says
 * browsers won't connect to.
 */
export const relayServersMade = (nth = 1) => ({
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: `the relay's name ${nth}`,
      credential: `the relay's credential ${nth}`,
    },
  ],
});

/** Those servers as a tab is welcomed with them: without the addresses browsers won't connect to. */
export const relayServersGiven = (nth = 1): HuddleIceServer[] => [
  { urls: ["stun:stun.cloudflare.com:3478"] },
  {
    urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turn:turn.cloudflare.com:80?transport=tcp", "turns:turn.cloudflare.com:5349?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"],
    username: `the relay's name ${nth}`,
    credential: `the relay's credential ${nth}`,
  },
];

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

/** A track a session pulls: the session that publishes it, its name there, and the size of it the session was last sent, by its RID, if it asked for one. */
interface Pulled {
  sessionId: string;
  trackName: string;
  rid?: string;
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

/** The size a session asks to be sent of a track it pulls, by its RID, or undefined when it asks for none. */
const ridAsked = ({ simulcast }: Record<string, unknown>): string | undefined => (isRecord(simulcast) && typeof simulcast.preferredRid === "string" ? simulcast.preferredRid : undefined);

/**
 * Stands in for Cloudflare's Realtime SFU as far as huddles ask it, by its HTTPS API: it starts
 * sessions, takes what one publishes, offers a session what others publish and takes its answer, sends
 * a track in another of its sizes, and closes tracks, refusing what the SFU refuses: an app or a secret
 * it doesn't know, a session it never started, a track nobody publishes, and anything asked of a
 * session whose offer is still unanswered. It keeps what it was asked, and passes a session
 * description on as it is, but for an offer's word that it sends a track in several sizes, which its
 * answer says it takes.
 *
 * It stands in for Cloudflare's TURN service as well, which makes a relay's servers for a TURN key,
 * refusing a key it doesn't know and a token that isn't the key's.
 */
export function standInSfu() {
  const asked: AskedOfSfu[] = [];
  /** What was asked for each relay's servers, with the TURN key it was asked by, in order. */
  const relayAsked: Array<{ keyId: string; body: unknown }> = [];
  /** How many relays' servers it has made. */
  let relaysMade = 0;
  const sessions = new Map<string, StandInSession>();
  const instead: Array<{ path: RegExp; answer: (otherwise: () => Response) => Response | Promise<Response> }> = [];
  /** The sessions that have published, in the order they first did. */
  const publishers: string[] = [];
  let offers = 0;
  /** Whether it takes a track in one size, whatever the offer sends. */
  let oneSize = false;
  /** The sessions whose tracks it sends in no size asked for, only to whoever asks for none. */
  const unsized = new Set<string>();

  function publish(sessionId: string, session: StandInSession, body: Record<string, unknown>, tracks: Array<Record<string, unknown>>): Response {
    const offer = isRecord(body.sessionDescription) && body.sessionDescription.type === "offer" ? body.sessionDescription.sdp : null;
    if (typeof offer !== "string") return refused(400, "invalid_params");
    for (const { mid, trackName } of tracks) session.published.set(String(mid), String(trackName));
    if (!publishers.includes(sessionId)) publishers.push(sessionId);
    // As an answer does, it says of the sizes an offer sends that it takes them, or says nothing of sizes.
    const sdp = oneSize ? offer.replaceAll(/^a=simulcast:.*\r\n/gm, "") : offer.replaceAll("a=simulcast:send ", "a=simulcast:recv ");
    return Response.json({
      requiresImmediateRenegotiation: false,
      sessionDescription: { type: "answer", sdp: `answer to ${sdp}` },
      tracks: tracks.map(({ mid, trackName }) => ({ mid, trackName })),
    });
  }

  function pull(session: StandInSession, tracks: Array<Record<string, unknown>>): Response {
    const results = tracks.map((track) => {
      const { sessionId, trackName } = track;
      const published = [...(sessions.get(String(sessionId))?.published.values() ?? [])].includes(String(trackName));
      if (!published) return { sessionId, trackName, errorCode: "not_found_track_error", errorDescription: "Track not found" };
      const rid = ridAsked(track);
      if (rid !== undefined && unsized.has(String(sessionId))) return { sessionId, trackName, errorCode: "invalid_params", errorDescription: "No such size" };
      // A session numbers its own media sections, so two sessions carry different tracks in sections of one name.
      const mid = String(session.offered++);
      session.pulled.set(mid, { sessionId: String(sessionId), trackName: String(trackName), ...(rid !== undefined && { rid }) });
      return { sessionId, trackName, mid };
    });
    if (results.every((result) => "errorCode" in result)) return Response.json({ requiresImmediateRenegotiation: false, tracks: results });
    session.offering = true;
    return Response.json({ requiresImmediateRenegotiation: true, sessionDescription: { type: "offer", sdp: `offer ${++offers}` }, tracks: results });
  }

  /** Sends a session the tracks it pulls in the sizes it now asks for, each of which it names by its media section and by what it carries. */
  function resize(session: StandInSession, tracks: Array<Record<string, unknown>>): Response {
    const results = tracks.map((track) => {
      const { mid, sessionId, trackName } = track;
      const pulled = session.pulled.get(String(mid));
      const rid = ridAsked(track);
      if (!pulled || pulled.sessionId !== sessionId || pulled.trackName !== trackName || rid === undefined) return { mid, sessionId, trackName, errorCode: "update_track_error", errorDescription: "Track can't be updated" };
      pulled.rid = rid;
      return { mid, sessionId, trackName };
    });
    return Response.json({ requiresImmediateRenegotiation: false, tracks: results });
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
    if (method === "PUT" && what === "/tracks/update" && Array.isArray(body.tracks)) {
      const tracks = (body.tracks as unknown[]).filter(isRecord);
      if (tracks.length > 0 && tracks.length <= 64 && tracks.every(({ location }) => location === "remote")) return resize(session, tracks);
    }
    return refused(400, "invalid_params");
  }

  /** What a test had it answer the next request whose address ends as `path` does, or else what it would `otherwise`. */
  function answered(path: string, otherwise: () => Response): Response | Promise<Response> {
    const index = instead.findIndex((one) => one.path.test(path));
    return index >= 0 ? instead.splice(index, 1)[0]!.answer(otherwise) : otherwise();
  }

  /** Makes a relay's servers for the TURN key `keyId`, as `request` asks. */
  async function relay(request: Request, path: string, keyId: string): Promise<Response> {
    relayAsked.push({ keyId, body: JSON.parse(await request.text()) as unknown });
    if (!TOKENS.has(keyId)) return new Response(null, { status: 404 });
    if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${TOKENS.get(keyId)}`) return new Response(null, { status: 401 });
    return answered(path, () => Response.json(relayServersMade(++relaysMade), { status: 201 }));
  }

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const [, relayPath, keyId] = RELAY_SERVERS.exec(url.pathname) ?? [];
    if (url.origin === SFU && relayPath !== undefined && keyId !== undefined) return relay(request, relayPath, keyId);
    const [, appId, path] = /^\/v1\/apps\/([^/]+)(\/.*)$/.exec(url.pathname) ?? [];
    if (url.origin !== SFU || appId === undefined || path === undefined) throw new Error(`Not a request for the Realtime SFU: ${request.method} ${request.url}`);
    const text = await request.text();
    const sent: AskedOfSfu = { appId, method: request.method, path, sessionId: /^\/sessions\/([^/]+)\//.exec(path)?.[1], body: text === "" ? null : (JSON.parse(text) as unknown) };
    asked.push(sent);
    if (!SECRETS.has(appId)) return refused(404, "not_found");
    if (request.headers.get("Authorization") !== `Bearer ${SECRETS.get(appId)}`) return refused(401, "unauthorized");
    return answered(path, () => answer(sent));
  });

  /** Everything asked of the SFU whose address ends as `path` does, in order. */
  const askedTo = (path: RegExp) => asked.filter((request) => path.test(request.path));

  return {
    asked,
    askedTo,
    relayAsked,
    sessions,
    publishers,
    /** Has the SFU take every track in one size from now, whatever sizes its offer sends, as an SFU that takes no more does. */
    takeOneSize: () => void (oneSize = true),
    /** Has the SFU refuse to send what session `id` publishes in any size asked for, from now: it sends it to whoever asks for no size. */
    refuseSizesOf: (id: string) => void unsized.add(id),
    /** Has the SFU, or the TURN service, answer the next request whose address ends as `path` does with `answer`, doing nothing of what's asked. */
    answerInstead: (path: RegExp, answer: () => Response | Promise<Response>) => void instead.push({ path, answer }),
    /** Has the SFU refuse the next such request, with a status and an error code. */
    refuse: (path: RegExp, status = 500, errorCode = "internal_error") => void instead.push({ path, answer: () => refused(status, errorCode) }),
    /**
     * Has the SFU, or the TURN service, hold its answer to the next such request, which it then answers
     * as it would have, until the function this answers is called.
     */
    hold(path: RegExp): () => void {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      instead.push({ path, answer: async (otherwise) => (await held, otherwise()) });
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

/** Publishes what `client` shows of `kind` with the offer `sdp`, on the connection a tab keeps for it, and says that the connection has connected. */
async function publishShown(client: HuddleSocket, kind: "video" | "screen", sdp: string): Promise<void> {
  client.send({ type: "huddle.publish", sdp, tracks: [{ mid: "0", kind }] });
  await client.next("huddle.published");
  client.send({ type: "huddle.connected", kind });
  await reached(client);
}

/** Publishes `client`'s camera, as `publishShown` does. */
export const publishCamera = (client: HuddleSocket, sdp = "a camera's offer") => publishShown(client, "video", sdp);

/** Publishes the screen `client` shares, as `publishShown` does. */
export const publishScreen = (client: HuddleSocket, sdp = "a screen's offer") => publishShown(client, "screen", sdp);

/** Has `client` ask what `asking` does, and answer the offer it's made, which this answers: null when it's made none. */
async function offeredFor(client: HuddleSocket, asking: Extract<HuddleClientFrame, { type: "huddle.listen" }>) {
  client.send(asking);
  const offer = await client.next("huddle.offer", "huddle.listening");
  if (offer.type === "huddle.listening") return null;
  client.send({ type: "huddle.answer", kind: asking.kind, sdp: `answer to ${offer.sdp}` });
  await client.next("huddle.listening");
  return offer;
}

/**
 * Has `client` ask to watch the cameras of `people`, or their screens if `kind` says so, and nobody
 * else's, on a `fresh` connection if said, and answer the offer it's made, which this answers: null when
 * it's made none.
 */
export const watch = (client: HuddleSocket, people: UserId[], fresh = false, kind: "video" | "screen" = "video") => offeredFor(client, { type: "huddle.listen", kind, watch: people, ...(fresh && { fresh: true as const }) });

/** Has `client` ask to watch the cameras of `people` as a tab that shows cameras small does, and answer as `watch` does. */
export const watchSmall = (client: HuddleSocket, people: UserId[], fresh = false) => offeredFor(client, { type: "huddle.listen", kind: "video", watch: people, small: true, ...(fresh && { fresh: true as const }) });

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

/** Gives huddles a relay by the TURN key `key` as `administrator`, as Set up the relay does. */
export async function giveRelay(administrator: Session, key = RELAY): Promise<void> {
  const response = await api("/api/account/huddles/relay", { method: "PUT", headers: { Cookie: administrator.cookie }, body: JSON.stringify(key) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Takes huddles' relay away as `administrator`, as its switch on the Huddles tab does. */
export async function takeRelayAway(administrator: Session): Promise<void> {
  const response = await api("/api/account/huddles/relay", { method: "DELETE", headers: { Cookie: administrator.cookie } });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Turns Cameras on or off as `administrator`, as its switch on the Huddles tab does. */
export async function switchCameras(administrator: Session, huddleCameras: boolean): Promise<void> {
  const response = await api("/api/account", { method: "PATCH", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ settings: { huddleCameras } }) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Turns Screen sharing on or off as `administrator`, as its switch on the Huddles tab does. */
export async function switchScreens(administrator: Session, huddleScreens: boolean): Promise<void> {
  const response = await api("/api/account", { method: "PATCH", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ settings: { huddleScreens } }) });
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
