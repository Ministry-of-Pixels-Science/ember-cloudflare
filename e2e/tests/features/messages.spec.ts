import { MAX_MESSAGE_LENGTH, type ServerFrame } from "@ember/protocol";
import type { Locator, Page } from "@playwright/test";
import { administratorOn, allowClipboard, editorField, ROOM_SOCKET } from "../../fixtures";
import { expect, test, type Member } from "./fixtures";

const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("Not visible");
  return rect;
};

/** Opens the room as if each message `times` names, by id, was written when it says, by rewriting the room's welcome. */
const writtenAt = (times: Map<string, string>) => (page: Page) =>
  page.routeWebSocket(ROOM_SOCKET, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((frame) => {
      const parsed = JSON.parse(String(frame)) as ServerFrame;
      if (parsed.type !== "welcome") return ws.send(frame);
      const messages = parsed.messages.map((message) => ({ ...message, createdAt: times.get(message.id) ?? message.createdAt }));
      ws.send(JSON.stringify({ ...parsed, messages }));
    });
  });

/** A message's More actions, while it's open. */
const moreActions = (message: Locator) => message.getByRole("group", { name: "More actions" });

/** Hovers the message that says `text`, then clicks Message options, the bar's last button, and returns More actions. */
async function openMoreActions(member: Member, text: string): Promise<Locator> {
  await member.actions(text);
  await member.message(text).getByRole("button", { name: "Message options" }).click();
  return moreActions(member.message(text));
}

/** The day separator just above the message that says `text`, if it has one. */
const separatorAbove = (member: Member, text: string) => member.message(text).locator("xpath=preceding-sibling::h2");

test.describe("Send a message", () => {
  test("delivers a message to everyone in the room as it's sent", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");

    await ada.send("Hello, Grace");
    await expect(ada.composer()).toHaveText("");
    await expect(grace.message("Hello, Grace")).toContainText("Ada");
    await expect(ada.message("Hello, Grace")).toBeVisible();
  });

  test("keeps messages for people who come in later", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.send("For whoever's next");
    await expect(ada.message("For whoever's next")).not.toHaveAttribute("aria-busy");

    const grace = await members.signIn("Grace");
    await expect(grace.message("For whoever's next")).toBeVisible();
  });
});

test.describe("Keyboard shortcuts", () => {
  test("lists them on Cmd+/ or Ctrl+/ from the composer, and gives the composer back on Escape", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().click();
    await ada.page.keyboard.press("ControlOrMeta+/");
    const dialog = ada.page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("region", { name: "Write a message" })).toContainText("Add a link");

    await ada.page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(ada.composer()).toBeFocused();
    await expect(ada.composer()).toHaveText("");
  });
});

test.describe("See your message before it's saved", () => {
  test("shows your message straight away and settles it when the room confirms", async ({ members }) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const ada = await members.signIn("Ada", {
      // Hold the room's confirmation back until the test has looked at the unconfirmed message.
      beforeOpen: (page) =>
        page.routeWebSocket(ROOM_SOCKET, (ws) => {
          const server = ws.connectToServer();
          server.onMessage(async (frame) => {
            if (String(frame).includes('"message.created"')) await held;
            ws.send(frame);
          });
        }),
    });
    await ada.send("Sending…");
    await expect(ada.message("Sending…")).toHaveAttribute("aria-busy", "true");

    release();
    await expect(ada.message("Sending…")).not.toHaveAttribute("aria-busy");
  });

  test("says when the room refuses a message", async ({ members }) => {
    const ada = await members.signIn("Ada", {
      beforeOpen: (page) =>
        page.routeWebSocket(ROOM_SOCKET, (ws) => {
          const server = ws.connectToServer();
          ws.onMessage((frame) => {
            const parsed = JSON.parse(String(frame)) as { type: string; clientMessageId?: string };
            if (parsed.type !== "message.create") return server.send(frame);
            ws.send(JSON.stringify({ type: "error", message: "Something went wrong", clientMessageId: parsed.clientMessageId }));
          });
        }),
    });
    await ada.send("Doomed");
    await expect(ada.message("Doomed")).toContainText("Not sent");
    await expect(ada.page.getByRole("alert")).toContainText("Something went wrong");
    await ada.page.getByRole("alert").getByRole("button", { name: "Dismiss" }).click();
    await expect(ada.page.getByRole("alert")).toHaveCount(0);
  });
});

