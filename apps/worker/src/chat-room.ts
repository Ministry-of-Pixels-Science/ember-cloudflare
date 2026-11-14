import { DurableObject } from "cloudflare:workers";
import {
  ASSISTANT_ID,
  CloseCode,
  HISTORY_PAGE_SIZE,
  isMessageTooLong,
  MAX_BOOST_LENGTH,
  MAX_MESSAGE_HTML_LENGTH,
  MESSAGE_TOO_LONG,
  parseClientFrame,
  parseRoomSocketParams,
  ROOM_PROTOCOL,
  type Boost,
  type Card,
  type CardAction,
  type ClientFrame,
  type LinkPreview,
  type Message,
  type NewUpload,
  type RoomId,
  type ServerFrame,
  type TimelinePage,
  type User,
  type UserId,
} from "@ember/protocol";
import { parseHuddleSocketParams } from "@ember/protocol/huddles";
import { prepareBody, userIdFromSgid, userIdsIn, type PreparedBody } from "@ember/richtext";
import {
  AGENT_NOTES,
  AnswerError,
  answerOf,
  NOTES,
  PICKED_MODEL_NOTES,
  previewAttachment,
  questionFor,
  readable,
  ROOM_MESSAGES_READ,
  THREAD_REPLIES_READ,
  waitFor,
  writtenBy,
  type Answer,
} from "./assistant/answers";
import { askWaiting, goOn, type Answered, type Asking, type GatewayRefusal } from "./assistant/gateway";
import { takesEmbersTools } from "./assistant/offered";
import { roomSearch } from "./assistant/room-search";
import { ToolError } from "./assistant/tool-calls";
import { saidCard, toolCallOf, toolCards, type CardCall } from "./apps/cards";
import {
  appTool,
  callCard,
  callDecisionOf,
  CALL_OUTCOMES,
  calledFromCard,
  givenAs,
  givenTools,
  ToolGone,
  usedCard,
  type GivenTool,
  type PickedTool,
  type ShowsCall,
  type ShowsCard,
  type Unmade,
} from "./apps/tools";
import { CALL_WAITS_MS, fits, WaitingCalls, type WaitingCall } from "./apps/waiting-calls";
import { JobQueue } from "./at-once";
import { actingButton, clickPayload } from "./bots/clicks";
import { payloadOf, slackMessage, type SlackMessage, type SlackPayload } from "./bots/slack";
import { postClick, postWebhook, WebhookError, webhookPayload, type ClickAnswer, type Reply } from "./bots/webhooks";
import { keptCards } from "./cards";
import { Courier, ENTRIES_PER_CALL } from "./courier";
import { openDb, type Db } from "./db";
import type { Env } from "./env";
import { attachedFile, Blobs, objectKey, previewKey, type Identified, type RoomBlob, type UploadedPart } from "./files/blobs";
import type { ImageSize } from "./files/images";
import { storeArriving, withPreview, type ArrivingFile, type StreamedFile } from "./files/streamed";
import { NO_STORAGE, type Uploader } from "./files/uploads";
import { Huddle, HUDDLE_CHECK_MS, HUDDLE_TAG } from "./huddles/room";
import { base36, sortableId } from "./ids";
import { sendPushes } from "./push/delivery";
import { urlOf } from "./request-url";
import { addressTag, EVERYONE, REVOCATIONS_KEPT_MS, Revocations, sessionTag, type Revocation } from "./revocations";
import { RoomLog, type RoomEvent } from "./room-log";
import { searchIndex } from "./search-index";
import { CLOSE_REASONS, closedAtOnce, closeTooLarge, isTooLarge, MAX_ROOM_FRAME_SIZE, RESERVED_CLOSE_CODES } from "./sockets";
import { MessageStore, type Deletion, type InThread, type PageCursor, type PostedFile, type StoredBody } from "./store";
import { unfurler } from "./unfurl";
import { viewersOf, type Viewing } from "./viewing";
import { workspace, type AssistantAccess, type BotAccess, type OutsideSender, type WebhookAccess } from "./workspace";
import type { AssistantAsk, MessagePush, MessageWebhook } from "./workspace-store";

/** What each socket remembers across hibernation. */
interface Attachment extends Viewing {
  roomId: RoomId;
  /** The revision of the room protocol its tab speaks, as its address said. Absent on sockets let in before the room asked. */
  protocol?: number;
  /** Set once the room has closed the socket for a revocation, which announced that it left. */
  revoked?: true;
  /** Set when a ban blocks the IP address the socket comes from: it can read, but not change anything. */
  banned?: true;
  /** Set while the tab is typing, from its typing.start until its typing.stop or message, so closing it stops only typing it did. */
  typing?: true;
}

export const USER_HEADER = "X-Ember-User";
export const ROOM_HEADER = "X-Ember-Room";
export const SESSION_HEADER = "X-Ember-Session";
/** When the Workspace checked the socket's session and membership, in milliseconds since the epoch. */
export const AUTHORIZED_AT_HEADER = "X-Ember-Authorized-At";
/** The IP address the socket comes from, which the room tags it with, so banning the address can find it. */
export const ADDRESS_HEADER = "X-Ember-Address";
/** "true" when a ban blocks the IP address the socket comes from. */
export const BANNED_HEADER = "X-Ember-Banned";
/** "true" on a socket for the room's huddle, rather than for the room itself. */
export const HUDDLE_HEADER = "X-Ember-Huddle";

/** What a deleted room's object keeps in its own storage until its alarm: the room's id, whose records the alarm erases. */
const DELETED_ROOM = "deletedRoom";
/** What a room's object keeps in its own storage while its alarm is to send its logs: the room's id. */
const UNDELIVERED_ROOM = "undeliveredRoom";
/**
 * What it keeps beside that: when the logs are to be sent, since while a huddle goes on the alarm rings
 * sooner than that, to check the huddle.
 */
const LOGS_DUE = "logsDue";

/** Why the room keeps nothing of a message: it couldn't show it, or there's nothing in it. `MESSAGE_TOO_LONG` says when there's too much. */
const UNREADABLE = "That message couldn't be saved.";
export const EMPTY = "Your message is empty.";
/** Why the room changes nothing of a bot's message with cards that a person edits, as the editor can't hold a card. */
const HAS_CARDS = "Messages with cards can't be edited.";
/** What the room tells a tab running an app older than its protocol, whose messages and edits it refuses. */
const OUTDATED = "Ember has been updated. Reload the page to keep chatting.";
/**
 * What the room tells a socket from a banned IP address that tries to change something, as the app says
 * of the 429 the Worker answers such a request with.
 */
const BANNED = "Request failed (429)";
/** The frames that change something, which a banned address's sockets can't send. */
const CHANGES = new Set<ClientFrame["type"]>(["message.create", "message.update", "message.delete", "boost.create", "boost.delete", "card.click"]);
/** Whether `ws`'s tab runs an app older than the room protocol. */
const isOutdated = (ws: WebSocket) => ((ws.deserializeAttachment() as Attachment).protocol ?? 1) < ROOM_PROTOCOL;

/** Keeps in `ws`'s attachment whether its tab is typing, writing it only when that changes. */
function markTyping(ws: WebSocket, typing: boolean): void {
  const attachment = ws.deserializeAttachment() as Attachment;
  if ((attachment.typing === true) === typing) return;
  const { typing: _, ...rest } = attachment;
  ws.serializeAttachment((typing ? { ...rest, typing: true } : rest) satisfies Attachment);
}

/** A page of a room's messages as the bot API reads it, with how many messages the room has. */
export interface BotPage extends Omit<TimelinePage, "around"> {
  total: number;
}

/** A file R2 has all of for the room, which it's to post: its key, and what it came to as it arrived. */
export interface KeptFile {
  key: string;
  file: StreamedFile;
}

/** How `ChatRoom.create` posts a message: as a reply, which goes to no bot, as a bot's to a webhook delivery is, with a file, or in a thread. */
interface Posting {
  kind?: "message" | "reply";
  posted?: PostedFile;
  inThread?: InThread;
}

/** What the room answers a bot that names a message it doesn't have. */
export const NOT_FOUND = "not found";
/** What the room answers a bot that names someone else's message, which it can't change. */
export const FORBIDDEN = "forbidden";
/** What the room answers a bot whose boost has nothing in it. */
export const BLANK = "blank";
/** Why the room keeps no reply in a thread whose message it no longer has. */
export const MESSAGE_GONE = "That message no longer exists";
/** Why the room keeps no longer boost. */
const BOOST_TOO_LONG = `Boosts can be up to ${MAX_BOOST_LENGTH} characters.`;

/**
 * How many of a room's deliveries to bots' webhooks run at once, and how many more can wait.
 */
const WEBHOOKS_AT_ONCE = 2;
const WEBHOOKS_WAITING = 1024;

/** Why a delivery sends nothing: the Workspace finds no webhook for its bot in the room now. */
const NO_WEBHOOK = "the bot has been deleted, has left the room or has no webhook";
/** Why the room posts nothing of what a bot says back: it was deleted or left the room, or its webhook changed, while the delivery ran. */
const WEBHOOK_CHANGED = "the bot has been deleted, has left the room or its webhook has changed";
/** Why the room posts nothing of what a bot says back to a reply in a thread: the thread's message was deleted while the delivery ran. */
const THREAD_GONE = "the thread's message has been deleted";

/** How many clicks on bots' buttons each person can have waiting in a room, so that no one fills its webhook queue. */
const CLICKS_WAITING_EACH = 3;
/** Why a click goes nowhere: its message, or the button on it, went before the click's turn came. */
const BUTTON_GONE = "That button is no longer there";
const TOO_MANY_CLICKS = "Wait for your earlier clicks to be answered";
const WEBHOOKS_FULL = "Too much is waiting for bots here. Try again in a moment.";
/** What whoever clicked is told when the click's delivery fails without saying why. */
const CLICK_FAILED = "That click couldn't be delivered";

/** Why a click came to nothing: what the room tells whoever clicked, and what it logs. */
class ClickError extends WebhookError {
  constructor(
    readonly told: string,
    logged: string,
  ) {
    super(logged);
  }
}

/** A click on a button that acts, as a socket sends it. */
type CardClick = Extract<ClientFrame, { type: "card.click" }>;

/** The button `click` says was clicked, as a card names one. */
const clickedIn = ({ actionId, blockId, value }: CardClick): CardAction => ({ id: actionId, blockId, value });

/** How many of a room's questions for @ember and the agents it answers at once, and how many more can wait, as each waits on a model. */
const ANSWERS_AT_ONCE = 4;
const ANSWERS_WAITING = 100;

/** How often @ember says again that it's typing while it answers, as apps forget typing they haven't heard of for 5 seconds. */
const TYPING_AGAIN_MS = 3_000;

/** Why the room posts nothing for a question for @ember: Ember AI was turned off, or @ember taken out of the room. */
const ASSISTANT_GONE = "Ember AI has been turned off, or @ember is no longer in the room";
/** Why it posts nothing for a question for an agent: Ember AI was turned off, or the agent deleted or taken out of the room. */
const AGENT_GONE = "Ember AI has been turned off, or the agent has been deleted or is no longer in the room";

/** Why the room posts nothing for a question for the bot `botId`, @ember or an agent, which is no longer there to answer. */
const answererGone = (botId: UserId) => (botId === ASSISTANT_ID ? ASSISTANT_GONE : AGENT_GONE);

/** Who answers as the bot `botId`, as the room's logs name them: Ember AI, as @ember, or an agent, by its id. */
const answererOf = (botId: UserId) => (botId === ASSISTANT_ID ? "Ember AI" : `Agent ${botId}`);

/**
 * What @ember or an agent says to a question: its model's answer, or the note saying why it has none, the
 * pages the answer came from, if it used the web, and what people wrote in the conversation it read
 * (`writtenBy`).
 */
interface Said extends Pick<Answered, "text" | "sources"> {
  written?: string[];
}

/** What a question comes to: what its answerer says, or the call of an app's tool its answer waits at, with the apps' tools its model was given. */
type Outcome = Said | { asking: Asking; given: GivenTool[] };

/** What the room tells whoever clicks a call's card that isn't waiting any more, as someone answered it first. */
const CALL_ANSWERED = "Someone has answered that already";
/** What it tells them once the call waited too long to be allowed. */
const CALL_LATE = "That waited too long to be allowed. Ask again";
/** What it tells them while the room has no turn left for the answer to go on in. */
const ROOM_BUSY = "Too many questions are waiting for answers in this room. Try again in a moment";
/** What it tells whoever clicks a button of a tool's card while another click on the card is being answered. */
const CARD_BUSY = "That card is answering another click. Try again in a moment";
/** The most characters of why a click's call came to nothing that whoever clicked is told, as an app's server may write it. */
const MAX_TOLD_LENGTH = 300;

/** What whoever clicked is told of `why` a click's call came to nothing, as a model would be told: without what says so to a model, and cut short. */
const toldOf = (why: string) => {
  const told = why.replace(/^Not run: /, "");
  return told.length > MAX_TOLD_LENGTH ? `${told.slice(0, MAX_TOLD_LENGTH - 1)}…` : told;
};

/** The names of the tools of the app `appId` among `picked`, an answerer's. */
const toolsOf = (picked: readonly PickedTool[], appId: string) => new Set(picked.filter((tool) => tool.appId === appId).map(({ name }) => name));
/** What an answerer says when its model isn't the one that made the call that waited. */
const MODEL_CHANGED = "I can't go on from that call: my model was changed while it waited. Ask me again.";
/** What an answerer says, by its tool's app, when what it has read is too much to keep while a call waits. */
const tooMuchToWait = (app: string) => `I wanted to use ${app}, but this conversation is too long for me to wait while someone allows it. Ask me again in a new thread.`;

/** How long an Active Storage key is: `MINIMUM_TOKEN_LENGTH`. */
const KEY_LENGTH = 28;

