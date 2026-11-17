import { describe, expect, it } from "vitest";
import { citedIn } from "../src/assistant/citations";

const DOCS = { url: "https://developers.cloudflare.com/ai-gateway/", title: "AI Gateway docs" };
const BLOG = { url: "https://blog.cloudflare.com/ai-gateway-ga/", title: "AI Gateway is generally available" };
const NEWS = { url: "https://example.com/news", title: "News" };
const PAGES = [DOCS, BLOG, NEWS];

describe("What an answer cites of the pages Ember's searches found", () => {
  it("takes out the numbers it cites pages by, with the space before them, and names those pages, each once, in the order it first cites them", () => {
    expect(citedIn("It's a proxy [2]. It logs requests [1][2].", PAGES)).toEqual({ text: "It's a proxy. It logs requests.", cited: [BLOG, DOCS] });
    expect(citedIn("It's a proxy.[3]\n\nIt caches [3].", PAGES)).toEqual({ text: "It's a proxy.\n\nIt caches.", cited: [NEWS] });
    expect(citedIn("Nothing cited.", PAGES)).toEqual({ text: "Nothing cited.", cited: [] });
  });

  it("reads a run of numbers, ranges, and footnotes as models write them", () => {
    expect(citedIn("Both [1, 3].", PAGES).cited).toEqual([DOCS, NEWS]);
    expect(citedIn("All [1-3].", PAGES).cited).toEqual([DOCS, BLOG, NEWS]);
    expect(citedIn("All [1–3].", PAGES).cited).toEqual([DOCS, BLOG, NEWS]);
    expect(citedIn("A footnote[^2].", PAGES)).toEqual({ text: "A footnote.", cited: [BLOG] });
  });

  it("leaves brackets that aren't all pages' numbers, a link's text and a reference as they're written", () => {
    for (const text of ["In [2024] it grew.", "See [4].", "See [0].", "See [3-1].", "See [1, 9].", "A list [a].", "[1](https://example.com/one)", "[1]: https://example.com/one"]) {
      expect(citedIn(text, PAGES)).toEqual({ text, cited: [] });
    }
    expect(citedIn("[the docs][1] say so.", PAGES)).toEqual({ text: "[the docs][1] say so.", cited: [] });
  });

  it("leaves code as it's written, but for a card's payload, whose text shows", () => {
    expect(citedIn("Write `list[1]` [2].", PAGES)).toEqual({ text: "Write `list[1]`.", cited: [BLOG] });
    expect(citedIn("```js\nconst first = pages[1];\n```", PAGES)).toEqual({ text: "```js\nconst first = pages[1];\n```", cited: [] });
    const card = '```slack\n{"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"Warriors 112, Lakers 108 [3]"}}]}\n```';
    expect(citedIn(`The score [3].\n\n${card}`, PAGES)).toEqual({ text: `The score.\n\n${card.replace(" [3]", "")}`, cited: [NEWS] });
    expect(citedIn(card.replace("slack", "Slack json"), PAGES)).toEqual({ text: card.replace("slack", "Slack json").replace(" [3]", ""), cited: [NEWS] });
  });

  it("leaves a card's payload as it's written when taking out what reads as citations would leave JSON that doesn't parse, or it didn't parse", () => {
    const numbers = '```slack\n{"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"Top [2]"}}],"ranks": [1]}\n```';
    expect(citedIn(numbers, PAGES)).toEqual({ text: numbers, cited: [] });
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
