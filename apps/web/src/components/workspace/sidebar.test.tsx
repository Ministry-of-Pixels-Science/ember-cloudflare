import type { Account, DirectoryUser, Favorites, LiveHuddle, SidebarRoom, User } from "@ember/protocol";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountContext } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { Sidebar } from "./sidebar";

const rooms = [
  { id: "general", name: "general", kind: "open" as const, icon: null, unread: false, involvement: "mentions" as const },
  { id: "random", name: "random", kind: "open" as const, icon: null, unread: false, involvement: "mentions" as const },
];
const unstarred: Favorites = { rooms: [], version: 0 };
const HELP = "Hold a starred room to drag it, or press Alt and the up or down arrow to reorder your favorites. Other rooms follow the workspace order.";

type Props = ComponentProps<typeof Sidebar>;

/** An AI agent, as the people directory lists it. */
const agent = (id: string, name: string): DirectoryUser => ({ id, name, bio: null, role: "bot", status: "active", avatarUrl: `/users/${id}/avatar`, agent: true });

/** The workspace, as it's set up. */
const EMBER: Account = { name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true };

/**
 * The sidebar, with `props` in place of an unstarred one listing `rooms` with none open, in `account`'s
 * workspace, with the people directory listing `people`.
 */
function renderSidebar(props: Partial<Props> = {}, account = EMBER, people: readonly DirectoryUser[] = []) {
  const all: Props = {
    workspaceName: "Ember",
    meId: "u1",
    rooms,
    favorites: unstarred,
    sharedOrder: [],
    huddles: {},
    loaded: true,
    currentRoomId: null,
    unreadOnly: false,
    agents: 0,
    agentsOpen: false,
    onSelect: vi.fn(),
    onNewDirect: vi.fn(),
    onOpenAgents: vi.fn(),
    onStarred: vi.fn(),
    onSessionChanged: vi.fn(),
    ...props,
  };
  const listed = new Map(people.map((person) => [person.id, person]));
  const sidebar = (changes: Partial<Props>, shown: Account) => (
    <PeopleContext value={listed}>
      <AccountContext value={shown}>
        <Sidebar {...all} {...changes} />
      </AccountContext>
    </PeopleContext>
  );
  const view = render(sidebar({}, account));
  return { ...view, ...all, rerender: (changes: Partial<Props>, changed = account) => view.rerender(sidebar(changes, changed)) };
}

const [ada, grace, linus, alan, edsger, barbara]: User[] = ["Ada", "Grace", "Linus", "Alan", "Edsger", "Barbara"].map((name, i) => ({ id: `u${i + 1}`, name }));
/** `minutes` past noon, on the day these tests take place. */
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 15, 12, minutes)).toISOString();
/** A DM between `members`, as the sidebar lists it to Ada, who's always in it, last active `activeAt`. */
const direct = (id: string, members: User[], unread = false, activeAt = at(0)): SidebarRoom => ({ id, kind: "direct", members, activeAt, unread, involvement: "everything" });

/** The DM rows, top to bottom. */
const directRows = () => within(screen.getByRole("region", { name: "DMs" })).queryAllByRole("link", { name: /^Direct message with / });

/** The room rows, top to bottom. */
const rows = () => within(screen.getByRole("region", { name: "Rooms" })).queryAllByRole("link");
const listed = () => rows().map((row) => row.textContent);
const row = (name: string) => rows().find((link) => link.textContent === `#${name}`)!;

afterEach(() => vi.restoreAllMocks());

describe("Workspace tagline", () => {
  it("heads the list with the workspace's tagline in small type under its name, and nothing while it has none", () => {
    const tagline = "Engines for every occasion";
    const { rerender } = renderSidebar({ workspaceName: "Analytical Engines" }, { ...EMBER, tagline });
    const name = screen.getByRole("heading", { level: 2, name: "Analytical Engines" });
    // HTML's element for a heading and its tagline, which the drawer's close button stays clear of.
    const heading = name.closest("hgroup")!;
    expect(heading).toHaveClass("max-md:pr-10");
    expect([...heading.children].map((child) => [child.tagName, child.textContent])).toEqual([
      ["H2", "Analytical Engines"],
      ["P", tagline],
    ]);
    expect(screen.getByText(tagline)).toHaveClass("text-[13px]", "text-muted-foreground");

    rerender({}, EMBER);
    expect([...heading.children].map((child) => child.tagName)).toEqual(["H2"]);
  });
});

