import type { DirectoryUser, LiveHuddle, User } from "@ember/protocol";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleContext } from "@/hooks/use-directory";
import { showHuddle, type JoinedHuddle } from "@/lib/huddle-store";
import { HuddleButton, HuddlesContext, joinsNoHuddle, useJoinsNoHuddle } from "./huddle-button";

const huddleOf = (...userIds: string[]): LiveHuddle => ({ startedAt: "2026-11-10T09:00:00.000Z", userIds });
/** The huddle this tab is in, in room `roomId`. */
const joined = (roomId: string): JoinedHuddle => ({ roomId, connected: true, you: { id: "ada", name: "Ada" }, people: [], muted: false, microphone: true, microphoneId: "", speakerId: "", camera: null, watched: new Map(), screen: null, screens: new Map(), open: false });
/** What the tab's huddle is asked to do, `leave` among it. */
const controlsWith = (leave = vi.fn()) => ({ leave, setMuted: vi.fn(), setCamera: vi.fn(), setScreen: vi.fn(), setOpen: vi.fn(), setDevice: vi.fn(), setSmall: vi.fn(), switchCamera: vi.fn() });

/** The keyboard of a device whose `navigator.platform` is `platform`. */
const on = (platform: string) => vi.stubGlobal("navigator", { ...navigator, platform, clipboard: navigator.clipboard });

function renderButton(live: Record<string, LiveHuddle> = {}) {
  const preview = vi.fn();
  const user = userEvent.setup();
  render(
    <HuddlesContext value={{ live, preview }}>
      <HuddleButton roomId="general" />
    </HuddlesContext>,
  );
  return { preview, user };
}

