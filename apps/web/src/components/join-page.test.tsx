import {
  AVATAR_TOO_LARGE,
  JOINING_PROBLEMS,
  MAX_AVATAR_SIZE,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_TOO_LONG,
  SIGN_UP_FULL,
  SIGN_UP_LIMITED,
  TURNSTILE_FAILED,
  signInSaying,
  type Bootstrap,
} from "@ember/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountContext } from "@/hooks/use-account";
import { loadPage } from "@/lib/page";
import { CHROME_MAC } from "@/test-platforms";
import { fakeTurnstile } from "@/test-turnstile";
import avatarPlaceholder from "./avatar-placeholder.svg";
import { JoinPage, TURNSTILE_UNAVAILABLE } from "./join-page";

vi.mock("@/lib/page", () => ({ loadPage: vi.fn() }));
vi.mock("@/lib/previews", () => ({ avatarVariantOf: vi.fn(async () => new Blob(["variant"], { type: "image/webp" })) }));

const grace = { id: "u2", name: "Grace Hopper" };
const workspace: Omit<Bootstrap, "user"> = {
  setup: "complete",
  setupAccess: "link",
  setupPlaceholders: { name: "Kevin Rose", emailAddress: "kevin@kevinrose.com" },
  guestSignIn: false,
  signInWithMemberful: false,
  signInWithSso: null,
  turnstileSiteKey: null,
  passwordResetCodes: false,
  account: { name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true },
  version: "0.1",
  vapidPublicKey: null,
  platform: CHROME_MAC,
};
const JOIN_CODE = "aB3d-Ef5h-iJ7k";

const respond = (status: number, body: unknown) => vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status }));

/** Fills in the form as Grace, with `emailAddress` if given, and sends it. */
async function join(emailAddress = "grace@example.com") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Name"), "Grace Hopper");
  await user.type(screen.getByLabelText("Email address"), emailAddress);
  await user.type(screen.getByLabelText("Password"), "compiler{Enter}");
}

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:moon");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(loadPage).mockClear();
  history.replaceState(null, "", "/");
  for (const script of document.head.querySelectorAll("script")) script.remove();
  document.documentElement.classList.remove("dark");
});

const photo = () => screen.getByRole("img", { name: "Your profile photo" });
const photoField = () => screen.getByLabelText("Upload photo");
const moon = () => new File(["moon"], "moon.jpg", { type: "image/jpeg" });

