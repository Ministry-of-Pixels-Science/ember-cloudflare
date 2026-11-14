import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { useMounted } from "@/hooks/use-mounted";
import { changeOutsideAi, isSignedOut } from "@/lib/api";
import { outsideAddress } from "./your-outside-ai";

// The Outside AI card on the AI assistant tab, for administrators: a switch that lets the people in the
// workspace connect AI apps, such as Claude and ChatGPT, to Ember, each as themselves. It's apart from
// Ember AI, whose agents answer in the rooms: an app that connects reads Ember from outside it, with
// what the person who connected it can see. Off until an administrator turns it on, and turning it off
// asks first, as it disconnects every app.

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** What the card says of letting AI apps connect, and of what turning it off does. */
export const OUTSIDE_AI_SETTING_EXPLAINED =
  "Let people connect AI apps, such as Claude and ChatGPT, to Ember as themselves. Each person allows an app on a page here first, and it can then see the rooms they're in, read their messages and search them. People who signed in with just a name can't. Turning this off disconnects every app.";

/** What turning it off asks first. */
export const CONFIRM_STOP_OUTSIDE_AI = "Are you sure you want to stop AI apps connecting to Ember? Every app people have connected will be disconnected.";

/** What the card says while it's on: the address people give an AI app, which their profile shows them too. */
export const outsideAiAddress = (address: string) => `People give an AI app this address, which their profile shows them: ${address}`;

interface Props {
  /** Whether AI apps may connect. */
  on: boolean;
  /** Shows whether they may, once the switch has changed it. */
  onChanged: (on: boolean) => void;
  /** Says why changing it failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** The Outside AI card: whether AI apps may connect, with the switch that changes it. */
export function OutsideAiSettings({ on, onChanged, onFailed }: Props) {
  /** What the switch is being changed to, until Ember answers. */
  const [turning, setTurning] = useState<boolean | null>(null);
  const mounted = useMounted();

  const turn = (to: boolean) => {
    if (turning !== null || (!to && !confirm(CONFIRM_STOP_OUTSIDE_AI))) return;
    setTurning(to);
    changeOutsideAi(to).then(
      (settings) => {
        onChanged(settings.on);
        if (mounted.current) setTurning(null);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setTurning(null);
        onFailed(error);
      },
    );
  };

  return (
    <section aria-labelledby="outside-ai-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div className="flex flex-wrap items-center gap-x-[1ch] gap-y-3">
        <div className="min-w-[16em] flex-1">
          <h2 id="outside-ai-heading" className="text-base font-semibold">
            Outside AI
          </h2>
          <p id="outside-ai-description" className={NOTE}>
            {OUTSIDE_AI_SETTING_EXPLAINED}
          </p>
        </div>
        <Switch checked={turning ?? on} disabled={turning !== null} onCheckedChange={turn} aria-label="Let AI apps connect to Ember" aria-describedby="outside-ai-description" />
      </div>
      {on && <p className={`${NOTE} wrap-anywhere`}>{outsideAiAddress(outsideAddress())}</p>}
    </section>
  );
}
