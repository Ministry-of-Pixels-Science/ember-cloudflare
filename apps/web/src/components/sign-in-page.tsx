import { useEffect, useRef, useState } from "react";
import {
  domainsInWords,
  EMAIL_SIGN_UP_PATH,
  MAX_PASSWORD_LENGTH,
  MEMBERFUL_CONNECTED,
  MEMBERFUL_SIGN_IN_PROBLEMS,
  memberfulSignInPath,
  PASSWORD_RESET_PATH,
  SIGN_IN_LIMITED,
  SIGN_IN_REJECTED,
  SIGN_UP_PATH,
  signsUpOpenly,
  signsUpWithEmailDomain,
  withEmailAddress,
  type Me,
} from "@ember/protocol";
import { DEFAULT_SSO_NAME, SSO_CONNECTED, SSO_SIGN_IN_PROBLEMS, ssoSignInPath, type ElsewhereConnection } from "@ember/protocol/sso";
import { AuthAlternative } from "@/components/auth-alternative";
import { AUTH_FORM, AuthCard, AuthHeading, AuthPage, Problem, type SignedOutWorkspace } from "@/components/auth-page";
import { FIELD_INPUT, Field, PRIMARY_BUTTON, SubmitButton } from "@/components/field";
import { GuestSignIn } from "@/components/guest-sign-in";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTitle } from "@/hooks/use-title";
import { ApiError, signIn } from "@/lib/api";
import { forgetJoiningProblem, joiningProblemOnArrival } from "@/lib/joining";
import { forgetMemberfulOutcome, memberfulOutcomeOnArrival } from "@/lib/memberful";
import { returnPath } from "@/lib/return-path";
import { forgetSsoOutcome, ssoOutcomeOnArrival } from "@/lib/sso";

// The sign-in page. A refused sign-in shakes the card and says why at the top of the form, in place of a
// flash, keeping the email address and emptying the password. While Memberful is members only, the card
// offers signing in with Memberful instead, and the email and password form to those who ask for it:
// administrators, and members with an account from before, whose password then asks them to connect
// their Memberful account. Otherwise, while Memberful's members sign in with it, the card links to that
// under the form. Single sign-on works the same way, named as the provider is: while it's the only way
// in, the card offers Sign in with it instead of the form, and otherwise links to it under the form. While anyone may sign up, it links to the page for that, and it says why a way to join
// that's off sent someone here. While Ember can send email, the form links to resetting a forgotten
// password with a code Ember emails.

/** What a Memberful or single sign-on sign-in that came back here says went wrong, as this page's address names it, if it does. */
function problemOnArrival(): { text: string; taken: boolean } | null {
  const memberful = memberfulOutcomeOnArrival();
  if (memberful !== null && memberful !== MEMBERFUL_CONNECTED) return { text: MEMBERFUL_SIGN_IN_PROBLEMS[memberful], taken: memberful === "taken" };
  const sso = ssoOutcomeOnArrival();
  if (sso !== null && sso !== SSO_CONNECTED) return { text: SSO_SIGN_IN_PROBLEMS[sso], taken: sso === "taken" };
  return null;
}

/** What the link to sign in with single sign-on asks, apart from Memberful's "Member?", which can be beside it. */
const SSO_QUESTION = "Use single sign-on?";

/** Where to connect your account elsewhere, once your password has checked out but you have yet to connect one, and what that elsewhere is called. */
interface Connection {
  url: string;
  name: string;
}

/** Where `answer` says to connect an account elsewhere: Memberful's, the provider's, called `ssoName`, or both. */
const connectionsOf = (answer: ElsewhereConnection, ssoName: string): Connection[] => [
  ...("memberfulConnection" in answer ? [{ url: answer.memberfulConnection, name: "Memberful" }] : []),
  ...("ssoConnection" in answer ? [{ url: answer.ssoConnection, name: ssoName }] : []),
];

