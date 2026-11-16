import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { devices, type APIResponse, type Locator, type Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { ADMINISTRATOR, drawnPicture, editorField, nextSecond, shownPicture, signInAsAdministrator, useOwnAddress } from "../../fixtures";
import { auditScreen } from "../mobile/audits";
import { join } from "./fixtures";

/** A command that posts to a room as a bot: its room's address on this server, then the bot's key. */
const COMMAND = /^curl -d 'Hello!' https:\/\/127\.0\.0\.1:\d+\/rooms\/[^/]+\/[^/]+-[A-Za-z0-9]{12}\/messages$/;

/** A bot's entry on the bots page. */
const botNamed = (page: Page, name: string) => page.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });

/** Where `locator` is drawn. */
async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("Not visible");
  return rect;
}

/** Signs the administrator in on the bots page, from workspace settings' Chat bots. */
async function openBots(page: Page) {
  await useOwnAddress(page);
  await page.goto("/account/edit");
  await signInAsAdministrator(page);
  await page.getByRole("link", { name: "Chat bots" }).click();
  await expect(page).toHaveURL(/\/account\/bots$/);
  await expect(page.getByRole("heading", { level: 1, name: "Chat bots" })).toBeVisible();
}

/** Adds a bot named `name`, from the bots page, back to which it goes. A server kept from an earlier run may have bots already. */
async function addBot(page: Page, name: string, webhookUrl = "") {
  await page.getByRole("link", { name: "Add a chat bot" }).click();
  await expect(page).toHaveURL(/\/account\/bots\/new$/);
  await page.getByRole("textbox", { name: "Bot name" }).fill(name);
  await page.getByRole("textbox", { name: "Webhook URL", exact: true }).fill(webhookUrl);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/\/account\/bots$/);
}

/** Adds a bot named `name`, delivering to `webhookUrl` if it's given, and opens general, answering the address the bot's command posts there to. */
async function openGeneralFor(page: Page, name: string, webhookUrl?: string): Promise<string> {
  await openBots(page);
  await addBot(page, name, webhookUrl);
  const command = botNamed(page, name).getByRole("group", { name: "general", exact: true }).getByRole("textbox", { name: "curl command for posting messages" });
  const url = (await command.inputValue()).split(" ").at(-1)!;
  // The room the command posts to, open in the administrator's browser.
  await page.goto(new URL(url).pathname.replace(/\/[^/]+\/messages$/, ""));
  await expect(page.getByRole("textbox", { name: "Write a message" })).toBeVisible();
  return url;
}

/** A request a webhook got. */
interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * Listens on this machine as a bot's webhook, answering each request with `answer`, by default an empty
 * 204, as a bot with nothing to say does.
 */
