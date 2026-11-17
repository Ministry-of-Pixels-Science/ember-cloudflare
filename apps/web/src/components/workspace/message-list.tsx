import { startTransition, useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { joinsWithLink, type Invitation, type Me } from "@ember/protocol";
import { ArrowDown } from "@/components/icons/iconoir";
import { useAccount } from "@/hooks/use-account";
import { RefusedUnboosts, RoomConnection } from "@/hooks/use-room";
import { ScrollIntoViewContext } from "@/hooks/use-scroll-into-view";
import { dropTarget } from "@/lib/drop-target";
import { dateLabel, dateTimeLabel, timeline } from "@/lib/messages";
import type { Focus, RoomState } from "@/lib/room-state";
import { cn } from "@/lib/utils";
import { InvitationCard } from "./invitation-card";
import { MessageItem, type MessageActions, type MessageEditors, type ThreadPlace } from "./message-item";

/**
 * How near the end of the room's messages a reader can be and still be at it, which keeps them there as
 * new ones come.
 */
const AT_END_PX = 100;
/** How near the view an end of the timeline comes before the page beyond it loads. */
const PAGE_AHEAD_PX = 200;
/**
 * How many of its newest messages a page that fills an empty timeline, as a room's first page does, shows
 * before the rest: more than a phone's view holds, so the rest go in above them, out of sight, once they're
 * on screen. Drawing a whole page at once is most of what opening a room waits on.
 */
const FIRST_DRAWN = 15;

/**
 * Campfire's `.message.search-highlight` (messages.css): the message a permalink goes to is outlined in
 * the ink for a second, then the outline fades over half a second. Drawn as an outline rather than a
 * border, so the message doesn't move, and run apart from its CSS, so a mention's wiggle still plays.
 */
const OUTLINE: Keyframe[] = [
  { outline: "2px solid var(--foreground)" },
  { outline: "2px solid var(--foreground)", offset: 2 / 3 },
  { outline: "2px solid transparent" },
];
const OUTLINE_MS = 1_500;

/** Where the reader is: a message's row, and how far its bottom is from the view's. */
interface Place {
  row: string;
  offset: number;
}

const rowsIn = (scroller: HTMLElement) => [...scroller.querySelectorAll<HTMLElement>("[data-row]")];

/**
 * Where the reader is in the timeline: the last message that starts above the view's bottom. Keeping it
 * where it is moves what's above it instead, which keeps the place of someone reading as older messages
 * come in above or the oldest are cut, or as a message above the view's bottom grows with an edit or a
 * boost.
 */
function placeIn(scroller: HTMLElement): Place | null {
  const rows = rowsIn(scroller);
  const bottom = scroller.getBoundingClientRect().bottom;
  let [low, high] = [0, rows.length - 1];
  let found: HTMLElement | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rows[middle]!.getBoundingClientRect().top < bottom) [found, low] = [rows[middle], middle + 1];
    else high = middle - 1;
  }
  return found ? { row: found.dataset.row!, offset: bottom - found.getBoundingClientRect().bottom } : null;
}

/** Scrolls the timeline so the reader is at `place` again, if its message is still there and has moved. */
function restore(scroller: HTMLElement, { row, offset }: Place) {
  const element = rowsIn(scroller).find((r) => r.dataset.row === row);
  if (!element) return;
  const moved = offset - (scroller.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom);
  // Setting where the timeline is scrolled to stops a smooth scroll, as an editor's to the middle, even to where it is.
  if (moved !== 0) scroller.scrollTop += moved;
}

/**
 * The day separator: a heading over the first message of a day, with the day's date written out and, on
 * hover, the message's date and time.
 */
function DaySeparator({ at }: { at: string }) {
  const date = new Date(at);
  return (
    <h2 className="mt-[13px] mb-6 flex items-center gap-3 text-sm leading-5 font-bold text-message-ink before:flex-1 before:border-t before:border-message-divider after:flex-1 after:border-t after:border-message-divider max-md:mb-[18px] max-md:gap-2">
      <time dateTime={at} title={dateTimeLabel(date)} className="rounded-[14px] border border-message-border bg-background px-4 py-[3px]">
        {dateLabel(date)}
      </time>
    </h2>
  );
}

/**
 * The New line, over the first message that came while the room was marked unread: in the negative red,
 * with its word at the end.
 */
function NewSeparator() {
  return (
    <div
      role="separator"
      aria-label="New messages"
      className="mb-1.5 flex items-center gap-2 text-xs leading-4 font-bold text-negative before:flex-1 before:border-t before:border-negative"
    >
      <span aria-hidden="true">New</span>
    </div>
  );
}

