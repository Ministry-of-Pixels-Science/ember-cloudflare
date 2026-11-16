import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "@ember/protocol";
import { APPS_FORBIDDEN, APPS_FULL, type App, type AppAnswer, type AppSignInBegun } from "@ember/protocol/apps";
import { ASSISTANT_OFF } from "@ember/protocol/assistant";
import { FlashProvider } from "@/components/flash";
import { Sheet } from "@/components/ui/sheet";
import { agentSettingsPath, appSettingsPath, NEW_APP_PATH } from "@/hooks/use-route";
import { openPage } from "@/lib/page";
import { AGENTS_PATH } from "./agent-list";
import {
  ADDRESS_KEPT,
  AppSettingsPage,
  changesOf,
  CLIENT_ID_EXPLAINED,
  CLIENT_SECRET_EXPLAINED,
  CLIENT_SECRET_KEPT,
  CONFIRM_REMOVE_APP,
  FINDING_SIGN_IN,
  NewAppPage,
  NO_TOOLS,
  READING_TOOLS,
  REDIRECT_EXPLAINED,
  removedNotice,
  SET_ASIDE_EXPLAINED,
  SIGN_IN_EXPLAINED,
  SIGN_IN_HAS_ENDED,
  SIGN_IN_STAYS,
  signedInBy,
  TOKEN_EXPLAINED,
  TOKEN_KEPT,
  TOOL_IS_GONE,
  toolsLeftOut,
  URL_EXPLAINED,
  wantsMore,
} from "./app-page";
import { CHANGES_SAVED } from "./settings-page";

// Leaving for an app's authorization server would end the test's page.
vi.mock("@/lib/page", async (original) => ({ ...(await original<typeof import("@/lib/page")>()), openPage: vi.fn() }));

const ada: Me = { id: "0mgk3x2a9b4c5d", name: "Ada Lovelace", administrator: true };

const LINEAR: App = {
  id: "0mgk3x2a9b4c70",
  name: "Linear",
  url: "https://mcp.linear.example/mcp",
  hasToken: true,
  serverName: "Linear MCP",
  tools: [
    { name: "create_issue", title: "Create issue", description: "Creates an issue in a team.\nIt needs a title." },
    { name: "list_issues", title: null, description: "" },
  ],
  toolsLeftOut: 0,
  toolsReadAt: "2026-11-13T10:30:00.000Z",
  connectedBy: { id: ada.id, name: ada.name },
  setAside: [],
  signIn: null,
};

/** The app as it is once an administrator signed in to its server, in place of a token. */
const SIGNED_IN: App = { ...LINEAR, hasToken: false, signIn: { by: { id: ada.id, name: ada.name }, at: "2026-11-14T08:00:00.000Z", ended: false, clientId: null, wantsScope: null } };

/** The app as it is once an administrator signed in to its server as a client they registered there. */
const SIGNED_IN_AS_CLIENT: App = { ...SIGNED_IN, signIn: { ...SIGNED_IN.signIn!, clientId: "ember-at-linear" } };

/** Where the app's authorization server signs people in, as Ember answers once it has found it. */
const AUTHORIZE = "https://auth.linear.example/authorize?client_id=ember&state=5f2c";
const begun = () => Response.json({ authorizationUrl: AUTHORIZE } satisfies AppSignInBegun);
const ASKS_FOR_SIGN_IN = "mcp.linear.example asks for a sign-in. Sign in to it, or give a token for it, if it has one.";
const ASKS_FOR_CLIENT = "mcp.linear.example has a sign-in, but doesn't let Ember register itself for it. Register Ember there yourself and give its client ID, or give a token, if it has one.";
const SIGN_IN = `POST /api/account/apps/${LINEAR.id}/sign-in`;

const answer = (app: App, status = 200) => Response.json({ app } satisfies AppAnswer, { status });
const refused = (status: number, error: string, field?: string, signIn?: true) => Response.json({ error, ...(field && { field }), ...(signIn && { signIn }) }, { status });
/** The answer to beginning a sign-in at a service that doesn't come to know Ember by itself. */
const asksForClient = () => Response.json({ error: ASKS_FOR_CLIENT, field: "token", client: true }, { status: 422 });

interface Answers {
  /** What listing the apps answers, rather than none. */
  listed?: () => Response | Promise<Response>;
  /** What loading the app answers, rather than `LINEAR`. */
  loaded?: () => Response | Promise<Response>;
  /** What connecting, changing, rereading or removing the app answers, rather than that it's done. */
  sent?: (request: string, body: unknown) => Response | Promise<Response>;
}