async function listenAsWebhook(answer = (response: ServerResponse) => response.writeHead(204).end()): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      received.push({ method: request.method!, path: request.url!, headers: request.headers, body });
      answer(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/hooks/build?team=ops`, received, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** Writes `text` in the room's composer, then mentions the bot `name` by `tag`, its name's own part, and sends it. */
async function mentionBot(page: Page, text: string, name: string, tag: string) {
  const composer = editorField(page, "Write a message");
  await composer.pressSequentially(text);
  await composer.pressSequentially("@");
  await expect(page.getByRole("listbox")).toBeVisible();
  // Waits for the people listed for the whole tag, as an answer for less of it may come later.
  const listed = page.waitForResponse((response) => new URL(response.url()).searchParams.get("filter") === tag);
  await composer.pressSequentially(tag);
  await listed;
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText([name]);
  await composer.press("Tab");
  await composer.press("Enter");
}

/** As `curl -d` sends a body. */
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

/** The address of the message a bot's post made, under the room's address for the bot, `url`. */
const messageUrl = (url: string, posted: APIResponse) => `${url}/${posted.headers()["location"]!.split("/@")[1]}`;

test.describe("Add and edit a bot", () => {
  test("the administrator adds a bot, which gets commands for posting to every open room, and renames it", async ({ page }) => {
    await openBots(page);
    const name = `Build Bot ${crypto.randomUUID().slice(0, 8)}`;
    await addBot(page, name, "https://ci.example.com/hook");

    // A new bot joins every open room, as someone new does, first run's general among them.
    const general = botNamed(page, name).getByRole("group", { name: "general", exact: true });
    await expect(general.getByRole("textbox", { name: "curl command for posting messages" })).toHaveValue(COMMAND);
    await expect(general.getByRole("textbox", { name: "curl command for posting attachments" })).toHaveValue(/^curl -F "attachment=@\/path\/to\/file" https:/);
    const command = await general.getByRole("textbox", { name: "curl command for posting messages" }).inputValue();

    await botNamed(page, name).getByRole("link", { name: `Edit ${name}` }).click();
    await expect(page).toHaveURL(/\/account\/bots\/[^/]+\/edit$/);
    await expect(page.getByRole("textbox", { name: "Bot name" })).toHaveValue(name);
    await expect(page.getByRole("textbox", { name: "Webhook URL", exact: true })).toHaveValue("https://ci.example.com/hook");
    // Its settings give the same commands, a room at a time.
    const incoming = page.getByRole("region", { name: "Incoming" });
    await incoming.getByRole("combobox", { name: "Room" }).selectOption({ label: "general" });
    await expect(incoming.getByRole("group", { name: "general", exact: true }).getByRole("textbox", { name: "curl command for posting messages" })).toHaveValue(command);
    const renamed = `Deploy Bot ${crypto.randomUUID().slice(0, 8)}`;
    await page.getByRole("textbox", { name: "Bot name" }).fill(renamed);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/account\/bots$/);
    await expect(botNamed(page, renamed)).toBeVisible();
    await expect(botNamed(page, name)).toHaveCount(0);
  });

  test("the administrator gives a bot an avatar from its form, shown on the bots page as the variant the browser made, and a new one", async ({ page }) => {
    await openBots(page);
    const name = `Build Bot ${crypto.randomUUID().slice(0, 8)}`;
    await page.getByRole("link", { name: "Add a chat bot" }).click();
    const preview = page.getByRole("img", { name: "Bot avatar" });
    // Campfire's default bot picture, until one is chosen.
    await expect(preview).toHaveAttribute("src", /svg/);
    await page.getByRole("textbox", { name: "Bot name" }).fill(name);
    await page.getByLabel("Upload bot avatar").setInputFiles(await drawnPicture(page, "robot.png", 1200, 800));
    await expect(preview).toHaveAttribute("src", /^blob:/);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/account\/bots$/);

    const avatar = botNamed(page, name).getByRole("link", { name, exact: true }).locator("img");
    await expect(avatar).toHaveAttribute("src", /^\/users\/[^/]+\/avatar\?v=\d{14}$/);
    expect(await shownPicture(avatar)).toEqual({ type: "image/webp", width: 512, height: 341 });
    const first = (await avatar.getAttribute("src"))!;

    await botNamed(page, name).getByRole("link", { name: `Edit ${name}` }).click();
    await expect(preview).toHaveAttribute("src", first);
    // An avatar's address changes with the second it was given.
    await nextSecond();
    await page.getByLabel("Upload bot avatar").setInputFiles(await drawnPicture(page, "robot.png", 300, 600));
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/account\/bots$/);
    await expect(avatar).not.toHaveAttribute("src", first);
    expect(await shownPicture(avatar)).toEqual({ type: "image/webp", width: 256, height: 512 });
  });
});

test.describe("Generate a new bot key", () => {
  test("the administrator gives a bot a new key after asking, which its commands then carry", async ({ page }) => {
    await openBots(page);
    const name = `Build Bot ${crypto.randomUUID().slice(0, 8)}`;
    await addBot(page, name);
    const command = botNamed(page, name).getByRole("group", { name: "general", exact: true }).getByRole("textbox", { name: "curl command for posting messages" });
    const before = await command.inputValue();

    await botNamed(page, name).getByRole("link", { name: `Edit ${name}` }).click();
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toBe("Are you sure you want to change the bot key? All usage of this bot must be updated.");
      void dialog.accept();
    });
    await page.getByRole("button", { name: "Generate a new key" }).click();
    await expect(page).toHaveURL(/\/account\/bots$/);
    await expect(command).toHaveValue(COMMAND);
    expect(await command.inputValue()).not.toBe(before);
  });
});

test.describe("Delete a bot", () => {
  test("the administrator deletes a bot after asking, which leaves the bots page, and its settings answer 404", async ({ page }) => {
    await openBots(page);
    const name = `Build Bot ${crypto.randomUUID().slice(0, 8)}`;
    await addBot(page, name);
    await botNamed(page, name).getByRole("link", { name: `Edit ${name}` }).click();
    await expect(page).toHaveURL(/\/account\/bots\/[^/]+\/edit$/);
    const settings = new URL(page.url()).pathname;

    page.once("dialog", (dialog) => {
      expect(dialog.message()).toBe("Are you sure you want to permanently remove this bot from the account? This can’t be undone.");
      void dialog.accept();
    });
    await page.getByRole("button", { name: "Delete this chat bot" }).click();
    await expect(page).toHaveURL(/\/account\/bots$/);
    await expect(page.getByRole("heading", { level: 1, name: "Chat bots" })).toBeVisible();
    await expect(botNamed(page, name)).toHaveCount(0);

    expect((await page.goto(settings))?.status()).toBe(404);
  });
});

test.describe("Bots post messages", () => {
  test("a bot's command posts to its room as the bot, which shows there at once by its round avatar, and the bot reads it back", async ({ page }) => {
    const name = `Build Bot ${crypto.randomUUID().slice(0, 8)}`;
    const url = await openGeneralFor(page, name);
    const text = `Deploy finished ${crypto.randomUUID().slice(0, 8)}`;
    const posted = await page.request.post(url, { data: text, headers: FORM });
    expect(posted.status()).toBe(201);
    const message = page.getByRole("article").filter({ hasText: text });
    await expect(message).toBeVisible();
    await expect(message).toContainText(name);
    // A circle, where a person's avatar in a message is a square with rounded corners.
    const avatar = message.locator("[aria-hidden=true]").first();
    await expect.poll(() => avatar.evaluate((image: HTMLElement) => parseFloat(getComputedStyle(image).borderRadius) >= image.offsetWidth / 2)).toBe(true);

    const read = await page.request.get(url);
    expect(read.status()).toBe(200);
    expect(((await read.json()) as Array<{ body: { plain_text: string }; creator: { name: string } }>).at(-1)).toMatchObject({ body: { plain_text: text }, creator: { name } });
  });

  test("a bot posts a picture as `curl -F` sends one, which shows in the room at once as itself", async ({ page }) => {
    const name = `Build Bot ${crypto.randomUUID().slice(0, 8)}`;
    const url = await openGeneralFor(page, name);
    const chart = await drawnPicture(page, `chart-${crypto.randomUUID().slice(0, 8)}.png`, 40, 20);
    expect((await page.request.post(url, { multipart: { attachment: chart } })).status()).toBe(201);

    const picture = page.getByRole("img", { name: chart.name });
    await expect(page.getByRole("article").filter({ has: picture })).toContainText(name);
    expect(await shownPicture(picture)).toEqual({ type: "image/png", width: 40, height: 20 });
  });
});

test.describe("Slack-compatible webhooks", () => {
  test("what a tool sends a bot's Slack-compatible webhook shows in its room at once, formatted, as the bot", async ({ page }) => {
    await openBots(page);
    const name = `Build Bot ${crypto.randomUUID().slice(0, 8)}`;
    await addBot(page, name);
    const webhook = botNamed(page, name).getByRole("group", { name: "general", exact: true }).getByRole("textbox", { name: "Slack-compatible webhook URL" });
    await expect(webhook).toHaveValue(/^https:\/\/127\.0\.0\.1:\d+\/rooms\/[^/]+\/[^/]+-[A-Za-z0-9]{12}\/slack$/);
    const url = await webhook.inputValue();
    await page.goto(new URL(url).pathname.replace(/\/[^/]+\/slack$/, ""));
    await expect(page.getByRole("textbox", { name: "Write a message" })).toBeVisible();

    const build = crypto.randomUUID().slice(0, 8);
    const posted = await page.request.post(url, { data: { text: `Deploy *finished* :tada: <https://ci.example.com/builds/${build}|Build ${build}>`, username: "Impostor" } });
    expect([posted.status(), await posted.text()]).toEqual([200, "ok"]);
    const message = page.getByRole("article").filter({ hasText: `Build ${build}` });
    await expect(message).toContainText(name);
    const content = message.locator(".message-content");
    await expect(content).toHaveText(`Deploy finished 🎉 Build ${build}`);
    await expect(content.locator("strong")).toHaveText("finished");
    await expect(content.getByRole("link", { name: `Build ${build}` })).toHaveAttribute("href", `https://ci.example.com/builds/${build}`);
  });
});

