import { Lexical, type LexicalEditor, type LexicalNode, type ParagraphNode } from "@37signals/lexxy";

// Quotes line by line, as Slack's composer has them. Shift+Enter breaks a line within its paragraph, so a
// message written before it's sent is one paragraph of lines, and Lexical's > shortcut, which quotes a
// paragraph, quoted the first of them and every line after it. Typing > and a space at the start of any line
// quotes just that line, and Backspace on an empty line in a quote takes the line out of it, splitting the
// quote around it, so a quote can be followed by what's said about it.

const { $copyNode, $createParagraphNode, $getSelection, $isLineBreakNode, $isParagraphNode, $isRangeSelection, $isTextNode, COMMAND_PRIORITY_HIGH, KEY_BACKSPACE_COMMAND, KEY_SPACE_COMMAND } = Lexical;

const isQuote = (node: LexicalNode | null): boolean => node?.getType() === "quote";

/** Where a collapsed caret is in a paragraph: before child `index`, or `offset` into text child `index`. */
function caretInParagraph(): { paragraph: ParagraphNode; index: number; offset: number } | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const { anchor } = selection;
  const node = anchor.getNode();
  if (anchor.type === "element") return $isParagraphNode(node) ? { paragraph: node, index: anchor.offset, offset: 0 } : null;
  const parent = node.getParent();
  return $isParagraphNode(parent) ? { paragraph: parent, index: node.getIndexWithinParent(), offset: anchor.offset } : null;
}

/**
 * Takes the empty line the caret is on, in a quote, out of it: the lines before it stay quoted, those after it
 * go in a quote of their own below, and the caret goes to a new unquoted line between. Answers whether it did,
 * which it doesn't anywhere but an empty line in a quote.
 */
export function $unquoteEmptyLine(): boolean {
  const caret = caretInParagraph();
  if (!caret || caret.offset !== 0) return false;
  const { paragraph, index } = caret;
  const quote = paragraph.getParent();
  if (!quote || !isQuote(quote)) return false;
  const children = paragraph.getChildren();
  const before = children[index - 1];
  const after = children[index];
  const empty = (index === 0 || $isLineBreakNode(before)) && (after === undefined || $isLineBreakNode(after));
  if (!empty) return false;

  // The breaks on either side of the empty line go with it.
  const following = children.slice(index + 1);
  const later = paragraph.getNextSiblings();
  before?.remove();
  after?.remove();
  for (const node of following) node.remove();
  if (paragraph.getChildrenSize() === 0) paragraph.remove();

  const unquoted = $createParagraphNode();
  quote.insertAfter(unquoted);
  if (following.length > 0 || later.length > 0) {
    const rest = $copyNode(quote);
    if (following.length > 0) rest.append($createParagraphNode().append(...following));
    rest.append(...later);
    unquoted.insertAfter(rest);
  }
  if (quote.getChildrenSize() === 0) quote.remove();
  unquoted.select();
  return true;
}

/**
 * Quotes the line the caret is on, as typing > and a space at its start does in Slack, where a line is a line
 * whichever paragraph it's in: gives the line a paragraph of its own, between the lines before and after it,
 * has Lexxy quote it, as its Quote button does, and takes the > out. Answers whether it did, which it doesn't
 * but just after a > at the start of a line outside a quote.
 */
export function $quoteLineAfterMarker(editor: LexicalEditor): boolean {
  const caret = caretInParagraph();
  if (!caret) return false;
  const { paragraph, index, offset } = caret;
  if (paragraph.getParent()?.getType() !== "root") return false;
  const children = paragraph.getChildren();
  const text = children[index];
  const lineStart = index === 0 ? null : children[index - 1];
  if (!$isTextNode(text) || offset !== 1 || !text.getTextContent().startsWith(">")) return false;
  if (lineStart !== null && !$isLineBreakNode(lineStart)) return false;

  const nextBreak = children.findIndex((node, i) => i > index && $isLineBreakNode(node));
  const line = children.slice(index, nextBreak === -1 ? undefined : nextBreak);
  const following = nextBreak === -1 ? [] : children.slice(nextBreak + 1);
  lineStart?.remove();
  if (nextBreak !== -1) children[nextBreak]!.remove();
  for (const node of [...line, ...following]) node.remove();
  // The lines before stay in the paragraph, an empty one too, which is a blank line.
  const quoted = $createParagraphNode().append(...line);
  paragraph.insertAfter(quoted);
  if (following.length > 0) quoted.insertAfter($createParagraphNode().append(...following));
  if (lineStart === null) paragraph.remove();

  text.select(1, 1);
  editor.dispatchCommand(QUOTE_COMMAND, undefined);
  const rest = text.getTextContent().slice(1);
  if (rest === "") {
    const holder = text.getParent();
    text.remove();
    holder?.select(0, 0);
  } else {
    text.setTextContent(rest);
    text.select(0, 0);
  }
  return true;
}

/** Lexxy's Quote button's command, which quotes the lines the selection is on. */
const QUOTE_COMMAND = "insertQuoteBlock";

/** Has `editor` quote line by line, answering what stops it. */
export function registerQuoteLines(editor: LexicalEditor): () => void {
  const unregisterBackspace = editor.registerCommand(
    KEY_BACKSPACE_COMMAND,
    (event: KeyboardEvent | null) => {
      if (!$unquoteEmptyLine()) return false;
      event?.preventDefault();
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
  // The space after the > only quotes, as Slack's does.
  const unregisterSpace = editor.registerCommand(
    KEY_SPACE_COMMAND,
    (event: KeyboardEvent) => {
      if (!$quoteLineAfterMarker(editor)) return false;
      event.preventDefault();
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
  return () => {
    unregisterBackspace();
    unregisterSpace();
  };
}
