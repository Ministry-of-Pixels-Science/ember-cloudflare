import { CloseCode, type Account, type DirectoryUser, type Me, type SharedRoom, type Sidebar, type SidebarRoom, type WorkspaceClientFrame, type WorkspaceServerFrame } from "@ember/protocol";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AWAY_AFTER_MS } from "@/lib/presence";
import { RELOAD_AFTER_HIDDEN_MS, RELOAD_SPREAD_MS, useSidebar } from "./use-sidebar";

const ada: Me = { id: "u1", name: "Ada", administrator: false };
const grace: Me = { id: "u2", name: "Grace", administrator: true };
const design = { id: "r1", name: "Design", kind: "open", icon: null, unread: false, involvement: "mentions" } satisfies SidebarRoom;
/** When a message came that marks a room unread. */
const NOON = "2026-10-15T12:00:00.000Z";
const general = { id: "r2", name: "general", kind: "open", icon: null, unread: false, involvement: "mentions" } satisfies SidebarRoom;
/** Ada's sidebar with `rooms`, none of them starred. */
const unstarred = (rooms: SidebarRoom[]): Sidebar => ({ rooms, favorites: { rooms: [], version: 0 }, sharedOrder: [], invitation: null, huddles: {}, blocks: { userIds: [], version: 0 } });
const ember: Account = { name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true };
/** Someone as the directory lists them. */
const listed = (me: Me, role: DirectoryUser["role"]): DirectoryUser => ({ id: me.id, name: me.name, bio: null, role, status: "active", avatarUrl: `/users/${me.id}/avatar` });

/** Stands in for the browser's WebSocket; tests play the Workspace and the network. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  closedWith: number | undefined;
  /** The frames the hook has sent, in order. */
  sent: WorkspaceClientFrame[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as WorkspaceClientFrame);
  }

  /** What the tab has said of whether it's shown, in order. */
  get shown() {
    return this.sent.flatMap((frame) => (frame.type === "presence.visible" ? [frame.visible] : []));
  }

  close(code?: number) {
    this.closedWith = code;
    this.readyState = FakeSocket.CLOSED;
  }

  /** Opens, as the Workspace lets the socket in, before it says anything. */
  open() {
    act(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }

  /** Opens, and lets the socket in with a welcome for `you`, with the workspace as `account`. */
  connect(you = ada, account = ember) {
    this.open();
    this.receive({ type: "welcome", you, account });
  }

  receive(frame: WorkspaceServerFrame) {
    act(() => this.onmessage?.({ data: JSON.stringify(frame) }));
  }

  /** Closes as the network or the Workspace does: 1006 when the connection drops. */
  drop(code = 1006) {
    act(() => {
      this.readyState = FakeSocket.CLOSED;
      this.onclose?.({ code });
    });
  }
}

/**
 * Plays the server: Ada's sidebar, with an ETag that changes with it, and who the session signs in.
 * While `held`, answers for the sidebar wait for it.
 */
const server = {
  sidebar: unstarred([design]),
  version: 1,
  signedIn: ada as Me | null,
  held: null as Promise<void> | null,
  change(sidebar: Sidebar) {
    this.sidebar = sidebar;
    this.version++;
  },
};

async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = String(input);
  if (path === "/api/me") return server.signedIn ? Response.json({ user: server.signedIn }) : Response.json({ error: "Not signed in" }, { status: 401 });
  if (path !== "/api/sidebar") throw new Error(`No answer for ${path}`);
  await server.held;
  if (!server.signedIn) return Response.json({ error: "Not signed in" }, { status: 401 });
  const etag = `W/"${server.version}"`;
  if (new Headers(init?.headers).get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return Response.json(server.sidebar, { headers: { ETag: etag } });
}

/** Holds the server's answers for the sidebar until the function it returns is called. */
function holdAnswers() {
  let release!: () => void;
  server.held = new Promise((resolve) => (release = resolve));
  return () => act(async () => release());
}

/** The ETag each request for the sidebar named, null for none, in order. */
const sidebarRequests = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([input]) => String(input) === "/api/sidebar")
    .map(([, init]) => new Headers(init?.headers).get("If-None-Match"));

