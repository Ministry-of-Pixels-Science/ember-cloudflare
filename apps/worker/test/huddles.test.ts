import type { Bootstrap, NewWorkspace, WorkspaceSettings } from "@ember/protocol";
import {
  APP_ID_REFUSED,
  APP_ID_UNKNOWN,
  APP_SECRET_REFUSED,
  APP_SECRET_UNKNOWN,
  HUDDLES_FORBIDDEN,
  HUDDLES_UNCHECKED,
  RELAY_API_TOKEN_REFUSED,
  RELAY_API_TOKEN_UNKNOWN,
  RELAY_KEY_ID_REFUSED,
  RELAY_KEY_ID_UNKNOWN,
  RELAY_TTL_S,
  RELAY_UNCHECKED,
  RELAY_WITHOUT_HUDDLES,
  type HuddlesForgotten,
  type HuddlesSaved,
} from "@ember/protocol/huddles";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { APP, OTHER_APP, OTHER_RELAY, RELAY, relayServersMade } from "./huddle-support";
import { api, apiWith, cookieOf, createRoom, freshDeploy, openWorkspaceSocket, shown, signIn, withWorkspaceEnv, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Where Cloudflare's Realtime SFU is asked to start a session with an app, or a stand-in for it at `sfu`. */
const newSession = (appId: string, sfu = "https://rtc.live.cloudflare.com") => `${sfu}/v1/apps/${appId}/sessions/new`;

/** Where Cloudflare's TURN service is asked for a relay's servers by a TURN key, or a stand-in for it at `turn`. */
const relayServers = (keyId: string, turn = "https://rtc.live.cloudflare.com") => `${turn}/v1/turn/keys/${keyId}/credentials/generate-ice-servers`;

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Gives Ember an SFU app's keys as `session`, as Set up huddles does, on a deployment whose bindings differ from this suite's by `changes`. */
const giveKeys = (session: Session | null, app: unknown, changes: Partial<Env> = {}) =>
  apiWith(changes, "/api/account/huddles", { method: "PUT", headers: as(session), body: JSON.stringify(app) });

/** Gives Ember `app`'s keys as `administrator`, which has to work. */
async function saveKeys(administrator: Session, app = APP): Promise<void> {
  const response = await giveKeys(administrator, app);
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Turns huddles off as `session`, as the Huddles card's switch does. */
const turnOff = (session: Session | null) => api("/api/account/huddles", { method: "DELETE", headers: as(session) });

/** Gives huddles a relay by a TURN key as `session`, as Set up the relay does, on a deployment whose bindings differ from this suite's by `changes`. */
const giveRelay = (session: Session | null, key: unknown, changes: Partial<Env> = {}) =>
  apiWith(changes, "/api/account/huddles/relay", { method: "PUT", headers: as(session), body: JSON.stringify(key) });

/** Gives huddles a relay by `key` as `administrator`, which has to work. */
async function saveRelay(administrator: Session, key = RELAY): Promise<void> {
  const response = await giveRelay(administrator, key);
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Takes huddles' relay away as `session`, as the relay's switch does. */
const takeRelayAway = (session: Session | null) => api("/api/account/huddles/relay", { method: "DELETE", headers: as(session) });

/** Turns Cameras on or off as `session`, as its switch on the Huddles tab does. */
const switchCameras = (session: Session | null, huddleCameras: unknown) => api("/api/account", { method: "PATCH", headers: as(session), body: JSON.stringify({ settings: { huddleCameras } }) });

/** Turns Screen sharing on or off as `session`, as its switch on the Huddles tab does. */
const switchScreens = (session: Session | null, huddleScreens: unknown) => api("/api/account", { method: "PATCH", headers: as(session), body: JSON.stringify({ settings: { huddleScreens } }) });

/** The account as a page is told of it before anyone signs in. */
const shownAccount = async () => ((await (await api("/api/bootstrap")).json()) as Bootstrap).account;

/** The workspace's settings as `session` sees them. */
const settings = async (session: Session) => (await (await api("/api/account", { headers: as(session) })).json()) as WorkspaceSettings;

/** Huddles as the workspace's settings show them to `session`. */
const huddlesSettings = async (session: Session) => (await settings(session)).huddles;

/** The account's settings, as the database keeps them. */
const storedSettings = async () => JSON.parse(((await workspaceSql("SELECT settings FROM accounts")) as Array<{ settings: string }>)[0]!.settings) as Record<string, unknown>;

/** A request the fake SFU, or the fake TURN service, was sent. */
interface SentToSfu {
  url: string;
  method: string;
  authorization: string | null;
  body: string;
}

/** What the SFU answers once it has started a session. */
const started = () => Response.json({ sessionId: "e017a2629c754fedc1f7d8587e06d126" }, { status: 201 });

/** Stands in for Cloudflare's Realtime SFU, answering `answer` to each request, and keeping what it's sent. */
function fakeSfu(answer: () => Response | Promise<Response> = started) {
  const requests: SentToSfu[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, method: request.method, authorization: request.headers.get("Authorization"), body: await request.text() });
    return answer();
  });
  return requests;
}