test.describe("Message rows", () => {
  test("lines every message up the same way, your own included", async ({ members, participant }) => {
    await (await participant("Grace")).say("From Grace");
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1280, height: 800 } } });
    await ada.send("From Ada");
    await expect(ada.message("From Ada")).not.toHaveAttribute("aria-busy");
    const log = await box(ada.page.getByRole("log"));

    for (const [text, author] of [
      ["From Grace", "Grace"],
      ["From Ada", "Ada"],
    ] as const) {
      const row = ada.message(text);
      const avatar = await box(row.locator("[aria-hidden=true]").first());
      expect(avatar.width).toBe(36);
      expect(avatar.height).toBe(36);
      expect(avatar.x - log.x).toBe(20);
      await expect(row.locator("[aria-hidden=true]").first()).toHaveCSS("border-radius", "6px");

      const name = row.getByText(author, { exact: true });
      expect((await box(name)).x - (avatar.x + avatar.width)).toBe(8);
      await expect(name).toHaveCSS("font-size", "15px");
      await expect(name).toHaveCSS("font-weight", "700");
      // An h3, its letters spaced as Ember's other headings are.
      await expect(row.getByRole("heading", { level: 3 })).toHaveCSS("letter-spacing", "-0.375px");
      await expect(row.locator("time")).toHaveCSS("font-size", "12px");
      const body = row.getByText(text, { exact: true });
      await expect(body).toHaveCSS("font-size", "15px");
      await expect(body).toHaveCSS("line-height", "22px");
    }
  });

  test("leaves 12px above a new author's message and 8px between one person's", async ({ members, participant }) => {
    await (await participant("Grace")).sayAll(["Grace starts", "Grace goes on"]);
    const ada = await members.signIn("Ada");
    await ada.send("Ada answers");
    await expect(ada.message("Ada answers")).not.toHaveAttribute("aria-busy");
    const text = (message: string) => ada.message(message).locator(".message-content");
    // From the bottom of one message's text to the top of the next one's first line, which is its author's
    // name where it starts a run.
    const gap = async (above: Locator, below: Locator) => {
      const [upper, lower] = [await box(above), await box(below)];
      return lower.y - (upper.y + upper.height);
    };

    await expect.poll(() => gap(text("Grace starts"), text("Grace goes on"))).toBe(8);
    await expect.poll(() => gap(text("Grace goes on"), ada.message("Ada answers").getByRole("heading", { level: 3 }))).toBe(12);
  });

  test("tints the row under the pointer without moving anything, in light and dark", async ({ members, participant }) => {
    await (await participant("Grace")).say("Point at me");
    for (const [colorScheme, tint] of [
      ["light", "rgb(248, 248, 248)"],
      ["dark", "rgb(32, 32, 32)"],
    ] as const) {
      const ada = await members.signIn("Ada", { context: { colorScheme } });
      const row = ada.message("Point at me");
      const body = row.getByText("Point at me", { exact: true });
      const before = await box(body);
      await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

      await row.hover();
      await expect(row, colorScheme).toHaveCSS("background-color", tint);
      expect(await box(body)).toEqual(before);
    }
  });

  test("uses a smaller avatar on phones and wraps long words", async ({ members, participant }) => {
    const long = "x".repeat(300);
    await (await participant("Grace")).say(long);
    const ada = await members.signIn("Ada", { context: phone });
    const row = ada.message(long);
    const avatar = await box(row.locator("[aria-hidden=true]").first());
    expect(avatar.width).toBe(30);
    expect(avatar.x).toBe(12);
    expect((await box(row.getByText("Grace", { exact: true }))).x - (avatar.x + avatar.width)).toBe(10);

    const text = await box(row.getByText(long, { exact: true }));
    expect(text.x + text.width).toBeLessThanOrEqual(390);
    expect(await ada.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test.describe("Rich text, safely", () => {
  test("shows each line of a message on a line of its own", async ({ members, participant }) => {
    await (await participant("Grace")).say("First line\nSecond line");
    const ada = await members.signIn("Ada");
    const paragraph = ada.message("First line").locator(".message-content p");
    await expect(paragraph).toHaveCount(1);
    expect(await paragraph.evaluate((p) => (p as HTMLElement).innerText)).toBe("First line\nSecond line");
    expect((await box(paragraph)).height).toBe(44);
  });
});

test.describe("Links in message text", () => {
  test("links addresses, opening other sites in a new tab and this site's pages in place", async ({ members, rooms, baseURL }) => {
    const ada = await members.signIn("Ada");
    const random = `${baseURL}/rooms/${rooms.random.id}`;
    await ada.send(`Read https://example.com/docs, then ${random}`);
    const message = ada.message("Read https://example.com/docs");
    const external = message.getByRole("link", { name: "https://example.com/docs" });
    await expect(external).toHaveAttribute("href", "https://example.com/docs");
    await expect(external).toHaveAttribute("target", "_blank");
    await expect(external).toHaveCSS("text-decoration-line", "underline");

    // A page load would forget this.
    await ada.page.evaluate(() => Object.assign(window, { stayed: true }));
    await message.getByRole("link", { name: random }).click();
    await expect(ada.page).toHaveURL(random);
    await expect(ada.page.getByRole("log", { name: `Messages in ${rooms.random.name}` })).toBeVisible();
    expect(await ada.page.evaluate(() => "stayed" in window)).toBe(true);
  });
});

test.describe("Emoji-only messages", () => {
  test("shows a message of nothing but emoji large", async ({ members, participant }) => {
    const grace = await participant("Grace");
    await grace.say("😄🤘");
    await grace.say("Haha! 😄🤘");
    const ada = await members.signIn("Ada");
    const content = (text: RegExp) => ada.page.locator(".message-content").filter({ hasText: text });
    // 2.24 times 15px, which WebKit gives as the nearest float, 33.599998px.
    const fontSize = (text: RegExp) => content(text).evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    await expect.poll(() => fontSize(/^😄🤘$/)).toBeCloseTo(33.6, 4);
    await expect(content(/^Haha! 😄🤘$/)).toHaveCSS("font-size", "15px");
  });
});

test.describe("Times on follow-up messages", () => {
  test("shows a follow-up's time only on hover or focus, and always shows the first message's", async ({ members, participant }) => {
    const grace = await participant("Grace");
    await grace.say("First");
    const followUp = await grace.say("Follow-up");
    await grace.boost(followUp.id, "👍");
    const ada = await members.signIn("Ada");

    // The time's wrapper fades it in, so check what it shows rather than whether it's in the page.
    const shown = (text: string) => ada.message(text).locator("time").locator("..");
    await expect(shown("First")).toHaveCSS("opacity", "1");
    await expect(shown("Follow-up")).toHaveCSS("opacity", "0");

    const body = ada.message("Follow-up").getByText("Follow-up", { exact: true });
    const before = await box(body);
    await ada.message("Follow-up").hover();
    await expect(shown("Follow-up")).toHaveCSS("opacity", "1");
    expect(await box(body)).toEqual(before);
    // After the text, beside it.
    const time = await box(ada.message("Follow-up").locator("time"));
    expect(time.x).toBeGreaterThan(before.x + before.width);
    expect(time.y).toBeLessThan(before.y + before.height);

    await ada.composer().hover();
    await expect(shown("Follow-up")).toHaveCSS("opacity", "0");
    await ada.message("Follow-up").getByRole("button", { name: "Add a boost" }).focus();
    await expect(shown("Follow-up")).toHaveCSS("opacity", "1");
  });

  test("links each time to its message, which following goes to in place", async ({ members, participant, baseURL }) => {
    const message = await (await participant("Grace")).say("Link to me");
    const ada = await members.signIn("Ada");
    const link = ada.message("Link to me").getByRole("link").filter({ has: ada.page.locator("time") });
    const permalink = `${baseURL}/rooms/${encodeURIComponent(message.roomId)}/@${encodeURIComponent(message.id)}`;
    await expect(link).toHaveAttribute("href", new URL(permalink).pathname);

    // A page load would forget this.
    await ada.page.evaluate(() => Object.assign(window, { stayed: true }));
    await link.click();
    await expect(ada.page).toHaveURL(permalink);
    expect(await ada.page.evaluate(() => "stayed" in window)).toBe(true);
  });
});

test.describe("Day separators", () => {
  test("dates each day's first message in the reader's time zone, with its date and time on hover", async ({ members, participant }) => {
    const grace = await participant("Grace");
    const times = new Map<string, string>();
    // Two hours apart on the 15th in UTC, but either side of midnight in Los Angeles.
    for (const [text, at] of [
      ["Late on the 14th", "2026-10-15T06:30:00Z"],
      ["Early on the 15th", "2026-10-15T08:30:00Z"],
    ] as const) {
      times.set((await grace.say(text)).id, at);
    }
    const ada = await members.signIn("Ada", { context: { timezoneId: "America/Los_Angeles", locale: "en-US" }, beforeOpen: writtenAt(times) });

    await expect(separatorAbove(ada, "Late on the 14th")).toHaveText("October 14, 2026");
    const separator = separatorAbove(ada, "Early on the 15th");
    await expect(separator).toHaveText("October 15, 2026");
    await expect(separator.locator("time")).toHaveAttribute("title", "10/15/26, 1:30 AM");
    // 14px bold, as written rather than in capitals, in a pill between two rules.
    await expect(separator).toHaveCSS("font-size", "14px");
    await expect(separator).toHaveCSS("font-weight", "700");
    await expect(separator).toHaveCSS("text-transform", "none");
    await expect(separator.locator("time")).toHaveCSS("border-radius", "14px");
  });
});

test.describe("Message action bar", () => {
  const bar = (message: Locator) => message.getByRole("group", { name: "Message actions" });

  test("opens over the top edge of the message the pointer crosses, without moving anything, one at a time", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1311, height: 900 } } });
    await ada.send("Hover over this message.");
    await ada.send("And then this message.");
    const first = ada.message("Hover over this message.");
    const second = ada.message("And then this message.");
    await expect(second).not.toHaveAttribute("aria-busy");
    const elsewhere = ada.page.getByRole("heading", { level: 1 });
    await elsewhere.hover();
    const text = first.locator(".message-content");
    const before = await box(text);

    await first.hover();
    await expect(bar(first)).toBeVisible();
    expect(await box(text)).toEqual(before);
    const bounds = await box(bar(first));
    const row = await box(first);
    const pane = await box(ada.timeline());
    expect(bounds).toMatchObject({ width: 234, height: 42 });
    expect(pane.x + pane.width - bounds.x - bounds.width).toBe(16);
    expect(row.y - bounds.y).toBe(17);
    // Message options is the bar's last button, and the bar overlaps the row rather than floating above it.
    const options = await box(first.getByRole("button", { name: "Message options" }));
    expect(options.x >= bounds.x && options.x + options.width <= bounds.x + bounds.width).toBe(true);
    expect(options.y >= bounds.y && options.y + options.height <= bounds.y + bounds.height).toBe(true);
    expect(bounds.y < row.y + row.height && bounds.y + bounds.height >= row.y + 12).toBe(true);

    // The pointer can cross to the bar, and back to its message.
    await ada.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 8 });
    await ada.page.waitForTimeout(250);
    await expect(bar(first)).toBeVisible();
    await first.hover();
    await ada.page.waitForTimeout(250);
    await expect(bar(first)).toBeVisible();

    await second.hover();
    await expect(bar(second)).toBeVisible();
    await expect(bar(first)).toBeHidden();
    const secondRow = await box(second);
    const secondBounds = await box(bar(second));
    const barMiddle = secondBounds.y + secondBounds.height / 2;
    expect(barMiddle >= secondRow.y + 3 && barMiddle <= secondRow.y + 5).toBe(true);
    // However slowly the pointer goes, the bar doesn't count on the moment it waits after the pointer leaves.
    const start = { x: (await box(second.locator(".message-content"))).x + 40, y: secondRow.y + Math.min(12, secondRow.height / 2) };
    const end = { x: secondBounds.x + 20, y: barMiddle };
    for (let step = 1; step <= 8; step++) {
      await ada.page.mouse.move(start.x + ((end.x - start.x) * step) / 8, start.y + ((end.y - start.y) * step) / 8);
      await ada.page.waitForTimeout(100);
      expect(await bar(second).isVisible()).toBe(true);
    }
    await expect(ada.page.getByRole("group", { name: "Message actions" })).toHaveCount(1);
    await elsewhere.hover();
    await expect(bar(second)).toBeHidden();
  });

  test("names each button in a tooltip above it as the pointer reaches it, and shuts it as the pointer leaves", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1311, height: 900 } } });
    await ada.send("Name your buttons.");
    const actions = await ada.actions("Name your buttons.");
    for (const [role, name] of [["button", "Clapping"], ["button", "More reactions"], ["link", "Reply in thread"], ["button", "Edit"]] as const) {
      const control = actions.getByRole(role, { name });
      await control.hover();
      // The last button's may still be fading out beside it.
      const tooltip = ada.page.getByRole("tooltip", { name });
      await expect(tooltip).toBeVisible();
      await tooltip.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
      const [tip, under] = [await box(tooltip), await box(control)];
      expect(tip.y + tip.height).toBeLessThanOrEqual(under.y);
      expect(Math.abs(tip.x + tip.width / 2 - (under.x + under.width / 2))).toBeLessThan(1);
    }
    await ada.page.getByRole("heading", { level: 1 }).hover();
    await expect(ada.page.getByRole("tooltip")).toHaveCount(0);
  });

  test("opens from Message options by keyboard, staying open without the pointer, until Escape", async ({ members, participant }) => {
    await (await participant("Grace")).say("Reach me by keyboard");
    const ada = await members.signIn("Ada");
    const message = ada.message("Reach me by keyboard");
    const options = message.getByRole("button", { name: "Message options" });

    await ada.composer().focus();
    // Back past the formatting row, which is one stop.
    await ada.page.keyboard.press("Shift+Tab");
    await ada.page.keyboard.press("Shift+Tab");
    await expect(options).toBeFocused();
    // Focus shows Message options, not the bar.
    await expect(options).toHaveCSS("opacity", "1");
    await expect(bar(message)).toBeHidden();
    await ada.page.keyboard.press("Enter");
    await expect(bar(message)).toBeVisible();
    await expect(options).toHaveAttribute("aria-expanded", "true");
    await ada.page.getByRole("heading", { level: 1 }).hover();
    await ada.page.waitForTimeout(250);
    await expect(bar(message)).toBeVisible();
    await ada.page.keyboard.press("Escape");
    await expect(bar(message)).toBeHidden();
    await expect(options).toBeFocused();

    await ada.page.keyboard.press("Enter");
    await ada.page.keyboard.press("Tab");
    await expect(bar(message).getByRole("button", { name: "Thumbs up" })).toBeFocused();
    // Focus names nothing, as the pointer does, so Escape goes on shutting the bar.
    await expect(ada.page.getByRole("tooltip")).toHaveCount(0);
    await ada.page.keyboard.press("Enter");
    await expect(message.getByRole("list", { name: "Reactions" })).toContainText("👍");
    // Sending a reaction closes the bar and hands focus back to Message options.
    await expect(bar(message)).toBeHidden();
    await expect(options).toBeFocused();
  });

  test("keeps the bar on its row as the tray of more reactions opens, and Escape closes the tray, then the bar", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1311, height: 900 } } });
    await ada.send("A compact set of message actions.");
    const message = ada.message("A compact set of message actions.");
    await expect(message).not.toHaveAttribute("aria-busy");
    const actions = await ada.actions("A compact set of message actions.");
    const quick = actions.getByRole("group", { name: "Quick reactions" });
    const more = actions.getByRole("button", { name: "More reactions" });
    const tray = message.getByRole("group", { name: "More reactions" });
    await expect(quick.getByRole("button")).toHaveCount(3);
    await expect(more.locator("svg")).toHaveCount(1);
    await expect(tray).toBeHidden();
    const bounds = await box(actions);
    expect(bounds.width < 300 && bounds.height < 52).toBe(true);
    const quickBefore = await box(quick);

    await more.click();
    await expect(tray).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(tray).toContainText("More reactions");
    expect(Math.abs((await box(quick)).y - quickBefore.y)).toBeLessThan(1);
    expect((await box(tray)).y).toBeGreaterThan(quickBefore.y);
    // The tray opens at its first reaction, as Reply in thread and Edit follow More reactions on the bar.
    await expect(tray.getByRole("button", { name: "Muscle" })).toBeFocused();
    // The click shut the tooltip that named More reactions as the pointer reached it, which takes Escape until it has faded.
    await expect(ada.page.getByRole("tooltip")).toHaveCount(0);
    await ada.page.keyboard.press("Escape");
    await expect(tray).toBeHidden();
    await expect(more).toBeFocused();
    await ada.page.keyboard.press("Escape");
    await expect(actions).toBeHidden();
    await expect(message.getByRole("button", { name: "Message options" })).toBeFocused();

    // A reaction from the tray closes it too, with the pointer away, which would open it again.
    await ada.page.getByRole("heading", { level: 1 }).hover();
    await ada.page.keyboard.press("Enter");
    await expect(actions).toBeVisible();
    await more.press("Enter");
    await tray.getByRole("button", { name: "Fire" }).press("Enter");
    await expect(message.getByRole("list", { name: "Reactions" })).toContainText("🔥");
    await expect(actions).toBeHidden();
    await expect(message.getByRole("button", { name: "Message options" })).toBeFocused();

    // A click anywhere else closes it.
    await ada.page.keyboard.press("Enter");
    await expect(actions).toBeVisible();
    await ada.page.getByRole("heading", { level: 1 }).click();
    await expect(actions).toBeHidden();
  });

  test("sits on the edge of a follow-up's code block rather than over its Copy code", async ({ members, participant }) => {
    const grace = await participant("Grace");
    await grace.say("Deploy it with this");
    await grace.post(`<pre>${"wrangler deploy --env production --minify ".repeat(4)}</pre>`);
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1311, height: 900 } } });
    const message = ada.message("wrangler deploy");
    const block = message.locator(".code-block");
    const copy = block.getByRole("button", { name: "Copy code" });
    await ada.page.getByRole("heading", { level: 1 }).hover();
    await block.hover();
    await expect(bar(message)).toBeVisible();
    await expect(copy).toHaveCSS("opacity", "1");

    // Copy code is in the bar's span, so the bar rises from 17px above the row to the block's top edge.
    const bounds = await box(bar(message));
    const button = await box(copy);
    expect(button.x < bounds.x + bounds.width && button.x + button.width > bounds.x).toBe(true);
    expect(bounds.y + bounds.height).toBeCloseTo((await box(block)).y, 0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(button.y);
    const options = await box(message.getByRole("button", { name: "Message options" }));
    expect(options.y >= bounds.y && options.y + options.height <= bounds.y + bounds.height).toBe(true);

    // The pointer can still cross to the bar.
    await ada.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 8 });
    await ada.page.waitForTimeout(250);
    await expect(bar(message)).toBeVisible();
  });

  test("keeps the bar on its row as a message above grows, as when someone reacts to it", async ({ members, participant }) => {
    const grace = await participant("Grace");
    const above = await grace.say("React to me");
    await grace.say("Keep my actions open");
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1311, height: 900 } } });
    const message = ada.message("Keep my actions open");
    const actions = await ada.actions("Keep my actions open");
    // Message options keeps it open as the pointer goes.
    await message.getByRole("button", { name: "Message options" }).click();
    await ada.page.getByRole("heading", { level: 1 }).hover();
    const before = await box(message);

    await grace.boost(above.id, "👍");
    await expect(ada.message("React to me").getByRole("list", { name: "Reactions" })).toBeVisible();
    const row = await box(message);
    expect(row.y).toBeGreaterThan(before.y);
    await expect(actions).toBeVisible();
    expect(row.y - (await box(actions)).y).toBe(17);
  });

  test("opens the tray above a bar near the composer, keeping the bar where it was", async ({ members, participant }) => {
    const grace = await participant("Grace");
    for (let i = 1; i <= 8; i++) await grace.say(`Earlier message ${i}`);
    await grace.say("Near the composer");
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1311, height: 500 } } });
    const message = ada.message("Near the composer");
    const actions = await ada.actions("Near the composer");
    const quick = await box(actions.getByRole("group", { name: "Quick reactions" }));
    await actions.getByRole("button", { name: "More reactions" }).click();
    const tray = await box(message.getByRole("group", { name: "More reactions" }));
    expect(Math.abs((await box(actions.getByRole("group", { name: "Quick reactions" }))).y - quick.y)).toBeLessThan(1);
    expect(tray.y).toBeLessThan(quick.y);
    expect(tray.y).toBeGreaterThanOrEqual((await box(ada.timeline())).y);
  });

  test("opens the bar beside a 44px Message options button on touch screens, inside the timeline at 390 and 320 wide", async ({ members, participant }) => {
    const grace = await participant("Grace");
    for (let i = 1; i <= 12; i++) await grace.say(`Earlier message ${i}`);
    await grace.say("Tap for options");
    const ada = await members.signIn("Ada", { context: { ...phone, colorScheme: "dark" } });
    const message = ada.message("Tap for options");
    const options = message.getByRole("button", { name: "Message options" });
    for (const width of [390, 320]) {
      await ada.page.setViewportSize({ width, height: width === 320 ? 620 : 844 });
      await ada.timeline().evaluate((log) => (log.scrollTop = log.scrollHeight));
      expect(await box(options)).toMatchObject({ width: 44, height: 44 });
      await options.tap();
      await expect(options).toHaveAttribute("aria-expanded", "true");
      await bar(message).getByRole("button", { name: "More reactions" }).tap();
      await expect(message.getByRole("group", { name: "More reactions" })).toBeVisible();
      const bounds = await box(bar(message));
      const timeline = await box(ada.timeline());
      const trigger = await box(options);
      expect(bounds.x).toBeGreaterThanOrEqual(7);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 7);
      expect(bounds.y).toBeGreaterThanOrEqual(timeline.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(timeline.y + timeline.height);
      // It goes below Message options, or above when there's no room below, as here at the timeline's end.
      expect(trigger.y + trigger.height + bounds.height + 6).toBeGreaterThan(timeline.y + timeline.height - 8);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(trigger.y - 6);
      await ada.page.getByRole("heading", { level: 1 }).tap();
      await expect(bar(message)).toBeHidden();
    }
  });

  test("lays the bar out in two rows of four on touch screens where a row of its buttons doesn't fit", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { ...phone, viewport: { width: 320, height: 620 } } });
    // On a phone, Enter starts a new line, so Send Message sends it.
    await ada.composer().fill("Eight actions on a narrow phone");
    await ada.page.getByRole("button", { name: "Send Message" }).tap();
    const message = ada.message("Eight actions on a narrow phone");
    await expect(message).not.toHaveAttribute("aria-busy");
    const options = message.getByRole("button", { name: "Message options" });
    await options.tap();
    // The reactions go in the first row, and Reply in thread starts the second, which Edit ends.
    const first = await box(bar(message).getByRole("button", { name: "Thumbs up" }));
    const more = await box(bar(message).getByRole("button", { name: "More reactions" }));
    const thread = await box(bar(message).getByRole("link", { name: "Reply in thread" }));
    const edit = await box(bar(message).getByRole("button", { name: "Edit" }));
    expect(more).toMatchObject({ x: first.x + 3 * 44, y: first.y });
    expect(thread).toMatchObject({ x: first.x, y: first.y + 44 });
    expect(edit).toMatchObject({ x: more.x, y: thread.y });
    // Lined up with Message options' right edge, as far as the timeline lets it.
    const trigger = await box(options);
    expect(more.x + more.width + 5).toBe(Math.min(trigger.x + trigger.width, 320 - 8));
  });

  test("keeps the bar's rows clear of the avatars on a narrow phone, each ending at its right edge", async ({ members, participant }) => {
    await (await participant("Grace")).say("Ten actions on a narrow phone");
    const ada = await members.signIn("Ada", { administrator: true, context: { ...phone, viewport: { width: 320, height: 620 } } });
    const message = ada.message("Ten actions on a narrow phone");
    await message.getByRole("button", { name: "Message options" }).tap();
    // An administrator has six buttons after the reactions on someone else's message, of which five fit
    // right of the avatars' column, so Edit starts a third row, under Report.
    const more = await box(bar(message).getByRole("button", { name: "More reactions" }));
    const thread = await box(bar(message).getByRole("link", { name: "Reply in thread" }));
    const report = await box(bar(message).getByRole("button", { name: "Report message" }));
    const edit = await box(bar(message).getByRole("button", { name: "Edit" }));
    expect(thread).toMatchObject({ x: more.x - 4 * 44, y: more.y + 44 });
    expect(report).toMatchObject({ x: more.x, y: thread.y });
    expect(edit).toMatchObject({ x: more.x, y: thread.y + 44 });
    expect((await box(bar(message))).x).toBeGreaterThanOrEqual((await box(message.getByText("Grace", { exact: true }))).x);
  });

  test("opens the bar below Message options on touch screens where there's room", async ({ members, participant }) => {
    await (await participant("Grace")).say("Room below me");
    const ada = await members.signIn("Ada", { context: phone });
    const options = ada.message("Room below me").getByRole("button", { name: "Message options" });
    await options.tap();
    const trigger = await box(options);
    const bounds = await box(bar(ada.message("Room below me")));
    expect(bounds.y).toBe(trigger.y + trigger.height + 6);
    expect(bounds.x + bounds.width).toBe(Math.min(trigger.x + trigger.width, 390 - 8));
  });

  test("opens the bar to the left of Message options on a phone held sideways, with room neither below nor above", async ({ members, participant }) => {
    await (await participant("Grace")).say("Held sideways");
    const ada = await members.signIn("Ada", { context: { ...phone, viewport: { width: 874, height: 352 } } });
    const message = ada.message("Held sideways");
    const options = message.getByRole("button", { name: "Message options" });
    await options.tap();
    await bar(message).getByRole("button", { name: "More reactions" }).tap();
    await expect(message.getByRole("group", { name: "More reactions" })).toBeVisible();
    const trigger = await box(options);
    const bounds = await box(bar(message));
    const timeline = await box(ada.timeline());
    expect(bounds.height).toBeGreaterThan(Math.max(timeline.y + timeline.height - 8 - (trigger.y + trigger.height + 6), trigger.y - 6 - (timeline.y + 8)));
    expect(Math.abs(bounds.x + bounds.width - (trigger.x - 6))).toBeLessThan(1);
    expect(bounds.y).toBeGreaterThanOrEqual(timeline.y + 8);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(timeline.y + timeline.height - 8);
  });

  test("closes the bar on touch screens with a second tap, a tap elsewhere or a reaction", async ({ members, participant }) => {
    await (await participant("Grace")).say("Tap me twice");
    const ada = await members.signIn("Ada", { context: phone });
    const message = ada.message("Tap me twice");
    const options = message.getByRole("button", { name: "Message options" });

    await options.tap();
    await expect(bar(message)).toBeVisible();
    await options.tap();
    await expect(bar(message)).toBeHidden();
    await expect(options).toHaveAttribute("aria-expanded", "false");

    await options.tap();
    await expect(bar(message)).toBeVisible();
    await ada.page.getByRole("heading", { level: 1 }).tap();
    await expect(bar(message)).toBeHidden();

    await options.tap();
    await bar(message).getByRole("button", { name: "Thumbs up" }).tap();
    await expect(message.getByRole("list", { name: "Reactions" })).toContainText("👍");
    await expect(bar(message)).toBeHidden();
  });
});

