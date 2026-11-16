import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HUDDLES_FORBIDDEN, RELAY_API_TOKEN_REFUSED, RELAY_API_TOKEN_UNKNOWN, RELAY_KEY_ID_REFUSED, RELAY_KEY_ID_UNKNOWN, RELAY_UNCHECKED, RELAY_WITHOUT_HUDDLES } from "@ember/protocol/huddles";
import { ApiError } from "@/lib/api";
import { RELAY_ON, RELAY_SETUP_EXPLAINED, RelaySetup } from "./relay-setup";

/** The SFU app huddles run through, by its ID. */
const APP_ID = "2a95132c15732412d22c1476fa83f27a";
/** A TURN key's ID and its API token, as an administrator copies them from Cloudflare's dashboard. */
const KEY = { keyId: "5b1e9a0c7d3f4e2a8b6c1d0e9f7a3b5c", apiToken: "9f3c5a7e1b2d4f6a8c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b9d2f4a" };
/** The Cloudflare account Ember is deployed to. */
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
/** Huddles as they are once their relay goes by the TURN key `keyId`. */
const relayedBy = (keyId = KEY.keyId) => ({ appId: APP_ID, relayKeyId: keyId });

/** Answers giving Ember the TURN key as the server would, or as `saved` says. */
function serve(saved: () => Response | Promise<Response> = () => Response.json({ huddles: relayedBy() })) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (`${init?.method} ${String(input)}` === "PUT /api/account/huddles/relay") return saved();
    throw new Error(`Unexpected request for ${init?.method} ${String(input)}`);
  });
}

/** What the dialog asked of the server, in order, with what it sent. */
const asked = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([input, init]) => [`${init?.method} ${String(input)}`, init?.body === undefined ? undefined : JSON.parse(String(init.body))]);

/** A response the test lets through when it says, with `answer` letting it through. */
function held(response: () => Response) {
  let answer = () => {};
  const answered = new Promise<Response>((resolve) => (answer = () => resolve(response())));
  return { answered: () => answered, answer: () => act(async () => answer()) };
}

/** Set up the relay, open on a workspace whose relay goes by the TURN key `relayKeyId`, if it has one, deployed to `deployedAccountId`, if that's known. */
function showSetup({ relayKeyId = null, deployedAccountId = null }: { relayKeyId?: string | null; deployedAccountId?: string | null } = {}) {
  const callbacks = { onSaved: vi.fn(), onClose: vi.fn(), onFailed: vi.fn() };
  render(<RelaySetup relayKeyId={relayKeyId} deployedAccountId={deployedAccountId} {...callbacks} />);
  return { ...callbacks, user: userEvent.setup() };
}

const dialog = (name: string) => screen.findByRole("dialog", { name });
const button = (name: string) => screen.getByRole("button", { name });
const keyIdField = () => screen.getByRole("textbox", { name: "TURN Token ID" });
const apiTokenField = () => screen.getByRole("textbox", { name: "API Token" });
const dashboardButton = () => screen.getByRole("link", { name: "Open Cloudflare's dashboard" });
/** What the line under the token says of it while there's nothing else to say. */
const TOKEN_KEPT = "Ember keeps it encrypted.";

/** Types the TURN key, as given, and saves it. */
async function giveKey(user: ReturnType<typeof userEvent.setup>, key: { keyId: string; apiToken: string } = KEY) {
  await user.clear(keyIdField());
  await user.type(keyIdField(), key.keyId);
  await user.clear(apiTokenField());
  await user.type(apiTokenField(), key.apiToken);
  await user.click(button("Save"));
}

afterEach(() => vi.restoreAllMocks());

