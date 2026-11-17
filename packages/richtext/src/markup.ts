// The Nokogiri operations that take markup. Action Text serializes nodes and parses markup back in
// many places, and the output takes its shape from those round trips, so each one is reproduced
// in the context Nokogiri parses it in.

import { append, HTML_NAMESPACE, removeChildren, type Element, type Fragment, type Node, type Parent } from "./tree";

/**
 * Gumbo's defaults, past which Nokogiri raises `ArgumentError`
 * (`Nokogiri::Gumbo::DEFAULT_MAX_TREE_DEPTH`, `DEFAULT_MAX_ATTRIBUTES`).
 */
export const MAX_TREE_DEPTH = 400;
export const MAX_ATTRIBUTES = 400;

/**
 * Ember's own limit on the formatting elements a parse reopens, which Gumbo doesn't have. Each
 * paragraph after up to 400 unclosed formatting elements reopens them all, so a few KB could
 * otherwise parse into megabytes. A misnested message reopens a few per paragraph.
 */
export const MAX_REOPENED_ELEMENTS = 1_000;

/**
 * Ember's own limit, which Gumbo doesn't have either, on the attributes one reading of a body copies,
 * in the UTF-16 units they serialize to. Each formatting element a parse reopens, and each one the
 * adoption agency clones around a misnested block, is a copy with every attribute of the tag that
 * opened it, so one long title reopened in each of a thousand paragraphs could otherwise parse into a
 * thousand times its size. It's as much as a message's markup holds in all (the protocol's
 * `MAX_MESSAGE_HTML_LENGTH`).
 */
export const MAX_COPIED_ATTRIBUTES_LENGTH = 100_000;

const LIMIT_MESSAGES = {
  depth: "Document tree depth limit exceeded",
  attributes: "Attributes per element limit exceeded",
  reopened: "Reopened formatting elements limit exceeded",
  copied: "Copied attributes limit exceeded",
};

export class ParseLimitError extends Error {
  constructor(readonly limit: keyof typeof LIMIT_MESSAGES) {
    super(LIMIT_MESSAGES[limit]);
    this.name = "ParseLimitError";
  }
}

/** Gumbo skips one byte order mark at the start of its input. */
export function withoutByteOrderMark(markup: string): string {
  return markup.startsWith("\uFEFF") ? markup.slice(1) : markup;
}

/** The element markup is parsed in place of. */
export interface Context {
  name: string;
  namespace: string;
}

/**
 * One reading of a body, from its markup to what's made of it: the parses of the body, of its
 * attachments' content and of what each step serializes, which count what they copy together.
 */
export interface Reading {
  /** What the attributes copied so far serialize to, in UTF-16 units, up to `MAX_COPIED_ATTRIBUTES_LENGTH`. */
  copiedAttributesLength: number;
}

/**
 * Parses markup as a fragment in a context, throwing `ParseLimitError` past Gumbo's limits:
 * `parseHtml` (parse5) on the server, `parseDom` in a browser. A parse counts what it copies in
 * `reading`, or by itself when it's given none.
 */
export type HtmlParser = (markup: string, context?: Context, reading?: Reading) => Fragment;

/**
 * `parse` for one reading of a body, whose parses count what they copy together, so that a body can't
 * copy `MAX_COPIED_ATTRIBUTES_LENGTH` over again in each attachment's content. Reading a body again,
 * as storing one reads it for its plain text and then to render it, is another reading, which copies
 * what the first did: `forOneReading` of a reading's parser counts apart from it.
 */
export function forOneReading(parse: HtmlParser): HtmlParser {
  const own: Reading = { copiedAttributesLength: 0 };
  return (markup, context, reading = own) => parse(markup, context, reading);
}

/** `Document#fragment` parses in a `body` context. */
export const BODY: Context = { name: "body", namespace: HTML_NAMESPACE };

/** The context `Node#fragment` parses in: the element itself, or a `body` for anything else. */
export function contextFor(parent: Parent): Context {
  return parent.kind === "element" ? { name: parent.name, namespace: parent.namespace } : BODY;
}

/**
 * What Nokogiri's `node.replace(markup)` puts in a node's place: the markup parsed in the context
 * of its parent. Replace nodes with `replaceEach`.
 */
export function parseReplacement(parse: HtmlParser, node: Node, markup: string): Node[] {
  return node.parent ? removeChildren(parse(markup, contextFor(node.parent))) : [];
}

/** Nokogiri's `node.inner_html = markup`, parsed in the node's own context. */
export function setInnerHtml(parse: HtmlParser, element: Element, markup: string): void {
  const children = removeChildren(parse(markup, contextFor(element)));
  removeChildren(element);
  for (const child of children) append(element, child);
}
