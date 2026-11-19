import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import {
  DEFAULT_GROUPS_CLAIM,
  DEFAULT_SSO_NAME,
  MAX_CLIENT_ID_LENGTH,
  MAX_CLIENT_SECRET_LENGTH,
  MAX_ISSUER_LENGTH,
  MAX_SSO_NAME_LENGTH,
  parseSsoSetup,
  SSO_CALLBACK_PATH,
  SSO_LOGOUT_PATH,
  type SsoField,
  type SsoSettings,
} from "@ember/protocol/sso";
import { FIELD_INPUT, Field } from "@/components/field";
import { Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAccount } from "@/hooks/use-account";
import { useMounted } from "@/hooks/use-mounted";
import { ApiError, isSignedOut, saveSso } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Actions } from "./assistant-setup";
import { HIDDEN } from "./huddles-steps";
import { NOTE } from "./model-picker";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE } from "./unsaved-changes";

// Set up single sign-on, for administrators: the steps to register Ember at an OpenID Connect provider,
// such as Zitadel, Okta, Entra ID, Google Workspace, Keycloak or Authentik, and give Ember the provider's
// issuer and the app's keys, in a dialog that the Single sign-on card of Membership's ways to join
// opens. The Worker reads the provider's discovery document before keeping them, saying on the field
// it's about why it didn't, if it didn't. While the deployment's secrets give the issuer and the app,
// the dialog shows them as they are, and sets the rest. Styled as Set up huddles is.

/** Where it's at: the provider and its app, or done. */
type Step = "provider" | "done";

const TITLES: Record<Step, string> = { provider: "Set up single sign-on", done: "Single sign-on is ready" };

/**
 * What each text field holds, as typed: the scopes apart by spaces, and the groups one a line. The
 * secret's holds nothing: only its field has it.
 */
type Typed = Record<SsoField, string>;

/** Why the setup wasn't kept, said on the field it's about, or else, with no field, under them. */
interface Refusal {
  field: SsoField | null;
  error: string;
}

const TEXTAREA = cn("w-full border placeholder:text-muted-foreground disabled:opacity-50", FIELD_INPUT, "resize-y");

interface Props {
  sso: SsoSettings | null;
  /** Shows single sign-on as it's saved. */
  onSaved: (sso: SsoSettings) => void;
  /** Closes it, saying whether it was saved, which goes on to turn single sign-on on, when that's what opened it. */
  onClose: (saved: boolean) => void;
  /** Says why saving failed, when it isn't the setup's or the provider's doing, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** What the fields start with: the provider as it's set up, or else blank, but for the claim that lists groups. */
const typedOf = (sso: SsoSettings | null): Typed => ({
  issuer: sso?.issuer ?? "",
  clientId: sso?.clientId ?? "",
  clientSecret: "",
  name: sso && sso.name !== DEFAULT_SSO_NAME ? sso.name : "",
  scopes: sso?.scopes.join(" ") ?? "",
  groupsClaim: sso && sso.groupsClaim !== DEFAULT_GROUPS_CLAIM ? sso.groupsClaim : "",
  allowedGroups: sso?.allowedGroups.join("\n") ?? "",
});

/** The field of Set up single sign-on a refusal names, if it names one. */
const fieldOf = (field: string | undefined): SsoField | null =>
  field !== undefined && ["issuer", "clientId", "clientSecret", "name", "scopes", "groupsClaim", "allowedGroups"].includes(field) ? (field as SsoField) : null;

/** Set up single sign-on: the provider's issuer, the app's keys and what the sign-in page calls it, and who it lets in. */
export function SsoSetup({ sso, onSaved, onClose, onFailed }: Props) {
  const { customDomain } = useAccount();
  const [step, setStep] = useState<Step>("provider");
  const [typed, setTyped] = useState<Typed>(() => typedOf(sso));
  // Uncontrolled, as passwords are, so the secret never reaches its field's `value` attribute, where custom CSS could read it.
  const secretInput = useRef<HTMLInputElement>(null);
  const [secretTyped, setSecretTyped] = useState(false);
  const [linksVerifiedEmails, setLinksVerifiedEmails] = useState(sso?.linksVerifiedEmails ?? false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Reading the provider's discovery document holds the dialog open until it's answered.
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const shown = useRef(step);
  const mounted = useMounted();
  // The deployment's secrets give the issuer, the app and its secret, which the dialog only shows.
  const secret = sso?.source === "secret";
  // A blank secret keeps the one saved, for the same issuer and app, as the Worker does.
  const keepsSecret = sso?.source === "saved" && typed.issuer.trim() === sso.issuer && typed.clientId.trim() === sso.clientId;
  // What the provider sends people back to, and says that someone signed out at: Ember's address, wherever settings are opened.
  const origin = `${location.protocol}//${customDomain ?? location.host}`;

  // Each step starts at its title, so that it's read first.
  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    title.current?.focus();
  }, [step]);

