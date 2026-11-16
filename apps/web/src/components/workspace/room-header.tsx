import { useContext } from "react";
import type { Favorites, Involvement, Me, Room, User, UserId } from "@ember/protocol";
import { ChatBubbleEmpty, MoreHoriz, Search } from "@/components/icons/iconoir";
import { RoomIcon } from "@/components/icons/room-icon";
import { PageLink } from "@/components/page-link";
import { useAccount } from "@/hooks/use-account";
import { useNameOf } from "@/hooks/use-directory";
import { roomSettingsPath, SEARCHES_PATH } from "@/hooks/use-route";
import { hasHuddles } from "@/lib/huddle-people";
import type { RoomAnswer } from "@/lib/room-list";
import type { ConnectionStatus } from "@/lib/room-state";
import { cn } from "@/lib/utils";
import { AgentBadge, useIsWithAgent } from "./agent-badge";
import { FavoriteButton } from "./favorite-button";
import { HuddleButton, useJoinsNoHuddle } from "./huddle-button";
import { NotificationBell } from "./notification-bell";
import { HEADER_BUTTON, PageHeader } from "./page-header";
import { OpenSearchContext, opensSearch } from "./search-box";
import { UserAvatar } from "./user-avatar";

const MAX_FACES = 4;

interface Props {
  room: Room;
  /** Its name as whoever's reading it reads it, which for a DM names the others in it. */
  name: string;
  /** Whoever's reading it. */
  meId: UserId;
  present: User[];
  status: ConnectionStatus;
  /** Whether the room has been without a connection long enough to say so. */
  offline: boolean;
  /** Whether this person has starred the room. */
  favorite: boolean;
  /** Called with this person's stars once its star saves them. */
  onStarred: (favorites: Favorites) => void;
  /** This person's notification level in the room. */
  involvement: Involvement;
  /** Called as its bell saves this person's level in the room, with what gives the room the level the server answers. */
  askForRoom: () => (answer: RoomAnswer) => void;
  onSessionChanged: (me: Me | null) => void;
  /** Says why its bell couldn't save a level, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * The room header: the room's name, its star, who's here, the huddle button once huddles are on, Search,
 * which opens the search box in the room, the bell, which turns notifications on until they're on and
 * is then your notification level's, and its settings. A DM's has a chat bubble in place of the room's
 * icon, and no star, a huddle button only when it has someone in it to huddle with, which neither a
 * bot nor anyone who can no longer sign in is, and a DM with an AI agent alone the agent badge after its
 * name.
 */
export function RoomHeader({ room, name, meId, present, status, offline, favorite, onStarred, involvement, askForRoom, onSessionChanged, onFailed }: Props) {
  const nameOf = useNameOf();
  const isWithAgent = useIsWithAgent();
  const openSearch = useContext(OpenSearchContext);
  const joinsNone = useJoinsNoHuddle();
  const direct = room.kind === "direct";
  const huddles = useAccount().huddles && hasHuddles(room, meId, joinsNone);
  return (
    <PageHeader>
      <div className="flex min-w-0 flex-1 items-center gap-2.5 max-md:gap-[7px]">
        {direct ? (
          <ChatBubbleEmpty className="size-5 shrink-0" />
        ) : (
          <RoomIcon icon={room.icon} size={22} className="shrink-0 text-[23px] text-muted-foreground" />
        )}
        <h1 className="truncate text-[17px] leading-[1.4] font-[650] max-md:text-base">
          {direct ? (
            <>
              <span className="sr-only">Direct message with</span> {name}
            </>
          ) : (
            name
          )}
        </h1>
        {isWithAgent(room) && <AgentBadge />}
        {!direct && <FavoriteButton roomId={room.id} favorite={favorite} onSaved={onStarred} onSessionChanged={onSessionChanged} />}
        {/* The composer's disabled while it's offline; this says why. */}
        {offline && (
          <span role="status" className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {status === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        )}
      </div>

      {/* Up to 500px wide the faces would squeeze out the room's name, so there only screen readers hear
          who's here. */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5 upto-500px:sr-only" title={present.map(nameOf).join(", ")}>
        <span className="sr-only">{present.length} here now</span>
        <div className="flex -space-x-1.5" aria-hidden="true">
          {present.slice(0, MAX_FACES).map((user) => (
            <UserAvatar key={user.id} user={user} className="size-7 ring-2 ring-background" />
          ))}
        </div>
        {present.length > MAX_FACES && <span className="text-xs text-muted-foreground">+{present.length - MAX_FACES}</span>}
      </div>

      {/* The room's actions, 6px apart, and touching at 900px and below. */}
      <div className="flex shrink-0 items-center gap-1.5 max-md:gap-0">
        {huddles && <HuddleButton roomId={room.id} />}
        {/* A phone under 430px wide has no room for both, and Search is in the drawer's rail too. */}
        <PageLink
          href={SEARCHES_PATH}
          title="Search messages"
          onClick={opensSearch(openSearch, { roomId: room.id })}
          className={cn(HEADER_BUTTON, huddles && "max-[429px]:hidden")}
        >
          <Search className="size-5" />
          <span className="sr-only">Search messages</span>
        </PageLink>
        <NotificationBell room={room} involvement={involvement} askForRoom={askForRoom} onFailed={onFailed} className={cn(HEADER_BUTTON, "[&>svg]:size-5")} />
        <PageLink href={roomSettingsPath(room.kind, room.id)} title="Conversation settings" className={HEADER_BUTTON}>
          <MoreHoriz className="size-5" />
          <span className="sr-only">Settings for this {direct ? "Ping" : "room"}</span>
        </PageLink>
      </div>
    </PageHeader>
  );
}
