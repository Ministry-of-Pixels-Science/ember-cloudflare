import type { DirectoryUser, LiveHuddle, PastHuddle, PastHuddles, SidebarRoom, User } from "@ember/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "@/components/ui/sheet";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { showHuddle, type JoinedHuddle } from "@/lib/huddle-store";
import { dateTimeLabel, timeLabel } from "@/lib/messages";
import { HuddlesContext } from "./huddle-button";
import { HuddlesPage } from "./huddles-page";

// The Huddles page (./huddles-page.tsx), as Ada sees it at three in the afternoon of 17 November 2026.

const [ada, grace, linus, alan, joan, katherine]: User[] = [
  { id: "ada", name: "Ada Lovelace" },
  { id: "grace", name: "Grace Hopper" },
  { id: "linus", name: "Linus Torvalds" },
  { id: "alan", name: "Alan Turing" },
  { id: "joan", name: "Joan Clarke" },
  { id: "katherine", name: "Katherine Johnson" },
];
/** Someone as the people directory lists them, a member who can sign in. */
const listed = (user: User): DirectoryUser => ({ ...user, bio: null, role: "member", status: "active", avatarUrl: `/users/${user.id}/avatar` });
const avatarOf = (user: User) => `/users/${user.id}/avatar`;

/** A time on a day of November 2026, where the tests run, as the server writes times. */
const at = (day: number, hour: number, minute = 0, second = 0) => new Date(2026, 10, day, hour, minute, second).toISOString();

const general: SidebarRoom = { id: "general", kind: "open", name: "General", icon: null, unread: false, involvement: "mentions" };
const design: SidebarRoom = { id: "design", kind: "closed", name: "Design", icon: null, unread: false, involvement: "mentions" };
/** A room Ada has hidden from her sidebar. */
const noise: SidebarRoom = { id: "noise", kind: "open", name: "Noise", icon: null, unread: false, involvement: "invisible" };
/** Ada's DM with Grace, who was Grace H. when the sidebar read it. */
const withGrace: SidebarRoom = { id: "dm-grace", kind: "direct", members: [ada!, { id: "grace", name: "Grace H." }], activeAt: at(1, 9), unread: false, involvement: "everything" };
/** Ada's DM with five others. */
const withFive: SidebarRoom = { id: "dm-five", kind: "direct", members: [ada!, grace!, linus!, alan!, joan!, katherine!], activeAt: at(1, 9), unread: false, involvement: "everything" };

/** This morning's huddle in General, which Grace started and Ada joined: 24 minutes and a half, with five replies. */
const standUp: PastHuddle = { roomId: "general", messageId: "m3", startedAt: at(17, 10, 14), endedAt: at(17, 10, 38, 30), userIds: ["grace", "ada"], replies: 5 };
/** Yesterday's in Design, which Ada wasn't in: an hour and five minutes, with one reply. */
const review: PastHuddle = { roomId: "design", messageId: "m2", startedAt: at(16, 16), endedAt: at(16, 17, 5), userIds: ["linus", "grace"], replies: 1 };
/** One in General two weeks ago, which five people were in for 40 seconds, with no reply. */
const kickOff: PastHuddle = { roomId: "general", messageId: "m1", startedAt: at(3, 9), endedAt: at(3, 9, 0, 40), userIds: ["grace", "linus", "ada", "alan", "joan"], replies: 0 };

/** What the server answers with the huddles that are over `huddles`. */
const answering = (...huddles: PastHuddle[]) => () => Response.json({ huddles } satisfies PastHuddles);
/** What it answers when it fails with `status`. */
const failing = (status: number) => () => Response.json({ error: "Something went wrong" }, { status });

/** Answers the page's asking for the huddles that are over as `answer` does, from now on: with all three, unless given. */
function serve(answer: () => Response | Promise<Response> = answering(standUp, review, kickOff)) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    if (request === "GET /api/huddles") return answer();
    throw new Error(`Unexpected request for ${request}`);
  });
}

/** How many times the page has asked for the huddles that are over. */
const asked = () => vi.mocked(fetch).mock.calls.length;

/** A request's answer, held until `answer` gives it. */
const held = () => {
  let answer = (_: Response) => {};
  return { promise: new Promise<Response>((resolve) => (answer = resolve)), answer: (response: Response) => act(async () => answer(response)) };
};

