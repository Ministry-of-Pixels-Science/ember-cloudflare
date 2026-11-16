import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "@ember/protocol";
import { APP_SIGN_IN_ENDED, APPS_FORBIDDEN, YOUR_APP_GONE, type App, type AppSignedIn, type YourAppSignedIn } from "@ember/protocol/apps";
import { ASSISTANT_OFF } from "@ember/protocol/assistant";
import { FlashProvider } from "@/components/flash";
import { Sheet } from "@/components/ui/sheet";
import { APP_SIGNED_IN_PATH, PROFILE_PATH } from "@ember/protocol";
import { appSettingsPath, WORKSPACE_SETTINGS_PATH } from "@/hooks/use-route";
import { AGENTS_PATH } from "./agent-list";
import { AppSignedInPage, FINISHING_OWN_SIGN_IN, FINISHING_SIGN_IN, SIGN_IN_NOT_FINISHED, SIGN_IN_TURNED_DOWN, signedInYourselfNotice } from "./app-signed-in-page";

const ada: Me = { id: "0mgk3x2a9b4c5d", name: "Ada Lovelace", administrator: true };

const LINEAR: App = {
  id: "0mgk3x2a9b4c70",
  name: "Linear",
  url: "https://mcp.linear.example/mcp",
  hasToken: false,
  serverName: "Linear MCP",
  tools: [
    { name: "create_issue", title: "Create issue", description: "Creates an issue in a team." },
    { name: "list_issues", title: null, description: "" },
  ],
  toolsLeftOut: 0,
  toolsReadAt: "2026-11-14T08:00:00.000Z",
  connectedBy: { id: ada.id, name: ada.name },
  setAside: [],
  signIn: { by: { id: ada.id, name: ada.name }, at: "2026-11-14T08:00:00.000Z", ended: false, clientId: null, wantsScope: null },
};

const FINISH = "POST /api/account/app-sign-ins/finish";

/** Answers finishing a sign-in as `finished` says, keeping what each request sent. */
function serve(finished: () => Response | Promise<Response> = () => Response.json({ app: LINEAR, again: false } satisfies AppSignedIn, { status: 201 })) {
  const requests: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    if (request !== FINISH) throw new Error(`Unexpected request for ${request}`);
    requests.push(JSON.parse(String(init?.body)));
    return finished();
  });
  return requests;
}

/** Shows the page as the browser comes back to it with `query` in the address, as the workspace does. */
function comeBack(query: string, { me = ada, strict = false } = {}) {
  const onFailed = vi.fn();
  history.replaceState(null, "", `${APP_SIGNED_IN_PATH}?${query}`);
  const page = (
    <FlashProvider workspace>
      <Sheet>
        <AppSignedInPage me={me} onFailed={onFailed} />
      </Sheet>
    </FlashProvider>
  );
  render(strict ? <StrictMode>{page}</StrictMode> : page);
  return { onFailed };
}

const flashed = () => screen.findByRole("alert");

