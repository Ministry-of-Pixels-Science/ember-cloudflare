import { ASSISTANT_NAME } from "@ember/protocol";
import {
  ASSISTANT_FORBIDDEN,
  ASSISTANT_OFF,
  DEFAULT_MODEL_KEPT,
  MODEL_NOT_LISTED,
  MODEL_REFUSED,
  MODELS_FULL,
  WEB_SEARCH_CHANGED,
  WEB_SEARCH_REFUSED,
  accountIdOf,
  cannotSearchWith,
  formatOf,
  modelName,
  modelOf,
  parseAssistantChanges,
  parseAssistantKeys,
  parseAssistantSetup,
  parseNewAssistantModel,
  parseWebSearchChange,
  parseYourAssistantChanges,
  searchFormatOf,
  webToolsOf,
  type AssistantChanged,
  type AssistantForgotten,
  type AssistantModel,
  type AssistantSaved,
  type ModelFormat,
  type OfferedModels,
  type ThinkingLevel,
  type WebSearchChanged,
  type WebTool,
  type YourAssistantChanged,
} from "@ember/protocol/assistant";
import { credentialsOf } from "../auth";
import { storeAvatar } from "../avatars";
import { jsonBodyOf } from "../bodies";
import type { Env } from "../env";
import { pictureFormOf } from "../files/pictures";
import { NO_STORAGE } from "../files/uploads";
import { formAnswer } from "../pages";
import { workspace, type Credentials } from "../workspace";
import type { MovedModel } from "../workspace-store";
import { ask, askOnce, type Gateway, type GatewayRefusal, type Question } from "./gateway";
import { TEST_QUESTION, TEST_TIMEOUT_MS, testedLevelsOf } from "./model-tests";
import { modelsFileOf, offeredModel, offeredModelsOf, searchingFormatOf, stillOffered } from "./offered";

// Ember AI's setup, as administrators turn it on, change it and turn it off on the AI assistant tab of
// workspace settings, the models Ember offers (assistant/offered.ts), the models people can pick, which
// administrators add there from those, what @ember may do on the web, @ember's avatar, and @ember's answers to each person, which
// they set the most of there, and each person picks the levels and model of on their profile. They
// answer JSON for the card, its dialogs and the profile.

const problem = (status: number, message: string) => Response.json({ error: message }, { status });

const NOT_SIGNED_IN = "Not signed in";
/** What's said of Ember AI is for administrators, which no cache should keep. */
const PRIVATE = { "Cache-Control": "no-store" };

/** Why Set up Ember AI needs an API token: Ember has none to keep. */
export const API_TOKEN_NEEDED = "Paste an API token. Ember doesn't have one yet.";
/** Why it needs one after the model answered: Ember AI was turned off meanwhile, or set up with another token. */
export const API_TOKEN_CHANGED = "Ember AI changed while the model answered, so Ember no longer has that API token. Paste an API token.";
/** Why Add a model didn't add one: Ember AI was set up again, with another account or API token, while the model answered. */
export const SETUP_CHANGED = "Ember AI was set up again while the model answered, so it wasn't added. Add it again.";

/** What turning on Search the web asks the model, which it has to search the web to answer, so that it's known to. */
export const WEB_TEST_QUESTION: Question = {
  instructions: `You are ${ASSISTANT_NAME}, the AI assistant in a team's chat. An administrator has just let you search the web.`,
  turns: [{ role: "user", text: "Search the web for what Cloudflare's AI Gateway is, then say it in one short sentence." }],
  // Room for a model that thinks before it searches and again once it has, however short the answer.
  maxTokens: 4_000,
};

/** How long turning on Search the web waits for the model to search and answer, which takes it longer than a hello. */
const WEB_TEST_TIMEOUT_MS = 60_000;

/** The most of what the model says to a test question that the dialog, or the card, shows. */
const MAX_SHOWN_ANSWER_LENGTH = 500;

