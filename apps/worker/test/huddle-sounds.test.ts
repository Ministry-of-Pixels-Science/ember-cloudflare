import type { Me, NewWorkspace, Sidebar, User, UserId, WorkspaceServerFrame } from "@ember/protocol";
import { HUDDLE_SOUNDS_REFUSED, type HuddleSounds, type HuddleSoundsChanged } from "@ember/protocol/huddles";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsFor } from "../src/auth";
import type { Env } from "../src/env";
import type { Workspace } from "../src/workspace";
import type { WorkspaceStore } from "../src/workspace-store";
import { api, cookieOf, freshDeploy, openWorkspaceSocket, origin, shown, signIn, workspaceSql, workspaceStub, type Session } from "./support";

// Which of a huddle's own sounds someone hears, as the switches on their profile leave them: its music
// while they're the only one in it, its sounds of someone joining and leaving, and an invitation's ring.

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Signs in as Ada from another browser, in a session of its own. */
async function signInAsAda(): Promise<Session> {
  const response = await api("/api/session", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.7" }, body: JSON.stringify({ emailAddress: ada.emailAddress, password: ada.password }) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: User }).user), cookie: cookieOf(response) };
}

/** Grace joins with the join link, setting an email address and password, signed in. */
async function join(): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify(grace) });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

const as = (session: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Turns a huddle's sounds on or off as `session`'s person, as the switches on their profile do, or with no session. */
const turn = (session: Session | null, changes: unknown) => api("/api/users/me/huddle-sounds", { method: "PATCH", headers: as(session), body: JSON.stringify(changes) });

/** The same, answering which they hear then. */
async function turned(session: Session, changes: Partial<HuddleSounds>): Promise<HuddleSounds> {
  const response = await turn(session, changes);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as HuddleSoundsChanged).sounds;
}

const sidebarOf = async (session: Session) => (await (await api("/api/sidebar", { headers: as(session) })).json()) as Sidebar;

/** Which of a huddle's sounds `userId` hears, as stored. */
const stored = async (userId: UserId) => ((await workspaceSql("SELECT huddle_music, huddle_chimes, huddle_ring FROM users WHERE id = ?", userId)) as Array<Record<string, number>>)[0]!;

const EVERY_SOUND = { huddle_music: 1, huddle_chimes: 1, huddle_ring: 1 };

