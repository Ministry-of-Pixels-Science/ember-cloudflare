import type { DirectoryUser, Room, User } from "@ember/protocol";
import type { HuddlePerson } from "@ember/protocol/huddles";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { showHuddle, showSpeaking, type JoinedHuddle } from "@/lib/huddle-store";
import { HuddleBar } from "./huddle-bar";

const ada: User = { id: "ada", name: "Ada Lovelace" };
const sam: User = { id: "sam", name: "Sam Rivera" };
const priya: User = { id: "priya", name: "Priya Patel" };
const general: Room = { id: "general", name: "general", kind: "open", icon: null };
const inHuddle = (user: User, muted = false): HuddlePerson => ({ user, muted, audio: true, video: false, screen: false });
const huddle = (changes: Partial<JoinedHuddle> = {}): JoinedHuddle => ({
  roomId: "general",
  connected: true,
  you: ada,
  people: [inHuddle(sam), inHuddle(ada)],
  muted: false,
  microphone: true,
  microphoneId: "",
  speakerId: "",
  camera: null,
  watched: new Map(),
  screen: null,
  screens: new Map(),
  open: false,
  ...changes,
});
/** A camera that's on, as much of one as the bar reads, and a screen that's shared. */
const CAMERA = {} as MediaStream;
const SCREEN = {} as MediaStream;

/** The bar of the huddle this tab is in, with what the huddle's controls were asked. */
function renderBar(joined: JoinedHuddle = huddle(), room: Room | null = general) {
  const controls = { leave: vi.fn(), setMuted: vi.fn(), setCamera: vi.fn(), setScreen: vi.fn(), setOpen: vi.fn(), setDevice: vi.fn(), setSmall: vi.fn(), switchCamera: vi.fn() };
  act(() => showHuddle(joined, controls));
  const user = userEvent.setup();
  const view = render(<HuddleBar huddle={joined} room={room} meId="ada" />);
  return { ...controls, user, ...view };
}

/** A workspace whose administrator has cameras off in huddles. */
function CamerasOff({ children }: { children: ReactNode }) {
  return <AccountContext value={{ ...useAccount(), huddleCameras: false }}>{children}</AccountContext>;
}

/** And one whose administrator has screen sharing off. */
function ScreensOff({ children }: { children: ReactNode }) {
  return <AccountContext value={{ ...useAccount(), huddleScreens: false }}>{children}</AccountContext>;
}

/** Has the browser be one that can share a screen, which jsdom's isn't, as a phone's isn't. */
function browserSharesScreens() {
  Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia: vi.fn() }, configurable: true });
}

const bar = () => screen.getByRole("region");
const state = () => bar().querySelector("[aria-live]");

