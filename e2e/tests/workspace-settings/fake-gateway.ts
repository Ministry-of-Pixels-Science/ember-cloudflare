import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { AI_GATEWAY_ACCOUNT, AI_GATEWAY_PORT } from "../../projects/workspace-settings";

// AI Gateway for the Ember AI specs, at the address the second test server's AI_GATEWAY_URL names, as Ember
// asks it (apps/worker/src/assistant/gateway.ts): the default gateway's endpoints for Anthropic, OpenAI
// and xAI, where Ember asks the models it offers in their providers' own APIs, of one account,
// `AI_GATEWAY_ACCOUNT`, taking that account's API token in AI Gateway's own header alone, and Cloudflare's
// REST API, where Ember asks Workers AI's models, and a model kept from before it offered only those, in
// any of its three formats. It answers with `HELLO` in the format asked, or, given a tool for searching
// the web in Messages or Responses, with `FOUND`, citing `SOURCE`, as the model would once it had
// searched, or, given Ember's own in Chat Completions, as Workers AI's models are, with a call of it, and
// once told what it found, with `FOUND`, or, asked `CARD_QUESTION` last, with `CARDED` and a card's Slack
// payload, or, asked `RECALL_QUESTION` last in Messages with the room's search among its tools, with a
// call of it, and then with `RECALLED` and what the search found, or, asked `FILE_QUESTION` last in
// Messages with an app's `create_issue` among its tools, with a call of that, and then with `FILED` and
// what the call came to, refusing as Cloudflare does an account or a token it doesn't know. The REST API's model search
// lists two of Workers AI's models, `GEMMA` and one Ember doesn't offer, and its Web Search API finds
// `SOURCE`, saying `FOUND`. It also serves the models file the second test server's EMBER_MODELS_URL
// names, as GitHub serves the one on Ember's main branch (apps/worker/src/assistant/offered.ts): the
// repository's, with `NEWER` added. A spec can hold its answers, to see what shows while a model answers.

/** What every model says, whatever it's asked. */
export const HELLO = "Hello, team! Mention @ember whenever you'd like a hand.";

/** What a model that searched the web says, and the page it cites. */
export const FOUND = "AI Gateway is Cloudflare's proxy for requests to AI models.";
export const SOURCE = { url: "https://developers.cloudflare.com/ai-gateway/", title: "Overview · Cloudflare AI Gateway docs" };

/**
 * What a model asked `CARD_QUESTION` says, `CARDED`, then a status card's Slack payload in a ```slack block,
 * which Ember shows as a card headed `CARD_HEADER` under the answer, its button linking to `CARD_LINK`.
 */
export const CARD_QUESTION = "How's the launch going? Show me a card.";
export const CARDED = "Here's where the launch stands.";
export const CARD_HEADER = "Launch status";
export const CARD_LINK = "https://plans.example/launch";
const CARD_PAYLOAD = {
  blocks: [
    { type: "header", text: { type: "plain_text", text: CARD_HEADER } },
    { type: "section", fields: [{ type: "mrkdwn", text: "*Stage:*\nBeta" }, { type: "mrkdwn", text: "*Owner:*\nAda" }] },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open the plan" }, url: CARD_LINK, style: "primary" }] },
  ],
};

/**
 * What a model asked `RECALL_QUESTION`, and then a word, does with the room's search, a tool Ember runs: it
 * searches for the word, and says `RECALLED`, then what the search answered.
 */
export const RECALL_QUESTION = "Where's the offsite? Look for";
export const RECALLED = "The room's search says:";

/**
 * What a model asked `FILE_QUESTION`, and then a title, does with a connected app's `create_issue`, given
 * it under its app's name: it calls it with the title, and says `FILED`, then what Ember says the call
 * came to.
 */
export const FILE_QUESTION = "File an issue called";
export const FILED = "The tracker says:";

/** Where the models file is, as the second test server's EMBER_MODELS_URL names it. */
const MODELS_FILE_PATH = "/models.json";

/** A model the models file lists that the one Ember shipped with doesn't, as a model added to it after a release is. */
export const NEWER = { id: "openai/gpt-7", name: "GPT-7", price: { input: 5, output: 25 }, web: ["search"] };

