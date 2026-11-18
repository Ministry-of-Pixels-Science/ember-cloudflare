import { REACTIONS, type UserId } from "@ember/protocol";
import { HuddleClient } from "../huddle-client.ts";
import { atRate, closeAll, measure, newRoom, sum, waitFor, type Window } from "../load.ts";
import { setUp, signIn, turnHuddlesOn, type Session } from "../room-client.ts";
import type { Server } from "../server.ts";
import { SFU_APP, type StandInSfu } from "../sfu.ts";
import { summarize, type Summary } from "../stats.ts";

export interface HuddleOptions {
  /** Huddle sizes to grow through, in order. A huddle takes 50 people. */
  sizes: number[];
  /** Reactions sent at each size, by the people in the huddle in turn, and how fast: few enough that nobody sends more than the 20 in ten seconds the room tells of. */
  reactions: number;
  rate: number;
}

export interface HuddleStep {
  people: number;
  joins: number;
  /** Opening a huddle's socket to the room's welcome. */
  welcome: Summary | null;
  /** From someone's welcome to the room saying that they receive everyone who was in the huddle. */
  hearsAll: Summary | null;
  /** From someone's welcome to the last person who was in the huddle receiving them. */
  heardByAll: Summary | null;
  /** What the room asked of the SFU for the last of them to join: for their own voice and connections, and for each of the others' round to hear them. */
  sfuRequestsForLastJoin: number;
  /** From someone reacting to each person in the huddle seeing it, themselves included. */
  reaction: Summary | null;
  /** Copies of those reactions that never came. */
  lost: number;
  /** While they joined. */
  window: Window;
}

export interface HuddleResult extends HuddleOptions {
  steps: HuddleStep[];
  /** How often the room told a tab that it couldn't do what the tab asked, or that the SFU had lost its voice. */
  errors: number;
  /** Why the huddle stopped growing early, if it did. */
  stopped: string | null;
}

/** How long someone's joining may take to reach everyone, and a reaction, before the scenario gives up waiting. */
const JOINED_TIMEOUT_MS = 30_000;
const REACTED_TIMEOUT_MS = 10_000;

/** How long each part of someone's joining took, in milliseconds: the last two are null for whoever starts the huddle, with nobody to hear. */
interface Joined {
  welcome: number;
  hearsAll: number | null;
  heardByAll: number | null;
}

/**
 * Has `client`, whose person the room has just welcomed, join the huddle `people` are in: they publish
 * their voice and ask to hear everyone, and everyone asks to hear them. Resolves once the room has told
 * each of them that they do, with the newcomer among `people` and how long both took from the welcome.
 */
async function join(people: HuddleClient[], client: HuddleClient): Promise<Omit<Joined, "welcome">> {
  const welcomedAt = performance.now();
  const others = people.length;
  let hears = 0;
  let heardBy = 0;
  let hearsAllAt = 0;
  let heardByAllAt = 0;
  client.onHeard = (_, at) => {
    if (++hears === others) hearsAllAt = at;
  };
  for (const person of people) {
    person.onHeard = (userId, at) => {
      if (userId === client.session.user.id && ++heardBy === others) heardByAllAt = at;
    };
  }
  client.talk();
  const joined = await waitFor(() => client.published && hears >= others && heardBy >= others, JOINED_TIMEOUT_MS);
  for (const person of [...people, client]) person.onHeard = null;
  if (!joined) throw new Error(`Of the ${others} in the huddle, the newcomer heard ${hears} and ${heardBy} heard the newcomer within ${JOINED_TIMEOUT_MS}ms`);
  people.push(client);
  return { hearsAll: others > 0 ? hearsAllAt - welcomedAt : null, heardByAll: others > 0 ? heardByAllAt - welcomedAt : null };
}

/**
 * Has the people in the huddle react in turn, `rate` reactions a second, and answers how long each
 * took to reach each of them. The room says whose a reaction is and nothing else of it, so each
 * person's are told apart by the order they come in.
 */
async function react(people: HuddleClient[], reactions: number, rate: number): Promise<{ delivery: number[]; lost: number }> {
  const sentAt = new Map<UserId, number[]>();
  const delivery: number[] = [];
  for (const person of people) {
    const seen = new Map<UserId, number>();
    person.onReaction = (userId, at) => {
      const nth = seen.get(userId) ?? 0;
      seen.set(userId, nth + 1);
      const sent = sentAt.get(userId)?.[nth];
      if (sent !== undefined) delivery.push(at - sent);
    };
  }
  const expected = reactions * people.length;
  await atRate(reactions, rate, (i) => {
    const sender = people[i % people.length]!;
    const { id } = sender.session.user;
    sentAt.set(id, [...(sentAt.get(id) ?? []), performance.now()]);
    sender.react(REACTIONS[i % REACTIONS.length]![0]);
  });
  await waitFor(() => delivery.length === expected, REACTED_TIMEOUT_MS);
  for (const person of people) person.onReaction = null;
  return { delivery, lost: expected - delivery.length };
}

const taken = (times: Array<number | null>) => summarize(times.filter((ms) => ms !== null));

/**
 * Grows one huddle a person at a time, each joining once the last is heard by everyone, as people
 * come to a call, and at each size has everyone react in turn. The SFU is a stand-in that answers at
 * once (../sfu.ts), so it's what a huddle has the room do that's timed: nothing anyone says passes
 * through Ember.
 */
export async function huddle(server: Server, sfu: StandInSfu, options: HuddleOptions): Promise<HuddleResult> {
  await turnHuddlesOn(server.url, await setUp(server.url), SFU_APP);
  const room = await newRoom(server, "huddle");
  const people: HuddleClient[] = [];
  /** Everyone the room has welcomed: the people in the huddle, and a newcomer who then couldn't join them, whose errors count as theirs do. */
  const welcomed: HuddleClient[] = [];
  const steps: HuddleStep[] = [];
  let stopped: string | null = null;

  for (const size of options.sizes) {
    try {
      const sessions: Session[] = [];
      for (let i = people.length; i < size; i++) sessions.push(await signIn(server.url, `huddler-${i}`));
      let askedBeforeLast = sfu.requests;
      const { result: joined, window } = await measure(server, async () => {
        const joined: Joined[] = [];
        for (const session of sessions) {
          askedBeforeLast = sfu.requests;
          const { client, ms: welcome } = await HuddleClient.connect(server.url, room, session);
          welcomed.push(client);
          joined.push({ welcome, ...(await join(people, client)) });
        }
        return joined;
      });
      const sfuRequestsForLastJoin = sfu.requests - askedBeforeLast;
      const { delivery, lost } = await react(people, options.reactions, options.rate);
      steps.push({
        people: people.length,
        joins: joined.length,
        welcome: summarize(joined.map(({ welcome }) => welcome)),
        hearsAll: taken(joined.map(({ hearsAll }) => hearsAll)),
        heardByAll: taken(joined.map(({ heardByAll }) => heardByAll)),
        sfuRequestsForLastJoin,
        reaction: summarize(delivery),
        lost,
        window,
      });
    } catch (error) {
      stopped = `Joining failed past ${people.length} people: ${(error as Error).message}`;
      break;
    }
  }
  closeAll(welcomed);
  return { ...options, steps, errors: sum(welcomed.map((client) => client.errors.length)), stopped };
}
