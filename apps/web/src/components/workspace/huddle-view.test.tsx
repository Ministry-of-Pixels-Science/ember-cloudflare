import type { DirectoryUser, DirectRoom, Me, Room, ServerFrame, User } from "@ember/protocol";
import type { HuddlePerson } from "@ember/protocol/huddles";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { FlashProvider } from "@/components/flash";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { showHuddle, showSpeaking, type JoinedHuddle } from "@/lib/huddle-store";
import { HuddleView } from "./huddle-view";

const ada: User = { id: "ada", name: "Ada Lovelace" };
/** Ada as the app has her once she's signed in. */
const me: Me = { ...ada, administrator: false };
const sam: User = { id: "sam", name: "Sam Rivera" };
const priya: User = { id: "priya", name: "Priya Patel" };
const general: Room = { id: "general", name: "general", kind: "open", icon: null };
/** Ada's direct message with Sam and Priya. */
const direct: DirectRoom = { id: "direct-1", kind: "direct", members: [ada, sam, priya], activeAt: "2026-11-16T09:00:00.000Z" };
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
  thread: true,
  ...changes,
});
/** A camera's stream, as much of one as a tile reads, which is the way it faces, where the browser says: jsdom has none. */
const camera = (facingMode?: string) => ({ getVideoTracks: () => [{ getSettings: () => ({ facingMode }) }] }) as unknown as MediaStream;
/** And a shared screen's, of which it reads nothing. */
const shared = () => ({}) as MediaStream;
const crowd = (count: number) => Array.from({ length: count }, (_, index) => inHuddle({ id: `u${index}`, name: `Person ${index}` }));
/** Hears that the session has ended, which none here does. */
const failed = vi.fn();

/** The huddle this tab is in, opened, with what the huddle's controls were asked. */
function renderView(joined: JoinedHuddle = huddle(), room: Room | null = general) {
  const controls = { leave: vi.fn(), setMuted: vi.fn(), setCamera: vi.fn(), setScreen: vi.fn(), setOpen: vi.fn(), setThread: vi.fn(), setDevice: vi.fn(), setSmall: vi.fn(), switchCamera: vi.fn(), invite: vi.fn(() => true) };
  act(() => showHuddle(joined, controls));
  const user = userEvent.setup();
  const view = render(<HuddleView huddle={joined} room={room} me={me} onFailed={failed} />, { wrapper: FlashProvider });
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

/** Has the browser list `count` cameras. Answers what has it list another number, and tell the page that its devices changed. */
function browserCameras(count: number) {
  let listed = count;
  const enumerateDevices = async () => Array.from({ length: listed }, (_, index) => ({ kind: "videoinput", deviceId: `camera-${index}`, label: "" }));
  const media = Object.assign(new EventTarget(), { enumerateDevices });
  Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
  return async (now: number) => {
    listed = now;
    await act(async () => void media.dispatchEvent(new Event("devicechange")));
  };
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
/** The buttons along its base, first to last: its own base's, and not those under what's written in its thread. */
const tools = () => within(opened().querySelector(":scope > footer")!).getAllByRole("button");
const inviteDialog = () => screen.findByRole("dialog", { name: "Invite people" });

/** Stands in for the browser's WebSocket: the socket the huddle's thread has to its room, which the test plays the room on. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  /** The room lets the socket in, as Ada. */
  letIn() {
    const welcome: ServerFrame = { type: "welcome", you: ada, messages: [], present: [ada], hasMore: false, hasNewer: false, around: null, seq: 0 };
    act(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.(new Event("open"));
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(welcome) }));
    });
  }
}

/**
 * Has the window be narrower than the huddle shows its thread beside its people in, or as wide. Answers
 * what makes it so from then on, telling the page that it changed.
 */
function windowNarrow(narrow: boolean) {
  let matches = narrow;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    get matches() {
      return media === "(width < 73.75rem)" && matches;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return (now: boolean) =>
    act(() => {
      matches = now;
      listeners.forEach((listener) => listener());
    });
}

const thread = () => screen.queryByRole("complementary", { name: "Huddle thread" });
const threadTool = () => screen.queryByRole("button", { name: "Thread" });

/** The page is hidden, as when its person goes to another app on a phone, or shows again. */
const pageShows = (state: DocumentVisibilityState) => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
};

let play: MockInstance<HTMLMediaElement["play"]>;

beforeEach(() => {
  // jsdom plays nothing.
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});

