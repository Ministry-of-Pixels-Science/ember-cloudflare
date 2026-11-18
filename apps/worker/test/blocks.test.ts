import { notTakingDirects, type ChangedBlocks, type Involvement, type RoomId, type Sidebar, type WorkspaceServerFrame } from "@ember/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomEvent } from "../src/room-log";
import { BLOCKED_BY_USER, HUDDLE_INVITEES, MARK_UNREAD, MESSAGE_PUSHES, type MessagePush } from "../src/workspace-store";
import { api, createRoom, direct, freshDeploy, freshRoom, openWorkspaceSocket, pushBrowser, signIn, startDirect, workspaceSql, workspaceStub, type Session } from "./support";

// Block someone, on their page and in their messages' More actions, which Apple asks of every app where
// people post: what they post collapses for you and doesn't notify you, they can't start a DM with you,
// and your DM with them leaves your sidebar. Nothing tells them.

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Has `session`'s person block whoever has `userId`, or unblock them. */
const block = (session: Session, userId: string, method: "POST" | "DELETE" = "POST") =>
  api(`/api/users/${encodeURIComponent(userId)}/block`, { method, headers: { Cookie: session.cookie } });

/** What a block or an unblock answers. */
async function answered(response: Promise<Response>): Promise<ChangedBlocks> {
  const settled = await response;
  expect(settled.status, await settled.clone().text()).toBe(200);
  return (await settled.json()) as ChangedBlocks;
}

/** The sidebar `session`'s person gets. */
const sidebarOf = async (session: Session) => (await (await api("/api/sidebar", { headers: { Cookie: session.cookie } })).json()) as Sidebar;

/** `session`'s person's level in room `roomId`. */
const levelIn = async (session: Session, roomId: RoomId) =>
  ((await workspaceSql("SELECT involvement FROM memberships WHERE room_id = ? AND user_id = ?", roomId, session.user.id)) as [{ involvement: Involvement }])[0].involvement;

/** Gives `session`'s person `involvement` in room `roomId`, as their bell does. */
async function involve(session: Session, roomId: RoomId, involvement: Involvement): Promise<void> {
  const response = await api(`/api/rooms/${roomId}/involvement`, { method: "PUT", headers: { Cookie: session.cookie }, body: JSON.stringify({ involvement }) });
  expect(response.status).toBe(200);
}

const directCount = async () => ((await workspaceSql("SELECT count(*) AS n FROM rooms WHERE kind = 'direct'")) as Array<{ n: number }>)[0]!.n;

/** Signs in as each of `names`, in turn. */
async function people<Names extends string[]>(...names: Names): Promise<{ [K in keyof Names]: Session }> {
  const sessions: Session[] = [];
  for (const name of names) sessions.push(await signIn(name));
  return sessions as { [K in keyof Names]: Session };
}

