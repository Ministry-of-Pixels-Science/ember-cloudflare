import { CloseCode, type User } from "@ember/protocol";
import {
  CAMERA_SIZES,
  CAMERAS_FULL,
  CAMERAS_OFF,
  HuddleCloseCode,
  MAX_HUDDLE_CAMERAS,
  MAX_HUDDLE_SCREENS,
  NOBODY_INVITED,
  RELAY_TTL_S,
  SCREENS_FULL,
  SCREENS_OFF,
  type HuddleIceServer,
  type HuddlePerson,
  type HuddleServerFrame,
  type HuddleTrackKind,
  type OfferedHuddleTrack,
} from "@ember/protocol/huddles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioEngine } from "@/test-audio-engine";
import { ANSWER_TIMEOUT_MS, CAMERA_BITRATE, joinHuddle, LISTEN_AGAIN_MS, PUBLISH_AGAIN_MS, SCREEN_BITRATE, SMALL_CAMERA_BITRATE } from "./huddle";
import { CAMERA_WENT_OFF, NO_CAMERA, NO_OTHER_CAMERA, NO_OTHER_MICROPHONE, NO_OTHER_SPEAKER, NO_SCREEN, STILL_NO_MICROPHONE } from "./huddle-devices";
import { MUSIC_AFTER_MS } from "./huddle-sounds";
import { MEASURED_EVERY_MS, SPEAKING_LEVEL } from "./huddle-speaking";
import { chooseHuddleDevice, hearHuddle, isSpeaking, joinedHuddle, leaveHuddle, muteHuddle, openHuddle, shareHuddleScreen, showHuddleCamera, switchHuddleCamera, takeCamerasSmall, watchHuddle, watchSpeaking } from "./huddle-store";

/** Stands in for the browser's WebSocket; tests play the room and the network. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  /** What the tab has sent, but for its socket's pings. */
  sent: Array<Record<string, unknown>> = [];
  /** Whether the socket's pings go unanswered, as on a network that has dropped without closing it. */
  silent = false;
  closedWith: number | undefined;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  /** Answers a ping as the runtime does for the room, and keeps anything else for the test. */
  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame.type !== "ping") this.sent.push(frame);
    else if (!this.silent) this.receive({ type: "pong" });
  }

  close(code?: number) {
    this.closedWith = code ?? 1005;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: this.closedWith }));
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(frame: HuddleServerFrame) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  /** Closes as the network or the room does: 1006 when the connection drops. */
  drop(code = 1006) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code }));
  }

  /** What the tab has sent since the test last asked. */
  take() {
    return this.sent.splice(0);
  }
}

/** Stands in for a microphone's track, a camera's or a shared screen's, or one a connection receives. */
class FakeTrack extends EventTarget {
  enabled = true;
  readyState: MediaStreamTrackState = "live";
  contentHint = "";

  constructor(
    readonly kind: HuddleTrackKind = "audio",
    /** The device it's from, by its id, where the browser says. */
    readonly deviceId = "",
    /** How large its picture is, and which way its camera faces, where the browser says. */
    readonly said: { width?: number; height?: number; facingMode?: string } = {},
  ) {
    super();
  }

  getSettings() {
    return { deviceId: this.deviceId, ...this.said };
  }

  stop() {
    this.readyState = "ended";
  }

  /** Ends as an unplugged microphone's does, or camera's, or a screen's that its person stops sharing from the browser's own bar. */
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[] = []) {}
  getTracks = () => this.tracks;
  getAudioTracks = () => this.tracks.filter(({ kind }) => kind === "audio");
  getVideoTracks = () => this.tracks.filter(({ kind }) => kind === "video");
}

/**
 * Stands in for what sends a track over a connection, which a browser has send another in its place,
 * unless the connection has closed, and in the sizes the connection was made to send, or what's left
 * of them: the first alone, once an answer has taken one.
 */
class FakeSender {
  readonly #connection: FakeConnection;
  #sizes: RTCRtpEncodingParameters[];

  constructor(
    connection: FakeConnection,
    public track: FakeTrack | null,
    sizes: RTCRtpEncodingParameters[] = [],
  ) {
    this.#connection = connection;
    this.#sizes = sizes;
  }

