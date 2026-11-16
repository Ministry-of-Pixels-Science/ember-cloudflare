import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Room, User, UserId } from "@ember/protocol";
import { MAX_HUDDLE_INVITED } from "@ember/protocol/huddles";
import { useFlash } from "@/components/flash";
import { Search, Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useNameOf } from "@/hooks/use-directory";
import { useMounted } from "@/hooks/use-mounted";
import { fetchRoomSettings, isSignedOut } from "@/lib/api";
import { PEOPLE_PAGE, soughtName } from "@/lib/directs";
import { invitable, invitedNow } from "@/lib/huddle-people";
import { inviteToHuddle, OPEN_HUDDLE, type JoinedHuddle } from "@/lib/huddle-store";
import { byName } from "@/lib/people";
import { cn } from "@/lib/utils";
import { useJoinsNoHuddle } from "./huddle-button";
import { ON_ONE_LINE } from "./huddle-preview";
import { BUTTON, MORE_BUTTON } from "./new-direct-dialog";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE, MAIN_ACTION, OTHER_ACTION } from "./unsaved-changes";
import { UserAvatar } from "./user-avatar";

/** What Invite people says when the huddle couldn't ask its room to invite anyone, which it can't while its connection to the room is down. */
export const INVITATION_UNSENT = "Ember couldn’t send the invitation while the huddle reconnects. Try again in a moment.";

/**
 * Who's in a room, for Invite people: a direct message's people at once, as the room lists them, and a
 * shared room's as its settings do, which anyone in it may read. Those are null until they answer, and
 * "failed" once they couldn't be read, until `ask` reads them again.
 */
function useMembers(room: Room, onFailed: (error: unknown) => void) {
  const mounted = useMounted();
  const [asked, setAsked] = useState<User[] | "failed" | null>(null);
  const ask = () => {
    if (room.kind === "direct") return;
    setAsked(null);
    fetchRoomSettings(room.id).then(
      ({ people }) => mounted.current && setAsked(people.filter(({ member }) => member)),
      (error: unknown) => (isSignedOut(error) ? onFailed(error) : mounted.current && setAsked("failed")),
    );
  };
  useEffect(ask, []);
  return { members: room.kind === "direct" ? room.members : asked, ask };
}

/**
 * Puts focus back on the button that opened Invite people, or on the huddle itself when the button
 * can't take it, as one its window no longer has room for can't.
 */
function returnFocus(opener: HTMLElement) {
  opener.focus({ preventScroll: true });
  if (document.activeElement !== opener) document.getElementById(OPEN_HUDDLE)?.focus({ preventScroll: true });
}

interface Props {
  /** The huddle this tab is in, whose people aren't listed. */
  huddle: JoinedHuddle;
  /** Its room, whose people are. */
  room: Room;
  meId: UserId;
  /** The button that opened it, which has the focus back once it closes. */
  opener: HTMLElement;
  onClose: () => void;
  /** Hears that the session has ended, when that's why the room's people didn't load. */
  onFailed: (error: unknown) => void;
}

/**
 * Invite people, as a huddle in Slack has it: the people in the huddle's room who aren't in the huddle
 * and could join it, by name, to tick one or more of, and Send Invite, which has the room ring them.
 * Someone who's the only one to invite is ticked already. Past 20 of them it lists 20 at a time, under
 * a search by name, which it keeps once it has one. One invitation names as many people as a huddle
 * takes, so once that many are ticked the rest can't be.
 */
