import { describe, expect, it } from "vitest";
import { OPENGRAPH_EMBED_CONTENT_TYPE, RenderError, webUrl } from "./attachments";
import { prepareBody, writtenBody, type PreparedBody } from "./body";
import { displayBody, displayMarkup, type DisplayNode, type DisplayPreview } from "./display";
import { editableBody, mentionSgid } from "./mentions";
import { parseHtml } from "./parse";
import { MAX_PREVIEW_COPIES_LENGTH, normalizeTweetUrl, previewContent } from "./previews";
import { htmlEscape } from "./ruby";
import { innerHtml, toHtml } from "./serialize";
import { corpus, corpusUser, RailsError } from "./testing/corpus";
import { testUserId, testUsers } from "./testing/users";
import { descendants, getAttr, isElement, removeAttr, type Element } from "./tree";
import { parseUri, uriToString } from "./uri";

const PREVIEW = `content-type="${OPENGRAPH_EMBED_CONTENT_TYPE}"`;
const { resolve } = testUsers("David");

/** A preview attachment as the composer writes one. */
const preview = (details: { href?: string; url?: string; filename?: string; description?: string }) =>
  `<action-text-attachment ${PREVIEW} content="${htmlEscape(previewContent(details))}"></action-text-attachment>`;

/** A preview attachment as Trix wrote one, its details in attributes. */
const trixPreview = (href: string, filename: string, url?: string) =>
  `<action-text-attachment ${PREVIEW} href="${href}" filename="${filename}"${url === undefined ? "" : ` url="${url}"`}></action-text-attachment>`;

function stored(body: string): PreparedBody {
  const prepared = prepareBody(parseHtml, body, resolve);
  if (prepared === null) throw new Error(`refused ${body}`);
  return prepared;
}

/** What a body shows once it's stored, read on `host`. */
const shown = (body: string, host = "") => {
  const { html, plainText } = stored(body);
  return displayBody(parseHtml, html, plainText, host);
};

const previewsIn = (nodes: DisplayNode[]): DisplayPreview[] =>
  nodes.flatMap((node) => (node.kind === "preview" ? [node] : node.kind === "element" ? previewsIn(node.children) : []));

/** What shows but previews, as markup. */
const textShown = (nodes: DisplayNode[]) => displayMarkup(nodes, () => "@");

