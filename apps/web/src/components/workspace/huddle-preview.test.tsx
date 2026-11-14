import type { DirectoryUser, LiveHuddle, Me, SharedRoom } from "@ember/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeopleContext } from "@/hooks/use-directory";
import { joinHuddle } from "@/lib/huddle";
import { showHuddle } from "@/lib/huddle-store";
import { ASKING_FOR_MICROPHONE, HuddlePreview, NO_MICROPHONE } from "./huddle-preview";

vi.mock("@/lib/huddle", () => ({ joinHuddle: vi.fn() }));

const general: SharedRoom = { id: "general", name: "general", kind: "open", icon: null };
const ada: Me = { id: "ada", name: "Ada Lovelace", administrator: false };
const person = (id: string, name: string): DirectoryUser => ({ id, name, bio: null, role: "member", status: "active", avatarUrl: `/users/${id}/avatar` });
const PEOPLE = new Map([person("sam", "Sam Rivera"), person("priya", "Priya Patel"), person("ada", "Ada Lovelace")].map((listed) => [listed.id, listed]));
const huddleOf = (...userIds: string[]): LiveHuddle => ({ startedAt: "2026-11-10T09:00:00.000Z", userIds });

/** A microphone's track, as much of one as the preview and the tests read. */
class FakeTrack extends EventTarget {
  stopped = false;
  /** Whether anything listens to it yet, as the preview does for its end, from an effect. */
  listenedTo = false;
  constructor(
    readonly deviceId: string,
    readonly label: string,
  ) {
    super();
  }
  stop() {
    this.stopped = true;
  }
  getSettings() {
    return { deviceId: this.deviceId };
  }
  addEventListener(...listener: Parameters<EventTarget["addEventListener"]>) {
    this.listenedTo = true;
    super.addEventListener(...listener);
  }
}

interface FakeStream {
  track: FakeTrack;
  getAudioTracks(): FakeTrack[];
  getTracks(): FakeTrack[];
}

const device = (kind: MediaDeviceKind, deviceId: string, label: string) => ({ kind, deviceId, label, groupId: "" }) as MediaDeviceInfo;
const BUILT_IN = device("audioinput", "mic-1", "Built-in Microphone");
const USB = device("audioinput", "mic-2", "USB Microphone");

/**
 * The browser's media devices: `devices` are the ones plugged in, and it opens the microphone asked for,
 * or the first, unless `refuses` or it has none. With `pending`, each request waits to be answered.
 */
class FakeMedia extends EventTarget {
  devices: MediaDeviceInfo[] = [BUILT_IN, USB];
  refuses = false;
  pending = false;
  /** The streams it has opened, oldest first. */
  opened: FakeStream[] = [];
  /** What each request asked for. */
  asked: MediaStreamConstraints[] = [];
  private waiting: (() => void)[] = [];

  getUserMedia = async (constraints: MediaStreamConstraints): Promise<FakeStream> => {
    this.asked.push(constraints);
    if (this.pending) await new Promise<void>((answer) => this.waiting.push(answer));
    if (this.refuses) throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    const microphones = this.devices.filter(({ kind }) => kind === "audioinput");
    const wanted = typeof constraints.audio === "object" ? (constraints.audio.deviceId as { exact: string }).exact : undefined;
    const found = wanted === undefined ? microphones[0] : microphones.find(({ deviceId }) => deviceId === wanted);
    if (!found) throw Object.assign(new Error("Requested device not found"), { name: wanted === undefined ? "NotFoundError" : "OverconstrainedError" });
    const track = new FakeTrack(found.deviceId, found.label);
    const stream = { track, getAudioTracks: () => [track], getTracks: () => [track] };
    this.opened.push(stream);
    return stream;
  };

  // Unnamed until a microphone has been opened, as browsers list them.
  enumerateDevices = async () => (this.opened.length > 0 ? this.devices : this.devices.map(({ kind }) => device(kind, "", "")));

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
});

afterEach(() => {
  act(() => showHuddle(null));
  Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
  vi.mocked(joinHuddle).mockReset();
});

/** A browser that can play through a speaker it's told, as Chrome and Firefox can. */
const withSpeakerChoice = () => Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { value: vi.fn(), configurable: true });

function renderPreview(live?: LiveHuddle) {
  const onClose = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <PeopleContext value={PEOPLE}>
      <HuddlePreview room={general} me={ada} live={live} onClose={onClose} />
    </PeopleContext>,
  );
  return { onClose, user, ...view };
}

/** The preview once the browser has answered for the microphone. */
async function openedPreview(live?: LiveHuddle) {
  const shown = renderPreview(live);
  await waitFor(() => expect(screen.getByRole("status")).toBeEmptyDOMElement());
  return shown;
}

const preview = () => screen.getByRole("dialog");
const microphoneSelect = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Microphone" });
const speakerSelect = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Speaker" });
const optionsOf = (select: HTMLSelectElement) => [...select.options].map((option) => option.textContent);

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
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith({ roomId: "general", muted: false, microphone: media.opened[0], speakerId: "" });
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
    expect(joinHuddle).toHaveBeenCalledExactlyOnceWith({ roomId: "general", muted: false, microphone: null, speakerId: "" });
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
    act(() => showHuddle({ roomId: "other", connected: true, you: ada, people: [], muted: false, microphone: true }, { leave: vi.fn(), setMuted: vi.fn() }));
    const { unmount } = await openedPreview();
    expect(preview()).toHaveAccessibleDescription("Everyone in general can join once it starts. Starting it leaves the huddle you're in now.");
    unmount();
    await openedPreview(huddleOf("sam"));
    expect(preview()).toHaveAccessibleDescription("Sam is in it now. Joining it leaves the huddle you're in now.");
  });
});