const socket = () => FakeSocket.all.at(-1)!;
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
/** Lets the requests under way be answered, and what they change render. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const visibility = (state: DocumentVisibilityState) =>
  act(() => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
    document.dispatchEvent(new Event("visibilitychange"));
  });

/** Ada's sidebar, loaded. */
async function showSidebar(onSessionChanged: (me: Me | null) => void = () => {}) {
  const hook = renderHook(() => useSidebar(ada, onSessionChanged));
  await settle();
  return hook;
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  Object.assign(server, { sidebar: unstarred([design]), version: 1, signedIn: ada, held: null });
  vi.stubGlobal("fetch", vi.fn(answer));
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter: back-off delays come out exact
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Live sidebar updates", () => {
  it("loads, and loads again each time the workspace socket connects, the first time included", async () => {
    const { result } = await showSidebar();
    expect(result.current.list).toEqual(unstarred([design]));
    expect(socket().url).toBe("ws://localhost:3000/api/socket?visible=1");

    server.change(unstarred([design, general]));
    socket().connect();
    await settle();
    expect(result.current.list?.rooms).toEqual([design, general]);

    server.change(unstarred([general]));
    socket().drop();
    await wait(500);
    socket().connect();
    await settle();
    expect(result.current.list?.rooms).toEqual([general]);
    expect(sidebarRequests()).toEqual([null, 'W/"1"', 'W/"2"']);
  });

  it("keeps the list it has while the server says it's current", async () => {
    const { result } = await showSidebar();
    const shown = result.current.list;
    socket().connect();
    await settle();
    expect(sidebarRequests()).toEqual([null, 'W/"1"']);
    expect(result.current.list).toBe(shown);
  });

  it("loads again once the tab is shown after more than a minute hidden", async () => {
    await showSidebar();
    await visibility("hidden");
    await wait(RELOAD_AFTER_HIDDEN_MS);
    await visibility("visible");
    await settle();
    expect(sidebarRequests()).toHaveLength(1);

    await visibility("hidden");
    await wait(RELOAD_AFTER_HIDDEN_MS + 1);
    await visibility("visible");
    await settle();
    expect(sidebarRequests()).toHaveLength(2);
  });

  it("counts a tab that loads hidden as hidden since it loaded", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await showSidebar();
    await wait(RELOAD_AFTER_HIDDEN_MS + 1);
    await visibility("visible");
    await settle();
    expect(sidebarRequests()).toHaveLength(2);
  });

  it("asks again once the list on its way comes, once however often it's asked for meanwhile", async () => {
    const { result } = await showSidebar();
    const release = holdAnswers();
    const asked = [result.current.refresh(), result.current.refresh(), result.current.refresh()];
    let settled = 0;
    asked.forEach((refresh) => void refresh.then(() => settled++));
    server.change(unstarred([design, general]));
    await release();
    await settle();
    expect(sidebarRequests()).toEqual([null, 'W/"1"', 'W/"2"']);
    expect(settled).toBe(3);
    expect(result.current.list?.rooms).toEqual([design, general]);
  });

  it("says each time it loads again by itself, for the people directory to load again too, failing or not", async () => {
    const onReload = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    const { result } = renderHook(() => useSidebar(ada, () => {}, { people: new Map(), reload: onReload, update: () => {}, remove: () => {} }));
    await settle();
    expect(onReload).toHaveBeenCalledOnce();
    socket().connect();
    await settle();
    expect(onReload).toHaveBeenCalledTimes(2);

    await visibility("hidden");
    await wait(RELOAD_AFTER_HIDDEN_MS + 1);
    await visibility("visible");
    expect(onReload).toHaveBeenCalledTimes(3);
    // Asked for, the list is about rooms only.
    await act(() => result.current.refresh());
    expect(onReload).toHaveBeenCalledTimes(3);
  });

  it("keeps a room saved here while a list is on its way that may not show it", async () => {
    const { result } = await showSidebar();
    const release = holdAnswers();
    socket().connect();
    act(() => result.current.change({ type: "saved", room: general }));
    await release();
    await settle();
    expect(result.current.list?.rooms).toEqual([design, general]);
  });

  it("adds the rooms the workspace socket brings as they're saved, and changes the ones it has, keeping their marks and levels", async () => {
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    socket().receive({ type: "room.saved", room: { id: general.id, name: "general", kind: "open", icon: null } });
    expect(result.current.list?.rooms).toEqual([design, general]);

    socket().receive({ type: "room.unread", roomId: design.id, at: NOON });
    socket().receive({ type: "room.involvement", roomId: design.id, involvement: "nothing" });
    socket().receive({ type: "room.saved", room: { id: design.id, name: "Roadmap", kind: "closed", icon: "rocket" } });
    expect(result.current.list?.rooms).toEqual([{ id: design.id, name: "Roadmap", kind: "closed", icon: "rocket", unread: true, unreadSince: NOON, involvement: "nothing" }, general]);
  });

  it("takes out each room the workspace socket says is gone, saying which", async () => {
    const onGone = vi.fn();
    server.change(unstarred([design, general]));
    const { result } = renderHook(() => useSidebar(ada, () => {}, undefined, undefined, onGone));
    await settle();
    socket().connect();
    await settle();
    socket().receive({ type: "room.gone", roomId: design.id });
    expect(result.current.list?.rooms).toEqual([general]);
    expect(onGone).toHaveBeenCalledExactlyOnceWith(design.id);
  });

  it("lists a room as the server answers a change to it, unless the workspace socket has said what became of it since", async () => {
    server.change(unstarred([design, general]));
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    const names = () => result.current.list?.rooms.map((room) => (room.kind === "direct" ? null : room.name));
    const named = (room: SharedRoom, name: string): SharedRoom => ({ id: room.id, name, kind: room.kind, icon: room.icon });

    // Ada renames Design, and the socket brings a rename saved in another tab just after, before her answer.
    const renamed = result.current.askForRoom();
    socket().receive({ type: "room.saved", room: named(design, "Roadmap") });
    act(() => renamed({ type: "saved", room: named(design, "Plans") }));
    expect(names()).toEqual(["Roadmap", "general"]);

    // She saves general, which is deleted before her answer comes.
    const saved = result.current.askForRoom();
    socket().receive({ type: "room.gone", roomId: general.id });
    act(() => saved({ type: "saved", room: named(general, "general") }));
    expect(names()).toEqual(["Roadmap"]);

    // She leaves Design, and is put back in it before her answer comes.
    const left = result.current.askForRoom();
    socket().receive({ type: "room.saved", room: named(design, "Roadmap") });
    act(() => left({ type: "gone", roomId: design.id }));
    expect(names()).toEqual(["Roadmap"]);

    // What the socket says of another room leaves an answer to take its place.
    const answered = result.current.askForRoom();
    socket().receive({ type: "room.saved", room: named(general, "general") });
    act(() => answered({ type: "saved", room: named(design, "Plans") }));
    expect(names()).toEqual(["Plans", "general"]);
  });

  it("keeps a room gone that a list on its way may still show", async () => {
    const { result } = await showSidebar();
    const release = holdAnswers();
    socket().connect();
    socket().receive({ type: "room.gone", roomId: design.id });
    await release();
    await settle();
    expect(result.current.list?.rooms).toEqual([]);
  });

  it("asks again at once after a list that may have a room in the wrong place, one Ada was taken out of and put back in while it was on its way", async () => {
    const { result } = await showSidebar();
    const release = holdAnswers();
    socket().connect();
    // She's taken out of Design and put back in it, then put in general, all before the server reads her list.
    socket().receive({ type: "room.gone", roomId: design.id });
    socket().receive({ type: "room.saved", room: { id: design.id, name: "Design", kind: "open", icon: null } });
    socket().receive({ type: "room.saved", room: { id: general.id, name: "general", kind: "open", icon: null } });
    server.change(unstarred([design, general]));
    await release();
    await settle();
    expect(sidebarRequests()).toEqual([null, 'W/"1"', 'W/"2"']);
    expect(result.current.list?.rooms).toEqual([design, general]);
  });
});

