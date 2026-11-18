import type { LinkPreview } from "@ember/protocol";
import type { Locator } from "@playwright/test";
import { expect, paste, test, type Member } from "./fixtures";

const basecamp: LinkPreview = {
  title: "Basecamp",
  url: "https://basecamp.com/",
  image: "https://basecamp.com/og.png",
  description: "The calm, organized way to manage projects",
};

/** A one-pixel PNG, for the preview's image. */
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** Answers the links `member` pastes with `preview`, and serves its image. */
async function previewWith(member: Member, preview: LinkPreview) {
  await member.page.route("**/api/unfurl", (route) => route.fulfill({ json: preview }));
  await member.page.route(preview.image!, (route) => route.fulfill({ contentType: "image/png", body: PIXEL }));
}

/**
 * Answers the links `member` writes with `preview` only once the function it answers is called, as a
 * page that takes seconds to answer does, and serves its image.
 */
async function slowPreviewWith(member: Member, preview: LinkPreview): Promise<() => void> {
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  await member.page.route("**/api/unfurl", async (route) => {
    await answered;
    await route.fulfill({ json: preview });
  });
  await member.page.route(preview.image!, (route) => route.fulfill({ contentType: "image/png", body: PIXEL }));
  return answer;
}

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("Not visible");
  return rect;
};

test.describe("Link previews while writing", () => {
  test("adds a pasted link's preview below it, which goes with the message", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await previewWith(ada, basecamp);
    await paste(ada, "https://basecamp.com/");
    const card = ada.composer().locator("action-text-attachment .og-embed");
    await expect(card.getByRole("link", { name: "Basecamp", exact: true })).toHaveAttribute("href", "https://basecamp.com/");
    await expect(card).toContainText("The calm, organized way to manage projects");
    // Campfire's card, not Lexxy's small round image for an attachment.
    expect((await box(card.locator("img"))).width).toBeGreaterThan(20);

    await ada.composer().press("Enter");
    await expect(grace.message("Basecamp").getByRole("link", { name: "Basecamp", exact: true })).toHaveAttribute("href", "https://basecamp.com/");
  });

  test("keeps a message's preview while it's edited", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await previewWith(ada, basecamp);
    await paste(ada, "https://basecamp.com/");
    await expect(ada.composer().locator("action-text-attachment")).toHaveCount(1);
    await ada.composer().press("Enter");

    await (await ada.actions("Basecamp")).getByRole("button", { name: "Edit" }).click();
    await expect(ada.editor().locator("action-text-attachment .og-embed")).toContainText("Basecamp");
    await ada.editor().locator("p").first().click();
    await ada.page.keyboard.press("End");
    await ada.page.keyboard.type(" is calm");
    await ada.editor().press("ControlOrMeta+Enter");
    const message = ada.message("is calm");
    await expect(message).toContainText("(edited)");
    await expect(message.getByRole("link", { name: "https://basecamp.com/" })).toBeVisible();
    await expect(message.getByRole("link", { name: "Basecamp", exact: true })).toBeVisible();
  });
});

test.describe("Link previews after sending", () => {
  test("adds a pasted link's preview that comes once the message has gone, for everyone, without marking it edited", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const answer = await slowPreviewWith(ada, basecamp);
    await paste(ada, "https://basecamp.com/");
    await ada.page.keyboard.type(" is calm");
    await ada.composer().press("Enter");
    const message = grace.message("is calm");
    await expect(message.getByRole("link", { name: "https://basecamp.com/" })).toBeVisible();
    await expect(message.getByRole("link", { name: "Basecamp", exact: true })).toHaveCount(0);

    answer();
    await expect(message.getByRole("link", { name: "Basecamp", exact: true })).toHaveAttribute("href", "https://basecamp.com/");
    await expect(message).toContainText("The calm, organized way to manage projects");
    await expect(message).not.toContainText("(edited)");
    await expect(ada.message("is calm").getByRole("link", { name: "Basecamp", exact: true })).toBeVisible();
    await expect(ada.composer().locator("action-text-attachment")).toHaveCount(0);
  });

  test("adds the preview of a link typed rather than pasted once the message has gone, as Slack does", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await previewWith(ada, basecamp);
    await ada.send("We moved to https://basecamp.com/ today");
    const message = grace.message("We moved to");
    await expect(message.getByRole("link", { name: "Basecamp", exact: true })).toHaveAttribute("href", "https://basecamp.com/");
    await expect(message.getByRole("link", { name: "https://basecamp.com/" })).toBeVisible();
    await expect(message).not.toContainText("(edited)");
  });
});

test.describe("Keep drafts", () => {
  test("keeps a pasted link's preview in what's written", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await previewWith(ada, basecamp);
    await paste(ada, "https://basecamp.com/");
    await expect(ada.composer().locator("action-text-attachment")).toHaveCount(1);

    await ada.page.reload();
    await ada.connected();
    await expect(ada.composer().locator("action-text-attachment .og-embed")).toContainText("Basecamp");
    await ada.composer().press("Enter");
    await expect(ada.message("Basecamp").getByRole("link", { name: "Basecamp", exact: true })).toBeVisible();
  });
});

test.describe("Link previews in messages", () => {
  test("shows a message that's only a link as its preview: the page's title, linked, its description and its image", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1280, height: 800 } } });
    await previewWith(ada, basecamp);
    await paste(ada, "https://basecamp.com/");
    await expect(ada.composer().locator("action-text-attachment")).toHaveCount(1);
    await ada.composer().press("Enter");

    const message = ada.message("Basecamp");
    await expect(message).not.toHaveAttribute("aria-busy");
    const title = message.getByRole("link", { name: "Basecamp", exact: true });
    await expect(title).toHaveAttribute("target", "_blank");
    await expect(message).toContainText("The calm, organized way to manage projects");
    // The link written is all there is to the message, so only its preview shows.
    await expect(message.getByRole("link", { name: "https://basecamp.com/" })).toHaveCount(0);
    // The image is beside the text on a wide screen.
    const image = message.locator(".message-content img");
    await expect(image).toHaveAttribute("src", "https://basecamp.com/og.png");
    expect((await box(image)).x).toBeGreaterThan((await box(title)).x + (await box(title)).width);
  });

  test("loads a preview's image without a referrer, so its site doesn't learn which Ember shows it", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await previewWith(ada, basecamp);
    await grace.page.route(basecamp.image!, (route) => route.fulfill({ contentType: "image/png", body: PIXEL }));
    const image = grace.page.waitForRequest(basecamp.image!);
    await paste(ada, "https://basecamp.com/");
    await expect(ada.composer().locator("action-text-attachment")).toHaveCount(1);
    await ada.composer().press("Enter");

    await expect(grace.message("Basecamp").locator(".message-content img")).toHaveAttribute("src", basecamp.image!);
    expect(await (await image).headerValue("referer")).toBeNull();
  });

  test("shows a preview's image under its text on a phone", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } });
    await previewWith(ada, basecamp);
    await paste(ada, "https://basecamp.com/");
    await expect(ada.composer().locator("action-text-attachment")).toHaveCount(1);
    await ada.page.getByRole("button", { name: "Send Message" }).click();

    const message = ada.message("Basecamp");
    const title = message.getByRole("link", { name: "Basecamp", exact: true });
    const image = message.locator(".message-content img");
    await expect(image).toBeVisible();
    expect((await box(image)).y).toBeGreaterThan((await box(title)).y + (await box(title)).height);
  });
});