describe("Block someone", () => {
  it("blocks someone for you alone, answering whom you've blocked, as your sidebar lists them", async () => {
    const [ada, grace, linus] = await people("Ada", "Grace", "Linus");

    expect(await answered(block(ada, grace.user.id))).toEqual({ blocks: { userIds: [grace.user.id], version: 1 }, direct: null });
    expect(await answered(block(ada, linus.user.id))).toEqual({ blocks: { userIds: [grace.user.id, linus.user.id], version: 2 }, direct: null });
    // Blocking someone again keeps their place.
    expect(await answered(block(ada, grace.user.id))).toEqual({ blocks: { userIds: [grace.user.id, linus.user.id], version: 3 }, direct: null });
    expect((await sidebarOf(ada)).blocks).toEqual({ userIds: [grace.user.id, linus.user.id], version: 3 });
    expect((await sidebarOf(grace)).blocks).toEqual({ userIds: [], version: 0 });

    expect(await answered(block(ada, grace.user.id, "DELETE"))).toEqual({ blocks: { userIds: [linus.user.id], version: 4 }, direct: null });
    // Unblocking someone again, or someone never blocked, changes nothing.
    expect(await answered(block(ada, grace.user.id, "DELETE"))).toEqual({ blocks: { userIds: [linus.user.id], version: 5 }, direct: null });
    expect(await answered(block(ada, "nobody", "DELETE"))).toEqual({ blocks: { userIds: [linus.user.id], version: 6 }, direct: null });
    expect((await sidebarOf(ada)).blocks).toEqual({ userIds: [linus.user.id], version: 6 });
  });

  it("blocks bots and anyone else who exists, whatever their status, but not yourself, nobody, or an agent you aren't told of", async () => {
    const [ada, grace, bot, agent] = await people("Ada", "Grace", "Bot", "Agent");
    await workspaceSql("UPDATE users SET status = 1 WHERE id = ?", grace.user.id);
    await workspaceSql("UPDATE users SET role = 2 WHERE id = ?", bot.user.id);
    expect((await answered(block(ada, grace.user.id))).blocks.userIds).toEqual([grace.user.id]);
    expect((await answered(block(ada, bot.user.id))).blocks.userIds).toEqual([grace.user.id, bot.user.id]);

    const yourself = await block(ada, ada.user.id);
    expect(yourself.status).toBe(422);
    expect(await yourself.json()).toEqual({ error: "You can't block yourself" });
    expect((await block(ada, "nobody")).status).toBe(404);
    // An AI agent kept for administrators' direct messages is nobody to anyone else.
    await workspaceSql("UPDATE users SET role = 2, agent_access = 'admin-dms' WHERE id = ?", agent.user.id);
    expect((await block(ada, agent.user.id)).status).toBe(404);
    expect(await workspaceSql("SELECT blocked_id FROM blocks WHERE user_id = ? ORDER BY created_at", ada.user.id)).toEqual([{ blocked_id: grace.user.id }, { blocked_id: bot.user.id }]);
    expect((await api(`/api/users/${grace.user.id}/block`, { method: "POST" })).status).toBe(401);
  });

  it("hides your DM with them alone from your sidebar alone, and unblocking shows it again at the level it had", async () => {
    const [ada, grace, linus] = await people("Ada", "Grace", "Linus");
    const theirs = await direct(ada, grace);
    const group = await direct(ada, grace, linus);
    await involve(ada, theirs.id, "nothing");

    expect((await answered(block(ada, grace.user.id))).direct).toEqual({ roomId: theirs.id, involvement: "invisible" });
    expect(await levelIn(ada, theirs.id)).toBe("invisible");
    // Not hers, nor a DM with someone else in it too.
    expect(await levelIn(grace, theirs.id)).toBe("everything");
    expect(await levelIn(ada, group.id)).toBe("everything");
    // Blocking her again hides nothing more.
    expect((await answered(block(ada, grace.user.id))).direct).toBeNull();

    expect((await answered(block(ada, grace.user.id, "DELETE"))).direct).toEqual({ roomId: theirs.id, involvement: "nothing" });
    expect(await levelIn(ada, theirs.id)).toBe("nothing");
    expect((await answered(block(ada, grace.user.id, "DELETE"))).direct).toBeNull();
  });

  it("leaves be a DM you've shown again since, and one started after blocking, though you block them again", async () => {
    // The Workspace runs in this isolate, so it sees the faked clock too, which each block here is a second later on.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const blockLater = (session: Session, userId: string) => {
      vi.setSystemTime(Date.now() + 1000);
      return answered(block(session, userId));
    };
    const [ada, grace, linus] = await people("Ada", "Grace", "Linus");
    const theirs = await direct(ada, grace);
    await blockLater(ada, grace.user.id);
    // As the bell on your profile shows it again.
    await involve(ada, theirs.id, "everything");
    // As a tab that hadn't heard of blocking her asks again.
    expect((await blockLater(ada, grace.user.id)).direct).toBeNull();
    expect(await levelIn(ada, theirs.id)).toBe("everything");
    expect((await answered(block(ada, grace.user.id, "DELETE"))).direct).toBeNull();
    expect(await levelIn(ada, theirs.id)).toBe("everything");

    await blockLater(ada, linus.user.id);
    const started = await direct(ada, linus);
    expect(await levelIn(ada, started.id)).toBe("everything");
    expect((await blockLater(ada, linus.user.id)).direct).toBeNull();
    expect(await levelIn(ada, started.id)).toBe("everything");
    expect((await answered(block(ada, linus.user.id, "DELETE"))).direct).toBeNull();
    expect(await levelIn(ada, started.id)).toBe("everything");
  });

  it("tells every tab of yours whom you've blocked, after the level of the DM it hid, and nobody else", async () => {
    const [ada, grace] = await people("Ada", "Grace");
    const theirs = await direct(ada, grace);
    const tabs = [await openWorkspaceSocket(ada), await openWorkspaceSocket(ada)];
    const gracesTab = await openWorkspaceSocket(grace);

    await block(ada, grace.user.id);
    const frames: WorkspaceServerFrame[] = [
      { type: "room.involvement", roomId: theirs.id, involvement: "invisible" },
      { type: "blocks.changed", blocks: { userIds: [grace.user.id], version: 1 } },
    ];
    for (const tab of tabs) expect([await tab.next(), await tab.next()]).toEqual(frames);
    expect(await gracesTab.answers()).toBe(true);

    await block(ada, grace.user.id, "DELETE");
    for (const tab of tabs) {
      expect(await tab.next()).toEqual({ type: "room.involvement", roomId: theirs.id, involvement: "everything" });
      expect(await tab.next()).toEqual({ type: "blocks.changed", blocks: { userIds: [], version: 2 } });
    }
    expect(await gracesTab.answers()).toBe(true);
  });

  it("changes your sidebar's ETag", async () => {
    const [ada, grace] = await people("Ada", "Grace");
    const before = await api("/api/sidebar", { headers: { Cookie: ada.cookie } });
    await block(ada, grace.user.id);
    const after = await api("/api/sidebar", { headers: { Cookie: ada.cookie, "If-None-Match": before.headers.get("ETag")! } });
    expect(after.status).toBe(200);
  });

  it("reads only your blocks for your sidebar", async () => {
    const [ada, grace] = await people("Ada", "Grace");
    await block(grace, ada.user.id);
    const plan = ((await workspaceSql(`EXPLAIN QUERY PLAN ${BLOCKED_BY_USER}`, ada.user.id)) as Array<{ detail: string }>).map(({ detail }) => detail).join("; ");
    expect(plan).toMatch(/SEARCH blocks USING (COVERING )?INDEX sqlite_autoindex_blocks_1 \(user_id=\?\)/);
  });
});

