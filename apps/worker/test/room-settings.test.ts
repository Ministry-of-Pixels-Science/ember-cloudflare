import { CloseCode, type NewRoomForm, type RoomId, type RoomSettings, type SharedRoom, type Sidebar, type UserId } from "@ember/protocol";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../src/workspace";
import { ACTIVE_PEOPLE, ACTIVE_PEOPLE_IN_ROOM, QUEUE_MEMBER_REVOCATIONS, REVOKE_ROOM_FROM_OTHERS, ROOM_TO_CHANGE, type WorkspaceStore } from "../src/workspace-store";
import { api, closeOf, connect, createRoom, direct, freshDeploy, openWorkspaceSocket, post, settle, signIn, upgrade, workspaceSql, workspaceStub, type Session } from "./support";

beforeEach(freshDeploy);

const as = (session: Session) => ({ headers: { Cookie: session.cookie } });

const newRoomForm = (session: Session) => api("/api/rooms/new", as(session));

const settings = (roomId: RoomId, session: Session) => api(`/api/rooms/${roomId}/settings`, as(session));

const change = (roomId: RoomId, session: Session, body: unknown) =>
  api(`/api/rooms/${roomId}`, { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify(body) });

/** Makes someone an administrator, as only first run can yet. */
const promote = (session: Session) => workspaceSql("UPDATE users SET role = 1 WHERE id = ?", session.user.id);

const nameOf = async (roomId: RoomId) => ((await workspaceSql("SELECT name FROM rooms WHERE id = ?", roomId)) as Array<{ name: string }>)[0]!.name;

/** Who's in a room, by id. */
const membersOf = async (roomId: RoomId) =>
  ((await workspaceSql("SELECT user_id FROM memberships WHERE room_id = ? ORDER BY user_id", roomId)) as Array<{ user_id: UserId }>).map((row) => row.user_id);

const ids = (...sessions: Session[]) => sessions.map((session) => session.user.id).sort();

/** What becomes of a new socket into a room as `session`'s person: let in, or the code it's closed with at once. */
async function reconnect(roomId: RoomId, session: Session): Promise<"welcome" | number> {
  const ws = (await api(`/api/rooms/${roomId}/socket`, upgrade(session.cookie))).webSocket!;
  ws.accept();
  return new Promise((resolve) => {
    ws.addEventListener("message", () => {
      resolve("welcome");
      ws.close(1000);
    });
    ws.addEventListener("close", (event) => resolve(event.code));
  });
}

describe("Create an open room", () => {
  it("lists everyone active for New room, by name whatever its case", async () => {
    const ada = await signIn("ada");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    await workspaceSql("UPDATE users SET status = 1 WHERE id = ?", linus.user.id);

    const response = await newRoomForm(grace);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ people: [ada.user, grace.user] } satisfies NewRoomForm);
  });

  it("asks who's signed in", async () => {
    expect((await api("/api/rooms/new")).status).toBe(401);
  });
});