afterEach(() => {
  act(() => showHuddle(null));
  act(() => showSpeaking(new Set()));
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("The huddle bar", () => {
  it("names the huddle's room and who's in it, on a button that opens the huddle", async () => {
    const { setOpen, user } = renderBar();
    expect(bar()).toHaveAccessibleName("Huddle in general");
    expect(state()).toHaveTextContent("Sam and you are in the huddle");
    const name = screen.getByRole("button", { name: "Huddle in general Sam and you are in the huddle" });
    expect(name).toHaveAttribute("title", "Open huddle");
    await user.click(name);
    expect(setOpen).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("opens the huddle from the button before Leave, too, which phones leave out", async () => {
    const { setOpen, user } = renderBar();
    const open = screen.getByRole("button", { name: "Open huddle" });
    expect(open).toHaveClass("max-md:hidden");
    expect(screen.getAllByRole("button").at(-2)).toBe(open);
    await user.click(open);
    expect(setOpen).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("takes the focus when nothing has it, as when the button that minimized the huddle went with it", () => {
    renderBar();
    expect(screen.getByRole("button", { name: /^Huddle in general/ })).toHaveFocus();
  });

  it("leaves the focus with whatever has it", () => {
    const composer = document.body.appendChild(document.createElement("textarea"));
    composer.focus();
    renderBar();
    expect(composer).toHaveFocus();
    composer.remove();
  });

  it("says when nobody else is in it, and counts past three others", () => {
    const { rerender } = renderBar(huddle({ people: [inHuddle(ada)] }));
    expect(state()).toHaveTextContent("Just you in the huddle");
    const crowd = Array.from({ length: 5 }, (_, index) => inHuddle({ id: `u${index}`, name: `Person${index} Smith` }));
    rerender(<HuddleBar huddle={huddle({ people: [...crowd, inHuddle(ada)] })} room={general} meId="ada" />);
    expect(state()).toHaveTextContent("Person0, Person1, Person2, and 2 others are in the huddle");
  });

  it("says who shares a screen in place of who's in it, since only the huddle opened shows one", () => {
    const sharing = (...users: User[]) => [...users.map((user) => ({ ...inHuddle(user), screen: true })), inHuddle(ada)];
    const { rerender } = renderBar(huddle({ people: sharing(sam) }));
    expect(state()).toHaveTextContent("Sam is sharing a screen");
    expect(screen.getByRole("button", { name: "Huddle in general Sam is sharing a screen" })).toHaveAttribute("title", "Open huddle");
    rerender(<HuddleBar huddle={huddle({ people: sharing(sam, priya) })} room={general} meId="ada" />);
    expect(state()).toHaveTextContent("Sam and Priya are sharing screens");
    // Your own is shared from when the browser shares it, whatever the room has said of it yet.
    rerender(<HuddleBar huddle={huddle({ screen: SCREEN })} room={general} meId="ada" />);
    expect(state()).toHaveTextContent("You're sharing your screen");
    rerender(<HuddleBar huddle={huddle({ screen: SCREEN, people: [{ ...inHuddle(ada), screen: true }, ...sharing(sam)] })} room={general} meId="ada" />);
    expect(state()).toHaveTextContent("Sam and you are sharing screens");
    rerender(<HuddleBar huddle={huddle({ connected: false, people: sharing(sam) })} room={general} meId="ada" />);
    expect(state()).toHaveTextContent("Reconnecting…");
  });

  it("says that it's connecting until the room lets the tab in, and reconnecting while its connection is down", () => {
    const { rerender } = renderBar(huddle({ connected: false, you: null, people: [] }));
    expect(state()).toHaveTextContent("Connecting…");
    rerender(<HuddleBar huddle={huddle({ connected: false })} room={general} meId="ada" />);
    expect(state()).toHaveTextContent("Reconnecting…");
    expect(state()).toHaveAttribute("aria-live", "polite");
  });

  it("is just Huddle once its room isn't among this person's", () => {
    renderBar(huddle(), null);
    expect(bar()).toHaveAccessibleName("Huddle");
  });

  it("names a DM's by who it's with", () => {
    renderBar(huddle(), { id: "direct-1", kind: "direct", members: [ada, priya], activeAt: "2026-11-10T09:00:00.000Z" });
    expect(bar()).toHaveAccessibleName("Huddle with Priya Patel");
  });

  it("shows the first four faces, named as the directory has them now", () => {
    const renamed: DirectoryUser = { id: "sam", name: "Samuel Rivera", bio: null, role: "member", status: "active", avatarUrl: "/users/sam/avatar" };
    const crowd = Array.from({ length: 4 }, (_, index) => inHuddle({ id: `u${index}`, name: `Person ${index}` }));
    act(() => showHuddle(null));
    render(
      <PeopleContext value={new Map([[renamed.id, renamed]])}>
        <HuddleBar huddle={huddle({ people: [inHuddle(sam), ...crowd, inHuddle(ada)] })} room={general} meId="ada" />
      </PeopleContext>,
    );
    const faces = screen.getByTitle("Samuel Rivera, Person 0, Person 1, Person 2, Person 3, Ada Lovelace");
    expect(faces.querySelectorAll("img")).toHaveLength(4);
    expect(faces).toHaveAttribute("aria-hidden", "true");
    expect(state()).toHaveTextContent("Samuel, Person, Person, and 2 others are in the huddle");
  });

  it("rings the face of whoever is speaking in green, over the faces beside it, but nobody's who is muted", () => {
    renderBar(huddle({ people: [inHuddle(sam), inHuddle(priya, true), inHuddle(ada)] }));
    const faces = () => [...screen.getByTitle("Sam Rivera, Priya Patel, Ada Lovelace").querySelectorAll("img")];
    for (const face of faces()) expect(face).toHaveClass("ring-2", "ring-background");

    act(() => showSpeaking(new Set(["sam", "priya"])));
    const [first, second, third] = faces();
    expect(first).toHaveClass("relative", "ring-2", "ring-positive");
    expect(first).not.toHaveClass("ring-background");
    // Whatever was heard of Priya as she muted.
    expect(second).toHaveClass("ring-background");
    expect(third).toHaveClass("ring-background");
    // Its line says who's in the huddle still, and not who speaks, which would be read out each time.
    expect(state()).toHaveTextContent("Sam, Priya, and you are in the huddle");

    act(() => showSpeaking(new Set(["ada"])));
    expect(faces().map((face) => face.classList.contains("ring-positive"))).toEqual([false, false, true]);
  });

  it("has no arrows beside its buttons, which choose among devices only in the huddle opened", () => {
    renderBar();
    expect(screen.queryByRole("button", { name: "Microphone and speaker" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Camera" })).not.toBeInTheDocument();
    for (const name of ["Mute microphone", "Turn on camera"]) expect(screen.getByRole("button", { name })).not.toHaveClass("md:rounded-r-none");
  });
});

describe("The huddle bar's microphone", () => {
  it("mutes the microphone, filled in ink while it's on", async () => {
    const { setMuted, user } = renderBar();
    const mute = screen.getByRole("button", { name: "Mute microphone" });
    expect(mute).toHaveClass("bg-foreground", "text-background");
    await user.click(mute);
    expect(setMuted).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("unmutes it once it's muted", async () => {
    const { setMuted, user } = renderBar(huddle({ muted: true }));
    const unmute = screen.getByRole("button", { name: "Unmute microphone" });
    expect(unmute).toHaveClass("bg-hover");
    await user.click(unmute);
    expect(setMuted).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("has nothing to switch for someone listening only", () => {
    renderBar(huddle({ muted: true, microphone: false }));
    expect(screen.getByRole("button", { name: "No microphone" })).toBeDisabled();
  });

  it("names what it does and the keys that do it in a tooltip, and the keys for screen readers", async () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });
    const { user } = renderBar();
    const mute = screen.getByRole("button", { name: "Mute microphone" });
    expect(mute).toHaveAttribute("aria-keyshortcuts", "Meta+Shift+Space");
    await user.hover(mute);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Mute microphone⌘⇧Space");
  });
});

describe("The huddle bar's camera", () => {
  it("turns the camera on, which phones leave to the huddle opened", async () => {
    const { setCamera, user } = renderBar();
    const camera = screen.getByRole("button", { name: "Turn on camera" });
    expect(camera).toHaveClass("bg-hover", "max-md:hidden");
    expect(camera).toHaveAttribute("title", "Turn on camera");
    await user.click(camera);
    expect(setCamera).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("turns it off once it's on, filled in ink until then", async () => {
    const { setCamera, user } = renderBar(huddle({ camera: CAMERA }));
    const camera = screen.getByRole("button", { name: "Turn off camera" });
    expect(camera).toHaveClass("bg-foreground", "text-background");
    await user.click(camera);
    expect(setCamera).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("has no camera button while an administrator has cameras off, but to turn off a camera that's on still", async () => {
    const { setCamera, user, rerender } = renderBar();
    rerender(
      <CamerasOff>
        <HuddleBar huddle={huddle()} room={general} meId="ada" />
      </CamerasOff>,
    );
    expect(screen.queryByRole("button", { name: /camera/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mute microphone" })).toBeInTheDocument();
    rerender(
      <CamerasOff>
        <HuddleBar huddle={huddle({ camera: CAMERA })} room={general} meId="ada" />
      </CamerasOff>,
    );
    await user.click(screen.getByRole("button", { name: "Turn off camera" }));
    expect(setCamera).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("The huddle bar's screen", () => {
  it("shares the screen in a browser that can share one, which phones leave out", async () => {
    browserSharesScreens();
    const { setScreen, user } = renderBar();
    const share = screen.getByRole("button", { name: "Share screen" });
    expect(share).toHaveClass("bg-hover", "max-md:hidden");
    expect(share).toHaveAttribute("title", "Share screen");
    await user.click(share);
    expect(setScreen).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("stops sharing it once it's shared, filled in ink until then", async () => {
    const { setScreen, user } = renderBar(huddle({ screen: SCREEN }));
    const stop = screen.getByRole("button", { name: "Stop sharing screen" });
    expect(stop).toHaveClass("bg-foreground", "text-background");
    await user.click(stop);
    expect(setScreen).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("has no button for it in a browser that can't share a screen, nor while an administrator has screen sharing off, but to stop one that's shared still", async () => {
    const { setScreen, user, rerender } = renderBar();
    expect(screen.queryByRole("button", { name: /screen/ })).not.toBeInTheDocument();
    browserSharesScreens();
    rerender(
      <ScreensOff>
        <HuddleBar huddle={huddle()} room={general} meId="ada" />
      </ScreensOff>,
    );
    expect(screen.queryByRole("button", { name: /screen/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn on camera" })).toBeInTheDocument();
    rerender(
      <ScreensOff>
        <HuddleBar huddle={huddle({ screen: SCREEN })} room={general} meId="ada" />
      </ScreensOff>,
    );
    await user.click(screen.getByRole("button", { name: "Stop sharing screen" }));
    expect(setScreen).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("Leaving a huddle from its bar", () => {
  it("leaves on Leave, the last of its buttons", async () => {
    const { leave, user } = renderBar();
    const buttons = screen.getAllByRole("button");
    expect(buttons.at(-1)).toHaveAccessibleName("Leave");
    await user.click(buttons.at(-1)!);
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
