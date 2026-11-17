// How a message body renders: `MessagesHelper#message_presentation` up to its auto_link, and the
// canonical form Ember stores, which is that rendering with its mentions and link previews left to
// render live.

import {
  attachmentFromNode,
  ATTACHMENT_TAG,
  contentAttachmentPartial,
  MENTION_CONTENT_TYPE,
  MISSING_ATTACHABLE,
  OPENGRAPH_EMBED_CONTENT_TYPE,
  opengraphEmbedPartial,
  remoteImagePartial,
  remoteVideoPartial,
  RenderError,
  type Attachable,
  type Attachment,
  type MentionUser,
  type OpengraphEmbed,
  type ResolveMention,
} from "./attachments";
import {
  attachmentGalleryNodes,
  attachmentNodes,
  contentToPlainText,
  loadContent,
  MAX_CONTENT_ATTACHMENT_DEPTH,
  sanitizeContentAttribute,
} from "./content";
import { BODY, forOneReading, parseReplacement, setInnerHtml, type HtmlParser } from "./markup";
import { mentionSgid } from "./mentions";
import { previewContent, removeSoloUnfurledLinkText } from "./previews";
import { chomp, htmlEscape, presence, strip } from "./ruby";
import { ACTION_TEXT, ATTACHMENT_ATTRIBUTES, AUTO_LINK, CONTENT_FILTER, sanitize, sanitizeTags, scrub } from "./sanitize";
import { toHtml } from "./serialize";
import {
  ancestors,
  createElement,
  createFragment,
  descendants,
  detach,
  elementChildren,
  getAttr,
  isElement,
  removeAttr,
  removeChildren,
  replaceEach,
  setAttr,
  type Element,
  type Fragment,
  type Node,
} from "./tree";

/** What mentions and link previews render as: Campfire's partials for them, or stand-ins. */
interface Partials {
  mention: (user: MentionUser) => string;
  preview: (embed: OpengraphEmbed) => string;
}

/**
 * `message_presentation`'s rendering, sanitized as its auto_link sanitizes it but not linked: `<` and
 * `>` escaped in attribute values. `host` is the one the page is served from, which previews mustn't
 * name. Throws `ParseLimitError` and `RenderError` where Rails raises, which `message_presentation`
 * rescues to show nothing.
 */
export function presentMessage(parse: HtmlParser, body: string, resolve: ResolveMention, mention: Partials["mention"], host = ""): string {
  const partials = { mention, preview: opengraphEmbedPartial };
  const read = forOneReading(parse);
  return toHtml(renderFiltered(read, filterMessage(read, body, resolve, host), resolve, partials, host), { escapeAttributeBrackets: true });
}

const MENTION_MARKER = "ember-mention";
const PREVIEW_MARKER = "ember-preview";
const isMarker = (element: Element) => element.name === MENTION_MARKER || element.name === PREVIEW_MARKER;

/**
 * The form Ember stores a body in: `presentMessage`'s, out of its layout and stripped, with each
 * mention as an empty `<action-text-attachment content-type="application/vnd.campfire.mention"
 * sgid="<user id>">` that renders the person as they are now, each link preview as the attachment
 * the composer writes for one (`previewContent`), which renders as the page shows it, and without
 * three things: `class` attributes, since a message's Tailwind classes could restyle the page, the
 * images of remote image attachments, which a stored body can't hold (SanitizeTags removes
 * `<img>`), and the newlines a `pre` starts with: each parse drops one, so those a body's five
 * parses leave would go when it's stored again. The link a preview is of keeps its text, which
 * goes as the message shows. Stored again, the stored form comes back the same.
 */
export function canonicalize(parse: HtmlParser, body: string, resolve: ResolveMention): string {
  const previews: OpengraphEmbed[] = [];
  const markers: Partials = {
    mention: (user) => `<${MENTION_MARKER} user="${htmlEscape(user.id)}"></${MENTION_MARKER}>`,
    preview: (embed) => `<${PREVIEW_MARKER} index="${previews.push(embed) - 1}"></${PREVIEW_MARKER}>`,
  };
  const read = forOneReading(parse);
  const content = withoutLayout(renderFiltered(read, filterStored(read, body, resolve), resolve, markers, ""));
  const replacements = new Map<Node, Node[]>();
  for (const node of descendants(content)) {
    if (!isElement(node)) continue;
    if (node.name === MENTION_MARKER) replacements.set(node, [mentionAttachment(getAttr(node, "user")!)]);
    else if (node.name === PREVIEW_MARKER) replacements.set(node, [previewAttachment(previews[Number(getAttr(node, "index"))]!)]);
    else if (node.name === "img") replacements.set(node, []);
    else removeAttr(node, "class");
    if (node.name === "pre") withoutLeadingNewlines(node);
  }
  replaceEach(replacements);
  return strip(toHtml(content, { escapeAttributeBrackets: true }));
}