const storeOf = (workspace: Workspace) => (workspace as unknown as { store: WorkspaceStore }).store;

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Huddle sounds, which each person turns on or off for themselves", () => {
  it("has everyone hear every sound until they turn one off, with nothing about them in their sidebar", async () => {
    const person = await signIn("Grace Hopper");
    expect(await sidebarOf(person)).not.toHaveProperty("huddleSounds");
    expect(await stored(person.user.id)).toEqual(EVERY_SOUND);
  });

  it("turns one off, answering which they hear then, and their sidebar says so under another ETag", async () => {
    const person = await signIn("Grace Hopper");
    const before = await api("/api/sidebar", { headers: as(person) });

    expect(await turned(person, { music: false })).toEqual({ music: false, chimes: true, ring: true });
    const after = await api("/api/sidebar", { headers: { ...as(person), "If-None-Match": before.headers.get("ETag")! } });
    expect(after.status).toBe(200);
    expect(((await after.json()) as Sidebar).huddleSounds).toEqual({ music: false, chimes: true, ring: true });
    expect(await stored(person.user.id)).toEqual({ ...EVERY_SOUND, huddle_music: 0 });
  });

  it("leaves the sounds a change doesn't name as they are, and changes nothing with none", async () => {
    const person = await signIn("Grace Hopper");
    await turned(person, { chimes: false });
    expect(await turned(person, { ring: false })).toEqual({ music: true, chimes: false, ring: false });
    expect(await turned(person, { chimes: true, music: false })).toEqual({ music: false, chimes: true, ring: false });
    expect(await turned(person, {})).toEqual({ music: false, chimes: true, ring: false });
    expect((await sidebarOf(person)).huddleSounds).toEqual({ music: false, chimes: true, ring: false });
  });

  it("says nothing of them in the sidebar again once they're all back on, which is the sidebar from before", async () => {
    const person = await signIn("Grace Hopper");
    const before = await api("/api/sidebar", { headers: as(person) });
    await turned(person, { music: false, ring: false });

    expect(await turned(person, { music: true, ring: true })).toEqual({ music: true, chimes: true, ring: true });
    expect(await sidebarOf(person)).not.toHaveProperty("huddleSounds");
    expect((await api("/api/sidebar", { headers: { ...as(person), "If-None-Match": before.headers.get("ETag")! } })).status).toBe(304);
  });

  it("keeps them with the person, on every device they sign in on, once the Workspace has started again", async () => {
    const phone = await setUp();
    await turned(phone, { ring: false });

    const laptop = await signInAsAda();
    await evictDurableObject(workspaceStub());
    expect((await sidebarOf(laptop)).huddleSounds).toEqual({ music: true, chimes: true, ring: false });
    expect(await turned(laptop, { music: false })).toEqual({ music: false, chimes: true, ring: false });
    expect((await sidebarOf(phone)).huddleSounds).toEqual({ music: false, chimes: true, ring: false });
  });

  it("turns them off for the person alone", async () => {
    const person = await signIn("Grace Hopper");
    const other = await signIn("Ada Lovelace");
    await turned(person, { music: false, chimes: false, ring: false });

    expect((await sidebarOf(person)).huddleSounds).toEqual({ music: false, chimes: false, ring: false });
    expect(await sidebarOf(other)).not.toHaveProperty("huddleSounds");
    expect(await stored(other.user.id)).toEqual(EVERY_SOUND);
  });

  it("tells every tab of theirs which they hear, and nobody else's", async () => {
    const person = await signIn("Grace Hopper");
    const other = await signIn("Ada Lovelace");
    const tabs = [await openWorkspaceSocket(person), await openWorkspaceSocket(person)];
    const othersTab = await openWorkspaceSocket(other);

    await turned(person, { chimes: false });
    for (const tab of tabs) expect(await tab.next()).toEqual({ type: "huddle.sounds", sounds: { music: true, chimes: false, ring: true } } satisfies WorkspaceServerFrame);
    // Back on, they hear them all, which the frame says in full.
    await turned(person, { chimes: true });
    for (const tab of tabs) expect(await tab.next()).toEqual({ type: "huddle.sounds", sounds: { music: true, chimes: true, ring: true } } satisfies WorkspaceServerFrame);
    expect(await othersTab.answers()).toBe(true);
  });

  it("tells their tabs of each change in the order it was kept, even when the first is answered late", async () => {
    const person = await signIn("Grace Hopper");
    await turned(person, { chimes: false });
    const tab = await openWorkspaceSocket(person);
    const credentials = await credentialsFor(person.cookie.split("=")[1]!, new Request(origin), env as unknown as Env);

    await runInDurableObject(workspaceStub(), async (workspace: Workspace) => {
      const store = storeOf(workspace);
      const keep = store.setHuddleSounds.bind(store);
      // On D1 a write's answer can come back after the answer to a write made after it.
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => (answer = resolve));
      vi.spyOn(store, "setHuddleSounds").mockImplementationOnce(async (...args) => {
        const kept = await keep(...args);
        await answered;
        return kept;
      });
      const changes = [workspace.setHuddleSounds(credentials, { music: false }), workspace.setHuddleSounds(credentials, { music: true })];
      // Long enough for the second change to be kept and told of, were it not waiting for the first.
      await new Promise((resolve) => setTimeout(resolve, 100));
      answer();
      expect(await Promise.all(changes)).toEqual([
        { music: false, chimes: false, ring: true },
        { music: true, chimes: false, ring: true },
      ]);
    });
    expect(await tab.next()).toEqual({ type: "huddle.sounds", sounds: { music: false, chimes: false, ring: true } });
    expect(await tab.next()).toEqual({ type: "huddle.sounds", sounds: { music: true, chimes: false, ring: true } });
    expect((await sidebarOf(person)).huddleSounds).toEqual({ music: true, chimes: false, ring: true });
  });

  it("refuses anything but true or false for a sound, changing nothing, and takes nothing else", async () => {
    const person = await signIn("Grace Hopper");
    const tab = await openWorkspaceSocket(person);
    for (const changes of [{ music: "off" }, { chimes: 0 }, { ring: null }, { music: false, ring: "no" }]) {
      const response = await turn(person, changes);
      expect(response.status, JSON.stringify(changes)).toBe(422);
      expect(await response.json()).toEqual({ error: HUDDLE_SOUNDS_REFUSED });
    }
    for (const changes of [null, [], [{ music: false }], "music", 0]) {
      const response = await turn(person, changes);
      expect(response.status, JSON.stringify(changes)).toBe(422);
      expect(await response.json()).toEqual({ error: "Expected a JSON object" });
    }
    expect(await stored(person.user.id)).toEqual(EVERY_SOUND);
    expect(await tab.answers()).toBe(true);

    // What isn't one of a huddle's sounds is passed over.
    expect(await turned(person, { volume: 11, ring: false } as Partial<HuddleSounds>)).toEqual({ music: true, chimes: true, ring: false });
  });

  it("refuses without a session", async () => {
    const person = await signIn("Grace Hopper");
    expect((await turn(null, { music: false })).status).toBe(401);
    expect((await turn({ ...person, cookie: person.cookie.replace(/=.*/, "=nonsense") }, { music: false })).status).toBe(401);
    expect(await stored(person.user.id)).toEqual(EVERY_SOUND);
  });

  it("keeps none of them for someone who has deleted their account, nor a change that reaches the Workspace after", async () => {
    await setUp();
    const member = await join();
    await turned(member, { music: false, chimes: false, ring: false });
    expect(await stored(member.user.id)).toEqual({ huddle_music: 0, huddle_chimes: 0, huddle_ring: 0 });

    const deleted = await api("/api/users/me", { method: "DELETE", headers: as(member), body: JSON.stringify({ currentPassword: grace.password }) });
    expect(deleted.status, await deleted.clone().text()).toBe(204);
    expect(await stored(member.user.id)).toEqual(EVERY_SOUND);
    expect((await turn(member, { music: false })).status).toBe(401);
    // A change from a session that was still theirs when it was checked.
    expect(await runInDurableObject(workspaceStub(), (workspace: Workspace) => storeOf(workspace).setHuddleSounds(member.user.id, { music: false }))).toBeNull();
    expect(await stored(member.user.id)).toEqual(EVERY_SOUND);
  });
});
