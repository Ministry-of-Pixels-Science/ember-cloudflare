// Huddles, in which people in a room talk to each other through Cloudflare's Realtime SFU, by an SFU app
// in the Cloudflare account of whoever runs Ember, whose keys administrators give it in Set up huddles,
// behind the Huddles card of workspace settings, or as they set Ember up, through `/api/account/huddles`.
// A network that blocks the way a browser reaches the SFU is gone around through Cloudflare's TURN
// service, which relays what the browser sends and receives, by a TURN key in the same account, whose
// ID and API token administrators give in Set up the relay, through `/api/account/huddles/relay`.

import type { User, UserId } from "./index.ts";
import { MAX_ID_LENGTH } from "./pages.ts";

/**
 * Huddles as the Huddles tab shows them to administrators while they're on: the SFU app they run
 * through, by its ID, and the TURN key their relay goes by, by its ID, or null while they have none.
 */
export interface HuddlesSettings {
  appId: string;
  relayKeyId: string | null;
}

/** What Set up huddles gives `PUT /api/account/huddles`: a Realtime SFU app's ID and its secret, as Cloudflare's dashboard shows them when the app is made. */
export interface HuddlesSetup {
  appId: string;
  appSecret: string;
}

/**
 * What `PUT /api/account/huddles` answers once Cloudflare has taken the app's keys, and
 * `PUT /api/account/huddles/relay` once it has taken the TURN key's: huddles as they are then. It's
 * what `DELETE /api/account/huddles/relay` answers too, while huddles are on.
 */
export interface HuddlesSaved {
  huddles: HuddlesSettings;
}

/** What `DELETE /api/account/huddles` answers: huddles are off. */
export interface HuddlesForgotten {
  huddles: null;
}

/** A field of Set up huddles, which a refusal can be about. */
export type HuddlesField = "appId" | "appSecret";

/** What Set up the relay gives `PUT /api/account/huddles/relay`: a TURN key's ID and its API token, as Cloudflare's dashboard shows them when the key is made. */
export interface HuddleRelaySetup {
  keyId: string;
  apiToken: string;
}

/** A field of Set up the relay, which a refusal can be about. */
export type HuddleRelayField = "keyId" | "apiToken";

/** How long an SFU app's ID is, and its secret, as Cloudflare's API gives them. */
const APP_ID_LENGTH = 32;
const APP_SECRET_LENGTH = 64;

/** Why Set up huddles' fields are refused before Cloudflare is asked about them. */
export const APP_ID_REFUSED = `An App ID is ${APP_ID_LENGTH} letters and digits. Copy it from your app under Realtime's Serverless SFU in the Cloudflare dashboard.`;
export const APP_SECRET_REFUSED = `An App Secret is ${APP_SECRET_LENGTH} letters and digits. Copy it from your app under Realtime's Serverless SFU in the Cloudflare dashboard.`;

/** Why they're refused once Cloudflare has been asked to start a session with them, or couldn't be. */
export const APP_ID_UNKNOWN = "Cloudflare doesn't know that App ID. Copy it again from your app, or try again in a minute if you've just made it.";
export const APP_SECRET_UNKNOWN = "Cloudflare didn't take that App Secret for this app. Copy both from the same app.";
export const HUDDLES_UNCHECKED = "Ember couldn't reach Cloudflare to check the app's keys. Try again.";

/** What the Huddles card tells anyone but an administrator. */
export const HUDDLES_FORBIDDEN = "Only administrators can set up huddles";

/** The SFU app ID `text` gives, without the spaces around it, or null when it can't be one: 32 letters and digits. */
export function appIdOf(text: string): string | null {
  const appId = text.trim();
  return appId.length === APP_ID_LENGTH && /^[0-9a-z]+$/i.test(appId) ? appId : null;
}

/** The SFU app secret `text` gives, without the spaces around it, or null when it can't be one: 64 letters and digits. */
export function appSecretOf(text: string): string | null {
  const appSecret = text.trim();
  return appSecret.length === APP_SECRET_LENGTH && /^[0-9a-z]+$/i.test(appSecret) ? appSecret : null;
}