function withoutLeadingNewlines(pre: Element): void {
  for (let first = pre.children[0]; first?.kind === "text"; first = pre.children[0]) {
    first.value = first.value.replace(/^\n+/, "");
    if (first.value !== "") return;
    detach(first);
  }
}

function mentionAttachment(userId: string): Element {
  return createElement(ATTACHMENT_TAG, [
    { name: "content-type", value: MENTION_CONTENT_TYPE },
    { name: "sgid", value: mentionSgid(userId) },
  ]);
}

function previewAttachment(embed: OpengraphEmbed): Element {
  return createElement(ATTACHMENT_TAG, [
    { name: "content-type", value: OPENGRAPH_EMBED_CONTENT_TYPE },
    { name: "content", value: previewContent(embed) },
  ]);
}

/**
 * `TextMessagePresentationFilters.apply(message.body.body)`: RemoveSoloUnfurledLinkText, then
 * SanitizeTags and SanitizeAttributes. The first reads the body's plain text, which can raise.
 */
export function filterMessage(parse: HtmlParser, body: string, resolve: ResolveMention, host = ""): Fragment {
  const plainText = readPlainText(parse, body, resolve);
  const content = loadContent(parse, body);
  removeSoloUnfurledLinkText(parse, content, plainText, host);
  return sanitizeFiltered(parse, content);
}

/**
 * The filters as Ember stores a body, leaving out RemoveSoloUnfurledLinkText, which `displayBody`
 * applies as a message shows, but still raising where reading its plain text does.
 */
function filterStored(parse: HtmlParser, body: string, resolve: ResolveMention): Fragment {
  readPlainText(parse, body, resolve);
  return sanitizeFiltered(parse, loadContent(parse, body));
}

/** The body's plain text, in a reading of its own: the one `parse` is for reads the body again, and copies as much. */
function readPlainText(parse: HtmlParser, body: string, resolve: ResolveMention): string {
  const read = forOneReading(parse);
  return contentToPlainText(read, loadContent(read, body), resolve);
}

/** SanitizeTags, then SanitizeAttributes. */
function sanitizeFiltered(parse: HtmlParser, content: Fragment): Fragment {
  sanitizeTags(content);
  return parse(strip(sanitize(parse, toHtml(content), CONTENT_FILTER)), BODY);
}

/** The filtered body rendered in its layout, and sanitized as `auto_link` sanitizes it. */
function renderFiltered(parse: HtmlParser, filtered: Fragment, resolve: ResolveMention, partials: Partials, host: string): Fragment {
  const rendered = new Renderer(parse, resolve, partials, host).render(filtered, 0);
  const layout = parse(`<div class="lexxy-content">\n  ${rendered}\n</div>\n`, BODY);
  scrub(layout, AUTO_LINK, isMarker);
  return layout;
}

/** The rendered body, out of the `lexxy-content` layout `renderFiltered` wraps it in. */
function withoutLayout(fragment: Fragment): Fragment {
  const [layout, ...after] = removeChildren(fragment);
  return createFragment([...(layout?.kind === "element" ? removeChildren(layout) : []), ...after]);
}

class Renderer {
  /** The `content` attributes of rendered attachments, by the stand-ins that replace them. */
  private readonly contents = new Map<string, string>();
  /** What `renderContent` made of each content it rendered, by its depth and the content. */
  private readonly renderedContents = new Map<string, string>();

  constructor(
    private readonly parse: HtmlParser,
    private readonly resolve: ResolveMention,
    private readonly partials: Partials,
    private readonly host: string,
  ) {}