describe("Sign up with the join link", () => {
  it("asks for a name, email address and password", () => {
    render(<JoinPage workspace={workspace} joinCode={JOIN_CODE} onJoined={vi.fn()} />);
    expect(document.title).toBe("Sign up");
    expect(screen.getByRole("img", { name: "Ember" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Join Ember" })).toBeInTheDocument();
    expect(screen.getByText("Create your account and join the conversation.")).toBeInTheDocument();

    const name = screen.getByLabelText("Name");
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("autocomplete", "name");
    expect(name).toHaveAttribute("placeholder", "Name");
    expect(name).toBeRequired();
    const emailAddress = screen.getByLabelText("Email address");
    expect(emailAddress).toHaveAttribute("type", "email");
    expect(emailAddress).toHaveAttribute("autocomplete", "username");
    expect(emailAddress).toHaveAttribute("placeholder", "Email address");
    expect(emailAddress).toBeRequired();
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(password).toHaveAttribute("placeholder", "Password");
    // At least as long as first run's.
    expect(password).toHaveAttribute("minlength", String(MIN_PASSWORD_LENGTH));
    expect(password).toHaveAttribute("maxlength", String(MAX_PASSWORD_LENGTH));
    expect(password).toBeRequired();
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.getByText("Already have an account?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/session/new");
  });

  it("names the workspace", () => {
    render(<JoinPage workspace={{ ...workspace, account: { ...workspace.account, name: "Analytical Engines" } }} joinCode={JOIN_CODE} onJoined={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 1, name: "Join Analytical Engines" })).toBeInTheDocument();
  });

  it("creates the account with the link's code", async () => {
    const fetch = respond(201, { user: grace });
    const onJoined = vi.fn();
    render(<JoinPage workspace={workspace} joinCode={JOIN_CODE} onJoined={onJoined} />);
    await join();
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(grace));
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe(`/api/join/${JOIN_CODE}`);
    expect(JSON.parse(String(init!.body))).toEqual({ name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler" });
  });

  it("sends an email address that has an account to sign in with it filled in", async () => {
    const signIn = "/session/new?email_address=ada%40example.com";
    respond(409, { error: "That email address has an account already", redirect: signIn });
    const onJoined = vi.fn();
    render(<JoinPage workspace={workspace} joinCode={JOIN_CODE} onJoined={onJoined} />);
    await join("ada@example.com");
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith(signIn));
    expect(onJoined).not.toHaveBeenCalled();
  });

  it("loads the link again when its code stops working, so the page says it's gone", async () => {
    history.replaceState(null, "", `/join/${JOIN_CODE}`);
    respond(404, { error: "Not found" });
    render(<JoinPage workspace={workspace} joinCode={JOIN_CODE} onJoined={vi.fn()} />);
    await join();
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith(`/join/${JOIN_CODE}`));
  });

  it("says what the server refused, keeping what was typed", async () => {
    respond(422, { error: PASSWORD_TOO_LONG, field: "password" });
    render(<JoinPage workspace={workspace} joinCode={JOIN_CODE} onJoined={vi.fn()} />);
    await join();
    expect(await screen.findByRole("alert")).toHaveTextContent(PASSWORD_TOO_LONG);
    expect(screen.getByLabelText("Name")).toHaveValue("Grace Hopper");
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
  });

  it("says when Ember can't be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    render(<JoinPage workspace={workspace} joinCode={JOIN_CODE} onJoined={vi.fn()} />);
    await join();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach Ember. Check your connection and try again.");
    expect(screen.getByLabelText("Email address")).toHaveValue("grace@example.com");
  });

  it("offers a photo, optional, with Upload photo, which shows as it's chosen", async () => {
    render(<JoinPage workspace={workspace} joinCode={JOIN_CODE} onJoined={vi.fn()} />);
    expect(photo()).toHaveAttribute("src", avatarPlaceholder);
    expect(photoField()).toMatchObject({ type: "file", accept: "image/*" });
    expect(screen.getByText("Optional")).toBeInTheDocument();
    expect(photoField().compareDocumentPosition(screen.getByLabelText("Name"))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await userEvent.upload(photoField(), moon());
    expect(photo()).toHaveAttribute("src", "blob:moon");
  });

  it("sends the photo chosen, and its variant, with the rest of the form", async () => {
    const fetch = respond(201, { user: grace });
    const onJoined = vi.fn();
    render(<JoinPage workspace={workspace} joinCode={JOIN_CODE} onJoined={onJoined} />);
    await userEvent.upload(photoField(), moon());
    await join();

    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(grace));
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(JSON.parse(String(form.get("user")))).toEqual({ name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler" });
    expect(form.get("avatar")).toMatchObject({ name: "moon.jpg", type: "image/jpeg" });
    expect(form.get("variant")).toMatchObject({ type: "image/webp" });
  });

  it("refuses a photo over 16 MB at once, saying so in place of Optional", async () => {
    render(<JoinPage workspace={workspace} joinCode={JOIN_CODE} onJoined={vi.fn()} />);
    const huge = moon();
    Object.defineProperty(huge, "size", { value: MAX_AVATAR_SIZE + 1 });
    await userEvent.upload(photoField(), huge);

    expect(screen.getByRole("alert")).toHaveTextContent(AVATAR_TOO_LARGE);
    expect(screen.queryByText("Optional")).toBeNull();
    expect(photo()).toHaveAttribute("src", avatarPlaceholder);
  });

  it("lets go of a photo the Worker refuses, saying why, so the form can be sent without it", async () => {
    const fetch = respond(413, { error: AVATAR_TOO_LARGE, field: "avatar" });
    render(<JoinPage workspace={workspace} joinCode={JOIN_CODE} onJoined={vi.fn()} />);
    await userEvent.upload(photoField(), moon());
    await join();

    expect(await screen.findByRole("alert")).toHaveTextContent(AVATAR_TOO_LARGE);
    expect(photo()).toHaveAttribute("src", avatarPlaceholder);
    expect(photoField()).toBeEnabled();
    fetch.mockResolvedValue(Response.json({ user: grace }, { status: 201 }));
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(typeof fetch.mock.calls[1]![1]!.body).toBe("string");
  });

  it("sends the form once while it's on its way, and keeps the photo it sends", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}));
    render(<JoinPage workspace={workspace} joinCode={JOIN_CODE} onJoined={vi.fn()} />);
    await userEvent.upload(photoField(), moon());
    await join();
    expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled();
    expect(photoField()).toBeDisabled();
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  });
});

