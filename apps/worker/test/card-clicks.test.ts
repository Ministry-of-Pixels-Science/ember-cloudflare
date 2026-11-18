import type { BotAnswer, BotSettings, Card, CardButton, Message, NewWorkspace, RoomId } from "@ember/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackMessage } from "../src/bots/slack";
import { api, connect, cookieOf, freshDeploy, roomStub, settle, shown, signIn, workspaceSql, workspaceStub, type Client, type Session } from "./support";

// Clicks on the buttons that act on a bot's cards (bots/clicks.ts): the room reports each to the webhook of
// the bot that posted the card, as Slack's `block_actions` tells one, and what the bot answers takes the
// card's place.

const WEBHOOK = "https://bots.example.com/hook";

/** Sets Ember up with Ada as its administrator, and a bot in first run's general room, whose webhook delivers to `webhookUrl`, if it's given. */
async function withBot(webhookUrl: string | undefined = WEBHOOK): Promise<{ ada: Session; bot: BotSettings; general: RoomId }> {
  const setUp = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(setUp.status).toBe(201);
  const ada = { user: shown(((await setUp.json()) as NewWorkspace).user), cookie: cookieOf(setUp) };
  const added = await api("/api/account/bots", { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify({ name: "Deploy Bot", webhookUrl }) });
  expect(added.status, await added.clone().text()).toBe(201);
  const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
  return { ada, bot: ((await added.json()) as BotAnswer).bot, general };
}

/** A request a webhook got: where it went, and how it was sent. */
interface Delivery {
  url: string;
  init: RequestInit;
}

/** Stands in for every webhook, answering each request with `answer`, by default an empty 204, and keeps the requests, in the order they came. */
function bots(answer: (delivery: Delivery) => Promise<Response> = async () => new Response(null, { status: 204 })) {
  const delivered: Delivery[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const delivery = { url: input instanceof Request ? input.url : String(input), init: init! };
    delivered.push(delivery);
    return answer(delivery);
  });
  return delivered;
}

/** Stands in for every webhook, answering each request with `payload` as JSON. */
const botsAnswering = (payload: unknown) => bots(async () => Response.json(payload));

/** What the request `delivery` sent, read as JSON. */
const sentIn = (delivery: Delivery) => JSON.parse(delivery.init.body as string) as Record<string, unknown>;

/** An actions block of Approve, which acts, primary, Reject, which acts with no value, and Logs, which links. */
const APPROVAL = {
  blocks: [
    { type: "section", text: { type: "mrkdwn", text: "Deploy *v42* to production?" } },
    {
      type: "actions",
      block_id: "deploy-42",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Approve" }, action_id: "approve", value: '{"build":42}', style: "primary" },
        { type: "button", text: { type: "plain_text", text: "Reject" }, action_id: "reject", style: "danger" },
        { type: "button", text: { type: "plain_text", text: "Logs" }, action_id: "logs", url: "https://ci.example.com/builds/42" },
      ],
    },
  ],
};

const APPROVE: CardButton = { text: "Approve", action: { id: "approve", blockId: "deploy-42", value: '{"build":42}' }, style: "primary" };
const REJECT: CardButton = { text: "Reject", action: { id: "reject", blockId: "deploy-42" }, style: "danger" };
const LOGS: CardButton = { text: "Logs", href: "https://ci.example.com/builds/42" };

/** The buttons of the first buttons part among `cards`. */
const buttonsOf = (cards: Card[] | undefined) => cards?.flatMap(({ parts }) => parts).flatMap((part) => (part.kind === "buttons" ? part.buttons : []));

/** Posts `payload` to `room`'s Slack-compatible webhook as the bot whose key is `key`, answering the message `watching` hears of. */
async function postCard(watching: Client, room: RoomId, key: string, payload: unknown = APPROVAL): Promise<Message> {
  const response = await api(`/rooms/${room}/${key}/slack`, { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } });
  expect([response.status, await response.text()]).toEqual([200, "ok"]);
  return (await watching.next("message.created")).message;
}

/** The values of `APPROVAL`'s buttons that have one, by `action_id`, which a tab sends with a click. */
const VALUES: Record<string, string> = { approve: '{"build":42}' };