describe("Room settings page", () => {
  it("shows a room's settings to whoever made it, with everyone active and whether they're in it", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, linus.user.id], as: ada });

    const response = await settings(room.id, ada);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      room,
      canAdminister: true,
      canChangeHuddles: false,
      people: [
        { ...ada.user, member: true },
        { ...grace.user, member: false },
        { ...linus.user, member: true },
      ],
    } satisfies RoomSettings);
  });

  it("shows other members the same settings, which they can't change", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Design", { as: ada });

    const shown = (await (await settings(room.id, grace)).json()) as RoomSettings;
    expect(shown.canAdminister).toBe(false);
    expect(shown.people).toEqual([
      { ...ada.user, member: true },
      { ...grace.user, member: true },
    ]);
  });

  it("renames a room, trimming the name, and answers it", async () => {
    const ada = await signIn("Ada");
    const room = await createRoom("Design", { as: ada });

    const response = await change(room.id, ada, { name: "  Product design " });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ room: { ...room, name: "Product design" } });
    expect(await nameOf(room.id)).toBe("Product design");
    expect(await (await change(room.id, ada, {})).json()).toEqual({ room: { ...room, name: "Product design" } });
  });

  it("refuses a name that's blank or too long, keeping the one it has", async () => {
    const ada = await signIn("Ada");
    const room = await createRoom("Design", { as: ada });
    for (const body of [{ name: " " }, { name: "x".repeat(101) }, null]) {
      const response = await change(room.id, ada, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect(await (await change(room.id, ada, { name: "" })).json()).toEqual({ error: "Name must be 1 to 100 characters" });
    expect(await nameOf(room.id)).toBe("Design");
  });

  it("finds a room and its people with one read each, by their keys", async () => {
    const plan = async (query: string, ...params: string[]) =>
      (await workspaceSql(`EXPLAIN QUERY PLAN ${query}`, ...params)).map((row) => (row as { detail: string }).detail).join("; ");
    const toChange = await plan(ROOM_TO_CHANGE, "room", "user");
    expect(toChange).toMatch(/SEARCH memberships USING (COVERING )?INDEX sqlite_autoindex_memberships_1 \(room_id=\? AND user_id=\?\)/);
    expect(toChange).toMatch(/SEARCH rooms USING INDEX sqlite_autoindex_rooms_1 \(id=\?\)/);
    expect(toChange).toMatch(/SEARCH users USING INDEX sqlite_autoindex_users_1 \(id=\?\)/);
    expect(await plan(ACTIVE_PEOPLE_IN_ROOM, "room")).toMatch(/SEARCH memberships USING (COVERING )?INDEX sqlite_autoindex_memberships_1 \(room_id=\? AND user_id=\?\)/);
    expect(await plan(ACTIVE_PEOPLE)).toContain("SCAN users");
  });
});

