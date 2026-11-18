import {
  isMessageTooLong,
  isReservedName,
  isRoomId,
  MAX_SHARED_ORDER,
  MAX_USER_NAME_LENGTH,
  MESSAGE_TOO_LONG,
  NAME_RESERVED,
  type Card,
  type DirectoryUser,
  type RoomId,
  type User,
} from "./index.ts";
import {
  ANSWER_LENGTHS,
  INSTRUCTIONS_TOO_LONG,
  LEVELS_REFUSED,
  MAX_INSTRUCTIONS_LENGTH,
  MODEL_REFUSED,
  modelOf,
  THINKING_LEVELS,
  type AnswerLength,
  type AnswerLevels,
  type ModelFormat,
  type ThinkingLevel,
  type WebTool,
} from "./assistant.ts";
import { parseTemplate } from "./prompts.ts";

// AI agents, which administrators make beside @ember on the AI assistant tab of workspace settings,
// through `/api/account/agents`. Each is a bot that answers with its own instructions and model, through
// the AI Gateway Ember AI asks, when someone mentions it in a room it's in, or writes to it directly.

/** The most agents there are, as many as the models people can pick, so that listing them is one short read. */
export const MAX_AGENTS = 20;

/** The longest description of what an agent does, which is one line in the list of agents. */
export const MAX_AGENT_DESCRIPTION_LENGTH = 100;

/** A room an agent is in, by name. */
export interface AgentRoom {
  id: RoomId;
  name: string;
}

/**
 * Who can ask an agent, as Admin access on its page sets it: "everyone", "admins", for one only
 * administrators can ask, which everyone else still reads in its rooms, or "admin-dms", for one only
 * administrators can ask, in their direct messages with it: it's in no other room, and nobody else is
 * told of it.
 */
export const AGENT_ACCESS = ["everyone", "admins", "admin-dms"] as const;
export type AgentAccess = (typeof AGENT_ACCESS)[number];

/**
 * An agent as the AI assistant tab lists it to administrators: as the people directory lists it, with
 * what it does, the model it answers with and what that's called, what it does on the web, nothing while
 * Search the web is off, who can ask it, and the open rooms it's kept to, by name, or null while it's in
 * every one, new ones too.
 */
export interface Agent extends DirectoryUser {
  description: string;
  model: string;
  modelName: string;
  webTools: WebTool[];
  access: AgentAccess;
  rooms: AgentRoom[] | null;
}

/** What Available Agents says @ember does, which has no description of its own. */
export const EMBER_DOES = "Answers anything people ask.";

/**
 * An agent as Available Agents lists it to someone who can ask it, @ember among them: as the people
 * directory lists it, with what it does, who can ask it, and the rooms it shares with them, by name, but
 * DMs, or null while it's in every open room, new ones too. Anyone who isn't an administrator is listed
 * only the ones everyone can ask.
 */
export interface AvailableAgent extends DirectoryUser {
  description: string;
  access: AgentAccess;
  rooms: AgentRoom[] | null;
}

/** What `GET /api/agents` answers: the agents whoever asks can ask, @ember first, then by name, and none while Ember AI is off. */
export interface AvailableAgents {
  agents: AvailableAgent[];
}

/**
 * An agent as its page shows it: as the tab lists it, with its instructions and what Ember adds around
 * them, the format its model took its test question in, how much it thinks and how long it answers, the
 * levels of thinking its model takes, whether an administrator uploaded its avatar, and who last changed
 * it, and when.
 */
export interface AgentSettings extends Agent {
  instructions: string;
  /** What Ember adds around its instructions, as an administrator changed it, or null for Ember's own (`ownTemplateFor`). */
  promptTemplate: string | null;
  format: ModelFormat;
  levels: AnswerLevels;
  /** The levels of thinking its model takes (`AssistantModel.thinkingLevels`), or null for one Ember hasn't asked at each, which is asked at any. */
  thinkingLevels: ThinkingLevel[] | null;
  /** Whether an administrator uploaded its avatar, which `DELETE /api/account/agents/<id>/avatar` takes away. */
  avatar: boolean;
  changedBy: User;
  changedAt: string;
}