/** Why Search the web didn't turn on for the model called `name`: AI Gateway refused its tools for the web, as `cloudflareSays`, when it says why. */
export const webToolsRefused = (name: string, cloudflareSays?: string) =>
  `AI Gateway didn't let ${name} search the web.${cloudflareSays ? ` Cloudflare says: ${cloudflareSays}` : ""}`;

/** Why Search the web didn't turn on for the model called `name`, whose tools AI Gateway took: it answered without searching. */
export const answeredUnsearched = (name: string) =>
  `${name} answered without searching the web, so Search the web is still off. Try again, or choose another model under Models or Change.`;

/**
 * The ID of the Cloudflare account the Worker is deployed to, which Set up Ember AI fills in, as the
 * deploy gave it, or null without one that can be an account's.
 */
export const deployedAccountIdOf = (env: Env): string | null => accountIdOf(env.CLOUDFLARE_ACCOUNT_ID ?? "");

/**
 * Who `request` signs in, if they're an administrator, or else what to answer them: that they aren't
 * signed in, or aren't one, as `forbidden` says, before anything they sent is read.
 */
export async function administratorOf(request: Request, env: Env, forbidden = ASSISTANT_FORBIDDEN): Promise<Credentials | Response> {
  const credentials = await credentialsOf(request, env);
  const administrator = credentials && (await workspace(env).canAdminister(credentials));
  if (!credentials || administrator === null) return problem(401, NOT_SIGNED_IN);
  return administrator ? credentials : problem(403, forbidden);
}

/**
 * `POST /api/account/assistant/offered`, `{ accountId?, apiToken? }`: the models Ember offers
 * (`offeredModelsOf`) through Ember AI's account, as Add a model and the agents' pages list them, or the
 * account given, as Set up Ember AI does, with its API token, when one is given, which Workers AI's models
 * are listed with now, or else Ember AI's, from the copy the Workspace keeps. Someone who isn't an
 * administrator hears so before anything they sent is read, and a field that can't be what it's for is
 * refused on that field.
 */
export async function listOfferedModels(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env);
  if (credentials instanceof Response) return credentials;
  const body = await jsonBodyOf(request);
  const keys = body === null || (typeof body === "object" && !("accountId" in body)) ? null : parseAssistantKeys(body);
  if (keys && "error" in keys) return formAnswer(keys, 422);
  const gateway = await workspace(env).assistantGateway();
  const accountId = keys?.accountId ?? gateway?.accountId ?? deployedAccountIdOf(env);
  const apiToken = keys?.apiToken ?? gateway?.apiToken ?? null;
  const offered =
    accountId === null
      ? await modelsFileOf(env, true).then(({ models, suggested }) => stillOffered(models, suggested, API_TOKEN_NEEDED))
      : await offeredModelsOf(env, { accountId, apiToken }, keys?.apiToken !== undefined, API_TOKEN_NEEDED);
  return Response.json(offered satisfies OfferedModels, { headers: PRIVATE });
}

/**
 * `PUT /api/account/assistant`, `{ accountId, apiToken, model }`: turns Ember AI on, or changes it, with a
 * model Ember offers (`offeredModel`), once that has answered a test question through AI Gateway with the
 * account and API token given, or the API token Ember has, when none is, and again at each level of
 * thinking, to find those it takes, unless Cloudflare's model search lists them (`greetingFrom`),
 * answering Ember AI as it is then and what the model said. The model
 * answers anyone who hasn't picked another, in place of the one that did among the models people can
 * pick. Someone who isn't an administrator hears so before anything they sent is read. A field that
 * can't be what it's for, or that AI Gateway refuses, is refused on that field, as is the API token
 * Ember had once it no longer has it, so that turning Ember AI off while the model answers stays done.
 */
