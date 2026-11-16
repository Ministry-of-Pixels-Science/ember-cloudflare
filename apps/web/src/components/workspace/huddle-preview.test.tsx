import type { DirectoryUser, DirectRoom, LiveHuddle, Me, Room, SharedRoom } from "@ember/protocol";
import { CAMERAS_OFF, MAX_HUDDLE_INVITED } from "@ember/protocol/huddles";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { joinHuddle } from "@/lib/huddle";
import { NO_CAMERA } from "@/lib/huddle-devices";
import { showHuddle } from "@/lib/huddle-store";
import { ASKING_FOR_MICROPHONE, HuddlePreview, NO_MICROPHONE } from "./huddle-preview";

vi.mock("@/lib/huddle", () => ({ joinHuddle: vi.fn() }));

const general: SharedRoom = { id: "general", name: "general", kind: "open", icon: null };
const ada: Me = { id: "ada", name: "Ada Lovelace", administrator: false };
const person = (id: string, name: string): DirectoryUser => ({ id, name, bio: null, role: "member", status: "active", avatarUrl: `/users/${id}/avatar` });
/** A bot that posts the deploys, as the people directory lists it. */
const DEPLOYS: DirectoryUser = { ...person("deploys", "Deploys"), role: "bot" };
/** Someone who was deactivated, and is still in the direct messages they were in. */
const GRACE: DirectoryUser = { ...person("grace", "Grace Hopper"), status: "deactivated" };
const PEOPLE = new Map([person("sam", "Sam Rivera"), person("priya", "Priya Patel"), person("ada", "Ada Lovelace"), DEPLOYS, GRACE].map((listed) => [listed.id, listed]));
/** Ada's direct message with `others`, who are named here as they were when it started. */
const directWith = (...others: string[]): DirectRoom => ({ id: "direct-1", kind: "direct", members: ["ada", ...others].map((id) => ({ id, name: `Was ${id}` })), activeAt: "2026-11-10T09:00:00.000Z" });
const huddleOf = (...userIds: string[]): LiveHuddle => ({ startedAt: "2026-11-10T09:00:00.000Z", userIds });

/** A microphone's track, or a camera's, as much of one as the preview and the tests read. */
class FakeTrack extends EventTarget {
  stopped = false;
  /** Whether anything listens to it yet, as the preview does for its end, from an effect. */
  listenedTo = false;
  constructor(
    readonly deviceId: string,
    readonly label: string,
    /** Which way its camera faces, where the browser says, as a phone's does. */
    readonly facingMode?: string,
  ) {
    super();
  }
  stop() {
    this.stopped = true;
  }
  getSettings() {
    return { deviceId: this.deviceId, facingMode: this.facingMode };
  }
  addEventListener(...listener: Parameters<EventTarget["addEventListener"]>) {
    this.listenedTo = true;
    super.addEventListener(...listener);
  }
}

interface FakeStream {
  track: FakeTrack;
  getAudioTracks(): FakeTrack[];
  getVideoTracks(): FakeTrack[];
  getTracks(): FakeTrack[];
}

const device = (kind: MediaDeviceKind, deviceId: string, label: string) => ({ kind, deviceId, label, groupId: "" }) as MediaDeviceInfo;
const BUILT_IN = device("audioinput", "mic-1", "Built-in Microphone");
const USB = device("audioinput", "mic-2", "USB Microphone");
const FACETIME = device("videoinput", "cam-1", "FaceTime HD Camera");
const WEBCAM = device("videoinput", "cam-2", "USB Webcam");
/** What a huddle asks of whichever camera it opens. */
const PICTURE = { width: { ideal: 640 }, height: { ideal: 360 } };

/**
 * The browser's media devices: `devices` are the ones plugged in, and it opens the microphone or the
 * camera asked for, or the first, unless it `refuses` microphones, or `refusesCameras`, or has none.
 * With `pending`, each request waits to be answered.
 */
