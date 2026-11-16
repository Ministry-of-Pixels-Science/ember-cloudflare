import {
  ASSISTANT_ID,
  ASSISTANT_NAME,
  MAX_FAVORITES,
  MAX_OTHER_ADDRESSES,
  MAX_PUSH_SUBSCRIPTIONS,
  MAX_SHARED_ORDER,
  NAVIGATION_SLOTS,
  PASSWORD_RESET_CODE_TRIES,
  RECENT_SEARCHES,
  emailDomainOf,
  isHost,
  isRoomIcon,
  mailboxOf,
  mailboxText,
  parseSearch,
  type Account,
  type BotChanges,
  type BotRoom,
  type CloseCode,
  type DirectRoom,
  type EmailInvitation,
  type EmailLinkKind,
  type Favorites,
  type Involvement,
  type NavigationIconChanges,
  type NavigationIcons,
  type PersonRole,
  type Profile,
  type PushSubscriptionKeys,
  type Role,
  type Room,
  type RoomChanges,
  type RoomId,
  type RoomKind,
  type RoomSettings,
  type Search,
  type SharedRoom,
  type SidebarRoom,
  type User,
  type UserId,
  type UserStatus,
} from "@ember/protocol";
import {
  ANSWER_LENGTHS,
  DEFAULT_LEVELS,
  MODEL_FORMATS,
  modelName,
  modelNameOf,
  modelOf,
  THINKING_LEVELS,
  TOP_LEVELS,
  WEB_TOOLS,
  type AnswerLength,
  type AnswerLevels,
  type AssistantModel,
  type ModelFormat,
  type ThinkingLevel,
  type WebTool,
  type YourAssistantChanges,
} from "@ember/protocol/assistant";
import type { AgentAccess, AgentProfile, AgentRoom } from "@ember/protocol/agents";
import type { AppId } from "@ember/protocol/apps";
import type { LiveHuddle } from "@ember/protocol/huddles";
import { statement, type Db, type Statement } from "./db";
import type { StoredPicture } from "./files/pictures";
import { messagePayload, type PushPayload } from "./push/payload";
import { ADDRESS_TAG_PREFIX, EVERYONE, SESSION_TAG_PREFIX, type Revocation } from "./revocations";
import type { RoomEvent } from "./room-log";

// The account, its people, their sessions and their rooms, kept by the Workspace in its own SQLite
// storage or in D1 (see db.ts).

/** The browser and IP a session records. */
export interface Client {
  ip: string | null;
  userAgent: string | null;
}

/** The user statuses. Only active people can sign in. */
export const ACTIVE = 0;
const DEACTIVATED = 1;
const BANNED = 2;
/** For a member whose Memberful membership has lapsed, until it's renewed. */
const SUSPENDED = 3;
/** The role for everyone who neither runs the workspace nor is a bot. */
const MEMBER = 0;
/** The role for the people who run the workspace. */
const ADMINISTRATOR = 1;
/** The role for bots. */
const BOT = 2;
/** The roles and statuses, each at the number it stores. */
const ROLES: readonly Role[] = ["member", "administrator", "bot"];
const STATUSES: readonly UserStatus[] = ["active", "deactivated", "banned", "suspended"];

/** The settings a new account starts with. */
const NEW_ACCOUNT_SETTINGS = JSON.stringify({ restrict_room_creation_to_administrators: false });

/**
 * What a new account's settings and custom CSS read as: no tagline, translation buttons hidden, no CSS,
 * anyone may create rooms, no custom domain, people join with the join link but can't sign up without
 * it, nor join with Memberful or an email domain, members sign in with passwords, the rail has its
 * own icons, and in huddles cameras may go on and screens be shared.
 */
export const NEW_ACCOUNT_LOOKS = {
  tagline: "",
  hideTranslationButtons: true,
  customStyles: "",
  restrictRoomCreation: false,
  huddleCameras: true,
  huddleScreens: true,
  customDomain: null,
  joinLink: true,
  openSignUp: false,
  memberfulJoin: false,
  memberfulSignIn: false,
  emailDomainSignUp: false,
  emailDomains: [] as string[],
  navigationIcons: {},
} as const;

/**
 * The workspace's account as the Workspace keeps it: as every page shows it, but for its logo's address,
 * with the code in its join link, which only the people in it see, when it last changed, which the
 * logo's address goes by, and the logo as R2 keeps it. Its email domains are the ones kept, whether Email
 * domain is on or not, and its huddles the app they run through, where pages hear only that they're on.
 */
export interface JoinableAccount extends Omit<Account, "logo" | "huddles"> {
  joinCode: string;
  updatedAt: string;
  storedLogo: StoredPicture | null;
  /** The address Ember's email comes from, as `mailboxText` writes it, or null while an administrator hasn't given one. */
  emailFrom: string | null;
  /** The Resend API key an administrator gave Ember to send email with, sealed (`seal`), or null while they haven't given one. */
  resendApiKey: string | null;
  /** The keys of the Turnstile widget an administrator gave Ember to check people with, or null while they haven't given one's. */
  turnstileKeys: SavedTurnstileKeys | null;
  /** The Memberful site and keys an administrator gave Ember in Set up Memberful, or null while they haven't. */
  memberfulKeys: SavedMemberfulKeys | null;
  /** How Ember AI asks AI Gateway, while an administrator has it on, or else null. */
  assistant: SavedAssistant | null;
  /** The most each of @ember's dials goes to for anyone's questions, as administrators set it, whether Ember AI is on or not. */
  assistantMost: AnswerLevels;
  /** What Ember adds to @ember's own instructions, as administrators write them, or "" for nothing, whether Ember AI is on or not. */
  assistantInstructions: string;
  /** What Ember adds around them, as administrators changed it, or null for Ember's own, whether Ember AI is on or not. */
  assistantPromptTemplate: string | null;
  /** The SFU app huddles run through, while an administrator has them on, or else null. */
  huddles: SavedHuddles | null;
  /** Whether AI apps may connect to Ember as the people in it, which an administrator turns on. Off until one does. */
  outsideAi: boolean;
  /** Where a deploy puts Ember, as the latest page opened there told it, or null until one has (`EmberAddresses.deployed`). */
  deployedAddress: string | null;
  /** The custom domains Ember has moved away from, newest first, which may still reach it (`EmberAddresses.others`). */
  otherAddresses: string[];
}

/** A Turnstile widget's keys as the account keeps them: its site key, and its secret key sealed (`seal`). */
export interface SavedTurnstileKeys {
  siteKey: string;
  sealedSecretKey: string;
}

/**
 * A Memberful site's keys as the account keeps them: the site's origin, its custom app's OAuth
 * identifier, and sealed together (`seal`), as `MemberfulSecrets` has them, the app's OAuth secret and
 * API key and its webhook's secret key.
 */
export interface SavedMemberfulKeys {
  site: string;
  clientId: string;
  sealedSecrets: string;
}

/**
 * A Realtime SFU app's keys as the account keeps them: its ID, and its secret sealed (`seal`), and with
 * them the TURN key huddles' relay goes by, or null while they have no relay.
 */
export interface SavedHuddles {
  appId: string;
  sealedAppSecret: string;
  relay: SavedRelay | null;
}

/** A TURN key as the account keeps it: its ID, and its API token sealed (`seal`). */
export interface SavedRelay {
  keyId: string;
  sealedApiToken: string;
}

/**
 * How Ember AI asks AI Gateway, as the account keeps it: the Cloudflare account, its API token sealed
 * (`seal`), the model it answers anyone with who hasn't picked another, and the format the model took
 * its test question in, the models people can pick from, that one among them, in the order they were
 * added, what @ember may do on the web, which Search the web found the model that answers everyone could
 * when it was turned on, or nothing while it's off, and when that was asked for, if Search the web has
 * been turned on or off for that model. Then when Ember asked the models it asks through Cloudflare's
 * REST API, the agents' too, whether their providers' own endpoints answer them, which it does once
 * after each time Ember AI is set up, or null until it has.
 */
export interface SavedAssistant {
  accountId: string;
  sealedApiToken: string;
  model: string;
  format: ModelFormat;
  models: SavedModel[];
  webTools: WebTool[];
  webToolsAskedAt: string | null;
  providerEndpointsTriedAt: string | null;
}

/**
 * A model that Ember asks in another format from now on than the one it was saved in, `from`, as one of
 * Workers AI's searches the web in theirs, or any model its provider's own endpoint answers, with the
 * levels of thinking it takes there, which asking it at each found.
 */
export interface MovedModel {
  id: string;
  from: ModelFormat;
  format: ModelFormat;
  thinkingLevels: ThinkingLevel[];
}

/**
 * A model people can pick, as the account keeps it: its ID, its name, the format it took its test
 * question in, and the levels of thinking it takes, once Ember has asked it at each.
 */
export type SavedModel = Pick<AssistantModel, "id" | "name" | "format" | "thinkingLevels">;

/** The account first run creates. */
export interface NewAccount {
  id: string;
  name: string;
  joinCode: string;
}

/**
 * What `WorkspaceStore.changeAccount` changes: the name, the tagline, the settings workspace settings'
 * switches change, the custom domain and the ones it moved away from, the navigation icons whose slots
 * change, the From address, the sealed Resend API key, Turnstile's keys, Memberful's, the SFU app
 * huddles run through, and the domains Email domain lets in. Memberful's two settings change together,
 * or not at all, as `memberful`.
 */
export type AccountChange = Partial<
  Pick<
    JoinableAccount,
    | "name"
    | "tagline"
    | "hideTranslationButtons"
    | "restrictRoomCreation"
    | "huddleCameras"
    | "huddleScreens"
    | "customDomain"
    | "otherAddresses"
    | "joinLink"
    | "openSignUp"
    | "emailDomainSignUp"
    | "emailDomains"
    | "emailFrom"
    | "resendApiKey"
    | "turnstileKeys"
    | "memberfulKeys"
    | "huddles"
  >
> & {
  memberful?: Pick<Account, "memberfulJoin" | "memberfulSignIn">;
  navigationIcons?: NavigationIconChanges;
};

/** Someone who signs in with an email address and password: first run's administrator, or someone who joins. */
export interface NewPerson {
  id: UserId;
  name: string;
  emailAddress: string;
  passwordDigest: string;
  /** The avatar they chose, which R2 has stored under a key the Workspace reserved, or null. */
  avatar: StoredPicture | null;
  /** The administrator whose invitation they joined with, if they did. */
  invitedBy?: UserId;
}

/** A session and the person it signs in. */
export interface StoredSession {
  id: string;
  user: User;
  /** Whether the person is one of the workspace's administrators. */
  administrator: boolean;
  /** Whether the person signed in with just a name. */
  guest: boolean;
  /** When the session was last refreshed, in milliseconds since the epoch. */
  lastActiveAt: number;
}

/** Someone as the people directory lists them, with when they last changed, which their avatar's address follows. */
export interface DirectoryEntry extends User {
  bio: string | null;
  role: Role;
  status: UserStatus;
  updatedAt: string;
  /** Whether they're an AI agent, @ember or one an administrator made, deleted ones too. */
  agent: boolean;
  /**
   * Whom an AI agent is kept for: "admins" for one only administrators can ask, "admin-dms" for one only
   * their direct messages reach, which nobody else is told of, even once it's deleted, or null for an
   * agent anyone can ask, and for anyone else.
   */
  keptFor: KeptFor | null;
}

/** Whom an AI agent that not everyone can ask is kept for (`AgentAccess`). */
export type KeptFor = Exclude<AgentAccess, "everyone">;

/** Someone as the people directory lists them, with their email address, which their profile shows too. */
export interface ProfileEntry extends DirectoryEntry {
  emailAddress: string | null;
}

/** The same, with the avatar they've uploaded, if any, as their own profile page shows them. */
export interface OwnProfileEntry extends ProfileEntry {
  avatar: StoredPicture | null;
  /** Whether they have a password, which changing their email address or password then asks for. */
  password: boolean;
  /** Whether they need a Memberful membership to sign in while Memberful is members only, as everyone does but administrators and the people they invited. */
  membershipNeeded: boolean;
  /** The accounts elsewhere they've connected, such as one at the Memberful site. */
  accounts: LinkedAccount[];
  /** How much @ember thinks and how long it answers them, and the model it answers with, as they picked. */
  picks: AssistantPicks;
}

/**
 * How much @ember thinks and how long it answers someone, and the model it answers them with, as they
 * picked each, or null for one they haven't.
 */
export interface AssistantPicks {
  thinking: ThinkingLevel | null;
  length: AnswerLength | null;
  model: string | null;
}

/** Someone who signs in with a Memberful account, which no account here is linked to yet. */
export interface NewLinkedPerson {
  id: UserId;
  name: string;
  /** Their Memberful account's email address, or null for one Ember can't keep. */
  emailAddress: string | null;
}

/**
 * An account elsewhere, as `issuer`, the address of the Memberful site it's on, and `subject`, its member
 * id there, name it, and what it says of itself: its name and email address there, or null for either
 * it didn't say, or Ember didn't keep, for one linked before it kept them.
 */
export interface LinkedAccount {
  issuer: string;
  subject: string;
  name: string | null;
  emailAddress: string | null;
}

/** Whose account connecting one elsewhere is for, and the digest of the password that checked out to start it, or "" without one. */
export interface Connecting {
  userId: UserId;
  passwordDigest: string;
}

/** The person an account elsewhere is linked to, as signing in with it finds them. */
export interface LinkedPerson {
  userId: UserId;
  /** Whether they can sign in, as only active people do, or why not. */
  status: UserStatus;
  /** Whether they need a membership to be let in, as everyone does but administrators and the people they invited. */
  membershipNeeded: boolean;
  /** When their membership was last read, by the Workspace's clock: as a sign-in began, or a check asked Memberful. */
  checkedAt: number;
}

/** A membership the Workspace has yet to check with the Memberful site's admin API. */
export interface MembershipCheck {
  /** The member id of the account to check, at the site checked. */
  subject: string;
  /** How many checks of it in a row Memberful failed to answer. */
  attempts: number;
}

/** What someone signs in with: their email address, and their password's digest, or null without one. */
export interface StoredSignIn {
  emailAddress: string | null;
  passwordDigest: string | null;
}

/**
 * A code someone was emailed to reset their password, as it's kept: its digest, the address it went to
 * and the digest of the password it replaces, as they were, and when it was made and stops working.
 */
