import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The keyboard of a device whose `navigator.platform` is `platform`. */
const on = (platform: string) => vi.stubGlobal("navigator", { ...navigator, platform });

/** Back and Forward, with the router as a page first shown at `path` has it, in an entry it didn't add. */
async function shownAt(path: string) {
  history.replaceState(null, "", path);
  vi.resetModules();
  const [{ HistoryButtons }, { navigate }] = await Promise.all([import("./history-buttons"), import("@/hooks/use-route")]);
  const { unmount } = render(<HistoryButtons />);
  return { navigate, unmount, back: screen.getByRole("button", { name: "Back" }), forward: screen.getByRole("button", { name: "Forward" }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("Back and Forward", () => {
  it("go back and on through the pages the app has shown, each off while it has none to go to", async () => {
    const user = userEvent.setup();
    const { navigate, back, forward } = await shownAt("/rooms/general");
    expect(back).toBeDisabled();
    expect(forward).toBeDisabled();

    act(() => navigate("/rooms/random"));
    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();

    await user.click(back);
    await waitFor(() => expect(location.pathname).toBe("/rooms/general"));
    expect(back).toBeDisabled();
    expect(forward).toBeEnabled();

    await user.click(forward);
    await waitFor(() => expect(location.pathname).toBe("/rooms/random"));
    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();
  });

  it("names the keys the browser takes for each, as a Mac's keyboard or another's has them", async () => {
    on("MacIntel");
    const mac = await shownAt("/rooms/general");
    expect(mac.back).toHaveAttribute("aria-keyshortcuts", "Meta+[");
    expect(mac.forward).toHaveAttribute("aria-keyshortcuts", "Meta+]");
    mac.unmount();

    on("Win32");
    const windows = await shownAt("/rooms/general");
    expect(windows.back).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowLeft");
    expect(windows.forward).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowRight");
  });

  it("draws Iconoir's arrows, hidden from screen readers, which hear each button's name", async () => {
    const { back, forward } = await shownAt("/rooms/general");
    expect(back.querySelector("svg")).toHaveClass("iconoir-arrow-left");
    expect(forward.querySelector("svg")).toHaveClass("iconoir-arrow-right");
    expect(back.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
