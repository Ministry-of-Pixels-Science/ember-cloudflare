import { ASSISTANT_ID, type UserId } from "./index.ts";
import type { WebTool } from "./assistant.ts";

// What @ember and the AI agents are told before the conversation they're asked in, on either side of
// their instructions: who they are, how the chat shows what they write, cards included, what they may
// do on the web, the date, and where they're asked. The Worker sends it to their models, and an agent's
// page shows it around the instructions typed there, so that what it shows is what the model reads.
// Ember writes it from a template, its own or one an administrator changed, whose placeholders it fills
// in each time.

/** Where @ember's and the agents' settings are, which what they're told of what an administrator could do names. */
export const AI_SETTINGS = "AI assistant in community settings";

/** Where someone asks: the community's name, the room's, or null for a direct message, and whether it's in a thread. */
export interface AskedIn {
  community: string;
  roomName: string | null;
  inThread: boolean;
}

/** What an answerer is told before its instructions, and after them, each as its template has it, with the space around them. */
export interface Prompt {
  before: string;
  after: string;
}

/**
 * What Ember fills in a template with each time: the answerer's name, the community's, where it's asked,
 * who asked, about how many words it may answer in, how it can show cards under its answer, what it's
 * told of the web, today's date, and, between what's before them and what's after, its instructions.
 */
