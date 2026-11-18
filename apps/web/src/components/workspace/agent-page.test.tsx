import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, SidebarRoom } from "@ember/protocol";
import { ACCESS_REFUSED, AGENT_CHANGED, agentCannotSearchWith, AGENTS_FORBIDDEN, NAME_TAKEN, type AgentSettings, type AgentTrialAnswer, type NewAgent } from "@ember/protocol/agents";
import {
  ASSISTANT_MODELS,
  ASSISTANT_OFF,
  offeredModelOf,
  SUGGESTED_MODEL,
  THINKING_LEVELS,
  TOP_LEVELS,
  type AssistantSettings as Assistant,
  type OfferedModel,
  type OfferedModels,
} from "@ember/protocol/assistant";
import { AGENT_TEMPLATE, INSTRUCTIONS_PLACE_NEEDED, PLACEHOLDERS, placeholderOf, unknownPlaceholder } from "@ember/protocol/prompts";
import defaultBotAvatar from "@/components/default-bot-avatar.svg";
import { FlashProvider } from "@/components/flash";
import { Sheet } from "@/components/ui/sheet";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { agentSettingsPath, leave, navigate, NEW_AGENT_PATH } from "@/hooks/use-route";
import { ApiError } from "@/lib/api";
import { dateLabel } from "@/lib/messages";
import { AGENTS_PATH } from "./agent-list";
import {
  accessExplained,
  AGENT_CHANGES,
  AGENT_EXPLAINED,
  AgentSettingsPage,
  cannotSearch,
  CONFIRM_DELETE_AGENT,
  INSTRUCTIONS_EXPLAINED,
  NewAgentPage,
  roomsExplained,
  tryExplained,
} from "./agent-page";
import { toolsExplained } from "./agent-tools";
import { searchingWith } from "./ember-settings";
import { cautionFor, PLACEHOLDER_MEANINGS } from "./prompt-preview";

vi.mock("@/lib/previews", () => ({ avatarVariantOf: vi.fn(async () => new Blob(["variant"], { type: "image/webp" })) }));

const ada: Me = { id: "0mgk3x2a9b4c5d", name: "Ada Lovelace", administrator: true };

const SONNET = "anthropic/claude-sonnet-5.5";
const GPT = "openai/gpt-6.1-sol";
const GROK = "xai/grok-4.7";
/** One of Workers AI's, which Ember no longer offers, kept by a copy set up before, in the format Cloudflare's REST API took it in. */
const GLM = { id: "@cf/zai-org/glm-4.7-flash", name: "GLM-4.7 Flash", format: "chat" } as const;
/** One of Workers AI's that the model search lists, as one that takes tools. */
const GEMMA: OfferedModel = { id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B", format: "workers", price: { input: 0.1, output: 0.3 }, thinkingLevels: [] };

/** The models Ember offers through Ember AI's account, as the Worker lists them: those it shipped with, then Workers AI's. */
const OFFERED: OfferedModels = { models: [...ASSISTANT_MODELS, GEMMA], suggested: SUGGESTED_MODEL, workersAi: null };

/** Ember AI on Claude Sonnet 5.5. */
const ON: Assistant = {
  accountId: "0123456789abcdef0123456789abcdef",
  model: SONNET,
  models: [offeredModelOf(SONNET, ASSISTANT_MODELS)!],
  most: TOP_LEVELS,
  webTools: [],
  instructions: "",
  promptTemplate: null,
  avatarUrl: "/users/ember.abc/avatar?v=20261101120000",
  avatar: false,
};

const room = (id: string, name: string, kind: "open" | "closed" = "open"): SidebarRoom => ({ id, name, kind, icon: null, unread: false, involvement: "mentions" });
const DESIGN = room("0mgk3x2a9b4c5a", "design");
const RESEARCH = room("0mgk3x2a9b4c5b", "research");
/** Ada's sidebar: open rooms, one closed, which an agent can't be kept to. */
const ROOMS: SidebarRoom[] = [RESEARCH, DESIGN, room("0mgk3x2a9b4c5c", "secret plans", "closed")];

/** Recap, kept to the design room, as its page reads it. */
const RECAP: AgentSettings = {
  id: "0mgk3x2a9b4c60",
  name: "Recap",
  bio: null,
  role: "bot",
  status: "active",
  avatarUrl: "/users/0mgk3x2a9b4c60/avatar?v=20261109120000",
  description: "Sums up threads into decisions and to-dos.",
  model: SONNET,
  modelName: "Claude Sonnet 5.5",
  webTools: [],
  access: "everyone",
  rooms: [{ id: DESIGN.id, name: "design" }],
  instructions: "Sum up the conversation so far as decisions and to-dos.",
  promptTemplate: null,
  format: "anthropic",
  levels: { thinking: "low", length: "medium" },
  thinkingLevels: [...THINKING_LEVELS],
  avatar: false,
  changedBy: { id: ada.id, name: "Ada Lovelace" },
  changedAt: "2026-11-09T12:00:00.000Z",
};

/** Recap kept to administrators' direct messages with it, and so in no room. */
const HIDDEN: AgentSettings = { ...RECAP, access: "admin-dms", rooms: [] };

/** Recap on a model Ember no longer offers, kept since before, which can't search the web. */
const KEPT: AgentSettings = { ...RECAP, model: GLM.id, modelName: GLM.name, format: GLM.format };

/** What Ember adds around an agent's instructions, as an administrator modified it. */
const SCRIBE = "You are {{name}}, the scribe of {{community}}.\n\n{{instructions}}\n\nAnswer {{asker}} in at most {{words}} words.";

/** What Try it's model says, as a message of its keeps it, and how long it took. */
const TRIED: AgentTrialAnswer = { body: "<p><strong>Two</strong> decisions so far.</p>", cards: [], ms: 2345 };

type Answer = () => Response | Promise<Response>;
const answer = (agent: AgentSettings, status = 200) => Response.json({ agent }, { status });
const refused = (status: number, error: string, field?: string) => Response.json({ error, field }, { status });

/** Where the pages ask for the models Ember offers. */
const LISTING = "POST /api/account/assistant/offered";

/**
 * Answers the pages' requests as the server does for an administrator, or as `read`, `offered`, `loaded`,
 * `sent`, `tried` and `deleted` say: reading Ember AI and the models Ember offers, loading the agent,
 * making or changing it or taking away its avatar, Try it, and deleting it.
 */
function serve({
  read = () => Response.json({ assistant: ON, cloudflareAccountId: null }),
  offered = () => Response.json(OFFERED),
  loaded = () => answer(RECAP),
  sent,
  tried = () => Response.json(TRIED),
  deleted = () => new Response(null, { status: 204 }),
}: { read?: Answer; offered?: Answer; loaded?: Answer; sent?: Answer; tried?: Answer; deleted?: Answer } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    switch (request) {
      case "GET /api/account":
        return read();
      case LISTING:
        return offered();
      case `GET /api/account/agents/${RECAP.id}`:
        return loaded();
      // The Tools card's, which has tests of its own.
      case `GET /api/account/agents/${RECAP.id}/tools`:
        return Response.json({ apps: [] });
      case "POST /api/account/agents/trials":
      case `POST /api/account/agents/${RECAP.id}/trials`:
        return tried();
      case `DELETE /api/account/agents/${RECAP.id}`:
        return deleted();
      case "POST /api/account/agents":
        return sent ? sent() : answer(RECAP, 201);
      case `PATCH /api/account/agents/${RECAP.id}`:
      case `DELETE /api/account/agents/${RECAP.id}/avatar`:
        return sent ? sent() : answer(RECAP);
      default:
        throw new Error(`Unexpected request for ${request}`);
    }
  });
}

