// The wire protocol shared by the browser and the Worker: the room socket's frames, each one JSON
// object with a `type`, and what the API sends and takes. Keep this file dependency-free: the
// worker and the web app both import it directly as TypeScript.

import type { AgentProfile } from "./agents.ts";
import type { YourApp } from "./apps.ts";
import type { AssistantSettings, YourAssistant } from "./assistant.ts";
import { isActionId, isActionValue, type Card } from "./cards.ts";
import type { StoredFile } from "./files.ts";
import type { HuddlesSettings, LiveHuddle } from "./huddles.ts";
import type { OutsideConnection } from "./outside.ts";
import { MAX_ID_LENGTH } from "./pages.ts";
import { MAX_PUSH_ENDPOINT_LENGTH } from "./push.ts";
import { ROOM_ICON_NAMES } from "./room-icons.ts";

export { ROOM_ICON_NAMES };
export {
  AVATAR_BOX,
  AVATAR_PATH,
  AVATAR_TOO_LARGE,
  avatarColor,
  avatarSvg,
  crc32,
  initials,
  LOGO_BOXES,
  LOGO_PATH,
  LOGO_TOO_LARGE,
  MAX_AVATAR_SIZE,
  MAX_LOGO_SIZE,
} from "./avatars.ts";
export {
  isActionId,
  isActionValue,
  MAX_ACTION_ID_LENGTH,
  MAX_ACTION_VALUE_LENGTH,
  MAX_CARDS,
  parseCards,
  parseParts,
  showsAnything,
  type AddressUse,
  type Card,
  type CardAction,
  type CardAddress,
  type CardButton,
  type CardColumn,
  type CardContextItem,
  type CardField,
  type CardImage,
  type CardPart,
  type CardTile,
} from "./cards.ts";
// The rest of bots.ts is imported from "@ember/protocol/bots": only the bot pages and the Worker's bot API use it,
// and the web app's main chunk, which imports this, would otherwise cost the app one more script to load
// (`oneAppScript` in apps/web/vite.config.ts says why).
export type { Bot, BotAnswer, BotChanges, BotRoom, Bots, BotSettings, NewBot } from "./bots.ts";
// So is the rest of assistant.ts, from "@ember/protocol/assistant", which only Ember AI's settings, its dials and the Worker's assistant use.
export type {
  AnswerLength,
  AnswerLevelChanges,
  AnswerLevels,
  AssistantChanged,
  AssistantChanges,
  AssistantForgotten,
  AssistantKeys,
  AssistantModel,
  AssistantSaved,
  AssistantSettings,
  AssistantSetup,
  ModelFormat,
  ModelPrice,
  NewAssistantModel,
  OfferedModel,
  OfferedModels,
  ThinkingLevel,
  WebSearchChange,
  WebSearchChanged,
  WebTool,
  YourAssistant,
  YourAssistantChanged,
  YourAssistantChanges,
} from "./assistant.ts";
// And the rest of huddles.ts, from "@ember/protocol/huddles", which only the Huddles card, its setup and the Worker's huddles use.
export type { HuddlesField, HuddlesForgotten, HuddlesSaved, HuddlesSettings, HuddlesSetup, LiveHuddle } from "./huddles.ts";
export {
  FILE_NAME_NOT_KEPT,
  FILE_TOO_LARGE,
  isKeepableFileName,
  isPreviewableSize,
  isPreviewed,
  isVariable,
  isWebImage,
  MAX_FILE_NAME_LENGTH,
  MAX_FILE_SIZE,
  MAX_FILE_TYPE_LENGTH,
  MAX_PREVIEW_PIXELS,
  MAX_PREVIEW_SIZE,
  parseNewUpload,
  PREVIEW_MAX_HEIGHT,
  PREVIEW_MAX_WIDTH,
  uploadPartPath,
  uploadPreviewPath,
  uploadsPath,
  type NewUpload,
  type StoredFile,
  type Upload,
} from "./files.ts";
export {
  APP_SIGNED_IN_PATH,
  BOTS_PATH,
  CUSTOM_STYLES_PATH,
  EMAIL_SIGN_UP_PATH,
  emailSignUpLink,
  huddlePath,
  INVITATION_PATH,
  invitationLink,
  isAppPage,
  KIND_SEGMENTS,
  MAX_ID_LENGTH,
  NEW_AGENT_PATH,
  NEW_APP_PATH,
  NEW_BOT_PATH,
  NEW_DIRECT_PATH,
  PASSWORD_RESET_PATH,
  PROFILE_PATH,
  PUSH_SUBSCRIPTIONS_PATH,
  SEARCHES_PATH,
  SIGN_UP_PATH,
  threadPath,
  TRANSFER_PATH,
  transferLink,
  TURNSTILE_CHECK_PATH,
  withEmailAddress,
  WORKSPACE_PRELOADS,
  WORKSPACE_SETTINGS_PATH,
  workspacePageOf,
  type RoomAccess,
  type WorkspacePage,
} from "./pages.ts";
export {
  MAX_PUSH_ENDPOINT_LENGTH,
  MAX_PUSH_KEY_LENGTH,
  MAX_PUSH_SUBSCRIPTIONS,
  parsePushSubscription,
  signOutEndpointOf,
  type PushSubscriptionKeys,
  type PushSubscriptions,
  type PushSubscriptionSave,
  type SavedPushSubscription,
  type SignOut,
} from "./push.ts";
export { TRANSLATIONS, type TranslationKey } from "./translations.ts";
export {
  hasFilters,
  hasWords,
  isSearchable,
  MAX_SEARCH_LENGTH,
  normalizedSearch,
  parseSearch,
  RECENT_SEARCHES,
  sanitizeSearch,
  SEARCH_FLAGS,
  SEARCH_LIMIT,
  SEARCH_TOO_LONG,
  searchKey,
  searchOfQuery,
  searchPath,
  searchQuery,
  searchTerms,
  type Search,
  type SearchFilters,
  type SearchFlag,
  type SearchMatch,
  type SearchParams,
  type SearchResults,
  type SearchSort,
} from "./search.ts";

export type UserId = string;
export type RoomId = string;

export interface User {
  id: UserId;
  name: string;
}

/** Who's signed in, as the app keeps them: someone, and whether they're one of the workspace's administrators. */
export interface Me extends User {
  administrator: boolean;
}

/** What someone is in the workspace: Campfire's user roles (`User::Role`). */
export type Role = "member" | "administrator" | "bot";

/**
 * Whether someone can still sign in: people who were removed are deactivated, and banned people are
 * banned. A member who signs in with Memberful is suspended while their membership has lapsed, until
 * it's renewed.
 */
export type UserStatus = "active" | "deactivated" | "banned" | "suspended";

/** Someone as the people directory lists them. */
export interface DirectoryUser extends User {
  /** What they say about themselves, or null when they haven't said. */
  bio: string | null;
  role: Role;
  status: UserStatus;
  /** Their avatar, `/users/<token>/avatar?v=<version>`, whose address changes whenever they do, and @ember's with each release too. */
  avatarUrl: string;
  /**
   * Whether they're an AI agent, @ember or one an administrator made, which the Agent badge shows, even
   * once it's deleted, as its answers stay. Left out for anyone else.
   */
  agent?: true;
}

/** What `GET /api/users` answers: everyone in the workspace, deactivated, banned and suspended people too. */
export interface Directory {
  users: DirectoryUser[];
}

export type RoomKind = "open" | "closed" | "direct";

/** A room's icon: the name of one of the Lucide or Iconoir icons in the room icon picker's catalog. */
export type RoomIconName = (typeof ROOM_ICON_NAMES)[number];

/**
 * A room's icon as New room and a room's settings send it: an icon's name, or "" for the default `#`.
 */
export type RoomIconChoice = RoomIconName | "";

/** An open or a private room, which Campfire calls a shared room (users/sidebars/rooms/_shared.html.erb). */
export interface SharedRoom {
  id: RoomId;
  kind: Exclude<RoomKind, "direct">;
  name: string;
  /** Null for the default `#`. */
  icon: RoomIconName | null;
}

/**
 * A direct message. It has no name or icon of its own: it's named after its members, who are the same
 * for as long as it lasts.
 */
export interface DirectRoom {
  id: RoomId;
  kind: "direct";
  /** Everyone in it, whoever's reading included, by id, with the names they had when it was read. */
  members: User[];
  /** When its latest message came, or when it started, until one has, as an ISO time, which DMs are listed by, latest first. */
  activeAt: string;
}

/** A room someone is in, as their room list shows it: a shared room, or a DM. */
export type Room = SharedRoom | DirectRoom;

/**
 * The welcome card's invitation: the workspace's first room, where the card shows while the room is
 * new, and the code in the workspace's join link, such as aB3d-Ef5h-iJ7k. Only administrators are
 * given it, until they dismiss the card.
 */
export interface Invitation {
  roomId: RoomId;
  joinCode: string;
}

/**
 * How much someone hears of a room they're in, its notification level: its @mentions of them, all its
 * messages, nothing, or nothing with the room hidden from their sidebar.
 */
export const INVOLVEMENTS = ["mentions", "everything", "nothing", "invisible"] as const;
export type Involvement = (typeof INVOLVEMENTS)[number];

/** The level someone starts at in `room`: all messages in a DM, and @mentions elsewhere. */
export const startingInvolvement = (room: Room): Involvement => (room.kind === "direct" ? "everything" : "mentions");

/**
 * A room in someone's sidebar, with whether a message has come since they last had it open in a shown
 * tab, which marks it unread for them until they do again, when the first of those messages came, while
 * it's marked, and their level in it. A room they've hidden is listed too, since they can still open it,
 * but their sidebar leaves it out.
 */
export type SidebarRoom = Room & { unread: boolean; unreadSince?: string; involvement: Involvement };

/**
 * The rooms someone has starred, which their sidebar lists first, in the order they starred them.
 * `version` counts the changes to them, so of two lists, the newer is the one with the larger version,
 * whichever arrives last.
 */
export interface Favorites {
  rooms: RoomId[];
  version: number;
}

/**
 * What `GET /api/sidebar` answers: the rooms someone is in, in the order they were made, the ones
 * they've starred, the invitation, when they're an administrator in its room who hasn't dismissed the
 * card, the people suggested for DMs, and the huddles going on in their rooms. It comes with an ETag,
 * and a request whose If-None-Match names it gets 304 Not Modified instead.
 */
export interface Sidebar {
  rooms: SidebarRoom[];
  favorites: Favorites;
  /**
   * The rooms in `rooms` that the workspace's shared order ranks, in that order, which the sidebar lists
   * after the stars, before the rest. An administrator sets it on workspace settings, and the ids of
   * rooms someone isn't in never reach them.
   */
  sharedOrder: RoomId[];
  invitation: Invitation | null;
  /**
   * People to start a DM with: the active people with the oldest accounts who share no DM with this
   * person, never them nor a bot or AI agent, as many as `suggestedCount` says.
   */
  suggestions: User[];
  /** The huddle going on in each of `rooms` that has one, by the room's id. `room.huddle` frames keep it current. */
  huddles: Record<RoomId, LiveHuddle>;
}

/** How many people the sidebar's suggestions start from, Campfire's `DIRECT_PLACEHOLDERS`. */
export const SUGGESTED_PEOPLE = 20;

/**
 * How many people the sidebar suggests for DMs to someone with `peopleInDirects` people across their
 * DMs, them included: `SUGGESTED_PEOPLE` less those people, less one more, so 19 with no DMs, 18 with
 * only a DM with themselves and 17 with a DM with one other person.
 */
export const suggestedCount = (peopleInDirects: number) => Math.max(0, SUGGESTED_PEOPLE - peopleInDirects - 1);

/**
 * A room to create: an open room takes in everyone, and a closed one only the people `memberIds` names.
 * Without an icon, it has the default `#`.
 */
export type NewRoom = { name: string; icon?: RoomIconChoice } & ({ kind: "open" } | { kind: "closed"; memberIds: UserId[] });

/** Someone active, as a room's settings list them, with whether they're in the room. */
export interface RoomPerson extends User {
  member: boolean;
}

/** What `GET /api/rooms/new` answers for the New room forms: everyone active, by name. */
export interface NewRoomForm {
  people: User[];
}

/**
 * A DM to start: the DM between you and them, whom `userIds` names, or your DM with yourself when it
 * names nobody else.
 */
export interface NewDirect {
  userIds: UserId[];
}

/** What `POST /api/directs` answers: the DM, 201 Created when it's new and 200 OK when the group had one. */
export interface StartedDirect {
  room: DirectRoom;
}

/** What `GET /api/rooms/<id>/settings` answers for a room's settings page. DMs have none. */
export interface RoomSettings {
  room: SharedRoom;
  /** Whether you can change the room, as administrators and its creator can. Others see it read-only. */
  canAdminister: boolean;
  /** Everyone active, by name. */
  people: RoomPerson[];
}

/**
 * What `PATCH /api/rooms/<id>` changes in a room, as its settings save it: its name, its icon, and who
 * it's for, everyone or just the people `memberIds` names, which takes anyone else out of it.
 */
export type RoomChanges = { name?: string; icon?: RoomIconChoice } & ({ kind?: "open" } | { kind: "closed"; memberIds: UserId[] });

/**
 * The rail's buttons and the appearance modes, whose icons an administrator can choose in Community
 * settings.
 */
export const NAVIGATION_SLOTS = ["home", "dms", "activity", "search", "admin", "light", "dark", "system"] as const;
export type NavigationSlot = (typeof NAVIGATION_SLOTS)[number];

/**
 * Each slot's icon until an administrator chooses another: the rail's Iconoir icons, which the project's
 * owner chose.
 */
export const DEFAULT_NAVIGATION_ICONS = {
  home: "iconoir:regular:home",
  dms: "iconoir:regular:multi-bubble",
  activity: "iconoir:regular:bell",
  search: "iconoir:regular:search",
  admin: "iconoir:regular:box",
  light: "iconoir:regular:sun-light",
  dark: "iconoir:regular:half-moon",
  system: "iconoir:regular:computer",
} as const satisfies Record<NavigationSlot, RoomIconName>;

/** The icons an administrator chose for the rail's buttons and the appearance modes, by slot. */
export type NavigationIcons = Partial<Record<NavigationSlot, RoomIconName>>;

/** The slots whose icons Save changes changes, as Community settings send them: each an icon's name, or "" for its default. */
export type NavigationIconChanges = Partial<Record<NavigationSlot, RoomIconChoice>>;

/** `icons` with `changes` made: a slot changed to "" has its default again. */
export function withNavigationIcons(icons: NavigationIcons, changes: NavigationIconChanges): NavigationIcons {
  const changed = { ...icons };
  for (const slot of NAVIGATION_SLOTS) {
    const icon = changes[slot];
    if (icon === "") delete changed[slot];
    else if (icon !== undefined) changed[slot] = icon;
  }
  return changed;
}

