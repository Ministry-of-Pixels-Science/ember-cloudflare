import { ASSISTANT_ID, AVATAR_TOO_LARGE, MAX_AVATAR_SIZE, type Directory, type DirectoryUser, type Me, type NewWorkspace, type WorkspaceSettings } from "@ember/protocol";
import { ASSISTANT_FORBIDDEN, ASSISTANT_OFF, type AssistantChanged, type AssistantSettings } from "@ember/protocol/assistant";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { NO_STORAGE } from "../src/files/uploads";
import { api, apiWith, avatarVersionOf, cookieOf, freshDeploy, openWorkspaceSocket, origin, recordedImage, shown, stopTheClock, WITH_THE_FLAME, workspaceSql, type Session } from "./support";

// @ember's avatar, which administrators replace on the Ember AI card while it's on, and take away again
// to bring back Ember's flame.

const files = (env as unknown as Env).FILES!;

const SETUP = { accountId: "0123456789abcdef0123456789abcdef", apiToken: "an-api-token-with-ai-gateway-run_0123456", model: "anthropic/claude-haiku-5.5" };
const PATH = "/api/account/assistant/avatar";

/** Ember's flame, as the built app's files have it, which these tests stand in for. */
const FLAME = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="#FF5F0F"/></svg>';
const builtFiles = {
  fetch: async (input: Request | string | URL) =>
    new URL(input instanceof Request ? input.url : input).pathname === "/assistant-avatar.svg" ? new Response(FLAME) : new Response("Not found", { status: 404 }),
} as unknown as Fetcher;

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Grace joins with the join link, as a member, signed in. */
async function joinAsGrace(): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify({ name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" }) });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** Turns Ember AI on as `administrator`, its model saying hello to the test question. */
async function turnOn(administrator: Session): Promise<void> {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ type: "message", role: "assistant", content: [{ type: "text", text: "Hello, team!" }], stop_reason: "end_turn" }),
  );
  const response = await api("/api/account/assistant", { method: "PUT", headers: as(administrator), body: JSON.stringify(SETUP) });
  expect(response.status, await response.clone().text()).toBe(200);
  fetch.mockRestore();
}

/** Turns Ember AI off as `administrator`. */
async function turnOff(administrator: Session): Promise<void> {
  expect((await api("/api/account/assistant", { method: "DELETE", headers: as(administrator) })).status).toBe(200);
}

/** moon.jpg, a JPEG of 640×640, with the WebP of 512×512 the browser makes of it, as the app sends them. */
function moonForm(): FormData {
  const form = new FormData();
  form.append("avatar", new File([recordedImage("moon-thumb.jpg")], "moon.jpg", { type: "image/jpeg" }));
  form.append("variant", new File([recordedImage("moon-avatar.webp")], "blob", { type: "image/webp" }));
  return form;
}

/** `form` as a browser sends it, with its length. */
async function encoded(form: FormData): Promise<{ body: ArrayBuffer; headers: Record<string, string> }> {
  const request = new Request(origin, { method: "POST", body: form });
  const body = await request.arrayBuffer();
  return { body, headers: { "Content-Type": request.headers.get("Content-Type")!, "Content-Length": String(body.byteLength) } };
}

/** Uploads `form` as @ember's avatar, as `session`, as a picture chosen on the Ember AI card does. */
async function upload(session: Session | null, form = moonForm(), changes: Partial<Env> = {}): Promise<Response> {
  const { body, headers } = await encoded(form);
  return apiWith(changes, PATH, { method: "PUT", headers: { ...as(session), ...headers }, body });
}

/** Uploads moon.jpg as @ember's avatar, as `administrator`, answering Ember AI then. */
async function uploadMoon(administrator: Session): Promise<AssistantSettings> {
  const response = await upload(administrator);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as AssistantChanged).assistant;
}

/** Takes away @ember's avatar, as `session`, as Use Ember's flame does. */
const useTheFlame = (session: Session | null) => api(PATH, { method: "DELETE", headers: as(session) });

/** Ember AI as the workspace's settings show it to `session`. */
const assistantSettings = async (session: Session) => ((await (await api("/api/account", { headers: as(session) })).json()) as WorkspaceSettings).assistant;

/** @ember as the people directory lists it to `viewer`. */
async function listedEmber(viewer: Session): Promise<DirectoryUser> {
  const { users } = (await (await api("/api/users", { headers: as(viewer) })).json()) as Directory;
  return users.find(({ id }) => id === ASSISTANT_ID)!;
}

