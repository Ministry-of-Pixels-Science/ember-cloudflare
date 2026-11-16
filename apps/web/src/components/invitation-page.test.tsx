import { INVITATION_GONE, PASSWORD_TOO_LONG, type Bootstrap, type Me } from "@ember/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPage } from "@/lib/page";
import { CHROME_MAC } from "@/test-platforms";
import { InvitationPage } from "./invitation-page";

vi.mock("@/lib/page", () => ({ loadPage: vi.fn() }));
vi.mock("@/lib/previews", () => ({ avatarVariantOf: vi.fn(async () => new Blob(["variant"], { type: "image/webp" })) }));

const hal: Me = { id: "u3", name: "Hal", administrator: false };
const workspace: Omit<Bootstrap, "user"> = {
  setup: "complete",
  setupAccess: "link",
  setupPlaceholders: { name: "Kevin Rose", emailAddress: "kevin@kevinrose.com" },
  guestSignIn: false,
  signInWithMemberful: false,
  turnstileSiteKey: "1x00000000000000000000AA",
  passwordResetCodes: false,
  account: { name: "Analytical Engines", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: false, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true },
  version: "0.1",
  vapidPublicKey: null,
  platform: CHROME_MAC,
};
const TOKEN = "Ab-_9z".repeat(7) + "Q";

/** Answers the page's requests with `answers`, one each, in order. */
function serve(...answers: Array<() => Response>) {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const answer of answers) fetch.mockImplementationOnce(async () => answer());
  return fetch;
}

/** Opens the invitation's page at `address`, its link unless given. */
function open(address = `/join/invitation#token=${TOKEN}`, onJoined = vi.fn()) {
  history.replaceState(null, "", address);
  render(<InvitationPage workspace={workspace} onJoined={onJoined} />);
  return onJoined;
}

const forHal = () => Response.json({ kind: "invitation", emailAddress: "hal@example.com" });
const gone = () => Response.json({ error: INVITATION_GONE }, { status: 404 });
const unreachable = () => {
  throw new TypeError("Failed to fetch");
};

const emailField = () => screen.getByRole("textbox", { name: "Email address" });

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:moon");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(loadPage).mockClear();
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});

describe("Join with an invitation", () => {
  it("takes the link's secret out of the address, then shows the join form with the address it's for, which can't be changed", async () => {
    const fetch = serve(forHal);
    open(`/join/invitation?from=email#token=${TOKEN}`);
    expect(`${location.pathname}${location.search}${location.hash}`).toBe("/join/invitation?from=email");
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");

    expect(await screen.findByRole("heading", { level: 1, name: "Join Analytical Engines" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/email_links/lookup", expect.objectContaining({ method: "POST", body: JSON.stringify({ token: TOKEN }) }));
    expect(emailField()).toHaveValue("hal@example.com");
    expect(emailField()).toHaveAttribute("readonly");
    expect(emailField()).toHaveAccessibleDescription("Your invitation is for this address.");
    // No Turnstile check: the link is the gate.
    expect(document.querySelector("script[src*='challenges.cloudflare.com']")).toBeNull();
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
  });

  it("joins with the link's secret, a name and a password, then goes home signed in", async () => {
    const fetch = serve(forHal, () => Response.json({ user: hal }, { status: 201 }));
    const onJoined = open();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Hal");
    await user.type(screen.getByLabelText("Password"), "heuristically{Enter}");
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(hal));
    const [path, init] = fetch.mock.calls[1]!;
    expect(path).toBe("/api/join/invitation");
    expect(JSON.parse(String(init!.body))).toEqual({ token: TOKEN, name: "Hal", password: "heuristically" });
  });

  it("says what the form was refused for, keeping what was typed", async () => {
    serve(forHal, () => Response.json({ error: PASSWORD_TOO_LONG, field: "password" }, { status: 422 }));
    open();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Hal");
    await user.type(screen.getByLabelText("Password"), "heuristically{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(PASSWORD_TOO_LONG);
    expect(screen.getByLabelText("Name")).toHaveValue("Hal");
    expect(emailField()).toHaveValue("hal@example.com");
  });

  it("says so when the link stops working while it's open", async () => {
    serve(forHal, gone);
    open();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Hal");
    await user.type(screen.getByLabelText("Password"), "heuristically{Enter}");
    expect(await screen.findByText(INVITATION_GONE)).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("says a link doesn't work, offering sign-in instead", async () => {
    serve(gone);
    open();
    expect(await screen.findByText(INVITATION_GONE)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Join Analytical Engines" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/session/new");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("says so without asking Ember when the address holds no link", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const address of ["/join/invitation", "/join/invitation#token=", "/join/invitation#m3"]) {
      history.replaceState(null, "", address);
      const { unmount } = render(<InvitationPage workspace={workspace} onJoined={vi.fn()} />);
      expect(screen.getByText(INVITATION_GONE), address).toBeInTheDocument();
      unmount();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("looks up another link opened over the page, which only changes its fragment", async () => {
    const fetch = serve(gone, forHal);
    open("/join/invitation#token=spent");
    expect(await screen.findByText(INVITATION_GONE)).toBeInTheDocument();

    act(() => {
      location.hash = `#token=${TOKEN}`;
    });
    await waitFor(() => expect(emailField()).toHaveValue("hal@example.com"));
    expect(fetch).toHaveBeenLastCalledWith("/api/email_links/lookup", expect.objectContaining({ body: JSON.stringify({ token: TOKEN }) }));
    expect(location.hash).toBe("");
  });

  it("asks again when it can't reach Ember, or Ember fails, waiting longer each time", async () => {
    vi.useFakeTimers();
    const fetch = serve(unreachable, () => Response.json({ error: "Something went wrong" }, { status: 500 }), forHal);
    open();
    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(emailField()).toHaveValue("hal@example.com");
  });
});