/**
 * An agent as its page at `/users/<id>` shows it to everyone, but its instructions: what it does, the
 * model it answers with and what that's called, and the administrator who made it.
 */
export interface AgentProfile {
  description: string;
  model: string;
  modelName: string;
  setUpBy: User;
}

/** What `GET /api/account/agents` answers: the agents, by name. */
export interface Agents {
  agents: Agent[];
}

/**
 * What `GET /api/account/agents/<id>` answers, and `POST /api/account/agents`, `PATCH /api/account/agents/<id>`
 * and `DELETE /api/account/agents/<id>/avatar`, which make an agent, change one and take away its avatar:
 * the agent as its page then shows it.
 */
export interface AgentAnswer {
  agent: AgentSettings;
}

/**
 * What `POST /api/account/agents` takes, as New agent sends it: the agent's name, what it does, its
 * instructions, and what Ember adds around them, if an administrator changed it, the ID of the model it
 * answers with, how much it thinks and how long it answers, whether it searches the web, who can ask it,
 * and the open rooms it's in, or null for every one, new ones too. One only administrators' direct
 * messages reach is in none, whatever rooms are sent.
 */
export interface NewAgent {
  name: string;
  description: string;
  instructions: string;
  /** What Ember adds around the instructions (`promptAround`), or null, or left out, for Ember's own. */
  promptTemplate?: string | null;
  model: string;
  thinking: ThinkingLevel;
  length: AnswerLength;
  webSearch: boolean;
  /** Who can ask it, or left out for everyone. */
  access?: AgentAccess;
  rooms: RoomId[] | null;
}

/** What `PATCH /api/account/agents/<id>` changes, as the agent's page saves it: any of what New agent takes. What's left out stays as it is. */
export type AgentChanges = Partial<NewAgent>;

/**
 * What `POST /api/account/agents/trials` takes, and `POST /api/account/agents/<id>/trials` for an agent
 * that's saved, as Try it sends it: the agent as its page sets it up, saved or not, but for what it does,
 * who can ask it and its rooms, which it doesn't answer by, and the question to ask it.
 */
export interface AgentTrial extends Omit<NewAgent, "description" | "access" | "rooms"> {
  question: string;
}

/**
 * What Try it answers: what the agent said, as a message of its shows it, its text as the room keeps one
 * (`Message.body`), which `displayBody` shows, and the cards of the pictures it shows, and how long its
 * model took, in milliseconds.
 */
export interface AgentTrialAnswer {
  body: string;
  cards: Card[];
  ms: number;
}

/** A field of an agent's page, which a refusal can be about. */
export type AgentField = "name" | "description" | "instructions" | "promptTemplate" | "model" | "levels" | "webSearch" | "access" | "rooms" | "question";

/** Why what an agent's page sent is refused, on the field it's about. */
export interface AgentRefusal {
  error: string;
  field: AgentField;
}

/** What the agents' pages and their API tell anyone but an administrator. */
export const AGENTS_FORBIDDEN = "Only administrators can set up agents";

/** Why `POST /api/account/agents` makes no more. */
export const AGENTS_FULL = `Ember can have at most ${MAX_AGENTS} agents. Delete one first.`;

/** Why an agent can't take a name that someone, a bot or another agent has, in any capitals. */
export const NAME_TAKEN = "Someone is called that already. Choose another name.";

/** Why someone or a bot can't be called `name`, which is an agent's. */
export const agentsName = (name: string) => `${name.trim()} is an AI agent's name. Choose another.`;

/** Why a change didn't save: the agent was changed while its model took its test question, or since its page read it. */
export const AGENT_CHANGED = "The agent was changed while its model answered. Try again.";

/** Why an agent wasn't saved: Ember AI was set up again, with another account or API token, while its model answered. */
export const AGENT_SET_UP_AGAIN = "Ember AI was set up again while the model answered, so nothing was saved. Try again.";

