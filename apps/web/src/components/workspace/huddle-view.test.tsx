import type { DirectoryUser, Room, User } from "@ember/protocol";
import type { HuddlePerson } from "@ember/protocol/huddles";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { showHuddle, showSpeaking, type JoinedHuddle } from "@/lib/huddle-store";
import { HuddleView } from "./huddle-view";

const ada: User = { id: "ada", name: "Ada Lovelace" };
const sam: User = { id: "sam", name: "Sam Rivera" };
const priya: User = { id: "priya", name: "Priya Patel" };
const general: Room = { id: "general", name: "general", kind: "open", icon: null };
const inHuddle = (user: User, changes: Partial<HuddlePerson> = {}): HuddlePerson => ({ user, muted: false, audio: true, video: false, screen: false, ...changes });
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
  open: true,
  ...changes,
});
/** A camera's stream, or a shared screen's, as much of one as a tile reads: jsdom has none. */
const camera = () => ({}) as MediaStream;
const shared = () => ({}) as MediaStream;
const crowd = (count: number) => Array.from({ length: count }, (_, index) => inHuddle({ id: `u${index}`, name: `Person ${index}` }));

/** The huddle this tab is in, opened, with what the huddle's controls were asked. */
function renderView(joined: JoinedHuddle = huddle(), room: Room | null = general) {
  const controls = { leave: vi.fn(), setMuted: vi.fn(), setCamera: vi.fn(), setScreen: vi.fn(), setOpen: vi.fn(), setDevice: vi.fn(), setSmall: vi.fn() };
  act(() => showHuddle(joined, controls));
  const user = userEvent.setup();
  const view = render(<HuddleView huddle={joined} room={room} meId="ada" />);
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

/** Has the huddle measure `space` as its own, which jsdom, laying nothing out, leaves to the test. Answers what tells it that its window changed. */
function measuring(space: { width: number; height: number }) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => space.width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => space.height);
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
  return () => act(() => resized());
}

const opened = () => screen.getByRole("region");
const list = () => screen.getByRole("list", { name: "In the huddle" });
const tiles = () => within(list()).getAllByRole("listitem");
/** The screen the huddle shows large, while it shows one, and the shape of the frame around its picture: how wide it is for its height. */
const stage = () => screen.queryByRole("figure");
const shape = () => parseFloat((stage()!.querySelector("figcaption")!.nextElementSibling as HTMLElement).style.aspectRatio);
const count = () => opened().querySelector("header [aria-live]");

let play: MockInstance<HTMLMediaElement["play"]>;

beforeEach(() => {
  // jsdom plays nothing.
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});

