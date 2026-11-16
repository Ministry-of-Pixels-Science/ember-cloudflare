import type { User } from "@ember/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showHuddle, type JoinedHuddle } from "@/lib/huddle-store";
import { CameraMenu, MicrophoneMenu } from "./huddle-device-menu";

const ada: User = { id: "ada", name: "Ada Lovelace" };
const huddle = (changes: Partial<JoinedHuddle> = {}): JoinedHuddle => ({
  roomId: "general",
  connected: true,
  you: ada,
  people: [{ user: ada, muted: false, audio: true, video: false, screen: false }],
  muted: false,
  microphone: true,
  microphoneId: "mic-1",
  speakerId: "",
  camera: null,
  watched: new Map(),
  screen: null,
  screens: new Map(),
  open: true,
  ...changes,
});
/** The stream of the camera `deviceId`, as much of one as the menu reads. */
const cameraFrom = (deviceId: string, label = "") => ({ getVideoTracks: () => [{ label, getSettings: () => ({ deviceId }) }] }) as unknown as MediaStream;

const device = (kind: MediaDeviceKind, deviceId: string, label = deviceId) => ({ kind, deviceId, label, groupId: "" }) as MediaDeviceInfo;
const MICROPHONES = [device("audioinput", "mic-1", "Built-in Microphone"), device("audioinput", "mic-2", "USB Microphone")];
const SPEAKERS = [device("audiooutput", "speaker-1", "Built-in Speakers"), device("audiooutput", "speaker-2", "Headphones")];
const CAMERAS = [device("videoinput", "camera-1", "FaceTime HD Camera"), device("videoinput", "camera-2", "USB Camera")];

/**
 * Has the browser list `devices`, and be one that can play through a speaker it's told unless
 * `choosesSpeaker` says not, as Safari can't. Answers what has it list others, as plugging one in or
 * unplugging one does.
 */
function browserLists(devices: MediaDeviceInfo[], choosesSpeaker = true) {
  const enumerateDevices = vi.fn(async () => devices);
  const media = Object.assign(new EventTarget(), { enumerateDevices });
  Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
  if (choosesSpeaker) Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { value: vi.fn(), configurable: true });
  return async (now: MediaDeviceInfo[]) => {
    enumerateDevices.mockResolvedValue(now);
    await act(async () => void media.dispatchEvent(new Event("devicechange")));
  };
}

/** One of a huddle's two menus, shut, with what the huddle's controls were asked. */
function renderMenu(Menu: typeof MicrophoneMenu, joined: JoinedHuddle = huddle()) {
  const controls = { leave: vi.fn(), setMuted: vi.fn(), setCamera: vi.fn(), setScreen: vi.fn(), setOpen: vi.fn(), setDevice: vi.fn(), setSmall: vi.fn() };
  act(() => showHuddle(joined, controls));
  const user = userEvent.setup();
  const view = render(<Menu huddle={joined} className="" />);
  return { ...controls, user, ...view };
}

/** The menu's arrow, which nothing but the menu can be reached past while that's open. */
const arrow = (name: string) => screen.getByRole("button", { name, hidden: true });
const menu = () => screen.findByRole("menu");
const choicesOf = (heading: string) => within(screen.getByRole("group", { name: heading })).getAllByRole("menuitemradio");
/** What a menu's choices are called, and which of them is ticked. */
const named = (choices: HTMLElement[]) => choices.map((choice) => choice.textContent);
const ticked = (choices: HTMLElement[]) => named(choices.filter((choice) => choice.getAttribute("aria-checked") === "true"));

afterEach(() => {
  act(() => showHuddle(null));
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
});

