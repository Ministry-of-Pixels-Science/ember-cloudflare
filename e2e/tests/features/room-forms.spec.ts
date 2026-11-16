import type { APIRequestContext, Page } from "@playwright/test";
import { cookieHeader, createRoom, createSession, ICON_CATALOG_LOADED, signInAs, type Session, type TestRoom } from "../../fixtures";
import { expect, Member, test, unique } from "./fixtures";

/** The id of the room `member` is in, from the address. */
const roomIdOf = (member: Member) => new URL(member.page.url()).pathname.split("/").pop()!;

/** Creates a private room through the API as `session`'s person, for exactly `members`. */
async function createPrivateRoom(request: APIRequestContext, session: Session, name: string, members: Session[]): Promise<TestRoom> {
  const memberIds = members.map(({ user }) => user.id);
  const response = await request.post("/api/rooms", { data: { kind: "closed", name, memberIds }, headers: { Cookie: cookieHeader(session) } });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { room: TestRoom }).room;
}

/** Whether `session`'s person can see the room `roomId`, as its settings answer. */
async function canSee(request: APIRequestContext, session: Session, roomId: string): Promise<boolean> {
  const response = await request.get(`/api/rooms/${roomId}/settings`, { headers: { Cookie: cookieHeader(session) } });
  expect([200, 404], await response.text()).toContain(response.status());
  return response.status() === 200;
}

test.describe("Create an open room", () => {
  test("makes an open room from Rooms and permissions, opens it, lists it below every other room, and lets everyone in", async ({ members, request }) => {
    const ada = await members.signIn("Ada");
    const rail = ada.page.getByRole("navigation", { name: "Workspace" });
    await expect(rail.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
    await rail.getByRole("link", { name: "Workspace" }).click();
    await expect(ada.page).toHaveURL(/\/account\/edit$/);
    await expect(ada.page).toHaveTitle("Community settings");
    await expect(rail.getByRole("link", { name: "Workspace" })).toHaveAttribute("aria-current", "page");

    await ada.page.getByRole("navigation", { name: "Community settings" }).getByRole("link", { name: "Rooms and permissions" }).click();
    await ada.page.getByRole("link", { name: "New room" }).click();
    await expect(ada.page).toHaveURL(/\/rooms\/opens\/new$/);
    await expect(ada.page).toHaveTitle("New chat room");
    const roomName = ada.page.getByRole("textbox", { name: "Room name" });
    await expect(roomName).toHaveValue("New room");
    await expect(roomName).toBeFocused();
    await expect(ada.page.getByRole("switch", { name: "Give only some access to this room" })).toBeChecked();

    const name = unique("Design");
    await roomName.fill(name);
    await roomName.press("Enter");
    await expect(ada.page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
    await expect(ada.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name })).toHaveAttribute("aria-current", "page");
    // Below general and random, though its name comes first.
    await expect(ada.page.getByRole("region", { name: "Rooms" }).getByRole("link")).toHaveText(["#general", "#random", `#${name}`]);
    await ada.connected();
    expect(await canSee(request, await createSession(request, "Grace"), roomIdOf(ada))).toBe(true);
  });
});

