import type { Room, Sidebar, WorkspaceServerFrame } from "@ember/protocol";
import type { APIRequestContext, BrowserContext, Page, WebSocketRoute } from "@playwright/test";
import { administratorSession, allowClipboard, answerChanged, connectWorkspace, cookieHeader, createRoom, downloadName, invitation, keepOtherRoomsOut, listing, makeAdministrator, rowsWithStars, signInAs, WORKSPACE_SOCKET } from "../../fixtures";
import { expect, test, unique, type Member } from "./fixtures";

/**
 * Makes every page in `context` list just the rooms `shows` picks, and any DMs, as the list loads and as
 * the workspace socket brings rooms saved since, since every other test's open rooms take everyone in
 * too. It routes the context, as `members` does, which stops routing it before closing it, so the test
 * can end while a list is still loading.
 */
async function showRoomsPicked(context: BrowserContext, shows: (room: Room) => boolean): Promise<void> {
  const picked = (room: Room) => room.kind === "direct" || shows(room);
  await context.route("**/api/sidebar", (route) => answerChanged<Sidebar>(route, (list) => ({ ...list, rooms: list.rooms.filter(picked) })));
  await context.routeWebSocket(WORKSPACE_SOCKET, (ws) => void connectWorkspace(ws, (frame) => frame.type !== "room.saved" || picked(frame.room)));
}

test.describe("Conversations sidebar", () => {
  test("lists the rooms the server says you're in", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada", { serverRooms: true });
    const sidebar = ada.page.getByRole("region", { name: "Rooms" });
    // Every other test's open rooms are listed too, so look for this test's by address.
    for (const room of Object.values(rooms)) {
      await expect(sidebar.locator(`a[href="/rooms/${room.id}"]`)).toHaveText(`#${room.name}`);
    }
  });

  test("marks the open room and switches between them", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    const links = ada.page.getByRole("region", { name: "Rooms" }).getByRole("link");
    await expect(links).toHaveText(["#general", "#random"]);
    await expect(links.first()).toHaveAttribute("aria-current", "page");

    await links.filter({ hasText: "random" }).click();
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.random.id}$`));
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("random");
    await expect(links.filter({ hasText: "random" })).toHaveAttribute("aria-current", "page");

    await ada.page.goBack();
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("general");
  });
});

test.describe("Live sidebar updates", () => {
  test("shows rooms as they're made, renamed and deleted, in everyone's sidebar at once", async ({ members, request }) => {
    const ada = await members.signIn(unique("Ada"), { serverRooms: true });
    const grace = await members.signIn(unique("Grace"), { serverRooms: true });
    const row = (name: string) => grace.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name });

    const plans = await createRoom(request, ada.session, unique("Plans"));
    await expect(row(plans.name)).toBeVisible();

    const roadmap = unique("Roadmap");
    const renamed = await request.patch(`/api/rooms/${plans.id}`, { data: { name: roadmap }, headers: { Cookie: cookieHeader(ada.session) } });
    expect(renamed.status(), await renamed.text()).toBe(200);
    await expect(row(roadmap)).toBeVisible();
    await expect(row(plans.name)).toHaveCount(0);

    const deleted = await request.delete(`/api/rooms/${plans.id}`, { headers: { Cookie: cookieHeader(ada.session) } });
    expect(deleted.status(), await deleted.text()).toBe(204);
    await expect(row(roadmap)).toHaveCount(0);
  });

  test("lists a room as it's made below every other room in everyone's sidebar, whatever its name, through a reload", async ({ members, request, rooms }) => {
    // This test's rooms, and the ones it makes, whose names end with its tag.
    const tag = crypto.randomUUID().slice(0, 8);
    const ours = (room: Room) => room.id === rooms.general.id || room.id === rooms.random.id || (room.kind !== "direct" && room.name.endsWith(tag));
    const showOurs = (page: Page) => showRoomsPicked(page.context(), ours);
    const ada = await members.signIn("Ada", { serverRooms: true, beforeOpen: showOurs });
    const grace = await members.signIn("Grace", { serverRooms: true, beforeOpen: showOurs });
    const rows = (member: Member) => member.page.getByRole("region", { name: "Rooms" }).getByRole("link");
    for (const member of [ada, grace]) await expect(rows(member)).toHaveText(["#general", "#random"]);

    // Names that come first by name.
    const annex = await createRoom(request, ada.session, `Annex ${tag}`);
    for (const member of [ada, grace]) await expect(rows(member)).toHaveText(["#general", "#random", `#${annex.name}`]);
    const aardvark = await createRoom(request, grace.session, `Aardvark ${tag}`);
    const listed = ["#general", "#random", `#${annex.name}`, `#${aardvark.name}`];
    for (const member of [ada, grace]) await expect(rows(member)).toHaveText(listed);

    await grace.page.reload();
    await expect(rows(grace)).toHaveText(listed);
  });

  test("loads the sidebar again when the tab's workspace connection comes back, for what it missed", async ({ members, request, rooms, session }) => {
    const ownRooms = listing([rooms.general.id, rooms.random.id]);
    let connection: { page: WebSocketRoute; server: WebSocketRoute } | undefined;
    let welcomed = false;
    // The sidebar loads the welcome asks for. One the Workspace answered after the rename would bring the
    // new name without the socket.
    const reloads: Promise<unknown>[] = [];
    // What the Workspace sends while this is set is lost on the way, as it is on a connection that's dropped.
    let losing = false;
    const lost: WorkspaceServerFrame[] = [];
    const ada = await members.signIn("Ada", {
      beforeOpen: (page) => {
        page.on("request", (request) => void (welcomed && new URL(request.url()).pathname === "/api/sidebar" && reloads.push(request.response())));
        return page.routeWebSocket(WORKSPACE_SOCKET, (ws) => {
          const server = connectWorkspace(ws, (frame) => {
            welcomed ||= frame.type === "welcome";
            if (losing) lost.push(frame);
            return !losing && ownRooms(frame);
          });
          connection = { page: ws, server };
        });
      },
    });
    const links = ada.page.getByRole("region", { name: "Rooms" }).getByRole("link");
    await expect(links).toHaveText(["#general", "#random"]);
    await expect.poll(() => reloads.length).toBeGreaterThan(0);
    await Promise.all(reloads);

    losing = true;
    const renamed = await request.patch(`/api/rooms/${rooms.random.id}`, { data: { name: "watercooler" }, headers: { Cookie: cookieHeader(session) } });
    expect(renamed.status(), await renamed.text()).toBe(200);
    await expect.poll(() => lost.some((frame) => frame.type === "room.saved" && frame.room.id === rooms.random.id)).toBe(true);
    losing = false;
    await expect(links).toHaveText(["#general", "#random"]);

    await connection!.server.close();
    await connection!.page.close();
    await expect(links).toHaveText(["#general", "#watercooler"]);
  });
});

