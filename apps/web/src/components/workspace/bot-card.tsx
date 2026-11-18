import { createContext, useContext, useId, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import type { Card, CardAction, CardButton, CardColumn, CardContextItem, CardField, CardImage, CardPart, CardTile } from "@ember/protocol";
import { cardAddress, displayBody, type DisplayElement, type DisplayNode } from "@ember/richtext/dom";
import { Button } from "@/components/ui/button";
import { dateTimeLabel } from "@/lib/messages";
import { cn } from "@/lib/utils";
import { MessageBody, MessageLink, RemoteImage } from "./message-body";
import { Marked } from "./search-marks";

// A bot's cards (packages/protocol/src/cards.ts), which a Slack-compatible webhook's legacy attachments and
// Block Kit blocks show under its message, framed as a link preview is (message-body.tsx) and laid out as Slack
// lays out an attachment and its blocks. The room kept only addresses on named hosts, and each is checked again
// here against the page's own host, which a card can't aim at, as a link preview can't, since every reader's
// browser would fetch it signed in. A search's results mark what it matched in all of a card's text, as it
// searched all of it. A button that acts tells the room it was clicked, which reports the click to the card's bot.

/** The bars of Slack's named colors, in Ember's: a notice's green, the warning amber and an alert's red. */
const BARS = new Map([
  ["good", "bg-positive"],
  ["warning", "bg-warning"],
  ["danger", "bg-negative"],
]);

/** How much text shows before a card folds the rest behind Show more. */
const FOLD_CHARACTERS = 700;
const FOLD_LINE_BREAKS = 5;

/** Elements that start a line of their own. */
const BLOCKS = new Set(["p", "div", "li", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** How a table's column lines up its cells. */
const ALIGNS = { left: "text-start", center: "text-center", right: "text-end" } as const;

/** What a click on a button that acts does, answering once its bot has taken the click, or hasn't. */
export type CardClick = (action: CardAction) => Promise<boolean>;

/** What the buttons that act do when they're clicked, where the cards are a message's in a room. Elsewhere, they're disabled. */
const OnAction = createContext<CardClick | undefined>(undefined);

/** A message's cards, one under another, whose buttons that act do `onAction`. */
export function BotCards({ cards, className, onAction }: { cards: Card[]; className?: string; onAction?: CardClick }) {
  return (
    <OnAction value={onAction}>
      <div className={cn("flex flex-col gap-2 pt-1", className)}>
        {cards.map((card, index) => (
          <BotCard key={index} card={card} />
        ))}
      </div>
    </OnAction>
  );
}

/**
 * A card, 38rem wide or as wide as there's room for: an attachment's pretext, then a frame, with a 4px bar down
 * its left side in an attachment's color, holding its parts and an attachment's thumbnail at the right. Its
 * fields take one column in a frame under 400px wide. It's an article named by its title or header.
 */
function BotCard({ card }: { card: Card }) {
  const titleId = useId();
  const title = card.parts.find((part) => part.kind === "title" || part.kind === "header");
  const thumb = card.thumb && shownImage(card.thumb);
  const barred = card.source === "attachment";
  const bar = card.color === undefined ? "bg-border" : BARS.get(card.color);
  return (
    <div className="w-[38rem] max-w-full">
      {card.pretext !== undefined && <CardText html={card.pretext} className="pb-1" />}
      <article
        aria-labelledby={title && titleId}
        className={cn(
          "@container relative flex gap-[1.5ch] overflow-clip rounded-[0.5em] border bg-background py-3 pe-[1.5ch]",
          barred ? "ps-[calc(1.5ch+4px)]" : "ps-[1.5ch]",
        )}
      >
        {barred && <span aria-hidden className={cn("absolute inset-y-0 start-0 w-1", bar)} style={bar ? undefined : { backgroundColor: card.color }} />}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {card.parts.map((part, index) => (
            <Part key={index} part={part} titleId={part === title ? titleId : undefined} />
          ))}
        </div>
        {thumb && <Thumb image={thumb} />}
      </article>
    </div>
  );
}

/** One of a card's parts, as Slack shows an attachment's or a block: the first title or header gets `titleId`, which names the card. */
function Part({ part, titleId }: { part: CardPart; titleId?: string }) {
  switch (part.kind) {
    case "author":
      return (
        <div className="flex min-w-0 items-center gap-[0.5ch] text-[13px] leading-[18px] font-semibold text-message-muted">
          <Icon url={part.icon} />
          <span className="min-w-0 wrap-anywhere">
            <Linked href={part.href}>{part.name}</Linked>
          </span>
        </div>
      );
    case "title":
      return (
        <h4 id={titleId} className="text-[15px] leading-[22px] font-semibold wrap-anywhere text-message-ink">
          <Linked href={part.href} className="text-link">
            {part.text}
          </Linked>
        </h4>
      );
    case "header":
      return (
        <h4 id={titleId} className="text-[18px] leading-[24px] font-bold wrap-anywhere text-message-ink">
          <Marked>{part.text}</Marked>
        </h4>
      );
    case "text":
      return <CardText html={part.html} folds />;
    case "section":
      return <Section html={part.html} fields={part.fields} thumb={part.thumb} button={part.button} />;
    case "fields":
      return <Fields fields={part.fields} />;
    case "image":
      return <Image image={part.image} title={part.title} />;
    case "context":
      return <Context items={part.items} />;
    case "divider":
      return <hr className="my-1 border-border" />;
    case "buttons":
      return <Buttons buttons={part.buttons} />;
    case "table":
      return <Table rows={part.rows} columns={part.columns} />;
    case "tiles":
      return <Tiles tiles={part.tiles} />;
    case "footer":
      return <Footer text={part.text} icon={part.icon} at={part.at} />;
  }
}

/**
 * Rich text in a card, as a message's text shows, or in small gray type where it's `small`. Where it `folds`,
 * text past 700 characters or 5 line breaks folds behind Show more, as Slack folds an attachment's.
 */
function CardText({ html, folds = false, small = false, className }: { html: string; folds?: boolean; small?: boolean; className?: string }) {
  const nodes = useMemo(() => shownText(html), [html]);
  const [open, setOpen] = useState(false);
  if (nodes === null) return null;
  const long = folds && isLong(nodes);
  return (
    <div className={className}>
      <MessageBody nodes={nodes} mentions={[]} className={cn(small && "text-xs leading-[18px] text-message-muted", long && !open && "max-h-[5lh] overflow-hidden")} />
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="cursor-pointer text-sm font-medium text-link hover:underline touch:min-h-11"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/**
 * A section: its text over its fields, with a thumbnail, or a button, at their right, as Slack shows a
 * section's accessory. In a card under 400px wide, the button goes under them, leaving the text room.
 */
function Section({ html, fields, thumb, button }: { html?: string; fields?: CardField[]; thumb?: CardImage; button?: CardButton }) {
  const shownThumb = thumb && shownImage(thumb);
  return (
    <div className={cn("flex min-w-0 gap-[1.5ch]", button && "@max-[400px]:flex-col @max-[400px]:gap-1.5")}>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {html !== undefined && <CardText html={html} folds />}
        {fields && <Fields fields={fields} />}
      </div>
      {shownThumb && <Thumb image={shownThumb} />}
      {button && <Buttons buttons={[button]} className="max-w-[50%] shrink-0 self-start pt-0" />}
    </div>
  );
}

/** A card's fields: short ones two to a row, the rest the whole width, each title in small bold over its value. */
function Fields({ fields }: { fields: CardField[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-[2ch] gap-y-2 pt-1 @max-[400px]:grid-cols-1">
      {fields.map((field, index) => (
        <div key={index} className={cn("min-w-0", !field.short && "col-span-full")}>
          {field.title !== undefined && (
            <div className="text-[13px] leading-[18px] font-semibold wrap-anywhere text-message-muted">
              <Marked>{field.title}</Marked>
            </div>
          )}
          {field.html !== "" && <CardText html={field.html} />}
        </div>
      ))}
    </div>
  );
}

/**
 * A card's image, under its title, at most 360px wide and 500px tall, loading as it nears the screen, linked to
 * itself: the link is named by what the image shows, or by its host where the payload doesn't say, as an
 * attachment's never does.
 */
function Image({ image, title }: { image: CardImage; title?: string }) {
  const shown = shownImage(image);
  if (!shown) return null;
  return (
    <figure className="flex min-w-0 flex-col gap-1 pt-1">
      {title !== undefined && (
        <figcaption className="text-[13px] leading-[18px] wrap-anywhere text-message-muted">
          <Marked>{title}</Marked>
        </figcaption>
      )}
      <MessageLink href={shown.url} aria-label={shown.alt === "" ? `Image from ${new URL(shown.url).hostname}` : undefined} className="block w-fit max-w-full">
        <RemoteImage src={shown.url} alt={shown.alt} className="max-h-[500px] max-w-[min(100%,360px)] rounded-[6px] object-contain" />
      </MessageLink>
    </figure>
  );
}

/** A 75px thumbnail at the right of a card or a section. */
function Thumb({ image }: { image: CardImage }) {
  return <RemoteImage src={image.url} alt={image.alt} className="size-[75px] shrink-0 rounded-[6px] object-cover" />;
}

/** A context row: small gray text and 20px images, side by side, wrapping where they need to. */
function Context({ items }: { items: CardContextItem[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-[1ch] gap-y-1">
      {items.map((item, index) => ("image" in item ? <ContextImage key={index} image={item.image} /> : <CardText key={index} html={item.html} small className="min-w-0" />))}
    </div>
  );
}

function ContextImage({ image }: { image: CardImage }) {
  const shown = shownImage(image);
  return shown ? <RemoteImage src={shown.url} alt={shown.alt} className="size-5 shrink-0 rounded-[4px] object-cover" /> : null;
}

/**
 * A table, ruled as a message's is, which scrolls sideways when it's wider than the card: each column lines up
 * as it says, and its cells are cut short at 20rem unless it wraps.
 */
function Table({ rows, columns }: { rows: string[][]; columns: CardColumn[] }) {
  return (
    <div role="region" aria-label="Table" tabIndex={0} className="max-w-full overflow-x-auto pt-1">
      <table className="border-collapse">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} className={cn("border px-[1ch] py-1 align-top", ALIGNS[columns[index]?.align ?? "left"])}>
                  {cell !== "" && <CardText html={cell} className={cn("max-w-[20rem]", !columns[index]?.wrap && "[&_p]:truncate")} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Small cards in a list, a row that scrolls sideways when there are more than fit, as Slack shows a carousel.
 * A row of several is a region a keyboard can scroll, where the next card shows at the edge of a narrow one;
 * one card shrinks to fit.
 */
function Tiles({ tiles }: { tiles: CardTile[] }) {
  const several = tiles.length > 1;
  return (
    <div
      role={several ? "region" : undefined}
      aria-label={several ? "Cards" : undefined}
      tabIndex={several ? 0 : undefined}
      className="max-w-full snap-x snap-mandatory overflow-x-auto pt-1"
    >
      <ul className="flex gap-2">
        {tiles.map((tile, index) => (
          <Tile key={index} tile={tile} inRow={several} />
        ))}
      </ul>
    </div>
  );
}

/**
 * A small card, 17.5rem wide, so two fit side by side in a card: its hero image across its top, its icon beside
 * its title and subtitle, its body and subtext, and its buttons, a danger one at the left and the rest at the
 * right, a primary one furthest right, as Slack lays out a card block's. In a row, it leaves room for the next.
 */
function Tile({ tile, inRow }: { tile: CardTile; inRow: boolean }) {
  const hero = tile.hero && shownImage(tile.hero);
  const icon = tile.icon && shownImage(tile.icon);
  const danger = tile.buttons?.filter(({ style }) => style === "danger") ?? [];
  const rest = (tile.buttons ?? []).filter(({ style }) => style !== "danger").sort((a, b) => Number(a.style === "primary") - Number(b.style === "primary"));
  return (
    <li className={cn("flex w-[17.5rem] shrink-0 snap-start flex-col overflow-clip rounded-[0.5em] border", inRow ? "max-w-[85%]" : "max-w-full")}>
      {hero && <RemoteImage src={hero.url} alt={hero.alt} className="aspect-[2/1] w-full object-cover" />}
      <div className="flex flex-1 flex-col gap-1.5 p-[1.5ch]">
        {(tile.title !== undefined || tile.subtitle !== undefined) && (
          <div className="flex min-w-0 items-center gap-[1ch]">
            {icon && <RemoteImage src={icon.url} alt={icon.alt} className="size-8 shrink-0 rounded-[6px] object-cover" />}
            <div className="min-w-0">
              {tile.title !== undefined && (
                <div className="text-[15px] leading-[22px] font-semibold wrap-anywhere text-message-ink">
                  <Marked>{tile.title}</Marked>
                </div>
              )}
              {tile.subtitle !== undefined && (
                <div className="text-[13px] leading-[18px] wrap-anywhere text-message-muted">
                  <Marked>{tile.subtitle}</Marked>
                </div>
              )}
            </div>
          </div>
        )}
        {tile.body !== undefined && <CardText html={tile.body} />}
        {tile.subtext !== undefined && <CardText html={tile.subtext} small />}
        {tile.buttons && (
          <div className="mt-auto flex justify-between gap-2">
            <Buttons buttons={danger} />
            <Buttons buttons={rest} className="ms-auto justify-end" />
          </div>
        )}
      </div>
    </li>
  );
}

/** A card's buttons, bordered, filled for `primary`, and red for `danger`, as Delete is in both modes: links, and those that act. */
function Buttons({ buttons, className }: { buttons: CardButton[]; className?: string }) {
  const shown = buttons.flatMap((button): CardButton[] => {
    if (button.action) return [button];
    const href = button.href === undefined ? undefined : shownAddress(button.href);
    return href ? [{ ...button, href }] : [];
  });
  if (shown.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2 pt-1", className)}>
      {shown.map(({ text, href, action, style }, index) => {
        const label = (
          <span className="truncate">
            <Marked>{text}</Marked>
          </span>
        );
        const look = {
          size: "sm",
          variant: style ? "default" : "outline",
          className: cn("max-w-full touch:min-h-11", style === "danger" && "bg-negative-button text-white hover:bg-negative-button/90"),
        } as const;
        return action ? (
          <ActionButton key={index} action={action} {...look}>
            {label}
          </ActionButton>
        ) : (
          <Button key={index} asChild {...look}>
            <MessageLink href={href!}>{label}</MessageLink>
          </Button>
        );
      })}
    </div>
  );
}

/**
 * A button that acts: a click tells its bot, and it waits, disabled, until the room says the bot has answered,
 * or why it hasn't, which the room shows. It's disabled where a click has nowhere to go.
 */
function ActionButton({ action, children, ...look }: { action: CardAction; children: ReactNode } & Pick<ComponentProps<typeof Button>, "size" | "variant" | "className">) {
  const onAction = useContext(OnAction);
  const [waiting, setWaiting] = useState(false);
  const click = () => {
    if (!onAction) return;
    setWaiting(true);
    void onAction(action).finally(() => setWaiting(false));
  };
  return (
    <Button type="button" disabled={!onAction || waiting} aria-busy={waiting || undefined} onClick={click} {...look}>
      {children}
    </Button>
  );
}

/** A card's footer, in small gray type: its icon, its text and its moment, in the reader's time zone. */
function Footer({ text, icon, at }: { text?: string; icon?: string; at?: number }) {
  const moment = at === undefined ? undefined : new Date(at * 1000);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-[0.5ch] pt-1 text-xs text-message-muted">
      <Icon url={icon} />
      {text !== undefined && (
        <span className="min-w-0 wrap-anywhere">
          <Marked>{text}</Marked>
        </span>
      )}
      {text !== undefined && moment && <span aria-hidden>·</span>}
      {moment && <time dateTime={moment.toISOString()}>{dateTimeLabel(moment)}</time>}
    </div>
  );
}

/** An author's or a footer's 16px icon, which says nothing its text doesn't. */
function Icon({ url }: { url?: string }) {
  const src = url && shownAddress(url);
  return src ? <RemoteImage src={src} alt="" className="size-4 shrink-0 rounded-[4px]" /> : null;
}

/** `children`, linked to `href` when the card may link there. */
function Linked({ href, className, children }: { href?: string; className?: string; children: string }) {
  const shown = href && shownAddress(href);
  return shown ? (
    <MessageLink href={shown} className={cn("hover:underline", className)}>
      <Marked>{children}</Marked>
    </MessageLink>
  ) : (
    <Marked>{children}</Marked>
  );
}

/** What a card's rich text shows, or null when it can't be shown, as a message whose text can't be shown goes. */
function shownText(html: string): DisplayNode[] | null {
  try {
    return displayBody(html, "", location.hostname);
  } catch (error) {
    console.error("Could not show a card's text", error);
    return null;
  }
}

/** Whether a block's first child is a block, which starts the same line, as Markdown's headings in a `div` do. */
const startsWithBlock = (block: DisplayElement) => {
  const first = block.children[0];
  return first?.kind === "element" && BLOCKS.has(first.name);
};

/** Whether text runs past 700 characters or 5 line breaks. */
function isLong(nodes: DisplayNode[]): boolean {
  let characters = 0;
  // The first line starts none.
  let lineBreaks = -1;
  const count = (node: DisplayNode) => {
    if (node.kind === "text") {
      characters += node.value.length;
      lineBreaks += node.value.split("\n").length - 1;
    } else if (node.kind === "element") {
      if (node.name === "br" || (BLOCKS.has(node.name) && !startsWithBlock(node))) lineBreaks++;
      node.children.forEach(count);
    }
  };
  nodes.forEach(count);
  return characters > FOLD_CHARACTERS || lineBreaks > FOLD_LINE_BREAKS;
}

/** An address a card may show, unless it's on the page's own host. */
const shownAddress = (url: string) => cardAddress(url, location.hostname);

function shownImage(image: CardImage): CardImage | undefined {
  const url = shownAddress(image.url);
  return url === undefined ? undefined : { ...image, url };
}