test.describe("Bot cards", () => {
  test("an attachment sent to a bot's Slack-compatible webhook shows as a card under its text, on a computer and a phone, in light and dark", async ({ page, browser, baseURL }) => {
    await openBots(page);
    // A room of its own, so the phone's screen holds no other test's messages, which the audit would check too. It's
    // made as the app's own page would make it, since over HTTPS a write that doesn't say so is refused as cross-site.
    const roomName = `Alerts ${crypto.randomUUID().slice(0, 8)}`;
    const created = await page.request.post("/api/rooms", { headers: { "Sec-Fetch-Site": "same-origin" }, data: { kind: "open", name: roomName } });
    expect(created.status(), await created.text()).toBe(201);
    const name = `Alert Bot ${crypto.randomUUID().slice(0, 8)}`;
    await addBot(page, name);
    const webhook = botNamed(page, name).getByRole("group", { name: roomName, exact: true }).getByRole("textbox", { name: "Slack-compatible webhook URL" });
    const url = await webhook.inputValue();
    const room = new URL(url).pathname.replace(/\/[^/]+\/slack$/, "");
    await page.goto(room);
    await expect(page.getByRole("textbox", { name: "Write a message" })).toBeVisible();

    // As Prometheus Alertmanager sends an alert, with fields, a runbook and a footer.
    const alert = crypto.randomUUID().slice(0, 8);
    const title = `[FIRING:1] HighErrorRate ${alert}`;
    const at = 1792612211;
    const posted = await page.request.post(url, {
      data: {
        text: `Alert ${alert}`,
        attachments: [
          {
            color: "danger",
            title,
            title_link: "https://alertmanager.example.com/#/alerts",
            text: "5xx responses on api-gateway are at *7.2%*, above the 5% threshold.",
            mrkdwn_in: ["text"],
            fields: [
              { title: "Severity", value: "critical", short: true },
              { title: "Service", value: "api-gateway", short: true },
            ],
            actions: [{ type: "button", text: "Runbook", url: "https://runbooks.example.com/high-error-rate", style: "danger" }],
            footer: "Prometheus",
            ts: at,
          },
        ],
      },
    });
    expect([posted.status(), await posted.text()]).toEqual([200, "ok"]);

    const card = page.getByRole("article", { name: title });
    const message = page.getByRole("article").filter({ has: card });
    await expect(message).toContainText(name);
    await expect(message.locator("[data-body-content] > .message-content")).toHaveText(`Alert ${alert}`);
    await expect(card.getByRole("link", { name: title })).toHaveAttribute("href", "https://alertmanager.example.com/#/alerts");
    await expect(card.locator("strong")).toHaveText("7.2%");
    await expect(card.getByText("Severity")).toBeVisible();
    await expect(card.getByRole("link", { name: "Runbook" })).toHaveAttribute("target", "_blank");
    await expect(card.locator("time")).toHaveAttribute("datetime", new Date(at * 1000).toISOString());

    // The bar is the negative red, which dark mode lightens.
    const bar = card.locator(":scope > span[aria-hidden]");
    await expect(bar).toHaveClass(/\bbg-negative\b/);
    const red = await bar.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => bar.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(red);

    // On a phone, the card fits the screen and its button is a finger's size.
    const phone = await browser.newContext({ ...devices["Galaxy S24"], baseURL, ignoreHTTPSErrors: true });
    try {
      const onPhone = await phone.newPage();
      await useOwnAddress(onPhone);
      await onPhone.goto(room);
      await signInAsAdministrator(onPhone);
      const cardOnPhone = onPhone.getByRole("article", { name: title });
      await cardOnPhone.scrollIntoViewIfNeeded();
      await expect(cardOnPhone.getByRole("link", { name: "Runbook" })).toBeVisible();
      const results = await auditScreen(onPhone, { top: 0, right: 0, bottom: 0, left: 0 });
      expect(results.overflow, "Nothing is cut off or pushed off the side of the screen").toEqual([]);
      expect(results.touchTargets, "Every control is easy to tap").toEqual([]);
    } finally {
      await phone.close();
    }
  });

  test("blocks sent to a bot's Slack-compatible webhook show as a card in place of its text, with a table and small cards, on a computer and a phone, in light and dark", async ({ page, browser, baseURL }) => {
    await openBots(page);
    // A room of its own, as the attachment's test has, for the phone's audit.
    const roomName = `Deploys ${crypto.randomUUID().slice(0, 8)}`;
    const created = await page.request.post("/api/rooms", { headers: { "Sec-Fetch-Site": "same-origin" }, data: { kind: "open", name: roomName } });
    expect(created.status(), await created.text()).toBe(201);
    const name = `Deploy Bot ${crypto.randomUUID().slice(0, 8)}`;
    await addBot(page, name);
    const webhook = botNamed(page, name).getByRole("group", { name: roomName, exact: true }).getByRole("textbox", { name: "Slack-compatible webhook URL" });
    const url = await webhook.inputValue();
    const room = new URL(url).pathname.replace(/\/[^/]+\/slack$/, "");
    await page.goto(room);
    await expect(page.getByRole("textbox", { name: "Write a message" })).toBeVisible();

    const header = `Deployed web ${crypto.randomUUID().slice(0, 8)}`;
    const posted = await page.request.post(url, {
      data: {
        text: `${header}, which only notifications show beside blocks`,
        blocks: [
          { type: "header", text: { type: "plain_text", text: header } },
          {
            type: "section",
            text: { type: "mrkdwn", text: "*3 services* are live in *production*." },
            accessory: { type: "button", text: { type: "plain_text", text: "Release notes" }, url: "https://example.com/releases", style: "primary" },
          },
          {
            type: "table",
            column_settings: [{ is_wrapped: true }, { align: "right" }],
            rows: [
              [
                { type: "raw_text", text: "Service" },
                { type: "raw_text", text: "Errors" },
              ],
              [
                { type: "raw_text", text: "api" },
                { type: "raw_number", value: 0 },
              ],
              [
                { type: "raw_text", text: "workers" },
                { type: "raw_number", value: 2 },
              ],
            ],
          },
          { type: "context", elements: [{ type: "mrkdwn", text: "Started by *Ada Lovelace*" }] },
          {
            type: "carousel",
            elements: [
              {
                type: "card",
                title: { type: "plain_text", text: "api" },
                body: { type: "mrkdwn", text: "Took *1m 12s*" },
                actions: [{ type: "button", text: { type: "plain_text", text: "Logs" }, url: "https://example.com/logs/api" }],
              },
              {
                type: "card",
                title: { type: "plain_text", text: "workers" },
                body: { type: "mrkdwn", text: "Took *2m 3s*, with 2 errors" },
                actions: [
                  { type: "button", text: { type: "plain_text", text: "Logs" }, url: "https://example.com/logs/workers" },
                  { type: "button", text: { type: "plain_text", text: "Roll back" }, url: "https://example.com/rollback/workers", style: "danger" },
                ],
              },
            ],
          },
        ],
      },
    });
    expect([posted.status(), await posted.text()]).toEqual([200, "ok"]);

    const card = page.getByRole("article", { name: header });
    const message = page.getByRole("article").filter({ has: card });
    await expect(message).toContainText(name);
    await expect(message).not.toContainText("only notifications show");
    await expect(card.locator(":scope > span[aria-hidden]")).toHaveCount(0);
    await expect(card.getByRole("link", { name: "Release notes" })).toHaveAttribute("href", "https://example.com/releases");
    const cells = card.getByRole("region", { name: "Table" }).getByRole("cell");
    await expect(cells).toHaveText(["Service", "Errors", "api", "0", "workers", "2"]);
    await expect(cells.nth(1)).toHaveCSS("text-align", "end");
    const tiles = card.getByRole("region", { name: "Cards" }).getByRole("listitem");
    await expect(tiles).toHaveCount(2);
    await expect(tiles.nth(1).getByRole("link")).toHaveText(["Roll back", "Logs"]);

    // The frame is the page's background, which dark mode darkens.
    const background = await card.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => card.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(background);

    // On a phone, the card fits the screen, its table and small cards scroll sideways within it, and its buttons are a finger's size.
    const phone = await browser.newContext({ ...devices["Galaxy S24"], baseURL, ignoreHTTPSErrors: true });
    try {
      const onPhone = await phone.newPage();
      await useOwnAddress(onPhone);
      await onPhone.goto(room);
      await signInAsAdministrator(onPhone);
      const cardOnPhone = onPhone.getByRole("article", { name: header });
      await cardOnPhone.getByRole("region", { name: "Cards" }).scrollIntoViewIfNeeded();
      await expect(cardOnPhone.getByRole("link", { name: "Logs" }).first()).toBeVisible();
      const results = await auditScreen(onPhone, { top: 0, right: 0, bottom: 0, left: 0 });
      expect(results.overflow, "Nothing is cut off or pushed off the side of the screen").toEqual([]);
      expect(results.touchTargets, "Every control is easy to tap").toEqual([]);
    } finally {
      await phone.close();
    }
  });
});

