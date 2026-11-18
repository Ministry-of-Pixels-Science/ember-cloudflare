// `ActionText::PlainTextConversion`, with a heading of any size ending a block, as `h1` does there, since Ember's
// formatting row writes `h2` and `h3` as well as Campfire's `h1`.

import { chompNewlines, isBlank } from "./ruby";
import { ancestors, nodeName, textContent, type Element, type Node, type Parent } from "./tree";

/**
 * Ember's own limit on the spaces a body's plain text indents its list items with in all, which Action
 * Text doesn't have: an item takes two for each list around its own, so 100 KB of items in lists as deep
 * as a body goes read as 20 MB of text. Once a body's items have taken this many, the rest aren't
 * indented. Its text is longer by then than a message's can be (`MAX_MESSAGE_LENGTH`, which this mustn't
 * be less than), so the room refuses the body either way, but for a card's table cell, whose text is
 * measured on one line.
 */
export const MAX_LIST_INDENTATION = 10_000;

/** The spaces of `MAX_LIST_INDENTATION` that the list items of the body being read have yet to take. */
interface IndentationBudget {
  spaces: number;
}

/** `PlainTextConversion.node_to_plain_text`: a bottom-up reduction keyed on each node's name. */
export function nodeToPlainText(node: Parent): string {
  return chompNewlines(plainTextFor(node, 0, { spaces: MAX_LIST_INDENTATION }));
}

/** `plain_text_for_node(node, index)`, where `index` is the node's among its parent's elements. */
function plainTextFor(node: Node | Parent, index: number, budget: IndentationBudget): string {
  const children = () => (node.kind === "element" || node.kind === "fragment" ? childrenPlainText(node, budget) : "");
  switch (node.kind === "fragment" ? "#document-fragment" : nodeName(node)) {
    case "script":
    case "style":
    case "unsupported":
      return "";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
    case "p":
      return block(children());
    case "ul":
    case "ol": {
      const text = block(children());
      return listDepth(node) > 0 ? `\n${text}` : text;
    }
    case "br":
      return "\n";
    // Text nodes, and elements that happen to be named "text" (SVG's), read their text
    case "text":
      return chompNewlines(textContent(node));
    case "div":
      return `${chompNewlines(children())}\n`;
    case "figcaption":
      return `[${chompNewlines(children())}]`;
    case "blockquote":
      return quoted(block(children()));
    case "li": {
      const depth = listDepth(node);
      return `${indentation(Math.max(depth - 1, 0), budget)}${bullet(node as Element, index)} ${chompNewlines(children())}\n`;
    }
    default:
      return children();
  }
}

function childrenPlainText(parent: Parent, budget: IndentationBudget): string {
  let elementIndex = 0;
  return parent.children.map((child) => plainTextFor(child, child.kind === "element" ? elementIndex++ : 0, budget)).join("");
}

/** Two spaces for each of a list item's `levels`, out of the `budget`, or none once the body's items have used it up. */
function indentation(levels: number, budget: IndentationBudget): string {
  if (budget.spaces <= 0) return "";
  budget.spaces -= 2 * levels;
  return "  ".repeat(levels);
}

function block(text: string): string {
  return `${chompNewlines(text)}\n\n`;
}

const isSpace = (c: string | undefined) => c !== undefined && " \t\n\v\f\r".includes(c);

/** `text.insert(text.rindex(/\S/) + 1, "”")`, then `text.insert(text.index(/\S/), "“")`. */
function quoted(text: string): string {
  if (isBlank(text)) return "“”";
  let end = text.length;
  while (isSpace(text[end - 1])) end--;
  let start = 0;
  while (isSpace(text[start])) start++;
  return `${text.slice(0, start)}“${text.slice(start, end)}”${text.slice(end)}`;
}

const isList = (parent: Parent) => parent.kind === "element" && (parent.name === "ul" || parent.name === "ol");

function listDepth(node: Node | Parent): number {
  return node.kind === "fragment" ? 0 : ancestors(node).filter(isList).length;
}

function bullet(item: Element, index: number): string {
  const list = ancestors(item).find(isList);
  return list?.kind === "element" && list.name === "ol" ? `${index + 1}.` : "•";
}
