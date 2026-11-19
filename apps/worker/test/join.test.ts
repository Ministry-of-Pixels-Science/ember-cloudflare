import {
  EMAIL_ADDRESS_TOO_LONG,
  MAX_EMAIL_ADDRESS_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_USER_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  NAME_TOO_LONG,
  PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT,
  type Bootstrap,
  type Directory,
  type NewWorkspace,
  type Sidebar,
  type User,
} from "@ember/protocol";
import { evictDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/passwords";
import { ORIGINAL_ROOM } from "../src/workspace-store";
import {
  api,
  apiWith,
  builtPages,
  cookieOf,
  createRoom,
  deactivatedPerson,
  freshDeploy,
  openWorkspaceSocket,
  origin,
  shown,
  signIn,
  workspaceSql,
  workspaceStub,
  type Session,
} from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler" };

/** Sets Ember up with Ada as its administrator, signed in, answering general, its first room, too. */
async function setUp(): Promise<Session & { general: NewWorkspace["room"] }> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  const { user, room } = (await response.json()) as NewWorkspace;
  return { user, cookie: cookieOf(response), general: room };
}

const joinCode = async () => ((await workspaceSql("SELECT join_code FROM accounts")) as Array<{ join_code: string }>)[0]!.join_code;

/** Posts the join form for `code`, from a browser with `cookie` if given. */
const join = (code: string, form: unknown, { cookie, headers = {} }: { cookie?: string; headers?: Record<string, string> } = {}) =>
  api(`/api/join/${code}`, {
    method: "POST",
    headers: { "User-Agent": "Grace's laptop", "CF-Connecting-IP": "203.0.113.9", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: JSON.stringify(form),
  });

/** The join link's page as the browser asks for it, with the built app standing in. */
const page = (path: string, init: RequestInit<IncomingRequestCfProperties> = {}) => apiWith({ ASSETS: builtPages }, path, { redirect: "manual", ...init });

const roomList = async (cookie: string) => (await (await api("/api/sidebar", { headers: { Cookie: cookie } })).json()) as Sidebar;

const count = async (table: string) => ((await workspaceSql(`SELECT count(*) AS n FROM ${table}`)) as Array<{ n: number }>)[0]!.n;

beforeEach(freshDeploy);

describe("Sign up with the join link", () => {
  it("serves the join page, which is the app's own, for the current code", async () => {
    await setUp();
    const response = await page(`/join/${await joinCode()}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("page /");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("tells everyone's workspace sockets of someone who joins, as the people directory lists them, so pages already open know them", async () => {
    const administrator = await setUp();
    const workspace = await openWorkspaceSocket(administrator);

    const { user } = (await (await join(await joinCode(), grace)).json()) as { user: User };
    const { users } = (await (await api("/api/users", { headers: { Cookie: administrator.cookie } })).json()) as Directory;
    const listed = users.find((person) => person.id === user.id);
    expect(listed).toMatchObject({ name: "Grace Hopper", role: "member", status: "active" });
    expect(await workspace.next()).toEqual({ type: "user.updated", user: listed });
  });

  it("adds a member in every open room, but no closed one, and signs them in", async () => {
    const administrator = await setUp();
    const [design, leads] = [await createRoom("Design", { as: administrator }), await createRoom("Leads", { as: administrator, closedTo: [administrator.user.id] })];

    const response = await join(await joinCode(), grace);
    expect(response.status).toBe(201);
    const { user } = (await response.json()) as { user: User };
    expect(user).toEqual({ id: expect.any(String), name: "Grace Hopper", administrator: false });
    expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^__Host-session_token=[\w-]{43}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$/)]);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const [member] = (await workspaceSql("SELECT name, email_address, password_digest, role, status, guest FROM users WHERE id = ?", user.id)) as Array<Record<string, unknown>>;
    expect(member).toMatchObject({ name: "Grace Hopper", email_address: "grace@example.com", role: 0, status: 0, guest: 0 });
    expect(await verifyPassword(grace.password, member!.password_digest as string)).toBe(true);
    expect(await workspaceSql("SELECT ip_address, user_agent FROM sessions WHERE user_id = ?", user.id)).toEqual([{ ip_address: "203.0.113.9", user_agent: "Grace's laptop" }]);

    const cookie = cookieOf(response);
    expect(await (await api("/api/me", { headers: { Cookie: cookie } })).json()).toEqual({ user });
    // The DM that welcomes them comes after the rooms (see "Welcome someone who joins").
    const rooms = (await roomList(cookie)).rooms.filter((room) => room.kind !== "direct");
    expect(rooms.map((room) => room.name)).toEqual(["general", "random", "Design"]);
    expect(rooms[0]!.id).toBe(administrator.general.id);
    expect(rooms[2]!.id).toBe(design.id);
    expect(rooms.map((room) => room.id)).not.toContain(leads.id);

    // And can sign in again with the password they chose.
    const signIn = await api("/api/session", { method: "POST", body: JSON.stringify({ emailAddress: grace.emailAddress, password: grace.password }) });
    expect(signIn.status).toBe(201);
    expect(await signIn.json()).toEqual({ user });
  });

  it("sends someone whose email address has an account to sign in with it, creating nothing", async () => {
    await setUp();
    const response = await join(await joinCode(), { ...grace, emailAddress: ada.emailAddress });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "That email address has an account already", redirect: "/session/new?email_address=ada%40example.com" });
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await count("users")).toBe(1);
    expect(await count("sessions")).toBe(1);
  });

  it("makes one account however many people join with one address at once", async () => {
    await setUp();
    const code = await joinCode();
    const responses = await Promise.all(["Grace", "Katherine", "Dorothy"].map((name) => join(code, { ...grace, name })));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409]);
    expect(await workspaceSql("SELECT count(*) AS n FROM users WHERE email_address = ?", grace.emailAddress)).toEqual([{ n: 1 }]);
    expect(await count("sessions")).toBe(2);
  });

  it("answers 404 for any other code, and for every code before Ember is set up", async () => {
    for (const code of ["AAAA-BBBB-CCCC", "nothing"]) {
      expect((await page(`/join/${code}`)).status, code).toBe(404);
      expect((await join(code, grace)).status, code).toBe(404);
    }
    await setUp();
    const code = await joinCode();
    const otherCase = code.replace(/[a-z]/gi, (letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()));
    for (const other of ["AAAA-BBBB-CCCC", otherCase, code.slice(0, -1), `${code}x`, `${code}.json`]) {
      const response = await page(`/join/${other}`);
      expect(response.status, other).toBe(404);
      expect(await response.text(), other).toBe("");
      expect((await join(other, grace)).status, other).toBe(404);
    }
    expect(await count("users")).toBe(1);
  });

  it("sends someone signed in home, whatever the code", async () => {
    const { cookie } = await setUp();
    for (const code of [await joinCode(), "AAAA-BBBB-CCCC"]) {
      const response = await page(`/join/${code}`, { headers: { Cookie: cookie } });
      expect(response.status, code).toBe(302);
      expect(response.headers.get("Location"), code).toBe(`${origin}/`);

      const joined = await join(code, grace, { cookie });
      expect(joined.status, code).toBe(409);
      expect(await joined.json(), code).toEqual({ error: "You're signed in already", redirect: "/" });
    }
    expect(await count("users")).toBe(1);
  });

  it("takes a password as short as first run does, counting an emoji as one character, or as long as the form sends", async () => {
    await setUp();
    expect((await join(await joinCode(), { ...grace, password: "x".repeat(MIN_PASSWORD_LENGTH) })).status).toBe(201);
    expect((await join(await joinCode(), { ...grace, emailAddress: "katherine@example.com", password: "🔐".repeat(MIN_PASSWORD_LENGTH) })).status).toBe(201);
    expect((await join(await joinCode(), { ...grace, emailAddress: "mary@example.com", password: "x".repeat(MAX_PASSWORD_LENGTH) })).status).toBe(201);
  });

  it.each([
    ["a blank password", { ...grace, password: "" }, 422, { error: PASSWORD_TOO_SHORT, field: "password" }],
    ["a password shorter than first run takes", { ...grace, password: "1234567" }, 422, { error: PASSWORD_TOO_SHORT, field: "password" }],
    ["four emoji, which the field's minlength counts as eight", { ...grace, password: "🔐🔐🔐🔐" }, 422, { error: PASSWORD_TOO_SHORT, field: "password" }],
    ["a password longer than the form sends", { ...grace, password: "x".repeat(MAX_PASSWORD_LENGTH + 1) }, 422, { error: PASSWORD_TOO_LONG, field: "password" }],
    ["a name longer than Ember keeps", { ...grace, name: "x".repeat(MAX_USER_NAME_LENGTH + 1) }, 422, { error: NAME_TOO_LONG, field: "name" }],
    ["an email address longer than any deliverable one", { ...grace, emailAddress: `${"x".repeat(MAX_EMAIL_ADDRESS_LENGTH - 11)}@example.com` }, 422, { error: EMAIL_ADDRESS_TOO_LONG, field: "emailAddress" }],
    ["a blank name", { ...grace, name: " " }, 400, { error: "Name, email address and password are required" }],
    ["no email address", { ...grace, emailAddress: undefined }, 400, { error: "Name, email address and password are required" }],
    ["no body", null, 400, { error: "Expected a JSON object" }],
  ])("refuses %s and creates nothing", async (_, form, status, body) => {
    await setUp();
    const response = await join(await joinCode(), form);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await count("users")).toBe(1);
  });

  it("refuses a post from another site", async () => {
    await setUp();
    expect((await join(await joinCode(), grace, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(422);
    expect(await count("users")).toBe(1);
  });

  it("never tells anyone signed out the join code", async () => {
    await setUp();
    const code = await joinCode();
    expect(JSON.stringify(await ((await api("/api/bootstrap")).json() as Promise<Bootstrap>))).not.toContain(code);
    expect((await api("/api/sidebar")).status).toBe(401);
  });
});

describe("Welcome someone who joins", () => {
  /** The DMs a sidebar lists. */
  const directsIn = ({ rooms }: Sidebar) => rooms.filter((room) => room.kind === "direct");

  it("starts a DM between someone who joins and each person here, which says they joined, telling each of their tabs at once", async () => {
    const administrator = await setUp();
    const [laptop, phone] = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(administrator)];

    const response = await join(await joinCode(), grace);
    const { user } = (await response.json()) as { user: User };
    const [welcome] = directsIn(await roomList(administrator.cookie));
    const members = [shown(administrator.user), shown(user)].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(welcome).toEqual({ id: expect.any(String), kind: "direct", members, activeAt: expect.any(String), joined: { userId: user.id, at: welcome!.activeAt }, unread: false, involvement: "everything" });
    const { unread: _, involvement: __, ...room } = welcome!;
    for (const tab of [laptop, phone]) {
      expect(await tab.next()).toMatchObject({ type: "user.updated", user: { id: user.id } });
      expect(await tab.next()).toEqual({ type: "room.saved", room });
    }
    // Their own sidebar lists it too, as the app leaves it out until someone writes in it.
    expect(directsIn(await roomList(cookieOf(response)))).toEqual([welcome]);

    // Someone who joins next is welcomed by both of them.
    const katherine = (await ((await join(await joinCode(), { ...grace, name: "Katherine Johnson", emailAddress: "katherine@example.com" })).json())) as { user: User };
    const welcomed = await workspaceSql("SELECT direct_key FROM rooms WHERE newcomer_id = ? ORDER BY direct_key", katherine.user.id);
    expect(welcomed).toEqual([administrator.user.id, user.id].map((id) => ({ direct_key: JSON.stringify([id, katherine.user.id].sort()) })).sort((a, b) => (a.direct_key < b.direct_key ? -1 : 1)));
    expect(directsIn(await roomList(administrator.cookie))).toHaveLength(2);
  });

  it("welcomes them to nobody but the active people here: no bot, guest or anyone gone, and a guest is welcomed by nobody", async () => {
    const administrator = await setUp();
    await signIn("Guest");
    await deactivatedPerson("Former");
    await workspaceSql("INSERT INTO users (id, name, role, created_at, updated_at) VALUES ('build-bot', 'Build Bot', 2, 'now', 'now')");
    expect(await count("rooms WHERE kind = 'direct'")).toBe(0);

    const { user } = (await (await join(await joinCode(), grace)).json()) as { user: User };
    expect(await workspaceSql("SELECT direct_key, creator_id, newcomer_id FROM rooms WHERE kind = 'direct'")).toEqual([
      { direct_key: JSON.stringify([administrator.user.id, user.id].sort()), creator_id: user.id, newcomer_id: user.id },
    ]);
  });

  it("starts them all in the batch that adds the member, binding one list however many people are here", async () => {
    const administrator = await setUp();
    // As many people as a statement can bind values, and then some.
    const ids = Array.from({ length: 150 }, (_, n) => `member-${String(n).padStart(3, "0")}`);
    await workspaceSql("INSERT INTO users (id, name, created_at, updated_at) SELECT value, value, 'now', 'now' FROM json_each(?)", JSON.stringify(ids));

    const { user } = (await (await join(await joinCode(), grace)).json()) as { user: User };
    expect(await count("rooms WHERE kind = 'direct'")).toBe(151);
    expect(await count(`memberships JOIN rooms ON rooms.id = memberships.room_id WHERE rooms.newcomer_id = '${user.id}'`)).toBe(302);
    expect(directsIn(await roomList(administrator.cookie))).toHaveLength(1);
  });
});

describe("Join link", () => {
  it("keeps the code first run made", async () => {
    await setUp();
    const code = await joinCode();
    // A Workspace that starts afresh reads it again.
    await evictDurableObject(workspaceStub());
    expect((await join(code, grace)).status).toBe(201);
    expect(await joinCode()).toBe(code);
  });
});

describe("Regenerate the join link", () => {
  it("joins with the new code once it's regenerated, and answers the old one with an empty 404", async () => {
    const { cookie } = await setUp();
    const old = await joinCode();
    const response = await api("/api/account/join_code", { method: "POST", headers: { Cookie: cookie } });
    const code = ((await response.json()) as { joinCode: string }).joinCode;

    const page404 = await page(`/join/${old}`);
    expect(page404.status).toBe(404);
    expect(await page404.text()).toBe("");
    expect((await join(old, grace)).status).toBe(404);
    expect(await count("users")).toBe(1);

    expect((await page(`/join/${code}`)).status).toBe(200);
    expect((await join(code, grace)).status).toBe(201);
  });

  it("refuses a join whose form arrives after the code it was sent to is regenerated", async () => {
    const { cookie } = await setUp();
    const old = await joinCode();
    // Someone with a link that's about to be replaced holds their form back until it has been.
    const form = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          expect((await api("/api/account/join_code", { method: "POST", headers: { Cookie: cookie } })).status).toBe(200);
          controller.enqueue(new TextEncoder().encode(JSON.stringify(grace)));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await apiWith({}, `/api/join/${old}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9" }, body: form });
    expect(response.status).toBe(404);
    expect(await count("users")).toBe(1);
  });
});

describe("Welcome and invite card", () => {
  it("gives administrators in the workspace's first room its invitation, with the join code", async () => {
    const administrator = await setUp();
    const code = await joinCode();
    await createRoom("Design", { as: administrator });
    expect((await roomList(administrator.cookie)).invitation).toEqual({ roomId: administrator.general.id, joinCode: code });
    expect((await api("/api/sidebar", { headers: { Cookie: administrator.cookie } })).headers.get("Cache-Control")).toBe("no-store");
  });

  it("gives nobody else the invitation", async () => {
    const administrator = await setUp();
    const guest = await signIn("Katherine");
    const promoted = await api(`/api/account/users/${guest.user.id}`, { method: "PATCH", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ role: "administrator" }) });
    expect(promoted.status).toBe(200);
    await workspaceSql("DELETE FROM memberships WHERE user_id = ?", guest.user.id);
    expect((await roomList(guest.cookie)).invitation).toBeNull();
    expect((await roomList(administrator.cookie)).invitation).not.toBeNull();
  });

  it("has none before Ember is set up", async () => {
    const guest = await signIn("Katherine");
    await createRoom("Design", { as: guest });
    expect((await roomList(guest.cookie)).invitation).toBeNull();
  });

  it("is the oldest room, of any kind, counting rooms from before the Workspace kept a list from when they were listed", async () => {
    await workspaceStub().registerLegacyRooms(["lobby"]);
    // Apart from the rooms made around it by a moment, so it's never made at the same time as one.
    await scheduler.wait(2);
    const administrator = await setUp();
    await scheduler.wait(2);
    await workspaceStub().registerLegacyRooms(["watercooler"]);
    expect((await roomList(administrator.cookie)).invitation?.roomId).toBe("lobby");
  });

  it("finds the first room through an index, however many rooms there are", async () => {
    const plan = (await workspaceSql(`EXPLAIN QUERY PLAN ${ORIGINAL_ROOM}`)).map((row) => (row as { detail: string }).detail).join("; ");
    expect(plan).toMatch(/USING COVERING INDEX index_rooms_on_created_at_and_id/);
    expect(plan).not.toContain("TEMP B-TREE");
  });
});