describe("Link previews in messages", () => {
  describe("reads addresses as Ruby's URI does", () => {
    // Cases checked against uri 1.1.1 by differential fuzzing
    it("parses them into their parts", () => {
      const uri = parseUri("https://x.com/dhh/status/1?s=20")!;
      expect([uri.host, uri.query]).toEqual(["x.com", "s=20"]);
      expect(parseUri("http://exa mple.com/ ")).toBeUndefined();
      expect(parseUri("https:/rooms/1")!.host).toBeUndefined();
      expect(parseUri("https:rooms/1")!.opaque).toBe("rooms/1");
      expect(parseUri("https://")!.host).toBe("");
      expect(parseUri("http://[::1]/x")!.host).toBe("[::1]");
      expect(() => parseUri("mailto:foo")).toThrow("unrecognised opaque part for mailtoURL: foo");
      expect(parseUri("mailto:a@b.com")).toBeDefined();
      expect(uriToString(parseUri("https://x.com:443/a")!)).toBe("https://x.com/a");
      expect(parseUri("ftp://h")).toBeDefined();
      expect(parseUri("ldap://h/dc=x#f")).toBeUndefined();
      expect(parseUri("ünïcode.example")).toBeUndefined();
    });

    it("finds an empty host after a userinfo, where Ruby's regex does, and none after a bare //", () => {
      expect(parseUri("//a@")).toMatchObject({ userinfo: "a", host: "" });
      expect(parseUri("//@:1")).toMatchObject({ userinfo: undefined, host: "", port: 1n });
      expect(parseUri("//")!.host).toBeUndefined();
      expect(parseUri("//:80")!.host).toBeUndefined();
    });

    it("downcases the scheme", () => {
      expect(parseUri("HTTPS://x.com/a")!.scheme).toBe("https");
      expect(uriToString(parseUri("HTTP://X.com:80/a")!)).toBe("http://X.com/a");
      expect(uriToString(parseUri("FILE:///etc")!)).toBe("file:///etc");
      expect(uriToString(parseUri("MailTo:a@b.com")!)).toBe("mailto:a@b.com");
    });
  });

  // Campfire's test/lib/rails_ext/actiontext_opengraph_embeds_test.rb
  describe("keeps a preview's link and image only at web addresses elsewhere", () => {
    it("keeps absolute http and https links and images", () => {
      expect(webUrl("http://example.com/page", "")).toBe("http://example.com/page");
      expect(webUrl("https://example.com/image.png", "")).toBe("https://example.com/image.png");
    });

    it("drops a link and an image that aren't web addresses", () => {
      for (const value of [
        "javascript:alert(1)", "data:text/html,pwned", "vbscript:msgbox(1)", "//example.com/image.png", "/rooms/1", "rooms/1", "",
        "http://exa mple.com/ ", "https:/rooms/1", "https:rooms/1", "http:/rooms/1", "https://", "http://:80/rooms/1",
      ]) {
        expect(webUrl(value, ""), value).toBeUndefined();
      }
    });

    it("drops a link and an image on this Ember's own host, however it's spelled", () => {
      for (const value of [
        "https://once.campfire.test/rooms/1",
        "http://once.campfire.test/rooms/1",
        "https://ONCE.Campfire.Test/rooms/1",
        "https://once.campfire.test./rooms/1",
        "https://%6fnce.campfire.test/rooms/1",
        "https://%77ww.example.com/x.png",
      ]) {
        expect(webUrl(value, "once.campfire.test"), value).toBeUndefined();
      }
      expect(webUrl("https://example.com/page", "once.campfire.test")).toBe("https://example.com/page");
    });

    it("drops a link and an image on a bare address rather than a domain name", () => {
      for (const value of [
        "http://127.0.0.1/rooms/1", "http://2130706433/rooms/1", "http://0177.0.0.1/rooms/1", "http://0x7f.0.0.1/rooms/1", "http://1.2.3.0xff/rooms/1",
        "http://[::1]/rooms/1", "http://localhost/rooms/1", "https://203.0.113.10/image.png",
      ]) {
        expect(webUrl(value, ""), value).toBeUndefined();
      }
    });

    it("keeps an internationalized domain written in punycode", () => {
      expect(webUrl("https://xn--80aswg.xn--p1ai/page", "")).toBe("https://xn--80aswg.xn--p1ai/page");
    });

    it("raises where Ruby does: on a malformed mailto: address, and a host of only dots", () => {
      expect(() => webUrl("mailto:nobody", "")).toThrow(RenderError);
      expect(() => webUrl("https://.../x", "")).toThrow(RenderError);
    });

    it("reads a host of many dots in a moment", () => {
      const host = `a${".".repeat(300_000)}b`;
      const started = Date.now();
      expect(webUrl(`https://${host}/`, "")).toBe(`https://${host}/`);
      expect(webUrl(`https://${host}.../`, "")).toBe(`https://${host}.../`);
      // A pattern for the dots at the host's end would try to end each run of them inside it there: half a minute each for these.
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  describe("compares a message with its preview's link as Campfire does", () => {
    it("reads x.com as twitter.com, without the query, in addresses with x.com or twitter.com in them", () => {
      // RemoveSoloUnfurledLinkText#normalize_tweet_url
      for (const [url, normalized] of [
        ["HTTPS://x.com/dhh/status/1?s=20", "https://twitter.com/dhh/status/1"],
        ["https://x.com/dhh/status/1?s=20", "https://twitter.com/dhh/status/1"],
        ["HTTP://twitter.com/a", "http://twitter.com/a"],
        ["Https://X.com/dhh/status/1", "Https://X.com/dhh/status/1"],
        ["https://example.com/?u=x.com", "https://example.com/"],
        ["https://box.com/a?b", "https://box.com/a"],
        ["https://example.com/a?b", "https://example.com/a?b"],
        ["see https://x.com/a", "see https://x.com/a"],
      ]) {
        expect(normalizeTweetUrl(url!), url).toBe(normalized);
      }
    });

    it("drops a userinfo, as uri 1.1 does setting the host", () => {
      expect(normalizeTweetUrl("http://u:p@x.com:80/a?b#i")).toBe("http://twitter.com/a#i");
    });

    it("has nothing for what Ruby raises on", () => {
      expect(normalizeTweetUrl("mailto:x.com")).toBeUndefined();
      expect(normalizeTweetUrl("http:///x.com")).toBeUndefined();
    });
  });

  // Campfire's test/helpers/content_filters_test.rb
  describe("shows a message that's only a link as its preview", () => {
    const basecamp = { href: "https://basecamp.com/", filename: "Basecamp", description: "Calm" };

    it("takes out a Lexxy body's paragraphs, but those with attachments", () => {
      const body = `<p><a href="https://basecamp.com/">https://basecamp.com/</a></p>${preview(basecamp)}<p><br></p>`;
      const nodes = shown(body);
      expect(textShown(nodes)).toBe("");
      expect(previewsIn(nodes)).toHaveLength(1);
      expect(stored(body).plainText).toBe("https://basecamp.com/");
    });

    it("puts the preview in place of a Trix body's text, in each of its divs", () => {
      const nodes = shown(`<div>https://basecamp.com/${trixPreview("https://basecamp.com/", "Basecamp")}</div>`);
      expect(nodes).toEqual([{ kind: "element", name: "div", attrs: {}, children: [expect.objectContaining({ kind: "preview" })] }]);
    });

    it("puts it in the first div and as many more as MAX_PREVIEW_COPIES_LENGTH has room for, and nothing in the rest", () => {
      const previewsByDiv = (nodes: DisplayNode[]) => nodes.map((node) => previewsIn([node]).length);
      const beforeEmptyDivs = (details: Parameters<typeof preview>[0], divs: number) =>
        shown(`<div>https://basecamp.com/${preview(details)}</div>${"<div></div>".repeat(divs)}`);
      const copies = Math.floor(MAX_PREVIEW_COPIES_LENGTH / toHtml(parseHtml(stored(preview(basecamp)).html)).length);
      const nodes = beforeEmptyDivs(basecamp, copies + 1);
      expect(previewsByDiv(nodes)).toEqual([...Array<number>(copies).fill(1), 0, 0]);
      expect(textShown(nodes)).toBe("<div></div>".repeat(copies + 2));
      expect(previewsByDiv(beforeEmptyDivs(basecamp, 1))).toEqual([1, 1]);
      const long = { ...basecamp, url: `https://example.com/${"a".repeat(MAX_PREVIEW_COPIES_LENGTH)}` };
      expect(previewsByDiv(beforeEmptyDivs(long, 1))).toEqual([1, 0]);
    });

    it("keeps the link with other text, or more than one preview", () => {
      const withText = `<p>Hello <a href="https://basecamp.com/">https://basecamp.com/</a></p>${preview(basecamp)}`;
      expect(textShown(shown(withText))).toBe('<p>Hello <a href="https://basecamp.com/">https://basecamp.com/</a></p>');
      const twice = `<p><a href="https://basecamp.com/">https://basecamp.com/</a></p>${preview(basecamp)}${preview(basecamp)}`;
      expect(textShown(shown(twice))).toBe('<p><a href="https://basecamp.com/">https://basecamp.com/</a></p>');
      expect(previewsIn(shown(twice))).toHaveLength(2);
    });

    it("matches an x.com link with its preview on twitter.com", () => {
      const tweet = { href: "https://twitter.com/dhh/status/1752476663303323939", filename: "DHH (@dhh)", description: "Extension points" };
      for (const link of ["https://x.com/dhh/status/1752476663303323939", "https://x.com/dhh/status/1752476663303323939?s=20"]) {
        expect(textShown(shown(`<p>${link}</p>${preview(tweet)}`)), link).toBe("");
      }
    });

    it("keeps the link that differs from the preview's, as one with tracking parameters does", () => {
      const body = `<p>https://example.com/a?utm_source=x</p>${preview({ href: "https://example.com/a", filename: "A" })}`;
      expect(textShown(shown(body))).toBe('<p><a href="https://example.com/a?utm_source=x">https://example.com/a?utm_source=x</a></p>');
    });

    it("shows a message Rails can't compare as written, where Rails shows nothing", () => {
      const body = `<p>mailto:x.com</p>${preview({ href: "https://x.com/a", filename: "A" })}`;
      expect(textShown(shown(body))).toBe("<p>mailto:x.com</p>");
    });
  });

  describe("shows a preview as its partial does", () => {
    it("shows the title linking to the page, the description, and the image", () => {
      const [card] = previewsIn(
        shown(preview({ href: "https://example.com/page", url: "https://example.com/i.png", filename: "Title", description: "Words" })),
      );
      expect(card).toEqual({
        kind: "preview",
        title: [{ kind: "text", value: "Title" }],
        href: "https://example.com/page",
        description: [{ kind: "text", value: "Words" }],
        image: "https://example.com/i.png",
        avatar: false,
      });
    });

    it("draws an X avatar round", () => {
      const [card] = previewsIn(shown(preview({ href: "https://twitter.com/x/status/1", url: "https://pbs.twimg.com/profile_images/x.jpg", filename: "T" })));
      expect(card!.avatar).toBe(true);
    });

    it("shows the title as text when there's no link, and links the addresses in it and in the description", () => {
      const [card] = previewsIn(shown(preview({ filename: "See https://example.com", description: "Mail a@example.com" })));
      expect(card!.href).toBeUndefined();
      expect(card!.title).toEqual([
        { kind: "text", value: "See " },
        { kind: "element", name: "a", attrs: { href: "https://example.com" }, children: [{ kind: "text", value: "https://example.com" }] },
      ]);
      expect(card!.description[1]).toEqual({
        kind: "element",
        name: "a",
        attrs: { href: "mailto:a@example.com" },
        children: [{ kind: "text", value: "a@example.com" }],
      });
    });

    it("shows its text as text, never markup", () => {
      const [card] = previewsIn(shown(trixPreview("https://example.com/page", "&lt;b&gt;Title&lt;/b&gt;")));
      expect(card!.title).toEqual([{ kind: "text", value: "<b>Title</b>" }]);
    });

    it("leaves out a link and an image on the host it's shown on", () => {
      const body = preview({ href: "https://once.campfire.test/rooms/1", url: "https://ONCE.campfire.test./x.png", filename: "Self" });
      expect(previewsIn(shown(body, "once.campfire.test"))).toEqual([
        { kind: "preview", title: [{ kind: "text", value: "Self" }], href: undefined, description: [], image: undefined, avatar: false },
      ]);
      expect(previewsIn(shown(body))[0]!.href).toBe("https://once.campfire.test/rooms/1");
    });

    it("cuts titles past 280 characters and descriptions past 560", () => {
      const [card] = previewsIn(shown(preview({ href: "https://example.com/", filename: "😀".repeat(300), description: "a".repeat(600) })));
      expect(card!.title).toEqual([{ kind: "text", value: `${"😀".repeat(279)}…` }]);
      expect(card!.description).toEqual([{ kind: "text", value: `${"a".repeat(559)}…` }]);
    });
  });

  describe("stores a preview", () => {
    it("as the composer writes one, read as Rails reads it, in the same form when stored again", () => {
      const body = `<p>Look</p>${trixPreview("https://example.com/page", "  Title  ", "https://example.com/i.png")}`;
      const { html } = stored(body);
      const content = previewContent({ href: "https://example.com/page", url: "https://example.com/i.png", filename: "Title", description: "" });
      expect(html).toBe(`<p>Look</p><action-text-attachment ${PREVIEW} content="${htmlEscape(content).replaceAll("&#39;", "'")}"></action-text-attachment>`);
      expect(stored(html).html).toBe(html);
    });

    it("without an address it can't keep", () => {
      const { html } = stored(trixPreview("javascript:alert(1)", "Title", "/rooms/1/avatar"));
      expect(html).toBe(`<action-text-attachment ${PREVIEW} content="${htmlEscape(previewContent({ filename: "Title" }))}"></action-text-attachment>`);
    });

    it("with the link's text, which goes as the message shows", () => {
      const body = `<p><a href="https://basecamp.com/">https://basecamp.com/</a></p>${preview({ href: "https://basecamp.com/", filename: "B" })}`;
      expect(stored(body).html).toBe(body);
    });

    it("but not one that raises as Rails reads it", () => {
      expect(prepareBody(parseHtml, trixPreview("mailto:nobody", "Mail"), resolve)).toBeNull();
      expect(writtenBody(parseHtml, `<p>Hi</p>${trixPreview("mailto:nobody", "Mail")}`)).toEqual({ plainText: "", mentions: [] });
    });

    it("keeps it in the editor, with the content it shows", () => {
      const body = `<p>Hi <action-text-attachment content-type="application/vnd.campfire.mention" sgid="${mentionSgid(testUserId(1))}"></action-text-attachment></p>${preview({ href: "https://example.com/", filename: "E" })}`;
      const editable = editableBody(parseHtml, body, () => undefined, "ember.example");
      expect(editable).toBe(`<p>Hi </p>${preview({ href: "https://example.com/", filename: "E" })}`);
    });

    it("leaves its link and image out of the editor when they're on the page's own host, as the message does", () => {
      const { html } = stored(preview({ href: "https://Ember.example./rooms", url: "https://ember.example/qr_code/1", filename: "E", description: "D" }));
      expect(editableBody(parseHtml, html, () => undefined, "ember.example")).toBe(preview({ filename: "E", description: "D" }));
      expect(editableBody(parseHtml, html, () => undefined, "other.example")).toBe(html);
    });
  });

  describe("drops a preview from a reply's quote", () => {
    it("quotes what else the message shows", () => {
      const nodes = shown(`<p>Look</p>${preview({ href: "https://example.com/", filename: "E" })}`);
      expect(displayMarkup(nodes, () => "")).toBe("<p>Look</p>");
    });
  });

  it("shows every corpus body's previews as Rails rendered them", { timeout: 30_000 }, () => {
    const differences: string[] = [];
    for (const { name, body, host, presentation } of corpus.cases) {
      if (!body.includes("opengraph-embed") || !("ok" in presentation)) continue;
      let prepared;
      try {
        prepared = prepareBody(parseHtml, body, corpusUser);
      } catch (error) {
        if (error instanceof RailsError) continue;
        throw error;
      }
      if (!prepared) continue;
      const ours = previewsIn(displayBody(parseHtml, prepared.html, prepared.plainText, host)).map(asRendered);
      const rails = renderedCards(presentation.ok);
      if (JSON.stringify(ours) !== JSON.stringify(rails)) {
        differences.push(`${name}\n  ours:  ${JSON.stringify(ours)}\n  rails: ${JSON.stringify(rails)}`);
      }
    }
    expect(differences).toEqual([]);
  });
});

/** The class the preview partial gives a card, which a message's own markup is unlikely to. */
const CARD_CLASS = /^og-embed gap (?:og-embed--twitter-avatar)?$/;

/** A card's parts in Rails' presentation of a message: its title and description markup, its image, and whether it's an avatar's. */
function renderedCards(presentation: string) {
  const elements = descendants(parseHtml(presentation)).filter((node): node is Element => isElement(node));
  const ofClass = (root: Element, name: string) =>
    descendants(root).find((node): node is Element => isElement(node) && (getAttr(node, "class") ?? "").split(" ").includes(name));
  return elements
    .filter((element) => element.name === "div" && CARD_CLASS.test(getAttr(element, "class") ?? ""))
    .map((card) => {
      const image = ofClass(card, "og-embed__image");
      return {
        title: normalized(ofClass(card, "og-embed__title")!),
        description: normalized(ofClass(card, "og-embed__description")!),
        image: image && getAttr(descendants(image).find((node): node is Element => isElement(node, "img"))!, "src"),
        avatar: (getAttr(card, "class") ?? "").includes("og-embed--twitter-avatar"),
      };
    });
}

/** A displayed preview's parts, as its partial renders them. */
function asRendered(card: DisplayPreview) {
  const title = displayMarkup(card.title, () => "");
  return {
    title: card.href === undefined ? title.trim() : `<a href="${htmlEscape(card.href)}">${title}</a>`,
    description: displayMarkup(card.description, () => "").trim(),
    image: card.image,
    avatar: card.avatar,
  };
}

/** An element's markup, without the target auto_link gives links, trimmed. */
function normalized(element: Element): string {
  for (const node of descendants(element)) if (isElement(node)) removeAttr(node, "target");
  return innerHtml(element).trim();
}