export async function saveAssistant(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env);
  if (credentials instanceof Response) return credentials;
  const ember = workspace(env);
  const setup = parseAssistantSetup(await jsonBodyOf(request));
  if ("error" in setup) return formAnswer(setup, 422);
  const kept = setup.apiToken === undefined ? (await ember.assistantGateway())?.apiToken : undefined;
  const apiToken = setup.apiToken ?? kept;
  if (!apiToken) return formAnswer({ error: API_TOKEN_NEEDED, field: "apiToken" }, 422);
  const offered = await offeredModel(env, setup.model, { accountId: setup.accountId, apiToken });
  if (!offered) return formAnswer({ error: MODEL_REFUSED, field: "model" }, 422);
  const answered = await greetingFrom(env, { accountId: setup.accountId, apiToken, model: setup.model }, TEST_QUESTION, offered.format, offered.thinkingLevels);
  if ("refusal" in answered) return refused(answered);
  const { format, thinkingLevels } = answered;
  const saved = await ember.changeAssistant(credentials, { accountId: setup.accountId, apiToken, model: setup.model, name: offered.name, format, thinkingLevels }, kept !== undefined);
  if (!saved) return problem(401, NOT_SIGNED_IN);
  if (saved === "changed") return formAnswer({ error: API_TOKEN_CHANGED, field: "apiToken" }, 422);
  if (saved === "forbidden" || !saved.assistant) return problem(403, ASSISTANT_FORBIDDEN);
  return Response.json({ assistant: saved.assistant, greeting: answered.greeting } satisfies AssistantSaved, { headers: PRIVATE });
}

/**
 * `POST /api/account/assistant/models`, `{ model }`: adds a model Ember offers (`offeredModel`) to those
 * people can pick, as Add a model on the Ember AI card does, once it has answered a test question through
 * Ember AI's account, and again at each level of thinking, unless Cloudflare's model search lists them
 * (`greetingFrom`), answering Ember AI as it is then and what the model said. Someone who isn't an administrator hears so before anything they sent is read. A
 * model Ember doesn't offer, or that AI Gateway refuses, is refused on its field, and one that answered
 * through Ember AI as it was before it was set up again isn't added.
 */
export async function addAssistantModel(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env);
  if (credentials instanceof Response) return credentials;
  const ember = workspace(env);
  const added = parseNewAssistantModel(await jsonBodyOf(request));
  if ("error" in added) return formAnswer(added, 422);
  const gateway = await ember.assistantGateway();
  if (!gateway) return problem(409, ASSISTANT_OFF);
  const through = { accountId: gateway.accountId, apiToken: gateway.apiToken };
  const offered = await offeredModel(env, added.model, through);
  if (!offered) return formAnswer({ error: MODEL_REFUSED, field: "model" }, 422);
  const answered = await greetingFrom(env, { ...through, model: added.model }, TEST_QUESTION, offered.format, offered.thinkingLevels);
  if ("refusal" in answered) return refused(answered);
  const model = { id: added.model, name: offered.name, format: answered.format, thinkingLevels: answered.thinkingLevels };
  const saved = await ember.addAssistantModel(credentials, model, gateway);
  if (!saved) return problem(401, NOT_SIGNED_IN);
  if (saved === "forbidden") return problem(403, ASSISTANT_FORBIDDEN);
  if (saved === "off") return problem(409, ASSISTANT_OFF);
  if (saved === "changed") return problem(409, SETUP_CHANGED);
  if (saved === "full") return formAnswer({ error: MODELS_FULL, field: "model" }, 422);
  return Response.json({ assistant: saved.assistant, greeting: answered.greeting } satisfies AssistantSaved, { headers: PRIVATE });
}

/**
 * `DELETE /api/account/assistant/models`, `{ model }`: takes the model out of those people can pick, as its
 * Remove on the Ember AI card does, answering Ember AI as it is then, but for the model @ember answers
 * everyone with. Someone who isn't an administrator hears so before anything they sent is read.
 */
export async function removeAssistantModel(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env);
  if (credentials instanceof Response) return credentials;
  const body = await jsonBodyOf(request);
  const model = typeof body === "object" && body !== null && "model" in body && typeof body.model === "string" ? modelOf(body.model) : null;
  if (model === null) return problem(422, MODEL_NOT_LISTED);
  const removed = await workspace(env).removeAssistantModel(credentials, model);
  if (!removed) return problem(401, NOT_SIGNED_IN);
  if (removed === "forbidden") return problem(403, ASSISTANT_FORBIDDEN);
  if (removed === "off") return problem(409, ASSISTANT_OFF);
  if (removed === "everyone's") return problem(409, DEFAULT_MODEL_KEPT);
  return Response.json(removed satisfies AssistantChanged, { headers: PRIVATE });
}