/** What the TURN service answers once it has made a relay's servers. */
const made = () => Response.json(relayServersMade(), { status: 201 });

/** What it's asked to make them. */
const MAKING = { method: "POST", body: JSON.stringify({ ttl: RELAY_TTL_S }) };

/**
 * Stands in for Cloudflare's TURN service as well as its SFU: it answers `answer` to each request for a
 * relay's servers, keeping what it's sent, and starts a session for any other.
 */
function fakeRelay(answer: () => Response | Promise<Response> = made) {
  const requests: SentToSfu[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.includes("/turn/keys/")) return started();
    requests.push({ url: request.url, method: request.method, authorization: request.headers.get("Authorization"), body: await request.text() });
    return answer();
  });
  return requests;
}

/** Sets Ember up with huddles on, and answers Ada, its administrator, and what the fake TURN service is sent from then. */
async function setUpWithHuddles(): Promise<{ administrator: Session; requests: SentToSfu[] }> {
  const administrator = await setUp();
  const requests = fakeRelay();
  await saveKeys(administrator);
  return { administrator, requests };
}

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Set up huddles", () => {
  it("keeps an SFU app's keys once Cloudflare has started a session with them, its secret sealed", async () => {
    const administrator = await setUp();
    expect(await huddlesSettings(administrator)).toBeNull();
    const requests = fakeSfu();
    const response = await giveKeys(administrator, { appId: ` ${APP.appId} `, appSecret: `${APP.appSecret}\n` });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ huddles: { appId: APP.appId, relayKeyId: null } } satisfies HuddlesSaved);
    expect(requests).toEqual([{ url: newSession(APP.appId), method: "POST", authorization: `Bearer ${APP.appSecret}`, body: "" }]);

    // The database holds the secret sealed, never as it was given.
    const stored = (await storedSettings()).huddles as { app_id: string; app_secret: string };
    expect(stored).toEqual({ app_id: APP.appId, app_secret: expect.stringMatching(/^v1\.[\w-]{16}\.[\w-]+$/) as unknown });
    expect(JSON.stringify(await workspaceSql("SELECT * FROM accounts"))).not.toContain(APP.appSecret);
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: null });
    // As it does once the Workspace starts afresh.
    await evictDurableObject(workspaceStub());
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: null });

    // Given again, it's sealed afresh.
    await saveKeys(administrator);
    expect(((await storedSettings()).huddles as typeof stored).app_secret).not.toBe(stored.app_secret);
  });

  it("runs huddles through another app once its keys are given", async () => {
    const administrator = await setUp();
    const requests = fakeSfu();
    await saveKeys(administrator);
    const response = await giveKeys(administrator, OTHER_APP);
    expect(await response.json()).toEqual({ huddles: { appId: OTHER_APP.appId, relayKeyId: null } });
    expect(requests.at(-1)).toEqual({ url: newSession(OTHER_APP.appId), method: "POST", authorization: `Bearer ${OTHER_APP.appSecret}`, body: "" });
    expect(await huddlesSettings(administrator)).toEqual({ appId: OTHER_APP.appId, relayKeyId: null });
    expect(JSON.stringify(await storedSettings())).not.toContain(APP.appId);
  });

  it("says why keys aren't kept, on the field they're about, asking Cloudflare nothing of keys that can't be an app's", async () => {
    const administrator = await setUp();
    const unasked = fakeSfu();
    const refusals: Array<[unknown, string, string]> = [
      [{ ...APP, appId: "my huddles app" }, "appId", APP_ID_REFUSED],
      [{ ...APP, appId: APP.appId.slice(1) }, "appId", APP_ID_REFUSED],
      [{ ...APP, appId: `${APP.appId.slice(0, 30)}/.` }, "appId", APP_ID_REFUSED],
      [{ ...APP, appId: APP.appSecret }, "appId", APP_ID_REFUSED],
      [{ ...APP, appId: 42 }, "appId", APP_ID_REFUSED],
      [{ appSecret: APP.appSecret }, "appId", APP_ID_REFUSED],
      [{ ...APP, appSecret: APP.appId }, "appSecret", APP_SECRET_REFUSED],
      [{ ...APP, appSecret: `${APP.appSecret}0` }, "appSecret", APP_SECRET_REFUSED],
      [{ ...APP, appSecret: `Bearer ${APP.appSecret.slice(7)}` }, "appSecret", APP_SECRET_REFUSED],
      [{ appId: APP.appId }, "appSecret", APP_SECRET_REFUSED],
      [null, "appId", APP_ID_REFUSED],
      [[APP.appId, APP.appSecret], "appId", APP_ID_REFUSED],
    ];
    for (const [given, field, error] of refusals) {
      const response = await giveKeys(administrator, given);
      expect(response.status, JSON.stringify(given)).toBe(422);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ error, field });
    }
    expect(unasked).toEqual([]);
    expect(await storedSettings()).not.toHaveProperty("huddles");
  });

  it("says why Cloudflare didn't start a session, keeping no keys, and logs its status and error code but never a key", async () => {
    const administrator = await setUp();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = (status: number, errorCode: string, errorDescription = "") => () => Response.json({ errorCode, errorDescription }, { status });
    const refusals: Array<[() => Response | Promise<Response>, number, Record<string, string>]> = [
      [refused(404, "not_found", `appId ${APP.appId} does not exist.`), 422, { error: APP_ID_UNKNOWN, field: "appId" }],
      [() => new Response("Not found", { status: 404 }), 422, { error: APP_ID_UNKNOWN, field: "appId" }],
      [refused(401, "unauthorized", "The SFU App Secret was not accepted."), 422, { error: APP_SECRET_UNKNOWN, field: "appSecret" }],
      [() => new Response(null, { status: 403 }), 422, { error: APP_SECRET_UNKNOWN, field: "appSecret" }],
      [refused(400, "unauthorized"), 422, { error: APP_SECRET_UNKNOWN, field: "appSecret" }],
      [refused(500, "internal_error"), 502, { error: HUDDLES_UNCHECKED }],
      [refused(429, "rate_limited"), 502, { error: HUDDLES_UNCHECKED }],
      // A session it doesn't name isn't one it started.
      [() => new Response("<html>", { status: 201 }), 502, { error: HUDDLES_UNCHECKED }],
      [() => Response.json({ sessionId: 7 }, { status: 201 }), 502, { error: HUDDLES_UNCHECKED }],
      [() => new Response(null, { status: 302, headers: { Location: "https://example.com/" } }), 502, { error: HUDDLES_UNCHECKED }],
      [() => Promise.reject(new TypeError("Network connection lost")), 502, { error: HUDDLES_UNCHECKED }],
    ];
    for (const [answer, status, refusal] of refusals) {
      const requests = fakeSfu(answer);
      const response = await giveKeys(administrator, APP);
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual(refusal);
      expect(requests).toHaveLength(1);
      vi.mocked(fetch).mockRestore();
    }
    expect(await storedSettings()).not.toHaveProperty("huddles");
    expect(await huddlesSettings(administrator)).toBeNull();
    expect(warned).toHaveBeenCalledWith("The Realtime SFU didn't start a session:", 404, "not_found");
    expect(warned).toHaveBeenCalledWith("The Realtime SFU didn't start a session:", 403, null);
    expect(logged).toHaveBeenCalledWith("Asking the Realtime SFU to start a session failed:", "TypeError");
    const said = JSON.stringify([...warned.mock.calls, ...logged.mock.calls]);
    expect(said).not.toContain(APP.appSecret);
    expect(said).not.toContain(APP.appId);
  });

  it("keeps the app huddles run through when another's keys are refused", async () => {
    const administrator = await setUp();
    fakeSfu();
    await saveKeys(administrator);
    vi.mocked(fetch).mockRestore();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeSfu(() => Response.json({ errorCode: "unauthorized" }, { status: 401 }));
    expect((await giveKeys(administrator, OTHER_APP)).status).toBe(422);
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: null });
  });

  it("lets only administrators turn huddles on or off, asking Cloudflare nothing for anyone else", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");
    const requests = fakeSfu();
    const forbidden = await giveKeys(member, APP);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: HUDDLES_FORBIDDEN });
    expect((await giveKeys(null, APP)).status).toBe(401);
    // Before anything they sent is read.
    expect((await giveKeys(member, { appId: "not an app" })).status).toBe(403);
    expect(requests).toEqual([]);
    expect(await storedSettings()).not.toHaveProperty("huddles");

    await saveKeys(administrator);
    const refused = await turnOff(member);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: HUDDLES_FORBIDDEN });
    expect((await turnOff(null)).status).toBe(401);
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: null });
    // Which app they run through is the administrators' to see.
    expect(await huddlesSettings(member)).toBeNull();
  });

  it("tells every page whether huddles are on, as they're turned on and off, and never which app they run through", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");
    fakeSfu();
    expect((await settings(member)).account.huddles).toBe(false);
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(member)];

    await saveKeys(administrator);
    for (const socket of sockets) {
      const heard = await socket.next();
      expect(heard).toMatchObject({ type: "account.updated", account: { huddles: true } });
      expect(JSON.stringify(heard)).not.toContain(APP.appId);
    }
    expect((await settings(member)).account.huddles).toBe(true);
    // As it does once the Workspace starts afresh.
    await evictDurableObject(workspaceStub());
    expect((await settings(member)).account.huddles).toBe(true);

    // Another app's keys leave them on, and turning them off says so once.
    const again = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(member)];
    await saveKeys(administrator, OTHER_APP);
    for (const socket of again) expect(await socket.next()).toMatchObject({ type: "account.updated", account: { huddles: true } });
    expect((await turnOff(administrator)).status).toBe(200);
    for (const socket of again) expect(await socket.next()).toMatchObject({ type: "account.updated", account: { huddles: false } });
    expect((await turnOff(administrator)).status).toBe(200);
    for (const socket of again) expect(await socket.answers()).toBe(true);
    expect((await settings(member)).account.huddles).toBe(false);
  });

  it("turns huddles off, forgetting the app's keys", async () => {
    const administrator = await setUp();
    const requests = fakeSfu();
    await saveKeys(administrator);
    const response = await turnOff(administrator);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ huddles: null } satisfies HuddlesForgotten);
    expect((await storedSettings()).huddles).toBeNull();
    expect(await huddlesSettings(administrator)).toBeNull();
    await evictDurableObject(workspaceStub());
    expect(await huddlesSettings(administrator)).toBeNull();
    // Turning off what's off changes nothing, and Cloudflare is asked nothing to turn them off.
    expect(await (await turnOff(administrator)).json()).toEqual({ huddles: null });
    expect(requests).toHaveLength(1);
  });

  it("counts huddles as off while the app's secret doesn't open under SESSION_SECRET, which it logs", async () => {
    const administrator = await setUp();
    fakeSfu();
    await saveKeys(administrator);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await withWorkspaceEnv({ SESSION_SECRET: "another secret, after the app's was sealed" }, async () => {
      expect(await huddlesSettings(administrator)).toBeNull();
      // Nor is any page told they're on, whose rooms would have a huddle button that starts nothing.
      expect((await settings(administrator)).account.huddles).toBe(false);
      expect((await openWorkspaceSocket(administrator)).welcome).toMatchObject({ account: { huddles: false } });
    });
    expect(logged).toHaveBeenCalledWith("The SFU app secret Ember was given doesn't open under SESSION_SECRET, so huddles are off.");
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: null });
    expect((await settings(administrator)).account.huddles).toBe(true);
  });

  it("asks a stand-in for the Realtime SFU only at a loopback address", async () => {
    const administrator = await setUp();
    const requests = fakeSfu();
    for (const REALTIME_SFU_URL of ["http://127.0.0.1:8794", " http://localhost:8794/ ", "https://sfu.example.com", "http://10.0.0.1:8794", "not a url", ""]) {
      expect((await giveKeys(administrator, APP, { REALTIME_SFU_URL })).status, REALTIME_SFU_URL).toBe(200);
    }
    expect(requests.map(({ url }) => url)).toEqual([
      newSession(APP.appId, "http://127.0.0.1:8794"),
      newSession(APP.appId, "http://localhost:8794"),
      newSession(APP.appId),
      newSession(APP.appId),
      newSession(APP.appId),
      newSession(APP.appId),
    ]);
  });
});