/** The workspace, which first run creates, as every page shows it. */
export interface Account {
  name: string;
  /**
   * The few words an administrator gives in Workspace settings, which the sidebar shows in small type
   * under the name. Empty while there are none, when nothing shows there.
   */
  tagline: string;
  /** Whether the translation buttons by fields are hidden, as they are until an administrator shows them. */
  hideTranslationButtons: boolean;
  /** The CSS administrators add to every page, after the app's own. Empty when there's none. */
  customStyles: string;
  /** Whether only administrators can create rooms, as "Must be admin to create new rooms" says. Off until one turns it on. */
  restrictRoomCreation: boolean;
  /**
   * The address of the workspace's logo, which changes whenever the account does, or null while there's
   * none, when pages show Ember's flame.
   */
  logo: string | null;
  /**
   * The address an administrator gave Ember in Workspace settings: a host, with its port where it isn't
   * the scheme's own, as `location.host` writes it, either a custom domain or, once they go back to it,
   * where a deploy put Ember (`EmberAddresses.deployed`). Pages opened at any other address move there,
   * but workspace settings. Null while Ember has none, and is used wherever it's opened.
   */
  customDomain: string | null;
  /**
   * Whether the join link lets people in, which an administrator turns off in Membership: then it sends
   * them to sign in, keeping its code for when it's on again. On until one turns it off. While Memberful
   * is members only it's off whatever this says (`joinsWithLink`).
   */
  joinLink: boolean;
  /**
   * Whether anyone may create an account at `/join`, with no link, which an administrator turns on in
   * Membership as Open. Off until one does, and never on while Memberful is members only.
   */
  openSignUp: boolean;
  /**
   * Whether the members of the deployment's Memberful site join, and sign in, with their Memberful
   * account, which an administrator turns on in Membership as Memberful. Off until one does. Members who
   * joined with it keep signing in with it once it's off, while the deployment has its keys.
   */
  memberfulJoin: boolean;
  /**
   * Whether only Memberful's members sign in, and administrators, which an administrator turns on in
   * Membership as Memberful's Members only: then the join link, open sign-up, Email domain and signing in
   * with just a name are off, and only administrators and the people they invite sign in with a
   * password. Off until one turns it on, and never on while Memberful is off.
   */
  memberfulSignIn: boolean;
  /**
   * Whether people with an email address at one of `emailDomains` may join with a link Ember emails
   * them, which they ask for at `/join/email`, and which an administrator turns on in Membership as Email
   * domain. Off until one does, and off whatever this says while Memberful is members only
   * (`signsUpWithEmailDomain`).
   */
  emailDomainSignUp: boolean;
  /**
   * The domains whose email addresses join while Email domain is on, as signed-out pages name them, each
   * as `emailDomainOf` has domains. None while it's off, though administrators see the ones kept for when
   * it's on again (`WorkspaceSettings.emailDomains`).
   */
  emailDomains: string[];
  /**
   * The icons an administrator chose in Community settings for the rail's buttons and the appearance
   * modes. A slot without one shows its default.
   */
  navigationIcons: NavigationIcons;
  /**
   * Whether huddles are on, which an administrator turns on in community settings' Huddles tab, or as
   * they set Ember up, by giving Ember the keys of the Realtime SFU app they run through. Off until one
   * does, when no room's header has a huddle button.
   */
  huddles: boolean;
}

/** What `GET /api/account` answers for workspace settings. */
export interface WorkspaceSettings {
  account: Account;
  /**
   * The join link's code, which everyone in the workspace can share, or null for someone who signed in
   * with just a name, unless they're an administrator, since a member's account they made with it would
   * stay once `EMBER_GUEST_SIGN_IN` turns guests away.
   */
  joinCode: string | null;
  /** Whether you can change the workspace, as administrators can. Members see it read-only. */
  canAdminister: boolean;
  /**
   * The address of the Memberful site whose members can sign in, such as https://example.memberful.com,
   * once the deployment has the keys of its custom app (`MEMBERFUL_URL` and the rest), or null while it
   * hasn't, when Memberful can't be turned on.
   */
  memberfulSite: string | null;
  /**
   * Whether the deployment also has what Memberful's webhooks take, their signing secret and the custom
   * app's API key (`MEMBERFUL_WEBHOOK_SECRET` and `MEMBERFUL_API_KEY`), so that Ember hears when a
   * membership lapses or is renewed, and checks what it hears with Memberful.
   */
  memberfulWebhooks: boolean;
  /**
   * Where the keys of the Cloudflare Turnstile widget come from that checks whoever signs up, or asks
   * Ember to email them, is a person, as Membership's Turnstile card says: the deployment's secrets
   * `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, which take the place of any others, the ones an
   * administrator gave Ember in Set up Turnstile, or null while it has neither, when limits on each
   * network stand in for the check.
   */
  turnstile: "secret" | "saved" | null;
  /** How Ember sends email, which Membership's Email card shows administrators. */
  email: EmailSettings;
  /** The invitations no one has accepted yet, newest first, for administrators, and none for anyone else. */
  invitations: EmailInvitation[];
  /** The domains Email domain lets in, as kept, whether it's on or not, for administrators, and none for anyone else. */
  emailDomains: string[];
  /** The addresses Ember knows reach it besides its own, which the Custom domain card names, for administrators, and none for anyone else. */
  addresses: EmberAddresses;
  /** Ember AI as the AI assistant tab shows it, for administrators while it's on, and null otherwise. */
  assistant: AssistantSettings | null;
  /** Huddles as the Huddles tab's card shows them, for administrators while they're on, and null otherwise. */
  huddles: HuddlesSettings | null;
  /** Whether AI apps, such as Claude, may connect to Ember, as the AI assistant tab's Outside AI card shows administrators, and false for anyone else. */
  outsideAi: boolean;
  /**
   * The ID of the Cloudflare account Ember is deployed to, which Set up Ember AI fills in, for
   * administrators once the deploy has given it to the Worker, and null otherwise.
   */
  cloudflareAccountId: string | null;
}

/**
 * An invitation an administrator sent to join with an email address, until it's accepted or revoked. Its
 * link works once, until it expires, and only for that address.
 */
export interface EmailInvitation {
  id: string;
  /** The address it's for, as the administrator gave it, which the account it makes has. */
  emailAddress: string;
  /** The name of the administrator who sent it last. */
  invitedBy: string;
  /** When its newest link was made, which a resend replaces, and when that stops working. */
  createdAt: string;
  expiresAt: string;
  /**
   * Whether Ember emailed its newest link, as "sent", or why the provider didn't send it, or null while
   * Ember can't send email, when the administrator sends the link themselves.
   */
  delivery: "sent" | { refusal: string } | null;
}

/** The most email addresses `POST /api/invitations` invites at once. Membership sends a longer list that many at a time. */
export const INVITATIONS_AT_ONCE = 20;

/** How long an invitation's link works, from when it's sent. */
export const INVITATION_DAYS = 7;

/**
 * What came of inviting an email address: nothing, when someone has an account with it already, whatever
 * its case, or else its invitation, with the link when Ember didn't email it, for the administrator to
 * send themselves, since only its digest is kept.
 */
export type InvitationOutcome = { emailAddress: string; member: true } | { emailAddress: string; invitation: EmailInvitation; link: string | null };

/** What `POST /api/invitations` answers: what came of each address, in the order given. */
export interface Invited {
  outcomes: InvitationOutcome[];
}

/** What `POST /api/invitations/<id>/resend` answers: the invitation with its new link, which the old one no longer joins with, and the link when Ember didn't email it. */
export interface ResentInvitation {
  invitation: EmailInvitation;
  link: string | null;
}

/** What Ember sends email with: Cloudflare Email Service's binding, or Resend's API. */
export type EmailProvider = "cloudflare" | "resend";

/** How Ember sends email. */
export interface EmailSettings {
  /**
   * What Ember sends email with: Resend while it has an API key for it, or else Cloudflare Email Service
   * while the Worker has its `EMAIL` binding, or null while it has neither, when Ember can't send any.
   */
  provider: EmailProvider | null;
  /**
   * Where Resend's API key comes from: the deployment's secret `RESEND_API_KEY`, which takes the place
   * of any other, the one an administrator gave Ember in Membership's Set up email, or null for none.
   */
  resendKey: "secret" | "saved" | null;
  /** Whether the Worker has Cloudflare Email Service's `EMAIL` binding, which sends while Ember has no Resend API key. */
  cloudflare: boolean;
  /** The address an administrator gave Ember's email to come from, as `mailboxText` writes it, or null while there's none. */
  from: string | null;
}

/** What `PUT` and `DELETE /api/account/turnstile_keys` answer: where Ember's Turnstile keys come from then, as `WorkspaceSettings.turnstile` says. */
export interface TurnstileSettings {
  turnstile: WorkspaceSettings["turnstile"];
}

/**
 * What Set up Turnstile gives `PUT /api/account/turnstile_keys`: a widget's site key and secret key, and
 * the token that widget's check gave the dialog, which the Worker asks Cloudflare about with the secret
 * key, so that Ember keeps only keys that check people here.
 */
export interface TurnstileKeysChange {
  siteKey: string;
  secretKey: string;
  turnstileToken: string;
}

/** The longest key of a Turnstile widget Ember takes, where Cloudflare's are a few dozen characters. */
const MAX_TURNSTILE_KEY_LENGTH = 100;

/** Why a site key, or a secret key, is refused before Cloudflare is asked about it. */
export const TURNSTILE_SITE_KEY_REFUSED = "A site key starts with 0x. Copy it from your widget in Cloudflare Turnstile.";
export const TURNSTILE_SECRET_KEY_REFUSED = "A secret key starts with 0x. Copy it from your widget in Cloudflare Turnstile.";

/** Why Set up Turnstile's keys are refused once Cloudflare has answered the check's token with them, or hasn't. */
export const TURNSTILE_SECRET_KEY_UNKNOWN = "Cloudflare doesn't know that secret key. Copy it again from your widget in Cloudflare Turnstile.";
export const TURNSTILE_KEYS_UNMATCHED = "That secret key isn't the site key's. Copy both keys from the same widget.";
export const TURNSTILE_CHECK_EXPIRED = "That check has expired. Pass it again.";
export const TURNSTILE_KEYS_UNCHECKED = "Ember couldn't reach Cloudflare to check the keys. Try again.";

/**
 * The Turnstile key `text` gives, without the spaces around it, or null when it can't be one: a widget's
 * keys start with a digit and an x, as `0x4AAAA…` and Cloudflare's test keys do, then letters, digits,
 * dashes and underscores.
 */
export function turnstileKeyOf(text: string): string | null {
  const key = text.trim();
  return key.length <= MAX_TURNSTILE_KEY_LENGTH && /^[0-9]x[\w-]{16,}$/.test(key) ? key : null;
}

/**
 * What `PUT /api/account/turnstile_keys` gives Ember, as Set up Turnstile sends it, or why it can't be one,
 * on the field it's about: a site key and a secret key, which aren't the same, and the check's token.
 */
export function parseTurnstileKeysChange(data: unknown): TurnstileKeysChange | { error: string; field: "siteKey" | "secretKey" | "turnstile" } {
  const given = isJsonObject(data) ? data : {};
  const siteKey = typeof given.siteKey === "string" ? turnstileKeyOf(given.siteKey) : null;
  if (siteKey === null) return { error: TURNSTILE_SITE_KEY_REFUSED, field: "siteKey" };
  const secretKey = typeof given.secretKey === "string" ? turnstileKeyOf(given.secretKey) : null;
  if (secretKey === null || secretKey === siteKey) return { error: TURNSTILE_SECRET_KEY_REFUSED, field: "secretKey" };
  const { turnstileToken } = given;
  if (typeof turnstileToken !== "string" || turnstileToken === "" || turnstileToken.length > MAX_TURNSTILE_TOKEN_LENGTH) {
    return { error: TURNSTILE_FAILED, field: "turnstile" };
  }
  return { siteKey, secretKey, turnstileToken };
}

/** Why Ember can't send email while it has neither a Resend API key nor Cloudflare's binding. */
export const CANT_SEND_EMAIL = "Ember can't send email yet. An administrator can set it up under Email in Membership.";

/** The longest Resend API key Ember takes, which goes in a header of each request to Resend. */
const MAX_RESEND_API_KEY_LENGTH = 256;

/** Why a Resend API key is refused before Resend is asked about it. */
export const RESEND_API_KEY_REFUSED = "A Resend API key starts with re_. Copy it from API Keys in Resend.";

/** The Resend API key `text` gives, without the spaces around it, or null when it can't be one: Resend's start with `re_`, and have no spaces. */
export function resendApiKeyOf(text: string): string | null {
  const apiKey = text.trim();
  return apiKey.length <= MAX_RESEND_API_KEY_LENGTH && /^re_[\x21-\x7e]+$/.test(apiKey) ? apiKey : null;
}

/** What `PUT /api/account/resend_api_key` gives Ember, as Set up email sends it: `{ apiKey }`, or why it can't be one. */
export function parseResendApiKey(data: unknown): { apiKey: string } | string {
  const apiKey = isJsonObject(data) && typeof data.apiKey === "string" ? resendApiKeyOf(data.apiKey) : null;
  return apiKey === null ? RESEND_API_KEY_REFUSED : { apiKey };
}

/** What `POST /api/account/test_email` answers once it has sent a test email: the address it went to, the administrator's own. */
export interface SentTestEmail {
  to: string;
}

/**
 * What `POST /api/account/sending_domain_checks` answers: whether the domain it was sent is onboarded to
 * Cloudflare Email Sending, as the records Onboard Domain adds to its DNS say, or null when DNS didn't
 * answer.
 */
export interface SendingDomainCheck {
  onboarded: boolean | null;
}

/** Why a domain to check for Cloudflare Email Sending is refused. */
export const SENDING_DOMAIN_REFUSED = "Expected a domain, such as example.com";

/**
 * Parses an untrusted request to check a domain Cloudflare Email Sending might send from, `{ domain }`,
 * as `emailDomainOf` has domains. Returns why it's refused instead of the domain.
 */
export function parseSendingDomainCheck(data: unknown): { domain: string } | string {
  const domain = isJsonObject(data) && typeof data.domain === "string" ? emailDomainOf(data.domain) : null;
  return domain === null ? SENDING_DOMAIN_REFUSED : { domain };
}

/** What `POST /api/account/join_code` answers: the join link's new code, which the old one no longer joins with. */
export interface NewJoinCode {
  joinCode: string;
}

/**
 * What `PATCH /api/account` changes, as workspace settings save it: the workspace's name, its tagline,
 * its settings, its custom domain, which can only be the address the request comes to, or null for
 * none, the icons of the rail's buttons and the appearance modes, the address Ember's email comes from,
 * or null for none, and the domains Email domain lets in, in place of those it had.
 */
export interface AccountChanges {
  name?: string;
  tagline?: string;
  settings?: AccountSettings;
  customDomain?: string | null;
  navigationIcons?: NavigationIconChanges;
  emailFrom?: string | null;
  emailDomains?: string[];
}

/**
 * The workspace's settings that workspace settings' switches change, the ways to join among them: the
 * join link's switch, Open, Memberful, its Members only, which the Worker turns on only with the
 * deployment's Memberful keys, and Email domain, which it turns on only with a domain to let in, while
 * Ember can send email. Members only turns Memberful on with it, turning Memberful off turns it off, and
 * it's never on together with Open.
 */