/** `DELETE /api/account/assistant`: turns Ember AI off, as turning off its card's switch does, forgetting its API token. */
export async function forgetAssistant(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const forgotten = credentials && (await workspace(env).changeAssistant(credentials, null));
  if (!forgotten) return problem(401, NOT_SIGNED_IN);
  if (forgotten === "forbidden") return problem(403, ASSISTANT_FORBIDDEN);
  return Response.json({ assistant: null } satisfies AssistantForgotten, { headers: PRIVATE });
}

/**
 * `PATCH /api/account/assistant`, `{ thinking?, length?, model? }`: changes the most each of @ember's dials
 * goes to for anyone's questions, as the Ember AI card's dials do while it's on, and which of the models
 * people can pick it answers everyone else with, as the card's Models do, answering Ember AI as it is
 * then. Someone who isn't an administrator hears so before anything they sent is read.
 */
export async function changeAssistantSettings(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env);
  if (credentials instanceof Response) return credentials;
  const changes = parseAssistantChanges(await jsonBodyOf(request));
  if ("error" in changes) return problem(422, changes.error);
  const changed = await workspace(env).changeAssistantSettings(credentials, changes);
  if (!changed) return problem(401, NOT_SIGNED_IN);
  if (changed === "forbidden") return problem(403, ASSISTANT_FORBIDDEN);
  if (changed === "off") return problem(409, ASSISTANT_OFF);
  if (changed === "not listed") return problem(422, MODEL_NOT_LISTED);
  return Response.json(changed satisfies AssistantChanged, { headers: PRIVATE });
}

/**
 * `PUT /api/account/assistant/avatar`: gives @ember the avatar the form brings, as a picture chosen on the
 * Ember AI card does while it's on, in place of Ember's flame or the one it had, answering Ember AI as it
 * is then. It's the form your own avatar comes in, its `avatar` and `variant` parts the picture. Someone
 * who isn't an administrator hears so before the picture is read.
 */
export async function changeAssistantAvatar(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env);
  if (credentials instanceof Response) return credentials;
  if (!env.FILES) return problem(503, NO_STORAGE);
  const form = await pictureFormOf(request);
  if (!(form instanceof FormData)) return problem(form.status, form.error);
  const avatar = await storeAvatar(env, env.FILES, form);
  if ("error" in avatar) return problem(avatar.status, avatar.error);
  return assistantAvatarAnswer(await workspace(env).changeAssistantAvatar(credentials, avatar));
}

/** `DELETE /api/account/assistant/avatar`: takes away the avatar @ember was given, as Use Ember's flame does, answering Ember AI as it is then. */
export async function removeAssistantAvatar(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return assistantAvatarAnswer(credentials && (await workspace(env).changeAssistantAvatar(credentials, null)));
}

/** What a change to @ember's avatar answers: Ember AI as it is then, or why it was refused. */
function assistantAvatarAnswer(changed: AssistantChanged | "off" | "forbidden" | null): Response {
  if (!changed) return problem(401, NOT_SIGNED_IN);
  if (changed === "forbidden") return problem(403, ASSISTANT_FORBIDDEN);
  if (changed === "off") return problem(409, ASSISTANT_OFF);
  return Response.json(changed, { headers: PRIVATE });
}

/**
 * `PUT /api/account/assistant/web_search`, `{ on }`: turns Search the web on or off while Ember AI is on,
 * as the Ember AI card's switch does, answering Ember AI as it is then, and, once it's on, what the model
 * that answers everyone said when it searched (`searchedBy`), in the format it searches in, which it's
 * asked in from then on, as one of Workers AI's kept in Chat Completions is in theirs (`searchFormatOf`). The models people pick
 * are given their format's tools for the web then too, in the one they search in (`movedModels`).
 * Someone who isn't an administrator hears so
 * before anything they sent is read, and turning it on for a model that has no tools for the web in any
 * format, that it can't search. The model, or the Cloudflare account, being changed while it searched
 * turns nothing on, as it's the model that was asked, through that account, that searched, and nor does
 * Search the web being turned off meanwhile, or on again, as the latest change asked for is the one that
 * stays.
 */