test.describe("Unread rooms", () => {
  test("marks a room bold with a dot for members not in it, through a reload, until they open it in any tab", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace", { path: `/rooms/${rooms.random.id}` });
    const general = (page: Page) => page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: "general" });
    await expect(general(grace.page)).not.toHaveAccessibleDescription(/^Unread/);

    await ada.send("Lunch?");
    await expect(general(grace.page)).toHaveAccessibleDescription(/^Unread/);
    await expect(general(grace.page)).toHaveCSS("font-weight", "650");
    await expect(general(grace.page).locator("span").last()).toHaveCSS("width", "7px");

    // The server keeps the mark.
    await grace.page.reload();
    await expect(general(grace.page)).toHaveAccessibleDescription(/^Unread/);

    const secondTab = await grace.page.context().newPage();
    await secondTab.goto(`/rooms/${rooms.general.id}`);
    await expect(general(grace.page)).not.toHaveAccessibleDescription(/^Unread/);
    await expect(general(grace.page)).toHaveCSS("font-weight", "400");
  });
});

test.describe("Activity filter", () => {
  test("counts the rooms marked unread, shows only them while it's on, and a room's link turns it off", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace", { path: `/rooms/${rooms.random.id}` });
    const activity = grace.page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Activity" });
    const rows = grace.page.getByRole("region", { name: "Rooms" }).getByRole("link");
    const caughtUp = grace.page.getByText("You’re all caught up. No unread conversations.");
    await expect(activity).toHaveAttribute("title", "Show unread conversations");

    await activity.click();
    await expect(activity).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveCount(0);
    await expect(caughtUp).toBeVisible();
    // The rail marks no page while it's on.
    await expect(grace.page.getByRole("navigation", { name: "Workspace" }).locator("[aria-current]")).toHaveCount(0);

    await ada.send("Lunch?");
    await expect(activity).toHaveAccessibleDescription("1 unread");
    await expect(activity.getByText("1", { exact: true })).toHaveCSS("height", "17px");
    await expect(rows).toHaveText(["#general"]);
    await expect(caughtUp).toBeHidden();

    await rows.first().click();
    await expect(grace.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect(activity).toHaveAttribute("aria-pressed", "false");
    // The room shown counts as read, so the pill goes.
    await expect(activity).not.toHaveAttribute("aria-description");
    await expect(activity.getByText("1", { exact: true })).toBeHidden();
    await expect(rows).toHaveText(["#general", "#random"]);
  });
});

