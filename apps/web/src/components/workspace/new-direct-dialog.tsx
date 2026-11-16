import { useContext, useEffect, useEffectEvent, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { DirectoryUser, Me, UserId } from "@ember/protocol";
import { Search, Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { PeopleContext, useNameOf } from "@/hooks/use-directory";
import { useMounted } from "@/hooks/use-mounted";
import { leave, navigate, roomPath, useRoute } from "@/hooks/use-route";
import { isSignedOut, startDirect } from "@/lib/api";
import { PEOPLE_PAGE, peopleMatching, soughtName } from "@/lib/directs";
import type { RoomAnswer } from "@/lib/room-list";
import { cn } from "@/lib/utils";
import { AgentBadge, useIsAgent } from "./agent-badge";
import { UserAvatar } from "./user-avatar";

// The New direct message dialog. It lists the people directory the page already has, so it searches as
// you type, without asking the server.

/** Campfire's `.btn`. */
const BUTTON = "inline-flex cursor-pointer items-center justify-center gap-[0.5em] rounded-[9px] border bg-background px-[1.1em] py-[0.5em] font-medium text-foreground";
/** The footer's buttons, 44px tall for fingers and at 500px wide and below. */
const FOOTER_BUTTON = "min-h-[42px] px-4 py-2.5 touch:min-h-11 upto-500px:min-h-11";
/** Show more people, and Try again. */
const MORE_BUTTON = "m-2 px-3 py-2 text-[13px] touch:min-h-11";

/**
 * A link's click that opens New direct message in place: a plain click on the rail's DMs and the
 * sidebar's New direct message, leaving one with a modifier key to follow the link to
 * `/rooms/directs/new`, as into a new tab.
 */
export function opensNewDirect(open: (opener: HTMLElement) => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(event.currentTarget);
  };
}

const namesOf = new Intl.ListFormat("en-US", { type: "conjunction" });

/**
 * What an administrator is told once a DM starts without the AI agents picked for it that are only
 * available in admin DMs, by their `names`: a DM with anyone who isn't an administrator leaves them out.
 */
export const startedWithout = (names: string[]) =>
  `${namesOf.format(names)} ${names.length === 1 ? "is" : "are"} only for DMs between administrators, so this DM is without ${names.length === 1 ? "it" : "them"}.`;

/**
 * Puts focus back on what opened a dialog, or, when that's gone with the drawer it was in, on the
 * drawer's toggle.
 */
export function returnFocus(opener: HTMLElement | null) {
  opener?.focus({ preventScroll: true });
  if (opener && document.activeElement === opener) return;
  document.querySelector<HTMLElement>("[data-ember-sidebar-toggle]")?.focus({ preventScroll: true });
}

interface Props {
  /** The link that opened it, or null when the page's address did. */
  opener: HTMLElement | null;
  /** Who's looking, who isn't listed, nor the AI agents only administrators can ask unless they're one. */
  me: Me;
  /** Loads the people directory again, settling once it has or failed, as opening the dialog does. */
  reloadPeople: () => Promise<void>;
  /** Called as a DM starts, with what lists it, for the sidebar, as the server answers. */
  askForRoom: () => (answer: RoomAnswer) => void;
  /**
   * Called once it has closed, with whether it started the DM the page shows, which going there leaves as
   * it is, so its composer has yet to take focus.
   */
  onClose: (startedShown: boolean) => void;
  /** Hears of the people picked whom the DM started without, which it does without an AI agent only available in admin DMs. */
  onLeftOut: (people: DirectoryUser[]) => void;
  /** Hears that the session has ended, when that's why a DM didn't start. */
  onFailed: (error: unknown) => void;
}

/**
 * New direct message: a search of the active people, 20 at a time, to pick one or more of, by pointer or
 * with the arrow keys and Enter, as chips that take them back out, and Start conversation, which opens
 * the DM between them and you, starting it if they don't have one, and goes there. It's open from when
 * it's shown until it closes, which it can't while a DM is starting.
 */
export function NewDirectDialog({ opener, me, reloadPeople, askForRoom, onClose, onLeftOut, onFailed }: Props) {
  const people = useContext(PeopleContext);
  const nameOf = useNameOf();
  const isAgent = useIsAgent();
  const mounted = useMounted();
  const listId = useId();
  const search = useRef<HTMLInputElement>(null);
  const browse = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  const [typed, setTyped] = useState("");
  const [picked, setPicked] = useState<DirectoryUser[]>([]);
  const [pages, setPages] = useState(1);
  const [highlighted, setHighlighted] = useState<UserId | null>(null);
  const [loading, setLoading] = useState<"loading" | "failed" | null>("loading");
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const route = useRoute();
  // How the dialog closed on starting a DM, which leaves focus for the DM's page to take: "shown" when the
  // page showed it already, and stays as it is.
  const started = useRef<"opened" | "shown" | null>(null);

  const name = soughtName(typed);
  const matches = useMemo(() => peopleMatching(people.values(), me, name), [people, me, name]);
  const shown = matches.slice(0, pages * PEOPLE_PAGE);
  const options = shown.filter((person) => !picked.some((p) => p.id === person.id));
  // The directory lists everyone, you included, once it's loaded.
  const unloaded = people.size === 0;
  const optionId = (userId: UserId) => `${listId}-${userId}`;

  // Each opening asks for the directory again, so someone who joined since shows up. Until a first copy
  // comes, there's nobody to list.
  const load = () => {
    setLoading("loading");
    reloadPeople().then(
      () => mounted.current && setLoading(null),
      () => mounted.current && setLoading("failed"),
    );
  };
  useEffect(load, []);

  // Anything picked or typed takes the place of a failure to start.
  const changed = () => setStartFailed(false);

  const close = () => {
    if (!starting) setOpen(false);
  };

  // Going Back or Forward closes it too.
  const historyMoved = useEffectEvent(close);
  useEffect(() => {
    const listener = () => historyMoved();
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);

  const find = (value: string) => {
    setTyped(value);
    setPages(1);
    setHighlighted(null);
    changed();
    if (browse.current) browse.current.scrollTop = 0;
  };

  const pick = (person: DirectoryUser) => {
    if (starting) return;
    setPicked((picked) => [...picked, person]);
    setHighlighted(null);
    changed();
    search.current?.focus();
  };

  const unpick = (person: DirectoryUser) => {
    if (starting) return;
    setPicked((picked) => picked.filter((p) => p.id !== person.id));
    changed();
    search.current?.focus();
  };

  const more = () => {
    setPages((pages) => pages + 1);
    setHighlighted(null);
    changed();
    // Show more people goes once everyone's shown, and focus stays in the dialog.
    if (matches.length <= (pages + 1) * PEOPLE_PAGE) search.current?.focus();
  };

  // The arrows move through the people listed, round from either end, and Enter picks the one highlighted.
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length > 0) {
      event.preventDefault();
      const index = options.findIndex((person) => person.id === highlighted);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = options[index === -1 ? (step > 0 ? 0 : options.length - 1) : (index + step + options.length) % options.length]!;
      setHighlighted(next.id);
      document.getElementById(optionId(next.id))?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const person = options.find((person) => person.id === highlighted);
      if (person) pick(person);
    }
  };

  /** Starts the DM and goes there, settling with whether it did. */
  const startConversation = async () => {
    setStarting(true);
    setStartFailed(false);
    const answered = askForRoom();
    try {
      const room = await startDirect(picked.map((person) => person.id));
      answered({ type: "saved", room });
      if (!mounted.current) return false;
      const leftOut = picked.filter((person) => !room.members.some((member) => member.id === person.id));
      if (leftOut.length > 0) onLeftOut(leftOut);
      started.current = route.page === "room" && route.roomId === room.id ? "shown" : "opened";
      setOpen(false);
      navigate(roomPath(room.id));
      return true;
    } catch (error) {
      if (isSignedOut(error)) onFailed(error);
      else if (mounted.current) {
        setStarting(false);
        setStartFailed(true);
      }
      return false;
    }
  };

  // A page with changes to lose asks before a conversation starts, and Keep editing comes back here with
  // the people picked.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (picked.length > 0 && !starting) leave(startConversation);
  };

  const status = starting
    ? "Starting conversation…"
    : startFailed
      ? "Couldn’t start the conversation. Please try again."
      : unloaded
        ? loading === "failed"
          ? "Couldn’t load people. Please try again."
          : "Loading people…"
        : options.length > 0
          ? "Choose one or more people."
          : shown.length > 0
            ? "Everyone shown is selected."
            : name
              ? "No people found. Try another name."
              : "No other people are available to message yet.";

  return (
    <Dialog open={open} onOpenChange={(open) => open || close()}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-dialog-backdrop backdrop-blur-[3px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          search.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!started.current) returnFocus(opener);
          onClose(started.current === "shown");
        }}
        className={cn(
          "block w-[500px] max-w-[calc(100dvw-24px-env(safe-area-inset-left)-env(safe-area-inset-right))] sm:max-w-[calc(100dvw-24px-env(safe-area-inset-left)-env(safe-area-inset-right))]",
          "max-h-[calc(100dvh-24px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] overflow-auto rounded-[18px] p-0 text-foreground shadow-[0_24px_80px_var(--color-dialog-shadow)]",
        )}
      >
        <form onSubmit={submit}>
          <header className="flex items-start justify-between gap-4 px-6 pt-6 pb-5 upto-500px:px-4 upto-500px:py-5">
            <div>
              <DialogTitle className="mb-1.5 text-[20px] leading-[1.3] font-bold">New direct message</DialogTitle>
              <DialogDescription className="text-[13px] leading-normal">Find people by full name. You can also type @name.</DialogDescription>
            </div>
            <button type="button" aria-label="Close" onClick={close} className="grid size-9 flex-none cursor-pointer place-items-center rounded-[9px] touch:size-11">
              <Xmark className="size-5" />
            </button>
          </header>
          {picked.length > 0 && (
            <div role="group" aria-label="Selected people" className="flex max-h-[110px] flex-wrap gap-1.5 overflow-y-auto px-6 pb-3.5 upto-500px:px-4">
              {picked.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  aria-label={`Remove ${nameOf(person)}`}
                  onClick={() => unpick(person)}
                  className="inline-flex min-h-9 max-w-full cursor-pointer items-center gap-1 rounded-[20px] border bg-surface py-[7px] ps-3 pe-2.5 text-[13px] text-foreground wrap-anywhere touch:min-h-11"
                >
                  {nameOf(person)}
                  <Xmark className="size-4 flex-none" />
                </button>
              ))}
            </div>
          )}
          {/* A label, so a tap anywhere on it reaches the field. */}
          <label className="mx-6 flex min-h-[46px] cursor-text items-center gap-2.5 rounded-[10px] border px-3 py-2.5 focus-within:border-muted-foreground focus-within:ring-1 focus-within:ring-muted-foreground upto-500px:mx-4">
            <Search className="size-[19px] flex-[0_0_19px] text-muted-foreground" />
            <span className="sr-only">Search people</span>
            <input
              ref={search}
              type="text"
              value={typed}
              placeholder="Search by name or @name"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              data-ember-preserve-selection
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={highlighted && options.some((person) => person.id === highlighted) ? optionId(highlighted) : undefined}
              onChange={(event) => find(event.target.value)}
              onKeyDown={keyDown}
              className="w-full min-w-0 bg-transparent p-0 text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none upto-500px:text-base touch:text-base"
            />
          </label>
          <div ref={browse} className="max-h-[min(340px,40dvh)] min-h-[170px] overflow-y-auto overscroll-contain px-4 pt-3.5 pb-5">
            <p role="status" className="mx-2 mb-2 text-xs text-muted-foreground">
              {status}
            </p>
            <div id={listId} role="listbox" aria-label="People" aria-busy={(unloaded && loading === "loading") || undefined}>
              {options.map((person) => (
                <button
                  key={person.id}
                  id={optionId(person.id)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={person.id === highlighted}
                  onClick={() => pick(person)}
                  className="flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-[9px] px-2 py-2.5 text-start text-foreground hover:bg-hover aria-selected:bg-hover"
                >
                  <UserAvatar user={person} />
                  <span className="min-w-0 wrap-anywhere">
                    {nameOf(person)}
                    {isAgent(person) && <AgentBadge className="ms-0.5" />}
                  </span>
                </button>
              ))}
            </div>
            {!unloaded && shown.length < matches.length && (
              <button type="button" onClick={more} className={cn(BUTTON, MORE_BUTTON)}>
                Show more people
              </button>
            )}
            {unloaded && loading === "failed" && (
              <button type="button" onClick={load} className={cn(BUTTON, MORE_BUTTON)}>
                Try again
              </button>
            )}
          </div>
          <footer className="flex justify-end gap-2.5 border-t px-6 py-[18px] upto-500px:p-4">
            <button type="button" onClick={close} className={cn(BUTTON, FOOTER_BUTTON)}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={picked.length === 0 || starting}
              className={cn(
                BUTTON,
                FOOTER_BUTTON,
                "border-transparent bg-foreground text-background hover:not-active:brightness-70 disabled:pointer-events-none disabled:opacity-50 disabled:grayscale disabled:contrast-50",
              )}
            >
              Start conversation
            </button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
