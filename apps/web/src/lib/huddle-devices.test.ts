import { afterEach, describe, expect, it, vi } from "vitest";
import { cameraOf, closeDevice, listDevices, listsSpeaker, microphoneOf, NO_DEVICES, openCamera, openMicrophone, openScreen, rememberDevice, rememberedDevice, sharesScreens, speakerChoices, watchDevices, withOpen } from "./huddle-devices";

/** A stream from the microphone `deviceId`, or with `kind` said, the camera, as much of one as the code reads. */
function streamFrom(deviceId: string, kind: "audio" | "video" = "audio") {
  const track = { stop: vi.fn(), getSettings: () => ({ deviceId }) };
  const of = (asked: string) => () => (asked === kind ? [track] : []);
  return { stream: { getAudioTracks: of("audio"), getVideoTracks: of("video"), getTracks: () => [track] } as unknown as MediaStream, track };
}

/** What the browser throws for a request it turns down, by its name. */
const refusal = (name: string) => Object.assign(new Error(name), { name });

const device = (kind: MediaDeviceKind, deviceId: string, label = deviceId) => ({ kind, deviceId, label, groupId: "" }) as MediaDeviceInfo;

/** Gives the page the browser's media devices, as much of them as the code asks. */
function withMedia(media: Partial<MediaDevices>) {
  vi.stubGlobal("navigator", { mediaDevices: media });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
});

describe("The devices a huddle remembers", () => {
  it("remembers a microphone, a speaker and a camera apart", () => {
    expect(rememberedDevice("microphone")).toBeNull();
    rememberDevice("microphone", "mic-2");
    rememberDevice("speaker", "speaker-1");
    rememberDevice("camera", "camera-1");
    expect(rememberedDevice("microphone")).toBe("mic-2");
    expect(rememberedDevice("speaker")).toBe("speaker-1");
    expect(rememberedDevice("camera")).toBe("camera-1");
  });

  it("forgets one once the browser's own choice is taken", () => {
    rememberDevice("speaker", "speaker-1");
    rememberDevice("speaker", "");
    expect(rememberedDevice("speaker")).toBeNull();
  });

  it("goes without when storage is refused", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("refused");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("refused");
    });
    expect(() => rememberDevice("microphone", "mic-2")).not.toThrow();
    expect(rememberedDevice("microphone")).toBeNull();
  });
});

describe("Opening a microphone", () => {
  it("opens the browser's own choice when none is asked for", async () => {
    const { stream } = streamFrom("mic-1");
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    withMedia({ getUserMedia });
    expect(await openMicrophone(null)).toBe(stream);
    expect(getUserMedia.mock.calls).toEqual([[{ audio: true }]]);
  });

  it("opens the one asked for", async () => {
    const { stream } = streamFrom("mic-2");
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    withMedia({ getUserMedia });
    expect(await openMicrophone("mic-2")).toBe(stream);
    expect(getUserMedia.mock.calls).toEqual([[{ audio: { deviceId: { exact: "mic-2" } } }]]);
  });

  it.each(["OverconstrainedError", "NotFoundError"])("opens the browser's own choice when the one asked for is gone (%s)", async (name) => {
    const { stream } = streamFrom("mic-1");
    const getUserMedia = vi.fn().mockRejectedValueOnce(refusal(name)).mockResolvedValue(stream);
    withMedia({ getUserMedia });
    expect(await openMicrophone("mic-2")).toBe(stream);
    expect(getUserMedia.mock.calls).toEqual([[{ audio: { deviceId: { exact: "mic-2" } } }], [{ audio: true }]]);
  });

  it("takes a browser's word that the one asked for is gone when what it throws isn't an Error", async () => {
    const { stream } = streamFrom("mic-1");
    const getUserMedia = vi.fn().mockRejectedValueOnce({ name: "OverconstrainedError", constraint: "deviceId" }).mockResolvedValue(stream);
    withMedia({ getUserMedia });
    expect(await openMicrophone("mic-2")).toBe(stream);
  });

  it("doesn't ask twice of someone who refuses", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(refusal("NotAllowedError"));
    withMedia({ getUserMedia });
    expect(await openMicrophone("mic-2")).toBeNull();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("has none when there's no microphone at all", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(refusal("NotFoundError"));
    withMedia({ getUserMedia });
    expect(await openMicrophone("mic-2")).toBeNull();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(await openMicrophone(null)).toBeNull();
    expect(getUserMedia).toHaveBeenCalledTimes(3);
  });

  it("has none on a page the browser gives no microphone", async () => {
    vi.stubGlobal("navigator", {});
    expect(await openMicrophone(null)).toBeNull();
  });

  it("says which device a stream is from, and stops it", () => {
    const { stream, track } = streamFrom("mic-2");
    expect(microphoneOf(stream)).toBe("mic-2");
    expect(microphoneOf(null)).toBe("");
    closeDevice(stream);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(() => closeDevice(null)).not.toThrow();
  });
});