test.describe("Star rooms", () => {
  test("stars a room from its header, which every tab of yours lists first with a star, until it's unstarred", async ({ members, rooms }) => {
    const grace = await members.signIn("Grace", { path: `/rooms/${rooms.random.id}` });
    const secondTab = await grace.page.context().newPage();
    await secondTab.goto(`/rooms/${rooms.general.id}`);
    const rows = (page: Page) => page.getByRole("region", { name: "Rooms" }).getByRole("link");
    const star = grace.page.getByRole("navigation", { name: "Page" }).getByRole("button", { name: "Favorite room" });
    await expect.poll(() => rowsWithStars(rows(secondTab))).toEqual(["#general", "#random"]);
    await expect(star).toHaveAttribute("title", "Add to favorites");
    await expect(star.locator("svg path")).toHaveCSS("fill", "none");

    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await expect(star).toHaveAttribute("title", "Remove from favorites");
    await expect(star.locator("svg path")).not.toHaveCSS("fill", "none");
    await expect(star).toBeFocused();
    for (const page of [grace.page, secondTab]) {
      await expect.poll(() => rowsWithStars(rows(page))).toEqual(["#random★", "#general"]);
      await expect(rows(page).first()).toHaveAccessibleName("random Favorite");
    }

    // The server keeps it.
    await secondTab.reload();
    await expect.poll(() => rowsWithStars(rows(secondTab))).toEqual(["#random★", "#general"]);
    await expect(secondTab.getByRole("navigation", { name: "Page" }).getByRole("button", { name: "Favorite room" })).toHaveAttribute("aria-pressed", "false");

    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "false");
    for (const page of [grace.page, secondTab]) await expect.poll(() => rowsWithStars(rows(page))).toEqual(["#general", "#random"]);
  });

  test("says when a star can't be saved, under the star, and changes nothing", async ({ members, rooms }) => {
    const grace = await members.signIn("Grace", { path: `/rooms/${rooms.random.id}` });
    await grace.page.route("**/api/rooms/*/favorite", (route) => route.fulfill({ status: 503, json: { error: "Workspace unavailable" } }));
    const star = grace.page.getByRole("navigation", { name: "Page" }).getByRole("button", { name: "Favorite room" });

    await star.click();
    const note = grace.page.getByRole("status").filter({ hasText: "Couldn’t save your favorite. Please try again." });
    await expect(note).toBeVisible();
    await expect(note).toHaveCSS("width", "200px");
    // From the star's left edge, where there's room for it.
    expect((await note.boundingBox())!.x).toBeCloseTo((await star.boundingBox())!.x, 0);
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => rowsWithStars(grace.page.getByRole("region", { name: "Rooms" }).getByRole("link"))).toEqual(["#general", "#random"]);
  });
});