/** The models file: the repository's, which Ember shipped with, and `NEWER`, which every copy offers once it reads the file. */
const shippedFile = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../models.json"), "utf8")) as { models: unknown[] };
const MODELS_FILE = { ...shippedFile, models: [...shippedFile.models, NEWER] };

/** The one of Workers AI's models that the model search lists that Ember offers, as it takes tools. */
export const GEMMA = { id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B" };

/** Workers AI's text models, as the model search lists them in OpenRouter's format: `GEMMA`, and Llama, which takes no tools, so that Ember doesn't offer it. */
const MODEL_SEARCH = {
  data: [
    {
      id: GEMMA.id,
      name: GEMMA.name,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      supported_features: ["tools"],
      pricing: { prompt: "0.0000001", completion: "0.0000003" },
    },
    {
      id: "@cf/meta/llama-3.1-8b-instruct",
      name: "Llama 3.1 8B Instruct",
      input_modalities: ["text"],
      output_modalities: ["text"],
      supported_features: [],
      pricing: { prompt: "0.000000282", completion: "0.000000827" },
    },
  ],
};

/** What the Web Search API answers every search with: `SOURCE`, as saying `FOUND`. */
const WEB_SEARCH = { success: true, result: { items: [{ ...SOURCE, description: FOUND }] } };

/** What Ember asked AI Gateway: where, with which token, as Cloudflare's API or AI Gateway's endpoints for each provider take it, and gateway, and what. */
export interface GatewayAsked {
  path: string;
  authorization: string | undefined;
  aigAuthorization: string | undefined;
  gateway: string | undefined;
  body: Record<string, unknown>;
}

/** Where the account's default gateway passes requests on to Anthropic's own Messages, OpenAI's own Responses and xAI's. */
export const ANTHROPIC_PATH = `/v1/${AI_GATEWAY_ACCOUNT.accountId}/default/anthropic/v1/messages`;
const OPENAI_PATH = `/v1/${AI_GATEWAY_ACCOUNT.accountId}/default/openai/responses`;
export const XAI_PATH = `/v1/${AI_GATEWAY_ACCOUNT.accountId}/default/grok/v1/responses`;
/** Where Cloudflare's REST API takes requests in Chat Completions, as Ember asks Grok while it isn't to search. */
export const CHAT_COMPLETIONS_PATH = `/accounts/${AI_GATEWAY_ACCOUNT.accountId}/ai/v1/chat/completions`;

/** The format of Cloudflare's REST API whose answers each provider's endpoint answers with, by its path. */
const PROVIDER_PATHS: Record<string, string> = { [ANTHROPIC_PATH]: "messages", [OPENAI_PATH]: "responses", [XAI_PATH]: "responses" };

export interface FakeGateway {
  /** What it was asked, in order. */
  asked: GatewayAsked[];
  /** Holds back its answers until the function it returns is called, or it closes. */
  hold(): () => void;
  close(): Promise<void>;
}

/** Starts AI Gateway. */
export async function startFakeGateway(): Promise<FakeGateway> {
  const asked: GatewayAsked[] = [];
  let held = Promise.resolve();
  let release = () => {};
  const server = createServer((request, response) => {
    answer(request, response, asked, held).catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(AI_GATEWAY_PORT, "127.0.0.1", resolve));
  const hold = () => {
    held = new Promise<void>((resolve) => (release = resolve));
    return release;
  };
  // Closing answers what it holds, as a spec that fails while it holds answers never lets them go.
  const close = () => {
    release();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { asked, hold, close };
}

/** Each format's path under an account, with its answer saying `text`. */
const answersSaying = (text: string): Record<string, unknown> => ({
  "chat/completions": { object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] },
  messages: { type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
  responses: { object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] },
});

const ANSWERS = answersSaying(HELLO);
const CARD_ANSWERS = answersSaying(`${CARDED}\n\n\`\`\`slack\n${JSON.stringify(CARD_PAYLOAD, null, 2)}\n\`\`\``);

/** The paths of the formats with a tool for searching the web, with the answer saying `FOUND` once the model has searched. */
const SEARCHED_ANSWERS: Record<string, unknown> = {
  messages: {
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "I'll look that up." },
      { type: "server_tool_use", id: "srvtoolu_e2e", name: "web_search", input: { query: "Cloudflare AI Gateway" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_e2e", content: [{ type: "web_search_result", ...SOURCE, encrypted_content: "e2e", page_age: null }] },
      { type: "text", text: FOUND, citations: [{ type: "web_search_result_location", ...SOURCE, encrypted_index: "e2e", cited_text: FOUND }] },
    ],
    stop_reason: "end_turn",
  },
  responses: {
    object: "response",
    output: [
      { type: "web_search_call", id: "ws_e2e", status: "completed", action: { type: "search", query: "Cloudflare AI Gateway" } },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: FOUND, annotations: [{ type: "url_citation", ...SOURCE, start_index: 0, end_index: FOUND.length }] }] },
    ],
  },
};

