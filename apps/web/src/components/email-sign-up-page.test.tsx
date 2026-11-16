import {
  CANT_EMAIL_LINKS,
  EMAIL_LINK_GONE,
  EMAIL_LINK_UNSENT,
  EMAIL_LINKS_LIMITED,
  JOINING_PROBLEMS,
  onlyAddressesAt,
  PASSWORD_TOO_LONG,
  signInSaying,
  TURNSTILE_FAILED,
  type Bootstrap,
  type Me,
} from "@ember/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPage } from "@/lib/page";
import { CHROME_MAC } from "@/test-platforms";
import { fakeTurnstile } from "@/test-turnstile";
import { EmailSignUpPage } from "./email-sign-up-page";

vi.mock("@/lib/page", () => ({ loadPage: vi.fn() }));
vi.mock("@/lib/previews", () => ({ avatarVariantOf: vi.fn(async () => new Blob(["variant"], { type: "image/webp" })) }));

const hal: Me = { id: "u3", name: "Hal", administrator: false };
const DOMAINS = ["example.org", "example.com"];
const workspace: Omit<Bootstrap, "user"> = {
  setup: "complete",
  setupAccess: "link",
  setupPlaceholders: { name: "Kevin Rose", emailAddress: "kevin@kevinrose.com" },
  guestSignIn: false,
  signInWithMemberful: false,
  turnstileSiteKey: null,
  passwordResetCodes: false,
  account: {
    name: "Analytical Engines",
    tagline: "",
    hideTranslationButtons: true,
    customStyles: "",
    restrictRoomCreation: false,
    logo: null,
    customDomain: null,
    joinLink: false,
    openSignUp: false,
    memberfulJoin: false,
    memberfulSignIn: false,
    emailDomainSignUp: true,
    emailDomains: DOMAINS,
    navigationIcons: {},
    huddles: false,
    huddleCameras: true,
    huddleScreens: true,
  },
  version: "0.1",
  vapidPublicKey: null,
  platform: CHROME_MAC,
};
const SITE_KEY = "1x00000000000000000000AA";
const checked = { ...workspace, turnstileSiteKey: SITE_KEY };
/** Email domain turned off, when the workspace says no domains. */
const off = { ...workspace, account: { ...workspace.account, emailDomainSignUp: false, emailDomains: [] } };
/** Memberful's Members only, which lets in nobody else. */
const membersOnly = { ...workspace, account: { ...workspace.account, memberfulJoin: true, memberfulSignIn: true } };
const TOKEN = "Ab-_9z".repeat(7) + "Q";

/** Answers the page's requests with `answers`, one each, in order. */
function serve(...answers: Array<() => Response>) {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const answer of answers) fetch.mockImplementationOnce(async () => answer());
  return fetch;
}

/** Opens the page at `address` as `shown` has the workspace: where someone asks for a link, unless given. */
function open(address = "/join/email", shown = workspace, onJoined = vi.fn()) {
  history.replaceState(null, "", address);
  render(<EmailSignUpPage workspace={shown} onJoined={onJoined} />);
  return onJoined;
}

const emailed = () => Response.json({}, { status: 202 });
const forHal = () => Response.json({ kind: "email_domain", emailAddress: "hal@example.org" });
const gone = () => Response.json({ error: EMAIL_LINK_GONE }, { status: 404 });
const unreachable = () => {
  throw new TypeError("Failed to fetch");
};

const emailField = () => screen.getByRole("textbox", { name: "Email address" });
const emailMe = () => screen.getByRole("button", { name: "Email me a link" });

/** Asks for a link for `emailAddress`. */
async function ask(emailAddress = "hal@example.org") {
  const user = userEvent.setup();
  await user.type(emailField(), emailAddress);
  await user.click(emailMe());
}

/** Joins as Hal with the link's form. */
async function join() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Name"), "Hal");
  await user.type(screen.getByLabelText("Password"), "heuristically{Enter}");
}

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

