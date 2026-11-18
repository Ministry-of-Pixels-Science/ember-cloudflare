import { readFile } from "node:fs/promises";
import { MAX_MESSAGE_LENGTH } from "@ember/protocol";
import type { Locator } from "@playwright/test";
import { ROOM_SOCKET } from "../../fixtures";
import { expect, paste, test, type Member } from "./fixtures";

const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("Not visible");
  return rect;
};

/** The composer's card, around the text and its buttons. */
const card = (member: Member) => member.page.locator("form.composer > div:has([role=textbox])");

/** A button under the composer's text, by its name, found while a menu over the page hides it from the rest too. */
const underText = (member: Member, name: string) => card(member).getByRole("button", { name, exact: true, includeHidden: true });

/** Show formatting, under the text, which shows or hides the formatting row. */
const showFormatting = (member: Member) => underText(member, "Show formatting");

/** The formatting row over the composer's text. */
const formattingRow = (member: Member) => member.page.locator("form.composer").getByRole("toolbar", { name: "Formatting" });

/** A button of the formatting row, by its name. */
const tool = (member: Member, name: string) => formattingRow(member).getByRole("button", { name, exact: true });

/** Link's dialog, as it adds a link, or as it edits one. */
const linkDialog = (member: Member, title = "Add link") => member.page.getByRole("dialog", { name: title });

/** The menu Slack's + opens, under the text. */
const attachMenu = (member: Member) => member.page.getByRole("menu");

/** A choice in the + menu, by the start of its name, which ends in its keys. */
const attachChoice = (member: Member, name: string) => attachMenu(member).getByRole("menuitem", { name: new RegExp(`^${name}`) });

/** Text snippet's dialog. */
const snippetDialog = (member: Member) => member.page.getByRole("dialog", { name: "Create a text snippet" });

/** The emoji picker over Emoji, under the text. */
const emojiPicker = (member: Member) => member.page.getByRole("dialog", { name: "Emoji" });

/** A text file called `name` that says `text`, as Playwright picks it. */
const textFile = (name: string, text: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });

/** A style in the formatting row's Paragraph menu, by the start of its name, which ends in H1 to H3 for a heading's. */
const paragraphStyle = (member: Member, name: string) => member.page.getByRole("menu").getByRole("menuitemradio", { name: new RegExp(`^${name}`) });

/** Replaces what's in the composer with `markup`, as Lexxy holds what's typed. */
const write = (member: Member, markup: string) =>
  member.composer().evaluate((content, markup) => {
    (content.closest("lexxy-editor") as HTMLElement & { value: string }).value = markup;
  }, markup);

/**
 * Moves the page's selection back by `letters`, as Shift+Left does with `alter` "extend" and Left with
 * "move", then presses Cmd or Ctrl with `key` in the text, before the page has told the editor its
 * selection moved.
 */
const pressAsSelectionMoves = (member: Member, alter: "extend" | "move", letters: number, key: { key: string; code: string; shiftKey?: boolean }) =>
  member.composer().evaluate(
    (text, { alter, letters, key }) => {
      for (let n = 0; n < letters; n++) getSelection()!.modify(alter, "backward", "character");
      const command = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
      text.dispatchEvent(new KeyboardEvent("keydown", { ...key, ...command, bubbles: true, cancelable: true }));
    },
    { alter, letters, key },
  );

/** Tells the editor the page's selection moved, as the page does a moment after the text under it's redrawn, though not always before the next key. */
const pageTellsTheEditor = (member: Member) => member.page.evaluate(() => document.dispatchEvent(new Event("selectionchange")));

/**
 * Moves the cursor to the line's start, as Home does, then presses Shift and Tab, which takes focus to the formatting
 * row's Bold, before the page has told the editor the cursor moved.
 */
const homeThenToTheRow = (member: Member) =>
  member.composer().evaluate((text) => {
    getSelection()!.modify("move", "backward", "lineboundary");
    text.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    document.querySelector<HTMLButtonElement>("form.composer [role=toolbar] button[aria-label=Bold]")!.focus();
  });

/** Opens another of the test's rooms from the sidebar. */
async function openRoom(member: Member, name: string) {
  await member.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: new RegExp(name) }).click();
  await expect(member.page.getByRole("heading", { level: 1 })).toHaveText(name);
  await member.connected();
}

test.describe("Composer", () => {
  test("is a card at least 108px tall, with the formatting row and the text on top and Slack's buttons below, ending in a round Send", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1280, height: 800 } } });
    const field = ada.composer();
    const send = underText(ada, "Send Message");
    await expect(field).toHaveAttribute("placeholder", "Message #general");

    expect((await box(card(ada))).height).toBeGreaterThanOrEqual(108);
    await expect(card(ada)).toHaveCSS("border-top-left-radius", "12px");
    const rowBox = await box(formattingRow(ada));
    const fieldBox = await box(field);
    const sendBox = await box(send);
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(fieldBox.y);
    expect(sendBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height);
    let left = 0;
    for (const name of ["Attach", "Show formatting", "Emoji", "Mention someone"]) {
      const buttonBox = await box(underText(ada, name));
      expect(buttonBox.y, name).toBe(sendBox.y);
      expect(buttonBox.x, name).toBeGreaterThan(left);
      left = buttonBox.x;
    }
    expect(sendBox.x).toBeGreaterThan(left);
    expect(sendBox.width).toBe(sendBox.height);
    expect(parseFloat(await send.evaluate((el) => getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThanOrEqual(sendBox.width / 2);
  });

  test("is focused as the room opens", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await expect(ada.composer()).toBeFocused();
  });

  test("loads the editor once the room's messages are in, so its code doesn't hold them up", async ({ members }) => {
    let answeredAt = Number.POSITIVE_INFINITY;
    let editorRequestedAt = Number.NEGATIVE_INFINITY;
    const ada = await members.signIn("Ada", {
      beforeOpen: async (page) => {
        page.on("request", (request) => {
          if (/\/assets\/rich-text-editor-[\w-]+\.js$/.test(request.url())) editorRequestedAt = Date.now();
        });
        await page.routeWebSocket(ROOM_SOCKET, (ws) => {
          const room = ws.connectToServer();
          let frames = Promise.resolve();
          room.onMessage((frame) => {
            frames = frames.then(async () => {
              // The room's first answer, its welcome, comes a second late, long enough for an editor that didn't wait to load first.
              if (answeredAt === Number.POSITIVE_INFINITY) {
                await new Promise((resolve) => setTimeout(resolve, 1_000));
                answeredAt = Date.now();
              }
              ws.send(frame);
            });
          });
        });
      },
    });
    await expect(ada.composer()).toBeVisible();
    expect(editorRequestedAt).toBeGreaterThanOrEqual(answeredAt);
  });

  test("grows with the text up to a third of the window", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1280, height: 800 } } });
    const field = ada.composer();
    // The text box takes the card's padding, around the room for the text.
    const room = () => field.evaluate((el) => el.clientHeight - parseFloat(getComputedStyle(el).paddingTop) - parseFloat(getComputedStyle(el).paddingBottom));
    const empty = await room();
    await write(ada, "<p>A line</p>".repeat(3));
    expect(await room()).toBeGreaterThan(empty);
    // min(32dvh, 300px) of an 800px window
    await write(ada, "<p>A line</p>".repeat(40));
    expect(await room()).toBe(256);
  });

  test("takes a tap anywhere above its buttons in the text", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: phone });
    const cardBox = await box(card(ada));
    const sendBox = await box(ada.page.getByRole("button", { name: "Send Message" }));
    await ada.page.touchscreen.tap(cardBox.x + 2, cardBox.y + 2);
    await expect(ada.composer()).toBeFocused();
    await ada.composer().blur();
    await ada.page.touchscreen.tap(cardBox.x + cardBox.width - 2, sendBox.y - 1);
    await expect(ada.composer()).toBeFocused();
  });

  test("is at least 100px tall on phones", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: phone });
    expect((await box(card(ada))).height).toBeGreaterThanOrEqual(100);
  });
});

