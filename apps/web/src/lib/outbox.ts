import { CloseCode, MAX_CHECKED_MESSAGES, parseServerFrame, type ClientFrame, type ServerFrame, type User } from "@ember/protocol";
import { roomSocketUrl } from "./api";
import { reconnectingSocket, type ReconnectingSocket } from "./reconnecting-socket";
import { dequeued, isPending, isQueued, notSent, unconfirmed, type PendingMessage, type RoomState } from "./room-state";

/**
 * A room's messages, and replies in its threads, that this page left unsent as their views went, as when
 * the room is left, or a thread closed, while the room is away. A socket of the outbox's own sends them,
 * or asks the room about them, as their views would have once the room let them in, and they wait here,
 * as their views would show them by now, for the room's next view, or their thread's, to take back.
 */
interface Outbox {
  /** In the order they were written: waiting to be sent, sent without the room saying it has them, or not sent. */
  messages: PendingMessage[];
  socket: ReconnectingSocket | null;
}

/** By room. */
const outboxes = new Map<string, Outbox>();

/**
 * What a view showing `state` leaves unsent as it goes: what was written while the room was away, and
 * what went without the room saying it has it, which it may never have had, but for what went over the
 * socket open now, which reaches the room as it closes. A file's upload answers for it, a message shown
 * as not sent has said so, and a room that's gone takes nothing more.
 */
export function leftUnsent({ messages, status, connections }: RoomState): PendingMessage[] {
  if (status === "gone") return [];
  const goesAsItCloses = (m: PendingMessage) => status === "open" && m.sentOver === connections;
  return messages.filter((m): m is PendingMessage => isPending(m) && !m.failed && !m.upload && !goesAsItCloses(m));
}

/**
 * Keeps `messages`, which a view of room `roomId` leaves unsent as it goes, sending them meanwhile, in
 * the order they were written, which a room left with its thread open hands over a view at a time. The
 * outbox sends, or connects, once every view going has handed over, and every view opening taken back.
 */
export function handOver(roomId: string, messages: PendingMessage[]): void {
  if (messages.length === 0) return;
  const outbox = outboxes.get(roomId) ?? { messages: [], socket: null };
  outboxes.set(roomId, outbox);
  outbox.messages = [...outbox.messages, ...messages].sort(byWritten);
  queueMicrotask(() => (outbox.socket ? deliver(outbox) : connect(roomId, outbox)));
}

const byWritten = (a: PendingMessage, b: PendingMessage) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

/**
 * Takes back what `me` left unsent in room `roomId`'s timeline, or in the thread of its message
 * `parentId`, as the outbox has it now, for the view opening there to send, ask about, or show as not sent.
 */
export function takeBack(roomId: string, me: User, parentId?: string): PendingMessage[] {
  const outbox = outboxes.get(roomId);
  if (!outbox) return [];
  const isFor = (m: PendingMessage) => m.creator.id === me.id && m.parentId === parentId;
  const taken = outbox.messages.filter(isFor);
  outbox.messages = outbox.messages.filter((m) => !isFor(m));
  settle(roomId, outbox);
  return taken;
}

/** Whether the room has more to hear about `m`: that it's to be sent, or, sent already, whether it has it. */
const isUnsettled = (m: PendingMessage) => !m.failed;

/**
 * Opens the outbox's socket, a hidden tab's, so that the room reads nothing for it, unless it has one,
 * or nothing to send or ask about.
 */
function connect(roomId: string, outbox: Outbox): void {
  if (outbox.socket || !outbox.messages.some(isUnsettled)) return;
  outbox.socket = reconnectingSocket({
    url: () => roomSocketUrl(roomId, { visible: false }),
    onMessage: (data) => {
      const frame = parseServerFrame(data);
      if (frame) hear(roomId, outbox, frame);
    },
    // As a view shows what was waiting as not sent once it's been without the room a while.
    onOffline: (offline) => offline && giveUp(roomId, outbox),
    // A room that's gone for the person, or a person who has lost access, takes nothing more.
    onClose: (code) => {
      if (code !== CloseCode.Revoked && code !== CloseCode.NotFound) return true;
      giveUp(roomId, outbox);
      return false;
    },
  });
}

/** What the room says, as it bears on the messages the outbox keeps: as it does on a view's. */
function hear(roomId: string, outbox: Outbox, frame: ServerFrame): void {
  switch (frame.type) {
    case "welcome":
    case "resumed":
      // Let in as someone else, as when another tab has signed this browser in as them, the page sends
      // none of this person's messages.
      if (outbox.messages.some((m) => isUnsettled(m) && m.creator.id !== frame.you.id)) return giveUp(roomId, outbox);
      outbox.socket!.connected();
      // Those among the room's newest messages, or what changed, the room has.
      outbox.messages = unconfirmed(outbox.messages, frame.messages);
      deliver(outbox);
      break;
    case "message.created":
      outbox.messages = unconfirmed(outbox.messages, [frame.message]);
      break;
    case "message.checked":
      outbox.messages = outbox.messages.flatMap((m) => (frame.stored.includes(m.clientMessageId) ? [] : frame.missing.includes(m.clientMessageId) ? [{ ...m, failed: true }] : [m]));
      break;
    case "error": {
      const refused = frame.clientMessageIds ?? (frame.clientMessageId === undefined ? [] : [frame.clientMessageId]);
      // One refused for what it says goes back to the composer of the view that takes it back, if it can.
      outbox.messages = outbox.messages.map((m) => (refused.includes(m.clientMessageId) ? { ...m, failed: true, ...(frame.rewrite && { rewrite: frame.message }) } : m));
      break;
    }
    default:
      return;
  }
  settle(roomId, outbox);
}

/**
 * Sends what's waiting over the outbox's socket, if the room has let it in, in the order it was written,
 * and asks the room about what went before.
 */
function deliver(outbox: Outbox): void {
  const room = outbox.socket!;
  const asked = outbox.messages.filter((m) => isUnsettled(m) && !m.queued).map((m) => m.clientMessageId);
  for (let i = 0; i < asked.length; i += MAX_CHECKED_MESSAGES) room.send({ type: "message.check", clientMessageIds: asked.slice(i, i + MAX_CHECKED_MESSAGES) });
  const sent = new Set(outbox.messages.filter((m) => isQueued(m) && room.send(createFrame(m))));
  outbox.messages = outbox.messages.map((m) => (sent.has(m) ? dequeued(m) : m));
}

/** What sends `message` as its view would have: a reply to its thread, and to the room too if it was asked to go there. */
function createFrame({ clientMessageId, body, parentId, alsoSent }: PendingMessage): ClientFrame {
  if (parentId === undefined) return { type: "message.create", clientMessageId, body };
  return { type: "message.create", clientMessageId, body, parentId, alsoSend: alsoSent === true };
}

/**
 * Stops sending, as a view does once it's been without the room a while: what's waiting shows as not
 * sent, and what went, the view that takes it back asks about.
 */
function giveUp(roomId: string, outbox: Outbox): void {
  outbox.messages = notSent(outbox.messages);
  outbox.socket?.close();
  outbox.socket = null;
  settle(roomId, outbox);
}

/** Lets the socket go once the room has nothing more to hear, and the outbox once it keeps nothing. */
function settle(roomId: string, outbox: Outbox): void {
  if (!outbox.messages.some(isUnsettled)) {
    outbox.socket?.close();
    outbox.socket = null;
  }
  if (outbox.messages.length === 0 && outboxes.get(roomId) === outbox) outboxes.delete(roomId);
}
