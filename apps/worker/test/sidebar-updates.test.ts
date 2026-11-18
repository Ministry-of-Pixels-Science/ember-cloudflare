import type { Room, RoomId } from "@ember/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { ROOM_MEMBERS } from "../src/workspace-store";
import { api, createRoom, freshDeploy, openWorkspaceSocket, signIn, workspaceSql, type Session, type WorkspaceSocket } from "./support";

beforeEach(freshDeploy);

const change = (roomId: RoomId, session: Session, body: unknown) =>
  api(`/api/rooms/${roomId}`, { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify(body) });

const remove = (roomId: RoomId, session: Session) => api(`/api/rooms/${roomId}`, { method: "DELETE", headers: { Cookie: session.cookie } });

/** Expects the Workspace to have sent `tab` nothing but the answer to a ping sent now. */
const heardNothing = async (tab: WorkspaceSocket) => expect(await tab.answers()).toBe(true);

describe("Live sidebar updates", () => {
  it("shows a new open room in every tab of everyone's at once", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const tabs = [await openWorkspaceSocket(ada), await openWorkspaceSocket(ada), await openWorkspaceSocket(grace)];

    const room = await createRoom("Design", { as: ada });
    for (const tab of tabs) expect(await tab.next()).toEqual({ type: "room.saved", room });
  });

  it("shows a new private room to its members alone", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const [adasTab, gracesTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace)];

    const room = await createRoom("Plans", { closedTo: [ada.user.id], as: ada });
    expect(await adasTab.next()).toEqual({ type: "room.saved", room });
    await heardNothing(gracesTab);
  });

  it("shows a room renamed, or given another icon, to everyone in it, and nobody else", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Plans", { closedTo: [ada.user.id], as: ada });
    const [adasTab, gracesTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace)];

    expect((await change(room.id, ada, { name: "Roadmap", icon: "rocket" })).status).toBe(200);
    expect(await adasTab.next()).toEqual({ type: "room.saved", room: { ...room, name: "Roadmap", icon: "rocket" } });
    await heardNothing(gracesTab);
  });

  it("shows everyone in a room that its settings no longer allow huddles there, whoever a change puts in it too, and that they do again, and nobody else", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    // An administrator, as whoever turns a room's huddles on or off is.
    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", ada.user.id);
    const room = await createRoom("Plans", { closedTo: [ada.user.id], as: ada });
    const [adasTab, gracesTab, linussTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace), await openWorkspaceSocket(linus)];

    expect((await change(room.id, ada, { huddles: false })).status).toBe(200);
    expect(await adasTab.next()).toEqual({ type: "room.saved", room: { ...room, huddles: false } });
    // Saved again, the room is as it was, so nobody hears anything.
    expect((await change(room.id, ada, { huddles: false })).status).toBe(200);
    await heardNothing(adasTab);

    // Grace, put in the room, is shown it without huddles.
    expect((await change(room.id, ada, { kind: "closed", memberIds: [ada.user.id, grace.user.id] })).status).toBe(200);
    expect(await gracesTab.next()).toEqual({ type: "room.saved", room: { ...room, huddles: false } });
    await heardNothing(adasTab);

    expect((await change(room.id, ada, { huddles: true })).status).toBe(200);
    for (const tab of [adasTab, gracesTab]) {
      const saved = await tab.next();
      expect(saved).toEqual({ type: "room.saved", room });
      expect((saved as { room: Room }).room).not.toHaveProperty("huddles");
    }
    await heardNothing(linussTab);
  });

  it("takes a room out of the sidebars of the people a change takes out, and shows it to those it puts in", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const room = await createRoom("Plans", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const [adasTab, gracesTab, linussTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace), await openWorkspaceSocket(linus)];

    expect((await change(room.id, ada, { kind: "closed", memberIds: [ada.user.id, linus.user.id] })).status).toBe(200);
    expect(await gracesTab.next()).toEqual({ type: "room.gone", roomId: room.id });
    expect(await linussTab.next()).toEqual({ type: "room.saved", room });
    // The room is as it was, so whoever stays in it hears nothing.
    await heardNothing(adasTab);
  });

  it("shows a private room opened to everyone in every sidebar, and one made private again in its members' alone", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Plans", { closedTo: [ada.user.id], as: ada });
    const [adasTab, gracesTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace)];

    expect((await change(room.id, ada, { kind: "open" })).status).toBe(200);
    const opened: Room = { ...room, kind: "open" };
    for (const tab of [adasTab, gracesTab]) expect(await tab.next()).toEqual({ type: "room.saved", room: opened });

    expect((await change(room.id, ada, { kind: "closed", memberIds: [ada.user.id] })).status).toBe(200);
    expect(await gracesTab.next()).toEqual({ type: "room.gone", roomId: room.id });
    expect(await adasTab.next()).toEqual({ type: "room.saved", room });
  });

  it("takes a deleted room out of the sidebars of the people who were in it, telling nobody else", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Plans", { closedTo: [ada.user.id], as: ada });
    const [adasTab, gracesTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace)];

    expect((await remove(room.id, ada)).status).toBe(204);
    expect(await adasTab.next()).toEqual({ type: "room.gone", roomId: room.id });
    await heardNothing(gracesTab);
  });

  it("tells nobody of a change that changes nothing", async () => {
    const ada = await signIn("Ada");
    const room = await createRoom("Plans", { as: ada });
    const adasTab = await openWorkspaceSocket(ada);

    expect((await change(room.id, ada, { name: "Plans", kind: "open", icon: "" })).status).toBe(200);
    await heardNothing(adasTab);
  });

  it("finds who's in a room by the memberships' key", async () => {
    const plan = await workspaceSql(`EXPLAIN QUERY PLAN ${ROOM_MEMBERS}`, "room");
    expect(plan.map((row) => (row as { detail: string }).detail).join("; ")).toMatch(/SEARCH memberships USING (COVERING )?INDEX sqlite_autoindex_memberships_1 \(room_id=\?\)/);
  });
});
