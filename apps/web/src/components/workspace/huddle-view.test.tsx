import type { DirectoryUser, DirectRoom, Me, Room, ServerFrame, User } from "@ember/protocol";
import type { HuddlePerson } from "@ember/protocol/huddles";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { FlashProvider } from "@/components/flash";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { NO_REACTIONS } from "@/lib/huddle-reactions";
import { showHuddle, showReactions, showSpeaking, type JoinedHuddle } from "@/lib/huddle-store";
import { HuddleView } from "./huddle-view";

// The emoji picker, without Emojibase's data, which isn't served here: its search, and one emoji to pick.
vi.mock("./emoji-panel", () => ({
  default: ({ onPick, autoFocus = true }: { onPick: (emoji: string) => void; autoFocus?: boolean }) => (
    <>
      <input aria-label="Search all emoji" autoFocus={autoFocus} />
      <button type="button" onClick={() => onPick("🎉")}>
        🎉
      </button>
    </>
  ),
}));

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
  sticker: null,
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
/** And a shared screen's, of which it reads nothing but its picture, which has come. */
const shared = () => ({ getVideoTracks: () => [] }) as unknown as MediaStream;
/** A camera's stream whose first packets have yet to come, and what brings them. */
function cameraToCome(): { stream: MediaStream; come: () => void } {
  const picture = Object.assign(new EventTarget(), { muted: true });
  const come = () => {
    picture.muted = false;
    picture.dispatchEvent(new Event("unmute"));
  };
  return { stream: { getVideoTracks: () => [picture] } as unknown as MediaStream, come };
}
/** What `picture` is given from here on, in turn: nothing, or a stream. jsdom's video keeps what it's given and makes nothing of it. */
function givenTo(picture: HTMLVideoElement): Array<MediaProvider | null> {
  const given: Array<MediaProvider | null> = [];
  let has = picture.srcObject;
  Object.defineProperty(picture, "srcObject", { configurable: true, get: () => has, set: (value: MediaProvider | null) => void given.push((has = value)) });
  return given;
}
const crowd = (count: number) => Array.from({ length: count }, (_, index) => inHuddle({ id: `u${index}`, name: `Person ${index}` }));
/** Hears that the session has ended, which none here does. */
const failed = vi.fn();

