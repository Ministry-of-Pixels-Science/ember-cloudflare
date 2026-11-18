import { CloseCode, type RoomId, type User, type UserId } from "@ember/protocol";
import {
  CAMERA_SIZES,
  CAMERAS_FULL,
  CAMERAS_OFF,
  carriesBothSizes,
  HUDDLE_FAILED,
  HUDDLE_TRACK_KINDS,
  HuddleCloseCode,
  INVITED_TOO_OFTEN,
  MAX_HUDDLE_CAMERAS,
  MAX_HUDDLE_PEOPLE,
  MAX_HUDDLE_SCREENS,
  NOBODY_INVITED,
  parseHuddleClientFrame,
  SCREENS_FULL,
  SCREENS_OFF,
  type CameraSize,
  type HuddleClientFrame,
  type HuddleIceServer,
  type HuddlePerson,
  type HuddleServerFrame,
  type HuddleSticker,
  type HuddleTrack,
  type HuddleTrackKind,
} from "@ember/protocol/huddles";
import type { Env } from "../env";
import { sortableId } from "../ids";
import { CLOSE_REASONS, closedAtOnce, isTooLarge, MAX_ROOM_FRAME_SIZE, TOO_LARGE } from "../sockets";
import { workspace } from "../workspace";
import type { InvitationPush } from "../workspace-store";
import type { HuddleNow, ResumedHuddle } from "./message";
import { relayServers } from "./relay";
import { acceptAnswer, closeTracks, publishTracks, pullTracks, resizeTracks, SfuError, startSession, TRACKS_PER_REQUEST, type HuddleApp, type Pulled, type SfuApp } from "./sfu";

// A room's huddle, which the room's Durable Object keeps beside its own sockets (src/chat-room.ts): who's
// in it, and what each of them publishes and receives at Cloudflare's Realtime SFU, which carries what
// they say and show (./sfu.ts). Each tab in a huddle has a socket of its own here, tagged `HUDDLE_TAG`,
// which the room's revocations close as they close the room's own, and which doesn't count as viewing
// the room.
//
// A tab keeps two connections to the SFU for the voices, each a session there: one it sends its
// microphone on, and one it receives everyone else on. Cameras go on two more like them, which a tab has
// only while it shows its own or watches the others', so nothing about a camera changes a session a
// voice is on, and the screens people share go on two more again. Only the room asks the SFU for
// anything, as the tab's frames have it do, and no session's ID reaches a tab or is taken from one,
// since the ID is all it takes to receive what a session publishes. A tab asks to hear whoever it
// doesn't hear yet (`huddle.listen`), rather than the room adding each newcomer to everyone's
// connection: an event then asks the SFU a few things however many are in the huddle, where Workers'
// free plan lets an event make 50 requests. It asks for cameras and screens by whose they are, and
// only while it shows the huddle open, so what nobody looks at isn't sent. A camera whose browser
// sends it in two sizes at once (simulcast) is sent to each tab in the one that tab says it shows
// cameras in, so that small tiles cost a small picture.
//
// A network that blocks the way to the SFU is gone around by Cloudflare's TURN service, where an
// administrator has given huddles a relay (./relay.ts): the room asks Cloudflare, as a tab joins, for
// the servers its connections go by, and welcomes the tab with them.
//
// What a socket publishes and hears is in its attachment, which outlives hibernation, so a huddle costs
// the room nothing between its frames but a check every `HUDDLE_CHECK_MS`. When someone leaves, or loses
// the room, the room has the SFU close their tracks: a tab that kept its connections open sends the
// others nothing more, and hears nothing more of them.
//
// The room tells the Workspace who's in the huddle as they join and leave, and the Workspace tells
// everyone in the room, in the huddle or not, so their sidebars and the room's header can show it.
// Someone in the huddle invites others into it through the Workspace too (`huddle.invite`), which
// knows who's in the room, and has every tab of theirs. Whoever it finds with Ember in view nowhere is
// pushed the invitation, which the room sends, as it sends its messages' pushes.
//
// The sticker someone shows is in their socket's attachment, as whether they're muted is, and the
// others hear of it as of that. A reaction is kept nowhere: the room tells everyone in the huddle of
// it as it comes, and it's gone.
//
// The room keeps a message of each huddle among its own (./message.ts), which it brings in step as
// people join and leave: the huddle tells it that they have, and what it is now. The huddle gives the
// message its id as it starts, and tells it to everyone it welcomes, whose tabs show the message's
// thread as the huddle's.

/**
 * The tag on a huddle's sockets, besides the tags a room's own sockets carry. Nobody's id has a colon in
 * it, and a session's tag and an address's end in more than one.
 */
export const HUDDLE_TAG = "huddle:";

/** How often a room checks its huddle while one goes on. */
export const HUDDLE_CHECK_MS = 30_000;

/**
 * How long a huddle's socket can go unheard before the room takes its person out. A tab pings every 25
 * seconds, and a browser can hold a hidden tab's timers back to one a minute, so only a connection that
 * dropped without closing goes this long.
 */
export const HUDDLE_SILENT_MS = 90_000;

/** How long the room goes by what the Workspace last said of the SFU app huddles run through, and of huddles in the room. */
export const APP_KEPT_MS = 30_000;

/** How many of a socket's frames for one of its connections can wait behind the one the SFU is answering. */
const FRAMES_WAITING = 4;

/** How often a tab may invite people into the huddle in a minute: each time has the Workspace read who of them is in the room. */
export const INVITES_A_MINUTE = 20;
const MINUTE_MS = 60_000;

/** How many of a tab's reactions the room tells the huddle of in ten seconds: everyone in it hears of each. */
export const REACTIONS_IN_TEN_SECONDS = 20;
const TEN_SECONDS_MS = 10_000;

/**
 * The most people one check takes out for being unheard. The SFU is asked about each of them once for
 * every connection their tab had: five at most, and six for the two who may be sharing their screens.
 * So these, the sessions asked about again and what's taken down fit the 50 requests an event may make.
 */
const REMOVED_PER_CHECK = 6;

/** The most cameras and screens one check takes down once an administrator has them off, each of which the SFU is asked about once. */
const TAKEN_DOWN_PER_CHECK = 8;

/** The most sessions one check asks the SFU again to close tracks on. */
const RETRIED_PER_CHECK = 10;

/** How long the room goes on asking the SFU to close tracks it didn't, and how many sessions' worth it keeps. */
const UNCLOSED_KEPT_MS = 60 * 60 * 1000;
const UNCLOSED_KEPT = 200;

/**
 * The most sessions a deleted room has the SFU close what was published on as it's deleted, which is as
 * many requests as an event may make. The rest wait for its alarm.
 */
const SILENCED_PER_DELETE = 50;

/**
 * The most sessions a check has the SFU close what was published on as it ends a huddle that its room's
 * settings no longer allow: with the sessions the check asks about again, as many requests as an event
 * may make. The rest wait for the checks after it.
 */
const SILENCED_PER_CHECK = SILENCED_PER_DELETE - RETRIED_PER_CHECK;

/** What the room's object keeps in its own storage while the SFU has tracks to close that it didn't: the sessions and their tracks. */
const UNCLOSED = "huddleUnclosed";

/**
 * What the room's object keeps in its own storage from before the Workspace hears of a huddle until it
 * has heard that the huddle is over: the room's id, which is otherwise only in its sockets' attachments,
 * so that the alarm can say so with nobody left in it.
 */
const REPORTED = "huddleRoom";

/**
 * How long after a tab's sending connection connects the SFU may take to find what it publishes. One it
 * can't find after that is gone, and the tab is told to publish again.
 */
export const PUBLICATION_SETTLES_MS = 10_000;

/** What the SFU answers of a track nobody publishes, or no longer does. */
const NOT_PUBLISHED = "not_found_track_error";

