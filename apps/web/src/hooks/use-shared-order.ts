import { useMemo, useRef, useState } from "react";
import type { Me, RoomId, SharedRoom } from "@ember/protocol";
import { useMounted } from "@/hooks/use-mounted";
import { useRoomDrag, type OrderStatus } from "@/hooks/use-room-drag";
import { isSignedOut, setSharedOrder } from "@/lib/api";
import { inSidebarOrder } from "@/lib/room-list";

interface Options {
  /** The rooms in this administrator's sidebar, but their DMs, in the order they were put in them. */
  rooms: SharedRoom[];
  /** The ones of them the shared order ranks, in its order. */
  sharedOrder: RoomId[];
  /** Called with the rooms of theirs the shared order ranks, as the server answers them, once an order is saved. */
  onSaved: (sharedOrder: RoomId[]) => void;
  /** Called with null when the session has expired. */
  onSessionChanged: (me: Me | null) => void;
}

const sameOrder = (a: RoomId[], b: RoomId[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** `staged` without the rooms that aren't in `rooms` any more, and then the ones in it that weren't yet. */
function stillStaged(staged: RoomId[], rooms: RoomId[]): RoomId[] {
  const now = new Set(rooms);
  const kept = staged.filter((id) => now.has(id));
  const listed = new Set(kept);
  return [...kept, ...rooms.filter((id) => !listed.has(id))];
}

/**
 * The order an administrator puts their rooms in for everyone, staged on workspace settings (`staged`):
 * a row is dragged at once by its handle, or moved with Alt and an arrow (`useRoomDrag`), and each move
 * is only staged until Save order saves the whole list as the shared order, or Cancel puts it back as
 * saved. The rooms the shared order doesn't rank come after the ones it does, in the order the
 * administrator was put in them, as they do in the sidebar. A room that comes or goes meanwhile joins or
 * leaves what's staged, at its end.
 */
export function useSharedOrder({ rooms, sharedOrder, onSaved, onSessionChanged }: Options) {
  const [staged, setStaged] = useState<RoomId[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const mounted = useMounted();
  // The save under way, as it is now rather than as last drawn, which saving again waits for.
  const saved = useRef<Promise<boolean> | null>(null);

  const savedOrder = useMemo(() => inSidebarOrder(rooms, [], sharedOrder).map((room) => room.id), [rooms, sharedOrder]);
  const order = useMemo(() => (staged ? stillStaged(staged, savedOrder) : savedOrder), [staged, savedOrder]);
  const changed = !sameOrder(order, savedOrder);
  const nameOf = (roomId: RoomId) => rooms.find((room) => room.id === roomId)?.name ?? "";

  const drag = useRoomDrag({
    order,
    movable: order,
    holdMs: 0,
    grabs: (target) => target.closest("[data-room-order-handle]") !== null,
    isLocked: () => saved.current !== null,
    onDrag: (roomId) => setStatus({ message: `Moving ${nameOf(roomId)}. Release to place, or press Escape to cancel.`, error: false }),
    onMove: (moved) => {
      setStaged(moved);
      setStatus({ message: "Unsaved room order. Save to apply it to everyone.", error: false });
    },
    onCancel: () => setStatus({ message: "Room move canceled.", error: false }),
  });

  /**
   * Saves the order staged as the shared order, putting back a row being dragged, so what's saved is what
   * shows, and settles with whether it's saved, waiting for a save already under way rather than saving again.
   */
  function save(): Promise<boolean> {
    if (saved.current) return saved.current;
    if (!changed) return Promise.resolve(true);
    drag.release();
    setSaving(true);
    setStatus({ message: "Saving room order…", error: false });
    saved.current = send().finally(() => {
      saved.current = null;
      if (mounted.current) setSaving(false);
    });
    return saved.current;
  }

  /** Sends the order staged, saying how that went, and settles with whether it's saved. */
  async function send(): Promise<boolean> {
    try {
      onSaved(await setSharedOrder(order));
      if (mounted.current) {
        setStaged(null);
        setStatus({ message: "Room order saved for everyone.", error: false });
      }
      return true;
    } catch (error) {
      // Once another person's workspace has taken this one's place, the session it hears about is gone.
      if (!mounted.current) return false;
      if (isSignedOut(error)) onSessionChanged(null);
      else setStatus({ message: "Couldn’t save room order. Please try again.", error: true });
      return false;
    }
  }

  /** Puts the rows back in the order saved, a row being dragged included. */
  function reset() {
    if (saved.current) return;
    drag.release();
    setStaged(null);
    setStatus(null);
  }

  return { order: drag.order, moving: drag.moving, status, changed, saving, listRef: drag.listRef, listProps: drag.listProps, save, reset };
}