export async function changeWebSearch(request: Request, env: Env): Promise<Response> {
  const askedAt = new Date().toISOString();
  const credentials = await administratorOf(request, env);
  if (credentials instanceof Response) return credentials;
  const ember = workspace(env);
  const change = parseWebSearchChange(await jsonBodyOf(request));
  if (!change) return problem(422, WEB_SEARCH_REFUSED);
  const gateway = change.on ? await ember.assistantGateway() : null;
  if (change.on && !gateway) return problem(409, ASSISTANT_OFF);
  const searchFormat = gateway && (await searchingFormatOf(env, gateway, gateway.model, gateway.format));
  if (gateway && !searchFormat) return problem(422, cannotSearchWith(gateway.name));
  const searched = gateway && searchFormat ? await searchedBy(env, { ...gateway, format: searchFormat }) : { webTools: [], found: null };
  if ("refusal" in searched) return problem(searched.status, searched.refusal);
  const moved = gateway && searchFormat ? await movedModels(env, gateway, searchFormat, await ember.assistantModels()) : [];
  const tested = gateway && { accountId: gateway.accountId, model: gateway.model, format: gateway.format };
  const changed = await ember.changeAssistantWebTools(credentials, searched.webTools, tested, askedAt, moved);
  if (!changed) return problem(401, NOT_SIGNED_IN);
  if (changed === "forbidden") return problem(403, ASSISTANT_FORBIDDEN);
  if (changed === "off") return problem(409, ASSISTANT_OFF);
  if (changed === "changed") return problem(409, WEB_SEARCH_CHANGED);
  return Response.json({ assistant: changed.assistant, found: searched.found } satisfies WebSearchChanged, { headers: PRIVATE });
}

/**
 * What the model `gateway` names, called `name`, may do on the web, as it answers the web's test question,
 * @ember's unless it's another `question`, given its format's tools for it, of what the models file lets
 * it do (`webToolsOf`), and what it said, or why it can't: AI Gateway refused the tools, even without the
 * one for reading pages, which it may not have for every model, the model answered without searching,
 * which shows in the pages it cites, as `unsearched` says, or Cloudflare's Web Search API refused the
 * searches Ember ran for it, or it didn't answer at all.
 */
export async function searchedBy(
  env: Env,
  gateway: Gateway & { name: string },
  question = WEB_TEST_QUESTION,
  unsearched = answeredUnsearched,
): Promise<{ webTools: WebTool[]; found: string } | GatewayRefusal> {
  const signal = AbortSignal.timeout(WEB_TEST_TIMEOUT_MS);
  let webTools = webToolsOf(gateway.model, gateway.format, (await modelsFileOf(env)).models);
  let answered = await askOnce(env, gateway, { ...question, webTools }, signal);
  if ("refusal" in answered && answered.wrongFormat && webTools.includes("read")) {
    console.error(`Asking ${gateway.model} to search again without reading pages, as AI Gateway didn't take that: ${answered.refusal}`);
    webTools = webTools.filter((tool) => tool !== "read");
    answered = await askOnce(env, gateway, { ...question, webTools }, signal);
  }
  if ("refusal" in answered) return answered.wrongFormat ? { ...answered, refusal: webToolsRefused(gateway.name, answered.cloudflareSays) } : answered;
  if (!answered.sources) return answered.searchRefused ?? { status: 422, reason: "model", refusal: unsearched(gateway.name) };
  return { webTools: [...webTools], found: shownOf(answered.text) };
}

/**
 * `PATCH /api/users/me/assistant`, `{ thinking?, length?, model? }`: changes how much @ember thinks and how
 * long it answers you, as your profile's dials do, and the model it answers you with, as its Model menu
 * does, of those administrators let people pick, or theirs with null, answering @ember's answers to you
 * as they are then.
 */
