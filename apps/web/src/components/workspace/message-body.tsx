import { createElement, useContext, type ComponentProps, type ReactNode } from "react";
import { isAppPage, type User, type UserId } from "@ember/protocol";
import { displayBody, type DisplayElement, type DisplayNode, type DisplayPreview } from "@ember/richtext/dom";
import { PageLink } from "@/components/page-link";
import { mentionedPerson, PeopleContext } from "@/hooks/use-directory";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";
import { markedRanges, matchesIn, SearchMarks, type Matches } from "./search-marks";
import { AvatarLink, UserAvatar } from "./user-avatar";

/** React's names for the attributes a message keeps, where they aren't HTML's. */
const PROP_NAMES: Record<string, string> = { datetime: "dateTime", "xml:lang": "xmlLang" };

/** Elements whose whitespace the browser doesn't show, which React won't put in them. */
const TABLE_PARTS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);

/** What a mention of someone no one knows shows. */
export const UNKNOWN_PERSON = "☒";

/**
 * What a stored body shows, or null when it can't be shown. `plainText` is the body's, which tells when a
 * message is only the link its preview is of, and a preview can't link to the page's own host.
 */
export function shownBody(body: string, plainText: string): DisplayNode[] | null {
  try {
    return displayBody(body, plainText, location.hostname);
  } catch (error) {
    console.error("Could not show a message", error);
    return null;
  }
}

interface Props {
  /** The text, as `displayBody` says it shows. */
  nodes: DisplayNode[];
  /** Whom it mentions, as the message named them, for those the people directory doesn't list yet. */
  mentions: User[];
  /** Shows it large, as a message of nothing but emoji shows. */
  emoji?: boolean;
  /** What follows the text: in its last paragraph, when it ends with one. */
  trailing?: ReactNode;
  className?: string;
}

/**
 * A message's text, built from `displayBody`'s nodes rather than set as markup, with what a search's
 * results mark in it (`SearchMarks`) marked. `.message-content` in index.css styles it.
 */
export function MessageBody({ nodes, mentions, emoji = false, trailing, className }: Props) {
  const marks = useContext(SearchMarks);
  const matches = marks && matchesIn(nodes, marks);
  const last = nodes.at(-1);
  const inLastParagraph = trailing !== undefined && last?.kind === "element" && last.name === "p";
  const children = nodes.map((node, index) => nodeOf(node, mentions, inLastParagraph && index === nodes.length - 1 ? trailing : undefined, false, matches));
  if (trailing !== undefined && !inLastParagraph) children.push(trailing);
  return createElement("div", { dir: "auto", className: cn("message-content", emoji && "text-[2.4em] leading-[1.4]", className) }, ...children);
}

/** `node` as React draws it, with `trailing` after its text, inside a link if `inLink`, and the `matches` in its text marked. */
function nodeOf(node: DisplayNode, mentions: User[], trailing?: ReactNode, inLink = false, matches: Matches | null = null): ReactNode {
  if (node.kind === "text") return markedRanges(node.value, matches?.get(node));
  if (node.kind === "mention") return createElement(Mention, { userId: node.userId, mentions, inLink });
  if (node.kind === "preview") return createElement(LinkPreview, { preview: node, mentions, inLink });
  const shown = TABLE_PARTS.has(node.name) ? node.children.filter((child) => child.kind !== "text" || child.value.trim() !== "") : node.children;
  const children = shown.map((child) => nodeOf(child, mentions, undefined, inLink || node.name === "a", matches));
  if (trailing !== undefined) children.push(" ", trailing);
  const props = Object.fromEntries(Object.entries(node.attrs).map(([name, value]) => [PROP_NAMES[name] ?? name, value]));
  switch (node.name) {
    case "a":
      return createElement(MessageLink, props, ...children);
    case "pre":
      return createElement(CodeBlock, { ...props, block: node }, ...children);
    case "li":
      return createElement("li", { ...props, "data-list": holdsOnlyAList(node) || undefined }, ...children);
    default:
      return createElement(node.name, props, ...children);
  }
}