describe("Conversations sidebar", () => {
  it("lists the rooms under the workspace name and marks the one you're in", () => {
    renderSidebar({ workspaceName: "Analytical Engines", currentRoomId: "random" });
    expect(screen.getByRole("heading", { level: 2, name: "Analytical Engines" })).toBeInTheDocument();
    expect(rows().map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("aria-current")])).toEqual([
      ["#general", "/rooms/general", null],
      ["#random", "/rooms/random", "page"],
    ]);
  });

  it("switches rooms in place, but leaves modified clicks to the browser", async () => {
    const { onSelect } = renderSidebar({ currentRoomId: "general" });
    await userEvent.click(screen.getByRole("link", { name: /random/ }));
    expect(onSelect).toHaveBeenCalledWith("random");

    vi.mocked(onSelect).mockClear();
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
      const click = fireEvent.click(screen.getByRole("link", { name: /random/ }), modifier);
      expect(click).toBe(true); // not prevented, so the browser opens a tab or window
    }
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("Room icons", () => {
  it("shows each room's icon before its name, or `#`", () => {
    renderSidebar({ rooms: [{ ...rooms[0]!, icon: "coffee" }, rooms[1]!], currentRoomId: "general" });
    const [coffee, random] = rows();
    expect(coffee).toHaveAccessibleName("general");
    expect(coffee!.querySelector('[data-icon="coffee"]')).toHaveStyle({ width: "19px", height: "19px" });
    expect(random).toHaveTextContent("#random");
  });
});

describe("Unread rooms", () => {
  it("makes an unread room's row bold, with a dot, and says so to screen readers", () => {
    renderSidebar({ rooms: [{ ...rooms[0]!, unread: true }, rooms[1]!] });
    const [general, random] = rows();
    expect(general).toHaveClass("font-[650]");
    expect(general).toHaveAccessibleName("general");
    expect(general).toHaveAccessibleDescription(`Unread ${HELP}`);
    expect(general!.lastElementChild).toHaveAttribute("aria-hidden", "true");
    expect(general!.lastElementChild).toHaveClass("ml-auto", "size-[7px]", "rounded-full", "bg-foreground");

    expect(random).not.toHaveClass("font-[650]");
    expect(random).toHaveAccessibleDescription(HELP);
    expect(random!.querySelector(".rounded-full")).toBeNull();
  });

  it("never marks the room the tab shows", () => {
    renderSidebar({ rooms: [{ ...rooms[0]!, unread: true }, rooms[1]!], currentRoomId: "general" });
    const general = screen.getByRole("link", { current: "page" });
    expect(general).not.toHaveClass("font-[650]");
    expect(general).toHaveAccessibleDescription(HELP);
    expect(general.querySelector(".rounded-full")).toBeNull();
  });
});

describe("Activity filter", () => {
  const marked = [{ ...rooms[0]!, unread: true }, rooms[1]!, { id: "design", name: "design", kind: "open" as const, icon: null, unread: true, involvement: "mentions" as const }];

  it("shows only the rows marked unread", () => {
    const { rerender } = renderSidebar({ rooms: [...marked, direct("d1", [ada!, grace!], true), direct("d2", [ada!, linus!])], unreadOnly: true });
    expect(listed()).toEqual(["#general", "#design"]);
    expect(directRows()).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "DMs" })).toBeInTheDocument();
    expect(screen.queryByText("You’re all caught up. No unread conversations.")).not.toBeInTheDocument();

    rerender({ unreadOnly: false });
    expect(listed()).toEqual(["#general", "#random", "#design"]);
    expect(directRows()).toHaveLength(2);
  });

  it("leaves out the room the tab shows, which is never marked", () => {
    renderSidebar({ rooms: marked, currentRoomId: "general", unreadOnly: true });
    expect(listed()).toEqual(["#design"]);
  });

  it("says everything's read when nothing is marked", () => {
    renderSidebar({ currentRoomId: "general", unreadOnly: true });
    expect(listed()).toEqual([]);
    expect(screen.getByText("You’re all caught up. No unread conversations.")).toHaveClass("text-[13px]", "text-muted-foreground");
  });
});

describe("Room order", () => {
  it("lists your starred rooms first, in the order you starred them, then the rest in the order you were put in them", () => {
    const more = [...rooms, { id: "design", name: "Design", kind: "open" as const, icon: null, unread: false, involvement: "mentions" as const }, { id: "ops", name: "ops", kind: "open" as const, icon: null, unread: false, involvement: "mentions" as const }];
    renderSidebar({ rooms: more, favorites: { rooms: ["random", "ops"], version: 2 } });
    expect(listed()).toEqual(["#random", "#ops", "#general", "#Design"]);
  });

  it("lists a room you've just been put in below every other room, whatever its name", () => {
    const { rerender } = renderSidebar();
    rerender({ rooms: [...rooms, { id: "annex", name: "Annex", kind: "open", icon: null, unread: false, involvement: "mentions" }] });
    expect(listed()).toEqual(["#general", "#random", "#Annex"]);
  });
});

describe("Shared room order", () => {
  it("lists the rooms the shared order ranks after your stars, in its order, then the rest in the order you were put in them", () => {
    const more = [...rooms, { id: "design", name: "Design", kind: "open" as const, icon: null, unread: false, involvement: "mentions" as const }, { id: "ops", name: "ops", kind: "open" as const, icon: null, unread: false, involvement: "mentions" as const }];
    renderSidebar({ rooms: more, favorites: { rooms: ["ops"], version: 1 }, sharedOrder: ["random", "ops", "gone", "general"] });
    expect(listed()).toEqual(["#ops", "#random", "#general", "#Design"]);
  });

  it("moves only the starred rows, which stay above the rest", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ favorites: { rooms: ["general"], version: 2 } }));
    renderSidebar({ favorites: { rooms: ["general"], version: 1 }, sharedOrder: ["random", "general"] });
    expect(listed()).toEqual(["#general", "#random"]);
    for (const [name, key] of [["random", "ArrowUp"], ["general", "ArrowDown"]] as const) fireEvent.keyDown(row(name), { key, altKey: true });
    expect(listed()).toEqual(["#general", "#random"]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Star rooms", () => {
  it("ends a starred room's row with a star, after its unread dot, which screen readers hear as Favorite", () => {
    renderSidebar({ rooms: [rooms[0]!, { ...rooms[1]!, unread: true }], favorites: { rooms: ["general", "random"], version: 2 } });
    const [general, random] = rows();
    const star = within(general!).getByRole("img", { name: "Favorite" });
    expect(star).toHaveClass("iconoir-star-solid");
    // Faded.
    expect(star).toHaveClass("ml-auto", "size-3.5", "text-muted-foreground/65");
    expect(general!.lastElementChild).toBe(star);
    // With no grip before it.
    expect(star.previousElementSibling).toHaveTextContent(/^general$/);
    expect([...general!.querySelectorAll("svg")]).toEqual([star]);

    // The dot takes the space before the star.
    const [name, dot, marker] = Array.from(random!.children).slice(-3);
    expect(name).toHaveTextContent(/^random$/);
    expect(dot).toHaveClass("ml-auto", "rounded-full");
    expect(marker).toHaveAccessibleName("Favorite");
    expect(marker).not.toHaveClass("ml-auto");
  });

  it("leaves the other rows without one", () => {
    renderSidebar({ favorites: { rooms: ["random"], version: 1 }, currentRoomId: "general" });
    expect(within(row("general")).queryByRole("img")).not.toBeInTheDocument();
    expect(row("general").querySelector("svg")).toBeNull();
    expect(within(row("random")).getByRole("img", { name: "Favorite" })).toBeInTheDocument();
  });
});

