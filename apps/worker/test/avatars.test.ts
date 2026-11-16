import { ASSISTANT_ID, avatarSvg, type Directory, type DirectoryUser, type UserId } from "@ember/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { avatarTokenUser, directoryOf } from "../src/avatar-tokens";
import { DEFAULT_BOT_AVATAR } from "../src/default-bot-avatar";
import { VERSION } from "../src/version";
import { api, freshDeploy, origin, signIn, workspaceSql, type Session } from "./support";

const CACHE_CONTROL = "max-age=1800, public, stale-while-revalidate=604800";

const directory = (session: Session | null, headers: Record<string, string> = {}) =>
  api("/api/users", { headers: { ...(session ? { Cookie: session.cookie } : {}), ...headers } });

/** Someone as the directory lists them, as `viewer` sees it. */
async function listed(viewer: Session, userId: UserId): Promise<DirectoryUser> {
  const { users } = (await (await directory(viewer)).json()) as Directory;
  return users.find((user) => user.id === userId)!;
}

/** Fetches an avatar, signed in as `viewer` if given. */
const avatar = (path: string, viewer: Session | null, init: RequestInit = {}) =>
  api(path, { redirect: "manual", ...init, headers: { ...(viewer ? { Cookie: viewer.cookie } : {}), ...init.headers } });

/** The address of an avatar whose token names `userId`, who needn't exist. */
const avatarPathFor = async (userId: UserId, secret = "test-secret") =>
  (await directoryOf([{ id: userId, name: "Nobody", username: null, bio: null, role: "member", status: "active", updatedAt: "2026-10-14T12:00:00.000Z", agent: false, keptFor: null }], secret))[0]!.avatarUrl;

const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, "0")).join("");

beforeEach(freshDeploy);

