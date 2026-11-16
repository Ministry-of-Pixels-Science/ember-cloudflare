import { ASSISTANT_NAME, isMessageTooLong, MAX_MESSAGE_HTML_LENGTH, parseCards, type Card, type CardAddress, type CardImage, type LinkPreview, type Message, type User, type UserId } from "@ember/protocol";
import { ANSWER_WORDS, MAX_CONVERSATION_LENGTH, maxTokensAt, type AnswerLevels, type WebTool } from "@ember/protocol/assistant";
import { AI_SETTINGS, promptAround, webPromptFor, withInstructions, type AskedIn } from "@ember/protocol/prompts";
import { linkedUrls, OPENGRAPH_EMBED_CONTENT_TYPE, prepareBody, previewContent } from "@ember/richtext";
import { decodeHTMLStrict } from "entities/decode";
import { Marked } from "marked";
import { markdownHtml } from "../bots/markdown";
import { anchor, escapeText, linkHref } from "../bots/mrkdwn";
import { payloadOf, slackMessage } from "../bots/slack";
import { keptCards } from "../cards";
import { isOnHost } from "../unfurl";
import { MAX_SOURCES, type Question, type RefusalReason, type Source, type Turn } from "./gateway";

// What @ember and the AI agents ask their models when someone asks them something, and what they answer
// with. Each reads the conversation it's asked in, each message after its writer's name, and answers in
// Markdown, as its instructions say, thinking and writing as much as its levels allow, @ember's the
// asker's, and searching the web and reading pages while Search the web lets it, which it posts as the
// rich text people write (`markdownHtml`), the pictures it shows in a card under it, as bots' image cards
// are, the cards of the Slack payloads it writes in ```slack blocks after that, as a bot's webhook posts
// them, the pages it came from after it, and a preview of its first link, as the composer adds one below
// a link, the pictures and the link only at addresses people wrote there, or the pages it came from
// (`fetchableIn`). When it can't answer, it says why, in words that say who can do something about it.

/** How many of the room's latest messages @ember reads when it's asked in the room, the question among them. */
export const ROOM_MESSAGES_READ = 20;

/** How many of a thread's latest replies it reads when it's asked in one, the question among them, after the thread's first message. */
export const THREAD_REPLIES_READ = 50;

/** How long @ember waits for its model at the least, which most answers take a fraction of. */
const LEAST_WAIT_MS = 120_000;

/** How long it waits for each token an answer may take, as long as a slow model takes to write one. */
const WAIT_PER_TOKEN_MS = 20;

/**
 * How long @ember waits for its model to answer `question`: the longer, the more it may think and write.
 * The most, High thinking and a Long answer, is under 13 minutes, within the 15 a request on its way
 * keeps a room in memory.
 */
export const waitFor = ({ maxTokens }: Question) => Math.max(LEAST_WAIT_MS, maxTokens * WAIT_PER_TOKEN_MS);

/**
 * Who answers a question: @ember, or an AI agent, by its id, or null for one not saved yet, which an
 * administrator tries, its name, its instructions, an agent's own, or what administrators added to
 * @ember's, if anything, and what Ember adds around them, as administrators changed it, or null for
 * Ember's own.
 */
export interface Answerer {
  id: UserId | null;
  name: string;
  instructions: string;
  promptTemplate: string | null;
}

/** What's read of a message in a conversation: who wrote it, its plain text, whether it shares a file, and whether it was deleted. */
export type ReadMessage = Pick<Message, "creator" | "plainText" | "attachment" | "deleted">;


/** Why a question for @ember gets no answer, which the room logs. */
export class AnswerError extends Error {}

/**
 * What `answerer` asks its model about the question `conversation` ends with, which `asker` asked
 * `where`, at `now`: the conversation it can read, its writers named, how to answer, as its
 * instructions say, how much to think and write, at `levels`, and what it may do on the web,
 * `webTools`, labeled with who asked and who answers. With no tools for searching while Search the web
 * is on, `webSearchOn`, @ember is told the model the asker picked can't search, rather than that an
 * administrator could let it, and with tools, how to answer only searching, and without them, as it's
 * asked again so when AI Gateway doesn't take the one for reading pages, or them all (`ask`).
 */