test.describe("Bots edit and delete their messages", () => {
  test("a bot edits its message, then deletes it, which the room shows at once", async ({ page }) => {
    const url = await openGeneralFor(page, `Build Bot ${crypto.randomUUID().slice(0, 8)}`);
    const tag = crypto.randomUUID().slice(0, 8);
    const message = messageUrl(url, await page.request.post(url, { data: `Deploying ${tag}`, headers: FORM }));
    await expect(page.getByRole("article").filter({ hasText: `Deploying ${tag}` })).toBeVisible();

    expect((await page.request.patch(message, { data: `Deployed ${tag}`, headers: FORM })).status()).toBe(200);
    const edited = page.getByRole("article").filter({ hasText: `Deployed ${tag}` });
    await expect(edited).toContainText("(edited)");
    await expect(page.getByRole("article").filter({ hasText: `Deploying ${tag}` })).toHaveCount(0);

    expect((await page.request.delete(message)).status()).toBe(204);
    await expect(edited).toHaveCount(0);
  });

  test("a bot gives its message a file, shown in place of its text, then takes the file away, which the room shows at once", async ({ page }) => {
    const url = await openGeneralFor(page, `Build Bot ${crypto.randomUUID().slice(0, 8)}`);
    const tag = crypto.randomUUID().slice(0, 8);
    const message = messageUrl(url, await page.request.post(url, { data: `Build log ${tag}`, headers: FORM }));
    const text = page.getByRole("article").filter({ hasText: `Build log ${tag}` });
    await expect(text).toBeVisible();

    const log = { name: `build-${tag}.log`, mimeType: "text/plain", buffer: Buffer.from("All green\n") };
    expect((await page.request.put(message, { multipart: { attachment: log } })).status()).toBe(200);
    const file = page.getByRole("article").filter({ hasText: log.name });
    await expect(file.getByRole("link", { name: `Download ${log.name}` })).toBeVisible();
    await expect(file).toContainText("(edited)");
    await expect(text).toHaveCount(0);

    expect((await page.request.put(message, { multipart: { attachment: "" } })).status()).toBe(200);
    await expect(text).toContainText("(edited)");
    await expect(file).toHaveCount(0);
  });
});

