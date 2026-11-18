import { describe, expect, it } from "vitest";
import { forOneReading, MAX_ATTRIBUTES, MAX_COPIED_ATTRIBUTES_LENGTH, MAX_REOPENED_ELEMENTS, ParseLimitError } from "./markup";
import { parseHtml } from "./parse";
import { toHtml } from "./serialize";

const roundTrip = (markup: string) => toHtml(parseHtml(markup));

const failure = (markup: string, parse = parseHtml) => {
  try {
    parse(markup);
    return undefined;
  } catch (error) {
    if (error instanceof ParseLimitError) return error.limit;
    throw error;
  }
};

const numberedAttributes = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `a${from + i}=${from + i}`).join(" ");

/** A title that serializes to `length` units, the space before it included. */
const titleOf = (length: number) => `title="${"x".repeat(length - ' title=""'.length)}"`;

/** A `<b>` with `attributes` that the first paragraph leaves open, reopened in each of `copies` more. */
const reopening = (attributes: string, copies: number) => `<p><b ${attributes}>x</p>${"<p>x</p>".repeat(copies)}`;

// The answers come from Nokogiri 1.19.4.
describe("Rich text, safely", () => {
  it("parses and serializes like Nokogiri", () => {
    expect(roundTrip("<td>x</td>")).toBe("x");
    expect(roundTrip("<p><table><tr><td>a</td></tr></table>")).toBe("<p></p><table><tbody><tr><td>a</td></tr></tbody></table>");
    expect(roundTrip("<a title='a<b>c' href=\"x&y\u00A0z\">t&lt;\u00A0>\"'</a>")).toBe(
      "<a title=\"a<b>c\" href=\"x&amp;y&nbsp;z\">t&lt;&nbsp;&gt;\"'</a>",
    );
    expect(toHtml(parseHtml("<a title='a<b>c'>d>e</a>"), { escapeAttributeBrackets: true })).toBe(
      '<a title="a&lt;b&gt;c">d&gt;e</a>',
    );
    expect(roundTrip("<pre>\n\nx</pre>")).toBe("<pre>\nx</pre>");
    expect(roundTrip("<noscript><b>x</b></noscript>")).toBe("<noscript><b>x</b></noscript>");
    expect(roundTrip("<?php x ?>")).toBe("<!--?php x ?-->");
    expect(roundTrip("<SVG viewBox='0 0 1 1'><CLIPPATH/></SVG>")).toBe('<svg viewBox="0 0 1 1"><clipPath></clipPath></svg>');
    expect(roundTrip("<template><td>x</td></template>")).toBe("<template><td>x</td></template>");
  });

  it("drops only a leading byte order mark", () => {
    expect(roundTrip("\uFEFF\uFEFFx")).toBe("\uFEFFx");
    expect(roundTrip("<script></script>\uFEFFx")).toBe("<script></script>\uFEFFx");
  });

  it("parses in a context", () => {
    expect(toHtml(parseHtml("<td>x</td>", { name: "tr", namespace: "http://www.w3.org/1999/xhtml" }))).toBe("<td>x</td>");
    expect(toHtml(parseHtml("<b>x</b>", { name: "textarea", namespace: "http://www.w3.org/1999/xhtml" }))).toBe(
      "&lt;b&gt;x&lt;/b&gt;",
    );
    expect(toHtml(parseHtml("<b>&amp;</b>", { name: "noscript", namespace: "http://www.w3.org/1999/xhtml" }))).toBe("<b>&amp;</b>");
  });

  it("enforces Gumbo's tree depth limit", () => {
    const b = (n: number) => "<b>".repeat(n);
    expect(failure(b(400))).toBeUndefined();
    expect(failure(b(401))).toBe("depth");
    expect(failure(`${b(401)}x`)).toBe("depth");
    expect(failure(`${b(400)}<p>`)).toBe("depth");
    expect(failure(`${b(397)}<table><td>`)).toBe("depth");
  });

  it("counts open elements as Gumbo does rather than the final tree's depth", () => {
    const b = (n: number) => "<b>".repeat(n);
    const span = (n: number) => "<span>".repeat(n);
    const div = (n: number) => "<div>".repeat(n);
    // A void element never goes on the stack of open elements
    expect(failure(`${b(400)}<br>`)).toBeUndefined();
    expect(failure(`${b(400)}</p>`)).toBeUndefined();
    // Closing everything again doesn't undo having been too deep
    expect(failure(`${b(401)}${"</b>".repeat(401)}`)).toBe("depth");
    // The adoption agency moves blocks back up, and what counts is how deep they were
    expect(failure(`<b>${span(300)}${div(10)}</b>`.repeat(3))).toBeUndefined();
    expect(failure(`<b>${span(390)}${div(10)}</b>${div(300)}`)).toBe("depth");
    // Text pending in a table reopens the <b>s past the limit when the input ends, and Gumbo
    // doesn't check after that
    const bs = Array.from({ length: 399 }, (_, i) => `<b id=${i + 1}>`).join("");
    const reopened = `<p>${bs}</p><div><div><table>x`;
    expect(failure(reopened)).toBeUndefined();
    expect(failure(`${reopened}<!---->`)).toBe("depth");
  });

  it("enforces Gumbo's attribute limit", () => {
    expect(MAX_ATTRIBUTES).toBe(400);
    expect(failure(`<p ${numberedAttributes(1, 400)}>x</p>`)).toBeUndefined();
    expect(failure(`<p ${numberedAttributes(1, 401)}>x</p>`)).toBe("attributes");
    expect(failure(`<p ${Array(1000).fill("a=1").join(" ")}>x</p>`)).toBeUndefined();
    expect(failure(`<textarea><p ${numberedAttributes(1, 401)}>`)).toBeUndefined();
  });

  it("counts attributes as Gumbo's tokenizer does", () => {
    const attributes = numberedAttributes(1, 400);
    // Before dropping a duplicate, on end tags, and on a tag the input ends inside
    expect(failure(`<p ${attributes} a1=again>x</p>`)).toBe("attributes");
    expect(failure(`<p>x</p ${attributes} a401>`)).toBe("attributes");
    expect(failure(`<p ${attributes} a401`)).toBe("attributes");
  });

  it("limits the formatting elements a parse reopens, which Gumbo doesn't", () => {
    expect(MAX_REOPENED_ELEMENTS).toBe(1_000);
    // Each paragraph reopens the three elements the first one left open
    const paragraphs = (n: number) => `<p><b><i><u>x</p>${"<p>x</p>".repeat(n)}`;
    expect(failure(paragraphs(333))).toBeUndefined();
    expect(failure(paragraphs(334))).toBe("reopened");
  });

  it("limits the attributes a parse copies with its formatting elements, which Gumbo doesn't", () => {
    expect(MAX_COPIED_ATTRIBUTES_LENGTH).toBe(100_000);
    expect(failure(reopening(titleOf(1_000), 100))).toBeUndefined();
    expect(failure(reopening(titleOf(1_000), 101))).toBe("copied");
    // One copy each: of an element reopened, of one the adoption agency closes around a block, and of
    // a formatting element between the two
    const copiedOnce = [
      (attributes: string) => `<p><b ${attributes}>x<p>x`,
      (attributes: string) => `<b ${attributes}><div></b>`,
      (attributes: string) => `<b><i ${attributes}><div></b>`,
    ];
    for (const markup of copiedOnce) {
      expect(roundTrip(markup("title=x")).split('title="x"').length - 1, markup("title=x")).toBe(2);
      expect(failure(markup(titleOf(100_000)))).toBeUndefined();
      expect(failure(markup(titleOf(100_001)))).toBe("copied");
    }
    // Each end tag has the adoption agency close another <b> around the block, and copy the <i> again
    const unclosed = Array.from({ length: 300 }, (_, i) => `<b id=${i}>`).join("");
    const copiedByEach = (attributes: string) => `${unclosed}<i ${attributes}><div>${"</b>".repeat(300)}`;
    expect(roundTrip(copiedByEach("title=x")).split('title="x"').length - 1).toBe(301);
    expect(failure(copiedByEach(titleOf(1_000)))).toBe("copied");
  });

  it("counts copied attributes as the stored form writes them", () => {
    // Five characters that serialize to 25, each escaped
    const escaped = `title='${'"&\u00A0<>'.repeat(39)}${"x".repeat(16)}'`;
    expect(toHtml(parseHtml(`<b ${escaped}>`), { escapeAttributeBrackets: true })).toHaveLength("<b></b>".length + 1_000);
    expect(failure(reopening(escaped, 100))).toBeUndefined();
    expect(failure(reopening(escaped, 101))).toBe("copied");
  });

  it("counts what the parses of one reading copy together", () => {
    const read = forOneReading(parseHtml);
    expect(failure(reopening(titleOf(1_000), 60), read)).toBeUndefined();
    expect(failure(reopening(titleOf(1_000), 40), read)).toBeUndefined();
    expect(failure(reopening(titleOf(1_000), 1), read)).toBe("copied");
    // Another reading counts apart, as does each parse outside one
    expect(failure(reopening(titleOf(1_000), 100), forOneReading(read))).toBeUndefined();
    expect(failure(reopening(titleOf(1_000), 100))).toBeUndefined();
    expect(failure(reopening(titleOf(1_000), 100))).toBeUndefined();
  });

  it("keeps what the tokenizer already deduplicated", () => {
    expect(roundTrip("<p title=a TITLE=b id=c title=d>x</p>")).toBe('<p title="a" id="c">x</p>');
    expect(roundTrip("<svg xlink:href=a href=b viewbox=c><a xlink:href=d>x</a></svg>")).toBe(
      '<svg xlink:href="a" href="b" viewBox="c"><a xlink:href="d">x</a></svg>',
    );
  });
});