describe("Join with an email domain", () => {
  it("asks for an address at the workspace's email domains, then says to look for the link in that inbox", async () => {
    const fetch = serve(emailed);
    open();
    expect(document.title).toBe("Sign up");
    expect(screen.getByRole("heading", { level: 1, name: "Join Analytical Engines" })).toBeInTheDocument();
    expect(screen.getByText("Enter your email address, and Ember will email you a link to join with it.")).toBeInTheDocument();
    expect(emailField()).toHaveAccessibleDescription("Addresses at example.org or example.com can join.");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/session/new");

    await ask();
    expect(await screen.findByRole("heading", { level: 1, name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByText(/^Ember emailed hal@example\.org\. Open the link in that email to go on\./)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/email_links", expect.objectContaining({ method: "POST", body: JSON.stringify({ emailAddress: "hal@example.org" }) }));

    await userEvent.click(screen.getByRole("button", { name: "Ask again" }));
    expect(emailField()).toHaveValue("hal@example.org");
  });

  it("waits for Turnstile's check while Ember has a widget's keys, sending its token, and draws it afresh to ask again", async () => {
    const fetch = serve(emailed);
    const { turnstile, pass } = fakeTurnstile();
    open("/join/email", checked);
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledOnce());
    expect(turnstile.render.mock.calls[0]![1]).toMatchObject({ sitekey: SITE_KEY, "response-field": false });
    await userEvent.type(emailField(), "hal@example.org");
    expect(emailMe()).toBeDisabled();

    pass("passed-token");
    await userEvent.click(emailMe());
    expect(await screen.findByRole("heading", { level: 1, name: "Check your email" })).toBeInTheDocument();
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ emailAddress: "hal@example.org", turnstileToken: "passed-token" });
    expect(turnstile.remove).toHaveBeenCalledWith("w1");

    await userEvent.click(screen.getByRole("button", { name: "Ask again" }));
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(2));
    expect(emailMe()).toBeDisabled();
  });

  it("draws the check afresh after an ask that fails, as a token is good once, and says why", async () => {
    serve(() => Response.json({ error: TURNSTILE_FAILED, field: "turnstile" }, { status: 422 }));
    const { turnstile, pass } = fakeTurnstile();
    open("/join/email", checked);
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledOnce());
    pass("spent-token");
    await ask();

    expect(await screen.findByRole("alert")).toHaveTextContent(TURNSTILE_FAILED);
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(2));
    expect(turnstile.remove).toHaveBeenCalledWith("w1");
    expect(emailMe()).toBeDisabled();
    expect(emailField()).toHaveValue("hal@example.org");
  });

  it.each([
    { status: 422, error: onlyAddressesAt(DOMAINS), field: "emailAddress" },
    { status: 429, error: EMAIL_LINKS_LIMITED },
    { status: 503, error: CANT_EMAIL_LINKS },
    { status: 502, error: EMAIL_LINK_UNSENT },
  ])("says why Ember emailed no link, keeping the address typed: $error", async ({ status, ...body }) => {
    serve(() => Response.json(body, { status }));
    open();
    await ask("hal@example.net");
    expect(await screen.findByRole("alert")).toHaveTextContent(body.error);
    expect(emailField()).toHaveValue("hal@example.net");
    expect(screen.queryByRole("heading", { name: "Check your email" })).not.toBeInTheDocument();
  });

  it("says so when it can't reach Ember", async () => {
    serve(unreachable);
    open();
    await ask();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach Ember. Check your connection and try again.");
    expect(emailMe()).toBeEnabled();
  });

  it("goes to sign in, which says why, once Email domain is turned off", async () => {
    serve(() => Response.json({ error: JOINING_PROBLEMS.email_off, redirect: signInSaying("email_off") }, { status: 403 }));
    open();
    await ask();
    await waitFor(() => expect(loadPage).toHaveBeenCalledExactlyOnceWith("/session/new?joining=email_off"));
  });

  it.each([
    ["it's off", off],
    ["Memberful is members only", membersOnly],
  ])("sends the browser to sign in, which says why, while %s", (_, shown) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    open("/join/email", shown);
    expect(loadPage).toHaveBeenCalledExactlyOnceWith("/session/new?joining=email_off");
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("takes a link's secret out of the address, then shows the join form with the address it's for, which can't be changed", async () => {
    const fetch = serve(forHal);
    open(`/join/email?from=email#token=${TOKEN}`, checked);
    expect(`${location.pathname}${location.search}${location.hash}`).toBe("/join/email?from=email");
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");

    expect(await screen.findByRole("heading", { level: 1, name: "Join Analytical Engines" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/email_links/lookup", expect.objectContaining({ method: "POST", body: JSON.stringify({ token: TOKEN }) }));
    expect(emailField()).toHaveValue("hal@example.org");
    expect(emailField()).toHaveAttribute("readonly");
    expect(emailField()).toHaveAccessibleDescription("Your link is for this address.");
    // No Turnstile check: the link is the gate.
    expect(document.querySelector("script[src*='challenges.cloudflare.com']")).toBeNull();
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
  });

  it("joins with the link's secret, a name and a password, then goes home signed in", async () => {
    const fetch = serve(forHal, () => Response.json({ user: hal }, { status: 201 }));
    const onJoined = open(`/join/email#token=${TOKEN}`);
    await join();
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(hal));
    const [path, init] = fetch.mock.calls[1]!;
    expect(path).toBe("/api/join/email");
    expect(JSON.parse(String(init!.body))).toEqual({ token: TOKEN, name: "Hal", password: "heuristically" });
  });

  it("says what the form was refused for, keeping what was typed", async () => {
    serve(forHal, () => Response.json({ error: PASSWORD_TOO_LONG, field: "password" }, { status: 422 }));
    open(`/join/email#token=${TOKEN}`);
    await join();
    expect(await screen.findByRole("alert")).toHaveTextContent(PASSWORD_TOO_LONG);
    expect(screen.getByLabelText("Name")).toHaveValue("Hal");
  });

  it("says a link doesn't work, asking for a new one", async () => {
    serve(gone);
    open(`/join/email#token=${TOKEN}`);
    expect(await screen.findByText(EMAIL_LINK_GONE)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Join Analytical Engines" })).toBeInTheDocument();
    expect(emailField()).toHaveValue("");
    expect(emailMe()).toBeEnabled();
  });

  it("says a link doesn't work while Email domain is off, offering only sign-in", async () => {
    serve(gone);
    open(`/join/email#token=${TOKEN}`, off);
    expect(await screen.findByText(EMAIL_LINK_GONE)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/session/new");
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("doesn't join with an invitation's link, which has a page of its own", async () => {
    serve(() => Response.json({ kind: "invitation", emailAddress: "hal@example.org" }));
    open(`/join/email#token=${TOKEN}`);
    expect(await screen.findByText(EMAIL_LINK_GONE)).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("says so when the link stops working while it's open, asking for a new one", async () => {
    serve(forHal, gone);
    open(`/join/email#token=${TOKEN}`);
    await join();
    expect(await screen.findByText(EMAIL_LINK_GONE)).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(emailField()).toHaveValue("");
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("looks up a link opened over the page, which only changes its fragment", async () => {
    const fetch = serve(forHal);
    open();
    act(() => {
      location.hash = `#token=${TOKEN}`;
    });
    await waitFor(() => expect(emailField()).toHaveValue("hal@example.org"));
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/email_links/lookup", expect.objectContaining({ body: JSON.stringify({ token: TOKEN }) }));
    expect(location.hash).toBe("");
  });

  it("asks again when it can't reach Ember to look a link up, waiting longer each time", async () => {
    vi.useFakeTimers();
    const fetch = serve(unreachable, () => Response.json({ error: "Something went wrong" }, { status: 500 }), forHal);
    open(`/join/email#token=${TOKEN}`);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(emailField()).toHaveValue("hal@example.org");
  });
});