test.describe("Create a private room", () => {
  test("makes a private room for you and the people chosen", async ({ members, request }) => {
    const [grace, linus] = [await createSession(request, unique("Grace")), await createSession(request, unique("Linus"))];
    const ada = await members.signIn("Ada");
    await ada.page.goto("/rooms/opens/new");
    const roomName = ada.page.getByRole("textbox", { name: "Room name" });
    const name = unique("Leads");
    await roomName.fill(name);

    await ada.page.getByRole("switch", { name: "Give only some access to this room" }).click();
    await expect(ada.page).toHaveURL(/\/rooms\/closeds\/new$/);
    await expect(roomName).toHaveValue(name);
    await expect(ada.page.getByRole("switch", { name: "Give everyone access to this room" })).not.toBeChecked();
    const graceSwitch = ada.page.getByRole("switch", { name: `Give ${grace.user.name} access to this room` });
    await expect(graceSwitch).not.toBeChecked();
    await graceSwitch.click();
    await ada.page.getByRole("button", { name: "Save" }).click();

    await expect(ada.page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
    await ada.connected();
    const roomId = roomIdOf(ada);
    expect(await canSee(request, grace, roomId)).toBe(true);
    expect(await canSee(request, linus, roomId)).toBe(false);
  });
});

test.describe("Room settings page", () => {
  test("renames a room from the settings in its header", async ({ page, rooms, session }) => {
    // As the person who made this test's rooms, who can change them.
    await signInAs(page, session);
    await page.goto(`/rooms/${rooms.general.id}`);
    await new Member(page, session).connected();

    const settings = page.getByRole("link", { name: "Settings for this room" });
    await expect(settings).toHaveAttribute("title", "Conversation settings");
    await settings.click();
    await expect(page).toHaveURL(new RegExp(`/rooms/opens/${rooms.general.id}/edit$`));
    await expect(page).toHaveTitle("Edit settings for general");
    await expect(page.getByRole("heading", { level: 1, name: "Room settings" })).toBeVisible();
    // A room's settings are part of community settings.
    await expect(page.getByRole("navigation", { name: "Workspace" }).locator("[aria-current=page]")).toHaveAccessibleName("Workspace");
    await expect(page.getByRole("navigation", { name: "Community settings" }).locator("[aria-current=page]")).toHaveText("Rooms and permissions");

    const roomName = page.getByRole("textbox", { name: "Room name" });
    await expect(roomName).toHaveValue("general");
    await roomName.fill("lobby");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect(page.getByRole("heading", { level: 1, name: "lobby", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Rooms" }).getByRole("link")).toHaveText(["#lobby", "#random"]);

    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("lobby");
  });
});

test.describe("Who can change a room", () => {
  test("shows other members a room's settings with nothing to change them with", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.page.getByRole("link", { name: "Settings for this room" }).click();
    await expect(ada.page.getByRole("heading", { level: 2, name: "general" })).toBeVisible();
    await expect(ada.page.getByRole("main").getByRole("listitem").first()).toHaveText("Everyone");
    await expect(ada.page.getByRole("textbox", { name: "Room name" })).toHaveCount(0);
    await expect(ada.page.getByRole("button", { name: "Save" })).toHaveCount(0);

    // Back to Rooms and permissions.
    await ada.page.getByRole("link", { name: "Go Back" }).click();
    await expect(ada.page).toHaveURL(/\/account\/edit#channel-settings$/);
    await expect(ada.page.getByText("Community admins manage room order and permissions.")).toBeVisible();
  });

  test("goes home with an alert from the settings of a room you aren't in", async ({ members, request, rooms }) => {
    const grace = await createSession(request, "Grace");
    const secret = await createPrivateRoom(request, grace, unique("Secret"), [grace]);
    const ada = await members.signIn("Ada");
    await ada.page.goto(`/rooms/closeds/${secret.id}/edit`);
    await expect(ada.page.getByRole("alert")).toHaveText("Room not found or inaccessible");
    // Home, which is the room they were in.
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect(ada.page.getByRole("heading", { level: 1, name: "general", exact: true })).toBeVisible();
  });
});

test.describe("Add and remove private room members", () => {
  test("adds and removes a private room's people, and someone removed who has it open finds it gone", async ({ members, request }) => {
    const ada = await members.signIn(unique("Ada"), { serverRooms: true });
    const linus = await members.signIn(unique("Linus"), { serverRooms: true });
    const grace = await createSession(request, unique("Grace"));
    const leads = await createPrivateRoom(request, linus.session, unique("Leads"), [linus.session, ada.session]);
    await ada.page.goto(`/rooms/${leads.id}`);
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText(leads.name);
    await ada.connected();

    await linus.page.goto(`/rooms/closeds/${leads.id}/edit`);
    const accessFor = (name: string) => linus.page.getByRole("switch", { name: `Give ${name} access to this room` });
    await expect(accessFor(ada.name)).toBeChecked();
    await expect(accessFor(grace.user.name)).not.toBeChecked();
    await accessFor(grace.user.name).click();
    await accessFor(ada.name).click();
    await linus.page.getByRole("button", { name: "Save" }).click();
    await expect(linus.page).toHaveURL(new RegExp(`/rooms/${leads.id}$`));

    await expect(ada.page.getByRole("alert")).toHaveText("This room was deleted.");
    await expect(ada.composer()).toHaveCount(0);
    await expect(ada.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: leads.name })).toHaveCount(0);
    expect(await canSee(request, ada.session, leads.id)).toBe(false);
    expect(await canSee(request, grace, leads.id)).toBe(true);
  });

  test("goes home with an alert when you save a private room without yourself", async ({ members, request, rooms }) => {
    const ada = await members.signIn(unique("Ada"), { serverRooms: true });
    const leads = await createPrivateRoom(request, ada.session, unique("Leads"), [ada.session]);
    await ada.page.goto(`/rooms/closeds/${leads.id}/edit`);
    await ada.page.getByRole("switch", { name: `Give ${ada.name} access to this room` }).click();
    await ada.page.getByRole("button", { name: "Save" }).click();
    await expect(ada.page.getByRole("alert")).toHaveText("Room not found or inaccessible");
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect(ada.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: leads.name })).toHaveCount(0);
    expect(await canSee(request, ada.session, leads.id)).toBe(false);
  });
});

