import { decodeHTMLStrict } from "entities/decode";
import { Marked, type Token, type Tokens } from "marked";
import { anchor, escapeText, linkHref } from "./mrkdwn";

// The Markdown of a Block Kit markdown block (https://docs.slack.dev/reference/block-kit/blocks/markdown-block),
// read with marked into the rich text a message keeps, as Slack draws it: GitHub's flavor, its line breaks kept,
// every heading at one size, images as links to them, a task's box as a character, and HTML as the text it's
// written in. Only web and email addresses link, as in mrkdwn, and the room sanitizes what's left as it does a body.
// The message's plain text reads it as Action Text does (`nodeToPlainText`), running a code block and a table's cells
// into what follows them, so those sit in a `div`, which ends a line there, and each cell ends in a space, which it
// doesn't show. A heading sits in one too, ending its line where it would end a paragraph.

/** Slack's limit on the Markdown in all of a payload's markdown blocks. */
export const MAX_MARKDOWN_LENGTH = 12_000;

/** A code block's language, as highlight.js names one. */
const LANGUAGE = /^[\w#+.-]+/;

/** A block in a `div`, which the plain text ends a line after. */
const ownLine = (html: string) => `<div>${html}</div>`;

/** An image's description as text: what its words say, its code, tags and autolinks as they're written, and a space for a line break. */
function descriptionText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === "link" && token.autolink) return token.text;
      if ("tokens" in token && token.tokens) return descriptionText(token.tokens);
      if (token.type === "text") return decodeHTMLStrict(token.text);
      if (token.type === "br") return " ";
      return "text" in token ? token.text : "";
    })
    .join("");
}

const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    heading({ tokens }) {
      return ownLine(`<h4>${this.parser.parseInline(tokens)}</h4>`);
    },
    html({ text, block }) {
      const html = escapeText(text.trim()).replace(/\n/g, "<br>");
      return block ? `<p>${html}</p>` : html;
    },
    text(token) {
      // marked writes the text in a `pre`, `code`, `kbd` or `script` tag unescaped, as it writes the tag, but the tag
      // shows as its text here, so that text is escaped as any other is: `<code>a<b</code>` keeps its `<b`.
      if (token.type === "text") token.escaped = false;
      return false;
    },
    code({ text, lang }) {
      const language = lang?.match(LANGUAGE)?.[0];
      return ownLine(`<pre${language ? ` data-language="${language}"` : ""}>${escapeText(text)}</pre>`);
    },
    table({ header, rows }) {
      const row = (cells: Tokens.TableCell[]) => `<tr>${cells.map((cell) => this.tablecell(cell)).join("")}</tr>`;
      return ownLine(`<table><thead>${row(header)}</thead>${rows.length > 0 ? `<tbody>${rows.map(row).join("")}</tbody>` : ""}</table>`);
    },
    tablecell({ tokens, header }) {
      const name = header ? "th" : "td";
      return `<${name}>${this.parser.parseInline(tokens)} </${name}>`;
    },
    link({ href, text, tokens, autolink }) {
      // As CommonMark reads them, a character reference in a link's address stands for its character, as `&amp;` does
      // for `&`, but an autolink's address is its text, every `&` in it an ampersand.
      const label = autolink ? escapeText(text) : this.parser.parseInline(tokens);
      const url = linkHref(autolink ? href : decodeHTMLStrict(href));
      return url ? anchor(url, label) : label;
    },
    image({ href, tokens }) {
      const label = descriptionText(tokens);
      const address = decodeHTMLStrict(href);
      const url = linkHref(address);
      return url ? anchor(url, escapeText(label || address)) : escapeText(label);
    },
    checkbox({ checked }) {
      return checked ? "☑ " : "☐ ";
    },
  },
});

/** A markdown block's text as markup, without the line breaks marked writes between its elements. */
export function markdownHtml(text: string): string {
  const html = markdown.parse(text, { async: false });
  return html.replace(/>\n+(?=<)/g, ">").trim();
}