describe("Unread rooms", () => {
  it("marks rooms unread and read as the workspace socket says", async () => {
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    socket().receive({ type: "room.unread", roomId: design.id, at: NOON });
    expect(result.current.list?.rooms).toEqual([{ ...design, unread: true, unreadSince: NOON }]);
    socket().receive({ type: "room.read", roomId: design.id });
    expect(result.current.list?.rooms).toEqual([design]);
  });

  it("keeps a mark that comes while a list is on its way that may not show it", async () => {
    const { result } = await showSidebar();
    const release = holdAnswers();
    socket().connect();
    socket().receive({ type: "room.unread", roomId: design.id, at: NOON });
    await release();
    await settle();
    expect(result.current.list?.rooms).toEqual([{ ...design, unread: true, unreadSince: NOON }]);
  });

  it("counts the messages that have come in a DM since it was marked unread, as the workspace socket says, until it's read", async () => {
    const withGrace = { id: "d1", kind: "direct", members: [ada, grace].map(({ id, name }) => ({ id, name })), activeAt: NOON, unread: false, involvement: "everything" } satisfies SidebarRoom;
    server.sidebar = unstarred([withGrace]);
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    socket().receive({ type: "room.unread", roomId: withGrace.id, at: NOON, count: 1 });
    socket().receive({ type: "room.unread", roomId: withGrace.id, at: NOON, count: 2 });
    expect(result.current.list?.rooms).toEqual([{ ...withGrace, unread: true, unreadSince: NOON, unreadCount: 2 }]);
    socket().receive({ type: "room.read", roomId: withGrace.id });
    expect(result.current.list?.rooms).toEqual([withGrace]);
  });
});

describe("Notification levels", () => {
  it("changes a room's level as the workspace socket says one of Ada's tabs saved it", async () => {
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    socket().receive({ type: "room.involvement", roomId: design.id, involvement: "invisible" });
    expect(result.current.list?.rooms).toEqual([{ ...design, involvement: "invisible" }]);
    socket().receive({ type: "room.involvement", roomId: design.id, involvement: "everything" });
    expect(result.current.list?.rooms).toEqual([{ ...design, involvement: "everything" }]);
  });

  it("gives a room the level the server answers, unless the workspace socket has said what became of it since", async () => {
    server.change(unstarred([design, general]));
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    const levels = () => result.current.list?.rooms.map((room) => room.involvement);

    // Ada's bell saves all messages in Design, and the socket brings her turning it off in another tab
    // just after, before her answer.
    const involved = result.current.askForRoom();
    socket().receive({ type: "room.involvement", roomId: design.id, involvement: "nothing" });
    act(() => involved({ type: "involved", roomId: design.id, involvement: "everything" }));
    expect(levels()).toEqual(["nothing", "mentions"]);

    // What the socket says of another room leaves an answer to take its place.
    const answered = result.current.askForRoom();
    socket().receive({ type: "room.involvement", roomId: design.id, involvement: "invisible" });
    act(() => answered({ type: "involved", roomId: general.id, involvement: "everything" }));
    expect(levels()).toEqual(["invisible", "everything"]);
  });
});

describe("DM order", () => {
  const withGrace = { id: "d1", kind: "direct", members: [ada, { id: grace.id, name: grace.name }], activeAt: "2026-10-15T12:00:00.000Z", unread: false, involvement: "everything" } satisfies SidebarRoom;

  it("moves a DM as the workspace socket says a message came in it", async () => {
    server.sidebar = unstarred([design, withGrace]);
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    socket().receive({ type: "room.active", roomId: withGrace.id, at: "2026-10-15T12:05:00.000Z" });
    expect(result.current.list?.rooms).toEqual([design, { ...withGrace, activeAt: "2026-10-15T12:05:00.000Z" }]);
  });

  it("keeps a message that comes while a list is on its way that may not show it", async () => {
    server.sidebar = unstarred([design, withGrace]);
    const { result } = await showSidebar();
    const release = holdAnswers();
    socket().connect();
    socket().receive({ type: "room.active", roomId: withGrace.id, at: "2026-10-15T12:05:00.000Z" });
    await release();
    await settle();
    expect(result.current.list?.rooms).toEqual([design, { ...withGrace, activeAt: "2026-10-15T12:05:00.000Z" }]);
  });
});

describe("Who's active", () => {
  /** What the hook has said of whether the tab is in use, on the latest socket. */
  const saidInUse = () => socket().sent.flatMap((frame) => (frame.type === "presence.active" ? [frame.active] : []));

  /** Lets `ms` go by without the tab being used, the Workspace answering the socket's pings meanwhile, as it does. */
  async function unusedFor(ms: number) {
    for (let left = ms; left > 0; left -= 20_000) {
      await wait(Math.min(left, 20_000));
      socket().receive({ type: "pong" });
    }
  }

  it("says whether the tab is in use once the Workspace lets its socket in, and again whenever that changes", async () => {
    await showSidebar();
    socket().open();
    expect(saidInUse()).toEqual([]);
    socket().receive({ type: "welcome", you: ada, account: ember });
    expect(saidInUse()).toEqual([true]);

    await unusedFor(AWAY_AFTER_MS);
    expect(saidInUse()).toEqual([true, false]);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown")));
    expect(saidInUse()).toEqual([true, false, true]);
  });

  it("says it again as the next connection is let in, as the tab is then", async () => {
    await showSidebar();
    socket().connect();
    await unusedFor(AWAY_AFTER_MS);
    socket().drop();
    await wait(60_000);
    socket().connect();
    expect(saidInUse()).toEqual([false]);
  });

  it("knows who's active from the first frame since the socket connected, then from the changes the frames after it tell of", async () => {
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    const active = () => result.current.active.current();
    expect(active()).toBeNull();
    socket().receive({ type: "presence", active: [ada.id, grace.id], away: [] });
    expect(active()).toEqual(new Set([ada.id, grace.id]));
    socket().receive({ type: "presence", active: ["u3"], away: [grace.id] });
    expect(active()).toEqual(new Set([ada.id, "u3"]));

    // The next connection's first frame says who's active then, whoever was before.
    socket().drop();
    await wait(60_000);
    socket().connect();
    socket().receive({ type: "presence", active: [grace.id], away: [] });
    expect(active()).toEqual(new Set([grace.id]));
  });
});

