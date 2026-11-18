import { TRANSLATIONS } from "@ember/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountContext } from "@/hooks/use-account";
import { InvitationCard } from "./invitation-card";

const JOIN_CODE = "aB3d-Ef5h-iJ7k";
const LINK = `http://localhost:3000/join/${JOIN_CODE}`;
/** The link as padded URL-safe base64. */
const QR_CODE = "/qr_code/aHR0cDovL2xvY2FsaG9zdDozMDAwL2pvaW4vYUIzZC1FZjVoLWlKN2s=";
/** What dismissing the card does in the tests that don't press its ×: nothing. */
const dismiss = async () => {};

/** Gives the browser `name`, as some browsers have it, until the test ends. */
function stubNavigator(name: "clipboard" | "canShare" | "share", value: unknown) {
  Object.defineProperty(navigator, name, { value, configurable: true });
  stubbed.push(name);
}
const stubbed: string[] = [];

afterEach(() => {
  for (const name of stubbed.splice(0)) delete (navigator as unknown as Record<string, unknown>)[name];
});

describe("Welcome and invite card", () => {
  it("welcomes people with the workspace's join link, labelled for screen readers", () => {
    render(<InvitationCard joinCode={JOIN_CODE} onDismiss={dismiss} />);
    expect(screen.getByRole("img", { name: "Ember" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Welcome to Ember" })).toBeInTheDocument();
    expect(screen.getByText("To invite people to chat, share the join link below.")).toBeInTheDocument();
    const link = screen.getByRole("textbox", { name: "Share to invite more people" });
    expect(link).toHaveValue(LINK);
    expect(link).toHaveAttribute("readonly");
  });

  it("can't regenerate the link, as workspace settings can", () => {
    render(<InvitationCard joinCode={JOIN_CODE} onDismiss={dismiss} />);
    expect(screen.getByRole("button", { name: "Copy join link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate join link" })).not.toBeInTheDocument();
  });
});

describe("Welcome card for administrators, until they dismiss it", () => {
  it("ends its heading with an × that dismisses it, 36px, or 44px for fingers", async () => {
    const onDismiss = vi.fn(async () => {});
    render(<InvitationCard joinCode={JOIN_CODE} onDismiss={onDismiss} />);
    const button = screen.getByRole("button", { name: "Dismiss welcome card" });
    expect(button.parentElement!.lastElementChild).toBe(button);
    expect(button.parentElement).toContainElement(screen.getByRole("heading", { name: "Welcome to Ember" }));
    expect(button).toHaveClass("size-9", "touch:size-11", "ml-auto");

    await userEvent.click(button);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("is dimmed while the dismissal saves, keeping the keyboard's focus and ignoring presses, until it's settled", async () => {
    let settle!: () => void;
    const onDismiss = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
    render(<InvitationCard joinCode={JOIN_CODE} onDismiss={onDismiss} />);
    const button = screen.getByRole("button", { name: "Dismiss welcome card" });
    const user = userEvent.setup();

    button.focus();
    await user.keyboard(" ");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveClass("aria-disabled:opacity-50", "aria-disabled:pointer-events-none");
    await user.keyboard(" ");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(button).toHaveFocus();

    // One that failed leaves the card, for its × to be pressed again.
    await act(async () => settle());
    expect(button).not.toHaveAttribute("aria-disabled");
    await user.keyboard(" ");
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});

describe("Join link", () => {
  it("copies the link, and plays its success each time", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator("clipboard", { writeText });
    render(<InvitationCard joinCode={JOIN_CODE} onDismiss={dismiss} />);
    const copy = screen.getByRole("button", { name: "Copy join link" });

    await userEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(LINK);
    await waitFor(() => expect(copy).toHaveClass("motion-safe:animate-success"));

    // The class comes off while the link is copied again, which starts the animation over.
    let finishCopying!: () => void;
    writeText.mockReturnValueOnce(new Promise<void>((resolve) => (finishCopying = resolve)));
    await userEvent.click(copy);
    expect(copy).not.toHaveClass("motion-safe:animate-success");
    finishCopying();
    await waitFor(() => expect(copy).toHaveClass("motion-safe:animate-success"));
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("leaves the button alone when the clipboard refuses", async () => {
    stubNavigator("clipboard", { writeText: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")) });
    render(<InvitationCard joinCode={JOIN_CODE} onDismiss={dismiss} />);
    const copy = screen.getByRole("button", { name: "Copy join link" });
    await userEvent.click(copy);
    expect(copy).not.toHaveClass("motion-safe:animate-success");
  });

  it("offers sharing only where the browser can share", async () => {
    render(<InvitationCard joinCode={JOIN_CODE} onDismiss={dismiss} />);
    expect(screen.queryByRole("button", { name: "Share join link" })).not.toBeInTheDocument();
  });

  it("shares the invitation with the link", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("Closed", "AbortError"));
    stubNavigator("canShare", () => true);
    stubNavigator("share", share);
    render(<InvitationCard joinCode={JOIN_CODE} onDismiss={dismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "Share join link" }));
    expect(share).toHaveBeenCalledWith({ title: "Link to join Ember", text: "Hit this link to join me in Ember and start chatting.", url: LINK });
  });
});

describe("QR codes for links", () => {
  it("opens the join link's QR code in the image viewer", async () => {
    render(<InvitationCard joinCode={JOIN_CODE} onDismiss={dismiss} />);
    const link = screen.getByRole("link", { name: "Show join link QR code" });
    expect(link).toHaveAttribute("href", QR_CODE);

    await userEvent.click(link);
    const viewer = screen.getByRole("dialog", { name: "Image Viewer (Press escape to close)" });
    expect(viewer).toHaveAttribute("open");
    expect(viewer.querySelector(`img[src="${QR_CODE}"]`)).toBeInTheDocument();
    expect(within(viewer).getByRole("link", { name: "Download file" })).toHaveAttribute("download", "QR code.svg");
  });

  it("puts it before Copy and Share", () => {
    render(<InvitationCard joinCode={JOIN_CODE} onDismiss={dismiss} />);
    const show = screen.getByRole("link", { name: "Show join link QR code" });
    expect(show.previousElementSibling).toBeNull();
    expect(show.nextElementSibling).toBe(screen.getByRole("button", { name: "Copy join link" }));
  });
});

describe("Translation buttons", () => {
  it("has a translation button for its invitation once an administrator shows them", () => {
    render(
      <AccountContext value={{ name: "Ember", tagline: "", hideTranslationButtons: false, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true }}>
        <InvitationCard joinCode={JOIN_CODE} onDismiss={dismiss} />
      </AccountContext>,
    );
    expect(screen.getByText("Translate")).toBeInTheDocument();
    expect(screen.getByText(TRANSLATIONS.invite_message[0][1])).toBeInTheDocument();
  });
});

describe("Workspace logo", () => {
  it("shows the workspace's logo in place of Ember's flame", () => {
    const logo = "/account/logo?v=20261017120000";
    render(
      <AccountContext value={{ name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true }}>
        <InvitationCard joinCode={JOIN_CODE} onDismiss={dismiss} />
      </AccountContext>,
    );
    expect(screen.getByRole("img", { name: "Account logo" })).toHaveAttribute("src", logo);
    expect(screen.queryByRole("img", { name: "Ember" })).toBeNull();
  });
});
