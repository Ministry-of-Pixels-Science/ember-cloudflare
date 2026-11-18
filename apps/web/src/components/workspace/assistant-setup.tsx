import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ACCOUNT_ID_REFUSED,
  API_TOKEN_REFUSED,
  accountIdOf,
  apiTokenOf,
  modelName,
  offeredModelOf,
  type AssistantField,
  type AssistantKeys,
  type AssistantSettings,
  type OfferedModels,
  type WebTool,
} from "@ember/protocol/assistant";
import { FIELD_INPUT, Field } from "@/components/field";
import { Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { useOfferedModels } from "@/hooks/use-offered-models";
import { ApiError, isSignedOut, saveAssistant } from "@/lib/api";
import { cn } from "@/lib/utils";
import { dashboard, FieldRefusal, ModelPicker, NOTE, Out, startingModelOf, type Refusal } from "./model-picker";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE, MAIN_ACTION, OTHER_ACTION } from "./unsaved-changes";

// Set up Ember AI, for administrators: the steps to give @ember a model through Cloudflare AI Gateway, in
// a dialog that the AI assistant tab's Ember AI card opens. First the Cloudflare account's ID, filled in
// with the account Ember is deployed to when the deploy gave it, and an API token of its with AI Gateway's
// Run permission, which AI Gateway's endpoint for each model's provider takes, and Workers AI Read and AI
// Gateway Read, which Workers AI's models and Cloudflare's Web Search API take. Then the model, of those
// Ember offers through that account, which the Worker asks a test question through AI Gateway before
// keeping all three, saying on the field it's about why it didn't answer, if it didn't, and which answers
// everyone who hasn't picked another. Then what the model said, and that Search the web is off, when a
// change of model turned it off. Styled as Set up Turnstile is.

/** Where the account's own API tokens are made, in the Cloudflare dashboard. */
const accountApiTokens = (accountId: string | null) => dashboard(accountId, "api-tokens");

/**
 * What the last step says once a change of model, or of the Cloudflare account it's asked through, has
 * turned Search the web off, leaving @ember doing `webTools` on the web: that it can try it again, or that
 * the model can't search.
 */
export const searchTurnedOff = (webTools: WebTool[] | null, changed: "model" | "account" = "model") =>
  webTools === null ? "Search the web is off, as this model can't search the web through AI Gateway." : `Search the web is off for the new ${changed}. Turn it on again to try it.`;

/** What Set up Ember AI changed of `before` in saving `after`, which turns Search the web off: the account, if only that. */
const changeOf = (before: AssistantSettings, after: AssistantSettings) => (before.accountId !== after.accountId && before.model === after.model ? "account" : "model");

/** Where it's at: the account and its API token, the model, or done. */
type Step = "keys" | "model" | "done";

const TITLES: Record<Step, string> = { keys: "Set up Ember AI", model: "Choose a model", done: "Ember AI is set up" };

/** The fields of the first step. */
type KeyField = Exclude<AssistantField, "model">;

interface Props {
  assistant: AssistantSettings | null;
  /** The Cloudflare account Ember is deployed to, which the account's ID starts as while Ember AI is off, if the deploy gave it. */
  deployedAccountId: string | null;
  /** Shows Ember AI as it's saved. */
  onSaved: (assistant: AssistantSettings) => void;
  onClose: () => void;
  /** Says why saving failed, when it isn't the setup's or AI Gateway's doing, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Set up Ember AI: the account and its API token, then the model, which saves them once it answers a test question. */
export function AssistantSetup({ assistant, deployedAccountId, onSaved, onClose, onFailed }: Props) {
  const [step, setStep] = useState<Step>("keys");
  // The account's ID as Ember AI has it, or else as the deploy gave it, which the steps then needn't say where to copy from.
  const [filledIn] = useState(() => assistant?.accountId ?? deployedAccountId);
  const [typed, setTyped] = useState<Record<KeyField, string>>({ accountId: filledIn ?? "", apiToken: "" });
  // The model chosen, once one is, while Ember offers it through the account typed.
  const [chosen, setChosen] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Asking the model a test question holds the dialog open until it's answered.
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ assistant: AssistantSettings; greeting: string } | null>(null);
  // Ember AI as it was when the dialog opened, which saving it replaces: whether @ember searched the web then,
  // which another model or account may not do with the same tools, and so doesn't until it's tried.
  const [opened] = useState(assistant);
  const title = useRef<HTMLHeadingElement>(null);
  const shown = useRef(step);
  const mounted = useMounted();

