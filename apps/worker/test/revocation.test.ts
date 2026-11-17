import { CloseCode, type RoomId } from "@ember/protocol";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { AUTHORIZATION_TTL_MS, EVERYONE, REVOCATIONS_KEPT_MS, sessionTag, type Revocation } from "../src/revocations";
import type { Workspace } from "../src/workspace";
import { DUE_REVOCATIONS, type WorkspaceStore } from "../src/workspace-store";
import { api, closeOf, connect, createRoom, freshDeploy, freshRoom, outcome, post, roomSql, roomStub, settle, signIn, standInForRooms, workspaceSql, workspaceStub } from "./support";

/** A time so far ahead that the runtime never runs an alarm set for it during a test. */
const LATER = Date.now() + 365 * 24 * 60 * 60 * 1000;

const reconnect = { code: CloseCode.Reconnect, reason: "Reconnect" };

/** Queues a revocation in the Workspace's outbox, as a change that ends someone's access does. */
const queue = (roomId: string, tag: string, code: CloseCode, dueAt: number) =>
  workspaceSql("INSERT INTO pending_revocations (room_id, tag, code, due_at) VALUES (?, ?, ?, ?)", roomId, tag, code, dueAt);

const waiting = () => workspaceSql("SELECT room_id, tag, attempts, due_at FROM pending_revocations ORDER BY id");

const alarm = () => runInDurableObject(workspaceStub(), (_workspace, state: DurableObjectState) => state.storage.getAlarm());

/** What the Workspace's alarm calls, standing in for each room. */
interface Rooms {
  revoke(roomId: RoomId, revocations: Revocation[], revokedAt: number): Promise<void>;
}

/** Runs the Workspace's alarm, as the runtime does once it's due, with `rooms` answering for the rooms. */
async function runAlarm(rooms: Rooms): Promise<void> {
  await runInDurableObject(workspaceStub(), async (workspace: Workspace, state: DurableObjectState) => {
    // The runtime clears an alarm as it runs it.
    await state.storage.deleteAlarm();
    const object = workspace as unknown as { env: Env };
    const env = object.env;
    object.env = { ...env, CHAT_ROOM: { getByName: () => rooms } as unknown as Env["CHAT_ROOM"] };
    try {
      await workspace.alarm();
    } finally {
      object.env = env;
    }
  });
}

/** Takes Grace out of a private room as Ada, who stays in it. */
const takeOut = (roomId: RoomId, ada: { cookie: string; user: { id: string } }) =>
  api(`/api/rooms/${roomId}`, { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ kind: "closed", memberIds: [ada.user.id] }) });

