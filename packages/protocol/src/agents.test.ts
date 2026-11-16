import { describe, expect, it } from "vitest";
import {
  ACCESS_REFUSED,
  AGENT_ACCESS,
  agentsName,
  DESCRIPTION_REFUSED,
  INSTRUCTIONS_NEEDED,
  MAX_AGENT_DESCRIPTION_LENGTH,
  NAME_REFUSED,
  parseAgentChanges,
  parseAgentTrial,
  parseNewAgent,
  QUESTION_NEEDED,
  ROOMS_REFUSED,
  WEB_SEARCH_UNSAID,
  type AgentTrial,
  type NewAgent,
} from "./agents";
import { INSTRUCTIONS_TOO_LONG, LEVELS_REFUSED, MAX_INSTRUCTIONS_LENGTH, MODEL_REFUSED } from "./assistant";
import { MAX_MESSAGE_LENGTH, MAX_SHARED_ORDER, MAX_USER_NAME_LENGTH, MESSAGE_TOO_LONG, NAME_RESERVED } from "./index";
import { AGENT_TEMPLATE, EMBER_TEMPLATE, INSTRUCTIONS_PLACE_NEEDED, TEMPLATE_REFUSED, unknownPlaceholder } from "./prompts";

/** An agent as New agent sends it, with what Ember adds around its instructions as Ember writes it, in every open room. */
const RECAP: NewAgent = {
  name: "Recap",
  description: "Sums up long threads",
  instructions: "Sum up the thread you're asked in, in five bullets at most.",
  promptTemplate: null,
  model: "anthropic/claude-haiku-5.5",
  thinking: "off",
  length: "short",
  webSearch: false,
  rooms: null,
};

const ROOMS = ["0mgk3x2a9b4c5a", "0mgk3x2a9b4c5b"];

describe("New agent", () => {
  it("takes every field, and text without the spaces around it, leaving out a model's name, as Ember names the models it offers", () => {
    expect(parseNewAgent(RECAP)).toEqual(RECAP);
    expect(parseNewAgent({ ...RECAP, name: " Recap ", description: "\tSums up long threads ", instructions: "\n  Sum up.  \n", model: " anthropic/claude-haiku-5.5 ", modelName: " Claude Haiku 5.5 " })).toEqual({
      ...RECAP,
      instructions: "Sum up.",
    });
    expect(parseNewAgent({ ...RECAP, webSearch: true, rooms: ROOMS, other: true })).toEqual({ ...RECAP, webSearch: true, rooms: ROOMS });
  });

  it("keeps instructions of more than one line, as long as Ember takes", () => {
    const instructions = `Sum up the thread.\n\n- Five bullets at most\n- ${"x".repeat(MAX_INSTRUCTIONS_LENGTH - 45)}`;
    expect(instructions).toHaveLength(MAX_INSTRUCTIONS_LENGTH);
    expect(parseNewAgent({ ...RECAP, instructions })).toEqual({ ...RECAP, instructions });
  });

  it("takes a model by its ID, as whether Ember offers it is the Worker's to say, and refuses anything else on its field", () => {
    expect(parseNewAgent({ ...RECAP, model: "@cf/zai-org/glm-5.2" })).toEqual({ ...RECAP, model: "@cf/zai-org/glm-5.2" });
    for (const model of ["gpt-5.5", "openai/gpt 5.5", 5]) {
      expect(parseNewAgent({ ...RECAP, model }), String(model)).toEqual({ error: MODEL_REFUSED, field: "model" });
    }
  });

  it("takes what Ember adds around its instructions as an administrator changed it, or else Ember's own", () => {
    const { promptTemplate: _, ...unchanged } = RECAP;
    expect(parseNewAgent(unchanged)).toEqual(RECAP);
    expect(parseNewAgent({ ...RECAP, promptTemplate: AGENT_TEMPLATE })).toEqual(RECAP);
    expect(parseNewAgent({ ...RECAP, promptTemplate: " You are {{name}}.\n\n{{instructions}}\n" })).toEqual({ ...RECAP, promptTemplate: "You are {{name}}.\n\n{{instructions}}" });
  });

  it.each([
    ["name", NAME_REFUSED],
    ["description", DESCRIPTION_REFUSED],
    ["instructions", INSTRUCTIONS_NEEDED],
    ["model", MODEL_REFUSED],
    ["thinking", LEVELS_REFUSED],
    ["length", LEVELS_REFUSED],
    ["webSearch", WEB_SEARCH_UNSAID],
    ["rooms", ROOMS_REFUSED],
  ] as const)("refuses one without its %s, on its field", (field, error) => {
    const { [field]: _, ...rest } = RECAP;
    expect(parseNewAgent(rest)).toEqual({ error, field: field === "thinking" || field === "length" ? "levels" : field });
  });

  it("refuses what isn't an object, on the first field it needs", () => {
    for (const data of [null, "Recap", [RECAP]]) expect(parseNewAgent(data)).toEqual({ error: NAME_REFUSED, field: "name" });
  });

  it("takes who can ask it, which is everyone when it's left out", () => {
    expect(parseNewAgent(RECAP)).not.toHaveProperty("access");
    for (const access of AGENT_ACCESS) expect(parseNewAgent({ ...RECAP, access })).toEqual({ ...RECAP, access });
    expect(parseNewAgent({ ...RECAP, access: "members" })).toEqual({ error: ACCESS_REFUSED, field: "access" });
  });
});

