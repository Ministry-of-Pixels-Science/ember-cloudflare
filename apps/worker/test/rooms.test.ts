import { CloseCode, type RoomId, type SidebarRoom } from "@ember/protocol";
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { openDb, statement } from "../src/db";
import type { Env } from "../src/env";
import { MEMBERSHIP, ROOMS_FOR_USER } from "../src/workspace-store";
import { api, connect, createRoom, deactivatedPerson, freshRoom, listedRoom, roomStub, signIn, upgrade, workspaceSql, workspaceStub, type Session } from "./support";

const bindings = env as unknown as Env;

/** The rooms `session`'s person sees listed, of those `ids` names, in the order they're listed. */
async function listed(session: Session, ...ids: RoomId[]): Promise<SidebarRoom[]> {
  const response = await api("/api/sidebar", { headers: { Cookie: session.cookie } });
  expect(response.status).toBe(200);
  const { rooms } = (await response.json()) as { rooms: SidebarRoom[] };
  return rooms.filter((room) => ids.includes(room.id));
}

/**
 * Opens room `roomId`'s socket as `session`'s person, answering what comes of it: "welcome" once the
 * room lets it in, the code it's closed with at once, or the status of an upgrade that's refused.
 */
async function openSocket(roomId: RoomId, session: Session): Promise<"welcome" | number> {
  const response = await api(`/api/rooms/${roomId}/socket`, upgrade(session.cookie));
  const ws = response.webSocket;
  if (!ws) return response.status;
  ws.accept();
  return new Promise((resolve) => {
    ws.addEventListener("message", () => {
      resolve("welcome");
      ws.close(1000);
    });
    ws.addEventListener("close", (event) => resolve(event.code));
  });
}

/** Whether anything has created room `roomId`'s Durable Object. */
async function roomObjectExists(roomId: RoomId): Promise<boolean> {
  const id = bindings.CHAT_ROOM.idFromName(roomId);
  return (await listDurableObjectIds(bindings.CHAT_ROOM)).some((existing) => existing.equals(id));
}

const membersOf = async (roomId: RoomId) =>
  (await workspaceSql("SELECT user_id, involvement FROM memberships WHERE room_id = ? ORDER BY user_id", roomId)) as Array<{ user_id: string; involvement: string }>;

describe("Open rooms everyone is in", () => {
  it("puts everyone in every open room, whether they joined before or after it was made", async () => {
    const ada = await signIn("Ada");
    const room = await createRoom("Design");
    const grace = await signIn("Grace");

    expect(room).toEqual({ id: expect.stringMatching(/^[0-9a-z]{16}$/), kind: "open", name: "Design", icon: null });
    expect(await listed(ada, room.id)).toEqual([listedRoom(room)]);
    expect(await listed(grace, room.id)).toEqual([listedRoom(room)]);
    expect(await membersOf(room.id)).toContainEqual({ user_id: grace.user.id, involvement: "mentions" });
  });

  it("lets anyone signed in open an open room's socket", async () => {
    const room = await freshRoom("lobby");
    expect(await openSocket(room, await signIn("Grace"))).toBe("welcome");
  });

  it("never adds deactivated people", async () => {
    const former = await deactivatedPerson("Former");
    const room = await createRoom("Design");
    expect((await membersOf(room.id)).map((m) => m.user_id)).not.toContain(former);
  });

  it("finds a membership by its key and someone's rooms by their index, however many there are", async () => {
    const plan = async (query: string, ...params: string[]) =>
      (await workspaceSql(`EXPLAIN QUERY PLAN ${query}`, ...params)).map((row) => (row as { detail: string }).detail).join("; ");
    expect(await plan(MEMBERSHIP, "room", "user")).toMatch(/INDEX sqlite_autoindex_memberships_1 \(room_id=\? AND user_id=\?\)/);
    expect(await plan(ROOMS_FOR_USER, "user")).toContain("index_memberships_on_user_id_and_room_id (user_id=?)");
  });
});

describe("Room addresses", () => {
  it("lists someone's rooms in the order they were put in them, for the app to find the first and the latest", async () => {
    const ada = await signIn("Ada");
    const as = { closedTo: [ada.user.id] };
    const [beta, alpha, gamma] = [await createRoom("beta", as), await createRoom("Alpha", as), await createRoom("gamma", as)];
    expect(await listed(ada, gamma.id, alpha.id, beta.id)).toEqual([beta, alpha, gamma].map(listedRoom));
  });
});