/** What `PUT /api/account/huddles` gives Ember, as Set up huddles sends it, or why it can't be an app's keys, on the field it's about. */
export function parseHuddlesSetup(data: unknown): HuddlesSetup | { error: string; field: HuddlesField } {
  const given = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const appId = typeof given.appId === "string" ? appIdOf(given.appId) : null;
  if (appId === null) return { error: APP_ID_REFUSED, field: "appId" };
  const appSecret = typeof given.appSecret === "string" ? appSecretOf(given.appSecret) : null;
  if (appSecret === null) return { error: APP_SECRET_REFUSED, field: "appSecret" };
  return { appId, appSecret };
}

/** The most letters and digits a TURN key's ID is taken to have, and the most characters its API token: Cloudflare's own are shorter. */
const MAX_RELAY_KEY_ID_LENGTH = 64;
const MAX_RELAY_API_TOKEN_LENGTH = 256;

/** Why Set up the relay's fields are refused before Cloudflare is asked about them. */
export const RELAY_KEY_ID_REFUSED = "A TURN Token ID is letters and digits. Copy it from your TURN key under Realtime in the Cloudflare dashboard.";
export const RELAY_API_TOKEN_REFUSED = "That can't be a TURN key's API Token. Copy it from your TURN key under Realtime in the Cloudflare dashboard.";

/** Why they're refused once Cloudflare has been asked for the relay's servers with them, or couldn't be. */
export const RELAY_KEY_ID_UNKNOWN = "Cloudflare doesn't know that TURN Token ID. Copy it again from your TURN key, or try again in a minute if you've just made it.";
export const RELAY_API_TOKEN_UNKNOWN = "Cloudflare didn't take that API Token for this TURN key. Copy both from the same key.";
export const RELAY_UNCHECKED = "Ember couldn't reach Cloudflare to check the TURN key. Try again.";

/** Why a TURN key isn't kept while huddles are off: the relay is huddles', and is forgotten with the SFU app they run through. */
export const RELAY_WITHOUT_HUDDLES = "Huddles are off. Turn them on before setting up their relay.";

/** The TURN key ID `text` gives, without the spaces around it, or null when it can't be one: letters and digits, as it goes into the address Cloudflare is asked at. */
export function relayKeyIdOf(text: string): string | null {
  const keyId = text.trim();
  return keyId.length <= MAX_RELAY_KEY_ID_LENGTH && /^[0-9a-z]+$/i.test(keyId) ? keyId : null;
}

/** The TURN key's API token `text` gives, without the spaces around it, or null when it can't be one: what a request can carry as its bearer token. */
export function relayApiTokenOf(text: string): string | null {
  const apiToken = text.trim();
  return apiToken.length <= MAX_RELAY_API_TOKEN_LENGTH && /^[A-Za-z0-9._~+/-]+=*$/.test(apiToken) ? apiToken : null;
}

/** What `PUT /api/account/huddles/relay` gives Ember, as Set up the relay sends it, or why it can't be a TURN key's, on the field it's about. */
export function parseHuddleRelaySetup(data: unknown): HuddleRelaySetup | { error: string; field: HuddleRelayField } {
  const given = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const keyId = typeof given.keyId === "string" ? relayKeyIdOf(given.keyId) : null;
  if (keyId === null) return { error: RELAY_KEY_ID_REFUSED, field: "keyId" };
  const apiToken = typeof given.apiToken === "string" ? relayApiTokenOf(given.apiToken) : null;
  if (apiToken === null) return { error: RELAY_API_TOKEN_REFUSED, field: "apiToken" };
  return { keyId, apiToken };
}

// A huddle's socket. Each tab in a huddle keeps one to the room, at `/api/rooms/:id/huddle`, besides the
// socket it keeps while it shows the room. What people say and show goes between their browsers and the
// SFU: the socket carries who's in the huddle, and the session descriptions (SDP) a browser and the SFU
// agree with on what's sent, which the room passes between them. A tab keeps two connections to the SFU
// for the voices, one it sends its microphone on and one it receives the others on, so that neither's
// changes wait on the other's, and two more like them for the cameras, from when it first shows or
// watches one, so that a camera turning on or off changes nothing the voices travel on. The screens
// people share go on two more again, for the same reason. A frame about a connection says which pair
// it's of by the `kind` of track the pair carries.

/** The most people a huddle takes. */
export const MAX_HUDDLE_PEOPLE = 50;

/** The most cameras a huddle shows at once, as Slack's does. */
export const MAX_HUDDLE_CAMERAS = 25;

