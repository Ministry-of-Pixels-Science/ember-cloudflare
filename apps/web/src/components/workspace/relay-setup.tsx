import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { HuddlesSettings } from "@ember/protocol";
import { RELAY_API_TOKEN_REFUSED, RELAY_KEY_ID_REFUSED, relayApiTokenOf, relayKeyIdOf, type HuddleRelayField } from "@ember/protocol/huddles";
import { FIELD_INPUT, Field } from "@/components/field";
import { Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { ApiError, isSignedOut, saveHuddleRelay } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Actions } from "./assistant-setup";
import { BUTTON } from "./email-settings";
import { HIDDEN, Step } from "./huddles-steps";
import { dashboard, NOTE } from "./model-picker";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE } from "./unsaved-changes";

// Set up the relay, for administrators: the dialog that the relay's switch opens on the Huddles tab,
// around two steps like Set up huddles' own. Make a TURN key in Cloudflare's dashboard, which a button
// opens, in the account Ember is deployed to when the deploy gave it, then copy the key's ID and its
// API token here. The Worker has Cloudflare make the relay's servers with the key before it keeps it,
// and why it didn't, if it didn't, is said on the field it's about. Then it says that the relay is on.

/** What the dialog says first, of what the relay is and what it costs. */
export const RELAY_SETUP_EXPLAINED = "The relay is Cloudflare's TURN service. Cloudflare doesn't charge for it when it's used with the Realtime SFU, as huddles use it.";

/** And once the key is kept. */
export const RELAY_ON = "Cloudflare made the relay's servers with the key. Whoever joins a huddle from now on connects through the relay where their network blocks the way.";

/**
 * Where TURN keys are made, in the Cloudflare dashboard, as Cloudflare's documentation of them links
 * there (https://developers.cloudflare.com/realtime/turn/generate-credentials/).
 */
const turnDashboard = (accountId: string | null) => dashboard(accountId, "calls");

/** What the line under the API token says while there's nothing else to say. */
const TOKEN_KEPT = "Ember keeps it encrypted.";
/** Or when Ember has a TURN key, which Change key starts from. */
const KEY_KEPT = "Ember has a TURN key already. Give another's to relay through it instead.";
/** Or while the Worker asks Cloudflare about the key. */
const CHECKING = "Asking Cloudflare for the relay's servers with the key…";

/** Why the key wasn't kept, said on the field it's about, or else, with no field, under them. */
interface Refusal {
  field: HuddleRelayField | null;
  error: string;
}

/** The TURN key as the steps have it, and what's become of saving it. */
interface RelayKey {
  keyId: string;
  /** The API token's field, which alone holds what's typed in it. */
  apiToken: RefObject<HTMLInputElement | null>;
  type: (field: HuddleRelayField, text: string) => void;
  /** Whether both are typed, so that they can be saved. */
  typed: boolean;
  refusal: Refusal | null;
  /** Whether the Worker is asking Cloudflare about them, which holds the steps as they are until it's answered. */
  saving: boolean;
  /** Saves them, as the steps' form is sent. */
  save: (event: FormEvent) => void;
}

interface KeyOptions {
  /** The TURN key the relay goes by, whose ID the steps start from, or null while huddles have no relay. */
  relayKeyId: string | null;
  /** Called with huddles as they're saved. */
  onSaved: (huddles: HuddlesSettings) => void;
  /** Called with why saving failed, when it isn't the key's or Cloudflare's doing. */
  onFailed: (error: unknown) => void;
}

/** A TURN key, typed into the steps, which is saved once Cloudflare has made the relay's servers with it. */
function useRelayKey({ relayKeyId, onSaved, onFailed }: KeyOptions): RelayKey {
  const [keyId, setKeyId] = useState(relayKeyId ?? "");
  // Uncontrolled, as passwords are, so the token never reaches its field's `value` attribute, where custom CSS could read it.
  const apiToken = useRef<HTMLInputElement>(null);
  const [tokenTyped, setTokenTyped] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useMounted();

  const type = (field: HuddleRelayField, text: string) => {
    if (field === "keyId") setKeyId(text);
    else setTokenTyped(text.trim() !== "");
    if (refusal?.field === field || refusal?.field === null) setRefusal(null);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const [id, token] = [relayKeyIdOf(keyId), relayApiTokenOf(apiToken.current?.value ?? "")];
    if (id === null) return setRefusal({ field: "keyId", error: RELAY_KEY_ID_REFUSED });
    if (token === null) return setRefusal({ field: "apiToken", error: RELAY_API_TOKEN_REFUSED });
    setRefusal(null);
    setSaving(true);
    saveHuddleRelay({ keyId: id, apiToken: token }).then(
      (saved) => {
        if (mounted.current) setSaving(false);
        onSaved(saved);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        // What Cloudflare or the Worker said of the key, or that Cloudflare didn't answer, which the steps say themselves.
        if (error instanceof ApiError && [422, 502].includes(error.status)) return setRefusal({ field: fieldOf(error.field), error: error.message });
        onFailed(error);
      },
    );
  };

  return { keyId, apiToken, type, typed: keyId.trim() !== "" && tokenTyped, refusal, saving, save };
}

/** The field of the steps a refusal names, if it names one. */
const fieldOf = (field: string | undefined): HuddleRelayField | null => (field === "keyId" || field === "apiToken" ? field : null);

