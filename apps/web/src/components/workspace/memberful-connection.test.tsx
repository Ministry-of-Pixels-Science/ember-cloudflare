import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_PASSWORD_WRONG,
  MAX_PASSWORD_LENGTH,
  MEMBERFUL_CONNECTIONS_PATH,
  type MemberfulAccount,
  type MemberfulConnectionStart,
  type MemberfulDisconnection,
  type ProfileAnswer,
} from "@ember/protocol";
import { ApiError } from "@/lib/api";
import { openPage } from "@/lib/page";
import { MemberfulConnection } from "./memberful-connection";

vi.mock("@/lib/page", () => ({ loadPage: vi.fn(), openPage: vi.fn() }));

/** Where the Memberful site signs you in to connect your account there. */
const MEMBERFUL_OAUTH = "https://example.memberful.com/oauth?response_type=code&client_id=ember&state=s7a7e";
/** Grace's Memberful account, as Memberful describes it. */
const grace: MemberfulAccount = { name: "Grace Hopper", emailAddress: "grace@example.com" };
/** Your profile once your Memberful account is disconnected, as disconnecting answers it. */
const DISCONNECTED: ProfileAnswer = {
  profile: {
    name: "Grace Hopper",
    emailAddress: "grace@example.com",
    bio: null,
    avatarUrl: "/users/t0k3n/avatar?v=1",
    avatar: false,
    password: true,
    membershipNeeded: true,
    memberful: { membersOnly: true, connected: null },
    assistant: null,
    apps: [],
    outsideAi: null,
  },
  transferId: "u2.mgk3x2b0.saved",
};
/** Where this browser's push subscription takes its pushes, when it has one. */
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/desk";

/** Answers Connect Memberful with where to sign in at the Memberful site, and Disconnect Memberful with your profile, or as `answer` says. */
const serve = (answer?: () => Response) =>
  vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, init) => answer?.() ?? (init?.method === "DELETE" ? Response.json(DISCONNECTED) : Response.json({ memberfulConnection: MEMBERFUL_OAUTH }, { status: 202 })));

/** What each request to connect or disconnect sent, in order. */
const sent = <T extends MemberfulConnectionStart | MemberfulDisconnection>(method: "POST" | "DELETE") =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([input, init]) => String(input) === MEMBERFUL_CONNECTIONS_PATH && init?.method === method)
    .map(([, init]) => JSON.parse(String(init?.body)) as T);

function showSection({ connected = null as MemberfulAccount | null, membersOnly = true, hasPassword = true, hasEmailAddress = true, membershipNeeded = true } = {}) {
  const [onDisconnected, onFailed] = [vi.fn(), vi.fn()];
  render(
    <MemberfulConnection
      connected={connected}
      membersOnly={membersOnly}
      hasPassword={hasPassword}
      hasEmailAddress={hasEmailAddress}
      membershipNeeded={membershipNeeded}
      onDisconnected={onDisconnected}
      onFailed={onFailed}
    />,
  );
  return { onDisconnected, onFailed, user: userEvent.setup() };
}

const section = () => screen.getByRole("region", { name: "Memberful" });
const connectButton = () => screen.getByRole("button", { name: "Connect Memberful" });
const disconnectButton = () => screen.getByRole("button", { name: "Disconnect Memberful" });