/** The most screens people share in a huddle at once, as in Slack's. */
export const MAX_HUDDLE_SCREENS = 2;

/** The most people one `huddle.invite` invites: as many as a huddle takes. */
export const MAX_HUDDLE_INVITED = MAX_HUDDLE_PEOPLE;

/** What a huddle closes a socket with, besides the codes a room closes one with (`CloseCode`). None is one to connect again after. */
export const HuddleCloseCode = {
  /** The huddle has as many people as one takes. */
  Full: 4005,
  /** Huddles are off: they were never set up, or an administrator turned them off while this one went on. */
  Off: 4006,
  /** The person joined the huddle from another tab or device, which it moved to. */
  Moved: 4007,
} as const;
export type HuddleCloseCode = (typeof HuddleCloseCode)[keyof typeof HuddleCloseCode];

/**
 * The sizes a camera's picture is sent in where its browser sends two at once (simulcast), by the names
 * its connection gives them, their RIDs: as large as the camera takes it, and at half that width and
 * height, for whoever shows it in a tile no larger. Where the SFU can't send the size it's asked for,
 * it sends the next in the alphabet's order, so the large one is the first of them.
 */
export const CAMERA_SIZES = { large: "a", small: "b" } as const;
export type CameraSize = (typeof CAMERA_SIZES)[keyof typeof CAMERA_SIZES];

/**
 * How long Cloudflare's relay takes what a tab is given to use it with, in seconds, from when the room
 * has Cloudflare make it, as the tab joins: a day. A tab whose connection fails after that joins again,
 * for what the relay takes then.
 */
export const RELAY_TTL_S = 86_400;

/**
 * A server a tab's connections to the SFU go by, as a browser's `RTCIceServer` has it: a STUN server,
 * by which the browser learns the address the SFU reaches it at, or the relay's, with the name and the
 * credential Cloudflare made for the tab to use it with.
 */
export interface HuddleIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** What a track in a huddle carries: someone's microphone, their camera, or the screen they share. */
export type HuddleTrackKind = "audio" | "video" | "screen";

/** The kinds of track, the microphone's first. */
export const HUDDLE_TRACK_KINDS: readonly HuddleTrackKind[] = ["audio", "video", "screen"];

/** A track a tab publishes: the media section of its offer that carries it, by its `mid`, and what it carries. */
export interface HuddleTrack {
  mid: string;
  kind: HuddleTrackKind;
}

/** A track a tab is offered: the media section of the offer that carries it, and whose it is. */
export interface OfferedHuddleTrack extends HuddleTrack {
  userId: UserId;
}

/** Someone in a huddle, as everyone in it hears of them. */
export interface HuddlePerson {
  user: User;
  /** Whether they've muted their microphone, as their tab says. */
  muted: boolean;
  /** Whether they can be listened to: their tab has connected to the SFU with their microphone. */
  audio: boolean;
  /** Whether they can be watched: their camera is on, and their tab has connected to the SFU with it. */
  video: boolean;
  /** Whether their screen can be watched: they share it, and their tab has connected to the SFU with it. */
  screen: boolean;
}

/**
 * A huddle going on in a room, as everyone in the room hears of it, in the huddle or not, in their
 * sidebar and on their workspace sockets: who's in it, by their ids in the order they joined, and when it
 * started. The room tells the Workspace as people join and leave, so it trails the huddle by a moment.
 */
export interface LiveHuddle {
  startedAt: string;
  userIds: UserId[];
}

/**
 * A huddle as its message in the room says it (`Message.huddle`): when it started, and once it's over,
 * when it ended and everyone who was in it, in the order they first joined, named as they were then. A
 * message without an end is of the huddle going on in its room, and who's in that is the room's
 * `LiveHuddle`.
 */
export interface MessageHuddle {
  startedAt: string;
  endedAt?: string;
  people?: User[];
}

