import type { Me, NewWorkspace, ProfileAnswer, WorkspaceSettings } from "@ember/protocol";
import {
  ASSISTANT_FORBIDDEN,
  ASSISTANT_OFF,
  DEFAULT_LEVELS,
  LEVELS_REFUSED,
  THINKING_LEVELS,
  TOP_LEVELS,
  type AnswerLevels,
  type AssistantChanged,
  type AssistantModel,
  type YourAssistant,
  type YourAssistantChanged,
} from "@ember/protocol/assistant";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, cookieOf, freshDeploy, shown, WITH_THE_FLAME, workspaceSql, type Session } from "./support";

// How much @ember thinks and how long it answers: the most of each, which administrators set on the
// Ember AI card for anyone's questions, and each person's own levels, which they pick on their profile.

const SETUP = { accountId: "0123456789abcdef0123456789abcdef", apiToken: "an-api-token-with-ai-gateway-run_0123456", model: "anthropic/claude-haiku-5.5" };

/** The models people can pick once Ember AI is on: its own, alone, which took its test question at each level of thinking. */
const MODELS: AssistantModel[] = [{ id: SETUP.model, name: "Claude Haiku 5.5", format: "anthropic", thinkingLevels: [...THINKING_LEVELS] }];

/** @ember's answers to someone at `levels`, under `most`, as their profile shows them, who leaves their model to administrators. */
const yours = (levels: AnswerLevels, most: AnswerLevels): YourAssistant => ({ levels, most, model: null, defaultModel: SETUP.model, models: MODELS });

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Grace joins with the join link, as a member, signed in. */
async function joinAsGrace(): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify({ name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" }) });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** Turns Ember AI on as `administrator`, its model saying hello to the test question. */
async function turnOn(administrator: Session): Promise<void> {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ type: "message", role: "assistant", content: [{ type: "text", text: "Hello, team!" }], stop_reason: "end_turn" }),
  );
  const response = await api("/api/account/assistant", { method: "PUT", headers: as(administrator), body: JSON.stringify(SETUP) });
  expect(response.status, await response.clone().text()).toBe(200);
  fetch.mockRestore();
}

/** Turns Ember AI off as `administrator`. */
async function turnOff(administrator: Session): Promise<void> {
  expect((await api("/api/account/assistant", { method: "DELETE", headers: as(administrator) })).status).toBe(200);
}

/** Changes the most @ember thinks and writes for anyone, as `session`, as the Ember AI card's dials do. */
const limit = (session: Session | null, changes: unknown) => api("/api/account/assistant", { method: "PATCH", headers: as(session), body: JSON.stringify(changes) });

/** Changes how much @ember thinks and how long it answers `session`, as their profile's dials do. */
const pick = (session: Session | null, changes: unknown) => api("/api/users/me/assistant", { method: "PATCH", headers: as(session), body: JSON.stringify(changes) });

/** The most as the AI assistant tab shows it to `administrator`, or undefined while Ember AI is off. */
const mostShown = async (administrator: Session) => ((await (await api("/api/account", { headers: as(administrator) })).json()) as WorkspaceSettings).assistant?.most;

/** `person`'s levels as their profile shows them, or null while Ember AI is off. */
const levelsShown = async (person: Session) => ((await (await api("/api/users/me/profile", { headers: as(person) })).json()) as ProfileAnswer).profile.assistant;

