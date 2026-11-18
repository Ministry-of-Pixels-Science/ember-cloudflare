import { useEffect, useState, type FormEvent } from "react";
import { MAX_HUDDLE_PEOPLE } from "@ember/protocol/huddles";
import { ArrowRight, Headset } from "@/components/icons/iconoir";
import { SetupCard, STEP_BUTTON } from "@/components/setup-card";
import { Button } from "@/components/ui/button";
import { HuddlesSteps, useHuddlesKeys } from "@/components/workspace/huddles-steps";
import { ApiError, fetchWorkspaceSettings, isSignedOut } from "@/lib/api";
import { HUDDLE_CHAT } from "@/lib/huddle-chat";
import { cn } from "@/lib/utils";

// First run's last step, once Ember has its administrator and this browser is signed in as them: whether
// to turn huddles on. Not now opens Ember, where the Huddles tab of community settings turns them on
// whenever it's wanted. Set up huddles shows the two steps that tab's dialog has (`HuddlesSteps`), and once
// Cloudflare has started a session with the app's keys, that huddles are on, from where Ember opens. It
// loads with the pages few visits need (pages.ts), apart from the rest of the app.

/** What the question asks, as the project's owner worded it (2026-11-12). */
export const QUESTION = `Would you like to enable ${HUDDLE_CHAT}?`;

/** What the question's card says of huddles, a line each. */
const FACTS: [string, string][] = [
  ["What it is", `Live ${HUDDLE_CHAT} in any room, for up to ${MAX_HUDDLE_PEOPLE} people in a huddle.`],
  ["What it needs", "A Realtime SFU app in your Cloudflare account. Creating one takes a couple of minutes."],
  ["What it costs", "Cloudflare gives a free monthly allowance, then bills your account for what's sent past it."],
];

/** What an alert says about saving that failed: the server's reason, or that Ember couldn't be reached. */
const reasonFor = (error: unknown) => (error instanceof ApiError ? error.message : "Couldn't reach Ember. Check your connection and try again.");

/** Asks whether to turn huddles on, sets them up if so, and has `onOpen` open Ember either way. */
export function SetupHuddles({ onOpen }: { onOpen: () => void }) {
  const [step, setStep] = useState<"question" | "steps" | "on">("question");
  const deployedAccountId = useDeployedAccountId();
  if (step === "question") return <Question onSetUp={() => setStep("steps")} onSkip={onOpen} />;
  if (step === "steps") return <Steps deployedAccountId={deployedAccountId} onBack={() => setStep("question")} onSaved={() => setStep("on")} onOpen={onOpen} />;
  return <HuddlesOn onOpen={onOpen} />;
}

/**
 * The Cloudflare account Ember is deployed to, which the steps' button opens the dashboard at, once Ember
 * says, if the deploy gave it. Until then, and without it, the dashboard asks someone with several which.
 */
function useDeployedAccountId(): string | null {
  const [accountId, setAccountId] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    fetchWorkspaceSettings().then(
      (settings) => current && setAccountId(settings.cloudflareAccountId),
      () => {},
    );
    return () => {
      current = false;
    };
  }, []);
  return accountId;
}

/** The question: what huddles are, what they need and what they cost, and the two answers. */
function Question({ onSetUp, onSkip }: { onSetUp: () => void; onSkip: () => void }) {
  return (
    <SetupCard startsAtTitle title={QUESTION} subtitle="Huddles let people in a room talk to each other live.">
      <div className="grid gap-6 px-5 pt-6 pb-7">
        <dl className="grid gap-4 text-base leading-normal text-pretty">
          {FACTS.map(([label, text]) => (
            <div key={label} className="grid grid-cols-[6.75rem_minmax(0,1fr)] gap-x-4 upto-480px:grid-cols-1 upto-480px:gap-y-0.5">
              <dt className="text-muted-foreground upto-480px:text-sm">{label}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm leading-normal text-muted-foreground">You can also turn it on later, in Admin under Huddles.</p>
      </div>
      <footer className="grid grid-cols-2 gap-3 border-t bg-surface p-5 upto-380px:grid-cols-1">
        <Button type="button" variant="outline" onClick={onSkip} className={cn(STEP_BUTTON, "bg-card")}>
          Not now
        </Button>
        <Button type="button" onClick={onSetUp} className={STEP_BUTTON}>
          Set up huddles <ArrowRight className="size-[1.125rem]" />
        </Button>
      </footer>
    </SetupCard>
  );
}

interface StepsProps {
  deployedAccountId: string | null;
  onBack: () => void;
  onSaved: () => void;
  onOpen: () => void;
}

/** Set up huddles' two steps, whose keys are saved once Cloudflare has started a session with them. */
function Steps({ deployedAccountId, onBack, onSaved, onOpen }: StepsProps) {
  const [problem, setProblem] = useState<string | null>(null);
  const keys = useHuddlesKeys({
    huddles: null,
    onSaved,
    // Whoever's been signed out can't give Ember anything here, so Ember opens, which has them sign in.
    onFailed: (error) => (isSignedOut(error) ? onOpen() : setProblem(reasonFor(error))),
  });
  const { saving } = keys;
  const save = (event: FormEvent) => {
    setProblem(null);
    keys.save(event);
  };
  return (
    <SetupCard startsAtTitle title="Set up huddles" subtitle="Two steps: one in Cloudflare, one here." problem={problem}>
      <form onSubmit={save} aria-busy={saving || undefined}>
        <div className="px-5 pt-6 pb-7">
          <HuddlesSteps keys={keys} deployedAccountId={deployedAccountId} roomy />
        </div>
        <footer className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 border-t bg-surface p-5 upto-380px:grid-cols-1">
          <Button type="button" variant="outline" disabled={saving} onClick={onBack} className={cn(STEP_BUTTON, "bg-card px-5")}>
            Back
          </Button>
          <Button type="submit" disabled={saving || !keys.typed} className={STEP_BUTTON}>
            {saving ? (
              "Checking…"
            ) : (
              <>
                Save and continue <ArrowRight className="size-[1.125rem]" />
              </>
            )}
          </Button>
        </footer>
      </form>
    </SetupCard>
  );
}

/** That huddles are on, and where one starts, before Ember opens. */
function HuddlesOn({ onOpen }: { onOpen: () => void }) {
  return (
    <SetupCard startsAtTitle title="Huddles are on" subtitle="Cloudflare accepted the app's keys.">
      <div className="grid gap-4 px-5 pt-6 pb-7">
        <div className="flex items-center gap-3.5 rounded-xl border bg-surface p-4">
          <span className="grid size-10 flex-none place-items-center rounded-[10px] border bg-card">
            <Headset className="size-5" />
          </span>
          <p className="text-base leading-normal">Start a huddle with the headphones at the top of any room.</p>
        </div>
        <p className="text-sm leading-normal text-muted-foreground">You can turn huddles off, or change the app, in Admin under Huddles.</p>
      </div>
      <footer className="border-t bg-surface p-5">
        <Button type="button" onClick={onOpen} className={cn(STEP_BUTTON, "w-full")}>
          Open Ember <ArrowRight className="size-[1.125rem]" />
        </Button>
      </footer>
    </SetupCard>
  );
}