test.describe("Leave a private room", () => {
  test("leaves a private room you can't change from its settings once you confirm, which then leaves your sidebar", async ({ members, request, rooms }) => {
    const ada = await members.signIn(unique("Ada"), { serverRooms: true });
    const linus = await members.signIn(unique("Linus"), { serverRooms: true });
    const leads = await createPrivateRoom(request, linus.session, unique("Leads"), [linus.session, ada.session]);
    await ada.page.goto(`/rooms/closeds/${leads.id}/edit`);

    const asked = new Promise<string>((resolve) =>
      ada.page.once("dialog", (dialog) => {
        resolve(dialog.message());
        void dialog.accept();
      }),
    );
    await ada.page.getByRole("button", { name: `Leave ${leads.name}` }).click();
    expect(await asked).toBe("Are you sure you want to leave this room? Only someone in it who can change it can add you back.");
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect(ada.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: leads.name })).toHaveCount(0);
    await expect(ada.page.getByRole("alert")).toHaveCount(0);
    expect(await canSee(request, ada.session, leads.id)).toBe(false);
    expect(await canSee(request, linus.session, leads.id)).toBe(true);
  });
});

test.describe("Switch a room between open and private", () => {
  test("opens a private room to everyone with the Everyone switch", async ({ members, request }) => {
    const linus = await members.signIn(unique("Linus"), { serverRooms: true });
    const grace = await createSession(request, unique("Grace"));
    const leads = await createPrivateRoom(request, linus.session, unique("Leads"), [linus.session]);
    await linus.page.goto(`/rooms/closeds/${leads.id}/edit`);
    await linus.page.getByRole("switch", { name: "Give everyone access to this room" }).click();
    await expect(linus.page).toHaveURL(new RegExp(`/rooms/opens/${leads.id}/edit$`));
    await expect(linus.page.getByRole("switch", { name: "Give only some access to this room" })).toBeChecked();
    await linus.page.getByRole("button", { name: "Save" }).click();

    await expect(linus.page).toHaveURL(new RegExp(`/rooms/${leads.id}$`));
    await linus.connected();
    expect(await canSee(request, grace, leads.id)).toBe(true);
    // Its settings now open at the open room's address.
    await expect(linus.page.getByRole("link", { name: "Settings for this room" })).toHaveAttribute("href", `/rooms/opens/${leads.id}/edit`);
  });
});