test.describe("More actions on a message", () => {
  test("opens under the bar from its last button, keeping the bar open, and Escape shuts it, then the bar", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1311, height: 900 } } });
    await ada.send("Show me more.");
    const message = ada.message("Show me more.");
    const actions = await ada.actions("Show me more.");
    const options = message.getByRole("button", { name: "Message options" });
    await options.hover();
    await expect(ada.page.getByRole("tooltip", { name: "More actions" })).toBeVisible();
    const bar = await box(actions);
    const quick = await box(actions.getByRole("group", { name: "Quick reactions" }));

    await options.click();
    const panel = moreActions(message);
    await expect(panel.getByRole("button")).toHaveText(["Quote", "Copy text", "Copy link", "Edit message", "Delete message"]);
    await expect(panel.getByRole("button", { name: "Quote" })).toBeFocused();
    // Under the bar, at its right end, where Message options is, without moving the bar.
    const panelBox = await box(panel);
    expect(Math.abs(panelBox.x + panelBox.width - (bar.x + bar.width))).toBeLessThan(1);
    expect(panelBox.y).toBeGreaterThan(bar.y + bar.height);
    expect(Math.abs((await box(actions.getByRole("group", { name: "Quick reactions" }))).y - quick.y)).toBeLessThan(1);

    await ada.page.getByRole("heading", { level: 1 }).hover();
    await ada.page.waitForTimeout(250);
    await expect(panel).toBeVisible();
    await ada.page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(options).toBeFocused();
    await expect(actions).toBeVisible();
    await ada.page.keyboard.press("Escape");
    await expect(actions).toBeHidden();
  });

  test("opens over the bar near the composer, keeping the bar where it was", async ({ members, participant }) => {
    const grace = await participant("Grace");
    for (let i = 1; i <= 8; i++) await grace.say(`Earlier message ${i}`);
    await grace.say("Near the composer");
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1311, height: 500 } } });
    const actions = await ada.actions("Near the composer");
    const quick = await box(actions.getByRole("group", { name: "Quick reactions" }));
    await ada.message("Near the composer").getByRole("button", { name: "Message options" }).click();
    const panel = await box(moreActions(ada.message("Near the composer")));
    expect(Math.abs((await box(actions.getByRole("group", { name: "Quick reactions" }))).y - quick.y)).toBeLessThan(1);
    expect(panel.y + panel.height).toBeLessThan(quick.y);
    expect(panel.y).toBeGreaterThanOrEqual((await box(ada.timeline())).y);
  });

  test("copies a message's text, leaving the actions open", async ({ members, participant }) => {
    const grace = await participant("Grace");
    await grace.say("Copy my words");
    const ada = await members.signIn("Ada");
    await allowClipboard(ada.page.context());
    const panel = await openMoreActions(ada, "Copy my words");
    await expect(panel.getByRole("button")).toHaveText(["Quote", "Copy text", "Copy link", `Block ${grace.session.user.name}`, "Report message"]);
    await panel.getByRole("button", { name: "Copy text" }).click();
    await expect.poll(() => ada.page.evaluate(() => navigator.clipboard.readText())).toBe("Copy my words");
    await expect(panel).toBeVisible();
  });

  test("deletes a message for everyone from Delete message, after asking", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.send("Delete me from the menu");
    await expect(grace.message("Delete me from the menu")).toBeVisible();
    const remove = (await openMoreActions(ada, "Delete me from the menu")).getByRole("button", { name: "Delete message" });

    ada.page.once("dialog", (dialog) => dialog.dismiss());
    await remove.click();
    await expect(remove).toBeVisible();

    ada.page.once("dialog", (dialog) => {
      expect(dialog.message()).toBe("Are you sure you want to delete this message?");
      void dialog.accept();
    });
    await remove.click();
    await expect(grace.message("Delete me from the menu")).toHaveCount(0);
    await expect(ada.message("Delete me from the menu")).toHaveCount(0);
    await expect(ada.composer()).toBeFocused();
  });
});

