import { MAX_MESSAGE_HTML_LENGTH } from "./index.ts";

// A bot's cards: what a Slack incoming webhook's legacy attachments and Block Kit blocks show under the
// message it posts (apps/worker/src/bots/slack.ts), kept as JSON beside the message's body (room migration
// 0034), as a file message keeps its file. Text in a card is rich text in the stored form, as a body is,
// which the room makes with `prepareBody` and clients draw through `displayBody`, never as markup.

/** The most cards a message keeps: Slack's 100 attachments, and the card its blocks make. */
export const MAX_CARDS = 101;
/** The most parts a card keeps: Slack's 50 blocks, after an attachment's own parts. */
const MAX_PARTS = 60;
/** The most fields, buttons, context items, rows or small cards a part keeps. */
const MAX_ITEMS = 100;
/** The most cells a table's row keeps, as Slack's tables have at most 20 columns. */
const MAX_COLUMNS = 20;
/** The most buttons a small card keeps, as Slack's card block takes. */
const MAX_TILE_BUTTONS = 3;
/** The longest plain text a card keeps in a name, title, button or footer, as Slack's text objects take. */
const MAX_TEXT_LENGTH = 3000;
/** The longest address a card keeps, as Slack takes an image's. */
const MAX_URL_LENGTH = 3000;

/**
 * A card under a bot's message: a Slack attachment, framed, with a bar down its left side in its color, or the
 * message's Block Kit blocks, framed without one.
 */
export interface Card {
  /** What it shows: an attachment, whose bar takes its color, or the message's blocks. */
  source: "attachment" | "blocks";
  /** An attachment's bar's color, in lowercase: Slack's `good`, `warning` or `danger`, or a color written `#rrggbb`. */
  color?: string;
  /** Rich text above an attachment's frame, where Slack puts its pretext. */
  pretext?: string;
  /** A small image at the right of an attachment's parts, as Slack shows its thumbnail. */
  thumb?: CardImage;
  parts: CardPart[];
}

/** What a card shows, top to bottom. */
export type CardPart =
  /** Who it's from, in a small row with their icon, linked. */
  | { kind: "author"; name: string; href?: string; icon?: string }
  | { kind: "title"; text: string; href?: string }
  /** A header block's heading. */
  | { kind: "header"; text: string }
  /** Rich text. */
  | { kind: "text"; html: string }
  /** A section block: its rich text over its fields, two to a row, with a thumbnail or a button at their right. */
  | { kind: "section"; html?: string; fields?: CardField[]; thumb?: CardImage; button?: CardButton }
  | { kind: "fields"; fields: CardField[] }
  /** An image, under its title. */
  | { kind: "image"; image: CardImage; title?: string }
  /** A context block's small row of rich text and images. */
  | { kind: "context"; items: CardContextItem[] }
  /** A rule. */
  | { kind: "divider" }
  | { kind: "buttons"; buttons: CardButton[] }
  /** A table block's rows of rich text cells, each column aligned and wrapped as `columns` says. */
  | { kind: "table"; rows: string[][]; columns: CardColumn[] }
  /** Card blocks' small cards: one, or a carousel's, in a row that scrolls sideways. */
  | { kind: "tiles"; tiles: CardTile[] }
  /** A small row at the foot: an icon, text, and a moment in seconds, which shows in its reader's time zone. */
  | { kind: "footer"; text?: string; icon?: string; at?: number };

/** A title in plain text over a value in rich text, taking half the card's width when `short`. */
export interface CardField {
  title?: string;
  html: string;
  short: boolean;
}

export interface CardImage {
  url: string;
  /** What it shows, for screen readers, or "" where the payload doesn't say. */
  alt: string;
}

/**
 * A button, filled for `primary` and red for `danger`: a link, with `href`, or one that acts, with `action`,
 * whose click the room reports to the bot that posted it. A button with both is a link.
 */
export interface CardButton {
  text: string;
  href?: string;
  action?: CardAction;
  style?: "primary" | "danger";
}

/**
 * What a button that acts tells its bot when it's clicked, as a Block Kit button's `action_id` and `value`
 * do, and its block's `block_id`: `id` names the button, which a click finds by it and `blockId`. On the
 * card a connected app's tool answered with, a button calls a tool of that app, `appId`, which only
 * the room writes there.
 */
export interface CardAction {
  id: string;
  blockId?: string;
  value?: string;
  appId?: string;
}

/** The longest `action_id` and `block_id` Slack takes. */
export const MAX_ACTION_ID_LENGTH = 255;
/** The longest `value` Slack takes on a button. */
export const MAX_ACTION_VALUE_LENGTH = 2000;

/** Rich text or an image in a context row. */
export type CardContextItem = { html: string } | { image: CardImage };

/** How a table's column lines up its cells, and whether their text wraps rather than being cut short. */
export interface CardColumn {
  align: "left" | "center" | "right";
  wrap: boolean;
}

/**
 * A card block's small card: an image across its top, an icon beside its title and subtitle in plain text, its
 * body and subtext in rich text, and up to three buttons.
 */
