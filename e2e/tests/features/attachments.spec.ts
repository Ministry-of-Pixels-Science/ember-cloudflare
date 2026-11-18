import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { uploadPartPath, uploadsPath, type Message, type Upload } from "@ember/protocol";
import type { APIRequestContext, FileChooser, Locator, Page } from "@playwright/test";
import { allowClipboard, cookieHeader, downloadName, drawnPicture, variantType } from "../../fixtures";
import { expect, test, type Member } from "./fixtures";

/**
 * Uploads `content` as a file called `name` to `roomId` for `member`, in one part and without a preview,
 * as a bot's files come, and returns the message the room posts it as.
 */
async function upload(request: APIRequestContext, member: Member, roomId: string, name: string, content: string | Buffer, type = "text/plain"): Promise<Message> {
  const headers = { Cookie: cookieHeader(member.session) };
  const file = { name, type, size: typeof content === "string" ? new TextEncoder().encode(content).length : content.length, clientMessageId: crypto.randomUUID() };
  const started = await request.post(uploadsPath(roomId), { data: file, headers });
  expect(started.status(), await started.text()).toBe(201);
  const { id } = (await started.json()) as Upload;
  const finished = await request.put(uploadPartPath(roomId, id, 1), { data: content, headers });
  expect(finished.status(), await finished.text()).toBe(201);
  return (await finished.json()) as Message;
}

/** A second of video, 320 by 180, as a WebM file that Chromium plays. */
const clip = resolve(import.meta.dirname, "files/clip.webm");

/** The width and height of the box `locator` takes up. */
async function sizeOf(locator: Locator): Promise<[number, number]> {
  const box = await locator.boundingBox();
  return [box!.width, box!.height];
}

/**
 * Gives `page` a share sheet that keeps what it's given, as browsers that can share have one: the title
 * and text, and each file's name, type and size, as `shared()` reads them.
 */
async function canShare(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperties(Navigator.prototype, {
      canShare: { value: () => true, configurable: true },
      share: {
        value: async ({ title, text, files = [] }: ShareData) => {
          const sheet = window as unknown as { shared: unknown[] };
          sheet.shared = [...(sheet.shared ?? []), { title, text, files: files.map(({ name, type, size }) => ({ name, type, size })) }];
        },
        configurable: true,
      },
    });
  });
}

/** What `member`'s share sheet has been given so far. */
const shared = (member: Member) => member.page.evaluate(() => (window as unknown as { shared?: unknown[] }).shared ?? []);

/** The link on a file message's card that downloads its file. */
const downloadLink = (member: Member, name: string) => member.message(name).getByRole("link", { name: `Download ${name}` });

/** Picks `files` with Upload from your computer, in the composer's + menu, as the browser's file picker does. */
async function attachFiles(member: Member, files: Parameters<FileChooser["setFiles"]>[0]): Promise<void> {
  const chooser = member.page.waitForEvent("filechooser");
  await member.page.locator("form.composer").getByRole("button", { name: "Attach", exact: true }).click();
  await member.page.getByRole("menuitem", { name: /^Upload from your computer/ }).click();
  await (await chooser).setFiles(files);
}

/** The files waiting in `member`'s composer, by the chips that take them back out. */
const chips = (member: Member) => member.page.getByRole("button", { name: /^Remove / });

/** A text file called `name` that says `text`, as Playwright picks it. */
const textFile = (name: string, text: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });

/** Drops a text file called `name` that says `text` on `target`, as dragging one from the desktop does. */
const dropFile = (target: Locator, name: string, text: string) =>
  target.evaluate(
    (element, [name, text]) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([text], name, { type: "text/plain" }));
      for (const type of ["dragenter", "dragover", "drop"]) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    },
    [name, text] as const,
  );

/** Downloads the file of `member`'s file message `name`, answering what it says. */
async function downloaded(member: Member, name: string): Promise<string> {
  const [download] = await Promise.all([member.page.waitForEvent("download"), downloadLink(member, name).click()]);
  return readFile(await download.path(), "utf8");
}

