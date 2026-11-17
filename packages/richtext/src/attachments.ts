// Resolving `<action-text-attachment>` elements to what they attach, as Action Text, Lexxy and
// Campfire's extensions do.

import { BODY, type HtmlParser } from "./markup";
import { htmlEscape, isBlank, presence, strip, truncate } from "./ruby";
import { descendants, getAttr, isElement, textContent, type Element, type Parent } from "./tree";
import { InvalidComponentError, isHttp, parseUri } from "./uri";

export const ATTACHMENT_TAG = "action-text-attachment";
export const MENTION_CONTENT_TYPE = "application/vnd.campfire.mention";
export const OPENGRAPH_EMBED_CONTENT_TYPE = "application/vnd.actiontext.opengraph-embed";

/** Who a mention names, as far as plain text needs to know. */
export interface MentionUser {
  id: string;
  name: string;
}

/** Finds the user a mention's `sgid` names, or nothing when it names no one. */
export type ResolveMention = (sgid: string) => MentionUser | undefined;

/** A link preview's details, as `ActionText::Attachment::OpengraphEmbed` reads them. */
export interface OpengraphEmbed {
  /** Where its title links. */
  href?: string;
  /** Its image's address. */
  url?: string;
  /** Its title. */
  filename?: string;
  description?: string;
}

export type Attachable =
  | { kind: "mention"; user: MentionUser }
  | { kind: "opengraph-embed"; embed: OpengraphEmbed }
  /** `ActionText::Attachables::ContentAttachment` */
  | { kind: "content"; content: string }
  /** `ActionText::Attachables::RemoteImage` */
  | { kind: "remote-image"; url: string; width?: string; height?: string }
  /** Lexxy's `ActionText::Attachables::RemoteVideo` */
  | { kind: "remote-video"; url: string; contentType: string; width?: string; height?: string; filename?: string }
  /** `ActionText::Attachables::MissingAttachable` */
  | { kind: "missing" };

export interface Attachment {
  attachable: Attachable;
  caption?: string;
}

const OPENGRAPH_CONTENT_TYPE = /application\/vnd.actiontext.opengraph-embed/;
const IMAGE_CONTENT_TYPE = /^image(\/.+|$)/m;
const VIDEO_CONTENT_TYPE = /^video(\/.+|$)/m;

/**
 * Campfire's `ActionText::Attachment.from_node` (lib/rails_ext/action_text_attachables.rb): a link
 * preview, else a mentioned user, else Action Text's own attachables as Lexxy extends them. `host` is
 * the one the page is served from, which a preview's addresses mustn't name; plain text doesn't depend
 * on it. Throws `RenderError` where Ruby raises reading a preview's address.
 */
export function attachmentFromNode(parse: HtmlParser, element: Element, resolve: ResolveMention, host = ""): Attachment {
  return { attachable: attachableFromNode(parse, element, resolve, host), caption: presence(getAttr(element, "caption")) };
}

function attachableFromNode(parse: HtmlParser, element: Element, resolve: ResolveMention, host: string): Attachable {
  const contentType = getAttr(element, "content-type");
  if (contentType !== undefined && OPENGRAPH_CONTENT_TYPE.test(contentType)) return { kind: "opengraph-embed", embed: opengraphEmbedFromNode(parse, element, host) };
  const sgid = getAttr(element, "sgid");
  const user = sgid === undefined ? undefined : resolve(sgid);
  if (user) return { kind: "mention", user };
  const content = getAttr(element, "content");
  if (content !== undefined && contentType?.includes("html") && !isBlank(content)) return { kind: "content", content };
  const url = getAttr(element, "url");
  if (url !== undefined) {
    const sizes = { width: getAttr(element, "width"), height: getAttr(element, "height") };
    if (IMAGE_CONTENT_TYPE.test(contentType ?? "")) return { kind: "remote-image", url, ...sizes };
    if (VIDEO_CONTENT_TYPE.test(contentType ?? "")) {
      return { kind: "remote-video", url, contentType: contentType ?? "", ...sizes, filename: getAttr(element, "filename") };
    }
  }
  return { kind: "missing" };
}

// --- Link previews ------------------------------------------------------------------------------

/**
 * `OpengraphEmbed.from_node`'s details: from the attributes Trix wrote them in, when they name a
 * file, or else from the markup Lexxy writes as the attachment's content.
 */
