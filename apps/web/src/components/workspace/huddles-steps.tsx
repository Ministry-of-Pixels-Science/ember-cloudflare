import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import type { HuddlesSettings } from "@ember/protocol";
import { APP_ID_REFUSED, APP_SECRET_REFUSED, appIdOf, appSecretOf, type HuddlesField } from "@ember/protocol/huddles";
import { FIELD_INPUT, Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { ApiError, isSignedOut, saveHuddles } from "@/lib/api";
import { cn } from "@/lib/utils";
import { BUTTON } from "./email-settings";
import { dashboard, NOTE } from "./model-picker";

// Set up huddles' two steps, which its dialog in community settings and first run's card share: make a
// Realtime SFU app in Cloudflare's dashboard, which a button opens, in the account Ember is deployed to
// when the deploy gave it, then copy the app's ID and its secret here. The Worker has Cloudflare start a
// session with the keys before it keeps them, and why it didn't, if it didn't, is said on the field it's
// about. One line under the secret says that, or that Cloudflare is being asked, or else what Ember does
// with the secret, so the steps keep their height on a phone.

/** Where Realtime's SFU apps are made, in the Cloudflare dashboard. */
const sfuDashboard = (accountId: string | null) => dashboard(accountId, "realtime/sfu");

/** What the line under the secret says while there's nothing else to say. */
const SECRET_KEPT = "Ember keeps it encrypted.";
/** Or when Ember has an app's keys, which Change keys starts from. */
const KEYS_KEPT = "Ember has an app's keys already. Give another app's to run huddles through it instead.";
/** Or while the Worker asks Cloudflare about the keys. */
const CHECKING = "Asking Cloudflare to start a session with the app's keys…";

/** Dots in place of what's typed, in a field that's no password, so no password manager offers to keep or fill it. */
export const HIDDEN = "[-webkit-text-security:disc]";

/** Why the keys weren't kept, said on the field it's about, or else, with no field, under them. */
interface Refusal {
  field: HuddlesField | null;
  error: string;
}

/** The app's keys as the steps have them, and what's become of saving them. */
export interface HuddlesKeys {
  appId: string;
  /** The App Secret's field, which alone holds what's typed in it. */
  appSecret: RefObject<HTMLInputElement | null>;
  type: (field: HuddlesField, text: string) => void;
  /** Whether both are typed, so that they can be saved. */
  typed: boolean;
  refusal: Refusal | null;
  /** Whether the Worker is asking Cloudflare about them, which holds the steps as they are until it's answered. */
  saving: boolean;
  /** Saves them, as the steps' form is sent. */
  save: (event: FormEvent) => void;
}

interface KeysOptions {
  /** Huddles as they are, whose app's ID the steps start from. */
  huddles: HuddlesSettings | null;
  /** Called with huddles as they're saved. */
  onSaved: (huddles: HuddlesSettings) => void;
  /** Called with why saving failed, when it isn't the keys' or Cloudflare's doing. */
  onFailed: (error: unknown) => void;
}

/** The keys of an SFU app, typed into `HuddlesSteps`, which are saved once Cloudflare has started a session with them. */
export function useHuddlesKeys({ huddles, onSaved, onFailed }: KeysOptions): HuddlesKeys {
  const [appId, setAppId] = useState(huddles?.appId ?? "");
  // Uncontrolled, as passwords are, so the secret never reaches its field's `value` attribute, where custom CSS could read it.
  const appSecret = useRef<HTMLInputElement>(null);
  const [secretTyped, setSecretTyped] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useMounted();

  const type = (field: HuddlesField, text: string) => {
    if (field === "appId") setAppId(text);
    else setSecretTyped(text.trim() !== "");
    if (refusal?.field === field || refusal?.field === null) setRefusal(null);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const [id, secret] = [appIdOf(appId), appSecretOf(appSecret.current?.value ?? "")];
    if (id === null) return setRefusal({ field: "appId", error: APP_ID_REFUSED });
    if (secret === null) return setRefusal({ field: "appSecret", error: APP_SECRET_REFUSED });
    setRefusal(null);
    setSaving(true);
    saveHuddles({ appId: id, appSecret: secret }).then(
      (saved) => {
        if (mounted.current) setSaving(false);
        onSaved(saved);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        // What Cloudflare or the Worker said of the keys, or that Cloudflare didn't answer, which the steps say themselves.
        if (error instanceof ApiError && [422, 502].includes(error.status)) return setRefusal({ field: fieldOf(error.field), error: error.message });
        onFailed(error);
      },
    );
  };

  return { appId, appSecret, type, typed: appId.trim() !== "" && secretTyped, refusal, saving, save };
}

/** The field of the steps a refusal names, if it names one. */
const fieldOf = (field: string | undefined): HuddlesField | null => (field === "appId" || field === "appSecret" ? field : null);

interface StepsProps {
  keys: HuddlesKeys;
  /** The Cloudflare account Ember is deployed to, whose SFU apps the dashboard opens at, if the deploy gave it. */
  deployedAccountId: string | null;
  /** Whether Ember has an app's keys already, which these would take the place of. */
  changing?: boolean;
  /** As first run's card sets them: in its larger type, each step's title a heading under the page's own. */
  roomy?: boolean;
}

/** The two steps: the app to make, with the button that opens Cloudflare's dashboard at it, then its keys' fields. */
export function HuddlesSteps({ keys, deployedAccountId, changing = false, roomy = false }: StepsProps) {
  const { refusal, saving } = keys;
  const note = roomy ? "text-sm leading-normal text-muted-foreground" : NOTE;
  const input = cn(FIELD_INPUT, roomy && "rounded-[0.7rem] bg-card dark:bg-card");
  const idRefused = refusal?.field === "appId" ? refusal.error : null;
  const secretRefused = refusal?.field === "appSecret" ? refusal.error : null;
  // Cloudflare couldn't be asked, which is about neither key.
  const unasked = refusal?.field === null ? refusal.error : null;
  return (
    // Safari reads a list without markers as no list, unless it's given the role.
    <ol role="list" aria-label="Steps to set up huddles" className="flex flex-col gap-6">
      <Step number={1} title="Create an SFU app in Cloudflare" roomy={roomy}>
        <p className={cn("-mt-2 text-muted-foreground", roomy ? "text-base leading-normal" : "leading-[1.6]")}>
          Open <em>Realtime</em>, choose <em>Serverless SFU</em>, and create an app. Any name will do.
        </p>
        <div>
          <a
            href={sfuDashboard(deployedAccountId)}
            target="_blank"
            rel="noopener"
            className={cn(BUTTON, "min-h-[42px] touch:min-h-11", roomy && "rounded-[0.7rem] bg-card text-base")}
          >
            Open Cloudflare's dashboard
          </a>
        </div>
      </Step>
      <Step number={2} title="Copy the app's keys here" roomy={roomy}>
        <div className="-mt-1 flex flex-col gap-4">
          <div>
            <Field id="huddles_app_id" label="App ID">
              <Input
                id="huddles_app_id"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={keys.appId}
                disabled={saving}
                aria-invalid={idRefused !== null}
                aria-describedby={idRefused !== null ? "huddles_app_id_refusal" : undefined}
                onChange={(event) => keys.type("appId", event.target.value)}
                className={input}
              />
            </Field>
            {idRefused !== null && (
              <p id="huddles_app_id_refusal" role="alert" className={cn(note, "mt-1.5 wrap-anywhere text-negative")}>
                {idRefused}
              </p>
            )}
          </div>
          <div>
            <Field id="huddles_app_secret" label="App Secret">
              <Input
                ref={keys.appSecret}
                id="huddles_app_secret"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={saving}
                aria-invalid={secretRefused !== null}
                aria-describedby={secretRefused !== null ? "huddles_app_secret_refusal" : "huddles_app_secret_note"}
                onChange={(event) => keys.type("appSecret", event.target.value)}
                className={cn(input, HIDDEN)}
              />
            </Field>
            {secretRefused !== null ? (
              <p id="huddles_app_secret_refusal" role="alert" className={cn(note, "mt-1.5 wrap-anywhere text-negative")}>
                {secretRefused}
              </p>
            ) : (
              <p id="huddles_app_secret_note" role="status" className={cn(note, "mt-1.5 wrap-anywhere", unasked !== null && "text-negative")}>
                {saving ? CHECKING : (unasked ?? (changing ? KEYS_KEPT : SECRET_KEPT))}
              </p>
            )}
          </div>
        </div>
      </Step>
    </ol>
  );
}

/** One of the steps, as Set up Memberful's are too: its number in a ring, its title, and what to do. */
export function Step({ number, title, roomy, children }: { number: number; title: string; roomy: boolean; children: ReactNode }) {
  const Title = roomy ? "h2" : "h3";
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
      <span aria-hidden="true" className="mt-px grid size-6 place-items-center rounded-full border bg-surface text-[12px] font-[650] tabular-nums">
        {number}
      </span>
      <div className="flex min-w-0 flex-col gap-3">
        <Title className={cn("leading-[26px]", roomy ? "text-base font-medium" : "text-[15px] font-[620]")}>{title}</Title>
        {children}
      </div>
    </li>
  );
}