export async function changeYourAssistant(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, NOT_SIGNED_IN);
  const changes = parseYourAssistantChanges(await jsonBodyOf(request));
  if ("error" in changes) return problem(422, changes.error);
  const changed = await workspace(env).changeYourAssistant(credentials, changes);
  if (!changed) return problem(401, NOT_SIGNED_IN);
  if (changed === "not listed") return problem(422, MODEL_NOT_LISTED);
  return Response.json(changed satisfies YourAssistantChanged, { headers: PRIVATE });
}

/** What to answer when the model didn't answer its test question: why, on the field it's about, if one is. */
const refused = ({ refusal, field, status }: GatewayRefusal) => formAnswer({ error: refusal, ...(field && { field }) }, status);

/** What a model found when it was asked a test question: the format it took it in, the levels of thinking it takes in that, and what it said. */
export interface Greeting {
  format: ModelFormat;
  thinkingLevels: ThinkingLevel[];
  greeting: string;
}

/**
 * What the model `gateway` names says to the test question, @ember's unless it's another `question`,
 * asked in `format`, the one Ember asks it in (`formatOf`) unless it's to be asked in another, and the
 * levels of thinking it takes in that format, as Cloudflare's model search lists them, `listed`, for one
 * of Workers AI's, which turns a level it doesn't take into another rather than refusing it, or else as
 * asking it at each finds (`testedLevelsOf`), or why it didn't answer.
 */
export async function greetingFrom(
  env: Env,
  gateway: Omit<Gateway, "format" | "thinkingLevels">,
  question = TEST_QUESTION,
  format = formatOf(gateway.model),
  listed?: ThinkingLevel[],
): Promise<Greeting | GatewayRefusal> {
  const answered = await ask(env, { ...gateway, format, ...(listed && { thinkingLevels: listed }) }, question, TEST_TIMEOUT_MS);
  if ("refusal" in answered) return answered;
  const thinkingLevels = listed ?? (await testedLevelsOf(env, { ...gateway, format }, question));
  return { format, thinkingLevels, greeting: shownOf(answered.text) };
}

/**
 * The models that search the web in another format than they're saved in, now that Search the web is on,
 * as Workers AI's kept in Chat Completions do in theirs, and a Grok saved in xAI's own Responses does in
 * Chat Completions (`searchFormatOf`), with the levels of thinking each takes there, which needn't be
 * those it took where it was: the one that answers everyone, `gateway`'s, which searched
 * in `searchFormat`, and each other of those people pick, `models`, that answers its test question
 * there, as Add a model would have found, but not one that doesn't, as through an API token without AI
 * Gateway Run, which stays where it is.
 */
async function movedModels(env: Env, gateway: Gateway, searchFormat: ModelFormat, models: readonly Pick<AssistantModel, "id" | "format">[]): Promise<MovedModel[]> {
  const through = { accountId: gateway.accountId, apiToken: gateway.apiToken };
  const everyone = async (): Promise<MovedModel> => ({
    id: gateway.model,
    from: gateway.format,
    format: searchFormat,
    thinkingLevels: await testedLevelsOf(env, { ...through, model: gateway.model, format: searchFormat }),
  });
  const picked = async ({ id, format: from }: Pick<AssistantModel, "id" | "format">): Promise<MovedModel | null> => {
    const format = searchFormatOf(id, from);
    if (id === gateway.model || format === null || format === from) return null;
    const answered = await greetingFrom(env, { ...through, model: id }, TEST_QUESTION, format);
    return "refusal" in answered ? null : { id, from, format, thinkingLevels: answered.thinkingLevels };
  };
  const moved = await Promise.all([...(searchFormat === gateway.format ? [] : [everyone()]), ...models.map(picked)]);
  return moved.filter((move) => move !== null);
}

/** `text` cut to what the dialog, or the card, shows. */
const shownOf = (text: string) => (text.length > MAX_SHOWN_ANSWER_LENGTH ? `${text.slice(0, MAX_SHOWN_ANSWER_LENGTH - 1).trimEnd()}…` : text);