interface StepsProps {
  relay: RelayKey;
  /** The Cloudflare account Ember is deployed to, which the dashboard opens at, if the deploy gave it. */
  deployedAccountId: string | null;
  /** Whether Ember has a TURN key already, which this one would take the place of. */
  changing: boolean;
}

/** The two steps: the TURN key to make, with the button that opens Cloudflare's dashboard, then the fields for its ID and its API token. */
function RelaySteps({ relay, deployedAccountId, changing }: StepsProps) {
  const { refusal, saving } = relay;
  const idRefused = refusal?.field === "keyId" ? refusal.error : null;
  const tokenRefused = refusal?.field === "apiToken" ? refusal.error : null;
  // Cloudflare couldn't be asked, which is about neither field.
  const unasked = refusal?.field === null ? refusal.error : null;
  return (
    // Safari reads a list without markers as no list, unless it's given the role.
    <ol role="list" aria-label="Steps to set up the relay" className="flex flex-col gap-6">
      <Step number={1} title="Create a TURN key in Cloudflare" roomy={false}>
        <p className="-mt-2 leading-[1.6] text-muted-foreground">
          Open <em>Realtime</em>, find <em>TURN</em>, and create a key. Any name will do.
        </p>
        <div>
          <a href={turnDashboard(deployedAccountId)} target="_blank" rel="noopener" className={cn(BUTTON, "min-h-[42px] touch:min-h-11")}>
            Open Cloudflare's dashboard
          </a>
        </div>
      </Step>
      <Step number={2} title="Copy the key's ID and token here" roomy={false}>
        <div className="-mt-1 flex flex-col gap-4">
          <div>
            <Field id="relay_key_id" label="TURN Token ID">
              <Input
                id="relay_key_id"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={relay.keyId}
                disabled={saving}
                aria-invalid={idRefused !== null}
                aria-describedby={idRefused !== null ? "relay_key_id_refusal" : undefined}
                onChange={(event) => relay.type("keyId", event.target.value)}
                className={FIELD_INPUT}
              />
            </Field>
            {idRefused !== null && (
              <p id="relay_key_id_refusal" role="alert" className={cn(NOTE, "mt-1.5 wrap-anywhere text-negative")}>
                {idRefused}
              </p>
            )}
          </div>
          <div>
            <Field id="relay_api_token" label="API Token">
              <Input
                ref={relay.apiToken}
                id="relay_api_token"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={saving}
                aria-invalid={tokenRefused !== null}
                aria-describedby={tokenRefused !== null ? "relay_api_token_refusal" : "relay_api_token_note"}
                onChange={(event) => relay.type("apiToken", event.target.value)}
                className={cn(FIELD_INPUT, HIDDEN)}
              />
            </Field>
            {tokenRefused !== null ? (
              <p id="relay_api_token_refusal" role="alert" className={cn(NOTE, "mt-1.5 wrap-anywhere text-negative")}>
                {tokenRefused}
              </p>
            ) : (
              <p id="relay_api_token_note" role="status" className={cn(NOTE, "mt-1.5 wrap-anywhere", unasked !== null && "text-negative")}>
                {saving ? CHECKING : (unasked ?? (changing ? KEY_KEPT : TOKEN_KEPT))}
              </p>
            )}
          </div>
        </div>
      </Step>
    </ol>
  );
}

interface Props {
  /** The TURN key the relay goes by, or null while huddles have no relay. */
  relayKeyId: string | null;
  /** The Cloudflare account Ember is deployed to, which the dashboard opens at, if the deploy gave it. */
  deployedAccountId: string | null;
  /** Shows huddles as they're saved. */
  onSaved: (huddles: HuddlesSettings) => void;
  onClose: () => void;
  /** Says why saving failed, when it isn't the key's or Cloudflare's doing, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Set up the relay: a TURN key's ID and API token, which are saved once Cloudflare has made the relay's servers with them. */
export function RelaySetup({ relayKeyId, deployedAccountId, onSaved, onClose, onFailed }: Props) {
  const [done, setDone] = useState(false);
  const relay = useRelayKey({
    relayKeyId,
    onSaved: (saved) => {
      onSaved(saved);
      setDone(true);
    },
    onFailed,
  });
  // Checking the key with Cloudflare holds the dialog open until it's answered.
  const { saving } = relay;
  const title = useRef<HTMLHeadingElement>(null);

  // What it says once the key is kept starts at its title, so that it's read first.
  useEffect(() => {
    if (done) title.current?.focus();
  }, [done]);

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
        // The key typed isn't lost to a click beside it.
        onInteractOutside={(event) => event.preventDefault()}
        className={cn(DIALOG, "w-[480px]")}
      >
        <button type="button" aria-label="Close" disabled={saving} onClick={onClose} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle ref={title} tabIndex={-1} className={cn(DIALOG_TITLE, "pe-10 outline-none")}>
          {done ? "The relay is on" : "Set up the relay"}
        </DialogTitle>
        {done ? (
          <>
            <DialogDescription className="mb-4 leading-[1.65]">{RELAY_ON}</DialogDescription>
            <Actions back={null} next={onClose} nextLabel="Done" />
          </>
        ) : (
          <form onSubmit={relay.save}>
            <DialogDescription className="mb-6 leading-[1.65]">{RELAY_SETUP_EXPLAINED}</DialogDescription>
            <RelaySteps relay={relay} deployedAccountId={deployedAccountId} changing={relayKeyId !== null} />
            <Actions back={onClose} backLabel="Cancel" next={null} nextLabel={saving ? "Checking…" : "Save"} disabled={!relay.typed} saving={saving} />
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
