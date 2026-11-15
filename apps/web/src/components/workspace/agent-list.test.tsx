import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSISTANT_ID, type DirectoryUser } from "@ember/protocol";
import { AGENT_CHANGED, AGENTS_FORBIDDEN, AGENTS_FULL, EMBER_DOES, MAX_AGENTS, type Agent } from "@ember/protocol/agents";
import { ASSISTANT_OFF, TOP_LEVELS, type AssistantSettings as Assistant } from "@ember/protocol/assistant";
import { FlashProvider } from "@/components/flash";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { agentSettingsPath, NEW_AGENT_PATH } from "@/hooks/use-route";
import { ApiError } from "@/lib/api";
import { AGENTS_EXPLAINED, AGENTS_PATH, AgentList, reachOf, roomsOf, SEARCHES_THE_WEB, useAgentsOnly } from "./agent-list";

/** Ember AI on GLM-4.7 Flash, the only model people can pick, which can't search the web. */
const ON: Assistant = {
  accountId: "0123456789abcdef0123456789abcdef",
  model: "@cf/zai-org/glm-4.7-flash",
  models: [{ id: "@cf/zai-org/glm-4.7-flash", name: "GLM-4.7 Flash", format: "chat" }],
  most: TOP_LEVELS,
  webTools: null,
  instructions: "",
  promptTemplate: null,
  avatarUrl: "/users/ember.abc/avatar?v=20261101120000",
  avatar: false,
};

/** An agent called `name`, with `id`, as the AI assistant tab lists it, in every open room, off the web and for everyone to ask unless `agent` says. */
const agent = (id: string, name: string, agent: Partial<Agent> = {}): Agent => ({
  id,
  name,
  bio: null,
  role: "bot",
  status: "active",
  avatarUrl: `/users/${id}/avatar?v=1`,
  description: `${name} does one thing well.`,
  model: "anthropic/claude-sonnet-5.5",
  modelName: "Claude Sonnet 5.5",
  webTools: [],
  access: "everyone",
  rooms: null,
  ...agent,
});

const RECAP = agent("0mgk3x2a9b4c60", "Recap", { description: "Sums up threads into decisions and to-dos." });
const SCOUT = agent("0mgk3x2a9b4c61", "Scout", {
  description: "Looks up what's new on the web.",
  model: "openai/gpt-6.1-sol",
  modelName: "GPT-6.1 Sol",
  webTools: ["search"],
  rooms: [{ id: "0mgk3x2a9b4c5a", name: "research" }],
});

/** Answers listing the agents with `agents`, or as `listed` says. */
const serve = (listed: () => Response | Promise<Response> = () => Response.json({ agents: [RECAP, SCOUT] })) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (`${init?.method ?? "GET"} ${String(input)}` === "GET /api/account/agents") return listed();
    throw new Error(`Unexpected request for ${init?.method ?? "GET"} ${String(input)}`);
  });

/** The card, for Ember AI as `assistant` has it, with the people directory as `people`, which `showPeople` changes. */
function showList(assistant: Assistant = ON, people: People = new Map()) {
  const onFailed = vi.fn();
  const shown = (listed: People) => (
    <PeopleContext value={listed}>
      <AgentList assistant={assistant} onFailed={onFailed} />
    </PeopleContext>
  );
  const { rerender } = render(shown(people));
  return { onFailed, showPeople: (listed: People) => rerender(shown(listed)) };
}

const card = () => screen.getByRole("region", { name: "Agents" });
/** The rows once the agents have loaded, by the names they show. */
async function rows() {
  await waitFor(() => expect(card()).toHaveAttribute("aria-busy", "false"));
  return within(card()).getAllByRole("listitem");
}
const names = async () => (await rows()).map((row) => row.querySelector("strong")?.textContent);

afterEach(() => vi.restoreAllMocks());

