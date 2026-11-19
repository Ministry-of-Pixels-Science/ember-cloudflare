import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withNavigationIcons, type Account, type AccountChanges, type CustomStyles } from "@ember/protocol";
import { FlashProvider } from "@/components/flash";
import { Sheet } from "@/components/ui/sheet";
import { AccountContext } from "@/hooks/use-account";
import { CustomStylesPage } from "./custom-styles-page";
import { CHANGES_SAVED } from "./settings-page";

const CSS = ".mb-app { --mb-ink: rebeccapurple; }";
const styled: Account = { name: "Analytical Engines", tagline: "", hideTranslationButtons: true, customStyles: CSS, restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true };

/** The icon pickers' catalog: a few icons, with Coffee suggested for a break room. */
const CATALOG = {
  icons: [
    { name: "coffee", label: "Coffee", roomLabel: "Break Room", collection: "Lucide", tags: ["drink"], svg: "<svg></svg>" },
    { name: "iconoir:regular:home", label: "Home", collection: "Iconoir", tags: ["house"], svg: "<svg></svg>" },
    { name: "telescope", label: "Telescope", collection: "Lucide", tags: ["search"], svg: "<svg></svg>" },
  ],
  roomOrder: ["coffee", "iconoir:regular:home", "telescope"],
  navigationOrder: ["telescope", "iconoir:regular:home", "coffee"],
};

interface Answers {
  /** The workspace as the server has it, rather than `styled`. */
  account?: Account;
  /** What loading the CSS answers, rather than `CSS`. */
  loaded?: () => Response | Promise<Response>;
  /** What saving the CSS answers, rather than the workspace with the CSS sent. */
  saved?: () => Response | Promise<Response>;
  /** What saving the navigation icons answers, rather than the workspace with the icons changed as asked. */
  iconsSaved?: () => Response | Promise<Response>;
}

/** Answers the page's requests as the server does for an administrator, or as `answers` says. */
function serve({ account = styled, loaded = () => Response.json({ customStyles: CSS } satisfies CustomStyles), saved, iconsSaved }: Answers = {}) {
  let kept = account;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    if (request.endsWith("catalog.json")) return Response.json(CATALOG);
    switch (request) {
      case "GET /api/account/custom_styles":
        return loaded();
      case "PATCH /api/account/custom_styles":
        if (saved) return saved();
        kept = { ...kept, ...(JSON.parse(String(init?.body)) as CustomStyles) };
        return Response.json({ account: kept });
      case "PATCH /api/account": {
        if (iconsSaved) return iconsSaved();
        const { navigationIcons = {} } = JSON.parse(String(init?.body)) as AccountChanges;
        kept = { ...kept, navigationIcons: withNavigationIcons(kept.navigationIcons, navigationIcons) };
        return Response.json({ account: kept });
      }
      default:
        throw new Error(`Unexpected request for ${request}`);
    }
  });
}

/** Changes the workspace the page shows, as the workspace socket does. */
let workspaceSays: (account: Account) => void;

/** The page, with the workspace as the app keeps it: changed as the page or the workspace socket says. */
function Page({ account: loaded, answered, onFailed }: { account: Account; answered: (account: Account) => void; onFailed: (error: unknown) => void }) {
  const [account, setAccount] = useState(loaded);
  workspaceSays = setAccount;
  // As the app's, it stays the same.
  const [askForAccount] = useState(() => () => (account: Account) => {
    answered(account);
    setAccount(account);
  });
  return (
    <AccountContext value={account}>
      <FlashProvider workspace>
        <Sheet>
          <CustomStylesPage askForAccount={askForAccount} onFailed={onFailed} />
        </Sheet>
      </FlashProvider>
    </AccountContext>
  );
}

function showPage(account = styled) {
  const [answered, onFailed] = [vi.fn(), vi.fn()];
  history.replaceState(null, "", "/account/custom_styles/edit");
  render(<Page account={account} answered={answered} onFailed={onFailed} />);
  return { answered, onFailed, user: userEvent.setup() };
}

const cssSection = () => screen.getByRole("region", { name: "Custom CSS" });
const iconsSection = () => screen.getByRole("region", { name: "Navigation icons" });
const field = () => screen.getByRole("textbox", { name: "Custom CSS" });
/** The field, once the CSS has loaded into it. */
const loadedField = async () => {
  await waitFor(() => expect(field()).toBeEnabled());
  return field();
};
const saveButton = () => within(cssSection()).getByRole("button", { name: "Save changes" });
/** What each save to `address` sent, in order. */
const sentTo = (address: string) =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([input, init]) => init?.method === "PATCH" && String(input) === address)
    .map(([, init]) => JSON.parse(String(init?.body)) as unknown);
