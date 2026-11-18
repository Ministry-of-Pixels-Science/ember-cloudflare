// What Ember keeps of a message body when it's written: the canonical markup, its plain text and
// whom it mentions (Ember's rich-text design: sanitize on write, render on the client).

import { RenderError, type MentionUser, type ResolveMention } from "./attachments";
import { autoLink } from "./autolink";
import { attachmentNodes, contentToPlainText, loadContent } from "./content";
import { displayBody } from "./display";
import { forOneReading, ParseLimitError, type HtmlParser } from "./markup";
import { editableBody, mentionedUsers, userIdFromSgid, userIdsIn, usersAttached, writtenMentions, type MentionCard } from "./mentions";
import { plainParagraphLines } from "./plain-paragraph";
import { hasPreview } from "./previews";
import { canonicalize } from "./render";
import { chompNewlines, isBlank } from "./ruby";
import { toHtml } from "./serialize";
import { append, createElement, createText } from "./tree";

/**
 * A body as Ember keeps it. Everything but `html` is read from `html`, so it matches what shows,
 * and preparing `html` again gives the same.
 */
export interface PreparedBody {
  /** The body in the form Ember stores and clients render (`canonicalize`). */
  html: string;
  /** Action Text's plain text of it: for search, notifications and emoji-only bodies. */
  plainText: string;
  /** The users it mentions, once each, in order, named as `resolve` named them. */
  mentions: MentionUser[];
  /** Nothing to send: no text but whitespace, and no mentions. */
  blank: boolean;
}

/** `message.body.to_plain_text`. Throws `ParseLimitError` past the parser's limits. */
export function plainText(parse: HtmlParser, markup: string, resolve: ResolveMention): string {
  const read = forOneReading(parse);
  return contentToPlainText(read, loadContent(read, markup), resolve);
}

/**
 * What markup the editor wrote says: its plain text, and whom it mentions, once each, in order, named as
 * their mentions show them. It's what the room makes of it but for renames since, so it stands in for that
 * until the room says. A body with a link preview that raises as Rails reads it, which the room refuses,
 * has no plain text. Throws `ParseLimitError` past the parser's limits.
 */
export function writtenBody(parse: HtmlParser, markup: string): { plainText: string; mentions: MentionUser[] } {
  const mentions = writtenMentions(parse, markup);
  try {
    return { plainText: plainText(parse, markup, (sgid) => mentions.find((person) => person.id === userIdFromSgid(sgid))), mentions };
  } catch (error) {
    if (error instanceof RenderError) return { plainText: "", mentions };
    throw error;
  }
}

/**
 * Everything Ember keeps of a body a client sent, or null when it can't be shown: past the parser's
 * limits, or with an attachment that raises as Rails renders it. Ember refuses such a body rather than
 * keep what would show as an empty message.
 */
export function prepareBody(parse: HtmlParser, markup: string, resolve: ResolveMention): PreparedBody | null {
  return preparePlainParagraph(markup) ?? prepareParsedBody(parse, markup, resolve);
}

/**
 * What `prepareParsedBody` makes of a plain paragraph, without parsing it: the markup as it is,
 * already in the stored form, and its plain text as `nodeToPlainText` reads it, without the
 * newlines that end each line or the whole.
 */
function preparePlainParagraph(markup: string): PreparedBody | null {
  const lines = plainParagraphLines(markup);
  if (lines === null) return null;
  const text = chompNewlines(lines.map(chompNewlines).join("\n"));
  return { html: markup, plainText: text, mentions: [], blank: isBlank(text) };
}

/** `prepareBody` the long way, parsing the markup, as it has to unless it's a plain paragraph. */
export function prepareParsedBody(parse: HtmlParser, markup: string, resolve: ResolveMention): PreparedBody | null {
  try {
    const html = canonicalize(parse, markup, resolve);
    const content = loadContent(parse, html);
    const attachments = attachmentNodes(content);
    const mentions = usersAttached(attachments, resolve).map(({ id, name }) => ({ id, name }));
    const text = contentToPlainText(parse, content, resolve);
    return { html, plainText: text, mentions, blank: isBlank(text) && attachments.length === 0 };
  } catch (error) {
    if (error instanceof ParseLimitError || error instanceof RenderError) return null;
    throw error;
  }
}

/**
 * The stored form of plain text: one paragraph, its line breaks `<br>`, as Lexxy sends text typed
 * into it. It's already in the form `prepareBody` stores.
 */
export function bodyFromPlainText(text: string): string {
  const paragraph = createElement("p");
  text.split(/\r\n?|\n/).forEach((line, index) => {
    if (index > 0) append(paragraph, createElement("br"));
    if (line !== "") append(paragraph, createText(line));
  });
  return toHtml(paragraph, { escapeAttributeBrackets: true });
}

/** The package's functions over one parser: parse5 in the Worker, the DOM's in a browser. */
export function withParser(parse: HtmlParser) {
  return {
    prepareBody: (markup: string, resolve: ResolveMention) => prepareBody(parse, markup, resolve),
    plainText: (markup: string, resolve: ResolveMention) => plainText(parse, markup, resolve),
    mentionedUsers: (markup: string, resolve: ResolveMention): MentionUser[] => mentionedUsers(parse, markup, resolve),
    userIdsIn: (markup: string) => userIdsIn(parse, markup),
    writtenBody: (markup: string) => writtenBody(parse, markup),
    editableBody: (stored: string, card: (userId: string) => MentionCard | undefined, host: string) => editableBody(parse, stored, card, host),
    autoLink: (html: string) => autoLink(parse, html),
    displayBody: (html: string, plainText: string, host: string) => displayBody(parse, html, plainText, host),
    hasPreview: (markup: string) => hasPreview(parse, markup),
  };
}