test.describe("Formatting row", () => {
  test("shows Slack's buttons over the text, which Show formatting hides, as the browser remembers", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await expect(formattingRow(ada)).toBeVisible();
    await expect(showFormatting(ada)).toHaveAttribute("aria-pressed", "true");
    expect(await formattingRow(ada).getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))).toEqual([
      "Bold",
      "Italic",
      "Underline",
      "Strikethrough",
      "Paragraph",
      "Link",
      "Ordered list",
      "Bulleted list",
      "Blockquote",
      "Code",
      "Code block",
      "Divider",
    ]);

    await showFormatting(ada).click();
    await expect(formattingRow(ada)).toBeHidden();
    await expect(showFormatting(ada)).toHaveAttribute("aria-pressed", "false");
    await expect(ada.composer()).toBeFocused();

    await ada.page.reload();
    await expect(ada.composer()).toBeVisible();
    await expect(formattingRow(ada)).toBeHidden();
    await showFormatting(ada).click();
    await expect(formattingRow(ada)).toBeVisible();
  });

  test("names each button in a tooltip with its keys", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await tool(ada, "Strikethrough").hover();
    await expect(ada.page.getByRole("tooltip")).toHaveText(/^Strikethrough\s*(Ctrl|⌘)\s*(Shift|⇧)\s*X$/);
    await expect(tool(ada, "Strikethrough")).toHaveAttribute("aria-keyshortcuts", /^(Control|Meta)\+Shift\+X$/);
    await tool(ada, "Divider").hover();
    await expect(ada.page.getByRole("tooltip", { name: "Divider" })).toHaveText("Divider");
  });

  test("formats what's selected with each button, lighting it, and sends the formatting", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const tools = [
      ["Bold", "strong"],
      ["Italic", "em"],
      ["Underline", "u"],
      ["Strikethrough", "s"],
      ["Blockquote", "blockquote"],
      ["Code", "code"],
      ["Ordered list", "ol > li"],
      ["Bulleted list", "ul > li"],
      ["Code block", "pre"],
    ] as const;
    for (const [name, element] of tools) {
      await ada.composer().fill(`${name} text`);
      await ada.composer().press("ControlOrMeta+a");
      await tool(ada, name).click();
      await expect(tool(ada, name)).toHaveAttribute("aria-pressed", "true");
      await expect(ada.composer()).toBeFocused();
      await ada.composer().press("Enter");
      await expect(grace.message(`${name} text`).locator(`.message-content ${element}`)).toHaveText(`${name} text`);
    }
  });

  test("formats what's typed next with nothing selected, and leaves no formatting on for the next message", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().pressSequentially("Plain, ");
    await tool(ada, "Bold").click();
    await expect(tool(ada, "Bold")).toHaveAttribute("aria-pressed", "true");
    await ada.composer().pressSequentially("loud");
    await tool(ada, "Bold").click();
    await ada.composer().pressSequentially(" and ");
    await tool(ada, "Code").click();
    await expect(tool(ada, "Code")).toHaveAttribute("aria-pressed", "true");
    await ada.composer().pressSequentially("code");
    await ada.composer().press("Enter");
    const sent = grace.message("Plain, loud").locator(".message-content");
    await expect(sent).toHaveText("Plain, loud and code");
    await expect(sent.locator("strong")).toHaveText("loud");
    await expect(sent.locator("code")).toHaveText("code");

    await expect(tool(ada, "Code")).toHaveAttribute("aria-pressed", "false");
    await ada.composer().pressSequentially("Quiet");
    await ada.composer().press("Enter");
    await expect(grace.message("Quiet").locator(".message-content")).toHaveText("Quiet");
    await expect(grace.message("Quiet").locator(".message-content :is(strong, code)")).toHaveCount(0);
  });

  test("turns Code on and off for what's typed next, straight after a list's new item too", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().press("ControlOrMeta+Shift+8");
    await ada.composer().pressSequentially("Steps");
    // Shift+Enter, then Code before the page has told the editor its selection moved to the new item.
    await ada.composer().evaluate(async (text) => {
      const press = (key: string, code: string, keys: KeyboardEventInit) =>
        text.dispatchEvent(new KeyboardEvent("keydown", { key, code, shiftKey: true, bubbles: true, cancelable: true, ...keys }));
      press("Enter", "Enter", {});
      await Promise.resolve();
      press("C", "KeyC", /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true });
    });
    await ada.composer().pressSequentially("pnpm run deploy");
    await ada.composer().press("ControlOrMeta+Shift+C");
    await ada.composer().pressSequentially(" to ship");
    await ada.composer().press("Enter");
    const step = grace.message("Steps").locator(".message-content li").nth(1);
    await expect(step).toHaveText("pnpm run deploy to ship");
    await expect(step.locator("code")).toHaveText("pnpm run deploy");
  });

  test("styles the line from the Paragraph menu as Slack's three headings, each smaller, keeping the cursor where it was, the menu closing on Escape", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const menu = ada.page.getByRole("menu");
    await ada.composer().pressSequentially("Big news");
    // Measured while the menu's shut, as the menu hides the rest of the page from screen readers.
    const paragraphBox = await box(tool(ada, "Paragraph"));
    await tool(ada, "Paragraph").click();
    await expect(menu.getByRole("menuitemradio")).toHaveText(["Paragraph", "Big headingH1", "Medium headingH2", "Small headingH3"]);
    await expect(paragraphStyle(ada, "Paragraph")).toHaveAttribute("aria-checked", "true");
    // Upward, as there's no room under the composer, once it's done sliding up into place.
    await menu.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    const menuBox = await box(menu);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(paragraphBox.y);
    await paragraphStyle(ada, "Big heading").click();
    await expect(menu).toBeHidden();
    await expect(ada.composer()).toBeFocused();
    await ada.composer().pressSequentially(" today");
    await expect(ada.composer().locator("h1")).toHaveText("Big news today");
    await ada.composer().press("Enter");

    for (const [name, element] of [
      ["Medium heading", "h2"],
      ["Small heading", "h3"],
    ] as const) {
      await ada.composer().pressSequentially(`A ${name.toLowerCase()}`);
      await tool(ada, "Paragraph").click();
      await paragraphStyle(ada, name).click();
      await ada.composer().press("Enter");
      await expect(grace.message(`A ${name.toLowerCase()}`).locator(`.message-content ${element}`)).toHaveText(`A ${name.toLowerCase()}`);
    }
    const size = (text: string) => grace.message(text).locator(".message-content :is(h1, h2, h3)").evaluate((heading) => parseFloat(getComputedStyle(heading).fontSize));
    const sizes = [await size("Big news today"), await size("A medium heading"), await size("A small heading"), 15];
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(new Set(sizes).size).toBe(4);

    await ada.composer().pressSequentially("Back to a paragraph");
    await tool(ada, "Paragraph").click();
    await paragraphStyle(ada, "Small heading").click();
    await tool(ada, "Paragraph").click();
    await expect(paragraphStyle(ada, "Small heading")).toHaveAttribute("aria-checked", "true");
    await paragraphStyle(ada, "Paragraph").click();
    await expect(ada.composer().locator("p")).toHaveText("Back to a paragraph");
    await expect(ada.composer().locator("h3")).toHaveCount(0);

    // A quick click comes before Paragraph's tooltip has opened, which mustn't then open over the menu and take its Escape.
    await tool(ada, "Paragraph").click();
    await ada.page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(ada.composer()).toBeFocused();
  });

  test("styles only the line the cursor's on, keeping the cursor there", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("Shopping");
    await ada.composer().press("Shift+Enter");
    await ada.composer().pressSequentially("Hello world");
    for (let n = 0; n < "world".length; n++) await ada.composer().press("ArrowLeft");
    await tool(ada, "Blockquote").click();
    await ada.composer().pressSequentially("big ");
    await expect(ada.composer().locator("blockquote")).toHaveText("Hello big world");
    await expect(ada.composer().locator(":scope > p")).toHaveText("Shopping");

    await tool(ada, "Bulleted list").click();
    await ada.composer().pressSequentially("wide ");
    await expect(ada.composer().locator("li")).toHaveText("Hello big wide world");
  });

  test("keeps what's selected as it styles the line, so what's typed next takes only its place", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const select = async (word: string, before: string) => {
      await ada.composer().press("End");
      for (let n = 0; n < before.length; n++) await ada.composer().press("ArrowLeft");
      for (let n = 0; n < word.length; n++) await ada.composer().press("Shift+ArrowLeft");
    };
    await ada.composer().pressSequentially("Launch day checklist");
    await select("day", " checklist");
    await tool(ada, "Paragraph").click();
    await paragraphStyle(ada, "Medium heading").click();
    await expect(ada.composer()).toBeFocused();
    await ada.composer().pressSequentially("week");
    await expect(ada.composer().locator("h2")).toHaveText("Launch week checklist");

    await select("checklist", "");
    await ada.composer().press("ControlOrMeta+Shift+8");
    await ada.composer().pressSequentially("plan");
    await expect(ada.composer().locator("li")).toHaveText("Launch week plan");
  });

  test("starts a list's next item on Shift+Enter, where Enter sends, ending the list on an empty one, and a paragraph after a heading", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await expect(ada.composer()).toBeFocused();
    await tool(ada, "Bulleted list").click();
    await ada.composer().pressSequentially("Milk");
    await ada.composer().press("Shift+Enter");
    await ada.composer().pressSequentially("Eggs");
    await ada.composer().press("Shift+Enter");
    await ada.composer().press("Shift+Enter");
    await ada.composer().pressSequentially("That's all");
    await ada.composer().press("Enter");
    const list = grace.message("Milk").locator(".message-content");
    await expect(list.locator("ul > li")).toHaveText(["Milk", "Eggs"]);
    await expect(list.locator(":scope > p")).toHaveText("That's all");

    await tool(ada, "Paragraph").click();
    await paragraphStyle(ada, "Small heading").click();
    await ada.composer().pressSequentially("Agenda");
    await ada.composer().press("Shift+Enter");
    await ada.composer().pressSequentially("First, the budget");
    await ada.composer().press("Enter");
    const agenda = grace.message("Agenda").locator(".message-content");
    await expect(agenda.locator("h3")).toHaveText("Agenda");
    await expect(agenda.locator(":scope > p")).toHaveText("First, the budget");
  });

  test("links what's selected in Link's dialog, taking an address without a scheme as a web address, and edits or removes the link the cursor's in", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().pressSequentially("Ember");
    await ada.composer().press("ControlOrMeta+a");
    await tool(ada, "Link").click();
    const adding = linkDialog(ada);
    await expect(adding.getByLabel("Text")).toHaveValue("Ember");
    await expect(adding.getByLabel("Link")).toBeFocused();
    await expect(adding.getByRole("button", { name: "Save" })).toBeDisabled();
    await expect(adding.getByRole("button", { name: "Remove link" })).toHaveCount(0);
    await adding.getByLabel("Link").fill("example.com/ember");
    await adding.getByLabel("Link").press("Enter");
    await expect(adding).toBeHidden();
    await expect(ada.composer()).toBeFocused();
    await expect(ada.composer().getByRole("link", { name: "Ember" })).toHaveAttribute("href", "https://example.com/ember");
    await expect(tool(ada, "Link")).toHaveAttribute("aria-pressed", "true");

    await ada.composer().press("ArrowLeft");
    await tool(ada, "Link").click();
    const editing = linkDialog(ada, "Edit link");
    await expect(editing.getByLabel("Text")).toHaveValue("Ember");
    await expect(editing.getByLabel("Link")).toHaveValue("https://example.com/ember");
    await editing.getByLabel("Text").fill("Ember's site");
    await editing.getByRole("button", { name: "Save" }).click();
    await expect(ada.composer().getByRole("link")).toHaveText("Ember's site");
    // Back in the text after the link once the dialog's gone, and into it two characters back, since
    // Lexical takes the very end of a link's text as after it.
    await expect(editing).toBeHidden();
    await expect(ada.composer()).toBeFocused();
    await expect(tool(ada, "Link")).toHaveAttribute("aria-pressed", "false");

    await ada.composer().press("ArrowLeft");
    await ada.composer().press("ArrowLeft");
    await expect(tool(ada, "Link")).toHaveAttribute("aria-pressed", "true");
    await tool(ada, "Link").click();
    await editing.getByRole("button", { name: "Remove link" }).click();
    await expect(ada.composer().getByRole("link")).toHaveCount(0);
    await expect(ada.composer()).toHaveText("Ember's site");

    await ada.composer().press("ControlOrMeta+a");
    await tool(ada, "Link").click();
    await adding.getByLabel("Link").fill("https://example.com/");
    await adding.getByRole("button", { name: "Save" }).click();
    // Sent linked, though the dialog's still fading.
    await ada.composer().press("Enter");
    await expect(grace.message("Ember's site").getByRole("link", { name: "Ember's site" })).toHaveAttribute("href", "https://example.com/");
  });

  test("opens Link's dialog on Cmd or Ctrl+Shift+U and Cmd or Ctrl+K with the row hidden too, writing the address as the text when there's none", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await showFormatting(ada).click();
    await ada.composer().pressSequentially("See ");
    await ada.composer().press("ControlOrMeta+Shift+U");
    await expect(linkDialog(ada).getByLabel("Text")).toBeFocused();
    // The click shut the tooltip that named Show formatting as the pointer reached it, which takes Escape until it
    // has faded, hidden under the dialog as it is.
    await expect(ada.page.getByRole("tooltip", { includeHidden: true })).toHaveCount(0);
    await ada.page.keyboard.press("Escape");
    await expect(linkDialog(ada)).toBeHidden();
    await expect(ada.composer()).toBeFocused();

    await ada.composer().press("ControlOrMeta+k");
    await linkDialog(ada).getByLabel("Link").fill("example.com");
    await linkDialog(ada).getByLabel("Link").press("Enter");
    await expect(ada.composer()).toBeFocused();
    await ada.composer().pressSequentially(" for more");
    await ada.composer().press("Enter");
    const sent = grace.message("See").locator(".message-content");
    await expect(sent).toHaveText("See https://example.com for more");
    await expect(sent.getByRole("link")).toHaveAttribute("href", "https://example.com");
  });

  test("formats with Slack's keys", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    for (const [keys, element] of [
      ["ControlOrMeta+b", "strong"],
      ["ControlOrMeta+i", "em"],
      ["ControlOrMeta+u", "u"],
      ["ControlOrMeta+Shift+X", "s"],
      ["ControlOrMeta+Shift+7", "ol > li"],
      ["ControlOrMeta+Shift+8", "ul > li"],
      ["ControlOrMeta+Shift+9", "blockquote"],
      ["ControlOrMeta+Shift+C", "code"],
      ["ControlOrMeta+Alt+Shift+C", "pre"],
    ] as const) {
      await ada.composer().fill(`Pressed ${keys}`);
      await ada.composer().press("ControlOrMeta+a");
      await ada.composer().press(keys);
      await ada.composer().press("Enter");
      await expect(grace.message(`Pressed ${keys}`).locator(`.message-content ${element}`)).toHaveText(`Pressed ${keys}`);
    }
  });

  test("formats what's selected as a key's pressed, though the page has yet to tell the editor the selection grew", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("Launch week checklist");
    for (let n = 0; n < "hecklist".length; n++) await ada.composer().press("Shift+ArrowLeft");
    // A letter more, then Cmd or Ctrl+Shift+8.
    await pressAsSelectionMoves(ada, "extend", 1, { key: "*", code: "Digit8", shiftKey: true });
    await ada.composer().pressSequentially("plan");
    await expect(ada.composer().locator("li")).toHaveText("Launch week plan");
  });

  test("puts what's typed after a key where the cursor's moved to, in its text's format, though the page has yet to tell the editor", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().pressSequentially("Run ");
    await ada.composer().press("ControlOrMeta+b");
    await ada.composer().pressSequentially("now");
    // Back to after "Run", out of the bold, then Cmd or Ctrl+Shift+C.
    await pressAsSelectionMoves(ada, "move", 4, { key: "C", code: "KeyC", shiftKey: true });
    await ada.composer().pressSequentially(" it");
    await ada.composer().press("Enter");
    const content = grace.message("Run it now").locator(".message-content");
    await expect(content.locator("code")).toHaveText(" it");
    await expect(content.locator("strong")).toHaveText("now");
  });

  test("is one stop in the tab order, whose arrow keys move along it, formatting from the keyboard, with Escape back to the text", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().pressSequentially("Keyboard only");
    await ada.composer().press("ControlOrMeta+a");
    await ada.page.keyboard.press("Shift+Tab");
    await expect(tool(ada, "Bold")).toBeFocused();
    await ada.page.keyboard.press("Enter");
    await expect(tool(ada, "Bold")).toHaveAttribute("aria-pressed", "true");
    await expect(tool(ada, "Bold")).toBeFocused();
    await ada.page.keyboard.press("ArrowRight");
    await ada.page.keyboard.press("Space");
    await expect(tool(ada, "Italic")).toHaveAttribute("aria-pressed", "true");
    await ada.page.keyboard.press("End");
    await expect(tool(ada, "Divider")).toBeFocused();
    await ada.page.keyboard.press("Escape");
    await expect(ada.composer()).toBeFocused();
    await ada.composer().press("Enter");
    await expect(grace.message("Keyboard only").locator(".message-content strong")).toHaveText("Keyboard only");
    // Lexical writes italic over bold as i.
    await expect(grace.message("Keyboard only").locator(".message-content :is(em, i)")).toHaveText("Keyboard only");
  });

  test("formats what's selected with one button after another from the keyboard, though each redraws the text under the page's selection", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().pressSequentially("Keyboard only");
    await ada.composer().press("ControlOrMeta+a");
    await ada.page.keyboard.press("Shift+Tab");
    await ada.page.keyboard.press("Enter");
    // Bold redrew what's selected, leaving the page's selection collapsed before it.
    await pageTellsTheEditor(ada);
    await ada.page.keyboard.press("ArrowRight");
    await ada.page.keyboard.press("Space");
    await ada.page.keyboard.press("Escape");
    await expect(ada.composer()).toBeFocused();
    await ada.composer().press("Enter");
    await expect(grace.message("Keyboard only").locator(".message-content strong")).toHaveText("Keyboard only");
    await expect(grace.message("Keyboard only").locator(".message-content :is(em, i)")).toHaveText("Keyboard only");
  });

  test("takes where the cursor was moved to straight before focus went to the row", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("Keyboard only");
    await homeThenToTheRow(ada);
    await expect(tool(ada, "Bold")).toBeFocused();
    await ada.page.keyboard.press("Escape");
    await expect(ada.composer()).toBeFocused();
    await ada.composer().pressSequentially("Just ");
    await expect(ada.composer().locator("p")).toHaveText("Just Keyboard only");
  });

  test("puts focus back in the text on Escape after a button that formats what's typed next", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("Keyboard");
    await ada.page.keyboard.press("Shift+Tab");
    await ada.page.keyboard.press("Enter");
    await expect(tool(ada, "Bold")).toHaveAttribute("aria-pressed", "true");
    await ada.page.keyboard.press("Escape");
    await expect(ada.composer()).toBeFocused();
    await ada.composer().pressSequentially(" only");
    await expect(ada.composer().locator("strong")).toHaveText(" only");
  });

  test("greys out what a code block has no use for, and turns back into a paragraph", async ({ members }) => {
    const ada = await members.signIn("Ada");
    // The row shows as the composer does, and does nothing until the editor's there.
    await expect(ada.composer()).toBeFocused();
    await tool(ada, "Code block").click();
    await expect(tool(ada, "Code block")).toHaveAttribute("aria-pressed", "true");
    for (const name of ["Bold", "Italic", "Underline", "Strikethrough", "Link", "Code", "Divider"]) await expect(tool(ada, name)).toBeDisabled();
    for (const name of ["Paragraph", "Ordered list", "Bulleted list", "Blockquote", "Code block"]) await expect(tool(ada, name)).toBeEnabled();
    await ada.composer().pressSequentially("let x = 1");
    await ada.composer().press("ControlOrMeta+Shift+X");
    await expect(ada.composer().locator("s")).toHaveCount(0);

    await tool(ada, "Code block").click();
    await expect(tool(ada, "Bold")).toBeEnabled();
    await expect(ada.composer().locator("p")).toHaveText("let x = 1");
  });

  test("adds a divider under the line, going on after it", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().pressSequentially("Above");
    await tool(ada, "Divider").click();
    await ada.composer().pressSequentially("Below");
    await ada.composer().press("Enter");
    await expect(grace.message("Above").locator(".message-content > *")).toHaveText(["Above", "", "Below"]);
    await expect(grace.message("Above").locator(".message-content hr")).toHaveCount(1);
  });

  test("puts a divider in place of an empty line, as after a new line or a list, leaving no line break", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().pressSequentially("Plans");
    await ada.composer().press("Shift+Enter");
    await tool(ada, "Divider").click();
    await tool(ada, "Bulleted list").click();
    await ada.composer().pressSequentially("Milk");
    await ada.composer().press("Shift+Enter");
    await ada.composer().press("Shift+Enter");
    await tool(ada, "Divider").click();
    await ada.composer().pressSequentially("That's all");
    await ada.composer().press("Enter");
    const content = grace.message("Plans").locator(".message-content");
    await expect(content.locator(":scope > *")).toHaveText(["Plans", "", "Milk", "", "That's all"]);
    await expect(content.locator(":scope > hr")).toHaveCount(2);
    await expect(content.locator(":scope > ul")).toHaveCount(1);
    await expect(content.locator("br")).toHaveCount(0);
  });

  test("formats Markdown as it's typed", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const blocks = [
      ["# Heading", "h1", "Heading"],
      ["## Subheading", "h2", "Subheading"],
      ["### Small print", "h3", "Small print"],
      ["> Quoted", "blockquote", "Quoted"],
      ["- Bulleted", "ul > li", "Bulleted"],
      ["1. Numbered", "ol > li", "Numbered"],
      ["```js let x = 1", "pre[data-language=js]", "let x = 1"],
    ] as const;
    for (const [typed, element, text] of blocks) {
      await ada.composer().pressSequentially(typed);
      await ada.composer().press("Enter");
      await expect(grace.message(text).locator(`.message-content ${element}`)).toHaveText(text);
    }

    await ada.composer().pressSequentially("Some `code`, ~~struck~~ and [linked](https://example.com/) text");
    await ada.composer().press("Enter");
    const inline = grace.message("Some code").locator(".message-content");
    await expect(inline.locator("code")).toHaveText("code");
    await expect(inline.locator("s")).toHaveText("struck");
    await expect(inline.getByRole("link", { name: "linked" })).toHaveAttribute("href", "https://example.com/");

    await ada.composer().pressSequentially("--- Below the line");
    await ada.composer().press("Enter");
    await expect(grace.message("Below the line").locator(".message-content hr")).toHaveCount(1);
  });

  test("scrolls rather than wraps on a phone, where it's hidden to begin with, its buttons fingertip-sized", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { ...phone, viewport: { width: 320, height: 568 } } });
    await expect(formattingRow(ada)).toBeHidden();
    await showFormatting(ada).tap();
    await expect(formattingRow(ada)).toBeVisible();
    const bold = await box(tool(ada, "Bold"));
    expect(Math.min(bold.width, bold.height)).toBeGreaterThanOrEqual(44);
    expect(await formattingRow(ada).evaluate((row) => row.scrollWidth > row.clientWidth)).toBe(true);
    await tool(ada, "Divider").scrollIntoViewIfNeeded();
    await expect(tool(ada, "Divider")).toBeInViewport();
    expect((await box(tool(ada, "Divider"))).y).toBe(bold.y);
  });

  test("wraps in a narrow composer with a mouse", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1280, height: 800 } } });
    await ada.page.locator("form.composer").evaluate((form) => (form.style.inlineSize = "240px"));
    await expect.poll(async () => (await box(tool(ada, "Divider"))).y - (await box(tool(ada, "Bold"))).y).toBeGreaterThan(0);
    await expect(tool(ada, "Divider")).toBeInViewport();
  });
});

