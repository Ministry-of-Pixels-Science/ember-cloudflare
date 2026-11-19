import { useState } from "react";
import type { SsoSettings } from "@ember/protocol/sso";
import { Switch } from "@/components/ui/switch";
import { useMounted } from "@/hooks/use-mounted";
import { forgetSso, isSignedOut } from "@/lib/api";
import { cn } from "@/lib/utils";
import { BUTTON } from "./email-settings";

// The Single sign-on card in Membership's ways to join: an administrator lets the people an OpenID
// Connect provider signs in join and sign in with their accounts there, once Set up single sign-on
// (`SsoSetup`) has the provider's issuer and the keys of the app registered there, or the deployment's
// secrets give them. Turning it on before then opens the setup, as switches open setup that's missing,
// as the project's owner asked (2026-10-26), and goes on once it's saved. Laid out as Memberful's card
// is, with SSO only's switch inside it, and Change settings and Remove under them.

/** What removing the provider asks first, since it turns single sign-on off. */
export const CONFIRM_FORGET_SSO =
  "Remove single sign-on? No one will be able to sign in with your provider until you set it up again.";

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

interface Props {
  /** The provider, once it's set up, or null while it isn't. */
  sso: SsoSettings | null;
  /** Where Single sign-on's switch is: where it was moved to while that's saved, or else where the workspace has it. */
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
  /** Where SSO only's switch is, likewise. */
  ssoOnly: boolean;
  onSsoOnlyChange: (on: boolean) => void;
  /** Whether a move of Single sign-on's switch is being saved, while which SSO only's waits. */
  ssoSaving?: boolean;
  /** Whether a move of SSO only's switch is being saved, while which Single sign-on's waits. */
  ssoOnlySaving?: boolean;
  /** Why the switch can't be moved while another way to join is on, said in place of what it does, or null. */
  setAside?: string | null;
  /** What's said in place of SSO only's switch while Memberful is members only, when the switch turns both on and off, or null. */
  beside?: string | null;
  /** What's said in place of what it does while Members only closes it, or null. */
  closed?: string | null;
  /** Opens Set up single sign-on, calling `then`, if given, once it closes with the provider saved. */
  onSetUp: (then?: () => void) => void;
  /** Shows the provider as removing it left it: the deployment's secrets', if they give one. */
  onForgotten: (sso: SsoSettings | null) => void;
  /** Says why removing it failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * Single sign-on, for administrators: its switch, and while it's on, SSO only's, then, once the provider
 * is set up, which one it is, Change settings, and Remove, unless the deployment's secrets give it.
 */
export function SingleSignOnSettings({
  sso,
  checked,
  onCheckedChange,
  ssoOnly,
  onSsoOnlyChange,
  ssoSaving = false,
  ssoOnlySaving = false,
  setAside = null,
  beside = null,
  closed = null,
  onSetUp,
  onForgotten,
  onFailed,
}: Props) {
  const [forgetting, setForgetting] = useState(false);
  const mounted = useMounted();
  // On without a provider, as once the deployment's secrets that gave it are gone, which only turning it off mends.
  const broken = sso === null && checked;

  const switchTo = (on: boolean) => {
    if (on && sso === null) return onSetUp(() => onCheckedChange(true));
    onCheckedChange(on);
  };

  const forget = () => {
    if (!confirm(CONFIRM_FORGET_SSO)) return;
    setForgetting(true);
    forgetSso().then(
      (sso) => {
        onForgotten(sso);
        if (mounted.current) setForgetting(false);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setForgetting(false);
        onFailed(error);
      },
    );
  };

  return (
    <section aria-labelledby="sso-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div className="flex items-center gap-x-[1ch] gap-y-4">
        <div className="min-w-0 flex-1">
          <h3 id="sso-heading" className={cn("text-base font-semibold", setAside !== null && "text-muted-foreground")}>
            Single sign-on
          </h3>
          <p id="sso-description" className={cn(NOTE, broken && "text-negative")}>
            {broken ? (
              "No provider is set up, so no one can sign in with single sign-on. Turn it off, then on again to set it up."
            ) : setAside !== null ? (
              setAside
            ) : closed !== null && sso !== null ? (
              closed
            ) : sso === null ? (
              "Let people join and sign in with Okta, Entra ID, Google Workspace, or another identity provider."
            ) : (
              <>
                People sign in at <strong className="wrap-anywhere">{sso.issuer}</strong> using the <em>Sign in with {sso.name}</em> button.
                {sso.allowedGroups.length > 0 && " Only allowed groups have access."}
                {/* Beside Members only, turning it off turns SSO only off too, which closes it. */}
                {beside === null
                  ? " When this is off, new people can't join, but members can still sign in."
                  : " When this is off, nobody signs in with it while Memberful is members only, not even those who joined with it."}
              </>
            )}
          </p>
        </div>
        <Switch
          checked={checked}
          onCheckedChange={switchTo}
          // Beside Members only, it saves SSO only's setting or its own, so it waits for either's move.
          disabled={setAside !== null || ssoOnlySaving || (beside !== null && ssoSaving) || forgetting}
          aria-labelledby="sso-heading"
          aria-describedby="sso-description"
        />
      </div>
      {checked && sso !== null && setAside === null && beside !== null && <p className={cn(NOTE, "border-t pt-3")}>{beside}</p>}
      {checked && sso !== null && setAside === null && beside === null && (
        <div className="flex items-center gap-x-[1ch] gap-y-4 border-t pt-3">
          <div className="min-w-0 flex-1">
            <div id="sso-only-heading">SSO only</div>
            <p id="sso-only-description" className={NOTE}>
              Everyone signs in with single sign-on, except administrators and people you invite. Members with a password connect their account the next
              time they sign in.
            </p>
          </div>
          <Switch
            checked={ssoOnly}
            onCheckedChange={onSsoOnlyChange}
            disabled={ssoSaving || forgetting}
            aria-labelledby="sso-only-heading"
            aria-describedby="sso-only-description"
          />
        </div>
      )}
      {sso !== null && setAside === null && (
        <div className="flex flex-wrap gap-2.5">
          <button type="button" onClick={() => onSetUp()} disabled={forgetting} className={BUTTON}>
            Change settings
          </button>
          {sso.source === "saved" && (
            <button type="button" onClick={forget} disabled={forgetting} className={BUTTON}>
              Remove
            </button>
          )}
        </div>
      )}
    </section>
  );
}
