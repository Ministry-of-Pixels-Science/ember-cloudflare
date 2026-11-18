import { useContext, useEffect, useEffectEvent, useLayoutEffect, useState, type FormEvent } from "react";
import { ASSISTANT_ID, ASSISTANT_NAME, AVATAR_TOO_LARGE, MAX_AVATAR_SIZE, type Me, type WorkspaceSettings } from "@ember/protocol";
import {
  ANSWER_WORDS,
  ASSISTANT_OFF,
  cannotSearchWith,
  DEFAULT_LEVELS,
  MAX_ASSISTANT_MODELS,
  MAX_INSTRUCTIONS_LENGTH,
  MODELS_FULL,
  modelName,
  noLongerOffered,
  PAGES_READ_PER_ANSWER,
  WEB_SEARCHES_PER_ANSWER,
  withinMost,
  type AssistantChanges,
  type AssistantModel,
  type AssistantSettings as Assistant,
  type OfferedModels,
  type WebTool,
} from "@ember/protocol/assistant";
import { EMBER_TEMPLATE, promptAround, templateRefusal, webPromptFor, type Prompt } from "@ember/protocol/prompts";
import { FIELD_INPUT } from "@/components/field";
import { useFlash } from "@/components/flash";
import { Switch } from "@/components/ui/switch";
import { useAccount } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { useMounted } from "@/hooks/use-mounted";
import { useOfferedModels } from "@/hooks/use-offered-models";
import { useTitle } from "@/hooks/use-title";
import {
  ApiError,
  changeAssistantAvatar,
  changeAssistantSettings,
  changeWebSearch,
  fetchWorkspaceSettings,
  isSignedOut,
  removeAssistantAvatar,
  removeAssistantModel,
} from "@/lib/api";
import { avatarVariantOf } from "@/lib/previews";
import { cn } from "@/lib/utils";
import { AddAssistantModel, modelsToAddTo } from "./add-assistant-model";
import { AGENTS_PATH, useAgentsOnly } from "./agent-list";
import { AgentTools } from "./agent-tools";
import { AssistantSetup, searchTurnedOff } from "./assistant-setup";
import { BUTTON } from "./email-settings";
import { LevelDials } from "./level-dials";
import { NO_LONGER_OFFERED } from "./model-picker";
import { PictureField } from "./picture-picker";
import { PromptPreview } from "./prompt-preview";
import { CHANGES_SAVED, PageHeading, Panel, SettingsPage } from "./settings-page";
import { UnsavedChanges } from "./unsaved-changes";
import { avatarVersionOf } from "./user-avatar";

// @ember's page, for administrators while Ember AI is on, which the Agents card links to as it does each
// agent's: what the Ember AI card held before there were agents, as the project's owner chose in the
// mock-ups (2026-11-10). It shows @ember's avatar, which a picture picked replaces, as the project's
// owner asked (2026-11-05), and Use Ember's flame takes away again, the Instructions administrators add
// to Ember's own, with what Ember adds around them, which they may modify with caution, as the project's
// owner asked (2026-11-11), the models people can pick on their profile, the one
// that answers everyone else chosen, with Add a model and each other's Remove, Search the web's switch,
// which turns on once the model that answers everyone has searched the web for a test question, saying
// what it found, or opens Set up Ember AI for a model that can't search, and the dials of the most
// @ember may think and write for anyone's question. Each change saves at once, but the instructions and
// what Ember adds around them, which Save instructions saves, or Save beside what's modified. While one
// saves, nothing else can change, so that the save's answer can't show Ember AI as it was.

/** What @ember's page says of it. */
export const EMBER_EXPLAINED = "Ember's own agent, @ember, which answers anything people ask in every room open to everyone.";

/** What the page says of @ember's instructions. */
export const INSTRUCTIONS_EXPLAINED =
  "@ember follows Ember's own instructions. Add yours to them, such as how your team likes answers written, or what to leave to people.";

/** What leaving the page with instructions unsaved asks. */
export const INSTRUCTIONS_UNSAVED = "You’ve changed @ember’s instructions. Save them before you leave, or discard them to keep things as they were.";

