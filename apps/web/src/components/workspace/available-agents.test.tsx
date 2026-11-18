import { ASSISTANT_ID, startingInvolvement, type DirectoryUser, type Me, type SharedRoom, type SidebarRoom } from "@ember/protocol";
import { EMBER_DOES, MAX_AGENTS, type AvailableAgent } from "@ember/protocol/agents";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { agentSettingsPath, guardLeaving, NEW_AGENT_PATH } from "@/hooks/use-route";
import { ApiError } from "@/lib/api";
import { AvailableAgentsDialog, directOnly, HOW_TO_ASK, NO_AGENTS } from "./available-agents";

/** An agent as Available Agents lists it, in every open room and for everyone to ask unless `agent` says. */
const agent = (id: string, name: string, agent: Partial<AvailableAgent> = {}): AvailableAgent => ({
  id,
  name,
  bio: null,
  role: "bot",
  status: "active",
  avatarUrl: `/users/${id}/avatar?v=1`,
  agent: true,
  description: `${name} does one thing well.`,
  access: "everyone",
  rooms: null,
  ...agent,
});

const EMBER = agent(ASSISTANT_ID, "Ember", { description: EMBER_DOES });
const HERALD = agent("0mgk3x2a9b4c62", "Herald", {
  description: "Drafts announcements and release notes.",
  access: "admins",
  adminsOnly: true,
  rooms: [
    { id: "general", name: "general" },
    { id: "launch", name: "Launch" },
  ],
});
const RECAP = agent("0mgk3x2a9b4c60", "Recap", { description: "Sums up threads into decisions and to-dos.", rooms: [] });
const SCOUT = agent("0mgk3x2a9b4c61", "Scout", {
  description: "Looks up what's new on the web.",
  rooms: [
    { id: "research", name: "research" },
    { id: "launch", name: "Launch" },
  ],
});
const STEWARD = agent("0mgk3x2a9b4c63", "Steward", { description: "Helps admins with membership.", access: "admin-dms", adminsOnly: true, rooms: [] });

/** What everyone can ask, and what an administrator can. */
const FOR_EVERYONE = [EMBER, RECAP, SCOUT];
const FOR_ADMINS = [EMBER, HERALD, RECAP, SCOUT, STEWARD];

/** An agent as the people directory lists it. */
const listed = ({ description: _, access: __, rooms: ___, ...person }: AvailableAgent): DirectoryUser => person;
const directory = (agents: AvailableAgent[]): People => new Map(agents.map((agent) => [agent.id, listed(agent)]));

/** A room in the sidebar. */
const room = (shared: SharedRoom): SidebarRoom => ({ ...shared, unread: false, involvement: startingInvolvement(shared) });
/** Launch, as it's called now, and a DM, which no chip names. */
const ROOMS: SidebarRoom[] = [
  room({ id: "general", name: "general", kind: "open", icon: null }),
  room({ id: "launch", name: "Liftoff", kind: "closed", icon: "rocket" }),
  { id: "research", kind: "direct", members: [], activeAt: "2026-11-15T12:00:00.000Z", unread: false, involvement: "everything" },
];

/** Answers listing the agents with `agents`, or as `answer` says. */
const serve = (answer: () => Response | Promise<Response>) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (`${init?.method ?? "GET"} ${String(input)}` === "GET /api/agents") return answer();
    throw new Error(`Unexpected request for ${init?.method ?? "GET"} ${String(input)}`);
  });

interface Options {
  /** Whether Ada is an administrator, which she isn't by default. */
  administrator?: boolean;
  /** The agents the server lists her, which are the ones she can ask by default. */
  agents?: AvailableAgent[];
  /** What the server answers, which lists her `agents` by default. */
  answer?: () => Response | Promise<Response>;
  /** What starting a DM does, which goes to it by default. */
  onStartDirect?: (agent: AvailableAgent) => Promise<boolean>;
  /** Puts the row that opened it in the page. */
  opener?: boolean;
}