/** Long enough for an answer the page has been given to have reached it. */
const settled = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

/** A huddle going on since `startedAt` with `userIds` in it, in the order they joined, as the sidebar hears of it. */
const going = (startedAt: string, ...userIds: string[]): LiveHuddle => ({ startedAt, userIds });

/** The huddle this tab is in, in room `roomId`. */
const joined = (roomId: string): JoinedHuddle => ({ roomId, connected: true, you: ada!, people: [], muted: false, sticker: null, microphone: true, microphoneId: "", speakerId: "", camera: null, watched: new Map(), screen: null, screens: new Map(), open: false, thread: true });
const controls = () => ({ leave: vi.fn(), setMuted: vi.fn(), setCamera: vi.fn(), setScreen: vi.fn(), setOpen: vi.fn(), setThread: vi.fn(), setDevice: vi.fn(), setSmall: vi.fn(), switchCamera: vi.fn(), invite: vi.fn(), setSticker: vi.fn(), react: vi.fn() });

interface Shown {
  /** The rooms and DMs the sidebar lists, or null until they've come: General, Design and Ada's DM with Grace, unless given. */
  rooms?: SidebarRoom[] | null;
  /** The huddles going on, by room, as the sidebar last heard: none, unless given. */
  live?: Record<string, LiveHuddle>;
  /** Whether huddles are on, as they are unless given. */
  huddles?: boolean;
  /** How many times the sidebar has heard that the huddles that are over may have changed. */
  changes?: number;
}

/** Shows the page as Ada sees it, where the people directory lists everyone. `show` shows it again with what has changed since, as the workspace does, and `leave` takes it away. */
function showPage(first: Shown = {}) {
  const onFailed = vi.fn();
  const preview = vi.fn();
  history.replaceState(null, "", "/huddles");
  const directory = new Map([ada!, grace!, linus!, alan!, joan!, katherine!].map((person) => [person.id, listed(person)]));
  let shown: Required<Shown> = { rooms: [general, design, withGrace], live: {}, huddles: true, changes: 0, ...first };
  function Page({ rooms, live, huddles, changes }: Required<Shown>) {
    return (
      <AccountContext value={{ ...useAccount(), huddles }}>
        <PeopleContext value={directory}>
          <HuddlesContext value={{ live, preview }}>
            <Sheet>
              <HuddlesPage me={{ ...ada!, administrator: false }} rooms={rooms} changes={changes} onFailed={onFailed} />
            </Sheet>
          </HuddlesContext>
        </PeopleContext>
      </AccountContext>
    );
  }
  const { rerender, unmount } = render(<Page {...shown} />);
  const show = (changed: Shown) => rerender(<Page {...(shown = { ...shown, ...changed })} />);
  return { onFailed, preview, show, leave: unmount, user: userEvent.setup() };
}

const main = () => screen.getByRole("main");
const happeningNow = () => screen.queryByRole("region", { name: "Happening now" });
/** The cards of the huddles going on, in order. */
const cards = () => within(happeningNow()!).getAllByRole("listitem");
/** The rows of Recent huddles, in order, once it lists `count`. */
async function recent(count: number): Promise<HTMLElement[]> {
  const region = await screen.findByRole("region", { name: "Recent huddles" });
  await waitFor(() => expect(within(region).queryAllByRole("listitem")).toHaveLength(count));
  return within(region).queryAllByRole("listitem");
}
/** What a row or a card is called: its room's name. */
const named = (item: HTMLElement) => item.querySelector("strong, a[href] > strong, p > a")!.textContent;
/** What a row or a card says of its huddle under its room's name, as it reads. */
const said = (item: HTMLElement) => item.querySelector("time")!.closest("p, .block")!.textContent!.replace(/\s+/g, " ").trim();
/** The faces in `element`, by the addresses of their pictures. */
const pictures = (element: Element) => [...element.querySelectorAll("img")].map((face) => face.getAttribute("src"));
/** What stands for a row's room, before its name. */
const tile = (row: HTMLElement) => within(row).getByRole("link").firstElementChild!;
const time = (iso: string) => timeLabel(new Date(iso));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 17, 15, 0));
  serve();
});

afterEach(() => {
  act(() => showHuddle(null));
  vi.useRealTimers();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
  document.title = "";
});

