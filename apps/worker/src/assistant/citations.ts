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
 * [2][5], but no link's text, as in [2](…) and [[2]](…), nor a reference's label or its definition, as in
 * [2][docs] and [2]: …, nor a bracket escaped by an odd number of backslashes before it, as in \[2].
 */
const CITATIONS = /[^\S\n]*(?<!\])(?<!(?<!\\)(?:\\\\)*\\)((?:\[\^?\d{1,3}(?:[^\S\n]*[,–-][^\S\n]*\d{1,3})*\])+)(?![(:[\]])/g;

/** Code in a span, as backticks fence it. */
const CODE_SPAN = /(`+)[\s\S]*?[^`]\1(?!`)/;

/** A link written in place, its text and where it goes, with the brackets and parentheses they hold, as in [the docs [2]](…/(a)[1]). */
const INLINE_LINK = /\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\((?:[^\s()]|\([^\s()]*\))*(?:[^\S\n]+(?:"[^"\n]*"|'[^'\n]*'))?\)/;

/** A web address, up to what ends one, as a closing bracket does, with the brackets and parentheses it opens, as in ?ids=[1]&pages=[2]. */
const ADDRESS = /[a-z][a-z\d+.-]*:\/\/(?:[^\s<>()[\]"'`]|\([^\s<>()"'`]*\)|\[[^\s<>()[\]"'`]*\])*/;

/** Where brackets in a block's text are never a citation, so that their own stay. */
const KEPT = new RegExp([CODE_SPAN, INLINE_LINK, ADDRESS].map(({ source }) => source).join("|"), "gi");

/**
 * What ends a web address written in text, as a page's must be to be the page's: what can't be in one,
 * or punctuation followed by that or by the end, as a comma after one is, where a comma in one isn't.
 */
const ADDRESS_ENDS = /^(?:$|[\s<>()[\]{}"'`|]|[.,:;?!*_]+(?:$|[\s<>)\]}"'`|]))/;

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

/** Where a stretch of a block starts and ends in it. */
interface Span {
  from: number;
  to: number;
}

/** What an answer's citations are read with: the pages its searches found, and the labels of its own references, as [1]: … defines. */
interface Reading {
  pages: readonly Source[];
  labels: ReadonlySet<string>;
}

/**
 * The answer `text` without the citations it writes of `pages`, the pages its searches found, numbered
 * from 1 in the order the model read them, and the pages it cites, each once, in the order it first
 * cites them: by number, outside code, links, references' definitions and web addresses, a card's
 * payload's text included, or by writing a page's address, as in a link to it. A run of numbers that
 * aren't all pages', or that links to one of the answer's own references, is left as it's written, as it
 * may be no citation.
 */
export function citedIn(text: string, pages: readonly Source[]): { text: string; cited: Source[] } {
  // The lexer's blocks are the text as it's written, a block at a time, once its line breaks are "\n",
  // but for what it leaves out, as a label's second definition, which stays as it's written.
  const answer = text.replace(/\r\n?/g, "\n");
  const blocks = markdown.lexer(answer);
  const reading: Reading = { pages, labels: new Set(Object.keys(blocks.links)) };
  const citations: Citation[] = [];
  let shown = "";
  let at = 0;
  for (const block of blocks) {
    const from = answer.indexOf(block.raw, at);
    if (from < 0) break;
    const uncited = blockWithoutCitations(block, from, reading);
    citations.push(...uncited.citations);
    shown += answer.slice(at, from) + uncited.text;
    at = from + block.raw.length;
  }
  shown += answer.slice(at);
  for (const page of pages) {
    const written = addressAt(answer, page.url);
    if (written !== null) citations.push({ at: written, page });
  }
  const cited = new Map<string, Source>();
  for (const { page } of citations.sort((one, other) => one.at - other.at)) if (!cited.has(page.url)) cited.set(page.url, page);
  return { text: shown, cited: [...cited.values()] };
}

/**
 * One of an answer's blocks, `block`, from `offset` in it, without the citations `reading` finds in it:
 * none in what's kept as it's written but a card's payload's text, and none in a list or a quote where
 * what's kept can't be found.
 */
function blockWithoutCitations(block: Token, offset: number, reading: Reading): Uncited {
  if (block.type === "code" && isCards(block as Tokens.Code)) return payloadWithoutCitations(block as Tokens.Code, offset, reading);
  if (isKept(block)) return { text: block.raw, citations: [] };
  const kept = keptLinesIn(block);
  if (kept === null) return { text: block.raw, citations: [] };
  // The text before each kept block, and after the last, without its citations, and the kept blocks as
  // they're written.
  const uncited: Uncited = { text: "", citations: [] };
  let from = 0;
  for (const span of [...kept, { from: block.raw.length, to: block.raw.length }]) {
    const around = withoutCitations(block.raw.slice(from, span.from), offset + from, reading);
    uncited.text += around.text + block.raw.slice(span.from, span.to);
    uncited.citations.push(...around.citations);
    from = span.to;
  }
  return uncited;
}

/** Whether `code` is a ```slack block, whose payload shows as cards, as answers.ts reads its language. */
const isCards = (code: Tokens.Code) => (code.lang ?? "").trim().split(/\s/)[0]?.toLowerCase() === "slack";

/** Whether `token` is kept as it's written, as code and a reference's definition, title and all, are. */
const isKept = (token: Token) => token.type === "code" || token.type === "def";

/**
 * Where in `block` the lines of what it holds that's kept as it's written are, as a list or a quote
 * holds code, each from the start of its first line to the end of its last, or null when one isn't on
 * the lines the lexer read it from. It reads what a list or a quote holds a line for each of its lines,
 * without the indentation and the quote marks before them.
 */
function keptLinesIn(block: Token): Span[] | null {
  const lines = block.raw.split("\n");
  let start = 0;
  const starts = lines.map((line) => {
    const at = start;
    start += line.length + 1;
    return at;
  });
  const spans: Span[] = [];
  for (const { kept, line: first } of keptIn(block, 0)) {
    const held = kept.raw.replace(/\n+$/, "").split("\n");
    const last = first + held.length - 1;
    if (last >= lines.length || held.some((line, n) => unmarked(line) !== unmarked(lines[first + n]!))) return null;
    spans.push({ from: starts[first]!, to: starts[last]! + lines[last]!.length });
  }
  return spans;
}

/**
 * What `token` holds that's kept as it's written, as a list's items or a quote hold code, in the order it
 * holds them, each with the line of `token` it starts on, counted on from `line`, as `token`'s first is.
 */
function keptIn(token: Token, line: number): { kept: Token; line: number }[] {
  const inside: Token[] = [...("tokens" in token && token.tokens ? token.tokens : []), ...(token.type === "list" ? (token as Tokens.List).items : [])];
  let at = line;
  return inside.flatMap((nested) => {
    const held = isKept(nested) ? [{ kept: nested, line: at }] : keptIn(nested, at);
    at += nested.raw.split("\n").length - 1;
    return held;
  });
}

/** A line without the indentation and the quote marks before it. */
const unmarked = (line: string) => line.replace(/^[\s>]*/, "");

/** `part` of an answer, from `offset` in it, without the citations `reading` finds in it outside code, links and web addresses, and those citations. */
function withoutCitations(part: string, offset: number, { pages, labels }: Reading): Uncited {
  // What's kept is read with the rest, so that what's around a run, as a link after it, still tells what it is.
  const kept: Span[] = [...part.matchAll(KEPT)].map(({ 0: written, index }) => ({ from: index, to: index + written.length }));
  const citations: Citation[] = [];
  const text = part.replace(CITATIONS, (written: string, run: string, at: number) => {
    if (kept.some(({ from, to }) => at < to && from < at + written.length)) return written;
    const numbers = linksToReference(run, labels) ? null : numbersIn(run, pages.length);
    if (numbers === null) return written;
    citations.push(...numbers.map((number) => ({ at: offset + at, page: pages[number - 1]! })));
    return "";
  });
  return { text, citations };
}

/**
 * A ```slack block, `code`, from `offset` in the answer, with the citations of `pages` its payload's text
 * writes taken out of that text, and not out of its addresses, or as it's written when it cites none or
 * its payload doesn't parse, when it shows as code. Its citations count from where it starts. A card's
 * text links to none of the answer's references, as its mrkdwn has no Markdown's.
 */
function payloadWithoutCitations(code: Tokens.Code, offset: number, { pages }: Reading): Uncited {
  const payload = payloadOf(code.text);
  if (payload === null) return { text: code.raw, citations: [] };
  const reading: Reading = { pages, labels: new Set() };
  const citations: Citation[] = [];
  const uncited = (value: unknown, key: string): unknown => {
    if (typeof value === "string" && !ADDRESS_KEY.test(key)) {
      const { text, citations: cited } = withoutCitations(value, 0, reading);
      citations.push(...cited.map(({ page }) => ({ at: offset, page })));
      return text;
    }
    if (Array.isArray(value)) return value.map((item) => uncited(item, key));
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, uncited(item, name)]));
    return value;
  };
  const shown = uncited(payload, "");
  if (citations.length === 0) return { text: code.raw, citations };
  return { text: refenced(code, JSON.stringify(shown, null, 2)), citations };
}

/**
 * The fenced block `code` holding `text` in place of what it held, indented as its opening fence is. The
 * lexer reads what a fence holds without that indentation, a line for each of its lines.
 */
function refenced(code: Tokens.Code, text: string): string {
  const [opening = "", ...rest] = code.raw.split("\n");
  const indent = opening.slice(0, opening.length - opening.trimStart().length);
  return [opening, ...text.split("\n").map((line) => indent + line), ...rest.slice(code.text.split("\n").length)].join("\n");
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

/**
 * Whether a run of citations, `run`, links to one of the answer's own references, whose `labels` its
 * definitions give, as [1] does where the answer defines [1]: …, as the lexer reads labels.
 */
const linksToReference = (run: string, labels: ReadonlySet<string>) =>
  labels.size > 0 && [...run.matchAll(/\[([^\]]*)\]/g)].some(([, label = ""]) => labels.has(label.trim().replace(/\s+/g, " ").toLowerCase()));

/** Where `text` first writes the address `url`, whole, as the start of a longer one is another page's, or null where it doesn't. */
function addressAt(text: string, url: string): number | null {
  for (let at = text.indexOf(url); at >= 0; at = text.indexOf(url, at + 1)) {
    if (ADDRESS_ENDS.test(text.slice(at + url.length))) return at;
  }
  return null;
}
