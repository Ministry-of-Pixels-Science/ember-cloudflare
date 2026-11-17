import { ASSISTANT_ID, type Me, type Message, type NewWorkspace, type RoomId, type User, type UserId } from "@ember/protocol";
import type { AgentAnswer, AgentSettings, NewAgent } from "@ember/protocol/agents";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, connect, cookieOf, createRoom, direct, freshDeploy, post, roomSql, settle, shown, startDirect, workspaceSql, workspaceStub, type Client, type Session } from "./support";

// What @ember and the AI agents read stays in the conversation they're asked in. Neither can be asked
// in a DM or a private room it isn't in, and each reads only the room it's asked in, by what it's given
// and by the room's search, so that what's said in a DM or a private room never reaches another room,
// or anyone who isn't in it. A question asked in one where an agent is isn't kept in AI Gateway's logs,
// which the account's administrators read. A fake AI Gateway stands behind `fetch`, whose model is Claude.

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "an-api-token-with-ai-gateway-run_0123456";
const CLAUDE = "anthropic/claude-sonnet-5.5";
const EMBER: Pick<User, "id"> = { id: ASSISTANT_ID };

/** What Ada and Grace say in their DM, and in their private room. */
const [SAID_IN_DM, SAID_IN_PRIVATE] = ["The launch code is tangerine.", "The budget for the launch is forty thousand."];
/** What Grace says in a room that was open to everyone, once it's private. */
const SAID_ONCE_CLOSED = "The venue is the old observatory.";

/** An agent as New agent sends it: Recap, in every open room, on Claude. */
const RECAP: NewAgent = { name: "Recap", description: "Sums up long threads", instructions: "Sum up the thread.", model: CLAUDE, thinking: "off", length: "short", webSearch: false, rooms: null };

/** A request the fake AI Gateway was sent: what it carried, as it was sent, and what it told the gateway's logs of keeping that, if anything. */
interface Asked {
  body: string;
  logsKeep: string | null;
}

/** What the model does in a turn of an answer with Ember's tools: searches the room for `words`, or answers, once what it waits for `first`, if anything, has happened. */
type Turn = ({ search: string } | { text: string }) & { first?: () => Promise<void> };

let asked: Asked[];
let script: Turn[];

/** Claude's answer for `turn`, the `nth` its model was asked for. */
function turnIn(turn: Turn, nth: number): Response {
  const content = "text" in turn ? [{ type: "text", text: turn.text }] : [{ type: "tool_use", id: `call_${nth}`, name: "search_messages", input: { words: turn.search } }];
  return Response.json({ type: "message", role: "assistant", content, stop_reason: "text" in turn ? "end_turn" : "tool_use", usage: { input_tokens: 1_000, output_tokens: 50 } });
}

beforeEach(async () => {
  await freshDeploy();
  asked = [];
  script = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const body = await request.text();
    asked.push({ body, logsKeep: request.headers.get("cf-aig-collect-log-payload") });
    // Turning Ember AI on, and making an agent, ask a test question, which gives the model no tools.
    if ((JSON.parse(body) as { tools?: unknown[] }).tools === undefined) return turnIn({ text: "Hello!" }, asked.length);
    const turn = script.shift() ?? { text: "Hello, team!" };
    await turn.first?.();
    return turnIn(turn, asked.length);
  });
});
afterEach(() => vi.restoreAllMocks());

const as = (session: Session) => ({ Cookie: session.cookie });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `done` says so, looking every few milliseconds. */
async function until(done: () => boolean): Promise<void> {
  while (!done()) await sleep(5);
}

/**
 * A turn's `first`, which holds the model there until the test lets it `go` on, and what waits until it's
 * `reached` there. The turn is asked in the room's own context, which can't use the test's sockets, and
 * neither goes on from the other's promises without taking its context, so each waits by looking.
 */
function held(): { first: () => Promise<void>; reached: () => Promise<void>; go: () => void } {
  let [there, gone] = [false, false];
  return {
    first: () => ((there = true), until(() => gone)),
    reached: () => until(() => there),
    go: () => void (gone = true),
  };
}