  // Each step starts at its title, so that it's read first.
  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    title.current?.focus();
  }, [step]);

  const refuse = (field: AssistantField | null, error: string) => {
    setRefusal({ field, error });
    if (field === "accountId" || field === "apiToken") setStep("keys");
  };

  /** The account and API token as typed, a blank token keeping the one Ember has. */
  const keys = (): AssistantKeys => {
    const apiToken = apiTokenOf(typed.apiToken);
    return { accountId: accountIdOf(typed.accountId) ?? "", ...(apiToken && { apiToken }) };
  };

  // The models Ember offers through the account typed, listed once the model's step opens, with the API token typed, or Ember AI's.
  const offered = useOfferedModels(step !== "keys", keys(), onFailed);
  const model = offered === null ? (chosen ?? assistant?.model ?? "") : chosenOf(chosen, assistant, offered);

  const save = () => {
    setRefusal(null);
    setSaving(true);
    saveAssistant({ ...keys(), model }).then(
      (answer) => {
        onSaved(answer.assistant);
        if (!mounted.current) return;
        setSaving(false);
        setSaved(answer);
        setStep("done");
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        // What AI Gateway or the Worker said of the setup, or that AI Gateway didn't answer, which the step says itself.
        if (error instanceof ApiError && [422, 429, 502].includes(error.status)) return refuse(fieldOf(error.field), error.message);
        onFailed(error);
      },
    );
  };

  const steps: Record<Step, ReactNode> = {
    keys: (
      <KeysStep
        hasToken={assistant !== null}
        filledIn={filledIn !== null}
        deployedAccountId={deployedAccountId}
        typed={typed}
        onType={(field, text) => {
          setTyped((typed) => ({ ...typed, [field]: text }));
          if (refusal?.field === field) setRefusal(null);
        }}
        refusal={refusal}
        onRefuse={refuse}
        onContinue={() => {
          setRefusal(null);
          setStep("model");
        }}
        onCancel={onClose}
      />
    ),
    model: (
      <ModelStep
        accountId={accountIdOf(typed.accountId)}
        offered={offered}
        model={model}
        onChoose={(model) => {
          setChosen(model);
          if (refusal?.field === "model" || refusal?.field === null) setRefusal(null);
        }}
        refusal={refusal}
        saving={saving}
        onSave={save}
        onBack={() => setStep("keys")}
      />
    ),
    done: saved && (
      <>
        <DialogDescription className="mb-4 leading-[1.65]">
          @ember is in every room open to everyone, running on <span className="wrap-anywhere">{modelName(saved.assistant.model, saved.assistant.models)}</span>.
          Asked to say hello, it said:
        </DialogDescription>
        <blockquote className="border-s-2 ps-3 whitespace-pre-wrap wrap-anywhere">{saved.greeting}</blockquote>
        {opened?.webTools?.includes("search") && !saved.assistant.webTools?.includes("search") && (
          <p className={cn(NOTE, "mt-4")}>{searchTurnedOff(saved.assistant.webTools, changeOf(opened, saved.assistant))}</p>
        )}
        <Actions back={null} next={onClose} nextLabel="Done" />
      </>
    ),
  };

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
        // What's typed isn't lost to a click beside it.
        onInteractOutside={(event) => event.preventDefault()}
        className={cn(DIALOG, "w-[480px]")}
      >
        <button type="button" aria-label="Close" disabled={saving} onClick={onClose} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle ref={title} tabIndex={-1} className={cn(DIALOG_TITLE, "pe-10 outline-none")}>
          {TITLES[step]}
        </DialogTitle>
        {steps[step]}
      </DialogContent>
    </Dialog>
  );
}