test.describe("Attach files", () => {
  test("shows a file uploaded to a room as its uploader's message, to everyone in it at once and after a reload", async ({ members, request, rooms }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await upload(request, ada, rooms.general.id, "Q3 report.txt", "Up and to the right");

    for (const member of [ada, grace]) {
      await expect(member.message("Q3 report.txt")).toContainText("Ada");
      await expect(downloadLink(member, "Q3 report.txt")).toBeVisible();
    }
    await grace.page.reload();
    await grace.connected();
    await expect(downloadLink(grace, "Q3 report.txt")).toBeVisible();
  });

  test("sends the files picked with Attach files with the text written, each as a message of its own, in order of their names", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await attachFiles(ada, [textFile("b.txt", "Bee"), textFile("a.txt", "Ay")]);
    await expect(chips(ada)).toHaveCount(2);
    await expect(chips(ada).first()).toHaveAccessibleName("Remove a.txt");
    await expect(chips(ada).last()).toHaveAccessibleName("Remove b.txt");

    await ada.send("Two files");
    await expect(chips(ada)).toHaveCount(0);
    for (const member of [ada, grace]) {
      await expect(downloadLink(member, "b.txt")).toBeVisible();
      const messages = await member.page.getByRole("article").allInnerTexts();
      const at = (text: string) => messages.findIndex((message) => message.includes(text));
      expect(at("Two files")).toBeGreaterThanOrEqual(0);
      expect(at("a.txt")).toBeLessThan(at("b.txt"));
    }
    expect(await downloaded(grace, "a.txt")).toBe("Ay");
  });

  test("waits to send the files pasted into the composer or dropped on it or on the room's messages", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.connected();
    await ada.composer().evaluate((content) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File(["Pasted"], "pasted.txt", { type: "text/plain" }));
      content.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await dropFile(ada.composer(), "on the composer.txt", "Dropped on the composer");
    await dropFile(ada.timeline(), "on the messages.txt", "Dropped on the messages");
    await expect(chips(ada)).toHaveCount(3);
    // None of them goes in the text.
    await expect(ada.composer()).toHaveText("");
    await expect(ada.composer().locator("img, action-text-attachment, figure")).toHaveCount(0);

    await ada.page.getByRole("button", { name: "Send Message" }).click();
    expect(await downloaded(ada, "on the messages.txt")).toBe("Dropped on the messages");
    for (const name of ["pasted.txt", "on the composer.txt"]) await expect(downloadLink(ada, name)).toBeVisible();
  });
});