test.describe("Quote a message", () => {
  test("quotes the message in the composer in place of what's written there, citing its author with a link to it", async ({ members, participant, rooms }) => {
    await (await participant("Grace")).say("Third time's a charm.");
    const ada = await members.signIn("Ada");
    await ada.composer().fill("Something else");
    // With a mouse, Quote is in More actions.
    await ada.actions("Third time's a charm.");
    await ada.message("Third time's a charm.").getByRole("button", { name: "Message options" }).click();
    await ada.message("Third time's a charm.").getByRole("group", { name: "More actions" }).getByRole("button", { name: "Quote" }).click();
    const composer = ada.composer();
    await expect(composer).toBeFocused();
    await expect(composer.locator("blockquote")).toHaveText("Third time's a charm.");
    await expect(composer.locator("cite")).toHaveText("Grace #");
    await expect(composer).not.toContainText("Something else");
    await expect(ada.message("Third time's a charm.").getByRole("group", { name: "Message actions" })).toBeHidden();

    // The cursor waits on the line after the quote.
    await ada.page.keyboard.type("Fourth time, then.");
    await ada.page.keyboard.press("Enter");
    const reply = ada.message("Fourth time, then.");
    await expect(reply.locator("blockquote")).toHaveText("Third time's a charm.");
    await expect(reply.locator("cite")).toHaveText("Grace #");
    await expect(reply.locator("p").last()).toHaveText("Fourth time, then.");

    // Its link is the quoted message's permalink, which opens its room.
    const link = reply.locator("cite").getByRole("link", { name: "#" });
    await expect(link).toHaveAttribute("href", new RegExp(`/rooms/${rooms.general.id}/@[^/]+$`));
    await link.click();
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}/@[^/]+$`));
    await expect(ada.message("Third time's a charm.").first()).toBeVisible();
  });

  test("quotes from the bar on touch screens, where Quote follows Reply in thread", async ({ members, participant }) => {
    await (await participant("Grace")).say("Quote me by touch");
    const ada = await members.signIn("Ada", { context: phone });
    const message = ada.message("Quote me by touch");
    await message.getByRole("button", { name: "Message options" }).tap();
    const actions = message.getByRole("group", { name: "Message actions" });
    const thread = await box(actions.getByRole("link", { name: "Reply in thread" }));
    const quote = actions.getByRole("button", { name: "Quote" });
    expect((await box(quote)).x).toBe(thread.x + thread.width);
    await quote.tap();
    await expect(ada.composer().locator("blockquote")).toHaveText("Quote me by touch");
    await expect(ada.composer().locator("cite")).toHaveText("Grace #");
    await expect(actions).toBeHidden();
  });
});

test("copies a code block from its corner, keeping its line breaks", async ({ members, participant }) => {
  const code = 'const greeting = "Hello";\nconsole.log(greeting);';
  await (await participant("Grace")).post(`<p>Run this snippet</p><pre data-language="javascript">${code}</pre>`);
  const ada = await members.signIn("Ada");
  await allowClipboard(ada.page.context());
  const block = ada.message("Run this snippet").locator(".code-block");
  const copy = block.getByRole("button", { name: "Copy code" });
  await ada.page.getByRole("heading", { level: 1 }).hover();
  await expect(copy).toHaveCSS("opacity", "0");
  await copy.focus();
  await expect(copy).toHaveCSS("opacity", "1");
  await ada.composer().focus();
  await block.hover();
  await expect(copy).toHaveCSS("opacity", "1");
  await expect(block.locator(".hljs-keyword")).toHaveText("const");
  const color = await copy.evaluate((button) => getComputedStyle(button).color);
  await copy.click();
  await expect.poll(() => ada.page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await expect(copy).not.toHaveCSS("color", color);
  await expect(copy).toHaveClass(/motion-safe:animate-success/);
  await ada.composer().focus();
  await ada.page.keyboard.press("ControlOrMeta+v");
  await expect(ada.composer()).toContainText("console.log(greeting);");
  await ada.page.setViewportSize(phone.viewport);
  await ada.page.getByRole("heading", { level: 1 }).hover();
  await expect(copy).toHaveCSS("opacity", "1");
  await expect(copy).toHaveCSS("width", "44px");
});

test.describe("Copy a link to a message", () => {
  test("copies the message's address from More actions, keeping it open and turning Copy link green", async ({ members, participant, rooms, baseURL }) => {
    await (await participant("Grace")).say("Link to me");
    const ada = await members.signIn("Ada");
    await allowClipboard(ada.page.context());
    // With a mouse, it's in More actions rather than on the bar.
    await expect((await ada.actions("Link to me")).getByRole("button", { name: "Copy link" })).toHaveCount(0);
    const panel = await openMoreActions(ada, "Link to me");
    const copy = panel.getByRole("button", { name: "Copy link" });
    const color = await copy.evaluate((button) => getComputedStyle(button).color);
    await copy.click();
    await expect(copy).not.toHaveCSS("color", color);
    const link = await ada.page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(new RegExp(`^${baseURL}/rooms/${rooms.general.id}/@[^/]+$`));
    await expect(panel).toBeVisible();
  });
});

test.describe("Link to a message", () => {
  test("opens a message's room at its permalink", async ({ members, participant, rooms }) => {
    await (await participant("Grace")).say("Find me later");
    const ada = await members.signIn("Ada");
    await allowClipboard(ada.page.context());
    await (await openMoreActions(ada, "Find me later")).getByRole("button", { name: "Copy link" }).click();
    const path = new URL(await ada.page.evaluate(() => navigator.clipboard.readText())).pathname;

    const grace = await members.signIn("Grace", { path });
    await expect(grace.message("Find me later")).toBeVisible();
    await expect(grace.page.getByRole("heading", { level: 1 })).toContainText(rooms.general.name);
    expect(new URL(grace.page.url()).pathname).toBe(path);
  });

  test("goes from a message's own address to its permalink", async ({ members, participant, rooms }) => {
    await (await participant("Grace")).say("Find me again");
    const ada = await members.signIn("Ada");
    await allowClipboard(ada.page.context());
    await (await openMoreActions(ada, "Find me again")).getByRole("button", { name: "Copy link" }).click();
    const permalink = new URL(await ada.page.evaluate(() => navigator.clipboard.readText())).pathname;

    const grace = await members.signIn("Grace", { path: permalink.replace("/@", "/messages/") });
    await expect(grace.message("Find me again")).toBeVisible();
    await expect(grace.page.getByRole("heading", { level: 1 })).toContainText(rooms.general.name);
    expect(new URL(grace.page.url()).pathname).toBe(permalink);
  });
});

test.describe("Edit a message", () => {
  test("lets the author edit a message, for everyone, saving on Ctrl or Cmd+Enter", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.send("Helo");

    await (await ada.actions("Helo")).getByRole("button", { name: "Edit" }).click();
    await expect(ada.editor()).toBeFocused();
    await expect(ada.editor()).toHaveText("Helo");
    await ada.editor().fill("Hello");
    await ada.editor().press("ControlOrMeta+Enter");

    await expect(grace.message("Hello")).toContainText("(edited)");
    await expect(grace.message("Helo")).toHaveCount(0);
    await expect(ada.message("Hello")).toContainText("(edited)");
    // Focus goes back to the composer.
    await expect(ada.composer()).toBeFocused();
  });

  test("edits the formatting along with the text, starting a new paragraph on Enter", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("A **bold** claim");
    await ada.composer().press("Enter");
    await (await ada.actions("A bold claim")).getByRole("button", { name: "Edit" }).click();
    await expect(ada.editor().locator("strong")).toHaveText("bold");
    // The cursor is after the text.
    await ada.page.keyboard.type(", revised");
    await ada.editor().press("Enter");
    await ada.page.keyboard.type("Second thoughts");
    await ada.editor().press("ControlOrMeta+Enter");
    const content = ada.message("A bold claim, revised").locator(".message-content");
    await expect(ada.message("A bold claim, revised")).toContainText("(edited)");
    await expect(content.locator("strong")).toHaveText("bold");
    await expect(content.locator("p")).toHaveText(["A bold claim, revised", "Second thoughts"]);
  });

  test("keeps the editor and what's written when the edit is too long to save", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.send("Short");
    await (await ada.actions("Short")).getByRole("button", { name: "Edit" }).click();
    await ada.editor().evaluate((content, length) => {
      (content.closest("lexxy-editor") as HTMLElement & { value: string }).value = `<p>${"x".repeat(length)}</p>`;
    }, MAX_MESSAGE_LENGTH + 1);
    await ada.editor().press("ControlOrMeta+Enter");
    await expect(ada.page.getByRole("alert")).toHaveText("Messages can be up to 40,000 characters.");
    await expect(ada.editor().locator("p")).toHaveText(["x".repeat(MAX_MESSAGE_LENGTH + 1)]);
    await expect(ada.page.getByRole("article")).not.toContainText("(edited)");
  });

  test("shows the formatting row above the text on a wide screen with a mouse, which formats the edit as its keys do", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.send("Format me");
    await (await ada.actions("Format me")).getByRole("button", { name: "Edit" }).click();
    const bold = ada.message("Format me").getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Bold" });
    await expect(bold).toBeVisible();
    expect((await box(bold)).y).toBeLessThan((await box(ada.editor())).y);

    await ada.editor().press("ControlOrMeta+a");
    await bold.click();
    await expect(ada.editor()).toBeFocused();
    await ada.editor().press("ControlOrMeta+Shift+X");
    // Escape closes Link's dialog, leaving the edit open.
    await ada.editor().press("ControlOrMeta+k");
    await expect(ada.page.getByRole("dialog", { name: "Edit link" }).or(ada.page.getByRole("dialog", { name: "Add link" }))).toBeVisible();
    // The click shut the tooltip that named Bold as the pointer reached it, which takes Escape until it has faded,
    // hidden under the dialog as it is.
    await expect(ada.page.getByRole("tooltip", { includeHidden: true })).toHaveCount(0);
    await ada.page.keyboard.press("Escape");
    await expect(ada.page.getByRole("dialog")).toBeHidden();
    await expect(ada.editor()).toBeFocused();

    await ada.editor().press("ControlOrMeta+Enter");
    await expect(ada.message("Format me").locator(".message-content strong")).toHaveText("Format me");
    await expect(ada.message("Format me").locator(".message-content s")).toHaveText("Format me");
  });

  test("scrolls the editor to the middle of the timeline as it opens, from the newest messages too", async ({ members, participant }) => {
    const archivist = await participant("Archivist");
    for (let n = 1; n <= 40; n++) await archivist.say(`Entry #${String(n).padStart(2, "0")}`);
    const ada = await members.signIn("Ada", { administrator: true });
    // The composer loads the editor's code. An editor opened before then is centred while it's a loading line,
    // then grows, leaving its middle below the timeline's.
    await expect(ada.composer()).toBeVisible();
    // The room opens at its newest messages. The editor's message is near the top of the view, so the editor
    // would go up out of it by however much taller than the message it is, if the timeline stayed at the end.
    const [, entry] = await ada.inView(/Entry #\d+/);
    await (await ada.actions(entry!)).getByRole("button", { name: "Edit" }).click();
    await expect(ada.editor()).toBeFocused();
    await expect.poll(() => ada.offCentre(ada.message(entry!).locator(".message-edit"))).toBeLessThanOrEqual(1);
  });

  test("shows all of your newest message's editor as it opens at the newest messages", async ({ members, participant }) => {
    const archivist = await participant("Archivist");
    for (let n = 1; n <= 40; n++) await archivist.say(`Entry #${String(n).padStart(2, "0")}`);
    const ada = await members.signIn("Ada");
    await ada.send("My newest");
    await expect(ada.message("My newest")).not.toHaveAttribute("aria-busy");
    // The editor goes on below the view, so Lexxy scrolls the timeline to its caret, and its own scroll to the middle
    // of the timeline ends at the end.
    await ada.composer().press("ArrowUp");
    await expect(ada.editor()).toBeFocused();
    await expect.poll(() => ada.outOfView(ada.message("My newest").locator(".message-edit"))).toBe(0);
  });

  test("links what's selected from Link's dialog, whose Enter saves the link and leaves the edit open", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.send("Draft");
    await (await ada.actions("Draft")).getByRole("button", { name: "Edit" }).click();
    await ada.editor().fill("Final");
    await ada.editor().press("ControlOrMeta+a");
    await ada.editor().press("ControlOrMeta+k");
    const dialog = ada.page.getByRole("dialog", { name: "Add link" });
    await dialog.getByLabel("Link").fill("example.com");
    await dialog.getByLabel("Link").press("Enter");
    await expect(dialog).toBeHidden();
    await expect(ada.editor()).toBeFocused();
    await expect(ada.editor().getByRole("link", { name: "Final" })).toHaveAttribute("href", "https://example.com");
    await ada.page.getByRole("button", { name: "Save changes" }).click();
    await expect(ada.message("Final")).toContainText("(edited)");
    await expect(ada.message("Final").getByRole("link", { name: "Final" })).toHaveAttribute("href", "https://example.com");
  });

  test("discards an edit with Escape or Close editor and discard changes", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.send("Unchanged");
    await (await ada.actions("Unchanged")).getByRole("button", { name: "Edit" }).click();
    await ada.editor().fill("Something else");
    await ada.editor().press("Escape");
    await expect(ada.editor()).toHaveCount(0);
    await expect(ada.composer()).toBeFocused();

    await (await ada.actions("Unchanged")).getByRole("button", { name: "Edit" }).click();
    await ada.editor().fill("Something else");
    await ada.page.getByRole("button", { name: "Close editor and discard changes" }).click();
    await expect(ada.editor()).toHaveCount(0);
    await expect(ada.message("Unchanged")).not.toContainText("(edited)");
    await expect(ada.composer()).toBeFocused();
  });

  test("edits your newest message on Up Arrow, from an empty composer", async ({ members, participant }) => {
    const ada = await members.signIn("Ada");
    await ada.send("My first");
    await ada.send("My newest");
    await expect(ada.message("My newest")).not.toHaveAttribute("aria-busy");
    await (await participant("Grace")).say("Grace's, after mine");

    await ada.composer().pressSequentially("Half written");
    await ada.composer().press("ArrowUp");
    await expect(ada.editor()).toHaveCount(0);

    // Selected and deleted as you would, as `fill("")` can delete before Lexical hears of the selection.
    await ada.composer().press("ControlOrMeta+a");
    await ada.composer().press("Delete");
    await expect(ada.composer()).toHaveText("");
    await ada.composer().press("ArrowUp");
    const editor = editorField(ada.message("My newest"), "Edit message");
    await expect(editor).toBeFocused();
    await expect(ada.editor()).toHaveText("My newest");

    // Up Arrow returns to the editor while it's open, with what's written in it.
    await editor.pressSequentially(", changed");
    await ada.composer().click();
    await ada.composer().press("ArrowUp");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("My newest, changed");
    await expect(ada.composer()).toHaveText("");
  });

  test("takes no files", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.send("Look");
    await (await ada.actions("Look")).getByRole("button", { name: "Edit" }).click();
    await ada.editor().evaluate((content) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([new Uint8Array([137, 80, 78, 71])], "screenshot.png", { type: "image/png" }));
      content.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await expect(ada.editor()).toHaveText("Look");
    await expect(ada.editor().locator("img, action-text-attachment, figure")).toHaveCount(0);
  });

  test("offers no Edit on other people's messages", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.send("Ada's");

    const toolbar = await grace.actions("Ada's");
    await expect(toolbar.getByRole("button", { name: "Thumbs up" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Edit" })).toHaveCount(0);
  });

  test("lets an administrator edit anyone's message, for everyone", async ({ browser, baseURL, members, rooms }) => {
    const grace = await members.signIn("Grace");
    await grace.send("Grace's typo");
    await expect(grace.message("Grace's typo")).not.toHaveAttribute("aria-busy");
    const administrator = await administratorOn(browser, baseURL!, rooms.general);
    const message = administrator.getByRole("article").filter({ hasText: "Grace's typo" });

    await message.hover();
    await message.getByRole("button", { name: "Edit" }).click();
    const editor = editorField(administrator, "Edit message");
    await editor.fill("Grace's fix");
    await editor.press("ControlOrMeta+Enter");
    await expect(grace.message("Grace's fix")).toContainText("(edited)");
    await expect(grace.message("Grace's fix")).toContainText("Grace");
    await administrator.context().close();
  });
});