/** The huddle this tab is in, opened, with what the huddle's controls were asked. */
function renderView(joined: JoinedHuddle = huddle(), room: Room | null = general) {
  const controls = { leave: vi.fn(), setMuted: vi.fn(), setCamera: vi.fn(), setScreen: vi.fn(), setOpen: vi.fn(), setThread: vi.fn(), setDevice: vi.fn(), setSmall: vi.fn(), switchCamera: vi.fn(), invite: vi.fn(() => true), setSticker: vi.fn(), react: vi.fn() };
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
/** What each of the buttons along its base is called. */
const toolNames = () => tools().map((tool) => tool.getAttribute("aria-label") ?? tool.textContent);
/** The panel React opens, while it's open. */
const reactions = () => screen.queryByRole("dialog", { name: "React" });
/** What's over the people in the huddle: the reactions that rise there, and the pills of the emoji they are, while any does. */
const overPeople = () => list().parentElement!.nextElementSibling as HTMLElement;
const rising = () => [...overPeople().querySelectorAll<HTMLElement>(":scope > [aria-hidden]")];
/** Which of the places along the people's base a reaction rises from, from 0 at the left. */
const placeOf = (reaction: HTMLElement) => reaction.style.getPropertyValue("--place");
const pills = () => screen.queryByRole("list", { name: "Reactions" });

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
  act(() => showReactions(NO_REACTIONS));
  failed.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  it("shows the sticker someone shows in the corner over their name, by its emoji and what it's called, said for whoever can't see it, until they take it off", () => {
    const { rerender } = renderView(huddle({ people: [inHuddle(sam, { sticker: "hand" }), inHuddle(ada), inHuddle(priya, { sticker: "brb" })] }));
    const [first, second, third] = tiles();
    const raised = within(first!).getByTitle("Raise hand");
    expect(raised).toHaveTextContent(/^✋Raise hand$/);
    // Someone else's is nothing to press, and it's the line under it that says it.
    expect(raised.tagName).toBe("SPAN");
    expect(raised).toHaveAttribute("aria-hidden", "true");
    // Over their name, where Slack has it, and no taller for the room around it.
    expect(raised).toHaveClass("absolute", "top-0", "left-0", "items-start", "p-2.5", "max-md:p-1.5");
    expect(raised.firstElementChild).toHaveClass("rounded-full", "bg-surface");
    // A tile too narrow for what it's called has its emoji alone.
    expect(within(raised).getByText("Raise hand")).toHaveClass("truncate", "@max-[11rem]:hidden");
    const said = within(first!).getByText("Sam Rivera: Hand raised");
    expect(said).toHaveAttribute("aria-live", "polite");
    expect(said).toHaveClass("sr-only");
    expect(within(third!).getByTitle("Be right back")).toHaveTextContent(/^☕Be right back$/);
    // Whoever shows none has a tile that says no more than it did.
    expect(second).toHaveTextContent(/^Ada Lovelace \(you\)$/);
    expect(within(second!).queryByTitle(/./)).not.toBeInTheDocument();

    rerender(<HuddleView huddle={huddle({ people: [inHuddle(sam, { sticker: "done" }), inHuddle(ada), inHuddle(priya, { sticker: "thumbs-up" })] })} room={general} me={me} onFailed={failed} />);
    expect(within(first!).getByTitle("Done")).toHaveTextContent(/^✅Done$/);
    expect(within(first!).queryByTitle("Raise hand")).not.toBeInTheDocument();
    // What says it is what said the last, so that it's said as it changes.
    expect(said).toHaveTextContent(/^Sam Rivera: Done$/);
    expect(within(third!).getByTitle("Yes")).toHaveTextContent(/^👍Yes$/);
    expect(within(third!).getByText("Priya Patel: Yes")).toBeInTheDocument();

    rerender(<HuddleView huddle={huddle({ people: [inHuddle(sam), inHuddle(ada), inHuddle(priya)] })} room={general} me={me} onFailed={failed} />);
    expect(first).toHaveTextContent(/^Sam Rivera$/);
    expect(within(first!).queryByTitle(/./)).not.toBeInTheDocument();
  });

  it("has the sticker of the tab's person on their own tile be a button, large enough for a finger, which takes it off", async () => {
    const { setSticker, user } = renderView(huddle({ sticker: "thumbs-down", people: [inHuddle(sam, { sticker: "done" }), inHuddle(ada, { sticker: "thumbs-down" })] }));
    const [first, second] = tiles();
    expect(within(first!).queryByRole("button")).not.toBeInTheDocument();
    const mine = within(second!).getByRole("button", { name: "Remove sticker: No" });
    expect(mine).toHaveAttribute("title", "Remove sticker");
    expect(mine).toHaveTextContent(/^👎No$/);
    expect(mine).toHaveClass("absolute", "top-0", "left-0", "cursor-pointer", "touch:min-h-11", "touch:min-w-11");
    // With the focus it's ringed around the sticker, where the tile's edge would cut a ring around the button.
    expect(mine).toHaveClass("focus-visible:outline-none");
    expect(mine.firstElementChild).toHaveClass("group-hover:bg-hover", "group-focus-visible:outline-2", "group-focus-visible:outline-offset-2");
    expect(within(first!).getByTitle("Done").firstElementChild).not.toHaveClass("group-hover:bg-hover");
    // It's said as everyone's is.
    expect(within(second!).getByText("Ada Lovelace: No")).toHaveClass("sr-only");
    await user.click(mine);
    expect(setSticker).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("has someone's reaction rise over the people in the huddle, from the base of where they are, over their name, said for whoever can't see it, and the same emoji again anew", () => {
    renderView(huddle({ people: [inHuddle(sam, { sticker: "hand" }), inHuddle(ada)] }));
    // Over the people, and a click goes through it to them. What rises there goes by how wide they are.
    expect(overPeople()).toHaveClass("pointer-events-none", "absolute", "inset-0", "@container", "overflow-hidden");
    expect(overPeople().parentElement).toHaveClass("relative");
    expect(overPeople().nextElementSibling).toBeNull();
    expect(rising()).toEqual([]);

    const first = { nth: 1, userId: "sam", emoji: "🎉" };
    act(() => showReactions({ rising: [first], runs: [] }));
    const [risen] = rising();
    expect(risen).toHaveTextContent(/^🎉Sam Rivera$/);
    // Without motion it holds still, at the base. The huddle's first is at the middle of the places there
    // are, which are right of the people's middle, or across more of them where they have less room.
    expect(risen).toHaveClass("absolute", "bottom-3", "-translate-x-1/2", "motion-safe:animate-reaction", "left-[calc(45%+var(--place)*6.25%)]", "@max-2xl:left-[calc(20%+var(--place)*12.5%)]", "@max-md:left-[calc(15%+var(--place)*11.25%)]");
    expect(placeOf(risen!)).toBe("2");
    // Its emoji grows as it rises, from the name under it, which doesn't.
    expect(within(risen!).getByText("🎉")).toHaveClass("origin-bottom", "motion-safe:animate-reaction-emoji");
    expect(within(risen!).getByText("Sam Rivera")).not.toHaveClass("motion-safe:animate-reaction-emoji");
    const said = within(overPeople()).getByText("Sam Rivera reacted with 🎉");
    expect(said.parentElement).toHaveAttribute("aria-live", "polite");
    expect(said.parentElement).toHaveClass("sr-only");
    // No tile has it, and their sticker stays where it was.
    for (const tile of tiles()) expect(within(tile).queryByText("🎉")).not.toBeInTheDocument();
    expect(within(tiles()[0]!).getByTitle("Raise hand")).toBeInTheDocument();

    // The same again is another, apart from it, to rise from the start and be said again.
    act(() => showReactions({ rising: [first, { nth: 2, userId: "sam", emoji: "🎉" }], runs: [] }));
    expect(rising()).toHaveLength(2);
    expect(rising()[0]).toBe(risen);
    expect(placeOf(rising()[1]!)).toBe("0");
    expect(within(overPeople()).getAllByText("Sam Rivera reacted with 🎉")).toEqual([said, expect.anything()]);

    // Your own rises over your name, as everyone's does.
    act(() => showReactions({ rising: [{ nth: 3, userId: "ada", emoji: "👍" }], runs: [] }));
    expect(rising().map((each) => [each.textContent, placeOf(each)])).toEqual([["👍Ada Lovelace", "4"]]);
    expect(within(overPeople()).getByText("Ada Lovelace reacted with 👍")).toBeInTheDocument();
    expect(risen).not.toBeInTheDocument();
    expect(said).not.toBeInTheDocument();

    // Each is apart from the one before it, so that those that rise together aren't over each other, and
    // the sixth is where the first was.
    act(() => showReactions({ rising: [4, 5, 6, 7, 8, 9].map((nth) => ({ nth, userId: "ada", emoji: "👍" })), runs: [] }));
    expect(rising().map(placeOf)).toEqual(["1", "3", "2", "0", "4", "1"]);

    // One of someone who isn't in the huddle shows nothing.
    act(() => showReactions({ rising: [{ nth: 10, userId: "priya", emoji: "👀" }], runs: [{ emoji: "👀", first: "priya", more: 0 }] }));
    expect(overPeople()).toHaveTextContent(/^$/);
    expect(screen.queryByRole("button", { name: /👀/ })).not.toBeInTheDocument();

    act(() => showReactions(NO_REACTIONS));
    expect(overPeople()).toHaveTextContent(/^$/);
  });

  it("has a pill in the corner for each emoji that rises, which says who sent the first and how many have come since, and sends it again", async () => {
    const { react, user } = renderView(huddle({ people: [inHuddle(sam), inHuddle(ada)] }));
    expect(pills()).not.toBeInTheDocument();

    const rise = [
      { nth: 1, userId: "ada", emoji: "🎉" },
      { nth: 2, userId: "sam", emoji: "👍" },
    ];
    act(() =>
      showReactions({
        rising: rise,
        runs: [
          { emoji: "🎉", first: "ada", more: 0 },
          { emoji: "👍", first: "sam", more: 2 },
        ],
      }),
    );
    // In the corner, where a click on them isn't one on the people under them.
    expect(pills()).toHaveClass("pointer-events-auto", "absolute", "right-3", "bottom-3");
    expect(overPeople()).toContainElement(pills());
    const [mine, sams] = within(pills()!).getAllByRole("button");
    expect(mine).toHaveTextContent(/^You🎉$/);
    expect(mine).toHaveAccessibleName("You 🎉: react with 🎉 too");
    expect(mine).toHaveAttribute("title", "React with 🎉 too");
    // 44px for a finger.
    expect(mine).toHaveClass("h-8", "touch:h-11", "touch:min-w-11");
    // Someone else's has their avatar for their name.
    expect(sams).toHaveTextContent(/^\+ 2👍$/);
    expect(sams).toHaveAccessibleName("Sam Rivera + 2 👍: react with 👍 too");
    expect(sams!.querySelector("img")).toHaveClass("size-5");

    await user.click(sams!);
    await user.click(mine!);
    expect(react.mock.calls).toEqual([["👍"], ["🎉"]]);

    // One that's counted again is the pill it was.
    act(() => showReactions({ rising: rise, runs: [{ emoji: "🎉", first: "ada", more: 1 }] }));
    expect(within(pills()!).getAllByRole("button")).toEqual([mine]);
    expect(mine).toHaveTextContent(/^You\+ 1🎉$/);
    expect(mine).toHaveAccessibleName("You + 1 🎉: react with 🎉 too");

    act(() => showReactions(NO_REACTIONS));
    expect(pills()).not.toBeInTheDocument();
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

  it("gives a picture its stream once the stream's first packets come, as WebKit can show nothing of one it's given before", () => {
    const sams = cameraToCome();
    renderView(huddle({ people: [inHuddle(sam, { video: true })], watched: new Map([["sam", sams.stream]]) }));
    const picture = screen.getByLabelText<HTMLVideoElement>("Sam Rivera's camera");
    expect(picture.srcObject).not.toBe(sams.stream);
    sams.come();
    expect(picture.srcObject).toBe(sams.stream);
  });

  it("gives a picture that's gone before its stream's first packets came nothing once they come", () => {
    const sams = cameraToCome();
    const { rerender } = renderView(huddle({ people: [inHuddle(sam, { video: true })], watched: new Map([["sam", sams.stream]]) }));
    const picture = screen.getByLabelText<HTMLVideoElement>("Sam Rivera's camera");
    rerender(<HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />);
    sams.come();
    expect(picture.srcObject).toBeNull();
  });

  it("gives a picture that shows nothing for three seconds its stream again, as WebKit shows it then, three times at most", () => {
    vi.useFakeTimers();
    const sams = camera();
    renderView(huddle({ people: [inHuddle(sam, { video: true })], watched: new Map([["sam", sams]]) }));
    const given = givenTo(screen.getByLabelText<HTMLVideoElement>("Sam Rivera's camera"));
    vi.advanceTimersByTime(2999);
    expect(given).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(given).toEqual([null, sams]);
    vi.advanceTimersByTime(60_000);
    expect(given).toEqual([null, sams, null, sams, null, sams]);
  });

  it("counts those seconds from when a picture is given its stream, which is once the stream's first packets have come", () => {
    vi.useFakeTimers();
    const sams = cameraToCome();
    renderView(huddle({ people: [inHuddle(sam, { video: true })], watched: new Map([["sam", sams.stream]]) }));
    const given = givenTo(screen.getByLabelText<HTMLVideoElement>("Sam Rivera's camera"));
    vi.advanceTimersByTime(60_000);
    expect(given).toEqual([]);
    sams.come();
    vi.advanceTimersByTime(2999);
    expect(given).toEqual([sams.stream]);
    vi.advanceTimersByTime(1);
    expect(given).toEqual([sams.stream, null, sams.stream]);
  });

  it("leaves a picture that shows within those seconds as it is", () => {
    vi.useFakeTimers();
    renderView(huddle({ people: [inHuddle(sam, { video: true })], watched: new Map([["sam", camera()]]) }));
    const picture = screen.getByLabelText<HTMLVideoElement>("Sam Rivera's camera");
    const given = givenTo(picture);
    vi.advanceTimersByTime(2999);
    fireEvent(picture, new Event("loadedmetadata"));
    vi.advanceTimersByTime(60_000);
    expect(given).toEqual([]);
  });

  it("gives a picture that fails its stream again, and counts the seconds anew for it, three times at most however it comes to show nothing", () => {
    vi.useFakeTimers();
    const sams = camera();
    renderView(huddle({ people: [inHuddle(sam, { video: true })], watched: new Map([["sam", sams]]) }));
    const picture = screen.getByLabelText<HTMLVideoElement>("Sam Rivera's camera");
    const given = givenTo(picture);
    vi.advanceTimersByTime(1000);
    fireEvent(picture, new Event("error"));
    expect(given).toEqual([null, sams]);
    vi.advanceTimersByTime(2999);
    expect(given).toEqual([null, sams]);
    vi.advanceTimersByTime(1);
    expect(given).toEqual([null, sams, null, sams]);
    fireEvent(picture, new Event("loadedmetadata"));
    vi.advanceTimersByTime(60_000);
    expect(given).toEqual([null, sams, null, sams]);

    for (let failures = 0; failures < 5; failures++) fireEvent(picture, new Event("error"));
    vi.advanceTimersByTime(60_000);
    expect(given).toEqual([null, sams, null, sams, null, sams]);
  });

  it("gives a picture that's gone nothing more, whether it showed nothing or failed", () => {
    vi.useFakeTimers();
    const { rerender } = renderView(huddle({ people: [inHuddle(sam, { video: true })], watched: new Map([["sam", camera()]]) }));
    const picture = screen.getByLabelText<HTMLVideoElement>("Sam Rivera's camera");
    rerender(<HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />);
    const given = givenTo(picture);
    vi.advanceTimersByTime(60_000);
    fireEvent(picture, new Event("error"));
    expect(given).toEqual([]);
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
    expect(names.slice(names.indexOf("Turn off camera"), names.indexOf("Raise hand"))).toEqual(["Turn off camera", "Camera", "Switch camera"]);

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

  it("raises the hand of the tab's person and lowers it, from a button after the screen's that's filled while it's raised, which a phone hasn't, and takes off another sticker they show, which it draws meanwhile", async () => {
    browserSharesScreens();
    const { setSticker, user, rerender } = renderView();
    const raise = screen.getByRole("button", { name: "Raise hand" });
    expect(toolNames().slice(toolNames().indexOf("Share screen"))).toEqual(["Share screen", "Raise hand", "Stickers", "React", "More", "Leave"]);
    expect(raise).toHaveAttribute("title", "Raise hand");
    expect(raise).toHaveTextContent(/^✋$/);
    expect(raise).toHaveClass("bg-hover");
    // A phone has its stickers in React's panel.
    expect(raise.parentElement).toHaveClass("max-md:hidden");
    await user.click(raise);

    rerender(<HuddleView huddle={huddle({ sticker: "hand" })} room={general} me={me} onFailed={failed} />);
    const lower = screen.getByRole("button", { name: "Lower hand" });
    expect(lower).toBe(raise);
    expect(lower).toHaveAttribute("title", "Lower hand");
    expect(lower).toHaveClass("bg-foreground", "text-background");
    await user.click(lower);
    expect(setSticker.mock.calls).toEqual([["hand"], [null]]);

    // Another sticker is on it in the hand's place, as on Slack's, and it takes that off.
    rerender(<HuddleView huddle={huddle({ sticker: "brb" })} room={general} me={me} onFailed={failed} />);
    const remove = screen.getByRole("button", { name: "Remove sticker" });
    expect(remove).toBe(raise);
    expect(remove).toHaveAttribute("title", "Remove sticker");
    expect(remove).toHaveTextContent(/^☕$/);
    expect(remove).toHaveClass("bg-foreground", "text-background");
    await user.click(remove);
    expect(setSticker.mock.calls).toEqual([["hand"], [null], [null]]);
  });

  it("has an arrow beside Raise hand, of a piece with it and lit as it is, which opens the stickers there are, the one that's shown ticked, to show another or take that one off", async () => {
    const { setSticker, user, rerender } = renderView(huddle({ sticker: "brb" }));
    const arrow = screen.getByRole("button", { name: "Stickers" });
    expect(arrow).toHaveAttribute("title", "Stickers");
    expect(arrow).toHaveClass("rounded-l-none", "bg-foreground", "text-background");
    expect(screen.getByRole("button", { name: "Remove sticker" })).toHaveClass("md:rounded-r-none");

    await user.click(arrow);
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveAccessibleName("Stickers");
    // Under how long one stays, as Slack's says over its own.
    expect(menu.firstElementChild).toHaveTextContent(/^StickersOne stays on until you take it off\.$/);
    const choices = within(menu).getAllByRole("menuitemcheckbox");
    expect(choices.map((choice) => [choice.textContent, choice.getAttribute("aria-checked")])).toEqual([
      ["✋Raise hand", "false"],
      ["☕Be right back", "true"],
      ["👍Yes", "false"],
      ["👎No", "false"],
      ["✅Done", "false"],
    ]);
    await user.click(choices[2]!);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(setSticker).toHaveBeenCalledExactlyOnceWith("thumbs-up");

    await user.click(arrow);
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Be right back" }));
    expect(setSticker).toHaveBeenLastCalledWith(null);

    rerender(<HuddleView huddle={huddle()} room={general} me={me} onFailed={failed} />);
    expect(arrow).toHaveClass("bg-hover");
    expect(arrow).not.toHaveClass("bg-foreground");
  });

  it("has React after Raise hand, which opens the huddle's reactions and stickers over its buttons, and closes them again, as an emoji picked does", async () => {
    const { react, user } = renderView();
    const button = screen.getByRole("button", { name: "React" });
    expect(toolNames().slice(toolNames().indexOf("Stickers"))).toEqual(["Stickers", "React", "More", "Leave"]);
    expect(button).toHaveAttribute("title", "React");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("aria-expanded", "false");
    // A phone too narrow for it has it in More's menu.
    expect(button).toHaveClass("bg-hover", "max-[360px]:hidden");
    expect(reactions()).not.toBeInTheDocument();

    await user.click(button);
    expect(reactions()).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
    await user.click(await within(reactions()!).findByRole("button", { name: "🎉" }));
    expect(react).toHaveBeenCalledExactlyOnceWith("🎉");
    expect(reactions()).not.toBeInTheDocument();
    await waitFor(() => expect(button).toHaveFocus());

    await user.click(button);
    expect(reactions()).toBeInTheDocument();
    await user.click(button);
    expect(reactions()).not.toBeInTheDocument();
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
    expect(more).not.toHaveClass("min-[360px]:hidden");

    await user.click(more);
    const choices = within(await screen.findByRole("menu")).getAllByRole("menuitem");
    expect(choices.map((choice) => choice.textContent)).toEqual(["React", "Invite people"]);
    const focused: EventTarget[] = [];
    const note = (event: FocusEvent) => void focused.push(event.target!);
    document.addEventListener("focusin", note);
    await user.click(choices[1]!);
    const dialog = await inviteDialog();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const title = within(dialog).getByRole("heading", { name: "Invite people" });
    await waitFor(() => expect(title).toHaveFocus());

    await user.keyboard("{Escape}");
    expect(dialog).not.toBeInTheDocument();
    await waitFor(() => expect(more).toHaveFocus());
    // The focus went from the menu straight to the list, which kept it until it closed.
    expect(focused).toEqual([choices[1], title, more]);
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

  it("has React in More's menu, on a phone too narrow to give it a button, which opens the reactions and stickers once the menu has shut, and has the focus back once they close", async () => {
    const { setSticker, user } = renderView(huddle({ roomId: "direct-1" }), direct);
    const more = screen.getByRole("button", { name: "More" });
    const choose = async () => {
      await user.click(more);
      const choice = await screen.findByRole("menuitem", { name: "React" });
      // Only where React has no button of its own.
      expect(choice).toHaveClass("min-[360px]:hidden");
      await user.click(choice);
      await waitFor(() => expect(reactions()).toBeInTheDocument());
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      // The menu isn't left holding the page.
      expect(document.body.style.pointerEvents).toBe("");
    };

    await choose();
    await user.keyboard("{Escape}");
    expect(reactions()).not.toBeInTheDocument();
    await waitFor(() => expect(more).toHaveFocus());

    // As a sticker's chosen, too.
    await choose();
    await user.click(within(reactions()!).getByRole("tab", { name: "Stickers" }));
    await user.click(within(reactions()!).getByRole("button", { name: "Done" }));
    expect(setSticker).toHaveBeenCalledExactlyOnceWith("done");
    expect(reactions()).not.toBeInTheDocument();
    await waitFor(() => expect(more).toHaveFocus());

    // But a click outside them leaves the focus where it put it.
    await choose();
    await user.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(reactions()).not.toBeInTheDocument();
    expect(more).not.toHaveFocus();
  });

  it("has no Invite people once its room isn't among this person's, which leaves nobody to list, and More only for React, where React has no button", async () => {
    const { user } = renderView(huddle(), null);
    expect(screen.queryByRole("button", { name: "Invite people" })).not.toBeInTheDocument();
    expect(toolNames()).toEqual(["Mute microphone", "Microphone and speaker", "Turn on camera", "Camera", "Raise hand", "Stickers", "React", "More", "Leave"]);
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveClass("md:hidden", "min-[360px]:hidden");
    await user.click(more);
    expect(within(await screen.findByRole("menu")).getAllByRole("menuitem").map((choice) => choice.textContent)).toEqual(["React"]);
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
    // In a row with the people and what rises over them, between the huddle's header and its buttons.
    const people = overPeople().parentElement!;
    expect(thread()!.parentElement).toBe(people.parentElement);
    expect(thread()!.parentElement).toHaveClass("flex");
    expect(thread()!.previousElementSibling).toBe(people);
    expect(thread()!.parentElement!.previousElementSibling).toBe(opened().querySelector(":scope > header"));
    expect(thread()!.parentElement!.nextElementSibling).toBe(opened().querySelector(":scope > footer"));

    expect(FakeSocket.all.map(({ url }) => url)).toEqual(["ws://localhost:3000/api/rooms/direct-1/socket?visible=1&protocol=4&apart=1"]);
    FakeSocket.all[0]!.letIn();
    expect(FakeSocket.all[0]!.sent).toEqual([{ type: "thread.open", parentId: "h1" }]);
  });

  it("has Thread among its buttons, after React and before More, lit while the thread shows", () => {
    browserSharesScreens();
    renderView(huddle({ messageId: "h1" }));
    expect(toolNames()).toEqual([
      "Invite people",
      "Mute microphone",
      "Microphone and speaker",
      "Turn on camera",
      "Camera",
      "Share screen",
      "Raise hand",
      "Stickers",
      "React",
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
