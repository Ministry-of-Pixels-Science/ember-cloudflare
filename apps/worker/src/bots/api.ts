import {
  FILE_NAME_NOT_KEPT,
  isKeepableFileName,
  MAX_FILE_SIZE,
  MAX_FILE_TYPE_LENGTH,
  MAX_MESSAGE_HTML_LENGTH,
  MESSAGE_TOO_LONG,
  threadPath,
  type Boost,
  type Message,
  type RoomId,
  type StoredFile,
  type UserId,
} from "@ember/protocol";
import { directoryOf } from "../avatar-tokens";
import { bodyUpTo } from "../bodies";
import { BLANK, EMPTY, FORBIDDEN, NOT_FOUND, type BotPage } from "../chat-room";
import { originFor } from "../custom-domain";
import type { Env } from "../env";
import { etagOf, isFresh } from "../etag";
import { objectKey, previewKey } from "../files/blobs";
import { FormError, formBoundaryOf, FormReader, isFormType } from "../files/form-parts";
import { storeArriving, withPreview } from "../files/streamed";
import { NO_STORAGE } from "../files/uploads";
import { urlOf } from "../request-url";
import type { PageCursor } from "../store";
import { workspace, type BotKeyAccess } from "../workspace";
import { botKeyParts } from "./keys";
import { railsJson } from "./rails-json";
import { payloadOf, slackMessage, slackPayloadOf, type SlackError, type SlackPayload } from "./slack";

// The bot API: a bot posts text or a file to a room it's in, and reads it, at /rooms/<room id>/<bot
// key>/messages, and edits, deletes and boosts its messages under that. The key is all a bot has, so
// these routes never read a session cookie, which leaves another site's page nothing to forge. At
// /rooms/<room id>/<bot key>/slack, a bot posts what a Slack incoming webhook is sent instead
// (slack.ts), so tools that post to Slack can post to a room, and at
// /rooms/<room id>/<bot key>/messages/<message id>/slack, what takes the place of a message it posted, as
// a bot that answers a click on its card later does (clicks.ts).

/** A room's address for bots, `room_bot_messages`, and those of its messages, their boosts and a boost, each with or without `.json`. */
const BOT_MESSAGES = /^\/rooms\/([^/.]+)\/([^/.]+)\/messages(?:\.json)?$/;
const BOT_MESSAGE = /^\/rooms\/([^/.]+)\/([^/.]+)\/messages\/([^/.]+)(?:\.json)?$/;
const BOT_BOOSTS = /^\/rooms\/([^/.]+)\/([^/.]+)\/messages\/([^/.]+)\/boosts(?:\.json)?$/;
const BOT_BOOST = /^\/rooms\/([^/.]+)\/([^/.]+)\/messages\/([^/.]+)\/boosts\/([^/.]+)(?:\.json)?$/;
/** A room's address for a bot's Slack-compatible webhook, and one of its messages' there. */
const BOT_SLACK = /^\/rooms\/([^/.]+)\/([^/.]+)\/slack$/;
const BOT_MESSAGE_SLACK = /^\/rooms\/([^/.]+)\/([^/.]+)\/messages\/([^/.]+)\/slack$/;

/** A key in a room's address for bots, as Campfire's `LogScrubbingFormatter` finds one, or in its Slack-compatible webhook's. */
const BOT_KEY_IN_PATH = /(\/rooms\/[^/\s]+\/)[^/\s]+(?=\/(?:messages|slack)\b)/g;

/**
 * The most bytes of text a bot can post: no more than `MAX_MESSAGE_HTML_LENGTH` characters, since none
 * takes more than 3 bytes of UTF-8 for each UTF-16 unit it counts as.
 */
const MAX_BODY_BYTES = 3 * MAX_MESSAGE_HTML_LENGTH;

const UNKNOWN_BOT_KEY = "Unknown bot key";
/** Why a form's `attachment` that's text posts nothing. */
const NOT_A_FILE = "An attachment has to be a file";