describe("Who can change a room", () => {
  it("lets the room's creator and administrators change it", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Design", { as: ada });
    await promote(grace);

    expect(((await (await settings(room.id, grace)).json()) as RoomSettings).canAdminister).toBe(true);
    expect((await change(room.id, grace, { name: "Renamed by an administrator" })).status).toBe(200);
    expect((await change(room.id, ada, { name: "Renamed by its creator" })).status).toBe(200);
    expect(await nameOf(room.id)).toBe("Renamed by its creator");
  });

  it("refuses other members before checking what they sent, and changes nothing", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Design", { as: ada });

    for (const body of [{ name: "Mine now" }, { name: " " }, { kind: "closed" }]) {
      const response = await change(room.id, grace, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators and the room's creator can change it" });
    }
    expect(await nameOf(room.id)).toBe("Design");
  });

  it("makes one change at a time, so someone taken out of a room can't open it with a change they sent before", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    await promote(grace);
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    // Holds Ada's change between reading who may make it and writing, as D1 can, until Grace's change
    // has finished, or for a second if it's waiting for Ada's.
    const race = { adaHasRead: false, graceIsDone: false };
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const roomToChange = store.roomToChange.bind(store);
      store.roomToChange = async (roomId, userId) => {
        const found = await roomToChange(roomId, userId);
        if (userId !== ada.user.id) return found;
        race.adaHasRead = true;
        for (let waited = 0; !race.graceIsDone && waited < 1_000; waited += 10) await scheduler.wait(10);
        return found;
      };
    });

    const adaOpensIt = change(room.id, ada, { kind: "open" });
    await vi.waitFor(() => expect(race.adaHasRead).toBe(true));
    const graceTakesAdaOut = await change(room.id, grace, { kind: "closed", memberIds: [grace.user.id] });
    race.graceIsDone = true;
    expect((await adaOpensIt).status).toBe(200);
    expect(graceTakesAdaOut.status).toBe(200);
    expect(await workspaceSql("SELECT kind FROM rooms WHERE id = ?", room.id)).toEqual([{ kind: "closed" }]);
    expect(await membersOf(room.id)).toEqual(ids(grace));
  });

  it("answers 404 to people who aren't in the room, administrators included, and for missing rooms and DMs", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    await promote(grace);
    const room = await createRoom("Leads", { closedTo: [ada.user.id], as: ada });
    const dm = await direct(ada, grace);

    for (const [roomId, session] of [[room.id, grace], ["nowhere", ada], [dm.id, ada], ["%FF", ada]] as const) {
      for (const response of [await settings(roomId, session), await change(roomId, session, { name: "Renamed" })]) {
        expect(response.status, roomId).toBe(404);
        expect(await response.json()).toEqual({ error: "Room not found or inaccessible" });
      }
    }
    expect(await nameOf(room.id)).toBe("Leads");
  });

  it("asks who's signed in, and refuses changes from other sites", async () => {
    const ada = await signIn("Ada");
    const room = await createRoom("Design", { as: ada });
    expect((await api(`/api/rooms/${room.id}/settings`)).status).toBe(401);
    expect((await api(`/api/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) })).status).toBe(401);
    const crossSite = await api(`/api/rooms/${room.id}`, {
      method: "PATCH",
      headers: { Cookie: ada.cookie, Origin: "https://evil.test" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(crossSite.status).toBe(422);
    expect(await nameOf(room.id)).toBe("Design");
  });
});

describe("Allow huddles in a room", () => {
  /** A room as `session`'s sidebar lists it. */
  const listed = async (roomId: RoomId, session: Session) => ((await (await api("/api/sidebar", as(session))).json()) as Sidebar).rooms.find((room) => room.id === roomId);

  /** What the Workspace keeps of whether a room's settings allow huddles in it. */
  const kept = (roomId: RoomId) => workspaceSql("SELECT huddles_allowed FROM rooms WHERE id = ?", roomId);

  /** Someone signed in who's an administrator, as whoever turns a room's huddles on or off is. */
  const administrator = async (name: string) => {
    const session = await signIn(name);
    await promote(session);
    return session;
  };

  it("allows huddles in a room until its settings turn them off, which its settings and its people's sidebars then say", async () => {
    const [ada, grace] = [await administrator("Ada"), await signIn("Grace")];
    const [room, other] = [await createRoom("Announcements", { as: ada }), await createRoom("Design", { as: ada })];
    expect(room).not.toHaveProperty("huddles");

    const response = await change(room.id, ada, { huddles: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ room: { ...room, huddles: false } satisfies SharedRoom });
    expect(((await (await settings(room.id, grace)).json()) as RoomSettings).room).toEqual({ ...room, huddles: false });
    expect(await listed(room.id, grace)).toMatchObject({ ...room, huddles: false });
    // In that room alone.
    expect(await listed(other.id, grace)).not.toHaveProperty("huddles");
    expect(await kept(other.id)).toEqual([{ huddles_allowed: 1 }]);
  });

  it("keeps huddles off through the room's other changes, and allows them again once its settings say so", async () => {
    const ada = await administrator("Ada");
    const room = await createRoom("Announcements", { as: ada });
    expect((await change(room.id, ada, { huddles: false })).status).toBe(200);

    const news: SharedRoom = { ...room, name: "News", icon: "rocket", kind: "closed", huddles: false };
    expect(await (await change(room.id, ada, { name: "News", icon: "rocket", kind: "closed", memberIds: [ada.user.id] })).json()).toEqual({ room: news });
    expect(await (await change(room.id, ada, {})).json()).toEqual({ room: news });

    const { room: allowing } = (await (await change(room.id, ada, { huddles: true })).json()) as { room: SharedRoom };
    expect(allowing).toEqual({ ...room, name: "News", icon: "rocket", kind: "closed" });
    expect(allowing).not.toHaveProperty("huddles");
    expect(await listed(room.id, ada)).not.toHaveProperty("huddles");
    expect(await kept(room.id)).toEqual([{ huddles_allowed: 1 }]);
  });

  it("takes only true or false, and otherwise keeps the room as it is", async () => {
    const ada = await administrator("Ada");
    const room = await createRoom("Design", { as: ada });
    for (const huddles of [null, 0, "false", "off"]) {
      const response = await change(room.id, ada, { name: "Renamed", huddles });
      expect(response.status, JSON.stringify(huddles)).toBe(422);
      expect(await response.json()).toEqual({ error: "Huddles must be true or false" });
    }
    expect(await nameOf(room.id)).toBe("Design");
    expect(await kept(room.id)).toEqual([{ huddles_allowed: 1 }]);
  });

  it("is an administrator's to turn off and on, and not the room's creator's, who can change the rest of it, nor anyone else's in it", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const room = await createRoom("Design", { as: ada });
    await promote(grace);

    // Linus can't change the room, and Ada, who made it, hears whose its huddles are, and changes nothing sent with them.
    const asLinus = await change(room.id, linus, { huddles: false });
    expect(asLinus.status).toBe(403);
    expect(await asLinus.json()).toEqual({ error: "Only administrators and the room's creator can change it" });
    const asAda = await change(room.id, ada, { name: "Renamed", huddles: false });
    expect(asAda.status).toBe(403);
    expect(await asAda.json()).toEqual({ error: "Only administrators can turn huddles on or off in a room" });
    expect(await nameOf(room.id)).toBe("Design");
    expect(await kept(room.id)).toEqual([{ huddles_allowed: 1 }]);

    // Grace, an administrator who didn't make it, turns them off, and Ada can't turn them on again.
    expect((await change(room.id, grace, { huddles: false })).status).toBe(200);
    expect(await kept(room.id)).toEqual([{ huddles_allowed: 0 }]);
    expect((await change(room.id, ada, { huddles: true })).status).toBe(403);
    expect(await kept(room.id)).toEqual([{ huddles_allowed: 0 }]);
    expect((await change(room.id, grace, { huddles: true })).status).toBe(200);
    expect(await kept(room.id)).toEqual([{ huddles_allowed: 1 }]);
  });

  it("takes huddles sent as they are from the room's creator, with the room's other changes, as it turns nothing on or off", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Design", { as: ada });
    await promote(grace);

    expect(await (await change(room.id, ada, { name: "Studio", huddles: true })).json()).toEqual({ room: { ...room, name: "Studio" } });
    expect((await change(room.id, grace, { huddles: false })).status).toBe(200);
    expect(await (await change(room.id, ada, { name: "Design", huddles: false })).json()).toEqual({ room: { ...room, huddles: false } });
    expect(await kept(room.id)).toEqual([{ huddles_allowed: 0 }]);
  });

  it("tells a room's settings that an administrator can turn its huddles on or off, and that its creator and everyone else in it can't", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const room = await createRoom("Design", { as: ada });
    await promote(grace);
    const can = async (session: Session) => {
      const { canAdminister, canChangeHuddles } = (await (await settings(room.id, session)).json()) as RoomSettings;
      return { canAdminister, canChangeHuddles };
    };

    expect(await can(ada)).toEqual({ canAdminister: true, canChangeHuddles: false });
    expect(await can(grace)).toEqual({ canAdminister: true, canChangeHuddles: true });
    expect(await can(linus)).toEqual({ canAdminister: false, canChangeHuddles: false });
  });

  it("records no change when huddles are already as the room's settings say", async () => {
    const ada = await administrator("Ada");
    const room = await createRoom("Design", { as: ada });
    const changedAt = () => workspaceSql("SELECT updated_at FROM rooms WHERE id = ?", room.id);
    const then = () => workspaceSql("UPDATE rooms SET updated_at = 'then' WHERE id = ?", room.id);

    await then();
    expect((await change(room.id, ada, { huddles: true })).status).toBe(200);
    expect(await changedAt()).toEqual([{ updated_at: "then" }]);
    expect((await change(room.id, ada, { huddles: false })).status).toBe(200);
    expect(await changedAt()).not.toEqual([{ updated_at: "then" }]);

    await then();
    expect((await change(room.id, ada, { huddles: false })).status).toBe(200);
    expect(await changedAt()).toEqual([{ updated_at: "then" }]);
  });

  it("starts a new room with huddles allowed, whatever New room is sent of them", async () => {
    const ada = await signIn("Ada");
    const response = await api("/api/rooms", { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify({ kind: "open", name: "Design", huddles: false }) });
    expect(response.status).toBe(201);
    const { room } = (await response.json()) as { room: SharedRoom };
    expect(room).not.toHaveProperty("huddles");
    expect(await kept(room.id)).toEqual([{ huddles_allowed: 1 }]);
  });
});

describe("Leave a private room", () => {
  const leave = (roomId: RoomId, session?: Session) => api(`/api/rooms/${roomId}/membership`, { method: "DELETE", ...(session && as(session)) });

  it("takes out someone who can't change the room, by their own choice, closing their sockets there, and nobody else", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id, linus.user.id], as: ada });
    const graceInRoom = await connect(room.id, grace);
    const linusInRoom = await connect(room.id, linus);
    const gracesTab = await openWorkspaceSocket(grace);
    const closed = closeOf(graceInRoom.ws);

    expect((await leave(room.id, grace)).status).toBe(204);
    expect(await membersOf(room.id)).toEqual(ids(ada, linus));
    expect(await gracesTab.next()).toEqual({ type: "room.gone", roomId: room.id });
    expect(await closed).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect(await linusInRoom.next("presence.left")).toEqual({ type: "presence.left", userId: grace.user.id });
    expect((await post(linusInRoom, "Still here")).body).toBe("Still here");
    expect((await settings(room.id, grace)).status).toBe(404);
    expect(await reconnect(room.id, grace)).toBe(CloseCode.NotFound);
    expect((await leave(room.id, grace)).status).toBe(404);
  });

  it("refuses whoever can change the room, creator or administrator, whose settings take them out, and keeps them in", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id, linus.user.id], as: ada });
    await promote(grace);
    for (const session of [ada, grace]) {
      const refused = await leave(room.id, session);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "You can change this room, so take yourself out in its settings" });
    }
    expect(await membersOf(room.id)).toEqual(ids(ada, grace, linus));
  });

  it("refuses the last person who could open it, counting neither bots nor anyone banned, and keeps them in", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const room = await createRoom("Leads", { closedTo: [grace.user.id, linus.user.id], as: ada });
    const refused = async () => {
      const response = await leave(room.id, grace);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Nobody else could open this room, so you can't leave it" });
      expect(await membersOf(room.id)).toEqual(ids(grace, linus));
    };
    await workspaceSql("UPDATE users SET role = 2 WHERE id = ?", linus.user.id);
    await refused();
    await workspaceSql("UPDATE users SET role = 0, status = 2 WHERE id = ?", linus.user.id);
    await refused();
    // Someone suspended has it again once their membership is renewed.
    await workspaceSql("UPDATE users SET status = 3 WHERE id = ?", linus.user.id);
    expect((await leave(room.id, grace)).status).toBe(204);
    expect(await membersOf(room.id)).toEqual(ids(linus));
  });

  it("refuses an open room, which takes in everyone, and answers 404 to people who aren't in the room, for missing rooms and DMs", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const open = await createRoom("Design", { as: ada });
    const refused = await leave(open.id, grace);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Everyone is in an open room, so nobody can leave it" });
    expect(await membersOf(open.id)).toContain(grace.user.id);

    const closed = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const dm = await direct(grace, linus);
    for (const roomId of [closed.id, "nothing"]) expect((await leave(roomId, linus)).status).toBe(404);
    expect((await leave(dm.id, grace)).status).toBe(404);
    expect(await membersOf(closed.id)).toEqual(ids(ada, grace));
  });

  it("asks who's signed in, and refuses requests from other sites", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    expect((await leave(room.id)).status).toBe(401);
    const crossSite = await api(`/api/rooms/${room.id}/membership`, { method: "DELETE", headers: { Cookie: grace.cookie, "Sec-Fetch-Site": "cross-site" } });
    expect(crossSite.status).toBe(422);
    expect(await membersOf(room.id)).toEqual(ids(ada, grace));
  });
});

describe("Switch a room between open and private", () => {
  it("makes a private room open, adding everyone active and keeping members' notification levels", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id], as: ada });
    await workspaceSql("UPDATE users SET status = 1 WHERE id = ?", linus.user.id);
    await workspaceSql("UPDATE memberships SET involvement = 'everything' WHERE room_id = ? AND user_id = ?", room.id, ada.user.id);

    const response = await change(room.id, ada, { kind: "open" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ room: { ...room, kind: "open" } satisfies SharedRoom });
    expect(await membersOf(room.id)).toEqual(ids(ada, grace));
    expect(await workspaceSql("SELECT involvement FROM memberships WHERE room_id = ? AND user_id = ?", room.id, ada.user.id)).toEqual([{ involvement: "everything" }]);
    expect(await reconnect(room.id, grace)).toBe("welcome");
  });

  it("makes an open room private to the people chosen, closing everyone else's sockets there, who find it gone", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const [room, annex] = [await createRoom("Design", { as: ada }), await createRoom("Annex", { as: ada })];
    const graceInRoom = await connect(room.id, grace);
    const linusInRoom = await connect(room.id, linus);
    const linusInAnnex = await connect(annex.id, linus);
    const closed = closeOf(linusInRoom.ws);

    const response = await change(room.id, ada, { name: "Leads", kind: "closed", memberIds: [ada.user.id, grace.user.id] });
    expect(await response.json()).toEqual({ room: { ...room, name: "Leads", kind: "closed" } satisfies SharedRoom });
    expect(await closed).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect(await reconnect(room.id, linus)).toBe(CloseCode.NotFound);
    expect(await membersOf(room.id)).toEqual(ids(ada, grace));
    expect(await workspaceSql("SELECT * FROM pending_revocations")).toEqual([]);

    // Everyone else is still where they were.
    expect((await post(graceInRoom, "Still here")).body).toBe("Still here");
    expect((await post(linusInAnnex, "Still in the annex")).body).toBe("Still in the annex");
    expect(await graceInRoom.next("presence.left")).toEqual({ type: "presence.left", userId: linus.user.id });
    await settle(graceInRoom);
  });
});

describe("Add and remove private room members", () => {
  it("adds and takes out a private room's people as its settings save them, adding anyone who exists", async () => {
    const [ada, grace, linus, mary] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus"), await signIn("Mary")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    await workspaceSql("UPDATE users SET status = 1 WHERE id = ?", mary.user.id);

    const memberIds = [ada.user.id, linus.user.id, mary.user.id, "nobody"];
    const response = await change(room.id, ada, { name: "Leads", kind: "closed", memberIds });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ room });
    expect(await membersOf(room.id)).toEqual(ids(ada, linus, mary));
    expect(await workspaceSql("SELECT DISTINCT involvement FROM memberships WHERE room_id = ?", room.id)).toEqual([{ involvement: "mentions" }]);
    expect(((await (await settings(room.id, linus)).json()) as RoomSettings).room).toEqual(room);
    expect((await settings(room.id, grace)).status).toBe(404);
  });

  it("takes out whoever saves the room without themselves, who can't see it then", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });

    expect((await change(room.id, ada, { kind: "closed", memberIds: [grace.user.id] })).status).toBe(200);
    expect(await membersOf(room.id)).toEqual(ids(grace));
    expect((await settings(room.id, ada)).status).toBe(404);
    expect(await reconnect(room.id, ada)).toBe(CloseCode.NotFound);
  });

  it("queues nothing, and records no change, when everyone stays and nothing else changes", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    await workspaceSql("UPDATE rooms SET updated_at = 'then' WHERE id = ?", room.id);
    const graceInRoom = await connect(room.id, grace);

    expect((await change(room.id, ada, { name: "Leads", kind: "closed", memberIds: ids(ada, grace) })).status).toBe(200);
    expect(await workspaceSql("SELECT updated_at FROM rooms WHERE id = ?", room.id)).toEqual([{ updated_at: "then" }]);
    expect(await workspaceSql("SELECT * FROM pending_revocations")).toEqual([]);
    expect((await post(graceInRoom, "Still here")).body).toBe("Still here");

    expect((await change(room.id, ada, { name: "Leaders" })).status).toBe(200);
    expect(await workspaceSql("SELECT updated_at FROM rooms WHERE id = ?", room.id)).not.toEqual([{ updated_at: "then" }]);
  });

  it("still closes the sockets of the people it takes out when the database saves the change but its answer is lost", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const closed = closeOf((await connect(room.id, grace)).ws);
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const changeRoom = store.changeRoom.bind(store);
      store.changeRoom = async (...args) => {
        await changeRoom(...args);
        throw new Error("The database's answer was lost");
      };
    });

    expect((await change(room.id, ada, { kind: "closed", memberIds: [ada.user.id] })).status).toBe(500);
    expect(await closed).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect(await reconnect(room.id, grace)).toBe(CloseCode.NotFound);
  });

  it("finds the people it takes out by the room's key", async () => {
    const plan = async (query: string, ...params: Array<string | number>) =>
      (await workspaceSql(`EXPLAIN QUERY PLAN ${query}`, ...params)).map((row) => (row as { detail: string }).detail).join("; ");
    for (const query of [await plan(QUEUE_MEMBER_REVOCATIONS, CloseCode.Reconnect, 0, "room", "[]"), await plan(REVOKE_ROOM_FROM_OTHERS, "room", "[]")]) {
      expect(query).toMatch(/SEARCH memberships USING (COVERING )?INDEX sqlite_autoindex_memberships_1 \(room_id=\?\)/);
    }
  });
});