/** What a refusal says. */
const refusalOf = async (response: Response) => [response.status, ((await response.json()) as { error: string }).error];

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("The most @ember thinks and writes", () => {
  it("is the top of each dial until an administrator sets less, which saves at once and shows with Ember AI", async () => {
    const ada = await setUp();
    await turnOn(ada);
    expect(await mostShown(ada)).toEqual(TOP_LEVELS);

    const response = await limit(ada, { thinking: "medium" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const most: AnswerLevels = { thinking: "medium", length: "long" };
    expect(await response.json()).toEqual({ assistant: { accountId: SETUP.accountId, model: SETUP.model, models: MODELS, most, webTools: [], instructions: "", promptTemplate: null, ...WITH_THE_FLAME } } satisfies AssistantChanged);
    expect(await mostShown(ada)).toEqual(most);
    expect(await (await limit(ada, { length: "short" })).json()).toMatchObject({ assistant: { most: { thinking: "medium", length: "short" } } });
    const [{ settings }] = (await workspaceSql("SELECT settings FROM accounts")) as [{ settings: string }];
    expect((JSON.parse(settings) as Record<string, unknown>).assistant_limits).toEqual({ thinking: "medium", length: "short" });
  });

  it("stays as it was set when Ember AI is turned off and on again", async () => {
    const ada = await setUp();
    await turnOn(ada);
    await limit(ada, { thinking: "off", length: "short" });
    await turnOff(ada);
    await turnOn(ada);
    expect(await mostShown(ada)).toEqual({ thinking: "off", length: "short" });
  });

  it("is the administrators' to change, to a level a dial has, while Ember AI is on", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    expect((await limit(null, { thinking: "low" })).status).toBe(401);
    expect(await refusalOf(await limit(ada, { thinking: "low" }))).toEqual([409, ASSISTANT_OFF]);
    await turnOn(ada);
    // A member hears so before anything they sent is read.
    expect(await refusalOf(await limit(grace, { thinking: "most" }))).toEqual([403, ASSISTANT_FORBIDDEN]);
    for (const changes of [{}, { thinking: "most" }, { length: 3 }, { thinking: "low", length: "longest" }, null]) {
      expect(await refusalOf(await limit(ada, changes))).toEqual([422, LEVELS_REFUSED]);
    }
    expect(await mostShown(ada)).toEqual(TOP_LEVELS);
  });
});

describe("Your levels", () => {
  it("start at Low thinking and a Medium answer, as your profile shows them with the most allowed, while Ember AI is on", async () => {
    const ada = await setUp();
    expect(await levelsShown(ada)).toBeNull();
    await turnOn(ada);
    expect(await levelsShown(ada)).toEqual(yours(DEFAULT_LEVELS, TOP_LEVELS));
  });

  it("are yours to pick, a dial at a time, kept while the most is lower, and shown no higher than it", async () => {
    const ada = await setUp();
    const grace = await joinAsGrace();
    await turnOn(ada);

    const response = await pick(grace, { length: "long" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ assistant: yours({ thinking: "low", length: "long" }, TOP_LEVELS) } satisfies YourAssistantChanged);
    expect(await (await pick(grace, { thinking: "high" })).json()).toEqual({ assistant: yours(TOP_LEVELS, TOP_LEVELS) });
    // Each person's are their own.
    expect(await levelsShown(ada)).toEqual(yours(DEFAULT_LEVELS, TOP_LEVELS));

    const lower: AnswerLevels = { thinking: "medium", length: "short" };
    await limit(ada, lower);
    expect(await levelsShown(grace)).toEqual(yours(lower, lower));
    await limit(ada, TOP_LEVELS);
    expect(await levelsShown(grace)).toEqual(yours(TOP_LEVELS, TOP_LEVELS));
  });

  it("take a level a dial has, from someone signed in, and none show while Ember AI is off", async () => {
    const ada = await setUp();
    expect((await pick(null, { thinking: "low" })).status).toBe(401);
    for (const changes of [{}, { thinking: "most" }, { length: "longest" }, "low"]) {
      expect(await refusalOf(await pick(ada, changes))).toEqual([422, LEVELS_REFUSED]);
    }
    expect(await (await pick(ada, { thinking: "off" })).json()).toEqual({ assistant: null } satisfies YourAssistantChanged);
    await turnOn(ada);
    expect(await levelsShown(ada)).toEqual(yours({ thinking: "off", length: "medium" }, TOP_LEVELS));
  });
});