export interface CardTile {
  hero?: CardImage;
  icon?: CardImage;
  title?: string;
  subtitle?: string;
  body?: string;
  subtext?: string;
  buttons?: CardButton[];
}

/** What a card's address is for: a link someone may follow, or a picture each reader's app fetches as it draws the card. */
export type AddressUse = "link" | "picture";

/** An address as a card may keep it for `use`, or undefined for one it can't: the room's rule for links and images. */
export type CardAddress = (url: string, use: AddressUse) => string | undefined;

const COLOR = /^(?:good|warning|danger|#[0-9a-f]{6})$/i;
const ALIGNMENTS = new Set(["left", "center", "right"]);

/**
 * The cards `value` lists, as a message can keep them: each with its parts that are well formed and not
 * too long, of kinds it knows, and the addresses `address` keeps, without whatever else it holds. A card
 * left with nothing to show goes. The room runs it on every message it stores with cards.
 */
export function parseCards(value: unknown, address: CardAddress): Card[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_CARDS).flatMap((card) => parseCard(card, address) ?? []);
}

/**
 * The parts `value` lists as a card keeps them: those that are well formed and not too long, of kinds it
 * knows, with the addresses `address` keeps. A bot's translator keeps the same, so that a part the room
 * would leave out can't take the place of what the card shows without it. Without `acting`, it leaves out
 * the buttons that act, as a card does whose clicks have nowhere to go.
 */
export function parseParts(value: unknown, address: CardAddress, acting = true): CardPart[] {
  return listOf(value)
    .slice(0, MAX_PARTS)
    .flatMap((part) => parsePart(part, address, acting) ?? []);
}

/** Whether parts show anything more than rules. */
export const showsAnything = (parts: CardPart[]) => parts.some((part) => part.kind !== "divider");

function parseCard(value: unknown, address: CardAddress): Card | null {
  if (!isRecord(value) || (value.source !== "attachment" && value.source !== "blocks")) return null;
  const parts = parseParts(value.parts, address);
  if (value.source === "blocks") return showsAnything(parts) ? { source: "blocks", parts } : null;
  const pretext = htmlOf(value.pretext);
  if (!showsAnything(parts) && pretext === undefined) return null;
  const color = typeof value.color === "string" && COLOR.test(value.color) ? value.color.toLowerCase() : undefined;
  const thumb = imageOf(value.thumb, address);
  return { source: "attachment", ...(color && { color }), ...(pretext && { pretext }), ...(thumb && { thumb }), parts };
}

function parsePart(value: unknown, address: CardAddress, acting: boolean): CardPart | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "author": {
      const name = textOf(value.name);
      return name === undefined ? null : { kind: "author", name, ...linked("href", value.href, address, "link"), ...linked("icon", value.icon, address, "picture") };
    }
    case "title": {
      const text = textOf(value.text);
      return text === undefined ? null : { kind: "title", text, ...linked("href", value.href, address, "link") };
    }
    case "header": {
      const text = textOf(value.text);
      return text === undefined ? null : { kind: "header", text };
    }
    case "text": {
      const html = htmlOf(value.html);
      return html === undefined ? null : { kind: "text", html };
    }
    case "section": {
      const html = htmlOf(value.html);
      const fields = itemsOf(value.fields, fieldOf);
      if (html === undefined && fields.length === 0) return null;
      const thumb = imageOf(value.thumb, address);
      const button = buttonOf(value.button, address, acting);
      return { kind: "section", ...(html && { html }), ...(fields.length > 0 && { fields }), ...(thumb && { thumb }), ...(button && { button }) };
    }
    case "fields": {
      const fields = itemsOf(value.fields, fieldOf);
      return fields.length === 0 ? null : { kind: "fields", fields };
    }
    case "image": {
      const image = imageOf(value.image, address);
      const title = textOf(value.title);
      return image ? { kind: "image", image, ...(title && { title }) } : null;
    }
    case "context": {
      const items = itemsOf(value.items, (item) => contextItemOf(item, address));
      return items.length === 0 ? null : { kind: "context", items };
    }
    case "divider":
      return { kind: "divider" };
    case "buttons": {
      const buttons = itemsOf(value.buttons, (button) => buttonOf(button, address, acting));
      return buttons.length === 0 ? null : { kind: "buttons", buttons };
    }
    case "table": {
      const rows = itemsOf(value.rows, rowOf);
      return rows.length === 0 ? null : { kind: "table", rows, columns: listOf(value.columns).slice(0, MAX_COLUMNS).map(columnOf) };
    }
    case "tiles": {
      const tiles = itemsOf(value.tiles, (tile) => tileOf(tile, address, acting));
      return tiles.length === 0 ? null : { kind: "tiles", tiles };
    }
    case "footer": {
      const text = textOf(value.text);
      const at = momentOf(value.at);
      if (text === undefined && at === undefined) return null;
      return { kind: "footer", ...(text && { text }), ...linked("icon", value.icon, address, "picture"), ...(at !== undefined && { at }) };
    }
    default:
      return null;
  }
}

function fieldOf(value: unknown): CardField | null {
  if (!isRecord(value)) return null;
  const title = textOf(value.title);
  const html = htmlOf(value.html);
  if (title === undefined && html === undefined) return null;
  return { ...(title && { title }), html: html ?? "", short: value.short === true };
}

