import { MAX_MESSAGE_HTML_LENGTH, threadPath, type Message, type RoomId, type StoredFile, type User } from "@ember/protocol";
import { botMessagesPath } from "@ember/protocol/bots";
import type { ArrivingFile } from "../files/streamed";
import { trimmed } from "../trim";
import type { WebhookAccess } from "../workspace";
import type { MessageWebhook } from "../workspace-store";
import { contentTypeOf, replyFileOf, type ReplyFile } from "./mime";
import { railsJson } from "./rails-json";

// Delivering new messages to bots' webhooks, as Campfire's `Webhook#deliver` does
// (app/models/webhook.rb): the message, as JSON, POSTed to the URL an administrator gave the bot, whose
// answer is what the bot says back. Nothing guards where that is, since only administrators set it.
// Redirects aren't followed, and nothing is retried.

/**
 * How long a webhook has to answer, connecting included, and then to send each part of its answer, as
 * Net::HTTP times connecting and each read: 30 seconds, where Campfire's `Webhook::ENDPOINT_TIMEOUT` is
 * 7, so that a bot that asks an AI model or another slow service has time to answer.
 */
export const ENDPOINT_TIMEOUT_MS = 30_000;

/**
 * The most a delivery may take in all, so that a webhook that keeps sending a little at a time can't
 * hold its place in the room's queue for ever.
 */
export const DELIVERY_DEADLINE_MS = 60_000;

/**
 * The most bytes of an answer read as text: no more than a message's markup can take, as the bot API
 * reads a post (api.ts).
 */
const MAX_TEXT_REPLY_BYTES = 3 * MAX_MESSAGE_HTML_LENGTH;

/** The most bytes of a file a bot replies with, where Rails reads any. */
export const MAX_FILE_REPLY_BYTES = 100 * 1024 * 1024;

/**
 * The headers Net::HTTP sends with Campfire's request, but for those a Worker's `fetch` decides itself:
 * Host, Content-Length, Connection and Accept-Encoding. Cloudflare adds `CF-Worker`, naming the Worker's
 * host.
 */
const HEADERS = { "Content-Type": "application/json", Accept: "*/*", "User-Agent": "Ruby" };

/**
 * `Webhook#payload`: who wrote `message` and where, as `delivery` names them, and what it says, for
 * `webhook`'s bot. The room's address is the one the bot posts to there, with the key its webhook gives
 * it there, where Campfire gives the bot's own (`Workspace.botWebhook`), which for a reply in a thread
 * posts to that thread, and reads it, so a bot that answers later finds it as one that answers at once
 * does. The message's is its permalink, both without an origin, as Rails' path helpers
 * write them. A file message has no rich text, so its `html` is null, as Campfire's `message.body.body`
 * is, and its plain text is its file's name. A message's file, which Campfire leaves out, follows its
 * body, with the path that opens it, signed as the room's links are, so the bot fetches it without its key.
 */
export function webhookPayload(roomId: RoomId, delivery: Pick<MessageWebhook, "author" | "roomName">, webhook: Pick<WebhookAccess, "bot" | "key">, message: DeliveredMessage): string {
  return railsJson(deliveryOf(roomId, delivery, webhook, message));
}

/** What a delivery says of a message. */
export type DeliveredMessage = Pick<Message, "id" | "body" | "plainText" | "mentions" | "parentId" | "attachment">;

/** What `webhookPayload` writes, which a click's delivery says too (clicks.ts), of whoever clicked and the message clicked. */
export function deliveryOf(roomId: RoomId, { author, roomName }: Pick<MessageWebhook, "author" | "roomName">, { bot, key }: Pick<WebhookAccess, "bot" | "key">, message: DeliveredMessage) {
  const plain = withoutMentionsOf(nameIn(message, bot), message.plainText);
  // A reply in a thread's permalink opens its thread at it.
  const path = message.parentId === undefined ? `/rooms/${roomId}/@${message.id}` : threadPath(roomId, message.parentId, message.id);
  return {
    user: { id: author.id, name: author.name },
    room: { id: roomId, name: roomName, path: botMessagesPath(roomId, key, message.parentId) },
    message: {
      id: message.id,
      body: { html: message.body === "" ? null : message.body, plain },
      ...(message.attachment && { attachment: attachmentJson(message.attachment) }),
      path,
    },
  };
}