test.describe("Buttons under the text", () => {
  test("names each in a tooltip, as Slack's do", async ({ members }) => {
    const ada = await members.signIn("Ada");
    // Once the text's ready, which Emoji and Mention someone wait for.
    await expect(ada.composer()).toBeFocused();
    const tips = [
      ["Attach", "Attach"],
      ["Show formatting", "Hide formatting"],
      ["Emoji", "Emoji"],
      ["Mention someone", "Mention someone"],
      ["Send Message", "Send message"],
    ] as const;
    for (const [name, tip] of tips) {
      await underText(ada, name).hover();
      await expect(ada.page.getByRole("tooltip", { name: tip, exact: true })).toBeVisible();
    }
  });

  test("opens Slack's + menu of Text snippet and Upload from your computer, with their keys, Escape putting focus back in the text", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await underText(ada, "Attach").click();
    await expect(attachMenu(ada).getByRole("menuitem")).toHaveText([/^Text snippet(Ctrl\+Shift\+Enter|⌘⇧Enter)$/, /^Upload from your computer(Ctrl\+O|⌘O)$/]);
    await expect(attachChoice(ada, "Upload from your computer")).toHaveAttribute("aria-keyshortcuts", /^(Control|Meta)\+O$/);
    await expect(underText(ada, "Attach")).toHaveAttribute("aria-expanded", "true");
    await ada.page.keyboard.press("Escape");
    await expect(attachMenu(ada)).toBeHidden();
    await expect(ada.composer()).toBeFocused();
  });

  test("picks files to send with Upload from your computer, and with Cmd or Ctrl+O", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    let chooser = ada.page.waitForEvent("filechooser");
    await underText(ada, "Attach").click();
    await attachChoice(ada, "Upload from your computer").click();
    expect((await chooser).isMultiple()).toBe(true);
    await (await chooser).setFiles(textFile("agenda.txt", "Agenda"));
    await expect(ada.page.getByRole("button", { name: "Remove agenda.txt" })).toBeVisible();
    await expect(ada.composer()).toBeFocused();

    chooser = ada.page.waitForEvent("filechooser");
    await ada.composer().press("ControlOrMeta+o");
    await (await chooser).setFiles(textFile("minutes.txt", "Minutes"));
    await expect(ada.page.getByRole("button", { name: "Remove minutes.txt" })).toBeVisible();
    await ada.composer().press("Enter");
    await expect(grace.message("agenda.txt")).toBeVisible();
    await expect(grace.message("minutes.txt")).toBeVisible();
  });

  test("writes a text snippet to send as a file named by its title, from the + menu and on Cmd or Ctrl+Shift+Enter", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await underText(ada, "Attach").click();
    await attachChoice(ada, "Text snippet").click();
    const dialog = snippetDialog(ada);
    await expect(dialog.getByLabel("Content")).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Create snippet" })).toBeDisabled();
    await dialog.getByLabel("Title (optional)").fill("deploy.sh");
    await dialog.getByLabel("Content").fill("#!/bin/sh\necho deployed");
    await dialog.getByRole("button", { name: "Create snippet" }).click();
    await expect(dialog).toBeHidden();
    await expect(ada.page.getByRole("button", { name: "Remove deploy.sh" })).toBeVisible();
    await expect(ada.composer()).toBeFocused();

    await ada.composer().press("ControlOrMeta+Shift+Enter");
    await expect(dialog.getByLabel("Content")).toBeFocused();
    await dialog.getByLabel("Content").fill("SELECT 1;");
    await dialog.getByLabel("Content").press("ControlOrMeta+Enter");
    await expect(ada.page.getByRole("button", { name: "Remove Untitled.txt" })).toBeVisible();

    await ada.composer().pressSequentially("Two snippets");
    await ada.composer().press("Enter");
    await expect(grace.message("Two snippets")).toBeVisible();
    const [download] = await Promise.all([grace.page.waitForEvent("download"), grace.message("deploy.sh").getByRole("link", { name: "Download deploy.sh" }).click()]);
    expect(await readFile(await download.path(), "utf8")).toBe("#!/bin/sh\necho deployed");
    await expect(grace.message("Untitled.txt")).toBeVisible();
  });

  test("picks from every emoji, by search too, from Ember itself, writing it where the cursor is", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const data = ada.page.waitForResponse((response) => new URL(response.url()).pathname === "/emojibase/en/data.json");
    await ada.composer().pressSequentially("Party ");
    await underText(ada, "Emoji").click();
    expect((await data).ok()).toBe(true);
    const picker = emojiPicker(ada);
    await expect(picker.getByLabel("Search all emoji")).toBeFocused();
    await expect(picker.getByRole("gridcell", { name: "Grinning face", exact: true })).toBeVisible();
    await picker.getByLabel("Search all emoji").fill("party popper");
    await picker.getByRole("gridcell", { name: "Party popper", exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(ada.composer()).toHaveText("Party 🎉");
    await expect(ada.composer()).toBeFocused();
    await ada.composer().pressSequentially(" time");
    await expect(ada.composer()).toHaveText("Party 🎉 time");
  });

  test("keeps the skin tone picked for next time", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await underText(ada, "Emoji").click();
    await emojiPicker(ada).getByRole("button", { name: /^Change skin tone/ }).click();
    await emojiPicker(ada).getByLabel("Search all emoji").fill("thumbs up");
    await emojiPicker(ada).getByRole("gridcell", { name: "Thumbs up", exact: true }).click();
    await expect(ada.composer()).toHaveText("👍🏻");

    await ada.page.reload();
    await ada.connected();
    await ada.composer().press("ControlOrMeta+a");
    await ada.composer().press("Backspace");
    await underText(ada, "Emoji").click();
    await emojiPicker(ada).getByLabel("Search all emoji").fill("thumbs up");
    await emojiPicker(ada).getByRole("gridcell", { name: "Thumbs up", exact: true }).click();
    await expect(ada.composer()).toHaveText("👍🏻");
  });

  test("puts focus back in the text as Escape, or Emoji again, closes the emoji picker", async ({ members }) => {
    const ada = await members.signIn("Ada");
    for (const close of [() => ada.page.keyboard.press("Escape"), () => underText(ada, "Emoji").click()]) {
      await underText(ada, "Emoji").click();
      await expect(emojiPicker(ada).getByLabel("Search all emoji")).toBeFocused();
      await close();
      await expect(emojiPicker(ada)).toBeHidden();
      await expect(ada.composer()).toBeFocused();
    }
  });

  test("leaves focus where a click outside the emoji picker puts it, as in another composer", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await grace.send("Lunch at noon?");
    await (await ada.actions("Lunch at noon?")).getByRole("link", { name: "Reply in thread" }).click();
    await ada.page.getByRole("complementary", { name: "Thread" }).getByRole("button", { name: "Emoji", exact: true }).click();
    // Once its search has loaded, which takes focus as it shows.
    await expect(emojiPicker(ada).getByLabel("Search all emoji")).toBeFocused();
    await ada.composer().click();
    await expect(emojiPicker(ada)).toBeHidden();
    // The picker hands focus on a moment after it's gone.
    await ada.page.evaluate(() => new Promise((handedOn) => setTimeout(handedOn)));
    await expect(ada.composer()).toBeFocused();
  });

  test("starts a mention where the cursor is with Mention someone, listing the room's people", async ({ members, participant }) => {
    const tag = crypto.randomUUID().slice(0, 8);
    await participant(`Jason ${tag}`);
    const ada = await members.signIn(`Ada ${tag}`);
    await ada.composer().pressSequentially("Thanks");
    await underText(ada, "Mention someone").click();
    await expect(ada.page.getByRole("listbox")).toBeVisible();
    await expect(ada.composer()).toHaveText("Thanks @");
    await expect(ada.composer()).toBeFocused();

    const answered = ada.page.waitForResponse((response) => new URL(response.url()).searchParams.get("filter") === tag);
    await ada.composer().pressSequentially(tag);
    await answered;
    await expect(ada.page.getByRole("listbox").getByRole("option")).toHaveText([`Ada ${tag}`, `Jason ${tag}`]);
    await ada.composer().press("ArrowDown");
    await ada.composer().press("Tab");
    await expect(ada.composer().getByText(`Jason ${tag}`, { exact: true })).toBeVisible();
  });

  test("keeps Emoji and Mention someone off until the text they write in is ready", async ({ members }) => {
    const ada = await members.signIn("Ada");
    // The editor's code loads once the room has shown its messages. Holding it shows the composer without it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await ada.page.route(/\/assets\/rich-text-editor-[^/]+\.js$/, async (route) => {
      await held;
      await route.continue();
    });
    await ada.page.reload();
    const button = (name: string) => ada.page.locator("form.composer").getByRole("button", { name, exact: true });
    await expect(button("Emoji")).toBeDisabled();
    await expect(button("Mention someone")).toBeDisabled();
    release();
    await expect(button("Emoji")).toBeEnabled();
    await expect(button("Mention someone")).toBeEnabled();
  });

  test("shows Send as a grey paper plane until there's something to send, a file too", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const send = underText(ada, "Send Message");
    await expect(send).toHaveAttribute("data-empty");
    await expect(send).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await ada.composer().pressSequentially("Hello");
    await expect(send).not.toHaveAttribute("data-empty");
    await expect(send).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await send.click();
    await expect(ada.message("Hello")).toBeVisible();
    await expect(send).toHaveAttribute("data-empty");

    const chooser = ada.page.waitForEvent("filechooser");
    await ada.composer().press("ControlOrMeta+o");
    await (await chooser).setFiles(textFile("notes.txt", "Notes"));
    await expect(send).not.toHaveAttribute("data-empty");
  });
});

