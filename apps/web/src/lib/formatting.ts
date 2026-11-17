// The formatting row over a message's text, as Slack's composer has it: what its buttons and keys do, and
// what they show of the text where the cursor is. The editor that does it is a chunk of its own
// (rich-text-editor.tsx), so this holds what the rest of the app needs to draw the row.

/** A heading's size: Slack's Big, Medium and Small heading. */
export type HeadingTag = "h1" | "h2" | "h3";

export const HEADING_TAGS: readonly HeadingTag[] = ["h1", "h2", "h3"];

/** What a button of the formatting row, or its keys, does to the text. */
export type FormattingCommand =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "paragraph"
  | HeadingTag
  | "orderedList"
  | "bulletedList"
  | "quote"
  | "code"
  | "codeBlock"
  | "divider";

/** What a button of the row, or its keys, does: a formatting command, or opening Link's dialog. */
export type FormattingKey = FormattingCommand | "link";

/** What Slack calls each of the row's buttons and the Paragraph menu's styles, as Ember calls them too. */
export const FORMATTING_NAMES: Record<FormattingKey, string> = {
  bold: "Bold",
  italic: "Italic",
  underline: "Underline",
  strikethrough: "Strikethrough",
  paragraph: "Paragraph",
  h1: "Big heading",
  h2: "Medium heading",
  h3: "Small heading",
  link: "Link",
  orderedList: "Ordered list",
  bulletedList: "Bulleted list",
  quote: "Blockquote",
  code: "Code",
  codeBlock: "Code block",
  divider: "Divider",
};

/** What a code block has no use for, as Slack's row greys out there: its text is code already. */
export const NOT_IN_CODE_BLOCKS: ReadonlySet<FormattingKey> = new Set<FormattingKey>(["bold", "italic", "underline", "strikethrough", "link", "code", "divider"]);

/** The formatting where the cursor is, or across what's selected, as the row shows it. */
export interface TextFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  /** Code in a line, which is on for what's typed next once Code is pressed with nothing selected. */
  code: boolean;
  link: boolean;
  /** The heading the line is, or null for a paragraph. */
  heading: HeadingTag | null;
  list: "ordered" | "bulleted" | null;
  quote: boolean;
  codeBlock: boolean;
}

/** No formatting, as in an empty composer. */
export const PLAIN_TEXT: TextFormat = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  code: false,
  link: false,
  heading: null,
  list: null,
  quote: false,
  codeBlock: false,
};

export const sameFormat = (a: TextFormat, b: TextFormat) => (Object.keys(a) as (keyof TextFormat)[]).every((key) => a[key] === b[key]);

/** A link's text and address, as Link's dialog edits them: an empty address for a new link. */
export interface LinkDraft {
  text: string;
  url: string;
}

/** An address as Link takes it, as Slack does: one without a scheme is a web address, over https. */
export function linkAddress(typed: string): string {
  const url = typed.trim();
  return /^(?:[a-z][a-z\d+.-]*:\/\/|mailto:|tel:)/i.test(url) ? url : `https://${url}`;
}
