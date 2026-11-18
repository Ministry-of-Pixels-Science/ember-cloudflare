import { HISTORY_PAGE_SIZE, type Message } from "@ember/protocol";
import type { Page } from "@playwright/test";
import { expect, test, type Member } from "./fixtures";

// Every test here starts in a room with more history than fits on one page.
const COUNT = HISTORY_PAGE_SIZE + 20;

/** The body of message `n`, zero-padded so that #1 doesn't also match #10 to #19. */
const body = (n: number) => `History #${String(n).padStart(3, "0")}`;

/** The messages posted before each test, #1 first. */
let posted: Message[] = [];

test.beforeEach(async ({ participant }) => {
  const archivist = await participant("Archivist");
  posted = [];
  for (let n = 1; n <= COUNT; n++) posted.push(await archivist.say(body(n)));
});

/** Message #`n`'s permalink. */
const permalink = (n: number) => `/rooms/${encodeURIComponent(posted[n - 1]!.roomId)}/@${encodeURIComponent(posted[n - 1]!.id)}`;

/** Keeps, for each message the page outlines, its id and its outline as the outline starts. */
const recordOutlines = async (page: Page) => {
  await page.addInitScript(() => {
    const outlines: Array<{ messageId: string | undefined; outline: string }> = [];
    Object.assign(window, { outlines });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      const animation = animate.apply(this, args);
      // Put together from its parts, as each browser writes the shorthand in an order of its own.
      const { outlineColor, outlineStyle, outlineWidth } = getComputedStyle(this);
      outlines.push({ messageId: this.closest<HTMLElement>("[data-message-id]")?.dataset.messageId, outline: `${outlineColor} ${outlineStyle} ${outlineWidth}` });
      return animation;
    };
  });
};
const outlines = (member: Member) => member.page.evaluate(() => (window as unknown as { outlines: unknown[] }).outlines);

/** How far the middle of message #`n` is from the middle of the timeline. */
async function offCentre(member: Member, n: number): Promise<number> {
  const log = (await member.timeline().boundingBox())!;
  const message = (await member.message(body(n)).boundingBox())!;
  return Math.abs(message.y + message.height / 2 - (log.y + log.height / 2));
}

/** The sidebar's link to the room the messages were posted in. */
const roomLink = (member: Member) => member.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: "general" });

/** The day separator just above the message that says `text`, if it has one. */
const separatorAbove = (member: Member, text: string) => member.message(text).locator("xpath=preceding-sibling::h2");

/** The days `messages` were written on, in UTC, as their separators date them. */
const daysOf = (messages: Message[]) => [...new Set(messages.map((m) => new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(m.createdAt))))];

const scrollToTop = (member: Member) => member.timeline().evaluate((el) => el.scrollTo({ top: 0 }));
const scrollToBottom = (member: Member) => member.timeline().evaluate((el) => el.scrollTo({ top: el.scrollHeight }));

test.describe("Scroll back through history", () => {
  test("opens on the newest page and loads earlier messages when you scroll up, keeping your place", async ({ members }) => {
    const ada = await members.signIn("Ada");

    await expect(ada.message(body(COUNT))).toBeInViewport();
    const firstLoaded = COUNT - HISTORY_PAGE_SIZE + 1;
    await expect(ada.message(body(firstLoaded))).toBeAttached();
    await expect(ada.message(body(firstLoaded - 1))).toHaveCount(0);

    await scrollToTop(ada);
    await expect(ada.message(body(1))).toBeAttached();
    await expect(ada.message(body(firstLoaded - 1))).toBeAttached();
    // The message that was at the top is still in view, rather than the view jumping to the oldest.
    await expect(ada.message(body(firstLoaded))).toBeInViewport();
    await expect(ada.message(body(1))).not.toBeInViewport();
    await expect(ada.page.getByText("Loading earlier messages…")).toHaveCount(0);
  });

  test("loads later messages as you scroll down from an old message's permalink, until it reaches the newest", async ({ members }) => {
    const ada = await members.signIn("Ada", { path: permalink(15) });
    // The page around #15 holds the 40 after it, so not the newest.
    await expect(ada.message(body(15 + HISTORY_PAGE_SIZE))).toBeAttached();
    await expect(ada.message(body(16 + HISTORY_PAGE_SIZE))).toHaveCount(0);

    await scrollToBottom(ada);
    await expect(ada.message(body(COUNT))).toBeAttached();
    // The reader stays where they were, with the later messages below.
    await expect(ada.message(body(15 + HISTORY_PAGE_SIZE))).toBeInViewport();
    await expect(ada.message(body(COUNT))).not.toBeInViewport();
    await scrollToBottom(ada);
    await expect(ada.message(body(COUNT))).toBeInViewport();
  });

  test("holds at most 320 messages, cutting the end you're furthest from as you page", async ({ members, participant }) => {
    test.slow();
    const total = 340;
    await (await participant("Chronicler")).sayAll(Array.from({ length: total - COUNT }, (_, i) => body(COUNT + 1 + i)));
    const ada = await members.signIn("Ada");
    await expect(ada.message(body(total))).toBeInViewport();

    // Paging back to #21 holds 320, which it keeps.
    for (let oldest = total - HISTORY_PAGE_SIZE + 1; oldest > 21; oldest -= HISTORY_PAGE_SIZE) {
      await scrollToTop(ada);
      await expect(ada.message(body(oldest - HISTORY_PAGE_SIZE))).toBeAttached();
    }
    await expect(ada.message(body(total))).toBeAttached();
    // One more page makes 340, so the newest 40 go, and the reader stays where they were.
    await scrollToTop(ada);
    await expect(ada.message(body(1))).toBeAttached();
    await expect(ada.message(body(total))).toHaveCount(0);
    await expect(ada.message(body(300))).toBeAttached();
    await expect(ada.message(body(21))).toBeInViewport();

    // Back at the end, the newest come again, and the oldest 40 go.
    await scrollToBottom(ada);
    await expect(ada.message(body(total))).toBeAttached();
    await expect(ada.message(body(40))).toHaveCount(0);
    await expect(ada.message(body(41))).toBeAttached();
    await expect(ada.page.getByRole("article")).toHaveCount(300);
  });
});

