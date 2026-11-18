import { searchPath } from "@ember/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  guardLeaving,
  joinCodeFromPath,
  leave,
  messagePath,
  navigate,
  newRoomPath,
  permalinkOf,
  roomIdFromPath,
  roomPath,
  roomSettingsPath,
  routeOf,
  SEARCHES_PATH,
  useBackPath,
  useJoinRoute,
  useQuery,
  useRoute,
  useVisit,
  type LeaveGuard,
} from "./use-route";

afterEach(() => history.replaceState(null, "", "/"));

describe("Open a room", () => {
  it("reads the room from /rooms/:id", () => {
    expect(roomIdFromPath("/rooms/general")).toBe("general");
    expect(roomIdFromPath("/rooms/caf%C3%A9")).toBe("café");
    expect(roomPath("café")).toBe("/rooms/caf%C3%A9");
    history.replaceState(null, "", "/rooms/random");
    expect(renderHook(() => useRoute()).result.current).toEqual({ page: "room", roomId: "random" });
  });

  it("reads other paths as home", () => {
    expect(roomIdFromPath("/")).toBeNull();
    expect(roomIdFromPath("/rooms/general/extra")).toBeNull();
    expect(routeOf("/")).toEqual({ page: "home" });
    expect(routeOf("/rooms/general/extra")).toEqual({ page: "home" });
  });

  it("treats a malformed escape as no room instead of throwing", () => {
    expect(roomIdFromPath("/rooms/%FF")).toBeNull();
    expect(roomIdFromPath("/rooms/%E0%A4")).toBeNull();
    expect(routeOf("/rooms/opens/%FF/edit")).toEqual({ page: "home" });
    expect(routeOf("/rooms/opens/%FF")).toEqual({ page: "home" });
  });

  it("follows in-app navigation and the browser's Back button", async () => {
    history.replaceState(null, "", "/rooms/general");
    const { result } = renderHook(() => useRoute());
    act(() => navigate("/rooms/random"));
    expect(result.current).toEqual({ page: "room", roomId: "random" });
    expect(location.pathname).toBe("/rooms/random");

    act(() => history.back());
    await waitFor(() => expect(result.current).toEqual({ page: "room", roomId: "general" }));
  });

  it("doesn't add a history entry for the page you're already on", () => {
    history.replaceState(null, "", "/rooms/general");
    const length = history.length;
    navigate("/rooms/general");
    expect(history.length).toBe(length);
  });

  it("takes the current page's place in the history when asked to", () => {
    history.replaceState(null, "", "/rooms/general");
    const length = history.length;
    navigate("/rooms/random", { replace: true });
    expect(location.pathname).toBe("/rooms/random");
    expect(history.length).toBe(length);
  });
});

describe("Link to a message", () => {
  it("reads a message's permalink as its room's page, naming the message", () => {
    expect(messagePath("general", "m 1")).toBe("/rooms/general/@m%201");
    expect(routeOf("/rooms/general/@m%201")).toEqual({ page: "room", roomId: "general", messageId: "m 1" });
  });

  it("counts every visit, to the page shown too, so following a permalink again goes to its message again", async () => {
    history.replaceState(null, "", "/rooms/general/@m1");
    const { result } = renderHook(() => useVisit());
    const first = result.current;
    act(() => navigate("/rooms/general/@m1"));
    expect(result.current).toBe(first + 1);
    act(() => navigate("/rooms/general"));
    expect(result.current).toBe(first + 2);
    act(() => history.back());
    await waitFor(() => expect(result.current).toBe(first + 3));
  });
});

describe("Threads", () => {
  it("reads a thread's address as its room's page with the thread open, at a reply when it names one", () => {
    expect(routeOf("/rooms/general/threads/m%201")).toEqual({ page: "room", roomId: "general", threadId: "m 1" });
    expect(routeOf("/rooms/general/threads/m1/@r1")).toEqual({ page: "room", roomId: "general", threadId: "m1", replyId: "r1" });
    expect(roomIdFromPath("/rooms/general/threads/m1/@r1")).toBe("general");
  });

  it("links a message to its place in its room, and a reply to its place in its thread", () => {
    expect(permalinkOf({ roomId: "general", id: "m1" })).toBe("/rooms/general/@m1");
    expect(permalinkOf({ roomId: "general", id: "r1", parentId: "m1" })).toBe("/rooms/general/threads/m1/@r1");
  });
});

