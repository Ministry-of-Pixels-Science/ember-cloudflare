import { payloadOf } from "../bots/slack";
import type { Source } from "./gateway";

// How a model that searches the web with Ember's own tool, as Grok and Workers AI's models do, says which
// pages its answer came from. Their APIs have no citations of their own, so Ember numbers the pages the
// answer's searches find, as the model reads them, and the model writes a page's number in brackets after
// what it takes from it, as [2]. Ember takes those numbers out of the answer and names the pages they cite
// under it, as it names the pages Claude's and GPT's answers cite, so that pages the answer didn't use,
// which a search finds plenty of, aren't named.

/** A run of citations as a model writes them, with the space before it: [2], [2, 5], [2-4], [^2] or [2][5], but no link's text, as in [2](…), nor a reference's. */
const CITATIONS = /[^\S\n]*(?<!\])((?:\[\^?\d{1,3}(?:[^\S\n]*[,–-][^\S\n]*\d{1,3})*\])+)(?![(:])/g;

/** Code, as backticks fence it, in a block or a span, where brackets are the code's own. */
const CODE = /(`+)([\s\S]*?[^`])\1(?!`)/g;

/** The language of a fenced block whose payload shows as cards, whose text shows, citations and all. */
const CARDS_BLOCK = /^slack\b/i;

/** What ends a web address written in text, as a page's must be to be the page's. */
const ADDRESS_ENDS = /^(?:$|[\s<>()[\]{}"'`|,;!*_]|[.:?]+(?:$|[\s<>()[\]{}"'`|,;!*_]))/;

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
 * cites them: by number, outside code but for a card's payload, or by writing a page's address, as in a
 * link to it. A run of numbers that aren't all pages' is left as it's written, as it may be no citation.
 */
export function citedIn(text: string, pages: readonly Source[]): { text: string; cited: Source[] } {
  const citations: Citation[] = [];
  const take = (uncited: Uncited) => {
    citations.push(...uncited.citations);
    return uncited.text;
  };
  let shown = "";
  let from = 0;
  for (const { 0: code, 1: fence = "", 2: inside = "", index } of text.matchAll(CODE)) {
    shown += take(withoutCitations(text.slice(from, index), from, pages));
    shown += fence.length >= 3 && CARDS_BLOCK.test(inside) ? fence + take(payloadWithoutCitations(inside, index + fence.length, pages)) + fence : code;
    from = index + code.length;
  }
  shown += take(withoutCitations(text.slice(from), from, pages));
  for (const page of pages) {
    const at = addressAt(text, page.url);
    if (at !== null) citations.push({ at, page });
  }
  const cited = new Map<string, Source>();
  for (const { page } of citations.sort((one, other) => one.at - other.at)) if (!cited.has(page.url)) cited.set(page.url, page);
  return { text: shown, cited: [...cited.values()] };
}

/** `part` of an answer, from `offset` in it, without the citations it writes of `pages`, and those citations. */
function withoutCitations(part: string, offset: number, pages: readonly Source[]): Uncited {
  const citations: Citation[] = [];
  const text = part.replace(CITATIONS, (written: string, run: string, at: number) => {
    const numbers = numbersIn(run, pages.length);
    if (numbers === null) return written;
    citations.push(...numbers.map((number) => ({ at: offset + at, page: pages[number - 1]! })));
    return "";
  });
  return { text, citations };
}

/**
 * What a ```slack block of an answer holds, `inside`, from `offset` in it: its language, then a card's
 * payload, whose text shows, without the citations it writes, unless taking them out leaves JSON that
 * doesn't parse, as taking out an array of numbers would, or it never parsed, when it shows as code.
 */
function payloadWithoutCitations(inside: string, offset: number, pages: readonly Source[]): Uncited {
  const parses = (block: string) => payloadOf(block.slice(block.indexOf("\n") + 1)) !== null;
  const uncited = withoutCitations(inside, offset, pages);
  return parses(inside) && parses(uncited.text) ? uncited : { text: inside, citations: [] };
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
