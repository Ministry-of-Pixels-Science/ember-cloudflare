import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSISTANT_OFF } from "@ember/protocol/assistant";
import { AGENT_TOOLS_FULL, MAX_AGENT_TOOLS, TOOL_GONE, type OfferedApp } from "@ember/protocol/apps";
import { NEW_APP_PATH } from "@/hooks/use-route";
import { ApiError } from "@/lib/api";
import { AgentTools, alwaysAllowExplained, NO_APPS_TO_PICK, NO_TOOLS_TO_PICK, pickedOf, TOOL_CHANGED, toolsExplained } from "./agent-tools";

const RECAP = "0mgk3x2a9b4c60";
const TOOLS = `/api/account/agents/${RECAP}/tools`;

const unpicked = { picked: false, changed: false, alwaysAllowed: false };
const MAIL: OfferedApp = { id: "0mgk3x2a9b4c71", name: "Mail", tools: [{ name: "send_email", title: null, description: "Sends an email.", fingerprint: "f-send", ...unpicked }] };
const TRACKER: OfferedApp = {
  id: "0mgk3x2a9b4c70",
  name: "Tracker",
  tools: [
    { name: "search_issues", title: "Search issues", description: "Finds issues by their words.", fingerprint: "f-search", ...unpicked, picked: true },
    { name: "create_issue", title: null, description: "", fingerprint: "f-create", ...unpicked },
  ],
};

/** `apps`, with the tool `name` of each picked or not. */
const withPicked = (apps: OfferedApp[], name: string, picked: boolean): OfferedApp[] =>
  apps.map((app) => ({ ...app, tools: app.tools.map((tool) => (tool.name === name ? { ...tool, picked } : tool)) }));

interface Answers {
  /** What loading the tools answers, each time. */
  loaded?: () => Response | Promise<Response>;
  /** What saving picks answers, rather than the apps with those picked. */
  saved?: (picks: unknown) => Response | Promise<Response>;
}

/** Answers the card's requests, keeping what each save sent. */
function serve({ loaded = () => Response.json({ apps: [MAIL, TRACKER] }), saved }: Answers = {}) {
  const sent: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    if (request === `GET ${TOOLS}`) return loaded();
    if (request !== `PUT ${TOOLS}`) throw new Error(`Unexpected request for ${request}`);
    const { tools } = JSON.parse(init!.body as string) as { tools: Array<{ appId: string; name: string; alwaysAllowed?: true }> };
    sent.push(tools);
    if (saved) return saved(tools);
    const pick = (app: OfferedApp, name: string) => tools.find((tool) => tool.appId === app.id && tool.name === name);
    const offered = (app: OfferedApp) => app.tools.map((tool) => ({ ...tool, picked: pick(app, tool.name) !== undefined, alwaysAllowed: pick(app, tool.name)?.alwaysAllowed === true }));
    return Response.json({ apps: [MAIL, TRACKER].map((app) => ({ ...app, tools: offered(app) })) });
  });
  return sent;
}

function showCard() {
  const onFailed = vi.fn();
  render(<AgentTools agentId={RECAP} name="Recap" onFailed={onFailed} />);
  return { onFailed, user: userEvent.setup() };
}

const card = () => screen.getByRole("region", { name: "Tools" });
const loaded = () => waitFor(() => expect(card()).toHaveAttribute("aria-busy", "false"));
const tool = (name: string) => within(card()).getByRole("checkbox", { name: new RegExp(`^${name}(,|$)`) });
const alwaysAllow = (name: string) => within(card()).queryByRole("checkbox", { name: `Always allow ${name}` });

afterEach(() => vi.restoreAllMocks());