describe("An agent's page", () => {
  it("changes any field, leaving out what isn't sent", () => {
    expect(parseAgentChanges({})).toEqual({});
    expect(parseAgentChanges({ name: "Digest" })).toEqual({ name: "Digest" });
    expect(parseAgentChanges({ thinking: "high" })).toEqual({ thinking: "high" });
    expect(parseAgentChanges({ webSearch: true, rooms: ROOMS })).toEqual({ webSearch: true, rooms: ROOMS });
    expect(parseAgentChanges({ rooms: null })).toEqual({ rooms: null });
    for (const access of AGENT_ACCESS) expect(parseAgentChanges({ access })).toEqual({ access });
    // Without a name, as Ember names the models it offers.
    expect(parseAgentChanges({ model: "openai/gpt-6.1-sol", modelName: "GPT-6.1 Sol" })).toEqual({ model: "openai/gpt-6.1-sol" });
    expect(parseAgentChanges({ modelName: "GPT-6.1 Sol" })).toEqual({});
    expect(parseAgentChanges({ promptTemplate: "{{instructions}}" })).toEqual({ promptTemplate: "{{instructions}}" });
    // Ember's own, as the page puts it back, goes back to following Ember's.
    expect(parseAgentChanges({ promptTemplate: AGENT_TEMPLATE })).toEqual({ promptTemplate: null });
    expect(parseAgentChanges({ promptTemplate: null })).toEqual({ promptTemplate: null });
    // @ember's own isn't an agent's.
    expect(parseAgentChanges({ promptTemplate: EMBER_TEMPLATE })).toEqual({ promptTemplate: EMBER_TEMPLATE });
  });

  it.each([
    ["a blank name", { name: " \t" }, NAME_REFUSED, "name"],
    ["a name of two lines", { name: "Re\ncap" }, NAME_REFUSED, "name"],
    ["a name that isn't text", { name: 7 }, NAME_REFUSED, "name"],
    ["a name longer than a person's can be", { name: "x".repeat(MAX_USER_NAME_LENGTH + 1) }, NAME_REFUSED, "name"],
    ["the AI assistant's name", { name: " @EMBER " }, NAME_RESERVED, "name"],
    ["a blank description", { description: "" }, DESCRIPTION_REFUSED, "description"],
    ["a description of two lines", { description: "Sums up long threads" }, DESCRIPTION_REFUSED, "description"],
    ["a description longer than one line in the list", { description: "x".repeat(MAX_AGENT_DESCRIPTION_LENGTH + 1) }, DESCRIPTION_REFUSED, "description"],
    ["blank instructions", { instructions: "\n \n" }, INSTRUCTIONS_NEEDED, "instructions"],
    ["instructions that aren't text", { instructions: ["Sum up."] }, INSTRUCTIONS_NEEDED, "instructions"],
    ["instructions longer than Ember takes", { instructions: "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1) }, INSTRUCTIONS_TOO_LONG, "instructions"],
    ["what Ember adds around them without the instructions", { promptTemplate: "You are {{name}}." }, INSTRUCTIONS_PLACE_NEEDED, "promptTemplate"],
    ["what Ember adds around them with a placeholder it doesn't fill in", { promptTemplate: "{{instructions}} {{room}}" }, unknownPlaceholder("room"), "promptTemplate"],
    ["what Ember adds around them that isn't text", { promptTemplate: ["{{instructions}}"] }, TEMPLATE_REFUSED, "promptTemplate"],
    ["a model that can't be one", { model: "claude haiku" }, MODEL_REFUSED, "model"],
    ["a level a dial doesn't have", { thinking: "max" }, LEVELS_REFUSED, "levels"],
    ["a length a dial doesn't have", { length: 3 }, LEVELS_REFUSED, "levels"],
    ["Search the web that isn't on or off", { webSearch: "yes" }, WEB_SEARCH_UNSAID, "webSearch"],
    ["an access there isn't", { access: "members" }, ACCESS_REFUSED, "access"],
    ["an access that isn't text", { access: ["admins"] }, ACCESS_REFUSED, "access"],
    ["no access at all", { access: null }, ACCESS_REFUSED, "access"],
    ["rooms that aren't a list", { rooms: "0mgk3x2a9b4c5a" }, ROOMS_REFUSED, "rooms"],
    ["a room twice", { rooms: [ROOMS[0], ROOMS[0]] }, ROOMS_REFUSED, "rooms"],
    ["something that can't be a room", { rooms: [ROOMS[0], "Launch!"] }, ROOMS_REFUSED, "rooms"],
    ["more rooms than there can be", { rooms: Array.from({ length: MAX_SHARED_ORDER + 1 }, (_, n) => `room-${n}`) }, ROOMS_REFUSED, "rooms"],
  ])("refuses %s, on its field", (_, data, error, field) => {
    expect(parseAgentChanges(data)).toEqual({ error, field });
  });

  it("says a name is an agent's in the words it was given", () => {
    expect(agentsName(" Recap ")).toBe("Recap is an AI agent's name. Choose another.");
  });
});

describe("Try it", () => {
  /** Recap as Try it sends it, with a question. */
  const TRIAL: AgentTrial = {
    name: "Recap",
    instructions: RECAP.instructions,
    promptTemplate: null,
    model: RECAP.model,
    thinking: "off",
    length: "short",
    webSearch: false,
    question: "Sum up this week.",
  };

  it("takes the agent as its page sets it up, and the question, leaving out what it does, who can ask it and its rooms, which it doesn't answer by", () => {
    expect(parseAgentTrial(TRIAL)).toEqual(TRIAL);
    expect(parseAgentTrial({ ...TRIAL, modelName: "Claude Haiku 5.5", question: "\n Sum up this week. \n" })).toEqual(TRIAL);
    // What it does, who can ask it and its rooms may be anything while they're unsaved.
    expect(parseAgentTrial({ ...TRIAL, description: "", access: "members", rooms: "Launch!" })).toEqual(TRIAL);
    expect(parseAgentTrial({ ...TRIAL, access: "admin-dms" })).toEqual(TRIAL);
    const longest = "x".repeat(MAX_MESSAGE_LENGTH);
    expect(parseAgentTrial({ ...TRIAL, question: longest })).toEqual({ ...TRIAL, question: longest });
    // What Ember adds around the instructions as the page has it, unsaved too, or else Ember's own.
    expect(parseAgentTrial({ ...TRIAL, promptTemplate: "Be {{name}}. {{instructions}}" })).toEqual({ ...TRIAL, promptTemplate: "Be {{name}}. {{instructions}}" });
    const { promptTemplate: _, ...unchanged } = TRIAL;
    expect(parseAgentTrial(unchanged)).toEqual(TRIAL);
  });

  it.each([
    ["name", NAME_REFUSED],
    ["instructions", INSTRUCTIONS_NEEDED],
    ["model", MODEL_REFUSED],
    ["thinking", LEVELS_REFUSED],
    ["length", LEVELS_REFUSED],
    ["webSearch", WEB_SEARCH_UNSAID],
    ["question", QUESTION_NEEDED],
  ] as const)("refuses one without its %s, on its field", (field, error) => {
    const { [field]: _, ...rest } = TRIAL;
    expect(parseAgentTrial(rest)).toEqual({ error, field: field === "thinking" || field === "length" ? "levels" : field });
  });

  it("refuses a field that can't be what it's for, and a question that's blank, not text, or longer than a message", () => {
    expect(parseAgentTrial({ ...TRIAL, name: "Ember" })).toEqual({ error: NAME_RESERVED, field: "name" });
    expect(parseAgentTrial({ ...TRIAL, model: "claude haiku" })).toEqual({ error: MODEL_REFUSED, field: "model" });
    expect(parseAgentTrial({ ...TRIAL, question: " \t\n" })).toEqual({ error: QUESTION_NEEDED, field: "question" });
    expect(parseAgentTrial({ ...TRIAL, question: ["Sum up."] })).toEqual({ error: QUESTION_NEEDED, field: "question" });
    expect(parseAgentTrial({ ...TRIAL, question: "x".repeat(MAX_MESSAGE_LENGTH + 1) })).toEqual({ error: MESSAGE_TOO_LONG, field: "question" });
    for (const data of [null, "Recap", [TRIAL]]) expect(parseAgentTrial(data)).toEqual({ error: NAME_REFUSED, field: "name" });
  });
});