test.describe("Image, video and file previews", () => {
  test("shows a picture by the thumbnail its uploader's browser makes, to everyone, in a box half its size up to 480px wide", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await attachFiles(ada, await drawnPicture(ada.page, "mural.png", 2400, 1600));
    await ada.page.getByRole("button", { name: "Send Message" }).click();

    for (const member of [ada, grace]) {
      const link = member.page.getByRole("link", { name: "mural.png" });
      await expect(link).toHaveAttribute("href", /^\/files\/[0-9a-z]+\/[\w-]+\/mural\.png$/);
      const thumbnail = link.getByRole("img", { name: "mural.png" });
      await expect(thumbnail).toHaveAttribute("src", /^\/previews\/[0-9a-z]+\/[\w-]+\/mural\.png$/);
      // Scaled down to fit 1200×800, and shown at half that, 480px wide at most.
      await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([1200, 800]);
      expect(await sizeOf(link)).toEqual([480, 320]);
      await expect(member.page.getByRole("link", { name: "Download mural.png" })).toHaveCount(0);
    }
    const preview = await ada.page.request.get((await ada.page.getByRole("img", { name: "mural.png" }).getAttribute("src"))!);
    expect(preview.headers()["content-type"]).toBe(await variantType(ada.page));
  });

  test("plays a video in place, in a box half its size, behind the poster its uploader's browser makes, loading nothing until it's played", async ({ members, request }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await attachFiles(ada, clip);
    await ada.page.getByRole("button", { name: "Send Message" }).click();

    for (const member of [ada, grace]) {
      const video = member.page.getByRole("article").locator("video");
      await expect(video).toHaveAccessibleName("clip.webm");
      await expect(video).toHaveAttribute("src", /^\/files\/[0-9a-z]+\/[\w-]+\/clip\.webm$/);
      await expect(video).toHaveAttribute("poster", /^\/previews\/[0-9a-z]+\/[\w-]+\/clip\.webm$/);
      await expect(video).toHaveAttribute("preload", "none");
      expect(await sizeOf(video)).toEqual([160, 90]);
      // HAVE_NOTHING: none of it has loaded.
      expect(await video.evaluate((element: HTMLVideoElement) => element.readyState)).toBe(0);
    }
    const poster = await request.get((await ada.page.locator("video").getAttribute("poster"))!);
    expect(poster.headers()["content-type"]).toBe(await variantType(ada.page, { seeThrough: false }));
  });

  test("shows a picture without a thumbnail, as a bot's, as itself, and a file the browser couldn't make one of as its card", async ({ members, request, rooms }) => {
    const ada = await members.signIn("Ada");
    const { buffer } = await drawnPicture(ada.page, "dot.png", 40, 20);
    const { attachment } = await upload(request, ada, rooms.general.id, "dot.png", buffer, "image/png");
    const dot = ada.page.getByRole("img", { name: "dot.png" });
    await expect(dot).toHaveAttribute("src", attachment!.url);
    expect(await sizeOf(ada.page.getByRole("link", { name: "dot.png" }))).toEqual([20, 10]);

    // Chromium can't decode HEIC, so this one goes without.
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(12)]);
    await attachFiles(ada, { name: "photo.heic", mimeType: "image/heic", buffer: heic });
    await ada.page.getByRole("button", { name: "Send Message" }).click();
    await expect(downloadLink(ada, "photo.heic")).toBeVisible();
    await expect(ada.page.getByRole("img", { name: "photo.heic" })).toHaveCount(0);
  });
});

test.describe("Safe SVG previews", () => {
  test("shows an SVG above its card from a data URL, where its scripts don't run and what it links to doesn't load, and downloads it", async ({ members, request }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const requested: string[] = [];
    grace.page.on("request", (sent) => requested.push(new URL(sent.url()).pathname));
    const badge = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" onload="fetch('/svg/onload')">`,
      `<rect width="120" height="60" fill="#c33"/>`,
      `<image href="/svg/image.png" width="10" height="10"/>`,
      `<script>fetch("/svg/script")</script>`,
      `</svg>`,
    ].join("");
    await attachFiles(ada, { name: "badge.svg", mimeType: "image/svg+xml", buffer: Buffer.from(badge) });
    await ada.page.getByRole("button", { name: "Send Message" }).click();

    for (const member of [ada, grace]) {
      const image = member.message("badge.svg").getByRole("img", { name: "badge.svg" });
      await expect(image).toHaveAttribute("src", `data:image/svg+xml;base64,${Buffer.from(badge).toString("base64")}`);
      expect(await image.evaluate((element: HTMLImageElement) => [element.naturalWidth, element.naturalHeight])).toEqual([120, 60]);
      await expect(downloadLink(member, "badge.svg")).toBeVisible();
    }
    expect(requested.filter((path) => path.startsWith("/svg/"))).toEqual([]);

    // Shown, it's still a download, which no browser runs as a page.
    const shown = await request.get((await downloadLink(grace, "badge.svg").getAttribute("href"))!.replace(/\?.*/, ""));
    expect(shown.headers()["content-type"]).toBe("application/octet-stream");
    expect(shown.headers()["content-disposition"]).toMatch(/^attachment; /);
  });
});

