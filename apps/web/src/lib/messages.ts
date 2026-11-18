import type { Message, UserId } from "@ember/protocol";
import { displayMarkup, type DisplayElement, type DisplayNode, type DisplayPreview } from "@ember/richtext/dom";

/**
 * How far apart a person's messages can be, either way, and still group, as Campfire's
 * message_formatter.js has it: five minutes, inclusive.
 */
const THREAD_WINDOW_MS = 5 * 60 * 1000;

export interface TimelineItem {
  message: Message;
  /** Whether the message is the first of its day in the reader's time zone, which a separator dates. */
  firstOfDay: boolean;
  /** Same author as the previous message, shortly after it: show it compactly. */
  threaded: boolean;
}

// Times and dates as Campfire's local_time_controller.js writes them, in the reader's locale and time zone.
// Days are told apart as message_formatter.js tells them, by a formatter's short dates rather than by `Date`,
// since a formatter keeps the zone it was made in: should the device's zone change, times, dates and the
// days they separate all stay in the zone the app opened in until the page loads again.
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });
const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });
const monthDayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const yearFormat = new Intl.DateTimeFormat(undefined, { year: "numeric" });
const shortDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** A message's time: "3:04 PM". */
export const timeLabel = (date: Date) => timeFormat.format(date);
/** A day separator's date: "October 12, 2026". */
export const dateLabel = (date: Date) => dateFormat.format(date);
/** What a time or a separator's date shows on hover: "10/12/26, 3:04 PM". */
export const dateTimeLabel = (date: Date) => dateTimeFormat.format(date);

/** The day `date` falls on, as of `now`: today, yesterday, or its date, "Oct 12", or "Oct 12, 2025" in another year. */
function dayAsOf(date: Date, now: Date): { near: "today" | "yesterday" } | { on: string } {
  const day = dayFormat.format(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day === dayFormat.format(now)) return { near: "today" };
  if (day === dayFormat.format(yesterday)) return { near: "yesterday" };
  return { on: (yearFormat.format(date) === yearFormat.format(now) ? monthDayFormat : shortDateFormat).format(date) };
}

/**
 * When a thread's newest reply came, as the thread's summary says it, as of `now`: "today at 3:04 PM",
 * "yesterday at 3:04 PM", "on Oct 12", or "on Oct 12, 2025" in another year. A narrow summary, as on a
 * phone, says it `short`: today's time, or "yesterday".
 */
export function lastReplyLabel(date: Date, now = new Date()): { long: string; short: string } {
  const day = dayAsOf(date, now);
  if ("on" in day) return { long: `on ${day.on}`, short: `on ${day.on}` };
  return { long: `${day.near} at ${timeLabel(date)}`, short: day.near === "today" ? timeLabel(date) : "yesterday" };
}

/**
 * When a huddle started, as the Huddles page says it, as of `now`: "Today at 3:04 PM", "Yesterday at
 * 3:04 PM", "Oct 12", or "Oct 12, 2025" in another year.
 */
export function huddleStartedLabel(date: Date, now = new Date()): string {
  const day = dayAsOf(date, now);
  return "on" in day ? day.on : `${day.near === "today" ? "Today" : "Yesterday"} at ${timeLabel(date)}`;
}

/** Whether two ISO times fall on the same day in the reader's time zone, as a timeline's separators tell days apart. */
export const sameDay = (a: string, b: string) => dayFormat.format(new Date(a)) === dayFormat.format(new Date(b));

/** The day each message was written, as `dayFormat` writes it, kept with the message, since a timeline asks again on every render. */
const days = new WeakMap<Message, string>();
function dayOf(message: Message): string {
  let day = days.get(message);
  if (day === undefined) days.set(message, (day = dayFormat.format(new Date(message.createdAt))));
  return day;
}

/**
 * The messages as message_formatter.js lays them out. A message is the first of its day when the one above it
 * is from another day. It's threaded, without its author's avatar and name, when the one above it is the
 * same person's from no more than five minutes before or after, even across midnight, when it has a separator
 * and still no header. A message deleted while its thread has replies shows neither its author nor its time,
 * so nothing threads under it, and it threads under nothing. The same goes for a huddle's message, which
 * shows the headphones and what it says of its huddle where its author would be.
 */