describe("Rooms with a huddle", () => {
  /** Someone as the people directory lists them. */
  const inDirectory = (user: User): DirectoryUser => ({ ...user, bio: null, role: "member", status: "active", avatarUrl: `/users/${user.id}/avatar` });
  const everyone = [ada!, grace!, linus!, alan!].map(inDirectory);
  /** A huddle with those people in it, in the order they joined. */
  const huddleOf = (...people: User[]): LiveHuddle => ({ startedAt: at(0), userIds: people.map(({ id }) => id) });
  /** What a room's row ends with while a huddle is going on in it. */
  const mark = (row: HTMLElement) => row.querySelector<HTMLElement>("[title]");
  const faces = (row: HTMLElement) => [...mark(row)!.querySelectorAll("img")].map((face) => face.getAttribute("src"));

  it("ends the row with the faces of the first two people in it, the headphones and how many are in it, in green", () => {
    renderSidebar({ huddles: { general: huddleOf(grace!, linus!, alan!) } }, EMBER, everyone);
    const [general, random] = rows();
    // Nothing shows after it: the words that follow it are hidden.
    expect(mark(general!)!.nextElementSibling).toBe(general!.lastElementChild);
    expect(general!.lastElementChild).not.toBeVisible();
    expect(mark(general!)).toHaveClass("ml-auto", "shrink-0", "text-positive");
    expect(faces(general!)).toEqual(["/users/u2/avatar", "/users/u3/avatar"]);
    for (const face of mark(general!)!.querySelectorAll("img")) expect(face).toHaveClass("size-4", "rounded-full", "ring-1", "ring-surface");
    expect(mark(general!)!.querySelector("svg")).toHaveClass("iconoir-headset", "size-3.5");
    expect(within(mark(general!)!).getByText("3")).toHaveClass("tabular-nums");

    expect(mark(random!)).toBeNull();
    expect(random!.querySelector("svg")).toBeNull();
  });

  it("says who's in it under a pointer, and to screen readers as the row's description, calling you you", () => {
    const { rerender } = renderSidebar({ huddles: { general: huddleOf(grace!, linus!) } }, EMBER, everyone);
    const general = () => rows()[0]!;
    expect(mark(general())).toHaveAttribute("title", "Grace and Linus are in the huddle");
    // The mark is the eye's, and the row keeps its room's name.
    expect(mark(general())).toHaveAttribute("aria-hidden", "true");
    expect(general()).toHaveAccessibleName("general");
    expect(general()).toHaveAccessibleDescription(`Grace and Linus are in the huddle ${HELP}`);
    expect(rows()[1]).toHaveAccessibleDescription(HELP);

    rerender({ huddles: { general: huddleOf(grace!, ada!) } });
    expect(mark(general())).toHaveAttribute("title", "Grace and you are in the huddle");
    expect(general()).toHaveAccessibleDescription(`Grace and you are in the huddle ${HELP}`);
    expect(faces(general())).toEqual(["/users/u2/avatar", "/users/u1/avatar"]);

    rerender({ huddles: { general: huddleOf(ada!) } });
    expect(mark(general())).toHaveAttribute("title", "Just you in the huddle");
    expect(within(mark(general())!).getByText("1")).toBeInTheDocument();
  });

  it("counts the people the directory doesn't list, whose faces it can't show", () => {
    const { rerender } = renderSidebar({ huddles: { general: huddleOf(linus!, grace!, alan!) } }, EMBER, [inDirectory(grace!)]);
    const general = () => rows()[0]!;
    expect(mark(general())).toHaveAttribute("title", "Grace and 2 others are in the huddle");
    expect(faces(general())).toEqual(["/users/u2/avatar"]);
    expect(within(mark(general())!).getByText("3")).toBeInTheDocument();

    // With you in it, everyone is counted.
    rerender({ huddles: { general: huddleOf(linus!, ada!) } });
    expect(mark(general())).toHaveAttribute("title", "2 people are in the huddle");
    expect(faces(general())).toEqual([]);
  });

  it("comes before the row's unread dot and its star, and takes the space before them", () => {
    const starred: Favorites = { rooms: ["general", "random"], version: 2 };
    renderSidebar({ rooms: [{ ...rooms[0]!, unread: true }, rooms[1]!], favorites: starred, huddles: { general: huddleOf(grace!), random: huddleOf(linus!) } }, EMBER, everyone);
    const [general, random] = rows();
    const [first, words, dot, star] = Array.from(general!.children).slice(-4);
    expect(first).toBe(mark(general!));
    expect(first).toHaveClass("ml-auto");
    expect(words).not.toBeVisible();
    expect(dot).toHaveClass("size-[7px]", "rounded-full");
    expect(dot).not.toHaveClass("ml-auto");
    expect(star).toHaveAccessibleName("Favorite");
    expect(star).not.toHaveClass("ml-auto");
    expect(general).toHaveAccessibleDescription(`Grace is in the huddle Unread ${HELP}`);

    const [its, , itsStar] = Array.from(random!.children).slice(-3);
    expect(its).toBe(mark(random!));
    expect(its).toHaveClass("ml-auto");
    expect(itsStar).toHaveAccessibleName("Favorite");
    expect(itsStar).not.toHaveClass("ml-auto");
  });

  it("follows the huddle as people join and leave it, and goes when it ends", () => {
    const { rerender } = renderSidebar({ huddles: { random: huddleOf(grace!) } }, EMBER, everyone);
    const random = () => rows()[1]!;
    /** How many it says are in it, and who under a pointer. */
    const says = () => [mark(random())!.textContent, mark(random())!.title];
    expect(says()).toEqual(["1", "Grace is in the huddle"]);

    rerender({ huddles: { random: huddleOf(grace!, linus!, alan!) } });
    expect(says()).toEqual(["3", "Grace, Linus, and Alan are in the huddle"]);
    rerender({ huddles: { random: huddleOf(linus!) } });
    expect(says()).toEqual(["1", "Linus is in the huddle"]);
    expect(faces(random())).toEqual(["/users/u3/avatar"]);

    // The row is as it was, its words gone with its mark.
    rerender({ huddles: {} });
    expect(mark(random())).toBeNull();
    expect(random()).toHaveAccessibleDescription(HELP);
    expect(listed()).toEqual(["#general", "#random"]);
  });

  it("ends a DM's row with it too, before its unread dot, and says who's in its huddle", () => {
    const withGrace = direct("d1", [ada!, grace!], true);
    const { rerender } = renderSidebar({ rooms: [...rooms, withGrace], huddles: { d1: huddleOf(grace!, ada!) } }, EMBER, everyone);
    const row = () => directRows()[0]!;
    const [its, words, dot] = Array.from(row().children).slice(-3);
    expect(its).toBe(mark(row()));
    expect(its).toHaveAttribute("title", "Grace and you are in the huddle");
    expect(its).toHaveClass("shrink-0", "text-positive");
    expect(faces(row())).toEqual(["/users/u2/avatar", "/users/u1/avatar"]);
    expect(its!.querySelector("svg")).toHaveClass("iconoir-headset", "size-3.5");
    expect(within(its as HTMLElement).getByText("2")).toHaveClass("tabular-nums");
    expect(words).not.toBeVisible();
    expect(dot).toHaveClass("size-[7px]", "rounded-full");
    expect(row()).toHaveAccessibleDescription("Grace and you are in the huddle Unread");

    // The row is as it was once the huddle has ended.
    rerender({ rooms: [...rooms, withGrace], huddles: {} });
    expect(mark(row())).toBeNull();
    expect(row()).toHaveAccessibleDescription("Unread");
    rerender({ rooms: [...rooms, { ...withGrace, unread: false }], huddles: {} });
    expect(row()).not.toHaveAttribute("aria-describedby");
  });
});

