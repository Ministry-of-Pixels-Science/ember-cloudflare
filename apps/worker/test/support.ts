import {
  ROOM_PROTOCOL,
  roomSocketQuery,
  startingInvolvement,
  uploadPartPath,
  uploadsPath,
  type ClientFrame,
  type DirectRoom,
  type Me,
  type Message,
  type Room,
  type RoomIconChoice,
  type RoomId,
  type RoomSocketParams,
  type ServerFrame,
  type SharedRoom,
  type StoredFile,
  type Upload,
  type User,
  type UserId,
  type WorkspaceServerFrame,
} from "@ember/protocol";
import type { ModelFormat, ThinkingLevel } from "@ember/protocol/assistant";
import { applyD1Migrations, evictDurableObject, reset, runInDurableObject, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, vi } from "vitest";
import { ADDRESS_HEADER, AUTHORIZED_AT_HEADER, BANNED_HEADER, ROOM_HEADER, SESSION_HEADER, USER_HEADER, type ChatRoom } from "../src/chat-room";
import { toBase64, toBase64url, urlsafeDecode64 } from "../src/encoding";
import type { Env } from "../src/env";
import worker from "../src/index";
import { forgetNewestRelease } from "../src/releases";
import { searchIndex } from "../src/search-index";
import { workspace, type Workspace } from "../src/workspace";

export const origin = "https://ember.test";

/** The deploy's setup token, which the suite's Worker is bound with (vitest.config.ts) and `api` sends to set Ember up. */
export const SETUP_TOKEN = "fedcba9876543210".repeat(4);

/**
 * `init` as the app's own pages send it to `path`: writes carry the `Sec-Fetch-Site` browsers add, and
 * setting Ember up carries the setup link's token, as the Set up Ember page sends it.
 */