test.describe("Text files' text", () => {
  test("shows a snippet's text above its card, to everyone, highlighted where its name says it's code, and copies it as written", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.page.locator("form.composer").getByRole("button", { name: "Attach", exact: true }).click();
    await ada.page.getByRole("menuitem", { name: /^Text snippet/ }).click();
    const dialog = ada.page.getByRole("dialog", { name: "Create a text snippet" });
    await dialog.getByLabel("Title (optional)").fill("deploy.sh");
    await dialog.getByLabel("Content").fill("#!/bin/sh\necho deployed");
    await dialog.getByRole("button", { name: "Create snippet" }).click();
    await ada.page.getByRole("button", { name: "Send Message" }).click();

    for (const member of [ada, grace]) {
      const text = member.message("deploy.sh").locator("pre");
      await expect(text.locator(".hljs-built_in")).toHaveText("echo");
      expect(await text.textContent()).toBe("#!/bin/sh\necho deployed");
      const [shown, card] = [await text.boundingBox(), await downloadLink(member, "deploy.sh").boundingBox()];
      expect(shown!.y + shown!.height).toBeLessThanOrEqual(card!.y);
    }

    await allowClipboard(grace.page.context());
    const block = grace.message("deploy.sh").locator(".code-block");
    await block.hover();
    await block.getByRole("button", { name: "Copy code" }).click();
    await expect.poll(() => grace.page.evaluate(() => navigator.clipboard.readText())).toBe("#!/bin/sh\necho deployed");
  });

  test("folds a text file's text past five lines behind Show more, and shows a bigger one's card alone", async ({ members, request, rooms }) => {
    const ada = await members.signIn("Ada");
    await upload(request, ada, rooms.general.id, "server.log", "x".repeat(64 * 1024 + 1));
    await upload(request, ada, rooms.general.id, "notes.txt", Array.from({ length: 12 }, (_, line) => `Line ${line + 1}`).join("\n"));
    const notes = ada.message("notes.txt");
    const text = notes.locator("pre");
    await expect(text).toContainText("Line 12");
    // How many of its lines show, within its padding.
    const linesShown = () =>
      text.evaluate((pre) => {
        const style = getComputedStyle(pre);
        return Math.round((pre.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight));
      });
    expect(await linesShown()).toBe(5);
    // Show more has a line of its own, under the text and over the card.
    const showMore = notes.getByRole("button", { name: "Show more" });
    const [shown, button, card] = [await text.boundingBox(), await showMore.boundingBox(), await downloadLink(ada, "notes.txt").boundingBox()];
    expect(shown!.y + shown!.height).toBeLessThanOrEqual(button!.y);
    expect(button!.y + button!.height).toBeLessThanOrEqual(card!.y);
    await showMore.click();
    expect(await linesShown()).toBe(12);
    await notes.getByRole("button", { name: "Show less" }).click();
    expect(await linesShown()).toBe(5);

    // Scrolled to its end while open, a file too long to show whole folds back to its first lines.
    await upload(request, ada, rooms.general.id, "long.txt", Array.from({ length: 100 }, (_, line) => `Row ${line + 1}`).join("\n"));
    const long = ada.message("long.txt");
    const longText = long.locator("pre");
    await expect(longText).toContainText("Row 100");
    await long.getByRole("button", { name: "Show more" }).click();
    const scrolled = await longText.evaluate((pre) => {
      pre.scrollTop = pre.scrollHeight;
      return pre.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);
    await long.getByRole("button", { name: "Show less" }).click();
    expect(await longText.evaluate((pre) => pre.scrollTop)).toBe(0);

    await expect(downloadLink(ada, "server.log")).toBeVisible();
    await expect(ada.message("server.log").locator("pre")).toHaveCount(0);
  });

  test("keeps the timeline at its end as a long snippet sent there shows its text", async ({ members, participant }) => {
    // Enough before it that the timeline scrolls.
    await (await participant("Grace")).sayAll(Array.from({ length: 20 }, (_, n) => `Earlier ${n + 1}`));
    const ada = await members.signIn("Ada");
    await expect(ada.message("Earlier 20")).toBeVisible();
    await ada.page.locator("form.composer").getByRole("button", { name: "Attach", exact: true }).click();
    await ada.page.getByRole("menuitem", { name: /^Text snippet/ }).click();
    const dialog = ada.page.getByRole("dialog", { name: "Create a text snippet" });
    await dialog.getByLabel("Title (optional)").fill("steps.sh");
    await dialog.getByLabel("Content").fill(Array.from({ length: 12 }, (_, line) => `echo "step ${line + 1}"`).join("\n"));
    await dialog.getByRole("button", { name: "Create snippet" }).click();
    await ada.page.getByRole("button", { name: "Send Message" }).click();

    await expect(ada.message("steps.sh").getByRole("button", { name: "Show more" })).toBeVisible();
    await expect.poll(() => ada.outOfView(downloadLink(ada, "steps.sh"))).toBe(0);
  });

  test("shows an HTML file's markup as its text, where nothing in it runs or loads", async ({ members, request, rooms }) => {
    const ada = await members.signIn("Ada");
    const requested: string[] = [];
    ada.page.on("request", (sent) => requested.push(new URL(sent.url()).pathname));
    const markup = `<img src="/text/image.png" onerror="fetch('/text/onerror')"><script>fetch("/text/script")</script>`;
    await upload(request, ada, rooms.general.id, "page.html", markup, "text/html");
    const text = ada.message("page.html").locator("pre");
    await expect(text.locator(".hljs-tag").first()).toBeVisible();
    expect(await text.textContent()).toBe(markup);
    await expect(text.locator("img, script")).toHaveCount(0);
    expect(requested.filter((path) => path.startsWith("/text/"))).toEqual([]);
  });
});