/** A message's file as Active Storage names a blob's columns, with the path that opens it. */
const attachmentJson = ({ name, contentType, byteSize, url }: StoredFile) => ({ filename: name, content_type: contentType, byte_size: byteSize, path: url });

/**
 * The name `message`'s plain text gives `bot`: the one its mentions of it have, from when the text was
 * last written, which a rename since leaves older than the bot's name now, or where it isn't mentioned
 * by name, the bot's name now. Campfire reads both as the delivery runs, so they always agree.
 */
const nameIn = (message: Pick<Message, "mentions">, bot: User) => message.mentions.find(({ id }) => id === bot.id)?.name || bot.name;

/** Rust's `char::is_whitespace`: Unicode's White_Space. */
const WHITE_SPACE = /\p{White_Space}/u;

/** `without_recipient_mentions`: `text` without its @mentions of `name`, matched case for case, nor whitespace at either end. */
const withoutMentionsOf = (name: string, text: string) => trimmed(text.replaceAll(`@${name}`, ""), (c) => WHITE_SPACE.test(c));

/** What a bot says back: text, which it posts as its message, or a file, with what keeping it as it arrived came to. */
export type Reply<K> = { text: string } | { file: ReplyFile; kept: K };

/** What came of a delivery: the webhook's status, or null when it didn't answer in time, and what the bot says back, if anything. */
export interface Delivered<K> {
  status: number | null;
  reply: Reply<K> | null;
}

/** Keeps a file a bot replies with, as it arrives, answering what that came to, or null once it's more than its limit. */
export type Keep<K> = (file: ArrivingFile) => Promise<K | null>;

/** How long a delivery may take: to answer, and then to send each part of the answer, and in all. */
export interface Timeouts {
  endpointMs: number;
  deadlineMs: number;
}

const TIMEOUTS: Timeouts = { endpointMs: ENDPOINT_TIMEOUT_MS, deadlineMs: DELIVERY_DEADLINE_MS };

/** Why a delivery came to nothing, as Ruby raises: a URL Net::HTTP can't send to, a request that failed, or an answer that can't be read. */
export class WebhookError extends Error {}

/**
 * Whether a webhook may be delivered to `url`: an https URL with a host, or an http one on this machine,
 * as a bot run beside `wrangler dev` is, where Campfire takes any http URL. Each delivery carries a key
 * in `room.path` that posts as the bot, which anyone on a plain http path could read and post with.
 */
export function isWebhookUrl({ protocol, hostname }: URL): boolean {
  if (!hostname) return false;
  return protocol === "https:" || (protocol === "http:" && isLoopback(hostname));
}

/** Whether `hostname`, as a URL gives it, names this machine: localhost, a name under it, or a loopback address. */
const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);

/** Why a delivery to an http URL elsewhere fails, as a webhook saved before only https was taken can have. */
const PLAIN_HTTP = "its URL is http, which only a webhook on localhost may use";

/**
 * `Webhook#deliver`'s request and what it reads of the answer: POSTs `payload` to `url`, as Net::HTTP
 * does, and answers what the bot says back, having `keep` keep a file as it arrives, where Campfire reads
 * all of it first. A webhook that doesn't answer, or send the next part of its answer, within
 * `endpointMs`, or finish within `deadlineMs`, says it failed to respond, as Campfire has the bot say
 * then. Throws a `WebhookError` when a webhook may not be delivered to `url` (`isWebhookUrl`), the
 * request fails, or the answer can't be read or kept, with a message that never holds the URL. Tests
 * can give it shorter `timeouts`, and `send` to stand in for `fetch`.
 */
