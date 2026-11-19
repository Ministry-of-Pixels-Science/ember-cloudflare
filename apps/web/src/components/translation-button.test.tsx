import { TRANSLATIONS, type Account } from "@ember/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountContext } from "@/hooks/use-account";
import { TranslationButton } from "./translation-button";

/** A workspace whose administrator has shown translation buttons. */
const shown: Account = { name: "Ember", tagline: "", hideTranslationButtons: false, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true };

/** The workspace name's button, after a field, in `account`. */
function showButton(account = shown) {
  render(
    <AccountContext value={account}>
      <input aria-label="Workspace name" />
      <TranslationButton translations="account_name" />
    </AccountContext>,
  );
  return userEvent.setup();
}

const globe = () => screen.getByText("Translate").closest("summary")!;
const isOpen = () => globe().closest("details")!.open;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Translation buttons", () => {
  it("is left out while the workspace hides translation buttons, as it does until an administrator shows them", () => {
    showButton({ ...shown, hideTranslationButtons: true });
    expect(screen.queryByText("Translate")).not.toBeInTheDocument();
  });

  it("lists what its field asks in seven languages, each after its country's flag, under a globe", async () => {
    const user = showButton();
    expect(isOpen()).toBe(false);
    await user.click(globe());
    await waitFor(() => expect(isOpen()).toBe(true));
    const list = globe().closest("details")!.querySelector("dl")!;
    expect([...list.querySelectorAll("dt")].map((flag) => flag.textContent)).toEqual(["🇺🇸", "🇪🇸", "🇫🇷", "🇮🇳", "🇩🇪", "🇧🇷", "🇯🇵"]);
    expect([...list.querySelectorAll("dd")].map((text) => text.textContent)).toEqual(TRANSLATIONS.account_name.map(([, text]) => text));
    expect(list).toHaveTextContent("Name this account");
  });

  it("can't be reached with Tab", async () => {
    const user = showButton();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveFocus();
    await user.tab();
    expect(globe()).not.toHaveFocus();
    expect(globe()).toHaveAttribute("tabindex", "-1");
  });

  it("closes with Escape, or a click anywhere but in it", async () => {
    const user = showButton();
    await user.click(globe());
    await waitFor(() => expect(isOpen()).toBe(true));
    await user.keyboard("{Escape}");
    expect(isOpen()).toBe(false);

    await user.click(globe());
    await waitFor(() => expect(isOpen()).toBe(true));
    await user.click(screen.getByText("Name this account"));
    expect(isOpen()).toBe(true);
    await user.click(screen.getByRole("textbox", { name: "Workspace name" }));
    expect(isOpen()).toBe(false);
  });

  it("keeps its list to the room on its right on the screen, measured as it opens, though a phone widens the window to fit it", async () => {
    // A 320px phone whose window has grown to fit a list too wide for it, as a phone's does.
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(320);
    vi.stubGlobal("innerWidth", 401);
    const user = showButton();
    await user.click(globe());
    await waitFor(() => expect(isOpen()).toBe(true));
    const menu = globe().nextElementSibling as HTMLElement;
    expect(menu.style.getPropertyValue("--max-width")).toBe(`${320 - menu.getBoundingClientRect().left}px`);
  });

  it("opens leftward where there's more room, keeping to what's seen of the part of the page it's in", async () => {
    // A globe 240px to 276px across a 320px phone, in messages that show 20px to 300px of it.
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(320);
    render(
      <AccountContext value={shown}>
        <div role="log" style={{ overflowX: "hidden" }}>
          <TranslationButton translations="account_name" />
        </div>
      </AccountContext>,
    );
    const messages = screen.getByRole("log");
    vi.spyOn(messages, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 20, width: 280 }));
    vi.spyOn(messages, "clientWidth", "get").mockReturnValue(280);
    vi.spyOn(globe().closest("details")!, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 240, width: 36 }));
    const menu = globe().nextElementSibling as HTMLElement;
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: 200 }));
    await userEvent.setup().click(globe());
    await waitFor(() => expect(isOpen()).toBe(true));
    expect(menu.style.getPropertyValue("right")).toBe("0px");
    expect(menu.style.getPropertyValue("--max-width")).toBe(`${276 - 20}px`);
  });
});
