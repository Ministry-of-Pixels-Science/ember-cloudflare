import type { DirectoryUser, Room, User } from "@ember/protocol";
import type { HuddlePerson } from "@ember/protocol/huddles";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PeopleContext } from "@/hooks/use-directory";
import { showHuddle, type JoinedHuddle } from "@/lib/huddle-store";
import { HuddleView } from "./huddle-view";

const ada: User = { id: "ada", name: "Ada Lovelace" };
const sam: User = { id: "sam", name: "Sam Rivera" };
const priya: User = { id: "priya", name: "Priya Patel" };
const general: Room = { id: "general", name: "general", kind: "open", icon: null };
const inHuddle = (user: User, changes: Partial<HuddlePerson> = {}): HuddlePerson => ({ user, muted: false, audio: true, video: false, ...changes });
const huddle = (changes: Partial<JoinedHuddle> = {}): JoinedHuddle => ({
  roomId: "general",
  connected: true,
  you: ada,
  people: [inHuddle(sam), inHuddle(ada)],
  muted: false,
  microphone: true,
  camera: null,
  watched: new Map(),
  open: true,
  ...changes,
});
/** A camera's stream, as much of one as a tile reads: jsdom has none. */
const camera = () => ({}) as MediaStream;
const crowd = (count: number) => Array.from({ length: count }, (_, index) => inHuddle({ id: `u${index}`, name: `Person ${index}` }));

/** The huddle this tab is in, opened, with what the huddle's controls were asked. */
function renderView(joined: JoinedHuddle = huddle(), room: Room | null = general) {
  const controls = { leave: vi.fn(), setMuted: vi.fn(), setCamera: vi.fn(), setOpen: vi.fn() };
  act(() => showHuddle(joined, controls));
  const user = userEvent.setup();
  const view = render(<HuddleView huddle={joined} room={room} meId="ada" />);
  return { ...controls, user, ...view };
}

const opened = () => screen.getByRole("region");
const tiles = () => within(screen.getByRole("list", { name: "In the huddle" })).getAllByRole("listitem");
const count = () => opened().querySelector("header [aria-live]");

let play: MockInstance<HTMLMediaElement["play"]>;

beforeEach(() => {
  // jsdom plays nothing.
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});

afterEach(() => {
  act(() => showHuddle(null));
  vi.restoreAllMocks();
});

describe("The huddle opened", () => {
  it("names the huddle's room, and counts who's in it", () => {
    const { rerender } = renderView();
    expect(opened()).toHaveAccessibleName("Huddle in general");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Huddle in general");
    expect(count()).toHaveTextContent("2 people");
    rerender(<HuddleView huddle={huddle({ people: [inHuddle(ada)] })} room={general} meId="ada" />);
    expect(count()).toHaveTextContent("1 person");
  });

  it("says that it's connecting until the room lets the tab in, and reconnecting while its connection is down", () => {
    const { rerender } = renderView(huddle({ connected: false, you: null, people: [] }));
    expect(count()).toHaveTextContent("Connecting…");
    rerender(<HuddleView huddle={huddle({ connected: false })} room={general} meId="ada" />);
    expect(count()).toHaveTextContent("Reconnecting…");
    expect(count()).toHaveAttribute("aria-live", "polite");
  });

  it("is just Huddle once its room isn't among this person's", () => {
    renderView(huddle(), null);
    expect(opened()).toHaveAccessibleName("Huddle");
  });

  it("takes the focus as it opens, and is where Skip to main content goes", () => {
    renderView();
    expect(opened()).toHaveFocus();
    expect(opened()).toHaveAttribute("id", "huddle");
  });

  it("minimizes from the button at either end of its header, a phone's and a computer's", async () => {
    const { setOpen, user } = renderView();
    const [phones, computers] = screen.getAllByRole("button", { name: "Minimize huddle" });
    expect(phones).toHaveClass("hidden", "max-md:flex");
    expect(computers).toHaveClass("max-md:hidden");
    await user.click(phones!);
    await user.click(computers!);
    expect(setOpen.mock.calls).toEqual([[false], [false]]);
  });
});