beforeEach(freshDeploy);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Connection sign-in and revocation", () => {
  it("turns away a socket let through at or before a revocation of its session or person, telling it to reconnect", async () => {
    const room = await freshRoom("lobby");
    const ada = await signIn("Ada");
    const revokedAt = Date.now();
    await roomStub(room).revoke(room, [{ tag: sessionTag("laptop"), code: CloseCode.Reconnect }], revokedAt);

    const laptop = (authorizedAt: number) => ({ user: ada.user, sessionId: "laptop", authorizedAt });
    expect(await outcome(room, laptop(revokedAt - 1))).toEqual(reconnect);
    expect(await outcome(room, laptop(revokedAt))).toEqual(reconnect);
    expect(await outcome(room, laptop(revokedAt + 1))).toBe("welcome");
    // The person's other sessions weren't revoked.
    expect(await outcome(room, { user: ada.user, sessionId: "phone", authorizedAt: revokedAt - 1 })).toBe("welcome");

    await roomStub(room).revoke(room, [{ tag: ada.user.id, code: CloseCode.Revoked }], revokedAt + 1);
    expect(await outcome(room, { user: ada.user, sessionId: "phone", authorizedAt: revokedAt + 1 })).toEqual(reconnect);
    expect(await outcome(room, { user: ada.user, sessionId: "phone", authorizedAt: revokedAt + 2 })).toBe("welcome");
  });

  it("turns away a socket let through over a minute before it arrives, which a revocation may have outlived", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    const room = await freshRoom("lobby");
    const { user } = await signIn("Ada");
    expect(await outcome(room, { user, sessionId: "laptop", authorizedAt: now - AUTHORIZATION_TTL_MS - 1 })).toEqual(reconnect);
    expect(await outcome(room, { user, sessionId: "laptop", authorizedAt: now - AUTHORIZATION_TTL_MS })).toBe("welcome");
  });

  it("keeps its revocations when it's evicted, and forgets them once no authorization could be that old", async () => {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const room = await freshRoom("lobby");
    const { user } = await signIn("Ada");
    await roomStub(room).revoke(room, [{ tag: user.id, code: CloseCode.Revoked }], start);

    await evictDurableObject(roomStub(room));
    expect(await outcome(room, { user, sessionId: "laptop", authorizedAt: start })).toEqual(reconnect);

    vi.setSystemTime(start + REVOCATIONS_KEPT_MS + 1);
    await roomStub(room).revoke(room, [{ tag: "someone-else", code: CloseCode.Revoked }], start + REVOCATIONS_KEPT_MS + 1);
    expect(await roomSql(room, "SELECT tag FROM revocations WHERE room_id = ?", room)).toEqual([{ tag: "someone-else" }]);
  });

  it("closes every socket a revocation names with its code, and the person leaves at once, just once", async () => {
    const room = await freshRoom("lobby");
    const grace = await connect(room, "Grace");
    const ada = await signIn("Ada");
    const tabs = [await connect(room, ada), await connect(room, ada)];
    const linus = await connect(room, "Linus");
    await settle(grace);
    const closes = tabs.map((tab) => closeOf(tab.ws));

    await roomStub(room).revoke(room, [{ tag: ada.user.id, code: CloseCode.Revoked }], Date.now());
    for (const close of await Promise.all(closes)) expect(close).toMatchObject({ code: CloseCode.Revoked, reason: "Revoked" });
    expect(await grace.next("presence.left")).toEqual({ type: "presence.left", userId: ada.user.id });

    // Everyone else carries on, and hears it once, though Ada's app answers the close after.
    expect((await post(linus, "Still here")).body).toBe("Still here");
    await settle(grace, linus);
    expect(grace.log.filter((frame) => frame.type === "presence.left")).toHaveLength(1);
    expect(linus.log.filter((frame) => frame.type === "presence.left")).toHaveLength(1);
  });

  it("closes a socket that shows a thread apart from the room's timeline as any other, and nobody leaves, since its person wasn't in the room for it", async () => {
    const room = await freshRoom("lobby");
    const grace = await connect(room, "Grace");
    const ada = await signIn("Ada");
    const apart = await connect(room, ada, { visible: true, apart: true });
    const close = closeOf(apart.ws);

    await roomStub(room).revoke(room, [{ tag: ada.user.id, code: CloseCode.Revoked }], Date.now());
    expect(await close).toMatchObject({ code: CloseCode.Revoked, reason: "Revoked" });
    expect((await post(grace, "Still here")).body).toBe("Still here");
    await settle(grace);
    expect(grace.log.filter((frame) => frame.type.startsWith("presence."))).toEqual([]);
  });

  it("ignores what a socket sent before it heard it was closed", async () => {
    const room = await freshRoom("lobby");
    const grace = await connect(room, "Grace");
    const ada = await connect(room, "Ada");
    await roomStub(room).revoke(room, [{ tag: ada.me.id, code: CloseCode.Revoked }], Date.now());
    ada.send({ type: "message.create", clientMessageId: "late", body: "Sent before I heard" });
    ada.send({ type: "typing.start" });

    await settle(grace);
    expect(grace.log.filter((frame) => frame.type === "message.created" || frame.type === "typing")).toEqual([]);
    expect(await roomSql(room, "SELECT count(*) AS n FROM messages WHERE room_id = ?", room)).toEqual([{ n: 0 }]);
  });

  it("queues closing a session's sockets in each of its person's rooms, in the change that ends it", async () => {
    const ada = await signIn("Ada");
    const rooms = [await freshRoom("lobby"), await freshRoom("annex")];
    const [{ id, token_digest }] = (await workspaceSql("SELECT id, token_digest FROM sessions WHERE user_id = ?", ada.user.id)) as [{ id: string; token_digest: string }];
    const endSession = () =>
      runInDurableObject(workspaceStub(), (workspace: Workspace) =>
        (workspace as unknown as { store: WorkspaceStore }).store.endSession(token_digest, CloseCode.Reconnect, LATER, null),
      );

    expect(await endSession()).toBe(true);
    expect(await workspaceSql("SELECT room_id, tag, code, attempts, due_at FROM pending_revocations ORDER BY room_id")).toEqual(
      rooms.sort().map((room_id) => ({ room_id, tag: `s:${id}`, code: CloseCode.Reconnect, attempts: 0, due_at: LATER })),
    );
    expect(await workspaceSql("SELECT id FROM sessions WHERE user_id = ?", ada.user.id)).toEqual([]);
    // Nothing more once it has ended.
    expect(await endSession()).toBe(false);
  });

  it("delivers each room's revocations in one call, as of when it read them, and leaves the rest for later", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    await queue("lobby", "u1", CloseCode.Revoked, LATER);
    await queue("annex", "u1", CloseCode.Revoked, LATER);
    await queue("lobby", "s:laptop", CloseCode.Reconnect, LATER);
    await queue("lobby", "u2", CloseCode.Revoked, LATER + 1);
    const calls: unknown[] = [];

    await runAlarm({ revoke: async (...call) => void calls.push(call) });
    expect(calls).toEqual([
      [
        "lobby",
        [
          { tag: "u1", code: CloseCode.Revoked },
          { tag: "s:laptop", code: CloseCode.Reconnect },
        ],
        LATER,
      ],
      ["annex", [{ tag: "u1", code: CloseCode.Revoked }], LATER],
    ]);
    expect(await waiting()).toEqual([{ room_id: "lobby", tag: "u2", attempts: 0, due_at: LATER + 1 }]);
    expect(await alarm()).toBe(LATER + 1);
  });

  it("tries a room it can't reach again, waiting twice as long each time up to five minutes, and never gives up", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await queue("lobby", "u1", CloseCode.Revoked, LATER);
    await queue("annex", "u1", CloseCode.Revoked, LATER);
    let reachable = false;
    const calls: RoomId[] = [];
    const rooms: Rooms = {
      revoke: async (roomId) => {
        calls.push(roomId);
        if (roomId === "lobby" && !reachable) throw new Error("The lobby isn't answering");
      },
    };

    let now = LATER;
    for (let tries = 1; tries <= 12; tries++) {
      await runAlarm(rooms);
      const wait = Math.min(1000 * 2 ** (tries - 1), 5 * 60 * 1000);
      expect(await waiting()).toEqual([{ room_id: "lobby", tag: "u1", attempts: tries, due_at: now + wait }]);
      expect(await alarm()).toBe(now + wait);
      // Not before then.
      vi.setSystemTime((now += wait) - 1);
      await runAlarm(rooms);
      vi.setSystemTime(now);
    }
    // However often it has failed: a socket left open would keep its access.
    await workspaceSql("UPDATE pending_revocations SET attempts = 100");
    await runAlarm(rooms);
    expect(await waiting()).toEqual([{ room_id: "lobby", tag: "u1", attempts: 101, due_at: now + 5 * 60 * 1000 }]);
    vi.setSystemTime((now += 5 * 60 * 1000));

    reachable = true;
    await runAlarm(rooms);
    expect(calls).toEqual(["lobby", "annex", ...Array<RoomId>(13).fill("lobby")]);
    expect(await waiting()).toEqual([]);
    expect(errors).toHaveBeenCalledTimes(13);
    expect(errors).not.toHaveBeenCalledWith(expect.stringMatching(/^Gave up/));
  });

  it("closes the sockets a change queues before the change answers, leaving the alarm nothing to deliver", async () => {
    // The alarm, set as the sockets are queued, would close them a moment later; set for LATER, it never
    // runs, so whatever is closed by the time the change answers, the change closed.
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const closed = closeOf((await connect(room.id, grace)).ws);

    expect((await takeOut(room.id, ada)).status).toBe(200);
    expect(await waiting()).toEqual([]);
    expect(await alarm()).toBe(LATER);
    expect(await closed).toMatchObject(reconnect);
  });

  it("closes a session's room sockets before signing out answers", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    const ada = await signIn("Ada");
    const lobby = await freshRoom("lobby");
    const closed = closeOf((await connect(lobby, ada)).ws);

    expect((await api("/api/session", { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(204);
    expect(await waiting()).toEqual([]);
    expect(await alarm()).toBe(LATER);
    expect(await closed).toMatchObject(reconnect);
  });

  it("answers a change after waiting two seconds for a room, and leaves that room's sockets to the alarm", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const closed = closeOf((await connect(room.id, grace)).ws);
    let isClosed = false;
    void closed.then(() => (isClosed = true));
    // The room answers once the test lets it, closing the sockets as it would have.
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const giveBack = await standInForRooms({
      revoke: async (...call) => {
        await held;
        await roomStub(call[0]).revoke(...call);
      },
    });

    const changing = takeOut(room.id, ada);
    expect(await Promise.race([changing.then(() => "answered"), scheduler.wait(1_500).then(() => "waiting")])).toBe("waiting");
    expect((await changing).status).toBe(200);
    expect(isClosed).toBe(false);
    expect(await waiting()).toEqual([{ room_id: room.id, tag: grace.user.id, attempts: 0, due_at: LATER }]);
    expect(await alarm()).toBe(LATER);

    // The call that was waiting goes on, and closes them once the room answers; the alarm would have found nothing left.
    letGo();
    expect(await closed).toMatchObject(reconnect);
    await vi.waitFor(async () => expect(await waiting()).toEqual([]));
    await giveBack();
  });

  it("closes every socket a change ends in a room with one call, however many rows it queued there", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const closed = closeOf((await connect(room.id, grace)).ws);
    // As many rows in the room as the alarm delivers a run, queued and not yet tried, as a change
    // taking that many people out of it leaves.
    const tags = Array.from({ length: 40 }, (_, i) => `u-${String(i).padStart(2, "0")}`);
    await workspaceSql("INSERT INTO pending_revocations (room_id, tag, code, due_at) SELECT ?, value, ?, ? FROM json_each(?)", room.id, CloseCode.Revoked, LATER - 1, JSON.stringify(tags));
    const calls: Array<{ roomId: RoomId; tags: string[] }> = [];
    const giveBack = await standInForRooms({
      revoke: async (...call) => {
        calls.push({ roomId: call[0], tags: call[1].map(({ tag }) => tag) });
        await roomStub(call[0]).revoke(...call);
      },
    });

    expect((await takeOut(room.id, ada)).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.roomId).toBe(room.id);
    expect(calls[0]!.tags).toHaveLength(41);
    expect(calls[0]!.tags).toContain(grace.user.id);
    expect(await waiting()).toEqual([]);
    expect(await closed).toMatchObject(reconnect);
    await giveBack();
  });

  it("calls the rooms a change queued last first, up to 40 of them, leaving older ones to the alarm", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const closed = closeOf((await connect(room.id, grace)).ws);
    // A backlog as many rooms long as a run delivers, queued before the change and not yet tried.
    const backlog = Array.from({ length: 40 }, (_, i) => `room-${String(i).padStart(2, "0")}`);
    await workspaceSql("INSERT INTO pending_revocations (room_id, tag, code, due_at) SELECT value, 'u1', ?, ? FROM json_each(?)", CloseCode.Revoked, LATER - 1, JSON.stringify(backlog));
    const calls: RoomId[] = [];
    const giveBack = await standInForRooms({
      revoke: async (...call) => {
        calls.push(call[0]);
        if (call[0] === room.id) await roomStub(call[0]).revoke(...call);
      },
    });

    expect((await takeOut(room.id, ada)).status).toBe(200);
    expect(calls[0]).toBe(room.id);
    expect(calls).toHaveLength(40);
    expect(calls).not.toContain("room-00");
    expect(await waiting()).toEqual([{ room_id: "room-00", tag: "u1", attempts: 0, due_at: LATER - 1 }]);
    expect(await alarm()).toBe(LATER);
    expect(await closed).toMatchObject(reconnect);
    await giveBack();
  });

  it("delivers a change's revocations after a delivery under way, never alongside it", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const closed = closeOf((await connect(room.id, grace)).ws);
    let isClosed = false;
    void closed.then(() => (isClosed = true));
    // The alarm is delivering to a room that's slow to answer as the change comes. Were the two to run
    // at once, each would settle the rows it read by id, and a deleted row's id can go to the next row
    // queued, which the other would then settle undelivered.
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const calls: RoomId[] = [];
    const giveBack = await standInForRooms({
      revoke: async (...call) => {
        calls.push(call[0]);
        if (call[0] === "annex") return held;
        await roomStub(call[0]).revoke(...call);
      },
    });
    await queue("annex", "u1", CloseCode.Revoked, LATER - 1);
    const alarmRun = runInDurableObject(workspaceStub(), (workspace: Workspace) => workspace.alarm());
    await vi.waitFor(() => expect(calls).toEqual(["annex"]));

    // Waiting moved the clock on.
    const now = Date.now();
    const changing = takeOut(room.id, ada);
    expect(await Promise.race([changing.then(() => "answered"), scheduler.wait(1_500).then(() => "waiting")])).toBe("waiting");
    expect((await changing).status).toBe(200);
    expect(calls).toEqual(["annex"]);
    expect(isClosed).toBe(false);
    expect(await waiting()).toEqual([
      { room_id: "annex", tag: "u1", attempts: 0, due_at: LATER - 1 },
      { room_id: room.id, tag: grace.user.id, attempts: 0, due_at: now },
    ]);

    // Its turn comes once the annex answers.
    letGo();
    await alarmRun;
    expect(await closed).toMatchObject(reconnect);
    await vi.waitFor(async () => expect(await waiting()).toEqual([]));
    expect(calls).toEqual(["annex", room.id]);
    await giveBack();
  });

  it("delivers 40 revocations a run, calling six rooms at once, and sets its alarm for the rest", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    const ids = Array.from({ length: 45 }, (_, i) => `room-${String(i).padStart(2, "0")}`);
    await workspaceSql(
      "INSERT INTO pending_revocations (room_id, tag, code, due_at) SELECT value, 'u1', ?, ? FROM json_each(?)",
      CloseCode.Revoked,
      LATER,
      JSON.stringify(ids),
    );
    const calls: RoomId[] = [];
    let open = 0;
    let most = 0;
    const rooms: Rooms = {
      revoke: async (roomId) => {
        calls.push(roomId);
        most = Math.max(most, ++open);
        await scheduler.wait(1);
        open--;
      },
    };

    await runAlarm(rooms);
    expect(calls).toEqual(ids.slice(0, 40));
    expect(most).toBe(6);
    expect(await alarm()).toBe(LATER);
    await runAlarm(rooms);
    expect(calls).toEqual(ids);
    expect(await waiting()).toEqual([]);
  });

  it("sets its alarm for the revocations waiting when it starts, in case it stopped before it could", async () => {
    const ada = await signIn("Ada");
    const lobby = await freshRoom("lobby");
    const closed = closeOf((await connect(lobby, ada)).ws);
    // As a Workspace that stopped between saving a change and setting its alarm leaves it.
    await queue(lobby, ada.user.id, CloseCode.Reconnect, Date.now());
    expect(await alarm()).toBeNull();

    await evictDurableObject(workspaceStub());
    // Anything that reaches the Workspace starts it again.
    await alarm();
    expect(await closed).toMatchObject(reconnect);
  });

  it("finds the revocations that are due by their index, however many are waiting", async () => {
    const plan = (await workspaceSql(`EXPLAIN QUERY PLAN ${DUE_REVOCATIONS}`, 0, 40)).map((row) => (row as { detail: string }).detail).join("; ");
    expect(plan).toContain("USING INDEX index_pending_revocations_on_due_at (due_at<?)");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});

