import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_ID_REFUSED, ISSUER_REFUSED, ISSUER_UNREACHABLE, SCOPES_REFUSED, SSO_FORBIDDEN, type SsoSettings } from "@ember/protocol/sso";
import { ApiError } from "@/lib/api";
import { SsoSetup } from "./sso-setup";

/** The provider and its app's keys, as an administrator copies them from Zitadel. */
const ISSUER = "https://example.zitadel.cloud";
const CLIENT_ID = "290871046598765432";
const CLIENT_SECRET = "s3cr3t-from-zitadel";

/** The provider as an administrator saved it. */
const SAVED: SsoSettings = {
  source: "saved",
  issuer: ISSUER,
  clientId: CLIENT_ID,
  name: "Acme",
  scopes: ["roles"],
  groupsClaim: "urn:zitadel:iam:org:project:roles",
  allowedGroups: ["staff", "contractors"],
  linksVerifiedEmails: true,
};

/** Answers saving the provider as the server would, or as `saved` says. */
function serve(saved: () => Response | Promise<Response> = () => Response.json({ sso: SAVED })) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (`${init?.method} ${String(input)}` === "PUT /api/account/sso") return saved();
    throw new Error(`Unexpected request for ${init?.method} ${String(input)}`);
  });
}

/** What the dialog sent to save the provider, in order. */
const sent = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as unknown);

function showSetup(sso: SsoSettings | null = null) {
  const callbacks = { onSaved: vi.fn(), onClose: vi.fn(), onFailed: vi.fn() };
  render(<SsoSetup sso={sso} {...callbacks} />);
  return { ...callbacks, user: userEvent.setup() };
}

const dialog = (name: string) => screen.findByRole("dialog", { name });
const button = (name: string) => screen.getByRole("button", { name });
const field = (name: string) => screen.getByLabelText(name);

afterEach(() => vi.restoreAllMocks());

