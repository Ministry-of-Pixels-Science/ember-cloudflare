import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileAnswer } from "@ember/protocol";
import { SSO_CONNECTIONS_PATH, type SsoAccount } from "@ember/protocol/sso";
import { openPage } from "@/lib/page";
import { SingleSignOnConnection } from "./sso-connection";

vi.mock("@/lib/page", () => ({ loadPage: vi.fn(), openPage: vi.fn() }));

/** Where the provider signs you in to connect your account there. */
const SSO_AUTHORIZE = "https://example.zitadel.cloud/oauth/v2/authorize?client_id=ember&state=s7a7e";
const grace: SsoAccount = { name: "Grace Hopper", emailAddress: "grace@example.com" };
const DISCONNECTED: ProfileAnswer = {
  profile: {
    name: "Grace Hopper",
    username: null,
    emailAddress: "grace@example.com",
    bio: null,
    avatarUrl: "/users/t0k3n/avatar?v=1",
    avatar: false,
    password: true,
    membershipNeeded: true,
    memberful: null,
    sso: { name: "Acme", ssoOnly: true, connected: null },
    assistant: null,
    apps: [],
    outsideAi: null,
  },
  transferId: "u2.mgk3x2b0.saved",
};

const serve = () =>
  vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, init) => (init?.method === "DELETE" ? Response.json(DISCONNECTED) : Response.json({ ssoConnection: SSO_AUTHORIZE }, { status: 202 })));

/** What each request to connect or disconnect sent, in order. */
const sent = (method: "POST" | "DELETE") =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([input, init]) => String(input) === SSO_CONNECTIONS_PATH && init?.method === method)
    .map(([, init]) => JSON.parse(String(init?.body)) as unknown);

function showSection({ connected = null as SsoAccount | null, ssoOnly = true, membershipNeeded = true } = {}) {
  const [onDisconnected, onFailed] = [vi.fn(), vi.fn()];
  render(
    <SingleSignOnConnection
      name="Acme"
      connected={connected}
      ssoOnly={ssoOnly}
      hasPassword
      hasEmailAddress
      membershipNeeded={membershipNeeded}
      onDisconnected={onDisconnected}
      onFailed={onFailed}
    />,
  );
  return { onDisconnected, onFailed, user: userEvent.setup() };
}

const section = () => screen.getByRole("region", { name: "Single sign-on" });

// Braced, since vitest calls a function the hook returns after each test, as it would fetch's spy,
// which hangs there while a test holds fetch's answer.
beforeEach(() => {
  serve();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(openPage).mockClear();
});

describe("Connect single sign-on", () => {
  it("asks a member to connect their account at the provider, named as the sign-in page names it, with their password", async () => {
    const { user } = showSection();
    expect(section()).toHaveTextContent("Members sign in with Acme. Connect your Acme account to keep signing in.");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Connect Acme" }));
    await waitFor(() => expect(openPage).toHaveBeenCalledWith(SSO_AUTHORIZE));
    expect(sent("POST")).toEqual([{ currentPassword: "correct horse" }]);
  });

  it("stays on the page you went to while connecting was under way", async () => {
    let answer = (_: Response) => {};
    vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { user } = showSection();
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Connect Acme" }));
    expect(sent("POST")).toEqual([{ currentPassword: "correct horse" }]);
    cleanup();
    await act(async () => answer(Response.json({ ssoConnection: SSO_AUTHORIZE }, { status: 202 })));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(openPage).not.toHaveBeenCalled();
  });
});

describe("Disconnect single sign-on", () => {
  it("names the account you've connected, and disconnects it once your password checks out", async () => {
    const { user, onDisconnected } = showSection({ connected: grace });
    expect(section()).toHaveTextContent("Connected as Grace Hopper (grace@example.com). You sign in with Acme.");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Disconnect Acme" }));
    await waitFor(() => expect(onDisconnected).toHaveBeenCalledWith(DISCONNECTED));
    expect(sent("DELETE")).toEqual([{ currentPassword: "correct horse" }]);
  });

  it("tells a member they can sign in with it too while it isn't the only way in", () => {
    showSection({ connected: grace, ssoOnly: false });
    expect(section()).toHaveTextContent("Connected as Grace Hopper (grace@example.com). You can sign in with Acme or your password.");
  });
});