/** Shows `page` at `path`, as the workspace does, in the community called Analytical Engines. */
function showAt(path: string, page: (props: { onMissing: () => void; onFailed: () => void }) => ReactNode) {
  const [onMissing, onFailed] = [vi.fn(), vi.fn()];
  history.replaceState(null, "", path);
  function Community({ children }: { children: ReactNode }) {
    return <AccountContext value={{ ...useAccount(), name: "Analytical Engines" }}>{children}</AccountContext>;
  }
  render(
    <Community>
      <FlashProvider workspace>
        <Sheet>{page({ onMissing, onFailed })}</Sheet>
      </FlashProvider>
    </Community>,
  );
  return { onMissing, onFailed, user: userEvent.setup() };
}

const showNewAgent = (me = ada, rooms: SidebarRoom[] | null = ROOMS) => showAt(NEW_AGENT_PATH, ({ onFailed }) => <NewAgentPage me={me} rooms={rooms} onFailed={onFailed} />);
const showSettings = (me = ada, rooms: SidebarRoom[] = ROOMS) =>
  showAt(agentSettingsPath(RECAP.id), ({ onMissing, onFailed }) => <AgentSettingsPage agentId={RECAP.id} me={me} rooms={rooms} onMissing={onMissing} onFailed={onFailed} />);

const nameField = () => screen.getByRole("textbox", { name: "Name" });
const descriptionField = () => screen.getByRole("textbox", { name: "What it does" });
const instructionsField = () => screen.getByRole("textbox", { name: "Instructions" });
const modelMenu = () => screen.getByRole("combobox", { name: "Model" });
const level = (dial: "Thinking" | "Answer length", name: string) => within(screen.getByRole("group", { name: dial })).getByRole("radio", { name });
const webSwitch = () => screen.getByRole("switch", { name: "Search the web" });
const rooms = () => screen.getByRole("group", { name: "Rooms" });
const everyRoom = () => screen.getByRole("radio", { name: "Every room" });
const chosenRooms = () => screen.getByRole("radio", { name: "Only the rooms I choose" });
const adminsOnly = () => screen.getByRole("switch", { name: "Admins only" });
const adminDms = () => screen.getByRole("switch", { name: "Only available in admin DMs" });
const tryIt = () => screen.getByRole("region", { name: "Try it" });
const question = () => within(tryIt()).getByRole("textbox", { name: "Question" });
const status = () => screen.getAllByRole("status").at(-1)!;
/** What Ember adds around the instructions, the box that asks for care before it's modified, and the template, once Modify is pressed. */
const around = () => screen.getByText("What Ember adds around them").closest("details")!;
const caution = () => screen.getByRole("region", { name: "Modify with caution" });
const modify = () => within(caution()).getByRole("button", { name: "Modify" });
const templateBox = () => screen.getByRole("textbox", { name: "What Ember adds around them" });
const useEmbersOwn = () => within(caution()).getByRole("button", { name: "Use Ember's own" });
const avatarField = () => screen.getByLabelText("Upload the agent's avatar");
const cost = () => screen.queryByText(/an answer at these levels costs at most about/);
const robot = () => new File(["robot"], "robot.png", { type: "image/png" });

/** The page's form, once Ember AI has loaded, and the agent, for its settings. */
const loaded = async () => {
  await waitFor(() => expect(screen.getByRole("button", { name: /^(?:Create agent|Save changes)$/ })).toBeInTheDocument());
  return nameField();
};

/** Fills in the new agent's name, what it does and its instructions. */
async function fillIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await loaded(), "Recap");
  await user.type(descriptionField(), "Sums up threads into decisions and to-dos.");
  await user.type(instructionsField(), "Sum up the conversation so far as decisions and to-dos.");
}

/** What New agent sends once it's filled in, and nothing else is changed. */
const FILLED_IN: NewAgent = {
  name: "Recap",
  description: "Sums up threads into decisions and to-dos.",
  instructions: "Sum up the conversation so far as decisions and to-dos.",
  model: SONNET,
  thinking: "low",
  length: "medium",
  webSearch: false,
  access: "everyone",
  rooms: null,
};

/** The requests the page has sent, with what they sent: JSON as it was, or a form's fields. */
const requests = () =>
  vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const body = init?.body instanceof FormData ? JSON.parse(String(init.body.get("user"))) : init?.body === undefined ? undefined : JSON.parse(String(init.body));
    return [`${init?.method ?? "GET"} ${String(input)}`, body] as [string, unknown];
  });

/** The same, but for reading what it shows, and listing the models Ember offers. */
const sent = () => requests().filter(([request]) => !request.startsWith("GET ") && request !== LISTING);

/** Whether the page went back to the AI assistant tab. */
const wentBack = () => waitFor(() => expect(location.pathname + location.hash).toBe(AGENTS_PATH));