class FakeMedia extends EventTarget {
  devices: MediaDeviceInfo[] = [BUILT_IN, USB, FACETIME, WEBCAM];
  /** Which way each camera it says so of faces, by its device's id. */
  faces: Record<string, string> = {};
  refuses = false;
  refusesCameras = false;
  pending = false;
  /** The streams it has opened, oldest first. */
  opened: FakeStream[] = [];
  /** What each request asked for. */
  asked: MediaStreamConstraints[] = [];
  private waiting: (() => void)[] = [];

  getUserMedia = async (constraints: MediaStreamConstraints): Promise<FakeStream> => {
    this.asked.push(constraints);
    if (this.pending) await new Promise<void>((answer) => this.waiting.push(answer));
    const camera = constraints.video !== undefined;
    if (camera ? this.refusesCameras : this.refuses) throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    const listed = this.devices.filter(({ kind }) => kind === (camera ? "videoinput" : "audioinput"));
    const asked = camera ? constraints.video : constraints.audio;
    const wanted = typeof asked === "object" ? (asked.deviceId as { exact: string } | undefined)?.exact : undefined;
    const found = wanted === undefined ? listed[0] : listed.find(({ deviceId }) => deviceId === wanted);
    if (!found) throw Object.assign(new Error("Requested device not found"), { name: wanted === undefined ? "NotFoundError" : "OverconstrainedError" });
    const track = new FakeTrack(found.deviceId, found.label, this.faces[found.deviceId]);
    const stream = { track, getAudioTracks: () => (camera ? [] : [track]), getVideoTracks: () => (camera ? [track] : []), getTracks: () => [track] };
    this.opened.push(stream);
    return stream;
  };

  // Unnamed until one of their kind has been opened, as browsers list them: the speakers go with the microphones.
  enumerateDevices = async () => {
    const named = (kind: MediaDeviceKind) => this.opened.some((stream) => (kind === "videoinput" ? stream.getVideoTracks() : stream.getAudioTracks()).length > 0);
    return this.devices.map((listed) => (named(listed.kind) ? listed : device(listed.kind, "", "")));
  };

  /** Answers the requests that are waiting. */
  async answer() {
    for (const answer of this.waiting.splice(0)) answer();
    await act(async () => {});
  }

  plugIn(...devices: MediaDeviceInfo[]) {
    this.devices = [...this.devices, ...devices];
    this.dispatchEvent(new Event("devicechange"));
  }
}

let media: FakeMedia;

beforeEach(() => {
  media = new FakeMedia();
  Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
  // jsdom plays nothing.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});

afterEach(() => {
  act(() => showHuddle(null));
  Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
  vi.mocked(joinHuddle).mockReset();
  vi.restoreAllMocks();
});

/** A browser that can play through a speaker it's told, as Chrome and Firefox can. */
const withSpeakerChoice = () => Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { value: vi.fn(), configurable: true });

function renderPreview(live?: LiveHuddle, room: Room = general) {
  const onClose = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <PeopleContext value={PEOPLE}>
      <HuddlePreview room={room} me={ada} live={live} onClose={onClose} />
    </PeopleContext>,
  );
  return { onClose, user, ...view };
}

/** The preview once the browser has answered for the microphone. */
async function openedPreview(live?: LiveHuddle, room?: Room) {
  const shown = renderPreview(live, room);
  await waitFor(() => expect(screen.getByRole("status")).toBeEmptyDOMElement());
  return shown;
}

const preview = () => screen.getByRole("dialog");
const microphoneSelect = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Microphone" });
const speakerSelect = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Speaker" });
const cameraSelect = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Camera" });
const picture = () => screen.getByLabelText<HTMLVideoElement>("Your camera");

/** The preview with its camera turned on, once the browser has answered for that too: the second stream it opened. */
async function previewWithCamera(live?: LiveHuddle) {
  const shown = await openedPreview(live);
  await shown.user.click(screen.getByRole("button", { name: "Turn on camera" }));
  await screen.findByRole("button", { name: "Turn off camera" });
  return shown;
}
const optionsOf = (select: HTMLSelectElement) => [...select.options].map((option) => option.textContent);