export interface SavedPasswordReset {
  userId: UserId;
  codeDigest: string;
  emailAddress: string;
  passwordDigest: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * The sessions a new password ends, all of its person's but `kept`, the one saving it, whose sockets it
 * closes with `code` in every room they're in, due at `dueAt`, and the push subscriptions it forgets with
 * them, all of theirs but those at `pushEndpoint`, its browser's.
 */
export interface EndedByPassword {
  kept: string;
  pushEndpoint: string | null;
  code: CloseCode;
  dueAt: number;
}

/** What disconnecting an account elsewhere did: whether it was unlinked, and whether it queued any revocations. */
export interface Disconnection {
  disconnected: boolean;
  queued: boolean;
}

/** A bot as the bots page lists it, with its token, which its key is made from, and the rooms it's in but its DMs. */
export interface StoredBot extends DirectoryEntry {
  /** Null for a bot from before bots had tokens, which no key works for. */
  token: string | null;
  rooms: BotRoom[];
}

/** The same, with where its webhook delivers, or null for nowhere, as its edit page shows it. */
export interface StoredBotSettings extends StoredBot {
  webhookUrl: string | null;
}

/** A bot to add: its id, name and token, where its webhook delivers, or null for nowhere, and its avatar, or null for none. */
export interface NewStoredBot {
  id: UserId;
  name: string;
  token: string;
  webhookUrl: string | null;
  avatar: StoredPicture | null;
}

/**
 * What makes a bot an agent, as the agents table keeps it: what it does, its instructions and what Ember
 * adds around them, the model it answers with, what that's called, the format it took its test question
 * in and the levels of thinking it takes, how much it thinks and how long it answers, and what it may do
 * on the web.
 */
export interface AgentSetup {
  description: string;
  instructions: string;
  /** What Ember adds around the instructions, as an administrator changed it, or null for Ember's own. */
  promptTemplate: string | null;
  model: string;
  modelName: string;
  format: ModelFormat;
  /** The levels of thinking its model takes, or null for one Ember hasn't asked at each, as for an agent made before Ember did. */
  thinkingLevels: ThinkingLevel[] | null;
  levels: AnswerLevels;
  webTools: WebTool[];
}

/**
 * An agent as a question for it finds it: its name, its instructions and what Ember adds around them, its
 * model, that model's format and the levels of thinking it takes, its levels and what it may do on the web.
 */
export interface AnsweringAgent extends Pick<AgentSetup, "instructions" | "promptTemplate" | "model" | "format" | "thinkingLevels" | "levels" | "webTools"> {
  name: string;
}

/**
 * An agent as the AI assistant tab lists it: as the people directory lists it, with what it does, its
 * model, what it may do on the web, who can ask it, and the open rooms it's kept to, by name, or null
 * while it's in every one.
 */
export interface StoredAgent extends DirectoryEntry {
  description: string;
  model: string;
  modelName: string;
  webTools: WebTool[];
  access: AgentAccess;
  rooms: AgentRoom[] | null;
}

/** The same, with the rest of its setup, its avatar, and who last changed it, and when, as its page shows it. */
export interface StoredAgentSettings extends StoredAgent, AgentSetup {
  avatar: StoredPicture | null;
  changedBy: User;
  changedAt: string;
}

/**
 * An agent as Available Agents lists it to someone who can ask it: as the people directory lists it, with
 * what it does, who can ask it, and the rooms it shares with them, by name, or null while it's in every
 * open one.
 */
export interface AvailableStoredAgent extends DirectoryEntry {
  description: string;
  access: AgentAccess;
  rooms: AgentRoom[] | null;
}

/**
 * An agent to add, made by `createdBy`: its id and name, its setup, who can ask it, the open rooms it's
 * in, or null for every one, and its avatar, or null for none.
 */
export interface NewStoredAgent extends AgentSetup {
  id: UserId;
  name: string;
  access: AgentAccess;
  rooms: RoomId[] | null;
  avatar: StoredPicture | null;
  createdBy: UserId;
}

/**
 * A change to an agent by `changedBy`: its new name, if it has one, its setup as it is then, who can ask
 * it then, if that changed, the open rooms it's in then, or null for every one, if they changed, and its
 * new avatar, or none, if that changed, with the key of the one it had, for R2 to delete at `dueAt`. One
 * only administrators' direct messages reach from then on leaves every room, whatever `rooms` says.
 */
export interface StoredAgentChange {
  name?: string;
  setup: AgentSetup;
  access?: AgentAccess;
  rooms?: RoomId[] | null;
  avatar?: { avatar: StoredPicture | null; previous: string | null; dueAt: number };
  changedBy: UserId;
}

/** A new avatar for someone, which R2 has stored under a key reserved for it, and the key of the one they had, for R2 to delete at `dueAt`. */
export interface AvatarChange {
  avatar: StoredPicture;
  previous: string | null;
  dueAt: number;
}

/** What `WorkspaceStore.changeProfile` saves: someone's profile, and the digest of a new password, or null to keep theirs. */
export interface ProfileChange extends Pick<Profile, "name" | "emailAddress" | "bio"> {
  passwordDigest: string | null;
}

/** What someone's avatar is drawn from: the picture they uploaded, if any, else their name, or the bot picture for a bot. */
export interface AvatarOwner {
  name: string;
  bot: boolean;
  avatar: StoredPicture | null;
  /** Whom they're kept for, if they're an AI agent not everyone can ask (`DirectoryEntry.keptFor`). */
  keptFor: KeptFor | null;
}

/** Someone as the people directory lists them, with the avatar they've uploaded, or a bot was given. */
export interface PicturedEntry extends DirectoryEntry {
  avatar: StoredPicture | null;
}

/** What `roomsFor` reads for someone's sidebar. */
export interface SidebarRooms {
  rooms: SidebarRoom[];
  favorites: Favorites;
  sharedOrder: RoomId[];
  huddles: Record<RoomId, LiveHuddle>;
  /** The workspace's first room, if they're given the welcome card. */
  invitationRoomId: RoomId | null;
}

/** What became of a room's report of its huddle. */
export interface ReportedHuddle {
  /** Who's in the room, to hear of the huddle, when the report changed the huddle kept, or else null. */
  memberIds: UserId[] | null;
  /** When the report kept instead was made, if that's no earlier than this one, which then counted for nothing. */
  outdatedBy: number | null;
}

/** What changing a room changed, and who's in it then. */
export interface SavedRoomChange {
  /** Whether its name, kind or icon changed. */
  roomChanged: boolean;
  memberIds: UserId[];
  /** Who the change put in the room. */
  addedIds: UserId[];
  /** Who it took out, whose sockets there it queued closing. */
  removedIds: UserId[];
  /** Whether the shared order ranks the room, which the sidebars of the people it put in have left out. */
  ranked: boolean;
}

/** What applying events from a room's log changed. */
export interface AppliedEvents {
  /** Whose unread marks changed, and when the message each is now marked unread as of came, or null for one now read. */
  marks: Map<UserId, string | null>;
  /** When messages came in a DM, when the latest did and everyone in the DM; null otherwise. */
  active: { at: string; userIds: UserId[] } | null;
  /** The new messages' pushes, oldest message first, when they were asked for. */
  pushes: MessagePush[];
  /** The new messages' deliveries to bots' webhooks, oldest message first. */
  webhooks: MessageWebhook[];
  /** The new messages @ember and the agents are to answer, oldest first, each agent mentioned once. */
  asks: AssistantAsk[];
}

/**
 * What a room sends for the events the Workspace has applied: its new messages' pushes, deliveries to
 * bots' webhooks and questions for @ember.
 */
export type RoomEventDeliveries = Pick<AppliedEvents, "pushes" | "webhooks" | "asks">;

/** A new message's pushes: what they say, and the subscriptions they go to. */
export interface MessagePush {
  payload: PushPayload;
  deliveries: PushDelivery[];
}

/** One of someone's push subscriptions, with the user agent of the browser that saved it, if it sent one. */
export interface StoredPushSubscription {
  id: number;
  endpoint: string;
  userAgent: string | null;
}

/** A subscription a message is pushed to, and the count its push sets the app's badge to. */
export interface PushDelivery {
  subscriptionId: number;
  endpoint: string;
  p256dhKey: string;
  authKey: string;
  badge: number;
}

/**
 * A new message's delivery to a bot's webhook, as its room queues it: who wrote the message and where,
 * as the delivery names them, and the bot, whose webhook is found again once the delivery's turn comes
 * (`BotWebhook`).
 */
export interface MessageWebhook {
  messageId: string;
  author: User;
  /** The room's name, or null for a DM. */
  roomName: string | null;
  botId: UserId;
}

/**
 * A new message @ember or an agent, `botId`, is to answer, as `MESSAGE_BOTS` finds it: the message, its
 * author and the room's name, or null for a DM.
 */
export type AssistantAsk = MessageWebhook;

/**
 * A bot's webhook as a delivery to it finds it: the bot, by its name now, with its token, and the URL it
 * delivers to, saved when, which the key in the address it can answer at is made from (`webhookTokenOf`).
 */
export interface BotWebhook {
  bot: User;
  /** Null for a bot from before bots had tokens, which no key works for. */
  token: string | null;
  url: string;
  /** When the webhook was given its URL, which a new one changes. */
  savedAt: string;
}

/** An active bot as a key to its API finds it: with its token, whether it's in the room, and its webhook's URL, saved when, if it has one. */
export interface BotKey {
  bot: User;
  token: string | null;
  member: boolean;
  webhook: Pick<BotWebhook, "url" | "savedAt"> | null;
}

/** A revocation the Workspace has yet to deliver to its room. */
export interface PendingRevocation extends Revocation {
  id: number;
  roomId: RoomId;
}

/** A room the outbox has yet to ask to delete a banned person's messages. */
export interface PendingPurge {
  id: number;
  roomId: RoomId;
  userId: UserId;
  /** When their ban was lifted, if it has been, after which what they write stays. */
  liftedAt: string | null;
}

interface SessionRow {
  session_id: string;
  last_active_at: string;
  user_id: string;
  name: string;
  administrator: number;
  guest: number;
}

const INSERT_SESSION = `INSERT INTO sessions (id, user_id, token_digest, ip_address, user_agent, last_active_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Whether someone needs no Memberful membership: an administrator, or someone who joined with an
 * invitation. They sign in with a password while Memberful is members only, and a membership of theirs
 * lapsing doesn't suspend them.
 */
const NEEDS_NO_MEMBERSHIP = `(users.role = ${ADMINISTRATOR} OR users.invited_by IS NOT NULL)`;

/**
 * The same, for someone who signed in, unless they've stopped being active since, or their password
 * has been reset since it was checked, or they're no longer an administrator while the last value says
 * only administrators, and the people they invited, sign in with a password.
 */
const INSERT_SESSION_IF_UNCHANGED = `INSERT INTO sessions (id, user_id, token_digest, ip_address, user_agent, last_active_at, created_at, updated_at)
  SELECT ?, id, ?, ?, ?, ?, ?, ? FROM users WHERE id = ? AND status = ${ACTIVE} AND password_digest = ? AND (? = 0 OR ${NEEDS_NO_MEMBERSHIP})`;

/** Keeps a digest made now of the password someone signed in with, in place of the one checked, unless it has changed since. */
const REHASH_PASSWORD = `UPDATE users SET password_digest = ? WHERE id = ? AND password_digest = ?`;

/** The same, for someone signing in with an account elsewhere that's linked to them, unless they've stopped being active. */
const INSERT_LINKED_SESSION = `INSERT INTO sessions (id, user_id, token_digest, ip_address, user_agent, last_active_at, created_at, updated_at)
  SELECT ?1, id, ?2, ?3, ?4, ?5, ?5, ?5 FROM users WHERE id = ?6 AND status = ${ACTIVE}`;

/** What `email_links.kind` holds for an invitation, and for a link someone asked for with an address at the email domains. */
const INVITATION = "'invitation'";
const EMAIL_DOMAIN = "'email_domain'";

/** An invitation's row, with the name of who sent it. */
interface InvitationRow {
  id: string;
  email_address: string;
  invited_by: string;
  created_at: string;
  expires_at: string;
  sent_at: string | null;
  send_error: string | null;
}

/** The invitation `row` holds, as administrators see it. */
const invitationOf = (row: InvitationRow): EmailInvitation => ({
  id: row.id,
  emailAddress: row.email_address,
  invitedBy: row.invited_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  delivery: row.sent_at !== null ? "sent" : row.send_error !== null ? { refusal: row.send_error } : null,
});

/** The invitations no one has accepted, newest first, each with the name of who sent it last. */
const INVITATIONS = `SELECT email_links.id, email_links.email_address, users.name AS invited_by, email_links.created_at, email_links.expires_at,
    email_links.sent_at, email_links.send_error
  FROM email_links JOIN users ON users.id = email_links.invited_by WHERE email_links.kind = ${INVITATION}
  ORDER BY email_links.created_at DESC, email_links.id DESC`;

/**
 * Invites an address, or gives the invitation it has already a new link, which the old one no longer
 * joins with, from whoever sends it now, as unsent, answering its id. An address has one invitation,
 * whatever its case, and is kept as given last.
 */
const SAVE_INVITATION = `INSERT INTO email_links (id, token_digest, kind, email_address, invited_by, created_at, expires_at) VALUES (?, ?, ${INVITATION}, ?, ?, ?, ?)
  ON CONFLICT (kind, lower(email_address)) DO UPDATE SET token_digest = excluded.token_digest, email_address = excluded.email_address,
    invited_by = excluded.invited_by, created_at = excluded.created_at, expires_at = excluded.expires_at, sent_at = NULL, send_error = NULL
  RETURNING id`;

/** Gives an invitation's link ?1 a new one, ?2, which works until ?4, from ?5, as unsent, unless it's gone. */
const RENEW_INVITATION = `UPDATE email_links SET token_digest = ?2, created_at = ?3, expires_at = ?4, invited_by = ?5, sent_at = NULL, send_error = NULL
  WHERE id = ?1 AND kind = ${INVITATION} RETURNING email_address`;

/** Records what came of emailing the link with digest ?1: when it was sent, ?2, or why not, ?3, unless a newer link has taken its place. */
const RECORD_DELIVERY = `UPDATE email_links SET sent_at = ?2, send_error = ?3 WHERE token_digest = ?1`;

/**
 * Gives the address ?3 a new link to join with at the email domains, whose digest is ?2, made at ?4 and
 * working until ?5, in place of any it had. An address has one, whatever its case, kept as given last.
 */
const SAVE_EMAIL_DOMAIN_LINK = `INSERT INTO email_links (id, token_digest, kind, email_address, created_at, expires_at) VALUES (?1, ?2, ${EMAIL_DOMAIN}, ?3, ?4, ?5)
  ON CONFLICT (kind, lower(email_address)) DO UPDATE SET token_digest = excluded.token_digest, email_address = excluded.email_address,
    created_at = excluded.created_at, expires_at = excluded.expires_at`;

/**
 * Spends the links to ?1, whatever its case, as someone joins with that address, however they join: its
 * invitation, which leaves the list, and any link it was sent to join with at the email domains. Matches
 * none for no address.
 */
const SPEND_EMAIL_LINKS = `DELETE FROM email_links WHERE kind IN (${INVITATION}, ${EMAIL_DOMAIN}) AND lower(email_address) = lower(?)`;

/** Deletes the links to join with at the email domains that stopped working at ?1 or before, which nobody joined with. */
const FORGET_EXPIRED_EMAIL_DOMAIN_LINKS = `DELETE FROM email_links WHERE kind = ${EMAIL_DOMAIN} AND expires_at <= ?1`;

/** Forgets the counts of the times addresses were asked for whose hour began at ?1 or before. */
const FORGET_EMAIL_LINK_REQUESTS = `DELETE FROM email_link_requests WHERE counted_since <= ?1`;

/**
 * Counts a time the address ?1 was asked for, at ?2, answering how many it's had in the hour its count
 * is of, which starts again at ?2 once it began at ?3 or before, and when that hour began.
 */
const COUNT_EMAIL_LINK_REQUEST = `INSERT INTO email_link_requests (email_address, counted_since, count) VALUES (lower(?1), ?2, 1)
  ON CONFLICT (email_address) DO UPDATE SET
    counted_since = CASE WHEN email_link_requests.counted_since > ?3 THEN email_link_requests.counted_since ELSE excluded.counted_since END,
    count = CASE WHEN email_link_requests.counted_since > ?3 THEN email_link_requests.count + 1 ELSE 1 END
  RETURNING count, counted_since`;

/** Takes back a time the address ?1 was counted in the hour that began at ?2, while its count is of that hour still. */
const UNCOUNT_EMAIL_LINK_REQUEST = `UPDATE email_link_requests SET count = count - 1 WHERE email_address = lower(?1) AND counted_since = ?2 AND count > 0`;

/**
 * Keeps the code the person ?1 was emailed to reset their password, whose digest is ?2, in place of any
 * they had, for the address ?3 and the password whose digest is ?4, made at ?5 and working until ?6, and
 * not tried yet.
 */
const SAVE_PASSWORD_RESET = `INSERT INTO password_resets (user_id, code_digest, email_address, password_digest, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  ON CONFLICT (user_id) DO UPDATE SET code_digest = excluded.code_digest, email_address = excluded.email_address, password_digest = excluded.password_digest,
    created_at = excluded.created_at, expires_at = excluded.expires_at, attempts = 0`;

/** Deletes the codes to reset a password that stopped working at ?1 or before, which nobody used. */
const FORGET_EXPIRED_PASSWORD_RESETS = `DELETE FROM password_resets WHERE expires_at <= ?1`;

/**
 * The code to reset a password that works, at ?2, for the active person whose email address is exactly
 * ?1, as sign-in matches it: one emailed to that address, for the password they have now, which hasn't
 * expired.
 */
const WORKING_PASSWORD_RESET = `user_id = (SELECT id FROM users WHERE email_address = ?1 AND status = ${ACTIVE})
  AND password_digest = (SELECT password_digest FROM users WHERE email_address = ?1) AND email_address = ?1 AND expires_at > ?2`;

/** Counts a try of that code, while it has been tried fewer than ?3 times, answering its digest. */
const TRY_PASSWORD_RESET = `UPDATE password_resets SET attempts = attempts + 1 WHERE ${WORKING_PASSWORD_RESET} AND attempts < ?3 RETURNING code_digest`;

/** Whose that code is, if its digest is ?3. */
const PASSWORD_RESET_HOLDER = `SELECT user_id FROM password_resets WHERE ${WORKING_PASSWORD_RESET} AND code_digest = ?3`;

/** The lowercase email addresses, among those in ?1, a JSON array, that someone has whatever their case. */
const TAKEN_EMAIL_ADDRESSES = `SELECT lower(email_address) AS email_address FROM users WHERE lower(email_address) IN (SELECT lower(value) FROM json_each(?1))`;

/** The people the accounts at issuer ?1 with the subjects ?2, a JSON array, are linked to, with when each account's membership was last read. */
const LINKED_PEOPLE = `SELECT identities.subject, users.id, users.status, NOT ${NEEDS_NO_MEMBERSHIP} AS membership_needed, identities.checked_at
  FROM identities JOIN users ON users.id = identities.user_id WHERE identities.issuer = ?1 AND identities.subject IN (SELECT value FROM json_each(?2))`;

/**
 * Whether the membership of the person a linked account signs in as counts: a member's does, while
 * they're active, or suspended for its lapsing, unless they joined with an invitation. Administrators,
 * and the people they invited, are let in whatever their membership, and someone removed or banned
 * stays so.
 */
const MEMBERSHIP_COUNTS = `users.role = ${MEMBER} AND users.invited_by IS NULL AND users.status IN (${ACTIVE}, ${SUSPENDED})`;

/**
 * Queues checking the membership of the account at issuer ?1 with subject ?2, due at ?3, if its member's
 * counts, as a webhook about it came then. One queued already is due then too, unless it's due sooner, and
 * is checked again if it was asked about before then.
 */
const QUEUE_MEMBERSHIP_CHECK = `INSERT INTO membership_checks (issuer, subject, queued_at, due_at)
  SELECT identities.issuer, identities.subject, ?3, ?3 FROM identities JOIN users ON users.id = identities.user_id
  WHERE identities.issuer = ?1 AND identities.subject = ?2 AND ${MEMBERSHIP_COUNTS}
  ON CONFLICT (issuer, subject) DO UPDATE SET queued_at = excluded.queued_at, due_at = min(due_at, excluded.due_at)`;

/**
 * Queues checking the membership of every account at issuer ?1 whose member's counts, due at ?2, if the
 * site's catch-up is due by then. A check queued already stays as it is, so one Memberful has failed to
 * answer still waits its turn.
 */
const QUEUE_MEMBERSHIP_CATCH_UP = `INSERT INTO membership_checks (issuer, subject, queued_at, due_at)
  SELECT identities.issuer, identities.subject, ?2, ?2 FROM identities JOIN users ON users.id = identities.user_id
  WHERE identities.issuer = ?1 AND ${MEMBERSHIP_COUNTS} AND EXISTS (SELECT 1 FROM membership_catch_ups WHERE issuer = ?1 AND due_at <= ?2)
  ON CONFLICT DO NOTHING`;

/** Whether anyone here is linked to an account at issuer ?1, without whom a catch-up has nobody to check. */
const ANYONE_LINKED = `EXISTS (SELECT 1 FROM identities WHERE issuer = ?1)`;

/** Makes the catch-up at issuer ?1 due at ?2, unless it's due sooner, while anyone is linked to an account there. */
const SCHEDULE_MEMBERSHIP_CATCH_UP = `INSERT INTO membership_catch_ups (issuer, due_at) SELECT ?1, ?2 WHERE ${ANYONE_LINKED}
  ON CONFLICT (issuer) DO UPDATE SET due_at = min(due_at, excluded.due_at)`;

/** Makes the catch-up at issuer ?1 due at ?2, unless one is due already, however much later, while anyone is linked to an account there. */
const START_MEMBERSHIP_CATCH_UP = `INSERT INTO membership_catch_ups (issuer, due_at) SELECT ?1, ?2 WHERE ${ANYONE_LINKED} ON CONFLICT (issuer) DO NOTHING`;

/** Records that the memberships of the accounts at issuer ?1 with the subjects ?2, a JSON array, were read at ?3, unless they were since. */
const STAMP_MEMBERSHIPS = `UPDATE identities SET checked_at = ?3 WHERE issuer = ?1 AND subject IN (SELECT value FROM json_each(?2)) AND checked_at < ?3`;

/** Whom an account elsewhere can be connected to: someone active, neither a guest nor a bot. */
const CONNECTABLE = `users.status = ${ACTIVE} AND users.guest = 0 AND users.role <> ${BOT}`;

/**
 * Keeps the state digest ?1, started at ?2, for connecting the account of person ?3 to one at issuer ?5,
 * if they can connect one, their password's digest is still ?4, or "" without one, as it was checked, and
 * they aren't connected to an account there already. It keeps that digest too, which connecting needs to
 * be theirs still.
 */
const START_CONNECTION = `INSERT INTO pending_identities (state_digest, user_id, password_digest, created_at)
  SELECT ?1, id, ?4, ?2 FROM users WHERE id = ?3 AND ${CONNECTABLE} AND coalesce(password_digest, '') = ?4
    AND NOT EXISTS (SELECT 1 FROM identities WHERE identities.user_id = users.id AND identities.issuer = ?5)
  RETURNING user_id`;

/** Whether the person ?1 can have an account elsewhere connected, whether they need a membership, and the subject of theirs at issuer ?2, if they have one. */
const CONNECTING_PERSON = `SELECT NOT ${NEEDS_NO_MEMBERSHIP} AS membership_needed,
    (SELECT subject FROM identities WHERE identities.user_id = users.id AND identities.issuer = ?2) AS subject
  FROM users WHERE id = ?1 AND ${CONNECTABLE}`;

/**
 * Links the account at issuer ?1 with subject ?2, its membership read at ?3, named ?7 with the email
 * address ?8, to person ?5 at ?4, if they can have one connected and their password's digest is still
 * ?6, or "" without one, as it was when they started connecting it.
 */
const CONNECT_IDENTITY = `INSERT INTO identities (issuer, subject, user_id, checked_at, created_at, updated_at, name, email_address)
  SELECT ?1, ?2, id, ?3, ?4, ?4, ?7, ?8 FROM users WHERE id = ?5 AND ${CONNECTABLE} AND coalesce(password_digest, '') = ?6
  RETURNING user_id`;

/** Keeps what the account at issuer ?1 with subject ?2 says of itself now, its name ?3 and email address ?4, recording when, ?5, if either has changed. */
const REFRESH_IDENTITY = `UPDATE identities SET name = ?3, email_address = ?4, updated_at = ?5
  WHERE issuer = ?1 AND subject = ?2 AND (name IS NOT ?3 OR email_address IS NOT ?4)`;

/**
 * Unlinks every account elsewhere from person ?1 as a reset replaces the password they have, which
 * connected each, so that a new password, as a reset gives someone whose account was taken over, ends
 * every other way in. Someone without one, as people who signed in with Memberful are, keeps theirs
 * as they set a first password, and so does someone without an email address, who'd have nothing to
 * sign in with once unlinked, since signing in with a password takes one (a reset finds them by it).
 * Before the statement that gives them the new one.
 */
const UNLINK_ON_RESET = `DELETE FROM identities WHERE user_id = ?1
  AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND coalesce(password_digest, '') <> '' AND coalesce(email_address, '') <> '')`;

/** The same as their profile saves a new password, with ?2 as their email address from then on, or none, as the save gives it. */
const UNLINK_ON_NEW_PASSWORD = `DELETE FROM identities WHERE user_id = ?1 AND coalesce(?2, '') <> ''
  AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND coalesce(password_digest, '') <> '')`;

/**
 * Whether person ?1 is linked to an account at issuer ?2 and has the password whose digest is ?3, as the
 * Worker checked it, and an email address to sign in with it by: what each of a disconnection's
 * statements checks, so that a password or email address changed meanwhile, or an account disconnected
 * already, changes nothing.
 */
const DISCONNECTING = `EXISTS (SELECT 1 FROM identities JOIN users ON users.id = identities.user_id
  WHERE identities.user_id = ?1 AND identities.issuer = ?2 AND users.password_digest = ?3 AND coalesce(users.email_address, '') <> '')`;

/** Queues revoking the sockets of every session of person ?1 but ?7, in every room they're in, while `DISCONNECTING`, as `QUEUE_OTHER_SESSION_REVOCATIONS` does. */
const QUEUE_DISCONNECTED_SESSION_REVOCATIONS = `INSERT INTO pending_revocations (room_id, tag, code, due_at)
  SELECT memberships.room_id, ?4 || sessions.id, ?5, ?6 FROM sessions JOIN memberships ON memberships.user_id = sessions.user_id
  WHERE sessions.user_id = ?1 AND sessions.id <> ?7 AND ${DISCONNECTING} RETURNING id`;

/** Unlinks the account at issuer ?2 from person ?1, while their password's digest is ?3 and they have an email address, answering its subject. */
const DISCONNECT_IDENTITY = `DELETE FROM identities WHERE user_id = ?1 AND issuer = ?2
  AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND password_digest = ?3 AND coalesce(email_address, '') <> '') RETURNING subject`;

/**
 * The same, for someone signing in with a sign-in link, unless they're no longer active, or are a guest
 * while ?7 says guests can't stay signed in, or the session ?8 names, which showed the link, has ended,
 * is a guest's while ?7 says that, or is neither theirs nor an active administrator's.
 */
const INSERT_TRANSFERRED_SESSION = `INSERT INTO sessions (id, user_id, token_digest, ip_address, user_agent, last_active_at, created_at, updated_at)
  SELECT ?1, id, ?2, ?3, ?4, ?5, ?5, ?5 FROM users WHERE id = ?6 AND status = ${ACTIVE} AND (guest = 0 OR ?7 = 1)
    AND EXISTS (SELECT 1 FROM sessions AS showing JOIN users AS shower ON shower.id = showing.user_id
      WHERE showing.id = ?8 AND shower.status = ${ACTIVE} AND (shower.guest = 0 OR ?7 = 1)
        AND (shower.id = users.id OR shower.role = ${ADMINISTRATOR}))`;

/** The session a token's digest names, if its person is still active. */
const SESSION = `SELECT sessions.id AS session_id, sessions.last_active_at, users.id AS user_id, users.name,
    users.role = ${ADMINISTRATOR} AS administrator, users.guest
  FROM sessions JOIN users ON users.id = sessions.user_id
  WHERE sessions.token_digest = ? AND users.status = ${ACTIVE}`;

/** Someone as `DIRECTORY_COLUMNS` reads them. */
interface DirectoryRow {
  id: UserId;
  name: string;
  bio: string | null;
  role: number;
  status: number;
  updated_at: string;
  agent: number;
  agent_access: string | null;
}

/** The columns that say what avatar someone has uploaded (migrations/0032_avatars.sql). */
interface AvatarColumns {
  avatar_key: string | null;
  avatar_variant: string | null;
}

const avatarOf = (row: AvatarColumns): StoredPicture | null => (row.avatar_key === null ? null : { key: row.avatar_key, variant: row.avatar_variant });

/** What takes the reservation of `picture`'s key, if there is one, in the batch that gives someone or the workspace it. */
const keeping = (picture: StoredPicture | null): Statement[] => (picture ? [statement(KEEP_PICTURE, picture.key)] : []);

/**
 * What gives `userId` `avatar`, or none, recording when, and queues R2 deleting the one they had,
 * `previous`, at `dueAt`.
 */
const avatarChange = (userId: UserId, avatar: StoredPicture | null, previous: string | null, now: string, dueAt: number): Statement[] => [
  statement(CHANGE_AVATAR, avatar?.key ?? null, avatar?.variant ?? null, now, userId),
  ...keeping(avatar),
  ...(previous ? [statement(QUEUE_PICTURE_DELETION, previous, dueAt)] : []),
];

/**
 * What puts agent `agentId` in every open room, with null, or in just the open rooms `rooms` names,
 * taking it out of the others, and records which it's in.
 */
const roomsChange = (agentId: UserId, rooms: RoomId[] | null, now: string): Statement[] =>
  rooms === null
    ? [statement(`UPDATE agents SET every_open_room = 1 WHERE user_id = ?`, agentId), statement(GRANT_OPEN_ROOMS_TO_USER, agentId, now, now)]
    : [
        statement(`UPDATE agents SET every_open_room = 0 WHERE user_id = ?`, agentId),
        statement(LEAVE_UNPICKED_ROOMS, agentId, JSON.stringify(rooms)),
        statement(GRANT_PICKED_ROOMS, agentId, JSON.stringify(rooms), now),
      ];

/**
 * What takes agent `agentId` out of every room but its DMs, the private rooms it was put in too, as one
 * only administrators' direct messages reach is in none, and records that it's in none.
 */
const leaveEveryRoom = (agentId: UserId): Statement[] => [
  statement(`UPDATE agents SET every_open_room = 0 WHERE user_id = ?`, agentId),
  statement(LEAVE_SHARED_ROOMS, agentId),
];

/** Whom an agent is kept for, as its user keeps it, `kept`: nobody for null, as for anyone who isn't one, or for what can't be, as nothing Ember writes is. */
const keptForIn = (kept: string | null): KeptFor | null => (kept === "admins" || kept === "admin-dms" ? kept : null);

/** Whom an agent `access` says who can ask is kept for, as its user keeps it: nobody when everyone can. */
const keptForOf = (access: AgentAccess): KeptFor | null => (access === "everyone" ? null : access);

const directoryEntry = (row: DirectoryRow): DirectoryEntry => ({
  id: row.id,
  name: row.name,
  bio: row.bio,
  role: ROLES[row.role] ?? "member",
  status: STATUSES[row.status] ?? "active",
  updatedAt: row.updated_at,
  agent: row.agent === 1,
  keptFor: keptForIn(row.agent_access),
});

interface BotRow extends DirectoryRow {
  bot_token: string | null;
}

const storedBot = (row: BotRow, rooms: BotRoom[]): StoredBot => ({ ...directoryEntry(row), token: row.bot_token, rooms });

/** An agent as the AI assistant tab lists it, as `AGENTS` reads it. */
interface AgentRow extends DirectoryRow {
  description: string;
  model: string;
  model_name: string;
  web_tools: string | null;
  every_open_room: number;
}

/** An agent as its page shows it, as `AGENT` reads it. */
interface AgentSettingsRow extends AgentRow, AvatarColumns {
  instructions: string;
  prompt_template: string | null;
  format: string;
  thinking_levels: string | null;
  thinking: string;
  answer_length: string;
  changed_by: UserId;
  changed_by_name: string;
  changed_at: string;
}

/** An agent as `AgentRow` has it, kept to `rooms` unless it's in every open room. */
const storedAgent = (row: AgentRow, rooms: AgentRoom[]): StoredAgent => ({
  ...directoryEntry(row),
  description: row.description,
  model: row.model,
  modelName: row.model_name,
  webTools: webToolsIn(row.web_tools),
  access: keptForIn(row.agent_access) ?? "everyone",
  rooms: row.every_open_room === 1 ? null : rooms,
});

/** The format an agent's model is asked in, as the agents table keeps it, `kept`, or Chat Completions for what can't be one. */
const agentsFormatIn = (kept: string): ModelFormat => (isModelFormat(kept) ? kept : "chat");

/**
 * How an agent answers, as the agents table keeps it: its instructions and what Ember adds around them,
 * its model's format and the levels of thinking it takes, its levels and what it may do on the web.
 */
type AnsweringColumns = Pick<AgentSettingsRow, "instructions" | "prompt_template" | "format" | "thinking_levels" | "thinking" | "answer_length" | "web_tools">;

/** How an agent answers, as `row` keeps it. What can't be a format or a level, as nothing Ember writes is, reads as where @ember's start, and as untested levels of thinking. */
const answeringOf = (row: AnsweringColumns): Pick<AgentSetup, "instructions" | "promptTemplate" | "format" | "thinkingLevels" | "levels" | "webTools"> => ({
  instructions: row.instructions,
  promptTemplate: row.prompt_template,
  format: agentsFormatIn(row.format),
  thinkingLevels: row.thinking_levels === null ? null : (thinkingLevelsIn(JSON.parse(row.thinking_levels)) ?? null),
  levels: { thinking: levelIn(THINKING_LEVELS, row.thinking) ?? DEFAULT_LEVELS.thinking, length: levelIn(ANSWER_LENGTHS, row.answer_length) ?? DEFAULT_LEVELS.length },
  webTools: webToolsIn(row.web_tools),
});

/** An agent as `AgentSettingsRow` has it, kept to `rooms` unless it's in every open room. */
const storedAgentSettings = (row: AgentSettingsRow, rooms: AgentRoom[]): StoredAgentSettings => ({
  ...storedAgent(row, rooms),
  ...answeringOf(row),
  avatar: avatarOf(row),
  changedBy: { id: row.changed_by, name: row.changed_by_name },
  changedAt: row.changed_at,
});

/** The tools for the web a JSON list `kept` names, as the agents table keeps them, or none for null. */
function webToolsIn(kept: string | null): WebTool[] {
  const listed: unknown = kept === null ? [] : JSON.parse(kept);
  return WEB_TOOLS.filter((tool) => Array.isArray(listed) && listed.includes(tool));
}

/** An agent's setup's columns, as `INSERT_AGENT` and `CHANGE_AGENT` take them, in order. */
const agentColumns = ({ description, instructions, model, modelName, format, levels, webTools, promptTemplate, thinkingLevels }: AgentSetup) =>
  [
    description,
    instructions,
    model,
    modelName,
    format,
    levels.thinking,
    levels.length,
    webTools.length > 0 ? JSON.stringify(webTools) : null,
    promptTemplate,
    thinkingLevels && JSON.stringify(thinkingLevels),
  ] as const;

/** Whether a value is `present?`: not null, false, blank, or empty. */
function isPresent(value: unknown): boolean {
  if (value === null || value === false || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "object" || Object.keys(value).length > 0;
}

/** The account's settings, as stored, or null when they don't parse as a JSON object. */
function storedSettings(settings: string | null): Record<string, unknown> | null {
  let stored: unknown;
  try {
    stored = JSON.parse(settings ?? "{}");
  } catch {
    return null;
  }
  return typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : null;
}

/**
 * Whether the account's settings hide the translation buttons: hidden until the setting is stored, even
 * for an existing account, then only while it's present, so a stored false or blank shows them. Settings
 * that don't parse hide them.
 */
function hidesTranslationButtons(settings: Record<string, unknown> | null): boolean {
  const hide = settings ? settings.hide_translation_buttons : true;
  return hide === undefined || isPresent(hide);
}

/**
 * Whether the account's settings let only administrators create rooms: only while the setting is
 * present.
 */
const restrictsRoomCreation = (settings: Record<string, unknown> | null) => isPresent(settings?.restrict_room_creation_to_administrators);

/** The account's tagline, which its settings keep as `tagline`, or empty while it has none. */
const taglineIn = (settings: Record<string, unknown> | null) => (typeof settings?.tagline === "string" ? settings.tagline : "");

/** The account's custom domain, which its settings keep as `custom_domain`, or null while it has none. */
const customDomainIn = (settings: Record<string, unknown> | null) => (typeof settings?.custom_domain === "string" ? settings.custom_domain : null);

/** Where a deploy puts Ember, which the account's settings keep as `deployed_address`, or null until a page there told it. */
const deployedAddressIn = (settings: Record<string, unknown> | null) =>
  typeof settings?.deployed_address === "string" && isHost(settings.deployed_address) ? settings.deployed_address : null;

/** The custom domains Ember has moved away from, newest first, which the account's settings keep as `other_addresses`. */
function otherAddressesIn(settings: Record<string, unknown> | null): string[] {
  const kept = settings?.other_addresses;
  if (!Array.isArray(kept)) return [];
  return [...new Set(kept.filter((address: unknown): address is string => typeof address === "string" && isHost(address)))].slice(0, MAX_OTHER_ADDRESSES);
}

/** The address Ember's email comes from, which the account's settings keep as `email_from`, as `mailboxText` writes it, or null while it has none. */
function emailFromIn(settings: Record<string, unknown> | null): string | null {
  const mailbox = typeof settings?.email_from === "string" ? mailboxOf(settings.email_from) : null;
  return mailbox && mailboxText(mailbox);
}

/** The Resend API key an administrator gave Ember, sealed, which the account's settings keep as `resend_api_key`, or null while it has none. */
const resendApiKeyIn = (settings: Record<string, unknown> | null) => (typeof settings?.resend_api_key === "string" ? settings.resend_api_key : null);

/**
 * The keys of the Turnstile widget an administrator gave Ember, which the account's settings keep as
 * `turnstile_keys`, both together, `{ site_key, secret_key }`, the secret key sealed, or null while it
 * has none.
 */
function turnstileKeysIn(settings: Record<string, unknown> | null): SavedTurnstileKeys | null {
  const kept = settings?.turnstile_keys;
  if (typeof kept !== "object" || kept === null) return null;
  const { site_key: siteKey, secret_key: sealedSecretKey } = kept as Record<string, unknown>;
  return typeof siteKey === "string" && typeof sealedSecretKey === "string" ? { siteKey, sealedSecretKey } : null;
}

/**
 * The Memberful site and keys an administrator gave Ember, which the account's settings keep as
 * `memberful_keys`, `{ site, client_id, secrets }`, the secrets sealed together, or null while it has
 * none.
 */
function memberfulKeysIn(settings: Record<string, unknown> | null): SavedMemberfulKeys | null {
  const kept = settings?.memberful_keys;
  if (typeof kept !== "object" || kept === null) return null;
  const { site, client_id: clientId, secrets: sealedSecrets } = kept as Record<string, unknown>;
  return typeof site === "string" && typeof clientId === "string" && typeof sealedSecrets === "string" ? { site, clientId, sealedSecrets } : null;
}

/**
 * The Realtime SFU app huddles run through, which the account's settings keep as `huddles`,
 * `{ app_id, app_secret }`, the secret sealed, or null while huddles are off. The TURN key their relay
 * goes by is kept with it, as `relay`, so that turning huddles off forgets both.
 */
function huddlesIn(settings: Record<string, unknown> | null): SavedHuddles | null {
  const kept = settings?.huddles;
  if (typeof kept !== "object" || kept === null) return null;
  const { app_id: appId, app_secret: sealedAppSecret, relay } = kept as Record<string, unknown>;
  return typeof appId === "string" && typeof sealedAppSecret === "string" ? { appId, sealedAppSecret, relay: relayIn(relay) } : null;
}

/** The TURN key huddles' relay goes by, as `huddles` keeps it, `{ key_id, api_token }`, the token sealed, or null without one. */
function relayIn(kept: unknown): SavedRelay | null {
  if (typeof kept !== "object" || kept === null) return null;
  const { key_id: keyId, api_token: sealedApiToken } = kept as Record<string, unknown>;
  return typeof keyId === "string" && typeof sealedApiToken === "string" ? { keyId, sealedApiToken } : null;
}

/** `huddles` as the account's settings keep them. */
const storedHuddles = ({ appId, sealedAppSecret, relay }: SavedHuddles) => ({
  app_id: appId,
  app_secret: sealedAppSecret,
  ...(relay && { relay: { key_id: relay.keyId, api_token: relay.sealedApiToken } }),
});

/** Whether the account's settings let cameras go on in huddles, which they keep as `huddle_cameras`: unless that's stored as false, as the Cameras switch stores it. */
const showsHuddleCameras = (settings: Record<string, unknown> | null) => settings?.huddle_cameras !== false;

/** Whether they let screens be shared in huddles, which they keep as `huddle_screens`: unless that's stored as false, as the Screen sharing switch stores it. */
const sharesHuddleScreens = (settings: Record<string, unknown> | null) => settings?.huddle_screens !== false;

/**
 * How Ember AI asks AI Gateway, which the account's settings keep as `assistant`, `{ account_id,
 * api_token, model, format, models, web_tools, web_tools_asked_at, provider_endpoints_tried_at }`, the
 * API token sealed, or null while it's off. Its models are `[{ id, name, format, thinking_levels }]`, which Ember AI set up
 * before people could pick has none of: it then has its own model alone, as it does when they leave it
 * out. A model added before Ember asked models at each level of thinking has no `thinking_levels`. Without
 * `web_tools`, as Ember AI was kept before Search the web, @ember does nothing on the web, and without
 * `provider_endpoints_tried_at`, as it was kept before Ember asked Claude and GPT through their providers'
 * endpoints, their models are yet to be asked there.
 */
function assistantIn(settings: Record<string, unknown> | null): SavedAssistant | null {
  const kept = settings?.assistant;
  if (typeof kept !== "object" || kept === null) return null;
  const {
    account_id: accountId,
    api_token: sealedApiToken,
    model,
    format,
    models,
    web_tools: webTools,
    web_tools_asked_at: webToolsAskedAt,
    provider_endpoints_tried_at: providerEndpointsTriedAt,
  } = kept as Record<string, unknown>;
  if (typeof accountId !== "string" || typeof sealedApiToken !== "string" || typeof model !== "string" || !isModelFormat(format)) return null;
  const listed = savedModelsIn(models);
  const own = listed.some(({ id }) => id === model) ? listed : [{ id: model, name: modelName(model), format }, ...listed];
  return {
    accountId,
    sealedApiToken,
    model,
    format,
    models: own,
    webTools: WEB_TOOLS.filter((tool) => Array.isArray(webTools) && webTools.includes(tool)),
    webToolsAskedAt: typeof webToolsAskedAt === "string" ? webToolsAskedAt : null,
    providerEndpointsTriedAt: typeof providerEndpointsTriedAt === "string" ? providerEndpointsTriedAt : null,
  };
}

/** The models people can pick that `kept` lists, as `assistantIn` reads them, once each, leaving out what can't be one. */
function savedModelsIn(kept: unknown): SavedModel[] {
  const models = new Map<string, SavedModel>();
  for (const model of Array.isArray(kept) ? kept : []) {
    const { id, name, format, thinking_levels: kept } = typeof model === "object" && model !== null ? (model as Record<string, unknown>) : {};
    if (typeof id !== "string" || modelOf(id) !== id || models.has(id) || !isModelFormat(format)) continue;
    const thinkingLevels = thinkingLevelsIn(kept);
    models.set(id, { id, name: modelNameOf(name) ?? modelName(id), format, ...(thinkingLevels && { thinkingLevels }) });
  }
  return [...models.values()];
}

const isModelFormat = (format: unknown): format is ModelFormat => (MODEL_FORMATS as readonly unknown[]).includes(format);

/** The levels of thinking `kept` lists, as Ember keeps those a model takes, in order, or undefined when it isn't a list. */
const thinkingLevelsIn = (kept: unknown): ThinkingLevel[] | undefined => (Array.isArray(kept) ? THINKING_LEVELS.filter((level) => kept.includes(level)) : undefined);

/**
 * The most each of @ember's dials goes to, which the account's settings keep as `assistant_limits`,
 * `{ thinking, length }`, or the top for a dial administrators haven't set.
 */
function assistantMostIn(settings: Record<string, unknown> | null): AnswerLevels {
  const kept = settings?.assistant_limits;
  const { thinking, length } = typeof kept === "object" && kept !== null ? (kept as Record<string, unknown>) : {};
  return { thinking: levelIn(THINKING_LEVELS, thinking) ?? TOP_LEVELS.thinking, length: levelIn(ANSWER_LENGTHS, length) ?? TOP_LEVELS.length };
}

/** What Ember adds to @ember's own instructions, which the account's settings keep as `assistant_instructions`, or "" for nothing. */
function assistantInstructionsIn(settings: Record<string, unknown> | null): string {
  const kept = settings?.assistant_instructions;
  return typeof kept === "string" ? kept : "";
}

/** What Ember adds around them, which the account's settings keep as `assistant_prompt_template`, or null for Ember's own. */
function assistantPromptTemplateIn(settings: Record<string, unknown> | null): string | null {
  const kept = settings?.assistant_prompt_template;
  return typeof kept === "string" ? kept : null;
}

/** `kept` as one of a dial's `levels`, or null when it isn't one. */
const levelIn = <T extends string>(levels: readonly T[], kept: unknown): T | null => ((levels as readonly unknown[]).includes(kept) ? (kept as T) : null);

/** Ember AI as the account's settings keep it (`assistantIn`), or null for off. */
const assistantSetting = (assistant: SavedAssistant | null) =>
  JSON.stringify(
    assistant && {
      account_id: assistant.accountId,
      api_token: assistant.sealedApiToken,
      model: assistant.model,
      format: assistant.format,
      models: assistant.models.map(({ id, name, format, thinkingLevels }) => ({ id, name, format, ...(thinkingLevels && { thinking_levels: thinkingLevels }) })),
      web_tools: assistant.webTools,
      web_tools_asked_at: assistant.webToolsAskedAt,
      provider_endpoints_tried_at: assistant.providerEndpointsTriedAt,
    },
  );

/**
 * Whether the join link lets people in, which the account's settings keep as `join_link`: until the
 * setting is stored, as for an account from before it, then only while it's present, as translation
 * buttons are read. Settings that don't parse leave it on.
 */
function joinsWithLinkIn(settings: Record<string, unknown> | null): boolean {
  const on = settings ? settings.join_link : true;
  return on === undefined || isPresent(on);
}

/** Whether anyone may sign up without a link, which the account's settings keep as `open_sign_up`: only while the setting is present. */
const signsUpOpenlyIn = (settings: Record<string, unknown> | null) => isPresent(settings?.open_sign_up);

/**
 * Whether Memberful is members only, which the account's settings keep as `memberful_sign_in`: only
 * while the setting is present, and Memberful is on (`joinsWithMemberfulIn`).
 */
const signsInWithMemberful = (settings: Record<string, unknown> | null) => isPresent(settings?.memberful_sign_in) && joinsWithMemberfulIn(settings);

/**
 * Whether Memberful's members join with it, which the account's settings keep as `memberful_join`: only
 * while the setting is present, or, until it's stored, as for an account from before it, while
 * `memberful_sign_in` is, which let them join while it was Memberful's only setting.
 */
function joinsWithMemberfulIn(settings: Record<string, unknown> | null): boolean {
  const on = settings?.memberful_join;
  return isPresent(on === undefined ? settings?.memberful_sign_in : on);
}

/** Whether people may join with an address at the email domains, which the account's settings keep as `email_domain_sign_up`: only while the setting is present. */
const signsUpWithEmailDomainIn = (settings: Record<string, unknown> | null) => isPresent(settings?.email_domain_sign_up);

/**
 * The domains Email domain lets in, which the account's settings keep as `email_domains`, each as
 * `emailDomainOf` has domains and once, leaving out anything else, or none while they keep none.
 */
function emailDomainsIn(settings: Record<string, unknown> | null): string[] {
  const kept = settings?.email_domains;
  if (!Array.isArray(kept)) return [];
  return [...new Set(kept.map((domain: unknown) => (typeof domain === "string" ? emailDomainOf(domain) : null)).filter((domain) => domain !== null))];
}

/**
 * The navigation icons the account's settings keep as `ember_navigation_icons`: an object of slots,
 * where any other value is none, and a slot or an icon Ember doesn't know is left out.
 */
function navigationIconsIn(settings: Record<string, unknown> | null): NavigationIcons {
  const stored = settings?.ember_navigation_icons;
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
  const icons: NavigationIcons = {};
  for (const slot of NAVIGATION_SLOTS) {
    const icon = (stored as Record<string, unknown>)[slot];
    if (isRoomIcon(icon)) icons[slot] = icon;
  }
  return icons;
}

interface RoomToChangeRow extends SharedRoom {
  can_administer: number;
}

/** A room's huddle as the room last reported it: when it started, and who's in it, a JSON list of their ids in the order they joined. */
interface HuddleRow {
  huddle_started_at: string;
  huddle_user_ids: string;
}

/** A room someone is in, as `ROOMS_FOR_USER` reads it: a DM's name and icon are null. */
interface SidebarRow extends HuddleRow {
  id: RoomId;
  kind: SidebarRoom["kind"];
  name: string | null;
  icon: SharedRoom["icon"];
  active_at: string;
  unread: number;
  unread_since: string | null;
  involvement: Involvement;
  shared_position: number | null;
}

/** Someone in a DM, as the statements that read a DM's people return them. */
interface DirectMemberRow extends User {
  room_id: RoomId;
}

/** Someone in a DM, as `DIRECT_WITH_KEY` reads them, with when the DM was last active. */
interface KeyedDirectMemberRow extends DirectMemberRow {
  active_at: string;
}

/** A row naming someone, as the statements that answer whom they changed return them. */
interface UserIdRow {
  user_id: UserId;
}

const userIdsOf = (rows: UserIdRow[]) => rows.map((row) => row.user_id);

/** A new message's pushes, from the subscriptions `MESSAGE_PUSHES` found for it: none when it found none. */
function messagePushes(roomId: RoomId, { message }: RoomEvent, rows: PushRow[]): MessagePush[] {
  if (rows.length === 0) return [];
  const [{ kind, name, author_name }] = rows as [PushRow];
  const { id, plainText, parentId } = message!;
  return [
    {
      payload: messagePayload(roomId, { kind, name }, author_name, plainText, parentId === undefined ? undefined : { parentId, replyId: id }),
      deliveries: rows.map(deliveryOf),
    },
  ];
}

/** Whether `ROOM_RANKED` found that the shared order ranks the room. */
const isRanked = (rows: unknown[]) => (rows as Array<{ ranked: number }>)[0]?.ranked === 1;

/** A DM's people, as the app has them, from the rows naming them. */
const membersOf = (rows: DirectMemberRow[]): User[] => rows.map(({ id, name }) => ({ id, name }));

/** A room someone is in, with the people in it if it's a DM, whom `members` reads. */
const roomOf = ({ id, kind, name, icon, active_at }: SidebarRow, members: DirectMemberRow[] = []): Room =>
  kind === "direct" ? { id, kind, members: membersOf(members), activeAt: active_at } : { id, kind, name: name ?? "", icon };

/** A room as someone's sidebar lists it, with whether it's marked unread for them, since when, and their level in it. */
const sidebarRoom = (row: SidebarRow, members?: DirectMemberRow[]): SidebarRoom => ({
  ...roomOf(row, members),
  unread: row.unread === 1,
  ...(row.unread_since !== null && { unreadSince: row.unread_since }),
  involvement: row.involvement,
});

const roomToChange = (row: RoomToChangeRow) => ({ room: { id: row.id, kind: row.kind, name: row.name, icon: row.icon }, canAdminister: row.can_administer === 1 });

const storedSession = (row: SessionRow): StoredSession => ({
  id: row.session_id,
  user: { id: row.user_id, name: row.name },
  administrator: row.administrator === 1,
  guest: row.guest === 1,
  lastActiveAt: Date.parse(row.last_active_at),
});

/** When a room was last active: when its latest message came, or when it was made, until one has. */
const ACTIVE_AT = `coalesce(rooms.last_message_at, rooms.created_at) AS active_at`;

/**
 * The rooms someone is in, hidden ones too, with whether each is marked unread for them, their level in
 * it and when it was last active, which orders DMs, and each room's place in the shared order. They come
 * in the order they were put in them, which the sidebar keeps for the rooms they haven't starred and the
 * shared order doesn't rank, so a room someone's just been put in, new or not, comes last, and the app
 * goes home to the first and `/rooms` to the latest. The rooms they were put in at once, as someone who
 * joins is put in every open room, go in the order they were made, and rooms from before the Workspace
 * kept a list (`LEGACY_ROOMS`), whose ids don't sort by time, by when they were listed.
 */
export const ROOMS_FOR_USER = `SELECT rooms.id, rooms.kind, rooms.name, rooms.icon, ${ACTIVE_AT}, memberships.unread_at IS NOT NULL AS unread,
    memberships.unread_at AS unread_since, memberships.involvement, rooms.shared_position, rooms.huddle_started_at, rooms.huddle_user_ids
  FROM memberships JOIN rooms ON rooms.id = memberships.room_id
  WHERE memberships.user_id = ? ORDER BY memberships.created_at, rooms.created_at, rooms.id`;

/** The ids of the rooms in `rows` that the shared order ranks, in its order. */
const sharedOrderOf = (rows: SidebarRow[]): RoomId[] =>
  rows
    .filter((row) => row.shared_position !== null)
    .sort((a, b) => a.shared_position! - b.shared_position!)
    .map((row) => row.id);

/**
 * The workspace's first room, where the welcome card shows: its oldest, of any kind. Rooms from before
 * the Workspace kept a list (`LEGACY_ROOMS`) count from when they were listed, as they do in
 * `ROOMS_FOR_USER`, so the old preview's is its general.
 */
export const ORIGINAL_ROOM = `SELECT id FROM rooms ORDER BY created_at, id LIMIT 1`;

/**
 * How many people with a role other than ?2 joined at or after ?1, counting no further than ?3, so that
 * it reads no more of the index on when people joined than that, as open sign-up's hourly limit asks.
 */
export const PEOPLE_JOINED_SINCE = `SELECT count(*) AS joined FROM (SELECT 1 FROM users WHERE created_at >= ?1 AND role != ?2 LIMIT ?3)`;

/**
 * Who's in each of someone's DMs, them included, a DM at a time, each DM's people by id.
 */
export const DIRECT_MEMBERS_FOR_USER = `SELECT members.room_id, users.id, users.name
  FROM memberships AS mine JOIN rooms ON rooms.id = mine.room_id
    JOIN memberships AS members ON members.room_id = mine.room_id JOIN users ON users.id = members.user_id
  WHERE mine.user_id = ? AND rooms.kind = 'direct' ORDER BY members.room_id, members.user_id`;

/** Who's in a room's huddle while it has none going on: nobody. */
const NOBODY = "[]";

/** The huddle going on in a room, as its row keeps it, or null when none is. */
const liveHuddleOf = (row: HuddleRow): LiveHuddle | null =>
  row.huddle_user_ids === NOBODY ? null : { startedAt: row.huddle_started_at, userIds: JSON.parse(row.huddle_user_ids) as UserId[] };

/** The huddles going on in the rooms `rows` lists, by room. */
function liveHuddlesIn(rows: SidebarRow[]): Record<RoomId, LiveHuddle> {
  const huddles: Record<RoomId, LiveHuddle> = {};
  for (const row of rows) {
    const huddle = liveHuddleOf(row);
    if (huddle) huddles[row.id] = huddle;
  }
  return huddles;
}

/**
 * Keeps room ?1's huddle as the room reported it at ?2: started at ?3, with the people ?4 lists in it,
 * or nobody once it's over. A report no later than the one kept changes nothing, nor does one that says
 * what's kept already, but for its time (`KEEP_REPORT_TIME`). Answers the room if it changed what's kept.
 */
const REPORT_HUDDLE = `UPDATE rooms SET huddle_reported_at = ?2, huddle_started_at = ?3, huddle_user_ids = ?4
  WHERE id = ?1 AND huddle_reported_at < ?2 AND (huddle_user_ids <> ?4 OR huddle_started_at <> ?3) RETURNING id`;

/**
 * Who's in room ?1, to hear of its huddle, if the report kept of it is the one made at ?2, as it is once
 * `REPORT_HUDDLE` has changed what's kept, and not yet when `KEEP_REPORT_TIME` keeps only the time. A
 * room says who's in its huddle again every half a minute, and a report that changes nothing reads no
 * memberships.
 */
export const MEMBERS_TO_TELL_OF_HUDDLE = `SELECT user_id FROM memberships
  WHERE room_id = ?1 AND EXISTS (SELECT 1 FROM rooms WHERE id = ?1 AND huddle_reported_at = ?2)`;

/**
 * Keeps ?2 as when room ?1 last reported its huddle, after `REPORT_HUDDLE` has left the time as it was
 * for a report that says what's kept already. A report made before it can still arrive after it, as
 * one the room gave up waiting for does, and the later time is what has that change nothing: it would
 * otherwise show the wrong people until the room's next report, or start a huddle that's over again,
 * with nobody left in it to say so, as when the Workspace never heard of the huddle.
 */
const KEEP_REPORT_TIME = `UPDATE rooms SET huddle_reported_at = ?2 WHERE id = ?1 AND huddle_reported_at < ?2`;

/** When the report kept of a room's huddle was made. */
const HUDDLE_REPORTED_AT = `SELECT huddle_reported_at FROM rooms WHERE id = ?`;

/** A room's huddle, as its row keeps it. */
const HUDDLE = `SELECT huddle_started_at, huddle_user_ids FROM rooms WHERE id = ?`;

/**
 * A DM's key: its people's ids, each once, sorted, as a JSON array, so each group of people has one key
 * whatever order they're named in, and `json_each` reads it back.
 */
const directKey = (memberIds: UserId[]) => JSON.stringify([...new Set(memberIds)].sort());

/**
 * Adds a DM, ?1, made by ?2 for the people ?3 is the key of, as of ?4, unless those people have one
 * already, answering it if it added it.
 */
const INSERT_DIRECT = `INSERT INTO rooms (id, kind, creator_id, direct_key, created_at, updated_at) VALUES (?1, 'direct', ?2, ?3, ?4, ?4)
  ON CONFLICT (direct_key) DO NOTHING RETURNING id`;

/**
 * Puts the people key ?3 names in DM ?1, as of ?2, if `INSERT_DIRECT` added it, at Campfire's
 * `default_involvement` for a DM, everything.
 */
const GRANT_DIRECT = `INSERT INTO memberships (room_id, user_id, involvement, created_at, updated_at)
  SELECT ?1, users.id, 'everything', ?2, ?2 FROM users
  WHERE users.id IN (SELECT value FROM json_each(?3)) AND EXISTS (SELECT 1 FROM rooms WHERE id = ?1)
  ON CONFLICT DO NOTHING`;

/** The DM a key names, when it was last active, and who's in it, by id. */
const DIRECT_WITH_KEY = `SELECT rooms.id AS room_id, ${ACTIVE_AT}, users.id, users.name
  FROM rooms JOIN memberships ON memberships.room_id = rooms.id JOIN users ON users.id = memberships.user_id
  WHERE rooms.direct_key = ? ORDER BY memberships.user_id`;

/**
 * Queues revoking a session's sockets in every room its person is in, the only rooms it can have
 * sockets in, answering a row for each room.
 */
const QUEUE_SESSION_REVOCATIONS = `INSERT INTO pending_revocations (room_id, tag, code, due_at)
  SELECT memberships.room_id, ? || sessions.id, ?, ? FROM sessions JOIN memberships ON memberships.user_id = sessions.user_id
  WHERE sessions.token_digest = ? RETURNING id`;

/**
 * Whether a membership is that of someone suspended for their Memberful membership's lapsing, in a room
 * that's private already, which changing the room leaves be: its settings list only people active, and
 * the room is theirs again once their membership is renewed. Making an open room private takes them out,
 * as it does everyone else nobody chose for it. It's read before the room's kind changes.
 */
const KEPT_SUSPENDED_MEMBERSHIP = `EXISTS (SELECT 1 FROM users JOIN rooms ON rooms.id = memberships.room_id
  WHERE users.id = memberships.user_id AND users.status = ${SUSPENDED} AND rooms.kind = 'closed')`;

/**
 * Queues closing the sockets of everyone in a room but the people a JSON list names and anyone
 * suspended whose membership it keeps (`KEPT_SUSPENDED_MEMBERSHIP`), whom changing the room takes out of
 * it, answering a row for each. Their person tag closes all their sockets there.
 */
export const QUEUE_MEMBER_REVOCATIONS = `INSERT INTO pending_revocations (room_id, tag, code, due_at)
  SELECT room_id, user_id, ?, ? FROM memberships WHERE room_id = ? AND user_id NOT IN (SELECT value FROM json_each(?)) AND NOT ${KEPT_SUSPENDED_MEMBERSHIP}
  RETURNING id`;

/**
 * Queues revoking the sockets of each of someone's sessions in every room they're in, answering a row
 * for each session in each room. Session tags, rather than their person tag, so a delivery tried again
 * after they've signed in afresh leaves the new session's sockets open.
 */
const QUEUE_PERSON_SESSION_REVOCATIONS = `INSERT INTO pending_revocations (room_id, tag, code, due_at)
  SELECT memberships.room_id, ? || sessions.id, ?, ? FROM sessions JOIN memberships ON memberships.user_id = sessions.user_id
  WHERE sessions.user_id = ? RETURNING id`;

/** The same, for every session of theirs but the one the last value names, which stays signed in. */
const QUEUE_OTHER_SESSION_REVOCATIONS = `INSERT INTO pending_revocations (room_id, tag, code, due_at)
  SELECT memberships.room_id, ? || sessions.id, ?, ? FROM sessions JOIN memberships ON memberships.user_id = sessions.user_id
  WHERE sessions.user_id = ? AND sessions.id <> ? RETURNING id`;

/** Revocations due by a time, those due longest first, up to a number of them. */
export const DUE_REVOCATIONS = `SELECT id, room_id AS roomId, tag, code FROM pending_revocations WHERE due_at <= ? ORDER BY due_at, id LIMIT ?`;

/**
 * The revocations due by a time that no delivery has tried yet, which a change has just queued: those
 * of the rooms queued last, up to a number of rooms (a call each), every row of each in the order they
 * were queued, since a socket closes with the first that names it. What a change delivers before it
 * answers (workspace.ts `closeQueuedSockets`).
 */
export const QUEUED_REVOCATIONS = `SELECT revocations.id, revocations.room_id AS roomId, revocations.tag, revocations.code
  FROM pending_revocations AS revocations
  JOIN (SELECT room_id, max(id) AS last FROM pending_revocations WHERE attempts = 0 AND due_at <= ?1 GROUP BY room_id ORDER BY last DESC LIMIT ?2) AS rooms
    ON rooms.room_id = revocations.room_id
  WHERE revocations.attempts = 0 AND revocations.due_at <= ?1
  ORDER BY rooms.last DESC, revocations.id`;

/**
 * Queues deleting someone's messages in every room they can have written in, answering a row for
 * each: every room but the DMs they aren't in, whose people never change.
 */
const QUEUE_PURGES = `INSERT INTO pending_purges (room_id, user_id, due_at)
  SELECT id, ?1, ?2 FROM rooms WHERE kind <> 'direct' OR id IN (SELECT room_id FROM memberships WHERE user_id = ?1) RETURNING id`;

/**
 * Queues having every room close the sockets from each address in a JSON list, telling them to connect
 * again, answering a row for each room and address: banning an address, or lifting the ban, changes
 * what they may do, which the Workspace checks as they connect.
 */
const QUEUE_ADDRESS_REVOCATIONS = `INSERT INTO pending_revocations (room_id, tag, code, due_at)
  SELECT rooms.id, ?1 || addresses.value, ?2, ?3 FROM rooms, json_each(?4) AS addresses RETURNING id`;

/** The same for the addresses someone's ban blocks, which lifting it unblocks. */
const QUEUE_UNBANNED_ADDRESS_REVOCATIONS = `INSERT INTO pending_revocations (room_id, tag, code, due_at)
  SELECT rooms.id, ?1 || addresses.ip_address, ?2, ?3 FROM rooms, (SELECT DISTINCT ip_address FROM bans WHERE user_id = ?4) AS addresses
  RETURNING id`;

/**
 * The purges a room can take: none while it has sockets left to close, which may be the banned person's,
 * who could write through one after their purge had finished. The outbox holds a revocation only until
 * its room answers, so this reads them all rather than keep an index.
 */
const PURGEABLE = `room_id NOT IN (SELECT room_id FROM pending_revocations)`;

/** Purges due by a time that their rooms can take, those due longest first, up to a number of them. */
export const DUE_PURGES = `SELECT id, room_id AS roomId, user_id AS userId, lifted_at AS liftedAt FROM pending_purges
  WHERE due_at <= ? AND ${PURGEABLE} ORDER BY due_at, id LIMIT ?`;

/** When the next purge a room can take is due. One waiting on its room's revocations is due once they've gone. */
export const NEXT_PURGE_DUE = `SELECT due_at FROM pending_purges WHERE ${PURGEABLE} ORDER BY due_at LIMIT 1`;

/** How long the outbox waits to deliver a row again after it fails, doubling each time up to the longest wait. */
const FIRST_RETRY_MS = 1_000;
const LONGEST_RETRY_MS = 5 * 60 * 1000;
/**
 * How many times a failed row's wait doubles before it stays at the longest: doubled this often, it's
 * past the longest already, and shifting the first wait by every failure would soon overflow. The outbox
 * never gives a row up. A revocation given up would leave the sockets it closes open, and able to write;
 * a room's deletion would leave its messages stored, with nothing left to delete them; a purge would
 * leave a banned person's messages up.
 */
const RETRY_DOUBLINGS = 10;

/** Whether someone is in a room. */
export const MEMBERSHIP = `SELECT 1 FROM memberships WHERE room_id = ? AND user_id = ?`;

/** The direct conversation ?1, if its members are ?2 and ?3 alone, each of them active. */
const BETWEEN = `SELECT 1 FROM rooms WHERE id = ?1 AND kind = 'direct' AND (SELECT COUNT(*) FROM memberships WHERE room_id = ?1) = 2
  AND (SELECT COUNT(*) FROM memberships JOIN users ON users.id = memberships.user_id
    WHERE memberships.room_id = ?1 AND memberships.user_id IN (?2, ?3) AND users.status = ${ACTIVE}) = 2`;

/**
 * Whether someone is in a room, and whether a ban blocks the IP address they come from, in one go,
 * asked on every room socket's upgrade.
 */
export const ROOM_ACCESS = `SELECT EXISTS (SELECT 1 FROM memberships WHERE room_id = ? AND user_id = ?) AS member,
  EXISTS (SELECT 1 FROM bans WHERE ip_address = ?) AS banned`;

/**
 * Marks a room unread, as of a message, for its members who aren't marked already, haven't hidden it,
 * didn't write the message and aren't among the people a JSON list names, who are viewing it, answering
 * a row for each. It writes only the rows it changes. Nothing changes once the Workspace has applied the
 * message's event, so one delivered again is applied once.
 */
export const MARK_UNREAD = `UPDATE memberships SET unread_at = ?1
  WHERE room_id = ?2 AND unread_at IS NULL AND involvement <> 'invisible' AND user_id <> ?3
    AND user_id NOT IN (SELECT value FROM json_each(?4)) AND ?5 > (SELECT applied_seq FROM rooms WHERE id = ?2)
  RETURNING user_id`;

/** Clears someone's unread mark on a room, answering a row if there was one, once for each event. */
export const MARK_READ = `UPDATE memberships SET unread_at = NULL
  WHERE room_id = ?1 AND user_id = ?2 AND unread_at IS NOT NULL AND ?3 > (SELECT applied_seq FROM rooms WHERE id = ?1)
  RETURNING user_id`;

/**
 * Everyone in DM ?1, to tell of a message in it, numbered ?2, that the Workspace hasn't applied yet,
 * and nobody for any other room or a message applied before.
 */
const TOLD_OF_DIRECT_MESSAGE = `SELECT user_id FROM memberships
  WHERE room_id = ?1 AND ?2 > (SELECT applied_seq FROM rooms WHERE id = ?1 AND kind = 'direct')`;

/**
 * Where a new message, numbered ?5, by ?2 in room ?1 is pushed: to the subscriptions of the room's
 * active members other than its author and the people a JSON list ?3 names, who are viewing it, or its
 * thread for a reply sent only there, at all messages, when it's in the room's timeline, as ?7 says, then
 * of those at @mentions or all messages whom it mentions, a JSON list ?4, or who follow the thread it's a
 * reply in, a JSON list ?8, each in the order they were saved. Guests are left out unless ?6 says they
 * can stay signed in. Each comes with the room, its author's name and the count its push sets the badge
 * to: how many of its owner's conversations are marked unread. Nothing once the Workspace has applied the
 * message's event.
 */
export const MESSAGE_PUSHES = `SELECT push_subscriptions.id, push_subscriptions.endpoint, push_subscriptions.p256dh_key, push_subscriptions.auth_key,
    (SELECT count(*) FROM memberships AS marked WHERE marked.user_id = memberships.user_id AND marked.unread_at IS NOT NULL) AS badge,
    rooms.kind, rooms.name, (SELECT name FROM users AS authors WHERE authors.id = ?2) AS author_name
  FROM rooms
    JOIN memberships ON memberships.room_id = rooms.id
    JOIN users ON users.id = memberships.user_id
    JOIN push_subscriptions ON push_subscriptions.user_id = memberships.user_id
  WHERE rooms.id = ?1 AND ?5 > rooms.applied_seq AND memberships.user_id <> ?2 AND users.status = ${ACTIVE} AND (users.guest = 0 OR ?6 = 1)
    AND memberships.user_id NOT IN (SELECT value FROM json_each(?3))
    AND ((memberships.involvement = 'everything' AND ?7 = 1) OR (memberships.involvement IN ('everything', 'mentions')
      AND (memberships.user_id IN (SELECT value FROM json_each(?4)) OR memberships.user_id IN (SELECT value FROM json_each(?8)))))
  ORDER BY memberships.involvement = 'mentions', push_subscriptions.id`;

/**
 * Whether push subscription ?1 is still saved, for someone active. Its id is never another's, as
 * AUTOINCREMENT numbers them.
 */
const PUSHABLE = `SELECT 1 FROM push_subscriptions JOIN users ON users.id = push_subscriptions.user_id
  WHERE push_subscriptions.id = ?1 AND users.status = ${ACTIVE}`;

/** A subscription a push goes to, and the count it sets the badge to. */
interface DeliveryRow {
  id: number;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
  badge: number;
}

interface PushRow extends DeliveryRow {
  kind: RoomKind;
  name: string | null;
  author_name: string;
}

/**
 * Someone's push subscription ?1, to send a test push to, with the count it sets the badge to, as
 * `MESSAGE_PUSHES` counts it, and nothing when it's someone else's, ?2 being whose it should be.
 */
const TEST_PUSH = `SELECT id, endpoint, p256dh_key, auth_key,
    (SELECT count(*) FROM memberships AS marked WHERE marked.user_id = push_subscriptions.user_id AND marked.unread_at IS NOT NULL) AS badge
  FROM push_subscriptions WHERE id = ?1 AND user_id = ?2`;

const deliveryOf = (row: DeliveryRow): PushDelivery => ({
  subscriptionId: row.id,
  endpoint: row.endpoint,
  p256dhKey: row.p256dh_key,
  authKey: row.auth_key,
  badge: row.badge,
});

/** Whether `id`, a parameter, is an active administrator's, as a statement asks of whoever it reads `users` for. */
const administratorIs = (id: string) => `EXISTS (SELECT 1 FROM users AS askers WHERE askers.id = ${id} AND askers.role = ${ADMINISTRATOR} AND askers.status = ${ACTIVE})`;

/**
 * Whether the user `users` reads is listed to `asker`, a parameter: anyone but an AI agent only
 * administrators' direct messages reach, deleted or not, which only an administrator is told of.
 */
const listedTo = (asker: string) => `(users.agent_access IS NOT 'admin-dms' OR ${administratorIs(asker)})`;

/**
 * Whether `asker`, a parameter, can ask the user `users` reads: anyone can, unless it's an AI agent kept
 * for administrators, which only an administrator mentions or writes to.
 */
const askedBy = (asker: string) => `(users.agent_access IS NULL OR ${administratorIs(asker)})`;

/**
 * Whether the bot `users` reads answers `asker` in room `room`, both parameters: any does, unless it's an
 * AI agent kept for administrators, which answers only an administrator, and one only their direct
 * messages reach only where everyone else in the room is an administrator, so that nobody else reads
 * what it says: no member, and nobody with the key of a bot there, which reads the room and is sent it.
 */
const answersTo = (asker: string, room: string) => `(users.agent_access IS NULL OR (${administratorIs(asker)}
    AND (users.agent_access <> 'admin-dms' OR NOT EXISTS (SELECT 1 FROM memberships AS others JOIN users AS people ON people.id = others.user_id
      WHERE others.room_id = ${room} AND others.user_id <> users.id AND people.role <> ${ADMINISTRATOR}))))`;

/**
 * The bots a new message, numbered ?4, by ?2 in room ?1 goes to: in a DM, the active bots in it, and in
 * any other room, the active bots in it whom the message mentions, a JSON list ?3; never its author.
 * They're the bots with webhooks, which it's delivered to, and @ember and the agents, which answer it
 * (`answers` 1) unless a bot wrote it, @ember or an agent among them, so that bots can't keep each other
 * talking, or it's from someone an agent kept for administrators doesn't answer (`answersTo`). Each
 * comes with the room's name, but a DM's, and the author's, and its id: a bot's webhook `BOT_WEBHOOK`
 * reads once the delivery's turn comes. Nothing once the Workspace has applied the message's event.
 * Webhooks and agents are few, so they're read first, with @ember, and each one's bot and membership
 * found by their keys.
 */
export const MESSAGE_BOTS = `SELECT users.id, bots.answers,
    (SELECT name FROM rooms WHERE id = ?1 AND kind <> 'direct') AS room_name, (SELECT name FROM users AS authors WHERE authors.id = ?2) AS author_name
  FROM (SELECT user_id, 0 AS answers FROM webhooks UNION ALL SELECT '${ASSISTANT_ID}', 1 UNION ALL SELECT user_id, 1 FROM agents) AS bots
    CROSS JOIN users ON users.id = bots.user_id
  WHERE users.role = ${BOT} AND users.status = ${ACTIVE} AND users.id <> ?2
    AND (bots.answers = 0 OR NOT EXISTS (SELECT 1 FROM users AS authors WHERE authors.id = ?2 AND authors.role = ${BOT}))
    AND EXISTS (SELECT 1 FROM memberships WHERE memberships.room_id = ?1 AND memberships.user_id = users.id)
    AND (users.id IN (SELECT value FROM json_each(?3)) OR EXISTS (SELECT 1 FROM rooms WHERE id = ?1 AND kind = 'direct'))
    AND ${answersTo("?2", "?1")}
    AND ?4 > (SELECT applied_seq FROM rooms WHERE id = ?1)
  ORDER BY lower(users.name), users.id`;

/** A bot a new message goes to, as `MESSAGE_BOTS` finds it, and whether it answers it, as @ember and the agents do. */
interface MessageBotRow {
  id: UserId;
  answers: number;
  room_name: string | null;
  author_name: string;
}

/** Where a new message goes, from the rows `MESSAGE_BOTS` found for it: to bots' webhooks, and to @ember and the agents to answer. */
function messageDeliveries({ userId, message }: RoomEvent, rows: MessageBotRow[]): Array<MessageWebhook & { answers: boolean }> {
  return rows.map((row) => ({ messageId: message!.id, author: { id: userId, name: row.author_name }, roomName: row.room_name, botId: row.id, answers: row.answers === 1 }));
}

/**
 * Bot ?2's webhook, with its name and token now, and when its URL was saved, as a delivery to it in room
 * ?1 finds it when its turn comes and again before what the bot says back is posted: nothing once the
 * bot isn't an active one in the room with a webhook, as `MESSAGE_BOTS` would find none for it then.
 */
export const BOT_WEBHOOK = `SELECT users.name, users.bot_token, webhooks.url, webhooks.updated_at FROM users JOIN webhooks ON webhooks.user_id = users.id
  WHERE users.id = ?2 AND users.role = ${BOT} AND users.status = ${ACTIVE}
    AND EXISTS (SELECT 1 FROM memberships WHERE memberships.room_id = ?1 AND memberships.user_id = users.id)`;

/**
 * Who clicked a button in room ?1, ?2, by their name now, with the room's name, but a DM's, as a click's
 * delivery names them: nothing once they aren't an active member of the room.
 */
const CLICKER = `SELECT users.name, (SELECT name FROM rooms WHERE id = ?1 AND kind <> 'direct') AS room_name FROM users
  WHERE users.id = ?2 AND users.status = ${ACTIVE}
    AND EXISTS (SELECT 1 FROM memberships WHERE memberships.room_id = ?1 AND memberships.user_id = users.id)`;

/** Who clicked a button in room ?1, ?2, by their name now, and whether they run the workspace: nothing once they aren't an active member of the room. */
const ROOM_MEMBER = `SELECT users.name, users.role = ${ADMINISTRATOR} AS administrator FROM users
  WHERE users.id = ?2 AND users.status = ${ACTIVE}
    AND EXISTS (SELECT 1 FROM memberships WHERE memberships.room_id = ?1 AND memberships.user_id = users.id)`;

/** Whether a room's event is a new message: anyone's, or a bot's reply to a webhook delivery. */
const isNewMessage = ({ kind }: RoomEvent) => kind !== "read";

/** Whether it's a new message in the room's timeline, as all but a reply sent only to its thread are. */
const isRoomMessage = (event: RoomEvent) => isNewMessage(event) && !event.threadOnly;

/** Records that the Workspace has applied room ?2's events up to ?1. */
const APPLIED = `UPDATE rooms SET applied_seq = ?1 WHERE id = ?2 AND applied_seq < ?1`;

/** Records that too, and that the room's latest message came at ?3, unless it has heard of a later one. */
const APPLIED_WITH_MESSAGE = `UPDATE rooms SET applied_seq = ?1, last_message_at = max(coalesce(last_message_at, ?3), ?3)
  WHERE id = ?2 AND applied_seq < ?1`;

/** Whether someone is one of the workspace's active administrators. */
export const ACTIVE_ADMINISTRATOR = `SELECT 1 FROM users WHERE id = ? AND role = ${ADMINISTRATOR} AND status = ${ACTIVE}`;

/** The active administrators, who alone hear of an AI agent only their direct messages reach. */
const ACTIVE_ADMINISTRATORS = `SELECT id AS user_id FROM users WHERE role = ${ADMINISTRATOR} AND status = ${ACTIVE}`;

/**
 * Renames the workspace and records when, unless it has that name already.
 */
const RENAME_ACCOUNT = `UPDATE accounts SET name = ?1, updated_at = ?2 WHERE name IS NOT ?1`;

/**
 * Sets the account's setting `key` to the JSON value ?1, and records when. The other settings stay, and
 * settings that aren't a JSON object start afresh.
 */
export const setSetting = (key: string) => `UPDATE accounts SET settings = json_set(
    CASE WHEN json_valid(settings) AND json_type(settings) = 'object' THEN settings ELSE '{}' END,
    '$.${key}', json(?1)
  ), updated_at = ?2`;
const SET_TAGLINE = setSetting("tagline");
const SET_HIDE_TRANSLATION_BUTTONS = setSetting("hide_translation_buttons");
const SET_RESTRICT_ROOM_CREATION = setSetting("restrict_room_creation_to_administrators");
const SET_HUDDLE_CAMERAS = setSetting("huddle_cameras");
const SET_HUDDLE_SCREENS = setSetting("huddle_screens");
const SET_CUSTOM_DOMAIN = setSetting("custom_domain");
const SET_JOIN_LINK = setSetting("join_link");
const SET_OPEN_SIGN_UP = setSetting("open_sign_up");
const SET_MEMBERFUL_JOIN = setSetting("memberful_join");
const SET_MEMBERFUL_SIGN_IN = setSetting("memberful_sign_in");
const SET_EMAIL_DOMAIN_SIGN_UP = setSetting("email_domain_sign_up");
const SET_EMAIL_DOMAINS = setSetting("email_domains");
const SET_EMAIL_FROM = setSetting("email_from");
const SET_RESEND_API_KEY = setSetting("resend_api_key");
const SET_TURNSTILE_KEYS = setSetting("turnstile_keys");
const SET_MEMBERFUL_KEYS = setSetting("memberful_keys");
const SET_HUDDLES = setSetting("huddles");
const SET_ASSISTANT = setSetting("assistant");

/**
 * Sets the account's setting `key` to the JSON value ?1, as `setSetting` does, but without recording
 * when: for what pages don't show, so that the logo's address, which goes by when the account changed,
 * stays as it is.
 */
const rememberSetting = (key: string) => `UPDATE accounts SET settings = json_set(
    CASE WHEN json_valid(settings) AND json_type(settings) = 'object' THEN settings ELSE '{}' END,
    '$.${key}', json(?1)
  )`;
const REMEMBER_DEPLOYED_ADDRESS = rememberSetting("deployed_address");
const REMEMBER_ASSISTANT = rememberSetting("assistant");
const REMEMBER_ASSISTANT_LIMITS = rememberSetting("assistant_limits");
const REMEMBER_ASSISTANT_INSTRUCTIONS = rememberSetting("assistant_instructions");
const REMEMBER_ASSISTANT_PROMPT_TEMPLATE = rememberSetting("assistant_prompt_template");
const REMEMBER_OTHER_ADDRESSES = rememberSetting("other_addresses");

/** Navigation icon changes as the merge patch `CHANGE_NAVIGATION_ICONS` takes them: null for a slot's default. */
const navigationIconsPatch = (changes: NavigationIconChanges) => Object.fromEntries(Object.entries(changes).map(([slot, icon]) => [slot, icon || null]));

/**
 * Changes the slots the JSON object ?1 names in the account's navigation icons, and records when: a slot
 * whose icon is null has its default again. As a merge patch it leaves the other slots, and the other
 * settings, as they are, and navigation icons that aren't an object start afresh.
 */
const CHANGE_NAVIGATION_ICONS = `UPDATE accounts SET settings = json_set(
    CASE WHEN json_valid(settings) AND json_type(settings) = 'object' THEN settings ELSE '{}' END,
    '$.ember_navigation_icons',
    json_patch(
      CASE WHEN json_valid(settings) AND json_type(settings, '$.ember_navigation_icons') = 'object'
        THEN json_extract(settings, '$.ember_navigation_icons') ELSE '{}' END,
      ?1
    )
  ), updated_at = ?2`;

/** Saves the workspace's custom CSS as typed and records when, unless it's that already. */
const CHANGE_CUSTOM_STYLES = `UPDATE accounts SET custom_styles = ?1, updated_at = ?2 WHERE custom_styles IS NOT ?1`;

/** Gives the join link a new code and records when. */
const CHANGE_JOIN_CODE = `UPDATE accounts SET join_code = ?, updated_at = ?`;

/**
 * The rooms someone, ?1, can star: the ones they're in and haven't hidden, but not DMs.
 */
const STARRABLE_ROOMS = `SELECT memberships.room_id FROM memberships JOIN rooms ON rooms.id = memberships.room_id
  WHERE memberships.user_id = ?1 AND memberships.involvement <> 'invisible' AND rooms.kind <> 'direct'`;

/** Whether room ?2 is one of them, found by its membership's key. */
const STARRABLE = `EXISTS (SELECT 1 FROM memberships JOIN rooms ON rooms.id = memberships.room_id
  WHERE memberships.room_id = ?2 AND memberships.user_id = ?1 AND memberships.involvement <> 'invisible' AND rooms.kind <> 'direct')`;

/** Whether ?1 has starred room ?2. */
const STARRED = `EXISTS (SELECT 1 FROM favorites WHERE user_id = ?1 AND room_id = ?2)`;

/**
 * Stars room ?2 for ?1 after their other stars, if they can star it and, counting only the rooms they
 * can star, have fewer stars than they can have. A room they've starred already keeps its place.
 */
const STAR = `INSERT INTO favorites (user_id, room_id, position)
  SELECT ?1, ?2, (SELECT coalesce(max(position) + 1, 0) FROM favorites WHERE user_id = ?1)
  WHERE ${STARRABLE} AND (SELECT count(*) FROM favorites WHERE user_id = ?1 AND room_id IN (${STARRABLE_ROOMS})) < ${MAX_FAVORITES}
  ON CONFLICT DO NOTHING`;

/** Unstars room ?2 for ?1, if they can star it. */
const UNSTAR = `DELETE FROM favorites WHERE user_id = ?1 AND room_id = ?2 AND ${STARRABLE}`;

/**
 * What follows a change to someone's stars, once `saved` says it did what was asked: dropping ?1's stars
 * on rooms they can't star now, and counting the change, answering the new version.
 */
const afterStarring = (saved: string) => ({
  drop: `DELETE FROM favorites WHERE user_id = ?1 AND room_id NOT IN (${STARRABLE_ROOMS}) AND ${saved}`,
  count: `UPDATE users SET favorites_version = favorites_version + 1 WHERE id = ?1 AND ${saved} RETURNING favorites_version AS version`,
});
/** A star stands only if it was allowed, and an unstar only needs the room to be one they can star. */
const AFTER_STAR = afterStarring(`${STARRABLE} AND ${STARRED}`);
const AFTER_UNSTAR = afterStarring(STARRABLE);

/** The rooms ?1 has starred and can star, in the order they starred them. */
const FAVORITES_FOR_USER = `SELECT room_id FROM favorites WHERE user_id = ?1 AND room_id IN (${STARRABLE_ROOMS}) ORDER BY position`;

/**
 * The version of ?'s stars, and whether they're given the welcome card: whether they're an active
 * administrator who hasn't dismissed it.
 */
const SIDEBAR_USER = `SELECT favorites_version AS version,
    role = ${ADMINISTRATOR} AND status = ${ACTIVE} AND invitation_dismissed_at IS NULL AS invited
  FROM users WHERE id = ?`;

/** Records that ?2 dismissed the welcome card at ?1, unless they had already. */
const DISMISS_INVITATION = `UPDATE users SET invitation_dismissed_at = ?1 WHERE id = ?2 AND invitation_dismissed_at IS NULL`;

/** ?1's notification level in room ?2, if they're in it. */
const INVOLVEMENT = `SELECT involvement FROM memberships WHERE user_id = ?1 AND room_id = ?2`;

/**
 * Counts a change to ?1's stars when level ?3 hides room ?2, which they've starred, or shows it again,
 * since their stars leave out the rooms they've hidden. It runs before the level changes, to compare.
 */
const COUNT_HIDDEN_STAR = `UPDATE users SET favorites_version = favorites_version + 1 WHERE id = ?1
  AND EXISTS (SELECT 1 FROM favorites WHERE user_id = ?1 AND room_id = ?2)
  AND EXISTS (SELECT 1 FROM memberships WHERE user_id = ?1 AND room_id = ?2 AND (involvement = 'invisible') <> (?3 = 'invisible'))
  RETURNING favorites_version AS version`;

/** Gives ?1 level ?3 in room ?2, if they're in it. */
const SET_INVOLVEMENT = `UPDATE memberships SET involvement = ?3 WHERE user_id = ?1 AND room_id = ?2 RETURNING involvement`;

/**
 * Whether ?2, a JSON array of distinct room ids, is exactly the rooms ?1 has starred and can star, so
 * that an order from a tab that hasn't heard of a star or unstar since can't undo it. The ids go in as
 * one value, since there can be thousands.
 */
const THEIR_STARS = `(SELECT count(*) FROM json_each(?2)) = (SELECT count(*) FROM favorites WHERE user_id = ?1 AND room_id IN (${STARRABLE_ROOMS}))
  AND NOT EXISTS (SELECT 1 FROM json_each(?2) WHERE value NOT IN (SELECT room_id FROM favorites WHERE user_id = ?1 AND room_id IN (${STARRABLE_ROOMS})))`;

/**
 * Puts ?1's stars in the order ?2 lists them, if it lists exactly their stars. Their stars on rooms they
 * can't star now, which ?2 leaves out, are dropped after it.
 */
const REORDER_STARS = `UPDATE favorites SET position = listed.key FROM json_each(?2) AS listed
  WHERE favorites.user_id = ?1 AND favorites.room_id = listed.value AND ${THEIR_STARS}`;
const AFTER_REORDER = afterStarring(THEIR_STARS);

/**
 * Whether ?1 can put ?2, a JSON array of distinct room ids, in the shared order: they're an active
 * administrator, and each room is one in their sidebar, not a DM. The ids go in as one value, since
 * there can be thousands.
 */
const MAY_ORDER_ROOMS = `SELECT EXISTS (SELECT 1 FROM users WHERE id = ?1 AND role = ${ADMINISTRATOR} AND status = ${ACTIVE})
  AND NOT EXISTS (SELECT 1 FROM json_each(?2) WHERE value NOT IN (${STARRABLE_ROOMS})) AS allowed`;

/** The shared order, each room with whether it's one ?1 could order. */
const SHARED_ORDER_FOR_ADMINISTRATOR = `SELECT id, id IN (${STARRABLE_ROOMS}) AS orderable FROM rooms
  WHERE shared_position IS NOT NULL ORDER BY shared_position`;

/** Takes the rooms ?1, a JSON array of their ids, leaves out of the shared order out of it. */
const UNRANK_ROOMS = `UPDATE rooms SET shared_position = NULL
  WHERE shared_position IS NOT NULL AND id NOT IN (SELECT value FROM json_each(?1))`;

/** Gives each room ?1, a JSON array of their ids, lists its place there in the shared order, unless it has it already. */
const RANK_ROOMS = `UPDATE rooms SET shared_position = listed.key FROM json_each(?1) AS listed
  WHERE rooms.id = listed.value AND rooms.shared_position IS NOT listed.key`;

/** The rooms ?1 is in that the shared order ranks, in its order, as their sidebar has them. */
const SHARED_ORDER_FOR_USER = `SELECT rooms.id FROM memberships JOIN rooms ON rooms.id = memberships.room_id
  WHERE memberships.user_id = ?1 AND rooms.shared_position IS NOT NULL ORDER BY rooms.shared_position`;

/**
 * The shared order once an administrator has put the rooms they could order in the order `roomIds` lists
 * them, given the order `saved` as it is: each place held by a room they could order goes to the next of
 * `roomIds` in turn, or goes once `roomIds` runs out; the rooms they couldn't order, which another
 * administrator may have placed, keep their places; and the rest of `roomIds` follow.
 */
export function mergedSharedOrder(saved: Array<{ id: RoomId; orderable: boolean }>, roomIds: RoomId[]): RoomId[] {
  const listed = roomIds.values();
  const merged = saved.flatMap(({ id, orderable }) => {
    if (!orderable) return [id];
    const next = listed.next();
    return next.done ? [] : [next.value];
  });
  return [...merged, ...listed];
}

/** Everyone active who can be put in a room, by name: all but an AI agent only administrators' direct messages reach, which is in none. */
export const ACTIVE_PEOPLE = `SELECT id, name FROM users WHERE status = ${ACTIVE} AND agent_access IS NOT 'admin-dms' ORDER BY lower(name), id`;

/**
 * What the people directory lists of whoever `users` reads, as `DirectoryRow` has it, with whether they're
 * an AI agent: a bot without a token, as @ember and the agents administrators make are and chat bots never
 * are, deleted agents too, whose answers stay, and whom an agent not everyone can ask is kept for
 * (migrations/0063_agent_access.sql).
 */
const DIRECTORY_COLUMNS = `users.id, users.name, users.bio, users.role, users.status, users.updated_at,
  (users.role = ${BOT} AND users.bot_token IS NULL) AS agent, users.agent_access`;

/** Everyone ?1 is told of, for the people directory: removed and banned people too, whose messages stay (`listedTo`). */
const DIRECTORY = `SELECT ${DIRECTORY_COLUMNS} FROM users WHERE ${listedTo("?1")} ORDER BY id`;

/** Someone active, as the directory lists them. */
const ACTIVE_PERSON = `SELECT ${DIRECTORY_COLUMNS} FROM users WHERE id = ? AND status = ${ACTIVE}`;

/** The same, or someone suspended for their membership's lapsing, as an administrator can remove them too. */
const REMOVABLE_PERSON = `SELECT ${DIRECTORY_COLUMNS} FROM users WHERE id = ? AND status IN (${ACTIVE}, ${SUSPENDED})`;

/** Whether the user `users` reads is no agent's: the AI assistant tab looks after agents, as it does @ember, not Chat bots. */
const NOT_AN_AGENT = `NOT EXISTS (SELECT 1 FROM agents WHERE agents.user_id = users.id)`;

/**
 * The active bots, by name, with their tokens. @ember and the agents aren't among them: the AI assistant
 * tab looks after them, not Chat bots.
 */
const ACTIVE_BOTS = `SELECT ${DIRECTORY_COLUMNS}, bot_token FROM users
  WHERE status = ${ACTIVE} AND role = ${BOT} AND id <> '${ASSISTANT_ID}' AND ${NOT_AN_AGENT} ORDER BY lower(name), id`;

/**
 * The rooms the active bots are in but their DMs, by name, as the bots page lists each bot's.
 */
const ACTIVE_BOTS_ROOMS = `SELECT memberships.user_id, rooms.id, rooms.name
  FROM users JOIN memberships ON memberships.user_id = users.id JOIN rooms ON rooms.id = memberships.room_id
  WHERE users.status = ${ACTIVE} AND users.role = ${BOT} AND users.id <> '${ASSISTANT_ID}' AND ${NOT_AN_AGENT} AND rooms.kind <> 'direct'
  ORDER BY lower(rooms.name), rooms.id`;

/**
 * An active bot, with its token and where its webhook delivers. @ember and the agents aren't, as above.
 */
const ACTIVE_BOT = `SELECT ${DIRECTORY_COLUMNS}, users.bot_token, webhooks.url AS webhook_url
  FROM users LEFT JOIN webhooks ON webhooks.user_id = users.id
  WHERE users.id = ? AND users.status = ${ACTIVE} AND users.role = ${BOT} AND users.id <> '${ASSISTANT_ID}' AND ${NOT_AN_AGENT}`;

/**
 * Active bot ?2's token, with whether it's in room ?1, and its webhook's URL and when that was saved, if
 * it has one.
 */
const ACTIVE_BOT_KEY = `SELECT users.id, users.name, users.bot_token, webhooks.url AS webhook_url, webhooks.updated_at AS webhook_saved_at,
    EXISTS (SELECT 1 FROM memberships WHERE memberships.room_id = ?1 AND memberships.user_id = users.id) AS member
  FROM users LEFT JOIN webhooks ON webhooks.user_id = users.id
  WHERE users.id = ?2 AND users.status = ${ACTIVE} AND users.role = ${BOT}`;

/** The rooms a bot is in but its DMs, by name. */
const BOT_ROOMS = `SELECT rooms.id, rooms.name FROM memberships JOIN rooms ON rooms.id = memberships.room_id
  WHERE memberships.user_id = ? AND rooms.kind <> 'direct' ORDER BY lower(rooms.name), rooms.id`;

/** What the AI assistant tab lists of an agent, of its user and its row. */
const AGENT_COLUMNS = `${DIRECTORY_COLUMNS},
  agents.description, agents.model, agents.model_name, agents.web_tools, agents.every_open_room`;

/** The active agents, by name, as the AI assistant tab lists them. */
const ACTIVE_AGENTS = `SELECT ${AGENT_COLUMNS} FROM agents JOIN users ON users.id = agents.user_id
  WHERE users.status = ${ACTIVE} ORDER BY lower(users.name), users.id`;

/** The open rooms each active agent kept to the open rooms picked is in, by name. */
const KEPT_AGENTS_ROOMS = `SELECT memberships.user_id, rooms.id, rooms.name
  FROM agents JOIN users ON users.id = agents.user_id JOIN memberships ON memberships.user_id = agents.user_id JOIN rooms ON rooms.id = memberships.room_id
  WHERE agents.every_open_room = 0 AND users.status = ${ACTIVE} AND rooms.kind = 'open' ORDER BY lower(rooms.name), rooms.id`;

/** The active agents ?1 can ask (`askedBy`), by name, as Available Agents lists them: as the people directory does, with what each does. */
const AVAILABLE_AGENTS = `SELECT ${DIRECTORY_COLUMNS}, agents.description, agents.every_open_room FROM agents JOIN users ON users.id = agents.user_id
  WHERE users.status = ${ACTIVE} AND ${askedBy("?1")} ORDER BY lower(users.name), users.id`;

/**
 * The rooms but DMs each active agent kept to the open rooms picked shares with ?1, by name: the open
 * rooms it's in, which everyone is in, and the private rooms it was put in that they're in too.
 */
const AVAILABLE_AGENTS_ROOMS = `SELECT theirs.user_id, rooms.id, rooms.name
  FROM agents JOIN users ON users.id = agents.user_id JOIN memberships AS theirs ON theirs.user_id = agents.user_id JOIN rooms ON rooms.id = theirs.room_id
  WHERE agents.every_open_room = 0 AND users.status = ${ACTIVE} AND rooms.kind <> 'direct'
    AND EXISTS (SELECT 1 FROM memberships AS mine WHERE mine.room_id = theirs.room_id AND mine.user_id = ?1)
  ORDER BY lower(rooms.name), rooms.id`;

/** An active agent as its page shows it, with its avatar and who last changed it. */
const ACTIVE_AGENT = `SELECT ${AGENT_COLUMNS}, users.avatar_key, users.avatar_variant,
    agents.instructions, agents.prompt_template, agents.format, agents.thinking_levels, agents.thinking, agents.answer_length,
    agents.updated_by AS changed_by, changers.name AS changed_by_name, agents.updated_at AS changed_at
  FROM agents JOIN users ON users.id = agents.user_id JOIN users AS changers ON changers.id = agents.updated_by
  WHERE agents.user_id = ? AND users.status = ${ACTIVE}`;

/**
 * Agent ?2 as a question ?3 asked it in room ?1 finds it, when its turn comes and again before its answer
 * is posted: its name, its model, and how it answers. Nothing unless it's an active agent in the room
 * that answers them there (`answersTo`), so that turning Ember AI off, deleting the agent, taking it out
 * of the room, keeping it for administrators or making whoever asked a member stops what's on its way.
 */
export const ANSWERING_AGENT = `SELECT users.name, agents.model, agents.instructions, agents.prompt_template, agents.format, agents.thinking_levels, agents.thinking,
    agents.answer_length, agents.web_tools
  FROM agents JOIN users ON users.id = agents.user_id
  WHERE agents.user_id = ?2 AND users.status = ${ACTIVE} AND EXISTS (SELECT 1 FROM memberships WHERE memberships.room_id = ?1 AND memberships.user_id = ?2)
    AND ${answersTo("?3", "?1")}`;

/** The open rooms someone is in, by name. */
const OPEN_ROOMS_OF = `SELECT rooms.id, rooms.name FROM memberships JOIN rooms ON rooms.id = memberships.room_id
  WHERE memberships.user_id = ? AND rooms.kind = 'open' ORDER BY lower(rooms.name), rooms.id`;

/** Every agent, active or not, as the directory lists it. */
const AGENTS_LISTED = `SELECT ${DIRECTORY_COLUMNS} FROM agents JOIN users ON users.id = agents.user_id`;

/** An agent, active or not, as its page shows it to everyone, with who made it. */
const AGENT_PROFILE = `SELECT agents.description, agents.model, agents.model_name, agents.created_by, makers.name AS created_by_name
  FROM agents JOIN users AS makers ON makers.id = agents.created_by WHERE agents.user_id = ?`;

/** What makes a bot an agent, ?12 being 1 to put it in every open room, made by ?13. */
const INSERT_AGENT = `INSERT INTO agents (user_id, description, instructions, model, model_name, format, thinking, answer_length, web_tools,
    prompt_template, thinking_levels, every_open_room, created_by, updated_by, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14, ?14)`;

/** Has the agents that ask a model in a format ask it in another, with the levels of thinking it takes there, without recording a change to them. */
const MOVE_AGENTS_MODEL = `UPDATE agents SET format = ?, thinking_levels = ? WHERE model = ? AND format = ?`;

/** Changes an agent's setup, and records who changed it, and when. */
const CHANGE_AGENT = `UPDATE agents SET description = ?2, instructions = ?3, model = ?4, model_name = ?5, format = ?6, thinking = ?7, answer_length = ?8,
  web_tools = ?9, prompt_template = ?10, thinking_levels = ?11, updated_by = ?12, updated_at = ?13 WHERE user_id = ?1`;

/** Keeps whom agent ?2 is for on its user: 'admins', 'admin-dms', or null for everyone. */
const KEEP_AGENT_FOR = `UPDATE users SET agent_access = ?1 WHERE id = ?2`;

/** Puts ?1 in the open rooms the JSON list ?2 names, of those there are, keeping the memberships it has. */
const GRANT_PICKED_ROOMS = `INSERT INTO memberships (room_id, user_id, created_at, updated_at)
  SELECT rooms.id, ?1, ?3, ?3 FROM json_each(?2) AS picked JOIN rooms ON rooms.id = picked.value WHERE rooms.kind = 'open' ON CONFLICT DO NOTHING`;

/** Takes ?1 out of the open rooms the JSON list ?2 doesn't name. */
const LEAVE_UNPICKED_ROOMS = `DELETE FROM memberships WHERE user_id = ?1 AND room_id NOT IN (SELECT value FROM json_each(?2))
  AND EXISTS (SELECT 1 FROM rooms WHERE rooms.id = memberships.room_id AND rooms.kind = 'open')`;

/**
 * Keeps the open rooms each active agent kept to the open rooms picked is in, as Ember AI is turned off,
 * so that turning it on again puts it back in them.
 */
const KEEP_AGENTS_ROOMS = `UPDATE agents SET kept_rooms = (SELECT json_group_array(memberships.room_id) FROM memberships JOIN rooms ON rooms.id = memberships.room_id
    WHERE memberships.user_id = agents.user_id AND rooms.kind = 'open')
  WHERE every_open_room = 0 AND EXISTS (SELECT 1 FROM users WHERE users.id = agents.user_id AND users.status = ${ACTIVE})`;

/** Takes every agent out of every room but its DMs, as `LEAVE_SHARED_ROOMS` takes someone. */
const AGENTS_LEAVE_SHARED_ROOMS = `DELETE FROM memberships WHERE user_id IN (SELECT user_id FROM agents)
  AND EXISTS (SELECT 1 FROM rooms WHERE rooms.id = memberships.room_id AND rooms.kind <> 'direct')`;

/** Deactivates every active agent, recording when. */
const DEACTIVATE_AGENTS = `UPDATE users SET status = ${DEACTIVATED}, updated_at = ? WHERE status = ${ACTIVE} AND id IN (SELECT user_id FROM agents)`;

/** Lets every agent back, as turning Ember AI on does, recording when. */
const ACTIVATE_AGENTS = `UPDATE users SET status = ${ACTIVE}, updated_at = ? WHERE status = ${DEACTIVATED} AND id IN (SELECT user_id FROM agents)`;

/** Puts each agent kept to the open rooms picked back in the ones it was in when Ember AI was turned off, of those still open. */
const RESTORE_AGENTS_ROOMS = `INSERT INTO memberships (room_id, user_id, created_at, updated_at)
  SELECT rooms.id, agents.user_id, ?1, ?1 FROM agents, json_each(agents.kept_rooms) AS kept JOIN rooms ON rooms.id = kept.value
  WHERE agents.every_open_room = 0 AND rooms.kind = 'open' ON CONFLICT DO NOTHING`;

/** Puts each agent that's in every open room in all of them, keeping the memberships it has. */
const GRANT_OPEN_ROOMS_TO_AGENTS = `INSERT INTO memberships (room_id, user_id, created_at, updated_at)
  SELECT rooms.id, agents.user_id, ?1, ?1 FROM agents, rooms WHERE agents.every_open_room = 1 AND rooms.kind = 'open' ON CONFLICT DO NOTHING`;

/**
 * Adds @ember, the bot Ember AI answers as, without a token, so its key opens nothing, or lets it back,
 * as it was, once it was turned off, so that its answers stay its own.
 */
const ACTIVATE_ASSISTANT = `INSERT INTO users (id, name, role, created_at, updated_at) VALUES (?1, ?2, ${BOT}, ?3, ?3)
  ON CONFLICT (id) DO UPDATE SET status = ${ACTIVE}, updated_at = excluded.updated_at WHERE status <> ${ACTIVE}`;

/** Adds a bot, with its avatar. */
const INSERT_BOT = `INSERT INTO users (id, name, role, bot_token, avatar_key, avatar_variant, created_at, updated_at) VALUES (?, ?, ${BOT}, ?, ?, ?, ?, ?)`;

/**
 * Has a bot's webhook deliver to ?2, adding one if it has none, and records when, unless it delivers
 * there already.
 */
const SAVE_WEBHOOK = `INSERT INTO webhooks (user_id, url, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
  ON CONFLICT (user_id) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at WHERE url <> excluded.url`;

/** Renames a bot and records when, unless that's its name already. */
const RENAME_BOT = `UPDATE users SET name = ?1, updated_at = ?2 WHERE id = ?3 AND name <> ?1`;

/** Gives a bot a new token, and records when. */
const CHANGE_BOT_TOKEN = `UPDATE users SET bot_token = ?, updated_at = ? WHERE id = ?`;

/**
 * Records a search, by its key (@ember/protocol `searchKey`), as someone's newest: a search they have
 * already moves to the front, rather than being added again.
 */
const RECORD_SEARCH = `INSERT INTO recent_searches (user_id, search, position)
  VALUES (?1, ?2, (SELECT coalesce(max(position), 0) + 1 FROM recent_searches WHERE user_id = ?1))
  ON CONFLICT (user_id, search) DO UPDATE SET position = excluded.position`;

/**
 * Forgets someone's searches past their newest ?2 + 1, as Campfire's `trim_recent_searches` does, which
 * it runs as it adds one. With no more than that, the subquery finds none to keep the rest newer than,
 * and nothing goes.
 */
const TRIM_SEARCHES = `DELETE FROM recent_searches WHERE user_id = ?1
  AND position < (SELECT position FROM recent_searches WHERE user_id = ?1 ORDER BY position DESC LIMIT 1 OFFSET ?2)`;

/** Someone's recent searches, newest first, by their keys. */
const RECENT_SEARCHES_FOR_USER = `SELECT search FROM recent_searches WHERE user_id = ? ORDER BY position DESC LIMIT ?`;

/** Forgets someone's recent searches, and those from before searches had filters (migrations/0048_recent_searches.sql). */
const forgettingSearches = (userId: UserId): Statement[] => [
  statement(`DELETE FROM recent_searches WHERE user_id = ?`, userId),
  statement(`DELETE FROM searches WHERE user_id = ?`, userId),
];

/** A recent search from its key, or null for one that isn't a search. */
function recentSearchOf(key: string): Search | null {
  try {
    const search = parseSearch(JSON.parse(key));
    return typeof search === "string" ? null : search.search;
  } catch {
    return null;
  }
}

/**
 * Saves a browser's push subscription for someone, with its user agent, or, when they've saved one at
 * the same endpoint before, records that it was saved again, with the keys and user agent it has now. It
 * saves nothing once their session ?7, which was checked first, has ended, answering a row only if it
 * saves: on D1 a password reset can end the session in between, and a subscription saved after would
 * outlive it.
 */
const SAVE_PUSH_SUBSCRIPTION = `INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key, user_agent, created_at, updated_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6 WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?7 AND user_id = ?1)
  ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh_key = excluded.p256dh_key, auth_key = excluded.auth_key,
    user_agent = excluded.user_agent, updated_at = excluded.updated_at
  RETURNING id`;

/**
 * Forgets someone's, ?1's, push subscription with the P-256 key ?2, but the one at ?3 they're saving, as
 * they save it in session ?4, if it hasn't ended: the one the same browser had at the address its page
 * moved from to Ember's custom domain, which would have every push come twice. A key is one browser's,
 * where a user agent can be every Mac's on the same Chrome, so no other browser's goes.
 */
const FORGET_REPLACED_PUSH_SUBSCRIPTION = `DELETE FROM push_subscriptions WHERE user_id = ?1 AND p256dh_key = ?2 AND endpoint <> ?3
  AND EXISTS (SELECT 1 FROM sessions WHERE id = ?4 AND user_id = ?1)`;

/**
 * Forgets someone's push subscriptions past the ?2 they saved most recently, so that saving many can't
 * have a message that notifies them pushed as many times.
 */
const TRIM_PUSH_SUBSCRIPTIONS = `DELETE FROM push_subscriptions WHERE user_id = ?1
  AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id = ?1 ORDER BY updated_at DESC, id DESC LIMIT ?2)`;

/**
 * Forgets the subscriptions with endpoint ?2 of whoever's session has the token digest ?1, as signing out
 * does in Campfire (`destroy_by`), before the session ends.
 */
const FORGET_SESSION_PUSH_ENDPOINT = `DELETE FROM push_subscriptions
  WHERE user_id = (SELECT user_id FROM sessions WHERE token_digest = ?1) AND endpoint = ?2`;

/** Gives someone a role and records when. */
const CHANGE_ROLE = `UPDATE users SET role = ?, updated_at = ? WHERE id = ?`;

/**
 * Takes someone out of every room but their DMs, which they stay in. It looks up each of their rooms,
 * where `room_id IN (SELECT ...)` would read them all.
 */
const LEAVE_SHARED_ROOMS = `DELETE FROM memberships WHERE user_id = ?
  AND EXISTS (SELECT 1 FROM rooms WHERE rooms.id = memberships.room_id AND rooms.kind <> 'direct')`;

/**
 * Marks someone removed and records when, writing the first value before each "@" of their email
 * address, which frees it. No email address stays none.
 */
const DEACTIVATE = `UPDATE users SET status = ${DEACTIVATED}, email_address = replace(email_address, '@', ?), updated_at = ? WHERE id = ?`;

/** Someone as the directory lists them, whatever their status. */
const PERSON = `SELECT ${DIRECTORY_COLUMNS} FROM users WHERE id = ?`;

/** The same, with the avatar they've uploaded, or a bot was given. */
const PERSON_WITH_AVATAR = `SELECT ${DIRECTORY_COLUMNS}, avatar_key, avatar_variant FROM users WHERE id = ?`;

/**
 * The IP addresses recorded on someone's sessions, each once, without none or blanks.
 */
const SESSION_IP_ADDRESSES = `SELECT DISTINCT ip_address FROM sessions WHERE user_id = ? AND trim(ip_address) <> ''`;

/** Someone as the directory lists them, with their email address, whatever their status. */
const PERSON_WITH_PROFILE = `SELECT ${DIRECTORY_COLUMNS}, email_address FROM users WHERE id = ?`;

/** The same, with the avatar they've uploaded, and whether they have a password, which people without one keep as none or blank. */
const OWN_PROFILE = `SELECT ${DIRECTORY_COLUMNS}, email_address, avatar_key, avatar_variant,
    coalesce(password_digest, '') <> '' AS password, NOT ${NEEDS_NO_MEMBERSHIP} AS membership_needed,
    (SELECT json_group_array(json_object('issuer', issuer, 'subject', subject, 'name', identities.name, 'emailAddress', identities.email_address))
      FROM identities WHERE identities.user_id = users.id) AS accounts,
    assistant_thinking, assistant_answer_length, assistant_model
  FROM users WHERE id = ?`;

/** How much someone picked for @ember to think, how long its answers to them are, and the model it answers them with. */
const ASSISTANT_PICKS = `SELECT assistant_thinking, assistant_answer_length, assistant_model FROM users WHERE id = ?`;

/**
 * Changes the dials someone picks a level of, ?1 and ?2, a null one staying as it is, and when ?3 is 1,
 * the model they pick, to ?4, or to none with null.
 */
const CHANGE_ASSISTANT_PICKS = `UPDATE users SET assistant_thinking = coalesce(?1, assistant_thinking), assistant_answer_length = coalesce(?2, assistant_answer_length),
    assistant_model = CASE WHEN ?3 = 1 THEN ?4 ELSE assistant_model END
  WHERE id = ?5`;

/** What a row's `assistant_thinking`, `assistant_answer_length` and `assistant_model` say someone picked. */
const assistantPicksOf = (row: PickColumns): AssistantPicks => ({
  thinking: levelIn(THINKING_LEVELS, row.assistant_thinking),
  length: levelIn(ANSWER_LENGTHS, row.assistant_answer_length),
  model: row.assistant_model,
});

interface PickColumns {
  assistant_thinking: string | null;
  assistant_answer_length: string | null;
  assistant_model: string | null;
}

/** Gives someone an avatar, or none, recording when, which changes its address. */
const CHANGE_AVATAR = `UPDATE users SET avatar_key = ?, avatar_variant = ?, updated_at = ? WHERE id = ?`;

/** Gives the workspace a logo, or none, and records when. */
const CHANGE_LOGO = `UPDATE accounts SET logo_key = ?, logo_variant = ?, updated_at = ?`;

/** Reserves a picture's key, or queues R2 deleting what it keeps there, at a time. */
const QUEUE_PICTURE_DELETION = `INSERT INTO pending_picture_deletions (object_key, due_at) VALUES (?, ?)`;

/** Takes a picture's reservation, now that someone has it, so R2 keeps it. */
const KEEP_PICTURE = `DELETE FROM pending_picture_deletions WHERE object_key = ?`;

/** Saves someone's profile and records when, keeping their password unless given a new one's digest. */
const CHANGE_PROFILE = `UPDATE users SET name = ?, email_address = ?, bio = ?, password_digest = coalesce(?, password_digest), updated_at = ?
  WHERE id = ?`;

/** The same, with whether each is in a room, for its settings. */
export const ACTIVE_PEOPLE_IN_ROOM = `SELECT users.id, users.name, memberships.user_id IS NOT NULL AS member
  FROM users LEFT JOIN memberships ON memberships.room_id = ? AND memberships.user_id = users.id
  WHERE users.status = ${ACTIVE} AND users.agent_access IS NOT 'admin-dms' ORDER BY lower(users.name), users.id`;

/** The people with the ids in a JSON array, whatever their status. */
export const PEOPLE_WITH_IDS = `SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))`;

/**
 * The people a JSON array ?1 names whom ?2 can start a DM with, whatever their status: anyone, but an AI
 * agent kept for administrators, which only an administrator writes to, and one only their direct
 * messages reach only while everyone else named is an administrator, so that nobody else is shown it:
 * no member, and no bot, another agent included, as whoever has a bot's key reads the rooms it's in.
 */
export const DIRECT_PEOPLE = `SELECT users.id, users.name FROM users
  WHERE users.id IN (SELECT value FROM json_each(?1))
    AND (users.agent_access IS NULL OR (${administratorIs("?2")}
      AND (users.agent_access <> 'admin-dms' OR NOT EXISTS (SELECT 1 FROM users AS others
        WHERE others.id IN (SELECT value FROM json_each(?1)) AND others.id <> users.id AND others.role <> ${ADMINISTRATOR}))))`;

/** The same, as the people directory lists them. */
const DIRECTORY_WITH_IDS = `SELECT ${DIRECTORY_COLUMNS} FROM users WHERE id IN (SELECT value FROM json_each(?))`;

/** How many people the mentions prompt offers: the first page of them, the only one Lexxy asks for. */
export const MENTIONABLE_PAGE = 20;

/**
 * Active people whose names contain ?1, by name, whom ?2 can ask (`askedBy`). It's `LIKE`, so only ASCII
 * letters ignore case, `%` and `_` match anything, and "" matches everyone.
 */
const MENTIONABLE_PEOPLE = `SELECT ${DIRECTORY_COLUMNS} FROM users
  WHERE status = ${ACTIVE} AND name LIKE '%' || ?1 || '%' AND ${askedBy("?2")} ORDER BY lower(name), id LIMIT ${MENTIONABLE_PAGE}`;

/** The same of room ?2's members (`Current.user.rooms.find(room_id).users`), for ?3. */
const MENTIONABLE_MEMBERS = `SELECT ${DIRECTORY_COLUMNS}
  FROM memberships JOIN users ON users.id = memberships.user_id
  WHERE memberships.room_id = ?2 AND users.status = ${ACTIVE} AND users.name LIKE '%' || ?1 || '%' AND ${askedBy("?3")}
  ORDER BY lower(users.name), users.id LIMIT ${MENTIONABLE_PAGE}`;

/** Whether someone in a room can change it: administrators and the room's creator can. */
const CAN_ADMINISTER = `(users.role = ${ADMINISTRATOR} OR rooms.creator_id = users.id) AS can_administer`;

/** A room someone is in, unless it's a DM, and whether they can change it. */
export const ROOM_TO_CHANGE = `SELECT rooms.id, rooms.kind, rooms.name, rooms.icon, ${CAN_ADMINISTER}
  FROM memberships JOIN rooms ON rooms.id = memberships.room_id JOIN users ON users.id = memberships.user_id
  WHERE memberships.room_id = ? AND memberships.user_id = ? AND rooms.kind <> 'direct'`;

/**
 * Whether anyone but ?2 who could open room ?1 is in it: no bot can, nor can someone banned, whose
 * membership stays, and someone suspended can again once their membership is renewed.
 */
const ANOTHER_PERSON_IN_ROOM = `SELECT EXISTS (SELECT 1 FROM memberships JOIN users ON users.id = memberships.user_id
  WHERE memberships.room_id = ?1 AND memberships.user_id <> ?2 AND users.role <> ${BOT} AND users.status IN (${ACTIVE}, ${SUSPENDED})) AS found`;

/** A room someone is in, DMs included, by its kind, and whether they can change it. */
const ROOM_TO_DELETE = `SELECT rooms.kind, ${CAN_ADMINISTER}
  FROM memberships JOIN rooms ON rooms.id = memberships.room_id JOIN users ON users.id = memberships.user_id
  WHERE memberships.room_id = ? AND memberships.user_id = ?`;

// Memberships are granted with one statement for everyone, rather than a row at a time, since both
// backends bind at most 100 values a statement. A WHERE clause comes before each ON CONFLICT, which
// SQLite would otherwise read as part of a join.

/** Puts someone new in every open room. */
const GRANT_OPEN_ROOMS_TO_USER = `INSERT INTO memberships (room_id, user_id, created_at, updated_at)
  SELECT id, ?, ?, ? FROM rooms WHERE kind = 'open' ON CONFLICT DO NOTHING`;

/**
 * Puts every active person in an open room, keeping the memberships they already have, and answers whom
 * it put in. Agents kept to the open rooms an administrator picked stay out, as do those only
 * administrators' direct messages reach.
 */
const GRANT_ROOM_TO_ACTIVE_USERS = `INSERT INTO memberships (room_id, user_id, created_at, updated_at)
  SELECT ?, id, ?, ? FROM users WHERE status = ${ACTIVE} AND agent_access IS NOT 'admin-dms'
    AND NOT EXISTS (SELECT 1 FROM agents WHERE agents.user_id = users.id AND agents.every_open_room = 0)
  ON CONFLICT DO NOTHING RETURNING user_id`;

/**
 * Adds one of first run's open rooms, made by ?3, unless the workspace has an open room of its name
 * already, as the old preview has its general and random from before the Workspace kept a list.
 */
const INSERT_FIRST_ROOM = `INSERT INTO rooms (id, kind, name, creator_id, created_at, updated_at)
  SELECT ?1, 'open', ?2, ?3, ?4, ?4 WHERE NOT EXISTS (SELECT 1 FROM rooms WHERE kind = 'open' AND name = ?2)`;

/** Puts every active person in one of first run's rooms, if it was added: one it found has them already, being open. */
const GRANT_FIRST_ROOM = `INSERT INTO memberships (room_id, user_id, created_at, updated_at)
  SELECT rooms.id, users.id, ?, ? FROM rooms, users WHERE rooms.id = ? AND users.status = ${ACTIVE} ON CONFLICT DO NOTHING`;

/** The oldest open room with a name, which first run opens: the one it added, or the one it found. */
const OPEN_ROOM_NAMED = `SELECT id, kind, name, icon FROM rooms WHERE kind = 'open' AND name = ? ORDER BY created_at, id LIMIT 1`;

/**
 * Puts the people a JSON list names in a room, whatever their status, and answers whom it put in: none
 * of them an AI agent only administrators' direct messages reach, which is in no room.
 */
const GRANT_ROOM_TO_USERS = `INSERT INTO memberships (room_id, user_id, created_at, updated_at)
  SELECT ?, id, ?, ? FROM users WHERE id IN (SELECT value FROM json_each(?)) AND agent_access IS NOT 'admin-dms'
  ON CONFLICT DO NOTHING RETURNING user_id`;

/** Takes everyone but the people a JSON list names and anyone suspended whose membership it keeps (`KEPT_SUSPENDED_MEMBERSHIP`) out of a room, and answers whom. */
export const REVOKE_ROOM_FROM_OTHERS = `DELETE FROM memberships WHERE room_id = ? AND user_id NOT IN (SELECT value FROM json_each(?)) AND NOT ${KEPT_SUSPENDED_MEMBERSHIP}
  RETURNING user_id`;

/** Who's in a room, which the memberships' key finds. */
export const ROOM_MEMBERS = `SELECT user_id FROM memberships WHERE room_id = ?`;

/** Whether the shared order ranks a room. */
const ROOM_RANKED = `SELECT shared_position IS NOT NULL AS ranked FROM rooms WHERE id = ?`;

/**
 * Renames a room, changes its kind and sets its icon, keeping whichever is null as it is, and records
 * when, unless nothing changes. An icon of "" is the default `#`, stored as null.
 */
