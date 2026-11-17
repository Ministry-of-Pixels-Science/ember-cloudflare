import type { DirectoryUser, LiveHuddle, Message, User } from "@ember/protocol";
import type { MessageHuddle } from "@ember/protocol/huddles";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlashProvider } from "@/components/flash";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { showHuddle, type JoinedHuddle } from "@/lib/huddle-store";
import { timeLabel } from "@/lib/messages";
import { HuddlesContext } from "./huddle-button";
import { MessageItem } from "./message-item";

// A huddle's message as its room shows it (./huddle-message.tsx), in a message's row (./message-item.tsx).

const [ada, grace, linus, alan, joan]: User[] = [
  { id: "ada", name: "Ada Lovelace" },
  { id: "grace", name: "Grace Hopper" },
  { id: "linus", name: "Linus Torvalds" },
  { id: "alan", name: "Alan Turing" },
  { id: "joan", name: "Joan Clarke" },
];
/** Someone as the people directory lists them, a member who can sign in. */
const listed = (user: User): DirectoryUser => ({ ...user, bio: null, role: "member", status: "active", avatarUrl: `/users/${user.id}/avatar` });

const STARTED = "2026-11-10T09:00:00.000Z";
const ENDED = "2026-11-10T09:24:40.000Z";
const time = timeLabel(new Date(STARTED));

/** The message of a huddle Ada started in General, as the room writes it, which says `huddle` of it: that it's going on, unless given. */
const huddleMessage = (huddle: MessageHuddle = { startedAt: STARTED }, changes: Partial<Message> = {}): Message => ({
  id: "m1",
  clientMessageId: "c1",
  roomId: "general",
  creator: ada!,
  body: "<p>A huddle started</p>",
  plainText: "A huddle started",
  mentions: [],
  createdAt: STARTED,
  updatedAt: STARTED,
  editedAt: null,
  boosts: [],
  huddle,
  ...changes,
});

/** The huddle going on in General since the message says, with `userIds` in it, as the sidebar hears of it. */
const going = (...userIds: string[]): Record<string, LiveHuddle> => ({ general: { startedAt: STARTED, userIds } });

/** The huddle this tab is in, in room `roomId`. */
const joined = (roomId: string): JoinedHuddle => ({ roomId, connected: true, you: grace!, people: [], muted: false, microphone: true, microphoneId: "", speakerId: "", camera: null, watched: new Map(), screen: null, screens: new Map(), open: false, thread: true });
const controls = () => ({ leave: vi.fn(), setMuted: vi.fn(), setCamera: vi.fn(), setScreen: vi.fn(), setOpen: vi.fn(), setThread: vi.fn(), setDevice: vi.fn(), setSmall: vi.fn(), switchCamera: vi.fn(), invite: vi.fn() });

interface Seen {
  /** Whose tab shows the message: Linus's, who's in no huddle, unless given. */
  me?: User;
  administrator?: boolean;
  /** The huddles going on, by room, as the sidebar last heard. */
  live?: Record<string, LiveHuddle>;
  /** Whether huddles are on, as they are unless given. */
  huddles?: boolean;
  /** Who the people directory lists: everyone but Alan, unless given. */
  people?: User[];
  /** Whether the message's thread is open beside the room. */
  open?: boolean;
}

/**
 * Renders a huddle's message as its room does, opening and closing its editor as the room does. `update`
 * hands it a new copy of the message, as the room does when the message changes, and the huddles going
 * on then.
 */
function show(message: Message, { me = linus!, administrator = false, live = {}, huddles = true, people = [ada!, grace!, linus!, joan!], open = false }: Seen = {}) {
  const preview = vi.fn();
  const actions = { boost: vi.fn(() => true), unboost: vi.fn(() => true), edit: vi.fn(() => true), remove: vi.fn(() => true), click: vi.fn(() => Promise.resolve(true)) };
  let setEditing: (editing: boolean) => void = () => {};
  const editors = { open: vi.fn(() => setEditing(true)), close: vi.fn(() => setEditing(false)), returnFocus: vi.fn(), attach: vi.fn(), reply: vi.fn() };
  const directory = new Map(people.map((person) => [person.id, listed(person)]));
  function Room({ shown, liveNow }: { shown: Message; liveNow: Record<string, LiveHuddle> }) {
    const [editing, set] = useState(false);
    setEditing = set;
    return (
      <FlashProvider workspace>
        <AccountContext value={{ ...useAccount(), huddles }}>
          <PeopleContext value={directory}>
            <HuddlesContext value={{ live: liveNow, preview }}>
              <MessageItem message={shown} me={{ ...me, administrator }} threaded={false} editing={editing} actions={actions} editors={editors} open={open} />
            </HuddlesContext>
          </PeopleContext>
        </AccountContext>
      </FlashProvider>
    );
  }
  const { container, rerender } = render(<Room shown={message} liveNow={live} />);
  const update = (next: Message, liveNow: Record<string, LiveHuddle> = live) => rerender(<Room shown={next} liveNow={liveNow} />);
  return { preview, actions, editors, update, user: userEvent.setup(), article: within(container).getByRole("article") };
}

