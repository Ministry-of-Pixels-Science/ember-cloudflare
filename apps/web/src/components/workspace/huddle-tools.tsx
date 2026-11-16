import type { Room, UserId } from "@ember/protocol";
import { Microphone, MicrophoneMute, VideoCamera, VideoCameraOff } from "@/components/icons/iconoir";
import { useNameOf } from "@/hooks/use-directory";
import { roomName } from "@/lib/directs";
import { leaveHuddle, muteHuddle, showHuddleCamera, type JoinedHuddle } from "@/lib/huddle-store";
import { muteShortcut } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { ShortcutTooltip } from "./shortcut-tooltip";

/** A huddle button: a 40px square, 44px for fingers, filled in ink while what it switches is on. */
export const TOOL = "grid h-10 min-w-10 cursor-pointer place-items-center rounded-lg touch:h-11 touch:min-w-11 disabled:cursor-default disabled:opacity-50 [&_svg]:size-5";
export const TOOL_OFF = "bg-hover text-foreground enabled:hover:bg-foreground/12";
export const TOOL_ON = "bg-foreground text-background";

/** What the tab's huddle is called, on its bar and opened: by its room, or just Huddle once the room isn't among this person's. */
export function useHuddleName(room: Room | null, meId: UserId): string {
  const nameOf = useNameOf();
  return room ? `Huddle in ${roomName(room, meId, nameOf)}` : "Huddle";
}

/** What a huddle says in place of who's in it, until the room has let the tab in, and while its connection to the room is down. */
export const waitingToJoin = (huddle: JoinedHuddle) => (huddle.connected ? null : huddle.you ? "Reconnecting…" : "Connecting…");

/** Mutes the tab's microphone in its huddle, or unmutes it, and says so when it has none. */
export function MicrophoneTool({ huddle }: { huddle: JoinedHuddle }) {
  const silent = huddle.muted || !huddle.microphone;
  const label = !huddle.microphone ? "No microphone" : huddle.muted ? "Unmute microphone" : "Mute microphone";
  return (
    <ShortcutTooltip label={label} shortcut={muteShortcut()}>
      <button type="button" aria-label={label} disabled={!huddle.microphone} onClick={() => muteHuddle(!huddle.muted)} className={cn(TOOL, silent ? TOOL_OFF : TOOL_ON)}>
        {silent ? <MicrophoneMute /> : <Microphone />}
      </button>
    </ShortcutTooltip>
  );
}

/** Turns the tab's camera on in its huddle, which has the browser ask for it the first time, or off. */
export function CameraTool({ huddle, className }: { huddle: JoinedHuddle; className?: string }) {
  const on = huddle.camera !== null;
  const label = on ? "Turn off camera" : "Turn on camera";
  return (
    <button type="button" title={label} aria-label={label} onClick={() => showHuddleCamera(!on)} className={cn(TOOL, on ? TOOL_ON : TOOL_OFF, className)}>
      {on ? <VideoCamera /> : <VideoCameraOff />}
    </button>
  );
}

/** Leave, in red and in words, last on the huddle's bar and in the huddle opened, as Slack's is. */
export function LeaveButton() {
  return (
    <button
      type="button"
      onClick={leaveHuddle}
      className="inline-flex h-10 shrink-0 cursor-pointer items-center rounded-lg bg-negative-button px-4 text-[15px] font-semibold text-white hover:brightness-90 touch:h-11"
    >
      Leave
    </button>
  );
}
