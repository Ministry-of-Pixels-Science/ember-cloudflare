import {
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactElement,
  type Ref,
  type RefObject,
} from "react";
import { QUICK_REACTION_COUNT, REACTIONS, type Message, type StoredFile } from "@ember/protocol";
import type { DisplayNode } from "@ember/richtext/dom";
import { ChatPlusIn, Copy, Download, Edit, Emoji, MessageText, MoreHoriz, QuoteMessage, ShareAndroid, Trash } from "@/components/icons/iconoir";
import { PageLink } from "@/components/page-link";
import { ShareButton } from "@/components/share-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { mentionedPerson, PeopleContext, useNameOf } from "@/hooks/use-directory";
import { useMediaQuery } from "@/hooks/use-media-query";
import { permalinkOf } from "@/hooks/use-route";
import { copyWithSuccess } from "@/lib/clipboard";
import { replyQuote } from "@/lib/messages";
import { canShare } from "@/lib/share";
import { cn } from "@/lib/utils";
import { COPY_CODE } from "./code-block";
import { UNKNOWN_PERSON } from "./message-body";

/** With a mouse, the bar overlaps its message. */
const OVERLAPPING = "(hover: hover) and (pointer: fine)";

/** How long a bar that hovering opened stays after the pointer leaves it, so the pointer can cross to it. */
const LEAVE_DELAY_MS = 180;

/** The open bar, which closes as another opens, so only one is open at a time. */
let openBar: { close(): void } | null = null;

/**
 * The bar's buttons: 32px, with 16px icons. For fingers they're 44px, as Ember's controls are.
 */
const ACTION =
  "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-[0.8rem] font-medium text-message-muted transition-colors duration-150 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground touch:size-11 [&_svg]:size-4";

/** The bar and the tray of more reactions. */
const PANEL = "rounded-[11px] border border-message-border bg-background shadow-[0_1px_3px_#0000001a]";

/** An item of More actions: its icon, as the bar draws it, then its name, the panel's whole width. */
const ITEM =
  "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-[6px] px-2 text-left text-sm whitespace-nowrap text-message-ink transition-colors duration-150 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground touch:h-11 [&_svg]:size-4 [&_svg]:shrink-0";

interface Props {
  message: Message;
  /** What the message shows, which Quote quotes. */
  nodes: DisplayNode[];
  /** The message's row: hovering it opens the bar with a mouse, and the bar overlaps its top edge. */
  row: RefObject<HTMLElement | null>;
  /** Whether the message follows on from the one before, rather than starting a run, whose row has 4px more above it. */
  threaded: boolean;
  /** Whether Edit and Delete message show: on your own messages, and on everyone's for administrators. */
  editable: boolean;
  /**
   * The address Reply in thread opens: the message's thread, or its parent's for a reply. Left out in a
   * thread, whose own composer is there to reply in.
   */
  threadPath?: string;
  onReact: (emoji: string) => void;
  /** Writes a reply in the composer, given the quote it starts with. */
  onQuote: (quote: string) => void;
  onEdit: () => void;
  /** Deletes the message, from More actions, answering whether the deletion was sent. */
  onDelete: () => boolean;
  /** Opens the message's Custom reaction form, from New boost. */
  onNewBoost: () => void;
  ref?: Ref<MessageActionsHandle>;
}

export interface MessageActionsHandle {
  /**
   * Opens the bar with More reactions showing and focuses the first of them, as Add a boost does.
   * Clicking `from` again leaves the bar open, and Escape hands focus back to it.
   */
  openReactions: (from: HTMLElement) => void;
  /** Focuses Message options, as sending a reaction does. */
  focus: () => void;
}

/**
 * The message actions: Message options, which opens a bar of three quick reactions, More reactions, whose
 * tray holds the other reactions and New boost, Reply in thread, a file message's Download, and Edit, in the
 * order Slack's bar has them. With a mouse, hovering the message opens the bar too, laid over the message's
 * top edge at the timeline's right, with Message options pinned as its last button, and each button names
 * itself in a tooltip as the pointer reaches it. On touch screens it opens beside Message options, with
 * Quote after Reply in thread and Copy link after that. Once opened, the bar stays in the page while it's
 * shut, so Copy link keeps its color.
 *
 * With a mouse, Message options then opens More actions under the bar, as Slack's does: Quote, Copy text,
 * Copy link, and on messages you can change, Edit message and Delete message.
 */
