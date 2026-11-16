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
/** The fields of the keys, which aren't the site's, by the key each is for, in the order the steps ask for them. */
const keyFields = () => ({ apiKey: field("API Key"), clientId: field("OAuth Identifier"), clientSecret: field("OAuth Secret"), webhookSecret: field("Secret key") });
/** What the line under the last key says while there's nothing else to say. */
const SECRETS_KEPT = "Ember checks the keys with Memberful, then keeps the secrets encrypted.";
const KEYS_KEPT = "Ember has your site's keys already. Give them all again to change any of them.";
/** What's said under the site's address, unless Ember keeps the site. */
const WHERE_THE_SITE_IS = "It's the address in your browser when you're signed in to Memberful's admin, such as yoursite.memberful.com.";
/** The links to Memberful's forms for a new custom app, and a new webhook, once the site's address is one at memberful.com. */
const newAppLink = () => screen.queryByRole("link", { name: "create a new app for Ember" });
const newWebhookLink = () => screen.queryByRole("link", { name: "Settings → Webhooks → Create webhook" });

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

/** Types `keys` over what their fields hold, the rest staying as they are, and saves them. */
async function changeKeys(user: ReturnType<typeof userEvent.setup>, keys: Partial<MemberfulKeysChange>) {
  const fields = { site: siteField(), ...keyFields() };
  for (const [key, value] of Object.entries(keys)) {
    await user.clear(fields[key as keyof typeof KEYS]);
    await user.type(fields[key as keyof typeof KEYS], value);
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
    expect(siteField()).toHaveAccessibleDescription(WHERE_THE_SITE_IS);
    expect(siteField()).toHaveAttribute("inputmode", "url");

    // Each step says what to fill in on Memberful's form by the names Memberful gives its fields.
    expect(within(app!).getByRole("heading", { level: 3, name: "Add a custom app" })).toBeVisible();
    expect(app).toHaveTextContent(
      "In Memberful, create a new app for Ember. Don't reuse an existing one, because its redirect URL must point at Ember. Name it Ember, check Include OAuth tokens with this application, choose Server-side Application, and paste this as the OAuth Redirect URL:" +
        `${location.origin}/auth/memberful/callback` +
        "Copy the OAuth Redirect URL" +
        "Choose Server-side even if you plan a mobile app. Ember's server handles the sign-in; phone apps sign in through Ember." +
        "After you save, Memberful opens the app's page with its keys. Copy them here from top to bottom.",
    );
    // Its keys in the order the app's page shows them.
    expect(within(app!).getAllByRole("textbox")).toEqual([keyFields().apiKey, keyFields().clientId, keyFields().clientSecret]);

    expect(within(webhook!).getByRole("heading", { level: 3, name: "Add a webhook" })).toBeVisible();
    expect(webhook).toHaveTextContent(
      "So Ember removes access as soon as a membership ends, rather than at its daily check. This is separate from the app. In Memberful, go to Settings → Webhooks → Create webhook. Name it Ember, and paste this as the Endpoint URL:" +
        `${location.origin}/webhooks/memberful` +
        "Copy the Endpoint URL" +
        "Select every event under Member, Order, Subscription, and Plan. Download isn't needed. After you save it, Memberful gives the webhook a secret key. Copy it here.",
    );
    expect(within(webhook!).getAllByRole("textbox")).toEqual([keyFields().webhookSecret]);
    // Nothing links to Memberful's forms until there's a site's address to link to.
    expect(newAppLink()).not.toBeInTheDocument();
    expect(newWebhookLink()).not.toBeInTheDocument();
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
    await user.click(button("Copy the Endpoint URL"));
    expect(await navigator.clipboard.readText()).toBe(`${location.protocol}//chat.example.com/webhooks/memberful`);
    // Copying sends nothing.
    expect(screen.getByRole("dialog", { name: "Set up Memberful" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("links to Memberful's forms for a new app and a new webhook, in a new tab, once the site's address is one at memberful.com, however it's typed", async () => {
    serve();
    const { user } = showSetup();
    await dialog("Set up Memberful");
    const linksTo = (site: string) => {
      expect(newAppLink()).toHaveAttribute("href", `${site}/admin/settings/custom_applications/new`);
      expect(newWebhookLink()).toHaveAttribute("href", `${site}/admin/settings/webhooks/new`);
      for (const link of [newAppLink(), newWebhookLink()]) expect(link).toHaveAttribute("target", "_blank");
    };
    // The site's name alone, as Memberful's admin's address names it, is its address at memberful.com.
    await user.type(siteField(), "Fernwood");
    linksTo(KEYS.site);
    for (const given of ["fernwood.memberful.com", "https://fernwood.memberful.com/admin/members"]) {
      await user.clear(siteField());
      await user.type(siteField(), given);
      linksTo(KEYS.site);
    }
    // Not at a domain of the site's own, where Memberful may not serve its admin, nor what can't be a site's address.
    for (const given of ["members.fernwood.example", "http://fernwood.memberful.com", "fern wood"]) {
      await user.clear(siteField());
      await user.type(siteField(), given);
      expect(newAppLink()).not.toBeInTheDocument();
      expect(newWebhookLink()).not.toBeInTheDocument();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("saves a site's name alone as its address at memberful.com", async () => {
    serve();
    const { user, onSaved } = showSetup();
    await dialog("Set up Memberful");
    await giveKeys(user, { ...KEYS, site: " fernwood " });
    const done = await dialog("Memberful is set up");
    expect(done).toHaveAccessibleDescription(expect.stringContaining(`members of ${KEYS.site} join`));
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(SAVED);
    expect(asked()).toEqual([["PUT /api/account/memberful_keys", KEYS]]);
  });

  it("links to the forms at the site Ember keeps, or Change keys starts from", async () => {
    serve();
    showSetup({ memberful: { ...SAVED, memberfulSite: "https://hollow.memberful.com", memberfulSiteKept: "https://hollow.memberful.com" } });
    await dialog("Set up Memberful");
    expect(newAppLink()).toHaveAttribute("href", "https://hollow.memberful.com/admin/settings/custom_applications/new");
    expect(newWebhookLink()).toHaveAttribute("href", "https://hollow.memberful.com/admin/settings/webhooks/new");
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

    // Keys have no spaces in them. Only the fields that change are typed again from here: typing all five
    // each time took the test past its five seconds on a busy machine.
    await changeKeys(user, { site: KEYS.site, clientId: "my custom app" });
    expect(screen.getByRole("alert")).toHaveTextContent(MEMBERFUL_CLIENT_ID_REFUSED);
    expect(keyFields().clientId).toHaveAttribute("aria-invalid", "true");
    expect(siteField()).toHaveAttribute("aria-invalid", "false");

    await changeKeys(user, { clientId: KEYS.clientId, apiKey: "an API key" });
    expect(screen.getByRole("alert")).toHaveTextContent(MEMBERFUL_API_KEY_REFUSED);
    expect(keyFields().apiKey).toHaveAccessibleDescription(MEMBERFUL_API_KEY_REFUSED);

    // Why the webhook's secret is refused is said in the place of the line under it, so the steps stay as tall.
    await changeKeys(user, { apiKey: KEYS.apiKey, webhookSecret: "the secret key" });
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