test.describe("Pasting into the composer", () => {
  test("pastes an address as a link, and over selected text, links the text to it", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await paste(ada, "https://example.com/article");
    await expect(ada.composer().getByRole("link", { name: "https://example.com/article" })).toHaveAttribute("href", "https://example.com/article");

    await ada.composer().press("ControlOrMeta+a");
    await ada.composer().press("Delete");
    await ada.composer().pressSequentially("Ember");
    await ada.composer().press("ControlOrMeta+a");
    await paste(ada, "https://example.com/");
    await expect(ada.composer()).toHaveText("Ember");
    await ada.composer().press("Enter");
    await expect(grace.message("Ember").getByRole("link", { name: "Ember" })).toHaveAttribute("href", "https://example.com/");
  });

  test("converts pasted Markdown, keeping its line breaks, and pastes other text as it is", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await paste(ada, "**Bold** and _italic_\nsecond line\n\n- one\n- two");
    await expect(ada.composer().locator("strong")).toHaveText("Bold");
    await expect(ada.composer().locator("em")).toHaveText("italic");
    await expect(ada.composer().locator("li")).toHaveText(["one", "two"]);
    await ada.composer().press("Enter");
    const message = grace.message("Bold and italic").locator(".message-content");
    await expect(message.locator("p")).toHaveText("Bold and italic\nsecond line", { useInnerText: true });
    await expect(message.locator("p > br")).toHaveCount(1);
    await expect(message.locator("ul > li")).toHaveText(["one", "two"]);

    // Without Markdown, nothing is changed: not runs of spaces, nor backslashes.
    await paste(ada, "C:\\Users\\ada\\my  notes.txt");
    await ada.composer().press("Enter");
    await expect(grace.message("notes.txt")).toBeVisible();
    expect(await grace.message("notes.txt").locator(".message-content").textContent()).toBe("C:\\Users\\ada\\my  notes.txt");
  });

  test("keeps text pasted into a code block as it is", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().pressSequentially("```");
    await ada.composer().press("Space");
    await paste(ada, "**not bold**\n  indented");
    await ada.composer().press("Enter");
    const code = grace.message("not bold").locator(".message-content pre");
    await expect(code).toBeVisible();
    expect(await code.innerText()).toBe("**not bold**\n  indented");
  });

  test("keeps pasted formatting, tables included", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await paste(ada, "Name Points\nJason 10", "<table><tr><th>Name</th><th>Points</th></tr><tr><td>Jason</td><td>10</td></tr></table>");
    await expect(ada.composer().locator("table")).toBeVisible();
    await ada.composer().press("Enter");
    const table = grace.message("Jason").locator(".message-content table");
    await expect(table.locator("th")).toHaveText(["Name", "Points"]);
    await expect(table.locator("td")).toHaveText(["Jason", "10"]);

    await paste(ada, "Bold, struck and linked", '<p><b>Bold</b>, <s>struck</s> and <a href="https://example.com/">linked</a></p>');
    await ada.composer().press("Enter");
    const formatted = grace.message("struck and linked").locator(".message-content");
    await expect(formatted.locator("strong")).toHaveText("Bold");
    await expect(formatted.locator("s")).toHaveText("struck");
    await expect(formatted.getByRole("link", { name: "linked" })).toHaveAttribute("href", "https://example.com/");
  });

  test("waits to send pasted files rather than putting them in the text", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("Look");
    await ada.composer().evaluate((content) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([new Uint8Array([137, 80, 78, 71])], "screenshot.png", { type: "image/png" }));
      content.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await expect(ada.composer()).toHaveText("Look");
    await expect(ada.composer().locator("img, action-text-attachment, figure")).toHaveCount(0);
    await expect(ada.page.getByRole("button", { name: "Remove screenshot.png" })).toBeVisible();
  });
});