describe("Set up the relay", () => {
  it("keeps a TURN key once Cloudflare has made a relay's servers with it, its API token sealed", async () => {
    const { administrator, requests } = await setUpWithHuddles();
    const response = await giveRelay(administrator, { keyId: ` ${RELAY.keyId} `, apiToken: `${RELAY.apiToken}\n` });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ huddles: { appId: APP.appId, relayKeyId: RELAY.keyId } } satisfies HuddlesSaved);
    // Asked as a room asks for a tab, for servers good for a day.
    expect(RELAY_TTL_S).toBe(86_400);
    expect(requests).toEqual([{ url: relayServers(RELAY.keyId), authorization: `Bearer ${RELAY.apiToken}`, ...MAKING }]);

    // The database holds the token sealed, never as it was given, and nothing of what Cloudflare made.
    const stored = (await storedSettings()).huddles as { relay: { key_id: string; api_token: string } };
    expect(stored).toEqual({ app_id: APP.appId, app_secret: expect.any(String) as unknown, relay: { key_id: RELAY.keyId, api_token: expect.stringMatching(/^v1\.[\w-]{16}\.[\w-]+$/) as unknown } });
    const kept = JSON.stringify(await workspaceSql("SELECT * FROM accounts"));
    expect(kept).not.toContain(RELAY.apiToken);
    expect(kept).not.toContain("the relay's");
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: RELAY.keyId });
    // As it does once the Workspace starts afresh, when a room is told of the key, its token opened, with the app.
    await evictDurableObject(workspaceStub());
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: RELAY.keyId });
    expect(await workspaceStub().huddleApp()).toEqual({ ...APP, cameras: true, screens: true, relay: RELAY });

    // Given again, it's sealed afresh.
    await saveRelay(administrator);
    expect(((await storedSettings()).huddles as typeof stored).relay.api_token).not.toBe(stored.relay.api_token);
  });

  it("relays by another TURN key once it's given, and keeps the one it has when another's is refused", async () => {
    const { administrator, requests } = await setUpWithHuddles();
    await saveRelay(administrator);
    const response = await giveRelay(administrator, OTHER_RELAY);
    expect(await response.json()).toEqual({ huddles: { appId: APP.appId, relayKeyId: OTHER_RELAY.keyId } });
    expect(requests.at(-1)).toEqual({ url: relayServers(OTHER_RELAY.keyId), authorization: `Bearer ${OTHER_RELAY.apiToken}`, ...MAKING });
    expect(JSON.stringify(await storedSettings())).not.toContain(RELAY.keyId);

    vi.mocked(fetch).mockRestore();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeRelay(() => new Response(null, { status: 401 }));
    expect((await giveRelay(administrator, RELAY)).status).toBe(422);
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: OTHER_RELAY.keyId });
    expect(await workspaceStub().huddleApp()).toMatchObject({ relay: OTHER_RELAY });
  });

  it("says why a key isn't kept, on the field it's about, asking Cloudflare nothing of what can't be a TURN key", async () => {
    const { administrator, requests: unasked } = await setUpWithHuddles();
    const refusals: Array<[unknown, string, string]> = [
      [{ ...RELAY, keyId: "my turn key" }, "keyId", RELAY_KEY_ID_REFUSED],
      [{ ...RELAY, keyId: `${RELAY.keyId}/../${OTHER_RELAY.keyId}` }, "keyId", RELAY_KEY_ID_REFUSED],
      [{ ...RELAY, keyId: `${RELAY.keyId}?ttl=1` }, "keyId", RELAY_KEY_ID_REFUSED],
      [{ ...RELAY, keyId: "a".repeat(65) }, "keyId", RELAY_KEY_ID_REFUSED],
      [{ ...RELAY, keyId: 42 }, "keyId", RELAY_KEY_ID_REFUSED],
      [{ apiToken: RELAY.apiToken }, "keyId", RELAY_KEY_ID_REFUSED],
      [{ ...RELAY, apiToken: `Bearer ${RELAY.apiToken}` }, "apiToken", RELAY_API_TOKEN_REFUSED],
      [{ ...RELAY, apiToken: `${RELAY.apiToken}\r\nX-Other: 1` }, "apiToken", RELAY_API_TOKEN_REFUSED],
      [{ ...RELAY, apiToken: "a".repeat(257) }, "apiToken", RELAY_API_TOKEN_REFUSED],
      [{ keyId: RELAY.keyId }, "apiToken", RELAY_API_TOKEN_REFUSED],
      [null, "keyId", RELAY_KEY_ID_REFUSED],
      [[RELAY.keyId, RELAY.apiToken], "keyId", RELAY_KEY_ID_REFUSED],
    ];
    for (const [given, field, error] of refusals) {
      const response = await giveRelay(administrator, given);
      expect(response.status, JSON.stringify(given)).toBe(422);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ error, field });
    }
    expect(unasked).toEqual([]);
    expect((await storedSettings()).huddles).not.toHaveProperty("relay");
  });

  it("says why Cloudflare didn't make a relay's servers, keeping no key, and logs its status but never the key", async () => {
    const { administrator } = await setUpWithHuddles();
    vi.mocked(fetch).mockRestore();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const [stun, relay] = relayServersMade().iceServers;
    const refusals: Array<[() => Response | Promise<Response>, number, Record<string, string>]> = [
      [() => new Response(null, { status: 404 }), 422, { error: RELAY_KEY_ID_UNKNOWN, field: "keyId" }],
      [() => Response.json({ error: "No such key" }, { status: 400 }), 422, { error: RELAY_KEY_ID_UNKNOWN, field: "keyId" }],
      [() => new Response(null, { status: 401 }), 422, { error: RELAY_API_TOKEN_UNKNOWN, field: "apiToken" }],
      [() => new Response("Forbidden", { status: 403 }), 422, { error: RELAY_API_TOKEN_UNKNOWN, field: "apiToken" }],
      // A refusal that carries servers is a refusal still.
      [() => Response.json(relayServersMade(), { status: 401 }), 422, { error: RELAY_API_TOKEN_UNKNOWN, field: "apiToken" }],
      [() => new Response(null, { status: 500 }), 502, { error: RELAY_UNCHECKED }],
      [() => new Response(null, { status: 429 }), 502, { error: RELAY_UNCHECKED }],
      // Servers it doesn't name, or names without a relay's among them, or without what a relay is used with, aren't a relay's.
      [() => new Response("<html>", { status: 201 }), 502, { error: RELAY_UNCHECKED }],
      [() => Response.json({ iceServers: [stun] }, { status: 201 }), 502, { error: RELAY_UNCHECKED }],
      [() => Response.json({ iceServers: [stun, { urls: relay!.urls, username: relay!.username }] }, { status: 201 }), 502, { error: RELAY_UNCHECKED }],
      [() => new Response(null, { status: 302, headers: { Location: "https://example.com/" } }), 502, { error: RELAY_UNCHECKED }],
      [() => Promise.reject(new TypeError("Network connection lost")), 502, { error: RELAY_UNCHECKED }],
    ];
    for (const [answer, status, refusal] of refusals) {
      const requests = fakeRelay(answer);
      const response = await giveRelay(administrator, RELAY);
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual(refusal);
      expect(requests).toHaveLength(1);
      vi.mocked(fetch).mockRestore();
    }
    expect((await storedSettings()).huddles).not.toHaveProperty("relay");
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: null });
    expect(warned).toHaveBeenCalledWith("Cloudflare didn't give the relay's servers:", 404);
    expect(warned).toHaveBeenCalledWith("Cloudflare didn't give the relay's servers:", 201);
    expect(logged).toHaveBeenCalledWith("Asking Cloudflare for the relay's servers failed:", "TypeError");
    const said = JSON.stringify([...warned.mock.calls, ...logged.mock.calls]);
    expect(said).not.toContain(RELAY.apiToken);
    expect(said).not.toContain(RELAY.keyId);
  });

  it("lets only administrators give huddles a relay or take it away, asking Cloudflare nothing for anyone else", async () => {
    const { administrator, requests } = await setUpWithHuddles();
    const member = await signIn("Grace");
    const forbidden = await giveRelay(member, RELAY);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: HUDDLES_FORBIDDEN });
    expect((await giveRelay(null, RELAY)).status).toBe(401);
    // Before anything they sent is read.
    expect((await giveRelay(member, { keyId: "not a key" })).status).toBe(403);
    expect(requests).toEqual([]);
    expect((await storedSettings()).huddles).not.toHaveProperty("relay");

    await saveRelay(administrator);
    const refused = await takeRelayAway(member);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: HUDDLES_FORBIDDEN });
    expect((await takeRelayAway(null)).status).toBe(401);
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: RELAY.keyId });
  });

  it("tells no page of the relay, which only administrators' settings show", async () => {
    const { administrator } = await setUpWithHuddles();
    const member = await signIn("Grace");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(member)];
    await saveRelay(administrator);
    expect(JSON.stringify([await settings(member), await shownAccount()])).not.toContain(RELAY.keyId);
    expect((await takeRelayAway(administrator)).status).toBe(200);
    for (const socket of sockets) expect(await socket.answers()).toBe(true);
  });

  it("keeps no TURN key while huddles are off, which it says", async () => {
    const administrator = await setUp();
    fakeRelay();
    const response = await giveRelay(administrator, RELAY);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: RELAY_WITHOUT_HUDDLES });
    expect(await storedSettings()).not.toHaveProperty("huddles");
    // With no relay to take away, taking it away changes nothing.
    const taken = await takeRelayAway(administrator);
    expect(taken.status).toBe(200);
    expect(await taken.json()).toEqual({ huddles: null } satisfies HuddlesForgotten);
    expect(await storedSettings()).not.toHaveProperty("huddles");
  });

  it("keeps none while the app's secret doesn't open either, when it's as if huddles were off", async () => {
    const { administrator } = await setUpWithHuddles();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await withWorkspaceEnv({ SESSION_SECRET: "another secret, after the app's was sealed" }, async () => {
      const response = await giveRelay(administrator, RELAY);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: RELAY_WITHOUT_HUDDLES });
      expect(await (await takeRelayAway(administrator)).json()).toEqual({ huddles: null });
    });
    expect((await storedSettings()).huddles).not.toHaveProperty("relay");
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: null });
  });

  it("keeps the relay through a change of SFU app, and forgets its key when huddles are turned off", async () => {
    const { administrator } = await setUpWithHuddles();
    await saveRelay(administrator);
    const changed = await giveKeys(administrator, OTHER_APP);
    expect(await changed.json()).toEqual({ huddles: { appId: OTHER_APP.appId, relayKeyId: RELAY.keyId } });
    expect(await workspaceStub().huddleApp()).toEqual({ ...OTHER_APP, cameras: true, screens: true, relay: RELAY });

    expect((await turnOff(administrator)).status).toBe(200);
    expect((await storedSettings()).huddles).toBeNull();
    expect(JSON.stringify(await workspaceSql("SELECT * FROM accounts"))).not.toContain(RELAY.keyId);
    // Turned on again, they have no relay.
    await saveKeys(administrator);
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: null });
  });

  it("takes the relay away, forgetting the TURN key", async () => {
    const { administrator, requests } = await setUpWithHuddles();
    await saveRelay(administrator);
    const response = await takeRelayAway(administrator);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ huddles: { appId: APP.appId, relayKeyId: null } } satisfies HuddlesSaved);
    expect((await storedSettings()).huddles).toEqual({ app_id: APP.appId, app_secret: expect.any(String) as unknown });
    expect(await workspaceStub().huddleApp()).toEqual({ ...APP, cameras: true, screens: true, relay: null });
    await evictDurableObject(workspaceStub());
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: null });
    // Taking away what's gone changes nothing, and Cloudflare is asked nothing to take it away.
    expect(await (await takeRelayAway(administrator)).json()).toEqual({ huddles: { appId: APP.appId, relayKeyId: null } });
    expect(requests).toHaveLength(1);
  });

  it("counts huddles as without a relay while the key's API token doesn't open, which it logs", async () => {
    const { administrator } = await setUpWithHuddles();
    await saveRelay(administrator);
    // Sealed for something else, as the app's secret is, it doesn't open as the key's token.
    const stored = await storedSettings();
    const { app_secret: sealedForTheApp } = stored.huddles as { app_secret: string };
    await workspaceSql("UPDATE accounts SET settings = ?", JSON.stringify({ ...stored, huddles: { ...(stored.huddles as object), relay: { key_id: RELAY.keyId, api_token: sealedForTheApp } } }));
    await evictDurableObject(workspaceStub());
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId, relayKeyId: null });
    expect(await workspaceStub().huddleApp()).toEqual({ ...APP, cameras: true, screens: true, relay: null });
    expect(logged).toHaveBeenCalledWith("The TURN key's API token Ember was given doesn't open under SESSION_SECRET, so huddles have no relay.");
    // Huddles go on without it, and take another key.
    expect((await settings(administrator)).account.huddles).toBe(true);
    await saveRelay(administrator, OTHER_RELAY);
    expect(await workspaceStub().huddleApp()).toMatchObject({ relay: OTHER_RELAY });
  });

  it("asks a stand-in for the TURN service only at a loopback address", async () => {
    const { administrator, requests } = await setUpWithHuddles();
    for (const REALTIME_SFU_URL of ["http://127.0.0.1:8794", " http://localhost:8794/ ", "https://sfu.example.com", "http://10.0.0.1:8794", "not a url", ""]) {
      expect((await giveRelay(administrator, RELAY, { REALTIME_SFU_URL })).status, REALTIME_SFU_URL).toBe(200);
    }
    expect(requests.map(({ url }) => url)).toEqual([
      relayServers(RELAY.keyId, "http://127.0.0.1:8794"),
      relayServers(RELAY.keyId, "http://localhost:8794"),
      relayServers(RELAY.keyId),
      relayServers(RELAY.keyId),
      relayServers(RELAY.keyId),
      relayServers(RELAY.keyId),
    ]);
  });
});