describe("Delete a room", () => {
  it("never gives up deleting a room it can't reach, trying again at the longest wait until it can", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await queue("lobby", EVERYONE, CloseCode.NotFound, LATER);
    let reachable = false;
    const calls: unknown[] = [];
    const rooms: Rooms = {
      revoke: async (...call) => {
        calls.push(call);
        if (!reachable) throw new Error("The lobby isn't answering");
      },
    };

    let now = LATER;
    for (let tries = 1; tries <= 12; tries++) {
      await runAlarm(rooms);
      const wait = Math.min(1000 * 2 ** (tries - 1), 5 * 60 * 1000);
      expect(await waiting()).toEqual([{ room_id: "lobby", tag: EVERYONE, attempts: tries, due_at: now + wait }]);
      expect(await alarm()).toBe(now + wait);
      vi.setSystemTime((now += wait));
    }
    // However often it has failed.
    await workspaceSql("UPDATE pending_revocations SET attempts = 100");
    await runAlarm(rooms);
    expect(await waiting()).toEqual([{ room_id: "lobby", tag: EVERYONE, attempts: 101, due_at: now + 5 * 60 * 1000 }]);
    vi.setSystemTime((now += 5 * 60 * 1000));

    reachable = true;
    await runAlarm(rooms);
    expect(calls).toHaveLength(14);
    expect(calls.at(-1)).toEqual(["lobby", [{ tag: EVERYONE, code: CloseCode.NotFound }], now]);
    expect(await waiting()).toEqual([]);
    expect(errors).toHaveBeenCalledTimes(13);
    expect(errors).not.toHaveBeenCalledWith(expect.stringMatching(/^Gave up/));
  });
});