test.describe("Upload progress", () => {
  test("shows each upload's card until the room posts its file, and why one failed", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const parts = "**/uploads/*/parts/*";
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await ada.page.route(parts, async (route) => {
      await held;
      await route.continue();
    });
    await attachFiles(ada, textFile("slow.txt", "Slow"));
    await ada.page.getByRole("button", { name: "Send Message" }).click();
    const card = ada.page.getByRole("group", { name: "Upload slow.txt" });
    await expect(card).toContainText("slow.txt1 KB");
    await expect(card.getByRole("progressbar", { name: "Upload progress for slow.txt" })).toBeVisible();
    await expect(grace.message("slow.txt")).toHaveCount(0);

    release();
    await expect(card).toHaveCount(0);
    for (const member of [ada, grace]) await expect(downloadLink(member, "slow.txt")).toBeVisible();

    // A part the Worker won't take fails its upload, whose card stays saying why.
    await ada.page.unroute(parts);
    await ada.page.route(parts, (route) => route.fulfill({ status: 500 }));
    await attachFiles(ada, textFile("broken.txt", "Broken"));
    await ada.page.getByRole("button", { name: "Send Message" }).click();
    const failed = ada.page.getByRole("group", { name: "Upload broken.txt" });
    await expect(failed.getByRole("alert")).toHaveText("Upload failed. Please attach the file and try again.");
    await expect(failed.getByRole("status")).toHaveText("Upload failed");
    await expect(grace.message("broken.txt")).toHaveCount(0);
  });
});

