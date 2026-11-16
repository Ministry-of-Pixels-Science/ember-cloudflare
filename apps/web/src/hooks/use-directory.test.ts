import type { DirectoryUser } from "@ember/protocol";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDirectory } from "./use-directory";

const ada: DirectoryUser = { id: "u1", name: "Ada", bio: null, role: "administrator", status: "active", avatarUrl: "/users/u1.abc/avatar?v=20261014120000" };
const grace: DirectoryUser = { id: "u2", name: "Grace", bio: "Compilers", role: "member", status: "active", avatarUrl: "/users/u2.def/avatar?v=20261014120000" };

/** Plays the server: the directory, with an ETag that changes with it, or no answer at all while `down`. */
const server = { users: [ada], version: 1, down: false };

async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (String(input) !== "/api/users") throw new Error(`No answer for ${String(input)}`);
  if (server.down) throw new TypeError("Failed to fetch");
  const etag = `W/"${server.version}"`;
  if (new Headers(init?.headers).get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return Response.json({ users: server.users }, { headers: { ETag: etag } });
}

/** The ETag each request named, null for none, in order. */
const requests = () => vi.mocked(fetch).mock.calls.map(([, init]) => new Headers(init?.headers).get("If-None-Match"));

/** Loads the directory again, and lets the answer render. */
const reload = (hook: { current: ReturnType<typeof useDirectory> }) => act(() => hook.current.reload());

beforeEach(() => {
  Object.assign(server, { users: [ada], version: 1, down: false });
  vi.stubGlobal("fetch", vi.fn(answer));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Initials avatars", () => {
  it("lists no one until it loads, then everyone by id", async () => {
    const { result } = renderHook(() => useDirectory());
    expect(result.current.people.size).toBe(0);
    await reload(result);
    expect(result.current.people.get("u1")).toEqual(ada);
  });

  it("has loaded once a load has come, and not for a change the workspace socket brings before one", async () => {
    const { result } = renderHook(() => useDirectory());
    act(() => result.current.update(grace));
    expect(result.current).toMatchObject({ loaded: false, people: new Map([["u2", grace]]) });
    server.down = true;
    await expect(reload(result)).rejects.toThrow("Failed to fetch");
    expect(result.current.loaded).toBe(false);
    server.down = false;
    await reload(result);
    expect(result.current.loaded).toBe(true);
  });

  it("keeps the people it has while the server says they're current, and takes them again when they change", async () => {
    const { result } = renderHook(() => useDirectory());
    await reload(result);
    const people = result.current.people;
    await reload(result);
    expect(result.current.people).toBe(people);

    Object.assign(server, { users: [ada, grace], version: 2 });
    await reload(result);
    expect([...result.current.people.keys()]).toEqual(["u1", "u2"]);
    expect(requests()).toEqual([null, 'W/"1"', 'W/"1"']);
  });

  it("keeps the people it has when a load fails, and says so", async () => {
    const { result } = renderHook(() => useDirectory());
    await reload(result);
    const people = result.current.people;
    server.down = true;
    await expect(reload(result)).rejects.toThrow("Failed to fetch");
    expect(result.current.people).toBe(people);
  });
});

describe("Make or revoke administrators", () => {
  it("changes someone as the workspace socket or a change made here says they are now", async () => {
    const { result } = renderHook(() => useDirectory());
    await reload(result);
    act(() => result.current.update({ ...ada, role: "member" }));
    expect(result.current.people.get("u1")).toEqual({ ...ada, role: "member" });
  });

  it("keeps a change that comes while a load is on its way, which may have read them before it", async () => {
    server.users = [ada, grace];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(fetch).mockImplementationOnce(async (input, init) => {
      await held;
      return answer(input, init);
    });
    const { result } = renderHook(() => useDirectory());
    let loaded!: Promise<void>;
    act(() => void (loaded = result.current.reload()));
    act(() => result.current.update({ ...grace, role: "administrator" }));
    await act(async () => {
      release();
      await loaded;
    });
    expect(result.current.people.get("u2")).toEqual({ ...grace, role: "administrator" });
    expect(result.current.people.get("u1")).toEqual(ada);

    // The next load takes them as the server has them.
    Object.assign(server, { users: [ada, { ...grace, role: "member" }], version: 2 });
    await reload(result);
    expect(result.current.people.get("u2")).toEqual(grace);
  });
});

describe("AI agents kept to administrators' direct messages", () => {
  const scout: DirectoryUser = { id: "u3", name: "Scout", bio: null, role: "bot", status: "active", avatarUrl: "/users/u3.ghi/avatar?v=20261115120000", agent: true };

  it("takes out whoever the workspace socket says this person is no longer told of, and takes them back as it says they are", async () => {
    server.users = [ada, scout];
    const { result } = renderHook(() => useDirectory());
    await reload(result);
    act(() => result.current.remove(scout.id));
    expect([...result.current.people.keys()]).toEqual(["u1"]);
    // Someone it never listed is as gone.
    act(() => result.current.remove("u9"));
    expect([...result.current.people.keys()]).toEqual(["u1"]);

    act(() => result.current.update({ ...scout, adminsOnly: true }));
    expect(result.current.people.get("u3")).toEqual({ ...scout, adminsOnly: true });
  });

  it("leaves out someone taken out while a load is on its way, which may have read them before, whatever came of them first", async () => {
    server.users = [ada, scout];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(fetch).mockImplementationOnce(async (input, init) => {
      await held;
      return answer(input, init);
    });
    const { result } = renderHook(() => useDirectory());
    let loaded!: Promise<void>;
    act(() => void (loaded = result.current.reload()));
    act(() => result.current.update({ ...scout, name: "Scout II" }));
    act(() => result.current.remove(scout.id));
    await act(async () => {
      release();
      await loaded;
    });
    expect([...result.current.people.keys()]).toEqual(["u1"]);
  });
});
