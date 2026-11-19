import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SSO_FORBIDDEN, type SsoSettings } from "@ember/protocol/sso";
import { ApiError } from "@/lib/api";
import { CONFIRM_FORGET_SSO, SingleSignOnSettings } from "./sso-settings";

const SAVED: SsoSettings = {
  source: "saved",
  issuer: "https://example.zitadel.cloud",
  clientId: "290871046598765432",
  name: "Acme",
  scopes: [],
  groupsClaim: "groups",
  allowedGroups: [],
  linksVerifiedEmails: false,
};

/** Answers removing the provider as the server would, or as `forgotten` says. */
function serve(forgotten: () => Response | Promise<Response> = () => Response.json({ sso: null })) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (`${init?.method} ${String(input)}` === "DELETE /api/account/sso") return forgotten();
    throw new Error(`Unexpected request for ${init?.method} ${String(input)}`);
  });
}

function showCard({ sso = null as SsoSettings | null, checked = false, ssoOnly = false, setAside = null as string | null } = {}) {
  const callbacks = { onCheckedChange: vi.fn(), onSsoOnlyChange: vi.fn(), onSetUp: vi.fn(), onForgotten: vi.fn(), onFailed: vi.fn() };
  render(<SingleSignOnSettings sso={sso} checked={checked} ssoOnly={ssoOnly} setAside={setAside} {...callbacks} />);
  return { ...callbacks, user: userEvent.setup() };
}

const card = () => screen.getByRole("region", { name: "Single sign-on" });
const ssoSwitch = () => within(card()).getByRole("switch", { name: "Single sign-on" });

afterEach(() => vi.restoreAllMocks());

describe("Single sign-on", () => {
  it("opens Set up single sign-on as it's turned on before a provider is set up, and goes on once that's saved", async () => {
    const { user, onSetUp, onCheckedChange } = showCard();
    expect(ssoSwitch()).not.toBeChecked();
    expect(ssoSwitch()).toHaveAccessibleDescription(/or another identity provider\.$/);
    expect(within(card()).queryByRole("button", { name: "Change settings" })).not.toBeInTheDocument();
    await user.click(ssoSwitch());
    expect(onSetUp).toHaveBeenCalledOnce();
    expect(onCheckedChange).not.toHaveBeenCalled();
    // What Set up single sign-on goes on to once it's saved.
    onSetUp.mock.calls[0]![0]();
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("names the provider once it's set up, whose switch saves at once, and offers to change or remove it", async () => {
    const { user, onCheckedChange, onSetUp } = showCard({ sso: { ...SAVED, allowedGroups: ["staff"] } });
    expect(ssoSwitch()).toHaveAccessibleDescription(
      "People sign in at https://example.zitadel.cloud using the Sign in with Acme button. Only allowed groups have access. When this is off, new people can't join, but members can still sign in.",
    );
    expect(within(card()).queryByRole("switch", { name: "SSO only" })).not.toBeInTheDocument();
    await user.click(ssoSwitch());
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    await user.click(within(card()).getByRole("button", { name: "Change settings" }));
    expect(onSetUp).toHaveBeenCalledWith();
  });

  it("offers SSO only while it's on", async () => {
    const { user, onSsoOnlyChange } = showCard({ sso: SAVED, checked: true });
    const ssoOnly = within(card()).getByRole("switch", { name: "SSO only" });
    expect(ssoOnly).not.toBeChecked();
    expect(ssoOnly).toHaveAccessibleDescription(/^Everyone signs in with single sign-on, except administrators and people you invite/);
    await user.click(ssoOnly);
    expect(onSsoOnlyChange).toHaveBeenCalledWith(true);
  });

  it("says nobody can sign in with it while it's on without a provider", () => {
    showCard({ checked: true });
    expect(ssoSwitch()).toBeChecked();
    expect(ssoSwitch()).toHaveAccessibleDescription("No provider is set up, so no one can sign in with single sign-on. Turn it off, then on again to set it up.");
  });

  it("is greyed out while another way to join sets it aside", () => {
    showCard({ sso: SAVED, checked: true, setAside: "Set aside while Open lets anyone join." });
    expect(ssoSwitch()).toBeDisabled();
    expect(ssoSwitch()).toHaveAccessibleDescription("Set aside while Open lets anyone join.");
    expect(within(card()).queryByRole("switch", { name: "SSO only" })).not.toBeInTheDocument();
    expect(within(card()).queryByRole("button", { name: "Change settings" })).not.toBeInTheDocument();
  });

  it("removes the provider once you confirm, showing it as removing it left it", async () => {
    serve();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onForgotten } = showCard({ sso: SAVED, checked: true });
    await user.click(within(card()).getByRole("button", { name: "Remove" }));
    expect(confirm).toHaveBeenCalledWith(CONFIRM_FORGET_SSO);
    await waitFor(() => expect(onForgotten).toHaveBeenCalledWith(null));
  });

  it("removes nothing unless you confirm", async () => {
    serve();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = showCard({ sso: SAVED });
    await user.click(within(card()).getByRole("button", { name: "Remove" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says why removing it failed", async () => {
    serve(() => Response.json({ error: SSO_FORBIDDEN }, { status: 403 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onFailed, onForgotten } = showCard({ sso: SAVED });
    await user.click(within(card()).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, SSO_FORBIDDEN)));
    expect(onForgotten).not.toHaveBeenCalled();
    expect(within(card()).getByRole("button", { name: "Remove" })).toBeEnabled();
  });

  it("offers no Remove while the deployment's secrets give the provider", () => {
    showCard({ sso: { ...SAVED, source: "secret" } });
    expect(within(card()).getByRole("button", { name: "Change settings" })).toBeInTheDocument();
    expect(within(card()).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });
});