describe("New rooms go last", () => {
  /** Changes room `roomId` as `session`'s person, as its settings do. */
  async function change(roomId: RoomId, session: Session, changes: unknown) {
    const response = await api(`/api/rooms/${roomId}`, { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify(changes) });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  /** Lets the clock move on, so whoever's put in a room next is put in it later than anyone was before. */
  const later = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("lists a room made since every other room someone's in after them all, whatever its name", async () => {
    const ada = await signIn("Ada");
    const zulu = await createRoom("Zulu");
    await later();
    const annex = await createRoom("Annex");
    expect(await listed(ada, annex.id, zulu.id)).toEqual([zulu, annex].map(listedRoom));
  });

  it("lists the open rooms someone's put in as they join in the order they were made", async () => {
    const zulu = await createRoom("Zulu");
    await later();
    const annex = await createRoom("Annex");
    expect(await listed(await signIn("Grace"), annex.id, zulu.id)).toEqual([zulu, annex].map(listedRoom));
  });

  it("lists a room someone's put in after it was made after the rooms made since, but leaves it in its place for the people in it already", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const earlier = await createRoom("Earlier", { closedTo: [ada.user.id], as: ada });
    await later();
    const since = await createRoom("Since", { closedTo: [ada.user.id, grace.user.id], as: ada });
    await later();
    await change(earlier.id, ada, { kind: "closed", memberIds: [ada.user.id, grace.user.id] });
    expect(await listed(grace, earlier.id, since.id)).toEqual([since, earlier].map(listedRoom));
    expect(await listed(ada, earlier.id, since.id)).toEqual([earlier, since].map(listedRoom));
  });

  it("lists a private room opened to everyone last for the people it puts in", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const earlier = await createRoom("Earlier", { closedTo: [ada.user.id], as: ada });
    await later();
    const since = await createRoom("Since");
    await later();
    await change(earlier.id, ada, { kind: "open" });
    const opened = { ...earlier, kind: "open" as const };
    expect(await listed(grace, earlier.id, since.id)).toEqual([since, opened].map(listedRoom));
    expect(await listed(ada, earlier.id, since.id)).toEqual([opened, since].map(listedRoom));
  });
});

describe("Only members see a room", () => {
  it("opens a room's socket only for its members, telling anyone else it's not there without waking the room", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id] });

    expect(await openSocket(room.id, grace)).toBe(CloseCode.NotFound);
    expect(await roomObjectExists(room.id)).toBe(false);

    expect(await openSocket(room.id, ada)).toBe("welcome");
  });

  it("lists only the rooms someone is in", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id] });
    expect(await listed(ada, room.id)).toEqual([listedRoom(room)]);
    expect(await listed(grace, room.id)).toEqual([]);
  });

  it("tells someone a room that doesn't exist isn't there, and answers 404 for ids that can't be rooms", async () => {
    const ada = await signIn("Ada");
    const missing = `nowhere-${crypto.randomUUID().slice(0, 8)}`;
    expect(await openSocket(missing, ada)).toBe(CloseCode.NotFound);
    expect(await roomObjectExists(missing)).toBe(false);
    for (const room of ["General", "-general", "a%2Fb", "%FF", "x".repeat(64)]) {
      expect(await openSocket(room, ada), room).toBe(404);
    }
  });
});

describe("Create an open room", () => {
  it("answers the room it made", async () => {
    const response = await api("/api/rooms", {
      method: "POST",
      headers: { Cookie: (await signIn("Ada")).cookie },
      body: JSON.stringify({ kind: "open", name: "  Design  " }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ room: { id: expect.any(String), kind: "open", name: "Design", icon: null } });
  });

  it("refuses requests without a session, from other sites, or that don't say what to make", async () => {
    const { cookie } = await signIn("Ada");
    const create = (body: unknown, headers: Record<string, string> = { Cookie: cookie }) =>
      api("/api/rooms", { method: "POST", headers, body: JSON.stringify(body) });

    expect((await create({ kind: "open", name: "Design" }, {})).status).toBe(401);
    expect((await create({ kind: "open", name: "Design" }, { Cookie: cookie, Origin: "https://evil.test" })).status).toBe(422);
    const invalid = await create({ kind: "open", name: " " });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: "Name must be 1 to 100 characters" });
    expect((await api("/api/rooms", { method: "POST", headers: { Cookie: cookie }, body: "kind=open" })).status).toBe(422);
  });
});

describe("Create a private room", () => {
  it("puts just the people it names in a closed room, whatever their status, and skips ids nobody has", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const former = await deactivatedPerson("Former");
    const room = await createRoom("Leads", { closedTo: [ada.user.id, former, "nobody", ada.user.id], as: grace });

    expect(room.kind).toBe("closed");
    // The creator isn't added unless they're named, whose form names them itself.
    expect((await membersOf(room.id)).map((m) => m.user_id).sort()).toEqual([ada.user.id, former].sort());
    expect(await listed(grace, room.id)).toEqual([]);
  });

  it("isn't joined by people who sign in later", async () => {
    const room = await createRoom("Leads", { closedTo: [] });
    expect(await listed(await signIn("Grace"), room.id)).toEqual([]);
  });
});

