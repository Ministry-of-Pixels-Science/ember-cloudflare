import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { MEMBERFUL_CALLBACK_PATH, MEMBERFUL_WEBHOOK_PATH } from "@ember/protocol";
import { memberfulSiteKept, parseMemberfulKeysChange, type MemberfulField, type MemberfulSaved } from "@ember/protocol/memberful";
import { FIELD_INPUT, Field } from "@/components/field";
import { Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAccount } from "@/hooks/use-account";
import { useMounted } from "@/hooks/use-mounted";
import { ApiError, isSignedOut, saveMemberfulKeys } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Actions } from "./assistant-setup";
import { HIDDEN, Step } from "./huddles-steps";
import { CopyButton, ROUND_BUTTON } from "./link-buttons";
import { NOTE } from "./model-picker";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE } from "./unsaved-changes";

// Set up Memberful, for administrators: the dialog that Membership's Memberful card opens, as its switch
// does until Ember has a Memberful site's keys, which gives Ember them here rather than as the Worker's
// secrets, as the project's owner asked (2026-11-14). Three steps: the site's address, then a custom app
// there, which sends members back to Ember, and its OAuth identifier, OAuth secret and API key, then a
// webhook, which tells Ember when a membership changes, and its secret key, each of Ember's addresses
// with a button that copies it. The Worker asks Memberful about the keys before it keeps them, and why it
// didn't, if it didn't, is said on the field it's about. Styled as Set up huddles is.

/** What the dialog says first. */
export const MEMBERFUL_SETUP_EXPLAINED =
  "Members of your Memberful site can join and sign in with their Memberful account. Add a custom app and a webhook for Ember there, then copy their keys here.";

/** What the line under the last key says while there's nothing else to say. */
const SECRETS_KEPT = "Ember checks the keys with Memberful, then keeps the secrets encrypted.";
/** Or when Ember has keys already, which Change keys starts from. */
const KEYS_KEPT = "Ember has your site's keys already. Give them all again to change any of them.";
/** Or while the Worker asks Memberful about the keys. */
const CHECKING = "Asking Memberful about the keys…";

/** The keys that are secrets, which only their fields hold. */
type SecretField = Extract<MemberfulField, "clientSecret" | "apiKey" | "webhookSecret">;

/** Each field's id, which its refusal's is made from. */
const FIELD_IDS: Record<MemberfulField, string> = {
  site: "memberful_site",
  clientId: "memberful_client_id",
  clientSecret: "memberful_client_secret",
  apiKey: "memberful_api_key",
  webhookSecret: "memberful_webhook_secret",
};

/** Why the keys weren't kept, said on the field it's about, or else, with no field, under them. */
interface Refusal {
  field: MemberfulField | null;
  error: string;
}

/** The field of the steps a refusal names, if it names one. */
const fieldOf = (field: string | undefined): MemberfulField | null => (field !== undefined && Object.hasOwn(FIELD_IDS, field) ? (field as MemberfulField) : null);

/** Where Memberful sends members back to as they sign in, and its webhook, at Ember's address, wherever settings are opened. */
export function useMemberfulAddresses(): { redirectUrl: string; webhookUrl: string } {
  const { customDomain } = useAccount();
  const origin = `${location.protocol}//${customDomain ?? location.host}`;
  return { redirectUrl: `${origin}${MEMBERFUL_CALLBACK_PATH}`, webhookUrl: `${origin}${MEMBERFUL_WEBHOOK_PATH}` };
}

