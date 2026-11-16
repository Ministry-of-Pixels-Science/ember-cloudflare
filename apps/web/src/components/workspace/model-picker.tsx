import type { ReactNode } from "react";
import {
  noLongerOffered,
  offeredModelOf,
  type AssistantField,
  type AssistantModel,
  type ModelPrice,
  type OfferedModel,
  type OfferedModels,
} from "@ember/protocol/assistant";
import { FIELD_INPUT, Field } from "@/components/field";
import { cn } from "@/lib/utils";

// The menu of the models @ember can answer with, which Set up Ember AI, Add a model and the agents' pages
// share: the ones Ember offers, as the Worker lists them, by their makers, then Workers AI's, with what
// they cost, and the one kept already, when it isn't listed. Under it, what the model chosen costs, and
// where that's paid for, and why Workers AI's models aren't listed, when they aren't.

export const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";
export const SELECT = cn("w-full min-w-0 border outline-none dark:bg-input/30", FIELD_INPUT);

/**
 * The page at `path` in the Cloudflare dashboard, in the account `accountId` names, or else in the one
 * the dashboard picks, asking someone with several accounts which.
 */
export const dashboard = (accountId: string | null, path: string) =>
  accountId === null ? `https://dash.cloudflare.com/?to=/:account/${path}` : `https://dash.cloudflare.com/${accountId}/${path}`;

/** Where AI Gateway's credits are topped up, under Credits Available, in the Cloudflare dashboard. */
const aiGatewayDashboard = (accountId: string | null) => dashboard(accountId, "ai/ai-gateway");

/** Where Workers AI's use of the account's Neurons shows, in the Cloudflare dashboard. */
const workersAiDashboard = (accountId: string | null) => dashboard(accountId, "ai/workers-ai");

/** What a model kept before Ember stopped offering it is called beside its name. */
export const NO_LONGER_OFFERED = "no longer offered";

/** Who makes the models Ember offers, by the start of their IDs, as the menu groups them, before Workers AI's, which Cloudflare runs. */
const MAKERS = [
  { prefix: "anthropic/", label: "Anthropic" },
  { prefix: "openai/", label: "OpenAI" },
  { prefix: "xai/", label: "xAI" },
] as const;

/** Who makes `model`, by the start of its ID, or null for a model Cloudflare runs on Workers AI. */
const makerOf = (model: string) => MAKERS.find(({ prefix }) => model.startsWith(prefix))?.label ?? null;

/** What the menu says while the Worker lists the models Ember offers. */
export const LISTING_MODELS = "Listing the models Ember offers…";

/** Why a field is refused, said on it, or else, with no field, under the step's. */
export interface Refusal {
  field: AssistantField | null;
  error: string;
}

/** What the menu starts at: `model`, Ember AI's or an agent's, while Ember offers it, as `offered` lists them, or else the model Ember suggests. */
export const startingModelOf = (model: string | null, offered: OfferedModels) => (model !== null && offeredModelOf(model, offered.models) ? model : offered.suggested);

/** `amount` in US dollars, with cents, or fractions of a cent, when it has them. */
export const dollars = (amount: number) =>
  amount.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 3 });

/** What `price` says, as a model's menu entry shows it: what a million tokens read costs, then a million written. */
const shortPrice = ({ input, output }: ModelPrice) => `${dollars(input)} / ${dollars(output)}`;

/** The day `day`, as YYYY-MM-DD, written out, as November 20, 2026. */
const dayOf = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A link out, which opens in a new tab. */
export function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener" className="underline">
      {children}
    </a>
  );
}

/** Why `field` is refused, under it, if it is. */
export function FieldRefusal({ id, field, refusal }: { id: string; field: AssistantField; refusal: Refusal | null }) {
  if (refusal?.field !== field) return null;
  return (
    <p id={id} role="alert" className={cn(NOTE, "mt-2 wrap-anywhere text-negative")}>
      {refusal.error}
    </p>
  );
}

interface Props {
  /** The models to list, of those Ember offers, or null while the Worker lists them. */
  models: readonly OfferedModel[] | null;
  /** The model kept already, when it isn't listed, as Ember no longer offers it, or it's one of Workers AI's, which weren't listed, which the menu lists after the others. */
  kept?: Pick<AssistantModel, "id" | "name"> | null;
  chosen: string;
  onChoose: (model: string) => void;
  refusal: Refusal | null;
  disabled: boolean;
  /** The Cloudflare account whose AI Gateway's credits, or Workers AI's Neurons, pay for the models. */
  accountId: string | null;
  /** Why Workers AI's models aren't among those listed, when they aren't. */
  workersAi?: string | null;
}

