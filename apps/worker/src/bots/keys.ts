import type { RoomId, UserId } from "@ember/protocol";
import { toHex } from "../encoding";
import { hmacKey } from "../hmac";
import { alphanumeric } from "../ids";

// Bots' keys, and the ones their webhooks' deliveries carry in their stead.

/** A bot's token: 12 random letters and digits, as `SecureRandom.alphanumeric(12)` makes them. */
export const newBotToken = () => alphanumeric(12);

/**
 * A bot's key, which its API's addresses carry: its id, then its token, as `"#{id}-#{bot_token}"`. Ids
 * never have a "-" in them, so the first one ends the id. A bot without a token has one no key matches.
 */
export const botKeyOf = (botId: UserId, token: string | null) => `${botId}-${token ?? ""}`;

/**
 * The bot id and token a key names: what comes before its first "-", and what comes between that and the
 * next. Null unless it has both, so a key without a token finds no bot.
 */
export function botKeyParts(key: string): { botId: UserId; token: string } | null {
  const [botId, token] = key.trim().split("-");
  return botId && token ? { botId, token } : null;
}

const encoder = new TextEncoder();

/** Whether `given` is the bot token `token`, compared in constant time. A bot without a token has none to give. */
export function isBotToken(given: string, token: string | null): boolean {
  if (!token) return false;
  const [a, b] = [encoder.encode(given), encoder.encode(token)];
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}

/** A bot's webhook as its token is made from: the bot's own token, and the URL the webhook delivers to, saved when. */
export interface WebhookTokenSource {
  token: string | null;
  url: string;
  savedAt: string;
}

/** How much of its HMAC a webhook's token keeps, as avatar tokens keep. */
const WEBHOOK_TOKEN_BYTES = 16;

/**
 * The token a delivery to bot `botId`'s webhook gives it in room `roomId`'s address, in place of the
 * bot's own, which never leaves Ember: the first 16 bytes of an HMAC under `secret` of the room, the
 * bot, its token, and its webhook's URL and when that was saved, in hex, so that it has no "-" in it. It
 * opens the bot API in that room alone, and only until the webhook delivers elsewhere or is removed, or
 * the bot is given a new token, whatever the server it was sent to keeps. Null for a bot without a token,
 * which no key works for.
 */
export async function webhookTokenOf(secret: string, roomId: RoomId, botId: UserId, { token, url, savedAt }: WebhookTokenSource): Promise<string | null> {
  if (!token) return null;
  const signed = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(JSON.stringify(["webhook", roomId, botId, token, url, savedAt])));
  return toHex(new Uint8Array(signed, 0, WEBHOOK_TOKEN_BYTES));
}
