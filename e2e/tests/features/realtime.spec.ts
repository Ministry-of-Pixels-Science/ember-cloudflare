import type { WebSocketRoute } from "@playwright/test";
import { editorField, ROOM_SOCKET } from "../../fixtures";
import { expect, test, type Member, type Members } from "./fixtures";

test.describe("Who's here", () => {
  test("shows who is in the room as people come and go", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await expect(ada.presence()).toHaveText("1 here now");

    const grace = await members.signIn("Grace");
    await expect(ada.presence()).toHaveText("2 here now");
    await expect(grace.presence()).toHaveText("2 here now");
    await expect(ada.page.getByTitle(/^(Ada, Grace|Grace, Ada)$/)).toBeVisible();

    await grace.page.close();
    await expect(ada.presence()).toHaveText("1 here now");
  });
});

test.describe("New line", () => {
  test("draws New over the first message that came while a room was unread, and none on the next visit", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.send("Before you left");
    // Grace reads general, then leaves it before the rest comes. The Workspace hears of a message a
    // moment after it's sent, so one sent just before someone joins can mark the room unread for them as
    // of it, unless they read the room after it.
    const grace = await members.signIn("Grace");
    await expect(grace.message("Before you left")).toBeVisible();
    await expect(ada.presence()).toHaveText("2 here now");
    const rows = grace.page.getByRole("region", { name: "Rooms" });
    const general = rows.getByRole("link", { name: "general" });
    const leaveGeneral = async () => {
      await rows.getByRole("link", { name: "random" }).click();
      await expect(ada.presence()).toHaveText("1 here now");
    };
    await leaveGeneral();

    await ada.send("While you were away");
    await ada.send("And another");
    await expect(general).toHaveAccessibleDescription(/^Unread/);
    await general.click();
    const newLine = grace.page.getByRole("separator", { name: "New messages" });
    const firstNew = grace.page.locator("[data-message-id]").filter({ has: newLine });
    await expect(newLine).toBeVisible();
    await expect(firstNew).toContainText("While you were away");

    // Opening it read it, so the next visit draws none, once Grace's sidebar has heard of the read.
    await leaveGeneral();
    await expect(general).not.toHaveAccessibleDescription(/^Unread/);
    await general.click();
    await expect(grace.message("And another")).toBeVisible();
    await expect(newLine).toHaveCount(0);

    // A line stays while the room is open, as more messages come. The test ends there: a room tells the
    // Workspace of a message a moment after it's sent, with who is viewing the room then, so someone who
    // leaves just after one comes can find the room unread as of it.
    await leaveGeneral();
    await ada.send("Back again");
    await expect(general).toHaveAccessibleDescription(/^Unread/);
    await general.click();
    await expect(firstNew).toContainText("Back again");
    await ada.send("Still here");
    await expect(grace.message("Still here")).toBeVisible();
    await expect(newLine).toHaveCount(1);
  });
});

test.describe("Presence", () => {
  test("counts someone with two tabs open once", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const secondTab = await grace.page.context().newPage();
    await secondTab.goto(`/rooms/${rooms.general.id}`);
    await expect(secondTab.getByText("2 here now")).toBeAttached();

    await secondTab.close();
    await expect(ada.presence()).toHaveText("2 here now");
  });
});

