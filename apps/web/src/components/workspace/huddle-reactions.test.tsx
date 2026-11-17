import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { User } from "@ember/protocol";
import { parseHuddleClientFrame } from "@ember/protocol/huddles";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showHuddle, type JoinedHuddle } from "@/lib/huddle-store";
import { HuddleReactions } from "./huddle-reactions";
import { MoreTool, ReactTool } from "./huddle-tools";

// The emoji picker, without Emojibase's data, which isn't served here: its search, and two emoji to pick.
vi.mock("./emoji-panel", () => ({
  default: ({ onPick, autoFocus = true }: { onPick: (emoji: string) => void; autoFocus?: boolean }) => (
    <>
      <input aria-label="Search all emoji" autoFocus={autoFocus} />
      {["🎉", "👍"].map((emoji) => (
        <button key={emoji} type="button" onClick={() => onPick(emoji)}>
          {emoji}
        </button>
      ))}
    </>
  ),
}));

const ada: User = { id: "ada", name: "Ada Lovelace" };
const huddle = (changes: Partial<JoinedHuddle> = {}): JoinedHuddle => ({
  roomId: "general",
  connected: true,
  you: ada,
  people: [{ user: ada, muted: false, audio: true, video: false, screen: false }],
  muted: false,
  sticker: null,
  microphone: true,
  microphoneId: "",
  speakerId: "",
  camera: null,
  watched: new Map(),
  screen: null,
  screens: new Map(),
  open: true,
  thread: true,
  ...changes,
});

/** React and More as the huddle opened has them, with the panel they open, and a button that's neither's. */
function Tools({ joined }: { joined: JoinedHuddle }) {
  return (
    <>
      <button type="button">Elsewhere</button>
      <HuddleReactions huddle={joined} within={null}>
        {(react) => (
          <div>
            <ReactTool />
            <MoreTool onReact={react} />
          </div>
        )}
      </HuddleReactions>
    </>
  );
}

/** The huddle's reactions and stickers, closed, with what the huddle's controls were asked. */
function renderTools(joined: JoinedHuddle = huddle()) {
  const controls = { leave: vi.fn(), setMuted: vi.fn(), setCamera: vi.fn(), setScreen: vi.fn(), setOpen: vi.fn(), setThread: vi.fn(), setDevice: vi.fn(), setSmall: vi.fn(), switchCamera: vi.fn(), invite: vi.fn(() => true), setSticker: vi.fn(), react: vi.fn() };
  act(() => showHuddle(joined, controls));
  const user = userEvent.setup();
  const view = render(<Tools joined={joined} />);
  return { ...controls, user, ...view };
}

function touchScreen() {
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: media === "(pointer: coarse)", media, addEventListener() {}, removeEventListener() {} }));
}