interface Props {
  /** The room's name as the reader reads it, which a DM's names the others in it. */
  roomName: string;
  /** Whether the room is a DM, which a timeline is "with" rather than "in". */
  direct?: boolean;
  /** The welcome card's invitation, when this is the room it's in. */
  invitation: Invitation | null;
  /** Dismisses the welcome card for good, settling once it's gone, or failed to go. */
  onDismissInvitation: () => Promise<void>;
  state: RoomState;
  me: Me;
  /** What can be done to the messages, or null for a room that's gone, whose messages stay as they are. */
  actions: MessageActions | null;
  /** The messages whose editors are open. */
  editing: ReadonlySet<string>;
  editors: MessageEditors;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  /** Goes to the newest messages, answering whether it could, which it can't while the room is away and they aren't loaded. */
  onJumpToNewest: () => boolean;
  /** Files dropped on the messages, which go to the composer. */
  onDropFiles?: (files: FileList) => void;
  /**
   * A thread's message, which its replies, the timeline's messages, show under, in a panel beside its room.
   * The room's welcome doesn't show there.
   */
  thread?: { header: ReactNode; place: ThreadPlace };
  /** The message whose thread is open beside the room. */
  openThread?: string;
  /**
   * When the room was marked unread as of, as it was opened: the first message from someone else that came
   * since gets the New line, unless the messages loaded may not reach back to it.
   */
  newSince?: string | null;
}

/**
 * The scrolling timeline. At the end of the room's messages, it stays there as new ones come. Anywhere
 * else, it keeps the reader's place, loads the pages before and after as they near either end, and
 * offers Jump to newest message when new ones come.
 */
