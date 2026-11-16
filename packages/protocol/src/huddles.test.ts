import { describe, expect, it } from "vitest";
import {
  APP_ID_REFUSED,
  APP_SECRET_REFUSED,
  appIdOf,
  appSecretOf,
  HuddleCloseCode,
  huddleSocketQuery,
  MAX_HUDDLE_CAMERAS,
  MAX_HUDDLE_PEOPLE,
  MAX_HUDDLE_SCREENS,
  MAX_SDP_LENGTH,
  parseHuddleClientFrame,
  parseHuddleSocketParams,
  parseHuddlesSetup,
} from "./huddles";
import { CloseCode, MAX_ID_LENGTH } from "./index";

const APP_ID = "2a95132c15732412d22c1476fa83f27a";
const APP_SECRET = "66bcf64aa8907b9f9d90ac17746a77ce394c393b92b3916633dc02846e608ad4";

describe("Set up huddles", () => {
  it("takes an SFU app's ID and its secret, without the spaces around them", () => {
    expect(parseHuddlesSetup({ appId: ` ${APP_ID}\n`, appSecret: `\t${APP_SECRET} ` })).toEqual({ appId: APP_ID, appSecret: APP_SECRET });
    // As they're given, whatever case their letters are in.
    expect(appIdOf(APP_ID.toUpperCase())).toBe(APP_ID.toUpperCase());
    expect(appSecretOf(APP_SECRET.toUpperCase())).toBe(APP_SECRET.toUpperCase());
  });

  it("refuses an App ID that can't be one, on its field", () => {
    const refused = { error: APP_ID_REFUSED, field: "appId" };
    for (const appId of ["", "   ", APP_ID.slice(1), `${APP_ID}0`, `${APP_ID.slice(0, 31)}/`, `${APP_ID.slice(0, 31)}é`, APP_SECRET, 42, null, undefined]) {
      expect(parseHuddlesSetup({ appId, appSecret: APP_SECRET }), JSON.stringify(appId)).toEqual(refused);
    }
    for (const data of [null, undefined, "keys", [APP_ID, APP_SECRET], 7]) expect(parseHuddlesSetup(data), JSON.stringify(data)).toEqual(refused);
  });

  it("refuses an App Secret that can't be one, on its field", () => {
    const refused = { error: APP_SECRET_REFUSED, field: "appSecret" };
    for (const appSecret of ["", APP_SECRET.slice(1), `${APP_SECRET}0`, `${APP_SECRET.slice(0, 63)}.`, `${APP_SECRET.slice(0, 32)} ${APP_SECRET.slice(33)}`, APP_ID, 42, null, undefined]) {
      expect(parseHuddlesSetup({ appId: APP_ID, appSecret }), JSON.stringify(appSecret)).toEqual(refused);
    }
  });
});