describe("Cameras in huddles (setting)", () => {
  it("lets cameras go on until an administrator turns them off, before first run too", async () => {
    expect((await shownAccount()).huddleCameras).toBe(true);
    const administrator = await setUp();
    expect((await settings(administrator)).account.huddleCameras).toBe(true);
    expect(await storedSettings()).not.toHaveProperty("huddle_cameras");
  });

  it("goes off and on for everyone as an administrator switches it, whether or not huddles are on, keeping the other settings", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");
    fakeSfu();
    await saveKeys(administrator);
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(member)];

    const response = await switchCameras(administrator, false);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account: { huddles: true, huddleCameras: false } });
    expect(await storedSettings()).toMatchObject({ huddle_cameras: false, huddles: { app_id: APP.appId } });
    for (const socket of sockets) expect(await socket.next()).toMatchObject({ type: "account.updated", account: { huddles: true, huddleCameras: false } });
    expect((await settings(member)).account.huddleCameras).toBe(false);
    // As it is once the Workspace starts afresh, and for a page nobody has signed in on.
    await evictDurableObject(workspaceStub());
    expect((await shownAccount()).huddleCameras).toBe(false);

    // Off already, it's nothing new, and huddles going off leave it as it was.
    const again = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(member)];
    expect((await switchCameras(administrator, false)).status).toBe(200);
    for (const socket of again) expect(await socket.answers()).toBe(true);
    expect((await turnOff(administrator)).status).toBe(200);
    for (const socket of again) expect(await socket.next()).toMatchObject({ type: "account.updated", account: { huddles: false, huddleCameras: false } });
    expect(await (await switchCameras(administrator, true)).json()).toMatchObject({ account: { huddles: false, huddleCameras: true } });
    for (const socket of again) expect(await socket.next()).toMatchObject({ type: "account.updated", account: { huddles: false, huddleCameras: true } });
    expect(await storedSettings()).toMatchObject({ huddle_cameras: true });
  });

  it("lets only administrators switch it, and takes only true or false", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");
    expect((await switchCameras(member, false)).status).toBe(403);
    expect((await switchCameras(null, false)).status).toBe(401);
    const refused = await switchCameras(administrator, "off");
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "Cameras must be true or false" });
    expect((await shownAccount()).huddleCameras).toBe(true);
    expect(await storedSettings()).not.toHaveProperty("huddle_cameras");
  });

  it("tells a room whether cameras may go on, along with the app huddles run through", async () => {
    const administrator = await setUp();
    fakeSfu();
    await saveKeys(administrator);
    expect(await workspaceStub().huddleApp()).toEqual({ ...APP, cameras: true, screens: true, relay: null });
    await switchCameras(administrator, false);
    expect(await workspaceStub().huddleApp()).toEqual({ ...APP, cameras: false, screens: true, relay: null });
    await switchCameras(administrator, true);
    expect(await workspaceStub().huddleApp()).toEqual({ ...APP, cameras: true, screens: true, relay: null });
    // There's no app to tell it of while huddles are off.
    await turnOff(administrator);
    expect(await workspaceStub().huddleApp()).toBeNull();
  });

  it.each([
    ["null", '{"huddle_cameras":null}'],
    ["text", '{"huddle_cameras":"false"}'],
    ["a number", '{"huddle_cameras":0}'],
    ["settings that aren't an object", "[]"],
    ["settings that don't parse", "not JSON"],
  ])("keeps cameras on for a workspace that stored %s, which only false turns off", async (_, stored) => {
    await setUp();
    await workspaceSql("UPDATE accounts SET settings = ?", stored);
    // Started afresh, the Workspace has to read the account again.
    await evictDurableObject(workspaceStub());
    expect((await shownAccount()).huddleCameras).toBe(true);
  });
});

