import { useId, useMemo } from "react";
import type { Me, RoomId, SharedRoom } from "@ember/protocol";
import { DotsGrid3x3 } from "@/components/icons/iconoir";
import { RoomIcon } from "@/components/icons/room-icon";
import { PageLink } from "@/components/page-link";
import { roomSettingsPath, WORKSPACE_SETTINGS_PATH } from "@/hooks/use-route";
import { useSharedOrder } from "@/hooks/use-shared-order";
import { cn } from "@/lib/utils";
import { UnsavedChanges } from "./unsaved-changes";

/**
 * Save order and Cancel: Campfire's `.btn`, 40px tall, 44px for fingers. Disabled, each is dimmed as
 * Campfire dims a disabled submit button.
 */
const ACTION =
  "inline-flex min-h-10 cursor-pointer items-center justify-center rounded-[9px] border px-3.5 py-2 font-medium touch:min-h-11 disabled:cursor-not-allowed disabled:opacity-50 disabled:grayscale disabled:contrast-50";

/** What the unsaved changes dialog says about an order staged, as it says of a room's form. */
const ORDER_CHANGES = "You’ve changed the room order. Save it before you leave, or discard it to keep things as they were.";

/** Whether going to `path` keeps workspace settings, as Back and Forward between its sections do. */
const staysInSettings = (path: string) => path === WORKSPACE_SETTINGS_PATH;

interface Props {
  /** The rooms in this administrator's sidebar, but their DMs, in the order they were put in them. */
  rooms: SharedRoom[];
  /** The ones of them the shared order ranks, in its order. */
  sharedOrder: RoomId[];
  /** Called with the rooms of theirs the shared order ranks, as the server answers them, once an order is saved. */
  onSaved: (sharedOrder: RoomId[]) => void;
  /** Called with null when the session has expired. */
  onSessionChanged: (me: Me | null) => void;
}

/**
 * The order rooms come in for everyone, in workspace settings' Rooms and permissions: a row per room,
 * dragged by its grip or moved with Alt and an arrow (`useSharedOrder`), then Save order or Cancel. The
 * rest of each row links to the room's settings, saying who it's open to. What the list last said about
 * a move shows under it. Leaving the page with an order staged asks to save or discard it, as leaving a
 * room's form does.
 */
export function RoomOrder({ rooms, sharedOrder, onSaved, onSessionChanged }: Props) {
  const { order, moving, status, changed, saving, listRef, listProps, save, reset } = useSharedOrder({ rooms, sharedOrder, onSaved, onSessionChanged });
  const byId = useMemo(() => new Map(rooms.map((room) => [room.id, room])), [rooms]);
  const helpId = useId();

  /** Saves the order staged for the unsaved changes dialog, which says so when it isn't saved. */
  const saveBeforeLeaving = async () => {
    if (!(await save())) throw new Error("The room order wasn't saved");
  };

  return (
    <div className="border-t">
      <p id={helpId} className="my-[1em] text-[0.8em] text-muted-foreground">
        Drag a room to reorder your community sidebar. Click a room to set its permissions.
      </p>
      <div
        ref={listRef}
        {...listProps}
        role="list"
        aria-label="Room order"
        className={cn("max-h-[360px] overflow-y-auto overscroll-contain rounded-[10px] border bg-background", moving && "select-none")}
      >
        {order.map((id) => {
          const room = byId.get(id);
          if (!room) return null;
          return (
            <div
              key={id}
              role="listitem"
              tabIndex={0}
              data-room-id={id}
              aria-describedby={helpId}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              className={cn(
                "flex min-h-[52px] items-center gap-2.5 py-1 pr-3 pl-1 not-first:border-t focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-muted-foreground",
                id === moving && "bg-hover shadow-[inset_3px_0_var(--color-foreground)]",
              )}
            >
              {/* The grip, 44px wide, so a fingertip on it doesn't land on the row around it instead. */}
              <button
                type="button"
                data-room-order-handle
                aria-label={`Move ${room.name}`}
                title="Drag to reorder, or press Alt + Up / Down"
                className="inline-flex min-h-11 min-w-9 cursor-grab touch-none items-center justify-center rounded-md p-2 text-muted-foreground touch:min-w-11 hover:bg-hover hover:text-foreground"
              >
                <DotsGrid3x3 className="size-[18px]" />
              </button>
              {/* The room's settings, filling the row beside the grip, with who it's open to at its end. */}
              <PageLink
                href={roomSettingsPath(room.kind, room.id)}
                aria-label={`Settings for ${room.name}`}
                className="group flex min-w-0 flex-1 items-center gap-2.5 self-stretch"
              >
                <RoomIcon icon={room.icon} size={19} className="w-[18px] shrink-0 text-center text-[22px] leading-none text-muted-foreground" />
                <span className="min-w-0 truncate group-hover:underline">{room.name}</span>
                <span className="ml-auto shrink-0 rounded-full border bg-hover px-2 py-[3px] text-[11px] whitespace-nowrap text-muted-foreground">
                  {room.kind === "closed" ? "Selected people" : "Everyone"}
                </span>
              </PageLink>
            </div>
          );
        })}
      </div>
      {order.length === 0 && <p className="my-[1em] text-[0.8em] text-muted-foreground">No rooms to arrange yet.</p>}
      <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2">
        {/* Always there for screen readers to hear, it takes no room until it says something. */}
        <p role="status" aria-live="polite" className={cn("basis-full", status?.error ? "text-negative" : "text-muted-foreground", !status && "sr-only")}>
          {status?.message}
        </p>
        <button type="button" disabled={saving || !changed} onClick={reset} className={cn(ACTION, "bg-background text-foreground")}>
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || !changed}
          onClick={() => void save()}
          className={cn(ACTION, "border-transparent bg-foreground text-background hover:not-active:brightness-70")}
        >
          Save order
        </button>
      </div>
      <UnsavedChanges changed={changed} stays={staysInSettings} onSave={saveBeforeLeaving} description={ORDER_CHANGES} />
    </div>
  );
}