/** The CSS each save sent, in order. */
const saved = () => sentTo("/api/account/custom_styles").map((sent) => (sent as CustomStyles).customStyles);

beforeEach(() => {
  serve();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Custom CSS", () => {
  it("reads Custom CSS, titled Custom styles, with Go Back to workspace settings", () => {
    showPage();
    expect(document.title).toBe("Custom styles");
    expect(screen.getByRole("heading", { level: 1, name: "Custom CSS" })).toBeInTheDocument();
    expect(screen.getByText("Add custom CSS styles.")).toBeInTheDocument();
    expect(screen.getByText("Use Caution: you could break things.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/account/edit");
  });

  it("is busy until the CSS loads, and then shows it to change", async () => {
    showPage();
    expect(cssSection()).toHaveAttribute("aria-busy", "true");
    expect(field()).toBeDisabled();
    expect(saveButton()).toBeDisabled();
    expect(await loadedField()).toHaveValue(CSS);
    expect(cssSection()).toHaveAttribute("aria-busy", "false");
    expect(saveButton()).toBeEnabled();
  });

  it("takes CSS as typed, with nothing correcting it", () => {
    showPage();
    expect(field()).toHaveAttribute("placeholder", "Add CSS styles…");
    expect(field()).toHaveAttribute("rows", "16");
    expect(field()).toHaveAttribute("maxlength", "100000");
    expect(field()).toHaveAttribute("spellcheck", "false");
    for (const attribute of ["autocorrect", "autocapitalize", "autocomplete"]) expect(field()).toHaveAttribute(attribute, "off");
  });

  it("saves the CSS with the check, saying ✓, for every page to apply at once", async () => {
    const { answered, user } = showPage();
    const css = await loadedField();
    await user.clear(css);
    await user.type(css, "body {{ color: red; }");
    await user.click(saveButton());

    // The flash's check alone, read as "Changes saved".
    expect(await screen.findByRole("alert")).toHaveTextContent("Changes saved");
    expect(saved()).toEqual(["body { color: red; }"]);
    expect(answered).toHaveBeenCalledWith({ ...styled, customStyles: "body { color: red; }" });
    expect(css).toHaveValue("body { color: red; }");
    // The navigation icons aren't sent with it.
    expect(sentTo("/api/account")).toEqual([]);
  });

  it("saves with Ctrl+Enter or ⌘+Enter, where Enter alone starts a new line", async () => {
    const { answered, user } = showPage();
    const css = await loadedField();
    await user.type(css, "{Enter}");
    expect(css).toHaveValue(`${CSS}\n`);
    expect(saved()).toEqual([]);

    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(answered).toHaveBeenCalledTimes(1));
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(answered).toHaveBeenCalledTimes(2));
    expect(saved()).toEqual([`${CSS}\n`, `${CSS}\n`]);
    expect(css).toHaveValue(`${CSS}\n`);
  });

  it("can't save again until the last save is answered", async () => {
    let answer = (_: Response) => {};
    serve({ saved: () => new Promise((resolve) => (answer = resolve)) });
    const { user } = showPage();
    await loadedField();
    await user.click(saveButton());
    expect(saveButton()).toBeDisabled();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(saved()).toEqual([CSS]);
    answer(Response.json({ account: styled }));
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });

  it("says why a save failed, keeping the CSS typed", async () => {
    serve({ saved: () => Response.json({ error: "Custom CSS must be at most 100,000 characters" }, { status: 422 }) });
    const { answered, onFailed, user } = showPage();
    await user.type(await loadedField(), " /* more */");
    await user.click(saveButton());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 422, message: "Custom CSS must be at most 100,000 characters" })));
    expect(field()).toHaveValue(`${CSS} /* more */`);
    expect(saveButton()).toBeEnabled();
    expect(answered).not.toHaveBeenCalled();
  });

  it("sends anyone but an administrator to workspace settings, saying why", async () => {
    serve({ loaded: () => Response.json({ error: "Only administrators can change the workspace" }, { status: 403 }) });
    const { onFailed } = showPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Only administrators can change the workspace");
    expect(location.pathname).toBe("/account/edit");
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says why the CSS didn't load", async () => {
    serve({ loaded: () => Response.json({ error: "Something went wrong" }, { status: 500 }) });
    const { onFailed } = showPage();
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 500 })));
    expect(location.pathname).toBe("/account/custom_styles/edit");
  });
});