const UPDATE_ROOM = `UPDATE rooms SET name = coalesce(?1, name), kind = coalesce(?2, kind),
    icon = CASE WHEN ?3 IS NULL THEN icon ELSE nullif(?3, '') END, updated_at = ?4
  WHERE id = ?5 AND (name IS NOT coalesce(?1, name) OR kind IS NOT coalesce(?2, kind)
    OR icon IS NOT CASE WHEN ?3 IS NULL THEN icon ELSE nullif(?3, '') END) RETURNING id`;

/** Of the rooms a JSON list names, those that are neither registered nor deleted. */
const UNREGISTERED_ROOMS = `SELECT DISTINCT value AS id FROM json_each(?)
  WHERE value NOT IN (SELECT id FROM rooms) AND value NOT IN (SELECT id FROM deleted_rooms)`;

/** Keeps the people a JSON list of `{id, name}` names as deactivated guests, unless they're already here. */
const INSERT_FORMER_GUESTS = `INSERT INTO users (id, name, status, guest, created_at, updated_at)
  SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), ${DEACTIVATED}, 1, ?, ? FROM json_each(?) WHERE true
  ON CONFLICT DO NOTHING`;

/** A tool read from a connected app, as the apps table keeps it: as its page shows it, with the JSON Schema of what it takes and a fingerprint of those. */
export interface StoredAppTool {
  name: string;
  title: string | null;
  description: string;
  takes: Record<string, unknown>;
  fingerprint: string;
}

