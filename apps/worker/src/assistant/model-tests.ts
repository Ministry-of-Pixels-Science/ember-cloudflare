import { ASSISTANT_NAME } from "@ember/protocol";
import { providerFormatOf, THINKING_LEVELS, type AssistantModel } from "@ember/protocol/assistant";
import type { Env } from "../env";
import type { MovedModel } from "../workspace-store";
import { ask, thinkingLevelsOf, type Gateway, type Question } from "./gateway";

// The test question Ember asks a model before it keeps it, and the move of the models it kept before it
// asked Claude and GPT through their providers' own endpoints (`formatOf`) onto those.

/** What Set up Ember AI asks the model before Ember keeps it, so that it's known to answer. */
export const TEST_QUESTION: Question = {
  instructions: `You are ${ASSISTANT_NAME}, the AI assistant in a team's chat, where people ask you things by mentioning @ember. An administrator has just set you up.`,
  turns: [{ role: "user", text: "Say hello to the team in one short sentence." }],
  // Room for a model that thinks before it answers, however short the answer.
  maxTokens: 2_000,
};

/** How long Set up Ember AI waits for each answer to its test question. */
export const TEST_TIMEOUT_MS = 30_000;

/** The levels of thinking the model `gateway` names takes in its format, as it answers the test question, @ember's unless it's another `question`, again at each (`thinkingLevelsOf`). */
export const testedLevelsOf = (env: Env, gateway: Gateway, question = TEST_QUESTION) => thinkingLevelsOf(env, gateway, question, TEST_TIMEOUT_MS);

/**
 * How many requests one move of the models Ember AI kept before it asked Claude and GPT through
 * their providers' endpoints makes there at most, of the 50 subrequests an invocation on the Free plan
 * can make: the test question for each model it asks, and for each that answers, the same again at each
 * level of thinking.
 */
const REQUESTS_PER_MOVE = 40;

/** The requests a model that answers there takes: its test question, then the same at each level of thinking. */
const REQUESTS_PER_MOVED = 1 + THINKING_LEVELS.length;

/** How many models one move moves at most: 8, as each that answers takes five requests. */
export const MODELS_PER_MOVE = Math.floor(REQUESTS_PER_MOVE / REQUESTS_PER_MOVED);

/** The models a move found answer through their providers' endpoints, and whether it's done: whether there are no more to ask there. */
export interface ProviderMoves {
  moves: MovedModel[];
  done: boolean;
}

/**
 * The models `saved` lists, the ones people can pick and the agents', that Ember AI asks through
 * Cloudflare's REST API and that answer the test question through AI Gateway's endpoint for their
 * provider, as `gateway`'s account and API token ask it, with the levels of thinking each takes there,
 * which needn't be those it took where it was. They're asked one after another, so that none waits out
 * its time behind the others' requests, while the move has room for one more that answers
 * (`REQUESTS_PER_MOVE`), and the rest by the next move, unless none of these answered, as the next would
 * ask the same again. One that doesn't answer there, as by a name its provider doesn't know it by, takes
 * one request and stays where it is, and an API token without AI Gateway Run, which every endpoint
 * refuses alike, leaves them all where they are.
 */
export async function providerMovesOf(env: Env, gateway: Pick<Gateway, "accountId" | "apiToken">, saved: readonly Pick<AssistantModel, "id" | "format">[]): Promise<ProviderMoves> {
  const moves: MovedModel[] = [];
  let requests = 0;
  for (const { id, from, format } of movableIn(saved)) {
    if (requests + REQUESTS_PER_MOVED > REQUESTS_PER_MOVE) return { moves, done: moves.length === 0 };
    const moving = { accountId: gateway.accountId, apiToken: gateway.apiToken, model: id, format };
    const answered = await ask(env, moving, TEST_QUESTION, TEST_TIMEOUT_MS);
    requests++;
    if (!("refusal" in answered)) {
      moves.push({ id, from, format, thinkingLevels: await testedLevelsOf(env, moving) });
      requests += THINKING_LEVELS.length;
      continue;
    }
    console.log(`Asking ${id} through Cloudflare's REST API still, as AI Gateway's endpoint for its provider didn't answer it: ${answered.refusal}`);
    if (answered.reason === "token") return { moves, done: true };
  }
  return { moves, done: true };
}

/** Each model of `saved` in a format of Cloudflare's REST API whose provider's endpoint Ember asks first now, with that endpoint's format, once each. */
function movableIn(saved: readonly Pick<AssistantModel, "id" | "format">[]): Omit<MovedModel, "thinkingLevels">[] {
  const movable = new Map<string, Omit<MovedModel, "thinkingLevels">>();
  for (const { id, format: from } of saved) {
    const format = providerFormatOf(id);
    if (format !== null && format !== from) movable.set(JSON.stringify([id, from]), { id, from, format });
  }
  return [...movable.values()];
}