test.describe("Reorder starred rooms", () => {
  const rows = (page: Page) => page.getByRole("region", { name: "Rooms" }).getByRole("link");
  const status = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });

  /** Stars `roomIds` in turn, as the header's star does. */
  async function star(request: APIRequestContext, member: Member, ...roomIds: string[]) {
    for (const roomId of roomIds) {
      const starred = await request.put(`/api/rooms/${roomId}/favorite`, { data: { favorite: true }, headers: { Cookie: cookieHeader(member.session) } });
      expect(starred.status(), await starred.text()).toBe(200);
    }
  }

  test("drags a starred room held with the mouse to a new place, which every tab of yours shows and a reload keeps", async ({ members, request, rooms }) => {
    const grace = await members.signIn("Grace");
    const secondTab = await grace.page.context().newPage();
    await secondTab.goto(`/rooms/${rooms.random.id}`);
    await star(request, grace, rooms.general.id, rooms.random.id);
    for (const page of [grace.page, secondTab]) await expect.poll(() => rowsWithStars(rows(page))).toEqual(["#general★", "#random★"]);

    const from = (await rows(grace.page).last().boundingBox())!;
    const to = (await rows(grace.page).first().boundingBox())!;
    await grace.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await grace.page.mouse.down();
    await expect(status(grace.page, "Moving random. Release to save, or press Escape to cancel.")).toBeAttached();
    await grace.page.mouse.move(to.x + to.width / 2, to.y + 2, { steps: 4 });
    await expect.poll(() => rowsWithStars(rows(grace.page))).toEqual(["#random★", "#general★"]);
    await grace.page.mouse.up();
    await expect(status(grace.page, "Starred room order saved.")).toBeAttached();
    // Letting go over the room's row didn't open it.
    await expect(grace.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect.poll(() => rowsWithStars(rows(secondTab))).toEqual(["#random★", "#general★"]);

    await secondTab.reload();
    await expect.poll(() => rowsWithStars(rows(secondTab))).toEqual(["#random★", "#general★"]);
  });

  test("moves a starred room past the next with Alt and an arrow, keeping it focused", async ({ members, request, rooms }) => {
    const grace = await members.signIn("Grace");
    await star(request, grace, rooms.general.id, rooms.random.id);
    await expect.poll(() => rowsWithStars(rows(grace.page))).toEqual(["#general★", "#random★"]);
    const random = rows(grace.page).filter({ hasText: "random" });
    await expect(random).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");

    await random.focus();
    await grace.page.keyboard.press("Alt+ArrowUp");
    await expect.poll(() => rowsWithStars(rows(grace.page))).toEqual(["#random★", "#general★"]);
    await expect(random).toBeFocused();
    await expect(status(grace.page, "Starred room order saved.")).toBeAttached();

    await grace.page.keyboard.press("Alt+ArrowDown");
    await expect.poll(() => rowsWithStars(rows(grace.page))).toEqual(["#general★", "#random★"]);
    await expect(random).toBeFocused();
    await grace.page.reload();
    await expect.poll(() => rowsWithStars(rows(grace.page))).toEqual(["#general★", "#random★"]);
  });

  test("puts the stars back and says so when an order can't be saved", async ({ members, request, rooms }) => {
    const grace = await members.signIn("Grace");
    await star(request, grace, rooms.general.id, rooms.random.id);
    await expect.poll(() => rowsWithStars(rows(grace.page))).toEqual(["#general★", "#random★"]);
    await grace.page.route("**/api/sidebar/order", (route) => route.fulfill({ status: 503, json: { error: "Workspace unavailable" } }));

    await rows(grace.page).last().focus();
    await grace.page.keyboard.press("Alt+ArrowUp");
    await expect(status(grace.page, "Couldn’t save room order. Please try again.")).toBeVisible();
    await expect.poll(() => rowsWithStars(rows(grace.page))).toEqual(["#general★", "#random★"]);
  });
});

test.describe("Open a room", () => {
  test("opens the room named in the address", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada", { path: `/rooms/${rooms.random.id}` });
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("random");
  });

  test("goes home with an alert for an address naming a room that doesn't exist", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada", { path: "/rooms/nowhere" });
    await expect(ada.page.getByRole("alert")).toHaveText("Room not found or inaccessible");
    // Home, which is their oldest room, since this browser has shown them none yet.
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("general");
    await expect(ada.page).toHaveTitle("general");
  });
});