/** What reading an app's server found, as the apps table keeps it. */
export interface StoredAppRead {
  serverName: string | null;
  tools: StoredAppTool[];
  toolsLeftOut: number;
}

/**
 * A connected app as the apps table keeps it: its token sealed, or null without one, what was read
 * from its server, who connected it, if they're still known, and, for one an administrator signed in
 * to, who and when, with the sign-in sealed, or null once it has ended, the client Ember signed
 * in as, when an administrator gave one: its ID, and what the service knows it by, sealed, and the
 * scopes its server has asked for since that the sign-in doesn't allow.
 */
export interface StoredApp extends StoredAppRead {
  id: AppId;
  name: string;
  url: string;
  sealedToken: string | null;
  toolsReadAt: string;
  connectedBy: { id: UserId; name: string } | null;
  sealedSignIn: string | null;
  signedIn: { by: { id: UserId; name: string } | null; at: string } | null;
  signInClient: SignInClient | null;
  scopeWanted: string | null;
}

/** The client an administrator gave for Ember to sign in to an app as: its ID, and what the service knows it by, sealed for the app. */
export interface SignInClient {
  id: string;
  sealed: string;
}

/** A sign-in to keep for an app: sealed for it, who signed in, and the client an administrator gave for it, if they gave one. */
export interface NewAppSignIn {
  sealed: string;
  by: UserId;
  client: SignInClient | null;
}