beforeEach(() => {
  serve();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:robot");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("New agent", () => {
  it("is titled New agent, with Go Back to the AI assistant tab, starting on @ember's model at the levels people start at, off the web, in every open room, for everyone to ask", async () => {
    showNewAgent();
    expect(document.title).toBe("New agent");
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", AGENTS_PATH);
    expect(await loaded()).toHaveFocus();
    expect(screen.getByRole("heading", { level: 1, name: "New agent" })).toBeInTheDocument();
    expect(screen.getByText(AGENT_EXPLAINED)).toBeInTheDocument();
    expect(nameField()).toHaveValue("");
    expect(nameField()).toBeRequired();
    expect(nameField()).toHaveAccessibleDescription("People mention it as @its name. Nobody else here can have its name.");
    expect(descriptionField()).toBeRequired();
    expect(descriptionField()).toHaveAttribute("maxlength", "100");
    expect(instructionsField()).toBeRequired();
    expect(instructionsField()).toHaveAccessibleDescription(`${INSTRUCTIONS_EXPLAINED} 0 of 10,000 characters`);
    expect(modelMenu()).toHaveValue(SONNET);
    expect(level("Thinking", "Low")).toBeChecked();
    expect(level("Answer length", "Medium")).toBeChecked();
    expect(webSwitch()).not.toBeChecked();
    expect(webSwitch()).toBeEnabled();
    expect(everyRoom()).toBeChecked();
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(rooms()).toHaveAccessibleDescription(roomsExplained("the agent", "everyone"));
    expect(screen.getByRole("region", { name: "Admin access" })).toHaveTextContent("Keep the agent for administrators.");
    expect(adminsOnly()).not.toBeChecked();
    expect(adminsOnly()).toHaveAccessibleDescription(accessExplained("the agent").adminsOff);
    expect(adminDms()).not.toBeChecked();
    expect(adminDms()).toHaveAccessibleDescription(accessExplained("the agent").dmsOff);
    expect(screen.getByRole("img", { name: "The agent's avatar" })).toHaveAttribute("src", defaultBotAvatar);
    expect(tryIt()).toHaveTextContent(tryExplained("the agent"));
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("calls the agent by the name typed", async () => {
    const { user } = showNewAgent();
    await user.type(await loaded(), "Recap");
    expect(nameField()).toHaveAccessibleDescription("People mention it as @Recap. Nobody else here can have its name.");
    expect(screen.getByRole("img", { name: "Recap's avatar" })).toBeInTheDocument();
    expect(tryIt()).toHaveTextContent(tryExplained("Recap"));
    expect(question()).toHaveAttribute("placeholder", "Ask Recap something");
  });

  it("makes the agent as it's set up, its model asked a test question first, holding the page meanwhile, then goes back to the AI assistant tab", async () => {
    let made = () => {};
    serve({ sent: () => new Promise((resolve) => (made = () => resolve(answer(RECAP, 201)))) });
    const { user } = showNewAgent();
    await fillIn(user);
    await user.selectOptions(modelMenu(), GPT);
    await user.click(level("Thinking", "Off"));
    await user.click(level("Answer length", "Long"));
    await user.click(webSwitch());
    await user.click(chosenRooms());
    // Its open rooms, by name.
    expect(screen.getAllByRole("checkbox").map((box) => box.closest("label")?.textContent)).toEqual(["design", "research"]);
    await user.click(screen.getByRole("checkbox", { name: "design" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    expect(status()).toHaveTextContent("Asking GPT-6.1 Sol a test question…");
    expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled();
    // Nothing typed meanwhile would be sent, nor asked about as the page goes back.
    for (const field of [nameField(), descriptionField(), instructionsField()]) expect(field).toBeDisabled();
    expect(sent()).toEqual([
      [
        "POST /api/account/agents",
        {
          name: "Recap",
          description: "Sums up threads into decisions and to-dos.",
          instructions: "Sum up the conversation so far as decisions and to-dos.",
          model: GPT,
          thinking: "off",
          length: "long",
          webSearch: true,
          access: "everyone",
          rooms: [DESIGN.id],
        } satisfies NewAgent,
      ],
    ]);
    act(() => made());
    await wentBack();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the agent for administrators to ask with Admins only, in the rooms it's put in", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.click(adminsOnly());
    expect(adminsOnly()).toBeChecked();
    expect(adminsOnly()).toHaveAccessibleDescription(accessExplained("Recap").adminsOn);
    expect(adminDms()).not.toBeChecked();
    expect(rooms()).toHaveAccessibleDescription(roomsExplained("Recap", "admins"));
    expect(everyRoom()).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await wentBack();
    expect(sent()).toEqual([["POST /api/account/agents", { ...FILLED_IN, access: "admins" }]]);
  });

  it("keeps the agent to administrators' direct messages with Only available in admin DMs, which holds Admins only on and takes it out of every room", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.click(chosenRooms());
    await user.click(screen.getByRole("checkbox", { name: "design" }));
    await user.click(adminDms());

    expect(adminDms()).toBeChecked();
    expect(adminDms()).toHaveAccessibleDescription(accessExplained("Recap").dmsOn);
    expect(adminsOnly()).toBeChecked();
    expect(adminsOnly()).toBeDisabled();
    expect(adminsOnly()).toHaveAccessibleDescription(accessExplained("Recap").adminsKept);
    // It's in no room, so neither choice is its, and the rooms chosen wait.
    expect(rooms()).toBeDisabled();
    expect(rooms()).toHaveAccessibleDescription(roomsExplained("Recap", "admin-dms"));
    expect(everyRoom()).not.toBeChecked();
    expect(chosenRooms()).not.toBeChecked();
    expect(screen.queryAllByRole("checkbox")).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await wentBack();
    expect(sent()).toEqual([["POST /api/account/agents", { ...FILLED_IN, access: "admin-dms", rooms: [] }]]);
  });

  it("puts Admins only and the rooms back as they were left once Only available in admin DMs is off again", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.click(chosenRooms());
    await user.click(screen.getByRole("checkbox", { name: "design" }));
    await user.click(adminDms());
    await user.click(adminDms());
    expect(adminsOnly()).not.toBeChecked();
    expect(adminsOnly()).toBeEnabled();
    expect(rooms()).toBeEnabled();
    expect(chosenRooms()).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "design" })).toBeChecked();

    // Admins only stays on when it was on before.
    await user.click(adminsOnly());
    await user.click(adminDms());
    await user.click(adminDms());
    expect(adminsOnly()).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await wentBack();
    expect(sent()).toEqual([["POST /api/account/agents", { ...FILLED_IN, access: "admins", rooms: [DESIGN.id] }]]);
  });

  it("says why the server refused who can ask it under the switches, until one turns", async () => {
    serve({ sent: () => refused(422, ACCESS_REFUSED, "access") });
    const { user, onFailed } = showNewAgent();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    expect(await within(screen.getByRole("region", { name: "Admin access" })).findByRole("alert")).toHaveTextContent(ACCESS_REFUSED);
    expect(onFailed).not.toHaveBeenCalled();
    await user.click(adminsOnly());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends the avatar chosen, and its variant, with the new agent", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.upload(avatarField(), robot());
    expect(screen.getByRole("img", { name: "Recap's avatar" })).toHaveAttribute("src", "blob:robot");
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await wentBack();
    const form = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === "/api/account/agents")![1]!.body as FormData;
    expect(form.get("avatar")).toMatchObject({ name: "robot.png", type: "image/png" });
    expect(form.get("variant")).toMatchObject({ type: "image/webp" });
  });

  it("lets go of the picture chosen with Remove avatar", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    expect(screen.queryByRole("button", { name: "Remove avatar" })).toBeNull();
    await user.upload(avatarField(), robot());
    await user.click(screen.getByRole("button", { name: "Remove avatar" }));
    expect(screen.getByRole("img", { name: "Recap's avatar" })).toHaveAttribute("src", defaultBotAvatar);
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await wentBack();
    expect(vi.mocked(fetch).mock.calls.find(([input]) => String(input) === "/api/account/agents")![1]!.body).not.toBeInstanceOf(FormData);
  });

  it("says why the server refused the agent on the field it's about, keeping what's typed, until that field changes", async () => {
    serve({ sent: () => refused(422, NAME_TAKEN, "name") });
    const { user, onFailed } = showNewAgent();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(nameField()).toHaveAttribute("aria-invalid", "true"));
    expect(nameField()).toHaveAccessibleDescription(NAME_TAKEN);
    expect(screen.getByRole("alert")).toHaveTextContent(NAME_TAKEN);
    expect(nameField()).toHaveValue("Recap");
    expect(location.pathname).toBe(NEW_AGENT_PATH);
    expect(onFailed).not.toHaveBeenCalled();

    await user.type(nameField(), "er");
    expect(nameField()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says why the model didn't answer on its menu", async () => {
    const refusal = "The model didn't answer: AI Gateway's credits have run out.";
    serve({ sent: () => refused(502, refusal, "model") });
    const { user } = showNewAgent();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(modelMenu()).toHaveAttribute("aria-invalid", "true"));
    expect(modelMenu()).toHaveAccessibleDescription(refusal);
  });

  it("says a refusal about none of its fields under Create agent", async () => {
    serve({ sent: () => refused(409, AGENT_CHANGED) });
    const { user, onFailed } = showNewAgent();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(status()).toHaveTextContent(AGENT_CHANGED));
    expect(screen.getByRole("button", { name: "Create agent" })).toBeEnabled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("goes to the AI assistant tab once Ember AI is found off as it's sent, saying so", async () => {
    serve({ sent: () => refused(409, ASSISTANT_OFF) });
    const { user, onFailed } = showNewAgent();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ASSISTANT_OFF);
    expect(location.pathname + location.hash).toBe(AGENTS_PATH);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("offers the models Ember offers through Ember AI's account, by their makers, then Workers AI's, saying what the one chosen costs", async () => {
    showNewAgent();
    await loaded();
    expect(requests().filter(([request]) => request === LISTING)).toEqual([[LISTING, { accountId: ON.accountId }]]);
    expect(within(modelMenu()).getAllByRole("group").map((group) => group.getAttribute("label"))).toEqual(["Anthropic", "OpenAI", "xAI", "Workers AI"]);
    expect(within(modelMenu()).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(OFFERED.models.map(({ id }) => id));
    expect(modelMenu()).toHaveAccessibleDescription(
      "AI Gateway's credits pay for this model, $2 for each million tokens it reads, and $10 for each million it writes. Top them up under Credits Available in AI Gateway. Open AI Gateway in the Cloudflare dashboard",
    );
  });

  it("lets one of Workers AI's search the web with Ember's own tool, which doesn't read pages, saying what it costs", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.selectOptions(modelMenu(), GEMMA.id);
    expect(modelMenu()).toHaveAccessibleDescription(
      "Cloudflare runs this model on Workers AI, free for the account's first 10,000 Neurons each day, and beyond that on Workers Paid, at $0.10 for each million tokens it reads, and $0.30 for each million it writes. AI Gateway's credits pay for its searches of the web, and for the model too once the default gateway's Workers AI Billing is Unified billing. Open Workers AI in the Cloudflare dashboard",
    );
    await user.click(webSwitch());
    expect(webSwitch()).toHaveAccessibleDescription(
      "Recap searches the web when a question needs it, at most 5 times an answer, and lists the pages it used under its answer. AI Gateway's credits pay for each search.",
    );
    expect(cost()).toHaveTextContent("At Gemma 4 26B's prices, an answer at these levels costs at most about");
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(sent()).toEqual([["POST /api/account/agents", expect.objectContaining({ model: GEMMA.id, webSearch: true })]]));
  });

  it("offers the models Ember shipped with when the Worker couldn't list them, saying Workers AI's aren't listed", async () => {
    serve({ offered: () => Response.json({ error: "Something went wrong" }, { status: 500 }) });
    showNewAgent();
    await loaded();
    expect(within(modelMenu()).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(ASSISTANT_MODELS.map(({ id }) => id));
    expect(screen.getByText("Workers AI's models aren't listed, as Ember couldn't list them. Try again in a moment.")).toBeInTheDocument();
  });

  it("starts at the model Ember suggests when @ember answers with one Ember no longer offers, which it doesn't list", async () => {
    serve({ read: () => Response.json({ assistant: { ...ON, model: GLM.id, models: [GLM], webTools: null }, cloudflareAccountId: null }) });
    showNewAgent();
    await loaded();
    expect(modelMenu()).toHaveValue(SUGGESTED_MODEL);
    expect(within(modelMenu()).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(OFFERED.models.map(({ id }) => id));
  });

  it("lets Grok search the web without reading pages, as Ember's own tool only searches", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.selectOptions(modelMenu(), GROK);
    await user.click(webSwitch());
    expect(webSwitch()).toBeChecked();
    expect(webSwitch()).toHaveAccessibleDescription(
      "Recap searches the web when a question needs it, at most 5 times an answer, and lists the pages it used under its answer. AI Gateway's credits pay for each search.",
    );
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(sent()).toEqual([["POST /api/account/agents", expect.objectContaining({ model: GROK, webSearch: true })]]));
  });

  it("says the most an answer costs at the model's prices", async () => {
    const { user } = showNewAgent();
    await loaded();
    expect(cost()).toHaveTextContent("At Claude Sonnet 5.5's prices, an answer at these levels costs at most about 8¢, and most far less.");
    await user.click(level("Thinking", "High"));
    await user.click(level("Answer length", "Long"));
    expect(cost()).toHaveTextContent("about 40¢");
    await user.click(webSwitch());
    expect(cost()).toHaveTextContent("about 40¢, and most far less, besides what searching the web costs.");
    await user.selectOptions(modelMenu(), "openai/gpt-6-luna");
    expect(cost()).toHaveTextContent("At GPT-6 Luna's prices, an answer at these levels costs at most about 2¢, and most far less, besides what searching the web costs.");
  });

  it("shows what Ember adds around the instructions, as the agent reads it when the administrator writes to it directly", async () => {
    const { user } = showNewAgent();
    await user.type(await loaded(), "Recap");
    const preview = screen.getByText("What Ember adds around them").closest("details")!;
    expect(preview).toHaveTextContent(`You are Recap, an AI agent in the team chat "Analytical Engines". People ask you things by mentioning @Recap in a room or a thread`);
    expect(preview).toHaveTextContent(`Answer the last one, which "Ada Lovelace" wrote, in at most about 400 words.`);
    expect(preview).toHaveTextContent("You can't search the web or open links.");
  });

  it("asks before the page is left with anything typed, saying what's unsaved", async () => {
    const { user } = showNewAgent();
    await user.type(await loaded(), "Recap");
    act(() => navigate("/rooms/general"));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved Changes" });
    expect(dialog).toHaveAccessibleDescription(AGENT_CHANGES);
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(location.pathname).toBe("/rooms/general");
    expect(sent()).toEqual([]);
  });

  it("says why the server refused what the dialog's Save sent on the field it's about, staying on the page", async () => {
    serve({ sent: () => refused(422, NAME_TAKEN, "name") });
    const { user, onFailed } = showNewAgent();
    await fillIn(user);
    act(() => navigate("/rooms/general"));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved Changes" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Your changes couldn’t be saved.");
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(nameField()).toHaveAttribute("aria-invalid", "true"));
    expect(nameField()).toHaveAccessibleDescription(NAME_TAKEN);
    expect(location.pathname).toBe(NEW_AGENT_PATH);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("leaves a session that's ended by the time the dialog's Save sends it to the workspace, as its own Save does", async () => {
    serve({ sent: () => refused(401, "Sign in to continue.") });
    const { onFailed, user } = showNewAgent();
    await fillIn(user);
    act(() => navigate("/rooms/general"));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(401, "Sign in to continue.")));
  });

  it("leaves without asking while nothing's typed", async () => {
    showNewAgent();
    await loaded();
    act(() => navigate("/rooms/general"));
    expect(location.pathname).toBe("/rooms/general");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends anyone but an administrator to workspace settings at once, reading nothing, saying why", async () => {
    const { onFailed } = showNewAgent({ ...ada, administrator: false });
    expect(await screen.findByRole("alert")).toHaveTextContent(AGENTS_FORBIDDEN);
    expect(location.pathname).toBe("/account/edit");
    expect(fetch).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("sends an administrator to the AI assistant tab while Ember AI is off, saying so", async () => {
    serve({ read: () => Response.json({ assistant: null, cloudflareAccountId: null }) });
    const { onFailed } = showNewAgent();
    expect(await screen.findByRole("alert")).toHaveTextContent(ASSISTANT_OFF);
    expect(location.pathname + location.hash).toBe(AGENTS_PATH);
    expect(onFailed).not.toHaveBeenCalled();
  });
});

