// HTML parsing on the server: parse5 builds the tree the way Gumbo (Nokogiri's HTML5 parser) does
// for Action Text, held to Gumbo's limits.

import { html, Parser, TokenizerMode, type Token, type TreeAdapter, type TreeAdapterTypeMap } from "parse5";
import {
  BODY,
  MAX_ATTRIBUTES,
  MAX_COPIED_ATTRIBUTES_LENGTH,
  MAX_REOPENED_ELEMENTS,
  MAX_TREE_DEPTH,
  ParseLimitError,
  withoutByteOrderMark,
  type HtmlParser,
  type Reading,
} from "./markup";
import { attributesHtml } from "./serialize";
import {
  append,
  createComment,
  createElement,
  createFragment,
  createText,
  detach,
  HTML_NAMESPACE,
  insertBefore,
  removeChildren,
  type Comment,
  type Element,
  type Fragment,
  type Node,
  type Parent,
  type Text,
} from "./tree";

/**
 * Parses `markup` in the context of an element named `context` (a `body` by default), as
 * `Nokogiri::HTML5::DocumentFragment` does: without scripting, so `<noscript>` holds markup, with a
 * template's contents as its children, and with a leading byte order mark dropped. Throws
 * `ParseLimitError` past Gumbo's limits, and Ember's own.
 */
export const parseHtml: HtmlParser = (markup, context = BODY, reading = { copiedAttributesLength: 0 }) => {
  const contextElement = createElement(context.name, [], context.namespace);
  const parser = GumboParser.getFragmentParser(contextElement, { treeAdapter: countingCopies(reading), scriptingEnabled: false });
  // Without scripting, a noscript context leaves the tokenizer in its data state, as in Gumbo,
  // where parse5 switches it to RAWTEXT either way
  if (context.name === "noscript" && context.namespace === HTML_NAMESPACE) parser.tokenizer.state = TokenizerMode.DATA;
  parser.tokenizer.write(withoutByteOrderMark(markup), true);
  const root = parser.document.children[0] as Element;
  return createFragment(removeChildren(root));
};

// --- The tree adapter ---------------------------------------------------------------------------

interface TreeMap extends TreeAdapterTypeMap {
  node: Node | Parent;
  parentNode: Parent;
  childNode: Node;
  document: Element;
  documentFragment: Fragment;
  element: Element;
  commentNode: Comment;
  textNode: Text;
  template: Element;
  documentType: never;
}

const qualifiedName = (attr: Token.Attribute) => (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name);

const treeAdapter: TreeAdapter<TreeMap> = {
  createDocument: () => createElement("document"),
  createDocumentFragment: () => createFragment(),
  createElement: (name, namespace, attrs) =>
    createElement(
      name,
      attrs.map((attr) => ({ name: qualifiedName(attr), value: attr.value })),
      namespace,
    ),
  createCommentNode: (data) => createComment(data),
  createTextNode: (value) => createText(value),
  appendChild: (parent, node) => append(parent, node),
  insertBefore: (_parent, node, reference) => insertBefore(reference, node),
  // Adjacent text merges, as in the DOM
  insertText: (parent, text) => {
    const last = parent.children.at(-1);
    if (last?.kind === "text") last.value += text;
    else append(parent, createText(text));
  },
  insertTextBefore: (parent, text, reference) => {
    const previous = parent.children[parent.children.lastIndexOf(reference) - 1];
    if (previous?.kind === "text") previous.value += text;
    else insertBefore(reference, createText(text));
  },
  detachNode: (node) => detach(node),
  // libxml2 has no template contents: Nokogiri keeps them as the template's children
  getTemplateContent: (template) => template as unknown as Fragment,
  setTemplateContent: () => {},
  // In a fragment, only `<html>` tags give their attributes away, to a root element nobody keeps
  adoptAttributes: () => {},
  getDocumentMode: () => html.DOCUMENT_MODE.NO_QUIRKS,
  setDocumentMode: () => {},
  setDocumentType: () => {},
  getDocumentTypeNodeName: () => "",
  getDocumentTypeNodePublicId: () => "",
  getDocumentTypeNodeSystemId: () => "",
  getFirstChild: (node) => node.children[0] ?? null,
  getChildNodes: (node) => node.children,
  getParentNode: (node) => node.parent,
  getAttrList: (element) => element.attrs,
  getTagName: (element) => element.name,
  getNamespaceURI: (element) => element.namespace as html.NS,
  getTextNodeContent: (node) => node.value,
  getCommentNodeContent: (node) => node.value,
  isTextNode: (node): node is Text => node.kind === "text",
  isCommentNode: (node): node is Comment => node.kind === "comment",
  isDocumentTypeNode: (_node): _node is never => false,
  isElementNode: (node): node is Element => node.kind === "element",
  setNodeSourceCodeLocation: () => {},
  getNodeSourceCodeLocation: () => undefined,
  updateNodeSourceCodeLocation: () => {},
};