/** A Workers AI model's call of Ember's tool for searching the web, in Chat Completions, which Ember runs with the Web Search API. */
const SEARCH_CALL = {
  object: "chat.completion",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_e2e", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "Cloudflare AI Gateway" }) } }],
      },
      finish_reason: "tool_calls",
    },
  ],
};

/** What Grok or a Workers AI model says in Chat Completions once Ember has told it what its search found. */
const FOUND_IN_CHAT = answersSaying(FOUND)["chat/completions"];

/** Whether `body` gives Grok or a Workers AI model Ember's own tool for searching the web, a function. */
const takesSearchFunction = (body: Record<string, unknown>) =>
  Array.isArray(body.tools) && body.tools.some((tool: { type?: unknown; function?: { name?: unknown } }) => tool.type === "function" && tool.function?.name === "web_search");

/** Whether `body` ends with what Ember's tool for searching the web found, told to the model as the tool's answer. */
const toldWhatItFound = (body: Record<string, unknown>) => Array.isArray(body.messages) && (body.messages.at(-1) as { role?: unknown } | undefined)?.role === "tool";

/** Whether the last message `body` asks, in any format, is `CARD_QUESTION`, whatever came before it in the conversation. */
function asksForCard(body: Record<string, unknown>): boolean {
  const turns: unknown[] = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  return JSON.stringify(turns.at(-1) ?? null).includes(CARD_QUESTION);
}

/**
 * What Anthropic's model does when the last thing `body`'s conversation asks is `RECALL_QUESTION` and it's
 * given the room's search: calls it for the word after the question, then, asked again with what the
 * search found, answers with that. Undefined for any other request.
 */
function recalling(body: Record<string, unknown>): unknown {
  const tools: Array<{ name?: unknown }> = Array.isArray(body.tools) ? body.tools : [];
  const messages: Array<{ role?: unknown; content?: unknown }> = Array.isArray(body.messages) ? body.messages : [];
  // What people wrote is text, where a turn of the model's that calls a tool, and what the call came to, are lists.
  const written = messages.findLast(({ role, content }) => role === "user" && typeof content === "string")?.content as string | undefined;
  const question = written?.split("\n\n").at(-1) ?? "";
  const [, word] = question.slice(question.indexOf(RECALL_QUESTION)).match(/Look for (\w+)/) ?? [];
  if (!tools.some(({ name }) => name === "search_messages") || !question.includes(RECALL_QUESTION) || word === undefined) return undefined;
  const last = messages.at(-1)?.content;
  const found = (Array.isArray(last) ? last : []).find((part: { type?: unknown }) => part.type === "tool_result") as { content: string } | undefined;
  const content = found
    ? [{ type: "text", text: `${RECALLED}\n\n${found.content}` }]
    : [{ type: "text", text: "I'll look." }, { type: "tool_use", id: "toolu_e2e", name: "search_messages", input: { words: word } }];
  return { type: "message", role: "assistant", content, stop_reason: found ? "end_turn" : "tool_use", usage: { input_tokens: 100, output_tokens: 20 } };
}

/**
 * What Anthropic's model does when the last thing `body`'s conversation asks is `FILE_QUESTION` and it's
 * given an app's `create_issue`: calls it with the title after the question, then, asked again with what
 * the call came to, answers with that. Undefined for any other request.
 */