/** What a tab sends on its huddle's socket. Leaving the huddle is closing the socket. */
export type HuddleClientFrame =
  /**
   * Publishes the tab's microphone, its camera or the screen its person shares, as the one track says,
   * with the offer the sending connection for that kind makes for it, which `huddle.published` answers.
   * A tab whose sending connection has failed publishes again from a new one, and only once the room has
   * answered the last, so that each answer is to the offer it waits on.
   */
  | { type: "huddle.publish"; sdp: string; tracks: [HuddleTrack] }
  /** The tab's sending connection for `kind` has connected, so the others can listen to what it publishes, or watch it. */
  | { type: "huddle.connected"; kind: HuddleTrackKind }
  /** The tab publishes its `kind` no longer, as when its person turns their camera off or stops sharing their screen, and has closed the connection it sent on. */
  | { type: "huddle.unpublish"; kind: HuddleTrackKind }
  /**
   * Asks to hear everyone the tab doesn't hear yet, which `huddle.offer` answers, or `huddle.listening`
   * when there's nobody new. `fresh` says the tab has no receiving connection: as it joins, and whenever
   * the one it had has failed. A tab asks again only once the room has answered. For cameras and for
   * screens, `watch` names whose the tab is to see, as many as a huddle shows, and the room stops
   * sending it anyone else's: a tab watches only while it shows the huddle open, and whoever asks for
   * nobody watches nobody. For cameras, `small` says that the tab shows them in tiles no larger than the
   * smaller of a camera's sizes, which is the one the room then has the SFU send it of each camera
   * that's sent in both, those it watches already included.
   */
  | { type: "huddle.listen"; kind: HuddleTrackKind; fresh?: true; watch?: UserId[]; small?: true }
  /** The answer the tab's receiving connection for `kind` makes to a `huddle.offer`. */
  | { type: "huddle.answer"; kind: HuddleTrackKind; sdp: string }
  /** The person has muted their microphone, or unmuted it. */
  | { type: "huddle.mute"; muted: boolean }
  /**
   * Invites people into the huddle, each named once: it rings for each of them wherever they have Ember
   * open, with who invites them, for them to join or decline. Whoever starts a huddle in a direct
   * message invites everyone else in it. The room leaves out whoever is in the huddle already, and the
   * Workspace whoever isn't in the room, or has turned its notifications off, so nobody hears of a
   * room they aren't in.
   */
  | { type: "huddle.invite"; userIds: UserId[] }
  | { type: "ping" };

/** What a tab hears on its huddle's socket. */
export type HuddleServerFrame =
  /**
   * The huddle as the tab joins it: everyone in it, the tab's person included, and when it started.
   * `messageId` names the room's message of the huddle, whose thread is the huddle's: the room may have
   * yet to write it, and it may have been deleted since. While huddles have a relay, `iceServers` are
   * the servers the tab's connections go by, the relay's among them, which take what the tab is given
   * to use them with for `RELAY_TTL_S` from now. A tab that's given none goes by Cloudflare's STUN
   * server alone.
   */
  | { type: "huddle.welcome"; you: User; people: HuddlePerson[]; startedAt: string; messageId?: string; iceServers?: HuddleIceServer[] }
  | { type: "huddle.joined"; person: HuddlePerson }
  /**
   * Someone muted or unmuted, can be listened to or watched now, or can't be: they've turned their camera
   * off or stopped sharing their screen, their tab is publishing again, or they've joined from another
   * one. A tab asks to hear whoever it can listen to and doesn't, and to see whoever it's to watch and
   * doesn't.
   */
  | { type: "huddle.changed"; person: HuddlePerson }
  | { type: "huddle.left"; userId: UserId }
  /** The SFU's answer to the offer the tab published its `kind` with. */
  | { type: "huddle.published"; kind: HuddleTrackKind; sdp: string }
  /**
   * The SFU's offer of the people the tab asked to hear, or to watch, as `tracks`, which the tab's
   * receiving connection for `kind` answers with `huddle.answer`. `tracks` names whoever publishes what
   * the offer carries of them as the room sends it, and not someone who left or began publishing anew
   * while the SFU made it. Someone can do either while the offer is on its way, too, or while the
   * connection takes it, so a tab plays only the tracks of people who have been in the huddle, and to be
   * listened to or watched, since it came.
   */
  | { type: "huddle.offer"; kind: HuddleTrackKind; sdp: string; tracks: OfferedHuddleTrack[] }
  /**
   * The tab receives everyone it was offered on its connection for `kind`: it may ask again, should
   * there be someone new. The SFU can take a moment to find what someone has just published, so a tab
   * that still doesn't hear someone it can listen to asks again in a while.
   */
  | { type: "huddle.listening"; kind: HuddleTrackKind }
  /**
   * The SFU no longer has what the tab published of `kind`, so nobody can listen to its person, or
   * watch them, until the tab publishes it again, from a new sending connection. A tab waiting on the
   * answer to an offer it has published with already is.
   */
  | { type: "huddle.unpublished"; kind: HuddleTrackKind }
  /**
   * The room couldn't do what the `failed` frame asked, of the connections for `kind`. After a failed
   * `huddle.listen` or `huddle.answer` the room has let go of the tab's receiving connection, so the tab
   * starts a fresh one. After a failed `huddle.publish` it publishes again, from a new sending
   * connection, unless the room `refused`: it won't publish that however often it's asked, as it won't
   * one camera or one screen more than a huddle shows, and `message` tells the tab's person why. After
   * a failed `huddle.invite` nobody was invited, which `message` tells them too.
   */
  | { type: "error"; message: string; failed?: HuddleClientFrame["type"]; kind?: HuddleTrackKind; refused?: true }
  | { type: "pong" };