describe("Huddles in your rooms", () => {
  const huddle = { startedAt: "2026-10-15T12:00:00.000Z", userIds: [grace.id] };

  it("keeps who's in a room's huddle as the workspace socket says people join and leave it", async () => {
    server.sidebar = { ...unstarred([design, general]), huddles: { [design.id]: huddle } };
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    expect(result.current.list?.huddles).toEqual({ [design.id]: huddle });

    socket().receive({ type: "room.huddle", roomId: general.id, huddle: { ...huddle, userIds: [ada.id] } });
    socket().receive({ type: "room.huddle", roomId: design.id, huddle: { ...huddle, userIds: [grace.id, ada.id] } });
    expect(result.current.list?.huddles).toEqual({ [design.id]: { ...huddle, userIds: [grace.id, ada.id] }, [general.id]: { ...huddle, userIds: [ada.id] } });
    socket().receive({ type: "room.huddle", roomId: design.id, huddle: null });
    expect(result.current.list?.huddles).toEqual({ [general.id]: { ...huddle, userIds: [ada.id] } });
  });

  it("tells of each invitation into a huddle the workspace socket brings, when it came, and of each that's answered", async () => {
    const onInvitation = vi.fn();
    const { result } = renderHook(() => useSidebar(ada, () => {}, undefined, undefined, undefined, onInvitation));
    await settle();
    socket().connect();
    await settle();
    const shown = result.current.list;

    vi.setSystemTime("2026-11-16T09:00:00.000Z");
    socket().receive({ type: "huddle.invited", roomId: "direct-1", by: grace.id });
    expect(onInvitation).toHaveBeenCalledExactlyOnceWith({ type: "invited", roomId: "direct-1", by: grace.id, at: Date.parse("2026-11-16T09:00:00.000Z") });
    socket().receive({ type: "huddle.answered", roomId: "direct-1" });
    expect(onInvitation).toHaveBeenLastCalledWith({ type: "over", roomId: "direct-1" });
    expect(onInvitation).toHaveBeenCalledTimes(2);
    // Neither changes the rooms listed.
    expect(result.current.list).toBe(shown);
  });

  it("tells that an invitation into a room's huddle is over once the workspace socket says the room is gone, a room it never listed too", async () => {
    const onInvitation = vi.fn();
    server.change(unstarred([design]));
    renderHook(() => useSidebar(ada, () => {}, undefined, undefined, undefined, onInvitation));
    await settle();
    socket().connect();
    await settle();

    socket().receive({ type: "room.gone", roomId: design.id });
    expect(onInvitation).toHaveBeenCalledExactlyOnceWith({ type: "over", roomId: design.id });
    socket().receive({ type: "room.gone", roomId: "direct-1" });
    expect(onInvitation).toHaveBeenLastCalledWith({ type: "over", roomId: "direct-1" });
    expect(onInvitation).toHaveBeenCalledTimes(2);
  });

  // The Workspace pushes an invitation to whoever has Ember in view nowhere, which it knows from their tabs.
  it("tells the Workspace whether the tab is shown as it connects", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await showSidebar();
    expect(socket().url).toBe("ws://localhost:3000/api/socket?visible=0");
    socket().connect();
    expect(socket().shown).toEqual([]);
  });

  it("tells the Workspace as soon as the tab is hidden, and as soon as it's shown again, once each", async () => {
    await showSidebar();
    socket().connect();
    expect(socket().shown).toEqual([]);
    await visibility("hidden");
    expect(socket().shown).toEqual([false]);
    await visibility("hidden");
    expect(socket().shown).toEqual([false]);

    await visibility("visible");
    expect(socket().shown).toEqual([false, true]);
    await visibility("visible");
    expect(socket().shown).toEqual([false, true]);
  });

  it("tells a Workspace it was connecting to once it lets the socket in, unless the socket's address said so", async () => {
    await showSidebar();
    socket().connect();
    socket().drop();
    await wait(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(socket().url).toMatch(/visible=1$/);
    // The tab is hidden while it connects again.
    await visibility("hidden");
    socket().open();
    expect(socket().shown).toEqual([]);
    socket().receive({ type: "welcome", you: ada, account: ember });
    expect(socket().shown).toEqual([false]);

    socket().drop();
    await wait(1_000);
    expect(socket().url).toMatch(/visible=0$/);
    socket().connect();
    expect(socket().shown).toEqual([]);
  });

  it("stops following the tab once it's gone", async () => {
    const [added, removed] = [vi.spyOn(document, "addEventListener"), vi.spyOn(document, "removeEventListener")];
    const following = (calls: unknown[][]) => calls.filter(([type]) => type === "visibilitychange").length;
    const { unmount } = await showSidebar();
    socket().connect();
    expect(following(added.mock.calls)).toBeGreaterThan(0);
    unmount();
    expect(following(removed.mock.calls)).toBe(following(added.mock.calls));
  });
});