/** The model the menu shows chosen of those `offered`: the one `chosen`, or else Ember AI's, while it's offered, or else the one Ember suggests. */
const chosenOf = (chosen: string | null, assistant: AssistantSettings | null, offered: OfferedModels) =>
  chosen !== null && offeredModelOf(chosen, offered.models) ? chosen : startingModelOf(assistant?.model ?? null, offered);

/** The field of Set up Ember AI a refusal names, if it names one. */
function fieldOf(field: string | undefined): AssistantField | null {
  return field === "accountId" || field === "apiToken" || field === "model" ? field : null;
}

/** The buttons at a step's foot, as Set up Turnstile's are: going back, or else cancelling, and going on. */
export function Actions({
  back,
  backLabel = "Back",
  next,
  nextLabel = "Continue",
  disabled = false,
  saving = false,
}: {
  back: (() => void) | null;
  backLabel?: string;
  /** Goes on, or null when the step's form does, as its submit button. */
  next: (() => void) | null;
  nextLabel?: string;
  disabled?: boolean;
  saving?: boolean;
}) {
  return (
    <div className="mt-[26px] flex justify-end gap-2.5">
      {back && (
        <button type="button" disabled={saving} onClick={back} className={OTHER_ACTION}>
          {backLabel}
        </button>
      )}
      <button type={next ? "button" : "submit"} disabled={disabled || saving} onClick={next ?? undefined} className={MAIN_ACTION}>
        {nextLabel}
      </button>
    </div>
  );
}

/**
 * The first step: the Cloudflare account's ID and an API token of its, with AI Gateway's Run permission,
 * which go on to the model once they can be an account's, a token left blank keeping the one Ember has.
 * The dashboard opens at the account typed, once it can be one.
 */
