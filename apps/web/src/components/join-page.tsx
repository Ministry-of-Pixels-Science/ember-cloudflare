import { useRef, useState } from "react";
import { MAX_EMAIL_ADDRESS_LENGTH, MAX_PASSWORD_LENGTH, MAX_USER_NAME_LENGTH, MIN_PASSWORD_LENGTH, type Me } from "@ember/protocol";
import { AuthAlternative } from "@/components/auth-alternative";
import { AUTH_FORM, AuthCard, AuthHeading, AuthPage, Problem, type SignedOutWorkspace } from "@/components/auth-page";
import { FIELD_INPUT, Field, SubmitButton } from "@/components/field";
import { PhotoField } from "@/components/photo-field";
import { TurnstileCheck } from "@/components/turnstile-check";
import { Input } from "@/components/ui/input";
import { useChosenPhoto } from "@/hooks/use-chosen-photo";
import { useTitle } from "@/hooks/use-title";
import type { EmailLink } from "@/hooks/use-email-link";
import { ApiError, joinWithEmailLink, joinWorkspace, signUp, type ChosenPhoto } from "@/lib/api";
import { loadPage } from "@/lib/page";

// The join page, which the workspace's join link opens for someone signed out. Without a code it's open
// sign-up's page, which shows Turnstile's check while Ember has a widget's keys, and with a link Ember
// emailed, an invitation's or one asked for at the workspace's email domains, it's the link's, which
// joins with its email address.

/** What the page says when Turnstile's script doesn't load, so there's no check to pass. */
export const TURNSTILE_UNAVAILABLE =
  "Ember couldn't load Cloudflare's check that you're a person. Check your connection, and anything that blocks challenges.cloudflare.com, then reload the page.";

interface Props {
  workspace: SignedOutWorkspace;
  /** The code from the join link, which the Worker checked before serving the page, or null for signing up without one. */
  joinCode: string | null;
  /** The link Ember emailed to join with, which its page has looked up, in place of a join code. */
  emailLink?: EmailLink;
  /** What the link's page does once the link stops working while the form is open. */
  onGone?: () => void;
  onJoined: (me: Me) => void;
}

/** What the address field says it's fixed by, for each kind of link Ember emails. */
const ADDRESS_FIXED_BY = { invitation: "Your invitation is for this address.", email_domain: "Your link is for this address." } as const;

/**
 * Creates an account with the join link, or a link Ember emailed, with its email address, or without
 * either while anyone may sign up, with the photo chosen, as a member in every open room, and signs in as it.
 * Signing up without a link waits for Turnstile's check to pass while Ember has a widget's keys, and
 * draws it afresh for each try.
 */
export function JoinPage({ workspace, joinCode, emailLink, onGone, onJoined }: Props) {
  const [name, setName] = useState("");
  const [emailAddress, setEmailAddress] = useState(emailLink?.emailAddress ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const photo = useChosenPhoto();
  const siteKey = joinCode === null && !emailLink ? workspace.turnstileSiteKey : null;
  // The token of the check passed, which is good for one try, and how many tries the check has been drawn for.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  useTitle("Sign up");

  /** Joins as the person the form describes, with the photo chosen, by the way the page is for. */
  function join(password: string, chosen: ChosenPhoto | null): Promise<Me> {
    if (emailLink) return joinWithEmailLink(emailLink.kind, { token: emailLink.token, name, password }, chosen);
    const person = { name, emailAddress, password };
    if (joinCode !== null) return joinWorkspace(joinCode, person, chosen);
    return signUp(siteKey === null ? person : { ...person, turnstileToken: turnstileToken ?? "" }, chosen);
  }

  async function submit() {
    setBusy(true);
    setProblem(null);
    try {
      onJoined(await join(passwordInput.current?.value ?? "", await photo.photo()));
    } catch (error) {
      setBusy(false);
      if (siteKey !== null) {
        setTurnstileToken(null);
        setTries((tries) => tries + 1);
      }
      if (!(error instanceof ApiError)) return setProblem("Couldn't reach Ember. Check your connection and try again.");
      // An email address with an account goes to sign in with it filled in, and someone who signed in
      // elsewhere meanwhile goes home.
      if (error.redirect) return loadPage(error.redirect);
      // The link stopped working while the page was open: its page says so, as loading the join link's
      // page again does.
      if (error.status === 404) return onGone ? onGone() : loadPage(location.pathname);
      // A photo that's refused goes, so the form can be sent without it.
      if (error.field === "avatar") return photo.refuse(error.message);
      setProblem(error.message);
    }
  }

  return (
    <AuthPage workspace={workspace}>
      {problem && <Problem>{problem}</Problem>}
      <AuthCard>
        <AuthHeading title={`Join ${workspace.account.name}`} logo={workspace.account.logo}>Create your account and join the conversation.</AuthHeading>
        <form
          className={AUTH_FORM}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <PhotoField photo={photo} disabled={busy} />
          <Field id="user_name" label="Name" translation="user_name">
            <Input
              id="user_name"
              required
              autoFocus
              autoComplete="name"
              placeholder="Name"
              maxLength={MAX_USER_NAME_LENGTH}
              data-1p-ignore
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={FIELD_INPUT}
            />
          </Field>
          <Field id="user_email_address" label="Email address" translation="email_address">
            <Input
              id="user_email_address"
              type="email"
              required
              readOnly={emailLink !== undefined}
              aria-describedby={emailLink ? "user_email_address_description" : undefined}
              autoComplete="username"
              placeholder="Email address"
              maxLength={MAX_EMAIL_ADDRESS_LENGTH}
              value={emailAddress}
              onChange={(event) => setEmailAddress(event.target.value)}
              className={FIELD_INPUT}
            />
            {emailLink && (
              <span id="user_email_address_description" className="text-[0.8rem] text-muted-foreground">
                {ADDRESS_FIXED_BY[emailLink.kind]}
              </span>
            )}
          </Field>
          <Field id="user_password" label="Password" translation="password">
            {/* Uncontrolled, so what's typed never reaches its `value` attribute, where custom CSS could read it. */}
            <Input
              ref={passwordInput}
              id="user_password"
              type="password"
              required
              autoComplete="new-password"
              placeholder="Password"
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              className={FIELD_INPUT}
            />
          </Field>
          {siteKey !== null && <TurnstileCheck key={tries} siteKey={siteKey} onToken={setTurnstileToken} onUnavailable={() => setProblem(TURNSTILE_UNAVAILABLE)} />}
          <SubmitButton disabled={busy || (siteKey !== null && turnstileToken === null)}>Create account</SubmitButton>
        </form>
        <AuthAlternative question="Already have an account?" action="Sign in" href="/session/new" />
      </AuthCard>
    </AuthPage>
  );
}
