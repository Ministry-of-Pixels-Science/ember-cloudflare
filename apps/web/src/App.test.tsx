import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloseCode, EMAIL_LINK_GONE, SIGN_IN_REJECTED, type Account, type AccountChanges, type Bootstrap, type Message, type WorkspaceSettings } from "@ember/protocol";
import type { HuddlesSetup } from "@ember/protocol/huddles";
import { QUESTION } from "@/components/setup-huddles";
import { flashOnNextPage } from "@/lib/flash";
import { loadPage } from "@/lib/page";
import { setPrefersDark } from "@/test-media";
import { CHROME_MAC } from "@/test-platforms";
import { App } from "./App";

vi.mock("@/lib/page", () => ({ loadPage: vi.fn() }));

const ada = { id: "u1", name: "Ada", administrator: true };
const grace = { id: "u2", name: "Grace", administrator: false };
const JOIN_CODE = "aB3d-Ef5h-iJ7k";
/** The id in Grace's sign-in link. */
const TRANSFER_ID = "u2.mgk3x2a9.Ab-_9z";
/** The secret in Grace's invitation's link. */
const INVITATION_TOKEN = "Gr-_ce".repeat(7) + "H";
/** The secret in the link Ember emailed Grace to join with her address at the email domains. */
const EMAIL_LINK_TOKEN = "Gr-_em".repeat(7) + "D";
/** Where joining with Ada's email address sends the browser. */
const ADA_SIGNS_IN = "/session/new?email_address=ada%40example.com";
/** The workspace as it's set up. */
const EMBER: Account = { name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false };
/** What the deployment's Set up Ember form suggests. */
const PLACEHOLDERS = { name: "Grace Hopper", emailAddress: "grace@example.com" };
const general = { id: "general", name: "general", kind: "open", icon: null };
/** The rooms first run makes, general first. */
const firstRooms = [
  { id: "r1", name: "general", kind: "open", icon: null },
  { id: "r2", name: "random", kind: "open", icon: null },
];

class QuietSocket {
  static readonly OPEN = 1;
  readyState = 0;
  send() {}
  close() {}
}

/** A room socket the test answers as the room. The tab's workspace socket stays quiet, and unlisted. */
class RoomSocket extends QuietSocket {
  static all: RoomSocket[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    super();
    if (url.includes("/api/rooms/")) RoomSocket.all.push(this);
  }

