import type { Bootstrap, Me } from "@ember/protocol";
import { OUTSIDE_ASK_REFUSED, OUTSIDE_FULL, OUTSIDE_SCOPE_EXPLAINED, type OutsideAsked } from "@ember/protocol/outside";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPage } from "@/lib/page";
import { takeReturnPath } from "@/lib/return-path";
import { CHROME_MAC } from "@/test-platforms";
import { comesBackTo, OutsideConnectPage } from "./outside-connect-page";

vi.mock("@/lib/page", () => ({ loadPage: vi.fn() }));

const grace: Me = { id: "u2", name: "Grace Hopper", administrator: false };
const workspace: Omit<Bootstrap, "user"> = {
  setup: "complete",
  setupAccess: "link",
  setupPlaceholders: { name: "Kevin Rose", emailAddress: "kevin@kevinrose.com" },
  guestSignIn: false,
  signInWithMemberful: false,
  turnstileSiteKey: null,
  passwordResetCodes: false,
  account: { name: "Fernwood", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false },
  version: "0.1",
  vapidPublicKey: null,
  platform: CHROME_MAC,
};

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const BACK = "https://claude.example/api/mcp/auth_callback";
const REQUEST = `/oauth/authorize?response_type=code&client_id=0mgk3x2a9b4c70&redirect_uri=${encodeURIComponent(BACK)}&state=5f2c01&code_challenge=${CHALLENGE}&code_challenge_method=S256&scope=read&resource=${encodeURIComponent("https://ember.test/mcp")}`;
const ASK = { responseType: "code", clientId: "0mgk3x2a9b4c70", redirectUri: BACK, state: "5f2c01", codeChallenge: CHALLENGE, codeChallengeMethod: "S256", scope: "read", resource: "https://ember.test/mcp" };
const CLAUDE: OutsideAsked = { name: "Claude", comesBackTo: "claude.example", workspace: "Fernwood", scopes: ["read"] };
const ALLOWED = `${BACK}?code=c0de&state=5f2c01&iss=https%3A%2F%2Fember.test`;

/** Answers the page's requests as `answers` has them, by method and path, keeping what each sent. */
function serve(answers: Record<string, () => Response | Promise<Response>>) {
  const sent: Array<[string, unknown]> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    sent.push([request, JSON.parse(String(init?.body))]);
    const answer = answers[request];
    if (!answer) throw new Error(`Unexpected request for ${request}`);
    return answer();
  });
  return sent;
}

/** Opens the page at `address`, an app's request unless given, as Grace. */
function open(address = REQUEST) {
  history.replaceState(null, "", address);
  render(<OutsideConnectPage me={grace} workspace={workspace} />);
  return userEvent.setup();
}

const described = () => Response.json(CLAUDE);
const problem = (status: number, error: string) => () => Response.json({ error }, { status });

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(loadPage).mockClear();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

describe("The page that asks whether to connect an AI app", () => {
  it("asks Ember about the request in its address, and says which app asks, as whom, what it could do, and where the browser goes back", async () => {
    const sent = serve({ "POST /api/outside/asks": described });
    open();
    expect(screen.queryByRole("heading")).toBeNull();

    expect(await screen.findByRole("heading", { level: 1, name: "Connect Claude to Fernwood?" })).toBeVisible();
    expect(sent).toEqual([["POST /api/outside/asks", ASK]]);
    expect(screen.getByText("It would act as you, Grace Hopper.")).toBeVisible();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([OUTSIDE_SCOPE_EXPLAINED.read]);
    expect(screen.getByText(comesBackTo("claude.example"))).toBeVisible();
    expect(comesBackTo("claude.example")).toBe("You'll go back to claude.example. Allow this only if that's where you started.");
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Don't allow" })).toBeEnabled();
    expect(document.title).toContain("Connect an AI app");
  });

  it("sends the browser back to the app with a code once you allow it, in place of this page", async () => {
    const sent = serve({ "POST /api/outside/asks": described, "POST /api/outside/answers": () => Response.json({ redirectTo: ALLOWED }) });
    const user = open();

    await user.click(await screen.findByRole("button", { name: "Allow" }));

    await waitFor(() => expect(loadPage).toHaveBeenCalledExactlyOnceWith(ALLOWED));
    expect(sent[1]).toEqual(["POST /api/outside/answers", { ask: ASK, allow: true }]);
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Don't allow" })).toBeDisabled();
  });

  it("sends the browser back saying you didn't, when you don't allow it", async () => {
    const refused = `${BACK}?error=access_denied&state=5f2c01&iss=https%3A%2F%2Fember.test`;
    const sent = serve({ "POST /api/outside/asks": described, "POST /api/outside/answers": () => Response.json({ redirectTo: refused }) });
    const user = open();

    await user.click(await screen.findByRole("button", { name: "Don't allow" }));

    await waitFor(() => expect(loadPage).toHaveBeenCalledExactlyOnceWith(refused));
    expect(sent[1]).toEqual(["POST /api/outside/answers", { ask: ASK, allow: false }]);
  });

  it("says a request Ember can't answer can't be connected, with the way home, and sends the browser nowhere", async () => {
    const sent = serve({ "POST /api/outside/asks": problem(422, OUTSIDE_ASK_REFUSED) });
    open("/oauth/authorize?client_id=unknown");

    expect(await screen.findByRole("alert")).toHaveTextContent(OUTSIDE_ASK_REFUSED);
    expect(screen.getByRole("heading", { level: 1, name: "This app can't be connected" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to Fernwood" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(sent[0]![1]).toEqual({ responseType: null, clientId: "unknown", redirectUri: null, state: null, codeChallenge: null, codeChallengeMethod: null, scope: null, resource: null });
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("says why allowing failed, such as having as many connected as one may", async () => {
    serve({ "POST /api/outside/asks": described, "POST /api/outside/answers": problem(409, OUTSIDE_FULL) });
    const user = open();

    await user.click(await screen.findByRole("button", { name: "Allow" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(OUTSIDE_FULL);
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("says when Ember can't be reached", async () => {
    serve({
      "POST /api/outside/asks": () => {
        throw new TypeError("Failed to fetch");
      },
    });
    open();

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach Ember. Check your connection and try again.");
  });

  it("goes to sign in again once the session has ended, remembering the request to come back to", async () => {
    serve({ "POST /api/outside/asks": described, "POST /api/outside/answers": problem(401, "Not signed in") });
    const user = open();

    await user.click(await screen.findByRole("button", { name: "Allow" }));

    await waitFor(() => expect(loadPage).toHaveBeenCalledExactlyOnceWith("/session/new"));
    expect(takeReturnPath()).toBe(REQUEST);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
