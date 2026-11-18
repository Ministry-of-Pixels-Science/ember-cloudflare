import {
  isActionId,
  MAX_ACTION_VALUE_LENGTH,
  MAX_MESSAGE_HTML_LENGTH,
  parseParts,
  showsAnything,
  type Card,
  type CardAction,
  type CardButton,
  type CardColumn,
  type CardContextItem,
  type CardField,
  type CardImage,
  type CardPart,
  type CardTile,
} from "@ember/protocol";
import { cardAddress } from "@ember/richtext";
import { markdownHtml, MAX_MARKDOWN_LENGTH } from "./markdown";
import { anchor, emojiNamed, escapeText, linkHref, mrkdwnHtml, mrkdwnText, plainText, plainTextHtml, utcTime, type Formatting } from "./mrkdwn";

// What a Slack incoming webhook is sent (https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks),
// read into the message a bot posts: its `text`, or, in its place, as Slack shows them, its Block Kit `blocks` as a
// card, and its legacy `attachments`, which alerting tools still send, as cards under it (packages/protocol/src/cards.ts).
// What Slack lets a payload change about who posts and where (`username`, `icon_emoji`, `icon_url`, `channel`,
// `thread_ts`) is left out: the bot posts as itself, to the room whose address the payload was sent to. A Block Kit
// button with an `action_id` and no `url` acts, where the room has somewhere to report its click (clicks.ts).

/** Why Slack's webhooks post nothing, in their words. */
export type SlackError = "invalid_payload" | "no_text" | "too_many_attachments" | "msg_too_long";

/** A payload, as JSON decodes an object. */
export type SlackPayload = Record<string, unknown>;

/** What a payload posts: the message's markup, and its cards. */
export interface SlackMessage {
  markup: string;
  cards: Card[];
}

/** The most attachments Slack takes. */
const MAX_ATTACHMENTS = 100;

/**
 * The payload in the text of a webhook's request: JSON, whatever the request's type says, as tools send it
 * as JSON and as `curl -d` does, or a form's `payload` field. Null when it's neither, or not an object.
 */
export function slackPayloadOf(text: string): SlackPayload | null {
  return payloadOf(text.trimStart().startsWith("{") ? text : new URLSearchParams(text).get("payload"));
}