test.describe("Bots boost messages", () => {
  test("a bot boosts a message, then takes its boost back, which the room shows at once", async ({ page }) => {
    const name = `Build Bot ${crypto.randomUUID().slice(0, 8)}`;
    const url = await openGeneralFor(page, name);
    const text = `Shipped ${crypto.randomUUID().slice(0, 8)}`;
    const message = messageUrl(url, await page.request.post(url, { data: text, headers: FORM }));

    const boosted = await page.request.post(`${message}/boosts`, { data: "🎉", headers: FORM });
    expect(boosted.status()).toBe(201);
    const boost = page.getByRole("article").filter({ hasText: text }).getByRole("img", { name: `${name} boosted 🎉` });
    await expect(boost).toBeVisible();

    const { id } = (await boosted.json()) as { id: string };
    expect((await page.request.delete(`${message}/boosts/${id}`)).status()).toBe(204);
    await expect(boost).toHaveCount(0);
  });
});

test.describe("Webhooks", () => {
  test("mentioning a bot in the composer delivers the message to its webhook, as Campfire's JSON", async ({ page }) => {
    const webhook = await listenAsWebhook();
    try {
      const tag = crypto.randomUUID().slice(0, 8);
      const name = `Build Bot ${tag}`;
      const url = await openGeneralFor(page, name, webhook.url);
      await mentionBot(page, "Ship it & tell ", name, tag);
      const sent = page.getByRole("article").filter({ hasText: `Ship it & tell ${name}` });
      await expect(sent).toBeVisible();

      await expect.poll(() => webhook.received.length).toBe(1);
      const [{ method, path, headers, body }] = webhook.received as [Received];
      expect([method, path]).toEqual(["POST", "/hooks/build?team=ops"]);
      expect(headers).toMatchObject({ "content-type": "application/json", accept: "*/*", "user-agent": "Ruby" });
      expect(body).not.toMatch(/[<>&]/);
      const payload = JSON.parse(body) as { user: { name: string }; room: { name: string; path: string }; message: { id: string; body: { html: string; plain: string }; path: string } };
      // The room's address is the one the bot's command posts to, with a key of the webhook's own in
      // place of the bot's, and the message's is its permalink.
      const command = new URL(url).pathname;
      const [room, key] = [command.replace(/\/[^/]+\/messages$/, ""), command.split("/")[3]!];
      expect(payload).toMatchObject({ user: { name: ADMINISTRATOR.name }, room: { name: "general" }, message: { body: { plain: "Ship it & tell" } } });
      expect(payload.room.path).toMatch(new RegExp(`^${room}/${key.split("-")[0]}-[0-9a-f]{32}/messages$`));
      expect(body).not.toContain(key);
      expect(Object.keys(payload)).toEqual(["user", "room", "message"]);
      expect(payload.message.path).toBe(`${room}/@${payload.message.id}`);
      // The stored rich text, the mention an attachment as Campfire keeps it.
      expect(payload.message.body.html).toMatch(/^<p>Ship it &amp; tell <action-text-attachment [^>]*content-type="application\/vnd\.campfire\.mention"/);
      // The webhook's key posts in the room as the bot, as the bot's own does.
      const answer = `Shipped ${tag}`;
      expect((await page.request.post(new URL(payload.room.path, url).href, { data: answer, headers: FORM })).status()).toBe(201);
      await expect(page.getByRole("article").filter({ hasText: answer })).toContainText(name);
    } finally {
      await webhook.close();
    }
  });
});

