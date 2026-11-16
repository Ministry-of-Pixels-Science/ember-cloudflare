import type { DirectoryUser, DirectRoom, Me } from "@ember/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { guardLeaving } from "@/hooks/use-route";
import type { RoomAnswer } from "@/lib/room-list";
import { NewDirectDialog, startedWithout } from "./new-direct-dialog";

/** Someone in the people directory, active unless `status` says otherwise. */
const person = (id: string, name: string, status: DirectoryUser["status"] = "active"): DirectoryUser => ({
  id,
  name,
  bio: null,
  role: "member",
  status,
  avatarUrl: `/users/${id}/avatar`,
});

const ada = person("u1", "Ada Lovelace");
const grace = person("u2", "Grace Hopper");
const linus = person("u3", "Linus Torvalds");
const alan = person("u4", "alan Turing");
const barbara = person("u5", "Barbara Liskov");
const edsger = person("u6", "Edsger Dijkstra", "deactivated");
const byron = person("u7", "Ada Byron");
const everyone = [ada, grace, linus, alan, barbara, edsger, byron];
const directory = (people: DirectoryUser[]): People => new Map(people.map((p) => [p.id, p]));

interface Options {
  people?: DirectoryUser[];
  /** What loading the people again does, which settles at once by default. */
  reloadPeople?: () => Promise<void>;
  /** Puts the link that opened it in the page. */
  opener?: boolean;
  /** Whether Ada is an administrator, which she isn't by default. */
  administrator?: boolean;
}

/** New direct message as Ada opens it, over a page with the drawer's toggle in its header. */
function showDialog({ people = everyone, reloadPeople = vi.fn(async () => {}), opener = true, administrator = false }: Options = {}) {
  const me: Me = { id: ada.id, name: ada.name, administrator };
  const [onClose, onLeftOut, onFailed, onAnswered] = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  const askForRoom = vi.fn(() => (answer: RoomAnswer) => onAnswered(answer));
  render(
    <>
      <button type="button" data-ember-sidebar-toggle>
        Open conversations
      </button>
      {opener && <a href="/rooms/directs/new">DMs</a>}
    </>,
  );
  const link = opener ? screen.getByRole("link", { name: "DMs" }) : null;
  const dialog = (people: DirectoryUser[]) => (
    <PeopleContext value={directory(people)}>
      <NewDirectDialog opener={link} me={me} reloadPeople={reloadPeople} askForRoom={askForRoom} onClose={onClose} onLeftOut={onLeftOut} onFailed={onFailed} />
    </PeopleContext>
  );
  const { rerender } = render(dialog(people));
  return { onClose, onLeftOut, onFailed, askForRoom, onAnswered, rerender: (people: DirectoryUser[]) => rerender(dialog(people)), user: userEvent.setup() };
}

const search = () => screen.getByRole("combobox", { name: "Search people" });
const status = () => screen.getByRole("status");
/** The people listed, top to bottom. */
const listed = () => within(screen.getByRole("listbox", { name: "People" })).queryAllByRole("option").map((option) => option.textContent);
const option = (name: string) => screen.getByRole("option", { name });
const chips = () => within(screen.queryByRole("group", { name: "Selected people" }) ?? document.createElement("div")).queryAllByRole("button").map((chip) => chip.textContent);
const start = () => screen.getByRole("button", { name: "Start conversation" });

/** A DM between Ada and `others`, as the server answers it. */
const directWith = (id: string, others: DirectoryUser[]): DirectRoom => ({
  id,
  kind: "direct",
  members: [ada, ...others].map(({ id, name }) => ({ id, name })),
  activeAt: "2026-10-15T12:00:00.000Z",
});

/** Goes Back, as far as the page can tell. */
const goBack = () => act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: null })));