describe("Huddle sounds, which each person turns on or off for themselves", () => {
  const EVERY_SOUND = { music: true, chimes: true, ring: true };
  const NO_MUSIC = { ...EVERY_SOUND, music: false };
  const NO_RING = { ...EVERY_SOUND, ring: false };

  it("keeps which of a huddle's sounds Ada hears as the workspace socket says one of her tabs saved them, even over a list on its way", async () => {
    server.change({ ...unstarred([design]), huddleSounds: NO_MUSIC });
    const { result } = await showSidebar();
    expect(result.current.list?.huddleSounds).toEqual(NO_MUSIC);
    const release = holdAnswers();
    socket().connect();
    socket().receive({ type: "huddle.sounds", sounds: NO_RING });
    expect(result.current.list?.huddleSounds).toEqual(NO_RING);
    await release();
    await settle();
    expect(result.current.list?.huddleSounds).toEqual(NO_RING);

    // Once she hears them all again, the list says nothing of them, as the server's doesn't.
    socket().receive({ type: "huddle.sounds", sounds: EVERY_SOUND });
    expect(result.current.list).not.toHaveProperty("huddleSounds");
    expect(result.current.list?.rooms).toEqual([design]);
  });

  it("keeps the sounds the server answers a switch with, unless the workspace socket has said which she hears since", async () => {
    const { result } = await showSidebar();
    socket().connect();
    await settle();

    // Ada turns the music off, and her answer comes before the socket's word of it.
    const saved = result.current.askForHuddleSounds();
    act(() => saved(NO_MUSIC));
    expect(result.current.list?.huddleSounds).toEqual(NO_MUSIC);
    socket().receive({ type: "huddle.sounds", sounds: NO_MUSIC });
    expect(result.current.list?.huddleSounds).toEqual(NO_MUSIC);

    // She turns the ring off, and the socket brings that, then the music turned back on in another tab just after, before her answer.
    const answered = result.current.askForHuddleSounds();
    socket().receive({ type: "huddle.sounds", sounds: { ...NO_MUSIC, ring: false } });
    socket().receive({ type: "huddle.sounds", sounds: NO_RING });
    act(() => answered({ ...NO_MUSIC, ring: false }));
    expect(result.current.list?.huddleSounds).toEqual(NO_RING);

    // What the socket says of anything else leaves an answer to take its place.
    const later = result.current.askForHuddleSounds();
    socket().receive({ type: "room.unread", roomId: design.id, at: NOON });
    act(() => later(EVERY_SOUND));
    expect(result.current.list).not.toHaveProperty("huddleSounds");
  });
});

describe("The huddles that are over, which the Huddles page lists", () => {
  it("counts a change each time the workspace socket says they've changed, and at nothing else it says", async () => {
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    const before = result.current.huddleChanges;
    socket().receive({ type: "huddles.changed" });
    expect(result.current.huddleChanges).toBe(before + 1);
    socket().receive({ type: "huddles.changed" });
    expect(result.current.huddleChanges).toBe(before + 2);

    socket().receive({ type: "room.unread", roomId: design.id, at: NOON });
    // Nor at a huddle starting or ending, which says so of its room's own.
    socket().receive({ type: "room.huddle", roomId: design.id, huddle: { startedAt: NOON, userIds: [grace.id] } });
    expect(result.current.list?.huddles).toEqual({ [design.id]: { startedAt: NOON, userIds: [grace.id] } });
    socket().receive({ type: "room.huddle", roomId: design.id, huddle: null });
    expect(result.current.huddleChanges).toBe(before + 2);
    // The page asks for them itself: the sidebar's list isn't loaded again for it, however long that's waited for.
    await wait(RELOAD_SPREAD_MS);
    await settle();
    expect(sidebarRequests()).toHaveLength(2);
  });

  it("counts one each time it loads everything again, as they may have changed unheard: as its socket connects, the first time included, and once the tab is shown after more than a minute hidden", async () => {
    const { result } = await showSidebar();
    const atFirst = result.current.huddleChanges;
    socket().connect();
    await settle();
    expect(result.current.huddleChanges).toBe(atFirst + 1);

    socket().drop();
    await wait(500);
    socket().connect();
    await settle();
    expect(result.current.huddleChanges).toBe(atFirst + 2);

    await visibility("hidden");
    await wait(RELOAD_AFTER_HIDDEN_MS + 1);
    await visibility("visible");
    await settle();
    expect(result.current.huddleChanges).toBe(atFirst + 3);
    // A shorter while hidden loads nothing again, so counts nothing.
    await visibility("hidden");
    await wait(RELOAD_AFTER_HIDDEN_MS);
    await visibility("visible");
    await settle();
    expect(result.current.huddleChanges).toBe(atFirst + 3);
  });
});