describe("The menu beside a huddle's microphone", () => {
  it("lists the browser's microphones and its speakers, each under what they are, with the huddle's own ticked", async () => {
    browserLists([...MICROPHONES, ...SPEAKERS, ...CAMERAS]);
    const { user } = renderMenu(MicrophoneMenu);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(arrow("Microphone and speaker"));
    expect(await menu()).toHaveAccessibleName("Microphone and speaker");
    expect(named(choicesOf("Microphone"))).toEqual(["Built-in Microphone", "USB Microphone"]);
    expect(ticked(choicesOf("Microphone"))).toEqual(["Built-in Microphone"]);
    // The system's speaker is the first to choose, where the browser doesn't list its own choice.
    expect(named(choicesOf("Speaker"))).toEqual(["System default", "Built-in Speakers", "Headphones"]);
    expect(ticked(choicesOf("Speaker"))).toEqual(["System default"]);
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(5);
  });

  it("has the huddle speak through the microphone chosen, and play through the speaker chosen, and shuts", async () => {
    browserLists([...MICROPHONES, ...SPEAKERS]);
    const { setDevice, user } = renderMenu(MicrophoneMenu);
    await user.click(arrow("Microphone and speaker"));
    await user.click(await screen.findByRole("menuitemradio", { name: "USB Microphone" }));
    expect(setDevice.mock.calls).toEqual([["microphone", "mic-2"]]);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    await user.click(arrow("Microphone and speaker"));
    await user.click(await screen.findByRole("menuitemradio", { name: "Headphones" }));
    expect(setDevice.mock.calls).toEqual([
      ["microphone", "mic-2"],
      ["speaker", "speaker-2"],
    ]);
    // The system's, which has no id to give.
    await user.click(arrow("Microphone and speaker"));
    await user.click(await screen.findByRole("menuitemradio", { name: "System default" }));
    expect(setDevice.mock.calls.at(-1)).toEqual(["speaker", ""]);
  });

  it("opens once the browser has listed its devices, with the first of them under the keys", async () => {
    let list = (_devices: MediaDeviceInfo[]) => {};
    const listed = new Promise<MediaDeviceInfo[]>((resolve) => (list = resolve));
    Object.defineProperty(navigator, "mediaDevices", { value: Object.assign(new EventTarget(), { enumerateDevices: () => listed }), configurable: true });
    const { user } = renderMenu(MicrophoneMenu);

    arrow("Microphone and speaker").focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await act(async () => list(MICROPHONES));
    await menu();
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "Built-in Microphone" })).toHaveFocus());
  });

  it("has no speakers to choose among in a browser that can't play through one it's told, as Safari", async () => {
    browserLists([...MICROPHONES, ...SPEAKERS], false);
    const { user } = renderMenu(MicrophoneMenu);
    await user.click(arrow("Microphone and speaker"));
    await menu();
    expect(named(choicesOf("Microphone"))).toEqual(["Built-in Microphone", "USB Microphone"]);
    expect(screen.queryByRole("group", { name: "Speaker" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("ticks the speaker the huddle plays through, and the first once that one has been unplugged, which is the browser's own choice where it lists one", async () => {
    const lists = browserLists([device("audiooutput", "default", "Default - Built-in Speakers"), ...SPEAKERS]);
    const { user } = renderMenu(MicrophoneMenu, huddle({ speakerId: "speaker-2" }));
    await user.click(arrow("Microphone and speaker"));
    await menu();
    expect(named(choicesOf("Speaker"))).toEqual(["Default - Built-in Speakers", "Built-in Speakers", "Headphones"]);
    expect(ticked(choicesOf("Speaker"))).toEqual(["Headphones"]);

    await lists([device("audiooutput", "default", "Default - Built-in Speakers"), SPEAKERS[0]!]);
    expect(named(choicesOf("Speaker"))).toEqual(["Default - Built-in Speakers", "Built-in Speakers"]);
    expect(ticked(choicesOf("Speaker"))).toEqual(["Default - Built-in Speakers"]);
  });

  it("lists the devices again as one is plugged in or taken away while it's open, and not once it's shut", async () => {
    const lists = browserLists(MICROPHONES);
    const { user } = renderMenu(MicrophoneMenu);
    await user.click(arrow("Microphone and speaker"));
    await menu();

    await lists([...MICROPHONES, device("audioinput", "mic-3", "Headset")]);
    expect(named(choicesOf("Microphone"))).toEqual(["Built-in Microphone", "USB Microphone", "Headset"]);
    await lists([MICROPHONES[0]!]);
    expect(named(choicesOf("Microphone"))).toEqual(["Built-in Microphone"]);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    const asked = vi.mocked(navigator.mediaDevices.enumerateDevices).mock.calls.length;
    await lists(MICROPHONES);
    expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalledTimes(asked);
  });

  it("leads with the microphone the huddle has where the browser's list leaves it out, and names a device the browser doesn't by what it is and where it comes", async () => {
    browserLists([device("audioinput", "mic-1", ""), device("audioinput", "mic-2", "USB Microphone")]);
    const { user } = renderMenu(MicrophoneMenu, huddle({ microphoneId: "mic-9" }));
    await user.click(arrow("Microphone and speaker"));
    await menu();
    expect(named(choicesOf("Microphone"))).toEqual(["Microphone 1", "Microphone 2", "USB Microphone"]);
    expect(ticked(choicesOf("Microphone"))).toEqual(["Microphone 1"]);
  });

  it("lists the microphones for someone who only listens, none of them ticked, where the browser names them", async () => {
    browserLists(MICROPHONES);
    const { setDevice, user } = renderMenu(MicrophoneMenu, huddle({ muted: true, microphone: false, microphoneId: "" }));
    await user.click(arrow("Microphone and speaker"));
    await menu();
    expect(named(choicesOf("Microphone"))).toEqual(["Built-in Microphone", "USB Microphone"]);
    expect(ticked(choicesOf("Microphone"))).toEqual([]);
    await user.click(screen.getByRole("menuitemradio", { name: "Built-in Microphone" }));
    expect(setDevice.mock.calls).toEqual([["microphone", "mic-1"]]);
  });

  it("offers someone who only listens their microphone where the browser names none: the one this browser last chose, or the browser's own choice", async () => {
    // As a browser lists what it has before it lets the page use a microphone.
    browserLists([device("audioinput", "", ""), device("audiooutput", "", "")]);
    const { setDevice, user } = renderMenu(MicrophoneMenu, huddle({ muted: true, microphone: false, microphoneId: "" }));
    await user.click(arrow("Microphone and speaker"));
    await menu();
    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Speaker" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Use your microphone" }));
    expect(setDevice.mock.calls).toEqual([["microphone", ""]]);

    localStorage.setItem("ember:huddle-microphone", "mic-2");
    await user.click(arrow("Microphone and speaker"));
    await user.click(await screen.findByRole("menuitem", { name: "Use your microphone" }));
    expect(setDevice.mock.calls.at(-1)).toEqual(["microphone", "mic-2"]);
  });
});

