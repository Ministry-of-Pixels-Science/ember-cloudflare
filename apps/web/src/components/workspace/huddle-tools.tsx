import { useEffect, useRef, useState, type Ref } from "react";
import type { Room, UserId } from "@ember/protocol";
import { MessageText, Microphone, MicrophoneMute, ModernTv, MoreVert, RotateCameraRight, UserPlus, VideoCamera, VideoCameraOff } from "@/components/icons/iconoir";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCamerasAllowed, useScreensAllowed } from "@/hooks/use-account";
import { useNameOf } from "@/hooks/use-directory";
import { roomName } from "@/lib/directs";
import { listDevices, sharesScreens, watchDevices } from "@/lib/huddle-devices";
import { huddlePlace } from "@/lib/huddle-people";
import { leaveHuddle, muteHuddle, shareHuddleScreen, showHuddleCamera, switchHuddleCamera, type JoinedHuddle } from "@/lib/huddle-store";
import { muteShortcut } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { CameraMenu, MicrophoneMenu } from "./huddle-device-menu";
import { ShortcutTooltip } from "./shortcut-tooltip";

/** A huddle button: a 40px square, 44px for fingers, filled in ink while what it switches is on. */
export const TOOL = "grid h-10 min-w-10 cursor-pointer place-items-center rounded-lg touch:h-11 touch:min-w-11 disabled:cursor-default disabled:opacity-50 [&_svg]:size-5";
export const TOOL_OFF = "bg-hover text-foreground enabled:hover:bg-foreground/12";
export const TOOL_ON = "bg-foreground text-background";
/**
 * A huddle button with an arrow beside it, and the arrow, which opens the menu of the devices the
 * button uses. The two are one shape, parted by a line. Phones leave the arrow out, as Slack's do.
 */
const BESIDE_ARROW = "md:rounded-r-none";
const ARROW = "min-w-6 rounded-l-none border-l border-background max-md:hidden [&_svg]:size-3.5";
/** What a phone has in the camera's arrow's place. */
const IN_ARROWS_PLACE = "md:hidden";

/**
 * What the tab's huddle is called, on its bar and opened: by its room, "Huddle in Launch", by who it's
 * with in a direct message, "Huddle with Priya Patel", or just Huddle once the room isn't among this
 * person's.
 */
export function useHuddleName(room: Room | null, meId: UserId): string {
  const nameOf = useNameOf();
  return room ? `Huddle ${huddlePlace(room, roomName(room, meId, nameOf))}` : "Huddle";
}

/** What a huddle says in place of who's in it, until the room has let the tab in, and while its connection to the room is down. */
export const waitingToJoin = (huddle: JoinedHuddle) => (huddle.connected ? null : huddle.you ? "Reconnecting…" : "Connecting…");

interface ToolProps {
  huddle: JoinedHuddle;
  /** Whether it has the arrow beside it that chooses among its devices, as it does in the huddle opened. */
  devices?: boolean;
  className?: string;
}

/**
 * Mutes the tab's microphone in its huddle, or unmutes it, and says so when it has none. Its arrow
 * chooses the microphone, and the speaker the huddle plays through.
 */
export function MicrophoneTool({ huddle, devices = false }: ToolProps) {
  const silent = huddle.muted || !huddle.microphone;
  const label = !huddle.microphone ? "No microphone" : huddle.muted ? "Unmute microphone" : "Mute microphone";
  const look = silent ? TOOL_OFF : TOOL_ON;
  const tool = (
    <ShortcutTooltip label={label} shortcut={muteShortcut()}>
      <button type="button" aria-label={label} disabled={!huddle.microphone} onClick={() => muteHuddle(!huddle.muted)} className={cn(TOOL, look, devices && BESIDE_ARROW)}>
        {silent ? <MicrophoneMute /> : <Microphone />}
      </button>
    </ShortcutTooltip>
  );
  if (!devices) return tool;
  return (
    <span className="flex">
      {tool}
      <MicrophoneMenu huddle={huddle} className={cn(TOOL, look, ARROW)} />
    </span>
  );
}

/**
 * Turns the tab's camera on in its huddle, which has the browser ask for it the first time, or off.
 * Its arrow chooses the camera. While an administrator has cameras off there's none to turn on or to
 * choose, so it's there only to turn off one that's on still.
 */