/**
 * Signs in with an email address and password, or with Memberful while its members sign in with it, or
 * with single sign-on while it's offered, or with just a name when the workspace allows it, or, while
 * Memberful is members only, or single sign-on the only way in, with that, or with either while both
 * are, or a password for administrators, which asks anyone else to connect their account there until
 * they have.
 */
export function SignInPage({ workspace, onSignedIn }: { workspace: SignedOutWorkspace; onSignedIn: (me: Me) => void }) {
  const { memberfulSignIn: membersOnly, ssoSignIn: ssoOnly } = workspace.account;
  const ssoName = workspace.signInWithSso ?? DEFAULT_SSO_NAME;
  // While both are the only ways in, Memberful's link goes beside single sign-on's, unless it signs nobody in, as without its site's keys.
  const eitherOnly = membersOnly && ssoOnly && workspace.signInWithMemberful;
  const [arrival] = useState(problemOnArrival);
  const [asGuest, setAsGuest] = useState(false);
  // Someone whose email address elsewhere is someone's here is asked for that someone's password.
  const [withPassword, setWithPassword] = useState(!(membersOnly || ssoOnly) || arrival?.taken === true);
  const [emailAddress, setEmailAddress] = useState(() => new URLSearchParams(location.search).get("email_address") ?? "");
  const [busy, setBusy] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(() => arrival?.text ?? joiningProblemOnArrival());
  /** Why the last sign-in was refused, said at the top of the form. */
  const [refusal, setRefusal] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);

  useTitle("Sign in");
  useEffect(() => {
    forgetMemberfulOutcome();
    forgetSsoOutcome();
    forgetJoiningProblem();
  }, []);

  function connect(asked: Connection[]) {
    setBusy(false);
    setConnections(asked);
  }

  async function submit() {
    setBusy(true);
    setProblem(null);
    setRefusal(null);
    try {
      // Connecting Memberful, or single sign-on, comes back to the page this tab was sent here from, signed in.
      const answer = await signIn({ emailAddress, password: passwordInput.current?.value ?? "", returnTo: returnPath() ?? undefined });
      if ("memberfulConnection" in answer || "ssoConnection" in answer) return connect(connectionsOf(answer, ssoName));
      onSignedIn(answer);
    } catch (error) {
      setBusy(false);
      if (!(error instanceof ApiError)) return setProblem("Couldn't reach Ember. Check your connection and try again.");
      if (passwordInput.current) passwordInput.current.value = "";
      // A member whose password is right, and who has connected Memberful or single sign-on, hears that they sign in with it.
      setRefusal(error.status === 403 ? error.message : error.status === 429 ? SIGN_IN_LIMITED : SIGN_IN_REJECTED);
      setShaking(true);
      passwordInput.current?.focus();
    }
  }

  return (
    <AuthPage workspace={workspace}>
      {problem && <Problem>{problem}</Problem>}
      <AuthCard onAnimationEnd={(event) => event.target === event.currentTarget && setShaking(false)} className={shaking ? "motion-safe:animate-shake" : undefined}>
        {connections !== null && connections[0] !== undefined ? (
          <>
            <AuthHeading title={`Sign in to ${workspace.account.name}`} logo={workspace.account.logo}>
              {connections.length > 1
                ? `This workspace now uses ${connections.map(({ name }) => name).join(" and ")}. Connect your account at either to keep signing in.`
                : `This workspace now uses ${connections[0].name}. Connect your ${connections[0].name} account to keep signing in.`}
            </AuthHeading>
            <Button asChild className={PRIMARY_BUTTON}>
              <a href={connections[0].url}>Connect {connections[0].name}</a>
            </Button>
            {connections.slice(1).map(({ url, name }) => (
              <AuthAlternative key={name} question="Or" action={`Connect ${name}`} href={url} />
            ))}
          </>
        ) : asGuest ? (
          <GuestSignIn logo={workspace.account.logo} onSignedIn={onSignedIn} onUsePassword={() => setAsGuest(false)} />
        ) : (
          <>
            <AuthHeading title={`Sign in to ${workspace.account.name}`} logo={workspace.account.logo}>Welcome back. Pick up the conversation.</AuthHeading>
            {withPassword ? (
              <form
                className={AUTH_FORM}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                {refusal && (
                  <p id="sign-in-error" role="alert" className="rounded-[8px] border border-auth-error-border bg-auth-error-background px-3.5 py-3 text-[14px] leading-normal text-auth-error">
                    {refusal}
                  </p>
                )}
                <Field id="email_address" label="Email address" translation="email_address">
                  <Input
                    id="email_address"
                    type="email"
                    required
                    autoFocus
                    autoComplete="username"
                    placeholder="Enter your email address"
                    value={emailAddress}
                    onChange={(event) => setEmailAddress(event.target.value)}
                    className={FIELD_INPUT}
                  />
                </Field>
                <Field id="password" label="Password" translation="password">
                  {/* Uncontrolled, so what's typed never reaches its `value` attribute, where custom CSS could read it. */}
                  <Input
                    ref={passwordInput}
                    id="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    maxLength={MAX_PASSWORD_LENGTH}
                    className={FIELD_INPUT}
                  />
                </Field>
                <SubmitButton disabled={busy}>Sign in</SubmitButton>
              </form>
            ) : (
              <Button asChild className={PRIMARY_BUTTON}>
                {/* The Worker opens the page this tab was sent here from once it's signed in. The tab keeps it too, for a try that fails. */}
                {ssoOnly ? (
                  <a href={ssoSignInPath(returnPath())}>Sign in with {ssoName}</a>
                ) : (
                  <a href={memberfulSignInPath(returnPath())}>Sign in with Memberful</a>
                )}
              </Button>
            )}
            {withPassword && workspace.passwordResetCodes && (
              <AuthAlternative question="Forgot your password?" action="Reset it" href={withEmailAddress(PASSWORD_RESET_PATH, emailAddress)} />
            )}
            {membersOnly || ssoOnly ? (
              withPassword ? (
                <AuthAlternative
                  question={eitherOnly ? "No password?" : ssoOnly ? SSO_QUESTION : "Member?"}
                  action={eitherOnly ? `Sign in with ${ssoName} or Memberful` : `Sign in with ${ssoOnly ? ssoName : "Memberful"}`}
                  onClick={() => setWithPassword(false)}
                  disabled={busy}
                />
              ) : (
                <>
                  {/* Single sign-on's button comes first, and Memberful's here, while either signs people in. */}
                  {eitherOnly && <AuthAlternative question="Member?" action="Sign in with Memberful" href={memberfulSignInPath(returnPath())} />}
                  <AuthAlternative question="Have a password?" action="Sign in with a password" onClick={() => setWithPassword(true)} />
                </>
              )
            ) : (
              <>
                {workspace.signInWithMemberful && <AuthAlternative question="Member?" action="Sign in with Memberful" href={memberfulSignInPath(returnPath())} />}
                {workspace.signInWithSso !== null && (
                  <AuthAlternative question={SSO_QUESTION} action={`Sign in with ${workspace.signInWithSso}`} href={ssoSignInPath(returnPath())} />
                )}
              </>
            )}
            {signsUpOpenly(workspace.account) ? (
              <AuthAlternative question="New here?" action="Create an account" href={SIGN_UP_PATH} />
            ) : (
              // Open lets anyone in, addresses at the email domains too, so this is for when it's off.
              signsUpWithEmailDomain(workspace.account) && (
                <AuthAlternative question={`Have an address at ${domainsInWords(workspace.account.emailDomains)}?`} action="Join with it" href={EMAIL_SIGN_UP_PATH} />
              )
            )}
            {workspace.guestSignIn && <AuthAlternative question="No account?" action="Join with just a name" onClick={() => setAsGuest(true)} disabled={busy} />}
          </>
        )}
      </AuthCard>
    </AuthPage>
  );
}