describe("Sign up without a link", () => {
  const open = { ...workspace, account: { ...workspace.account, openSignUp: true } };
  const SITE_KEY = "1x00000000000000000000AA";
  const checked = { ...open, turnstileSiteKey: SITE_KEY };
  const createAccount = () => screen.getByRole("button", { name: "Create account" });

  it("signs up without a link, posting to sign-up's own address", async () => {
    const fetch = respond(201, { user: grace });
    const onJoined = vi.fn();
    render(<JoinPage workspace={open} joinCode={null} onJoined={onJoined} />);
    expect(screen.getByRole("heading", { level: 1, name: "Join Ember" })).toBeInTheDocument();
    await join();
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(grace));
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/join");
    expect(JSON.parse(String(init!.body))).toEqual({ name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler" });
  });

  it("waits for Turnstile's check, drawn in the page's appearance and as wide as the form, then sends its token", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(352);
    document.documentElement.classList.add("dark");
    const fetch = respond(201, { user: grace });
    const { turnstile, pass } = fakeTurnstile();
    const onJoined = vi.fn();
    render(<JoinPage workspace={checked} joinCode={null} onJoined={onJoined} />);
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledOnce());
    const [container, options] = turnstile.render.mock.calls[0]!;
    expect(container.compareDocumentPosition(createAccount())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(options).toMatchObject({ sitekey: SITE_KEY, theme: "dark", size: "flexible", "response-field": false });
    expect(createAccount()).toBeDisabled();

    pass("passed-token");
    expect(createAccount()).toBeEnabled();
    await join();
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(grace));
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler", turnstileToken: "passed-token" });
  });

  it("draws the check compact where the form is narrower than its flexible size, in light", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(280);
    const { turnstile } = fakeTurnstile();
    render(<JoinPage workspace={checked} joinCode={null} onJoined={vi.fn()} />);
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledOnce());
    expect(turnstile.render.mock.calls[0]![1]).toMatchObject({ theme: "light", size: "compact" });
  });

  it("waits again once the check's token expires", async () => {
    const { turnstile, pass, expire } = fakeTurnstile();
    render(<JoinPage workspace={checked} joinCode={null} onJoined={vi.fn()} />);
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledOnce());
    pass("passed-token");
    expire();
    expect(createAccount()).toBeDisabled();
  });

  it("draws the check afresh after a try that fails, as a token is good once, and says why", async () => {
    const fetch = respond(422, { error: TURNSTILE_FAILED, field: "turnstile" });
    const { turnstile, pass } = fakeTurnstile();
    render(<JoinPage workspace={checked} joinCode={null} onJoined={vi.fn()} />);
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledOnce());
    pass("spent-token");
    await join();

    expect(await screen.findByRole("alert")).toHaveTextContent(TURNSTILE_FAILED);
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(2));
    expect(turnstile.remove).toHaveBeenCalledWith("w1");
    expect(createAccount()).toBeDisabled();
    expect(screen.getByLabelText("Name")).toHaveValue("Grace Hopper");

    fetch.mockResolvedValue(Response.json({ user: grace }, { status: 201 }));
    pass("fresh-token");
    await userEvent.click(createAccount());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toMatchObject({ turnstileToken: "fresh-token" });
  });

  it("loads Turnstile's script from Cloudflare, and says so if it doesn't load", async () => {
    render(<JoinPage workspace={checked} joinCode={null} onJoined={vi.fn()} />);
    const script = document.head.querySelector("script")!;
    expect(script.src).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    act(() => script.dispatchEvent(new Event("error")));
    expect(await screen.findByRole("alert")).toHaveTextContent(TURNSTILE_UNAVAILABLE);
    expect(createAccount()).toBeDisabled();
  });

  it("takes the check away as the page goes", async () => {
    const { turnstile } = fakeTurnstile();
    const { unmount } = render(<JoinPage workspace={checked} joinCode={null} onJoined={vi.fn()} />);
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledOnce());
    unmount();
    expect(turnstile.remove).toHaveBeenCalledWith("w1");
  });

  it("shows no check on a join link's page, which has no limits to keep", async () => {
    const { turnstile } = fakeTurnstile();
    render(<JoinPage workspace={checked} joinCode={JOIN_CODE} onJoined={vi.fn()} />);
    expect(createAccount()).toBeEnabled();
    await Promise.resolve();
    expect(turnstile.render).not.toHaveBeenCalled();
  });

  it.each([SIGN_UP_LIMITED, SIGN_UP_FULL])("says when there have been too many sign-ups: %s", async (error) => {
    respond(429, { error });
    render(<JoinPage workspace={open} joinCode={null} onJoined={vi.fn()} />);
    await join();
    expect(await screen.findByRole("alert")).toHaveTextContent(error);
  });

  it("goes to sign in, which says why, once signing up has closed", async () => {
    respond(403, { error: JOINING_PROBLEMS.closed, redirect: signInSaying("closed") });
    render(<JoinPage workspace={open} joinCode={null} onJoined={vi.fn()} />);
    await join();
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/session/new?joining=closed"));
  });
});