  async replaceTrack(track: FakeTrack | null) {
    if (FakeConnection.keepingTracks || this.#connection.connectionState === "closed") throw new DOMException("The connection can't send another track", "InvalidStateError");
    this.track = track;
  }

  getParameters() {
    return { encodings: this.#sizes.map((size) => ({ ...size })) };
  }

  async setParameters({ encodings }: { encodings: RTCRtpEncodingParameters[] }) {
    this.#sizes = encodings;
  }

  takeOneSize() {
    this.#sizes = this.#sizes.slice(0, 1);
  }
}

interface FakeTransceiver {
  mid: string | null;
  direction?: string;
  sendEncodings?: RTCRtpEncodingParameters[];
  sender: FakeSender;
  receiver: { track: FakeTrack };
}

/**
 * Stands in for the browser's RTCPeerConnection. Its offers are numbered in the order connections make
 * them, and an offer made to it names the media sections it carries after a colon: `offer:0,1`.
 */
class FakeConnection {
  static all: FakeConnection[] = [];
  static offers = 0;
  /** What the next description set fails with, as a browser refuses one it can't make sense of. */
  static refusing = false;
  /** Whether the connections refuse to send another track in place of the one they send. */
  static keepingTracks = false;
  /** Whether the answers the connections are given take one size of a track sent in several, as an SFU that takes no more does. */
  static takingOneSize = false;
  /** Whether a connection can't be made by a relay's servers, as in a browser that can't make sense of one of them. */
  static refusingRelays = false;

  connectionState: RTCPeerConnectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  transceivers: FakeTransceiver[] = [];

  constructor(readonly configuration: RTCConfiguration) {
    if (FakeConnection.refusingRelays && configuration.iceServers?.some(({ username }) => username !== undefined)) throw new DOMException("Failed to parse the servers", "SyntaxError");
    FakeConnection.all.push(this);
  }

  addTransceiver(track: FakeTrack, { direction, sendEncodings }: RTCRtpTransceiverInit) {
    const transceiver: FakeTransceiver = { mid: null, direction, ...(sendEncodings && { sendEncodings }), sender: new FakeSender(this, track, sendEncodings), receiver: { track: new FakeTrack() } };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers = () => this.transceivers;
  getSenders = () => this.transceivers.map(({ sender }) => sender);

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: `offer ${++FakeConnection.offers}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: `answer to ${this.remoteDescription!.sdp}` };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.refuseIfTold();
    this.localDescription = description;
    this.transceivers.forEach((transceiver, index) => (transceiver.mid ??= String(index)));
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.refuseIfTold();
    this.remoteDescription = description;
    if (description.type !== "offer") {
      if (FakeConnection.takingOneSize) for (const sender of this.getSenders()) sender.takeOneSize();
      return;
    }
    for (const mid of description.sdp!.split(":")[1]!.split(",")) {
      if (!this.transceivers.some((transceiver) => transceiver.mid === mid)) this.transceivers.push({ mid, sender: new FakeSender(this, null), receiver: { track: new FakeTrack() } });
    }
  }

  close() {
    this.connectionState = "closed";
  }

  /** Changes the connection's state, as the browser does once it has connected, or can't. */
  becomes(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  private refuseIfTold() {
    if (!FakeConnection.refusing) return;
    FakeConnection.refusing = false;
    throw new DOMException("Failed to parse the session description", "InvalidAccessError");
  }
}

const ada: User = { id: "u1", name: "Ada" };
const grace: User = { id: "u2", name: "Grace" };
const linus: User = { id: "u3", name: "Linus" };
const person = (user: User, overrides: Partial<HuddlePerson> = {}): HuddlePerson => ({ user, muted: false, audio: true, video: false, screen: false, ...overrides });
const STARTED_AT = "2026-11-10T09:00:00.000Z";

const socket = () => FakeSocket.all.at(-1)!;
const connection = () => FakeConnection.all.at(-1)!;
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** Once what a frame started has run as far as it goes without the room or the browser. */
const settled = () => wait(0);
const voices = () => [...document.querySelectorAll<HTMLAudioElement>("[data-huddle-voices] audio[data-user-id]")];
const voiceOf = (user: User) => voices().find((audio) => audio.dataset.userId === user.id);
/** The huddle's music, while it plays. */
const music = () => document.querySelector<HTMLAudioElement>("[data-huddle-voices] audio[data-huddle-sound=music]");
/** What an `<audio>` is of: the id of the person whose voice it is, or the name of one of the huddle's own sounds. */
const whatIs = (audio: HTMLMediaElement) => audio.dataset.userId ?? audio.dataset.huddleSound;
/** What each call of an `<audio>`'s method was made on, in order. */
const madeOn = (method: { mock: { contexts: unknown[] } }) => (method.mock.contexts as HTMLMediaElement[]).map(whatIs);
/** What the tab has had the browser play, each as often as it was started. */
const played = () => madeOn(vi.mocked(HTMLMediaElement.prototype.play));
/** And what it has had it stop. */
const stopped = () => madeOn(vi.mocked(HTMLMediaElement.prototype.pause));
/** The track `audio` plays, as the stream it was given holds it. */
const playedBy = (audio: HTMLAudioElement | undefined) => (audio?.srcObject as unknown as FakeStream | null | undefined)?.tracks[0];

let microphone: FakeStream;
const microphoneTrack = () => microphone.tracks[0]!;

/** Joins general's huddle, which the room lets the tab into with `people` in it besides Ada, who the tab is. */
async function joined(people: HuddlePerson[] = [], join: Partial<Parameters<typeof joinHuddle>[0]> = {}) {
  joinHuddle({ roomId: "general", muted: false, microphone: microphone as unknown as MediaStream, camera: null, speakerId: "", ...join });
  socket().open();
  return welcomed(people);
}

/** The room lets the newest socket in, to a huddle with `people` in it besides Ada. */
async function welcomed(people: HuddlePerson[] = [], mine: Partial<HuddlePerson> = {}) {
  socket().receive({ type: "huddle.welcome", you: ada, people: [...people, person(ada, { audio: false, muted: joinedHuddle()!.muted, ...mine })], startedAt: STARTED_AT });
  await settled();
  return socket();
}

const offerOf = (kind: HuddleTrackKind, tracks: Array<[mid: string, user: User]>): HuddleServerFrame => ({
  type: "huddle.offer",
  kind,
  sdp: `offer:${tracks.map(([mid]) => mid).join(",")}`,
  tracks: tracks.map(([mid, user]): OfferedHuddleTrack => ({ mid, kind, userId: user.id })),
});

/** The room's offer of the voices on `tracks`, as the SFU makes it. */
const offer = (...tracks: Array<[mid: string, user: User]>) => offerOf("audio", tracks);
/** And of the cameras on `tracks`. */
const pictures = (...tracks: Array<[mid: string, user: User]>) => offerOf("video", tracks);
/** And of the screens shared on `tracks`. */
const screens = (...tracks: Array<[mid: string, user: User]>) => offerOf("screen", tracks);

/** The tab's sending connection has its answer and has connected, which it tells the room. */
async function publishedAndConnected() {
  const sending = connection();
  socket().receive({ type: "huddle.published", kind: "audio", sdp: "the SFU's answer" });
  await settled();
  sending.becomes("connected");
  return sending;
}

/** A round in which the room offers `tracks`, the tab answers, and the room says it's listening. */
async function offeredRound(...tracks: Array<[mid: string, user: User]>) {
  socket().receive(offer(...tracks));
  await settled();
  socket().receive({ type: "huddle.listening", kind: "audio" });
  await settled();
}

/** The same for cameras, and the round the tab asks at once after it, which brings nobody new. */
async function watchedRound(...tracks: Array<[mid: string, user: User]>) {
  socket().receive(pictures(...tracks));
  await settled();
  socket().receive({ type: "huddle.listening", kind: "video" });
  socket().receive({ type: "huddle.listening", kind: "video" });
  await settled();
}

/** And for the screens people share. */
async function sharedRound(...tracks: Array<[mid: string, user: User]>) {
  socket().receive(screens(...tracks));
  await settled();
  socket().receive({ type: "huddle.listening", kind: "screen" });
  socket().receive({ type: "huddle.listening", kind: "screen" });
  await settled();
}

let camera: FakeStream;
const cameraTrack = () => camera.tracks[0]!;
const asCamera = () => camera as unknown as MediaStream;
/** A camera's stream from the device `deviceId`, whose picture is as large as the browser says. */
const cameraFrom = (deviceId: string, width: number, height: number) => new FakeStream([new FakeTrack("video", deviceId, { width, height })]);

/** The tab's camera is published, and its connection has connected. */
async function cameraConnected() {
  const picture = connection();
  socket().receive({ type: "huddle.published", kind: "video", sdp: "the SFU's answer" });
  await settled();
  picture.becomes("connected");
  socket().take();
  return picture;
}

/** What Chrome says of itself, which is known to send a camera in two sizes at once, and what Safari says. */
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
/** The two sizes such a browser sends a camera in: the smaller first, and then the picture whole. */
const TWO_SIZES = [
  { rid: CAMERA_SIZES.small, maxBitrate: SMALL_CAMERA_BITRATE, scaleResolutionDownBy: 2 },
  { rid: CAMERA_SIZES.large, maxBitrate: CAMERA_BITRATE },
];

/** Has the browser say `userAgent` of itself, with the devices the test has given it. */
function browserIs(userAgent: string) {
  vi.stubGlobal("navigator", { userAgent, mediaDevices: navigator.mediaDevices });
}

/** Has the browser give the tab `camera` when it asks for one, or with `none`, refuse. Answers what the tab asked it. */
function browserCamera(none = false) {
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
    if (none) throw new DOMException("Permission denied", "NotAllowedError");
    return camera;
  });
  vi.stubGlobal("navigator", { mediaDevices: Object.assign(new EventTarget(), { getUserMedia }) });
  return getUserMedia;
}

let display: FakeStream;
const displayTrack = () => display.tracks[0]!;

/** Has the browser share `display` once the tab's person has chosen it, or with `failing`, fail as that does. Answers what the tab asked it. */
function browserScreen(failing?: Error) {
  const getDisplayMedia = vi.fn(async (_options: DisplayMediaStreamOptions) => {
    if (failing) throw failing;
    return display;
  });
  vi.stubGlobal("navigator", { mediaDevices: Object.assign(new EventTarget(), { getDisplayMedia }) });
  return getDisplayMedia;
}

/** What the tab has said of one kind of track since the test last asked, leaving the rest for it to ask about. */
function taken(kind: HuddleTrackKind) {
  const { sent } = socket();
  const of = (frame: Record<string, unknown>) => (frame.kind ?? (frame.tracks as Array<{ kind: string }> | undefined)?.[0]?.kind) === kind;
  const frames = sent.filter(of);
  sent.splice(0, sent.length, ...sent.filter((frame) => !of(frame)));
  return frames;
}

/** The connections the tab has made that aren't closed, in the order it made them. */
const open = () => FakeConnection.all.filter(({ connectionState }) => connectionState !== "closed");

beforeEach(() => {
  FakeSocket.all = [];
  FakeConnection.all = [];
  FakeConnection.offers = 0;
  FakeConnection.refusing = false;
  FakeConnection.keepingTracks = false;
  FakeConnection.takingOneSize = false;
  FakeConnection.refusingRelays = false;
  microphone = new FakeStream([new FakeTrack("audio", "built-in")]);
  camera = new FakeStream([new FakeTrack("video", "front")]);
  display = new FakeStream([new FakeTrack("video")]);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("RTCPeerConnection", FakeConnection);
  vi.stubGlobal("MediaStream", FakeStream);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  // The huddle's own sounds, which the page fetches once and keeps a copy of.
  vi.stubGlobal("fetch", async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sound");
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter: back-off delays come out exact
});

afterEach(async () => {
  leaveHuddle();
  // The sound of leaving plays a moment after, while the browser is still stood in for.
  await settled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Joining a huddle", () => {
  it("connects to the room's huddle, and shows it as joining until the room lets the tab in", async () => {
    const shown = vi.fn();
    const stop = watchHuddle(shown);
    joinHuddle({ roomId: "general", muted: false, microphone: microphone as unknown as MediaStream, camera: null, speakerId: "" });

    expect(socket().url).toBe("ws://localhost:3000/api/rooms/general/huddle");
    const joining = { roomId: "general", connected: false, you: null, people: [], muted: false, microphone: true, microphoneId: "built-in", speakerId: "", camera: null, watched: new Map(), screen: null, screens: new Map(), open: true };
    expect(joinedHuddle()).toEqual(joining);
    expect(shown).toHaveBeenCalledTimes(1);
    // Nothing is asked of the room before it has said who the tab is.
    socket().open();
    await settled();
    expect(socket().sent).toEqual([]);
    expect(FakeConnection.all).toEqual([]);

    await welcomed([person(grace)]);
    expect(joinedHuddle()).toEqual({ ...joining, connected: true, you: ada, people: [person(grace), person(ada, { audio: false })] });
    stop();
  });

  it("says in the address that the tab joins muted, and keeps its microphone off", async () => {
    joinHuddle({ roomId: "team/ops", muted: true, microphone: microphone as unknown as MediaStream, camera: null, speakerId: "" });
    expect(socket().url).toBe("ws://localhost:3000/api/rooms/team%2Fops/huddle?muted=1");
    expect(microphoneTrack().enabled).toBe(false);
    expect(joinedHuddle()).toMatchObject({ muted: true, microphone: true });
  });

  it("joins listening only without a microphone: muted, publishing nothing, with nothing to unmute", async () => {
    const room = await joined([person(grace)], { microphone: null });
    expect(room.url).toBe("ws://localhost:3000/api/rooms/general/huddle?muted=1");
    expect(joinedHuddle()).toMatchObject({ muted: true, microphone: false });
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio", fresh: true }]);

    muteHuddle(false);
    expect(joinedHuddle()).toMatchObject({ muted: true });
    expect(room.take()).toEqual([]);
  });

  it("leaves the huddle the tab was in as it joins another", async () => {
    const first = await joined();
    joinHuddle({ roomId: "random", muted: false, microphone: new FakeStream([new FakeTrack()]) as unknown as MediaStream, camera: null, speakerId: "" });

    expect(first.closedWith).toBe(1000);
    expect(microphoneTrack().readyState).toBe("ended");
    expect(socket().url).toBe("ws://localhost:3000/api/rooms/random/huddle");
    expect(joinedHuddle()).toMatchObject({ roomId: "random", connected: false });
  });
});

describe("A huddle's microphone", () => {
  it("is published from a connection of its own once the room lets the tab in, which tells the room when it has connected", async () => {
    const room = await joined();
    const sending = connection();
    expect(sending.configuration).toEqual({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
    expect(sending.transceivers).toEqual([expect.objectContaining({ direction: "sendonly", sender: { track: microphoneTrack() } })]);
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 1", tracks: [{ mid: "0", kind: "audio" }] }]);

    room.receive({ type: "huddle.published", kind: "audio", sdp: "the SFU's answer" });
    await settled();
    expect(sending.remoteDescription).toEqual({ type: "answer", sdp: "the SFU's answer" });
    expect(room.take()).toEqual([]);
    sending.becomes("connecting");
    expect(room.take()).toEqual([]);
    sending.becomes("connected");
    expect(room.take()).toEqual([{ type: "huddle.connected", kind: "audio" }]);
  });

  it("is published again, a little later each time, after its connection fails or the room couldn't publish it", async () => {
    const room = await joined();
    const first = await publishedAndConnected();
    room.take();

    first.becomes("failed");
    expect(first.connectionState).toBe("closed");
    await wait(PUBLISH_AGAIN_MS[0] - 1);
    expect(room.take()).toEqual([]);
    await wait(1);
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 2", tracks: [{ mid: "0", kind: "audio" }] }]);
    expect(connection()).not.toBe(first);

    // The room couldn't: the SFU refused, or couldn't be reached.
    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.publish", kind: "audio" });
    await wait(PUBLISH_AGAIN_MS[0] * 2 - 1);
    expect(room.take()).toEqual([]);
    await wait(1);
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish", sdp: "offer 3" })]);

    // Nor could the browser make sense of the SFU's answer.
    FakeConnection.refusing = true;
    room.receive({ type: "huddle.published", kind: "audio", sdp: "not a session description" });
    await wait(PUBLISH_AGAIN_MS[0] * 4);
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish", sdp: "offer 4" })]);

    // Once one has connected, the next wait is the first again.
    (await publishedAndConnected()).becomes("failed");
    room.take();
    await wait(PUBLISH_AGAIN_MS[0]);
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish", sdp: "offer 5" })]);
  });

  it("waits no longer than the longest wait between tries", async () => {
    const room = await joined();
    for (let tries = 0; tries < 6; tries++) {
      room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.publish", kind: "audio" });
      await wait(PUBLISH_AGAIN_MS[1]);
    }
    room.take();
    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.publish", kind: "audio" });
    await wait(PUBLISH_AGAIN_MS[1] - 1);
    expect(room.take()).toEqual([]);
    await wait(1);
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish" })]);
  });

  it("is published again at once when the room says the SFU has lost it, unless the tab is waiting on an answer already", async () => {
    const room = await joined();
    const first = await publishedAndConnected();
    room.take();

    room.receive({ type: "huddle.unpublished", kind: "audio" });
    await settled();
    expect(first.connectionState).toBe("closed");
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish", sdp: "offer 2" })]);

    // The answer on its way is to the offer just made, which a third would take for its own.
    room.receive({ type: "huddle.unpublished", kind: "audio" });
    await settled();
    expect(room.take()).toEqual([]);
    expect(FakeConnection.all).toHaveLength(2);
    room.receive({ type: "huddle.published", kind: "audio", sdp: "the SFU's answer" });
    await settled();
    expect(connection().remoteDescription).toEqual({ type: "answer", sdp: "the SFU's answer" });
  });

  it("takes no answer it isn't waiting on", async () => {
    const room = await joined();
    await publishedAndConnected();
    room.receive({ type: "huddle.published", kind: "audio", sdp: "another answer" });
    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.publish", kind: "audio" });
    await wait(PUBLISH_AGAIN_MS[1]);
    expect(connection().remoteDescription).toEqual({ type: "answer", sdp: "the SFU's answer" });
    expect(FakeConnection.all).toHaveLength(1);
  });

  it("mutes and unmutes: the track, the room, and the tab's own person among the huddle's", async () => {
    const room = await joined([person(grace)]);
    room.take();

    muteHuddle(true);
    expect(microphoneTrack().enabled).toBe(false);
    expect(room.take()).toEqual([{ type: "huddle.mute", muted: true }]);
    expect(joinedHuddle()).toMatchObject({ muted: true, people: [person(grace), person(ada, { audio: false, muted: true })] });
    // Muting again says nothing.
    muteHuddle(true);
    expect(room.take()).toEqual([]);

    muteHuddle(false);
    expect(microphoneTrack().enabled).toBe(true);
    expect(room.take()).toEqual([{ type: "huddle.mute", muted: false }]);
    expect(joinedHuddle()).toMatchObject({ muted: false, people: [person(grace), person(ada, { audio: false })] });
  });

  it("leaves its person listening once it's unplugged, or the browser takes it away", async () => {
    const room = await joined();
    room.take();

    microphoneTrack().end();
    expect(room.take()).toEqual([{ type: "huddle.mute", muted: true }]);
    expect(joinedHuddle()).toMatchObject({ muted: true, microphone: false, microphoneId: "" });
    muteHuddle(false);
    expect(joinedHuddle()).toMatchObject({ muted: true });
    // And nothing more is published of it.
    room.receive({ type: "huddle.unpublished", kind: "audio" });
    await settled();
    expect(room.take()).toEqual([]);
  });
});

describe("Hearing the others in a huddle", () => {
  it("asks for whoever can be listened to, answers the SFU's offer, and plays each person's track", async () => {
    const room = await joined([person(grace), person(linus, { audio: false })]);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio", fresh: true }, expect.objectContaining({ type: "huddle.publish" })]);
    expect(FakeConnection.all).toHaveLength(1);

    room.receive(offer(["0", grace]));
    await settled();
    const receiving = connection();
    expect(FakeConnection.all).toHaveLength(2);
    expect(receiving.configuration).toEqual({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
    expect(receiving.remoteDescription).toEqual({ type: "offer", sdp: "offer:0" });
    expect(room.take()).toEqual([{ type: "huddle.answer", kind: "audio", sdp: "answer to offer:0" }]);
    expect(voices()).toHaveLength(1);
    expect(playedBy(voiceOf(grace))).toBe(receiving.transceivers[0]!.receiver.track);
    expect(voiceOf(grace)!.autoplay).toBe(true);
    // After the sound of the tab's person joining.
    expect(played()).toEqual(["joined", grace.id]);
    // Kept in the page, where nobody sees them.
    expect(document.querySelector<HTMLElement>("[data-huddle-voices]")!.hidden).toBe(true);
  });

  it("asks once more after a round that brought an offer, for whoever it left out, on the same connection", async () => {
    const room = await joined([person(grace), person(linus)]);
    room.take();
    room.receive(offer(["0", grace]));
    await settled();
    room.take();

    room.receive({ type: "huddle.listening", kind: "audio" });
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio" }]);
    room.receive(offer(["0", grace], ["1", linus]));
    await settled();
    expect(FakeConnection.all).toHaveLength(2);
    expect(room.take()).toEqual([{ type: "huddle.answer", kind: "audio", sdp: "answer to offer:0,1" }]);
    expect(playedBy(voiceOf(linus))).toBe(connection().transceivers[1]!.receiver.track);

    // And once more, since someone may have published anew while that offer was made.
    room.receive({ type: "huddle.listening", kind: "audio" });
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio" }]);
    // A round that brings nobody is the last, with everyone heard.
    room.receive({ type: "huddle.listening", kind: "audio" });
    await wait(LISTEN_AGAIN_MS[1] * 2);
    expect(room.take()).toEqual([]);
  });

  it("asks again in a while for someone the SFU couldn't offer yet, a little longer each time", async () => {
    const room = await joined([person(grace)]);
    room.take();

    for (const expected of [500, 1_000, 2_000, 4_000, 8_000, 8_000]) {
      room.receive({ type: "huddle.listening", kind: "audio" });
      await wait(expected - 1);
      expect(room.take()).toEqual([]);
      await wait(1);
      expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio", fresh: true }]);
    }
    expect([LISTEN_AGAIN_MS[0], LISTEN_AGAIN_MS[1]]).toEqual([500, 8_000]);

    // An offer starts the wait over.
    await offeredRound(["0", grace]);
    room.receive({ type: "huddle.joined", person: person(linus) });
    room.take();
    room.receive({ type: "huddle.listening", kind: "audio" });
    room.receive({ type: "huddle.listening", kind: "audio" });
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio" }]);
  });

  it("asks for someone as they join or become someone to listen to, and for nobody while a round is under way", async () => {
    const room = await joined();
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish" })]);

    // Grace has joined, and her microphone isn't connected yet.
    room.receive({ type: "huddle.joined", person: person(grace, { audio: false }) });
    expect(joinedHuddle()!.people).toEqual([person(ada, { audio: false }), person(grace, { audio: false })]);
    expect(room.take()).toEqual([]);
    room.receive({ type: "huddle.changed", person: person(grace) });
    expect(joinedHuddle()!.people).toEqual([person(ada, { audio: false }), person(grace)]);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio", fresh: true }]);

    // Linus can be listened to before the room has answered: the tab asks once it has.
    room.receive({ type: "huddle.joined", person: person(linus) });
    expect(room.take()).toEqual([]);
    await offeredRound(["0", grace]);
    expect(room.take()).toEqual([{ type: "huddle.answer", kind: "audio", sdp: "answer to offer:0" }, { type: "huddle.listen", kind: "audio" }]);

    // Someone muting is nobody new.
    await offeredRound(["0", grace], ["1", linus]);
    room.receive({ type: "huddle.listening", kind: "audio" });
    room.take();
    room.receive({ type: "huddle.changed", person: person(grace, { muted: true }) });
    expect(joinedHuddle()!.people).toEqual([person(ada, { audio: false }), person(grace, { muted: true }), person(linus)]);
    expect(room.take()).toEqual([]);
    expect(voices()).toHaveLength(2);
  });

  it("stops playing someone who leaves, and someone publishing anew, whose next track it asks for", async () => {
    const room = await joined([person(grace), person(linus)]);
    await offeredRound(["0", grace], ["1", linus]);
    room.receive({ type: "huddle.listening", kind: "audio" });
    room.take();

    room.receive({ type: "huddle.left", userId: linus.id });
    expect(joinedHuddle()!.people).toEqual([person(grace), person(ada, { audio: false })]);
    expect(voices().map((audio) => audio.dataset.userId)).toEqual([grace.id]);
    expect(room.take()).toEqual([]);

    // Grace's connection failed, or she joined from another tab: nothing comes of what the tab heard of her.
    const graces = voiceOf(grace)!;
    room.receive({ type: "huddle.changed", person: person(grace, { audio: false }) });
    expect(voices()).toEqual([]);
    expect(graces.srcObject).toBeNull();
    expect(room.take()).toEqual([]);
    room.receive({ type: "huddle.changed", person: person(grace) });
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio" }]);
    await offeredRound(["2", grace]);
    expect(playedBy(voiceOf(grace))).toBe(connection().transceivers[2]!.receiver.track);
  });

  it("plays no track of someone who left while it was on its way, nor of someone who can't be listened to for the moment", async () => {
    const room = await joined([person(grace), person(linus)]);
    room.take();
    room.receive({ type: "huddle.left", userId: grace.id });
    room.receive({ type: "huddle.changed", person: person(linus, { audio: false }) });
    room.receive(offer(["0", grace], ["1", linus]));
    await settled();
    expect(voices()).toEqual([]);
    // The connection answers all the same, as the SFU waits for it to.
    expect(room.take()).toEqual([{ type: "huddle.answer", kind: "audio", sdp: "answer to offer:0,1" }]);

    // Linus isn't heard yet, so he's asked for once he can be: the round after the offer's, or a later one.
    room.receive({ type: "huddle.listening", kind: "audio" });
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio" }]);
    room.receive({ type: "huddle.changed", person: person(linus) });
    room.receive({ type: "huddle.listening", kind: "audio" });
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio" }]);
    await offeredRound(["2", linus]);
    expect(voices().map((audio) => audio.dataset.userId)).toEqual([linus.id]);
  });

  it("plays no track of someone who began publishing anew as the connection took the offer of it, and asks for what they publish now", async () => {
    const room = await joined([person(grace)]);
    room.take();
    room.receive(offer(["0", grace]));
    // Her connection failed, and she can be listened to again, before the tab's has taken the offer of what she published first.
    room.receive({ type: "huddle.changed", person: person(grace, { audio: false }) });
    room.receive({ type: "huddle.changed", person: person(grace) });
    await settled();
    expect(voices()).toEqual([]);
    expect(room.take()).toEqual([{ type: "huddle.answer", kind: "audio", sdp: "answer to offer:0" }]);

    // The round after the offer's can't bring her yet, and the tab doesn't take her for heard: it asks again in a while.
    room.receive({ type: "huddle.listening", kind: "audio" });
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio" }]);
    room.receive({ type: "huddle.listening", kind: "audio" });
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio" }]);
    await offeredRound(["1", grace]);
    expect(playedBy(voiceOf(grace))).toBe(connection().transceivers[1]!.receiver.track);
  });

  it("starts a fresh connection, in a while, when its receiving connection fails", async () => {
    const room = await joined([person(grace)]);
    await offeredRound(["0", grace]);
    room.receive({ type: "huddle.listening", kind: "audio" });
    room.take();
    const receiving = connection();

    receiving.becomes("failed");
    expect(receiving.connectionState).toBe("closed");
    expect(voices()).toEqual([]);
    await wait(LISTEN_AGAIN_MS[0] - 1);
    expect(room.take()).toEqual([]);
    await wait(1);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio", fresh: true }]);
    await offeredRound(["0", grace]);
    expect(connection()).not.toBe(receiving);
    expect(playedBy(voiceOf(grace))).toBe(connection().transceivers[0]!.receiver.track);
  });

  it.each(["huddle.listen", "huddle.answer"] as const)("starts a fresh connection when the room couldn't do what a %s asked, having let go of the one it had", async (failed) => {
    const room = await joined([person(grace), person(linus)]);
    await offeredRound(["0", grace]);
    room.take();
    const receiving = connection();

    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed, kind: "audio" });
    expect(receiving.connectionState).toBe("closed");
    expect(voices()).toEqual([]);
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio", fresh: true }]);
    await offeredRound(["0", grace], ["1", linus]);
    expect(voices()).toHaveLength(2);
  });

  it("starts a fresh connection when the browser can't answer the SFU's offer, which the room is left waiting on", async () => {
    const room = await joined([person(grace)]);
    room.take();
    FakeConnection.refusing = true;
    room.receive(offer(["0", grace]));
    await settled();
    const refused = connection();
    expect(refused.connectionState).toBe("closed");
    expect(room.take()).toEqual([]);

    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio", fresh: true }]);
    await offeredRound(["0", grace]);
    expect(connection()).not.toBe(refused);
    expect(voices()).toHaveLength(1);
  });

  it("starts a fresh connection when the one it has fails as it answers an offer", async () => {
    const room = await joined([person(grace)]);
    room.take();
    room.receive(offer(["0", grace]));
    const failing = connection();
    failing.becomes("failed");
    await settled();
    expect(failing.connectionState).toBe("closed");
    expect(voices()).toEqual([]);
    expect(room.take()).toEqual([]);
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio", fresh: true }]);
  });

  it("waits for the round under way to end before it asks for a fresh connection, and drops what the round offers the one it gave up", async () => {
    const room = await joined([person(grace), person(linus)]);
    await offeredRound(["0", grace]);
    expect(room.take().at(-1)).toEqual({ type: "huddle.listen", kind: "audio" });
    const receiving = connection();

    // The round asked on this connection is still to be answered when it fails.
    receiving.becomes("failed");
    await wait(LISTEN_AGAIN_MS[1]);
    expect(room.take()).toEqual([]);
    room.receive(offer(["0", grace], ["1", linus]));
    await settled();
    expect(connection()).toBe(receiving);
    expect(voices()).toEqual([]);
    expect(room.take()).toEqual([]);
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio", fresh: true }]);

    await offeredRound(["0", grace], ["1", linus]);
    expect(connection()).not.toBe(receiving);
    expect(voices()).toHaveLength(2);
  });

  it("plays through the speaker the preview left chosen, where the browser can choose one", async () => {
    const setSinkId = vi.fn(async () => {});
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: setSinkId });
    try {
      const room = await joined([person(grace)], { speakerId: "headphones" });
      room.receive(offer(["0", grace]));
      await settled();
      // The sound of the tab's person joining plays there, and then her voice.
      expect(setSinkId.mock.calls).toEqual([["headphones"], ["headphones"]]);
      expect(madeOn(setSinkId)).toEqual(["joined", grace.id]);
    } finally {
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    }
  });

  it("plays through the system's speaker for as long as the one chosen is unplugged, which would play nothing", async () => {
    const setSinkId = vi.fn(async () => {});
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: setSinkId });
    const speakers = (...ids: string[]) => ids.map((deviceId) => ({ kind: "audiooutput", deviceId }));
    const enumerateDevices = vi.fn(async () => speakers("default", "headphones"));
    const media = Object.assign(new EventTarget(), { enumerateDevices });
    vi.stubGlobal("navigator", { mediaDevices: media });
    const changes = async (to: ReturnType<typeof speakers>) => {
      setSinkId.mockClear();
      enumerateDevices.mockResolvedValue(to);
      media.dispatchEvent(new Event("devicechange"));
      await settled();
    };
    try {
      const room = await joined([person(grace), person(linus)], { speakerId: "headphones" });
      room.receive(offer(["0", grace]));
      await settled();

      // Something else is plugged in, and the voices stay where they play.
      await changes(speakers("default", "headphones", "monitor"));
      expect(setSinkId.mock.calls).toEqual([["headphones"]]);

      await changes(speakers("default", "monitor"));
      expect(setSinkId).toHaveBeenCalledExactlyOnceWith("");
      expect(setSinkId.mock.contexts[0]).toBe(voiceOf(grace));
      // Whoever is offered meanwhile plays there too, as an `<audio>` does until it's told otherwise.
      setSinkId.mockClear();
      await offeredRound(["1", linus]);
      expect(setSinkId).not.toHaveBeenCalled();

      await changes(speakers("default", "monitor", "headphones"));
      expect(setSinkId.mock.calls).toEqual([["headphones"], ["headphones"]]);
      expect(setSinkId.mock.contexts).toEqual([voiceOf(grace), voiceOf(linus)]);

      // Out of the huddle, it has stopped asking.
      leaveHuddle();
      enumerateDevices.mockClear();
      media.dispatchEvent(new Event("devicechange"));
      expect(enumerateDevices).not.toHaveBeenCalled();
    } finally {
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    }
  });

  it("asks nothing of the browser's speakers when it plays through the system's", async () => {
    const enumerateDevices = vi.fn(async () => []);
    const media = Object.assign(new EventTarget(), { enumerateDevices });
    vi.stubGlobal("navigator", { mediaDevices: media });
    await joined([person(grace)]);
    media.dispatchEvent(new Event("devicechange"));
    await settled();
    expect(enumerateDevices).not.toHaveBeenCalled();
  });

  it("plays at the person's next click or key, in a browser that won't until they've touched the page", async () => {
    const started = new WeakSet<HTMLMediaElement>();
    let refusing = true;
    const play = vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(async function (this: HTMLMediaElement) {
      if (refusing) throw new DOMException("play() failed", "NotAllowedError");
      started.add(this);
    });
    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) {
      return !started.has(this);
    });
    const room = await joined([person(grace), person(linus)]);
    room.receive(offer(["0", grace]));
    await settled();
    // Refused too, the sound of joining isn't kept for a touch: its moment has passed by then.
    expect(played()).toEqual(["joined", grace.id]);
    play.mockClear();

    // A finger landing isn't yet a touch to the browser, which would refuse again.
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(play).not.toHaveBeenCalled();
    // A key the browser doesn't count leaves the next touch to try.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settled();
    expect(played()).toEqual([grace.id]);

    // A click plays it, even one that what was clicked keeps to itself.
    refusing = false;
    const button = document.body.appendChild(document.createElement("button"));
    button.addEventListener("click", (event) => event.stopPropagation());
    button.click();
    button.remove();
    expect(played()).toEqual([grace.id, grace.id]);

    // Whoever plays is left playing, and whoever the browser refuses next waits for the next touch.
    refusing = true;
    await offeredRound(["1", linus]);
    expect(played()).toEqual([grace.id, grace.id, linus.id]);
    refusing = false;
    document.body.click();
    expect(played()).toEqual([grace.id, grace.id, linus.id, linus.id]);
    document.body.click();
    expect(played()).toHaveLength(4);
  });
});

describe("Who's speaking in a huddle", () => {
  /** As loud as someone speaking. */
  const LOUD = SPEAKING_LEVEL * 2;
  /** Who the huddle shows as speaking, of everyone a test has in one. */
  const speakingNow = () => [ada, grace, linus].filter(({ id }) => isSpeaking(id));
  /** The track `user`'s voice plays from. */
  const voiceFrom = (user: User) => playedBy(voiceOf(user))!;

  it("is whoever's voice the tab plays as loud as speech, and its own person by their microphone, which only what shows who's speaking hears of", async () => {
    const engine = audioEngine();
    const [shown, said] = [vi.fn(), vi.fn()];
    const stops = [watchHuddle(shown), watchSpeaking(said)];
    await joined([person(grace), person(linus)]);
    await offeredRound(["0", grace], ["1", linus]);
    expect(engine.measured()).toEqual([microphoneTrack(), voiceFrom(grace), voiceFrom(linus)]);
    shown.mockClear();

    engine.setLevel(voiceFrom(grace), LOUD);
    await wait(MEASURED_EVERY_MS);
    expect(speakingNow()).toEqual([grace]);
    engine.setLevel(microphoneTrack(), LOUD);
    await wait(MEASURED_EVERY_MS);
    expect(speakingNow()).toEqual([ada, grace]);
    expect(said).toHaveBeenCalledTimes(2);
    expect(shown).not.toHaveBeenCalled();
    for (const stop of stops) stop();
  });

  it("measures a voice until its person leaves or publishes anew, and the microphone until it's unplugged", async () => {
    const engine = audioEngine();
    const room = await joined([person(grace), person(linus)]);
    await offeredRound(["0", grace], ["1", linus]);
    const gracesVoice = voiceFrom(grace);
    engine.setLevel(voiceFrom(linus), LOUD);
    engine.setLevel(microphoneTrack(), LOUD);
    await wait(MEASURED_EVERY_MS);
    expect(speakingNow()).toEqual([ada, linus]);

    room.receive({ type: "huddle.left", userId: linus.id });
    expect(engine.measured()).toEqual([microphoneTrack(), gracesVoice]);
    room.receive({ type: "huddle.changed", person: person(grace, { audio: false }) });
    expect(engine.measured()).toEqual([microphoneTrack()]);
    microphoneTrack().end();
    expect(engine.measured()).toEqual([]);
    await wait(MEASURED_EVERY_MS);
    expect(speakingNow()).toEqual([]);
  });

  it("measures the microphone from when the room first lets the tab in, which says whose it is, and goes on as the room lets it back in", async () => {
    const engine = audioEngine();
    joinHuddle({ roomId: "general", muted: false, microphone: microphone as unknown as MediaStream, camera: null, speakerId: "" });
    socket().open();
    expect(engine.measured()).toEqual([]);
    await welcomed([person(grace)]);
    await offeredRound(["0", grace]);
    expect(engine.measured()).toEqual([microphoneTrack(), voiceFrom(grace)]);

    // The voices go with the connection that brought them, and come again with the next.
    socket().drop();
    expect(engine.measured()).toEqual([microphoneTrack()]);
    await wait(500);
    socket().open();
    await welcomed([person(grace)]);
    await offeredRound(["0", grace]);
    expect(engine.measured()).toEqual([microphoneTrack(), voiceFrom(grace)]);
    expect(engine.engines).toHaveLength(1);
  });

  it("measures no microphone for a tab that joined to listen", async () => {
    const engine = audioEngine();
    await joined([person(grace)], { microphone: null });
    await offeredRound(["0", grace]);
    expect(engine.measured()).toEqual([voiceFrom(grace)]);
  });

  it("stops measuring as the tab leaves, which shows nobody speaking", async () => {
    const engine = audioEngine();
    await joined([person(grace)]);
    await offeredRound(["0", grace]);
    engine.setLevel(voiceFrom(grace), LOUD);
    await wait(MEASURED_EVERY_MS);
    expect(speakingNow()).toEqual([grace]);
    const said = vi.fn();
    const stop = watchSpeaking(said);

    leaveHuddle();
    expect(speakingNow()).toEqual([]);
    expect(said).toHaveBeenCalledTimes(1);
    expect(engine.measured()).toEqual([]);
    expect(engine.engines.map(({ state }) => state)).toEqual(["closed"]);
    stop();
  });
});

describe("A huddle's camera", () => {
  it("is shown from the start by a tab that joins with it on, and published from a connection of its own once the room lets the tab in", async () => {
    joinHuddle({ roomId: "general", muted: false, microphone: microphone as unknown as MediaStream, camera: asCamera(), speakerId: "" });
    expect(joinedHuddle()).toMatchObject({ camera, connected: false });
    socket().open();
    await settled();
    expect(FakeConnection.all).toEqual([]);

    const room = await welcomed();
    const [voice, picture] = FakeConnection.all;
    expect(FakeConnection.all).toHaveLength(2);
    expect(picture!.configuration).toEqual(voice!.configuration);
    expect(picture!.transceivers).toEqual([expect.objectContaining({ direction: "sendonly", sendEncodings: [{ maxBitrate: CAMERA_BITRATE }], sender: { track: cameraTrack() } })]);
    expect(room.take()).toEqual([
      { type: "huddle.publish", sdp: "offer 1", tracks: [{ mid: "0", kind: "audio" }] },
      { type: "huddle.publish", sdp: "offer 2", tracks: [{ mid: "0", kind: "video" }] },
    ]);

    // Each answer is for the connection of its kind, which says for itself when it has connected.
    room.receive({ type: "huddle.published", kind: "video", sdp: "the SFU's answer to the camera" });
    await settled();
    expect([voice!.remoteDescription, picture!.remoteDescription]).toEqual([null, { type: "answer", sdp: "the SFU's answer to the camera" }]);
    picture!.becomes("connected");
    expect(room.take()).toEqual([{ type: "huddle.connected", kind: "video" }]);
  });

  it("turns on in the huddle: asks the browser for the camera this browser last chose, shows it, and publishes it", async () => {
    const asked = browserCamera();
    localStorage.setItem("ember:huddle-camera", "front");
    try {
      const room = await joined();
      room.take();
      expect(joinedHuddle()).toMatchObject({ camera: null });

      showHuddleCamera(true);
      // Asked again while the browser asks the person, it's asked for once.
      showHuddleCamera(true);
      await settled();
      expect(asked).toHaveBeenCalledExactlyOnceWith({ video: { width: { ideal: 640 }, height: { ideal: 360 }, deviceId: { exact: "front" } } });
      expect(joinedHuddle()).toMatchObject({ camera });
      expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 2", tracks: [{ mid: "0", kind: "video" }] }]);
      expect(connection().transceivers[0]!.sender.track).toBe(cameraTrack());
      // On already, there's nothing to turn on.
      showHuddleCamera(true);
      await settled();
      expect(asked).toHaveBeenCalledTimes(1);
      expect(FakeConnection.all).toHaveLength(2);
    } finally {
      localStorage.removeItem("ember:huddle-camera");
    }
  });

  it("turns off: stops the camera, closes its connection, and has the room take down what it showed", async () => {
    const room = await joined([], { camera: asCamera() });
    const [voice, picture] = FakeConnection.all;
    room.receive({ type: "huddle.published", kind: "video", sdp: "the SFU's answer" });
    await settled();
    room.take();

    showHuddleCamera(false);
    expect(cameraTrack().readyState).toBe("ended");
    expect([voice!.connectionState, picture!.connectionState]).toEqual(["new", "closed"]);
    expect(joinedHuddle()).toMatchObject({ camera: null, microphone: true });
    expect(room.take()).toEqual([{ type: "huddle.unpublish", kind: "video" }]);
    expect(microphoneTrack().readyState).toBe("live");
    // Off already, there's nothing to turn off, and nothing more is published of it.
    showHuddleCamera(false);
    room.receive({ type: "huddle.unpublished", kind: "video" });
    await wait(PUBLISH_AGAIN_MS[1]);
    expect(room.take()).toEqual([]);
    expect(FakeConnection.all).toHaveLength(2);
  });

  it("goes off as it's unplugged, or as the browser takes it away", async () => {
    const room = await joined([], { camera: asCamera() });
    room.take();
    cameraTrack().end();
    expect(joinedHuddle()).toMatchObject({ camera: null });
    expect(room.take()).toEqual([{ type: "huddle.unpublish", kind: "video" }]);
    expect(connection().connectionState).toBe("closed");
  });

  it("waits for the room's answer to an offer it has given up before it publishes again, since the answer doesn't say which offer it's to", async () => {
    browserCamera();
    const room = await joined([], { camera: asCamera() });
    const first = connection();
    room.take();

    // Off and on again before the room has answered the first offer.
    showHuddleCamera(false);
    camera = new FakeStream([new FakeTrack("video")]);
    showHuddleCamera(true);
    await settled();
    expect(joinedHuddle()).toMatchObject({ camera });
    expect(room.take()).toEqual([{ type: "huddle.unpublish", kind: "video" }]);
    expect(FakeConnection.all).toHaveLength(2);

    // The answer to the first is nobody's now, and the second offer goes out once it has come.
    room.receive({ type: "huddle.published", kind: "video", sdp: "the SFU's answer to the first" });
    await settled();
    expect(first.remoteDescription).toBeNull();
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 3", tracks: [{ mid: "0", kind: "video" }] }]);
    const second = connection();
    expect(second.transceivers[0]!.sender.track).toBe(cameraTrack());
    room.receive({ type: "huddle.published", kind: "video", sdp: "the SFU's answer to the second" });
    await settled();
    expect(second.remoteDescription).toEqual({ type: "answer", sdp: "the SFU's answer to the second" });
  });

  it("stays off, and says so, when the browser has no camera for it", async () => {
    browserCamera(true);
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined();
    room.take();

    showHuddleCamera(true);
    await settled();
    expect(said).toHaveBeenCalledExactlyOnceWith(NO_CAMERA);
    expect(joinedHuddle()).toMatchObject({ camera: null, connected: true });
    expect(room.take()).toEqual([]);
    expect(FakeConnection.all).toHaveLength(1);
    stop();
  });

  it.each([
    ["the huddle shows as many cameras as it does", CAMERAS_FULL],
    ["an administrator has cameras off", CAMERAS_OFF],
  ])("goes off, with what the room says of it, when %s", async (_, message) => {
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined([], { camera: asCamera() });
    room.take();

    room.receive({ type: "error", message, failed: "huddle.publish", kind: "video", refused: true });
    expect(said).toHaveBeenCalledExactlyOnceWith(message);
    expect(joinedHuddle()).toMatchObject({ camera: null, connected: true });
    expect(cameraTrack().readyState).toBe("ended");
    expect(connection().connectionState).toBe("closed");
    // It isn't tried again, and the huddle goes on.
    await wait(PUBLISH_AGAIN_MS[1]);
    expect(taken("video")).toEqual([{ type: "huddle.unpublish", kind: "video" }]);
    expect(FakeConnection.all).toHaveLength(2);
    expect(room.closedWith).toBeUndefined();
    stop();
  });

  it("is published again by itself when the room couldn't publish it or leaves its offer unanswered, and the huddle goes on meanwhile", async () => {
    const room = await joined([], { camera: asCamera() });
    const [voice] = FakeConnection.all as [FakeConnection];
    room.receive({ type: "huddle.published", kind: "audio", sdp: "the SFU's answer" });
    await settled();
    voice.becomes("connected");
    room.take();

    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.publish", kind: "video" });
    await wait(PUBLISH_AGAIN_MS[0] - 1);
    expect(room.take()).toEqual([]);
    await wait(1);
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 3", tracks: [{ mid: "0", kind: "video" }] }]);

    // Unanswered, where a microphone's offer has the tab join again, a camera's is only made again.
    await wait(ANSWER_TIMEOUT_MS + PUBLISH_AGAIN_MS[0] * 2 - 1);
    expect(room.take()).toEqual([]);
    await wait(1);
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 4", tracks: [{ mid: "0", kind: "video" }] }]);
    expect(room.closedWith).toBeUndefined();
    expect(joinedHuddle()).toMatchObject({ connected: true, camera });
    expect(voice.connectionState).toBe("connected");
    expect(cameraTrack().readyState).toBe("live");
  });

  it("stays on while the tab's connection to the room is down, and is published again once the room lets it back in", async () => {
    const room = await joined([], { camera: asCamera() });
    room.drop();
    expect(joinedHuddle()).toMatchObject({ connected: false, camera });
    expect(open()).toEqual([]);
    expect(cameraTrack().readyState).toBe("live");

    await wait(500);
    socket().open();
    await welcomed();
    expect(socket().take()).toEqual([expect.objectContaining({ type: "huddle.publish", tracks: [{ mid: "0", kind: "audio" }] }), expect.objectContaining({ type: "huddle.publish", tracks: [{ mid: "0", kind: "video" }] })]);
  });

  it("stops with the huddle, which no longer answers for it", async () => {
    const asked = browserCamera();
    await joined([], { camera: asCamera() });
    leaveHuddle();
    expect(cameraTrack().readyState).toBe("ended");
    for (const each of FakeConnection.all) expect(each.connectionState).toBe("closed");

    showHuddleCamera(true);
    await settled();
    expect(asked).not.toHaveBeenCalled();
  });

  it("is closed again when the tab left while the browser asked its person for it", async () => {
    let give!: (stream: FakeStream) => void;
    const getUserMedia = vi.fn(() => new Promise<FakeStream>((resolve) => (give = resolve)));
    vi.stubGlobal("navigator", { mediaDevices: Object.assign(new EventTarget(), { getUserMedia }) });
    await joined();
    showHuddleCamera(true);
    await settled();
    leaveHuddle();
    give(camera);
    await settled();
    expect(cameraTrack().readyState).toBe("ended");
    expect(joinedHuddle()).toBeNull();
  });

  it("is shown once the browser has opened it, by a tab that joins while it's opening, and published then", async () => {
    let give!: (stream: MediaStream | null) => void;
    const asked = browserCamera();
    const room = await joined([], { camera: new Promise((resolve) => (give = resolve)) });
    expect(joinedHuddle()).toMatchObject({ camera: null, connected: true });
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish", tracks: [{ mid: "0", kind: "audio" }] })]);
    // The browser is asked for no other meanwhile.
    showHuddleCamera(true);

    give(asCamera());
    await settled();
    expect(joinedHuddle()).toMatchObject({ camera });
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 2", tracks: [{ mid: "0", kind: "video" }] }]);
    expect(connection().transceivers[0]!.sender.track).toBe(cameraTrack());
    expect(asked).not.toHaveBeenCalled();
  });

  it("says so when the browser has none for a tab that joined while it was opening, and is closed again when the tab left meanwhile", async () => {
    let give!: (stream: MediaStream | null) => void;
    const opening = () => new Promise<MediaStream | null>((resolve) => (give = resolve));
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined([], { camera: opening() });
    room.take();
    give(null);
    await settled();
    expect(said).toHaveBeenCalledExactlyOnceWith(NO_CAMERA);
    expect(joinedHuddle()).toMatchObject({ camera: null, connected: true });
    expect(room.take()).toEqual([]);
    stop();

    await joined([], { camera: opening() });
    leaveHuddle();
    give(asCamera());
    await settled();
    expect(cameraTrack().readyState).toBe("ended");
    expect(joinedHuddle()).toBeNull();
  });
});

describe("Watching the others in a huddle", () => {
  it("asks for the cameras that are on, by whose they are, on a connection of its own, and shows each person's", async () => {
    const room = await joined([person(grace, { video: true }), person(linus)]);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio", fresh: true }, { type: "huddle.listen", kind: "video", fresh: true, watch: [grace.id] }, expect.objectContaining({ type: "huddle.publish" })]);
    expect(FakeConnection.all).toHaveLength(1);
    expect(joinedHuddle()!.watched).toEqual(new Map());

    room.receive(pictures(["0", grace]));
    await settled();
    const watching = connection();
    expect(FakeConnection.all).toHaveLength(2);
    expect(watching.configuration).toEqual({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
    expect(room.take()).toEqual([{ type: "huddle.answer", kind: "video", sdp: "answer to offer:0" }]);
    const shown = joinedHuddle()!.watched.get(grace.id) as unknown as FakeStream;
    expect([...joinedHuddle()!.watched.keys()]).toEqual([grace.id]);
    expect(shown.tracks).toEqual([watching.transceivers[0]!.receiver.track]);
    // A picture isn't a voice: nothing plays it but the huddle, opened.
    expect(voices()).toEqual([]);

    // Once more, as for voices, and then no more with everyone watched.
    room.receive({ type: "huddle.listening", kind: "video" });
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "video", watch: [grace.id] }]);
    room.receive({ type: "huddle.listening", kind: "video" });
    await wait(LISTEN_AGAIN_MS[1] * 2);
    expect(room.take()).toEqual([]);
    expect(watching.connectionState).toBe("new");
  });

  it("hears and watches on connections apart: a round of one waits on nothing of the other", async () => {
    const room = await joined([person(grace, { video: true })]);
    room.take();
    room.receive(pictures(["0", grace]));
    room.receive(offer(["0", grace]));
    await settled();
    const [, watching, hearing] = FakeConnection.all;
    expect(FakeConnection.all).toHaveLength(3);
    expect(taken("video")).toEqual([{ type: "huddle.answer", kind: "video", sdp: "answer to offer:0" }]);
    expect(taken("audio")).toEqual([{ type: "huddle.answer", kind: "audio", sdp: "answer to offer:0" }]);
    expect(playedBy(voiceOf(grace))).toBe(hearing!.transceivers[0]!.receiver.track);
    expect((joinedHuddle()!.watched.get(grace.id) as unknown as FakeStream).tracks).toEqual([watching!.transceivers[0]!.receiver.track]);
  });

  it("asks for a camera as it comes on, and stops showing one that goes off, or whose person leaves", async () => {
    const room = await joined([person(grace), person(linus)]);
    room.take();
    room.receive({ type: "huddle.changed", person: person(grace, { video: true }) });
    expect(taken("video")).toEqual([{ type: "huddle.listen", kind: "video", fresh: true, watch: [grace.id] }]);
    await watchedRound(["0", grace]);
    room.take();

    // Linus's is asked for beside hers, on the connection the tab has.
    room.receive({ type: "huddle.changed", person: person(linus, { video: true }) });
    expect(taken("video")).toEqual([{ type: "huddle.listen", kind: "video", watch: [grace.id, linus.id] }]);
    await watchedRound(["1", linus]);
    expect([...joinedHuddle()!.watched.keys()]).toEqual([grace.id, linus.id]);
    room.take();

    room.receive({ type: "huddle.changed", person: person(grace) });
    expect([...joinedHuddle()!.watched.keys()]).toEqual([linus.id]);
    room.receive({ type: "huddle.left", userId: linus.id });
    expect(joinedHuddle()!.watched).toEqual(new Map());
    // Neither is anyone to ask the room about: it stops sending what's no longer published.
    expect(taken("video")).toEqual([]);
    // Nor is the tab's own camera anyone's to watch.
    room.receive({ type: "huddle.changed", person: person(ada, { audio: false, video: true }) });
    expect(taken("video")).toEqual([]);
  });

  it("asks for nobody's once the huddle is closed to its bar, so the room stops sending them, and for them again once it's opened", async () => {
    const room = await joined([person(grace, { video: true })]);
    await watchedRound(["0", grace]);
    room.take();
    const watching = connection();

    openHuddle(false);
    expect(joinedHuddle()).toMatchObject({ open: false, watched: new Map() });
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "video", watch: [] }]);
    // With nobody on it, and nobody to ask for, the connection closes.
    room.receive({ type: "huddle.listening", kind: "video" });
    expect(watching.connectionState).toBe("closed");
    // A camera that comes on meanwhile is nobody's to watch,
    room.receive({ type: "huddle.joined", person: person(linus, { audio: false, video: true }) });
    openHuddle(false);
    expect(room.take()).toEqual([]);

    // until the huddle is opened again, on a new connection.
    openHuddle(true);
    expect(joinedHuddle()).toMatchObject({ open: true });
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "video", fresh: true, watch: [grace.id, linus.id] }]);
    await watchedRound(["0", grace], ["1", linus]);
    expect(connection()).not.toBe(watching);
    expect([...joinedHuddle()!.watched.keys()]).toEqual([grace.id, linus.id]);
  });

  it("asks at once for nobody's when the huddle closes during a round, once that round is over", async () => {
    const room = await joined([person(grace, { video: true })]);
    room.take();
    room.receive(pictures(["0", grace]));
    await settled();
    openHuddle(false);
    expect(taken("video")).toEqual([{ type: "huddle.answer", kind: "video", sdp: "answer to offer:0" }]);
    // What the round brought is shown until the room has been asked to stop sending it.
    room.receive({ type: "huddle.listening", kind: "video" });
    expect(taken("video")).toEqual([{ type: "huddle.listen", kind: "video", watch: [] }]);
    expect(joinedHuddle()!.watched).toEqual(new Map());
  });

  it("takes the camera an offer brings while the huddle is closed, which the room offers once, and shows it when the huddle has opened again by the round's end", async () => {
    const room = await joined([person(grace, { video: true })]);
    room.take();
    openHuddle(false);
    room.receive(pictures(["0", grace]));
    await settled();
    expect(taken("video")).toEqual([{ type: "huddle.answer", kind: "video", sdp: "answer to offer:0" }]);
    openHuddle(true);
    room.receive({ type: "huddle.listening", kind: "video" });
    expect(taken("video")).toEqual([{ type: "huddle.listen", kind: "video", watch: [grace.id] }]);
    // The room sends her already, and has nobody more to offer.
    room.receive({ type: "huddle.listening", kind: "video" });
    expect((joinedHuddle()!.watched.get(grace.id) as unknown as FakeStream).tracks).toEqual([connection().transceivers[0]!.receiver.track]);
    await wait(LISTEN_AGAIN_MS[1] * 2);
    expect(taken("video")).toEqual([]);
  });

  it("has the room stop sending the camera an offer brings while the huddle is closed, when it's closed still by the round's end", async () => {
    const room = await joined([person(grace, { video: true })]);
    room.take();
    openHuddle(false);
    room.receive(pictures(["0", grace]));
    await settled();
    room.receive({ type: "huddle.listening", kind: "video" });
    expect(taken("video")).toEqual([{ type: "huddle.answer", kind: "video", sdp: "answer to offer:0" }, { type: "huddle.listen", kind: "video", watch: [] }]);
    expect(joinedHuddle()!.watched).toEqual(new Map());
    room.receive({ type: "huddle.listening", kind: "video" });
    expect(connection().connectionState).toBe("closed");
  });

  it("watches no more cameras than a huddle shows", async () => {
    const crowd = Array.from({ length: MAX_HUDDLE_CAMERAS + 1 }, (_, n) => person({ id: `p${n}`, name: `Person ${n}` }, { audio: false, video: true }));
    const room = await joined(crowd);
    const [asked] = taken("video");
    expect(asked!.watch).toEqual(crowd.slice(0, MAX_HUDDLE_CAMERAS).map(({ user }) => user.id));
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish" })]);
  });

  it("starts watching over by itself when the room couldn't do what a round asked, or leaves it unanswered, and goes on hearing meanwhile", async () => {
    const room = await joined([person(grace, { video: true })]);
    await publishedAndConnected();
    await offeredRound(["0", grace]);
    room.receive({ type: "huddle.listening", kind: "audio" });
    const hearing = connection();
    await watchedRound(["0", grace]);
    const watching = connection();
    room.receive({ type: "huddle.joined", person: person(linus, { audio: false, video: true }) });
    room.take();

    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.listen", kind: "video" });
    expect(watching.connectionState).toBe("closed");
    expect(joinedHuddle()!.watched).toEqual(new Map());
    expect([hearing.connectionState, voices().length]).toEqual(["new", 1]);
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "video", fresh: true, watch: [grace.id, linus.id] }]);

    // Unanswered, where a round of listening has the tab join again, a round of watching is only asked again.
    await wait(ANSWER_TIMEOUT_MS + LISTEN_AGAIN_MS[0] * 2);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "video", fresh: true, watch: [grace.id, linus.id] }]);
    expect(room.closedWith).toBeUndefined();
    expect(joinedHuddle()).toMatchObject({ connected: true });
    expect([hearing.connectionState, voices().length]).toEqual(["new", 1]);
  });

  it("shows nobody while the tab's connection to the room is down, and watches again once the room lets it back in", async () => {
    const room = await joined([person(grace, { video: true })]);
    await watchedRound(["0", grace]);
    room.drop();
    expect(joinedHuddle()!.watched).toEqual(new Map());
    expect(open()).toEqual([]);

    await wait(500);
    socket().open();
    await welcomed([person(grace, { video: true })]);
    expect(taken("video")).toEqual([{ type: "huddle.listen", kind: "video", fresh: true, watch: [grace.id] }]);
  });
});

describe("A camera's sizes in a huddle", () => {
  /** The tab's camera is on as it joins, and published once the room lets it in: answers the room's socket and the camera's connection. */
  async function showing() {
    const room = await joined([], { camera: asCamera() });
    room.take();
    return [room, connection()] as const;
  }

  it("sends a camera in two sizes from a browser known to send them: the smaller first, half as wide and half as tall, and then the picture whole", async () => {
    camera = cameraFrom("front", 640, 360);
    browserIs(CHROME);
    const [, picture] = await showing();
    expect(picture.transceivers).toEqual([expect.objectContaining({ direction: "sendonly", sendEncodings: TWO_SIZES, sender: { track: cameraTrack() } })]);
  });

  it.each([
    ["from any other browser", SAFARI, cameraFrom("front", 640, 360)],
    ["of a picture too small for two", CHROME, cameraFrom("front", 320, 180)],
    ["of a picture the browser says no size of", CHROME, new FakeStream([new FakeTrack("video", "front")])],
  ])("sends it in one size %s", async (_why, userAgent, from) => {
    camera = from;
    browserIs(userAgent);
    const [, picture] = await showing();
    expect(picture.transceivers[0]!.sendEncodings).toEqual([{ maxBitrate: CAMERA_BITRATE }]);
  });

  it("leaves both sizes as they are once the SFU's answer has taken both, and the one size of a camera sent in one", async () => {
    const changed = vi.spyOn(FakeSender.prototype, "setParameters");
    camera = cameraFrom("front", 640, 360);
    browserIs(CHROME);
    const [room, picture] = await showing();
    room.receive({ type: "huddle.published", kind: "video", sdp: "the SFU's answer" });
    await settled();
    expect(picture.getSenders()[0]!.getParameters().encodings).toEqual(TWO_SIZES);

    // One size offered is one size sent, whatever the answer takes of it.
    FakeConnection.takingOneSize = true;
    showHuddleCamera(false);
    camera = cameraFrom("front", 320, 180);
    browserCamera();
    showHuddleCamera(true);
    await settled();
    room.receive({ type: "huddle.published", kind: "video", sdp: "the SFU's answer" });
    await settled();
    expect(connection()).not.toBe(picture);
    expect(connection().getSenders()[0]!.getParameters().encodings).toEqual([{ maxBitrate: CAMERA_BITRATE }]);
    expect(changed).not.toHaveBeenCalled();
  });

  it("sends its camera whole when the SFU's answer takes one size of the two: the smaller, which the browser is left sending, as large as the picture and at as many bits", async () => {
    FakeConnection.takingOneSize = true;
    camera = cameraFrom("front", 640, 360);
    browserIs(CHROME);
    const [room, picture] = await showing();
    room.receive({ type: "huddle.published", kind: "video", sdp: "an answer that takes one size" });
    await settled();
    expect(picture.getSenders()[0]!.getParameters().encodings).toEqual([{ rid: CAMERA_SIZES.small, maxBitrate: CAMERA_BITRATE, scaleResolutionDownBy: 1 }]);
    expect(picture.connectionState).toBe("new");
    expect(room.take()).toEqual([]);
  });

  it("asks nothing more of a connection whose camera was turned off while the browser took the SFU's answer", async () => {
    const changed = vi.spyOn(FakeSender.prototype, "setParameters");
    FakeConnection.takingOneSize = true;
    camera = cameraFrom("front", 640, 360);
    browserIs(CHROME);
    const [room, picture] = await showing();
    room.receive({ type: "huddle.published", kind: "video", sdp: "an answer that takes one size" });
    showHuddleCamera(false);
    await settled();
    expect(picture.connectionState).toBe("closed");
    expect(changed).not.toHaveBeenCalled();
  });

  it("goes on with the huddle when the browser won't send that one size whole", async () => {
    vi.spyOn(FakeSender.prototype, "setParameters").mockRejectedValue(new DOMException("The connection has closed", "InvalidStateError"));
    FakeConnection.takingOneSize = true;
    camera = cameraFrom("front", 640, 360);
    browserIs(CHROME);
    const [room, picture] = await showing();
    room.receive({ type: "huddle.published", kind: "video", sdp: "an answer that takes one size" });
    await settled();
    picture.becomes("connected");
    expect(room.take()).toEqual([{ type: "huddle.connected", kind: "video" }]);
    expect(joinedHuddle()).toMatchObject({ camera });
  });

  it("publishes its camera again in one size, whole, once the room couldn't publish it in two, which may be what the SFU wouldn't take, and keeps to one in that huddle", async () => {
    camera = cameraFrom("front", 640, 360);
    browserIs(CHROME);
    const [room, picture] = await showing();
    expect(picture.transceivers[0]!.sendEncodings).toEqual(TWO_SIZES);

    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.publish", kind: "video" });
    await wait(PUBLISH_AGAIN_MS[0]);
    const whole = connection();
    expect(whole).not.toBe(picture);
    expect(whole.transceivers).toEqual([expect.objectContaining({ direction: "sendonly", sendEncodings: [{ maxBitrate: CAMERA_BITRATE }], sender: { track: cameraTrack() } })]);
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 3", tracks: [{ mid: "0", kind: "video" }] }]);
    room.receive({ type: "huddle.published", kind: "video", sdp: "the SFU's answer" });
    await settled();

    // Turned off and on again, it goes out in one.
    showHuddleCamera(false);
    camera = cameraFrom("front", 640, 360);
    browserCamera();
    browserIs(CHROME);
    showHuddleCamera(true);
    await settled();
    expect(connection()).not.toBe(whole);
    expect(connection().transceivers[0]!.sendEncodings).toEqual([{ maxBitrate: CAMERA_BITRATE }]);
  });

  it("sends two sizes still of a camera the room refused itself, the huddle showing as many as it does, once it's turned on again", async () => {
    camera = cameraFrom("front", 640, 360);
    browserIs(CHROME);
    const [room] = await showing();
    room.receive({ type: "error", message: CAMERAS_FULL, failed: "huddle.publish", kind: "video", refused: true });
    expect(joinedHuddle()).toMatchObject({ camera: null });

    camera = cameraFrom("front", 640, 360);
    browserCamera();
    browserIs(CHROME);
    showHuddleCamera(true);
    await settled();
    expect(connection().transceivers[0]!.sendEncodings).toEqual(TWO_SIZES);
  });

  it("asks for the cameras it watches small once its huddle shows them in small tiles, and large again once it shows them larger", async () => {
    const room = await joined([person(grace, { video: true })]);
    await watchedRound(["0", grace]);
    room.take();

    takeCamerasSmall(true);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "video", watch: [grace.id], small: true }]);
    // The room has the SFU send her camera in its smaller size, and has nobody to offer.
    room.receive({ type: "huddle.listening", kind: "video" });
    await wait(LISTEN_AGAIN_MS[1] * 2);
    expect(room.take()).toEqual([]);
    expect([...joinedHuddle()!.watched.keys()]).toEqual([grace.id]);
    // Said again, it's nothing to ask.
    takeCamerasSmall(true);
    expect(room.take()).toEqual([]);

    takeCamerasSmall(false);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "video", watch: [grace.id] }]);
  });

  it("asks in the size it shows by then, once the round under way is over, when its tiles change size meanwhile", async () => {
    const room = await joined([person(grace, { video: true })]);
    await watchedRound(["0", grace]);
    room.take();

    takeCamerasSmall(true);
    room.take();
    takeCamerasSmall(false);
    expect(room.take()).toEqual([]);
    room.receive({ type: "huddle.listening", kind: "video" });
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "video", watch: [grace.id] }]);
    // And nothing more once that's answered.
    room.receive({ type: "huddle.listening", kind: "video" });
    await wait(LISTEN_AGAIN_MS[1] * 2);
    expect(room.take()).toEqual([]);
  });

  it("says nothing of sizes while it watches nobody, and asks small for the first camera that comes on", async () => {
    const room = await joined([person(grace)]);
    room.take();
    takeCamerasSmall(true);
    expect(room.take()).toEqual([]);

    room.receive({ type: "huddle.changed", person: person(grace, { video: true }) });
    expect(taken("video")).toEqual([{ type: "huddle.listen", kind: "video", fresh: true, watch: [grace.id], small: true }]);
  });

  it("says small of cameras alone: never of voices, nor of the screens people share", async () => {
    const room = await joined([person(grace, { video: true })]);
    await offeredRound(["0", grace]);
    room.receive({ type: "huddle.listening", kind: "audio" });
    await watchedRound(["0", grace]);
    takeCamerasSmall(true);
    room.take();

    room.receive({ type: "huddle.joined", person: person(linus) });
    expect(taken("audio")).toEqual([{ type: "huddle.listen", kind: "audio" }]);
    room.receive({ type: "huddle.changed", person: person(grace, { video: true, screen: true }) });
    expect(taken("screen")).toEqual([{ type: "huddle.listen", kind: "screen", fresh: true, watch: [grace.id] }]);
  });

  it("answers a change of sizes that takes an offer on the connection it has, and goes on showing whom it watched", async () => {
    const room = await joined([person(grace, { video: true })]);
    await watchedRound(["0", grace]);
    const watching = connection();
    const shown = joinedHuddle()!.watched.get(grace.id);
    takeCamerasSmall(true);
    room.take();

    // The SFU's offer carries the camera it sent already, and nobody new.
    room.receive({ type: "huddle.offer", kind: "video", sdp: "offer:0", tracks: [] });
    await settled();
    expect(room.take()).toEqual([{ type: "huddle.answer", kind: "video", sdp: "answer to offer:0" }]);
    expect(connection()).toBe(watching);
    expect(joinedHuddle()!.watched.get(grace.id)).toBe(shown);
    // Then it asks once more, as after any offer, in the size it shows.
    room.receive({ type: "huddle.listening", kind: "video" });
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "video", watch: [grace.id], small: true }]);
  });

  it("shows a camera it watches from the track it's offered of it anew, which the room does of one the SFU won't make larger", async () => {
    const room = await joined([person(grace, { video: true })]);
    await watchedRound(["0", grace]);
    const watching = connection();
    takeCamerasSmall(true);
    room.receive({ type: "huddle.listening", kind: "video" });
    const small = joinedHuddle()!.watched.get(grace.id)!;
    takeCamerasSmall(false);
    room.take();

    // The room has had the SFU close the track it sent of her, and offers her camera again on the connection's next media section.
    room.receive(pictures(["1", grace]));
    await settled();
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.answer", kind: "video" })]);
    expect(connection()).toBe(watching);
    const large = joinedHuddle()!.watched.get(grace.id)!;
    expect(large).not.toBe(small);
    expect(large.getTracks()).toEqual([watching.transceivers.find(({ mid }) => mid === "1")!.receiver.track]);
    expect([...joinedHuddle()!.watched.keys()]).toEqual([grace.id]);
  });

  it("keeps to the size its tiles last showed as the huddle closes to its bar and opens again, and as the room lets the tab back in", async () => {
    const room = await joined([person(grace, { video: true })]);
    await watchedRound(["0", grace]);
    takeCamerasSmall(true);
    room.receive({ type: "huddle.listening", kind: "video" });
    room.take();

    openHuddle(false);
    room.receive({ type: "huddle.listening", kind: "video" });
    openHuddle(true);
    expect(taken("video")).toEqual([
      { type: "huddle.listen", kind: "video", watch: [], small: true },
      { type: "huddle.listen", kind: "video", fresh: true, watch: [grace.id], small: true },
    ]);

    room.drop();
    await wait(1_000);
    socket().open();
    const again = await welcomed([person(grace, { video: true })]);
    expect(taken("video")).toEqual([{ type: "huddle.listen", kind: "video", fresh: true, watch: [grace.id], small: true }]);
    expect(again).not.toBe(room);
  });
});

describe("A screen shared in a huddle", () => {
  it("is shared once its person has chosen it: the browser asks them what to share, and the huddle shows it and publishes it from a connection of its own", async () => {
    const asked = browserScreen();
    const room = await joined();
    const [voice] = FakeConnection.all;
    room.take();
    expect(joinedHuddle()).toMatchObject({ screen: null });

    shareHuddleScreen(true);
    // Asked again while the browser asks its person, it's asked for once.
    shareHuddleScreen(true);
    await settled();
    expect(asked).toHaveBeenCalledExactlyOnceWith({ video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 15 } }, audio: false });
    expect(joinedHuddle()).toMatchObject({ screen: display, camera: null });
    // Text stays sharp, where the browser can't keep that and smooth movement both.
    expect(displayTrack().contentHint).toBe("detail");
    const sharing = connection();
    expect(FakeConnection.all).toHaveLength(2);
    expect(sharing.configuration).toEqual(voice!.configuration);
    expect(sharing.transceivers).toEqual([expect.objectContaining({ direction: "sendonly", sendEncodings: [{ maxBitrate: SCREEN_BITRATE }], sender: { track: displayTrack() } })]);
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 2", tracks: [{ mid: "0", kind: "screen" }] }]);

    // The answer is for the screen's connection, which says for itself when it has connected.
    room.receive({ type: "huddle.published", kind: "screen", sdp: "the SFU's answer to the screen" });
    await settled();
    expect([voice!.remoteDescription, sharing.remoteDescription]).toEqual([null, { type: "answer", sdp: "the SFU's answer to the screen" }]);
    sharing.becomes("connected");
    expect(room.take()).toEqual([{ type: "huddle.connected", kind: "screen" }]);
    // Shared already, there's nothing more to share.
    shareHuddleScreen(true);
    await settled();
    expect(asked).toHaveBeenCalledTimes(1);
    expect(FakeConnection.all).toHaveLength(2);
  });

  it("shares nothing, and says nothing, when its person chooses nothing, which they can do again", async () => {
    const asked = browserScreen(new DOMException("Permission denied", "NotAllowedError"));
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined();
    room.take();

    shareHuddleScreen(true);
    await settled();
    expect(said).not.toHaveBeenCalled();
    expect(joinedHuddle()).toMatchObject({ screen: null, connected: true });
    expect(room.take()).toEqual([]);
    expect(FakeConnection.all).toHaveLength(1);
    shareHuddleScreen(true);
    await settled();
    expect(asked).toHaveBeenCalledTimes(2);
    stop();
  });

  it.each([
    ["couldn't start sharing what they chose", new DOMException("Could not start video source", "NotReadableError")],
    ["is kept from recording the screen by their computer, as Chrome says it", new DOMException("Permission denied by system", "NotAllowedError")],
    ["can't share a screen", undefined],
  ])("shares nothing, and says so, when the browser %s", async (_, failing) => {
    if (failing) browserScreen(failing);
    else vi.stubGlobal("navigator", { mediaDevices: new EventTarget() });
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined();
    room.take();

    shareHuddleScreen(true);
    await settled();
    expect(said).toHaveBeenCalledExactlyOnceWith(NO_SCREEN);
    expect(joinedHuddle()).toMatchObject({ screen: null, connected: true });
    expect(room.take()).toEqual([]);
    expect(FakeConnection.all).toHaveLength(1);
    stop();
  });

  it("stops: ends the browser's sharing, closes its connection, and has the room take down what it showed", async () => {
    browserScreen();
    const room = await joined([], { camera: asCamera() });
    shareHuddleScreen(true);
    await settled();
    const [voice, picture, sharing] = FakeConnection.all;
    room.take();

    shareHuddleScreen(false);
    expect(displayTrack().readyState).toBe("ended");
    expect([voice!.connectionState, picture!.connectionState, sharing!.connectionState]).toEqual(["new", "new", "closed"]);
    expect(joinedHuddle()).toMatchObject({ screen: null, camera, microphone: true });
    expect(room.take()).toEqual([{ type: "huddle.unpublish", kind: "screen" }]);
    expect([microphoneTrack().readyState, cameraTrack().readyState]).toEqual(["live", "live"]);
    // Stopped already, there's nothing to stop, and nothing more is published of it.
    shareHuddleScreen(false);
    room.receive({ type: "huddle.unpublished", kind: "screen" });
    await wait(PUBLISH_AGAIN_MS[1]);
    expect(room.take()).toEqual([]);
    expect(FakeConnection.all).toHaveLength(3);
  });

  it("stops as its person stops sharing from the browser's own bar, or closes what they shared", async () => {
    browserScreen();
    const room = await joined();
    shareHuddleScreen(true);
    await settled();
    room.take();
    displayTrack().end();
    expect(joinedHuddle()).toMatchObject({ screen: null });
    expect(room.take()).toEqual([{ type: "huddle.unpublish", kind: "screen" }]);
    expect(connection().connectionState).toBe("closed");
  });

  it.each([
    ["the huddle shows as many screens as it does", SCREENS_FULL],
    ["an administrator has screen sharing off", SCREENS_OFF],
  ])("stops, with what the room says of it, when %s", async (_, message) => {
    browserScreen();
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined([], { camera: asCamera() });
    shareHuddleScreen(true);
    await settled();
    room.take();

    room.receive({ type: "error", message, failed: "huddle.publish", kind: "screen", refused: true });
    expect(said).toHaveBeenCalledExactlyOnceWith(message);
    expect(joinedHuddle()).toMatchObject({ screen: null, camera, connected: true });
    expect(displayTrack().readyState).toBe("ended");
    expect(connection().connectionState).toBe("closed");
    // It isn't tried again, and the huddle and its camera go on.
    await wait(PUBLISH_AGAIN_MS[1]);
    expect(room.take()).toEqual([{ type: "huddle.unpublish", kind: "screen" }]);
    expect(cameraTrack().readyState).toBe("live");
    expect(room.closedWith).toBeUndefined();
    stop();
  });

  it("isn't asked of the browser while as many others share theirs as a huddle shows, which its person hears instead", async () => {
    const asked = browserScreen();
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined([person(grace, { screen: true }), person(linus, { screen: true })]);
    room.take();

    shareHuddleScreen(true);
    await settled();
    expect(asked).not.toHaveBeenCalled();
    expect(said).toHaveBeenCalledExactlyOnceWith(SCREENS_FULL);
    expect(joinedHuddle()).toMatchObject({ screen: null });

    // Once one of them stops, it's the browser's to ask.
    room.receive({ type: "huddle.changed", person: person(linus) });
    shareHuddleScreen(true);
    await settled();
    expect(asked).toHaveBeenCalledOnce();
    expect(joinedHuddle()).toMatchObject({ screen: display });
    stop();
  });

  it("is published again by itself when the room couldn't publish it, and the huddle goes on meanwhile", async () => {
    browserScreen();
    const room = await joined();
    shareHuddleScreen(true);
    await settled();
    room.take();

    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.publish", kind: "screen" });
    await wait(PUBLISH_AGAIN_MS[0] - 1);
    expect(room.take()).toEqual([]);
    await wait(1);
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 3", tracks: [{ mid: "0", kind: "screen" }] }]);
    expect(room.closedWith).toBeUndefined();
    expect(joinedHuddle()).toMatchObject({ connected: true, screen: display });
    expect(displayTrack().readyState).toBe("live");
  });

  it("stays shared while the tab's connection to the room is down, and is published again, beside its camera, once the room lets it back in", async () => {
    browserScreen();
    const room = await joined([], { camera: asCamera() });
    shareHuddleScreen(true);
    await settled();
    room.drop();
    expect(joinedHuddle()).toMatchObject({ connected: false, camera, screen: display });
    expect(open()).toEqual([]);
    expect(displayTrack().readyState).toBe("live");

    await wait(500);
    socket().open();
    await welcomed();
    expect(socket().take()).toEqual(["audio", "video", "screen"].map((kind) => expect.objectContaining({ type: "huddle.publish", tracks: [{ mid: "0", kind }] })));
  });

  it("stops with the huddle, which no longer answers for it", async () => {
    const asked = browserScreen();
    await joined();
    shareHuddleScreen(true);
    await settled();
    leaveHuddle();
    expect(displayTrack().readyState).toBe("ended");
    for (const each of FakeConnection.all) expect(each.connectionState).toBe("closed");

    shareHuddleScreen(true);
    await settled();
    expect(asked).toHaveBeenCalledOnce();
  });

  it("is let go of again when the tab left while the browser asked its person what to share, and says nothing of a browser that failed by then", async () => {
    let give!: (stream: FakeStream) => void;
    let fail!: (error: Error) => void;
    const getDisplayMedia = vi.fn(() => new Promise<FakeStream>((resolve, reject) => ([give, fail] = [resolve, reject])));
    vi.stubGlobal("navigator", { mediaDevices: Object.assign(new EventTarget(), { getDisplayMedia }) });
    const said = vi.fn();
    const stop = hearHuddle(said);
    await joined();
    shareHuddleScreen(true);
    await settled();
    leaveHuddle();
    give(display);
    await settled();
    expect(displayTrack().readyState).toBe("ended");
    expect(joinedHuddle()).toBeNull();

    await joined();
    shareHuddleScreen(true);
    await settled();
    leaveHuddle();
    fail(new DOMException("Could not start video source", "NotReadableError"));
    await settled();
    expect(said).not.toHaveBeenCalled();
    stop();
  });
});

describe("Watching the screens shared in a huddle", () => {
  it("asks for the screens shared, by whose they are, on a connection of its own, and shows each person's apart from their camera", async () => {
    const room = await joined([person(grace, { video: true, screen: true }), person(linus)]);
    expect(room.take()).toEqual([
      { type: "huddle.listen", kind: "audio", fresh: true },
      { type: "huddle.listen", kind: "video", fresh: true, watch: [grace.id] },
      { type: "huddle.listen", kind: "screen", fresh: true, watch: [grace.id] },
      expect.objectContaining({ type: "huddle.publish" }),
    ]);
    expect(joinedHuddle()!.screens).toEqual(new Map());

    room.receive(screens(["0", grace]));
    await settled();
    const watching = connection();
    expect(FakeConnection.all).toHaveLength(2);
    expect(watching.configuration).toEqual({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
    expect(room.take()).toEqual([{ type: "huddle.answer", kind: "screen", sdp: "answer to offer:0" }]);
    expect([...joinedHuddle()!.screens.keys()]).toEqual([grace.id]);
    expect((joinedHuddle()!.screens.get(grace.id) as unknown as FakeStream).tracks).toEqual([watching.transceivers[0]!.receiver.track]);
    // Her camera is another picture, on another connection, which the tab has yet to be offered.
    expect(joinedHuddle()!.watched).toEqual(new Map());
    expect(voices()).toEqual([]);

    await watchedRound(["0", grace]);
    expect(FakeConnection.all).toHaveLength(3);
    expect((joinedHuddle()!.watched.get(grace.id) as unknown as FakeStream).tracks).toEqual([connection().transceivers[0]!.receiver.track]);
    expect([...joinedHuddle()!.screens.keys()]).toEqual([grace.id]);
  });

  it("asks for a screen as it's shared, and stops showing one that's stopped, or whose person leaves", async () => {
    const room = await joined([person(grace), person(linus)]);
    room.take();
    room.receive({ type: "huddle.changed", person: person(grace, { screen: true }) });
    expect(taken("screen")).toEqual([{ type: "huddle.listen", kind: "screen", fresh: true, watch: [grace.id] }]);
    await sharedRound(["0", grace]);
    room.take();

    room.receive({ type: "huddle.changed", person: person(linus, { screen: true }) });
    expect(taken("screen")).toEqual([{ type: "huddle.listen", kind: "screen", watch: [grace.id, linus.id] }]);
    await sharedRound(["1", linus]);
    expect([...joinedHuddle()!.screens.keys()]).toEqual([grace.id, linus.id]);
    room.take();

    room.receive({ type: "huddle.changed", person: person(grace) });
    expect([...joinedHuddle()!.screens.keys()]).toEqual([linus.id]);
    room.receive({ type: "huddle.left", userId: linus.id });
    expect(joinedHuddle()!.screens).toEqual(new Map());
    expect(taken("screen")).toEqual([]);
    // Nor is the tab's own screen anyone's to watch.
    room.receive({ type: "huddle.changed", person: person(ada, { audio: false, screen: true }) });
    expect(taken("screen")).toEqual([]);
  });

  it("asks for nobody's once the huddle is closed to its bar, so the room stops sending them, and for them again once it's opened", async () => {
    const room = await joined([person(grace, { video: true, screen: true })]);
    await watchedRound(["0", grace]);
    await sharedRound(["0", grace]);
    room.take();
    const [, , watching] = FakeConnection.all;

    openHuddle(false);
    expect(joinedHuddle()).toMatchObject({ open: false, watched: new Map(), screens: new Map() });
    expect(room.take()).toEqual([
      { type: "huddle.listen", kind: "video", watch: [] },
      { type: "huddle.listen", kind: "screen", watch: [] },
    ]);
    room.receive({ type: "huddle.listening", kind: "screen" });
    expect(watching!.connectionState).toBe("closed");

    openHuddle(true);
    expect(taken("screen")).toEqual([{ type: "huddle.listen", kind: "screen", fresh: true, watch: [grace.id] }]);
    await sharedRound(["0", grace]);
    expect([...joinedHuddle()!.screens.keys()]).toEqual([grace.id]);
  });

  it("watches no more screens than a huddle shows", async () => {
    const crowd = Array.from({ length: MAX_HUDDLE_SCREENS + 1 }, (_, n) => person({ id: `p${n}`, name: `Person ${n}` }, { audio: false, screen: true }));
    await joined(crowd);
    const [asked] = taken("screen");
    expect(asked!.watch).toEqual(crowd.slice(0, MAX_HUDDLE_SCREENS).map(({ user }) => user.id));
  });

  it("starts watching over by itself when the room couldn't do what a round asked, and goes on hearing and watching cameras meanwhile", async () => {
    const room = await joined([person(grace, { video: true, screen: true })]);
    await publishedAndConnected();
    await offeredRound(["0", grace]);
    room.receive({ type: "huddle.listening", kind: "audio" });
    await watchedRound(["0", grace]);
    await sharedRound(["0", grace]);
    const [, hearing, pictured, watching] = FakeConnection.all;
    room.receive({ type: "huddle.joined", person: person(linus, { audio: false, screen: true }) });
    room.take();

    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.listen", kind: "screen" });
    expect(watching!.connectionState).toBe("closed");
    expect(joinedHuddle()!.screens).toEqual(new Map());
    expect([hearing!.connectionState, pictured!.connectionState, voices().length, joinedHuddle()!.watched.size]).toEqual(["new", "new", 1, 1]);
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "screen", fresh: true, watch: [grace.id, linus.id] }]);
    expect(room.closedWith).toBeUndefined();
  });
});

describe("Choosing another device in a huddle", () => {
  /** A microphone's stream, or a camera's, from the device `deviceId`. */
  const deviceStream = (kind: "audio" | "video", deviceId: string) => new FakeStream([new FakeTrack(kind, deviceId)]);
  const trackOf = (stream: FakeStream) => stream.tracks[0]!;
  /** What the tab asks the browser for the camera `deviceId` with. */
  const cameraAsked = (deviceId: string) => ({ video: { width: { ideal: 640 }, height: { ideal: 360 }, deviceId: { exact: deviceId } } });

  /**
   * Has the browser open, of `streams`, the one from the device the tab asks for, or the first when it
   * asks for the browser's own choice, and refuse it any other. Answers what the tab asked it.
   */
  function browserDevices(...streams: FakeStream[]) {
    const getUserMedia = vi.fn(async ({ audio, video }: MediaStreamConstraints) => {
      const { deviceId } = (audio ?? video) as { deviceId?: { exact: string } };
      const stream = deviceId ? streams.find((from) => trackOf(from).deviceId === deviceId.exact) : streams[0];
      if (!stream) throw new DOMException("Permission denied", "NotAllowedError");
      return stream;
    });
    vi.stubGlobal("navigator", { mediaDevices: Object.assign(new EventTarget(), { getUserMedia }) });
    return getUserMedia;
  }

  afterEach(() => {
    for (const kind of ["microphone", "speaker", "camera"]) localStorage.removeItem(`ember:huddle-${kind}`);
  });

  it("speaks through another microphone once the browser has opened it: on the connection it has, measured in the first one's place, which is closed", async () => {
    const usb = deviceStream("audio", "usb");
    const asked = browserDevices(usb);
    const engine = audioEngine();
    const room = await joined();
    const sending = await publishedAndConnected();
    const first = microphoneTrack();
    room.take();
    expect(joinedHuddle()).toMatchObject({ microphoneId: "built-in" });

    chooseHuddleDevice("microphone", "usb");
    await settled();
    expect(asked).toHaveBeenCalledExactlyOnceWith({ audio: { deviceId: { exact: "usb" } } });
    expect(sending.transceivers[0]!.sender.track).toBe(trackOf(usb));
    expect([first.readyState, trackOf(usb).readyState]).toEqual(["ended", "live"]);
    expect(joinedHuddle()).toMatchObject({ muted: false, microphone: true, microphoneId: "usb" });
    expect(engine.measured()).toEqual([trackOf(usb)]);
    expect(localStorage.getItem("ember:huddle-microphone")).toBe("usb");
    // The SFU carries the track it did, so the room hears nothing of it.
    expect(room.take()).toEqual([]);
    expect(FakeConnection.all).toEqual([sending]);

    // Chosen again, the one it has is nothing to ask the browser for.
    chooseHuddleDevice("microphone", "usb");
    await settled();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("stays as muted as it was, and mutes and unmutes the microphone it speaks through now", async () => {
    const usb = deviceStream("audio", "usb");
    browserDevices(usb);
    const room = await joined();
    muteHuddle(true);
    room.take();

    chooseHuddleDevice("microphone", "usb");
    await settled();
    expect(trackOf(usb).enabled).toBe(false);
    expect(joinedHuddle()).toMatchObject({ muted: true, microphone: true });
    expect(room.take()).toEqual([]);

    muteHuddle(false);
    expect(trackOf(usb).enabled).toBe(true);
    expect(room.take()).toEqual([{ type: "huddle.mute", muted: false }]);
  });

  it("leaves its person listening once the microphone chosen is unplugged, where the end of the one before is nothing to it", async () => {
    const usb = deviceStream("audio", "usb");
    browserDevices(usb);
    const room = await joined();
    const first = microphoneTrack();
    chooseHuddleDevice("microphone", "usb");
    await settled();
    room.take();

    first.end();
    expect(room.take()).toEqual([]);
    expect(joinedHuddle()).toMatchObject({ muted: false, microphone: true });
    trackOf(usb).end();
    expect(room.take()).toEqual([{ type: "huddle.mute", muted: true }]);
    expect(joinedHuddle()).toMatchObject({ muted: true, microphone: false, microphoneId: "" });
  });

  it("publishes the microphone anew when its connection won't send another track", async () => {
    const usb = deviceStream("audio", "usb");
    browserDevices(usb);
    const room = await joined();
    const first = await publishedAndConnected();
    room.take();
    FakeConnection.keepingTracks = true;

    chooseHuddleDevice("microphone", "usb");
    await settled();
    expect(first.connectionState).toBe("closed");
    expect(connection().transceivers[0]!.sender.track).toBe(trackOf(usb));
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 2", tracks: [{ mid: "0", kind: "audio" }] }]);
  });

  it("publishes a microphone chosen before the room lets the tab in with the room's welcome, which measures it as its person's", async () => {
    const usb = deviceStream("audio", "usb");
    browserDevices(usb);
    const engine = audioEngine();
    joinHuddle({ roomId: "general", muted: false, microphone: microphone as unknown as MediaStream, camera: null, speakerId: "" });
    socket().open();
    chooseHuddleDevice("microphone", "usb");
    await settled();
    expect(FakeConnection.all).toEqual([]);
    expect(engine.measured()).toEqual([]);

    const room = await welcomed();
    expect(FakeConnection.all).toHaveLength(1);
    expect(connection().transceivers[0]!.sender.track).toBe(trackOf(usb));
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 1", tracks: [{ mid: "0", kind: "audio" }] }]);
    expect(engine.measured()).toEqual([trackOf(usb)]);
  });

  it("gives a tab that joined to listen the browser's own choice of microphone, which it publishes, and stays muted on until its person unmutes", async () => {
    const builtIn = deviceStream("audio", "built-in");
    const asked = browserDevices(builtIn);
    const engine = audioEngine();
    const room = await joined([], { microphone: null });
    expect(room.take()).toEqual([]);
    expect(joinedHuddle()).toMatchObject({ muted: true, microphone: false, microphoneId: "" });

    chooseHuddleDevice("microphone", "");
    await settled();
    expect(asked).toHaveBeenCalledExactlyOnceWith({ audio: true });
    expect(joinedHuddle()).toMatchObject({ muted: true, microphone: true, microphoneId: "built-in" });
    expect(trackOf(builtIn).enabled).toBe(false);
    expect(connection().transceivers[0]!.sender.track).toBe(trackOf(builtIn));
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 1", tracks: [{ mid: "0", kind: "audio" }] }]);
    expect(engine.measured()).toEqual([trackOf(builtIn)]);

    muteHuddle(false);
    expect(trackOf(builtIn).enabled).toBe(true);
    expect(room.take()).toEqual([{ type: "huddle.mute", muted: false }]);
    expect(joinedHuddle()).toMatchObject({ muted: false });
  });

  it("has a microphone again, muted still, once one is chosen after its own was unplugged", async () => {
    const usb = deviceStream("audio", "usb");
    browserDevices(usb);
    const room = await joined();
    const sending = await publishedAndConnected();
    microphoneTrack().end();
    room.take();

    chooseHuddleDevice("microphone", "usb");
    await settled();
    expect(joinedHuddle()).toMatchObject({ muted: true, microphone: true, microphoneId: "usb" });
    expect(trackOf(usb).enabled).toBe(false);
    expect(sending.transceivers[0]!.sender.track).toBe(trackOf(usb));
    expect(room.take()).toEqual([]);
  });

  it("keeps the microphone it has, and says so, when the browser won't open the one chosen", async () => {
    browserDevices();
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined();
    const sending = connection();
    room.take();

    chooseHuddleDevice("microphone", "usb");
    await settled();
    expect(said).toHaveBeenCalledExactlyOnceWith(NO_OTHER_MICROPHONE);
    expect(microphoneTrack().readyState).toBe("live");
    expect(sending.transceivers[0]!.sender.track).toBe(microphoneTrack());
    expect(joinedHuddle()).toMatchObject({ microphone: true, microphoneId: "built-in" });
    expect(room.take()).toEqual([]);
    stop();
  });

  it("tells someone who only listens that there's no microphone for them still, when the browser won't open one", async () => {
    browserDevices();
    const said = vi.fn();
    const stop = hearHuddle(said);
    await joined([], { microphone: null });

    chooseHuddleDevice("microphone", "");
    await settled();
    expect(said).toHaveBeenCalledExactlyOnceWith(STILL_NO_MICROPHONE);
    expect(joinedHuddle()).toMatchObject({ muted: true, microphone: false });
    stop();
  });

  it("speaks through the last of the microphones chosen while the browser opens them, whichever it opens last, and closes the others", async () => {
    const [usb, headset] = [deviceStream("audio", "usb"), deviceStream("audio", "headset")];
    // The browser takes its time over the first one chosen.
    let openFirst = () => {};
    const getUserMedia = vi.fn(({ audio }: MediaStreamConstraints) =>
      (audio as { deviceId: { exact: string } }).deviceId.exact === "usb" ? new Promise<FakeStream>((resolve) => (openFirst = () => resolve(usb))) : Promise.resolve(headset),
    );
    vi.stubGlobal("navigator", { mediaDevices: Object.assign(new EventTarget(), { getUserMedia }) });
    await joined();
    const sending = connection();

    chooseHuddleDevice("microphone", "usb");
    chooseHuddleDevice("microphone", "headset");
    await settled();
    expect(sending.transceivers[0]!.sender.track).toBe(trackOf(headset));
    openFirst();
    await settled();
    expect([trackOf(usb).readyState, trackOf(headset).readyState]).toEqual(["ended", "live"]);
    expect(sending.transceivers[0]!.sender.track).toBe(trackOf(headset));
    expect(joinedHuddle()).toMatchObject({ microphoneId: "headset" });
    expect(localStorage.getItem("ember:huddle-microphone")).toBe("headset");
  });

  it("keeps the microphone it has when that's chosen while the browser opens another, which is closed", async () => {
    const usb = deviceStream("audio", "usb");
    browserDevices(usb);
    await joined();

    chooseHuddleDevice("microphone", "usb");
    chooseHuddleDevice("microphone", "built-in");
    await settled();
    expect([microphoneTrack().readyState, trackOf(usb).readyState]).toEqual(["live", "ended"]);
    expect(joinedHuddle()).toMatchObject({ microphoneId: "built-in" });
    expect(localStorage.getItem("ember:huddle-microphone")).toBe("built-in");
  });

  it("closes a microphone the browser opens once the tab has left", async () => {
    const usb = deviceStream("audio", "usb");
    browserDevices(usb);
    await joined();

    chooseHuddleDevice("microphone", "usb");
    leaveHuddle();
    await settled();
    expect(trackOf(usb).readyState).toBe("ended");
  });

  it("plays through another speaker: what the huddle plays now, and what it plays after", async () => {
    const setSinkId = vi.fn(async () => {});
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: setSinkId });
    try {
      await joined([person(grace), person(linus)]);
      await offeredRound(["0", grace]);
      expect(setSinkId).not.toHaveBeenCalled();

      chooseHuddleDevice("speaker", "headphones");
      expect(setSinkId).toHaveBeenCalledExactlyOnceWith("headphones");
      expect(madeOn(setSinkId)).toEqual([grace.id]);
      // Shown, and kept for the next huddle, once the browser plays through it.
      expect(joinedHuddle()).toMatchObject({ speakerId: "" });
      await settled();
      expect(joinedHuddle()).toMatchObject({ speakerId: "headphones" });
      expect(localStorage.getItem("ember:huddle-speaker")).toBe("headphones");
      await offeredRound(["1", linus]);
      expect(setSinkId.mock.calls).toEqual([["headphones"], ["headphones"]]);
      expect(madeOn(setSinkId)).toEqual([grace.id, linus.id]);

      // And through the system's again, which this browser's next huddle starts with.
      setSinkId.mockClear();
      chooseHuddleDevice("speaker", "");
      expect(setSinkId.mock.calls).toEqual([[""], [""]]);
      await settled();
      expect(joinedHuddle()).toMatchObject({ speakerId: "" });
      expect(localStorage.getItem("ember:huddle-speaker")).toBeNull();
    } finally {
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    }
  });

  it("keeps the speaker it has, and says so, when the browser won't play through the one chosen", async () => {
    const setSinkId = vi.fn(async (deviceId: string) => {
      if (deviceId === "monitor") throw new DOMException("Refused", "NotAllowedError");
    });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: setSinkId });
    const said = vi.fn();
    const stop = hearHuddle(said);
    try {
      await joined([person(grace)]);
      await offeredRound(["0", grace]);
      chooseHuddleDevice("speaker", "headphones");
      await settled();
      setSinkId.mockClear();

      chooseHuddleDevice("speaker", "monitor");
      await settled();
      expect(said).toHaveBeenCalledExactlyOnceWith(NO_OTHER_SPEAKER);
      // Back through the one before, which the huddle shows still, and this browser's next huddle starts with.
      expect(setSinkId.mock.calls).toEqual([["monitor"], ["headphones"]]);
      expect(joinedHuddle()).toMatchObject({ speakerId: "headphones" });
      expect(localStorage.getItem("ember:huddle-speaker")).toBe("headphones");
    } finally {
      stop();
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    }
  });

  it("shows the last of two speakers chosen one right after the other, however long the browser takes over the first", async () => {
    let take = () => {};
    const taken = new Promise<void>((resolve) => (take = resolve));
    const setSinkId = vi.fn(async (deviceId: string) => {
      if (deviceId === "headphones") await taken;
    });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: setSinkId });
    try {
      await joined([person(grace)]);
      await offeredRound(["0", grace]);

      chooseHuddleDevice("speaker", "headphones");
      chooseHuddleDevice("speaker", "monitor");
      await settled();
      expect(joinedHuddle()).toMatchObject({ speakerId: "" });
      take();
      await settled();
      expect(setSinkId.mock.calls).toEqual([["headphones"], ["monitor"]]);
      expect(joinedHuddle()).toMatchObject({ speakerId: "monitor" });
      expect(localStorage.getItem("ember:huddle-speaker")).toBe("monitor");
    } finally {
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    }
  });

  it("forgets a speaker chosen as the tab leaves, which its next huddle doesn't start with", async () => {
    const setSinkId = vi.fn(async () => {});
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: setSinkId });
    const said = vi.fn();
    const stop = hearHuddle(said);
    try {
      await joined([person(grace)]);
      await offeredRound(["0", grace]);

      chooseHuddleDevice("speaker", "headphones");
      leaveHuddle();
      await settled();
      expect(localStorage.getItem("ember:huddle-speaker")).toBeNull();
      expect(said).not.toHaveBeenCalled();
    } finally {
      stop();
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    }
  });

  it("shows another camera in place of the one that's on, once the browser has opened it: on the connection it has, with the first one closed", async () => {
    const rear = deviceStream("video", "rear");
    const asked = browserDevices(rear);
    const room = await joined([], { camera: asCamera() });
    const picture = await cameraConnected();
    const first = cameraTrack();

    chooseHuddleDevice("camera", "rear");
    await settled();
    expect(asked).toHaveBeenCalledExactlyOnceWith(cameraAsked("rear"));
    expect(joinedHuddle()).toMatchObject({ camera: rear });
    expect(picture.transceivers[0]!.sender.track).toBe(trackOf(rear));
    expect([first.readyState, trackOf(rear).readyState]).toEqual(["ended", "live"]);
    expect(localStorage.getItem("ember:huddle-camera")).toBe("rear");
    expect(room.take()).toEqual([]);
    expect(FakeConnection.all).toHaveLength(2);

    // The end of the one before is nothing to it, and the one chosen goes off as it's unplugged.
    first.end();
    expect(joinedHuddle()).toMatchObject({ camera: rear });
    trackOf(rear).end();
    expect(joinedHuddle()).toMatchObject({ camera: null });
    expect(room.take()).toEqual([{ type: "huddle.unpublish", kind: "video" }]);
  });

  it("asks the browser for nothing when the camera chosen is the one that's on", async () => {
    const asked = browserDevices();
    await joined([], { camera: asCamera() });

    chooseHuddleDevice("camera", "front");
    await settled();
    expect(asked).not.toHaveBeenCalled();
    expect(joinedHuddle()).toMatchObject({ camera });
  });

  it("publishes anew a camera chosen in place of one sent in another number of sizes, which its connection wasn't made to send", async () => {
    camera = cameraFrom("front", 640, 360);
    const [rear, side] = [cameraFrom("rear", 320, 180), cameraFrom("side", 1280, 720)];
    browserDevices(rear, side);
    browserIs(CHROME);
    const room = await joined([], { camera: asCamera() });
    const first = await cameraConnected();
    expect(first.transceivers[0]!.sendEncodings).toEqual(TWO_SIZES);

    // Of a picture too small for two, a connection made for two would send the smaller size alone.
    chooseHuddleDevice("camera", "rear");
    await settled();
    const second = connection();
    expect(first.connectionState).toBe("closed");
    expect(second.transceivers).toEqual([expect.objectContaining({ sendEncodings: [{ maxBitrate: CAMERA_BITRATE }], sender: { track: trackOf(rear) } })]);
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 3", tracks: [{ mid: "0", kind: "video" }] }]);

    // And one made for one size would send a larger picture in that one alone.
    await cameraConnected();
    chooseHuddleDevice("camera", "side");
    await settled();
    expect(second.connectionState).toBe("closed");
    expect(connection().transceivers).toEqual([expect.objectContaining({ sendEncodings: TWO_SIZES, sender: { track: trackOf(side) } })]);
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 4", tracks: [{ mid: "0", kind: "video" }] }]);
  });

  it("sends a camera chosen in place of one sent in as many sizes on the connection it has, in both of them", async () => {
    camera = cameraFrom("front", 640, 360);
    const rear = cameraFrom("rear", 1280, 720);
    browserDevices(rear);
    browserIs(CHROME);
    const room = await joined([], { camera: asCamera() });
    const picture = await cameraConnected();

    chooseHuddleDevice("camera", "rear");
    await settled();
    expect(connection()).toBe(picture);
    expect(picture.transceivers[0]!.sender.track).toBe(trackOf(rear));
    expect(picture.getSenders()[0]!.getParameters().encodings).toEqual(TWO_SIZES);
    expect(room.take()).toEqual([]);
  });

  it("sends a camera chosen in a huddle that keeps to one size, the room having failed to publish two, on the connection it has, though the camera would go out in two", async () => {
    camera = cameraFrom("front", 640, 360);
    const rear = cameraFrom("rear", 1280, 720);
    browserDevices(rear);
    browserIs(CHROME);
    const room = await joined([], { camera: asCamera() });
    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.publish", kind: "video" });
    await wait(PUBLISH_AGAIN_MS[0]);
    const whole = await cameraConnected();
    expect(whole.transceivers[0]!.sendEncodings).toEqual([{ maxBitrate: CAMERA_BITRATE }]);

    chooseHuddleDevice("camera", "rear");
    await settled();
    expect(connection()).toBe(whole);
    expect(whole.transceivers[0]!.sender.track).toBe(trackOf(rear));
    expect(room.take()).toEqual([]);
  });

  it("turns the camera on with the one chosen while it's off", async () => {
    const rear = deviceStream("video", "rear");
    const asked = browserDevices(rear);
    const room = await joined();
    room.take();

    chooseHuddleDevice("camera", "rear");
    await settled();
    expect(asked).toHaveBeenCalledExactlyOnceWith(cameraAsked("rear"));
    expect(joinedHuddle()).toMatchObject({ camera: rear });
    expect(connection().transceivers[0]!.sender.track).toBe(trackOf(rear));
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 2", tracks: [{ mid: "0", kind: "video" }] }]);
    expect(localStorage.getItem("ember:huddle-camera")).toBe("rear");
  });

  it("publishes a camera chosen before the room lets the tab in with the room's welcome", async () => {
    const rear = deviceStream("video", "rear");
    browserDevices(rear);
    joinHuddle({ roomId: "general", muted: false, microphone: microphone as unknown as MediaStream, camera: asCamera(), speakerId: "" });
    socket().open();
    chooseHuddleDevice("camera", "rear");
    await settled();
    expect(joinedHuddle()).toMatchObject({ camera: rear });
    expect(FakeConnection.all).toEqual([]);

    await welcomed();
    expect(FakeConnection.all).toHaveLength(2);
    expect(connection().transceivers[0]!.sender.track).toBe(trackOf(rear));
  });

  it("has the camera that was on back on, and says so, when the browser won't open the one chosen: opened again, on the connection it has", async () => {
    const again = deviceStream("video", "front");
    const asked = browserDevices(again);
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined([], { camera: asCamera() });
    const picture = await cameraConnected();

    chooseHuddleDevice("camera", "rear");
    await settled();
    expect(asked.mock.calls).toEqual([[cameraAsked("rear")], [cameraAsked("front")]]);
    expect(said).toHaveBeenCalledExactlyOnceWith(NO_OTHER_CAMERA);
    expect(joinedHuddle()).toMatchObject({ camera: again });
    expect([cameraTrack().readyState, trackOf(again).readyState]).toEqual(["ended", "live"]);
    expect(picture.transceivers[0]!.sender.track).toBe(trackOf(again));
    expect(room.take()).toEqual([]);

    // It goes off as it's unplugged, as the one before it would have.
    trackOf(again).end();
    expect(joinedHuddle()).toMatchObject({ camera: null });
    stop();
  });

  it("is left with its camera off, and says so, when the browser won't open the one chosen, nor the one that was on again", async () => {
    browserDevices();
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined([], { camera: asCamera() });
    const picture = await cameraConnected();

    chooseHuddleDevice("camera", "rear");
    await settled();
    expect(said).toHaveBeenCalledExactlyOnceWith(CAMERA_WENT_OFF);
    expect(joinedHuddle()).toMatchObject({ camera: null });
    expect(cameraTrack().readyState).toBe("ended");
    expect(picture.connectionState).toBe("closed");
    expect(room.take()).toEqual([{ type: "huddle.unpublish", kind: "video" }]);

    // Its person turns it on again, with the one they chose, which the browser opens by now.
    const rear = deviceStream("video", "rear");
    browserDevices(rear);
    showHuddleCamera(true);
    await settled();
    expect(joinedHuddle()).toMatchObject({ camera: rear });
    expect(connection().transceivers[0]!.sender.track).toBe(trackOf(rear));
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 3", tracks: [{ mid: "0", kind: "video" }] }]);
    stop();
  });

  it("takes up no camera chosen while the browser opens another, which is the one this browser remembers", async () => {
    const [rear, side] = [deviceStream("video", "rear"), deviceStream("video", "side")];
    const asked = browserDevices(rear, side);
    await joined([], { camera: asCamera() });

    chooseHuddleDevice("camera", "rear");
    chooseHuddleDevice("camera", "side");
    await settled();
    expect(asked).toHaveBeenCalledExactlyOnceWith(cameraAsked("rear"));
    expect(joinedHuddle()).toMatchObject({ camera: rear });
    expect(localStorage.getItem("ember:huddle-camera")).toBe("rear");
  });

  it("closes a camera the browser opens once the one it was to take the place of is off", async () => {
    const rear = deviceStream("video", "rear");
    browserDevices(rear);
    const room = await joined([], { camera: asCamera() });
    room.take();

    chooseHuddleDevice("camera", "rear");
    showHuddleCamera(false);
    await settled();
    expect(trackOf(rear).readyState).toBe("ended");
    expect(joinedHuddle()).toMatchObject({ camera: null });
    expect(room.take()).toEqual([{ type: "huddle.unpublish", kind: "video" }]);
  });

  it("closes a camera the browser opens once the tab has left", async () => {
    const rear = deviceStream("video", "rear");
    browserDevices(rear);
    await joined([], { camera: asCamera() });

    chooseHuddleDevice("camera", "rear");
    leaveHuddle();
    await settled();
    expect(trackOf(rear).readyState).toBe("ended");
  });
});

describe("Switching cameras in a huddle", () => {
  /** One of the browser's cameras: the device it is, and which way it faces, where the browser says. */
  interface Camera {
    deviceId: string;
    facingMode?: "user" | "environment";
  }
  const FRONT: Camera = { deviceId: "front", facingMode: "user" };
  const BACK: Camera = { deviceId: "back", facingMode: "environment" };

  const SIZE = { width: { ideal: 640 }, height: { ideal: 360 } };
  /** What the tab asks the browser for the camera that faces `facingMode` with, and for the camera `deviceId`. */
  const facingAsked = (facingMode: string) => ({ video: { ...SIZE, facingMode: { exact: facingMode } } });
  const cameraAsked = (deviceId: string) => ({ video: { ...SIZE, deviceId: { exact: deviceId } } });

  const trackOf = (stream: FakeStream) => stream.tracks[0]!;
  /** The tab's camera as its huddle has it, the device that's from, and which this browser's next huddle starts with. */
  const shown = () => joinedHuddle()!.camera as unknown as FakeStream | null;
  const showing = () => shown()?.tracks[0]?.deviceId ?? null;
  const remembered = () => localStorage.getItem("ember:huddle-camera");

  /**
   * Has the browser be a phone's, which lists `cameras` and has one of them open at a time: the one that
   * faces the way the tab asks for, the one from the device it asks for, or its first as its own choice,
   * opened anew each time. Answers what the tab asked it, each camera it has opened, and what opens the
   * one a test joins with.
   */
  function phoneWith(...cameras: Camera[]) {
    const opened: FakeStream[] = [];
    const open = (camera: Camera) => {
      const stream = new FakeStream([new FakeTrack("video", camera.deviceId, { facingMode: camera.facingMode })]);
      opened.push(stream);
      return stream as unknown as MediaStream;
    };
    const asked = vi.fn(async ({ video }: MediaStreamConstraints) => {
      const { deviceId, facingMode } = video as { deviceId?: { exact: string }; facingMode?: { exact: string } };
      const camera = cameras.find((listed) => (facingMode ? listed.facingMode === facingMode.exact : !deviceId || listed.deviceId === deviceId.exact));
      if (!camera) throw new DOMException("No such camera", "OverconstrainedError");
      if (opened.some((stream) => trackOf(stream).readyState === "live")) throw new DOMException("Could not start video source", "NotReadableError");
      return open(camera);
    });
    const enumerateDevices = async () => cameras.map(({ deviceId }) => ({ kind: "videoinput", deviceId, label: "" }));
    vi.stubGlobal("navigator", { mediaDevices: Object.assign(new EventTarget(), { getUserMedia: asked, enumerateDevices }) });
    return { asked, opened, open };
  }

  afterEach(() => {
    localStorage.removeItem("ember:huddle-camera");
  });

  it("shows the camera that faces away in place of the one that faces the tab's person, and then that one again: each once the one before is let go of, on the connection it has", async () => {
    const phone = phoneWith(FRONT, BACK);
    const room = await joined([], { camera: phone.open(FRONT) });
    const picture = await cameraConnected();

    switchHuddleCamera();
    await settled();
    expect(phone.asked.mock.calls).toEqual([[facingAsked("environment")]]);
    expect(showing()).toBe("back");
    expect(picture.transceivers[0]!.sender.track).toBe(trackOf(shown()!));
    expect(phone.opened.map((stream) => trackOf(stream).readyState)).toEqual(["ended", "live"]);
    expect(remembered()).toBe("back");

    switchHuddleCamera();
    await settled();
    expect(phone.asked.mock.calls.slice(1)).toEqual([[facingAsked("user")]]);
    expect(showing()).toBe("front");
    expect(picture.transceivers[0]!.sender.track).toBe(trackOf(shown()!));
    expect(phone.opened.map((stream) => trackOf(stream).readyState)).toEqual(["ended", "ended", "live"]);
    expect(remembered()).toBe("front");
    expect(room.take()).toEqual([]);
    expect(FakeConnection.all).toHaveLength(2);

    // The end of one it let go of is nothing to it, and the one it shows goes off as it's unplugged.
    trackOf(phone.opened[1]!).end();
    expect(showing()).toBe("front");
    trackOf(shown()!).end();
    expect(shown()).toBeNull();
    expect(room.take()).toEqual([{ type: "huddle.unpublish", kind: "video" }]);
  });

  it("goes to the next camera the browser lists, and round to its first after its last, where the browser doesn't say which way they face", async () => {
    const phone = phoneWith({ deviceId: "built-in" }, { deviceId: "usb" }, { deviceId: "capture" });
    await joined([], { camera: phone.open({ deviceId: "built-in" }) });

    for (const next of ["usb", "capture", "built-in"]) {
      switchHuddleCamera();
      await settled();
      expect(phone.asked).toHaveBeenLastCalledWith(cameraAsked(next));
      expect([showing(), remembered()]).toEqual([next, next]);
    }
    expect(phone.asked).toHaveBeenCalledTimes(3);
  });

  it("goes to the next camera the browser lists where it has none that faces the other way", async () => {
    const phone = phoneWith(FRONT, { deviceId: "usb" });
    await joined([], { camera: phone.open(FRONT) });

    switchHuddleCamera();
    await settled();
    expect(phone.asked.mock.calls).toEqual([[facingAsked("environment")], [cameraAsked("usb")]]);
    expect([showing(), remembered()]).toEqual(["usb", "usb"]);

    switchHuddleCamera();
    await settled();
    expect(phone.asked.mock.calls.slice(2)).toEqual([[cameraAsked("front")]]);
    expect([showing(), remembered()]).toEqual(["front", "front"]);
  });

  it("has the camera that was on back on, and says so, when the browser has no other: opened again, on the connection it has", async () => {
    const phone = phoneWith(FRONT);
    localStorage.setItem("ember:huddle-camera", "usb");
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined([], { camera: phone.open(FRONT) });
    const picture = await cameraConnected();

    switchHuddleCamera();
    await settled();
    expect(phone.asked.mock.calls).toEqual([[facingAsked("environment")], [cameraAsked("front")]]);
    expect(said).toHaveBeenCalledExactlyOnceWith(NO_OTHER_CAMERA);
    expect(showing()).toBe("front");
    expect(phone.opened.map((stream) => trackOf(stream).readyState)).toEqual(["ended", "live"]);
    expect(picture.transceivers[0]!.sender.track).toBe(trackOf(shown()!));
    // The one this browser's next huddle starts with is the one it was.
    expect(remembered()).toBe("usb");
    expect(room.take()).toEqual([]);
    stop();
  });

  it("is left with its camera off, and says so, when the browser opens neither another camera nor the one that was on again", async () => {
    const phone = phoneWith(FRONT, BACK);
    localStorage.setItem("ember:huddle-camera", "front");
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined([], { camera: phone.open(FRONT) });
    const picture = await cameraConnected();
    phone.asked.mockRejectedValue(new DOMException("Could not start video source", "NotReadableError"));

    switchHuddleCamera();
    await settled();
    expect(phone.asked.mock.calls).toEqual([[facingAsked("environment")], [cameraAsked("back")], [cameraAsked("front")]]);
    expect(said).toHaveBeenCalledExactlyOnceWith(CAMERA_WENT_OFF);
    expect(shown()).toBeNull();
    expect(picture.connectionState).toBe("closed");
    expect(remembered()).toBe("front");
    expect(room.take()).toEqual([{ type: "huddle.unpublish", kind: "video" }]);
    stop();
  });

  it("leaves a camera that's off off", async () => {
    const phone = phoneWith(FRONT, BACK);
    const room = await joined();
    room.take();

    switchHuddleCamera();
    await settled();
    expect(phone.asked).not.toHaveBeenCalled();
    expect(shown()).toBeNull();
    expect(room.take()).toEqual([]);
  });

  it("takes up no switch while the browser opens a camera already, nor a camera chosen while it switches, which this browser doesn't remember", async () => {
    const phone = phoneWith(FRONT, BACK, { deviceId: "usb" });
    await joined([], { camera: phone.open(FRONT) });

    switchHuddleCamera();
    switchHuddleCamera();
    chooseHuddleDevice("camera", "usb");
    await settled();
    expect(phone.asked).toHaveBeenCalledExactlyOnceWith(facingAsked("environment"));
    expect([showing(), remembered()]).toEqual(["back", "back"]);

    // And none while it opens one chosen.
    chooseHuddleDevice("camera", "usb");
    switchHuddleCamera();
    await settled();
    expect(phone.asked.mock.calls.slice(1)).toEqual([[cameraAsked("usb")]]);
    expect([showing(), remembered()]).toEqual(["usb", "usb"]);
  });

  it("closes the camera the browser opens once the one it was to take the place of is turned off, which stays off", async () => {
    const phone = phoneWith(FRONT, BACK);
    localStorage.setItem("ember:huddle-camera", "front");
    const room = await joined([], { camera: phone.open(FRONT) });
    room.take();

    switchHuddleCamera();
    showHuddleCamera(false);
    await settled();
    expect(phone.opened.map((stream) => trackOf(stream).readyState)).toEqual(["ended", "ended"]);
    expect(shown()).toBeNull();
    expect(remembered()).toBe("front");
    expect(room.take()).toEqual([{ type: "huddle.unpublish", kind: "video" }]);
  });

  it("closes the camera the browser opens once the tab has left, and remembers nothing of it", async () => {
    const phone = phoneWith(FRONT, BACK);
    localStorage.setItem("ember:huddle-camera", "front");
    await joined([], { camera: phone.open(FRONT) });

    switchHuddleCamera();
    leaveHuddle();
    await settled();
    expect(phone.opened.map((stream) => trackOf(stream).readyState)).toEqual(["ended", "ended"]);
    expect(remembered()).toBe("front");
  });

  it("opens no camera again for a tab whose camera is off, or that has left, by the time the browser has no other for it, and says nothing", async () => {
    const phone = phoneWith(FRONT);
    const said = vi.fn();
    const stop = hearHuddle(said);
    await joined([], { camera: phone.open(FRONT) });

    switchHuddleCamera();
    showHuddleCamera(false);
    await settled();
    expect(phone.asked).toHaveBeenCalledExactlyOnceWith(facingAsked("environment"));
    expect(shown()).toBeNull();

    showHuddleCamera(true);
    await settled();
    expect(showing()).toBe("front");
    switchHuddleCamera();
    leaveHuddle();
    await settled();
    expect(phone.asked.mock.calls.slice(1)).toEqual([[{ video: SIZE }], [facingAsked("environment")]]);
    expect(trackOf(phone.opened.at(-1)!).readyState).toBe("ended");
    expect(said).not.toHaveBeenCalled();
    stop();
  });
});

describe("A huddle on a phone", () => {
  /**
   * Has the browser be one that keeps its screen awake when it's asked to, on a phone, or with `touch`
   * false, on a computer. Answers what it was asked, and what the tab has let go of.
   */
  function keepsScreenAwake(touch = true) {
    const release = vi.fn(async () => {});
    const request = vi.fn(async (_what: string) => Object.assign(new EventTarget(), { released: false, release }));
    vi.stubGlobal("navigator", { wakeLock: { request } });
    vi.stubGlobal("matchMedia", (media: string) => ({ matches: touch && media === "(pointer: coarse)", media, addEventListener() {}, removeEventListener() {} }));
    return { request, release };
  }

  it("keeps the phone's screen awake from when the tab joins until it leaves", async () => {
    const screen = keepsScreenAwake();
    await joined();
    expect(screen.request).toHaveBeenCalledExactlyOnceWith("screen");
    expect(screen.release).not.toHaveBeenCalled();

    leaveHuddle();
    await settled();
    expect(screen.release).toHaveBeenCalledTimes(1);
  });

  it("lets the phone's screen sleep once the room ends the huddle for the tab", async () => {
    const screen = keepsScreenAwake();
    const room = await joined();
    room.drop(HuddleCloseCode.Off);
    await settled();
    expect(screen.release).toHaveBeenCalledTimes(1);
  });

  it("leaves a computer's screen to sleep as it does", async () => {
    const screen = keepsScreenAwake(false);
    await joined();
    expect(screen.request).not.toHaveBeenCalled();
  });
});

describe("A huddle's own sounds", () => {
  it("play as the room lets the tab in and as someone else joins, and as someone leaves and the tab does", async () => {
    const room = await joined([person(grace)]);
    expect(played()).toEqual(["joined"]);

    room.receive({ type: "huddle.joined", person: person(linus) });
    await settled();
    expect(played()).toEqual(["joined", "joined"]);
    // Someone who mutes, or moves to another of their tabs, hasn't joined,
    room.receive({ type: "huddle.changed", person: person(linus, { muted: true }) });
    await settled();
    expect(played()).toHaveLength(2);

    room.receive({ type: "huddle.left", userId: linus.id });
    await settled();
    expect(played().slice(2)).toEqual(["left"]);
    // and someone the tab didn't know was in the huddle hasn't left it.
    room.receive({ type: "huddle.left", userId: linus.id });
    await settled();
    expect(played()).toHaveLength(3);

    leaveHuddle();
    await settled();
    expect(played().slice(3)).toEqual(["left"]);
  });

  it("play nothing as the room lets the tab back in, to a huddle others have joined and left meanwhile", async () => {
    const room = await joined([person(grace)]);
    room.drop();
    await wait(500);
    socket().open();
    await welcomed([person(linus)]);
    expect(played()).toEqual(["joined"]);
  });

  it("play the leaving sound as the room ends the huddle for the tab's person, unless it never let them in", async () => {
    const room = await joined([person(grace)]);
    room.drop(HuddleCloseCode.Off);
    await settled();
    expect(played()).toEqual(["joined", "left"]);

    joinHuddle({ roomId: "general", muted: false, microphone: null, camera: null, speakerId: "" });
    socket().open();
    socket().drop(HuddleCloseCode.Full);
    await settled();
    expect(played()).toHaveLength(2);
  });

  it("play music to whoever is alone in the huddle, from five seconds after they find themselves alone until someone joins them", async () => {
    const room = await joined();
    await wait(MUSIC_AFTER_MS - 1);
    expect(music()).toBeNull();
    await wait(1);
    expect(music()!.loop).toBe(true);
    expect(played()).toEqual(["joined", "music"]);
    // Muting is nothing to it.
    muteHuddle(true);
    await wait(MUSIC_AFTER_MS);
    expect(played()).toHaveLength(2);

    room.receive({ type: "huddle.joined", person: person(grace) });
    await settled();
    expect(music()).toBeNull();
    expect(stopped()).toEqual(["music"]);

    // Alone again, they hear it go on after another five seconds,
    room.receive({ type: "huddle.left", userId: grace.id });
    await wait(MUSIC_AFTER_MS - 1);
    expect(music()).toBeNull();
    await wait(1);
    expect(music()).not.toBeNull();
    expect(played().slice(2)).toEqual(["joined", "left", "music"]);

    // but not while the tab has lost the room, which may have let someone in since.
    room.drop();
    expect(music()).toBeNull();
    await wait(500);
    socket().open();
    await welcomed();
    await wait(MUSIC_AFTER_MS - 1);
    expect(music()).toBeNull();
    await wait(1);
    expect(music()).not.toBeNull();

    leaveHuddle();
    expect(music()).toBeNull();
    await wait(MUSIC_AFTER_MS);
    expect(played().slice(5)).toEqual(["music", "left"]);
  });

  it("play no music to someone who joins others, or who leaves within five seconds of finding themselves alone", async () => {
    const room = await joined([person(grace)]);
    await wait(MUSIC_AFTER_MS * 2);
    room.receive({ type: "huddle.left", userId: grace.id });
    await wait(MUSIC_AFTER_MS - 1);
    leaveHuddle();
    await wait(MUSIC_AFTER_MS);
    expect(played()).toEqual(["joined", "left", "left"]);
  });
});

describe("A huddle whose socket closes", () => {
  it("shows that it's reconnecting, closes both connections, and starts them again once the room lets it back in", async () => {
    const room = await joined([person(grace)]);
    const sending = await publishedAndConnected();
    await offeredRound(["0", grace]);
    const receiving = connection();
    muteHuddle(true);

    room.drop();
    expect(joinedHuddle()).toMatchObject({ connected: false, people: [person(grace), person(ada, { audio: false, muted: true })] });
    expect([sending.connectionState, receiving.connectionState]).toEqual(["closed", "closed"]);
    expect(voices()).toEqual([]);

    await wait(500);
    expect(FakeSocket.all).toHaveLength(2);
    // The address says how the tab is muted now.
    expect(socket().url).toBe("ws://localhost:3000/api/rooms/general/huddle?muted=1");
    socket().open();
    await welcomed([person(grace), person(linus)]);
    expect(joinedHuddle()).toMatchObject({ connected: true, muted: true, people: [person(grace), person(linus), person(ada, { audio: false, muted: true })] });
    expect(socket().take()).toEqual([{ type: "huddle.listen", kind: "audio", fresh: true }, expect.objectContaining({ type: "huddle.publish", sdp: "offer 2" })]);
    expect(FakeConnection.all).toHaveLength(3);
  });

  it("tells the room how it's muted when that changed while it connected", async () => {
    const room = await joined();
    room.drop();
    await wait(500);
    muteHuddle(true);
    socket().open();
    await welcomed([], { muted: false });
    expect(socket().take()[0]).toEqual({ type: "huddle.mute", muted: true });
  });

  it("connects again without a close, when the socket stops answering", async () => {
    const room = await joined([person(grace)]);
    const sending = await publishedAndConnected();
    await offeredRound(["0", grace]);
    room.receive({ type: "huddle.listening", kind: "audio" });
    // Two heartbeats with nothing heard between them.
    room.silent = true;
    await wait(25_000);
    expect(joinedHuddle()).toMatchObject({ connected: true });
    await wait(25_000);
    expect(room.closedWith).toBe(1005);
    expect(joinedHuddle()).toMatchObject({ connected: false });
    expect([sending.connectionState, connection().connectionState]).toEqual(["closed", "closed"]);
    expect(voices()).toEqual([]);
  });

  it.each([
    ["a publish", 0],
    ["a round of listening", 1],
  ])("joins again on a new socket when the room leaves %s unanswered", async (_, people) => {
    const room = await joined(people ? [person(grace)] : []);
    if (people) room.receive({ type: "huddle.published", kind: "audio", sdp: "the SFU's answer" });
    await wait(ANSWER_TIMEOUT_MS - 1);
    expect(room.closedWith).toBeUndefined();
    expect(joinedHuddle()).toMatchObject({ connected: true });

    await wait(1);
    expect(room.closedWith).toBe(1000);
    expect(joinedHuddle()).toMatchObject({ connected: false });
    for (const each of FakeConnection.all) expect(each.connectionState).toBe("closed");
    await wait(500);
    expect(FakeSocket.all).toHaveLength(2);
    socket().open();
    await welcomed(people ? [person(grace)] : []);
    expect(socket().take()).toEqual([...(people ? [{ type: "huddle.listen", kind: "audio", fresh: true }] : []), expect.objectContaining({ type: "huddle.publish" })]);
  });
});

describe("A huddle's relay", () => {
  /** The servers a room whose huddles have a relay welcomes a tab with: Cloudflare's STUN server, and its relay, with what the tab uses it with for a day. */
  const relayed = (nth = 1): HuddleIceServer[] => [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: `the relay's name ${nth}`, credential: `the relay's credential ${nth}` },
  ];
  /** How a connection reaches the SFU by `servers`. */
  const by = (servers: HuddleIceServer[]) => ({ iceServers: servers, bundlePolicy: "max-bundle" });
  /** And by Cloudflare's STUN server alone, as it does without a relay. */
  const DIRECT = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" };
  const DAY_MS = RELAY_TTL_S * 1000;
  /** How each connection the tab has made reaches the SFU, in the order it made them. */
  const reached = () => FakeConnection.all.map(({ configuration }) => configuration);

  /** The room lets the newest socket in, to a huddle with `people` in it besides Ada, with `iceServers` for the tab's connections. */
  async function welcomedBy(iceServers: HuddleIceServer[], people: HuddlePerson[] = []) {
    socket().receive({ type: "huddle.welcome", you: ada, people: [...people, person(ada, { audio: false, muted: joinedHuddle()!.muted })], startedAt: STARTED_AT, iceServers });
    await settled();
    return socket();
  }

  /** Joins general's huddle, which the room lets the tab into as `welcomedBy` has it. */
  async function joinedBy(iceServers: HuddleIceServer[], people: HuddlePerson[] = [], join: Partial<Parameters<typeof joinHuddle>[0]> = {}) {
    joinHuddle({ roomId: "general", muted: false, microphone: microphone as unknown as MediaStream, camera: null, speakerId: "", ...join });
    socket().open();
    return welcomedBy(iceServers, people);
  }

  it("makes each of the tab's connections by the servers the room welcomed it with, the relay's among them", async () => {
    const room = await joinedBy(relayed(), [person(grace, { video: true })], { camera: asCamera() });
    // The ones it sends its microphone and its camera on.
    expect(reached()).toEqual([by(relayed()), by(relayed())]);
    // And the ones it hears and watches the others on, which it makes as the SFU's offers come.
    room.receive(offer(["0", grace]));
    room.receive(pictures(["0", grace]));
    await settled();
    expect(reached()).toEqual([by(relayed()), by(relayed()), by(relayed()), by(relayed())]);
  });

  it("goes by Cloudflare's STUN server alone once the room welcomes the tab with no servers, as it does once the relay has been taken away", async () => {
    const room = await joinedBy(relayed(), [person(grace)]);
    expect(reached()).toEqual([by(relayed())]);

    room.drop();
    await wait(500);
    socket().open();
    await welcomed([person(grace)]);
    expect(connection().configuration).toEqual(DIRECT);
    // A day later, a connection that fails is made again on the socket the tab has: there's nothing to have run out.
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    connection().becomes("failed");
    expect(socket().closedWith).toBeUndefined();

    // Nor does a list of none leave a connection without a server.
    socket().drop();
    await wait(500);
    socket().open();
    await welcomedBy([], [person(grace)]);
    expect(connection().configuration).toEqual(DIRECT);
  });

  it("joins again, for the room to give it the relay anew, when a connection fails once the day it was given the relay for has passed, and not before", async () => {
    const room = await joinedBy(relayed(), [person(grace)]);
    const welcomedAt = Date.now();
    const sending = await publishedAndConnected();
    await offeredRound(["0", grace]);
    const receiving = connection();

    // Within the day, the tab makes the connection again on the socket it has.
    vi.setSystemTime(welcomedAt + DAY_MS - 1);
    receiving.becomes("failed");
    expect(room.closedWith).toBeUndefined();
    expect(joinedHuddle()).toMatchObject({ connected: true });
    // After it, what it has no longer opens the relay, so it joins again.
    vi.setSystemTime(welcomedAt + DAY_MS);
    sending.becomes("failed");
    expect(room.closedWith).toBe(1000);
    expect(joinedHuddle()).toMatchObject({ connected: false });
    for (const each of FakeConnection.all) expect(each.connectionState).toBe("closed");
    await wait(500);
    expect(FakeSocket.all).toHaveLength(2);
    socket().open();
    const again = await welcomedBy(relayed(2), [person(grace)]);
    const welcomedAgainAt = Date.now();
    expect(again.take()).toEqual([{ type: "huddle.listen", kind: "audio", fresh: true }, expect.objectContaining({ type: "huddle.publish" })]);
    expect(connection().configuration).toEqual(by(relayed(2)));

    // The day counts from that welcome: the connection it sends on fails within it, and the one it receives on after.
    again.receive(offer(["0", grace]));
    await settled();
    const [sendingAgain, receivingAgain] = FakeConnection.all.slice(-2);
    expect(receivingAgain!.configuration).toEqual(by(relayed(2)));
    vi.setSystemTime(welcomedAgainAt + DAY_MS - 1);
    sendingAgain!.becomes("failed");
    expect(again.closedWith).toBeUndefined();
    vi.setSystemTime(welcomedAgainAt + DAY_MS);
    receivingAgain!.becomes("failed");
    expect(again.closedWith).toBe(1000);
    expect(joinedHuddle()).toMatchObject({ connected: false });
  });

  it("goes without the relay in a browser that can't make a connection by the servers it's given", async () => {
    FakeConnection.refusingRelays = true;
    const room = await joinedBy(relayed(), [person(grace)]);
    expect(reached()).toEqual([DIRECT]);
    expect(room.take()).toEqual([{ type: "huddle.listen", kind: "audio", fresh: true }, expect.objectContaining({ type: "huddle.publish" })]);
    room.receive(offer(["0", grace]));
    await settled();
    expect(reached()).toEqual([DIRECT, DIRECT]);
    expect(room.take()).toEqual([{ type: "huddle.answer", kind: "audio", sdp: "answer to offer:0" }]);
  });
});

describe("Whoever a huddle is told to invite", () => {
  const types = (room: FakeSocket) => room.take().map(({ type }) => type);

  it("is invited once the room lets the tab into a huddle with nobody else in it, as starting one in a direct message does", async () => {
    const room = await joined([], { roomId: "direct-1", invite: [grace.id, linus.id] });
    expect(room.take()).toContainEqual({ type: "huddle.invite", userIds: [grace.id, linus.id] });
  });

  it("isn't invited into a huddle someone else is in already", async () => {
    const room = await joined([person(grace)], { roomId: "direct-1", invite: [grace.id, linus.id] });
    expect(types(room)).not.toContain("huddle.invite");
  });

  it("is nobody unless the tab is told so, as in a shared room, whose huddle invites no one", async () => {
    expect(types(await joined())).not.toContain("huddle.invite");
  });

  it("is invited the once, and not again as the room lets the tab back in after its socket dropped", async () => {
    const room = await joined([], { invite: [grace.id] });
    expect(types(room)).toContain("huddle.invite");
    room.drop();
    await wait(500);
    socket().open();
    expect(types(await welcomed())).not.toContain("huddle.invite");
  });

  it("is said not to have been when the room couldn't invite anyone, which leaves the huddle as it is", async () => {
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined([], { invite: [grace.id] });
    room.take();
    room.receive({ type: "error", message: NOBODY_INVITED, failed: "huddle.invite" });
    await settled();
    expect(said).toHaveBeenCalledExactlyOnceWith(NOBODY_INVITED);
    expect(joinedHuddle()).toMatchObject({ connected: true });
    expect(room.take()).toEqual([]);
    expect(FakeConnection.all).toHaveLength(1);
    stop();
  });
});

describe("Leaving a huddle", () => {
  it("closes the socket and both connections, stops the microphone and the voices, and shows no huddle", async () => {
    const shown = vi.fn();
    const stop = watchHuddle(shown);
    const room = await joined([person(grace)]);
    const sending = await publishedAndConnected();
    await offeredRound(["0", grace]);
    const receiving = connection();
    shown.mockClear();

    leaveHuddle();
    expect(room.closedWith).toBe(1000);
    expect([sending.connectionState, receiving.connectionState]).toEqual(["closed", "closed"]);
    expect(microphoneTrack().readyState).toBe("ended");
    expect(document.querySelector("[data-huddle-voices]")).toBeNull();
    expect(joinedHuddle()).toBeNull();
    expect(shown).toHaveBeenCalledTimes(1);

    // Nothing more comes of it: no socket, no connection, and nothing for its controls to do.
    muteHuddle(true);
    leaveHuddle();
    await wait(ANSWER_TIMEOUT_MS * 2);
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeConnection.all).toHaveLength(2);
    expect(shown).toHaveBeenCalledTimes(1);
    stop();
  });

  it.each([
    [HuddleCloseCode.Full, "That huddle is full. A huddle takes 50 people."],
    [HuddleCloseCode.Off, "Huddles have been turned off."],
    [HuddleCloseCode.Moved, "You joined the huddle somewhere else, so it left this tab."],
    [CloseCode.NotFound, "You left the huddle, since its room is no longer there for you."],
  ])("ends for good, and says why, when the room closes its socket with %i", async (code, why) => {
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined([person(grace)]);
    await offeredRound(["0", grace]);

    room.drop(code);
    expect(said).toHaveBeenCalledExactlyOnceWith(why);
    expect(joinedHuddle()).toBeNull();
    expect(microphoneTrack().readyState).toBe("ended");
    for (const each of FakeConnection.all) expect(each.connectionState).toBe("closed");
    expect(voices()).toEqual([]);
    await wait(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    stop();
  });

  it("ends without a word when the person's sessions have ended, which the app says for itself", async () => {
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined();
    room.drop(CloseCode.Revoked);
    expect(joinedHuddle()).toBeNull();
    expect(said).not.toHaveBeenCalled();
    await wait(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    stop();
  });

  it("connects again after any other close, as when the room asks it to", async () => {
    const said = vi.fn();
    const stop = hearHuddle(said);
    const room = await joined();
    room.drop(CloseCode.Reconnect);
    expect(joinedHuddle()).toMatchObject({ connected: false });
    await wait(500);
    expect(FakeSocket.all).toHaveLength(2);
    expect(said).not.toHaveBeenCalled();
    stop();
  });

  it("says why to whoever listens now, and to nobody once they've stopped", () => {
    const [first, second] = [vi.fn(), vi.fn()];
    const stopFirst = hearHuddle(first);
    const stopSecond = hearHuddle(second);
    // The first to stop is no longer the one listening, and stops nothing.
    stopFirst();
    joinHuddle({ roomId: "general", muted: false, microphone: null, camera: null, speakerId: "" });
    socket().open();
    socket().drop(HuddleCloseCode.Off);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith("Huddles have been turned off.");

    stopSecond();
    joinHuddle({ roomId: "general", muted: false, microphone: null, camera: null, speakerId: "" });
    socket().open();
    socket().drop(HuddleCloseCode.Off);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
