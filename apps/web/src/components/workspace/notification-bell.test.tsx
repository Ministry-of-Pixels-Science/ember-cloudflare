import type { Account, Room } from "@ember/protocol";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountContext } from "@/hooks/use-account";
import { PushProvider } from "@/hooks/use-push";
import { isPushOn, savePushAgain, subscribeToPushEnding, turnOnPush, type PushNotice } from "@/lib/push";
import { CHROME_MAC } from "@/test-platforms";
import { FEEDBACK_MS, INVOLVEMENT_NOT_SAVED, NotificationBell } from "./notification-bell";

vi.mock("@/lib/push", () => ({
  isPushOn: vi.fn(async () => false),
  savePushAgain: vi.fn(async () => {}),
  turnOnPush: vi.fn(async () => null),
  subscribeToPushEnding: vi.fn(() => () => {}),
}));

const KEY = "BP79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eDf3t3c29rZ2NfW1dTT0tHQz87NzMvKycjHxsXEw8LBwL8";
const general: Room = { id: "general", name: "general", kind: "open", icon: null };

const BLOCKED: PushNotice = { title: "Notifications are blocked", message: "Allow notifications for this site in your browser settings, then try again.", help: true };
const UNCONFIGURED: PushNotice = { title: "Notifications aren’t configured", message: "Ask your workspace administrator to configure Web Push on this server.", help: false };

/** The bell in general's header, on Chrome on a Mac. */
function renderBell() {
  render(
    <PushProvider vapidPublicKey={KEY} platform={CHROME_MAC}>
      <NotificationBell room={general} involvement="mentions" askForRoom={() => vi.fn()} onFailed={vi.fn()} />
    </PushProvider>,
  );
  return userEvent.setup();
}

const enableButton = () => screen.getByRole("button", { name: "Enable notifications" });
const levelBell = () => screen.queryByRole("checkbox", { name: "Notifying about @ mentions" });
const setup = () => screen.queryByRole("dialog", { name: "Notification setup" });

/** Settles turning notifications on when called, as `turnOnPush` would with `notice`. */
function turningOn() {
  let settle!: (notice: PushNotice | null) => void;
  vi.mocked(turnOnPush).mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
  return (notice: PushNotice | null) => act(() => settle(notice));
}

afterEach(() => vi.clearAllMocks());

describe("Turn on notifications", () => {
  it("offers to turn notifications on until this browser has them on, saving nothing", async () => {
    renderBell();
    expect(enableButton()).toHaveAttribute("title", "Enable notifications");
    expect(levelBell()).not.toBeInTheDocument();
    expect(isPushOn).toHaveBeenCalledWith(KEY);
    await act(async () => {});
    expect(savePushAgain).not.toHaveBeenCalled();
  });

  it("is your level's bell once they're on, without asking the server", async () => {
    vi.mocked(isPushOn).mockResolvedValueOnce(true);
    renderBell();
    expect(await screen.findByRole("checkbox", { name: "Notifying about @ mentions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable notifications" })).not.toBeInTheDocument();
    expect(turnOnPush).not.toHaveBeenCalled();
  });

  it("saves this browser's subscription again once it finds them on, so the server keeps it among your most recent", async () => {
    vi.mocked(isPushOn).mockResolvedValueOnce(true);
    renderBell();
    await screen.findByRole("checkbox", { name: "Notifying about @ mentions" });
    expect(savePushAgain).toHaveBeenCalledOnce();
  });

  it("offers to turn them on again once logging out has ended the subscription, should signing out then fail", async () => {
    vi.mocked(isPushOn).mockResolvedValueOnce(true);
    renderBell();
    expect(await screen.findByRole("checkbox", { name: "Notifying about @ mentions" })).toBeInTheDocument();
    const ended = vi.mocked(subscribeToPushEnding).mock.calls[0]![0];
    act(() => ended());
    expect(enableButton()).toBeInTheDocument();
    expect(levelBell()).not.toBeInTheDocument();
  });

  it("turns them on with a press, ignoring more while it's busy, then hands focus to your level's bell", async () => {
    const user = renderBell();
    const settle = turningOn();
    await user.click(enableButton());
    expect(turnOnPush).toHaveBeenCalledWith(KEY);
    expect(enableButton()).toHaveAttribute("aria-busy", "true");
    expect(enableButton()).toHaveAttribute("aria-disabled", "true");
    // It keeps focus, where a disabled button would lose it.
    expect(enableButton()).toHaveFocus();
    await user.click(enableButton());
    expect(turnOnPush).toHaveBeenCalledOnce();

    await settle(null);
    expect(levelBell()).toHaveFocus();
    expect(setup()).not.toBeInTheDocument();
  });

  it("leaves focus be when the press didn't focus it, as Safari's clicks don't", async () => {
    renderBell();
    fireEvent.click(enableButton());
    expect(await screen.findByRole("checkbox", { name: "Notifying about @ mentions" })).not.toHaveFocus();
  });

  it("says why they aren't on in the Notification setup dialog, with help for this browser, and Close at hand", async () => {
    vi.mocked(turnOnPush).mockResolvedValueOnce(BLOCKED);
    const user = renderBell();
    await user.click(enableButton());

    const dialog = await screen.findByRole("dialog", { name: "Notification setup" });
    expect(screen.getByRole("heading", { name: "Notifications are blocked" })).toBeInTheDocument();
    expect(within(dialog).getByRole("status")).toHaveTextContent("Allow notifications for this site in your browser settings, then try again.");
    expect(screen.getByText("Check your Chrome settings")).toBeVisible();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    expect(enableButton()).not.toHaveAttribute("aria-busy");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(dialog).not.toHaveAttribute("open");
  });

  it("gives no help where it wouldn't help, and says so again for each press", async () => {
    vi.mocked(turnOnPush).mockResolvedValue(UNCONFIGURED);
    const user = renderBell();
    await user.click(enableButton());
    expect(await screen.findByRole("heading", { name: "Notifications aren’t configured" })).toBeInTheDocument();
    expect(screen.getByText("Check your Chrome settings")).not.toBeVisible();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(enableButton());
    expect(await screen.findByRole("dialog", { name: "Notification setup" })).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });
});