describe("An agent's Tools card", () => {
  it("lists each connected app's tools under the app's name, with the ones the agent may use checked, and how many that is", async () => {
    serve();
    showCard();
    await loaded();

    const groups = within(card()).getAllByRole("group");
    expect(groups.map((group) => group.querySelector("legend")?.textContent)).toEqual(["Mail", "Tracker"]);
    expect(within(groups[1]!).getAllByRole("checkbox", { name: /^(?!Always allow )/ })).toHaveLength(2);
    expect(tool("search_issues")).toBeChecked();
    expect(tool("search_issues")).toHaveAccessibleName("search_issues, Search issues");
    expect(tool("search_issues")).toHaveAccessibleDescription("Finds issues by their words.");
    expect(tool("create_issue")).not.toBeChecked();
    expect(tool("send_email")).not.toBeChecked();
    expect(card()).toHaveTextContent(pickedOf(1));
    expect(card()).toHaveTextContent(toolsExplained("Recap"));
    expect(toolsExplained("Recap")).toContain(`up to ${MAX_AGENT_TOOLS} tools`);
  });

  it("saves a pick as it's made, sending every tool the agent may then use, and shows what the server answers", async () => {
    const sent = serve();
    const { user } = showCard();
    await loaded();

    await user.click(tool("send_email"));
    await waitFor(() => expect(tool("send_email")).toBeChecked());
    expect(sent).toEqual([
      [
        { appId: TRACKER.id, name: "search_issues", fingerprint: "f-search" },
        { appId: MAIL.id, name: "send_email", fingerprint: "f-send" },
      ],
    ]);
    expect(card()).toHaveTextContent(pickedOf(2));

    await user.click(tool("search_issues"));
    await waitFor(() => expect(tool("search_issues")).not.toBeChecked());
    expect(sent[1]).toEqual([{ appId: MAIL.id, name: "send_email", fingerprint: "f-send" }]);
  });

  it("has a picked tool's calls always allowed, or asked for again, with a box under it, saved as it's made, and under no tool that isn't picked", async () => {
    const sent = serve();
    const { user } = showCard();
    await loaded();

    expect(alwaysAllow("search_issues")).not.toBeChecked();
    expect(alwaysAllow("search_issues")!.closest("label")).toHaveTextContent(alwaysAllowExplained("Recap"));
    expect(alwaysAllow("create_issue")).toBeNull();
    expect(alwaysAllow("send_email")).toBeNull();

    await user.click(alwaysAllow("search_issues")!);
    await waitFor(() => expect(alwaysAllow("search_issues")).toBeChecked());
    expect(sent).toEqual([[{ appId: TRACKER.id, name: "search_issues", fingerprint: "f-search", alwaysAllowed: true }]]);
    expect(card()).toHaveTextContent(pickedOf(1));

    // Another pick keeps it.
    await user.click(tool("send_email"));
    await waitFor(() => expect(tool("send_email")).toBeChecked());
    expect(sent[1]).toEqual([
      { appId: TRACKER.id, name: "search_issues", fingerprint: "f-search", alwaysAllowed: true },
      { appId: MAIL.id, name: "send_email", fingerprint: "f-send" },
    ]);
    expect(alwaysAllow("search_issues")).toBeChecked();
    expect(alwaysAllow("send_email")).not.toBeChecked();

    await user.click(alwaysAllow("search_issues")!);
    await waitFor(() => expect(alwaysAllow("search_issues")).not.toBeChecked());
    expect(sent[2]).toEqual([
      { appId: MAIL.id, name: "send_email", fingerprint: "f-send" },
      { appId: TRACKER.id, name: "search_issues", fingerprint: "f-search" },
    ]);
  });

  it("asks first again for a tool that's taken away and picked again", async () => {
    const sent = serve({ loaded: () => Response.json({ apps: [{ ...TRACKER, tools: TRACKER.tools.map((tool) => ({ ...tool, alwaysAllowed: tool.picked })) }] }) });
    const { user } = showCard();
    await loaded();
    expect(alwaysAllow("search_issues")).toBeChecked();

    await user.click(tool("search_issues"));
    await waitFor(() => expect(tool("search_issues")).not.toBeChecked());
    expect(alwaysAllow("search_issues")).toBeNull();
    await user.click(tool("search_issues"));
    await waitFor(() => expect(tool("search_issues")).toBeChecked());
    expect(sent[1]).toEqual([{ appId: TRACKER.id, name: "search_issues", fingerprint: "f-search" }]);
    expect(alwaysAllow("search_issues")).not.toBeChecked();
  });

  it("takes no other pick while one is on its way", async () => {
    let answer!: (response: Response) => void;
    const sent = serve({ saved: () => new Promise((resolve) => (answer = resolve)) });
    const { user } = showCard();
    await loaded();

    await user.click(tool("send_email"));
    await waitFor(() => expect(card()).toHaveAttribute("aria-busy", "true"));
    expect(tool("create_issue")).toBeDisabled();
    await user.click(tool("create_issue"));
    expect(sent).toHaveLength(1);

    answer(Response.json({ apps: withPicked([MAIL, TRACKER], "send_email", true) }));
    await loaded();
    expect(tool("send_email")).toBeChecked();
    expect(tool("create_issue")).toBeEnabled();
  });

  it("says a tool's app describes it another way than when it was picked, and picks it again as any other", async () => {
    const changed = { ...TRACKER, tools: TRACKER.tools.map((tool) => (tool.name === "create_issue" ? { ...tool, changed: true } : tool)) };
    const sent = serve({ loaded: () => Response.json({ apps: [changed] }) });
    const { user } = showCard();
    await loaded();

    expect(tool("create_issue")).not.toBeChecked();
    expect(tool("create_issue")).toHaveAccessibleDescription(TOOL_CHANGED);
    await user.click(tool("create_issue"));
    await waitFor(() => expect(tool("create_issue")).toBeChecked());
    // The pick carries the tool as the card showed it, so that it's never of one nobody read.
    expect(sent[0]).toContainEqual({ appId: TRACKER.id, name: "create_issue", fingerprint: "f-create" });
    expect(card()).not.toHaveTextContent(TOOL_CHANGED);
  });

  it("lets no more be picked once the agent has as many as it may use, but lets them be taken away", async () => {
    const tools = Array.from({ length: MAX_AGENT_TOOLS + 1 }, (_, n) => ({ name: `tool_${n}`, title: null, description: "", fingerprint: `f-${n}`, changed: false, picked: n < MAX_AGENT_TOOLS }));
    serve({ loaded: () => Response.json({ apps: [{ ...TRACKER, tools }] }) });
    showCard();
    await loaded();

    expect(card()).toHaveTextContent(pickedOf(MAX_AGENT_TOOLS));
    expect(tool(`tool_${MAX_AGENT_TOOLS}`)).toBeDisabled();
    expect(tool("tool_0")).toBeEnabled();
  });

  it("says why the server refused a pick, and shows what the apps offer now", async () => {
    let offers = [MAIL, TRACKER];
    serve({ loaded: () => Response.json({ apps: offers }), saved: () => Response.json({ error: TOOL_GONE }, { status: 409 }) });
    const { user, onFailed } = showCard();
    await loaded();

    // Mail was disconnected since the card loaded.
    offers = [TRACKER];
    await user.click(tool("send_email"));
    await waitFor(() => expect(within(card()).getByRole("alert")).toHaveTextContent(TOOL_GONE));
    await loaded();
    expect(within(card()).queryByRole("checkbox", { name: /^send_email/ })).toBeNull();
    expect(tool("search_issues")).toBeChecked();
    expect(onFailed).not.toHaveBeenCalled();

    // The next pick clears what was said.
    vi.restoreAllMocks();
    serve();
    await user.click(tool("create_issue"));
    await waitFor(() => expect(tool("create_issue")).toBeChecked());
    expect(within(card()).queryByRole("alert")).toBeNull();
  });

  it("says so itself when the server finds too many picked", async () => {
    serve({ saved: () => Response.json({ error: AGENT_TOOLS_FULL }, { status: 422 }) });
    const { user, onFailed } = showCard();
    await loaded();
    await user.click(tool("send_email"));
    await waitFor(() => expect(within(card()).getByRole("alert")).toHaveTextContent(AGENT_TOOLS_FULL));
    await loaded();
    expect(tool("send_email")).not.toBeChecked();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says no apps are connected yet, with a link to connect one, in place of the tools", async () => {
    serve({ loaded: () => Response.json({ apps: [] }) });
    showCard();
    await loaded();
    expect(card()).toHaveTextContent(NO_APPS_TO_PICK);
    expect(within(card()).getByRole("link", { name: "Connect an app" })).toHaveAttribute("href", NEW_APP_PATH);
    expect(within(card()).queryByRole("checkbox")).toBeNull();
    expect(card()).not.toHaveTextContent(pickedOf(0));
  });

  it("says so under an app whose server has no tools any more", async () => {
    serve({ loaded: () => Response.json({ apps: [{ id: "0mgk3x2a9b4c70", name: "Tracker", tools: [] }] }) });
    showCard();
    await loaded();
    expect(within(card()).getByRole("group", { name: "Tracker" })).toHaveTextContent(NO_TOOLS_TO_PICK);
    expect(within(card()).queryByRole("checkbox")).toBeNull();
  });

  it("shows no tools, and not that there are no apps, while they load", () => {
    serve({ loaded: () => new Promise(() => {}) });
    showCard();
    expect(card()).toHaveAttribute("aria-busy", "true");
    expect(card()).not.toHaveTextContent(NO_APPS_TO_PICK);
    expect(within(card()).queryByRole("checkbox")).toBeNull();
  });

  it("leaves it to the page to say why the tools didn't load, or a pick failed any other way, as when Ember AI is off", async () => {
    serve({ loaded: () => Response.json({ error: "Something went wrong" }, { status: 500 }) });
    const { onFailed } = showCard();
    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1));
    expect(onFailed.mock.calls[0]![0]).toBeInstanceOf(ApiError);

    vi.restoreAllMocks();
    document.body.replaceChildren();
    serve({ saved: () => Response.json({ error: ASSISTANT_OFF }, { status: 409 }) });
    const off = showCard();
    await loaded();
    await off.user.click(tool("send_email"));
    await waitFor(() => expect(off.onFailed).toHaveBeenCalledTimes(1));
    expect((off.onFailed.mock.calls[0]![0] as ApiError).message).toBe(ASSISTANT_OFF);
    // The box goes back to what's saved.
    expect(tool("send_email")).not.toBeChecked();
    expect(within(card()).queryByRole("alert")).toBeNull();
  });
});