describe("The menu beside a huddle's camera", () => {
  it("lists the browser's cameras, the one that's on ticked, and has the huddle show the one chosen", async () => {
    browserLists([...MICROPHONES, ...SPEAKERS, ...CAMERAS]);
    const { setDevice, user } = renderMenu(CameraMenu, huddle({ camera: cameraFrom("camera-1") }));
    await user.click(arrow("Camera"));
    expect(await menu()).toHaveAccessibleName("Camera");
    expect(named(choicesOf("Camera"))).toEqual(["FaceTime HD Camera", "USB Camera"]);
    expect(ticked(choicesOf("Camera"))).toEqual(["FaceTime HD Camera"]);
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);

    await user.click(screen.getByRole("menuitemradio", { name: "USB Camera" }));
    expect(setDevice.mock.calls).toEqual([["camera", "camera-2"]]);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("leads with the camera that's on where the browser's list leaves it out, by the name its picture comes with", async () => {
    browserLists(CAMERAS);
    const { user } = renderMenu(CameraMenu, huddle({ camera: cameraFrom("camera-9", "Continuity Camera") }));
    await user.click(arrow("Camera"));
    await menu();
    expect(named(choicesOf("Camera"))).toEqual(["Continuity Camera", "FaceTime HD Camera", "USB Camera"]);
    expect(ticked(choicesOf("Camera"))).toEqual(["Continuity Camera"]);
  });

  it("ticks none while the camera's off, when choosing one turns it on", async () => {
    browserLists(CAMERAS);
    const { setDevice, setCamera, user } = renderMenu(CameraMenu);
    await user.click(arrow("Camera"));
    await menu();
    expect(ticked(choicesOf("Camera"))).toEqual([]);
    await user.click(screen.getByRole("menuitemradio", { name: "USB Camera" }));
    expect(setDevice.mock.calls).toEqual([["camera", "camera-2"]]);
    expect(setCamera).not.toHaveBeenCalled();
  });

  it("has the camera to turn on where the browser names none, as it does until it lets the page use one", async () => {
    browserLists([device("videoinput", "", "")]);
    const { setDevice, setCamera, user } = renderMenu(CameraMenu);
    await user.click(arrow("Camera"));
    await menu();
    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Turn on camera" }));
    expect(setCamera.mock.calls).toEqual([[true]]);
    expect(setDevice).not.toHaveBeenCalled();
  });
});