describe("Reorder starred rooms", () => {
  const team = [...rooms, { id: "design", name: "design", kind: "open" as const, icon: null, unread: false, involvement: "mentions" as const }, { id: "ops", name: "ops", kind: "open" as const, icon: null, unread: false, involvement: "mentions" as const }];
  const stars: Favorites = { rooms: ["general", "random", "design"], version: 3 };
  const status = () => screen.getByRole("status");
  /** What was sent to save an order, as the JSON it was sent as. */
  const sent = () => vi.mocked(fetch).mock.calls.map(([input, init]) => [String(input), init?.method, JSON.parse(String(init?.body))]);

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  // jsdom lays nothing out, so each row is 36px tall, in the order the list draws them, and the list
  // scrolls in a box too tall for a drag to scroll it.
  function layOutRows() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (!this.dataset.roomId) return DOMRect.fromRect({ x: 0, y: -1000, width: 280, height: 3000 });
      return DOMRect.fromRect({ x: 0, y: Array.prototype.indexOf.call(this.parentElement!.children, this) * 36, width: 280, height: 36 });
    });
  }

  /** Holds `name`'s row down with the mouse until it can be dragged. */
  function hold(name: string) {
    fireEvent.pointerDown(row(name), { pointerType: "mouse", button: 0, clientX: 20, clientY: rows().indexOf(row(name)) * 36 + 18 });
    act(() => vi.advanceTimersByTime(400));
  }

  const dragTo = (clientY: number) => fireEvent.pointerMove(window, { pointerType: "mouse", clientX: 20, clientY });

  it("says how the stars are reordered on every row, and gives starred rows the keys that do it", () => {
    renderSidebar({ rooms: team, favorites: stars });
    for (const link of rows()) expect(link).toHaveAccessibleDescription(HELP);
    expect(rows().map((link) => link.getAttribute("aria-keyshortcuts"))).toEqual([
      "Alt+ArrowUp Alt+ArrowDown",
      "Alt+ArrowUp Alt+ArrowDown",
      "Alt+ArrowUp Alt+ArrowDown",
      null,
    ]);
    expect(row("ops")).not.toHaveClass("cursor-grab");
    expect(row("general")).toHaveClass("cursor-grab", "[-webkit-touch-callout:none]");
    expect(row("general")).toHaveAttribute("draggable", "false");
  });

  it("moves a starred row past the one above or below it with Alt and an arrow, saving the order, and keeps it focused", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ favorites: { rooms: ["random", "general", "design"], version: 4 } }));
    const { onStarred } = renderSidebar({ rooms: team, favorites: stars });
    row("random").focus();

    fireEvent.keyDown(row("random"), { key: "ArrowUp", altKey: true });
    expect(listed()).toEqual(["#random", "#general", "#design", "#ops"]);
    expect(status()).toHaveTextContent("Saving room order…");
    expect(status()).toHaveClass("sr-only");
    expect(row("random")).toHaveFocus();
    await act(async () => {});
    expect(sent()).toEqual([["/api/sidebar/order", "PUT", { roomIds: ["random", "general", "design"] }]]);
    expect(onStarred).toHaveBeenCalledWith({ rooms: ["random", "general", "design"], version: 4 });
    expect(status()).toHaveTextContent("Starred room order saved.");
  });

  it("moves down past the next starred row shown, keeping the places of the stars Activity hides, and goes no further than the last", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ favorites: { rooms: ["design", "general", "random"], version: 4 } }));
    const unread = team.map((room) => (room.id === "random" ? room : { ...room, unread: true }));
    renderSidebar({ rooms: unread, favorites: stars, unreadOnly: true });
    expect(listed()).toEqual(["#general", "#design", "#ops"]);

    fireEvent.keyDown(row("general"), { key: "ArrowDown", altKey: true });
    await act(async () => {});
    expect(sent()).toEqual([["/api/sidebar/order", "PUT", { roomIds: ["design", "general", "random"] }]]);

    // Only starred rows move, and not past the end of them, or with the arrow alone.
    for (const [name, key, altKey] of [["ops", "ArrowUp", true], ["design", "ArrowUp", false]] as const) fireEvent.keyDown(row(name), { key, altKey });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  describe("dragged", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      layOutRows();
    });
    afterEach(() => vi.useRealTimers());

    it("lifts a starred row held for 400ms, moves it past the rows whose middle it passes, and saves where it's let go", async () => {
      vi.mocked(fetch).mockResolvedValue(Response.json({ favorites: { rooms: ["random", "design", "general"], version: 4 } }));
      const { onSelect, onStarred } = renderSidebar({ rooms: team, favorites: stars });

      hold("general");
      expect(status()).toHaveTextContent("Moving general. Release to save, or press Escape to cancel.");
      expect(row("general")).toHaveClass("cursor-grabbing", "bg-background!", "shadow-[0_4px_14px_var(--color-drag-shadow)]", "outline");
      expect(row("general").parentElement).toHaveClass("select-none");

      // Below the middle of design's row, the third, is after every star but never past the unstarred rows.
      dragTo(3 * 36 + 30);
      expect(listed()).toEqual(["#random", "#design", "#general", "#ops"]);
      fireEvent.pointerUp(window);
      expect(row("general")).not.toHaveClass("cursor-grabbing");
      expect(row("general")).toHaveFocus();
      expect(status()).toHaveTextContent("Saving room order…");
      // Letting go doesn't open the room.
      fireEvent.click(row("general"));
      expect(onSelect).not.toHaveBeenCalled();

      await act(async () => {});
      expect(sent()).toEqual([["/api/sidebar/order", "PUT", { roomIds: ["random", "design", "general"] }]]);
      expect(onStarred).toHaveBeenCalledWith({ rooms: ["random", "design", "general"], version: 4 });
      act(() => vi.advanceTimersByTime(500));
      fireEvent.click(row("general"));
      expect(onSelect).toHaveBeenCalledWith("general");
    });

    it("saves where a row is let go without a starred room that went meanwhile, deleted or no longer theirs", async () => {
      vi.mocked(fetch).mockResolvedValue(Response.json({ favorites: { rooms: ["design", "general"], version: 4 } }));
      const { rerender } = renderSidebar({ rooms: team, favorites: stars });
      hold("design");
      dragTo(0);
      // The list drops a room that's gone, and its star, with no news that the stars changed.
      rerender({ rooms: team.filter((room) => room.id !== "random"), favorites: { rooms: ["general", "design"], version: 3 } });
      expect(row("design")).toHaveClass("cursor-grabbing");

      fireEvent.pointerUp(window);
      await act(async () => {});
      expect(sent()).toEqual([["/api/sidebar/order", "PUT", { roomIds: ["design", "general"] }]]);
    });

    it("puts a dragged row back on Escape wherever the focus is, saving nothing", () => {
      renderSidebar({ rooms: team, favorites: stars });
      hold("design");
      dragTo(0);
      expect(listed()).toEqual(["#design", "#general", "#random", "#ops"]);

      // Safari leaves the focus where it was when a row is clicked, in the composer, say. Escape is
      // taken as it's pressed, so it closes nothing else, but only while a row is dragged.
      expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
      expect(listed()).toEqual(["#general", "#random", "#design", "#ops"]);
      expect(status()).toHaveTextContent("Room move canceled.");
      fireEvent.pointerUp(window);
      expect(fetch).not.toHaveBeenCalled();
      expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
    });

    it("ignores Alt and an arrow while a row is held, saving only where a dragged one is let go", async () => {
      vi.mocked(fetch).mockResolvedValue(Response.json({ favorites: { rooms: ["design", "general", "random"], version: 4 } }));
      renderSidebar({ rooms: team, favorites: stars });
      // Before the hold has lifted the row, and once it's dragged.
      fireEvent.pointerDown(row("design"), { pointerType: "mouse", button: 0, clientX: 20, clientY: 2 * 36 + 18 });
      fireEvent.keyDown(row("random"), { key: "ArrowUp", altKey: true });
      act(() => vi.advanceTimersByTime(400));
      dragTo(0);
      fireEvent.keyDown(row("random"), { key: "ArrowUp", altKey: true });
      expect(listed()).toEqual(["#design", "#general", "#random", "#ops"]);

      fireEvent.pointerUp(window);
      await act(async () => {});
      expect(sent()).toEqual([["/api/sidebar/order", "PUT", { roomIds: ["design", "general", "random"] }]]);
    });

    it("lets go of a row that moves 8px before the hold ends, a click, an unstarred row, and a lone starred one", () => {
      const { onSelect, rerender } = renderSidebar({ rooms: team, favorites: stars });
      fireEvent.pointerDown(row("general"), { pointerType: "mouse", button: 0, clientX: 20, clientY: 18 });
      fireEvent.pointerMove(window, { pointerType: "mouse", clientX: 20, clientY: 27 });
      act(() => vi.advanceTimersByTime(400));
      expect(status()).toBeEmptyDOMElement();

      fireEvent.pointerDown(row("general"), { pointerType: "mouse", button: 0, clientX: 20, clientY: 18 });
      fireEvent.pointerUp(window);
      fireEvent.click(row("general"));
      expect(onSelect).toHaveBeenCalledWith("general");
      act(() => vi.advanceTimersByTime(400));
      expect(status()).toBeEmptyDOMElement();

      hold("ops");
      expect(status()).toBeEmptyDOMElement();
      rerender({ favorites: { rooms: ["general"], version: 4 } });
      hold("general");
      expect(status()).toBeEmptyDOMElement();
    });

    it("says on screen when an order can't be saved, putting the stars back as they were", async () => {
      vi.mocked(fetch).mockResolvedValue(Response.json({ error: "Those aren't the rooms you've starred" }, { status: 403 }));
      renderSidebar({ rooms: team, favorites: stars });
      hold("design");
      dragTo(0);
      fireEvent.pointerUp(window);
      expect(listed()).toEqual(["#design", "#general", "#random", "#ops"]);

      await act(async () => {});
      expect(listed()).toEqual(["#general", "#random", "#design", "#ops"]);
      expect(status()).toHaveTextContent("Couldn’t save room order. Please try again.");
      expect(status()).toHaveClass("mx-[9px]", "my-1", "text-xs", "leading-normal", "text-negative", "wrap-anywhere");
      expect(status()).not.toHaveClass("sr-only");
    });

    it("signs out when the session has expired", async () => {
      vi.mocked(fetch).mockResolvedValue(Response.json({ error: "Not signed in" }, { status: 401 }));
      const { onSessionChanged } = renderSidebar({ rooms: team, favorites: stars });
      hold("design");
      dragTo(0);
      fireEvent.pointerUp(window);
      await act(async () => {});
      expect(onSessionChanged).toHaveBeenCalledWith(null);
    });

    it("drags with a finger held 400ms, which until then scrolls the list as usual", () => {
      renderSidebar({ rooms: team, favorites: stars });
      const touchmove = () => fireEvent.touchMove(window, { touches: [{ clientX: 20, clientY: 0 }] });
      fireEvent.touchStart(row("design"), { touches: [{ clientX: 20, clientY: 2 * 36 + 18 }] });
      // A tap goes to the row as usual, and a pointer's events from the finger change nothing.
      fireEvent.pointerDown(row("design"), { pointerType: "touch", button: 0, clientX: 20, clientY: 2 * 36 + 18 });
      act(() => vi.advanceTimersByTime(400));
      expect(status()).toHaveTextContent("Moving design.");
      expect(touchmove()).toBe(false); // prevented, so the page doesn't scroll
      expect(listed()).toEqual(["#design", "#general", "#random", "#ops"]);
      fireEvent.touchCancel(window);
      expect(listed()).toEqual(["#general", "#random", "#design", "#ops"]);
      expect(status()).toHaveTextContent("Room move canceled.");
    });
  });
});

