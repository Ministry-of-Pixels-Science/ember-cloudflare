import { CloseCode, parseServerFrame, type RoomId, type UserId } from "@ember/protocol";
import {
  CAMERA_SIZES,
  HUDDLE_TRACK_KINDS,
  HuddleCloseCode,
  huddleSocketQuery,
  MAX_HUDDLE_CAMERAS,
  MAX_HUDDLE_PEOPLE,
  MAX_HUDDLE_SCREENS,
  RELAY_TTL_S,
  SCREENS_FULL,
  type HuddleClientFrame,
  type HuddleIceServer,
  type HuddleServerFrame,
  type HuddleTrackKind,
  type OfferedHuddleTrack,
} from "@ember/protocol/huddles";
import { socketUrl } from "./api";
import { keepScreenAwake } from "./huddle-awake";
import {
  CAMERA_WENT_OFF,
  cameraOf,
  closeDevice,
  facingOf,
  microphoneOf,
  NO_CAMERA,
  NO_OTHER_CAMERA,
  NO_OTHER_MICROPHONE,
  NO_OTHER_SPEAKER,
  NO_SCREEN,
  openCamera,
  openMicrophone,
  openOtherCamera,
  openScreen,
  rememberDevice,
  rememberedDevice,
  STILL_NO_MICROPHONE,
  type CameraFacing,
} from "./huddle-devices";
import { huddleSounds } from "./huddle-sounds";
import { huddleSpeaker, type HuddleSpeaker } from "./huddle-speaker";
import { whoSpeaks, type HuddleSpeaking } from "./huddle-speaking";
import { endHuddle, leaveHuddle, showHuddle, showSpeaking, tellOfHuddle, type HuddleControls, type JoinedHuddle } from "./huddle-store";
import { reconnectingSocket } from "./reconnecting-socket";

// A tab's side of a huddle. Its socket to the room (`/api/rooms/:id/huddle`) says who's in the huddle and
// carries the session descriptions the browser and Cloudflare's Realtime SFU agree with, which the room
// passes between them. What people say goes over two connections to the SFU: one sends the tab's
// microphone, and one receives everyone else, so that neither's changes wait on the other's. Cameras go
// over two more like them, which the tab has only while its own is on, or while it watches the others',
// so that nothing about a camera touches what carries a voice, and the screens people share go over two
// more again. The room has the SFU close them all whenever the socket closes, so a socket that connects
// again starts each afresh. The tab plays the huddle's own sounds as well (huddle-sounds.ts), through
// the speaker the voices use.
//
// A huddle in a direct message rings the others in it: the tab that starts one asks the room to invite
// them, and their tabs show the invitation and ring (huddle-invitations.ts). Anyone in a huddle asks
// the same for whoever they pick of the room's people, from Invite people.
//
// A camera goes out in two sizes at once (simulcast) from a browser known to send them, and each tab
// that watches is sent the one it says it shows: the small one for small tiles, so that a huddle of
// many costs each of them, and Cloudflare's bill, a small picture apiece.
//
// Where an administrator has given huddles a relay, the room's welcome has the servers the connections
// go by, Cloudflare's TURN service among them, which carries them on a network that blocks the way to
// the SFU. What the tab is given to use the relay with lasts a day, so a connection that fails after
// that joins again, on a new socket, for the room to give it anew.
//
// The room's answers say which of those pairs they're about, and not which frame they're to, so the tab
// asks one thing at a time of each connection, and waits for the answer before it asks the next.
//
// A phone's browser stops a page once its screen locks, so a huddle keeps a phone's screen awake
// (huddle-awake.ts). And a phone opens one of its cameras at a time, so the camera that's on is let go
// of before another is opened in its place.

/** How a tab joins a huddle, as the preview before it leaves things. */
export interface HuddleJoin {
  roomId: RoomId;
  muted: boolean;
  /** The microphone, open already, which the huddle stops as it's left, or null to join listening only. */
  microphone: MediaStream | null;
  /**
   * The camera of a tab that joins showing it, open already, or still opening where the browser hadn't
   * answered for it as the preview was left: the huddle shows it once it's open, and stops it as it's
   * turned off or left. Null joins with it off.
   */
  camera: MediaStream | Promise<MediaStream | null> | null;
  /** The speaker the others play through, by its device's id, or empty for the browser's own. */
  speakerId: string;
  /**
   * Who the tab invites into the huddle if joining it starts it, the room letting it in with nobody else
   * there: the others in a direct message, whose huddle rings them, and nobody in a shared room.
   */
  invite?: UserId[];
}

/** Cloudflare's STUN server, by which the browser learns the address the SFU reaches it at, which is all a connection goes by without a relay. */
const CONNECTION: RTCConfiguration = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" };

/** How a tab's connections reach the SFU, as the room's welcome had it, and when the relay's servers came, if they did. */
interface Reach {
  configuration: RTCConfiguration;
  relayedAt: number | null;
}

/** How they reach it by `servers`, the relay's among them, as the room gives them now, or by Cloudflare's STUN server alone where it gives none. */
const reachBy = (servers: HuddleIceServer[] | undefined): Reach =>
  servers?.length ? { configuration: { ...CONNECTION, iceServers: servers }, relayedAt: Date.now() } : { configuration: CONNECTION, relayedAt: null };

/** Whether what the tab was given to use the relay with has run out, so that a connection made now would go without it. */
const hasRunOut = ({ relayedAt }: Reach) => relayedAt !== null && Date.now() - relayedAt >= RELAY_TTL_S * 1000;

/**
 * A connection that reaches the SFU as `configuration` says. A browser refuses one any of whose servers
 * it can't make sense of, and then the connection goes by Cloudflare's STUN server alone, as it would
 * without a relay.
 */