  const close = () => onClose(saved);

  const type = (field: SsoField, text: string) => {
    if (field === "clientSecret") setSecretTyped(text.trim() !== "");
    else setTyped((typed) => ({ ...typed, [field]: text }));
    if (refusal?.field === field || refusal?.field === null) setRefusal(null);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const { issuer, clientId, name, scopes, groupsClaim, allowedGroups } = typed;
    const app = secret ? {} : { issuer, clientId, clientSecret: secretInput.current?.value ?? "" };
    const setup = parseSsoSetup({ ...app, name, scopes, groupsClaim, allowedGroups, linksVerifiedEmails });
    if ("error" in setup) return setRefusal(setup);
    setRefusal(null);
    setSaving(true);
    saveSso(setup).then(
      (sso) => {
        onSaved(sso);
        if (!mounted.current) return;
        setSaving(false);
        setSaved(true);
        setStep("done");
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        // What the Worker or the provider said of the setup, or that the provider didn't answer, which the step says itself.
        if (error instanceof ApiError && [422, 502].includes(error.status)) return setRefusal({ field: fieldOf(error.field), error: error.message });
        onFailed(error);
      },
    );
  };

  const needed = secret ? false : typed.issuer.trim() === "" || typed.clientId.trim() === "" || (!keepsSecret && !secretTyped);
  const fieldProps = { typed, onType: type, refusal, disabled: saving };