  welcome(you: typeof ada, messages: Message[] = []) {
    this.readyState = RoomSocket.OPEN;
    this.onopen?.(new Event("open"));
    const welcome = { type: "welcome", you, messages, present: [you], hasMore: false, seq: 0 };
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(welcome) }));
  }

  /** The room closes the socket, saying why. */
  end(code: number) {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

/** The tab's workspace socket, which the test answers as the Workspace. Room sockets stay quiet. */
class WorkspaceSocket extends QuietSocket {
  static all: WorkspaceSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: string) {
    super();
    if (url.endsWith("/api/socket")) WorkspaceSocket.all.push(this);
  }

  receive(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  welcome(you: typeof ada, account = EMBER) {
    this.readyState = WorkspaceSocket.OPEN;
    this.onopen?.();
    this.receive({ type: "welcome", you, account });
  }

  /** The Workspace closes the socket, saying why. */
  end(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/**
 * Plays the server, which may be waiting to be set up, and whose session cookie this browser starts
 * out with or without. Ada, its administrator, signs in as ada@example.com with "correct horse", and
 * Grace joins, or signs in with her sign-in link.
 */
function serve({
  signedIn,
  setup = "complete",
  setupAccess = "open",
  guestSignIn = true,
  passwordResetCodes = false,
  account: given = EMBER,
}: {
  signedIn: boolean;
  setup?: "pending" | "complete";
  /** What setting Ember up takes, until it's set up. */
  setupAccess?: Bootstrap["setupAccess"];
  guestSignIn?: boolean;
  /** Whether Ember can email a code to reset a password. */
  passwordResetCodes?: boolean;
  /** The workspace as it's set up, rather than `EMBER`. */
  account?: Account;
}) {
  let rooms = [general];
  let account = given;
  let me = ada;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const route = `${init?.method ?? "GET"} ${String(input)}`;
    if (route === "GET /api/bootstrap") {
      return Response.json({ setup, setupAccess, setupPlaceholders: PLACEHOLDERS, guestSignIn, signInWithMemberful: false, account, version: "0.1", vapidPublicKey: null, turnstileSiteKey: null, passwordResetCodes, platform: CHROME_MAC, user: signedIn ? me : null });
    }
    if (route === "POST /api/first_run") {
      [setup, signedIn, rooms] = ["complete", true, firstRooms];
      return Response.json({ user: ada, room: firstRooms[0] }, { status: 201 });
    }
    if (route === "POST /api/session") {
      const fields = JSON.parse(String(init?.body)) as Record<string, string>;
      const isAda = fields.emailAddress === "ada@example.com" && fields.password === "correct horse";
      if (!("name" in fields) && !isAda) return Response.json({ error: SIGN_IN_REJECTED }, { status: 401 });
      [signedIn, me] = [true, ada];
      return Response.json({ user: ada }, { status: 201 });
    }
    if (route === "DELETE /api/session") {
      signedIn = false;
      return new Response(null, { status: 204 });
    }
    if (route === "POST /api/session/transfers") {
      const { transferId } = JSON.parse(String(init?.body)) as Record<string, string>;
      if (transferId !== TRANSFER_ID) return new Response(null, { status: 400 });
      [signedIn, me] = [true, grace];
      return Response.json({ user: grace }, { status: 201 });
    }
    if (route === "POST /api/email_links/lookup") {
      const { token } = JSON.parse(String(init?.body)) as { token: string };
      const kind = { [INVITATION_TOKEN]: "invitation", [EMAIL_LINK_TOKEN]: "email_domain" }[token];
      if (!kind) return Response.json({ error: EMAIL_LINK_GONE }, { status: 404 });
      return Response.json({ kind, emailAddress: "grace@example.com" });
    }
    if (route === "POST /api/join/invitation" || route === "POST /api/join/email") {
      [signedIn, me] = [true, grace];
      return Response.json({ user: grace }, { status: 201 });
    }
    if (route === `POST /api/join/${JOIN_CODE}` || (route === "POST /api/join" && account.openSignUp)) {
      const { emailAddress } = JSON.parse(String(init?.body)) as Record<string, string>;
      if (emailAddress === "ada@example.com") return Response.json({ error: "That email address has an account already", redirect: ADA_SIGNS_IN }, { status: 409 });
      [signedIn, me] = [true, grace];
      return Response.json({ user: grace }, { status: 201 });
    }
    if (!signedIn) return Response.json({ error: "Not signed in" }, { status: 401 });
    if (route === "GET /api/me") return Response.json({ user: me });
    if (route === "POST /api/outside/asks") return Response.json({ name: "Claude", comesBackTo: "claude.example", workspace: account.name, scopes: ["read"] });
    if (route === "GET /api/account")
      return Response.json({
        account,
        joinCode: JOIN_CODE,
        canAdminister: me.administrator,
        memberfulSite: null,
        memberfulWebhooks: false,
        turnstile: null,
        assistant: null,
        huddles: null,
        outsideAi: false,
        cloudflareAccountId: null,
        email: { provider: "cloudflare", resendKey: null, cloudflare: true, from: null },
        invitations: [],
        emailDomains: [],
        addresses: { deployed: null, others: [] },
      } satisfies WorkspaceSettings);
    if (route === "PUT /api/account/huddles") {
      account = { ...account, huddles: true };
      return Response.json({ huddles: { appId: (JSON.parse(String(init?.body)) as HuddlesSetup).appId } });
    }
    if (route === "GET /api/users") return Response.json({ users: [] });
    if (route === "GET /api/users/me/profile") return Response.json({ profile: { name: me.name, emailAddress: null, bio: null, apps: [], outsideAi: null } });
    if (route === "PATCH /api/account") {
      const { name = account.name, tagline = account.tagline, settings, customDomain = account.customDomain } = JSON.parse(String(init?.body)) as AccountChanges;
      account = { ...account, name, tagline, hideTranslationButtons: settings?.hideTranslationButtons ?? account.hideTranslationButtons, customDomain };
      return Response.json({ account });
    }
    // Each read, at the level a room starts at.
    return Response.json({ rooms: rooms.map((room) => ({ ...room, unread: false, involvement: "mentions" })), favorites: { rooms: [], version: 0 }, invitation: null });
  });
}

/** Serves signed in, as `serve` does, holding back its answer to `held`, such as "GET /api/account", until it's let go. */
function serveHolding(held: string) {
  const server = serve({ signedIn: true });
  const answer = server.getMockImplementation()!;
  let letGo!: () => void;
  const goes = new Promise<void>((resolve) => (letGo = resolve));
  server.mockImplementation(async (input, init) => {
    if (`${init?.method ?? "GET"} ${String(input)}` === held) await goes;
    return answer(input, init);
  });
  return letGo;
}

const roomHeading = () => screen.findByRole("heading", { level: 1, name: "general" });
/** The room page's first socket, which it opens just after it shows, so it may not exist yet when the page is found. */
async function roomSocket(): Promise<RoomSocket> {
  await waitFor(() => expect(RoomSocket.all).not.toHaveLength(0));
  return RoomSocket.all[0]!;
}
const signInPage = () => screen.findByRole("heading", { name: "Sign in to Ember" });
/** What first run asks about huddles, once the workspace is made, before it opens Ember. */
const huddlesQuestion = () => screen.findByRole("heading", { level: 1, name: QUESTION });

async function signInAsAda(password = "correct horse") {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Email address"), "ada@example.com");
  await user.type(screen.getByLabelText("Password"), `${password}{Enter}`);
}

/** Opens your profile, where you sign out, from the rail's avatar, once it has loaded. */
async function openYourProfile() {
  await userEvent.setup().click(screen.getAllByRole("link", { name: "Your profile" })[0]!);
  await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
}

const logOut = () => userEvent.setup().click(screen.getByRole("button", { name: "Log out" }));

beforeEach(() => {
  vi.stubGlobal("WebSocket", QuietSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(loadPage).mockClear();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

describe("Set up the workspace", () => {
  it("sends every page to Set up Ember until Ember is set up", async () => {
    history.replaceState(null, "", "/rooms/general");
    serve({ signedIn: false, setup: "pending" });
    render(<App />);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/first_run"));
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("sets up Ember at /first_run, asks about huddles, then opens general signed in as its administrator", async () => {
    history.replaceState(null, "", "/first_run");
    const fetch = serve({ signedIn: false, setup: "pending" });
    render(<App />);
    const user = userEvent.setup();
    const name = await screen.findByLabelText("Name");
    // What the deployment suggests, rather than the defaults.
    expect(name).toHaveAttribute("placeholder", PLACEHOLDERS.name);
    expect(screen.getByLabelText("Email address")).toHaveAttribute("placeholder", PLACEHOLDERS.emailAddress);
    await user.type(name, "Ada");
    await user.type(screen.getByLabelText("Email address"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse{Enter}");

    // The question comes before Ember opens, still at setup's address. Its title takes focus in an effect, just after it shows.
    const question = await huddlesQuestion();
    await waitFor(() => expect(question).toHaveFocus());
    expect(location.pathname).toBe("/first_run");
    await user.click(screen.getByRole("button", { name: "Not now" }));

    expect(await screen.findByRole("heading", { level: 1, name: "general" })).toBeInTheDocument();
    expect(location.pathname).toBe("/rooms/r1");
    expect(screen.getAllByRole("link", { name: "Your profile" })[0]).toHaveAttribute("title", "Ada");
    expect(fetch.mock.calls.some(([path]) => path === "/api/account/huddles")).toBe(false);
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("turns huddles on as Ember is set up, with an SFU app's keys, which gives general's header its huddle button", async () => {
    WorkspaceSocket.all = [];
    vi.stubGlobal("WebSocket", WorkspaceSocket);
    history.replaceState(null, "", "/first_run");
    const fetch = serve({ signedIn: false, setup: "pending" });
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email address"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse{Enter}");

    await huddlesQuestion();
    await user.click(screen.getByRole("button", { name: "Set up huddles" }));
    expect(screen.getByRole("heading", { level: 1, name: "Set up huddles" })).toHaveFocus();
    const app = { appId: "ca11".repeat(8), appSecret: "5ec7".repeat(16) };
    await user.type(screen.getByRole("textbox", { name: "App ID" }), app.appId);
    await user.type(screen.getByRole("textbox", { name: "App Secret" }), app.appSecret);
    await user.click(screen.getByRole("button", { name: "Save and continue" }));

    const on = await screen.findByRole("heading", { level: 1, name: "Huddles are on" });
    await waitFor(() => expect(on).toHaveFocus());
    const [, saved] = fetch.mock.calls.find(([path]) => path === "/api/account/huddles")!;
    expect([saved!.method, JSON.parse(String(saved!.body))]).toEqual(["PUT", app]);
    // Nothing has opened Ember yet.
    expect(location.pathname).toBe("/first_run");
    expect(WorkspaceSocket.all).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Open Ember" }));

    expect(await screen.findByRole("heading", { level: 1, name: "general" })).toBeInTheDocument();
    expect(location.pathname).toBe("/rooms/r1");
    // The workspace says huddles are on as its socket connects.
    expect(screen.queryByRole("button", { name: "Start huddle" })).not.toBeInTheDocument();
    await waitFor(() => expect(WorkspaceSocket.all).toHaveLength(1));
    act(() => WorkspaceSocket.all[0]!.welcome(ada, { ...EMBER, huddles: true }));
    expect(screen.getByRole("button", { name: "Start huddle" })).toBeInTheDocument();
  });

  it("sets up Ember through its setup link, sending the link's token and taking it out of the address", async () => {
    const token = "e2e1".repeat(16);
    history.replaceState(null, "", `/first_run#token=${token}`);
    const fetch = serve({ signedIn: false, setup: "pending", setupAccess: "link" });
    render(<App />);
    const user = userEvent.setup();
    const name = await screen.findByLabelText("Name");
    // An effect takes it out, which on a busy machine can run after the field shows.
    await waitFor(() => expect(location.hash).toBe(""));
    expect(location.pathname).toBe("/first_run");
    await user.type(name, "Ada");
    await user.type(screen.getByLabelText("Email address"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse{Enter}");
    await huddlesQuestion();
    await user.click(screen.getByRole("button", { name: "Not now" }));

    expect(await screen.findByRole("heading", { level: 1, name: "general" })).toBeInTheDocument();
    const [, init] = fetch.mock.calls.find(([path, init]) => path === "/api/first_run" && init?.method === "POST")!;
    expect(new Headers(init!.headers).get("Authorization")).toBe(`Bearer ${token}`);
  });

  it("asks for the setup link where Ember takes one and this address brought none", async () => {
    history.replaceState(null, "", "/first_run");
    serve({ signedIn: false, setup: "pending", setupAccess: "link" });
    render(<App />);
    expect(await screen.findByText("Ember is waiting for its administrator.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("leaves /first_run for the workspace once Ember is set up", async () => {
    history.replaceState(null, "", "/first_run");
    serve({ signedIn: true });
    render(<App />);
    expect(await roomHeading()).toBeInTheDocument();
    // Home, which goes on to the last room visited.
    expect(location.pathname).toBe("/rooms/general");
    expect(loadPage).not.toHaveBeenCalled();
  });
});

describe("Stay signed in, per device", () => {
  it("opens straight into the workspace for someone already signed in", async () => {
    serve({ signedIn: true });
    render(<App />);
    expect(await roomHeading()).toBeInTheDocument();
  });

  it("sends someone who isn't signed in to sign in", async () => {
    history.replaceState(null, "", "/rooms/general");
    serve({ signedIn: false });
    render(<App />);
    expect(await signInPage()).toBeInTheDocument();
    expect(location.pathname).toBe("/session/new");
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("opens the page asked for once someone signs in, though it preloaded the workspace with a session that had ended", async () => {
    history.replaceState(null, "", "/rooms/general");
    const server = serve({ signedIn: false });
    const answer = server.getMockImplementation()!;
    // What the browser fetched with the page for the cookie's session, which it gives the first request for each, once.
    const preloaded = new Map(["/api/sidebar", "/api/users"].map((path) => [path, Response.json({ error: "Not signed in" }, { status: 401 })]));
    server.mockImplementation(async (input, init) => {
      const preload = init?.method === undefined ? preloaded.get(String(input)) : undefined;
      if (!preload) return answer(input, init);
      preloaded.delete(String(input));
      return preload;
    });
    render(<App />);
    await signInPage();
    await signInAsAda();
    expect(await roomHeading()).toBeInTheDocument();
    expect(location.pathname).toBe("/rooms/general");
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("keeps asking who's signed in while the server can't be reached", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = serve({ signedIn: true });
    fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<App />);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("heading", { name: "Sign in to Ember" })).not.toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await roomHeading()).toBeInTheDocument();
  });

  it("follows another tab that signs this browser in as someone else", async () => {
    RoomSocket.all = [];
    vi.stubGlobal("WebSocket", RoomSocket);
    const fetch = serve({ signedIn: true });
    render(<App />);
    await roomHeading();

    // Another tab joins as Grace, whose cookie reaches the room when this tab's socket reconnects.
    await fetch(`/api/join/${JOIN_CODE}`, { method: "POST", body: JSON.stringify({ emailAddress: "grace@example.com" }) });
    const socket = await roomSocket();
    act(() => socket.welcome(grace));
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Your profile" })[0]).toHaveAttribute("title", "Grace"));
    // Grace's workspace opens its own socket to the room.
    await waitFor(() => expect(RoomSocket.all).toHaveLength(2));
  });

  it("forgets the session earlier versions kept in localStorage", async () => {
    localStorage.setItem("ember:session", JSON.stringify({ user: ada, token: "t" }));
    serve({ signedIn: false });
    render(<App />);
    await signInPage();
    expect(localStorage.getItem("ember:session")).toBeNull();
  });

  it("goes to sign in when the session ends elsewhere, and comes back to this room afterwards", async () => {
    RoomSocket.all = [];
    vi.stubGlobal("WebSocket", RoomSocket);
    history.replaceState(null, "", "/rooms/general");
    const fetch = serve({ signedIn: true });
    render(<App />);
    await roomHeading();
    const socket = await roomSocket();
    act(() => socket.welcome(ada));

    // Another tab signs out, and the room tells this tab's socket to reconnect.
    await fetch("/api/session", { method: "DELETE" });
    act(() => socket.end(CloseCode.Reconnect));
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/session/new"));
    expect(sessionStorage.getItem("ember:return-to")).toBe("/rooms/general");
  });
});

describe("Open a room", () => {
  const morning: Message = {
    id: "m1",
    clientMessageId: "m1",
    roomId: "general",
    creator: ada,
    body: "<p>Morning!</p>",
    plainText: "Morning!",
    mentions: [],
    createdAt: "2026-10-18T09:00:00.000Z",
    updatedAt: "2026-10-18T09:00:00.000Z",
    editedAt: null,
    boosts: [],
  };

  it("connects to the room an address shows once it knows who's signed in, before the room can show, and the room takes that socket", async () => {
    RoomSocket.all = [];
    vi.stubGlobal("WebSocket", RoomSocket);
    history.replaceState(null, "", "/rooms/general");
    const sendRooms = serveHolding("GET /api/sidebar");
    render(<App />);
    await waitFor(() => expect(RoomSocket.all).toHaveLength(1));
    act(() => RoomSocket.all[0]!.welcome(ada, [morning]));

    sendRooms();
    expect(await screen.findByText("Morning!")).toBeInTheDocument();
    expect(RoomSocket.all).toHaveLength(1);
  });

  it("connects to no room before someone signs in", async () => {
    RoomSocket.all = [];
    vi.stubGlobal("WebSocket", RoomSocket);
    history.replaceState(null, "", "/rooms/general");
    serve({ signedIn: false });
    render(<App />);
    await signInPage();
    expect(RoomSocket.all).toEqual([]);
  });
});

describe("Rename the workspace", () => {
  it("takes a name saved in another tab at once, as the workspace socket says, on every page", async () => {
    WorkspaceSocket.all = [];
    vi.stubGlobal("WebSocket", WorkspaceSocket);
    serve({ signedIn: true });
    render(<App />);
    await roomHeading();
    await waitFor(() => expect(WorkspaceSocket.all).toHaveLength(1));
    act(() => WorkspaceSocket.all[0]!.welcome(ada));
    act(() => WorkspaceSocket.all[0]!.receive({ type: "account.updated", account: { ...EMBER, name: "Analytical Engines" } }));
    expect(screen.getByRole("heading", { level: 2, name: "Analytical Engines" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ember home" })).toHaveAttribute("title", "Analytical Engines");
  });

  it("renames the workspace from its settings, and the rail takes the new name, and the sidebar back in a room", async () => {
    history.replaceState(null, "", "/account/edit");
    serve({ signedIn: true });
    render(<App />);
    const user = userEvent.setup();
    const name = await screen.findByRole("textbox", { name: "Community name" });
    expect(name).toHaveValue("Ember");
    await user.clear(name);
    await user.type(name, "Analytical Engines{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("Changes saved.");
    expect(screen.getByRole("link", { name: "Ember home" })).toHaveAttribute("title", "Analytical Engines");
    expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("aria-current", "page");
    // Community settings take the sidebar's place.
    await user.click(screen.getByRole("link", { name: "Go Back" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Analytical Engines" })).toBeInTheDocument();
  });

  it("keeps a name the workspace socket says over settings asked for before it said so, which may be older", async () => {
    WorkspaceSocket.all = [];
    vi.stubGlobal("WebSocket", WorkspaceSocket);
    history.replaceState(null, "", "/account/edit");
    const sendSettings = serveHolding("GET /api/account");
    render(<App />);
    await waitFor(() => expect(WorkspaceSocket.all).toHaveLength(1));
    act(() => WorkspaceSocket.all[0]!.welcome(ada));
    // Saved in another tab after the settings were read.
    act(() => WorkspaceSocket.all[0]!.receive({ type: "account.updated", account: { ...EMBER, name: "Analytical Engines" } }));
    sendSettings();

    // The field too, which follows the workspace until it's typed in.
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Community name" })).toHaveValue("Analytical Engines"));
    expect(screen.getByRole("link", { name: "Ember home" })).toHaveAttribute("title", "Analytical Engines");
  });

  it("keeps a name the workspace socket says over a save answered after it said so, which may be older", async () => {
    WorkspaceSocket.all = [];
    vi.stubGlobal("WebSocket", WorkspaceSocket);
    history.replaceState(null, "", "/account/edit");
    const answerSave = serveHolding("PATCH /api/account");
    render(<App />);
    await waitFor(() => expect(WorkspaceSocket.all).toHaveLength(1));
    act(() => WorkspaceSocket.all[0]!.welcome(ada));
    const user = userEvent.setup();
    const name = await screen.findByRole("textbox", { name: "Community name" });
    await waitFor(() => expect(name).toHaveValue("Ember"));
    await user.clear(name);
    await user.type(name, "Difference Engines{Enter}");
    // Saved in another tab after this one's save.
    act(() => WorkspaceSocket.all[0]!.receive({ type: "account.updated", account: { ...EMBER, name: "Analytical Engines" } }));
    answerSave();

    expect(await screen.findByRole("alert")).toHaveTextContent("Changes saved.");
    expect(screen.getByRole("link", { name: "Ember home" })).toHaveAttribute("title", "Analytical Engines");
  });
});

describe("Workspace tagline", () => {
  const TAGLINE = "Engines for every occasion";
  /** The sidebar's heading, with the tagline under the name, if there is one. */
  const sidebarHeading = () => screen.getByRole("heading", { level: 2, name: "Ember" }).closest("hgroup");

  it("takes a tagline saved in another tab at once, as the workspace socket says", async () => {
    WorkspaceSocket.all = [];
    vi.stubGlobal("WebSocket", WorkspaceSocket);
    serve({ signedIn: true });
    render(<App />);
    await roomHeading();
    await waitFor(() => expect(WorkspaceSocket.all).toHaveLength(1));
    act(() => WorkspaceSocket.all[0]!.welcome(ada));
    expect(sidebarHeading()).toHaveTextContent(/^Ember$/);

    act(() => WorkspaceSocket.all[0]!.receive({ type: "account.updated", account: { ...EMBER, tagline: TAGLINE } }));
    expect(sidebarHeading()).toHaveTextContent(`Ember${TAGLINE}`);
    act(() => WorkspaceSocket.all[0]!.receive({ type: "account.updated", account: EMBER }));
    expect(sidebarHeading()).toHaveTextContent(/^Ember$/);
  });

  it("gives the workspace a tagline from its settings, which the sidebar shows under the name", async () => {
    history.replaceState(null, "", "/account/edit");
    serve({ signedIn: true });
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Tagline" }), `${TAGLINE}{Enter}`);

    expect(await screen.findByRole("alert")).toHaveTextContent("Changes saved.");
    // Community settings take the sidebar's place.
    await user.click(screen.getByRole("link", { name: "Go Back" }));
    await waitFor(() => expect(sidebarHeading()).toHaveTextContent(`Ember${TAGLINE}`));
  });
});

describe("Custom domain", () => {
  const DOMAIN = "chat.example.com";
  const MOVED: Account = { ...EMBER, customDomain: DOMAIN };
  /** The notice in a tab left open at another address. */
  const movedNotice = () => screen.queryByText((_, element) => element?.tagName === "P" && element.textContent === `Ember has moved to ${DOMAIN}. Go there`);

  it("moves a page opened at any other address to the same page at Ember's custom domain, before showing anything", async () => {
    history.replaceState(null, "", "/rooms/general?ref=email#top");
    serve({ signedIn: true, account: MOVED });
    render(<App />);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith(`http://${DOMAIN}/rooms/general?ref=email#top`));
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(RoomSocket.all).toEqual([]);
  });

  it("moves sign-in too, so people sign in there", async () => {
    history.replaceState(null, "", "/session/new");
    serve({ signedIn: false, account: MOVED });
    render(<App />);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith(`http://${DOMAIN}/session/new`));
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("stays at Ember's custom domain", async () => {
    serve({ signedIn: true, account: { ...EMBER, customDomain: location.host } });
    render(<App />);
    expect(await roomHeading()).toBeInTheDocument();
    expect(loadPage).not.toHaveBeenCalled();
    expect(movedNotice()).not.toBeInTheDocument();
  });

  it("keeps workspace settings wherever they're opened, so an administrator can go back from another address", async () => {
    history.replaceState(null, "", "/account/edit#domain-settings");
    serve({ signedIn: true, account: MOVED });
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: `Go back to ${location.host}` }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Changes saved.");
    expect(screen.getByRole("region", { name: "Custom domain" })).toHaveTextContent(`Ember's address is ${location.host}.`);
    expect(loadPage).not.toHaveBeenCalled();
    expect(movedNotice()).not.toBeInTheDocument();
  });

  it("tells a tab left open at another address that Ember has moved, on every page that would move", async () => {
    WorkspaceSocket.all = [];
    vi.stubGlobal("WebSocket", WorkspaceSocket);
    serve({ signedIn: true });
    render(<App />);
    await roomHeading();
    await waitFor(() => expect(WorkspaceSocket.all).toHaveLength(1));
    act(() => WorkspaceSocket.all[0]!.welcome(ada));
    expect(movedNotice()).not.toBeInTheDocument();
    /** Gives Ember the custom domain `customDomain`, as an administrator at that address does, which the workspace socket then says. */
    const moveEmberTo = async (customDomain: string | null) => {
      const { account } = (await (await fetch("/api/account", { method: "PATCH", body: JSON.stringify({ customDomain }) })).json()) as { account: Account };
      act(() => WorkspaceSocket.all[0]!.receive({ type: "account.updated", account }));
    };

    await moveEmberTo(DOMAIN);
    expect(movedNotice()).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go there" })).toHaveAttribute("href", `http://${DOMAIN}/rooms/general`);
    // Not moved from under them.
    expect(loadPage).not.toHaveBeenCalled();

    // Workspace settings stay, and say so themselves.
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Admin" }));
    await user.click(await screen.findByRole("link", { name: "Domain settings" }));
    expect(await screen.findByRole("region", { name: "Custom domain" })).toHaveTextContent(`Ember's address is ${DOMAIN}.`);
    expect(movedNotice()).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Go Back" }));
    await roomHeading();
    expect(movedNotice()).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(movedNotice()).not.toBeInTheDocument();
    // Until Ember moves again.
    await moveEmberTo("ember.example.org");
    expect(screen.getByRole("link", { name: "Go there" })).toHaveAttribute("href", "http://ember.example.org/rooms/general");
    // Moving as a page opened afresh would.
    await user.click(screen.getByRole("link", { name: "Go there" }));
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("http://ember.example.org/rooms/general"));
    await moveEmberTo(null);
    expect(screen.queryByRole("link", { name: "Go there" })).not.toBeInTheDocument();
  });
});

describe("Custom CSS", () => {
  const RED = "body { color: red; }";
  const BLUE = "body { color: blue; }";
  /** The workspace's CSS, which comes after the app's own. */
  const customStyles = () => document.head.lastElementChild?.tagName === "STYLE" && document.head.lastElementChild.textContent;

  it("applies the workspace's CSS to every page, sign-in included", async () => {
    serve({ signedIn: false, account: { ...EMBER, customStyles: RED } });
    render(<App />);
    await signInPage();
    expect(customStyles()).toBe(RED);
  });

  it("applies CSS saved in another tab at once, as the workspace socket says", async () => {
    WorkspaceSocket.all = [];
    vi.stubGlobal("WebSocket", WorkspaceSocket);
    serve({ signedIn: true, account: { ...EMBER, customStyles: RED } });
    render(<App />);
    await roomHeading();
    await waitFor(() => expect(WorkspaceSocket.all).toHaveLength(1));
    // Saved while the tab was without its socket.
    act(() => WorkspaceSocket.all[0]!.welcome(ada, { ...EMBER, customStyles: BLUE }));
    expect(customStyles()).toBe(BLUE);
    act(() => WorkspaceSocket.all[0]!.receive({ type: "account.updated", account: EMBER }));
    expect(customStyles()).toBe(false);
    expect(document.head.querySelectorAll("style")).toHaveLength(0);
  });

  it("marks the page's body admin while an administrator is signed in, for the CSS to go by", async () => {
    WorkspaceSocket.all = [];
    vi.stubGlobal("WebSocket", WorkspaceSocket);
    serve({ signedIn: true });
    const { unmount } = render(<App />);
    await roomHeading();
    expect(document.body).toHaveClass("admin");
    await waitFor(() => expect(WorkspaceSocket.all).toHaveLength(1));
    act(() => WorkspaceSocket.all[0]!.welcome({ ...ada, administrator: false }));
    await waitFor(() => expect(document.body).not.toHaveClass("admin"));
    act(() => WorkspaceSocket.all[0]!.welcome(ada));
    await waitFor(() => expect(document.body).toHaveClass("admin"));
    unmount();
    expect(document.body).not.toHaveClass("admin");
  });
});

describe("Huddles", () => {
  const huddleButton = () => screen.queryByRole("button", { name: "Start huddle" });

  it("gives a room's header its huddle button, and takes it away, as the workspace socket says huddles go on and off", async () => {
    WorkspaceSocket.all = [];
    vi.stubGlobal("WebSocket", WorkspaceSocket);
    serve({ signedIn: true });
    render(<App />);
    await roomHeading();
    await waitFor(() => expect(WorkspaceSocket.all).toHaveLength(1));
    act(() => WorkspaceSocket.all[0]!.welcome(ada));
    expect(huddleButton()).not.toBeInTheDocument();

    act(() => WorkspaceSocket.all[0]!.receive({ type: "account.updated", account: { ...EMBER, huddles: true } }));
    expect(huddleButton()).toBeInTheDocument();
    act(() => WorkspaceSocket.all[0]!.receive({ type: "account.updated", account: EMBER }));
    expect(huddleButton()).not.toBeInTheDocument();
  });
});

describe("Workspace logo", () => {
  const LOGO = "/account/logo?v=20261017120000";
  const brand = () => screen.getByRole("link", { name: "Ember home" }).querySelector("img");

  it("shows the workspace's logo before anyone signs in", async () => {
    serve({ signedIn: false, account: { ...EMBER, logo: LOGO } });
    render(<App />);
    await signInPage();
    expect(screen.getByRole("img", { name: "Account logo" })).toHaveAttribute("src", LOGO);
    expect(document.body).toHaveClass("account-has-logo");
  });

  it("shows a logo saved in another tab at once, as the workspace socket says", async () => {
    WorkspaceSocket.all = [];
    vi.stubGlobal("WebSocket", WorkspaceSocket);
    serve({ signedIn: true });
    const { unmount } = render(<App />);
    await roomHeading();
    expect(brand()).toHaveAttribute("src", "/ember-icon.png");
    await waitFor(() => expect(WorkspaceSocket.all).toHaveLength(1));
    act(() => WorkspaceSocket.all[0]!.receive({ type: "account.updated", account: { ...EMBER, logo: LOGO } }));
    expect(brand()).toHaveAttribute("src", LOGO);
    expect(document.body).toHaveClass("account-has-logo");
    act(() => WorkspaceSocket.all[0]!.receive({ type: "account.updated", account: EMBER }));
    expect(brand()).toHaveAttribute("src", "/ember-icon.png");
    expect(document.body).not.toHaveClass("account-has-logo");
    unmount();
  });
});

describe("Translation buttons", () => {
  it("shows translation buttons on sign-in once an administrator shows them", async () => {
    serve({ signedIn: false, account: { ...EMBER, hideTranslationButtons: false } });
    render(<App />);
    await signInPage();
    // By the email address and the password.
    expect(screen.getAllByText("Translate")).toHaveLength(2);
  });
});

describe("Make or revoke administrators", () => {
  it("follows the person signed in being made a member, and an administrator again, as their rail says", async () => {
    WorkspaceSocket.all = [];
    vi.stubGlobal("WebSocket", WorkspaceSocket);
    serve({ signedIn: true });
    render(<App />);
    await roomHeading();
    expect(screen.getByRole("link", { name: "Admin" })).toBeInTheDocument();
    await waitFor(() => expect(WorkspaceSocket.all).toHaveLength(1));
    act(() => WorkspaceSocket.all[0]!.welcome(ada));

    const listed = { ...ada, bio: null, status: "active", avatarUrl: "/users/u1.token/avatar?v=20261014120000" };
    act(() => WorkspaceSocket.all[0]!.receive({ type: "user.updated", user: { ...listed, role: "member" } }));
    expect(await screen.findByRole("link", { name: "Workspace" })).toBeInTheDocument();
    act(() => WorkspaceSocket.all[0]!.receive({ type: "user.updated", user: { ...listed, role: "administrator" } }));
    expect(await screen.findByRole("link", { name: "Admin" })).toBeInTheDocument();
    // The same workspace, which only follows them.
    expect(WorkspaceSocket.all).toHaveLength(1);
  });
});

describe("Sign in with email and password", () => {
  it("signs in with an email address and password, and comes back to the page asked for", async () => {
    history.replaceState(null, "", "/rooms/general");
    serve({ signedIn: false });
    render(<App />);
    await signInPage();
    await signInAsAda();
    expect(await roomHeading()).toBeInTheDocument();
    expect(location.pathname).toBe("/rooms/general");
  });

  it("goes home from the sign-in page itself", async () => {
    history.replaceState(null, "", "/session/new");
    serve({ signedIn: false });
    render(<App />);
    await signInAsAda();
    expect(await roomHeading()).toBeInTheDocument();
    // Home, which goes on to the last room visited.
    expect(location.pathname).toBe("/rooms/general");
  });

  it("shows the sign-in page to someone already signed in", async () => {
    history.replaceState(null, "", "/session/new");
    serve({ signedIn: true });
    render(<App />);
    expect(await signInPage()).toBeInTheDocument();
    await signInAsAda();
    expect(await roomHeading()).toBeInTheDocument();
  });

  it("stays on the sign-in page when the password is wrong", async () => {
    serve({ signedIn: false });
    render(<App />);
    await signInAsAda("wrong horse");
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGN_IN_REJECTED);
    expect(screen.getByRole("heading", { name: "Sign in to Ember" })).toBeInTheDocument();
    expect(location.pathname).toBe("/session/new");
  });
});

describe("Sign in with Memberful", () => {
  it("forgets the page to come back to once it opens signed in, as signing in with Memberful opens that page itself", async () => {
    sessionStorage.setItem("ember:return-to", "/rooms/general");
    history.replaceState(null, "", "/rooms/general");
    serve({ signedIn: true });
    render(<App />);
    expect(await roomHeading()).toBeInTheDocument();
    expect(sessionStorage.getItem("ember:return-to")).toBeNull();
  });

  it("keeps it on the sign-in page, which opens even for someone signed in", async () => {
    sessionStorage.setItem("ember:return-to", "/rooms/general");
    history.replaceState(null, "", "/session/new");
    serve({ signedIn: true });
    render(<App />);
    expect(await signInPage()).toBeInTheDocument();
    expect(sessionStorage.getItem("ember:return-to")).toBe("/rooms/general");
  });
});

describe("Sign up with the join link", () => {
  const joinPage = () => screen.findByRole("heading", { name: "Join Ember" });

  async function join(emailAddress: string) {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Grace");
    await user.type(screen.getByLabelText("Email address"), emailAddress);
    await user.type(screen.getByLabelText("Password"), "compiler{Enter}");
  }

  it("opens the join page for a join link, and goes home signed in once the account is made", async () => {
    history.replaceState(null, "", `/join/${JOIN_CODE}`);
    serve({ signedIn: false });
    render(<App />);
    expect(await joinPage()).toBeInTheDocument();
    expect(location.pathname).toBe(`/join/${JOIN_CODE}`);

    await join("grace@example.com");
    expect(await roomHeading()).toBeInTheDocument();
    // Home, which goes on to the last room visited.
    expect(location.pathname).toBe("/rooms/general");
    expect(screen.getAllByRole("link", { name: "Your profile" })[0]).toHaveAttribute("title", "Grace");
  });

  it("sends an email address that has an account to sign in with it", async () => {
    history.replaceState(null, "", `/join/${JOIN_CODE}`);
    serve({ signedIn: false });
    render(<App />);
    await join("ada@example.com");
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith(ADA_SIGNS_IN));
  });

  it("sends someone who's signed in home from a join link", async () => {
    history.replaceState(null, "", `/join/${JOIN_CODE}`);
    serve({ signedIn: true });
    render(<App />);
    expect(await roomHeading()).toBeInTheDocument();
    // Home, which goes on to the last room visited.
    expect(location.pathname).toBe("/rooms/general");
  });
});

describe("Sign up without a link", () => {
  it("opens open sign-up's page, and goes home signed in once the account is made", async () => {
    history.replaceState(null, "", "/join");
    const fetch = serve({ signedIn: false, account: { ...EMBER, openSignUp: true } });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Join Ember" })).toBeInTheDocument();
    expect(location.pathname).toBe("/join");

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Name"), "Grace");
    await user.type(screen.getByLabelText("Email address"), "grace@example.com");
    await user.type(screen.getByLabelText("Password"), "compiler{Enter}");
    expect(await roomHeading()).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/join", expect.objectContaining({ method: "POST" }));
    expect(location.pathname).toBe("/rooms/general");
    expect(screen.getAllByRole("link", { name: "Your profile" })[0]).toHaveAttribute("title", "Grace");
  });

  it("sends someone who's signed in home from it", async () => {
    history.replaceState(null, "", "/join");
    serve({ signedIn: true, account: { ...EMBER, openSignUp: true } });
    render(<App />);
    expect(await roomHeading()).toBeInTheDocument();
    expect(location.pathname).toBe("/rooms/general");
  });
});

describe("Join with an invitation", () => {
  it("opens an invitation's page, with its secret out of the address, and goes home signed in once the account is made", async () => {
    history.replaceState(null, "", `/join/invitation#token=${INVITATION_TOKEN}`);
    serve({ signedIn: false, account: { ...EMBER, joinLink: false } });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Join Ember" })).toBeInTheDocument();
    expect(`${location.pathname}${location.hash}`).toBe("/join/invitation");
    expect(await screen.findByRole("textbox", { name: "Email address" })).toHaveValue("grace@example.com");

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Name"), "Grace");
    await user.type(screen.getByLabelText("Password"), "compiler{Enter}");
    expect(await roomHeading()).toBeInTheDocument();
    expect(location.pathname).toBe("/rooms/general");
  });

  it("sends someone who's signed in home from it, leaving its secret behind", async () => {
    history.replaceState(null, "", `/join/invitation#token=${INVITATION_TOKEN}`);
    const fetch = serve({ signedIn: true });
    render(<App />);
    expect(await roomHeading()).toBeInTheDocument();
    expect(location.pathname).toBe("/rooms/general");
    expect(location.hash).toBe("");
    expect(fetch).not.toHaveBeenCalledWith("/api/email_links/lookup", expect.anything());
  });
});

describe("Join with an email domain", () => {
  const atDomains: Account = { ...EMBER, joinLink: false, emailDomainSignUp: true, emailDomains: ["example.com"] };

  it("opens the page to ask for a link without signing in", async () => {
    history.replaceState(null, "", "/join/email");
    serve({ signedIn: false, account: atDomains });
    render(<App />);
    expect(await screen.findByRole("button", { name: "Email me a link" })).toBeInTheDocument();
    expect(location.pathname).toBe("/join/email");
  });

  it("opens a link's page, with its secret out of the address, and goes home signed in once the account is made", async () => {
    history.replaceState(null, "", `/join/email#token=${EMAIL_LINK_TOKEN}`);
    serve({ signedIn: false, account: atDomains });
    render(<App />);
    expect(await screen.findByRole("textbox", { name: "Email address" })).toHaveValue("grace@example.com");
    expect(`${location.pathname}${location.hash}`).toBe("/join/email");

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Name"), "Grace");
    await user.type(screen.getByLabelText("Password"), "compiler{Enter}");
    expect(await roomHeading()).toBeInTheDocument();
    expect(location.pathname).toBe("/rooms/general");
  });

  it("sends someone who's signed in home from it, leaving a link's secret behind", async () => {
    history.replaceState(null, "", `/join/email#token=${EMAIL_LINK_TOKEN}`);
    const fetch = serve({ signedIn: true, account: atDomains });
    render(<App />);
    expect(await roomHeading()).toBeInTheDocument();
    expect(location.pathname).toBe("/rooms/general");
    expect(location.hash).toBe("");
    expect(fetch).not.toHaveBeenCalledWith("/api/email_links/lookup", expect.anything());
  });
});

describe("Reset a forgotten password with an emailed code", () => {
  const resetPage = () => screen.findByRole("heading", { level: 1, name: "Reset your password" });

  it("offers it from the sign-in page while Ember can send email", async () => {
    serve({ signedIn: false, passwordResetCodes: true });
    render(<App />);
    await signInPage();
    expect(screen.getByRole("link", { name: "Reset it" })).toHaveAttribute("href", "/passwords/new");
  });

  it("opens the page to reset a password without sending someone signed out to sign in, keeping the page to come back to", async () => {
    sessionStorage.setItem("ember:return-to", "/rooms/general");
    history.replaceState(null, "", "/passwords/new");
    serve({ signedIn: false, passwordResetCodes: true });
    render(<App />);
    expect(await resetPage()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me a code" })).toBeInTheDocument();
    expect(location.pathname).toBe("/passwords/new");
    expect(sessionStorage.getItem("ember:return-to")).toBe("/rooms/general");
  });

  it("opens it for someone signed in too, as the sign-in page does", async () => {
    sessionStorage.setItem("ember:return-to", "/rooms/general");
    history.replaceState(null, "", "/passwords/new");
    serve({ signedIn: true, passwordResetCodes: true });
    render(<App />);
    expect(await resetPage()).toBeInTheDocument();
    expect(sessionStorage.getItem("ember:return-to")).toBe("/rooms/general");
  });
});

describe("Connecting an AI app", () => {
  const REQUEST = "/oauth/authorize?response_type=code&client_id=0mgk3x2a9b4c70&state=5f2c01";

  it("asks whether to connect the app whose request the address carries, in place of the workspace", async () => {
    history.replaceState(null, "", REQUEST);
    const fetch = serve({ signedIn: true });
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Connect Claude to Ember?" })).toBeVisible();
    expect(fetch).toHaveBeenCalledWith("/api/outside/asks", expect.objectContaining({ method: "POST" }));
    expect(screen.queryAllByRole("link", { name: "Your profile" })).toEqual([]);
    expect(`${location.pathname}${location.search}`).toBe(REQUEST);
  });

  it("has someone signed out sign in first, and comes back to the request", async () => {
    history.replaceState(null, "", REQUEST);
    serve({ signedIn: false });
    render(<App />);
    await signInPage();
    await signInAsAda();
    expect(await screen.findByRole("heading", { level: 1, name: "Connect Claude to Ember?" })).toBeVisible();
    expect(`${location.pathname}${location.search}`).toBe(REQUEST);
  });
});

describe("Private sign-in link", () => {
  it("signs in with a sign-in link rather than going to sign in, then loads home as whoever it's for", async () => {
    history.replaceState(null, "", `/session/transfers#token=${TRANSFER_ID}`);
    const fetch = serve({ signedIn: false });
    render(<App />);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/"));
    expect(fetch).toHaveBeenCalledWith("/api/session/transfers", expect.objectContaining({ method: "POST", body: JSON.stringify({ transferId: TRANSFER_ID }) }));
    expect(`${location.pathname}${location.hash}`).toBe("/session/transfers");
    expect(screen.queryByRole("heading", { name: "Sign in to Ember" })).not.toBeInTheDocument();
  });

  it("signs in with it over the session this browser has, without opening the workspace", async () => {
    history.replaceState(null, "", `/session/transfers#token=${TRANSFER_ID}`);
    serve({ signedIn: true });
    render(<App />);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/"));
    expect(screen.queryAllByRole("link", { name: "Your profile" })).toEqual([]);
  });

  it("leaves the page blank for a link that doesn't work", async () => {
    history.replaceState(null, "", "/session/transfers#token=nonsense");
    serve({ signedIn: false });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByRole("main")).toBeEmptyDOMElement();
    expect(`${location.pathname}${location.hash}`).toBe("/session/transfers");
    expect(loadPage).not.toHaveBeenCalled();
  });
});

describe("Sign in with a display name", () => {
  it("goes from the sign-in page to the workspace with just a name", async () => {
    serve({ signedIn: false });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Join with just a name" }));
    await userEvent.type(screen.getByLabelText("Your name"), "Ada{Enter}");
    expect(await roomHeading()).toBeInTheDocument();
  });

  it("only offers the password when guests can't sign in", async () => {
    serve({ signedIn: false, guestSignIn: false });
    render(<App />);
    await signInPage();
    expect(screen.queryByRole("button", { name: "Join with just a name" })).not.toBeInTheDocument();
  });
});

describe("Sign out", () => {
  it("ends the session and loads the sign-in page, from where signing in goes home", async () => {
    const fetch = serve({ signedIn: true });
    render(<App />);
    await roomHeading();
    sessionStorage.setItem("ember:return-to", "/rooms/general");
    await openYourProfile();
    await logOut();
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/session/new"));
    expect(fetch).toHaveBeenCalledWith("/api/session", expect.objectContaining({ method: "DELETE" }));
    expect(sessionStorage.getItem("ember:return-to")).toBeNull();
  });

  it("goes home after signing in again, even when the workspace closes its socket before signing out answers", async () => {
    WorkspaceSocket.all = [];
    vi.stubGlobal("WebSocket", WorkspaceSocket);
    history.replaceState(null, "", "/rooms/general");
    const fetch = serve({ signedIn: true });
    render(<App />);
    await roomHeading();
    await waitFor(() => expect(WorkspaceSocket.all).toHaveLength(1));
    act(() => WorkspaceSocket.all[0]!.welcome(ada));
    await openYourProfile();
    // The server ends the session at once, but its answer is held back.
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const server = fetch.getMockImplementation()!;
    fetch.mockImplementationOnce(async (input, init) => {
      const response = await server(input, init);
      await answered;
      return response;
    });

    await logOut();
    act(() => WorkspaceSocket.all[0]!.end(CloseCode.Reconnect));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/me", expect.anything()));
    answer();
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/session/new"));
    expect(loadPage).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem("ember:return-to")).toBeNull();
  });

  it("first ends this browser's push subscription, which the server forgets with the session", async () => {
    const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", unsubscribe: vi.fn(async () => true) };
    const registration = { pushManager: { getSubscription: async () => subscription } };
    Object.defineProperty(navigator, "serviceWorker", { value: { getRegistration: async () => registration }, configurable: true });
    try {
      const fetch = serve({ signedIn: true });
      render(<App />);
      await roomHeading();
      await openYourProfile();
      await logOut();
      await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/session/new"));
      expect(subscription.unsubscribe).toHaveBeenCalled();
      const body = JSON.stringify({ pushSubscriptionEndpoint: subscription.endpoint });
      expect(fetch).toHaveBeenCalledWith("/api/session", expect.objectContaining({ method: "DELETE", body }));
    } finally {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  });

  it("stays signed in when signing out can't reach the server", async () => {
    const fetch = serve({ signedIn: true });
    render(<App />);
    await roomHeading();
    await openYourProfile();
    fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await logOut();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/session", expect.objectContaining({ method: "DELETE" })));
    expect(screen.getByRole("heading", { level: 1, name: "Your profile" })).toBeInTheDocument();
    expect(loadPage).not.toHaveBeenCalled();
  });
});

describe("Light, dark or system appearance", () => {
  it("keeps pages without the rail, such as sign-in, in step with other tabs and the device", async () => {
    serve({ signedIn: false });
    render(<App />);
    await signInPage();
    const isDark = () => document.documentElement.classList.contains("dark");

    localStorage.setItem("ember:appearance", "dark");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "ember:appearance", newValue: "dark" })));
    expect(isDark()).toBe(true);

    // Another tab clears the site's storage, which goes back to System.
    localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(isDark()).toBe(false);
    act(() => setPrefersDark(true));
    expect(isDark()).toBe(true);
  });
});

describe("Saved notices", () => {
  const BESIDE_THE_RAIL = "md:left-[calc((100%+env(safe-area-inset-left)+var(--spacing-rail)+var(--spacing-sidebar))/2)]";
  /** Where the flash showing is placed. */
  const placement = async () => (await screen.findByRole("alert")).parentElement!;

  it("centers a flash over the window while signed out", async () => {
    // A refused sign-in says why in its form, so this is one the page before kept.
    flashOnNextPage({ kind: "alert", text: "Something went wrong" });
    serve({ signedIn: false });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    expect(await placement()).toHaveClass("left-1/2");
    expect(await placement()).not.toHaveClass(BESIDE_THE_RAIL);
  });

  it("centers a flash over the page beside the rail and sidebar in the workspace", async () => {
    history.replaceState(null, "", "/rooms/nowhere");
    serve({ signedIn: true });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Room not found or inaccessible");
    expect(await placement()).toHaveClass(BESIDE_THE_RAIL);
  });

  it("leaves a refused sign-in's alert behind once someone signs in", async () => {
    serve({ signedIn: false });
    render(<App />);
    await signInAsAda("wrong horse");
    await screen.findByRole("alert");
    await userEvent.type(screen.getByLabelText("Password"), "correct horse{Enter}");
    expect(await roomHeading()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("flashes what the page before a full page load kept for it once the page it's for shows", async () => {
    flashOnNextPage({ kind: "notice", text: "✓" });
    serve({ signedIn: true });
    render(<App />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(await roomHeading()).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Changes saved");
    expect(await placement()).toHaveClass(BESIDE_THE_RAIL);
  });
});

describe("Select a field's text on entry", () => {
  it("selects what's in a field entered again on the sign-in page, signed out", async () => {
    serve({ signedIn: false });
    render(<App />);
    const user = userEvent.setup();
    const emailAddress = await screen.findByLabelText("Email address");
    await user.type(emailAddress, "grace@example.com");
    await user.click(screen.getByLabelText("Password"));
    await user.click(emailAddress);
    await user.keyboard("ada@example.com");
    expect(emailAddress).toHaveValue("ada@example.com");
  });

  it("leaves what's in Set up Ember's fields alone when they're entered", async () => {
    history.replaceState(null, "", "/first_run");
    serve({ signedIn: false, setup: "pending" });
    render(<App />);
    const user = userEvent.setup();
    const name = await screen.findByLabelText("Name");
    await user.type(name, "Ada");
    await user.click(screen.getByLabelText("Email address"));
    await user.click(name);
    await user.keyboard(" Lovelace");
    expect(name).toHaveValue("Ada Lovelace");
  });
});
