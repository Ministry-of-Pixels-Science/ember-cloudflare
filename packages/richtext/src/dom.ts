// The package for browsers: markup parsed by the platform's own HTML parser, in a document without
// a browsing context, so nothing in it runs or loads and it parses without scripting, and without
// bundling parse5.

import { withParser } from "./body";
import { BODY, MAX_ATTRIBUTES, MAX_TREE_DEPTH, ParseLimitError, withoutByteOrderMark, type Context, type HtmlParser } from "./markup";
import {
  append,
  createComment,
  createElement,
  createFragment,
  createText,
  HTML_NAMESPACE,
  MATHML_NAMESPACE,
  SVG_NAMESPACE,
  type Node,
} from "./tree";

export * from "./shared";

let inertDocument: Document | undefined;

/**
 * `parseHtml`'s counterpart: the fragment parsing algorithm, run by setting a context element's
 * `innerHTML`. Gumbo's limits are checked on the tree that results, which can't show the
 * attributes the browser dropped as duplicates, or the elements it closed early. Nor does it show
 * which formatting elements were reopened or copied, so only the server keeps `MAX_REOPENED_ELEMENTS`
 * and `MAX_COPIED_ATTRIBUTES_LENGTH`.
 */
export const parseDom: HtmlParser = (markup, context = BODY) => {
  inertDocument ??= new DOMParser().parseFromString("", "text/html");
  const element = contextElement(inertDocument, context);
  element.innerHTML = withoutByteOrderMark(markup);
  return createFragment(fromDomChildren(element, 1));
};

/** An element of each namespace that parses its contents as any other would. */
const ORDINARY_ELEMENTS: Record<string, string> = { [HTML_NAMESPACE]: "div", [SVG_NAMESPACE]: "g", [MATHML_NAMESPACE]: "mrow" };

/**
 * An element to parse in the context of. The DOM won't create every element the parser makes,
 * like `https:` from `<https://example.com/>`, and takes a colon to start a local name where the
 * parser doesn't, so those get an ordinary element, which they parse as. A noscript gets one too:
 * it parses as one without scripting, which jsdom's parser (parse5) doesn't honor here.
 */
function contextElement(document: Document, { name, namespace }: Context): globalThis.Element {
  const ordinary = ORDINARY_ELEMENTS[namespace] ?? ORDINARY_ELEMENTS[HTML_NAMESPACE]!;
  const noscript = name === "noscript" && namespace === HTML_NAMESPACE;
  if (noscript || name.includes(":")) return document.createElementNS(namespace, ordinary);
  try {
    return document.createElementNS(namespace, name);
  } catch {
    return document.createElementNS(namespace, ordinary);
  }
}

function fromDomChildren(element: globalThis.Element, depth: number): Node[] {
  const parent = isTemplate(element) ? element.content : element;
  return Array.from(parent.childNodes, (child) => fromDom(child, depth)).filter((node) => node !== undefined);
}

function fromDom(node: ChildNode, depth: number): Node | undefined {
  if (node.nodeType === node.TEXT_NODE) return createText((node as Text).data);
  if (node.nodeType === node.COMMENT_NODE) return createComment((node as Comment).data);
  if (node.nodeType !== node.ELEMENT_NODE) return undefined;
  const element = node as globalThis.Element;
  if (depth > MAX_TREE_DEPTH) throw new ParseLimitError("depth");
  if (element.attributes.length > MAX_ATTRIBUTES) throw new ParseLimitError("attributes");
  const attrs = Array.from(element.attributes, (attr) => ({ name: attr.name, value: attr.value }));
  const converted = createElement(element.localName, attrs, element.namespaceURI ?? HTML_NAMESPACE);
  for (const child of fromDomChildren(element, depth + 1)) append(converted, child);
  return converted;
}

/** A template's children are its contents, as Nokogiri has them. */
function isTemplate(element: globalThis.Element): element is HTMLTemplateElement {
  return element.namespaceURI === HTML_NAMESPACE && element.localName === "template";
}

export const { prepareBody, plainText, mentionedUsers, userIdsIn, writtenBody, editableBody, autoLink, displayBody } = withParser(parseDom);