/** Answers the pages' requests as the server does for an administrator, or as `answers` says, keeping what was sent. */
function serve({ listed = () => Response.json({ apps: [] }), loaded = () => answer(LINEAR), sent }: Answers = {}) {
  const requests: Array<{ request: string; body: unknown }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    if (request === "GET /api/account/apps") return listed();
    if (request === `GET /api/account/apps/${LINEAR.id}`) return loaded();
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ request, body });
    if (sent) return sent(request, body);
    switch (request) {
      case "POST /api/account/apps":
        return answer(LINEAR, 201);
      case `PATCH /api/account/apps/${LINEAR.id}`:
      case `POST /api/account/apps/${LINEAR.id}/tools`:
        return answer(LINEAR);
      case `DELETE /api/account/apps/${LINEAR.id}`:
        return new Response(null, { status: 204 });
      default:
        throw new Error(`Unexpected request for ${request}`);
    }
  });
  return requests;
}

/** Shows `page` at `path`, as the workspace does. */
function showAt(path: string, page: (props: { onMissing: () => void; onFailed: () => void }) => React.ReactNode) {
  const [onMissing, onFailed] = [vi.fn(), vi.fn()];
  history.replaceState(null, "", path);
  render(
    <FlashProvider workspace>
      <Sheet>{page({ onMissing, onFailed })}</Sheet>
    </FlashProvider>,
  );
  return { onMissing, onFailed, user: userEvent.setup() };
}

const showNew = (me = ada) => showAt(NEW_APP_PATH, ({ onFailed }) => <NewAppPage me={me} onFailed={onFailed} />);
const showSettings = (me = ada) =>
  showAt(appSettingsPath(LINEAR.id), ({ onMissing, onFailed }) => <AppSettingsPage appId={LINEAR.id} me={me} onMissing={onMissing} onFailed={onFailed} />);

const nameField = () => screen.findByRole("textbox", { name: "Name" });
const urlField = () => screen.getByRole("textbox", { name: "Server address" });
const tokenField = () => screen.getByLabelText("Token");
const clientIdField = () => screen.getByRole("textbox", { name: "Client ID" });
const clientSecretField = () => screen.getByLabelText("Client secret");
const tools = () => screen.getByRole("region", { name: /^Tools/ });
const flashed = () => screen.findByRole("alert");

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(openPage).mockClear();
});

