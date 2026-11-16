import type { Card, CardAction, CardButton, RoomId, User } from "@ember/protocol";
import { botMessageSlackPath } from "@ember/protocol/bots";
import type { WebhookAccess } from "../workspace";
import { railsJson } from "./rails-json";
import { deliveryOf, type DeliveredMessage } from "./webhooks";

// Clicks on the buttons that act on a bot's cards (packages/protocol/src/cards.ts): the room reports each to
// the webhook of the bot that posted the card, as it delivers a message (webhooks.ts), and the bot answers
// with what takes its card's place, if anything. A click is told as Slack's `block_actions` tells one
// (https://docs.slack.dev/reference/interaction-payloads/block_actions-payload), within what a delivery says.

/** A button that acts. */
export type ActingButton = CardButton & { action: CardAction };

/**
 * The button among `cards`' that act that `clicked` is: the one of its `id`, in the block `blockId` names, or
 * in none without one, with its `value`, or none. Slack makes up a `block_id` for a block without one, so
 * two blocks' buttons may share an `action_id` there, and here their values tell them apart.
 */
export function actingButton(cards: Card[], clicked: CardAction): ActingButton | undefined {
  const isClicked = ({ id, blockId, value }: CardAction) => id === clicked.id && blockId === clicked.blockId && value === clicked.value;
  return cards.flatMap(buttonsOf).find((button): button is ActingButton => button.action !== undefined && isClicked(button.action));
}

function buttonsOf({ parts }: Card): CardButton[] {
  return parts.flatMap((part) => {
    if (part.kind === "buttons") return part.buttons;
    if (part.kind === "section") return part.button ? [part.button] : [];
    return part.kind === "tiles" ? part.tiles.flatMap(({ buttons }) => buttons ?? []) : [];
  });
}

/**
 * What a click's delivery says: what a message's does (`webhookPayload`), of whoever clicked, `clicker`, and
 * the bot's message whose button it was, with `type` `block_actions`, the button in `actions` as Slack
 * names it, clicked at `at`, and in `response_path` where the bot posts a payload to take the message's
 * place later, with the key `room.path` has.
 */
export function clickPayload(
  roomId: RoomId,
  { clicker, roomName }: { clicker: User; roomName: string | null },
  webhook: Pick<WebhookAccess, "bot" | "key">,
  message: DeliveredMessage,
  { text, action }: ActingButton,
  at: number,
): string {
  return railsJson({
    type: "block_actions",
    ...deliveryOf(roomId, { author: clicker, roomName }, webhook, message),
    actions: [
      {
        type: "button",
        action_id: action.id,
        ...(action.blockId !== undefined && { block_id: action.blockId }),
        ...(action.value !== undefined && { value: action.value }),
        text: { type: "plain_text", text },
        action_ts: (at / 1000).toFixed(6),
      },
    ],
    response_path: botMessageSlackPath(roomId, webhook.key, message.id),
  });
}