const heading = (article: HTMLElement) => within(article).getByRole("heading", { level: 3 });
/** What stands where the author's face would be. */
const tile = (article: HTMLElement) => article.firstElementChild!;
/** The faces a message shows, by the addresses of their pictures. */
const faces = (article: HTMLElement) => [...article.querySelectorAll("img")].map((face) => face.getAttribute("src"));
const join = (article: HTMLElement) => within(article).queryByRole("button", { name: "Join" });
const options = (article: HTMLElement) => within(article).getByRole("button", { name: "Message options" });

/** What each button and link of the open bar of a message's actions is called, in order. */
const barNames = () => [...screen.getByRole("group", { name: "Message actions" }).firstElementChild!.querySelectorAll<HTMLElement>("button, a")].map((control) => control.getAttribute("aria-label") ?? control.textContent);
/** The names of More actions' items, opened on `article` as a mouse does: hovering the message, then clicking Message options. */
async function moreActions(user: ReturnType<typeof userEvent.setup>, article: HTMLElement) {
  fireEvent.pointerEnter(article, { pointerType: "mouse" });
  await user.click(options(article));
  return within(screen.getByRole("group", { name: "More actions" })).getAllByRole("button").map((item) => item.textContent);
}

/** Answers media queries as a page does where a mouse can hover. */
const withMouse = () => {
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: media === "(hover: hover) and (pointer: fine)", media, addEventListener() {}, removeEventListener() {} }));
};