/** What a huddle socket's address says of its tab: whether its person joins with their microphone muted. */
export interface HuddleSocketParams {
  muted: boolean;
}

/** The query a huddle socket's address ends with. */
export const huddleSocketQuery = ({ muted }: HuddleSocketParams) => (muted ? "?muted=1" : "");

/** What a huddle socket's address says of its tab, as `huddleSocketQuery` wrote it. A tab that doesn't say joins unmuted. */
export const parseHuddleSocketParams = (query: { get(name: string): string | null }): HuddleSocketParams => ({ muted: query.get("muted") === "1" });

/** Why the room couldn't do what a huddle's tab asked: the SFU refused, or couldn't be reached. */
export const HUDDLE_FAILED = "The huddle couldn't connect. Trying again.";

/** Why the room won't show someone's camera while an administrator has cameras off, which their tab tells them as theirs goes off. */
export const CAMERAS_OFF = "Cameras are turned off for huddles here.";

/** Why the room won't show someone's camera while the huddle shows as many as one does. */
export const CAMERAS_FULL = `${MAX_HUDDLE_CAMERAS} cameras are on in this huddle, which is as many as one shows. Yours can go on once someone turns theirs off.`;

/** Why the room won't show someone's screen while an administrator has screen sharing off, which their tab tells them as theirs stops. */
export const SCREENS_OFF = "Screen sharing is turned off for huddles here.";

/** Why the room won't show someone's screen while as many people share theirs as a huddle shows. */
export const SCREENS_FULL = `${MAX_HUDDLE_SCREENS} people are sharing their screens in this huddle, which is as many as one shows. You can share yours once one of them stops.`;

/** Why nobody someone invited into a huddle was: the room couldn't have them told. */
export const NOBODY_INVITED = "Ember couldn't invite anyone to the huddle just now.";

/** Why the room invites nobody more for someone who has invited people as often as a tab may in a minute. */
export const INVITED_TOO_OFTEN = "You've invited people to this huddle a lot in the last minute. Wait a moment before inviting anyone else.";

/** The most characters a session description can have: one for a tab hearing a full huddle is a fraction of this. */
export const MAX_SDP_LENGTH = 500_000;

const sdpOf = (value: unknown): string | null => (typeof value === "string" && value.length > 0 && value.length <= MAX_SDP_LENGTH ? value : null);

/** A media section's `mid` as browsers write them: a few letters and digits, and never the `#` the SFU reads a track's name after. */
const isMid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value);

const isKind = (value: unknown): value is HuddleTrackKind => HUDDLE_TRACK_KINDS.some((kind) => kind === value);

/**
 * The pair of connections a frame is about, by the kind of track the pair carries, or null when it names
 * none there is. A tab from before there were cameras names none, and means the voices'.
 */
const kindOf = (value: unknown): HuddleTrackKind | null => (value === undefined ? "audio" : isKind(value) ? value : null);

/** The one track a `huddle.publish` names, by its `mid` and its kind, or null when it can't be that: a connection sends a microphone, a camera or a screen. */
function trackOf(value: unknown): [HuddleTrack] | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const track: unknown = value[0];
  if (typeof track !== "object" || track === null) return null;
  const { mid, kind } = track as Record<string, unknown>;
  return isMid(mid) && isKind(kind) ? [{ mid, kind }] : null;
}

const isUserId = (value: unknown): value is UserId => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;