function connectionBy(configuration: RTCConfiguration): RTCPeerConnection {
  try {
    return new RTCPeerConnection(configuration);
  } catch {
    return new RTCPeerConnection(CONNECTION);
  }
}

/**
 * How long the room has to answer what a connection asked of it: longer than it gives the SFU to answer
 * all that a round of listening can have it ask. A room that hasn't by then isn't going to, and the tab
 * joins again on a new socket.
 */
export const ANSWER_TIMEOUT_MS = 45_000;
/** How long the tab waits to ask again for someone it can listen to and doesn't hear, doubling up to the second. */
export const LISTEN_AGAIN_MS = [500, 8_000] as const;
/** How long it waits to publish again after its sending connection failed, doubling up to the second. */
export const PUBLISH_AGAIN_MS = [1_000, 15_000] as const;
/** The most a camera's connection sends, in bits a second: enough for a tile, which is as large as a huddle shows anyone. */
export const CAMERA_BITRATE = 500_000;
/** The most it sends of the camera's smaller size, half as wide and half as tall, which is all a small tile shows. */
export const SMALL_CAMERA_BITRATE = 150_000;
/** The fewest pixels a picture has for Chromium to send it in two sizes. */
const LEAST_IN_TWO_SIZES = 480 * 270;
/** The most a shared screen's connection sends, in bits a second: enough to keep the text of one as large as a huddle asks for sharp, at the few pictures a second it takes. */
export const SCREEN_BITRATE = 1_500_000;

/** The kinds of track by which a tab shows the others something, beside the one that carries its voice. */
const SHOWN_KINDS = ["video", "screen"] as const;
type ShownKind = (typeof SHOWN_KINDS)[number];

/**
 * Whether the browser is one known to send a camera in two sizes at once as the SFU takes them:
 * Chromium's family, by what it says of itself. Any other sends one size until it has been tried.
 */
const sendsTwoSizes = () => /Chrom(e|ium)\//.test(navigator.userAgent);

/**
 * The sizes a camera's connection sends `track` in. From a browser known to send two at once, that's
 * the picture as it is and, before it, one of half its width and height, for the SFU to send whoever
 * shows it small. Chromium sends the first alone of a picture too small for two, and while it hasn't
 * the bandwidth for both, so the small one is first. From any other browser, and of a picture too
 * small, it's the one size.
 */
function cameraSizes(track: MediaStreamTrack): RTCRtpEncodingParameters[] {
  const { width = 0, height = 0 } = track.getSettings();
  if (!sendsTwoSizes() || width * height < LEAST_IN_TWO_SIZES) return [{ maxBitrate: CAMERA_BITRATE }];
  return [
    { rid: CAMERA_SIZES.small, maxBitrate: SMALL_CAMERA_BITRATE, scaleResolutionDownBy: 2 },
    { rid: CAMERA_SIZES.large, maxBitrate: CAMERA_BITRATE },
  ];
}

/**
 * What a tab shows the others by each of those kinds, its camera and its screen: where its huddle keeps
 * its own and the others', how many of the others' a huddle shows, and the sizes its connection sends
 * a track in, with the most each sends.
 */
const SHOWN = {
  video: { own: "camera", theirs: "watched", most: MAX_HUDDLE_CAMERAS, sizes: cameraSizes },
  screen: { own: "screen", theirs: "screens", most: MAX_HUDDLE_SCREENS, sizes: (): RTCRtpEncodingParameters[] => [{ maxBitrate: SCREEN_BITRATE }] },
} as const;

/**
 * What the tab's person is told once the room has ended the huddle for them, by the code it closed their
 * socket with, or null where the app says so for itself. After any other close the tab connects again.
 */
const ENDINGS: Record<number, string | null> = {
  [HuddleCloseCode.Full]: `That huddle is full. A huddle takes ${MAX_HUDDLE_PEOPLE} people.`,
  [HuddleCloseCode.Off]: "Huddles have been turned off.",
  [HuddleCloseCode.Moved]: "You joined the huddle somewhere else, so it left this tab.",
  [CloseCode.NotFound]: "You left the huddle, since its room is no longer there for you.",
  // Their sessions have ended, and the app goes to sign in.
  [CloseCode.Revoked]: null,
};

/** The address of room `roomId`'s huddle's socket, which says whether the tab joins muted. */
export const huddleSocketUrl = (roomId: RoomId, muted: boolean) => socketUrl(`/api/rooms/${encodeURIComponent(roomId)}/huddle${huddleSocketQuery({ muted })}`);

/** A wait that doubles each time it's taken, from `least` to `most`, until it's started over. */
function growingWait([least, most]: readonly [number, number]) {
  let next = least;
  return {
    take() {
      const wait = next;
      next = Math.min(most, next * 2);
      return wait;
    },
    startOver() {
      next = least;
    },
  };
}

/**
 * The others' voices: an `<audio>` each, which plays its person's track through `speaker` from when the
 * tab is offered it until they leave, while `speaking` measures it. A browser measures a voice from
 * another computer only while the page plays it, so it's played first.
 */
function voicesThrough(speaker: HuddleSpeaker, speaking: HuddleSpeaking) {
  const playing = new Map<UserId, HTMLAudioElement>();
  const stop = (userId: UserId) => {
    const audio = playing.get(userId);
    if (!audio) return;
    speaking.forget(userId);
    audio.srcObject = null;
    speaker.stop(audio);
    playing.delete(userId);
  };
  return {
    play(userId: UserId, track: MediaStreamTrack) {
      const audio = playing.get(userId) ?? document.createElement("audio");
      audio.dataset.userId = userId;
      audio.autoplay = true;
      audio.srcObject = new MediaStream([track]);
      playing.set(userId, audio);
      speaker.play(audio);
      speaking.hear(userId, track);
    },
    stop,
    stopAll() {
      for (const userId of [...playing.keys()]) stop(userId);
    },
  };
}