function filing(body: Record<string, unknown>): unknown {
  const tools: Array<{ name?: unknown }> = Array.isArray(body.tools) ? body.tools : [];
  const messages: Array<{ role?: unknown; content?: unknown }> = Array.isArray(body.messages) ? body.messages : [];
  const written = messages.findLast(({ role, content }) => role === "user" && typeof content === "string")?.content as string | undefined;
  const question = written?.split("\n\n").at(-1) ?? "";
  const [, title] = question.slice(question.indexOf(FILE_QUESTION)).match(/called (.+)$/) ?? [];
  const tool = tools.find(({ name }) => typeof name === "string" && name.endsWith("__create_issue"))?.name;
  if (tool === undefined || !question.includes(FILE_QUESTION) || title === undefined) return undefined;
  const last = messages.at(-1)?.content;
  const came = (Array.isArray(last) ? last : []).find((part: { type?: unknown }) => part.type === "tool_result") as { content: string } | undefined;
  const content = came ? [{ type: "text", text: `${FILED} ${came.content}` }] : [{ type: "tool_use", id: "toolu_e2e_file", name: tool, input: { title } }];
  return { type: "message", role: "assistant", content, stop_reason: came ? "end_turn" : "tool_use", usage: { input_tokens: 100, output_tokens: 20 } };
}

/** Whether `body` gives the model a tool for searching the web, as Anthropic's and OpenAI's are named. */
const searches = (body: Record<string, unknown>) =>
  Array.isArray(body.tools) && body.tools.some((tool: { type?: unknown }) => typeof tool.type === "string" && tool.type.startsWith("web_search"));

async function answer(request: IncomingMessage, response: ServerResponse, asked: GatewayAsked[], held: Promise<void>): Promise<void> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  await held;
  const path = request.url ?? "";
  const gateway = request.headers["cf-aig-gateway-id"] as string | undefined;
  const aigAuthorization = request.headers["cf-aig-authorization"] as string | undefined;
  const sent = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
  asked.push({ path, authorization: request.headers.authorization, aigAuthorization, gateway, body: sent });
  const [, account, endpoint] = path.match(/^\/accounts\/([^/]+)\/ai\/([^?]+)/) ?? [];
  const reply = (status: number, data: unknown) => void response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  if (path === MODELS_FILE_PATH && request.method === "GET") return reply(200, MODELS_FILE);
  const provider = PROVIDER_PATHS[path];
  if (provider !== undefined) {
    // It would pass a token in Authorization on to the provider, as a key of the account's own there.
    if (aigAuthorization !== `Bearer ${AI_GATEWAY_ACCOUNT.apiToken}` || request.headers.authorization !== undefined) return reply(401, { success: false, error: [{ code: 2009, message: "Unauthorized" }] });
    const recalled = provider === "messages" ? (recalling(sent) ?? filing(sent)) : undefined;
    return reply(200, recalled ?? ((searches(sent) && SEARCHED_ANSWERS[provider]) || (asksForCard(sent) ? CARD_ANSWERS : ANSWERS)[provider]));
  }
  if (account !== AI_GATEWAY_ACCOUNT.accountId) {
    return reply(400, { success: false, errors: [{ code: 7003, message: `Could not route to /client/v4${path}, perhaps your object identifier is invalid?` }] });
  }
  if (request.headers.authorization !== `Bearer ${AI_GATEWAY_ACCOUNT.apiToken}`) return reply(401, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
  if (endpoint === "models/search") return reply(200, MODEL_SEARCH);
  if (endpoint === "websearch/") return reply(200, WEB_SEARCH);
  const format = endpoint?.startsWith("v1/") ? endpoint.slice("v1/".length) : undefined;
  if (format === "chat/completions" && takesSearchFunction(sent)) return reply(200, toldWhatItFound(sent) ? FOUND_IN_CHAT : SEARCH_CALL);
  const answers = asksForCard(sent) ? CARD_ANSWERS : ANSWERS;
  const answered = format === undefined ? undefined : ((searches(sent) && SEARCHED_ANSWERS[format]) || answers[format]);
  if (answered === undefined) return reply(404, { success: false, errors: [{ code: 7000, message: "No route for that URI" }] });
  reply(200, answered);
}
