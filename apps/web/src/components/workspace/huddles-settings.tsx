import { useState, type ComponentType } from "react";
import type { AccountSettings, WorkspaceSettings } from "@ember/protocol";
import { Computer, VideoCamera, type IconoirIconProps } from "@/components/icons/iconoir";
import { Switch } from "@/components/ui/switch";
import { useCamerasAllowed, useScreensAllowed } from "@/hooks/use-account";
import { useMounted } from "@/hooks/use-mounted";
import { forgetHuddles, isSignedOut } from "@/lib/api";
import { HUDDLE_CHAT_TITLE } from "@/lib/huddle-chat";
import { cn } from "@/lib/utils";
import { BUTTON } from "./email-settings";

// The card on the Huddles tab, for administrators, named as first run's question names huddles
// (`HUDDLE_CHAT`): whether Ember has what huddles run through, which is Cloudflare's Realtime SFU, by an
// SFU app in the Cloudflare account of whoever runs Ember, whose keys an administrator gives it. Its
// switch says whether it has, as Turnstile's does. Turning it on opens Set up huddles (`HuddlesSetup`),
// as switches open setup that's missing, as the project's owner asked (2026-10-26), and turning it off
// forgets the app's keys, which ends any huddle going on once its room next checks, within half a
// minute. Change keys opens the setup with the app's ID as it is. While huddles are on, a second card
// has what people may do in one, each on until an administrator turns it off: Cameras, which off keeps
// huddles to voices and takes down the cameras that are on, and Screen sharing, which off stops the
// screens people share.

/** What the card says of huddles while they're off. */
export const HUDDLES_EXPLAINED =
  "Huddles let people in a room talk to each other live. They run through Cloudflare's Realtime SFU, with an app in your Cloudflare account.";

/** What turning huddles off asks first. */
export const CONFIRM_STOP_HUDDLES = "Are you sure you want to turn off huddles? Any huddle going on will end, and Ember will forget the SFU app's keys.";

/** What the second card says its Cameras switch lets people do, and its Screen sharing switch. */
export const CAMERAS_EXPLAINED = "People can turn their camera on in a huddle.";
export const SCREENS_EXPLAINED = "People can share their screen in a huddle, from a computer.";

const CARD = "flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3";
const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

interface Props {
  huddles: WorkspaceSettings["huddles"];
  /** Opens Set up huddles. */
  onSetUp: () => void;
  /** Shows that huddles are off, once turning them off has forgotten the app's keys. */
  onStopped: () => void;
  /** Says why turning them off failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Whether huddles are on, for administrators, and through which SFU app they run, or else what huddles would add. */
export function HuddlesSettings({ huddles, onSetUp, onStopped, onFailed }: Props) {
  const [stopping, setStopping] = useState(false);
  const mounted = useMounted();

  const stop = () => {
    if (!confirm(CONFIRM_STOP_HUDDLES)) return;
    setStopping(true);
    forgetHuddles().then(
      () => {
        onStopped();
        if (mounted.current) setStopping(false);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setStopping(false);
        onFailed(error);
      },
    );
  };

  return (
    <section aria-labelledby="huddles-heading" className={CARD}>
      <div className="flex items-center gap-x-[1ch] gap-y-4">
        <div className="min-w-0 flex-1">
          <h2 id="huddles-heading" className="text-base font-semibold">
            {HUDDLE_CHAT_TITLE}
          </h2>
          <p id="huddles-description" className={NOTE}>
            {huddles === null ? (
              HUDDLES_EXPLAINED
            ) : (
              <>
                Huddles run through the Realtime SFU app <strong className="font-semibold wrap-anywhere">{huddles.appId}</strong> in your Cloudflare account.
              </>
            )}
          </p>
        </div>
        <Switch
          checked={huddles !== null && !stopping}
          onCheckedChange={(on) => (on ? onSetUp() : stop())}
          disabled={stopping}
          aria-labelledby="huddles-heading"
          aria-describedby="huddles-description"
        />
      </div>
      {huddles !== null && (
        <div>
          <button type="button" onClick={onSetUp} disabled={stopping} className={BUTTON}>
            Change keys
          </button>
        </div>
      )}
    </section>
  );
}

interface SwitchesProps {
  /** Saves a switch at once, then calls `settled`, as the settings' other switches are saved. */
  saveSwitch: (settings: AccountSettings, settled: () => void) => void;
}

/**
 * What people may do in a huddle, for administrators, which the tab shows while huddles are on: turn
 * their camera on, and share their screen, a row for each.
 */
export function HuddleSwitches({ saveSwitch }: SwitchesProps) {
  const cameras = useCamerasAllowed();
  const screens = useScreensAllowed();
  return (
    <div className={cn(CARD, "gap-0 py-1")}>
      <HuddleSwitch id="huddle-cameras" title="Cameras" icon={VideoCamera} explained={CAMERAS_EXPLAINED} on={cameras} save={(on, settled) => saveSwitch({ huddleCameras: on }, settled)} />
      <HuddleSwitch id="huddle-screens" title="Screen sharing" icon={Computer} explained={SCREENS_EXPLAINED} on={screens} save={(on, settled) => saveSwitch({ huddleScreens: on }, settled)} className="border-t" />
    </div>
  );
}

interface SwitchProps {
  /** What the row's heading and description are called in the page, which name and describe its switch. */
  id: string;
  title: string;
  icon: ComponentType<IconoirIconProps>;
  explained: string;
  /** Whether the workspace has it on. */
  on: boolean;
  /** Saves where the switch was moved to, then calls `settled`. */
  save: (on: boolean, settled: () => void) => void;
  className?: string;
}

/** One of the things people may do in a huddle: what it is, a line about it, and its switch, saved at once. */
function HuddleSwitch({ id, title, icon: Icon, explained, on, save, className }: SwitchProps) {
  // Where the switch was moved to, while that's saved.
  const [moved, setMoved] = useState<boolean | null>(null);

  const move = (to: boolean) => {
    if (moved !== null) return;
    setMoved(to);
    save(to, () => setMoved(null));
  };

  return (
    <section aria-labelledby={`${id}-heading`} className={cn("flex items-center gap-x-[1ch] gap-y-4 py-3", className)}>
      <Icon className="size-[18px] flex-none" />
      <div className="min-w-0 flex-1">
        <h2 id={`${id}-heading`} className="text-base font-semibold">
          {title}
        </h2>
        <p id={`${id}-description`} className={NOTE}>
          {explained}
        </p>
      </div>
      <Switch checked={moved ?? on} onCheckedChange={move} aria-labelledby={`${id}-heading`} aria-describedby={`${id}-description`} />
    </section>
  );
}