test.describe("Go back to the last room", () => {
  test("goes home to the room you were in last, as Go Back from settings does", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada", { path: `/rooms/${rooms.random.id}` });
    await ada.page.goto("/");
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.random.id}$`));
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("random");

    await ada.page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Workspace" }).click();
    await expect(ada.page).toHaveURL(/\/account\/edit$/);
    await ada.page.getByRole("link", { name: "Go Back" }).click();
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.random.id}$`));
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("random");
  });

  test("shows someone in no rooms a picture of an empty room, with their name for screen readers", async ({ page, session }) => {
    await signInAs(page, session);
    await page.route("**/api/sidebar", (route) => route.fulfill({ json: { rooms: [], favorites: { rooms: [], version: 0 }, sharedOrder: [], invitation: null, huddles: {}, blocks: { userIds: [], version: 0 } } satisfies Sidebar }));
    await keepOtherRoomsOut(page, []);
    await page.goto("/");
    await expect(page).toHaveTitle("No rooms yet");
    const main = page.getByRole("main");
    await expect(main.locator("svg")).toBeVisible();
    await expect(main).toHaveText(session.user.name);
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe("Room addresses", () => {
  test("opens the room you were put in latest at /rooms", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada", { path: "/rooms" });
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.random.id}$`));
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("random");
  });

  test("opens a room from the address for its kind, which Back then skips", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    await ada.page.goto(`/rooms/opens/${rooms.random.id}`);
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.random.id}$`));
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("random");

    await ada.page.goBack();
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("general");
  });

  test("reads /rooms/opens as a room's address, naming none", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada", { path: "/rooms/opens" });
    await expect(ada.page.getByRole("alert")).toHaveText("Room not found or inaccessible");
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
  });
});

test.describe("Open rooms everyone is in", () => {
  test("lets everyone into every room, and keeps each room's messages to itself", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada", { path: `/rooms/${rooms.random.id}` });
    const grace = await members.signIn("Grace");
    await ada.send("Only in random");
    await expect(ada.message("Only in random")).toBeVisible();
    await expect(grace.message("Only in random")).toHaveCount(0);

    await grace.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: /random/ }).click();
    await expect(grace.message("Only in random")).toBeVisible();
  });
});

test.describe("Welcome and invite card", () => {
  test("welcomes administrators to the first room with the workspace's join link", async ({ baseURL, members, request, session }) => {
    const { roomId, joinCode } = await invitation(request, session);
    const ada = await members.signIn("Ada", { path: `/rooms/${roomId}`, serverRooms: true, administrator: true });
    const log = ada.page.getByRole("log", { name: "Messages in general" });
    await expect(log.getByRole("heading", { level: 2, name: "Welcome to Ember" })).toBeVisible();
    await expect(log.getByText("To invite people to chat, share the join link below.")).toBeVisible();
    await expect(log.getByRole("textbox", { name: "Share to invite more people" })).toHaveValue(new URL(`/join/${joinCode}`, baseURL).href);
    // It takes the place of the welcome an empty room has.
    await expect(log.getByText("This is the very beginning of the room. Say hello!")).toHaveCount(0);
  });

  test("stays in the first room", async ({ members }) => {
    const ada = await members.signIn("Ada", { administrator: true });
    await expect(ada.page.getByRole("heading", { name: "Welcome to #general" })).toBeVisible();
    await expect(ada.page.getByRole("heading", { name: "Welcome to Ember" })).toHaveCount(0);
  });
});

test.describe("Welcome card for administrators, until they dismiss it", () => {
  test("shows the welcome card to administrators alone, and to a member made one at once", async ({ members, request, session }) => {
    const { roomId } = await invitation(request, session);
    const grace = await members.signIn("Grace", { path: `/rooms/${roomId}`, serverRooms: true });
    const card = grace.page.getByRole("heading", { level: 2, name: "Welcome to Ember" });
    await expect(card).toHaveCount(0);

    await makeAdministrator(request, grace.session);
    await expect(card).toBeVisible();
  });

  test("an administrator dismisses it for good, in every tab of theirs, and other administrators keep theirs", async ({ members, request, session }) => {
    const { roomId } = await invitation(request, session);
    const grace = await members.signIn("Grace", { path: `/rooms/${roomId}`, serverRooms: true, administrator: true });
    const otherTab = await grace.page.context().newPage();
    await otherTab.goto(`/rooms/${roomId}`);
    const cards = [grace.page, otherTab].map((page) => page.getByRole("heading", { level: 2, name: "Welcome to Ember" }));
    for (const card of cards) await expect(card).toBeVisible();

    const dismissed = grace.page.waitForResponse((response) => response.url().endsWith("/api/sidebar/invitation") && response.request().method() === "DELETE");
    await grace.page.getByRole("button", { name: "Dismiss welcome card" }).click();
    expect((await dismissed).status()).toBe(204);
    for (const card of cards) await expect(card).toHaveCount(0);

    await grace.page.reload();
    await grace.connected();
    await expect(cards[0]!).toHaveCount(0);
    const administrator = await administratorSession(request);
    const { invitation: theirs } = (await (await request.get("/api/sidebar", { headers: { Cookie: cookieHeader(administrator) } })).json()) as Sidebar;
    expect(theirs).toEqual({ roomId, joinCode: expect.any(String) });
  });
});