export async function postWebhook<K>(url: string, payload: string, keep: Keep<K>, options: PostOptions = {}): Promise<Delivered<K>> {
  const posted = await post(url, payload, (response, clock) => replyIn(response, clock, keep), options);
  if ("timedOutAfter" in posted) return { status: null, reply: { text: `Failed to respond within ${posted.timedOutAfter / 1000} seconds` } };
  return { status: posted.status, reply: posted.answer };
}

/** What tests give a delivery: shorter `timeouts`, and `send` to stand in for `fetch`. */
export interface PostOptions {
  timeouts?: Timeouts;
  send?: typeof fetch;
}

/** What came of a click's delivery: the webhook's status, or null when it didn't answer in time, and what the bot answers, if anything. */
export interface Clicked<K> {
  status: number | null;
  answer: ClickAnswer<K> | null;
}

/** What a bot answers a click with: what it says back, as it answers a message, or the JSON of a Slack payload, for its card. */
export type ClickAnswer<K> = Reply<K> | { payload: string };

/**
 * Delivers a click as `postWebhook` delivers a message, and reads the answer as it does, but for a 200's
 * `application/json`, which is a payload for the bot's card, where a message's delivery keeps it as a
 * file. A webhook that doesn't answer in time says nothing: the room tells whoever clicked.
 */
export async function postClick<K>(url: string, payload: string, keep: Keep<K>, options: PostOptions = {}): Promise<Clicked<K>> {
  const posted = await post(url, payload, (response, clock) => clickAnswerIn(response, clock, keep), options);
  return "timedOutAfter" in posted ? { status: null, answer: null } : posted;
}

async function clickAnswerIn<K>(response: Response, clock: DeliveryClock, keep: Keep<K>): Promise<ClickAnswer<K> | null> {
  const json = response.status === 200 && contentTypeOf(response.headers.get("Content-Type")) === "application/json";
  return json ? { payload: await textOf(response.body, clock) } : replyIn(response, clock, keep);
}

/** POSTs `payload` to `url` and has `read` read the answer, against a delivery's clock: what it came to, or how long the webhook had when it ran out of time. */
async function post<Answer>(
  url: string,
  payload: string,
  read: (response: Response, clock: DeliveryClock) => Promise<Answer>,
  { timeouts = TIMEOUTS, send = fetch }: PostOptions,
): Promise<{ status: number; answer: Answer } | { timedOutAfter: number }> {
  const target = URL.parse(url);
  if (!target || !isWebhookUrl(target)) throw new WebhookError(target?.protocol === "http:" && target.hostname ? PLAIN_HTTP : "bad URI");
  const clock = new DeliveryClock(timeouts);
  try {
    const response = await clock.race(send(target, { method: "POST", headers: HEADERS, body: payload, redirect: "manual", signal: clock.signal }));
    return { status: response.status, answer: await read(response, clock) };
  } catch (error) {
    if (clock.timedOutAfter !== null) return { timedOutAfter: clock.timedOutAfter };
    if (error instanceof WebhookError) throw error;
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new WebhookError([url, target.href].reduce((text, address) => text.replaceAll(address, "[FILTERED]"), reason));
  } finally {
    clock.stop();
  }
}

/**
 * What the bot says back in `response`, as `extract_text_from`, then `extract_attachment_from`, read it:
 * a 200's `text/html` or `text/plain` is text, and a 200 of any other type is a file, of a name and type
 * by that type, which `keep` keeps. A 200 without a type says nothing, and one whose type isn't a media
 * type fails. Any other answer says nothing, unread, since an error page or a redirect is no reply, as
 * Campfire 1.5.2 has it.
 */