function fromOwnPages<Cf>(path: string, init: RequestInit<Cf>): RequestInit<Cf> {
  const headers = new Headers(init.headers);
  const write = init.method !== undefined && init.method !== "GET" && init.method !== "HEAD";
  if (write && !headers.has("Sec-Fetch-Site")) headers.set("Sec-Fetch-Site", "same-origin");
  if (write && new URL(path, origin).pathname === "/api/first_run" && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${SETUP_TOKEN}`);
  return { ...init, headers };
}

/** A request from the app's own pages. */
export const api = (path: string, init: RequestInit = {}) => exports.default.fetch(`${origin}${path}`, fromOwnPages(path, init));

/** The same request, to a Worker whose bindings differ from this suite's by `changes`. `path` may be a whole URL. */
export const apiWith = (changes: Partial<Env>, path: string, init: RequestInit<IncomingRequestCfProperties> = {}) =>
  worker.fetch(new Request(new URL(path, origin), fromOwnPages(path, init)), { ...(env as unknown as Env), ...changes });

/**
 * What Ember AI's settings say of @ember's avatar while it's Ember's flame, as it is until an
 * administrator uploads one: its address, at whichever version.
 */
export const WITH_THE_FLAME = { avatarUrl: expect.stringMatching(/^\/users\/ember\.[\w-]+\/avatar\?v=\d{14}(?:&|$)/) as string, avatar: false };

/** When the owner of the avatar at `avatarUrl` last changed, as its address says (`?v=`), so a later address has a larger one. */
export const avatarVersionOf = (avatarUrl: string) => Number(new URL(avatarUrl, origin).searchParams.get("v"));

/**
 * Stops the clock, for the Workspace too, which then moves only as far as anything waits, at once: what
 * happens next happens in the same second, but for what waits for a later one. `vi.useRealTimers` and
 * `vi.restoreAllMocks` start it again.
 */
export function stopTheClock(): void {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  vi.spyOn(scheduler, "wait").mockImplementation(async (ms) => void vi.setSystemTime(Date.now() + ms));
}

/** One of the recorded images (fixtures/README.md), by its name in fixtures/storage/. */
export function recordedImage(name: string): Uint8Array {
  const { TEST_RECORDED_IMAGES } = env as unknown as { TEST_RECORDED_IMAGES: Record<string, string> };
  return Uint8Array.from(atob(TEST_RECORDED_IMAGES[name]!), (c) => c.charCodeAt(0));
}

/** A digest as Ember made them before scrypt: PBKDF2-SHA256 at the 100,000 iterations Web Crypto allows on Workers. */
export async function pbkdf2Digest(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256));
  return `$pbkdf2-sha256$i=100000$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Stands in for the built app's pages, which the worker tests run without: each answers with its path. */
export const builtPages = {
  fetch: async (input: Request | string) => new Response(`page ${new URL(input instanceof Request ? input.url : input).pathname}`, { headers: { "Content-Type": "text/html" } }),
} as unknown as Fetcher;

/**
 * Empties every Durable Object and the D1 database, which then gets its tables back, so a test starts
 * as a fresh deploy does: no account, people or rooms, nor any release heard of.
 */
export async function freshDeploy(): Promise<void> {
  // A reset can leave the storage of a Durable Object that's still busy, as the Workspace is while its
  // alarm delivers what the last test queued, so it's made again until the Workspace has nobody.
  do {
    await reset();
    const db = sharedD1();
    if (db) await applyD1Migrations(db, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  } while (await anyoneLeft());
  host = undefined;
  forgetNewestRelease();
}

const anyoneLeft = async () => ((await workspaceSql("SELECT count(*) AS n FROM users")) as Array<{ n: number }>)[0]!.n > 0;

export interface Session {
  user: User;
  /** The `Cookie` header that carries the session, `name=value`. */
  cookie: string;
  /** The IP address its sockets come from, as Cloudflare's `CF-Connecting-IP` says, if any. */
  ip?: string;
}

/** The `name=value` a response's `Set-Cookie` sets. */
export const cookieOf = (response: Response) => response.headers.get("Set-Cookie")!.split(";")[0]!;

/** Someone as rooms and lists show them, without what the app keeps about whoever is signed in. */
export const shown = ({ id, name }: User | Me): User => ({ id, name });

/** Signs in as a guest named `name`. */
export async function signIn(name: string): Promise<Session> {
  const response = await api("/api/session", { method: "POST", body: JSON.stringify({ name }) });
  expect(response.status).toBe(201);
  const { user } = (await response.json()) as { user: Me };
  return { user: shown(user), cookie: cookieOf(response) };
}

/** A room socket's upgrade request from the app's own pages, signed in with `cookie` if given, from the IP address `ip` if given. */
export const upgrade = (cookie?: string, ip?: string) => ({
  headers: { Upgrade: "websocket", Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(ip ? { "CF-Connecting-IP": ip } : {}) },
});

/** The room's Durable Object. */
export const roomStub = (room: string) => (env as unknown as Env).CHAT_ROOM.getByName(room);

/** Who the Workspace let into a room, and when it checked, and the IP address their socket comes from and whether a ban blocks it, if said. */
export interface Access {
  user: User;
  sessionId: string;
  authorizedAt: number;
  address?: string;
  banned?: boolean;
}

/** A room socket's upgrade as the Worker sends it on to the room, once the Workspace has let it through. */
export const forwardUpgrade = (room: RoomId, { user, sessionId, authorizedAt, address, banned = false }: Access) =>
  roomStub(room).fetch(`https://room/${room}?protocol=${ROOM_PROTOCOL}`, {
    headers: {
      Upgrade: "websocket",
      [USER_HEADER]: JSON.stringify(user),
      [ROOM_HEADER]: room,
      [SESSION_HEADER]: sessionId,
      [AUTHORIZED_AT_HEADER]: String(authorizedAt),
      [BANNED_HEADER]: String(banned),
      ...(address ? { [ADDRESS_HEADER]: address } : {}),
    },
  });

/**
 * What a socket the Worker sends on to the room comes to: let in and welcomed, or closed at once,
 * with a code and reason. A socket let in is closed again once it's welcomed.
 */
export async function outcome(room: RoomId, access: Access): Promise<"welcome" | { code: number; reason: string }> {
  const ws = (await forwardUpgrade(room, access)).webSocket!;
  ws.accept();
  let welcomed = false;
  ws.addEventListener("message", (event) => {
    welcomed = (JSON.parse(event.data as string) as { type: string }).type === "welcome";
    ws.close(1000);
  });
  const { code, reason } = await closeOf(ws);
  return welcomed ? "welcome" : { code, reason };
}

/**
 * Makes the Workspace unreachable from room `room`, as it is when it's restarting, until the function
 * this answers is called. The time of each call the room makes meanwhile goes in `calls`.
 */
export async function cutOff(room: RoomId, calls: number[] = []): Promise<() => Promise<void>> {
  let original: Env | undefined;
  await runInDurableObject(roomStub(room), (instance: ChatRoom) => {
    const object = instance as unknown as { env: Env };
    original = object.env;
    const unreachable = {
      applyRoomEvents: () => {
        calls.push(Date.now());
        return Promise.reject(new Error("The Workspace is unreachable"));
      },
    };
    object.env = { ...original, WORKSPACE: { getByName: () => unreachable } as unknown as Env["WORKSPACE"] };
  });
  return () =>
    runInDurableObject(roomStub(room), (instance: ChatRoom) => {
      (instance as unknown as { env: Env }).env = original!;
    });
}

/** How `ws` closes, once it does. */
export const closeOf = (ws: WebSocket) => new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve));

/** The Workspace's Durable Object. */
export const workspaceStub = () => workspace(env as unknown as Env);

/** Runs `run` while the Workspace's bindings differ from this suite's by `changes`. */
export async function withWorkspaceEnv(changes: Partial<Env>, run: () => Promise<void>): Promise<void> {
  let original: Env | undefined;
  await runInDurableObject(workspaceStub(), (instance: Workspace) => {
    const object = instance as unknown as { env: Env };
    original = object.env;
    object.env = { ...original, ...changes };
  });
  try {
    await run();
  } finally {
    await runInDurableObject(workspaceStub(), (instance: Workspace) => void ((instance as unknown as { env: Env }).env = original!));
  }
}

/** The search index's Durable Object. */
export const searchIndexStub = () => searchIndex(env as unknown as Env);

/** The calls the Workspace makes on a room, as a test answers them in every room's stead. */
export type RoomStandIn = Partial<Pick<ChatRoom, "revoke" | "removeMessagesBy" | "reindex" | "authors">>;

/** Has `rooms` answer the Workspace's calls to rooms until the function it answers with is called, which gives the rooms back. */
export async function standInForRooms(rooms: RoomStandIn): Promise<() => Promise<void>> {
  type Swappable = { env: Env; envBefore?: Env };
  await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
    const object = workspace as unknown as Swappable;
    object.envBefore ??= object.env;
    object.env = { ...object.env, CHAT_ROOM: { getByName: () => rooms } as unknown as Env["CHAT_ROOM"] };
  });
  return () =>
    runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const object = workspace as unknown as Swappable;
      if (object.envBefore) object.env = object.envBefore;
      delete object.envBefore;
    });
}