test.describe("Join link", () => {
  test("copies the join link", async ({ baseURL, members, request, session }) => {
    const { roomId, joinCode } = await invitation(request, session);
    const ada = await members.signIn("Ada", { path: `/rooms/${roomId}`, serverRooms: true, administrator: true });
    await allowClipboard(ada.page.context());
    const copy = ada.page.getByRole("button", { name: "Copy join link" });
    await copy.click();
    await expect(copy).toHaveClass(/animate-success/);
    expect(await ada.page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(`/join/${joinCode}`, baseURL).href);
  });

  test("shares the join link where the browser can share", async ({ baseURL, members, request, session }) => {
    const { roomId, joinCode } = await invitation(request, session);
    const ada = await members.signIn("Ada", {
      path: `/rooms/${roomId}`,
      serverRooms: true,
      administrator: true,
      beforeOpen: async (page) => {
        await page.addInitScript(() => {
          Object.defineProperties(Navigator.prototype, {
            canShare: { value: () => true, configurable: true },
            share: { value: async (data: ShareData) => void ((window as unknown as { shared: ShareData }).shared = data), configurable: true },
          });
        });
      },
    });
    await ada.page.getByRole("button", { name: "Share join link" }).click();
    // The stand-in for the system's share sheet kept what the page shared.
    await expect.poll(() => ada.page.evaluate(() => (window as unknown as { shared?: ShareData }).shared)).toEqual({
      title: "Link to join Ember",
      text: "Hit this link to join me in Ember and start chatting.",
      url: new URL(`/join/${joinCode}`, baseURL).href,
    });
  });

  test("offers only Copy where the browser can't share", async ({ members, request, session }) => {
    const { roomId } = await invitation(request, session);
    const ada = await members.signIn("Ada", {
      path: `/rooms/${roomId}`,
      serverRooms: true,
      administrator: true,
      beforeOpen: async (page) => {
        await page.addInitScript(() => {
          const navigator = Navigator.prototype as Partial<Navigator>;
          delete navigator.canShare;
          delete navigator.share;
        });
      },
    });
    await expect(ada.page.getByRole("button", { name: "Copy join link" })).toBeVisible();
    await expect(ada.page.getByRole("button", { name: "Share join link" })).toHaveCount(0);
  });
});

test.describe("QR codes for links", () => {
  test("opens the join link's QR code in the image viewer", async ({ baseURL, members, request, session }) => {
    const { roomId, joinCode } = await invitation(request, session);
    const ada = await members.signIn("Ada", { path: `/rooms/${roomId}`, serverRooms: true, administrator: true });
    // The join link as padded URL-safe base64.
    const qrCode = `/qr_code/${Buffer.from(new URL(`/join/${joinCode}`, baseURL).href).toString("base64").replace(/\+/g, "-").replace(/\//g, "_")}`;
    const show = ada.page.getByRole("link", { name: "Show join link QR code" });
    await expect(show).toHaveAttribute("href", qrCode);

    const drawn = ada.page.waitForResponse((response) => new URL(response.url()).pathname === qrCode);
    await show.click();
    const response = await drawn;
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/svg+xml; charset=utf-8");
    const viewer = ada.page.getByRole("dialog", { name: "Image Viewer (Press escape to close)" });
    await expect(viewer.locator(`img[src="${qrCode}"]`)).toBeVisible();
    await expect(viewer.getByRole("link", { name: "Download file" })).toHaveAttribute("href", qrCode);
    await expect(viewer.getByRole("button", { name: "Close image viewer" })).toBeFocused();

    // It saves the code and stays open.
    const download = ada.page.waitForEvent("download");
    await viewer.getByRole("link", { name: "Download file" }).click();
    expect(downloadName(await download)).toBe("QR code.svg");
    await expect(viewer).toBeVisible();
    expect(new URL(ada.page.url()).pathname).toBe(`/rooms/${roomId}`);

    await ada.page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(show).toBeFocused();

    await show.click();
    await viewer.getByRole("button", { name: "Close image viewer" }).click();
    await expect(viewer).toBeHidden();
    await expect(viewer.locator("img[src^='/qr_code/']")).toHaveCount(0);
  });
});