export function opengraphEmbedFromNode(parse: HtmlParser, element: Element, host: string): OpengraphEmbed {
  const filename = getAttr(element, "filename");
  if (presence(filename) === undefined) return opengraphEmbedFromContent(parse, getAttr(element, "content") ?? "", host);
  return { href: webUrl(getAttr(element, "href"), host), url: webUrl(getAttr(element, "url"), host), filename, description: getAttr(element, "caption") };
}

/**
 * `attributes_from_content`: the first `.og-embed__title`, its first link, the first image in an
 * `.og-embed__image` and the first `.og-embed__description`, as Nokogiri finds them in the content.
 */
function opengraphEmbedFromContent(parse: HtmlParser, content: string, host: string): OpengraphEmbed {
  const elements = descendants(parse(content, BODY)).filter((node): node is Element => isElement(node));
  const title = elements.find((element) => hasClass(element, "og-embed__title"));
  const link = title && descendants(title).find((node): node is Element => isElement(node, "a"));
  const image = firstImageWithin(elements, "og-embed__image");
  const description = elements.find((element) => hasClass(element, "og-embed__description"));
  const named = link ?? title;
  return {
    href: webUrl(link && getAttr(link, "href"), host),
    url: webUrl(image && getAttr(image, "src"), host),
    filename: named && strip(textContent(named)),
    description: description && strip(textContent(description)),
  };
}

/**
 * CSS's `.name img`, as Nokogiri finds its first: the first image, of `elements` in document order,
 * inside an element of the class. Each element's class is read once: reading the classes of every
 * image's ancestors took time quadratic in the content's size.
 */
function firstImageWithin(elements: Element[], name: string): Element | undefined {
  const within = new Set<Parent>();
  for (const element of elements) {
    const inside = element.parent !== null && within.has(element.parent);
    if (inside && element.name === "img") return element;
    if (inside || hasClass(element, name)) within.add(element);
  }
  return undefined;
}

/** Whether CSS's `.name` picks the element, as Nokogiri tests it: `name` is one of its class's words. */
const hasClass = (element: Element, name: string) => (getAttr(element, "class") ?? "").split(/[ \t\n\r]+/).includes(name);

/**
 * `web_url`: the address, when it's an absolute http or https URL on a named host other than
 * `host`, so that a preview can't aim its link or its image at this Ember, where every reader's
 * browser would fetch it signed in.
 */
export function webUrl(value: string | undefined, host: string): string | undefined {
  if (value === undefined || isBlank(value)) return undefined;
  let uri;
  try {
    uri = parseUri(value);
  } catch (error) {
    if (error instanceof InvalidComponentError) throw new RenderError(`URI::InvalidComponentError: ${error.message}`);
    throw error;
  }
  return uri && isHttp(uri) && uri.host !== undefined && namedHost(uri.host) && canonicalHost(uri.host) !== canonicalHost(host) ? value : undefined;
}

/**
 * `value` when a bot's card may link to it or show it, as `webUrl` decides for a preview, or undefined,
 * as for an address `webUrl` can't read. A card's addresses come from a webhook, not from Rails.
 */
export function cardAddress(value: string, host: string): string | undefined {
  try {
    return webUrl(value, host);
  } catch {
    return undefined;
  }
}

/**
 * `named_host?`: a domain name, written plainly, whose last label is a word, not a number or its
 * hexadecimal spelling, as an address can be written. Ruby's `split(".")` drops the empty labels at
 * the end, and raises when that leaves none.
 */
function namedHost(host: string): boolean {
  if (isBlank(host) || host.includes("%") || !host.includes(".")) return false;
  const labels = host.split(".");
  while (labels.at(-1) === "") labels.pop();
  const label = labels.at(-1);
  if (!label) throw new RenderError("NoMethodError: undefined method 'match?' for nil");
  return /[a-z]/i.test(label) && !/^0x/i.test(label);
}

const canonicalHost = (host: string) => host.toLowerCase().replace(/\.$/, "");

/**
 * `Attachment#to_plain_text`: markup that replaces the attachment, parsed in its parent, or for a
 * content attachment, its content loaded as rich text.
 */
