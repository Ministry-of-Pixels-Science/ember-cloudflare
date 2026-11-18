import { threadPath, type RoomId, type RoomKind } from "@ember/protocol";
import { REPORTS_PATH, type ReportReason, type ReportSubject } from "@ember/protocol/reports";

// What a push says, of a new message or of an invitation into a huddle, for the service worker to show as it is.

/**
 * How long a push's title and text may be, counted as the bytes they take in its JSON: a push service
 * takes 4,096 bytes at most.
 */
export const MAX_TITLE_BYTES = 256;
export const MAX_BODY_BYTES = 3072;

/** What a push shows, and the page opening it opens. */
export interface PushPayload {
  title: string;
  body: string;
  path: string;
}

/** What a push says of the room its message is in, or its huddle. */
export interface PushedRoom {
  kind: RoomKind;
  /** Null for a DM. */
  name: string | null;
}

/** A reply in a thread, as its push names it: the message it replies to, and its own id. */
export interface PushedReply {
  parentId: string;
  replyId: string;
}

/**
 * A new message's push: a DM's is titled with the sender's name and reads the message's plain text, and
 * any other room's is titled with the room's name and reads "<sender>: <text>". Opening it opens the
 * room, not the message. A reply in a thread, `reply`, is titled "<sender> in a thread" in a DM and
 * "Thread in <room>" elsewhere, and opening it opens the thread at the reply. A title or text too long is
 * cut short, with an ellipsis.
 */
export function messagePayload(roomId: RoomId, room: PushedRoom, senderName: string, plainText: string, reply?: PushedReply): PushPayload {
  const direct = room.kind === "direct";
  const named = direct ? senderName : (room.name ?? "");
  const title = reply === undefined ? named : direct ? `${named} in a thread` : `Thread in ${named}`;
  const body = direct ? plainText : `${senderName}: ${plainText}`;
  const path = reply === undefined ? `/rooms/${roomId}` : threadPath(roomId, reply.parentId, reply.replyId);
  return { title: truncated(title, MAX_TITLE_BYTES), body: truncated(body, MAX_BODY_BYTES), path };
}

/**
 * How long a push service keeps an invitation's push for a browser that's away, in seconds: a minute,
 * where it keeps a message's for weeks, since one that comes much later asks into a huddle that may be over.
 */
export const INVITATION_TTL_SECONDS = 60;

/**
 * The push of an invitation into a room's huddle, which reads as the invitation does where Ember is
 * open: titled with whoever invites, "Invites you to a huddle", and in which room for any but a DM,
 * whose huddle is with them. Opening it opens the room, where the huddle is to join.
 */
export function invitationPayload(roomId: RoomId, room: PushedRoom, inviterName: string): PushPayload {
  const body = room.kind === "direct" ? "Invites you to a huddle" : `Invites you to a huddle in ${room.name ?? ""}`;
  return { title: truncated(inviterName, MAX_TITLE_BYTES), body: truncated(body, MAX_BODY_BYTES), path: `/rooms/${roomId}` };
}

/** How a report's push says why, after what it reports. */
const REPORTED_AS: Record<ReportReason, string> = { spam: " as spam", harassment: " for harassment", other: "" };

/**
 * The push of a report to an administrator, titled "New report", which reads who reported whom and why,
 * and of a message, where it is, naming no DM: "Ada reported Grace's message in general for harassment",
 * "Ada reported Grace's message in a direct message as spam", or "Ada reported Grace". `subjectName` is
 * whoever wrote the message, or the person reported. Opening it opens the Reports list.
 */
export function reportPayload(reporterName: string, subjectName: string, subject: ReportSubject, reason: ReportReason): PushPayload {
  const where = subject.kind === "person" ? "" : subject.room.kind === "direct" ? "'s message in a direct message" : `'s message in ${subject.room.name ?? ""}`;
  const body = `${reporterName} reported ${subjectName}${where}${REPORTED_AS[reason]}`;
  return { title: "New report", body: truncated(body, MAX_BODY_BYTES), path: REPORTS_PATH };
}

/**
 * The push as the service worker reads it, with the count `badge` sets the app's badge to, in the order
 * and escaping Campfire's `encoded_message` writes it, which `JSON.stringify`'s match. Its icon is the
 * workspace's logo.
 */
export const encodedPush = ({ title, body, path }: PushPayload, badge: number): string =>
  JSON.stringify({ title, options: { body, icon: "/account/logo", data: { path, badge } } });

const ELLIPSIS = "…";

/** `text`, cut short with an ellipsis if it takes more than `maxBytes` as a JSON string's contents. */
function truncated(text: string, maxBytes: number): string {
  const characters = [...text];
  if (characters.reduce((bytes, character) => bytes + jsonLength(character), 0) <= maxBytes) return text;
  let used = jsonLength(ELLIPSIS);
  const kept = characters.findIndex((character) => (used += jsonLength(character)) > maxBytes);
  return characters.slice(0, kept).join("") + ELLIPSIS;
}

/**
 * The bytes a character takes in a JSON string: a quote, a backslash and the control characters with
 * short escapes take two, other control characters six (`\u001f`), as does an unpaired surrogate, which
 * `JSON.stringify` escapes too, and anything else its UTF-8.
 */
function jsonLength(character: string): number {
  const code = character.codePointAt(0)!;
  if ('"\\\n\r\t\b\f'.includes(character)) return 2;
  if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) return 6;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}