test.describe("Delete a room", () => {
  test("deletes a room from its settings once you confirm, and someone with it open finds it deleted", async ({ members, request, rooms }) => {
    const ada = await members.signIn(unique("Ada"), { serverRooms: true });
    const grace = await members.signIn(unique("Grace"), { serverRooms: true });
    const design = await createRoom(request, ada.session, unique("Design"));
    await grace.page.goto(`/rooms/${design.id}`);
    await grace.connected();

    await ada.page.goto(`/rooms/opens/${design.id}/edit`);
    const remove = ada.page.getByRole("button", { name: `Delete ${design.name}` });
    // Saying no keeps the room.
    ada.page.once("dialog", (dialog) => void dialog.dismiss());
    await remove.click();
    await expect(remove).toBeEnabled();
    expect(await canSee(request, ada.session, design.id)).toBe(true);

    const asked = new Promise<string>((resolve) =>
      ada.page.once("dialog", (dialog) => {
        resolve(dialog.message());
        void dialog.accept();
      }),
    );
    await remove.click();
    expect(await asked).toBe("Are you sure you want to delete this room and all messages in it? This can’t be undone.");
    // Home, which is the room they were in before its settings.
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect(ada.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: design.name })).toHaveCount(0);
    await expect(ada.page.getByRole("alert")).toHaveCount(0);

    await expect(grace.page.getByRole("alert")).toHaveText("This room was deleted.");
    await expect(grace.composer()).toHaveCount(0);
    await expect(grace.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: design.name })).toHaveCount(0);
    expect(await canSee(request, grace.session, design.id)).toBe(false);
  });
});