/**
 * How many messages deleting the room deletes in each write, and has the search index forget in each
 * call, so that a large room holds up neither the rooms sharing D1 or the index for long, nor fails for
 * its size each time it's tried. A page of history's worth.
 */
export const MESSAGES_DELETED_AT_ONCE = 100;

/** How long an upload may go unfinished, after which the room deletes what R2 has of it. */
export const UNFINISHED_UPLOAD_KEPT_MS = 24 * 60 * 60 * 1000;

/** How long a deleted room waits to erase itself again when R2 couldn't delete its files. */
const ERASE_RETRY_MS = 5 * 60 * 1000;

/** What sends each of a room's logs (see `couriersFor`). */
interface Couriers {
  /** Sends the Workspace the room's events, which it marks the room unread and read by. */
  workspace: Courier;
  /** Sends the search index the messages written, edited, boosted and deleted. */
  index: Courier;
  /** Has R2 delete the files the room has marked deleted. */
  files: Courier;
}

/**
 * One chat room: its WebSockets, who is present and typing, and its messages.
 * Uses the hibernation API, so an idle room costs nothing while sockets stay open.
 */
export class ChatRoom extends DurableObject<Env> {
  private db: Db | null = null;
  private store: MessageStore | null = null;
  private revocations: Revocations | null = null;
  private log: RoomLog | null = null;
  private blobs: Blobs | null = null;
  private waitingCalls: WaitingCalls | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private couriers: Couriers | null = null;
  /** Whether the alarm has erased the room, whose storage no longer says it was deleted. */
  private erased = false;
  private readonly webhooks = new JobQueue(WEBHOOKS_AT_ONCE, WEBHOOKS_WAITING);
  /** How many clicks each person has waiting on bots' webhooks. */
  private readonly clicking = new Map<UserId, number>();
  private readonly answers = new JobQueue(ANSWERS_AT_ONCE, ANSWERS_WAITING);
  /** The tools' cards a click's call is being made for, by their messages' ids: one at a time each, as what it answers takes the card's place. */
  private readonly calling = new Set<string>();
  /** How many jobs each bot is typing for, by its id and the thread it's typing in, if it's in one. */
  private readonly typists = new Map<string, number>();
  /**
   * Who has read the room since its latest message, as far as this object has seen. Only a new message
   * in the room marks it unread, so until one comes another read of theirs would change nothing, and
   * isn't logged.
   */
  private readonly readers = new Set<UserId>();
  /**
   * Who was viewing the room as each of its new messages in the room came, by the message's id, until its
   * event goes to the Workspace. Someone who saw a message come in has seen it, though they may have left
   * the room by the time the Workspace hears of it. Kept in memory only: a message the object restarted
   * since is judged by who's viewing as it's sent, as before.
   */
  private readonly seenBy = new Map<string, UserId[]>();
  /** The room's huddle, whose sockets it keeps beside the room's own. */
  private readonly huddle: Huddle;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeats are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    this.huddle = new Huddle(ctx, env, (time) => this.serially(() => this.checkHuddleBy(time)));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const user = JSON.parse(request.headers.get(USER_HEADER) ?? "null") as User | null;
    const roomId = request.headers.get(ROOM_HEADER);
    const sessionId = request.headers.get(SESSION_HEADER);
    const authorizedAt = Number(request.headers.get(AUTHORIZED_AT_HEADER) ?? NaN);
    if (!user || !roomId || !sessionId || !Number.isFinite(authorizedAt)) return new Response("Missing user, room, session or time", { status: 400 });
    const address = request.headers.get(ADDRESS_HEADER);
    const banned = request.headers.get(BANNED_HEADER) === "true";
    const tags = [user.id, sessionTag(sessionId), ...(address ? [addressTag(address)] : [])];
    if (request.headers.get(HUDDLE_HEADER) === "true") {
      // A banned address reads the room and changes nothing in it, and the Worker turns it away from the huddle.
      if (banned) return closedAtOnce(CloseCode.NotFound);
      return this.joinHuddle(user, roomId, tags, authorizedAt, parseHuddleSocketParams(urlOf(request).searchParams).muted);
    }
    const { visible, since, around, protocol } = parseRoomSocketParams(urlOf(request).searchParams);