test.describe("Typing indicator", () => {
  test("shows who is typing until they send or clear their message", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");

    await grace.composer().fill("Let me think");
    await expect(ada.typingIndicator()).toHaveText("Grace");
    await expect(ada.typingIndicator()).toBeVisible();
    await expect(grace.typingIndicator()).toHaveText("");

    // Selected and deleted as you would. `fill("")` selects the text by script and presses Delete at
    // once, which Lexical can take before it hears of the selection, deleting nothing.
    await grace.composer().press("ControlOrMeta+a");
    await grace.composer().press("Delete");
    await expect(ada.typingIndicator()).toHaveText("");
    await expect(ada.typingIndicator()).toBeHidden();

    // Typing goes out at most once a second, even after a stop, so Grace shows again as she types on.
    await grace.composer().pressSequentially("Here's my answer", { delay: 100 });
    await expect(ada.typingIndicator()).toHaveText("Grace");
    await grace.composer().press("Enter");
    await expect(ada.typingIndicator()).toHaveText("");
  });

  test("names everyone typing, sorted and comma-separated", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const linus = await members.signIn("Linus");
    const ken = await members.signIn("Ken");

    await linus.composer().fill("…");
    await grace.composer().fill("…");
    await expect(ada.typingIndicator()).toHaveText("Grace, Linus");
    await ken.composer().fill("…");
    await expect(ada.typingIndicator()).toHaveText("Grace, Ken, Linus");
  });

  test("keeps names that don't fit on one line, clear of the message box", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 320, height: 640 } } });
    const typists: Member[] = [];
    for (const name of ["Grace Brewster Murray Hopper", "Kenneth Lane Thompson", "Linus Benedict Torvalds"]) typists.push(await members.signIn(name));
    // Everyone signs in first, as someone typing shows for only 5 seconds after they last typed.
    for (const typist of typists) await typist.composer().fill("…");
    await expect(ada.typingIndicator()).toHaveText("Grace Brewster Murray Hopper, Kenneth Lane Thompson, Linus Benedict Torvalds");

    const names = (await ada.typingIndicator().boundingBox())!;
    const field = (await ada.composer().boundingBox())!;
    expect(names.height).toBeLessThan(20);
    expect(names.y + names.height).toBeLessThanOrEqual(field.y);
  });
});