/** Holds `POST /api/directs` until the returned function answers it, keeping what it was sent. */
function holdStart() {
  let answer = (_: Response) => {};
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => (answer = resolve)));
  return { fetch, answer: (response: Response) => act(async () => answer(response)) };
}

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("Where bots show up", () => {
  it("finds active bots with everyone else, but not deleted ones", async () => {
    const bots = [{ ...person("b1", "Build Bot"), role: "bot" as const }, { ...person("b2", "Old Bot", "deactivated"), role: "bot" as const }];
    const { user } = showDialog({ people: [...everyone, ...bots] });
    await waitFor(() => expect(listed()).toEqual(["Ada Byron", "alan Turing", "Barbara Liskov", "Build Bot", "Grace Hopper", "Linus Torvalds"]));
    await user.type(search(), "bot");
    expect(listed()).toEqual(["Build Bot"]);
  });

  it("badges @ember as an agent after its name, and picks it by that name", async () => {
    const ember = { ...person("ember", "Ember"), role: "bot" as const };
    const { user } = showDialog({ people: [...everyone, ember] });
    await user.type(search(), "em");
    expect(listed()).toEqual(["Ember Agent"]);
    expect(within(option("Ember Agent")).getByText("Agent")).toHaveAttribute("data-slot", "badge");
    await user.click(option("Ember Agent"));
    expect(chips()).toEqual(["Ember"]);
  });

  it("badges every agent the people directory lists, and no other bot", async () => {
    const bots = [{ ...person("b1", "Build Bot"), role: "bot" as const }, { ...person("b2", "Recap"), role: "bot" as const, agent: true as const }];
    showDialog({ people: [...everyone, ...bots] });
    await waitFor(() => expect(listed()).toEqual(["Ada Byron", "alan Turing", "Barbara Liskov", "Build Bot", "Grace Hopper", "Linus Torvalds", "Recap Agent"]));
    expect(within(option("Recap Agent")).getByText("Agent")).toHaveAttribute("data-slot", "badge");
  });
});

describe("AI agents only administrators can ask", () => {
  const agents = [
    { ...person("b2", "Recap"), role: "bot" as const, agent: true as const },
    { ...person("b3", "Herald"), role: "bot" as const, agent: true as const, adminsOnly: true as const },
  ];

  it("leaves them out for anyone else, as a DM with one wouldn't start", async () => {
    const { user } = showDialog({ people: [...everyone, ...agents] });
    await waitFor(() => expect(listed()).toContain("Recap Agent"));
    expect(listed()).not.toContain("Herald Agent");
    await user.type(search(), "herald");
    expect(listed()).toEqual([]);
    expect(status()).toHaveTextContent("No people found. Try another name.");
  });

  it("lists them for an administrator", async () => {
    const { user } = showDialog({ people: [...everyone, ...agents], administrator: true });
    await user.type(search(), "herald");
    expect(listed()).toEqual(["Herald Agent"]);
  });

  it("says which of them the DM started without, as one only available in admin DMs is left out of a DM with anyone else", async () => {
    const [recap, herald] = agents;
    const { answer } = holdStart();
    const { user, onLeftOut, onClose } = showDialog({ people: [...everyone, ...agents], administrator: true });
    for (const name of ["Herald Agent", "Grace Hopper"]) await user.click(option(name));
    await user.click(start());
    await answer(Response.json({ room: directWith("d1", [grace]) }, { status: 201 }));
    expect(onLeftOut).toHaveBeenCalledExactlyOnceWith([herald]);
    expect(location.pathname).toBe("/rooms/d1");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());

    expect(startedWithout(["Herald"])).toBe("Herald is only for DMs between administrators, so this DM is without it.");
    expect(startedWithout(["Herald", recap!.name])).toBe("Herald and Recap are only for DMs between administrators, so this DM is without them.");
  });

  it("says nothing of a DM that starts with everyone picked", async () => {
    const [, herald] = agents;
    const { answer } = holdStart();
    const { user, onLeftOut, onClose } = showDialog({ people: [...everyone, ...agents], administrator: true });
    await user.click(option("Herald Agent"));
    await user.click(start());
    await answer(Response.json({ room: directWith("d2", [herald!]) }, { status: 201 }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onLeftOut).not.toHaveBeenCalled();
  });
});