afterEach(() => {
  act(() => showHuddle(null));
  act(() => showSpeaking(new Set()));
  failed.mockClear();
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
    rerender(<HuddleView huddle={huddle({ people: [inHuddle(ada)] })} room={general} me={me} onFailed={failed} />);
    expect(count()).toHaveTextContent("1 person");
  });

  it("says that it's connecting until the room lets the tab in, and reconnecting while its connection is down", () => {
    const { rerender } = renderView(huddle({ connected: false, you: null, people: [] }));
    expect(count()).toHaveTextContent("Connecting…");
    rerender(<HuddleView huddle={huddle({ connected: false })} room={general} me={me} onFailed={failed} />);
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
        <HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />
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

  it("shows you a camera that faces away from you, as a phone's back camera does, as it is, and one that faces you as a mirror would", () => {
    const { rerender } = renderView(huddle({ camera: camera("environment") }));
    expect(screen.getByLabelText("Your camera")).not.toHaveClass("-scale-x-100");
    rerender(<HuddleView huddle={huddle({ camera: camera("user") })} room={general} me={me} onFailed={failed} />);
    expect(screen.getByLabelText("Your camera")).toHaveClass("-scale-x-100");
    // Someone else's is as it is whichever way it faces.
    rerender(<HuddleView huddle={huddle({ watched: new Map([["sam", camera("user")]]) })} room={general} me={me} onFailed={failed} />);
    expect(screen.getByLabelText("Sam Rivera's camera")).not.toHaveClass("-scale-x-100");
  });

  it("plays a picture the browser kept from playing at the person's next click or key, until it's gone", async () => {
    const { user, rerender } = renderView(huddle({ watched: new Map([["sam", camera()]]) }));
    const picture = screen.getByLabelText<HTMLVideoElement>("Sam Rivera's camera");
    expect(play).not.toHaveBeenCalled();
    await user.click(screen.getByRole("heading", { level: 2 }));
    expect(play.mock.contexts).toEqual([picture]);
    await user.keyboard("a");
    expect(play.mock.contexts).toEqual([picture, picture]);
    rerender(<HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />);
    expect(picture.srcObject).toBeNull();
    await user.click(screen.getByRole("heading", { level: 2 }));
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("plays a picture the browser stopped while the page was hidden as the page shows again, and none that plays still, until it's gone", () => {
    const { rerender } = renderView(huddle({ camera: camera("user"), watched: new Map([["sam", camera()]]) }));
    const [yours, sams] = [screen.getByLabelText<HTMLVideoElement>("Your camera"), screen.getByLabelText<HTMLVideoElement>("Sam Rivera's camera")];
    vi.spyOn(yours, "paused", "get").mockReturnValue(false);
    pageShows("hidden");
    expect(play).not.toHaveBeenCalled();
    pageShows("visible");
    expect(play.mock.contexts).toEqual([sams]);

    rerender(<HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />);
    pageShows("visible");
    expect(play).toHaveBeenCalledTimes(1);
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
    rerender(<HuddleView huddle={huddle({ people: [...crowd(19), inHuddle(ada)] })} room={general} me={me} onFailed={failed} />);
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
    const { rerender } = render(<HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />);
    expect(setSmall.mock.calls).toEqual([[false]]);
    rerender(<HuddleView huddle={huddle({ roomId: "random" })} room={general} me={me} onFailed={failed} />);
    expect(setSmall.mock.calls).toEqual([[false], [false]]);
  });

  it("says nothing of its tiles' size either while the room has yet to say who's in the huddle, when it has no tiles", () => {
    measuring({ width: 1200, height: 700 });
    const { setSmall, rerender } = renderView(huddle({ connected: false, you: null, people: [] }));
    expect(setSmall).not.toHaveBeenCalled();
    rerender(<HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />);
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
    rerender(<HuddleView huddle={sharing({ screens: new Map([["sam", sams]]) })} room={general} me={me} onFailed={failed} />);
    expect(within(stage()!).getByLabelText<HTMLVideoElement>("Sam Rivera's screen").srcObject).toBe(sams);
    expect(tiles()).toHaveLength(3);
    // And with none shared, it's the tiles as they were, as large as shows them all.
    rerender(<HuddleView huddle={sharing()} room={general} me={me} onFailed={failed} />);
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
    rerender(<HuddleView huddle={huddle({ screen: yours })} room={general} me={me} onFailed={failed} />);
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
    rerender(<HuddleView huddle={huddle({ screen: yours, people: [inHuddle(sam, { screen: true }), inHuddle(ada)], screens: new Map([["sam", sams]]) })} room={general} me={me} onFailed={failed} />);
    expect(within(stage()!).getByLabelText<HTMLVideoElement>("Sam Rivera's screen").srcObject).toBe(sams);
    expect(tiles().map((tile) => tile.textContent)).toEqual(["Your screen", "Sam Rivera", "Ada Lovelace (you)"]);
    expect(list()).toHaveStyle({ gridTemplateColumns: "repeat(1, minmax(0, 211px))" });
  });
});

describe("The buttons along the base of a huddle", () => {
  it("mutes the microphone and unmutes it, as the bar's does", async () => {
    const { setMuted, user, rerender } = renderView();
    await user.click(screen.getByRole("button", { name: "Mute microphone" }));
    rerender(<HuddleView huddle={huddle({ muted: true })} room={general} me={me} onFailed={failed} />);
    await user.click(screen.getByRole("button", { name: "Unmute microphone" }));
    expect(setMuted.mock.calls).toEqual([[true], [false]]);
  });

  it("turns the camera on and off, on a phone too", async () => {
    const { setCamera, user, rerender } = renderView();
    const off = screen.getByRole("button", { name: "Turn on camera" });
    expect(off).not.toHaveClass("max-md:hidden");
    await user.click(off);
    rerender(<HuddleView huddle={huddle({ camera: camera() })} room={general} me={me} onFailed={failed} />);
    const on = screen.getByRole("button", { name: "Turn off camera" });
    expect(on).toHaveClass("bg-foreground", "text-background");
    await user.click(on);
    expect(setCamera.mock.calls).toEqual([[true], [false]]);
  });

  it("has no camera button while an administrator has cameras off, but to turn off a camera that's on still", async () => {
    const { setCamera, user, rerender } = renderView();
    rerender(
      <CamerasOff>
        <HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />
      </CamerasOff>,
    );
    expect(screen.queryByRole("button", { name: /camera/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mute microphone" })).toBeInTheDocument();
    rerender(
      <CamerasOff>
        <HuddleView huddle={huddle({ camera: camera() })} room={general} me={me} onFailed={failed} />
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
        <HuddleView huddle={huddle({ camera: camera() })} room={general} me={me} onFailed={failed} />
      </CamerasOff>,
    );
    expect(screen.getByRole("button", { name: "Turn off camera" })).not.toHaveClass("md:rounded-r-none");
    expect(screen.queryByRole("button", { name: "Camera" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Microphone and speaker" })).toBeInTheDocument();
  });

  it("has a button that switches cameras in the camera's arrow's place, as on a phone, while the camera is on and the browser lists another", async () => {
    browserCameras(2);
    const { switchCamera, user, rerender } = renderView(huddle({ camera: camera() }));
    const button = await screen.findByRole("button", { name: "Switch camera" });
    expect(button).toHaveClass("md:hidden", "bg-hover");
    expect(button).toHaveAttribute("title", "Switch camera");
    expect(screen.getByRole("button", { name: "Camera" })).toHaveClass("max-md:hidden");
    // Right after the camera's own, and its arrow on a computer.
    const names = screen.getAllByRole("button").map((each) => each.getAttribute("aria-label") ?? each.textContent);
    expect(names.slice(names.indexOf("Turn off camera"))).toEqual(["Turn off camera", "Camera", "Switch camera", "More", "Leave"]);

    await user.click(button);
    expect(switchCamera).toHaveBeenCalledExactlyOnceWith();
    // Off, there's none to switch from.
    rerender(<HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />);
    expect(screen.queryByRole("button", { name: "Switch camera" })).not.toBeInTheDocument();
  });

  it("has no button to switch cameras while the browser lists the one, until another is plugged in, nor once that's taken away", async () => {
    const lists = browserCameras(1);
    renderView(huddle({ camera: camera() }));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Switch camera" })).not.toBeInTheDocument();
    await lists(2);
    expect(screen.getByRole("button", { name: "Switch camera" })).toBeInTheDocument();
    await lists(1);
    expect(screen.queryByRole("button", { name: "Switch camera" })).not.toBeInTheDocument();
  });

  it("asks nothing of the browser's cameras while its own is off, and hears no more of them once it's off again", async () => {
    const lists = browserCameras(2);
    const enumerateDevices = vi.spyOn(navigator.mediaDevices, "enumerateDevices");
    const { rerender } = renderView();
    await lists(2);
    expect(enumerateDevices).not.toHaveBeenCalled();
    rerender(<HuddleView huddle={huddle({ camera: camera() })} room={general} me={me} onFailed={failed} />);
    expect(await screen.findByRole("button", { name: "Switch camera" })).toBeInTheDocument();
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    rerender(<HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />);
    await lists(2);
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
  });

  it("has no button to switch cameras while an administrator has cameras off, who leaves none to choose", async () => {
    browserCameras(2);
    const { rerender } = renderView();
    rerender(
      <CamerasOff>
        <HuddleView huddle={huddle({ camera: camera() })} room={general} me={me} onFailed={failed} />
      </CamerasOff>,
    );
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Turn off camera" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch camera" })).not.toBeInTheDocument();
  });

  it("keeps its camera button under a workspace that says nothing of cameras, as one told of by an older Worker does", () => {
    function Unsaid({ children }: { children: ReactNode }) {
      return <AccountContext value={{ ...useAccount(), huddleCameras: undefined as unknown as boolean }}>{children}</AccountContext>;
    }
    const { rerender } = renderView();
    rerender(
      <Unsaid>
        <HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />
      </Unsaid>,
    );
    expect(screen.getByRole("button", { name: "Turn on camera" })).toBeInTheDocument();
  });

  it("shares the screen and stops sharing it, in a browser that can share one", async () => {
    browserSharesScreens();
    const { setScreen, user, rerender } = renderView();
    await user.click(screen.getByRole("button", { name: "Share screen" }));
    rerender(<HuddleView huddle={huddle({ screen: shared() })} room={general} me={me} onFailed={failed} />);
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
        <HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />
      </ScreensOff>,
    );
    expect(screen.queryByRole("button", { name: /screen/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn on camera" })).toBeInTheDocument();
    rerender(
      <ScreensOff>
        <HuddleView huddle={huddle({ screen: shared() })} room={general} me={me} onFailed={failed} />
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
        <HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />
      </Unsaid>,
    );
    expect(screen.getByRole("button", { name: "Share screen" })).toBeInTheDocument();
  });

  it("has Invite people first, on a computer, which opens the list of the room's people to invite, and has the focus back once that closes", async () => {
    const { invite, user } = renderView(huddle({ roomId: "direct-1" }), direct);
    const button = screen.getByRole("button", { name: "Invite people" });
    expect(tools()[0]).toBe(button);
    expect(button).toHaveAttribute("title", "Invite people");
    expect(button).toHaveClass("bg-hover");
    expect(button.parentElement).toHaveClass("max-md:hidden");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(button);
    const dialog = await inviteDialog();
    // Sam is in the huddle, which leaves Priya to invite.
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(dialog).getByRole("checkbox", { name: "Priya Patel" })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Send Invite" }));
    expect(invite).toHaveBeenCalledExactlyOnceWith(["priya"]);
    expect(dialog).not.toBeInTheDocument();
    await waitFor(() => expect(button).toHaveFocus());
    expect(screen.getByRole("alert")).toHaveTextContent("Priya is invited.");
  });

  it("has More last before Leave, on a phone, whose menu has Invite people, which opens the list once the menu has shut, and has the focus back once that closes", async () => {
    const { invite, user } = renderView(huddle({ roomId: "direct-1" }), direct);
    const more = screen.getByRole("button", { name: "More" });
    expect(tools().at(-2)).toBe(more);
    expect(more).toHaveAttribute("title", "More");
    expect(more).toHaveClass("md:hidden", "bg-hover");

    await user.click(more);
    const choices = within(await screen.findByRole("menu")).getAllByRole("menuitem");
    expect(choices.map((choice) => choice.textContent)).toEqual(["Invite people"]);
    const focused: EventTarget[] = [];
    const note = (event: FocusEvent) => void focused.push(event.target!);
    document.addEventListener("focusin", note);
    await user.click(choices[0]!);
    const dialog = await inviteDialog();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const title = within(dialog).getByRole("heading", { name: "Invite people" });
    await waitFor(() => expect(title).toHaveFocus());

    await user.keyboard("{Escape}");
    expect(dialog).not.toBeInTheDocument();
    await waitFor(() => expect(more).toHaveFocus());
    // The focus went from the menu straight to the list, which kept it until it closed.
    expect(focused).toEqual([choices[0], title, more]);
    document.removeEventListener("focusin", note);
    expect(invite).not.toHaveBeenCalled();
    // Neither the menu nor the list is left holding the page.
    expect(document.body.style.pointerEvents).toBe("");
    // And the menu opens the list again.
    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "Invite people" }));
    expect(await inviteDialog()).toBeInTheDocument();
  });

  it("leaves the focus on More when its menu shuts with nothing chosen, and opens no list, whether or not it has opened the list before", async () => {
    const { user } = renderView(huddle({ roomId: "direct-1" }), direct);
    const more = screen.getByRole("button", { name: "More" });
    const shutMenu = async () => {
      await user.click(more);
      await screen.findByRole("menu");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      await waitFor(() => expect(more).toHaveFocus());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    };
    await shutMenu();

    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "Invite people" }));
    await inviteDialog();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(more).toHaveFocus());
    await shutMenu();
  });

  it("lists a shared room's people as its settings have them, and reports a session that's ended when that's why they didn't come", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ room: general, canAdminister: false, people: [ada, sam, priya].map((person) => ({ ...person, member: true })) }),
    );
    const { user } = renderView();
    await user.click(screen.getByRole("button", { name: "Invite people" }));
    expect(await within(await inviteDialog()).findByRole("checkbox", { name: "Priya Patel" })).toBeInTheDocument();
    expect(fetched).toHaveBeenCalledExactlyOnceWith("/api/rooms/general/settings", expect.anything());
    expect(failed).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    fetched.mockImplementation(async () => Response.json({ error: "Sign in to continue" }, { status: 401 }));
    await user.click(screen.getByRole("button", { name: "Invite people" }));
    await waitFor(() => expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401 })));
  });

  it("has neither Invite people nor More once its room isn't among this person's, which leaves nobody to list", () => {
    renderView(huddle(), null);
    expect(screen.queryByRole("button", { name: "Invite people" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    expect(tools().map((tool) => tool.getAttribute("aria-label") ?? tool.textContent)).toEqual(["Mute microphone", "Microphone and speaker", "Turn on camera", "Camera", "Leave"]);
  });

  it("leaves on Leave, the last of its buttons", async () => {
    const { leave, user } = renderView();
    const buttons = screen.getAllByRole("button");
    expect(buttons.at(-1)).toHaveAccessibleName("Leave");
    await user.click(buttons.at(-1)!);
    expect(leave).toHaveBeenCalledTimes(1);
  });
});

describe("The thread of a huddle", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  it("shows beside the people in the huddle, once the room has said which message is the huddle's, over a socket of its own to the huddle's room", () => {
    renderView(huddle({ roomId: "direct-1", messageId: "h1" }), direct);
    // In a row with the tiles, between the huddle's header and its buttons.
    expect(thread()!.parentElement).toBe(list().parentElement!.parentElement);
    expect(thread()!.parentElement).toHaveClass("flex");
    expect(thread()!.previousElementSibling).toBe(list().parentElement);
    expect(thread()!.parentElement!.previousElementSibling).toBe(opened().querySelector(":scope > header"));
    expect(thread()!.parentElement!.nextElementSibling).toBe(opened().querySelector(":scope > footer"));

    expect(FakeSocket.all.map(({ url }) => url)).toEqual(["ws://localhost:3000/api/rooms/direct-1/socket?visible=1&protocol=4&apart=1"]);
    FakeSocket.all[0]!.letIn();
    expect(FakeSocket.all[0]!.sent).toEqual([{ type: "thread.open", parentId: "h1" }]);
  });

  it("has Thread among its buttons, after the screen's and before More, lit while the thread shows", () => {
    browserSharesScreens();
    renderView(huddle({ messageId: "h1" }));
    expect(tools().map((tool) => tool.getAttribute("aria-label") ?? tool.textContent)).toEqual([
      "Invite people",
      "Mute microphone",
      "Microphone and speaker",
      "Turn on camera",
      "Camera",
      "Share screen",
      "Thread",
      "More",
      "Leave",
    ]);
    expect(threadTool()).toHaveAttribute("title", "Thread");
    expect(threadTool()).toHaveAttribute("aria-pressed", "true");
    expect(threadTool()).toHaveClass("bg-foreground", "text-background");
  });

  it("closes from Close thread, which leaves the focus on Thread, and from Thread, which shows it again", async () => {
    const { setThread, user, rerender } = renderView(huddle({ messageId: "h1" }));
    await user.click(within(thread()!).getByRole("button", { name: "Close thread" }));
    expect(setThread).toHaveBeenCalledExactlyOnceWith(false);
    expect(threadTool()).toHaveFocus();
    await user.click(threadTool()!);
    expect(setThread).toHaveBeenCalledTimes(2);
    expect(setThread).toHaveBeenLastCalledWith(false);

    // Closed, it's gone with its socket, and Thread is as the huddle's other buttons that are off.
    rerender(<HuddleView huddle={huddle({ messageId: "h1", thread: false })} room={general} me={me} onFailed={failed} />);
    expect(thread()).not.toBeInTheDocument();
    expect(FakeSocket.all.map(({ readyState }) => readyState)).toEqual([FakeSocket.CLOSED]);
    expect(threadTool()).toHaveAttribute("aria-pressed", "false");
    expect(threadTool()).toHaveClass("bg-hover", "text-foreground");
    await user.click(threadTool()!);
    expect(setThread).toHaveBeenLastCalledWith(true);

    rerender(<HuddleView huddle={huddle({ messageId: "h1" })} room={general} me={me} onFailed={failed} />);
    expect(thread()).toBeInTheDocument();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("leaves the focus on the huddle, which took it as it opened, where the thread shows with it, and puts it in the thread's composer where its person asks for the thread", async () => {
    // The room says which message is the huddle's a moment after the huddle has opened.
    const { user, rerender } = renderView(huddle());
    expect(opened()).toHaveFocus();
    rerender(<HuddleView huddle={huddle({ messageId: "h1" })} room={general} me={me} onFailed={failed} />);
    await within(thread()!).findByRole("textbox", { name: "Write a reply" });
    expect(opened()).toHaveFocus();

    // Closed, and shown again from Thread, it's there to write in.
    rerender(<HuddleView huddle={huddle({ messageId: "h1", thread: false })} room={general} me={me} onFailed={failed} />);
    await user.click(threadTool()!);
    rerender(<HuddleView huddle={huddle({ messageId: "h1" })} room={general} me={me} onFailed={failed} />);
    expect(await within(thread()!).findByRole("textbox", { name: "Write a reply" })).toHaveFocus();
  });

  it("has neither the thread nor Thread until the room has said which message is the huddle's, nor once the huddle's room isn't among this person's", () => {
    const { unmount } = renderView(huddle());
    expect(thread()).not.toBeInTheDocument();
    expect(threadTool()).not.toBeInTheDocument();
    unmount();

    renderView(huddle({ messageId: "h1" }), null);
    expect(thread()).not.toBeInTheDocument();
    expect(threadTool()).not.toBeInTheDocument();
    expect(FakeSocket.all).toEqual([]);
  });

  it("has neither in a window narrower than 1180px, which has no room for the thread beside the people, until it's that wide", () => {
    const narrow = windowNarrow(true);
    renderView(huddle({ messageId: "h1" }));
    expect(thread()).not.toBeInTheDocument();
    expect(threadTool()).not.toBeInTheDocument();
    expect(FakeSocket.all).toEqual([]);

    narrow(false);
    expect(thread()).toBeInTheDocument();
    expect(threadTool()).toBeInTheDocument();
    expect(FakeSocket.all).toHaveLength(1);

    narrow(true);
    expect(thread()).not.toBeInTheDocument();
    expect(threadTool()).not.toBeInTheDocument();
    expect(FakeSocket.all.map(({ readyState }) => readyState)).toEqual([FakeSocket.CLOSED]);
  });

  it("shows another huddle's thread once the room says that another message is the huddle's, as the tab comes back to another huddle than it left", () => {
    const { rerender } = renderView(huddle({ messageId: "h1" }));
    FakeSocket.all[0]!.letIn();
    rerender(<HuddleView huddle={huddle({ messageId: "h2" })} room={general} me={me} onFailed={failed} />);
    expect(FakeSocket.all.map(({ readyState }) => readyState)).toEqual([FakeSocket.CLOSED, FakeSocket.CONNECTING]);
    FakeSocket.all[1]!.letIn();
    expect(FakeSocket.all[1]!.sent).toEqual([{ type: "thread.open", parentId: "h2" }]);
    expect(screen.getAllByRole("complementary", { name: "Huddle thread" })).toHaveLength(1);
  });
});
