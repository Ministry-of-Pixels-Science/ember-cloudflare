import { test as base, expect, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Locator, type Page, type WebSocketRoute } from "@playwright/test";
import { roomSocketQuery, type Account, type Bootstrap, type ClientFrame, type Invitation, type LiveHuddle, type Message, type ServerFrame, type Sidebar, type User, type WorkspaceServerFrame, type WorkspaceSettings } from "@ember/protocol";
import { bodyFromPlainText } from "@ember/richtext";

// Helpers every browser suite can share. They drive the real Worker and ChatRoom Durable Object
// that the config's webServer runs; nothing here mocks the backend except the room list.

/** A room's socket, for `page.routeWebSocket`. */
export const ROOM_SOCKET = /\/api\/rooms\/[^/]+\/socket/;
/** A tab's workspace socket, for `page.routeWebSocket`, whose address says whether the tab is shown. */
export const WORKSPACE_SOCKET = /\/api\/socket(\?|$)/;

/**
 * How long a test waits for the room icon picker's 991 KB catalog, which the test server has taken
 * longer than expect's 5 seconds to send at the end of a CI run.
 */
export const ICON_CATALOG_LOADED = { timeout: 15_000 };

/** Node's WebSocket, which, unlike a browser's, can send a handshake's headers. */
const NodeWebSocket = WebSocket as unknown as new (url: URL, init: { headers: Record<string, string> }) => WebSocket;

export interface Session {
  user: User;
  /** The session's cookie, ready for `BrowserContext.addCookies`. */
  cookie: { name: string; value: string; url: string; httpOnly: true; sameSite: "Lax" };
}

export interface TestRoom {
  id: string;
  name: string;
}

/** Signs someone in through the API, as the sign-in form does. */
export async function createSession(request: APIRequestContext, name: string): Promise<Session> {
  return sessionOf(await request.post("/api/session", { data: { name } }));
}

/** The session a sign-in through the API began. */
async function sessionOf(response: APIResponse): Promise<Session> {
  expect(response.status(), await response.text()).toBe(201);
  const { user } = (await response.json()) as { user: User };
  const [pair] = response.headers()["set-cookie"]!.split(";");
  const [cookieName, value] = pair!.split("=") as [string, string];
  return { user, cookie: { name: cookieName, value, url: new URL(response.url()).origin, httpOnly: true, sameSite: "Lax" } };
}

/** The administrator the first-run project sets Ember up with, whom every other suite can sign in as. */
export const ADMINISTRATOR = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "correct horse battery" };

/**
 * Signs the administrator in through the API, in a session of its own, from an IP address of its own,
 * so the per-address limit on signing in never counts another test's attempts. It says it comes from the
 * app's own pages, as a browser does, which a server over HTTPS asks of every change.
 */
export async function administratorSession(request: APIRequestContext): Promise<Session> {
  const { emailAddress, password } = ADMINISTRATOR;
  const headers = { "CF-Connecting-IP": newAddress(), ...SAME_ORIGIN };
  return sessionOf(await request.post("/api/session", { data: { emailAddress, password }, headers }));
}

/** What a browser says of a request from the app's own pages, which a server over HTTPS asks of every change. */
export const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" };

/** Makes `session`'s person an administrator, as the administrator does on their page. */
export async function makeAdministrator(request: APIRequestContext, session: Session): Promise<void> {
  const administrator = await administratorSession(request);
  const response = await request.patch(`/api/account/users/${session.user.id}`, { data: { role: "administrator" }, headers: { Cookie: cookieHeader(administrator) } });
  expect(response.status(), await response.text()).toBe(200);
}

/** An IP address no other test uses, from the range set aside for documentation. */
export function newAddress(): string {
  const groups = Array.from(crypto.getRandomValues(new Uint16Array(4)), (group) => group.toString(16));
  return `2001:db8::${groups.join(":")}`;
}

/**
 * Gives `page` an IP address of its own, or `address`, as Cloudflare's `CF-Connecting-IP` header, which
 * `wrangler dev` passes through, so the per-address limit on signing in never counts another test's attempts.
 * Browsers don't send it when they open a WebSocket, which comes from the test server's own address.
 */