/**
 * A sign-in under way, from when an administrator, `userId`, is sent to an app's authorization server
 * until their browser comes back with `state`: for the connected app `appId`, or, with null, for one
 * to connect by `name` at `url`, with what the sign-in needs to finish, sealed. One that's `own` is
 * anyone's, to a connected app, for themselves.
 */
export interface PendingAppSignIn {
  state: string;
  userId: UserId;
  appId: AppId | null;
  name: string;
  url: string;
  sealedSignIn: string;
  own: boolean;
}

/** A connected app Ember signs in to, with the sign-in someone has made to it themselves, if they have: when, sealed, or null once it has ended, and what its server has asked for beyond it. */
export interface OwnAppSignIn {
  appId: AppId;
  appName: string;
  url: string;
  signedIn: { at: string; sealed: string | null; scopeWanted: string | null } | null;
}

/** An app to connect, by `connectedBy`. */
export interface NewStoredApp extends StoredAppRead {
  id: AppId;
  name: string;
  url: string;
  sealedToken: string | null;
  /** The sign-in it's connected with, if it's connected by one: sealed, with the client an administrator gave for it, if they gave one. */
  signIn?: Omit<NewAppSignIn, "by">;
  connectedBy: UserId;
  now: string;
}

/** A change to a connected app by `changedBy`: what's left out stays as it is, and `read` is what its server answered when it was read again. */
export interface AppChange {
  name?: string;
  url?: string;
  sealedToken?: string | null;
  read?: StoredAppRead;
  /** The agents' picks that what was read changes (`ChangedPicks`). */
  picks?: ChangedPicks[];
  changedBy: UserId;
  now: string;
}

/**
 * A connected app's tool as it was picked for an agent: its app, its name there, and its fingerprint
 * then. One set aside was found described another way when picks were saved, and stays set aside, the
 * agent without it, however its server describes it later, until it's picked again. One always allowed
 * is called without asking first, which one set aside never is.
 */
export interface StoredToolPick {
  appId: AppId;
  name: string;
  fingerprint: string;
  setAside?: true;
  alwaysAllowed?: true;
}

/** The tools picked for one agent, with what it's called, @ember's name before it has answered, as it has no user till then, and the picks as they're `stored`. */
export interface AgentToolPicks {
  agent: { id: UserId; name: string };
  picks: StoredToolPick[];
  stored: string;
}

/** An agent's picks as reading an app's tools leaves them, `picks`, kept only while they're still `stored` as they were when that was worked out. */
export interface ChangedPicks {
  agentId: UserId;
  stored: string;
  picks: StoredToolPick[];
}

interface AppRow {
  id: AppId;
  name: string;
  url: string;
  token: string | null;
  server_name: string | null;
  tools: string;
  tools_left_out: number;
  tools_read_at: string;
  connected_by_id: UserId | null;
  connected_by_name: string | null;
  sign_in: string | null;
  signed_in_at: string | null;
  signed_in_by_id: UserId | null;
  signed_in_by_name: string | null;
  sign_in_client_id: string | null;
  sign_in_client: string | null;
  scope_wanted: string | null;
}

const APPS = `SELECT apps.id, apps.name, apps.url, apps.token, apps.server_name, apps.tools, apps.tools_left_out, apps.tools_read_at,
  users.id AS connected_by_id, users.name AS connected_by_name,
  apps.sign_in, apps.signed_in_at, signers.id AS signed_in_by_id, signers.name AS signed_in_by_name, apps.sign_in_client_id, apps.sign_in_client, apps.scope_wanted
  FROM apps LEFT JOIN users ON users.id = apps.created_by LEFT JOIN users AS signers ON signers.id = apps.signed_in_by`;

const APP = `${APPS} WHERE apps.id = ?`;

/** Each connected app Ember signs in to, with the sign-in the person bound first has made to it themselves, if they have. */
const OWN_APP_SIGN_INS = `SELECT apps.id, apps.name, apps.url, own.signed_in_at, own.sign_in, own.scope_wanted
  FROM apps LEFT JOIN own_app_sign_ins AS own ON own.app_id = apps.id AND own.user_id = ?
  WHERE apps.signed_in_at IS NOT NULL`;

interface OwnAppSignInRow {
  id: AppId;
  name: string;
  url: string;
  signed_in_at: string | null;
  sign_in: string | null;
  scope_wanted: string | null;
}

const ownAppSignIn = (row: OwnAppSignInRow): OwnAppSignIn => ({
  appId: row.id,
  appName: row.name,
  url: row.url,
  signedIn: row.signed_in_at === null ? null : { at: row.signed_in_at, sealed: row.sign_in, scopeWanted: row.scope_wanted },
});

/** A connected app as `APP` reads it. */
const storedApp = (row: AppRow): StoredApp => ({
  id: row.id,
  name: row.name,
  url: row.url,
  sealedToken: row.token,
  serverName: row.server_name,
  tools: JSON.parse(row.tools) as StoredAppTool[],
  toolsLeftOut: row.tools_left_out,
  toolsReadAt: row.tools_read_at,
  connectedBy: row.connected_by_id !== null && row.connected_by_name !== null ? { id: row.connected_by_id, name: row.connected_by_name } : null,
  sealedSignIn: row.sign_in,
  signedIn:
    row.signed_in_at === null ? null : { by: row.signed_in_by_id !== null && row.signed_in_by_name !== null ? { id: row.signed_in_by_id, name: row.signed_in_by_name } : null, at: row.signed_in_at },
  signInClient: row.sign_in_client_id !== null && row.sign_in_client !== null ? { id: row.sign_in_client_id, sealed: row.sign_in_client } : null,
  scopeWanted: row.scope_wanted,
});

/** How many sign-ins to apps can be under way at once: beginning another forgets the one begun longest ago. */
const MAX_PENDING_APP_SIGN_INS = 20;

/** How many sign-ins people make to apps themselves can be under way at once, each person's latest: they're counted apart, so that they never crowd out an administrator's. */
const MAX_PENDING_OWN_APP_SIGN_INS = 100;

export class WorkspaceStore {
  constructor(private readonly db: Db) {}

  /** The workspace's account, or null until first run creates it. */
  async account(): Promise<JoinableAccount | null> {
    const [row] = await this.db.all<{
      name: string;
      join_code: string;
      settings: string | null;
      custom_styles: string | null;
      updated_at: string;
      logo_key: string | null;
      logo_variant: string | null;
    }>(`SELECT name, join_code, settings, custom_styles, updated_at, logo_key, logo_variant FROM accounts`);
    if (!row) return null;
    const settings = storedSettings(row.settings);
    return {
      name: row.name,
      joinCode: row.join_code,
      tagline: taglineIn(settings),
      hideTranslationButtons: hidesTranslationButtons(settings),
      customStyles: row.custom_styles ?? "",
      restrictRoomCreation: restrictsRoomCreation(settings),
      huddleCameras: showsHuddleCameras(settings),
      huddleScreens: sharesHuddleScreens(settings),
      customDomain: customDomainIn(settings),
      joinLink: joinsWithLinkIn(settings),
      openSignUp: signsUpOpenlyIn(settings),
      memberfulJoin: joinsWithMemberfulIn(settings),
      memberfulSignIn: signsInWithMemberful(settings),
      emailDomainSignUp: signsUpWithEmailDomainIn(settings),
      emailDomains: emailDomainsIn(settings),
      navigationIcons: navigationIconsIn(settings),
      updatedAt: row.updated_at,
      storedLogo: row.logo_key === null ? null : { key: row.logo_key, variant: row.logo_variant },
      emailFrom: emailFromIn(settings),
      resendApiKey: resendApiKeyIn(settings),
      turnstileKeys: turnstileKeysIn(settings),
      memberfulKeys: memberfulKeysIn(settings),
      assistant: assistantIn(settings),
      assistantMost: assistantMostIn(settings),
      assistantInstructions: assistantInstructionsIn(settings),
      assistantPromptTemplate: assistantPromptTemplateIn(settings),
      huddles: huddlesIn(settings),
      outsideAi: isPresent(settings?.outside_ai),
      deployedAddress: deployedAddressIn(settings),
      otherAddresses: otherAddressesIn(settings),
    };
  }

  /**
   * Changes the workspace's name, tagline, settings, custom domain and the ones it moved away from,
   * navigation icons, From address, Resend API key, Turnstile's keys, Memberful's, huddles' SFU app and
   * email domains, as `change` has them, in one batch. Memberful's settings are stored both at once, so that an account
   * from before `memberful_join` reads as they're saved.
   */
  async changeAccount(
    {
      name,
      tagline,
      hideTranslationButtons,
      restrictRoomCreation,
      huddleCameras,
      huddleScreens,
      customDomain,
      otherAddresses,
      joinLink,
      openSignUp,
      memberful,
      emailDomainSignUp,
      emailDomains,
      navigationIcons,
      emailFrom,
      resendApiKey,
      turnstileKeys,
      memberfulKeys,
      huddles,
    }: AccountChange,
    now: string,
  ): Promise<void> {
    await this.db.batch([
      ...(name === undefined ? [] : [statement(RENAME_ACCOUNT, name, now)]),
      ...(tagline === undefined ? [] : [statement(SET_TAGLINE, JSON.stringify(tagline), now)]),
      ...(hideTranslationButtons === undefined ? [] : [statement(SET_HIDE_TRANSLATION_BUTTONS, JSON.stringify(hideTranslationButtons), now)]),
      ...(restrictRoomCreation === undefined ? [] : [statement(SET_RESTRICT_ROOM_CREATION, JSON.stringify(restrictRoomCreation), now)]),
      ...(huddleCameras === undefined ? [] : [statement(SET_HUDDLE_CAMERAS, JSON.stringify(huddleCameras), now)]),
      ...(huddleScreens === undefined ? [] : [statement(SET_HUDDLE_SCREENS, JSON.stringify(huddleScreens), now)]),
      ...(customDomain === undefined ? [] : [statement(SET_CUSTOM_DOMAIN, JSON.stringify(customDomain), now)]),
      ...(otherAddresses === undefined ? [] : [statement(REMEMBER_OTHER_ADDRESSES, JSON.stringify(otherAddresses))]),
      ...(joinLink === undefined ? [] : [statement(SET_JOIN_LINK, JSON.stringify(joinLink), now)]),
      ...(openSignUp === undefined ? [] : [statement(SET_OPEN_SIGN_UP, JSON.stringify(openSignUp), now)]),
      ...(memberful === undefined
        ? []
        : [statement(SET_MEMBERFUL_JOIN, JSON.stringify(memberful.memberfulJoin), now), statement(SET_MEMBERFUL_SIGN_IN, JSON.stringify(memberful.memberfulSignIn), now)]),
      ...(emailDomainSignUp === undefined ? [] : [statement(SET_EMAIL_DOMAIN_SIGN_UP, JSON.stringify(emailDomainSignUp), now)]),
      ...(emailDomains === undefined ? [] : [statement(SET_EMAIL_DOMAINS, JSON.stringify(emailDomains), now)]),
      ...(navigationIcons === undefined ? [] : [statement(CHANGE_NAVIGATION_ICONS, JSON.stringify(navigationIconsPatch(navigationIcons)), now)]),
      ...(emailFrom === undefined ? [] : [statement(SET_EMAIL_FROM, JSON.stringify(emailFrom), now)]),
      ...(resendApiKey === undefined ? [] : [statement(SET_RESEND_API_KEY, JSON.stringify(resendApiKey), now)]),
      ...(turnstileKeys === undefined ? [] : [statement(SET_TURNSTILE_KEYS, JSON.stringify(turnstileKeys && { site_key: turnstileKeys.siteKey, secret_key: turnstileKeys.sealedSecretKey }), now)]),
      ...(memberfulKeys === undefined
        ? []
        : [statement(SET_MEMBERFUL_KEYS, JSON.stringify(memberfulKeys && { site: memberfulKeys.site, client_id: memberfulKeys.clientId, secrets: memberfulKeys.sealedSecrets }), now)]),
      ...(huddles === undefined ? [] : [statement(SET_HUDDLES, JSON.stringify(huddles && storedHuddles(huddles)), now)]),
    ]);
  }

  /** Remembers `address` as where a deploy puts Ember, which pages don't show. */
  async rememberDeployedAddress(address: string): Promise<void> {
    await this.db.run(REMEMBER_DEPLOYED_ADDRESS, JSON.stringify(address));
  }

  /** Remembers `addresses` as the custom domains Ember has moved away from, which pages don't show. */
  async rememberOtherAddresses(addresses: string[]): Promise<void> {
    await this.db.run(REMEMBER_OTHER_ADDRESSES, JSON.stringify(addresses));
  }

  /** Saves the workspace's custom CSS. */
  async changeCustomStyles(customStyles: string, now: string): Promise<void> {
    await this.db.run(CHANGE_CUSTOM_STYLES, customStyles, now);
  }

  /** Gives the join link a new code, so the old one joins no more. */
  async changeJoinCode(joinCode: string, now: string): Promise<void> {
    await this.db.run(CHANGE_JOIN_CODE, joinCode, now);
  }

  /** Whether someone is one of the workspace's active administrators, as they are when this asks. */
  async isAdministrator(userId: UserId): Promise<boolean> {
    return (await this.db.all(ACTIVE_ADMINISTRATOR, userId)).length > 0;
  }

  /** The active administrators' ids. */
  async administratorIds(): Promise<UserId[]> {
    return userIdsOf(await this.db.all<UserIdRow>(ACTIVE_ADMINISTRATORS));
  }

