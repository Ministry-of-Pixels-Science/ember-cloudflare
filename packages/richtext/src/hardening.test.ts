import { describe, expect, it } from "vitest";
import { OPENGRAPH_EMBED_CONTENT_TYPE } from "./attachments";
import { autoLink } from "./autolink";
import { plainText, prepareBody } from "./body";
import { displayBody } from "./display";
import * as worker from "./index";
import { MAX_ATTRIBUTES, ParseLimitError } from "./markup";
import { mentionSgid, userIdsIn } from "./mentions";
import { parseHtml } from "./parse";
import { canonicalize, presentMessage } from "./render";
import { htmlEscape } from "./ruby";
import { cgiUnescapeHtml } from "./sanitize";
import { testUserId, testUsers } from "./testing/users";
import { descendants, getAttr, isElement } from "./tree";

// Where Ember deliberately diverges from Rails to close a hole or bound the work a message body can
// cause. Bodies come from clients, and the Durable Object that prepares them has little CPU time to
// spare.

const { resolve } = testUsers("David");
const none = () => undefined;
const mentionPartial = (user: { name: string }) => `<span class="mention">${user.name}</span>\n`;
const presentation = (body: string) => presentMessage(parseHtml, body, resolve, mentionPartial);
const mention = (n: number) =>
  `<action-text-attachment content-type="application/vnd.campfire.mention" sgid="${mentionSgid(testUserId(n))}"></action-text-attachment>`;
const galleryAttachment =
  '<action-text-attachment presentation="gallery" content-type="text/html" content="&lt;p&gt;x&lt;/p&gt;"></action-text-attachment>';
const preview = (content: string) =>
  `<action-text-attachment content-type="${OPENGRAPH_EMBED_CONTENT_TYPE}" content="${htmlEscape(content)}"></action-text-attachment>`;

/**
 * A generous bound: each of these bodies of hundreds of KB takes a second at most, where the slow paths
 * they found took several.
 */
const QUICK_MS = 5_000;
const SLOW_TEST_MS = 30_000;

function expectQuick(what: string, work: () => void): void {
  const started = performance.now();
  work();
  expect(performance.now() - started, what).toBeLessThan(QUICK_MS);
}

/** Every element and attribute name in rendered `html` as a browser would parse it. */
function parsedMarkup(html: string): string[] {
  const names: string[] = [];
  for (const node of descendants(parseHtml(html))) {
    if (!isElement(node) || getAttr(node, "class") === "lexxy-content") continue;
    names.push(node.name, ...node.attrs.map((attr) => `${node.name}[${attr.name}]`));
  }
  return names;
}

/** Content attachments nested `levels` deep, each saying which level it is. */
function nestedContentAttachments(levels: number, padding: string): string {
  let body = "";
  for (let level = levels; level >= 1; level--) {
    const content = `<p>level ${level}${padding}</p>${body}`.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    body = `<action-text-attachment content-type="text/html" content="${content}"></action-text-attachment>`;
  }
  return body;
}

/** Galleries nested `levels` deep, each in the content of an attachment of the one above, which says which level it is. */
function nestedGalleries(levels: number, padding: string): string {
  let body = "";
  for (let level = levels; level >= 1; level--) {
    const content = `<p>level ${level}${padding}</p>${body}`.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    body = `<div><action-text-attachment presentation="gallery" content-type="text/html" content="${content}"></action-text-attachment>${galleryAttachment}</div>`;
  }
  return body;
}

/** A `<b>` left open, whose title serializes to 1,000 units unless it's given, reopened in each of `copies` paragraphs. */
const reopenedTitle = (copies: number, title = "x".repeat(991)) => `<p><b title="${title}">a${"<p>b".repeat(copies)}`;

const contentAttachment = (content: string) =>
  `<action-text-attachment content-type="text/html" content="${content.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></action-text-attachment>`;

/** The page and the stored form both have to refuse `body`, and quickly. */
function expectRefusedQuickly(what: string, body: string): void {
  expectQuick(what, () => {
    expect(() => presentation(body), what).toThrow(ParseLimitError);
    expect(() => plainText(parseHtml, body, none), what).toThrow(ParseLimitError);
    expect(prepareBody(parseHtml, body, none), what).toBeNull();
  });
}