export function questionFor(
  answerer: Answerer,
  conversation: ReadMessage[],
  asker: User,
  where: AskedIn,
  levels: AnswerLevels,
  now: Date,
  webTools: readonly WebTool[] = [],
  webSearchOn = webTools.includes("search"),
): Question {
  const told = (web: string) => instructionsFor(answerer, asker, where, ANSWER_WORDS[levels.length], now, web);
  return {
    instructions: told(webPromptFor(asker.name, webTools, webSearchOn)),
    ...(webTools.includes("read") && { instructionsWithoutReading: told(webPromptFor(asker.name, webTools.filter((tool) => tool !== "read"), webSearchOn)) }),
    ...(webTools.length > 0 && { instructionsWithoutWeb: told(WEB_TOOLS_REFUSED) }),
    turns: turnsOf(answerer.id, readable(conversation, where.inThread)),
    maxTokens: maxTokensAt(levels),
    thinking: levels.thinking,
    askerId: asker.id,
    ...(answerer.id !== null && { agentId: answerer.id }),
    webTools,
  };
}

/**
 * What `answerer` is told before the conversation: who it is, its instructions, where it's asked, to
 * answer in about `words` words at most, and what it's told of the web, `web`, as its template has it
 * (`promptAround`).
 */
const instructionsFor = ({ id, name, instructions, promptTemplate }: Answerer, asker: User, where: AskedIn, words: number, now: Date, web: string) =>
  withInstructions(promptAround(id, name, asker.name, where, words, web, now, promptTemplate), instructions);

/** What @ember is told when it's asked again without the web, as AI Gateway didn't take its model's tools for it. */
const WEB_TOOLS_REFUSED =
  "You can't search the web or open links this time, as AI Gateway didn't take the tools for them with the model you answer with. When someone asks you to, say so.";

/**
 * The messages of `conversation` @ember reads: the question it ends with, and as many of those before it
 * as fit in `MAX_CONVERSATION_LENGTH` characters, the newest first, but for a thread's first message, which
 * comes before them all.
 */
export function readable<T extends ReadMessage>(conversation: T[], inThread: boolean): T[] {
  const question = conversation.at(-1)!;
  const before = conversation.slice(0, -1);
  const [first, ...replies] = before;
  const candidates = inThread && first ? [first, ...replies.reverse()] : before.reverse();
  const kept = new Set<T>([question]);
  let length = question.plainText.length;
  for (const message of candidates) {
    length += message.plainText.length;
    if (length > MAX_CONVERSATION_LENGTH) break;
    kept.add(message);
  }
  return conversation.filter((message) => kept.has(message));
}

/**
 * The conversation as the model of the answerer `answererId` reads it: each message after its writer's
 * name, a file as its name, and the answerer's own answers as the model's turns, leaving out what was
 * deleted and what has nothing to read. Other bots' messages, @ember's and agents' among them, are read
 * as anyone's.
 */
function turnsOf(answererId: UserId | null, messages: ReadMessage[]): Turn[] {
  return messages.flatMap((message): Turn[] => {
    const text = message.attachment ? `(shares a file, ${message.plainText})` : message.plainText.trim();
    if (message.deleted || text === "") return [];
    return [message.creator.id === answererId ? { role: "assistant", text } : { role: "user", text: `${message.creator.name}: ${text}` }];
  });
}

/**
 * What `people` wrote in the part of `conversation` @ember reads (`readable`), as it reads it: the only
 * text, with the pages its answer came from, whose addresses the answer may have fetched (`answerOf`).
 * Its own answers and bots' messages are left out, as their writers aren't among `people`.
 */
export function writtenBy(people: ReadonlySet<UserId>, conversation: Message[], inThread: boolean): string[] {
  return readable(conversation, inThread).flatMap(({ creator, plainText, deleted }) => (!deleted && people.has(creator.id) ? [plainText] : []));
}

