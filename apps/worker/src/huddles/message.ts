import type { RoomId, ServerFrame, User, UserId } from "@ember/protocol";
import type { MessageHuddle } from "@ember/protocol/huddles";
import { sortableId } from "../ids";
import type { MessageStore, StoredBody } from "../store";

// A huddle's message, which the room's Durable Object writes in the room as a huddle starts there
// (src/chat-room.ts), as Slack has one: in the name of whoever started the huddle, it shows that a
// huddle is going on, and once nobody is left in it, who was in it and for how long. Its thread is the
// huddle's. The room brings it in step with its huddle (./room.ts) as it is with each change of who's in
// it, in the order they come, and again with every check of the huddle, which is what makes up for a
// write that failed, and for an object that came back with nobody left in its huddle.
//
// The room's object keeps the message's id in its own storage from before it writes the message, so
// that a write whose answer it never had isn't made twice, and with it everyone who has been in the
// huddle, since the huddle's sockets only say who's in it now. The id is the huddle's to give, as it
// starts, so that everyone who joins it is told which message's thread is the huddle's.

/** What a huddle's message has for text, which a search finds it by, and which a bot or a tab from before huddles had messages reads. */
export const HUDDLE_STARTED = "A huddle started";

const BODY: StoredBody = { html: `<p>${HUDDLE_STARTED}</p>`, plainText: HUDDLE_STARTED, mentions: [] };

/**
 * How long after the last person leaves a huddle someone who was in it can join and find it the huddle
 * it was, which its message then shows going on again: a tab that lost its connection is back within
 * that. Anyone else starts another.
 */
export const HUDDLE_RESUMED_MS = 30_000;

/** What the room's object keeps in its own storage of its latest huddle's message. */
const KEPT = "huddleMessage";

/** A huddle as it is now: its room, when it started, and who's in it, in the order they joined. */
export interface HuddleNow {
  roomId: RoomId;
  startedAt: string;
  people: User[];
  /** The id its message has, or is to have. A huddle whose sockets are from before huddles named their messages has none. */
  messageId?: string;
}

/** The huddle a message is of, for whoever joins to go on with: when it started, and the message's id. */
export type ResumedHuddle = Required<Pick<HuddleNow, "startedAt" | "messageId">>;

interface Kept {
  roomId: RoomId;
  /** The message's id, which is kept before the message is written. */
  messageId: string;
  startedAt: string;
  /** Everyone who has been in the huddle, in the order they first joined. */
  people: User[];
  /** Whether the room has written the message, and told everyone of it, or has seen it deleted, which leaves nothing to write. */
  posted: boolean;
  /** When the room found nobody left in the huddle, once it has. */
  endedAt?: string;
}

/** What the room tells everyone of a huddle's message: that it's there, or what it says now. */
export type HuddleMessageFrame = Extract<ServerFrame, { type: "message.created" | "message.updated" }>;

/** `people`, with whoever of `inIt` isn't among them after them: `people` itself when they all are. */
function withNewcomers(people: User[], inIt: User[]): User[] {
  const newcomers = inIt.filter(({ id }) => !people.some((person) => person.id === id));
  return newcomers.length > 0 ? [...people, ...newcomers] : people;
}

export class HuddleMessage {
  /** What's kept of the latest huddle's message, once read from the object's storage. */
  private kept: Promise<Kept | undefined> | null = null;

  constructor(private readonly storage: DurableObjectStorage) {}

  /** The room whose huddle the latest message is of, which the alarm goes by with nobody left in the huddle. */
  async roomId(): Promise<RoomId | undefined> {
    return (await this.read())?.roomId;
  }

  /**
   * The huddle that `userId` joins now, with nobody else in one, where it's the huddle the latest
   * message is of going on: one the room hasn't found over, as when its object has come back since, or
   * one they were in that it found over no longer than `HUDDLE_RESUMED_MS` ago. Undefined for a huddle
   * that starts now.
   */
  async resumed(userId: UserId, now = Date.now()): Promise<ResumedHuddle | undefined> {
    const kept = await this.read();
    if (!kept) return undefined;
    const back = kept.endedAt === undefined || (now - Date.parse(kept.endedAt) <= HUDDLE_RESUMED_MS && kept.people.some(({ id }) => id === userId));
    return back ? { startedAt: kept.startedAt, messageId: kept.messageId } : undefined;
  }

