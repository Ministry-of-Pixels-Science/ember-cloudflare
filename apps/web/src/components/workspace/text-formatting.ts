import { Lexical, type ElementNode, type LexicalEditor, type LexicalNode, type RangeSelection } from "@37signals/lexxy";
import { HEADING_TAGS, NOT_IN_CODE_BLOCKS, PLAIN_TEXT, type FormattingCommand, type HeadingTag, type LinkDraft, type TextFormat } from "@/lib/formatting";

// What the formatting row (formatting-toolbar.tsx) does to the editor's text, through Lexxy's own commands
// where it has them, which split a paragraph of lines at the line the cursor is on, as Slack formats a
// line, and what the row shows of the text where the cursor is.

const {
  $createTextNode,
  $findMatchingParent,
  $getNodeByKey,
  $getSelection,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  INSERT_PARAGRAPH_COMMAND,
} = Lexical;

/** What Lexxy's `selection.getFormat()` tells of the text where the cursor is: nothing, outside the text. */
interface LexxyFormat {
  isBold?: boolean;
  isItalic?: boolean;
  isStrikethrough?: boolean;
  isUnderline?: boolean;
  isInLink?: boolean;
  isInQuote?: boolean;
  isInHeading?: boolean;
  headingTag?: string | null;
  listType?: string | null;
}

/** What of a `<lexxy-editor>` formatting uses. */
export interface FormattedEditor {
  readonly editor: LexicalEditor;
  /** Lexxy's reading of the selection, in the editor's state. */
  readonly selection: {
    getFormat(): LexxyFormat;
    readonly isInsideCodeBlock: boolean;
    /** The list item the cursor is in, of Lexxy's own kind, if it's in one. */
    readonly isInsideList: LexicalNode | null;
    readonly hasSelectedWordsInSingleLine: boolean;
  };
  readonly contents: {
    toggleCodeBlock(): void;
    /** Writes a link to `url`, its address as its text, in place of what's selected, answering its node's key. */
    createLink(url: string): string | null;
    createLinkWithSelectedText(url: string): void;
  };
}

/** A link in the text, as @lexical/link's LinkNode is. */
interface LinkNode extends ElementNode {
  getURL(): string;
  setURL(url: string): this;
}

const LIST_TYPES: Record<string, TextFormat["list"]> = { number: "ordered", bullet: "bulleted" };

const isHeading = (tag: string | null | undefined): tag is HeadingTag => HEADING_TAGS.includes(tag as HeadingTag);

/**
 * The formatting where the cursor is, or across what's selected, as the formatting row shows it: none of
 * what's in a line in a code block, which shows its text as it is.
 */
export function $formatOf(lexxy: FormattedEditor): TextFormat {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return PLAIN_TEXT;
  const format = lexxy.selection.getFormat();
  const codeBlock = lexxy.selection.isInsideCodeBlock;
  const inLine = (on: boolean | undefined) => !codeBlock && (on ?? false);
  return {
    bold: inLine(format.isBold),
    italic: inLine(format.isItalic),
    underline: inLine(format.isUnderline),
    strikethrough: inLine(format.isStrikethrough),
    // Lexxy's isInCode is false for code that's on for what's typed next, which Code shows.
    code: inLine(selection.hasFormat("code")),
    link: inLine(format.isInLink),
    heading: isHeading(format.headingTag) ? format.headingTag : null,
    list: LIST_TYPES[format.listType ?? ""] ?? null,
    quote: format.isInQuote ?? false,
    codeBlock,
  };
}

/** What styles each line the selection's on, all of it, as Lexxy styles it, selecting all those lines. */
const LINE_STYLES = new Set<FormattingCommand>(["paragraph", ...HEADING_TAGS, "orderedList", "bulletedList", "quote", "codeBlock"]);

/** Formats what's selected, or what's typed next, as a button of the formatting row does. */
export function $applyFormatting(lexxy: FormattedEditor, command: FormattingCommand) {
  if (lexxy.selection.isInsideCodeBlock && NOT_IN_CODE_BLOCKS.has(command)) return;
  if (LINE_STYLES.has(command)) $keepingSelection(() => $format(lexxy, command));
  else $format(lexxy, command);
}

/**
 * Runs `styleLine`, then puts the cursor, or what was selected, back where it was in its text, as Slack
 * keeps it, rather than leave the whole lines Lexxy styled selected, which what's typed next would take
 * the place of. Where that text is gone, the cursor goes at the end of what's styled.
 */
function $keepingSelection(styleLine: () => void) {
  const before = $getSelection();
  const kept = $isRangeSelection(before) ? [before.anchor, before.focus].map(({ key, offset, type }) => ({ key, offset, type })) : [];
  styleLine();
  const after = $getSelection();
  if (kept.length === 0 || !$isRangeSelection(after)) return;
  // Text keeps to its line as Lexxy splits lines into blocks of their own, where an element can be split.
  const points = kept.map(({ key, offset, type }) => {
    const text = type === "text" ? $getNodeByKey(key) : null;
    return $isTextNode(text) && text.isAttached() ? { key, offset: Math.min(offset, text.getTextContentSize()) } : null;
  });
  const [anchor, focus] = points;
  if (anchor && focus) {
    after.anchor.set(anchor.key, anchor.offset, "text");
    after.focus.set(focus.key, focus.offset, "text");
  } else {
    after.anchor.set(after.focus.key, after.focus.offset, after.focus.type);
  }
}

