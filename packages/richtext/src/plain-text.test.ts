import { describe, expect, it } from "vitest";
import { plainText } from "./body";
import { parseHtml } from "./parse";
import { MAX_LIST_INDENTATION } from "./plain-text";
import { testUserId, testUsers } from "./testing/users";

const { resolve } = testUsers("David");
const read = (html: string) => plainText(parseHtml, html, resolve);

describe("Plain-text version of a message", () => {
  it("reads text as it is", () => {
    expect(read("<span>My hovercraft is full of eels</span>")).toBe("My hovercraft is full of eels");
    expect(read("First post!")).toBe("First post!");
  });

  it("ends blocks with blank lines and breaks with newlines, trimming the last", () => {
    expect(read("<h1>Title</h1><p>a</p><p>b<br>c</p>")).toBe("Title\n\na\n\nb\nc");
    expect(read("<h2>Medium</h2><h3>Small</h3><h6>Smallest</h6>")).toBe("Medium\n\nSmall\n\nSmallest");
    expect(read("<div>a</div><div>b</div>")).toBe("a\nb");
    expect(read("<pre>no</pre><pre>break</pre><table><tr><td>x</td><td>y</td></tr></table>")).toBe("nobreakxy");
  });

  it("quotes quotes and bullets lists, nested ones indented", () => {
    expect(read("<blockquote>q</blockquote>")).toBe("“q”");
    expect(read("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>")).toBe("• a\n  • b\n• c");
    expect(read("<ol><li>one</li>\n<li>two</li></ol>")).toBe("1. one\n2. two");
  });

  it("reads mentions, images and captions, and drops scripts", () => {
    const mention = `<action-text-attachment content-type="application/vnd.campfire.mention" sgid="${testUserId(1)}"></action-text-attachment>`;
    expect(read(`<p>Hi ${mention}!</p>`)).toBe("Hi @David!");
    expect(read('<action-text-attachment content-type="image/png" url="https://example.com/a.png"></action-text-attachment>')).toBe("[Image]");
    expect(read('<action-text-attachment content-type="image/png" url="/a.png" caption="Cat"></action-text-attachment>')).toBe("[Cat]");
    expect(read("<figure>a<figcaption>Cap</figcaption></figure><script>x()</script><style>p{}</style>")).toBe("a[Cap]");
  });

  it("numbers a long list in linear time", () => {
    const started = performance.now();
    const text = read(`<ol>${"<li>x</li>".repeat(25_000)}</ol>`);
    expect(text.endsWith("25000. x")).toBe(true);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  // Where Ember diverges from Rails, to bound the text a body reads as
  it(`indents nested items with ${MAX_LIST_INDENTATION} spaces in all, and those after them not at all`, () => {
    const lists = 101;
    const indentation = " ".repeat(2 * (lists - 1));
    const indented = MAX_LIST_INDENTATION / indentation.length;
    const text = read("<ul>".repeat(lists) + "<li>x</li>".repeat(indented + 2));
    expect(text.split("\n").slice(lists - 1)).toEqual([...Array<string>(indented).fill(`${indentation}• x`), "• x", "• x"]);
    expect(text.length).toBeGreaterThan(MAX_LIST_INDENTATION);
  });

  it("reads 100 KB of items in lists as deep as a body goes without megabytes of indentation", () => {
    const lists = 398;
    const text = read("<ol>".repeat(lists) + "<li>".repeat(24_600));
    expect(text.endsWith("\n24600. ")).toBe(true);
    expect(text.match(/^ +/gm)!.join("").length).toBeLessThan(MAX_LIST_INDENTATION + 2 * lists);
  });
});