// jsdom lays nothing out, so every box is put 100px down the window, where the bar can open in view.
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 200, 40));
});
afterEach(() => {
  act(() => showHuddle(null));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("A huddle's message while the huddle goes on", () => {
  it("shows the huddle where its author and its text would be: the headphones on green, LIVE, who's in it as the sidebar hears, and Join, which opens the huddle's preview", async () => {
    const { article, preview, user } = show(huddleMessage(), { live: going("ada", "grace") });
    expect(heading(article)).toHaveTextContent(`A huddle is happeningLIVE${time}`);
    expect(article).not.toHaveTextContent("A huddle started");
    expect(tile(article)).toHaveClass("bg-positive", "text-white");
    expect(tile(article).querySelector("svg")).toBeInTheDocument();
    // Green behind it, under the pointer too.
    expect(article).toHaveClass("bg-positive/8", "hover:bg-positive/8");
    expect(within(article).getByText("Ada and Grace are in the huddle")).toBeInTheDocument();
    expect(faces(article)).toEqual(["/users/ada/avatar", "/users/grace/avatar"]);
    // Nothing of whoever started it, whose face would link to their page: the one link is the time's, to the message.
    expect(within(article).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/rooms/general/@m1"]);

    await user.click(join(article)!);
    expect(preview).toHaveBeenCalledExactlyOnceWith("general");
  });

  it("is marked as any message whose thread is open beside the room, in place of the green, under the pointer too", () => {
    const { article } = show(huddleMessage(), { live: going("ada"), open: true });
    expect(article).toHaveClass("bg-hover", "hover:bg-message-hover");
    expect(article).not.toHaveClass("bg-positive/8");
    expect(article).not.toHaveClass("hover:bg-positive/8");
    expect(tile(article)).toHaveClass("bg-positive");
  });

  it("shows the faces of the first four people in it, and counts whoever its words don't name", () => {
    const five = going("ada", "grace", "alan", "joan", "linus");
    const { article } = show(huddleMessage(), { live: five, people: [ada!, grace!, linus!, alan!, joan!] });
    expect(faces(article)).toEqual(["/users/ada/avatar", "/users/grace/avatar", "/users/alan/avatar", "/users/joan/avatar"]);
    expect(within(article).getByText("Ada, Grace, Alan, and 1 other are in the huddle")).toBeInTheDocument();
    cleanup();

    // The people directory doesn't list Alan, who has no face to show and no name to say.
    const unlisted = show(huddleMessage(), { live: five });
    expect(faces(unlisted.article)).toEqual(["/users/ada/avatar", "/users/grace/avatar", "/users/joan/avatar", "/users/linus/avatar"]);
    expect(within(unlisted.article).getByText("5 people are in the huddle")).toBeInTheDocument();
    cleanup();

    const others = show(huddleMessage(), { me: alan!, live: going("ada", "grace", "joan", "linus") });
    expect(within(others.article).getByText("Ada, Grace, Joan, and 1 other are in the huddle")).toBeInTheDocument();
  });

  it("says who's in it to someone in it as their own huddle does, and offers Join unless this tab is in the room's huddle", () => {
    const { article } = show(huddleMessage(), { me: grace!, live: going("ada", "grace") });
    expect(within(article).getByText("Ada and you are in the huddle")).toBeInTheDocument();
    // Grace is in it somewhere else: joining here moves her to this tab.
    expect(join(article)).toBeInTheDocument();

    act(() => showHuddle(joined("general"), controls()));
    expect(join(article)).not.toBeInTheDocument();
    expect(within(article).getByText("Ada and you are in the huddle")).toBeInTheDocument();
    act(() => showHuddle(joined("other"), controls()));
    expect(join(article)).toBeInTheDocument();
  });

  it("shows who's in it only while the room's huddle is the one it's of, and nothing where there's nobody to show and nothing to join", () => {
    // What the sidebar hears of is a huddle that started later: the message's is over, though it doesn't say so yet.
    const later = { general: { startedAt: "2026-11-10T09:30:00.000Z", userIds: ["grace"] } };
    const { article } = show(huddleMessage(), { live: later });
    expect(article).not.toHaveTextContent("in the huddle");
    expect(faces(article)).toEqual([]);
    expect(join(article)).toBeInTheDocument();
    cleanup();

    // Where huddles are off there's none to join, with nobody to show or with somebody.
    const off = show(huddleMessage(), { huddles: false });
    expect(heading(off.article)).toHaveTextContent(`A huddle is happeningLIVE${time}`);
    expect(heading(off.article).nextElementSibling).toBeNull();
    off.update(huddleMessage(), going("ada"));
    expect(within(off.article).getByText("Ada is in the huddle")).toBeInTheDocument();
    expect(join(off.article)).not.toBeInTheDocument();
    cleanup();

    // And before the sidebar has heard of it, a tab that's in it has neither.
    const here = show(huddleMessage(), { me: grace! });
    act(() => showHuddle(joined("general"), controls()));
    expect(heading(here.article).nextElementSibling).toBeNull();
  });
});

describe("A huddle's message once the huddle is over", () => {
  const over = (people: User[] = [ada!, grace!]) => huddleMessage({ startedAt: STARTED, endedAt: ENDED, people });

  it("says that a huddle happened, without LIVE, green or Join: who was in it and for how long", () => {
    const { article } = show(over(), { live: { general: { startedAt: "2026-11-10T09:30:00.000Z", userIds: ["grace"] } } });
    expect(heading(article)).toHaveTextContent(`A huddle happened${time}`);
    expect(article).not.toHaveTextContent("A huddle started");
    expect(tile(article)).toHaveClass("bg-border", "text-message-muted");
    expect(tile(article)).not.toHaveClass("bg-positive");
    expect(article).not.toHaveClass("bg-positive/8");
    expect(within(article).getByText("Ada and Grace were in the huddle for 24 minutes")).toBeInTheDocument();
    expect(faces(article)).toEqual(["/users/ada/avatar", "/users/grace/avatar"]);
    expect(join(article)).not.toBeInTheDocument();
  });

  it("shows the faces of the first four people who were in it, and counts the others past the third it names", () => {
    const everyone = [ada!, grace!, linus!, alan!, joan!];
    const { article } = show(over(everyone), { people: everyone });
    expect(faces(article)).toEqual(["/users/ada/avatar", "/users/grace/avatar", "/users/linus/avatar", "/users/alan/avatar"]);
    expect(within(article).getByText("Ada, Grace, Alan, and 1 other were in the huddle for 24 minutes")).toBeInTheDocument();
  });

  it("calls whoever reads it you, and names the others as the people directory does now, or as they were named then", () => {
    // Grace has changed her name since, and Alan has left the people directory.
    const people = [ada!, { ...grace!, name: "Gracie Hopper" }, linus!];
    const then = over([ada!, grace!, alan!]);
    const { article } = show(then, { me: ada!, people });
    expect(within(article).getByText("Gracie, Alan, and you were in the huddle for 24 minutes")).toBeInTheDocument();
    cleanup();

    const alone = show(over([ada!]), { me: ada! });
    expect(within(alone.article).getByText("Only you were in the huddle for 24 minutes")).toBeInTheDocument();
    cleanup();

    const one = show(huddleMessage({ startedAt: STARTED, endedAt: "2026-11-10T09:00:20.000Z", people: [ada!] }));
    expect(within(one.article).getByText("Ada was in the huddle for less than a minute")).toBeInTheDocument();
  });

  it("follows its huddle as it ends, and as it goes on again for someone who's back", () => {
    const { article, update } = show(huddleMessage(), { live: going("ada") });
    expect(within(article).getByText("Ada is in the huddle")).toBeInTheDocument();

    update(over([ada!]), {});
    expect(heading(article)).toHaveTextContent(`A huddle happened${time}`);
    expect(within(article).getByText("Ada was in the huddle for 24 minutes")).toBeInTheDocument();
    expect(join(article)).not.toBeInTheDocument();

    update(huddleMessage(), going("ada"));
    expect(heading(article)).toHaveTextContent(`A huddle is happeningLIVE${time}`);
    expect(within(article).getByText("Ada is in the huddle")).toBeInTheDocument();
    expect(join(article)).toBeInTheDocument();
  });
});

describe("What can be done to a huddle's message", () => {
  it("keeps its reactions and its thread's summary under what it says of its huddle, as any message does", () => {
    const thread = { count: 2, latestAt: "2026-11-10T09:10:00.000Z", people: [grace!] };
    const boosts = [{ id: "b1", messageId: "m1", booster: grace!, content: "👍", createdAt: STARTED }];
    const { article } = show(huddleMessage(undefined, { thread, boosts }), { live: going("ada") });
    expect(within(article).getByRole("list", { name: "Reactions" })).toHaveTextContent("👍");
    expect(within(article).getByRole("link", { name: /2 replies/ })).toHaveAttribute("href", "/rooms/general/threads/m1");
  });

  it("offers reactions, Reply in thread and Copy link, with nothing to quote or copy, and Edit only to whoever can delete it", async () => {
    const { article, user } = show(huddleMessage(), { live: going("ada") });
    await user.click(options(article));
    expect(barNames()).toEqual(["👍Thumbs up", "👏Clapping", "👋Waving hand", "More reactions", "Reply in thread", "Copy link"]);
    cleanup();

    const starter = show(huddleMessage(), { me: ada!, live: going("ada") });
    await starter.user.click(options(starter.article));
    expect(barNames()).toEqual(["👍Thumbs up", "👏Clapping", "👋Waving hand", "More reactions", "Reply in thread", "Copy link", "Edit"]);
    cleanup();

    withMouse();
    const reader = show(huddleMessage(), { live: going("ada") });
    expect(await moreActions(reader.user, reader.article)).toEqual(["Copy link"]);
    cleanup();

    const administrator = show(huddleMessage(), { administrator: true, live: going("ada") });
    expect(await moreActions(administrator.user, administrator.article)).toEqual(["Copy link", "Delete message"]);
  });

  it("opens an editor that shows it as it is, with Delete message alone, which asks first", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { article, actions, editors, user } = show(huddleMessage(), { me: ada!, live: going("ada", "grace") });
    await user.click(options(article));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("textbox", { name: "Edit message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(article).toHaveTextContent("A huddle is happeningLIVE");
    expect(within(article).getByText("Grace and you are in the huddle")).toBeInTheDocument();
    expect(tile(article)).toHaveClass("bg-positive");

    const remove = screen.getByRole("button", { name: "Delete message" });
    expect(remove).toHaveFocus();
    await user.click(remove);
    expect(confirm).toHaveBeenCalledWith("Are you sure you want to delete this message?");
    expect(actions.remove).not.toHaveBeenCalled();
    await user.click(remove);
    expect(actions.remove).toHaveBeenCalledExactlyOnceWith("m1");
    expect(editors.returnFocus).toHaveBeenCalled();
    expect(actions.edit).not.toHaveBeenCalled();
  });
});