describe("Room addresses", () => {
  it("has the newest room at /rooms", () => {
    expect(routeOf("/rooms")).toEqual({ page: "newest-room" });
  });

  it("reads a room's address for its kind, which goes on to the room's own", () => {
    expect(routeOf("/rooms/opens/general")).toEqual({ page: "room-of-kind", kind: "open", roomId: "general" });
    expect(routeOf("/rooms/closeds/caf%C3%A9")).toEqual({ page: "room-of-kind", kind: "closed", roomId: "café" });
    expect(routeOf("/rooms/directs/ada-grace")).toEqual({ page: "room-of-kind", kind: "direct", roomId: "ada-grace" });
  });

  it("reads /rooms/opens and the others as room ids, matching /rooms/<id> first", () => {
    expect(routeOf("/rooms/opens")).toEqual({ page: "room", roomId: "opens" });
    expect(routeOf("/rooms/closeds")).toEqual({ page: "room", roomId: "closeds" });
    expect(routeOf("/rooms/directs")).toEqual({ page: "room", roomId: "directs" });
  });

  it("reads /rooms/directs/new as New direct message's address rather than a DM's", () => {
    expect(routeOf("/rooms/directs/new")).toEqual({ page: "new-direct" });
  });
});

describe("Create an open room", () => {
  it("has New room at /rooms/opens/new", () => {
    expect(newRoomPath("open")).toBe("/rooms/opens/new");
    expect(routeOf("/rooms/opens/new")).toEqual({ page: "new-room", access: "open" });
  });
});

describe("Create a private room", () => {
  it("has the private room form at /rooms/closeds/new", () => {
    expect(newRoomPath("closed")).toBe("/rooms/closeds/new");
    expect(routeOf("/rooms/closeds/new")).toEqual({ page: "new-room", access: "closed" });
  });
});

describe("Room settings page", () => {
  it("has a room's settings at the address for its kind", () => {
    expect(roomSettingsPath("open", "general")).toBe("/rooms/opens/general/edit");
    expect(roomSettingsPath("closed", "café")).toBe("/rooms/closeds/caf%C3%A9/edit");
    expect(roomSettingsPath("direct", "ada-grace")).toBe("/rooms/directs/ada-grace/edit");
    expect(routeOf("/rooms/opens/general/edit")).toEqual({ page: "room-settings", access: "open", roomId: "general" });
    expect(routeOf("/rooms/closeds/caf%C3%A9/edit")).toEqual({ page: "room-settings", access: "closed", roomId: "café" });
  });
});

describe("Community settings page", () => {
  it("has workspace settings at /account/edit", () => {
    expect(routeOf("/account/edit")).toEqual({ page: "workspace-settings" });
  });

  it("goes back to the section of community settings someone's page was opened from, which a referrer leaves out", () => {
    history.replaceState(null, "", "/account/edit#membership-settings");
    const { result } = renderHook(() => useBackPath());
    act(() => navigate("/users/u2"));
    expect(result.current).toBe("/account/edit#membership-settings");
  });
});

describe("Edit your profile", () => {
  it("has your profile at /users/me/profile", () => {
    expect(routeOf("/users/me/profile")).toEqual({ page: "profile" });
  });

  it("goes back to the page another was opened from, as a referrer would", async () => {
    history.replaceState(null, "", "/rooms/general");
    const { result } = renderHook(() => useBackPath());
    act(() => navigate("/users/me/profile"));
    expect(result.current).toBe("/rooms/general");
    act(() => navigate("/account/edit"));
    expect(result.current).toBe("/users/me/profile");

    // Back and Forward find where each page was opened from, as a browser keeps a page's referrer.
    act(() => history.back());
    await waitFor(() => expect(location.pathname).toBe("/users/me/profile"));
    expect(result.current).toBe("/rooms/general");
    act(() => history.forward());
    await waitFor(() => expect(result.current).toBe("/users/me/profile"));
  });

  it("goes back to where a page that took another's place was opened from, as a redirect keeps the referrer", () => {
    history.replaceState(null, "", "/account/edit");
    const { result } = renderHook(() => useBackPath());
    act(() => navigate("/"));
    act(() => navigate("/rooms/general", { replace: true }));
    expect(result.current).toBe("/account/edit");
  });

  it("goes home from a page the app didn't open, or one opened from itself", () => {
    history.replaceState(null, "", "/users/me/profile");
    const { result } = renderHook(() => useBackPath());
    expect(result.current).toBe("/");
    act(() => history.replaceState({ position: 0, from: "/users/me/profile" }, "", "/users/me/profile"));
    expect(renderHook(() => useBackPath()).result.current).toBe("/");
    act(() => history.replaceState({ position: 0, from: "/users/me/profile#bio" }, "", "/users/me/profile"));
    expect(renderHook(() => useBackPath()).result.current).toBe("/");
  });
});