export interface AccountSettings {
  hideTranslationButtons?: boolean;
  restrictRoomCreation?: boolean;
  joinLink?: boolean;
  openSignUp?: boolean;
  memberfulJoin?: boolean;
  memberfulSignIn?: boolean;
  emailDomainSignUp?: boolean;
}

/** Whether the join link lets people in: its switch is on, and Memberful isn't members only, which turns it off. */
export const joinsWithLink = ({ joinLink, memberfulSignIn }: Pick<Account, "joinLink" | "memberfulSignIn">) => joinLink && !memberfulSignIn;

/** Whether anyone may create an account at `/join`: Open is on, and Memberful isn't members only, which it can't be on with. */
export const signsUpOpenly = ({ openSignUp, memberfulSignIn }: Pick<Account, "openSignUp" | "memberfulSignIn">) => openSignUp && !memberfulSignIn;

/**
 * Whether people may join with an email address at the workspace's email domains: Email domain is on,
 * with a domain to let in, and Memberful isn't members only, which turns it off.
 */
export const signsUpWithEmailDomain = ({ emailDomainSignUp, emailDomains, memberfulSignIn }: Pick<Account, "emailDomainSignUp" | "emailDomains" | "memberfulSignIn">) =>
  emailDomainSignUp && emailDomains.length > 0 && !memberfulSignIn;

/** Why turning on Open, or Memberful's Members only, is refused while the other is on: Members only lets only Memberful's members in. */
export const OPEN_WITH_MEMBERFUL = "Open and Members only can't both be on. Turn one off first.";

/** The most domains Email domain lets in, which every page carries while it's on. */
export const MAX_EMAIL_DOMAINS = 100;

/** Why `PATCH /api/account` refuses the domains it's given for Email domain. */
export const EMAIL_DOMAINS_REFUSED = `Email domains must be a list of at most ${MAX_EMAIL_DOMAINS} domains, such as example.com`;

/** Why Email domain can't be on without a domain to let in. */
export const NO_EMAIL_DOMAINS = "Add a domain whose email addresses can join.";

/** Why Email domain can't be turned on while Ember can't send email, since it emails people the links they join with. */
export const EMAIL_DOMAIN_NEEDS_EMAIL = "Email domain emails people a link to join with, so Ember has to send email first. Set up email in Membership.";

/**
 * Domains anyone can have an email address at, for free, which Email domain warns would let almost
 * anyone in.
 */
export const FREE_EMAIL_DOMAINS: readonly string[] = [
  "aol.com",
  "duck.com",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mac.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "tuta.com",
  "tutanota.com",
  "yahoo.com",
  "yandex.com",
  "zoho.com",
];

/** What `GET /api/account/custom_styles` answers, and `PATCH` sets, as the Custom CSS page saves it. */
export interface CustomStyles {
  customStyles: string;
}

/** Ember's repository, which publishes its releases, and its docs on updating a deployment to one. */
export const EMBER_REPOSITORY = "https://github.com/NYLLON-SOFTWARE/ember-cloudflare";
export const UPDATING_EMBER = `${EMBER_REPOSITORY}/blob/main/docs/self-hosting.md#updating`;
/** Ember's docs on its betas, and on trying one. */
export const TRYING_BETAS = `${EMBER_REPOSITORY}/blob/main/docs/self-hosting.md#betas`;

/**
 * What `GET /api/account/release` answers an administrator, for General settings to say, and `POST
 * /api/account/release_checks`, which opening Admin, and its Check for updates, make to have the Worker
 * ask GitHub afresh: the release this Ember is, named without its version's trailing ".0", such as "0.1",
 * and the newest release of Ember on GitHub, named so too, with its version, such as "0.1.0", the address
 * of its notes there and whether it's newer than this one, or null when GitHub didn't name one.
 */
export interface ReleaseCheck {
  release: string;
  /** Whether this Ember is a beta, such as "0.5 beta 1", ahead of the newest release, which GitHub never names a beta. */
  beta: boolean;
  newest: { release: string; version: string; notes: string; newer: boolean } | null;
  /** When GitHub named that release, as an ISO time, which General says it last checked, or null with it. */
  checkedAt: string | null;
  /**
   * Ember's newest beta while it's ahead of the newest release, named as "0.6 beta 1", with its version,
   * "0.6.0-beta.1", its notes and whether it's newer than this one, or null when it isn't ahead, or GitHub
   * didn't say: what General offers a release to try, and a beta to update to (docs/self-hosting.md#betas).
   */
  newestBeta: { release: string; version: string; notes: string; newer: boolean } | null;
  /** The copy of Ember this is on GitHub, as its deploy said, or null where it said none. */
  copy: CopyOnGitHub | null;
}

/**
 * A version's numbers, such as [0, 1, 0] for "0.1.0", and then its beta's, which is Infinity for a
 * release, as it comes after its betas: [0, 5, 0, 1] for "0.5.0-beta.1", and [0, 5, 0, Infinity] for "0.5.0".
 */
function numbersOf(version: string): number[] {
  const [, ...numbers] = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(version) ?? [];
  return numbers.map((number) => (number === undefined ? Infinity : Number(number)));
}

/** Whether version `a` of Ember, a release's or a beta's, comes after version `b`. */
export function isNewer(a: string, b: string): boolean {
  const [later, earlier] = [numbersOf(a), numbersOf(b)];
  const differs = later.findIndex((number, at) => number !== earlier[at]);
  return differs !== -1 && later[differs]! > (earlier[differs] ?? -1);
}

/**
 * A copy of Ember on GitHub, as its deploy tells the Worker: its repository, as `owner/name`, the branch
 * that deploys, and whether it has the Update Ember workflow, and the beta workflow, Update Ember to its
 * newest beta, for General's release card to link to running each, or to adding it.
 */
export interface CopyOnGitHub {
  repository: string;
  branch: string;
  workflow: boolean;
  betaWorkflow: boolean;
}

/** The roles an administrator can give someone with the crown on workspace settings. Bots stay bots. */
export type PersonRole = Exclude<Role, "bot">;

/** What `PATCH /api/account/users/<id>` sets, as the crown on workspace settings does: someone's role. */
export interface RoleChange {
  role: PersonRole;
}

/**
 * What `PATCH /api/account/users/<id>` answers, and `DELETE`, which removes them from the workspace, and
 * `POST` and `DELETE /api/users/<id>/ban`, which ban them and lift it: the person as the people
 * directory now lists them.
 */
export interface ChangedPerson {
  user: DirectoryUser;
}

/** Someone as their page shows them: as the people directory lists them, and to administrators with their email address. */
export interface Person extends DirectoryUser {
  /** Their email address, or null when they have none, which only administrators are told. */
  emailAddress?: string | null;
}

/** What `GET /api/users/<id>` answers: anyone, whatever their status. */
export interface PersonAnswer {
  person: Person;
  /**
   * The id in a new sign-in link for them (`transferLink`), which administrators are given for anyone
   * active who isn't a bot.
   */
  transferId?: string;
  /** What an agent's page tells everyone of it, for an agent an administrator made, until it's deleted. */
  agent?: AgentProfile;
}

/** You, as your profile shows you. */
export interface Profile {
  name: string;
  /** Null for someone who signed in with just a name, or who took theirs out. */
  emailAddress: string | null;
  /** What you say about yourself, or null when you haven't said. */
  bio: string | null;
  /** Your avatar, as the people directory gives it (`DirectoryUser.avatarUrl`). */
  avatarUrl: string;
  /** Whether you've uploaded an avatar, which Remove avatar takes away, though one that can't be resized shows your initials. */
  avatar: boolean;
  /** Whether you have a password, which changing your email address or password then asks for (`currentPassword`). */
  password: boolean;
  /**
   * Whether you need a Memberful membership to sign in while Memberful is members only, as everyone does
   * but administrators and the people they invite, who sign in with a password too.
   */
  membershipNeeded: boolean;
  /**
   * Where you stand with Memberful (`MemberfulStatus`): the account at the Memberful site you've connected
   * your account to, which you can sign in with then, or none yet while Memberful is members only. Null
   * when there's nothing to show: while the deployment lacks Memberful's keys, for a guest, who has
   * nothing to connect, or while Memberful isn't members only and you haven't connected one.
   */
  memberful: MemberfulStatus | null;
  /** How much @ember thinks and how long it answers you, and the most each may be, and the model you picked, if you did, and the ones you can pick, or null while Ember AI is off. */
  assistant: YourAssistant | null;
  /** The connected apps you can sign in to yourself, by name, each with your sign-in to it, if you've made one: none while Ember AI is off, or for a guest. */
  apps: YourApp[];
  /** The AI apps connected to Ember as you, newest first, or null when none can be: while an administrator hasn't let AI apps connect, or for a guest. */
  outsideAi: OutsideConnection[] | null;
}

/** What `GET /api/users/me/profile` answers, and `PATCH` once it has saved. */
export interface ProfileAnswer {
  profile: Profile;
  /** The id in a new sign-in link for you (`transferLink`), as each of the profile pages shows a new one. */
  transferId: string;
}

/**
 * What `PATCH /api/users/me/profile` changes, as the profile's form saves it. What's left out stays as
 * it is, and so does the password when it's blank.
 */
export interface ProfileChanges {
  name?: string;
  emailAddress?: string;
  password?: string;
  bio?: string;
  /** The password you have, which changing your email address or password needs while you have one. */
  currentPassword?: string;
  /**
   * The endpoint of this browser's push subscription, which a new password keeps while it forgets your
   * others, as signing out names the one it forgets (`SignOut`).
   */
  pushSubscriptionEndpoint?: string;
}

/** What the Set up Ember form shows in its Name and Email address fields while they're empty. */
export interface SetupPlaceholders {
  name: string;
  emailAddress: string;
}

/**
 * How setup can be reached from where the app runs, while Ember waits to be set up:
 * - "password": with the deployment's setup password, which Deploy to Cloudflare's form asks the deployer
 *   to make up (`EMBER_SETUP_PASSWORD`), typed into the page;
 * - "link": with the setup link a deploy from a terminal prints, which ends in the deployment's
 *   `EMBER_SETUP_TOKEN`;
 * - "open": by whoever is here, over loopback, where `wrangler dev` serves, while the deployment has neither;
 * - "closed": by nobody, while it has neither.
 */
export type SetupAccess = "password" | "link" | "open" | "closed";

/** What the app asks first (`GET /api/bootstrap`): whether Ember is set up, and who this browser is signed in as. */
export interface Bootstrap {
  /** "pending" until first run creates the workspace and its first administrator. */
  setup: "pending" | "complete";
  /** What setting Ember up takes from here, while it's pending. */
  setupAccess: SetupAccess;
  /**
   * What the Set up Ember form suggests: Kevin Rose's name and email address, unless the deployment names
   * its own with `EMBER_SETUP_NAME_PLACEHOLDER` and `EMBER_SETUP_EMAIL_PLACEHOLDER`.
   */
  setupPlaceholders: SetupPlaceholders;
  /** Whether people may sign in with just a name (`EMBER_GUEST_SIGN_IN`). */
  guestSignIn: boolean;
  /**
   * Whether the sign-in page offers Sign in with Memberful, once the deployment has the keys of its
   * Memberful site's custom app: while Memberful lets that site's members join, or while anyone here signs
   * in with an account there, as members who joined with it keep doing once it's off.
   */
  signInWithMemberful: boolean;
  /**
   * The site key of the Turnstile widget whose check the open sign-up form shows, and the forms that ask
   * Ember to email a link to join or a code to reset a password, to check that whoever fills them in is a
   * person: the deployment's `TURNSTILE_SITE_KEY`, while it has both Turnstile's keys, or else the one an
   * administrator gave in Set up Turnstile, or null while Ember has neither.
   */
  turnstileSiteKey: string | null;
  /**
   * Whether someone who forgot their password can have Ember email them a code to choose a new one with,
   * as the sign-in page then offers: while Ember can send email, from the From address an administrator
   * gave it.
   */
  passwordResetCodes: boolean;
  /** "Ember" before setup. */
  account: Account;
  /** This deployment's version: `APP_VERSION`, else `GIT_REVISION`, else the release. */
  version: string;
  /**
   * The public key browsers subscribe to push notifications with, in URL-safe Base64, or null while Web
   * Push is off.
   */
  vapidPublicKey: string | null;
  /** The browser and system that asked, which choose the steps the notification setup help gives. */
  platform: Platform;
  user: Me | null;
}

/**
 * A browser and the system it runs on, so Chromium Edge and Brave count as Chrome, for instance.
 */
export interface Platform {
  /** An iPhone or an iPad, though iPadOS Safari says it's a Mac. */
  ios: boolean;
  android: boolean;
  /** Neither an iPhone, an iPad nor Android. */
  desktop: boolean;
  windows: boolean;
  /** Chrome, or a browser that says it is, such as Chromium Edge, Brave, and Chrome on iPhone and iPad. */
  chrome: boolean;
  /** Firefox, but for Firefox on iPhone and iPad, which counts as Safari. */
  firefox: boolean;
  safari: boolean;
  /** Edge before it was built on Chrome. */
  edge: boolean;
  /** The browser's name, such as "Chrome", or "" when none can be read. */
  browser: string;
  /** The system's name, such as "macOS", "Windows", "iPhone", "Android" or "Linux", or "" when none can be read. */
  operatingSystem: string;
}

/**
 * Someone new with an email address and password: the workspace's first administrator, as the Set up
 * Ember form sends them to `POST /api/first_run`, or someone joining, as the join form sends them to
 * `POST /api/join/<code>`.
 */
export interface SignUp {
  name: string;
  emailAddress: string;
  password: string;
}

/**
 * Someone signing up while anyone may, as the open sign-up form sends them to `POST /api/join`: as the
 * join form does, with the token Turnstile's check gave the page while Ember has a widget's keys.
 */
export interface OpenSignUp extends SignUp {
  turnstileToken?: string;
}

/** The most characters a Turnstile token has, as Cloudflare's siteverify takes it. */
export const MAX_TURNSTILE_TOKEN_LENGTH = 2048;

/**
 * Someone joining with a link Ember emailed them, as its form sends them to `POST /api/join/invitation`
 * for an invitation's, or `POST /api/join/email` for one they asked for with an address at the
 * workspace's email domains: the secret in the link's fragment, and a name and password. The email
 * address is the link's.
 */
export interface EmailLinkSignUp {
  token: string;
  name: string;
  password: string;
}

/**
 * What a link Ember emails people to join with is: an administrator's invitation, or one someone asked
 * for with an address at the workspace's email domains.
 */
export type EmailLinkKind = "invitation" | "email_domain";

/** What `POST /api/email_links/lookup` answers for a link that works: whom it's for, which looking spends nothing of. */
export interface EmailLinkFor {
  kind: EmailLinkKind;
  emailAddress: string;
}

/** Why an invitation's link doesn't work, whatever the reason, as its page and its form say. */
export const INVITATION_GONE = "This invitation has expired, been used, or been replaced by a newer one. Ask whoever invited you to send another.";