describe("Navigation icons", () => {
  const pickers = () => within(iconsSection()).getAllByRole("button", { name: /^Choose / });
  const picker = (slot: string) => screen.findByRole("button", { name: `Choose ${slot} icon` });
  const dialog = () => screen.getByRole("dialog", { name: "Choose a navigation icon" });
  const saveIcons = () => within(iconsSection()).getByRole("button", { name: "Save changes" });
  /** The icons each save sent, in order. */
  const sentIcons = () => sentTo("/api/account");
  /** Each picker, once the page has loaded and they can be used. */
  const loadedPickers = async () => {
    await waitFor(() => expect(saveIcons()).toBeEnabled());
    return pickers();
  };

  it("lists a picker for each of the rail's buttons and appearance modes, under Navigation icons, above Custom CSS", async () => {
    const account: Account = { ...styled, navigationIcons: { home: "coffee", dark: "iconoir:regular:home" } };
    serve({ account });
    showPage(account);
    const home = await picker("Home");
    expect(within(iconsSection()).getByRole("heading", { level: 1, name: "Navigation icons" })).toBeInTheDocument();
    expect(iconsSection()).toHaveTextContent("Choose the icons in your community’s left navigation. Changes apply to everyone.");
    expect(iconsSection().compareDocumentPosition(cssSection()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pickers().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Choose Home icon",
      "Choose DMs icon",
      "Choose Activity icon",
      "Choose Search icon",
      "Choose Admin icon",
      "Choose Light mode icon",
      "Choose Dark mode icon",
      "Choose System appearance icon",
    ]);
    // Called by their own names, not as rooms suggest them.
    await waitFor(() => expect(home).toHaveTextContent("HomeCoffee"));
    expect(home.querySelector("[data-icon]")).toHaveAttribute("data-icon", "coffee");
    expect(await picker("Dark mode")).toHaveTextContent("Dark modeHome · Iconoir");
    const dms = await picker("DMs");
    expect(dms).toHaveTextContent("DMsDefault icon");
    expect(dms).toHaveAttribute("aria-haspopup", "dialog");
    expect(dms.querySelector(".iconoir-multi-bubble")).toBeInTheDocument();
  });

  it("can't be changed until the page has loaded, as the CSS can't", async () => {
    showPage();
    expect(iconsSection()).toHaveAttribute("aria-busy", "true");
    for (const button of pickers()) expect(button).toBeDisabled();
    expect(saveIcons()).toBeDisabled();
    for (const button of await loadedPickers()) expect(button).toBeEnabled();
    expect(iconsSection()).toHaveAttribute("aria-busy", "false");
  });

  it("chooses an icon in the dialog, which their own Save changes saves, sending only the slots changed", async () => {
    const { answered, user } = showPage();
    await loadedPickers();
    const search = await picker("Search");
    await user.click(search);
    expect(dialog()).toHaveTextContent("Recommendations for your navigation buttons and appearance modes.");
    const grid = within(dialog()).getByRole("group", { name: "Navigation icons" });
    // In the catalog's navigation order, by their own names.
    await waitFor(() =>
      expect(within(grid).getAllByRole("button").map((option) => option.getAttribute("aria-label"))).toEqual(["Use Telescope icon", "Use Home icon from Iconoir", "Use Coffee icon"]),
    );
    expect(within(dialog()).getByRole("button", { name: "Use default icon" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(grid).getByRole("button", { name: "Use Telescope icon" }));
    await user.click(within(dialog()).getByRole("button", { name: "Use icon" }));
    expect(search).toHaveTextContent("SearchTelescope");
    expect(search).toHaveFocus();
    expect(sentIcons()).toEqual([]);

    await user.click(saveIcons());
    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(sentIcons()).toEqual([{ navigationIcons: { search: "telescope" } }]);
    expect(answered).toHaveBeenLastCalledWith({ ...styled, navigationIcons: { search: "telescope" } });
    expect(search).toHaveTextContent("SearchTelescope");
    // The CSS isn't sent with them.
    expect(saved()).toEqual([]);

    // Saved again, they're as the workspace has them, so no slot is sent.
    await user.click(saveIcons());
    await waitFor(() => expect(sentIcons()).toHaveLength(2));
    expect(sentIcons()[1]).toEqual({ navigationIcons: {} });
  });

  it("gives a slot its own icon back with Use default icon, or the default's own icon", async () => {
    const account: Account = { ...styled, navigationIcons: { home: "coffee", search: "telescope" } };
    serve({ account });
    const { answered, user } = showPage(account);
    await loadedPickers();
    const search = await picker("Search");
    expect(search).toHaveTextContent("SearchTelescope");
    await user.click(search);
    await user.click(within(dialog()).getByRole("button", { name: "Use default icon" }));
    await user.click(within(dialog()).getByRole("button", { name: "Use icon" }));
    expect(search).toHaveTextContent("SearchDefault icon");

    const home = await picker("Home");
    await user.click(home);
    await user.click(await within(dialog()).findByRole("button", { name: "Use Home icon from Iconoir" }));
    await user.click(within(dialog()).getByRole("button", { name: "Use icon" }));
    expect(home).toHaveTextContent("HomeDefault icon");

    await user.click(saveIcons());
    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(sentIcons()).toEqual([{ navigationIcons: { search: "", home: "" } }]);
    expect(answered).toHaveBeenLastCalledWith(styled);
  });

  it("leaves a slot as it was when the dialog's cancelled", async () => {
    const { user } = showPage();
    await loadedPickers();
    const home = await picker("Home");
    await user.click(home);
    await user.click(await within(dialog()).findByRole("button", { name: "Use Coffee icon" }));
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(home).toHaveTextContent("HomeDefault icon");
    await user.click(saveIcons());
    await waitFor(() => expect(sentIcons()).toEqual([{ navigationIcons: {} }]));
  });

  it("follows the workspace socket for the slots not changed here, so saving never puts back what another tab chose", async () => {
    const { user } = showPage();
    await loadedPickers();
    const dms = await picker("DMs");
    act(() => workspaceSays({ ...styled, navigationIcons: { dms: "coffee", home: "telescope" } }));
    expect(dms).toHaveTextContent("DMsCoffee");

    const home = await picker("Home");
    await user.click(home);
    await user.click(await within(dialog()).findByRole("button", { name: "Use Coffee icon" }));
    await user.click(within(dialog()).getByRole("button", { name: "Use icon" }));
    act(() => workspaceSays({ ...styled, navigationIcons: { dms: "telescope" } }));
    expect(dms).toHaveTextContent("DMsTelescope");
    expect(home).toHaveTextContent("HomeCoffee");

    await user.click(saveIcons());
    await waitFor(() => expect(sentIcons()).toEqual([{ navigationIcons: { home: "coffee" } }]));
  });

  it("can't be changed while Save changes saves them", async () => {
    let answer = (_: Response) => {};
    serve({ iconsSaved: () => new Promise((resolve) => (answer = resolve)) });
    const { user } = showPage();
    await loadedPickers();
    const home = await picker("Home");
    await user.click(saveIcons());
    for (const button of pickers()) expect(button).toBeDisabled();
    expect(saveIcons()).toBeDisabled();
    await act(async () => answer(Response.json({ account: styled })));
    expect(home).toBeEnabled();
    expect(saveIcons()).toBeEnabled();
  });

  it("says why a save failed, keeping the icons chosen", async () => {
    serve({ iconsSaved: () => Response.json({ error: "Only administrators can change the workspace" }, { status: 403 }) });
    const { answered, onFailed, user } = showPage();
    await loadedPickers();
    const home = await picker("Home");
    await user.click(home);
    await user.click(await within(dialog()).findByRole("button", { name: "Use Coffee icon" }));
    await user.click(within(dialog()).getByRole("button", { name: "Use icon" }));
    await user.click(saveIcons());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 403, message: "Only administrators can change the workspace" })));
    expect(home).toHaveTextContent("HomeCoffee");
    expect(saveIcons()).toBeEnabled();
    expect(answered).not.toHaveBeenCalled();
  });
});

describe("Translation buttons", () => {
  it("has a translation button for the CSS once an administrator shows them", () => {
    showPage({ ...styled, hideTranslationButtons: false });
    expect(screen.getByText("Translate")).toBeInTheDocument();
  });

  it("has none while they're hidden", () => {
    showPage();
    expect(screen.queryByText("Translate")).not.toBeInTheDocument();
  });
});
