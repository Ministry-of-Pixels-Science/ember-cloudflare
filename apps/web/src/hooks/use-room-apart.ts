import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CloseCode, parseServerFrame, type RoomId, type ServerFrame, type UserId } from "@ember/protocol";
import { roomSocketUrl } from "@/lib/api";
import { reconnectingSocket, type ReconnectingSocket } from "@/lib/reconnecting-socket";
import type { ConnectionStatus } from "@/lib/room-state";
import { settledVisibility } from "@/lib/visibility";
import type { RoomFrames } from "./use-room";

type RoomError = Extract<ServerFrame, { type: "error" }>;

/**
 * Whether an error is the room's to say, as a room's timeline says one: not one about opening a thread
 * or paging through it, nor about messages being sent, which over this socket are a thread's replies,
 * and the thread's own to show.
 */
const isRoomsToSay = (frame: ServerFrame): frame is RoomError =>
  frame.type === "error" && frame.failed !== "thread.open" && frame.failed !== "thread.before" && frame.clientMessageId === undefined && frame.clientMessageIds === undefined;

/**
 * A socket of room `roomId`'s that shows a part of the room apart from its timeline, as a huddle shows
 * its thread beside the people in it, for the person `meId` names: what a thread takes of a room's
 * socket, with the room's `status`, whether the page is `offline`, and what the room has to say of what
 * it refused, its `notice`. Its person isn't in the room for it: the room neither counts them among
 * who's here, nor reads itself for them through it, nor takes them to be there to see what's said in
 * it. They view the thread it has open, while the tab is shown, which the socket tells the room as a
 * room's own does.
 */
export function useRoomApart(roomId: RoomId, meId: UserId) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const socket = useRef<ReconnectingSocket | null>(null);
  const listeners = useRef(new Set<(frame: ServerFrame) => void>());

  useEffect(() => {
    // As useRoom tells the room: once the tab has been shown or hidden for a while, unless the socket's
    // address or an earlier frame said so already.
    let told: boolean;
    const tellVisibility = (visible: boolean) => {
      if (visible !== told && room.send({ type: "presence.visible", visible })) told = visible;
    };
    const visibility = settledVisibility(tellVisibility);

    const room = reconnectingSocket({
      url: () => roomSocketUrl(roomId, { visible: (told = visibility.visible), apart: true }),
      onMessage: (data) => {
        const frame = parseServerFrame(data);
        if (!frame) return;
        if (frame.type === "welcome" || frame.type === "resumed") {
          // The browser has signed in as someone else since, whom the app hands over to, as the room's
          // own socket has it do: nothing of theirs shows here, and nothing goes as them. It connects
          // again after the usual wait, should the browser be this person's again by then.
          if (frame.you.id !== meId) {
            room.hold();
            return room.retry();
          }
          room.connected();
          tellVisibility(visibility.visible);
          setStatus("open");
        }
        if (isRoomsToSay(frame)) setNotice(frame.message);
        for (const listener of listeners.current) listener(frame);
      },
      onConnecting: setStatus,
      onOffline: setOffline,
      // The room is gone for this person, or they've lost their access, which leaves nothing to connect to.
      onClose: (code) => {
        if (code !== CloseCode.Revoked && code !== CloseCode.NotFound) return true;
        setStatus("gone");
        return false;
      },
    });
    socket.current = room;
    return () => {
      visibility.stop();
      room.close();
      socket.current = null;
    };
  }, [roomId, meId]);

  const frames = useMemo<RoomFrames>(
    () => ({
      send: (frame) => socket.current?.send(frame) ?? false,
      listen: (listener) => {
        listeners.current.add(listener);
        return () => void listeners.current.delete(listener);
      },
    }),
    [],
  );
  const dismissNotice = useCallback(() => setNotice(null), []);

  return { frames, status, offline, notice, dismissNotice };
}