  /**
   * Brings the message in step with `huddle`, the room's huddle as it is, or null with nobody in one,
   * and has `tell` tell everyone in the room of each thing it writes, as it's written, so that nothing
   * written goes untold for what fails after it. A huddle that starts gets a message, in the name of
   * whoever is first in it. Once nobody is left, the message says when the huddle ended and who was in
   * it, and should the huddle go on after all, that it's going on. Whatever is thrown leaves what's kept
   * as it was, for the next time to make up for.
   */
  async keepUp(store: MessageStore, huddle: HuddleNow | null, tell: (frames: HuddleMessageFrame[]) => void): Promise<void> {
    const kept = await this.read();
    if (kept && kept.startedAt === huddle?.startedAt) return tell(await this.goOn(store, kept, huddle));
    // The huddle the latest message is of is over, and one going on now is another.
    if (kept) tell(await this.end(store, kept));
    if (huddle) tell(await this.start(store, huddle));
  }

  /**
   * Leaves the latest huddle's message unwritten once the room has deleted it, as one of the messages
   * `ids` names: one whose write failed, and was saved all the same, isn't written again in its place.
   */
  async deleted(ids: string[]): Promise<void> {
    const kept = await this.read();
    if (kept && !kept.posted && ids.includes(kept.messageId)) await this.keep({ ...kept, posted: true });
  }

  /** Forgets the latest huddle's message, as a deleted room's messages go. */
  async forget(): Promise<void> {
    await this.storage.delete(KEPT);
    this.kept = Promise.resolve(undefined);
  }

  private async start(store: MessageStore, { roomId, startedAt, people, messageId = sortableId() }: HuddleNow): Promise<HuddleMessageFrame[]> {
    return this.post(store, await this.keep({ roomId, messageId, startedAt, people, posted: false }));
  }

  /** Writes the message `kept` names, of a huddle that's going on, and answers it for everyone to be told of. */
  private async post(store: MessageStore, kept: Kept): Promise<HuddleMessageFrame[]> {
    const told = await this.write(store, kept, { startedAt: kept.startedAt });
    await this.keep({ ...kept, posted: true });
    return told;
  }

  /**
   * Writes the message `kept` names, which says `huddle` of its huddle, in the name of whoever was first
   * in it, and answers it for everyone to be told of. A write that failed may have been saved all the
   * same, as D1's can be: the room then has the message, which nobody was told of, and it's written
   * again as it is, for its change's number. Unless it has been deleted since, and kept for its thread's
   * replies.
   */
  private async write(store: MessageStore, kept: Kept, huddle: MessageHuddle): Promise<HuddleMessageFrame[]> {
    const now = huddle.endedAt ?? new Date().toISOString();
    const saved = await store.find(kept.messageId);
    const written = saved ? saved.huddle && (await store.updateHuddle(saved, huddle, now)) : await store.createHuddle(kept.messageId, kept.people[0]!, BODY, huddle, now);
    return written ? [{ type: "message.created", ...written }] : [];
  }

  /**
   * Keeps whoever has joined the huddle since among those who've been in it. A message that isn't
   * written yet is written, and one that said the huddle was over says that it's going on.
   */
  private async goOn(store: MessageStore, kept: Kept, { people }: HuddleNow): Promise<HuddleMessageFrame[]> {
    const { endedAt, ...going } = { ...kept, people: withNewcomers(kept.people, people) };
    if (!kept.posted) return this.post(store, going);
    const told = endedAt === undefined ? [] : await this.say(store, kept.messageId, { startedAt: kept.startedAt });
    if (endedAt !== undefined || going.people !== kept.people) await this.keep(going);
    return told;
  }

  /**
   * Has the message say that the huddle is over, and who was in it, unless it says so already. One that
   * couldn't be written as the huddle started is written saying so.
   */
  private async end(store: MessageStore, kept: Kept): Promise<HuddleMessageFrame[]> {
    if (kept.endedAt !== undefined) return [];
    const endedAt = new Date().toISOString();
    const over = { startedAt: kept.startedAt, endedAt, people: kept.people };
    const told = kept.posted ? await this.say(store, kept.messageId, over) : await this.write(store, kept, over);
    await this.keep({ ...kept, posted: true, endedAt });
    return told;
  }

  /** Has the message say `huddle` of its huddle, and answers it as it is then for everyone to be told. A message deleted since says nothing more, nor does one kept for its thread's replies. */
  private async say(store: MessageStore, messageId: string, huddle: MessageHuddle): Promise<HuddleMessageFrame[]> {
    const message = await store.find(messageId);
    if (!message?.huddle) return [];
    return [{ type: "message.updated", ...(await store.updateHuddle(message, huddle, huddle.endedAt ?? new Date().toISOString())) }];
  }

  private read(): Promise<Kept | undefined> {
    return (this.kept ??= this.storage.get<Kept>(KEPT));
  }

  private async keep(kept: Kept): Promise<Kept> {
    await this.storage.put(KEPT, kept);
    this.kept = Promise.resolve(kept);
    return kept;
  }
}
