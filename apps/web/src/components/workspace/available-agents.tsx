import { useContext, useEffect, useEffectEvent, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ASSISTANT_ID, type Me, type RoomIconName, type SidebarRoom, type User, type UserId } from "@ember/protocol";
import { MAX_AGENTS, type AgentAccess, type AgentRoom, type AvailableAgent } from "@ember/protocol/agents";
import { AtSign, ChatLines, Copy, Crown, EditPencil, EyeClosed, Hashtag, MultiBubble, Plus, Xmark } from "@/components/icons/iconoir";
import { RoomIcon } from "@/components/icons/room-icon";
import { PageLink } from "@/components/page-link";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useMounted } from "@/hooks/use-mounted";
import { agentSettingsPath, leave, NEW_AGENT_PATH, roomPath } from "@/hooks/use-route";
import { asListed, canAsk, DMS_ONLY, EVERY_ROOM, KEPT_FOR } from "@/lib/agents";
import { fetchAvailableAgents, isSignedOut } from "@/lib/api";
import { copyWithSuccess } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { returnFocus } from "./new-direct-dialog";
import { DIALOG_BACKDROP } from "./unsaved-changes";
import { UserAvatar } from "./user-avatar";

// Available Agents, which the sidebar's row of that name opens, as the project's owner chose from the
// mock-ups (2026-11-15): the AI agents this person can ask down one side, @ember first, and the one
// picked beside them, with its picture, the @name that summons it, what it does, the rooms it's in, and
// a button that starts a DM with it. Administrators see the agents kept for them too, marked, with a
// link to each one's page and to New agent.

/** How to summon an agent, which the dialog says of itself. */
export const HOW_TO_ASK = "Type @ and an agent's name in a room it's in, or message it directly.";

/** What the dialog says once it's loaded no agent this person can ask, as when Ember AI has just been turned off. */
export const NO_AGENTS = "There are no agents to ask right now.";

/** Below this width the agents run across the top, each a picture over its name, rather than down the side. */
const STRIP_LAYOUT = "(width <= 37.5rem)";

/** Campfire's `.btn`, small. */
const SMALL_BUTTON =
  "inline-flex min-h-9 shrink-0 cursor-pointer items-center justify-center gap-[0.45em] rounded-[9px] border bg-background px-3.5 py-1 text-sm font-medium text-foreground hover:bg-hover touch:min-h-11";
/** And the dialog's main action, in ink. */
const INK_BUTTON =
  "inline-flex min-h-9 cursor-pointer items-center justify-center gap-[0.5em] rounded-[9px] border border-transparent bg-foreground px-3.5 py-1.5 text-sm font-medium text-background hover:not-active:brightness-70 aria-disabled:cursor-default touch:min-h-11";
/** A chip of where an agent works. */
const CHIP = "inline-flex h-6 max-w-full items-center gap-1 rounded-full border bg-background px-2 text-xs leading-none text-foreground touch:h-8 touch:px-2.5";
/** How many there are, in a pill of the ink at 8%, as the Agent badge's is. */
const COUNT = "grid h-5 min-w-5 place-items-center rounded-full bg-foreground/8 px-1.5 text-[11px] leading-none font-semibold tabular-nums text-message-muted";

/**
 * The agents listed, as the people directory has them now: each by the name and picture it has now,
 * without those it says are gone, no longer lists, or now keeps for administrators, unless `me` is one.
 */
function listedNow(agents: AvailableAgent[], people: People, me: Me): AvailableAgent[] {
  return agents.flatMap((agent) => {
    const listed = people.get(agent.id);
    return listed?.status === "active" && canAsk(listed, me) ? [asListed(agent, listed)] : [];
  });
}

/** The tab of the agent picked, in the dialog `content`, once its agents have come. */
const pickedTab = (content: HTMLElement | null) => content?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');

/** What the dialog says of asking an agent that shares no room with this person, by who can ask it. */
export const directOnly = (access: AgentAccess) =>
  access === "admin-dms" ? "Message it directly. It isn't in any room, and only administrators can see it." : "Message it directly. It isn't in any of your rooms.";

