import { useState } from "react";
import { modelName, type YourAssistant, type YourAssistantChanges } from "@ember/protocol/assistant";
import { useMounted } from "@/hooks/use-mounted";
import { changeYourAssistant, isSignedOut } from "@/lib/api";
import { LevelDials } from "./level-dials";
import { NOTE, SELECT } from "./model-picker";

// The Ember AI section of your profile, while Ember AI is on: which of the models administrators let
// people pick @ember answers you with, when they let people pick from more than one, how much it thinks
// before it answers you, and how long its answers to you are, up to the most administrators allow. A
// choice saves at once, and shows as it was again if it isn't saved. Default follows the administrators'
// choice of model, whichever they choose, while a model picked by name stays yours, even the one they
// chose. Boxed as the Memberful section is.

/** What the Model menu says under it. */
export const DEFAULT_MODEL_EXPLAINED =
  "Default is the model an administrator chose for everyone, and changes when they choose another. A model you pick stays yours, unless it's removed, when @ember answers you with the default.";

/** The Model menu's value for Default, which leaves your model to administrators. */
const DEFAULT = "";

interface Props {
  /** Your model and levels, the most each level may be, and the models you can pick. */
  assistant: YourAssistant;
  /** Shows your model and levels as a change leaves them, or as they were again when it fails, or none once Ember AI is off. */
  onChanged: (assistant: YourAssistant | null) => void;
  /** Says why a change wasn't saved, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Your Model menu, and your Thinking and Answer length dials, each up to the most administrators allow. */
export function AnswerLevels({ assistant, onChanged, onFailed }: Props) {
  const [saving, setSaving] = useState(false);
  const mounted = useMounted();
  const picking = assistant.models.length > 1;
  const answering = assistant.models.find(({ id }) => id === (assistant.model ?? assistant.defaultModel));

  const change = (changes: YourAssistantChanges) => {
    const { model, ...levels } = changes;
    setSaving(true);
    onChanged({ ...assistant, model: model === undefined ? assistant.model : model, levels: { ...assistant.levels, ...levels } });
    changeYourAssistant(changes).then(
      (changed) => {
        if (!mounted.current) return;
        setSaving(false);
        onChanged(changed);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        onChanged(assistant);
        onFailed(error);
      },
    );
  };

  return (
    <section aria-labelledby="answer-levels-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 max-md:px-3">
      <h2 id="answer-levels-heading" className="text-base font-semibold">
        Ember AI
      </h2>
      <p>
        {picking
          ? "Which model @ember answers you with, how much it thinks first, and how long its answers are, up to the most an administrator allows."
          : "How much @ember thinks before it answers you, and how long its answers are, up to the most an administrator allows."}
      </p>
      <div className="flex flex-col gap-4">
        {picking && (
          // Labelled as the dials under it are.
          <div className="flex max-w-[24em] flex-col gap-1.5">
            <label htmlFor="your_assistant_model" className="text-sm font-semibold">
              Model
            </label>
            <select
              id="your_assistant_model"
              value={assistant.model ?? DEFAULT}
              disabled={saving}
              aria-describedby="your-assistant-model-note"
              onChange={(event) => change({ model: event.target.value === DEFAULT ? null : event.target.value })}
              className={SELECT}
            >
              <option value={DEFAULT}>{`Default (${modelName(assistant.defaultModel, assistant.models)})`}</option>
              {assistant.models.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <p id="your-assistant-model-note" className={NOTE}>
              {DEFAULT_MODEL_EXPLAINED}
            </p>
          </div>
        )}
        <LevelDials name="answer-levels" levels={assistant.levels} most={assistant.most} model={answering} disabled={saving} onChange={change} />
      </div>
    </section>
  );
}