/** The field of a form that brings a bot's file, as `curl -F "attachment=@<path>"` sends it. */
const ATTACHMENT = "attachment";

/** `Rack::Utils::HTTP_STATUS_CODES`, for the exceptions Campfire answers here. */
const REASONS = { 400: "Bad Request", 404: "Not Found", 413: "Content Too Large", 500: "Internal Server Error" } as const;

const JSON_TYPE = "application/json; charset=utf-8";
/** How a bot may keep JSON it's answered, as Rack::ETag allows JSON with an ETag: only once it's checked it's current. */
const REVALIDATE = "max-age=0, private, must-revalidate";

/** What answers a request to a room's address for bots, if it's one the bot API takes. */
export function botAction(request: Request, env: Env, pathname: string): (() => Promise<Response>) | null {
  const { method } = request;
  const messages = pathname.match(BOT_MESSAGES);
  if (messages && method === "POST") return () => createMessage(request, env, messages[1]!, messages[2]!);
  if (messages && (method === "GET" || method === "HEAD")) return () => listMessages(request, env, messages[1]!, messages[2]!);
  const message = pathname.match(BOT_MESSAGE);
  if (message && (method === "PUT" || method === "PATCH")) return () => updateMessage(request, env, message[1]!, message[2]!, message[3]!);
  if (message && method === "DELETE") return () => deleteMessage(env, message[1]!, message[2]!, message[3]!);
  const boosts = pathname.match(BOT_BOOSTS);
  if (boosts && method === "POST") return () => createBoost(request, env, boosts[1]!, boosts[2]!, boosts[3]!);
  const boost = pathname.match(BOT_BOOST);
  if (boost && method === "DELETE") return () => deleteBoost(env, boost[1]!, boost[2]!, boost[3]!, boost[4]!);
  const slack = pathname.match(BOT_SLACK);
  if (slack && method === "POST") return () => postSlackMessage(request, env, slack[1]!, slack[2]!);
  const slackMessage = pathname.match(BOT_MESSAGE_SLACK);
  if (slackMessage && (method === "POST" || method === "PUT" || method === "PATCH")) return () => replaceWithSlackMessage(request, env, slackMessage[1]!, slackMessage[2]!, slackMessage[3]!);
  return null;
}

/** Whether `pathname` is one of the bot API's addresses, whose failures answer JSON. */
export const isBotPath = (pathname: string) => [BOT_MESSAGES, BOT_MESSAGE, BOT_BOOSTS, BOT_BOOST, BOT_SLACK, BOT_MESSAGE_SLACK].some((route) => route.test(pathname));

/** `text` with every bot key in an address `[FILTERED]`, as Campfire's log lines have them. */
export const withoutBotKeys = (text: string) => text.replace(BOT_KEY_IN_PATH, "$1[FILTERED]");

/** An exception. */
export const exception = (status: keyof typeof REASONS) =>
  new Response(JSON.stringify({ status, error: REASONS[status] }), { status, headers: { "Content-Type": "application/json; charset=UTF-8" } });

/** `head status`, an empty answer. */
const head = (status: number) => new Response(null, { status, headers: { "Content-Type": "text/html" } });

/** What a key that names no active bot answers. */
const unknownKey = () => Response.json({ error: UNKNOWN_BOT_KEY }, { status: 401 });

/** What a request the room can't take answers: 422 with why. */
const unprocessable = (reason: string) => Response.json({ error: reason }, { status: 422 });

/** What a form answers without an R2 bucket bound as FILES, as a browser's upload does. */
const noStorage = () => Response.json({ error: NO_STORAGE }, { status: 503 });

/**
 * The bot the key segment `key` names, if it's in room `roomId`, as `set_room` finds the room, with when
 * the Workspace checked, or what the request answers otherwise: 401 unless the key is an active bot's
 * own, and an empty 404 when the bot isn't in the room.
 */
async function botIn(env: Env, roomId: RoomId, key: string): Promise<BotKeyAccess | Response> {
  const access = await botAccessIn(env, roomId, key);
  if (!access) return unknownKey();
  return access === "not found" ? head(404) : access;
}