/** Whether the tab's person is the only one in its huddle, as far as the room has said. */
const isAlone = ({ connected, you, people }: JoinedHuddle) => connected && people.every(({ user }) => user.id === you?.id);

/** What each of a tab's connections to the SFU has of the huddle it's part of. */
interface Huddled {
  /** Sends the room a frame, and says whether it went, which it doesn't while the socket is down. */
  send(frame: HuddleClientFrame): boolean;
  /** Joins again on a new socket. */
  rejoin(): void;
  /** Whether the tab has left the huddle. */
  isOver(): boolean;
  /** Makes a connection that reaches the SFU as the room's welcome had it. */
  connect(): RTCPeerConnection;
  /** Whether what the tab was given to use the relay with has run out: a connection that fails then is made again only once the tab has joined again. */
  relayRunOut(): boolean;
}

/** What one of a tab's connections carries. */
interface Carried {
  kind: HuddleTrackKind;
  /**
   * Whether a huddle is none without it, as without its voices: the tab joins again, on a new socket,
   * when the room leaves what the connection asked unanswered. One that isn't starts over by itself, so
   * that a camera's troubles stay the camera's.
   */
  vital: boolean;
}

/** What a sending connection publishes, and how. */
interface Sent extends Carried {
  /** The track to publish now, or null while there's none, as with a camera that's off. */
  track(): MediaStreamTrack | null;
  /** How a connection sends `track`: in one size, or in several at once, the largest last. */
  sends(track: MediaStreamTrack): RTCRtpTransceiverInit;
}

/** Whose tracks a receiving connection receives, and what becomes of each. */
interface Received extends Carried {
  /** Who can be received now: everyone else whose connection for this kind of track has connected. */
  receivable(): UserId[];
  /** Whom of them the tab would receive now, which for cameras and screens is nobody while its huddle is closed to its bar. */
  wanted(): UserId[];
  /** Whether the room is asked for them by name, as it is for cameras and screens, and so stops sending whoever isn't named. */
  byName: boolean;
  /** Whether the tab shows them small, which it tells the room of cameras, for the smaller of the sizes one is sent in. */
  small?(): boolean;
  /** Plays someone's track, from when the tab is offered it until it's stopped. */
  play(userId: UserId, track: MediaStreamTrack): void;
  stop(userId: UserId): void;
}

/** One of a tab's sending connections, which publishes a track: its microphone, its camera while that's on, or its screen while that's shared. */
function sendingConnection({ kind, vital, track, sends }: Sent, { send, rejoin, isOver, connect, relayRunOut }: Huddled) {
  let connection: RTCPeerConnection | null = null;
  /** The connection whose offer the room has yet to answer, which the tab may have given up since. */
  let unanswered: RTCPeerConnection | null = null;
  /** Runs out on the room's answer to that offer, or brings the next time the tab publishes. */
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The sizes the connection was made to send its track in, the largest last. */
  let sizes: RTCRtpEncodingParameters[] = [];
  /** Whether the SFU has failed to take the track, which may be for the sizes it was offered in: it goes out in one from then on. */
  let inOneSize = false;
  const wait = growingWait(PUBLISH_AGAIN_MS);

  /** How a connection sends `sending`: as the tab would, or once the SFU has failed to take that, whole, in the largest of those sizes alone. */
  function sentAs(sending: MediaStreamTrack): RTCRtpTransceiverInit {
    const sent = sends(sending);
    const largest = sent.sendEncodings?.at(-1);
    return inOneSize && largest ? { ...sent, sendEncodings: [{ maxBitrate: largest.maxBitrate }] } : sent;
  }

  /**
   * Publishes the track from a new connection, with the offer the connection makes for it, in place of
   * the connection there was. An offer waits for the answer the room owes, which doesn't say which offer
   * it's to.
   */
  async function publish() {
    close();
    const publishing = track();
    if (!publishing || publishing.readyState === "ended" || unanswered) return;
    const made = (connection = connect());
    const sent = sentAs(publishing);
    sizes = sent.sendEncodings ?? [];
    const transceiver = made.addTransceiver(publishing, sent);
    made.onconnectionstatechange = () => {
      if (connection !== made) return;
      if (made.connectionState === "failed") return relayRunOut() ? rejoin() : publishLater();
      if (made.connectionState !== "connected") return;
      wait.startOver();
      send({ type: "huddle.connected", kind });
    };
    let offer: string | undefined;
    try {
      await made.setLocalDescription(await made.createOffer());
      offer = made.localDescription?.sdp;
    } catch {
      // Published again below, as an offer that couldn't be made.
    }
    if (connection !== made) return;
    if (!offer || transceiver.mid === null) return publishLater();
    // Unsent, the socket is down, and the room's welcome on the next one publishes.
    if (!send({ type: "huddle.publish", sdp: offer, tracks: [{ mid: transceiver.mid, kind }] })) return;
    unanswered = made;
    timer = setTimeout(leftUnanswered, ANSWER_TIMEOUT_MS);
  }

  /** Publishes again in a while, longer each time until a sending connection has connected. */
  function publishLater() {
    close();
    if (!unanswered && !isOver()) timer = setTimeout(() => void publish(), wait.take());
  }

  function leftUnanswered() {
    if (vital) return rejoin();
    unanswered = null;
    publishLater();
  }

  /**
   * Gives the connection the SFU's answer to the offer it published with, after which it connects. The
   * answer to an offer the tab has given up is dropped, and what there is to publish now goes out.
   */
  async function published(sdp: string) {
    const answered = unanswered;
    if (!answered) return;
    unanswered = null;
    clearTimeout(timer);
    if (answered !== connection) return void publish();
    try {
      await answered.setRemoteDescription({ type: "answer", sdp });
    } catch {
      if (connection === answered) publishLater();
      return;
    }
    if (connection === answered) await sendWhole(answered);
  }

  /**
   * Sends the track whole on a connection made to send it in several sizes, of which the SFU's answer
   * took one. The browser is left sending the first alone, the smallest, which becomes as large as
   * the largest was to be, at as many bits a second.
   */
  async function sendWhole(answered: RTCPeerConnection) {
    const [sender] = answered.getSenders();
    const largest = sizes.at(-1);
    if (!sender || !largest || sizes.length < 2) return;
    const parameters = sender.getParameters();
    const [only, ...others] = parameters.encodings;
    if (!only || others.length > 0) return;
    only.maxBitrate = largest.maxBitrate;
    only.scaleResolutionDownBy = largest.scaleResolutionDownBy ?? 1;
    await sender.setParameters(parameters).catch(() => {});
  }

  /**
   * Sends the track there is now in place of the one the connection sent, which the others receive as
   * the same track still. Without a connection, with one that can't, or with one made to send another
   * number of sizes than this track goes out in, it publishes anew.
   */
  async function swap() {
    const swapping = connection;
    const next = track();
    const fits = next !== null && (sentAs(next).sendEncodings ?? []).length === sizes.length;
    const swapped =
      fits &&
      (await swapping?.getSenders()[0]?.replaceTrack(next).then(
        () => true,
        () => false,
      ));
    if (!swapped && connection === swapping) void publish();
  }

  /** Closes the connection, which sends nothing more. What the room owes an answer to, it still owes. */
  function close() {
    if (!unanswered) clearTimeout(timer);
    connection?.close();
    connection = null;
  }

  return {
    publish,
    published,
    swap,
    close,
    /** The room couldn't publish what it was asked to: the SFU refused, or couldn't be reached, unless the room `refused` it itself. */
    failed(refused = false) {
      const answered = unanswered;
      if (!answered) return;
      unanswered = null;
      clearTimeout(timer);
      if (!refused) inOneSize = true;
      if (answered === connection) publishLater();
      else void publish();
    },
    /** The SFU has lost what was published, which the offer the tab waits on the answer to publishes anew already. */
    unpublished() {
      if (!unanswered) void publish();
    },
    /** The socket is gone, and with it what the room owed an answer to. */
    hangUp() {
      unanswered = null;
      close();
    },
    startOver: wait.startOver,
  };
}

