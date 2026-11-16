import type { CardAction, CardButton, CardPart } from "@ember/protocol";
import type { AppId } from "@ember/protocol/apps";
import { slackMessage, type SlackMessage, type SlackPayload } from "../bots/slack";
import type { GivenTool } from "./tools";

// The cards connected apps' tools answer with: a tool built for Slack's client answers a call with
// Block Kit blocks beside its text (https://docs.slack.dev/ai/slackbot-mcp-client/returning-rich-responses),
// which the room posts as the tool's card, as it posts a bot's (bots/slack.ts), saying whose it is. As
// Slack shows such a card whole or not at all, so does Ember: one with a block Ember doesn't draw isn't
// shown, and the model, which has the tool's text either way, answers from that. A button on it whose
// `action_id` is `tool:` and a tool's name calls that tool of the same app when it's clicked, with the
// JSON object its `value` writes, and what the tool answers takes the card's place.

/** The most blocks Slack takes of a tool's card. */
const MAX_BLOCKS = 50;

/** The blocks of Slack's that Ember draws (`blockPart`), of those a tool's card may hold. */
const DRAWN = new Set(["header", "section", "context", "divider", "image", "actions", "rich_text", "markdown", "table", "card", "carousel", "video"]);

/** Who clicked which button of a tool's card, by their name and its text. */
export interface Clicked {
  who: string;
  button: string;
}

/**
 * What a tool's card says under the tool's own blocks: whose they are, and which tool answered with
 * them, a model's call, or the click of a button on the card it takes the place of, `clicked`.
 */
export const fromApp = (appName: string, toolName: string, clicked?: Clicked) =>
  clicked ? `From ${appName}, answering ${toolName}, after ${clicked.who} clicked ${clicked.button}.` : `From ${appName}, answering ${toolName}.`;

/** Text shown as it's written, without emoji by name. */
const plainText = (text: string) => ({ type: "plain_text", text, emoji: false });

/** The line under a tool's card, or under what its tool said, that says whose it is. */
const fromLine = (tool: Pick<GivenTool, "appName" | "name">, clicked?: Clicked) => ({ type: "context", elements: [plainText(fromApp(tool.appName, tool.name, clicked))] });

/**
 * The card a room posts for what `tool`'s app answered a call with, `blocks`, its Block Kit blocks as
 * JSON, as a Slack payload: the blocks, and under them whose they are, in plain text, and whose click
 * the call was, if it was one. Null for blocks Ember doesn't draw whole.
 */
export function toolCard(tool: Pick<GivenTool, "appName" | "name">, blocks: string, clicked?: Clicked): SlackPayload | null {
  const listed = listIn(blocks);
  if (listed.length === 0 || listed.length > MAX_BLOCKS || !listed.every(isDrawn)) return null;
  return { blocks: [...listed, fromLine(tool, clicked)] };
}

/** The most characters of what a tool said that a room shows after a click. */
const MAX_SAID_LENGTH = 3_000;

/**
 * The card a room posts for what `tool`'s app answered a click's call with when that's `text` alone,
 * as a Slack payload: the text as it's written, and under it whose it is, and whose click.
 */
export function saidCard(tool: Pick<GivenTool, "appName" | "name">, text: string, clicked: Clicked): SlackPayload {
  const said = text.length > MAX_SAID_LENGTH ? `${text.slice(0, MAX_SAID_LENGTH - 1)}…` : text;
  return { blocks: [{ type: "section", text: plainText(said) }, fromLine(tool, clicked)] };
}

/**
 * A tool's card, `card`, as the room keeps it: its cards, whose buttons that act are those that call
 * a tool of the app `appId` that's one of `picked`, the app's tools its answerer has, by their names,
 * with what an object's JSON writes, each then naming the app. Any other button that acts goes, as
 * nothing would take its click. Null for a card that then shows nothing but whose it is, or that the
 * room couldn't keep whole.
 */
export function toolCards(card: SlackPayload, appId: AppId, picked: ReadonlySet<string>): SlackMessage | null {
  const message = slackMessage(card, true);
  if (typeof message === "string" || !isKeptWhole(Array.isArray(card.blocks) ? card.blocks : [], message)) return null;
  const calls = (action: CardAction) => {
    const call = toolCallOf({ ...action, appId });
    return call !== undefined && picked.has(call.name);
  };
  const cards = message.cards.map(({ parts, ...rest }) => ({ ...rest, parts: parts.flatMap((part) => callingPart(part, appId, calls) ?? []) }));
  // The last part says whose the card is, which is nothing to show by itself.
  return cards.some(({ parts }) => parts.slice(0, -1).some(({ kind }) => kind !== "divider")) ? { ...message, cards } : null;
}