describe("Screen sharing in huddles (setting)", () => {
  it("lets screens be shared until an administrator turns that off, before first run too", async () => {
    expect((await shownAccount()).huddleScreens).toBe(true);
    const administrator = await setUp();
    expect((await settings(administrator)).account.huddleScreens).toBe(true);
    expect(await storedSettings()).not.toHaveProperty("huddle_screens");
  });

  it("goes off and on for everyone as an administrator switches it, whether or not huddles are on, leaving cameras as they were", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");
    fakeSfu();
    await saveKeys(administrator);
    await switchCameras(administrator, false);
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(member)];

    const response = await switchScreens(administrator, false);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account: { huddles: true, huddleCameras: false, huddleScreens: false } });
    expect(await storedSettings()).toMatchObject({ huddle_screens: false, huddle_cameras: false, huddles: { app_id: APP.appId } });
    for (const socket of sockets) expect(await socket.next()).toMatchObject({ type: "account.updated", account: { huddles: true, huddleCameras: false, huddleScreens: false } });
    expect((await settings(member)).account.huddleScreens).toBe(false);
    // As it is once the Workspace starts afresh, and for a page nobody has signed in on.
    await evictDurableObject(workspaceStub());
    expect((await shownAccount()).huddleScreens).toBe(false);

    // Off already, it's nothing new, and huddles going off leave it as it was.
    const again = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(member)];
    expect((await switchScreens(administrator, false)).status).toBe(200);
    for (const socket of again) expect(await socket.answers()).toBe(true);
    expect((await turnOff(administrator)).status).toBe(200);
    for (const socket of again) expect(await socket.next()).toMatchObject({ type: "account.updated", account: { huddles: false, huddleScreens: false } });
    expect(await (await switchScreens(administrator, true)).json()).toMatchObject({ account: { huddles: false, huddleCameras: false, huddleScreens: true } });
    for (const socket of again) expect(await socket.next()).toMatchObject({ type: "account.updated", account: { huddles: false, huddleCameras: false, huddleScreens: true } });
    expect(await storedSettings()).toMatchObject({ huddle_screens: true, huddle_cameras: false });
  });

  it("lets only administrators switch it, and takes only true or false", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");
    expect((await switchScreens(member, false)).status).toBe(403);
    expect((await switchScreens(null, false)).status).toBe(401);
    const refused = await switchScreens(administrator, "off");
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "Screen sharing must be true or false" });
    expect((await shownAccount()).huddleScreens).toBe(true);
    expect(await storedSettings()).not.toHaveProperty("huddle_screens");
  });

  it("tells a room whether screens may be shared, along with the app huddles run through", async () => {
    const administrator = await setUp();
    fakeSfu();
    await saveKeys(administrator);
    await switchScreens(administrator, false);
    expect(await workspaceStub().huddleApp()).toEqual({ ...APP, cameras: true, screens: false, relay: null });
    await switchScreens(administrator, true);
    expect(await workspaceStub().huddleApp()).toEqual({ ...APP, cameras: true, screens: true, relay: null });
  });

  it.each([
    ["null", '{"huddle_screens":null}'],
    ["text", '{"huddle_screens":"false"}'],
    ["a number", '{"huddle_screens":0}'],
  ])("keeps screen sharing on for a workspace that stored %s, which only false turns off", async (_, stored) => {
    await setUp();
    await workspaceSql("UPDATE accounts SET settings = ?", stored);
    // Started afresh, the Workspace has to read the account again.
    await evictDurableObject(workspaceStub());
    expect((await shownAccount()).huddleScreens).toBe(true);
  });
});