/** Available Agents as Ada opens it from the sidebar's row, over a page with the drawer's toggle in its header. */
function showDialog({
  administrator = false,
  agents = administrator ? FOR_ADMINS : FOR_EVERYONE,
  answer = () => Response.json({ agents }),
  onStartDirect = goesToDirect,
  opener = true,
}: Options = {}) {
  const me: Me = { id: "u1", name: "Ada", administrator };
  const fetch = serve(answer);
  const [onClose, onFailed] = [vi.fn(), vi.fn()];
  const starts = vi.fn(onStartDirect);
  render(
    <>
      <button type="button" data-ember-sidebar-toggle>
        Open conversations
      </button>
      {opener && <button type="button">Available Agents row</button>}
    </>,
  );
  const row = opener ? screen.getByRole("button", { name: "Available Agents row" }) : null;
  const dialog = (people: People, rooms: SidebarRoom[]) => (
    <PeopleContext value={people}>
      <AvailableAgentsDialog me={me} rooms={rooms} opener={row} onClose={onClose} onStartDirect={starts as never} onFailed={onFailed} />
    </PeopleContext>
  );
  const { rerender } = render(dialog(directory(agents), ROOMS));
  return {
    fetch,
    onClose,
    onFailed,
    onStartDirect: starts,
    showPeople: (people: People) => rerender(dialog(people, ROOMS)),
    showRooms: (rooms: SidebarRoom[]) => rerender(dialog(directory(agents), rooms)),
    user: userEvent.setup(),
  };
}

/** Starts the DM and goes to it, as the workspace does. */
const goesToDirect = async () => {
  history.pushState(null, "", "/rooms/d1");
  return true;
};

