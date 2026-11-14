import { useEffect, useState } from "react";
import type { Me } from "@ember/protocol";
import { OUTSIDE_SCOPE_EXPLAINED, outsideAskOf, type OutsideAsked } from "@ember/protocol/outside";
import { AuthCard, AuthHeading, AuthPage, type SignedOutWorkspace } from "@/components/auth-page";
import { PRIMARY_BUTTON } from "@/components/field";
import { Button } from "@/components/ui/button";
import { useMounted } from "@/hooks/use-mounted";
import { useTitle } from "@/hooks/use-title";
import { answerOutsideAsk, ApiError, describeOutsideAsk, isSignedOut } from "@/lib/api";
import { loadPage } from "@/lib/page";
import { rememberThisPage } from "@/lib/return-path";

// The page an AI app, such as Claude, sends your browser to when you connect it to Ember: it says which
// app asks, where your browser goes back to, and what the app would be able to do as you, and sends you
// back to the app with your answer. The request is in the address, as OAuth puts it there, and stays
// there until you answer, so that signing in first comes back to it.

const SIGN_IN_PATH = "/session/new";
const NO_CONNECTION = "Couldn't reach Ember. Check your connection and try again.";

/** What the page says of where the browser goes back to, which is what tells whose the app is: its name is only what it calls itself. */
export const comesBackTo = (host: string) => `You'll go back to ${host}. Allow this only if that's where you started.`;

/** Don't allow: the primary button's size, without its color. */
const SECONDARY_BUTTON = "h-auto min-h-[42px] w-full rounded-[9px] px-4 py-2.5 text-sm font-[550] touch:min-h-11";

/** Why something failed, in Ember's words, or null once the session has ended, when the page goes to sign in again, and back here. */
function problemOf(error: unknown): string | null {
  if (!isSignedOut(error)) return error instanceof ApiError ? error.message : NO_CONNECTION;
  rememberThisPage();
  loadPage(SIGN_IN_PATH);
  return null;
}

interface Props {
  me: Me;
  workspace: SignedOutWorkspace;
}

/**
 * Asks whether to connect the AI app whose request the address carries to Ember as you: Allow sends
 * your browser back to the app with a code it exchanges for its access, and Don't allow sends it back
 * saying you didn't. A request Ember can't answer says so, with the way home, and goes nowhere.
 */
export function OutsideConnectPage({ me, workspace }: Props) {
  const [ask] = useState(() => outsideAskOf(new URLSearchParams(location.search)));
  const [asked, setAsked] = useState<OutsideAsked | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);
  const mounted = useMounted();
  useTitle("Connect an AI app");

  useEffect(() => {
    let stopped = false;
    describeOutsideAsk(ask).then(
      (asked) => !stopped && setAsked(asked),
      (error: unknown) => !stopped && setProblem(problemOf(error)),
    );
    return () => void (stopped = true);
  }, [ask]);

  const answer = (allow: boolean) => {
    setAnswering(true);
    answerOutsideAsk(ask, allow).then(
      // The app's page takes this one's place, so Back doesn't come back to a request that's answered.
      (redirectTo) => loadPage(redirectTo),
      (error: unknown) => {
        if (!mounted.current) return;
        setAnswering(false);
        setProblem(problemOf(error));
      },
    );
  };

  if (problem !== null) {
    return (
      <AuthPage workspace={workspace}>
        <AuthCard>
          <AuthHeading title="This app can't be connected" logo={workspace.account.logo}>
            <span role="alert">{problem}</span>
          </AuthHeading>
          <Button asChild variant="outline" className={SECONDARY_BUTTON}>
            <a href="/">Back to {workspace.account.name}</a>
          </Button>
        </AuthCard>
      </AuthPage>
    );
  }
  return (
    <AuthPage workspace={workspace}>
      {asked && (
        <AuthCard>
          <AuthHeading title={`Connect ${asked.name} to ${asked.workspace}?`} logo={workspace.account.logo}>
            It would act as you, {me.name}.
          </AuthHeading>
          <div className="flex flex-col gap-5">
            <div>
              <p className="mb-2 font-medium">It will be able to:</p>
              <ul className="list-disc ps-5">
                {asked.scopes.map((scope) => (
                  <li key={scope}>{OUTSIDE_SCOPE_EXPLAINED[scope]}</li>
                ))}
              </ul>
            </div>
            <p className="text-muted-foreground wrap-anywhere">{comesBackTo(asked.comesBackTo)}</p>
            <div className="flex flex-col gap-3">
              <Button type="button" disabled={answering} onClick={() => answer(true)} className={PRIMARY_BUTTON}>
                Allow
              </Button>
              <Button type="button" variant="outline" disabled={answering} onClick={() => answer(false)} className={SECONDARY_BUTTON}>
                Don't allow
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">You can disconnect it at any time on your profile.</p>
          </div>
        </AuthCard>
      )}
    </AuthPage>
  );
}
