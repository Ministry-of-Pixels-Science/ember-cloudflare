import { useContext, useEffect, useEffectEvent } from "react";
import type { Room, RoomId, User } from "@ember/protocol";
import { Headset } from "@/components/icons/iconoir";
import { PeopleContext } from "@/hooks/use-directory";
import { INVITATION_RINGS_MS, type HuddleInvitation } from "@/lib/huddle-invitations";
import { ringForHuddle } from "@/lib/huddle-ring";
import { UserAvatar } from "./user-avatar";

/** Join, in green with the headphones, as the huddle button is while a huddle can be joined. */
const JOIN = "inline-flex min-h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-positive px-3.5 text-sm font-semibold text-white hover:brightness-95 touch:min-h-11";
const DECLINE = "inline-flex min-h-9 cursor-pointer items-center justify-center rounded-lg border bg-background px-3.5 text-sm font-semibold hover:bg-hover touch:min-h-11";

/** What an invitation says after who invites: into a direct message's huddle, which is with them, or into a room's, by its name. */
const invites = (room: Room | undefined) => (room && room.kind !== "direct" ? `invites you to a huddle in ${room.name}` : "invites you to a huddle");

interface CardProps {
  invitation: HuddleInvitation;
  /** The room whose huddle it's into, once this person's rooms have come. */
  room: Room | undefined;
  onJoin: () => void;
  onDecline: () => void;
  /** Called once it has rung for as long as an invitation does, unanswered. */
  onUnanswered: () => void;
}

/** One invitation: whoever invites, with the headphones on their avatar, over Decline and Join. */
function HuddleInvitationCard({ invitation: { by, at }, room, onJoin, onDecline, onUnanswered }: CardProps) {
  const people = useContext(PeopleContext);
  // As the people directory lists them, or as their direct message does until it lists anyone.
  const inviter: User = people.get(by) ?? (room?.kind === "direct" ? room.members.find(({ id }) => id === by) : undefined) ?? { id: by, name: "Someone" };
  const what = invites(room);
  const unanswered = useEffectEvent(onUnanswered);
  useEffect(() => {
    const givesUp = setTimeout(unanswered, Math.max(0, at + INVITATION_RINGS_MS - Date.now()));
    return () => clearTimeout(givesUp);
  }, [at]);
  return (
    // A group, so that its buttons say whose invitation they answer, whose words are read out as it comes.
    <div
      role="group"
      aria-label={`${inviter.name} ${what}`}
      className="pointer-events-auto w-[320px] max-w-full rounded-2xl border bg-background p-4 shadow-[0_12px_40px_var(--color-dialog-shadow),0_2px_8px_var(--color-dialog-shadow-faint)]"
    >
      <div role="alert" className="flex items-center gap-3">
        <span className="relative shrink-0">
          <UserAvatar user={inviter} className="size-11" />
          <span aria-hidden="true" className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full bg-positive text-white ring-2 ring-background">
            <Headset className="size-3" />
          </span>
        </span>
        <div className="min-w-0">
          <p className="truncate text-[15px] leading-5 font-semibold">{inviter.name}</p>
          <p className="truncate text-sm leading-5 text-muted-foreground">{what}</p>
        </div>
      </div>
      <div className="mt-3.5 grid grid-cols-2 gap-2">
        <button type="button" onClick={onDecline} className={DECLINE}>
          Decline
        </button>
        <button type="button" onClick={onJoin} className={JOIN}>
          <Headset className="size-4" />
          Join
        </button>
      </div>
    </div>
  );
}

interface Props {
  /** The invitations that ring, in the order they came. */
  invitations: HuddleInvitation[];
  /** This person's rooms, or none until they've come. */
  rooms: Room[];
  /** Whether they show without a sound, as they do for someone in a huddle already. */
  quiet: boolean;
  /** Called to join the huddle an invitation is into, by its room. */
  onJoin: (roomId: RoomId) => void;
  onDecline: (roomId: RoomId) => void;
  /** Called once an invitation has rung for as long as one does, unanswered. */
  onUnanswered: (roomId: RoomId) => void;
}

/**
 * The invitations into huddles that ring in this tab, in the window's corner under the header, over
 * whatever page shows: one from whoever starts a huddle in a direct message with this person. Each rings
 * for half a minute, or until it's answered, here or in another of their tabs. More than the window is
 * tall enough for scroll. The ring is one sound for them all (huddle-ring.ts), and the focus stays where
 * it is, so that an invitation takes nothing from what its person is typing.
 */
export function HuddleInvitations({ invitations, rooms, quiet, onJoin, onDecline, onUnanswered }: Props) {
  useEffect(() => (quiet ? undefined : ringForHuddle()), [quiet]);
  return (
    <section
      aria-label="Huddle invitations"
      // z-30: over the page and the huddle opened, under menus and dialogs, as the workspace's flashes are.
      // It runs from the header to the window's foot, and as wide as the window, so that more invitations
      // than fit scroll under the header with their shadows whole, and lets a click through to the page
      // everywhere but on an invitation.
      className="pointer-events-none absolute inset-x-0 top-header bottom-0 z-30 flex flex-col items-end gap-2 overflow-y-auto pt-3 pr-[max(16px,env(safe-area-inset-right))] pb-[max(12px,env(safe-area-inset-bottom))] pl-4 [scrollbar-width:none] max-md:top-[calc(56px+env(safe-area-inset-top))] max-md:pt-2"
    >
      {invitations.map((invitation) => (
        <HuddleInvitationCard
          key={`${invitation.roomId} ${invitation.at}`}
          invitation={invitation}
          room={rooms.find(({ id }) => id === invitation.roomId)}
          onJoin={() => onJoin(invitation.roomId)}
          onDecline={() => onDecline(invitation.roomId)}
          onUnanswered={() => onUnanswered(invitation.roomId)}
        />
      ))}
    </section>
  );
}