/** A workspace whose administrator has cameras on in huddles, or off. */
function Cameras({ allowed, children }: { allowed: boolean; children: ReactNode }) {
  return <AccountContext value={{ ...useAccount(), huddleCameras: allowed }}>{children}</AccountContext>;
}

/** The preview in such a workspace, once the browser has answered for the microphone, and the call that turns cameras off there, or on again. */
async function previewWhereCameras(allowed: boolean) {
  const page = (cameras: boolean) => (
    <Cameras allowed={cameras}>
      <PeopleContext value={PEOPLE}>
        <HuddlePreview room={general} me={ada} live={undefined} onClose={vi.fn()} />
      </PeopleContext>
    </Cameras>
  );
  const user = userEvent.setup();
  const { rerender } = render(page(allowed));
  await waitFor(() => expect(screen.getByRole("status")).toBeEmptyDOMElement());
  return { user, allowCameras: (cameras: boolean) => rerender(page(cameras)) };
}

describe("Starting a huddle", () => {
  it("asks the browser for the microphone as it opens, and waits for its answer", async () => {
    media.pending = true;
    renderPreview();
    expect(preview()).toHaveAccessibleName("Start a huddle in general");
    expect(preview()).toHaveAccessibleDescription("Everyone in general can join once it starts.");
    expect(screen.getByRole("heading", { name: "Start a huddle in general" })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(ASKING_FOR_MICROPHONE);
    expect(screen.getByRole("button", { name: "Start Huddle" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unmute microphone" })).toBeDisabled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(media.asked).toEqual([{ audio: true }]);

    await media.answer();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "Start Huddle" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Mute microphone" })).toBeEnabled();
    expect(microphoneSelect()).toHaveValue("mic-1");
    expect(optionsOf(microphoneSelect())).toEqual(["Built-in Microphone", "USB Microphone"]);
  });

  it("starts the huddle with the microphone it has open, which the huddle closes from then on", async () => {
    const { onClose, user, unmount } = await openedPreview();
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    // A shared room's huddle invites nobody: everyone in the room can see it's going on.
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith({ roomId: "general", muted: false, microphone: media.opened[0], camera: null, speakerId: "", invite: [] });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(media.opened[0]!.track.stopped).toBe(false);
  });

  it("starts muted once its switch is off", async () => {
    const { user } = await openedPreview();
    await user.click(screen.getByRole("button", { name: "Mute microphone" }));
    await user.click(screen.getByRole("button", { name: "Unmute microphone" }));
    await user.click(screen.getByRole("button", { name: "Mute microphone" }));
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ muted: true, microphone: media.opened[0] }));
  });

  it("starts listening only when the browser has no microphone to give, and says so", async () => {
    media.refuses = true;
    const { user } = renderPreview();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(NO_MICROPHONE));
    expect(screen.getByRole("button", { name: "Unmute microphone" })).toBeDisabled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith({ roomId: "general", muted: false, microphone: null, camera: null, speakerId: "", invite: [] });
  });

  it.each(["Cancel", "the × in its corner", "Escape"])("closes the microphone when it's left by %s", async (way) => {
    const { onClose, user, unmount } = await openedPreview();
    if (way === "Escape") await user.keyboard("{Escape}");
    else await user.click(within(preview()).getAllByRole("button", { name: "Cancel" })[way === "Cancel" ? 1 : 0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(joinHuddle).not.toHaveBeenCalled();
    unmount();
    expect(media.opened[0]!.track.stopped).toBe(true);
  });

  it("closes a microphone the browser gives it after it has closed", async () => {
    media.pending = true;
    const { unmount } = renderPreview();
    unmount();
    await media.answer();
    expect(media.opened).toHaveLength(1);
    expect(media.opened[0]!.track.stopped).toBe(true);
  });
});

describe("A huddle's microphone and speaker", () => {
  it("opens the microphone this browser's last huddle chose", async () => {
    localStorage.setItem("ember:huddle-microphone", "mic-2");
    await openedPreview();
    expect(media.asked).toEqual([{ audio: { deviceId: { exact: "mic-2" } } }]);
    expect(microphoneSelect()).toHaveValue("mic-2");
  });

  it("opens the browser's own choice once the one remembered is gone", async () => {
    localStorage.setItem("ember:huddle-microphone", "mic-9");
    await openedPreview();
    expect(media.asked).toEqual([{ audio: { deviceId: { exact: "mic-9" } } }, { audio: true }]);
    expect(microphoneSelect()).toHaveValue("mic-1");
  });

  it("opens another one chosen, closing the last, and remembers it", async () => {
    const { user } = await openedPreview();
    await user.selectOptions(microphoneSelect(), "USB Microphone");
    await waitFor(() => expect(microphoneSelect()).toHaveValue("mic-2"));
    expect(media.opened[0]!.track.stopped).toBe(true);
    expect(media.opened[1]!.track.stopped).toBe(false);
    expect(localStorage.getItem("ember:huddle-microphone")).toBe("mic-2");
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ microphone: media.opened[1] }));
  });

  it("takes the browser's own choice when the microphone it has open is unplugged", async () => {
    localStorage.setItem("ember:huddle-microphone", "mic-2");
    await openedPreview();
    // The preview listens for its end in an effect, which can run after its microphone shows.
    await waitFor(() => expect(media.opened[0]!.track.listenedTo).toBe(true));
    media.devices = [BUILT_IN];
    act(() => void media.opened[0]!.track.dispatchEvent(new Event("ended")));
    await waitFor(() => expect(microphoneSelect()).toHaveValue("mic-1"));
    expect(optionsOf(microphoneSelect())).toEqual(["Built-in Microphone"]);
    expect(media.asked.at(-1)).toEqual({ audio: true });
  });

  it("lists a microphone plugged in while it's open", async () => {
    await openedPreview();
    act(() => media.plugIn(device("audioinput", "mic-3", "Headset")));
    await waitFor(() => expect(optionsOf(microphoneSelect())).toEqual(["Built-in Microphone", "USB Microphone", "Headset"]));
    expect(microphoneSelect()).toHaveValue("mic-1");
  });

  it("names the microphone that's open even if the browser's list leaves it out, and numbers ones without a name", async () => {
    media.enumerateDevices = async () => [device("audioinput", "mic-7", "")];
    await openedPreview();
    expect(optionsOf(microphoneSelect())).toEqual(["Built-in Microphone", "Microphone 2"]);
    expect(microphoneSelect()).toHaveValue("mic-1");
  });

  it("offers no speaker where the browser plays through the system's, as Safari does", async () => {
    media.devices = [BUILT_IN, device("audiooutput", "speaker-1", "Built-in Speakers")];
    await openedPreview();
    expect(screen.queryByRole("combobox", { name: "Speaker" })).not.toBeInTheDocument();
  });

  it("offers the speakers where the browser can play through one, after the system's own, and remembers the one chosen", async () => {
    withSpeakerChoice();
    media.devices = [BUILT_IN, device("audiooutput", "speaker-1", "Built-in Speakers"), device("audiooutput", "speaker-2", "USB Headset")];
    const { user } = await openedPreview();
    expect(optionsOf(speakerSelect())).toEqual(["System default", "Built-in Speakers", "USB Headset"]);
    expect(speakerSelect()).toHaveValue("");
    await user.selectOptions(speakerSelect(), "USB Headset");
    expect(localStorage.getItem("ember:huddle-speaker")).toBe("speaker-2");
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ speakerId: "speaker-2" }));
  });

  it("lists a browser's own default speaker as the browser does, in place of the system's", async () => {
    withSpeakerChoice();
    media.devices = [BUILT_IN, device("audiooutput", "default", "Default - Built-in Speakers"), device("audiooutput", "speaker-1", "Built-in Speakers")];
    const { user } = await openedPreview();
    expect(optionsOf(speakerSelect())).toEqual(["Default - Built-in Speakers", "Built-in Speakers"]);
    expect(speakerSelect()).toHaveValue("default");
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ speakerId: "default" }));
  });

  it("plays through the speaker remembered while it's plugged in, and the system's once it isn't", async () => {
    withSpeakerChoice();
    localStorage.setItem("ember:huddle-speaker", "speaker-2");
    media.devices = [BUILT_IN, device("audiooutput", "speaker-1", "Built-in Speakers"), device("audiooutput", "speaker-2", "USB Headset")];
    const first = await openedPreview();
    expect(speakerSelect()).toHaveValue("speaker-2");
    first.unmount();

    media.devices = [BUILT_IN, device("audiooutput", "speaker-1", "Built-in Speakers")];
    const { user } = await openedPreview();
    expect(speakerSelect()).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ speakerId: "" }));
  });
});