describe("Someone you've blocked", () => {
  it("can't start a DM with you or put you in one, which says only that you aren't taking direct messages", async () => {
    const [ada, grace, linus, margaret] = await people("Ada", "Grace", "Linus", "Margaret");
    await block(ada, grace.user.id);
    await block(margaret, grace.user.id);

    for (const named of [[ada.user.id], [linus.user.id, ada.user.id]]) {
      const refused = await startDirect(grace, named);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: notTakingDirects("Ada") });
    }
    // The first of those who have blocked her, by name.
    expect(await (await startDirect(grace, [margaret.user.id, ada.user.id])).json()).toEqual({ error: notTakingDirects("Ada") });
    expect(await directCount()).toBe(0);

    // Anyone else, and you yourself, still can.
    expect((await startDirect(grace, [linus.user.id])).status).toBe(201);
    expect((await startDirect(ada, [grace.user.id])).status).toBe(201);
    expect((await startDirect(linus, [ada.user.id, grace.user.id])).status).toBe(201);
  });

  it("still opens a DM you had with them", async () => {
    const [ada, grace] = await people("Ada", "Grace");
    const theirs = await direct(ada, grace);
    await block(ada, grace.user.id);

    const opened = await startDirect(grace, [ada.user.id]);
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { room: { id: RoomId } }).room.id).toBe(theirs.id);
  });

  it("doesn't mark your rooms unread, but for anyone else", async () => {
    const [ada, grace, linus] = await people("Ada", "Grace", "Linus");
    const { id: room } = await createRoom("Designers", { as: ada });
    await block(ada, grace.user.id);

    const now = new Date().toISOString();
    const marks = await workspaceSql(MARK_UNREAD, now, room, grace.user.id, "[]", 1);
    expect(marks).toEqual([{ user_id: linus.user.id, unread_at: now, unread_count: 1 }]);
    const plan = ((await workspaceSql(`EXPLAIN QUERY PLAN ${MARK_UNREAD}`, "", room, grace.user.id, "[]", 1)) as Array<{ detail: string }>).map(({ detail }) => detail).join("; ");
    expect(plan).toMatch(/SEARCH blocks USING (COVERING )?INDEX sqlite_autoindex_blocks_1 \(user_id=\? AND blocked_id=\?\)/);
  });

  it("doesn't push their messages to you, mentions and replies included, but to anyone else", async () => {
    const [ada, grace, linus] = await people("Ada", "Grace", "Linus");
    const room = await freshRoom("Designers");
    for (const [session, label] of [[ada, "ada"], [linus, "linus"]] as const) await subscribe(session, label);
    await involve(linus, room, "everything");
    await block(ada, grace.user.id);

    // Mentioning Ada and Linus, in a thread they both follow.
    const event: RoomEvent = {
      seq: 1,
      kind: "message",
      userId: grace.user.id,
      at: new Date().toISOString(),
      message: { id: crypto.randomUUID(), plainText: "Hey @Ada @Linus", mentionIds: [ada.user.id, linus.user.id], followerIds: [ada.user.id, linus.user.id] },
    };
    expect(labelsOf((await workspaceStub().applyRoomEvents(room, [event], [])).pushes)).toEqual(["linus"]);
    const plan = ((await workspaceSql(`EXPLAIN QUERY PLAN ${MESSAGE_PUSHES}`, room, grace.user.id, "[]", "[]", 1, 1, 1, "[]")) as Array<{ detail: string }>)
      .map(({ detail }) => detail)
      .join("; ");
    expect(plan).toMatch(/SEARCH blocks USING (COVERING )?INDEX sqlite_autoindex_blocks_1 \(user_id=\? AND blocked_id=\?\)/);
  });

  it("can't invite you into a huddle, though anyone else can", async () => {
    const [ada, grace, linus] = await people("Ada", "Grace", "Linus");
    const { id: room } = await createRoom("Standup");
    await block(ada, grace.user.id);
    const named = JSON.stringify([ada.user.id, linus.user.id]);

    expect(await workspaceSql(HUDDLE_INVITEES, room, named, grace.user.id)).toEqual([{ user_id: linus.user.id }]);
    expect(await workspaceSql(HUDDLE_INVITEES, room, JSON.stringify([ada.user.id]), linus.user.id)).toEqual([{ user_id: ada.user.id }]);

    const [adasTab, linusTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(linus)];
    await workspaceStub().inviteToHuddle(room, grace.user.id, [ada.user.id, linus.user.id]);
    expect(await linusTab.next()).toEqual({ type: "huddle.invited", roomId: room, by: grace.user.id });
    expect(await adasTab.answers()).toBe(true);
  });
});