describe("Make or revoke administrators", () => {
  /** Ada's sidebar, connected, telling `onSessionChanged` and the directory's `reload`, `update` and `remove`. */
  async function connected() {
    const [onSessionChanged, update, remove] = [vi.fn(), vi.fn(), vi.fn()];
    const reload = vi.fn(async () => {});
    renderHook(() => useSidebar(ada, onSessionChanged, { people: new Map(), reload, update, remove }));
    await settle();
    socket().connect();
    await settle();
    return { onSessionChanged, reload, update, remove };
  }

  it("changes whoever the workspace socket says has changed in the people directory", async () => {
    const { onSessionChanged, update } = await connected();
    const promoted = listed(grace, "administrator");
    socket().receive({ type: "user.updated", user: promoted });
    expect(update).toHaveBeenCalledWith(promoted);
    expect(onSessionChanged).not.toHaveBeenCalled();
  });

  it("takes out of the people directory whoever the workspace socket says this person is no longer told of", async () => {
    const { update, remove } = await connected();
    socket().receive({ type: "user.gone", userId: grace.id });
    expect(remove).toHaveBeenCalledExactlyOnceWith(grace.id);
    expect(update).not.toHaveBeenCalled();
    expect(sidebarRequests()).toHaveLength(2);
  });

  it("loads the people directory again once the person signed in is given another role, which decides who it lists them", async () => {
    const { reload } = await connected();
    expect(reload).toHaveBeenCalledTimes(2);
    socket().receive({ type: "user.updated", user: listed(ada, "administrator") });
    expect(reload).toHaveBeenCalledTimes(3);
    socket().receive({ type: "user.updated", user: listed(ada, "member") });
    expect(reload).toHaveBeenCalledTimes(4);

    // But not for anything else about them, nor for someone else's role.
    socket().receive({ type: "user.updated", user: { ...listed(ada, "member"), bio: "Poet of science" } });
    socket().receive({ type: "user.updated", user: listed(grace, "administrator") });
    expect(reload).toHaveBeenCalledTimes(4);
  });

  it("says when the person signed in has been made an administrator, or a member again", async () => {
    const { onSessionChanged, update } = await connected();
    socket().receive({ type: "user.updated", user: listed(ada, "administrator") });
    expect(update).toHaveBeenCalledWith(listed(ada, "administrator"));
    expect(onSessionChanged).toHaveBeenLastCalledWith({ ...ada, administrator: true });

    // The hook still has Ada as a member, as the page would if this came before it took the change.
    socket().receive({ type: "user.updated", user: listed(ada, "member") });
    expect(onSessionChanged).toHaveBeenLastCalledWith(ada);

    // Then nothing more for word that she's as she was last heard.
    socket().receive({ type: "user.updated", user: listed(ada, "member") });
    expect(onSessionChanged).toHaveBeenCalledTimes(2);
  });

  it("takes a change heard before the welcome over the welcome, which may be older, until it connects again", async () => {
    const [onSessionChanged, update] = [vi.fn(), vi.fn()];
    renderHook(() => useSidebar(ada, onSessionChanged, { people: new Map(), reload: async () => {}, update, remove: () => {} }));
    await settle();
    socket().open();
    socket().receive({ type: "user.updated", user: listed(ada, "administrator") });
    socket().receive({ type: "welcome", you: ada, account: ember });
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
    expect(onSessionChanged).toHaveBeenLastCalledWith({ ...ada, administrator: true });

    // The page still has Ada as a member, but she's an administrator as far as this hook has heard.
    socket().drop();
    await wait(60_000);
    socket().connect(ada);
    expect(onSessionChanged).toHaveBeenLastCalledWith(ada);
  });

  it("takes the next connection's welcome again after one that stopped answering", async () => {
    const [onSessionChanged, update] = [vi.fn(), vi.fn()];
    renderHook(() => useSidebar(ada, onSessionChanged, { people: new Map(), reload: async () => {}, update, remove: () => {} }));
    await settle();
    socket().open();
    socket().receive({ type: "user.updated", user: listed(ada, "administrator") });
    socket().receive({ type: "welcome", you: ada, account: ember });
    const silent = socket();

    // Two heartbeats without a word drop the socket without its closing, and the next one connects.
    await wait(60_000);
    expect(socket()).not.toBe(silent);
    socket().connect(ada);
    expect(onSessionChanged).toHaveBeenLastCalledWith(ada);
  });

  it("says when the welcome finds the person signed in has changed since the page loaded", async () => {
    const onSessionChanged = vi.fn();
    await showSidebar(onSessionChanged);
    socket().connect({ ...ada, administrator: true });
    expect(onSessionChanged).toHaveBeenCalledWith({ ...ada, administrator: true });
    expect(socket().closedWith).toBeUndefined();
    await settle();
    expect(sidebarRequests()).toHaveLength(2);
  });

  it("says nothing when the welcome finds them as they were", async () => {
    const onSessionChanged = vi.fn();
    await showSidebar(onSessionChanged);
    socket().connect();
    expect(onSessionChanged).not.toHaveBeenCalled();
  });
});

describe("Star rooms", () => {
  it("takes the stars saved in any of Ada's tabs from the workspace socket, keeping the newest", async () => {
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    socket().receive({ type: "favorites.changed", favorites: { rooms: [design.id], version: 2 } });
    expect(result.current.list?.favorites).toEqual({ rooms: [design.id], version: 2 });
    socket().receive({ type: "favorites.changed", favorites: { rooms: [], version: 1 } });
    expect(result.current.list?.favorites).toEqual({ rooms: [design.id], version: 2 });
  });

  it("keeps stars that come while a list is on its way over the older ones it brings", async () => {
    const { result } = await showSidebar();
    const release = holdAnswers();
    socket().connect();
    socket().receive({ type: "favorites.changed", favorites: { rooms: [design.id], version: 1 } });
    await release();
    await settle();
    expect(result.current.list?.favorites).toEqual({ rooms: [design.id], version: 1 });
  });
});

describe("Block someone", () => {
  it("takes the blocks made in any of Ada's tabs from the workspace socket, keeping the newest", async () => {
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    socket().receive({ type: "blocks.changed", blocks: { userIds: ["u2"], version: 2 } });
    expect(result.current.list?.blocks).toEqual({ userIds: ["u2"], version: 2 });
    socket().receive({ type: "blocks.changed", blocks: { userIds: [], version: 1 } });
    expect(result.current.list?.blocks).toEqual({ userIds: ["u2"], version: 2 });
  });
});

describe("Reports", () => {
  it("counts an administrator's open reports as the workspace socket says, made or handled in any tab", async () => {
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    socket().receive({ type: "reports.changed", open: 3 });
    expect(result.current.list?.openReports).toBe(3);
    socket().receive({ type: "reports.changed", open: 0 });
    expect(result.current.list?.openReports).toBe(0);
  });

  it("counts the times the count comes, with a list or from the socket, though it's the same, for the Reports list to load again", async () => {
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    const heard = result.current.reportsHeard;
    socket().receive({ type: "reports.changed", open: 3 });
    socket().receive({ type: "reports.changed", open: 3 });
    expect(result.current.reportsHeard).toBe(heard + 2);
    // A list loaded once the socket connects again, as the server says the one it has is current, though
    // reports may have been made and handled while it wasn't connected.
    socket().drop();
    await wait(500);
    socket().connect();
    await settle();
    expect(result.current.reportsHeard).toBe(heard + 3);
  });
});

