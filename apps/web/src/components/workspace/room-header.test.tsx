import { avatarSvg, type DirectoryUser, type Room, type User } from "@ember/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "@/components/ui/sheet";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { PushContext, type Push } from "@/hooks/use-push";
import { PUSH_ON } from "@/test-push";
import { INVOLVEMENT_NOT_SAVED } from "./notification-bell";
import { RoomHeader } from "./room-header";
import { OpenSearchContext, type OpenSearch } from "./search-box";

const people = (count: number): User[] => Array.from({ length: count }, (_, i) => ({ id: `u${i}`, name: `Person ${i}` }));
const general: Room = { id: "general", name: "general", kind: "open", icon: null };
/** Ada's DM with Linus, as Linus reads it. */
const adaDirect: Room = { id: "direct-1", kind: "direct", members: [{ id: "ada", name: "Ada" }, { id: "linus", name: "Linus" }], activeAt: "2026-10-15T12:00:00.000Z" };
/** @ember, the AI assistant. */
const ember: User = { id: "ember", name: "Ember" };

afterEach(() => history.replaceState(null, "", "/"));

/** What the header's statuses say: the connection's, and the bell's, which says nothing until it's pressed. */
const statuses = () => screen.queryAllByRole("status").flatMap((status) => status.textContent || []);

/**
 * The header inside the drawer's Sheet, which its menu button opens, as in the workspace, on a browser
 * with notifications on unless `push` says otherwise.
 */
function renderHeader(props: Partial<ComponentProps<typeof RoomHeader>> = {}, onOpenChange?: (open: boolean) => void, push: Push = PUSH_ON, openSearch: OpenSearch = () => {}) {
  return render(
    <PushContext value={push}>
      <OpenSearchContext value={openSearch}>
        <Sheet onOpenChange={onOpenChange}>
          <RoomHeader
            room={general}
            name="general"
            meId="linus"
            present={[]}
            status="open"
            offline={false}
            favorite={false}
            onStarred={vi.fn()}
            involvement="mentions"
            askForRoom={() => vi.fn()}
            onSessionChanged={vi.fn()}
            onFailed={vi.fn()}
            {...props}
          />
        </Sheet>
      </OpenSearchContext>
    </PushContext>,
  );
}