describe("Rich text, safely", () => {
  it("drops name attributes, which could clobber the page's globals", () => {
    const html = presentation('<p><a name="body" href="/x">x</a><span name="cookie">y</span></p>');
    expect(parsedMarkup(html)).toEqual(["p", "a", "a[href]", "span"]);
  });

  it("renders content attachments eight levels deep", () => {
    const html = presentation(nestedContentAttachments(12, ""));
    for (let level = 1; level <= 12; level++) expect(html.includes(`level ${level}<`), `level ${level}`).toBe(level <= 8);
  });

  it(
    "renders deeply nested content attachments quickly",
    () => {
      const body = nestedContentAttachments(200, "x".repeat(1000));
      expect(body.length).toBeGreaterThan(200_000);
      expectQuick("200 nested content attachments", () => presentation(body));
      expectQuick("the users of 200 nested content attachments", () => userIdsIn(parseHtml, body));
    },
    SLOW_TEST_MS,
  );

  it("renders nested galleries eight levels deep, and each one's attachments once", () => {
    // Rails renders the inner gallery's attachments again as the outer one's, which has four, and shows level 2 twice
    const html = presentation(nestedGalleries(2, ""));
    expect(html.match(/attachment-gallery--\d+|level \d+/g)).toEqual(["attachment-gallery--2", "level 1", "attachment-gallery--2", "level 2"]);
    const deep = presentation(nestedGalleries(12, ""));
    for (let level = 1; level <= 12; level++) expect(deep.split(`level ${level}<`).length - 1, `level ${level}`).toBe(level <= 8 ? 1 : 0);
  });

  it(
    "refuses deeply nested elements quickly",
    () => {
      expectRefusedQuickly("400 KB of nested <div>s", "<div>".repeat(80_000));
      expectRefusedQuickly("480 KB of <a><b>", "<a><b>".repeat(80_000));
      expectRefusedQuickly("390 KB of <a><div><div>", "<a><div><div>".repeat(30_000));
    },
    SLOW_TEST_MS,
  );

  it(
    "doesn't read the rest of a body once it's too deep",
    () => {
      const tooDeep = "<div>".repeat(401);
      const rest = "x".repeat(16 * 1024 * 1024);
      for (const [what, body] of [
        ["tags", tooDeep + "<a><b>".repeat(rest.length / 6)],
        ["a comment", `${tooDeep}<!--${rest}`],
        ["a tag name", `${tooDeep}<${rest}`],
      ] as const) {
        const started = performance.now();
        expect(() => plainText(parseHtml, body, none)).toThrow(ParseLimitError);
        expect(prepareBody(parseHtml, body, none)).toBeNull();
        expect(performance.now() - started, `refusing 16 MB of ${what}`).toBeLessThan(1_000);
      }
    },
    SLOW_TEST_MS,
  );

  it(
    "refuses a tag with too many attributes quickly",
    () => {
      const attributes = Array.from({ length: 64_000 }, (_, i) => `a${i + 1}=1`).join(" ");
      expectRefusedQuickly("a tag with 64,000 attributes", `<b ${attributes}>x</b>`);
    },
    SLOW_TEST_MS,
  );

  it(
    "parses <html> tags in the body in linear time",
    () => {
      const attributes = (t: number) => Array.from({ length: MAX_ATTRIBUTES }, (_, i) => `a${t * MAX_ATTRIBUTES + i + 1}`);
      const tag = (t: number) => `<html ${attributes(t).join(" ")}>`;
      const body = Array.from({ length: 200 }, (_, t) => tag(t)).join("");
      expect(body.length).toBeGreaterThan(500_000);
      expectQuick("550 KB of <html> tags, each with 400 new attributes", () => {
        expect(plainText(parseHtml, body, none)).toBe("");
        expect(presentation(body)).toBe(presentation(""));
      });
    },
    SLOW_TEST_MS,
  );

  it(
    "parses elements misplaced in a table in linear time",
    () => {
      expectQuick("800 KB of <br>s in a table", () => plainText(parseHtml, `<table>${"<br>".repeat(200_000)}`, none));
    },
    SLOW_TEST_MS,
  );

  it("refuses a body that reopens more formatting elements than a message would", () => {
    // Parsed in full, as Rails parses them, these 19 KB hold over 600,000 elements
    const unclosed = Array.from({ length: 390 }, (_, i) => `<b class="b${i}">`).join("");
    expectRefusedQuickly("390 formatting elements reopened in each of 1,600 paragraphs", `<p>${unclosed}</p>${"<p>x</p>".repeat(1_600)}`);
    const boldTitle = `<p><b>Title</p>${"<p>line</p>".repeat(500)}`;
    expect(prepareBody(parseHtml, boldTitle, none)?.html).toBe(`<p><b>Title</b></p>${"<p><b>line</b></p>".repeat(500)}`);
  });

  it(
    "refuses a body that copies more attributes than a message holds",
    () => {
      // Parsed in full, as Rails parses them, the first two bodies' 99 KB hold 95 MB and 28 MB of titles
      const long = "A".repeat(95_000);
      const unclosed = Array.from({ length: 300 }, (_, i) => `<b id=${i}>`).join("");
      expectRefusedQuickly("a 95 KB title reopened in each of 1,000 paragraphs", reopenedTitle(1_000, long));
      expectRefusedQuickly("a 95 KB title the adoption agency copies for each of 300 end tags", `${unclosed}<i title="${long}"><div>${"</b>".repeat(300)}`);
      expectRefusedQuickly("a 1.9 KB title reopened in each of 1,000 paragraphs", reopenedTitle(1_000, "A".repeat(1_900)));
      expectRefusedQuickly("66 attachments that each copy as much as a message may", contentAttachment(reopenedTitle(100)).repeat(66));
    },
    SLOW_TEST_MS,
  );

  it("keeps a body that copies as much as a message holds, though storing it reads it more than once", () => {
    const paragraph = (text: string) => `<p><b title="${"x".repeat(991)}">${text}</b></p>`;
    const kept = { html: paragraph("a") + paragraph("b").repeat(100), plainText: `a${"\n\nb".repeat(100)}` };
    const stored = (body: string) => worker.prepareBody(body, none);
    expect(stored(reopenedTitle(100))?.html === kept.html).toBe(true);
    expect(stored(reopenedTitle(101))).toBeNull();
    expect(worker.plainText(reopenedTitle(100), none)).toBe(kept.plainText);
    expect(() => worker.plainText(reopenedTitle(101), none)).toThrow(ParseLimitError);
    expect(worker.writtenBody(reopenedTitle(100)).plainText).toBe(kept.plainText);
    expect(() => worker.writtenBody(reopenedTitle(101))).toThrow(ParseLimitError);
    // What attachments copy counts with the rest, as deep as they render
    expect(stored(contentAttachment(reopenedTitle(100)))?.html === kept.html).toBe(true);
    expect(stored(contentAttachment(reopenedTitle(101)))).toBeNull();
    expect(stored(contentAttachment(reopenedTitle(50)) + reopenedTitle(50))).not.toBeNull();
    expect(stored(contentAttachment(reopenedTitle(50)) + reopenedTitle(51))).toBeNull();
    expect(stored(contentAttachment(contentAttachment(reopenedTitle(50)).repeat(2)))).not.toBeNull();
    expect(stored(contentAttachment(contentAttachment(reopenedTitle(50)) + contentAttachment(reopenedTitle(51))))).toBeNull();
    // A link a pasted page left open over 700 paragraphs
    const link = `<a href="https://example.com/${"x".repeat(64)}">`;
    expect(stored(`<p>${link}x${"<p>y".repeat(700)}`)?.plainText).toBe(`x${"\n\ny".repeat(700)}`);
    // An element closed inside a block is copied once, however many blocks it's closed in after
    const long = "A".repeat(95_000);
    expect(stored(`<b title="${long}">${"<div></b>".repeat(390)}x`)?.html.split(long)).toHaveLength(3);
  });

  const hostileBodies = {
    "700 KB of <font>s": `<p>${"<font>x</font>".repeat(50_000)}</p>`,
    "a <font> of 200,000 <br>s": `<p><font>${"<br>".repeat(200_000)}</font></p>`,
    "500 KB of <img>s": `<p>${"<img>".repeat(100_000)}</p>`,
    "a list of 50,000 items": `<ol>${"<li>x</li>".repeat(50_000)}</ol>`,
    "10,000 mentions": `<p>${mention(1).repeat(10_000)}</p>`,
    "2,000 galleries": `<div>${galleryAttachment.repeat(2)}</div>`.repeat(2_000),
    "60 nested galleries": nestedGalleries(60, "x".repeat(1000)),
    "300 KB of misnested links": `<b>${"<a>x</a><p>y".repeat(25_000)}`,
    "a misnested <b> around 200,000 <br>s": `<b><div>${"<br>".repeat(200_000)}</b>`,
    "500 KB of escaped ampersands": `<p><a href="${"&amp;#38;".repeat(50_000)}">x</a></p>`,
    "a preview of 10,000 images in a div of 25,000 classes": preview(`<div class="${"a ".repeat(25_000)}">${"<img>".repeat(10_000)}</div>`),
  };
  for (const [what, body] of Object.entries(hostileBodies)) {
    it(
      `prepares ${what} in linear time`,
      () =>
        expectQuick(what, () => {
          userIdsIn(parseHtml, body);
          expect(prepareBody(parseHtml, body, resolve)).not.toBeNull();
        }),
      SLOW_TEST_MS,
    );
  }

  it(
    "shows a link's long preview in the first few of a body's many divs, not in each",
    () => {
      // A copy in each div, as Campfire shows a message that's only a link, would come to 50 MB
      const content = `<div class='og-embed__title'><a href='https://example.com/a'>t</a></div><div class='og-embed__image'><img src='https://example.com/${"a".repeat(49_000)}'></div>`;
      const preview = `<action-text-attachment content-type="${OPENGRAPH_EMBED_CONTENT_TYPE}" content="${content}"></action-text-attachment>`;
      const stored = prepareBody(parseHtml, `<div>https://example.com/a</div>${"<div></div>".repeat(1_000)}${preview}`, none)!;
      let shown = "";
      expectQuick("1,000 divs and a link's preview of 49 KB", () => (shown = JSON.stringify(displayBody(parseHtml, stored.html, stored.plainText, ""))));
      // The preview itself, after the two copies there's room for
      expect(shown.split('"kind":"preview"').length - 1).toBe(3);
    },
    SLOW_TEST_MS,
  );

  it("unescapes a value of many entities in linear time", () => {
    expectQuick("1 MB of &s", () => cgiUnescapeHtml("&".repeat(1_000_000)));
    expectQuick("1 MB of unfinished references", () => cgiUnescapeHtml("&#1".repeat(250_000)));
  });

  it("shows a mention of a deleted user as ☒ and keeps the rest of the message", () => {
    const body = `<p>Hi ${mention(6)}, welcome</p>`;
    const html = presentation(body);
    expect(html.includes("Hi") && html.includes("☒") && html.includes("welcome"), html).toBe(true);
    expect(canonicalize(parseHtml, body, resolve)).toBe("<p>Hi ☒, welcome</p>");
  });
});