/** A button that links where `address` keeps, or, without an address, with `acting`, one that acts. */
function buttonOf(value: unknown, address: CardAddress, acting: boolean): CardButton | undefined {
  if (!isRecord(value)) return undefined;
  const text = textOf(value.text);
  const href = urlOf(value.href, address, "link");
  const action = value.href === undefined && acting ? actionOf(value.action) : undefined;
  if (text === undefined || (href === undefined && action === undefined)) return undefined;
  const style = value.style === "primary" || value.style === "danger" ? value.style : undefined;
  return { text, ...(href !== undefined && { href }), ...(action && { action }), ...(style && { style }) };
}

function actionOf(value: unknown): CardAction | undefined {
  if (!isRecord(value) || !isActionId(value.id)) return undefined;
  const blockId = isActionId(value.blockId) ? value.blockId : undefined;
  const actionValue = isActionValue(value.value) ? value.value : undefined;
  const appId = isActionId(value.appId) ? value.appId : undefined;
  return { id: value.id, ...(blockId !== undefined && { blockId }), ...(actionValue !== undefined && { value: actionValue }), ...(appId !== undefined && { appId }) };
}

/** Whether `value` can name a button that acts, or its block: text, some but not too much. */
export const isActionId = (value: unknown): value is string => typeof value === "string" && value !== "" && value.length <= MAX_ACTION_ID_LENGTH;

/** Whether `value` can be what a button that acts tells its bot: text, but not too much. */
export const isActionValue = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_ACTION_VALUE_LENGTH;

function imageOf(value: unknown, address: CardAddress): CardImage | undefined {
  if (!isRecord(value)) return undefined;
  const url = urlOf(value.url, address, "picture");
  return url === undefined ? undefined : { url, alt: textOf(value.alt) ?? "" };
}

function contextItemOf(value: unknown, address: CardAddress): CardContextItem | null {
  if (!isRecord(value)) return null;
  if ("image" in value) {
    const image = imageOf(value.image, address);
    return image ? { image } : null;
  }
  const html = htmlOf(value.html);
  return html === undefined ? null : { html };
}

/** A table's row: its cells' rich text, "" for an empty or malformed one. */
function rowOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.slice(0, MAX_COLUMNS).map((cell) => htmlOf(cell) ?? "");
}

function columnOf(value: unknown): CardColumn {
  const align = isRecord(value) && typeof value.align === "string" && ALIGNMENTS.has(value.align) ? (value.align as CardColumn["align"]) : "left";
  return { align, wrap: isRecord(value) && value.wrap === true };
}

function tileOf(value: unknown, address: CardAddress, acting: boolean): CardTile | null {
  if (!isRecord(value)) return null;
  const hero = imageOf(value.hero, address);
  const icon = imageOf(value.icon, address);
  const title = textOf(value.title);
  const subtitle = textOf(value.subtitle);
  const body = htmlOf(value.body);
  const subtext = htmlOf(value.subtext);
  const buttons = itemsOf(value.buttons, (button) => buttonOf(button, address, acting)).slice(0, MAX_TILE_BUTTONS);
  const tile: CardTile = {
    ...(hero && { hero }),
    ...(icon && { icon }),
    ...(title && { title }),
    ...(subtitle && { subtitle }),
    ...(body && { body }),
    ...(subtext && { subtext }),
    ...(buttons.length > 0 && { buttons }),
  };
  return hero || title || subtitle || body || subtext || buttons.length > 0 ? tile : null;
}

/** `{ [key]: url }` for an address `address` keeps for `use`, or nothing, to spread into a part. */
function linked<Key extends string>(key: Key, value: unknown, address: CardAddress, use: AddressUse): { [key in Key]?: string } {
  const url = urlOf(value, address, use);
  return url === undefined ? {} : ({ [key]: url } as { [key in Key]?: string });
}

function urlOf(value: unknown, address: CardAddress, use: AddressUse): string | undefined {
  return typeof value === "string" && value.length <= MAX_URL_LENGTH ? address(value, use) : undefined;
}

/** Plain text a card shows, or undefined for none, or too much. */
const textOf = (value: unknown) => (typeof value === "string" && value.trim() !== "" && value.length <= MAX_TEXT_LENGTH ? value : undefined);

/** A moment in seconds that a date can hold, or undefined. */
const momentOf = (value: unknown) => (typeof value === "number" && !Number.isNaN(new Date(value * 1000).getTime()) ? value : undefined);

/** Rich text a card shows, or undefined for none, or more than a message's body can hold. */
const htmlOf = (value: unknown) => (typeof value === "string" && value !== "" && value.length <= MAX_MESSAGE_HTML_LENGTH ? value : undefined);

/** The items of a list that `parse` keeps, up to `MAX_ITEMS`. */
const itemsOf = <Item>(value: unknown, parse: (item: unknown) => Item | null | undefined) =>
  listOf(value)
    .slice(0, MAX_ITEMS)
    .map(parse)
    .filter((item): item is Item => item !== null && item !== undefined);

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
