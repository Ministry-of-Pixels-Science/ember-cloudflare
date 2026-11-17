// Nokogiri's HTML5 serialization (`Nokogiri::HTML5::Node#write_to`, `html_standard_serialize`),
// which is what Action Text's `to_html` and Loofah's produce.

import { HTML_NAMESPACE, type Attr, type Node, type Parent } from "./tree";

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const RAW_TEXT_ELEMENTS = new Set(["style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript"]);

export interface SerializeOptions {
  /**
   * Escapes `<` and `>` in attribute values too, as the current HTML serialization algorithm
   * does. Nokogiri leaves them raw; the two parse back to the same tree.
   */
  escapeAttributeBrackets?: boolean;
}

/** `node.to_html`: the node itself, or only the children of a fragment. */
export function toHtml(node: Node | Parent, options: SerializeOptions = {}): string {
  return node.kind === "fragment" ? innerHtml(node, options) : serializeNode(node, options);
}

export function innerHtml(parent: Parent, options: SerializeOptions = {}): string {
  let out = "";
  for (const child of parent.children) out += serializeNode(child, options);
  return out;
}

function serializeNode(node: Node, options: SerializeOptions): string {
  switch (node.kind) {
    case "element": {
      const out = `<${node.name}${attributesHtml(node.attrs, options)}>`;
      if (node.namespace === HTML_NAMESPACE && VOID_ELEMENTS.has(node.name)) return out;
      return `${out}${innerHtml(node, options)}</${node.name}>`;
    }
    case "text": {
      const parent = node.parent;
      const raw = parent?.kind === "element" && parent.namespace === HTML_NAMESPACE && RAW_TEXT_ELEMENTS.has(parent.name);
      return raw ? node.value : escapeText(node.value);
    }
    case "comment":
      return `<!--${node.value}-->`;
  }
}

/** An element's attributes as its start tag holds them, each after a space. */
export function attributesHtml(attrs: readonly Attr[], options: SerializeOptions = {}): string {
  let out = "";
  for (const attr of attrs) out += ` ${attr.name}="${escapeAttribute(attr.value, options)}"`;
  return out;
}

function escapeAttribute(value: string, { escapeAttributeBrackets = false }: SerializeOptions): string {
  return value.replace(/[&\u00A0"<>]/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "\u00A0":
        return "&nbsp;";
      case '"':
        return "&quot;";
      case "<":
        return escapeAttributeBrackets ? "&lt;" : c;
      default:
        return escapeAttributeBrackets ? "&gt;" : c;
    }
  });
}

function escapeText(value: string): string {
  return value.replace(/[&\u00A0<>]/g, (c) => (c === "&" ? "&amp;" : c === "\u00A0" ? "&nbsp;" : c === "<" ? "&lt;" : "&gt;"));
}