export function CameraTool({ huddle, devices = false, className }: ToolProps) {
  const allowed = useCamerasAllowed();
  const on = huddle.camera !== null;
  if (!allowed && !on) return null;
  const label = on ? "Turn off camera" : "Turn on camera";
  const look = on ? TOOL_ON : TOOL_OFF;
  const chooses = devices && allowed;
  const tool = (
    <button type="button" title={label} aria-label={label} onClick={() => showHuddleCamera(!on)} className={cn(TOOL, look, chooses && BESIDE_ARROW, className)}>
      {on ? <VideoCamera /> : <VideoCameraOff />}
    </button>
  );
  if (!chooses) return tool;
  return (
    <span className="flex">
      {tool}
      <CameraMenu huddle={huddle} className={cn(TOOL, look, ARROW)} />
    </span>
  );
}

/**
 * Whether the browser lists a camera besides the one that's `on`, which it's asked as that turns on,
 * when it names them, and again whenever one is plugged in or taken away.
 */
function useHasAnotherCamera(on: boolean): boolean {
  const [cameras, setCameras] = useState(0);
  useEffect(() => {
    if (!on) return;
    const count = async () => setCameras((await listDevices()).cameras.length);
    void count();
    return watchDevices(() => void count());
  }, [on]);
  return on && cameras > 1;
}

/**
 * Switches the tab's camera in its huddle to the one that faces the other way, as from a phone's front
 * camera to its back one, or to the next the browser lists. It's there in the place of the arrow that
 * chooses a camera, where the huddle has none, as on a phone, while the camera is on and the browser
 * has another.
 */
export function SwitchCameraTool({ huddle }: { huddle: JoinedHuddle }) {
  const allowed = useCamerasAllowed();
  const another = useHasAnotherCamera(huddle.camera !== null);
  if (!allowed || !another) return null;
  return (
    <button type="button" title="Switch camera" aria-label="Switch camera" onClick={switchHuddleCamera} className={cn(TOOL, TOOL_OFF, IN_ARROWS_PLACE)}>
      <RotateCameraRight />
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

/**
 * Shows the huddle's thread beside the people in it, or closes it, and is filled in ink while it shows:
 * after the screen and before More, where Slack's is. The huddle opened has it where it has room for
 * the thread.
 */
export function ThreadTool({ shown, onShow, ref }: { shown: boolean; onShow: (shown: boolean) => void; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button ref={ref} type="button" title="Thread" aria-label="Thread" aria-pressed={shown} onClick={() => onShow(!shown)} className={cn(TOOL, shown ? TOOL_ON : TOOL_OFF)}>
      <MessageText />
    </button>
  );
}

/** Opens Invite people from a button, which has the focus back once it closes. */
type Invite = (opener: HTMLElement) => void;

/** Invite people, which opens the list of the room's people to invite into the huddle: a button of its own where the huddle opened has room for one, as on a computer. */
export function InviteTool({ onInvite }: { onInvite: Invite }) {
  return (
    <button type="button" title="Invite people" aria-label="Invite people" onClick={(event) => onInvite(event.currentTarget)} className={cn(TOOL, TOOL_OFF)}>
      <UserPlus />
    </button>
  );
}

/**
 * More, last of the huddle's buttons on a phone, where Slack's is, whose menu has what a phone has no
 * room to give a button: Invite people. The list opens once the menu has closed, when the menu has let
 * go of the page and of the focus, which the list takes in place of the button.
 */
export function MoreTool({ onInvite }: { onInvite: Invite }) {
  const button = useRef<HTMLButtonElement>(null);
  const inviting = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger ref={button} title="More" aria-label="More" className={cn(TOOL, TOOL_OFF, "md:hidden")}>
        <MoreVert />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        sideOffset={8}
        className="min-w-[200px]"
        onCloseAutoFocus={(event) => {
          if (!inviting.current || !button.current) return;
          inviting.current = false;
          event.preventDefault();
          onInvite(button.current);
        }}
      >
        <DropdownMenuItem onSelect={() => void (inviting.current = true)}>
          <UserPlus />
          Invite people
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