test.describe("Catch up after a reconnect", () => {
  /**
   * Routes Ada's room socket so the test can cut it, and keep it cut, like a network drop. `addresses`
   * lists the addresses it has connected to.
   */
  async function cuttable(members: Members) {
    let online = true;
    let connection: { page: WebSocketRoute; server: WebSocketRoute } | undefined;
    const addresses: URL[] = [];
    const ada = await members.signIn("Ada", {
      beforeOpen: (page) =>
        page.routeWebSocket(ROOM_SOCKET, (ws) => {
          if (!online) return ws.close();
          addresses.push(new URL(ws.url()));
          connection = { page: ws, server: ws.connectToServer() };
        }),
    });
    const cut = async () => {
      online = false;
      await connection!.server.close();
      await connection!.page.close();
      // The page knows the connection is down.
      await expect(ada.timeline()).toHaveAttribute("aria-busy", "true");
    };
    const restore = () => {
      online = true;
    };
    return { ada, cut, restore, addresses };
  }

  test("reconnects after losing the connection and catches up on what was missed", async ({ members }) => {
    const { ada, cut, restore } = await cuttable(members);
    const grace = await members.signIn("Grace");

    await cut();
    await expect(ada.connection()).toHaveText("Reconnecting…", { timeout: 10_000 });
    await expect(ada.page.getByRole("button", { name: "Send Message" })).toBeDisabled();
    await ada.composer().fill("Typed while offline");
    await expect(ada.page.getByRole("button", { name: "Send Message" })).toBeDisabled();

    await grace.send("Sent while Ada was away");
    await expect(grace.message("Sent while Ada was away")).not.toHaveAttribute("aria-busy");

    restore();
    await expect(ada.connection()).toHaveCount(0, { timeout: 20_000 });
    await expect(ada.message("Sent while Ada was away")).toBeVisible();
    await expect(ada.composer()).toHaveText("Typed while offline");
    await expect(ada.page.getByRole("button", { name: "Send Message" })).toBeEnabled();
  });

  test("catches up on edits, deletions and reactions made while it was away, asking for only what changed", async ({ members }) => {
    const { ada, cut, restore, addresses } = await cuttable(members);
    const grace = await members.signIn("Grace");
    for (const text of ["Typo heer", "Gone soon", "React to me"]) await grace.send(text);
    await expect(ada.message("React to me")).toBeVisible();

    await cut();
    await (await grace.actions("Typo heer")).getByRole("button", { name: "Edit" }).click();
    await grace.editor().fill("Typo here");
    await grace.editor().press("ControlOrMeta+Enter");
    await expect(grace.message("Typo here")).toContainText("(edited)");
    await (await grace.actions("Gone soon")).getByRole("button", { name: "Edit" }).click();
    grace.page.once("dialog", (dialog) => void dialog.accept());
    await grace.page.getByRole("button", { name: "Delete message" }).click();
    await expect(grace.message("Gone soon")).toHaveCount(0);
    await (await grace.actions("React to me")).getByRole("button", { name: "Thumbs up" }).click();
    await expect(grace.message("React to me").getByRole("img", { name: "Grace boosted 👍" })).toBeVisible();

    restore();
    await expect(ada.message("Typo here")).toContainText("(edited)", { timeout: 20_000 });
    await expect(ada.message("Gone soon")).toHaveCount(0);
    await expect(ada.message("React to me").getByRole("img", { name: "Grace boosted 👍" })).toBeVisible();
    // The page named the latest change it had heard of, Grace's third message.
    expect(addresses.map((address) => address.searchParams.get("since"))).toEqual([null, "3"]);
  });

  test("sends a message written during a short drop once the connection is back", async ({ members }) => {
    const { ada, cut, restore } = await cuttable(members);
    const grace = await members.signIn("Grace");

    await cut();
    await ada.send("Written during a short drop");
    await expect(ada.message("Written during a short drop")).toHaveAttribute("aria-busy", "true");
    await expect(ada.page.getByRole("alert")).toHaveCount(0);

    restore();
    await expect(grace.message("Written during a short drop")).toBeVisible();
    await expect(ada.message("Written during a short drop")).not.toHaveAttribute("aria-busy");
    await expect(ada.message("Written during a short drop")).toHaveCount(1);
  });

  test("sends a message written during a short drop once the connection is back, though the room was left meanwhile", async ({ members, rooms }) => {
    const { ada, cut, restore } = await cuttable(members);
    const grace = await members.signIn("Grace");
    const room = (name: string) => ada.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name });

    await cut();
    await ada.send("Written before leaving");
    await expect(ada.message("Written before leaving")).toHaveAttribute("aria-busy", "true");
    await room(rooms.random.name).click();
    await expect(ada.page.getByRole("log", { name: `Messages in ${rooms.random.name}` })).toBeVisible();

    restore();
    await expect(grace.message("Written before leaving")).toBeVisible();
    await room(rooms.general.name).click();
    await expect(ada.message("Written before leaving")).not.toHaveAttribute("aria-busy");
    for (const member of [ada, grace]) await expect(member.message("Written before leaving")).toHaveCount(1);
  });

  test("sends a reply written during a short drop once the connection is back, though the thread was closed meanwhile", async ({ members }) => {
    const { ada, cut, restore } = await cuttable(members);
    const grace = await members.signIn("Grace");
    const thread = ada.page.getByRole("complementary", { name: "Thread" });
    const replies = (member: Member) => member.message("Who has the keys?").getByRole("link", { name: /^1 reply\b/ });
    await grace.send("Who has the keys?");
    await (await ada.actions("Who has the keys?")).getByRole("link", { name: "Reply in thread" }).click();
    await expect(thread.getByRole("article").filter({ hasText: "Who has the keys?" })).toBeVisible();

    await cut();
    await editorField(thread, "Write a reply").fill("In the cupboard");
    await editorField(thread, "Write a reply").press("Enter");
    await expect(thread.getByRole("article").filter({ hasText: "In the cupboard" })).toHaveAttribute("aria-busy", "true");
    await thread.getByRole("link", { name: "Close thread" }).click();
    await expect(thread).toHaveCount(0);

    restore();
    await expect(replies(grace)).toBeVisible();
    await replies(ada).click();
    await expect(thread.getByRole("article").filter({ hasText: "In the cupboard" })).toHaveCount(1);
    await expect(thread.getByRole("article").filter({ hasText: "In the cupboard" })).not.toHaveAttribute("aria-busy");
  });
});