describe("Links in message text", () => {
  const shown = (body: string) => autoLink(parseHtml, presentation(body));

  it("can't break out of an attribute through an address after a greater-than sign", () => {
    // Rails serialized the title unescaped (`title="x> http://..."`), so auto_link's "inside a
    // tag" check missed, the <a href="..."> it inserted closed the attribute, and the <img> after
    // it became markup.
    const html = shown('<p title="x> http://evil.test/ <img src=x onerror=alert(1)>">hi</p>');
    expect(parsedMarkup(html), html).toEqual(["p", "p[title]"]);
  });

  it("can't break out of an attribute through an email address after a greater-than sign", () => {
    const html = shown('<p><abbr title="x> me@evil.test <img src=x onerror=alert(1)>">hi</abbr></p>');
    expect(parsedMarkup(html), html).toEqual(["p", "abbr", "abbr[title]"]);
  });

  it("still links addresses in the text", () => {
    expect(shown("<p>see http://example.com/a?b=1&amp;c=2 and me@example.com</p>")).toContain(
      '<p>see <a target="_blank" href="http://example.com/a?b=1&amp;c=2">http://example.com/a?b=1&amp;c=2</a> and <a target="_blank" href="mailto:me@example.com">me@example.com</a></p>',
    );
  });

  it(
    "links many bare domains in linear time",
    () => {
      const domains = (64 * 1024) / 16;
      let html = "";
      expectQuick("linking 64 KB of bare domains", () => (html = shown("<p>www.a.com</p>".repeat(domains))));
      expect(html.split('<a target="_blank" href="http://www.a.com">').length - 1).toBe(domains);
    },
    SLOW_TEST_MS,
  );
});