describe("Initials avatars", () => {
  it("serves someone's initials at the address the directory gives, to people signed in", async () => {
    const ada = await signIn("Ada Lovelace");
    const { avatarUrl } = await listed(ada, ada.user.id);
    expect(avatarUrl).toMatch(new RegExp(`^/users/${ada.user.id}\\.[\\w-]{22}/avatar\\?v=\\d{14}$`));

    const response = await avatar(avatarUrl, ada);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
    expect(response.headers.get("ETag")).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(await response.text()).toBe(avatarSvg(ada.user.id, "Ada Lovelace"));
  });

  it("dates the address to the second someone last changed", async () => {
    const ada = await signIn("Ada Lovelace");
    await workspaceSql("UPDATE users SET updated_at = ? WHERE id = ?", "2026-10-14T21:24:45.804Z", ada.user.id);
    expect((await listed(ada, ada.user.id)).avatarUrl).toMatch(/\/avatar\?v=20261014212445$/);
  });

  it("answers 304 when the browser's copy is current, saying how long to keep it", async () => {
    const ada = await signIn("Ada Lovelace");
    const { avatarUrl } = await listed(ada, ada.user.id);
    const etag = (await avatar(avatarUrl, ada)).headers.get("ETag")!;

    const response = await avatar(avatarUrl, ada, { headers: { "If-None-Match": etag } });
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
    expect(await response.text()).toBe("");
  });

  it("answers HEAD with the headers alone", async () => {
    const ada = await signIn("Ada Lovelace");
    const response = await avatar((await listed(ada, ada.user.id)).avatarUrl, ada, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(await response.text()).toBe("");
  });

  it("sends people who aren't signed in to sign in, before looking at the token", async () => {
    const ada = await signIn("Ada Lovelace");
    const { avatarUrl } = await listed(ada, ada.user.id);
    // A session token nobody has, in the cookie that would carry one.
    const signedOut = { user: ada.user, cookie: `${ada.cookie.split("=")[0]}=${"A".repeat(43)}` };
    for (const [path, viewer] of [
      [avatarUrl, null],
      [avatarUrl, signedOut],
      ["/users/forged.AAAAAAAAAAAAAAAAAAAAAA/avatar", null],
      ["/users/forged.AAAAAAAAAAAAAAAAAAAAAA/avatar", signedOut],
    ] as const) {
      const response = await avatar(path, viewer);
      expect(response.status, path).toBe(302);
      expect(response.headers.get("Location")).toBe(`${origin}/session/new`);
    }
  });

  it("answers an empty 404 for a token it didn't sign, or for nobody", async () => {
    const ada = await signIn("Ada Lovelace");
    const { avatarUrl } = await listed(ada, ada.user.id);
    const [, token] = avatarUrl.match(/^\/users\/([^/]+)\/avatar/)!;
    const forged = token!.slice(0, -1) + (token!.endsWith("A") ? "B" : "A");
    for (const path of [`/users/${forged}/avatar`, `/users/${ada.user.id}/avatar`, "/users/%E0%A4%A/avatar", await avatarPathFor("nobody")]) {
      const response = await avatar(path, ada);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe("");
    }
  });

  it("keeps tokens to the secret that signed them", async () => {
    const path = await avatarPathFor("someone");
    const token = decodeURIComponent(path.split("/")[2]!);
    expect(await avatarTokenUser(token, "test-secret")).toBe("someone");
    expect(await avatarTokenUser(token, "another secret")).toBeNull();
    expect(await avatarTokenUser("someone", "test-secret")).toBeNull();

    const other = await avatarPathFor("someone", "another secret");
    expect(other).not.toBe(path);
    expect(await avatarTokenUser(decodeURIComponent(other.split("/")[2]!), "another secret")).toBe("someone");
    expect(await avatarPathFor("someone")).toBe(path);
  });

  it("serves removed and banned people's avatars too", async () => {
    const [ada, grace, katherine] = [await signIn("Ada Lovelace"), await signIn("Grace Hopper"), await signIn("Katherine Johnson")];
    await workspaceSql("UPDATE users SET status = 1 WHERE id = ?", grace.user.id);
    await workspaceSql("UPDATE users SET status = 2 WHERE id = ?", katherine.user.id);
    for (const { user } of [grace, katherine]) {
      const response = await avatar((await listed(ada, user.id)).avatarUrl, ada);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(avatarSvg(user.id, user.name));
    }
  });

  it("gives bots Campfire's bot picture", async () => {
    const ada = await signIn("Ada Lovelace");
    const now = new Date().toISOString();
    await workspaceSql("INSERT INTO users (id, name, role, created_at, updated_at) VALUES ('robot', 'Build Bot', 2, ?, ?)", now, now);
    const bot = await listed(ada, "robot");
    expect(bot.role).toBe("bot");

    const response = await avatar(bot.avatarUrl, ada);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Content-Disposition")).toBe(`inline; filename="default-bot-avatar.svg"; filename*=UTF-8''default-bot-avatar.svg`);
    expect(response.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
    expect(await response.text()).toBe(DEFAULT_BOT_AVATAR);
    // app/assets/images/default-bot-avatar.svg, byte for byte.
    expect(await sha256(DEFAULT_BOT_AVATAR)).toBe("aefe43e21cd8423e5b29ee6e3088db788090bc715f52863eaddc0efdb92c9062");
  });

  it("names the release in @ember's address too, since its picture comes with Ember", async () => {
    const ada = await signIn("Ada Lovelace");
    const changed = "2026-10-14T21:24:45.804Z";
    await workspaceSql("INSERT INTO users (id, name, role, created_at, updated_at) VALUES (?, 'Ember', 2, ?, ?)", ASSISTANT_ID, changed, changed);
    const address = new URL((await listed(ada, ASSISTANT_ID)).avatarUrl, origin);
    expect(address.pathname).toMatch(new RegExp(`^/users/${ASSISTANT_ID}\\.[\\w-]{22}/avatar$`));
    expect([...address.searchParams]).toEqual([
      ["v", "20261014212445"],
      ["release", VERSION],
    ]);
  });

  it("answers anything but GET and HEAD with the 404 page", async () => {
    const ada = await signIn("Ada Lovelace");
    const response = await avatar((await listed(ada, ada.user.id)).avatarUrl, ada, { method: "DELETE" });
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
  });

  it("lists everyone in the directory, whatever their status, with what they say about themselves", async () => {
    const [ada, grace] = [await signIn("Ada Lovelace"), await signIn("Grace Hopper")];
    await workspaceSql("UPDATE users SET status = 1, bio = 'Wrote the first compiler' WHERE id = ?", grace.user.id);
    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", ada.user.id);

    const response = await directory(ada);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { users } = (await response.json()) as Directory;
    expect(users).toHaveLength(2);
    expect(users).toEqual(
      expect.arrayContaining([
        { id: ada.user.id, name: "Ada Lovelace", bio: null, role: "administrator", status: "active", avatarUrl: expect.stringMatching(/^\/users\//) },
        { id: grace.user.id, name: "Grace Hopper", bio: "Wrote the first compiler", role: "member", status: "deactivated", avatarUrl: expect.stringMatching(/^\/users\//) },
      ]),
    );
  });

  it("answers the directory 304 when the app's copy is current, and 401 to anyone signed out", async () => {
    const ada = await signIn("Ada Lovelace");
    const etag = (await directory(ada)).headers.get("ETag")!;
    expect((await directory(ada, { "If-None-Match": etag })).status).toBe(304);
    await signIn("Grace Hopper");
    expect((await directory(ada, { "If-None-Match": etag })).status).toBe(200);
    expect((await directory(null)).status).toBe(401);
  });
});