/**
 * @ember's answer as the room posts it: its Markdown as markup, a card of the pictures it shows, then the
 * cards of the Slack payloads it writes, and the first web link it may have a preview of.
 */
export interface Answer {
  markup: string;
  cards: Card[];
  firstLink: string | null;
}

/**
 * Which web addresses, each as a link to it goes, an answer may have fetched: by each reader's app, as a
 * `picture` in its card, and by the Worker, for its `preview`.
 */
interface Fetchable {
  picture(url: string): boolean;
  preview(url: string): boolean;
}

const markdown = new Marked({ gfm: true });

/** The most characters of a page's title that its link among an answer's sources shows. */
const MAX_SOURCE_TITLE_LENGTH = 80;

/**
 * The most markup a link to one of an answer's sources may take, so that all it names take about half of
 * what a message holds at most, leaving the rest to the answer: a page whose address is longer goes unnamed.
 */
const MAX_SOURCE_LINK_LENGTH = MAX_MESSAGE_HTML_LENGTH / (2 * MAX_SOURCES);

/**
 * `text`, the model's answer in Markdown, as the answerer called `name`, @ember unless it's an agent,
 * posts it, without its name in front, where the conversation's form leads some models to write it,
 * with the cards of the Slack payloads it writes (`cardsIn`), then the `sources` it came from, all cut
 * to what one message holds, which cuts the answer, as its sources are what it says it came from: to as
 * many of its cards as fit, each whole, and as much of its Markdown as fits beside them. Only the
 * addresses people wrote in the conversation it read, `written`, and its sources' are fetched for it,
 * and none on Ember's own `ownHosts` for its preview.
 */
export function answerOf(text: string, sources: readonly Source[] = [], written: readonly string[] = [], ownHosts: readonly string[] = [], name = ASSISTANT_NAME): Answer {
  const named = literally(name);
  const answer = text.replace(new RegExp(`^\\s*(?:${named}:|\\*\\*${named}:\\*\\*|\\*\\*${named}\\*\\*:)\\s*(?=\\S)`, "i"), "");
  const fetchable = fetchableIn(written, sources, ownHosts);
  const { prose, cards } = cardsIn(answer, fetchable);
  const whole = answerIn(prose, sources, fetchable, cards);
  if (fits(whole)) return whole;
  const kept = cards.slice(0, largest(cards.length, (count) => fits(cutAt(prose, 0, sources, fetchable, cards.slice(0, count)))));
  if (kept.length < cards.length) {
    const fewer = answerIn(prose, sources, fetchable, kept);
    if (fits(fewer)) return fewer;
  }
  return cutToFit(prose, sources, fetchable, kept);
}

/** A regular expression's source that matches `text` as it's written. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Which web addresses an answer may have fetched: where the links in what people wrote in the
 * conversation @ember read, `written`, go, as their messages show them (`linkedUrls`), and the pages it
 * came from, its `sources`, but for its preview none on Ember's own `ownHosts`, as the composer asks for
 * none. Its model reads what everyone wrote, and pages anyone can write, so an address it made up could
 * carry any of that to a host of anyone's choosing. Only whole addresses count, as the start of one can
 * be another site's: https://example.com starts https://example.com.au/.
 */
function fetchableIn(written: readonly string[], sources: readonly Source[], ownHosts: readonly string[]): Fetchable {
  const addresses = new Set([...written.flatMap(linkedUrls), ...sources.map(({ url }) => url)].map(webAddress));
  const picture = (url: string) => addresses.has(url);
  return { picture, preview: (url) => picture(url) && !isOnHost(url, ownHosts) };
}

/** The language of a fenced code block in which an answer writes a Slack payload, for its cards. */
const CARDS_LANGUAGE = "slack";

/**
 * The Markdown answer `text` writes outside its ```slack blocks, its prose, and the cards of the Slack
 * payloads they hold, as a bot's webhook posts them (`slackMessage`), with only the pictures that are
 * `fetchable`. A payload's own text goes, as the prose is the answer's text. A block whose payload
 * doesn't parse, or posts no card the room keeps, stays the code it's written as, as does one inside a
 * list or a quote.
 */