/**
 * One of a tab's receiving connections, on which the SFU offers the tab whoever it would receive and
 * doesn't yet, a round at a time: the tab asks (`huddle.listen`), answers the offer if one comes, and
 * the room says `huddle.listening`.
 */
function receivingConnection({ kind, vital, receivable, wanted, byName, small, play, stop }: Received, { send, rejoin, isOver, connect, relayRunOut }: Huddled) {
  let connection: RTCPeerConnection | null = null;
  /** Whom the tab has been offered, and so receives. */
  const heard = new Set<UserId>();
  /** Whether the tab last asked the room for them small. */
  let askedSmall = false;
  /** The round under way: whether it has brought an offer, and whether the tab has given up the connection it asked on meanwhile. */
  let round: { offered: boolean; givenUp: boolean } | null = null;
  /** Runs out on the room's answer to that round, or brings the next. */
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = growingWait(LISTEN_AGAIN_MS);

  const isUnheard = () => wanted().some((userId) => !heard.has(userId));
  /** Whom the tab receives and would no longer, as once it stops showing cameras and screens. The room goes on sending them until it's asked for the others by name. */
  const unwanted = () => (byName ? [...heard].filter((userId) => !wanted().includes(userId)) : []);
  const isSmall = () => small?.() === true;
  /** Whether the tab shows whom it receives in another size than it last told the room, which sends it that size once it's told. */
  const isResized = () => heard.size > 0 && isSmall() !== askedSmall;
  /** What a round asks of the room: on a fresh connection when the tab has none, by name, for whom, and small, if that's how the tab shows them. */
  const asking = (): HuddleClientFrame => ({ type: "huddle.listen", kind, ...(!connection && { fresh: true as const }), ...(byName && { watch: wanted() }), ...(isSmall() && { small: true as const }) });

  /**
   * Starts a round, unless one is under way: asks for whoever the tab would receive and doesn't, or with
   * `anyone`, whoever the room finds it doesn't, and for those it receives in the size it shows them
   * in now. Whoever it would no longer receive is forgotten as it asks.
   */
  function listen(anyone = false) {
    if (isOver() || round) return;
    clearTimeout(timer);
    const dropped = unwanted();
    if (!anyone && dropped.length === 0 && !isUnheard() && !isResized()) return;
    if (!send(asking())) return;
    askedSmall = isSmall();
    dropped.forEach(forget);
    round = { offered: false, givenUp: false };
    timer = setTimeout(leftUnanswered, ANSWER_TIMEOUT_MS);
  }

  function listenLater() {
    timer = setTimeout(() => listen(), wait.take());
  }

  function endRound() {
    clearTimeout(timer);
    round = null;
  }

  function leftUnanswered() {
    if (vital) return rejoin();
    endRound();
    listenAfresh();
  }

  /**
   * Answers the SFU's offer of `tracks` from the connection, and plays them. An offer the tab can't
   * answer, or one to a connection it has given up, is the last the room says of the round: it lets go
   * of its side of the connection as the tab asks for a fresh one.
   */
  async function offered(sdp: string, tracks: OfferedHuddleTrack[]) {
    const asked = round;
    if (!asked) return;
    asked.offered = true;
    const answer = asked.givenUp ? undefined : await answerTo(sdp, tracks);
    // The socket has gone meanwhile, or the tab has left.
    if (round !== asked) return;
    if (answer !== undefined && !asked.givenUp) return void send({ type: "huddle.answer", kind, sdp: answer });
    endRound();
    close();
    listenLater();
  }

  /**
   * The connection's answer to an offer of `tracks`, which it plays, or undefined when it can't make
   * one. The first offer makes the connection. The tab receives whoever the offer names from when it
   * comes, though the connection takes a moment to have their tracks: whoever leaves or begins publishing
   * anew in that moment is forgotten, and isn't played what the offer carries of them, which is of before.
   * It receives them whether or not it would by now, as when its huddle closed to its bar while the
   * offer was on its way: the room sends them from the answer on, and offers nobody twice, so they're
   * the tab's to play, or to stop being sent in its next round.
   */
  async function answerTo(sdp: string, tracks: OfferedHuddleTrack[]): Promise<string | undefined> {
    const made = (connection ??= open());
    const present = receivable();
    for (const { userId } of tracks) if (present.includes(userId)) heard.add(userId);
    try {
      await made.setRemoteDescription({ type: "offer", sdp });
      if (connection !== made) return undefined;
      for (const track of tracks) playFrom(made, track);
      await made.setLocalDescription(await made.createAnswer());
      return made.localDescription?.sdp;
    } catch {
      return undefined;
    }
  }

  function open(): RTCPeerConnection {
    const made = connect();
    made.onconnectionstatechange = () => {
      if (connection !== made || made.connectionState !== "failed") return;
      if (relayRunOut()) rejoin();
      else listenAfresh();
    };
    return made;
  }

  /**
   * Plays the track the SFU offered of someone the tab receives, which the connection has on the media
   * section the offer named. Not of someone who had left as the offer came, or couldn't be received
   * then, nor of someone the tab has forgotten since: the track is of what they published before, and
   * the tab asks for what they publish next.
   */
  function playFrom(from: RTCPeerConnection, { mid, userId }: OfferedHuddleTrack) {
    const theirs = from.getTransceivers().find((transceiver) => transceiver.mid === mid)?.receiver.track;
    if (theirs && heard.has(userId)) play(userId, theirs);
  }

  /**
   * The room has answered what the tab asked, which ends the round. After one that brought an offer the
   * tab asks again at once: for whoever the offer left out, and for anyone who began publishing anew
   * while it was made, whose track in it carries nothing. It asks at once, too, when it would no longer
   * receive someone it does, or shows them in another size than it asked for. After a round that
   * brought no offer it asks in a while, for whoever the SFU couldn't offer yet, and with nobody to
   * ask for by name, and nobody received, it closes the connection.
   */
  function listening() {
    if (!round) return;
    const { offered: wasOffered, givenUp } = round;
    endRound();
    if (wasOffered && !givenUp) {
      wait.startOver();
      return listen(true);
    }
    if (unwanted().length > 0 || isResized()) return listen();
    if (givenUp || isUnheard()) return listenLater();
    if (byName && heard.size === 0) close();
  }

  /**
   * Gives up the connection, which has failed or which the room has let go of, to receive everyone on a
   * new one, which the tab asks for in a while, once the round under way is over.
   */
  function listenAfresh() {
    close();
    if (round) round.givenUp = true;
    else listenLater();
  }

  /** Stops receiving `userId`, who left, or can't be received for the moment: what the tab had of them carries nothing more. */
  function forget(userId: UserId) {
    heard.delete(userId);
    stop(userId);
  }

  function close() {
    connection?.close();
    connection = null;
    for (const userId of [...heard]) forget(userId);
  }

  return {
    listen,
    offered,
    listening,
    forget,
    /** The room couldn't do what the round asked, and has let go of its side of the connection. */
    failed() {
      if (!round) return;
      endRound();
      listenAfresh();
    },
    /** The socket is gone, and the round with it. */
    hangUp() {
      close();
      endRound();
    },
    startOver: wait.startOver,
  };
}

