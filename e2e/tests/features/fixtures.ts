import type { Sidebar } from "@ember/protocol";
import type { APIRequestContext, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { test as app, answerChanged, cookieHeader, createRoom, createSession, editorField, expect, keepOtherRoomsOut, makeAdministrator, type Session, type TestRoom } from "../../fixtures";

export { expect };

/** A name no other test's people or rooms have, since they all share the server. */
export const unique = (name: string) => `${name} ${crypto.randomUUID().slice(0, 8)}`;

/** The rooms each test has to itself. Its browsers show these instead of the server's own. */
export interface Rooms {
  general: TestRoom;
  random: TestRoom;
}

/**
 * Makes every page in `context` list just `rooms` of the server's rooms, and any DMs, as the list loads
 * and as the workspace socket brings rooms saved since, since every other test's open rooms take everyone
 * in too, while only the test's own people are in its DMs. The server still answers first, so a session
 * it refuses gets its 401 as usual, and the welcome card's invitation is the server's, for the general
 * that setup made, which isn't listed.
 */
async function showRooms(context: BrowserContext, rooms: Rooms): Promise<void> {
  const ids = new Set(Object.values(rooms).map((room) => room.id));
  await context.route("**/api/sidebar", (route) =>
    answerChanged<Sidebar>(route, (list) => ({ ...list, rooms: list.rooms.filter((room) => room.kind === "direct" || ids.has(room.id)) })),
  );
  await keepOtherRoomsOut(context, ids);
}

/**
 * Lets a test end while its rooms list is still loading: closing the context mid-request would
 * otherwise fail the test with "Response has been disposed" or "Test ended" from `showRooms`.
 */
const stopShowingRooms = (context: BrowserContext) => context.unrouteAll({ behavior: "ignoreErrors" });

/** One signed-in person with a browser of their own. */
export class Member {
  constructor(
    readonly page: Page,
    readonly session: Session,
  ) {}

  get name(): string {
    return this.session.user.name;
  }

  composer(): Locator {
    return editorField(this.page, "Write a message");
  }

  async send(text: string): Promise<void> {
    await this.composer().fill(text);
    await this.composer().press("Enter");
  }

  /** The message whose text includes `text`. */
  message(text: string): Locator {
    return this.page.getByRole("article").filter({ hasText: text });
  }

  /** The box for editing a message in place, while one is open. */
  editor(): Locator {
    return editorField(this.page, "Edit message");
  }

  /**
   * Shows a message's action bar by hovering it, and returns the bar. It waits for the room to confirm a
   * message just sent, which has no bar until then, so the pointer doesn't come to rest on it too soon.
   * The pointer comes from the page's heading, since a bar that a click shut, as a click on the message's
   * file card does, opens again only as the pointer comes back to its message.
   */
  async actions(text: string): Promise<Locator> {
    await expect(this.message(text)).not.toHaveAttribute("aria-busy");
    await this.page.getByRole("heading", { level: 1 }).hover();
    await this.message(text).hover();
    return this.message(text).getByRole("group", { name: "Message actions" });
  }

  /**
   * The header's Connecting… or Reconnecting… badge, shown once the room's socket has been down 5 seconds,
   * rather than the bell's status, which says what a press of it did.
   */
  connection(): Locator {
    return this.page.getByRole("navigation", { name: "Page" }).getByRole("status").filter({ hasText: /^(Connecting|Reconnecting)…$/ });
  }

  /** The room's or DM's messages, busy until the room lets its socket in. */
  timeline(): Locator {
    return this.page.getByRole("log", { name: /^Messages (in|with) / });
  }

  /** What `pattern` matches in each message whose top is in view, from the top of the timeline down. */
  inView(pattern: RegExp): Promise<string[]> {
    return this.timeline().evaluate((log, source) => {
      const top = log.getBoundingClientRect().top;
      const shown = [...log.querySelectorAll("article")].filter((article) => article.getBoundingClientRect().top >= top);
      return shown.flatMap((article) => new RegExp(source).exec(article.textContent!)?.[0] ?? []);
    }, pattern.source);
  }

  /** How far the middle of `locator` is from the middle of the timeline. */
  async offCentre(locator: Locator): Promise<number> {
    const [log, box] = [await this.timeline().boundingBox(), await locator.boundingBox()];
    if (!log || !box) throw new Error("Not visible");
    return Math.abs(box.y + box.height / 2 - (log.y + log.height / 2));
  }

  /** How much of `locator` is above or below the timeline's view. */
  async outOfView(locator: Locator): Promise<number> {
    const [log, box] = [await this.timeline().boundingBox(), await locator.boundingBox()];
    if (!log || !box) throw new Error("Not visible");
    return Math.max(0, log.y - box.y) + Math.max(0, box.y + box.height - (log.y + log.height));
  }

  /** Waits until the room's history has loaded and its socket is open. */
  async connected(): Promise<void> {
    await expect(this.timeline()).toBeVisible();
    await expect(this.timeline()).not.toHaveAttribute("aria-busy");
  }

  presence(): Locator {
    return this.page.getByText(/^\d+ here now$/);
  }

  /** The names of whoever else is typing, above the composer: hidden and empty while nobody is. */
  typingIndicator(): Locator {
    return this.page.locator("footer").filter({ has: this.composer() }).locator(".spinner");
  }
}

/** Starts a DM between `member` and `others` through the API, as New direct message does, and returns its id. */
export async function startDirect(request: APIRequestContext, member: Member, others: Member[]): Promise<string> {
  const userIds = others.map(({ session }) => session.user.id);
  const response = await request.post("/api/directs", { data: { userIds }, headers: { Cookie: cookieHeader(member.session) } });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { room: { id: string } }).room.id;
}