/** The most people a `huddle.listen` names: as many as a huddle shows the screens of, or the cameras. */
const mostWatched = (kind: HuddleTrackKind) => (kind === "screen" ? MAX_HUDDLE_SCREENS : MAX_HUDDLE_CAMERAS);

/** Whose cameras or screens a `huddle.listen` asks to see, `most` of them, each named once, or null when they can't be that. A tab that names none asks for nobody's. */
function watchOf(value: unknown, most: number): UserId[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > most || !value.every(isUserId)) return null;
  return new Set(value).size === value.length ? value : null;
}

/** Who a `huddle.invite` invites, at least one of them and `MAX_HUDDLE_INVITED` at most, each named once, or null when they can't be that. */
function invitedOf(value: unknown): UserId[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HUDDLE_INVITED || !value.every(isUserId)) return null;
  return new Set(value).size === value.length ? value : null;
}

/** Whether `value` is something a frame says only when it's so: `true`, or left out. */
const isSaidOrNot = (value: unknown): value is true | undefined => value === undefined || value === true;

/** What a `huddle.listen` asks, or null when it can't be one. Cameras and screens are asked for by name, and voices aren't, and only cameras come in sizes. */
function listenOf(frame: Record<string, unknown>): HuddleClientFrame | null {
  const kind = kindOf(frame.kind);
  if (kind === null || !isSaidOrNot(frame.fresh) || !isSaidOrNot(frame.small)) return null;
  const watch = watchOf(frame.watch, mostWatched(kind));
  if (watch === null) return null;
  const listen: Extract<HuddleClientFrame, { type: "huddle.listen" }> = { type: "huddle.listen", kind };
  if (frame.fresh) listen.fresh = true;
  if (kind !== "audio") listen.watch = watch;
  if (kind === "video" && frame.small) listen.small = true;
  return listen;
}

/** The names in a list of them that a session description gives after `direction`, as `a=simulcast:send b;a` does, each without the mark of one that starts paused. */
function namedAfter(line: string, direction: string): string[] {
  const words = line.split(" ");
  const at = words.indexOf(direction);
  return at < 0 ? [] : (words[at + 1] ?? "").split(";").map((name) => name.replace(/^~/, ""));
}

/**
 * Whether the session description `sdp` carries the track of its media section `mid` in both of a
 * camera's sizes, and in no other: as a tab's offer says of what its browser sends (`send`), and the
 * SFU's answer of what it takes (`recv`).
 */
export function carriesBothSizes(sdp: string, mid: string, direction: "send" | "recv"): boolean {
  // What a description says before its first media section, it says of no track.
  const sections = sdp.split(/^(?=m=)/m).filter((section) => section.startsWith("m="));
  const simulcast = sections
    .map((section) => section.split(/\r?\n/))
    .find((lines) => lines.includes(`a=mid:${mid}`))
    ?.find((line) => line.startsWith("a=simulcast:"));
  if (!simulcast) return false;
  const sizes = namedAfter(simulcast.slice("a=simulcast:".length), direction);
  return sizes.length === 2 && Object.values(CAMERA_SIZES).every((size) => sizes.includes(size));
}

/** Parses an untrusted frame from a huddle's socket. Returns null for anything malformed. */
export function parseHuddleClientFrame(raw: string): HuddleClientFrame | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const frame = data as Record<string, unknown>;
  switch (frame.type) {
    case "huddle.publish": {
      const [sdp, tracks] = [sdpOf(frame.sdp), trackOf(frame.tracks)];
      return sdp !== null && tracks !== null ? { type: "huddle.publish", sdp, tracks } : null;
    }
    case "huddle.connected":
    case "huddle.unpublish": {
      const kind = kindOf(frame.kind);
      return kind !== null ? { type: frame.type, kind } : null;
    }
    case "huddle.listen":
      return listenOf(frame);
    case "huddle.answer": {
      const [kind, sdp] = [kindOf(frame.kind), sdpOf(frame.sdp)];
      return kind !== null && sdp !== null ? { type: "huddle.answer", kind, sdp } : null;
    }
    case "huddle.mute":
      return typeof frame.muted === "boolean" ? { type: "huddle.mute", muted: frame.muted } : null;
    case "huddle.invite": {
      const userIds = invitedOf(frame.userIds);
      return userIds !== null ? { type: "huddle.invite", userIds } : null;
    }
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
}
