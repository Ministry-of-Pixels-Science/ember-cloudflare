import type { Bootstrap, NewWorkspace, WorkspaceSettings } from "@ember/protocol";
import {
  APP_ID_REFUSED,
  APP_ID_UNKNOWN,
  APP_SECRET_REFUSED,
  APP_SECRET_UNKNOWN,
  HUDDLES_FORBIDDEN,
  HUDDLES_UNCHECKED,
  type HuddlesForgotten,
  type HuddlesSaved,
} from "@ember/protocol/huddles";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { APP, OTHER_APP } from "./huddle-support";
import { api, apiWith, cookieOf, freshDeploy, openWorkspaceSocket, shown, signIn, withWorkspaceEnv, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Where Cloudflare's Realtime SFU is asked to start a session with an app, or a stand-in for it at `sfu`. */
const newSession = (appId: string, sfu = "https://rtc.live.cloudflare.com") => `${sfu}/v1/apps/${appId}/sessions/new`;

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

/** A request the fake SFU was sent. */
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
    expect(await response.json()).toEqual({ huddles: { appId: APP.appId } } satisfies HuddlesSaved);
    expect(requests).toEqual([{ url: newSession(APP.appId), method: "POST", authorization: `Bearer ${APP.appSecret}`, body: "" }]);

    // The database holds the secret sealed, never as it was given.
    const stored = (await storedSettings()).huddles as { app_id: string; app_secret: string };
    expect(stored).toEqual({ app_id: APP.appId, app_secret: expect.stringMatching(/^v1\.[\w-]{16}\.[\w-]+$/) as unknown });
    expect(JSON.stringify(await workspaceSql("SELECT * FROM accounts"))).not.toContain(APP.appSecret);
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId });
    // As it does once the Workspace starts afresh.
    await evictDurableObject(workspaceStub());
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId });

    // Given again, it's sealed afresh.
    await saveKeys(administrator);
    expect(((await storedSettings()).huddles as typeof stored).app_secret).not.toBe(stored.app_secret);
  });

  it("runs huddles through another app once its keys are given", async () => {
    const administrator = await setUp();
    const requests = fakeSfu();
    await saveKeys(administrator);
    const response = await giveKeys(administrator, OTHER_APP);
    expect(await response.json()).toEqual({ huddles: { appId: OTHER_APP.appId } });
    expect(requests.at(-1)).toEqual({ url: newSession(OTHER_APP.appId), method: "POST", authorization: `Bearer ${OTHER_APP.appSecret}`, body: "" });
    expect(await huddlesSettings(administrator)).toEqual({ appId: OTHER_APP.appId });
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
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId });
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
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId });
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
    expect(await huddlesSettings(administrator)).toEqual({ appId: APP.appId });
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
    expect(await workspaceStub().huddleApp()).toEqual({ ...APP, cameras: true, screens: true });
    await switchCameras(administrator, false);
    expect(await workspaceStub().huddleApp()).toEqual({ ...APP, cameras: false, screens: true });
    await switchCameras(administrator, true);
    expect(await workspaceStub().huddleApp()).toEqual({ ...APP, cameras: true, screens: true });
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
    expect(await workspaceStub().huddleApp()).toEqual({ ...APP, cameras: true, screens: false });
    await switchScreens(administrator, true);
    expect(await workspaceStub().huddleApp()).toEqual({ ...APP, cameras: true, screens: true });
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