/** Runs SQL against a Durable Object's own SQLite storage, whichever backend this suite is using. */
export function objectSql(stub: DurableObjectStub, query: string, ...params: Array<string | number>): Promise<unknown[]> {
  return runInDurableObject(stub, (_object, state: DurableObjectState) => state.storage.sql.exec(query, ...params).toArray());
}

/**
 * The D1 database every object keeps its tables in when this suite runs on D1, or undefined on DO SQLite,
 * where wrangler.jsonc binds one that nothing uses, as Deploy to Cloudflare's form makes one for every copy.
 */
export function sharedD1(): D1Database | undefined {
  const { STORAGE_BACKEND, DB } = env as unknown as Env;
  return STORAGE_BACKEND === "d1" ? DB : undefined;
}

/** Runs SQL against the tables `stub` keeps: in D1 when this suite uses it, else in the object's own storage. */
async function tablesSql(stub: DurableObjectStub, query: string, ...params: Array<string | number>): Promise<unknown[]> {
  const db = sharedD1();
  if (db) return (await db.prepare(query).bind(...params).all()).results;
  return objectSql(stub, query, ...params);
}

/**
 * Runs SQL against a room's tables, whichever backend this suite is using. Since that's behind the
 * room's back, the room then forgets what it keeps of them, its newest page and latest change, and
 * reads them again.
 */
