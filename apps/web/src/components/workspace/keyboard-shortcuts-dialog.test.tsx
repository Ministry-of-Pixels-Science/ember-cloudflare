import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyboardShortcutsDialog } from "./keyboard-shortcuts-dialog";

/** The keyboard of a device whose `navigator.platform` is `platform`. */
const on = (platform: string) => vi.stubGlobal("navigator", { ...navigator, platform });

/** The dialog, open, with a button that opens it again once it's closed. */
function Shortcuts() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Shortcuts
      </button>
      <KeyboardShortcutsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/** The keys a row of the dialog shows, by the row's action. */
const keysOf = (action: string) =>
  within(screen.getByText(action).parentElement!)
    .getAllByText((_, element) => element?.tagName === "KBD")
    .map((key) => key.textContent);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Keyboard shortcuts dialog", () => {
  it("lists the shortcuts a group at a time, with Cmd and Option on a Mac", () => {
    on("MacIntel");
    render(<Shortcuts />);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["Navigate", "Huddles", "Write a message", "Format text", "Edit a message"]);
    expect(keysOf("Search")).toEqual(["⌘", "F"]);
    expect(keysOf("Move a starred room up or down")).toEqual(["⌥", "↑ ↓"]);
    expect(keysOf("Start, join or leave a huddle")).toEqual(["⌘", "⌥", "⇧", "H"]);
    expect(keysOf("Edit your last message, with nothing written")).toEqual(["↑"]);
    expect(keysOf("Send, on a touch screen too")).toEqual(["⌘", "Enter"]);
    expect(keysOf("Strikethrough")).toEqual(["⌘", "⇧", "X"]);
    expect(keysOf("Code block")).toEqual(["⌘", "⌥", "⇧", "C"]);
  });

  it("shows Ctrl and Alt on other keyboards", () => {
    on("Win32");
    render(<Shortcuts />);
    expect(keysOf("Search")).toEqual(["Ctrl", "F"]);
    expect(keysOf("Move a starred room up or down")).toEqual(["Alt", "↑ ↓"]);
    expect(keysOf("Send")).toEqual(["Enter"]);
    expect(keysOf("Send, on a touch screen too")).toEqual(["Ctrl", "Enter"]);
    expect(keysOf("Code block")).toEqual(["Ctrl", "Alt", "Shift", "C"]);
    expect(keysOf("Save")).toEqual(["Ctrl", "Enter"]);
  });

  it("closes on Escape or its ×", async () => {
    const user = userEvent.setup();
    render(<Shortcuts />);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Shortcuts" }));
    await user.click(within(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Shortcuts" })).toHaveFocus());
  });
});
