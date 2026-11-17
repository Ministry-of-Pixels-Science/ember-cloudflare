import { Marked, type Token, type Tokens } from "marked";
import { payloadOf } from "../bots/slack";
import type { Source } from "./gateway";

// How a model that searches the web with Ember's own tool, as Grok and Workers AI's models do, says which
// pages its answer came from. Their APIs have no citations of their own, so Ember numbers the pages the
// answer's searches find, as the model reads them, and the model writes a page's number in brackets after
// what it takes from it, as [2]. Ember takes those numbers out of the answer and names the pages they cite
// under it, as it names the pages Claude's and GPT's answers cite, so that pages the answer didn't use,
// which a search finds plenty of, aren't named.

/**
 * A run of citations as a model writes them, with the space before it: [2], [2, 5], [2-4], [^2] or
 * [2][5], but no link's text, as in [2](…), nor a reference's label or its definition, as in [2][docs]
 * and [2]: ….
 */
const CITATIONS = /[^\S\n]*(?<!\])((?:\[\^?\d{1,3}(?:[^\S\n]*[,–-][^\S\n]*\d{1,3})*\])+)(?![(:[])/g;

/**
 * Where brackets are never a citation: code, as backticks fence it, in a span or a block in a list or a
 * quote, and a web address, up to what ends one, as a closing bracket does, so that its own brackets stay.
 */
const KEPT = /(`+)[\s\S]*?[^`]\1(?!`)|[a-z][a-z\d+.-]*:\/\/[^\s<>()\]"'`]*/gi;

/** What ends a web address written in text, as a page's must be to be the page's. */
const ADDRESS_ENDS = /^(?:$|[\s<>()[\]{}"'`|,;!*_]|[.:?]+(?:$|[\s<>()[\]{}"'`|,;!*_]))/;

/** The keys of a card's payload whose values are web addresses, as a button's `url` and a picture's `image_url` are, which keep their brackets. */
const ADDRESS_KEY = /(?:url|link|icon)$/i;

/** The Markdown an answer is written in, as Ember reads it for its cards (answers.ts). */
const markdown = new Marked({ gfm: true });

/** A page an answer cites, and where in the answer it first does. */
interface Citation {
  at: number;
  page: Source;
}

/** Text without the citations it writes, and those citations. */
interface Uncited {
  text: string;
  citations: Citation[];
}

/**
 * The answer `text` without the citations it writes of `pages`, the pages its searches found, numbered
 * from 1 in the order the model read them, and the pages it cites, each once, in the order it first
 * cites them: by number, outside code and web addresses, a card's payload's text included, or by writing
 * a page's address, as in a link to it. A run of numbers that aren't all pages' is left as it's written,
 * as it may be no citation.
 */
export function citedIn(text: string, pages: readonly Source[]): { text: string; cited: Source[] } {
  // The lexer's blocks are the text as it's written, a block at a time, once its line breaks are "\n".
  const answer = text.replace(/\r\n?/g, "\n");
  const citations: Citation[] = [];
  let shown = "";
  let at = 0;
  for (const block of markdown.lexer(answer)) {
    const uncited = blockWithoutCitations(block, at, pages);
    citations.push(...uncited.citations);
    shown += uncited.text;
    at += block.raw.length;
  }
  for (const page of pages) {
    const written = addressAt(answer, page.url);
    if (written !== null) citations.push({ at: written, page });
  }
  const cited = new Map<string, Source>();
  for (const { page } of citations.sort((one, other) => one.at - other.at)) if (!cited.has(page.url)) cited.set(page.url, page);
  return { text: shown, cited: [...cited.values()] };
}

/**
 * One of an answer's blocks, `block`, from `offset` in it, without the citations it writes of `pages`:
 * none in code but a card's payload's text, and none in a block holding code that isn't fenced with
 * backticks, as a list's indented code is, which only the lexer can tell apart from the list's text.
 */
function blockWithoutCitations(block: Token, offset: number, pages: readonly Source[]): Uncited {
  if (block.type === "code") return isCards(block as Tokens.Code) ? payloadWithoutCitations(block as Tokens.Code, offset, pages) : { text: block.raw, citations: [] };
  if (holdsUnfencedCode(block)) return { text: block.raw, citations: [] };
  return withoutCitations(block.raw, offset, pages);
}

/** Whether `code` is a ```slack block, whose payload shows as cards, as answers.ts reads its language. */
const isCards = (code: Tokens.Code) => (code.lang ?? "").trim().split(/\s/)[0]?.toLowerCase() === "slack";

/** Whether `token` holds code that isn't fenced with backticks, indented or fenced with tildes. */
function holdsUnfencedCode(token: Token): boolean {
  const inside: Token[] = [...("tokens" in token && token.tokens ? token.tokens : []), ...(token.type === "list" ? (token as Tokens.List).items : [])];
  return inside.some((nested) => (nested.type === "code" && !nested.raw.trimStart().startsWith("`")) || holdsUnfencedCode(nested));
}

/** `part` of an answer, from `offset` in it, without the citations it writes of `pages` outside code and web addresses, and those citations. */
function withoutCitations(part: string, offset: number, pages: readonly Source[]): Uncited {
  const citations: Citation[] = [];
  const uncited = (between: string, from: number) =>
    between.replace(CITATIONS, (written: string, run: string, at: number) => {
      const numbers = numbersIn(run, pages.length);
      if (numbers === null) return written;
      citations.push(...numbers.map((number) => ({ at: offset + from + at, page: pages[number - 1]! })));
      return "";
    });
  let text = "";
  let from = 0;
  for (const { 0: kept, index } of part.matchAll(KEPT)) {
    text += uncited(part.slice(from, index), from) + kept;
    from = index + kept.length;
  }
  return { text: text + uncited(part.slice(from), from), citations };
}

/**
 * A ```slack block, `code`, from `offset` in the answer, with the citations its payload's text writes of
 * `pages` taken out of that text, and not out of its addresses, or as it's written when it cites none or
 * its payload doesn't parse, when it shows as code. Its citations count from where it starts.
 */
function payloadWithoutCitations(code: Tokens.Code, offset: number, pages: readonly Source[]): Uncited {
  const payload = payloadOf(code.text);
  const at = code.raw.indexOf(code.text);
  if (payload === null || at < 0) return { text: code.raw, citations: [] };
  const citations: Citation[] = [];
  const uncited = (value: unknown, key: string): unknown => {
    if (typeof value === "string" && !ADDRESS_KEY.test(key)) {
      const { text, citations: cited } = withoutCitations(value, 0, pages);
      citations.push(...cited.map(({ page }) => ({ at: offset, page })));
      return text;
    }
    if (Array.isArray(value)) return value.map((item) => uncited(item, key));
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, uncited(item, name)]));
    return value;
  };
  const shown = uncited(payload, "");
  if (citations.length === 0) return { text: code.raw, citations };
  return { text: code.raw.slice(0, at) + JSON.stringify(shown, null, 2) + code.raw.slice(at + code.text.length), citations };
}

/**
 * The numbers a run of citations, `run`, cites, ranges spelled out, or null when any isn't one of the
 * `count` pages', as a run that's something else, such as [2024], may be.
 */
function numbersIn(run: string, count: number): number[] | null {
  const numbers: number[] = [];
  for (const [range = ""] of run.matchAll(/\d+(?:[^\S\n]*[–-][^\S\n]*\d+)?/g)) {
    const [first = 0, last = first] = range.split(/[–-]/).map((number) => Number(number.trim()));
    if (first < 1 || last < first || last > count) return null;
    for (let number = first; number <= last; number++) numbers.push(number);
  }
  return numbers.length > 0 ? numbers : null;
}

/** Where `text` first writes the address `url`, whole, as the start of a longer one is another page's, or null where it doesn't. */
function addressAt(text: string, url: string): number | null {
  for (let at = text.indexOf(url); at >= 0; at = text.indexOf(url, at + 1)) {
    if (ADDRESS_ENDS.test(text.slice(at + url.length, at + url.length + 2))) return at;
  }
  return null;
}