test.describe("Download and share files", () => {
  test("downloads a file message's file from its card, and offers Download on its action bar in place of Quote", async ({ members, request, rooms }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const { attachment } = await upload(request, ada, rooms.general.id, "Q3 report.txt", "Up and to the right");

    const [download] = await Promise.all([grace.page.waitForEvent("download"), downloadLink(grace, "Q3 report.txt").click()]);
    expect(downloadName(download)).toBe("Q3 report.txt");
    expect(await readFile(await download.path(), "utf8")).toBe("Up and to the right");

    const bar = await grace.actions("Q3 report.txt");
    await expect(bar.getByRole("link", { name: "Download" })).toHaveAttribute("href", attachment!.downloadUrl);
    await expect(bar.getByRole("button", { name: "Quote" })).toHaveCount(0);
    // Quoting a file would quote nothing, so More actions has no Quote either.
    await grace.message("Q3 report.txt").getByRole("button", { name: "Message options" }).click();
    await expect(grace.message("Q3 report.txt").getByRole("group", { name: "More actions" }).getByRole("button")).toHaveText(["Copy link", `Block ${ada.name}`, "Report message"]);
    // Share shows only where the browser can share, which Chromium on Linux can't, and WebKit on a Mac can.
    const shares = (await grace.page.evaluate(() => "canShare" in navigator)) ? 1 : 0;
    await expect(bar.getByRole("button", { name: "Share" })).toHaveCount(shares);
    await expect(grace.message("Q3 report.txt").getByRole("button", { name: "Share Q3 report.txt" })).toHaveCount(shares);
  });

  test("shares a file from its card and its image viewer untitled, and from its message's actions titled with its name", async ({ members, request, rooms }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace", { beforeOpen: canShare });
    await upload(request, ada, rooms.general.id, "Q3 report.txt", "Up and to the right");
    const { buffer } = await drawnPicture(ada.page, "dot.png", 40, 20);
    await upload(request, ada, rooms.general.id, "dot.png", buffer, "image/png");
    const report = { type: "text/plain", size: "Up and to the right".length };

    // Each fetches its file before it shares, so each waits for the last to land.
    await grace.message("Q3 report.txt").getByRole("button", { name: "Share Q3 report.txt" }).click();
    await expect.poll(async () => (await shared(grace)).length).toBe(1);
    await (await grace.actions("Q3 report.txt")).getByRole("button", { name: "Share" }).click();
    await expect.poll(async () => (await shared(grace)).length).toBe(2);
    await grace.page.getByRole("link", { name: "dot.png" }).click();
    await grace.page.getByRole("dialog", { name: "Image Viewer (Press escape to close)" }).getByRole("button", { name: "Share file" }).click();
    await expect.poll(() => shared(grace)).toEqual([
      { title: "", text: "", files: [{ name: expect.stringMatching(/^Ember_[a-z0-9]+\.plain$/), ...report }] },
      { title: "Q3 report.txt", text: "", files: [{ name: expect.stringMatching(/^Ember_[a-z0-9]+\.plain$/), ...report }] },
      { title: "", text: "", files: [{ name: expect.stringMatching(/^Ember_[a-z0-9]+\.png$/), type: "image/png", size: buffer.length }] },
    ]);
  });
});

test.describe("Image viewer", () => {
  test("opens a picture's original in the image viewer, which downloads it, and closes it with Escape", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await attachFiles(ada, await drawnPicture(ada.page, "mural.png", 2400, 1600));
    await ada.page.getByRole("button", { name: "Send Message" }).click();

    const link = grace.page.getByRole("link", { name: "mural.png" });
    await link.click();
    const viewer = grace.page.getByRole("dialog", { name: "Image Viewer (Press escape to close)" });
    const original = viewer.getByRole("img", { name: "mural.png" });
    await expect(original).toHaveAttribute("src", (await link.getAttribute("href"))!);
    await expect.poll(() => original.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([2400, 1600]);
    await expect(viewer.getByRole("button", { name: "Close image viewer" })).toBeFocused();

    const [download] = await Promise.all([grace.page.waitForEvent("download"), viewer.getByRole("link", { name: "Download file" }).click()]);
    expect(downloadName(download)).toBe("mural.png");
    expect((await readFile(await download.path())).length).toBe((await drawnPicture(ada.page, "mural.png", 2400, 1600)).buffer.length);
    await expect(viewer).toBeVisible();

    await grace.page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(link).toBeFocused();
  });
});

test.describe("Delete a message", () => {
  test("deletes a file message from its editor, which shows its file where a message's text would be", async ({ members, request, rooms }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await upload(request, ada, rooms.general.id, "Draft.txt", "Not yet");
    await expect(grace.message("Draft.txt")).toBeVisible();

    await (await ada.actions("Draft.txt")).getByRole("button", { name: "Edit" }).click();
    await expect(ada.page.getByRole("button", { name: "Delete message" })).toBeFocused();
    await expect(ada.editor()).toHaveCount(0);
    await expect(downloadLink(ada, "Draft.txt")).toBeVisible();

    ada.page.once("dialog", (dialog) => void dialog.accept());
    await ada.page.getByRole("button", { name: "Delete message" }).click();
    await expect(grace.message("Draft.txt")).toHaveCount(0);
    await expect(ada.message("Draft.txt")).toHaveCount(0);
  });
});