describe("Deleting an account", () => {
  it("forgets whom its person blocked, and who blocked them", async () => {
    const [ada, grace, linus] = await people("Ada", "Grace", "Linus");
    await block(ada, grace.user.id);
    await block(grace, linus.user.id);
    await block(linus, ada.user.id);

    const deleted = await api("/api/users/me", { method: "DELETE", headers: { Cookie: grace.cookie }, body: JSON.stringify({ name: "Grace" }) });
    expect(deleted.status, await deleted.clone().text()).toBe(204);
    expect(await workspaceSql("SELECT user_id, blocked_id FROM blocks")).toEqual([{ user_id: linus.user.id, blocked_id: ada.user.id }]);
    expect((await sidebarOf(ada)).blocks.userIds).toEqual([]);
  });

  it("tells every tab of whoever blocked its person whom they've blocked now, before saying who's gone", async () => {
    const [ada, grace, linus] = await people("Ada", "Grace", "Linus");
    await block(ada, linus.user.id);
    await block(ada, grace.user.id);
    await block(grace, linus.user.id);
    const adasTabs = [await openWorkspaceSocket(ada), await openWorkspaceSocket(ada)];
    const linusTab = await openWorkspaceSocket(linus);

    const deleted = await api("/api/users/me", { method: "DELETE", headers: { Cookie: grace.cookie }, body: JSON.stringify({ name: "Grace" }) });
    expect(deleted.status, await deleted.clone().text()).toBe(204);
    const blocks = { userIds: [linus.user.id], version: 3 };
    for (const tab of adasTabs) {
      expect(await tab.next()).toEqual({ type: "blocks.changed", blocks });
      expect(await tab.next()).toMatchObject({ type: "user.updated", user: { id: grace.user.id } });
    }
    expect((await sidebarOf(ada)).blocks).toEqual(blocks);
    // Linus, whom she had blocked, hears only that she's gone.
    expect(await linusTab.next()).toMatchObject({ type: "user.updated", user: { id: grace.user.id } });
    expect(await linusTab.answers()).toBe(true);
  });
});

/** Saves a subscription for `session` at Chrome's push service, at `/fcm/send/<label>`. */
async function subscribe(session: Session, label: string): Promise<void> {
  const { p256dh, auth } = await pushBrowser();
  const endpoint = `https://fcm.googleapis.com/fcm/send/${label}`;
  const response = await api("/api/push-subscriptions", { method: "POST", headers: { Cookie: session.cookie }, body: JSON.stringify({ endpoint, p256dhKey: p256dh, authKey: auth }) });
  expect(response.status, await response.clone().text()).toBe(204);
}

/** Where a message's pushes go, by the labels `subscribe` gave them. */
const labelsOf = (pushes: MessagePush[]) => pushes.flatMap(({ deliveries }) => deliveries.map(({ endpoint }) => endpoint.split("/").at(-1)));