export function HuddleInviteDialog({ huddle, room, meId, opener, onClose, onFailed }: Props) {
  const nameOf = useNameOf();
  const joinsNone = useJoinsNoHuddle();
  const flash = useFlash();
  const title = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const browse = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const { members, ask } = useMembers(room, onFailed);
  const [typed, setTyped] = useState("");
  const [pages, setPages] = useState(1);
  // Whether the list has its search, which it keeps however few are left to invite, so that it isn't
  // taken from under whoever is typing in it when one of them joins the huddle.
  const [searchable, setSearchable] = useState(false);
  // Who's ticked, once anyone has been ticked or unticked.
  const [ticked, setTicked] = useState<ReadonlySet<UserId> | null>(null);
  const [unsent, setUnsent] = useState(false);

  const candidates = useMemo(() => {
    if (!Array.isArray(members)) return [];
    const inIt = new Set(huddle.people.map(({ user }) => user.id));
    return byName(invitable(members, meId, inIt, joinsNone).map((person) => ({ ...person, name: nameOf(person) })));
  }, [members, huddle.people, meId, joinsNone, nameOf]);
  if (!searchable && candidates.length > PEOPLE_PAGE) setSearchable(true);
  const sought = soughtName(typed).toLowerCase();
  const matches = sought ? candidates.filter(({ name }) => name.toLowerCase().includes(sought)) : candidates;
  const shown = matches.slice(0, pages * PEOPLE_PAGE);
  // Whoever is ticked of those who can still be invited, whether or not the search shows them.
  const chosen = candidates.filter(({ id }) => (ticked ? ticked.has(id) : candidates.length === 1));
  const full = chosen.length >= MAX_HUDDLE_INVITED;

  const find = (value: string) => {
    setTyped(value);
    setPages(1);
    if (browse.current) browse.current.scrollTop = 0;
  };

  const tick = (userId: UserId, on: boolean) => {
    const next = new Set(chosen.map(({ id }) => id));
    if (on) next.add(userId);
    else next.delete(userId);
    setTicked(next);
    setUnsent(false);
  };

  const more = () => {
    const [added, last] = [shown.length, matches.length <= (pages + 1) * PEOPLE_PAGE];
    flushSync(() => setPages(pages + 1));
    // Show more people goes once everyone's shown, and the focus goes to the first person it added,
    // for whom a phone opens no keyboard, as it would for the search.
    if (last) list.current?.querySelectorAll("input")[added]?.focus();
  };

  const send = () => {
    if (!inviteToHuddle(chosen.map(({ id }) => id))) return setUnsent(true);
    flash("notice", invitedNow(chosen.map(({ name }) => name)));
    onClose();
  };

  const direct = room.kind === "direct";
  const place = direct ? "this conversation" : room.name;
  const status =
    members === null
      ? "Loading people…"
      : members === "failed"
        ? "Couldn’t load people. Please try again."
        : candidates.length === 0
          ? `There’s nobody else in ${place} to invite.`
          : matches.length === 0
            ? "No people found. Try another name."
            : chosen.length === 0
              ? "Choose one or more people."
              : full
                ? `${chosen.length} people selected, the most one invitation takes.`
                : chosen.length === 1
                  ? "1 person selected."
                  : `${chosen.length} people selected.`;

  return (
    <Dialog open onOpenChange={(open) => open || onClose()}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={DIALOG_BACKDROP}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus(opener);
        }}
        className={cn(DIALOG, "w-[460px]")}
      >
        <button type="button" aria-label="Cancel" onClick={onClose} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle ref={title} tabIndex={-1} className={cn(DIALOG_TITLE, "pe-10 outline-none")}>
          Invite people
        </DialogTitle>
        <DialogDescription className="leading-[1.65] text-muted-foreground wrap-anywhere">
          People in {place} who aren’t in the huddle. Ember rings whoever you invite, unless they’ve turned {direct ? "its" : "the room’s"} notifications off.
        </DialogDescription>

        {searchable && (
          // A label, so a tap anywhere on it reaches the field.
          <label className="mt-5 flex min-h-[46px] cursor-text items-center gap-2.5 rounded-[10px] border px-3 py-2.5 focus-within:border-muted-foreground focus-within:ring-1 focus-within:ring-muted-foreground">
            <Search className="size-[19px] flex-[0_0_19px] text-muted-foreground" />
            <span className="sr-only">Search people</span>
            <input
              ref={search}
              type="text"
              value={typed}
              placeholder="Search by name"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              data-ember-preserve-selection
              onChange={(event) => find(event.target.value)}
              className="w-full min-w-0 bg-transparent p-0 text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none upto-500px:text-base touch:text-base"
            />
          </label>
        )}
        {/* A shared room's list is as tall as a few people while it loads, so the dialog doesn't jump as they come. */}
        <div ref={browse} className={cn("-mx-2 mt-4 max-h-[min(340px,40dvh)] overflow-y-auto overscroll-contain", !direct && "min-h-[140px]")}>
          <p role="status" className="mx-2 mb-2 text-xs text-muted-foreground">
            {status}
          </p>
          {shown.length > 0 && (
            <ul ref={list} aria-label="People">
              {shown.map((person) => {
                const picked = chosen.some(({ id }) => id === person.id);
                return (
                  <li key={person.id}>
                    {/* For fingers, the box sits far enough into its label for a fingertip on it to land on the label. */}
                    <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-[9px] px-2 py-1.5 hover:bg-hover has-disabled:cursor-default has-disabled:opacity-50 touch:min-h-14 touch:ps-4">
                      <input type="checkbox" checked={picked} disabled={!picked && full} onChange={(event) => tick(person.id, event.target.checked)} className="size-4 flex-none accent-foreground" />
                      <UserAvatar user={person} />
                      <span className="min-w-0 wrap-anywhere">{person.name}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {shown.length < matches.length && (
            <button type="button" onClick={more} className={cn(BUTTON, MORE_BUTTON)}>
              Show more people
            </button>
          )}
          {members === "failed" && (
            <button type="button" onClick={ask} className={cn(BUTTON, MORE_BUTTON)}>
              Try again
            </button>
          )}
        </div>
        {unsent && (
          <p role="alert" className="mt-4 leading-[1.65] text-muted-foreground">
            {INVITATION_UNSENT}
          </p>
        )}

        <div className="mt-[26px] flex justify-end gap-2.5">
          <button type="button" onClick={onClose} className={cn(OTHER_ACTION, ON_ONE_LINE)}>
            Cancel
          </button>
          <button
            type="button"
            disabled={chosen.length === 0}
            onClick={send}
            className={cn(MAIN_ACTION, ON_ONE_LINE, "disabled:pointer-events-none disabled:opacity-50 disabled:grayscale disabled:contrast-50")}
          >
            Send Invite
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