/** Why a link someone asked for with their email address doesn't work, whatever the reason, as its page and its form say. */
export const EMAIL_LINK_GONE = "This link has expired, been used, or been replaced by a newer one.";

/**
 * Someone asking for a link to join with their email address, at one of the workspace's email domains,
 * as `/join/email`'s form sends it to `POST /api/email_links`, with the token Turnstile's check gave the
 * page while Ember has a widget's keys.
 */
export interface EmailLinkRequest {
  emailAddress: string;
  turnstileToken?: string;
}

/**
 * How many times Ember emails an address in an hour, at most, whoever asks, so that nobody can have
 * Ember email someone over and over: links to join with it at the email domains and codes to reset its
 * password together.
 */
export const EMAILS_PER_ADDRESS = 3;

/**
 * How many links to join a network may ask for in an hour while Ember lacks Turnstile's keys, whose
 * check stops the scripts that would ask for many addresses at once.
 */
export const EMAIL_LINKS_PER_NETWORK = 10;

/** Why `/join/email` sends no link to a network that has asked for as many as it may in an hour. */
export const EMAIL_LINKS_LIMITED = "Too many links asked for from your network. Try again in an hour.";

/** Why `/join/email` sends no link while Ember can't send email. */
export const CANT_EMAIL_LINKS = "Ember can't email links right now. Try again later, or ask an administrator to invite you.";

/** Why `/join/email` sent no link when the email provider refused to send it. */
export const EMAIL_LINK_UNSENT = "Ember couldn't email you just now. Try again later.";

/**
 * Whose password to reset, and to what, as `POST /api/recovery/reset-password` takes it from
 * apps/worker/scripts/reset-password.ts.
 */
export interface PasswordReset {
  emailAddress: string;
  password: string;
}

/**
 * Someone who forgot their password asking Ember to email them a code to choose a new one with, as the
 * Reset your password page sends it to `POST /api/password_resets`, with the token Turnstile's check
 * gave the page while Ember has a widget's keys. The address is taken as given, as sign-in takes it.
 */
export interface PasswordResetRequest {
  emailAddress: string;
  turnstileToken?: string;
}

/**
 * A new password, with the code Ember emailed the address to choose it with, as the Reset your password
 * page sends it to `PUT /api/password_resets`.
 */
export interface PasswordResetWithCode {
  emailAddress: string;
  code: string;
  password: string;
}

/**
 * What a new password chosen with a code answers: who it signed this browser in as, or null when they
 * sign in themselves, as someone who signs in with Memberful while it's members only does.
 */
export interface PasswordResetDone {
  user: Me | null;
}

/**
 * The codes Ember emails to reset a password: how many digits one has, how many minutes it works for, as
 * its email and page say, and how many times it can be tried before it stops working, so that guessing
 * one takes far more tries than anyone gets. An address is emailed as often as `EMAILS_PER_ADDRESS`
 * says, and a network may ask for a code as often as `PASSWORD_RESETS_PER_NETWORK` says while Ember
 * lacks Turnstile's keys.
 */
export const PASSWORD_RESET_CODE_DIGITS = 8;
export const PASSWORD_RESET_CODE_MINUTES = 15;
export const PASSWORD_RESET_CODE_TRIES = 5;
export const PASSWORD_RESETS_PER_NETWORK = 10;

/** Why the Reset your password page emails no code while Ember can't send email. */
export const CANT_EMAIL_CODES = "Ember can't email you a code right now. Ask an administrator for help.";

/** Why the Reset your password page emails no code to a network that has asked for as many as it may in an hour. */
export const PASSWORD_RESETS_LIMITED = "Too many codes asked for from your network. Try again in an hour.";

/** Why a new password is refused without a code of the right shape. */
export const PASSWORD_RESET_CODE_NEEDED = `Enter the ${PASSWORD_RESET_CODE_DIGITS}-digit code from the email.`;

/**
 * Why a new password is refused with a code that doesn't work, whatever the reason, so that the answer
 * never says who has an account: mistyped, expired, replaced by a newer one, or tried too often.
 */
export const PASSWORD_RESET_CODE_WRONG = "That code is wrong or no longer works. Check the newest email from Ember, or send another code.";

/** Why a code isn't checked once its network has tried as many codes and passwords as sign-in lets it. */
export const PASSWORD_RESET_LIMITED = "Too many tries. Please wait a few minutes and try again.";

/** What the workspace says once a new password has signed someone in. */
export const PASSWORD_RESET_DONE = "Your password has been reset.";

/** What the sign-in page says once a new password has been chosen by someone who signs in themselves. */
export const PASSWORD_RESET_SIGN_IN = "Your password has been reset. Sign in with it.";

/** What `POST /api/first_run` answers: the administrator it signed in, and general, which opens first. */
export interface NewWorkspace {
  user: Me;
  room: SharedRoom;
}

/** Signing in with an email address and password (`POST /api/session`). */
export interface PasswordSignIn {
  emailAddress: string;
  password: string;
  /**
   * The page to come back to, a page of the workspace, if signing in goes on at the Memberful site, to
   * connect a member's account there first (`MemberfulConnection`), as Sign in with Memberful names it.
   */
  returnTo?: string;
}

/** Signing in with a sign-in link (`POST /api/session/transfers`): its id, which the link's address keeps out of every request's. */
export interface LinkSignIn {
  transferId: string;
}

/** What `POST /api/unfurl` answers for a link with a preview. A link without one gets 204. */
export interface LinkPreview {
  title: string;
  /** The page's og:url when that's a public http(s) URL, else the link that was sent. */
  url: string;
  /** The page's og:image when a HEAD for it answers a JPEG, PNG, GIF or WebP content type. */
  image: string | null;
  description: string;
}

/**
 * The answer to a sign-in Ember refuses: a wrong password, an unknown email address, or an account
 * removed or banned.
 */
export const SIGN_IN_REJECTED = "Incorrect email or password. Please try again.";

/**
 * The answer once an address has tried to sign in too often, which checking a password anywhere counts
 * against.
 */
export const SIGN_IN_LIMITED = "Too many sign-in attempts. Please wait a few minutes and try again.";

/**
 * Campfire's one answer to a sign-in it refuses, which a Memberful sign-in Ember refuses still gets,
 * since it can't say which of the two went wrong.
 */
export const SIGN_IN_REFUSED = "Too many requests or unauthorized.";

/**
 * Where the sign-in page's Sign in with Memberful goes, which sends the browser on to sign in at the
 * Memberful site, naming the page to come back to in `return_to`.
 */
export const MEMBERFUL_SIGN_IN_PATH = "/auth/memberful";

/** Where Memberful sends the browser back to, which the Memberful site's custom app names as its OAuth redirect URL. */
export const MEMBERFUL_CALLBACK_PATH = "/auth/memberful/callback";

/**
 * Where the Memberful site's webhooks go, which say when a member's membership changes. Memberful signs
 * each, and the Worker checks what it says with Memberful.
 */
export const MEMBERFUL_WEBHOOK_PATH = "/webhooks/memberful";

/** Signing in with Memberful, coming back to `returnTo`, a page of the workspace, once signed in, or home without one. */
export const memberfulSignInPath = (returnTo: string | null) =>
  returnTo === null ? MEMBERFUL_SIGN_IN_PATH : `${MEMBERFUL_SIGN_IN_PATH}?return_to=${encodeURIComponent(returnTo)}`;

/**
 * Where your profile's Connect Memberful goes, which answers where to sign in at the Memberful site
 * (`MemberfulConnection`) once it knows it's you.
 */
export const MEMBERFUL_CONNECTIONS_PATH = "/api/users/me/memberful_connections";

/**
 * What connecting your account to a Memberful account from your profile takes (`POST
 * /api/users/me/memberful_connections`): your password, while you have one, so that holding your session
 * isn't enough to add a way into your account, as changing your email address or password takes it.
 */
export interface MemberfulConnectionStart {
  currentPassword?: string;
}

/**
 * The Memberful account you've connected, as Memberful described it when you connected it or last
 * signed in with it: its name and email address there, either null when Memberful didn't say, or for
 * an account connected before Ember kept them, until you sign in with it again.
 */
export interface MemberfulAccount {
  name: string | null;
  emailAddress: string | null;
}

/**
 * Where you stand with Memberful, as your profile's Memberful section shows it: the account you've
 * connected, which you sign in with, or null while you haven't, when the section offers Connect
 * Memberful, and whether Memberful is members only, when members sign in with Memberful alone, unless
 * they need no membership (`Profile.membershipNeeded`).
 */
export interface MemberfulStatus {
  membersOnly: boolean;
  connected: MemberfulAccount | null;
}

/**
 * What disconnecting your Memberful account from your profile takes (`DELETE
 * /api/users/me/memberful_connections`): your password, so that holding your session isn't enough to
 * change how you sign in, as connecting one takes it, and this browser's push subscription, if it has
 * one, which it keeps while it forgets your other browsers', as a new password does.
 */
export interface MemberfulDisconnection {
  currentPassword?: string;
  pushSubscriptionEndpoint?: string;
}

/**
 * Where to sign in at the Memberful site, within ten minutes, to connect the account you sign in to there
 * to yours here: what connecting from your profile answers, and what signing in with a password answers a
 * member whose password checks out while Memberful is members only, until they've connected one.
 * Memberful sends the browser back, which connects it. Asked at an address Ember has moved from to its
 * custom domain, where Memberful doesn't send it back, it's the page to come back to at the custom domain
 * instead, to sign in and connect there.
 */
export interface MemberfulConnection {
  memberfulConnection: string;
}

/**
 * Why a Memberful sign-in didn't sign anyone in, or didn't connect an account, which the callback sends
 * the browser back to sign in with, as `?memberful=`, or to your profile when it's signed in as you, and
 * what that page then says.
 */
export const MEMBERFUL_SIGN_IN_PROBLEMS = {
  /** Memberful sent the browser back without a sign-in, or with one this browser didn't start, or didn't answer as it should. */
  failed: "Signing in with Memberful didn't work. Try again.",
  /** The Memberful account has no active subscription, nor the all access pass. */
  membership: "Your Memberful account has no active membership.",
  /**
   * Someone here has the Memberful account's email address already, and accounts are never matched by it,
   * but connected by its owner, as signing in with that password does while Memberful is members only.
   */
  taken: "Someone here has your Memberful email address already. If that's you, sign in with your password.",
  /** The Memberful account is connected to someone else here already. */
  claimed: "That Memberful account is connected to someone else here.",
  /** Your account is connected to another account at the Memberful site already. */
  another: "Your account is connected to another Memberful account already.",
  /** Someone new signed in with Memberful while an administrator has Memberful off. */
  off: "Joining with Memberful is off.",
  /** Someone connected their account to one at Memberful once Memberful stopped being members only, when their password signs them in. */
  unneeded: "Memberful isn't members only anymore, so there's nothing to connect. Your password signs you in.",
  /** It's on, but the deployment has no Memberful keys. */
  unavailable: "Memberful sign-in isn't set up. Ask an administrator for help.",
  /** Too many sign-ins from the address, or the account was removed or banned, which this doesn't tell apart. */
  refused: SIGN_IN_REFUSED,
} as const;
export type MemberfulSignInProblem = keyof typeof MEMBERFUL_SIGN_IN_PROBLEMS;

/** The query parameter that names a Memberful sign-in's problem, or says that your profile connected your Memberful account. */
export const MEMBERFUL_PROBLEM_PARAM = "memberful";

/** What that parameter says once your Memberful account is connected, and what your profile then says. */
export const MEMBERFUL_CONNECTED = "connected";
export const MEMBERFUL_CONNECTED_NOTICE = "Your Memberful account is connected.";

/** The problem `value` names, or null for none it names. */
export const memberfulProblemOf = (value: string | null): MemberfulSignInProblem | null =>
  value !== null && Object.hasOwn(MEMBERFUL_SIGN_IN_PROBLEMS, value) ? (value as MemberfulSignInProblem) : null;

/** Why connecting Memberful from your profile is refused without your password, while you have one. */
export const MEMBERFUL_PASSWORD_NEEDED = "Enter your password to connect Memberful.";

/** Why disconnecting it is refused without your password. */
export const MEMBERFUL_DISCONNECT_PASSWORD_NEEDED = "Enter your password to disconnect Memberful.";
/** Why it's refused while you have no password, which you'd have nothing to sign in with without, and which Memberful signing you in gives you none of. */
export const MEMBERFUL_DISCONNECT_WITHOUT_PASSWORD = "You sign in with Memberful alone, so it can't be disconnected.";
/** Why it's refused while you have no email address, which signing in with your password takes. */
export const MEMBERFUL_DISCONNECT_WITHOUT_EMAIL = "Add your email address first, so that you can still sign in once Memberful is disconnected.";
/** Why it's refused while you haven't connected a Memberful account. */
export const MEMBERFUL_NOT_CONNECTED = "Your account isn't connected to a Memberful account.";
/** What your profile says once your Memberful account is disconnected. */
export const MEMBERFUL_DISCONNECTED_NOTICE = "Your Memberful account is disconnected.";

/** Why signing in with a password, joining with the join link, or signing in with just a name is refused while Memberful is members only. */
export const MEMBERFUL_SIGN_IN_NEEDED = "Members sign in with Memberful. Only administrators and invited people sign in with a password.";

/**
 * Why a page for joining sent the browser to sign in instead, which the address names as `?joining=`,
 * and what the sign-in page then says: the join link is off, though its code is right, Open is, or
 * Email domain is.
 */
export const JOINING_PROBLEMS = {
  link_off: "Joining by link is off.",
  closed: "Signing up is closed.",
  email_off: "Joining with an email address is off.",
} as const;
export type JoiningProblem = keyof typeof JOINING_PROBLEMS;

/** The query parameter that names why joining sent the browser to sign in. */
export const JOINING_PARAM = "joining";

/** The problem `value` names, or null for none it names. */
export const joiningProblemOf = (value: string | null): JoiningProblem | null =>
  value !== null && Object.hasOwn(JOINING_PROBLEMS, value) ? (value as JoiningProblem) : null;

/** The sign-in page, saying why joining sent the browser there. */
export const signInSaying = (problem: JoiningProblem) => `/session/new?${JOINING_PARAM}=${problem}`;

/**
 * Open sign-up's limits, which stand in for Turnstile's check while Ember lacks its keys: how many
 * people may sign up from an IP address in an hour, and how many new people in the workspace in the last
 * hour, however they joined, stop it, so that a flood can't use up the rows a Workers Free account
 * writes in a day.
 */
export const SIGN_UPS_PER_ADDRESS = 5;
export const SIGN_UPS_PER_HOUR = 50;

/** Why open sign-up refuses someone from an IP address that has signed up as many times as it may in an hour. */
export const SIGN_UP_LIMITED = "Too many sign-ups from your network. Try again in an hour.";

/** Why open sign-up refuses anyone once the workspace has let in as many new people as it does in an hour. */
export const SIGN_UP_FULL = "Lots of people have signed up in the last hour. Try again later.";

