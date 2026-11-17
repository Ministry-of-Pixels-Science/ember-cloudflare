import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EmojiPanel from "./emoji-panel";

afterEach(() => void vi.unstubAllGlobals());

describe("The emoji picker", () => {
  it("has the cursor in its search as it shows, to type in at once, unless it's told to leave it where it is", () => {
    // Emojibase's data isn't served here, and the search is there before it comes.
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { unmount } = render(<EmojiPanel onPick={() => {}} />);
    expect(screen.getByLabelText("Search all emoji")).toHaveFocus();
    unmount();

    render(<EmojiPanel onPick={() => {}} autoFocus={false} />);
    expect(screen.getByLabelText("Search all emoji")).not.toHaveFocus();
  });
});