export async function roomSql(room: string, query: string, ...params: Array<string | number>): Promise<unknown[]> {
  const rows = await tablesSql(roomStub(room), query, ...params);
  await runInDurableObject(roomStub(room), (object: unknown) => {
    (object as { store: unknown }).store = null;
  });
  return rows;
}

/** Runs SQL against the Workspace's tables, whichever backend this suite is using. */
export const workspaceSql = (query: string, ...params: Array<string | number>) => tablesSql(workspaceStub(), query, ...params);

/** Has the Workspace read what's stored afresh, as it does once it starts again, whether or not it's running now. */
async function restartWorkspace(): Promise<void> {
  // On D1 what's stored changes without the Workspace, which then needn't be running to be stopped.
  await runInDurableObject(workspaceStub(), () => {});
  await evictDurableObject(workspaceStub());
}

/**
 * A model kept before Ember stopped offering it, as a copy set up then keeps it: its ID, its name, the
 * format Cloudflare's REST API took it in, and the levels of thinking it took its test question at.
 */
export interface KeptModel {
  id: string;
  name: string;
  format: ModelFormat;
  thinkingLevels: readonly ThinkingLevel[];
}

/**
 * Has Ember AI, which is on, answer everyone with `model`, which Ember no longer offers, as a copy set
 * up before Ember stopped offering it does, with it and `others` the models people can pick, as the
 * Workspace finds when it next opens.
 */
export async function answerWithKeptModel(model: KeptModel, ...others: KeptModel[]): Promise<void> {
  const models = [model, ...others].map(({ thinkingLevels, ...kept }) => ({ ...kept, thinking_levels: thinkingLevels }));
  await workspaceSql(
    "UPDATE accounts SET settings = json_set(settings, '$.assistant.model', ?, '$.assistant.format', ?, '$.assistant.models', json(?))",
    model.id,
    model.format,
    JSON.stringify(models),
  );
  await restartWorkspace();
}

/**
 * Adds `models`, which Ember no longer offers, to those people can pick, after the others, as a copy set
 * up before Ember stopped offering them has them, as the Workspace finds when it next opens.
 */
export async function addKeptModels(...models: KeptModel[]): Promise<void> {
  const [{ settings }] = (await workspaceSql("SELECT settings FROM accounts")) as [{ settings: string }];
  const others = (JSON.parse(settings) as { assistant: { models: unknown[] } }).assistant.models;
  const kept = models.map(({ thinkingLevels, ...model }) => ({ ...model, thinking_levels: thinkingLevels }));
  await workspaceSql("UPDATE accounts SET settings = json_set(settings, '$.assistant.models', json(?))", JSON.stringify([...others, ...kept]));
  await restartWorkspace();
}

/** Has the agent `agentId` answer with `model`, which Ember no longer offers, as an agent made before Ember stopped offering it does. */
export async function agentWithKeptModel(agentId: UserId, { id, name, format, thinkingLevels }: KeptModel): Promise<void> {
  await workspaceSql("UPDATE agents SET model = ?, model_name = ?, format = ?, thinking_levels = ? WHERE user_id = ?", id, name, format, JSON.stringify(thinkingLevels), agentId);
  await restartWorkspace();
}

/** Runs SQL against the search index's tables, which it keeps in its own storage on either backend. */
export const searchSql = (query: string, ...params: Array<string | number>) => objectSql(searchIndexStub(), query, ...params);