  /**
   * `render_action_text_content(content)` for content `depth` content attachments down: its
   * attachments and galleries rendered, then sanitized with Action Text's allowlist, which leaves
   * the stand-ins for mentions and previews as they are.
   *
   * Unlike Rails, a gallery renders only its own attachments, and the galleries in what an
   * attachment's content rendered stay as that level rendered them. Rails counts the gallery
   * attachments in what a gallery's attachments rendered as the gallery's too, and renders the
   * galleries in rendered content again at every level above them, so galleries nested in one
   * another's attachments multiplied the rendering and its markup at each level, however deep
   * content renders.
   */
  render(content: Fragment, depth: number): string {
    const parse = this.parse;
    const attachments = new Map<Node, Node[]>();
    for (const node of attachmentNodes(content)) {
      sanitizeContentAttribute(parse, node);
      const { attachable } = attachmentFromNode(parse, node, this.resolve, this.host);
      const full = this.withFullAttributes(node, attachable);
      setInnerHtml(parse, full, this.renderAttachment({ attachable, caption: presence(getAttr(full, "caption")) }, depth));
      attachments.set(node, parseReplacement(parse, node, toHtml(full)));
    }
    replaceEach(attachments);
    const galleries = new Map<Node, Node[]>();
    for (const gallery of attachmentGalleryNodes(content)) {
      if (isInsideAttachment(gallery)) continue;
      // A gallery's elements are all gallery attachments
      const members = elementChildren(gallery);
      let rendered = "";
      for (const member of members) {
        const node = this.withContent(member);
        const attachment = attachmentFromNode(parse, node, this.resolve, this.host);
        const full = this.withFullAttributes(node, attachment.attachable);
        setInnerHtml(parse, full, this.renderAttachment(attachment, depth));
        rendered += toHtml(full);
      }
      const html = `<div class="attachment-gallery attachment-gallery--${members.length}">\n  ${rendered}\n</div>`;
      galleries.set(gallery, parseReplacement(parse, gallery, html));
    }
    replaceEach(galleries);
    return sanitize(parse, toHtml(content), ACTION_TEXT, isMarker);
  }

  /** `render_action_text_attachment(attachment)`: the attachable's partial, chomped. */
  private renderAttachment({ attachable, caption }: Attachment, depth: number): string {
    switch (attachable.kind) {
      case "mention":
        return chomp(this.partials.mention(attachable.user));
      case "opengraph-embed":
        return chomp(this.partials.preview(attachable.embed));
      // Rails asks a missing record's model for its partial, which User doesn't have, so a mention of
      // someone deleted raised and blanked the message: Ember shows ☒ for every one
      case "missing":
        return MISSING_ATTACHABLE;
      case "content":
        return chomp(contentAttachmentPartial(this.renderContent(attachable.content, depth)));
      case "remote-image":
        return chomp(remoteImagePartial(attachable, caption));
      case "remote-video":
        return chomp(remoteVideoPartial(attachable, caption));
    }
  }

  /**
   * A content attachment's content, rendered without a layout, as deep as content renders. Content
   * renders the same each time at a depth, and a gallery renders its attachments a second time, so
   * each rendering is kept: rendered twice, nested galleries would double the work at every level.
   */
  private renderContent(content: string, depth: number): string {
    if (depth >= MAX_CONTENT_ATTACHMENT_DEPTH) return "";
    const key = `${depth} ${content}`;
    let rendered = this.renderedContents.get(key);
    if (rendered === undefined) {
      rendered = `${this.render(loadContent(this.parse, content), depth + 1)}\n`;
      this.renderedContents.set(key, rendered);
    }
    return rendered;
  }

  /**
   * `Attachment#with_full_attributes`'s node, its `content` replaced by a stand-in. Rails carries
   * each rendered attachment's content through the markup of every level above it, parsing and
   * serializing it again at each, until auto_link's sanitizing drops it with the attachment: with
   * the stand-in, a level of nested content attachments costs only its own markup. Galleries
   * resolve their members again, which `withContent` makes possible.
   */
  private withFullAttributes(node: Element, attachable: Attachable): Element {
    const full = withFullAttributes(node, attachable);
    const content = getAttr(full, "content");
    if (content !== undefined) {
      const standIn = `ember-content-${this.contents.size}`;
      this.contents.set(standIn, content);
      setAttr(full, "content", standIn);
    }
    return full;
  }

  /** A copy of a rendered attachment with its `content` back in place of the stand-in. */
  private withContent(rendered: Element): Element {
    const content = this.contents.get(getAttr(rendered, "content") ?? "");
    if (content === undefined) return rendered;
    const attrs = rendered.attrs.map((attr) => (attr.name === "content" ? { name: "content", value: content } : attr));
    return createElement(rendered.name, attrs, rendered.namespace);
  }
}

/** Whether a node is part of what an attachment rendered, which is all a rendered attachment holds. */
const isInsideAttachment = (node: Node) => ancestors(node).some((ancestor) => isElement(ancestor, ATTACHMENT_TAG));

/**
 * `Attachment#with_full_attributes`'s node: the node's attachment attributes, in Action Text's
 * order, with a mentioned user's content type.
 */
function withFullAttributes(node: Element, attachable: Attachable): Element {
  const attrs = [];
  for (const name of ATTACHMENT_ATTRIBUTES) {
    const value = name === "content-type" && attachable.kind === "mention" ? MENTION_CONTENT_TYPE : getAttr(node, name);
    if (value !== undefined) attrs.push({ name, value });
  }
  // Rails makes no node of no attributes, then calls #node on the nil
  if (attrs.length === 0) throw new RenderError("undefined method 'node' for nil");
  return createElement(ATTACHMENT_TAG, attrs);
}
