// `ActionText::PlainTextConversion`, with a heading of any size ending a block, as `h1` does there, since Ember's
// formatting row writes `h2` and `h3` as well as Campfire's `h1`.

import { chompNewlines, isBlank } from "./ruby";
import { ancestors, nodeName, textContent, type Element, type Node, type Parent } from "./tree";

/** `PlainTextConversion.node_to_plain_text`: a bottom-up reduction keyed on each node's name. */
export function nodeToPlainText(node: Parent): string {
  return chompNewlines(plainTextFor(node));
}

/** `plain_text_for_node(node, index)`, where `index` is the node's among its parent's elements. */
function plainTextFor(node: Node | Parent, index = 0): string {
  const children = () => (node.kind === "element" || node.kind === "fragment" ? childrenPlainText(node) : "");
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
      return `${"  ".repeat(Math.max(depth - 1, 0))}${bullet(node as Element, index)} ${chompNewlines(children())}\n`;
    }
    default:
      return children();
  }
}

function childrenPlainText(parent: Parent): string {
  let elementIndex = 0;
  return parent.children.map((child) => plainTextFor(child, child.kind === "element" ? elementIndex++ : 0)).join("");
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
