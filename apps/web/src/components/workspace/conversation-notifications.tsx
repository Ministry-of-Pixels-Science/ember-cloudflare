import { useMemo } from "react";
import type { Me, SidebarRoom } from "@ember/protocol";
import { PageLink } from "@/components/page-link";
import { useNameOf } from "@/hooks/use-directory";
import { roomPath } from "@/hooks/use-route";
import { roomName } from "@/lib/directs";
import { isHidden, profileOrder } from "@/lib/involvement";
import { isQuietWelcome, type RoomAnswer } from "@/lib/room-list";
import { cn } from "@/lib/utils";
import { InvolvementButton } from "./involvement-button";
import { ROUND_BUTTON } from "./link-buttons";
import { ListSeparator } from "./list-row";

/**
 * Campfire's `.fill-shade` pill around a room's name, whose taps reach past it to 44px on touch screens.
 */
const PILL =
  "relative flex min-w-0 rounded-full border bg-surface px-[9px] py-[3px] leading-[1.4] text-foreground no-underline touch:after:absolute touch:after:inset-x-0 touch:after:-inset-y-2.5";

interface Props {
  me: Me;
  /** Your rooms and DMs, as the sidebar's list has them. */
  rooms: SidebarRoom[];
  /** Called as a bell saves your level in a room, with what gives the room the level the server answers. */
  askForRoom: () => (answer: RoomAnswer) => void;
  /** Says why a bell couldn't save a level, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * Conversation notifications on your profile:
 * your rooms, then your DMs, with a rule between them, each a link to it in a pill, then a dashed line and
 * its bell, which goes round your levels there. A room you've hidden is listed too, dimmed, as Campfire's
 * `.membership-item:has(.btn.invisible)` is (base.css), for you to show it again, but not the DMs that
 * welcomed you as you joined that nobody has written in yet, which your sidebar leaves out too.
 */
export function ConversationNotifications({ me, rooms, askForRoom, onFailed }: Props) {
  const nameOf = useNameOf();
  const { shared, directs } = useMemo(() => profileOrder(rooms.filter((room) => !isQuietWelcome(room, me.id))), [rooms, me.id]);

  const row = (room: SidebarRoom) => (
    <li key={room.id} className={cn("flex min-w-0 items-center gap-x-[1ch]", isHidden(room) && "opacity-50")}>
      <PageLink href={roomPath(room.id)} className={PILL}>
        <strong className="truncate">{roomName(room, me.id, nameOf)}</strong>
      </PageLink>
      <hr aria-hidden="true" className="min-w-[2ch] grow border-t border-dashed" />
      <span className="text-[0.8rem]">
        <InvolvementButton room={room} involvement={room.involvement} askForRoom={askForRoom} onFailed={onFailed} className={ROUND_BUTTON} />
      </span>
    </li>
  );

  // A section title over Campfire's `menu.flex.flex-column.gap.pad`, in a `.fill-shade` box.
  return (
    <div className="my-4 rounded-[10px] border bg-surface px-[1ch] py-4">
      <h2 id="notifications-heading" className="mb-3 text-base font-semibold">
        Conversation notifications
      </h2>
      <menu aria-labelledby="notifications-heading" className="m-0 flex flex-col gap-x-[1ch] gap-y-4 px-[1ch] py-4">
        {shared.map(row)}
        {shared.length > 0 && directs.length > 0 && <ListSeparator />}
        {directs.map(row)}
      </menu>
    </div>
  );
}