test.describe("Delete a message", () => {
  test("deletes a message for everyone from its editor, after asking", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.send("Oops");
    await expect(grace.message("Oops")).toBeVisible();
    await (await ada.actions("Oops")).getByRole("button", { name: "Edit" }).click();

    ada.page.once("dialog", (dialog) => dialog.dismiss());
    await ada.page.getByRole("button", { name: "Delete message" }).click();
    await expect(ada.editor()).toBeVisible();

    ada.page.once("dialog", (dialog) => {
      expect(dialog.message()).toBe("Are you sure you want to delete this message?");
      void dialog.accept();
    });
    await ada.page.getByRole("button", { name: "Delete message" }).click();
    await expect(grace.message("Oops")).toHaveCount(0);
    await expect(ada.message("Oops")).toHaveCount(0);
    await expect(ada.composer()).toBeFocused();
  });

  test("lets an administrator delete anyone's message, for everyone", async ({ browser, baseURL, members, rooms }) => {
    const grace = await members.signIn("Grace");
    await grace.send("Grace's mistake");
    await expect(grace.message("Grace's mistake")).not.toHaveAttribute("aria-busy");
    const administrator = await administratorOn(browser, baseURL!, rooms.general);
    const message = administrator.getByRole("article").filter({ hasText: "Grace's mistake" });

    await message.hover();
    await message.getByRole("button", { name: "Edit" }).click();
    administrator.once("dialog", (dialog) => void dialog.accept());
    await administrator.getByRole("button", { name: "Delete message" }).click();
    await expect(grace.message("Grace's mistake")).toHaveCount(0);
    await expect(message).toHaveCount(0);
    await administrator.context().close();
  });

  test("offers Delete in the editor, not on the action bar", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.send("Mine to delete");
    const bar = await ada.actions("Mine to delete");
    await expect(bar.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(bar.getByRole("button", { name: /Delete/ })).toHaveCount(0);
  });
});