describe("Search page", () => {
  /** What's searched for, as the address of the page shown has it. */
  const useSearched = () => new URLSearchParams(useQuery()).get("q");

  it("has search at /searches, reading what's searched for from its query string as the address changes", async () => {
    history.replaceState(null, "", "/searches?q=hello++world&in=general&has=link");
    const { result } = renderHook(() => ({ route: useRoute(), query: useQuery(), q: useSearched() }));
    expect(result.current).toEqual({ route: { page: "search" }, query: "?q=hello++world&in=general&has=link", q: "hello  world" });
    act(() => navigate("/searches?q=eel"));
    expect(result.current.q).toBe("eel");
    expect(location.search).toBe("?q=eel");
    act(() => navigate(SEARCHES_PATH));
    expect(result.current).toEqual({ route: { page: "search" }, query: "", q: null });

    act(() => history.back());
    await waitFor(() => expect(result.current.q).toBe("eel"));
  });

  it("reads any search back from its address as it was searched for", () => {
    for (const query of ["hello  world", "café_1 日本", " eel ", "\u{200d}", ""]) {
      history.replaceState(null, "", searchPath({ q: query }));
      const { result, unmount } = renderHook(useSearched);
      expect(result.current, query).toBe(query);
      unmount();
    }
  });

  it("goes to another search as another page, which Back leaves, but not to the search shown", async () => {
    history.replaceState(null, "", "/searches?q=eel");
    const { result } = renderHook(useSearched);
    act(() => navigate("/searches?q=eel"));
    expect(history.state).toBeNull();
    act(() => navigate(SEARCHES_PATH));
    expect(result.current).toBeNull();
    expect(history.state).toMatchObject({ from: "/searches?q=eel" });

    act(() => history.back());
    await waitFor(() => expect(result.current).toBe("eel"));
  });

  it("goes back to a search with its query string", () => {
    history.replaceState(null, "", "/searches?q=eel");
    const { result } = renderHook(() => useBackPath());
    act(() => navigate("/users/me/profile"));
    expect(result.current).toBe("/searches?q=eel");
  });
});

describe("Sign up with the join link", () => {
  it("reads the join code from /join/:code, as the link has it", () => {
    expect(joinCodeFromPath("/join/aB3d-Ef5h-iJ7k")).toBe("aB3d-Ef5h-iJ7k");
    expect(joinCodeFromPath("/join/")).toBeNull();
    expect(joinCodeFromPath("/join/aB3d-Ef5h-iJ7k/extra")).toBeNull();
    expect(joinCodeFromPath("/rooms/aB3d-Ef5h-iJ7k")).toBeNull();
  });

  it("reads no join code from the pages that links Ember emails open", () => {
    expect(joinCodeFromPath("/join/invitation")).toBeNull();
    expect(joinCodeFromPath("/join/email")).toBeNull();
  });

  it("leaves the join page when the app goes home", () => {
    history.replaceState(null, "", "/join/aB3d-Ef5h-iJ7k");
    const { result } = renderHook(() => useJoinRoute());
    expect(result.current).toBe("aB3d-Ef5h-iJ7k");
    act(() => navigate("/", { replace: true }));
    expect(result.current).toBeNull();
  });
});