/** Grace, a member, and Linear as her profile lists it once she has signed in to it herself. */
const grace: Me = { id: "0mgk3x2a9b4c5e", name: "Grace Hopper", administrator: false };
const YOURS: YourAppSignedIn = { yours: { id: LINEAR.id, name: "Linear", signedInAt: "2026-11-14T09:00:00.000Z", ended: false, wantsMore: false } };

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("The page an app's sign-in comes back to", () => {
  it("has Ember finish the sign-in with what came back, which leaves the address at once, then goes to the app's page, saying it's connected", async () => {
    let finished!: (response: Response) => void;
    const requests = serve(() => new Promise((resolve) => (finished = resolve)));
    comeBack("code=c0de-1&state=5f2c01&iss=https%3A%2F%2Fauth.linear.example");

    expect(screen.getByRole("heading", { level: 1, name: "Signing in…" })).toBeVisible();
    expect(screen.getByText(FINISHING_SIGN_IN)).toBeVisible();
    expect(location.pathname + location.search).toBe(APP_SIGNED_IN_PATH);
    await waitFor(() => expect(requests).toEqual([{ state: "5f2c01", code: "c0de-1", iss: "https://auth.linear.example" }]));

    finished(Response.json({ app: LINEAR, again: false } satisfies AppSignedIn, { status: 201 }));
    expect(await flashed()).toHaveTextContent("Linear is connected. Ember read 2 tools from it.");
    expect(location.pathname).toBe(appSettingsPath(LINEAR.id));
  });

  it("says Ember is signed in again to an app that was connected already, and sends no issuer when none came back", async () => {
    const requests = serve(() => Response.json({ app: LINEAR, again: true } satisfies AppSignedIn));
    comeBack("code=c0de-2&state=5f2c02");

    expect(await flashed()).toHaveTextContent("Ember is signed in to Linear again.");
    expect(location.pathname).toBe(appSettingsPath(LINEAR.id));
    expect(requests).toEqual([{ state: "5f2c02", code: "c0de-2" }]);
  });

  it("finishes a sign-in once, though React shows the page twice while it's developed", async () => {
    const requests = serve();
    comeBack("code=c0de-3&state=5f2c03", { strict: true });

    await waitFor(() => expect(location.pathname).toBe(appSettingsPath(LINEAR.id)));
    expect(requests).toHaveLength(1);
  });

  it("says a sign-in turned down there changed nothing, with the way back to the apps, and asks Ember nothing", async () => {
    const requests = serve();
    comeBack("error=access_denied&error_description=Call+this+number+to+finish&state=5f2c04");

    expect(await flashed()).toHaveTextContent(SIGN_IN_TURNED_DOWN);
    expect(screen.getByRole("heading", { level: 1, name: "The app isn't signed in to" })).toBeVisible();
    expect(document.body).not.toHaveTextContent("Call this number");
    expect(screen.getByRole("link", { name: "Back to the apps" })).toHaveAttribute("href", AGENTS_PATH);
    expect(location.search).toBe("");
    expect(requests).toEqual([]);
  });

  it("says a sign-in that came back with another error, or without a code, wasn't finished", async () => {
    const requests = serve();
    comeBack("error=server_error&state=5f2c05");
    expect(await flashed()).toHaveTextContent(SIGN_IN_NOT_FINISHED);
    expect(requests).toEqual([]);
  });

  it("says so of an address with nothing in it", async () => {
    const requests = serve();
    comeBack("");
    expect(await flashed()).toHaveTextContent(SIGN_IN_NOT_FINISHED);
    expect(requests).toEqual([]);
  });

  it("says why Ember couldn't finish the sign-in, and stays", async () => {
    serve(() => Response.json({ error: APP_SIGN_IN_ENDED }, { status: 422 }));
    const { onFailed } = comeBack("code=c0de-6&state=5f2c06");

    expect(await flashed()).toHaveTextContent(APP_SIGN_IN_ENDED);
    expect(location.pathname).toBe(APP_SIGNED_IN_PATH);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("sends an administrator who isn't one any more to workspace settings, saying why", async () => {
    serve(() => Response.json({ error: APPS_FORBIDDEN }, { status: 403 }));
    comeBack("code=c0de-7&state=5f2c07");

    expect(await flashed()).toHaveTextContent(APPS_FORBIDDEN);
    expect(location.pathname).toBe(WORKSPACE_SETTINGS_PATH);
  });

  it("has Ember finish a sign-in someone made themselves, and goes back to their profile, saying they're signed in", async () => {
    let finished!: (response: Response) => void;
    const requests = serve(() => new Promise((resolve) => (finished = resolve)));
    comeBack("code=c0de-9&state=5f2c09", { me: grace });

    expect(screen.getByText(FINISHING_OWN_SIGN_IN)).toBeVisible();
    await waitFor(() => expect(requests).toEqual([{ state: "5f2c09", code: "c0de-9" }]));
    finished(Response.json(YOURS));
    expect(await flashed()).toHaveTextContent(signedInYourselfNotice({ name: "Linear" }));
    expect(location.pathname).toBe(PROFILE_PATH);
  });

  it("takes an administrator's sign-in for their own when this tab noted it as that, and for Ember's otherwise, and goes where Ember says either way", async () => {
    sessionStorage.setItem("ember:own-app-sign-in", "5f2c10");
    serve(() => Response.json(YOURS));
    comeBack("code=c0de-10&state=5f2c10");
    expect(screen.getByText(FINISHING_OWN_SIGN_IN)).toBeVisible();
    await waitFor(() => expect(location.pathname).toBe(PROFILE_PATH));

    // Another sign-in than the one noted is Ember's to the page, and goes to the profile all the same when Ember says it's theirs.
    comeBack("code=c0de-11&state=5f2c11");
    expect(screen.getByText(FINISHING_SIGN_IN)).toBeVisible();
    await waitFor(() => expect(location.pathname).toBe(PROFILE_PATH));
  });

  it("says why a sign-in someone made themselves wasn't finished, with the way back to their profile", async () => {
    serve(() => Response.json({ error: YOUR_APP_GONE }, { status: 404 }));
    const { onFailed } = comeBack("code=c0de-12&state=5f2c12", { me: grace });

    expect(await flashed()).toHaveTextContent(YOUR_APP_GONE);
    expect(screen.getByRole("heading", { level: 1, name: "You aren't signed in to the app" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to your profile" })).toHaveAttribute("href", PROFILE_PATH);
    expect(location.pathname).toBe(APP_SIGNED_IN_PATH);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says a sign-in someone turned down for themselves changed nothing, with the way back to their profile", async () => {
    const requests = serve();
    comeBack("error=access_denied&state=5f2c13", { me: grace });

    expect(await flashed()).toHaveTextContent(SIGN_IN_TURNED_DOWN);
    expect(screen.getByRole("link", { name: "Back to your profile" })).toHaveAttribute("href", PROFILE_PATH);
    expect(requests).toEqual([]);
  });

  it("sends an administrator to the AI assistant tab while Ember AI is off, saying so", async () => {
    serve(() => Response.json({ error: ASSISTANT_OFF }, { status: 409 }));
    comeBack("code=c0de-8&state=5f2c08");
    expect(await flashed()).toHaveTextContent(ASSISTANT_OFF);
    expect(location.pathname + location.hash).toBe(AGENTS_PATH);
  });
});