describe("New direct message dialog", () => {
  it("opens titled New direct message, focused on the search, listing everyone else active by name", async () => {
    showDialog();
    const dialog = screen.getByRole("dialog", { name: "New direct message" });
    expect(dialog).toHaveAccessibleDescription("Find people by full name. You can also type @name.");
    expect(search()).toHaveFocus();
    expect(search()).toHaveAttribute("placeholder", "Search by name or @name");
    // Entering it keeps the usual cursor.
    expect(search()).toHaveAttribute("data-ember-preserve-selection");
    expect(search()).toHaveAttribute("aria-controls", screen.getByRole("listbox", { name: "People" }).id);
    // Ada, deactivated Edsger and the case of a name don't count.
    await waitFor(() => expect(listed()).toEqual(["Ada Byron", "alan Turing", "Barbara Liskov", "Grace Hopper", "Linus Torvalds"]));
    expect(status()).toHaveTextContent("Choose one or more people.");
    expect(screen.queryByRole("group", { name: "Selected people" })).not.toBeInTheDocument();
    expect(start()).toBeDisabled();
  });

  it("lists 20 people at a time, with Show more people until everyone's shown", async () => {
    const many = Array.from({ length: 45 }, (_, i) => person(`p${i}`, `Person ${String(i).padStart(2, "0")}`));
    const { user } = showDialog({ people: [ada, ...many] });
    expect(listed()).toHaveLength(20);
    expect(listed().at(-1)).toBe("Person 19");
    await user.click(screen.getByRole("button", { name: "Show more people" }));
    expect(listed()).toHaveLength(40);
    await user.click(screen.getByRole("button", { name: "Show more people" }));
    expect(listed()).toHaveLength(45);
    expect(screen.queryByRole("button", { name: "Show more people" })).not.toBeInTheDocument();
    // Focus stays in the dialog as the button goes.
    expect(search()).toHaveFocus();

    // A new search starts again from the first 20.
    await user.type(search(), "Person");
    expect(listed()).toHaveLength(20);
  });

  it("searches as you type, anywhere in a name and in any case, without the @s before it", async () => {
    const { user } = showDialog();
    await user.type(search(), "@@ADA");
    expect(listed()).toEqual(["Ada Byron"]);
    await user.clear(search());
    await user.type(search(), "  RING ");
    expect(listed()).toEqual(["alan Turing"]);
    await user.clear(search());
    await user.type(search(), "Dijkstra");
    expect(listed()).toEqual([]);
    expect(status()).toHaveTextContent("No people found. Try another name.");
  });

  it("finds people by the start of their usernames too, which it shows after their names", async () => {
    const amazing = { ...grace, username: "amazing.grace" };
    const { user } = showDialog({ people: [ada, amazing, linus, alan] });
    await user.type(search(), "@Amaz");
    expect(listed()).toEqual(["Grace Hopper @amazing.grace"]);
    await user.clear(search());
    await user.type(search(), "zing");
    expect(listed()).toEqual([]);
  });

  it("picks people by pointer, as chips that take them back out, which leave the list", async () => {
    const { user } = showDialog();
    await user.click(option("Grace Hopper"));
    await user.click(option("alan Turing"));
    expect(chips()).toEqual(["Grace Hopper", "alan Turing"]);
    expect(listed()).toEqual(["Ada Byron", "Barbara Liskov", "Linus Torvalds"]);
    expect(search()).toHaveFocus();
    expect(start()).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Remove Grace Hopper" }));
    expect(chips()).toEqual(["alan Turing"]);
    expect(listed()).toEqual(["Ada Byron", "Barbara Liskov", "Grace Hopper", "Linus Torvalds"]);
    expect(search()).toHaveFocus();

    await user.type(search(), "turing");
    expect(listed()).toEqual([]);
    expect(status()).toHaveTextContent("Everyone shown is selected.");
  });

  it("moves through the list with the arrows, round from either end, and picks with Enter", async () => {
    const { user } = showDialog();
    const highlighted = () => screen.queryByRole("option", { selected: true })?.textContent ?? null;
    // Enter with nobody highlighted does nothing.
    await user.keyboard("{Enter}");
    expect(chips()).toEqual([]);

    await user.keyboard("{ArrowUp}");
    expect(highlighted()).toBe("Linus Torvalds");
    expect(search()).toHaveAttribute("aria-activedescendant", option("Linus Torvalds").id);
    await user.keyboard("{ArrowDown}");
    expect(highlighted()).toBe("Ada Byron");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(chips()).toEqual(["Barbara Liskov"]);
    expect(highlighted()).toBeNull();
    expect(search()).not.toHaveAttribute("aria-activedescendant");

    await user.keyboard("{ArrowDown}");
    expect(highlighted()).toBe("Ada Byron");
    // Typing starts again from nobody.
    await user.type(search(), "a");
    expect(highlighted()).toBeNull();
  });

  it("says there's nobody else to message", () => {
    showDialog({ people: [ada, edsger] });
    expect(listed()).toEqual([]);
    expect(status()).toHaveTextContent("No other people are available to message yet.");
  });

  it("loads the people again each time it opens, saying so until a first copy comes, with Try again should it fail", async () => {
    let fail = (_: Error) => {};
    const reloadPeople = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    const { user, rerender } = showDialog({ people: [], reloadPeople });
    expect(reloadPeople).toHaveBeenCalledOnce();
    expect(status()).toHaveTextContent("Loading people…");
    expect(screen.getByRole("listbox", { name: "People" })).toHaveAttribute("aria-busy", "true");

    await act(async () => fail(new TypeError("Failed to fetch")));
    expect(status()).toHaveTextContent("Couldn’t load people. Please try again.");
    expect(screen.getByRole("listbox", { name: "People" })).not.toHaveAttribute("aria-busy");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reloadPeople).toHaveBeenCalledTimes(2);
    expect(status()).toHaveTextContent("Loading people…");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();

    rerender(everyone);
    expect(listed()).toHaveLength(5);
    expect(status()).toHaveTextContent("Choose one or more people.");
  });

  it("lists the people it has while it loads them again, and keeps them if that fails", async () => {
    showDialog({ reloadPeople: () => Promise.reject(new TypeError("Failed to fetch")) });
    await act(async () => {});
    expect(listed()).toHaveLength(5);
    expect(status()).toHaveTextContent("Choose one or more people.");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("starts the DM between you and the people picked, lists it, and goes there", async () => {
    const { fetch, answer } = holdStart();
    const { user, askForRoom, onAnswered, onClose } = showDialog();
    await user.click(option("Linus Torvalds"));
    await user.click(option("Grace Hopper"));
    await user.click(start());
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/directs", expect.objectContaining({ method: "POST", body: JSON.stringify({ userIds: [linus.id, grace.id] }) }));
    expect(askForRoom).toHaveBeenCalledOnce();
    expect(status()).toHaveTextContent("Starting conversation…");
    expect(start()).toBeDisabled();

    // It can't close or change while the DM starts.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Remove Linus Torvalds" }));
    await user.click(option("Ada Byron"));
    expect(screen.getByRole("dialog", { name: "New direct message" })).toBeInTheDocument();
    expect(chips()).toEqual(["Linus Torvalds", "Grace Hopper"]);

    const room = directWith("d1", [grace, linus]);
    await answer(Response.json({ room }, { status: 201 }));
    expect(onAnswered).toHaveBeenCalledExactlyOnceWith({ type: "saved", room });
    expect(location.pathname).toBe("/rooms/d1");
    await waitFor(() => expect(onClose).toHaveBeenCalledExactlyOnceWith(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Focus is left for the DM's composer to take.
    expect(screen.getByRole("link", { name: "DMs" })).not.toHaveFocus();
  });

  it("says, once it's closed, that it started the DM the page shows, whose composer is still to take focus", async () => {
    history.replaceState(null, "", "/rooms/d1");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ room: directWith("d1", [grace]) }, { status: 201 }));
    const { user, onClose } = showDialog();
    await user.click(option("Grace Hopper"));
    await user.click(start());
    await waitFor(() => expect(onClose).toHaveBeenCalledExactlyOnceWith(true));
    expect(location.pathname).toBe("/rooms/d1");
    expect(screen.getByRole("link", { name: "DMs" })).not.toHaveFocus();
  });

  it("keeps the people picked when the conversation can't start, and says so until they change", async () => {
    const { answer } = holdStart();
    const { user, onFailed } = showDialog();
    await user.click(option("Grace Hopper"));
    await user.click(start());
    await answer(Response.json({ error: "Something went wrong" }, { status: 500 }));
    expect(status()).toHaveTextContent("Couldn’t start the conversation. Please try again.");
    expect(chips()).toEqual(["Grace Hopper"]);
    expect(start()).toBeEnabled();
    expect(location.pathname).toBe("/");
    expect(onFailed).not.toHaveBeenCalled();

    await user.click(option("Linus Torvalds"));
    expect(status()).toHaveTextContent("Choose one or more people.");
  });

  it("hands on a session that's ended", async () => {
    const { answer } = holdStart();
    const { user, onFailed } = showDialog();
    await user.click(option("Grace Hopper"));
    await user.click(start());
    await answer(Response.json({ error: "Not signed in" }, { status: 401 }));
    expect(onFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401 }));
  });

  it("asks before a page with changes to lose is left, starting the DM only once the page lets it", async () => {
    const { fetch, answer } = holdStart();
    let proceed: (() => unknown) | null = null;
    const guard = vi.fn((_: string | null, go: () => unknown) => {
      proceed = go;
      return true;
    });
    const release = guardLeaving(guard);
    try {
      const { user } = showDialog();
      await user.click(option("Grace Hopper"));
      await user.click(start());
      expect(guard).toHaveBeenCalledExactlyOnceWith(null, expect.any(Function));
      expect(fetch).not.toHaveBeenCalled();
      expect(status()).toHaveTextContent("Choose one or more people.");

      release();
      const left = act(async () => proceed!());
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await answer(Response.json({ room: directWith("d1", [grace]) }, { status: 201 }));
      expect(await left).toBe(true);
      expect(location.pathname).toBe("/rooms/d1");
    } finally {
      release();
    }
  });

  it("settles with the page kept when the DM that would have left it doesn't start", async () => {
    const { answer } = holdStart();
    let proceed: (() => unknown) | null = null;
    const release = guardLeaving((_, go) => {
      proceed = go;
      return true;
    });
    try {
      const { user } = showDialog();
      await user.click(option("Grace Hopper"));
      await user.click(start());
      release();
      const left = act(async () => proceed!());
      await answer(Response.json({ error: "Something went wrong" }, { status: 500 }));
      expect(await left).toBe(false);
      expect(status()).toHaveTextContent("Couldn’t start the conversation. Please try again.");
    } finally {
      release();
    }
  });

  it.each([
    ["Cancel", (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Cancel" }))],
    ["Close", (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Close" }))],
    ["Escape", (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}")],
    ["a click beside it", (user: ReturnType<typeof userEvent.setup>) => user.click(document.querySelector("[data-slot=dialog-overlay]")!)],
  ])("closes with %s, giving focus back to the link that opened it", async (_, close) => {
    const { user, onClose } = showDialog();
    await close(user);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "DMs" })).toHaveFocus();
  });

  it("closes as Back or Forward goes to another page", async () => {
    const { onClose } = showDialog();
    goBack();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "DMs" })).toHaveFocus();
  });

  it("stays open through Back or Forward while a DM starts", async () => {
    const { answer } = holdStart();
    const { user, onClose } = showDialog();
    await user.click(option("Grace Hopper"));
    await user.click(start());
    goBack();
    expect(screen.getByRole("dialog", { name: "New direct message" })).toBeInTheDocument();
    await answer(Response.json({ room: directWith("d1", [grace]) }, { status: 201 }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(location.pathname).toBe("/rooms/d1");
  });

  it("gives focus to the drawer's toggle when what opened it has gone with the drawer", async () => {
    const { user, onClose } = showDialog({ opener: false });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Open conversations" })).toHaveFocus();
  });
});