/** The picture at `avatarUrl`, as `viewer` is served it, from the built app's files for Ember's flame. */
const served = (avatarUrl: string, viewer: Session) => apiWith({ ASSETS: builtFiles }, avatarUrl, { headers: as(viewer) });

/** @ember's avatar as the database keeps it. */
const storedAvatar = async () =>
  ((await workspaceSql("SELECT avatar_key, avatar_variant, updated_at FROM users WHERE id = ?", ASSISTANT_ID)) as Array<{ avatar_key: string | null; avatar_variant: string | null; updated_at: string }>)[0]!;

/** Everything R2 keeps of avatars. */
const storedAvatars = async () => (await files.list({ prefix: "avatars/" })).objects.map(({ key }) => key);

const pendingDeletions = () => workspaceSql("SELECT object_key FROM pending_picture_deletions ORDER BY object_key");

/** Waits for the Workspace to have R2 delete the pictures it has queued, and to forget them. */
const deleted = () => vi.waitFor(async () => expect(await pendingDeletions()).toEqual([]), { timeout: 5_000 });

beforeEach(freshDeploy);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("@ember's avatar", () => {
  it("is Ember's flame until an administrator uploads one, which everyone's served as its variant, at a new address every open page hears of", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    await turnOn(ada);
    const flame = await listedEmber(ada);
    expect(await assistantSettings(ada)).toMatchObject({ ...WITH_THE_FLAME, avatarUrl: flame.avatarUrl });
    const socket = await openWorkspaceSocket(grace);

    const response = await upload(ada);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { assistant } = (await response.json()) as AssistantChanged;
    const ember = await listedEmber(grace);
    expect(assistant).toEqual({ ...(await assistantSettings(ada))!, avatarUrl: ember.avatarUrl, avatar: true });
    expect(ember.avatarUrl).not.toBe(flame.avatarUrl);
    expect(await socket.next()).toEqual({ type: "user.updated", user: ember });

    const picture = await served(ember.avatarUrl, grace);
    expect(picture.headers.get("Content-Type")).toBe("image/webp");
    expect(new Uint8Array(await picture.arrayBuffer())).toEqual(recordedImage("moon-avatar.webp"));
    const { avatar_key: key, avatar_variant: variant } = await storedAvatar();
    expect(key).toMatch(/^avatars\/[0-9a-z]{28}$/);
    expect(variant).toBe("image/webp");
    // Giving it to @ember took its reservation, so it's kept.
    expect(await pendingDeletions()).toEqual([]);
  });

  it("has R2 delete the picture a new one replaces, and the one Use Ember's flame takes away, bringing back the flame", async () => {
    const ada = await setUp();
    await turnOn(ada);
    await uploadMoon(ada);
    const first = (await storedAvatar()).avatar_key!;
    const replaced = await uploadMoon(ada);
    const second = (await storedAvatar()).avatar_key!;
    expect(second).not.toBe(first);
    await deleted();
    expect(await storedAvatars()).toEqual([second, `${second}/512`]);

    const pictured = await listedEmber(ada);
    const socket = await openWorkspaceSocket(ada);
    const response = await useTheFlame(ada);
    expect(response.status).toBe(200);
    const { assistant } = (await response.json()) as AssistantChanged;
    const ember = await listedEmber(ada);
    expect(assistant).toEqual({ ...replaced, avatarUrl: ember.avatarUrl, avatar: false });
    expect(ember.avatarUrl).not.toBe(pictured.avatarUrl);
    expect(await socket.next()).toEqual({ type: "user.updated", user: ember });
    const flame = await served(ember.avatarUrl, ada);
    expect(flame.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(await flame.text()).toBe(FLAME);
    expect(await storedAvatar()).toMatchObject({ avatar_key: null, avatar_variant: null });
    await deleted();
    expect(await storedAvatars()).toEqual([]);

    // Ember's flame already, it changes nothing.
    const unchanged = await storedAvatar();
    expect(await (await useTheFlame(ada)).json()).toEqual({ assistant });
    expect(await storedAvatar()).toEqual(unchanged);
  });

  it("has a later address after each change, even one in the same second as the last, which nothing after takes back, as browsers keep the picture they have at one", async () => {
    const ada = await setUp();
    // Turning Ember AI on, uploading a picture, turning Ember AI off and on again and taking the picture away, all at once.
    stopTheClock();
    await turnOn(ada);
    const flame = (await listedEmber(ada)).avatarUrl;
    const pictured = (await uploadMoon(ada)).avatarUrl;
    await turnOff(ada);
    await turnOn(ada);
    const back = (await listedEmber(ada)).avatarUrl;
    const { assistant } = (await (await useTheFlame(ada)).json()) as AssistantChanged;

    const pictures = [flame, pictured, assistant.avatarUrl].map(avatarVersionOf);
    expect(pictures).toEqual([...pictures].sort((a, b) => a - b));
    expect(new Set(pictures).size).toBe(3);
    // The same picture, at the address it had or a later one.
    expect(avatarVersionOf(back)).toBeGreaterThanOrEqual(avatarVersionOf(pictured));
    expect(avatarVersionOf(back)).toBeLessThan(avatarVersionOf(assistant.avatarUrl));
    expect((await listedEmber(ada)).avatarUrl).toBe(assistant.avatarUrl);
    expect((await served(assistant.avatarUrl, ada)).headers.get("Content-Type")).toBe("image/svg+xml");
  });

  it("stays while Ember AI is off, as @ember's messages do, and can't be changed until it's on again", async () => {
    const ada = await setUp();
    await turnOn(ada);
    await uploadMoon(ada);
    const { avatar_key: key } = await storedAvatar();
    await turnOff(ada);

    const ember = await listedEmber(ada);
    expect(ember.status).toBe("deactivated");
    expect((await served(ember.avatarUrl, ada)).headers.get("Content-Type")).toBe("image/webp");
    const refused = await upload(ada);
    expect([refused.status, await refused.json()]).toEqual([409, { error: ASSISTANT_OFF }]);
    expect([(await useTheFlame(ada)).status, (await storedAvatar()).avatar_key]).toEqual([409, key]);
    // The picture the refused upload stored has its reservation, which runs out in an hour.
    expect(await pendingDeletions()).toHaveLength(1);

    await turnOn(ada);
    expect(await assistantSettings(ada)).toMatchObject({ avatarUrl: (await listedEmber(ada)).avatarUrl, avatar: true });
    expect((await storedAvatar()).avatar_key).toBe(key);
  });

  it("can't be uploaded before Ember AI is first turned on, when there's no @ember", async () => {
    const ada = await setUp();
    const refused = await upload(ada);
    expect([refused.status, await refused.json()]).toEqual([409, { error: ASSISTANT_OFF }]);
    expect((await useTheFlame(ada)).status).toBe(409);
    expect(await workspaceSql("SELECT id FROM users WHERE id = ?", ASSISTANT_ID)).toEqual([]);
  });

  it("is changed only by administrators, whose picture is read once that's known, into a bucket", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    await turnOn(ada);
    const unchanged = await storedAvatar();

    expect((await upload(null)).status).toBe(401);
    expect((await useTheFlame(null)).status).toBe(401);
    const forbidden = await upload(grace);
    expect([forbidden.status, await forbidden.json()]).toEqual([403, { error: ASSISTANT_FORBIDDEN }]);
    expect([(await useTheFlame(grace)).status]).toEqual([403]);
    const unbound = await upload(ada, moonForm(), { FILES: undefined });
    expect([unbound.status, await unbound.json()]).toEqual([503, { error: NO_STORAGE }]);
    expect(await storedAvatars()).toEqual([]);
    expect(await pendingDeletions()).toEqual([]);
    expect(await storedAvatar()).toEqual(unchanged);
  });

  it("refuses what isn't a picture with its variant, storing nothing", async () => {
    const ada = await setUp();
    await turnOn(ada);
    const unchanged = await storedAvatar();
    const refusal = async (form: FormData) => {
      const response = await upload(ada, form);
      return [response.status, ((await response.json()) as { error: string }).error];
    };
    const tooLarge = new FormData();
    tooLarge.append("avatar", new File([new Uint8Array(MAX_AVATAR_SIZE + 1)], "earth.png"));

    expect(await refusal(new FormData())).toEqual([400, "Choose a picture"]);
    expect(await refusal(tooLarge)).toEqual([413, AVATAR_TOO_LARGE]);
    expect(await storedAvatars()).toEqual([]);
    expect(await storedAvatar()).toEqual(unchanged);
  });
});