describe("Unsaved changes guard", () => {
  /** A guard that holds the app on its page, keeping how to go on. */
  function holdingGuard() {
    const asked: (string | null)[] = [];
    let proceed = () => {};
    const guard = vi.fn<LeaveGuard>((path, go) => {
      asked.push(path);
      proceed = go;
      return true;
    });
    const stop = guardLeaving(guard);
    return { asked, guard, stop, proceed: () => act(() => proceed()) };
  }

  /** The app at `from`, then at `to`, two entries it numbered in the history. */
  function visit(from: string, to: string) {
    navigate(from, { replace: true });
    navigate(to);
    return renderHook(() => useRoute());
  }

  it("asks the page's guard before showing another page, and shows it once the guard lets it go", () => {
    history.replaceState(null, "", "/rooms/opens/design/edit");
    const { result } = renderHook(() => useRoute());
    const { asked, stop, proceed } = holdingGuard();
    act(() => navigate("/rooms/general"));
    expect(asked).toEqual(["/rooms/general"]);
    expect(location.pathname).toBe("/rooms/opens/design/edit");
    expect(result.current).toEqual({ page: "room-settings", access: "open", roomId: "design" });

    proceed();
    expect(location.pathname).toBe("/rooms/general");
    expect(result.current).toEqual({ page: "room", roomId: "general" });
    stop();
  });

  it("goes straight on when the guard doesn't hold the page, or once it's gone", () => {
    history.replaceState(null, "", "/rooms/opens/design/edit");
    const guard = vi.fn<LeaveGuard>(() => false);
    const stop = guardLeaving(guard);
    navigate("/rooms/closeds/design/edit", { replace: true });
    expect(guard).toHaveBeenCalledWith("/rooms/closeds/design/edit", expect.any(Function));
    expect(location.pathname).toBe("/rooms/closeds/design/edit");

    stop();
    const { guard: stale } = holdingGuard();
    // Taking away a guard that's been replaced leaves the one in its place.
    stop();
    navigate("/rooms/general");
    expect(stale).toHaveBeenCalledOnce();
    expect(location.pathname).toBe("/rooms/closeds/design/edit");
  });

  it("asks with no page before leaving the app, as signing out does", () => {
    const signOut = vi.fn();
    const { asked, stop, proceed } = holdingGuard();
    leave(signOut);
    expect(asked).toEqual([null]);
    expect(signOut).not.toHaveBeenCalled();
    proceed();
    expect(signOut).toHaveBeenCalledOnce();

    stop();
    leave(signOut);
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  it("turns Back around, showing the page all along, until the guard lets it go", async () => {
    const { result } = visit("/rooms/general", "/rooms/opens/design/edit");
    const length = history.length;
    const { asked, stop, proceed } = holdingGuard();
    // What the app shows each time the address changes, read as soon as it has.
    const shown: unknown[] = [];
    const read = () => shown.push(renderHook(() => useRoute()).result.current);
    window.addEventListener("popstate", read);

    act(() => history.back());
    await waitFor(() => expect(shown).toHaveLength(2));
    expect(asked).toEqual(["/rooms/general"]);
    expect(location.pathname).toBe("/rooms/opens/design/edit");
    expect(shown).toEqual([result.current, result.current]);
    expect(result.current).toEqual({ page: "room-settings", access: "open", roomId: "design" });
    expect(history.length).toBe(length);

    proceed();
    await waitFor(() => expect(result.current).toEqual({ page: "room", roomId: "general" }));
    expect(location.pathname).toBe("/rooms/general");
    expect(asked).toHaveLength(1);
    window.removeEventListener("popstate", read);
    stop();
  });

  it("turns Forward around too", async () => {
    const { result } = visit("/rooms/opens/design/edit", "/rooms/general");
    act(() => history.back());
    await waitFor(() => expect(result.current).toEqual({ page: "room-settings", access: "open", roomId: "design" }));
    const { asked, stop, proceed } = holdingGuard();

    act(() => history.forward());
    await waitFor(() => expect(asked).toEqual(["/rooms/general"]));
    await waitFor(() => expect(location.pathname).toBe("/rooms/opens/design/edit"));
    expect(result.current).toEqual({ page: "room-settings", access: "open", roomId: "design" });

    proceed();
    await waitFor(() => expect(result.current).toEqual({ page: "room", roomId: "general" }));
    stop();
  });

  it("follows Back when the guard lets it", async () => {
    const { result } = visit("/rooms/general", "/rooms/opens/design/edit");
    const stop = guardLeaving(() => false);
    act(() => history.back());
    await waitFor(() => expect(result.current).toEqual({ page: "room", roomId: "general" }));
    stop();
  });
});

describe("Back and Forward", () => {
  /** The router as a page loaded afresh has it, at the address and history entry shown, as a reload loads it. */
  async function loaded() {
    vi.resetModules();
    const router = await import("./use-route");
    const { result } = renderHook(() => ({ back: router.useCanGoBack(), forward: router.useCanGoForward() }));
    return { navigate: router.navigate, result };
  }

  /** The router as a page first shown at `path` has it, in an entry it didn't add. */
  function openedAt(path: string) {
    history.replaceState(null, "", path);
    return loaded();
  }

  it("has neither on the first page the app shows, Back once it goes on, and Forward once Back comes back", async () => {
    const { navigate, result } = await openedAt("/rooms/general");
    expect(result.current).toEqual({ back: false, forward: false });

    act(() => navigate("/rooms/random"));
    expect(result.current).toEqual({ back: true, forward: false });
    act(() => history.back());
    await waitFor(() => expect(result.current).toEqual({ back: false, forward: true }));
    expect(location.pathname).toBe("/rooms/general");

    act(() => history.forward());
    await waitFor(() => expect(result.current).toEqual({ back: true, forward: false }));
    expect(location.pathname).toBe("/rooms/random");
  });

  it("drops Forward once the app goes on to another page, as the browser drops the pages ahead", async () => {
    const { navigate, result } = await openedAt("/rooms/general");
    act(() => navigate("/rooms/random"));
    act(() => navigate("/rooms/design"));
    act(() => history.back());
    await waitFor(() => expect(result.current).toEqual({ back: true, forward: true }));

    act(() => navigate("/account/edit"));
    expect(result.current).toEqual({ back: true, forward: false });
    act(() => history.back());
    await waitFor(() => expect(location.pathname).toBe("/rooms/random"));
    act(() => history.forward());
    await waitFor(() => expect(location.pathname).toBe("/account/edit"));
    expect(result.current).toEqual({ back: true, forward: false });
  });

  it("keeps the pages ahead when a page takes another's place", async () => {
    const { navigate, result } = await openedAt("/rooms/general");
    act(() => navigate("/rooms/random"));
    act(() => history.back());
    await waitFor(() => expect(result.current.forward).toBe(true));

    act(() => navigate("/rooms/design", { replace: true }));
    expect(result.current).toEqual({ back: false, forward: true });
    act(() => history.forward());
    await waitFor(() => expect(location.pathname).toBe("/rooms/random"));
  });

  it("keeps both through a reload, and on a page loaded afresh from the history, as a restored tab loads one", async () => {
    const { navigate } = await openedAt("/rooms/general");
    act(() => navigate("/rooms/random"));
    act(() => navigate("/rooms/design"));
    act(() => history.back());
    await waitFor(() => expect(location.pathname).toBe("/rooms/random"));
    expect((await loaded()).result.current).toEqual({ back: true, forward: true });

    // A tab the browser restores loads the page Back goes to afresh, which the app went on from before.
    act(() => history.back());
    await waitFor(() => expect(location.pathname).toBe("/rooms/general"));
    expect((await loaded()).result.current).toEqual({ back: false, forward: true });
  });

  it("has Forward after going back to a page an earlier version of the app added, which doesn't say what's ahead of it", async () => {
    // Its pages, numbered but not marked, then the reload that brought this version, on the last of them.
    history.replaceState({ position: 0 }, "", "/rooms/general");
    history.pushState({ position: 1 }, "", "/rooms/random");
    history.pushState({ position: 2 }, "", "/rooms/design");
    const { result } = await loaded();
    expect(result.current).toEqual({ back: true, forward: false });

    act(() => history.back());
    await waitFor(() => expect(result.current).toEqual({ back: true, forward: true }));
    expect(location.pathname).toBe("/rooms/random");
    act(() => history.back());
    await waitFor(() => expect(location.pathname).toBe("/rooms/general"));
    expect(result.current).toEqual({ back: false, forward: true });

    // Each page it went back to keeps that one is ahead of it, going on again and through a reload.
    act(() => history.forward());
    await waitFor(() => expect(result.current).toEqual({ back: true, forward: true }));
    expect(location.pathname).toBe("/rooms/random");
    expect((await loaded()).result.current).toEqual({ back: true, forward: true });
  });
});