function $format(lexxy: FormattedEditor, command: FormattingCommand) {
  const { editor } = lexxy;
  switch (command) {
    case "bold":
    case "italic":
    case "underline":
    case "strikethrough":
      editor.dispatchCommand(command);
      return;
    case "paragraph":
      editor.dispatchCommand("setFormatParagraph");
      return;
    case "h1":
    case "h2":
    case "h3":
      editor.dispatchCommand("applyHeadingFormat", command);
      return;
    case "orderedList":
      editor.dispatchCommand("insertOrderedList");
      return;
    case "bulletedList":
      editor.dispatchCommand("insertUnorderedList");
      return;
    case "quote":
      editor.dispatchCommand("insertQuoteBlock");
      return;
    case "code":
      $toggleCode(lexxy);
      return;
    case "codeBlock":
      lexxy.contents.toggleCodeBlock();
      return;
    case "divider":
      $insertDivider(editor);
      return;
  }
}

/**
 * Puts a divider at the cursor, as Lexxy's button does, splitting the line there, then takes away the line
 * break, or the empty line, that the split leaves on either side of it: so a divider goes under the line
 * whose end the cursor's at, and in place of an empty one, as after a new line or a list.
 */
function $insertDivider(editor: LexicalEditor) {
  editor.dispatchCommand("insertHorizontalDivider");
  // Lexxy leaves the cursor at the start of the line after the divider.
  const selection = $getSelection();
  const below = $isRangeSelection(selection) ? selection.anchor.getNode().getTopLevelElement() : null;
  const above = below?.getPreviousSibling()?.getPreviousSibling();
  if ($isParagraphNode(below)) {
    const first = below.getFirstChild();
    if ($isLineBreakNode(first)) first.remove();
  }
  if ($isParagraphNode(above)) {
    const last = above.getLastChild();
    if ($isLineBreakNode(last)) last.remove();
    else if (above.getChildrenSize() === 0) above.remove();
  }
}

/**
 * Code in a line, as Slack's Code marks it: words selected on one line, as Lexxy's Code button marks them,
 * which takes their other formatting off so they're one piece of code; with nothing selected, what's typed
 * next; and the words on each line selected, across lines, where Lexxy's button would make a code block.
 */
function $toggleCode(lexxy: FormattedEditor) {
  if (lexxy.selection.hasSelectedWordsInSingleLine) {
    lexxy.editor.dispatchCommand("insertCodeBlock");
    return;
  }
  const selection = $getSelection();
  if ($isRangeSelection(selection)) selection.formatText("code");
}

const isLink = (node: LexicalNode): node is LinkNode => node.getType() === "link" || node.getType() === "autolink";

/** The link all of the selection is in, if it's all in one. */
function $linkAround(selection: RangeSelection): LinkNode | null {
  const link = $findMatchingParent(selection.anchor.getNode(), isLink) as LinkNode | null;
  return link?.is($findMatchingParent(selection.focus.getNode(), isLink)) ? link : null;
}

/**
 * What Link's dialog opens with: the link the cursor is in, to change, or what's selected, its text, and
 * the address of the link it's in, if it is.
 */
export function $linkDraft(): LinkDraft {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return { text: "", url: "" };
  const link = $linkAround(selection);
  if (link && selection.isCollapsed()) return { text: link.getTextContent(), url: link.getURL() };
  return { text: selection.getTextContent(), url: link?.getURL() ?? "" };
}

/** Writes `text` as a link's text, in its first piece of text, keeping that piece's formatting. */
function $retext(link: LinkNode, text: string) {
  if (link.getTextContent() === text) return;
  const [first, ...rest] = link.getChildren();
  for (const node of rest) node.remove();
  if ($isTextNode(first)) {
    first.setTextContent(text);
  } else {
    first?.remove();
    link.append($createTextNode(text));
  }
}

/**
 * Links `text` to `url`, as Link's dialog saves them: changes the link the cursor is in, links what's
 * selected if it's still the text, and otherwise writes the text as a link in place of what's selected,
 * leaving the cursor after the link. Lexxy writes a link in a change of its own, which answers the link
 * only once it's run, so this isn't a change itself.
 */
export function linkText(lexxy: FormattedEditor, { text, url }: LinkDraft) {
  const { editor } = lexxy;
  const target = editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return null;
    if (!selection.isCollapsed()) return { link: null, selected: selection.getTextContent() };
    return { link: $linkAround(selection)?.getKey() ?? null, selected: null };
  });
  if (!target) return;
  if (target.selected === text) {
    lexxy.contents.createLinkWithSelectedText(url);
    return;
  }
  const key = target.link ?? lexxy.contents.createLink(url);
  if (key === null) return;
  editor.update(() => {
    const link = $getNodeByKey(key) as LinkNode | null;
    if (!link) return;
    link.setURL(url);
    $retext(link, text);
    link.selectNext();
  });
}

/** Takes off the link the selection is in, keeping its text. */
export function $unlink() {
  const selection = $getSelection();
  const link = $isRangeSelection(selection) ? $linkAround(selection) : null;
  if (!link) return;
  for (const child of link.getChildren()) link.insertBefore(child);
  link.remove();
}

/**
 * In a list, starts its next item, or ends it on an empty one, and in a heading, starts a paragraph after
 * it, as Enter does where it doesn't send. Answers whether it did: elsewhere, a new line is a line break.
 */
export function startNewBlock({ editor, selection }: FormattedEditor): boolean {
  const inBlock = editor.getEditorState().read(() => selection.isInsideList !== null || (selection.getFormat().isInHeading ?? false));
  if (inBlock) editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
  return inBlock;
}