export const PLACEHOLDERS = ["name", "community", "where", "asker", "words", "cards", "web", "today", "instructions"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** A placeholder as a template writes it, its name in double braces, with or without spaces inside them. */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Where a template puts the instructions. */
const INSTRUCTIONS = /\{\{\s*instructions\s*\}\}/;

/** How the placeholders read in a template, as the pages show them. */
export const placeholderOf = (placeholder: Placeholder) => `{{${placeholder}}}`;

const FENCE = "```";

/** The blocks a card shows, each as a payload writes it, with how it shows and what it's for. */
const CARD_BLOCKS = [
  String.raw`- {"type": "header", "text": {"type": "plain_text", "text": "..."}}: a large bold title, under 150 characters.`,
  String.raw`- {"type": "section", "text": {"type": "mrkdwn", "text": "..."}}: a paragraph, which folds behind Show more past about five lines. A section can hold "fields" as well, or in place of its text: up to 10 mrkdwn texts, two to a row, such as "*Owner*\nDana". At its right, its "accessory" can be a button, or a small image, {"type": "image", "image_url": "...", "alt_text": "..."}.`,
  String.raw`- {"type": "context", "elements": [{"type": "mrkdwn", "text": "..."}]}: a short line of small gray text, for a source, a date or who's involved.`,
  String.raw`- {"type": "divider"}: a rule between groups.`,
  String.raw`- {"type": "image", "image_url": "...", "alt_text": "what it shows"}: a picture.`,
  String.raw`- {"type": "table", "rows": [[{"type": "raw_text", "text": "Name"}, {"type": "raw_text", "text": "Score"}], ...], "column_settings": [{"align": "left"}, {"align": "right"}]}: rows under a first row naming the columns. A card is narrow, so keep to about four columns; right-align numbers, and give a column of long text "is_wrapped": true.`,
  String.raw`- {"type": "carousel", "elements": [...]}: small cards side by side, for options to compare, each {"type": "card", "title": {"type": "plain_text", "text": "..."}, "subtitle": {"type": "plain_text", "text": "..."}, "body": {"type": "mrkdwn", "text": "..."}, "actions": [...]}, with a body under 200 characters and at most three buttons.`,
  String.raw`- {"type": "actions", "elements": [...]}: buttons. A button is {"type": "button", "text": {"type": "plain_text", "text": "..."}, "url": "https://...", "style": "primary"}, filled for "primary", red for "danger", and outlined without a style. A button only opens its url, so each needs one.`,
  String.raw`- {"type": "markdown", "text": "..."}: Markdown, as you write outside the block, for a list or longer text.`,
].join("\n");

/**
 * The card the guide shows, one block to a line, as an answer writes its payload: a status in an amber
 * attachment, with a header, a section, its fields and a line of context.
 */
const CARD_EXAMPLE = String.raw`{"attachments": [{"color": "warning", "blocks": [
  {"type": "header", "text": {"type": "plain_text", "text": "Spring launch: at risk"}},
  {"type": "section", "text": {"type": "mrkdwn", "text": "Three of five tasks are done. The *pricing page* waits on legal review."}},
  {"type": "section", "fields": [
    {"type": "mrkdwn", "text": "*Owner*\nWeb team"},
    {"type": "mrkdwn", "text": "*Launch*\nMarch 14"},
    {"type": "mrkdwn", "text": "*Done*\n3 of 5"},
    {"type": "mrkdwn", "text": "*Waiting on*\nLegal review"}
  ]},
  {"type": "context", "elements": [{"type": "mrkdwn", "text": "From the launch tracker, updated this morning"}]}
]}]}`;

/**
 * What @ember and the agents are told of the cards they can show under an answer, which Ember makes of the
 * Slack payloads they write in ```slack blocks, as a bot's webhook posts them (apps/worker/src/bots/slack.ts):
 * when a card helps, the blocks it can show, Slack's markup, what doesn't show, and how a good card looks.
 * It's in every question they're asked, so it says only what a model needs, in about 1,800 of Claude's
 * tokens.
 */
export const CARDS_PROMPT = [
  `You can show cards under your answer, the way Slack shows an app's message. Write a Slack message's payload as JSON in a code block that starts with ${FENCE}slack, and Ember shows its blocks and attachments as cards in place of the block. The cards show under all your words, wherever you write the block, so write your words first and end your answer with it.`,
  `Answer with a card when someone should take something in at a glance: where something stands, a report or a summary of the facts, options to compare, a checklist, a schedule, a ranking, or links to open next. Leave it out of a conversational reply, an explanation, or an answer of a sentence or two. Write your words outside the block, as a payload's "text" doesn't show. With a card, keep them to a sentence or two on what it means or what it leaves out, and never repeat what it shows. Put in a card only what you know from the conversation or your sources, and never make up a link.`,
  `A payload is {"blocks": [...]}, which shows as one card, or, for a status, {"attachments": [{"color": "good", "blocks": [...]}]}, which shows each attachment as a card with a bar down its left side in its color: "good" (green) when it's done or healthy, "warning" (amber) when it's at risk, "danger" (red) when it's failing or blocked. Use attachments only for a status like that, and blocks for anything else. Blocks show top to bottom:\n${CARD_BLOCKS}`,
  `In mrkdwn, Slack's markup and not Markdown, write *bold* with one asterisk, _italics_, ~strikethrough~, \`code\`, <https://example.com|a link> and emoji by name, such as :white_check_mark:. It has no headings or lists, so start a list's lines with "• ". Menus, date pickers, inputs, checkboxes and buttons without a url don't show, as only a Slack app could answer them. Write people's names rather than Slack's mentions, which show only as text and notify nobody. A card's pictures show only at addresses a person in the conversation wrote. Write JSON that parses, with double quotes, "\\n" for a line break inside a string, and no trailing commas or comments: a block that doesn't parse, or shows nothing, stays as code.`,
  `A card reads best when it's focused: a header that says the point, a sentence or two on what matters, the facts as fields, a line of context saying where they come from, and, when there's somewhere to go next, a button, making only the main one "primary". Give things you compare the same shape, and keep to one card unless several are clearer. For example:\n\n${FENCE}slack\n${CARD_EXAMPLE}\n${FENCE}`,
].join("\n\n");

/**
 * What @ember is told, as Ember writes it: what stays the same from question to question before what
 * changes, as providers cache the start of a prompt.
 */
export const EMBER_TEMPLATE = `You are {{name}}, the AI assistant in the team chat "{{community}}". People ask you things by mentioning @ember in a room or a thread, or by writing to you directly.

{{instructions}}

Write in Markdown. Links, bold, italics, lists, quotes, code blocks and tables show as they do in the chat, and a picture you show with ![what it shows](its address) appears under your answer when a person in the conversation wrote its address. Don't begin with your name.

{{cards}}

{{web}}

Today is {{today}}, in UTC.

You're asked in {{where}}. Its messages follow, oldest first, each after its writer's name. Answer the last one, which {{asker}} wrote, as a helpful teammate would: plainly, and in at most about {{words}} words.`;

/** What an agent is told, as Ember writes it, in the order @ember's is. */
export const AGENT_TEMPLATE = `You are {{name}}, an AI agent in the team chat "{{community}}". People ask you things by mentioning @{{name}} in a room or a thread, or by writing to you directly.

{{instructions}}

Write in Markdown. Links, bold, italics, lists, quotes, code blocks and tables show as they do in the chat, and a picture you show with ![what it shows](its address) appears under your answer when a person in the conversation wrote its address. Don't begin with your name.

{{cards}}

{{web}}

Today is {{today}}, in UTC.

You're asked in {{where}}. Its messages follow, oldest first, each after its writer's name. Answer the last one, which {{asker}} wrote, in at most about {{words}} words.`;

/** Ember's own template for the answerer `answererId`: @ember's, or an agent's, saved or not (null). */
export const ownTemplateFor = (answererId: UserId | null) => (answererId === ASSISTANT_ID ? EMBER_TEMPLATE : AGENT_TEMPLATE);

/**
 * What the answerer `answererId` is told, @ember, or an agent called `name`, by its id, or null for one
 * not saved yet, from `template`, an administrator's, or else Ember's own (`ownTemplateFor`): before its
 * instructions, who it is, and after them, how the chat shows what it writes, cards included
 * (`CARDS_PROMPT`), what it's told of the web, `web`, the date at `now`, in UTC, and where it's asked,
 * to answer the last message, which `askerName` wrote, in at most about `words` words. An agent answers
 * as its instructions say, where @ember answers as a helpful teammate would, and then as administrators
 * added. A placeholder Ember doesn't fill in stays as it's written, as it does in a template without the
 * instructions, which goes before them.
 */
export function promptAround(
  answererId: UserId | null,
  name: string,
  askerName: string,
  { community, roomName, inThread }: AskedIn,
  words: number,
  web: string,
  now: Date,
  template: string | null = null,
): Prompt {
  const room = roomName === null ? "a direct message" : `the room "${roomName}"`;
  const values: Record<Exclude<Placeholder, "instructions">, string> = {
    name,
    community,
    where: inThread ? `a thread in ${room}` : room,
    asker: askerName,
    words: words.toLocaleString("en-US"),
    cards: CARDS_PROMPT,
    web,
    today: new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: "UTC" }).format(now),
  };
  // In one pass, so that what fills a placeholder, such as a name in braces, is never filled in itself.
  const filled = (text: string) => text.replace(PLACEHOLDER, (written, placeholder: string) => (Object.hasOwn(values, placeholder) ? values[placeholder as keyof typeof values] : written));
  const [before = "", ...after] = (template ?? ownTemplateFor(answererId)).split(INSTRUCTIONS);
  return { before: filled(before), after: filled(after.join(placeholderOf("instructions"))) };
}