function KeysStep({
  hasToken,
  filledIn,
  deployedAccountId,
  typed,
  onType,
  refusal,
  onRefuse,
  onContinue,
  onCancel,
}: {
  hasToken: boolean;
  /** Whether the account's ID was filled in, so that the steps needn't say where to copy it from. */
  filledIn: boolean;
  deployedAccountId: string | null;
  typed: Record<KeyField, string>;
  onType: (field: KeyField, text: string) => void;
  refusal: Refusal | null;
  onRefuse: (field: KeyField, error: string) => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const next = (event: FormEvent) => {
    event.preventDefault();
    if (accountIdOf(typed.accountId) === null) return onRefuse("accountId", ACCOUNT_ID_REFUSED);
    if (typed.apiToken.trim() !== "" && apiTokenOf(typed.apiToken) === null) return onRefuse("apiToken", API_TOKEN_REFUSED);
    onContinue();
  };
  const accountId = accountIdOf(typed.accountId);
  const accountRefused = refusal?.field === "accountId";
  const deployedTo = !accountRefused && deployedAccountId !== null && accountId === deployedAccountId;
  const tokenRefused = refusal?.field === "apiToken";

  return (
    <form onSubmit={next}>
      <DialogDescription className="mb-4 leading-[1.65]">
        Ember AI asks Claude, GPT or Grok through your Cloudflare account's AI Gateway, paid for with AI Gateway's credits, or a model Cloudflare runs on Workers
        AI. Ember keeps the API token encrypted.
      </DialogDescription>
      <ol aria-label="Steps to make an API token" className="mb-4 flex list-decimal flex-col gap-2 ps-5">
        <li>
          In the Cloudflare dashboard, open <em>Account API tokens</em> and choose <em>Create Token</em>.{" "}
          <Out href={accountApiTokens(accountId)}>Open Account API tokens in the Cloudflare dashboard</Out>
        </li>
        <li>
          Under <em>Custom Token</em>, choose <em>Get started</em>, name the token, and under <em>Permissions</em> choose <em>Account</em>, <em>AI Gateway</em>{" "}
          and <em>Run</em>. Then <em>Add more</em>: <em>Account</em>, <em>AI Gateway</em> and <em>Read</em>, and <em>Account</em>, <em>Workers AI</em> and{" "}
          <em>Read</em>.
        </li>
        <li>
          Choose <em>Continue to summary</em>, then <em>Create Token</em>, and copy the token here.
        </li>
        {!filledIn && (
          <li>
            Copy the account's ID too: search the dashboard for <em>Copy account ID</em>.
          </li>
        )}
      </ol>
      <div className="flex flex-col gap-4">
        <div>
          <Field id="assistant_account_id" label="Account ID">
            <Input
              id="assistant_account_id"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={typed.accountId}
              aria-invalid={accountRefused}
              aria-describedby={accountRefused ? "assistant-account-id-refusal" : deployedTo ? "assistant-account-id-description" : undefined}
              onChange={(event) => onType("accountId", event.target.value)}
              className={FIELD_INPUT}
            />
          </Field>
          {accountRefused ? (
            <FieldRefusal id="assistant-account-id-refusal" field="accountId" refusal={refusal} />
          ) : (
            deployedTo && (
              <p id="assistant-account-id-description" className={cn(NOTE, "mt-2")}>
                Ember is deployed to this account. To ask through another, paste that account's ID.
              </p>
            )
          )}
        </div>
        <div>
          <Field id="assistant_api_token" label="API token">
            <Input
              id="assistant_api_token"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={typed.apiToken}
              aria-invalid={tokenRefused}
              aria-describedby={tokenRefused ? "assistant-api-token-refusal" : hasToken ? "assistant-api-token-description" : undefined}
              onChange={(event) => onType("apiToken", event.target.value)}
              className={FIELD_INPUT}
            />
          </Field>
          {tokenRefused ? (
            <FieldRefusal id="assistant-api-token-refusal" field="apiToken" refusal={refusal} />
          ) : (
            hasToken && (
              <p id="assistant-api-token-description" className={cn(NOTE, "mt-2")}>
                Ember has an API token already. Leave this blank to keep it, or paste another to ask with it instead. Either needs the AI Gateway Run and Read and the
                Workers AI Read permissions.
              </p>
            )
          )}
        </div>
      </div>
      <Actions back={onCancel} backLabel="Cancel" next={null} disabled={typed.accountId.trim() === "" || (!hasToken && typed.apiToken.trim() === "")} />
    </form>
  );
}

/**
 * The second step: the model @ember runs on, of those Ember offers, `offered`, once the Worker lists them,
 * which Save asks a test question. AI Gateway's credits are topped up in the account given, `accountId`.
 */
function ModelStep({
  accountId,
  offered,
  model,
  onChoose,
  refusal,
  saving,
  onSave,
  onBack,
}: {
  accountId: string | null;
  offered: OfferedModels | null;
  model: string;
  onChoose: (model: string) => void;
  refusal: Refusal | null;
  saving: boolean;
  onSave: () => void;
  onBack: () => void;
}) {
  const save = (event: FormEvent) => {
    event.preventDefault();
    onSave();
  };

  return (
    <form onSubmit={save}>
      <DialogDescription className="mb-4 leading-[1.65]">
        Choose the model @ember answers everyone with. Ember asks it a test question through AI Gateway before keeping it. You can let people pick other models
        later.
      </DialogDescription>
      <ModelPicker
        models={offered?.models ?? null}
        chosen={model}
        onChoose={onChoose}
        refusal={refusal}
        disabled={saving}
        accountId={accountId}
        workersAi={offered?.workersAi ?? null}
      />
      <p role="status" className={cn(NOTE, "mt-2 wrap-anywhere empty:mt-0", !saving && "text-negative")}>
        {saving ? `Asking ${modelName(model, offered?.models)} a test question…` : refusal?.field === null ? refusal.error : null}
      </p>
      <Actions back={onBack} next={null} nextLabel={saving ? "Asking…" : "Save"} disabled={offered === null} saving={saving} />
    </form>
  );
}