/** Why open sign-up refuses a form whose Turnstile check didn't pass, or that came without one. */
export const TURNSTILE_FAILED = "Ember couldn't check that you're a person. Try again.";

/**
 * What a room closes a socket with when access to it ends. A close code says the same and can't go
 * missing, as a frame sent just before the close can.
 */
export const CloseCode = {
  /**
   * Connect again: this browser signed out, say, or the room couldn't trust the connection's sign-in,
   * and a new connection is checked afresh. The app asks at once whether it's still signed in, rather
   * than waiting for the new connection to be refused.
   */
  Reconnect: 4001,
  /** Don't connect again: the person was removed from the workspace or banned, which ended all their sessions. */
  Revoked: 4003,
  /**
   * Don't connect again: the room isn't there for this person, who was taken out of it, or it was
   * deleted. The Worker says so with a socket it closes at once, since a refused upgrade looks to the
   * app like any network failure.
   */
  NotFound: 4004,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/**
 * The shortest new password Ember takes, in characters rather than bytes.
 */
export const MIN_PASSWORD_LENGTH = 8;
/** The password fields' `maxlength`, which Campfire's profile form keeps from bcrypt's 72-byte limit. */
export const MAX_PASSWORD_LENGTH = 72;
export const PASSWORD_TOO_SHORT = "Password must be at least 8 characters.";
export const PASSWORD_TOO_LONG = "Password must be at most 72 characters.";
/** Why a change to your email address or password is refused without your current password. */
export const CURRENT_PASSWORD_NEEDED = "Enter your current password to change your email address or password.";
/** Why it's refused with a current password that isn't yours. */
export const CURRENT_PASSWORD_WRONG = "That isn't your current password.";
/**
 * Why a first password is refused to someone Memberful signs in, while it does: it's their way in, and
 * a password that whoever holds their session could set would be another.
 */
export const PASSWORD_WITH_MEMBERFUL = "You sign in with Memberful, so there's no password to set.";

export interface Boost {
  id: string;
  messageId: string;
  booster: User;
  content: string;
  createdAt: string;
}

export interface Message {
  id: string;
  /** Generated by the sender so its optimistic copy can be reconciled with the stored one. */
  clientMessageId: string;
  roomId: RoomId;
  creator: User;
  /**
   * Its text as rich text: the markup the room keeps of what the sender wrote (`prepareBody` in
   * packages/richtext). Clients show it through `displayBody`, never as markup.
   */
  body: string;
  /** Its plain text, as Action Text writes it, read from `body` when it was written. */
  plainText: string;
  /**
   * The people it mentions, once each, in order, named as they were when its text was last written. A
   * mention shows someone by the name they have now, which the people directory knows.
   */
  mentions: User[];
  createdAt: string;
  updatedAt: string;
  /** When its text last changed, or a bot changed its file, or null if neither has. */
  editedAt: string | null;
  boosts: Boost[];
  /**
   * A file message's file, which it shows in place of its text. Its text is empty, and its plain text
   * the file's name.
   */
  attachment?: StoredFile;
  /**
   * A bot's cards, which show under its text, as a Slack incoming webhook's blocks and attachments do: its
   * text may be empty then, and its plain text has theirs after its own.
   */
  cards?: Card[];
  /** A reply in a thread: the message it replies to, its parent, which is never a reply itself. */
  parentId?: string;
  /** Whether a reply was also sent to the room, whose timeline shows it then as well as its thread. */
  alsoSent?: boolean;
  /** The start of a reply's parent's plain text, which the room shows over a reply also sent there: empty once the parent is deleted. */
  parentText?: string;
  /** The replies in the message's thread, once it has some, as the room shows them under it. */
  thread?: ThreadSummary;
  /**
   * A message deleted while replies in its thread are left, which keeps its place for them: its text, file,
   * cards and boosts are gone, and it goes once its last reply does.
   */
  deleted?: boolean;
}

/** How much of a reply's parent's plain text the room shows over a reply also sent there, which it cuts to one line. */
export const PARENT_TEXT_LENGTH = 150;

/** The start of `plainText` a reply shows of its parent (`parentText`), cut as SQLite's `substr` cuts it, by characters. */
export const parentTextOf = (plainText: string) => [...plainText].slice(0, PARENT_TEXT_LENGTH).join("");

/** How many of the people who replied in a thread its summary shows. */
export const THREAD_FACES = 4;

/** A thread, as the room shows it under the message it's for. */
export interface ThreadSummary {
  /** How many replies it has. */
  count: number;
  /** When the newest was written. */
  latestAt: string;
  /** Who wrote the replies, each once, the one who wrote the newest first, up to `THREAD_FACES`. */
  people: User[];
}

/** Whether a message shows in its room's timeline: every message but a reply that was sent only to its thread. */
export const isInRoom = (message: Pick<Message, "parentId" | "alsoSent">) => message.parentId === undefined || message.alsoSent === true;

/**
 * What a tab sends on a room socket. A socket from an IP address a ban blocks can read, but the room
 * answers each frame that would change messages or boosts with an `error`.
 */
export type ClientFrame =
  /**
   * A new message, its body markup, as the composer writes it. The room keeps what it can show of it, or refuses it.
   * With `parentId`, it's a reply in that message's thread, which `alsoSend` sends to the room too.
   */
  | { type: "message.create"; clientMessageId: string; body: string; parentId?: string; alsoSend?: boolean }
  /** A message's new body, as for `message.create`. */
  | { type: "message.update"; messageId: string; body: string }
  | { type: "message.delete"; messageId: string }
  | { type: "boost.create"; messageId: string; content: string }
  | { type: "boost.delete"; boostId: string }
  | { type: "typing.start" }
  | { type: "typing.stop" }
  /** Up to `limit` messages before a message, oldest first, as history pages back from the oldest the timeline holds. */
  | { type: "history.before"; before: string; limit?: number }
  /** Up to `limit` messages after a message, as history pages forward from the newest the timeline holds while it's behind. */
  | { type: "history.after"; after: string; limit?: number }
  /**
   * The page around a message, as its permalink opens the room: up to a page before it, it, and up to a
   * page after. Without one, or for one the room doesn't have, the newest page, as Jump to newest message shows.
   */
  | { type: "history.around"; messageId?: string }
  /** Asks which of these messages the room stored from the sender, after a closed socket lost their confirmations. */
  | { type: "message.check"; clientMessageIds: string[] }
  /**
   * A message's thread, as opening it shows it: the message and its newest page of replies. Its person
   * views the thread as they view the room, and isn't pushed the replies sent only to it, until the tab
   * closes it or opens another.
   */
  | { type: "thread.open"; parentId: string }
  /** Says the tab has closed the thread it opened. */
  | { type: "thread.close"; parentId: string }
  /** Up to `limit` of a thread's replies before one, oldest first, as its history pages back from the oldest it holds. */
  | { type: "thread.before"; parentId: string; before: string; limit?: number }
  /** Says the tab has been shown, or hidden, for a few seconds, since the socket's address or the last of these said otherwise. */
  | { type: "presence.visible"; visible: boolean }
  /**
   * A click on a button that acts, on one of a bot's message's cards: the button `actionId` names there, in the
   * block `blockId` names when it has one, with the `value` it has, which tells apart two that share a name.
   * The room reports it to the bot, and answers `card.clicked`, or an `error`, with `clickId`, which the tab
   * makes up.
   */
  | { type: "card.click"; clickId: string; messageId: string; actionId: string; blockId?: string; value?: string }
  | { type: "ping" };

/**
 * A page of a room's messages that takes the timeline's place: the newest, or the one around a message.
 */
export interface TimelinePage {
  /** Oldest first. */
  messages: Message[];
  /** Whether the room has messages older than the page. */
  hasMore: boolean;
  /** Whether it has newer ones, which only a page around a message can leave out. */
  hasNewer: boolean;
  /** The message the page is around, or null for the newest page. */
  around: string | null;
}

/**
 * What a room sends on a socket. The room numbers the changes to its messages, 1 for its first and one
 * more for each after: the frame that announces a change carries its number as `seq`, and a welcome or
 * `resumed` the latest. A tab that connects again names the latest it has seen (`since` in
 * `RoomSocketParams`), so the room can send only what changed after it.
 */
export type ServerFrame =
  /**
   * Everything a newcomer needs, including who's here. After it, they only hear who arrives and leaves. Its
   * page is the newest, or the one around the message the socket's address names, if the room has it.
   */
  | ({ type: "welcome"; you: User; present: User[]; seq: number } & TimelinePage)
  /**
   * Sent in place of a welcome to a tab that names the latest change it has seen, if the room still
   * keeps every change since: the messages changed after it, as they are now, oldest first, the ids of
   * those deleted, and who's here. A message both made and deleted since is among the deleted alone.
   */
  | { type: "resumed"; you: User; messages: Message[]; deletedIds: string[]; present: User[]; seq: number }
  /** A new message. Its author has stopped typing, too. */
  | { type: "message.created"; message: Message; seq: number }
  | { type: "message.updated"; message: Message; seq: number }
  | { type: "message.deleted"; messageId: string; seq: number }
  | { type: "boost.created"; boost: Boost; seq: number }
  | { type: "boost.deleted"; boostId: string; messageId: string; seq: number }
  /** Someone opened the room who didn't have it open already, in another tab. */
  | { type: "presence.joined"; user: User }
  /** Someone closed the last tab they had the room open in, which stops their typing, too. */
  | { type: "presence.left"; userId: UserId }
  /**
   * Someone started or stopped typing: in the room's composer, or, with `threadId`, in that thread, where
   * only @ember types, as it answers there.
   */
  | { type: "typing"; user: User; typing: boolean; threadId?: string }
  /** Answers history.before: the page before `before`, oldest first, and whether there are older ones still. */
  | { type: "history"; before: string; messages: Message[]; hasMore: boolean }
  /** Answers history.after: the page after `after`, oldest first, and whether there are newer ones still. */
  | { type: "history.after"; after: string; messages: Message[]; hasNewer: boolean }
  /** Answers history.around with a page to show in the timeline's place. */
  | ({ type: "history.around" } & TimelinePage)
  /** Answers message.check: which of the sender's messages the room stored, and which it never received. */
  | { type: "message.checked"; stored: string[]; missing: string[] }
  /**
   * Answers thread.open: the message, or null when the room doesn't have it or it's a reply, which has no
   * thread, and its newest page of replies, oldest first, with whether it has older ones.
   */
  | { type: "thread.opened"; parentId: string; parent: Message | null; messages: Message[]; hasMore: boolean }
  /** Answers thread.before: the replies before `before`, oldest first, and whether there are older ones still. */
  | { type: "thread.history"; parentId: string; before: string; messages: Message[]; hasMore: boolean }
  /** Answers card.click once the bot has answered the click: what it does to the room, if anything, comes as any change does. */
  | { type: "card.clicked"; clickId: string }
  /**
   * `failed` names the request that went wrong, when the error answers one, and `clientMessageId` or
   * `clientMessageIds` the messages it was about, or `clickId` the click.
   */
  | { type: "error"; message: string; clientMessageId?: string; clientMessageIds?: string[]; clickId?: string; failed?: ClientFrame["type"] }
  | { type: "pong" };

/**
 * What a tab sends on its workspace socket (`/api/socket`): only pings, which the runtime answers
 * without waking the Workspace.
 */
export type WorkspaceClientFrame = { type: "ping" };

/** What the Workspace sends on a tab's workspace socket. */
export type WorkspaceServerFrame =
  /** Sent as the Workspace lets the socket in: who its session signs in, and the workspace as it is then. */
  | { type: "welcome"; you: Me; account: Account }
  /**
   * A room of theirs has a message they haven't seen, which marks it unread, as of `at`, when that message
   * came. Sent only to the person marked, as their mark changes.
   */
  | { type: "room.unread"; roomId: RoomId; at: string }
  /** They've read a room marked unread, in this tab or another. */
  | { type: "room.read"; roomId: RoomId }
  /**
   * Someone changed, as the people directory now lists them: they changed their profile, or an
   * administrator gave them another role, removed them, banned them or lifted their ban. Sent to everyone.
   */
  | { type: "user.updated"; user: DirectoryUser }
  /**
   * A room of theirs as it is now, sent to everyone in it when it's made, renamed, given another icon,
   * opened to everyone or made private, and to whoever a change puts in it, and to everyone in a DM
   * when it's started. A room they have keeps its mark, and one new to them starts read.
   */
  | { type: "room.saved"; room: Room }
  /** A room that's no longer theirs: deleted, or they've been taken out of it. Nobody else hears of it. */
  | { type: "room.gone"; roomId: RoomId }
  /**
   * A message came in a DM of theirs at `at`, which lists it first among their DMs, unless they've heard
   * of a later one. Sent to everyone in the DM, its author included, as the Workspace applies the message.
   */
  | { type: "room.active"; roomId: RoomId; at: string }
  /**
   * Who's in the huddle of a room of theirs now, or null once nobody is. Sent to everyone in the room, in
   * the huddle or not, as people join it and leave, and to whoever a change puts in a room with one going on.
   */
  | { type: "room.huddle"; roomId: RoomId; huddle: LiveHuddle | null }
  /** They've starred or unstarred a room, in this tab or another: their stars as they are now. */
  | { type: "favorites.changed"; favorites: Favorites }
  /** They've given a room of theirs another notification level, in this tab or another. */
  | { type: "room.involvement"; roomId: RoomId; involvement: Involvement }
  /** They've dismissed the welcome card, in this tab or another, so their sidebar has no invitation from now on. */
  | { type: "invitation.dismissed" }
  /**
   * An administrator saved the shared room order, so the sidebar loads again. It names no rooms, since
   * some aren't everyone's. Sent to everyone, and to the people a room the order ranks takes in, whose
   * sidebars' order left it out.
   */
  | { type: "rooms.reordered" }
  /** An administrator changed the workspace's name, settings or custom CSS, which every page applies at once. Sent to everyone. */
  | { type: "account.updated"; account: Account }
  | { type: "error"; message: string }
  | { type: "pong" };

/**
 * The revision of the room protocol the app speaks, which its room sockets' addresses name. The room
 * tells a tab running an older app to reload, and refuses its messages and edits: before revision 2,
 * tabs sent a message's text rather than its markup, which the room would now read as markup, before
 * revision 3, an edit dropped the message's mentions, and before revision 4, tabs knew nothing of
 * threads, and showed every reply in the room.
 */
export const ROOM_PROTOCOL = 4;

/** What a room socket's address tells the room about the tab opening it. */
export interface RoomSocketParams {
  /** Whether the tab is shown, which `presence.visible` frames update. */
  visible: boolean;
  /**
   * The latest change to the room the tab has seen, by its `seq`, when it has the room's messages from
   * an earlier socket: the room answers with what changed since (`resumed`) rather than a welcome, if it can.
   */
  since?: number;
  /**
   * The message whose permalink the tab opened the room at, which its welcome brings the page around, if the
   * room has it. Named only until the first welcome, since a socket that connects again keeps the tab's page.
   */
  around?: string;
}

/** The query that carries `params` on a room socket's address, with the revision of the protocol the tab speaks. */
export const roomSocketQuery = ({ visible, since, around }: RoomSocketParams) =>
  `?visible=${visible ? 1 : 0}&protocol=${ROOM_PROTOCOL}` +
  (since === undefined ? "" : `&since=${since}`) +
  (around === undefined ? "" : `&around=${encodeURIComponent(around)}`);

/** The part of a `URLSearchParams` that reading a socket's address needs, which the protocol, made for every runtime, names itself. */
interface SearchParams {
  get(name: string): string | null;
}

/** A change's number as an address writes it, or undefined for anything else. */
const parseSeq = (value: string | null) => (value !== null && /^\d{1,15}$/.test(value) ? Number(value) : undefined);

/** A message's id as an address names it, or undefined for none, or for what no message's id could be. */
const messageIdOf = (value: string | null) => (value !== null && id(value) ? value : undefined);

/**
 * What a room socket's address says about its tab, as `roomSocketQuery` wrote it, and the revision of the
 * protocol it speaks. A tab that doesn't say counts as shown and new to the room, and one naming no
 * revision speaks the first, as the app did before it named them.
 */
export const parseRoomSocketParams = (query: SearchParams): RoomSocketParams & { protocol: number } => ({
  visible: query.get("visible") !== "0",
  since: parseSeq(query.get("since")),
  around: messageIdOf(query.get("around")),
  protocol: Number(query.get("protocol")) || 1,
});

/** The most characters a message's plain text can have. */
export const MAX_MESSAGE_LENGTH = 10_000;
/** What the room says of a message with more, which the app says itself rather than send one. */
export const MESSAGE_TOO_LONG = `Messages can be up to ${MAX_MESSAGE_LENGTH.toLocaleString("en-US")} characters.`;
/** Whether a message whose plain text is `plainText` is longer than the room takes. */
export const isMessageTooLong = (plainText: string) => plainText.length > MAX_MESSAGE_LENGTH;
/** The most characters of markup a message can arrive as: room for the longest message, formatted. */
export const MAX_MESSAGE_HTML_LENGTH = 100_000;
/** As long as Campfire's `boosts.content` column can be (`limit: 16`, db/schema.rb). */
export const MAX_BOOST_LENGTH = 16;
/**
 * Campfire's page of messages (`Message::PAGE_SIZE`): the newest a room opens on, what each page of
 * history adds before or after the timeline, and how many a permalink shows on either side of its
 * message.
 */
export const HISTORY_PAGE_SIZE = 40;
/** How many messages one message.check can ask about: more than anyone sends before a dead socket is noticed. */
export const MAX_CHECKED_MESSAGES = 50;
/** Keeps a room's name to what a sidebar row and a room's header can show. */
export const MAX_ROOM_NAME_LENGTH = 100;
/** Keeps the workspace's name to what the sidebar's heading can show. */
export const MAX_ACCOUNT_NAME_LENGTH = 100;
/**
 * What fits on one line under the name at the top of the sidebar, at its full 280px and in the drawer of
 * a phone from 375px wide, as an App Store app's subtitle takes 30 characters under its name. A narrower
 * sidebar, or wider letters, can wrap it onto a second line.
 */
export const MAX_TAGLINE_LENGTH = 30;
export const TAGLINE_TOO_LONG = `Tagline must be at most ${MAX_TAGLINE_LENGTH} characters`;
/** The longest host name DNS has, which a custom domain can be, with a port. */
const MAX_HOST_NAME_LENGTH = 253;
/**
 * Keeps custom CSS, which every page load and workspace socket carries, well within what a row or a
 * socket's message can hold.
 */
export const MAX_CUSTOM_STYLES_LENGTH = 100_000;
/** How many people one request can name: a bound on the request's size, not on a room's. */
export const MAX_LISTED_USERS = 1_000;
/** How many rooms someone can star. */
export const MAX_FAVORITES = 4_096;
/** How many rooms the shared order can rank. */
export const MAX_SHARED_ORDER = 4_096;
/** The profile's Bio field's `maxlength`, as in Campfire's users/profiles/show.html.erb, which the server keeps too. */
export const MAX_BIO_LENGTH = 200;
/**
 * Keeps a person's or a bot's name to what a byline, a mention and a directory row can show. Every
 * message copies its author's name, so a name of megabytes would swell a room's storage and every page
 * of its history for everyone in it.
 */
export const MAX_USER_NAME_LENGTH = 100;
/** No deliverable address is longer (RFC 5321's path limit). */
export const MAX_EMAIL_ADDRESS_LENGTH = 254;
export const NAME_TOO_LONG = `Name must be at most ${MAX_USER_NAME_LENGTH} characters`;

/** The id of @ember, the account Ember AI answers as, which the Worker adds once an administrator sets Ember AI up. */
export const ASSISTANT_ID: UserId = "ember";
/** @ember's name, which nobody else can take (`isReservedName`). */
export const ASSISTANT_NAME = "Ember";
export const NAME_RESERVED = `${ASSISTANT_NAME} is the AI assistant's name. Choose another.`;

/**
 * Whether `name` is @ember's, which nobody can take, whether or not Ember AI is on, so that nobody passes
 * for it: "Ember" as `sameName` compares names. Anyone who had the name before keeps it.
 */
export function isReservedName(name: string): boolean {
  return sameName(name, ASSISTANT_NAME);
}

/**
 * Whether two names look the same: in any capitals, in any of Unicode's compatible forms, such as
 * fullwidth letters, with spaces around them, an @ before them, or characters that show nothing, such
 * as a zero-width space, in them.
 */
export function sameName(name: string, other: string): boolean {
  return nameAsShown(name) === nameAsShown(other);
}

/** `name` as `sameName` compares it. */
function nameAsShown(name: string): string {
  return name.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/^[\s@]+|\s+$/g, "").toLowerCase();
}