    return this.serially(async () => {
      // Read side by side, so a room that has just woken waits on D1 once.
      const [refused, opening] = await Promise.all([this.revocationsFor(roomId).refuse(tags, authorizedAt), this.opening(roomId, since, around)]);
      if (refused) return closedAtOnce(CloseCode.Reconnect);
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, tags);
      server.serializeAttachment({ user, roomId, visible, protocol, heardAt: Date.now(), ...(banned && { banned }) } satisfies Attachment);

      this.send(server, { ...opening, you: user, present: this.present() });
      // A tab running an older app hears at once that it has to reload, rather than once it sends something.
      if (protocol < ROOM_PROTOCOL) this.send(server, { type: "error", message: OUTDATED });
      // Everyone else has the list from their own welcome, so they only hear who's new.
      if (!this.isPresent(user.id, server)) this.broadcast({ type: "presence.joined", user }, server);
      const couriers = this.couriersFor(roomId);
      // Opening the room in a shown tab reads it, which sends the Workspace the log. Logged next,
      // rather than before the socket is let in, so the welcome doesn't wait on it.
      if (visible) void this.serially(() => this.read(roomId, user.id)).catch((error) => console.error("Could not log a read", error));
      // Otherwise the first socket since the object started sends whatever a restart left in the log.
      else if (!couriers.workspace.checked) couriers.workspace.deliver();
      // And the search index's, which nothing else here sends, and the files to delete.
      if (!couriers.index.checked) couriers.index.deliver();
      if (!couriers.files.checked) couriers.files.deliver();
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  /**
   * Lets `user` into the room's huddle on a socket of its own, which carries the tags a socket of the
   * room's does, so whatever ends their access to the room takes them out of its huddle. Like one of the
   * room's, it's turned away when the Workspace's word for it is too old, or older than a revocation.
   */
  private joinHuddle(user: User, roomId: RoomId, tags: string[], authorizedAt: number, muted: boolean): Promise<Response> {
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse(tags, authorizedAt)) return closedAtOnce(CloseCode.Reconnect);
      const response = await this.huddle.join(user, roomId, tags, muted);
      if (this.huddle.live) await this.checkHuddleBy(Date.now() + HUDDLE_CHECK_MS);
      return response;
    });
  }

  /**
   * What a socket starts with: what changed since `since`, the latest change its tab has seen, if it
   * names one and the room keeps every change after it, or else a welcome's page, which is the one
   * around the message `around` names, for a tab opened at its permalink, or the newest.
   */
  private async opening(roomId: RoomId, since: number | undefined, around: string | undefined) {
    const store = this.storeFor(roomId);
    const changes = since === undefined ? null : await store.changesSince(since);
    if (changes) return { type: "resumed" as const, ...changes };
    return { type: "welcome" as const, ...(await store.opening(HISTORY_PAGE_SIZE, around)) };
  }

  /** Resolves once the room's messages can be read. */
  async health(roomId: RoomId): Promise<void> {
    await this.serially(() => this.storeFor(roomId).page(1));
  }

  /**
   * Closes the sockets each of `revocations` names here, with its code, once the Workspace has saved
   * the change that ended their access, and turns away their sockets that it let through at or
   * before `revokedAt`, which may have been checked before the change. Queued behind the events
   * before it, so a socket it was opening is closed too. Whoever loses their last socket here leaves
   * at once, rather than when their app answers the close, which it may never do.
   */
  async revoke(roomId: RoomId, revocations: Revocation[], revokedAt: number): Promise<void> {
    await this.serially(async () => {
      await this.revocationsFor(roomId).record(
        revocations.map(({ tag }) => tag),
        revokedAt,
      );
      const deletion = revocations.find(({ tag }) => tag === EVERYONE);
      if (deletion) return this.destroy(roomId, deletion.code);
      const leaving = new Map<UserId, User>();
      for (const { tag, code } of revocations) {
        for (const socket of this.ctx.getWebSockets(tag)) {
          if (this.huddle.has(socket)) {
            this.huddle.remove(socket, code);
            continue;
          }
          const user = this.close(socket, code);
          if (user) leaving.set(user.id, user);
        }
      }
      for (const user of leaving.values()) this.depart(user);
    });
  }

  /**
   * Closes every socket in a room the Workspace has deleted, with `code`, its huddle's among them, which
   * the SFU stops carrying, and deletes its messages, with their files, and has the search index forget
   * them, each `MESSAGES_DELETED_AT_ONCE` at a time. Nobody is left to hear who leaves. The record that
   * the room was deleted stays, turning away sockets let through before then, until none of those could
   * still arrive, when the alarm erases it. A failure has the Workspace ask again, which goes on from
   * the batch that failed.
   */
  private async destroy(roomId: RoomId, code: CloseCode): Promise<void> {
    this.huddle.end(code, true);
    for (const socket of this.roomSockets()) this.close(socket, code);
    while (await this.storeFor(roomId).deleteMessages(MESSAGES_DELETED_AT_ONCE));
    await this.logFor(roomId).forget();
    await this.waitingCallsFor(roomId).forget();
    while (await searchIndex(this.env).forget(roomId, MESSAGES_DELETED_AT_ONCE));
    await this.ctx.storage.put(DELETED_ROOM, roomId);
    await this.ctx.storage.setAlarm(Date.now() + REVOCATIONS_KEPT_MS);
    this.couriersFor(roomId).files.deliver();
  }

  /**
   * Erases what's left of a deleted room, once R2 has deleted its files. Otherwise, checks the room's
   * huddle, and comes back to check it while one goes on, and sends the room's logs. While a huddle
   * goes on, the alarm rings far more often than a log that failed is sent again, so the logs wait
   * until they're due.
   */
  override async alarm(): Promise<void> {
    const [deleted, undelivered, logsDue] = await this.serially(() =>
      Promise.all([this.ctx.storage.get<RoomId>(DELETED_ROOM), this.ctx.storage.get<RoomId>(UNDELIVERED_ROOM), this.ctx.storage.get<number>(LOGS_DUE)]),
    );
    if (deleted !== undefined) return this.erase(deleted);
    const nextCheck = await this.huddle.check().catch((error: unknown) => {
      console.error("Checking the room's huddle failed:", error instanceof Error ? error.name : "unknown error");
      return Date.now() + HUDDLE_CHECK_MS;
    });
    const logsWait = nextCheck !== null && logsDue !== undefined && logsDue > Date.now();
    if (undelivered !== undefined && !logsWait) await this.sendLogs(undelivered);
    // Logs that waited are due before the huddle's next check, or after it. Logs just sent have set the alarm for whatever is left of them.
    if (nextCheck !== null) await this.serially(() => this.checkHuddleBy(logsWait ? Math.min(nextCheck, logsDue) : nextCheck));
  }

  /**
   * Sends room `roomId`'s logs, which a call that failed left, or which `reindex` filled, and has R2
   * delete the files the room has marked deleted, and the uploads a day old that are still unfinished,
   * coming back for the next of those once it's a day old. Forgets the calls of apps' tools that waited
   * too long to be allowed, too, coming back for the next of those once it has.
   */
  private async sendLogs(roomId: RoomId): Promise<void> {
    // Whatever is left to send after this says when it's due.
    await this.serially(() => this.ctx.storage.delete(LOGS_DUE));
    const couriers = this.couriersFor(roomId);
    await Promise.all([couriers.workspace.retry(), couriers.index.retry(), couriers.files.retry()]);
    // Whatever the couriers came to, so that a call is forgotten in time while a delivery keeps failing.
    const nextLateCall = await this.forgetLateCalls(roomId);
    // Kept until then, so an alarm cut off as it sends, as a deploy can do, sends the rest when it's
    // retried. A courier whose last call failed has set the alarm again, for its next try, which comes
    // sooner for a call that will have waited too long by then.
    if (couriers.workspace.failing || couriers.index.failing || couriers.files.failing) {
      if (nextLateCall !== null) await this.wakeAt(roomId, nextLateCall);
      return;
    }
    // Looked for and forgotten in one turn, so that a call that starts to wait meanwhile, or an upload
    // that starts, which each set the alarm, isn't left without it.
    const next = await this.serially(async () => {
      const [unfinished, lateCall] = await Promise.all([this.blobsFor(roomId).oldestUnfinished(), this.waitingCallsFor(roomId).nextLate()]);
      const next = Math.min(unfinished === null ? Infinity : Date.parse(unfinished) + UNFINISHED_UPLOAD_KEPT_MS, lateCall ?? Infinity);
      if (next === Infinity) await this.ctx.storage.delete(UNDELIVERED_ROOM);
      return next;
    });
    if (next !== Infinity) await this.wakeAt(roomId, next);
  }

  /**
   * Erases what's left of deleted room `roomId` once R2 has deleted its files: its revocations, and the
   * object's own storage, which on DO SQLite is everything it kept. An object with nothing stored ceases
   * to exist. Until R2 has, the alarm tries again later, since the room's record of its files goes too.
   */
  private async erase(roomId: RoomId): Promise<void> {
    const { workspace, index, files } = this.couriersFor(roomId);
    await files.retry();
    if (files.failing) return this.ctx.storage.setAlarm(Date.now() + ERASE_RETRY_MS);
    // A call still out would read its log once the tables are gone, which makes them again.
    await Promise.all([workspace.settled(), index.settled()]);
    await this.serially(async () => {
      await this.revocationsFor(roomId).forget();
      await this.ctx.storage.deleteAll();
      // Its tables went too, so anything after this would open the database afresh, making them again.
      this.db = this.store = this.revocations = this.log = this.blobs = this.waitingCalls = null;
      this.erased = true;
    });
  }

  /**
   * Deletes up to `limit` of `userId`'s messages here, with their boosts, telling everyone in the room
   * of each, and answers whether any of theirs are left. Once the ban has been lifted, at `liftedAt`,
   * only those written by then count.
   */
  async removeMessagesBy(roomId: RoomId, userId: UserId, limit: number, liftedAt: string | null): Promise<boolean> {
    return this.serially(async () => {
      const store = this.storeFor(roomId);
      const ids = await store.messageIdsBy(userId, limit + 1, liftedAt);
      const removed = ids.slice(0, limit);
      if (removed.length === 0) return false;
      this.broadcastDeletion(await store.delete(removed));
      const couriers = this.couriersFor(roomId);
      couriers.index.deliver();
      couriers.files.deliver();
      return ids.length > limit;
    });
  }

  /**
   * Has the search index take every message the room has afresh, as the Workspace asks of each room
   * once the index is new: logs them all for it, and has the alarm send them, which a restart can't
   * stop.
   */
  async reindex(roomId: RoomId): Promise<void> {
    await this.serially(() => this.logFor(roomId).reindex());
    await this.wakeAt(roomId, Date.now());
  }

  /**
   * The messages `ids` names, for search results, leaving out any the room no longer has: the search
   * index can name one deleted since it last heard from the room.
   */
  async messagesWithIds(roomId: RoomId, ids: string[]): Promise<Message[]> {
    return this.serially(() => this.storeFor(roomId).withIds(ids));
  }

  /** Everyone who wrote or reacted in the room, for the Workspace to keep when it registers a legacy room. */
  async authors(roomId: RoomId): Promise<User[]> {
    return this.serially(() => this.storeFor(roomId).authors());
  }

  /**
   * Posts `markup` as a message from the bot the Workspace let in: as a socket's message.create does,
   * with a client message id of its own, as Campfire gives one (`Random.uuid`, message.rb), and with
   * `cards` under its text, as a Slack incoming webhook's attachments show, and with `threadId` in that
   * message's thread, only there, as a reply to a delivery goes. Answers the message, why the room keeps
   * nothing of it, or null once the room has heard that the bot's access ended, or the room was deleted,
   * after the Workspace checked, as it turns away a socket then, or when it has no such thread.
   */
  async createBotMessage(roomId: RoomId, { bot, authorizedAt }: BotAccess, markup: string, cards: Card[] = [], threadId?: string): Promise<Message | string | null> {
    return this.serially(async () => {
      const now = new Date().toISOString();
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return null;
      const store = this.storeFor(roomId);
      const inThread = threadId === undefined ? undefined : await this.inThread(store, threadId, false);
      if (inThread === null) return null;
      const body = await this.prepareWithCards(markup, cards);
      if (typeof body === "string") return body;
      return this.create(store, bot, crypto.randomUUID(), body, now, { inThread });
    });
  }

  /**
   * Posts `markup` as a message from the person an AI app is connected as (`outside/tools`), whom the
   * Workspace found in the room: as their socket's message.create does, in the thread of the message
   * `threadId` names, only there, if it names one, but as a reply is posted, which goes to no bot. So
   * an app calls neither a webhook, @ember nor an agent, even in a direct message with one, where a
   * message needs no mention to. Answers the message, why the room keeps nothing of it, `MESSAGE_GONE`
   * when it has no such thread, or null once the room has heard that they were taken out of it, or it
   * was deleted, after the Workspace checked, as it turns away a socket then.
   */
  async createOutsideMessage(roomId: RoomId, { user, authorizedAt }: OutsideSender, markup: string, threadId?: string): Promise<Message | string | null> {
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse([user.id], authorizedAt)) return null;
      const store = this.storeFor(roomId);
      const inThread = threadId === undefined ? undefined : await this.inThread(store, threadId, false);
      if (inThread === null) return MESSAGE_GONE;
      const body = await this.prepare(markup);
      if (typeof body === "string") return body;
      return this.create(store, user, crypto.randomUUID(), body, new Date().toISOString(), { kind: "reply", inThread });
    });
  }

  /**
   * A page of the room's messages for the bot API: the page `cursor` names, with how many messages the
   * room has, or null when the cursor isn't one of them.
   */
  async botPage(roomId: RoomId, cursor: PageCursor): Promise<BotPage | null> {
    return this.serially(async () => {
      const store = this.storeFor(roomId);
      const [page, total] = await Promise.all([store.pageAt(cursor, HISTORY_PAGE_SIZE), store.count()]);
      return page && { ...page, total };
    });
  }

  /**
   * A page of the room's messages for an AI app that reads it as someone in it (`outside/tools`): the
   * page `cursor` names, or null when the cursor isn't one of them. The room isn't counted, as it is for
   * a bot, since on D1 counting reads a row for every message.
   */
  async outsidePage(roomId: RoomId, cursor: PageCursor): Promise<Omit<TimelinePage, "around"> | null> {
    return this.serially(() => this.storeFor(roomId).pageAt(cursor, HISTORY_PAGE_SIZE));
  }

  /**
   * The thread of the message `parentId` names, for a bot or an AI app reading the room: the message and
   * its newest replies, oldest first, or null when the room has no such message or it's a reply, which
   * has no thread.
   */
  async botThread(roomId: RoomId, parentId: string): Promise<Message[] | null> {
    return this.serially(async () => {
      const { parent, messages } = await this.storeFor(roomId).thread(parentId, HISTORY_PAGE_SIZE);
      return parent && [parent, ...messages];
    });
  }

  /**
   * Replaces the text of the bot's message `messageId` with `markup`, and its cards with `cards`: as a
   * socket's message.update does, answering the message as it is now. Answers `NOT_FOUND` when the room
   * turns the bot away, as `createBotMessage` does, or has no such message, `FORBIDDEN` when it's someone
   * else's, then why the room keeps nothing of `markup` and `cards`.
   */
  async editBotMessage(roomId: RoomId, { bot, authorizedAt }: BotAccess, messageId: string, markup: string, cards: Card[] = []): Promise<Message | string> {
    return this.serially(async () => {
      const now = new Date().toISOString();
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return NOT_FOUND;
      const store = this.storeFor(roomId);
      const message = await this.botsOwn(store, bot, messageId);
      if (typeof message === "string") return message;
      const body = await this.prepareWithCards(markup, cards);
      return typeof body === "string" ? body : this.edit(store, message, body, now);
    });
  }

  /**
   * Deletes the bot's message `messageId`, with its boosts: as a socket's message.delete does, answering
   * null, or `NOT_FOUND` when the room turns the bot away, as `createBotMessage` does, or has no such
   * message, and `FORBIDDEN` when it's someone else's.
   */
  async deleteBotMessage(roomId: RoomId, { bot, authorizedAt }: BotAccess, messageId: string): Promise<string | null> {
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return NOT_FOUND;
      const store = this.storeFor(roomId);
      const message = await this.botsOwn(store, bot, messageId);
      if (typeof message === "string") return message;
      await this.deleteMessage(store, message);
      return null;
    });
  }

  /**
   * Adds the bot's boost of `content`, trimmed, to the message `messageId`: as a socket's boost.create
   * does, but even when the bot has added the same one, as there, answering it. Answers `NOT_FOUND` when
   * the room turns the bot away, as `createBotMessage` does, or has no such message, then `BLANK` when
   * `content` is only spaces, or why the room keeps no boost of it.
   */
  async addBotBoost(roomId: RoomId, { bot, authorizedAt }: BotAccess, messageId: string, content: string): Promise<Boost | string> {
    return this.serially(async () => {
      const now = new Date().toISOString();
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return NOT_FOUND;
      const store = this.storeFor(roomId);
      if (!(await this.findUndeleted(store, messageId))) return NOT_FOUND;
      const trimmed = content.trim();
      if (trimmed === "") return BLANK;
      if (trimmed.length > MAX_BOOST_LENGTH) return BOOST_TOO_LONG;
      return this.addBoost(store, messageId, bot, trimmed, now);
    });
  }

  /**
   * Removes the bot's boost `boostId` from the message `messageId`: as a socket's boost.delete does,
   * answering whether it did, which it does only when the boost is the bot's own, on that message, and
   * the room doesn't turn the bot away, as `createBotMessage` does.
   */
  async removeBotBoost(roomId: RoomId, { bot, authorizedAt }: BotAccess, messageId: string, boostId: string): Promise<boolean> {
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return false;
      const store = this.storeFor(roomId);
      const boost = await store.findBoost(boostId);
      if (!boost || boost.messageId !== messageId || boost.booster.id !== bot.id) return false;
      await this.removeBoost(store, boost);
      return true;
    });
  }

  /**
   * Starts `uploader`'s upload of `file` to the room, as a reply in the thread it names if it names one,
   * answering the file's key, or null once the room has heard that their access ended, or the room was
   * deleted, after the Workspace checked, as it turns away a socket then, or `MESSAGE_GONE` when it has
   * no such thread. The alarm comes back once it's a day old, to delete it from R2 if it's unfinished.
   */
  async startUpload(roomId: RoomId, uploader: Uploader, file: NewUpload): Promise<{ key: string } | typeof MESSAGE_GONE | null> {
    const startedAt = Date.now();
    const started = await this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse(uploader.tags, uploader.authorizedAt)) return null;
      if (file.parentId !== undefined && !(await this.inThread(this.storeFor(roomId), file.parentId, false))) return MESSAGE_GONE;
      const key = base36(KEY_LENGTH);
      const blob = {
        id: key,
        uploaderId: uploader.user.id,
        filename: file.name,
        contentType: file.type,
        byteSize: file.size,
        clientMessageId: file.clientMessageId,
        parentId: file.parentId ?? null,
        alsoSent: file.alsoSend === true,
      };
      await this.blobsFor(roomId).create(blob, new Date(startedAt).toISOString());
      return { key };
    });
    if (typeof started === "object" && started) await this.wakeAt(roomId, startedAt + UNFINISHED_UPLOAD_KEPT_MS);
    return started;
  }

  /** `uploaderId`'s upload `key` to the room, as far as it has come, or null if they have no such upload. */
  async uploadOf(roomId: RoomId, uploaderId: UserId, key: string): Promise<RoomBlob | null> {
    return this.serially(async () => {
      const blob = await this.blobsFor(roomId).find(key);
      return blob?.uploaderId === uploaderId ? blob : null;
    });
  }

  /**
   * Records what the first part of `uploader`'s upload `key`, in more than one part, says the file is,
   * with the multipart upload R2 has started and the part it has, unless another request has recorded
   * its own first part, answering the upload as it is then. Answers null when the room turns the uploader
   * away, as `startUpload` does, or they have no such upload.
   */
  async identifyUpload(roomId: RoomId, uploader: Uploader, key: string, identified: Identified, multipartUploadId: string, part: UploadedPart): Promise<RoomBlob | null> {
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse(uploader.tags, uploader.authorizedAt)) return null;
      const blobs = this.blobsFor(roomId);
      const blob = await blobs.find(key);
      if (blob?.uploaderId !== uploader.user.id) return null;
      return (await blobs.identify(key, identified, multipartUploadId, part)) ?? blob;
    });
  }

  /**
   * Records `part` of `uploader`'s upload `key` in more than one part, answering the upload as it is
   * then, or null as `identifyUpload` answers it, or when the upload hasn't started in R2.
   */
  async recordUploadPart(roomId: RoomId, uploader: Uploader, key: string, part: UploadedPart): Promise<RoomBlob | null> {
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse(uploader.tags, uploader.authorizedAt)) return null;
      const blobs = this.blobsFor(roomId);
      const blob = await blobs.find(key);
      if (blob?.uploaderId !== uploader.user.id || blob.multipartUploadId === null) return null;
      return blob.completedAt ? blob : blobs.recordPart(blob, part);
    });
  }

  /**
   * Records that `uploader`'s upload `key` has a preview of `size`, unless the room has posted the file
   * already, answering the upload as it is then, or null as `identifyUpload` answers it.
   */
  async recordUploadPreview(roomId: RoomId, uploader: Uploader, key: string, size: ImageSize): Promise<RoomBlob | null> {
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse(uploader.tags, uploader.authorizedAt)) return null;
      return this.blobsFor(roomId).recordPreview(key, uploader.user.id, size);
    });
  }

  /**
   * Posts `uploader`'s upload `key`, which R2 has all of, as their message: records that the upload has
   * finished, what its one part said the file is when `identified` says, and the message, in one
   * transaction, then tells everyone in the room and sends the Workspace and the search index their
   * logs, as for any new message, in the thread the upload was started in, if it was. Answers the message,
   * with whether this posted it, or the message an earlier request posted it as, which was, unless it's
   * been deleted since. Answers null when the room turns the uploader away, as `startUpload` does, or they
   * have no such upload, and `MESSAGE_GONE` when the room no longer has its thread.
   */
  async finishUpload(roomId: RoomId, uploader: Uploader, key: string, identified?: Identified): Promise<{ message: Message; posted: boolean } | typeof MESSAGE_GONE | null> {
    return this.serially(async () => {
      const now = new Date().toISOString();
      if (await this.revocationsFor(roomId).refuse(uploader.tags, uploader.authorizedAt)) return null;
      const blobs = this.blobsFor(roomId);
      const blob = await blobs.find(key);
      if (blob?.uploaderId !== uploader.user.id) return null;
      const store = this.storeFor(roomId);
      if (blob.completedAt) {
        const message = blob.messageId === null ? null : await store.find(blob.messageId);
        return message && { message, posted: false };
      }
      const inThread = blob.parentId === null ? undefined : await this.inThread(store, blob.parentId, blob.alsoSent);
      if (inThread === null) return MESSAGE_GONE;
      const posted: PostedFile = { file: attachedFile(blob, identified), finished: (messageId) => blobs.finished(key, messageId, now, identified) };
      return { message: await this.postFile(store, uploader.user, blob, posted, now, { inThread }), posted: true };
    });
  }

  /**
   * Starts the bot's upload of a file named `filename`, of `declaredType` as it says, to the room, for a
   * form that brings it to R2 as it arrives, as `startUpload` starts someone's, or, with `messageId`, one
   * to give the bot's message in place of its file. Answers the file's key, or `NOT_FOUND` when the room
   * turns the bot away, as `createBotMessage` does, or has no such message, and `FORBIDDEN` when it's
   * someone else's.
   */
  async startBotUpload(
    roomId: RoomId,
    { bot, authorizedAt }: BotAccess,
    file: Pick<ArrivingFile, "filename" | "declaredType">,
    messageId?: string,
  ): Promise<{ key: string } | typeof NOT_FOUND | typeof FORBIDDEN> {
    const startedAt = Date.now();
    const started = await this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return NOT_FOUND;
      const message = messageId === undefined ? null : await this.botsOwn(this.storeFor(roomId), bot, messageId);
      if (message === NOT_FOUND || message === FORBIDDEN) return message;
      return { key: await this.startArriving(roomId, bot.id, file, startedAt) };
    });
    if (typeof started === "object") await this.wakeAt(roomId, startedAt + UNFINISHED_UPLOAD_KEPT_MS);
    return started;
  }

  /**
   * Posts the bot's file `key`, which R2 has all of, as it came to in `file`, as the bot's message,
   * recording that its upload has finished and the message in one transaction, as `finishUpload` does.
   * With `messageId`, gives it to the bot's message in place of the file that had, as `update` does, and
   * otherwise posts it in the thread `threadId` names, if it names one, as `createBotMessage` posts text.
   * Answers the message, or `NOT_FOUND` when the room turns the bot away, as `createBotMessage` does, or
   * has no such upload, message or thread, and `FORBIDDEN` when the message is someone else's.
   */
  async finishBotUpload(roomId: RoomId, { bot, authorizedAt }: BotAccess, { key, file }: KeptFile, messageId?: string, threadId?: string): Promise<Message | string> {
    return this.serially(async () => {
      const now = new Date().toISOString();
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return NOT_FOUND;
      const blob = await this.blobsFor(roomId).find(key);
      if (blob?.uploaderId !== bot.id) return NOT_FOUND;
      const store = this.storeFor(roomId);
      if (messageId === undefined) {
        const inThread = threadId === undefined ? undefined : await this.inThread(store, threadId, false);
        if (inThread === null) return NOT_FOUND;
        return this.postFile(store, bot, blob, this.streamed(roomId, blob, file, now), now, { inThread });
      }
      const message = await this.botsOwn(store, bot, messageId);
      return typeof message === "string" ? message : this.attach(store, message, this.streamed(roomId, blob, file, now), now);
    });
  }

  /**
   * Takes the file away from the bot's message `messageId`, answering the message as it is now, or
   * `NOT_FOUND` or `FORBIDDEN` as `editBotMessage` does. A message without a file stays as it was.
   */
  async removeBotFile(roomId: RoomId, { bot, authorizedAt }: BotAccess, messageId: string): Promise<Message | string> {
    return this.serially(async () => {
      const now = new Date().toISOString();
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return NOT_FOUND;
      const store = this.storeFor(roomId);
      const message = await this.botsOwn(store, bot, messageId);
      if (typeof message === "string" || !message.attachment) return message;
      return this.attach(store, message, null, now);
    });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (this.huddle.has(ws)) return this.huddle.message(ws, raw);
    if (isTooLarge(raw, MAX_ROOM_FRAME_SIZE)) return closeTooLarge(ws);
    const frame = typeof raw === "string" ? parseClientFrame(raw) : null;
    if (!frame) return this.send(ws, { type: "error", message: "Unrecognized frame" });

    const { user, roomId } = ws.deserializeAttachment() as Attachment;
    await this.serially(async () => {
      // A socket the room has closed, as when its access was revoked, can't change anything, even
      // with frames it sent before it heard.
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        await this.handle(ws, user, this.storeFor(roomId), frame);
      } catch (error) {
        console.error("ChatRoom frame failed", frame.type, error);
        const clientMessageId = frame.type === "message.create" ? frame.clientMessageId : undefined;
        const clientMessageIds = frame.type === "message.check" ? frame.clientMessageIds : undefined;
        const clickId = frame.type === "card.click" ? frame.clickId : undefined;
        this.send(ws, { type: "error", message: "Something went wrong", clientMessageId, clientMessageIds, clickId, failed: frame.type });
      }
    });
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(RESERVED_CLOSE_CODES.has(code) ? 1000 : code, "Closing");
    if (this.huddle.has(ws)) return this.huddle.left(ws);
    await this.serially(async () => this.leave(ws));
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    if (this.huddle.has(ws)) return this.huddle.left(ws);
    await this.serially(async () => this.leave(ws));
  }

  /**
   * Runs one event at a time. Durable Object storage holds other events back while it works,
   * but D1 queries are network calls that don't, so without this a joining socket could get
   * live frames before its snapshot, or an edit could broadcast reactions it read too early.
   */
  private serially<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  private async handle(ws: WebSocket, user: User, store: MessageStore, frame: ClientFrame): Promise<void> {
    const now = new Date().toISOString();
    if (CHANGES.has(frame.type) && (ws.deserializeAttachment() as Attachment).banned) {
      const clientMessageId = frame.type === "message.create" ? frame.clientMessageId : undefined;
      const clickId = frame.type === "card.click" ? frame.clickId : undefined;
      return this.send(ws, { type: "error", message: BANNED, clientMessageId, clickId, failed: frame.type });
    }

    switch (frame.type) {
      case "message.create": {
        if (isOutdated(ws)) return this.send(ws, { type: "error", message: OUTDATED, clientMessageId: frame.clientMessageId, failed: frame.type });
        const inThread = frame.parentId === undefined ? undefined : await this.inThread(store, frame.parentId, frame.alsoSend === true);
        if (inThread === null) return this.send(ws, { type: "error", message: MESSAGE_GONE, clientMessageId: frame.clientMessageId, failed: frame.type });
        const body = await this.prepare(frame.body);
        if (typeof body === "string") return this.send(ws, { type: "error", message: body, clientMessageId: frame.clientMessageId, failed: frame.type });
        await this.create(store, user, frame.clientMessageId, body, now, { inThread });
        // Everyone else takes the message as its author's stop.
        markTyping(ws, false);
        return;
      }
      case "message.update": {
        const message = await this.findUndeleted(store, frame.messageId);
        if (!message || !(await this.canAdminister(user, message))) return this.refuse(ws, "You can only edit your own messages");
        if (isOutdated(ws)) return this.send(ws, { type: "error", message: OUTDATED, failed: frame.type });
        if (message.cards) return this.send(ws, { type: "error", message: HAS_CARDS, failed: frame.type });
        const body = await this.prepare(frame.body);
        if (typeof body === "string") return this.send(ws, { type: "error", message: body, failed: frame.type });
        await this.edit(store, message, body, now);
        return;
      }
      case "message.delete": {
        const message = await this.findUndeleted(store, frame.messageId);
        if (!message || !(await this.canAdminister(user, message))) return this.refuse(ws, "You can only delete your own messages");
        return this.deleteMessage(store, message);
      }
      case "boost.create": {
        const message = await this.findUndeleted(store, frame.messageId);
        if (!message) return this.refuse(ws, "That message no longer exists");
        // A person adds each reaction once, so one they've already added is a repeated click.
        if (message.boosts.some((b) => b.booster.id === user.id && b.content === frame.content)) return;
        await this.addBoost(store, frame.messageId, user, frame.content, now);
        return;
      }
      case "boost.delete": {
        const boost = await store.findBoost(frame.boostId);
        if (!boost || boost.booster.id !== user.id) return this.refuse(ws, "You can only remove your own reactions");
        return this.removeBoost(store, boost);
      }
      case "typing.start":
      case "typing.stop": {
        const typing = frame.type === "typing.start";
        markTyping(ws, typing);
        return this.broadcast({ type: "typing", user, typing }, ws);
      }
      case "history.before": {
        const { messages, hasMore } = await store.page(frame.limit ?? HISTORY_PAGE_SIZE, frame.before);
        return this.send(ws, { type: "history", before: frame.before, messages, hasMore });
      }
      case "history.after": {
        const { messages, hasNewer } = await store.after(frame.limit ?? HISTORY_PAGE_SIZE, frame.after);
        return this.send(ws, { type: "history.after", after: frame.after, messages, hasNewer });
      }
      case "history.around":
        return this.send(ws, { type: "history.around", ...(await store.timeline(HISTORY_PAGE_SIZE, frame.messageId)) });
      case "message.check": {
        const stored = await store.storedClientMessageIds(user, frame.clientMessageIds);
        const missing = frame.clientMessageIds.filter((id) => !stored.includes(id));
        return this.send(ws, { type: "message.checked", stored, missing });
      }
      case "thread.open": {
        const attachment = ws.deserializeAttachment() as Attachment;
        ws.serializeAttachment({ ...attachment, thread: frame.parentId } satisfies Attachment);
        return this.send(ws, { type: "thread.opened", parentId: frame.parentId, ...(await store.thread(frame.parentId, HISTORY_PAGE_SIZE)) });
      }
      case "thread.close": {
        const { thread, ...attachment } = ws.deserializeAttachment() as Attachment;
        if (thread === frame.parentId) ws.serializeAttachment(attachment satisfies Attachment);
        return;
      }
      case "thread.before": {
        const { messages, hasMore } = await store.repliesBefore(frame.parentId, frame.before, frame.limit ?? HISTORY_PAGE_SIZE);
        return this.send(ws, { type: "thread.history", parentId: frame.parentId, before: frame.before, messages, hasMore });
      }
      case "presence.visible": {
        const attachment = ws.deserializeAttachment() as Attachment;
        ws.serializeAttachment({ ...attachment, visible: frame.visible, heardAt: Date.now() } satisfies Attachment);
        // Coming back to a tab showing the room reads it.
        if (frame.visible) await this.read(store.roomId, user.id);
        return;
      }
      case "card.click": {
        const message = await this.findUndeleted(store, frame.messageId);
        const button = message?.cards && actingButton(message.cards, clickedIn(frame));
        const waiting = this.clicking.get(user.id) ?? 0;
        const refused = !button ? BUTTON_GONE : waiting >= CLICKS_WAITING_EACH ? TOO_MANY_CLICKS : null;
        if (refused) return this.send(ws, { type: "error", message: refused, clickId: frame.clickId, failed: frame.type });
        this.clicking.set(user.id, waiting + 1);
        // The bot answers in its own time, which nothing else in the room waits for. A click that calls an app's tool waits on the app, as an answer does, not among the bots' deliveries.
        this.ctx.waitUntil(this.deliverClick(store.roomId, ws, user, frame, button && toolCallOf(button.action) ? this.answers : this.webhooks));
        return;
      }
      case "ping":
        return this.send(ws, { type: "pong" });
    }
  }

  /**
   * Stores a message from `user`, as `posting` says, tells everyone in the room, and its parent as it is
   * now for a reply in a thread, and sends the Workspace and the search index their logs, which the
   * message is in, answering it.
   */
  private async create(store: MessageStore, user: User, clientMessageId: string, body: StoredBody, now: string, { kind, posted, inThread }: Posting = {}): Promise<Message> {
    // Before the batch, which on D1 may save the message even when it fails.
    if (!inThread || inThread.alsoSend) this.readers.clear();
    const { message, seq, parent } = await store.create(sortableId(), clientMessageId, user, body, now, kind, posted, inThread);
    if (!inThread || inThread.alsoSend) this.seenBy.set(message.id, viewersOf(this.ctx));
    this.broadcast({ type: "message.created", message, seq });
    if (parent) this.broadcast({ type: "message.updated", ...parent });
    const couriers = this.couriersFor(store.roomId);
    couriers.workspace.deliver();
    couriers.index.deliver();
    return message;
  }

  /**
   * Posts `posted`'s file, `blob`, as `user`'s message, as `create` posts one. A file message's text is
   * empty, and its plain text, which search, pushes and webhooks read, is its file's name. An upload
   * started without an id for its message, as one from before files were messages or a bot's is, gets
   * one, as a bot's text does.
   */
  private postFile(store: MessageStore, user: User, blob: RoomBlob, posted: PostedFile, now: string, posting: Omit<Posting, "posted"> = {}): Promise<Message> {
    const body = { html: "", plainText: posted.file.name, mentions: [] };
    return this.create(store, user, blob.clientMessageId ?? crypto.randomUUID(), body, now, { ...posting, posted });
  }

  /**
   * Records that `uploaderId` has started a file named `filename`, of `declaredType` as they say, at
   * `startedAt`, which is to come to R2 as it arrives, so its size is only known once it has, and answers
   * its key. The alarm deletes it if it's still unfinished a day later, as it does an upload's.
   */
  private async startArriving(roomId: RoomId, uploaderId: UserId, { filename, declaredType }: Pick<ArrivingFile, "filename" | "declaredType">, startedAt: number): Promise<string> {
    const key = base36(KEY_LENGTH);
    const blob = { id: key, uploaderId, filename, contentType: declaredType, byteSize: 0, clientMessageId: null, parentId: null, alsoSent: false };
    await this.blobsFor(roomId).create(blob, new Date(startedAt).toISOString());
    return key;
  }

  /** `blob`, which R2 has all of now, as it came to in `file`, as the message it's posted as keeps it, at `now`. */
  private streamed(roomId: RoomId, blob: RoomBlob, file: StreamedFile, now: string): PostedFile {
    const blobs = this.blobsFor(roomId);
    return { file: attachedFile({ ...blob, byteSize: file.byteSize, preview: file.preview ?? null }, file.identified), finished: (messageId) => blobs.streamed(blob.id, messageId, now, file) };
  }

  /**
   * Gives `message` the file `posted` brings, in place of any it had, or takes its file away with null,
   * telling everyone in the room, sending the search index its log and having R2 delete the file it had,
   * and answers the message as it is now.
   */
  private async attach(store: MessageStore, message: Message, posted: PostedFile | null, now: string): Promise<Message> {
    const { message: attached, seq } = await store.updateAttachment(message, posted, now);
    this.broadcast({ type: "message.updated", message: attached, seq });
    const couriers = this.couriersFor(store.roomId);
    couriers.index.deliver();
    if (message.attachment) couriers.files.deliver();
    return attached;
  }

  /**
   * Replaces `message`'s text with `body`, and its cards with `body`'s, or none, telling everyone in the
   * room and sending the search index its log, and answers the message as it is now. Saved as it was, it
   * stays as it was, its update time included, as Rails saves nothing then.
   */
  private async edit(store: MessageStore, message: Message, body: StoredBody, now: string): Promise<Message> {
    if (body.html === message.body && JSON.stringify(body.cards) === JSON.stringify(message.cards)) return message;
    const { message: edited, seq } = await store.updateBody(message, body, now);
    this.broadcast({ type: "message.updated", message: edited, seq });
    this.couriersFor(store.roomId).index.deliver();
    return edited;
  }

  /**
   * Deletes `message`, with its boosts, or keeps it for its thread's replies without them, telling
   * everyone in the room and sending the search index its log, and has R2 delete its file, if it has one.
   */
  private async deleteMessage(store: MessageStore, message: Message): Promise<void> {
    this.broadcastDeletion(await store.delete([message.id]));
    const couriers = this.couriersFor(store.roomId);
    couriers.index.deliver();
    if (message.attachment) couriers.files.deliver();
  }

  /** Adds `user`'s boost of `content` to the message `messageId`, telling everyone in the room, and answers it. */
  private async addBoost(store: MessageStore, messageId: string, user: User, content: string, now: string): Promise<Boost> {
    const { boost, seq } = await store.addBoost(sortableId(), messageId, user, content, now);
    this.broadcast({ type: "boost.created", boost, seq });
    // Search results show a message's boosts, so the index takes it again.
    this.couriersFor(store.roomId).index.deliver();
    return boost;
  }

  /** Removes `boost`, telling everyone in the room. */
  private async removeBoost(store: MessageStore, boost: Boost): Promise<void> {
    const seq = await store.removeBoost(boost);
    this.broadcast({ type: "boost.deleted", boostId: boost.id, messageId: boost.messageId, seq });
    this.couriersFor(store.roomId).index.deliver();
  }

  /** Tells everyone in the room what deleting messages did: the deletions, then the messages it changed. */
  private broadcastDeletion({ deletedIds, changed, seq }: Deletion): void {
    // A deleted message's event no longer names it, nor does that of one kept for its thread's replies, so
    // their viewers are dropped here rather than when the event goes.
    for (const messageId of deletedIds) this.seenBy.delete(messageId);
    for (const { message } of changed) if (message.deleted) this.seenBy.delete(message.id);
    deletedIds.forEach((messageId, index) => this.broadcast({ type: "message.deleted", messageId, seq: seq + index }));
    for (const { message, seq } of changed) this.broadcast({ type: "message.updated", message, seq });
  }

  /** The message `messageId`, or null when the room has no such message, or keeps it deleted for its thread's replies. */
  private async findUndeleted(store: MessageStore, messageId: string): Promise<Message | null> {
    const message = await store.find(messageId);
    return message?.deleted ? null : message;
  }

  /**
   * A new reply's place in the thread of the message `parentId`, sent to the room too when `alsoSend`
   * says so, or null when the room has no such message, or it's a reply, which has no thread. A thread
   * whose message was deleted while it had replies still takes them.
   */
  private async inThread(store: MessageStore, parentId: string, alsoSend: boolean): Promise<InThread | null> {
    const parent = await store.find(parentId);
    return parent && parent.parentId === undefined ? { parent, alsoSend } : null;
  }

  /**
   * The bot `bot`'s message `messageId`, or `NOT_FOUND` or `FORBIDDEN` when the room has no such message
   * or it's someone else's. A bot is never an administrator, so the only messages it can change are its
   * own.
   */
  private async botsOwn(store: MessageStore, bot: User, messageId: string): Promise<Message | string> {
    const message = await this.findUndeleted(store, messageId);
    if (!message) return NOT_FOUND;
    return message.creator.id === bot.id ? message : FORBIDDEN;
  }

  /**
   * Whether `user` may edit or delete `message`: its author or an administrator. Only someone else's
   * message asks the Workspace.
   */
  private async canAdminister(user: User, message: Message): Promise<boolean> {
    return message.creator.id === user.id || (await workspace(this.env).isAdministrator(user.id));
  }

  /**
   * What the room keeps of a body a client sent, naming the people it mentions as they are now, or
   * why it keeps nothing.
   */
  private async prepare(markup: string): Promise<PreparedBody | string> {
    const ids = userIdsIn(markup);
    const people = new Map<UserId, User>(ids.length === 0 ? [] : (await workspace(this.env).mentionedPeople(ids)).map((person) => [person.id, person]));
    const body = prepareBody(markup, (sgid) => people.get(userIdFromSgid(sgid) ?? ""));
    if (body === null) return UNREADABLE;
    if (body.blank) return EMPTY;
    return isMessageTooLong(body.plainText) ? MESSAGE_TOO_LONG : body;
  }

  /**
   * What the room keeps of a bot's message with `cards`: its text, as `prepare` keeps a body, though it may
   * be empty once the room keeps a card, and the cards, as `keptCards` keeps them, whose plain text
   * follows the text's, together no longer than a message's, or why it keeps nothing.
   */
  private async prepareWithCards(markup: string, cards: Card[]): Promise<StoredBody | string> {
    const kept = cards.length === 0 ? null : keptCards(cards);
    if (!kept || kept.cards.length === 0) return this.prepare(markup);
    if (JSON.stringify(kept.cards).length > MAX_MESSAGE_HTML_LENGTH) return MESSAGE_TOO_LONG;
    const body = await this.prepare(markup);
    if (typeof body === "string" && body !== EMPTY) return body;
    const text = typeof body === "string" ? { html: "", plainText: "", mentions: [] } : body;
    const plainText = [text.plainText, kept.plainText].filter((line) => line !== "").join("\n");
    return isMessageTooLong(plainText) ? MESSAGE_TOO_LONG : { ...text, plainText, cards: kept.cards };
  }

  /** The room's database, with its migrations applied first if its storage needs them. */
  private dbFor(): Db {
    return (this.db ??= openDb(this.env, this.ctx.storage, "room"));
  }

  private storeFor(roomId: RoomId): MessageStore {
    return (this.store ??= new MessageStore(this.dbFor(), roomId, this.env.SESSION_SECRET));
  }

  private revocationsFor(roomId: RoomId): Revocations {
    return (this.revocations ??= new Revocations(this.dbFor(), roomId));
  }

  private logFor(roomId: RoomId): RoomLog {
    return (this.log ??= new RoomLog(this.dbFor(), roomId));
  }

  private blobsFor(roomId: RoomId): Blobs {
    return (this.blobs ??= new Blobs(this.dbFor(), roomId));
  }

  private waitingCallsFor(roomId: RoomId): WaitingCalls {
    return (this.waitingCalls ??= new WaitingCalls(this.dbFor(), roomId));
  }

  /**
   * Logs that `userId` has read the room, unless they have since its latest message, for the Workspace
   * to clear their mark, and sends it the log.
   */
  private async read(roomId: RoomId, userId: UserId): Promise<void> {
    if (this.readers.has(userId)) return;
    await this.logFor(roomId).read(userId, new Date().toISOString());
    this.readers.add(userId);
    this.couriersFor(roomId).workspace.deliver();
  }

  /**
   * What sends each of the room's logs. Each has a call of its own out at a time, and waits on its own
   * failures. The search index's is patient, since a search can find a message a moment late: its call
   * doesn't go with the Workspace's as a message is written, so the unread marks the Workspace sends
   * everyone away don't wait behind its queries, as on D1 they would.
   */
  private couriersFor(roomId: RoomId): Couriers {
    return (this.couriers ??= {
      workspace: new Courier(() => this.sendEvents(roomId), (time) => this.wakeAt(roomId, time), `room ${roomId}'s log to the Workspace`),
      index: new Courier(() => this.sendMessages(roomId), (time) => this.wakeAt(roomId, time), `room ${roomId}'s messages to the search index`, true),
      files: new Courier(() => this.purgeFiles(roomId), (time) => this.wakeAt(roomId, time), `room ${roomId}'s deleted files to R2`, true),
    });
  }

  /**
   * Sends the Workspace the oldest events it hasn't taken, as many as one call takes, with who is viewing
   * the room now, for it to mark the room unread for the members who aren't and read for those who've
   * opened it, and forgets them once it has. Answers how many it sent. A reply sent only to its thread
   * goes with who is viewing the thread, who see it, where those viewing the room only see it counted.
   */
  private async sendEvents(roomId: RoomId): Promise<number> {
    const log = this.logFor(roomId);
    const logged = await log.undelivered(ENTRIES_PER_CALL);
    if (logged.length === 0) return 0;
    const now = Date.now();
    const viewers = viewersOf(this.ctx, now);
    const threads = new Map<string, UserId[]>();
    const viewingThread = (parentId: string) => {
      if (!threads.has(parentId)) threads.set(parentId, viewersOf(this.ctx, now, parentId));
      return threads.get(parentId)!;
    };
    // A message in the room goes with everyone who was viewing it as it came, as well as those viewing it now.
    const seeing = (event: RoomEvent): RoomEvent => {
      const seen = event.message && this.seenBy.get(event.message.id);
      return seen ? { ...event, viewerIds: [...new Set([...seen, ...viewers])] } : event;
    };
    const events = logged.map((event) => (event.threadOnly && event.message?.parentId !== undefined ? { ...event, viewerIds: viewingThread(event.message.parentId) } : seeing(event)));
    const { pushes, webhooks, asks } = await workspace(this.env).applyRoomEvents(roomId, events, viewers);
    // The Workspace answers a message's pushes, webhooks and question for @ember once, so they're sent
    // whatever happens next, and the log's next call doesn't wait on push services, bots or models.
    if (pushes.length > 0) this.ctx.waitUntil(this.push(pushes));
    for (const webhook of webhooks) this.ctx.waitUntil(this.deliver(roomId, webhook));
    for (const question of asks) this.ctx.waitUntil(this.answer(roomId, question));
    await log.delivered(events.at(-1)!.seq);
    for (const { message } of events) if (message) this.seenBy.delete(message.id);
    return events.length;
  }

  /**
   * Delivers a new message to a bot's webhook in its turn: the message as it is by then, to the bot's
   * webhook as the Workspace finds it then, and nothing once either is gone, and posts what the bot says
   * back, text or a file. The Workspace finds no webhook for a bot deleted or taken out of the room
   * since, so deleting a bot, taking it out of a room or removing its webhook stops what was on its way
   * to it, and a new URL or key takes effect at once. Each delivery is logged, without its URL or the
   * bot's key, and one the queue has no room for is dropped.
   */
  private async deliver(roomId: RoomId, delivery: MessageWebhook): Promise<void> {
    const job = `Bot::WebhookJob of message ${delivery.messageId} to bot ${delivery.botId}`;
    const ran = await this.webhooks.run(async () => {
      try {
        const message = (await this.isDeleted()) ? null : await this.storeFor(roomId).find(delivery.messageId);
        if (!message) throw new WebhookError("the message is gone");
        const webhook = await workspace(this.env).botWebhook(roomId, delivery.botId);
        if (!webhook) throw new WebhookError(NO_WEBHOOK);
        const keep = (file: ArrivingFile) => this.keepReplyFile(roomId, webhook.bot, file);
        const { status, reply } = await postWebhook(webhook.url, webhookPayload(roomId, delivery, webhook, message), keep);
        const refused = reply && (await this.postReply(roomId, webhook, reply, message.parentId));
        if (refused) throw new WebhookError(`its reply wasn't posted: ${refused}`);
        console.log(`${job} performed: ${status ?? "no answer in time"}`);
      } catch (error) {
        console.error(`${job} failed:`, error instanceof WebhookError ? error.message : error);
      }
    });
    if (!ran) console.error(`${job} dropped: the room's webhook queue is full`);
  }

  /**
   * Reports the click `click`, which `user` sent on `ws`, to the webhook of the bot whose message it's on,
   * in its turn among the room's deliveries, or among its answers, as `queue` is, and does what the bot
   * answers, then tells `ws` it's done, or why it came to nothing. Each is logged as a delivery is, and
   * one the queue has no room for is dropped.
   */
  private async deliverClick(roomId: RoomId, ws: WebSocket, user: User, click: CardClick, queue: JobQueue): Promise<void> {
    const job = `Bot::WebhookJob of ${user.id}'s click on message ${click.messageId}`;
    let failed: string | null = null;
    try {
      const ran = await queue.run(async () => {
        try {
          console.log(`${job} performed: ${await this.reportClick(roomId, user, click)}`);
        } catch (error) {
          console.error(`${job} failed:`, error instanceof WebhookError ? error.message : error);
          failed = error instanceof ClickError ? error.told : CLICK_FAILED;
        }
      });
      if (!ran) {
        console.error(`${job} dropped: the room's queue is full`);
        failed = queue === this.answers ? ROOM_BUSY : WEBHOOKS_FULL;
      }
    } finally {
      const waiting = (this.clicking.get(user.id) ?? 1) - 1;
      if (waiting > 0) this.clicking.set(user.id, waiting);
      else this.clicking.delete(user.id);
      this.send(ws, failed === null ? { type: "card.clicked", clickId: click.clickId } : { type: "error", message: failed, clickId: click.clickId, failed: click.type });
    }
  }

  /**
   * Delivers `user`'s click to the bot's webhook, as `deliver` delivers a message: the button as its
   * message has it by then, to the webhook as the Workspace finds it then, for whoever clicked, while
   * they're in the room, and does what the bot answers. Answers the webhook's status, or throws why the
   * click came to nothing. A click that answers a call that waits goes to no webhook (`decideCall`),
   * and neither does one that calls a tool, on a tool's card (`callFromCard`).
   */
  private async reportClick(roomId: RoomId, user: User, click: CardClick): Promise<number | string> {
    const message = (await this.isDeleted()) ? null : await this.findUndeleted(this.storeFor(roomId), click.messageId);
    const button = message?.cards && actingButton(message.cards, clickedIn(click));
    if (!message || !button) throw new ClickError(BUTTON_GONE, "the button is gone");
    const decision = callDecisionOf(button.action);
    const decided = decision && (await this.decideCall(roomId, user, message, decision));
    if (decided) return decided;
    if (toolCallOf(button.action)) return this.callFromCard(roomId, user, click);
    const { name } = message.creator;
    const webhook = await workspace(this.env).clickWebhook(roomId, message.creator.id, user.id);
    if (!webhook) throw new ClickError(`${name} isn't taking clicks here`, `${NO_WEBHOOK}, or whoever clicked has left the room`);
    const keep = (file: ArrivingFile) => this.keepReplyFile(roomId, webhook.bot, file);
    const { status, answer } = await postClick(webhook.url, clickPayload(roomId, webhook, webhook, message, button, Date.now()), keep);
    if (status === null) throw new ClickError(`${name} didn't answer in time`, "no answer in time");
    if (status < 200 || status > 299) throw new ClickError(`${name} couldn't take that click`, `its webhook answered ${status}`);
    const refused = answer && (await this.postClickAnswer(roomId, webhook, message, answer));
    if (refused) throw new ClickError(`${name}'s answer couldn't be shown`, `its answer wasn't kept: ${refused}`);
    return status;
  }

  /**
   * Makes the call `user`'s `click` on a button of a tool's card asks for, one click a card at a time.
   * The click has the card to itself before its button is looked for again, so one that waited while
   * another's answer took the card's place calls nothing the card no longer offers. Answers what came
   * of it, or throws why the click came to nothing, which whoever clicked is told.
   */
  private async callFromCard(roomId: RoomId, user: User, click: CardClick): Promise<string> {
    if (this.calling.has(click.messageId)) throw new ClickError(CARD_BUSY, "another click on the card is being answered");
    this.calling.add(click.messageId);
    try {
      const message = (await this.isDeleted()) ? null : await this.findUndeleted(this.storeFor(roomId), click.messageId);
      const button = message?.cards && actingButton(message.cards, clickedIn(click));
      const call = button ? toolCallOf(button.action) : undefined;
      if (!message || !button || !call) throw new ClickError(BUTTON_GONE, "the button is gone");
      return await this.callForClick(roomId, user, message, button.text, call);
    } finally {
      this.calling.delete(click.messageId);
    }
  }

  /**
   * Makes the call `call`, which `user`'s click on the button `label` of the tool's card `message`
   * asks for: of a tool the card's answerer still has, of the app whose tool answered with the card,
   * for someone in the room, while Ember AI is on and the answerer there. The card the tool answers
   * with takes the clicked one's place, saying who clicked what, and what a tool only says is the
   * answerer's new message beside it. Answers what came of it, or throws why the click came to nothing,
   * which whoever clicked is told: a tool's own word for it, cut short.
   */
  private async callForClick(roomId: RoomId, user: User, message: Message, label: string, call: CardCall): Promise<string> {
    const { name } = message.creator;
    const [clicker, access] = await Promise.all([workspace(this.env).callDecider(roomId, user.id), workspace(this.env).answererIn(roomId, message.creator.id, user.id)]);
    if (!clicker || !access) throw new ClickError(`${name} isn't answering here`, `${answererGone(message.creator.id)}, or whoever clicked has left the room`);
    const tool = givenTools(access.appTools).find(({ appId, name }) => appId === call.appId && name === call.name);
    if (!tool) throw new ClickError(`${name} no longer has that tool`, "the tool isn't the answerer's any more");
    try {
      const clicked = { who: clicker.member.name, button: label };
      const { text, card } = await calledFromCard(this.env, access.bot.id, givenAs(tool), call.input, clicked, { roomId, askerId: user.id });
      const cards = card && toolCards(card, tool.appId, toolsOf(access.appTools, tool.appId));
      const unshown = await this.showCalled(roomId, access, message, cards ?? slackMessage(saidCard(tool, text, clicked)), cards !== null);
      if (unshown !== null) throw new ClickError(`${tool.appName}'s answer couldn't be shown`, `its answer wasn't kept: ${unshown}`);
      return cards ? "its card was replaced" : "its tool's answer was posted";
    } catch (error) {
      if (error instanceof ToolGone) throw new ClickError(`${name} no longer has that tool`, "the tool isn't the answerer's any more");
      // What a server says of a call isn't logged, as it could write the token there.
      if (error instanceof ToolError) throw new ClickError(toldOf(error.message), "the call came to nothing");
      throw error;
    }
  }

  /**
   * Shows what a click's call was answered with, `shown`, for the tool's card `message`, the answerer
   * `access` finds's own: in its place, `replacing` it, or as the answerer's new message beside it.
   * Answers why the room keeps nothing of it, if it doesn't.
   */
  private showCalled(roomId: RoomId, access: AssistantAccess, message: Message, shown: SlackMessage | string, replacing: boolean): Promise<string | null> {
    return this.serially(async () => {
      if (typeof shown === "string") return shown;
      if (await this.isDeleted()) return "the room is gone";
      if (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt)) return answererGone(access.bot.id);
      const store = this.storeFor(roomId);
      const current = await this.botsOwn(store, access.bot, message.id);
      if (typeof current === "string") return "the card is gone";
      if (!replacing) return this.postBeside(store, access.bot, current, shown);
      const body = await this.prepareWithCards(shown.markup, shown.cards);
      if (typeof body === "string") return body;
      await this.edit(store, current, body, new Date().toISOString());
      return null;
    });
  }

  /**
   * Does what a bot answers a click on its `message` with: what it says back, text or a file, is its
   * reply, as `postReply` posts one to a delivery, and a Slack payload takes the message's place, as
   * Slack has an interactive message's answer do, or, with `replace_original` false, is a new message
   * beside it, and `delete_original` deletes the message. A payload that shows nothing does nothing, as an
   * answer without one does, and as blank text does, which is a webhook's bare 200. Answers why the room
   * keeps nothing of it, if it doesn't.
   */
  private async postClickAnswer(roomId: RoomId, webhook: WebhookAccess, message: Message, answer: ClickAnswer<KeptFile>): Promise<string | null> {
    if ("text" in answer && answer.text.trim() === "") return null;
    if (!("payload" in answer)) return this.postReply(roomId, webhook, answer, message.parentId);
    if (answer.payload.trim() === "") return null;
    const payload = payloadOf(answer.payload);
    if (!payload) return "it isn't a JSON object";
    const posted = payload.delete_original === true ? null : slackMessage(payload, true);
    if (posted === "no_text") return null;
    if (typeof posted === "string") return posted;
    const found = await workspace(this.env).botWebhook(roomId, webhook.bot.id);
    const access = found?.url === webhook.url ? found : null;
    return this.serially(async () => {
      if (await this.isDeleted()) return "the room is gone";
      if (!access || (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt))) return WEBHOOK_CHANGED;
      const store = this.storeFor(roomId);
      if (posted && payload.replace_original === false) return this.postBeside(store, access.bot, message, posted);
      const current = await this.botsOwn(store, access.bot, message.id);
      if (typeof current === "string") return "the message is gone";
      if (!posted) return this.deleteMessage(store, current).then(() => null);
      const body = await this.prepareWithCards(posted.markup, posted.cards);
      if (typeof body === "string") return body;
      await this.edit(store, current, body, new Date().toISOString());
      return null;
    });
  }

  /**
   * Posts `posted` as `bot`'s new message beside `message`, in its thread when it's in one, only there, as
   * a reply to a delivery goes, and to no webhook. Answers why the room keeps nothing of it, if it doesn't.
   */
  private async postBeside(store: MessageStore, bot: User, message: Message, { markup, cards }: SlackMessage): Promise<string | null> {
    const inThread = message.parentId === undefined ? undefined : await this.inThread(store, message.parentId, false);
    if (inThread === null) return THREAD_GONE;
    const body = await this.prepareWithCards(markup, cards);
    if (typeof body === "string") return body;
    await this.create(store, bot, crypto.randomUUID(), body, new Date().toISOString(), { kind: "reply", inThread });
    return null;
  }

  /**
   * Posts what a bot says back to a delivery to `webhook`, text or a file, as the bot by its name then,
   * once the Workspace has found it still in the room, delivering to the same URL: one deleted, taken
   * out of the room or sent elsewhere while the delivery ran posts nothing, where Campfire posts it
   * (`Webhook#deliver`). A reply to a message in a thread, `threadId`'s, goes in the thread, only there.
   * Answers why the room keeps nothing of it, if it doesn't, and has R2 delete a file it couldn't ask the
   * Workspace about, as `replyWithFile` has it delete one it refuses.
   */
  private async postReply(roomId: RoomId, webhook: WebhookAccess, reply: Reply<KeptFile>, threadId?: string): Promise<string | null> {
    const found = await workspace(this.env)
      .botWebhook(roomId, webhook.bot.id)
      .catch(async (error: unknown) => {
        if ("kept" in reply) await this.env.FILES?.delete([objectKey(reply.kept.key), previewKey(reply.kept.key)]);
        throw error;
      });
    const access = found?.url === webhook.url ? found : null;
    return "text" in reply ? this.reply(roomId, access, reply.text, threadId) : this.replyWithFile(roomId, access, reply.kept, threadId);
  }

  /**
   * Posts `text` as the bot's reply to a delivery, as Campfire's `receive_text_reply_to` does: as the
   * bot's message, which reaches the room as any message does but is delivered to no webhook. Answers why
   * the room keeps nothing of it, if it doesn't: as `createBotMessage` refuses a bot's post, it refuses
   * one without `access`, or that the room has heard was taken out since the Workspace checked, and one
   * to thread `threadId` that the room no longer has.
   */
  private async reply(roomId: RoomId, access: BotAccess | null, text: string, threadId?: string): Promise<string | null> {
    return this.serially(async () => {
      if (await this.isDeleted()) return "the room is gone";
      if (!access || (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt))) return WEBHOOK_CHANGED;
      const store = this.storeFor(roomId);
      const inThread = threadId === undefined ? undefined : await this.inThread(store, threadId, false);
      if (inThread === null) return THREAD_GONE;
      const body = await this.prepare(text);
      if (typeof body === "string") return body;
      await this.create(store, access.bot, crypto.randomUUID(), body, new Date().toISOString(), { kind: "reply", inThread });
      return null;
    });
  }

  /**
   * Has R2 keep the file a bot replies with, as it arrives, as an upload of the bot's the room starts for
   * it, for `replyWithFile` to post, and answers what it came to, or null once it's more than its limit.
   */
  private async keepReplyFile(roomId: RoomId, bot: User, file: ArrivingFile): Promise<KeptFile | null> {
    const files = this.env.FILES;
    if (!files) throw new WebhookError(`its reply, ${file.filename} (${file.declaredType}), is a file, and ${NO_STORAGE}`);
    const startedAt = Date.now();
    const key = await this.serially(async () => {
      if (await this.isDeleted()) throw new WebhookError("the room is gone");
      return this.startArriving(roomId, bot.id, file, startedAt);
    });
    await this.wakeAt(roomId, startedAt + UNFINISHED_UPLOAD_KEPT_MS);
    const stored = await storeArriving(files, objectKey(key), file);
    return stored && { key, file: await withPreview(this.env, files, key, file.filename, stored) };
  }

  /**
   * Posts the file `kept` as the bot's reply to a delivery, as Campfire's `receive_attachment_reply_to`
   * does, as `reply` posts text, refusing it as `reply` does. Answers why the room keeps nothing of it, if
   * it doesn't, having R2 delete it at once: nothing else would once the room is deleted, and otherwise it
   * would wait for the alarm to find it unfinished.
   */
  private async replyWithFile(roomId: RoomId, access: BotAccess | null, { key, file }: KeptFile, threadId?: string): Promise<string | null> {
    const refused = await this.serially(async () => {
      const now = new Date().toISOString();
      const blob = (await this.isDeleted()) ? null : await this.blobsFor(roomId).find(key);
      if (!blob) return "the room is gone";
      if (!access || (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt))) return WEBHOOK_CHANGED;
      const store = this.storeFor(roomId);
      const inThread = threadId === undefined ? undefined : await this.inThread(store, threadId, false);
      if (inThread === null) return THREAD_GONE;
      await this.postFile(store, access.bot, blob, this.streamed(roomId, blob, file, now), now, { kind: "reply", inThread });
      return null;
    });
    if (refused) await this.env.FILES?.delete([objectKey(key), previewKey(key)]);
    return refused;
  }

  /**
   * Answers a question for @ember or an agent, the bot `question` names, in its turn: the message as it
   * is by then, while Ember AI is on and the bot is in the room, and nothing once either isn't, typing
   * while it works, and posting what the model answers, or a note saying why it can't. Each is logged,
   * without what was asked or answered, and one the queue has no room for is dropped.
   */
  private async answer(roomId: RoomId, question: AssistantAsk): Promise<void> {
    const job = `${answererOf(question.botId)}'s answer to message ${question.messageId}`;
    const ran = await this.answers.run(async () => {
      try {
        const message = (await this.isDeleted()) ? null : await this.findUndeleted(this.storeFor(roomId), question.messageId);
        if (!message) throw new AnswerError("the message is gone");
        const access = await workspace(this.env).answererIn(roomId, question.botId, question.author.id);
        if (!access) throw new AnswerError(answererGone(question.botId));
        const refused = await this.typingWhile(access.bot, message.parentId, async () => this.post(roomId, access, question.author, message, await this.saidTo(roomId, access, question, message)));
        if (refused) throw new AnswerError(`it wasn't posted: ${refused}`);
        console.log(`${job} posted`);
      } catch (error) {
        console.error(`${job} failed:`, error instanceof AnswerError ? error.message : error);
      }
    });
    if (!ran) console.error(`${job} dropped: the room's queue of questions for @ember and the agents is full`);
  }

  /**
   * What the bot `access` finds, @ember or an agent, says to `message`, `question`'s message, with what
   * it reads of the conversation, as its instructions say, using the web as Search the web lets it, and
   * searching the room for what was written before that, and the connected apps' tools picked for it,
   * where its model takes Ember's tools: its answer in Markdown, at its levels, @ember's the asker's,
   * with the model they picked, if they did (`outcomeOf`), or the call of an app's tool it waits at.
   */
  private async saidTo(roomId: RoomId, access: AssistantAccess, { author, roomName }: AssistantAsk, message: Message): Promise<Outcome> {
    const { bot, gateway, instructions, promptTemplate, community, levels, webTools, webSearchOn } = access;
    if (!gateway) return { text: NOTES["unopened token"] };
    const [conversation, takesTools] = await Promise.all([this.conversationOf(this.storeFor(roomId), message), takesEmbersTools(this.env, gateway.model)]);
    const where = { community, roomName, inThread: message.parentId !== undefined };
    const read = readable(conversation, where.inThread).map(({ id }) => id);
    const given = takesTools ? givenTools(access.appTools) : [];
    const askedBy = { roomId, askerId: author.id };
    const appTools = given.map((tool) => appTool(this.env, bot.id, tool, askedBy, { described: tool, shown: this.showsCallsOf(roomId, access, message, tool), cards: this.showsCardsOf(roomId, bot, message, tool) }));
    const tools = takesTools ? [roomSearch(this.env, roomId, read), ...appTools] : [];
    const asked = { ...questionFor({ ...bot, instructions, promptTemplate }, conversation, author, where, levels, new Date(), webTools, webSearchOn), tools };
    const [answered, people] = await Promise.all([askWaiting(this.env, gateway, asked, waitFor(asked)), this.peopleWhoWrote(conversation)]);
    return this.outcomeOf(access, message, answered, writtenBy(people, conversation, where.inThread), given.map(givenAs));
  }

  /**
   * What the bot `access` finds says to `message` once the call its answer waited at, `call`, is
   * `allowed` or isn't: as `saidTo` answers, going on from where its model stopped, with the room's
   * search and the apps' tools the model was given then, each called only while it's still picked for
   * the bot, and without asking first where its calls of it are always allowed by now. A model changed
   * since can't go on from another's answer, which the bot says.
   */
  private async wentOn(roomId: RoomId, access: AssistantAccess, message: Message, call: WaitingCall, allowed: boolean): Promise<Outcome> {
    const { bot, gateway } = access;
    if (!gateway) return { text: NOTES["unopened token"] };
    if (gateway.model !== call.paused.model || gateway.format !== call.paused.format) return { text: MODEL_CHANGED };
    const conversation = await this.conversationOf(this.storeFor(roomId), message);
    const inThread = message.parentId !== undefined;
    const read = readable(conversation, inThread).map(({ id }) => id);
    const asked = { roomId, askerId: call.asker.id };
    const appTools = call.tools.map((tool) => appTool(this.env, bot.id, tool, asked, { shown: this.showsCallsOf(roomId, access, message, tool), cards: this.showsCardsOf(roomId, bot, message, tool) }));
    const tools = [roomSearch(this.env, roomId, read), ...appTools];
    const [answered, people] = await Promise.all([goOn(this.env, gateway, tools, call.paused, allowed, waitFor(call.paused.question)), this.peopleWhoWrote(conversation)]);
    return this.outcomeOf(access, message, answered, writtenBy(people, conversation, inThread), call.tools);
  }

  /**
   * What shows room `roomId` the calls of `tool` that the bot `access` finds makes, answering `message`,
   * without asking first, or undefined unless its calls of it are always allowed: a card for each, as
   * its reply, which says what the tool was called with, and then that the call wasn't made, if it wasn't.
   */
  private showsCallsOf(roomId: RoomId, { bot, appTools }: AssistantAccess, message: Message, tool: GivenTool): ShowsCall | undefined {
    const isIt = (picked: PickedTool) => picked.appId === tool.appId && picked.name === tool.name && picked.fingerprint === tool.fingerprint;
    if (!appTools.some((picked) => isIt(picked) && picked.alwaysAllowed)) return undefined;
    return async (input) => {
      let cardId: string | undefined;
      const unshown = await this.postCallCard(roomId, bot, message, () => slackMessage(usedCard(bot.name, tool, input), true), async (posted) => void (cardId = posted.id));
      return unshown ?? { unmade: (why) => this.showUnmade(roomId, cardId!, tool, input, why) };
    };
  }

  /**
   * What shows room `roomId` the cards that `tool` answers `bot`'s calls with, as it answers
   * `message`: each as `bot`'s reply, where its answer goes, with the buttons that call a tool of the
   * same app that `bot` has by then (`toolCards`).
   */
  private showsCardsOf(roomId: RoomId, bot: User, message: Message, tool: GivenTool): ShowsCard {
    return (card) => this.postCallCard(roomId, bot, message, ({ appTools }) => toolCards(card, tool.appId, toolsOf(appTools, tool.appId)) ?? "it shows nothing here");
  }

  /** Has the card `messageId`, which showed the room a call of `tool` made without asking first, say the call wasn't made, and `why`. */
  private async showUnmade(roomId: RoomId, messageId: string, tool: GivenTool, input: Record<string, unknown>, why: Unmade): Promise<void> {
    const unchanged = await this.changeCallCard(roomId, messageId, (botName) => usedCard(botName, tool, input, why));
    if (unchanged !== null) console.error(`The card of a call that wasn't made, message ${messageId}, wasn't changed: ${unchanged}`);
  }

  /**
   * What `answered`, which the model of the bot `access` finds came to for `message`, has it say: its
   * answer, ending with an ellipsis when the model was cut short, the pages it came from, and what
   * people wrote in what it read, `written`, or the note it posts when its model doesn't answer, saying
   * why, which the room logs, or the call it waits at, with the apps' tools it was `given`.
   */
  private outcomeOf(access: AssistantAccess, message: Message, answered: Answered | GatewayRefusal | Asking, written: string[], given: GivenTool[]): Outcome {
    const { bot, gateway, picked } = access;
    if ("asks" in answered) return { asking: answered, given };
    if (!("refusal" in answered)) {
      const text = answered.cut ? `${answered.text}\n\n…` : answered.text;
      return { text, ...(answered.sources && { sources: answered.sources }), written };
    }
    console.error(`${answererOf(bot.id)}'s model ${gateway?.model} didn't answer message ${message.id}: ${answered.refusal}`);
    const agent = bot.id !== ASSISTANT_ID;
    return { text: (picked && PICKED_MODEL_NOTES[answered.reason]) || (agent && AGENT_NOTES[answered.reason]) || NOTES[answered.reason] };
  }

  /**
   * Posts what a question to the bot `access` finds came to, `outcome`, for `message`, which `asker`
   * asked: its answer (`postAnswer`), or the card that asks whether its call may run (`askFirst`).
   * Answers why the room keeps nothing of it, if it doesn't.
   */
  private async post(roomId: RoomId, access: AssistantAccess, asker: User, message: Message, outcome: Outcome): Promise<string | null> {
    if (!("asking" in outcome)) return this.postAnswer(roomId, access.bot, outcome, message, access.addresses);
    const { asks, paused } = outcome.asking;
    const tool = outcome.given.find(({ as }) => as === asks.name);
    if (!tool) return `${asks.name} asks first, and is no app's tool`;
    const call: WaitingCall = { questionId: message.id, botId: access.bot.id, asker, tool, input: asks.input, tools: outcome.given, paused, askedAt: Date.now() };
    return fits(call) ? this.askFirst(roomId, access.bot, message, call) : this.postAnswer(roomId, access.bot, { text: tooMuchToWait(tool.appName) }, message, access.addresses);
  }

  /**
   * Posts the card that asks whether `call`, which `bot`'s answer to `message` waits at, may run, as its
   * reply, where `postAnswer` would post the answer and while it would, and keeps the call for the click
   * that answers it (`decideCall`). Answers why the room keeps nothing of it, if it doesn't.
   */
  private async askFirst(roomId: RoomId, bot: User, message: Message, call: WaitingCall): Promise<string | null> {
    const card = () => slackMessage(callCard(bot.name, call.asker.name, call.tool, call.input), true);
    const refused = await this.postCallCard(roomId, bot, message, card, (posted) => this.waitingCallsFor(roomId).keep(posted.id, call));
    // The alarm forgets it once it has waited too long (`forgetLateCalls`).
    if (refused === null) await this.wakeAt(roomId, call.askedAt + CALL_WAITS_MS + 1);
    return refused;
  }

  /**
   * Posts a call's card, or the card one was answered with, as `bot`'s reply to `message`, where
   * `postAnswer` would post the answer and while it would: what `cardFor` gives for `bot` as the
   * Workspace finds it then, or why there's none to post. It then does `kept` with the message it is,
   * in the same turn. Answers why the room keeps nothing of it, if it doesn't.
   */
  private async postCallCard(roomId: RoomId, bot: User, message: Message, cardFor: (access: AssistantAccess) => SlackMessage | string, kept?: (posted: Message) => Promise<void>): Promise<string | null> {
    const access = await workspace(this.env).answererIn(roomId, bot.id, message.creator.id);
    const card = access && cardFor(access);
    if (typeof card === "string") return card;
    return this.serially(async () => {
      if (await this.isDeleted()) return "the room is gone";
      if (!access || !card || (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt))) return answererGone(bot.id);
      const store = this.storeFor(roomId);
      if (!(await this.findUndeleted(store, message.id))) return "the message is gone";
      const inThread = message.parentId === undefined ? undefined : await this.inThread(store, message.parentId, false);
      if (inThread === null) return THREAD_GONE;
      const body = await this.prepareWithCards(card.markup, card.cards);
      if (typeof body === "string") return body;
      const posted = await this.create(store, access.bot, crypto.randomUUID(), body, new Date().toISOString(), { kind: "reply", inThread });
      await kept?.(posted);
      return null;
    });
  }

  /**
   * Forgets the calls that have waited too long to be allowed in room `roomId`, a few at a time, each
   * card saying so in place of its buttons, and answers when the next will have, if any still waits.
   */
  private async forgetLateCalls(roomId: RoomId): Promise<number | null> {
    const { late, next } = await this.serially(() => this.waitingCallsFor(roomId).takeLate(Date.now()));
    for (const { messageId, call } of late) {
      const unchanged = await this.showDecided(roomId, messageId, call, CALL_OUTCOMES.late());
      if (unchanged !== null) console.error(`The card of a call that waited too long, message ${messageId}, wasn't changed: ${unchanged}`);
    }
    return next;
  }

  /**
   * Answers the call that waits on the card `message` as `user`'s click on its button says, `allow` or
   * `deny`, for whoever asked the question or an administrator, once: the card says who answered and
   * how, in place of its buttons, and the answer goes on in its turn (`goOnFrom`). Answers what was
   * decided, or null when no call waits on that message, and throws why the click came to nothing: with
   * no turn left for the answer to go on in, the call waits on, to be answered again.
   */
  private async decideCall(roomId: RoomId, user: User, message: Message, decision: "allow" | "deny"): Promise<string | null> {
    const calls = this.waitingCallsFor(roomId);
    const waiting = await calls.find(message.id);
    if (!waiting) return null;
    const decider = await workspace(this.env).callDecider(roomId, user.id);
    if (!decider || (!decider.administrator && user.id !== waiting.asker.id)) throw new ClickError(`Only ${waiting.asker.name} or an administrator can answer that`, "whoever clicked may not answer it");
    const call = await this.serially(() => calls.take(message.id));
    if (!call) throw new ClickError(CALL_ANSWERED, "the call was answered meanwhile");
    if (Date.now() - call.askedAt > CALL_WAITS_MS) {
      await this.showDecided(roomId, message.id, call, CALL_OUTCOMES.late());
      throw new ClickError(CALL_LATE, "the call waited too long");
    }
    if (this.answers.full) {
      // Kept to be answered again, as an answer nobody goes on with would be lost with its call allowed.
      await this.serially(() => calls.keep(message.id, call));
      throw new ClickError(ROOM_BUSY, "the room's queue of questions for @ember and the agents is full");
    }
    // The answer takes its turn before anything else can take the queue's last place.
    const going = this.goOnFrom(roomId, call, decision === "allow");
    const shown = await this.showDecided(roomId, message.id, call, CALL_OUTCOMES[decision](decider.member.name));
    this.ctx.waitUntil(going);
    return `${decision}${shown === null ? "" : `, though its card wasn't changed: ${shown}`}`;
  }

  /** Has the card `messageId`, which asked whether `call` may run, say `outcome` in place of its buttons. Answers why it's left as it was, if it is. */
  private showDecided(roomId: RoomId, messageId: string, call: WaitingCall, outcome: string): Promise<string | null> {
    return this.changeCallCard(roomId, messageId, (botName) => callCard(botName, call.asker.name, call.tool, call.input, outcome));
  }

  /** Has the message `messageId`, a call's card, be the card `cardFor` gives for the bot that posted it, by its name now. Answers why it's left as it was, if it is. */
  private changeCallCard(roomId: RoomId, messageId: string, cardFor: (botName: string) => SlackPayload): Promise<string | null> {
    return this.serially(async () => {
      const store = this.storeFor(roomId);
      const current = (await this.isDeleted()) ? null : await this.findUndeleted(store, messageId);
      if (!current) return "the message is gone";
      const card = slackMessage(cardFor(current.creator.name));
      if (typeof card === "string") return card;
      const body = await this.prepareWithCards(card.markup, card.cards);
      if (typeof body === "string") return body;
      await this.edit(store, current, body, new Date().toISOString());
      return null;
    });
  }

  /**
   * Goes on with the answer that waited at `call`, once it's `allowed` or isn't, in its turn among the
   * room's answers, as `answer` answers a question: for the message asked, as it is by then, while Ember
   * AI is on and the bot in the room, typing while it works, and posting what the model answers, the
   * note saying why it can't, or the card for the next call it waits at.
   */
  private async goOnFrom(roomId: RoomId, call: WaitingCall, allowed: boolean): Promise<void> {
    const job = `${answererOf(call.botId)}'s answer to message ${call.questionId}, going on from a call ${allowed ? "allowed" : "not allowed"}`;
    const ran = await this.answers.run(async () => {
      try {
        const message = (await this.isDeleted()) ? null : await this.findUndeleted(this.storeFor(roomId), call.questionId);
        if (!message) throw new AnswerError("the message is gone");
        const access = await workspace(this.env).answererIn(roomId, call.botId, call.asker.id);
        if (!access) throw new AnswerError(answererGone(call.botId));
        const refused = await this.typingWhile(access.bot, message.parentId, async () => this.post(roomId, access, call.asker, message, await this.wentOn(roomId, access, message, call, allowed)));
        if (refused) throw new AnswerError(`it wasn't posted: ${refused}`);
        console.log(`${job} posted`);
      } catch (error) {
        console.error(`${job} failed:`, error instanceof AnswerError ? error.message : error);
      }
    });
    if (!ran) console.error(`${job} dropped: the room's queue of questions for @ember and the agents is full`);
  }

  /**
   * Which of those who wrote `conversation` are people, not bots, as @ember is one, as the Workspace has
   * them now, or nobody when it can't say.
   */
  private async peopleWhoWrote(conversation: Message[]): Promise<Set<UserId>> {
    const writers = [...new Set(conversation.map(({ creator }) => creator.id))];
    const entries = await workspace(this.env)
      .directoryEntries(writers)
      .catch((error: unknown) => {
        console.error("Could not find who wrote what Ember AI read", error);
        return [];
      });
    return new Set(entries.flatMap(({ id, role }) => (role === "bot" ? [] : [id])));
  }

  /**
   * The conversation @ember reads to answer `message`, oldest first, ending with it: the thread it's in,
   * its first message and latest replies, or else the room's latest messages.
   */
  private async conversationOf(store: MessageStore, message: Message): Promise<Message[]> {
    if (message.parentId === undefined) return [...(await store.page(ROOM_MESSAGES_READ - 1, message.id)).messages, message];
    const [parent, replies] = await Promise.all([store.find(message.parentId), store.repliesBefore(message.parentId, message.id, THREAD_REPLIES_READ - 1)]);
    return [...(parent ? [parent] : []), ...replies.messages, message];
  }

  /**
   * Posts what `bot`, @ember or an agent, `said` to `message`, its answer in Markdown, as its reply: in
   * `message`'s thread when it's in one, only there, with the pictures it shows in a card under it and
   * the cards of the Slack payloads it writes after that, the pages it came from after it, and a preview
   * of its first web link below it, as the composer adds one, the pictures, in its cards too, and the
   * link only at addresses people wrote or of the pages it came from, and the link
   * on none of Ember's own `addresses` (`answerOf`). Like a bot's reply, it reaches the room as any
   * message does, but goes to no bot, @ember and the agents among them. It's posted only while Ember AI
   * is on and the bot in the room, and `message` still there, so that turning Ember AI off, deleting the
   * agent, taking the bot out of the room or deleting the question while the model answers posts
   * nothing. Answers why the room keeps nothing of it, if it doesn't.
   */
  private async postAnswer(roomId: RoomId, bot: User, said: Said, message: Message, addresses: readonly string[]): Promise<string | null> {
    const answer = answerOf(said.text, said.sources, said.written, addresses, bot.name);
    const preview = answer.firstLink === null ? null : await this.previewOf(answer.firstLink);
    const access = await workspace(this.env).answererIn(roomId, bot.id, message.creator.id);
    return this.serially(async () => {
      if (await this.isDeleted()) return "the room is gone";
      if (!access || (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt))) return answererGone(bot.id);
      const store = this.storeFor(roomId);
      if (!(await this.findUndeleted(store, message.id))) return "the message is gone";
      const inThread = message.parentId === undefined ? undefined : await this.inThread(store, message.parentId, false);
      if (inThread === null) return THREAD_GONE;
      const body = await this.answerBody(answer, preview);
      if (typeof body === "string") return body;
      await this.create(store, access.bot, crypto.randomUUID(), body, new Date().toISOString(), { kind: "reply", inThread });
      return null;
    });
  }

  /** What the room keeps of `answer`, with `preview` below it, unless the room can't keep the preview, or why it keeps nothing. */
  private async answerBody({ markup, cards }: Answer, preview: LinkPreview | null): Promise<StoredBody | string> {
    const previewed = preview && (await this.prepareWithCards(`${markup}${previewAttachment(preview)}`, cards));
    return previewed && typeof previewed !== "string" ? previewed : this.prepareWithCards(markup, cards);
  }

  /** The preview of `url`, as the composer would show one, or null when it has none, or none can be had. */
  private async previewOf(url: string): Promise<LinkPreview | null> {
    return unfurler(this.env)
      .unfurl(url)
      .catch((error: unknown) => {
        console.error("Could not unfurl the link in Ember AI's answer", error);
        return null;
      });
  }

  /**
   * Runs `work`, the room hearing that `bot` is typing until it's done: in thread `threadId`, if there is
   * one, else in the room, and again every few seconds, as apps forget typing they've stopped hearing of.
   * While other work of the bot's goes on there, it's still typing once this is done, which the room says
   * again, as apps stop showing someone typing once a message of theirs arrives.
   */
  private async typingWhile<T>(bot: User, threadId: string | undefined, work: () => Promise<T>): Promise<T> {
    const typing = (typing: boolean) => this.broadcast({ type: "typing", user: bot, typing, ...(threadId !== undefined && { threadId }) });
    const typist = `${bot.id} ${threadId ?? ""}`;
    this.typists.set(typist, (this.typists.get(typist) ?? 0) + 1);
    typing(true);
    const again = setInterval(() => typing(true), TYPING_AGAIN_MS);
    try {
      return await work();
    } finally {
      clearInterval(again);
      const jobs = this.typists.get(typist)! - 1;
      if (jobs === 0) this.typists.delete(typist);
      else this.typists.set(typist, jobs);
      typing(jobs > 0);
    }
  }

  /**
   * Sends new messages' pushes, as the Workspace still allows each when its turn comes, and has it forget
   * the subscriptions they found gone.
   */
  private async push(pushes: MessagePush[]): Promise<void> {
    const gone = await sendPushes(this.env, pushes, (id) => workspace(this.env).pushable(id));
    if (gone.length === 0) return;
    await workspace(this.env)
      .forgetPushSubscriptions(gone)
      .catch((error: unknown) => console.error(`Error in WebPush::Pool.invalid_subscription_handler: ${error}`));
  }

  /**
   * Sends the search index the messages written, edited, boosted or deleted longest ago that it hasn't
   * taken, as many as one call takes, as they are now, and forgets them once it has. Answers how many it
   * sent.
   */
  private async sendMessages(roomId: RoomId): Promise<number> {
    const log = this.logFor(roomId);
    const logged = await log.unindexed(ENTRIES_PER_CALL);
    if (logged.length === 0) return 0;
    // Read after the log, so each is as new as the change that logged it, or newer.
    const ids = [...new Set(logged.map(({ messageId }) => messageId))];
    const messages = await this.storeFor(roomId).indexable(ids);
    const kept = new Set(messages.map(({ id }) => id));
    const seq = logged.at(-1)!.seq;
    await searchIndex(this.env).apply(roomId, seq, messages, ids.filter((id) => !kept.has(id)));
    await log.indexed(seq);
    return logged.length;
  }

  /**
   * Has R2 delete the files the room has marked deleted, as many as one call takes, with their previews,
   * then forgets them, and answers how many. Uploads still unfinished a day after they started are
   * marked first, and their uploads in parts aborted. Without a bucket, the room only forgets them.
   */
  private async purgeFiles(roomId: RoomId): Promise<number> {
    const blobs = this.blobsFor(roomId);
    const deleted = await this.serially(async () => {
      const now = Date.now();
      await blobs.deleteUnfinished(new Date(now - UNFINISHED_UPLOAD_KEPT_MS).toISOString(), new Date(now).toISOString());
      return blobs.deleted(ENTRIES_PER_CALL);
    });
    if (deleted.length === 0) return 0;
    const files = this.env.FILES;
    if (files) {
      // An abort that fails, as one of an upload R2 has put together or forgotten does, is left to R2,
      // which aborts an unfinished upload a week after it started.
      const aborting = deleted.map(({ id, unfinishedUploadId }) => unfinishedUploadId && files.resumeMultipartUpload(objectKey(id), unfinishedUploadId).abort().catch(() => {}));
      await Promise.all(aborting);
      await files.delete(deleted.flatMap(({ id }) => [objectKey(id), previewKey(id)]));
    }
    await this.serially(() => blobs.forget(deleted.map(({ id }) => id)));
    return deleted.length;
  }

  /**
   * Sets the alarm to send the room's logs at `time`, unless it's set for sooner, and answers whether it
   * did. A deleted room's alarm is for erasing it, so it's left as it is; this runs one event at a time
   * with deleting it, so the deletion's alarm can't be overtaken.
   */
  private wakeAt(roomId: RoomId, time: number): Promise<boolean> {
    return this.serially(async () => {
      if (await this.isDeleted()) return false;
      await this.ctx.storage.put(UNDELIVERED_ROOM, roomId);
      const due = await this.ctx.storage.get<number>(LOGS_DUE);
      if (due === undefined || due > time) await this.ctx.storage.put(LOGS_DUE, time);
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > time) await this.ctx.storage.setAlarm(time);
      return true;
    });
  }

  /**
   * Sets the alarm to check the room's huddle by `time`, unless it's set for sooner. A deleted room's
   * alarm is left as it is, as `wakeAt` leaves it, and like it this runs one event at a time with
   * deleting the room.
   */
  private async checkHuddleBy(time: number): Promise<void> {
    if (await this.isDeleted()) return;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > time) await this.ctx.storage.setAlarm(time);
  }

  /**
   * Whether the Workspace has deleted the room, which a request it let through just before can still
   * find, as can a delivery to a bot's webhook still waiting its turn once the alarm has erased the room.
   */
  private async isDeleted(): Promise<boolean> {
    return this.erased || (await this.ctx.storage.get(DELETED_ROOM)) !== undefined;
  }

  /**
   * The room's own sockets, all of them or those carrying `tag`: every socket but the huddle's, whose
   * people hear of the huddle alone, and aren't in the room for being in it.
   */
  private roomSockets(tag?: string): WebSocket[] {
    const sockets = tag === undefined ? this.ctx.getWebSockets() : this.ctx.getWebSockets(tag);
    const inHuddle = this.ctx.getWebSockets(HUDDLE_TAG);
    if (inHuddle.length === 0) return sockets;
    const huddle = new Set(inHuddle);
    return sockets.filter((socket) => !huddle.has(socket));
  }

  /** Everyone with at least one open socket, once each. */
  private present(): User[] {
    const users = new Map<string, User>();
    for (const socket of this.roomSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const { user } = socket.deserializeAttachment() as Attachment;
      users.set(user.id, user);
    }
    return [...users.values()];
  }

  /** Whether someone has the room open in a socket other than `except`. */
  private isPresent(userId: UserId, except?: WebSocket): boolean {
    return this.roomSockets(userId).some((socket) => socket !== except && socket.readyState === WebSocket.OPEN);
  }

  /** Closes `socket` with `code` for a revocation, if it's open, and answers whose it was. */
  private close(socket: WebSocket, code: CloseCode): User | null {
    if (socket.readyState !== WebSocket.OPEN) return null;
    const attachment = socket.deserializeAttachment() as Attachment;
    socket.serializeAttachment({ ...attachment, revoked: true } satisfies Attachment);
    socket.close(code, CLOSE_REASONS[code]);
    return attachment.user;
  }

  /** Lets everyone know a socket has closed, unless the room closed it for a revocation and said so already. */
  private leave(ws: WebSocket): void {
    const { user, revoked, typing } = ws.deserializeAttachment() as Attachment;
    if (!revoked) this.depart(user, ws, typing === true);
  }

  /**
   * Tells the room that `user` closed a socket, `closed` if it's just the one, and has left if it was
   * their last. Closing one of several tabs stops the typing it was doing, if it was: telling everyone
   * whenever any tab closes was a message to everyone in a busy room for each room someone switched
   * away from, and cleared the typing another of their tabs was doing.
   */
  private depart(user: User, closed?: WebSocket, typing = true): void {
    if (!this.isPresent(user.id, closed)) this.broadcast({ type: "presence.left", userId: user.id }, closed);
    else if (typing) this.broadcast({ type: "typing", user, typing: false }, closed);
  }

  private refuse(ws: WebSocket, message: string): void {
    this.send(ws, { type: "error", message });
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // The socket closed between lookup and send; its close handler cleans up.
    }
  }

  private broadcast(frame: ServerFrame, except?: WebSocket): void {
    const data = JSON.stringify(frame);
    for (const socket of this.roomSockets()) {
      if (socket === except) continue;
      try {
        socket.send(data);
      } catch {
        // As above.
      }
    }
  }
}