export function timeline(messages: Message[]): TimelineItem[] {
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    if (!previous) return { message, firstOfDay: true, threaded: false };
    const [created, before] = [new Date(message.createdAt), new Date(previous.createdAt)];
    return {
      message,
      firstOfDay: dayOf(previous) !== dayOf(message),
      threaded:
        !message.deleted && !previous.deleted && !message.huddle && !previous.huddle && previous.creator.id === message.creator.id && Math.abs(created.getTime() - before.getTime()) <= THREAD_WINDOW_MS,
    };
  });
}

/**
 * The newest of `messages` that the person `userId` signs in wrote, which Up Arrow edits. A huddle's
 * message is in the name of whoever started the huddle, who didn't write it.
 */
export const newestWrittenBy = <T extends Message>(messages: T[], userId: UserId): T | undefined => messages.findLast((message) => message.creator.id === userId && !message.huddle);

/**
 * What Quote writes in the composer (reply_controller.js): what the message shows but its link previews,
 * quoted, with each mention as the bare name `nameOf` gives, then its author with a link to it, and a line
 * to reply on.
 */
export function replyQuote(nodes: DisplayNode[], author: string, link: string, nameOf: (userId: UserId) => string): string {
  const linkToOriginal: DisplayNode = { kind: "element", name: "a", attrs: { href: link }, children: [{ kind: "text", value: "#" }] };
  const quote: DisplayNode[] = [
    { kind: "element", name: "blockquote", attrs: {}, children: quoted(nodes) },
    { kind: "element", name: "cite", attrs: {}, children: [{ kind: "text", value: `${author} ` }, linkToOriginal] },
    { kind: "element", name: "p", attrs: {}, children: [{ kind: "element", name: "br", attrs: {}, children: [] }] },
  ];
  return displayMarkup(quote, ({ userId }) => nameOf(userId));
}

/**
 * What Quote quotes of a bot's message that shows only cards: their plain text, its lines broken as they are, since
 * what a card lays out has no place in a quote.
 */
export function cardsQuote(plainText: string): DisplayNode[] {
  const lines = plainText.split("\n").flatMap((line, index): DisplayNode[] => [...(index > 0 ? [LINE_BREAK] : []), { kind: "text", value: line }]);
  return [{ kind: "element", name: "p", attrs: {}, children: lines }];
}

const LINE_BREAK: DisplayElement = { kind: "element", name: "br", attrs: {}, children: [] };

/**
 * `#stripUnfurledAttachments`: what a message shows, or, when that's only link previews, the address of the
 * first link in them, as a message of only a link shows only its preview.
 */
function quoted(nodes: DisplayNode[]): DisplayNode[] {
  const link = firstPreviewLink(nodes);
  return link && !hasText(nodes) ? [{ kind: "text", value: link }] : nodes;
}

/** Whether there's text outside link previews, where a mention is the name it shows. */
const hasText = (nodes: DisplayNode[]): boolean =>
  nodes.some((node) => node.kind === "mention" || (node.kind === "text" ? node.value.trim() !== "" : node.kind === "element" && hasText(node.children)));

/** The first link in a link preview, as `.og-embed a` finds it, by where it goes. */
function firstPreviewLink(nodes: DisplayNode[]): string | undefined {
  for (const node of nodes) {
    const link = node.kind === "element" ? firstPreviewLink(node.children) : node.kind === "preview" ? previewLink(node) : undefined;
    if (link !== undefined) return link;
  }
  return undefined;
}

/** Where a preview's first link goes: its title's, or else the first address linked in its text. */
function previewLink(preview: DisplayPreview): string | undefined {
  if (preview.href !== undefined) return hrefOf(preview.href);
  const link = firstLink([...preview.title, ...preview.description]);
  return link && hrefOf(link.attrs.href);
}

function firstLink(nodes: DisplayNode[]): DisplayElement | undefined {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    const link = node.name === "a" ? node : firstLink(node.children);
    if (link) return link;
  }
  return undefined;
}

/** A link's `href` as the browser reads it: absolute, or empty for a link without one. */
function hrefOf(href: string | undefined): string {
  if (href === undefined) return "";
  try {
    return new URL(href, location.href).href;
  } catch {
    return href;
  }
}
