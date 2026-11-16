import type { Room, UserId } from "@ember/protocol";
import { Microphone, MicrophoneMute, ModernTv, VideoCamera, VideoCameraOff } from "@/components/icons/iconoir";
import { useCamerasAllowed, useScreensAllowed } from "@/hooks/use-account";
import { useNameOf } from "@/hooks/use-directory";
import { roomName } from "@/lib/directs";
import { sharesScreens } from "@/lib/huddle-devices";
import { leaveHuddle, muteHuddle, shareHuddleScreen, showHuddleCamera, type JoinedHuddle } from "@/lib/huddle-store";
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

/**
 * Turns the tab's camera on in its huddle, which has the browser ask for it the first time, or off.
 * While an administrator has cameras off there's none to turn on, so it's there only to turn off one
 * that's on still.
 */
export function CameraTool({ huddle, className }: { huddle: JoinedHuddle; className?: string }) {
  const allowed = useCamerasAllowed();
  const on = huddle.camera !== null;
  if (!allowed && !on) return null;
  const label = on ? "Turn off camera" : "Turn on camera";
  return (
    <button type="button" title={label} aria-label={label} onClick={() => showHuddleCamera(!on)} className={cn(TOOL, on ? TOOL_ON : TOOL_OFF, className)}>
      {on ? <VideoCamera /> : <VideoCameraOff />}
    </button>
  );
}

/**
 * Shares the tab's screen in its huddle, which has the browser ask what to share, or stops sharing it.
 * It's there in a browser that can share one, which a phone's can't, and while an administrator has
 * screen sharing off, only to stop one that's shared still.
 */
export function ScreenTool({ huddle, className }: { huddle: JoinedHuddle; className?: string }) {
  const allowed = useScreensAllowed();
  const shared = huddle.screen !== null;
  if (!shared && !(allowed && sharesScreens())) return null;
  const label = shared ? "Stop sharing screen" : "Share screen";
  return (
    <button type="button" title={label} aria-label={label} onClick={() => shareHuddleScreen(!shared)} className={cn(TOOL, shared ? TOOL_ON : TOOL_OFF, className)}>
      <ModernTv />
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