/** What the page says of its models. */
export const MODELS_EXPLAINED = "People can pick any of these on their profile for @ember to answer them with. The one chosen here answers everyone else.";

/** What it says under Add a model once people can pick every model Ember offers. */
export const EVERY_MODEL_ADDED = "People can pick every model Ember offers.";

/** What the page says of its dials. */
export const LIMITS_EXPLAINED =
  "The most @ember may think and write for anyone's question. Each person picks their own levels on their profile, up to these. AI Gateway's spend limits can cap what each person's questions cost, as every request says who asked.";

/** What the page says of Search the web while it's off, for a model that can search. */
export const WEB_SEARCH_OFF = `@ember answers from what its model learned in training. Turn this on to let it search the web when a question needs what's current, at most ${WEB_SEARCHES_PER_ANSWER} times an answer, and list the pages it used under its answer.`;

/** What the page says of Search the web while it's on, letting @ember do `webTools` on the web, while people can pick from `models`. */
export function webSearchOn(webTools: WebTool[], models: readonly AssistantModel[]): string {
  const reads = webTools.includes("read") ? `, and reads the pages people link to or its searches find, at most ${PAGES_READ_PER_ANSWER}` : "";
  const picked = models.length > 1 ? " A model someone picks searches too, if it can." : "";
  return `@ember searches the web when a question needs it, at most ${WEB_SEARCHES_PER_ANSWER} times an answer${reads}, and lists the pages it used under its answer.${picked} AI Gateway's credits pay for each search.`;
}

/** What the page says while the model called `name` searches the web for Search the web's test question. */
export const searchingWith = (name: string) => `Asking ${name} something it has to search the web for…`;

/** What the page says of @ember's avatar while it's Ember's flame. */
export const AVATAR_EXPLAINED = "Everyone sees it beside @ember's answers. Choose a picture of your own in place of Ember's flame.";

/** What it says once an administrator has uploaded one. */
export const UPLOADED_AVATAR_EXPLAINED = "Everyone sees it beside @ember's answers. Choose another picture, or go back to Ember's flame.";

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** Where leaving @ember's page goes, which is always away from what's typed there. */
const leaves = () => false;

/** The instructions' box: Campfire's `.input` as a textarea, which can be made taller. */
export const TEXTAREA = cn("w-full border placeholder:text-muted-foreground disabled:opacity-50", FIELD_INPUT, "resize-y");

/** How many characters of the most there can be `text` has, as the instructions' boxes count them. */
export const lengthOf = (text: string) => `${text.length.toLocaleString("en-US")} of ${MAX_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters`;

/**
 * @ember's page, which only administrators may open while Ember AI is on: anyone else is sent to
 * workspace settings at once, reading nothing, and an administrator to the AI assistant tab while it's
 * off, each saying why. Set up Ember AI opens over it for Search the web with a model that can't search.
 */
export function EmberPage({ me, onFailed }: { me: Me; onFailed: (error: unknown) => void }) {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const { forbidden, off, failed } = useAgentsOnly(onFailed);
  useTitle("Edit agent");

  // Before the page paints, so anyone else never sees it.
  useLayoutEffect(() => {
    if (!me.administrator) forbidden();
  }, [me.administrator, forbidden]);

  useEffect(() => {
    if (!me.administrator) return;
    let stopped = false;
    fetchWorkspaceSettings().then(
      (read) => {
        if (stopped) return;
        if (read.assistant === null) off();
        else setSettings(read);
      },
      (error: unknown) => {
        // A page left before Ember AI loads only reports a session that's ended, which goes to sign in.
        if (!stopped || isSignedOut(error)) failed(error);
      },
    );
    return () => void (stopped = true);
  }, [me.administrator, off, failed]);

  const assistant = settings?.assistant ?? null;
  const show = (changed: Assistant) => setSettings((shown) => shown && { ...shown, assistant: changed });
  return (
    <SettingsPage back={AGENTS_PATH}>
      <Panel aria-busy={assistant === null} className="flex flex-col gap-6">
        <PageHeading title={ASSISTANT_NAME} className="mb-0">
          {EMBER_EXPLAINED}
        </PageHeading>
        {settings && assistant && (
          <>
            <EmberSettings me={me} assistant={assistant} onSetUp={() => setSettingUp(true)} onStopped={off} onChanged={show} onFailed={failed} />
            <AgentTools agentId={ASSISTANT_ID} name="@ember" onFailed={failed} />
            {settingUp && (
              <AssistantSetup assistant={assistant} deployedAccountId={settings.cloudflareAccountId} onSaved={show} onClose={() => setSettingUp(false)} onFailed={failed} />
            )}
          </>
        )}
      </Panel>
    </SettingsPage>
  );
}