export const EMAIL_ADDRESS_TOO_LONG = `Email address must be at most ${MAX_EMAIL_ADDRESS_LENGTH} characters`;

/** The reactions: the first three are quick reactions, the rest sit in the tray. */
export const REACTIONS = [
  ["👍", "Thumbs up"],
  ["👏", "Clapping"],
  ["👋", "Waving hand"],
  ["💪", "Muscle"],
  ["❤️", "Red heart"],
  ["😂", "Face with tears of joy"],
  ["🎉", "Party popper"],
  ["🔥", "Fire"],
] as const;
export const QUICK_REACTION_COUNT = 3;

const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;
/** How many messages a page asked for may hold: 1 to 100, or undefined for a page's usual size. */
const pageLimit = (v: unknown) => (typeof v === "number" ? Math.min(Math.max(1, Math.floor(v)), 100) : undefined);
/** Whether `v` lists people's ids, as many as one request can name. */
const userIds = (v: unknown): v is UserId[] => Array.isArray(v) && v.length <= MAX_LISTED_USERS && v.every(id);

/** Markup no longer than `MAX_MESSAGE_HTML_LENGTH`, or null. Whether it holds a message is the room's to read. */
const markup = (v: unknown): string | null => (typeof v === "string" && v.length <= MAX_MESSAGE_HTML_LENGTH ? v : null);

/** Trimmed, non-empty text no longer than `max`, or null. */
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
};

/** The JSON object `raw` holds, or null if it holds anything else. */
function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(raw);
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Parses an untrusted frame from a room's socket. Returns null for anything malformed. */
export function parseClientFrame(raw: string): ClientFrame | null {
  const f = parseObject(raw);
  if (!f) return null;

  switch (f.type) {
    case "message.create": {
      const body = markup(f.body);
      if (!id(f.clientMessageId) || body === null) return null;
      if (f.parentId === undefined) return { type: f.type, clientMessageId: f.clientMessageId, body };
      return id(f.parentId) ? { type: f.type, clientMessageId: f.clientMessageId, body, parentId: f.parentId, alsoSend: f.alsoSend === true } : null;
    }
    case "message.update": {
      const body = markup(f.body);
      return id(f.messageId) && body !== null ? { type: f.type, messageId: f.messageId, body } : null;
    }
    case "message.delete":
      return id(f.messageId) ? { type: f.type, messageId: f.messageId } : null;
    case "boost.create": {
      const content = text(f.content, MAX_BOOST_LENGTH);
      return id(f.messageId) && content ? { type: f.type, messageId: f.messageId, content } : null;
    }
    case "boost.delete":
      return id(f.boostId) ? { type: f.type, boostId: f.boostId } : null;
    case "history.before":
      return id(f.before) ? { type: f.type, before: f.before, limit: pageLimit(f.limit) } : null;
    case "history.after":
      return id(f.after) ? { type: f.type, after: f.after, limit: pageLimit(f.limit) } : null;
    case "history.around":
      return f.messageId === undefined || id(f.messageId) ? { type: f.type, messageId: f.messageId } : null;
    case "message.check": {
      const ids = f.clientMessageIds;
      return Array.isArray(ids) && ids.length > 0 && ids.length <= MAX_CHECKED_MESSAGES && ids.every(id)
        ? { type: f.type, clientMessageIds: ids }
        : null;
    }
    case "thread.open":
    case "thread.close":
      return id(f.parentId) ? { type: f.type, parentId: f.parentId } : null;
    case "thread.before":
      return id(f.parentId) && id(f.before) ? { type: f.type, parentId: f.parentId, before: f.before, limit: pageLimit(f.limit) } : null;
    case "presence.visible":
      return typeof f.visible === "boolean" ? { type: f.type, visible: f.visible } : null;
    case "card.click": {
      if (!id(f.clickId) || !id(f.messageId) || !isActionId(f.actionId)) return null;
      if (f.blockId !== undefined && !isActionId(f.blockId)) return null;
      if (f.value !== undefined && !isActionValue(f.value)) return null;
      const { blockId, value } = f;
      return { type: f.type, clickId: f.clickId, messageId: f.messageId, actionId: f.actionId, ...(blockId !== undefined && { blockId }), ...(value !== undefined && { value }) };
    }
    case "typing.start":
    case "typing.stop":
    case "ping":
      return { type: f.type };
    default:
      return null;
  }
}

/** Parses an untrusted frame from a workspace socket. Returns null for anything malformed. */
export function parseWorkspaceClientFrame(raw: string): WorkspaceClientFrame | null {
  return parseObject(raw)?.type === "ping" ? { type: "ping" } : null;
}

/**
 * Whether `value` could name a room. A room's id also names its Durable Object: the Workspace's
 * sortable ids, or the old address of a room from before it kept a list (`LEGACY_ROOMS`).
 */
export function isRoomId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
}

// Built on first use, so a bundle that never checks an icon leaves the names out.
let roomIconNames: ReadonlySet<string> | undefined;

/**
 * Whether `value` is exactly the name of an icon in the catalog: `"coffee"` is, but `" coffee "`,
 * `"Coffee"` and `""`, which stands for the default `#`, aren't.
 */
export function isRoomIcon(value: unknown): value is RoomIconName {
  roomIconNames ??= new Set(ROOM_ICON_NAMES);
  return typeof value === "string" && roomIconNames.has(value);
}

const ICON_REFUSED = 'Icon must be one of the room icons, or "" for the default';

/**
 * A room's icon: undefined when it's left out, which keeps the icon, or null when it's neither "" nor
 * exactly an icon's name.
 */
function iconChoice(value: unknown): RoomIconChoice | null | undefined {
  if (value === undefined) return undefined;
  return value === "" || isRoomIcon(value) ? value : null;
}

/** Parses an untrusted request to create a room. Returns why it's refused instead of the room. */
export function parseNewRoom(data: unknown): NewRoom | string {
  if (typeof data !== "object" || data === null) return "Expected a JSON object";
  const r = data as Record<string, unknown>;
  if (r.kind !== "open" && r.kind !== "closed") return 'Kind must be "open" or "closed"';
  const name = text(r.name, MAX_ROOM_NAME_LENGTH);
  if (!name) return `Name must be 1 to ${MAX_ROOM_NAME_LENGTH} characters`;
  const icon = iconChoice(r.icon);
  if (icon === null) return ICON_REFUSED;
  if (r.kind === "open") return { kind: r.kind, name, icon };
  const memberIds = r.memberIds ?? [];
  return userIds(memberIds) ? { kind: r.kind, name, icon, memberIds } : `Members must be a list of at most ${MAX_LISTED_USERS} user ids`;
}

/**
 * Parses an untrusted change to a room. Returns why it's refused instead of the changes. Making a
 * room private needs its members listed, even if that's nobody, since everyone left out is taken out.
 */
export function parseRoomChanges(data: unknown): RoomChanges | string {
  if (typeof data !== "object" || data === null) return "Expected a JSON object";
  const r = data as Record<string, unknown>;
  const name = r.name === undefined ? undefined : text(r.name, MAX_ROOM_NAME_LENGTH);
  if (name === null) return `Name must be 1 to ${MAX_ROOM_NAME_LENGTH} characters`;
  const icon = iconChoice(r.icon);
  if (icon === null) return ICON_REFUSED;
  const changes = { name, icon };
  if (r.kind === undefined) return changes;
  if (r.kind === "open") return { ...changes, kind: r.kind };
  if (r.kind !== "closed") return 'Kind must be "open" or "closed"';
  return userIds(r.memberIds) ? { ...changes, kind: r.kind, memberIds: r.memberIds } : `Members must be a list of at most ${MAX_LISTED_USERS} user ids`;
}

/** Whether `data` is a JSON object: an array is an object too, but not one that can name a change. */
const isJsonObject = (data: unknown): data is Record<string, unknown> => typeof data === "object" && data !== null && !Array.isArray(data);

/**
 * Parses an untrusted request to start a DM. Returns why it's refused instead of the DM. Naming nobody,
 * or leaving `userIds` out, starts your DM with yourself.
 */
export function parseNewDirect(data: unknown): NewDirect | string {
  if (!isJsonObject(data)) return "Expected a JSON object";
  const named = data.userIds === undefined ? [] : data.userIds;
  return userIds(named) ? { userIds: named } : `People must be a list of at most ${MAX_LISTED_USERS} user ids`;
}

/** The settings `PATCH /api/account` changes, each with the name workspace settings give it. */
const SETTING_NAMES: Record<keyof AccountSettings, string> = {
  hideTranslationButtons: "Hide translation buttons",
  restrictRoomCreation: "Must be admin to create new rooms",
  joinLink: "Join link",
  openSignUp: "Open",
  memberfulJoin: "Memberful",
  memberfulSignIn: "Members only",
  emailDomainSignUp: "Email domain",
};

/**
 * Parses an untrusted order of at most `max` rooms. Returns why it's refused instead of the rooms.
 */
function parseRoomOrder(data: unknown, max: number): RoomId[] | string {
  const roomIds = typeof data === "object" && data !== null ? (data as Record<string, unknown>).roomIds : undefined;
  if (!Array.isArray(roomIds)) return "roomIds must be an array";
  if (roomIds.length > max) return "too many rooms";
  const ids = roomIds.filter((id): id is RoomId => typeof id === "string" && isRoomId(id));
  return ids.length === roomIds.length && new Set(ids).size === ids.length ? ids : "room IDs must be unique and valid";
}