test.describe("Send from the keyboard", () => {
  test("sends on Enter, starts a new line on Shift+Enter and never sends a blank message", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().pressSequentially("   ");
    await ada.composer().press("Enter");

    await ada.composer().fill("First line");
    await ada.composer().press("Shift+Enter");
    await ada.composer().pressSequentially("second line");
    await expect(ada.composer()).toHaveText("First line\nsecond line", { useInnerText: true });
    await ada.composer().press("Enter");

    await expect(grace.message("First line")).toContainText("second line");
    await expect(grace.page.getByRole("article")).toHaveCount(1);
    await expect(ada.composer()).toHaveText("");
    await expect(ada.composer()).toBeFocused();
  });

  test("quotes line by line, as Slack does: Backspace on an empty quoted line ends the quote, and > quotes just its line", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");

    // A quote, then what's said about it, on a line Backspace takes out of the quote.
    await ada.composer().pressSequentially("> Not obvious who is in this room?");
    await ada.composer().press("Shift+Enter");
    await ada.composer().press("Backspace");
    await ada.composer().pressSequentially("Agreed, it needs a people list.");
    await ada.composer().press("Enter");
    const reply = grace.message("Agreed").locator(".message-content");
    await expect(reply.locator("blockquote")).toHaveText("Not obvious who is in this room?");
    await expect(reply.locator(":scope > p")).toHaveText("Agreed, it needs a people list.");

    // > at the start of a line added above what's written quotes that line alone.
    await ada.composer().press("Shift+Enter");
    await ada.composer().pressSequentially("What was said");
    await expect(ada.composer()).toHaveText("\nWhat was said", { useInnerText: true });
    await ada.composer().press("ArrowUp");
    // Lexical hears the caret move with the selectionchange after the key, as a frame goes by.
    await ada.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await ada.composer().pressSequentially("> The quote");
    await ada.composer().press("Enter");
    const quoted = grace.message("The quote").locator(".message-content");
    await expect(quoted.locator("blockquote")).toHaveText("The quote");
    await expect(quoted.locator(":scope > p")).toHaveText("What was said");

    // > on a later line quotes that line, leaving the ones before it as they are.
    await ada.composer().pressSequentially("Before");
    await ada.composer().press("Shift+Enter");
    await ada.composer().pressSequentially("> Middle");
    await ada.composer().press("Enter");
    const middle = grace.message("Before").locator(".message-content");
    await expect(middle.locator("blockquote")).toHaveText("Middle");
    await expect(middle.locator(":scope > p").first()).toHaveText("Before");
  });

  test("sends on Enter with the formatting row showing, as Slack's does, keeping the row", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await expect(formattingRow(ada)).toBeVisible();
    await ada.composer().pressSequentially("One");
    await ada.composer().press("Enter");
    await expect(ada.message("One")).toBeVisible();
    await expect(ada.composer()).toHaveText("");
    await expect(ada.composer()).toBeFocused();
    await expect(formattingRow(ada)).toBeVisible();
  });

  test("says a message over 40,000 characters is too long instead of sending it, keeping it to be cut down", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await write(ada, `<p>${"x".repeat(MAX_MESSAGE_LENGTH + 1)}</p>`);
    await ada.composer().press("Enter");
    await expect(ada.page.getByRole("alert")).toHaveText("Messages can be up to 40,000 characters.");
    await expect(ada.composer()).toHaveText("x".repeat(MAX_MESSAGE_LENGTH + 1));
    await expect(ada.page.getByRole("article")).toHaveCount(0);
  });

  test("starts a new paragraph on Enter on a touch screen, where only the Send button sends", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: phone });
    await ada.composer().tap();
    await ada.page.keyboard.type("First line");
    await ada.page.keyboard.press("Enter");
    await ada.page.keyboard.type("second line");
    await expect(ada.composer().locator("p")).toHaveText(["First line", "second line"]);
    await expect(ada.page.getByRole("article")).toHaveCount(0);

    await ada.page.getByRole("button", { name: "Send Message" }).tap();
    await expect(ada.message("First line")).toContainText("second line");
    await expect(ada.composer()).toBeFocused();
  });
});