test.describe("Group messages by author", () => {
  test("shows quick follow-ups from the same person without repeating their name", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.send("First");
    await ada.send("Follow-up");

    await expect(grace.message("First").getByText("Ada", { exact: true })).toBeVisible();
    await expect(grace.message("Follow-up")).toBeVisible();
    await expect(grace.message("Follow-up").getByText("Ada", { exact: true })).toHaveCount(0);

    await grace.send("Grace replies");
    await expect(ada.message("Grace replies").getByText("Grace", { exact: true })).toBeVisible();
  });

  test("groups someone's messages up to five minutes apart, past midnight too, under the new day's date", async ({ members, participant }) => {
    const grace = await participant("Grace");
    const times = new Map<string, string>();
    for (const [text, at] of [
      ["Before midnight", "2026-10-15T23:52:00Z"],
      ["Five minutes on", "2026-10-15T23:57:00Z"],
      ["Past midnight", "2026-10-16T00:02:00Z"],
      ["Six minutes on", "2026-10-16T00:08:00Z"],
    ] as const) {
      times.set((await grace.say(text)).id, at);
    }
    const ada = await members.signIn("Ada", { context: { timezoneId: "UTC", locale: "en-US" }, beforeOpen: writtenAt(times) });

    const named = (text: string) => ada.message(text).getByText("Grace", { exact: true });
    await expect(named("Before midnight")).toBeVisible();
    await expect(named("Five minutes on")).toHaveCount(0);
    await expect(named("Past midnight")).toHaveCount(0);
    await expect(named("Six minutes on")).toBeVisible();
    await expect(separatorAbove(ada, "Past midnight")).toHaveText("October 16, 2026");
  });
});

test.describe("Initials avatars", () => {
  test("shows each person's avatar from the address the directory gives, the same everywhere", async ({ members }) => {
    const ada = await members.signIn("Ada Lovelace");
    const grace = await members.signIn("Grace");
    await ada.send("Avatar check");

    const avatar = (member: typeof ada) => member.message("Avatar check").locator("img[aria-hidden=true]").first();
    const address = new RegExp(`^/users/${ada.session.user.id}\\.[\\w-]{22}/avatar\\?v=\\d{14}$`);
    for (const member of [ada, grace]) {
      await expect(avatar(member)).toHaveAttribute("src", address);
      // Loaded from the Worker, not just named.
      await expect.poll(() => avatar(member).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    }
    expect(await avatar(grace).getAttribute("src")).toBe(await avatar(ada).getAttribute("src"));
  });
});