/** Parses an untrusted order for someone's starred rooms. Returns why it's refused instead of the rooms. */
export const parseFavoriteOrder = (data: unknown) => parseRoomOrder(data, MAX_FAVORITES);

/** Parses an untrusted shared room order. Returns why it's refused instead of the rooms. */
export const parseSharedOrder = (data: unknown) => parseRoomOrder(data, MAX_SHARED_ORDER);

/** A host as `location.host` writes one: its name, lowercase labels between dots, and maybe a port, from 1 and without leading zeros. */
const HOST = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::([1-9][0-9]{0,4}))?$/;
/** The highest port a URL can have. */
const MAX_PORT = 65535;

/**
 * Where a deploy or `wrangler dev` puts Ember, which can't be its custom domain: a workers.dev address,
 * and localhost itself or a loopback address, though a name under localhost can, as a custom domain
 * stands in for one there.
 */
const DEPLOYED_HOSTNAME = /(?:^|\.)workers\.dev$|^localhost$|^127(?:\.[0-9]{1,3}){3}$|^\[::1\]$/;

/** Whether `host` is written as a custom domain is: as `location.host` writes it, with a name DNS could have and a port a URL can. */
export function isHost(host: string): boolean {
  const match = host.length <= MAX_HOST_NAME_LENGTH + `:${MAX_PORT}`.length ? HOST.exec(host) : null;
  return match !== null && match[1]!.length <= MAX_HOST_NAME_LENGTH && Number(match[2] ?? 0) <= MAX_PORT;
}

/** Whether the host name `hostname` could be Ember's custom domain: any but where a deploy or `wrangler dev` puts it. */
export const canBeCustomDomain = (hostname: string) => !DEPLOYED_HOSTNAME.test(hostname.toLowerCase());

/** Whether `host`, as `location.host` writes one, could be Ember's custom domain (`canBeCustomDomain`). */
export const isCustomDomainHost = (host: string) => isHost(host) && canBeCustomDomain(HOST.exec(host)![1]!);

/** Why a custom domain is refused when it isn't a host. */
export const CUSTOM_DOMAIN_NOT_A_HOST = "Custom domain must be a host name, such as chat.example.com";
/** Why a custom domain is refused when it's where a deploy or `wrangler dev` puts Ember. */
export const NOT_A_CUSTOM_DOMAIN = "A workers.dev or localhost address can't be a custom domain";

/** A custom domain as `PATCH /api/account` may send one, a host or null for none, or undefined when it's neither. */
const customDomainOf = (value: unknown): string | null | undefined => (value === null || (typeof value === "string" && isHost(value)) ? value : undefined);

/**
 * What a custom domain reaches, as checking it finds: this Ember; something else, which answers there
 * but isn't it; or nothing yet, as before Cloudflare has added the domain, or while its certificate is
 * on the way.
 */
export type CustomDomainReach = "ember" | "elsewhere" | "nothing";

/** What `POST /api/account/custom_domain_checks` answers: what the domain it was sent reaches. */
export interface CustomDomainCheck {
  reaches: CustomDomainReach;
}

/**
 * The DNS providers the Custom domain card has steps for, as its DNS provider menu lists them: Cloudflare,
 * where a Worker's custom domain must be, first, then those whose nameservers move a domain there, and
 * "other" for any other.
 */
export const DNS_PROVIDERS = ["cloudflare", "godaddy", "namecheap", "squarespace", "porkbun", "route53", "hover", "ionos", "other"] as const;

/** A DNS provider the Custom domain card has steps for (`DNS_PROVIDERS`). */
export type DnsProvider = (typeof DNS_PROVIDERS)[number];

/**
 * What `POST /api/account/custom_domain_lookups` answers, as public DNS says: the zone the domain it was
 * sent is in, which is the domain someone registered unless a name under it has a zone of its own, and
 * the DNS provider whose nameservers serve that zone, "other" for one the card has no steps for. Either
 * is null where DNS doesn't say, as for a name nobody registered.
 */
export interface CustomDomainLookup {
  zone: string | null;
  provider: DnsProvider | null;
}

/**
 * Parses an untrusted request to check or look up a custom domain, `{ domain }`, whose host could be
 * Ember's as one `PATCH /api/account` takes could. Returns why it's refused instead of the domain.
 */
export function parseCustomDomainCheck(data: unknown): { domain: string } | string {
  const domain = isJsonObject(data) && typeof data.domain === "string" && isHost(data.domain) ? data.domain : null;
  if (domain === null) return CUSTOM_DOMAIN_NOT_A_HOST;
  return isCustomDomainHost(domain) ? { domain } : NOT_A_CUSTOM_DOMAIN;
}

/**
 * The addresses Ember knows reach it besides its own (`Account.customDomain`), as Workspace settings'
 * Custom domain card names them: where a deploy puts it, its workers.dev address or `wrangler dev`'s,
 * as the latest page opened at one told it, or null until one has; and the custom domains it has moved
 * away from, newest first, which reach it until they're removed from the Worker in Cloudflare, unless a
 * check has found they don't (`othersAfterMove`).
 */
export interface EmberAddresses {
  deployed: string | null;
  others: string[];
}

/** The most custom domains Ember remembers moving away from, forgetting the oldest first. */
export const MAX_OTHER_ADDRESSES = 5;

/**
 * The custom domains Ember has moved away from, `others`, once it moves to `to` from the addresses in
 * `left`, its own until then and the one the move was asked at, which reach it too: those of them that
 * are custom domains first, as a deploy's address always reaches it, then the rest, newest first, but
 * never `to`, and only the latest `MAX_OTHER_ADDRESSES`.
 */
export function othersAfterMove(others: readonly string[], left: readonly (string | null)[], to: string | null): string[] {
  const moved = left.filter((address): address is string => address !== null && isCustomDomainHost(address));
  return [...new Set([...moved, ...others])].filter((address) => address !== to).slice(0, MAX_OTHER_ADDRESSES);
}

/** An email address, and the name its email is sent under, if any, as a From line gives them. */
export interface Mailbox {
  name: string | null;
  address: string;
}

/**
 * An email address Ember can send from or to: a local part of the characters RFC 5322 lets one have
 * unquoted, then a domain of letters, digits and hyphens between dots, as DNS has its names.
 */
const MAILBOX_ADDRESS =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** Whether `address` is an email address Ember can send from or to, as `MAILBOX_ADDRESS` has them, no longer than Ember keeps. */
export const isEmailAddress = (address: string) => address.length <= MAX_EMAIL_ADDRESS_LENGTH && MAILBOX_ADDRESS.test(address);
/** A name, in quotes or not, then an address in angle brackets. */
const NAMED_MAILBOX = /^(.*?)\s*<([^<>]*)>$/s;
/** What a From line's name can't hold: line breaks and other control characters, quotes, backslashes and angle brackets. */
const NOT_IN_A_NAME = /[\u0000-\u001f\u007f"\\<>]/;
/** What has a From line put its name in quotes, since the line's syntax would read it otherwise. */
const QUOTED_IN_A_NAME = /[()[\]:;@,.]/;

/** Why a From address is refused. */
export const EMAIL_FROM_REFUSED = "From must be an email address, such as ember@example.com, or a name and one, such as Ember <ember@example.com>";

/**
 * The mailbox `text` gives, as an administrator types a From address: an email address, or a name, in
 * quotes or not, and an address in angle brackets. Null for anything else, as for an address Ember can't
 * send from, or a name a From line can't hold.
 */
export function mailboxOf(text: string): Mailbox | null {
  const typed = text.trim();
  const named = NAMED_MAILBOX.exec(typed);
  const given = named?.[1]?.trim() ?? "";
  const name = /^".*"$/s.test(given) ? given.slice(1, -1).trim() : given;
  const address = named ? named[2]!.trim() : typed;
  if (!isEmailAddress(address)) return null;
  if (name.length > MAX_USER_NAME_LENGTH || NOT_IN_A_NAME.test(name)) return null;
  return { name: name || null, address };
}

/** What a From line's name can't hold, as `NOT_IN_A_NAME` has it, wherever it is. */
const NOT_IN_A_NAME_ANYWHERE = new RegExp(NOT_IN_A_NAME.source, "g");

/**
 * `mailbox` under `name`, the workspace's, unless it has a name of its own, as Ember's email comes from
 * the From address, so that a mail client shows the workspace's name rather than the start of the
 * address: on one line, with a space for what a From line's name can't hold, or no name if that leaves none.
 */
export function mailboxUnder(mailbox: Mailbox, name: string): Mailbox {
  if (mailbox.name !== null) return mailbox;
  const kept = name.replace(NOT_IN_A_NAME_ANYWHERE, " ").replace(/\s+/g, " ").trim();
  return { name: kept || null, address: mailbox.address };
}

/** `mailbox` as a From line writes it: its name, in quotes where the line's syntax needs them, then its address in angle brackets, or the address alone. */
export const mailboxText = ({ name, address }: Mailbox) => (name === null ? address : `${QUOTED_IN_A_NAME.test(name) ? `"${name}"` : name} <${address}>`);

/** A From address as `PATCH /api/account` may send one, as `mailboxText` writes it, null for none, as blank is, or undefined when it's neither. */
function emailFromOf(value: unknown): string | null | undefined {
  if (value === null || (typeof value === "string" && value.trim() === "")) return null;
  const mailbox = typeof value === "string" ? mailboxOf(value) : null;
  return mailbox === null ? undefined : mailboxText(mailbox);
}

/**
 * The part of the URL parser that reading a domain needs, which every runtime Ember runs in has, though
 * the protocol, made for every runtime, names it itself, as it does `SearchParams`.
 */
declare const URL: new (url: string) => { readonly hostname: string };

/**
 * A domain as DNS has it, in ASCII: letters, digits and hyphens between dots, in labels of at most 63,
 * and at most 253 in all, with a top-level domain that isn't all digits, as an IP address's would be.
 */
const EMAIL_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?=[a-z0-9-]*[a-z])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The email domain `text` names, as an administrator lists one for Email domain, with an "@" before it
 * or not: in lowercase, an international name in the ASCII form the URL parser gives a host, so that a
 * look-alike is just another domain. Null for anything else.
 */
export function emailDomainOf(text: string): string | null {
  const typed = text.trim().replace(/^@/, "");
  // Nothing but a host, so that the parser finds no path, port or user in it.
  if (typed === "" || /[\s/\\?#@:[\]%]/.test(typed)) return null;
  let host: string;
  try {
    host = new URL(`http://${typed}`).hostname;
  } catch {
    return null;
  }
  return EMAIL_DOMAIN.test(host) ? host : null;
}

/** The domain of `emailAddress`, as `emailDomainOf` has domains, or null for an address without one. */
export function domainOfEmailAddress(emailAddress: string): string | null {
  const at = emailAddress.lastIndexOf("@");
  return at > 0 ? emailDomainOf(emailAddress.slice(at + 1)) : null;
}

/** The domains `PATCH /api/account` may give Email domain, each as `emailDomainOf` has it and once, or undefined for anything else. */
function emailDomainsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_EMAIL_DOMAINS) return undefined;
  const domains = value.map((text: unknown) => (typeof text === "string" ? emailDomainOf(text) : null));
  return domains.every((domain) => domain !== null) ? [...new Set(domains)] : undefined;
}

/** `domains` in words, as pages name the ones Email domain lets in: "example.com", or "example.com or example.org", and so on. */
export const domainsInWords = (domains: readonly string[]) => (domains.length < 2 ? (domains[0] ?? "") : `${domains.slice(0, -1).join(", ")} or ${domains.at(-1)}`);

/** Why `/join/email` sends no link to an address at a domain Email domain doesn't let in. */
export const onlyAddressesAt = (domains: readonly string[]) => `Only email addresses at ${domainsInWords(domains)} can join this way.`;

/** A tagline as it's kept: on one line, with a single space between words and none at either end. */
const taglineOf = (text: string) => text.replace(/\s+/g, " ").trim();

export const NAVIGATION_ICONS_REFUSED = 'Navigation icons must give the rail\'s buttons and the appearance modes one of the room icons each, or "" for the default';

/**
 * Untrusted changes to navigation icons: an object of known slots, each an icon's exact name or "" for
 * its default, which its default's own name stands for too. Undefined for anything else.
 */
function navigationIconsOf(data: unknown): NavigationIconChanges | undefined {
  if (!isJsonObject(data)) return undefined;
  const changes: NavigationIconChanges = {};
  for (const [key, icon] of Object.entries(data)) {
    if (!(NAVIGATION_SLOTS as readonly string[]).includes(key) || (icon !== "" && !isRoomIcon(icon))) return undefined;
    const slot = key as NavigationSlot;
    changes[slot] = icon === DEFAULT_NAVIGATION_ICONS[slot] ? "" : icon;
  }
  return changes;
}

/**
 * Parses an untrusted change to the workspace. Returns why it's refused instead of the changes. The name
 * is saved as typed, even blank. The tagline is kept on one line without space at its ends, and blank is
 * none. Each setting is true or false, and one it doesn't know is refused. A custom domain is a host or
 * null, which the Worker then checks is the address the request came to. Navigation icons are as
 * `navigationIconsOf` reads them, the From address as `emailFromOf` does, and Email domain's domains as
 * `emailDomainsOf` does.
 */
export function parseAccountChanges(data: unknown): AccountChanges | string {
  if (!isJsonObject(data)) return "Expected a JSON object";
  const { name, tagline, settings, customDomain, navigationIcons, emailFrom, emailDomains } = data;
  if (name !== undefined && (typeof name !== "string" || name.length > MAX_ACCOUNT_NAME_LENGTH)) return `Name must be at most ${MAX_ACCOUNT_NAME_LENGTH} characters`;
  const kept = typeof tagline === "string" ? taglineOf(tagline) : undefined;
  if (tagline !== undefined && (kept === undefined || kept.length > MAX_TAGLINE_LENGTH)) return TAGLINE_TOO_LONG;
  const domain = customDomainOf(customDomain);
  if (customDomain !== undefined && domain === undefined) return CUSTOM_DOMAIN_NOT_A_HOST;
  const icons = navigationIconsOf(navigationIcons);
  if (navigationIcons !== undefined && icons === undefined) return NAVIGATION_ICONS_REFUSED;
  const from = emailFromOf(emailFrom);
  if (emailFrom !== undefined && from === undefined) return EMAIL_FROM_REFUSED;
  const domains = emailDomainsOf(emailDomains);
  if (emailDomains !== undefined && domains === undefined) return EMAIL_DOMAINS_REFUSED;
  const changes: AccountChanges = {
    ...(name !== undefined && { name }),
    ...(kept !== undefined && { tagline: kept }),
    ...(domain !== undefined && { customDomain: domain }),
    ...(icons !== undefined && { navigationIcons: icons }),
    ...(from !== undefined && { emailFrom: from }),
    ...(domains !== undefined && { emailDomains: domains }),
  };
  if (settings === undefined) return changes;
  if (!isJsonObject(settings)) return "Settings must be a JSON object";
  const changed: AccountSettings = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!Object.hasOwn(SETTING_NAMES, key)) return `Unknown setting: ${key}`;
    const setting = key as keyof AccountSettings;
    if (typeof value !== "boolean") return `${SETTING_NAMES[setting]} must be true or false`;
    changed[setting] = value;
  }
  return { ...changes, settings: changed };
}