describe("Opening a camera", () => {
  /** A picture the size of a tile, which is all a huddle asks of a camera. */
  const TILE = { width: { ideal: 640 }, height: { ideal: 360 } };

  it("opens the browser's own choice when none is asked for, and the one asked for when one is", async () => {
    const { stream } = streamFrom("camera-1", "video");
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    withMedia({ getUserMedia });
    expect(await openCamera(null)).toBe(stream);
    expect(await openCamera("camera-2")).toBe(stream);
    expect(getUserMedia.mock.calls).toEqual([[{ video: TILE }], [{ video: { ...TILE, deviceId: { exact: "camera-2" } } }]]);
  });

  it("opens the browser's own choice when the one asked for is gone", async () => {
    const { stream } = streamFrom("camera-1", "video");
    const getUserMedia = vi.fn().mockRejectedValueOnce(refusal("OverconstrainedError")).mockResolvedValue(stream);
    withMedia({ getUserMedia });
    expect(await openCamera("camera-2")).toBe(stream);
    expect(getUserMedia.mock.calls).toEqual([[{ video: { ...TILE, deviceId: { exact: "camera-2" } } }], [{ video: TILE }]]);
  });

  it("has none when its person refuses, without asking twice, nor on a page the browser gives no camera", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(refusal("NotAllowedError"));
    withMedia({ getUserMedia });
    expect(await openCamera("camera-2")).toBeNull();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    vi.stubGlobal("navigator", {});
    expect(await openCamera(null)).toBeNull();
  });

  it("says which device a stream is from, and stops it, which puts its light out", () => {
    const { stream, track } = streamFrom("camera-2", "video");
    expect(cameraOf(stream)).toBe("camera-2");
    expect(cameraOf(null)).toBe("");
    // A microphone's stream is from no camera.
    expect(cameraOf(streamFrom("mic-1").stream)).toBe("");
    closeDevice(stream);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});

describe("Sharing a screen", () => {
  /** What the browser throws for a request it turns down, by its name and what it says of it. */
  const turnedDown = (name: string, message: string) => new DOMException(message, name);

  it("opens what its person chooses, no larger than 1080p nor faster than 15 pictures a second, without sound, and has the browser keep its text sharp", async () => {
    const track = { stop: vi.fn(), contentHint: "" };
    const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    const getDisplayMedia = vi.fn().mockResolvedValue(stream);
    withMedia({ getDisplayMedia });
    expect(await openScreen()).toBe(stream);
    expect(getDisplayMedia.mock.calls).toEqual([[{ video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 15 } }, audio: false }]]);
    expect(track.contentHint).toBe("detail");
    closeDevice(stream);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("has none when its person chooses nothing", async () => {
    withMedia({ getDisplayMedia: vi.fn().mockRejectedValue(turnedDown("NotAllowedError", "Permission denied")) });
    expect(await openScreen()).toBeNull();
  });

  it.each([
    ["the browser couldn't start sharing what they chose", turnedDown("NotReadableError", "Could not start video source")],
    ["their computer keeps the browser from recording the screen, as Chrome says it", turnedDown("NotAllowedError", "Permission denied by system")],
    ["the browser fails with something that isn't an Error", "no"],
  ])("fails when %s", async (_, failure) => {
    withMedia({ getDisplayMedia: vi.fn().mockRejectedValue(failure) });
    await expect(openScreen()).rejects.toBe(failure);
  });

  it("fails in a browser that can't share a screen, as a phone's can't, which it says of itself", async () => {
    withMedia({ getDisplayMedia: vi.fn() });
    expect(sharesScreens()).toBe(true);
    withMedia({});
    expect(sharesScreens()).toBe(false);
    await expect(openScreen()).rejects.toBeInstanceOf(TypeError);
    vi.stubGlobal("navigator", {});
    expect(sharesScreens()).toBe(false);
    await expect(openScreen()).rejects.toBeInstanceOf(TypeError);
  });
});

describe("Listing a huddle's devices", () => {
  const DEVICES = [
    device("audioinput", "mic-1", "Built-in Microphone"),
    device("audioinput", "mic-2", "USB Microphone"),
    device("audiooutput", "speaker-1", "Built-in Speakers"),
    device("videoinput", "camera-1", "FaceTime HD Camera"),
  ];

  it("lists the microphones and the cameras, and no speakers where the browser can't play through one it's told", async () => {
    withMedia({ enumerateDevices: vi.fn().mockResolvedValue(DEVICES) });
    const { microphones, speakers, cameras } = await listDevices();
    expect(microphones.map(({ label }) => label)).toEqual(["Built-in Microphone", "USB Microphone"]);
    expect(cameras.map(({ label }) => label)).toEqual(["FaceTime HD Camera"]);
    expect(speakers).toEqual([]);
  });

  it("lists the speakers where it can", async () => {
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { value: vi.fn(), configurable: true });
    withMedia({ enumerateDevices: vi.fn().mockResolvedValue(DEVICES) });
    expect((await listDevices()).speakers.map(({ label }) => label)).toEqual(["Built-in Speakers"]);
  });

  it("leaves out the devices a browser lists without an id, as it does before a microphone is allowed", async () => {
    withMedia({ enumerateDevices: vi.fn().mockResolvedValue([device("audioinput", "", ""), device("audiooutput", "", ""), device("videoinput", "", "")]) });
    expect(await listDevices()).toEqual(NO_DEVICES);
  });

  it("lists none when the browser can't say", async () => {
    withMedia({ enumerateDevices: vi.fn().mockRejectedValue(new Error("refused")) });
    expect(await listDevices()).toEqual(NO_DEVICES);
    vi.stubGlobal("navigator", {});
    expect(await listDevices()).toEqual(NO_DEVICES);
  });

  it("says whether a speaker is still listed, and counts one the browser can't say of as there", async () => {
    withMedia({ enumerateDevices: vi.fn().mockResolvedValue(DEVICES) });
    expect(await listsSpeaker("speaker-1")).toBe(true);
    expect(await listsSpeaker("speaker-2")).toBe(false);
    // A microphone of that id isn't a speaker.
    expect(await listsSpeaker("mic-1")).toBe(false);
    withMedia({ enumerateDevices: vi.fn().mockRejectedValue(new Error("refused")) });
    expect(await listsSpeaker("speaker-2")).toBe(true);
    vi.stubGlobal("navigator", {});
    expect(await listsSpeaker("speaker-2")).toBe(true);
  });

  it("hears of devices plugged in and taken away until it's told to stop", () => {
    const media = new EventTarget();
    withMedia(media as MediaDevices);
    const changed = vi.fn();
    const stop = watchDevices(changed);
    media.dispatchEvent(new Event("devicechange"));
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
    media.dispatchEvent(new Event("devicechange"));
    expect(changed).toHaveBeenCalledTimes(1);
    vi.stubGlobal("navigator", {});
    expect(() => watchDevices(changed)()).not.toThrow();
  });
});