interface Props {
  /** Who's looking, who sees the agents kept for administrators, and the links to their pages, if they're one. */
  me: Me;
  /** The rooms in their sidebar, which name the rooms an agent is in as they're called now, with their icons. */
  rooms: SidebarRoom[];
  /** The row that opened it, which gets focus back. */
  opener: HTMLElement | null;
  /**
   * Called once it has closed, with whether it started a DM, whose composer has yet to take focus, which
   * the dialog kept while the page went there.
   */
  onClose: (started: boolean) => void;
  /** Starts the DM with an agent, or opens the one there is, and goes there, settling with whether it did. */
  onStartDirect: (agent: User) => Promise<boolean>;
  /** Says why the agents didn't load, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * Available Agents: the agents this person can ask, as tabs, down the side, or across the top on a
 * phone, and the one picked beside them, which is the first, @ember, until another is. It asks the
 * server for them each time it opens, and follows the people directory from then on. It's open from
 * when it's shown until it closes, which following one of its links, starting a DM, and going Back or
 * Forward do too.
 */
export function AvailableAgentsDialog({ me, rooms, opener, onClose, onStartDirect, onFailed }: Props) {
  const people = useContext(PeopleContext);
  const [open, setOpen] = useState(true);
  const [loaded, setLoaded] = useState<AvailableAgent[] | null>(null);
  const [pickedId, setPickedId] = useState<UserId | null>(null);
  const [starting, setStarting] = useState(false);
  // Whether the dialog closed on starting a DM, which leaves focus for the DM's composer to take.
  const started = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const mounted = useMounted();
  const strip = useMediaQuery(STRIP_LAYOUT);
  const id = useId();
  const tabId = (agentId: UserId) => `${id}-tab-${agentId}`;
  const panelId = `${id}-panel`;

  useEffect(() => {
    let stopped = false;
    fetchAvailableAgents().then(
      (agents) => !stopped && setLoaded(agents),
      (error: unknown) => {
        // A dialog closed before its agents load only reports a session that's ended, which goes to sign in.
        if (!stopped || isSignedOut(error)) onFailed(error);
      },
    );
    return () => void (stopped = true);
  }, [onFailed]);

  const agents = useMemo(() => listedNow(loaded ?? [], people, me), [loaded, people, me]);
  // The agent picked takes focus as the agents come, for the arrows to move from, unless focus has moved on from the dialog itself.
  useEffect(() => {
    if (loaded && document.activeElement === content.current) pickedTab(content.current)?.focus();
  }, [loaded]);
  const picked = agents.find((agent) => agent.id === pickedId) ?? agents[0];
  const sidebarRooms = useMemo(() => new Map(rooms.map((room) => [room.id, room])), [rooms]);
  const canMakeAnother = me.administrator && agents.filter((agent) => agent.id !== ASSISTANT_ID).length < MAX_AGENTS;
  const close = () => setOpen(false);

  // Going Back or Forward closes it too.
  const historyMoved = useEffectEvent(close);
  useEffect(() => {
    const listener = () => historyMoved();
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);

  // As a tablist's arrows do, picking the tab they move to, down the side or across the top.
  const moveThroughAgents = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else return;
    event.preventDefault();
    tabs[next]!.focus();
    setPickedId(agents[next]!.id);
  };

  // As the button on someone's page does, once the page's guard lets it, which a second click doesn't start again.
  const message = (agent: User) => {
    if (starting) return;
    leave(async () => {
      setStarting(true);
      try {
        const went = await onStartDirect(agent);
        if (went && mounted.current) {
          started.current = true;
          close();
        }
        return went;
      } finally {
        if (mounted.current) setStarting(false);
      }
    });
  };

  const closeButton = (
    <button type="button" aria-label="Close" onClick={close} className="grid size-9 flex-none cursor-pointer place-items-center rounded-[9px] hover:bg-hover touch:size-11">
      <Xmark className="size-5" />
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(open) => open || close()}>
      <DialogContent
        ref={content}
        showCloseButton={false}
        overlayClassName={DIALOG_BACKDROP}
        aria-busy={loaded === null || undefined}
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          // The dialog itself takes focus until its agents come.
          event.preventDefault();
          content.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!started.current) returnFocus(opener);
          onClose(started.current);
        }}
        className={cn(
          "flex w-[800px] flex-row gap-0 overflow-hidden rounded-[18px] p-0 text-foreground shadow-[0_24px_80px_var(--color-dialog-shadow),0_4px_16px_var(--color-dialog-shadow-faint)] upto-600px:flex-col",
          "max-w-[calc(100dvw-24px-env(safe-area-inset-left)-env(safe-area-inset-right))] sm:max-w-[calc(100dvw-24px-env(safe-area-inset-left)-env(safe-area-inset-right))]",
          "max-h-[calc(100dvh-24px-env(safe-area-inset-top)-env(safe-area-inset-bottom))]",
        )}
      >
        <div className="flex w-[264px] shrink-0 flex-col border-r bg-surface upto-600px:w-auto upto-600px:border-r-0 upto-600px:border-b">
          <div className="flex items-center gap-2 px-5 pt-5 pb-3 upto-600px:px-4 upto-600px:pt-3 upto-600px:pb-1">
            <DialogTitle className="text-[17px] leading-[1.3] font-bold">Available Agents</DialogTitle>
            {/* Said by the tabs, which say how many they are. */}
            <span aria-hidden="true" className={COUNT}>
              {agents.length}
            </span>
            {strip && <div className="ml-auto">{closeButton}</div>}
          </div>
          <DialogDescription className="sr-only">{HOW_TO_ASK}</DialogDescription>
          <div
            role="tablist"
            aria-label="Agents"
            aria-orientation={strip ? "horizontal" : "vertical"}
            onKeyDown={moveThroughAgents}
            className="flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto px-2.5 pb-3 upto-600px:flex-none upto-600px:flex-row upto-600px:gap-0.5 upto-600px:overflow-x-auto upto-600px:px-3"
          >
            {agents.map((agent) => (
              <button
                key={agent.id}
                id={tabId(agent.id)}
                type="button"
                role="tab"
                aria-selected={agent.id === picked?.id}
                aria-controls={panelId}
                tabIndex={agent.id === picked?.id ? 0 : -1}
                onClick={() => setPickedId(agent.id)}
                className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-start text-sm hover:bg-hover aria-selected:bg-hover aria-selected:font-semibold upto-600px:w-[68px] upto-600px:flex-col upto-600px:gap-1 upto-600px:px-1 upto-600px:py-2 upto-600px:text-center upto-600px:text-[11px]"
              >
                <UserAvatar user={agent} className="size-7 upto-600px:size-9" />
                <span className="min-w-0 flex-1 truncate upto-600px:w-full upto-600px:flex-none">{agent.name}</span>
                {agent.access !== "everyone" && <KeptMark access={agent.access} className="size-3.5 shrink-0 text-muted-foreground upto-600px:hidden" />}
              </button>
            ))}
          </div>
          {canMakeAnother && !strip && (
            <div className="border-t p-2.5">
              <PageLink href={NEW_AGENT_PATH} onClick={close} className="flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground touch:min-h-11">
                <Plus className="size-4" />
                New agent
              </PageLink>
            </div>
          )}
        </div>
        {/* As tall with nothing in it yet, so that the dialog doesn't grow as its agents come. */}
        <div className="relative flex min-h-[440px] min-w-0 flex-1 flex-col upto-600px:min-h-[300px]">
          {!strip && <div className="absolute end-3 top-3">{closeButton}</div>}
          {picked ? (
            <div id={panelId} role="tabpanel" aria-labelledby={tabId(picked.id)} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6 upto-600px:p-4">
              <div className="flex items-center gap-4 pe-9 upto-600px:pe-0">
                <UserAvatar user={picked} className="size-16 upto-600px:size-14" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="text-[22px] leading-[1.25] font-bold wrap-anywhere">{picked.name}</h3>
                    {picked.access !== "everyone" && <KeptTag access={picked.access} />}
                  </div>
                  <Handle name={picked.name} className="mt-1" />
                </div>
              </div>
              <p className="text-[15px] leading-normal wrap-anywhere text-message-ink">{picked.description}</p>
              <p className="flex items-start gap-2 rounded-[10px] border bg-surface px-3.5 py-3 text-[13px] leading-normal">
                <AtSign className="mt-px size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 wrap-anywhere">
                  {picked.rooms?.length === 0 ? (
                    directOnly(picked.access)
                  ) : (
                    <>
                      Type <strong className="font-semibold">@{picked.name}</strong> in a room it's in, or message it directly.
                    </>
                  )}
                </span>
              </p>
              <section aria-labelledby={`${id}-where`}>
                <h4 id={`${id}-where`} className="mb-2 text-xs font-medium text-muted-foreground">
                  Available in
                </h4>
                <Where rooms={picked.rooms} sidebarRooms={sidebarRooms} onFollow={close} />
              </section>
              <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
                <button type="button" aria-disabled={starting || undefined} onClick={() => message(picked)} className={INK_BUTTON}>
                  <ChatLines className="size-[18px]" />
                  Message {picked.name}
                </button>
                {me.administrator && (
                  <PageLink href={agentSettingsPath(picked.id)} onClick={close} className={SMALL_BUTTON}>
                    <EditPencil className="size-4" />
                    Edit
                  </PageLink>
                )}
              </div>
            </div>
          ) : (
            loaded && <p className="m-auto p-6 text-center text-sm text-muted-foreground">{NO_AGENTS}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What marks an agent kept for administrators in the list, which only they see: a crown, or a closed eye for one only their DMs reach. */
function KeptMark({ access, className }: { access: Exclude<AgentAccess, "everyone">; className?: string }) {
  return access === "admins" ? <Crown aria-label={KEPT_FOR[access]} className={className} /> : <EyeClosed aria-label={KEPT_FOR[access]} className={className} />;
}

/** And beside its name, in words, on a pill of the ink at 8%. */
function KeptTag({ access }: { access: Exclude<AgentAccess, "everyone"> }) {
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full bg-foreground/8 px-1.5 text-[11px] leading-none font-medium text-message-muted">
      {access === "admins" ? <Crown className="size-3" /> : <EyeClosed className="size-3" />}
      {KEPT_FOR[access]}
    </span>
  );
}

/** An agent's @name, which summons it, as a button that copies it, turning green as it does. */
function Handle({ name, className }: { name: string; className?: string }) {
  return (
    <button
      type="button"
      title="Copy"
      aria-label={`Copy @${name}`}
      onClick={(event) => void copyWithSuccess(event.currentTarget, `@${name}`)}
      className={cn("inline-flex min-h-6 max-w-full cursor-pointer items-center gap-1 rounded-[6px] bg-foreground/6 px-1.5 font-mono text-[12px] leading-none text-message-ink hover:bg-foreground/10 touch:min-h-8", className)}
    >
      <span className="truncate">@{name}</span>
      <Copy className="size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

interface WhereProps {
  /** The rooms an agent shares with this person, or null for every open one. */
  rooms: AgentRoom[] | null;
  sidebarRooms: ReadonlyMap<string, SidebarRoom>;
  /** Closes the dialog as a room's link is followed. */
  onFollow: () => void;
}

/** Where an agent works, as chips: every room, the rooms it shares with this person, each a link to it, or DMs alone. */
function Where({ rooms, sidebarRooms, onFollow }: WhereProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {rooms === null ? (
        <span className={CHIP}>
          <Hashtag className="size-3 shrink-0 text-muted-foreground" />
          {EVERY_ROOM}
        </span>
      ) : rooms.length === 0 ? (
        <span className={CHIP}>
          <MultiBubble className="size-3 shrink-0 text-muted-foreground" />
          {DMS_ONLY}
        </span>
      ) : (
        rooms.map((room) => {
          const { name, icon } = roomNow(room, sidebarRooms);
          return (
            <PageLink key={room.id} href={roomPath(room.id)} onClick={onFollow} className={cn(CHIP, "hover:bg-hover")}>
              <RoomIcon icon={icon} size={12} className="w-3 shrink-0 text-center text-[13px] leading-none text-muted-foreground" />
              <span className="truncate">{name}</span>
            </PageLink>
          );
        })
      )}
    </div>
  );
}

/** A room an agent is in as the sidebar has it now, which follows renames, with its icon, or as the list named it until the sidebar lists it. */
function roomNow(room: AgentRoom, sidebarRooms: ReadonlyMap<string, SidebarRoom>): { name: string; icon: RoomIconName | null } {
  const listed = sidebarRooms.get(room.id);
  return listed && listed.kind !== "direct" ? { name: listed.name, icon: listed.icon } : { name: room.name, icon: null };
}