afterEach(() => {
  act(() => showHuddle(null));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("The huddle button", () => {
  it("starts the room's huddle from its preview while nobody is in one", async () => {
    const { preview, user } = renderButton({ other: huddleOf("grace") });
    await user.click(screen.getByRole("button", { name: "Start huddle" }));
    expect(preview).toHaveBeenCalledExactlyOnceWith("general");
  });

  it("joins the one going on, outlined in green with how many are in it", async () => {
    const { preview, user } = renderButton({ general: huddleOf("grace", "linus", "alan") });
    const join = screen.getByRole("button", { name: "Join huddle, 3 in it" });
    expect(join.parentElement).toHaveClass("text-positive", "ring-positive");
    await user.click(join);
    expect(preview).toHaveBeenCalledExactlyOnceWith("general");
  });

  it("leaves the huddle this tab is in, green all over, without counting who's in it", async () => {
    const leave = vi.fn();
    const { preview, user } = renderButton({ general: huddleOf("ada", "grace") });
    act(() => showHuddle(joined("general"), controlsWith(leave)));
    const button = screen.getByRole("button", { name: "Leave huddle" });
    expect(button.parentElement).toHaveClass("bg-positive", "text-white");
    expect(button.parentElement).not.toHaveClass("ring-positive");
    await user.click(button);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(preview).not.toHaveBeenCalled();
  });

  it("starts or joins this room's while the tab is in another room's huddle", () => {
    renderButton();
    act(() => showHuddle(joined("other"), controlsWith()));
    expect(screen.getByRole("button", { name: "Start huddle" })).toBeInTheDocument();
  });

  it("follows the huddle as people join and leave it, and as the tab does", () => {
    const { rerender } = render(
      <HuddlesContext value={{ live: {}, preview: vi.fn() }}>
        <HuddleButton roomId="general" />
      </HuddlesContext>,
    );
    rerender(
      <HuddlesContext value={{ live: { general: huddleOf("grace") }, preview: vi.fn() }}>
        <HuddleButton roomId="general" />
      </HuddlesContext>,
    );
    expect(screen.getByRole("button", { name: "Join huddle, 1 in it" })).toBeInTheDocument();
    act(() => showHuddle(joined("general"), controlsWith()));
    expect(screen.getByRole("button", { name: "Leave huddle" })).toBeInTheDocument();
    act(() => showHuddle(null));
    expect(screen.getByRole("button", { name: "Join huddle, 1 in it" })).toBeInTheDocument();
  });

  it("names what it does and the keys that do it in a tooltip, and the keys for screen readers", async () => {
    on("MacIntel");
    const { user } = renderButton();
    const start = screen.getByRole("button", { name: "Start huddle" });
    expect(start).toHaveAttribute("aria-keyshortcuts", "Meta+Alt+Shift+H");
    await user.hover(start);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Start huddle⌘⌥⇧H");
    await user.unhover(start);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("names the keys as a keyboard that isn't Apple's has them", async () => {
    on("Win32");
    const { user } = renderButton({ general: huddleOf("grace") });
    const join = screen.getByRole("button", { name: "Join huddle, 1 in it" });
    expect(join).toHaveAttribute("aria-keyshortcuts", "Control+Alt+Shift+H");
    await user.hover(join);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Join huddleCtrlAltShiftH");
  });

  it("shows no tooltip as focus reaches it, as when the preview gives focus back", async () => {
    const { user } = renderButton();
    await user.tab();
    expect(screen.getByRole("button", { name: "Start huddle" })).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});

describe("Copy huddle link", () => {
  it("copies the room's huddle's address from the arrow's menu, and turns green", async () => {
    const { user } = renderButton();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const options = screen.getByRole("button", { name: "Huddle options" });
    expect(options).toHaveAttribute("aria-expanded", "false");
    await user.click(options);
    expect(options).toHaveAttribute("aria-expanded", "true");
    const copy = screen.getByRole("button", { name: "Copy huddle link" });
    expect(screen.getByRole("dialog", { name: "Huddle options" })).toContainElement(copy);
    await user.click(copy);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(`${location.origin}/rooms/general/huddle`);
    expect(copy).toHaveClass("text-positive");
  });

  it("shuts its menu on Escape, giving focus back to the arrow", async () => {
    const { user } = renderButton();
    const options = screen.getByRole("button", { name: "Huddle options" });
    await user.click(options);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Huddle options" })).not.toBeInTheDocument();
    expect(options).toHaveFocus();
  });

  it("leaves its row as it was when the clipboard refuses", async () => {
    const { user } = renderButton();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("refused"));
    await user.click(screen.getByRole("button", { name: "Huddle options" }));
    const copy = screen.getByRole("button", { name: "Copy huddle link" });
    await user.click(copy);
    expect(copy).not.toHaveClass("text-positive");
  });
});

describe("Who joins no huddle", () => {
  const grace: User = { id: "grace", name: "Grace" };
  /** Grace as the people directory lists her, a member who can sign in, but for `changes`. */
  const listed = (changes: Partial<DirectoryUser> = {}): DirectoryUser => ({ ...grace, bio: null, role: "member", status: "active", avatarUrl: "/users/grace/avatar", ...changes });

  it("is a bot, an AI agent among them, and @ember before the directory lists anyone", () => {
    expect(joinsNoHuddle(grace, listed({ role: "bot" }))).toBe(true);
    expect(joinsNoHuddle(grace, listed({ role: "bot", agent: true }))).toBe(true);
    expect(joinsNoHuddle({ id: "ember", name: "Ember" }, undefined)).toBe(true);
  });

  it("is whoever can no longer sign in: someone deactivated, banned or suspended", () => {
    for (const status of ["deactivated", "banned", "suspended"] as const) expect(joinsNoHuddle(grace, listed({ status })), status).toBe(true);
  });

  it("is nobody else, as the directory lists them or before it does", () => {
    expect(joinsNoHuddle(grace, listed())).toBe(false);
    expect(joinsNoHuddle(grace, listed({ role: "administrator" }))).toBe(false);
    expect(joinsNoHuddle(grace, undefined)).toBe(false);
  });

  it("goes by the people directory as it lists them now", () => {
    const directory = (people: DirectoryUser[]) => ({ children }: { children: ReactNode }) => <PeopleContext value={new Map(people.map((person) => [person.id, person]))}>{children}</PeopleContext>;
    expect(renderHook(useJoinsNoHuddle, { wrapper: directory([listed()]) }).result.current(grace)).toBe(false);
    expect(renderHook(useJoinsNoHuddle, { wrapper: directory([listed({ status: "banned" })]) }).result.current(grace)).toBe(true);
  });
});
