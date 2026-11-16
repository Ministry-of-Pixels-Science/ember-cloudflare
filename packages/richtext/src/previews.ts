// Link previews: the attachment Campfire's composer adds below a link it unfurls
// (app/javascript/controllers/unfurl_controller.js), and how a message that is only that link shows just
// its preview (app/helpers/content_filters/remove_solo_unfurled_link_text.rb).

import { isTwitterAvatar, OPENGRAPH_EMBED_CONTENT_TYPE, opengraphEmbedFromNode, type OpengraphEmbed } from "./attachments";
import { attachmentNodes } from "./content";
import { setInnerHtml, type HtmlParser } from "./markup";
import { htmlEscape, isBlank, strip, truncate } from "./ruby";
import { toHtml } from "./serialize";
import { descendants, detach, getAttr, isElement, removeChildren, type Element, type Fragment } from "./tree";
import { InvalidComponentError, isHttp, parseUri, uriToString } from "./uri";

/**
 * A preview's markup as the composer writes it, which is the content of its attachment: its title,
 * linked when it has an address, its description, and its image. Ember stores a preview in this
 * form too, its title and description shortened as they show and stripped as they're read, so
 * that storing it again gives the same.
 */
export function previewContent({ href, url, filename, description }: OpengraphEmbed): string {
  const twitter = isTwitterAvatar(url) ? " og-embed--twitter-avatar" : "";
  const name = filename === undefined ? undefined : htmlEscape(strip(truncate(filename, 280)));
  const linked = href === undefined ? name : `<a href="${htmlEscape(href)}" rel="noreferrer" target="_blank">${name ?? htmlEscape(href)}</a>`;
  const title = linked === undefined ? "" : `<div class="og-embed__title">${linked}</div>`;
  const image = url === undefined ? "" : `<div class="og-embed__image"><img src="${htmlEscape(url)}" class="image center" alt=""></div>`;
  return (
    `<actiontext-opengraph-embed><div class="og-embed gap${twitter}"><div class="og-embed__content">${title}` +
    `<div class="og-embed__description">${htmlEscape(strip(truncate(description ?? "", 560)))}</div></div>${image}</div></actiontext-opengraph-embed>`
  );
}

/** The attachments a composer writes for previews, by their exact content type, unlike those Action Text reads as one. */
export function unfurledLinks(root: Fragment | Element): Element[] {
  return attachmentNodes(root).filter((node) => getAttr(node, "content-type") === OPENGRAPH_EMBED_CONTENT_TYPE);
}

/**
 * Ember's own limit on the markup the copies of a preview come to, in characters, which Campfire
 * doesn't have. Every div of a body that's only a link gets a copy, so 100 KB of empty divs and a
 * long preview could otherwise show as hundreds of megabytes. A message that's only a link has a
 * div or two.
 */
export const MAX_PREVIEW_COPIES_LENGTH = 100_000;

/**
 * RemoveSoloUnfurledLinkText, on a loaded body whose plain text is `plainText`: when the body is
 * only the link its one preview is of, the link goes. A body with divs, as Trix wrote them, gets the
 * preview as the only content of its first div, and of as many after it as
 * `MAX_PREVIEW_COPIES_LENGTH` has room for, and the rest of its divs end up empty; Lexxy's loses
 * every paragraph without an attachment. Rails raises comparing a plain text that parses as a
 * malformed address with x.com in it, such as "mailto:x.com", and shows nothing of the message;
 * Ember shows it as written.
 */
export function removeSoloUnfurledLinkText(parse: HtmlParser, content: Fragment, plainText: string, host: string): void {
  const links = unfurledLinks(content);
  const solo = links.length === 1 ? opengraphEmbedFromNode(parse, links[0]!, host).href : undefined;
  const normalized = solo === undefined ? undefined : normalizeTweetUrl(solo);
  if (normalized === undefined || normalized !== normalizeTweetUrl(plainText)) return;
  const nodes = descendants(content);
  const divs = nodes.filter((node): node is Element => isElement(node, "div"));
  if (divs.length > 0) {
    const preview = toHtml(links[0]!);
    const copies = Math.max(1, Math.floor(MAX_PREVIEW_COPIES_LENGTH / preview.length));
    divs.forEach((div, index) => {
      if (index < copies) setInnerHtml(parse, div, preview);
      else removeChildren(div);
    });
  } else {
    for (const node of nodes) if (isElement(node, "p") && attachmentNodes(node).length === 0) detach(node);
  }
}

const TWITTER_DOMAINS = ["x.com", "twitter.com"];

/**
 * `normalize_tweet_url`: text with x.com or twitter.com in it that parses as an address, as Ruby's URI
 * writes it back on twitter.com for x.com and without its query, so that a tweet's addresses compare
 * equal; any other text as it is. Setting the host drops the userinfo, as it does in uri 1.1, which
 * Campfire runs. Nothing where Ruby raises: for a malformed mailto: address, and for an http one without
 * a host, which Ruby won't set a host on.
 */
export function normalizeTweetUrl(url: string): string | undefined {
  if (isBlank(url) || !TWITTER_DOMAINS.some((domain) => url.includes(domain))) return url;
  let uri;
  try {
    uri = parseUri(url);
  } catch (error) {
    if (error instanceof InvalidComponentError) return undefined;
    throw error;
  }
  if (uri === undefined) return url;
  if (isHttp(uri) && uri.host === "") return undefined;
  return uriToString({ ...uri, userinfo: undefined, host: uri.host?.toLowerCase() === "x.com" ? "twitter.com" : uri.host, query: undefined });
}