async function replyIn<K>(response: Response, clock: DeliveryClock, keep: Keep<K>): Promise<Reply<K> | null> {
  if (response.status !== 200) {
    await response.body?.cancel();
    return null;
  }
  const type = contentTypeOf(response.headers.get("Content-Type"));
  if (type === "text/html" || type === "text/plain") return { text: await textOf(response.body, clock) };
  const file = type === null ? null : replyFileOf(type);
  if (!file) {
    await response.body?.cancel();
    if (type === null) return null;
    throw new WebhookError(`${JSON.stringify(type)} is not a valid MIME type`);
  }
  return { file, kept: await keptFile(response.body, clock, file, keep) };
}

/**
 * What `keep` made of the file `body` brings, named and typed as `file` says, read a part at a time
 * against `clock`. Throws a `WebhookError` once it's larger than a reply can be.
 */
async function keptFile<K>(body: ReadableStream<Uint8Array> | null, clock: DeliveryClock, { filename, contentType }: ReplyFile, keep: Keep<K>): Promise<K> {
  const reader = body?.getReader();
  const read = async () => {
    if (!reader) return null;
    const { done, value } = await clock.race(reader.read());
    return done ? null : value;
  };
  try {
    const kept = await keep({ filename, declaredType: contentType, limit: MAX_FILE_REPLY_BYTES, read });
    if (kept === null) throw new WebhookError(`the reply is larger than ${MAX_FILE_REPLY_BYTES / 1024 / 1024} MB`);
    return kept;
  } catch (error) {
    void reader?.cancel().catch(() => {});
    throw error;
  }
}

/**
 * `body` as UTF-8, with invalid bytes replaced, where Campfire's `force_encoding` keeps them, read a
 * part at a time against `clock`. Throws a `WebhookError` once it's longer than a message can be.
 */
async function textOf(body: ReadableStream<Uint8Array> | null, clock: DeliveryClock): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let [text, size] = ["", 0];
  try {
    for (let read = await clock.race(reader.read()); !read.done; read = await clock.race(reader.read())) {
      size += read.value.byteLength;
      if (size > MAX_TEXT_REPLY_BYTES) throw new WebhookError(REPLY_TOO_LONG);
      text += decoder.decode(read.value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
  text += decoder.decode();
  if (text.length > MAX_MESSAGE_HTML_LENGTH) throw new WebhookError(REPLY_TOO_LONG);
  return text;
}

const REPLY_TOO_LONG = "the reply is longer than a message can be";

/**
 * Times a delivery as Net::HTTP's timeouts do, and against a deadline: it aborts the request once the
 * webhook has gone `endpointMs` without answering or sending the next part it's asked for, or
 * `deadlineMs` have passed since it began, and says which.
 */
class DeliveryClock {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  /** How long the webhook had, once it has run out of time. */
  timedOutAfter: number | null = null;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private readonly deadline: ReturnType<typeof setTimeout>;
  private readonly aborted: Promise<never>;

  constructor(private readonly timeouts: Timeouts) {
    this.deadline = this.after(timeouts.deadlineMs);
    this.aborted = new Promise((_resolve, reject) => this.signal.addEventListener("abort", () => reject(this.signal.reason)));
    // Nothing need wait for the abort but what races it.
    this.aborted.catch(() => {});
  }

  /**
   * What `work`, waiting on the webhook, comes to, unless time runs out first. Its `endpointMs` count
   * only while it's waited on, as Net::HTTP's do, so keeping the parts it sent takes none of them.
   */
  async race<T>(work: Promise<T>): Promise<T> {
    this.quiet = this.after(this.timeouts.endpointMs);
    try {
      return await Promise.race([work, this.aborted]);
    } finally {
      clearTimeout(this.quiet);
    }
  }

  stop(): void {
    clearTimeout(this.quiet);
    clearTimeout(this.deadline);
  }

  private after(ms: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.timedOutAfter ??= ms;
      this.controller.abort();
    }, ms);
  }
}