describe("Welcome card for administrators, until they dismiss it", () => {
  const invited: Sidebar = { ...unstarred([general]), invitation: { roomId: general.id, joinCode: "aB3d-Ef5h-iJ7k" } };

  it("takes the welcome card away as the workspace socket says one of Ada's tabs dismissed it, even from a list on its way", async () => {
    server.change(invited);
    const { result } = await showSidebar();
    expect(result.current.list?.invitation).toEqual(invited.invitation);
    const release = holdAnswers();
    socket().connect();
    socket().receive({ type: "invitation.dismissed" });
    expect(result.current.list?.invitation).toBeNull();
    await release();
    await settle();
    expect(result.current.list?.invitation).toBeNull();
    expect(result.current.list?.rooms).toEqual([general]);
  });

  it("loads Ada's rooms again once the workspace socket says she's an administrator, or a member again, for the card that comes and goes with it", async () => {
    const { result } = await showSidebar();
    socket().connect();
    await settle();
    expect(sidebarRequests()).toHaveLength(2);

    server.change(invited);
    socket().receive({ type: "user.updated", user: listed(ada, "administrator") });
    await settle();
    expect(sidebarRequests()).toHaveLength(3);
    expect(result.current.list?.invitation).toEqual(invited.invitation);

    server.change(unstarred([general]));
    socket().receive({ type: "user.updated", user: listed(ada, "member") });
    await settle();
    expect(sidebarRequests()).toHaveLength(4);
    expect(result.current.list?.invitation).toBeNull();
  });

  it("doesn't load them again for anything else about Ada, or for someone else's role", async () => {
    await showSidebar();
    socket().connect();
    await settle();
    socket().receive({ type: "user.updated", user: { ...listed(ada, "member"), bio: "Poet of science" } });
    socket().receive({ type: "user.updated", user: listed(grace, "member") });
    await settle();
    expect(sidebarRequests()).toHaveLength(2);
  });
});

describe("Shared room order", () => {
  it("loads its rooms again a while after the workspace socket says the shared order changed, once for the news that comes meanwhile", async () => {
    const onReload = vi.fn(async () => {});
    const { result } = renderHook(() => useSidebar(ada, () => {}, { people: new Map(), reload: onReload, update: () => {}, remove: () => {} }));
    socket().connect();
    await settle();
    expect(sidebarRequests()).toHaveLength(2);

    server.change({ ...unstarred([design, general]), sharedOrder: [general.id, design.id] });
    socket().receive({ type: "rooms.reordered" });
    // Math.random says halfway.
    await wait(RELOAD_SPREAD_MS / 2 - 1);
    socket().receive({ type: "rooms.reordered" });
    await settle();
    expect(sidebarRequests()).toHaveLength(2);
    await wait(1);
    await settle();
    expect(sidebarRequests()).toHaveLength(3);
    expect(result.current.list?.sharedOrder).toEqual([general.id, design.id]);
    // The people haven't changed.
    expect(onReload).toHaveBeenCalledTimes(2);

    await wait(RELOAD_SPREAD_MS);
    await settle();
    expect(sidebarRequests()).toHaveLength(3);
  });

  it("spreads the tabs' loads over a few seconds at random", async () => {
    await showSidebar();
    socket().connect();
    await settle();
    vi.mocked(Math.random).mockReturnValue(0.999);
    socket().receive({ type: "rooms.reordered" });
    await wait(0.999 * RELOAD_SPREAD_MS - 1);
    await settle();
    expect(sidebarRequests()).toHaveLength(2);
    await wait(1);
    await settle();
    expect(sidebarRequests()).toHaveLength(3);
  });

  it("doesn't wait to load what the socket's next welcome loads anyway", async () => {
    await showSidebar();
    socket().connect();
    await settle();
    socket().receive({ type: "rooms.reordered" });
    socket().drop();
    await wait(500);
    socket().connect();
    await settle();
    expect(sidebarRequests()).toHaveLength(3);
    await wait(RELOAD_SPREAD_MS);
    await settle();
    expect(sidebarRequests()).toHaveLength(3);
  });

  it("loads nothing once the tab is gone", async () => {
    const { unmount } = await showSidebar();
    socket().connect();
    await settle();
    socket().receive({ type: "rooms.reordered" });
    unmount();
    await wait(RELOAD_SPREAD_MS);
    await settle();
    expect(sidebarRequests()).toHaveLength(2);
  });
});

describe("People", () => {
  const hedy: Me = { id: "u3", name: "Hedy", administrator: false };
  /** A people directory that lists Hedy as `status`. */
  const listingHedy = (status: DirectoryUser["status"]) => ({ people: new Map([[hedy.id, { ...listed(hedy, "member"), status }]]), reload: async () => {}, update: () => {}, remove: () => {} });

  it("doesn't load its rooms again for someone new, someone back, or someone changing, since it lists only DMs someone is in", async () => {
    renderHook(() => useSidebar(ada, () => {}, listingHedy("suspended")));
    socket().connect();
    await settle();
    socket().receive({ type: "user.updated", user: listed(grace, "member") });
    socket().receive({ type: "user.updated", user: listed(hedy, "member") });
    socket().receive({ type: "user.updated", user: { ...listed(hedy, "member"), bio: "Inventor" } });
    socket().receive({ type: "user.updated", user: { ...listed(hedy, "member"), status: "banned" } });
    await wait(RELOAD_SPREAD_MS);
    await settle();
    expect(sidebarRequests()).toHaveLength(2);
  });
});