test.describe("Webhook replies", () => {
  test("what a bot's webhook answers, gzipped, shows in the room as the bot's message", async ({ page }) => {
    const webhook = await listenAsWebhook((response) => response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Encoding": "gzip" }).end(gzipSync("Zipped reply")));
    try {
      const tag = crypto.randomUUID().slice(0, 8);
      const name = `Build Bot ${tag}`;
      await openGeneralFor(page, name, webhook.url);
      await mentionBot(page, "Ship it ", name, tag);

      const reply = page.getByRole("article").filter({ hasText: "Zipped reply" });
      await expect(reply).toBeVisible();
      await expect(reply).toContainText(name);
      expect(webhook.received).toHaveLength(1);
    } finally {
      await webhook.close();
    }
  });

  test("a picture a bot's webhook answers shows in the room as the bot's file", async ({ page }) => {
    let chart = Buffer.alloc(0);
    const webhook = await listenAsWebhook((response) => response.writeHead(200, { "Content-Type": "image/png" }).end(chart));
    try {
      const tag = crypto.randomUUID().slice(0, 8);
      const name = `Build Bot ${tag}`;
      await openGeneralFor(page, name, webhook.url);
      chart = (await drawnPicture(page, "chart.png", 40, 20)).buffer;
      await mentionBot(page, "Chart it ", name, tag);

      // Named by its type, as Campfire names a file a webhook answers.
      const reply = page.getByRole("article").filter({ hasText: name }).filter({ has: page.getByRole("img", { name: "attachment.png" }) });
      await expect(reply).toBeVisible();
      expect(await shownPicture(reply.getByRole("img", { name: "attachment.png" }))).toEqual({ type: "image/png", width: 40, height: 20 });
    } finally {
      await webhook.close();
    }
  });
});

test.describe("Buttons that act", () => {
  test("a click on a bot's card's button goes to the bot's webhook, and the card the bot answers takes its place", async ({ page }) => {
    const tag = crypto.randomUUID().slice(0, 8);
    const approved = { blocks: [{ type: "section", text: { type: "mrkdwn", text: `*v${tag}* approved` } }] };
    const webhook = await listenAsWebhook((response) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(approved)));
    try {
      const name = `Deploy Bot ${tag}`;
      const url = await openGeneralFor(page, name, webhook.url);
      const question = `Deploy v${tag} to production?`;
      const posted = await page.request.post(url.replace(/\/messages$/, "/slack"), {
        data: {
          blocks: [
            { type: "section", text: { type: "plain_text", text: question } },
            {
              type: "actions",
              block_id: `deploy-${tag}`,
              elements: [
                { type: "button", text: { type: "plain_text", text: "Approve" }, action_id: "approve", value: tag, style: "primary" },
                { type: "button", text: { type: "plain_text", text: "Release notes" }, url: "https://example.com/releases" },
              ],
            },
          ],
        },
      });
      expect([posted.status(), await posted.text()]).toEqual([200, "ok"]);

      // The bot's one message, which its name is on, where its card's frame is an article too.
      const message = page.getByRole("article").filter({ hasText: name });
      await expect(message).toContainText(question);
      await expect(message.getByRole("link", { name: "Release notes" })).toHaveAttribute("href", "https://example.com/releases");
      await message.getByRole("button", { name: "Approve" }).click();

      // The bot's answer takes the card's place, buttons and all, in the message it was.
      await expect(message).toContainText(`v${tag} approved`);
      await expect(message).not.toContainText(question);
      await expect(message.getByRole("button", { name: "Approve" })).toHaveCount(0);
      await expect(message).toHaveCount(1);

      expect(webhook.received).toHaveLength(1);
      const payload = JSON.parse(webhook.received[0]!.body) as { type: string; user: { name: string }; actions: unknown[]; response_path: string; message: { id: string } };
      expect(payload).toMatchObject({
        type: "block_actions",
        user: { name: ADMINISTRATOR.name },
        room: { name: "general" },
        actions: [{ type: "button", action_id: "approve", block_id: `deploy-${tag}`, value: tag, text: { type: "plain_text", text: "Approve" } }],
      });

      // Later, the bot puts another card in its place, at the address the click gave it.
      const live = await page.request.post(new URL(payload.response_path, url).href, { data: { text: `v${tag} is live` } });
      expect([live.status(), await live.text()]).toEqual([200, "ok"]);
      await expect(message).toContainText(`v${tag} is live`);
      await expect(message).not.toContainText(`v${tag} approved`);
    } finally {
      await webhook.close();
    }
  });

  test("a click a bot's webhook refuses tells whoever clicked, and leaves the card as it was", async ({ page }) => {
    const webhook = await listenAsWebhook((response) => response.writeHead(500).end());
    try {
      const tag = crypto.randomUUID().slice(0, 8);
      const name = `Deploy Bot ${tag}`;
      const url = await openGeneralFor(page, name, webhook.url);
      const posted = await page.request.post(url.replace(/\/messages$/, "/slack"), {
        data: { blocks: [{ type: "section", text: { type: "plain_text", text: `Roll back v${tag}?` }, accessory: { type: "button", text: { type: "plain_text", text: "Roll back" }, action_id: "rollback", style: "danger" } }] },
      });
      expect(posted.status()).toBe(200);

      const button = page.getByRole("article").filter({ hasText: name }).getByRole("button", { name: "Roll back" });
      await button.click();
      await expect(page.getByText(`${name} couldn't take that click`)).toBeVisible();
      await expect(button).toBeEnabled();
      expect(webhook.received).toHaveLength(1);
    } finally {
      await webhook.close();
    }
  });
});