/**
 * `prompt` with `instructions` in their place, as the model reads it. When there are none, a place for
 * them on a line of its own goes with its line, leaving the text around it as far apart as the further
 * side was, where a place within a line leaves the rest of the line as it's written.
 */
export function withInstructions({ before, after }: Prompt, instructions: string): string {
  if (instructions !== "") return `${before}${instructions}${after}`;
  const [above, below] = [before.trimEnd(), after.trimStart()];
  const [gapAbove, gapBelow] = [before.slice(above.length), after.slice(0, after.length - below.length)];
  const ownLine = (above === "" || gapAbove.includes("\n")) && (below === "" || gapBelow.includes("\n"));
  if (!ownLine) return `${before}${after}`;
  return [above, below].filter((part) => part !== "").join("\n".repeat(Math.max(lineBreaksIn(gapAbove), lineBreaksIn(gapBelow))));
}

/** How many line breaks `space` holds. */
const lineBreaksIn = (space: string) => space.split("\n").length - 1;

/** The longest template Ember takes, as long as the instructions it goes around may be. */
export const MAX_TEMPLATE_LENGTH = 10_000;

/** Why a template is refused before anything's saved. */
export const TEMPLATE_REFUSED = "Write what Ember adds around the instructions, or go back to Ember's own.";
export const TEMPLATE_TOO_LONG = `What Ember adds around the instructions can be at most ${MAX_TEMPLATE_LENGTH.toLocaleString("en-US")} characters.`;
export const INSTRUCTIONS_PLACE_NEEDED = `What Ember adds around the instructions needs ${placeholderOf("instructions")} in it once, where they go.`;