describe("Who's here", () => {
  it("shows up to four faces of the people here, and how many more", () => {
    renderHeader({ present: people(6) });
    expect(screen.getByText("6 here now")).toBeInTheDocument();
    const faces = [...screen.getByTitle(/^Person 0, Person 1, .*Person 5$/).querySelectorAll("img")];
    // Their initials, drawn as the Worker draws them while the directory doesn't list them.
    expect(faces.map((face) => atob(face.getAttribute("src")!.split(",")[1]!))).toEqual(people(4).map((person) => avatarSvg(person.id, person.name)));
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("names them as the people directory lists them now, which follows a rename since the room heard them", () => {
    const renamed = { id: "u1", name: "Grace Hopper", bio: null, role: "member", status: "active", avatarUrl: "/users/u1/avatar" } as const;
    render(
      <PeopleContext value={new Map([[renamed.id, renamed]])}>
        <Sheet>
          <RoomHeader
            room={general}
            name="general"
            meId="linus"
            present={people(2)}
            status="open"
            offline={false}
            favorite={false}
            onStarred={vi.fn()}
            involvement="mentions"
            askForRoom={() => vi.fn()}
            onSessionChanged={vi.fn()}
            onFailed={vi.fn()}
          />
        </Sheet>
      </PeopleContext>,
    );
    expect(screen.getByTitle("Person 0, Grace Hopper")).toBeInTheDocument();
  });

  it("shows no overflow count for four or fewer", () => {
    renderHeader({ present: people(2) });
    expect(screen.getByText("2 here now")).toBeInTheDocument();
    expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument();
  });
});

describe("Room header", () => {
  it("shows the room's name after a # in the Page navigation, and screen readers hear just the name", () => {
    renderHeader();
    expect(screen.getByRole("navigation", { name: "Page" })).toHaveTextContent(/^#general/);
    expect(screen.getByRole("heading", { level: 1 })).toHaveAccessibleName("general");
  });
});

describe("Star rooms", () => {
  it("has a star after the room's name, pressed while it's starred", () => {
    const { unmount } = renderHeader();
    const star = screen.getByRole("button", { name: "Favorite room" });
    expect(star).toHaveAttribute("aria-pressed", "false");
    expect(star.compareDocumentPosition(screen.getByRole("heading", { level: 1 })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    unmount();

    renderHeader({ favorite: true });
    expect(screen.getByRole("button", { name: "Favorite room" })).toHaveAttribute("aria-pressed", "true");
  });

  it("has none in a DM, which can't be starred", () => {
    renderHeader({ room: adaDirect, name: "Ada" });
    expect(screen.queryByRole("button", { name: "Favorite room" })).not.toBeInTheDocument();
  });
});

describe("Group DMs and DM names", () => {
  it("shows a DM's name after a chat bubble, saying to screen readers whom it's with", () => {
    renderHeader({ room: adaDirect, name: "Ada" });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(/^Direct message with Ada$/);
    expect(heading.previousElementSibling).toHaveClass("iconoir-chat-bubble-empty");
    expect(screen.getByRole("navigation", { name: "Page" })).not.toHaveTextContent("#");
  });

  it("badges a DM with @ember alone as an agent's after its name", () => {
    renderHeader({ room: { ...adaDirect, members: [{ id: "ada", name: "Ada" }, ember] }, name: "Ember" });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(/^Direct message with Ember$/);
    expect(heading.nextElementSibling).toHaveTextContent(/^Agent$/);
    expect(heading.nextElementSibling).toHaveAttribute("data-slot", "badge");
  });

  it("badges a DM with any agent alone, as the people directory lists it", () => {
    const recap: DirectoryUser = { id: "u9", name: "Recap", bio: null, role: "bot", status: "active", avatarUrl: "/users/u9/avatar", agent: true };
    render(
      <PeopleContext value={new Map([[recap.id, recap]])}>
        <Sheet>
          <RoomHeader
            room={{ ...adaDirect, members: [{ id: "ada", name: "Ada" }, { id: recap.id, name: recap.name }] }}
            name="Recap"
            meId="ada"
            present={[]}
            status="open"
            offline={false}
            favorite={false}
            onStarred={vi.fn()}
            involvement="mentions"
            askForRoom={() => vi.fn()}
            onSessionChanged={vi.fn()}
            onFailed={vi.fn()}
          />
        </Sheet>
      </PeopleContext>,
    );
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(/^Direct message with Recap$/);
    expect(heading.nextElementSibling).toHaveTextContent(/^Agent$/);
  });

  it("badges no other DM, nor a group DM @ember is in", () => {
    renderHeader({ room: adaDirect, name: "Ada" });
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    cleanup();
    renderHeader({ room: { ...adaDirect, members: [...adaDirect.members, ember] }, name: "Ada and Ember" });
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
  });

  it("links to a DM's settings at a DM's address, saying it's a Ping's", () => {
    renderHeader({ room: adaDirect, name: "Ada" });
    const settings = screen.getByRole("link", { name: "Settings for this Ping" });
    expect(settings).toHaveAttribute("title", "Conversation settings");
    expect(settings).toHaveAttribute("href", "/rooms/directs/direct-1/edit");
  });
});

describe("Room settings page", () => {
  it("links to the room's settings at the address for its kind, showing them in place", async () => {
    renderHeader({ room: { id: "leads", name: "Leads", kind: "closed", icon: null } });
    const settings = screen.getByRole("link", { name: "Settings for this room" });
    expect(settings).toHaveAttribute("title", "Conversation settings");
    expect(settings).toHaveAttribute("href", "/rooms/closeds/leads/edit");
    await userEvent.click(settings);
    expect(location.pathname).toBe("/rooms/closeds/leads/edit");
  });
});

describe("Search box", () => {
  it("links to search before the room's settings, in rooms and DMs alike, opening the search box in place, in the room", async () => {
    for (const [room, name] of [[general, "general"], [adaDirect, "Ada"]] as const) {
      const openSearch = vi.fn();
      const { unmount } = renderHeader({ room, name }, undefined, PUSH_ON, openSearch);
      const search = screen.getByRole("link", { name: "Search messages" });
      expect(search).toHaveAttribute("title", "Search messages");
      expect(search).toHaveAttribute("href", "/searches");
      expect(search.compareDocumentPosition(screen.getByRole("link", { name: /^Settings for this/ })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await userEvent.click(search);
      expect(openSearch).toHaveBeenCalledExactlyOnceWith({ roomId: room.id, opener: search });
      // A click with a modifier key is the browser's, as into a new tab.
      expect(fireEvent.click(search, { ctrlKey: true })).toBe(true);
      expect(openSearch).toHaveBeenCalledOnce();
      unmount();
    }
    expect(location.pathname).toBe("/");
  });
});

describe("Catch up after a reconnect", () => {
  it.each([
    ["connecting", "Connecting…"],
    ["reconnecting", "Reconnecting…"],
  ] as const)("says when the room is %s, once it has been without a connection a while", (status, label) => {
    renderHeader({ status, offline: true });
    expect(statuses()).toEqual([label]);
  });

  it("says nothing while the connection has only just dropped", () => {
    renderHeader({ status: "reconnecting" });
    expect(statuses()).toEqual([]);
  });

  it("shows no status once connected", () => {
    renderHeader();
    expect(statuses()).toEqual([]);
  });

  it("shows no status for a room that's gone, which nothing reconnects to", () => {
    renderHeader({ status: "gone" });
    expect(statuses()).toEqual([]);
  });
});

describe("Conversations drawer on phones", () => {
  it("has a button that opens the conversations drawer", async () => {
    const onOpenChange = vi.fn();
    renderHeader({}, onOpenChange);
    const button = screen.getByRole("button", { name: "Open conversations" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(button);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});

describe("Room icons", () => {
  it("shows the room's icon before its name, or `#`", () => {
    const { unmount } = renderHeader({ room: { ...general, icon: "rocket" } });
    const icon = document.querySelector<HTMLElement>('[data-icon="rocket"]')!;
    expect(icon).toHaveStyle({ width: "22px", height: "22px" });
    expect(icon.compareDocumentPosition(screen.getByRole("heading", { level: 1, name: "general" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();

    renderHeader();
    expect(screen.getByText("#")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("Notification levels", () => {
  afterEach(() => vi.restoreAllMocks());

  it("puts the bell for your level between Search and the settings, in rooms and DMs alike", () => {
    for (const [room, name, involvement, label] of [
      [general, "general", "mentions", "Notifying about @ mentions"],
      [adaDirect, "Ada", "everything", "Notifying about all messages"],
    ] as const) {
      const { unmount } = renderHeader({ room, name, involvement });
      const bell = screen.getByRole("checkbox", { name: label });
      expect(bell).toHaveClass("size-9", "[&>svg]:size-5");
      const following = (a: Element, b: Element) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(following(screen.getByRole("link", { name: "Search messages" }), bell)).toBeTruthy();
      expect(following(bell, screen.getByRole("link", { name: /^Settings for this/ }))).toBeTruthy();
      unmount();
    }
  });

  it("hands on the level its bell saves, says under the bell when it couldn't, and leaves a session that's ended to the workspace", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ involvement: "everything" }));
    const [answered, onFailed] = [vi.fn(), vi.fn()];
    renderHeader({ askForRoom: () => answered, onFailed });
    const bell = screen.getByRole("checkbox", { name: "Notifying about @ mentions" });
    await userEvent.click(bell);
    expect(answered).toHaveBeenCalledWith({ type: "involved", roomId: "general", involvement: "everything" });
    expect(statuses()).toEqual(["Notifying about all messages"]);

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Something went wrong" }, { status: 500 }));
    await userEvent.click(bell);
    expect(statuses()).toEqual([INVOLVEMENT_NOT_SAVED]);
    expect(onFailed).not.toHaveBeenCalled();

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Sign in" }, { status: 401 }));
    await userEvent.click(bell);
    expect(onFailed).toHaveBeenCalledOnce();
  });
});

describe("Huddles", () => {
  /** Gives what's inside it a workspace where huddles are on. */
  function HuddlesOn({ children }: { children: ReactNode }) {
    return <AccountContext value={{ ...useAccount(), huddles: true }}>{children}</AccountContext>;
  }
  /** The header of `room`, as Linus reads it, where huddles are on and the people directory lists `listed`. */
  const renderWithHuddles = (room: Room, name: string, listed: DirectoryUser[] = []) =>
    render(
      <PeopleContext value={new Map(listed.map((person) => [person.id, person]))}>
        <PushContext value={PUSH_ON}>
          <Sheet>
            <RoomHeader
              room={room}
              name={name}
              meId="linus"
              present={[]}
              status="open"
              offline={false}
              favorite={false}
              onStarred={vi.fn()}
              involvement="mentions"
              askForRoom={() => vi.fn()}
              onSessionChanged={vi.fn()}
              onFailed={vi.fn()}
            />
          </Sheet>
        </PushContext>
      </PeopleContext>,
      { wrapper: HuddlesOn },
    );
  const following = (a: Element, b: Element) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;

  it("has no huddle button until huddles are on, and Search stays on the narrowest phones", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "Start huddle" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search messages" })).not.toHaveClass("max-[429px]:hidden");
  });

  it("starts its actions with the huddle button once they are, and gives up Search for it under 430px wide", () => {
    renderWithHuddles(general, "general");
    const search = screen.getByRole("link", { name: "Search messages" });
    expect(following(screen.getByRole("button", { name: "Start huddle" }), search)).toBeTruthy();
    expect(following(screen.getByRole("button", { name: "Huddle options" }), search)).toBeTruthy();
    expect(search).toHaveClass("max-[429px]:hidden");
  });

  it("has it in a DM with someone to huddle with, where Search gives way to it too", () => {
    renderWithHuddles(adaDirect, "Ada");
    const search = screen.getByRole("link", { name: "Search messages" });
    expect(following(screen.getByRole("button", { name: "Start huddle" }), search)).toBeTruthy();
    expect(search).toHaveClass("max-[429px]:hidden");
  });

  it("has none in a DM with nobody to huddle with, their own, one with bots alone or one with someone who can no longer sign in, which keeps Search", () => {
    const linus = { id: "linus", name: "Linus" };
    const own = renderWithHuddles({ ...adaDirect, members: [linus] }, "Linus");
    expect(screen.queryByRole("button", { name: "Start huddle" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search messages" })).not.toHaveClass("max-[429px]:hidden");
    own.unmount();

    const deploys: DirectoryUser = { id: "u8", name: "Deploys", bio: null, role: "bot", status: "active", avatarUrl: "/users/u8/avatar" };
    const withBots: Room = { ...adaDirect, members: [linus, { id: deploys.id, name: deploys.name }, ember] };
    const bots = renderWithHuddles(withBots, "Deploys and Ember", [deploys]);
    expect(screen.queryByRole("button", { name: "Start huddle" })).not.toBeInTheDocument();
    bots.unmount();

    // Ada has been deactivated since the DM with her started.
    renderWithHuddles(adaDirect, "Ada", [{ id: "ada", name: "Ada", bio: null, role: "member", status: "deactivated", avatarUrl: "/users/ada/avatar" }]);
    expect(screen.queryByRole("button", { name: "Start huddle" })).not.toBeInTheDocument();
  });

  it("has it in a DM with a bot and someone else", () => {
    renderWithHuddles({ ...adaDirect, members: [...adaDirect.members, ember] }, "Ada and Ember");
    expect(screen.getByRole("button", { name: "Start huddle" })).toBeInTheDocument();
  });
});
