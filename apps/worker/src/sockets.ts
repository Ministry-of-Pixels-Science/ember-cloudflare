import { CloseCode } from "@ember/protocol";
import { HuddleCloseCode } from "@ember/protocol/huddles";

// What rooms and the Workspace, the Durable Objects that keep sockets, share about closing them.

/** The code a socket that sent a frame too large to read closes with (RFC 6455, section 7.4.1). */
export const TOO_LARGE = 1009;

/** What a socket closed with each code says, for anyone reading the close. */
export const CLOSE_REASONS: Record<CloseCode | HuddleCloseCode | typeof TOO_LARGE, string> = {
  [CloseCode.Reconnect]: "Reconnect",
  [CloseCode.Revoked]: "Revoked",
  [CloseCode.NotFound]: "NotFound",
  [HuddleCloseCode.Full]: "Full",
  [HuddleCloseCode.Off]: "Off",
  [HuddleCloseCode.Moved]: "Moved",
  [TOO_LARGE]: "Message too big",
};

/**
 * A socket that closes with `code` as soon as it opens: a browser can't read why an upgrade was refused.
 * wrangler dev logs "Uncaught Error: Network connection lost." as each one finishes closing, even after
 * a clean close handshake: the runtime raises it once the close event has fired, where nothing here can
 * catch it, and the Worker's tests, which have no network between them and the Worker, never see it.
 */
export function closedAtOnce(code: CloseCode | HuddleCloseCode): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, CLOSE_REASONS[code]);
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Close codes that only report how a socket closed, like 1006 for a dropped connection, and can't
 * be sent in a close frame (RFC 6455, section 7.4.1).
 */
export const RESERVED_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

/**
 * The most bytes a frame from a client can take on a room's socket. The largest the app sends, a message
 * of `MAX_MESSAGE_HTML_LENGTH` characters, is under 601 KB however JSON escapes them.
 */
export const MAX_ROOM_FRAME_SIZE = 1 << 20;

/** The most bytes a frame from a client can take on a workspace socket, which takes only pings. */
export const MAX_WORKSPACE_FRAME_SIZE = 1 << 10;

/** Whether `raw`, a frame from a client, takes more than `limit` bytes, counting text in UTF-8, as it came. */
export function isTooLarge(raw: string | ArrayBuffer, limit: number): boolean {
  if (typeof raw !== "string") return raw.byteLength > limit;
  // Each code unit took one byte to three, so only text between those bounds needs counting.
  if (raw.length > limit) return true;
  if (raw.length * 3 <= limit) return false;
  return new TextEncoder().encode(raw).byteLength > limit;
}

/**
 * Closes `ws`, which sent a frame too large to read, with the code for one (RFC 6455, section 7.4.1).
 * Reading it would hold up every other socket the Durable Object serves.
 */
export function closeTooLarge(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN) ws.close(TOO_LARGE, CLOSE_REASONS[TOO_LARGE]);
}