/** Who creates rooms for the tests, signed in once per test file. */
let host: Promise<Session> | undefined;

/**
 * Creates a room through the API as `as`, or as the tests' host: an open room everyone is in, or a
 * closed one for just the people `closedTo` names.
 */
export async function createRoom(name: string, { closedTo, icon, as }: { closedTo?: UserId[]; icon?: RoomIconChoice; as?: Session } = {}): Promise<SharedRoom> {
  const { cookie } = as ?? (await (host ??= signIn("Host")));
  const room = closedTo ? { kind: "closed", name, icon, memberIds: closedTo } : { kind: "open", name, icon };
  const response = await api("/api/rooms", { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify(room) });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { room: SharedRoom }).room;
}

/** Starts uploading `file`, a `NewUpload`, to `room` as `session`, answering how the Worker answered. */
export const startUpload = (session: Session, room: RoomId, file: unknown) =>
  api(uploadsPath(room), { method: "POST", headers: { Cookie: session.cookie }, body: JSON.stringify(file) });

/** Sends `bytes` as part `n` of upload `id` in `room` as `session`, with their length, as a browser sends a part. */
export const sendPart = (session: Session, room: RoomId, id: string, n: number, bytes: Uint8Array, headers: Record<string, string> = {}) =>
  api(uploadPartPath(room, id, n), { method: "PUT", headers: { Cookie: session.cookie, "Content-Length": String(bytes.length), ...headers }, body: bytes });

/** A file message, as the room posts an upload once R2 has all of it. */
export type FileMessage = Message & { attachment: StoredFile };

/**
 * Uploads `bytes` to `room` as `session`, part by part, named `name` and of the type a browser declares,
 * answering the message the room posts it as, whose id for the app is `clientMessageId`.
 */
export async function upload(session: Session, room: RoomId, name: string, bytes: Uint8Array, type = "", clientMessageId = crypto.randomUUID()): Promise<FileMessage> {
  const started = await startUpload(session, room, { name, type, size: bytes.length, clientMessageId });
  expect(started.status, await started.clone().text()).toBe(201);
  const { id, partSize, parts } = (await started.json()) as Upload;
  for (let n = 1; n < parts; n++) expect((await sendPart(session, room, id, n, bytes.subarray((n - 1) * partSize, n * partSize))).status).toBe(204);
  const last = await sendPart(session, room, id, parts, bytes.subarray((parts - 1) * partSize));
  expect(last.status, await last.clone().text()).toBe(201);
  return (await last.json()) as FileMessage;
}

/** Starts a DM through the API as `as`, with the people `userIds` names, answering how the Worker answered. */
export const startDirect = (as: Session, userIds: unknown) =>
  api("/api/directs", { method: "POST", headers: { Cookie: as.cookie }, body: JSON.stringify({ userIds }) });

/** Starts the DM between `as` and `people`, or opens the one they have, answering it. */
export async function direct(as: Session, ...people: Session[]): Promise<DirectRoom> {
  const response = await startDirect(as, people.map((person) => person.user.id));
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return ((await response.json()) as { room: DirectRoom }).room;
}

/** Adds someone who has left the workspace, as deactivating them will, answering their id. */
export async function deactivatedPerson(name: string): Promise<UserId> {
  const id = `former-${crypto.randomUUID()}`;
  await workspaceSql(`INSERT INTO users (id, name, status, created_at, updated_at) VALUES (?, ?, 1, 'now', 'now')`, id, name);
  return id;
}

/** `room` as the sidebar lists it to someone it isn't marked unread for, at the level they start at. */
export const listedRoom = <T extends Room>(room: T) => ({ ...room, unread: false, involvement: startingInvolvement(room) });

/** A new open room, so tests never share a ChatRoom. Everyone is in it, whenever they sign in. */
export const freshRoom = async (label: string): Promise<RoomId> => (await createRoom(label)).id;

export type Client = Awaited<ReturnType<typeof connect>>;

