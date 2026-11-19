import { useRef, useState, type FormEvent } from "react";
import { MAX_PASSWORD_LENGTH, type MemberfulAccount, type MemberfulDisconnection, type ProfileAnswer } from "@ember/protocol";
import { AUTH_FORM } from "@/components/auth-page";
import { FIELD_INPUT, Field, SubmitButton } from "@/components/field";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { isSignedOut } from "@/lib/api";
import { openPage } from "@/lib/page";
import { pushEndpoint } from "@/lib/push";

// A section of your profile for an account elsewhere that signs you in, Memberful's or the single
// sign-on provider's: while it's the only way in, someone with an account from before connects theirs
// there to it, with their password, as changing their email address takes it, and signs in with it from
// then on. Once one is connected, it names the account, and Disconnect, with their password again,
// unlinks it and ends their other sessions, as a new password does, while they have a password and an
// email address to sign in with instead. Someone who joined with it has no password, and is given none
// while it signs them in, so theirs stays connected, nor can they connect the other, since holding their
// session would be all there was to check. Boxed as workspace settings' Memberful section is.

export interface ConnectionProps {
  /** The account elsewhere you've connected, as it describes itself, or null while you haven't. */
  connected: MemberfulAccount | null;
  /** Whether you have a password, which connecting one asks for then, and disconnecting it needs. */
  hasPassword: boolean;
  /** Whether you have an email address, which signing in with your password takes, so disconnecting needs it too. */
  hasEmailAddress: boolean;
  /** Whether you need the account elsewhere to sign in, as everyone does but administrators and the people they invite, who sign in with a password too. */
  membershipNeeded: boolean;
  /**
   * Why there's no Connect, when you have no password and the other way in signs you in, as the Worker
   * refuses one then: holding your session would be all there was to check before adding a way in.
   */
  signsInOtherwise?: string;
  /** Why it signs nobody in, while the other way is the only way in without it, said in place of how you sign in. */
  closed?: string;
  /** Shows your profile as disconnecting answered it. */
  onDisconnected: (answer: ProfileAnswer) => void;
  /** Says why connecting didn't start, or disconnecting didn't work, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

interface Props extends ConnectionProps {
  /** What the section's elements' ids start with. */
  id: string;
  /** The section's heading. */
  title: string;
  /** What the section calls the place the account is at: "Connect `name`", "Members sign in with `name`". */
  name: string;
  /** Whether it's the only way in, when members sign in with it alone, unless they need no account there. */
  only: boolean;
  /** Starts connecting, with your password while you have one, answering where to sign in elsewhere. */
  connect: (currentPassword?: string) => Promise<string>;
  disconnect: (disconnection: MemberfulDisconnection) => Promise<ProfileAnswer>;
}

/** Who `account` is, as it describes itself: "Grace Hopper (grace@example.com)", or whichever of the two it said, or null when it said neither. */
function describe({ name, emailAddress }: MemberfulAccount): string | null {
  if (name && emailAddress) return `${name} (${emailAddress})`;
  return name || emailAddress || null;
}

/**
 * The account elsewhere you've connected, with Disconnect, or Connect, which sends the browser to sign in
 * there once your password checks out, and which sends it back here.
 */
export function ExternalConnection({
  id,
  title,
  name,
  only,
  connect,
  disconnect,
  connected,
  hasPassword,
  hasEmailAddress,
  membershipNeeded,
  signsInOtherwise,
  closed,
  onDisconnected,
  onFailed,
}: Props) {
  const [busy, setBusy] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const mounted = useMounted();

  /** Once connecting has failed, or disconnecting has answered: ready for another try, with the password field emptied. */
  const settle = () => {
    setBusy(false);
    if (passwordInput.current) passwordInput.current.value = "";
  };

  const startConnecting = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    connect(hasPassword ? (passwordInput.current?.value ?? "") : undefined).then(
      (page) => {
        // Unless you've gone to another page meanwhile, where the browser stays.
        if (mounted.current) openPage(page);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        settle();
        onFailed(error);
      },
    );
  };

  const startDisconnecting = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const currentPassword = passwordInput.current?.value ?? "";
    // With this browser's push subscription named, which it keeps while it forgets the rest of your browsers'.
    pushEndpoint()
      .then((endpoint) => disconnect(endpoint ? { currentPassword, pushSubscriptionEndpoint: endpoint } : { currentPassword }))
      .then(
        (answer) => {
          if (!mounted.current) return;
          settle();
          onDisconnected(answer);
        },
        (error: unknown) => {
          if (!mounted.current && !isSignedOut(error)) return;
          settle();
          onFailed(error);
        },
      );
  };

  /** The password field, as both forms have it, described by the form's help, `helpId`: uncontrolled, as the profile's password fields are. */
  const passwordField = (helpId: string) => (
    <Field id={`${id}_password`} label="Password" translation="password">
      <Input
        ref={passwordInput}
        id={`${id}_password`}
        type="password"
        required
        autoComplete="current-password"
        placeholder="Enter your password"
        maxLength={MAX_PASSWORD_LENGTH}
        aria-describedby={helpId}
        className={FIELD_INPUT}
      />
    </Field>
  );

  // Whether your password signs you in, which takes an email address to sign in by, so that the account can be disconnected.
  const signsInWithPassword = hasPassword && hasEmailAddress;
  // Whether the account is your way in, rather than one of two: a member's, while it's the only way in,
  // and anyone's whose password doesn't sign them in.
  const signsYouIn = (only && membershipNeeded) || !signsInWithPassword;
  const who = connected && describe(connected);

  return (
    <section aria-labelledby={`${id}-connection-heading`} className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 max-md:px-3">
      <h2 id={`${id}-connection-heading`} className="text-base font-semibold">
        {title}
      </h2>
      {connected ? (
        <>
          <p>
            {who ? `Connected as ${who}.` : `Your ${name} account is connected.`}
            {closed ? ` ${closed}` : signsYouIn ? ` You sign in with ${name}.` : ` You can sign in with ${name} or your password.`}
          </p>
          {signsInWithPassword ? (
            <form onSubmit={startDisconnecting} className={AUTH_FORM}>
              <p id={`${id}-disconnection-help`}>
                {signsYouIn
                  ? "Disconnecting signs you out everywhere else. You'll be asked to connect again the next time you sign in."
                  : "Disconnecting signs you out everywhere else."}
              </p>
              {passwordField(`${id}-disconnection-help`)}
              <SubmitButton disabled={busy}>Disconnect {name}</SubmitButton>
            </form>
          ) : (
            hasPassword && <p>To disconnect, add an email address above so you can still sign in with your password.</p>
          )}
        </>
      ) : signsInOtherwise ? (
        <p>{signsInOtherwise}</p>
      ) : (
        <form onSubmit={startConnecting} className={AUTH_FORM}>
          <p id={`${id}-connection-help`}>
            {membershipNeeded ? `Members sign in with ${name}. Connect your ${name} account to keep signing in.` : `Connect your ${name} account to sign in with it.`}
          </p>
          {hasPassword && passwordField(`${id}-connection-help`)}
          <SubmitButton disabled={busy}>Connect {name}</SubmitButton>
        </form>
      )}
    </section>
  );
}