export function attachmentPlainText({ attachable, caption }: Attachment): string | { content: string } {
  switch (attachable.kind) {
    case "mention":
      return `@${attachable.user.name}`;
    case "opengraph-embed":
      return "";
    case "content":
      return { content: attachable.content };
    case "remote-image":
      return `[${caption ?? "Image"}]`;
    case "remote-video":
      return `[${caption ?? attachable.filename ?? "Video"}]`;
    case "missing":
      return caption ?? "";
  }
}

// --- Partials -----------------------------------------------------------------------------------

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

/** Action Text's `_missing_attachable` partial. */
export const MISSING_ATTACHABLE = "☒";

const TWITTER_AVATAR_URL_PREFIX = "https://pbs.twimg.com/profile_images";

/** `OpengraphEmbed#twitter_avatar?`: an image that's someone's X avatar, which shows small and round. */
export const isTwitterAvatar = (url: string | undefined) => url?.startsWith(TWITTER_AVATAR_URL_PREFIX) ?? false;

/**
 * Campfire's app/views/action_text/attachables/_opengraph_embed.html.erb: the title, linked when there's
 * an address, and named by it when there's no title, then the description and the image.
 */
export function opengraphEmbedPartial(embed: OpengraphEmbed): string {
  const filename = embed.filename === undefined ? undefined : htmlEscape(truncate(embed.filename, 280));
  const title = embed.href === undefined ? (filename ?? "") : `<a rel="noreferrer" target="_blank" href="${htmlEscape(embed.href)}">${filename ?? htmlEscape(embed.href)}</a>`;
  let html =
    `<figure class="attachment attachment--content attachment--og">\n  <actiontext-opengraph-embed>\n` +
    `    <div class="og-embed gap ${isTwitterAvatar(embed.url) ? "og-embed--twitter-avatar" : ""}">\n      <div class="og-embed__content">\n` +
    `        <div class="og-embed__title">\n          ${title}\n        </div>\n` +
    `        <div class="og-embed__description">${htmlEscape(truncate(embed.description ?? "", 560))}</div>\n      </div>\n`;
  if (embed.url !== undefined) html += `        <div class="og-embed__image">\n          <img src="${htmlEscape(embed.url)}" class="image center" alt="">\n        </div>\n`;
  return `${html}    </div>\n  </actiontext-opengraph-embed>\n</figure>\n`;
}

/** `action_text/attachables/_content_attachment`, around its already rendered content. */
export function contentAttachmentPartial(renderedContent: string): string {
  return `<figure class="attachment attachment--content">\n  ${renderedContent}\n</figure>\n`;
}

/** `action_text/attachables/_remote_image` */
export function remoteImagePartial(attachable: Extract<Attachable, { kind: "remote-image" }>, caption?: string): string {
  let html = `<figure class="attachment attachment--preview">\n  ${imageTag(attachable.url, attachable.width, attachable.height)}\n`;
  if (caption !== undefined) html += figcaption(caption);
  return `${html}</figure>\n`;
}

/** Lexxy's `action_text/attachables/_remote_video` */
export function remoteVideoPartial(attachable: Extract<Attachable, { kind: "remote-video" }>, caption?: string): string {
  let html = `<figure class="attachment attachment--preview attachment--video">\n  <video controls="controls"${sizeAttributes(attachable.width, attachable.height)}>\n    <source src="${htmlEscape(attachable.url)}" type="${htmlEscape(attachable.contentType)}">\n</video>`;
  if (caption !== undefined) html += figcaption(caption);
  return `${html}</figure>\n`;
}

function figcaption(caption: string): string {
  return `    <figcaption class="attachment__caption">\n      ${htmlEscape(caption)}\n    </figcaption>\n`;
}

function sizeAttributes(width?: string, height?: string): string {
  return (width === undefined ? "" : ` width="${htmlEscape(width)}"`) + (height === undefined ? "" : ` height="${htmlEscape(height)}"`);
}

const ASSET_URI = /^[-a-z]+:\/\/|^(?:cid|data):|^\/\//im;

/**
 * `image_tag(url, width:, height:)`. A source that isn't a URL goes through the asset pipeline,
 * which raises for anything it doesn't know; a rooted path passes through.
 */
function imageTag(url: string, width?: string, height?: string): string {
  if (!isBlank(url) && !ASSET_URI.test(url) && !url.startsWith("/")) throw new RenderError(`The asset '${url}' was not found`);
  return `<img${sizeAttributes(width, height)} src="${htmlEscape(isBlank(url) ? "" : url)}" />`;
}