const dialog = () => screen.getByRole("dialog", { name: "Available Agents" });
/** The agents listed, top to bottom, once they've come. */
const tabs = async () => (await within(dialog()).findAllByRole("tab")).map((tab) => tab.textContent);
/** The tab of the agent called `name`, which says after it how it's kept, if it is. */
const tab = (name: string) => within(dialog()).findByRole("tab", { name: (said) => said.startsWith(name) });
const panel = () => within(dialog()).getByRole("tabpanel");
/** What `element` says to a screen reader, which hears none of its icons. */
function said(element: Element) {
  const heard = element.cloneNode(true) as Element;
  heard.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
  return heard.textContent;
}
/** Where the agent picked works, as its chips say, left to right. */
const chips = () => [...within(panel()).getByRole("region", { name: "Available in" }).lastElementChild!.children].map(said);
const messageButton = (name: string) => within(panel()).getByRole("button", { name: `Message ${name}` });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("Available Agents", () => {
  it("is busy until its agents come, and then lists them, with the first picked", async () => {
    let answer: (response: Response) => void = () => {};
    const fetch = serve(() => new Promise<Response>((resolve) => (answer = resolve)));
    render(
      <PeopleContext value={directory(FOR_EVERYONE)}>
        <AvailableAgentsDialog me={{ id: "u1", name: "Ada", administrator: false }} rooms={ROOMS} opener={null} onClose={vi.fn()} onStartDirect={vi.fn()} onFailed={vi.fn()} />
      </PeopleContext>,
    );
    expect(dialog()).toHaveAttribute("aria-busy", "true");
    expect(dialog()).toHaveAccessibleDescription(HOW_TO_ASK);
    expect(dialog()).toHaveFocus();
    expect(within(dialog()).queryByRole("tab")).not.toBeInTheDocument();
    expect(within(dialog()).queryByText(NO_AGENTS)).not.toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    await act(async () => answer(Response.json({ agents: FOR_EVERYONE })));
    expect(await tabs()).toEqual(["Ember", "Recap", "Scout"]);
    expect(dialog()).not.toHaveAttribute("aria-busy");
    expect(within(dialog()).getByRole("tablist", { name: "Agents" })).toHaveAttribute("aria-orientation", "vertical");
    expect(await tab("Ember")).toHaveAttribute("aria-selected", "true");
    // For the arrows to move from.
    expect(await tab("Ember")).toHaveFocus();
    expect(panel()).toHaveAccessibleName("Ember");
    expect(within(panel()).getByRole("heading", { level: 3 })).toHaveTextContent("Ember");
    expect(within(panel()).getByText(EMBER_DOES)).toBeInTheDocument();
    expect(panel()).toHaveTextContent("Type @Ember in a room it's in, or message it directly.");
    expect(chips()).toEqual(["Every room"]);
  });

  it("shows the agent picked: what it does, and the rooms it shares with them as the sidebar calls them now", async () => {
    const { user, showRooms } = showDialog();
    await user.click(await tab("Scout"));
    expect(await tab("Scout")).toHaveAttribute("aria-selected", "true");
    expect(await tab("Ember")).toHaveAttribute("aria-selected", "false");
    expect(panel()).toHaveAccessibleName("Scout");
    expect(within(panel()).getByText("Looks up what's new on the web.")).toBeInTheDocument();
    expect(panel()).toHaveTextContent("Type @Scout in a room it's in, or message it directly.");
    // research isn't a room the sidebar lists, so it's as the server named it.
    expect(chips()).toEqual(["research", "Liftoff"]);
    expect(within(panel()).getByRole("link", { name: "research" })).toHaveAttribute("href", "/rooms/research");
    const liftoff = within(panel()).getByRole("link", { name: "Liftoff" });
    expect(liftoff).toHaveAttribute("href", "/rooms/launch");
    expect(liftoff.querySelector("[data-icon]")).toHaveAttribute("data-icon", "rocket");

    showRooms([room({ id: "launch", name: "Launch day", kind: "closed", icon: null })]);
    expect(chips()).toEqual(["research", "Launch day"]);
  });

  it("says to message an agent directly when it shares no room with them", async () => {
    const { user } = showDialog();
    await user.click(await tab("Recap"));
    expect(within(panel()).getByText(directOnly("everyone"))).toBeInTheDocument();
    expect(chips()).toEqual(["Direct messages only"]);
  });

  it("moves through the agents with the arrows, Home and End, picking each", async () => {
    const { user } = showDialog();
    // The agent picked takes focus in an effect, after its tab is rendered.
    const ember = await tab("Ember");
    await waitFor(() => expect(ember).toHaveFocus());
    const moves: Array<[string, string]> = [
      ["{ArrowDown}", "Recap"],
      ["{ArrowRight}", "Scout"],
      ["{ArrowDown}", "Ember"],
      ["{ArrowUp}", "Scout"],
      ["{ArrowLeft}", "Recap"],
      ["{Home}", "Ember"],
      ["{End}", "Scout"],
    ];
    for (const [key, name] of moves) {
      await user.keyboard(key);
      expect(await tab(name)).toHaveFocus();
      expect(await tab(name)).toHaveAttribute("aria-selected", "true");
      expect(panel()).toHaveAccessibleName(name);
    }
    // Only the one picked is a stop for Tab.
    expect((await within(dialog()).findAllByRole("tab")).map((tab) => tab.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("runs the agents across the top on a phone, with Close beside the title", async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({ matches: media === "(width <= 37.5rem)", media, addEventListener() {}, removeEventListener() {} }));
    showDialog({ administrator: true });
    await tab("Ember");
    expect(within(dialog()).getByRole("tablist", { name: "Agents" })).toHaveAttribute("aria-orientation", "horizontal");
    expect(within(dialog()).getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(within(dialog()).queryByRole("link", { name: "New agent" })).not.toBeInTheDocument();
  });

  it("says there are no agents to ask when the server lists none", async () => {
    showDialog({ agents: [] });
    expect(await within(dialog()).findByText(NO_AGENTS)).toBeInTheDocument();
    expect(within(dialog()).queryByRole("tab")).not.toBeInTheDocument();
    expect(within(dialog()).queryByRole("tabpanel")).not.toBeInTheDocument();
  });

  it("copies an agent's @name", async () => {
    const { user } = showDialog();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await tab("Ember");
    const handle = within(panel()).getByRole("button", { name: "Copy @Ember" });
    expect(handle).toHaveTextContent("@Ember");
    await user.click(handle);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("@Ember");
    await waitFor(() => expect(handle).toHaveClass("text-positive"));
  });
});

describe("Available Agents, for someone who isn't an administrator", () => {
  it("marks no agent, and links to no agent's page nor to New agent", async () => {
    showDialog();
    expect(await tabs()).toEqual(["Ember", "Recap", "Scout"]);
    expect(within(dialog()).queryByRole("img")).not.toBeInTheDocument();
    expect(within(dialog()).queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(dialog()).queryByRole("link", { name: "New agent" })).not.toBeInTheDocument();
    expect(messageButton("Ember")).toBeInTheDocument();
  });

  it("leaves out an agent the people directory keeps for administrators, whatever the server listed", async () => {
    const { showPeople } = showDialog({ agents: [EMBER, HERALD, SCOUT] });
    expect(await tabs()).toEqual(["Ember", "Scout"]);
    showPeople(directory([EMBER, HERALD, { ...SCOUT, adminsOnly: true }]));
    expect(await tabs()).toEqual(["Ember"]);
  });
});

describe("Available Agents, for an administrator", () => {
  it("marks the agents kept for administrators, in the list and beside their names", async () => {
    const { user } = showDialog({ administrator: true });
    expect(await tabs()).toEqual(["Ember", "Herald", "Recap", "Scout", "Steward"]);
    expect(within(await tab("Herald")).getByRole("img", { name: "Admins only" })).toBeInTheDocument();
    expect(within(await tab("Steward")).getByRole("img", { name: "Admin DMs only" })).toBeInTheDocument();
    expect(within(await tab("Ember")).queryByRole("img")).not.toBeInTheDocument();

    await user.click(await tab("Herald"));
    expect(within(panel()).getByText("Admins only")).toBeInTheDocument();
    expect(chips()).toEqual(["general", "Liftoff"]);

    await user.click(await tab("Steward"));
    expect(within(panel()).getByText("Admin DMs only")).toBeInTheDocument();
    expect(within(panel()).getByText(directOnly("admin-dms"))).toBeInTheDocument();
    expect(chips()).toEqual(["Direct messages only"]);
  });

  it("links to the page of the agent picked, and to New agent, closing as either is followed", async () => {
    const { user, onClose } = showDialog({ administrator: true });
    await user.click(await tab("Scout"));
    expect(within(dialog()).getByRole("link", { name: "New agent" })).toHaveAttribute("href", NEW_AGENT_PATH);
    const edit = within(panel()).getByRole("link", { name: "Edit" });
    expect(edit).toHaveAttribute("href", agentSettingsPath(SCOUT.id));

    await user.click(edit);
    await waitFor(() => expect(onClose).toHaveBeenCalledExactlyOnceWith(false));
    expect(location.pathname).toBe(agentSettingsPath(SCOUT.id));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers no New agent once there are as many agents as Ember keeps", async () => {
    const full = Array.from({ length: MAX_AGENTS }, (_, index) => agent(`0mgk3x2a9b4d${String(index).padStart(2, "0")}`, `Agent ${index + 1}`));
    showDialog({ administrator: true, agents: [EMBER, ...full] });
    expect(await tabs()).toHaveLength(MAX_AGENTS + 1);
    expect(within(dialog()).queryByRole("link", { name: "New agent" })).not.toBeInTheDocument();
  });
});

describe("Available Agents and the people directory", () => {
  it("shows each agent by the name and picture it has now", async () => {
    const { showPeople } = showDialog();
    await tab("Ember");
    showPeople(directory([EMBER, RECAP, { ...SCOUT, name: "Pathfinder", avatarUrl: `/users/${SCOUT.id}/avatar?v=2` }]));
    expect(await tabs()).toEqual(["Ember", "Recap", "Pathfinder"]);
    expect((await tab("Pathfinder")).querySelector("img")).toHaveAttribute("src", `/users/${SCOUT.id}/avatar?v=2`);
  });

  it("drops an agent that's deleted, or that the directory no longer lists, and picks the first in place of one picked", async () => {
    const { user, showPeople } = showDialog();
    await user.click(await tab("Scout"));
    showPeople(directory([EMBER, RECAP, { ...SCOUT, status: "deactivated" }]));
    expect(await tabs()).toEqual(["Ember", "Recap"]);
    expect(await tab("Ember")).toHaveAttribute("aria-selected", "true");
    expect(panel()).toHaveAccessibleName("Ember");

    showPeople(directory([EMBER]));
    expect(await tabs()).toEqual(["Ember"]);
  });
});

describe("Messaging an agent from Available Agents", () => {
  it("starts the DM with the agent picked, and closes, saying it did, which leaves focus for the DM's composer", async () => {
    const { user, onStartDirect, onClose } = showDialog();
    await user.click(await tab("Scout"));
    await user.click(messageButton("Scout"));
    await waitFor(() => expect(onClose).toHaveBeenCalledExactlyOnceWith(true));
    expect(onStartDirect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: SCOUT.id, name: "Scout" }));
    expect(location.pathname).toBe("/rooms/d1");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Available Agents row" })).not.toHaveFocus();
  });

  it("starts it once, however many times the button is pressed while it starts", async () => {
    let started: (went: boolean) => void = () => {};
    const { user, onStartDirect, onClose } = showDialog({ onStartDirect: () => new Promise<boolean>((resolve) => (started = resolve)) });
    await tab("Ember");
    await user.click(messageButton("Ember"));
    expect(messageButton("Ember")).toHaveAttribute("aria-disabled", "true");
    await user.click(messageButton("Ember"));
    expect(onStartDirect).toHaveBeenCalledOnce();

    await act(async () => started(true));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("stays open when the DM doesn't start, ready to try again", async () => {
    const { user, onStartDirect, onClose } = showDialog({ onStartDirect: async () => false });
    await tab("Ember");
    await user.click(messageButton("Ember"));
    await waitFor(() => expect(messageButton("Ember")).not.toHaveAttribute("aria-disabled"));
    expect(dialog()).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(messageButton("Ember"));
    expect(onStartDirect).toHaveBeenCalledTimes(2);
  });

  it("waits for a page with unsaved changes to let it leave", async () => {
    let proceed: (() => unknown) | null = null;
    const guard = vi.fn((_: string | null, go: () => unknown) => {
      proceed = go;
      return true;
    });
    const release = guardLeaving(guard);
    try {
      const { user, onStartDirect, onClose } = showDialog();
      await tab("Ember");
      await user.click(messageButton("Ember"));
      expect(guard).toHaveBeenCalledExactlyOnceWith(null, expect.any(Function));
      expect(onStartDirect).not.toHaveBeenCalled();

      release();
      let left: unknown;
      await act(async () => (left = await proceed!()));
      expect(left).toBe(true);
      expect(onStartDirect).toHaveBeenCalledOnce();
      await waitFor(() => expect(onClose).toHaveBeenCalledExactlyOnceWith(true));
    } finally {
      release();
    }
  });
});

describe("Closing Available Agents", () => {
  it.each([
    ["Close", (user: ReturnType<typeof userEvent.setup>) => user.click(within(dialog()).getByRole("button", { name: "Close" }))],
    ["Escape", (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}")],
    ["a click beside it", (user: ReturnType<typeof userEvent.setup>) => user.click(document.querySelector("[data-slot=dialog-overlay]")!)],
  ])("closes with %s, and gives focus back to the row that opened it", async (_, close) => {
    const { user, onClose } = showDialog();
    await tab("Ember");
    await close(user);
    await waitFor(() => expect(onClose).toHaveBeenCalledExactlyOnceWith(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Available Agents row" })).toHaveFocus();
  });

  it("gives focus to the drawer's toggle when the row has gone with its drawer", async () => {
    const { user, onClose } = showDialog({ opener: false });
    await tab("Ember");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Open conversations" })).toHaveFocus();
  });

  it("closes when the page goes Back or Forward", async () => {
    const { onClose } = showDialog();
    await tab("Ember");
    act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: null })));
    await waitFor(() => expect(onClose).toHaveBeenCalledExactlyOnceWith(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes as a room's link is followed", async () => {
    const { user, onClose } = showDialog();
    await user.click(await tab("Scout"));
    await user.click(within(panel()).getByRole("link", { name: "Liftoff" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledExactlyOnceWith(false));
    expect(location.pathname).toBe("/rooms/launch");
  });
});

describe("Available Agents that can't load", () => {
  it("says why", async () => {
    const { onFailed } = showDialog({ answer: () => Promise.reject(new TypeError("Failed to fetch")) });
    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(dialog()).toHaveAttribute("aria-busy", "true");
  });

  it("says nothing once it's closed, unless the session has ended", async () => {
    const answers: Array<(response: Response) => void> = [];
    const fetch = serve(() => new Promise<Response>((resolve) => answers.push(resolve)));
    const onFailed = vi.fn();
    const shown = () =>
      render(
        <PeopleContext value={directory(FOR_EVERYONE)}>
          <AvailableAgentsDialog me={{ id: "u1", name: "Ada", administrator: false }} rooms={ROOMS} opener={null} onClose={vi.fn()} onStartDirect={vi.fn()} onFailed={onFailed} />
        </PeopleContext>,
      );
    const first = shown();
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    first.unmount();
    await act(async () => answers[0]!(Response.json({ error: "Something went wrong" }, { status: 500 })));
    expect(onFailed).not.toHaveBeenCalled();

    const second = shown();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    second.unmount();
    await act(async () => answers[1]!(Response.json({ error: "Sign in first" }, { status: 401 })));
    await waitFor(() => expect(onFailed).toHaveBeenCalledExactlyOnceWith(expect.any(ApiError)));
  });
});