/**
 * Clicks the button `actionId` names on `message`, in the block `blockId` names, or in none for null, as
 * `client`, with the value `APPROVAL` gives it, or `value`, or none for null, answering the click's id.
 */
function click(client: Client, message: Pick<Message, "id">, actionId: string, blockId: string | null = "deploy-42", value: string | null = VALUES[actionId] ?? null): string {
  const clickId = crypto.randomUUID();
  client.send({ type: "card.click", clickId, messageId: message.id, actionId, ...(blockId !== null && { blockId }), ...(value !== null && { value }) });
  return clickId;
}

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Buttons that act", () => {
  it("keeps the buttons with an action_id among a bot's with a webhook, and a link as a link", async () => {
    const { ada, bot, general } = await withBot();
    const message = await postCard(await connect(general, ada), general, bot.key);
    expect(buttonsOf(message.cards)).toEqual([APPROVE, REJECT, LOGS]);
    expect(message.plainText).toBe("Deploy v42 to production?\nApprove · Reject · Logs");
  });

  it("leaves them out of the card of a bot without a webhook, whose clicks have nowhere to go, as it always has", async () => {
    const { ada, bot, general } = await withBot("");
    const message = await postCard(await connect(general, ada), general, bot.key);
    expect(buttonsOf(message.cards)).toEqual([LOGS]);
  });

  it("leaves them out of a payload read without them, as an agent's answer is", () => {
    const read = (acting?: boolean) => {
      const message = slackMessage(APPROVAL, acting);
      return typeof message === "string" ? message : buttonsOf(message.cards);
    };
    expect(read()).toEqual([LOGS]);
    expect(read(true)).toEqual([APPROVE, REJECT, LOGS]);
    // A card of nothing but buttons that act shows nothing without them.
    expect(slackMessage({ blocks: [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Approve" }, action_id: "approve" }] }] })).toBe("no_text");
  });

  it("takes a section's accessory and a card block's buttons, with a value up to Slack's limit", () => {
    const button = (extra: Record<string, unknown>) => ({ type: "button", text: { type: "plain_text", text: "Run" }, ...extra });
    const message = slackMessage(
      {
        blocks: [
          { type: "section", block_id: "s1", text: { type: "plain_text", text: "Nightly" }, accessory: button({ action_id: "run", value: "x".repeat(2000) }) },
          { type: "section", text: { type: "plain_text", text: "Too long" }, accessory: button({ action_id: "run", value: "x".repeat(2001) }) },
          { type: "section", text: { type: "plain_text", text: "Unnamed" }, accessory: button({ value: "only an app could answer" }) },
          // A button with an address is a link, which goes when the room can't keep where it leads.
          { type: "section", text: { type: "plain_text", text: "Linked" }, accessory: button({ action_id: "open", url: "javascript:alert(1)" }) },
          { type: "card", block_id: "c1", title: { type: "plain_text", text: "Build" }, actions: [button({ action_id: "retry" })] },
        ],
      },
      true,
    );
    expect(message).toMatchObject({
      cards: [
        {
          parts: [
            { kind: "section", button: { text: "Run", action: { id: "run", blockId: "s1", value: "x".repeat(2000) } } },
            { kind: "section", button: { text: "Run", action: { id: "run" } } },
            { kind: "section" },
            { kind: "section" },
            { kind: "tiles", tiles: [{ title: "Build", buttons: [{ text: "Run", action: { id: "retry", blockId: "c1" } }] }] },
          ],
        },
      ],
    });
    const parts = (message as { cards: Card[] }).cards[0]!.parts;
    expect(parts[1]).not.toHaveProperty("button.action.value");
    expect(parts[2]).not.toHaveProperty("button");
    expect(parts[3]).not.toHaveProperty("button");
  });

  it("reports a click to the bot's webhook as Slack's block_actions, for whoever clicked, and tells them once the bot has answered", async () => {
    const { ada, bot, general } = await withBot();
    const kai = await connect(general, "Kai");
    const message = await postCard(kai, general, bot.key);
    const delivered = bots();

    const clickId = click(kai, message, "approve");
    expect(await kai.next("card.clicked")).toEqual({ type: "card.clicked", clickId });

    expect(delivered.map(({ url }) => url)).toEqual([`${WEBHOOK}`]);
    expect(delivered[0]!.init).toMatchObject({ method: "POST", redirect: "manual", headers: { "Content-Type": "application/json" } });
    const { key } = (await workspaceStub().botWebhook(general, bot.id))!;
    const sent = sentIn(delivered[0]!);
    expect(sent).toEqual({
      type: "block_actions",
      user: { id: kai.me.id, name: "Kai" },
      room: { id: general, name: "general", path: `/rooms/${general}/${key}/messages` },
      message: { id: message.id, body: { html: null, plain: "Deploy v42 to production?\nApprove · Reject · Logs" }, path: `/rooms/${general}/@${message.id}` },
      actions: [
        { type: "button", action_id: "approve", block_id: "deploy-42", value: '{"build":42}', text: { type: "plain_text", text: "Approve" }, action_ts: expect.stringMatching(/^\d{10}\.\d{6}$/) },
      ],
      response_path: `/rooms/${general}/${key}/messages/${message.id}/slack`,
    });
    // The key is the webhook's own there, never the bot's.
    expect(key).not.toBe(bot.key);
  });

  it("tells apart two buttons of one action_id in blocks without a block_id, by their values", async () => {
    const { ada, bot, general } = await withBot();
    const inRoom = await connect(general, ada);
    const row = (build: string) => ({
      type: "section",
      text: { type: "mrkdwn", text: `Deploy *${build}*?` },
      accessory: { type: "button", text: { type: "plain_text", text: "Approve" }, action_id: "approve", value: build },
    });
    const message = await postCard(inRoom, general, bot.key, { blocks: [row("v41"), row("v42")] });
    const delivered = bots();

    for (const build of ["v42", "v41"]) {
      click(inRoom, message, "approve", null, build);
      await inRoom.next("card.clicked");
    }
    expect(delivered.map((delivery) => sentIn(delivery).actions)).toEqual([
      [expect.objectContaining({ action_id: "approve", value: "v42" })],
      [expect.objectContaining({ action_id: "approve", value: "v41" })],
    ]);
    expect(sentIn(delivered[0]!).actions).not.toEqual([expect.objectContaining({ block_id: expect.anything() })]);
  });

  it("puts the payload a bot answers in its card's place, for everyone, marked as edited", async () => {
    const { ada, bot, general } = await withBot();
    const [inRoom, kai] = [await connect(general, ada), await connect(general, "Kai")];
    const message = await postCard(inRoom, general, bot.key);
    await kai.next("message.created");
    botsAnswering({ blocks: [{ type: "section", text: { type: "mrkdwn", text: "*v42* approved by Kai" } }] });

    const clickId = click(kai, message, "approve");
    for (const client of [inRoom, kai]) {
      const { message: replaced } = await client.next("message.updated");
      expect(replaced).toMatchObject({ id: message.id, creator: { id: bot.id }, body: "", plainText: "v42 approved by Kai", cards: [{ source: "blocks", parts: [{ kind: "section" }] }] });
      expect(replaced.editedAt).not.toBeNull();
    }
    expect(await kai.next("card.clicked")).toEqual({ type: "card.clicked", clickId });
    // Only whoever clicked hears the click was taken.
    await settle(inRoom);
    expect(inRoom.pending("card.clicked")).toEqual([]);
  });

  it("keeps the buttons that act in what takes the card's place, and replaces a card with text alone", async () => {
    const { ada, bot, general } = await withBot();
    const inRoom = await connect(general, ada);
    const message = await postCard(inRoom, general, bot.key);
    botsAnswering({ blocks: [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Undo" }, action_id: "undo" }] }] });
    click(inRoom, message, "approve");
    expect(buttonsOf((await inRoom.next("message.updated")).message.cards)).toEqual([{ text: "Undo", action: { id: "undo" } }]);
    await inRoom.next("card.clicked");

    vi.restoreAllMocks();
    botsAnswering({ text: "Undone." });
    click(inRoom, message, "undo", null);
    const { message: text } = await inRoom.next("message.updated");
    expect(text).toMatchObject({ id: message.id, body: "<p>Undone.</p>", plainText: "Undone." });
    expect(text).not.toHaveProperty("cards");
  });

  it("posts the payload as a new message with replace_original false, and deletes the card with delete_original", async () => {
    const { ada, bot, general } = await withBot();
    const inRoom = await connect(general, ada);
    const message = await postCard(inRoom, general, bot.key);
    const delivered = botsAnswering({ replace_original: false, text: "Kai is on it." });
    click(inRoom, message, "approve");
    expect((await inRoom.next("message.created")).message).toMatchObject({ creator: { id: bot.id }, body: "<p>Kai is on it.</p>" });
    await inRoom.next("card.clicked");
    // The bot's own message is delivered to no webhook, its own least of all.
    await settle(inRoom);
    expect(delivered).toHaveLength(1);

    vi.restoreAllMocks();
    botsAnswering({ delete_original: true });
    click(inRoom, message, "reject");
    expect(await inRoom.next("message.deleted")).toMatchObject({ messageId: message.id });
    await inRoom.next("card.clicked");
  });

  it("posts text a bot answers as its reply, and takes an answer without a payload as taken", async () => {
    const { ada, bot, general } = await withBot();
    const inRoom = await connect(general, ada);
    const message = await postCard(inRoom, general, bot.key);
    bots(async () => new Response("On it.", { headers: { "Content-Type": "text/plain" } }));
    click(inRoom, message, "approve");
    expect((await inRoom.next("message.created")).message).toMatchObject({ creator: { id: bot.id }, body: "On it." });
    await inRoom.next("card.clicked");

    const taken = [
      () => new Response(null, { status: 204 }),
      () => Response.json({}),
      () => new Response("", { headers: { "Content-Type": "application/json" } }),
      () => new Response("", { headers: { "Content-Type": "text/plain" } }),
      () => new Response(" \n", { headers: { "Content-Type": "text/html" } }),
      () => new Response(null, { status: 202 }),
    ];
    for (const answer of taken) {
      vi.restoreAllMocks();
      bots(async () => answer());
      const clickId = click(inRoom, message, "approve");
      expect(await inRoom.next("card.clicked")).toEqual({ type: "card.clicked", clickId });
    }
    await settle(inRoom);
    expect(inRoom.pending("message.updated")).toEqual([]);
    expect(inRoom.pending("message.created")).toEqual([]);
  });

  it("tells whoever clicked when the bot answers an error, or something the room can't show, and leaves the card", async () => {
    const { ada, bot, general } = await withBot();
    const inRoom = await connect(general, ada);
    const message = await postCard(inRoom, general, bot.key);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refusals: Array<[() => Response, string]> = [
      [() => new Response("no", { status: 500 }), "Deploy Bot couldn't take that click"],
      [() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.com/" } }), "Deploy Bot couldn't take that click"],
      [() => new Response("[1]", { headers: { "Content-Type": "application/json" } }), "Deploy Bot's answer couldn't be shown"],
      [() => Response.json({ attachments: Array.from({ length: 101 }, () => ({ text: "one too many" })) }), "Deploy Bot's answer couldn't be shown"],
    ];
    for (const [answer, told] of refusals) {
      vi.restoreAllMocks();
      vi.spyOn(console, "error").mockImplementation(() => {});
      bots(async () => answer());
      const clickId = click(inRoom, message, "approve");
      expect(await inRoom.next("error")).toEqual({ type: "error", message: told, clickId, failed: "card.click" });
    }
    bots(async () => {
      throw new TypeError("Network connection lost.");
    });
    const clickId = click(inRoom, message, "approve");
    expect(await inRoom.next("error")).toEqual({ type: "error", message: "That click couldn't be delivered", clickId, failed: "card.click" });
    await settle(inRoom);
    expect(inRoom.pending("message.updated")).toEqual([]);
  });

  it("refuses a click on a button the message doesn't have, a link, or a message that's gone", async () => {
    const { ada, bot, general } = await withBot();
    const inRoom = await connect(general, ada);
    const message = await postCard(inRoom, general, bot.key);
    const delivered = bots();
    const gone = { type: "error", message: "That button is no longer there", failed: "card.click" };
    // A value the button doesn't have names no button: the room tells a bot only what it kept.
    const attempts: Array<[Pick<Message, "id">, string, string | null, string | null]> = [
      [message, "approve", null, VALUES.approve!],
      [message, "approve", "another-block", VALUES.approve!],
      [message, "approve", "deploy-42", "forged"],
      [message, "approve", "deploy-42", null],
      [message, "reject", "deploy-42", ""],
      [message, "launch", "deploy-42", null],
      [message, "logs", "deploy-42", null],
      [{ id: "nosuchmessage" }, "approve", "deploy-42", VALUES.approve!],
    ];
    for (const [target, actionId, blockId, value] of attempts) {
      const clickId = click(inRoom, target, actionId, blockId, value);
      expect(await inRoom.next("error")).toEqual({ ...gone, clickId });
    }
    inRoom.send({ type: "card.click", clickId: "c2", messageId: message.id, actionId: "approve", value: "x".repeat(2001) });
    expect(await inRoom.next("error")).toEqual({ type: "error", message: "Unrecognized frame" });
    inRoom.send({ type: "card.click", clickId: "c1", messageId: message.id });
    expect(await inRoom.next("error")).toEqual({ type: "error", message: "Unrecognized frame" });
    expect(delivered).toEqual([]);
  });

  it("delivers nothing once the bot's webhook is gone, and says so", async () => {
    const { ada, bot, general } = await withBot();
    const inRoom = await connect(general, ada);
    const message = await postCard(inRoom, general, bot.key);
    const removed = await api(`/api/account/bots/${bot.id}`, { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ webhookUrl: "" }) });
    expect(removed.status).toBe(200);
    const delivered = bots();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const clickId = click(inRoom, message, "approve");
    expect(await inRoom.next("error")).toEqual({ type: "error", message: "Deploy Bot isn't taking clicks here", clickId, failed: "card.click" });
    expect(delivered).toEqual([]);
  });

  it("refuses a click from a banned address, as it refuses a message", async () => {
    const { ada, bot, general } = await withBot();
    const inRoom = await connect(general, ada);
    const message = await postCard(inRoom, general, bot.key);
    const address = "203.0.113.7";
    const signedIn = await api("/api/session", { method: "POST", body: JSON.stringify({ name: "Mallory" }), headers: { "CF-Connecting-IP": address } });
    expect(signedIn.status).toBe(201);
    const mallory = ((await signedIn.json()) as { user: { id: string } }).user;
    const banned = await api(`/api/users/${mallory.id}/ban`, { method: "POST", headers: { Cookie: ada.cookie } });
    expect(banned.status, await banned.clone().text()).toBe(200);
    const delivered = bots();
    // Anyone at the address reads the room, and changes nothing in it.
    const kai = await connect(general, { ...(await signIn("Kai")), ip: address });
    const clickId = click(kai, message, "approve");
    expect(await kai.next("error")).toEqual({ type: "error", message: "Request failed (429)", clickId, failed: "card.click" });
    expect(delivered).toEqual([]);
  });

  it("lets each person have only so many clicks waiting on a bot", async () => {
    const { ada, bot, general } = await withBot();
    const [inRoom, kai] = [await connect(general, ada), await connect(general, "Kai")];
    const message = await postCard(inRoom, general, bot.key);
    let answer = () => {};
    const answered = new Promise<void>((resolve) => (answer = resolve));
    bots(async () => {
      await answered;
      return new Response(null, { status: 204 });
    });
    const waiting = [click(inRoom, message, "approve"), click(inRoom, message, "approve"), click(inRoom, message, "reject")];
    const fourth = click(inRoom, message, "approve");
    expect(await inRoom.next("error")).toEqual({ type: "error", message: "Wait for your earlier clicks to be answered", clickId: fourth, failed: "card.click" });
    // Someone else's click waits its turn all the same.
    const kais = click(kai, message, "approve");
    answer();
    const taken = [await inRoom.next("card.clicked"), await inRoom.next("card.clicked"), await inRoom.next("card.clicked")];
    expect(taken.map(({ clickId }) => clickId).sort()).toEqual([...waiting].sort());
    expect(await kai.next("card.clicked")).toEqual({ type: "card.clicked", clickId: kais });
    // Once they're answered, there's room again.
    const next = click(inRoom, message, "approve");
    expect(await inRoom.next("card.clicked")).toEqual({ type: "card.clicked", clickId: next });
  });

  it("has a bot put a payload in its message's place later, at the address a click gives it", async () => {
    const { ada, bot, general } = await withBot();
    const inRoom = await connect(general, ada);
    const message = await postCard(inRoom, general, bot.key);
    const delivered = bots();
    click(inRoom, message, "approve");
    await inRoom.next("card.clicked");
    const path = sentIn(delivered[0]!).response_path as string;
    vi.restoreAllMocks();

    const replace = (payload: unknown, method = "POST", at = path) =>
      api(at, { method, body: typeof payload === "string" ? payload : JSON.stringify(payload), headers: { "Content-Type": "application/json" } });
    const deployed = await replace({ blocks: [{ type: "header", text: { type: "plain_text", text: "v42 is live" } }, APPROVAL.blocks[1]] });
    expect([deployed.status, await deployed.text()]).toEqual([200, "ok"]);
    const { message: replaced } = await inRoom.next("message.updated");
    expect(replaced).toMatchObject({ id: message.id, plainText: "v42 is live\nApprove · Reject · Logs" });
    expect(buttonsOf(replaced.cards)).toEqual([APPROVE, REJECT, LOGS]);

    // With the bot's own key too, by PUT or PATCH.
    for (const method of ["PUT", "PATCH"]) {
      const again = await replace({ text: `Sent by ${method}` }, method, `/rooms/${general}/${bot.key}/messages/${message.id}/slack`);
      expect([again.status, await again.text()]).toEqual([200, "ok"]);
      expect((await inRoom.next("message.updated")).message).toMatchObject({ id: message.id, body: `<p>Sent by ${method}</p>` });
    }

    const refusals: Array<[Promise<Response>, number, string]> = [
      [replace({}), 400, "no_text"],
      [replace("[]"), 400, "invalid_payload"],
      [replace({ text: "hi" }, "POST", `/rooms/${general}/${bot.key}/messages/nosuchmessage/slack`), 404, "message_not_found"],
      [replace({ text: "hi" }, "POST", `/rooms/${general}/${bot.id}-wrong/messages/${message.id}/slack`), 403, "invalid_token"],
      [api(path), 404, ""],
    ];
    for (const [request, status, text] of refusals) {
      const response = await request;
      expect(response.status).toBe(status);
      if (text) expect(await response.text()).toBe(text);
    }

    const adas = (await (async () => {
      inRoom.send({ type: "message.create", clientMessageId: crypto.randomUUID(), body: "<div>Mine</div>" });
      return (await inRoom.next("message.created")).message;
    })()) as Message;
    const someoneElses = await replace({ text: "hi" }, "POST", `/rooms/${general}/${bot.key}/messages/${adas.id}/slack`);
    expect([someoneElses.status, await someoneElses.text()]).toEqual([403, "cant_update_message"]);

    const deleted = await replace({ delete_original: true });
    expect([deleted.status, await deleted.text()]).toEqual([200, "ok"]);
    expect(await inRoom.next("message.deleted")).toMatchObject({ messageId: message.id });
  });

  it("reports a click in a thread with the thread's address, and posts the answer's new message there", async () => {
    const { ada, bot, general } = await withBot();
    const inRoom = await connect(general, ada);
    inRoom.send({ type: "message.create", clientMessageId: crypto.randomUUID(), body: "<div>Ship it?</div>" });
    const { message: parent } = await inRoom.next("message.created");
    const { key } = (await workspaceStub().botWebhook(general, bot.id))!;
    const posted = await workspaceStub().botInRoom(bot.id, bot.key.split("-")[1]!, general);
    expect(posted).toMatchObject({ takesClicks: true });
    const card = slackMessage(APPROVAL, true) as { markup: string; cards: Card[] };
    const reply = (await roomStub(general).createBotMessage(general, posted as Exclude<typeof posted, "not found" | null>, card.markup, card.cards, parent.id)) as Message;
    expect(reply).toMatchObject({ parentId: parent.id });

    const delivered = botsAnswering({ replace_original: false, text: "In the thread." });
    inRoom.send({ type: "thread.open", parentId: parent.id });
    await inRoom.next("thread.opened");
    await settle(inRoom);
    inRoom.pending("message.created").forEach(() => void inRoom.next("message.created"));
    click(inRoom, reply, "approve");
    expect((await inRoom.next("message.created")).message).toMatchObject({ parentId: parent.id, body: "<p>In the thread.</p>" });
    await inRoom.next("card.clicked");
    expect(sentIn(delivered[0]!)).toMatchObject({ room: { path: `/rooms/${general}/${key}/messages?thread=${parent.id}` }, message: { id: reply.id } });
  });
});