describe("Notification levels", () => {
  /** The level's bell in general's header, with notifications on, whose saves `fetch` answers. */
  async function renderLevelBell(fetch: () => Promise<Response>) {
    vi.mocked(isPushOn).mockResolvedValueOnce(true);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetch);
    const onFailed = vi.fn();
    render(
      <PushProvider vapidPublicKey={KEY} platform={CHROME_MAC}>
        <NotificationBell room={general} involvement="mentions" askForRoom={() => vi.fn()} onFailed={onFailed} />
      </PushProvider>,
    );
    await act(async () => {});
    return { bell: screen.getByRole("checkbox"), onFailed };
  }

  /** What the bell shows under itself, which screen readers don't get, as its status says the same. */
  const tooltip = () => document.querySelector("[data-notification-tooltip]");
  const answered = (involvement: string) => async () => Response.json({ involvement });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("confirms the level a press saved under itself for 3.2 seconds, which its status tells screen readers", async () => {
    vi.useFakeTimers();
    const { bell } = await renderLevelBell(answered("everything"));
    expect(tooltip()).toBeEmptyDOMElement();
    expect(tooltip()).toHaveClass("invisible");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    // A pointer's press, which slides it in.
    fireEvent.click(bell, { detail: 1 });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(tooltip()).toHaveTextContent("Notifying about all messages");
    expect(tooltip()).toHaveAttribute("aria-hidden", "true");
    expect(tooltip()).toHaveClass("visible", "opacity-100", "transition-[opacity,translate,visibility]", "motion-reduce:transition-none", "bg-foreground", "text-background");
    expect(screen.getByRole("status")).toHaveTextContent("Notifying about all messages");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");

    act(() => vi.advanceTimersByTime(FEEDBACK_MS - 1));
    expect(tooltip()).toHaveClass("visible");
    act(() => vi.advanceTimersByTime(1));
    expect(tooltip()).toHaveClass("invisible", "opacity-0");
    // Its words go with it as it fades.
    expect(tooltip()).toHaveTextContent("Notifying about all messages");
  });

  it("shows at once when a key pressed it, keeping focus, until Escape", async () => {
    const { bell } = await renderLevelBell(answered("everything"));
    const user = userEvent.setup();
    bell.focus();
    await user.keyboard("{Enter}");
    expect(tooltip()).toHaveTextContent("Notifying about all messages");
    expect(tooltip()).toHaveClass("visible", "transition-none");
    expect(bell).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(tooltip()).toHaveClass("invisible");
    expect(bell).toHaveFocus();
  });

  it("says a press couldn't save under itself, rather than as the workspace's alert, afresh for screen readers each time", async () => {
    const { bell, onFailed } = await renderLevelBell(async () => Response.json({ error: "Something went wrong" }, { status: 500 }));
    const user = userEvent.setup();
    await user.click(bell);
    expect(tooltip()).toHaveTextContent(INVOLVEMENT_NOT_SAVED);
    expect(tooltip()).not.toHaveClass("transition-none");
    expect(screen.getByRole("status")).toHaveTextContent("Couldn’t update notifications. Try again.");
    expect(onFailed).not.toHaveBeenCalled();
    expect(bell).toHaveAccessibleName("Notifying about @ mentions");

    const said = screen.getByRole("status").firstElementChild;
    await user.click(bell);
    expect(screen.getByRole("status").firstElementChild).not.toBe(said);
    expect(screen.getByRole("status")).toHaveTextContent(INVOLVEMENT_NOT_SAVED);
  });

  it("leaves a session that's ended to the workspace, which signs in again", async () => {
    const { bell, onFailed } = await renderLevelBell(async () => Response.json({ error: "Sign in" }, { status: 401 }));
    await userEvent.click(bell);
    expect(onFailed).toHaveBeenCalledOnce();
    expect(tooltip()).toBeEmptyDOMElement();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

describe("Custom domain", () => {
  const MOVED: Account = { name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: "chat.example.com", joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true };
  /** The bell in general's header, at this address while Ember's custom domain is `customDomain`. */
  const bellWhile = (customDomain: string | null) => (
    <AccountContext value={{ ...MOVED, customDomain }}>
      <PushProvider vapidPublicKey={KEY} platform={CHROME_MAC}>
        <NotificationBell room={general} involvement="mentions" askForRoom={() => vi.fn()} onFailed={vi.fn()} />
      </PushProvider>
    </AccountContext>
  );

  it("doesn't save this browser's subscription again at an address Ember has moved from, where the one saved at its custom domain replaced it", async () => {
    vi.mocked(isPushOn).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    const { rerender } = render(bellWhile(MOVED.customDomain));
    expect(await screen.findByRole("checkbox", { name: "Notifying about @ mentions" })).toBeInTheDocument();
    expect(savePushAgain).not.toHaveBeenCalled();

    // Until Ember stops using the domain, which makes this address Ember's again.
    rerender(bellWhile(null));
    await vi.waitFor(() => expect(savePushAgain).toHaveBeenCalledOnce());
  });

  it("saves it again at Ember's custom domain", async () => {
    vi.mocked(isPushOn).mockResolvedValueOnce(true);
    render(bellWhile(location.host));
    await screen.findByRole("checkbox", { name: "Notifying about @ mentions" });
    expect(savePushAgain).toHaveBeenCalledOnce();
  });
});