function cardsIn(text: string, fetchable: Fetchable): { prose: string; cards: Card[] } {
  const tokens = markdown.lexer(text);
  const posted = tokens.map((token) => (token.type === "code" && languageOf(token.lang) === CARDS_LANGUAGE ? slackCardsOf(token.text, fetchable) : null));
  if (posted.every((cards) => cards === null)) return { prose: text, cards: [] };
  // The lexer's blocks are the text as it's written, a block at a time. A blank line in place of each
  // payload keeps the blocks around it apart, as a line after a paragraph or a table would join it.
  const prose = tokens.map(({ raw }, index) => (posted[index] === null ? raw : "\n\n")).join("");
  return { prose, cards: posted.flatMap((cards) => cards ?? []) };
}

/** A fenced code block's language: the first word after its fence, in lowercase, as `slack` in ```Slack json. */
const languageOf = (info: string | undefined) => (info ?? "").trim().split(/\s/)[0]?.toLowerCase();

/**
 * The cards the Slack payload `json` posts, with only the pictures that are `fetchable`, or null when it
 * posts none the room would keep, as when its only part is a picture nobody wrote.
 */
function slackCardsOf(json: string, fetchable: Fetchable): Card[] | null {
  const payload = payloadOf(json);
  const posted = payload && slackMessage(payload);
  if (!posted || typeof posted === "string") return null;
  const cards = parseCards(posted.cards, answerAddress(fetchable));
  return keptCards(cards).cards.length > 0 ? cards : null;
}

/** An address in an answer's card as the answer keeps it: a link wherever it goes, as its Markdown's do, but a picture only when it's `fetchable`. */
const answerAddress =
  (fetchable: Fetchable): CardAddress =>
  (url, use) => {
    if (use === "link") return url;
    const address = webAddress(url);
    return address !== null && fetchable.picture(address) ? address : undefined;
  };

/**
 * The answer `text`, in Markdown, makes, with `cards`, followed by the `sources` it came from that it
 * doesn't link to itself: its rich text, a card of the web pictures it shows that are `fetchable`, then
 * `cards`, and the first of its own web links, not a source's, that may have a preview.
 */
function answerIn(text: string, sources: readonly Source[], fetchable: Fetchable, cards: readonly Card[]): Answer {
  const { images, links, previewed } = webPartsOf(text, fetchable);
  const pictures: Card[] = images.length === 0 ? [] : [{ source: "blocks", parts: images.map((image) => ({ kind: "image", image })) }];
  return { markup: `${markdownHtml(text)}${sourcesHtml(sources, links)}`, cards: [...pictures, ...cards], firstLink: previewed };
}

/**
 * The web pictures Markdown `text` shows that may be fetched, the web addresses it links to, in order,
 * and the first of those that may have a preview.
 */
function webPartsOf(text: string, fetchable: Fetchable): { images: CardImage[]; links: string[]; previewed: string | null } {
  const images: CardImage[] = [];
  const links: string[] = [];
  let previewed: string | null = null;
  markdown.walkTokens(markdown.lexer(text), (token) => {
    if (token.type === "image") {
      const url = webAddressOf(token.href);
      if (url && fetchable.picture(url)) images.push({ url, alt: decodeHTMLStrict(token.text) });
    } else if (token.type === "link") {
      const url = webAddressOf(token.href, token.autolink);
      if (!url) return;
      links.push(url);
      if (previewed === null && fetchable.preview(url)) previewed = url;
    }
  });
  return { images, links, previewed };
}

/** Where a Markdown link or picture to `href` goes, as `markdownHtml` reads it, when that's a web address. */
function webAddressOf(href: string, autolink = false): string | null {
  // An autolink's address is its text, with no character references, though a `www.` one's link has "http://" in front.
  return webAddress(autolink ? href : decodeHTMLStrict(href));
}