describe("Version", () => {
  it("shows Ember's version under the card, as the sign-in page does, and nobody to email", () => {
    render(<JoinPage workspace={workspace} joinCode={JOIN_CODE} onJoined={vi.fn()} />);
    const card = screen.getByRole("heading", { name: /^Join / }).closest("section")!;
    expect(card.nextElementSibling).toHaveTextContent(/^Ember version 0\.1$/);
    expect(screen.queryByRole("link", { name: /@/ })).not.toBeInTheDocument();
  });
});

describe("Translation buttons", () => {
  it("has a translation button by the name, the email address and the password once an administrator shows them", () => {
    const shown = { ...workspace.account, hideTranslationButtons: false };
    render(
      <AccountContext value={shown}>
        <JoinPage workspace={{ ...workspace, account: shown }} joinCode={JOIN_CODE} onJoined={vi.fn()} />
      </AccountContext>,
    );
    expect(screen.getAllByText("Translate")).toHaveLength(3);
    for (const text of ["Enter your name", "Enter your email address", "Enter your password"]) expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe("Workspace logo", () => {
  it("shows the workspace's logo in place of Ember's flame", () => {
    const logo = "/account/logo?v=20261017120000";
    render(<JoinPage workspace={{ ...workspace, account: { ...workspace.account, logo } }} joinCode={JOIN_CODE} onJoined={vi.fn()} />);
    expect(screen.getByRole("img", { name: "Account logo" })).toHaveAttribute("src", logo);
    expect(screen.queryByRole("img", { name: "Ember" })).toBeNull();
  });
});

describe("Custom CSS", () => {
  it("keeps the password typed out of its field's value attribute, where custom CSS could read it", async () => {
    render(<JoinPage workspace={workspace} joinCode={JOIN_CODE} onJoined={vi.fn()} />);
    const password = screen.getByLabelText("Password");
    await userEvent.type(password, "compiler");
    expect(password).toHaveValue("compiler");
    expect(password).not.toHaveAttribute("value");
  });
});
