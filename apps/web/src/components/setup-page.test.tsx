import { AVATAR_TOO_LARGE, MAX_AVATAR_SIZE, PASSWORD_TOO_SHORT } from "@ember/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPage } from "@/lib/page";
import avatarPlaceholder from "./avatar-placeholder.svg";
import { SetupPage } from "./setup-page";

vi.mock("@/lib/page", () => ({ loadPage: vi.fn() }));
vi.mock("@/lib/previews", () => ({ avatarVariantOf: vi.fn(async () => new Blob(["variant"], { type: "image/webp" })) }));
// The question about huddles has tests of its own (setup-huddles.test.tsx). Here, what opens Ember from it
// stands in for it, among the pages it loads with. Where those can't load is setup-page-unloaded.test.tsx's.
vi.mock("@/components/workspace/pages", () => ({
  SetupHuddles: ({ onOpen }: { onOpen: () => void }) => (
    <section aria-label="The question about huddles">
      <button type="button" onClick={onOpen}>
        Open Ember
      </button>
    </section>
  ),
}));

const workspace = { user: { id: "u1", name: "Ada Lovelace" }, room: { id: "r1", kind: "open", name: "general", icon: null } };
/** The placeholders the Worker suggests unless the deployment names its own. */
const DEFAULTS = { name: "Kevin Rose", emailAddress: "kevin@kevinrose.com" };

/** The server's answer to the form. */
const answer = (status: number, body: object) => vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status }));

async function fillIn(password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
  await user.type(screen.getByLabelText("Email address"), "ada@example.com");
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:moon");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(loadPage).mockClear();
  history.replaceState(null, "", "/");
});

/** The question about huddles, which the form goes on to once it has made the workspace. */
const huddlesQuestion = () => screen.findByRole("region", { name: "The question about huddles" });
/** Opens Ember from it. */
const openEmber = async () => userEvent.click(within(await huddlesQuestion()).getByRole("button", { name: "Open Ember" }));

const preview = () => screen.getByRole("img", { name: "Avatar preview" });
const photoField = () => screen.getByLabelText("Upload profile image (optional)", { exact: false });
const moon = () => new File(["moon"], "moon.jpg", { type: "image/jpeg" });
/** What the form sent, as a form when it brought a photo. */
const sent = () => vi.mocked(fetch).mock.calls.at(-1)![1]!.body;