describe("The devices to choose among", () => {
  const MICROPHONES = [device("audioinput", "mic-1", "Built-in Microphone"), device("audioinput", "mic-2", "USB Microphone")];
  const SPEAKERS = [device("audiooutput", "speaker-1", "Built-in Speakers")];

  it("are those the browser lists, led by the one that's open where its list leaves that out, by the name its track comes with", () => {
    expect(withOpen(MICROPHONES, "mic-2")).toBe(MICROPHONES);
    expect(withOpen(MICROPHONES, "mic-3")).toEqual([{ deviceId: "mic-3", label: "" }, ...MICROPHONES]);
    expect(withOpen([], "", { label: "Headset" } as MediaStreamTrack)).toEqual([{ deviceId: "", label: "Headset" }]);
  });

  it("are led, for speakers, by the system's where the browser doesn't list its own choice", () => {
    expect(speakerChoices(SPEAKERS)).toEqual([{ deviceId: "", label: "System default" }, ...SPEAKERS]);
    expect(speakerChoices([])).toEqual([{ deviceId: "", label: "System default" }]);
    const withOwnChoice = [device("audiooutput", "default", "Default - Built-in Speakers"), ...SPEAKERS];
    expect(speakerChoices(withOwnChoice)).toBe(withOwnChoice);
  });
});