test.describe("Keep drafts", () => {
  test("keeps what's written in a room, formatting and all, until it's sent", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("Half a **thought** so far");
    await expect(ada.composer().locator("strong")).toHaveText("thought");

    await ada.page.reload();
    await ada.connected();
    await expect(ada.composer().locator("strong")).toHaveText("thought");
    await expect(ada.composer()).toBeFocused();
    // The cursor is after what was written.
    await ada.page.keyboard.type(" and more");
    await expect(ada.composer()).toHaveText("Half a thought so far and more");

    await ada.composer().press("Enter");
    await expect(ada.message("Half a thought so far and more").locator(".message-content strong")).toHaveText("thought");
    await ada.page.reload();
    await ada.connected();
    await expect(ada.composer()).toHaveText("");
  });

  test("keeps each room's to itself", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("For general");
    await openRoom(ada, "random");
    await expect(ada.composer()).toHaveText("");
    await ada.composer().pressSequentially("For random");

    await openRoom(ada, "general");
    await expect(ada.composer()).toHaveText("For general");
    await openRoom(ada, "random");
    await expect(ada.composer()).toHaveText("For random");
  });
});

test.describe("Rich text, safely", () => {
  test("sends the formatting Markdown makes as it's typed", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().pressSequentially("Some **bold** and _italic_ text");
    await ada.composer().press("Enter");
    const text = grace.message("Some bold").locator(".message-content");
    await expect(text.locator("strong")).toHaveText("bold");
    await expect(text.locator("em")).toHaveText("italic");
  });

  test("sends what's typed as text, never as markup", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("<b>1</b> < 2 & 3");
    await ada.composer().press("Enter");
    await expect(ada.message("<b>1</b> < 2 & 3")).toBeVisible();
    await expect(ada.message("< 2 & 3").locator(".message-content b")).toHaveCount(0);
  });
});