describe("Rooms from before memberships", () => {
  /** A room with messages and a reaction from before the Workspace kept a list, as the old preview's are. */
  async function legacyRoom() {
    const id = `legacy-${crypto.randomUUID().slice(0, 8)}`;
    const authors = { ada: { id: `${id}-ada`, name: "Ada" }, grace: { id: `${id}-grace`, name: "Grace" } };
    const message = (n: number, author: { id: string; name: string }, body: string) =>
      statement(
        `INSERT INTO messages (id, room_id, client_message_id, creator_id, creator_name, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        `${id}-m${n}`,
        id,
        `c${n}`,
        author.id,
        author.name,
        body,
        `2026-10-0${n}T12:00:00.000Z`,
        `2026-10-0${n}T12:00:00.000Z`,
      );
    await runInDurableObject(roomStub(id), async (_room, state: DurableObjectState) => {
      await openDb(bindings, state.storage, "room").batch([
        message(1, authors.ada, "From before the list"),
        message(2, authors.ada, "Still here"),
        statement(
          `INSERT INTO boosts (id, room_id, message_id, booster_id, booster_name, content, created_at) VALUES (?, ?, ?, ?, ?, '👍', 'now')`,
          `${id}-b1`,
          id,
          `${id}-m1`,
          authors.grace.id,
          authors.grace.name,
        ),
      ]);
    });
    return { id, authors };
  }

  it("registers each room as an open room named for its address, which keeps its messages and takes everyone in", async () => {
    const ada = await signIn("Ada");
    const room = await legacyRoom();
    await workspaceStub().registerLegacyRooms([room.id]);
    const grace = await signIn("Grace");

    const expected = { id: room.id, kind: "open", name: room.id, icon: null, unread: false, involvement: "mentions" };
    expect(await listed(ada, room.id)).toEqual([expected]);
    expect(await listed(grace, room.id)).toEqual([expected]);
    const { welcome } = await connect(room.id, grace);
    expect(welcome.messages.map((m) => m.body)).toEqual(["From before the list", "Still here"]);
    expect(welcome.messages[0]!.boosts.map((b) => b.booster)).toEqual([room.authors.grace]);
  });

  it("keeps the people who wrote or reacted there as deactivated guests, outside every room", async () => {
    const room = await legacyRoom();
    await workspaceStub().registerLegacyRooms([room.id]);

    const people = await workspaceSql("SELECT id, name, status, guest FROM users WHERE id IN (?, ?) ORDER BY id", room.authors.ada.id, room.authors.grace.id);
    expect(people).toEqual([
      { ...room.authors.ada, status: 1, guest: 1 },
      { ...room.authors.grace, status: 1, guest: 1 },
    ]);
    expect(await workspaceSql("SELECT room_id FROM memberships WHERE user_id IN (?, ?)", room.authors.ada.id, room.authors.grace.id)).toEqual([]);
  });

  it("changes nothing when it registers a room again", async () => {
    const room = await legacyRoom();
    await signIn("Ada");
    await workspaceStub().registerLegacyRooms([room.id]);
    const snapshot = async () => ({
      rooms: await workspaceSql("SELECT * FROM rooms WHERE id = ?", room.id),
      people: await workspaceSql("SELECT * FROM users WHERE id IN (?, ?) ORDER BY id", room.authors.ada.id, room.authors.grace.id),
      members: await membersOf(room.id),
    });
    const before = await snapshot();

    await workspaceStub().registerLegacyRooms([room.id, room.id]);
    expect(await snapshot()).toEqual(before);
  });

  it("lists each room by when it was listed, though its id doesn't sort by time", async () => {
    const ada = await signIn("Ada");
    const before = await createRoom("Before", { closedTo: [ada.user.id] });
    const room = await legacyRoom();
    // Apart from the rooms made around it by a moment, so it's never listed at the same time as one.
    await scheduler.wait(2);
    await workspaceStub().registerLegacyRooms([room.id]);
    await scheduler.wait(2);
    const after = await createRoom("After", { closedTo: [ada.user.id] });
    expect((await listed(ada, after.id, room.id, before.id)).map((listedRoom) => listedRoom.id)).toEqual([before.id, room.id, after.id]);
  });

  it("keeps an old room it wasn't told about out of reach", async () => {
    const room = await legacyRoom();
    const ada = await signIn("Ada");
    expect(await listed(ada, room.id)).toEqual([]);
    expect(await openSocket(room.id, ada)).toBe(CloseCode.NotFound);
  });
});