/**
 * The menu of `models`, by their makers, then Workers AI's, and of the one `kept`, if Ember no longer
 * offers it, and under it what the one chosen costs, or that they're being listed, and why Workers AI's
 * aren't, when they aren't.
 */
export function ModelPicker({ models, kept = null, chosen, onChoose, refusal, disabled, accountId, workersAi = null }: Props) {
  const modelRefused = refusal?.field === "model";
  const listed = models ?? [];
  const groups = [
    ...MAKERS.map(({ prefix, label }) => ({ label, models: listed.filter(({ id, format }) => format !== "workers" && id.startsWith(prefix)) })),
    { label: "Workers AI", models: listed.filter(({ format }) => format === "workers") },
  ];

  return (
    <>
      <Field id="assistant_model" label="Model">
        <select
          id="assistant_model"
          value={chosen}
          disabled={disabled || models === null}
          aria-invalid={modelRefused}
          aria-describedby={modelRefused ? "assistant-model-refusal" : "assistant-model-cost"}
          onChange={(event) => onChoose(event.target.value)}
          className={SELECT}
        >
          {models === null && <option value={chosen}>{LISTING_MODELS}</option>}
          {groups.map(
            (group) =>
              group.models.length > 0 && (
                <optgroup key={group.label} label={group.label}>
                  {group.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.price ? `${model.name} · ${shortPrice(model.price)}` : model.name}
                    </option>
                  ))}
                </optgroup>
              ),
          )}
          {kept && <option value={kept.id}>{noLongerOffered(kept.id, models ?? [], workersAi) ? `${kept.name} (${NO_LONGER_OFFERED})` : kept.name}</option>}
        </select>
      </Field>
      <FieldRefusal id="assistant-model-refusal" field="model" refusal={refusal} />
      <p id="assistant-model-cost" className={cn(NOTE, "mt-2")}>
        {models === null ? LISTING_MODELS : <Cost model={costOf(chosen, models, workersAi)} accountId={accountId} />}
      </p>
      {models !== null && workersAi !== null && <p className={cn(NOTE, "mt-2")}>{workersAi}</p>}
    </>
  );
}

/**
 * What `Cost` says `model` costs from: the model as `models` lists it, or else, for one of Workers AI's
 * while those couldn't be listed, `workersAi` saying why, its format alone, as its price isn't known, or
 * null, as Ember no longer offers it.
 */
function costOf(model: string, models: readonly OfferedModel[], workersAi: string | null): Pick<OfferedModel, "id" | "format" | "price" | "until"> | null {
  return offeredModelOf(model, models) ?? (noLongerOffered(model, models, workersAi) ? null : { id: model, format: "workers" });
}

/** What `model` costs, and where that's paid for, or that Ember no longer offers it, for null. */
function Cost({ model, accountId }: { model: Pick<OfferedModel, "id" | "format" | "price" | "until"> | null; accountId: string | null }) {
  if (!model) return "Ember no longer offers this model. It answers as it did until you choose one that Ember offers.";
  const { id, format, price, until } = model;
  // Cloudflare runs Workers AI's models itself, and the others' makers run theirs.
  const stops = until && ` ${makerOf(id) ?? "Cloudflare"} plans to stop running it on ${dayOf(until)}.`;
  if (format === "workers") {
    return (
      <>
        Cloudflare runs this model on Workers AI, free for the account's first 10,000 Neurons each day, and beyond that on Workers Paid
        {price ? `, at ${dollars(price.input)} for each million tokens it reads, and ${dollars(price.output)} for each million it writes` : ""}. AI Gateway's
        credits pay for its searches of the web, and for the model too once the default gateway's Workers AI Billing is Unified billing.{stops}{" "}
        <Out href={workersAiDashboard(accountId)}>Open Workers AI in the Cloudflare dashboard</Out>
      </>
    );
  }
  return (
    <>
      AI Gateway's credits pay for this model
      {price ? `, ${dollars(price.input)} for each million tokens it reads, and ${dollars(price.output)} for each million it writes` : ""}. Top them up under{" "}
      <em>Credits Available</em> in AI Gateway.{stops} <Out href={aiGatewayDashboard(accountId)}>Open AI Gateway in the Cloudflare dashboard</Out>
    </>
  );
}