interface Props {
  /** Memberful as Membership's card shows it, whose site the steps start from. */
  memberful: MemberfulSaved;
  /** Shows Memberful as it's saved. */
  onSaved: (memberful: MemberfulSaved) => void;
  onClose: () => void;
  /** Says why saving failed, when it isn't the keys' or Memberful's doing, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Set up Memberful: a Memberful site's address, its custom app's keys and its webhook's, which are saved once Memberful has taken them. */
export function MemberfulSetup({ memberful, onSaved, onClose, onFailed }: Props) {
  const { memberfulSite, memberfulKeys, memberfulSiteKept: kept } = memberful;
  const { redirectUrl, webhookUrl } = useMemberfulAddresses();
  // The site Ember keeps, which can't be changed, or else the one Change keys starts from.
  const [site, setSite] = useState(kept ?? (memberfulKeys === "saved" ? memberfulSite : null) ?? "");
  const [clientId, setClientId] = useState("");
  // Uncontrolled, as passwords are, so the secrets never reach their fields' `value` attributes, where custom CSS could read them.
  const secrets: Record<SecretField, RefObject<HTMLInputElement | null>> = {
    clientSecret: useRef<HTMLInputElement>(null),
    apiKey: useRef<HTMLInputElement>(null),
    webhookSecret: useRef<HTMLInputElement>(null),
  };
  const [secretsTyped, setSecretsTyped] = useState<Record<SecretField, boolean>>({ clientSecret: false, apiKey: false, webhookSecret: false });
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Checking the keys with Memberful holds the dialog open until it's answered.
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const mounted = useMounted();
  const title = useRef<HTMLHeadingElement>(null);
  const typed = site.trim() !== "" && clientId.trim() !== "" && Object.values(secretsTyped).every(Boolean);

  // What it says once the keys are kept starts at its title, so that it's read first.
  useEffect(() => {
    if (saved !== null) title.current?.focus();
  }, [saved]);

  const type = (field: MemberfulField, text: string) => {
    if (field === "site") setSite(text);
    else if (field === "clientId") setClientId(text);
    else setSecretsTyped((typed) => ({ ...typed, [field]: text.trim() !== "" }));
    if (refusal?.field === field || refusal?.field === null) setRefusal(null);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const secretOf = (field: SecretField) => secrets[field].current?.value ?? "";
    const keys = parseMemberfulKeysChange({
      site,
      clientId,
      clientSecret: secretOf("clientSecret"),
      apiKey: secretOf("apiKey"),
      webhookSecret: secretOf("webhookSecret"),
    });
    if ("error" in keys) return setRefusal(keys);
    setRefusal(null);
    setSaving(true);
    saveMemberfulKeys(keys).then(
      (memberful) => {
        onSaved(memberful);
        if (!mounted.current) return;
        setSaving(false);
        setSaved(keys.site);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        // What Memberful or the Worker said of the keys, or that Memberful didn't answer, which the steps say themselves.
        if (error instanceof ApiError && [422, 502].includes(error.status)) return setRefusal({ field: fieldOf(error.field), error: error.message });
        onFailed(error);
      },
    );
  };

  const keyProps = { refusal, saving, onType: type };
  // Memberful couldn't be asked, which is about no key.
  const unasked = refusal?.field === null ? refusal.error : null;
  const secretRefused = refusal?.field === "webhookSecret";

  return (
    <Dialog open onOpenChange={(open) => open || saving || onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-busy={saving || undefined}
        overlayClassName={DIALOG_BACKDROP}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        // The keys typed aren't lost to a click beside it.
        onInteractOutside={(event) => event.preventDefault()}
        // Wider than the other setup dialogs, for its three steps and the addresses to copy.
        className={cn(DIALOG, "w-[640px]")}
      >
        <button type="button" aria-label="Close" disabled={saving} onClick={onClose} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle ref={title} tabIndex={-1} className={cn(DIALOG_TITLE, "pe-10 outline-none")}>
          {saved === null ? "Set up Memberful" : "Memberful is set up"}
        </DialogTitle>
        {saved !== null ? (
          <>
            <DialogDescription className="mb-4 leading-[1.65]">
              Memberful took the keys. While Memberful is on, members of <strong className="wrap-anywhere">{saved}</strong> join and sign in with their
              Memberful account, and a member whose membership lapses is signed out until it's renewed.
            </DialogDescription>
            <Actions back={null} next={onClose} nextLabel="Done" />
          </>
        ) : (
          <form onSubmit={save}>
            <DialogDescription className="mb-6 leading-[1.65]">{MEMBERFUL_SETUP_EXPLAINED}</DialogDescription>
            {/* Safari reads a list without markers as no list, unless it's given the role. */}
            <ol role="list" aria-label="Steps to set up Memberful" className="flex flex-col gap-6">
              <Step number={1} title="Your Memberful site" roomy={false}>
                <KeyInput
                  field="site"
                  label="Address"
                  {...keyProps}
                  value={site}
                  readOnly={kept !== null}
                  inputMode="url"
                  placeholder="https://example.memberful.com"
                  note={kept !== null ? memberfulSiteKept(kept) : null}
                />
              </Step>
              <Step number={2} title="Add a custom app" roomy={false}>
                <Instructions first>
                  In Memberful, open <em>Settings</em>, then <em>Custom applications</em>, and add one. Check{" "}
                  <em>Include OAuth tokens with this application</em>, choose <em>Server-side</em>, and give it this OAuth Redirect URL:
                </Instructions>
                <AddressToCopy url={redirectUrl} label="OAuth Redirect URL" />
                <Instructions>Once it's made, copy its keys here.</Instructions>
                <div className="flex flex-col gap-4">
                  <KeyInput field="clientId" label="OAuth identifier" {...keyProps} value={clientId} />
                  <KeyInput field="clientSecret" label="OAuth secret" {...keyProps} secret={secrets.clientSecret} />
                  <KeyInput field="apiKey" label="API key" {...keyProps} secret={secrets.apiKey} />
                </div>
              </Step>
              <Step number={3} title="Add a webhook" roomy={false}>
                <Instructions first>
                  Under <em>Settings</em>, then <em>Webhooks</em>, add one that sends the member, subscription and order events to this URL:
                </Instructions>
                <AddressToCopy url={webhookUrl} label="webhook URL" />
                <Instructions>Then copy its secret key here.</Instructions>
                <div>
                  <KeyInput
                    field="webhookSecret"
                    label="Secret key"
                    {...keyProps}
                    secret={secrets.webhookSecret}
                    describedBy={secretRefused ? undefined : "memberful_keys_note"}
                  />
                  {!secretRefused && (
                    <p id="memberful_keys_note" role="status" className={cn(NOTE, "mt-1.5 wrap-anywhere", unasked !== null && "text-negative")}>
                      {saving ? CHECKING : (unasked ?? (memberfulKeys === "saved" ? KEYS_KEPT : SECRETS_KEPT))}
                    </p>
                  )}
                </div>
              </Step>
            </ol>
            <Actions back={onClose} backLabel="Cancel" next={null} nextLabel={saving ? "Checking…" : "Save"} disabled={!typed} saving={saving} />
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** What a step asks, before or after its address and fields, the `first` of it closer to the step's title. */
function Instructions({ first = false, children }: { first?: boolean; children: ReactNode }) {
  return <p className={cn("leading-[1.6] text-muted-foreground", first && "-mt-2")}>{children}</p>;
}

/** An address of Ember's to give Memberful, with a button that copies it, called after `label`. */
function AddressToCopy({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex min-h-[42px] items-center gap-3 rounded-[9px] border bg-background py-[3px] ps-[11px] pe-[3px] touch:min-h-11">
      <code className="min-w-0 flex-1 text-[0.9em] wrap-anywhere">{wrappable(url)}</code>
      <CopyButton text={url} label={`Copy the ${label}`} className={ROUND_BUTTON} />
    </div>
  );
}

/** `url`, which wraps before a slash of its path, where it's too long for a line, rather than within a word. */
const wrappable = (url: string) => {
  const { origin, pathname } = new URL(url);
  return [origin, ...pathname.split(/(?=\/)/).flatMap((part, index) => [<wbr key={index} />, part])];
};

interface KeyInputProps {
  field: MemberfulField;
  label: string;
  refusal: Refusal | null;
  saving: boolean;
  onType: (field: MemberfulField, text: string) => void;
  /** What's typed in it, unless it's a secret's. */
  value?: string;
  /** A secret's field, which alone holds what's typed in it. */
  secret?: RefObject<HTMLInputElement | null>;
  readOnly?: boolean;
  inputMode?: "url";
  placeholder?: string;
  /** What's said under it, while it isn't refused. */
  note?: string | null;
  /** The id of what's said of it elsewhere, while it isn't refused. */
  describedBy?: string;
}

/** A field of the steps, with why it's refused under it, if it is, or else its note. */
function KeyInput({ field, label, refusal, saving, onType, value, secret, readOnly = false, inputMode, placeholder, note = null, describedBy }: KeyInputProps) {
  const id = FIELD_IDS[field];
  const refused = refusal?.field === field ? refusal.error : null;
  const said = refused !== null ? `${id}_refusal` : note !== null ? `${id}_note` : describedBy;
  return (
    <div>
      <Field id={id} label={label}>
        <Input
          ref={secret}
          id={id}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode={inputMode}
          placeholder={placeholder}
          value={secret ? undefined : value}
          readOnly={readOnly}
          disabled={saving}
          aria-invalid={refused !== null}
          aria-describedby={said}
          onChange={(event) => onType(field, event.target.value)}
          className={cn(FIELD_INPUT, secret && HIDDEN, readOnly && "text-muted-foreground")}
        />
      </Field>
      {refused !== null ? (
        <p id={`${id}_refusal`} role="alert" className={cn(NOTE, "mt-1.5 wrap-anywhere text-negative")}>
          {refused}
        </p>
      ) : (
        note !== null && (
          <p id={`${id}_note`} className={cn(NOTE, "mt-1.5 wrap-anywhere")}>
            {note}
          </p>
        )
      )}
    </div>
  );
}
