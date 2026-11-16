import {
  CANT_EMAIL_CODES,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RESET_CODE_WRONG,
  PASSWORD_RESET_DONE,
  PASSWORD_RESET_LIMITED,
  PASSWORD_RESET_SIGN_IN,
  PASSWORD_RESETS_LIMITED,
  PASSWORD_TOO_SHORT,
  TURNSTILE_FAILED,
  type Bootstrap,
  type Me,
} from "@ember/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPage } from "@/lib/page";
import { CHROME_MAC } from "@/test-platforms";
import { fakeTurnstile } from "@/test-turnstile";
import { PasswordResetPage } from "./password-reset-page";

vi.mock("@/lib/page", () => ({ loadPage: vi.fn() }));

const ada: Me = { id: "u1", name: "Ada", administrator: true };
const workspace: Omit<Bootstrap, "user"> = {
  setup: "complete",
  setupAccess: "link",
  setupPlaceholders: { name: "Kevin Rose", emailAddress: "kevin@kevinrose.com" },
  guestSignIn: false,
  signInWithMemberful: false,
  turnstileSiteKey: null,
  passwordResetCodes: true,
  account: { name: "Analytical Engines", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true },
  version: "0.1",
  vapidPublicKey: null,
  platform: CHROME_MAC,
};
const SITE_KEY = "1x00000000000000000000AA";
const checked = { ...workspace, turnstileSiteKey: SITE_KEY };

/** Answers the page's requests with `answers`, one each, in order. */
function serve(...answers: Array<() => Response>) {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const answer of answers) fetch.mockImplementationOnce(async () => answer());
  return fetch;
}

/** Opens the page at `address` as `shown` has the workspace. */
function open(address = "/passwords/new", shown = workspace) {
  history.replaceState(null, "", address);
  render(<PasswordResetPage workspace={shown} />);
}

const asked = () => Response.json({}, { status: 202 });
const refused = (error: string, field?: string, status = 422) => () => Response.json({ error, field }, { status });
const unreachable = () => {
  throw new TypeError("Failed to fetch");
};

const emailField = () => screen.getByRole("textbox", { name: "Email address" });
const emailMe = () => screen.getByRole("button", { name: "Email me a code" });
const codeField = () => screen.getByRole("textbox", { name: "Code" });
const passwordField = () => screen.getByLabelText("New password");

/** Asks for a code for `emailAddress`, then waits for the form that takes it. */
async function ask(emailAddress = "ada@example.com") {
  const user = userEvent.setup();
  await user.type(emailField(), emailAddress);
  await user.click(emailMe());
  await screen.findByRole("heading", { level: 1, name: "Check your email" });
}

/** Asks for a code for the address the field holds already. */
async function askAgain() {
  await userEvent.click(emailMe());
  await screen.findByRole("heading", { level: 1, name: "Check your email" });
}