describe("Allow huddles in a room (setting)", () => {
  it("tells a room whether its own settings allow huddles in it, with the app huddles run through either way", async () => {
    const administrator = await setUp();
    fakeSfu();
    await saveKeys(administrator);
    const [room, other] = [await createRoom("Announcements", { as: administrator }), await createRoom("Design", { as: administrator })];
    const app = { ...APP, cameras: true, screens: true, relay: null };
    expect(await workspaceStub().huddlesIn(room.id)).toEqual({ app, allowed: true });

    expect((await api(`/api/rooms/${room.id}`, { method: "PATCH", headers: as(administrator), body: JSON.stringify({ huddles: false }) })).status).toBe(200);
    expect(await workspaceStub().huddlesIn(room.id)).toEqual({ app, allowed: false });
    // Another room's still do, and so do those of a room the Workspace doesn't know.
    expect(await workspaceStub().huddlesIn(other.id)).toEqual({ app, allowed: true });
    expect(await workspaceStub().huddlesIn("no such room")).toEqual({ app, allowed: true });

    // There's no app to tell it of while huddles are off.
    await turnOff(administrator);
    expect(await workspaceStub().huddlesIn(room.id)).toEqual({ app: null, allowed: false });
    expect(await workspaceStub().huddlesIn(other.id)).toEqual({ app: null, allowed: true });
  });
});