/** What a tab hears when it answers an offer it wasn't made. */
export const NO_OFFER = "There's no offer to answer.";
/** What a tab hears when it sends frames faster than the SFU answers them. */
export const TOO_FAST = "The huddle is still on what you asked before.";
const UNRECOGNIZED = "Unrecognized frame";

/** A connection of a tab's at the SFU, and the media sections of it that carry tracks. */
interface Session {
  sessionId: string;
  mids: string[];
}

/** Tracks the SFU was asked to close and didn't, for the room's alarm to ask about again. */
interface Unclosed extends Session {
  appId: string;
  /** When the room first asked. */
  since: number;
}

/** What a tab publishes on one of its sending connections: its microphone, its camera, or the screen its person shares. */
interface Publishing {
  sessionId: string;
  tracks: HuddleTrack[];
  /** When the tab said the connection had connected, from when the others can listen to it. */
  connectedAt?: number;
  /** Whether it's a camera the SFU takes in both of a camera's sizes, as the tab's offer and the SFU's answer to it both said. */
  sized?: true;
}

/** A track a tab hears, or has been offered. */
interface Heard {
  /** The media section of the tab's receiving connection that carries it. */
  mid: string;
  /** The session that publishes it. */
  from: string;
  kind: HuddleTrackKind;
  /** The size the SFU was last asked to send, of a camera it takes in both. */
  size?: CameraSize;
}

/** A track a tab doesn't hear yet, as the SFU is asked for it. */
type Wanted = Omit<Heard, "mid">;

/** What a tab hears, or watches, on one of its receiving connections. */
interface Receiving {
  sessionId: string;
  heard: Heard[];
  /** What the SFU's latest offer adds, until the tab has answered it: nothing, where the offer is of a change of sizes. */
  offered?: Heard[];
  /** Set once the SFU has refused to send a camera in the size asked for, or to make one larger: it's asked for none on this connection from then on, and sends what it chooses. */
  unsized?: true;
}

/** What someone publishes on one of their sending connections, as a tab that would receive it is told of it. */
interface Publication {
  userId: UserId;
  tracks: HuddleTrack[];
  sized: boolean;
}

/** A tab's pair of connections for one kind of track: the one it sends on, and the one it receives on. */
interface Connections {
  publishing?: Publishing;
  receiving?: Receiving;
}

/** How often a tab has done something in a stretch of time, which started at `since`. */
interface Tally {
  since: number;
  count: number;
}

/** `tally` with one more counted at `now`, in a stretch `ms` long that takes `most`, or null once the stretch has had that many. */
function oneMore(tally: Tally | undefined, now: number, ms: number, most: number): Tally | null {
  const stretch = tally && now - tally.since < ms ? tally : { since: now, count: 0 };
  return stretch.count < most ? { since: stretch.since, count: stretch.count + 1 } : null;
}

/** What each of a huddle's sockets remembers across hibernation. */
export interface HuddleAttachment {
  /** Tells a huddle's socket from one of the room's own. */
  huddle: true;
  user: User;
  roomId: RoomId;
  /** When the person joined the huddle, which a tab they move to keeps. */
  joinedAt: number;
  /** When this socket opened. */
  openedAt: number;
  /** When the huddle started. */
  startedAt: string;
  /** The id of the room's message of the huddle. A socket from before huddles named their messages has none, nor does one that joined a huddle of such sockets. */
  messageId?: string;
  muted: boolean;
  /** The sticker the person shows, while they show one. A tab they move to starts with none. */
  sticker?: HuddleSticker;
  /** The SFU app the tab's connections are with: a huddle runs through one. */
  appId: string;
  /** The pair that carries the voices: the tab's microphone, and everyone else's. */
  publishing?: Publishing;
  receiving?: Receiving;
  /** The pair that carries the cameras, once the tab has shown its own or watched another's. A socket from before there were cameras has none. */
  cameras?: Connections;
  /** The pair that carries the screens people share, once the tab has shared its own or watched another's. */
  screens?: Connections;
  /** How often the tab has invited people into the huddle in the minute that started at `since`, once it has. */
  inviting?: Tally;
  /** Set once the tab has invited someone who isn't in the huddle into it. */
  invited?: true;
  /** How many reactions of the tab's the room has told the huddle of in the ten seconds that started at `since`, once it has told of one. */
  reacting?: Tally;
  /** Set once the room has closed the socket itself, having told the others whatever they're to hear of it. */
  revoked?: true;
}

/** A socket in the huddle, with what it remembers. */
interface Member {
  socket: WebSocket;
  attachment: HuddleAttachment;
}

/** What a socket's frames for one of its connections wait behind, and how many of them are waiting, the one the SFU is answering included. */
interface Line {
  last: Promise<void>;
  waiting: number;
}

const attachmentOf = (ws: WebSocket) => ws.deserializeAttachment() as HuddleAttachment;

/** Changes what `ws` remembers, from what it remembers now, so nothing read before an await is written back. */
function change(ws: WebSocket, changed: (attachment: HuddleAttachment) => HuddleAttachment): HuddleAttachment {
  const attachment = changed(attachmentOf(ws));
  ws.serializeAttachment(attachment);
  return attachment;
}

/** A tab's pair of connections for `kind`, as its socket remembers them. */
function connectionsOf(attachment: HuddleAttachment, kind: HuddleTrackKind): Connections {
  if (kind === "audio") return attachment;
  return (kind === "video" ? attachment.cameras : attachment.screens) ?? {};
}

/** `attachment` with its tab's pair of connections for `kind` as `connections` has them. */
function withConnections(attachment: HuddleAttachment, kind: HuddleTrackKind, { publishing, receiving }: Connections): HuddleAttachment {
  const connections = { ...(publishing && { publishing }), ...(receiving && { receiving }) };
  if (kind === "video") return { ...attachment, cameras: connections };
  if (kind === "screen") return { ...attachment, screens: connections };
  const { publishing: _, receiving: __, ...rest } = attachment;
  return { ...rest, ...connections };
}

/** Changes what `ws` remembers of its tab's pair of connections for `kind`, from what it remembers now. */
const changeConnections = (ws: WebSocket, kind: HuddleTrackKind, changed: (connections: Connections) => Connections): HuddleAttachment =>
  change(ws, (attachment) => withConnections(attachment, kind, changed(connectionsOf(attachment, kind))));

/** Whether the others can receive what a tab publishes: its sending connection has connected. */
const isConnected = (publishing: Publishing | undefined) => publishing?.connectedAt !== undefined;

const personOf = ({ user, muted, sticker, publishing, cameras, screens }: HuddleAttachment): HuddlePerson => ({
  user,
  muted,
  audio: isConnected(publishing),
  video: isConnected(cameras?.publishing),
  screen: isConnected(screens?.publishing),
  ...(sticker && { sticker }),
});

const midsOf = (tracks: Array<{ mid: string }>) => tracks.map(({ mid }) => mid);

/** What a huddle shows of people: their cameras, and the screens they share. */
type ShownKind = Exclude<HuddleTrackKind, "audio">;

/** Those kinds, the screens first, of which a huddle shows fewest. */
const SHOWN_KINDS: readonly ShownKind[] = ["screen", "video"];

/**
 * What the room goes by for each: whether an administrator has it off in the huddles `app` runs, how
 * many of it a huddle shows at once, and what a tab is told when the room won't show its own, with them
 * off or with that many on. A Workspace from before one could be turned off says nothing of it.
 */
const SHOWN: Record<ShownKind, { isOff: (app: HuddleApp) => boolean; most: number; off: string; full: string }> = {
  video: { isOff: (app) => app.cameras === false, most: MAX_HUDDLE_CAMERAS, off: CAMERAS_OFF, full: CAMERAS_FULL },
  screen: { isOff: (app) => app.screens === false, most: MAX_HUDDLE_SCREENS, off: SCREENS_OFF, full: SCREENS_FULL },
};

