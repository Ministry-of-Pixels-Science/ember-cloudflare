import { useEffect, useState } from "react";
import { PROFILE_PATH, type Me } from "@ember/protocol";
import type { AppSignedIn, AppSignInReturn, YourAppSignedIn } from "@ember/protocol/apps";
import { useFlash } from "@/components/flash";
import { PageLink } from "@/components/page-link";
import { appSettingsPath, navigate } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import { ApiError, finishAppSignIn, isSignedOut } from "@/lib/api";
import { AGENTS_PATH, useAgentsOnly } from "./agent-list";
import { connectedNotice } from "./app-page";
import { BUTTON } from "./email-settings";
import { PageHeading, Panel, SettingsPage } from "./settings-page";
import { isOwnSignIn } from "./your-apps";

// Where an app's authorization server sends a browser back, once its person has signed in there: the
// page takes what came back out of the address, has Ember finish the sign-in with it, and goes on to
// the app's page, for the sign-in an administrator makes for Ember, or to your profile, for the one
// you made yourself, or says why not.

/** What the page says while Ember finishes the sign-in, which reads the app's tools, and while it finishes one you made yourself. */
export const FINISHING_SIGN_IN = "Ember is finishing the sign-in and reading the app's tools.";
export const FINISHING_OWN_SIGN_IN = "Ember is finishing your sign-in.";

/** What the page says of a sign-in its server didn't go through with: one the administrator turned down there, and any other. */
export const SIGN_IN_TURNED_DOWN = "The sign-in was turned down there, so nothing has changed.";
export const SIGN_IN_NOT_FINISHED = "The sign-in wasn't finished there, so nothing has changed. Start it again.";

/** What a page says once Ember is signed in to `app`'s server again. */
export const signedInAgainNotice = (app: { name: string }) => `Ember is signed in to ${app.name} again.`;

/** What your profile says once you've signed in to `app` yourself. */
export const signedInYourselfNotice = (app: { name: string }) => `You're signed in to ${app.name}. What an agent does with it in your direct conversation with that agent, it now does as you.`;

/** What an authorization server sent the browser back with, in the address: a code for the sign-in begun as `state`, with who it says it is, or why there's none. */
interface CameBack {
  state: string | null;
  code: string | null;
  iss: string | null;
  error: string | null;
}

function cameBack(): CameBack {
  const query = new URLSearchParams(location.search);
  return { state: query.get("state"), code: query.get("code"), iss: query.get("iss"), error: query.get("error") };
}

/** What Ember finishes the sign-in with, or why it can't be finished, said in the page's own words: an authorization server's aren't shown. */
function returnOf({ state, code, iss, error }: CameBack): AppSignInReturn | string {
  if (error === "access_denied") return SIGN_IN_TURNED_DOWN;
  if (error !== null || !state || !code) return SIGN_IN_NOT_FINISHED;
  return { state, code, ...(iss !== null && { iss }) };
}

// A sign-in is finished once, so a page that asks twice, as React has one do while it's developed, is answered once.
const finishing = new Map<string, Promise<AppSignedIn | YourAppSignedIn>>();

function finishOnce(back: AppSignInReturn): Promise<AppSignedIn | YourAppSignedIn> {
  const asked = finishing.get(back.state) ?? finishAppSignIn(back);
  finishing.set(back.state, asked);
  return asked;
}

interface Props {
  me: Me;
  /** Says why something failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * The page a sign-in to an app's server comes back to. Ember's, which an administrator began, goes on
 * to the app's page once Ember has finished it, saying the app is connected, or signed in to again.
 * One you began for yourself, from your profile, goes back there, saying you're signed in. Either says
 * why when it wasn't finished, with the way back to where it began: the apps, or, for a sign-in this
 * tab noted as your own, and for anyone who isn't an administrator, your profile. Ember says whose a
 * sign-in is when it finishes it, whatever the page took it for.
 */
export function AppSignedInPage({ me, onFailed }: Props) {
  const [came] = useState(cameBack);
  const [back] = useState(() => returnOf(came));
  const [own] = useState(() => !me.administrator || isOwnSignIn(came.state));
  const [problem, setProblem] = useState(typeof back === "string" ? back : null);
  const { failed } = useAgentsOnly(onFailed);
  const flash = useFlash();
  useTitle("Signing in to an app");

  useEffect(() => {
    // The code leaves the address bar and this tab's history.
    history.replaceState(history.state, "", location.pathname);
    if (typeof back === "string") return;
    let stopped = false;
    finishOnce(back).then(
      (signedIn) => {
        if (stopped) return;
        navigate("yours" in signedIn ? PROFILE_PATH : appSettingsPath(signedIn.app.id), { replace: true });
        flash("notice", "yours" in signedIn ? signedInYourselfNotice(signedIn.yours) : signedIn.again ? signedInAgainNotice(signedIn.app) : connectedNotice(signedIn.app));
      },
      (error: unknown) => {
        if (stopped && !isSignedOut(error)) return;
        // Your own is refused in words for you, which the page says: the apps' tab isn't yours to be sent to.
        if (error instanceof ApiError && (error.status === 422 || (own && !isSignedOut(error)))) setProblem(error.message);
        else failed(error);
      },
    );
    return () => void (stopped = true);
  }, [own, back, flash, failed]);

  return (
    <SettingsPage back={own ? PROFILE_PATH : AGENTS_PATH}>
      <Panel aria-busy={problem === null}>
        {problem === null ? (
          <PageHeading title="Signing in…">{own ? FINISHING_OWN_SIGN_IN : FINISHING_SIGN_IN}</PageHeading>
        ) : (
          <>
            <PageHeading title={own ? "You aren't signed in to the app" : "The app isn't signed in to"}>
              <span role="alert" className="wrap-anywhere">
                {problem}
              </span>
            </PageHeading>
            <PageLink href={own ? PROFILE_PATH : AGENTS_PATH} className={BUTTON}>
              {own ? "Back to your profile" : "Back to the apps"}
            </PageLink>
          </>
        )}
      </Panel>
    </SettingsPage>
  );
}
