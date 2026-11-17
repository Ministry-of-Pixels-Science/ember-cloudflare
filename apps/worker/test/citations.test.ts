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

  it("leaves brackets that aren't all pages' numbers, a link's text and a reference's label and definition as they're written", () => {
    for (const text of ["In [2024] it grew.", "See [4].", "See [0].", "See [3-1].", "See [1, 9].", "A list [a].", "[1](https://example.com/one)", "[1]: https://example.com/one"]) {
      expect(citedIn(text, PAGES)).toEqual({ text, cited: [] });
    }
    for (const text of ["[the docs][1] say so.", "Read [1][manual] first.\n\n[manual]: https://example.com/manual"]) {
      expect(citedIn(text, PAGES)).toEqual({ text, cited: [] });
    }
  });

  it("leaves code as it's written, however it's fenced or indented, and a web address's own brackets", () => {
    for (const code of ["```js\nconst first = pages[1];\n```", "~~~js\nconst first = pages[1];\n~~~", "    const first = pages[1];", "- Run it:\n\n      const first = pages[1];\n\n  It's on March 3 [2]."]) {
      expect(citedIn(code, PAGES)).toEqual({ text: code, cited: [] });
    }
    expect(citedIn("Write `list[1]` [2].", PAGES)).toEqual({ text: "Write `list[1]`.", cited: [BLOG] });
    expect(citedIn("- Run:\n\n  ```js\n  pages[1]\n  ```\n- It's out [3].", PAGES)).toEqual({ text: "- Run:\n\n  ```js\n  pages[1]\n  ```\n- It's out.", cited: [NEWS] });
    expect(citedIn("See [the report](https://example.com/report?ids=[1]) [2].", PAGES)).toEqual({ text: "See [the report](https://example.com/report?ids=[1]).", cited: [BLOG] });
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
  });

  it("leaves a card's payload as it's written when it cites nothing, or doesn't parse, as it then shows as code", () => {
    const tight = '```slack\n{"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"Top"}}]}\n```';
    expect(citedIn(tight, PAGES)).toEqual({ text: tight, cited: [] });
    const broken = '```slack\n{"blocks": [{"text": "Top [2]"\n```';
    expect(citedIn(broken, PAGES)).toEqual({ text: broken, cited: [] });
  });

  it("counts a page whose address the answer writes as cited, though it gives no number, and only its whole address", () => {
    expect(citedIn(`Read [the docs](${DOCS.url}) first [2].`, PAGES).cited).toEqual([DOCS, BLOG]);
    expect(citedIn(`At ${NEWS.url}.`, PAGES).cited).toEqual([NEWS]);
    expect(citedIn(`At ${NEWS.url}/sports.`, PAGES).cited).toEqual([]);
  });

  it("counts no pages when no searches found any", () => {
    expect(citedIn("It's a proxy [1].", [])).toEqual({ text: "It's a proxy [1].", cited: [] });
  });
});