describe("Set up the workspace", () => {
  it("asks for the administrator's name, email address and password", () => {
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    expect(document.title).toBe("Set up Ember");
    expect(screen.getByRole("region", { name: "Set up Ember" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Set up Ember" })).toBeInTheDocument();
    expect(screen.getByText("Create the admin account for your workspace.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Ember" })).toHaveAttribute("src", "/ember-icon.png");

    const name = screen.getByLabelText("Name");
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("placeholder", "Kevin Rose");
    expect(name).toHaveAttribute("autocomplete", "name");
    const email = screen.getByLabelText("Email address");
    expect(email).toMatchObject({ type: "email", placeholder: "kevin@kevinrose.com", required: true });
    expect(email).toHaveAttribute("autocomplete", "username");
    const password = screen.getByLabelText("Password");
    expect(password).toMatchObject({ type: "password", placeholder: "••••••••", required: true, minLength: 8, maxLength: 72 });
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(password).toHaveAccessibleDescription("Must be at least 8 characters.");
    expect(password).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("button", { name: "Continue" })).toHaveAttribute("type", "submit");
  });

  it("shows and hides the password", async () => {
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    const password = screen.getByLabelText("Password");
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("aria-controls", password.id);

    await userEvent.click(toggle);
    expect(password).toHaveAttribute("type", "text");
    expect(toggle).toHaveAccessibleName("Hide password");
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(toggle);
    expect(password).toHaveAttribute("type", "password");
    expect(toggle).toHaveAccessibleName("Show password");
  });

  it("sets up the workspace, asks about huddles in the form's place, and opens general in this page's from there", async () => {
    history.replaceState(null, "", "/first_run");
    const length = history.length;
    const fetch = answer(201, workspace);
    const onSetUp = vi.fn();
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={onSetUp} />);
    await fillIn("correct horse");

    // Still setting Ember up, at its address, until the question is answered.
    expect(await huddlesQuestion()).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(onSetUp).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/first_run");
    expect(document.title).toBe("Set up Ember");
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/first_run");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init!.body))).toEqual({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "correct horse" });

    await openEmber();
    expect(onSetUp).toHaveBeenCalledExactlyOnceWith(workspace);
    expect(location.pathname).toBe("/rooms/r1");
    expect(history.length).toBe(length);
  });

  it("goes on asking about huddles when the address's fragment changes, the workspace being made", async () => {
    history.replaceState(null, "", "/first_run");
    answer(201, workspace);
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    await fillIn("correct horse");
    const question = await huddlesQuestion();

    history.replaceState(null, "", "/first_run#token=again");
    act(() => void dispatchEvent(new HashChangeEvent("hashchange")));
    expect(question).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("starts the password over when it's too short, keeping the name and email", async () => {
    answer(422, { error: PASSWORD_TOO_SHORT, field: "password" });
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    await fillIn("🔐🔐🔐🔐");

    const password = await screen.findByLabelText("Password");
    await waitFor(() => expect(password).toHaveFocus());
    expect(password).toHaveValue("");
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(PASSWORD_TOO_SHORT);
    expect(password).toHaveAccessibleDescription(PASSWORD_TOO_SHORT);
    expect(screen.getByLabelText("Name")).toHaveValue("Ada Lovelace");
    expect(screen.getByLabelText("Email address")).toHaveValue("ada@example.com");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("goes home when someone else set Ember up first", async () => {
    answer(409, { error: "Ember is already set up", redirect: "/" });
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    await fillIn("correct horse");
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/"));
  });

  it("says so when Ember can't be reached, and lets you try again", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    const user = await fillIn("correct horse");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach Ember. Check your connection and try again.");

    fetch.mockResolvedValueOnce(Response.json(workspace, { status: 201 }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("offers a photo, optional, which shows as it's chosen", async () => {
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    expect(preview()).toHaveAttribute("src", avatarPlaceholder);
    expect(photoField()).toMatchObject({ type: "file", accept: "image/*" });
    expect(photoField()).toHaveAccessibleDescription("Add a profile photo (optional).");
    expect(photoField().compareDocumentPosition(screen.getByLabelText("Name"))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await userEvent.upload(photoField(), moon());
    expect(preview()).toHaveAttribute("src", "blob:moon");
  });

  it("sends the photo chosen, and its variant, with the rest of the form", async () => {
    answer(201, workspace);
    const onSetUp = vi.fn();
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={onSetUp} />);
    await userEvent.upload(photoField(), moon());
    await fillIn("correct horse");

    await openEmber();
    expect(onSetUp).toHaveBeenCalledWith(workspace);
    const form = sent() as FormData;
    expect(JSON.parse(String(form.get("user")))).toEqual({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "correct horse" });
    expect(form.get("avatar")).toMatchObject({ name: "moon.jpg", type: "image/jpeg" });
    expect(form.get("variant")).toMatchObject({ type: "image/webp" });
  });

  it("keeps the photo when the password is too short", async () => {
    answer(422, { error: PASSWORD_TOO_SHORT, field: "password" });
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    await userEvent.upload(photoField(), moon());
    await fillIn("🔐🔐🔐🔐");

    await waitFor(() => expect(screen.getByLabelText("Password")).toHaveFocus());
    expect(preview()).toHaveAttribute("src", "blob:moon");
    expect(photoField()).toBeEnabled();
  });

  it("keeps the photo it sends until it's answered", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}));
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    await userEvent.upload(photoField(), moon());
    await fillIn("correct horse");

    expect(photoField()).toBeDisabled();
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  });

  it("refuses a photo over 16 MB at once, saying so in place of its description", async () => {
    answer(201, workspace);
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    const huge = moon();
    Object.defineProperty(huge, "size", { value: MAX_AVATAR_SIZE + 1 });
    await userEvent.upload(photoField(), huge);

    expect(screen.getByRole("alert")).toHaveTextContent(AVATAR_TOO_LARGE);
    expect(photoField()).toHaveAccessibleDescription(AVATAR_TOO_LARGE);
    expect(photoField()).toHaveAttribute("aria-invalid", "true");
    expect(preview()).toHaveAttribute("src", avatarPlaceholder);
    await fillIn("correct horse");
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(typeof sent()).toBe("string");
  });

  it("lets go of a photo the Worker refuses, saying why, so the form can be sent without it", async () => {
    const fetch = answer(503, { error: "Ember isn't set up to store files", field: "avatar" });
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    await userEvent.upload(photoField(), moon());
    const user = await fillIn("correct horse");

    expect(await screen.findByRole("alert")).toHaveTextContent("Ember isn't set up to store files");
    expect(preview()).toHaveAttribute("src", avatarPlaceholder);
    expect(photoField()).toHaveValue("");
    fetch.mockResolvedValue(Response.json(workspace, { status: 201 }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(sent()))).toEqual({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "correct horse" });
  });
});

describe("Installer-protected setup link", () => {
  const token = "e2e1".repeat(16);
  const link = `/first_run#token=${token}`;
  /** The link the Worker printed, as the page tells it: this deployment's address with the token's place. */
  const linkShape = () => screen.getByText(`${location.origin}/first_run#token=…`);

  it("sends the setup link's token with the form, having taken it out of the address as it opened", async () => {
    history.replaceState(null, "", link);
    const fetch = answer(201, workspace);
    const onSetUp = vi.fn();
    render(<SetupPage placeholders={DEFAULTS} access="link" onSetUp={onSetUp} />);
    expect(location.hash).toBe("");
    expect(location.pathname).toBe("/first_run");
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await fillIn("correct horse");

    await openEmber();
    expect(onSetUp).toHaveBeenCalledWith(workspace);
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("Authorization")).toBe(`Bearer ${token}`);
  });

  it("sends no token where setup is open, as it is on localhost", async () => {
    const fetch = answer(201, workspace);
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    await fillIn("correct horse");
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).has("Authorization")).toBe(false);
  });

  it("asks for the setup link, saying where it is and what to do without it, in the form's place", () => {
    history.replaceState(null, "", "/first_run");
    render(<SetupPage placeholders={DEFAULTS} access="link" onSetUp={() => {}} />);
    expect(document.title).toBe("Set up Ember");
    expect(screen.getByRole("heading", { level: 1, name: "Set up Ember" })).toBeInTheDocument();
    expect(screen.getByText("Ember is waiting for its administrator.")).toBeInTheDocument();
    expect(linkShape()).toBeInTheDocument();
    expect(screen.getByText("pnpm run deploy")).toBeInTheDocument();
    // Without the link, a setup password set in the dashboard opens setup instead.
    expect(screen.getByText("EMBER_SETUP_PASSWORD")).toBeInTheDocument();
    expect(screen.getByText(/If it's lost, give the Worker a setup password instead: set/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to main content" })).toBeInTheDocument();
  });

  it("opens the setup link pasted over this page's address", async () => {
    history.replaceState(null, "", "/first_run");
    render(<SetupPage placeholders={DEFAULTS} access="link" onSetUp={() => {}} />);
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();

    history.replaceState(null, "", link);
    dispatchEvent(new HashChangeEvent("hashchange"));
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
    expect(location.hash).toBe("");
  });

  it("says nobody can set Ember up while the deployment has neither a setup password nor a token, and how to give it a password", () => {
    render(<SetupPage placeholders={DEFAULTS} access="closed" onSetUp={() => {}} />);
    expect(screen.getByText("Nobody can set it up yet.")).toBeInTheDocument();
    expect(screen.getByText("This deployment has no setup password, so nobody can set it up.")).toBeInTheDocument();
    expect(screen.getByText("EMBER_SETUP_PASSWORD")).toBeInTheDocument();
    expect(screen.getByText(/in the Cloudflare dashboard, in this Worker's Settings under Variables and Secrets, then reload this page/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });

  it("shows the form even without a token where setup is open, whatever the address says", () => {
    history.replaceState(null, "", "/first_run");
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  it("says so when the link's token isn't this deployment's, keeping what was typed", async () => {
    history.replaceState(null, "", link);
    answer(403, { error: "This setup link isn't this deployment's. Open the one its latest deploy printed" });
    render(<SetupPage placeholders={DEFAULTS} access="link" onSetUp={() => {}} />);
    await fillIn("correct horse");
    expect(await screen.findByRole("alert")).toHaveTextContent("This setup link isn't this deployment's. Open the one its latest deploy printed");
    expect(screen.getByLabelText("Name")).toHaveValue("Ada Lovelace");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});

describe("Setup password", () => {
  const password = "correct horse battery staple";
  const setupPasswordField = () => screen.getByLabelText("Setup password");
  /** The Worker's answers to the page's posts, in turn. */
  const answers = (...responses: Array<[number, object | null]>) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const [status, body] of responses) fetch.mockResolvedValueOnce(body === null ? new Response(null, { status }) : Response.json(body, { status }));
    return fetch;
  };
  const authorizationOf = (call: Parameters<typeof fetch>) => new Headers(call[1]!.headers).get("Authorization");

  async function typeSetupPassword(typed: string) {
    const user = userEvent.setup();
    await user.type(setupPasswordField(), typed);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    return user;
  }

  it("asks for the setup password first, in the form's place, saying what to do if it's forgotten", () => {
    history.replaceState(null, "", "/first_run");
    render(<SetupPage placeholders={DEFAULTS} access="password" onSetUp={() => {}} />);
    expect(document.title).toBe("Set up Ember");
    expect(screen.getByRole("heading", { level: 1, name: "Set up Ember" })).toBeInTheDocument();
    expect(screen.getByText("Ember is waiting for its administrator.")).toBeInTheDocument();
    const field = setupPasswordField();
    expect(field).toHaveFocus();
    expect(field).toMatchObject({ type: "password", required: true });
    // Nothing for a password manager to fill in or keep.
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(field).toHaveAccessibleDescription("The one you gave Ember when you deployed it.");
    expect(screen.getByText("EMBER_SETUP_PASSWORD")).toBeInTheDocument();
    expect(screen.getByText(/a new value in the Cloudflare dashboard, in this Worker's Settings under Variables and Secrets, then type that one/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to main content" })).toBeInTheDocument();
  });

  it("shows and hides the setup password", async () => {
    render(<SetupPage placeholders={DEFAULTS} access="password" onSetUp={() => {}} />);
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle).toHaveAttribute("aria-controls", setupPasswordField().id);
    await userEvent.click(toggle);
    expect(setupPasswordField()).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("has the Worker check the setup password, then opens the form, which sends it too, encoded as a header needs", async () => {
    const typed = `Pässwört "${password}"`;
    const fetch = answers([204, null], [201, workspace]);
    const onSetUp = vi.fn();
    render(<SetupPage placeholders={DEFAULTS} access="password" onSetUp={onSetUp} />);
    await typeSetupPassword(typed);

    expect(await screen.findByLabelText("Name")).toHaveFocus();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe("/api/first_run/check");
    expect(fetch.mock.calls[0]![1]!.method).toBe("POST");
    expect(authorizationOf(fetch.mock.calls[0]!)).toBe(`Bearer ${encodeURIComponent(typed)}`);
    expect(screen.getByText("Create the admin account for your workspace.")).toBeInTheDocument();

    await fillIn("correct horse");
    await openEmber();
    expect(onSetUp).toHaveBeenCalledWith(workspace);
    expect(fetch.mock.calls[1]![0]).toBe("/api/first_run");
    expect(authorizationOf(fetch.mock.calls[1]!)).toBe(`Bearer ${encodeURIComponent(typed)}`);
    expect(JSON.parse(String(sent()))).toEqual({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "correct horse" });
  });

  it("says why the Worker refused a setup password, beneath its field, and lets it be typed again", async () => {
    const fetch = answers([403, { error: "That isn't this Ember's setup password" }], [204, null]);
    render(<SetupPage placeholders={DEFAULTS} access="password" onSetUp={() => {}} />);
    const user = await typeSetupPassword("not the password");

    expect(await screen.findByRole("alert")).toHaveTextContent("That isn't this Ember's setup password");
    const field = setupPasswordField();
    expect(field).toHaveAccessibleDescription("That isn't this Ember's setup password");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveValue("");
    expect(field).toHaveFocus();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();

    await user.type(field, password);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
    expect(authorizationOf(fetch.mock.calls[1]!)).toBe(`Bearer ${encodeURIComponent(password)}`);
  });

  it("says so above the card past the limit of tries, keeping what was typed", async () => {
    answers([429, { error: "Too many tries at the setup password. Please wait a few minutes and try again." }]);
    render(<SetupPage placeholders={DEFAULTS} access="password" onSetUp={() => {}} />);
    await typeSetupPassword(password);
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many tries at the setup password. Please wait a few minutes and try again.");
    expect(setupPasswordField()).toHaveValue(password);
    expect(setupPasswordField()).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("says so when Ember can't be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    render(<SetupPage placeholders={DEFAULTS} access="password" onSetUp={() => {}} />);
    await typeSetupPassword(password);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach Ember. Check your connection and try again.");
    expect(setupPasswordField()).toHaveValue(password);
  });

  it("goes home where someone else set Ember up first", async () => {
    answers([409, { error: "Ember is already set up", redirect: "/" }]);
    render(<SetupPage placeholders={DEFAULTS} access="password" onSetUp={() => {}} />);
    await typeSetupPassword(password);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/"));
  });

  it("opens the form without asking where the setup link brings a token the Worker takes, as a deploy may have printed one too", async () => {
    const token = "e2e1".repeat(16);
    history.replaceState(null, "", `/first_run#token=${token}`);
    const fetch = answers([204, null], [201, workspace]);
    render(<SetupPage placeholders={DEFAULTS} access="password" onSetUp={() => {}} />);
    expect(await screen.findByLabelText("Name")).toHaveFocus();
    expect(screen.queryByLabelText("Setup password")).not.toBeInTheDocument();
    await fillIn("correct horse");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/first_run/check", "/api/first_run"]);
    for (const call of fetch.mock.calls) expect(authorizationOf(call)).toBe(`Bearer ${token}`);
  });

  it("opens the form with the setup link where Ember couldn't be reached to check it, as the form has it checked again", async () => {
    const token = "e2e1".repeat(16);
    history.replaceState(null, "", `/first_run#token=${token}`);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(Response.json(workspace, { status: 201 }));
    const onSetUp = vi.fn();
    render(<SetupPage placeholders={DEFAULTS} access="password" onSetUp={onSetUp} />);
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
    await fillIn("correct horse");
    await openEmber();
    expect(onSetUp).toHaveBeenCalledWith(workspace);
    expect(authorizationOf(fetch.mock.calls[1]!)).toBe(`Bearer ${token}`);
  });

  it("asks for the setup password where the setup link it opens with is out of date", async () => {
    history.replaceState(null, "", `/first_run#token=${"0".repeat(64)}`);
    const fetch = answers([403, { error: "That isn't this Ember's setup password" }], [204, null]);
    render(<SetupPage placeholders={DEFAULTS} access="password" onSetUp={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("That setup link is out of date. Type this Ember's setup password instead.");
    expect(setupPasswordField()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();

    await typeSetupPassword(password);
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
    expect(authorizationOf(fetch.mock.calls[1]!)).toBe(`Bearer ${encodeURIComponent(password)}`);
  });
});

describe("Landmarks and names", () => {
  it("starts with Skip to main content, which focuses the main content", async () => {
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(document.body.querySelector("a[href], button, input")).toBe(skip);
    await userEvent.click(skip);
    expect(screen.getByRole("main")).toHaveFocus();
  });
});

describe("Custom CSS", () => {
  it("keeps the password typed out of its field's value attribute, shown or hidden, where custom CSS could read it", async () => {
    render(<SetupPage placeholders={DEFAULTS} access="open" onSetUp={() => {}} />);
    const password = screen.getByLabelText("Password");
    await userEvent.type(password, "correct horse");
    expect(password).not.toHaveAttribute("value");
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveValue("correct horse");
    expect(password).not.toHaveAttribute("value");
  });
});