interface Props {
  /** Who's looking, whom What Ember adds around them shows asking @ember. */
  me: Me;
  assistant: Assistant;
  /** Opens Set up Ember AI. */
  onSetUp: () => void;
  /** Shows that Ember AI is off, once it's found to be. */
  onStopped: () => void;
  /** Shows Ember AI as a change to @ember leaves it, or as it was again when the change fails. */
  onChanged: (assistant: Assistant) => void;
  /** Says why a change failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * What came of turning Search the web on: the model is searching, said what it found, or why it didn't
 * turn on, or else that choosing another model turned it off.
 */
type WebTest = "searching" | { found: string } | { refusal: string } | { off: string };

/** Whether Ember AI, as `assistant` has it, searches the web. */
const searchesIn = (assistant: Assistant) => assistant.webTools?.includes("search") ?? false;

/**
 * What @ember is told around its instructions, from `template`, when `me` writes to it, as it answers
 * anyone who hasn't picked its levels, which Limits may hold lower.
 */
function emberPrompt(me: Me, community: string, assistant: Assistant, template: string): Prompt {
  const web = webPromptFor(me.name, assistant.webTools ?? [], searchesIn(assistant));
  const { length } = withinMost(DEFAULT_LEVELS, assistant.most);
  return promptAround(ASSISTANT_ID, ASSISTANT_NAME, me.name, { community, roomName: null, inThread: false }, ANSWER_WORDS[length], web, new Date(), template);
}

/** @ember's settings, in one card. */
export function EmberSettings({ me, assistant, onSetUp, onStopped, onChanged, onFailed }: Props) {
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  // Whether Search the web is turning on or off, while it saves.
  const [turningWeb, setTurningWeb] = useState<boolean | null>(null);
  const [webTest, setWebTest] = useState<WebTest | null>(null);
  /** The address of the picture picked for @ember's avatar, shown while it saves. */
  const [pickedAvatar, setPickedAvatar] = useState<string | null>(null);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const busy = saving || savingAvatar || turningWeb !== null;
  // The models Ember offers through Ember AI's account, for Add a model and for saying which people can pick that it no longer offers.
  const offered = useOfferedModels(true, { accountId: assistant.accountId }, onFailed);
  const people = useContext(PeopleContext);
  const community = useAccount().name;
  const flash = useFlash();
  const mounted = useMounted();

  // The picked picture's address is let go of once the saved one takes its place.
  useEffect(() => () => void (pickedAvatar && URL.revokeObjectURL(pickedAvatar)), [pickedAvatar]);

  // Another tab may change @ember's avatar, which the people directory hears of: Ember AI is read again
  // then, for whether an administrator uploaded the one it has now, but not while a change of the page's
  // own saves. That drops a read begun before, which could answer after the change and show Ember AI as
  // it was. The change's answer has the avatar, or else Ember AI is read again once it's done.
  const listedAvatarUrl = people.get(ASSISTANT_ID)?.avatarUrl;
  const changedElsewhere = !busy && listedAvatarUrl !== undefined && avatarVersionOf(listedAvatarUrl) > avatarVersionOf(assistant.avatarUrl);
  const showRead = useEffectEvent(({ assistant: read }: WorkspaceSettings) => (read ? onChanged(read) : onStopped()));
  const readFailed = useEffectEvent((error: unknown) => onFailed(error));
  useEffect(() => {
    if (!changedElsewhere) return;
    let stopped = false;
    fetchWorkspaceSettings().then(
      (settings) => {
        if (!stopped) showRead(settings);
      },
      (error: unknown) => {
        // A read that's been replaced, or that outlived the page, only reports a session that's ended, which goes to sign in.
        if (!stopped || isSignedOut(error)) readFailed(error);
      },
    );
    return () => void (stopped = true);
  }, [changedElsewhere, listedAvatarUrl]);

  /** Shows Ember AI as `changed` at once, and saves it with `save`, showing it as it was, `shown`, again if it isn't saved. */
  const saveShown = (shown: Assistant, changed: Assistant, save: () => Promise<Assistant>) => {
    setSaving(true);
    onChanged(changed);
    save().then(
      (saved) => {
        onChanged(saved);
        if (mounted.current) setSaving(false);
      },
      (error: unknown) => {
        onChanged(shown);
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        onFailed(error);
      },
    );
  };

  /**
   * Changes the model that answers everyone, or the most of the dials, by `changes`. Another model may not
   * take the same tools for the web, so choosing one turns Search the web off, which the page then says.
   */
  const change = (shown: Assistant, { model, ...levels }: AssistantChanges) =>
    saveShown(shown, { ...shown, model: model ?? shown.model, most: { ...shown.most, ...levels } }, async () => {
      const saved = await changeAssistantSettings({ ...levels, ...(model && { model }) });
      if (mounted.current && saved.model !== shown.model) setWebTest(searchesIn(shown) && !searchesIn(saved) ? { off: searchTurnedOff(saved.webTools) } : null);
      return saved;
    });

  /** Takes `model` out of the models people can pick. */
  const remove = (shown: Assistant, model: string) =>
    saveShown(shown, { ...shown, models: shown.models.filter(({ id }) => id !== model) }, () => removeAssistantModel(model));

  /**
   * Saves `changes` to what Ember adds to @ember's own instructions, or around them, settling with Ember AI
   * once they're saved, or failing, leaving what's typed as it is.
   */
  const saveInstructions = async (changes: InstructionChanges) => {
    setSaving(true);
    try {
      const saved = await changeAssistantSettings(changes);
      onChanged(saved);
      flash("notice", CHANGES_SAVED);
      return saved;
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  /** Turns Search the web `on`, once the model has searched, or off, saying what came of it. */
  const turnWebSearch = (on: boolean) => {
    setTurningWeb(on);
    setWebTest(on ? "searching" : null);
    changeWebSearch(on).then(
      ({ assistant, found }) => {
        onChanged(assistant);
        if (!mounted.current) return;
        setTurningWeb(null);
        setWebTest(found === null ? null : { found });
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setTurningWeb(null);
        // What AI Gateway or the model made of searching, or that Ember AI changed meanwhile, which the page says itself,
        // though not that it was turned off, which takes the page away.
        if (error instanceof ApiError && ([422, 429, 502].includes(error.status) || (error.status === 409 && error.message !== ASSISTANT_OFF))) return setWebTest({ refusal: error.message });
        setWebTest(null);
        onFailed(error);
      },
    );
  };

  /** Saves `file` as @ember's avatar, once a picture is picked. */
  const saveAvatar = (file: File) => {
    if (file.size > MAX_AVATAR_SIZE) return flash("alert", AVATAR_TOO_LARGE);
    setPickedAvatar(URL.createObjectURL(file));
    showAvatar(avatarVariantOf(file).then((variant) => changeAssistantAvatar({ file, variant })), CHANGES_SAVED);
  };

  /** Shows @ember's avatar as `change` saves it, flashing `notice` once it has. */
  function showAvatar(change: Promise<Assistant>, notice?: string) {
    setSavingAvatar(true);
    change.then(
      (saved) => {
        onChanged(saved);
        if (!mounted.current) return;
        setSavingAvatar(false);
        setPickedAvatar(null);
        if (notice) flash("notice", notice);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSavingAvatar(false);
        setPickedAvatar(null);
        onFailed(error);
      },
    );
  }

  /** Opens the setup, whose model, once it's saved, may not be the one the page said searched, or didn't. */
  const setUp = () => {
    setWebTest(null);
    onSetUp();
  };

  return (
    <section aria-label="@ember" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] pb-4 text-start max-md:px-3 [&>:first-child]:border-t-0">
      <Avatar
        src={pickedAvatar ?? latestAvatarUrl(assistant.avatarUrl, listedAvatarUrl)}
        uploaded={assistant.avatar}
        disabled={busy}
        onChoose={saveAvatar}
        // Use Ember's flame: no confirmation first, and no notice after, as Remove icon.
        onRemove={() => showAvatar(removeAssistantAvatar())}
      />
      <Instructions
        saved={assistant.instructions}
        savedTemplate={assistant.promptTemplate ?? EMBER_TEMPLATE}
        promptOf={(template) => emberPrompt(me, community, assistant, template)}
        disabled={busy}
        onSave={saveInstructions}
        onFailed={onFailed}
      />
      <Models
        assistant={assistant}
        offered={offered}
        disabled={busy}
        onChoose={(model) => change(assistant, { model })}
        onRemove={(model) => remove(assistant, model)}
        onAdd={() => setAdding(true)}
      />
      <WebSearch assistant={assistant} turning={turningWeb} test={webTest} disabled={busy} onTurn={turnWebSearch} onSetUp={setUp} />
      <div className="flex flex-col gap-3 border-t pt-4">
        <div>
          <h3 className="text-sm font-semibold">Limits</h3>
          <p className={NOTE}>{LIMITS_EXPLAINED}</p>
        </div>
        <LevelDials name="assistant-most" levels={assistant.most} disabled={busy} onChange={(changes) => change(assistant, changes)} />
      </div>
      {adding && <AddAssistantModel assistant={assistant} offered={offered} onAdded={onChanged} onClose={() => setAdding(false)} onFailed={onFailed} />}
    </section>
  );
}

/** What @ember's Instructions save: what Ember adds to its own instructions, and around them, null for Ember's own. */
type InstructionChanges = Pick<AssistantChanges, "instructions" | "promptTemplate">;

/**
 * @ember's Instructions: what administrators add to Ember's own, `saved`, in a box that Save instructions
 * saves once what's typed differs, and What Ember adds around them, as `promptOf` has it from the template,
 * `savedTemplate` until it's modified, which Save instructions saves too, as does Save beside it. Leaving
 * the page with either unsaved asks first, even while another change on the page saves.
 */
function Instructions({
  saved,
  savedTemplate,
  promptOf,
  disabled,
  onSave,
  onFailed,
}: {
  saved: string;
  savedTemplate: string;
  promptOf: (template: string) => Prompt;
  disabled: boolean;
  onSave: (changes: InstructionChanges) => Promise<Assistant>;
  onFailed: (error: unknown) => void;
}) {
  // What's typed in each box, or null while it's as Ember AI has it, when it follows what another tab saves.
  const [typed, setTyped] = useState<string | null>(null);
  const [typedTemplate, setTypedTemplate] = useState<string | null>(null);
  // Why the template was refused, which What Ember adds around them opens to say.
  const [refusal, setRefusal] = useState<{ error: string } | null>(null);
  const instructions = typed ?? saved;
  const template = typedTemplate ?? savedTemplate;
  const instructionsChanged = typed !== null && typed.trim() !== saved;
  const templateChanged = typedTemplate !== null && typedTemplate.trim() !== savedTemplate;
  const changed = instructionsChanged || templateChanged;
  const mounted = useMounted();

  /** Why the template typed can't be saved, which What Ember adds around them opens to say, or null. */
  const refused = () => {
    const error = templateChanged ? templateRefusal(template.trim()) : null;
    if (error !== null) setRefusal({ error });
    return error;
  };

  /**
   * Saves what's changed, which the boxes then show as saved, but for anything typed while it saves, which
   * stays unsaved, unless the template is one Ember doesn't take.
   */
  const save = () => {
    const error = refused();
    if (error !== null) return Promise.reject(new Error(error));
    const sent = instructions.trim();
    const sentTemplate = template.trim();
    const changes: InstructionChanges = {
      ...(instructionsChanged && { instructions: sent }),
      ...(templateChanged && { promptTemplate: sentTemplate === EMBER_TEMPLATE ? null : sentTemplate }),
    };
    return onSave(changes).then((assistant) => {
      if (!mounted.current) return assistant;
      setTyped((typed) => (typed?.trim() === sent ? null : typed));
      setTypedTemplate((typed) => (typed?.trim() === sentTemplate ? null : typed));
      return assistant;
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed && !disabled && refused() === null) save().catch((error: unknown) => (mounted.current || isSignedOut(error)) && onFailed(error));
  };

  const changeTemplate = (template: string) => {
    setTypedTemplate(template);
    setRefusal(null);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t pt-4">
      <div>
        <h3 id="ember-instructions-heading" className="text-sm font-semibold">
          Instructions
        </h3>
        <p id="ember-instructions-description" className={NOTE}>
          {INSTRUCTIONS_EXPLAINED}
        </p>
      </div>
      <textarea
        id="ember_instructions"
        aria-labelledby="ember-instructions-heading"
        aria-describedby="ember-instructions-description ember-instructions-count"
        rows={4}
        maxLength={MAX_INSTRUCTIONS_LENGTH}
        placeholder="Answer in British English, and send billing questions to the Support room."
        value={instructions}
        onChange={(event) => setTyped(event.target.value)}
        className={TEXTAREA}
      />
      <div className="flex flex-wrap items-center justify-between gap-x-[1ch] gap-y-2">
        <p id="ember-instructions-count" className={NOTE}>
          {lengthOf(instructions)}
        </p>
        <button type="submit" disabled={disabled || !changed} className={BUTTON}>
          Save instructions
        </button>
      </div>
      <PromptPreview
        name="@ember"
        prompt={promptOf(template.trim())}
        template={template}
        ownTemplate={EMBER_TEMPLATE}
        refusal={refusal}
        disabled={false}
        onChange={changeTemplate}
        heading="h4"
        save={
          <button type="submit" disabled={disabled || !changed} className={BUTTON}>
            Save
          </button>
        }
      />
      <UnsavedChanges changed={changed} stays={leaves} onSave={save} description={INSTRUCTIONS_UNSAVED} />
    </form>
  );
}

/** @ember's avatar as the card last saw it, or as the people directory has it, when another tab has changed it since. */
const latestAvatarUrl = (shown: string, listed: string | undefined) => (listed && avatarVersionOf(listed) > avatarVersionOf(shown) ? listed : shown);

/**
 * @ember's avatar, while Ember AI is on: the picture `src` in a circle with a camera on its corner, which
 * picks a picture to replace it at once, as your avatar on your profile, and Use Ember's flame, which
 * takes away the picture an administrator `uploaded`, where one did.
 */
function Avatar({ src, uploaded, disabled, onChoose, onRemove }: { src: string; uploaded: boolean; disabled: boolean; onChoose: (file: File) => void; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-x-[2ch] border-t pt-4">
      <PictureField id="assistant_avatar" src={src} alt="@ember's avatar" label="Upload @ember's avatar" size="small" disabled={disabled} onChoose={onChoose} />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
        <div>
          <h3 className="text-sm font-semibold">Avatar</h3>
          <p id="assistant_avatar-description" className={NOTE}>
            {uploaded ? UPLOADED_AVATAR_EXPLAINED : AVATAR_EXPLAINED}
          </p>
        </div>
        {uploaded && (
          <button type="button" disabled={disabled} onClick={onRemove} className={BUTTON}>
            Use Ember's flame
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The models people can pick, in the order they were added, each a radio button that chooses it to
 * answer everyone else, with a Remove for each but that one, and saying so of one Ember no longer
 * offers (`noLongerOffered`), as the Worker lists them, `offered`, once it has, and Add a model under them,
 * until there are as many as there can be, or people can pick every model Ember offers.
 */
function Models({
  assistant,
  offered,
  disabled,
  onChoose,
  onRemove,
  onAdd,
}: {
  assistant: Assistant;
  offered: OfferedModels | null;
  disabled: boolean;
  onChoose: (model: string) => void;
  onRemove: (model: string) => void;
  onAdd: () => void;
}) {
  const full = assistant.models.length >= MAX_ASSISTANT_MODELS;
  const noneToAdd = offered !== null && modelsToAddTo(assistant, offered.models).length === 0;
  const why = full ? MODELS_FULL : noneToAdd ? EVERY_MODEL_ADDED : null;
  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div>
        <h3 id="assistant-models-heading" className="text-sm font-semibold">
          Models
        </h3>
        <p id="assistant-models-description" className={NOTE}>
          {MODELS_EXPLAINED}
        </p>
      </div>
      <fieldset aria-labelledby="assistant-models-heading" aria-describedby="assistant-models-description" className="flex min-w-0 flex-col gap-1">
        {assistant.models.map(({ id, name }) => (
          <div key={id} className="flex items-center gap-[1ch]">
            {/* For fingers, the box sits far enough into its label for a fingertip on it to land on the label. */}
            <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 has-disabled:cursor-default touch:-ms-3.5 touch:ps-3.5">
              <input
                type="radio"
                name="assistant-model"
                value={id}
                checked={assistant.model === id}
                disabled={disabled}
                onChange={() => onChoose(id)}
                className="size-4 flex-none accent-foreground"
              />
              <span className="min-w-0 wrap-anywhere">
                {name}
                {offered && noLongerOffered(id, offered.models, offered.workersAi) && (
                  <>
                    {" "}
                    <span className="text-muted-foreground">({NO_LONGER_OFFERED})</span>
                  </>
                )}
              </span>
            </label>
            {assistant.model !== id && (
              <button type="button" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => onRemove(id)} className={BUTTON}>
                Remove
              </button>
            )}
          </div>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-x-[1ch] gap-y-2">
        <button type="button" disabled={disabled || why !== null} onClick={onAdd} aria-describedby={why ? "assistant-models-full" : undefined} className={BUTTON}>
          Add a model
        </button>
        {why && (
          <p id="assistant-models-full" className={NOTE}>
            {why}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Search the web, while Ember AI is on: what @ember does on the web, its switch, shown as it's `turning`
 * while it saves, and what came of turning it on, or of choosing another model, its `test`. For a model
 * that can't search, it says so, and its switch opens the setup, where another can be chosen.
 */
function WebSearch({
  assistant,
  turning,
  test,
  disabled,
  onTurn,
  onSetUp,
}: {
  assistant: Assistant;
  turning: boolean | null;
  test: WebTest | null;
  disabled: boolean;
  onTurn: (on: boolean) => void;
  onSetUp: () => void;
}) {
  const { webTools, model, models } = assistant;
  const name = modelName(model, models);
  const searches = searchesIn(assistant);
  const note = webTools === null ? cannotSearchWith(name) : searches ? webSearchOn(webTools, models) : WEB_SEARCH_OFF;
  return (
    <div className="border-t pt-4">
      <div className="flex items-center gap-x-[1ch]">
        <div className="min-w-0 flex-1">
          <h3 id="web-search-heading" className="text-sm font-semibold">
            Search the web
          </h3>
          <p id="web-search-description" className={NOTE}>
            {note}
          </p>
        </div>
        <Switch
          checked={turning ?? searches}
          onCheckedChange={(on) => (webTools === null ? onSetUp() : onTurn(on))}
          disabled={disabled}
          aria-labelledby="web-search-heading"
          aria-describedby="web-search-description"
        />
      </div>
      <p role="status" className={cn(NOTE, "mt-2 wrap-anywhere empty:mt-0", test !== null && test !== "searching" && ("found" in test ? "text-positive" : "refusal" in test && "text-negative"))}>
        {test === "searching" ? searchingWith(name) : test !== null && ("found" in test ? `It searched the web and said: ${test.found}` : "refusal" in test ? test.refusal : test.off)}
      </p>
    </div>
  );
}