/** Someone called `name` joins with the join link, as a member, signed in. */
async function join(name: string): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify({ name, emailAddress: `${name.split(" ")[0]!.toLowerCase()}@example.com`, password: "nanoseconds" }) });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** Waits until room `room` has nothing left in its log for the search index. */
async function caughtUp(room: RoomId): Promise<void> {
  while ((await roomSql(room, "SELECT seq FROM unindexed_messages WHERE room_id = ?", room)).length > 0) await sleep(5);
}

/**
 * Sets Ember up with Ada as its administrator, Ember AI answering with Claude, and Grace, a member, who
 * has said something in her DM with Ada and in a private room of theirs, where neither @ember nor any
 * agent is, which the search index has: answering both of them, the general room, the DM and the
 * private room, and Grace in each of those two.
 */
async function setUp() {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  const ada = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
  const on = await api("/api/account/assistant", { method: "PUT", headers: as(ada), body: JSON.stringify({ accountId: ACCOUNT_ID, apiToken: API_TOKEN, model: CLAUDE }) });
  expect(on.status, await on.clone().text()).toBe(200);
  const grace = await join("Grace Hopper");
  const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
  const dm = (await direct(grace, ada)).id;
  const leads = (await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada })).id;
  const [inDm, inLeads] = [await connect(dm, grace), await connect(leads, grace)];
  await post(inDm, `<p>${SAID_IN_DM}</p>`);
  await post(inLeads, `<p>${SAID_IN_PRIVATE}</p>`);
  await Promise.all([caughtUp(dm), caughtUp(leads)]);
  asked.length = 0;
  return { ada, grace, general, dm, leads, inDm, inLeads };
}

/** Makes `agent` as `administrator`, answering it as its page shows it. */
async function makeAgent(administrator: Session, agent: NewAgent): Promise<AgentSettings> {
  const made = await api("/api/account/agents", { method: "POST", headers: as(administrator), body: JSON.stringify(agent) });
  expect(made.status, await made.clone().text()).toBe(201);
  return ((await made.json()) as AgentAnswer).agent;
}

/** How a message mentioning `person` is written. */
const mention = (person: Pick<User, "id">) => `<action-text-attachment sgid="${mentionSgid(person.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;

/** The next message `bot` posts that `client` hears of. */
async function nextFrom(client: Client, bot: Pick<User, "id">): Promise<Message> {
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.creator.id === bot.id) return message;
  }
}

/** Waits until everything `client` wrote in `room` has gone to whoever answers it. */
async function allAsked(room: RoomId, client: Client): Promise<void> {
  await vi.waitFor(async () => expect(await roomSql(room, "SELECT count(*) AS n FROM room_events")).toEqual([{ n: 0 }]));
  await settle(client);
}

/** The rooms `userId` is in, by ID. */
const roomsOf = async (userId: UserId) => ((await workspaceSql("SELECT room_id FROM memberships WHERE user_id = ? ORDER BY room_id", userId)) as Array<{ room_id: RoomId }>).map(({ room_id }) => room_id);

describe("What an agent reads", () => {
  it("is nothing in a DM or a private room it isn't in, whoever mentions it there, @ember or an agent in every open room", async () => {
    const { ada, grace, dm, leads, inDm, inLeads } = await setUp();
    const recap = await makeAgent(ada, RECAP);
    expect(await roomsOf(recap.id)).not.toContain(dm);
    expect(await roomsOf(recap.id)).not.toContain(leads);
    expect(await roomsOf(ASSISTANT_ID)).not.toContain(dm);
    expect(await roomsOf(ASSISTANT_ID)).not.toContain(leads);
    asked.length = 0;

    for (const [room, client] of [[dm, inDm], [leads, inLeads]] as const) {
      await post(client, `<p>${mention(EMBER)} ${mention(recap)} what did we just say?</p>`);
      await allAsked(room, client);
      for (const bot of [ASSISTANT_ID, recap.id]) expect(await workspaceStub().answererIn(room, bot, grace.user.id)).toBeNull();
    }
    expect(asked).toEqual([]);
  });

  it("is only the room it's asked in, by what it's given and by the room's search, even for someone who's in a DM or private room too", async () => {
    const { grace, general } = await setUp();
    const inGeneral = await connect(general, grace);
    script = [{ search: "tangerine" }, { search: "budget" }, { text: "I found nothing about that here." }];

    await post(inGeneral, `<p>${mention(EMBER)} what's the launch code, and the budget?</p>`);
    expect((await nextFrom(inGeneral, EMBER)).plainText).toBe("I found nothing about that here.");
    expect(asked).toHaveLength(3);
    // Each search was made, and found nothing of the DM or the private room.
    expect(asked[2]!.body).toContain('"tool_result"');
    for (const { body } of asked) {
      expect(body).not.toContain("tangerine.");
      expect(body).not.toContain("forty thousand");
    }
  });
});