/** Why Search the web can't be on for an agent whose model, called `name`, has no tool for it that AI Gateway passes on, or Ember gives it. */
export const agentCannotSearchWith = (name: string) =>
  `${name} can't search the web through AI Gateway, but the other models Ember offers can. Choose one of those, or leave Search the web off.`;

/** Why an agent's fields are refused before anything's saved. */
export const NAME_REFUSED = `Give it a name of one line, at most ${MAX_USER_NAME_LENGTH} characters, which people mention it by.`;
export const DESCRIPTION_REFUSED = `Say what it does in one line of at most ${MAX_AGENT_DESCRIPTION_LENGTH} characters, so people know when to ask it.`;
export const INSTRUCTIONS_NEEDED = "Give it instructions: its task, how to go about it, and what to leave alone.";
export const WEB_SEARCH_UNSAID = "Say whether it searches the web.";
export const ACCESS_REFUSED = "Say who can ask it: everyone, administrators, or administrators in their direct messages with it.";
export const ROOMS_REFUSED = "Choose rooms open to everyone, or every one.";
export const QUESTION_NEEDED = "Ask it something.";

/**
 * Parses an untrusted change to an agent, as its page saves it. Returns why it's refused instead, on the
 * field it's about: a name, which can't be @ember's (`isReservedName`), and what it does have to be one
 * line with more than spaces, no longer than Ember keeps, instructions more than spaces, no longer than
 * Ember takes (`MAX_INSTRUCTIONS_LENGTH`), what Ember adds around them a template Ember takes, or null
 * for its own (`parseTemplate`), a model one's ID, which needn't be one Ember offers, as an agent may
 * keep the one it has (`changeAgent`), levels ones the dials have, who can ask it one of `AGENT_ACCESS`,
 * and rooms a list of rooms' IDs, each once, or null for every open room. Text is saved without the
 * spaces around it.
 */
export function parseAgentChanges(data: unknown): AgentChanges | AgentRefusal {
  const given = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const changes: AgentChanges = {};
  if (given.name !== undefined) {
    const name = oneLineIn(given.name);
    if (!name || name.length > MAX_USER_NAME_LENGTH) return { error: NAME_REFUSED, field: "name" };
    if (isReservedName(name)) return { error: NAME_RESERVED, field: "name" };
    changes.name = name;
  }
  if (given.description !== undefined) {
    const description = oneLineIn(given.description);
    if (!description || description.length > MAX_AGENT_DESCRIPTION_LENGTH) return { error: DESCRIPTION_REFUSED, field: "description" };
    changes.description = description;
  }
  if (given.instructions !== undefined) {
    const instructions = typeof given.instructions === "string" ? given.instructions.trim() : "";
    if (!instructions) return { error: INSTRUCTIONS_NEEDED, field: "instructions" };
    if (instructions.length > MAX_INSTRUCTIONS_LENGTH) return { error: INSTRUCTIONS_TOO_LONG, field: "instructions" };
    changes.instructions = instructions;
  }
  if (given.promptTemplate !== undefined) {
    const parsed = parseTemplate(given.promptTemplate, null);
    if ("error" in parsed) return { error: parsed.error, field: "promptTemplate" };
    changes.promptTemplate = parsed.template;
  }
  if (given.model !== undefined) {
    const model = typeof given.model === "string" ? modelOf(given.model) : null;
    if (model === null) return { error: MODEL_REFUSED, field: "model" };
    changes.model = model;
  }
  if (given.thinking !== undefined) {
    if (!(THINKING_LEVELS as readonly unknown[]).includes(given.thinking)) return { error: LEVELS_REFUSED, field: "levels" };
    changes.thinking = given.thinking as ThinkingLevel;
  }
  if (given.length !== undefined) {
    if (!(ANSWER_LENGTHS as readonly unknown[]).includes(given.length)) return { error: LEVELS_REFUSED, field: "levels" };
    changes.length = given.length as AnswerLength;
  }
  if (given.webSearch !== undefined) {
    if (typeof given.webSearch !== "boolean") return { error: WEB_SEARCH_UNSAID, field: "webSearch" };
    changes.webSearch = given.webSearch;
  }
  if (given.access !== undefined) {
    if (!(AGENT_ACCESS as readonly unknown[]).includes(given.access)) return { error: ACCESS_REFUSED, field: "access" };
    changes.access = given.access as AgentAccess;
  }
  if (given.rooms !== undefined) {
    const rooms = roomsIn(given.rooms);
    if (rooms === undefined) return { error: ROOMS_REFUSED, field: "rooms" };
    changes.rooms = rooms;
  }
  return changes;
}

