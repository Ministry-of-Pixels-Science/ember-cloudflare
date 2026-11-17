import { TRANSFER_PATH, type LinkSignIn, type Me, type NewWorkspace, type PersonAnswer, type ProfileAnswer, type UserId } from "@ember/protocol";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenDigest } from "../src/auth";
import type { Env } from "../src/env";
import { newTransferId, TRANSFER_LINK_EXPIRY_MS, transferOf } from "../src/transfers";
import { api, apiWith, builtPages, cookieOf, freshDeploy, shown, signIn, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const SECRET = (env as unknown as Env).SESSION_SECRET;

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** The id of the session `session`'s cookie carries. */
async function sessionIdOf(session: Session): Promise<string> {
  const digest = await tokenDigest(session.cookie.slice(session.cookie.indexOf("=") + 1), SECRET);
  return ((await workspaceSql("SELECT id FROM sessions WHERE token_digest = ?", digest)) as [{ id: string }])[0].id;
}

/** The sign-in link `session`'s profile gives them. */
const yourTransferId = async (session: Session) => ((await (await api("/api/users/me/profile", { headers: as(session) })).json()) as ProfileAnswer).transferId;

/** What someone's page tells `viewer` about `userId`. */
const personAnswer = async (viewer: Session, userId: UserId) => (await (await api(`/api/users/${userId}`, { headers: as(viewer) })).json()) as PersonAnswer;

/** Signs in with `transferId`, as a sign-in link's page does. */
const signInWith = (transferId: string) => ({ method: "POST", body: JSON.stringify({ transferId } satisfies LinkSignIn) });

/** Opens the sign-in link `transferId` in a browser signed in with `session`, if any, as its page does. */
const transfer = (transferId: string, session?: Session | null, init: RequestInit = {}) =>
  api("/api/session/transfers", { ...signInWith(transferId), ...init, headers: { ...as(session), ...init.headers } });

/** The session opening the sign-in link `transferId` starts, signed in as whom it's for. */
async function transferred(transferId: string): Promise<Session> {
  const response = await transfer(transferId);
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** Who `cookie` signs in, or the status that says nobody. */
async function whoIs(cookie: string): Promise<Me | number> {
  const response = await api("/api/me", { headers: { Cookie: cookie } });
  return response.ok ? ((await response.json()) as { user: Me }).user : response.status;
}

/** Expects `response` to refuse, signing nobody in. */
async function expectRefused(response: Response, why: string) {
  expect(response.status, why).toBe(400);
  expect(await response.text(), why).toBe("");
  expect(response.headers.has("Set-Cookie"), why).toBe(false);
}

beforeEach(freshDeploy);
afterEach(() => vi.useRealTimers());

describe("Private sign-in link", () => {
  describe("its id", () => {
    const someone = { userId: "someone", sessionId: "0123456789abcdef", shownAt: 0 };

    it("names whom it signs in, the session that showed it and when, until it expires, 4 hours after it's shown", async () => {
      const transferId = await newTransferId(someone, SECRET);
      expect(transferId).toMatch(/^someone\.0123456789abcdef\.[0-9a-z]+\.[\w-]+$/);
      expect(await transferOf(transferId, SECRET, 0)).toEqual(someone);
      expect(await transferOf(transferId, SECRET, TRANSFER_LINK_EXPIRY_MS - 1)).toEqual(someone);
      expect(await transferOf(transferId, SECRET, TRANSFER_LINK_EXPIRY_MS)).toBeNull();
      const dotted = { ...someone, userId: "some.one" };
      expect(await transferOf(await newTransferId(dotted, SECRET), SECRET, 0)).toEqual(dotted);
    });

    it("names nobody once changed, or when another secret signed it", async () => {
      const [userId, sessionId, expiresAt, signature] = (await newTransferId(someone, SECRET)).split(".") as [string, string, string, string];
      const later = (TRANSFER_LINK_EXPIRY_MS * 2).toString(36);
      const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
      const changes = [
        `another.${sessionId}.${expiresAt}.${signature}`,
        `${userId}.another.${expiresAt}.${signature}`,
        `${userId}.${sessionId}.${later}.${signature}`,
        `${userId}.${sessionId}.${expiresAt}.${flipped}`,
        `${userId}.${sessionId}.${expiresAt}.`,
        // As links were before they named a session.
        `${userId}.${expiresAt}.${signature}`,
      ];
      for (const changed of changes) expect(await transferOf(changed, SECRET, 0), changed).toBeNull();
      expect(await transferOf(await newTransferId(someone, "another secret"), SECRET, 0)).toBeNull();
    });

    it("names nobody when it isn't one", async () => {
      for (const id of ["", "someone", "someone.0", "someone.session.0", ".", "...", "...signature", "someone...signature", "someone..0.signature", ".session.0.signature"]) {
        expect(await transferOf(id, SECRET, 0), id).toBeNull();
      }
    });
  });

  it("comes with your profile, whenever it loads or saves, shown by your session", async () => {
    const administrator = await setUp();
    const yours = { userId: administrator.user.id, sessionId: await sessionIdOf(administrator), shownAt: expect.any(Number) as number };
    expect(await transferOf(await yourTransferId(administrator), SECRET, Date.now())).toEqual(yours);

    const saved = (await (await api("/api/users/me/profile", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ bio: "Countess" }) })).json()) as ProfileAnswer;
    expect(await transferOf(saved.transferId, SECRET, Date.now())).toEqual(yours);
  });

  it("comes with the page of anyone active who isn't a bot, themselves included, for administrators only", async () => {
    const administrator = await setUp();
    const people = await Promise.all(["Grace Hopper", "Alan Turing", "Edsger Dijkstra", "Bender"].map((name) => signIn(name)));
    const [grace, banned, removed, bot] = people.map((person) => person.user.id) as [UserId, UserId, UserId, UserId];
    await workspaceSql("UPDATE users SET status = 2 WHERE id = ?", banned);
    await workspaceSql("UPDATE users SET status = 1 WHERE id = ?", removed);
    await workspaceSql("UPDATE users SET role = 2 WHERE id = ?", bot);

    const sessionId = await sessionIdOf(administrator);
    for (const userId of [grace, administrator.user.id]) {
      const { transferId } = await personAnswer(administrator, userId);
      expect(await transferOf(transferId!, SECRET, Date.now())).toEqual({ userId, sessionId, shownAt: expect.any(Number) });
    }
    for (const userId of [banned, removed, bot]) expect(await personAnswer(administrator, userId), userId).not.toHaveProperty("transferId");
    expect(await personAnswer(people[0]!, administrator.user.id)).not.toHaveProperty("transferId");
    expect(await personAnswer(people[0]!, grace)).not.toHaveProperty("transferId");
  });

  it("signs whoever opens it in as the person it's for, again and again, in sessions of their own", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    const transferId = await yourTransferId(grace);

    for (const browser of [null, administrator, grace]) {
      const response = await transfer(transferId, browser);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ user: { id: grace.user.id, name: "Grace Hopper", administrator: false } });
      expect(response.headers.get("Set-Cookie")).toMatch(/^__Host-session_token=[\w-]{43}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$/);
      const cookie = cookieOf(response);
      expect(cookie).not.toBe(grace.cookie);
      expect(await whoIs(cookie)).toMatchObject({ id: grace.user.id });
    }
    // The sessions the link replaced stay signed in.
    expect(await whoIs(administrator.cookie)).toMatchObject({ id: administrator.user.id });
    expect(await whoIs(grace.cookie)).toMatchObject({ id: grace.user.id });
    expect(await workspaceSql("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?", grace.user.id)).toEqual([{ count: 4 }]);
  });

  it("signs administrators in as administrators", async () => {
    const administrator = await setUp();
    const response = await transfer(await yourTransferId(administrator));
    expect(await response.json()).toEqual({ user: { id: administrator.user.id, name: "Ada Lovelace", administrator: true } });
  });

  it("answers 400 with nothing else for a link that's expired, changed or made up", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    const [, sessionId, expiresAt, signature] = (await yourTransferId(grace)).split(".") as [string, string, string, string];
    const graces = { userId: grace.user.id, sessionId, shownAt: Date.now() };

    const refused = {
      expired: await newTransferId({ ...graces, shownAt: graces.shownAt - TRANSFER_LINK_EXPIRY_MS - 1 }, SECRET),
      "for someone else": `${administrator.user.id}.${sessionId}.${expiresAt}.${signature}`,
      "signed with another secret": await newTransferId(graces, "another secret"),
      "for nobody": await newTransferId({ ...graces, userId: "nobody" }, SECRET),
      "shown by no session": await newTransferId({ ...graces, sessionId: "nosession" }, SECRET),
      "made up": "nonsense",
    };
    for (const [why, transferId] of Object.entries(refused)) await expectRefused(await transfer(transferId, administrator), why);
    expect(await whoIs(administrator.cookie)).toMatchObject({ id: administrator.user.id });
  });

  it("answers 400 with nothing else when what's sent holds no link", async () => {
    await setUp();
    for (const body of [undefined, "", "{", "null", "1", '"nonsense"', "[]", "{}", '{"transferId":null}', '{"transferId":1}']) {
      await expectRefused(await api("/api/session/transfers", { method: "POST", body }), String(body));
    }
  });

  it("answers 400 once the person it's for is banned or removed", async () => {
    await setUp();
    const grace = await signIn("Grace Hopper");
    const transferId = await yourTransferId(grace);

    for (const status of [2, 1]) {
      await workspaceSql("UPDATE users SET status = ? WHERE id = ?", status, grace.user.id);
      await expectRefused(await transfer(transferId), `status ${status}`);
    }
    await workspaceSql("UPDATE users SET status = 0 WHERE id = ?", grace.user.id);
    expect((await transfer(transferId)).status).toBe(201);
  });

  it("answers 400 once the session that showed it has signed out, though the links their other sessions showed still work", async () => {
    await setUp();
    const laptop = await signIn("Grace Hopper");
    const laptops = await yourTransferId(laptop);
    const phone = await transferred(laptops);
    const phones = await yourTransferId(phone);

    expect((await api("/api/session", { method: "DELETE", headers: as(laptop) })).status).toBe(204);
    await expectRefused(await transfer(laptops), "signed out");
    expect((await transfer(phones)).status).toBe(201);
  });

  it("answers 400 for every link someone's sessions showed once their password is reset, their own and others'", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    const theirs = [await yourTransferId(administrator), (await personAnswer(administrator, grace.user.id)).transferId!];
    const graces = await yourTransferId(grace);
    const later = await yourTransferId(await transferred(theirs[0]!));

    expect(await workspaceStub().resetPassword(ada.emailAddress, "digest")).toBe("reset");
    for (const [i, transferId] of [...theirs, later].entries()) await expectRefused(await transfer(transferId), `link ${i}`);
    // Grace's own link was shown by her session, which goes on.
    expect((await transfer(graces)).status).toBe(201);
  });

  it("answers 400 for every link a session showed before it gave its person a new password, though those it shows from then on work", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    const links = async () => [await yourTransferId(administrator), (await personAnswer(administrator, grace.user.id)).transferId!];
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const before = await links();
    const opened = await transferred(before[0]!);

    // A millisecond later.
    vi.setSystemTime(Date.now() + 1);
    const changes = { password: "difference engine", currentPassword: ada.password };
    const saved = await api("/api/users/me/profile", { method: "PATCH", headers: as(administrator), body: JSON.stringify(changes) });
    expect(saved.status).toBe(200);
    // The session one of them started ends with her other sessions, and none starts another.
    expect(await whoIs(opened.cookie)).toBe(401);
    for (const [i, transferId] of before.entries()) await expectRefused(await transfer(transferId), `link ${i}`);
    for (const transferId of [((await saved.json()) as ProfileAnswer).transferId, ...(await links())]) expect((await transfer(transferId)).status).toBe(201);
    expect(await whoIs(administrator.cookie)).toMatchObject({ id: administrator.user.id });
  });

  it("answers 400 for a link an administrator showed of someone else once they're no longer an active administrator, though their own still works", async () => {
    await setUp();
    const [bob, grace] = [await signIn("Bob"), await signIn("Grace Hopper")];
    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", bob.user.id);
    const graces = (await personAnswer(bob, grace.user.id)).transferId!;
    const bobs = await yourTransferId(bob);
    expect((await transfer(graces)).status).toBe(201);

    await workspaceSql("UPDATE users SET role = 0 WHERE id = ?", bob.user.id);
    await expectRefused(await transfer(graces), "a member");
    expect((await transfer(bobs)).status).toBe(201);

    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", bob.user.id);
    for (const status of [2, 1]) {
      await workspaceSql("UPDATE users SET status = ? WHERE id = ?", status, bob.user.id);
      await expectRefused(await transfer(graces), `status ${status}`);
    }
  });

  it("answers 400 for someone who signed in with just a name, while EMBER_GUEST_SIGN_IN doesn't allow it", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    const post = async (session: Session) => apiWith({ EMBER_GUEST_SIGN_IN: undefined }, "/api/session/transfers", signInWith(await yourTransferId(session)));

    await expectRefused(await post(grace), "guest");
    expect((await post(administrator)).status).toBe(201);
  });

  it("answers 400 for a link an administrator who signed in with just a name showed, while EMBER_GUEST_SIGN_IN doesn't allow it", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    // Making her an administrator leaves her a guest.
    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", grace.user.id);
    const adas = (await personAnswer(grace, administrator.user.id)).transferId!;

    await expectRefused(await apiWith({ EMBER_GUEST_SIGN_IN: undefined }, "/api/session/transfers", signInWith(adas)), "shown by a guest");
    expect((await transfer(adas)).status).toBe(201);
  });

  it("refuses to sign in from other sites", async () => {
    const grace = await signIn("Grace Hopper");
    const response = await transfer(await yourTransferId(grace), null, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(response.status).toBe(422);
    expect(response.headers.has("Set-Cookie")).toBe(false);
  });

  it("is the app's page, signed in or out, with the link's id in its fragment, which browsers don't send", async () => {
    const administrator = await setUp();
    const transferId = await yourTransferId(administrator);
    const page = (path: string, { method, session }: { method?: string; session?: Session } = {}) =>
      apiWith({ ASSETS: builtPages }, path, { method, headers: as(session), redirect: "manual" });

    for (const session of [undefined, administrator]) {
      const response = await page(TRANSFER_PATH, { session });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("page /");
    }
    // The addresses, with the id in the path, are no page or route here, so no request holds the id: the
    // built app answers Campfire's 404 page for the page's.
    const path = `${TRANSFER_PATH}/${transferId}`;
    expect(await (await page(path)).text()).toBe(`page ${path}`);
    expect((await api(`/api/session/transfers/${transferId}`, { method: "PUT" })).status).toBe(404);
    // Campfire's page signs in with a PUT to itself, which this one sends to the API.
    expect((await page(TRANSFER_PATH, { method: "PUT" })).status).toBe(404);
  });
});