test.describe("Room icon picker", () => {
  test("picks a room's icon in its settings, which its sidebar row and header then show", async ({ members, request }) => {
    const ada = await members.signIn(unique("Ada"), { serverRooms: true });
    const design = await createRoom(request, ada.session, unique("Design"));
    await ada.page.goto(`/rooms/opens/${design.id}/edit`);
    const trigger = ada.page.getByRole("button", { name: "Choose room icon" });
    await expect(trigger).toContainText("Default hashtag");
    await trigger.click();

    const picker = ada.page.getByRole("dialog", { name: "Choose a room icon" });
    await expect(picker.getByRole("status")).toHaveText("3,540 icons · 72 shown", ICON_CATALOG_LOADED);
    await picker.getByRole("tab", { name: "Iconoir" }).click();
    await expect(picker.getByRole("status")).toHaveText("1,671 icons · 72 shown");
    await picker.getByRole("searchbox", { name: "Search icons" }).fill("coffee");
    await picker.getByRole("button", { name: "Use Coffee Cup icon from Iconoir" }).click();
    await picker.getByRole("button", { name: "Use icon" }).click();
    await expect(picker).toBeHidden();
    await expect(trigger).toContainText("Coffee Cup · Iconoir");
    await ada.page.getByRole("button", { name: "Save" }).click();

    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${design.id}$`));
    const icon = '[data-icon="iconoir:regular:coffee-cup"]';
    const row = ada.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: design.name });
    await expect(row.locator(icon)).toBeVisible();
    await expect(ada.page.getByRole("navigation", { name: "Page" }).locator(icon)).toBeVisible();
    // Each icon is a file of its own, which the page fetches as it shows it.
    for (const path of ["/iconoir/icons/regular/coffee-cup.svg", "/lucide/icons/coffee.svg"]) {
      const svg = await request.get(path);
      expect(svg.status()).toBe(200);
      expect(svg.headers()["content-type"]).toContain("image/svg+xml");
      expect(await svg.text()).toContain("<svg");
    }
  });
});

test.describe("Unsaved changes guard", () => {
  /** The dialog that asks before leaving a room's form with changes. */
  const unsaved = (page: Page) => page.getByRole("dialog", { name: "Unsaved Changes" });
  /** The rail's link to workspace settings: somewhere to go from a room's form. */
  const workspaceLink = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Workspace" });
  const at = (path: string) => new RegExp(`${path}$`);

  test("asks before leaving a room's changed settings, then keeps editing, discards, points out a blank name, says a save failed, or saves", async ({ page, rooms, session }) => {
    // As the person who made this test's rooms, who can change them.
    await signInAs(page, session);
    const editPath = `/rooms/opens/${rooms.general.id}/edit`;
    await page.goto(editPath);
    const name = page.getByRole("textbox", { name: "Room name" });
    await expect(name).toHaveValue("general");
    await name.fill("A draft room");
    await workspaceLink(page).click();
    await expect(unsaved(page)).toBeVisible();
    await expect(page).toHaveURL(at(editPath));
    await expect(unsaved(page).getByRole("button", { name: "Save" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(unsaved(page)).toBeHidden();
    await expect(name).toHaveValue("A draft room");
    await workspaceLink(page).click();
    await unsaved(page).getByRole("button", { name: "Discard" }).click();
    await expect(page).toHaveURL(/\/account\/edit$/);
    // Discarded changes don't come back.
    await page.goBack();
    await expect(name).toHaveValue("general");

    await name.fill("");
    await workspaceLink(page).click();
    await unsaved(page).getByRole("button", { name: "Save" }).click();
    await expect(unsaved(page)).toBeHidden();
    await expect(name).toBeFocused();
    expect(await name.evaluate((field: HTMLInputElement) => field.validity.valueMissing)).toBe(true);
    await expect(page).toHaveURL(at(editPath));

    await name.fill("Saved from the dialog");
    const room = `**/api/rooms/${rooms.general.id}`;
    await page.route(room, (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 422, json: { error: "Refused for this test" } }) : route.fallback()));
    await workspaceLink(page).click();
    await unsaved(page).getByRole("button", { name: "Save" }).click();
    await expect(unsaved(page).getByRole("alert")).toHaveText("Your changes couldn’t be saved. Please try again, or keep editing.");
    // Behind the dialog, which hides the page from assistive tech.
    await expect(page.getByRole("textbox", { name: "Room name", includeHidden: true })).toHaveValue("Saved from the dialog");
    await expect(page).toHaveURL(at(editPath));
    await page.unroute(room);
    let writes = 0;
    page.on("request", (request) => void (request.method() === "PATCH" && writes++));
    await unsaved(page).getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(/\/account\/edit$/);
    expect(writes).toBe(1);

    await page.goto(editPath);
    await expect(name).toHaveValue("Saved from the dialog");
    await name.fill("Changed, then changed back");
    await name.fill("Saved from the dialog");
    await workspaceLink(page).click();
    await expect(page).toHaveURL(/\/account\/edit$/);
    await expect(unsaved(page)).toHaveCount(0);
  });

  test("keeps the draft through the Everyone switch, and turns Back around until you decide", async ({ page, rooms, session }) => {
    await signInAs(page, session);
    await page.goto(`/rooms/${rooms.general.id}`);
    await new Member(page, session).connected();
    await page.getByRole("link", { name: "Settings for this room" }).click();
    const name = page.getByRole("textbox", { name: "Room name" });
    await name.fill("Working draft");
    await page.getByRole("switch", { name: "Give only some access to this room" }).click();
    const closedPath = `/rooms/closeds/${rooms.general.id}/edit`;
    await expect(page).toHaveURL(at(closedPath));
    await expect(name).toHaveValue("Working draft");
    await expect(unsaved(page)).toHaveCount(0);

    const length = await page.evaluate(() => history.length);
    await page.evaluate(() => history.back());
    await expect(unsaved(page)).toBeVisible();
    await expect(page).toHaveURL(at(closedPath));
    await unsaved(page).getByRole("button", { name: "Keep editing" }).click();
    await expect(name).toHaveValue("Working draft");
    expect(await page.evaluate(() => history.length)).toBe(length);

    // The icon picker, a native dialog, which would stay above the question, closes for it.
    await page.getByRole("button", { name: "Choose room icon" }).click();
    const picker = page.getByRole("dialog", { name: "Choose a room icon" });
    await expect(picker).toBeVisible();
    await page.evaluate(() => history.back());
    await expect(unsaved(page)).toBeVisible();
    await expect(picker).toBeHidden();
    await unsaved(page).getByRole("button", { name: "Discard" }).click();
    await expect(page).toHaveURL(at(`/rooms/${rooms.general.id}`));
    await expect(page.getByRole("heading", { level: 1, name: "general", exact: true })).toBeVisible();
    await page.evaluate(() => history.forward());
    await expect(page).toHaveURL(at(closedPath));
    await expect(name).toHaveValue("general");
  });

  test("saves a change of access, and then an icon, from the dialog before going on", async ({ members, request }) => {
    const ada = await members.signIn(unique("Ada"), { serverRooms: true });
    const leads = await createPrivateRoom(request, ada.session, unique("Leads"), [ada.session]);
    const { page } = ada;
    await page.goto(`/rooms/closeds/${leads.id}/edit`);
    await page.getByRole("switch", { name: "Give everyone access to this room" }).click();
    await expect(page).toHaveURL(at(`/rooms/opens/${leads.id}/edit`));
    await workspaceLink(page).click();
    await expect(unsaved(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(unsaved(page)).toBeHidden();

    await page.getByRole("button", { name: "Choose room icon" }).click();
    const picker = page.getByRole("dialog", { name: "Choose a room icon" });
    await picker.getByRole("searchbox", { name: "Search icons" }).fill("coffee");
    await picker.getByRole("button", { name: "Use Break Room icon" }).click();
    await picker.getByRole("button", { name: "Use icon" }).click();
    await workspaceLink(page).click();
    await unsaved(page).getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(/\/account\/edit$/);

    const settings = await request.get(`/api/rooms/${leads.id}/settings`, { headers: { Cookie: cookieHeader(ada.session) } });
    expect(((await settings.json()) as { room: TestRoom }).room).toEqual({ ...leads, kind: "open", icon: "coffee" });
  });

  test("has the browser ask before a reload loses the changes, keeping them if you stay", async ({ page, rooms, session }) => {
    await signInAs(page, session);
    await page.goto(`/rooms/opens/${rooms.general.id}/edit`);
    const name = page.getByRole("textbox", { name: "Room name" });
    await name.fill("Keep this draft");
    // Reloading from the page, since Playwright's own reload waits for a load that staying cancels.
    const warning = page.waitForEvent("dialog");
    const reloading = page.evaluate(() => location.reload());
    const prompt = await warning;
    expect(prompt.type()).toBe("beforeunload");
    await prompt.dismiss();
    await reloading;
    await expect(name).toHaveValue("Keep this draft");

    await name.fill("general");
    await page.reload();
    await expect(name).toHaveValue("general");
  });

  test("saves from the dialog after you take away your own access, and never counts an ended session as saved", async ({ members, request }) => {
    const ada = await members.signIn(unique("Ada"), { serverRooms: true });
    const grace = await createSession(request, unique("Grace"));
    const leads = await createPrivateRoom(request, ada.session, unique("Leads"), [ada.session, grace]);
    const { page } = ada;
    await page.goto(`/rooms/closeds/${leads.id}/edit`);
    await page.getByRole("switch", { name: `Give ${ada.name} access to this room` }).click();
    await workspaceLink(page).click();
    const room = `**/api/rooms/${leads.id}`;
    await page.route(room, (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 401, json: { error: "Sign in to continue" } }) : route.fallback()));
    await unsaved(page).getByRole("button", { name: "Save" }).click();
    await expect(unsaved(page).getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(at(`/rooms/closeds/${leads.id}/edit`));

    await page.unroute(room);
    await unsaved(page).getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(/\/account\/edit$/);
    // Back in a room, the sidebar has it no more.
    await page.getByRole("link", { name: "Go Back" }).click();
    await expect(page.getByRole("region", { name: "Rooms" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: leads.name })).toHaveCount(0);
    expect(await canSee(request, ada.session, leads.id)).toBe(false);
    expect(await canSee(request, grace, leads.id)).toBe(true);
  });

  test("asks before opening your profile, where you log out, and opens it once the changes are discarded", async ({ members, request }) => {
    const ada = await members.signIn(unique("Ada"), { serverRooms: true });
    const design = await createRoom(request, ada.session, unique("Design"));
    const { page } = ada;
    await page.goto(`/rooms/opens/${design.id}/edit`);
    await page.getByRole("textbox", { name: "Room name" }).fill("A draft room");
    await page.getByRole("link", { name: "Your profile" }).click();
    await expect(unsaved(page)).toBeVisible();
    await unsaved(page).getByRole("button", { name: "Discard" }).click();
    await expect(page).toHaveURL(/\/users\/me\/profile$/);
    await expect(page.getByRole("heading", { level: 1, name: "Your profile" })).toBeVisible();
  });
});