describe("One live connection per tab outside the open room", () => {
  it("hands the tab over to whoever its socket's welcome says the session signs in", async () => {
    const onSessionChanged = vi.fn();
    await showSidebar(onSessionChanged);
    socket().connect(grace);
    expect(onSessionChanged).toHaveBeenCalledWith(grace);
    expect(socket().closedWith).toBe(1000);
    await settle();
    expect(sidebarRequests()).toHaveLength(1);
  });

  it("goes to sign in when the session has expired, found when the Workspace says to reconnect", async () => {
    const onSessionChanged = vi.fn();
    await showSidebar(onSessionChanged);
    socket().connect();
    server.signedIn = null;
    socket().drop(CloseCode.Reconnect);
    await settle();
    expect(onSessionChanged).toHaveBeenCalledWith(null);
  });

  it("asks whether the session has expired when the socket is refused, and connects again while it hasn't", async () => {
    const onSessionChanged = vi.fn();
    await showSidebar(onSessionChanged);
    socket().drop();
    await settle();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/me", expect.anything());
    expect(onSessionChanged).not.toHaveBeenCalled();
    await wait(500);
    expect(FakeSocket.all).toHaveLength(2);

    server.signedIn = null;
    socket().drop();
    await settle();
    expect(onSessionChanged).toHaveBeenCalledWith(null);
  });

  it("goes to sign in when the sidebar is refused for an expired session", async () => {
    server.signedIn = null;
    const onSessionChanged = vi.fn();
    await showSidebar(onSessionChanged);
    expect(onSessionChanged).toHaveBeenCalledWith(null);
  });

  it("closes its socket, and stops listening for the tab, once it's gone", async () => {
    const { unmount } = await showSidebar();
    unmount();
    expect(socket().closedWith).toBe(1000);
    await visibility("hidden");
    await wait(RELOAD_AFTER_HIDDEN_MS + 1);
    await visibility("visible");
    await settle();
    expect(sidebarRequests()).toHaveLength(1);
  });
});

describe("Remove someone from the workspace", () => {
  it("goes to sign in, connecting no more, once the person is removed, which ends their sessions and closes the socket for good", async () => {
    const onSessionChanged = vi.fn();
    await showSidebar(onSessionChanged);
    socket().connect();
    await settle();
    server.signedIn = null;
    socket().drop(CloseCode.Revoked);
    await settle();
    expect(onSessionChanged).toHaveBeenCalledExactlyOnceWith(null);
    await wait(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("connects again while the browser is still signed in as them, as when the removal didn't save", async () => {
    const onSessionChanged = vi.fn();
    await showSidebar(onSessionChanged);
    socket().connect();
    await settle();
    socket().drop(CloseCode.Revoked);
    await settle();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/me", expect.anything());
    expect(FakeSocket.all).toHaveLength(1);
    await wait(500);
    expect(FakeSocket.all).toHaveLength(2);
    expect(onSessionChanged).not.toHaveBeenCalled();
  });

  it("hands the tab over to whoever the browser is signed in as now", async () => {
    const onSessionChanged = vi.fn();
    await showSidebar(onSessionChanged);
    socket().connect();
    await settle();
    server.signedIn = grace;
    socket().drop(CloseCode.Revoked);
    await settle();
    expect(onSessionChanged).toHaveBeenCalledExactlyOnceWith(grace);
  });
});

describe("Custom CSS", () => {
  it("says what the workspace is each time its socket connects, and whenever an administrator changes it", async () => {
    const onAccountChanged = vi.fn();
    renderHook(() => useSidebar(ada, () => {}, undefined, onAccountChanged));
    await settle();
    const styled = { ...ember, customStyles: "body { color: red; }" };
    socket().connect(ada, styled);
    expect(onAccountChanged).toHaveBeenLastCalledWith(styled);
    socket().receive({ type: "account.updated", account: { ...styled, hideTranslationButtons: false } });
    expect(onAccountChanged).toHaveBeenLastCalledWith({ ...styled, hideTranslationButtons: false });
  });

  it("takes a change heard before the welcome over the welcome's workspace, which may be older, until it connects again", async () => {
    const onAccountChanged = vi.fn();
    renderHook(() => useSidebar(ada, () => {}, undefined, onAccountChanged));
    await settle();
    const styled = { ...ember, customStyles: "body { color: red; }" };
    socket().open();
    socket().receive({ type: "account.updated", account: styled });
    socket().receive({ type: "welcome", you: ada, account: ember });
    expect(onAccountChanged).toHaveBeenCalledTimes(1);
    expect(onAccountChanged).toHaveBeenLastCalledWith(styled);

    socket().drop();
    await wait(60_000);
    socket().connect(ada, ember);
    expect(onAccountChanged).toHaveBeenLastCalledWith(ember);
  });

  it("takes the next connection's welcome workspace again after one that stopped answering", async () => {
    const onAccountChanged = vi.fn();
    renderHook(() => useSidebar(ada, () => {}, undefined, onAccountChanged));
    await settle();
    socket().open();
    socket().receive({ type: "account.updated", account: { ...ember, customStyles: "body { color: red; }" } });
    socket().receive({ type: "welcome", you: ada, account: ember });
    const silent = socket();

    // Two heartbeats without a word drop the socket without its closing, and the next one connects.
    await wait(60_000);
    expect(socket()).not.toBe(silent);
    socket().connect(ada, ember);
    expect(onAccountChanged).toHaveBeenLastCalledWith(ember);
  });

  it("says nothing of a workspace whose welcome was for someone else", async () => {
    const onAccountChanged = vi.fn();
    renderHook(() => useSidebar(ada, () => {}, undefined, onAccountChanged));
    await settle();
    socket().connect(grace);
    expect(onAccountChanged).not.toHaveBeenCalled();
  });
});