describe("Background sidebar reloads keep your place", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => vi.useRealTimers());

  it("keeps a drag going through a reload of the list, but ends it when the stars have changed elsewhere", () => {
    const stars: Favorites = { rooms: ["general", "random"], version: 2 };
    const more: SidebarRoom[] = [...rooms, { id: "design", name: "design", kind: "open", icon: null, unread: true, involvement: "mentions" }];
    const { rerender } = renderSidebar({ favorites: stars });
    fireEvent.pointerDown(row("random"), { pointerType: "mouse", button: 0, clientX: 20, clientY: 54 });
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByRole("status")).toHaveTextContent("Moving random.");

    rerender({ rooms: more, favorites: { ...stars } });
    expect(row("random")).toHaveClass("cursor-grabbing");
    rerender({ rooms: more, favorites: { rooms: ["random"], version: 3 } });
    expect(row("random")).not.toHaveClass("cursor-grabbing");
    expect(screen.getByRole("status")).toHaveTextContent("Room move canceled.");
    fireEvent.pointerUp(window);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Group DMs and DM names", () => {
  it("names the others in each DM, or you in your DM with yourself, saying whom it's with to screen readers", () => {
    renderSidebar({ rooms: [...rooms, direct("d1", [ada!, grace!], false, at(3)), direct("d2", [ada!, grace!, linus!], false, at(2)), direct("d3", [ada!], false, at(1))] });
    expect(directRows().map((row) => [row.textContent, row.getAttribute("href")])).toEqual([
      ["Direct message with Grace", "/rooms/d1"],
      ["Direct message with Grace, Linus", "/rooms/d2"],
      ["Direct message with Ada (you)", "/rooms/d3"],
    ]);
    expect(directRows()[1]).toHaveAccessibleName("Direct message with Grace, Linus");
    expect(listed()).toEqual(["#general", "#random"]);
  });

  it("shows the other person's avatar at 24px, or up to four of a group's at 14px", () => {
    renderSidebar({ rooms: [direct("d1", [ada!, grace!], false, at(2)), direct("d2", [ada!, grace!, linus!, alan!, edsger!, barbara!], false, at(1))] });
    const [one, group] = directRows();
    expect([...one!.querySelectorAll("img")].map((img) => img.getAttribute("class"))).toEqual([expect.stringContaining("size-6")]);
    const faces = [...group!.querySelectorAll("img")];
    expect(faces).toHaveLength(4);
    for (const face of faces) expect(face).toHaveClass("size-3.5");
    expect(faces[0]!.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(faces[0]!.parentElement).toHaveClass("size-6", "grid-cols-2");
  });

  it("names people as the people directory lists them now, which follows a rename", () => {
    const renamed: DirectoryUser = { ...grace!, name: "Grace Hopper", bio: null, role: "member", status: "active", avatarUrl: "/users/u2/avatar" };
    render(
      <PeopleContext value={new Map([[renamed.id, renamed]])}>
        <Sidebar
          {...{ workspaceName: "Ember", meId: ada!.id, loaded: true, favorites: unstarred, sharedOrder: [], huddles: {}, currentRoomId: null, unreadOnly: false }}
          {...{ agents: 0, agentsOpen: false, onSelect: vi.fn(), onNewDirect: vi.fn(), onOpenAgents: vi.fn(), onStarred: vi.fn(), onSessionChanged: vi.fn() }}
          rooms={[direct("d1", [ada!, grace!])]}
        />
      </PeopleContext>,
    );
    expect(directRows()[0]).toHaveAccessibleName("Direct message with Grace Hopper");
  });

  it("badges a DM with @ember alone as an agent's after its name, but not a group DM it's in", () => {
    const ember: User = { id: "ember", name: "Ember" };
    renderSidebar({ rooms: [direct("d1", [ada!, ember], false, at(2)), direct("d2", [ada!, ember, grace!], false, at(1))] });
    const [alone, group] = directRows();
    expect(alone).toHaveAccessibleName("Direct message with Ember Agent");
    expect(within(alone!).getByText("Agent")).toHaveAttribute("data-slot", "badge");
    expect(group).toHaveAccessibleName("Direct message with Ember, Grace");
  });

  it("badges a DM with any agent alone, as the people directory lists it, but not one with another bot", () => {
    const recap = agent("u8", "Recap");
    const bot: DirectoryUser = { id: "u9", name: "Build Bot", bio: null, role: "bot", status: "active", avatarUrl: "/users/u9/avatar" };
    renderSidebar({ rooms: [direct("d1", [ada!, recap], false, at(2)), direct("d2", [ada!, bot], false, at(1))] }, EMBER, [recap, bot]);
    const [withAgent, withBot] = directRows();
    expect(withAgent).toHaveAccessibleName("Direct message with Recap Agent");
    expect(within(withAgent!).getByText("Agent")).toHaveAttribute("data-slot", "badge");
    expect(withBot).toHaveAccessibleName("Direct message with Build Bot");
  });
});