/** Has the screen be too short for the panel's tabs over what they hold, and wide enough for them beside it, or not. Answers what makes it so from then on. */
function screenShort(short: boolean) {
  let matches = short;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    get matches() {
      return media === "(height < 31.25rem) and (width >= 30rem)" && matches;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return (now: boolean) =>
    act(() => {
      matches = now;
      listeners.forEach((listener) => listener());
    });
}

const react = () => screen.getByRole("button", { name: "React" });
const panel = () => screen.queryByRole("dialog", { name: "React" });
const tab = (name: string) => within(panel()!).getByRole("tab", { name });
const search = () => within(panel()!).findByLabelText("Search all emoji");
/** The stickers the panel lists, each with whether it's marked as the one that's shown. */
const stickers = () => within(panel()!).getAllByRole("listitem").map((item) => [item.textContent, within(item).getByRole("button").getAttribute("aria-pressed")]);

afterEach(() => {
  act(() => showHuddle(null));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("A huddle's reactions and stickers", () => {
  it("open from React on Reactions, with the cursor in the picker's search, and close at Escape, which leaves the focus on React", async () => {
    const { user } = renderTools();
    expect(panel()).not.toBeInTheDocument();
    await user.click(react());

    expect(within(panel()!).getByRole("tablist")).toHaveAccessibleName("Reactions and stickers");
    expect(within(panel()!).getAllByRole("tab").map((each) => [each.textContent, each.getAttribute("aria-selected"), each.tabIndex])).toEqual([
      ["Reactions", "true", 0],
      ["Stickers", "false", -1],
    ]);
    expect(within(panel()!).getByRole("tabpanel")).toHaveAccessibleName("Reactions");
    expect(tab("Reactions")).toHaveAttribute("aria-controls", within(panel()!).getByRole("tabpanel").id);
    expect(await search()).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(panel()).not.toBeInTheDocument();
    await waitFor(() => expect(react()).toHaveFocus());
  });

  it("leave the picker's search alone on a touch screen, where the cursor in it would bring the keyboard up over the huddle", async () => {
    touchScreen();
    const { user } = renderTools();
    await user.click(react());
    expect(await search()).not.toHaveFocus();
    expect(panel()).toContainElement(document.activeElement as HTMLElement);
  });

  it("send the emoji picked as a reaction and close, as Slack's do, which leaves the focus on what opened them", async () => {
    const { react: reacted, setSticker, user } = renderTools();
    await user.click(react());
    await search();
    await user.click(within(panel()!).getByRole("button", { name: "🎉" }));
    expect(reacted.mock.calls).toEqual([["🎉"]]);
    expect(panel()).not.toBeInTheDocument();
    expect(setSticker).not.toHaveBeenCalled();
    await waitFor(() => expect(react()).toHaveFocus());

    // From More's menu, as on the narrowest phone, it's More that has the focus back.
    const more = screen.getByRole("button", { name: "More" });
    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "React" }));
    await waitFor(() => expect(panel()).toBeInTheDocument());
    await search();
    await user.click(within(panel()!).getByRole("button", { name: "👍" }));
    expect(reacted.mock.calls).toEqual([["🎉"], ["👍"]]);
    expect(panel()).not.toBeInTheDocument();
    await waitFor(() => expect(more).toHaveFocus());
  });

  it("close as an emoji's picked on a touch screen too, where the same again is from React again", async () => {
    touchScreen();
    const { react: reacted, user } = renderTools();
    await user.click(react());
    await search();
    await user.click(within(panel()!).getByRole("button", { name: "🎉" }));
    expect(panel()).not.toBeInTheDocument();
    await waitFor(() => expect(react()).toHaveFocus());

    await user.click(react());
    await search();
    await user.click(within(panel()!).getByRole("button", { name: "🎉" }));
    expect(reacted.mock.calls).toEqual([["🎉"], ["🎉"]]);
    expect(panel()).not.toBeInTheDocument();
  });

  it("list the stickers there are on their other tab, the one that's shown marked, and close as one's chosen, to show it or to take it off", async () => {
    const { setSticker, user, rerender } = renderTools();
    await user.click(react());
    await user.click(tab("Stickers"));
    expect(tab("Stickers")).toHaveAttribute("aria-selected", "true");
    expect(within(panel()!).getByRole("tabpanel")).toHaveAccessibleName("Stickers");
    expect(stickers()).toEqual([
      ["✋Raise hand", "false"],
      ["☕Be right back", "false"],
      ["👍Yes", "false"],
      ["👎No", "false"],
      ["✅Done", "false"],
    ]);

    await user.click(within(panel()!).getByRole("button", { name: "Be right back" }));
    expect(setSticker).toHaveBeenCalledExactlyOnceWith("brb");
    expect(panel()).not.toBeInTheDocument();
    await waitFor(() => expect(react()).toHaveFocus());

    // The one that's shown is marked, and choosing it takes it off.
    rerender(<Tools joined={huddle({ sticker: "brb" })} />);
    await user.click(react());
    await user.click(tab("Stickers"));
    expect(stickers().map(([, pressed]) => pressed)).toEqual(["false", "true", "false", "false", "false"]);
    await user.click(within(panel()!).getByRole("button", { name: "Be right back" }));
    expect(setSticker).toHaveBeenLastCalledWith(null);
    expect(panel()).not.toBeInTheDocument();

    // And another is shown in its place.
    await user.click(react());
    await user.click(tab("Stickers"));
    await user.click(within(panel()!).getByRole("button", { name: "Raise hand" }));
    expect(setSticker).toHaveBeenLastCalledWith("hand");
  });

  it("keep the picker under Stickers, unseen, as it was left, so that the panel is as large on either tab", async () => {
    const { user } = renderTools();
    await user.click(react());
    await user.type(await search(), "party");
    const picker = (await search()).parentElement!;
    expect(picker).not.toHaveClass("invisible");

    await user.click(tab("Stickers"));
    expect(picker).toHaveClass("invisible");
    // The stickers are over it, in its place, and scroll where that's too short for them.
    const list = within(panel()!).getByRole("list");
    expect(list.parentElement).toBe(picker.parentElement);
    expect(list.parentElement).toHaveClass("relative");
    expect(list).toHaveClass("absolute", "inset-0", "overflow-y-auto");

    await user.click(tab("Reactions"));
    expect(picker).not.toHaveClass("invisible");
    expect(await search()).toHaveValue("party");
    expect(within(panel()!).queryByRole("list")).not.toBeInTheDocument();
    // The search takes the focus only as the panel opens.
    expect(tab("Reactions")).toHaveFocus();
  });

  it("move between their tabs by the arrow keys, Home and End, as a tablist's do", async () => {
    const { user } = renderTools();
    await user.click(react());
    await search();
    const selected = () =>
      within(panel()!)
        .getAllByRole("tab")
        .filter((each) => each.getAttribute("aria-selected") === "true")
        .map((each) => each.textContent);
    act(() => tab("Reactions").focus());

    for (const [key, name] of [
      ["{ArrowRight}", "Stickers"],
      ["{ArrowRight}", "Reactions"],
      ["{ArrowLeft}", "Stickers"],
      ["{Home}", "Reactions"],
      ["{End}", "Stickers"],
      ["{ArrowLeft}", "Reactions"],
      ["{ArrowDown}", "Stickers"],
      ["{ArrowDown}", "Reactions"],
      ["{ArrowUp}", "Stickers"],
      ["{ArrowUp}", "Reactions"],
    ] as const) {
      await user.keyboard(key);
      expect(selected()).toEqual([name]);
      expect(tab(name)).toHaveFocus();
      expect(tab(name).tabIndex).toBe(0);
    }
    // Any other key is the page's.
    await user.keyboard("{PageDown}");
    expect(selected()).toEqual(["Reactions"]);
  });

  it("are no taller than the room they're given, with their tabs over what they hold, or beside it on a screen too short for that", async () => {
    const short = screenShort(false);
    const { user } = renderTools();
    await user.click(react());
    await search();
    const [tabs, held] = [within(panel()!).getByRole("tablist"), within(panel()!).getByRole("tabpanel")];
    // The room is what Radix finds between the huddle's header and its buttons, and the picker gives way to fit it.
    expect(panel()).toHaveClass("flex", "max-h-(--radix-popover-content-available-height)", "overflow-hidden");
    expect(held).toHaveClass("flex", "min-h-0", "flex-col");
    expect((await search()).parentElement).toHaveClass("flex", "min-h-0", "flex-col");

    expect(panel()).toHaveClass("flex-col");
    expect(tabs).toHaveAttribute("aria-orientation", "horizontal");
    for (const beside of ["w-28", "flex-col", "self-start"]) expect(tabs).not.toHaveClass(beside);
    expect(held).toHaveClass("border-t");

    // As a phone turned on its side while they're open, and turned back.
    short(true);
    expect(panel()).toHaveClass("flex-row");
    expect(panel()).not.toHaveClass("flex-col");
    expect(tabs).toHaveAttribute("aria-orientation", "vertical");
    // As wide whichever tab is chosen, which has heavier letters.
    expect(tabs).toHaveClass("w-28", "flex-col", "self-start");
    expect(held).toHaveClass("border-s");
    expect(held).not.toHaveClass("border-t");

    short(false);
    expect(panel()).toHaveClass("flex-col");
    expect(tabs).toHaveAttribute("aria-orientation", "horizontal");
  });

  it("open on Reactions each time, whichever tab they closed on", async () => {
    const { user } = renderTools();
    await user.click(react());
    await user.click(tab("Stickers"));
    await user.keyboard("{Escape}");
    await user.click(react());
    expect(tab("Reactions")).toHaveAttribute("aria-selected", "true");
    expect(await search()).toHaveValue("");
  });

  it("close at React again, and at a click outside them, which leaves the focus where it put it", async () => {
    const { user } = renderTools();
    await user.click(react());
    expect(react()).toHaveAttribute("aria-expanded", "true");
    await user.click(react());
    expect(panel()).not.toBeInTheDocument();
    expect(react()).toHaveAttribute("aria-expanded", "false");

    await user.click(react());
    await search();
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(panel()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();

    // Opened from More's menu too, which has the focus back only from a panel that closes by itself.
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: "React" }));
    await search();
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(panel()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  });

  it("open from React in More's menu, where React has no button, once the menu has shut, and have the focus back on More as they close", async () => {
    const { user } = renderTools();
    const more = screen.getByRole("button", { name: "More" });
    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "React" }));
    await waitFor(() => expect(panel()).toBeInTheDocument());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(await search()).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(panel()).not.toBeInTheDocument();
    await waitFor(() => expect(more).toHaveFocus());

    // Opened from React after that, it's React that has the focus back.
    await user.click(react());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(react()).toHaveFocus());
  });
});

describe("The emoji a huddle's picker offers", () => {
  it("are each one the room takes as a reaction, in every skin tone", () => {
    interface Emoji {
      emoji: string;
      skins?: Emoji[];
    }
    const data = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("emojibase-data/en/data.json"), "utf8")) as Emoji[];
    const offered = data.flatMap(({ emoji, skins = [] }) => [emoji, ...skins.map((skin) => skin.emoji)]);
    expect(offered.length).toBeGreaterThan(3_000);
    expect(offered.filter((emoji) => parseHuddleClientFrame(JSON.stringify({ type: "huddle.react", emoji })) === null)).toEqual([]);
  });
});
