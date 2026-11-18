import type { UserId } from "@ember/protocol";
import { huddleSocketQuery, type HuddleClientFrame, type HuddlePerson, type HuddleServerFrame } from "@ember/protocol/huddles";
import type { Session } from "./room-client.ts";
import { sessionDescription } from "./sfu.ts";

// A lightweight tab in a huddle for load tests: one WebSocket to a room's huddle, the frames the web
// app sends for its person's voice, and the rounds it asks to hear the others in, with session
// descriptions as long as a browser's in place of a browser's connections (./sfu.ts).

/** Node's WebSocket, which, unlike a browser's, can send a handshake's headers. */
const NodeWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const CONNECT_TIMEOUT_MS = 30_000;
/** How often a tab pings its huddle's socket, which the runtime answers for the room: the room takes out of a huddle whoever's socket it hasn't heard from in 90 seconds. */
const HEARTBEAT_MS = 25_000;

type Welcome = Extract<HuddleServerFrame, { type: "huddle.welcome" }>;

/** The address of a room's huddle socket, for a tab whose person joins unmuted. */
export function huddleSocketUrl(baseUrl: string, room: string): string {
  const url = new URL(`/api/rooms/${encodeURIComponent(room)}/huddle${huddleSocketQuery({ muted: false })}`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class HuddleClient {
  /** Called as the room says the tab receives someone's voice, with whose it is and the time it said so. */
  onHeard: ((userId: UserId, at: number) => void) | null = null;
  /** Called with each reaction the tab sees, whose it is, and the time it came. */
  onReaction: ((userId: UserId, at: number) => void) | null = null;
  /** Whether the SFU has taken the tab's voice, which the others can listen to from then. */
  published = false;
  /** What the room said it couldn't do, and what the SFU lost of the tab's. */
  errors: string[] = [];

  readonly session: Session;
  private readonly ws: WebSocket;
  /** Who the tab can listen to, as the room last said: the others whose voices have connected. */
  private readonly listenable = new Set<UserId>();
  /** Whose voices the room has said the tab receives. */
  private readonly heard = new Set<UserId>();
  /** Who the round under way has offered the tab so far, or null between rounds. */
  private round: UserId[] | null = null;
  /** Whether the tab has a receiving connection, which its first offer makes. */
  private receiving = false;
  /** The tab's pings, from the room's welcome until its socket closes. */
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  private constructor(session: Session, ws: WebSocket) {
    this.session = session;
    this.ws = ws;
  }

  /** Opens a socket to `room`'s huddle and resolves once the room's welcome arrives, with how long that took in milliseconds. */
  static connect(baseUrl: string, room: string, session: Session): Promise<{ client: HuddleClient; ms: number }> {
    const started = performance.now();
    // The room only takes upgrades from the app's own pages, with a session cookie.
    const ws = new NodeWebSocket(huddleSocketUrl(baseUrl, room), { headers: { Cookie: session.cookie, Origin: new URL(baseUrl).origin } });
    const client = new HuddleClient(session, ws);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`No welcome from ${room}'s huddle after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS);
      const fail = (error: Error) => {
        clearTimeout(timer);
        // Closing a socket that failed to open fires its error event again, so stop listening first.
        ws.onerror = ws.onclose = ws.onmessage = null;
        ws.close();
        reject(error);
      };
      ws.onerror = () => fail(new Error(`Socket to ${room}'s huddle failed`));
      ws.onclose = (event) => fail(new Error(`Socket to ${room}'s huddle closed (${event.code}) before its welcome`));
      ws.onmessage = (event) => {
        const frame = JSON.parse(event.data as string) as HuddleServerFrame;
        if (frame.type !== "huddle.welcome") return;
        clearTimeout(timer);
        ws.onerror = null;
        ws.onclose = () => clearInterval(client.heartbeat);
        ws.onmessage = (next) => client.receive(next.data as string);
        client.heartbeat = setInterval(() => ws.send('{"type":"ping"}'), HEARTBEAT_MS);
        client.welcomed(frame);
        resolve({ client, ms: performance.now() - started });
      };
    });
  }

  /** Publishes the tab's voice, and asks to hear everyone it can listen to, as a tab does once it's welcomed. */
  talk(): void {
    this.send({ type: "huddle.publish", sdp: sessionDescription(1), tracks: [{ mid: "0", kind: "audio" }] });
    this.listen();
  }

  /** Reacts with `emoji`, which everyone in the huddle sees, the tab itself included. */
  react(emoji: string): void {
    this.send({ type: "huddle.react", emoji });
  }

  /** Starts closing without waiting for the handshake; nothing here needs to see it finish. */
  close(): void {
    clearInterval(this.heartbeat);
    this.ws.close(1000);
  }

  private send(frame: HuddleClientFrame): void {
    this.ws.send(JSON.stringify(frame));
  }

  private welcomed({ you, people }: Welcome): void {
    for (const person of people) if (person.user.id !== you.id) this.heardOf(person);
  }

  /** Takes what the room says of someone else in the huddle: whether the tab can listen to them. One who publishes anew is the tab's to hear again. */
  private heardOf({ user, audio }: HuddlePerson): void {
    if (audio) return void this.listenable.add(user.id);
    this.gone(user.id);
  }

  private gone(userId: UserId): void {
    this.listenable.delete(userId);
    this.heard.delete(userId);
  }

  /** Starts a round, unless one is under way: asks the room for whoever the tab can listen to and doesn't hear, on a fresh connection while it has none. */
  private listen(): void {
    if (this.round || ![...this.listenable].some((userId) => !this.heard.has(userId))) return;
    this.round = [];
    this.send({ type: "huddle.listen", kind: "audio", ...(!this.receiving && { fresh: true as const }) });
  }

  /** Ends the round under way: the tab receives whoever it was offered. One that offered someone is followed by another, for whoever the tab can listen to since. */
  private listening(at: number): void {
    const offered = this.round ?? [];
    this.round = null;
    for (const userId of offered) {
      this.heard.add(userId);
      this.onHeard?.(userId, at);
    }
    // A round that offered nobody waits for the room's next word of someone, rather than asking again at once.
    if (offered.length > 0) this.listen();
  }

  private receive(data: string): void {
    const at = performance.now();
    const frame = JSON.parse(data) as HuddleServerFrame;
    switch (frame.type) {
      case "huddle.joined":
      case "huddle.changed":
        this.heardOf(frame.person);
        return this.listen();
      case "huddle.left":
        return this.gone(frame.userId);
      case "huddle.published":
        this.published = true;
        return this.send({ type: "huddle.connected", kind: "audio" });
      case "huddle.offer":
        this.receiving = true;
        this.round = frame.tracks.map(({ userId }) => userId);
        return this.send({ type: "huddle.answer", kind: "audio", sdp: sessionDescription(this.heard.size + frame.tracks.length) });
      case "huddle.listening":
        return this.listening(at);
      case "huddle.reacted":
        return this.onReaction?.(frame.userId, at);
      case "huddle.unpublished":
        this.errors.push("The SFU lost the tab's voice");
        return;
      case "error":
        this.errors.push(frame.message);
        return;
    }
  }
}