/**
 * The tree adapter for a parse of `reading`, which counts the attributes of each copy the parse makes
 * of a formatting element. parse5 makes every element of a tag from the tag's own list of attributes,
 * so an element made from a list that has made one already is a copy: one reopened, or one of the
 * adoption agency's, which parse5 gives no method to override.
 */
function countingCopies(reading: Reading): TreeAdapter<TreeMap> {
  const used = new Set<Token.Attribute[]>();
  return {
    ...treeAdapter,
    createElement: (name, namespace, attrs) => {
      const element = treeAdapter.createElement(name, namespace, attrs);
      if (attrs.length === 0) return element;
      if (used.has(attrs)) countCopy(reading, element);
      else used.add(attrs);
      return element;
    },
  };
}

/**
 * Counts a copy's attributes in its reading, as long as the stored form writes them, up to Ember's
 * `MAX_COPIED_ATTRIBUTES_LENGTH` in all.
 */
function countCopy(reading: Reading, copy: Element): void {
  reading.copiedAttributesLength += attributesHtml(copy.attrs, { escapeAttributeBrackets: true }).length;
  if (reading.copiedAttributesLength > MAX_COPIED_ATTRIBUTES_LENGTH) throw new ParseLimitError("copied");
}

// --- Gumbo's limits -----------------------------------------------------------------------------

/**
 * Gumbo's limits, which Nokogiri raises for exceeding. The tree depth is checked before each
 * token is read, so once a token has been handled (except at the end of the input, where text left
 * pending in a table can reopen formatting elements past the limit unchecked), and counts the
 * open elements, the fragment's root `html` included (nokogiri's ext/nokogiri/gumbo.c). Attributes
 * are counted as the tokenizer finishes each name, before a duplicate is dropped, on end tags too.
 * It also keeps Ember's limit on reopened formatting elements, as its tree adapter keeps the one on
 * the attributes they're copied with (`countingCopies`), and moves children in linear time.
 * parse5 exports its parser class for its own use, so package.json pins the version this hooks into.
 */
class GumboParser extends Parser<TreeMap> {
  private handling = 0;
  private ended = false;
  private reopened = 0;

  constructor(...args: ConstructorParameters<typeof Parser<TreeMap>>) {
    super(...args);
    const tokenizer = this.tokenizer as unknown as AttributeNames;
    const leaveAttrName = tokenizer._leaveAttrName;
    tokenizer._leaveAttrName = function (this: AttributeNames) {
      if ((this.currentToken?.attrs.length ?? 0) >= MAX_ATTRIBUTES) throw new ParseLimitError("attributes");
      leaveAttrName.call(this);
    };
  }

  private handle(handler: () => void): void {
    this.handling++;
    try {
      handler();
    } finally {
      this.handling--;
    }
    if (this.handling === 0 && !this.ended && this.openElements.stackTop + 1 > MAX_TREE_DEPTH + 1) {
      throw new ParseLimitError("depth");
    }
  }

  override onCharacter(token: Token.CharacterToken) {
    this.handle(() => super.onCharacter(token));
  }
  override onNullCharacter(token: Token.CharacterToken) {
    this.handle(() => super.onNullCharacter(token));
  }
  override onWhitespaceCharacter(token: Token.CharacterToken) {
    this.handle(() => super.onWhitespaceCharacter(token));
  }
  override onComment(token: Token.CommentToken) {
    this.handle(() => super.onComment(token));
  }
  override onDoctype(token: Token.DoctypeToken) {
    this.handle(() => super.onDoctype(token));
  }
  override onStartTag(token: Token.TagToken) {
    this.handle(() => super.onStartTag(token));
  }
  override onEndTag(token: Token.TagToken) {
    this.handle(() => super.onEndTag(token));
  }
  override onEof(token: Token.EOFToken) {
    this.ended = true;
    super.onEof(token);
  }

  /** Reopens the formatting elements a block closed, up to Ember's `MAX_REOPENED_ELEMENTS` in all. */
  override _reconstructActiveFormattingElements(): void {
    const open = this.openElements.stackTop;
    super._reconstructActiveFormattingElements();
    this.reopened += this.openElements.stackTop - open;
    if (this.reopened > MAX_REOPENED_ELEMENTS) throw new ParseLimitError("reopened");
  }

  /**
   * Moves all of `donor`'s children to `recipient` at once. parse5 detaches them one at a time from the
   * front, so the adoption agency took time quadratic in the number of children a misnested block had.
   */
  override _adoptNodes(donor: Parent, recipient: Parent): void {
    for (const child of removeChildren(donor)) append(recipient, child);
  }
}

/** The tokenizer's protected members that count attributes as their names end. */
interface AttributeNames {
  currentToken: Token.TagToken | null;
  _leaveAttrName(): void;
}