test.describe("Chat bots page", () => {
  test("a member who opens the bot pages is sent to workspace settings, told why", async ({ page, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit#membership-settings");
    await signInAsAdministrator(page);
    const member = await join(browser, baseURL!, await page.getByRole("textbox", { name: "Share to invite more people" }).inputValue(), "Grace Hopper");

    for (const path of ["/account/bots", "/account/bots/new"]) {
      await member.goto(path);
      await expect(member.getByRole("alert")).toHaveText("Only administrators can manage bots");
      await expect(member).toHaveURL(/\/account\/edit$/);
      await expect(member.getByRole("heading", { level: 1, name: "Basic community settings" })).toBeVisible();
      await expect(member.getByRole("link", { name: "Chat bots" })).toHaveCount(0);
    }
    await member.context().close();
  });

  test("spaces its heading, explainer and Add a chat bot apart, with the bots lined up under them, on a computer and a phone", async ({ page, browser, baseURL }) => {
    await openBots(page);
    await addBot(page, `Spacing Bot ${crypto.randomUUID().slice(0, 8)}`);
    /** The page's heading, explainer, Add a chat bot and first bot, where they're drawn. */
    const header = async (on: Page) => {
      const main = on.getByRole("main");
      const [heading, explainer, add, bot] = [
        main.getByRole("heading", { level: 1, name: "Chat bots" }),
        main.getByText(/^Chat bots let other apps and services post in your rooms/),
        main.getByRole("link", { name: "Add a chat bot" }),
        main.getByRole("listitem").first(),
      ];
      await expect(bot).toBeVisible();
      return { heading: await box(heading), explainer: await box(explainer), add: await box(add), bot: await box(bot) };
    };

    // On a computer, Add a chat bot ends the heading's row, centered on the heading, the explainer starts
    // under both, as a section's description does under its heading, and the bots 28px under that, as wide
    // as the row.
    const { heading, explainer, add, bot } = await header(page);
    expect(add.y + add.height / 2).toBeCloseTo(heading.y + heading.height / 2, 0);
    expect(add.x).toBeGreaterThan(heading.x + heading.width);
    expect(explainer.y - (add.y + add.height)).toBeCloseTo(6, 0);
    expect(bot.y - (explainer.y + explainer.height)).toBeCloseTo(28, 0);
    expect(bot.x).toBeCloseTo(heading.x, 0);
    expect(bot.x + bot.width).toBeCloseTo(add.x + add.width, 0);

    // On a phone, Add a chat bot follows the explainer, 16px under it, rather than wrapping in between them,
    // and the bots start 28px under it, all at the heading's edge.
    const phone = await browser.newContext({ ...devices["Galaxy S24"], baseURL, ignoreHTTPSErrors: true });
    try {
      const onPhone = await phone.newPage();
      await useOwnAddress(onPhone);
      await onPhone.goto("/account/bots");
      await signInAsAdministrator(onPhone);
      const shown = await header(onPhone);
      expect(shown.add.y - (shown.explainer.y + shown.explainer.height)).toBeCloseTo(16, 0);
      expect(shown.bot.y - (shown.add.y + shown.add.height)).toBeCloseTo(28, 0);
      for (const { x } of [shown.explainer, shown.add, shown.bot]) expect(x).toBeCloseTo(shown.heading.x, 0);
      const results = await auditScreen(onPhone, { top: 0, right: 0, bottom: 0, left: 0 });
      expect(results.overflow, "Nothing is cut off or pushed off the side of the screen").toEqual([]);
      expect(results.touchTargets, "Every control is easy to tap").toEqual([]);
    } finally {
      await phone.close();
    }
  });
});

test.describe("Where bots show up", () => {
  test("a bot is offered to mention, to message and for a private room, but isn't among the people", async ({ page }) => {
    const tag = crypto.randomUUID().slice(0, 8);
    const name = `Build Bot ${tag}`;
    await openGeneralFor(page, name);

    // It joined general as it was added, so the composer offers it there.
    const composer = editorField(page, "Write a message");
    await composer.pressSequentially("@");
    await expect(page.getByRole("listbox")).toBeVisible();
    const listed = page.waitForResponse((response) => new URL(response.url()).searchParams.get("filter") === tag);
    await composer.pressSequentially(tag);
    await listed;
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText([name]);

    await page.goto("/rooms/directs/new");
    const newDirect = page.getByRole("dialog", { name: "New direct message" });
    await newDirect.getByRole("combobox", { name: "Search people" }).fill(tag);
    await expect(newDirect.getByRole("option")).toHaveText([name]);

    await page.goto("/rooms/closeds/new");
    await expect(page.getByRole("switch", { name: `Give ${name} access to this room` })).not.toBeChecked();

    await page.goto("/account/edit#membership-settings");
    const people = page.getByRole("region", { name: "Membership" });
    await expect(people.getByRole("listitem").filter({ hasText: ADMINISTRATOR.name })).toBeVisible();
    await expect(people.getByText(name)).toHaveCount(0);
  });
});

test.describe("A bot's profile", () => {
  test("a bot's page, opened from its avatar, shows that and a button that starts a DM with it, until it's deleted", async ({ page }) => {
    await openBots(page);
    const name = `Build Bot ${crypto.randomUUID().slice(0, 8)}`;
    await addBot(page, name);
    await botNamed(page, name).getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(/\/users\/[^/]+$/);
    const profile = new URL(page.url()).pathname;
    await expect(page).toHaveTitle(name);
    await expect(page.getByRole("img", { name: "Profile avatar" })).toBeVisible();
    // Neither its name, nor a sign-in link or Ban, which the administrator gets on a person's page.
    await expect(page.getByRole("main").getByRole("heading")).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Ban ${name}` })).toHaveCount(0);

    await page.getByRole("button", { name: `Ping ${name}` }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Direct message with ${name}`);

    await page.goto("/account/bots");
    await botNamed(page, name).getByRole("link", { name: `Edit ${name}` }).click();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Delete this chat bot" }).click();
    await expect(page).toHaveURL(/\/account\/bots$/);

    await page.goto(profile);
    await expect(page.getByText(`${name} is no longer on this account`)).toBeVisible();
    await expect(page.getByRole("img", { name: "Profile avatar" })).toBeVisible();
    await expect(page.getByRole("button", { name: `Ping ${name}` })).toHaveCount(0);
  });
});