describe("Try it", () => {
  it("asks the agent as the page sets it up, saved or not, showing what it said as a message and how long it took", async () => {
    let answered = () => {};
    serve({ tried: () => new Promise((resolve) => (answered = () => resolve(Response.json(TRIED)))) });
    const { user } = showNewAgent();
    await fillIn(user);
    const ask = within(tryIt()).getByRole("button", { name: "Ask" });
    expect(ask).toBeDisabled();
    await user.type(question(), "What did we decide?");
    await user.click(ask);
    expect(within(tryIt()).getByRole("status")).toHaveTextContent("Asking Claude Sonnet 5.5 your question…");
    expect(ask).toBeDisabled();
    expect(sent()).toEqual([
      [
        "POST /api/account/agents/trials",
        {
          name: "Recap",
          instructions: "Sum up the conversation so far as decisions and to-dos.",
          model: SONNET,
          thinking: "low",
          length: "medium",
          webSearch: false,
          question: "What did we decide?",
        },
      ],
    ]);

    act(() => answered());
    expect(await within(tryIt()).findByText("Two", { selector: "strong" })).toBeInTheDocument();
    expect(tryIt()).toHaveTextContent("Two decisions so far.Answered in 2.3 seconds.");
    expect(within(tryIt()).getByRole("status")).toHaveTextContent("");
    expect(location.pathname).toBe(NEW_AGENT_PATH);
  });

  it("asks with Enter, rather than making the agent", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.type(question(), "What did we decide?{Enter}");
    await within(tryIt()).findByText("Answered in 2.3 seconds.");
    expect(sent().map(([request]) => request)).toEqual(["POST /api/account/agents/trials"]);
  });

  it("says why the agent didn't answer", async () => {
    const refusal = "The model didn't answer in time. Try again.";
    serve({ tried: () => refused(502, refusal) });
    const { user, onFailed } = showNewAgent();
    await fillIn(user);
    await user.type(question(), "What did we decide?{Enter}");
    await waitFor(() => expect(within(tryIt()).getByRole("status")).toHaveTextContent(refusal));
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says why the page can't be asked as it's set up, sending nothing", async () => {
    serve({ loaded: () => answer(KEPT) });
    const { user } = showSettings();
    await loaded();
    await user.click(webSwitch());
    await user.type(question(), "What's new?{Enter}");
    expect(within(tryIt()).getByRole("status")).toHaveTextContent(agentCannotSearchWith("GLM-4.7 Flash"));
    expect(sent()).toEqual([]);
  });

  it("asks with what Ember adds around the instructions as it's modified, before it's saved", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.click(modify());
    await user.clear(templateBox());
    await user.paste(SCRIBE);
    await user.type(question(), "What did we decide?{Enter}");
    await within(tryIt()).findByText("Answered in 2.3 seconds.");
    expect(sent()).toEqual([["POST /api/account/agents/trials", expect.objectContaining({ promptTemplate: SCRIBE, question: "What did we decide?" })]]);
  });

  it("asks a saved agent at its own address", async () => {
    const { user } = showSettings();
    await loaded();
    await user.type(question(), "What did we decide?{Enter}");
    await within(tryIt()).findByText("Answered in 2.3 seconds.");
    expect(sent().map(([request]) => request)).toEqual([`POST /api/account/agents/${RECAP.id}/trials`]);
  });
});