describe("The tiles of a huddle", () => {
  it("shows each person by avatar and name, in the order they joined, and says which is you", () => {
    renderView(huddle({ people: [inHuddle(sam), inHuddle(ada), inHuddle(priya)] }));
    expect(tiles().map((tile) => tile.textContent)).toEqual(["Sam Rivera", "Ada Lovelace (you)", "Priya Patel"]);
    for (const tile of tiles()) expect(tile.querySelectorAll("img")).toHaveLength(1);
    expect(screen.queryByRole("img", { name: "Muted" })).not.toBeInTheDocument();
  });

  it("names people as the directory has them now", () => {
    const renamed: DirectoryUser = { id: "sam", name: "Samuel Rivera", bio: null, role: "member", status: "active", avatarUrl: "/users/sam/avatar" };
    render(
      <PeopleContext value={new Map([[renamed.id, renamed]])}>
        <HuddleView huddle={huddle()} room={general} meId="ada" />
      </PeopleContext>,
    );
    expect(tiles()[0]).toHaveTextContent("Samuel Rivera");
  });

  it("marks whoever is muted, you among them", () => {
    renderView(huddle({ muted: true, people: [inHuddle(sam, { muted: true }), inHuddle(ada, { muted: true }), inHuddle(priya)] }));
    const [first, second, third] = tiles();
    expect(within(first!).getByRole("img", { name: "Muted" })).toBeInTheDocument();
    expect(within(second!).getByRole("img", { name: "Muted" })).toBeInTheDocument();
    expect(within(third!).queryByRole("img", { name: "Muted" })).not.toBeInTheDocument();
  });

  it("shows someone's camera in place of their avatar, playing without sound", () => {
    const sams = camera();
    renderView(huddle({ people: [inHuddle(sam, { video: true }), inHuddle(ada), inHuddle(priya, { video: true })], watched: new Map([["sam", sams]]) }));
    const picture = screen.getByLabelText<HTMLVideoElement>("Sam Rivera's camera");
    expect(picture.srcObject).toBe(sams);
    expect(picture).toHaveProperty("muted", true);
    expect(picture).toHaveProperty("autoplay", true);
    expect(picture).toHaveAttribute("playsinline");
    expect(picture).not.toHaveClass("-scale-x-100");
    const [first, second, third] = tiles();
    expect(first).toContainElement(picture);
    expect(first!.querySelector("img")).toBeNull();
    expect(first).toHaveTextContent("Sam Rivera");
    // Your own stays an avatar while your camera's off, and so does a camera this tab isn't shown yet.
    expect(second!.querySelector("video")).toBeNull();
    expect(third!.querySelector("video")).toBeNull();
    expect(third!.querySelectorAll("img")).toHaveLength(1);
  });

  it("shows you your own camera as a mirror would", () => {
    const yours = camera();
    renderView(huddle({ camera: yours }));
    const picture = screen.getByLabelText<HTMLVideoElement>("Your camera");
    expect(picture.srcObject).toBe(yours);
    expect(picture).toHaveClass("-scale-x-100");
    expect(tiles()[1]).toContainElement(picture);
  });

  it("plays a picture the browser kept from playing at the person's next click or key, until it's gone", async () => {
    const { user, rerender } = renderView(huddle({ watched: new Map([["sam", camera()]]) }));
    const picture = screen.getByLabelText<HTMLVideoElement>("Sam Rivera's camera");
    expect(play).not.toHaveBeenCalled();
    await user.click(screen.getByRole("heading", { level: 2 }));
    expect(play.mock.contexts).toEqual([picture]);
    await user.keyboard("a");
    expect(play.mock.contexts).toEqual([picture, picture]);
    rerender(<HuddleView huddle={huddle()} room={general} meId="ada" />);
    expect(picture.srcObject).toBeNull();
    await user.click(screen.getByRole("heading", { level: 2 }));
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("lays the tiles out as large as shows them all in the space it measures, and again as its window changes", () => {
    // jsdom lays nothing out, and gives nothing any padding, so the space is the test's.
    let [width, height] = [1000, 500];
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
    let resized = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    renderView(huddle({ people: [...crowd(3), inHuddle(ada)] }));
    const list = screen.getByRole("list", { name: "In the huddle" });
    // Four people in 1000 by 500: two rows of two, 4 by 3.
    expect(list).toHaveStyle({ gridTemplateColumns: "repeat(2, 325px)" });
    for (const tile of tiles()) expect(tile).toHaveClass("aspect-[4/3]");

    // A phone held upright has them square.
    [width, height] = [296, 500];
    act(() => resized());
    expect(list).toHaveStyle({ gridTemplateColumns: "repeat(2, 142px)" });
    for (const tile of tiles()) expect(tile).toHaveClass("aspect-square");
    vi.unstubAllGlobals();
  });
});

describe("The buttons along the base of a huddle", () => {
  it("mutes the microphone and unmutes it, as the bar's does", async () => {
    const { setMuted, user, rerender } = renderView();
    await user.click(screen.getByRole("button", { name: "Mute microphone" }));
    rerender(<HuddleView huddle={huddle({ muted: true })} room={general} meId="ada" />);
    await user.click(screen.getByRole("button", { name: "Unmute microphone" }));
    expect(setMuted.mock.calls).toEqual([[true], [false]]);
  });

  it("turns the camera on and off, on a phone too", async () => {
    const { setCamera, user, rerender } = renderView();
    const off = screen.getByRole("button", { name: "Turn on camera" });
    expect(off).not.toHaveClass("max-md:hidden");
    await user.click(off);
    rerender(<HuddleView huddle={huddle({ camera: camera() })} room={general} meId="ada" />);
    const on = screen.getByRole("button", { name: "Turn off camera" });
    expect(on).toHaveClass("bg-foreground", "text-background");
    await user.click(on);
    expect(setCamera.mock.calls).toEqual([[true], [false]]);
  });

  it("leaves on Leave, the last of its buttons", async () => {
    const { leave, user } = renderView();
    const buttons = screen.getAllByRole("button");
    expect(buttons.at(-1)).toHaveAccessibleName("Leave");
    await user.click(buttons.at(-1)!);
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
