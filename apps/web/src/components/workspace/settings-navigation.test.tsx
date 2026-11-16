import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeOf } from "@/hooks/use-route";
import { SettingsNavigation, settingsSectionOf, workspaceSectionOf, workspaceSectionPath, type SettingsSection } from "./settings-navigation";

/** The links the navigation shows, by their labels, top to bottom. */
const links = () => within(screen.getByRole("navigation", { name: "Community settings" })).getAllByRole("link");
const current = () => within(screen.getByRole("navigation", { name: "Community settings" })).getByRole("link", { current: "page" });
const sectionAt = (address: string) => {
  const [pathname, hash = ""] = address.split(/(?=#)/);
  return settingsSectionOf(routeOf(pathname!), hash);
};

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("Community settings page", () => {
  it("links everyone to workspace settings' three sections, by their fragments", () => {
    render(<SettingsNavigation section="community-settings" administrator={false} />);
    expect(links().map((link) => link.textContent)).toEqual(["General", "Rooms and permissions", "Membership"]);
    expect(links().map((link) => link.getAttribute("href"))).toEqual([
      "/account/edit#community-settings",
      "/account/edit#channel-settings",
      "/account/edit#membership-settings",
    ]);
    for (const link of links()) expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("marks the section shown", () => {
    const { rerender } = render(<SettingsNavigation section="community-settings" administrator />);
    expect(current()).toHaveTextContent("General");
    rerender(<SettingsNavigation section="membership-settings" administrator />);
    expect(current()).toHaveTextContent("Membership");
    expect(current()).toHaveClass("aria-[current=page]:bg-hover", "aria-[current=page]:font-semibold");
  });

  it("follows a link to another section in place, the page staying as it is", async () => {
    render(<SettingsNavigation section="community-settings" administrator={false} />);
    history.replaceState(null, "", "/account/edit");
    await userEvent.click(screen.getByRole("link", { name: "Membership" }));
    expect(location.pathname + location.hash).toBe("/account/edit#membership-settings");
  });

  it("brings the section shown into view in a strip too narrow for every link", () => {
    const scrolled = vi.fn();
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      scrolled(this.textContent);
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(375);
    const { rerender } = render(<SettingsNavigation section="community-settings" administrator />);
    rerender(<SettingsNavigation section="custom-styles" administrator />);
    expect(scrolled.mock.calls).toEqual([["General"], ["Custom styles"]]);
  });

  it("leaves a strip as it is while every link fits", () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    render(<SettingsNavigation section="membership-settings" administrator />);
    expect(scrolled).not.toHaveBeenCalled();
  });

  it("puts workspace settings, the room forms, the bot and agent pages and Custom styles in their sections, and no other page", () => {
    const sections: [string, SettingsSection | null][] = [
      ["/account/edit", "community-settings"],
      ["/account/edit#community-settings", "community-settings"],
      ["/account/edit#channel-settings", "channel-settings"],
      ["/account/edit#membership-settings", "membership-settings"],
      ["/account/edit#domain-settings", "domain-settings"],
      ["/account/edit#assistant-settings", "assistant-settings"],
      ["/account/edit#huddles-settings", "huddles-settings"],
      ["/account/edit#nowhere", "community-settings"],
      ["/rooms/opens/new", "channel-settings"],
      ["/rooms/closeds/new", "channel-settings"],
      ["/rooms/opens/general/edit", "channel-settings"],
      ["/rooms/closeds/secret/edit", "channel-settings"],
      ["/account/bots", "chat-bots"],
      ["/account/bots/new", "chat-bots"],
      ["/account/bots/b1/edit", "chat-bots"],
      ["/account/agents/new", "assistant-settings"],
      ["/account/agents/a1/edit", "assistant-settings"],
      ["/account/agents/ember/edit", "assistant-settings"],
      ["/account/apps/new", "assistant-settings"],
      ["/account/apps/p1/edit", "assistant-settings"],
      ["/account/apps/signed-in", "assistant-settings"],
      ["/account/custom_styles/edit", "custom-styles"],
      ["/rooms/general", null],
      ["/rooms/directs/d1/edit", null],
      ["/rooms/directs/new", null],
      ["/searches", null],
      ["/users/me/profile", null],
      ["/", null],
    ];
    expect(sections.map(([address]) => [address, sectionAt(address)])).toEqual(sections);
  });

  it("shows General unless the fragment names another of workspace settings' sections", () => {
    expect(workspaceSectionOf("")).toBe("community-settings");
    expect(workspaceSectionOf("#membership-settings")).toBe("membership-settings");
    expect(workspaceSectionOf("#domain-settings")).toBe("domain-settings");
    expect(workspaceSectionOf("#chat-bots")).toBe("community-settings");
    expect(workspaceSectionPath("channel-settings")).toBe("/account/edit#channel-settings");
  });
});

describe("Chat bots page", () => {
  it("links administrators to Chat bots, after workspace settings' sections, and members not at all", () => {
    const { rerender } = render(<SettingsNavigation section="chat-bots" administrator />);
    expect(screen.getByRole("link", { name: "Chat bots" })).toHaveAttribute("href", "/account/bots");
    expect(current()).toHaveTextContent("Chat bots");
    expect(links().map((link) => link.textContent)).toEqual(["General", "Rooms and permissions", "Membership", "Domain settings", "Chat bots", "AI assistant", "Huddles", "Custom styles"]);
    rerender(<SettingsNavigation section="community-settings" administrator={false} />);
    expect(screen.queryByRole("link", { name: "Chat bots" })).not.toBeInTheDocument();
  });
});

describe("Ember AI", () => {
  it("links administrators to AI assistant, after Chat bots, and members not at all", () => {
    const { rerender } = render(<SettingsNavigation section="assistant-settings" administrator />);
    const assistant = screen.getByRole("link", { name: "AI assistant" });
    expect(assistant).toHaveAttribute("href", "/account/edit#assistant-settings");
    expect(assistant.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(links()[links().indexOf(screen.getByRole("link", { name: "Chat bots" })) + 1]).toBe(assistant);
    expect(current()).toBe(assistant);
    rerender(<SettingsNavigation section="community-settings" administrator={false} />);
    expect(screen.queryByRole("link", { name: "AI assistant" })).not.toBeInTheDocument();
  });
});

describe("Set up huddles", () => {
  it("links administrators to Huddles, after AI assistant, under the huddle's headset, and members not at all", () => {
    const { rerender } = render(<SettingsNavigation section="huddles-settings" administrator />);
    const huddles = screen.getByRole("link", { name: "Huddles" });
    expect(huddles).toHaveAttribute("href", "/account/edit#huddles-settings");
    expect(huddles.querySelector("svg")).toHaveClass("iconoir-headset");
    expect(huddles.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(links()[links().indexOf(screen.getByRole("link", { name: "AI assistant" })) + 1]).toBe(huddles);
    expect(current()).toBe(huddles);
    expect(workspaceSectionOf("#huddles-settings")).toBe("huddles-settings");
    rerender(<SettingsNavigation section="community-settings" administrator={false} />);
    expect(screen.queryByRole("link", { name: "Huddles" })).not.toBeInTheDocument();
  });
});

describe("Custom CSS", () => {
  it("links administrators to Custom styles, last, and members not at all", () => {
    const { rerender } = render(<SettingsNavigation section="custom-styles" administrator />);
    expect(screen.getByRole("link", { name: "Custom styles" })).toHaveAttribute("href", "/account/custom_styles/edit");
    expect(links().at(-1)).toHaveTextContent("Custom styles");
    expect(current()).toHaveTextContent("Custom styles");
    rerender(<SettingsNavigation section="community-settings" administrator={false} />);
    expect(screen.queryByRole("link", { name: "Custom styles" })).not.toBeInTheDocument();
  });
});

describe("Custom domain", () => {
  it("links administrators to Domain settings, after Membership, and members not at all", () => {
    const { rerender } = render(<SettingsNavigation section="domain-settings" administrator />);
    const domain = screen.getByRole("link", { name: "Domain settings" });
    expect(domain).toHaveAttribute("href", "/account/edit#domain-settings");
    expect(domain.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(links()[3]).toBe(domain);
    expect(current()).toBe(domain);
    rerender(<SettingsNavigation section="community-settings" administrator={false} />);
    expect(screen.queryByRole("link", { name: "Domain settings" })).not.toBeInTheDocument();
  });
});