describe("Connect an app", () => {
  it("asks for a name, the server's address and a token, saying what each is for, with Go Back to the AI assistant tab", async () => {
    serve();
    showNew();
    expect(await nameField()).toHaveValue("");
    expect(screen.getByRole("heading", { level: 1, name: "Connect an app" })).toBeVisible();
    expect(document.title).toContain("Connect an app");
    expect(urlField()).toHaveAccessibleDescription(URL_EXPLAINED);
    expect(tokenField()).toHaveAccessibleDescription(TOKEN_EXPLAINED);
    expect(tokenField()).toHaveAttribute("type", "password");
    expect(screen.queryByRole("checkbox", { name: "Send no token" })).toBeNull();
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", AGENTS_PATH);
  });

  it("connects the app with what's typed, leaving out a blank token, and goes to its page, saying how many tools Ember read", async () => {
    const requests = serve();
    const { user } = showNew();
    await user.type(await nameField(), "Linear");
    await user.type(urlField(), LINEAR.url);
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await flashed()).toHaveTextContent("Linear is connected. Ember read 2 tools from it.");
    expect(location.pathname).toBe(appSettingsPath(LINEAR.id));
    expect(requests).toEqual([{ request: "POST /api/account/apps", body: { name: "Linear", url: LINEAR.url } }]);
  });

  it("sends a token that's typed, and says it's reading the app's tools while it waits", async () => {
    let connected!: (response: Response) => void;
    const requests = serve({ sent: () => new Promise((resolve) => (connected = resolve)) });
    const { user } = showNew();
    await user.type(await nameField(), "Linear");
    await user.type(urlField(), LINEAR.url);
    await user.type(tokenField(), "lin_api_123");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(screen.getByRole("status")).toHaveTextContent(READING_TOOLS);
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(requests[0]!.body).toEqual({ name: "Linear", url: LINEAR.url, token: "lin_api_123" });
    connected(answer(LINEAR, 201));
    await waitFor(() => expect(location.pathname).toBe(appSettingsPath(LINEAR.id)));
  });

  it("says why a field is refused on that field, until it's changed, and stays", async () => {
    const why = "mcp.linear.example has no MCP server at that address. Check the address, which often ends in /mcp.";
    serve({ sent: () => refused(422, why, "url") });
    const { user, onFailed } = showNew();
    await user.type(await nameField(), "Linear");
    await user.type(urlField(), "https://mcp.linear.example/");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(urlField()).toHaveAccessibleDescription(why));
    expect(urlField()).toBeInvalid();
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(location.pathname).toBe(NEW_APP_PATH);
    expect(onFailed).not.toHaveBeenCalled();

    await user.type(urlField(), "mcp");
    expect(urlField()).toBeValid();
    expect(urlField()).toHaveAccessibleDescription(URL_EXPLAINED);
  });

  it("says a refusal about no field under Connect", async () => {
    serve({ sent: () => refused(422, "Expected a JSON object") });
    const { user } = showNew();
    await user.type(await nameField(), "Linear");
    await user.type(urlField(), LINEAR.url);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Expected a JSON object"));
  });

  it("offers to sign in to a server that asks for a sign-in, and sends the browser where it signs people in", async () => {
    let found!: (response: Response) => void;
    const requests = serve({ sent: (request) => (request === "POST /api/account/apps" ? refused(422, ASKS_FOR_SIGN_IN, "token", true) : new Promise((resolve) => (found = resolve))) });
    const { user } = showNew();
    await user.type(await nameField(), "Linear");
    await user.type(urlField(), LINEAR.url);
    expect(screen.queryByRole("button", { name: /^Sign in/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(tokenField()).toHaveAccessibleDescription(ASKS_FOR_SIGN_IN));
    await user.click(screen.getByRole("button", { name: "Sign in to mcp.linear.example" }));
    expect(screen.getByRole("status")).toHaveTextContent(FINDING_SIGN_IN);
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(requests.at(-1)).toEqual({ request: "POST /api/account/app-sign-ins", body: { name: "Linear", url: LINEAR.url } });
    expect(openPage).not.toHaveBeenCalled();

    found(begun());
    await waitFor(() => expect(openPage).toHaveBeenCalledWith(AUTHORIZE));
    // The form is as it was for whoever comes back to it.
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("says why a sign-in couldn't begin, on the field it's about, and no longer offers one", async () => {
    const why = "mcp.linear.example doesn't say how to sign in to it. Give a token for it, if it has one.";
    serve({ sent: (request) => (request === "POST /api/account/apps" ? refused(422, ASKS_FOR_SIGN_IN, "token", true) : refused(422, why, "token")) });
    const { user } = showNew();
    await user.type(await nameField(), "Linear");
    await user.type(urlField(), LINEAR.url);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: "Sign in to mcp.linear.example" }));

    await waitFor(() => expect(tokenField()).toHaveAccessibleDescription(why));
    expect(screen.queryByRole("button", { name: /^Sign in/ })).toBeNull();
    expect(openPage).not.toHaveBeenCalled();
  });

  it("asks who Ember is to a service that doesn't let Ember register itself, and signs in as the client that's typed", async () => {
    const answers = [() => refused(422, ASKS_FOR_SIGN_IN, "token", true), asksForClient, () => refused(422, "Client ID can't be longer than 512 characters", "clientId"), begun];
    const requests = serve({ sent: () => answers.shift()!() });
    const { user } = showNew();
    await user.type(await nameField(), "Linear");
    await user.type(urlField(), LINEAR.url);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.queryByLabelText("Client ID")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Sign in to mcp.linear.example" }));

    // The form says why, and asks for what registering Ember there gives, with the address to register it with.
    await waitFor(() => expect(tokenField()).toHaveAccessibleDescription(ASKS_FOR_CLIENT));
    expect(screen.getByRole("textbox", { name: "Redirect address" })).toHaveValue(`${location.origin}/account/apps/signed-in`);
    expect(screen.getByRole("textbox", { name: "Redirect address" })).toHaveAttribute("readonly");
    expect(screen.getByRole("textbox", { name: "Redirect address" })).toHaveAccessibleDescription(REDIRECT_EXPLAINED);
    expect(clientIdField()).toHaveAccessibleDescription(CLIENT_ID_EXPLAINED);
    expect(clientSecretField()).toHaveAccessibleDescription(CLIENT_SECRET_EXPLAINED);
    expect(clientSecretField()).toHaveAttribute("type", "password");

    // What's typed there stays to be typed on, and a refusal is said on its field.
    await user.type(clientIdField(), " ember-at-linear ");
    await user.type(clientSecretField(), "s3cret");
    expect(screen.getAllByRole("button", { name: "Sign in to mcp.linear.example" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Sign in to mcp.linear.example" }));
    expect(requests.at(-1)).toEqual({ request: "POST /api/account/app-sign-ins", body: { name: "Linear", url: LINEAR.url, clientId: "ember-at-linear", clientSecret: "s3cret" } });
    await waitFor(() => expect(clientIdField()).toHaveAccessibleDescription("Client ID can't be longer than 512 characters"));
    expect(clientIdField()).toBeInvalid();

    // Enter in either field signs in, rather than connecting the app without one.
    await user.type(clientSecretField(), "{Enter}");
    await waitFor(() => expect(openPage).toHaveBeenCalledWith(AUTHORIZE));
    expect(requests.map(({ request }) => request)).toEqual(["POST /api/account/apps", "POST /api/account/app-sign-ins", "POST /api/account/app-sign-ins", "POST /api/account/app-sign-ins"]);

    // Another address is another service, which may come to know Ember by itself.
    await user.type(urlField(), "/v2");
    expect(screen.queryByLabelText("Client ID")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Sign in/ })).toBeNull();

    // What was typed for the last one doesn't follow the form there, should that service ask who Ember is too.
    answers.push(() => refused(422, ASKS_FOR_SIGN_IN, "token", true), asksForClient, begun);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: "Sign in to mcp.linear.example" }));
    await waitFor(() => expect(clientIdField()).toHaveValue(""));
    expect(clientSecretField()).toHaveValue("");
    await user.type(clientIdField(), "ember-two");
    await user.click(screen.getByRole("button", { name: "Sign in to mcp.linear.example" }));
    await waitFor(() => expect(requests.at(-1)).toEqual({ request: "POST /api/account/app-sign-ins", body: { name: "Linear", url: `${LINEAR.url}/v2`, clientId: "ember-two" } }));
  });

  it("says so, as the workspace's alerts do, when as many apps are connected as can be", async () => {
    serve({ sent: () => refused(409, APPS_FULL) });
    const { user, onFailed } = showNew();
    await user.type(await nameField(), "Linear");
    await user.type(urlField(), LINEAR.url);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("sends anyone but an administrator to workspace settings at once, saying why, and asks the server nothing", async () => {
    const requests = serve({ listed: () => refused(403, APPS_FORBIDDEN) });
    const { onFailed } = showNew({ ...ada, administrator: false });
    expect(await flashed()).toHaveTextContent(APPS_FORBIDDEN);
    expect(location.pathname).toBe("/account/edit");
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(requests).toEqual([]);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("sends an administrator to the AI assistant tab while Ember AI is off, saying so", async () => {
    serve({ listed: () => refused(409, ASSISTANT_OFF) });
    showNew();
    expect(await flashed()).toHaveTextContent(ASSISTANT_OFF);
    expect(location.pathname + location.hash).toBe(AGENTS_PATH);
  });
});

describe("A connected app's page", () => {
  it("shows the app as it's connected, never its token, and the tools Ember read, each with what its server says of it", async () => {
    serve();
    showSettings();
    expect(await nameField()).toHaveValue("Linear");
    expect(screen.getByRole("heading", { level: 1, name: "Edit app" })).toBeVisible();
    expect(urlField()).toHaveValue(LINEAR.url);
    expect(tokenField()).toHaveValue("");
    expect(tokenField()).toHaveAccessibleDescription(TOKEN_KEPT);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    expect(within(tools()).getByRole("heading", { name: "Tools (2)" })).toBeVisible();
    expect(tools()).toHaveTextContent("Its server calls itself Linear MCP");
    expect(tools()).toHaveTextContent("Connected by Ada Lovelace");
    const [create, list] = within(tools()).getAllByRole("listitem");
    expect(create).toHaveTextContent("create_issue");
    expect(create).toHaveTextContent("Create issue");
    expect(create).toHaveTextContent("Creates an issue in a team. It needs a title.");
    expect(list).toHaveTextContent(/^list_issues$/);
    expect(tools()).not.toHaveTextContent("Ember leaves out");
    expect(within(tools()).queryByRole("group")).toBeNull();
  });

  it("says who signed in to an app that signs in to its server, in place of a token, and keeps its address", async () => {
    serve({ loaded: () => answer(SIGNED_IN) });
    const { user } = showSettings();
    expect(await nameField()).toHaveValue("Linear");

    expect(screen.queryByLabelText("Token")).toBeNull();
    const signIn = screen.getByRole("group", { name: "Sign-in" });
    expect(signIn).toHaveTextContent(signedInBy(SIGNED_IN.signIn!));
    expect(signedInBy(SIGNED_IN.signIn!)).toMatch(/^Signed in by Ada Lovelace, .+\.$/);
    expect(signIn).toHaveTextContent(SIGN_IN_EXPLAINED);
    expect(signIn).not.toHaveTextContent(SIGN_IN_HAS_ENDED);
    expect(urlField()).toHaveAttribute("readonly");
    expect(urlField()).toHaveAccessibleDescription(ADDRESS_KEPT);
    // Its name is still its administrators' to change.
    await user.type(await nameField(), " issues");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("says what an app's server has asked for beyond its sign-in, which Sign in again then asks for", async () => {
    const requests = serve({ loaded: () => answer({ ...SIGNED_IN, signIn: { ...SIGNED_IN.signIn!, wantsScope: "issues:write projects:read" } }), sent: begun });
    const { user } = showSettings();
    await nameField();
    const signIn = within(screen.getByRole("group", { name: "Sign-in" }));
    expect(signIn.getByRole("alert")).toHaveTextContent(wantsMore("issues:write projects:read"));
    expect(wantsMore("issues:write projects:read")).toContain("(issues:write, projects:read)");

    await user.click(signIn.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(openPage).toHaveBeenCalledWith(AUTHORIZE));
    expect(requests).toEqual([{ request: SIGN_IN, body: undefined }]);
  });

  it("says a sign-in has ended, and signs in again by sending the browser where its server signs people in", async () => {
    const requests = serve({ loaded: () => answer({ ...SIGNED_IN, signIn: { ...SIGNED_IN.signIn!, ended: true } }), sent: begun });
    const { user } = showSettings();
    await nameField();
    expect(within(screen.getByRole("group", { name: "Sign-in" })).getByRole("alert")).toHaveTextContent(SIGN_IN_HAS_ENDED);

    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(openPage).toHaveBeenCalledWith(AUTHORIZE));
    expect(requests).toEqual([{ request: SIGN_IN, body: undefined }]);
  });

  it("shows the client ID an app signed in with, never its secret, and signs in again as that client, or as another that's typed", async () => {
    const requests = serve({ loaded: () => answer(SIGNED_IN_AS_CLIENT), sent: begun });
    const { user } = showSettings();
    await nameField();
    const signIn = within(screen.getByRole("group", { name: "Sign-in" }));
    expect(signIn.getByRole("textbox", { name: "Redirect address" })).toHaveValue(`${location.origin}/account/apps/signed-in`);
    expect(clientIdField()).toHaveValue("ember-at-linear");
    expect(clientSecretField()).toHaveValue("");
    expect(clientSecretField()).toHaveAttribute("placeholder", "Unchanged");
    expect(clientSecretField()).toHaveAccessibleDescription(CLIENT_SECRET_KEPT);
    // Typing there is nothing for Save changes to send.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    // Untouched, the ID goes without a secret, which keeps the one Ember has.
    await user.click(signIn.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(openPage).toHaveBeenCalledTimes(1));
    expect(requests.at(-1)).toEqual({ request: SIGN_IN, body: { clientId: "ember-at-linear" } });

    // Another ID's secret is its own, and no ID has the service come to know Ember by itself.
    await user.clear(clientIdField());
    await user.type(clientIdField(), "ember-two");
    expect(clientSecretField()).toHaveAttribute("placeholder", "None");
    expect(clientSecretField()).toHaveAccessibleDescription(CLIENT_SECRET_EXPLAINED);
    await user.type(clientSecretField(), "another-s3cret");
    await user.click(signIn.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(openPage).toHaveBeenCalledTimes(2));
    expect(requests.at(-1)).toEqual({ request: SIGN_IN, body: { clientId: "ember-two", clientSecret: "another-s3cret" } });
    await user.clear(clientIdField());
    await user.clear(clientSecretField());
    await user.click(signIn.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(openPage).toHaveBeenCalledTimes(3));
    expect(requests.at(-1)).toEqual({ request: SIGN_IN, body: { clientId: "" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("asks who Ember is once signing in again finds a service that doesn't let Ember register itself any more", async () => {
    const answers = [asksForClient, begun];
    const requests = serve({ loaded: () => answer(SIGNED_IN), sent: () => answers.shift()!() });
    const { user } = showSettings();
    await nameField();
    expect(screen.queryByLabelText("Client ID")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Sign in again" }));

    const signIn = within(screen.getByRole("group", { name: "Sign-in" }));
    expect(await signIn.findByRole("alert")).toHaveTextContent(ASKS_FOR_CLIENT);
    await user.type(signIn.getByRole("textbox", { name: "Client ID" }), "ember-at-linear");
    await user.click(signIn.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(openPage).toHaveBeenCalledWith(AUTHORIZE));
    expect(requests).toEqual([
      { request: SIGN_IN, body: undefined },
      { request: SIGN_IN, body: { clientId: "ember-at-linear" } },
    ]);
  });

  it("signs in again as the client another administrator signed in as since, once its tools are read again, rather than as none", async () => {
    const answers = [() => answer(SIGNED_IN_AS_CLIENT), begun];
    const requests = serve({ loaded: () => answer(SIGNED_IN), sent: () => answers.shift()!() });
    const { user } = showSettings();
    await nameField();
    await user.click(within(tools()).getByRole("button", { name: "Read its tools again" }));

    await waitFor(() => expect(clientIdField()).toHaveValue("ember-at-linear"));
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(openPage).toHaveBeenCalledWith(AUTHORIZE));
    expect(requests.at(-1)).toEqual({ request: SIGN_IN, body: { clientId: "ember-at-linear" } });
  });

  it("doesn't send a secret typed for the client an app had with the one another administrator signed in as since, once its tools are read again", async () => {
    const answers = [() => answer({ ...SIGNED_IN_AS_CLIENT, signIn: { ...SIGNED_IN.signIn!, clientId: "ember-three" } }), begun];
    const requests = serve({ loaded: () => answer(SIGNED_IN_AS_CLIENT), sent: () => answers.shift()!() });
    const { user } = showSettings();
    await nameField();
    await user.type(clientSecretField(), "a-secret-for-the-last-client");
    await user.click(within(tools()).getByRole("button", { name: "Read its tools again" }));

    await waitFor(() => expect(clientIdField()).toHaveValue("ember-three"));
    expect(clientSecretField()).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(openPage).toHaveBeenCalledWith(AUTHORIZE));
    expect(requests.at(-1)).toEqual({ request: SIGN_IN, body: { clientId: "ember-three" } });
  });

  it("keeps a secret typed for the client an app still has, once its tools are read again", async () => {
    serve({ loaded: () => answer(SIGNED_IN_AS_CLIENT), sent: () => answer(SIGNED_IN_AS_CLIENT) });
    const { user } = showSettings();
    await nameField();
    await user.type(clientSecretField(), "another-s3cret");
    await user.click(within(tools()).getByRole("button", { name: "Read its tools again" }));

    await waitFor(() => expect(within(tools()).getByRole("button", { name: "Read its tools again" })).toBeEnabled());
    expect(clientIdField()).toHaveValue("ember-at-linear");
    expect(clientSecretField()).toHaveValue("another-s3cret");
  });

  it("keeps the client ID that's typed once its tools are read again, whatever another administrator signed in as since", async () => {
    serve({ loaded: () => answer(SIGNED_IN_AS_CLIENT), sent: () => answer({ ...SIGNED_IN_AS_CLIENT, signIn: { ...SIGNED_IN.signIn!, clientId: "ember-three" } }) });
    const { user } = showSettings();
    await nameField();
    await user.clear(clientIdField());
    await user.type(clientIdField(), "ember-two");
    await user.click(within(tools()).getByRole("button", { name: "Read its tools again" }));

    await waitFor(() => expect(clientSecretField()).toHaveAttribute("placeholder", "None"));
    expect(clientIdField()).toHaveValue("ember-two");
  });

  it("says why signing in again couldn't begin, under Sign in again", async () => {
    const why = "mcp.linear.example doesn't say how to sign in to it. Give a token for it, if it has one.";
    serve({ loaded: () => answer(SIGNED_IN), sent: () => refused(422, why, "token") });
    const { user } = showSettings();
    await nameField();
    await user.click(screen.getByRole("button", { name: "Sign in again" }));

    expect(await within(screen.getByRole("group", { name: "Sign-in" })).findByRole("alert")).toHaveTextContent(why);
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeEnabled();
    expect(openPage).not.toHaveBeenCalled();
  });

  it("says which tools are set aside for the agents that had them, as the app changed them or no longer has them, with a link to each agent's page", async () => {
    const setAside = [
      { name: "close_issue", gone: true, agents: [{ id: "0mgk3x2a9b4c81", name: "Recap" }] },
      { name: "create_issue", gone: false, agents: [{ id: "ember", name: "Ember" }, { id: "0mgk3x2a9b4c81", name: "Recap" }] },
    ];
    serve({ loaded: () => answer({ ...LINEAR, setAside }) });
    showSettings();
    await nameField();

    const group = within(tools()).getByRole("group", { name: SET_ASIDE_EXPLAINED });
    const [closed, created] = within(group).getAllByRole("listitem");
    expect(closed).toHaveTextContent(`close_issue${TOOL_IS_GONE}, picked for Recap`);
    expect(created).toHaveTextContent("create_issuepicked for Ember, Recap");
    expect(within(created!).getByRole("link", { name: "Ember" })).toHaveAttribute("href", agentSettingsPath("ember"));
    expect(within(created!).getByRole("link", { name: "Recap" })).toHaveAttribute("href", agentSettingsPath("0mgk3x2a9b4c81"));
    // The tools themselves are listed under it as ever.
    expect(within(tools()).getAllByRole("listitem")).toHaveLength(4);
  });

  it("says so of an app whose server has no tools any more, over the ones set aside for the agents that had them", async () => {
    serve({ loaded: () => answer({ ...LINEAR, tools: [], setAside: [{ name: "create_issue", gone: true, agents: [{ id: "ember", name: "Ember" }] }] }) });
    showSettings();
    await nameField();

    expect(within(tools()).getByRole("heading", { name: "Tools" })).toBeVisible();
    expect(within(tools()).getByText(NO_TOOLS)).toBeVisible();
    expect(within(tools()).getAllByRole("listitem")).toHaveLength(1);
  });

  it("says how many tools Ember left out, when the server has more than it keeps", async () => {
    serve({ loaded: () => answer({ ...LINEAR, toolsLeftOut: 12, serverName: null, connectedBy: null }) });
    showSettings();
    await nameField();
    expect(tools()).toHaveTextContent(toolsLeftOut(12));
    expect(tools()).not.toHaveTextContent("calls itself");
    expect(tools()).not.toHaveTextContent("Connected by");
  });

  it("saves only what was changed, and says so", async () => {
    const requests = serve({ sent: () => answer({ ...LINEAR, name: "Linear (work)" }) });
    const { user } = showSettings();
    await user.type(await nameField(), " (work)");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await flashed()).toHaveTextContent(CHANGES_SAVED);
    expect(requests).toEqual([{ request: `PATCH /api/account/apps/${LINEAR.id}`, body: { name: "Linear (work)" } }]);
    expect(await nameField()).toHaveValue("Linear (work)");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(location.pathname).toBe(appSettingsPath(LINEAR.id));
  });

  it("says it's reading the app's tools while another address or token is saved, then how many it read", async () => {
    let saved!: (response: Response) => void;
    const requests = serve({ sent: () => new Promise((resolve) => (saved = resolve)) });
    const { user } = showSettings();
    await nameField();
    await user.type(tokenField(), "lin_api_456");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // The form's note, over the Tools card's.
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(READING_TOOLS);
    expect(within(tools()).getByRole("status")).toHaveTextContent("");
    expect(requests[0]!.body).toEqual({ token: "lin_api_456" });
    // Nothing can be typed until the server answers, as its answer would replace it.
    await user.type(await nameField(), "!");
    await user.type(tokenField(), "7");
    expect(await nameField()).toHaveValue("Linear");
    expect(tokenField()).toHaveValue("lin_api_456");
    expect(screen.getByRole("checkbox", { name: "Send no token" })).toBeDisabled();
    saved(answer({ ...LINEAR, tools: [LINEAR.tools[0]!] }));
    expect(await flashed()).toHaveTextContent("Changes saved. Ember read 1 tool from Linear.");
    expect(within(tools()).getByRole("heading", { name: "Tools (1)" })).toBeVisible();
    expect(tokenField()).toHaveValue("");
  });

  it("stops sending the token once Send no token is checked, which turns the token field off", async () => {
    const requests = serve({ sent: () => answer({ ...LINEAR, hasToken: false }) });
    const { user } = showSettings();
    await nameField();
    await user.click(screen.getByRole("checkbox", { name: "Send no token" }));
    expect(tokenField()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(requests).toEqual([{ request: `PATCH /api/account/apps/${LINEAR.id}`, body: { token: "" } }]));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Send no token" })).toBeNull());
    expect(tokenField()).toHaveAccessibleDescription(TOKEN_EXPLAINED);
  });

  it("reads the app's tools again, keeping what's typed, and shows what it read", async () => {
    const requests = serve({ sent: () => answer({ ...LINEAR, tools: [...LINEAR.tools, { name: "close_issue", title: null, description: "Closes an issue." }] }) });
    const { user } = showSettings();
    await user.type(await nameField(), "!");
    await user.click(within(tools()).getByRole("button", { name: "Read its tools again" }));

    expect(await within(tools()).findByRole("heading", { name: "Tools (3)" })).toBeVisible();
    expect(requests).toEqual([{ request: `POST /api/account/apps/${LINEAR.id}/tools`, body: undefined }]);
    expect(await nameField()).toHaveValue("Linear!");
  });

  it("follows what another administrator saved, in the fields left as they were, once its tools are read again, so that the next save doesn't put the old back", async () => {
    const elsewhere = { ...LINEAR, name: "Linear (EU)", url: "https://mcp.eu.linear.example/mcp" };
    const requests = serve({ sent: (request) => answer(request.startsWith("POST") ? elsewhere : { ...elsewhere, name: "Linear!" }) });
    const { user } = showSettings();
    await user.type(await nameField(), "!");
    await user.click(within(tools()).getByRole("button", { name: "Read its tools again" }));

    // The address wasn't touched, so it's the one saved since; the name was, so it stays as typed.
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Server address" })).toHaveValue(elsewhere.url));
    expect(await nameField()).toHaveValue("Linear!");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(requests.at(-1)).toEqual({ request: `PATCH /api/account/apps/${LINEAR.id}`, body: { name: "Linear!" } }));
  });

  it("lets a token be typed again once the tools are read again of an app another administrator took the token from", async () => {
    serve({ sent: () => answer({ ...LINEAR, hasToken: false }) });
    const { user } = showSettings();
    await user.click(await screen.findByRole("checkbox", { name: "Send no token" }));
    expect(tokenField()).toBeDisabled();
    await user.click(within(tools()).getByRole("button", { name: "Read its tools again" }));

    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Send no token" })).toBeNull());
    expect(tokenField()).toBeEnabled();
  });

  it("says why its tools couldn't be read again, in the Tools card, leaving those it has", async () => {
    const why = "mcp.linear.example took too long to answer.";
    serve({ sent: () => refused(422, why) });
    const { user, onFailed } = showSettings();
    await nameField();
    await user.click(within(tools()).getByRole("button", { name: "Read its tools again" }));

    await waitFor(() => expect(within(tools()).getByRole("status")).toHaveTextContent(why));
    expect(within(tools()).getAllByRole("listitem")).toHaveLength(2);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("offers no sign-in while the form has another address than the app's, which is where Ember would sign in, and says so", async () => {
    const elsewhere = "https://mcp.eu.linear.example/mcp";
    serve({ sent: () => refused(422, "mcp.eu.linear.example didn't take that token.", "token", true) });
    const { user } = showSettings();
    await nameField();
    await user.clear(urlField());
    await user.type(urlField(), elsewhere);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(tokenField()).toHaveAccessibleDescription("mcp.eu.linear.example didn't take that token."));
    expect(screen.getByText(SIGN_IN_STAYS)).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Sign in/ })).toBeNull();
  });

  it("offers to sign in to an app whose server takes its token no longer, once its tools couldn't be read again for that", async () => {
    const why = "mcp.linear.example didn't take that token.";
    const answers = [() => refused(422, why, undefined, true), begun];
    const requests = serve({ sent: () => answers.shift()!() });
    const { user } = showSettings();
    await nameField();
    expect(screen.queryByRole("button", { name: /^Sign in/ })).toBeNull();
    await user.click(within(tools()).getByRole("button", { name: "Read its tools again" }));

    await waitFor(() => expect(within(tools()).getByRole("status")).toHaveTextContent(why));
    await user.click(screen.getByRole("button", { name: "Sign in to mcp.linear.example" }));
    await waitFor(() => expect(openPage).toHaveBeenCalledWith(AUTHORIZE));
    expect(requests.at(-1)).toEqual({ request: SIGN_IN, body: undefined });
    // What was offered was for the read that failed: the next thing asked starts over.
    expect(screen.queryByRole("button", { name: /^Sign in/ })).toBeNull();
  });

  it("removes the app once the administrator is sure, and goes back to the AI assistant tab", async () => {
    const requests = serve();
    const sure = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user } = showSettings();
    await nameField();
    await user.click(screen.getByRole("button", { name: "Remove Linear" }));
    expect(sure).toHaveBeenCalledWith(CONFIRM_REMOVE_APP);
    expect(requests).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Remove Linear" }));
    await waitFor(() => expect(location.pathname + location.hash).toBe(AGENTS_PATH));
    expect(requests).toEqual([{ request: `DELETE /api/account/apps/${LINEAR.id}`, body: undefined }]);
  });

  it("says whether its service took back Ember's sign-in, once an app Ember was signed in to is removed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    serve({ loaded: () => answer(SIGNED_IN), sent: () => Response.json({ revoked: true }) });
    const { user } = showSettings();
    await nameField();
    await user.click(screen.getByRole("button", { name: "Remove Linear" }));
    expect(await flashed()).toHaveTextContent("Linear is removed, and mcp.linear.example took back Ember's sign-in.");
    expect(location.pathname + location.hash).toBe(AGENTS_PATH);
  });

  it("says to remove Ember's access at its service, once an app is removed whose service didn't take back Ember's sign-in", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    serve({ loaded: () => answer(SIGNED_IN), sent: () => Response.json({ revoked: false }) });
    const { user } = showSettings();
    await nameField();
    await user.click(screen.getByRole("button", { name: "Remove Linear" }));
    expect(await flashed()).toHaveTextContent(removedNotice("Linear", LINEAR.url, false));
    expect(removedNotice("Linear", LINEAR.url, false)).toBe("Linear is removed. Ember couldn't take back its sign-in at mcp.linear.example, so remove Ember's access there.");
    expect(location.pathname + location.hash).toBe(AGENTS_PATH);
  });

  it("shows the 404 page for an id that isn't a connected app's", async () => {
    serve({ loaded: () => refused(404, "Not found") });
    const { onMissing, onFailed } = showSettings();
    await waitFor(() => expect(onMissing).toHaveBeenCalledTimes(1));
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("sends anyone but an administrator to workspace settings at once, asking the server nothing", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    showSettings({ ...ada, administrator: false });
    expect(await flashed()).toHaveTextContent(APPS_FORBIDDEN);
    expect(location.pathname).toBe("/account/edit");
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe("What Save changes sends", () => {
  const typed = { name: LINEAR.name, url: LINEAR.url, token: "", noToken: false, clientId: "", clientSecret: "" };

  it("is only what's typed differently from the app as it loaded", () => {
    expect(changesOf(LINEAR, typed)).toEqual({});
    expect(changesOf(LINEAR, { ...typed, name: " Linear " })).toEqual({});
    expect(changesOf(LINEAR, { ...typed, name: "Tracker", url: "https://mcp.linear.example/v2/mcp" })).toEqual({ name: "Tracker", url: "https://mcp.linear.example/v2/mcp" });
  });

  it("is a token that's typed, or none for an app that has one once Send no token is checked", () => {
    expect(changesOf(LINEAR, { ...typed, token: "lin_api_456" })).toEqual({ token: "lin_api_456" });
    expect(changesOf(LINEAR, { ...typed, noToken: true })).toEqual({ token: "" });
    expect(changesOf({ ...LINEAR, hasToken: false }, { ...typed, noToken: true })).toEqual({});
  });
});