/** The bot the key segment `key` names in room `roomId`, as `botIn` finds it: null unless it's an active bot's key, and "not found" when the bot isn't in the room. */
async function botAccessIn(env: Env, roomId: RoomId, key: string): Promise<BotKeyAccess | "not found" | null> {
  const parts = botKeyParts(segmentText(key));
  return parts && workspace(env).botInRoom(parts.botId, parts.token, roomId);
}

/** A path segment as Rails reads it, or "" for malformed percent-encoding, which names nothing. */
function segmentText(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

/**
 * `POST /rooms/<room id>/<bot key>/messages`: posts the request's body, whatever its type, as the bot's
 * message, as `create` posts `raw_request_body`, or the file a form sends as `attachment`, answering 201
 * with where the message is. With `?thread=<message id>`, as the address a delivery of a reply in a
 * thread gives (webhooks.ts), it goes in that message's thread, or answers an empty 404 when the room has
 * no such thread.
 */
async function createMessage(request: Request, env: Env, roomId: RoomId, key: string): Promise<Response> {
  const access = await botIn(env, roomId, key);
  if (access instanceof Response) return access;
  const threadId = present(urlOf(request).searchParams.get("thread"));
  const formAnswer = await withForm(request, (form) => createFileMessage(request, env, roomId, key, access, form, threadId));
  if (formAnswer) return formAnswer;
  const markup = await bodyText(request);
  if (markup === null) return exception(413);
  // The key is checked again once the whole body is here, which arrives as slowly as its sender likes:
  // long enough for the bot to be deleted, given a new key or taken out of the room since the check
  // above, which only spares reading the body of a request that can't post.
  const arrived = await botIn(env, roomId, key);
  if (arrived instanceof Response) return arrived;
  // `raw_request_body.blank?`: empty or only spaces.
  if (markup.trim() === "") return head(422);
  const created = await env.CHAT_ROOM.getByName(roomId).createBotMessage(roomId, arrived, markup, [], threadId);
  if (!created) return head(404);
  if (typeof created === "string") return unprocessable(created);
  return createdAt(request, arrived, created);
}

/**
 * `POST /rooms/<room id>/<bot key>/slack`: posts what a Slack incoming webhook is sent, its JSON or a form's
 * `payload`, as the bot's message, as `slackMessage` reads it, and answers as Slack's webhooks do: `ok`, or
 * what's wrong in their words.
 */
async function postSlackMessage(request: Request, env: Env, roomId: RoomId, key: string): Promise<Response> {
  const access = await slackBotIn(env, roomId, key);
  if (access instanceof Response) return access;
  const payload = await slackPayloadIn(request);
  if (payload instanceof Response) return payload;
  // Again now the body has arrived, as `createMessage` checks text.
  const arrived = await slackBotIn(env, roomId, key);
  if (arrived instanceof Response) return arrived;
  const message = slackMessage(payload, arrived.takesClicks);
  if (typeof message === "string") return slackAnswer(400, message);
  const created = await env.CHAT_ROOM.getByName(roomId).createBotMessage(roomId, arrived, message.markup, message.cards);
  if (!created) return slackAnswer(404, "channel_not_found");
  if (typeof created === "string") return slackAnswer(400, slackReason(created));
  return slackAnswer(200, "ok");
}

/**
 * `POST`, `PUT` or `PATCH /rooms/<room id>/<bot key>/messages/<id>/slack`: puts what a Slack incoming webhook
 * is sent in the place of the bot's own message, its text and its cards, as a click's answer does, or, with
 * `delete_original`, deletes the message, and answers as `postSlackMessage` does, in the words of Slack's
 * `chat.update` for a message the room doesn't have or that's someone else's.
 */
async function replaceWithSlackMessage(request: Request, env: Env, roomId: RoomId, key: string, messageId: string): Promise<Response> {
  const access = await slackBotIn(env, roomId, key);
  if (access instanceof Response) return access;
  const payload = await slackPayloadIn(request);
  if (payload instanceof Response) return payload;
  // Again now the body has arrived, as `createMessage` checks text.
  const arrived = await slackBotIn(env, roomId, key);
  if (arrived instanceof Response) return arrived;
  const room = env.CHAT_ROOM.getByName(roomId);
  const message = payload.delete_original === true ? null : slackMessage(payload, arrived.takesClicks);
  if (typeof message === "string") return slackAnswer(400, message);
  const refused = message ? await room.editBotMessage(roomId, arrived, messageId, message.markup, message.cards) : await room.deleteBotMessage(roomId, arrived, messageId);
  if (refused === NOT_FOUND) return slackAnswer(404, "message_not_found");
  if (refused === FORBIDDEN) return slackAnswer(403, "cant_update_message");
  return typeof refused === "string" ? slackAnswer(400, slackReason(refused)) : slackAnswer(200, "ok");
}

/**
 * The bot `key` names, if it's in room `roomId`, as `botIn` finds it, or what Slack's webhooks answer
 * otherwise: 403 `invalid_token` unless the key is an active bot's, and 404 `channel_not_found` when the bot
 * isn't in the room.
 */
async function slackBotIn(env: Env, roomId: RoomId, key: string): Promise<BotKeyAccess | Response> {
  const access = await botAccessIn(env, roomId, key);
  if (!access) return slackAnswer(403, "invalid_token");
  return access === "not found" ? slackAnswer(404, "channel_not_found") : access;
}

/**
 * The payload a Slack webhook's request brings, its body or its multipart form's `payload` field, or what it
 * answers: 413 for more than a message's markup can be, and 400 `invalid_payload` for no payload.
 */
async function slackPayloadIn(request: Request): Promise<SlackPayload | Response> {
  const text = await bodyText(request);
  if (text === null) return slackAnswer(413, "msg_too_long");
  const type = request.headers.get("Content-Type");
  const payload = isFormType(type) ? await formPayloadOf(text, type!) : slackPayloadOf(text);
  return payload ?? slackAnswer(400, "invalid_payload");
}

/** The payload in the `payload` field of the multipart form `text`, of type `type`, or null when it has none. */
async function formPayloadOf(text: string, type: string): Promise<SlackPayload | null> {
  let field: File | string | null;
  try {
    field = (await new Response(text, { headers: { "Content-Type": type } }).formData()).get("payload");
  } catch {
    return null;
  }
  return payloadOf(typeof field === "string" ? field : ((await field?.text()) ?? null));
}

/** Slack's words for why the room keeps nothing of a message. */
const slackReason = (reason: string): SlackError => (reason === MESSAGE_TOO_LONG ? "msg_too_long" : reason === EMPTY ? "no_text" : "invalid_payload");

/** What Slack's webhooks answer, `ok` or what's wrong, as text. */
const slackAnswer = (status: number, text: string) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/** What posting `message` answers: 201 with where it is, at Ember's address. */
const createdAt = (request: Request, { customDomain }: BotKeyAccess, message: Message) =>
  new Response(null, { status: 201, headers: { Location: permalink(originFor(request, customDomain), message), "Content-Type": JSON_TYPE } });

/**
 * Posts the file `form` sends as `attachment` as the bot's message, answering as a post of text does. A
 * form with no file posts nothing, an empty 422.
 */
async function createFileMessage(request: Request, env: Env, roomId: RoomId, key: string, access: BotKeyAccess, form: FormReader, threadId?: string): Promise<Response> {
  const attachment = await attachmentIn(form);
  if (attachment?.kind !== "file") return attachment?.kind === "text" ? unprocessable(NOT_A_FILE) : head(422);
  const created = await postFile(env, roomId, key, access, form, attachment, undefined, threadId);
  if (created instanceof Response) return created;
  return typeof created === "string" ? head(404) : createdAt(request, access, created);
}

/**
 * `PUT` or `PATCH /rooms/<room id>/<bot key>/messages/<id>`: replaces the text of the bot's own message
 * with the request's body, as `update` does, or its file with the one a form sends as `attachment`,
 * answering the message as the list has it.
 */
async function updateMessage(request: Request, env: Env, roomId: RoomId, key: string, messageId: string): Promise<Response> {
  const access = await botIn(env, roomId, key);
  if (access instanceof Response) return access;
  const formAnswer = await withForm(request, (form) => updateFileMessage(request, env, roomId, key, access, form, messageId));
  if (formAnswer) return formAnswer;
  const markup = await bodyText(request);
  if (markup === null) return exception(413);
  // Again now the body has arrived, as `createMessage` checks it.
  const arrived = await botIn(env, roomId, key);
  if (arrived instanceof Response) return arrived;
  const edited = await env.CHAT_ROOM.getByName(roomId).editBotMessage(roomId, arrived, messageId, markup);
  if (edited === NOT_FOUND) return exception(404);
  if (edited === FORBIDDEN) return head(403);
  if (typeof edited === "string") return unprocessable(edited);
  return renderedMessage(request, env, arrived, edited);
}

/**
 * Gives the bot's message `messageId` the file `form` sends as `attachment`, in place of the one it had,
 * or takes its file away when `attachment` is text with nothing in it, answering as an edit of its text
 * does. A form with no `attachment` changes nothing, an empty 422.
 */
async function updateFileMessage(request: Request, env: Env, roomId: RoomId, key: string, access: BotKeyAccess, form: FormReader, messageId: string): Promise<Response> {
  const attachment = await attachmentIn(form);
  if (!attachment) return head(422);
  if (attachment.kind === "text") return unprocessable(NOT_A_FILE);
  const updated = attachment.kind === "file" ? await postFile(env, roomId, key, access, form, attachment, messageId) : await removeFile(env, roomId, key, messageId);
  if (updated instanceof Response) return updated;
  if (typeof updated === "string") return updated === FORBIDDEN ? head(403) : exception(404);
  return renderedMessage(request, env, access, updated);
}

/** `message` as the list writes it, answered as `render :show` does. */
async function renderedMessage(request: Request, env: Env, { customDomain }: BotKeyAccess, message: Message): Promise<Response> {
  const [json] = await messagesJson(env, originFor(request, customDomain), [message]);
  return rendered(json, 200);
}

/** `DELETE /rooms/<room id>/<bot key>/messages/<id>`: deletes the bot's own message, as `destroy` does. */
async function deleteMessage(env: Env, roomId: RoomId, key: string, messageId: string): Promise<Response> {
  const access = await botIn(env, roomId, key);
  if (access instanceof Response) return access;
  const refusal = await env.CHAT_ROOM.getByName(roomId).deleteBotMessage(roomId, access, messageId);
  if (refusal === NOT_FOUND) return exception(404);
  if (refusal === FORBIDDEN) return head(403);
  return new Response(null, { status: 204 });
}

/**
 * `POST /rooms/<room id>/<bot key>/messages/<id>/boosts`: boosts a message in the room with the
 * request's body, as `create` does there, answering 201 with the boost.
 */
async function createBoost(request: Request, env: Env, roomId: RoomId, key: string, messageId: string): Promise<Response> {
  let access = await botIn(env, roomId, key);
  if (access instanceof Response) return access;
  const content = await bodyText(request);
  if (content === null) return exception(413);
  // Again now the body has arrived, as `createMessage` checks it.
  access = await botIn(env, roomId, key);
  if (access instanceof Response) return access;
  const boost = await env.CHAT_ROOM.getByName(roomId).addBotBoost(roomId, access, messageId, content);
  if (boost === NOT_FOUND) return head(404);
  // `raw_request_body.blank?`, checked once the message is found.
  if (boost === BLANK) return head(422);
  if (typeof boost === "string") return unprocessable(boost);
  return rendered(await boostJson(env, originFor(request, access.customDomain), roomId, boost), 201);
}

/**
 * `DELETE /rooms/<room id>/<bot key>/messages/<id>/boosts/<boost id>`: removes the bot's own boost on the
 * message, as `destroy` does there, or answers an empty 404.
 */
async function deleteBoost(env: Env, roomId: RoomId, key: string, messageId: string, boostId: string): Promise<Response> {
  const access = await botIn(env, roomId, key);
  if (access instanceof Response) return access;
  const removed = await env.CHAT_ROOM.getByName(roomId).removeBotBoost(roomId, access, messageId, boostId);
  return removed ? new Response(null, { status: 204 }) : head(404);
}

/** A form's `attachment` field, as Rack reads it: a file, which the form reads next, text with nothing in it, or other text. */
type Attachment = { kind: "file"; filename: string; contentType: string | null } | { kind: "nothing" } | { kind: "text" };

/**
 * The form's `attachment`, as Rack reads a form `curl -F` sends, which is its first such field here, or
 * null when it has none. A file input left empty sends a file without a name, which Rack leaves out.
 */
async function attachmentIn(form: FormReader): Promise<Attachment | null> {
  for (let part = await form.next(); part; part = await form.next()) {
    if (part.name !== ATTACHMENT || part.filename === "") continue;
    if (part.filename !== null) return { kind: "file", filename: part.filename, contentType: part.contentType };
    return (await form.read()) === null ? { kind: "nothing" } : { kind: "text" };
  }
  return null;
}

/**
 * What `answer` makes of the form the request sends, which it reads as it arrives, or null when it sends
 * none. A form that can't be read is 400, as Rack answers a malformed form, and so is one whose type
 * names no boundary to read it by, as when its sender set the type itself, its parts' headers and bytes
 * and all. What isn't read of a form is never read.
 */
async function withForm(request: Request, answer: (form: FormReader) => Promise<Response>): Promise<Response | null> {
  const type = request.headers.get("Content-Type");
  const boundary = formBoundaryOf(type);
  if (boundary === null) return isFormType(type) ? exception(400) : null;
  const form = new FormReader(request.body, boundary);
  try {
    return await answer(form);
  } catch (error) {
    if (error instanceof FormError) return exception(400);
    throw error;
  } finally {
    form.cancel();
  }
}

/**
 * Has the room post the file `form` is reading, `attachment`, as the bot's message, in the thread
 * `threadId` names if it names one, or with `messageId` give it to the bot's message in place of its file,
 * R2 keeping it as it arrives, a part at a time, as a browser's upload is, since a form can bring more
 * than a Worker can hold. Answers the message, why the room took nothing, as `finishBotUpload` says, or
 * what the request answers otherwise: 413 for a file larger than a browser can upload, and 422 for a name
 * too long to keep. Without an R2 bucket bound as FILES, it answers 503, as a browser's upload does.
 */
async function postFile(
  env: Env,
  roomId: RoomId,
  key: string,
  access: BotKeyAccess,
  form: FormReader,
  { filename, contentType }: { filename: string; contentType: string | null },
  messageId?: string,
  threadId?: string,
): Promise<Message | string | Response> {
  const files = env.FILES;
  if (!files) return noStorage();
  if (!isKeepableFileName(filename)) return unprocessable(FILE_NAME_NOT_KEPT);
  // A type no browser could give a file only says what it is as much as an empty one does.
  const declaredType = contentType !== null && contentType.length <= MAX_FILE_TYPE_LENGTH ? contentType : "";
  const file = { filename, declaredType, limit: MAX_FILE_SIZE, read: () => form.read() };
  const room = env.CHAT_ROOM.getByName(roomId);
  const started = await room.startBotUpload(roomId, access, file, messageId);
  if (typeof started === "string") return started;
  const stored = await storeArriving(files, objectKey(started.key), file);
  if (!stored) return exception(413);
  const kept = { key: started.key, file: await withPreview(env, files, started.key, filename, stored) };
  // Again now the file has arrived, as `createMessage` checks text.
  const arrived = await botIn(env, roomId, key);
  const finished = arrived instanceof Response ? arrived : await room.finishBotUpload(roomId, arrived, kept, messageId, threadId);
  // A file that isn't posted goes from R2 at once, since a room deleted meanwhile had R2 delete its files
  // before this one was there. The room's alarm forgets the upload, as it does a browser's never finished.
  if (finished instanceof Response || typeof finished === "string") await files.delete([objectKey(started.key), previewKey(started.key)]);
  return finished;
}

/** Takes the file away from the bot's message `messageId`, once the form has arrived, as `removeBotFile` does. */
async function removeFile(env: Env, roomId: RoomId, key: string, messageId: string): Promise<Message | string | Response> {
  // Again now the form has arrived, as `createMessage` checks text.
  const access = await botIn(env, roomId, key);
  if (access instanceof Response) return access;
  return env.CHAT_ROOM.getByName(roomId).removeBotFile(roomId, access, messageId);
}

/**
 * The request's body as UTF-8, with invalid bytes replaced as `raw_request_body` replaces them, or null
 * when it's longer than a message's markup can be.
 */
async function bodyText(request: Request): Promise<string | null> {
  const text = await bodyUpTo(request, MAX_BODY_BYTES);
  return text !== null && text.length <= MAX_MESSAGE_HTML_LENGTH ? text : null;
}

/**
 * `GET /rooms/<room id>/<bot key>/messages`: a page of the room's messages as JSON, oldest first, as
 * `index` answers it: the newest 40, or the 40 before the message `?before` names or after the one
 * `?after` does, with how many the room has in `X-Total-Count` and a `Link` to the next page when the
 * room has more beyond this one. A message deleted but kept for its thread's replies has nothing to
 * read, so the page leaves it out, though the room still counts it and pages from it. A reply that wasn't
 * also sent to the room isn't on the page, as it isn't in the room's timeline: `?thread` reads its thread
 * (`listThread`).
 */
async function listMessages(request: Request, env: Env, roomId: RoomId, key: string): Promise<Response> {
  const access = await botIn(env, roomId, key);
  if (access instanceof Response) return access;
  const url = urlOf(request);
  const thread = present(url.searchParams.get("thread"));
  if (thread !== undefined) return listThread(request, env, roomId, access, thread);
  const cursor = { before: present(url.searchParams.get("before")), after: present(url.searchParams.get("after")) };
  const page = await env.CHAT_ROOM.getByName(roomId).botPage(roomId, cursor);
  if (!page) return exception(404);

  const origin = originFor(request, access.customDomain);
  const body = railsJson(await messagesJson(env, origin, page.messages.filter((message) => !message.deleted)));
  const etag = await etagOf(body);
  const headers = new Headers({ "X-Total-Count": String(page.total), ETag: etag, "Cache-Control": REVALIDATE });
  const next = nextPage(page, cursor);
  if (next) headers.set("Link", `<${origin}/rooms/${roomId}/${key}/messages?${next}>; rel="next"`);
  if (isFresh(request, etag)) return new Response(null, { status: 304, headers });
  headers.set("Content-Type", JSON_TYPE);
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

/**
 * `GET /rooms/<room id>/<bot key>/messages?thread=<message id>`: the thread of that message as JSON, the
 * message first and then its newest 40 replies, oldest first, as the room's messages are written, so a
 * bot that answered in a thread can read what's been said there since. 404 when the room has no such
 * message or it's a reply, which has no thread.
 */
async function listThread(request: Request, env: Env, roomId: RoomId, access: BotKeyAccess, parentId: string): Promise<Response> {
  const messages = await env.CHAT_ROOM.getByName(roomId).botThread(roomId, parentId);
  if (!messages) return exception(404);
  const origin = originFor(request, access.customDomain);
  const body = railsJson(await messagesJson(env, origin, messages.filter((message) => !message.deleted)));
  const etag = await etagOf(body);
  const headers = new Headers({ ETag: etag, "Cache-Control": REVALIDATE });
  if (isFresh(request, etag)) return new Response(null, { status: 304, headers });
  headers.set("Content-Type", JSON_TYPE);
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

/** `value` as the bot API writes JSON, answered with `status` as Rack::ETag sends a 200 or 201: with its ETag. */
async function rendered(value: unknown, status: 200 | 201): Promise<Response> {
  const body = railsJson(value);
  return new Response(body, { status, headers: { "Content-Type": JSON_TYPE, ETag: await etagOf(body), "Cache-Control": REVALIDATE } });
}

/** A parameter as Rails reads a `present?` one: absent when it's missing or blank. */
const present = (value: string | null) => (value === null || value.trim() === "" ? undefined : value);

/**
 * Where the next page starts, as `set_pagination_headers` says: when `after` was asked for, even with
 * `before`, after the page's last message, and otherwise before its first, if the room has any there.
 */
function nextPage({ messages, hasMore, hasNewer }: BotPage, { after }: PageCursor): string | null {
  if (messages.length === 0) return null;
  if (after !== undefined) return hasNewer ? `after=${messages.at(-1)!.id}` : null;
  return hasMore ? `before=${messages[0]!.id}` : null;
}

/**
 * Messages as `messages/_message.json.jbuilder` writes them, in its order of keys, each with its writer
 * as they are now and its addresses on `origin`, Ember's address (`originFor`), and a file message with
 * its file after its body, which Campfire leaves out.
 */
async function messagesJson(env: Env, origin: string, messages: Message[]) {
  const writers = await peopleJson(env, origin, messages.map(({ creator }) => creator.id));
  return messages.map((message) => ({
    id: message.id,
    created_at: message.createdAt,
    // `message.body.to_s`, in Ember's layout for rich text, with mentions and link previews as they're
    // stored, or nothing for a file message, which has no rich text.
    body: { plain_text: message.plainText, html: message.body === "" ? "" : `<div class="lexxy-content">\n  ${message.body}\n</div>\n` },
    ...(message.attachment && { attachment: attachmentJson(origin, message.attachment) }),
    // Nobody is ever deleted, so everyone who wrote a message is there.
    creator: writers.get(message.creator.id)!,
    room: { id: message.roomId },
    url: permalink(origin, message),
  }));
}

/**
 * A message's file as Active Storage names a blob's columns, at its address on `origin`, which is signed
 * and opens the file for whoever has it, as the room's links do, so the bot fetches it without its key.
 */
const attachmentJson = (origin: string, { name, contentType, byteSize, url }: StoredFile) => ({
  filename: name,
  content_type: contentType,
  byte_size: byteSize,
  url: `${origin}${url}`,
});

/**
 * A boost in room `roomId` as `messages/boosts/_boost.json.jbuilder` writes it, in its order of keys, with
 * its booster as they are now and its message's address on `origin`.
 */
async function boostJson(env: Env, origin: string, roomId: RoomId, boost: Boost) {
  const boosters = await peopleJson(env, origin, [boost.booster.id]);
  return {
    id: boost.id,
    content: boost.content,
    created_at: boost.createdAt,
    booster: boosters.get(boost.booster.id)!,
    message: { id: boost.messageId, url: permalink(origin, { roomId, id: boost.messageId }) },
  };
}

/** The people `ids` names, by id, as `users/_user.json.jbuilder` writes them, with their avatars' addresses on `origin`. */
async function peopleJson(env: Env, origin: string, ids: UserId[]) {
  const people = await directoryOf(await workspace(env).directoryEntries([...new Set(ids)]), env.SESSION_SECRET);
  return new Map(people.map(({ id, name, role, avatarUrl }) => [id, { id, name, role, avatar_url: `${origin}${avatarUrl}` }]));
}

/** A message's address on `origin`: its permalink, which opens its room at it, or a reply's thread at it. */
const permalink = (origin: string, { roomId, id, parentId }: Pick<Message, "roomId" | "id" | "parentId">) =>
  origin + (parentId === undefined ? `/rooms/${roomId}/@${id}` : threadPath(roomId, parentId, id));
