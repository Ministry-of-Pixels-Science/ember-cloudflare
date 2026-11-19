import { describe, expect, it } from "vitest";
import {
  ALL_HUDDLE_SOUNDS,
  APP_ID_REFUSED,
  APP_SECRET_REFUSED,
  appIdOf,
  appSecretOf,
  CAMERA_SIZES,
  carriesBothSizes,
  hearsAllHuddleSounds,
  HUDDLE_SOUNDS,
  HUDDLE_SOUNDS_REFUSED,
  HUDDLE_STICKERS,
  HuddleCloseCode,
  huddleSocketQuery,
  MAX_HUDDLE_CAMERAS,
  MAX_HUDDLE_INVITED,
  MAX_HUDDLE_PEOPLE,
  MAX_HUDDLE_SCREENS,
  MAX_REACTION_LENGTH,
  MAX_SDP_LENGTH,
  parseHuddleClientFrame,
  parseHuddleRelaySetup,
  parseHuddleSocketParams,
  parseHuddleSoundChanges,
  parseHuddlesSetup,
  RELAY_API_TOKEN_REFUSED,
  RELAY_KEY_ID_REFUSED,
  relayApiTokenOf,
  relayKeyIdOf,
} from "./huddles";
import { CloseCode, MAX_ID_LENGTH } from "./index";

const APP_ID = "2a95132c15732412d22c1476fa83f27a";
const APP_SECRET = "66bcf64aa8907b9f9d90ac17746a77ce394c393b92b3916633dc02846e608ad4";

/** A session description of `sections`, each a media section's lines after its first, as a browser writes one: a line to an end of `\r\n`. */
const described = (...sections: string[][]) => ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", ...sections.flatMap((lines) => ["m=video 9 UDP/TLS/RTP/SAVPF 96", ...lines])].join("\r\n") + "\r\n";

