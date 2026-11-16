import { createContext, useLayoutEffect, useRef, type ComponentType } from "react";
import { BrainElectricity, Group, Hashtag, Headset, Internet, Palette, Settings, Sparks } from "@/components/icons/iconoir";
import { PageLink } from "@/components/page-link";
import { BOTS_PATH, CUSTOM_STYLES_PATH, WORKSPACE_SETTINGS_PATH, type Route } from "@/hooks/use-route";
import { cn } from "@/lib/utils";

// Community settings: the pages that set the workspace up share a layout whose column of links to them
// takes the conversations' place, and workspace settings show one of their sections at a time, the one
// the address's fragment names: General, Rooms and permissions, Membership, and Domain settings, where
// administrators give Ember a custom domain, AI assistant, where they set up Ember AI and its agents,
// whose pages are part of it, and Huddles, where they turn huddles on.

/** The sections of community settings, by their ids. */
export type SettingsSection =
  | "community-settings"
  | "channel-settings"
  | "membership-settings"
  | "domain-settings"
  | "chat-bots"
  | "assistant-settings"
  | "huddles-settings"
  | "custom-styles";

const WORKSPACE_SECTIONS = ["community-settings", "channel-settings", "membership-settings", "domain-settings", "assistant-settings", "huddles-settings"] as const;

/** Workspace settings' own sections, which `/account/edit` shows one at a time. */
export type WorkspaceSection = (typeof WORKSPACE_SECTIONS)[number];

/** The address of one of workspace settings' sections. */
export const workspaceSectionPath = (section: WorkspaceSection) => `${WORKSPACE_SETTINGS_PATH}#${section}`;

/** The section of workspace settings an address's fragment shows: the first, unless it names another. */
export function workspaceSectionOf(hash: string): WorkspaceSection {
  return WORKSPACE_SECTIONS.find((section) => `#${section}` === hash) ?? "community-settings";
}

/** The section of community settings a page is part of, or null for any other page. */
export function settingsSectionOf(route: Route, hash: string): SettingsSection | null {
  switch (route.page) {
    case "workspace-settings":
      return workspaceSectionOf(hash);
    case "new-room":
    case "room-settings":
      return "channel-settings";
    case "bots":
    case "new-bot":
    case "bot-settings":
      return "chat-bots";
    case "new-agent":
    case "agent-settings":
    case "new-app":
    case "app-settings":
    case "app-signed-in":
      return "assistant-settings";
    case "custom-styles":
      return "custom-styles";
    default:
      return null;
  }
}

/** On a page of community settings, its section, and whether whoever's looking administers the workspace. */
export interface SettingsPlace {
  section: SettingsSection;
  administrator: boolean;
}

/** The page of community settings shown, which the layout around it follows, or null on any other page. */
export const SettingsLayout = createContext<SettingsPlace | null>(null);

interface SectionLink {
  section: SettingsSection;
  href: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
}

const LINKS: SectionLink[] = [
  { section: "community-settings", href: workspaceSectionPath("community-settings"), icon: Settings, label: "General" },
  { section: "channel-settings", href: workspaceSectionPath("channel-settings"), icon: Hashtag, label: "Rooms and permissions" },
  { section: "membership-settings", href: workspaceSectionPath("membership-settings"), icon: Group, label: "Membership" },
];

/** And the sections only administrators use. */
const ADMINISTRATOR_LINKS: SectionLink[] = [
  { section: "domain-settings", href: workspaceSectionPath("domain-settings"), icon: Internet, label: "Domain settings" },
  { section: "chat-bots", href: BOTS_PATH, icon: BrainElectricity, label: "Chat bots" },
  { section: "assistant-settings", href: workspaceSectionPath("assistant-settings"), icon: Sparks, label: "AI assistant" },
  { section: "huddles-settings", href: workspaceSectionPath("huddles-settings"), icon: Headset, label: "Huddles" },
  { section: "custom-styles", href: CUSTOM_STYLES_PATH, icon: Palette, label: "Custom styles" },
];

/**
 * A link's look: 13px muted text beside its 18px icon, on the surface under a pointer, and in ink on the
 * hover color, in bold, for the current section. At 900px and below the links share the strip, centered,
 * and at 500px and below each icon sits over its label, in 11px text.
 */
const LINK = cn(
  "mb-2 flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-[11px] text-[13px] leading-[1.4] text-muted-foreground",
  "hover:bg-surface hover:text-foreground aria-[current=page]:bg-hover aria-[current=page]:font-semibold aria-[current=page]:text-foreground",
  "max-md:m-0 max-md:flex-[1_0_auto] max-md:justify-center max-md:px-2 max-md:py-2.5 max-md:text-center",
  "upto-500px:flex-col upto-500px:gap-[5px] upto-500px:text-[11px]",
);

/**
 * The links to community settings' sections, the current one marked: a 244px column beside the page,
 * or at 900px and below, a strip under the header that scrolls sideways when they don't all fit, keeping
 * the current one in view. Domain settings, Chat bots, AI assistant, Huddles and Custom styles are for
 * administrators alone.
 */
export function SettingsNavigation({ section, administrator }: SettingsPlace) {
  const navigation = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const strip = navigation.current;
    if (strip && strip.scrollWidth > strip.clientWidth) strip.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [section]);
  return (
    <nav
      ref={navigation}
      aria-label="Community settings"
      className={cn(
        "min-h-0 overflow-y-auto border-r bg-background px-4 py-9",
        "max-md:flex max-md:gap-1.5 max-md:overflow-x-auto max-md:border-r-0 max-md:border-b max-md:py-2 max-md:pr-[max(12px,env(safe-area-inset-right))] max-md:pl-[max(12px,env(safe-area-inset-left))]",
      )}
    >
      {(administrator ? [...LINKS, ...ADMINISTRATOR_LINKS] : LINKS).map(({ section: linked, href, icon: Icon, label }) => (
        <PageLink key={linked} href={href} aria-current={linked === section ? "page" : undefined} className={LINK}>
          <Icon className="size-[18px] shrink-0" />
          <span>{label}</span>
        </PageLink>
      ))}
    </nav>
  );
}