/**
 * A mention, styled by Campfire's autocomplete.css: the person's avatar, as tall as the line and linking
 * to their page, then their name as they're named now, in semibold, every time they're mentioned. The
 * avatar is a `.btn`'s weight, which its `ch` is measured in. Unlike Campfire's, the mention isn't
 * lifted over what follows, such as the next message's Message options. In a link, the avatar is only an
 * image, as a link can't hold another.
 */
function Mention({ userId, mentions, inLink }: { userId: UserId; mentions: User[]; inLink: boolean }) {
  const person = mentionedPerson(useContext(PeopleContext), mentions, userId);
  if (!person) return UNKNOWN_PERSON;
  const avatar = "absolute inset-y-0 start-[0.1ch] size-[1.1em] font-medium";
  return (
    <span className="relative inline-flex items-center ps-[calc(1.1em+1ch/3)] leading-[1.1em] font-semibold">
      {inLink ? <UserAvatar user={person} className={avatar} /> : <AvatarLink user={person} reach="none" className={avatar} />}
      {person.name}
    </span>
  );
}

/**
 * A link preview, as Campfire's _opengraph_embed.html.erb lays one out and its embeds.css styles it: a card
 * with the page's title in semibold, linking to it, and its description, cut at six lines, then its image,
 * 16:9 under the text, or beside it at 100ch wide and up. An X avatar is small and round, beside the text at
 * any width. Unlike Campfire's, the image loads as it nears the screen, as a room can hold a lot of them,
 * and without a referrer (`RemoteImage`).
 * In a link, the title is only text, as a link can't hold another.
 */
function LinkPreview({ preview, mentions, inLink }: { preview: DisplayPreview; mentions: User[]; inLink: boolean }) {
  const linked = preview.href !== undefined && !inLink;
  const title = preview.title.map((node) => nodeOf(node, mentions, undefined, inLink || linked));
  return (
    <div
      className={cn(
        "mt-4 mb-2 flex gap-x-[1ch] gap-y-4 overflow-clip rounded-[0.5em] border bg-background px-[1.5ch] py-4 min-[100ch]:items-start",
        preview.avatar ? "flex-row" : "flex-col min-[100ch]:flex-row",
      )}
    >
      <div className="line-clamp-6 whitespace-normal">
        <div className="font-semibold">{linked ? createElement(MessageLink, { href: preview.href }, ...title) : title}</div>
        <div className="text-foreground">{preview.description.map((node) => nodeOf(node, mentions, undefined, inLink))}</div>
      </div>
      {preview.image !== undefined && (
        <div
          className={cn(
            "flex max-w-full shrink-0 overflow-clip",
            preview.avatar ? "aspect-square size-[2lh] rounded-full" : "aspect-video min-[100ch]:w-[15dvw]",
          )}
        >
          <RemoteImage src={preview.image} alt="" className="h-auto w-full rounded-none object-contain object-right-top max-[100ch]:object-left-top" />
        </div>
      )}
    </div>
  );
}

/** A list item that holds only a list, as Lexxy nests one list in another, which shows no marker of its own. */
function holdsOnlyAList(item: DisplayElement): boolean {
  const children = item.children.filter((child) => child.kind !== "text" || child.value.trim() !== "");
  return children.length === 1 && children[0]!.kind === "element" && ["ul", "ol"].includes(children[0]!.name);
}

/**
 * An image another site serves, as a link preview's or a bot card's is: loaded once it's near the
 * screen, and without a referrer, so the site doesn't learn which Ember shows it. The site still sees
 * the reader's IP address, which only serving the image through the Worker would hide.
 */
export function RemoteImage(props: Omit<ComponentProps<"img">, "referrerPolicy">) {
  return <img loading="lazy" {...props} referrerPolicy="no-referrer" />;
}

/**
 * A link in a message: an address on this site opens in place, without a page load for one of the app's
 * pages, and any other in a new tab.
 */
export function MessageLink({ href, ...props }: ComponentProps<"a">) {
  if (href === undefined) return <a {...props} />;
  const url = urlOf(href);
  if (url?.origin !== location.origin) return <a href={href} target="_blank" rel="noopener" {...props} />;
  return isAppPage(url.pathname) ? <PageLink href={url.pathname + url.search + url.hash} {...props} /> : <a href={href} {...props} />;
}

function urlOf(href: string): URL | null {
  try {
    return new URL(href, location.href);
  } catch {
    return null;
  }
}