afterEach(() => {
  act(() => showHuddle(null));
  act(() => showSpeaking(new Set()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
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

  it("covers every row of the layout, which has one more on a phone at a page of community settings", () => {
    renderView();
    expect(opened()).toHaveClass("absolute", "inset-0", "row-start-1", "row-end-[-1]");
    expect(opened()).not.toHaveClass("row-span-2");
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

  it("rings whoever is speaking in green, over their picture, which it says for those who can't see it, but nobody who's muted", () => {
    renderView(huddle({ people: [inHuddle(sam), inHuddle(ada), inHuddle(priya, { muted: true })], watched: new Map([["sam", camera()]]) }));
    const ring = (tile: HTMLElement | undefined) => within(tile!).queryByRole("img", { name: "Speaking" });
    for (const tile of tiles()) {
      expect(tile).not.toHaveClass("border-transparent");
      expect(ring(tile)).not.toBeInTheDocument();
    }

    act(() => showSpeaking(new Set(["sam", "priya"])));
    const [first, second, third] = tiles();
    // In the tile's edge's place, and drawn last, so over the camera's picture, where a click goes through it.
    expect(first).toHaveClass("border-transparent");
    expect(ring(first)).toHaveClass("pointer-events-none", "absolute", "inset-0", "border-2", "border-positive");
    expect(first!.lastElementChild).toBe(ring(first));
    expect(first!.querySelector("video")).toBeInTheDocument();
    // Its name stays as it was.
    expect(first).toHaveTextContent(/^Sam Rivera$/);
    expect(second).not.toHaveClass("border-transparent");
    expect(ring(second)).not.toBeInTheDocument();
    // Whatever was heard of Priya as she muted.
    expect(third).not.toHaveClass("border-transparent");
    expect(ring(third)).not.toBeInTheDocument();

    act(() => showSpeaking(new Set(["ada"])));
    expect(tiles().map((tile) => [tile.classList.contains("border-transparent"), ring(tile) !== null])).toEqual([
      [false, false],
      [true, true],
      [false, false],
    ]);
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
    const space = { width: 1000, height: 500 };
    const resized = measuring(space);
    renderView(huddle({ people: [...crowd(3), inHuddle(ada)] }));
    // Four people in 1000 by 500: two rows of two, 4 by 3.
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(2, 325px)" });
    for (const tile of tiles()) expect(tile).toHaveClass("aspect-[4/3]");

    // A phone held upright has them square.
    Object.assign(space, { width: 296, height: 500 });
    resized();
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(2, 142px)" });
    for (const tile of tiles()) expect(tile).toHaveClass("aspect-square");
  });

  it("tells the huddle once its tiles are no taller than the smaller of a camera's sizes, and once they're taller again", () => {
    const space = { width: 1200, height: 700 };
    const resized = measuring(space);
    const { setSmall, rerender } = renderView(huddle({ people: [...crowd(3), inHuddle(ada)] }));
    // Four people in 1200 by 700: tiles as wide as they get, 315px tall.
    expect(setSmall.mock.calls).toEqual([[false]]);

    // Twenty: five to a row, 221px wide and 165px tall, which the smaller size fills.
    rerender(<HuddleView huddle={huddle({ people: [...crowd(19), inHuddle(ada)] })} room={general} meId="ada" />);
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(5, 221px)" });
    expect(setSmall.mock.calls).toEqual([[false], [true]]);

    // In a window twice as tall they're four to a row, and 218px tall.
    Object.assign(space, { width: 1200, height: 1400 });
    resized();
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(4, 291px)" });
    expect(setSmall.mock.calls).toEqual([[false], [true], [false]]);
  });

  it("says nothing of its tiles' size before it has measured them, and tells the next huddle the tab joins from it", () => {
    const { setSmall, unmount } = renderView();
    expect(setSmall).not.toHaveBeenCalled();
    unmount();

    measuring({ width: 1200, height: 700 });
    const { rerender } = render(<HuddleView huddle={huddle()} room={general} meId="ada" />);
    expect(setSmall.mock.calls).toEqual([[false]]);
    rerender(<HuddleView huddle={huddle({ roomId: "random" })} room={general} meId="ada" />);
    expect(setSmall.mock.calls).toEqual([[false], [false]]);
  });

  it("says nothing of its tiles' size either while the room has yet to say who's in the huddle, when it has no tiles", () => {
    measuring({ width: 1200, height: 700 });
    const { setSmall, rerender } = renderView(huddle({ connected: false, you: null, people: [] }));
    expect(setSmall).not.toHaveBeenCalled();
    rerender(<HuddleView huddle={huddle()} room={general} meId="ada" />);
    expect(setSmall.mock.calls).toEqual([[false]]);
  });
});

describe("A screen shared in a huddle", () => {
  const sharing = (changes: Partial<JoinedHuddle> = {}) => huddle({ people: [inHuddle(sam, { screen: true }), inHuddle(ada), inHuddle(priya, { screen: true })], ...changes });

  it("shows someone else's large, all of it, in the shape of most screens, under whose it is, and everyone's tiles in a strip beside it", () => {
    measuring({ width: 866, height: 560 });
    const sams = shared();
    renderView(sharing({ screens: new Map([["sam", sams]]) }));
    const picture = within(stage()!).getByLabelText<HTMLVideoElement>("Sam Rivera's screen");
    expect(picture.srcObject).toBe(sams);
    expect(picture).toHaveProperty("muted", true);
    expect(picture).toHaveClass("object-contain");
    expect(picture).not.toHaveClass("-scale-x-100");
    expect(stage()!.querySelector("figcaption")).toHaveTextContent("Sam Rivera's screen");
    // As wide as the strip leaves it, and in the middle with the strip.
    expect(stage()).toHaveStyle({ width: "664px" });
    expect(stage()).toHaveClass("my-auto", "ml-auto");
    expect(shape()).toBe(16 / 9);
    // A screen that's shared and that the tab has yet to be offered, as Priya's, shows nowhere.
    expect(tiles().map((tile) => tile.textContent)).toEqual(["Sam Rivera", "Ada Lovelace (you)", "Priya Patel"]);
    // The strip is as wide as shows its three tiles one above another, and scrolls by itself, in rows as tall as its tiles.
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(1, minmax(0, 190px))" });
    expect(list()).toHaveClass("my-auto", "mr-auto", "max-h-full", "auto-rows-max", "overflow-y-auto");
    // A list kept from shrinking would grow by the width of a scrollbar that takes room, past the window's edge.
    expect(list()).not.toHaveClass("shrink-0");
    expect(list().parentElement).not.toHaveClass("flex-col", "overflow-auto");
    for (const tile of tiles()) expect(tile).toHaveClass("aspect-[4/3]");
  });

  it("tells the huddle that the tiles in the strip beside a screen are small, which are no taller than the smaller of a camera's sizes", () => {
    measuring({ width: 1400, height: 800 });
    const { setSmall } = renderView(huddle({ people: [inHuddle(sam, { screen: true }), inHuddle(ada)], screens: new Map([["sam", shared()]]) }));
    // Two tiles as wide as the strip's get, 220px, are 165px tall.
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(1, minmax(0, 220px))" });
    expect(setSmall.mock.calls).toEqual([[true]]);
  });

  it("has the tiles under the screen where that shows it larger than beside them, as on a phone held upright, laid out in what it leaves them", () => {
    const space = { width: 866, height: 560 };
    const resized = measuring(space);
    renderView(sharing({ screens: new Map([["sam", shared()]]) }));
    expect(list().parentElement).not.toHaveClass("flex-col");

    Object.assign(space, { width: 366, height: 690 });
    resized();
    // The screen is as wide as the phone, and the tiles under it are two to a row, square, as a phone's are by themselves.
    expect(list().parentElement).toHaveClass("flex-col");
    expect(stage()).toHaveStyle({ width: "366px" });
    expect(stage()).toHaveClass("mx-auto");
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(2, minmax(0, 177px))" });
    expect(list()).toHaveClass("flex-1", "auto-rows-max", "overflow-y-auto");
    for (const tile of tiles()) expect(tile).toHaveClass("aspect-square");
  });

  it("gives the screen its picture's own shape once the browser knows it, and whenever that changes, and the next it shows large the shape of most until its own is known", async () => {
    measuring({ width: 866, height: 560 });
    const both = new Map([
      ["sam", shared()],
      ["priya", shared()],
    ]);
    const { user } = renderView(sharing({ screens: both }));
    /** Has the browser say the size of the picture that shows large, as it does at its first frame, or when a later frame's is another. */
    const sized = (width: number, height: number, said: "loadedmetadata" | "resize") => {
      const picture = stage()!.querySelector("video")!;
      Object.defineProperties(picture, { videoWidth: { value: width, configurable: true }, videoHeight: { value: height, configurable: true } });
      fireEvent(picture, new Event(said));
    };
    expect(stage()).toHaveStyle({ width: "680px" });
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(1, minmax(0, 174px))" });
    // A window that's taller than it's wide shows as tall as the huddle has room for, under its caption, which leaves the tiles room for two to a row.
    sized(800, 1000, "loadedmetadata");
    expect(shape()).toBe(0.8);
    expect(stage()).toHaveStyle({ width: "425px" });
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(2, minmax(0, 208px))" });
    // Its person makes it wider.
    sized(1600, 1000, "resize");
    expect(shape()).toBe(1.6);
    expect(stage()).toHaveStyle({ width: "680px" });
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(1, minmax(0, 174px))" });
    // A picture with no size yet says nothing of its shape.
    sized(0, 0, "resize");
    expect(shape()).toBe(1.6);

    await user.click(screen.getByRole("button", { name: "Show Priya Patel's screen larger" }));
    expect(shape()).toBe(16 / 9);
  });

  it("shows a second among the tiles, first of them, which a click shows large in place of the other for as long as it's shared", async () => {
    const [sams, priyas] = [shared(), shared()];
    const both = new Map([
      ["sam", sams],
      ["priya", priyas],
    ]);
    const { user, rerender } = renderView(sharing({ screens: both }));
    // Whoever joined first shows large.
    expect(within(stage()!).getByLabelText<HTMLVideoElement>("Sam Rivera's screen").srcObject).toBe(sams);
    expect(tiles().map((tile) => tile.textContent)).toEqual(["Priya Patel's screen", "Sam Rivera", "Ada Lovelace (you)", "Priya Patel"]);
    const small = within(tiles()[0]!).getByLabelText<HTMLVideoElement>("Priya Patel's screen");
    expect(small.srcObject).toBe(priyas);
    expect(small).toHaveClass("object-contain");

    await user.click(within(tiles()[0]!).getByRole("button", { name: "Show Priya Patel's screen larger" }));
    expect(within(stage()!).getByLabelText<HTMLVideoElement>("Priya Patel's screen").srcObject).toBe(priyas);
    expect(tiles().map((tile) => tile.textContent)).toEqual(["Sam Rivera's screen", "Sam Rivera", "Ada Lovelace (you)", "Priya Patel"]);
    expect(within(tiles()[0]!).getByRole("button", { name: "Show Sam Rivera's screen larger" })).toBeInTheDocument();

    // Once hers is no longer shared, his shows large again, and the tiles are people only.
    rerender(<HuddleView huddle={sharing({ screens: new Map([["sam", sams]]) })} room={general} meId="ada" />);
    expect(within(stage()!).getByLabelText<HTMLVideoElement>("Sam Rivera's screen").srcObject).toBe(sams);
    expect(tiles()).toHaveLength(3);
    // And with none shared, it's the tiles as they were, as large as shows them all.
    rerender(<HuddleView huddle={sharing()} room={general} meId="ada" />);
    expect(stage()).not.toBeInTheDocument();
    expect(list()).toHaveClass("m-auto");
    expect(list().parentElement).toHaveClass("overflow-auto");
  });

  it("shows you your own among the tiles, first of them and never large, as the others see it", () => {
    const space = { width: 1000, height: 500 };
    measuring(space);
    const [yours, sams] = [shared(), shared()];
    const { rerender } = renderView();
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(2, 420px)" });
    rerender(<HuddleView huddle={huddle({ screen: yours })} room={general} meId="ada" />);
    expect(stage()).not.toBeInTheDocument();
    expect(tiles().map((tile) => tile.textContent)).toEqual(["Your screen", "Sam Rivera", "Ada Lovelace (you)"]);
    const picture = within(tiles()[0]!).getByLabelText<HTMLVideoElement>("Your screen");
    expect(picture.srcObject).toBe(yours);
    expect(picture).toHaveClass("object-contain");
    expect(picture).not.toHaveClass("-scale-x-100");
    expect(within(tiles()[0]!).queryByRole("button")).not.toBeInTheDocument();
    // It's a tile like the others, so the two people's are laid out as three: two rows in 1000 by 500, where they had one.
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(2, 325px)" });

    // Beside someone else's, which shows large, it's first in the strip, which is as wide as shows the three.
    rerender(<HuddleView huddle={huddle({ screen: yours, people: [inHuddle(sam, { screen: true }), inHuddle(ada)], screens: new Map([["sam", sams]]) })} room={general} meId="ada" />);
    expect(within(stage()!).getByLabelText<HTMLVideoElement>("Sam Rivera's screen").srcObject).toBe(sams);
    expect(tiles().map((tile) => tile.textContent)).toEqual(["Your screen", "Sam Rivera", "Ada Lovelace (you)"]);
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(1, minmax(0, 211px))" });
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

  it("has no camera button while an administrator has cameras off, but to turn off a camera that's on still", async () => {
    const { setCamera, user, rerender } = renderView();
    rerender(
      <CamerasOff>
        <HuddleView huddle={huddle()} room={general} meId="ada" />
      </CamerasOff>,
    );
    expect(screen.queryByRole("button", { name: /camera/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mute microphone" })).toBeInTheDocument();
    rerender(
      <CamerasOff>
        <HuddleView huddle={huddle({ camera: camera() })} room={general} meId="ada" />
      </CamerasOff>,
    );
    await user.click(screen.getByRole("button", { name: "Turn off camera" }));
    expect(setCamera.mock.calls).toEqual([[false]]);
  });

  it("has an arrow beside the microphone and one beside the camera, on a computer, each of a piece with its button and lit as it is, which opens the menu of its devices", async () => {
    Object.defineProperty(navigator, "mediaDevices", { value: Object.assign(new EventTarget(), { enumerateDevices: async () => [] }), configurable: true });
    const { user } = renderView();
    const [microphones, cameras] = [screen.getByRole("button", { name: "Microphone and speaker" }), screen.getByRole("button", { name: "Camera" })];
    for (const arrow of [microphones, cameras]) expect(arrow).toHaveClass("max-md:hidden", "rounded-l-none");
    for (const name of ["Mute microphone", "Turn on camera"]) expect(screen.getByRole("button", { name })).toHaveClass("md:rounded-r-none");
    expect(microphones).toHaveClass("bg-foreground", "text-background");
    expect(cameras).toHaveClass("bg-hover");

    await user.click(cameras);
    expect(await screen.findByRole("menu")).toHaveAccessibleName("Camera");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await user.click(microphones);
    expect(await screen.findByRole("menu")).toHaveAccessibleName("Microphone and speaker");
  });

  it("has no arrow beside the camera while an administrator has cameras off, who leaves none to choose", () => {
    const { rerender } = renderView();
    rerender(
      <CamerasOff>
        <HuddleView huddle={huddle({ camera: camera() })} room={general} meId="ada" />
      </CamerasOff>,
    );
    expect(screen.getByRole("button", { name: "Turn off camera" })).not.toHaveClass("md:rounded-r-none");
    expect(screen.queryByRole("button", { name: "Camera" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Microphone and speaker" })).toBeInTheDocument();
  });

  it("keeps its camera button under a workspace that says nothing of cameras, as one told of by an older Worker does", () => {
    function Unsaid({ children }: { children: ReactNode }) {
      return <AccountContext value={{ ...useAccount(), huddleCameras: undefined as unknown as boolean }}>{children}</AccountContext>;
    }
    const { rerender } = renderView();
    rerender(
      <Unsaid>
        <HuddleView huddle={huddle()} room={general} meId="ada" />
      </Unsaid>,
    );
    expect(screen.getByRole("button", { name: "Turn on camera" })).toBeInTheDocument();
  });

  it("shares the screen and stops sharing it, in a browser that can share one", async () => {
    browserSharesScreens();
    const { setScreen, user, rerender } = renderView();
    await user.click(screen.getByRole("button", { name: "Share screen" }));
    rerender(<HuddleView huddle={huddle({ screen: shared() })} room={general} meId="ada" />);
    const stop = screen.getByRole("button", { name: "Stop sharing screen" });
    expect(stop).toHaveClass("bg-foreground", "text-background");
    await user.click(stop);
    expect(setScreen.mock.calls).toEqual([[true], [false]]);
  });

  it("has no button to share a screen in a browser that can't, as a phone's, nor while an administrator has screen sharing off, but to stop one that's shared still", async () => {
    const { setScreen, user, rerender } = renderView();
    expect(screen.queryByRole("button", { name: /screen/ })).not.toBeInTheDocument();
    browserSharesScreens();
    rerender(
      <ScreensOff>
        <HuddleView huddle={huddle()} room={general} meId="ada" />
      </ScreensOff>,
    );
    expect(screen.queryByRole("button", { name: /screen/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn on camera" })).toBeInTheDocument();
    rerender(
      <ScreensOff>
        <HuddleView huddle={huddle({ screen: shared() })} room={general} meId="ada" />
      </ScreensOff>,
    );
    await user.click(screen.getByRole("button", { name: "Stop sharing screen" }));
    expect(setScreen.mock.calls).toEqual([[false]]);
  });

  it("keeps its button to share a screen under a workspace that says nothing of screen sharing, as one told of by an older Worker does", () => {
    function Unsaid({ children }: { children: ReactNode }) {
      return <AccountContext value={{ ...useAccount(), huddleScreens: undefined as unknown as boolean }}>{children}</AccountContext>;
    }
    browserSharesScreens();
    const { rerender } = renderView();
    rerender(
      <Unsaid>
        <HuddleView huddle={huddle()} room={general} meId="ada" />
      </Unsaid>,
    );
    expect(screen.getByRole("button", { name: "Share screen" })).toBeInTheDocument();
  });

  it("leaves on Leave, the last of its buttons", async () => {
    const { leave, user } = renderView();
    const buttons = screen.getAllByRole("button");
    expect(buttons.at(-1)).toHaveAccessibleName("Leave");
    await user.click(buttons.at(-1)!);
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