export function MessageList({ roomName, direct = false, invitation, onDismissInvitation, state, me, actions, editing, editors, onLoadOlder, onLoadNewer, onJumpToNewest, onDropFiles = () => {}, thread, openThread, newSince = null }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const place = useRef<Place | null>(null);
  // How many messages have something open in them that scrolls itself into view, as an editor.
  const open = useRef(0);
  const viewHeight = useRef(0);
  const viewWidth = useRef(0);
  // The timeline's scroll height when it last settled, which differs while a resize waits for the resize observer.
  const settledHeight = useRef(0);
  const focused = useRef<Focus | null>(null);
  const arrivals = useRef(state.arrivals);
  // Whether new messages have come that the reader isn't at the end to see.
  const [behind, setBehind] = useState(false);
  // Whether the timeline has drawn every message it holds: until it has, a page that fills it shows its newest
  // messages first, unless it's a permalink's, whose message goes in the middle.
  const [drawnAll, setDrawnAll] = useState(false);
  const items = timeline(state.messages);
  const newestFirst = !drawnAll && !state.focus?.messageId && items.length > FIRST_DRAWN;
  const firstNew = newSince === null ? -1 : items.findIndex(({ message }) => message.createdAt >= newSince && message.creator.id !== me.id);
  // A page that doesn't reach back before `newSince` may have older new messages before it that aren't loaded yet,
  // whoever wrote its first one.
  const newLineAt = firstNew === -1 || (state.hasMore && items[0]!.message.createdAt >= newSince!) ? null : items[firstNew]!.message;

  const nearEnd = (el: HTMLElement) => !state.hasNewer && el.scrollHeight - el.scrollTop - el.clientHeight <= AT_END_PX;

  // Keeps the reader at the end, or in their place, as the timeline or what it shows changes, but not as only what it
  // shows resizes while something's open in a message (`opened`). A short last page of later messages can leave them
  // at the end without scrolling them, so this asks again.
  const settle = useEffectEvent((contentResized = false) => {
    const el = scroller.current!;
    const scroll = !contentResized || open.current === 0;
    if (scroll && atEnd.current) el.scrollTop = el.scrollHeight;
    else if (scroll && place.current) restore(el, place.current);
    atEnd.current = nearEnd(el);
    if (atEnd.current) setBehind(false);
    place.current = placeIn(el);
    settledHeight.current = el.scrollHeight;
  });

  // Goes to a message, centred and outlined, as a permalink opens it, or, for none, to the end, as
  // sending and Jump to newest message go.
  const go = useEffectEvent((messageId: string | null) => {
    const el = scroller.current!;
    const row = messageId === null ? undefined : rowsIn(el).find((r) => r.dataset.messageId === messageId);
    if (row) {
      const view = el.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      el.scrollTop += box.top - view.top - (el.clientHeight - box.height) / 2;
      row.querySelector("[data-body-content]")?.animate?.(OUTLINE, OUTLINE_MS);
    } else {
      el.scrollTop = el.scrollHeight;
    }
    atEnd.current = nearEnd(el);
    place.current = placeIn(el);
    settledHeight.current = el.scrollHeight;
    setBehind(false);
  });

  // Something open in a message that scrolls itself into view, as its editor or New boost's form, grows and scrolls
  // as the browser has it: the timeline doesn't scroll as what it shows resizes until it's closed. Following the
  // end, or keeping the place of a message below it, would push it up by however much it grows, out of view, and
  // setting the scroll would stop its own to the middle of the timeline, or undo Lexxy's to its caret. New messages
  // still bring a reader near the end to them, and the timeline still keeps the reader at the end, or in their
  // place, as it resizes itself, as a window or a phone's keyboard resizes it.
  const opened = useCallback(() => {
    open.current++;
    return () => {
      open.current--;
    };
  }, []);

  useLayoutEffect(() => {
    const moved = state.focus !== focused.current;
    focused.current = state.focus;
    if (moved && state.focus) go(state.focus.messageId);
    else settle();
  }, [state.messages, state.focus, drawnAll]);

  // A page that showed its newest messages first draws the rest above them once they're on screen, or before the
  // view is painted where they don't fill it with room to spare, so that nothing shows above them meanwhile.
  useLayoutEffect(() => {
    if (drawnAll || items.length === 0) return;
    if (newestFirst && content.current!.offsetHeight >= scroller.current!.clientHeight + PAGE_AHEAD_PX) startTransition(() => setDrawnAll(true));
    else setDrawnAll(true);
  }, [drawnAll, newestFirst, items.length]);

  // When the timeline changes size, as it does when a phone's keyboard opens, or what it shows does after it's
  // drawn, the reader stays where they were.
  useEffect(() => {
    const el = scroller.current!;
    const observer = new ResizeObserver(() => {
      const contentResized = el.clientHeight === viewHeight.current && el.clientWidth === viewWidth.current;
      viewHeight.current = el.clientHeight;
      viewWidth.current = el.clientWidth;
      settle(contentResized);
    });
    observer.observe(el);
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);

  // New messages the reader can't see, away from the end, offer the way there.
  useEffect(() => {
    if (state.arrivals === arrivals.current) return;
    arrivals.current = state.arrivals;
    if (!atEnd.current) setBehind(true);
  }, [state.arrivals]);

  // What an observer saw is about the timeline it was made for: the browser can tell it after the timeline has
  // changed, as when a room's first messages come before it has looked, and the observer made for the new one
  // says whether its end is near.
  const loadOlder = useEffectEvent((shown: RoomState["messages"]) => shown === state.messages && state.hasMore && !state.loadingOlder && onLoadOlder());
  const loadNewer = useEffectEvent((shown: RoomState["messages"]) => shown === state.messages && state.hasNewer && !state.loadingNewer && onLoadNewer());
  useEffect(() => {
    // Load the page beyond either end of the timeline whenever that end comes near the view, whether by
    // scrolling, a resize, or a window tall enough to show every loaded message. Observing afresh after
    // each change asks again while the end is still near, but a failed page changes nothing, so it waits
    // for the reader instead of retrying in a loop.
    const shown = state.messages;
    const root = scroller.current;
    // An observer can tell of more than one look at once, oldest first, as when the reader scrolls to the top
    // before it has told of the place a page kept them in, so the last says where the end is now.
    const older = new IntersectionObserver((entries) => entries.at(-1)?.isIntersecting && loadOlder(shown), { root, rootMargin: `${PAGE_AHEAD_PX}px 0px 0px 0px` });
    const newer = new IntersectionObserver((entries) => entries.at(-1)?.isIntersecting && loadNewer(shown), { root, rootMargin: `0px 0px ${PAGE_AHEAD_PX}px 0px` });
    older.observe(top.current!);
    newer.observe(bottom.current!);
    return () => {
      older.disconnect();
      newer.disconnect();
    };
  }, [state.messages]);

  const onScroll = () => {
    const el = scroller.current!;
    // A resize scrolls the timeline to keep its end in view for a reader at it, and that scroll can arrive once
    // the timeline has resized again, before the resize observer has caught up, leaving them at the end of the
    // view as it was. What it shows can resize before the resize observer has caught up, too, as a message does
    // when its file's text loads, and the browser scroll it on its own then, as Chrome's scroll anchoring does to
    // put back what was in view before the end moved up. Either way they didn't move, so they're still at the
    // end. Any other scroll is the reader's, even one that comes as the timeline resizes, as it does while the
    // composer's editor loads.
    const resizing = el.scrollHeight !== settledHeight.current;
    const stillAtEnd = atEnd.current && !state.hasNewer && (resizing || el.scrollHeight - el.scrollTop - viewHeight.current <= 1);
    atEnd.current = nearEnd(el) || stillAtEnd;
    if (atEnd.current) setBehind(false);
    place.current = placeIn(el);
  };

  // The card shows in its room while the room is new, and it's the room's welcome, but only to the
  // administrators who haven't dismissed it, who alone are given the invitation, and only while its join
  // link lets people in: not once an administrator turns it off, or Memberful is members only.
  const linkJoins = joinsWithLink(useAccount());
  const welcomeCard = invitation !== null && state.paged === false && linkJoins;
  // Until the room lets the socket in, which brings its messages afresh. The timeline is busy then, and while it
  // draws a page newest first, so screen readers read the page once it's whole.
  const waiting = state.status === "connecting" || state.status === "reconnecting";

  return (
    <div className="min-h-0 flex-1" {...dropTarget(onDropFiles)}>
      {/* `isolate` keeps the message controls' z-indexes inside the timeline, so Jump to newest message
          below stays above them. */}
      <div
        ref={scroller}
        onScroll={onScroll}
        className={cn(
          "isolate h-full overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable]",
          thread ? "pt-[18px] pb-3" : "pt-[26px] pb-[18px] max-md:pt-[18px] max-md:pb-3",
        )}
        role="log"
        aria-live="polite"
        aria-label={thread ? "Thread" : `Messages ${direct ? "with" : "in"} ${roomName}`}
        aria-busy={waiting || newestFirst || undefined}
      >
        <div ref={content}>
          <RoomConnection value={state.connections}>
            <RefusedUnboosts value={state.refusedUnboosts}>
              <ScrollIntoViewContext value={opened}>
                {thread?.header}
                <div ref={top} aria-hidden className="h-px" />
                {state.loadingOlder && <p className="py-2 text-center text-xs text-muted-foreground">Loading earlier messages…</p>}

                {welcomeCard && <InvitationCard joinCode={invitation.joinCode} onDismiss={onDismissInvitation} />}

                {!thread && state.status === "open" && items.length === 0 && !state.hasMore && !state.hasNewer && !welcomeCard && (
                  <div className="p-6 text-center text-muted-foreground">
                    <h2 className="mb-1.5 text-xl text-foreground">{direct ? roomName : `Welcome to #${roomName}`}</h2>
                    <p>{direct ? "This is the very beginning of your direct messages." : "This is the very beginning of the room. Say hello!"}</p>
                  </div>
                )}

                {(newestFirst ? items.slice(-FIRST_DRAWN) : items).map(({ message, firstOfDay, threaded }) => {
                  // Stable from optimistic copy to stored message, and distinct across senders.
                  const key = `${message.creator.id}:${message.clientMessageId}`;
                  return (
                    <div key={key} data-row={key} data-message-id={message.id}>
                      {/* A thread's replies start under its message, without a day's heading between them. */}
                      {firstOfDay && (!thread || message !== items[0]!.message) && <DaySeparator at={message.createdAt} />}
                      {message === newLineAt && <NewSeparator />}
                      <MessageItem
                        message={message}
                        me={me}
                        threaded={threaded}
                        editing={editing.has(message.id)}
                        actions={actions}
                        editors={editors}
                        thread={thread?.place}
                        open={message.id === openThread}
                      />
                    </div>
                  );
                })}
              </ScrollIntoViewContext>
            </RefusedUnboosts>
          </RoomConnection>
          <div ref={bottom} aria-hidden className="h-px" />
        </div>
      </div>

      {/* 160px above the bottom of the main content, which holds the composer too. */}
      {behind && (
        <button
          type="button"
          // Kept to try again when it can't go yet.
          onClick={() => onJumpToNewest() && setBehind(false)}
          aria-label="Jump to newest message"
          className="absolute bottom-[160px] left-1/2 z-[3] flex size-[38px] -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border bg-background shadow-[0_3px_12px_#00000014] touch:size-11"
        >
          <ArrowDown className="size-[18px]" />
        </button>
      )}
    </div>
  );
}