/** Why a template can't have the placeholder `written`, which Ember has nothing to fill in for. */
export const unknownPlaceholder = (written: string) =>
  `Ember has nothing to fill in for {{${written}}}. It fills in ${PLACEHOLDERS.map(placeholderOf).join(", ")}.`;

/** How many places for the instructions `template` has, which Ember takes only one of. */
export const placesForInstructions = (template: string) => template.split(INSTRUCTIONS).length - 1;

/**
 * Why `template` can't be what Ember adds around an answerer's instructions, or null when it can: it's
 * longer than Ember takes, has a placeholder Ember doesn't fill in, or doesn't have the instructions'
 * once, as an answerer's instructions would otherwise go unread.
 */
export function templateRefusal(template: string): string | null {
  if (template.length > MAX_TEMPLATE_LENGTH) return TEMPLATE_TOO_LONG;
  for (const [, written = ""] of template.matchAll(PLACEHOLDER)) {
    if (!(PLACEHOLDERS as readonly string[]).includes(written)) return unknownPlaceholder(written);
  }
  return placesForInstructions(template) === 1 ? null : INSTRUCTIONS_PLACE_NEEDED;
}

/**
 * Parses an untrusted template for what Ember adds around the instructions of the answerer `answererId`,
 * @ember or an agent, saved or not (null), as its page saves it: null, or Ember's own template, for
 * Ember's own, which then changes as Ember does, or else a template Ember takes (`templateRefusal`),
 * without the spaces around it. Returns why it's refused instead.
 */
export function parseTemplate(given: unknown, answererId: UserId | null): { template: string | null } | { error: string } {
  if (given === null) return { template: null };
  if (typeof given !== "string") return { error: TEMPLATE_REFUSED };
  const template = given.trim();
  if (template === ownTemplateFor(answererId)) return { template: null };
  const refusal = templateRefusal(template);
  return refusal === null ? { template } : { error: refusal };
}

/**
 * What an answerer is told it may do on the web with `webTools`, or, with none, that it can't, and who
 * could let it: `askerName`, by picking a model that can, while Search the web is on, `webSearchOn`, or
 * else an administrator.
 */
export function webPromptFor(askerName: string, webTools: readonly WebTool[], webSearchOn: boolean): string {
  if (!webTools.includes("search") && webSearchOn) {
    return `You can't search the web or open links with the model ${askerName} picked for your answers to them. When they ask you to, say so, and that they can pick one that can under Ember AI on their profile.`;
  }
  if (!webTools.includes("search")) {
    return `You can't search the web or open links. When someone asks you to, say so, and that an administrator can turn on Search the web under ${AI_SETTINGS}.`;
  }
  const reading = webTools.includes("read") ? ", and read the pages people link to or your searches find," : "";
  return [
    `You can search the web${reading} when a question needs what's current, or what you don't know.`,
    "Only what you write after you last search or read is posted, so write all of your answer then. The chat lists the pages you cite after it, so don't list them yourself.",
  ].join(" ");
}
