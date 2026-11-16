import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPS_FULL, MAX_APPS, type AppSummary } from "@ember/protocol/apps";
import { appSettingsPath, NEW_APP_PATH } from "@/hooks/use-route";
import { ApiError } from "@/lib/api";
import { addressOf, AppList, APPS_EXPLAINED, NO_APPS, setAsideOf, SIGN_IN_ENDED, toolsOf, WANTS_ACCESS } from "./app-list";

const LINEAR: AppSummary = { id: "0mgk3x2a9b4c70", name: "Linear", url: "https://mcp.linear.example/mcp", toolCount: 23, setAside: 0, signInEnded: false, wantsAccess: false };
const NOTES: AppSummary = { id: "0mgk3x2a9b4c71", name: "Notes", url: "https://notes.example/", toolCount: 1, setAside: 0, signInEnded: false, wantsAccess: false };

/** Answers listing the apps with `apps`, or as `listed` says. */
const serve = (listed: () => Response | Promise<Response> = () => Response.json({ apps: [LINEAR, NOTES] })) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (`${init?.method ?? "GET"} ${String(input)}` === "GET /api/account/apps") return listed();
    throw new Error(`Unexpected request for ${init?.method ?? "GET"} ${String(input)}`);
  });

function showList() {
  const onFailed = vi.fn();
  render(<AppList onFailed={onFailed} />);
  return { onFailed };
}

const card = () => screen.getByRole("region", { name: "Apps" });
const loaded = () => waitFor(() => expect(card()).toHaveAttribute("aria-busy", "false"));

afterEach(() => vi.restoreAllMocks());

describe("The Apps card", () => {
  it("lists each app connected, by name, with where its server is and how many tools Ember read, and a link to its page", async () => {
    serve();
    showList();
    await loaded();

    const rows = within(card()).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByText(/./, { selector: "strong" }).textContent)).toEqual(["Linear", "Notes"]);
    expect(rows[0]).toHaveTextContent("mcp.linear.example/mcp · 23 tools");
    expect(card()).not.toHaveTextContent("set aside");
    expect(rows[1]).toHaveTextContent("notes.example · 1 tool");
    expect(within(rows[0]!).getByRole("link", { name: "Edit Linear" })).toHaveAttribute("href", appSettingsPath(LINEAR.id));
    expect(within(rows[1]!).getByRole("link", { name: "Edit Notes" })).toHaveAttribute("href", appSettingsPath(NOTES.id));
  });

  it("says on an app's row how many of its tools are set aside for an agent that had them, and nothing of that on any other", async () => {
    serve(() => Response.json({ apps: [{ ...LINEAR, setAside: 2 }, { ...NOTES, setAside: 1 }] }));
    showList();
    await loaded();
    const [linear, notes] = within(card()).getAllByRole("listitem");
    expect(linear).toHaveTextContent(setAsideOf(2));
    expect(setAsideOf(2)).toContain("2 picked tools are set aside");
    expect(notes).toHaveTextContent(setAsideOf(1));
    expect(setAsideOf(1)).toContain("1 picked tool is set aside");
  });

  it("says on an app's row that Ember's sign-in to it has ended, and nothing of that on any other", async () => {
    serve(() => Response.json({ apps: [{ ...LINEAR, signInEnded: true }, NOTES] }));
    showList();
    await loaded();
    const [linear, notes] = within(card()).getAllByRole("listitem");
    expect(linear).toHaveTextContent(SIGN_IN_ENDED);
    expect(notes).not.toHaveTextContent("sign-in");
  });

  it("says on an app's row that its server asks for more than its sign-in allows, unless the sign-in has ended, which says to sign in again already", async () => {
    serve(() => Response.json({ apps: [{ ...LINEAR, wantsAccess: true }, { ...NOTES, wantsAccess: true, signInEnded: true }] }));
    showList();
    await loaded();
    const [linear, notes] = within(card()).getAllByRole("listitem");
    expect(linear).toHaveTextContent(WANTS_ACCESS);
    expect(notes).toHaveTextContent(SIGN_IN_ENDED);
    expect(notes).not.toHaveTextContent(WANTS_ACCESS);
  });

  it("says what apps are, with Connect an app, which goes to its page", async () => {
    serve();
    showList();
    await loaded();
    expect(card()).toHaveTextContent(APPS_EXPLAINED);
    expect(APPS_EXPLAINED).toContain(`up to ${MAX_APPS}`);
    expect(within(card()).getByRole("link", { name: "Connect an app" })).toHaveAttribute("href", NEW_APP_PATH);
  });

  it("says no apps are connected yet, in place of the list, with none", async () => {
    serve(() => Response.json({ apps: [] }));
    showList();
    await loaded();
    expect(card()).toHaveTextContent(NO_APPS);
    expect(within(card()).queryByRole("list")).toBeNull();
  });

  it("shows no list, and not that there are none, while the apps load", () => {
    serve(() => new Promise(() => {}));
    showList();
    expect(card()).toHaveAttribute("aria-busy", "true");
    expect(card()).not.toHaveTextContent(NO_APPS);
    expect(within(card()).queryByRole("list")).toBeNull();
  });

  it("turns Connect an app off, saying why, once as many are connected as can be", async () => {
    const apps = Array.from({ length: MAX_APPS }, (_, n) => ({ ...LINEAR, id: `0mgk3x2a9b4c${80 + n}`, name: `App ${n + 1}` }));
    serve(() => Response.json({ apps }));
    showList();
    await loaded();
    expect(within(card()).queryByRole("link", { name: "Connect an app" })).toBeNull();
    expect(within(card()).getByRole("button", { name: "Connect an app" })).toBeDisabled();
    expect(within(card()).getByRole("button", { name: "Connect an app" })).toHaveAccessibleDescription(APPS_FULL);
  });

  it("says why the apps didn't load, as the workspace's alerts do", async () => {
    serve(() => Response.json({ error: "Something went wrong" }, { status: 500 }));
    const { onFailed } = showList();
    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1));
    expect(onFailed.mock.calls[0]![0]).toBeInstanceOf(ApiError);
    expect(card()).toHaveAttribute("aria-busy", "true");
  });
});

describe("What a row says of an app", () => {
  it("names its server by its host, and its path unless that's only a slash", () => {
    expect(addressOf("https://mcp.linear.example/mcp")).toBe("mcp.linear.example/mcp");
    expect(addressOf("https://notes.example/")).toBe("notes.example");
    expect(addressOf("http://localhost:8788/mcp?key=1")).toBe("localhost:8788/mcp");
    expect(addressOf("not an address")).toBe("not an address");
  });

  it("counts its tools", () => {
    expect([toolsOf(0), toolsOf(1), toolsOf(2)]).toEqual(["0 tools", "1 tool", "2 tools"]);
  });
});
