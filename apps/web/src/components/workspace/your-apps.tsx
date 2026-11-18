import { useState } from "react";
import type { AppId, YourApp } from "@ember/protocol/apps";
import { useFlash } from "@/components/flash";
import { useMounted } from "@/hooks/use-mounted";
import { beginOwnAppSignIn, isSignedOut, signOutOfApp } from "@/lib/api";
import { dateTimeLabel } from "@/lib/messages";
import { openPage } from "@/lib/page";
import { BUTTON } from "./email-settings";

// The Apps section of your profile, while Ember AI is on: the connected apps Ember signs in to, each
// of which you can sign in to yourself. What an agent then does with the app in your direct
// conversation with it, it does as you, asking you first each time, and everywhere else it goes on
// using the sign-in an administrator made. Signing in sends the browser to the app's service, which
// sends it back to the page that finishes the sign-in. Boxed as the Ember AI section is.

/** What the section says of signing in to an app yourself. */
export const YOUR_APPS_EXPLAINED =
  "Sign in to an app yourself, and what an agent does with it in your direct conversation with that agent, it does as you, after asking you each time. Everywhere else, agents use the sign-in an administrator made.";

/** What a row says of an app you haven't signed in to, or have, `at` a time, and of a sign-in that has ended, or that the app has asked for more than. */
export const NOT_SIGNED_IN = "You haven't signed in. Agents use the sign-in an administrator made.";
export const signedInAt = (at: string) => `You signed in ${dateTimeLabel(new Date(at))}.`;
export const SIGN_IN_ENDED = "Your sign-in has ended. Until you sign in again, or sign out, agents can't use this app for you in your direct conversations with them.";
export const WANTS_MORE = "It has asked for more access than your sign-in has. Sign in again to allow it.";

/** What's said once you've signed out of `name`: whether its service took your sign-in back, or it's left to take back there. */
export const signedOutNotice = (name: string, revoked: boolean) =>
  revoked ? `You're signed out of ${name}, which took your sign-in back.` : `You're signed out of ${name} here. Ember couldn't take your sign-in back there, so remove Ember's access at ${name} too.`;

/** What a sign-in you began for yourself is noted by, for the page it comes back to: the state it comes back with. */
const OWN_SIGN_IN = "ember:own-app-sign-in";

/** Notes that the sign-in the browser is being sent to `authorizationUrl` for is your own, where this tab can keep a note. */
function noteOwnSignIn(authorizationUrl: string): void {
  try {
    sessionStorage.setItem(OWN_SIGN_IN, new URL(authorizationUrl).searchParams.get("state") ?? "");
  } catch {
    // The page it comes back to then goes by who you are.
  }
}

/** Whether the sign-in that came back with `state` is one this tab noted as your own. */
export function isOwnSignIn(state: string | null): boolean {
  try {
    return state !== null && state !== "" && sessionStorage.getItem(OWN_SIGN_IN) === state;
  } catch {
    return false;
  }
}

interface Props {
  /** The apps you can sign in to yourself, by name, each with your sign-in to it, if you've made one. */
  apps: YourApp[];
  /** Shows the apps as signing out leaves them. */
  onChanged: (apps: YourApp[]) => void;
  /** Says why a sign-in didn't start, or signing out didn't work, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** The apps you can sign in to yourself, each with Sign in, or with when you did, and Sign out. */
export function YourApps({ apps, onChanged, onFailed }: Props) {
  /** The app a sign-in is beginning for, or that's being signed out of. */
  const [busy, setBusy] = useState<AppId | null>(null);
  const mounted = useMounted();
  const flash = useFlash();

  const failed = (error: unknown) => {
    if (!mounted.current && !isSignedOut(error)) return;
    setBusy(null);
    onFailed(error);
  };

  const signIn = ({ id }: YourApp) => {
    setBusy(id);
    beginOwnAppSignIn(id).then((authorizationUrl) => {
      // Leaving your profile meanwhile leaves the sign-in unmade, rather than taking you from where you went.
      if (!mounted.current) return;
      noteOwnSignIn(authorizationUrl);
      openPage(authorizationUrl);
    }, failed);
  };

  const signOut = ({ id, name }: YourApp) => {
    setBusy(id);
    signOutOfApp(id).then(({ apps, revoked }) => {
      if (!mounted.current) return;
      setBusy(null);
      onChanged(apps);
      flash(revoked ? "notice" : "alert", signedOutNotice(name, revoked));
    }, failed);
  };

  return (
    <section aria-labelledby="your-apps-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 max-md:px-3">
      <h2 id="your-apps-heading" className="text-base font-semibold">
        Apps
      </h2>
      <p>{YOUR_APPS_EXPLAINED}</p>
      <ul className="flex flex-col gap-3">
        {apps.map((app) => (
          <li key={app.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-col">
              <span className="font-semibold wrap-anywhere">{app.name}</span>
              <span className="text-sm text-muted-foreground">{statusOf(app)}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {(app.signedInAt === null || app.ended || app.wantsMore) && (
                <button type="button" disabled={busy !== null} aria-label={`${app.signedInAt === null ? "Sign in" : "Sign in again"} to ${app.name}`} onClick={() => signIn(app)} className={BUTTON}>
                  {app.signedInAt === null ? "Sign in" : "Sign in again"}
                </button>
              )}
              {app.signedInAt !== null && (
                <button type="button" disabled={busy !== null} aria-label={`Sign out of ${app.name}`} onClick={() => signOut(app)} className={BUTTON}>
                  Sign out
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What a row says of your sign-in to `app`. */
function statusOf({ signedInAt: at, ended, wantsMore }: YourApp): string {
  if (at === null) return NOT_SIGNED_IN;
  if (ended) return SIGN_IN_ENDED;
  return wantsMore ? `${signedInAt(at)} ${WANTS_MORE}` : signedInAt(at);
}