/** A room socket opened by `connect` or `reconnect`. */
export type Socket = Awaited<ReturnType<typeof openSocket>>;

/**
 * Opens a room socket as `name` (or in an existing session), queues every frame it receives, and
 * waits for its welcome. Its address names the room protocol's revision, as the app's do, and says
 * whether its tab is shown only when `params` does. An `outdated` tab's names nothing, as the app's
 * did before rich text.
 */
export async function connect(room: string, as: string | Session, params?: RoomSocketParams | "outdated") {
  const socket = await openSocket(room, typeof as === "string" ? await signIn(as) : as, params);
  const welcome = await socket.next("welcome");
  return { ...socket, welcome, me: welcome.you };
}

/**
 * Opens a room socket in `session`, as a tab that has seen the room's change `since` connects again,
 * and waits for what the room opens it with: `resumed`, or a welcome.
 */
export async function reconnect(room: string, session: Session, since: number) {
  const socket = await openSocket(room, session, { visible: true, since });
  return { ...socket, opening: await socket.next("welcome", "resumed") };
}

/** Queues every frame `ws` receives, for a test to read in its own time. */
export function framesOf<Frame extends { type: string }>(ws: WebSocket) {
  const frames: Frame[] = [];
  /** Every frame received, in order, whether or not it has been read. */
  const log: Frame[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data as string) as Frame;
    frames.push(frame);
    log.push(frame);
    waiters.splice(0).forEach((wake) => wake());
  });

  /** The next unread frame of one of `types`, waiting for it if need be. */
  async function next<T extends Frame["type"]>(...types: T[]): Promise<Extract<Frame, { type: T }>> {
    for (;;) {
      const index = frames.findIndex((f) => (types as string[]).includes(f.type));
      if (index >= 0) return frames.splice(index, 1)[0] as Extract<Frame, { type: T }>;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }

  /** Unread frames of `type` that have already arrived. */
  const pending = (type: Frame["type"]) => frames.filter((f) => f.type === type);

  return { next, pending, log };
}

/** Opens a room socket in `session` and queues every frame it receives. */
async function openSocket(room: string, session: Session, params?: RoomSocketParams | "outdated") {
  const query = params === "outdated" ? "" : params ? roomSocketQuery(params) : `?protocol=${ROOM_PROTOCOL}`;
  const response = await api(`/api/rooms/${room}/socket${query}`, upgrade(session.cookie, session.ip));
  const ws = response.webSocket;
  if (!ws) throw new Error(`No socket: ${response.status} ${await response.text()}`);
  ws.accept();

  return {
    ws,
    session,
    ...framesOf<ServerFrame>(ws),
    // Any frame, the ones the protocol refuses included. Not `Record<string, unknown>`: once ClientFrame
    // has ten members, TypeScript checks an object literal against the member its `type` names alone.
    send: (frame: ClientFrame | { type: string; [field: string]: unknown }) => ws.send(JSON.stringify(frame)),
    sendRaw: (data: string | ArrayBuffer) => ws.send(data),
    close: () => ws.close(1000),
  };
}

/** Posts a message and waits for the room to confirm it. */
export async function post(client: Socket, body: string, clientMessageId = crypto.randomUUID()) {
  client.send({ type: "message.create", clientMessageId, body });
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.clientMessageId === clientMessageId) return message;
  }
}

/**
 * Lets frames already on their way arrive. A room handles frames one at a time, so once each
 * client in turn has a reply to a ping, everything sent before has been handled and delivered.
 * (A ping with extra fields reaches the room; the bare `{"type":"ping"}` is answered by the runtime.)
 */
export async function settle(...clients: Socket[]): Promise<void> {
  for (const client of clients) {
    client.send({ type: "ping", nonce: crypto.randomUUID() });
    await client.next("pong");
  }
}