/** Tells a tab that the room won't publish its `kind`, however often it's asked, and why. */
const refuse = (ws: WebSocket, kind: HuddleTrackKind, message: string) => send(ws, { type: "error", message, failed: "huddle.publish", kind, refused: true });

/** Every track of a pair of connections that the SFU carries: what the tab publishes, and what it receives or has been offered. */
function sessionsOf({ publishing, receiving }: Connections): Session[] {
  const sessions: Session[] = [];
  if (publishing) sessions.push({ sessionId: publishing.sessionId, mids: midsOf(publishing.tracks) });
  if (receiving) sessions.push({ sessionId: receiving.sessionId, mids: midsOf([...receiving.heard, ...(receiving.offered ?? [])]) });
  return sessions.filter(({ mids }) => mids.length > 0);
}

/** Every track of a tab's that the SFU carries, on all its connections. */
const allSessionsOf = (attachment: HuddleAttachment): Session[] => HUDDLE_TRACK_KINDS.flatMap((kind) => sessionsOf(connectionsOf(attachment, kind)));

/** What each socket's frames for its connections of one sort wait behind, by the kind of track the connection carries. */
type Lines = Record<HuddleTrackKind, WeakMap<WebSocket, Line>>;

const noLines = (): Lines => ({ audio: new WeakMap(), video: new WeakMap(), screen: new WeakMap() });

function send(ws: WebSocket, frame: HuddleServerFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // The socket closed between lookup and send; its close handler cleans up.
  }
}

/** What's logged of a failure: the SFU's status and error code, or the kind of error, and never what was sent. */
const logged = (error: unknown) => (error instanceof SfuError ? error.message : error instanceof Error ? error.name : "unknown error");

/**
 * Whether the SFU answered that it didn't do what it was asked, by its status or by an error code in
 * place of its answer. Not when it didn't answer, or answered what the room can't read: the room can't
 * tell what it did then.
 */
const isRefusal = (error: unknown): error is SfuError => error instanceof SfuError && error.status !== null && (error.status >= 400 || error.code !== null);