/**
 * Whether the room keeps all that `blocks` show in `kept`, the message they made: a part for each
 * block, and each of their pictures. It leaves out a block that shows nothing here, and a picture at
 * an address it doesn't show, such as one on a host with no name, and a card missing either isn't the
 * card its tool answered with. Buttons aren't counted, as those nothing would answer go either way.
 */
function isKeptWhole(blocks: unknown[], kept: SlackMessage): boolean {
  const parts = kept.cards.flatMap(({ parts }) => parts);
  const shown = blocks.filter((block) => !isObject(block) || block.type !== "actions");
  return shown.length === parts.filter(({ kind }) => kind !== "buttons").length && count(blocks, isPicture) === count(parts, isKeptPicture);
}

/** A picture as a block holds one, by its address or as a file of Slack's, and as a card's part keeps one. */
const isPicture = (value: Record<string, unknown>) => "image_url" in value || "slack_file" in value;
const isKeptPicture = (value: Record<string, unknown>) => typeof value.url === "string" && typeof value.alt === "string";

/** How many of the objects `value` holds, at any depth, `counts` counts. */
function count(value: unknown, counts: (value: Record<string, unknown>) => boolean): number {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + count(item, counts), 0);
  if (!isObject(value)) return 0;
  return Object.values(value).reduce((sum: number, item) => sum + count(item, counts), counts(value) ? 1 : 0);
}

/** `part` with only the buttons that link somewhere or that `calls` says call a tool, each of those naming the app `appId`, or null when that leaves nothing of it. */
function callingPart(part: CardPart, appId: AppId, calls: (action: CardAction) => boolean): CardPart | null {
  const kept = (buttons: CardButton[]) => buttons.flatMap((button) => (!button.action ? [button] : calls(button.action) ? [{ ...button, action: { ...button.action, appId } }] : []));
  if (part.kind === "buttons") {
    const buttons = kept(part.buttons);
    return buttons.length === 0 ? null : { ...part, buttons };
  }
  if (part.kind === "section") {
    const { button, ...rest } = part;
    const [calling] = button ? kept([button]) : [];
    return calling ? { ...rest, button: calling } : rest;
  }
  if (part.kind !== "tiles") return part;
  const tiles = part.tiles.flatMap(({ buttons, ...tile }) => {
    const calling = kept(buttons ?? []);
    return calling.length > 0 ? [{ ...tile, buttons: calling }] : Object.keys(tile).length > 0 ? [tile] : [];
  });
  return tiles.length === 0 ? null : { ...part, tiles };
}

/** A tool's name after `tool:`, as a button of a tool's card names the tool its click calls. */
const TOOL_ACTION = /^tool:([A-Za-z0-9_.-]{1,128})$/;

/** A call a click on a tool's card makes: of which app's tool, by its name, and with what. */
export interface CardCall {
  appId: AppId;
  name: string;
  input: Record<string, unknown>;
}

/**
 * The call the button `action` makes when it's clicked, or undefined for a button that calls no tool:
 * one on no tool's card, one not named `tool:` and a tool's name, or one whose `value` isn't the JSON
 * of an object, as Slack has such a button's be.
 */
export function toolCallOf({ id, value, appId }: CardAction): CardCall | undefined {
  const name = TOOL_ACTION.exec(id)?.[1];
  if (name === undefined || appId === undefined || value === undefined) return undefined;
  try {
    const input: unknown = JSON.parse(value);
    return isObject(input) ? { appId, name, input } : undefined;
  } catch {
    return undefined;
  }
}

/** The list `json` writes, or none. */
function listIn(json: string): unknown[] {
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Whether Ember draws all of `block`: one of the kinds it draws, whose controls, where it has any, are
 * buttons, as a menu, or a field to type in, is left out of a card here, and what's left of a form
 * without them would send its tool less than its server meant.
 */
function isDrawn(block: unknown): boolean {
  if (!isObject(block) || typeof block.type !== "string" || !DRAWN.has(block.type)) return false;
  if (block.type === "actions") return areButtons(block.elements);
  if (block.type === "section") return block.accessory === undefined || isButton(block.accessory) || (isObject(block.accessory) && block.accessory.type === "image");
  if (block.type === "card") return block.actions === undefined || areButtons(isObject(block.actions) ? block.actions.elements : block.actions);
  return block.type !== "carousel" || (Array.isArray(block.elements) && block.elements.every((card) => isObject(card) && card.type === "card" && isDrawn(card)));
}

const isButton = (element: unknown) => isObject(element) && element.type === "button";

const areButtons = (elements: unknown) => Array.isArray(elements) && elements.every(isButton);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