beforeEach(() => serve());

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(openPage).mockClear();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("Connect Memberful", () => {
  it("asks a member to connect their Memberful account with their password, to keep signing in as themselves", () => {
    showSection();
    expect(section()).toHaveTextContent("Members sign in with Memberful. Connect your Memberful account to keep signing in as yourself.");
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    expect(password).toHaveAttribute("placeholder", "Enter your password");
    expect(password).toHaveAttribute("maxlength", String(MAX_PASSWORD_LENGTH));
    expect(password).toBeRequired();
    expect(password).toHaveAccessibleDescription("Members sign in with Memberful. Connect your Memberful account to keep signing in as yourself.");
    expect(connectButton()).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Disconnect Memberful" })).not.toBeInTheDocument();
  });

  it("tells an administrator, or someone they invited, who needs no membership, that they can sign in with it too", () => {
    showSection({ membershipNeeded: false });
    expect(section()).toHaveTextContent("Members sign in with Memberful. Connect your Memberful account to sign in with it too.");
  });

  it("goes to sign in at the Memberful site once your password checks out, staying busy meanwhile", async () => {
    const { user, onFailed } = showSection();
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(connectButton());
    await waitFor(() => expect(openPage).toHaveBeenCalledWith(MEMBERFUL_OAUTH));
    expect(sent("POST")).toEqual([{ currentPassword: "correct horse" }]);
    expect(connectButton()).toBeDisabled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("asks for no password while you have none", async () => {
    const { user } = showSection({ hasPassword: false });
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    await user.click(connectButton());
    await waitFor(() => expect(openPage).toHaveBeenCalledWith(MEMBERFUL_OAUTH));
    expect(sent("POST")).toEqual([{}]);
  });

  it("says why it didn't start, emptying your password for another try", async () => {
    serve(() => Response.json({ error: CURRENT_PASSWORD_WRONG }, { status: 422 }));
    const { user, onFailed } = showSection();
    const password = screen.getByLabelText("Password");
    await user.type(password, "wrong horse");
    await user.click(connectButton());
    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(onFailed.mock.calls[0]![0]).toEqual(new ApiError(422, CURRENT_PASSWORD_WRONG));
    expect(password).toHaveValue("");
    expect(connectButton()).toBeEnabled();
    expect(openPage).not.toHaveBeenCalled();
  });
});

describe("Disconnect Memberful", () => {
  it("names the account you've connected, and offers to disconnect it with your password", () => {
    showSection({ connected: grace });
    expect(section()).toHaveTextContent("Connected to Memberful as Grace Hopper (grace@example.com), so you sign in with it.");
    expect(section()).toHaveTextContent("Disconnecting ends your other sessions. Signing in with your password then asks you to connect one again.");
    expect(screen.queryByRole("button", { name: "Connect Memberful" })).not.toBeInTheDocument();
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    expect(password).toBeRequired();
    expect(password).toHaveAccessibleDescription("Disconnecting ends your other sessions. Signing in with your password then asks you to connect one again.");
    expect(disconnectButton()).toBeEnabled();
  });

  it("tells someone who needs no membership, and has connected one, that they can sign in with it too", () => {
    showSection({ connected: grace, membershipNeeded: false });
    expect(section()).toHaveTextContent("Connected to Memberful as Grace Hopper (grace@example.com), so you can sign in with it too.");
    expect(section()).toHaveTextContent("Disconnecting ends your other sessions, as a new password does.");
  });

  it("tells a member the same while Memberful isn't members only, since their password signs them in", () => {
    showSection({ connected: grace, membersOnly: false });
    expect(section()).toHaveTextContent("Connected to Memberful as Grace Hopper (grace@example.com), so you can sign in with it too.");
    expect(section()).toHaveTextContent("Disconnecting ends your other sessions, as a new password does.");
  });

  it.each([
    [{ name: "Grace Hopper", emailAddress: null }, "Connected to Memberful as Grace Hopper, so you sign in with it."],
    [{ name: null, emailAddress: "grace@example.com" }, "Connected to Memberful as grace@example.com, so you sign in with it."],
    [{ name: null, emailAddress: null }, "Your Memberful account is connected, so you sign in with it."],
  ])("names the account by what Memberful said of it: %j", (connected, text) => {
    showSection({ connected });
    expect(section()).toHaveTextContent(text);
  });

  it("disconnects it once your password checks out, showing your profile as it answers", async () => {
    const { user, onDisconnected, onFailed } = showSection({ connected: grace });
    const password = screen.getByLabelText("Password");
    await user.type(password, "correct horse");
    await user.click(disconnectButton());
    await waitFor(() => expect(onDisconnected).toHaveBeenCalledWith(DISCONNECTED));
    // Without a push subscription to keep, since this browser has none.
    expect(sent("DELETE")).toEqual([{ currentPassword: "correct horse" }]);
    expect(password).toHaveValue("");
    expect(disconnectButton()).toBeEnabled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(openPage).not.toHaveBeenCalled();
  });

  it("names this browser's push subscription, which disconnecting keeps while it forgets your other browsers'", async () => {
    const registration = { pushManager: { getSubscription: async () => ({ endpoint: ENDPOINT }) } };
    Object.defineProperty(navigator, "serviceWorker", { value: { getRegistration: async () => registration }, configurable: true });
    const { user, onDisconnected } = showSection({ connected: grace });
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(disconnectButton());
    await waitFor(() => expect(onDisconnected).toHaveBeenCalledOnce());
    expect(sent("DELETE")).toEqual([{ currentPassword: "correct horse", pushSubscriptionEndpoint: ENDPOINT }]);
  });

  it("says why it didn't disconnect, emptying your password for another try", async () => {
    serve(() => Response.json({ error: CURRENT_PASSWORD_WRONG }, { status: 422 }));
    const { user, onDisconnected, onFailed } = showSection({ connected: grace });
    const password = screen.getByLabelText("Password");
    await user.type(password, "wrong horse");
    await user.click(disconnectButton());
    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(onFailed.mock.calls[0]![0]).toEqual(new ApiError(422, CURRENT_PASSWORD_WRONG));
    expect(password).toHaveValue("");
    expect(disconnectButton()).toBeEnabled();
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it.each([
    ["while Memberful is members only", {}],
    ["even while it isn't, since nothing else signs them in", { membersOnly: false, membershipNeeded: false }],
  ])("offers someone without a password nothing to disconnect, Memberful being how they sign in, %s", (_, settings) => {
    showSection({ connected: grace, hasPassword: false, ...settings });
    expect(section()).toHaveTextContent("Connected to Memberful as Grace Hopper (grace@example.com), so you sign in with it.");
    // Nothing asks them for a password, which they're given none of, nor offers to disconnect it.
    expect(section()).not.toHaveTextContent(/password|disconnect/i);
    expect(screen.queryByRole("button", { name: "Disconnect Memberful" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("asks someone with a password but no email address to add one first, since signing in with a password takes one", () => {
    showSection({ connected: grace, hasEmailAddress: false, membersOnly: false, membershipNeeded: false });
    expect(section()).toHaveTextContent("Connected to Memberful as Grace Hopper (grace@example.com), so you sign in with it.");
    expect(section()).toHaveTextContent("Add your email address above to disconnect it, so that you can still sign in with your password.");
    expect(screen.queryByRole("button", { name: "Disconnect Memberful" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });
});
