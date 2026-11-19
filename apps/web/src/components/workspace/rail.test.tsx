import { avatarSvg, type Account } from "@ember/protocol";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountContext } from "@/hooks/use-account";
import { Rail, type Activity, type RailPage } from "./rail";
import { OpenSearchContext } from "./search-box";

const ada = { id: "u1", name: "Ada Lovelace", administrator: false };
const activityOff: Activity = { on: false, unread: 0, onToggle: () => {} };

/** The rail for the page `current` names, as `me` sees it, with `newRelease` out since this Ember's. */
const railAt = (current: RailPage, activity = activityOff, me = ada, onNewDirect = () => {}, newRelease: string | null = null) => (
  <Rail me={me} workspaceName="Analytical Engines" current={current} activity={activity} newRelease={newRelease} onNewDirect={onNewDirect} />
);

afterEach(() => history.replaceState(null, "", "/"));

describe("Rail", () => {
  it("puts Back and Forward, Home, DMs, Activity, Search, Workspace, appearance and your profile on the rail", () => {
    render(railAt("home"));
    const rail = screen.getByRole("navigation", { name: "Workspace" });
    expect([...rail.querySelectorAll("a, button")].map((item) => item.getAttribute("aria-label") ?? item.textContent)).toEqual([
      "Back",
      "Forward",
      "Ember home",
      "Home",
      "DMs",
      "Activity",
      "Search",
      "Workspace",
      "Appearance: System",
      "Your profile",
    ]);
    expect(within(rail).getByRole("link", { name: "Ember home" })).toHaveAttribute("href", "/");
    expect(within(rail).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(within(rail).getByRole("link", { name: "DMs" })).toHaveAttribute("href", "/rooms/directs/new");
    expect(within(rail).getByRole("link", { name: "Search" })).toHaveAttribute("href", "/searches");
    expect(within(rail).getByRole("link", { name: "Workspace" })).toHaveAttribute("href", "/account/edit");
    expect(within(rail).getByRole("link", { name: "Your profile" })).toHaveAttribute("href", "/users/me/profile");
  });

  it("puts Back and Forward at its top for a pointer, leaving them out for fingers, which have their own way back", () => {
    render(railAt("room"));
    const arrows = screen.getByRole("button", { name: "Back" }).parentElement!;
    expect(arrows).toContainElement(screen.getByRole("button", { name: "Forward" }));
    expect(arrows).toHaveClass("touch:hidden");
    expect(screen.getByRole("navigation", { name: "Workspace" }).firstElementChild).toBe(arrows);
  });

  it("links your avatar to your profile, titled with your name", async () => {
    render(railAt("home"));
    const profile = screen.getByRole("link", { name: "Your profile" });
    expect(profile).toHaveAttribute("title", "Ada Lovelace");
    await userEvent.click(profile);
    expect(location.pathname).toBe("/users/me/profile");
  });

  it("names the settings link Admin for administrators, and Workspace for everyone else", () => {
    const { rerender } = render(railAt("workspace", activityOff, { ...ada, administrator: true }));
    const settings = screen.getByRole("link", { name: "Admin" });
    expect(settings).toHaveAttribute("href", "/account/edit");
    expect(settings).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Workspace" })).not.toBeInTheDocument();
    rerender(railAt("workspace"));
    expect(screen.getByRole("link", { name: "Workspace" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("marks Admin with a dot while a newer release of Ember is out, which it says to screen readers", () => {
    const grace = { ...ada, administrator: true };
    const { rerender } = render(railAt("home", activityOff, grace, () => {}, "0.2"));
    const admin = screen.getByRole("link", { name: "Admin" });
    expect(admin).toHaveAccessibleDescription("Ember 0.2 is available");
    const dot = admin.lastElementChild;
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(dot).toHaveClass("absolute", "rounded-full", "border-2", "border-surface", "bg-foreground");
    rerender(railAt("home", activityOff, grace));
    expect(admin).not.toHaveAccessibleDescription();
    expect(admin.lastElementChild).toHaveTextContent("Admin");
  });

  it("marks Admin with a dot while reports are open too, saying how many", () => {
    const grace = { ...ada, administrator: true };
    const rail = (openReports: number, newRelease: string | null = null) => (
      <Rail me={grace} workspaceName="Analytical Engines" current="home" activity={activityOff} newRelease={newRelease} openReports={openReports} onNewDirect={() => {}} />
    );
    const { rerender } = render(rail(1));
    const admin = screen.getByRole("link", { name: "Admin" });
    expect(admin).toHaveAccessibleDescription("1 open report");
    expect(admin.lastElementChild).toHaveClass("absolute", "rounded-full", "bg-foreground");
    rerender(rail(3, "0.2"));
    expect(admin).toHaveAccessibleDescription("Ember 0.2 is available. 3 open reports");
    rerender(rail(0));
    expect(admin).not.toHaveAccessibleDescription();
  });

  it("titles the logo with the workspace's name", () => {
    render(railAt("home"));
    expect(screen.getByRole("link", { name: "Ember home" })).toHaveAttribute("title", "Analytical Engines");
  });

  it("marks the logo and Home at home, Home for a room, Workspace for its settings, your avatar for your profile, and nothing for a room's forms", () => {
    const { rerender } = render(railAt("home"));
    const current = () => screen.queryAllByRole("link", { current: "page" }).map((link) => link.getAttribute("aria-label") ?? link.textContent);
    expect(current()).toEqual(["Ember home", "Home"]);
    rerender(railAt("room"));
    expect(current()).toEqual(["Home"]);
    rerender(railAt("workspace"));
    expect(current()).toEqual(["Workspace"]);
    rerender(railAt("profile"));
    expect(current()).toEqual(["Your profile"]);
    rerender(railAt(null));
    expect(current()).toEqual([]);
  });

  it("shows the page a link names in place", async () => {
    render(railAt("home"));
    const length = history.length;
    await userEvent.click(screen.getByRole("link", { name: "Workspace" }));
    expect(location.pathname).toBe("/account/edit");
    expect(history.length).toBe(length + 1);
  });

  it("marks no page while Activity is on", () => {
    render(railAt("home", { ...activityOff, on: true }));
    expect(screen.queryAllByRole("link", { current: "page" })).toEqual([]);
  });

  it("draws Iconoir's icons, which the project's owner chose", () => {
    render(railAt("home"));
    const rail = screen.getByRole("navigation", { name: "Workspace" });
    const icons = Object.fromEntries(
      [...rail.querySelectorAll("a, button")].map((item) => [item.getAttribute("aria-label") ?? item.textContent, item.querySelector("svg")?.classList[0]]),
    );
    expect(icons).toEqual({
      Back: "iconoir-arrow-left",
      Forward: "iconoir-arrow-right",
      "Ember home": undefined,
      Home: "iconoir-home",
      DMs: "iconoir-multi-bubble",
      Activity: "iconoir-bell",
      Search: "iconoir-search",
      Workspace: "iconoir-box",
      "Appearance: System": "iconoir-computer",
      "Your profile": undefined,
    });
  });
});

describe("Search box", () => {
  it("opens the search box in place from Search, which a click with a modifier key leaves to the browser, marked while the search page shows", async () => {
    const openSearch = vi.fn();
    const { rerender } = render(<OpenSearchContext value={openSearch}>{railAt("home")}</OpenSearchContext>);
    const search = screen.getByRole("link", { name: "Search" });
    expect(search).toHaveAttribute("href", "/searches");
    expect(search).not.toHaveAttribute("aria-current");
    await userEvent.click(search);
    expect(openSearch).toHaveBeenCalledExactlyOnceWith({ opener: search });
    expect(location.pathname).toBe("/");

    openSearch.mockClear();
    expect(fireEvent.click(search, { metaKey: true })).toBe(true);
    expect(openSearch).not.toHaveBeenCalled();
    rerender(<OpenSearchContext value={openSearch}>{railAt("search")}</OpenSearchContext>);
    expect(screen.queryAllByRole("link", { current: "page" })).toEqual([search]);
  });
});

describe("New direct message dialog", () => {
  it("opens New direct message in place from DMs, which a click with a modifier key leaves to the browser", async () => {
    const onNewDirect = vi.fn();
    render(railAt("room", activityOff, ada, onNewDirect));
    const dms = screen.getByRole("link", { name: "DMs" });
    await userEvent.click(dms);
    expect(onNewDirect).toHaveBeenCalledExactlyOnceWith(dms);
    expect(location.pathname).toBe("/");

    onNewDirect.mockClear();
    const opened = fireEvent.click(dms, { ctrlKey: true });
    expect(opened).toBe(true);
    expect(onNewDirect).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/");
  });

  it("never marks DMs, whose address goes on to the last room visited", () => {
    render(railAt("room"));
    expect(screen.getByRole("link", { name: "DMs" })).not.toHaveAttribute("aria-current");
  });
});

describe("Activity filter", () => {
  it("toggles Activity and shows it pressed while it's on", async () => {
    const onToggle = vi.fn();
    const { rerender } = render(railAt("home", { ...activityOff, onToggle }));
    const activity = screen.getByRole("button", { name: "Activity" });
    expect(activity).toHaveAttribute("title", "Show unread conversations");
    expect(activity).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(activity);
    expect(onToggle).toHaveBeenCalledOnce();

    rerender(railAt("home", { ...activityOff, on: true, onToggle }));
    expect(activity).toHaveAttribute("aria-pressed", "true");
    expect(activity).toHaveClass("aria-pressed:bg-hover", "aria-pressed:text-foreground");
  });

  it("counts unread conversations in a pill at its corner, hidden at none", () => {
    const { rerender } = render(railAt("room", { ...activityOff, unread: 3 }));
    const activity = screen.getByRole("button", { name: "Activity" });
    expect(activity).toHaveAccessibleDescription("3 unread");
    const pill = within(activity).getByText("3");
    expect(pill).toHaveAttribute("aria-hidden", "true");
    expect(pill).toHaveClass("absolute", "h-[17px]", "min-w-[17px]", "border-2", "border-surface", "bg-foreground", "text-[10px]", "text-background");

    rerender(railAt("room", { ...activityOff, unread: 0 }));
    expect(activity).not.toHaveAttribute("aria-description");
    expect(activity).toHaveTextContent(/^Activity$/);
  });
});

describe("Initials avatars", () => {
  it("shows your avatar as your profile picture", () => {
    render(railAt("home"));
    const picture = screen.getByRole("link", { name: "Your profile" }).querySelector("img")!;
    expect(picture.src).toBe(`data:image/svg+xml;base64,${btoa(avatarSvg(ada.id, ada.name))}`);
  });
});

describe("Workspace logo", () => {
  it("shows Ember's flame, or the workspace's logo, filling a 56px square with rounded corners", () => {
    const account = { name: "Analytical Engines", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true };
    const { rerender } = render(<AccountContext value={account}>{railAt("home")}</AccountContext>);
    const brand = screen.getByRole("link", { name: "Ember home" });
    expect(brand.querySelector("img")).toHaveAttribute("src", "/ember-icon.png");
    expect(brand).toHaveClass("size-14", "rounded-[10px]");
    expect(brand.querySelector("img")).toHaveClass("size-14", "rounded-[inherit]", "object-contain");

    rerender(<AccountContext value={{ ...account, logo: "/account/logo?v=20261017120000" }}>{railAt("home")}</AccountContext>);
    expect(brand.querySelector("img")).toHaveAttribute("src", "/account/logo?v=20261017120000");
    expect(brand.querySelector("img")).toHaveAttribute("alt", "");
    expect(brand.querySelector("img")).toHaveClass("size-14", "rounded-[inherit]", "object-cover");
    // On no background of its own.
    expect(brand).not.toHaveClass("bg-background");
  });
});

describe("Navigation icons", () => {
  it("draws the icons an administrator chose for its buttons, and Iconoir's for the rest", () => {
    const account: Account = {
      name: "Analytical Engines",
      tagline: "",
      hideTranslationButtons: true,
      customStyles: "",
      restrictRoomCreation: false,
      logo: null,
      customDomain: null,
      joinLink: true,
      openSignUp: false,
      memberfulJoin: false,
      memberfulSignIn: false,
      ssoJoin: false,
      ssoSignIn: false,
      emailDomainSignUp: false,
      emailDomains: [],
      navigationIcons: { home: "coffee", search: "iconoir:solid:heart" },
      huddles: false,
      huddleCameras: true,
      huddleScreens: true,
    };
    render(<AccountContext value={account}>{railAt("home", activityOff, { ...ada, administrator: true })}</AccountContext>);
    const icon = (name: string) => screen.getByRole(name === "Activity" ? "button" : "link", { name }).querySelector("[data-icon], svg");
    expect(icon("Home")).toHaveAttribute("data-icon", "coffee");
    expect(icon("Home")).toHaveStyle({ maskImage: "url(/lucide/icons/coffee.svg)", width: "22px", height: "22px" });
    expect(icon("Search")).toHaveStyle({ maskImage: "url(/iconoir/icons/solid/heart.svg)" });
    expect(icon("DMs")).toHaveClass("iconoir-multi-bubble", "size-[22px]");
    expect(icon("Activity")).toHaveClass("iconoir-bell");
    expect(icon("Admin")).toHaveClass("iconoir-box");
  });
});
