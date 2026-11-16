import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startingInvolvement, type Me, type Profile, type SharedRoom } from "@ember/protocol";
import { PUSH_ON } from "@/test-push";

const ada: Me = { id: "u1", name: "Ada", administrator: false };
// All of it, as the profile page reads every part once it loads.
const adasProfile: Profile = { name: "Ada", emailAddress: "ada@example.com", bio: null, avatarUrl: "/users/u1/avatar?v=1", avatar: false, password: true, membershipNeeded: false, memberful: null, assistant: null, apps: [], outsideAi: null };
const random: SharedRoom = { id: "random", name: "random", kind: "open", icon: null };
const ANSWERS: Record<string, () => Response> = {
  "GET /api/sidebar": () =>
    Response.json({
      rooms: [{ ...random, unread: false, involvement: startingInvolvement(random) }],
      favorites: { rooms: [], version: 0 },
      sharedOrder: [],
      invitation: null,
      huddles: {},
    }),
  "GET /api/users": () => Response.json({ users: [] }),
  "GET /api/searches?q=": () => Response.json({ search: null, matches: [], next: null, rooms: [], recent: [] }),
  "GET /api/users/me/profile": () => Response.json({ profile: adasProfile }),
};

/** A socket that never connects: these tests are about the pages around the rooms. */
class QuietSocket {
  static readonly OPEN = 1;
  readyState = 0;
  send() {}
  close() {}
}

/**
 * The workspace as a page loaded afresh has it, none of the pages few visits need loaded yet, with what
 * shows it at an address.
 */
async function freshWorkspace() {
  vi.resetModules();
  const [{ Workspace, loadPageAhead }, { FlashProvider }, { PushContext }, { navigate }] = await Promise.all([
    import("./workspace"),
    import("@/components/flash"),
    import("@/hooks/use-push"),
    import("@/hooks/use-route"),
  ]);
  const show = (path: string) => {
    history.replaceState(null, "", path);
    render(
      <PushContext value={PUSH_ON}>
        <FlashProvider workspace>
          <Workspace me={ada} workspaceName="Analytical Engines" onAccountChanged={vi.fn()} onSignOut={vi.fn()} onSessionChanged={vi.fn()} />
        </FlashProvider>
      </PushContext>,
    );
  };
  return { show, navigate, loadPageAhead };
}

const searchHeading = () => screen.queryByRole("heading", { level: 1, name: "Search messages" });

beforeEach(() => {
  vi.stubGlobal("WebSocket", QuietSocket);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => (ANSWERS[`${init?.method ?? "GET"} ${String(input)}`] ?? (() => Response.json({})))());
});

afterEach(() => {
  // Unmounted while what it calls on the way out is still stubbed.
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("./pages");
  history.replaceState(null, "", "/");
});

describe("Workspace layout", () => {
  it("says Loading… until the pages few visits need have loaded, and then shows each at once", async () => {
    const { show, navigate } = await freshWorkspace();
    show("/searches");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Search messages" })).toBeInTheDocument();

    act(() => navigate("/users/me/profile"));
    expect(screen.getByRole("heading", { level: 1, name: "Your profile" })).toBeInTheDocument();
    act(() => navigate("/rooms/random"));
    act(() => navigate("/searches"));
    expect(searchHeading()).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("loads them once the rooms have, while the browser is idle, so that a page opened then shows at once", async () => {
    const idle: Array<() => void> = [];
    vi.stubGlobal("requestIdleCallback", (run: () => void) => idle.push(run));
    vi.stubGlobal("cancelIdleCallback", () => {});
    const { show, navigate } = await freshWorkspace();
    show("/rooms/random");
    expect(idle).toEqual([]);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("random");
    // Asked for by the effects of the commit that listed the rooms, which can run a task after the heading shows.
    await vi.waitFor(() => expect(idle).toHaveLength(1));

    await act(async () => {
      idle[0]!();
      // The workspace asked for them first, so they've loaded for it by the time they have here.
      await import("./pages");
    });
    act(() => navigate("/searches"));
    expect(searchHeading()).toBeInTheDocument();
  });

  it("loads the page an address shows ahead when few visits need it, so that it shows with the workspace", async () => {
    const { show, loadPageAhead } = await freshWorkspace();
    await loadPageAhead("/searches");
    show("/searches");
    expect(searchHeading()).toBeInTheDocument();
  });

  it("loads nothing ahead for a room's address", async () => {
    const { show, loadPageAhead } = await freshWorkspace();
    await loadPageAhead("/rooms/random");
    // Anything it asked for has loaded by the time this has.
    await import("./pages");
    show("/searches");
    expect(searchHeading()).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("says Ember can't be reached when they can't load, and tries again for the next page that needs them", async () => {
    vi.doMock("./pages", () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });
    const { show, navigate } = await freshWorkspace();
    show("/searches");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach Ember. Check your connection and try again.");
    expect(screen.getByText("Loading…")).toBeInTheDocument();

    // Straight from the one that couldn't load them.
    vi.doUnmock("./pages");
    act(() => navigate("/users/me/profile"));
    expect(await screen.findByRole("heading", { level: 1, name: "Your profile" })).toBeInTheDocument();
  });
});