describe("Set up single sign-on", () => {
  it("starts with the URIs to register at the provider, at Ember's address, and blank fields", async () => {
    serve();
    showSetup();
    const setup = await dialog("Set up single sign-on");
    expect(within(setup).getByRole("heading", { name: "Set up single sign-on" })).toHaveFocus();
    const [create, redirect, logout, enter] = within(screen.getByRole("list", { name: "Steps to set up your provider" })).getAllByRole("listitem");
    expect(create).toHaveTextContent("create a web app that uses the authorization code flow with PKCE.");
    // Without refresh tokens, Ember can't check that people may still sign in.
    expect(create).toHaveTextContent(
      "Let it give refresh tokens, often called the refresh token grant or offline_access, so that Ember checks every hour that each person may still sign in. Without them, it checks only as people sign in.",
    );
    expect(redirect).toHaveTextContent(`Set its redirect URI to ${location.origin}/auth/sso/callback.`);
    expect(logout).toHaveTextContent(`set its back-channel logout URI to ${location.origin}/auth/sso/backchannel_logout.`);
    expect(enter).toHaveTextContent("Enter the app's details below.");
    expect(field("Client Secret")).toHaveAccessibleDescription("Stored encrypted.");
    expect(field("Issuer URL")).toHaveValue("");
    expect(field("Button name")).toHaveAttribute("placeholder", "SSO");
    expect(field("Groups claim")).toHaveAttribute("placeholder", "groups");
    expect(field("Groups claim")).toHaveAccessibleDescription(
      "The claim that lists each person's groups or roles, in the ID token or the userinfo endpoint's answer. Where both give it, the userinfo endpoint's counts.",
    );
    expect(field("Allowed groups").tagName).toBe("TEXTAREA");
    expect(field("Allowed groups")).toHaveAccessibleDescription(/urn:zitadel:iam:org:project:roles/);
    expect(screen.getByRole("checkbox", { name: /Link accounts by verified email/ })).not.toBeChecked();
    // Whoever has an address at the provider gets the account here that has it.
    expect(screen.getByRole("checkbox", { name: /Link accounts by verified email/ })).toHaveAccessibleDescription(
      /Only check it if your provider verifies addresses and doesn't let people change their own, since whoever has an address there gets the account here\.$/,
    );
    expect(button("Save")).toBeDisabled();
  });

  it("hides the secret as it's typed, in a field that's no password's, and keeps it out of the field's value attribute, where custom CSS could read it", async () => {
    serve();
    const { user } = showSetup();
    await dialog("Set up single sign-on");
    const input = field("Client Secret");
    await user.type(input, CLIENT_SECRET);
    expect(input).toHaveValue(CLIENT_SECRET);
    expect(input).toHaveClass("[-webkit-text-security:disc]");
    // No password manager offers to keep it, or to fill in a password it kept.
    expect(input).toHaveProperty("type", "text");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).not.toHaveAttribute("value");
    for (const other of ["Issuer URL", "Client ID"]) expect(field(other)).not.toHaveClass("[-webkit-text-security:disc]");
  });

  it("saves the provider, with the scopes apart by spaces and the groups one a line, then says it's set up", async () => {
    serve();
    const { user, onSaved, onClose } = showSetup();
    await user.type(field("Issuer URL"), ISSUER);
    await user.type(field("Client ID"), CLIENT_ID);
    await user.type(field("Client Secret"), CLIENT_SECRET);
    await user.type(field("Button name"), "Acme");
    await user.type(field("Extra scopes"), "roles  roles");
    await user.type(field("Groups claim"), "urn:zitadel:iam:org:project:roles");
    await user.type(field("Allowed groups"), "staff{Enter}contractors{Enter}");
    await user.click(screen.getByRole("checkbox", { name: /Link accounts by verified email/ }));
    await user.click(button("Save"));
    // Saving checks the provider's discovery document, but not the Client ID and secret, which only a sign-in does.
    expect(await dialog("Single sign-on is ready")).toHaveAccessibleDescription(
      "Ember found your provider, but it first uses the Client ID and secret as someone signs in. Once Single sign-on is on, sign in with your provider in a private window to check them.",
    );
    expect(sent()).toEqual([
      {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        name: "Acme",
        scopes: ["roles"],
        groupsClaim: "urn:zitadel:iam:org:project:roles",
        allowedGroups: ["staff", "contractors"],
        linksVerifiedEmails: true,
      },
    ]);
    expect(onSaved).toHaveBeenCalledWith(SAVED);
    await user.click(button("Done"));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("starts from the provider as saved, keeping its secret while that's left blank", async () => {
    serve();
    const { user } = showSetup(SAVED);
    await dialog("Set up single sign-on");
    expect(field("Issuer URL")).toHaveValue(ISSUER);
    expect(field("Client ID")).toHaveValue(CLIENT_ID);
    expect(field("Client Secret")).toHaveValue("");
    expect(field("Client Secret")).toHaveAccessibleDescription("Stored encrypted. Leave blank to keep the current one.");
    expect(field("Button name")).toHaveValue("Acme");
    expect(field("Allowed groups")).toHaveValue("staff\ncontractors");
    expect(screen.getByRole("checkbox", { name: /Link accounts by verified email/ })).toBeChecked();
    await user.click(button("Save"));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).not.toHaveProperty("clientSecret");
  });

  it("asks for the secret again once the issuer or app changes, as the Worker won't keep it for another", async () => {
    serve();
    const { user } = showSetup(SAVED);
    await dialog("Set up single sign-on");
    await user.type(field("Issuer URL"), "/other");
    expect(field("Client Secret")).not.toHaveAccessibleDescription("Stored encrypted. Leave blank to keep the current one.");
    expect(button("Save")).toBeDisabled();
    await user.clear(field("Issuer URL"));
    await user.type(field("Issuer URL"), ISSUER);
    expect(field("Client Secret")).toHaveAccessibleDescription("Stored encrypted. Leave blank to keep the current one.");
    expect(button("Save")).toBeEnabled();
  });

  it("shows the issuer and app the deployment's secrets give as they are, and sends only the rest", async () => {
    serve();
    const { user } = showSetup({ ...SAVED, source: "secret" });
    await dialog("Set up single sign-on");
    expect(field("Issuer URL")).toHaveAttribute("readonly");
    expect(field("Issuer URL")).toHaveValue(ISSUER);
    expect(field("Client ID")).toHaveAttribute("readonly");
    expect(screen.queryByLabelText("Client Secret")).not.toBeInTheDocument();
    expect(screen.getByText(/Set by your deployment's/)).toBeInTheDocument();
    await user.click(button("Save"));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ name: "Acme", scopes: ["roles"], groupsClaim: "urn:zitadel:iam:org:project:roles", allowedGroups: ["staff", "contractors"], linksVerifiedEmails: true });
  });

  it("says on the field why it's refused before asking the provider, until that field is typed in", async () => {
    serve();
    const { user } = showSetup();
    await user.type(field("Issuer URL"), "example.zitadel.cloud");
    await user.type(field("Client ID"), CLIENT_ID);
    await user.type(field("Client Secret"), CLIENT_SECRET);
    await user.click(button("Save"));
    expect(field("Issuer URL")).toHaveAccessibleDescription(ISSUER_REFUSED);
    expect(field("Issuer URL")).toHaveAttribute("aria-invalid", "true");
    expect(fetch).not.toHaveBeenCalled();
    await user.type(field("Client ID"), "x");
    expect(field("Issuer URL")).toHaveAccessibleDescription(ISSUER_REFUSED);
    await user.type(field("Issuer URL"), "x");
    expect(field("Issuer URL")).not.toHaveAccessibleDescription(ISSUER_REFUSED);
  });

  it.each([
    ["issuer", "Issuer URL", ISSUER_UNREACHABLE],
    ["clientId", "Client ID", CLIENT_ID_REFUSED],
    ["scopes", "Extra scopes", SCOPES_REFUSED],
  ])("says on the %s field why the Worker refused it", async (name, label, error) => {
    serve(() => Response.json({ error, field: name }, { status: 422 }));
    const { user, onSaved, onFailed } = showSetup(SAVED);
    await dialog("Set up single sign-on");
    await user.click(button("Save"));
    await waitFor(() => expect(field(label)).toHaveAccessibleDescription(expect.stringContaining(error)));
    expect(screen.getByRole("dialog", { name: "Set up single sign-on" })).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("leaves any other failure to the workspace's alerts, and closes without saying it saved", async () => {
    serve(() => Response.json({ error: SSO_FORBIDDEN }, { status: 403 }));
    const { user, onFailed, onClose } = showSetup(SAVED);
    await dialog("Set up single sign-on");
    await user.click(button("Save"));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, SSO_FORBIDDEN)));
    await user.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledWith(false);
  });
});
