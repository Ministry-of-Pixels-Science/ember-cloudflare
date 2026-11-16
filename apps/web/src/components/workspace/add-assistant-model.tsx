import { useEffect, useRef, useState, type FormEvent } from "react";
import { modelName, type AssistantField, type AssistantSettings, type OfferedModel, type OfferedModels } from "@ember/protocol/assistant";
import { Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useMounted } from "@/hooks/use-mounted";
import { addAssistantModel, ApiError, isSignedOut } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Actions } from "./assistant-setup";
import { ModelPicker, NOTE, type Refusal } from "./model-picker";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE } from "./unsaved-changes";

// Add a model, for administrators: a model people can pick for @ember to answer them with, of those Ember
// offers through Ember AI's account, as the Ember AI card has them listed, but those people can pick
// already, in a dialog that the card's Add a model opens. The Worker asks it a test question through AI
// Gateway before adding it, saying why it didn't answer, if it didn't. Then what the model said. Styled as
// Set up Ember AI is.

/** The models Ember offers, `offered`, that people can't pick yet, as Ember AI is `assistant`. */
export const modelsToAddTo = (assistant: AssistantSettings, offered: readonly OfferedModel[]) =>
  offered.filter(({ id }) => !assistant.models.some((listed) => listed.id === id));

interface Props {
  assistant: AssistantSettings;
  /** The models Ember offers, as the Worker listed them, or null until it has. */
  offered: OfferedModels | null;
  /** Shows Ember AI as adding the model leaves it. */
  onAdded: (assistant: AssistantSettings) => void;
  onClose: () => void;
  /** Says why adding failed, when it isn't the model's doing or AI Gateway's, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Add a model: the models Ember offers that people can't pick yet, the one chosen added once it answers a test question. */
export function AddAssistantModel({ assistant, offered, onAdded, onClose, onFailed }: Props) {
  // The models people can pick already aren't offered again.
  const toAdd = offered && modelsToAddTo(assistant, offered.models);
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = (picked !== null && toAdd?.some(({ id }) => id === picked) ? picked : toAdd?.[0]?.id) ?? "";
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Asking the model a test question holds the dialog open until it's answered.
  const [saving, setSaving] = useState(false);
  const [added, setAdded] = useState<{ name: string; greeting: string } | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const mounted = useMounted();

  // What the model said starts at the title, so that it's read first.
  useEffect(() => {
    if (added) title.current?.focus();
  }, [added]);

  const add = (event: FormEvent) => {
    event.preventDefault();
    setRefusal(null);
    setSaving(true);
    addAssistantModel({ model: chosen }).then(
      (answer) => {
        onAdded(answer.assistant);
        if (!mounted.current) return;
        setSaving(false);
        setAdded({ name: modelName(chosen, answer.assistant.models), greeting: answer.greeting });
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        // What AI Gateway or the Worker said of the model, or that AI Gateway didn't answer, which the dialog says itself.
        if (error instanceof ApiError && [422, 429, 502].includes(error.status)) return setRefusal({ field: fieldOf(error.field), error: error.message });
        onFailed(error);
      },
    );
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
          {added ? "Model added" : "Add a model"}
        </DialogTitle>
        {added ? (
          <>
            <DialogDescription className="mb-4 leading-[1.65]">
              People can pick <span className="wrap-anywhere">{added.name}</span> on their profile now. Asked to say hello, it said:
            </DialogDescription>
            <blockquote className="border-s-2 ps-3 whitespace-pre-wrap wrap-anywhere">{added.greeting}</blockquote>
            <Actions back={null} next={onClose} nextLabel="Done" />
          </>
        ) : (
          <form onSubmit={add}>
            <DialogDescription className="mb-4 leading-[1.65]">
              Choose a model people can pick for @ember to answer them with. Ember asks it a test question through AI Gateway before adding it.
            </DialogDescription>
            <ModelPicker
              models={toAdd}
              chosen={chosen}
              onChoose={(model) => {
                setPicked(model);
                setRefusal(null);
              }}
              refusal={refusal}
              disabled={saving}
              accountId={assistant.accountId}
              workersAi={offered?.workersAi ?? null}
            />
            <p role="status" className={cn(NOTE, "mt-2 wrap-anywhere empty:mt-0", !saving && "text-negative")}>
              {saving ? `Asking ${modelName(chosen, toAdd ?? [])} a test question…` : refusal?.field === null ? refusal.error : null}
            </p>
            <Actions back={onClose} backLabel="Cancel" next={null} nextLabel={saving ? "Asking…" : "Add"} disabled={chosen === ""} saving={saving} />
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The field a refusal names, which can only be the model's here, if it names one. */
const fieldOf = (field: string | undefined): AssistantField | null => (field === "model" ? field : null);