/** Opens a workspace socket in `session`, as a tab does, and queues what the Workspace sends on it after its welcome. */
export async function openWorkspaceSocket(session: Session) {
  const response = await api("/api/socket", upgrade(session.cookie));
  if (!response.webSocket) throw new Error(`No socket: ${response.status} ${await response.text()}`);
  const ws = response.webSocket;
  const frames: WorkspaceServerFrame[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data as string) as WorkspaceServerFrame);
    waiters.splice(0).forEach((wake) => wake());
  });
  const closed = closeOf(ws);
  ws.accept();

  /** The next frame, waiting for it if need be. */
  async function next(): Promise<WorkspaceServerFrame> {
    while (frames.length === 0) await new Promise<void>((resolve) => waiters.push(resolve));
    return frames.shift()!;
  }

  /** Whether the Workspace still answers on it. A ping with more than its type reaches the Workspace itself. */
  async function answers(): Promise<boolean> {
    ws.send(JSON.stringify({ type: "ping", nonce: crypto.randomUUID() }));
    return (await next()).type === "pong";
  }

  const welcome = await next();
  return { ws, welcome, next, answers, closed, send: (data: string) => ws.send(data) };
}

export type WorkspaceSocket = Awaited<ReturnType<typeof openWorkspaceSocket>>;

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const encoder = new TextEncoder();

/** A browser that has subscribed to pushes: its keys, as its subscription gives them, and what reads the pushes made for them. */
export interface PushBrowser {
  p256dh: string;
  auth: string;
  /** The push's one record, decrypted. */
  read(body: Uint8Array): Promise<PushRecord>;
  /** The push's JSON, as the service worker reads it, from a record the gem's way pads. */
  open(body: Uint8Array): Promise<string>;
}

/** What a push's record header says, and its plaintext, delimiter and padding included. */
export interface PushRecord {
  recordSize: number;
  ciphertextLength: number;
  serverPublic: Uint8Array;
  plaintext: Uint8Array;
}

/** A browser with fresh keys, or the keys `given`: its private key, and its subscription's keys in URL-safe Base64. */
export async function pushBrowser(given?: { privateKey: CryptoKey; p256dh: string; auth: string }): Promise<PushBrowser> {
  let keys = given;
  if (!keys) {
    const pair = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
    const point = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    keys = { privateKey: pair.privateKey, p256dh: toBase64url(point), auth: toBase64url(crypto.getRandomValues(new Uint8Array(16))) };
  }
  const { privateKey, p256dh, auth } = keys;
  const read = (body: Uint8Array) => decryptedPush(body, privateKey, p256dh, auth);
  return { p256dh, auth, read, open: async (body) => gemMessage((await read(body)).plaintext) };
}

/**
 * A push's one record as a browser reads it (RFC 8291 and RFC 8188), written apart from the code under
 * test, so it checks that code: what its header says, and its plaintext.
 */
async function decryptedPush(body: Uint8Array, privateKey: CryptoKey, p256dh: string, auth: string): Promise<PushRecord> {
  const salt = body.subarray(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const serverPublic = body.subarray(21, 21 + body[20]!);
  const ciphertext = body.subarray(21 + body[20]!);
  const serverKey = await crypto.subtle.importKey("raw", serverPublic, ECDH, false, []);
  const agreement = { name: "ECDH", public: serverKey };
  const shared = new Uint8Array(await crypto.subtle.deriveBits(agreement, privateKey, 256));
  const key = await hkdf(urlsafeDecode64(auth)!, shared, Uint8Array.from([...encoder.encode("WebPush: info\0"), ...urlsafeDecode64(p256dh)!, ...serverPublic]), 32);
  const contentKey = await hkdf(salt, key, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, key, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ciphertext));
  return { recordSize, ciphertextLength: ciphertext.length, serverPublic, plaintext };
}

async function hkdf(salt: Uint8Array, secret: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** The message in a record the gem padded: its plaintext but for the last record's delimiter and one zero. */
export function gemMessage(plaintext: Uint8Array): string {
  expect([...plaintext.subarray(-2)]).toEqual([2, 0]);
  return new TextDecoder().decode(plaintext.subarray(0, -2));
}