describe("a huddle's socket", () => {
  const read = (frame: unknown) => parseHuddleClientFrame(JSON.stringify(frame));
  const SDP = "v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n";

  it("reads what a tab publishes: its offer, and the track its media section carries, a microphone's, a camera's or a screen's", () => {
    expect(read({ type: "huddle.publish", sdp: SDP, tracks: [{ mid: "0", kind: "audio" }] })).toEqual({ type: "huddle.publish", sdp: SDP, tracks: [{ mid: "0", kind: "audio" }] });
    expect(read({ type: "huddle.publish", sdp: SDP, tracks: [{ mid: "0", kind: "video" }] })).toEqual({ type: "huddle.publish", sdp: SDP, tracks: [{ mid: "0", kind: "video" }] });
    expect(read({ type: "huddle.publish", sdp: SDP, tracks: [{ mid: "0", kind: "screen" }] })).toEqual({ type: "huddle.publish", sdp: SDP, tracks: [{ mid: "0", kind: "screen" }] });
    // Only what the room reads is kept.
    expect(read({ type: "huddle.publish", sdp: SDP, tracks: [{ mid: "sdparta_0", kind: "audio", trackName: "theirs" }], sessionId: "theirs" })).toEqual({
      type: "huddle.publish",
      sdp: SDP,
      tracks: [{ mid: "sdparta_0", kind: "audio" }],
    });
  });

  it("refuses an offer that can't be one, and tracks that can't be a tab's", () => {
    const publish = (changes: Record<string, unknown>) => read({ type: "huddle.publish", sdp: SDP, tracks: [{ mid: "0", kind: "audio" }], ...changes });
    for (const sdp of ["", 7, null, undefined, [SDP], "v".repeat(MAX_SDP_LENGTH + 1)]) expect(publish({ sdp }), JSON.stringify(sdp)?.slice(0, 20)).toBeNull();
    expect(publish({ sdp: "v".repeat(MAX_SDP_LENGTH) })).not.toBeNull();
    const refused = [
      undefined,
      null,
      "0",
      [],
      [null],
      ["0"],
      [{ mid: "0" }],
      [{ mid: "0", kind: "slides" }],
      [{ mid: 0, kind: "audio" }],
      [{ mid: "", kind: "audio" }],
      // The SFU reads a track's name after a #, which would name a transceiver the tab didn't make.
      [{ mid: "#audio", kind: "audio" }],
      [{ mid: "0 1", kind: "audio" }],
      [{ mid: "m".repeat(33), kind: "audio" }],
      // A connection sends the one track: the microphone, the camera and the screen each go on their own.
      [{ mid: "0", kind: "audio" }, { mid: "0", kind: "audio" }],
      [{ mid: "0", kind: "audio" }, { mid: "1", kind: "audio" }],
      [{ mid: "0", kind: "audio" }, { mid: "1", kind: "video" }],
      [{ mid: "0", kind: "video" }, { mid: "1", kind: "screen" }],
    ];
    for (const tracks of refused) expect(publish({ tracks }), JSON.stringify(tracks)).toBeNull();
  });

  it("reads the rest of what a tab sends, each frame about a connection saying which pair it's of", () => {
    expect(read({ type: "huddle.connected", kind: "audio", sessionId: "theirs" })).toEqual({ type: "huddle.connected", kind: "audio" });
    expect(read({ type: "huddle.connected", kind: "video" })).toEqual({ type: "huddle.connected", kind: "video" });
    expect(read({ type: "huddle.connected", kind: "screen" })).toEqual({ type: "huddle.connected", kind: "screen" });
    expect(read({ type: "huddle.unpublish", kind: "video" })).toEqual({ type: "huddle.unpublish", kind: "video" });
    expect(read({ type: "huddle.unpublish", kind: "screen" })).toEqual({ type: "huddle.unpublish", kind: "screen" });
    expect(read({ type: "huddle.listen", kind: "audio" })).toEqual({ type: "huddle.listen", kind: "audio" });
    expect(read({ type: "huddle.listen", kind: "audio", fresh: true })).toEqual({ type: "huddle.listen", kind: "audio", fresh: true });
    expect(read({ type: "huddle.answer", kind: "video", sdp: SDP })).toEqual({ type: "huddle.answer", kind: "video", sdp: SDP });
    expect(read({ type: "huddle.answer", kind: "screen", sdp: SDP })).toEqual({ type: "huddle.answer", kind: "screen", sdp: SDP });
    expect(read({ type: "huddle.mute", muted: true })).toEqual({ type: "huddle.mute", muted: true });
    expect(read({ type: "huddle.mute", muted: false })).toEqual({ type: "huddle.mute", muted: false });
    expect(read({ type: "ping", at: 1 })).toEqual({ type: "ping" });
  });

  it("takes a frame that names no pair, as a tab from before there were cameras sends them, to be about the voices'", () => {
    expect(read({ type: "huddle.connected" })).toEqual({ type: "huddle.connected", kind: "audio" });
    expect(read({ type: "huddle.listen" })).toEqual({ type: "huddle.listen", kind: "audio" });
    expect(read({ type: "huddle.listen", fresh: true })).toEqual({ type: "huddle.listen", kind: "audio", fresh: true });
    expect(read({ type: "huddle.answer", sdp: SDP })).toEqual({ type: "huddle.answer", kind: "audio", sdp: SDP });
  });

  it("reads whose cameras a tab asks to see, which is nobody's unless it names them", () => {
    expect(read({ type: "huddle.listen", kind: "video", fresh: true, watch: ["ada", "grace"] })).toEqual({ type: "huddle.listen", kind: "video", fresh: true, watch: ["ada", "grace"] });
    expect(read({ type: "huddle.listen", kind: "video" })).toEqual({ type: "huddle.listen", kind: "video", watch: [] });
    expect(read({ type: "huddle.listen", kind: "video", watch: [] })).toEqual({ type: "huddle.listen", kind: "video", watch: [] });
    // Voices aren't asked for by name: a tab hears everyone.
    expect(read({ type: "huddle.listen", kind: "audio", watch: ["ada"] })).toEqual({ type: "huddle.listen", kind: "audio" });
    const everyCamera = Array.from({ length: MAX_HUDDLE_CAMERAS }, (_, index) => `user-${index}`);
    expect(read({ type: "huddle.listen", kind: "video", watch: everyCamera })).toEqual({ type: "huddle.listen", kind: "video", watch: everyCamera });
    for (const watch of ["ada", [7], [""], [null], ["ada", "ada"], ["u".repeat(MAX_ID_LENGTH + 1)], [...everyCamera, "one-more"]]) {
      expect(read({ type: "huddle.listen", kind: "video", watch }), JSON.stringify(watch).slice(0, 40)).toBeNull();
    }
  });

  it("reads whose screens a tab asks to see, as many as a huddle shows, which is nobody's unless it names them", () => {
    expect(read({ type: "huddle.listen", kind: "screen", fresh: true, watch: ["ada", "grace"] })).toEqual({ type: "huddle.listen", kind: "screen", fresh: true, watch: ["ada", "grace"] });
    expect(read({ type: "huddle.listen", kind: "screen" })).toEqual({ type: "huddle.listen", kind: "screen", watch: [] });
    for (const watch of ["ada", [7], ["ada", "ada"], ["ada", "grace", "linus"]]) {
      expect(read({ type: "huddle.listen", kind: "screen", watch }), JSON.stringify(watch)).toBeNull();
    }
  });

  it("refuses anything else", () => {
    for (const frame of [
      { type: "huddle.listen", fresh: false },
      { type: "huddle.listen", fresh: "yes" },
      { type: "huddle.listen", kind: "slides" },
      { type: "huddle.connected", kind: "slides" },
      { type: "huddle.connected", kind: null },
      { type: "huddle.unpublish", kind: 7 },
      { type: "huddle.answer" },
      { type: "huddle.answer", sdp: "" },
      { type: "huddle.answer", kind: "both", sdp: SDP },
      { type: "huddle.mute" },
      { type: "huddle.mute", muted: "true" },
      { type: "huddle.leave" },
      { type: "huddle.welcome" },
      { type: "message.create", clientMessageId: "1", body: "<p>hi</p>" },
      {},
      null,
      [],
      "huddle.listen",
      7,
    ]) {
      expect(read(frame), JSON.stringify(frame)).toBeNull();
    }
    expect(parseHuddleClientFrame("{")).toBeNull();
    expect(parseHuddleClientFrame("")).toBeNull();
  });

  it("says in the socket's address whether its person joins muted", () => {
    const read = (params: Record<string, string>) => parseHuddleSocketParams({ get: (name) => params[name] ?? null });
    expect(huddleSocketQuery({ muted: false })).toBe("");
    expect(huddleSocketQuery({ muted: true })).toBe("?muted=1");
    expect(read({ muted: "1" })).toEqual({ muted: true });
    // A tab that doesn't say, or says something else, joins unmuted.
    const unmuted: Array<Record<string, string>> = [{}, { muted: "0" }, { muted: "true" }, { muted: "" }];
    for (const params of unmuted) expect(read(params), JSON.stringify(params)).toEqual({ muted: false });
  });

  it("closes a socket with codes of its own, none of them a room's", () => {
    expect(HuddleCloseCode).toEqual({ Full: 4005, Off: 4006, Moved: 4007 });
    expect(Object.values(CloseCode).filter((code) => (Object.values(HuddleCloseCode) as number[]).includes(code))).toEqual([]);
    expect(MAX_HUDDLE_PEOPLE).toBe(50);
    expect(MAX_HUDDLE_CAMERAS).toBe(25);
    expect(MAX_HUDDLE_SCREENS).toBe(2);
  });
});