/** The payload `json` writes, or null when there's none, it isn't JSON, or it isn't an object. */
export function payloadOf(json: string | null): SlackPayload | null {
  if (json === null) return null;
  try {
    const payload: unknown = JSON.parse(json.trim());
    return isObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * The message `payload` posts, as Slack shows it: a card of its blocks in place of its text, which Slack shows
 * beside them only in notifications, or its text when they show nothing here, with a card for each of its
 * attachments; or why it posts nothing. With `acting`, its cards keep their buttons that act.
 */
export function slackMessage(payload: SlackPayload, acting = false): SlackMessage | SlackError {
  const attachments = listOf(payload.attachments);
  if (attachments.length > MAX_ATTACHMENTS) return "too_many_attachments";
  const attachmentBlocks = attachments.flatMap((attachment) => (isObject(attachment) ? listOf(attachment.blocks) : []));
  if (markdownLength([...listOf(payload.blocks), ...attachmentBlocks]) > MAX_MARKDOWN_LENGTH) return "msg_too_long";
  const blocks = blocksCard(listOf(payload.blocks), acting);
  const formatting: Formatting = payload.mrkdwn === false ? "plain" : "mrkdwn";
  const markup = blocks ? "" : mrkdwnHtml(stringOf(payload.text), formatting);
  const cards = [...(blocks ? [blocks] : []), ...attachments.flatMap((attachment) => attachmentCard(attachment, acting) ?? [])];
  if (!shows(markup) && cards.length === 0) return "no_text";
  const tooLong = markup.length > MAX_MESSAGE_HTML_LENGTH || JSON.stringify(cards).length > MAX_MESSAGE_HTML_LENGTH;
  return tooLong ? "msg_too_long" : { markup, cards };
}

/** How much Markdown `blocks` hold in their markdown blocks, which Slack limits across a payload. */
function markdownLength(blocks: unknown[]): number {
  return blocks.reduce((length: number, block) => length + (isObject(block) && block.type === "markdown" ? stringOf(block.text).length : 0), 0);
}

/** A payload's blocks as a card of the parts the room keeps (`parseParts`), or null when they show nothing here but rules. */
function blocksCard(blocks: unknown[], acting: boolean): Card | null {
  const parts = parseParts(blocks.map(blockPart).filter((part) => part !== null), addressOf, acting);
  return showsAnything(parts) ? { source: "blocks", parts } : null;
}

/**
 * A legacy attachment as a card, in its color: its author, linked title, text, fields, image, buttons, blocks
 * and footer, under its pretext and beside its thumbnail, or, when those show nothing, its fallback. Slack formats
 * only the fields its `mrkdwn_in` names, but shows links, mentions, emoji and escapes in all of them. It keeps only
 * the parts and addresses the room keeps (`parseParts`), so one the room would leave out, such as an image whose
 * address is too long, can't hide the fallback.
 */
function attachmentCard(attachment: unknown, acting: boolean): Card | null {
  if (!isObject(attachment)) return null;
  const formatted = new Set(listOf(attachment.mrkdwn_in));
  const formattingOf = (field: string): Formatting => (formatted.has(field) ? "mrkdwn" : "plain");
  const candidates = [
    authorPart(attachment),
    titlePart(attachment),
    textPart(mrkdwnHtml(stringOf(attachment.text), formattingOf("text"))),
    fieldsPart(listOf(attachment.fields), formattingOf("fields")),
    imagePart(attachment.image_url),
    buttonsPart(listOf(attachment.actions)),
    ...listOf(attachment.blocks).map(blockPart),
    footerPart(attachment),
  ].filter((part) => part !== null);
  const parts = parseParts(candidates, addressOf, acting);
  const fallback = textPart(mrkdwnHtml(stringOf(attachment.fallback), "plain"));
  const shown = showsAnything(parts) ? parts : fallback ? [fallback] : [];
  const pretext = mrkdwnHtml(stringOf(attachment.pretext), formattingOf("pretext"));
  if (shown.length === 0 && !shows(pretext)) return null;
  const color = colorOf(attachment.color);
  const thumb = imageOf(attachment.thumb_url);
  return { source: "attachment", ...(color && { color }), ...(shows(pretext) && { pretext }), ...(thumb && { thumb }), parts: shown };
}

/** An attachment's color: one of Slack's names, or a hex color, which Gitea, for one, writes without its `#`. */
function colorOf(value: unknown): string {
  const color = stringOf(value);
  return /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : color;
}

function authorPart(attachment: SlackPayload): CardPart | null {
  const name = mrkdwnText(stringOf(attachment.author_name));
  return name === "" ? null : { kind: "author", name, ...linkOf("href", attachment.author_link), ...linkOf("icon", attachment.author_icon) };
}

function titlePart(attachment: SlackPayload): CardPart | null {
  const text = mrkdwnText(stringOf(attachment.title));
  return text === "" ? null : { kind: "title", text, ...linkOf("href", attachment.title_link) };
}

const textPart = (html: string): CardPart | null => (shows(html) ? { kind: "text", html } : null);

function imagePart(url: unknown): CardPart | null {
  const image = imageOf(url);
  return image ? { kind: "image", image } : null;
}

/** An attachment's fields: each one's title, which Slack never formats, and its value. */
function fieldsPart(fields: unknown[], formatting: Formatting): CardPart | null {
  const shown = fields.flatMap((field): CardField[] => {
    if (!isObject(field)) return [];
    const title = mrkdwnText(stringOf(field.title));
    const value = mrkdwnHtml(stringOf(field.value), formatting);
    const html = shows(value) ? value : "";
    return title === "" && html === "" ? [] : [{ ...(title && { title }), html, short: field.short === true }];
  });
  return shown.length === 0 ? null : { kind: "fields", fields: shown };
}

/** The buttons of an attachment's `actions` or an actions block's `elements`, the block `blockId` names, each in its style. */
function buttonsPart(buttons: unknown[], blockId?: unknown): CardPart | null {
  const shown = buttons.flatMap((button) => buttonOf(button, blockId) ?? []);
  return shown.length === 0 ? null : { kind: "buttons", buttons: shown };
}

/**
 * A button, an attachment's action, whose text is plain text, or a Block Kit button, whose text is a text
 * object, in the block `blockId` names: one that links somewhere, or, without a `url`, one that acts, which has
 * an `action_id`; or null for any other element, or a button with neither, which only an app could answer.
 */
function buttonOf(button: unknown, blockId?: unknown): CardButton | null {
  if (!isObject(button) || (button.type !== undefined && button.type !== "button")) return null;
  const text = isObject(button.text) ? textOf(button.text) : mrkdwnText(stringOf(button.text));
  const href = addressOf(button.url);
  const action = button.url === undefined ? actionOf(button, blockId) : undefined;
  const style = button.style === "primary" || button.style === "danger" ? button.style : undefined;
  return text === "" || (href === undefined && !action) ? null : { text, ...(href !== undefined && { href }), ...(action && { action }), ...(style && { style }) };
}

/** What a click on `button` tells its bot, its `action_id` and `value`, in the block `blockId` names, or undefined when it has no `action_id` a card keeps. */
function actionOf(button: SlackPayload, blockId: unknown): CardAction | undefined {
  if (!isActionId(button.action_id)) return undefined;
  const value = typeof button.value === "string" && button.value.length <= MAX_ACTION_VALUE_LENGTH ? button.value : undefined;
  return { id: button.action_id, ...(isActionId(blockId) && { blockId }), ...(value !== undefined && { value }) };
}

/** An attachment's footer: its text, its icon and its time, `ts`, in seconds. */
function footerPart(attachment: SlackPayload): CardPart | null {
  const text = mrkdwnText(stringOf(attachment.footer));
  const at = numberOf(attachment.ts);
  const known = !Number.isNaN(new Date(at * 1000).getTime());
  if (text === "" && !known) return null;
  return { kind: "footer", ...(text && { text }), ...linkOf("icon", attachment.footer_icon), ...(known && { at }) };
}

/**
 * A Block Kit block (https://docs.slack.dev/reference/block-kit/blocks) as a card's part, or null when it shows
 * nothing here. A block Ember doesn't know keeps the text it carries, and what only an app could answer, such as
 * a menu, or a button with neither an address nor an `action_id`, goes.
 */
function blockPart(block: unknown): CardPart | null {
  if (!isObject(block)) return null;
  switch (block.type) {
    case "header": {
      const text = textOf(block.text);
      return text === "" ? null : { kind: "header", text };
    }
    case "section":
      return sectionPart(block);
    case "context":
      return contextPart(listOf(block.elements));
    case "divider":
      return { kind: "divider" };
    case "image":
      return imageBlockPart(block);
    case "actions":
      return buttonsPart(listOf(block.elements), block.block_id);
    case "rich_text":
      return textPart(richTextHtml(listOf(block.elements)));
    case "markdown":
      return textPart(markdownHtml(stringOf(block.text)));
    case "table":
      return tablePart(block);
    case "card":
      return tilesPart([block]);
    case "carousel":
      return tilesPart(listOf(block.elements));
    case "video":
      return videoPart(block);
    default:
      return textPart(textHtml(block.text));
  }
}

/** A section block: its text and its fields, two to a row, beside an image, or a button. */
function sectionPart(section: SlackPayload): CardPart | null {
  const html = textHtml(section.text);
  const fields = listOf(section.fields).flatMap((field): CardField[] => {
    const value = textHtml(field);
    return shows(value) ? [{ html: value, short: true }] : [];
  });
  if (!shows(html) && fields.length === 0) return null;
  const accessory = isObject(section.accessory) ? section.accessory : undefined;
  const thumb = accessory?.type === "image" ? imageElementOf(accessory) : undefined;
  const button = accessory?.type === "button" ? buttonOf(accessory, section.block_id) : null;
  return { kind: "section", ...(shows(html) && { html }), ...(fields.length > 0 && { fields }), ...(thumb && { thumb }), ...(button && { button }) };
}

/** A context block's small row of text and images. */
function contextPart(elements: unknown[]): CardPart | null {
  const items = elements.flatMap((element): CardContextItem[] => {
    if (isObject(element) && element.type === "image") {
      const image = imageElementOf(element);
      return image ? [{ image }] : [];
    }
    const html = textHtml(element);
    return shows(html) ? [{ html }] : [];
  });
  return items.length === 0 ? null : { kind: "context", items };
}

/** An image block: its image, described by its alt text, under its title. */
function imageBlockPart(block: SlackPayload): CardPart | null {
  const image = imageElementOf(block);
  const title = textOf(block.title);
  return image ? { kind: "image", image, ...(title && { title }) } : null;
}

/** A table block: its rows of cells, and how each column lines its cells up and whether their text wraps. */
function tablePart(table: SlackPayload): CardPart | null {
  const rows = listOf(table.rows).flatMap((row) => {
    const cells = listOf(row);
    return cells.length === 0 ? [] : [cells.map(cellHtml)];
  });
  if (!rows.some((row) => row.some(shows))) return null;
  const columns = listOf(table.column_settings).map((setting): CardColumn => {
    const align = isObject(setting) && (setting.align === "center" || setting.align === "right") ? setting.align : "left";
    return { align, wrap: isObject(setting) && setting.is_wrapped === true };
  });
  return { kind: "table", rows, columns };
}

/** A table's cell as markup: raw text as it's written, a number as its text, and rich text as a rich text block's. */
function cellHtml(cell: unknown): string {
  if (!isObject(cell)) return "";
  switch (cell.type) {
    case "raw_text":
      return plainTextHtml(stringOf(cell.text), false);
    case "raw_number":
      return plainTextHtml(stringOf(cell.text) || (typeof cell.value === "number" && Number.isFinite(cell.value) ? String(cell.value) : ""), false);
    case "rich_text":
      return richTextHtml(listOf(cell.elements));
    default:
      return "";
  }
}

/** Card blocks, one or a carousel's, as small cards in a row. */
function tilesPart(cards: unknown[]): CardPart | null {
  const tiles = cards.flatMap((card) => tileOf(card) ?? []);
  return tiles.length === 0 ? null : { kind: "tiles", tiles };
}

/**
 * A card block: its hero image, its icon, title and subtitle, its body and subtext, and its buttons, which it
 * lists, or holds in an actions block.
 */
function tileOf(card: unknown): CardTile | null {
  if (!isObject(card) || card.type !== "card") return null;
  const hero = isObject(card.hero_image) ? imageElementOf(card.hero_image) : undefined;
  const icon = isObject(card.icon) ? imageElementOf(card.icon) : undefined;
  const title = textOf(card.title);
  const subtitle = textOf(card.subtitle);
  const body = textHtml(card.body);
  const subtext = textHtml(card.subtext);
  const actions = isObject(card.actions) ? listOf(card.actions.elements) : listOf(card.actions);
  const buttons = actions.flatMap((button) => buttonOf(button, card.block_id) ?? []);
  if (!hero && title === "" && subtitle === "" && !shows(body) && !shows(subtext) && buttons.length === 0) return null;
  return {
    ...(hero && { hero }),
    ...(icon && { icon }),
    ...(title && { title }),
    ...(subtitle && { subtitle }),
    ...(shows(body) && { body }),
    ...(shows(subtext) && { subtext }),
    ...(buttons.length > 0 && { buttons }),
  };
}

/** A video block, which can't play here: its title, linked to its page or its video, over its description. */
function videoPart(video: SlackPayload): CardPart | null {
  const title = escapeText(textOf(video.title));
  const href = linkHref(stringOf(video.title_url)) ?? linkHref(stringOf(video.video_url));
  return textPart((title && `<p>${href ? anchor(href, title) : title}</p>`) + textHtml(video.description));
}

/** An image element, or an image block: its address, if a card can show it, and its alt text. */
function imageElementOf(element: SlackPayload): CardImage | undefined {
  const url = addressOf(element.image_url);
  return url === undefined ? undefined : { url, alt: stringOf(element.alt_text).trim() };
}

/** An address in a payload that a card can show, a web address on a named host, or undefined. */
const addressOf = (url: unknown) => (typeof url === "string" ? cardAddress(url, "") : undefined);

/** An attachment's image, which Slack describes with no text, or undefined. */
function imageOf(url: unknown): CardImage | undefined {
  const address = addressOf(url);
  return address === undefined ? undefined : { url: address, alt: "" };
}

/** `{ [key]: address }` for an address in a payload that a card can show, to spread into a part, or nothing. */
function linkOf<Key extends string>(key: Key, link: unknown): { [key in Key]?: string } {
  const address = addressOf(link);
  return address === undefined ? {} : ({ [key]: address } as { [key in Key]?: string });
}

/** A text object, as markup: `mrkdwn` formatted, and `plain_text` as it is, with emoji by name unless it says not to. */
function textHtml(text: unknown): string {
  if (!isObject(text)) return "";
  if (text.type === "mrkdwn") return mrkdwnHtml(stringOf(text.text));
  return text.type === "plain_text" ? plainTextHtml(stringOf(text.text), text.emoji !== false) : "";
}

/** A text object as plain text, as Slack shows a header or a button: `mrkdwn` without its formatting, and `plain_text` as it is. */
function textOf(text: unknown): string {
  if (!isObject(text)) return "";
  if (text.type === "mrkdwn") return mrkdwnText(stringOf(text.text), "mrkdwn");
  return text.type === "plain_text" ? plainText(stringOf(text.text), text.emoji !== false) : "";
}

/** A rich text block's elements: sections, quotes, preformatted text, and lists, each nested as deep as its indent. */
function richTextHtml(elements: unknown[]): string {
  let html = "";
  let lists: SlackPayload[] = [];
  for (const element of elements) {
    if (isObject(element) && element.type === "rich_text_list") {
      lists.push(element);
      continue;
    }
    html += listsHtml(lists) + richTextElementHtml(element);
    lists = [];
  }
  return html + listsHtml(lists);
}

/** One of a rich text block's elements other than a list: a section, a quote, or preformatted text. */
function richTextElementHtml(element: unknown): string {
  if (!isObject(element)) return "";
  const inline = inlineHtml(listOf(element.elements));
  switch (element.type) {
    case "rich_text_section":
      return inline && `<p>${inline}</p>`;
    case "rich_text_quote":
      return inline && `<blockquote><p>${inline}</p></blockquote>`;
    case "rich_text_preformatted":
      return inline && `<pre>${inline.replace(/<br>/g, "\n")}</pre>`;
    default:
      return "";
  }
}

/**
 * A run of rich text lists, as Slack sends a nested list: one a level deeper than the last nests in its last
 * item, and one back out continues the list at its level, or starts one when its style differs.
 */
function listsHtml(lists: SlackPayload[]): string {
  let html = "";
  const open: { tag: "ul" | "ol"; indent: number }[] = [];
  for (const list of lists) {
    const items = listOf(list.elements).flatMap((item) => {
      const inline = isObject(item) ? inlineHtml(listOf(item.elements)) : "";
      return shows(inline) ? [inline] : [];
    });
    if (items.length === 0) continue;
    const tag = list.style === "ordered" ? "ol" : "ul";
    const indent = typeof list.indent === "number" ? list.indent : 0;
    while (open.length > 0 && (open.at(-1)!.indent > indent || (open.at(-1)!.indent === indent && open.at(-1)!.tag !== tag))) {
      html += `</li></${open.pop()!.tag}>`;
    }
    if (open.at(-1)?.indent === indent) {
      html += items.map((item) => `</li><li>${item}`).join("");
    } else {
      open.push({ tag, indent });
      html += `<${tag}><li>${items.join("</li><li>")}`;
    }
  }
  return html + open.reverse().map(({ tag }) => `</li></${tag}>`).join("");
}

/** A rich text section's elements as markup, its line breaks `<br>`, without one at its end. */
function inlineHtml(elements: unknown[]): string {
  const html = elements.map(inlineElementHtml).join("");
  // Counted off the end: `/(?:<br>)+$/` would try to end each run of breaks inside the markup at its end.
  let end = html.length;
  while (html.endsWith("<br>", end)) end -= "<br>".length;
  return html.slice(0, end);
}

/** One of a rich text section's elements: text, a link, an emoji, a mention, a date or a color. */
function inlineElementHtml(element: unknown): string {
  if (!isObject(element)) return "";
  switch (element.type) {
    case "text":
      return styled(escapeText(stringOf(element.text)).replace(/\n/g, "<br>"), element.style);
    case "link": {
      const url = stringOf(element.url);
      const href = linkHref(url);
      const text = styled(escapeText(stringOf(element.text) || url), element.style);
      return href ? anchor(href, text) : text;
    }
    case "emoji":
      return emojiNamed(stringOf(element.name), typeof element.skin_tone === "number" ? element.skin_tone : undefined) ?? escapeText(`:${stringOf(element.name)}:`);
    case "user":
      return escapeText(`@${stringOf(element.user_id)}`);
    case "usergroup":
      return escapeText(`@${stringOf(element.usergroup_id)}`);
    case "channel":
      return escapeText(`#${stringOf(element.channel_id)}`);
    case "broadcast":
      return escapeText(`@${stringOf(element.range)}`);
    case "date": {
      const text = escapeText(stringOf(element.fallback) || utcTime(numberOf(element.timestamp)));
      const href = linkHref(stringOf(element.url));
      return href ? anchor(href, text) : text;
    }
    case "color":
      return escapeText(stringOf(element.value));
    default:
      return "";
  }
}

/** Rich text's `html` in the styles `style` turns on: code, struck through, underlined, in italics and in bold. */
function styled(html: string, style: unknown): string {
  if (!isObject(style) || html === "") return html;
  let styledHtml = html;
  if (style.code === true) styledHtml = `<code>${styledHtml}</code>`;
  if (style.strike === true) styledHtml = `<s>${styledHtml}</s>`;
  if (style.underline === true) styledHtml = `<u>${styledHtml}</u>`;
  if (style.italic === true) styledHtml = `<em>${styledHtml}</em>`;
  if (style.bold === true) styledHtml = `<strong>${styledHtml}</strong>`;
  return styledHtml;
}

/** Whether markup shows anything: text beside its tags that isn't all space. */
const shows = (html: string) => html.replace(/<[^>]*>/g, "").trim() !== "";

const isObject = (value: unknown): value is SlackPayload => typeof value === "object" && value !== null && !Array.isArray(value);

const stringOf = (value: unknown) => (typeof value === "string" ? value : "");

/** A number in a payload, written as one or as text, or NaN for anything else. */
const numberOf = (value: unknown) => (typeof value === "number" || typeof value === "string" ? Number(value) : NaN);

/** A list in a payload: an array, or one written as JSON in a string, as Slack's forms take one; or none. */
function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const list: unknown = JSON.parse(value);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