export function MessageActionsMenu({ message, nodes, row, threaded, editable, threadPath, onReact, onQuote, onEdit, onDelete, onNewBoost, ref }: Props) {
  const [open, setOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  // Whether hovering opened the bar, which leaving then closes, unless Message options pinned it.
  const hoverOpened = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The Add a boost that opened the bar, if one did and More actions hasn't opened since.
  const boostTrigger = useRef<HTMLElement | null>(null);
  // Whether the tray's first reaction is still to be focused, as Add a boost or More reactions opens it.
  const focusingTray = useRef(false);
  // Whether More actions' first item is still to be focused, as it opens.
  const focusingActions = useRef(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const tray = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const actionsPanel = useRef<HTMLDivElement>(null);
  const overlapping = useMediaQuery(OVERLAPPING);
  const menuId = useId();
  const trayId = useId();
  // What Copy text copies: the message's plain text, which holds a bot's cards' too. A file message has none
  // but its file's name, and a huddle's message none that it shows.
  const text = message.attachment || message.huddle ? null : message.plainText;

  const show = (byHovering: boolean) => {
    hoverOpened.current = byHovering;
    setRendered(true);
    setOpen(true);
  };

  const close = () => {
    clearTimeout(leaveTimer.current);
    hoverOpened.current = false;
    boostTrigger.current = null;
    setOpen(false);
    setTrayOpen(false);
    setActionsOpen(false);
  };

  // The bar closes once a reaction is sent, handing focus to Message options.
  const closeAfterReacting = () => {
    close();
    trigger.current?.focus({ preventScroll: true });
  };

  const react = (emoji: string) => {
    onReact(emoji);
    closeAfterReacting();
  };

  // Quote and Edit close the bar too, as their `message-actions#close` does, and take focus themselves, as
  // the thread Reply in thread opens does.
  const quote = (quoted: string) => {
    close();
    onQuote(quoted);
  };

  const edit = () => {
    close();
    onEdit();
  };

  // New boost closes the bar too, and the form it opens takes focus.
  const newBoost = () => {
    close();
    onNewBoost();
  };

  // Delete message asks first, as the editor's does. The composer takes focus as the message goes, or Message
  // options does where the deletion can't be sent.
  const deleteMessage = () => {
    if (!confirm("Are you sure you want to delete this message?")) return;
    close();
    if (!onDelete()) trigger.current?.focus({ preventScroll: true });
  };

  const focusFirstReaction = () => {
    focusingTray.current = false;
    tray.current?.querySelector("button")?.focus({ preventScroll: true });
  };

  const focusFirstAction = () => {
    focusingActions.current = false;
    actionsPanel.current?.querySelector("button")?.focus({ preventScroll: true });
  };

  // The tray and More actions open in the same place, under the bar, so one shuts as the other opens. The
  // tray's first reaction takes focus as it opens, as More actions' first item does, since Tab from More
  // reactions reaches the rest of the bar first.
  const toggleTray = () => {
    focusingTray.current = !trayOpen;
    setActionsOpen(false);
    setTrayOpen(!trayOpen);
  };

  // Opening More actions keeps the bar open and makes it Message options' bar, so Escape shuts More
  // actions first even where Add a boost opened the bar.
  const toggleActions = () => {
    clearTimeout(leaveTimer.current);
    hoverOpened.current = false;
    boostTrigger.current = null;
    focusingActions.current = !actionsOpen;
    setTrayOpen(false);
    setActionsOpen(!actionsOpen);
  };

  useImperativeHandle(ref, () => ({
    // As the controller's click on `.message__boost-inline .boost__action` does.
    openReactions: (from) => {
      clearTimeout(leaveTimer.current);
      hoverOpened.current = false;
      boostTrigger.current = from;
      focusingTray.current = true;
      setRendered(true);
      setOpen(true);
      setActionsOpen(false);
      setTrayOpen(true);
      // An open bar with its tray showing doesn't render again, so its reaction is focused here.
      if (open && trayOpen) focusFirstReaction();
    },
    focus: () => trigger.current?.focus({ preventScroll: true }),
  }));

  const toggle = () => {
    if (!open) return show(false);
    // With a mouse, Message options is the open bar's last button, and opens More actions.
    if (overlapping) return toggleActions();
    close();
  };

  const place = () => {
    // The bar can leave the page, with its message or as the message's editor opens, a moment before what
    // watches the page for it stops.
    if (!open || !container.current) return;
    // Add a boost goes if the message's last reaction does while the bar is open.
    const anchor = boostTrigger.current?.isConnected ? boostTrigger.current : trigger.current!;
    const panel = actionsOpen ? actionsPanel.current! : tray.current!;
    if (!placeMenu({ row: row.current!, container: container.current, trigger: trigger.current!, anchor, menu: menu.current!, bar: bar.current!, panel, overlapping })) close();
  };

  const hovered = useEffectEvent((event: PointerEvent) => {
    if (event.pointerType === "touch" || !matchMedia(OVERLAPPING).matches) return;
    clearTimeout(leaveTimer.current);
    if (!open) show(true);
  });

  const left = useEffectEvent(() => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      if (hoverOpened.current && !container.current?.matches(":focus-within") && !row.current?.matches(":hover")) close();
    }, LEAVE_DELAY_MS);
  });

  useEffect(() => {
    const element = row.current!;
    const enter = (event: PointerEvent) => hovered(event);
    const leave = () => left();
    element.addEventListener("pointerenter", enter);
    element.addEventListener("pointerleave", leave);
    // The bar comes back as its message's editor shuts, maybe under a pointer that never left the message
    // and so won't enter it, so the pointer's first move over the message opens it too.
    element.addEventListener("pointermove", enter, { once: true });
    return () => {
      element.removeEventListener("pointerenter", enter);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("pointermove", enter);
      clearTimeout(leaveTimer.current);
    };
  }, [row]);

  const clickedElsewhere = useEffectEvent((event: Event) => {
    const target = event.target as Node;
    if (!container.current?.contains(target) && !boostTrigger.current?.contains(target)) close();
  });

  // Focus leaving the bar closes it, rather than focus landing anywhere else, which would shut a bar the
  // pointer opened as the composer, ready a moment after the messages show, takes focus.
  const focusLeft = useEffectEvent((event: FocusEvent) => {
    if (event.relatedTarget && !container.current?.contains(event.relatedTarget as Node)) close();
  });

  // Escape closes a bar Add a boost opened, handing focus back to it. Otherwise it closes the tray first,
  // handing focus to More reactions, or More actions, handing it to Message options, then the bar, handing
  // it to Message options. While you're elsewhere, as in the composer under a bar the pointer opened, it
  // only closes the bar.
  const keyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const from = boostTrigger.current;
    if (from) {
      event.preventDefault();
      close();
      return (from.isConnected ? from : trigger.current)?.focus({ preventScroll: true });
    }
    if (!container.current?.contains(document.activeElement)) return close();
    event.preventDefault();
    if (trayOpen) {
      setTrayOpen(false);
      more.current?.focus({ preventScroll: true });
    } else if (actionsOpen) {
      setActionsOpen(false);
      trigger.current?.focus({ preventScroll: true });
    } else {
      close();
      trigger.current?.focus({ preventScroll: true });
    }
  });

  const moved = useEffectEvent(() => place());
  const closedElsewhere = useEffectEvent(() => close());

  // Only the open bar watches the page: a click or Escape elsewhere, focus leaving it, and anything that moves it.
  useEffect(() => {
    if (!open) return;
    const self = { close: () => closedElsewhere() };
    openBar?.close();
    openBar = self;
    const events = new AbortController();
    const options = { signal: events.signal };
    document.addEventListener("click", (event) => clickedElsewhere(event), options);
    container.current!.addEventListener("focusout", (event) => focusLeft(event), options);
    document.addEventListener("keydown", (event) => keyDown(event), options);
    document.addEventListener("scroll", () => moved(), { ...options, capture: true, passive: true });
    window.addEventListener("resize", () => moved(), options);
    window.visualViewport?.addEventListener("resize", () => moved(), options);
    const resized = new ResizeObserver(() => moved());
    resized.observe(menu.current!);
    // Messages above can change or go without anything scrolling, as when someone reacts to one, moving the row.
    const changed = new MutationObserver(() => moved());
    const timeline = row.current!.closest('[role="log"]');
    if (timeline) changed.observe(timeline, { childList: true, characterData: true, subtree: true });
    return () => {
      if (openBar === self) openBar = null;
      events.abort();
      resized.disconnect();
      changed.disconnect();
    };
  }, [open]);

  // Placed before it's painted, and again as the tray or More actions opens or shuts.
  useLayoutEffect(() => {
    place();
    if (open && trayOpen && focusingTray.current) focusFirstReaction();
    if (open && actionsOpen && focusingActions.current) focusFirstAction();
  }, [open, trayOpen, actionsOpen, overlapping]);

  const pinned = open && overlapping;

  const options = (
    <button
      ref={trigger}
      type="button"
      aria-label="Message options"
      aria-expanded={open}
      aria-controls={rendered ? menuId : undefined}
      onClick={toggle}
      className={cn(
        "flex size-8 cursor-pointer items-center justify-center rounded-[9px] text-[0.8rem] font-medium text-message-muted hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground touch:size-11 [&_svg]:size-4",
        // Campfire's messages.css: hidden until the message is hovered or holds focus, fading in after a
        // moment with a mouse, and half shown for fingers.
        "opacity-0 touch:opacity-50 group-hover/message:opacity-100! group-focus-within/message:opacity-100! aria-expanded:opacity-100!",
        "[@media(hover:hover)_and_(pointer:fine)]:transition-opacity [@media(hover:hover)_and_(pointer:fine)]:delay-150 [@media(hover:hover)_and_(pointer:fine)]:duration-150 [@media(hover:hover)_and_(pointer:fine)]:ease-in-out",
        // Message options: at the top right of the message's text, 6px further out for fingers, so 4px
        // lower on a run's first message, whose text starts 4px lower in its row. With a mouse, the open bar
        // keeps room for it as its last button, which stays shaded while More actions is open, as More
        // reactions does while its tray is.
        pinned
          ? "fixed top-(--trigger-top) left-(--trigger-left) z-31"
          : cn("absolute right-5 max-md:right-3 touch:translate-x-1.5", threaded ? "-top-1.5 touch:-top-[11px]" : "-top-0.5 touch:-top-[7px]"),
        pinned && actionsOpen && "bg-hover",
      )}
    >
      <MoreHoriz />
    </button>
  );

  return (
    <div ref={container} className="contents">
      {/* Every message has Message options, so only a mouse, which can show its tooltip, gets one. As the bar's
          last button, the tooltip says what it opens. */}
      {overlapping ? <ActionTooltip label={pinned ? "More actions" : "Message options"}>{options}</ActionTooltip> : options}
      {rendered && (
        <div
          ref={menu}
          id={menuId}
          role="group"
          aria-label="Message actions"
          hidden={!open}
          onPointerEnter={() => clearTimeout(leaveTimer.current)}
          onPointerLeave={() => left()}
          className="group/menu fixed z-30 grid w-max min-w-0 gap-[7px]"
        >
          <div
            ref={bar}
            className={cn(
              PANEL,
              "flex flex-wrap items-center p-1 group-data-[two-rows]/menu:grid group-data-[two-rows]/menu:grid-cols-[repeat(4,auto)] group-data-[two-rows]/menu:justify-self-end",
              overlapping && "pr-9 touch:pr-12",
            )}
          >
            <div role="group" aria-label="Quick reactions" className="flex flex-wrap group-data-[two-rows]/menu:col-span-3">
              {REACTIONS.slice(0, QUICK_REACTION_COUNT).map(([emoji, title]) => (
                <Reaction key={emoji} emoji={emoji} title={title} onClick={() => react(emoji)} />
              ))}
            </div>
            <ActionTooltip label="More reactions">
              <button
                ref={more}
                type="button"
                aria-label="More reactions"
                aria-expanded={trayOpen}
                aria-controls={trayId}
                className={cn(ACTION, "aria-expanded:bg-hover")}
                onClick={toggleTray}
              >
                <Emoji />
              </button>
            </ActionTooltip>
            {threadPath !== undefined && (
              <ActionTooltip label="Reply in thread">
                <PageLink href={threadPath} aria-label="Reply in thread" className={ACTION} onClick={close}>
                  <MessageText />
                </PageLink>
              </ActionTooltip>
            )}
            {/* More actions holds Quote and Copy link with a mouse. A huddle's message has nothing of its author's to quote. */}
            {message.attachment ? (
              <FileActions file={message.attachment} />
            ) : (
              !overlapping &&
              !message.huddle && (
                <ActionTooltip label="Quote">
                  <QuoteButton message={message} nodes={nodes} aria-label="Quote" className={ACTION} onQuote={quote}>
                    <QuoteMessage />
                  </QuoteButton>
                </ActionTooltip>
              )
            )}
            {!overlapping && (
              <ActionTooltip label="Copy link">
                <button type="button" aria-label="Copy link" className={ACTION} onClick={(event) => void copyLink(event, message)}>
                  <Copy />
                </button>
              </ActionTooltip>
            )}
            {/* As Campfire's `.message__edit-btn` shows (messages.css). */}
            {editable && (
              <ActionTooltip label="Edit">
                <button type="button" aria-label="Edit" className={ACTION} onClick={edit}>
                  <Edit />
                </button>
              </ActionTooltip>
            )}
          </div>
          <div
            ref={tray}
            id={trayId}
            role="group"
            aria-label="More reactions"
            hidden={!trayOpen}
            className={cn(PANEL, "w-max max-w-full justify-self-end overflow-y-auto overscroll-contain p-2 group-data-[panel-above]/menu:-order-1")}
          >
            <span className="mx-[3px] mb-[5px] block text-[11px] leading-normal font-medium text-muted-foreground">More reactions</span>
            <div className="flex flex-wrap">
              {REACTIONS.slice(QUICK_REACTION_COUNT).map(([emoji, title]) => (
                <Reaction key={emoji} emoji={emoji} title={title} onClick={() => react(emoji)} />
              ))}
              <ActionTooltip label="New boost">
                <button type="button" className={ACTION} onClick={newBoost}>
                  <ChatPlusIn />
                  <span className="sr-only">New boost</span>
                </button>
              </ActionTooltip>
            </div>
          </div>
          <div
            ref={actionsPanel}
            role="group"
            aria-label="More actions"
            hidden={!actionsOpen}
            className={cn(PANEL, "w-max max-w-full justify-self-end overflow-y-auto overscroll-contain p-1 group-data-[panel-above]/menu:-order-1")}
          >
            {/* Quoting a file message would quote nothing, as its text is empty, and a huddle's message shows none of its own. */}
            {!message.attachment && !message.huddle && (
              <QuoteButton message={message} nodes={nodes} className={ITEM} onQuote={quote}>
                <QuoteMessage />
                Quote
              </QuoteButton>
            )}
            {text !== null && (
              <button type="button" className={ITEM} onClick={(event) => void copyWithSuccess(event.currentTarget, text)}>
                <Copy />
                Copy text
              </button>
            )}
            <button type="button" className={ITEM} onClick={(event) => void copyLink(event, message)}>
              <Copy />
              Copy link
            </button>
            {editable && (
              <>
                <hr className="my-1 border-message-border" />
                {/* The text of a file message, of a bot's cards or of a huddle's message can't be changed, so only the bar's Edit opens their editor. */}
                {!message.attachment && !message.cards && !message.huddle && (
                  <button type="button" className={ITEM} onClick={edit}>
                    <Edit />
                    Edit message
                  </button>
                )}
                <button type="button" className={cn(ITEM, "text-negative")} onClick={deleteMessage}>
                  <Trash />
                  Delete message
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Names one of the bar's buttons, or the tray's, in a tooltip the moment the pointer reaches it, where a
 * `title` took a second or so. It shuts as the pointer leaves, so the pointer can't rest on it outside the
 * message, which would shut the bar under it. Focus doesn't open it, as it didn't show a `title`, since an
 * open tooltip takes the Escape that shuts the tray, More actions and the bar.
 */
function ActionTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild onFocus={(event) => event.preventDefault()}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** One of the reactions: the emoji, named by its title. */
function Reaction({ emoji, title, onClick }: { emoji: string; title: string; onClick: () => void }) {
  return (
    <ActionTooltip label={title}>
      <button type="button" className={ACTION} onClick={onClick}>
        <span aria-hidden className="text-[1.3rem] leading-normal">
          {emoji}
        </span>
        <span className="sr-only">{title}</span>
      </button>
    </ActionTooltip>
  );
}

/**
 * A file message's Download and Share, in Quote's place.
 * Download is hidden in Ember added to an iPhone's or iPad's home screen, as the file's card hides it, and
 * Share shows where the browser can share, sharing the file titled with its name.
 */
function FileActions({ file }: { file: StoredFile }) {
  return (
    <>
      <ActionTooltip label="Download">
        <a href={file.downloadUrl} aria-label="Download" className={cn(ACTION, "ios-pwa:hidden")}>
          <Download />
        </a>
      </ActionTooltip>
      {canShare() && (
        <ActionTooltip label="Share">
          <ShareButton url={file.url} sharedTitle={file.name} aria-label="Share" className={ACTION}>
            <ShareAndroid />
          </ShareButton>
        </ActionTooltip>
      )}
    </>
  );
}

interface QuoteButtonProps extends ComponentProps<"button"> {
  message: Message;
  nodes: DisplayNode[];
  onQuote: (quote: string) => void;
}

/**
 * Quote, which writes a reply quoting the message in the composer. It reads the people directory only
 * while the bar's in the page, so a change to the directory doesn't render every message's actions again.
 * As a tooltip's trigger, it's handed the tooltip's `onClick`, which a click calls first.
 */
function QuoteButton({ message, nodes, onQuote, onClick, ...props }: QuoteButtonProps) {
  const people = useContext(PeopleContext);
  const nameOf = useNameOf();
  const quote = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    const link = new URL(permalinkOf(message), document.baseURI).href;
    const mentioned = (userId: string) => mentionedPerson(people, message.mentions, userId)?.name ?? UNKNOWN_PERSON;
    onQuote(replyQuote(nodes, nameOf(message.creator), link, mentioned));
  };
  return <button type="button" onClick={quote} {...props} />;
}

/** Copies the message's address, as Copy link does. Pages carry only the path, made absolute against the page. */
function copyLink(event: MouseEvent<HTMLButtonElement>, message: Message) {
  return copyWithSuccess(event.currentTarget, new URL(permalinkOf(message), document.baseURI).href);
}

/** The top of the highest of `row`'s Copy code buttons between `left` and `right`, or Infinity. */
function copyCodeTop(row: HTMLElement, left: number, right: number): number {
  let top = Infinity;
  for (const button of row.querySelectorAll(COPY_CODE)) {
    const box = button.getBoundingClientRect();
    if (box.left < right && box.right > left) top = Math.min(top, box.top);
  }
  return top;
}

interface Placed {
  row: HTMLElement;
  container: HTMLElement;
  trigger: HTMLElement;
  /** What the bar opens beside for fingers: Message options, or Add a boost when that opened it. */
  anchor: HTMLElement;
  menu: HTMLElement;
  bar: HTMLElement;
  /** What opens under the bar, or over it: More actions while it's open, or else the tray of more reactions. */
  panel: HTMLElement;
  overlapping: boolean;
}

/**
 * Places an open bar within the timeline less 8px on each side, and within what's on screen. With a
 * mouse, it overlaps the row, its top 17px above the row's, or higher to keep clear of a code block's
 * Copy code, and its right 16px in from the timeline's,
 * with Message options pinned as its last button, and the tray or More actions opens below it, or above
 * when there's more room there. For fingers, it opens 6px below its anchor, lined up with its right
 * edge, or above when it doesn't fit, or beside it when it fits neither, so it doesn't cover what opened
 * it, nor Message options. Its buttons then go in two rows of four, where a row of them would wrap or
 * doesn't fit beside its anchor. Answers false, placing nothing, once the row is out of the timeline's
 * sight, when the bar should close.
 */
function placeMenu({ row, container, trigger, anchor, menu, bar, panel, overlapping }: Placed): boolean {
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop || 0;
  const left = viewport?.offsetLeft || 0;
  const width = viewport?.width || window.innerWidth;
  const height = viewport?.height || window.innerHeight;
  const timeline = row.closest('[role="log"]')?.getBoundingClientRect();
  const bounds = {
    left: Math.max(left, timeline?.left ?? left) + 8,
    right: Math.min(left + width, timeline?.right ?? left + width) - 8,
    top: Math.max(top, timeline?.top ?? top) + 8,
    bottom: Math.min(top + height, timeline?.bottom ?? top + height) - 8,
  };
  const triggerBox = trigger.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  if (rowBox.bottom < bounds.top || rowBox.top > bounds.bottom) return false;
  menu.style.maxWidth = `${Math.max(0, bounds.right - bounds.left)}px`;
  menu.removeAttribute("data-two-rows");
  panel.style.maxHeight = "";
  let menuBox = menu.getBoundingClientRect();
  let y: number;
  let right: number;
  let barTop = 0;
  let barHeight = 0;
  if (overlapping) {
    barHeight = bar.getBoundingClientRect().height;
    // Overlapping the row by more than half the bar leaves the pointer a way across to it. Over a code
    // block's Copy code, as at the top of a follow-up, it sits on the block's edge instead.
    const copyCode = copyCodeTop(row, Math.max(bounds.left, bounds.right - 8 - menuBox.width), bounds.right - 8);
    barTop = Math.max(bounds.top, Math.min(rowBox.top - 17, copyCode - 6 - barHeight, bounds.bottom - barHeight));
    const below = bounds.bottom - barTop - barHeight;
    const above = barTop - bounds.top;
    const panelAbove = !panel.hidden && menuBox.height - barHeight > below && above > below;
    menu.toggleAttribute("data-panel-above", panelAbove);
    if (!panel.hidden) {
      panel.style.maxHeight = `${Math.max(0, (panelAbove ? above : below) - 7)}px`;
      menuBox = menu.getBoundingClientRect();
    }
    // Opening the tray or More actions mustn't move the bar off its row or out from under the pointer.
    y = panelAbove ? barTop - (menuBox.height - barHeight) : barTop;
    right = bounds.right - 8;
  } else {
    menu.removeAttribute("data-panel-above");
    const anchorBox = anchor.getBoundingClientRect();
    // Beside Add a boost, it keeps clear of Message options at the message's right too.
    const rightmost = anchor === trigger ? bounds.right : Math.min(bounds.right, triggerBox.left - 6);
    const spotFor = ({ width, height }: DOMRect) => {
      const below = anchorBox.bottom + 6;
      const above = anchorBox.top - height - 6;
      if (below + height <= bounds.bottom) return { y: below, right: anchorBox.right, fits: true };
      if (above >= bounds.top) return { y: above, right: anchorBox.right, fits: true };
      // With room neither below nor above, as on a phone held sideways with the tray open, it opens to the
      // left of its anchor, clear of Message options, or to its right where only that has room.
      const roomLeft = anchorBox.left - 6 - bounds.left >= width;
      const roomRight = rightmost - anchorBox.right - 6 >= width;
      return {
        y: Math.max(bounds.top, Math.min(anchorBox.top, bounds.bottom - height)),
        right: roomRight && !roomLeft ? anchorBox.right + 6 + width : anchorBox.left - 6,
        fits: roomLeft || roomRight,
      };
    };
    let spot = spotFor(menuBox);
    const [first, last] = [bar.firstElementChild as HTMLElement, bar.lastElementChild as HTMLElement];
    if (!spot.fits || last.offsetTop > first.offsetTop) {
      menu.setAttribute("data-two-rows", "");
      menuBox = menu.getBoundingClientRect();
      spot = spotFor(menuBox);
    }
    ({ y, right } = spot);
  }
  const x = Math.max(bounds.left, Math.min(right - menuBox.width, bounds.right - menuBox.width));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  if (overlapping) {
    // Inside the bar's border and padding, at its right end.
    container.style.setProperty("--trigger-left", `${x + menuBox.width - 5 - triggerBox.width}px`);
    container.style.setProperty("--trigger-top", `${barTop + (barHeight - triggerBox.height) / 2}px`);
  }
  return true;
}
