import { CloseCode, type NewWorkspace, type Sidebar, type User } from "@ember/protocol";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsFor } from "../src/auth";
import type { Env } from "../src/env";
import { CREDENTIALS_HEADER, type Workspace } from "../src/workspace";
import type { WorkspaceStore } from "../src/workspace-store";
import { api, cookieOf, createRoom, freshDeploy, listedRoom, openWorkspaceSocket, origin, signIn, upgrade, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: ((await response.json()) as NewWorkspace).user, cookie: cookieOf(response) };
}

/** Signs in as Ada from another browser, in a session of her own. */
async function signInAsAda(): Promise<Session> {
  const response = await api("/api/session", { method: "POST", body: JSON.stringify({ emailAddress: ada.emailAddress, password: ada.password }) });
  expect(response.status).toBe(201);
  return { user: ((await response.json()) as { user: User }).user, cookie: cookieOf(response) };
}

const signOut = (session: Session) => api("/api/session", { method: "DELETE", headers: { Cookie: session.cookie } });

beforeEach(freshDeploy);

describe("One live connection per tab outside the open room", () => {
  it("lets in a signed-in tab's socket from the app's own pages, saying who it signs in", async () => {
    const grace = await signIn("Grace");
    expect((await openWorkspaceSocket(grace)).welcome).toEqual({
      type: "welcome",
      you: { ...grace.user, administrator: false },
      account: { name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true },
    });
  });

  it("refuses an upgrade without a session, or from another site, and anything but an upgrade", async () => {
    const { cookie } = await signIn("Grace");
    const forgotten = cookie.replace(/=.*/, `=${"A".repeat(43)}`);
    expect((await api("/api/socket", upgrade())).status).toBe(401);
    expect((await api("/api/socket", upgrade(forgotten))).status).toBe(401);
    expect((await api("/api/socket", { headers: { Upgrade: "websocket", Origin: "https://elsewhere.test", Cookie: cookie } })).status).toBe(404);
    expect((await api("/api/socket", { headers: { Upgrade: "websocket", Cookie: cookie } })).status).toBe(404);
    expect((await api("/api/socket", { headers: { Origin: origin, Cookie: cookie } })).status).toBe(404);
  });

  it("answers pings, the runtime the bare one, and refuses anything else", async () => {
    const socket = await openWorkspaceSocket(await signIn("Grace"));
    socket.send('{"type":"ping"}');
    expect(await socket.next()).toEqual({ type: "pong" });
    expect(await socket.answers()).toBe(true);
    socket.send('{"type":"message.create","clientMessageId":"c1","body":"hi"}');
    expect(await socket.next()).toEqual({ type: "error", message: "Unrecognized frame" });
  });

  it("closes a session's sockets when it signs out, telling them to reconnect, and leaves everyone else's", async () => {
    const laptop = await setUp();
    const phone = await signInAsAda();
    const grace = await signIn("Grace");
    const onLaptop = await openWorkspaceSocket(laptop);
    const onPhone = await openWorkspaceSocket(phone);
    const gracesTab = await openWorkspaceSocket(grace);

    expect((await signOut(laptop)).status).toBe(204);
    expect(await onLaptop.closed).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect(await onPhone.answers()).toBe(true);
    expect(await gracesTab.answers()).toBe(true);
    expect((await api("/api/socket", upgrade(laptop.cookie))).status).toBe(401);
  });

  it("closes a session's sockets even when the database ends it but the answer is lost", async () => {
    const laptop = await setUp();
    const socket = await openWorkspaceSocket(laptop);
    const { tokenDigest } = await credentialsFor(laptop.cookie.split("=")[1]!, new Request(origin), env as unknown as Env);
    const failure = await runInDurableObject(workspaceStub(), async (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const endSession = store.endSession.bind(store);
      // As on D1, where the session can go and the answer saying so never come back.
      vi.spyOn(store, "endSession").mockImplementationOnce(async (...args) => {
        await endSession(...args);
        throw new Error("Network connection lost.");
      });
      return workspace.signOut(tokenDigest).then(
        () => null,
        (error: Error) => error.message,
      );
    });
    expect(failure).toBe("Network connection lost.");
    expect(await socket.closed).toMatchObject({ code: CloseCode.Reconnect });
    expect((await api("/api/socket", upgrade(laptop.cookie))).status).toBe(401);
  });

  it("keeps its sockets while the Workspace is evicted, and still finds them to close", async () => {
    const laptop = await setUp();
    const socket = await openWorkspaceSocket(laptop);
    await evictDurableObject(workspaceStub());
    expect(await socket.answers()).toBe(true);
    await signOut(laptop);
    expect(await socket.closed).toMatchObject({ code: CloseCode.Reconnect });
  });

  it("turns away a socket whose session ends while it's being checked", async () => {
    const laptop = await setUp();
    const credentials = await credentialsFor(laptop.cookie.split("=")[1]!, new Request(origin), env as unknown as Env);
    // The Workspace starts afresh, so the check has to read the session rather than remember it.
    await evictDurableObject(workspaceStub());
    const code = await runInDurableObject(workspaceStub(), async (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const findSession = store.findSession.bind(store);
      let read!: () => void;
      const reading = new Promise<void>((resolve) => (read = resolve));
      let answer!: () => void;
      const answering = new Promise<void>((resolve) => (answer = resolve));
      // The check reads the session, but its answer arrives only after a sign-out that started later,
      // as an answer from D1 can.
      vi.spyOn(store, "findSession").mockImplementationOnce(async (digest) => {
        const session = await findSession(digest);
        read();
        await answering;
        return session;
      });

      const opening = workspace.fetch(new Request(`${origin}/api/socket`, { headers: { Upgrade: "websocket", [CREDENTIALS_HEADER]: JSON.stringify(credentials) } }));
      await reading;
      await workspace.signOut(credentials.tokenDigest);
      answer();
      const ws = (await opening).webSocket!;
      const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
      ws.accept();
      return closed;
    });
    expect(code).toBe(CloseCode.Reconnect);
  });
});

describe("Live sidebar updates", () => {
  const sidebarOf = (session: Session, etag?: string) => api("/api/sidebar", { headers: { Cookie: session.cookie, ...(etag ? { "If-None-Match": etag } : {}) } });

  it("comes with an ETag, and answers 304 while the copy the app has is current", async () => {
    const grace = await signIn("Grace");
    const first = await sidebarOf(grace);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    const etag = first.headers.get("ETag")!;
    expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(((await first.json()) as Sidebar).rooms).toEqual([]);

    for (const current of [etag, `W/"stale", ${etag}`, "*"]) {
      const again = await sidebarOf(grace, current);
      expect(again.status, current).toBe(304);
      expect(again.headers.get("ETag")).toBe(etag);
      expect(await again.text()).toBe("");
    }

    const room = await createRoom("Design", { as: grace });
    const changed = await sidebarOf(grace, etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(etag);
    expect(((await changed.json()) as Sidebar).rooms).toEqual([listedRoom(room)]);
  });

  it("is only for someone signed in", async () => {
    expect((await api("/api/sidebar")).status).toBe(401);
    expect((await api("/api/sidebar", { headers: { "If-None-Match": "*" } })).status).toBe(401);
  });
});