/**
 * The markup naming `sources`, the pages an answer that used the web came from, as Anthropic asks of
 * answers from its searches: a line after the answer linking to each, by its page's title, or its host
 * without one, but for those the answer links to itself, `linked`, and those whose address is too long
 * to name in a message, or "" when there's none left to name.
 */
function sourcesHtml(sources: readonly Source[], linked: readonly string[]): string {
  const links = sources.flatMap(({ url, title }) => {
    const address = webAddress(url);
    if (address === null || linked.includes(address)) return [];
    const words = title.replace(/\s+/g, " ").trim();
    const shown = words.length > MAX_SOURCE_TITLE_LENGTH ? `${words.slice(0, MAX_SOURCE_TITLE_LENGTH - 1).trimEnd()}…` : words;
    const link = anchor(address, escapeText(shown || new URL(address).host));
    return link.length > MAX_SOURCE_LINK_LENGTH ? [] : [link];
  });
  return links.length > 0 ? `<p>Sources: ${links.join(", ")}</p>` : "";
}

/** `address` as a web address, as a link to it goes, or null when it isn't one. */
function webAddress(address: string): string | null {
  const url = linkHref(address);
  return url && /^https?:/i.test(url) ? url : null;
}

/**
 * Whether `answer` fits in a message, as the room measures one (`prepareWithCards`): its markup, and its
 * cards as the room keeps them, each no longer than a message's markup may be, and its plain text, with
 * its cards' after it, no longer than a message's.
 */
function fits({ markup, cards }: Answer): boolean {
  const kept = keptCards(cards);
  if (markup.length > MAX_MESSAGE_HTML_LENGTH || JSON.stringify(kept.cards).length > MAX_MESSAGE_HTML_LENGTH) return false;
  const body = prepareBody(markup, () => undefined);
  return body !== null && !isMessageTooLong([body.plainText, kept.plainText].filter((text) => text !== "").join("\n"));
}

/**
 * The answer as much of `text` makes as fits in a message with `cards` and the `sources` it came from
 * after it: its first lines, or the start of its first line when even that doesn't fit, ending with an
 * ellipsis where it's cut. Its Markdown can show more than it's written in, as a numbered list counts
 * up, or a picture's address shows for each reference to it, and a source whose link the cut leaves out
 * is named after it, so each cut is measured as it shows.
 */
function cutToFit(text: string, sources: readonly Source[], fetchable: Fetchable, cards: readonly Card[]): Answer {
  const cutFits = (length: number) => fits(cutAt(text, length, sources, fetchable, cards));
  const lineEnds = Array.from(text.matchAll(/\n/g), ({ index }) => index);
  const lines = largest(lineEnds.length, (count) => cutFits(lineEnds[count - 1]!));
  return cutAt(text, lines > 0 ? lineEnds[lines - 1]! : largest(lineEnds[0] ?? text.length, cutFits), sources, fetchable, cards);
}

/** The answer `text`'s first `length` characters make, ending with an ellipsis to say it's cut, with `cards`, and then the `sources` they don't link to. */
const cutAt = (text: string, length: number, sources: readonly Source[], fetchable: Fetchable, cards: readonly Card[]) =>
  answerIn(`${text.slice(0, length).trimEnd()}\n\n…`, sources, fetchable, cards);

/** The largest count from 0 to `most` that `holds` is true of, as it is of every count below one it's true of. */
function largest(most: number, holds: (count: number) => boolean): number {
  let [low, high] = [0, most + 1];
  while (high - low > 1) {
    const count = Math.floor((low + high) / 2);
    if (holds(count)) low = count;
    else high = count;
  }
  return low;
}

/** `preview` as the attachment the composer adds below a link it has a preview of, as Lexxy writes one. */
export function previewAttachment({ url, image, title, description }: LinkPreview): string {
  const content = previewContent({ href: url, url: image ?? undefined, filename: title, description });
  return `<action-text-attachment content-type="${OPENGRAPH_EMBED_CONTENT_TYPE}" content="${escapeText(content).replace(/"/g, "&quot;")}"></action-text-attachment>`;
}