describe("A camera's sizes", () => {
  it("names the large one first, as the SFU goes down the alphabet from the one it can't send", () => {
    expect(CAMERA_SIZES).toEqual({ large: "a", small: "b" });
    expect(CAMERA_SIZES.large < CAMERA_SIZES.small).toBe(true);
  });

  it("finds that an offer sends a track in both sizes, as Chromium writes one, in whichever order", () => {
    const offer = described(["a=mid:0", "a=sendonly", "a=rid:b send", "a=rid:a send", "a=simulcast:send b;a"]);
    expect(carriesBothSizes(offer, "0", "send")).toBe(true);
    expect(carriesBothSizes(offer.replace("send b;a", "send a;b"), "0", "send")).toBe(true);
    // A description whose lines end as a file's do, and one a size of which starts paused.
    expect(carriesBothSizes(offer.replaceAll("\r\n", "\n"), "0", "send")).toBe(true);
    expect(carriesBothSizes(offer.replace("send b;a", "send b;~a"), "0", "send")).toBe(true);
  });

  it("finds that an answer takes both, which it says the other way about", () => {
    const answer = described(["a=mid:0", "a=recvonly", "a=rid:b recv", "a=rid:a recv", "a=simulcast:recv b;a"]);
    expect(carriesBothSizes(answer, "0", "recv")).toBe(true);
    expect(carriesBothSizes(answer, "0", "send")).toBe(false);
    expect(carriesBothSizes(described(["a=mid:0", "a=simulcast:send x;y recv a;b"]), "0", "recv")).toBe(true);
    expect(carriesBothSizes(described(["a=mid:0", "a=simulcast:recv a;b send x;y"]), "0", "recv")).toBe(true);
  });

  it("finds one size, other sizes, or more of them, not to be both", () => {
    const sending = (simulcast: string[]) => carriesBothSizes(described(["a=mid:0", "a=sendonly", ...simulcast]), "0", "send");
    expect(sending([])).toBe(false);
    for (const sizes of ["a", "b", "a;a", "f;h", "a;b;c", "f;a;b", "a,b", "a,c;b", "A;B", "", ";", "a;"]) expect(sending([`a=simulcast:send ${sizes}`]), sizes).toBe(false);
    // Each size has a line of its own, which says nothing of both being sent at once.
    expect(sending(["a=rid:b send", "a=rid:a send"])).toBe(false);
    expect(sending(["a=simulcast:send"])).toBe(false);
    expect(sending(["a=simulcast:recv b;a"])).toBe(false);
  });

  it("goes by the media section that carries the track", () => {
    const both = ["a=sendonly", "a=simulcast:send b;a"];
    const offer = described(["a=mid:0", "a=sendonly"], ["a=mid:1", ...both], ["a=mid:10", "a=sendonly"]);
    expect(carriesBothSizes(offer, "1", "send")).toBe(true);
    for (const mid of ["0", "10", "2", "", "1\r\na=simulcast:send b;a"]) expect(carriesBothSizes(offer, mid, "send"), mid).toBe(false);
    // Said before any media section, it's said of none of them.
    expect(carriesBothSizes(["v=0", "a=mid:0", "a=simulcast:send b;a", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:0"].join("\r\n"), "0", "send")).toBe(false);
    expect(carriesBothSizes("", "0", "send")).toBe(false);
  });
});

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

describe("Set up the relay", () => {
  // A TURN key's ID and its API token are as long as an SFU app's ID and its secret.
  const [KEY_ID, API_TOKEN] = [APP_ID, APP_SECRET];

  it("takes a TURN key's ID and its API token, without the spaces around them", () => {
    expect(parseHuddleRelaySetup({ keyId: ` ${KEY_ID}\n`, apiToken: `\t${API_TOKEN} ` })).toEqual({ keyId: KEY_ID, apiToken: API_TOKEN });
    expect(relayKeyIdOf(KEY_ID.toUpperCase())).toBe(KEY_ID.toUpperCase());
    // Cloudflare says which keys are its own, so one of another length than its keys have today is asked about.
    expect(relayKeyIdOf("abc123")).toBe("abc123");
    expect(relayApiTokenOf("Abc-123_x.y~z+/w==")).toBe("Abc-123_x.y~z+/w==");
  });

  it("refuses an ID that can't go into the address Cloudflare is asked at, on its field", () => {
    const refused = { error: RELAY_KEY_ID_REFUSED, field: "keyId" };
    for (const keyId of ["", "   ", `${KEY_ID}/credentials`, `${KEY_ID}?ttl=1`, "../apps", `${KEY_ID.slice(0, 31)}é`, `${KEY_ID} ${KEY_ID}`, "a".repeat(65), 42, null, undefined]) {
      expect(parseHuddleRelaySetup({ keyId, apiToken: API_TOKEN }), JSON.stringify(keyId)).toEqual(refused);
    }
  });

  it("refuses an API token no request could carry, on its field", () => {
    const refused = { error: RELAY_API_TOKEN_REFUSED, field: "apiToken" };
    for (const apiToken of ["", "   ", `${API_TOKEN.slice(0, 32)} ${API_TOKEN.slice(33)}`, `${API_TOKEN}\r\nX-Other: 1`, `${API_TOKEN}é`, "=", "a=b", "a".repeat(257), 42, null, undefined]) {
      expect(parseHuddleRelaySetup({ keyId: KEY_ID, apiToken }), JSON.stringify(apiToken)).toEqual(refused);
    }
    // Nor anything but an object.
    for (const given of [null, undefined, "keys", [KEY_ID, API_TOKEN]]) expect(parseHuddleRelaySetup(given)).toEqual({ error: RELAY_KEY_ID_REFUSED, field: "keyId" });
  });
});

describe("A huddle's sounds, which each person turns on or off", () => {
  it("are its music, its chimes and an invitation's ring, all of which everyone hears until they turn one off", () => {
    expect(HUDDLE_SOUNDS).toEqual(["music", "chimes", "ring"]);
    expect(ALL_HUDDLE_SOUNDS).toEqual({ music: true, chimes: true, ring: true });
    expect(hearsAllHuddleSounds(ALL_HUDDLE_SOUNDS)).toBe(true);
    for (const sound of HUDDLE_SOUNDS) expect(hearsAllHuddleSounds({ ...ALL_HUDDLE_SOUNDS, [sound]: false }), sound).toBe(false);
  });

  it("reads a change to them: each sound it turns on or off, and no others", () => {
    expect(parseHuddleSoundChanges({ music: false })).toEqual({ music: false });
    expect(parseHuddleSoundChanges({ ring: true, chimes: false })).toEqual({ chimes: false, ring: true });
    expect(parseHuddleSoundChanges({ music: true, chimes: true, ring: true })).toEqual(ALL_HUDDLE_SOUNDS);
    // Nothing to change changes nothing, and what isn't one of the sounds is passed over.
    expect(parseHuddleSoundChanges({})).toEqual({});
    expect(parseHuddleSoundChanges({ volume: 11, ring: false, music: undefined })).toEqual({ ring: false });
  });

  it("refuses a sound turned neither on nor off, and anything but an object", () => {
    for (const on of ["off", "true", 0, 1, null, [], {}]) {
      for (const sound of HUDDLE_SOUNDS) expect(parseHuddleSoundChanges({ [sound]: on }), `${sound}: ${JSON.stringify(on)}`).toBe(HUDDLE_SOUNDS_REFUSED);
    }
    expect(parseHuddleSoundChanges({ music: false, ring: "no" })).toBe(HUDDLE_SOUNDS_REFUSED);
    for (const data of [null, undefined, "music", 7, true, [], [{ music: false }]]) expect(parseHuddleSoundChanges(data), JSON.stringify(data)).toBe("Expected a JSON object");
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

  it("reads that a tab shows cameras small, which it says only of cameras, and only when it does", () => {
    expect(read({ type: "huddle.listen", kind: "video", watch: ["ada"], small: true })).toEqual({ type: "huddle.listen", kind: "video", watch: ["ada"], small: true });
    expect(read({ type: "huddle.listen", kind: "video", fresh: true, watch: ["ada"], small: true })).toEqual({ type: "huddle.listen", kind: "video", fresh: true, watch: ["ada"], small: true });
    expect(read({ type: "huddle.listen", kind: "video", watch: ["ada"] })).toEqual({ type: "huddle.listen", kind: "video", watch: ["ada"] });
    // Neither voices nor screens come in sizes.
    expect(read({ type: "huddle.listen", kind: "audio", small: true })).toEqual({ type: "huddle.listen", kind: "audio" });
    expect(read({ type: "huddle.listen", kind: "screen", watch: ["ada"], small: true })).toEqual({ type: "huddle.listen", kind: "screen", watch: ["ada"] });
    for (const small of [false, "true", 1, null, "b"]) expect(read({ type: "huddle.listen", kind: "video", watch: ["ada"], small }), JSON.stringify(small)).toBeNull();
  });

  it("reads whose screens a tab asks to see, as many as a huddle shows, which is nobody's unless it names them", () => {
    expect(read({ type: "huddle.listen", kind: "screen", fresh: true, watch: ["ada", "grace"] })).toEqual({ type: "huddle.listen", kind: "screen", fresh: true, watch: ["ada", "grace"] });
    expect(read({ type: "huddle.listen", kind: "screen" })).toEqual({ type: "huddle.listen", kind: "screen", watch: [] });
    for (const watch of ["ada", [7], ["ada", "ada"], ["ada", "grace", "linus"]]) {
      expect(read({ type: "huddle.listen", kind: "screen", watch }), JSON.stringify(watch)).toBeNull();
    }
  });

  it("reads who a tab invites into the huddle, as many as one takes, each named once", () => {
    expect(read({ type: "huddle.invite", userIds: ["grace"] })).toEqual({ type: "huddle.invite", userIds: ["grace"] });
    expect(read({ type: "huddle.invite", userIds: ["grace", "linus"], roomId: "another" })).toEqual({ type: "huddle.invite", userIds: ["grace", "linus"] });
    const everyone = Array.from({ length: MAX_HUDDLE_INVITED }, (_, index) => `user-${index}`);
    expect(MAX_HUDDLE_INVITED).toBe(MAX_HUDDLE_PEOPLE);
    expect(read({ type: "huddle.invite", userIds: everyone })).toEqual({ type: "huddle.invite", userIds: everyone });
    // Nobody is no invitation, and neither is anything but people's ids.
    for (const userIds of [undefined, [], "grace", [7], [""], [null], ["grace", "grace"], ["u".repeat(MAX_ID_LENGTH + 1)], [...everyone, "one-more"]]) {
      expect(read({ type: "huddle.invite", userIds }), JSON.stringify(userIds)?.slice(0, 40)).toBeNull();
    }
  });

  it("reads the sticker a tab's person shows, one of the five there are, or that they've taken theirs off", () => {
    expect(HUDDLE_STICKERS).toEqual(["hand", "brb", "thumbs-up", "thumbs-down", "done"]);
    for (const sticker of HUDDLE_STICKERS) expect(read({ type: "huddle.sticker", sticker })).toEqual({ type: "huddle.sticker", sticker });
    expect(read({ type: "huddle.sticker", sticker: null })).toEqual({ type: "huddle.sticker", sticker: null });
    expect(read({ type: "huddle.sticker", sticker: "hand", userId: "grace" })).toEqual({ type: "huddle.sticker", sticker: "hand" });
    // Nothing said isn't taking one off, and a sticker goes by its name here, not by its emoji.
    for (const sticker of [undefined, "", "wave", "Hand", "\u270B", 7, true, ["hand"], { sticker: "hand" }]) {
      expect(read({ type: "huddle.sticker", sticker }), JSON.stringify(sticker)).toBeNull();
    }
  });

  it("reads the emoji a tab's person reacts with, which is one emoji and nothing else", () => {
    const [joiner, picture] = ["\u200D", "\uFE0F"];
    const emoji = [
      "\u{1F389}",
      // With a skin tone, and a skin tone by itself, as a picker lists them.
      "\u{1F44D}\u{1F3FD}",
      "\u{1F3FD}",
      // A flag, a letter of one, and the flag of part of a country.
      "\u{1F1E8}\u{1F1E6}",
      "\u{1F1E6}",
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
      // A keycap, and a heart shown as a picture.
      `#${picture}\u20E3`,
      `\u2764${picture}`,
      // Several joined into one: a family, a flag, and the longest there is, two people kissing, each with a skin tone.
      ["\u{1F468}", "\u{1F469}", "\u{1F467}", "\u{1F466}"].join(joiner),
      `\u{1F3F3}${picture}${joiner}\u{1F308}`,
      ["\u{1F9D1}\u{1F3FB}", `\u2764${picture}`, "\u{1F48B}", "\u{1F9D1}\u{1F3FC}"].join(joiner),
    ];
    for (const one of emoji) expect(read({ type: "huddle.react", emoji: one }), one).toEqual({ type: "huddle.react", emoji: one });
    expect(Math.max(...emoji.map((one) => one.length))).toBe(MAX_REACTION_LENGTH - 1);
    expect(read({ type: "huddle.react", emoji: "\u{1F389}", userId: "grace" })).toEqual({ type: "huddle.react", emoji: "\u{1F389}" });
    // Not words or markup, nor more than one emoji, one with anything around it, or the parts that join them.
    const others = [undefined, null, 7, ["\u{1F389}"], "", " ", "hi", "a", "1", "#", "<b>", "\u{1F389}\u{1F389}", "\u{1F389} ", " \u{1F389}", "\u{1F389}!", "x\u{1F389}", `\u{1F44D}${joiner}`, `${joiner}\u{1F44D}`, picture, "x\u20E3", "\u{1F1E8}\u{1F1E6}\u{1F1E8}\u{1F1E6}"];
    for (const text of others) expect(read({ type: "huddle.react", emoji: text }), JSON.stringify(text)).toBeNull();
    // Nor one emoji made longer than any is.
    expect(read({ type: "huddle.react", emoji: ["\u{1F468}", "\u{1F469}", "\u{1F467}", "\u{1F466}", "\u{1F476}", "\u{1F476}"].join(joiner) })).toBeNull();
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
      { type: "huddle.sticker" },
      { type: "huddle.react" },
      { type: "huddle.reacted", userId: "ada", emoji: "\u{1F389}" },
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