  /**
   * Creates the workspace: the account, its first administrator, open rooms that take in every active
   * person, and the administrator's session, who also joins every other open room. It adds `rooms` in
   * order, all made at once, so the first is the workspace's first room by its id, except any the
   * workspace has an open room of the same name for already, and answers the first, which opens. If
   * there's an account already, its singleton guard refuses the first statement, and so the whole batch.
   */
  async createWorkspace(
    account: NewAccount,
    administrator: NewPerson,
    rooms: Array<Pick<SharedRoom, "id" | "name">>,
    sessionId: string,
    tokenDigest: string,
    client: Client,
    now: string,
  ): Promise<SharedRoom> {
    const results = await this.db.batch([
      statement(`INSERT INTO accounts (id, name, join_code, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, account.id, account.name, account.joinCode, NEW_ACCOUNT_SETTINGS, now, now),
      statement(
        `INSERT INTO users (id, name, email_address, password_digest, role, avatar_key, avatar_variant, created_at, updated_at) VALUES (?, ?, ?, ?, ${ADMINISTRATOR}, ?, ?, ?, ?)`,
        administrator.id,
        administrator.name,
        administrator.emailAddress,
        administrator.passwordDigest,
        administrator.avatar?.key ?? null,
        administrator.avatar?.variant ?? null,
        now,
        now,
      ),
      ...keeping(administrator.avatar),
      ...rooms.flatMap((room) => [statement(INSERT_FIRST_ROOM, room.id, room.name, administrator.id, now), statement(GRANT_FIRST_ROOM, now, now, room.id)]),
      statement(GRANT_OPEN_ROOMS_TO_USER, administrator.id, now, now),
      statement(INSERT_SESSION, sessionId, administrator.id, tokenDigest, client.ip, client.userAgent, now, now, now),
      statement(OPEN_ROOM_NAMED, rooms[0]!.name),
    ]);
    return (results.at(-1) as SharedRoom[])[0]!;
  }

  /**
   * Adds someone who joined with the join link as a member, with their session, in every open room,
   * recording who invited them, if they joined with an invitation. Any invitation to their email address
   * is accepted, and the links to it spent, whichever way they joined. If someone has their email
   * address already, the address's unique index refuses the first statement, and so the whole batch,
   * which leaves the links as they were.
   */
  async createMember(person: NewPerson, sessionId: string, tokenDigest: string, client: Client, now: string): Promise<void> {
    await this.db.batch([
      statement(
        `INSERT INTO users (id, name, email_address, password_digest, avatar_key, avatar_variant, invited_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        person.id,
        person.name,
        person.emailAddress,
        person.passwordDigest,
        person.avatar?.key ?? null,
        person.avatar?.variant ?? null,
        person.invitedBy ?? null,
        now,
        now,
      ),
      ...keeping(person.avatar),
      statement(INSERT_SESSION, sessionId, person.id, tokenDigest, client.ip, client.userAgent, now, now, now),
      statement(GRANT_OPEN_ROOMS_TO_USER, person.id, now, now),
      statement(SPEND_EMAIL_LINKS, person.emailAddress),
    ]);
  }

  /**
   * Adds someone who signed in with `account`, an account elsewhere, as a member with no password, linked
   * to it, with their session, in every open room, spending the links to their email address, as
   * `createMember` adds someone who joins. If someone has their email address already, or the account
   * is linked to someone already, a unique index refuses its statement, and so the whole batch.
   */
  async createLinkedMember(person: NewLinkedPerson, account: LinkedAccount, checkedAt: number, sessionId: string, tokenDigest: string, client: Client, now: string): Promise<void> {
    await this.db.batch([
      statement(`INSERT INTO users (id, name, email_address, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, person.id, person.name, person.emailAddress, now, now),
      statement(
        `INSERT INTO identities (issuer, subject, user_id, checked_at, created_at, updated_at, name, email_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        account.issuer,
        account.subject,
        person.id,
        checkedAt,
        now,
        now,
        account.name,
        account.emailAddress,
      ),
      statement(INSERT_SESSION, sessionId, person.id, tokenDigest, client.ip, client.userAgent, now, now, now),
      statement(GRANT_OPEN_ROOMS_TO_USER, person.id, now, now),
      statement(SPEND_EMAIL_LINKS, person.emailAddress),
    ]);
  }

  /** The person the account elsewhere that `issuer` and `subject` name is linked to, whatever their status, or null for nobody. */
  async linkedPerson(issuer: string, subject: string): Promise<LinkedPerson | null> {
    return (await this.linkedPeople(issuer, [subject])).get(subject) ?? null;
  }

  /** The people the accounts at `issuer` with `subjects` are linked to, whatever their status, by subject, leaving out those linked to nobody. */
  async linkedPeople(issuer: string, subjects: string[]): Promise<Map<string, LinkedPerson>> {
    const rows = await this.db.all<{ subject: string; id: UserId; status: number; membership_needed: number; checked_at: number }>(LINKED_PEOPLE, issuer, JSON.stringify(subjects));
    return new Map(
      rows.map((row) => [
        row.subject,
        { userId: row.id, status: STATUSES[row.status] ?? "active", membershipNeeded: row.membership_needed === 1, checkedAt: row.checked_at },
      ]),
    );
  }

  /**
   * Starts a session for someone who signed in with `account`, an account elsewhere that's linked to
   * them, unless they've stopped being active, keeping what the account says of itself now.
   */
  async startLinkedSession(userId: UserId, sessionId: string, tokenDigest: string, client: Client, now: string, account: LinkedAccount): Promise<StoredSession | null> {
    const [, , [row]] = (await this.db.batch([
      statement(INSERT_LINKED_SESSION, sessionId, tokenDigest, client.ip, client.userAgent, now, userId),
      statement(REFRESH_IDENTITY, account.issuer, account.subject, account.name, account.emailAddress, now),
      statement(SESSION, tokenDigest),
    ])) as [unknown[], unknown[], SessionRow[]];
    return row ? storedSession(row) : null;
  }

  /**
   * Keeps `stateDigest`, started at `now`, for connecting the account of `userId` to one at `issuer`,
   * forgetting those started before `expiredBefore`, which can no longer connect anything. Whether it's
   * kept: not unless they're active, neither a guest nor a bot, their password's digest is still
   * `passwordDigest`, or "" for none, as it was checked, and they aren't connected to an account there.
   */
  async startConnection(stateDigest: string, userId: UserId, passwordDigest: string, issuer: string, now: number, expiredBefore: number): Promise<boolean> {
    const [, started] = await this.db.batch([
      statement(`DELETE FROM pending_identities WHERE created_at < ?`, expiredBefore),
      statement(START_CONNECTION, stateDigest, now, userId, passwordDigest, issuer),
    ]);
    return started!.length > 0;
  }

  /**
   * Takes the connection `stateDigest` started, if it started one, for good, answering whose it is, the
   * digest of the password that started it, and when it was started.
   */
  async takeConnection(stateDigest: string): Promise<(Connecting & { startedAt: number }) | null> {
    const [row] = await this.db.all<{ user_id: UserId; password_digest: string; created_at: number }>(
      `DELETE FROM pending_identities WHERE state_digest = ? RETURNING user_id, password_digest, created_at`,
      stateDigest,
    );
    return row ? { userId: row.user_id, passwordDigest: row.password_digest, startedAt: row.created_at } : null;
  }

  /**
   * Whether `userId` can have an account elsewhere connected, as an active person, neither a guest nor a
   * bot, can: if so, whether they need a membership, as everyone does but administrators and the people
   * they invited, and the subject of their account at `issuer`, if they have one there already.
   */
  async connectingPerson(userId: UserId, issuer: string): Promise<{ membershipNeeded: boolean; subject: string | null } | null> {
    const [row] = await this.db.all<{ membership_needed: number; subject: string | null }>(CONNECTING_PERSON, userId, issuer);
    return row ? { membershipNeeded: row.membership_needed === 1, subject: row.subject } : null;
  }

  /**
   * Links `account`, an account elsewhere, to the person `connecting` is for, its membership read at
   * `checkedAt`, unless they've stopped being able to have one connected, or their password has changed
   * since it checked out. Whether it's linked. A unique index refuses it for an account linked to
   * anyone already, or a second account of theirs at its issuer.
   */
  async connectIdentity({ userId, passwordDigest }: Connecting, account: LinkedAccount, checkedAt: number, now: string): Promise<boolean> {
    const { issuer, subject, name, emailAddress } = account;
    return (await this.db.all(CONNECT_IDENTITY, issuer, subject, checkedAt, now, userId, passwordDigest, name, emailAddress)).length > 0;
  }

  /**
   * Unlinks the account at `issuer` from `userId`, while their password's digest is still
   * `passwordDigest`, as the Worker checked it, and in the same transaction ends the sessions and
   * forgets the push subscriptions `ended` says, queuing closing those sessions' sockets, and forgets
   * the connections their browsers started and haven't finished, as a new password does. Each
   * statement checks both, so a password changed meanwhile, or an account disconnected already, changes
   * nothing. Answers whether it was unlinked, and whether it queued any.
   */
  async disconnectIdentity(userId: UserId, issuer: string, passwordDigest: string, ended: EndedByPassword): Promise<Disconnection> {
    const [queued, , , , unlinked] = await this.db.batch([
      // Before their sessions go, which it finds their sockets by, and before the link, which each checks.
      statement(QUEUE_DISCONNECTED_SESSION_REVOCATIONS, userId, issuer, passwordDigest, SESSION_TAG_PREFIX, ended.code, ended.dueAt, ended.kept),
      statement(`DELETE FROM sessions WHERE user_id = ?1 AND id <> ?4 AND ${DISCONNECTING}`, userId, issuer, passwordDigest, ended.kept),
      statement(`DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint IS NOT ?4 AND ${DISCONNECTING}`, userId, issuer, passwordDigest, ended.pushEndpoint),
      statement(`DELETE FROM pending_identities WHERE user_id = ?1 AND ${DISCONNECTING}`, userId, issuer, passwordDigest),
      statement(DISCONNECT_IDENTITY, userId, issuer, passwordDigest),
    ]);
    return { disconnected: unlinked!.length > 0, queued: queued!.length > 0 };
  }

  /** Whether anyone, whatever their status, has an account at `issuer` linked to them. */
  async anyoneLinked(issuer: string): Promise<boolean> {
    return (await this.db.all(`SELECT 1 FROM identities WHERE issuer = ? LIMIT 1`, issuer)).length > 0;
  }

  /** A Memberful site anyone here, whatever their status, has an account at linked to them, the first if there are several, or null while nobody has. */
  async linkedSite(): Promise<string | null> {
    const [linked] = await this.db.all<{ issuer: string }>(`SELECT issuer FROM identities LIMIT 1`);
    return linked?.issuer ?? null;
  }

  /** Whether anyone has exactly this email address, whatever their status. */
  async hasEmailAddress(emailAddress: string): Promise<boolean> {
    return (await this.db.all(`SELECT 1 FROM users WHERE email_address = ?`, emailAddress)).length > 0;
  }

  /** Which of `emailAddresses`, no more than `INVITATIONS_AT_ONCE`, someone has, whatever its case or their status, in lowercase. */
  async takenEmailAddresses(emailAddresses: string[]): Promise<Set<string>> {
    const rows = await this.db.all<{ email_address: string }>(TAKEN_EMAIL_ADDRESSES, JSON.stringify(emailAddresses));
    return new Set(rows.map((row) => row.email_address));
  }

  /** The invitations no one has accepted, newest first. */
  async invitations(): Promise<EmailInvitation[]> {
    return (await this.db.all<InvitationRow>(INVITATIONS)).map(invitationOf);
  }

  /**
   * Invites each address in `links` from `invitedBy`, with a link whose digest it gives, made at `now`
   * and working until `expiresAt`, in place of the link of any invitation it has already. Answers each
   * invitation's id, in order: the one given, or the one it had.
   */
  async saveInvitations(links: Array<{ id: string; emailAddress: string; tokenDigest: string }>, invitedBy: UserId, now: string, expiresAt: string): Promise<string[]> {
    if (links.length === 0) return [];
    const saved = await this.db.batch(links.map(({ id, emailAddress, tokenDigest }) => statement(SAVE_INVITATION, id, tokenDigest, emailAddress, invitedBy, now, expiresAt)));
    return saved.map((rows) => (rows as Array<{ id: string }>)[0]!.id);
  }

  /**
   * Gives the invitation with `id` a link whose digest is `tokenDigest`, made at `now` and working until
   * `expiresAt`, from `invitedBy`, in place of the one it had, answering its address, or null once it's
   * been accepted or revoked.
   */
  async renewInvitation(id: string, tokenDigest: string, invitedBy: UserId, now: string, expiresAt: string): Promise<string | null> {
    const [row] = await this.db.all<{ email_address: string }>(RENEW_INVITATION, id, tokenDigest, now, expiresAt, invitedBy);
    return row?.email_address ?? null;
  }

  /** Records what came of emailing each link, by its digest: sent at `now`, or the refusal, unless a newer link has taken its place. */
  async recordDeliveries(deliveries: Array<{ tokenDigest: string; refusal: string | null }>, now: string): Promise<void> {
    if (deliveries.length === 0) return;
    await this.db.batch(deliveries.map(({ tokenDigest, refusal }) => statement(RECORD_DELIVERY, tokenDigest, refusal === null ? now : null, refusal)));
  }

  /** Revokes the invitation with `id`, answering whether there was one to revoke. */
  async revokeInvitation(id: string): Promise<boolean> {
    return (await this.db.all(`DELETE FROM email_links WHERE id = ? AND kind = ${INVITATION} RETURNING id`, id)).length > 0;
  }

  /**
   * The link whose digest is `tokenDigest`, if it hasn't expired at `now`: what it is, the address it's
   * for, and who sent it, if it's an invitation.
   */
  async emailLinkFor(tokenDigest: string, now: string): Promise<{ kind: EmailLinkKind; emailAddress: string; invitedBy: UserId | null } | null> {
    const [row] = await this.db.all<{ kind: EmailLinkKind; email_address: string; invited_by: UserId | null }>(
      `SELECT kind, email_address, invited_by FROM email_links WHERE token_digest = ? AND expires_at > ?`,
      tokenDigest,
      now,
    );
    return row ? { kind: row.kind, emailAddress: row.email_address, invitedBy: row.invited_by } : null;
  }

  /**
   * Counts a time someone asked Ember to email `emailAddress`, whatever its case, at `now`: a link to join
   * with it at the email domains, or a code to reset its password. Answers how many times it's been asked
   * for in the hour its count is of, and when that hour began, which starts again once `since` is past,
   * when the counts whose hour is over are forgotten.
   */
  async countEmailRequest(emailAddress: string, now: string, since: string): Promise<{ count: number; countedSince: string }> {
    const [, counted] = await this.db.batch([statement(FORGET_EMAIL_LINK_REQUESTS, since), statement(COUNT_EMAIL_LINK_REQUEST, emailAddress, now, since)]);
    const [row] = counted as Array<{ count: number; counted_since: string }>;
    return { count: row!.count, countedSince: row!.counted_since };
  }

  /** Takes back a time `countEmailRequest` counted `emailAddress` in the hour that began at `countedSince`, unless its count has started again since. */
  async uncountEmailRequest(emailAddress: string, countedSince: string): Promise<void> {
    await this.db.run(UNCOUNT_EMAIL_LINK_REQUEST, emailAddress, countedSince);
  }

  /**
   * Gives `emailAddress` a new link to join with at the email domains, whose digest is `tokenDigest`,
   * made at `now` and working until `expiresAt`, in place of any it had, keeping that one's id, or else
   * with `id`, deleting in the same batch the links that stopped working by `now`, which nobody joined
   * with, so that those nobody uses don't pile up.
   */
  async saveEmailDomainLink(id: string, emailAddress: string, tokenDigest: string, now: string, expiresAt: string): Promise<void> {
    await this.db.batch([statement(FORGET_EXPIRED_EMAIL_DOMAIN_LINKS, now), statement(SAVE_EMAIL_DOMAIN_LINK, id, tokenDigest, emailAddress, now, expiresAt)]);
  }

  /**
   * Keeps `reset`, the code someone was emailed to reset their password, in place of any they had,
   * deleting in the same batch the codes that stopped working by the time it was made, which nobody
   * used, so that those don't pile up.
   */
  async savePasswordReset({ userId, codeDigest, emailAddress, passwordDigest, createdAt, expiresAt }: SavedPasswordReset): Promise<void> {
    await this.db.batch([
      statement(FORGET_EXPIRED_PASSWORD_RESETS, createdAt),
      statement(SAVE_PASSWORD_RESET, userId, codeDigest, emailAddress, passwordDigest, createdAt, expiresAt),
    ]);
  }

  /**
   * Counts a try of the code to reset a password that works, at `now`, for the active person whose email
   * address is exactly `emailAddress`, while it has tries left, answering its digest to check the code
   * tried against, or null while no code works for them, whoever they are.
   */
  async tryPasswordReset(emailAddress: string, now: string): Promise<string | null> {
    const [row] = await this.db.all<{ code_digest: string }>(TRY_PASSWORD_RESET, emailAddress, now, PASSWORD_RESET_CODE_TRIES);
    return row?.code_digest ?? null;
  }

  /**
   * Whose the code to reset a password whose digest is `codeDigest` is, while it works for the person
   * whose email address is exactly `emailAddress` at `now`, or null. Resetting their password spends it
   * (`resetPassword`).
   */
  async passwordResetHolder(emailAddress: string, codeDigest: string, now: string): Promise<UserId | null> {
    const [row] = await this.db.all<{ user_id: UserId }>(PASSWORD_RESET_HOLDER, emailAddress, now, codeDigest);
    return row?.user_id ?? null;
  }

  /** Whether `userId` may sign in with a password while Memberful is members only, as an active administrator, or someone who joined with an invitation, may. */
  async signsInWhileMembersOnly(userId: UserId): Promise<boolean> {
    return (await this.db.all(`SELECT 1 FROM users WHERE id = ? AND status = ${ACTIVE} AND ${NEEDS_NO_MEMBERSHIP}`, userId)).length > 0;
  }

  /** How many people, bots aside, have joined since `since`, whatever their status, counting no further than `most`. */
  async peopleJoinedSince(since: string, most: number): Promise<number> {
    const [row] = await this.db.all<{ joined: number }>(PEOPLE_JOINED_SINCE, since, BOT, most);
    return row?.joined ?? 0;
  }

  /** Adds a guest, who has a name but no way to sign in again, together with their session and open rooms. */
  async createGuest(user: User, sessionId: string, tokenDigest: string, client: Client, now: string): Promise<void> {
    await this.db.batch([
      statement(`INSERT INTO users (id, name, guest, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`, user.id, user.name, now, now),
      statement(INSERT_SESSION, sessionId, user.id, tokenDigest, client.ip, client.userAgent, now, now, now),
      statement(GRANT_OPEN_ROOMS_TO_USER, user.id, now, now),
    ]);
  }

  /** The session a token's digest names, if its person is still active. */
  async findSession(tokenDigest: string): Promise<StoredSession | null> {
    const [row] = await this.db.all<SessionRow>(SESSION, tokenDigest);
    return row ? storedSession(row) : null;
  }

  /**
   * The active person whose email address is exactly `emailAddress`, and their password's digest. People
   * without a password never sign in with one.
   */
  async passwordFor(emailAddress: string): Promise<{ userId: UserId; passwordDigest: string } | null> {
    const [row] = await this.db.all<{ id: UserId; password_digest: string }>(
      `SELECT id, password_digest FROM users WHERE email_address = ? AND status = ${ACTIVE} AND password_digest <> ''`,
      emailAddress,
    );
    return row ? { userId: row.id, passwordDigest: row.password_digest } : null;
  }

  /**
   * Starts a session for someone who signed in with the password `passwordDigest` is the digest of,
   * unless they've stopped being active since, or their password has been reset, or, while `membersOnly`
   * says Memberful is members only, they're neither an administrator nor someone who joined with an
   * invitation, and keeps `rehash`, a digest made now of the same password, in its place when there is one.
   */
  async startSession(
    userId: UserId,
    passwordDigest: string,
    rehash: string | null,
    membersOnly: boolean,
    sessionId: string,
    tokenDigest: string,
    client: Client,
    now: string,
  ): Promise<StoredSession | null> {
    const results = await this.db.batch([
      statement(INSERT_SESSION_IF_UNCHANGED, sessionId, tokenDigest, client.ip, client.userAgent, now, now, now, userId, passwordDigest, membersOnly ? 1 : 0),
      ...(rehash === null ? [] : [statement(REHASH_PASSWORD, rehash, userId, passwordDigest)]),
      statement(SESSION, tokenDigest),
    ]);
    const [row] = results[results.length - 1] as SessionRow[];
    return row ? storedSession(row) : null;
  }

  /**
   * Starts a session for someone who opened a sign-in link for them that the session `shownBy` showed,
   * unless they're no longer active, or are a guest while `guests` says guests can't stay signed in, or
   * that session has ended or is neither theirs nor an active administrator's.
   */
  async startTransferredSession(
    userId: UserId,
    shownBy: string,
    guests: boolean,
    sessionId: string,
    tokenDigest: string,
    client: Client,
    now: string,
  ): Promise<StoredSession | null> {
    const [, [row]] = (await this.db.batch([
      statement(INSERT_TRANSFERRED_SESSION, sessionId, tokenDigest, client.ip, client.userAgent, now, userId, guests ? 1 : 0, shownBy),
      statement(SESSION, tokenDigest),
    ])) as [unknown[], SessionRow[]];
    return row ? storedSession(row) : null;
  }

  /** Records that the session is in use from `client`. */
  async touchSession(id: string, client: Client, now: string): Promise<void> {
    await this.db.run(
      `UPDATE sessions SET last_active_at = ?, ip_address = ?, user_agent = ?, updated_at = ? WHERE id = ?`,
      now,
      client.ip,
      client.userAgent,
      now,
      id,
    );
  }

  /**
   * Ends the session a token's digest names, and in the same transaction queues closing its sockets
   * with `code` in every room its person is in, due at `dueAt`, and forgets its person's push
   * subscriptions with the endpoint `pushEndpoint`, the browser's that's signing out. Answers whether it
   * queued any.
   */
  async endSession(tokenDigest: string, code: CloseCode, dueAt: number, pushEndpoint: string | null): Promise<boolean> {
    const [queued] = await this.db.batch([
      statement(QUEUE_SESSION_REVOCATIONS, SESSION_TAG_PREFIX, code, dueAt, tokenDigest),
      ...(pushEndpoint === null ? [] : [statement(FORGET_SESSION_PUSH_ENDPOINT, tokenDigest, pushEndpoint)]),
      statement(`DELETE FROM sessions WHERE token_digest = ?`, tokenDigest),
    ]);
    return queued!.length > 0;
  }

  /**
   * Whoever has exactly the email address `emailAddress`, whatever their status, and whether they're a
   * bot.
   */
  async personWithEmailAddress(emailAddress: string): Promise<{ id: UserId; bot: boolean } | null> {
    const [row] = await this.db.all<{ id: UserId; role: number }>(`SELECT id, role FROM users WHERE email_address = ?`, emailAddress);
    return row ? { id: row.id, bot: ROLES[row.role] === "bot" } : null;
  }

  /**
   * Gives someone the password `passwordDigest` is the digest of, recording when, and ends all their
   * sessions, keeping their role and status, and forgets their push subscriptions, the accounts
   * elsewhere their old password started connecting, or connected (`UNLINK_ON_RESET`), and any
   * code they were emailed to reset it. In the same transaction it queues closing each session's
   * sockets with `code` in every room they're in, due at `dueAt`, as signing out does. Answers whether
   * it queued any.
   */
  async resetPassword(userId: UserId, passwordDigest: string, code: CloseCode, dueAt: number, now: string): Promise<boolean> {
    const [queued] = await this.db.batch([
      statement(QUEUE_PERSON_SESSION_REVOCATIONS, SESSION_TAG_PREFIX, code, dueAt, userId),
      statement(UNLINK_ON_RESET, userId),
      statement(`UPDATE users SET password_digest = ?, updated_at = ? WHERE id = ?`, passwordDigest, now, userId),
      statement(`DELETE FROM sessions WHERE user_id = ?`, userId),
      statement(`DELETE FROM push_subscriptions WHERE user_id = ?`, userId),
      statement(`DELETE FROM pending_identities WHERE user_id = ?`, userId),
      statement(`DELETE FROM password_resets WHERE user_id = ?`, userId),
    ]);
    return queued!.length > 0;
  }

  /**
   * Removes someone from the workspace, in one transaction: queues closing each of their sessions'
   * sockets with `code` in every room they're in, DMs included, due at `dueAt`, takes them out of every
   * room but their DMs, ends their sessions, forgets their recent searches, their push subscriptions
   * the sign-ins they made to apps and the AI apps connected as them, and marks them removed, recording when, with
   * `-deactivated-<uuid>` before each "@" of their email address. Their messages, boosts, DMs, role and
   * avatar stay. Answers whether it queued any.
   */
  async removePerson(userId: UserId, uuid: string, code: CloseCode, dueAt: number, now: string): Promise<boolean> {
    const [queued] = await this.db.batch([
      // Before they leave the rooms it finds their sockets in.
      statement(QUEUE_PERSON_SESSION_REVOCATIONS, SESSION_TAG_PREFIX, code, dueAt, userId),
      statement(LEAVE_SHARED_ROOMS, userId),
      statement(`DELETE FROM sessions WHERE user_id = ?`, userId),
      ...forgettingSearches(userId),
      statement(`DELETE FROM push_subscriptions WHERE user_id = ?`, userId),
      statement(`DELETE FROM own_app_sign_ins WHERE user_id = ?`, userId),
      statement(`DELETE FROM outside_spent_tokens WHERE connection_id IN (SELECT id FROM outside_connections WHERE user_id = ?)`, userId),
      statement(`DELETE FROM outside_connections WHERE user_id = ?`, userId),
      statement(DEACTIVATE, `-deactivated-${uuid}@`, now, userId),
    ]);
    return queued!.length > 0;
  }

  /**
   * Bans someone, in one transaction: queues closing each of their sessions' sockets with `code` in
   * every room they're in, due at `dueAt`, blocks each of `ipAddresses`, ends their sessions, marks them
   * banned, recording when, unless they were already, and queues deleting their messages in every room
   * they can have written in, due then too. It queues having every room tell the sockets from those
   * addresses to reconnect, due then as well, so they come back able only to read, and forgets the
   * sign-ins they made to apps and the AI apps connected as them. Their memberships, role and avatar
   * stay. Answers whether it queued anything.
   */
  async banPerson(userId: UserId, ipAddresses: string[], code: CloseCode, reconnect: CloseCode, dueAt: number, now: string): Promise<boolean> {
    const [revocations, , reconnections, , , purges] = (await this.db.batch([
      // Before their sessions go, which it finds their sockets by.
      statement(QUEUE_PERSON_SESSION_REVOCATIONS, SESSION_TAG_PREFIX, code, dueAt, userId),
      statement(`INSERT INTO bans (user_id, ip_address, created_at, updated_at) SELECT ?, value, ?, ? FROM json_each(?)`, userId, now, now, JSON.stringify(ipAddresses)),
      statement(QUEUE_ADDRESS_REVOCATIONS, ADDRESS_TAG_PREFIX, reconnect, dueAt, JSON.stringify(ipAddresses)),
      statement(`DELETE FROM sessions WHERE user_id = ?`, userId),
      statement(`UPDATE users SET status = ${BANNED}, updated_at = ? WHERE id = ? AND status <> ${BANNED}`, now, userId),
      statement(QUEUE_PURGES, userId, dueAt),
      statement(`DELETE FROM own_app_sign_ins WHERE user_id = ?`, userId),
      statement(`DELETE FROM outside_spent_tokens WHERE connection_id IN (SELECT id FROM outside_connections WHERE user_id = ?)`, userId),
      statement(`DELETE FROM outside_connections WHERE user_id = ?`, userId),
    ])) as unknown[][];
    return revocations!.length > 0 || reconnections!.length > 0 || purges!.length > 0;
  }

  /**
   * Lifts someone's ban: unblocks their IP addresses and makes them active, recording when, unless they
   * were already, whatever their status was, and puts them in every open room, as joining does, those
   * made or opened while they were banned among them. The rooms yet to delete their messages delete
   * only those written by then, at once. It queues having every room tell the sockets from those
   * addresses to reconnect, due at `dueAt`, so they come back able to change things again, unless
   * another ban blocks them too. Answers whether it queued anything.
   */
  async unbanPerson(userId: UserId, reconnect: CloseCode, dueAt: number, now: string): Promise<boolean> {
    const [reconnections] = (await this.db.batch([
      // Before the bans go, which it finds the addresses by.
      statement(QUEUE_UNBANNED_ADDRESS_REVOCATIONS, ADDRESS_TAG_PREFIX, reconnect, dueAt, userId),
      statement(`DELETE FROM bans WHERE user_id = ?`, userId),
      statement(`UPDATE users SET status = ${ACTIVE}, updated_at = ? WHERE id = ? AND status <> ${ACTIVE}`, now, userId),
      statement(GRANT_OPEN_ROOMS_TO_USER, userId, now, now),
      // The outbox holds a row only until its room answers, so this reads it all rather than keep an index.
      statement(`UPDATE pending_purges SET lifted_at = ? WHERE user_id = ? AND lifted_at IS NULL`, now, userId),
    ])) as unknown[][];
    return reconnections!.length > 0;
  }

  /**
   * Suspends the active member `userId`, whose membership of the Memberful site `issuer` has lapsed, as
   * their account there with `subject` was read at `readAt`, in one transaction: queues closing each of
   * their sessions' sockets with `code` in every room they're in, due at `dueAt`, as removing them does,
   * ends their sessions, forgets their push subscriptions, marks them suspended, recording when, and
   * records the read. Their rooms, messages, role and avatar stay, for when it's renewed. Answers whether
   * it queued any.
   */
  async suspendPerson(userId: UserId, issuer: string, subject: string, readAt: number, code: CloseCode, dueAt: number, now: string): Promise<boolean> {
    const [queued] = await this.db.batch([
      // Before their sessions go, which it finds their sockets by.
      statement(QUEUE_PERSON_SESSION_REVOCATIONS, SESSION_TAG_PREFIX, code, dueAt, userId),
      statement(`DELETE FROM sessions WHERE user_id = ?`, userId),
      statement(`DELETE FROM push_subscriptions WHERE user_id = ?`, userId),
      statement(`UPDATE users SET status = ${SUSPENDED}, updated_at = ? WHERE id = ? AND status = ${ACTIVE}`, now, userId),
      statement(STAMP_MEMBERSHIPS, issuer, JSON.stringify([subject]), readAt),
    ]);
    return queued!.length > 0;
  }

  /**
   * Lets back the suspended member `userId`, whose membership of the Memberful site `issuer` is renewed,
   * as their account there with `subject` was read at `readAt`, in one transaction: makes them active,
   * recording when, puts them in the open rooms made while they were suspended, as joining puts someone
   * in every open room, and records the read.
   */
  async restorePerson(userId: UserId, issuer: string, subject: string, readAt: number, now: string): Promise<void> {
    await this.db.batch([
      statement(`UPDATE users SET status = ${ACTIVE}, updated_at = ? WHERE id = ? AND status = ${SUSPENDED}`, now, userId),
      statement(GRANT_OPEN_ROOMS_TO_USER, userId, now, now),
      statement(STAMP_MEMBERSHIPS, issuer, JSON.stringify([subject]), readAt),
    ]);
  }

  /** Records that the memberships of the accounts at the Memberful site `issuer` with `subjects` were read at `readAt`, unless they were since. */
  async stampMemberships(issuer: string, subjects: string[], readAt: number): Promise<void> {
    if (subjects.length > 0) await this.db.run(STAMP_MEMBERSHIPS, issuer, JSON.stringify(subjects), readAt);
  }

  /** Every IP address a ban blocks. */
  async bannedAddresses(): Promise<string[]> {
    return (await this.db.all<{ ip_address: string }>(`SELECT DISTINCT ip_address FROM bans`)).map((row) => row.ip_address);
  }

  /** The IP addresses recorded on someone's sessions, which banning them blocks. */
  async sessionIpAddresses(userId: UserId): Promise<string[]> {
    return (await this.db.all<{ ip_address: string }>(SESSION_IP_ADDRESSES, userId)).map((row) => row.ip_address);
  }

  /** Up to `limit` of the purges due by `now` whose rooms have no sockets left to close, those due longest first. */
  async duePurges(now: number, limit: number): Promise<PendingPurge[]> {
    return this.db.all<PendingPurge>(DUE_PURGES, now, limit);
  }

  /**
   * Forgets the purges `finished` names, makes the ones `unfinished` names due again at `now`, and puts
   * off the ones `failed` names, each for twice as long as the time before, up to the longest wait. It
   * never gives one up, which would leave a banned person's messages up.
   */
  async settlePurges(finished: number[], unfinished: number[], failed: number[], now: number): Promise<void> {
    await this.db.batch([
      statement(`DELETE FROM pending_purges WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(finished)),
      statement(`UPDATE pending_purges SET attempts = 0, due_at = ? WHERE id IN (SELECT value FROM json_each(?))`, now, JSON.stringify(unfinished)),
      // As a revocation's wait.
      statement(
        `UPDATE pending_purges SET attempts = attempts + 1, due_at = ? + min(?, ? << min(attempts, ?)) WHERE id IN (SELECT value FROM json_each(?))`,
        now,
        LONGEST_RETRY_MS,
        FIRST_RETRY_MS,
        RETRY_DOUBLINGS,
        JSON.stringify(failed),
      ),
    ]);
  }

  /** Up to `limit` of the revocations due by `now`, those due longest first. */
  async dueRevocations(now: number, limit: number): Promise<PendingRevocation[]> {
    return this.db.all<PendingRevocation>(DUE_REVOCATIONS, now, limit);
  }

  /**
   * The revocations due by `now` that no delivery has tried yet, in up to `limit` rooms, those queued
   * last first and every row of each: what a change has just queued.
   */
  async queuedRevocations(now: number, limit: number): Promise<PendingRevocation[]> {
    return this.db.all<PendingRevocation>(QUEUED_REVOCATIONS, now, limit);
  }

  /**
   * Forgets the revocations `delivered` names, and puts off the ones `failed` names, each for twice as
   * long as the time before, up to the longest wait, for as long as it takes: it never gives one up,
   * which would leave the sockets it closes open, or a deleted room's messages stored.
   */
  async settleRevocations(delivered: number[], failed: number[], now: number): Promise<void> {
    await this.db.batch([
      statement(`DELETE FROM pending_revocations WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(delivered)),
      statement(
        `UPDATE pending_revocations SET attempts = attempts + 1, due_at = ? + min(?, ? << min(attempts, ?)) WHERE id IN (SELECT value FROM json_each(?))`,
        now,
        LONGEST_RETRY_MS,
        FIRST_RETRY_MS,
        RETRY_DOUBLINGS,
        JSON.stringify(failed),
      ),
    ]);
  }

  /** Up to `limit` of the rooms due by `now` to have the search index take all their messages, those due longest first. */
  async dueReindexes(now: number, limit: number): Promise<RoomId[]> {
    const rows = await this.db.all<{ room_id: RoomId }>(`SELECT room_id FROM pending_reindexes WHERE due_at <= ? ORDER BY due_at, room_id LIMIT ?`, now, limit);
    return rows.map((row) => row.room_id);
  }

  /**
   * Forgets the reindexes `delivered` names, and puts off the ones `failed` names, each for twice as
   * long as the time before, up to the longest wait. It never gives one up, which would leave the room's
   * messages out of searches.
   */
  async settleReindexes(delivered: RoomId[], failed: RoomId[], now: number): Promise<void> {
    await this.db.batch([
      statement(`DELETE FROM pending_reindexes WHERE room_id IN (SELECT value FROM json_each(?))`, JSON.stringify(delivered)),
      // As a purge's wait.
      statement(
        `UPDATE pending_reindexes SET attempts = attempts + 1, due_at = ? + min(?, ? << min(attempts, ?)) WHERE room_id IN (SELECT value FROM json_each(?))`,
        now,
        LONGEST_RETRY_MS,
        FIRST_RETRY_MS,
        RETRY_DOUBLINGS,
        JSON.stringify(failed),
      ),
    ]);
  }

  /**
   * Queues checking the membership of the account at the Memberful site `issuer` with `subject`, due at
   * `now`, as a webhook about it came then, if it's linked to a member whose membership counts, and makes
   * the site's catch-up due by `nextCatchUp`, if anyone here is linked to an account there.
   */
  async queueMembershipCheck(issuer: string, subject: string, now: number, nextCatchUp: number): Promise<void> {
    await this.db.batch([statement(QUEUE_MEMBERSHIP_CHECK, issuer, subject, now), statement(SCHEDULE_MEMBERSHIP_CATCH_UP, issuer, nextCatchUp)]);
  }

  /** Makes the catch-up of the memberships at the Memberful site `issuer` due by `dueAt`, if anyone here is linked to an account there. */
  async scheduleMembershipCatchUp(issuer: string, dueAt: number): Promise<void> {
    await this.db.run(SCHEDULE_MEMBERSHIP_CATCH_UP, issuer, dueAt);
  }

  /** Makes the catch-up of the memberships at the Memberful site `issuer` due at `dueAt`, unless one is due already, if anyone here is linked to an account there. */
  async startMembershipCatchUp(issuer: string, dueAt: number): Promise<void> {
    await this.db.run(START_MEMBERSHIP_CATCH_UP, issuer, dueAt);
  }

  /**
   * Forgets the membership checks and catch-ups of every Memberful site but `site`, all of them for null,
   * as nothing checks them, and the catch-up of `site` while nobody here is linked to an account there,
   * as one started before anyone was may be, then, if the catch-up of `site` is due by `now`, queues
   * checking every membership there that counts and makes the next due at `nextCatchUp`, and answers up
   * to `limit` of its checks due by `now`, those due longest first.
   */
  async dueMembershipChecks(site: string | null, now: number, nextCatchUp: number, limit: number): Promise<MembershipCheck[]> {
    const results = await this.db.batch([
      statement(`DELETE FROM membership_checks WHERE issuer IS NOT ?`, site),
      statement(`DELETE FROM membership_catch_ups WHERE issuer IS NOT ?1 OR NOT ${ANYONE_LINKED}`, site),
      statement(QUEUE_MEMBERSHIP_CATCH_UP, site, now),
      statement(`UPDATE membership_catch_ups SET due_at = ? WHERE issuer = ? AND due_at <= ?`, nextCatchUp, site, now),
      statement(`SELECT subject, attempts FROM membership_checks WHERE issuer = ? AND due_at <= ? ORDER BY due_at, subject LIMIT ?`, site, now, limit),
    ]);
    return results[4] as MembershipCheck[];
  }

  /**
   * Forgets the checks of the accounts at the Memberful site `issuer` with `subjects`, which it answered
   * for as read at `readAt`, but those queued again since, which are checked again. When it didn't answer
   * (null), puts them off instead, each for twice as long as the time before, up to the longest wait, as
   * a revocation is, for as long as it takes.
   */
  async settleMembershipChecks(issuer: string, subjects: string[], readAt: number | null, now: number): Promise<void> {
    const checked = JSON.stringify(subjects);
    if (readAt !== null) {
      await this.db.run(`DELETE FROM membership_checks WHERE issuer = ? AND subject IN (SELECT value FROM json_each(?)) AND queued_at <= ?`, issuer, checked, readAt);
      return;
    }
    await this.db.run(
      `UPDATE membership_checks SET attempts = attempts + 1, due_at = ? + min(?, ? << min(attempts, ?)) WHERE issuer = ? AND subject IN (SELECT value FROM json_each(?))`,
      now,
      LONGEST_RETRY_MS,
      FIRST_RETRY_MS,
      RETRY_DOUBLINGS,
      issuer,
      checked,
    );
  }

  /**
   * When the outbox's next revocation, purge, reindex, picture deletion or membership check is due, if
   * any is waiting, leaving out the purges waiting on their rooms' revocations, which are due no sooner.
   */
  async nextDeliveryDue(): Promise<number | null> {
    const [row] = await this.db.all<{ revocation: number | null; purge: number | null; reindex: number | null; picture: number | null; membership: number | null; catchUp: number | null }>(
      `SELECT (SELECT min(due_at) FROM pending_revocations) AS revocation, (${NEXT_PURGE_DUE}) AS purge, (SELECT min(due_at) FROM pending_reindexes) AS reindex,
        (SELECT min(due_at) FROM pending_picture_deletions) AS picture, (SELECT min(due_at) FROM membership_checks) AS membership,
        (SELECT min(due_at) FROM membership_catch_ups) AS catchUp`,
    );
    const due = [row?.revocation, row?.purge, row?.reindex, row?.picture, row?.membership, row?.catchUp].filter((time) => typeof time === "number");
    return due.length > 0 ? Math.min(...due) : null;
  }

  /**
   * What someone's search needs: the rooms they're in, with the people in their DMs, as their sidebar
   * lists them, and their recent searches, newest first, having first recorded the search whose key is
   * `recording` as their newest, when it's given, in the same transaction.
   */
  async searcherOf(userId: UserId, recording: string | null): Promise<{ rooms: Room[]; recent: Search[] }> {
    const records = recording === null ? [] : [statement(RECORD_SEARCH, userId, recording), statement(TRIM_SEARCHES, userId, RECENT_SEARCHES - 1)];
    const results = await this.db.batch([
      ...records,
      statement(ROOMS_FOR_USER, userId),
      statement(DIRECT_MEMBERS_FOR_USER, userId),
      statement(RECENT_SEARCHES_FOR_USER, userId, RECENT_SEARCHES),
    ]);
    const [rows, members, recent] = results.slice(records.length) as [SidebarRow[], DirectMemberRow[], Array<{ search: string }>];
    const membersByRoom = Map.groupBy(members, (member) => member.room_id);
    return { rooms: rows.map((row) => roomOf(row, membersByRoom.get(row.id))), recent: recent.flatMap((row) => recentSearchOf(row.search) ?? []) };
  }

  /** Forgets all of someone's recent searches. */
  async clearSearches(userId: UserId): Promise<void> {
    await this.db.batch(forgettingSearches(userId));
  }

  /**
   * Saves a browser's push subscription for someone, with its user agent, or records that they saved it
   * again, and forgets theirs past the `MAX_PUSH_SUBSCRIPTIONS` saved most recently, and the one with
   * the P-256 key `replacing`, which it replaces. Answers whether it saved it, which it doesn't once their
   * session `sessionId` has ended.
   */
  async savePushSubscription(
    userId: UserId,
    sessionId: string,
    { endpoint, p256dhKey, authKey }: PushSubscriptionKeys,
    userAgent: string | null,
    replacing: string | null,
    now: string,
  ): Promise<boolean> {
    const [saved] = await this.db.batch([
      statement(SAVE_PUSH_SUBSCRIPTION, userId, endpoint, p256dhKey, authKey, userAgent, now, sessionId),
      ...(replacing === null ? [] : [statement(FORGET_REPLACED_PUSH_SUBSCRIPTION, userId, replacing, endpoint, sessionId)]),
      statement(TRIM_PUSH_SUBSCRIPTIONS, userId, MAX_PUSH_SUBSCRIPTIONS),
    ]);
    return saved!.length > 0;
  }

  /** Someone's push subscriptions, oldest first. */
  async pushSubscriptionsOf(userId: UserId): Promise<StoredPushSubscription[]> {
    const rows = await this.db.all<{ id: number; endpoint: string; user_agent: string | null }>(
      `SELECT id, endpoint, user_agent FROM push_subscriptions WHERE user_id = ? ORDER BY id`,
      userId,
    );
    return rows.map((row) => ({ id: row.id, endpoint: row.endpoint, userAgent: row.user_agent }));
  }

  /**
   * Where a test push to someone's push subscription `id` goes, with how many of their conversations
   * are marked unread for its badge, or null if it isn't theirs or there's no such subscription.
   */
  async testPushDelivery(userId: UserId, id: number): Promise<PushDelivery | null> {
    const [row] = await this.db.all<DeliveryRow>(TEST_PUSH, id, userId);
    return row ? deliveryOf(row) : null;
  }

  /** Deletes someone's push subscription `id`, if it's theirs. */
  async deletePushSubscription(userId: UserId, id: number): Promise<void> {
    await this.db.run(`DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?`, id, userId);
  }

  /**
   * The rooms someone is in, with their unread marks and the people in their DMs, the ones they've
   * starred, the huddles going on in their rooms, and the workspace's first room, if there is one yet
   * and they're given the welcome card: an active administrator who hasn't dismissed it.
   */
  async roomsFor(userId: UserId): Promise<SidebarRooms> {
    const [rows, [original], starred, [user], members] = (await this.db.batch([
      statement(ROOMS_FOR_USER, userId),
      statement(ORIGINAL_ROOM),
      statement(FAVORITES_FOR_USER, userId),
      statement(SIDEBAR_USER, userId),
      statement(DIRECT_MEMBERS_FOR_USER, userId),
    ])) as [SidebarRow[], Array<{ id: RoomId }>, Array<{ room_id: RoomId }>, Array<{ version: number; invited: number }>, DirectMemberRow[]];
    const membersByRoom = Map.groupBy(members, (member) => member.room_id);
    return {
      rooms: rows.map((row) => sidebarRoom(row, membersByRoom.get(row.id))),
      favorites: { rooms: starred.map((row) => row.room_id), version: user?.version ?? 0 },
      sharedOrder: sharedOrderOf(rows),
      huddles: liveHuddlesIn(rows),
      invitationRoomId: user?.invited === 1 ? (original?.id ?? null) : null,
    };
  }

  /**
   * Keeps room `roomId`'s huddle as the room reported it at `at`, by its own clock: `huddle`, or nobody
   * in it once it's null, and the report's time, even when the huddle kept was that already. Answers
   * who's in the room, to hear of it, when the report changed the huddle kept, and the time of the
   * latest report instead, when that's no earlier than this one. A room that's gone keeps nothing.
   */
  async reportHuddle(roomId: RoomId, at: number, huddle: LiveHuddle | null): Promise<ReportedHuddle> {
    const [[before], changed, members] = (await this.db.batch([
      statement(HUDDLE_REPORTED_AT, roomId),
      statement(REPORT_HUDDLE, roomId, at, huddle?.startedAt ?? "", huddle ? JSON.stringify(huddle.userIds) : NOBODY),
      statement(MEMBERS_TO_TELL_OF_HUDDLE, roomId, at),
      statement(KEEP_REPORT_TIME, roomId, at),
    ])) as [Array<{ huddle_reported_at: number }>, unknown[], UserIdRow[], unknown[]];
    if (before && before.huddle_reported_at >= at) return { memberIds: null, outdatedBy: before.huddle_reported_at };
    return { memberIds: changed.length > 0 ? userIdsOf(members) : null, outdatedBy: null };
  }

  /** The huddle going on in a room, or null when none is. */
  async liveHuddle(roomId: RoomId): Promise<LiveHuddle | null> {
    const [row] = await this.db.all<HuddleRow>(HUDDLE, roomId);
    return row ? liveHuddleOf(row) : null;
  }

  /** Records that someone has dismissed the welcome card, at `now`, unless they had already. */
  async dismissInvitation(userId: UserId, now: string): Promise<void> {
    await this.db.run(DISMISS_INVITATION, now, userId);
  }

  /**
   * Puts the rooms in administrator `userId`'s sidebar, DMs aside, in the shared order in the order
   * `roomIds` lists them, as saving it on workspace settings does, merged with the order as
   * `mergedSharedOrder` says, or clears the order when `roomIds` is empty. Answers the rooms they're in
   * that the order ranks, in its order, as their sidebar lists them then, or null, having changed
   * nothing, unless they're an active administrator and every room is one they could order, and the
   * order holds at most `MAX_SHARED_ORDER` rooms. The Workspace makes this change one at a time with the
   * others that change who can see a room or order them, so nothing changes what the first batch read
   * before the second.
   */
  async setSharedOrder(userId: UserId, roomIds: RoomId[]): Promise<RoomId[] | null> {
    const [[may], saved] = (await this.db.batch([
      statement(MAY_ORDER_ROOMS, userId, JSON.stringify(roomIds)),
      statement(SHARED_ORDER_FOR_ADMINISTRATOR, userId),
    ])) as [Array<{ allowed: number }>, Array<{ id: RoomId; orderable: number }>];
    if (may?.allowed !== 1) return null;
    const merged = roomIds.length === 0 ? [] : mergedSharedOrder(saved.map((row) => ({ id: row.id, orderable: row.orderable === 1 })), roomIds);
    if (merged.length > MAX_SHARED_ORDER) return null;
    const listed = JSON.stringify(merged);
    const [, , ranked] = (await this.db.batch([
      statement(UNRANK_ROOMS, listed),
      statement(RANK_ROOMS, listed),
      statement(SHARED_ORDER_FOR_USER, userId),
    ])) as [unknown[], unknown[], Array<{ id: RoomId }>];
    return ranked.map((row) => row.id);
  }

  /**
   * Puts someone's stars in the order `roomIds` lists them, as dragging one does in the sidebar, in one
   * transaction that also drops their stars on rooms they can't star any more. Answers their stars as
   * they are then, or null, having changed nothing, when `roomIds` isn't exactly the rooms they've
   * starred and can star.
   */
  async setFavoriteOrder(userId: UserId, roomIds: RoomId[]): Promise<Favorites | null> {
    const listed = JSON.stringify(roomIds);
    const [, , [saved], starred] = (await this.db.batch([
      statement(REORDER_STARS, userId, listed),
      statement(AFTER_REORDER.drop, userId, listed),
      statement(AFTER_REORDER.count, userId, listed),
      statement(FAVORITES_FOR_USER, userId),
    ])) as [unknown[], unknown[], Array<{ version: number }>, Array<{ room_id: RoomId }>];
    return saved ? { rooms: starred.map((row) => row.room_id), version: saved.version } : null;
  }

  /**
   * Stars room `roomId` for someone, after their other stars, or unstars it, in one transaction that
   * also drops their stars on rooms they can't star any more. Answers their stars as they are then, or
   * null, having changed nothing, when they can't star the room, a DM or one they've hidden or aren't
   * in, or have as many stars as they can have.
   */
  async setFavorite(userId: UserId, roomId: RoomId, favorite: boolean): Promise<Favorites | null> {
    const after = favorite ? AFTER_STAR : AFTER_UNSTAR;
    const [, , [saved], starred] = (await this.db.batch([
      statement(favorite ? STAR : UNSTAR, userId, roomId),
      statement(after.drop, userId, roomId),
      statement(after.count, userId, roomId),
      statement(FAVORITES_FOR_USER, userId),
    ])) as [unknown[], unknown[], Array<{ version: number }>, Array<{ room_id: RoomId }>];
    return saved ? { rooms: starred.map((row) => row.room_id), version: saved.version } : null;
  }

  /**
   * Gives someone level `involvement` in room `roomId`, answering it, with their stars as they are then
   * when hiding the room or showing it again changed them. Answers "not found" when they aren't in the
   * room, and "invalid" for no level at all, having changed nothing.
   */
  async setInvolvement(
    userId: UserId,
    roomId: RoomId,
    involvement: Involvement | null,
  ): Promise<{ involvement: Involvement; favorites: Favorites | null } | "not found" | "invalid"> {
    if (involvement === null) return (await this.db.all(INVOLVEMENT, userId, roomId)).length > 0 ? "invalid" : "not found";
    const [[counted], [saved], starred] = (await this.db.batch([
      statement(COUNT_HIDDEN_STAR, userId, roomId, involvement),
      statement(SET_INVOLVEMENT, userId, roomId, involvement),
      statement(FAVORITES_FOR_USER, userId),
    ])) as [Array<{ version: number }>, Array<{ involvement: Involvement }>, Array<{ room_id: RoomId }>];
    if (!saved) return "not found";
    const favorites = counted ? { rooms: starred.map((row) => row.room_id), version: counted.version } : null;
    return { involvement: saved.involvement, favorites };
  }

  /**
   * Applies `events` from room `roomId`'s log, in order and in one transaction, with `viewerIds`, who
   * is viewing the room, or for a message whose event names its own `viewerIds`, those: a message marks
   * it unread for the members who aren't, and a read clears the reader's mark. The latest message also records when the room was last active. A reply sent only to
   * its thread does neither, and isn't pushed to those its event's `viewerIds` say are viewing the thread,
   * in place of those viewing the room. Those the Workspace has applied before change nothing. Answers
   * whose marks changed, and whether each is now unread, and, when a message has come in a DM, when the
   * latest did and everyone in the DM, to tell. With `pushing`, it answers each new message's pushes too,
   * found just after its marks, so that a push's badge counts them and none of the events after it, and
   * to guests only if `guests` says they can stay signed in. It answers the bots' webhooks each new
   * message is delivered to, but for a bot's reply to one, which reaches the room as any message does but
   * goes to no webhook.
   */
  async applyRoomEvents(roomId: RoomId, events: RoomEvent[], viewerIds: UserId[], pushing = false, guests = false): Promise<AppliedEvents> {
    const viewers = JSON.stringify(viewerIds);
    const last = events.at(-1)!.seq;
    const message = events.findLast(isRoomMessage);
    // When the latest message came, which a clock behind can make earlier than one logged before it.
    const messageAt = message && events.reduce((latest, event) => (isRoomMessage(event) && event.at > latest ? event.at : latest), message.at);
    const statements: Statement[] = [];
    const applied = events.map((event) => {
      const { seq, kind, userId, at } = event;
      const seeing = event.viewerIds === undefined ? viewers : JSON.stringify(event.viewerIds);
      const mark = isNewMessage(event) ? (event.threadOnly ? null : statement(MARK_UNREAD, at, roomId, userId, seeing, seq)) : statement(MARK_READ, roomId, userId, seq);
      const marks = mark && statements.push(mark) - 1;
      const mentions = event.message ? JSON.stringify(event.message.mentionIds) : null;
      const followers = JSON.stringify(event.message?.followerIds ?? []);
      const inRoom = event.threadOnly ? 0 : 1;
      const pushes = pushing && mentions !== null ? statements.push(statement(MESSAGE_PUSHES, roomId, userId, seeing, mentions, seq, guests ? 1 : 0, inRoom, followers)) - 1 : null;
      // A bot's reply is never delivered to webhooks, as Campfire posts one without delivering it, nor is
      // @ember's answer, which is a reply too.
      const bots = kind === "message" && mentions !== null ? statements.push(statement(MESSAGE_BOTS, roomId, userId, mentions, seq)) - 1 : null;
      return { event, marks, pushes, bots };
    });
    const told = statements.length;
    statements.push(...(message ? [statement(TOLD_OF_DIRECT_MESSAGE, roomId, message.seq), statement(APPLIED_WITH_MESSAGE, last, roomId, messageAt!)] : [statement(APPLIED, last, roomId)]));
    const results = await this.db.batch(statements);
    const marks = new Map<UserId, string | null>();
    for (const { event, marks: at } of applied) {
      if (at === null) continue;
      for (const { user_id } of results[at] as UserIdRow[]) marks.set(user_id, isNewMessage(event) ? event.at : null);
    }
    const pushes = applied.flatMap(({ event, pushes: at }) => (at === null ? [] : messagePushes(roomId, event, results[at] as PushRow[])));
    const deliveries = applied.flatMap(({ event, bots: at }) => (at === null ? [] : messageDeliveries(event, results[at] as MessageBotRow[])));
    const webhooks = deliveries.flatMap(({ answers, ...delivery }) => (answers ? [] : [delivery]));
    const asks = deliveries.flatMap(({ answers, ...ask }) => (answers ? [ask] : []));
    const toldIds = message ? userIdsOf(results[told] as UserIdRow[]) : [];
    return { marks, active: toldIds.length > 0 ? { at: messageAt!, userIds: toldIds } : null, pushes, webhooks, asks };
  }

  /** Whether push subscription `id` is still saved, for someone active. */
  async pushable(id: number): Promise<boolean> {
    return (await this.db.all(PUSHABLE, id)).length > 0;
  }

  /** Forgets the push subscriptions with `ids`, which the push service has said are gone or can never be pushed to. */
  async forgetPushSubscriptions(ids: number[]): Promise<void> {
    await this.db.run(`DELETE FROM push_subscriptions WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
  }

  async isMember(roomId: RoomId, userId: UserId): Promise<boolean> {
    return (await this.db.all(MEMBERSHIP, roomId, userId)).length > 0;
  }

  /** Whether room `roomId` is a direct conversation between `userId` and `otherId` alone, each an active member of it. */
  async isBetween(roomId: RoomId, userId: UserId, otherId: UserId): Promise<boolean> {
    return (await this.db.all(BETWEEN, roomId, userId, otherId)).length > 0;
  }

  /** Whether `userId` is in room `roomId`, and whether a ban blocks `ipAddress`, if there is one. */
  async roomAccess(roomId: RoomId, userId: UserId, ipAddress: string | null): Promise<{ member: boolean; banned: boolean }> {
    const [row] = await this.db.all<{ member: number; banned: number }>(ROOM_ACCESS, roomId, userId, ipAddress);
    return { member: row!.member === 1, banned: row!.banned === 1 };
  }

  /** Everyone active who can be put in a room, by name (`ACTIVE_PEOPLE`). */
  async activePeople(): Promise<User[]> {
    return this.db.all<User>(ACTIVE_PEOPLE);
  }

  /** The people with `ids` who exist, active or not. */
  async peopleWithIds(ids: UserId[]): Promise<User[]> {
    return this.db.all<User>(PEOPLE_WITH_IDS, JSON.stringify(ids));
  }

  /** The people with `ids` who exist, active or not, whom `askerId` can start a DM with (`DIRECT_PEOPLE`). */
  async directPeople(ids: UserId[], askerId: UserId): Promise<User[]> {
    return this.db.all<User>(DIRECT_PEOPLE, JSON.stringify(ids), askerId);
  }

  /** The people with `ids`, whatever their status, as the people directory lists them. */
  async directoryEntries(ids: UserId[]): Promise<DirectoryEntry[]> {
    return (await this.db.all<DirectoryRow>(DIRECTORY_WITH_IDS, JSON.stringify(ids))).map(directoryEntry);
  }

  /**
   * The first page of the active people whose names contain `query`, by name, whom `askerId` can ask:
   * room `roomId`'s members, or anyone's when it's null.
   */
  async mentionable(query: string, roomId: RoomId | null, askerId: UserId): Promise<DirectoryEntry[]> {
    const rows =
      roomId === null ? await this.db.all<DirectoryRow>(MENTIONABLE_PEOPLE, query, askerId) : await this.db.all<DirectoryRow>(MENTIONABLE_MEMBERS, query, roomId, askerId);
    return rows.map(directoryEntry);
  }

  /** Everyone `askerId` is told of, whatever their status, for the people directory. */
  async directory(askerId: UserId): Promise<DirectoryEntry[]> {
    return (await this.db.all<DirectoryRow>(DIRECTORY, askerId)).map(directoryEntry);
  }

  /** Someone as the people directory lists them, whatever their status, or null if nobody has id `userId`. */
  async person(userId: UserId): Promise<DirectoryEntry | null> {
    const [row] = await this.db.all<DirectoryRow>(PERSON, userId);
    return row ? directoryEntry(row) : null;
  }

  /** Someone active, as the people directory lists them, or null unless `userId` is someone active. */
  async activePerson(userId: UserId): Promise<DirectoryEntry | null> {
    const [row] = await this.db.all<DirectoryRow>(ACTIVE_PERSON, userId);
    return row ? directoryEntry(row) : null;
  }

  /** Someone active, or suspended for their membership's lapsing, as the people directory lists them, or null for anyone else: whom removing finds. */
  async removablePerson(userId: UserId): Promise<DirectoryEntry | null> {
    const [row] = await this.db.all<DirectoryRow>(REMOVABLE_PERSON, userId);
    return row ? directoryEntry(row) : null;
  }

  /** Gives someone `role`, recording when. */
  async changeRole(userId: UserId, role: PersonRole, now: string): Promise<void> {
    await this.db.run(CHANGE_ROLE, ROLES.indexOf(role), now, userId);
  }

  /** The active bots, by name, each with its token and its rooms but DMs, read together. */
  async activeBots(): Promise<StoredBot[]> {
    const [bots, rooms] = (await this.db.batch([statement(ACTIVE_BOTS), statement(ACTIVE_BOTS_ROOMS)])) as [BotRow[], Array<BotRoom & { user_id: UserId }>];
    const roomsOf = Map.groupBy(rooms, (room) => room.user_id);
    return bots.map((row) => storedBot(row, (roomsOf.get(row.id) ?? []).map(({ id, name }) => ({ id, name }))));
  }

  /** The active bot `botId`, with its token, whether it's in room `roomId` and its webhook, or null unless it's one. */
  async activeBotKey(botId: UserId, roomId: RoomId): Promise<BotKey | null> {
    const [row] = await this.db.all<User & { bot_token: string | null; webhook_url: string | null; webhook_saved_at: string | null; member: number }>(
      ACTIVE_BOT_KEY,
      roomId,
      botId,
    );
    if (!row) return null;
    const webhook = row.webhook_url === null || row.webhook_saved_at === null ? null : { url: row.webhook_url, savedAt: row.webhook_saved_at };
    return { bot: { id: row.id, name: row.name }, token: row.bot_token, member: row.member === 1, webhook };
  }

  /** Bot `botId`'s webhook as a delivery to it in room `roomId` finds it now, or null unless it's an active bot in the room with one. */
  async botWebhook(roomId: RoomId, botId: UserId): Promise<BotWebhook | null> {
    const [row] = await this.db.all<{ name: string; bot_token: string | null; url: string; updated_at: string }>(BOT_WEBHOOK, roomId, botId);
    return row ? { bot: { id: botId, name: row.name }, token: row.bot_token, url: row.url, savedAt: row.updated_at } : null;
  }

  /**
   * Bot `botId`'s webhook as a delivery to it in room `roomId` finds it now, with who clicked, `clickerId`,
   * and the room's name, or null for a DM's: null unless the bot has one there and whoever clicked is an
   * active member of the room.
   */
  async clickWebhook(roomId: RoomId, botId: UserId, clickerId: UserId): Promise<(BotWebhook & { clicker: User; roomName: string | null }) | null> {
    const [[bot], [clicker]] = (await this.db.batch([statement(BOT_WEBHOOK, roomId, botId), statement(CLICKER, roomId, clickerId)])) as [
      Array<{ name: string; bot_token: string | null; url: string; updated_at: string }>,
      Array<{ name: string; room_name: string | null }>,
    ];
    if (!bot || !clicker) return null;
    return { bot: { id: botId, name: bot.name }, token: bot.bot_token, url: bot.url, savedAt: bot.updated_at, clicker: { id: clickerId, name: clicker.name }, roomName: clicker.room_name };
  }

  /** The active member `userId` of room `roomId`, by their name now, and whether they're an administrator, or null unless they're one. */
  async roomMember(roomId: RoomId, userId: UserId): Promise<{ member: User; administrator: boolean } | null> {
    const [row] = await this.db.all<{ name: string; administrator: number }>(ROOM_MEMBER, roomId, userId);
    return row ? { member: { id: userId, name: row.name }, administrator: row.administrator === 1 } : null;
  }

  /** The active bot `botId`, with its token, its rooms but DMs and where its webhook delivers, or null unless it's one. */
  async activeBot(botId: UserId): Promise<StoredBotSettings | null> {
    const [[row], rooms] = (await this.db.batch([statement(ACTIVE_BOT, botId), statement(BOT_ROOMS, botId)])) as [
      Array<BotRow & { webhook_url: string | null }>,
      BotRoom[],
    ];
    return row ? { ...storedBot(row, rooms), webhookUrl: row.webhook_url } : null;
  }

  /**
   * Adds a bot, with its webhook if it has somewhere to deliver and its avatar if it has one, in every
   * open room, in one batch.
   */
  async createBot({ id, name, token, webhookUrl, avatar }: NewStoredBot, now: string): Promise<void> {
    await this.db.batch([
      statement(INSERT_BOT, id, name, token, avatar?.key ?? null, avatar?.variant ?? null, now, now),
      ...keeping(avatar),
      ...(webhookUrl === null ? [] : [statement(SAVE_WEBHOOK, id, webhookUrl, now)]),
      statement(GRANT_OPEN_ROOMS_TO_USER, id, now, now),
    ]);
  }

  /**
   * Changes a bot, in one batch: its webhook first, which delivers to `webhookUrl`, or goes when that's
   * "", then its name, then its avatar, as `changeAvatar` gives someone theirs. What's left out stays as
   * it is.
   */
  async changeBot(botId: UserId, { name, webhookUrl }: BotChanges, now: string, avatar: AvatarChange | null): Promise<void> {
    await this.db.batch([
      ...(webhookUrl === undefined ? [] : [webhookUrl ? statement(SAVE_WEBHOOK, botId, webhookUrl, now) : statement(`DELETE FROM webhooks WHERE user_id = ?`, botId)]),
      ...(name === undefined ? [] : [statement(RENAME_BOT, name, now, botId)]),
      ...(avatar ? avatarChange(botId, avatar.avatar, avatar.previous, now, avatar.dueAt) : []),
    ]);
  }

  /** Gives a bot a new token, recording when, so its old key no longer works. */
  async changeBotToken(botId: UserId, token: string, now: string): Promise<void> {
    await this.db.run(CHANGE_BOT_TOKEN, token, now, botId);
  }

  /** The active agents, by name, each with the open rooms it's in, if it's kept to the ones picked, read together. */
  async activeAgents(): Promise<StoredAgent[]> {
    const [agents, rooms] = (await this.db.batch([statement(ACTIVE_AGENTS), statement(KEPT_AGENTS_ROOMS)])) as [AgentRow[], Array<AgentRoom & { user_id: UserId }>];
    const roomsOf = Map.groupBy(rooms, (room) => room.user_id);
    return agents.map((row) => storedAgent(row, (roomsOf.get(row.id) ?? []).map(({ id, name }) => ({ id, name }))));
  }

  /** The active agent `agentId` as its page shows it, with the open rooms it's in, or null unless it's one. */
  async activeAgent(agentId: UserId): Promise<StoredAgentSettings | null> {
    const [[row], rooms] = (await this.db.batch([statement(ACTIVE_AGENT, agentId), statement(OPEN_ROOMS_OF, agentId)])) as [AgentSettingsRow[], AgentRoom[]];
    return row ? storedAgentSettings(row, rooms) : null;
  }

  /**
   * The active agents `askerId` can ask, by name, as Available Agents lists them, each with the rooms it
   * shares with them, if it's kept to the open rooms picked, and before them @ember as the people
   * directory lists it, or null while Ember AI is off, read together.
   */
  async availableAgents(askerId: UserId): Promise<{ ember: DirectoryEntry | null; agents: AvailableStoredAgent[] }> {
    const [[ember], agents, rooms] = (await this.db.batch([
      statement(ACTIVE_PERSON, ASSISTANT_ID),
      statement(AVAILABLE_AGENTS, askerId),
      statement(AVAILABLE_AGENTS_ROOMS, askerId),
    ])) as [DirectoryRow[], Array<DirectoryRow & Pick<AgentRow, "description" | "every_open_room">>, Array<AgentRoom & { user_id: UserId }>];
    const roomsOf = Map.groupBy(rooms, (room) => room.user_id);
    return {
      ember: ember ? directoryEntry(ember) : null,
      agents: agents.map((row) => ({
        ...directoryEntry(row),
        description: row.description,
        access: keptForIn(row.agent_access) ?? "everyone",
        rooms: row.every_open_room === 1 ? null : (roomsOf.get(row.id) ?? []).map(({ id, name }) => ({ id, name })),
      })),
    };
  }

  /**
   * Agent `agentId` as a question `askerId` asked it in room `roomId` finds it (`ANSWERING_AGENT`), or null
   * unless it's an active agent there that answers them.
   */
  async answeringAgent(roomId: RoomId, agentId: UserId, askerId: UserId): Promise<AnsweringAgent | null> {
    const [row] = await this.db.all<AnsweringColumns & { name: string; model: string }>(ANSWERING_AGENT, roomId, agentId, askerId);
    return row ? { name: row.name, model: row.model, ...answeringOf(row) } : null;
  }

  /** What agent `agentId`'s page tells everyone of it, whether Ember AI is on or off, or null unless it's an agent. */
  async agentProfile(agentId: UserId): Promise<AgentProfile | null> {
    const [row] = await this.db.all<{ description: string; model: string; model_name: string; created_by: UserId; created_by_name: string }>(AGENT_PROFILE, agentId);
    return row ? { description: row.description, model: row.model, modelName: row.model_name, setUpBy: { id: row.created_by, name: row.created_by_name } } : null;
  }

  /** The models the agents answer with, whether Ember AI is on or off, each with a format an agent asks it in, once each. */
  async agentModels(): Promise<Pick<AssistantModel, "id" | "format">[]> {
    const rows = await this.db.all<{ model: string; format: string }>(`SELECT DISTINCT model, format FROM agents`);
    return rows.map((row) => ({ id: row.model, format: agentsFormatIn(row.format) }));
  }

  /** Every agent, whether Ember AI is on or off, as the people directory lists it. */
  async agentEntries(): Promise<DirectoryEntry[]> {
    return (await this.db.all<DirectoryRow>(AGENTS_LISTED)).map(directoryEntry);
  }

  /** Whether `userId` is an agent's, whether Ember AI is on or off. */
  async isAgent(userId: UserId): Promise<boolean> {
    return (await this.db.all(`SELECT 1 FROM agents WHERE user_id = ?`, userId)).length > 0;
  }

  /**
   * The names of everyone but `userId` who's active, or can be again with the name they have: people,
   * bots and agents active, and people banned, whom lifting the ban lets back, or suspended for their
   * membership's lapsing, whom renewing it does.
   */
  async namesInUse(userId: UserId | null): Promise<string[]> {
    const rows = await this.db.all<{ name: string }>(`SELECT name FROM users WHERE status IN (${ACTIVE}, ${BANNED}, ${SUSPENDED}) AND id IS NOT ?`, userId);
    return rows.map((row) => row.name);
  }

  /**
   * Adds an agent as `agent` has it, in one batch: a bot without a token, so that no key opens anything as
   * it, with its avatar if it has one, whom it's kept for, unless everyone can ask it, what makes it an
   * agent, and its memberships of every open room, or of the open rooms picked, of those there are: of
   * none, for one only administrators' direct messages reach.
   */
  async createAgent({ id, name, avatar, access, rooms: picked, createdBy, ...setup }: NewStoredAgent, now: string): Promise<void> {
    const rooms = access === "admin-dms" ? [] : picked;
    await this.db.batch([
      statement(INSERT_BOT, id, name, null, avatar?.key ?? null, avatar?.variant ?? null, now, now),
      ...(access === "everyone" ? [] : [statement(KEEP_AGENT_FOR, access, id)]),
      ...keeping(avatar),
      statement(INSERT_AGENT, id, ...agentColumns(setup), rooms === null ? 1 : 0, createdBy, now),
      rooms === null ? statement(GRANT_OPEN_ROOMS_TO_USER, id, now, now) : statement(GRANT_PICKED_ROOMS, id, JSON.stringify(rooms), now),
    ]);
  }

  /**
   * Changes agent `agentId` as `change` has it, in one batch: its name, its avatar, as `changeAvatar` gives
   * someone theirs, its setup, recording who changed it, and when, whom it's kept for, and the open rooms
   * it's in: every one, or just the ones picked, keeping the rooms it's in that aren't open, or none at
   * all, private rooms neither, once only administrators' direct messages reach it.
   */
  async changeAgent(agentId: UserId, { name, setup, access, rooms, avatar, changedBy }: StoredAgentChange, now: string): Promise<void> {
    await this.db.batch([
      ...(name === undefined ? [] : [statement(RENAME_BOT, name, now, agentId)]),
      ...(avatar ? avatarChange(agentId, avatar.avatar, avatar.previous, now, avatar.dueAt) : []),
      statement(CHANGE_AGENT, agentId, ...agentColumns(setup), changedBy, now),
      ...(access === undefined ? [] : [statement(KEEP_AGENT_FOR, keptForOf(access), agentId)]),
      ...(access === "admin-dms" ? leaveEveryRoom(agentId) : rooms === undefined ? [] : roomsChange(agentId, rooms, now)),
    ]);
  }

  /**
   * Deletes agent `agentId`, in one batch: forgets what made it an agent and the tools picked for it,
   * takes it out of every room but its DMs, and deactivates it, recording when, as deleting a bot does.
   * Its messages and avatar stay.
   */
  async deleteAgent(agentId: UserId, now: string): Promise<void> {
    await this.db.batch([
      statement(`DELETE FROM agents WHERE user_id = ?`, agentId),
      statement(`DELETE FROM agent_tools WHERE agent_id = ?`, agentId),
      statement(LEAVE_SHARED_ROOMS, agentId),
      statement(`UPDATE users SET status = ${DEACTIVATED}, updated_at = ? WHERE id = ? AND status = ${ACTIVE}`, now, agentId),
    ]);
  }

  /** The tools picked for every agent that has any, @ember among them, by the agents' names: at most one row an agent. */
  async everyAgentsToolPicks(): Promise<AgentToolPicks[]> {
    const rows = await this.db.all<{ agent_id: UserId; name: string | null; tools: string }>(
      `SELECT agent_tools.agent_id, users.name, agent_tools.tools FROM agent_tools LEFT JOIN users ON users.id = agent_tools.agent_id
       ORDER BY users.name COLLATE NOCASE, agent_tools.agent_id`,
    );
    return rows.map(({ agent_id, name, tools }) => ({ agent: { id: agent_id, name: name ?? ASSISTANT_NAME }, picks: JSON.parse(tools) as StoredToolPick[], stored: tools }));
  }

  /** Every connected app, by name, with its sealed token and the tools read from it. */
  async apps(): Promise<StoredApp[]> {
    const rows = await this.db.all<AppRow>(`${APPS} ORDER BY apps.name COLLATE NOCASE, apps.id`);
    return rows.map(storedApp);
  }

  /** The tools picked for the agent `agentId`, @ember or an agent, as they were picked. */
  async toolPicks(agentId: UserId): Promise<StoredToolPick[]> {
    const [row] = await this.db.all<{ tools: string }>(`SELECT tools FROM agent_tools WHERE agent_id = ?`, agentId);
    return row ? (JSON.parse(row.tools) as StoredToolPick[]) : [];
  }

  /** Has `picks` be every tool the agent `agentId` may use, picked by `pickedBy`. */
  async pickTools(agentId: UserId, picks: StoredToolPick[], pickedBy: UserId, now: string): Promise<void> {
    await this.db.run(
      `INSERT INTO agent_tools (agent_id, tools, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET tools = excluded.tools, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      agentId,
      JSON.stringify(picks),
      pickedBy,
      now,
    );
  }

  /** How many apps are connected. */
  async appCount(): Promise<number> {
    const [row] = await this.db.all<{ count: number }>(`SELECT COUNT(*) AS count FROM apps`);
    return row?.count ?? 0;
  }

  /** The connected app `appId`, with its sealed token and the tools read from it, or null unless there's one. */
  async app(appId: AppId): Promise<StoredApp | null> {
    const [row] = await this.db.all<AppRow>(APP, appId);
    return row ? storedApp(row) : null;
  }

  /** Connects `app`, unless as many apps as there can be, `most`, are connected already, answering whether it did. */
  async connectApp(app: NewStoredApp, most: number): Promise<boolean> {
    const { id, name, url, sealedToken, signIn, serverName, tools, toolsLeftOut, connectedBy, now } = app;
    const signedIn = signIn ? [signIn.sealed, connectedBy, now, signIn.client?.id ?? null, signIn.client?.sealed ?? null] : [null, null, null, null, null];
    const [connected] = (await this.db.batch([
      statement(
        `INSERT INTO apps (id, name, url, token, server_name, tools, tools_left_out, tools_read_at, created_by, updated_by, created_at, updated_at, sign_in, signed_in_by, signed_in_at, sign_in_client_id, sign_in_client)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM apps) < ? RETURNING id`,
        ...[id, name, url, sealedToken, serverName, JSON.stringify(tools), toolsLeftOut, now, connectedBy, connectedBy, now, now, ...signedIn, most],
      ),
    ])) as [unknown[]];
    return connected.length > 0;
  }

  /**
   * Keeps a sign-in to the connected app `appId`, made by `signIn.by`, in place of any it had, and of its
   * token, with the client it was made as, if an administrator gave one, what was `read` from its server
   * with it and the agents' `picks` that changes, in one batch, while the app is still asked at `url`:
   * answers whether it was. What its server asked for beyond the last sign-in is forgotten, as this one
   * asked for it.
   */
  async signInToApp(appId: AppId, signIn: NewAppSignIn, { serverName, tools, toolsLeftOut }: StoredAppRead, picks: ChangedPicks[], url: string, now: string): Promise<boolean> {
    const [signedIn] = (await this.db.batch([
      statement(
        `UPDATE apps SET token = NULL, sign_in = ?, signed_in_by = ?, signed_in_at = ?, sign_in_client_id = ?, sign_in_client = ?, scope_wanted = NULL,
           server_name = ?, tools = ?, tools_left_out = ?, tools_read_at = ?, updated_by = ?, updated_at = ?
         WHERE id = ? AND url = ? RETURNING id`,
        ...[signIn.sealed, signIn.by, now, signIn.client?.id ?? null, signIn.client?.sealed ?? null, serverName, JSON.stringify(tools), toolsLeftOut, now, signIn.by, now, appId, url],
      ),
      ...picks.map(({ agentId, stored, picks: changed }) =>
        statement(
          `UPDATE agent_tools SET tools = ? WHERE agent_id = ? AND tools = ? AND EXISTS (SELECT 1 FROM apps WHERE id = ? AND url = ? AND sign_in = ?)`,
          ...[JSON.stringify(changed), agentId, stored, appId, url, signIn.sealed],
        ),
      ),
    ])) as [unknown[]];
    return signedIn.length > 0;
  }

  /**
   * Has the sign-in the connected app `appId` keeps be `sealed`, with the tokens its authorization
   * server gave in place of the last, or null once it has ended, while it's still the one that was
   * asked with, `was`: answers whether it was.
   */
  async keepAppSignIn(appId: AppId, sealed: string | null, was: string): Promise<boolean> {
    const [kept] = (await this.db.batch([statement(`UPDATE apps SET sign_in = ? WHERE id = ? AND sign_in = ? RETURNING id`, sealed, appId, was)])) as [unknown[]];
    return kept.length > 0;
  }

  /** Keeps `scope`, what the server of the connected app `appId` has asked for beyond Ember's sign-in to it, while that's still the one made at `signedInAt`. */
  async keepAppScopeWanted(appId: AppId, scope: string, signedInAt: string): Promise<void> {
    await this.db.batch([statement(`UPDATE apps SET scope_wanted = ? WHERE id = ? AND signed_in_at = ?`, scope, appId, signedInAt)]);
  }

  /**
   * Keeps `pending`, a sign-in under way, until `expiresAt`, forgetting those that have expired by
   * `now`, and the ones of its kind begun longest ago once there are more than Ember keeps. One that's
   * someone's `own` takes the place of any other of theirs that was under way.
   */
  async beginAppSignIn({ state, userId, appId, name, url, sealedSignIn, own }: PendingAppSignIn, expiresAt: string, now: string): Promise<void> {
    const kind = own ? 1 : 0;
    await this.db.batch([
      own ? statement(`DELETE FROM app_sign_ins WHERE expires_at <= ? OR (own = 1 AND user_id = ?)`, now, userId) : statement(`DELETE FROM app_sign_ins WHERE expires_at <= ?`, now),
      statement(
        `INSERT INTO app_sign_ins (state, user_id, app_id, name, url, sign_in, expires_at, own) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ...[state, userId, appId, name, url, sealedSignIn, expiresAt, kind],
      ),
      statement(
        `DELETE FROM app_sign_ins WHERE own = ?1 AND state NOT IN (SELECT state FROM app_sign_ins WHERE own = ?1 ORDER BY expires_at DESC, state LIMIT ?2)`,
        ...[kind, own ? MAX_PENDING_OWN_APP_SIGN_INS : MAX_PENDING_APP_SIGN_INS],
      ),
    ]);
  }

  /** Takes the sign-in under way that `userId` began and whose browser came back with `state`, if it hasn't expired by `now`: it's finished once. */
  async takeAppSignIn(state: string, userId: UserId, now: string): Promise<PendingAppSignIn | null> {
    const [taken] = (await this.db.batch([
      statement(`DELETE FROM app_sign_ins WHERE state = ? AND user_id = ? AND expires_at > ? RETURNING app_id, name, url, sign_in, own`, state, userId, now),
    ])) as [Array<{ app_id: AppId | null; name: string; url: string; sign_in: string; own: number }>];
    const row = taken[0];
    return row ? { state, userId, appId: row.app_id, name: row.name, url: row.url, sealedSignIn: row.sign_in, own: row.own === 1 } : null;
  }

  /** Whether the sign-in under way that `userId` began, and whose browser came back with `state`, is their own, or null when there's none that hasn't expired by `now`. */
  async isOwnAppSignIn(state: string, userId: UserId, now: string): Promise<boolean | null> {
    const [row] = await this.db.all<{ own: number }>(`SELECT own FROM app_sign_ins WHERE state = ? AND user_id = ? AND expires_at > ?`, state, userId, now);
    return row ? row.own === 1 : null;
  }

  /** The connected apps Ember signs in to, by name, each with the sign-in `userId` has made to it themselves, if they have. */
  async ownAppSignIns(userId: UserId): Promise<OwnAppSignIn[]> {
    return (await this.db.all<OwnAppSignInRow>(`${OWN_APP_SIGN_INS} ORDER BY lower(apps.name), apps.id`, userId)).map(ownAppSignIn);
  }

  /** The connected app `appId`, if Ember signs in to it, with the sign-in `userId` has made to it themselves, if they have, or null for any other app. */
  async ownAppSignIn(appId: AppId, userId: UserId): Promise<OwnAppSignIn | null> {
    const [row] = await this.db.all<OwnAppSignInRow>(`${OWN_APP_SIGN_INS} AND apps.id = ?`, userId, appId);
    return row ? ownAppSignIn(row) : null;
  }

  /**
   * Keeps `sealed`, the sign-in `userId` made to the connected app `appId` themselves, in place of any
   * they had, and forgets what its server asked for beyond that one, while the app is still asked at
   * `url` and is one Ember signs in to: answers whether it was.
   */
  async signInToAppAsSelf(appId: AppId, userId: UserId, sealed: string, url: string, now: string): Promise<boolean> {
    const [signedIn] = (await this.db.batch([
      statement(
        `INSERT INTO own_app_sign_ins (app_id, user_id, sign_in, signed_in_at)
         SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM apps WHERE id = ?1 AND url = ?5 AND signed_in_at IS NOT NULL)
         ON CONFLICT (app_id, user_id) DO UPDATE SET sign_in = excluded.sign_in, signed_in_at = excluded.signed_in_at, scope_wanted = NULL RETURNING app_id`,
        ...[appId, userId, sealed, now, url],
      ),
    ])) as [unknown[]];
    return signedIn.length > 0;
  }

  /**
   * Has the sign-in `userId` keeps to the connected app `appId` be `sealed`, with the tokens its
   * authorization server gave in place of the last, or null once it has ended, while it's still the
   * one that was asked with, `was`: answers whether it was.
   */
  async keepOwnAppSignIn(appId: AppId, userId: UserId, sealed: string | null, was: string): Promise<boolean> {
    const [kept] = (await this.db.batch([
      statement(`UPDATE own_app_sign_ins SET sign_in = ? WHERE app_id = ? AND user_id = ? AND sign_in = ? RETURNING app_id`, sealed, appId, userId, was),
    ])) as [unknown[]];
    return kept.length > 0;
  }

  /** Keeps `scope`, what the server of the connected app `appId` has asked for beyond the sign-in `userId` made to it themselves, while that's still the one made at `signedInAt`. */
  async keepOwnAppScopeWanted(appId: AppId, userId: UserId, scope: string, signedInAt: string): Promise<void> {
    await this.db.batch([statement(`UPDATE own_app_sign_ins SET scope_wanted = ? WHERE app_id = ? AND user_id = ? AND signed_in_at = ?`, scope, appId, userId, signedInAt)]);
  }

  /** Forgets the sign-in `userId` made to the connected app `appId` themselves, answering it, sealed, or null once it had ended, or undefined when they had none. */
  async forgetOwnAppSignIn(appId: AppId, userId: UserId): Promise<string | null | undefined> {
    const [forgotten] = (await this.db.batch([statement(`DELETE FROM own_app_sign_ins WHERE app_id = ? AND user_id = ? RETURNING sign_in`, appId, userId)])) as [Array<{ sign_in: string | null }>];
    return forgotten[0] ? forgotten[0].sign_in : undefined;
  }

  /**
   * Changes the connected app `appId` as `change` has it, by `changedBy`: its name, its server's address
   * and its sealed token, null for none, each kept when left out, and what was read from its server
   * again, if it was, with the agents' picks that changes, in the same batch.
   */
  async changeApp(appId: AppId, { name, url, sealedToken, read, picks = [], changedBy, now }: AppChange): Promise<void> {
    const statements = [
      statement(`UPDATE apps SET name = COALESCE(?, name), url = COALESCE(?, url), updated_by = ?, updated_at = ? WHERE id = ?`, name ?? null, url ?? null, changedBy, now, appId),
    ];
    if (sealedToken !== undefined) statements.push(statement(`UPDATE apps SET token = ? WHERE id = ?`, sealedToken, appId));
    if (read) {
      const { serverName, tools, toolsLeftOut } = read;
      statements.push(statement(`UPDATE apps SET server_name = ?, tools = ?, tools_left_out = ?, tools_read_at = ? WHERE id = ?`, serverName, JSON.stringify(tools), toolsLeftOut, now, appId));
      for (const { agentId, stored, picks: changed } of picks) {
        statements.push(statement(`UPDATE agent_tools SET tools = ? WHERE agent_id = ? AND tools = ?`, JSON.stringify(changed), agentId, stored));
      }
    }
    await this.db.batch(statements);
  }

  /**
   * Keeps what was read from the server of the app `appId` again, with the agents' `picks` that
   * changes, in one batch, while it's still asked at `url` with `sealedToken`, signed in to when it
   * was, if it was, changing nothing else of it.
   */
  async keepAppRead(
    appId: AppId,
    { serverName, tools, toolsLeftOut }: StoredAppRead,
    picks: ChangedPicks[],
    { url, sealedToken, signedInAt }: { url: string; sealedToken: string | null; signedInAt: string | null },
    now: string,
  ): Promise<void> {
    const asked = [appId, url, sealedToken, signedInAt];
    await this.db.batch([
      statement(
        `UPDATE apps SET server_name = ?, tools = ?, tools_left_out = ?, tools_read_at = ? WHERE id = ? AND url = ? AND token IS ? AND signed_in_at IS ?`,
        ...[serverName, JSON.stringify(tools), toolsLeftOut, now, ...asked],
      ),
      ...picks.map(({ agentId, stored, picks: changed }) =>
        statement(
          `UPDATE agent_tools SET tools = ? WHERE agent_id = ? AND tools = ? AND EXISTS (SELECT 1 FROM apps WHERE id = ? AND url = ? AND token IS ? AND signed_in_at IS ?)`,
          ...[JSON.stringify(changed), agentId, stored, ...asked],
        ),
      ),
    ]);
  }

  /**
   * Disconnects the app `appId`, forgetting any sign-in to it that's under way, and the ones people
   * made to it themselves: answers where its server was, the sign-in Ember kept to it, sealed, if it
   * kept one, and those people kept, each sealed, with whose it was, or null when there's no such app.
   */
  async disconnectApp(appId: AppId): Promise<(Pick<StoredApp, "url" | "sealedSignIn"> & { own: Array<{ userId: UserId; sealed: string }> }) | null> {
    const [disconnected, , own] = (await this.db.batch([
      statement(`DELETE FROM apps WHERE id = ? RETURNING url, sign_in`, appId),
      statement(`DELETE FROM app_sign_ins WHERE app_id = ?`, appId),
      statement(`DELETE FROM own_app_sign_ins WHERE app_id = ? RETURNING user_id, sign_in`, appId),
    ])) as [Array<Pick<AppRow, "url" | "sign_in">>, unknown[], Array<{ user_id: UserId; sign_in: string | null }>];
    if (!disconnected[0]) return null;
    const kept = own.flatMap(({ user_id: userId, sign_in: sealed }) => (sealed === null ? [] : [{ userId, sealed }]));
    return { url: disconnected[0].url, sealedSignIn: disconnected[0].sign_in, own: kept };
  }

  /**
   * Turns Ember AI on as `assistant` has it, or changes it while it's on, in one batch: saves it in the
   * account's settings, recording when, adds @ember, or lets it back as it was, and puts it in every open
   * room, as someone who joins is, and lets every agent back, in every open room, or the ones picked it
   * was in when Ember AI was turned off, of those still open.
   */
  async turnOnAssistant(assistant: SavedAssistant, now: string): Promise<void> {
    await this.db.batch([
      statement(SET_ASSISTANT, assistantSetting(assistant), now),
      statement(ACTIVATE_ASSISTANT, ASSISTANT_ID, ASSISTANT_NAME, now),
      statement(GRANT_OPEN_ROOMS_TO_USER, ASSISTANT_ID, now, now),
      // The agents come back as they were when it was turned off, and while it's on, these change nothing.
      statement(ACTIVATE_AGENTS, now),
      statement(RESTORE_AGENTS_ROOMS, now),
      statement(GRANT_OPEN_ROOMS_TO_AGENTS, now),
      statement(`UPDATE agents SET kept_rooms = NULL WHERE kept_rooms IS NOT NULL`),
    ]);
  }

  /**
   * Turns Ember AI off, in one batch: forgets how it asked AI Gateway, recording when, and deactivates
   * @ember as removing someone does, taking it out of every room but its DMs. It has no sessions to end,
   * nor an email address to free. Its messages stay. Every agent goes the same way, its setup kept, and
   * with it the open rooms it's in, if it's kept to the ones picked.
   */
  async turnOffAssistant(now: string): Promise<void> {
    await this.db.batch([
      statement(SET_ASSISTANT, assistantSetting(null), now),
      statement(LEAVE_SHARED_ROOMS, ASSISTANT_ID),
      statement(`UPDATE users SET status = ${DEACTIVATED}, updated_at = ? WHERE id = ? AND status = ${ACTIVE}`, now, ASSISTANT_ID),
      // Before they leave the rooms it keeps.
      statement(KEEP_AGENTS_ROOMS),
      statement(AGENTS_LEAVE_SHARED_ROOMS),
      statement(DEACTIVATE_AGENTS, now),
    ]);
  }

  /** Someone with their email address, whatever their status, or null if nobody has id `userId`. */
  async personWithProfile(userId: UserId): Promise<ProfileEntry | null> {
    const [row] = await this.db.all<DirectoryRow & { email_address: string | null }>(PERSON_WITH_PROFILE, userId);
    return row ? { ...directoryEntry(row), emailAddress: row.email_address } : null;
  }

  /**
   * Saves someone's profile, and a new password when `passwordDigest` is one's, recording when. With a
   * new password, in the same transaction it ends the sessions and forgets the push subscriptions
   * `ended` says, queuing closing those sessions' sockets, and forgets the accounts elsewhere their old
   * password started connecting, or connected, if they had one and keep an email address to sign in
   * with (`UNLINK_ON_NEW_PASSWORD`). Answers whether it queued any.
   */
  async changeProfile(userId: UserId, { name, emailAddress, bio, passwordDigest }: ProfileChange, now: string, ended: EndedByPassword | null): Promise<boolean> {
    const change = statement(CHANGE_PROFILE, name, emailAddress, bio, passwordDigest, now, userId);
    if (!ended) {
      await this.db.batch([change]);
      return false;
    }
    const [queued] = await this.db.batch([
      // Before their sessions go, which it finds their sockets by.
      statement(QUEUE_OTHER_SESSION_REVOCATIONS, SESSION_TAG_PREFIX, ended.code, ended.dueAt, userId, ended.kept),
      statement(`DELETE FROM sessions WHERE user_id = ? AND id <> ?`, userId, ended.kept),
      statement(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint IS NOT ?`, userId, ended.pushEndpoint),
      statement(`DELETE FROM pending_identities WHERE user_id = ?`, userId),
      statement(UNLINK_ON_NEW_PASSWORD, userId, emailAddress),
      change,
    ]);
    return queued!.length > 0;
  }

  /** What whoever has id `userId` signs in with, whatever their status, or null if nobody does. */
  async signInOf(userId: UserId): Promise<StoredSignIn | null> {
    const [row] = await this.db.all<{ email_address: string | null; password_digest: string | null }>(
      `SELECT email_address, password_digest FROM users WHERE id = ?`,
      userId,
    );
    return row ? { emailAddress: row.email_address, passwordDigest: row.password_digest || null } : null;
  }

  /** What the avatar of whoever has id `userId` is drawn from, whatever their status, or null if nobody does. */
  async avatarOwner(userId: UserId): Promise<AvatarOwner | null> {
    const [row] = await this.db.all<{ name: string; role: number; agent_access: string | null } & AvatarColumns>(
      `SELECT name, role, avatar_key, avatar_variant, agent_access FROM users WHERE id = ?`,
      userId,
    );
    return row ? { name: row.name, bot: ROLES[row.role] === "bot", avatar: avatarOf(row), keptFor: keptForIn(row.agent_access) } : null;
  }

  /** Someone with the avatar they've uploaded, or a bot was given, whatever their status, or null if nobody has id `userId`. */
  async personWithAvatar(userId: UserId): Promise<PicturedEntry | null> {
    const [row] = await this.db.all<DirectoryRow & AvatarColumns>(PERSON_WITH_AVATAR, userId);
    return row ? { ...directoryEntry(row), avatar: avatarOf(row) } : null;
  }

  /** Someone with their profile and the avatar they've uploaded, whatever their status, or null if nobody has id `userId`. */
  async ownProfile(userId: UserId): Promise<OwnProfileEntry | null> {
    const [row] = await this.db.all<DirectoryRow & AvatarColumns & PickColumns & { email_address: string | null; password: number; membership_needed: number; accounts: string }>(
      OWN_PROFILE,
      userId,
    );
    if (!row) return null;
    const accounts = JSON.parse(row.accounts) as LinkedAccount[];
    const membershipNeeded = row.membership_needed === 1;
    return { ...directoryEntry(row), emailAddress: row.email_address, avatar: avatarOf(row), password: row.password === 1, membershipNeeded, accounts, picks: assistantPicksOf(row) };
  }

  /** How much `userId` picked for @ember to think, how long its answers to them are and the model it answers them with, or null for nobody. */
  async assistantPicks(userId: UserId): Promise<AssistantPicks | null> {
    const [row] = await this.db.all<PickColumns>(ASSISTANT_PICKS, userId);
    return row ? assistantPicksOf(row) : null;
  }

  /** Changes what `userId` picks of @ember's dials and its model to `changes`, keeping what they leave out. */
  async changeAssistantPicks(userId: UserId, changes: YourAssistantChanges): Promise<void> {
    await this.db.run(CHANGE_ASSISTANT_PICKS, changes.thinking ?? null, changes.length ?? null, changes.model === undefined ? 0 : 1, changes.model ?? null, userId);
  }

  /**
   * Changes Ember AI while it's on to `assistant`, the most each of @ember's dials goes to for anyone's
   * questions to `most`, what Ember adds to @ember's instructions to `instructions`, and what it adds
   * around them to `promptTemplate`, null for its own, in one batch, without recording when, as no page's
   * address goes by any of them.
   */
  async changeAssistant(assistant: SavedAssistant, most: AnswerLevels, instructions: string, promptTemplate: string | null): Promise<void> {
    await this.db.batch([
      statement(REMEMBER_ASSISTANT, assistantSetting(assistant)),
      statement(REMEMBER_ASSISTANT_LIMITS, JSON.stringify(most)),
      statement(REMEMBER_ASSISTANT_INSTRUCTIONS, JSON.stringify(instructions)),
      statement(REMEMBER_ASSISTANT_PROMPT_TEMPLATE, JSON.stringify(promptTemplate)),
    ]);
  }

  /**
   * Saves Ember AI as `assistant` has it, without recording when, and has each agent whose model and
   * format a move of `moves` names asked as the move says, in one batch.
   */
  async moveModels(assistant: SavedAssistant, moves: readonly MovedModel[]): Promise<void> {
    await this.db.batch([
      statement(REMEMBER_ASSISTANT, assistantSetting(assistant)),
      ...moves.map(({ id, from, format, thinkingLevels }) => statement(MOVE_AGENTS_MODEL, format, JSON.stringify(thinkingLevels), id, from)),
    ]);
  }

  /**
   * Gives someone `avatar`, which R2 has stored under a key reserved for it, or takes theirs away with
   * null, recording when, and queues R2 deleting the one they had, `previous`, at `dueAt`.
   */
  async changeAvatar(userId: UserId, avatar: StoredPicture | null, previous: string | null, now: string, dueAt: number): Promise<void> {
    await this.db.batch(avatarChange(userId, avatar, previous, now, dueAt));
  }

  /**
   * Gives the workspace `logo`, which R2 has stored under a key reserved for it, or takes its logo away
   * with null, recording when, and queues R2 deleting the one it had, `previous`, at `dueAt`.
   */
  async changeLogo(logo: StoredPicture | null, previous: string | null, now: string, dueAt: number): Promise<void> {
    await this.db.batch([
      statement(CHANGE_LOGO, logo?.key ?? null, logo?.variant ?? null, now),
      ...keeping(logo),
      ...(previous ? [statement(QUEUE_PICTURE_DELETION, previous, dueAt)] : []),
    ]);
  }

  /**
   * Reserves `key` for a picture R2 is about to store, until `dueAt`, when R2 deletes whatever is there
   * unless someone or the workspace has been given the picture by then.
   */
  async reservePicture(key: string, dueAt: number): Promise<void> {
    await this.db.run(QUEUE_PICTURE_DELETION, key, dueAt);
  }

  /** Up to `limit` of the keys due by `now` whose pictures R2 is to delete, those due longest first. */
  async duePictureDeletions(now: number, limit: number): Promise<string[]> {
    const rows = await this.db.all<{ object_key: string }>(
      `SELECT object_key FROM pending_picture_deletions WHERE due_at <= ? ORDER BY due_at, object_key LIMIT ?`,
      now,
      limit,
    );
    return rows.map((row) => row.object_key);
  }

  /**
   * Forgets the pictures `deleted` names, and puts off the ones `failed` names, each for twice as long as
   * the time before, up to the longest wait. It never gives one up, which would leave the picture in R2.
   */
  async settlePictureDeletions(deleted: string[], failed: string[], now: number): Promise<void> {
    await this.db.batch([
      statement(`DELETE FROM pending_picture_deletions WHERE object_key IN (SELECT value FROM json_each(?))`, JSON.stringify(deleted)),
      // As a purge's wait.
      statement(
        `UPDATE pending_picture_deletions SET attempts = attempts + 1, due_at = ? + min(?, ? << min(attempts, ?)) WHERE object_key IN (SELECT value FROM json_each(?))`,
        now,
        LONGEST_RETRY_MS,
        FIRST_RETRY_MS,
        RETRY_DOUBLINGS,
        JSON.stringify(failed),
      ),
    ]);
  }

  /** Room `roomId`, unless it's a DM or someone isn't in it, and whether they can change it. */
  async roomToChange(roomId: RoomId, userId: UserId): Promise<{ room: SharedRoom; canAdminister: boolean } | null> {
    const [row] = await this.db.all<RoomToChangeRow>(ROOM_TO_CHANGE, roomId, userId);
    return row ? roomToChange(row) : null;
  }

  /** The same, with everyone active who can be put in a room and whether they're in it, read together. */
  async roomSettings(roomId: RoomId, userId: UserId): Promise<RoomSettings | null> {
    const [[row], people] = (await this.db.batch([statement(ROOM_TO_CHANGE, roomId, userId), statement(ACTIVE_PEOPLE_IN_ROOM, roomId)])) as [
      RoomToChangeRow[],
      Array<User & { member: number }>,
    ];
    return row ? { ...roomToChange(row), people: people.map((person) => ({ ...person, member: person.member === 1 })) } : null;
  }

  /**
   * Makes `changes` to a room in one transaction: renames it, and makes it open to everyone active, or
   * private to just the people `memberIds` names, taking anyone else out but those suspended in a room
   * that was private already, whom its settings don't list, and queueing closing their sockets there
   * with `code`, due at `dueAt`. Answers what it changed, who's in the room then, and whether the shared
   * order ranks it.
   */
  async changeRoom(roomId: RoomId, changes: RoomChanges, code: CloseCode, dueAt: number, now: string): Promise<SavedRoomChange> {
    const update = statement(UPDATE_ROOM, changes.name ?? null, changes.kind ?? null, changes.icon ?? null, now, roomId);
    const members = statement(ROOM_MEMBERS, roomId);
    const ranked = statement(ROOM_RANKED, roomId);
    if (changes.kind === "open") {
      const grant = statement(GRANT_ROOM_TO_ACTIVE_USERS, roomId, now, now);
      const [updated, added, after, rank] = (await this.db.batch([update, grant, members, ranked])) as UserIdRow[][];
      return { roomChanged: updated!.length > 0, memberIds: userIdsOf(after!), addedIds: userIdsOf(added!), removedIds: [], ranked: isRanked(rank!) };
    }
    if (changes.kind !== "closed") {
      const [updated, after] = (await this.db.batch([update, members])) as UserIdRow[][];
      // Nobody new is in it, so nobody's sidebar has left it out.
      return { roomChanged: updated!.length > 0, memberIds: userIdsOf(after!), addedIds: [], removedIds: [], ranked: false };
    }
    const memberIds = JSON.stringify(changes.memberIds);
    // Whom it takes out is read before the room's kind changes, which says whether anyone suspended stays.
    const [, removed, updated, added, after, rank] = (await this.db.batch([
      statement(QUEUE_MEMBER_REVOCATIONS, code, dueAt, roomId, memberIds),
      statement(REVOKE_ROOM_FROM_OTHERS, roomId, memberIds),
      update,
      statement(GRANT_ROOM_TO_USERS, roomId, now, now, memberIds),
      members,
      ranked,
    ])) as UserIdRow[][];
    return {
      roomChanged: updated!.length > 0,
      memberIds: userIdsOf(after!),
      addedIds: userIdsOf(added!),
      removedIds: userIdsOf(removed!),
      ranked: isRanked(rank!),
    };
  }

  /** Whether anyone but `userId` who could open room `roomId` is in it. */
  async anotherPersonInRoom(roomId: RoomId, userId: UserId): Promise<boolean> {
    const [row] = await this.db.all<{ found: number }>(ANOTHER_PERSON_IN_ROOM, roomId, userId);
    return row!.found === 1;
  }

  /** Takes someone out of a room, and in the same transaction queues closing their sockets there with `code`, due at `dueAt`. */
  async leaveRoom(roomId: RoomId, userId: UserId, code: CloseCode, dueAt: number): Promise<void> {
    await this.db.batch([
      statement(`INSERT INTO pending_revocations (room_id, tag, code, due_at) VALUES (?, ?, ?, ?)`, roomId, userId, code, dueAt),
      statement(`DELETE FROM memberships WHERE room_id = ? AND user_id = ?`, roomId, userId),
    ]);
  }

  /** The kind of room `roomId`, DMs included, and whether someone can change it, unless they aren't in it. */
  async roomToDelete(roomId: RoomId, userId: UserId): Promise<{ kind: SidebarRoom["kind"]; canAdminister: boolean } | null> {
    const [row] = await this.db.all<{ kind: SidebarRoom["kind"]; can_administer: number }>(ROOM_TO_DELETE, roomId, userId);
    return row ? { kind: row.kind, canAdminister: row.can_administer === 1 } : null;
  }

  /**
   * Deletes a room and who is in it, and in the same transaction queues closing every socket in it with
   * `code`, due at `dueAt`, in place of whatever else the outbox had for it. The room's own object
   * deletes its messages when that reaches it. The room is remembered as deleted, so registering
   * `LEGACY_ROOMS` doesn't bring it back. Answers who was in it.
   */
  async deleteRoom(roomId: RoomId, code: CloseCode, dueAt: number, now: string): Promise<UserId[]> {
    const [, , members] = (await this.db.batch([
      // Queued before the rest go, so it takes an id none of them had: SQLite numbers a row after the
      // largest id left, and the alarm settles what it delivered by id, so taking the id of one it's
      // delivering now would settle the deletion with it.
      statement(`INSERT INTO pending_revocations (room_id, tag, code, due_at) VALUES (?, ?, ?, ?)`, roomId, EVERYONE, code, dueAt),
      statement(`DELETE FROM pending_revocations WHERE room_id = ? AND tag <> ?`, roomId, EVERYONE),
      statement(`DELETE FROM memberships WHERE room_id = ? RETURNING user_id`, roomId),
      // Its messages all go, a banned person's with them, and the search index forgets them.
      statement(`DELETE FROM pending_purges WHERE room_id = ?`, roomId),
      statement(`DELETE FROM pending_reindexes WHERE room_id = ?`, roomId),
      statement(`DELETE FROM rooms WHERE id = ?`, roomId),
      statement(`INSERT INTO deleted_rooms (id, deleted_at) VALUES (?, ?) ON CONFLICT DO NOTHING`, roomId, now),
    ])) as UserIdRow[][];
    return userIdsOf(members!);
  }

  /**
   * Adds a room and its people: everyone active for an open room, or just `memberIds` for a closed one.
   * Answers who's in it.
   */
  async createRoom(room: SharedRoom, creatorId: UserId, memberIds: UserId[] | null, now: string): Promise<UserId[]> {
    const [, members] = (await this.db.batch([
      statement(
        `INSERT INTO rooms (id, kind, name, icon, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        room.id,
        room.kind,
        room.name,
        room.icon,
        creatorId,
        now,
        now,
      ),
      memberIds ? statement(GRANT_ROOM_TO_USERS, room.id, now, now, JSON.stringify(memberIds)) : statement(GRANT_ROOM_TO_ACTIVE_USERS, room.id, now, now),
    ])) as UserIdRow[][];
    return userIdsOf(members!);
  }

  /**
   * The DM whose people are exactly the ones `memberIds` names, who all exist, adding it as `roomId`,
   * made by `creatorId`, if they have none, in one transaction. Answers it, and whether it added it.
   */
  async startDirect(roomId: RoomId, creatorId: UserId, memberIds: UserId[], now: string): Promise<{ room: DirectRoom; started: boolean }> {
    const key = directKey(memberIds);
    const [added, , members] = (await this.db.batch([
      statement(INSERT_DIRECT, roomId, creatorId, key, now),
      statement(GRANT_DIRECT, roomId, now, key),
      statement(DIRECT_WITH_KEY, key),
    ])) as [unknown[], unknown[], KeyedDirectMemberRow[]];
    const [{ room_id: id, active_at: activeAt }] = members as [KeyedDirectMemberRow];
    return { room: { id, kind: "direct", members: membersOf(members), activeAt }, started: added!.length > 0 };
  }

  /** Of the rooms `ids` names, the ones that aren't registered yet and were never deleted. The ids go as one JSON value. */
  async unregisteredRooms(ids: RoomId[]): Promise<RoomId[]> {
    const rows = await this.db.all<{ id: RoomId }>(UNREGISTERED_ROOMS, JSON.stringify(ids));
    return rows.map((row) => row.id);
  }

  /**
   * Registers a room from before the Workspace kept a list as an open room everyone is in, named for
   * its old address, keeps the people who wrote or reacted in it as deactivated guests, and queues having
   * the search index take its messages.
   */
  async registerLegacyRoom(id: RoomId, authors: User[], now: string): Promise<void> {
    await this.db.batch([
      statement(INSERT_FORMER_GUESTS, now, now, JSON.stringify(authors)),
      statement(`INSERT INTO rooms (id, kind, name, created_at, updated_at) VALUES (?, 'open', ?, ?, ?) ON CONFLICT DO NOTHING`, id, id, now, now),
      statement(GRANT_ROOM_TO_ACTIVE_USERS, id, now, now),
      statement(`INSERT INTO pending_reindexes (room_id, due_at) VALUES (?, 0) ON CONFLICT DO NOTHING`, id),
    ]);
  }
}
