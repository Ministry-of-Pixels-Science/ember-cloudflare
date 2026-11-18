import { useState } from "react";
import { HUDDLE_SOUNDS, type HuddleSound, type HuddleSoundChanges, type HuddleSounds } from "@ember/protocol/huddles";
import { Switch } from "@/components/ui/switch";
import { useMounted } from "@/hooks/use-mounted";
import { changeHuddleSounds, isSignedOut } from "@/lib/api";

/** What the switch of each of a huddle's sounds says it does, as the boxes in Slack's preferences say of its sounds. */
export const HUDDLE_SOUND_LABELS: Record<HuddleSound, string> = {
  music: "Play music when you're the only one in a huddle",
  chimes: "Play a sound when someone joins or leaves",
  ring: "Ring when someone invites you to a huddle",
};

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

interface Props {
  /** Which of a huddle's sounds you hear, as the sidebar's list has them. */
  sounds: HuddleSounds;
  /** Called as a switch saves a sound, with what keeps the sounds the server answers. */
  askForSounds: () => (sounds: HuddleSounds) => void;
  /** Says why a switch couldn't save a sound, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * Huddle sounds on your profile: a switch for each of a huddle's own sounds, its music while you're the
 * only one in it, its sounds of someone joining and leaving, and the ring of an invitation into one.
 * Each is saved at once, with your account, as Slack keeps its preferences, so it holds in every browser
 * you're signed in on, and the huddle you're in goes by it from then.
 */
export function HuddleSoundSwitches({ sounds, askForSounds, onFailed }: Props) {
  const mounted = useMounted();

  const save = async (changes: HuddleSoundChanges) => {
    const answered = askForSounds();
    try {
      answered(await changeHuddleSounds(changes));
    } catch (error) {
      if (mounted.current || isSignedOut(error)) onFailed(error);
    }
  };

  return (
    <section aria-labelledby="huddle-sounds-heading" className="flex flex-col gap-4 rounded-[10px] border bg-surface px-[2ch] py-4 max-md:px-3">
      <div>
        <h2 id="huddle-sounds-heading" className="text-base font-semibold">
          Huddle sounds
        </h2>
        <p className={NOTE}>Choose which huddle sounds you hear. Your choices apply everywhere you're signed in.</p>
      </div>
      {HUDDLE_SOUNDS.map((sound) => (
        <SoundSwitch key={sound} id={`huddle-sound-${sound}`} label={HUDDLE_SOUND_LABELS[sound]} on={sounds[sound]} save={(on) => save({ [sound]: on })} />
      ))}
    </section>
  );
}

interface SwitchProps {
  /** What the row's label is called in the page, which names its switch. */
  id: string;
  label: string;
  /** Whether you hear the sound. */
  on: boolean;
  /** Saves where the switch was moved to, settling once it has, or has failed to. */
  save: (on: boolean) => Promise<void>;
}

/** One of a huddle's sounds: what its switch does, and the switch, saved at once. */
function SoundSwitch({ id, label, on, save }: SwitchProps) {
  // Where the switch was moved to, while that's saved.
  const [moved, setMoved] = useState<boolean | null>(null);

  const move = async (to: boolean) => {
    if (moved !== null) return;
    setMoved(to);
    await save(to);
    setMoved(null);
  };

  return (
    <div className="flex items-center gap-x-[1.5ch] border-t pt-4">
      <div id={id} className="min-w-0 flex-1">
        {label}
      </div>
      <Switch checked={moved ?? on} onCheckedChange={move} aria-labelledby={id} />
    </div>
  );
}