describe("Agents", () => {
  it("lists @ember first, built in, then each agent by name, with what it does, its model, the web and its rooms", async () => {
    serve(() => Response.json({ agents: [SCOUT, RECAP] }));
    showList();
    expect(card()).toHaveTextContent(AGENTS_EXPLAINED);
    const [ember, recap, scout] = await rows();
    expect(await names()).toEqual(["Ember", "Recap", "Scout"]);
    expect(ember).toHaveTextContent(`EmberBuilt in${EMBER_DOES}GLM-4.7 Flash · Every room`);
    expect(recap).toHaveTextContent("RecapSums up threads into decisions and to-dos.Claude Sonnet 5.5 · Every room");
    expect(recap).not.toHaveTextContent("Built in");
    expect(scout).toHaveTextContent(`ScoutLooks up what's new on the web.GPT-6.1 Sol · ${SEARCHES_THE_WEB} · research`);
  });

  it("says which agents are kept for administrators, before their rooms, or in place of them for one only their DMs reach", async () => {
    const herald = agent("0mgk3x2a9b4c62", "Herald", { access: "admins", rooms: [{ id: "0mgk3x2a9b4c5a", name: "research" }] });
    const steward = agent("0mgk3x2a9b4c63", "Steward", { access: "admin-dms", rooms: [] });
    serve(() => Response.json({ agents: [herald, steward] }));
    showList();
    const [, heraldRow, stewardRow] = await rows();
    expect(heraldRow).toHaveTextContent("Claude Sonnet 5.5 · Admins only · research");
    expect(stewardRow).toHaveTextContent("Claude Sonnet 5.5 · Admin DMs only");
    expect(stewardRow).not.toHaveTextContent("Direct messages only");
  });

  it("links each row to its agent's page, @ember's too", async () => {
    serve();
    showList();
    const [ember, recap] = await rows();
    expect(within(ember!).getByRole("link", { name: "Edit Ember" })).toHaveAttribute("href", agentSettingsPath(ASSISTANT_ID));
    expect(within(recap!).getByRole("link", { name: "Edit Recap" })).toHaveAttribute("href", agentSettingsPath(RECAP.id));
  });

  it("says when people can pick other models for @ember, and when it searches the web", async () => {
    serve();
    showList({
      ...ON,
      model: "anthropic/claude-sonnet-5.5",
      models: [{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", format: "messages" }, ...ON.models],
      webTools: ["search", "read"],
    });
    const [ember] = await rows();
    expect(ember).toHaveTextContent(`Claude Sonnet 5.5, or the model each person picks · ${SEARCHES_THE_WEB} · Every room`);
  });

  it("shows @ember alone while there are no agents", async () => {
    serve(() => Response.json({ agents: [] }));
    showList();
    expect(await names()).toEqual(["Ember"]);
  });

  it("links New agent to New agent, until there are as many agents as there can be", async () => {
    serve();
    showList();
    await rows();
    expect(within(card()).getByRole("link", { name: "New agent" })).toHaveAttribute("href", NEW_AGENT_PATH);
  });

  it("can't make another agent once there are as many as there can be, saying why", async () => {
    const agents = Array.from({ length: MAX_AGENTS }, (_, index) => agent(`0mgk3x2a9b4d${String(index).padStart(2, "0")}`, `Agent ${index}`));
    serve(() => Response.json({ agents }));
    showList();
    expect(await rows()).toHaveLength(MAX_AGENTS + 1);
    expect(within(card()).queryByRole("link", { name: "New agent" })).toBeNull();
    expect(within(card()).getByRole("button", { name: "New agent" })).toBeDisabled();
    expect(within(card()).getByRole("button", { name: "New agent" })).toHaveAccessibleDescription(AGENTS_FULL);
  });

  it("follows a rename elsewhere, keeping the agents in order, and drops one deleted elsewhere, as the people directory hears of them", async () => {
    serve();
    const listed = (person: DirectoryUser): People => new Map([[person.id, person]]);
    const { showPeople } = showList();
    expect(await names()).toEqual(["Ember", "Recap", "Scout"]);
    showPeople(listed({ ...RECAP, name: "Tally" }));
    expect(await names()).toEqual(["Ember", "Scout", "Tally"]);
    showPeople(listed({ ...SCOUT, status: "deactivated" }));
    expect(await names()).toEqual(["Ember", "Recap"]);
  });

  it("says why the agents didn't load", async () => {
    serve(() => Response.json({ error: "Something went wrong" }, { status: 500 }));
    const { onFailed } = showList();
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(500, "Something went wrong")));
  });
});

describe("Rooms an agent is in", () => {
  const room = (name: string, index: number) => ({ id: `0mgk3x2a9b4c${index}a`, name });

  it("says every room for an agent in each open one, new ones too, and direct messages for one in none", () => {
    expect(roomsOf(null)).toBe("Every room");
    expect(roomsOf([])).toBe("Direct messages only");
  });

  it("says who can ask it first, when that's administrators alone", () => {
    expect(reachOf({ access: "everyone", rooms: null })).toEqual(["Every room"]);
    expect(reachOf({ access: "admins", rooms: [] })).toEqual(["Admins only", "Direct messages only"]);
    expect(reachOf({ access: "admin-dms", rooms: [] })).toEqual(["Admin DMs only"]);
  });

  it("names up to three rooms, counting the rest", () => {
    expect(roomsOf(["design", "research"].map(room))).toBe("design, research");
    expect(roomsOf(["design", "research", "support"].map(room))).toBe("design, research, support");
    expect(roomsOf(["design", "research", "support", "sales", "general"].map(room))).toBe("design, research, support and 2 more");
  });
});

describe("Pages for administrators while Ember AI is on", () => {
  /** What the agents' pages make of a failure: sending the page away, or else leaving it to `onFailed`. */
  function useFailed() {
    const onFailed = vi.fn();
    const { result } = renderHook(() => useAgentsOnly(onFailed), { wrapper: ({ children }: { children: ReactNode }) => <FlashProvider workspace>{children}</FlashProvider> });
    return { onFailed, failed: (error: unknown) => act(() => result.current.failed(error)) };
  }

  afterEach(() => history.replaceState(null, "", "/"));

  it("sends anyone but an administrator to workspace settings, saying what the server said", async () => {
    history.replaceState(null, "", NEW_AGENT_PATH);
    const { onFailed, failed } = useFailed();
    failed(new ApiError(403, AGENTS_FORBIDDEN));
    expect(location.pathname).toBe("/account/edit");
    expect(await screen.findByRole("alert")).toHaveTextContent(AGENTS_FORBIDDEN);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("sends an administrator to the AI assistant tab once Ember AI is found off, saying so", async () => {
    history.replaceState(null, "", NEW_AGENT_PATH);
    const { onFailed, failed } = useFailed();
    failed(new ApiError(409, ASSISTANT_OFF));
    expect(location.pathname + location.hash).toBe(AGENTS_PATH);
    expect(await screen.findByRole("alert")).toHaveTextContent(ASSISTANT_OFF);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("leaves any other failure to the workspace's alerts, staying", () => {
    history.replaceState(null, "", NEW_AGENT_PATH);
    const { onFailed, failed } = useFailed();
    failed(new ApiError(409, AGENT_CHANGED));
    failed(new ApiError(500, "Something went wrong"));
    expect(onFailed.mock.calls).toEqual([[new ApiError(409, AGENT_CHANGED)], [new ApiError(500, "Something went wrong")]]);
    expect(location.pathname).toBe(NEW_AGENT_PATH);
  });
});
