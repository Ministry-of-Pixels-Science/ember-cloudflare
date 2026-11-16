import { useState } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_ID_REFUSED,
  API_TOKEN_REFUSED,
  ASSISTANT_MODELS,
  SUGGESTED_MODEL,
  TOP_LEVELS,
  modelName,
  offeredModelOf,
  type AssistantSettings,
  type AssistantSetup as Setup,
  type OfferedModel,
  type OfferedModels,
} from "@ember/protocol/assistant";
import { ApiError } from "@/lib/api";
import { AssistantSetup, searchTurnedOff } from "./assistant-setup";

/** A Cloudflare account's ID and an API token of its, with AI Gateway's Run permission, as an administrator makes one. */
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
/** Another account's ID. */
const OTHER_ACCOUNT_ID = "fedcba9876543210fedcba9876543210";
const API_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-Ab";
const GREETING = "Hello, team! I'm Ember, here whenever you mention @ember.";

/** Workers AI's models, as the Worker lists them for the account: one Cloudflare plans to stop running. */
const GEMMA: OfferedModel = { id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B", format: "workers", price: { input: 0.1, output: 0.3 }, thinkingLevels: [] };
const GLM: OfferedModel = { id: "@cf/zai-org/glm-5.2", name: "GLM 5.2", format: "workers", price: { input: 1.4, output: 4.4 }, thinkingLevels: ["off", "high"], until: "2026-11-20" };

/** The models Ember offers, as the Worker lists them: those it shipped with, then Workers AI's. */
const OFFERED: OfferedModels = { models: [...ASSISTANT_MODELS, GEMMA, GLM], suggested: SUGGESTED_MODEL, workersAi: null };

/** Ember AI as the server saves it from `setup`: on the model sent, of those Ember offers, the only one people can pick. */
const savedOf = ({ accountId, model }: Pick<Setup, "accountId" | "model">): AssistantSettings => ({
  accountId,
  model,
  models: [{ id: model, name: modelName(model, OFFERED.models), format: offeredModelOf(model, OFFERED.models)!.format }],
  most: TOP_LEVELS,
  // Searching the web waits for Search the web to be turned on.
  webTools: [],
  instructions: "",
  promptTemplate: null,
  avatarUrl: "/users/ember.abc/avatar?v=20261101120000",
  avatar: false,
});

/** Where the dialog asks for the models Ember offers. */
const LISTING = "POST /api/account/assistant/offered";

/**
 * Answers setting Ember AI up as the server would, with the model sent, or as `saved` says, and listing
 * the models Ember offers as `offered` says, or with OFFERED.
 */
function serve(saved?: (setup: Setup) => Response | Promise<Response>, offered: () => Response | Promise<Response> = () => Response.json(OFFERED)) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method} ${String(input)}`;
    if (request === LISTING) return offered();
    if (request !== "PUT /api/account/assistant") throw new Error(`Unexpected request for ${request}`);
    const setup = JSON.parse(String(init?.body)) as Setup;
    return saved ? saved(setup) : Response.json({ assistant: savedOf(setup), greeting: GREETING });
  });
}

/** What the dialog asked of the server, in order, with what it sent. */
const requests = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([input, init]) => [`${init?.method} ${String(input)}`, init?.body === undefined ? undefined : JSON.parse(String(init.body))]);

/** The same, but for listing the models Ember offers. */
const asked = () => requests().filter(([request]) => request !== LISTING);

/** What the dialog listed the models Ember offers with, each time it did. */
const listedWith = () => requests().flatMap(([request, body]) => (request === LISTING ? [body] : []));

/** A response the test lets through when it says, with `answer` letting it through. */
function held(response: () => Response) {
  let answer = () => {};
  const answered = new Promise<Response>((resolve) => (answer = () => resolve(response())));
  return { answered: () => answered, answer: () => act(async () => answer()) };
}

/**
 * Set up Ember AI, open on a workspace whose Ember AI is `assistant`, deployed to the Cloudflare account
 * `deployedAccountId` names, if the deploy said, as the settings page opens it: on Ember AI as it's saved,
 * once it is.
 */
function showSetup(assistant: AssistantSettings | null = null, deployedAccountId: string | null = null) {
  const callbacks = { onSaved: vi.fn(), onClose: vi.fn(), onFailed: vi.fn() };
  function SettingsPage() {
    const [shown, setShown] = useState(assistant);
    const onSaved = (saved: AssistantSettings) => {
      setShown(saved);
      callbacks.onSaved(saved);
    };
    return <AssistantSetup assistant={shown} deployedAccountId={deployedAccountId} {...callbacks} onSaved={onSaved} />;
  }
  render(<SettingsPage />);
  return { ...callbacks, user: userEvent.setup() };
}

const dialog = (name: string) => screen.findByRole("dialog", { name });
const button = (name: string) => screen.getByRole("button", { name });
const accountIdField = () => screen.getByRole("textbox", { name: "Account ID" });
const apiTokenField = () => screen.getByRole("textbox", { name: "API token" });
const modelMenu = () => screen.getByRole("combobox", { name: "Model" });
const steps = () => within(screen.getByRole("list", { name: "Steps to make an API token" })).getAllByRole("listitem");
const apiTokensLink = () => screen.getByRole("link", { name: "Open Account API tokens in the Cloudflare dashboard" });
const aiGatewayLink = () => screen.getByRole("link", { name: "Open AI Gateway in the Cloudflare dashboard" });

/** The model menu, once the Worker has listed the models Ember offers in it. */
async function listedMenu() {
  const menu = await screen.findByRole("combobox", { name: "Model" });
  await waitFor(() => expect(menu).toBeEnabled());
  return menu;
}

/** Types the account's ID and API token, as given, and goes on to the model, once the models are listed, if it does. */
async function giveKeys(user: ReturnType<typeof userEvent.setup>, { accountId = ACCOUNT_ID, apiToken = API_TOKEN } = {}) {
  await user.type(accountIdField(), accountId);
  if (apiToken) await user.type(apiTokenField(), apiToken);
  await user.click(button("Continue"));
  if (screen.queryByRole("heading", { name: "Choose a model" })) await listedMenu();
}

afterEach(() => vi.restoreAllMocks());

describe("Set up Ember AI", () => {
  it("starts with the account and an API token of its with AI Gateway Run and Read and Workers AI Read, linking to the account's API tokens in the Cloudflare dashboard", async () => {
    const fetch = serve();
    const { user, onClose } = showSetup();
    const setup = await dialog("Set up Ember AI");
    expect(within(setup).getByRole("heading", { name: "Set up Ember AI" })).toHaveFocus();
    expect(setup).toHaveAccessibleDescription(
      "Ember AI asks Claude, GPT or Grok through your Cloudflare account's AI Gateway, paid for with AI Gateway's credits, or a model Cloudflare runs on Workers AI. Ember keeps the API token encrypted.",
    );
    const [open, permission, copy, account] = steps();
    expect(open).toHaveTextContent("In the Cloudflare dashboard, open Account API tokens and choose Create Token.");
    const tokens = within(open!).getByRole("link", { name: "Open Account API tokens in the Cloudflare dashboard" });
    expect(tokens).toHaveAttribute("href", "https://dash.cloudflare.com/?to=/:account/api-tokens");
    expect(tokens).toHaveAttribute("target", "_blank");
    expect(permission).toHaveTextContent("Under Custom Token, choose Get started, name the token, and under Permissions choose Account, AI Gateway and Run. Then Add more: Account, AI Gateway and Read, and Account, Workers AI and Read.");
    expect(copy).toHaveTextContent("Choose Continue to summary, then Create Token, and copy the token here.");
    expect(account).toHaveTextContent("Copy the account's ID too: search the dashboard for Copy account ID.");
    expect(accountIdField()).toHaveValue("");
    expect(accountIdField()).not.toHaveAccessibleDescription();
    expect(button("Continue")).toBeDisabled();
    await user.type(accountIdField(), ACCOUNT_ID);
    expect(tokens).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/api-tokens`);
    expect(button("Continue")).toBeDisabled();
    await user.type(apiTokenField(), API_TOKEN);
    expect(button("Continue")).toBeEnabled();

    await user.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an account ID or an API token that can't be one on its field, without going on, until it's typed again", async () => {
    const fetch = serve();
    const { user } = showSetup();
    await giveKeys(user, { accountId: "my account" });
    expect(screen.getByRole("alert")).toHaveTextContent(ACCOUNT_ID_REFUSED);
    expect(accountIdField()).toHaveAttribute("aria-invalid", "true");
    expect(accountIdField()).toHaveAccessibleDescription(ACCOUNT_ID_REFUSED);
    await user.clear(accountIdField());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.type(accountIdField(), ACCOUNT_ID);
    await user.clear(apiTokenField());
    await user.type(apiTokenField(), "short");
    await user.click(button("Continue"));
    expect(screen.getByRole("alert")).toHaveTextContent(API_TOKEN_REFUSED);
    expect(apiTokenField()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("dialog", { name: "Set up Ember AI" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists the models Ember offers through the account typed, by their makers, then Workers AI's, with what each costs, starting at the one it suggests", async () => {
    serve();
    const { user } = showSetup();
    await giveKeys(user);
    expect(listedWith()).toEqual([{ accountId: ACCOUNT_ID, apiToken: API_TOKEN }]);
    const step = await dialog("Choose a model");
    expect(within(step).getByRole("heading", { name: "Choose a model" })).toHaveFocus();
    expect(step).toHaveAccessibleDescription(
      "Choose the model @ember answers everyone with. Ember asks it a test question through AI Gateway before keeping it. You can let people pick other models later.",
    );
    const groups = within(modelMenu()).getAllByRole("group");
    expect(groups.map((group) => [group.getAttribute("label"), within(group).getAllByRole("option").map((option) => option.textContent)])).toEqual([
      ["Anthropic", ["Claude Fable 5.2 · $8 / $40", "Claude Opus 5.5 · $4 / $20", "Claude Sonnet 5.5 · $2 / $10", "Claude Haiku 5.5 · $0.10 / $0.50"]],
      ["OpenAI", ["GPT-6 Astra · $10 / $50", "GPT-6.1 Sol · $2 / $10", "GPT-6.1 Terra · $1 / $5", "GPT-6 Luna · $0.10 / $0.50"]],
      ["xAI", ["Grok 4.7 · $2 / $6"]],
      ["Workers AI", ["Gemma 4 26B · $0.10 / $0.30", "GLM 5.2 · $1.40 / $4.40"]],
    ]);
    expect(within(modelMenu()).getAllByRole("option")).toHaveLength(OFFERED.models.length);
    expect(modelMenu()).toHaveValue(SUGGESTED_MODEL);
    expect(modelMenu()).toHaveAccessibleDescription(
      "AI Gateway's credits pay for this model, $0.10 for each million tokens it reads, and $0.50 for each million it writes. Top them up under Credits Available in AI Gateway. Open AI Gateway in the Cloudflare dashboard",
    );
    expect(aiGatewayLink()).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/ai/ai-gateway`);

    await user.selectOptions(modelMenu(), "anthropic/claude-sonnet-5.5");
    expect(modelMenu()).toHaveAccessibleDescription(
      "AI Gateway's credits pay for this model, $2 for each million tokens it reads, and $10 for each million it writes. Top them up under Credits Available in AI Gateway. Open AI Gateway in the Cloudflare dashboard",
    );

    // Workers AI's, which Cloudflare runs, for free up to the day's allowance.
    await user.selectOptions(modelMenu(), GLM.id);
    expect(modelMenu()).toHaveAccessibleDescription(
      "Cloudflare runs this model on Workers AI, free for the account's first 10,000 Neurons each day, and beyond that on Workers Paid, at $1.40 for each million tokens it reads, and $4.40 for each million it writes. AI Gateway's credits pay for its searches of the web, and for the model too once the default gateway's Workers AI Billing is Unified billing. Cloudflare plans to stop running it on November 20, 2026. Open Workers AI in the Cloudflare dashboard",
    );
    expect(screen.getByRole("link", { name: "Open Workers AI in the Cloudflare dashboard" })).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/ai/workers-ai`);
  });

  it("says when the maker of one of the others plans to stop running it", async () => {
    const luna = { ...offeredModelOf("openai/gpt-6-luna", ASSISTANT_MODELS)!, until: "2027-01-15" };
    serve(undefined, () => Response.json({ ...OFFERED, models: OFFERED.models.map((model) => (model.id === luna.id ? luna : model)) } satisfies OfferedModels));
    const { user } = showSetup();
    await giveKeys(user);
    await user.selectOptions(modelMenu(), luna.id);
    expect(modelMenu()).toHaveAccessibleDescription(
      "AI Gateway's credits pay for this model, $0.10 for each million tokens it reads, and $0.50 for each million it writes. Top them up under Credits Available in AI Gateway. OpenAI plans to stop running it on January 15, 2027. Open AI Gateway in the Cloudflare dashboard",
    );
  });

  it("lists the models while the model's step opens, which it can't save until they're listed", async () => {
    const list = held(() => Response.json(OFFERED));
    serve(undefined, list.answered);
    const { user } = showSetup();
    await user.type(accountIdField(), ACCOUNT_ID);
    await user.type(apiTokenField(), API_TOKEN);
    await user.click(button("Continue"));
    expect(await screen.findByRole("combobox", { name: "Model" })).toBeDisabled();
    expect(modelMenu()).toHaveAccessibleDescription("Listing the models Ember offers…");
    expect(button("Save")).toBeDisabled();

    await list.answer();
    expect(await listedMenu()).toHaveValue(SUGGESTED_MODEL);
    expect(button("Save")).toBeEnabled();
  });

  it("says why Workers AI's models aren't listed, listing the others", async () => {
    const workersAi = "Workers AI's models aren't listed, as Cloudflare didn't let the API token list them. Add the Workers AI Read permission to it in the Cloudflare dashboard.";
    serve(undefined, () => Response.json({ ...OFFERED, models: [...ASSISTANT_MODELS], workersAi } satisfies OfferedModels));
    const { user } = showSetup();
    await giveKeys(user);
    expect(screen.getByText(workersAi)).toBeInTheDocument();
    expect(within(modelMenu()).getAllByRole("group").map((group) => group.getAttribute("label"))).toEqual(["Anthropic", "OpenAI", "xAI"]);
  });

  it("lists the models Ember shipped with when the Worker couldn't list them, saying Workers AI's aren't", async () => {
    serve(undefined, () => Response.json({ error: "Something went wrong" }, { status: 500 }));
    const { user, onFailed } = showSetup();
    await giveKeys(user);
    expect(screen.getByText("Workers AI's models aren't listed, as Ember couldn't list them. Try again in a moment.")).toBeInTheDocument();
    expect(within(modelMenu()).getAllByRole("option")).toHaveLength(ASSISTANT_MODELS.length);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("opens at Ember AI's model when it's one of Workers AI's, once the Worker lists it", async () => {
    serve();
    const { user } = showSetup({ ...savedOf({ accountId: ACCOUNT_ID, model: SUGGESTED_MODEL }), model: GEMMA.id, models: [GEMMA] });
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await listedMenu()).toHaveValue(GEMMA.id);
    // Without an API token typed, the Worker lists them with Ember AI's.
    expect(listedWith()).toEqual([{ accountId: ACCOUNT_ID }]);
  });

  it("asks the model chosen a test question, saving it with the account and API token, and shows what it said", async () => {
    serve();
    const { user, onSaved, onClose } = showSetup();
    await giveKeys(user, { accountId: ` ${ACCOUNT_ID.toUpperCase()} `, apiToken: ` ${API_TOKEN} ` });
    await user.selectOptions(await listedMenu(), "anthropic/claude-sonnet-5.5");
    await user.click(button("Save"));
    const done = await dialog("Ember AI is set up");
    expect(within(done).getByRole("heading", { name: "Ember AI is set up" })).toHaveFocus();
    expect(done).toHaveAccessibleDescription("@ember is in every room open to everyone, running on Claude Sonnet 5.5. Asked to say hello, it said:");
    expect(done).toHaveTextContent(GREETING);
    const setup = { accountId: ACCOUNT_ID, model: "anthropic/claude-sonnet-5.5" };
    expect(asked()).toEqual([["PUT /api/account/assistant", { ...setup, apiToken: API_TOKEN }]]);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(savedOf(setup));
    await user.click(button("Done"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ["account ID", "accountId", "Cloudflare has no account with that ID that the token can reach.", accountIdField],
    ["API token", "apiToken", "AI Gateway's endpoint for Anthropic didn't take the API token. Add the AI Gateway Run permission to the token in the Cloudflare dashboard, then try again.", apiTokenField],
  ])("sends an %s AI Gateway refuses back to its field, keeping what was typed", async (_, field, refusal, fieldOf) => {
    serve(() => Response.json({ error: refusal, field }, { status: 422 }));
    const { user, onSaved, onFailed } = showSetup();
    await giveKeys(user);
    await listedMenu();
    await user.click(button("Save"));
    expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
    expect(screen.getByRole("dialog", { name: "Set up Ember AI" })).toBeInTheDocument();
    expect(fieldOf()).toHaveAttribute("aria-invalid", "true");
    expect(accountIdField()).toHaveValue(ACCOUNT_ID);
    expect(apiTokenField()).toHaveValue(API_TOKEN);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();

    await user.click(button("Continue"));
    expect(await listedMenu()).toHaveValue(SUGGESTED_MODEL);
  });

  it("says on the model menu why AI Gateway didn't take the model, until another's chosen", async () => {
    serve(() => Response.json({ error: "AI Gateway didn't take that model.", field: "model" }, { status: 422 }));
    const { user, onFailed } = showSetup();
    await giveKeys(user);
    await listedMenu();
    await user.click(button("Save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("AI Gateway didn't take that model.");
    expect(modelMenu()).toHaveAttribute("aria-invalid", "true");
    expect(modelMenu()).toHaveAccessibleDescription("AI Gateway didn't take that model.");
    await user.selectOptions(modelMenu(), "openai/gpt-6-luna");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it.each([
    ["no credits", 422, "This model is paid for with AI Gateway's credits, and there aren't enough."],
    ["AI Gateway turning requests away", 429, "AI Gateway is turning requests away for now, or a spend limit was reached. Try again later."],
    ["AI Gateway not answering", 502, "AI Gateway didn't answer. Try again in a moment."],
  ])("says under the model when it couldn't be saved for %s, saving it when asked again", async (_, status, problem) => {
    let answers = 0;
    serve((setup) => (answers++ === 0 ? Response.json({ error: problem }, { status }) : Response.json({ assistant: savedOf(setup), greeting: GREETING })));
    const { user, onFailed } = showSetup();
    await giveKeys(user);
    await listedMenu();
    await user.click(button("Save"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(problem));
    expect(onFailed).not.toHaveBeenCalled();
    await user.click(button("Save"));
    expect(await dialog("Ember AI is set up")).toBeInTheDocument();
    expect(asked().map(([request]) => request)).toEqual(["PUT /api/account/assistant", "PUT /api/account/assistant"]);
  });

  it("can't be closed while the model's asked, saying so", async () => {
    const answer = held(() => Response.json({ assistant: savedOf({ accountId: ACCOUNT_ID, model: "anthropic/claude-sonnet-5.5" }), greeting: GREETING }));
    serve(answer.answered);
    const { user, onClose } = showSetup();
    await giveKeys(user);
    await user.selectOptions(await listedMenu(), "anthropic/claude-sonnet-5.5");
    await user.click(button("Save"));
    expect(button("Asking…")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Asking Claude Sonnet 5.5 a test question…");
    expect(modelMenu()).toBeDisabled();
    expect(button("Back")).toBeDisabled();
    expect(button("Close")).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    await answer.answer();
    expect(await dialog("Ember AI is set up")).toBeInTheDocument();
  });

  it("leaves a failure it can't say itself to the page's alerts", async () => {
    serve(() => Response.json({ error: "Only administrators can set up Ember AI" }, { status: 403 }));
    const { user, onFailed } = showSetup();
    await giveKeys(user);
    await listedMenu();
    await user.click(button("Save"));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can set up Ember AI")));
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(button("Save")).toBeEnabled();
  });

  it("opens on Ember AI as it is to change it, keeping the API token Ember has when none is given", async () => {
    serve();
    const { user } = showSetup(savedOf({ accountId: ACCOUNT_ID, model: "openai/gpt-6.1-sol" }));
    await dialog("Set up Ember AI");
    expect(steps()).toHaveLength(3);
    expect(accountIdField()).toHaveValue(ACCOUNT_ID);
    expect(apiTokensLink()).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/api-tokens`);
    expect(apiTokenField()).toHaveValue("");
    expect(apiTokenField()).toHaveAccessibleDescription(
      "Ember has an API token already. Leave this blank to keep it, or paste another to ask with it instead. Either needs the AI Gateway Run and Read and the Workers AI Read permissions.",
    );
    expect(button("Continue")).toBeEnabled();
    await user.click(button("Continue"));
    expect(await listedMenu()).toHaveValue("openai/gpt-6.1-sol");
    await user.selectOptions(modelMenu(), "openai/gpt-6.1-terra");
    await user.click(button("Save"));
    await dialog("Ember AI is set up");
    expect(asked()).toEqual([["PUT /api/account/assistant", { accountId: ACCOUNT_ID, model: "openai/gpt-6.1-terra" }]]);
  });

  it("fills in the account Ember is deployed to, saying so, and opens its pages in the Cloudflare dashboard", async () => {
    serve();
    const { user, onSaved } = showSetup(null, ACCOUNT_ID);
    await dialog("Set up Ember AI");
    expect(steps().map((step) => step.textContent)).toEqual([
      "In the Cloudflare dashboard, open Account API tokens and choose Create Token. Open Account API tokens in the Cloudflare dashboard",
      "Under Custom Token, choose Get started, name the token, and under Permissions choose Account, AI Gateway and Run. Then Add more: Account, AI Gateway and Read, and Account, Workers AI and Read.",
      "Choose Continue to summary, then Create Token, and copy the token here.",
    ]);
    expect(accountIdField()).toHaveValue(ACCOUNT_ID);
    expect(accountIdField()).toHaveAccessibleDescription("Ember is deployed to this account. To ask through another, paste that account's ID.");
    expect(apiTokensLink()).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/api-tokens`);
    expect(button("Continue")).toBeDisabled();
    await user.type(apiTokenField(), API_TOKEN);
    await user.click(button("Continue"));
    await user.selectOptions(await listedMenu(), "anthropic/claude-sonnet-5.5");
    expect(aiGatewayLink()).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/ai/ai-gateway`);
    await user.click(button("Save"));
    await dialog("Ember AI is set up");
    const setup = { accountId: ACCOUNT_ID, model: "anthropic/claude-sonnet-5.5" };
    expect(asked()).toEqual([["PUT /api/account/assistant", { ...setup, apiToken: API_TOKEN }]]);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(savedOf(setup));
  });

  it("takes another account in place of the one Ember is deployed to, the dashboard's pages following what's typed", async () => {
    serve();
    const { user } = showSetup(null, ACCOUNT_ID);
    await dialog("Set up Ember AI");
    await user.clear(accountIdField());
    expect(accountIdField()).not.toHaveAccessibleDescription();
    expect(apiTokensLink()).toHaveAttribute("href", "https://dash.cloudflare.com/?to=/:account/api-tokens");
    await user.type(accountIdField(), OTHER_ACCOUNT_ID.toUpperCase());
    expect(accountIdField()).not.toHaveAccessibleDescription();
    expect(apiTokensLink()).toHaveAttribute("href", `https://dash.cloudflare.com/${OTHER_ACCOUNT_ID}/api-tokens`);
    await user.type(apiTokenField(), API_TOKEN);
    await user.click(button("Continue"));
    await listedMenu();
    await user.click(button("Save"));
    await dialog("Ember AI is set up");
    expect(asked()).toEqual([["PUT /api/account/assistant", { accountId: OTHER_ACCOUNT_ID, apiToken: API_TOKEN, model: SUGGESTED_MODEL }]]);
  });

  it("says why AI Gateway refused the account Ember is deployed to in place of saying it's that account", async () => {
    const refusal = "Cloudflare has no account with that ID that the token can reach.";
    serve(() => Response.json({ error: refusal, field: "accountId" }, { status: 422 }));
    const { user } = showSetup(null, ACCOUNT_ID);
    await user.type(await screen.findByRole("textbox", { name: "API token" }), API_TOKEN);
    await user.click(button("Continue"));
    await listedMenu();
    await user.click(button("Save"));
    expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
    expect(accountIdField()).toHaveAccessibleDescription(refusal);
    expect(screen.queryByText("Ember is deployed to this account.", { exact: false })).not.toBeInTheDocument();
  });

  it("opens on Ember AI's own account when it's on, saying only of the deployed account that Ember is there", async () => {
    serve();
    showSetup(savedOf({ accountId: OTHER_ACCOUNT_ID, model: "openai/gpt-6.1-sol" }), ACCOUNT_ID);
    await dialog("Set up Ember AI");
    expect(steps()).toHaveLength(3);
    expect(accountIdField()).toHaveValue(OTHER_ACCOUNT_ID);
    expect(accountIdField()).not.toHaveAccessibleDescription();
    expect(apiTokensLink()).toHaveAttribute("href", `https://dash.cloudflare.com/${OTHER_ACCOUNT_ID}/api-tokens`);
  });

  it("opens at the model Ember suggests when Ember AI answers with one Ember no longer offers, which it doesn't list", async () => {
    serve();
    const kept = { id: "deepseek/deepseek-v4", name: "DeepSeek V4", format: "chat" } as const;
    const { user } = showSetup({ ...savedOf({ accountId: ACCOUNT_ID, model: SUGGESTED_MODEL }), model: kept.id, models: [kept], webTools: null });
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await listedMenu()).toHaveValue(SUGGESTED_MODEL);
    expect(within(modelMenu()).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(OFFERED.models.map(({ id }) => id));
  });

  it("says Search the web is off once a change of model turned it off, as the new model hasn't searched", async () => {
    const searching: AssistantSettings = { ...savedOf({ accountId: ACCOUNT_ID, model: "anthropic/claude-sonnet-5.5" }), webTools: ["search", "read"] };
    serve((setup) => Response.json({ assistant: setup.model === searching.model ? searching : savedOf(setup), greeting: GREETING }));
    for (const [model, said] of [
      ["anthropic/claude-sonnet-5.5", null],
      ["anthropic/claude-opus-5.5", searchTurnedOff([])],
    ] as const) {
      const { user, onClose } = showSetup(searching);
      await user.click(await screen.findByRole("button", { name: "Continue" }));
      await user.selectOptions(await listedMenu(), model);
      await user.click(button("Save"));
      const done = await dialog("Ember AI is set up");
      if (said === null) expect(done).not.toHaveTextContent("Search the web");
      else expect(done).toHaveTextContent(said);
      await user.click(button("Done"));
      expect(onClose).toHaveBeenCalledOnce();
      cleanup();
    }
  });

  it("says Search the web is off for the new account once moving the same model to another turned it off", async () => {
    const searching: AssistantSettings = { ...savedOf({ accountId: ACCOUNT_ID, model: "anthropic/claude-sonnet-5.5" }), webTools: ["search", "read"] };
    // The server turns it off, as the other account's AI Gateway may not take the same tools.
    serve();
    const { user } = showSetup(searching);
    await dialog("Set up Ember AI");
    await user.clear(accountIdField());
    await user.type(accountIdField(), OTHER_ACCOUNT_ID);
    await user.type(apiTokenField(), API_TOKEN);
    await user.click(button("Continue"));
    await listedMenu();
    await user.click(button("Save"));
    expect(await dialog("Ember AI is set up")).toHaveTextContent("Search the web is off for the new account. Turn it on again to try it.");
    const setup = { accountId: OTHER_ACCOUNT_ID, model: "anthropic/claude-sonnet-5.5", apiToken: API_TOKEN };
    expect(asked().at(-1)).toEqual(["PUT /api/account/assistant", setup]);
  });
});