export async function useOwnAddress(page: Page, address = newAddress()): Promise<void> {
  await page.setExtraHTTPHeaders({ "CF-Connecting-IP": address });
}

/** Signs the administrator in on the sign-in page `page` is showing, with `password` if given. */
export async function signInAsAdministrator(page: Page, password = ADMINISTRATOR.password): Promise<void> {
  await page.getByLabel("Email address").fill(ADMINISTRATOR.emailAddress);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Logs out: from your profile, which the rail's avatar links to. */
export async function logOut(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Your profile" }).click();
  await page.getByRole("button", { name: "Log out" }).click();
}

/** The `Cookie` header that carries a session, for clients other than the test's browsers. */
export const cookieHeader = ({ cookie }: Session) => `${cookie.name}=${cookie.value}`;

/** What Ember's email comes from with `address` as its From address, which has no name: the address under the workspace's name, as it is now. */
export async function sentFrom(request: APIRequestContext, address: string): Promise<string> {
  const { account } = (await (await request.get("/api/bootstrap")).json()) as Bootstrap;
  return `${account.name} <${address}>`;
}

/** Starts the app already signed in, by giving the browser the session's cookie. */
export async function signInAs(page: Page, session: Session): Promise<void> {
  await page.context().addCookies([session.cookie]);
}

/** A Turnstile widget's keys, which the fake Turnstile and the fake siteverify have. Neither is a secret. */
export const TURNSTILE_WIDGET = { siteKey: "0x4AAAAAAA-e2e-only-site-key", secretKey: "0x4AAAAAAA-e2e-only-secret-key" };

/** The token the fake Turnstile's check gives once it passes, for the widget whose site key is `siteKey`. */
export const turnstileTokenFor = (siteKey: string) => `e2e-token-for-${siteKey}`;

/** Turnstile's script, as pages load it from the one address Ember's policy lets it come from. */
const TURNSTILE_SCRIPT = /^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit$/;

/**
 * Stands in for Turnstile's script wherever `target`'s pages load it, without reaching Cloudflare: its
 * `render` draws a button saying "Verify you are human", whose theme and site key it keeps as data,
 * which passes the check, giving the callback the token `turnstileTokenFor` says.
 */
export async function fakeTurnstile(target: Page | BrowserContext): Promise<void> {
  const script = `window.turnstile = {
    render(container, options) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Verify you are human";
      button.dataset.siteKey = options.sitekey;
      button.dataset.theme = options.theme;
      button.addEventListener("click", () => options.callback(${JSON.stringify(turnstileTokenFor(""))} + options.sitekey));
      (typeof container === "string" ? document.querySelector(container) : container).append(button);
      return "e2e-widget";
    },
    remove() {},
  };`;
  await target.route(TURNSTILE_SCRIPT, (route) => route.fulfill({ contentType: "text/javascript", body: script }));
}

/**
 * A Web Push public key in URL-safe Base64 for the app to subscribe browsers with, standing in for the
 * server's, since the test server runs without VAPID keys. Nothing is pushed with it.
 */
export const VAPID_PUBLIC_KEY = "BP79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eDf3t3c29rZ2NfW1dTT0tHQz87NzMvKycjHxsXEw8LBwL8";

/** A browser's push subscription's keys, which nothing is pushed with either. */
export const PUSH_KEYS = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };

/** An endpoint at Chrome's push service that no other test's subscriptions have. */
export const uniqueEndpoint = () => `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;

export interface PushOptions {
  /** Where the push service takes pushes for this browser. */
  endpoint?: string;
  /** Whether the browser has turned notifications on already, which makes the room header's bell your level's. */
  on?: boolean;
}

/**
 * Lets every page in `context` show notifications, with Web Push on, which the test server's isn't,
 * and a stand-in for the browser's push service, which headless Chromium can't reach: a subscription
 * at `endpoint` that nothing is pushed to.
 */
export async function allowNotifications(context: BrowserContext, { endpoint = uniqueEndpoint(), on = true }: PushOptions = {}): Promise<void> {
  await context.grantPermissions(["notifications"]);
  await context.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...((await response.json()) as Bootstrap), vapidPublicKey: VAPID_PUBLIC_KEY } });
  });
  await context.addInitScript(standInPushService, { endpoint, on, keys: PUSH_KEYS });
}

/** The push service `allowNotifications` stands in, for each page before the app loads. */
function standInPushService({ endpoint, on, keys }: { endpoint: string; on: boolean; keys: typeof PUSH_KEYS }) {
  if (!("PushManager" in window)) return;
  // The headless shell CI runs keeps notifications denied whatever the context grants.
  Object.defineProperty(Notification, "permission", { get: () => "granted" });
  Notification.requestPermission = async () => "granted";
  let subscription: PushSubscription | null = null;
  const subscribe = (options: PushSubscriptionOptionsInit = {}) => {
    const made = { endpoint, options, toJSON: () => ({ endpoint, expirationTime: null, keys }), unsubscribe: async () => ((subscription = null), true) };
    return (subscription = made as unknown as PushSubscription);
  };
  PushManager.prototype.getSubscription = async () => subscription;
  PushManager.prototype.subscribe = async (options) => subscribe(options);
  if (!on) return;
  subscribe({ userVisibleOnly: true });
  // The service worker turning them on registered, active.
  const registration = { active: {}, pushManager: { getSubscription: async () => subscription, subscribe } };
  ServiceWorkerContainer.prototype.getRegistration = async () => registration as unknown as ServiceWorkerRegistration;
}

/** Creates an open room through the API as `session`'s person. Everyone is in it, whenever they sign in. */
export async function createRoom(request: APIRequestContext, session: Session, name: string): Promise<TestRoom> {
  const response = await request.post("/api/rooms", { data: { kind: "open", name }, headers: { Cookie: cookieHeader(session) } });
  expect(response.status(), await response.text()).toBe(201);
  const { room } = (await response.json()) as { room: TestRoom };
  return { id: room.id, name: room.name };
}

/**
 * Connects a tab's routed workspace socket to the server, passing on to the page what the server sends
 * when `passes` says so, and returns the server's end.
 */
export function connectWorkspace(ws: WebSocketRoute, passes: (frame: WorkspaceServerFrame) => boolean): WebSocketRoute {
  const server = ws.connectToServer();
  server.onMessage((message) => {
    if (passes(JSON.parse(String(message)) as WorkspaceServerFrame)) ws.send(message);
  });
  return server;
}

/**
 * Whether the workspace socket of a tab that lists just `roomIds` passes `frame` on: all but the rooms
 * saved that aren't among them, as the socket brings each room saved to everyone in it, and everyone's
 * in the rooms every other test opens to all. DMs pass, since only the test's own people are in them.
 */
export function listing(roomIds: Iterable<string>): (frame: WorkspaceServerFrame) => boolean {
  const listed = new Set(roomIds);
  return (frame) => frame.type !== "room.saved" || frame.room.kind === "direct" || listed.has(frame.room.id);
}

/** Keeps the rooms every other test saves out of the sidebars of `target`'s tabs, which list just `roomIds`. */
export async function keepOtherRoomsOut(target: Page | BrowserContext, roomIds: Iterable<string>): Promise<void> {
  const passes = listing(roomIds);
  await target.routeWebSocket(WORKSPACE_SOCKET, (ws) => void connectWorkspace(ws, passes));
}

/**
 * Makes `room` the only room in this page's sidebar, with nobody suggested for DMs, so the test starts
 * in an empty room of its own instead of among every other test's open rooms and oldest people. Given a `joinCode`, it's the room with the
 * welcome card too, inviting people with that code, and given a `huddle`, that's going on in it.
 */
export async function isolateRoom(page: Page, room: TestRoom, { joinCode, huddle }: { joinCode?: string; huddle?: LiveHuddle } = {}): Promise<void> {
  const invitation = joinCode === undefined ? null : { roomId: room.id, joinCode };
  const huddles = huddle ? { [room.id]: huddle } : {};
  await page.route("**/api/sidebar", (route) =>
    route.fulfill({ json: { rooms: [{ ...room, kind: "open", icon: null, unread: false, involvement: "mentions" }], favorites: { rooms: [], version: 0 }, sharedOrder: [], invitation, huddles } satisfies Sidebar }),
  );
  await keepOtherRoomsOut(page, [room.id]);
}

/** Which of the workspace socket's frames reach the page. */
export type Passes = (frame: WorkspaceServerFrame) => boolean;

/** Tells a page `frame` on the workspace socket it has open, as the Workspace does. */
export type Tells = (frame: WorkspaceServerFrame) => void;

/**
 * Shows `page` the workspace as `change` makes it wherever the server says what it is, its socket's
 * welcome included, without changing the test server's, which every other test shows. Its socket takes
 * over from any the page routed before, such as `isolateRoom`'s, so it passes on just what `passes` does.
 * Answers how to tell the page something more on that socket, once it's open, as the Workspace would.
 */
export async function changeTheWorkspace(page: Page, change: (account: Account) => Account, passes: Passes = () => true): Promise<Tells> {
  const changed = <T extends { account: Account }>(body: T): T => ({ ...body, account: change(body.account) });
  let socket: WebSocketRoute | undefined;
  for (const path of ["**/api/bootstrap", "**/api/account"]) {
    await page.route(path, async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      await route.fulfill({ response, json: changed(await response.json()) });
    });
  }
  await page.routeWebSocket(WORKSPACE_SOCKET, (ws) => {
    socket = ws;
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (passes(frame)) ws.send(JSON.stringify("account" in frame ? changed(frame) : frame));
    });
  });
  return (frame) => socket!.send(JSON.stringify(frame));
}

/**
 * The welcome card's invitation: the workspace's first room, the general that setup made, which every
 * open room's member is in, and the join code. Only administrators get it with their rooms, so it's
 * what they'd see: the oldest room in `session`'s sidebar, and the join link on the administrator's
 * workspace settings, since guests, as people signed in with `createSession` are, aren't given its code.
 */
export async function invitation(request: APIRequestContext, session: Session): Promise<Invitation> {
  const administrator = await administratorSession(request);
  const [sidebar, account] = await Promise.all([
    request.get("/api/sidebar", { headers: { Cookie: cookieHeader(session) } }),
    request.get("/api/account", { headers: { Cookie: cookieHeader(administrator) } }),
  ]);
  expect(sidebar.status(), await sidebar.text()).toBe(200);
  expect(account.status(), await account.text()).toBe(200);
  const [first] = ((await sidebar.json()) as Sidebar).rooms;
  expect(first, "Everyone is in general, where the welcome card is").toBeDefined();
  const { joinCode } = (await account.json()) as WorkspaceSettings;
  expect(joinCode, "Administrators are given the join code").not.toBeNull();
  return { roomId: first!.id, joinCode: joinCode! };
}

/** Opens a room and waits until its socket has connected and the history has loaded. */
export async function openRoom(page: Page, room: TestRoom): Promise<void> {
  await page.goto(`/rooms/${room.id}`);
  const timeline = page.getByRole("log", { name: `Messages in ${room.name}` });
  await expect(timeline).toBeVisible();
  await expect(timeline).not.toHaveAttribute("aria-busy");
}

/**
 * Opens `room` on a browser of the administrator's own, signing in on the way, and waits until its
 * history has loaded. Close its context afterwards.
 */
export async function administratorOn(browser: Browser, baseURL: string, room: TestRoom): Promise<Page> {
  const page = await (await browser.newContext({ baseURL })).newPage();
  await useOwnAddress(page);
  await page.goto(`/rooms/${room.id}`);
  await signInAsAdministrator(page);
  await expect(page.getByRole("log", { name: `Messages in ${room.name}` })).not.toHaveAttribute("aria-busy");
  return page;
}

/**
 * A message editor's text box, such as the composer's ("Write a message"), once Lexical has taken it
 * over. Lexxy shows the box a frame before then, and Lexical empties it as it takes over, so anything
 * typed into it sooner is lost.
 */
export function editorField(scope: Page | Locator, name: string): Locator {
  return scope.getByRole("textbox", { name }).and(scope.locator("[data-lexical-editor]"));
}

/**
 * Waits for the clock's next second, so a change after it gives an avatar or the logo a new address:
 * their versions count seconds, and a browser keeps a picture at an address a while.
 */
export async function nextSecond(): Promise<void> {
  const second = Math.floor(Date.now() / 1000);
  await expect.poll(() => Math.floor(Date.now() / 1000), { intervals: [100] }).toBeGreaterThan(second);
}

/** How the sidebar's room rows read: each row's text, with a ★ after a starred room's, whose star is a picture. */
export function rowsWithStars(rows: Locator): Promise<string[]> {
  return rows.evaluateAll((links) =>
    links.map((link) => `${link.textContent!.replace(/\s+/g, " ").trim()}${link.querySelector('[role="img"][aria-label="Favorite"]') ? "★" : ""}`),
  );
}

/** A picture `width` by `height`, drawn in `page`'s browser as a PNG, as Playwright picks a file. */
export async function drawnPicture(page: Page, name: string, width: number, height: number) {
  const bytes = await page.evaluate(
    async ([width, height]) => {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#c33";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#33c";
      context.fillRect(0, 0, width / 2, height / 2);
      return [...new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer())];
    },
    [width, height] as const,
  );
  return { name, mimeType: "image/png", buffer: Buffer.from(bytes) };
}

/** The size of the picture `image` shows, once it has loaded, and its type, as the server answers it. */
export async function shownPicture(image: Locator): Promise<{ type: string | null; width: number; height: number }> {
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete)).toBe(true);
  return image.evaluate(async (element: HTMLImageElement) => ({
    type: (await fetch(element.currentSrc)).headers.get("Content-Type"),
    width: element.naturalWidth,
    height: element.naturalHeight,
  }));
}

/**
 * Whether an opened huddle's tiles, the items of `list`, keep clear of one another, with each one's
 * avatar inside it and clear of the name under it, which only a browser's own layout says.
 */
export function huddleTilesKeepClear(list: Locator): Promise<boolean> {
  return list.evaluate((list) => {
    const apart = (a: DOMRect, b: DOMRect) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
    const tiles = [...list.children].map((tile) => ({ box: tile.getBoundingClientRect(), avatar: tile.querySelector("img")?.getBoundingClientRect(), name: tile.querySelector(":scope > span")!.getBoundingClientRect() }));
    const avatarIsFine = ({ box, avatar, name }: (typeof tiles)[number]) => !avatar || (avatar.top >= box.top && apart(avatar, name));
    return tiles.every((tile, index) => avatarIsFine(tile) && tiles.slice(index + 1).every((other) => apart(tile.box, other.box)));
  });
}

/**
 * Another person in a room, connected over a real WebSocket from the test runner. Use it to
 * seed messages and presence without driving a second browser.
 */
export class Participant {
  private waiters = new Set<(frame: ServerFrame) => boolean>();

  private constructor(
    readonly session: Session,
    private readonly socket: WebSocket,
  ) {
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      for (const waiter of this.waiters) if (waiter(frame)) this.waiters.delete(waiter);
    });
  }

  static async join(baseURL: string, session: Session, roomId: string): Promise<Participant> {
    const url = new URL(`/api/rooms/${encodeURIComponent(roomId)}/socket${roomSocketQuery({ visible: true })}`, baseURL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    // The room only takes upgrades from the app's own pages, with a session cookie.
    const headers = { Cookie: cookieHeader(session), Origin: new URL(baseURL).origin };
    const participant = new Participant(session, new NodeWebSocket(url, { headers }));
    await participant.next((frame) => frame.type === "welcome");
    return participant;
  }

  /** Posts a message, sending its text as the composer does, and resolves once the room has stored it. */
  say(text: string): Promise<Message> {
    return this.post(bodyFromPlainText(text));
  }

  /** Posts a message whose body is `body`, rich text as the composer sends it, such as a mention's, and resolves once the room has stored it. */
  async post(body: string): Promise<Message> {
    const clientMessageId = crypto.randomUUID();
    const created = this.next((frame) => frame.type === "message.created" && frame.message.clientMessageId === clientMessageId);
    this.send({ type: "message.create", clientMessageId, body });
    const frame = await created;
    return (frame as Extract<ServerFrame, { type: "message.created" }>).message;
  }

  /** Replies in the thread of the message `parentId`, and in the room too when `alsoSend`, and resolves once the room has stored it. */
  async reply(parentId: string, text: string, { alsoSend = false } = {}): Promise<Message> {
    const clientMessageId = crypto.randomUUID();
    const created = this.next((frame) => frame.type === "message.created" && frame.message.clientMessageId === clientMessageId);
    this.send({ type: "message.create", clientMessageId, body: bodyFromPlainText(text), parentId, alsoSend });
    const frame = await created;
    return (frame as Extract<ServerFrame, { type: "message.created" }>).message;
  }

  /** Posts messages back to back, without waiting for each, and resolves once the room has stored them all, in order. */
  sayAll(texts: string[]): Promise<Message[]> {
    return Promise.all(texts.map((text) => this.say(text)));
  }

  /** Reacts to a message and resolves once the room has broadcast it. */
  async boost(messageId: string, content: string): Promise<void> {
    const created = this.next((frame) => frame.type === "boost.created" && frame.boost.messageId === messageId && frame.boost.content === content);
    this.send({ type: "boost.create", messageId, content });
    await created;
  }

  close(): void {
    this.socket.close(1000);
  }

  private send(frame: ClientFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  private next(match: (frame: ServerFrame) => boolean, timeout = 10_000): Promise<ServerFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`${this.session.user.name} timed out waiting for a frame`));
      }, timeout);
      const waiter = (frame: ServerFrame) => {
        if (!match(frame)) return false;
        clearTimeout(timer);
        resolve(frame);
        return true;
      };
      this.waiters.add(waiter);
    });
  }
}

export interface AppFixtures {
  /** The signed-in user for this test. */
  session: Session;
  /** A room only this test uses, and the only one in its sidebar. */
  room: TestRoom;
  /** Connects someone else to the test's room. Disconnected when the test ends. */
  participant: (name: string) => Promise<Participant>;
  /** Fails the test if the policy blocked something on any of its pages, unless it said it would. Every test has it. */
  policyKept: void;
}

/** What Chromium logs when a page's Content-Security-Policy blocks something, which is all a browser does about it. */
const CSP_VIOLATION = /Content Security Policy/;
/** The annotation a test that means to see the policy refuse something carries, naming the directive. */
const EXPECTED_VIOLATION = "policy-violation";
/** What the policy blocked on the pages of every context this worker opened, since the test began. */
const blocked: string[] = [];
const watchPolicy = (context: BrowserContext) =>
  context.on("page", (page) => page.on("console", (message) => void (CSP_VIOLATION.test(message.text()) && blocked.push(message.text()))));

/** Says the test means to see the policy refuse something under `directive`, which otherwise fails it. */
export const expectsPolicyViolation = (directive: string) => test.info().annotations.push({ type: EXPECTED_VIOLATION, description: directive });

export const test = base.extend<AppFixtures>({
  // The Worker's policy applies to every page a test opens, in its own context or one it makes for
  // someone else, so every context the browser opens reports what the policy got in the way of,
  // which the browser only logs...
  browser: [
    async ({ browser }, use) => {
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...options) => {
        const context = await newContext(...options);
        watchPolicy(context);
        return context;
      };
      await use(browser);
    },
    { scope: "worker" },
  ],
  // ...and a test fails if it got in the way of anything, unless it said it would.
  policyKept: [
    async ({}, use, testInfo) => {
      blocked.length = 0;
      await use();
      const expected = testInfo.annotations.filter((annotation) => annotation.type === EXPECTED_VIOLATION).map((annotation) => annotation.description);
      const unexpected = blocked.filter((message) => !expected.some((directive) => message.includes(`directive: "${directive}`)));
      expect(unexpected, "The Content-Security-Policy blocked something on a page").toEqual([]);
    },
    { auto: true },
  ],
  session: async ({ request }, use) => {
    await use(await createSession(request, "Test Person"));
  },
  room: async ({ page, request, session }, use) => {
    const room = await createRoom(request, session, "general");
    await isolateRoom(page, room);
    await use(room);
  },
  participant: async ({ request, room, baseURL }, use) => {
    const joined: Participant[] = [];
    await use(async (name) => {
      const participant = await Participant.join(baseURL!, await createSession(request, name), room.id);
      joined.push(participant);
      return participant;
    });
    for (const participant of joined) participant.close();
  },
});

export { expect };
