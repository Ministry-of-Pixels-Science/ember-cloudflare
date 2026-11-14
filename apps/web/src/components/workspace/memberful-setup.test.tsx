import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEMBERFUL_API_KEY_REFUSED,
  MEMBERFUL_API_KEY_UNKNOWN,
  MEMBERFUL_CLIENT_ID_REFUSED,
  MEMBERFUL_CLIENT_UNKNOWN,
  MEMBERFUL_KEYS_UNCHECKED,
  MEMBERFUL_SITE_REFUSED,
  MEMBERFUL_SITE_UNKNOWN,
  MEMBERFUL_WEBHOOK_SECRET_REFUSED,
  memberfulSiteKept,
  type MemberfulKeysChange,
  type MemberfulSaved,
} from "@ember/protocol/memberful";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { ApiError } from "@/lib/api";
import { MEMBERFUL_SETUP_EXPLAINED, MemberfulSetup } from "./memberful-setup";

/** A Memberful site and its keys, as an administrator copies them from Memberful's dashboard. */
const KEYS: MemberfulKeysChange = {
  site: "https://fernwood.memberful.com",
  clientId: "5vmrRcXKRn7bLuK4uTbGqDV5",
  clientSecret: "Vfa9uQGvqQp4DXsNgcR8Lk2y",
  apiKey: "K3w9mZsQp7vLx2Nc8RfT4yHb",
  webhookSecret: "a91c6e7f0b2d4e58b3f6a1c9d0e7b2f4",
};

/** Memberful before Ember has a site's keys. */
const UNSET: MemberfulSaved = { memberfulSite: null, memberfulWebhooks: false, memberfulKeys: null, memberfulSiteKept: null };
/** And once Memberful has taken `KEYS`. */
const SAVED: MemberfulSaved = { memberfulSite: KEYS.site, memberfulWebhooks: true, memberfulKeys: "saved", memberfulSiteKept: null };

/** Answers giving Ember the keys as the server would, or as `saved` says. */
function serve(saved: () => Response | Promise<Response> = () => Response.json(SAVED)) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (`${init?.method} ${String(input)}` === "PUT /api/account/memberful_keys") return saved();
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

/** Set up Memberful, open on a workspace whose Memberful is as `memberful` says, at `customDomain`, if it has one. */
function showSetup({ memberful = UNSET, customDomain = null }: { memberful?: MemberfulSaved; customDomain?: string | null } = {}) {
  const callbacks = { onSaved: vi.fn(), onClose: vi.fn(), onFailed: vi.fn() };
  function WithDomain() {
    return (
      <AccountContext value={{ ...useAccount(), customDomain }}>
        <MemberfulSetup memberful={memberful} {...callbacks} />
      </AccountContext>
    );
  }
  render(<WithDomain />);
  return { ...callbacks, user: userEvent.setup() };
}

const dialog = (name: string) => screen.findByRole("dialog", { name });
const button = (name: string) => screen.getByRole("button", { name });
const field = (name: string) => screen.getByRole("textbox", { name });
const siteField = () => field("Address");
/** The fields of the keys, which aren't the site's, by the key each is for. */
const keyFields = () => ({ clientId: field("OAuth identifier"), clientSecret: field("OAuth secret"), apiKey: field("API key"), webhookSecret: field("Secret key") });
/** What the line under the last key says while there's nothing else to say. */
const SECRETS_KEPT = "Ember checks the keys with Memberful, then keeps the secrets encrypted.";
const KEYS_KEPT = "Ember has your site's keys already. Give them all again to change any of them.";

/** Types the site and keys, as given, and saves them. */
async function giveKeys(user: ReturnType<typeof userEvent.setup>, keys: MemberfulKeysChange = KEYS) {
  if (!siteField().hasAttribute("readonly")) {
    await user.clear(siteField());
    await user.type(siteField(), keys.site);
  }
  for (const [key, input] of Object.entries(keyFields())) {
    await user.clear(input);
    await user.type(input, keys[key as keyof typeof KEYS]);
  }
  await user.click(button("Save"));
}

afterEach(() => vi.restoreAllMocks());