test.describe("Day separators", () => {
  test("dates the first message loaded, and then the day's first as earlier pages load", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { timezoneId: "UTC", locale: "en-US" } });
    const separators = ada.timeline().getByRole("heading", { level: 2 });
    const firstLoaded = COUNT - HISTORY_PAGE_SIZE + 1;
    await expect(separators).toHaveText(daysOf(posted.slice(firstLoaded - 1)));
    await expect(separatorAbove(ada, body(firstLoaded))).toHaveCount(1);

    await scrollToTop(ada);
    await expect(ada.message(body(1))).toBeAttached();
    await expect(separators).toHaveText(daysOf(posted));
    await expect(separatorAbove(ada, body(1))).toHaveCount(1);
  });
});

test.describe("Stay at the newest message", () => {
  test("follows new messages while you're at the bottom", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await grace.send("Latest news");
    await expect(ada.message("Latest news")).toBeInViewport();
  });

  test("stays put when you've scrolled up, and offers the way to new messages as they come", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const jump = ada.page.getByRole("button", { name: "Jump to newest message" });

    await ada.timeline().evaluate((el) => el.scrollTo({ top: el.scrollHeight - el.clientHeight - 800 }));
    // Scrolling up alone doesn't offer it.
    await expect(ada.message(body(COUNT))).not.toBeInViewport();
    await expect(jump).toHaveCount(0);

    await grace.send("While you were reading");
    await expect(ada.message("While you were reading")).toBeAttached();
    await expect(ada.message("While you were reading")).not.toBeInViewport();
    await expect(jump).toBeVisible();

    await jump.click();
    await expect(ada.message("While you were reading")).toBeInViewport();
    await expect(jump).toHaveCount(0);
  });

  test("jumps from older history to the newest messages, which wait until then", async ({ members }) => {
    const ada = await members.signIn("Ada", { path: permalink(15) });
    const grace = await members.signIn("Grace");
    const jump = ada.page.getByRole("button", { name: "Jump to newest message" });

    await grace.send("Meanwhile");
    await expect(jump).toBeVisible();
    await expect(ada.message("Meanwhile")).toHaveCount(0);

    await jump.click();
    await expect(ada.message("Meanwhile")).toBeInViewport();
    await expect(ada.message(body(15))).toHaveCount(0);
    await expect(jump).toHaveCount(0);
  });

  test("goes to the newest messages as you send one from older history", async ({ members }) => {
    const ada = await members.signIn("Ada", { path: permalink(15) });
    await ada.send("Back to the present");
    await expect(ada.message("Back to the present")).toBeInViewport();
    await expect(ada.message(body(COUNT))).toBeAttached();
    await expect(ada.message(body(15))).toHaveCount(0);
  });
});

test.describe("Link to a message", () => {
  test("opens an old message's permalink on the page around it, with the message centred and outlined", async ({ members }) => {
    const ada = await members.signIn("Ada", { path: permalink(15), beforeOpen: recordOutlines });
    await expect(ada.message(body(15))).toBeInViewport();
    expect(await offCentre(ada, 15)).toBeLessThanOrEqual(1);
    await expect(ada.message(body(1))).toBeAttached();
    await expect(ada.message(body(COUNT))).toHaveCount(0);
    // Campfire's highlight: a 2px outline in the ink, which fades.
    expect(await outlines(ada)).toEqual([{ messageId: posted[14]!.id, outline: "rgb(23, 23, 23) solid 2px" }]);
    await expect(ada.message(body(15)).locator("[data-body-content]")).toHaveCSS("outline-style", "none");
    // The sidebar marks the room as the one you're in.
    await expect(roomLink(ada)).toHaveAttribute("aria-current", "page");
  });

  test("opens the newest messages for a message the room doesn't have, and goes home for a room you can't see", async ({ members }) => {
    const room = encodeURIComponent(posted[0]!.roomId);
    const ada = await members.signIn("Ada", { path: `/rooms/${room}/@no-such-message` });
    await expect(ada.message(body(COUNT))).toBeInViewport();
    await expect(ada.message(body(COUNT - HISTORY_PAGE_SIZE))).toHaveCount(0);

    await ada.page.goto(`/rooms/nowhere/@${encodeURIComponent(posted[0]!.id)}`);
    await expect(ada.page.getByRole("alert")).toHaveText("Room not found or inaccessible");
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${room}$`));
  });

  test("goes to a message in the room as its permalink is followed there, and again each time", async ({ members, participant, baseURL }) => {
    const ada = await members.signIn("Ada", { beforeOpen: recordOutlines });
    await (await participant("Grace")).say(`Remember this? ${baseURL}${permalink(3)}`);
    const link = ada.message("Remember this?").getByRole("link", { name: `${baseURL}${permalink(3)}` });

    await link.click();
    await expect(ada.page).toHaveURL(permalink(3));
    await expect(ada.message(body(3))).toBeInViewport();
    await expect(ada.message("Remember this?")).toHaveCount(0);

    // From there, the room's own link goes back to its newest messages.
    await roomLink(ada).click();
    await expect(ada.message("Remember this?")).toBeInViewport();
    await link.click();
    await expect(ada.message(body(3))).toBeInViewport();
    expect((await outlines(ada)).map((o) => (o as { messageId: string }).messageId)).toEqual([posted[2]!.id, posted[2]!.id]);
  });
});