  return (
    <Dialog open onOpenChange={(open) => open || saving || close()}>
      <DialogContent
        showCloseButton={false}
        aria-busy={saving || undefined}
        overlayClassName={DIALOG_BACKDROP}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        // What's typed isn't lost to a click beside it.
        onInteractOutside={(event) => event.preventDefault()}
        className={cn(DIALOG, "w-[520px]")}
      >
        <button type="button" aria-label="Close" disabled={saving} onClick={close} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle ref={title} tabIndex={-1} className={cn(DIALOG_TITLE, "pe-10 outline-none")}>
          {TITLES[step]}
        </DialogTitle>
        {step === "provider" ? (
          <form onSubmit={save}>
            <DialogDescription className="mb-4 leading-[1.65]">
              Let people sign in with Okta, Entra ID, Google Workspace, or any other OpenID Connect provider.
            </DialogDescription>
            <ol aria-label="Steps to set up your provider" className="mb-4 flex list-decimal flex-col gap-2 ps-5">
              <li>
                In your provider, create a web app that uses the authorization code flow with PKCE. Let it give refresh tokens, often called the refresh
                token grant or <code>offline_access</code>, so that Ember checks every hour that each person may still sign in. Without them, it checks
                only as people sign in.
              </li>
              <li>
                Set its redirect URI to <strong className="wrap-anywhere">{`${origin}${SSO_CALLBACK_PATH}`}</strong>.
              </li>
              <li>
                Optional: to sign people out of Ember when they sign out of your provider, set its back-channel logout URI to{" "}
                <strong className="wrap-anywhere">{`${origin}${SSO_LOGOUT_PATH}`}</strong>.
              </li>
              <li>{secret ? "Choose a button name and who can sign in." : "Enter the app's details below."}</li>
            </ol>
            <div className="flex flex-col gap-4">
              {secret ? (
                <>
                  <TextField field="issuer" id="sso_issuer" label="Issuer URL" readOnly {...fieldProps} />
                  <TextField field="clientId" id="sso_client_id" label="Client ID" readOnly {...fieldProps} />
                  <p className={NOTE}>
                    Set by your deployment's <code>SSO_ISSUER</code>, <code>SSO_CLIENT_ID</code> and <code>SSO_CLIENT_SECRET</code> secrets.
                  </p>
                </>
              ) : (
                <>
                  <TextField
                    field="issuer"
                    id="sso_issuer"
                    label="Issuer URL"
                    placeholder="https://auth.example.com"
                    maxLength={MAX_ISSUER_LENGTH}
                    {...fieldProps}
                  />
                  <TextField field="clientId" id="sso_client_id" label="Client ID" maxLength={MAX_CLIENT_ID_LENGTH} {...fieldProps} />
                  <TextField
                    field="clientSecret"
                    id="sso_client_secret"
                    label="Client Secret"
                    secret={secretInput}
                    maxLength={MAX_CLIENT_SECRET_LENGTH}
                    help={keepsSecret ? "Stored encrypted. Leave blank to keep the current one." : "Stored encrypted."}
                    {...fieldProps}
                  />
                </>
              )}
              <TextField
                field="name"
                id="sso_name"
                label="Button name"
                placeholder={DEFAULT_SSO_NAME}
                maxLength={MAX_SSO_NAME_LENGTH}
                help={`Shown as Sign in with ${typed.name.trim() || DEFAULT_SSO_NAME}.`}
                {...fieldProps}
              />
              <TextField
                field="scopes"
                id="sso_scopes"
                label="Extra scopes"
                help="Separate with spaces. openid, profile and email are always included."
                {...fieldProps}
              />
              <TextField
                field="groupsClaim"
                id="sso_groups_claim"
                label="Groups claim"
                placeholder={DEFAULT_GROUPS_CLAIM}
                help="The claim that lists each person's groups or roles, in the ID token or the userinfo endpoint's answer. Where both give it, the userinfo endpoint's counts."
                {...fieldProps}
              />
              <TextField
                field="allowedGroups"
                id="sso_allowed_groups"
                label="Allowed groups"
                multiline
                help={
                  <>
                    One per line. Leave empty to allow everyone. For Zitadel, turn on <em>User roles inside ID Token</em> and set the groups claim to{" "}
                    <code className="wrap-anywhere">urn:zitadel:iam:org:project:roles</code>.
                  </>
                }
                {...fieldProps}
              />
              <label className="flex cursor-pointer items-start gap-[7px] text-start">
                <input
                  type="checkbox"
                  checked={linksVerifiedEmails}
                  disabled={saving}
                  onChange={(event) => setLinksVerifiedEmails(event.target.checked)}
                  aria-describedby="sso_links_verified_emails_help"
                  className="mt-0.5 size-4 flex-none cursor-pointer accent-foreground"
                />
                <span>
                  Link accounts by verified email
                  <span id="sso_links_verified_emails_help" className={cn(NOTE, "block")}>
                    The first time someone signs in, match them to the member with the same verified email. Administrators are never matched. When
                    this is off, members connect their accounts from their profiles. Only check it if your provider verifies addresses and doesn't let
                    people change their own, since whoever has an address there gets the account here.
                  </span>
                </span>
              </label>
            </div>
            <p role="status" className={cn(NOTE, "mt-4 wrap-anywhere empty:mt-0", !saving && "text-negative")}>
              {saving ? "Contacting your provider…" : refusal?.field === null ? refusal.error : null}
            </p>
            <Actions back={close} backLabel="Cancel" next={null} nextLabel={saving ? "Checking…" : "Save"} disabled={needed} saving={saving} />
          </form>
        ) : (
          <>
            <DialogDescription className="mb-4 leading-[1.65]">
              Ember found your provider, but it first uses the Client ID and secret as someone signs in. Once <em>Single sign-on</em> is on, sign in
              with your provider in a private window to check them.
            </DialogDescription>
            <Actions back={null} next={close} nextLabel="Done" />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A field of the setup, with its help under it, and why it's refused, if it is. */
function TextField({
  field,
  id,
  label,
  typed,
  onType,
  refusal,
  disabled,
  help,
  multiline = false,
  readOnly = false,
  secret,
  placeholder,
  maxLength,
}: {
  field: SsoField;
  id: string;
  label: string;
  typed: Typed;
  onType: (field: SsoField, text: string) => void;
  refusal: Refusal | null;
  disabled: boolean;
  help?: ReactNode;
  multiline?: boolean;
  readOnly?: boolean;
  /** A secret's field, which alone holds what's typed in it, shown as dots, in a field that's no password, so no password manager offers to keep or fill it. */
  secret?: RefObject<HTMLInputElement | null>;
  placeholder?: string;
  maxLength?: number;
}) {
  const refused = refusal?.field === field ? refusal.error : null;
  const describedBy = [help !== undefined && `${id}_help`, refused !== null && `${id}_refusal`].filter(Boolean).join(" ") || undefined;
  const shared = {
    id,
    value: secret ? undefined : typed[field],
    placeholder,
    maxLength,
    readOnly,
    disabled,
    autoComplete: "off",
    autoCapitalize: "none",
    spellCheck: false,
    "aria-invalid": refused !== null,
    "aria-describedby": describedBy,
  };
  return (
    <div>
      <Field id={id} label={label}>
        {multiline ? (
          <textarea rows={3} {...shared} onChange={(event) => onType(field, event.target.value)} className={TEXTAREA} />
        ) : (
          <Input
            ref={secret}
            {...shared}
            onChange={(event) => onType(field, event.target.value)}
            className={cn(FIELD_INPUT, secret && HIDDEN, readOnly && "text-muted-foreground")}
          />
        )}
      </Field>
      {help !== undefined && (
        <p id={`${id}_help`} className={cn(NOTE, "mt-2")}>
          {help}
        </p>
      )}
      {refused !== null && (
        <p id={`${id}_refusal`} role="alert" className={cn(NOTE, "mt-2 wrap-anywhere text-negative")}>
          {refused}
        </p>
      )}
    </div>
  );
}