/** Where each person picks how much @ember thinks and writes for them, and the model it answers them with, as its notes name it. */
const YOUR_LEVELS = "Ember AI on your profile";

/** What @ember says when it can't answer, for each reason it can't, and while its API token doesn't open. */
export const NOTES: Record<RefusalReason | "unopened token", string> = {
  token: `I can't answer right now: Cloudflare didn't take Ember AI's API token. An administrator can give it another under ${AI_SETTINGS}.`,
  account: `I can't answer right now: Cloudflare can't find Ember AI's account. An administrator can set it up again under ${AI_SETTINGS}.`,
  credits: "I can't answer right now: the AI Gateway credits that pay for my model have run out. An administrator can top them up in AI Gateway.",
  model: `I can't answer right now: AI Gateway didn't take my question for its model. An administrator can choose another model under ${AI_SETTINGS}.`,
  retired: `I can't answer right now: Cloudflare no longer runs my model. An administrator can choose another model under ${AI_SETTINGS}.`,
  busy: "I can't answer right now: AI Gateway is turning requests away, or a spend limit was reached. Try again later.",
  neurons:
    "I can't answer right now: Ember AI's Cloudflare account has used the Neurons Workers AI runs my model on free each day, which start again at midnight UTC. An administrator can move the account to Workers Paid, or have AI Gateway's credits pay for Workers AI, to go on before then.",
  "too long": "I can't answer that here: the conversation is longer than my model reads at once. Try asking in a new thread.",
  unanswered: "I couldn't answer: AI Gateway didn't answer in time. Try again in a moment.",
  nothing: "I couldn't answer: my model answered with nothing. Try asking again.",
  "out of room": `I couldn't answer: my model thought for as long as it may before it wrote anything. Try asking again, or choose less Thinking under ${YOUR_LEVELS}.`,
  guardrails: "I can't answer that: AI Gateway's Guardrails blocked the question, or the messages I read with it. An administrator can change what they block in AI Gateway.",
  "guardrails answer": "I can't answer that: AI Gateway's Guardrails blocked my answer. An administrator can change what they block in AI Gateway.",
  dlp: "I can't answer that: AI Gateway's Data Loss Prevention blocked the question, or the messages I read with it. An administrator can change its policies in AI Gateway.",
  "dlp answer": "I can't answer that: AI Gateway's Data Loss Prevention blocked my answer. An administrator can change its policies in AI Gateway.",
  "unopened token": `I can't answer right now: Ember AI's API token no longer opens here. An administrator can set it up again under ${AI_SETTINGS}.`,
};

/** What an agent says instead, for the reasons only administrators, who set it up, can do something about. */
export const AGENT_NOTES: Partial<Record<RefusalReason, string>> = {
  "out of room": `I couldn't answer: my model thought for as long as it may before it wrote anything. Try asking again, or an administrator can choose less Thinking for me under ${AI_SETTINGS}.`,
};

/** What @ember says instead, when it can't answer with the model whoever asked picked, for the reasons they can do something about. */
export const PICKED_MODEL_NOTES: Partial<Record<RefusalReason, string>> = {
  credits: `I can't answer right now: the AI Gateway credits that pay for the model you picked have run out. An administrator can top them up in AI Gateway, or you can pick another model under ${YOUR_LEVELS}.`,
  model: `I can't answer right now: AI Gateway didn't take my question for the model you picked. Pick another model under ${YOUR_LEVELS}.`,
  retired: `I can't answer right now: Cloudflare no longer runs the model you picked. Pick another model under ${YOUR_LEVELS}.`,
  neurons: `I can't answer right now: Ember AI's Cloudflare account has used the Neurons Workers AI runs the model you picked on free each day, which start again at midnight UTC. Pick a model Workers AI doesn't run under ${YOUR_LEVELS}, or an administrator can move the account to Workers Paid, or have AI Gateway's credits pay for Workers AI.`,
};