describe("What Ember adds around them", () => {
  it("keeps Ember's own until Modify is pressed, asking for care first, then shows it with what each placeholder stands for", async () => {
    const { user } = showNewAgent();
    await user.type(await loaded(), "Recap");
    await user.click(screen.getByText("What Ember adds around them"));
    expect(around()).toHaveAttribute("open");
    expect(within(around()).queryByText("Modified")).toBeNull();
    expect(within(caution()).getByRole("heading", { level: 3, name: "Modify with caution" })).toBeInTheDocument();
    expect(caution()).toHaveTextContent(cautionFor("Recap"));
    expect(modify()).toHaveAccessibleDescription(cautionFor("Recap"));
    expect(screen.queryByRole("textbox", { name: "What Ember adds around them" })).toBeNull();

    await user.click(modify());
    expect(templateBox()).toHaveValue(AGENT_TEMPLATE);
    expect(templateBox()).toHaveFocus();
    expect(templateBox()).toHaveAttribute("maxlength", "10000");
    expect(templateBox()).toHaveAccessibleDescription(`${cautionFor("Recap")} ${AGENT_TEMPLATE.length.toLocaleString("en-US")} of 10,000 characters`);
    for (const placeholder of PLACEHOLDERS) expect(caution()).toHaveTextContent(`${placeholderOf(placeholder)}${PLACEHOLDER_MEANINGS[placeholder]}`);
    expect(useEmbersOwn()).toBeDisabled();
    expect(sent()).toEqual([]);
  });

  it("makes the agent with what Ember adds around its instructions as it's modified, shown as the agent reads it", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.click(modify());
    await user.clear(templateBox());
    await user.paste(SCRIBE);
    expect(around()).toHaveTextContent(`You are Recap, the scribe of Analytical Engines. Your instructions Answer "Ada Lovelace" in at most 400 words.`);
    expect(within(around()).getByText("Modified")).toBeInTheDocument();
    expect(useEmbersOwn()).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await wentBack();
    expect(sent()).toEqual([["POST /api/account/agents", expect.objectContaining({ instructions: "Sum up the conversation so far as decisions and to-dos.", promptTemplate: SCRIBE })]]);
  });

  it("says why Ember can't take what's typed as it's typed, refusing to send the page or ask the agent until it can, opening to say so", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.click(modify());
    await user.clear(templateBox());
    await user.paste("You are {{name}}.");
    expect(templateBox()).toHaveAttribute("aria-invalid", "true");
    expect(templateBox()).toHaveAccessibleDescription(`${cautionFor("Recap")} ${INSTRUCTIONS_PLACE_NEEDED}`);
    expect(screen.getByRole("alert")).toHaveTextContent(INSTRUCTIONS_PLACE_NEEDED);
    // Nor does it show where the instructions would go.
    expect(within(around()).queryByText("Your instructions")).toBeNull();

    await user.type(question(), "What did we decide?{Enter}");
    expect(within(tryIt()).getByRole("status")).toHaveTextContent(INSTRUCTIONS_PLACE_NEEDED);
    expect(around()).not.toHaveAttribute("open");
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    expect(around()).toHaveAttribute("open");

    await user.clear(templateBox());
    await user.paste("{{instructions}} for {{comunity}}");
    expect(screen.getByRole("alert")).toHaveTextContent(unknownPlaceholder("comunity"));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    expect(sent()).toEqual([]);
  });

  it("shows what an administrator modified, which Use Ember's own puts back, saved as Ember's own, which then changes as Ember does", async () => {
    serve({ loaded: () => answer({ ...RECAP, promptTemplate: SCRIBE }) });
    const { user } = showSettings();
    await loaded();
    expect(within(around()).getByText("Modified")).toBeInTheDocument();
    expect(templateBox()).toHaveValue(SCRIBE);
    expect(around()).toHaveTextContent("You are Recap, the scribe of Analytical Engines.");

    await user.click(useEmbersOwn());
    expect(templateBox()).toHaveValue(AGENT_TEMPLATE);
    expect(useEmbersOwn()).toBeDisabled();
    expect(within(around()).queryByText("Modified")).toBeNull();
    expect(around()).toHaveTextContent(`You are Recap, an AI agent in the team chat "Analytical Engines".`);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await wentBack();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { promptTemplate: null }]]);
  });

  it("says why the server refused it in it, opening it, until it changes", async () => {
    const refusal = "Ember can't take this.";
    serve({ sent: () => refused(422, refusal, "promptTemplate") });
    const { user, onFailed } = showSettings();
    await loaded();
    await user.click(modify());
    await user.clear(templateBox());
    await user.paste(SCRIBE);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(templateBox()).toHaveAttribute("aria-invalid", "true"));
    expect(around()).toHaveAttribute("open");
    expect(screen.getByRole("alert")).toHaveTextContent(refusal);
    expect(onFailed).not.toHaveBeenCalled();
    await user.type(templateBox(), " Be brief.");
    expect(templateBox()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("An agent's settings", () => {
  it("has the Tools card, for the agent by its name, which a new agent's page doesn't have until it's saved", async () => {
    showSettings();
    await loaded();
    expect(await screen.findByRole("region", { name: "Tools" })).toHaveTextContent(toolsExplained("Recap"));
    expect(requests().map(([request]) => request)).toContain(`GET /api/account/agents/${RECAP.id}/tools`);

    cleanup();
    showNewAgent();
    await screen.findByRole("heading", { level: 1, name: "New agent" });
    expect(screen.queryByRole("region", { name: "Tools" })).toBeNull();
  });

  it("shows the agent as it's saved, titled Edit agent, with who last changed it, and Delete agent", async () => {
    showSettings();
    expect(document.title).toBe("Edit agent");
    expect(await loaded()).toHaveValue("Recap");
    expect(nameField()).not.toHaveFocus();
    expect(screen.getByRole("heading", { level: 1, name: "Edit Recap" })).toBeInTheDocument();
    expect(descriptionField()).toHaveValue(RECAP.description);
    expect(instructionsField()).toHaveValue(RECAP.instructions);
    expect(modelMenu()).toHaveValue(SONNET);
    expect(level("Thinking", "Low")).toBeChecked();
    expect(level("Answer length", "Medium")).toBeChecked();
    expect(webSwitch()).not.toBeChecked();
    expect(chosenRooms()).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "design" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "research" })).not.toBeChecked();
    expect(adminsOnly()).not.toBeChecked();
    expect(adminDms()).not.toBeChecked();
    expect(screen.getByRole("img", { name: "Recap's avatar" })).toHaveAttribute("src", RECAP.avatarUrl);
    expect(screen.queryByRole("button", { name: "Remove avatar" })).toBeNull();
    expect(screen.getByText(`Ada Lovelace last changed Recap on ${dateLabel(new Date(RECAP.changedAt))}.`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Recap" })).toHaveTextContent("Delete agent");
  });

  it("saves only what's changed, so another administrator's change stays, then goes back to the AI assistant tab", async () => {
    const { user } = showSettings();
    await loaded();
    await user.clear(descriptionField());
    await user.type(descriptionField(), "Sums up threads.");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await wentBack();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { description: "Sums up threads." }]]);
  });

  it("asks a new model a test question as it saves it", async () => {
    let saved = () => {};
    serve({ sent: () => new Promise((resolve) => (saved = () => resolve(answer({ ...RECAP, model: GPT, modelName: "GPT-6.1 Sol", format: "openai" })))) });
    const { user } = showSettings();
    await loaded();
    await user.selectOptions(modelMenu(), GPT);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(status()).toHaveTextContent("Asking GPT-6.1 Sol a test question…");
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { model: GPT }]]);
    act(() => saved());
    await wentBack();
  });

  it("offers only the levels of thinking its model took when it was saved, saying which it can't be set to, and each for another model, which saving asks", async () => {
    serve({ loaded: () => answer({ ...RECAP, model: GPT, modelName: "GPT-6.1 Sol", format: "openai", levels: { thinking: "off", length: "medium" }, thinkingLevels: ["low", "medium", "high"] }) });
    const { user } = showSettings();
    await loaded();
    const thinking = () => screen.getByRole("group", { name: "Thinking" });

    expect(level("Thinking", "Off")).toBeChecked();
    expect(level("Thinking", "Off")).toBeDisabled();
    for (const name of ["Low", "Medium", "High"]) expect(level("Thinking", name)).toBeEnabled();
    expect(thinking()).toHaveAccessibleDescription("GPT-6.1 Sol can't be set to Off, so it thinks at Low instead.");
    await user.click(level("Thinking", "High"));
    expect(thinking()).toHaveAccessibleDescription("Thinks the most first, up to about 32,000 tokens, which takes longest. GPT-6.1 Sol can't be set to Off.");

    await user.selectOptions(modelMenu(), SONNET);
    for (const name of ["Off", "Low", "Medium", "High"]) expect(level("Thinking", name)).toBeEnabled();
    expect(thinking()).toHaveAccessibleDescription("Thinks the most first, up to about 32,000 tokens, which takes longest.");
  });

  it("offers each level of thinking for a model that took none when it was saved, saying it decides itself, up to what each allows", async () => {
    serve({ loaded: () => answer({ ...RECAP, thinkingLevels: [] }) });
    const { user } = showSettings();
    await loaded();
    const thinking = () => screen.getByRole("group", { name: "Thinking" });

    for (const name of ["Off", "Low", "Medium", "High"]) expect(level("Thinking", name)).toBeEnabled();
    expect(thinking()).toHaveAccessibleDescription("Claude Sonnet 5.5 can't be told how much to think, so it decides for itself, up to about 4,000 tokens.");
    await user.click(level("Thinking", "Off"));
    expect(thinking()).toHaveAccessibleDescription("Claude Sonnet 5.5 can't be told how much to think, so it decides for itself, up to about 2,000 tokens.");
  });

  it("keeps a model Ember no longer offers on the menu, saying so, without saying what an answer costs, while it isn't changed", async () => {
    serve({ loaded: () => answer(KEPT) });
    const { user } = showSettings();
    await loaded();
    expect(modelMenu()).toHaveValue(GLM.id);
    expect(within(modelMenu()).getAllByRole("option").at(-1)).toHaveTextContent("GLM-4.7 Flash (no longer offered)");
    expect(modelMenu()).toHaveAccessibleDescription("Ember no longer offers this model. It answers as it did until you choose one that Ember offers.");
    expect(cost()).toBeNull();

    // Chosen again once another is, it's nothing to save.
    await user.selectOptions(modelMenu(), SONNET);
    expect(cost()).toHaveTextContent("At Claude Sonnet 5.5's prices");
    await user.selectOptions(modelMenu(), GLM.id);
    act(() => navigate("/rooms/general"));
    expect(location.pathname).toBe("/rooms/general");
  });

  it("keeps one of Workers AI's on the menu while the Worker couldn't list them, saying why, rather than that Ember no longer offers it", async () => {
    const unlisted = "Workers AI's models aren't listed, as Cloudflare didn't take the API token for them. Add the Workers AI Read permission to it in the Cloudflare dashboard.";
    serve({
      loaded: () => answer({ ...RECAP, model: GEMMA.id, modelName: GEMMA.name, format: GEMMA.format }),
      offered: () => Response.json({ ...OFFERED, models: [...ASSISTANT_MODELS], workersAi: unlisted } satisfies OfferedModels),
    });
    showSettings();
    await loaded();
    expect(modelMenu()).toHaveValue(GEMMA.id);
    expect(within(modelMenu()).getAllByRole("option").at(-1)?.textContent).toBe("Gemma 4 26B");
    expect(modelMenu()).toHaveAccessibleDescription(
      "Cloudflare runs this model on Workers AI, free for the account's first 10,000 Neurons each day, and beyond that on Workers Paid. AI Gateway's credits pay for its searches of the web, and for the model too once the default gateway's Workers AI Billing is Unified billing. Open Workers AI in the Cloudflare dashboard",
    );
    expect(screen.getByText(unlisted)).toBeInTheDocument();
    expect(cost()).toBeNull();
  });

  it("saves other changes to one of Workers AI's that searches the web while the Worker couldn't list them, as it searches still", async () => {
    serve({
      loaded: () => answer({ ...RECAP, model: GEMMA.id, modelName: GEMMA.name, format: GEMMA.format, webTools: ["search"] }),
      offered: () => Response.json({ ...OFFERED, models: [...ASSISTANT_MODELS], workersAi: "Workers AI's models aren't listed." } satisfies OfferedModels),
    });
    const { user } = showSettings();
    await loaded();
    expect(webSwitch()).toBeChecked();
    await user.clear(descriptionField());
    await user.type(descriptionField(), "Sums up threads.");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await wentBack();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { description: "Sums up threads." }]]);
  });

  it("says a model Ember no longer offers that can't search can't, refusing Search the web with it before sending anything, until one Ember offers is chosen", async () => {
    serve({ loaded: () => answer(KEPT) });
    const { user } = showSettings();
    await loaded();
    expect(webSwitch()).toHaveAccessibleDescription(cannotSearch("GLM-4.7 Flash"));
    // Its switch isn't greyed out, but says why it can't be on.
    await user.click(webSwitch());
    expect(webSwitch()).toBeChecked();
    expect(webSwitch()).toHaveAccessibleDescription(agentCannotSearchWith("GLM-4.7 Flash"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent(agentCannotSearchWith("GLM-4.7 Flash"));
    expect(sent()).toEqual([]);

    await user.selectOptions(modelMenu(), SONNET);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(webSwitch()).toHaveAccessibleDescription(
      "Recap searches the web when a question needs it, at most 5 times an answer, and reads the pages people link to or its searches find, at most 3, and lists the pages it used under its answer. AI Gateway's credits pay for each search.",
    );
  });

  it("has the model search the web as Search the web turns on", async () => {
    const { user } = showSettings();
    await loaded();
    await user.click(webSwitch());
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(status()).toHaveTextContent(searchingWith("Claude Sonnet 5.5"));
    await wentBack();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { webSearch: true }]]);
  });

  it("puts the agent in every open room, new ones too", async () => {
    const { user } = showSettings();
    await loaded();
    await user.click(everyRoom());
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await wentBack();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { rooms: null }]]);
  });

  it("lists a room the agent's kept to that the administrator isn't in, so they can take it out of it", async () => {
    // Such as one made while they were banned.
    const { user } = showSettings(ada, [RESEARCH]);
    await loaded();
    expect(screen.getByRole("checkbox", { name: "design" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "design" }));
    await user.click(screen.getByRole("checkbox", { name: "research" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await wentBack();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { rooms: [RESEARCH.id] }]]);
  });

  it("names a room as the sidebar does, which follows renames, once", async () => {
    showSettings(ada, [RESEARCH, room(DESIGN.id, "design studio")]);
    await loaded();
    expect(screen.getAllByRole("checkbox").map((box) => box.closest("label")?.textContent)).toEqual(["design studio", "research"]);
    expect(screen.getByRole("checkbox", { name: "design studio" })).toBeChecked();
  });

  it("keeps the rooms chosen once every open room is chosen and then not", async () => {
    const { user } = showSettings();
    await loaded();
    await user.click(everyRoom());
    await user.click(chosenRooms());
    expect(screen.getByRole("checkbox", { name: "design" })).toBeChecked();
    act(() => navigate("/rooms/general"));
    // Nothing's changed, so nothing asks.
    expect(location.pathname).toBe("/rooms/general");
  });

  it("keeps the agent for administrators, or lets everyone ask it again, saving only that", async () => {
    serve({ loaded: () => answer({ ...RECAP, access: "admins" }) });
    const { user } = showSettings();
    await loaded();
    expect(adminsOnly()).toBeChecked();
    expect(adminsOnly()).toBeEnabled();
    expect(adminDms()).not.toBeChecked();
    await user.click(adminsOnly());
    expect(adminsOnly()).toHaveAccessibleDescription(accessExplained("Recap").adminsOff);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await wentBack();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { access: "everyone" }]]);
  });

  it("takes the agent out of its rooms as it's kept to administrators' direct messages", async () => {
    const { user } = showSettings();
    await loaded();
    await user.click(adminDms());
    expect(rooms()).toBeDisabled();
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await wentBack();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { access: "admin-dms", rooms: [] }]]);
  });

  it("shows one kept to administrators' direct messages in no room, which stays for administrators only once it's let into rooms", async () => {
    serve({ loaded: () => answer(HIDDEN) });
    const { user } = showSettings();
    await loaded();
    expect(adminDms()).toBeChecked();
    expect(adminsOnly()).toBeChecked();
    expect(adminsOnly()).toBeDisabled();
    expect(rooms()).toBeDisabled();
    expect(rooms()).toHaveAccessibleDescription(roomsExplained("Recap", "admin-dms"));
    act(() => navigate("/rooms/general"));
    // Nothing's changed, so nothing asks.
    expect(location.pathname).toBe("/rooms/general");
    act(() => navigate(agentSettingsPath(RECAP.id)));

    await user.click(adminDms());
    expect(adminsOnly()).toBeChecked();
    expect(adminsOnly()).toBeEnabled();
    // In no room still, until one is chosen.
    expect(chosenRooms()).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "design" })).not.toBeChecked();
    await user.click(everyRoom());
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await wentBack();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { access: "admins", rooms: null }]]);
  });

  it("takes away the avatar an administrator uploaded with Remove avatar, once it's saved", async () => {
    serve({ loaded: () => answer({ ...RECAP, avatar: true }) });
    const { user } = showSettings();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Remove avatar" }));
    expect(screen.getByRole("img", { name: "Recap's avatar" })).toHaveAttribute("src", defaultBotAvatar);
    expect(screen.queryByRole("button", { name: "Remove avatar" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await wentBack();
    expect(sent()).toEqual([[`DELETE /api/account/agents/${RECAP.id}/avatar`, undefined]]);
  });

  it("asks before the page is left with changes", async () => {
    const { user } = showSettings();
    await user.type(await loaded(), " Bot");
    act(() => navigate("/rooms/general"));
    expect(await screen.findByRole("dialog", { name: "Unsaved Changes" })).toHaveAccessibleDescription(AGENT_CHANGES);
  });

  it("goes back to the AI assistant tab once the dialog's Save has saved the changes, when signing out then fails, as its own Save does", async () => {
    const { user } = showSettings();
    await user.type(await loaded(), " Bot");
    const signOut = vi.fn(async () => false);
    act(() => leave(signOut));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await wentBack();
    expect(signOut).toHaveBeenCalledOnce();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { name: "Recap Bot" }]]);
  });

  it("answers the 404 page for an id that isn't an agent's", async () => {
    serve({ loaded: () => refused(404, "Not found") });
    const { onMissing, onFailed } = showSettings();
    await waitFor(() => expect(onMissing).toHaveBeenCalledOnce());
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("answers the 404 page when the agent has gone by the time it's saved", async () => {
    serve({ sent: () => refused(404, "Not found") });
    const { onMissing, user } = showSettings();
    await user.type(await loaded(), " Bot");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onMissing).toHaveBeenCalledOnce());
  });

  it("answers the 404 page when the agent has gone by the time the dialog's Save sends it, as its own Save does", async () => {
    serve({ sent: () => refused(404, "Not found") });
    const { onMissing, onFailed, user } = showSettings();
    await user.type(await loaded(), " Bot");
    act(() => navigate("/rooms/general"));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(onMissing).toHaveBeenCalledOnce());
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("sends anyone but an administrator to workspace settings at once, reading nothing, saying why", async () => {
    const { onFailed } = showSettings({ ...ada, administrator: false });
    expect(await screen.findByRole("alert")).toHaveTextContent(AGENTS_FORBIDDEN);
    expect(location.pathname).toBe("/account/edit");
    expect(fetch).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });
});

describe("Delete an agent", () => {
  it("deletes the agent once it's confirmed, then goes back to the AI assistant tab", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user } = showSettings();
    await loaded();
    const remove = screen.getByRole("button", { name: "Delete Recap" });
    await user.click(remove);
    expect(confirm).toHaveBeenLastCalledWith(CONFIRM_DELETE_AGENT);
    expect(sent()).toEqual([]);
    await user.click(remove);
    await wentBack();
    expect(sent()).toEqual([[`DELETE /api/account/agents/${RECAP.id}`, undefined]]);
  });

  it("can't save or delete the agent while a deletion is on its way, and leaves why one failed to the workspace's alerts", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let fail = () => {};
    serve({ deleted: () => new Promise((resolve) => (fail = () => resolve(refused(500, "Something went wrong")))) });
    const { onFailed, user } = showSettings();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Delete Recap" }));
    for (const name of ["Save changes", "Delete Recap"]) expect(screen.getByRole("button", { name })).toBeDisabled();

    act(() => fail());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(500, "Something went wrong")));
    for (const name of ["Save changes", "Delete Recap"]) expect(screen.getByRole("button", { name })).toBeEnabled();
    expect(location.pathname).toBe(agentSettingsPath(RECAP.id));
  });
});