describe("Set up the relay", () => {
  it("starts with its two steps: the TURN key to make, with the button that opens Cloudflare's dashboard, then the key's ID and its token", async () => {
    const fetch = serve();
    const { user, onClose } = showSetup();
    const setup = await dialog("Set up the relay");
    expect(within(setup).getByRole("heading", { name: "Set up the relay" })).toHaveFocus();
    expect(setup).toHaveAccessibleDescription(RELAY_SETUP_EXPLAINED);
    // What it costs is said before anything is asked for.
    expect(RELAY_SETUP_EXPLAINED).toContain("Cloudflare doesn't charge for it when it's used with the Realtime SFU");
    const [key, fields] = within(screen.getByRole("list", { name: "Steps to set up the relay" })).getAllByRole("listitem");
    expect(within(key!).getByRole("heading", { level: 3, name: "Create a TURN key in Cloudflare" })).toBeVisible();
    expect(key).toHaveTextContent("Open Realtime, find TURN, and create a key. Any name will do.");
    // Without the account Ember is deployed to, the dashboard asks which.
    expect(within(key!).getByRole("link")).toBe(dashboardButton());
    expect(dashboardButton()).toHaveAttribute("href", "https://dash.cloudflare.com/?to=/:account/calls");
    expect(dashboardButton()).toHaveAttribute("target", "_blank");
    expect(within(fields!).getByRole("heading", { level: 3, name: "Copy the key's ID and token here" })).toBeVisible();
    expect(within(fields!).getAllByRole("textbox")).toEqual([keyIdField(), apiTokenField()]);
    expect(keyIdField()).toHaveValue("");
    expect(apiTokenField()).toHaveAccessibleDescription(TOKEN_KEPT);
    expect(screen.queryByText(/has a TURN key already/)).not.toBeInTheDocument();
    expect(button("Save")).toBeDisabled();
    await user.type(keyIdField(), KEY.keyId);
    expect(button("Save")).toBeDisabled();
    await user.type(apiTokenField(), KEY.apiToken);
    expect(button("Save")).toBeEnabled();

    await user.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("opens the dashboard at the account Ember is deployed to, once the deploy has given it", async () => {
    serve();
    showSetup({ deployedAccountId: ACCOUNT_ID });
    await dialog("Set up the relay");
    expect(dashboardButton()).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/calls`);
  });

  it("hides the token as it's typed, in a field that's no password's, and keeps it out of the field's value attribute, where custom CSS could read it", async () => {
    serve();
    const { user } = showSetup();
    await dialog("Set up the relay");
    await user.type(apiTokenField(), KEY.apiToken);
    expect(apiTokenField()).toHaveValue(KEY.apiToken);
    expect(apiTokenField()).toHaveClass("[-webkit-text-security:disc]");
    // No password manager offers to keep it, or to fill in a password it kept.
    expect(apiTokenField()).toHaveProperty("type", "text");
    expect(apiTokenField()).toHaveAttribute("autocomplete", "off");
    expect(apiTokenField()).not.toHaveAttribute("value");
    expect(keyIdField()).not.toHaveClass("[-webkit-text-security:disc]");
  });

  it("refuses what can't be a TURN key's on its field, asking the server nothing, until it's typed again", async () => {
    const fetch = serve();
    const { user } = showSetup();
    await giveKey(user, { keyId: "my TURN key", apiToken: KEY.apiToken });
    expect(screen.getByRole("alert")).toHaveTextContent(RELAY_KEY_ID_REFUSED);
    expect(keyIdField()).toHaveAttribute("aria-invalid", "true");
    expect(keyIdField()).toHaveAccessibleDescription(RELAY_KEY_ID_REFUSED);
    // Typing the token leaves what's said of the ID.
    await user.type(apiTokenField(), "{Backspace}");
    expect(screen.getByRole("alert")).toHaveTextContent(RELAY_KEY_ID_REFUSED);
    await user.clear(keyIdField());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // A token is one word, as a request carries it.
    await giveKey(user, { keyId: KEY.keyId, apiToken: "Bearer token" });
    expect(screen.getByRole("alert")).toHaveTextContent(RELAY_API_TOKEN_REFUSED);
    expect(apiTokenField()).toHaveAttribute("aria-invalid", "true");
    expect(keyIdField()).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByRole("dialog", { name: "Set up the relay" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("saves the key, without the spaces around it, once Cloudflare has made the relay's servers with it", async () => {
    const answer = held(() => Response.json({ huddles: relayedBy() }));
    serve(answer.answered);
    const { user, onSaved, onClose } = showSetup();
    await giveKey(user, { keyId: ` ${KEY.keyId} `, apiToken: `${KEY.apiToken} ` });

    // Nothing closes it, or changes the key, while Cloudflare is asked, which the line under the token says.
    expect(screen.getByRole("status")).toHaveTextContent("Asking Cloudflare for the relay's servers with the key…");
    expect(screen.queryByText(TOKEN_KEPT)).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Set up the relay" })).toHaveAttribute("aria-busy", "true");
    expect(button("Checking…")).toBeDisabled();
    expect(button("Cancel")).toBeDisabled();
    expect(button("Close")).toBeDisabled();
    expect(keyIdField()).toBeDisabled();
    expect(apiTokenField()).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    await answer.answer();
    const done = await dialog("The relay is on");
    expect(within(done).getByRole("heading", { name: "The relay is on" })).toHaveFocus();
    expect(done).toHaveAccessibleDescription(RELAY_ON);
    expect(RELAY_ON).toContain("Whoever joins a huddle from now on connects through the relay where their network blocks the way.");
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(relayedBy());
    expect(asked()).toEqual([["PUT /api/account/huddles/relay", KEY]]);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(button("Done"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says on its field why Cloudflare didn't take the key, until it's typed again", async () => {
    const refusals = [
      { error: RELAY_KEY_ID_UNKNOWN, field: "keyId" },
      { error: RELAY_API_TOKEN_UNKNOWN, field: "apiToken" },
    ];
    serve(() => Response.json(refusals.shift(), { status: 422 }));
    const { user, onSaved, onFailed } = showSetup();
    await giveKey(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(RELAY_KEY_ID_UNKNOWN);
    expect(keyIdField()).toHaveAccessibleDescription(RELAY_KEY_ID_UNKNOWN);
    expect(keyIdField()).toBeEnabled();
    // What was typed is still there to correct.
    expect(keyIdField()).toHaveValue(KEY.keyId);
    expect(apiTokenField()).toHaveValue(KEY.apiToken);
    expect(screen.getByRole("status")).toHaveTextContent(TOKEN_KEPT);

    // Why the token wasn't taken is said in that line's place, so the steps stay as tall.
    await user.click(button("Save"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(RELAY_API_TOKEN_UNKNOWN));
    expect(apiTokenField()).toHaveAccessibleDescription(RELAY_API_TOKEN_UNKNOWN);
    expect(apiTokenField()).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(keyIdField()).toHaveAttribute("aria-invalid", "false");
    await user.type(apiTokenField(), "{Backspace}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(apiTokenField()).toHaveAccessibleDescription(TOKEN_KEPT);
    expect(screen.getByRole("dialog", { name: "Set up the relay" })).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says under the token that Cloudflare couldn't be asked, which saving again asks", async () => {
    const answers = [() => Response.json({ error: RELAY_UNCHECKED }, { status: 502 }), () => Response.json({ huddles: relayedBy() })];
    serve(() => answers.shift()!());
    const { user, onSaved, onFailed } = showSetup();
    await giveKey(user);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(RELAY_UNCHECKED));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onFailed).not.toHaveBeenCalled();
    // Typing in either field takes it away.
    await user.type(keyIdField(), "{Backspace}");
    expect(screen.getByRole("status")).toHaveTextContent(TOKEN_KEPT);
    await user.type(keyIdField(), KEY.keyId.at(-1)!);

    await user.click(button("Save"));
    await dialog("The relay is on");
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(relayedBy());
    expect(asked()).toEqual([
      ["PUT /api/account/huddles/relay", KEY],
      ["PUT /api/account/huddles/relay", KEY],
    ]);
  });

  it.each([
    ["anyone but an administrator", 403, HUDDLES_FORBIDDEN],
    ["huddles turned off meanwhile", 409, RELAY_WITHOUT_HUDDLES],
  ])("leaves a failure that's neither the key's nor Cloudflare's to the page's alerts, the key still there: %s", async (_, status, error) => {
    serve(() => Response.json({ error }, { status }));
    const { user, onSaved, onFailed, onClose } = showSetup();
    await giveKey(user);
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(status, error)));
    expect(screen.getByRole("dialog", { name: "Set up the relay" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(TOKEN_KEPT);
    expect(button("Save")).toBeEnabled();
    expect(apiTokenField()).toHaveValue(KEY.apiToken);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("starts from the key's ID when changing keys, and asks for its token again", async () => {
    serve();
    const another = { keyId: "e".repeat(32), apiToken: "0f1e2d3c4b5a6978".repeat(4) };
    const { user, onSaved } = showSetup({ relayKeyId: KEY.keyId });
    await dialog("Set up the relay");
    expect(keyIdField()).toHaveValue(KEY.keyId);
    expect(apiTokenField()).toHaveValue("");
    // Said under the token, in the place of what Ember does with it.
    expect(apiTokenField()).toHaveAccessibleDescription("Ember has a TURN key already. Give another's to relay through it instead.");
    expect(screen.queryByText(TOKEN_KEPT)).not.toBeInTheDocument();
    expect(button("Save")).toBeDisabled();

    vi.mocked(fetch).mockImplementation(async () => Response.json({ huddles: relayedBy(another.keyId) }));
    await giveKey(user, another);
    await dialog("The relay is on");
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(relayedBy(another.keyId));
    expect(asked()).toEqual([["PUT /api/account/huddles/relay", another]]);
  });
});
