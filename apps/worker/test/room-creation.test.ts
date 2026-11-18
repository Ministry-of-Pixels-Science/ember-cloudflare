import type { Account, Bootstrap, NewWorkspace, Sidebar, UserId, WorkspaceServerFrame } from "@ember/protocol";
import { evictDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { api, cookieOf, createRoom, freshDeploy, openWorkspaceSocket, shown, signIn, startDirect, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Turns "Must be admin to create new rooms" on or off, as `session`, as its switch on workspace settings does. */
const restrict = (session: Session, restrictRoomCreation: unknown) =>
  api("/api/account", { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify({ settings: { restrictRoomCreation } }) });

/** The New room forms' list, as `session` asks for it. */
const newRoomForm = (session: Session) => api("/api/rooms/new", { headers: { Cookie: session.cookie } });

/** Asks to create `room` as `session`, as New room's forms do. */
const create = (session: Session, room: unknown) =>
  api("/api/rooms", { method: "POST", headers: { Cookie: session.cookie }, body: typeof room === "string" ? room : JSON.stringify(room) });

const changeRole = (session: Session, userId: UserId, role: string) =>
  api(`/api/account/users/${userId}`, { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify({ role }) });

const bootstrap = async (session?: Session) => (await (await api("/api/bootstrap", { headers: session ? { Cookie: session.cookie } : {} })).json()) as Bootstrap;

const storedSettings = async () => JSON.parse(((await workspaceSql("SELECT settings FROM accounts")) as Array<{ settings: string }>)[0]!.settings) as unknown;

/** The names of the rooms in `session`'s sidebar. */
const roomNames = async (session: Session) =>
  ((await (await api("/api/sidebar", { headers: { Cookie: session.cookie } })).json()) as Sidebar).rooms.map((room) => (room.kind === "direct" ? "a DM" : room.name));

/** The 403 someone gets for a room they may not create. */
const FORBIDDEN = { error: "Only administrators can create rooms" };

beforeEach(freshDeploy);

describe("Only administrators create rooms (setting)", () => {
  it("lets anyone create rooms until an administrator turns it on, before first run too", async () => {
    expect((await bootstrap()).account.restrictRoomCreation).toBe(false);
    await setUp();
    const grace = await signIn("Grace");

    expect((await bootstrap(grace)).account.restrictRoomCreation).toBe(false);
    expect((await newRoomForm(grace)).status).toBe(200);
    expect((await create(grace, { kind: "open", name: "Design" })).status).toBe(201);
  });

  it("turns on and off for everyone as an administrator switches it, keeping the other settings", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace)];
    const restricted: Account = { name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: true, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true };

    const response = await restrict(administrator, true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: restricted });
    expect(await storedSettings()).toEqual({ restrict_room_creation_to_administrators: true });
    expect((await bootstrap(grace)).account).toEqual(restricted);
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "account.updated", account: restricted } satisfies WorkspaceServerFrame);

    expect(await (await restrict(administrator, false)).json()).toEqual({ account: { ...restricted, restrictRoomCreation: false } });
    expect(await storedSettings()).toEqual({ restrict_room_creation_to_administrators: false });
    expect((await newRoomForm(grace)).status).toBe(200);
  });

  it("refuses members New room's forms and creating open or private rooms while it's on, but not DMs", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    await restrict(administrator, true);

    const form = await newRoomForm(grace);
    expect(form.status).toBe(403);
    expect(await form.json()).toEqual(FORBIDDEN);
    for (const room of [{ kind: "open", name: "Design" }, { kind: "closed", name: "Secret", memberIds: [grace.user.id] }]) {
      const response = await create(grace, room);
      expect(response.status, room.kind).toBe(403);
      expect(await response.json()).toEqual(FORBIDDEN);
    }
    expect(await roomNames(grace)).toEqual(["general", "random"]);

    expect((await startDirect(grace, [administrator.user.id])).status).toBe(201);
    expect(await roomNames(grace)).toEqual(["general", "random", "a DM"]);
  });

  it("tells members so before looking at what they sent", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    await restrict(administrator, true);
    for (const body of ["not JSON", { kind: "open" }, { kind: "closed", name: "Secret", memberIds: "everyone" }]) {
      expect((await create(grace, body)).status, JSON.stringify(body)).toBe(403);
      // Someone who may create rooms hears what's wrong with the room instead.
      expect((await create(administrator, body)).status, JSON.stringify(body)).toBe(422);
    }
  });

  it("leaves administrators free to create rooms while it's on", async () => {
    const administrator = await setUp();
    await restrict(administrator, true);
    expect((await newRoomForm(administrator)).status).toBe(200);
    expect((await createRoom("Design", { as: administrator })).name).toBe("Design");
    expect((await createRoom("Secret", { as: administrator, closedTo: [administrator.user.id] })).name).toBe("Secret");
  });

  it("checks who's an administrator as they are when they create a room", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    await restrict(administrator, true);

    await changeRole(administrator, grace.user.id, "administrator");
    expect((await create(grace, { kind: "open", name: "Design" })).status).toBe(201);
    await changeRole(administrator, grace.user.id, "member");
    expect((await create(grace, { kind: "open", name: "Ops" })).status).toBe(403);
    expect((await newRoomForm(grace)).status).toBe(403);
  });

  it("lets only administrators switch it", async () => {
    await setUp();
    const grace = await signIn("Grace");
    const response = await restrict(grace, true);
    expect(response.status).toBe(403);
    expect((await bootstrap()).account.restrictRoomCreation).toBe(false);
    expect((await create(grace, { kind: "open", name: "Design" })).status).toBe(201);
  });

  it("refuses a setting that isn't true or false, changing nothing", async () => {
    const administrator = await setUp();
    const response = await restrict(administrator, "true");
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Must be admin to create new rooms must be true or false" });
    expect((await bootstrap()).account.restrictRoomCreation).toBe(false);
  });

  it.each([
    ["no setting", "{}", false],
    ["true", '{"restrict_room_creation_to_administrators":true}', true],
    ["false", '{"restrict_room_creation_to_administrators":false}', false],
    ["null", '{"restrict_room_creation_to_administrators":null}', false],
    ["blank text", '{"restrict_room_creation_to_administrators":" "}', false],
    ["other text", '{"restrict_room_creation_to_administrators":"no"}', true],
    ["a number", '{"restrict_room_creation_to_administrators":0}', true],
    ["an empty list", '{"restrict_room_creation_to_administrators":[]}', false],
    ["settings that aren't an object", "[]", false],
    ["settings that don't parse", "not JSON", false],
  ])("reads %s", async (_, stored, restricted) => {
    await setUp();
    const grace = await signIn("Grace");
    await workspaceSql("UPDATE accounts SET settings = ?", stored);
    // Started afresh, the Workspace has to read the account again.
    await evictDurableObject(workspaceStub());
    expect((await bootstrap()).account.restrictRoomCreation).toBe(restricted);
    expect((await newRoomForm(grace)).status).toBe(restricted ? 403 : 200);
  });
});