describe("Conversations sidebar", () => {
  it("lists DMs under DMs, marks the one you're in, and opens one in place", async () => {
    const { onSelect } = renderSidebar({ rooms: [direct("d1", [ada!, grace!], false, at(2)), ...rooms, direct("d2", [ada!, linus!], false, at(1))], currentRoomId: "d2" });
    expect(directRows().map((row) => row.getAttribute("aria-current"))).toEqual([null, "page"]);
    await userEvent.click(directRows()[0]!);
    expect(onSelect).toHaveBeenCalledWith("d1");
    expect(fireEvent.click(directRows()[0]!, { metaKey: true })).toBe(true);
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe("Conversations sidebar", () => {
  it("says it found no conversations once the list has come with nothing in it", () => {
    const { rerender } = renderSidebar({ rooms: [], loaded: false });
    expect(screen.queryByText("No conversations found.")).not.toBeInTheDocument();
    rerender({ loaded: true });
    expect(screen.getByText("No conversations found.")).toHaveClass("text-[13px]", "text-muted-foreground");
    rerender({ rooms: [direct("d1", [ada!, grace!])] });
    expect(screen.queryByText("No conversations found.")).not.toBeInTheDocument();
  });
});

describe("DM order", () => {
  it("lists DMs by their latest message, or when they started until one comes, latest first", () => {
    const listing = (d1: string) => [direct("d1", [ada!, grace!], false, d1), direct("d2", [ada!, linus!], false, at(3)), ...rooms, direct("d3", [ada!, alan!], false, at(2))];
    const { rerender } = renderSidebar({ rooms: listing(at(1)) });
    expect(directRows().map((row) => row.getAttribute("href"))).toEqual(["/rooms/d2", "/rooms/d3", "/rooms/d1"]);
    rerender({ rooms: listing(at(4)) });
    expect(directRows().map((row) => row.getAttribute("href"))).toEqual(["/rooms/d1", "/rooms/d2", "/rooms/d3"]);
  });
});

describe("DMs", () => {
  it("lists only the DMs you're in, with nobody else to start one with, however many people there are", () => {
    renderSidebar({ rooms: [...rooms, direct("d1", [ada!, grace!])] }, EMBER, [linus!, alan!].map((person) => ({ ...person, bio: null, role: "member", status: "active", avatarUrl: `/users/${person.id}/avatar` })));
    const dms = screen.getByRole("region", { name: "DMs" });
    expect(within(dms).getAllByRole("link").map((link) => link.getAttribute("aria-label") ?? link.textContent)).toEqual(["New direct message", "Direct message with Grace"]);
    expect(within(dms).queryAllByRole("button")).toEqual([]);
  });
});

describe("New direct message dialog", () => {
  it("opens New direct message in place from the DMs heading's link, which a click with a modifier key leaves to the browser", async () => {
    const { onNewDirect } = renderSidebar();
    const link = within(screen.getByRole("region", { name: "DMs" })).getByRole("link", { name: "New direct message" });
    expect(link).toHaveAttribute("href", "/rooms/directs/new");
    expect(link).toHaveAttribute("title", "New direct message");
    await userEvent.click(link);
    expect(onNewDirect).toHaveBeenCalledExactlyOnceWith(link);
    expect(fireEvent.click(link, { shiftKey: true })).toBe(true);
    expect(onNewDirect).toHaveBeenCalledOnce();
  });
});

describe("Unread rooms", () => {
  it("makes an unread DM's row bold, with a dot, and says so to screen readers, unless the tab shows it", () => {
    const { rerender } = renderSidebar({ rooms: [direct("d1", [ada!, grace!], true, at(2)), direct("d2", [ada!, linus!], false, at(1))] });
    const [unread, read] = directRows();
    expect(unread).toHaveClass("font-[650]");
    expect(unread).toHaveAccessibleDescription("Unread");
    expect(unread!.lastElementChild).toHaveClass("size-[7px]", "rounded-full", "bg-foreground");
    expect(read).not.toHaveClass("font-[650]");
    expect(read).toHaveAccessibleDescription("");

    rerender({ currentRoomId: "d1" });
    expect(directRows()[0]).not.toHaveClass("font-[650]");
    expect(directRows()[0]).toHaveAccessibleDescription("");
  });
});

describe("Activity filter", () => {
  it("shows only the DMs marked unread, and says everything's read only once no room or DM is", () => {
    const { rerender } = renderSidebar({ rooms: [...rooms, direct("d1", [ada!, grace!], true), direct("d2", [ada!, linus!])], unreadOnly: true });
    expect(listed()).toEqual([]);
    expect(directRows().map((row) => row.getAttribute("href"))).toEqual(["/rooms/d1"]);
    expect(screen.queryByText("You’re all caught up. No unread conversations.")).not.toBeInTheDocument();

    rerender({ currentRoomId: "d1" });
    expect(directRows()).toEqual([]);
    expect(screen.getByText("You’re all caught up. No unread conversations.")).toBeInTheDocument();
  });
});

describe("Available Agents", () => {
  const row = () => screen.queryByRole("button", { name: /^Available Agents/ });

  it("says how many AI agents there are to ask, under the DMs, and opens the list of them from its row", async () => {
    const { onOpenAgents, rerender } = renderSidebar({ rooms: [...rooms, direct("d1", [ada!, grace!])], agents: 6 });
    expect(row()).toHaveAccessibleName("Available Agents, 6 to ask");
    expect(within(screen.getByRole("region", { name: "Agents" })).getByText("6")).toHaveAttribute("aria-hidden", "true");
    expect(row()).toHaveAttribute("aria-haspopup", "dialog");
    expect(row()).toHaveAttribute("aria-expanded", "false");
    // After the DMs.
    expect(screen.getByRole("region", { name: "DMs" }).compareDocumentPosition(row()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(row()!);
    expect(onOpenAgents).toHaveBeenCalledExactlyOnceWith(row());
    rerender({ agents: 6, agentsOpen: true });
    expect(row()).toHaveAttribute("aria-expanded", "true");
  });

  it("isn't there while there are none to ask, as while Ember AI is off, nor while Activity shows only what's unread", () => {
    const { rerender } = renderSidebar();
    expect(row()).toBeNull();
    rerender({ agents: 2, unreadOnly: true });
    expect(row()).toBeNull();
    rerender({ agents: 2 });
    expect(row()).toHaveAccessibleName("Available Agents, 2 to ask");
  });
});

describe("Hide a room", () => {
  it("leaves out the rooms and DMs you've hidden, even the one open", () => {
    const hidden = { id: "design", name: "design", kind: "open" as const, icon: null, unread: true, involvement: "invisible" as const };
    const hiddenDirect: SidebarRoom = { ...direct("d2", [ada!, linus!], true), involvement: "invisible" };
    renderSidebar({ rooms: [...rooms, hidden, direct("d1", [ada!, grace!]), hiddenDirect], currentRoomId: "design" });
    expect(listed()).toEqual(["#general", "#random"]);
    expect(directRows().map((row) => row.textContent)).toEqual(["Direct message with Grace"]);
  });
});