/** Parses untrusted custom CSS, which is saved as typed. Returns why it's refused instead. */
export function parseCustomStyles(data: unknown): Partial<CustomStyles> | string {
  if (!isJsonObject(data)) return "Expected a JSON object";
  const { customStyles } = data;
  if (customStyles === undefined) return {};
  return typeof customStyles === "string" && customStyles.length <= MAX_CUSTOM_STYLES_LENGTH
    ? { customStyles }
    : `Custom CSS must be at most ${MAX_CUSTOM_STYLES_LENGTH.toLocaleString("en-US")} characters`;
}

/**
 * Parses an untrusted role change: exactly "administrator" makes someone an administrator, and anything
 * else a member, blank included. Null without a role at all, as it does a request without `user`.
 */
export function parseRoleChange(data: unknown): RoleChange | null {
  if (typeof data !== "object" || data === null || Array.isArray(data) || !("role" in data)) return null;
  return { role: data.role === "administrator" ? "administrator" : "member" };
}

/** Whether `value` is exactly one of the notification levels. */
export const isInvolvement = (value: unknown): value is Involvement => (INVOLVEMENTS as readonly unknown[]).includes(value);

/**
 * Parses an untrusted change to someone's notification level in a room: the level, or null for anything
 * else.
 */
export function parseInvolvementChange(data: unknown): Involvement | null {
  if (typeof data !== "object" || data === null) return null;
  const { involvement } = data as Record<string, unknown>;
  return isInvolvement(involvement) ? involvement : null;
}

const PROFILE_FIELDS = {
  name: "Name",
  emailAddress: "Email address",
  password: "Password",
  bio: "Bio",
  currentPassword: "Current password",
  pushSubscriptionEndpoint: "Push subscription endpoint",
} as const satisfies Record<keyof ProfileChanges, string>;

/**
 * Parses an untrusted change to your profile. Returns why it's refused instead. Each field is saved as
 * typed, even a blank name. The server keeps the form's limits too: a new password from the 8 characters
 * first run takes, to the 72 sign-in can take, and a 200-character bio.
 */
export function parseProfileChanges(data: unknown): ProfileChanges | string {
  if (!isJsonObject(data)) return "Expected a JSON object";
  const changes: ProfileChanges = {};
  for (const [field, label] of Object.entries(PROFILE_FIELDS) as [keyof ProfileChanges, string][]) {
    const value = data[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return `${label} must be text`;
    changes[field] = value;
  }
  if (changes.name !== undefined && changes.name.length > MAX_USER_NAME_LENGTH) return NAME_TOO_LONG;
  if (changes.emailAddress !== undefined && changes.emailAddress.length > MAX_EMAIL_ADDRESS_LENGTH) return EMAIL_ADDRESS_TOO_LONG;
  if (changes.password !== undefined && isPasswordTooLong(changes.password)) return PASSWORD_TOO_LONG;
  // A blank one keeps the password you have.
  if (changes.password && isPasswordTooShort(changes.password)) return PASSWORD_TOO_SHORT;
  if (changes.bio !== undefined && changes.bio.length > MAX_BIO_LENGTH) return `Bio must be at most ${MAX_BIO_LENGTH} characters`;
  if (changes.pushSubscriptionEndpoint !== undefined && changes.pushSubscriptionEndpoint.length > MAX_PUSH_ENDPOINT_LENGTH) {
    return `Endpoint can't be longer than ${MAX_PUSH_ENDPOINT_LENGTH} characters`;
  }
  return changes;
}

/**
 * Parses an untrusted disconnection of your Memberful account. Returns why it's refused instead. Whether
 * the password is yours, and whether you have one, the server checks once it knows who's asking.
 */
export function parseMemberfulDisconnection(data: unknown): MemberfulDisconnection | string {
  if (!isJsonObject(data)) return "Expected a JSON object";
  const { currentPassword, pushSubscriptionEndpoint } = data;
  if (currentPassword !== undefined && typeof currentPassword !== "string") return "Current password must be text";
  if (pushSubscriptionEndpoint !== undefined && typeof pushSubscriptionEndpoint !== "string") return "Push subscription endpoint must be text";
  if (pushSubscriptionEndpoint !== undefined && pushSubscriptionEndpoint.length > MAX_PUSH_ENDPOINT_LENGTH) {
    return `Endpoint can't be longer than ${MAX_PUSH_ENDPOINT_LENGTH} characters`;
  }
  return { ...(currentPassword === undefined ? {} : { currentPassword }), ...(pushSubscriptionEndpoint === undefined ? {} : { pushSubscriptionEndpoint }) };
}

/**
 * Parses an untrusted first run or join. Returns why it's refused instead, when a field is missing or
 * the name or email address is longer than Ember keeps; the password's length is checked apart from
 * this, since each form has its own rules.
 */
export function parseSignUp(data: unknown): SignUp | string {
  if (typeof data !== "object" || data === null) return "Expected a JSON object";
  const f = data as Record<string, unknown>;
  const name = typeof f.name === "string" ? f.name.trim() : "";
  // Take the address as typed: the browser checks its shape and trims it.
  const emailAddress = typeof f.emailAddress === "string" ? f.emailAddress : "";
  if (!name || !emailAddress || typeof f.password !== "string") return "Name, email address and password are required";
  if (name.length > MAX_USER_NAME_LENGTH) return NAME_TOO_LONG;
  if (isReservedName(name)) return NAME_RESERVED;
  if (emailAddress.length > MAX_EMAIL_ADDRESS_LENGTH) return EMAIL_ADDRESS_TOO_LONG;
  return { name, emailAddress, password: f.password };
}

/** Parses an untrusted open sign-up, as `parseSignUp` does, with Turnstile's token if it has one. Returns why it's refused instead. */
export function parseOpenSignUp(data: unknown): OpenSignUp | string {
  const signUp = parseSignUp(data);
  if (typeof signUp === "string") return signUp;
  const { turnstileToken } = data as Record<string, unknown>;
  if (turnstileToken === undefined) return signUp;
  if (typeof turnstileToken !== "string" || turnstileToken.length > MAX_TURNSTILE_TOKEN_LENGTH) return `Turnstile's token must be at most ${MAX_TURNSTILE_TOKEN_LENGTH} characters`;
  return { ...signUp, turnstileToken };
}

/**
 * Parses an untrusted join with a link Ember emailed, as `parseSignUp` does a join, but for the email
 * address, which is the link's, and with the link's secret, which the Worker checks. Returns why it's
 * refused instead.
 */
export function parseEmailLinkSignUp(data: unknown): EmailLinkSignUp | string {
  if (!isJsonObject(data)) return "Expected a JSON object";
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name || typeof data.password !== "string" || typeof data.token !== "string") return "Name and password are required";
  if (name.length > MAX_USER_NAME_LENGTH) return NAME_TOO_LONG;
  if (isReservedName(name)) return NAME_RESERVED;
  return { token: data.token, name, password: data.password };
}

/** Why `POST /api/email_links` is refused an address it can't send to. */
export const EMAIL_ADDRESS_NEEDED = "Enter your email address, such as ann@example.com";

/**
 * Parses an untrusted `POST /api/email_links`, answering the address to email, with its domain, as
 * `emailDomainOf` has domains, and Turnstile's token if it has one, or why it's refused instead: no
 * address Ember can send to. The address is kept as given, as joining keeps one, but for an
 * international domain, which goes in its ASCII form, as Ember sends to it.
 */
export function parseEmailLinkRequest(data: unknown): (EmailLinkRequest & { domain: string }) | string {
  if (!isJsonObject(data)) return "Expected a JSON object";
  const { emailAddress, turnstileToken } = data;
  const given = typeof emailAddress === "string" ? emailAddress.trim() : "";
  const domain = domainOfEmailAddress(given);
  const address = domain !== null && !isEmailAddress(given) ? `${given.slice(0, given.lastIndexOf("@"))}@${domain}` : given;
  if (domain === null || !isEmailAddress(address)) return EMAIL_ADDRESS_NEEDED;
  if (turnstileToken === undefined) return { emailAddress: address, domain };
  if (typeof turnstileToken !== "string" || turnstileToken.length > MAX_TURNSTILE_TOKEN_LENGTH) return `Turnstile's token must be at most ${MAX_TURNSTILE_TOKEN_LENGTH} characters`;
  return { emailAddress: address, domain, turnstileToken };
}

/** Why `POST /api/invitations` is refused without an email address to invite. */
export const NO_EMAIL_ADDRESSES = "Give an email address to invite";

/** Why `POST /api/invitations` is refused an address it can't send to. */
export const NOT_AN_EMAIL_ADDRESS = "Each must be an email address, such as ann@example.com";

/**
 * Parses an untrusted `POST /api/invitations`, `{ emailAddresses }`: 1 to `INVITATIONS_AT_ONCE` email
 * addresses Ember can send to, each once, whatever its case, as first given. Returns why it's refused
 * instead.
 */
export function parseInvitationRequest(data: unknown): string[] | string {
  const given = isJsonObject(data) ? data.emailAddresses : undefined;
  if (!Array.isArray(given) || given.length === 0) return NO_EMAIL_ADDRESSES;
  if (given.length > INVITATIONS_AT_ONCE) return `Invite at most ${INVITATIONS_AT_ONCE} email addresses at once`;
  if (!given.every((address) => typeof address === "string" && isEmailAddress(address))) return NOT_AN_EMAIL_ADDRESS;
  return onceEach(given as string[]);
}

/**
 * The email addresses in `text`, as an administrator pastes a list of them to invite: apart by commas,
 * semicolons, spaces or line breaks, or each in angle brackets after a name, in quotes or not, as an
 * email's To line has them. Each comes once, whatever its case, as first given, and anything else is
 * refused, as given.
 */
export function emailAddressesIn(text: string): { emailAddresses: string[]; refused: string[] } {
  // A name in quotes can hold commas, and is never an address.
  const words = text.replace(/"[^"]*"/g, " ").split(/[,;\n]/).flatMap(wordsOfEntry);
  return { emailAddresses: onceEach(words.filter(isEmailAddress)), refused: words.filter((word) => !isEmailAddress(word)) };
}

/** The words of `entry`, one of a list of addresses, apart by spaces: all but those of each name before an address in angle brackets. */
function wordsOfEntry(entry: string): string[] {
  // What's in angle brackets lands at the odd places, each after what comes before it.
  const parts = entry.split(/<([^<>]*)>/);
  return parts.flatMap((part, index) => {
    const words = part.split(/\s+/).filter(Boolean);
    // The words before an address in angle brackets are its name, but for any address among them.
    return index % 2 === 0 && index < parts.length - 1 ? words.filter(isEmailAddress) : words;
  });
}

/** `emailAddresses` with each address once, whatever its case, as first given. */
function onceEach(emailAddresses: string[]): string[] {
  const given = new Set<string>();
  return emailAddresses.filter((address) => !given.has(address.toLowerCase()) && given.add(address.toLowerCase()));
}

/**
 * Parses an untrusted password reset. Returns why it's refused instead, when a field is missing; the
 * password's length is checked apart from this, as for first run.
 */
export function parsePasswordReset(data: unknown): PasswordReset | string {
  if (typeof data !== "object" || data === null) return "Expected a JSON object";
  const { emailAddress, password } = data as Record<string, unknown>;
  // Taken as given, as sign-in takes it.
  if (typeof emailAddress !== "string" || !emailAddress || typeof password !== "string") return "Email address and password are required";
  return { emailAddress, password };
}

/**
 * Parses an untrusted `POST /api/password_resets`, answering the address to email a code to, as given,
 * and Turnstile's token if it has one, or why it's refused instead: no address, or one longer than any
 * account's.
 */
export function parsePasswordResetRequest(data: unknown): PasswordResetRequest | string {
  if (!isJsonObject(data)) return "Expected a JSON object";
  const { emailAddress, turnstileToken } = data;
  if (typeof emailAddress !== "string" || !emailAddress.trim()) return EMAIL_ADDRESS_NEEDED;
  if (emailAddress.length > MAX_EMAIL_ADDRESS_LENGTH) return EMAIL_ADDRESS_TOO_LONG;
  if (turnstileToken === undefined) return { emailAddress };
  if (typeof turnstileToken !== "string" || turnstileToken.length > MAX_TURNSTILE_TOKEN_LENGTH) return `Turnstile's token must be at most ${MAX_TURNSTILE_TOKEN_LENGTH} characters`;
  return { emailAddress, turnstileToken };
}

/** A code Ember emails to reset a password: its digits, and nothing else. */
const PASSWORD_RESET_CODE = new RegExp(`^[0-9]{${PASSWORD_RESET_CODE_DIGITS}}$`);

/**
 * The code in `typed`, as someone types or pastes the one Ember emailed them: its digits, apart by spaces
 * or dashes if they like, and full-width as a Japanese keyboard types them if it does, or null for
 * anything else.
 */
export function passwordResetCodeOf(typed: string): string | null {
  const code = typed.normalize("NFKC").replace(/[\s-]/g, "");
  return PASSWORD_RESET_CODE.test(code) ? code : null;
}

/**
 * Parses an untrusted `PUT /api/password_resets`, answering the address, the code, as
 * `passwordResetCodeOf` reads it, and the new password, or why it's refused instead, with the field it's
 * about; the password's length is checked apart from this, as for first run.
 */
export function parsePasswordResetWithCode(data: unknown): PasswordResetWithCode | { error: string; field?: "emailAddress" | "code" } {
  if (!isJsonObject(data)) return { error: "Expected a JSON object" };
  const { emailAddress, code, password } = data;
  if (typeof emailAddress !== "string" || !emailAddress || typeof code !== "string" || typeof password !== "string") return { error: "Email address, code and password are required" };
  if (emailAddress.length > MAX_EMAIL_ADDRESS_LENGTH) return { error: EMAIL_ADDRESS_TOO_LONG, field: "emailAddress" };
  const read = passwordResetCodeOf(code);
  if (read === null) return { error: PASSWORD_RESET_CODE_NEEDED, field: "code" };
  return { emailAddress, code: read, password };
}

/** Whether a new password is shorter than Ember takes, counting an emoji as one character. */
export const isPasswordTooShort = (password: string) => [...password].length < MIN_PASSWORD_LENGTH;

/**
 * Whether a password is longer than the password fields take, counting UTF-16 units as their
 * `maxlength` does, so the server takes exactly the passwords the forms can send.
 */
export const isPasswordTooLong = (password: string) => password.length > MAX_PASSWORD_LENGTH;

/**
 * Parses a frame from the server: a room's, or the workspace socket's when `Frame` says so. The
 * server is trusted, so this only guards against garbage.
 */
export function parseServerFrame<Frame extends { type: string } = ServerFrame>(raw: string): Frame | null {
  const data = parseObject(raw);
  return typeof data?.type === "string" ? (data as Frame) : null;
}