/** Joins room `roomId`'s huddle, which starts it when nobody's in it, leaving any the tab was in. */
export function joinHuddle({ roomId, muted, microphone, camera, speakerId, invite = [] }: HuddleJoin): void {
  leaveHuddle();
  /** The microphone the tab speaks through, and its track, until its person chooses another. */
  let voice = microphone;
  let track = voice?.getAudioTracks()[0] ?? null;
  let huddle: JoinedHuddle = {
    roomId,
    connected: false,
    you: null,
    people: [],
    muted: muted || !track,
    microphone: track !== null,
    microphoneId: microphoneOf(voice),
    speakerId,
    camera: null,
    watched: new Map(),
    screen: null,
    screens: new Map(),
    open: true,
    thread: true,
  };
  let over = false;
  if (track) track.enabled = !huddle.muted;
  /** How many times its person has chosen a microphone in place of the tab's: one the browser opens for any choice but the last is closed again. */
  let microphonesAsked = 0;
  /** Whether the browser is being asked for a camera. */
  let openingCamera = false;
  /** Whether the browser is asking the tab's person what to share. */
  let choosingScreen = false;
  /** Whether the huddle, opened, last showed people in tiles small enough for the smaller of a camera's sizes. */
  let smallTiles = false;

  const letScreenSleep = keepScreenAwake();
  const speaker = huddleSpeaker(speakerId);
  const speaking = whoSpeaks(showSpeaking);
  const voices = voicesThrough(speaker, speaking);
  const sounds = huddleSounds(speaker);

  const socket = reconnectingSocket<HuddleClientFrame>({
    url: () => huddleSocketUrl(roomId, huddle.muted),
    onMessage: (data) => {
      const frame = parseServerFrame<HuddleServerFrame>(data);
      if (frame && !over) hear(frame);
    },
    // However the socket was lost: one that stops answering goes without a close.
    onConnecting: (status) => {
      if (status === "reconnecting") roomLost();
    },
    onClose: (code) => {
      const ending = ENDINGS[code];
      if (ending === undefined) return true;
      stop();
      if (ending === null) showHuddle(null);
      else endHuddle(ending);
      return false;
    },
  });

  // By Cloudflare's STUN server alone, until the room's welcome says otherwise.
  let reach = reachBy(undefined);
  const huddled: Huddled = { send: (frame) => socket.send(frame), rejoin, isOver: () => over, connect: () => connectionBy(reach.configuration), relayRunOut: () => hasRunOut(reach) };
  /** Everyone else in the huddle whose track of `kind` can be received. */
  const receivable = (kind: HuddleTrackKind) => huddle.people.filter((person) => person.user.id !== huddle.you?.id && person[kind]).map(({ user }) => user.id);
  /** The track of what the tab shows by `kind`, or null while it shows nothing by it. */
  const shownTrack = (kind: ShownKind) => huddle[SHOWN[kind].own]?.getVideoTracks()[0] ?? null;
  /** Takes down what the tab shows by each kind once its track ends: a camera unplugged, or a screen its person stops sharing from the browser's own bar. */
  const ended: Record<ShownKind, () => void> = { video: () => takeDown("video"), screen: () => takeDown("screen") };

  // The connections that carry the voices, which a huddle has throughout, and those for cameras and for
  // screens, each of which it has while it shows its own, and while it's open and someone else shows theirs.
  const showing = (kind: ShownKind) => sendingConnection({ kind, vital: false, track: () => shownTrack(kind), sends: (track) => ({ direction: "sendonly", sendEncodings: SHOWN[kind].sizes(track) }) }, huddled);
  const watching = (kind: ShownKind) =>
    receivingConnection(
      {
        kind,
        vital: false,
        receivable: () => receivable(kind),
        wanted: () => (huddle.open ? receivable(kind).slice(0, SHOWN[kind].most) : []),
        byName: true,
        // Only cameras come in sizes.
        ...(kind === "video" && { small: () => smallTiles }),
        ...pictures(kind),
      },
      huddled,
    );
  const sending = {
    audio: sendingConnection({ kind: "audio", vital: true, track: () => track, sends: () => ({ direction: "sendonly" }) }, huddled),
    video: showing("video"),
    screen: showing("screen"),
  };
  const receiving = {
    audio: receivingConnection({ kind: "audio", vital: true, receivable: () => receivable("audio"), wanted: () => receivable("audio"), byName: false, play: voices.play, stop: voices.stop }, huddled),
    video: watching("video"),
    screen: watching("screen"),
  };

  const controls: HuddleControls = {
    leave() {
      stop();
      showHuddle(null);
    },
    setMuted(to) {
      if (!track || !huddle.microphone || to === huddle.muted) return;
      track.enabled = !to;
      socket.send({ type: "huddle.mute", muted: to });
      show({ muted: to });
    },
    setCamera(on) {
      if (on) turnCameraOn();
      else takeDown("video");
    },
    setScreen(shared) {
      if (shared) void shareScreen();
      else takeDown("screen");
    },
    // Only an open huddle watches cameras and screens, so the tab asks for them as it opens, and for none as it closes.
    setOpen(open) {
      if (open === huddle.open) return;
      show({ open });
      for (const kind of SHOWN_KINDS) receiving[kind].listen();
    },
    setThread(shown) {
      if (shown !== huddle.thread) show({ thread: shown });
    },
    // The tab is sent the size of each camera that its tiles show, so it asks again as they come to show another.
    setSmall(small) {
      smallTiles = small;
      receiving.video.listen();
    },
    setDevice(kind, deviceId) {
      if (kind === "microphone") return void speakThrough(deviceId);
      if (kind === "camera") return showThrough(deviceId);
      void playThrough(deviceId);
    },
    switchCamera() {
      void showOtherCamera();
    },
    invite(userIds) {
      return socket.send({ type: "huddle.invite", userIds });
    },
  };

  /** Shows the huddle with `changes`, the tab's person among its people muted as the tab is. */
  function show(changes: Partial<JoinedHuddle>) {
    if (over) return;
    const next = { ...huddle, ...changes };
    const people = next.people.map((person) => (person.user.id === next.you?.id && person.muted !== next.muted ? { ...person, muted: next.muted } : person));
    showHuddle((huddle = { ...next, people }), controls);
    sounds.setAlone(isAlone(huddle));
  }

  // A microphone that's unplugged, or that the browser stops letting the page use, leaves its person listening.
  const microphoneGone = () => {
    if (huddle.you) speaking.forget(huddle.you.id);
    socket.send({ type: "huddle.mute", muted: true });
    show({ muted: true, microphone: false, microphoneId: "" });
  };
  track?.addEventListener("ended", microphoneGone);

  /**
   * Speaks through another microphone: once the browser has opened it, the connection sends its track
   * in place of the one before, which is closed. The tab stays as muted as it was, and one that only
   * listened for want of a microphone has one to unmute. A microphone the browser won't open changes
   * nothing, which the tab's person is told. Of several chosen while the browser opens them, the last
   * is the one, which may be the one the tab has.
   */
  async function speakThrough(deviceId: string) {
    rememberDevice("microphone", deviceId);
    const asking = ++microphonesAsked;
    if (huddle.microphone && deviceId === huddle.microphoneId) return;
    const opened = await openMicrophone(deviceId);
    if (over || asking !== microphonesAsked) return closeDevice(opened);
    const next = opened?.getAudioTracks()[0];
    if (!next) return tellOfHuddle(huddle.microphone ? NO_OTHER_MICROPHONE : STILL_NO_MICROPHONE);
    track?.removeEventListener("ended", microphoneGone);
    closeDevice(voice);
    [voice, track] = [opened, next];
    next.enabled = !huddle.muted;
    next.addEventListener("ended", microphoneGone);
    if (huddle.you) speaking.hear(huddle.you.id, next);
    show({ microphone: true, microphoneId: microphoneOf(opened) });
    // A tab the room has yet to let in, or let back in, publishes it with the room's welcome.
    if (huddle.connected) void sending.audio.swap();
  }

  /**
   * Plays the huddle through another speaker, which this browser's next huddle starts with, once the
   * browser plays through it. One it won't play through changes nothing, which the tab's person is told.
   */
  async function playThrough(deviceId: string) {
    const played = await speaker.use(deviceId);
    if (over) return;
    if (!played) return tellOfHuddle(NO_OTHER_SPEAKER);
    rememberDevice("speaker", deviceId);
    show({ speakerId: deviceId });
  }

  /** Turns the camera on: asks the browser for one, which asks the person the first time, and shows it. */
  function turnCameraOn() {
    if (!over && !huddle.camera && !openingCamera) void showOnceOpen(openCamera(rememberedDevice("camera")));
  }

  /**
   * Shows another camera, which this browser's next huddle starts with. One that's off turns on with
   * it, and one that's on gives way to it. One chosen while the browser opens another isn't taken up.
   */
  function showThrough(deviceId: string) {
    if (over || openingCamera) return;
    rememberDevice("camera", deviceId);
    if (!huddle.camera) return void showOnceOpen(openCamera(deviceId));
    if (deviceId !== cameraOf(huddle.camera)) void showInstead(() => openCamera(deviceId));
  }

  /**
   * Switches from the camera that's on to the one that faces the other way, as a phone's back camera
   * does from its front one, or to the next the browser lists, which this browser's next huddle starts
   * with. A camera that's off stays off.
   */
  async function showOtherCamera() {
    const other = await showInstead(openOtherCamera);
    if (other) rememberDevice("camera", cameraOf(other));
  }

  /**
   * Shows the camera `open` opens in place of the one that's on, whose device and which way it faced
   * `open` is given, and answers it once it shows. The one that's on is let go of first, since a phone
   * opens one camera at a time, and the others go on watching what takes its place as the same camera.
   * Where the browser won't open that, the one before comes back on, and the tab's person is told, as
   * they are of a camera left off because the browser wouldn't open that one again either. Nothing
   * is asked of the browser while it opens a camera already.
   */
  async function showInstead(open: (deviceId: string, facing: CameraFacing | null) => Promise<MediaStream | null>): Promise<MediaStream | null> {
    const shown = huddle.camera;
    if (over || openingCamera || !shown) return null;
    openingCamera = true;
    const deviceId = cameraOf(shown);
    const facing = facingOf(shown);
    shown.getVideoTracks()[0]?.removeEventListener("ended", ended.video);
    closeDevice(shown);
    const other = await open(deviceId, facing);
    // Left meanwhile, or turned off, when there's none for it to take the place of.
    const gone = () => over || huddle.camera !== shown;
    const opened = other ?? (gone() ? null : await openCamera(deviceId || null));
    openingCamera = false;
    if (gone()) {
      closeDevice(opened);
      return null;
    }
    if (!other) tellOfHuddle(opened ? NO_OTHER_CAMERA : CAMERA_WENT_OFF);
    if (!opened) {
      takeDown("video");
      return null;
    }
    opened.getVideoTracks()[0]?.addEventListener("ended", ended.video);
    show({ camera: opened });
    if (huddle.connected) void sending.video.swap();
    return other;
  }

  /** Shows the camera the browser is opening, once it has, or tells the tab's person that there's none for it. */
  async function showOnceOpen(opening: Promise<MediaStream | null>) {
    openingCamera = true;
    const stream = await opening;
    openingCamera = false;
    if (over) return closeDevice(stream);
    if (stream) showOwn("video", stream);
    else tellOfHuddle(NO_CAMERA);
  }

  /**
   * Shares the tab's screen: the browser asks its person what to share, each time, and the huddle shows
   * the others what they choose. Choosing nothing shares nothing. With as many screens shared as a
   * huddle shows, the room would refuse another, so its person hears that before the browser asks them.
   */
  async function shareScreen() {
    if (over || huddle.screen || choosingScreen) return;
    if (receivable("screen").length >= MAX_HUDDLE_SCREENS) return tellOfHuddle(SCREENS_FULL);
    choosingScreen = true;
    const chosen = await openScreen().catch(() => {
      if (!over) tellOfHuddle(NO_SCREEN);
      return null;
    });
    choosingScreen = false;
    if (over) return closeDevice(chosen);
    if (chosen) showOwn("screen", chosen);
  }

  /** Shows the tab's person what they show the others by `kind`, their camera or their screen, and publishes it, which the room's welcome does for a tab that isn't in yet. */
  function showOwn(kind: ShownKind, stream: MediaStream) {
    stream.getVideoTracks()[0]?.addEventListener("ended", ended[kind]);
    show({ [SHOWN[kind].own]: stream });
    sending[kind].startOver();
    if (huddle.connected) void sending[kind].publish();
  }

  /**
   * Takes down what the tab shows by `kind`: stops it, which puts a camera's light out and ends the
   * browser's sharing of a screen, and has the room take down what the tab published of it. A camera
   * that's unplugged, and a screen that its person stops sharing from the browser's own bar, go the same way.
   */
  function takeDown(kind: ShownKind) {
    const stream = huddle[SHOWN[kind].own];
    if (!stream) return;
    stream.getVideoTracks()[0]?.removeEventListener("ended", ended[kind]);
    closeDevice(stream);
    show({ [SHOWN[kind].own]: null });
    sending[kind].close();
    socket.send({ type: "huddle.unpublish", kind });
  }

  /** What the others show by `kind`, their cameras or their screens, as the huddle keeps them: each from when the tab is offered it, until it's stopped. */
  function pictures(kind: ShownKind) {
    const kept = SHOWN[kind].theirs;
    return {
      play(userId: UserId, picture: MediaStreamTrack) {
        show({ [kept]: new Map(huddle[kept]).set(userId, new MediaStream([picture])) });
      },
      stop(userId: UserId) {
        if (!huddle[kept].has(userId)) return;
        const left = new Map(huddle[kept]);
        left.delete(userId);
        show({ [kept]: left });
      },
    };
  }

  /**
   * Leaves for good: the socket closes, which is how the room hears, and so do the connections, the
   * microphone, the camera and the screen it shares, and a phone's own screen is left to sleep again.
   * A tab the room had let in hears the leaving sound, however its huddle ended.
   */
  function stop() {
    over = true;
    socket.close();
    hangUp();
    letScreenSleep();
    voices.stopAll();
    speaking.stop();
    showSpeaking(new Set());
    sounds.end(huddle.you !== null);
    speaker.stopAll();
    track?.removeEventListener("ended", microphoneGone);
    closeDevice(voice);
    for (const kind of SHOWN_KINDS) {
      shownTrack(kind)?.removeEventListener("ended", ended[kind]);
      closeDevice(huddle[SHOWN[kind].own]);
    }
  }

  /** The socket is gone, and the connections with it, which the room has the SFU close. The next socket's welcome starts them again. */
  function roomLost() {
    hangUp();
    if (huddle.connected) show({ connected: false });
  }

  /** Joins again on a new socket, the room having left something the tab asked unanswered, or the tab's way through the relay having run out. */
  function rejoin() {
    socket.hold();
    socket.retry();
  }

  function hangUp() {
    for (const kind of HUDDLE_TRACK_KINDS) {
      sending[kind].hangUp();
      receiving[kind].hangUp();
    }
  }

  /** Asks for whoever the tab would hear or watch and doesn't, now that who's in the huddle, or what they publish, has changed. */
  function listen() {
    for (const kind of HUDDLE_TRACK_KINDS) receiving[kind].listen();
  }

  /**
   * The room couldn't do what a frame asked for one of the connections, which starts over. A camera or
   * a screen it refused, the huddle showing as many as it does or an administrator having them off, is
   * taken down instead, and its person is told, as they are when nobody they invited was.
   */
  function couldNot({ failed, kind = "audio", refused, message }: Extract<HuddleServerFrame, { type: "error" }>) {
    if (failed === "huddle.invite") return tellOfHuddle(message);
    if (failed === "huddle.listen" || failed === "huddle.answer") return receiving[kind].failed();
    if (failed !== "huddle.publish") return;
    if (refused && kind !== "audio") {
      takeDown(kind);
      tellOfHuddle(message);
    }
    sending[kind].failed(refused);
  }

  function hear(frame: HuddleServerFrame) {
    switch (frame.type) {
      case "huddle.welcome": {
        socket.connected();
        reach = reachBy(frame.iceServers);
        for (const kind of HUDDLE_TRACK_KINDS) {
          sending[kind].startOver();
          receiving[kind].startOver();
        }
        // The address said whether the tab was muted as it asked to join, which it may not be now.
        const mine = frame.people.find(({ user }) => user.id === frame.you.id);
        if (mine && mine.muted !== huddle.muted) socket.send({ type: "huddle.mute", muted: huddle.muted });
        // Let in, and not let back in after the tab's connection to the room dropped.
        if (!huddle.you) {
          sounds.joined();
          // Its own person speaks by the microphone, now that the room has said who they are.
          if (track && huddle.microphone) speaking.hear(frame.you.id, track);
          // Whoever starts a direct message's huddle invites the others in it, which being let back in doesn't do again.
          if (invite.length > 0 && frame.people.every(({ user }) => user.id === frame.you.id)) socket.send({ type: "huddle.invite", userIds: invite });
        }
        show({ connected: true, you: frame.you, people: frame.people, messageId: frame.messageId });
        for (const kind of HUDDLE_TRACK_KINDS) void sending[kind].publish();
        return listen();
      }
      case "huddle.joined":
      case "huddle.changed": {
        const { person } = frame;
        for (const kind of HUDDLE_TRACK_KINDS) if (!person[kind]) receiving[kind].forget(person.user.id);
        const known = huddle.people.some(({ user }) => user.id === person.user.id);
        if (!known) sounds.joined();
        show({ people: known ? huddle.people.map((other) => (other.user.id === person.user.id ? person : other)) : [...huddle.people, person] });
        return listen();
      }
      case "huddle.left":
        for (const kind of HUDDLE_TRACK_KINDS) receiving[kind].forget(frame.userId);
        if (huddle.people.some(({ user }) => user.id === frame.userId)) sounds.left();
        return show({ people: huddle.people.filter(({ user }) => user.id !== frame.userId) });
      case "huddle.published":
        return void sending[frame.kind].published(frame.sdp);
      case "huddle.unpublished":
        return sending[frame.kind].unpublished();
      case "huddle.offer":
        return void receiving[frame.kind].offered(frame.sdp, frame.tracks);
      case "huddle.listening":
        return receiving[frame.kind].listening();
      case "error":
        return couldNot(frame);
      case "pong":
        return;
    }
  }

  show({});
  if (camera instanceof Promise) void showOnceOpen(camera);
  else if (camera) showOwn("video", camera);
}
