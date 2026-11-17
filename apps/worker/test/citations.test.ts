import { describe, expect, it } from "vitest";
import { citedIn } from "../src/assistant/citations";

const DOCS = { url: "https://developers.cloudflare.com/ai-gateway/", title: "AI Gateway docs" };
const BLOG = { url: "https://blog.cloudflare.com/ai-gateway-ga/", title: "AI Gateway is generally available" };
const NEWS = { url: "https://example.com/news", title: "News" };
const PAGES = [DOCS, BLOG, NEWS];

/** A ```slack block of `payload`, as a model writes one, after `language`. */
const card = (payload: unknown, language = "slack") => `\`\`\`${language}\n${JSON.stringify(payload, null, 2)}\n\`\`\``;

describe("What an answer cites of the pages Ember's searches found", () => {
  it("takes out the numbers it cites pages by, with the space before them, and names those pages, each once, in the order it first cites them", () => {
    expect(citedIn("It's a proxy [2]. It logs requests [1][2].", PAGES)).toEqual({ text: "It's a proxy. It logs requests.", cited: [BLOG, DOCS] });
    expect(citedIn("It's a proxy.[3]\n\nIt caches [3].", PAGES)).toEqual({ text: "It's a proxy.\n\nIt caches.", cited: [NEWS] });
    expect(citedIn("It's a proxy [2].\r\nIt caches [1].", PAGES)).toEqual({ text: "It's a proxy.\nIt caches.", cited: [BLOG, DOCS] });
    expect(citedIn("Nothing cited.", PAGES)).toEqual({ text: "Nothing cited.", cited: [] });
  });

  it("reads a run of numbers, ranges, and footnotes as models write them", () => {
    expect(citedIn("Both [1, 3].", PAGES).cited).toEqual([DOCS, NEWS]);
    expect(citedIn("All [1-3].", PAGES).cited).toEqual([DOCS, BLOG, NEWS]);
    expect(citedIn("All [1–3].", PAGES).cited).toEqual([DOCS, BLOG, NEWS]);
    expect(citedIn("A footnote[^2].", PAGES)).toEqual({ text: "A footnote.", cited: [BLOG] });
  });

  it("leaves brackets that aren't all pages' numbers, escaped ones, a link's text, and a reference's label, its definition and the links to it as they're written", () => {
    for (const text of ["In [2024] it grew.", "See [4].", "See [0].", "See [3-1].", "See [1, 9].", "A list [a].", "[1](https://example.com/one)", "[[1]](https://example.com/one)", "[See [2]](https://example.com/two)", "[see [1] here](https://example.com/one)", "[x](/wiki/A_(b)[1])", "[1]: https://example.com/one"]) {
      expect(citedIn(text, PAGES)).toEqual({ text, cited: [] });
    }
    for (const text of ["Literal \\[1].", "A footnote \\[^2].", "Three \\\\\\[2]."]) expect(citedIn(text, PAGES)).toEqual({ text, cited: [] });
    // A backslash written as itself doesn't escape the bracket after it.
    expect(citedIn("A backslash \\\\[2].", PAGES)).toEqual({ text: "A backslash \\\\.", cited: [BLOG] });
    for (const text of ["[the docs][1] say so.", "Read [1][manual] first.\n\n[manual]: https://example.com/manual", "It grew [1].\n\n[1]: https://example.com/one", "It grew [3][2].\n\n[2]: https://example.com/two", "It grew [1][the report](https://example.com/report)."]) {
      expect(citedIn(text, PAGES)).toEqual({ text, cited: [] });
    }
    // A definition keeps its title, in a list too, and a label's second one, which the lexer leaves out, is kept whole.
    const definition = '[docs]: https://example.com/docs "Edition [1]"';
    expect(citedIn(`It grew [2].\n\n${definition}`, PAGES)).toEqual({ text: `It grew.\n\n${definition}`, cited: [BLOG] });
    expect(citedIn(`- It grew [2].\n\n  ${definition}\n- It's out [3].`, PAGES)).toEqual({ text: `- It grew.\n\n  ${definition}\n- It's out.`, cited: [BLOG, NEWS] });
    expect(citedIn(`[docs]: https://example.com/a\n\n${definition}\n\nIt grew [2].`, PAGES)).toEqual({ text: `[docs]: https://example.com/a\n\n${definition}\n\nIt grew.`, cited: [BLOG] });
  });

  it("leaves code as it's written, however it's fenced or indented, and a web address's own brackets", () => {
    for (const code of ["```js\nconst first = pages[1];\n```", "~~~js\nconst first = pages[1];\n~~~", "    const first = pages[1];"]) {
      expect(citedIn(code, PAGES)).toEqual({ text: code, cited: [] });
    }
    expect(citedIn("Write `list[1]` [2].", PAGES)).toEqual({ text: "Write `list[1]`.", cited: [BLOG] });
    expect(citedIn("See [the report](https://example.com/report?ids=[1]) [2].", PAGES)).toEqual({ text: "See [the report](https://example.com/report?ids=[1]).", cited: [BLOG] });
    expect(citedIn("See [the report](https://example.com/(item[1])) [2].", PAGES)).toEqual({ text: "See [the report](https://example.com/(item[1])).", cited: [BLOG] });
    for (const address of ["https://example.com/report?ids=[1]&pages=[2]", "<https://example.com/report?ids=[1]&pages=[2]>"]) {
      expect(citedIn(`See ${address} [3].`, PAGES)).toEqual({ text: `See ${address}.`, cited: [NEWS] });
    }
    // A bracket an address doesn't open still ends it.
    expect(citedIn("[See https://example.com/report] [2].", PAGES)).toEqual({ text: "[See https://example.com/report].", cited: [BLOG] });
  });

  it("takes citations out of a list's or a quote's text around the code it holds, but not out of the code", () => {
    expect(citedIn("- Run it:\n\n      const first = pages[1];\n\n  It's on March 3 [2].\n- Released yesterday [3].", PAGES)).toEqual({
      text: "- Run it:\n\n      const first = pages[1];\n\n  It's on March 3.\n- Released yesterday.",
      cited: [BLOG, NEWS],
    });
    expect(citedIn("- Run:\n\n  ```js\n  pages[1]\n  ```\n- It's out [3].", PAGES)).toEqual({ text: "- Run:\n\n  ```js\n  pages[1]\n  ```\n- It's out.", cited: [NEWS] });
    expect(citedIn("> ~~~js\n> const first = pages[1];\n> ~~~\n>\n> It's out [2].", PAGES)).toEqual({ text: "> ~~~js\n> const first = pages[1];\n> ~~~\n>\n> It's out.", cited: [BLOG] });
    expect(citedIn("- A quote:\n\n  >     const first = pages[1];\n  >\n  > It's out [2].", PAGES)).toEqual({ text: "- A quote:\n\n  >     const first = pages[1];\n  >\n  > It's out.", cited: [BLOG] });
    expect(citedIn("> It's out [2].\n>\n>     It's out [2].", PAGES)).toEqual({ text: "> It's out.\n>\n>     It's out [2].", cited: [BLOG] });
    // Code begun on an item's number can't be told from the item's text, so the list stays as it's written.
    const numbered = "1.     const first = pages[1];\n\n   It's out [2].";
    expect(citedIn(numbered, PAGES)).toEqual({ text: numbered, cited: [] });
  });

  it("takes citations out of the text of a card's payload, but not out of its addresses or its JSON's own brackets", () => {
    const payload = {
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Warriors 112, Lakers 108 [3] <https://example.com/box?ids=[1]|Box score>" } },
        { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Report" }, url: "https://example.com/report?ids=[2]" }] },
      ],
      ranks: [1],
    };
    const uncited = structuredClone(payload);
    uncited.blocks[0]!.text!.text = "Warriors 112, Lakers 108 <https://example.com/box?ids=[1]|Box score>";
    expect(citedIn(`The score [3].\n\n${card(payload)}`, PAGES)).toEqual({ text: `The score.\n\n${card(uncited)}`, cited: [NEWS] });
    expect(citedIn(card(payload, "Slack json"), PAGES)).toEqual({ text: card(uncited, "Slack json"), cited: [NEWS] });
    // A card's mrkdwn doesn't link to the answer's own references.
    const defined = "\n\n[3]: https://example.com/overview";
    expect(citedIn(card(payload) + defined, PAGES)).toEqual({ text: card(uncited) + defined, cited: [NEWS] });
    const indented = (block: string) => `  ${block.replaceAll("\n", "\n  ")}`;
    expect(citedIn(`The score:\n\n${indented(card(payload))}\n\nFinal.`, PAGES)).toEqual({ text: `The score:\n\n${indented(card(uncited))}\n\nFinal.`, cited: [NEWS] });
  });

  it("leaves a card's payload as it's written when it cites nothing, or doesn't parse, as it then shows as code", () => {
    const tight = '```slack\n{"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"Top"}}]}\n```';
    expect(citedIn(tight, PAGES)).toEqual({ text: tight, cited: [] });
    const broken = '```slack\n{"blocks": [{"text": "Top [2]"\n```';
    expect(citedIn(broken, PAGES)).toEqual({ text: broken, cited: [] });
  });

  it("counts a page whose address the answer writes as cited, though it gives no number, and only its whole address", () => {
    expect(citedIn(`Read [the docs](${DOCS.url}) first [2].`, PAGES).cited).toEqual([DOCS, BLOG]);
    expect(citedIn(`It grew [1].\n\n[1]: ${NEWS.url}`, PAGES)).toEqual({ text: `It grew [1].\n\n[1]: ${NEWS.url}`, cited: [NEWS] });
    for (const text of [`At ${NEWS.url}.`, `At ${NEWS.url}, then.`, `At _${NEWS.url}_.`, `At (${NEWS.url}).`]) expect(citedIn(text, PAGES).cited).toEqual([NEWS]);
    for (const text of [`At ${NEWS.url}/sports.`, `At ${NEWS.url},2026.`, `At ${NEWS.url};edition=2.`, `At ${NEWS.url}_archive.`]) expect(citedIn(text, PAGES).cited).toEqual([]);
  });

  it("counts no pages when no searches found any", () => {
    expect(citedIn("It's a proxy [1].", [])).toEqual({ text: "It's a proxy [1].", cited: [] });
  });
});