describe("A question asked in a DM or a private room", () => {
  it("isn't kept in AI Gateway's logs, as one asked in an open room is", async () => {
    const { ada, grace, general, leads } = await setUp();
    // Its people put @ember in the private room, and Ada has a DM with it.
    const changed = await api(`/api/rooms/${leads}`, { method: "PATCH", headers: as(ada), body: JSON.stringify({ name: "Leads", kind: "closed", memberIds: [ada.user.id, grace.user.id, ASSISTANT_ID] }) });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const { room: withEmber } = (await (await startDirect(ada, [ASSISTANT_ID])).json()) as { room: { id: RoomId } };
    const [inGeneral, inLeads, inDm] = [await connect(general, ada), await connect(leads, ada), await connect(withEmber.id, ada)];

    await post(inGeneral, `<p>${mention(EMBER)} hello?</p>`);
    await nextFrom(inGeneral, EMBER);
    await post(inLeads, `<p>${mention(EMBER)} what's the budget?</p>`);
    await nextFrom(inLeads, EMBER);
    await post(inDm, "<p>Just between us?</p>");
    await nextFrom(inDm, EMBER);

    expect(asked.map(({ logsKeep }) => logsKeep)).toEqual([null, "false", "false"]);
    // What was said there went to the model all the same, which answers from it.
    expect(asked[1]!.body).toContain("forty thousand");
  });

  it("is what an answer begun in the open becomes once it searches its room after the room is made private, to its end", async () => {
    const { ada, grace } = await setUp();
    const plans = (await createRoom("Plans", { as: ada })).id;
    const [inPlans, graceInPlans] = [await connect(plans, ada), await connect(plans, grace)];
    const made = async (kind: "open" | "closed") => {
      const body = kind === "closed" ? { kind, memberIds: [ada.user.id, grace.user.id, ASSISTANT_ID] } : { kind };
      const changed = await api(`/api/rooms/${plans}`, { method: "PATCH", headers: as(ada), body: JSON.stringify(body) });
      expect(changed.status, await changed.clone().text()).toBe(200);
    };
    const [closing, opening] = [held(), held()];
    script = [{ search: "venue", first: closing.first }, { search: "venue", first: opening.first }, { text: "It's at the old observatory." }];

    await post(inPlans, `<p>${mention(EMBER)} where's the venue?</p>`);
    // The room is made private while the model works on its first turn, and Grace says something there before it searches.
    await closing.reached();
    await made("closed");
    await post(graceInPlans, `<p>${SAID_ONCE_CLOSED}</p>`);
    await caughtUp(plans);
    closing.go();
    // It's open to everyone again before the model searches once more.
    await opening.reached();
    await made("open");
    opening.go();
    expect((await nextFrom(inPlans, EMBER)).plainText).toBe("It's at the old observatory.");
    expect(asked[1]!.body).toContain(SAID_ONCE_CLOSED);
    // The first was asked in the open, and the rest after the search read the private room, though it was open again by the last.
    expect(asked.map(({ logsKeep }) => logsKeep)).toEqual([null, "false", "false"]);
  });
});