describe("The Huddles page", () => {
  it("is the Huddles page, with the headphones before its heading, busy until your rooms and its huddles have both come, which it asks for once your rooms have", async () => {
    const { show } = showPage({ rooms: null });
    expect(document.title).toBe("Huddles");
    const heading = within(screen.getByRole("navigation", { name: "Page" })).getByRole("heading", { level: 1, name: "Huddles" });
    expect(heading.previousElementSibling?.tagName).toBe("svg");
    expect(main()).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(asked()).toBe(0);

    show({ rooms: [general, design, withGrace] });
    expect(main()).toHaveAttribute("aria-busy", "true");
    expect(vi.mocked(fetch).mock.calls.map(([url, init]) => [init?.method ?? "GET", url])).toEqual([["GET", "/api/huddles"]]);
    await recent(3);
    expect(main()).not.toHaveAttribute("aria-busy");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Recent huddles"]);
    expect(asked()).toBe(1);
  });

  it("lists the huddles that are over in the order the server answers them, each with its room, when it started, how long it went on, and how many replies its thread has", async () => {
    showPage();
    const rows = await recent(3);
    expect(rows.map(named)).toEqual(["General", "Design", "General"]);
    expect(rows.map(said)).toEqual([
      `Today at ${time(standUp.startedAt)} · 24 minutes · 5 replies`,
      `Yesterday at ${time(review.startedAt)} · 1 hour and 5 minutes · 1 reply`,
      "Nov 3 · less than a minute",
    ]);
    // A shared room's icon stands for it, on a tile, which says nothing to a screen reader.
    for (const row of rows) {
      expect(tile(row)).toHaveTextContent("#");
      expect(tile(row)).toHaveClass("bg-border", "text-message-muted");
      expect(tile(row)).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("makes each row one link to its huddle's thread, and says when the huddle started in full where a pointer rests on that", async () => {
    const { user } = showPage();
    const [row] = await recent(3);
    const link = within(row!).getByRole("link");
    expect(link).toHaveAttribute("href", "/rooms/general/threads/m3");
    const started = row!.querySelector("time")!;
    expect(started).toHaveAttribute("datetime", standUp.startedAt);
    expect(started).toHaveAttribute("title", dateTimeLabel(new Date(standUp.startedAt)));
    // The whole row is the link, its replies too, which are words in it rather than a link of their own.
    expect(row!.querySelectorAll("a, button")).toHaveLength(1);
    expect(link).toContainElement(within(row!).getByText("5 replies"));
    expect(link.parentElement).toBe(row);

    await user.click(within(row!).getByText("5 replies"));
    expect(location.pathname).toBe("/rooms/general/threads/m3");
  });

  it("shows the faces of the first four who were in a huddle, in the order they joined, and names who was in it where a pointer rests on them, and to a screen reader", async () => {
    showPage();
    const rows = await recent(3);
    /** The faces a row ends with, which say `sentence`, as the row's own words do to a screen reader. */
    const faces = (row: HTMLElement, sentence: string) => {
      expect(within(row).getByText(sentence)).toHaveClass("sr-only");
      const shown = within(row).getByTitle(sentence);
      expect(shown.firstElementChild).toHaveAttribute("aria-hidden", "true");
      return pictures(shown);
    };
    expect(faces(rows[0]!, "Grace and you were in the huddle")).toEqual([grace!, ada!].map(avatarOf));
    expect(faces(rows[1]!, "Linus and Grace were in the huddle")).toEqual([linus!, grace!].map(avatarOf));
    expect(faces(rows[2]!, "Grace, Linus, Alan, and 1 other were in the huddle")).toEqual([grace!, linus!, ada!, alan!].map(avatarOf));
  });

  it("counts whoever the people directory doesn't list among those who were in a huddle, and shows no face of theirs", async () => {
    serve(answering({ ...standUp, userIds: ["grace", "gone", "ada"] }, { ...review, userIds: ["linus", "gone"] }, { ...kickOff, userIds: ["ada", "gone"], replies: 1 }));
    showPage();
    const rows = await recent(3);
    expect(pictures(within(rows[0]!).getByTitle("3 people were in the huddle"))).toEqual([grace!, ada!].map(avatarOf));
    expect(pictures(within(rows[1]!).getByTitle("Linus and 1 other were in the huddle"))).toEqual([avatarOf(linus!)]);
    expect(pictures(within(rows[2]!).getByTitle("2 people were in the huddle"))).toEqual([avatarOf(ada!)]);
  });

  it("names a DM's huddle by the others in the DM, as they're called now, with their faces for its tile: one as a message shows it, or the first four", async () => {
    serve(answering({ ...standUp, roomId: "dm-grace" }, { ...review, roomId: "dm-five" }));
    showPage({ rooms: [general, withGrace, withFive] });
    const [one, five] = await recent(2);
    expect(named(one!)).toBe("Grace Hopper");
    expect(tile(one!)).toHaveAttribute("src", avatarOf(grace!));
    expect(tile(one!)).toHaveClass("size-9", "rounded-[6px]");
    expect(within(one!).getByRole("link")).toHaveAttribute("href", "/rooms/dm-grace/threads/m3");

    expect(named(five!)).toBe("Grace Hopper, Linus Torvalds, Alan Turing, Joan Clarke, and Katherine Johnson");
    expect(pictures(tile(five!))).toEqual([grace!, linus!, alan!, joan!].map(avatarOf));
    expect(tile(five!)).toHaveAttribute("aria-hidden", "true");
  });

  it("leaves out the huddles of a room you've hidden from your sidebar, and of a room it doesn't list", async () => {
    serve(answering({ ...standUp, roomId: "noise" }, review, { ...kickOff, roomId: "left" }));
    showPage({ rooms: [general, design, noise] });
    expect((await recent(1)).map(named)).toEqual(["Design"]);
  });

  it("says there are none yet, and what it takes for one to show", async () => {
    serve(answering());
    showPage();
    await recent(0);
    expect(screen.getByText("No huddles yet. A huddle shows here once it’s over, if someone else joined it or its thread has a reply.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    expect(main()).not.toHaveAttribute("aria-busy");
  });

  it("says the same where every huddle that's over is in a room you've hidden", async () => {
    serve(answering({ ...standUp, roomId: "noise" }));
    showPage({ rooms: [general, noise] });
    await recent(0);
    expect(screen.getByText(/^No huddles yet\./)).toBeInTheDocument();
  });

  it("asks for them again whenever the sidebar hears they may have changed, and shows what's answered", async () => {
    const { show } = showPage();
    await recent(3);
    serve(answering({ ...standUp, replies: 6 }, review));
    show({ changes: 1 });
    await waitFor(() => expect(asked()).toBe(2));
    await waitFor(async () => expect((await recent(2)).map(said)).toEqual([`Today at ${time(standUp.startedAt)} · 24 minutes · 6 replies`, `Yesterday at ${time(review.startedAt)} · 1 hour and 5 minutes · 1 reply`]));
    expect(main()).not.toHaveAttribute("aria-busy");
  });

  it("asks for them again as you're put in a room and as you leave one, but not as your rooms are renamed, read, muted or put in another order", async () => {
    const { show } = showPage();
    await recent(3);
    // General renamed, read and muted, Design marked unread, and the three in another order: the same rooms.
    show({ rooms: [withGrace, { ...design, unread: true }, { ...general, name: "Lobby", involvement: "nothing" }] });
    expect((await recent(3)).map(named)).toEqual(["Lobby", "Design", "Lobby"]);
    expect(asked()).toBe(1);

    show({ rooms: [general, design, withGrace, withFive] });
    expect(asked()).toBe(2);
    show({ rooms: [general, withGrace, withFive] });
    expect(asked()).toBe(3);
    // Design's huddle goes with it, before the answer comes.
    expect((await recent(2)).map(named)).toEqual(["General", "General"]);
  });

  it("asks for them again as you hide a room from your sidebar and as you show one again, since the server lists none of a hidden room's", async () => {
    const { show } = showPage();
    await recent(3);
    serve(answering(standUp, kickOff));
    show({ rooms: [general, { ...design, involvement: "invisible" }, withGrace] });
    expect(asked()).toBe(2);
    // Design's huddle goes as it's hidden, before the answer comes.
    expect((await recent(2)).map(named)).toEqual(["General", "General"]);

    serve(answering(standUp, review, kickOff));
    show({ rooms: [general, design, withGrace] });
    expect(asked()).toBe(3);
    expect((await recent(3)).map(named)).toEqual(["General", "Design", "General"]);
  });

  it("shows what its latest asking answers, even where an earlier one answers after it", async () => {
    const [first, second] = [held(), held()];
    const answers = [first.promise, second.promise];
    serve(() => answers.shift()!);
    const { show } = showPage();
    show({ changes: 1 });
    expect(asked()).toBe(2);
    await second.answer(answering(standUp)());
    expect((await recent(1)).map(named)).toEqual(["General"]);
    await first.answer(answering(review, kickOff)());
    await settled();
    expect((await recent(1)).map(named)).toEqual(["General"]);
  });

  it("says why its huddles didn't load, where it has none to show, and stays busy", async () => {
    serve(failing(500));
    const { onFailed } = showPage();
    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(onFailed.mock.calls[0]![0]).toMatchObject({ status: 500, message: "Something went wrong" });
    expect(main()).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("region", { name: "Recent huddles" })).toBeNull();
  });

  it("keeps the huddles it has, without a word, when they can't be loaded again, and asks again at the next change", async () => {
    const { show, onFailed } = showPage();
    await recent(3);
    const again = held();
    serve(() => again.promise);
    show({ changes: 1 });
    // What it has stays while it asks, and isn't marked busy.
    expect(main()).not.toHaveAttribute("aria-busy");
    expect(await recent(3)).toHaveLength(3);
    await again.answer(failing(500)());
    await settled();
    expect(onFailed).not.toHaveBeenCalled();
    expect((await recent(3)).map(named)).toEqual(["General", "Design", "General"]);

    serve(answering(review));
    show({ changes: 2 });
    expect((await recent(1)).map(named)).toEqual(["Design"]);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("reports a session that has ended whenever it hears of one: with its huddles loaded, and after it's left", async () => {
    const { show, leave, onFailed } = showPage();
    await recent(3);
    serve(failing(401));
    show({ changes: 1 });
    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(onFailed.mock.calls[0]![0]).toMatchObject({ status: 401 });

    const late = held();
    serve(() => late.promise);
    show({ changes: 2 });
    leave();
    await late.answer(failing(401)());
    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(2));
  });

  it("says nothing of huddles that fail to load once it's left", async () => {
    const late = held();
    serve(() => late.promise);
    const { leave, onFailed } = showPage();
    leave();
    await late.answer(failing(500)());
    await settled();
    expect(onFailed).not.toHaveBeenCalled();
  });
});

describe("Happening now, on the Huddles page", () => {
  const NOON = at(17, 12);
  const LATER = at(17, 14, 40);

  it("lists the huddles going on in your rooms and DMs over the ones that are over, the latest to start first: each a card with its room, LIVE, who's in it, when it started, and their faces", async () => {
    showPage({ live: { general: going(NOON, "grace", "linus"), "dm-grace": going(LATER, "grace") } });
    await recent(3);
    expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-labelledby"))).toEqual(["huddles-going-on", "recent-huddles"]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Happening now", "Recent huddles"]);

    const [direct, shared] = cards();
    expect(within(shared!).getByRole("link", { name: "General" })).toHaveAttribute("href", "/rooms/general");
    expect(within(shared!).getByText("LIVE")).toBeInTheDocument();
    expect(said(shared!)).toBe(`Grace and Linus are in the huddle · started ${time(NOON)}`);
    const started = shared!.querySelector("time")!;
    expect(started).toHaveAttribute("datetime", NOON);
    expect(started).toHaveAttribute("title", dateTimeLabel(new Date(NOON)));
    expect(pictures(shared!)).toEqual([grace!, linus!].map(avatarOf));
    // The room's icon on green, as a huddle's message shows the headphones while it goes on.
    expect(shared!.firstElementChild).toHaveTextContent("#");
    expect(shared!.firstElementChild).toHaveClass("bg-positive", "text-white");
    expect(shared).toHaveClass("bg-positive/8", "border-positive/30");

    expect(within(direct!).getByRole("link", { name: "Grace Hopper" })).toHaveAttribute("href", "/rooms/dm-grace");
    expect(said(direct!)).toBe(`Grace is in the huddle · started ${time(LATER)}`);
    // Her face for the DM's tile, then hers again as the one in the huddle.
    expect(pictures(direct!)).toEqual([grace!, grace!].map(avatarOf));
  });

  it("goes to a huddle's room from its card's link, which is the room's name", async () => {
    const { user } = showPage({ live: { design: going(NOON, "linus") } });
    await recent(3);
    const [card] = cards();
    expect(within(card!).getAllByRole("link")).toHaveLength(1);
    // The link's own box is stretched over the card, under Join.
    expect(within(card!).getByRole("link")).toHaveClass("after:absolute", "after:inset-0");
    expect(card).toHaveClass("relative");
    await user.click(within(card!).getByRole("link", { name: "Design" }));
    expect(location.pathname).toBe("/rooms/design");
  });

  it("follows the sidebar as people join a huddle and leave it, and as it ends", async () => {
    const { show } = showPage({ live: { general: going(NOON, "grace") } });
    await recent(3);
    expect(cards().map(said)).toEqual([`Grace is in the huddle · started ${time(NOON)}`]);
    show({ live: { general: going(NOON, "grace", "ada", "gone") } });
    // Someone the people directory doesn't list is counted, and with Ada in it, so is everyone.
    expect(cards().map(said)).toEqual([`3 people are in the huddle · started ${time(NOON)}`]);
    expect(pictures(cards()[0]!)).toEqual([grace!, ada!].map(avatarOf));
    show({ live: { general: going(NOON, "grace", "ada") } });
    expect(cards().map(said)).toEqual([`Grace and you are in the huddle · started ${time(NOON)}`]);
    show({ live: {} });
    expect(happeningNow()).toBeNull();
    expect(await recent(3)).toHaveLength(3);
  });

  it("has Join on each card, named for its room, which opens that huddle's preview, but not on the card of the huddle this tab is in", async () => {
    const { preview, user } = showPage({ live: { general: going(NOON, "grace"), "dm-grace": going(LATER, "grace") } });
    await recent(3);
    const joinGeneral = () => screen.queryByRole("button", { name: "Join the huddle in General" });
    const joinGrace = () => screen.queryByRole("button", { name: "Join the huddle with Grace Hopper" });
    expect(joinGeneral()).toHaveTextContent(/^Join$/);
    // Raised over the card's link, which would take its click otherwise.
    expect(joinGeneral()!.parentElement).toHaveClass("relative", "z-[1]");
    await user.click(joinGeneral()!);
    expect(preview.mock.calls).toEqual([["general"]]);
    await user.click(joinGrace()!);
    expect(preview.mock.calls).toEqual([["general"], ["dm-grace"]]);
    expect(location.pathname).toBe("/huddles");

    act(() => showHuddle(joined("general"), controls()));
    expect(joinGeneral()).toBeNull();
    expect(joinGrace()).toBeInTheDocument();
    expect(cards()).toHaveLength(2);
    act(() => showHuddle(null));
    expect(joinGeneral()).toBeInTheDocument();
  });

  it("lists none while huddles are off, whatever the sidebar last heard, though the ones that are over stay", async () => {
    const { show } = showPage({ huddles: false, live: { general: going(NOON, "grace") } });
    expect(await recent(3)).toHaveLength(3);
    expect(happeningNow()).toBeNull();
    show({ huddles: true });
    expect(cards()).toHaveLength(1);
  });

  it("leaves out the huddle going on in a room you've hidden from your sidebar", async () => {
    showPage({ rooms: [general, noise], live: { noise: going(LATER, "linus"), general: going(NOON, "grace") } });
    await recent(2);
    expect(cards().map(said)).toEqual([`Grace is in the huddle · started ${time(NOON)}`]);
  });

  it("lists a huddle once: one the sidebar still has as going on isn't among the recent ones until the sidebar hears it's over", async () => {
    const { show } = showPage({ live: { general: going(standUp.startedAt, "grace") } });
    expect((await recent(2)).map(named)).toEqual(["Design", "General"]);
    expect(cards()).toHaveLength(1);
    show({ live: {} });
    expect((await recent(3)).map(named)).toEqual(["General", "Design", "General"]);
    // The room's next huddle hides neither.
    show({ live: { general: going(LATER, "linus") } });
    expect(await recent(3)).toHaveLength(3);
    expect(cards()).toHaveLength(1);
  });
});
