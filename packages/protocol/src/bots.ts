import { isReservedName, MAX_USER_NAME_LENGTH, NAME_RESERVED, type DirectoryUser, type RoomId } from "./index.ts";

// Chat bots, as administrators add, change and delete them through `/api/account/bots`, as Campfire's
// `accounts/bots` and `accounts/bots/keys` controllers do.

/**
 * Where a bot posts messages to a room and reads them, as Campfire's `room_bot_messages_path` gives it,
 * with the bot's key: `/rooms/<room id>/<bot key>/messages`, and with `threadId`, where it posts to that
 * message's thread and reads it.
 */
export const botMessagesPath = (roomId: RoomId, key: string, threadId?: string) =>
  `/rooms/${encodeURIComponent(roomId)}/${key}/messages` + (threadId === undefined ? "" : `?thread=${encodeURIComponent(threadId)}`);

/** Where a bot posts what a Slack incoming webhook is sent to a room, with the bot's key: `/rooms/<room id>/<bot key>/slack`. */
export const botSlackPath = (roomId: RoomId, key: string) => `/rooms/${encodeURIComponent(roomId)}/${key}/slack`;

/**
 * Where a bot posts what a Slack incoming webhook is sent to take the place of its message `messageId`, with
 * the bot's key: `/rooms/<room id>/<bot key>/messages/<message id>/slack`.
 */
export const botMessageSlackPath = (roomId: RoomId, key: string, messageId: string) =>
  `/rooms/${encodeURIComponent(roomId)}/${key}/messages/${encodeURIComponent(messageId)}/slack`;

/** What the bot pages and their API tell anyone but an administrator. */
export const BOTS_FORBIDDEN = "Only administrators can manage bots";

/** The longest webhook URL saved. */
export const MAX_WEBHOOK_URL_LENGTH = 2048;

/** Why a webhook URL is refused: one is delivered only to https, or to http on localhost. */
export const WEBHOOK_URL_REFUSED = "Webhook URL must be an https URL, or an http one on localhost";

/** A room a bot is in, which the bots page shows its commands for. */
export interface BotRoom {
  id: RoomId;
  name: string;
}

/** A bot as the bots page lists it: as the people directory lists it, with its key and its rooms. */
export interface Bot extends DirectoryUser {
  /** What its API's addresses carry, `<id>-<token>`, which only administrators are told. */
  key: string;
  /** The rooms it's in but its DMs, by name. */
  rooms: BotRoom[];
}

/** A bot as its edit page shows it: as the bots page lists it, with where its webhook delivers, or null for nowhere. */
export interface BotSettings extends Bot {
  webhookUrl: string | null;
}

/** What `GET /api/account/bots` answers: the active bots, by name. */
export interface Bots {
  bots: Bot[];
}

/**
 * What `GET /api/account/bots/<id>` answers, and `POST /api/account/bots`, `PATCH /api/account/bots/<id>`
 * and `PUT /api/account/bots/<id>/key`, which add a bot, change one and give one a new key.
 */
export interface BotAnswer {
  bot: BotSettings;
}

/**
 * What `PATCH /api/account/bots/<id>` changes, as the bot form saves it: the bot's name, and where its
 * webhook delivers, "" for nowhere. What's left out stays as it is.
 */
export interface BotChanges {
  name?: string;
  webhookUrl?: string;
}

/** What `POST /api/account/bots` takes, as the bot form adds one: a name, and where its webhook delivers, if anywhere. */
export interface NewBot {
  name: string;
  webhookUrl?: string;
}

/**
 * Parses an untrusted change to a bot. Returns why it's refused instead: a name has to have more than
 * spaces, and no more than a person's name can (`MAX_USER_NAME_LENGTH`). The name is saved as typed, and
 * the webhook URL trimmed, as the form's URL field sends it; the Worker checks that it's a URL.
 */
export function parseBotChanges(data: unknown): BotChanges | string {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return "Expected a JSON object";
  const { name, webhookUrl } = data as Record<string, unknown>;
  const changes: BotChanges = {};
  if (name !== undefined) {
    if (typeof name !== "string") return "Name must be text";
    if (!name.trim()) return "Name can't be blank";
    if (name.length > MAX_USER_NAME_LENGTH) return `Name can't be longer than ${MAX_USER_NAME_LENGTH} characters`;
    changes.name = name;
  }
  if (webhookUrl !== undefined) {
    if (typeof webhookUrl !== "string") return "Webhook URL must be text";
    const url = webhookUrl.trim();
    if (url.length > MAX_WEBHOOK_URL_LENGTH) return `Webhook URL can't be longer than ${MAX_WEBHOOK_URL_LENGTH} characters`;
    changes.webhookUrl = url;
  }
  return changes;
}

/**
 * Parses an untrusted new bot, as `parseBotChanges` does a change, which also needs a name, and not
 * @ember's (`isReservedName`). A bot that has that name already keeps it, so the Worker checks a new name
 * for one.
 */
export function parseNewBot(data: unknown): NewBot | string {
  const changes = parseBotChanges(data);
  if (typeof changes === "string") return changes;
  if (changes.name === undefined) return "Name can't be blank";
  return isReservedName(changes.name) ? NAME_RESERVED : { ...changes, name: changes.name };
}