export class Huddle {
  /**
   * The SFU app huddles run through, and whether cameras may go on in them and screens be shared, as the
   * Workspace last said, and when it did, with whether the room's settings allow huddles in it, if that
   * was asked too.
   */
  private known: { app: HuddleApp | null; allowed?: boolean; at: number } | null = null;
  /** What each socket's frames for its sending connections wait behind, and those for its receiving connections. */
  private readonly sending = noLines();
  private readonly receiving = noLines();
  /** The tracks the SFU didn't close, once read from the object's storage. */
  private kept: Promise<Unclosed[]> | null = null;
  /** The room whose huddle the Workspace has heard of, and not yet the end of, once read from the object's storage. */
  private reported: Promise<RoomId | undefined> | null = null;
  /** The reports to the Workspace that are on their way, and whether who's in the huddle may have changed since the latest was made. */
  private reporting: Promise<boolean> | null = null;
  private unreported = false;
  /** The time the room gave its latest report, which the next is later than. */
  private reportedAt = 0;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    /** Sets the room's alarm to check the huddle by a time, unless it's set for sooner, once the room's events before it are done. */
    private readonly wakeBy: (time: number) => Promise<void>,
    /** Sends an invitation's pushes, as the room sends its messages'. */
    private readonly push: (pushes: InvitationPush[]) => Promise<void>,
    /**
     * Brings the room's message of the huddle in step with `now`, the huddle as a change of who's in it
     * left it, once the room's events before it are done: whoever leaves again before then was in it.
     */
    private readonly changed: (now: HuddleNow | null) => Promise<unknown>,
  ) {}

  /** Whether `ws` is one of the huddle's sockets, rather than one of the room's own. */
  has(ws: WebSocket): boolean {
    return (ws.deserializeAttachment() as Partial<HuddleAttachment> | null)?.huddle === true;
  }

  /** Whether anyone is in the huddle. */
  get live(): boolean {
    return this.ctx.getWebSockets(HUDDLE_TAG).some((socket) => socket.readyState === WebSocket.OPEN);
  }

  /** The huddle as it is now, which the room's message of it goes by, or null with nobody in it. */
  now(): HuddleNow | null {
    const members = this.members();
    const first = members[0]?.attachment;
    if (!first) return null;
    const { roomId, startedAt, messageId } = first;
    const invited = members.some(({ attachment }) => attachment.invited === true);
    return { roomId, startedAt, people: members.map(({ attachment }) => attachment.user), ...(messageId !== undefined && { messageId }), ...(invited && { invited }) };
  }

  /**
   * Lets `user` into room `roomId`'s huddle, on a socket carrying `tags`, once the room has checked the
   * Workspace's word for them. A huddle that's full, or huddles being off, for everyone or in the
   * room's settings, closes the socket at once with the code that says so. Someone already in the
   * huddle moves to this tab: their other socket closes, and the others hear that they changed rather
   * than that they left and joined. The room, which lets people in one at a time, sets its alarm to
   * check the huddle once someone's in it. The tab is welcomed with `iceServers`, the servers its
   * connections go by, if the room has any for it. Whoever joins with nobody in the huddle starts one,
   * whose message gets its id here, unless `resumed` is the room's last, which then goes on
   * (./message.ts).
   */
  async join(user: User, roomId: RoomId, tags: string[], muted: boolean, iceServers: HuddleIceServer[] | null, resumed?: ResumedHuddle): Promise<Response> {
    const app = await this.appIn(roomId);
    if (!app) return closedAtOnce(HuddleCloseCode.Off);
    let members = this.members();
    // Whoever joined through an app huddles no longer run through connects again, through this one, to
    // the huddle as it goes on with whoever is first. Nothing is told of their going: the Workspace and
    // the room's message of the huddle hear how this join leaves it, which is going on.
    if (members.some(({ attachment }) => attachment.appId !== app.appId)) {
      for (const { socket } of members) this.close(socket, CloseCode.Reconnect, false);
      members = [];
    }
    const { startedAt, messageId } = members[0]?.attachment ?? resumed ?? { startedAt: new Date().toISOString(), messageId: sortableId() };
    const itsMessage = messageId !== undefined && { messageId };
    const earlier = members.filter(({ attachment }) => attachment.user.id === user.id);
    if (members.length - earlier.length >= MAX_HUDDLE_PEOPLE) return closedAtOnce(HuddleCloseCode.Full);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [...tags, HUDDLE_TAG]);
    const now = Date.now();
    const attachment: HuddleAttachment = { huddle: true, user, roomId, joinedAt: earlier[0]?.attachment.joinedAt ?? now, openedAt: now, startedAt, ...itsMessage, muted, appId: app.appId };
    server.serializeAttachment(attachment);
    for (const { socket } of earlier) this.close(socket, HuddleCloseCode.Moved);
    send(server, { type: "huddle.welcome", you: user, people: this.people(), startedAt, ...itsMessage, ...(iceServers && { iceServers }) });
    this.broadcast({ type: earlier.length > 0 ? "huddle.changed" : "huddle.joined", person: personOf(attachment) }, server);
    if (earlier.length === 0) this.reportSoon();
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * The servers a tab that joins room `roomId`'s huddle now makes its connections by, while huddles
   * have a relay: what Cloudflare answers the room with for the tab, or null without a relay, or when
   * the room can't say. The tab is let in either way. The Workspace is asked afresh, so a relay set up
   * a moment ago is the next tab's to use, and the join that follows goes by what the room's settings
   * say of huddles now.
   */
  async iceServers(roomId: RoomId): Promise<HuddleIceServer[] | null> {
    const app = await this.appIn(roomId, true).catch(() => null);
    return app?.relay ? relayServers(this.env, app.relay) : null;
  }

  /** Does what a frame from one of the huddle's sockets asks. */
  async message(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // A socket the room has closed, as when its person lost the room, can't change anything, even with
    // frames it sent before it heard.
    if (ws.readyState !== WebSocket.OPEN) return;
    // A session description is the largest thing a tab sends, and fits a room's largest frame twice over.
    // Whoever sends more leaves the huddle as the room closes their socket, rather than when their tab
    // answers the close, which it may never do.
    if (isTooLarge(raw, MAX_ROOM_FRAME_SIZE)) return this.remove(ws, TOO_LARGE);
    const frame = typeof raw === "string" ? parseHuddleClientFrame(raw) : null;
    if (!frame) return send(ws, { type: "error", message: UNRECOGNIZED });
    switch (frame.type) {
      case "ping":
        return send(ws, { type: "pong" });
      case "huddle.mute":
        return this.mute(ws, frame.muted);
      case "huddle.publish": {
        const [track] = frame.tracks;
        return this.inTurn(this.sending, track.kind, ws, frame.type, () => this.publish(ws, frame.sdp, track));
      }
      case "huddle.connected":
        // In its turn, so that it's about the connection the tab last published from.
        return this.inTurn(this.sending, frame.kind, ws, frame.type, async () => this.connected(ws, frame.kind));
      case "huddle.unpublish":
        return this.inTurn(this.sending, frame.kind, ws, frame.type, async () => this.unpublish(ws, frame.kind));
      case "huddle.listen":
        // Voices aren't asked for by name: a tab hears everyone.
        return this.inTurn(this.receiving, frame.kind, ws, frame.type, () => this.listen(ws, frame.kind, frame.fresh === true, frame.kind === "audio" ? null : (frame.watch ?? []), frame.small === true));
      case "huddle.answer":
        return this.inTurn(this.receiving, frame.kind, ws, frame.type, () => this.answer(ws, frame.kind, frame.sdp));
      case "huddle.invite":
        return this.invite(ws, frame.userIds);
      case "huddle.sticker":
        return this.showSticker(ws, frame.sticker);
      case "huddle.react":
        return this.react(ws, frame.emoji);
    }
  }

  /** Tells the others that `ws`'s person left, as its tab closed it or its connection dropped, and has the SFU close their tracks. */
  left(ws: WebSocket): void {
    const attachment = attachmentOf(ws);
    if (attachment.revoked) return;
    this.broadcast({ type: "huddle.left", userId: attachment.user.id }, ws);
    this.ctx.waitUntil(this.cutOff(ws, attachment));
    this.reportSoon();
  }

  /** Takes `socket`'s person out of the huddle: closes it with `code`, tells the others they left, and has the SFU close their tracks. */
  remove(socket: WebSocket, code: CloseCode | HuddleCloseCode | typeof TOO_LARGE): void {
    const attachment = this.close(socket, code);
    if (!attachment) return;
    this.broadcast({ type: "huddle.left", userId: attachment.user.id });
    this.reportSoon();
  }

  /**
   * Ends the huddle for everyone in it, closing their sockets with `code`. Nobody is left to hear who
   * went, and every tab closes its own connections as its socket closes. Unless `silence` says to, the
   * SFU is asked nothing: with huddles off or their app changed there's no asking it as the app those
   * connections are with. A room that's deleted can ask, and has it close what everyone published, so
   * that a tab which kept its connections open is heard by nobody, and hears nobody. So can the check
   * of a huddle that only its room's settings end (`check`), which asks about `most` of it at once.
   * It's what each had published as their socket closed that the SFU closes, so a tab that published
   * while the room was finding out that the huddle ends is no exception.
   */
  end(code: CloseCode | HuddleCloseCode, silence = false, most = SILENCED_PER_DELETE): void {
    const members = this.members();
    if (members.length === 0) return;
    for (const { socket } of members) this.close(socket, code, false);
    if (silence) this.ctx.waitUntil(this.silence(members, most));
    this.reportSoon();
  }

  /**
   * Has the SFU close what each of `members` published, as it was when their sockets closed. That's a
   * request for each microphone, each camera and each screen, the microphones first, and `most` of them
   * now. A deleted room's are as many as the 50 an event may make on Workers' free plan: a full huddle's
   * microphones fit, which closing what each heard as well wouldn't, and it's all it takes for nobody
   * to hear anything. The cameras and screens that don't fit, and whatever the SFU didn't close, are
   * kept for the room's alarm, which asks about them (`closeUnclosed`), a deleted room's before it
   * erases the room.
   */
  private async silence(members: Member[], most: number): Promise<void> {
    const app = await this.appNow().catch(() => undefined);
    if (!app) return;
    const published = HUDDLE_TRACK_KINDS.flatMap((kind) =>
      members.flatMap(({ socket, attachment }) => (attachment.appId === app.appId ? sessionsOf({ publishing: connectionsOf(attachment, kind).publishing }).map((session) => ({ socket, kind, session })) : [])),
    );
    const unclosed = published.slice(most).map(({ session }) => session);
    for (const { socket, kind, session } of published.slice(0, most)) {
      // A tab publishing as its socket closed has what that made closed by the frame that made it.
      await this.sending[kind].get(socket)?.last;
      const mids = await this.closeOn(app, session);
      if (mids.length > 0) unclosed.push({ sessionId: session.sessionId, mids });
    }
    await this.keep(app.appId, unclosed);
  }

  /**
   * Checks the huddle, as the room's alarm has it do every `HUDDLE_CHECK_MS` while one goes on: ends it
   * once huddles are off, for everyone or in the room's settings, or run through another app, takes
   * out whoever's socket has gone unheard, tells the Workspace who's in it again, which is what makes
   * up for a report that failed, and asks the SFU again to close the tracks it didn't. A huddle the
   * room's settings end has the SFU close what everyone in it published, as a deleted room's does.
   * Answers when to check next, or null once there's nobody in the huddle, the Workspace has heard so,
   * and nothing is left to close.
   */
  async check(now = Date.now()): Promise<number | null> {
    const members = this.members();
    if (members.length > 0) {
      // Asked afresh, so turning huddles off, for everyone or in this room, ends one within a check. Unanswered, the huddle goes on.
      const app = await this.appIn(members[0]!.attachment.roomId, true).catch(() => undefined);
      if (app === null || (app && members.some(({ attachment }) => attachment.appId !== app.appId))) {
        // Where only the room's settings end it, huddles still run through the app, which the SFU is asked as.
        this.end(app ? CloseCode.Reconnect : HuddleCloseCode.Off, !app, SILENCED_PER_CHECK);
      } else {
        for (const { socket } of members.filter((member) => this.isSilent(member, now)).slice(0, REMOVED_PER_CHECK)) this.remove(socket, CloseCode.Reconnect);
        if (app) this.takeDownWhatsOff(app);
      }
    }
    const reported = await this.report();
    const unclosed = await this.closeUnclosed(now);
    return this.live || unclosed || !reported ? now + HUDDLE_CHECK_MS : null;
  }

  /** Whether the room last heard from a socket, as it opened or as the runtime answered its ping, longer ago than a live tab leaves it. */
  private isSilent({ socket, attachment }: Member, now: number): boolean {
    return now - Math.max(attachment.openedAt, this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0) > HUDDLE_SILENT_MS;
  }

  /**
   * Runs what a frame asks of the SFU once the socket's frames before it, for the same connection of
   * its tab's, have had their answers: the SFU takes one change to a session at a time, and each
   * change here reads what the last one left. A socket's connections don't wait on each other, nor
   * do other sockets. Whatever fails, the tab hears that its frame did, and for which pair of them.
   */
  private inTurn(lines: Lines, kind: HuddleTrackKind, ws: WebSocket, type: HuddleClientFrame["type"], work: () => Promise<void>): Promise<void> {
    const line = lines[kind].get(ws) ?? { last: Promise.resolve(), waiting: 0 };
    lines[kind].set(ws, line);
    if (line.waiting > FRAMES_WAITING) return Promise.resolve(send(ws, { type: "error", message: TOO_FAST }));
    line.waiting++;
    line.last = line.last.then(async () => {
      try {
        if (ws.readyState === WebSocket.OPEN) await work();
      } catch (error) {
        console.warn(`A huddle's ${type} failed:`, logged(error));
        send(ws, { type: "error", message: HUDDLE_FAILED, failed: type, kind });
      } finally {
        line.waiting--;
      }
    });
    return line.last;
  }

  private mute(ws: WebSocket, muted: boolean): void {
    if (attachmentOf(ws).muted === muted) return;
    this.broadcast({ type: "huddle.changed", person: personOf(change(ws, (attachment) => ({ ...attachment, muted }))) }, ws);
  }

  /** Tells the others that `ws`'s person shows `sticker` now, in place of any they showed, or with null, none. */
  private showSticker(ws: WebSocket, sticker: HuddleSticker | null): void {
    if ((attachmentOf(ws).sticker ?? null) === sticker) return;
    this.broadcast({ type: "huddle.changed", person: personOf(change(ws, ({ sticker: _, ...attachment }) => ({ ...attachment, ...(sticker && { sticker }) }))) }, ws);
  }

  /**
   * Tells everyone in the huddle that `ws`'s person reacted with `emoji`, their own tab included, which
   * shows it as the others do. Past as many as the room tells of in ten seconds, a tab's reactions go
   * unheard, by its own person too.
   */
  private react(ws: WebSocket, emoji: string): void {
    const reacting = oneMore(attachmentOf(ws).reacting, Date.now(), TEN_SECONDS_MS, REACTIONS_IN_TEN_SECONDS);
    if (!reacting) return;
    const { user } = change(ws, (attachment) => ({ ...attachment, reacting }));
    this.broadcast({ type: "huddle.reacted", userId: user.id, emoji });
  }

  /**
   * Invites into the huddle the people `ws`'s person names, but for whoever is in it already: the
   * Workspace tells those of them who are in the room, on every tab they have open, and the room pushes
   * the invitation to whoever the Workspace finds with Ember in view nowhere, without the tab waiting
   * on it. A tab that has invited people as often as one may in a minute hears that nobody more is, and
   * so does one whose invitation the Workspace couldn't be given. The room's message of the huddle is
   * theirs to come back to, should they not join, so the room keeps that someone was invited before
   * anyone is, and whoever invites them can leave at once (./message.ts).
   */
  private async invite(ws: WebSocket, userIds: UserId[]): Promise<void> {
    const inviting = oneMore(attachmentOf(ws).inviting, Date.now(), MINUTE_MS, INVITES_A_MINUTE);
    if (!inviting) return send(ws, { type: "error", message: INVITED_TOO_OFTEN, failed: "huddle.invite" });
    const { user, roomId } = change(ws, (attachment) => ({ ...attachment, inviting }));
    const inIt = new Set(this.members().map(({ attachment }) => attachment.user.id));
    const invited = userIds.filter((userId) => !inIt.has(userId));
    if (invited.length === 0) return;
    change(ws, (attachment) => ({ ...attachment, invited: true }));
    this.ctx.waitUntil(this.changed(this.now()));
    try {
      const pushes = await workspace(this.env).inviteToHuddle(roomId, user.id, invited);
      // A Workspace still on the code from before it answered pushes, as it may be for some minutes after an update, answers nothing.
      if (pushes?.length > 0) this.ctx.waitUntil(this.push(pushes));
    } catch (error) {
      console.warn("Inviting people into a huddle failed:", logged(error));
      send(ws, { type: "error", message: NOBODY_INVITED, failed: "huddle.invite" });
    }
  }

  /**
   * Publishes a tab's track on a new session, with the offer its sending connection made for it, and
   * sends it the SFU's answer. The track goes by its kind, which is how the others' sessions ask for
   * it. What the tab published of that kind before, on a connection it has given up, is closed. A
   * camera or a screen is refused while an administrator has them off, or past as many as a huddle
   * shows, which its tab hears. A camera is sent in sizes only where the offer says the tab sends both
   * and the answer that the SFU takes both: a browser sends one size to an SFU that takes one.
   */
  private async publish(ws: WebSocket, offer: string, track: HuddleTrack): Promise<void> {
    const { kind } = track;
    const app = await this.appOf(ws);
    if (!app) return;
    const refused = this.refusalOf(ws, kind, app);
    if (refused) return refuse(ws, kind, refused);
    const sessionId = await startSession(this.env, app);
    const answer = await publishTracks(this.env, app, sessionId, offer, [{ mid: track.mid, trackName: kind }]);
    const published = [{ sessionId, mids: [track.mid] }];
    // They left while the SFU answered, so nothing of theirs stays published.
    if (ws.readyState !== WebSocket.OPEN) return this.cut(app.appId, published);
    // The last camera or screen a huddle shows may have gone on while the SFU answered, or a check have heard that they're off.
    const late = this.refusalOf(ws, kind, this.known?.app ?? app);
    if (late) {
      refuse(ws, kind, late);
      return this.cut(app.appId, published);
    }
    const earlier = connectionsOf(attachmentOf(ws), kind).publishing;
    const sized = kind === "video" && carriesBothSizes(offer, track.mid, "send") && carriesBothSizes(answer, track.mid, "recv");
    const attachment = changeConnections(ws, kind, (connections) => ({ ...connections, publishing: { sessionId, tracks: [track], ...(sized && { sized }) } }));
    send(ws, { type: "huddle.published", kind, sdp: answer });
    if (!earlier) return;
    // Nobody can listen to them, or watch them, until the new connection has connected.
    if (isConnected(earlier)) this.broadcast({ type: "huddle.changed", person: personOf(attachment) }, ws);
    this.ctx.waitUntil(this.cut(app.appId, sessionsOf({ publishing: earlier })));
  }

  /**
   * Why the room won't publish a track of `kind` from `ws`'s tab, or null while it will: an
   * administrator has cameras off, or screen sharing, or this would be one more than a huddle shows,
   * counting those the others have published.
   */
  private refusalOf(ws: WebSocket, kind: HuddleTrackKind, app: HuddleApp): string | null {
    if (kind === "audio") return null;
    const { isOff, most, off, full } = SHOWN[kind];
    if (isOff(app)) return off;
    return this.showing(kind).filter(({ socket }) => socket !== ws).length >= most ? full : null;
  }

  /** Whoever has their camera on, or shares their screen, as `kind` says, as far as their tab has published it. */
  private showing(kind: ShownKind): Member[] {
    return this.members().filter(({ attachment }) => connectionsOf(attachment, kind).publishing);
  }

  /**
   * Takes down the screens and cameras that are on though an administrator has turned them off, a few
   * a check, as if the room had refused them: each one's tab hears why, and turns its own off. A tab
   * that heard them go off has taken its own down already.
   */
  private takeDownWhatsOff(app: HuddleApp): void {
    const off = SHOWN_KINDS.filter((kind) => SHOWN[kind].isOff(app)).flatMap((kind) => this.showing(kind).map(({ socket }) => ({ socket, kind })));
    for (const { socket, kind } of off.slice(0, TAKEN_DOWN_PER_CHECK)) {
      this.unpublish(socket, kind);
      refuse(socket, kind, SHOWN[kind].off);
    }
  }

  /** Has the others hear that they can listen to `ws`'s person, or watch them, now that the sending connection for `kind` has connected. */
  private connected(ws: WebSocket, kind: HuddleTrackKind): void {
    const { publishing } = connectionsOf(attachmentOf(ws), kind);
    if (!publishing || isConnected(publishing)) return;
    const attachment = changeConnections(ws, kind, (connections) => ({ ...connections, publishing: { ...publishing, connectedAt: Date.now() } }));
    this.broadcast({ type: "huddle.changed", person: personOf(attachment) }, ws);
  }

  /**
   * Takes down what a tab published of `kind`, as when its person turns their camera off or stops
   * sharing their screen: the others hear that they can't watch it, and the SFU closes the track, so
   * that a tab which kept sending shows nobody anything.
   */
  private unpublish(ws: WebSocket, kind: HuddleTrackKind): void {
    const { publishing } = connectionsOf(attachmentOf(ws), kind);
    if (!publishing) return;
    const attachment = changeConnections(ws, kind, ({ publishing: _, ...connections }) => connections);
    if (isConnected(publishing)) this.broadcast({ type: "huddle.changed", person: personOf(attachment) }, ws);
    this.ctx.waitUntil(this.cut(attachment.appId, sessionsOf({ publishing })));
  }

  /**
   * Has the SFU offer a tab everyone it can listen to and doesn't hear yet, on its receiving
   * connection's session, which is started for the first of them, and sends the tab the offer to
   * answer. For cameras and screens, that's the people `only` names, whom the tab watches. With nobody
   * new, or nobody the SFU can offer yet, the tab hears that it's listening to whoever it was offered.
   * Tracks it heard of people who've left, or who publish anew, are closed first, as are the cameras
   * and screens of people it no longer asks for. Someone can leave or publish anew while the SFU makes
   * the offer, too, and the offer then names nobody for the track it carries of them, which is of what
   * they published before: named, the tab would take it for what they publish now, and never ask for
   * that. Should the SFU refuse, the room lets go of the connection, since it can't tell what the
   * session then carries.
   *
   * Of a camera the SFU takes in both sizes, a tab is sent the smaller while it says it shows cameras
   * `small`, and otherwise the larger: the cameras it's offered now, and those it watches already in
   * the other size, which the SFU is asked to change first. A camera the SFU won't send in a size, or
   * won't make larger, is asked for without one, as is every other on that connection from then on,
   * so that it shows in whatever size the SFU chooses rather than not at all, or small in a large tile.
   * Where the SFU would otherwise offer the tab nothing, it's asked for without one in the same round.
   */
  private async listen(ws: WebSocket, kind: HuddleTrackKind, fresh: boolean, only: UserId[] | null, small: boolean): Promise<void> {
    const app = await this.appOf(ws);
    if (!app) return;
    if (fresh) this.letGo(ws, kind);
    const before = connectionsOf(attachmentOf(ws), kind).receiving;
    // The tab answers the offer it has before it's made another.
    if (before?.offered) return;
    const publications = this.publications(ws, kind, only);
    let heard = (before?.heard ?? []).filter(({ from }) => publications.has(from));
    let unsized = before?.unsized;
    try {
      if (before && heard.length < before.heard.length) {
        const stale = before.heard.filter(({ from }) => !publications.has(from));
        await this.cut(app.appId, [{ sessionId: before.sessionId, mids: midsOf(stale) }]);
        if (ws.readyState !== WebSocket.OPEN) return;
        changeConnections(ws, kind, (connections) => ({ ...connections, receiving: { ...before, heard } }));
      }
      const resized = before ? await this.resized(app, { ...before, heard }, small) : null;
      if (before && resized) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ({ heard, unsized } = resized);
        changeConnections(ws, kind, (connections) => ({ ...connections, receiving: { ...before, heard, ...(unsized && { unsized }), ...(resized.offer !== null && { offered: [] }) } }));
        // The session takes nothing more until the tab has answered, which is when the tab asks again, for anyone new.
        if (resized.offer !== null) return send(ws, { type: "huddle.offer", kind, sdp: resized.offer, tracks: [] });
      }
      const size = unsized ? undefined : CAMERA_SIZES[small ? "small" : "large"];
      const wanted = [...publications].flatMap(([from, { tracks, sized }]) =>
        tracks.filter(({ kind }) => !heard.some((track) => track.from === from && track.kind === kind)).map(({ kind }) => ({ from, kind, ...(sized && size && { size }) })),
      );
      if (wanted.length === 0) return send(ws, { type: "huddle.listening", kind });

      const sessionId = before?.sessionId ?? (await startSession(this.env, app));
      const { asked, pulled, sizeRefused } = await this.pulled(app, sessionId, wanted.slice(0, TRACKS_PER_REQUEST));
      const offered = pulled.tracks.flatMap(({ sessionId: from, trackName, mid }) => asked.filter((track) => track.from === from && track.kind === trackName).map((track) => ({ mid, ...track })));
      // They left while the SFU answered, so it sends them nothing of this.
      if (ws.readyState !== WebSocket.OPEN) return this.cut(app.appId, [{ sessionId, mids: midsOf(offered) }]);
      this.republish(
        kind,
        pulled.missing.filter(({ code }) => code === NOT_PUBLISHED).map(({ sessionId }) => sessionId),
      );
      if (sizeRefused) unsized = true;
      // The session waits for the tab's answer to whatever it offers, even an offer of nobody.
      changeConnections(ws, kind, (connections) => ({ ...connections, receiving: { sessionId, heard, ...(pulled.offer !== null && { offered }), ...(unsized && { unsized }) } }));
      if (pulled.offer === null) return send(ws, { type: "huddle.listening", kind });
      // As the others publish now, which the SFU's answer may have taken long enough to change.
      const current = this.publications(ws, kind, only);
      const tracks = offered.filter(({ from }) => current.has(from)).map(({ mid, from, kind }) => ({ mid, kind, userId: current.get(from)!.userId }));
      send(ws, { type: "huddle.offer", kind, sdp: pulled.offer, tracks });
    } catch (error) {
      this.letGo(ws, kind);
      throw error;
    }
  }

  /**
   * Gives the SFU a tab's answer to the offer it was made, after which the tab receives those the offer
   * added. Should the SFU refuse the answer, the room lets go of the connection.
   */
  private async answer(ws: WebSocket, kind: HuddleTrackKind, sdp: string): Promise<void> {
    const app = await this.appOf(ws);
    if (!app) return;
    const { receiving } = connectionsOf(attachmentOf(ws), kind);
    if (!receiving?.offered) return send(ws, { type: "error", message: NO_OFFER });
    const { offered, ...answered } = receiving;
    try {
      await acceptAnswer(this.env, app, answered.sessionId, sdp);
    } catch (error) {
      this.letGo(ws, kind);
      throw error;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    changeConnections(ws, kind, (connections) => ({ ...connections, receiving: { ...answered, heard: [...answered.heard, ...offered] } }));
    send(ws, { type: "huddle.listening", kind });
  }

  /**
   * Has the SFU send a receiving connection the cameras it hears in the other size than its tab shows
   * them in, `small` or not, in that one from now, and answers what's left of the connection then,
   * with the SFU's offer, should the change take one: null when nothing changed.
   *
   * A camera the SFU won't make smaller stays as large as it was, to be asked for again with the tab's
   * next round. One it won't make larger is closed, and no longer heard, and the connection asks for
   * no sizes from then on, so that the round asks for the camera anew, as the SFU would send it: a tab
   * that shows cameras large isn't left with a small picture of one. The same goes for the small ones
   * on a connection that asks for no sizes already. Nothing else the round does waits on a change.
   */
  private async resized(app: HuddleApp, { sessionId, heard, unsized }: Receiving, small: boolean): Promise<(Pick<Receiving, "heard" | "unsized"> & { offer: string | null }) | null> {
    const size = CAMERA_SIZES[small ? "small" : "large"];
    const outgrown = heard.filter((track) => track.size !== undefined && track.size !== size).slice(0, TRACKS_PER_REQUEST);
    if (outgrown.length === 0) return null;
    const { offer, refused } = unsized ? { offer: null, refused: outgrown } : await this.resizedBySfu(app, sessionId, outgrown, size);
    const leftSmall = small ? [] : refused;
    if (leftSmall.length > 0) await this.cut(app.appId, [{ sessionId, mids: midsOf(leftSmall) }]);
    if (refused.length === outgrown.length && leftSmall.length === 0 && offer === null) return null;
    const changed = (track: Heard) => outgrown.includes(track) && !refused.includes(track);
    return {
      heard: heard.filter((track) => !leftSmall.includes(track)).map((track) => (changed(track) ? { ...track, size } : track)),
      ...((unsized || leftSmall.length > 0) && { unsized: true as const }),
      offer,
    };
  }

  /** Asks the SFU to send a session the cameras `outgrown` in `size`, and answers its offer, should the change take one, and the cameras it left as they were: all of them, where it refused the request. */
  private async resizedBySfu(app: HuddleApp, sessionId: string, outgrown: Heard[], size: CameraSize): Promise<{ offer: string | null; refused: Heard[] }> {
    try {
      const { offer, refused } = await resizeTracks(
        this.env,
        app,
        sessionId,
        outgrown.map(({ mid, from, kind }) => ({ mid, sessionId: from, trackName: kind, rid: size })),
      );
      if (refused[0]) console.warn("The Realtime SFU didn't change the size of a huddle's camera:", refused[0].code);
      return { offer, refused: outgrown.filter(({ mid }) => refused.some((track) => track.mid === mid)) };
    } catch (error) {
      if (!(error instanceof SfuError)) throw error;
      console.warn("Changing the size of a huddle's cameras failed:", logged(error));
      return { offer: null, refused: outgrown };
    }
  }

  /**
   * Pulls the tracks `wanted` into a tab's session, each camera in the size wanted of it, and answers
   * what the SFU made of them, the tracks as it was asked for them, and whether it refused a camera
   * its size. A refusal that leaves the tab without an offer, because the SFU offered nobody else or
   * refused the whole request, has them all asked for again at once, without sizes, and it's that
   * request this answers for: a tab makes its connection of an offer, so with none it would ask again
   * on a fresh one, by size, and never be shown the camera. Whatever the SFU refuses a whole request
   * for counts, since it doesn't say how it would refuse one for its sizes.
   */
  private async pulled(app: HuddleApp, sessionId: string, wanted: Wanted[]): Promise<{ asked: Wanted[]; pulled: Pulled; sizeRefused: boolean }> {
    const pull = (asked: Wanted[]) =>
      pullTracks(
        this.env,
        app,
        sessionId,
        asked.map(({ from, kind, size }) => ({ sessionId: from, trackName: kind, ...(size && { rid: size }) })),
      );
    const pulled = await pull(wanted).catch((error: unknown) => {
      if (!isRefusal(error) || !wanted.some(({ size }) => size)) throw error;
      console.warn("The Realtime SFU didn't take a request for a huddle's cameras in sizes:", logged(error));
      return null;
    });
    const sizeRefused = pulled === null || this.wontSize(pulled.missing);
    if (pulled && (pulled.offer !== null || !sizeRefused)) return { asked: wanted, pulled, sizeRefused };
    const unsized = wanted.map(({ from, kind }) => ({ from, kind }));
    return { asked: unsized, pulled: await pull(unsized), sizeRefused: true };
  }

  /** Whether the SFU found a camera among those it was asked for and didn't offer, and wouldn't send it in the size asked for, which it says once. */
  private wontSize(missing: Array<{ rid?: string; code: string }>): boolean {
    const refused = missing.find(({ rid, code }) => rid !== undefined && code !== NOT_PUBLISHED);
    if (refused) console.warn("The Realtime SFU didn't send a huddle's camera in the size asked for:", refused.code);
    return refused !== undefined;
  }

  /** Forgets `ws`'s receiving connection for `kind`, having the SFU close what it received on it, for its tab to start a fresh one. */
  private letGo(ws: WebSocket, kind: HuddleTrackKind): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const attachment = attachmentOf(ws);
    const { receiving } = connectionsOf(attachment, kind);
    if (!receiving) return;
    changeConnections(ws, kind, ({ receiving: _, ...connections }) => connections);
    this.ctx.waitUntil(this.cut(attachment.appId, sessionsOf({ receiving })));
  }

  /**
   * Has the tabs that publish their `kind` on `sessionIds`, which the SFU no longer finds anything on,
   * publish again, and the others hear that they can't be listened to, or watched, meanwhile. A session
   * that connected a moment ago is left alone: the SFU may not have found it yet.
   */
  private republish(kind: HuddleTrackKind, sessionIds: string[]): void {
    const now = Date.now();
    for (const { socket, attachment } of this.members()) {
      const { publishing } = connectionsOf(attachment, kind);
      if (publishing?.connectedAt === undefined || !sessionIds.includes(publishing.sessionId) || now - publishing.connectedAt < PUBLICATION_SETTLES_MS) continue;
      const { connectedAt: _, ...unconnected } = publishing;
      this.broadcast({ type: "huddle.changed", person: personOf(changeConnections(socket, kind, (connections) => ({ ...connections, publishing: unconnected }))) }, socket);
      send(socket, { type: "huddle.unpublished", kind });
    }
  }

  /**
   * What the others in the huddle publish of `kind` that can be received, by the session each publishes
   * it on, and whether it's a camera the SFU takes in both sizes: everyone's, or with `only`, that of
   * the people it names.
   */
  private publications(except: WebSocket, kind: HuddleTrackKind, only: UserId[] | null): Map<string, Publication> {
    const publications = new Map<string, Publication>();
    for (const { socket, attachment } of this.members()) {
      const { publishing } = connectionsOf(attachment, kind);
      const { id } = attachment.user;
      if (socket !== except && publishing && isConnected(publishing) && (only === null || only.includes(id))) publications.set(publishing.sessionId, { userId: id, tracks: publishing.tracks, sized: publishing.sized === true });
    }
    return publications;
  }

  /**
   * The SFU app `ws`'s huddle runs through, for a frame to ask the SFU as. Once huddles are off, or run
   * through another app than the huddle's, the huddle ends, and this answers null.
   */
  private async appOf(ws: WebSocket): Promise<HuddleApp | null> {
    const app = await this.appNow();
    if (ws.readyState !== WebSocket.OPEN) return null;
    if (app?.appId === attachmentOf(ws).appId) return app;
    this.end(app ? CloseCode.Reconnect : HuddleCloseCode.Off);
    return null;
  }

  /** The SFU app huddles run through, or null while they're off, as the Workspace said within `APP_KEPT_MS`, or says now. */
  private async appNow(): Promise<HuddleApp | null> {
    if (this.known && Date.now() - this.known.at < APP_KEPT_MS) return this.known.app;
    const app = await workspace(this.env).huddleApp();
    this.known = { app, at: Date.now() };
    return app;
  }

  /**
   * The same for a huddle in room `roomId`, as the Workspace said of the room within `APP_KEPT_MS`, or
   * says now: null, too, while the room's settings don't allow huddles in it. The app is known either
   * way, so the room still has the SFU close what a huddle that its settings end leaves open.
   */
  private async appIn(roomId: RoomId, fresh = false): Promise<HuddleApp | null> {
    if (fresh || this.known?.allowed === undefined || Date.now() - this.known.at >= APP_KEPT_MS) this.known = { ...(await workspace(this.env).huddlesIn(roomId)), at: Date.now() };
    return this.known.allowed ? this.known.app : null;
  }

  /**
   * Closes `socket` itself, with `code`, if it's open, and answers what it remembered. Unless `cut` says
   * not to, the SFU closes its tab's tracks.
   */
  private close(socket: WebSocket, code: CloseCode | HuddleCloseCode | typeof TOO_LARGE, cut = true): HuddleAttachment | null {
    if (socket.readyState !== WebSocket.OPEN) return null;
    const attachment = change(socket, (attachment) => ({ ...attachment, revoked: true }));
    socket.close(code, CLOSE_REASONS[code]);
    if (cut) this.ctx.waitUntil(this.cutOff(socket, attachment));
    return attachment;
  }

  /**
   * Has the SFU close everything a closed socket's tab published and received, as `attachment` has it,
   * once the frames the SFU was still answering for it are done: each of those closes what it made
   * itself, on finding the socket closed.
   */
  private async cutOff(socket: WebSocket, attachment: HuddleAttachment): Promise<void> {
    await Promise.all(HUDDLE_TRACK_KINDS.flatMap((kind) => [this.sending[kind].get(socket)?.last, this.receiving[kind].get(socket)?.last]));
    await this.cut(attachment.appId, allSessionsOf(attachment));
  }

  /**
   * Has the SFU close tracks, as the app whose ID is `appId`, and keeps the ones it didn't for the alarm
   * to ask about again. An app Ember no longer has the secret of can't be asked, and no huddle runs
   * through it again.
   */
  private async cut(appId: string, sessions: Session[]): Promise<void> {
    if (sessions.length === 0) return;
    const app = await this.appNow().catch(() => undefined);
    if (app === null || (app && app.appId !== appId)) return;
    const unclosed: Session[] = [];
    for (const session of sessions) {
      const mids = app ? await this.closeOn(app, session) : session.mids;
      if (mids.length > 0) unclosed.push({ sessionId: session.sessionId, mids });
    }
    await this.keep(appId, unclosed);
  }

  /** Has the SFU close `mids` on a session, and answers the ones it didn't. */
  private async closeOn(app: SfuApp, { sessionId, mids }: Session): Promise<string[]> {
    try {
      return await closeTracks(this.env, app, sessionId, mids);
    } catch (error) {
      console.warn("Closing a huddle's tracks failed:", logged(error));
      return mids;
    }
  }

  /** The tracks the SFU was asked to close and didn't. */
  private unclosed(): Promise<Unclosed[]> {
    return (this.kept ??= this.ctx.storage.get<Unclosed[]>(UNCLOSED).then((kept) => kept ?? []));
  }

  /** Whether the SFU has tracks to close still, which the room's alarm comes back to ask it about. */
  async hasUnclosed(): Promise<boolean> {
    return (await this.unclosed()).length > 0;
  }

  /**
   * Keeps the tracks on `sessions`, which the SFU has yet to close as the app whose ID is `appId`, in
   * the object's storage, and has the alarm ask about them again.
   */
  private async keep(appId: string, sessions: Session[]): Promise<void> {
    if (sessions.length === 0) return;
    try {
      const kept = await this.unclosed();
      const since = Date.now();
      kept.push(...sessions.map((session) => ({ appId, ...session, since })));
      if (kept.length > UNCLOSED_KEPT) kept.splice(0, kept.length - UNCLOSED_KEPT);
      await this.ctx.storage.put(UNCLOSED, kept);
      await this.wakeBy(Date.now() + HUDDLE_CHECK_MS);
    } catch (error) {
      console.error("Could not keep a huddle's tracks to close:", logged(error));
    }
  }

  /**
   * Asks the SFU again to close the tracks it didn't, a few sessions at a time, and answers whether
   * any are left to ask about. Those of an app huddles no longer run through are dropped, as are those
   * it has been asked about for `UNCLOSED_KEPT_MS`. A session stays among those kept until the SFU has
   * answered for it, since tracks kept meanwhile store the list as it is then. A check of the huddle
   * asks, and so does the alarm of a deleted room, which checks no huddle, before it erases the room.
   */
  async closeUnclosed(now = Date.now()): Promise<boolean> {
    const kept = await this.unclosed();
    if (kept.length === 0) return false;
    const app = await this.appNow().catch(() => undefined);
    if (app === undefined) return true;
    for (const session of kept.slice(0, RETRIED_PER_CHECK)) {
      const mids = app?.appId === session.appId && !this.givenUpOn(session, now) ? await this.closeOn(app, session) : [];
      // Unless the list has dropped it meanwhile, as it does its oldest once it's full.
      const at = kept.indexOf(session);
      if (at >= 0) kept.splice(at, 1);
      if (mids.length > 0) kept.push({ ...session, mids });
    }
    if (kept.length > 0) await this.ctx.storage.put(UNCLOSED, kept);
    else await this.ctx.storage.delete(UNCLOSED);
    return kept.length > 0;
  }

  /** Whether the SFU has been asked to close `session`'s tracks for as long as the room goes on asking, which it says once. */
  private givenUpOn(session: Unclosed, now: number): boolean {
    if (now - session.since <= UNCLOSED_KEPT_MS) return false;
    console.error("Gave up closing a huddle's tracks at the Realtime SFU.");
    return true;
  }

  /** Tells the Workspace who's in the huddle now, which has changed, and has the room bring its message of the huddle in step with it as it is now, without anything waiting on either. */
  private reportSoon(): void {
    this.ctx.waitUntil(this.report());
    this.ctx.waitUntil(this.changed(this.now()));
  }

  /**
   * Tells the Workspace who's in the huddle, for everyone in the room to hear. Reports go one at a time,
   * each saying who's in the huddle as it's made, so the changes made while one is on its way go
   * together in the next. Answers whether the Workspace has heard: when it hasn't, the room's next check
   * tells it again.
   */
  private report(): Promise<boolean> {
    this.unreported = true;
    return (this.reporting ??= this.sendReports());
  }

  private async sendReports(): Promise<boolean> {
    try {
      while (this.unreported) {
        this.unreported = false;
        await this.sendReport();
      }
      return true;
    } catch (error) {
      console.warn("Telling the Workspace who's in a huddle failed:", logged(error));
      return false;
    } finally {
      this.reporting = null;
    }
  }

  /**
   * Tells the Workspace who's in the huddle as this is called, at a later time than the report before.
   * The room's id is kept before the Workspace hears of anyone, so that it hears of the huddle's end
   * whatever becomes of the room's object meanwhile, and forgotten once it has heard that.
   */
  private async sendReport(): Promise<void> {
    const members = this.members();
    const roomId = members[0]?.attachment.roomId ?? (await this.reportedRoom());
    // Nobody has been in a huddle here since the Workspace heard that the last one was over.
    if (roomId === undefined) return;
    const huddle = members[0] ? { startedAt: members[0].attachment.startedAt, userIds: members.map(({ attachment }) => attachment.user.id) } : null;
    if (huddle) await this.keepReported(roomId);
    const at = Math.max(this.reportedAt + 1, Date.now());
    this.reportedAt = at;
    const outdatedBy = await workspace(this.env).reportHuddle(roomId, at, huddle);
    if (outdatedBy !== null) {
      // The Workspace has a report from a later time, as a clock that went back makes an earlier one: said again, after it.
      this.reportedAt = Math.max(this.reportedAt, outdatedBy);
      this.unreported = true;
    } else if (!huddle && !this.unreported) await this.forgetReported();
  }

  /** The room whose huddle the Workspace has heard of, and not yet the end of. */
  private reportedRoom(): Promise<RoomId | undefined> {
    return (this.reported ??= this.ctx.storage.get<RoomId>(REPORTED));
  }

  private async keepReported(roomId: RoomId): Promise<void> {
    if ((await this.reportedRoom()) === roomId) return;
    await this.ctx.storage.put(REPORTED, roomId);
    this.reported = Promise.resolve(roomId);
  }

  private async forgetReported(): Promise<void> {
    await this.ctx.storage.delete(REPORTED);
    this.reported = Promise.resolve(undefined);
  }

  /** Everyone in the huddle, in the order they joined. */
  private people(): HuddlePerson[] {
    return this.members().map(({ attachment }) => personOf(attachment));
  }

  /** The huddle's open sockets, in the order their people joined, with what each remembers. */
  private members(): Member[] {
    return this.ctx
      .getWebSockets(HUDDLE_TAG)
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .map((socket) => ({ socket, attachment: attachmentOf(socket) }))
      .sort((a, b) => a.attachment.joinedAt - b.attachment.joinedAt);
  }

  private broadcast(frame: HuddleServerFrame, except?: WebSocket): void {
    const data = JSON.stringify(frame);
    for (const { socket } of this.members()) {
      if (socket === except) continue;
      try {
        socket.send(data);
      } catch {
        // As in `send`.
      }
    }
  }
}