describe("Set up Memberful", () => {
  it("starts with its three steps: the site, then a custom app and its keys, then a webhook and its secret key", async () => {
    const fetch = serve();
    const { user, onClose } = showSetup();
    const setup = await dialog("Set up Memberful");
    expect(within(setup).getByRole("heading", { name: "Set up Memberful" })).toHaveFocus();
    expect(setup).toHaveAccessibleDescription(MEMBERFUL_SETUP_EXPLAINED);
    const [site, app, webhook] = within(screen.getByRole("list", { name: "Steps to set up Memberful" })).getAllByRole("listitem");
    expect(within(site!).getByRole("heading", { level: 3, name: "Your Memberful site" })).toBeVisible();
    expect(within(site!).getAllByRole("textbox")).toEqual([siteField()]);
    expect(siteField()).toHaveValue("");
    expect(siteField()).toHaveAttribute("placeholder", "https://example.memberful.com");
    expect(siteField()).toHaveAttribute("inputmode", "url");

    expect(within(app!).getByRole("heading", { level: 3, name: "Add a custom app" })).toBeVisible();
    expect(app).toHaveTextContent(
      "In Memberful, open Settings, then Custom applications, and add one. Check Include OAuth tokens with this application, choose Server-side, and give it this OAuth Redirect URL:",
    );
    expect(app).toHaveTextContent(`${location.origin}/auth/memberful/callback`);
    expect(within(app!).getAllByRole("textbox")).toEqual([keyFields().clientId, keyFields().clientSecret, keyFields().apiKey]);

    expect(within(webhook!).getByRole("heading", { level: 3, name: "Add a webhook" })).toBeVisible();
    expect(webhook).toHaveTextContent("Under Settings, then Webhooks, add one that sends the member, subscription and order events to this URL:");
    expect(webhook).toHaveTextContent(`${location.origin}/webhooks/memberful`);
    expect(within(webhook!).getAllByRole("textbox")).toEqual([keyFields().webhookSecret]);
    expect(keyFields().webhookSecret).toHaveAccessibleDescription(SECRETS_KEPT);
    expect(screen.queryByText(KEYS_KEPT)).not.toBeInTheDocument();

    // Saved once every field has something in it.
    expect(button("Save")).toBeDisabled();
    await user.type(siteField(), "fernwood.memberful.com");
    for (const input of Object.values(keyFields())) {
      expect(button("Save")).toBeDisabled();
      await user.type(input, "key");
    }
    expect(button("Save")).toBeEnabled();

    await user.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("copies Ember's addresses for Memberful, at its custom domain once it has one", async () => {
    serve();
    const { user } = showSetup({ customDomain: "chat.example.com" });
    await dialog("Set up Memberful");
    await user.click(button("Copy the OAuth Redirect URL"));
    expect(await navigator.clipboard.readText()).toBe(`${location.protocol}//chat.example.com/auth/memberful/callback`);
    await user.click(button("Copy the webhook URL"));
    expect(await navigator.clipboard.readText()).toBe(`${location.protocol}//chat.example.com/webhooks/memberful`);
    // Copying sends nothing.
    expect(screen.getByRole("dialog", { name: "Set up Memberful" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hides the secrets as they're typed, in fields that are no password's, and keeps them out of the fields' value attributes, where custom CSS could read them", async () => {
    serve();
    const { user } = showSetup();
    await dialog("Set up Memberful");
    const { clientId, ...secrets } = keyFields();
    for (const [key, input] of Object.entries(secrets)) {
      await user.type(input, KEYS[key as keyof typeof secrets]);
      expect(input).toHaveValue(KEYS[key as keyof typeof secrets]);
      expect(input).toHaveClass("[-webkit-text-security:disc]");
      // No password manager offers to keep it, or to fill in a password it kept.
      expect(input).toHaveProperty("type", "text");
      expect(input).toHaveAttribute("autocomplete", "off");
      expect(input).not.toHaveAttribute("value");
    }
    for (const input of [siteField(), clientId]) expect(input).not.toHaveClass("[-webkit-text-security:disc]");
  });

  it("refuses what can't be a site or its keys on their fields, asking the server nothing, until they're typed again", async () => {
    const fetch = serve();
    const { user } = showSetup();
    await dialog("Set up Memberful");
    // Memberful's sites are https.
    await giveKeys(user, { ...KEYS, site: "http://fernwood.memberful.com" });
    expect(screen.getByRole("alert")).toHaveTextContent(MEMBERFUL_SITE_REFUSED);
    expect(siteField()).toHaveAttribute("aria-invalid", "true");
    expect(siteField()).toHaveAccessibleDescription(MEMBERFUL_SITE_REFUSED);
    await user.type(siteField(), "{Backspace}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Keys have no spaces in them.
    await giveKeys(user, { ...KEYS, clientId: "my custom app" });
    expect(screen.getByRole("alert")).toHaveTextContent(MEMBERFUL_CLIENT_ID_REFUSED);
    expect(keyFields().clientId).toHaveAttribute("aria-invalid", "true");
    expect(siteField()).toHaveAttribute("aria-invalid", "false");

    await giveKeys(user, { ...KEYS, apiKey: "an API key" });
    expect(screen.getByRole("alert")).toHaveTextContent(MEMBERFUL_API_KEY_REFUSED);
    expect(keyFields().apiKey).toHaveAccessibleDescription(MEMBERFUL_API_KEY_REFUSED);

    // Why the webhook's secret is refused is said in the place of the line under it, so the steps stay as tall.
    await giveKeys(user, { ...KEYS, webhookSecret: "the secret key" });
    expect(screen.getByRole("alert")).toHaveTextContent(MEMBERFUL_WEBHOOK_SECRET_REFUSED);
    expect(keyFields().webhookSecret).toHaveAccessibleDescription(MEMBERFUL_WEBHOOK_SECRET_REFUSED);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Set up Memberful" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("saves the site and keys, as the site's origin and without the spaces around them, once Memberful has taken them", async () => {
    const answer = held(() => Response.json(SAVED));
    serve(answer.answered);
    const { user, onSaved, onClose } = showSetup();
    await dialog("Set up Memberful");
    await giveKeys(user, { site: " fernwood.memberful.com/admin ", clientId: ` ${KEYS.clientId}`, clientSecret: `${KEYS.clientSecret} `, apiKey: KEYS.apiKey, webhookSecret: KEYS.webhookSecret });

    // Nothing closes it, or changes the keys, while Memberful is asked, which the line under the keys says.
    expect(screen.getByRole("status")).toHaveTextContent("Asking Memberful about the keys…");
    expect(screen.getByRole("dialog", { name: "Set up Memberful" })).toHaveAttribute("aria-busy", "true");
    expect(button("Checking…")).toBeDisabled();
    expect(button("Cancel")).toBeDisabled();
    expect(button("Close")).toBeDisabled();
    for (const input of [siteField(), ...Object.values(keyFields())]) expect(input).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    await answer.answer();
    const done = await dialog("Memberful is set up");
    expect(within(done).getByRole("heading", { name: "Memberful is set up" })).toHaveFocus();
    expect(done).toHaveAccessibleDescription(
      `Memberful took the keys. While Memberful is on, members of ${KEYS.site} join and sign in with their Memberful account, and a member whose membership lapses is signed out until it's renewed.`,
    );
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(SAVED);
    expect(asked()).toEqual([["PUT /api/account/memberful_keys", KEYS]]);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(button("Done"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says on its field why Memberful didn't take the site or a key, until it's typed again", async () => {
    const refusals = [
      { error: MEMBERFUL_SITE_UNKNOWN, field: "site" },
      { error: MEMBERFUL_API_KEY_UNKNOWN, field: "apiKey" },
      { error: MEMBERFUL_CLIENT_UNKNOWN, field: "clientSecret" },
    ];
    serve(() => Response.json(refusals.shift(), { status: 422 }));
    const { user, onSaved, onFailed } = showSetup();
    await dialog("Set up Memberful");
    await giveKeys(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(MEMBERFUL_SITE_UNKNOWN);
    expect(siteField()).toHaveAccessibleDescription(MEMBERFUL_SITE_UNKNOWN);
    expect(siteField()).toBeEnabled();
    // What was typed is still there to correct.
    expect(siteField()).toHaveValue(KEYS.site);
    expect(keyFields().webhookSecret).toHaveValue(KEYS.webhookSecret);
    expect(screen.getByRole("status")).toHaveTextContent(SECRETS_KEPT);

    await user.click(button("Save"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(MEMBERFUL_API_KEY_UNKNOWN));
    expect(keyFields().apiKey).toHaveAccessibleDescription(MEMBERFUL_API_KEY_UNKNOWN);
    expect(siteField()).toHaveAttribute("aria-invalid", "false");

    await user.click(button("Save"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(MEMBERFUL_CLIENT_UNKNOWN));
    expect(keyFields().clientSecret).toHaveAttribute("aria-invalid", "true");
    await user.type(keyFields().clientSecret, "{Backspace}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Set up Memberful" })).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says under the keys that Memberful couldn't be asked, which saving again asks", async () => {
    const answers = [() => Response.json({ error: MEMBERFUL_KEYS_UNCHECKED }, { status: 502 }), () => Response.json(SAVED)];
    serve(() => answers.shift()!());
    const { user, onSaved, onFailed } = showSetup();
    await dialog("Set up Memberful");
    await giveKeys(user);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(MEMBERFUL_KEYS_UNCHECKED));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onFailed).not.toHaveBeenCalled();

    await user.click(button("Save"));
    await dialog("Memberful is set up");
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(SAVED);
    expect(asked()).toEqual([
      ["PUT /api/account/memberful_keys", KEYS],
      ["PUT /api/account/memberful_keys", KEYS],
    ]);
  });

  it("leaves any other failure to the page's alerts, the keys still there", async () => {
    serve(() => Response.json({ error: "Only administrators can do that." }, { status: 403 }));
    const { user, onSaved, onFailed, onClose } = showSetup();
    await dialog("Set up Memberful");
    await giveKeys(user);
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can do that.")));
    expect(screen.getByRole("dialog", { name: "Set up Memberful" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(SECRETS_KEPT);
    expect(button("Save")).toBeEnabled();
    expect(keyFields().apiKey).toHaveValue(KEYS.apiKey);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("starts from the site when changing keys, and asks for every key again", async () => {
    serve();
    const { user, onSaved } = showSetup({ memberful: SAVED });
    await dialog("Set up Memberful");
    expect(siteField()).toHaveValue(KEYS.site);
    expect(siteField()).not.toHaveAttribute("readonly");
    for (const input of Object.values(keyFields())) expect(input).toHaveValue("");
    // Said under the last key, in the place of what Ember does with them.
    expect(keyFields().webhookSecret).toHaveAccessibleDescription(KEYS_KEPT);
    expect(screen.queryByText(SECRETS_KEPT)).not.toBeInTheDocument();
    expect(button("Save")).toBeDisabled();

    const another = { ...KEYS, site: "https://hollow.memberful.com" };
    vi.mocked(fetch).mockImplementation(async () => Response.json({ ...SAVED, memberfulSite: another.site }));
    await giveKeys(user, another);
    await dialog("Memberful is set up");
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ ...SAVED, memberfulSite: another.site });
    expect(asked()).toEqual([["PUT /api/account/memberful_keys", another]]);
  });

  it("keeps the site people here sign in at, saying why, with only its keys to give", async () => {
    serve();
    const { user, onSaved } = showSetup({ memberful: { ...SAVED, memberfulSiteKept: KEYS.site } });
    await dialog("Set up Memberful");
    expect(siteField()).toHaveValue(KEYS.site);
    expect(siteField()).toHaveAttribute("readonly");
    expect(siteField()).toHaveAccessibleDescription(memberfulSiteKept(KEYS.site));
    await user.type(siteField(), "x");
    expect(siteField()).toHaveValue(KEYS.site);

    await giveKeys(user);
    await dialog("Memberful is set up");
    expect(onSaved).toHaveBeenCalledOnce();
    expect(asked()).toEqual([["PUT /api/account/memberful_keys", KEYS]]);
  });

  it("keeps the site people signed in at with the deployment's keys, once those are gone", async () => {
    serve();
    showSetup({ memberful: { ...UNSET, memberfulSiteKept: KEYS.site } });
    await dialog("Set up Memberful");
    expect(siteField()).toHaveValue(KEYS.site);
    expect(siteField()).toHaveAttribute("readonly");
    expect(keyFields().webhookSecret).toHaveAccessibleDescription(SECRETS_KEPT);
  });
});