/**
 * Parses an untrusted new agent, as New agent sends it, as `parseAgentChanges` does a change, which leaves
 * out nothing but what Ember adds around the instructions, which is then its own, and who can ask it,
 * which is then everyone. Whether Ember offers its model is the Worker's to say, as the models it offers
 * change.
 */
export function parseNewAgent(data: unknown): NewAgent | AgentRefusal {
  const agent = parseAgentChanges(data);
  if ("error" in agent) return agent;
  const { name, description, instructions, promptTemplate = null, model, thinking, length, webSearch, rooms } = agent;
  if (name === undefined) return { error: NAME_REFUSED, field: "name" };
  if (description === undefined) return { error: DESCRIPTION_REFUSED, field: "description" };
  if (instructions === undefined) return { error: INSTRUCTIONS_NEEDED, field: "instructions" };
  if (model === undefined) return { error: MODEL_REFUSED, field: "model" };
  if (thinking === undefined || length === undefined) return { error: LEVELS_REFUSED, field: "levels" };
  if (webSearch === undefined) return { error: WEB_SEARCH_UNSAID, field: "webSearch" };
  if (rooms === undefined) return { error: ROOMS_REFUSED, field: "rooms" };
  return { ...agent, name, description, instructions, promptTemplate, model, thinking, length, webSearch, rooms };
}

/**
 * Parses an untrusted trial, as Try it sends it: the agent as `parseNewAgent` takes one, but for what it
 * does, who can ask it and its rooms, which are left out, and its model, which may be one Ember no
 * longer offers that the agent has (`tryAgent`), and a question of more than spaces, no longer than a
 * message, without the spaces around it.
 */
export function parseAgentTrial(data: unknown): AgentTrial | AgentRefusal {
  const given = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const { description: _, rooms: __, access: ___, question: asked, ...setup } = given;
  const agent = parseAgentChanges(setup);
  if ("error" in agent) return agent;
  const { name, instructions, promptTemplate = null, model, thinking, length, webSearch } = agent;
  if (name === undefined) return { error: NAME_REFUSED, field: "name" };
  if (instructions === undefined) return { error: INSTRUCTIONS_NEEDED, field: "instructions" };
  if (model === undefined) return { error: MODEL_REFUSED, field: "model" };
  if (thinking === undefined || length === undefined) return { error: LEVELS_REFUSED, field: "levels" };
  if (webSearch === undefined) return { error: WEB_SEARCH_UNSAID, field: "webSearch" };
  const question = typeof asked === "string" ? asked.trim() : "";
  if (!question) return { error: QUESTION_NEEDED, field: "question" };
  if (isMessageTooLong(question)) return { error: MESSAGE_TOO_LONG, field: "question" };
  return { ...agent, name, instructions, promptTemplate, model, thinking, length, webSearch, question };
}

/** `text` without the spaces around it, or "" unless it's one line: without control characters or line breaks. */
function oneLineIn(text: unknown): string {
  const line = typeof text === "string" ? text.trim() : "";
  return /[\p{Cc}\p{Zl}\p{Zp}]/u.test(line) ? "" : line;
}

/** The rooms `given` lists, each once, or null for every open room, or undefined when it's neither, as an agent's and a chat bot's are picked. */
export function roomsIn(given: unknown): RoomId[] | null | undefined {
  if (given === null) return null;
  if (!Array.isArray(given) || given.length > MAX_SHARED_ORDER) return undefined;
  const ids = given.filter((id): id is RoomId => typeof id === "string" && isRoomId(id));
  return ids.length === given.length && new Set(ids).size === ids.length ? ids : undefined;
}