/** Gives `code` with `password` in the second form. */
async function reset(code = "12345678", password = "difference engine") {
  const user = userEvent.setup();
  await user.type(codeField(), code);
  await user.type(passwordField(), `${password}{Enter}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(loadPage).mockClear();
  history.replaceState(null, "", "/");
  sessionStorage.clear();
});

describe("Reset a forgotten password with an emailed code", () => {
  it("asks for an email address, then for the code Ember emailed it with a new password", async () => {
    const fetch = serve(asked);
    open();
    expect(document.title).toBe("Reset your password");
    expect(screen.getByRole("heading", { level: 1, name: "Reset your password" })).toBeInTheDocument();
    expect(screen.getByText("Enter your email address, and Ember will email you a code to choose a new password with.")).toBeInTheDocument();
    expect(emailField()).toHaveFocus();
    expect(emailField()).toHaveAttribute("autocomplete", "username");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/session/new");

    await ask();
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/password_resets", expect.objectContaining({ method: "POST", body: JSON.stringify({ emailAddress: "ada@example.com" }) }));
    expect(
      screen.getByText("If ada@example.com has an account here, Ember emailed it a code that works for 15 minutes. If it hasn't arrived soon, look in your spam folder."),
    ).toBeInTheDocument();
    expect(codeField()).toHaveFocus();
    expect(codeField()).toHaveAttribute("inputmode", "numeric");
    expect(codeField()).toHaveAttribute("autocomplete", "one-time-code");
    expect(codeField()).toHaveAttribute("placeholder", "8-digit code");
    expect(passwordField()).toHaveAttribute("type", "password");
    expect(passwordField()).toHaveAttribute("autocomplete", "new-password");
    expect(passwordField()).toHaveAttribute("minlength", String(MIN_PASSWORD_LENGTH));
    expect(passwordField()).toHaveAttribute("maxlength", String(MAX_PASSWORD_LENGTH));
    // So that a password manager saves the new password for the address.
    expect(document.querySelector("input[autocomplete='username']")).toHaveValue("ada@example.com");
    expect(screen.getByRole("button", { name: "Reset password" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Send another code" }));
    expect(emailField()).toHaveValue("ada@example.com");
    expect(emailMe()).toBeEnabled();
  });

  it("asks for the code still when the browser loads the page again, as a phone's may once someone has been to their email, but not on a new visit", async () => {
    serve(asked, asked);
    open("/passwords/new?email_address=ada%40example.com");
    await askAgain();
    cleanup();
    // As the same history entry, loaded again.
    render(<PasswordResetPage workspace={workspace} />);
    expect(screen.getByRole("heading", { level: 1, name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByText(/^If ada@example\.com has an account here/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Send another code" }));
    cleanup();
    render(<PasswordResetPage workspace={workspace} />);
    expect(emailField()).toHaveValue("ada@example.com");

    await askAgain();
    cleanup();
    open("/passwords/new");
    expect(emailField()).toHaveValue("");
  });

  it("asks for the code Ember emailed the address it sent, though the field changes while it's sending", async () => {
    let answer!: (response: Response) => void;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    fetch.mockImplementationOnce(async () => Response.json({ user: ada }, { status: 201 }));
    open();
    const user = userEvent.setup();
    await user.type(emailField(), "ada@example.com");
    await user.click(emailMe());
    await user.type(emailField(), ".uk");
    answer(Response.json({}, { status: 202 }));

    expect(await screen.findByText(/^If ada@example\.com has an account here/)).toBeInTheDocument();
    expect(history.state).toMatchObject({ passwordResetAsked: "ada@example.com" });
    await reset();
    await waitFor(() => expect(loadPage).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toMatchObject({ emailAddress: "ada@example.com" });
  });

  it("fills in the email address its link gives, for the link back to sign in too", () => {
    open("/passwords/new?email_address=ada%40example.com");
    expect(emailField()).toHaveValue("ada@example.com");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/session/new?email_address=ada%40example.com");
  });

  it("waits for Turnstile's check while Ember has a widget's keys, sending its token, and draws it afresh to ask again", async () => {
    const fetch = serve(refused(TURNSTILE_FAILED, "turnstile"), asked);
    const { turnstile, pass } = fakeTurnstile();
    open("/passwords/new", checked);
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledOnce());
    expect(turnstile.render.mock.calls[0]![1]).toMatchObject({ sitekey: SITE_KEY, "response-field": false });
    await userEvent.type(emailField(), "ada@example.com");
    expect(emailMe()).toBeDisabled();

    pass("spent-token");
    await userEvent.click(emailMe());
    expect(await screen.findByRole("alert")).toHaveTextContent(TURNSTILE_FAILED);
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(2));
    expect(turnstile.remove).toHaveBeenCalledWith("w1");
    expect(emailMe()).toBeDisabled();

    pass("passed-token");
    await userEvent.click(emailMe());
    expect(await screen.findByRole("heading", { level: 1, name: "Check your email" })).toBeInTheDocument();
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual({ emailAddress: "ada@example.com", turnstileToken: "passed-token" });
  });

  it.each([
    { status: 429, error: PASSWORD_RESETS_LIMITED },
    { status: 503, error: CANT_EMAIL_CODES },
  ])("says why Ember emailed no code, keeping the address typed: $error", async ({ status, error }) => {
    serve(refused(error, undefined, status));
    open();
    await userEvent.type(emailField(), "ada@example.com");
    await userEvent.click(emailMe());
    expect(await screen.findByRole("alert")).toHaveTextContent(error);
    expect(emailField()).toHaveValue("ada@example.com");
    expect(emailMe()).toBeEnabled();
  });

  it("says so when it can't reach Ember", async () => {
    serve(unreachable);
    open();
    await userEvent.type(emailField(), "ada@example.com");
    await userEvent.click(emailMe());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach Ember. Check your connection and try again.");
  });

  it("says Ember can't email a code while it can't send email, with no form", () => {
    open("/passwords/new?email_address=ada%40example.com", { ...workspace, passwordResetCodes: false });
    expect(screen.getByRole("heading", { level: 1, name: "Reset your password" })).toBeInTheDocument();
    expect(screen.getByText(CANT_EMAIL_CODES)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/session/new?email_address=ada%40example.com");
  });

  it("resets the password with the code, then loads the page this tab was sent to sign in from, signed in, saying so", async () => {
    sessionStorage.setItem("ember:return-to", "/rooms/abc?tab=pins");
    const fetch = serve(asked, () => Response.json({ user: ada }, { status: 201 }));
    open();
    await ask();
    await reset("1234 5678");
    await waitFor(() => expect(loadPage).toHaveBeenCalledExactlyOnceWith("/rooms/abc?tab=pins", { kind: "notice", text: PASSWORD_RESET_DONE }));
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/password_resets",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ emailAddress: "ada@example.com", code: "1234 5678", password: "difference engine" }) }),
    );
    expect(sessionStorage.getItem("ember:return-to")).toBeNull();
    // Until the page loads.
    expect(screen.getByRole("button", { name: "Reset password" })).toBeDisabled();
  });

  it("goes home once signed in when this tab came to reset the password itself", async () => {
    serve(asked, () => Response.json({ user: ada }, { status: 201 }));
    open();
    await ask();
    await reset();
    await waitFor(() => expect(loadPage).toHaveBeenCalledExactlyOnceWith("/", { kind: "notice", text: PASSWORD_RESET_DONE }));
  });

  it("goes to sign in with the address, saying so, when the person signs in themselves", async () => {
    serve(asked, () => Response.json({ user: null }));
    open();
    await ask();
    await reset();
    await waitFor(() => expect(loadPage).toHaveBeenCalledExactlyOnceWith("/session/new?email_address=ada%40example.com", { kind: "notice", text: PASSWORD_RESET_SIGN_IN }));
  });

  it("says at the top of the form why a code or password is refused, keeping what was typed, in the field it's about", async () => {
    serve(asked, refused(PASSWORD_RESET_CODE_WRONG, "code"), refused(PASSWORD_TOO_SHORT, "password"), refused(PASSWORD_RESET_LIMITED, undefined, 429));
    open();
    await ask();
    await reset("12345678", "difference engine");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(PASSWORD_RESET_CODE_WRONG);
    expect(alert.closest("form")!.firstElementChild).toBe(alert);
    expect(codeField()).toHaveFocus();
    expect(codeField()).toHaveValue("12345678");
    expect(passwordField()).toHaveValue("difference engine");
    expect(loadPage).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(PASSWORD_TOO_SHORT));
    expect(passwordField()).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(PASSWORD_RESET_LIMITED));
    expect(screen.getByRole("button", { name: "Reset password" })).toBeEnabled();
  });

  it("says so when it can't reach Ember to reset it, keeping what was typed", async () => {
    serve(asked, unreachable);
    open();
    await ask();
    await reset();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach Ember. Check your connection and try again.");
    expect(codeField()).toHaveValue("12345678");
    expect(screen.getByRole("button", { name: "Reset password" })).toBeEnabled();
  });
});