describe("A huddle's camera", () => {
  it("leaves the camera off, and unasked for, until its switch turns it on", async () => {
    const { user } = await openedPreview();
    const off = screen.getByRole("button", { name: "Turn on camera" });
    expect(off).toHaveClass("bg-background");
    expect(media.asked).toEqual([{ audio: true }]);
    expect(preview().querySelector("video")).toBeNull();
    expect(preview().querySelectorAll("img")).toHaveLength(1);
    expect(screen.queryByRole("combobox", { name: "Camera" })).not.toBeInTheDocument();

    await user.click(off);
    expect(await screen.findByRole("button", { name: "Turn off camera" })).toHaveClass("bg-foreground", "text-background");
    expect(media.asked.at(-1)).toEqual({ video: PICTURE });
    // Your own picture, as a mirror would show it, in place of your avatar.
    expect(picture().srcObject).toBe(media.opened[1]);
    expect(picture()).toHaveClass("-scale-x-100");
    expect(picture()).toHaveProperty("muted", true);
    expect(preview().querySelector("img")).toBeNull();
    // The browser names the cameras once one is open.
    await waitFor(() => expect(optionsOf(cameraSelect())).toEqual(["FaceTime HD Camera", "USB Webcam"]));
    expect(cameraSelect()).toHaveValue("cam-1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("starts the huddle with the camera it has open, which the huddle closes from then on", async () => {
    const { user, unmount } = await previewWithCamera();
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith({ roomId: "general", muted: false, microphone: media.opened[0], camera: media.opened[1], speakerId: "", invite: [] });
    unmount();
    expect(media.opened[1]!.track.stopped).toBe(false);
  });

  it("closes the camera once its switch turns it off, and starts without one", async () => {
    const { user } = await previewWithCamera();
    await user.click(screen.getByRole("button", { name: "Turn off camera" }));
    expect(screen.getByRole("button", { name: "Turn on camera" })).toBeInTheDocument();
    expect(media.opened[1]!.track.stopped).toBe(true);
    expect(preview().querySelector("video")).toBeNull();
    expect(preview().querySelectorAll("img")).toHaveLength(1);
    expect(screen.queryByRole("combobox", { name: "Camera" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ camera: null }));
  });

  it("says so when the browser has no camera to give, until it has one", async () => {
    media.refusesCameras = true;
    const { user } = await openedPreview();
    await user.click(screen.getByRole("button", { name: "Turn on camera" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(NO_CAMERA);
    expect(screen.getByRole("button", { name: "Turn on camera" })).toBeEnabled();
    expect(preview().querySelector("video")).toBeNull();

    media.refusesCameras = false;
    await user.click(screen.getByRole("button", { name: "Turn on camera" }));
    await screen.findByRole("button", { name: "Turn off camera" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows without a microphone, when the camera is all there is to choose", async () => {
    media.refuses = true;
    const { user } = renderPreview();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(NO_MICROPHONE));
    await user.click(screen.getByRole("button", { name: "Turn on camera" }));
    await waitFor(() => expect(optionsOf(cameraSelect())).toEqual(["FaceTime HD Camera", "USB Webcam"]));
    expect(screen.getAllByRole("combobox")).toEqual([cameraSelect()]);
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ microphone: null, camera: media.opened[0] }));
  });

  it("opens the camera this browser's last huddle chose", async () => {
    localStorage.setItem("ember:huddle-camera", "cam-2");
    await previewWithCamera();
    expect(media.asked.at(-1)).toEqual({ video: { ...PICTURE, deviceId: { exact: "cam-2" } } });
    await waitFor(() => expect(cameraSelect()).toHaveValue("cam-2"));
  });

  it("opens the browser's own choice once the one remembered is gone", async () => {
    localStorage.setItem("ember:huddle-camera", "cam-9");
    await previewWithCamera();
    expect(media.asked.slice(-2)).toEqual([{ video: { ...PICTURE, deviceId: { exact: "cam-9" } } }, { video: PICTURE }]);
    await waitFor(() => expect(cameraSelect()).toHaveValue("cam-1"));
  });

  it("opens another one chosen, closing the last, and remembers it", async () => {
    const { user } = await previewWithCamera();
    await waitFor(() => expect(optionsOf(cameraSelect())).toContain("USB Webcam"));
    await user.selectOptions(cameraSelect(), "USB Webcam");
    await waitFor(() => expect(cameraSelect()).toHaveValue("cam-2"));
    expect(media.opened[1]!.track.stopped).toBe(true);
    expect(media.opened[2]!.track.stopped).toBe(false);
    expect(picture().srcObject).toBe(media.opened[2]);
    expect(localStorage.getItem("ember:huddle-camera")).toBe("cam-2");
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ microphone: media.opened[0], camera: media.opened[2] }));
  });

  it("shows you a camera that faces away from you, as a phone's back camera does, as it is, and one that faces you as a mirror would", async () => {
    media.faces = { [FACETIME.deviceId]: "user", [WEBCAM.deviceId]: "environment" };
    const { user } = await previewWithCamera();
    expect(picture()).toHaveClass("-scale-x-100");
    await waitFor(() => expect(optionsOf(cameraSelect())).toContain("USB Webcam"));
    await user.selectOptions(cameraSelect(), "USB Webcam");
    await waitFor(() => expect(picture().srcObject).toBe(media.opened[2]));
    expect(picture()).not.toHaveClass("-scale-x-100");
  });

  it("names the camera that's open even if the browser's list leaves it out, and numbers ones without a name", async () => {
    media.enumerateDevices = async () => [device("videoinput", "cam-7", "")];
    await previewWithCamera();
    expect(optionsOf(cameraSelect())).toEqual(["FaceTime HD Camera", "Camera 2"]);
    expect(cameraSelect()).toHaveValue("cam-1");
  });

  it("goes off when the camera it has open is unplugged", async () => {
    await previewWithCamera();
    await waitFor(() => expect(media.opened[1]!.track.listenedTo).toBe(true));
    act(() => void media.opened[1]!.track.dispatchEvent(new Event("ended")));
    expect(screen.getByRole("button", { name: "Turn on camera" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(media.asked).toHaveLength(2);
  });

  it("closes the camera when it's left", async () => {
    const { user, unmount } = await previewWithCamera();
    await user.click(within(preview()).getAllByRole("button", { name: "Cancel" })[1]!);
    expect(joinHuddle).not.toHaveBeenCalled();
    unmount();
    expect(media.opened.map(({ track }) => track.stopped)).toEqual([true, true]);
  });

  it("closes a camera the browser gives it after it has closed", async () => {
    const { user, unmount } = await openedPreview();
    media.pending = true;
    await user.click(screen.getByRole("button", { name: "Turn on camera" }));
    unmount();
    await media.answer();
    expect(media.opened).toHaveLength(2);
    expect(media.opened[1]!.track.stopped).toBe(true);
  });

  it("starts the huddle with the camera the browser is still opening, which is the huddle's to show and to close from then on", async () => {
    const { user, unmount } = await openedPreview();
    media.pending = true;
    await user.click(screen.getByRole("button", { name: "Turn on camera" }));
    // Asked for again while the browser hasn't answered, the first one asked for is nobody's.
    await user.click(screen.getByRole("button", { name: "Turn on camera" }));
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    const { camera } = vi.mocked(joinHuddle).mock.calls[0]![0];
    expect(camera).toBeInstanceOf(Promise);
    unmount();
    await media.answer();
    expect(await camera).toBe(media.opened[2]);
    expect(media.opened.map(({ track }) => track.stopped)).toEqual([false, true, false]);
  });

  it("keeps the camera through a change of microphone", async () => {
    const { user } = await previewWithCamera();
    await user.selectOptions(microphoneSelect(), "USB Microphone");
    await waitFor(() => expect(microphoneSelect()).toHaveValue("mic-2"));
    expect(media.opened[1]!.track.stopped).toBe(false);
    expect(picture().srcObject).toBe(media.opened[1]);
  });

  it("has no camera switch while an administrator has cameras off, and starts without one", async () => {
    const { user } = await previewWhereCameras(false);
    expect(screen.getByRole("button", { name: "Mute microphone" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /camera/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ camera: null }));
    expect(media.asked).toEqual([{ audio: true }]);
  });

  it("closes the camera, and says why, when an administrator turns cameras off, until they turn them on again", async () => {
    const { user, allowCameras } = await previewWhereCameras(true);
    await user.click(screen.getByRole("button", { name: "Turn on camera" }));
    await screen.findByRole("button", { name: "Turn off camera" });
    allowCameras(false);
    expect(media.opened[1]!.track.stopped).toBe(true);
    expect(preview().querySelector("video")).toBeNull();
    expect(preview().querySelectorAll("img")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /camera/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Camera" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(CAMERAS_OFF);

    allowCameras(true);
    expect(screen.getByRole("button", { name: "Turn on camera" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("closes a camera the browser was still opening as cameras were turned off, and starts without it", async () => {
    const { user, allowCameras } = await previewWhereCameras(true);
    media.pending = true;
    await user.click(screen.getByRole("button", { name: "Turn on camera" }));
    allowCameras(false);
    await media.answer();
    expect(media.opened[1]!.track.stopped).toBe(true);
    expect(preview().querySelector("video")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(CAMERAS_OFF);
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ camera: null }));
  });
});

describe("Joining a huddle", () => {
  it("says who's in the one going on, by first name as the directory has them", async () => {
    const { user } = await openedPreview(huddleOf("sam", "priya"));
    expect(preview()).toHaveAccessibleName("Join the huddle in general");
    expect(preview()).toHaveAccessibleDescription("Sam and Priya are in it now.");
    await user.click(screen.getByRole("button", { name: "Join Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ roomId: "general" }));
  });

  it("counts whoever the directory doesn't list", async () => {
    await openedPreview(huddleOf("sam", "stranger", "another"));
    expect(preview()).toHaveAccessibleDescription("Sam and 2 others are in it now.");
  });

  it("follows the huddle as people join it and as it ends", async () => {
    const { rerender } = await openedPreview(huddleOf("sam"));
    expect(preview()).toHaveAccessibleDescription("Sam is in it now.");
    const shown = (live?: LiveHuddle) =>
      rerender(
        <PeopleContext value={PEOPLE}>
          <HuddlePreview room={general} me={ada} live={live} onClose={vi.fn()} />
        </PeopleContext>,
      );
    shown(huddleOf("sam", "priya"));
    expect(preview()).toHaveAccessibleDescription("Sam and Priya are in it now.");
    shown(undefined);
    expect(preview()).toHaveAccessibleName("Start a huddle in general");
    expect(screen.getByRole("button", { name: "Start Huddle" })).toBeInTheDocument();
    // The microphone stays open through it all.
    expect(media.asked).toHaveLength(1);
  });

  it("says that joining leaves the huddle wherever else this person is in it", async () => {
    const { rerender } = await openedPreview(huddleOf("ada"));
    expect(preview()).toHaveAccessibleName("Join the huddle in general");
    expect(preview()).toHaveAccessibleDescription("You're in it in another tab or on another device, and joining here leaves it there.");
    rerender(
      <PeopleContext value={PEOPLE}>
        <HuddlePreview room={general} me={ada} live={huddleOf("sam", "ada")} onClose={vi.fn()} />
      </PeopleContext>,
    );
    expect(preview()).toHaveAccessibleDescription("Sam is in it now. You're in it in another tab or on another device, and joining here leaves it there.");
  });

  it("says that it leaves the huddle this tab is in", async () => {
    const elsewhere = { roomId: "other", connected: true, you: ada, people: [], muted: false, microphone: true, microphoneId: "", speakerId: "", camera: null, watched: new Map(), screen: null, screens: new Map(), open: false };
    act(() => showHuddle(elsewhere, { leave: vi.fn(), setMuted: vi.fn(), setCamera: vi.fn(), setScreen: vi.fn(), setOpen: vi.fn(), setDevice: vi.fn(), setSmall: vi.fn(), switchCamera: vi.fn() }));
    const { unmount } = await openedPreview();
    expect(preview()).toHaveAccessibleDescription("Everyone in general can join once it starts. Starting it leaves the huddle you're in now.");
    unmount();
    await openedPreview(huddleOf("sam"));
    expect(preview()).toHaveAccessibleDescription("Sam is in it now. Joining it leaves the huddle you're in now.");
  });
});

describe("A huddle in a direct message", () => {
  it("is with the other person in it, whom starting it invites", async () => {
    const { user } = await openedPreview(undefined, directWith("priya"));
    expect(preview()).toHaveAccessibleName("Start a huddle with Priya Patel");
    expect(preview()).toHaveAccessibleDescription("Priya is invited once it starts.");
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ roomId: "direct-1", invite: ["priya"] }));
  });

  it("invites everyone else in a group's, but for its bots and whoever can no longer sign in", async () => {
    const { user } = await openedPreview(undefined, directWith("priya", "deploys", "sam", "grace"));
    expect(preview()).toHaveAccessibleName("Start a huddle with Priya Patel, Deploys, Sam Rivera, and Grace Hopper");
    expect(preview()).toHaveAccessibleDescription("Priya and Sam are invited once it starts.");
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ invite: ["priya", "sam"] }));
  });

  it("invites as many of a large group's as one invitation names, and says how many", async () => {
    const others = Array.from({ length: MAX_HUDDLE_INVITED + 1 }, (_, index) => `member-${index}`);
    const { user } = await openedPreview(undefined, directWith("priya", "sam", ...others));
    expect(preview()).toHaveAccessibleDescription(`Priya, Sam, Was, and ${MAX_HUDDLE_INVITED - 3} others are invited once it starts.`);
    await user.click(screen.getByRole("button", { name: "Start Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ invite: ["priya", "sam", ...others.slice(0, MAX_HUDDLE_INVITED - 2)] }));
  });

  it("says who's in the one going on, and still names the others for the huddle to invite if it has ended by then", async () => {
    const { user } = await openedPreview(huddleOf("priya"), directWith("priya"));
    expect(preview()).toHaveAccessibleName("Join the huddle with Priya Patel");
    expect(preview()).toHaveAccessibleDescription("Priya is in it now.");
    await user.click(screen.getByRole("button", { name: "Join Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ roomId: "direct-1", invite: ["priya"] }));
  });

  it("invites nobody again when the only person in it moves it here from another tab or device", async () => {
    const { user } = await openedPreview(huddleOf("ada"), directWith("priya"));
    expect(preview()).toHaveAccessibleName("Join the huddle with Priya Patel");
    expect(preview()).toHaveAccessibleDescription("You're in it in another tab or on another device, and joining here leaves it there.");
    await user.click(screen.getByRole("button", { name: "Join Huddle" }));
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ roomId: "direct-1", invite: [] }));
  });
});