/** Pastes `text` into the composer, and `html` if given, as Campfire's tests do. */
export const paste = (member: Member, text: string, html?: string) =>
  member.composer().evaluate(
    (content, [text, html]) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      if (html) clipboardData.setData("text/html", html);
      content.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    },
    [text, html] as const,
  );

export interface SignInOptions {
  /** Where to open the app: this test's #general by default. */
  path?: string;
  /** Options for this person's browser, such as a phone's viewport or a color scheme. */
  context?: BrowserContextOptions;
  /** Runs before the app loads, for instance to route the room socket. */
  beforeOpen?: (page: Page) => Promise<void>;
  /** Lists the server's rooms rather than this test's. */
  serverRooms?: boolean;
  /** Makes them an administrator before the app loads, as only administrators are shown the welcome card. */
  administrator?: boolean;
}

export interface Members {
  /** Signs `name` in with a browser context of their own and waits for the room to connect. */
  signIn(name: string, options?: SignInOptions): Promise<Member>;
}

export const test = app.extend<{ rooms: Rooms; members: Members }>({
  rooms: async ({ request, session }, use) => {
    await use({ general: await createRoom(request, session, "general"), random: await createRoom(request, session, "random") });
  },

  // The shared `room` is this test's #general, so `participant` posts where its members are.
  room: async ({ rooms }, use) => {
    await use(rooms.general);
  },

  // The default `page`, used by tests that start signed out, lists this test's rooms too.
  context: async ({ context, rooms }, use) => {
    await showRooms(context, rooms);
    await use(context);
    await stopShowingRooms(context);
  },

  members: async ({ browser, baseURL, request, rooms }, use) => {
    // Closing every context ends its sockets, so nobody lingers in a room after the test.
    const contexts: BrowserContext[] = [];
    await use({
      signIn: async (name, { path = `/rooms/${rooms.general.id}`, context: options, beforeOpen, serverRooms = false, administrator = false } = {}) => {
        const session = await createSession(request, name);
        if (administrator) await makeAdministrator(request, session);
        // Given the cookie signing in gives a browser, so signing out and reloading stays signed out.
        const context = await browser.newContext({ baseURL, ...options });
        await context.addCookies([session.cookie]);
        contexts.push(context);
        if (!serverRooms) await showRooms(context, rooms);
        // A link written gets no preview, pasted or typed, unless a test answers with one, so no test reaches the Internet.
        await context.route("**/api/unfurl", (route) => route.fulfill({ status: 204 }));
        const page = await context.newPage();
        await beforeOpen?.(page);
        await page.goto(path);
        const member = new Member(page, session);
        await member.connected();
        return member;
      },
    });
    await Promise.all(
      contexts.map(async (context) => {
        await stopShowingRooms(context);
        await context.close();
      }),
    );
  },
});
