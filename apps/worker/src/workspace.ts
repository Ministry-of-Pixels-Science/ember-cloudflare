import { DurableObject } from "cloudflare:workers";
import {
  ASSISTANT_ID,
  ASSISTANT_NAME,
  CANT_SEND_EMAIL,
  CloseCode,
  domainOfEmailAddress,
  EMAILS_PER_ADDRESS,
  EMAIL_LINKS_PER_NETWORK,
  emailSignUpLink,
  INVITATION_DAYS,
  invitationLink,
  isReservedName,
  isRoomId,
  mailboxOf,
  mailboxUnder,
  NAVIGATION_SLOTS,
  othersAfterMove,
  parseWorkspaceClientFrame,
  PASSWORD_RESET_CODE_MINUTES,
  PASSWORD_RESETS_PER_NETWORK,
  sameName,
  SIGN_UPS_PER_ADDRESS,
  SIGN_UPS_PER_HOUR,
  signsUpOpenly,
  signsUpWithEmailDomain,
  withNavigationIcons,
  type Account,
  type AccountChanges,
  type AccountSettings,
  type AssistantSettings,
  type Bot,
  type BotChanges,
  type BotSettings,
  type CustomStyles,
  type DirectoryUser,
  type DirectRoom,
  type EmailInvitation,
  type EmailLinkFor,
  type EmailLinkKind,
  type EmailSettings,
  type Favorites,
  type HuddlesSettings,
  type LiveHuddle,
  type Mailbox,
  type Invited,
  type Involvement,
  type Me,
  type NavigationIconChanges,
  type NavigationIcons,
  type NewBot,
  type NewJoinCode,
  type NewRoom,
  type NewRoomForm,
  type NewWorkspace,
  type PersonRole,
  type Profile,
  type ProfileChanges,
  type PushSubscriptionSave,
  type ResentInvitation,
  type Room,
  type RoomChanges,
  type RoomId,
  type RoomSettings,
  type Search,
  type SentTestEmail,
  type SharedRoom,
  type Sidebar,
  type SidebarRoom,
  type User,
  type UserId,
  type UserStatus,
  type WorkspaceServerFrame,
  type WorkspaceSettings,
} from "@ember/protocol";
import { MAX_OUTSIDE_CONNECTIONS, outsideScopesOf, type OutsideAiSettings, type OutsideConnection, type OutsideScope } from "@ember/protocol/outside";
import {
  ASSISTANT_MODELS,
  DEFAULT_LEVELS,
  isWorkersAiModel,
  MAX_ASSISTANT_MODELS,
  modelName,
  offeredModelOf,
  searchFormatOf,
  TOP_LEVELS,
  webToolsOf,
  withinMost,
  type AnswerLevels,
  type AssistantChanges,
  type ModelFormat,
  type OfferedModel,
  type ThinkingLevel,
  type WebTool,
  type YourAssistant,
  type YourAssistantChanges,
} from "@ember/protocol/assistant";
import { EMBER_DOES, MAX_AGENTS, type Agent, type AgentChanges, type AgentProfile, type AgentRoom, type AgentSettings, type AvailableAgent, type NewAgent } from "@ember/protocol/agents";
import {
  MAX_APP_SCOPE_LENGTH,
  MAX_APPS,
  type App,
  type AppChanges,
  type AppId,
  type AppSummary,
  type NewApp,
  type OfferedApp,
  type SetAsideTool,
  type ToolPick,
  type YourApp,
  type YourAppSignedOut,
} from "@ember/protocol/apps";
import type { MemberfulKeysChange, MemberfulSaved } from "@ember/protocol/memberful";
import type { Gateway } from "./assistant/gateway";
import { modelsFileUrlOf, type KeptModelsFile, type KeptWorkersAiModels } from "./assistant/offered";
import { providerMovesOf } from "./assistant/model-tests";
import { eachAtMost, ROOMS_AT_ONCE } from "./at-once";
import { directoryOf, TooSoon, tooSoonAfter, versionOf } from "./avatar-tokens";
import { banProblem, type BanProblem } from "./bans";
import { botKeyOf, isBotToken, newBotToken, webhookTokenOf } from "./bots/keys";
import { openDb, type Db } from "./db";
import { alreadyAMemberEmail, emailDomainLinkEmail, invitationEmail, passwordResetCodeEmail, testEmail } from "./emails";
import { guestSignIn, type Env } from "./env";
import { pictureObjects, type StoredPicture } from "./files/pictures";
import type { RelayKey } from "./huddles/relay";
import type { HuddleApp, SfuApp } from "./huddles/sfu";
import { alphanumeric, sortableId } from "./ids";
import { sendEmail, sendEmails, senderOf, type Sender } from "./mail";
import {
  deployedMemberfulOf,
  memberfulApiOf,
  memberfulWebhooksOf,
  membershipsOf,
  namelessMember,
  openMemberfulSecrets,
  sealMemberfulSecrets,
  type MemberfulApi,
  type MemberfulMember,
  type MemberfulSetup,
} from "./memberful-api";
import { webPush } from "./push/keys";
import { FixedWindowLimit } from "./rate-limit";
import { sessionTag } from "./revocations";
import type { RoomEvent } from "./room-log";
import { appConnector } from "./apps/connector";
import { ACCESS_TTL_SECONDS, CODE_TTL_MS, provesChallenge, REFRESH_TTL_MS } from "./outside/oauth";
import { OutsideStore, type NewOutsideConnection, type OutsideClient, type OutsideTokens, type StoredOutsideConnection } from "./outside/store";
import type { Key } from "./apps/mcp";
import { isDue, type SignIn } from "./apps/oauth";
import { scopesWith } from "./apps/scopes";
import type { PickedTool } from "./apps/tools";
import { seal, unseal } from "./sealed";
import { isToken } from "./secrets";
import { SessionCache } from "./session-cache";
import { CLOSE_REASONS, closeTooLarge, isTooLarge, MAX_WORKSPACE_FRAME_SIZE, RESERVED_CLOSE_CODES } from "./sockets";
import type { Transfer } from "./transfers";
import type { TurnstileKeys } from "./turnstile";
import {
  NEW_ACCOUNT_LOOKS,
  WorkspaceStore,
  type AccountChange,
  type AgentSetup,
  type AvatarOwner,
  type BotKey,
  type Client,
  type Connecting,
  type AssistantPicks,
  type DirectoryEntry,
  type Disconnection,
  type JoinableAccount,
  type LinkedAccount,
  type LinkedPerson,
  type MovedModel,
  type NewPerson,
  type OwnAppSignIn,
  type OwnProfileEntry,
  type PendingRevocation,
  type ProfileEntry,
  type PushDelivery,
  type RoomEventDeliveries,
  type SavedAssistant,
  type SavedModel,
  type SavedRoomChange,
  type SignInClient,
  type StoredAgent,
  type StoredApp,
  type StoredAppRead,
  type AgentToolPicks,
  type ChangedPicks,
  type StoredToolPick,
  type StoredAgentSettings,
  type StoredBot,
  type StoredBotSettings,
  type StoredPushSubscription,
  type StoredSession,
} from "./workspace-store";

/** How often a session's last activity, browser and IP are written, at most. */
export const SESSION_REFRESH_MS = 60 * 60 * 1000;
/**
 * How long a session lasts unused: as long as its cookie does (auth.ts), so a token kept from a browser
 * that's long gone stops working too.
 */
export const SESSION_IDLE_MS = 400 * 24 * 60 * 60 * 1000;
/** How many sessions the Workspace keeps in memory: a few devices each for a large team. */
const CACHED_SESSIONS = 10_000;
/** Campfire's sign-in limit: 10 attempts from an IP address in a fixed 3-minute window (sessions_controller.rb). */
const SIGN_IN_ATTEMPTS = 10;
const SIGN_IN_WINDOW_MS = 3 * 60 * 1000;
/**
 * The limit on tries at a deployment's setup password while Ember waits to be set up: 10 in a fixed
 * 10-minute window, from anywhere, which the Workspace's storage keeps under SETUP_TRY_WINDOW.
 */
const SETUP_TRIES = 10;
const SETUP_TRY_WINDOW_MS = 10 * 60 * 1000;
const SETUP_TRY_WINDOW = "setupTryWindow";
/** Where the Workspace's storage keeps the models file it last read, and Workers AI's models the model search last listed (see assistant/offered.ts). */
const KEPT_MODELS_FILE = "keptModelsFile";
const KEPT_WORKERS_AI_MODELS = "keptWorkersAiModels";
/**
 * Open sign-up's limits' hour: the sign-ups from an IP address are counted in a fixed one, before the
 * password is hashed, which takes more CPU than the rest of a request, and the new people in the
 * workspace in the last one, counted from the people kept, whatever the Workspace's memory forgets.
 */
const SIGN_UP_WINDOW_MS = 60 * 60 * 1000;

/** How many times an hour one IP address can register an AI app, which nothing signs in to do. */
const OUTSIDE_REGISTRATIONS_PER_ADDRESS = 10;
const OUTSIDE_REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
/** The most AI apps Ember keeps that registered themselves, and how long one nobody has connected is kept once there are that many. */
export const MAX_OUTSIDE_CLIENTS = 500;
const UNCONNECTED_CLIENT_MS = 60 * 60 * 1000;
/** How often Ember records that a connection's app asked it something. */
const OUTSIDE_USED_EVERY_MS = 60 * 60 * 1000;

/** What an AI app's access token lets it do, and as whom: the connection it's of. */
export interface OutsideAccess {
  connectionId: string;
  userId: UserId;
  clientId: string;
  scopes: OutsideScope[];
  /** The address the app said it connects to, which is the only one its tokens are good at, or null when it didn't say. */
  resource: string | null;
}

/** The person an AI app sends a message as, in a room they're in, as the room keeps who wrote it. */
export interface OutsideSender {
  user: User;
  /** When the Workspace checked, in milliseconds since the epoch, as a room's socket has it. */
  authorizedAt: number;
}

/** How many messages AI apps may send as one person in a minute, all their apps together. */
export const OUTSIDE_SENDS_PER_MINUTE = 20;

/** The digests of the tokens Ember gives an app next. */
export type NextOutsideTokens = Pick<OutsideTokens, "accessDigest" | "refreshDigest">;

/** `next`, with when each expires, given at `now`. */
const outsideTokensAt = (next: NextOutsideTokens, now: number): OutsideTokens => ({
  ...next,
  accessExpiresAt: new Date(now + ACCESS_TTL_SECONDS * 1000).toISOString(),
  refreshExpiresAt: new Date(now + REFRESH_TTL_MS).toISOString(),
});

/** A connection as its person's profile lists it. */
const shownConnection = ({ id, clientName, redirectUri, scope, createdAt, usedAt }: StoredOutsideConnection): OutsideConnection => ({
  id,
  name: clientName,
  comesBackTo: new URL(redirectUri).host,
  scopes: outsideScopesOf(scope),
  connectedAt: createdAt,
  usedAt,
});
/**
 * The hour of the limits on asking Ember to email someone, a link to join at the email domains or a code
 * to reset a password: the asks from an IP address are counted in a fixed one, and the times an address
 * is emailed in one that starts as it's first asked for, which the Workspace keeps.
 */
const EMAIL_ASK_WINDOW_MS = 60 * 60 * 1000;
/** How long a link someone asks for to join with their address at the email domains works: an hour, as its email and page say. */
const EMAIL_DOMAIN_LINK_MS = 60 * 60 * 1000;
/** How long a code someone asks for to reset their password works, as its email and page say. */
const PASSWORD_RESET_CODE_MS = PASSWORD_RESET_CODE_MINUTES * 60 * 1000;
/**
 * Link previews someone may ask for in a minute, since a preview fetches any page someone names, which
 * would otherwise make the Worker anyone's fetcher.
 */
const UNFURLS = 30;
const UNFURL_WINDOW_MS = 60 * 1000;
/** How long the Workspace waits for a custom domain check's probe, longer than the check waits for an answer. */
const PROBE_WAIT_MS = 30 * 1000;
/** How many probes the Workspace waits for at once, of the latest checks. */
const WAITING_PROBES = 20;
/**
 * How many rows of its outbox the Workspace delivers in one run of its alarm, at most, revocations
 * first, then purges, then reindexes, and how many rooms a change calls before it answers
 * (`closeQueuedSockets`). Each room it calls may count as a subrequest, of which an invocation on the
 * Free plan can make 50, its queries included.
 */
const DELIVERIES_PER_RUN = 40;
/**
 * How long a change waits for the rooms to close the sockets it queued before it answers. The alarm sees
 * to a room that takes longer.
 */
const CLOSING_SOCKETS_MS = 2_000;
/** How many of a banned person's messages a room deletes each time the outbox asks: a page of history's worth. */
const MESSAGES_PER_PURGE = 100;
/**
 * How many memberships the alarm checks in a run, at most, asking Memberful's admin API after them all in
 * one request, a query with an alias for each, so that a run's subrequests stay well within the Free plan's.
 */
const MEMBERSHIPS_PER_CHECK = 25;
/** How often the Workspace checks the membership of everyone linked to the Memberful site, in case a webhook about one never came. */
const MEMBERSHIP_CATCH_UP_MS = 24 * 60 * 60 * 1000;
/**
 * How long signing in with Memberful, or connecting an account there, has to come back from the Memberful
 * site: long enough to sign in there, or sign up.
 */
export const MEMBERFUL_ROUND_TRIP_MS = 10 * 60 * 1000;

/**
 * Campfire's `fresh_account_logo_path`, which account-logo.ts serves: versioned by when the account last
 * changed, so a new logo, or any other change to the account, gets past the copies browsers keep.
 */
const accountLogoPath = (updatedAt: string) => `/account/logo?v=${versionOf(updatedAt)}`;

/** The slots `changes` gives another icon than `icons` has, or undefined for none. */
function changedNavigationIcons(icons: NavigationIcons, changes: NavigationIconChanges): NavigationIconChanges | undefined {
  const changed = NAVIGATION_SLOTS.filter((slot) => changes[slot] !== undefined && changes[slot] !== (icons[slot] ?? ""));
  return changed.length > 0 ? Object.fromEntries(changed.map((slot) => [slot, changes[slot]])) : undefined;
}

/** Whether `domains` lists the same domains as `kept`, in the same order. */
const sameDomains = (domains: string[], kept: string[]) => domains.length === kept.length && domains.every((domain, index) => domain === kept[index]);

/** Whether Email domain lets people at `domain` join `account`. */
const letsInEmailDomain = (account: Pick<Account, "emailDomainSignUp" | "emailDomains" | "memberfulSignIn">, domain: string) =>
  signsUpWithEmailDomain(account) && account.emailDomains.includes(domain);

/** The mailbox `account`'s email comes from: its From address, under the workspace's name unless that names another (`mailboxUnder`), or null while it has none. */
function fromOf(account: Pick<JoinableAccount, "name" | "emailFrom">): Mailbox | null {
  const from = account.emailFrom === null ? null : mailboxOf(account.emailFrom);
  return from && mailboxUnder(from, account.name);
}

/**
 * What `settings` changes of the account's two Memberful settings, `account` having them as they are,
 * both at once, or undefined when it changes neither: Members only turns Memberful on with it, and
 * turning Memberful off turns Members only off.
 */
function memberfulChange(account: Pick<Account, "memberfulJoin" | "memberfulSignIn">, { memberfulJoin, memberfulSignIn }: AccountSettings) {
  const join = memberfulJoin ?? (memberfulSignIn || account.memberfulJoin);
  const membersOnly = join && (memberfulSignIn ?? account.memberfulSignIn);
  return join === account.memberfulJoin && membersOnly === account.memberfulSignIn ? undefined : { memberfulJoin: join, memberfulSignIn: membersOnly };
}

/**
 * The account as every page shows it, without its join code, which only the people in it see, nor its
 * email domains while Email domain is off, and with whether huddles are on, `huddles`, in place of the
 * app they run through.
 */
const accountOf = (
  {
    name,
    tagline,
    hideTranslationButtons,
    customStyles,
    restrictRoomCreation,
    customDomain,
    joinLink,
    openSignUp,
    memberfulJoin,
    memberfulSignIn,
    emailDomainSignUp,
    emailDomains,
    navigationIcons,
    huddleCameras,
    huddleScreens,
    updatedAt,
    storedLogo,
  }: JoinableAccount,
  huddles: boolean,
): Account => ({
  name,
  tagline,
  hideTranslationButtons,
  customStyles,
  restrictRoomCreation,
  logo: storedLogo && accountLogoPath(updatedAt),
  customDomain,
  joinLink,
  openSignUp,
  memberfulJoin,
  memberfulSignIn,
  emailDomainSignUp,
  emailDomains: emailDomainSignUp ? emailDomains : [],
  navigationIcons,
  huddles,
  huddleCameras,
  huddleScreens,
});

/** The parts of the account that Ember AI's settings are made of. */
type AssistantAccount = Pick<JoinableAccount, "assistant" | "assistantMost" | "assistantInstructions" | "assistantPromptTemplate">;

/** Ember AI as the AI assistant tab shows `account`'s to administrators, but for @ember's avatar, or null while it's off. */
const assistantSettingsOf = ({ assistant, assistantMost, assistantInstructions, assistantPromptTemplate }: AssistantAccount): Omit<AssistantSettings, "avatarUrl" | "avatar"> | null =>
  assistant && {
    accountId: assistant.accountId,
    model: assistant.model,
    models: assistant.models,
    most: assistantMost,
    webTools: searchFormatOf(assistant.model, assistant.format) === null ? null : assistant.webTools,
    instructions: assistantInstructions,
    promptTemplate: assistantPromptTemplate,
  };

/**
 * How AI Gateway is asked, as far as the tools it passes on go: through which Cloudflare account, whose
 * gateway settings and provider keys it uses, and the model and format, but whichever of the account's
 * API tokens asks.
 */
type AskedAs = Pick<Gateway, "accountId" | "model" | "format">;

/** Whether Ember AI, as `saved`, answers everyone as `asked` says: through its account, with its model, in its format. */
const isAskedAs = (saved: SavedAssistant, asked: AskedAs) => saved.accountId === asked.accountId && saved.model === asked.model && saved.format === asked.format;

/**
 * What @ember may do on the web, and when that was asked for, once Ember AI, `saved`, or off for null,
 * changes at `changedAt` to answer everyone as `asked` says: as they were, for the same account and model
 * in the same format, and else nothing, as of then, as another account or model may not take the same
 * tools, so that a test Search the web began before then can't turn it on.
 */
const webToolsKept = (saved: SavedAssistant | null, asked: AskedAs, changedAt: string): Pick<SavedAssistant, "webTools" | "webToolsAskedAt"> =>
  saved && isAskedAs(saved, asked) ? { webTools: saved.webTools, webToolsAskedAt: saved.webToolsAskedAt } : { webTools: [], webToolsAskedAt: changedAt };

/** Ember AI as `assistant` has it, but for each of its models that one of `moves` moves from the format it's in, asked as the move says. */
function movedIn(assistant: SavedAssistant, moves: readonly MovedModel[]): SavedAssistant {
  const moveOf = (id: string, format: ModelFormat) => moves.find((move) => move.id === id && move.from === format);
  const models = assistant.models.map((model) => {
    const move = moveOf(model.id, model.format);
    return move ? { ...model, format: move.format, thinkingLevels: move.thinkingLevels } : model;
  });
  return { ...assistant, format: moveOf(assistant.model, assistant.format)?.format ?? assistant.format, models };
}

/** The hosts Ember knows reach it, as `account` keeps them: its custom domain, where a deploy puts it, and the domains it moved away from. */
const addressesOf = (account: Pick<JoinableAccount, "customDomain" | "deployedAddress" | "otherAddresses">): string[] =>
  [account.customDomain, account.deployedAddress, ...account.otherAddresses].filter((address) => address !== null);

/** The levels someone who `picked` them has of @ember's dials, where each starts for one they haven't picked, no higher than `most`. */
const levelsOf = (picked: AssistantPicks | null, most: AnswerLevels): AnswerLevels =>
  withinMost({ thinking: picked?.thinking ?? DEFAULT_LEVELS.thinking, length: picked?.length ?? DEFAULT_LEVELS.length }, most);

/**
 * The model someone who `picked` one has @ember answer them with instead of whichever `assistant` answers
 * everyone with: theirs while it's one of the models people can pick, even that one, or else null.
 */
const pickedModelOf = (assistant: SavedAssistant, picked: AssistantPicks | null): SavedModel | null => assistant.models.find(({ id }) => id === picked?.model) ?? null;

/** The model that answers someone, as the models people can pick list it: the one they `picked` (`pickedModelOf`), or else the one that answers everyone. */
const answeringModelOf = (assistant: SavedAssistant, picked: SavedModel | null): SavedModel | undefined => picked ?? assistant.models.find(({ id }) => id === assistant.model);

/**
 * How `model`, saved in a format and with the levels of thinking it takes, as `saved` says, is asked: as
 * it's saved, but for one of Workers AI's that the model search lists, `workersAi`, which is asked in
 * Workers AI's format, where it takes Ember's tool for searching the web, at the levels the search lists,
 * as one saved before Ember read the search was asked in Chat Completions, at the levels it was tested at.
 */
function askedAs(model: string, saved: { format: ModelFormat; thinkingLevels?: ThinkingLevel[] }, workersAi: readonly OfferedModel[]): { format: ModelFormat; thinkingLevels?: ThinkingLevel[] } {
  const listed = isWorkersAiModel(model) ? offeredModelOf(model, workersAi) : undefined;
  return listed ? { format: "workers", thinkingLevels: listed.thinkingLevels ?? saved.thinkingLevels } : saved;
}

/**
 * @ember's answers to someone who `picked` their levels and model, as their profile shows them with
 * `account`'s most and models, or null while Ember AI is off.
 */
function yourAssistantOf(account: Pick<JoinableAccount, "assistant" | "assistantMost"> | null, picked: AssistantPicks | null): YourAssistant | null {
  if (!account?.assistant) return null;
  const { assistant, assistantMost: most } = account;
  return { levels: levelsOf(picked, most), most, model: pickedModelOf(assistant, picked)?.id ?? null, defaultModel: assistant.model, models: assistant.models };
}

/** What Set up Ember AI chose to answer everyone with: how AI Gateway asks it, and what Ember offers it as, if it says. */
type ChosenModel = Gateway & { name?: string };

/**
 * The models people can pick once Set up Ember AI has chosen `chosen` to answer everyone with: those of
 * `previous`, Ember AI as it was, with `chosen` in place of the one that answered everyone, without it
 * twice, or `chosen` alone, as when Ember AI was off, so that the models stay as many as administrators
 * added. `chosen` is called by the name Ember offers it by, when it's given, or else as it was listed.
 */
function modelsAfterSetup(previous: SavedAssistant | null, { model, name, format, thinkingLevels }: ChosenModel): SavedModel[] {
  const models = previous?.models ?? [];
  const chosen = { id: model, name: name ?? modelName(model, models), format, ...(thinkingLevels && { thinkingLevels }) };
  const others = models.filter(({ id }) => id !== previous?.model);
  if (others.some(({ id }) => id === model)) return others.map((kept) => (kept.id === model ? chosen : kept));
  return others.toSpliced(Math.max(0, models.findIndex(({ id }) => id === previous?.model)), 0, chosen);
}

/**
 * What asking an agent's model found, through the Cloudflare account and API token `through` names: the
 * model, what it's called, the format it took its test question in, the levels of thinking it takes, and
 * what it may do on the web, as Search the web found it, or nothing while that's off.
 */
export interface AskedModel extends Pick<AgentSetup, "model" | "modelName" | "format" | "thinkingLevels" | "webTools"> {
  through: Pick<Gateway, "accountId" | "apiToken">;
}

/**
 * Whether changing `agent` by `changes` needs its model asked first: a new one answers its test
 * question, which finds its format, and Search the web's too, unless that's turned off, and turning
 * Search the web on has the model it has search the web.
 */
export const asksModel = (agent: Pick<AgentSetup, "model" | "webTools">, changes: AgentChanges): boolean =>
  (changes.model !== undefined && changes.model !== agent.model) || (changes.webSearch === true && agent.webTools.length === 0);

/** An agent's setup, of what it does, its instructions and what Ember adds around them, and its levels, with its model as `asked` found it. */
const setupOf = (
  { description, instructions, promptTemplate, levels }: Pick<AgentSetup, "description" | "instructions" | "promptTemplate" | "levels">,
  { model, modelName, format, thinkingLevels, webTools }: Pick<AgentSetup, "model" | "modelName" | "format" | "thinkingLevels" | "webTools">,
): AgentSetup => ({ description, instructions, promptTemplate, model, modelName, format, thinkingLevels, levels, webTools });

/** Whether two lists of the levels of thinking a model takes are the same, null for a model Ember hasn't asked at each. */
const sameLevels = (levels: ThinkingLevel[] | null, others: ThinkingLevel[] | null): boolean =>
  levels === null || others === null ? levels === others : levels.length === others.length && levels.every((level) => others.includes(level));

/** Whether two setups of an agent are the same, so that saving one in place of the other changes nothing. */
const sameSetup = (setup: AgentSetup, other: AgentSetup): boolean =>
  setup.description === other.description &&
  setup.instructions === other.instructions &&
  setup.promptTemplate === other.promptTemplate &&
  setup.model === other.model &&
  setup.modelName === other.modelName &&
  setup.format === other.format &&
  sameLevels(setup.thinkingLevels, other.thinkingLevels) &&
  setup.levels.thinking === other.levels.thinking &&
  setup.levels.length === other.levels.length &&
  setup.webTools.length === other.webTools.length &&
  setup.webTools.every((tool) => other.webTools.includes(tool));

/** Whether an agent in `rooms`, the open rooms it's kept to, or null while it's in every one, is in just the rooms `picked` picks already. */
const sameRooms = (rooms: AgentRoom[] | null, picked: RoomId[] | null): boolean =>
  rooms === null || picked === null ? rooms === picked : rooms.length === picked.length && rooms.every(({ id }) => picked.includes(id));

/** The header in which the Worker passes a workspace socket's credentials on to the Workspace. */
export const CREDENTIALS_HEADER = "X-Ember-Credentials";

/** What a request brings to say who it's from. */
export interface Credentials {
  /** The digest of the token in the request's session cookie. */
  tokenDigest: string;
  client: Client;
  /** Whether people who signed in with just a name may stay signed in (`EMBER_GUEST_SIGN_IN`). */
  guests: boolean;
}

/** What first run names the workspace. */
export const ACCOUNT_NAME = "Ember";
/**
 * The open rooms first run makes, everyone's to begin with, as a Slack workspace's are. The first,
 * general, is the workspace's first room, which first run opens and the welcome card shows in.
 */
const FIRST_ROOM_NAMES = ["general", "random"];

/** The account at the Memberful site `issuer` that `member` signed in to, as `identities` keeps it: named as Memberful does, not as the person is here. */
const linkedAccountOf = (issuer: string, member: MemberfulMember): LinkedAccount => ({ issuer, subject: member.id, name: member.fullName, emailAddress: member.emailAddress });

/** Your profile, and the sign-in link it shows you, by the session asking, which the Worker signs. */
export interface YourProfile {
  transfer: Transfer;
  profile: Omit<Profile, "memberful">;
  /**
   * Whether Memberful is members only, and the accounts elsewhere you've connected, from which the
   * Worker, which knows the Memberful site, tells your profile where you stand with Memberful
   * (`Profile.memberful`), or null for a guest, who has nothing to connect.
   */
  memberful: { membersOnly: boolean; accounts: LinkedAccount[] } | null;
}

/** Someone as their page shows them to the person asking. */
export interface ShownPerson {
  person: DirectoryEntry | ProfileEntry;
  /**
   * The sign-in link the page gives for them, by the session asking, as Campfire's gives one to
   * administrators when they're active and aren't a bot (users/show.html.erb), or null.
   */
  transfer: Transfer | null;
  /** What the page tells everyone of an agent an administrator made, or null for anyone else. */
  agent: AgentProfile | null;
}

/**
 * What a search needs from the Workspace: who's searching, the rooms whose messages they can search, the
 * ones they've hidden and DMs too, and their recent searches, newest first.
 */
export interface Searcher {
  userId: UserId;
  rooms: Room[];
  recent: Search[];
}

/** What the Workspace says about opening a room's socket. */
export interface RoomAccess {
  user: User;
  sessionId: string;
  member: boolean;
  /** Whether a ban blocks the IP address the socket comes from, which lets it read but not change anything. */
  banned: boolean;
  /** When the Workspace checked, in milliseconds since the epoch. */
  authorizedAt: number;
}

/** What the Workspace says about a bot API key it found an active bot in a room for. */
export interface BotAccess {
  bot: User;
  /** When the Workspace checked, in milliseconds since the epoch, as a room's socket has it. */
  authorizedAt: number;
}

/**
 * @ember or an AI agent as a room asks Ember AI to answer a question there (`Workspace.answererIn`): how
 * Ember AI asks AI Gateway with its model, or null while its API token doesn't open, its instructions,
 * the community's name, which it's told, how much it thinks and how long it answers, what it may do on
 * the web, and Ember's own addresses, whose pages its answers don't preview.
 */
export interface AssistantAccess extends BotAccess {
  gateway: Gateway | null;
  /** Whether the gateway's model is one whoever asked picked, rather than the one @ember answers everyone else with. */
  picked: boolean;
  /** An agent's instructions, or those administrators added to @ember's. */
  instructions: string;
  /** What Ember adds around them, as administrators changed it, or null for Ember's own. */
  promptTemplate: string | null;
  community: string;
  levels: AnswerLevels;
  /** What the gateway's model may do on the web: what Search the web lets @ember do, of what that model's format has tools for. */
  webTools: WebTool[];
  /** Whether Search the web is on, which `webTools` doesn't show for a model that can't search. */
  webSearchOn: boolean;
  /** The hosts Ember knows reach it, as `location.host` writes them: its custom domain, where a deploy puts it, and the domains it moved away from. */
  addresses: string[];
  /** The connected apps' tools picked for it, each as its server described it when it was picked. */
  appTools: PickedTool[];
}

/**
 * What Try it asks an agent with (`Workspace.agentTrial`): the administrator who asks, the account and
 * API token Ember AI asks AI Gateway through, the community's name and Ember's addresses, as a question
 * for an agent has them, and the agent as it's saved, if it is, by its id, with its model and that
 * model's name, the format that took its test question and what it may do on the web.
 */
export interface AgentTrialAccess {
  asker: User;
  through: Pick<Gateway, "accountId" | "apiToken">;
  community: string;
  addresses: string[];
  saved: Pick<StoredAgentSettings, "id" | "model" | "modelName" | "format" | "thinkingLevels" | "webTools"> | null;
}

/**
 * The same, as the bot API has it, with Ember's custom domain, which the API's links name, or null while it
 * has none, and whether the bot has a webhook, where the room reports clicks on its cards' buttons that act.
 */
export interface BotKeyAccess extends BotAccess {
  customDomain: string | null;
  takesClicks: boolean;
}

/**
 * What the Workspace says about the webhook of a bot it found active in a room, as a delivery to it runs:
 * the URL it delivers to, and the key the delivery gives the bot in the room's address, which is the
 * webhook's own, never the bot's (`webhookTokenOf`).
 */
export interface WebhookAccess extends BotAccess {
  url: string;
  key: string;
}

/** A bot's webhook as a click's delivery finds it, with who clicked, by their name now, and the room's name, or null for a DM's. */
export interface ClickAccess extends WebhookAccess {
  clicker: User;
  roomName: string | null;
}

/**
 * Why signing in with Memberful signed nobody in, or connected no account: Memberful is off for someone
 * new, the person the account is linked to was removed or banned, it has no active membership, someone
 * new would have someone's email address, keys for another site took the place of the ones it signed
 * in with meanwhile, or, connecting one, Memberful isn't members only, the account is connected to
 * someone else, or they're connected to another.
 */
export type MemberfulRefusal = "off" | "unneeded" | "refused" | "membership" | "taken" | "claimed" | "another" | "failed";

/** What a join link does: joins, is off while an administrator has turned it off or Memberful is members only, or isn't the join link. */
export type JoinLink = "joins" | "off" | "memberful" | "not found";

/** Why open sign-up lets nobody in: it's off, or the workspace has let in as many new people as it does in an hour. */
export type SignUpRefusal = "closed" | "full";

/**
 * Why a change to the account changes nothing: Open and Memberful's Members only can't both be on
 * ("conflict"), and Email domain can't be on without a domain to let in, nor be turned on while Ember
 * can't send email, since it emails people the links they join with.
 */
export type AccountRefusal = "conflict" | "no email domains" | "no email";

/**
 * What asking for a link to join with an address at the email domains came to: "asked", whatever Ember
 * emailed, if anything, "off" while Email domain doesn't let the address's domain in, "limited" past the
 * network's limit, "unsendable" while Ember can't send email, and "unsent" when the provider refused to.
 */
export type EmailLinkAsk = "asked" | "off" | "limited" | "unsendable" | "unsent";

/**
 * What asking for a code to reset a password came to: "asked", whatever Ember goes on to email, if
 * anything, "limited" past the network's limit, and "unsendable" while Ember can't send email.
 */
export type PasswordResetAsk = "asked" | "limited" | "unsendable";

/** A new code for Ember to email to reset a password: the code, which only the email holds, and its digest, which the Workspace keeps in its place. */
export interface NewResetCode {
  code: string;
  digest: string;
}

/**
 * What Send me a test email came to: the address it went to, or why it wasn't sent, with the status that
 * says so: 503 while the deployment can't send email, 422 without a From address or an email address of
 * one's own, and 502 when the provider refused it.
 */
export type TestEmail = SentTestEmail | { status: 422 | 502 | 503; refusal: string };

/** A new link for Ember to email: its secret, which only the link holds, and the secret's digest, which the Workspace keeps in its place. */
export interface NewEmailLink {
  token: string;
  digest: string;
}

/** An invitation as it's saved, before it's sent: the address it's for, its new link, and when that was made and stops working. */
interface SavedInvitation {
  id: string;
  emailAddress: string;
  link: NewEmailLink;
  createdAt: string;
  expiresAt: string;
}

/** When an invitation's link made now is made, and stops working, `INVITATION_DAYS` days on. */
function invitationTimes(): Pick<SavedInvitation, "createdAt" | "expiresAt"> {
  const now = Date.now();
  return { createdAt: new Date(now).toISOString(), expiresAt: new Date(now + INVITATION_DAYS * 24 * 60 * 60 * 1000).toISOString() };
}

/** Why there's no test email without a From address. */
const NO_EMAIL_FROM = "Give Ember a From address first.";
/** Why there's no test email to an administrator without an email address. */
const NO_EMAIL_ADDRESS = "Your profile has no email address to send it to.";

/** The workspace as pages show it before first run: named "Ember" and looking as a new one does, with huddles off. */
export const ACCOUNT_BEFORE_SETUP: Account = { name: ACCOUNT_NAME, ...NEW_ACCOUNT_LOOKS, logo: null, huddles: false };

/** A join link's code: 12 random letters and digits in fours, like aB3d-Ef5h-iJ7k. */
const newJoinCode = () => alphanumeric(12).match(/.{4}/g)!.join("-");

const encoder = new TextEncoder();

/** Whether `code` is the join code, compared in constant time. Every code is as long as the next, so that much needn't be hidden. */
function isCode(code: string, joinCode: string): boolean {
  const [given, expected] = [encoder.encode(code), encoder.encode(joinCode)];
  return given.length === expected.length && crypto.subtle.timingSafeEqual(given, expected);
}

/** Sends `frame` on a workspace socket, unless it has closed since. */
function send(ws: WebSocket, frame: WorkspaceServerFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // Its close handler has nothing to clean up.
  }
}

/** Who a session signs in, as the app keeps them. */
const meOf = ({ user, administrator }: StoredSession): Me => ({ ...user, administrator });

/** Whether someone or a bot named `name` takes @ember's name by being renamed `rename`, which they can't, unless it was theirs already (`isReservedName`). */
const takesReservedName = (name: string, rename: string) => rename !== name && isReservedName(rename) && !isReservedName(name);

/**
 * What reading that `person`'s membership is `subscribed`, or not, changes: "lapsed" for an active member
 * without one, whom it suspends, "renewed" for a suspended member with one, whom it lets back, and null
 * for anyone else, administrators and the people they invited included, who are let in whatever their
 * membership.
 */
function membershipChange({ status, membershipNeeded }: LinkedPerson, subscribed: boolean): "lapsed" | "renewed" | null {
  if (!subscribed && status === "active" && membershipNeeded) return "lapsed";
  if (subscribed && status === "suspended") return "renewed";
  return null;
}

/**
 * Whether a change to the profile of someone with `emailAddress` changes what they sign in with: it's
 * a new password, or `typed` is another email address, as `changeProfile` saves it, a blank one as none.
 */
const changesSignIn = ({ emailAddress }: { emailAddress: string | null }, typed: string | undefined, newPassword: boolean) =>
  newPassword || (typed !== undefined && (typed || null) !== emailAddress);

/**
 * Whether `person` signs in with Memberful alone: they have no password, and are linked at
 * `memberfulSite`, the Memberful site the deployment has the keys to, if any. Memberful is their way in
 * then, so they're given no password, which holding their session would be enough to set.
 */
const signsInWithMemberfulAlone = ({ password, accounts }: Pick<OwnProfileEntry, "password" | "accounts">, memberfulSite: string | null) =>
  !password && memberfulSite !== null && accounts.some(({ issuer }) => issuer === memberfulSite);

/**
 * How long a picture's key stays reserved for whatever gives someone the picture, which the Worker
 * calls once R2 has stored it: far longer than that takes. R2 then deletes whatever is there, unless
 * someone has the picture.
 */
const PICTURE_RESERVATION_MS = 60 * 60 * 1000;

/** The rooms `LEGACY_ROOMS` lists, leaving out anything that couldn't be a room's id. */
const legacyRooms = (env: Env): RoomId[] => (env.LEGACY_ROOMS ?? "").split(",").map((id) => id.trim()).filter(isRoomId);

/**
 * Where a connected app is asked: by its name, its server's address, what Ember sends it to be let
 * in, if it has anything, with the token as it's kept, sealed, and when an administrator signed in to
 * its server, if one did, which with the address say whether the app is still asked there, as the
 * same account, once its server has answered. One signed in to has no key once its sign-in has ended.
 */
export interface AppAccess {
  name: string;
  url: string;
  key: Key | null;
  sealedToken: string | null;
  signedIn: boolean;
  signedInAt: string | null;
}

/**
 * Where a call of a connected app's tool goes, as the app is asked: with what Ember sends it, or, with
 * `own`, as that person, who asked, with the sign-in they made to it themselves, when `signedInAt` is
 * when they did, and there's no key once it has ended, or they've signed out.
 */
export type AppCallAccess = AppAccess & { own?: UserId };

/** Where an app was asked when its tools were read: its server's address then, its token as it was kept, and when it was signed in to. */
export type AskedAt = Pick<AppAccess, "url" | "sealedToken" | "signedInAt">;

/** Who asked for a call of an app's tool that goes as them, with the sign-in they made to the app themselves, and where: in their direct conversation with the agent. */
export interface AskedBy {
  roomId: RoomId;
  askerId: UserId;
}

/** Whose sign-in to an app it is: a person's, which they made themselves, or, with null, Ember's, which an administrator made. */
type Holder = UserId | null;

/** What the sign-in `holder` keeps to the app `appId` is sealed for, and what's asked for with it is kept by. */
const signInOf = (appId: AppId, holder: Holder) => (holder === null ? appId : `own ${appId} ${holder}`);

/** The most sign-ins people made to an app themselves that its removal has its service take back: the rest are forgotten all the same. */
export const MAX_OWN_SIGN_INS_REVOKED = 20;

/** A connected app as someone's profile lists it, with the sign-in they've made to it themselves, if they have. */
const yourApp = ({ appId, appName, signedIn }: OwnAppSignIn): YourApp => ({
  id: appId,
  name: appName,
  signedInAt: signedIn?.at ?? null,
  ended: signedIn !== null && signedIn.sealed === null,
  wantsMore: signedIn !== null && signedIn.scopeWanted !== null,
});

/** Whether `app` is still asked where it was `at`, as the same account: what its server answered then is still about it. */
const isAskedAt = (app: StoredApp, at: AskedAt) => app.url === at.url && app.sealedToken === at.sealedToken && (app.signedIn?.at ?? null) === at.signedInAt;

/** The access token of a sign-in to an app, or null once it has ended, with when the app was signed in to as that token is its: null for an app that's gone. */
interface SignInKey {
  key: Key | null;
  signedInAt: string | null;
}

/** A sign-in to an app that an administrator began, as JSON: for a connected app, or for one to connect by `name` at `url`. One anyone began to a connected app for themselves is the same. */
export interface BegunAppSignIn {
  state: string;
  appId: AppId | null;
  name: string;
  url: string;
  signIn: string;
}

/** How long an administrator has to sign in at an app's authorization server and come back. */
const APP_SIGN_IN_MS = 10 * 60_000;

/** A connected app as its page shows it: without its token, and with each tool as its server describes it. */
/**
 * The tools of `apps` as an agent's page offers them, with which of them `picks` have the agent use: one
 * picked as its server described it then, by its fingerprint. One described another way since has
 * changed, which sets it aside until it's picked again.
 */
const offeredApps = (apps: readonly StoredApp[], picks: readonly StoredToolPick[]): OfferedApp[] =>
  apps.map(({ id, name, tools }) => ({
    id,
    name,
    tools: tools.map(({ name: tool, title, description, fingerprint }) => {
      const pick = picks.find((pick) => pick.appId === id && pick.name === tool);
      const picked = pick !== undefined && !pick.setAside && pick.fingerprint === fingerprint;
      return { name: tool, title, description, fingerprint, picked, changed: pick !== undefined && !picked, alwaysAllowed: picked && pick.alwaysAllowed === true };
    }),
  }));

/**
 * The tools of `app` that agents were picked and none of them is given, by name, each with the agents
 * whose picks those are, `everyPicks` being every agent's: one its server describes another way than a
 * pick has it, or that was set aside for that before, and one its server no longer has.
 */
function setAsideTools(app: StoredApp, everyPicks: readonly AgentToolPicks[]): SetAsideTool[] {
  const tools = new Map<string, SetAsideTool>();
  for (const { agent, picks } of everyPicks) {
    for (const pick of picks.filter(({ appId }) => appId === app.id)) {
      const fingerprint = app.tools.find((tool) => tool.name === pick.name)?.fingerprint;
      if (!pick.setAside && fingerprint === pick.fingerprint) continue;
      const tool = tools.get(pick.name) ?? { name: pick.name, gone: fingerprint === undefined, agents: [] };
      tools.set(pick.name, { ...tool, agents: [...tool.agents, agent] });
    }
  }
  return [...tools.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * The picks that reading `read` from the app `appId` changes, by agent, `everyPicks` being every
 * agent's: an always-allowed pick of a tool its server no longer has as it was picked asks first from
 * then on, even once the server describes the tool as it did. Nobody is asked about a call that's
 * always allowed, so that isn't to come back without an administrator.
 */
function picksChangedBy(appId: AppId, read: StoredAppRead, everyPicks: readonly AgentToolPicks[]): ChangedPicks[] {
  const isChanged = (pick: StoredToolPick) => pick.appId === appId && read.tools.find((tool) => tool.name === pick.name)?.fingerprint !== pick.fingerprint;
  const asksFirst = ({ alwaysAllowed: _, ...pick }: StoredToolPick): StoredToolPick => pick;
  return everyPicks
    .filter(({ picks }) => picks.some((pick) => pick.alwaysAllowed && isChanged(pick)))
    .map(({ agent, picks, stored }) => ({ agentId: agent.id, stored, picks: picks.map((pick) => (pick.alwaysAllowed && isChanged(pick) ? asksFirst(pick) : pick)) }));
}

const shownApp = (app: StoredApp, everyPicks: readonly AgentToolPicks[]): App => ({
  id: app.id,
  name: app.name,
  url: app.url,
  hasToken: app.sealedToken !== null,
  serverName: app.serverName,
  tools: app.tools.map(({ name, title, description }) => ({ name, title, description })),
  toolsLeftOut: app.toolsLeftOut,
  toolsReadAt: app.toolsReadAt,
  connectedBy: app.connectedBy,
  setAside: setAsideTools(app, everyPicks),
  signIn: app.signedIn && { ...app.signedIn, ended: app.sealedSignIn === null, clientId: app.signInClient?.id ?? null, wantsScope: app.scopeWanted },
});

/**
 * What a workspace shares across its rooms: its account, its people and their sessions, and its
 * rooms and who is in each. There is one, and every request reaches it by name; its tables live in
 * its own SQLite storage, or in D1 with everyone else's. Each signed-in tab keeps a socket to it,
 * besides its room's, for what changes outside the room; like rooms, it hibernates them.
 */
export class Workspace extends DurableObject<Env> {
  private readonly db: Db;
  private readonly store: WorkspaceStore;
  private readonly outside: OutsideStore;
  private readonly sessions = new SessionCache<StoredSession>(CACHED_SESSIONS);
  /**
   * The account once it exists. Renaming it and regenerating its join code keep this current, and
   * nothing deletes it, so once read it needn't be read again.
   */
  private knownAccount: JoinableAccount | null = null;
  /** Counts the starts and ends of changes to the account, so a read that overlapped one isn't kept: on D1, queries interleave. */
  private accountChanges = 0;
  /** The Memberful sites someone here is known to be linked to an account at (see `offersMemberfulSignIn`). */
  private readonly linkedSites = new Set<string>();
  /** Counts the unlinkings of accounts elsewhere, so a read that overlapped one isn't kept as a linked site: on D1, queries interleave. */
  private unlinkings = 0;
  /** Every IP address a ban blocks, once read. Banning someone and lifting a ban forget it. */
  private knownBannedAddresses: Set<string> | null = null;
  /** Counts the starts and ends of bans and lifted bans, so a read of the banned addresses that overlapped one isn't kept. */
  private banChanges = 0;
  private readonly signInAttempts = new FixedWindowLimit(SIGN_IN_ATTEMPTS, SIGN_IN_WINDOW_MS);
  private readonly signUps = new FixedWindowLimit(SIGN_UPS_PER_ADDRESS, SIGN_UP_WINDOW_MS);
  private readonly emailLinkAsks = new FixedWindowLimit(EMAIL_LINKS_PER_NETWORK, EMAIL_ASK_WINDOW_MS);
  private readonly passwordResetAsks = new FixedWindowLimit(PASSWORD_RESETS_PER_NETWORK, EMAIL_ASK_WINDOW_MS);
  private readonly unfurls = new FixedWindowLimit(UNFURLS, UNFURL_WINDOW_MS);
  private readonly outsideRegistrations = new FixedWindowLimit(OUTSIDE_REGISTRATIONS_PER_ADDRESS, OUTSIDE_REGISTRATION_WINDOW_MS);
  private readonly outsideSends = new FixedWindowLimit(OUTSIDE_SENDS_PER_MINUTE, 60_000);
  /** The probes custom domain checks send, each with its answer and when it's no longer waited for (see `expectProbe`). */
  private readonly probes = new Map<string, { answer: string; until: number }>();
  /** The access token of each app's sign-in that's being asked for now (`signInKey`). */
  private readonly signInKeys = new Map<string, Promise<SignInKey>>();
  /** Whether a removed app's service took back the tokens Ember got from it as the app went, by app, until its removal reads it (`revokeStrayTokens`). */
  private readonly strayTokens = new Map<string, Promise<boolean>>();
  /** The last change asked for, which the next one waits for (see `oneAtATime`). */
  private lastChange: Promise<unknown> = Promise.resolve();
  /** Ember AI's models being asked through their providers' endpoints, while they are (see `moveToProviderEndpoints`). */
  private movingToProviderEndpoints: Promise<void> | null = null;
  /** Counts the times Ember AI is set up, changed or turned off, so a move onto the providers' endpoints that overlapped one isn't kept. */
  private assistantSetups = 0;
  /** The last delivery of revocations, which the next one waits for (see `deliverRevocations`). */
  private lastDelivery: Promise<unknown> = Promise.resolve();
  /**
   * The last code to reset a password emailed, which the next one waits for, so that codes are emailed,
   * and kept, in the order they were asked for (see `askForPasswordReset`).
   */
  private lastResetCode: Promise<unknown> = Promise.resolve();
  /** How many changes have queued revocations, which `afterQueuing` compares to see whether its change did. */
  private queuedRevocations = 0;
  /**
   * When each ban lifted since the outbox last read its purges was first lifted, so the rooms it goes on
   * to ask delete only what was written before, which the purges it read can't say.
   */
  private readonly liftedBans = new Map<UserId, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // As in rooms, the runtime answers the app's heartbeats without waking the Workspace.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    this.db = openDb(env, ctx.storage, "workspace");
    this.store = new WorkspaceStore(this.db);
    this.outside = new OutsideStore(this.db);
    // The outbox can hold revocations with no alarm set for them: the Workspace can stop after saving a
    // change but before setting the alarm, and an alarm that keeps failing is given up. So it looks
    // whenever it starts, before answering anything. A failure is only logged; the next change that
    // queues a revocation, or the next start, sets the alarm.
    void ctx.blockConcurrencyWhile(() => this.resumeDeliveries().catch((error) => console.error("Could not schedule the outbox's deliveries", error)));
    const legacy = legacyRooms(env);
    // Before anything else is answered, so the first request after a deploy finds them. A failure
    // mustn't keep everyone from signing in, so it's only logged, and the next start tries again.
    if (legacy.length > 0) {
      void ctx.blockConcurrencyWhile(() => this.registerLegacyRooms(legacy).catch((error) => console.error("Registering LEGACY_ROOMS failed", error)));
    }
  }

  /**
   * Lets in a tab's workspace socket, which the Worker sends on with the credentials of the request
   * for it, if they sign someone in. Like a room's, it's tagged with its person and its session, so
   * signing out can find it.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
    const credentials = JSON.parse(request.headers.get(CREDENTIALS_HEADER) ?? "null") as Credentials | null;
    if (!credentials) return new Response("Missing credentials", { status: 400 });
    const session = await this.session(credentials);
    if (!session) return Response.json({ error: "Sign in first" }, { status: 401 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [session.user.id, sessionTag(session.id)]);
    // On D1, signing out can end the session while the check above reads it, and close the session's
    // sockets before this one is among them. Now that it is, checking again settles it: the session
    // cache forgets a session as it starts ending, and doesn't keep a lookup an ending overlapped.
    // The welcome says who they are as this check reads them, since a change to them while the first
    // read was told only the sockets already in. It brings the workspace as it is now too, which may
    // have changed while the tab was without a socket.
    const [current, account] = await Promise.all([this.session(credentials), this.account()]);
    if (current) send(server, { type: "welcome", you: meOf(current), account: account ?? ACCOUNT_BEFORE_SETUP });
    else server.close(CloseCode.Reconnect, CLOSE_REASONS[CloseCode.Reconnect]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Answers a ping that the runtime doesn't, because it carries more than its type. A workspace socket sends nothing else. */
  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (isTooLarge(raw, MAX_WORKSPACE_FRAME_SIZE)) return closeTooLarge(ws);
    const frame = typeof raw === "string" ? parseWorkspaceClientFrame(raw) : null;
    send(ws, frame ? { type: "pong" } : { type: "error", message: "Unrecognized frame" });
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(RESERVED_CLOSE_CODES.has(code) ? 1000 : code, "Closing");
  }

  /** Sends `frame` on every workspace socket, written out once for them all. */
  private broadcast(frame: WorkspaceServerFrame): void {
    const data = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(data);
      } catch {
        // It has closed since, and its close handler has nothing to clean up.
      }
    }
  }

  /** Closes the workspace sockets tagged `tag`, with `code`, but those tagged `kept` too, if given. */
  private closeSockets(tag: string, code: CloseCode, kept?: string): void {
    for (const socket of this.ctx.getWebSockets(tag)) {
      if (kept !== undefined && this.ctx.getTags(socket).includes(kept)) continue;
      if (socket.readyState === WebSocket.OPEN) socket.close(code, CLOSE_REASONS[code]);
    }
  }

  /** Resolves once the workspace's database answers a query. */
  async health(): Promise<void> {
    await this.db.all("SELECT 1");
  }

  /**
   * Waits a while for a custom domain check's `probe`, which `takeProbe` then answers with `answer`.
   * There's one Workspace, which only this Ember reaches, so a domain that answers the probe reaches
   * this Ember (custom-domain.ts, `reachOf`). A check takes seconds, so probes are only kept in memory,
   * and only the latest few.
   */
  expectProbe(probe: string, answer: string): void {
    const now = Date.now();
    for (const [waiting, { until }] of this.probes) if (until <= now || this.probes.size >= WAITING_PROBES) this.probes.delete(waiting);
    this.probes.set(probe, { answer, until: now + PROBE_WAIT_MS });
  }

  /** The answer to a custom domain check's `probe`, once, while the Workspace waits for it, or null. */
  takeProbe(probe: string): string | null {
    const expected = this.probes.get(probe);
    this.probes.delete(probe);
    return expected !== undefined && expected.until > Date.now() ? expected.answer : null;
  }

  /** The workspace's account, or null until first run creates it. Its join code is only for the people in it. */
  async account(): Promise<Account | null> {
    const account = await this.joinableAccount();
    return account && this.shownAccount(account);
  }

  /**
   * `account` as every page shows it, with huddles on while the app they run through opens, as rooms
   * and the Huddles card have it (`openedHuddleApp`).
   */
  private async shownAccount(account: JoinableAccount): Promise<Account> {
    return accountOf(account, (await this.openedHuddleApp(account)) !== null);
  }

  private async joinableAccount(): Promise<JoinableAccount | null> {
    if (this.knownAccount) return this.knownAccount;
    const changes = this.accountChanges;
    const account = await this.store.account();
    if (changes === this.accountChanges) this.knownAccount = account;
    return account;
  }

  /**
   * What the join link with `code` does: "not found" unless `code` is the workspace's join code, which it
   * can't be before first run, "memberful" while Memberful is members only, which turns it off, and "off"
   * while an administrator has turned it off.
   */
  async joinLink(code: string): Promise<JoinLink> {
    const account = await this.joinableAccount();
    if (account === null || !isCode(code, account.joinCode)) return "not found";
    if (account.memberfulSignIn) return "memberful";
    return account.joinLink ? "joins" : "off";
  }

  /**
   * What the app asks first: the account, if it's set up, who `credentials` signs in, if anyone, whether
   * the sign-in page offers Sign in with Memberful at `memberfulSite`, the deployment's Memberful site, or
   * else at the one an administrator gave the keys of (`offersMemberfulSignIn`), and whether it offers to
   * email a code to reset a password, which it does while Ember can send email, and the site key of the
   * Turnstile widget an administrator gave Ember, while it has one (`savedTurnstileKeys`). A page opened
   * at `deployedAddress`, where a deploy puts Ember, which it's null anywhere else, tells Ember where that
   * is.
   */
  async bootstrap(
    credentials: Credentials | null,
    memberfulSite: string | null,
    deployedAddress: string | null,
  ): Promise<{ account: Account | null; user: Me | null; signInWithMemberful: boolean; passwordResetCodes: boolean; turnstileSiteKey: string | null }> {
    const [account, user, signInWithMemberful] = await Promise.all([
      this.joinableAccount(),
      credentials && this.me(credentials),
      this.offersMemberfulSignIn(memberfulSite),
      deployedAddress && this.rememberDeployedAddress(deployedAddress).catch((error) => console.error("Could not remember where a deploy puts Ember", error)),
    ]);
    const turnstile = account && (await this.openedTurnstileKeys(account));
    return {
      account: account && (await this.shownAccount(account)),
      user,
      signInWithMemberful,
      passwordResetCodes: account !== null && this.sendsEmail(account),
      turnstileSiteKey: turnstile?.siteKey ?? null,
    };
  }

  /**
   * Remembers `address` as where a deploy puts Ember, unless it's known already, as it is but once the
   * Worker's workers.dev address changes. Pages don't show it, so it changes nothing they'd hear of.
   */
  private async rememberDeployedAddress(address: string): Promise<void> {
    const known = await this.joinableAccount();
    if (known === null || known.deployedAddress === address) return;
    await this.oneAtATime(async () => {
      const account = await this.joinableAccount();
      if (account === null || account.deployedAddress === address) return;
      await this.storeAccount({ ...account, deployedAddress: address }, () => this.store.rememberDeployedAddress(address));
    });
  }

  /** Where a deploy puts Ember, as the latest page opened there told it, or null until one has. */
  async deployedAddress(): Promise<string | null> {
    return (await this.joinableAccount())?.deployedAddress ?? null;
  }

  /** Forgets `address` as a custom domain Ember moved away from, a check having found it no longer reaches Ember. */
  async forgetOtherAddress(address: string): Promise<void> {
    await this.oneAtATime(async () => {
      const account = await this.joinableAccount();
      if (!account?.otherAddresses.includes(address)) return;
      const otherAddresses = account.otherAddresses.filter((other) => other !== address);
      await this.storeAccount({ ...account, otherAddresses }, () => this.store.rememberOtherAddresses(otherAddresses));
    });
  }

  /**
   * Whether Sign in with Memberful is offered at `deployedSite`, the deployment's Memberful site, or
   * without its keys at the one an administrator gave Ember the keys of, if they did, and else never:
   * while Memberful lets the site's members join, or anyone here is linked to an account there, since
   * they keep signing in with it once it's off.
   */
  async offersMemberfulSignIn(deployedSite: string | null): Promise<boolean> {
    const account = await this.joinableAccount();
    const site = deployedSite ?? (account && (await this.openedMemberful(account)))?.site ?? null;
    if (site === null) return false;
    if (account?.memberfulJoin || this.linkedSites.has(site)) return true;
    const unlinkings = this.unlinkings;
    if (!(await this.store.anyoneLinked(site))) return false;
    // Until a new password or Disconnect unlinks the last account there (`forgetUnlinked`).
    if (unlinkings === this.unlinkings) this.linkedSites.add(site);
    return true;
  }

  /**
   * Forgets the sites nobody is linked to an account at anymore (`linkedSites`), once a new password or
   * Disconnect has unlinked accounts: the sign-in page stops offering Sign in with Memberful while
   * Memberful is off and nobody signs in with it.
   */
  private async forgetUnlinked(): Promise<void> {
    this.unlinkings++;
    for (const site of this.linkedSites) if (!(await this.store.anyoneLinked(site))) this.linkedSites.delete(site);
  }

  /**
   * Workspace settings as the person `credentials` signs in sees them: "not set up" before first run, or
   * null without a valid session. A guest isn't given the join link's code, since a member's account
   * they made with it would stay once guests are turned away, unless they're an administrator, who
   * could make a new code anyway. Memberful is as an administrator set it up, if they did. The Worker
   * adds the Cloudflare account it's deployed to, and has the deployment's Memberful and Turnstile keys
   * take the place of any an administrator gave, and the Workspace says how it sends email, since it's
   * what sends it.
   */
  async workspaceSettings(credentials: Credentials): Promise<Omit<WorkspaceSettings, "cloudflareAccountId"> | "not set up" | null> {
    const session = await this.session(credentials);
    if (!session) return null;
    const [account, canAdminister] = await Promise.all([this.joinableAccount(), this.store.isAdministrator(session.user.id)]);
    if (!account) return "not set up";
    const invitations = canAdminister ? await this.store.invitations() : [];
    return {
      account: await this.shownAccount(account),
      joinCode: canAdminister || !session.guest ? account.joinCode : null,
      canAdminister,
      ...(await this.memberfulSettings(account, canAdminister)),
      email: await this.emailSettings(account),
      turnstile: (await this.openedTurnstileKeys(account)) ? "saved" : null,
      invitations,
      emailDomains: canAdminister ? account.emailDomains : [],
      addresses: canAdminister ? { deployed: account.deployedAddress, others: account.otherAddresses } : { deployed: null, others: [] },
      assistant: canAdminister ? await this.assistantSettings(account) : null,
      huddles: canAdminister ? await this.huddlesSettings(account) : null,
      outsideAi: canAdminister && account.outsideAi,
    };
  }

  /**
   * Makes `changes` to the workspace as the person `credentials` signs in, answering the account as it
   * is then: "forbidden" unless they're an administrator, why it changes nothing, as `AccountRefusal`
   * has it, or null without a valid session. Members only turns Memberful on with it, and turning
   * Memberful off turns Members only off. Everyone's workspace sockets hear of a change, a new custom
   * domain included, which tabs open at another address then point to. Moving to one, Ember remembers
   * the custom domain it moves away from, and `host`, the address the change was asked at, as they reach
   * it too (`othersAfterMove`).
   */
  async changeAccount(
    credentials: Credentials,
    { name, tagline, settings, customDomain, navigationIcons, emailFrom, emailDomains }: AccountChanges,
    host: string,
  ): Promise<Account | AccountRefusal | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      // Only what differs is written.
      const { hideTranslationButtons, restrictRoomCreation, huddleCameras, huddleScreens, joinLink, openSignUp, emailDomainSignUp } = settings ?? {};
      const memberful = memberfulChange(account, settings ?? {});
      const icons = changedNavigationIcons(account.navigationIcons, navigationIcons ?? {});
      const moving = customDomain !== undefined && customDomain !== account.customDomain;
      const otherAddresses = moving ? othersAfterMove(account.otherAddresses, [account.customDomain, host], customDomain) : account.otherAddresses;
      const change: AccountChange = {
        ...(name !== undefined && name !== account.name && { name }),
        ...(tagline !== undefined && tagline !== account.tagline && { tagline }),
        ...(hideTranslationButtons !== undefined && hideTranslationButtons !== account.hideTranslationButtons && { hideTranslationButtons }),
        ...(restrictRoomCreation !== undefined && restrictRoomCreation !== account.restrictRoomCreation && { restrictRoomCreation }),
        ...(huddleCameras !== undefined && huddleCameras !== account.huddleCameras && { huddleCameras }),
        ...(huddleScreens !== undefined && huddleScreens !== account.huddleScreens && { huddleScreens }),
        ...(moving && { customDomain }),
        ...(!sameDomains(otherAddresses, account.otherAddresses) && { otherAddresses }),
        ...(joinLink !== undefined && joinLink !== account.joinLink && { joinLink }),
        ...(openSignUp !== undefined && openSignUp !== account.openSignUp && { openSignUp }),
        ...(memberful && { memberful }),
        ...(emailDomainSignUp !== undefined && emailDomainSignUp !== account.emailDomainSignUp && { emailDomainSignUp }),
        ...(emailDomains !== undefined && !sameDomains(emailDomains, account.emailDomains) && { emailDomains }),
        ...(icons && { navigationIcons: icons }),
        ...(emailFrom !== undefined && emailFrom !== account.emailFrom && { emailFrom }),
      };
      // Open lets anyone in, and Members only only Memberful's members, so neither is turned on while the other is.
      const open = change.openSignUp ?? account.openSignUp;
      const membersOnly = memberful?.memberfulSignIn ?? account.memberfulSignIn;
      if (open && membersOnly && (change.openSignUp || !account.memberfulSignIn)) return "conflict";
      if (Object.keys(change).length === 0) return this.shownAccount(account);
      const { memberful: _, ...settled } = change;
      const changed = { ...account, ...settled, ...memberful, navigationIcons: withNavigationIcons(account.navigationIcons, icons ?? {}) };
      // Email domain lets in no one without a domain, and emails the links people join with.
      const domainsChange = change.emailDomainSignUp !== undefined || change.emailDomains !== undefined;
      if (domainsChange && changed.emailDomainSignUp && changed.emailDomains.length === 0) return "no email domains";
      if (change.emailDomainSignUp && (await this.emailSender(changed)) === null) return "no email";
      const save = (now: string) => this.store.changeAccount(change, now);
      // Pages show neither the From address nor, while Email domain is off, its domains, so a change to
      // them alone, like a new join code, tells no one.
      if (Object.keys(change).every((key) => key === "emailFrom" || (key === "emailDomains" && !changed.emailDomainSignUp))) {
        return this.shownAccount(await this.saveAccount(changed, save));
      }
      return this.publishAccount(changed, save);
    });
  }

  /**
   * The workspace's custom CSS, for the Custom CSS page: "forbidden" unless the person `credentials`
   * signs in is an administrator, or null without a valid session.
   */
  async customStyles(credentials: Credentials): Promise<CustomStyles | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    const [account, administrator] = await Promise.all([this.joinableAccount(), this.store.isAdministrator(user.id)]);
    return administrator && account ? { customStyles: account.customStyles } : "forbidden";
  }

  /**
   * Saves `customStyles` as the workspace's custom CSS as the person `credentials` signs in, answering
   * the account as it is then: "forbidden" unless they're an administrator, or null without a valid
   * session. Undefined changes nothing, once that's checked. Everyone's workspace sockets hear of a
   * change.
   */
  async changeCustomStyles(credentials: Credentials, customStyles: string | undefined): Promise<Account | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      if (customStyles === undefined || customStyles === account.customStyles) return this.shownAccount(account);
      return this.publishAccount({ ...account, customStyles }, (now) => this.store.changeCustomStyles(customStyles, now));
    });
  }

  /**
   * Gives the join link a new code as the person `credentials` signs in, answering it: "forbidden"
   * unless they're an administrator, or null without a valid session.
   */
  async regenerateJoinCode(credentials: Credentials): Promise<NewJoinCode | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      const joinCode = newJoinCode();
      await this.saveAccount({ ...account, joinCode }, (now) => this.store.changeJoinCode(joinCode, now));
      return { joinCode };
    });
  }

  /**
   * Gives Ember `apiKey`, a Resend API key the Worker has checked with Resend, to send email with, kept
   * sealed under SESSION_SECRET (`seal`), or takes the one it has away with null, as the person
   * `credentials` signs in, answering how Ember sends email then: "forbidden" unless they're an
   * administrator, or null without a valid session. Pages show nothing of it, so no socket hears of it.
   */
  async changeResendApiKey(credentials: Credentials, apiKey: string | null): Promise<EmailSettings | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      if (apiKey === null && account.resendApiKey === null) return this.emailSettings(account);
      const resendApiKey = apiKey === null ? null : await seal(this.env.SESSION_SECRET, "resend-api-key", apiKey);
      return this.emailSettings(await this.saveAccount({ ...account, resendApiKey }, (now) => this.store.changeAccount({ resendApiKey }, now)));
    });
  }

  /** How Ember sends email, as Membership shows it, with the From address and Resend API key `account` has. */
  private async emailSettings(account: Pick<JoinableAccount, "emailFrom" | "resendApiKey">): Promise<EmailSettings> {
    const sender = await this.senderOf(account);
    const resendKey = sender?.provider !== "resend" ? null : sender.secret ? "secret" : "saved";
    return { provider: sender?.provider ?? null, resendKey, cloudflare: Boolean(this.env.EMAIL), from: account.emailFrom };
  }

  /** What sends Ember's email (`senderOf`), with the Resend API key `account` keeps sealed, while it opens. */
  private async senderOf(account: Pick<JoinableAccount, "resendApiKey">): Promise<Sender | null> {
    const sealed = account.resendApiKey;
    const savedKey = sealed === null ? null : await unseal(this.env.SESSION_SECRET, "resend-api-key", sealed);
    // Sealed under a SESSION_SECRET since changed, it's as if Ember had none, until an administrator gives it one again.
    if (sealed !== null && savedKey === null) console.error("The Resend API key Ember was given doesn't open under SESSION_SECRET, so it isn't used.");
    return senderOf(this.env, savedKey);
  }

  /** What sends the workspace's email, and the mailbox it comes from (`fromOf`), while Ember can send email from the From address `account` has, or else null. */
  private async emailSender(account: Pick<JoinableAccount, "name" | "emailFrom" | "resendApiKey">): Promise<{ sender: Sender; from: Mailbox } | null> {
    const from = fromOf(account);
    const sender = from === null ? null : await this.senderOf(account);
    return from && sender ? { sender, from } : null;
  }

  /**
   * Whether Ember can send email from the From address `account` has, as `emailSender` says, but without
   * opening a Resend API key an administrator gave it, as every page's first request asks: one sealed under
   * a SESSION_SECRET since changed counts, though it no longer sends.
   */
  private sendsEmail(account: Pick<JoinableAccount, "emailFrom" | "resendApiKey">): boolean {
    return account.emailFrom !== null && (account.resendApiKey !== null || senderOf(this.env, null) !== null);
  }

  /**
   * Gives Ember `keys`, the keys of a Turnstile widget whose check the Worker has seen pass with them, to
   * check people with, its secret key sealed under SESSION_SECRET (`seal`), or takes the ones it has away
   * with null, as the person `credentials` signs in, answering whether Ember keeps a widget's keys then:
   * "forbidden" unless they're an administrator, or null without a valid session. Only signed-out pages
   * show the site key, so no socket hears of it.
   */
  async changeTurnstileKeys(credentials: Credentials, keys: TurnstileKeys | null): Promise<{ saved: boolean } | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      if (keys === null && account.turnstileKeys === null) return { saved: false };
      const turnstileKeys = keys && { siteKey: keys.siteKey, sealedSecretKey: await seal(this.env.SESSION_SECRET, "turnstile-secret-key", keys.secretKey) };
      await this.saveAccount({ ...account, turnstileKeys }, (now) => this.store.changeAccount({ turnstileKeys }, now));
      return { saved: turnstileKeys !== null };
    });
  }

  /**
   * The keys of the Turnstile widget an administrator gave Ember, its secret key opened, which the Worker
   * checks people with while the deployment has none of its own, or null while there are none, or while
   * the secret key doesn't open under SESSION_SECRET, as once that's changed, when it's as if Ember had
   * none until an administrator gives it a widget's keys again.
   */
  async savedTurnstileKeys(): Promise<TurnstileKeys | null> {
    const account = await this.joinableAccount();
    return account && this.openedTurnstileKeys(account);
  }

  /** The Turnstile widget's keys `account` keeps, as `savedTurnstileKeys` has them. */
  private async openedTurnstileKeys(account: Pick<JoinableAccount, "turnstileKeys">): Promise<TurnstileKeys | null> {
    const saved = account.turnstileKeys;
    if (!saved) return null;
    const secretKey = await unseal(this.env.SESSION_SECRET, "turnstile-secret-key", saved.sealedSecretKey);
    if (secretKey === null) console.error("The Turnstile secret key Ember was given doesn't open under SESSION_SECRET, so it isn't used.");
    return secretKey === null ? null : { siteKey: saved.siteKey, secretKey };
  }

  /** The workspace's name while outside AI is on, or null while it's off, when none of its addresses answers. */
  async outsideAi(): Promise<{ name: string } | null> {
    const account = await this.joinableAccount();
    return account?.outsideAi ? { name: account.name } : null;
  }

  /**
   * Lets AI apps connect, or stops them, as the administrator `credentials` signs in, answering which:
   * "forbidden" for anyone else, or null without a valid session. Stopping them ends every connection
   * and forgets every app that registered, so turning it on again starts afresh.
   */
  async changeOutsideAi(credentials: Credentials, on: boolean): Promise<OutsideAiSettings | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      if (account.outsideAi !== on) await this.saveAccount({ ...account, outsideAi: on }, (now) => this.outside.turn(on, now));
      return { on };
    });
  }

  /**
   * Keeps `client`, an AI app registering itself from the IP address `ip`, under an id of its own,
   * which it answers with it: "off" while outside AI is, "limited" once that address has registered as
   * many as one may in an hour, or "full" when Ember keeps as many as it does.
   */
  async registerOutsideClient(client: Omit<OutsideClient, "id">, ip: string | null): Promise<OutsideClient | "off" | "limited" | "full"> {
    if (!(await this.outsideAi())) return "off";
    if (!this.outsideRegistrations.attempt(ip ?? "unknown")) return "limited";
    // One at a time with the switch, as `connectOutside` is, so no app is kept once turning outside AI off has forgotten them all.
    return this.oneAtATime(async () => {
      if (!(await this.outsideAi())) return "off";
      const registered = { id: alphanumeric(32), ...client };
      const now = Date.now();
      const kept = await this.outside.register(registered, new Date(now).toISOString(), MAX_OUTSIDE_CLIENTS, new Date(now - UNCONNECTED_CLIENT_MS).toISOString());
      return kept ? registered : "full";
    });
  }

  /** The AI app that registered itself as `id`, or null, or "off" while outside AI is. */
  async outsideClient(id: string): Promise<OutsideClient | "off" | null> {
    return (await this.outsideAi()) ? this.outside.client(id) : "off";
  }

  /** The person `credentials` signs in, who may connect an AI app as themselves, with the workspace's name: "off" while outside AI is, "forbidden" for a guest, or null without a valid session. */
  private async outsidePerson(credentials: Credentials): Promise<{ user: User; workspace: string } | "off" | "forbidden" | null> {
    const session = await this.session(credentials);
    if (!session) return null;
    const on = await this.outsideAi();
    if (!on) return "off";
    return session.guest ? "forbidden" : { user: session.user, workspace: on.name };
  }

  /** The workspace's name, for the page that asks the person `credentials` signs in whether to connect an AI app, or why they can't, as `outsidePerson` answers. */
  async outsideAsker(credentials: Credentials): Promise<{ workspace: string } | "off" | "forbidden" | null> {
    const person = await this.outsidePerson(credentials);
    return person && typeof person !== "string" ? { workspace: person.workspace } : person;
  }

  /**
   * Begins `begun`, a connection of an AI app as the person `credentials` signs in, who has just allowed
   * it: the app is sent back with the code whose digest it holds, good for a few minutes. "full" when
   * they have as many connections as one may, or why they can't, as `outsidePerson` answers.
   */
  async connectOutside(credentials: Credentials, begun: Omit<NewOutsideConnection, "id" | "userId" | "codeExpiresAt">): Promise<true | "full" | "off" | "forbidden" | null> {
    // One at a time with the switch, which other requests run beside on D1: a connection that began
    // after turning outside AI off had ended them all would be there when it's turned on again.
    return this.oneAtATime(async () => {
      const person = await this.outsidePerson(credentials);
      if (!person || typeof person === "string") return person;
      const now = Date.now();
      const connection = { ...begun, id: sortableId(), userId: person.user.id, codeExpiresAt: new Date(now + CODE_TTL_MS).toISOString() };
      return (await this.outside.begin(connection, new Date(now).toISOString(), MAX_OUTSIDE_CONNECTIONS)) || "full";
    });
  }

  /**
   * Gives the AI app that presents the code with the digest `codeDigest` its first tokens, `next`, and
   * answers what its connection allows, or null for a code that's no good: one Ember never gave, that
   * has expired, that another app was given, whose app can't prove it began the request (PKCE), or
   * that was asked for to connect somewhere other than the app now says. A code that comes a second
   * time has been copied, so the connection it began ends. "off" while outside AI is.
   */
  async exchangeOutsideCode(
    codeDigest: string,
    proof: { clientId: string; redirectUri: string | null; verifier: string; resource: string | null },
    next: NextOutsideTokens,
  ): Promise<{ scope: string } | "off" | null> {
    if (!(await this.outsideAi())) return "off";
    return this.oneAtATime(async () => {
      const connection = await this.outside.byCode(codeDigest);
      if (!connection || connection.clientId !== proof.clientId) return null;
      if (connection.exchanged) {
        await this.outside.forget(connection.id);
        return null;
      }
      if (proof.redirectUri !== null && proof.redirectUri !== connection.redirectUri) return null;
      if (proof.resource !== null && connection.resource !== null && proof.resource !== connection.resource) return null;
      if (!(await provesChallenge(proof.verifier, connection.codeChallenge))) return null;
      const now = Date.now();
      // An app that says only now where it connects to has its tokens bound to that.
      const exchanged = await this.outside.exchange(connection.id, outsideTokensAt(next, now), proof.resource, new Date(now).toISOString());
      return exchanged ? { scope: connection.scope } : null;
    });
  }

  /**
   * Gives the AI app `clientId`, which presents the refresh token with the digest `refreshDigest`, its
   * next tokens, `next`, in place of the ones it has, and answers what its connection allows, or null
   * for a refresh token that's no good. One that was used already has been copied, so its connection
   * ends. "off" while outside AI is.
   */
  async refreshOutside(refreshDigest: string, clientId: string, next: NextOutsideTokens): Promise<{ scope: string } | "off" | null> {
    if (!(await this.outsideAi())) return "off";
    return this.oneAtATime(async () => {
      const now = Date.now();
      const connection = await this.outside.byRefresh(refreshDigest);
      if (!connection) {
        await this.outside.forgetSpent(refreshDigest, new Date(now).toISOString());
        return null;
      }
      if (connection.clientId !== clientId || connection.refreshExpiresAt === null || connection.refreshExpiresAt <= new Date(now).toISOString()) return null;
      const rotated = await this.outside.rotate(connection.id, refreshDigest, outsideTokensAt(next, now), new Date(now).toISOString());
      return rotated ? { scope: connection.scope } : null;
    });
  }

  /** Ends the connection of the AI app `clientId` one of whose tokens has the digest `tokenDigest`, if there is one, as the app asks when it's disconnected there. */
  async revokeOutside(tokenDigest: string, clientId: string): Promise<void> {
    await this.outside.forgetByToken(tokenDigest, clientId);
  }

  /**
   * What the access token with the digest `accessDigest` lets its AI app do, and as whom, or null for
   * one that's no good: unknown, expired, or its person's no longer active. "off" while outside AI is.
   * It records that the app asked, to the hour.
   */
  async outsideAccess(accessDigest: string): Promise<OutsideAccess | "off" | null> {
    if (!(await this.outsideAi())) return "off";
    const now = Date.now();
    const connection = await this.outside.byAccess(accessDigest, new Date(now).toISOString());
    if (!connection) return null;
    if (connection.usedAt === null || Date.parse(connection.usedAt) <= now - OUTSIDE_USED_EVERY_MS) await this.outside.touch(connection.id, new Date(now).toISOString());
    return { connectionId: connection.id, userId: connection.userId, clientId: connection.clientId, scopes: outsideScopesOf(connection.scope), resource: connection.resource };
  }

  /** The AI apps connected as the person `userId`, newest first, as their profile lists them, or null when none can be: while outside AI is off for `account`, or for a `guest`. */
  private async yourOutsideAi(userId: UserId, guest: boolean, account: JoinableAccount | null): Promise<OutsideConnection[] | null> {
    if (guest || !account?.outsideAi) return null;
    return (await this.outside.connectionsOf(userId, new Date().toISOString())).map(shownConnection);
  }

  /** Ends the connection `id` of the person `credentials` signs in, answering the ones they have left: "not found" when it isn't theirs, or why not, as `outsidePerson` answers. */
  async disconnectOutside(credentials: Credentials, id: string): Promise<OutsideConnection[] | "not found" | "off" | "forbidden" | null> {
    const person = await this.outsidePerson(credentials);
    if (!person || typeof person === "string") return person;
    if (!(await this.outside.disconnect(person.user.id, id))) return "not found";
    return (await this.outside.connectionsOf(person.user.id, new Date().toISOString())).map(shownConnection);
  }

  /** The rooms `userId` is in, as an AI app connected as them lists them. */
  async outsideRooms(userId: UserId): Promise<SidebarRoom[]> {
    return (await this.store.roomsFor(userId)).rooms;
  }

  /** The rooms an AI app connected as `userId` may read and search: the ones they're in, those they've hidden and their direct messages too, as their own search has them. */
  async outsideReadable(userId: UserId): Promise<Room[]> {
    return (await this.store.searcherOf(userId, null)).rooms;
  }

  /**
   * The person `userId` as an AI app connected as them sends a message to room `roomId`, with when this
   * checked, as a room's socket has it: null unless they're in the room, or "limited" once their apps
   * have sent as many in a minute as they may.
   */
  async outsideSender(userId: UserId, roomId: RoomId): Promise<OutsideSender | "limited" | null> {
    // Before anything is read, as `roomAccess` takes it.
    const authorizedAt = Date.now();
    const [[user], { member }] = await Promise.all([this.store.peopleWithIds([userId]), this.store.roomAccess(roomId, userId, null)]);
    if (!user || !member) return null;
    return this.outsideSends.attempt(userId) ? { user, authorizedAt } : "limited";
  }

  /**
   * Gives Ember `keys`, the Memberful site and keys Set up Memberful was given, which the Worker has seen
   * Memberful take, their secrets sealed together under SESSION_SECRET (`seal`), as the person
   * `credentials` signs in, answering Memberful as Membership's card shows it then: "forbidden" unless
   * they're an administrator, null without a valid session, and the site Ember keeps when `keys` are for
   * another, since people here sign in with their accounts at it (`memberfulSiteKept`). Once anyone here
   * is linked to an account at the site, the daily check of their memberships is made due at once, as
   * when the Workspace starts, since none may have been checked with the keys before. Only signed-in
   * pages show the site, which they ask for, so no socket hears of it.
   */
  async changeMemberfulKeys(credentials: Credentials, keys: MemberfulKeysChange): Promise<MemberfulSaved | { kept: string } | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      const kept = await this.memberfulSiteKept(account);
      if (kept !== null && kept !== keys.site) return { kept };
      const memberfulKeys = { site: keys.site, clientId: keys.clientId, sealedSecrets: await sealMemberfulSecrets(this.env.SESSION_SECRET, keys) };
      const saved = await this.saveAccount({ ...account, memberfulKeys }, (now) => this.store.changeAccount({ memberfulKeys }, now));
      await this.store.startMembershipCatchUp(keys.site, Date.now());
      await this.scheduleDelivery();
      return this.memberfulSettings(saved, true);
    });
  }

  /**
   * The Memberful site and keys an administrator gave Ember in Set up Memberful, their secrets opened,
   * which the Worker signs members in with, and hears the site's webhooks with, while the deployment has
   * none of its own, or null while there are none, or while they don't open under SESSION_SECRET, as once
   * that's changed, when it's as if Ember had none until an administrator gives it them again.
   */
  async savedMemberful(): Promise<MemberfulSetup | null> {
    const account = await this.joinableAccount();
    return account && this.openedMemberful(account);
  }

  /** The Memberful site and keys `account` keeps, as `savedMemberful` has them. */
  private async openedMemberful(account: Pick<JoinableAccount, "memberfulKeys">): Promise<MemberfulSetup | null> {
    const saved = account.memberfulKeys;
    if (!saved) return null;
    const secrets = await openMemberfulSecrets(this.env.SESSION_SECRET, saved.sealedSecrets);
    if (secrets === null) console.error("The Memberful keys Ember was given don't open under SESSION_SECRET, so they aren't used.");
    return secrets && { site: saved.site, clientId: saved.clientId, ...secrets };
  }

  /**
   * What asking the Memberful site's admin API takes, as the Workspace checks memberships: the
   * deployment's keys, which take the place of any others, or else those an administrator gave, while
   * either has the API key.
   */
  private async memberfulApi(): Promise<MemberfulApi | null> {
    const deployed = deployedMemberfulOf(this.env);
    if (deployed) return memberfulApiOf(deployed);
    const account = await this.joinableAccount();
    return memberfulApiOf(account && (await this.openedMemberful(account)));
  }

  /**
   * Memberful as workspace settings show `account`'s, as an administrator set it up, which the Worker has
   * the deployment's keys take the place of, and for `administrator`, the site Set up Memberful keeps.
   */
  private async memberfulSettings(account: JoinableAccount, administrator: boolean): Promise<MemberfulSaved> {
    const memberful = await this.openedMemberful(account);
    return {
      memberfulSite: memberful?.site ?? null,
      memberfulWebhooks: memberfulWebhooksOf(memberful) !== null,
      memberfulKeys: memberful ? "saved" : null,
      memberfulSiteKept: administrator ? await this.memberfulSiteKept(account) : null,
    };
  }

  /**
   * The Memberful site Set up Memberful keeps, since people here sign in with their accounts at it, which
   * are linked to them by that site and their member id there, so that another site's members never sign
   * in as them: the site an administrator gave while anyone is linked at it, or else the site anyone is
   * linked at, as when the deployment's secrets gave the keys, even after keys for another were given.
   * Null while nobody is.
   */
  private async memberfulSiteKept(account: Pick<JoinableAccount, "memberfulKeys">): Promise<string | null> {
    const site = account.memberfulKeys?.site;
    if (site !== undefined && (this.linkedSites.has(site) || (await this.store.anyoneLinked(site)))) return site;
    return this.store.linkedSite();
  }

  /**
   * Whether an administrator has given keys for another Memberful site in place of those the Worker
   * signed someone in at `issuer` with, while it asked Memberful who they were, the deployment having
   * none of its own: linked then, they'd have an account nobody signs in with, at a site Set up Memberful
   * would keep (`memberfulSiteKept`). Asked one change at a time with giving keys, so one goes first.
   */
  private async memberfulSiteReplaced(issuer: string): Promise<boolean> {
    const site = deployedMemberfulOf(this.env)?.site ?? (await this.joinableAccount())?.memberfulKeys?.site;
    return site !== undefined && site !== issuer;
  }

  /**
   * Turns huddles on as the person `credentials` signs in, through the Realtime SFU app whose keys `app`
   * are, which the Worker has had Cloudflare start a session with, its secret sealed under SESSION_SECRET
   * (`seal`), or changes the app while they're on, or turns them off with null, which forgets the app's
   * keys, answering huddles as the Huddles card then shows them: "forbidden" unless they're an
   * administrator, or null without a valid session. Every page hears whether huddles are on, which is
   * what gives a room's header its huddle button, so every workspace socket hears the account.
   */
  async changeHuddles(credentials: Credentials, app: SfuApp | null): Promise<{ huddles: HuddlesSettings | null } | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      if (app === null && account.huddles === null) return { huddles: null };
      // The relay is the account's, by a key of its own, so huddles keep it through a change of app.
      const huddles = app && { appId: app.appId, sealedAppSecret: await seal(this.env.SESSION_SECRET, "sfu-app-secret", app.appSecret), relay: account.huddles?.relay ?? null };
      await this.publishAccount({ ...account, huddles }, (now) => this.store.changeAccount({ huddles }, now));
      return { huddles: await this.huddlesSettings({ huddles }) };
    });
  }

  /**
   * Gives huddles a relay as the person `credentials` signs in, by the TURN key `key`, which the Worker
   * has had Cloudflare make a relay's servers with, its API token sealed under SESSION_SECRET (`seal`),
   * or changes the key they have one by, or takes it away with null, which forgets the key, answering
   * huddles as the Huddles tab then shows them: "off" for a key given while huddles are off, which is
   * kept with the app they run through, "forbidden" unless they're an administrator, or null without a
   * valid session. A room asks what huddles run through afresh as a tab joins, so whoever joins one from
   * then on goes by the relay, or without it. Pages show nothing of it, so no socket hears of it.
   */
  async changeHuddleRelay(credentials: Credentials, key: RelayKey | null): Promise<{ huddles: HuddlesSettings | null } | "off" | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      const { huddles: saved } = account;
      if (saved === null || (await this.openedHuddleApp(account)) === null) return key === null ? { huddles: null } : "off";
      if (key === null && saved.relay === null) return { huddles: await this.huddlesSettings(account) };
      const relay = key && { keyId: key.keyId, sealedApiToken: await seal(this.env.SESSION_SECRET, "turn-key-api-token", key.apiToken) };
      const huddles = { ...saved, relay };
      return { huddles: await this.huddlesSettings(await this.saveAccount({ ...account, huddles }, (now) => this.store.changeAccount({ huddles }, now))) };
    });
  }

  /**
   * Huddles as the Huddles tab shows them: the SFU app they run through, by its ID, while `account` keeps
   * its keys, or null while it keeps none, or while the app's secret doesn't open under SESSION_SECRET,
   * as once that's changed, when it's as if huddles were off until an administrator sets them up again.
   * With it, the TURN key their relay goes by, by its ID, while its API token opens.
   */
  private async huddlesSettings(account: Pick<JoinableAccount, "huddles">): Promise<HuddlesSettings | null> {
    const app = await this.openedHuddleApp(account);
    return app && { appId: app.appId, relayKeyId: (await this.openedRelay(account))?.keyId ?? null };
  }

  /**
   * The Realtime SFU app huddles run through, with its secret opened, for a room to ask the SFU as,
   * whether cameras may go on in them and screens be shared, and the TURN key their relay goes by, with
   * its API token opened, for the room to ask Cloudflare for the relay's servers as, or null while
   * huddles are off. Rooms ask as a huddle goes on, so turning huddles off, or changing the app, ends
   * the ones under way, and turning cameras or screen sharing off takes down the ones that are on. The
   * secret and the token go no further than the room's memory.
   */
  async huddleApp(): Promise<HuddleApp | null> {
    const account = await this.joinableAccount();
    const app = account && (await this.openedHuddleApp(account));
    return account && app && { ...app, cameras: account.huddleCameras, screens: account.huddleScreens, relay: await this.openedRelay(account) };
  }

  /** The SFU app `account` keeps the keys of, with its secret opened, or null while it keeps none or the secret doesn't open. */
  private async openedHuddleApp({ huddles: saved }: Pick<JoinableAccount, "huddles">): Promise<SfuApp | null> {
    if (!saved) return null;
    const appSecret = await unseal(this.env.SESSION_SECRET, "sfu-app-secret", saved.sealedAppSecret);
    if (appSecret === null) console.error("The SFU app secret Ember was given doesn't open under SESSION_SECRET, so huddles are off.");
    return appSecret === null ? null : { appId: saved.appId, appSecret };
  }

  /** The TURN key `account`'s huddles have their relay by, with its API token opened, or null while they have none or the token doesn't open. */
  private async openedRelay({ huddles: saved }: Pick<JoinableAccount, "huddles">): Promise<RelayKey | null> {
    if (!saved?.relay) return null;
    const apiToken = await unseal(this.env.SESSION_SECRET, "turn-key-api-token", saved.relay.sealedApiToken);
    if (apiToken === null) console.error("The TURN key's API token Ember was given doesn't open under SESSION_SECRET, so huddles have no relay.");
    return apiToken === null ? null : { keyId: saved.relay.keyId, apiToken };
  }

  /**
   * Takes room `roomId`'s word for who's in its huddle, as the room reported it at `at` by its own clock:
   * `huddle`, or null once nobody is. Everyone in the room hears of a report that changes what the
   * Workspace keeps, in the huddle or not. A room's reports can arrive out of order, and one made no
   * later than the latest the Workspace has heard counts for nothing, whatever that one said: this
   * answers when that one was made, for the room to report again after it, and null otherwise.
   */
  async reportHuddle(roomId: RoomId, at: number, huddle: LiveHuddle | null): Promise<number | null> {
    const { memberIds, outdatedBy } = await this.store.reportHuddle(roomId, at, huddle);
    if (memberIds) this.tell(memberIds, { type: "room.huddle", roomId, huddle });
    return outdatedBy;
  }

  /**
   * Turns Ember AI on as the person `credentials` signs in, asking AI Gateway as `chosen` says, which the
   * Worker has had the model answer a test question with, its API token sealed under SESSION_SECRET
   * (`seal`), or changes it while it's on, or turns it off with null, answering Ember AI as the AI
   * assistant tab then shows it: "forbidden" unless they're an administrator, or null without a valid
   * session. Turning it on adds @ember, or lets it back as it was, in every open room, and turning it
   * off deactivates @ember, as deleting a bot does, and forgets the models people could pick. The agents
   * go and come back with it, each as it was. Everyone's workspace sockets hear of @ember either way, and
   * of the agents when it's turned on or off. A change that kept the API token Ember had, as
   * `keptToken` says, changes nothing ("changed") once that's no longer Ember's token: Ember AI was turned
   * off while the model answered, which forgot it, or set up again with another. What @ember may do on
   * the web stays as Search the web found it while the account, the model that answers everyone and its
   * format do (`webToolsKept`), and turns off otherwise, as setting Ember AI up after it was off does.
   */
  async changeAssistant(credentials: Credentials, chosen: ChosenModel | null, keptToken = false): Promise<{ assistant: AssistantSettings | null } | "forbidden" | "changed" | null> {
    return this.administerAccount(credentials, async (account) => {
      if (chosen === null && account.assistant === null) return { assistant: null };
      if (chosen && keptToken && (await this.openedAssistant(account))?.apiToken !== chosen.apiToken) return "changed";
      const assistant = chosen && {
        accountId: chosen.accountId,
        sealedApiToken: await seal(this.env.SESSION_SECRET, "ai-gateway-token", chosen.apiToken),
        model: chosen.model,
        format: chosen.format,
        models: modelsAfterSetup(account.assistant, chosen),
        ...webToolsKept(account.assistant, chosen, new Date().toISOString()),
        // The models it kept, and the agents' models, may answer through their providers' endpoints, as through another API token.
        providerEndpointsTriedAt: null,
      };
      this.assistantSetups++;
      const changed = await this.saveAccount({ ...account, assistant }, (now) => (assistant ? this.store.turnOnAssistant(assistant, now) : this.store.turnOffAssistant(now)));
      await this.publishPerson(ASSISTANT_ID);
      if ((account.assistant === null) !== (assistant === null)) await this.publishAgents();
      return { assistant: await this.assistantSettings(changed) };
    });
  }

  /**
   * Changes the most each of @ember's dials goes to for anyone's questions, which of the models people
   * can pick it answers everyone else with, what Ember adds to its instructions, and what it adds around
   * them, by `changes`, as the administrator `credentials` signs in, answering Ember AI as the AI
   * assistant tab then shows it: "off" while it's off, "not listed" for a model people can't pick,
   * "forbidden" for anyone else, and null without a valid session. Choosing another model turns Search
   * the web off, as Set up Ember AI choosing one does (`webToolsKept`).
   */
  async changeAssistantSettings(
    credentials: Credentials,
    { model, instructions, promptTemplate, ...levels }: AssistantChanges,
  ): Promise<{ assistant: AssistantSettings } | "off" | "not listed" | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      if (!account.assistant) return "off";
      const chosen = model === undefined ? null : account.assistant.models.find(({ id }) => id === model);
      if (chosen === undefined) return "not listed";
      const asked = chosen && { accountId: account.assistant.accountId, model: chosen.id, format: chosen.format };
      const assistant = asked ? { ...account.assistant, ...asked, ...webToolsKept(account.assistant, asked, new Date().toISOString()) } : account.assistant;
      return this.storeAssistant(account, assistant, { ...account.assistantMost, ...levels }, instructions, promptTemplate);
    });
  }

  /**
   * Changes what @ember may do on the web to `webTools`, as Search the web was asked to at `askedAt` while
   * Ember AI is on, as the administrator `credentials` signs in, answering Ember AI as the AI assistant tab
   * then shows it: "off" while it's off, "forbidden" for anyone else, and null without a valid session.
   * The change, whose tools Search the web found the model `tested` took, asks the models `moved` in the
   * formats they search in from then on, with the levels of thinking they take there, each that's still
   * in the format it was tested from, and changes nothing ("changed") once Ember AI answers everyone
   * through another account or with another model, or in another format than `tested`'s, or once a change
   * to Search the web asked for after it has been saved, as when it's turned off while the model searched,
   * which this change doesn't undo.
   */
  async changeAssistantWebTools(
    credentials: Credentials,
    webTools: WebTool[],
    tested: AskedAs | null,
    askedAt: string,
    moved: readonly MovedModel[] = [],
  ): Promise<{ assistant: AssistantSettings } | "off" | "changed" | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      const { assistant } = account;
      if (!assistant) return "off";
      if (tested && !isAskedAs(assistant, tested)) return "changed";
      if (assistant.webToolsAskedAt !== null && assistant.webToolsAskedAt > askedAt) return "changed";
      return this.storeAssistant(account, { ...movedIn(assistant, moved), webTools, webToolsAskedAt: askedAt });
    });
  }

  /**
   * Adds `model`, which the Worker has had answer a test question through Ember AI as `tested` asks AI
   * Gateway, to the models people can pick, or changes it there, as the administrator `credentials` signs
   * in, answering Ember AI as the AI assistant tab then shows it: "off" while it's off, "changed" once it
   * asks with another account or API token than `tested`'s, as after it was turned off and set up again
   * while the model answered, "full" when people can pick as many as they can already, "forbidden" for
   * anyone else, and null without a valid session.
   */
  async addAssistantModel(
    credentials: Credentials,
    model: SavedModel,
    tested: Pick<Gateway, "accountId" | "apiToken">,
  ): Promise<{ assistant: AssistantSettings } | "off" | "changed" | "full" | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      const { assistant } = account;
      if (!assistant) return "off";
      const opened = await this.openedAssistant(account);
      if (!opened || opened.accountId !== tested.accountId || opened.apiToken !== tested.apiToken) return "changed";
      const listed = assistant.models.some(({ id }) => id === model.id);
      if (!listed && assistant.models.length >= MAX_ASSISTANT_MODELS) return "full";
      const models = listed ? assistant.models.map((kept) => (kept.id === model.id ? model : kept)) : [...assistant.models, model];
      // The one that answers everyone took its test question in this format now, which Search the web may not have tried.
      const asked = { accountId: assistant.accountId, model: model.id, format: model.format };
      const everyone = model.id === assistant.model && { format: model.format, ...webToolsKept(assistant, asked, new Date().toISOString()) };
      return this.storeAssistant(account, { ...assistant, models, ...everyone });
    });
  }

  /**
   * Takes model `modelId` out of the models people can pick, as the administrator `credentials` signs in,
   * answering Ember AI as the AI assistant tab then shows it: "off" while it's off, "everyone's" for the
   * one @ember answers everyone else with, which stays, "forbidden" for anyone else, and null without a
   * valid session. Whoever picked it has @ember answer them with that one then.
   */
  async removeAssistantModel(credentials: Credentials, modelId: string): Promise<{ assistant: AssistantSettings } | "off" | "everyone's" | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      const { assistant } = account;
      if (!assistant) return "off";
      if (modelId === assistant.model) return "everyone's";
      const models = assistant.models.filter(({ id }) => id !== modelId);
      if (models.length === assistant.models.length) return { assistant: (await this.assistantSettings(account))! };
      return this.storeAssistant(account, { ...assistant, models });
    });
  }

  /**
   * Stores Ember AI as `assistant` has it, while it's on, the most of each dial as `most`, what Ember adds
   * to @ember's instructions as `instructions`, and what it adds around them as `promptTemplate`,
   * answering Ember AI as the AI assistant tab then shows it.
   */
  private async storeAssistant(
    account: JoinableAccount,
    assistant: SavedAssistant,
    most = account.assistantMost,
    instructions = account.assistantInstructions,
    promptTemplate = account.assistantPromptTemplate,
  ): Promise<{ assistant: AssistantSettings }> {
    const changed = await this.storeAccount({ ...account, assistant, assistantMost: most, assistantInstructions: instructions, assistantPromptTemplate: promptTemplate }, () =>
      this.store.changeAssistant(assistant, most, instructions, promptTemplate),
    );
    return { assistant: (await this.assistantSettings(changed))! };
  }

  /**
   * Gives @ember `avatar`, which R2 has stored under a key `reservePicture` reserved, in place of Ember's
   * flame or the one it had, or takes the one it was given away with null, bringing back the flame, as the
   * administrator `credentials` signs in, answering Ember AI as the AI assistant tab then shows it: "off"
   * while it's off, "forbidden" for anyone else, and null without a valid session. R2 deletes the avatar
   * it had, and everyone's workspace sockets hear of the change, which gives @ember's avatar a new address.
   * The avatar stays while Ember AI is off, as @ember's messages do.
   */
  async changeAssistantAvatar(credentials: Credentials, avatar: StoredPicture | null): Promise<{ assistant: AssistantSettings } | "off" | "forbidden" | null> {
    return this.inALaterSecond(() =>
      this.administerAccount(credentials, async (account) => {
        if (!account.assistant) return "off";
        // Turning Ember AI on adds @ember, so it's there.
        const ember = (await this.store.personWithAvatar(ASSISTANT_ID))!;
        const previous = ember.avatar?.key ?? null;
        // Taking away an avatar that isn't there changes nothing.
        if (avatar !== null || previous !== null) {
          const now = Date.now();
          const tooSoon = tooSoonAfter(ember.updatedAt, now);
          if (tooSoon) return tooSoon;
          await this.store.changeAvatar(ASSISTANT_ID, avatar, previous, new Date(now).toISOString(), now);
          if (previous) await this.wakeAt(now);
          await this.publishPerson(ASSISTANT_ID);
        }
        return { assistant: (await this.assistantSettings(account))! };
      }),
    );
  }

  /**
   * Ember AI as the AI assistant tab shows `account`'s to administrators, with @ember's avatar, or null
   * while it's off. Turning it on adds @ember, in the batch that saves it, so it's there while it's on.
   */
  private async assistantSettings(account: AssistantAccount): Promise<AssistantSettings | null> {
    const settings = assistantSettingsOf(account);
    if (!settings) return null;
    const ember = await this.store.personWithAvatar(ASSISTANT_ID);
    if (!ember) throw new Error("Ember AI is on without @ember");
    const { avatarUrl } = await this.directoryUser(ember);
    return { ...settings, avatarUrl, avatar: ember.avatar !== null };
  }

  /**
   * Changes how much @ember thinks and how long it answers the person `credentials` signs in, and the
   * model it answers them with, by `changes`, answering @ember's answers to them as their profile then
   * shows them: "not listed" for a model people can't pick, which changes nothing, or null without a
   * valid session. A null model leaves theirs to administrators, whichever they choose, while a model
   * stays theirs, even the one @ember answers everyone with, and is kept only while Ember AI is on, when
   * there are models to pick.
   */
  async changeYourAssistant(credentials: Credentials, changes: YourAssistantChanges): Promise<{ assistant: YourAssistant | null } | "not listed" | null> {
    const session = await this.session(credentials);
    if (!session) return null;
    const { model, ...levels } = changes;
    const assistant = (await this.joinableAccount())?.assistant;
    if (typeof model === "string" && assistant && !assistant.models.some(({ id }) => id === model)) return "not listed";
    const picked = model === undefined || !assistant ? levels : { ...levels, model };
    await this.store.changeAssistantPicks(session.user.id, picked);
    const [account, picks] = await Promise.all([this.joinableAccount(), this.store.assistantPicks(session.user.id)]);
    return { assistant: yourAssistantOf(account, picks) };
  }

  /**
   * How Ember AI asks AI Gateway, its API token opened, with what the model that answers everyone is
   * called, while it's on, or else null, as when the token doesn't open under SESSION_SECRET, once that's
   * changed, until an administrator sets it up again.
   */
  async assistantGateway(): Promise<(Gateway & { name: string }) | null> {
    const assistant = (await this.joinableAccount())?.assistant;
    if (!assistant) return null;
    const gateway = await this.openedAssistant({ assistant });
    return gateway && { ...gateway, name: modelName(gateway.model, assistant.models) };
  }

  /** The models people can pick from while Ember AI is on, the one that answers everyone among them, or none while it's off. */
  async assistantModels(): Promise<SavedModel[]> {
    return (await this.joinableAccount())?.assistant?.models ?? [];
  }

  /** The models file the Workspace last read, and where, if it has (see `modelsFileOf`). */
  async keptModelsFile(): Promise<KeptModelsFile | null> {
    return (await this.ctx.storage.get<KeptModelsFile>(KEPT_MODELS_FILE)) ?? null;
  }

  /**
   * Keeps `kept` for the listings and answers that follow, in place of the models file kept before, but
   * for the file itself when `kept` couldn't read one at the same address, as another read may have since.
   */
  async keepModelsFile(kept: KeptModelsFile): Promise<void> {
    const before = kept.read ? null : await this.keptModelsFile();
    await this.ctx.storage.put(KEPT_MODELS_FILE, before?.url === kept.url ? { ...kept, file: before.file } : kept);
  }

  /** Workers AI's models the model search last listed for the account `accountId`, and when, if they're the ones kept. */
  async keptWorkersAiModels(accountId: string): Promise<KeptWorkersAiModels | null> {
    const kept = await this.ctx.storage.get<KeptWorkersAiModels>(KEPT_WORKERS_AI_MODELS);
    return kept?.accountId === accountId ? kept : null;
  }

  /** Keeps `kept` for the listings and answers that follow, in place of the models kept before, whatever their account. */
  async keepWorkersAiModels(kept: KeptWorkersAiModels): Promise<void> {
    await this.ctx.storage.put(KEPT_WORKERS_AI_MODELS, kept);
  }

  /** Forgets Workers AI's models kept for the account `accountId`, if they're the ones kept. */
  async forgetWorkersAiModels(accountId: string): Promise<void> {
    if ((await this.keptWorkersAiModels(accountId)) !== null) await this.ctx.storage.delete(KEPT_WORKERS_AI_MODELS);
  }

  /**
   * What answers through the Cloudflare account `accountId` go by of the models Ember offers: the models
   * the models file the Workspace last read lists, from where this Ember reads it, or else the one it
   * shipped with, and Workers AI's that the model search last listed for that account, as they're kept.
   */
  private async offeredForAnswers(accountId: string): Promise<{ file: readonly OfferedModel[]; workersAi: readonly OfferedModel[] }> {
    const [file, workersAi] = await Promise.all([this.keptModelsFile(), this.keptWorkersAiModels(accountId)]);
    const read = file?.url === modelsFileUrlOf(this.env) ? file?.file : null;
    return { file: read?.models ?? ASSISTANT_MODELS, workersAi: workersAi?.models ?? [] };
  }

  /** How Ember AI asks AI Gateway as `account` keeps it, as `assistantGateway` answers it. */
  private async openedAssistant({ assistant: saved }: Pick<JoinableAccount, "assistant">): Promise<Gateway | null> {
    if (!saved) return null;
    const apiToken = await unseal(this.env.SESSION_SECRET, "ai-gateway-token", saved.sealedApiToken);
    if (apiToken === null) console.error("The API token Ember AI was given doesn't open under SESSION_SECRET, so it isn't used.");
    return apiToken === null ? null : { accountId: saved.accountId, apiToken, model: saved.model, format: saved.format };
  }

  /**
   * Sends the person `credentials` signs in a test email, at their email address, from the workspace's
   * From address, as Membership's Send me a test email does, answering the address it went to, or why it
   * wasn't sent, as `TestEmail` has it: "forbidden" unless they're an administrator, or null without a
   * valid session. `origin` is Ember's address, which the email names.
   */
  async sendTestEmail(credentials: Credentials, origin: string): Promise<TestEmail | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    const [account, administrator, person] = await Promise.all([this.joinableAccount(), this.store.isAdministrator(user.id), this.store.personWithProfile(user.id)]);
    if (!account || !administrator) return "forbidden";
    const sender = await this.senderOf(account);
    if (sender === null) return { status: 503, refusal: CANT_SEND_EMAIL };
    const from = fromOf(account);
    if (!from) return { status: 422, refusal: NO_EMAIL_FROM };
    if (!person?.emailAddress) return { status: 422, refusal: NO_EMAIL_ADDRESS };
    const refusal = await sendEmail(sender, from, testEmail(person.emailAddress, account.name, origin));
    return refusal === null ? { to: person.emailAddress } : { status: 502, refusal };
  }

  /**
   * Invites each address in `invitations`, with the link its secret makes, as the person `credentials`
   * signs in, answering what came of each, in order: "forbidden" unless they're an administrator, or null
   * without a valid session. An address someone has an account with already, whatever its case, isn't
   * invited, and one invited already gets a new link in place of its old one. The links are emailed from
   * the From address while Ember can send email, and the answer holds each one that wasn't, for the
   * administrator to send themselves. `origin` is Ember's address, where links go.
   */
  async invite(credentials: Credentials, invitations: Array<{ emailAddress: string; link: NewEmailLink }>, origin: string): Promise<Invited | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    const times = invitationTimes();
    // Saved one at a time, as people join, but sent afterwards, so that sending never holds up a join.
    const saved = await this.oneAtATime(async () => {
      if (!(await this.store.isAdministrator(user.id))) return "forbidden";
      const taken = await this.store.takenEmailAddresses(invitations.map(({ emailAddress }) => emailAddress));
      const inviting = invitations.filter(({ emailAddress }) => !taken.has(emailAddress.toLowerCase()));
      const links = inviting.map(({ emailAddress, link }) => ({ id: sortableId(), emailAddress, tokenDigest: link.digest }));
      const ids = await this.store.saveInvitations(links, user.id, times.createdAt, times.expiresAt);
      return { account: (await this.joinableAccount())!, inviting: inviting.map((invitation, index) => ({ ...invitation, ...times, id: ids[index]! })) };
    });
    if (saved === "forbidden") return saved;
    const delivered = new Map((await this.deliverInvitations(saved.account, user, saved.inviting, origin)).map((sent) => [sent.invitation.emailAddress, sent]));
    return {
      outcomes: invitations.map(({ emailAddress }) => {
        const sent = delivered.get(emailAddress);
        return sent ? { emailAddress, ...sent } : { emailAddress, member: true };
      }),
    };
  }

  /**
   * Gives the invitation with `id` a new link, the one `link`'s secret makes, in place of its old one, as
   * the person `credentials` signs in, and emails it as `invite` does, answering the invitation with the
   * link if it wasn't emailed: "not found" once it's been accepted or revoked, "forbidden" unless they're
   * an administrator, or null without a valid session.
   */
  async resendInvitation(credentials: Credentials, id: string, link: NewEmailLink, origin: string): Promise<ResentInvitation | "not found" | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    const times = invitationTimes();
    const renewed = await this.oneAtATime(async () => {
      if (!(await this.store.isAdministrator(user.id))) return "forbidden";
      const emailAddress = await this.store.renewInvitation(id, link.digest, user.id, times.createdAt, times.expiresAt);
      return emailAddress === null ? "not found" : { account: (await this.joinableAccount())!, emailAddress };
    });
    if (typeof renewed === "string") return renewed;
    const [resent] = await this.deliverInvitations(renewed.account, user, [{ id, emailAddress: renewed.emailAddress, link, ...times }], origin);
    return resent!;
  }

  /**
   * Revokes the invitation with `id` as the person `credentials` signs in, so that its link joins no
   * more: "not found" once it's been accepted or revoked, "forbidden" unless they're an administrator, or
   * null without a valid session.
   */
  async revokeInvitation(credentials: Credentials, id: string): Promise<"revoked" | "not found" | "forbidden" | null> {
    return this.administerAccount(credentials, async () => ((await this.store.revokeInvitation(id)) ? "revoked" : "not found"));
  }

  /**
   * Emails each of `invitations`, from `inviter`, with its link at `origin`, from the workspace's From
   * address while Ember can send email, and records what came of it, answering each invitation as
   * administrators see it, with its link when it wasn't emailed.
   */
  private async deliverInvitations(
    account: JoinableAccount,
    inviter: User,
    invitations: SavedInvitation[],
    origin: string,
  ): Promise<Array<{ invitation: EmailInvitation; link: string | null }>> {
    const sending = await this.emailSender(account);
    const links = invitations.map(({ link }) => `${origin}${invitationLink(link.token)}`);
    const emails = invitations.map(({ emailAddress }, index) => invitationEmail(emailAddress, account.name, inviter.name, links[index]!));
    const refusals = sending ? await sendEmails(sending.sender, sending.from, emails) : null;
    if (refusals) await this.store.recordDeliveries(invitations.map(({ link }, index) => ({ tokenDigest: link.digest, refusal: refusals[index] ?? null })), new Date().toISOString());
    return invitations.map(({ id, emailAddress, createdAt, expiresAt }, index) => {
      const refusal = refusals?.[index] ?? null;
      const delivery = refusals === null ? null : refusal === null ? "sent" : { refusal };
      return { invitation: { id, emailAddress, invitedBy: inviter.name, createdAt, expiresAt, delivery }, link: delivery === "sent" ? null : links[index]! };
    });
  }

  /**
   * What the link whose secret has the digest `linkDigest` is, and whom it's for, while it works, which
   * looking spends nothing of, or else null: an invitation's until it expires, or one someone asked for
   * with an address at the email domains while Email domain still lets its domain in, too.
   */
  async emailLinkFor(linkDigest: string): Promise<EmailLinkFor | null> {
    const link = await this.workingEmailLink(linkDigest);
    return link && { kind: link.kind, emailAddress: link.emailAddress };
  }

  /** The link whose secret has the digest `linkDigest`, while it works, as `emailLinkFor` says, with who sent it, if it's an invitation. */
  private async workingEmailLink(linkDigest: string): Promise<{ kind: EmailLinkKind; emailAddress: string; invitedBy: UserId | null } | null> {
    const [link, account] = await Promise.all([this.store.emailLinkFor(linkDigest, new Date().toISOString()), this.joinableAccount()]);
    if (link?.kind !== "email_domain") return link;
    const domain = domainOfEmailAddress(link.emailAddress);
    return account !== null && domain !== null && letsInEmailDomain(account, domain) ? link : null;
  }

  /**
   * Gives the workspace `logo`, which R2 has stored under a key `reservePicture` reserved, or takes its
   * logo away with null, as the person `credentials` signs in, answering the account as it is then:
   * "forbidden" unless they're an administrator, or null without a valid session. R2 deletes the logo it
   * had, and everyone's workspace sockets hear of the change, which gives the logo a new address.
   */
  async changeLogo(credentials: Credentials, logo: StoredPicture | null): Promise<Account | "forbidden" | null> {
    return this.administerAccount(credentials, async (account) => {
      // Removing a logo that isn't there changes nothing.
      if (logo === null && account.storedLogo === null) return this.shownAccount(account);
      const previous = account.storedLogo?.key ?? null;
      const shown = await this.publishAccount({ ...account, storedLogo: logo }, (now) => this.store.changeLogo(logo, previous, now, Date.parse(now)));
      if (previous) await this.wakeAt(Date.now());
      return shown;
    });
  }

  /** The workspace's logo as R2 keeps it, or null while it has none, as before first run. */
  async logo(): Promise<StoredPicture | null> {
    return (await this.joinableAccount())?.storedLogo ?? null;
  }

  /**
   * Changes the account with `change`, one change at a time, if `credentials` signs in an administrator
   * as they are then: "forbidden" if it signs in anyone else, or null without a valid session.
   */
  private async administerAccount<T>(credentials: Credentials, change: (account: JoinableAccount) => Promise<T>): Promise<T | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.oneAtATime(async () => {
      if (!(await this.store.isAdministrator(user.id))) return "forbidden";
      // First run made the account with its first administrator.
      return change((await this.joinableAccount())!);
    });
  }

  /**
   * Saves a change to what every page shows of the account, as `saveAccount` does, then tells every
   * workspace socket, so pages show it at once. Answers the account as it is now.
   */
  private async publishAccount(account: JoinableAccount, save: (now: string) => Promise<void>): Promise<Account> {
    const shown = await this.shownAccount(await this.saveAccount(account, save));
    this.broadcast({ type: "account.updated", account: shown });
    return shown;
  }

  /** Saves the account as `account` with `save`, remembering it as that, changed now, once it's saved, and answering it. */
  private saveAccount(account: JoinableAccount, save: (now: string) => Promise<void>): Promise<JoinableAccount> {
    const now = new Date().toISOString();
    return this.storeAccount({ ...account, updatedAt: now }, () => save(now));
  }

  /** Stores the account as `account` with `store`, remembering it as that once it's stored, and answering it. */
  private async storeAccount(account: JoinableAccount, store: () => Promise<void>): Promise<JoinableAccount> {
    this.accountChanges++;
    try {
      await store();
    } catch (error) {
      // On D1 a change can be saved and its answer lost, so the account is read again.
      this.knownAccount = null;
      throw error;
    } finally {
      this.accountChanges++;
    }
    return (this.knownAccount = account);
  }

  /**
   * Creates the workspace, its first administrator, the open rooms general and random, and the session
   * their cookie's token opens, answering general, which opens. A room of either name that the workspace
   * has open already, such as one `LEGACY_ROOMS` registered, stands in for it. Answers null if the
   * workspace exists.
   */
  async createWorkspace(administrator: Omit<NewPerson, "id">, tokenDigest: string, client: Client): Promise<NewWorkspace | null> {
    if (await this.account()) return null;
    const session: StoredSession = {
      id: sortableId(),
      user: { id: sortableId(), name: administrator.name },
      administrator: true,
      guest: false,
      lastActiveAt: Date.now(),
    };
    const account = { id: sortableId(), name: ACCOUNT_NAME, joinCode: newJoinCode() };
    // Ids sort in the order they're made, which makes general the older of two rooms made at once.
    const rooms = FIRST_ROOM_NAMES.map((name) => ({ id: sortableId(), name }));
    const now = new Date(session.lastActiveAt).toISOString();
    let room: SharedRoom;
    try {
      room = await this.store.createWorkspace(account, { ...administrator, id: session.user.id }, rooms, session.id, tokenDigest, client, now);
    } catch (error) {
      // On D1 two first runs can overlap, and the account's singleton guard refuses the second.
      if (await this.store.account()) return null;
      throw error;
    }
    this.knownAccount = {
      name: account.name,
      joinCode: account.joinCode,
      ...NEW_ACCOUNT_LOOKS,
      updatedAt: now,
      storedLogo: null,
      emailFrom: null,
      resendApiKey: null,
      turnstileKeys: null,
      memberfulKeys: null,
      assistant: null,
      assistantMost: TOP_LEVELS,
      assistantInstructions: "",
      assistantPromptTemplate: null,
      huddles: null,
      outsideAi: false,
      deployedAddress: null,
      otherAddresses: [],
    };
    this.sessions.remember(tokenDigest, session);
    return { user: meOf(session), room };
  }

  /**
   * Adds someone who joined with the join link for `code` as a member, in every open room, and the
   * session their cookie's token opens. Everyone's workspace sockets hear of them, so pages already open
   * know them. Answers "not found" if `code` isn't the join code, "memberful" while Memberful is members
   * only, "off" while the link is off, "agent's name" for a name that's an agent's (`takesAgentsName`),
   * and null if someone already has their email address.
   */
  async join(code: string, person: Omit<NewPerson, "id">, tokenDigest: string, client: Client): Promise<Me | Exclude<JoinLink, "joins"> | "agent's name" | null> {
    // The Worker checked the link before the form arrived, but it may have been regenerated or turned off since.
    return this.oneAtATime(async () => {
      const link = await this.joinLink(code);
      return link === "joins" ? this.addMember(person, tokenDigest, client) : link;
    });
  }

  /**
   * Adds someone who joined with the link of `kind` whose secret has the digest `linkDigest`, with the
   * email address it's for, as `join` adds someone with the join link, spending the link: an invitation's
   * whichever ways to join are on, recording who sent it, or one they asked for at the email domains
   * while Email domain lets its domain in. Answers "gone" once the link doesn't work, having expired,
   * been used or replaced, an invitation's having been revoked, "agent's name" for a name that's an
   * agent's, and null if someone has its email address already, whatever its case, which leaves it be.
   */
  async joinWithEmailLink(
    kind: EmailLinkKind,
    linkDigest: string,
    person: Omit<NewPerson, "id" | "emailAddress">,
    tokenDigest: string,
    client: Client,
  ): Promise<Me | "gone" | "agent's name" | null> {
    // One at a time, so that two joins with the same link can't both add someone.
    return this.oneAtATime(async () => {
      const link = await this.workingEmailLink(linkDigest);
      if (link?.kind !== kind) return "gone";
      if ((await this.store.takenEmailAddresses([link.emailAddress])).size > 0) return null;
      return this.addMember({ ...person, emailAddress: link.emailAddress, ...(link.invitedBy !== null && { invitedBy: link.invitedBy }) }, tokenDigest, client);
    });
  }

  /**
   * Emails `emailAddress` a link to join with it, the one `link`'s secret makes, at `origin`, while Email
   * domain lets in `domain`, its domain, which takes the place of any it was sent before once the
   * provider has the email, unless they've joined since, or, if someone has an account with it already,
   * whatever its case, an email saying so, with a link to sign in. Asks from `ip` count against its limit
   * while they're `limited`, as they are while Ember lacks Turnstile's keys. Once the address has been
   * emailed as often as it is in an hour, an ask sends nothing, though it answers "asked", as it does for
   * an address with an account, so that the answer never says who has one, and the link sent last still
   * works. An email the provider refuses reaches nobody, so it isn't counted, and changes no link.
   */
  async askForEmailLink(ip: string, emailAddress: string, domain: string, link: NewEmailLink, origin: string, limited: boolean): Promise<EmailLinkAsk> {
    const account = await this.joinableAccount();
    if (account === null || !letsInEmailDomain(account, domain)) return "off";
    const sending = await this.emailSender(account);
    if (sending === null) return "unsendable";
    if (limited && !this.emailLinkAsks.attempt(ip)) return "limited";
    const now = Date.now();
    // Counted one at a time, as people join, but sent afterwards, so that sending never holds up a join.
    const asked = await this.oneAtATime(async () => {
      const current = (await this.joinableAccount())!;
      if (!letsInEmailDomain(current, domain)) return "off";
      const { count, countedSince } = await this.store.countEmailRequest(emailAddress, new Date(now).toISOString(), new Date(now - EMAIL_ASK_WINDOW_MS).toISOString());
      if (count > EMAILS_PER_ADDRESS) {
        // The count is of the emails sent, or being sent, so that one the provider refuses frees a place.
        await this.store.uncountEmailRequest(emailAddress, countedSince);
        return "enough";
      }
      return { name: current.name, member: (await this.store.takenEmailAddresses([emailAddress])).size > 0, countedSince };
    });
    if (asked === "off") return "off";
    if (asked === "enough") return "asked";
    const email = asked.member
      ? alreadyAMemberEmail(emailAddress, asked.name, `${origin}/session/new?${new URLSearchParams({ email_address: emailAddress })}`)
      : emailDomainLinkEmail(emailAddress, asked.name, `${origin}${emailSignUpLink(link.token)}`);
    if ((await sendEmail(sending.sender, sending.from, email)) !== null) {
      await this.store.uncountEmailRequest(emailAddress, asked.countedSince);
      return "unsent";
    }
    if (asked.member) return "asked";
    // Saved one at a time, as people join, so that someone who joined as it was sent gets no link to join with again.
    await this.oneAtATime(async () => {
      if ((await this.store.takenEmailAddresses([emailAddress])).size > 0) return;
      await this.store.saveEmailDomainLink(sortableId(), emailAddress, link.digest, new Date(now).toISOString(), new Date(now + EMAIL_DOMAIN_LINK_MS).toISOString());
    });
    return "asked";
  }

  /**
   * Counts an open sign-up from `ip` against its limit, while sign-ups are `limited`, as they are while
   * Ember lacks Turnstile's keys, then checks it can go on, all before the Worker hashes its password:
   * "closed" unless anyone may sign up, "limited" past the address's limit, "full" once the workspace
   * has let in as many new people as it does in an hour, "taken" if someone has the email address
   * already, and else "begun".
   */
  async beginSignUp(ip: string, emailAddress: string, limited: boolean): Promise<SignUpRefusal | "limited" | "taken" | "begun"> {
    const account = await this.joinableAccount();
    if (account === null || !signsUpOpenly(account)) return "closed";
    if (limited && !this.signUps.attempt(ip)) return "limited";
    if (limited && (await this.signUpsFull())) return "full";
    return (await this.store.hasEmailAddress(emailAddress)) ? "taken" : "begun";
  }

  /**
   * Adds someone who signed up while anyone may as a member, as `join` adds someone with the join link.
   * Answers "closed" if sign-up has closed since it began, "full" if sign-ups are `limited` and the
   * hour's new people have filled them since, "agent's name" for a name that's an agent's, and null if
   * someone already has their email address.
   */
  async signUp(person: Omit<NewPerson, "id">, tokenDigest: string, client: Client, limited: boolean): Promise<Me | SignUpRefusal | "agent's name" | null> {
    // One at a time, so that the hour's sign-ups never pass the limit together.
    return this.oneAtATime(async () => {
      const account = await this.joinableAccount();
      if (account === null || !signsUpOpenly(account)) return "closed";
      if (limited && (await this.signUpsFull())) return "full";
      return this.addMember(person, tokenDigest, client);
    });
  }

  /** Whether the workspace has let in as many new people in the last hour as open sign-up lets in, bots aside. */
  private async signUpsFull(): Promise<boolean> {
    const since = new Date(Date.now() - SIGN_UP_WINDOW_MS).toISOString();
    return (await this.store.peopleJoinedSince(since, SIGN_UPS_PER_HOUR)) >= SIGN_UPS_PER_HOUR;
  }

  /**
   * Adds `person` as a member, in every open room, with the session their cookie's token opens, and tells
   * everyone's workspace sockets, as joining does, answering who they are, "agent's name" for a name
   * that's an agent's, which nobody can take (`takesAgentsName`), or null if someone already has their
   * email address.
   */
  private async addMember(person: Omit<NewPerson, "id">, tokenDigest: string, client: Client): Promise<Me | "agent's name" | null> {
    if (await this.takesAgentsName(null, person.name)) return "agent's name";
    const session: StoredSession = { id: sortableId(), user: { id: sortableId(), name: person.name }, administrator: false, guest: false, lastActiveAt: Date.now() };
    try {
      await this.store.createMember({ ...person, id: session.user.id }, session.id, tokenDigest, client, new Date(session.lastActiveAt).toISOString());
    } catch (error) {
      if (await this.store.hasEmailAddress(person.emailAddress)) return null;
      throw error;
    }
    this.sessions.remember(tokenDigest, session);
    await this.publishPerson(session.user.id);
    return meOf(session);
  }

  /**
   * Counts a try at the deployment's setup password against its limit before it's checked: false past
   * the limit. A right guess would make whoever made it the administrator, so unlike sign-in's limit,
   * which is per IP address and kept in memory, this one is the whole deployment's and stored: neither
   * another address nor a Workspace that starts over starts the count over.
   */
  async trySetupPassword(): Promise<boolean> {
    const now = Date.now();
    const kept = await this.ctx.storage.get<{ count: number; endsAt: number }>(SETUP_TRY_WINDOW);
    const window = kept !== undefined && kept.endsAt > now ? kept : { count: 0, endsAt: now + SETUP_TRY_WINDOW_MS };
    // Past the limit there's nothing more to keep until the window ends, so a flood of tries writes nothing.
    if (window.count >= SETUP_TRIES) return false;
    window.count++;
    await this.ctx.storage.put(SETUP_TRY_WINDOW, window);
    return true;
  }

  /**
   * Counts a password sign-in from `ip` against the limit before anything is checked, then finds whose
   * password to check: "limited" past the limit, or else the active person `emailAddress` names, if it
   * names someone with a password.
   */
  async beginSignIn(ip: string, emailAddress: string | null): Promise<"limited" | { userId: UserId; passwordDigest: string } | null> {
    if (!this.signInAttempts.attempt(ip)) return "limited";
    return emailAddress === null ? null : this.store.passwordFor(emailAddress);
  }

  /**
   * Counts a sign-in with Memberful from `ip` against the same limit, before Memberful is asked
   * anything, having taken the connection whose state's digest is `connection`, for one that connects an
   * account, so that each is good for one try, whatever comes of it: "limited" past the limit, "expired"
   * for a connection taken already, forgotten, or started more than ten minutes ago, or else when it
   * began by the Workspace's clock, which what Memberful then says of the membership of whoever signed
   * in is no older than, and whose account it connects, if anyone's, with the password that started it.
   */
  async beginMemberfulSignIn(ip: string, connection: string | null): Promise<"limited" | "expired" | { begunAt: number; connecting: Connecting | null }> {
    const taken = connection === null ? null : await this.store.takeConnection(connection);
    if (!this.signInAttempts.attempt(ip)) return "limited";
    const begunAt = Date.now();
    if (connection === null) return { begunAt, connecting: null };
    if (!taken || taken.startedAt < begunAt - MEMBERFUL_ROUND_TRIP_MS) return "expired";
    return { begunAt, connecting: { userId: taken.userId, passwordDigest: taken.passwordDigest } };
  }

  /** Whose password `emailAddress` signs in with, and its digest as kept now, for a sign-in that found the one it checked replaced. */
  passwordKept(emailAddress: string): Promise<{ userId: UserId; passwordDigest: string } | null> {
    return this.store.passwordFor(emailAddress);
  }

  /**
   * Counts a link preview against the limit of the person `credentials` signs in: "limited" past it,
   * null without a valid session.
   */
  async beginUnfurl(credentials: Credentials): Promise<"allowed" | "limited" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.unfurls.attempt(user.id) ? "allowed" : "limited";
  }

  /**
   * Signs in someone whose password checked out against `passwordDigest`, unless they've stopped being
   * active since, or their password has been reset while it was checked. While Memberful is members
   * only, only administrators and the people they invited sign in with a password, and anyone else hears
   * "memberful", which only someone who knows their password can, so it says nothing about who has an
   * account.
   */
  async startSession(userId: UserId, passwordDigest: string, rehash: string | null, tokenDigest: string, client: Client): Promise<Me | "memberful" | null> {
    const membersOnly = (await this.joinableAccount())?.memberfulSignIn ?? false;
    if (membersOnly && !(await this.store.signsInWhileMembersOnly(userId))) return "memberful";
    // On D1 a role change can overlap it, so it's remembered only if none did, and the session starts
    // only if they may still sign in with a password, while Memberful is members only.
    const session = await this.sessions.keep(tokenDigest, () =>
      this.store.startSession(userId, passwordDigest, rehash, membersOnly, sortableId(), tokenDigest, client, new Date().toISOString()),
    );
    return session && meOf(session);
  }

  /**
   * Signs in the person a sign-in link names, with a session of its own, unless they're no longer
   * active, or are a guest while `guests` says guests can't stay signed in, or the session that showed
   * the link has ended, is a guest's while that's so, or is neither theirs nor an active
   * administrator's.
   */
  async transferSession({ userId, sessionId: shownBy }: Transfer, tokenDigest: string, client: Client, guests: boolean): Promise<Me | null> {
    // On D1 a role change can overlap it, so it's remembered only if none did.
    const session = await this.sessions.keep(tokenDigest, () =>
      this.store.startTransferredSession(userId, shownBy, guests, sortableId(), tokenDigest, client, new Date().toISOString()),
    );
    return session && meOf(session);
  }

  /**
   * Adds someone who signs in with just a name, and the session their cookie's token opens, unless
   * Memberful is members only, which answers "memberful", or the name is an agent's, which answers
   * "agent's name". Everyone's workspace sockets hear of them.
   */
  async signInGuest(name: string, tokenDigest: string, client: Client): Promise<Me | "memberful" | "agent's name"> {
    // One at a time, as joining is, so that none can overlap turning Members only on.
    return this.oneAtATime(async () => {
      if ((await this.joinableAccount())?.memberfulSignIn) return "memberful";
      if (await this.takesAgentsName(null, name)) return "agent's name";
      const session: StoredSession = { id: sortableId(), user: { id: sortableId(), name }, administrator: false, guest: true, lastActiveAt: Date.now() };
      await this.store.createGuest(session.user, session.id, tokenDigest, client, new Date(session.lastActiveAt).toISOString());
      this.sessions.remember(tokenDigest, session);
      await this.publishPerson(session.user.id);
      return meOf(session);
    });
  }

  /**
   * Signs in `member`, who signed in to the Memberful site `issuer`, with the session their cookie's
   * token opens: as the person their Memberful account is linked to, whether Memberful is on or not, or
   * else, while it's on, as someone new, a member in every open room, linked to it, as joining adds
   * someone, called by the first of their names that isn't an agent's, else "Member" (`namelessMember`).
   * Accounts are linked by the site and the member's id there, never matched by email address.
   * What Memberful said of their membership, as of `readAt`, is gone by as a check's is
   * (`settleMembership`), unless the Workspace has gone by a newer read: a member whose membership has
   * lapsed is suspended, their sessions elsewhere ending, and one whose membership is renewed is let back.
   * Answers "off" for someone new while Memberful is off, "refused" for someone linked who has been
   * removed or banned, "membership" for anyone but an administrator, or someone they invited, without an
   * active membership, "taken" when someone here has the email address someone new would have, which
   * creates nothing, and "failed" once keys for another site have taken the place of the ones they signed
   * in with (`memberfulSiteReplaced`). Everyone's workspace sockets hear of someone new.
   */
  async signInWithMemberful(issuer: string, member: MemberfulMember, readAt: number, tokenDigest: string, client: Client): Promise<Me | MemberfulRefusal> {
    // One at a time, so that two sign-ins of someone new can't both add them, none can overlap turning
    // Memberful off, giving it another site's keys, or a check of the same membership, and a suspension
    // closes the sockets it ends before answering.
    return this.closingSockets(async () => {
      if (await this.memberfulSiteReplaced(issuer)) return "failed";
      const linked = await this.store.linkedPerson(issuer, member.id);
      if (linked) {
        await this.keepCatchingUp(Date.now() + MEMBERSHIP_CATCH_UP_MS);
        if (linked.status === "deactivated" || linked.status === "banned") return "refused";
        if ((await this.settleMembership(issuer, member.id, linked, member.subscribed, readAt)) !== "active") return "membership";
        // On D1 a role change can overlap it, so it's remembered only if none did.
        const session = await this.sessions.keep(tokenDigest, () =>
          this.store.startLinkedSession(linked.userId, sortableId(), tokenDigest, client, new Date().toISOString(), linkedAccountOf(issuer, member)),
        );
        return session ? meOf(session) : "refused";
      }
      if (!(await this.joinableAccount())?.memberfulJoin) return "off";
      if (!member.subscribed) return "membership";
      // Nobody can take an agent's name, which Memberful knows nothing of.
      const agents = await this.store.agentEntries();
      const free = (name: string) => !agents.some((agent) => sameName(agent.name, name));
      const name = member.names.find(free) ?? namelessMember(free);
      const session: StoredSession = { id: sortableId(), user: { id: sortableId(), name }, administrator: false, guest: false, lastActiveAt: Date.now() };
      const person = { ...session.user, emailAddress: member.emailAddress };
      try {
        await this.store.createLinkedMember(person, linkedAccountOf(issuer, member), readAt, session.id, tokenDigest, client, new Date(session.lastActiveAt).toISOString());
      } catch (error) {
        if (member.emailAddress !== null && (await this.store.hasEmailAddress(member.emailAddress))) return "taken";
        throw error;
      }
      this.linkedSites.add(issuer);
      await this.keepCatchingUp(Date.now() + MEMBERSHIP_CATCH_UP_MS);
      this.sessions.remember(tokenDigest, session);
      await this.publishPerson(session.user.id);
      return meOf(session);
    });
  }

  /**
   * What connecting the account of the person `credentials` signs in to one at the Memberful site
   * `issuer` from their profile checks first: whose account it is, and the digest of their password, or
   * "" without one, which the Worker checks the password they give against, counting it against
   * sign-in's limit for `ip`, as changing their email address or password does: "limited" past it.
   * "unneeded" unless Memberful is members only, "forbidden" for a guest, "connected" when they're
   * connected to an account at the site already, and null without a valid session.
   */
  async memberfulConnectionCheck(
    credentials: Credentials,
    ip: string,
    issuer: string,
  ): Promise<{ userId: UserId; passwordDigest: string } | "limited" | "unneeded" | "forbidden" | "connected" | null> {
    const session = await this.session(credentials);
    if (!session) return null;
    if (!(await this.joinableAccount())?.memberfulSignIn) return "unneeded";
    if (session.guest) return "forbidden";
    const person = await this.store.connectingPerson(session.user.id, issuer);
    if (!person) return null;
    if (person.subject !== null) return "connected";
    const passwordDigest = (await this.store.signInOf(session.user.id))?.passwordDigest ?? "";
    if (passwordDigest !== "" && !this.signInAttempts.attempt(ip)) return "limited";
    return { userId: session.user.id, passwordDigest };
  }

  /**
   * Starts connecting the account of `userId`, whose password's digest was `passwordDigest` as the Worker
   * checked it, or "" without one, to one at the Memberful site `issuer`: keeps `stateDigest`, the digest
   * of the state their browser goes there with, for the callback to take within ten minutes. Whether it's
   * kept: not unless Memberful is members only, and they're active, neither a guest nor a bot, have that
   * password still, and aren't connected to an account at the site already.
   */
  async startMemberfulConnection(userId: UserId, passwordDigest: string, stateDigest: string, issuer: string): Promise<boolean> {
    if (!(await this.joinableAccount())?.memberfulSignIn) return false;
    const now = Date.now();
    return this.store.startConnection(stateDigest, userId, passwordDigest, issuer, now, now - MEMBERFUL_ROUND_TRIP_MS);
  }

  /**
   * Connects the account of `member`, who signed in to the Memberful site `issuer`, to the account here of
   * the person `connecting` is for, who started connecting one, and signs them in with the session their
   * cookie's token opens, `tokenDigest`, unless it's null, as it is when the browser is signed in as them
   * already, which answers "connected". Only its owner here connects an account there, which is never
   * matched by email address, and only while the password that started it is theirs still, so that a new
   * one, as a reset gives someone whose account was taken over, ends a connection on its way as it ends
   * their sessions. A member needs an active membership to connect one, as to sign in with it, which an
   * administrator, or someone they invited, doesn't, and an account connected to them already signs them
   * in as signing in with it does, going by what Memberful said of its membership as of `readAt`
   * (`settleMembership`). Answers "unneeded" unless Memberful is members only, "failed" once keys for
   * another site have taken the place of the ones it signed in with (`memberfulSiteReplaced`), "claimed"
   * for an account connected to someone else, "another" when they're connected to another account at the
   * site, "membership" for a member without an active membership, and "refused" when they've been
   * removed or banned, or their password has changed.
   */
  async connectMemberful(
    issuer: string,
    member: MemberfulMember,
    readAt: number,
    connecting: Connecting,
    tokenDigest: string | null,
    client: Client,
  ): Promise<Me | "connected" | MemberfulRefusal> {
    const { userId } = connecting;
    // One at a time, as signing in with Memberful is, so that two can't connect the same account.
    return this.closingSockets(async () => {
      if (!(await this.joinableAccount())?.memberfulSignIn) return "unneeded";
      if (await this.memberfulSiteReplaced(issuer)) return "failed";
      const linked = await this.store.linkedPerson(issuer, member.id);
      if (linked && linked.userId !== userId) return "claimed";
      if (linked) {
        if (linked.status === "deactivated" || linked.status === "banned") return "refused";
        if ((await this.settleMembership(issuer, member.id, linked, member.subscribed, readAt)) !== "active") return "membership";
      } else {
        const person = await this.store.connectingPerson(userId, issuer);
        if (!person) return "refused";
        if (person.subject !== null) return "another";
        if (person.membershipNeeded && !member.subscribed) return "membership";
        if (!(await this.store.connectIdentity(connecting, linkedAccountOf(issuer, member), readAt, new Date().toISOString()))) return "refused";
        this.linkedSites.add(issuer);
      }
      await this.keepCatchingUp(Date.now() + MEMBERSHIP_CATCH_UP_MS);
      if (tokenDigest === null) return "connected";
      // On D1 a role change can overlap it, so it's remembered only if none did.
      const session = await this.sessions.keep(tokenDigest, () =>
        this.store.startLinkedSession(userId, sortableId(), tokenDigest, client, new Date().toISOString(), linkedAccountOf(issuer, member)),
      );
      return session ? meOf(session) : "refused";
    });
  }

  /**
   * What disconnecting the account of the person `credentials` signs in from the one at the Memberful
   * site `issuer`, from their profile, checks first: whose account it is, and the digest of their
   * password, which the Worker checks the password they give against, counting it against sign-in's
   * limit for `ip`, as connecting one does: "limited" past it. "forbidden" for a guest, "not connected"
   * while they aren't connected to an account there, "no password" while they have none, or "no email
   * address" while they have none, which they'd have nothing to sign in with without, since signing
   * in with a password takes both, and null without a valid session.
   */
  async memberfulDisconnectionCheck(
    credentials: Credentials,
    ip: string,
    issuer: string,
  ): Promise<{ userId: UserId; passwordDigest: string } | "limited" | "forbidden" | "not connected" | "no password" | "no email address" | null> {
    const session = await this.session(credentials);
    if (!session) return null;
    if (session.guest) return "forbidden";
    const person = await this.store.connectingPerson(session.user.id, issuer);
    if (!person) return null;
    if (person.subject === null) return "not connected";
    const signIn = await this.store.signInOf(session.user.id);
    if (!signIn?.passwordDigest) return "no password";
    if (signIn.emailAddress === null) return "no email address";
    if (!this.signInAttempts.attempt(ip)) return "limited";
    return { userId: session.user.id, passwordDigest: signIn.passwordDigest };
  }

  /**
   * Disconnects the account of the person `credentials` signs in from the one at the Memberful site
   * `issuer`, once the Worker has checked their password, whose digest is `checked`
   * (`memberfulDisconnectionCheck`), answering their profile as it is then. As a new password does, it
   * ends their other sessions: their sockets close and are told to reconnect, here at once and in every
   * room they're in through the outbox, their push subscriptions are forgotten but this browser's, at
   * `pushEndpoint`, and so are the connections their browsers started and haven't finished, which could
   * connect an account again. Each statement checks that they're still connected there and still have that
   * password and an email address, so a reset ahead of it in line, or another tab's Disconnect or
   * profile change, makes it "refused". Null without a valid session.
   */
  async disconnectMemberful(credentials: Credentials, issuer: string, checked: string, pushEndpoint: string | null): Promise<YourProfile | "refused" | null> {
    return this.closingSockets(async () => {
      const session = await this.session(credentials);
      if (!session) return null;
      const { user } = session;
      const now = Date.now();
      const ended = { kept: session.id, pushEndpoint, code: CloseCode.Reconnect, dueAt: now };
      // As when a password is changed, until the database says what it did.
      let done: Disconnection | null = null;
      try {
        done = await this.sessions.change(
          (session) => session.user.id === user.id,
          () => this.store.disconnectIdentity(user.id, issuer, checked, ended),
        );
      } finally {
        // Whether or not it saved: the sockets of sessions that didn't end are let in again, and the site is
        // forgotten if nobody is linked there anymore.
        if (done?.disconnected ?? true) this.closeSockets(user.id, CloseCode.Reconnect, sessionTag(session.id));
        if (done?.queued ?? true) await this.revocationsQueued(now);
        if (done?.disconnected ?? true) await this.forgetUnlinked();
      }
      if (!done.disconnected) return "refused";
      const person = await this.store.ownProfile(user.id);
      return person && this.yourProfile(person, session);
    });
  }

  /**
   * Queues checking the membership of the account with `subject` at the Memberful site `issuer` with its
   * admin API, as the site's webhook says it changed, if it's linked to a member whose membership
   * counts, whether Memberful is on or not, since the members who joined with it keep signing in with
   * it. The alarm checks it.
   */
  async queueMembershipCheck(issuer: string, subject: string): Promise<void> {
    const now = Date.now();
    await this.store.queueMembershipCheck(issuer, subject, now, now + MEMBERSHIP_CATCH_UP_MS);
    await this.scheduleDelivery();
  }

  /**
   * Makes the daily check of every membership at the deployment's Memberful site due by `dueAt`, if it
   * can ask the site's admin API, and sets the alarm for it. Called once someone here is linked to an
   * account there, since the check isn't kept while nobody is.
   */
  private async keepCatchingUp(dueAt: number): Promise<void> {
    const api = await this.memberfulApi();
    if (!api) return;
    await this.store.scheduleMembershipCatchUp(api.site, dueAt);
    await this.wakeAt(dueAt);
  }

  /**
   * Goes by what Memberful said of the membership of `linked`, the person their account with `subject` at
   * the Memberful site `issuer` is linked to, as read at `readAt`, unless the Workspace has gone by a newer
   * read: suspends a member whose membership has lapsed (`suspendLapsed`), lets back one whose membership
   * is renewed (`restoreRenewed`), or else records the read. Administrators, and the people they invited,
   * are let in whatever their membership, and someone removed or banned stays so. Answers their status
   * then. One change at a time.
   */
  private async settleMembership(issuer: string, subject: string, linked: LinkedPerson, subscribed: boolean, readAt: number): Promise<UserStatus> {
    if (linked.checkedAt > readAt) return linked.status;
    const change = membershipChange(linked, subscribed);
    if (change === "lapsed") {
      await this.suspendLapsed(linked.userId, issuer, subject, readAt);
      return "suspended";
    }
    if (change === "renewed") {
      await this.restoreRenewed(linked.userId, issuer, subject, readAt);
      return "active";
    }
    await this.store.stampMemberships(issuer, [subject], readAt);
    return linked.status;
  }

  /**
   * Suspends the active member `userId`, whose membership has lapsed, as their account with `subject` at
   * the Memberful site `issuer` was read at `readAt`: all their sessions end, and their sockets close
   * for good, here at once and in every room they're in through the outbox, as removing them closes
   * them, but they stay in their rooms, for when it's renewed. Everyone's workspace sockets hear of it.
   */
  private async suspendLapsed(userId: UserId, issuer: string, subject: string, readAt: number): Promise<void> {
    const now = Date.now();
    // As when removing someone, until the database says it queued nothing.
    let queued = true;
    try {
      queued = await this.sessions.change(
        (session) => session.user.id === userId,
        () => this.store.suspendPerson(userId, issuer, subject, readAt, CloseCode.Revoked, now, new Date(now).toISOString()),
      );
    } finally {
      // Whether or not it saved: the app connects them again if they're still signed in.
      this.closeSockets(userId, CloseCode.Revoked);
      if (queued) await this.revocationsQueued(now);
    }
    await this.publishPerson(userId);
  }

  /**
   * Lets back the suspended member `userId`, whose membership is renewed, as their account with `subject`
   * at the Memberful site `issuer` was read at `readAt`, to sign in again, to the rooms they were in and
   * every open room. Everyone's workspace sockets hear of it.
   */
  private async restoreRenewed(userId: UserId, issuer: string, subject: string, readAt: number): Promise<void> {
    await this.store.restorePerson(userId, issuer, subject, readAt, new Date().toISOString());
    await this.publishPerson(userId);
  }

  /** Tells the workspace sockets of `userId` as the people directory now lists them: every socket, or just the ones it lists them to (`publish`). */
  private async publishPerson(userId: UserId): Promise<void> {
    const person = await this.store.person(userId);
    if (person) await this.publish(person);
  }

  /** Tells the workspace sockets of every agent, as the people directory lists it (`publish`). */
  private async publishAgents(): Promise<void> {
    for (const agent of await this.store.agentEntries()) await this.publish(agent);
  }

  /**
   * Tells the workspace sockets of `person` as the people directory lists them: every socket, but of an AI
   * agent only administrators' direct messages reach, which only administrators' sockets hear of, as only
   * their directories list it.
   */
  private async publish(person: DirectoryEntry): Promise<void> {
    const frame: WorkspaceServerFrame = { type: "user.updated", user: await this.directoryUser(person) };
    if (person.keptFor === "admin-dms") this.tell(await this.store.administratorIds(), frame);
    else this.broadcast(frame);
  }

  /**
   * The person a session signs in, refreshing the session's last activity at most once an hour.
   * Guests' sessions only count while `guests` says signing in with just a name is allowed.
   */
  async authenticate(credentials: Credentials): Promise<User | null> {
    return (await this.session(credentials))?.user ?? null;
  }

  /** The same, as the app keeps them. */
  async me(credentials: Credentials): Promise<Me | null> {
    const session = await this.session(credentials);
    return session && meOf(session);
  }

  private async session({ tokenDigest, client, guests }: Credentials): Promise<StoredSession | null> {
    const session = await this.sessions.get(tokenDigest, () => this.store.findSession(tokenDigest));
    if (!session || (session.guest && !guests)) return null;
    const now = Date.now();
    if (now - session.lastActiveAt >= SESSION_IDLE_MS) return null;
    if (now - session.lastActiveAt >= SESSION_REFRESH_MS) {
      await this.store.touchSession(session.id, client, new Date(now).toISOString());
      session.lastActiveAt = now;
    }
    return session;
  }

  /**
   * Ends the session `tokenDigest` names, and closes the sockets it opened, telling them to reconnect:
   * its workspace sockets here at once, and the rest by having every room its person is in close the
   * session's sockets there, before it answers. It forgets its person's push subscriptions with the
   * endpoint `pushEndpoint`, the browser's signing out.
   */
  async signOut(tokenDigest: string, pushEndpoint: string | null = null): Promise<void> {
    await this.afterQueuing(async () => {
      const now = Date.now();
      // Found first: on D1 a change can be saved, its revocations with it, and its answer lost on the
      // way back, and then nothing would say which sockets were the session's.
      const session = await this.sessions.get(tokenDigest, () => this.store.findSession(tokenDigest));
      // Until the database says it queued nothing.
      let queued = true;
      try {
        queued = await this.sessions.end(tokenDigest, () => this.store.endSession(tokenDigest, CloseCode.Reconnect, now, pushEndpoint));
      } finally {
        // Whether or not it ended: the sockets of a session that didn't are let in again.
        if (session) this.closeSockets(sessionTag(session.id), CloseCode.Reconnect);
        if (queued) await this.revocationsQueued(now);
      }
    });
  }

  /**
   * Gives whoever has exactly the email address `emailAddress` the password `passwordDigest` is the
   * digest of: "not found" if nobody has it, whatever their status, and "bot" for a bot, who never signs
   * in with a password. Their role and status stay, a ban included. All their sessions end, and their
   * sockets close and are told to reconnect: here at once, and in every room they're in through the
   * outbox. Their push subscriptions are forgotten too, so that a browser no longer signed in as them
   * gets none of their pushes.
   */
  async resetPassword(emailAddress: string, passwordDigest: string): Promise<"reset" | "not found" | "bot"> {
    return this.closingSockets(async () => {
      const person = await this.store.personWithEmailAddress(emailAddress);
      if (!person) return "not found";
      if (person.bot) return "bot";
      await this.replacePassword(person.id, passwordDigest);
      return "reset";
    });
  }

  /**
   * Gives `userId` the password `passwordDigest` is the digest of, ending all their sessions and closing
   * their sockets, as `resetPassword` does, and unlinking the accounts elsewhere they connected with the
   * password it replaces, from inside a change that's closing sockets (`closingSockets`).
   */
  private async replacePassword(userId: UserId, passwordDigest: string): Promise<void> {
    const now = Date.now();
    // As when signing out, until the database says it queued nothing.
    let queued = true;
    try {
      queued = await this.sessions.change(
        (session) => session.user.id === userId,
        () => this.store.resetPassword(userId, passwordDigest, CloseCode.Reconnect, now, new Date(now).toISOString()),
      );
    } finally {
      // Whether or not it saved: sockets whose sessions didn't end are let in again, and the sites nobody
      // is linked at anymore are forgotten.
      this.closeSockets(userId, CloseCode.Reconnect);
      if (queued) await this.revocationsQueued(now);
      await this.forgetUnlinked();
    }
  }

  /**
   * Emails a code to reset their password, the one `code` holds, to whoever has exactly the email address
   * `emailAddress`, as sign-in matches it, while they're active and have a password, from the workspace's
   * From address. Asks from `ip` count against the network's limit while they're `limited`, as they are
   * while Ember lacks Turnstile's keys. It answers "asked" before anything is emailed, and whether or not
   * anyone has the address, so that neither the answer nor how soon it comes says who has an account: the
   * code is emailed afterwards, one at a time with the others asked for (`emailResetCode`).
   */
  async askForPasswordReset(ip: string, emailAddress: string, code: NewResetCode, limited: boolean): Promise<PasswordResetAsk> {
    const account = await this.joinableAccount();
    const sending = account && (await this.emailSender(account));
    if (!account || !sending) return "unsendable";
    if (limited && !this.passwordResetAsks.attempt(ip)) return "limited";
    const person = await this.store.passwordFor(emailAddress);
    if (person) {
      const emailing = this.lastResetCode
        .then(() => this.emailResetCode(person, emailAddress, code, account.name, sending))
        .catch((error: unknown) => console.error("Could not email a code to reset a password", error));
      this.lastResetCode = emailing;
      this.ctx.waitUntil(emailing);
    }
    return "asked";
  }

  /**
   * Emails `person` the code `code` holds at `emailAddress`, from the workspace named `workspace`, with
   * `sending`, unless the address has been emailed as often as it is in an hour, whoever asked, and keeps
   * the code once the provider has taken the email, in place of any sent before, for the address and the
   * password the person has now, so that changing either ends it. An email the provider refuses reaches
   * nobody, so it isn't counted, and changes no code.
   */
  private async emailResetCode(
    person: { userId: UserId; passwordDigest: string },
    emailAddress: string,
    code: NewResetCode,
    workspace: string,
    sending: { sender: Sender; from: Mailbox },
  ): Promise<void> {
    const now = Date.now();
    const { count, countedSince } = await this.store.countEmailRequest(emailAddress, new Date(now).toISOString(), new Date(now - EMAIL_ASK_WINDOW_MS).toISOString());
    // The count is of the emails sent, or being sent, so that one the provider refuses frees a place.
    if (count > EMAILS_PER_ADDRESS) return this.store.uncountEmailRequest(emailAddress, countedSince);
    if ((await sendEmail(sending.sender, sending.from, passwordResetCodeEmail(emailAddress, workspace, code.code))) !== null) {
      return this.store.uncountEmailRequest(emailAddress, countedSince);
    }
    const { userId, passwordDigest } = person;
    const [createdAt, expiresAt] = [new Date(now).toISOString(), new Date(now + PASSWORD_RESET_CODE_MS).toISOString()];
    await this.store.savePasswordReset({ userId, codeDigest: code.digest, emailAddress, passwordDigest, createdAt, expiresAt });
  }

  /**
   * Counts a try of a code to reset a password from `ip` against sign-in's limit, then against the code
   * that works for exactly `emailAddress`, if one does, all before the Worker hashes the new password:
   * "limited" past sign-in's limit, "right" if `codeDigest` is the code's digest, and else "wrong", the
   * same whether nobody has the address, no code works for them, or it's been tried as often as it can
   * be.
   */
  async beginPasswordReset(ip: string, emailAddress: string, codeDigest: string): Promise<"limited" | "right" | "wrong"> {
    if (!this.signInAttempts.attempt(ip)) return "limited";
    const kept = await this.store.tryPasswordReset(emailAddress, new Date().toISOString());
    return kept !== null && (await isToken(codeDigest, kept)) ? "right" : "wrong";
  }

  /**
   * Gives the person whose email address is exactly `emailAddress` the password `passwordDigest` is the
   * digest of, with the code whose digest is `codeDigest`, spending it, as `beginPasswordReset` found it,
   * and ends all their sessions, as `resetPassword` does. Then it signs this browser in as them, with the
   * session `tokenDigest` names, answering who they are, or null when they sign in themselves, as someone
   * does who signs in with Memberful while it's members only. Answers "wrong" if the code stopped working
   * once it was checked.
   */
  async resetPasswordWithCode(emailAddress: string, codeDigest: string, passwordDigest: string, tokenDigest: string, client: Client): Promise<Me | "wrong" | null> {
    const userId = await this.closingSockets(async () => {
      // One at a time with the other changes, so nothing else resets the password between reading the
      // code and replacing it, which spends the code in the same transaction (`resetPassword`): a new
      // password that can't be saved leaves the code working, to try again.
      const holder = await this.store.passwordResetHolder(emailAddress, codeDigest, new Date().toISOString());
      if (holder !== null) await this.replacePassword(holder, passwordDigest);
      return holder;
    });
    if (userId === null) return "wrong";
    const session = await this.startSession(userId, passwordDigest, null, tokenDigest, client);
    return session === "memberful" ? null : session;
  }

  /**
   * The sidebar of the person `credentials` signs in: the rooms they're in, the ones they've starred and
   * the shared order of the rest, with the welcome card's invitation if they're an administrator in the
   * workspace's first room who hasn't dismissed the card, and the huddles going on in their rooms. Null
   * without a valid session.
   */
  async sidebar(credentials: Credentials): Promise<Sidebar | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    const [{ rooms, favorites, sharedOrder, huddles, invitationRoomId }, account] = await Promise.all([this.store.roomsFor(user.id), this.joinableAccount()]);
    const invited = invitationRoomId !== null && rooms.some((room) => room.id === invitationRoomId);
    const invitation = account && invited ? { roomId: invitationRoomId, joinCode: account.joinCode } : null;
    return { rooms, favorites, sharedOrder, invitation, huddles };
  }

  /**
   * Dismisses the welcome card for the person `credentials` signs in, for good: their sidebar, on any
   * device, has no invitation from then on, and every tab of theirs hears so. Only administrators are
   * shown the card, but anyone may dismiss it, since that changes nothing but what they're shown.
   * Answers whether it did, which it can't without a valid session.
   */
  async dismissInvitation(credentials: Credentials): Promise<boolean> {
    const user = await this.authenticate(credentials);
    if (!user) return false;
    await this.store.dismissInvitation(user.id, new Date().toISOString());
    this.tell([user.id], { type: "invitation.dismissed" });
    return true;
  }

  /**
   * Puts the rooms in the sidebar of the administrator `credentials` signs in, DMs aside, in the shared
   * order in the order `roomIds` lists them, answering the rooms they're in that it ranks, in its order:
   * "forbidden" unless they're an administrator and every room is one they could order, or null without
   * a valid session. Every sidebar loads again, its own included.
   */
  async setSharedOrder(credentials: Credentials, roomIds: RoomId[]): Promise<RoomId[] | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.oneAtATime(async () => {
      const sharedOrder = await this.store.setSharedOrder(user.id, roomIds);
      if (!sharedOrder) return "forbidden";
      this.broadcast({ type: "rooms.reordered" });
      return sharedOrder;
    });
  }

  /**
   * Stars room `roomId` for the person `credentials` signs in, or unstars it, answering their stars as
   * they are then: "forbidden" when they can't star it, or null without a valid session. Every tab of
   * theirs hears the new list.
   */
  async setFavorite(credentials: Credentials, roomId: RoomId, favorite: boolean): Promise<Favorites | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    const favorites = await this.store.setFavorite(user.id, roomId, favorite);
    if (!favorites) return "forbidden";
    this.starsChanged(user.id, favorites);
    return favorites;
  }

  /**
   * Puts the stars of the person `credentials` signs in in the order `roomIds` lists them, answering
   * their stars as they are then: "forbidden" when `roomIds` isn't exactly the rooms they've starred, or
   * null without a valid session. Every tab of theirs hears the new order.
   */
  async setFavoriteOrder(credentials: Credentials, roomIds: RoomId[]): Promise<Favorites | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    const favorites = await this.store.setFavoriteOrder(user.id, roomIds);
    if (!favorites) return "forbidden";
    this.starsChanged(user.id, favorites);
    return favorites;
  }

  /**
   * Gives the person `credentials` signs in level `involvement` in room `roomId`, answering it: "not
   * found" when they aren't in it, "invalid" for no level, having changed nothing, or null without a
   * valid session. Every tab of theirs hears it, which hides the room from their sidebars at
   * "invisible", and hears their stars again when hiding a starred room, or showing it again, changes
   * them.
   */
  async setInvolvement(credentials: Credentials, roomId: RoomId, involvement: Involvement | null): Promise<Involvement | "not found" | "invalid" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    const saved = await this.store.setInvolvement(user.id, roomId, involvement);
    if (typeof saved === "string") return saved;
    this.tell([user.id], { type: "room.involvement", roomId, involvement: saved.involvement });
    if (saved.favorites) this.starsChanged(user.id, saved.favorites);
    return saved.involvement;
  }

  /** Tells every tab of `userId`'s what their stars are now. */
  private starsChanged(userId: UserId, favorites: Favorites) {
    this.tell([userId], { type: "favorites.changed", favorites });
  }

  /** Sends `frame` on the workspace sockets of each of `userIds`, every tab of theirs, and nobody else's. */
  private tell(userIds: Iterable<UserId>, frame: WorkspaceServerFrame): void {
    const data = JSON.stringify(frame);
    for (const userId of userIds) {
      for (const socket of this.ctx.getWebSockets(userId)) {
        try {
          socket.send(data);
        } catch {
          // It has closed since, and its close handler has nothing to clean up.
        }
      }
    }
  }

  /** Sends `frame` on every workspace socket but those of `userIds`, whom each socket's tags name. */
  private tellAllBut(userIds: Iterable<UserId>, frame: WorkspaceServerFrame): void {
    const data = JSON.stringify(frame);
    const left = new Set<string>(userIds);
    for (const socket of this.ctx.getWebSockets()) {
      if (this.ctx.getTags(socket).some((tag) => left.has(tag))) continue;
      try {
        socket.send(data);
      } catch {
        // It has closed since, and its close handler has nothing to clean up.
      }
    }
  }

  /** Whether the person `credentials` signs in is an administrator now, or null without a valid session. */
  async canAdminister(credentials: Credentials): Promise<boolean | null> {
    const user = await this.authenticate(credentials);
    return user && this.store.isAdministrator(user.id);
  }

  /**
   * Whether the person `credentials` signs in may create rooms: anyone, unless an administrator has
   * turned on "Must be admin to create new rooms". Null without a valid session.
   */
  async mayCreateRooms(credentials: Credentials): Promise<boolean | null> {
    const user = await this.authenticate(credentials);
    return user && this.mayCreateRoomsAs(user.id);
  }

  private async mayCreateRoomsAs(userId: UserId): Promise<boolean> {
    const account = await this.joinableAccount();
    return !account?.restrictRoomCreation || this.store.isAdministrator(userId);
  }

  /**
   * Creates a room as the person `credentials` signs in: "forbidden" unless they may create rooms, or
   * null without a valid session. Everyone it puts in sees it in their sidebars at once, and nobody else
   * hears of it.
   */
  async createRoom(credentials: Credentials, room: NewRoom): Promise<SharedRoom | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    if (!(await this.mayCreateRoomsAs(user.id))) return "forbidden";
    const created: SharedRoom = { id: sortableId(), kind: room.kind, name: room.name, icon: room.icon || null };
    const memberIds = await this.store.createRoom(created, user.id, room.kind === "closed" ? room.memberIds : null, new Date().toISOString());
    this.tell(memberIds, { type: "room.saved", room: created });
    return created;
  }

  /**
   * Starts a DM as the person `credentials` signs in: the DM between them and the people `userIds` names
   * who exist, whatever their status, or their DM with themselves when it names nobody else. An AI agent
   * kept for administrators counts as nobody to anyone else, and one only their direct messages reach to
   * an administrator who names with it anyone who isn't one, a member or a bot, who would read what it
   * says (`DIRECT_PEOPLE`). A group of people has one DM, so the one they have opens again. Answers it,
   * and whether it's new, or null without a valid session. Everyone in a new DM sees it in their sidebars
   * at once, and nobody else hears of it.
   */
  async startDirect(credentials: Credentials, userIds: UserId[]): Promise<{ room: DirectRoom; started: boolean } | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    const people = userIds.length > 0 ? await this.store.directPeople(userIds, user.id) : [];
    const memberIds = [user.id, ...people.map((person) => person.id)];
    const direct = await this.store.startDirect(sortableId(), user.id, memberIds, new Date().toISOString());
    if (direct.started) this.tell(direct.room.members.map((member) => member.id), { type: "room.saved", room: direct.room });
    return direct;
  }

  /**
   * What the New room forms list, everyone active who can be put in a room, for the person `credentials`
   * signs in: "forbidden" unless they may create rooms, or null without a valid session.
   */
  async newRoomForm(credentials: Credentials): Promise<NewRoomForm | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return (await this.mayCreateRoomsAs(user.id)) ? { people: await this.store.activePeople() } : "forbidden";
  }

  /**
   * Whom the person `credentials` signs in can mention in room `roomId`, or anywhere when it's null:
   * the first page of the active people there whose names contain `query`, by name, but the AI agents
   * kept for administrators, unless they're one. "not found" unless they're in the room, or null without
   * a valid session.
   */
  async mentionable(credentials: Credentials, roomId: RoomId | null, query: string): Promise<DirectoryEntry[] | "not found" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    if (roomId !== null && !(await this.store.isMember(roomId, user.id))) return "not found";
    return this.store.mentionable(query, roomId, user.id);
  }

  /**
   * Everyone in the workspace, for the person `credentials` signs in, but the AI agents only
   * administrators' direct messages reach, unless they're one, or null without a valid session.
   */
  async directory(credentials: Credentials): Promise<DirectoryEntry[] | null> {
    const user = await this.authenticate(credentials);
    return user && this.store.directory(user.id);
  }

  /**
   * Someone as their page shows them to the person `credentials` signs in, whatever their status, and
   * with their email address and sign-in link to administrators: "not found" if nobody has id `userId`,
   * or it's an AI agent's only administrators' direct messages reach and they aren't one, or null without
   * a valid session.
   */
  async person(credentials: Credentials, userId: UserId): Promise<ShownPerson | "not found" | null> {
    const session = await this.session(credentials);
    if (!session) return null;
    const [person, administrator] = await Promise.all([this.store.personWithProfile(userId), this.store.isAdministrator(session.user.id)]);
    if (!person || (person.keptFor === "admin-dms" && !administrator)) return "not found";
    const agent = person.agent ? await this.store.agentProfile(userId) : null;
    if (administrator) {
      const transferable = person.status === "active" && person.role !== "bot";
      return { person, transfer: transferable ? { userId: person.id, sessionId: session.id } : null, agent };
    }
    const { emailAddress, ...listed } = person;
    return { person: listed, transfer: null, agent };
  }

  /**
   * What the avatar of whoever has id `userId` is drawn from, for the person `credentials` signs in:
   * "not found" if nobody has it, or it's an AI agent's only administrators' direct messages reach and
   * they aren't one, or null without a valid session.
   */
  async avatarOwner(credentials: Credentials, userId: UserId): Promise<AvatarOwner | "not found" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    const owner = await this.store.avatarOwner(userId);
    if (!owner || (owner.keptFor === "admin-dms" && !(await this.store.isAdministrator(user.id)))) return "not found";
    return owner;
  }

  /**
   * Makes the active person `userId` an administrator or a member as the person `credentials` signs in,
   * answering them as the people directory then lists them: "forbidden" unless that's an administrator,
   * "not found" unless `userId` is someone active, or null without a valid session. A null `role`
   * changes nothing, once that's checked. Nobody can change their own role ("own role"), so there's
   * always an administrator, or a bot's ("bot"). Everyone's workspace sockets hear of a change.
   */
  async changeRole(
    credentials: Credentials,
    userId: UserId,
    role: PersonRole | null,
  ): Promise<DirectoryUser | "forbidden" | "not found" | "own role" | "bot" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.oneAtATime(async () => {
      if (!(await this.store.isAdministrator(user.id))) return "forbidden";
      const person = await this.store.activePerson(userId);
      if (!person) return "not found";
      if (role === null) return this.directoryUser(person);
      if (userId === user.id) return "own role";
      if (person.role === "bot") return "bot";
      // Only what differs is written.
      if (role === person.role) return this.directoryUser(person);

      const now = new Date().toISOString();
      const changed = await this.directoryUser({ ...person, role, updatedAt: now });
      // Their sessions are read again, so their next welcome says what they are now.
      await this.sessions.change(
        (session) => session.user.id === userId,
        () => this.store.changeRole(userId, role, now),
      );
      this.broadcast({ type: "user.updated", user: changed });
      return changed;
    });
  }

  /**
   * Removes the active person `userId` from the workspace as the person `credentials` signs in, or
   * someone suspended for their membership's lapsing, answering them as the people directory then lists
   * them: "forbidden" unless that's an administrator, "not found" unless `userId` is someone active or
   * suspended, but for @ember and the agents (`goesWithEmberAi`), or null without a valid session. Nobody
   * can remove themselves ("yourself"), so there's always an administrator. All their sessions end, and
   * their sockets close for good: here at once, and in every room they're in through the outbox.
   * Everyone's workspace sockets hear of it.
   */
  async removePerson(credentials: Credentials, userId: UserId): Promise<DirectoryUser | "forbidden" | "not found" | "yourself" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.closingSockets(async () => {
      if (!(await this.store.isAdministrator(user.id))) return "forbidden";
      const person = (await this.goesWithEmberAi(userId)) ? null : await this.store.removablePerson(userId);
      if (!person) return "not found";
      if (userId === user.id) return "yourself";
      return this.deactivate(person);
    });
  }

  /**
   * Deactivates someone active or suspended, answering them as the people directory then lists them. All
   * their sessions end, and their sockets close for good: here at once, and in every room they're in
   * through the outbox. Everyone's workspace sockets hear of it.
   */
  private async deactivate({ id, name, bio, role, agent, keptFor }: DirectoryEntry): Promise<DirectoryUser> {
    const now = Date.now();
    const removedAt = new Date(now).toISOString();
    const removed = await this.directoryUser({ id, name, bio, role, status: "deactivated", updatedAt: removedAt, agent, keptFor });
    // As when resetting a password, until the database says it queued nothing.
    let queued = true;
    try {
      queued = await this.sessions.change(
        (session) => session.user.id === id,
        () => this.store.removePerson(id, crypto.randomUUID(), CloseCode.Revoked, now, removedAt),
      );
    } finally {
      // Whether or not it saved: the app connects them again if they're still signed in.
      this.closeSockets(id, CloseCode.Revoked);
      if (queued) await this.revocationsQueued(now);
    }
    this.broadcast({ type: "user.updated", user: removed });
    return removed;
  }

  /** Whether `userId` is @ember's or an agent's, which go with Ember AI, on the AI assistant tab, so that removing or banning them finds nobody. */
  private async goesWithEmberAi(userId: UserId): Promise<boolean> {
    return userId === ASSISTANT_ID || this.store.isAgent(userId);
  }

  /**
   * The active bots, by name, each with its key and the rooms it's in but its DMs, for the person
   * `credentials` signs in: "forbidden" unless that's an administrator, or null without a valid session.
   */
  async bots(credentials: Credentials): Promise<Bot[] | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    if (!(await this.store.isAdministrator(user.id))) return "forbidden";
    return this.shownBots(await this.store.activeBots());
  }

  /**
   * The active bot `botId` as its edit page shows it to the person `credentials` signs in: "forbidden"
   * unless that's an administrator, "not found" unless `botId` is an active bot, or null without a valid
   * session.
   */
  async bot(credentials: Credentials, botId: UserId): Promise<BotSettings | "forbidden" | "not found" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    if (!(await this.store.isAdministrator(user.id))) return "forbidden";
    return (await this.botSettings(botId)) ?? "not found";
  }

  /**
   * Adds a bot as the person `credentials` signs in: with a new token, a webhook if `bot` gives it
   * somewhere to deliver, `avatar`, which R2 has stored under a key `reservePicture` reserved, if it's
   * given one, and in every open room, as someone who joins is, and everyone's workspace sockets hear of
   * it. Answers it as its edit page shows it, "forbidden" unless that's an administrator, "agent's name"
   * for a name that's an agent's (`takesAgentsName`), or null without a valid session.
   */
  async createBot(credentials: Credentials, { name, webhookUrl }: NewBot, avatar: StoredPicture | null): Promise<BotSettings | "forbidden" | "agent's name" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.oneAtATime(async () => {
      if (!(await this.store.isAdministrator(user.id))) return "forbidden";
      if (await this.takesAgentsName(null, name)) return "agent's name";
      const id = sortableId();
      await this.store.createBot({ id, name, token: newBotToken(), webhookUrl: webhookUrl || null, avatar }, new Date().toISOString());
      await this.publishPerson(id);
      return (await this.botSettings(id))!;
    });
  }

  /**
   * Changes the active bot `botId` as the person `credentials` signs in, giving it `avatar`, which R2
   * has stored under a key `reservePicture` reserved, in place of the one it had, if it's given one, as
   * `changeAvatar` gives someone theirs. Answers it as its edit page then shows it: "forbidden" unless
   * that's an administrator, "not found" unless `botId` is an active bot, "name reserved" for a new name
   * that's @ember's, and "agent's name" for one that's an agent's, unless it was the bot's before, or null
   * without a valid session. Everyone's workspace sockets hear of a new name or avatar.
   */
  async changeBot(
    credentials: Credentials,
    botId: UserId,
    changes: BotChanges,
    avatar: StoredPicture | null,
  ): Promise<BotSettings | "forbidden" | "not found" | "name reserved" | "agent's name" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.inALaterSecond(() =>
      this.oneAtATime(async () => {
        if (!(await this.store.isAdministrator(user.id))) return "forbidden";
        const bot = await this.store.activeBot(botId);
        if (!bot) return "not found";
        if (changes.name !== undefined && takesReservedName(bot.name, changes.name)) return "name reserved";
        if (changes.name !== undefined && (await this.takesAgentsName(bot.name, changes.name))) return "agent's name";
        const now = Date.now();
        const tooSoon = avatar && tooSoonAfter(bot.updatedAt, now);
        if (tooSoon) return tooSoon;
        const previous = avatar && ((await this.store.avatarOwner(botId))?.avatar?.key ?? null);
        await this.store.changeBot(botId, changes, new Date(now).toISOString(), avatar && { avatar, previous, dueAt: now });
        if (previous) await this.wakeAt(now);
        const changed = (await this.store.activeBot(botId))!;
        if (changed.name !== bot.name || avatar) this.broadcast({ type: "user.updated", user: await this.directoryUser(changed) });
        return this.shownBotSettings(changed);
      }),
    );
  }

  /**
   * Deletes the active bot `botId` as the person `credentials` signs in, deactivating it as removing
   * someone does: it leaves every room but its DMs, and its key stops working, while its messages, token
   * and webhook stay. Answers "forbidden" unless that's an administrator, "not found" unless `botId` is
   * an active bot, or null without a valid session. Everyone's workspace sockets hear of it.
   */
  async deleteBot(credentials: Credentials, botId: UserId): Promise<"deleted" | "forbidden" | "not found" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.closingSockets(async () => {
      if (!(await this.store.isAdministrator(user.id))) return "forbidden";
      const bot = await this.store.activeBot(botId);
      if (!bot) return "not found";
      await this.deactivate(bot);
      return "deleted";
    });
  }

  /**
   * Gives the active bot `botId` a new token as the person `credentials` signs in, so its old key stops
   * working at once. Answers it as its edit page then shows it, "forbidden" unless that's an
   * administrator, "not found" unless `botId` is an active bot, or null without a valid session.
   */
  async resetBotKey(credentials: Credentials, botId: UserId): Promise<BotSettings | "forbidden" | "not found" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.oneAtATime(async () => {
      if (!(await this.store.isAdministrator(user.id))) return "forbidden";
      if (!(await this.store.activeBot(botId))) return "not found";
      await this.store.changeBotToken(botId, newBotToken(), new Date().toISOString());
      return (await this.botSettings(botId))!;
    });
  }

  /** The active bot `botId` as its edit page shows it, or null unless it's one. */
  private async botSettings(botId: UserId): Promise<BotSettings | null> {
    const bot = await this.store.activeBot(botId);
    return bot && this.shownBotSettings(bot);
  }

  /** Bots as administrators see them: with their avatars' addresses, and their keys in place of their tokens. */
  private async shownBots(bots: StoredBot[]): Promise<Bot[]> {
    return (await directoryOf(bots, this.env.SESSION_SECRET)).map(({ token, ...bot }) => ({ ...bot, key: botKeyOf(bot.id, token) }));
  }

  /** A bot as its edit page shows it to administrators. */
  private async shownBotSettings(bot: StoredBotSettings): Promise<BotSettings> {
    const [shown] = await this.shownBots([bot]);
    return { ...shown!, webhookUrl: bot.webhookUrl };
  }

  /**
   * The agents, by name, as the AI assistant tab lists them to the person `credentials` signs in: "off"
   * while Ember AI is off, "forbidden" unless that's an administrator, or null without a valid session.
   */
  async agents(credentials: Credentials): Promise<Agent[] | "off" | "forbidden" | null> {
    const allowed = await this.mayAdministerAgents(credentials);
    if (allowed !== true) return allowed;
    return directoryOf(await this.store.activeAgents(), this.env.SESSION_SECRET);
  }

  /**
   * Agent `agentId` as its page shows it to the person `credentials` signs in: "off" while Ember AI is
   * off, "forbidden" unless that's an administrator, "not found" unless `agentId` is an agent's, or null
   * without a valid session.
   */
  async agent(credentials: Credentials, agentId: UserId): Promise<AgentSettings | "off" | "forbidden" | "not found" | null> {
    const allowed = await this.mayAdministerAgents(credentials);
    if (allowed !== true) return allowed;
    const agent = await this.store.activeAgent(agentId);
    return agent ? this.shownAgentSettings(agent) : "not found";
  }

  /**
   * The agents the person `credentials` signs in can ask, as Available Agents lists them: @ember first,
   * which is in every open room, then the others by name, each with what it does and the rooms it shares
   * with them. None while Ember AI is off, when they're all deactivated, and only an administrator is
   * listed the ones kept for administrators. Null without a valid session.
   */
  async availableAgents(credentials: Credentials): Promise<AvailableAgent[] | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    const { ember, agents } = await this.store.availableAgents(user.id);
    const builtIn = ember ? [{ ...ember, description: EMBER_DOES, access: "everyone" as const, rooms: null }] : [];
    return directoryOf([...builtIn, ...agents], this.env.SESSION_SECRET);
  }

  /**
   * The gateway that asks the model of an agent called `name`, which the person `credentials` signs in
   * is making, or calling agent `agentId`, so that what `createAgent` or `changeAgent` would refuse
   * doesn't wait for the model first: "off", "full", "name taken", "not found", "forbidden" or null, as
   * they would answer.
   */
  async agentGateway(credentials: Credentials, name: string, agentId: UserId | null = null): Promise<Gateway | "off" | "full" | "name taken" | "not found" | "forbidden" | null> {
    const allowed = await this.mayAdministerAgents(credentials);
    if (allowed !== true) return allowed;
    if (agentId === null && (await this.store.agentEntries()).length >= MAX_AGENTS) return "full";
    if (agentId !== null && !(await this.store.isAgent(agentId))) return "not found";
    if ((await this.store.namesInUse(agentId)).some((other) => sameName(other, name))) return "name taken";
    return (await this.assistantGateway()) ?? "off";
  }

  /**
   * What the person `credentials` signs in asks agent `agentId` with, as it's saved, or an agent not saved
   * yet, for null, as they try it (`AgentTrialAccess`): "off" while Ember AI is off, or its API token
   * doesn't open, "not found" unless `agentId` is an agent's, "forbidden" unless that's an administrator,
   * or null without a valid session.
   */
  async agentTrial(credentials: Credentials, agentId: UserId | null): Promise<AgentTrialAccess | "off" | "not found" | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    if (!(await this.store.isAdministrator(user.id))) return "forbidden";
    const account = await this.joinableAccount();
    const opened = account && (await this.openedAssistant(account));
    if (!account || !opened) return "off";
    const agent = agentId === null ? null : await this.store.activeAgent(agentId);
    if (agentId !== null && !agent) return "not found";
    const through = { accountId: opened.accountId, apiToken: opened.apiToken };
    const saved = agent && { id: agent.id, model: agent.model, modelName: agent.modelName, format: agent.format, thinkingLevels: agent.thinkingLevels, webTools: agent.webTools };
    return { asker: { id: user.id, name: user.name }, through, community: account.name, addresses: addressesOf(account), saved };
  }

  /**
   * Makes `agent` as the person `credentials` signs in, with its model as asking it found it (`asked`),
   * and `avatar`, which R2 has stored under a key `reservePicture` reserved, if it's given one: a bot
   * without a key, in every open room or the ones `agent` picks, or in none if only administrators'
   * direct messages reach it, and the workspace sockets of everyone the people directory lists it to
   * hear of it (`publish`). Answers it as its page shows it: "off" while Ember AI is off, "set up
   * again" once Ember AI asks AI Gateway through another account or API token than the model was asked
   * through, "full" when there are as many agents as there can be, "name taken" for a name in use
   * (`namesInUse`, `sameName`), "forbidden" unless that's an administrator, or null without a valid
   * session.
   */
  async createAgent(
    credentials: Credentials,
    agent: NewAgent,
    asked: AskedModel,
    avatar: StoredPicture | null,
  ): Promise<AgentSettings | "off" | "set up again" | "full" | "name taken" | "forbidden" | null> {
    return this.administerAgents(credentials, async (user, account) => {
      if (!(await this.asksThrough(account, asked.through))) return "set up again";
      if ((await this.store.agentEntries()).length >= MAX_AGENTS) return "full";
      if ((await this.store.namesInUse(null)).some((name) => sameName(name, agent.name))) return "name taken";
      const id = sortableId();
      const setup = setupOf({ ...agent, promptTemplate: agent.promptTemplate ?? null, levels: { thinking: agent.thinking, length: agent.length } }, asked);
      await this.store.createAgent({ id, name: agent.name, access: agent.access ?? "everyone", rooms: agent.rooms, avatar, createdBy: user.id, ...setup }, new Date().toISOString());
      await this.publishPerson(id);
      return this.shownAgentSettings((await this.store.activeAgent(id))!);
    });
  }

  /**
   * Changes agent `agentId` by `changes` as the person `credentials` signs in, with its model as asking
   * it found it (`asked`), when the change needs that (`asksModel`), of the agent as it was when it was
   * changed at `asked.changedAt`, and gives it `avatar.picture`, which R2 has stored under a key
   * `reservePicture` reserved, or takes away the one it was given, for null, as `changeAvatar` gives
   * someone theirs. It records who changed it, and when, once anything did, and the workspace sockets of
   * everyone the people directory lists it to hear of a new name or avatar, or of who can ask it now
   * (`publish`): once only administrators' direct messages reach it, it leaves every room, whatever rooms
   * `changes` picks, and everyone else's sockets hear that it has gone. Answers it as its page then shows
   * it: "off" while Ember AI is off, "changed" once the agent was changed since its model was asked, or
   * it needs asking now, "set up again" once Ember AI asks AI Gateway through another account or API
   * token than the model was asked through, "name taken" for a name someone else uses (`namesInUse`),
   * "not found" unless `agentId` is an agent's, "forbidden" unless that's an administrator, or null
   * without a valid session.
   */
  async changeAgent(
    credentials: Credentials,
    agentId: UserId,
    changes: AgentChanges,
    asked: (AskedModel & { changedAt: string }) | null,
    avatar: { picture: StoredPicture | null } | null,
  ): Promise<AgentSettings | "off" | "changed" | "set up again" | "name taken" | "not found" | "forbidden" | null> {
    return this.inALaterSecond(() =>
      this.administerAgents(credentials, async (user, account) => {
        const agent = await this.store.activeAgent(agentId);
        if (!agent) return "not found";
        if (asked ? asked.changedAt !== agent.changedAt : asksModel(agent, changes)) return "changed";
        if (asked && !(await this.asksThrough(account, asked.through))) return "set up again";
        const name = changes.name === undefined || changes.name === agent.name ? undefined : changes.name;
        if (name !== undefined && (await this.store.namesInUse(agentId)).some((other) => sameName(other, name))) return "name taken";
        const model = asked ?? { ...agent, webTools: changes.webSearch === false ? [] : agent.webTools };
        const levels = { thinking: changes.thinking ?? agent.levels.thinking, length: changes.length ?? agent.levels.length };
        const promptTemplate = changes.promptTemplate === undefined ? agent.promptTemplate : changes.promptTemplate;
        const setup = setupOf({ description: changes.description ?? agent.description, instructions: changes.instructions ?? agent.instructions, promptTemplate, levels }, model);
        const access = changes.access === undefined || changes.access === agent.access ? undefined : changes.access;
        // One only administrators' direct messages reach is in no room, and stays in none.
        const inNoRoom = (access ?? agent.access) === "admin-dms";
        const rooms = inNoRoom || changes.rooms === undefined || sameRooms(agent.rooms, changes.rooms) ? undefined : changes.rooms;
        // Taking away an avatar that isn't there changes nothing.
        const picture = avatar && (avatar.picture !== null || agent.avatar !== null) ? avatar.picture : undefined;
        if (name === undefined && access === undefined && rooms === undefined && picture === undefined && sameSetup(setup, agent)) return this.shownAgentSettings(agent);
        const now = Date.now();
        const tooSoon = picture !== undefined && tooSoonAfter(agent.updatedAt, now);
        if (tooSoon) return tooSoon;
        const previous = picture === undefined ? null : (agent.avatar?.key ?? null);
        const pictured = picture === undefined ? undefined : { avatar: picture, previous, dueAt: now };
        await this.store.changeAgent(agentId, { name, setup, access, rooms, avatar: pictured, changedBy: user.id }, new Date(now).toISOString());
        if (previous) await this.wakeAt(now);
        if (access === "admin-dms") this.tellAllBut(await this.store.administratorIds(), { type: "user.gone", userId: agentId });
        if (name !== undefined || picture !== undefined || access !== undefined) await this.publishPerson(agentId);
        return this.shownAgentSettings((await this.store.activeAgent(agentId))!);
      }),
    );
  }

  /**
   * Deletes agent `agentId` as the person `credentials` signs in, deactivating it as deleting a bot does:
   * it leaves every room but its DMs, and its messages stay, while what made it an agent goes, so that
   * its name is free again. Answers "off" while Ember AI is off, "not found" unless `agentId` is an
   * agent's, "forbidden" unless that's an administrator, or null without a valid session. The workspace
   * sockets of everyone the people directory lists it to hear of it (`publish`): it goes on listing one
   * only administrators' direct messages reached to them alone.
   */
  async deleteAgent(credentials: Credentials, agentId: UserId): Promise<"deleted" | "off" | "not found" | "forbidden" | null> {
    return this.administerAgents(credentials, async () => {
      if (!(await this.store.isAgent(agentId))) return "not found";
      await this.store.deleteAgent(agentId, new Date().toISOString());
      await this.publishPerson(agentId);
      return "deleted";
    });
  }

  /**
   * The connected apps, by name, as the AI assistant tab lists them to the person `credentials` signs
   * in: "off" while Ember AI is off, "forbidden" unless that's an administrator, or null without a valid
   * session, as the agents are, whose tools they are.
   */
  async connectedApps(credentials: Credentials): Promise<AppSummary[] | "off" | "forbidden" | null> {
    const allowed = await this.mayAdministerAgents(credentials);
    if (allowed !== true) return allowed;
    const [apps, everyPicks] = await Promise.all([this.store.apps(), this.store.everyAgentsToolPicks()]);
    return apps.map((app) => ({
      id: app.id,
      name: app.name,
      url: app.url,
      toolCount: app.tools.length,
      setAside: setAsideTools(app, everyPicks).length,
      signInEnded: app.signedIn !== null && app.sealedSignIn === null,
      wantsAccess: app.signedIn !== null && app.scopeWanted !== null,
    }));
  }

  /** The connected app `appId` as its page shows it to the person `credentials` signs in, or "not found" unless there's one, or why not, as `connectedApps` answers. */
  async connectedApp(credentials: Credentials, appId: AppId): Promise<App | "off" | "forbidden" | "not found" | null> {
    const allowed = await this.mayAdministerAgents(credentials);
    if (allowed !== true) return allowed;
    const [app, everyPicks] = await Promise.all([this.store.app(appId), this.store.everyAgentsToolPicks()]);
    return app ? shownApp(app, everyPicks) : "not found";
  }

  /**
   * Whether the person `credentials` signs in can connect another app now, so that nobody waits for an
   * app's server to hear they can't: "full" with as many as there can be, or why not, as `connectedApps`
   * answers.
   */
  async appSlot(credentials: Credentials): Promise<true | "full" | "off" | "forbidden" | null> {
    const allowed = await this.mayAdministerAgents(credentials);
    if (allowed !== true) return allowed;
    return (await this.store.appCount()) < MAX_APPS ? true : "full";
  }

  /**
   * Where the connected app `appId` is asked, for the administrator `credentials` signs in, who's
   * changing it, reading its tools again or signing in to it: its name, its server's address and what
   * Ember sends it, if it has anything, or why not, as `connectedApp` answers.
   */
  async appAccess(credentials: Credentials, appId: AppId): Promise<AppAccess | "off" | "forbidden" | "not found" | null> {
    const allowed = await this.mayAdministerAgents(credentials);
    if (allowed !== true) return allowed;
    const app = await this.store.app(appId);
    return app ? this.accessTo(app) : "not found";
  }

  /**
   * What a sign-in to the connected app `appId` begins with, for the administrator `credentials` signs
   * in: its name, its server's address, the client Ember last signed in to it as, as JSON, when an
   * administrator gave one, and, once its server has asked for more than the sign-in allows, the scopes
   * to ask for besides those a sign-in asks for by itself: what it asked for, with what the sign-in
   * had. Or why not, as `connectedApp` answers. Its server isn't asked for this, nor its
   * authorization server for another token.
   */
  async appSignInTarget(credentials: Credentials, appId: AppId): Promise<{ name: string; url: string; client: string | null; scope: string | null } | "off" | "forbidden" | "not found" | null> {
    const allowed = await this.mayAdministerAgents(credentials);
    if (allowed !== true) return allowed;
    const app = await this.store.app(appId);
    if (!app) return "not found";
    const client = app.signInClient && (await this.openedSignIn(`client ${appId}`, app.signInClient.sealed));
    return { name: app.name, url: app.url, client, scope: app.scopeWanted && scopesWith(await this.scopeHad(app), app.scopeWanted) };
  }

  /** The scopes Ember's sign-in to `app` has, as its authorization server said when it gave them, or null where it didn't say, or the sign-in has ended. */
  private scopeHad({ id, sealedSignIn }: StoredApp): Promise<string | null> {
    return this.scopeIn(id, sealedSignIn);
  }

  /** The scopes the sign-in `sealed` for `signIn` (`signInOf`) has, as its authorization server said when it gave them, or null where it didn't say, or there's none. */
  private async scopeIn(signIn: string, sealed: string | null): Promise<string | null> {
    const kept = sealed === null ? null : await this.openedSignIn(signIn, sealed);
    return kept === null ? null : ((JSON.parse(kept) as SignIn).tokens?.scope ?? null);
  }

  /** Where `app` is asked (`AppAccess`): one signed in to as it's signed in to once its access token is had, which an administrator may have done again meanwhile. */
  private async accessTo(app: StoredApp): Promise<AppAccess> {
    const asked = { name: app.name, url: app.url, sealedToken: app.sealedToken, signedIn: app.signedIn !== null };
    return app.signedIn ? { ...asked, ...(await this.signInKey(app.id, null)) } : { ...asked, key: await this.tokenKey(app), signedInAt: null };
  }

  /**
   * Connects `app`, whose server answered `read`, as the administrator `credentials` signs in, with
   * their `signIn` to its server in place of a token, if that's how it was read, answering it as its
   * page shows it: "full" with as many as there can be, or why not, as `connectedApps` answers.
   */
  async connectApp(credentials: Credentials, app: NewApp, read: StoredAppRead, signIn?: string): Promise<App | "full" | "off" | "forbidden" | null> {
    return this.administerAgents(credentials, async (user) => {
      const id = sortableId();
      const sealedToken = app.token === undefined || signIn ? null : await this.sealedAppToken(id, app.token);
      const signedIn = signIn ? { sealed: await this.sealedSignIn(id, signIn), client: await this.signInClientOf(id, signIn) } : undefined;
      const connected = await this.store.connectApp({ id, name: app.name, url: app.url, sealedToken, signIn: signedIn, ...read, connectedBy: user.id, now: new Date().toISOString() }, MAX_APPS);
      return connected ? shownApp((await this.store.app(id))!, []) : "full";
    });
  }

  /**
   * Keeps `begun`, a sign-in to an app that the administrator `credentials` signs in was just sent to
   * its authorization server for, until their browser comes back, or for ten minutes: answers true, or
   * why not, as `connectedApps` answers.
   */
  async beginAppSignIn(credentials: Credentials, begun: BegunAppSignIn): Promise<true | "off" | "forbidden" | null> {
    return this.administerAgents(credentials, (user) => this.keepBegunSignIn(user, begun, false));
  }

  /** Keeps `begun`, a sign-in `user` was just sent to an app's authorization server for, for ten minutes: Ember's, or their `own`. */
  private async keepBegunSignIn(user: User, { state, appId, name, url, signIn }: BegunAppSignIn, own: boolean): Promise<true> {
    const now = Date.now();
    const pending = { state, userId: user.id, appId, name, url, sealedSignIn: await this.sealedSignIn(`sign-in ${state}`, signIn), own };
    await this.store.beginAppSignIn(pending, new Date(now + APP_SIGN_IN_MS).toISOString(), new Date(now).toISOString());
    return true;
  }

  /**
   * Takes the sign-in to an app that the person `credentials` signs in began and came back from with
   * `state`, which finishes it once, saying whether it's their `own`, to a connected app, or Ember's,
   * which an administrator began: "ended" for one that has expired, was finished already, or was begun
   * by someone else, "forbidden" for Ember's once they aren't an administrator, and for a guest, "off"
   * while Ember AI is off, or null without a valid session.
   */
  async takeAppSignIn(credentials: Credentials, state: string): Promise<(BegunAppSignIn & { own: boolean }) | "ended" | "off" | "forbidden" | null> {
    const session = await this.session(credentials);
    if (!session) return null;
    if (session.guest) return "forbidden";
    const { user } = session;
    return this.oneAtATime(async () => {
      const [administrator, own, account] = await Promise.all([this.store.isAdministrator(user.id), this.store.isOwnAppSignIn(state, user.id, new Date().toISOString()), this.joinableAccount()]);
      if (own === false && !administrator) return "forbidden";
      if (!account?.assistant) return "off";
      const taken = own === null ? null : await this.store.takeAppSignIn(state, user.id, new Date().toISOString());
      const signIn = taken && (await this.openedSignIn(`sign-in ${state}`, taken.sealedSignIn));
      return taken && signIn ? { state, appId: taken.appId, name: taken.name, url: taken.url, signIn, own: taken.own } : "ended";
    });
  }

  /**
   * Keeps `signIn`, the sign-in the administrator `credentials` signs in made to the server of the
   * connected app `appId`, at `url`, in place of any it had, and of its token, with what its server
   * answered when its tools were `read` with it, answering the app as its page then shows it:
   * "changed" once it's asked at another address, or why not, as `connectedApp` answers.
   */
  async signInToApp(credentials: Credentials, appId: AppId, url: string, signIn: string, read: StoredAppRead): Promise<App | "changed" | "off" | "forbidden" | "not found" | null> {
    return this.administerAgents(credentials, async (user) => {
      if (!(await this.store.app(appId))) return "not found";
      const picks = picksChangedBy(appId, read, await this.store.everyAgentsToolPicks());
      const made = { sealed: await this.sealedSignIn(appId, signIn), by: user.id, client: await this.signInClientOf(appId, signIn) };
      const signedIn = await this.store.signInToApp(appId, made, read, picks, url, new Date().toISOString());
      if (!signedIn) return "changed";
      const [app, everyPicks] = await Promise.all([this.store.app(appId), this.store.everyAgentsToolPicks()]);
      return app ? shownApp(app, everyPicks) : "not found";
    });
  }

  /**
   * Does `change` for the person `credentials` signs in, to the sign-ins they make to connected apps
   * themselves, one change at a time with the others, while Ember AI is on: "off" while it's off,
   * "forbidden" for a guest, or null without a valid session.
   */
  private async changeOwnSignIns<T>(credentials: Credentials, change: (user: User) => Promise<T>): Promise<T | "off" | "forbidden" | null> {
    const session = await this.session(credentials);
    if (!session) return null;
    if (session.guest) return "forbidden";
    return this.oneAtATime(async () => ((await this.joinableAccount())?.assistant ? change(session.user) : "off"));
  }

  /** The connected apps `userId` can sign in to themselves, as their profile lists them: those Ember signs in to, while Ember AI is on, and none for a `guest`. */
  private async yourApps(userId: UserId, guest: boolean, account: JoinableAccount | null): Promise<YourApp[]> {
    return account?.assistant && !guest ? (await this.store.ownAppSignIns(userId)).map(yourApp) : [];
  }

  /**
   * What a sign-in the person `credentials` signs in makes to the connected app `appId` themselves
   * begins with, as `appSignInTarget` answers for Ember's: as the client Ember signed in to it as, and
   * asking, besides what a sign-in asks for by itself, for what their last had, and what the app's
   * server has asked for beyond that. "not found" unless the app is one Ember signs in to, or why
   * not, as `changeOwnSignIns` answers.
   */
  async ownAppSignInTarget(credentials: Credentials, appId: AppId): Promise<{ name: string; url: string; client: string | null; scope: string | null } | "off" | "forbidden" | "not found" | null> {
    const session = await this.session(credentials);
    if (!session) return null;
    if (session.guest) return "forbidden";
    const [account, app, own] = await Promise.all([this.joinableAccount(), this.store.app(appId), this.store.ownAppSignIn(appId, session.user.id)]);
    if (!account?.assistant) return "off";
    if (!app || !own) return "not found";
    const client = app.signInClient && (await this.openedSignIn(`client ${appId}`, app.signInClient.sealed));
    const had = await this.scopeIn(signInOf(appId, session.user.id), own.signedIn?.sealed ?? null);
    return { name: app.name, url: app.url, client, scope: scopesWith(had, own.signedIn?.scopeWanted ?? null) };
  }

  /** Keeps `begun`, a sign-in to a connected app that the person `credentials` signs in was just sent to its authorization server to make themselves, as `beginAppSignIn` keeps Ember's, or says why not, as `changeOwnSignIns` answers. */
  async beginOwnAppSignIn(credentials: Credentials, begun: BegunAppSignIn): Promise<true | "off" | "forbidden" | null> {
    return this.changeOwnSignIns(credentials, (user) => this.keepBegunSignIn(user, begun, true));
  }

  /**
   * Keeps `signIn`, the sign-in the person `credentials` signs in made to the server of the connected
   * app `appId`, at `url`, themselves, in place of any they had, answering the app as their profile
   * then lists it: "changed" once the app is gone, or why not, as `changeOwnSignIns` answers. Its
   * service is asked to take back what a sign-in gave that Ember doesn't keep.
   */
  async signInToAppAsSelf(credentials: Credentials, appId: AppId, url: string, signIn: string): Promise<YourApp | "changed" | "off" | "forbidden" | null> {
    const signedIn = await this.changeOwnSignIns(credentials, async (user) => {
      const sealed = await this.sealedSignIn(signInOf(appId, user.id), signIn);
      const kept = await this.store.signInToAppAsSelf(appId, user.id, sealed, url, new Date().toISOString());
      const own = kept ? await this.store.ownAppSignIn(appId, user.id) : null;
      return own ? yourApp(own) : "changed";
    });
    if (signedIn === null || typeof signedIn === "string") this.ctx.waitUntil(this.unkeptRevoked(url, signIn));
    return signedIn;
  }

  /** Whether the service of the app at `url` took back `signIn`, as JSON, which Ember was given and doesn't keep. */
  private unkeptRevoked(url: string, signIn: string): Promise<boolean> {
    return appConnector(this.env)
      .revokeSignIn(url, signIn)
      .catch(() => false);
  }

  /**
   * Forgets the sign-in the person `credentials` signs in made to the connected app `appId` themselves,
   * and has its service take back what it gave, as an app's removal does Ember's (`disconnectApp`):
   * answers the apps as their profile then lists them, and whether the service did, which it's said
   * to have of a sign-in that had ended. "not found" when they had none, or why not, as
   * `changeOwnSignIns` answers.
   */
  async signOutOfApp(credentials: Credentials, appId: AppId): Promise<YourAppSignedOut | "off" | "forbidden" | "not found" | null> {
    const forgotten = await this.changeOwnSignIns(credentials, async (user) => {
      const own = await this.store.ownAppSignIn(appId, user.id);
      const sealed = own ? await this.store.forgetOwnAppSignIn(appId, user.id) : undefined;
      return own && sealed !== undefined ? { user, url: own.url, sealed } : ("not found" as const);
    });
    if (forgotten === null || typeof forgotten === "string") return forgotten;
    const { user, url, sealed } = forgotten;
    const signIn = signInOf(appId, user.id);
    const revoked = await Promise.all([sealed === null || this.signInRevoked(signIn, url, sealed), this.strayTokensRevoked(signIn)]);
    return { apps: await this.yourApps(user.id, false, await this.joinableAccount()), revoked: revoked.every(Boolean) };
  }

  /**
   * Changes the connected app `appId` as the administrator `credentials` signs in: its name, its
   * server's address and its token, "" for none, each kept when left out, and what its server answered
   * when it was read again, `reread`, if it was, answering it as its page then shows it, or why not, as
   * `connectedApp` answers. What was read is kept only while the app is still asked where it was when
   * the server was, `askedAt`: "changed" once someone has saved another address or token meanwhile, as
   * the tools would be another server's, or the new address's token one it never took. An app that's
   * signed in to keeps its address, and takes no token, "signed in": its sign-in is to the server there.
   */
  async changeApp(
    credentials: Credentials,
    appId: AppId,
    changes: AppChanges,
    reread: { read: StoredAppRead; askedAt: AskedAt } | null,
  ): Promise<App | "changed" | "signed in" | "off" | "forbidden" | "not found" | null> {
    return this.administerAgents(credentials, async (user) => {
      const app = await this.store.app(appId);
      if (!app) return "not found";
      if (app.signedIn && ((changes.url !== undefined && changes.url !== app.url) || changes.token !== undefined)) return "signed in";
      if (reread && !isAskedAt(app, reread.askedAt)) return "changed";
      const sealedToken = changes.token === undefined ? undefined : changes.token === "" ? null : await this.sealedAppToken(appId, changes.token);
      const read = reread && { read: reread.read, picks: picksChangedBy(appId, reread.read, await this.store.everyAgentsToolPicks()) };
      await this.store.changeApp(appId, { name: changes.name, url: changes.url, sealedToken, ...read, changedBy: user.id, now: new Date().toISOString() });
      const [changed, everyPicks] = await Promise.all([this.store.app(appId), this.store.everyAgentsToolPicks()]);
      return changed ? shownApp(changed, everyPicks) : "not found";
    });
  }

  /**
   * Disconnects the app `appId` as the administrator `credentials` signs in, or says why not, as
   * `connectedApp` answers. One Ember was signed in to has its service asked to take back what the
   * sign-in gave, once the app is gone, so that nothing more is asked with it meanwhile: "revoked"
   * when it did, or "unrevoked" when it didn't, couldn't be asked, or doesn't say how. That's with
   * the tokens Ember was getting as the app went, if it was, which it couldn't keep (`currentSignInKey`),
   * and with the sign-ins people made to it themselves, which go with it: as many of those as Ember
   * has a service take back at once, so that with more it says "unrevoked", having forgotten them all.
   */
  async disconnectApp(credentials: Credentials, appId: AppId): Promise<"disconnected" | "revoked" | "unrevoked" | "off" | "forbidden" | "not found" | null> {
    const removed = await this.administerAgents(credentials, async () => (await this.store.disconnectApp(appId)) ?? "not found");
    if (removed === null || typeof removed === "string") return removed;
    const own = removed.own.slice(0, MAX_OWN_SIGN_INS_REVOKED).map(({ userId, sealed }) => ({ signIn: signInOf(appId, userId), sealed }));
    // Ember's sign-in may have ended while people's own, which are kept apart from it, are still good.
    const signIns = removed.sealedSignIn === null ? own : [{ signIn: appId, sealed: removed.sealedSignIn }, ...own];
    if (signIns.length === 0) return "disconnected";
    const revoked = await Promise.all(signIns.flatMap(({ signIn, sealed }) => [this.signInRevoked(signIn, removed.url, sealed), this.strayTokensRevoked(signIn)]));
    return revoked.every(Boolean) && removed.own.length <= MAX_OWN_SIGN_INS_REVOKED ? "revoked" : "unrevoked";
  }

  /** Whether the service of an app took back the tokens Ember was getting from it for `signIn` (`signInOf`) as that went, if it was, once it has them. */
  private async strayTokensRevoked(signIn: string): Promise<boolean> {
    await this.signInKeys.get(signIn)?.catch(() => undefined);
    const revoked = this.strayTokens.get(signIn);
    this.strayTokens.delete(signIn);
    return revoked === undefined || revoked;
  }

  /**
   * Has the service of the app at `url` take back `tokens`, a sign-in as JSON, which it gave Ember for
   * `signIn` (`signInOf`) as that went, with its app or as its person signed out: what forgot it took
   * back the ones before them, which these ended, and waits for this to say whether its service took
   * everything back.
   */
  private revokeStrayTokens(signIn: string, url: string, tokens: string): void {
    const revoked = this.unkeptRevoked(url, tokens);
    this.strayTokens.set(signIn, revoked);
    this.ctx.waitUntil(revoked);
  }

  /** Whether the service of the app at `url` took back what `sealed`, the sign-in `signIn` (`signInOf`) that Ember just forgot, gave. It's asked outside the queue of changes, as it may take a while to answer. */
  private async signInRevoked(signIn: string, url: string, sealed: string): Promise<boolean> {
    try {
      const opened = await this.openedSignIn(signIn, sealed);
      return opened !== null && (await appConnector(this.env).revokeSignIn(url, opened));
    } catch (error) {
      console.error(`Taking back the sign-in ${signIn} to an app failed: ${error instanceof Error ? error.name : "unknown error"}`);
      return false;
    }
  }

  /**
   * Every connected app's tools as the page of `agentId`, @ember or an agent, offers them to the person
   * `credentials` signs in, with which of them it may use: "not found" unless `agentId` is @ember's or
   * an agent's, or why not, as `connectedApps` answers.
   */
  async agentTools(credentials: Credentials, agentId: UserId): Promise<OfferedApp[] | "off" | "forbidden" | "not found" | null> {
    const allowed = await this.mayAdministerAgents(credentials);
    if (allowed !== true) return allowed;
    if (!(await this.usesTools(agentId))) return "not found";
    const [apps, picks] = await Promise.all([this.store.apps(), this.store.toolPicks(agentId)]);
    return offeredApps(apps, picks);
  }

  /**
   * Has `picks` be every tool of the connected apps `agentId`, @ember or an agent, may use from then on,
   * as the administrator `credentials` signs in, answering what its page then offers: "gone" when one
   * of them isn't a connected app's tool as the administrator read it, by its fingerprint, or why not,
   * as `agentTools` answers. A tool found set aside for having changed stays set aside until it's among
   * them, even once its server describes it as it did, so that the agent never has more than was picked,
   * and is no longer always allowed, as that was said of the tool as it was.
   */
  async pickAgentTools(credentials: Credentials, agentId: UserId, picks: readonly ToolPick[]): Promise<OfferedApp[] | "gone" | "off" | "forbidden" | "not found" | null> {
    return this.administerAgents(credentials, async (user) => {
      if (!(await this.usesTools(agentId))) return "not found";
      const [apps, before] = await Promise.all([this.store.apps(), this.store.toolPicks(agentId)]);
      const fingerprintOf = ({ appId, name }: ToolPick) => apps.find((app) => app.id === appId)?.tools.find((tool) => tool.name === name)?.fingerprint;
      if (picks.some((pick) => fingerprintOf(pick) !== pick.fingerprint)) return "gone";
      const isPicked = ({ appId, name }: ToolPick) => picks.some((pick) => pick.appId === appId && pick.name === name);
      const isSetAside = (pick: StoredToolPick) => fingerprintOf(pick) !== undefined && (pick.setAside || fingerprintOf(pick) !== pick.fingerprint);
      const setAside = before.filter((pick) => !isPicked(pick) && isSetAside(pick)).map(({ appId, name, fingerprint }): StoredToolPick => ({ appId, name, fingerprint, setAside: true }));
      const kept: StoredToolPick[] = [...picks, ...setAside];
      await this.store.pickTools(agentId, kept, user.id, new Date().toISOString());
      return offeredApps(apps, kept);
    });
  }

  /**
   * The connected apps' tools `agentId`, @ember or an agent, may use: those picked for it that its app
   * still has as they were picked, by their fingerprints, and none that's set aside, each with whether
   * its calls of it are always allowed.
   */
  private async pickedTools(agentId: UserId): Promise<PickedTool[]> {
    const picks = (await this.store.toolPicks(agentId)).filter(({ setAside }) => !setAside);
    const apps = picks.length === 0 ? [] : await this.store.apps();
    return picks.flatMap(({ appId, name, fingerprint, alwaysAllowed }) => {
      const app = apps.find((app) => app.id === appId);
      const tool = app?.tools.find((tool) => tool.name === name && tool.fingerprint === fingerprint);
      if (!app || !tool) return [];
      return [{ appId, appName: app.name, name, title: tool.title, description: tool.description, takes: JSON.stringify(tool.takes), fingerprint, alwaysAllowed: alwaysAllowed === true }];
    });
  }

  /**
   * The connected apps' tools `agentId` may use (`pickedTools`) answering `askerId` in room `roomId`:
   * in their direct conversation, the two of them alone, a tool of an app `askerId` has signed in to
   * themselves is theirs, `own`, as a call of it there goes as them, and each one asks first, whatever
   * is always allowed, which was said of calls with Ember's sign-in. One whose sign-in has ended stays
   * theirs until they sign out, so that nothing goes with Ember's that was to go with their own.
   */
  private async toolsFor(agentId: UserId, roomId: RoomId, askerId: UserId): Promise<PickedTool[]> {
    const picked = await this.pickedTools(agentId);
    if (picked.length === 0 || !(await this.store.isBetween(roomId, askerId, agentId))) return picked;
    const own = new Set((await this.store.ownAppSignIns(askerId)).flatMap(({ appId, signedIn }) => (signedIn ? [appId] : [])));
    return picked.map((tool) => (own.has(tool.appId) ? { ...tool, alwaysAllowed: false, own: true } : tool));
  }

  /**
   * Where a call of `tool`, a connected app's, goes for `agentId`, @ember or an agent, as the call finds
   * it when it's made: null once Ember AI is off, the app is gone, or the tool isn't picked for the
   * agent as it was, by its fingerprint, so that what an administrator takes away stops what's waiting.
   * A call nobody was asked about, `unasked`, goes nowhere either unless the agent's calls of the tool
   * are always allowed by then. Getting a sign-in's next access token asks its authorization server,
   * which can take a while, so the tool is looked up again after that: one taken away meanwhile isn't
   * called, and an app signed in to again meanwhile is asked as it is then. A call that was to go as
   * whoever asked, `as`, with the sign-in they made to the app themselves, goes that way or nowhere
   * (`callAs`), and never `unasked`.
   */
  async appToolCall(agentId: UserId, tool: Pick<PickedTool, "appId" | "name" | "fingerprint">, unasked: boolean, as?: AskedBy): Promise<AppCallAccess | null> {
    const app = await this.calledApp(agentId, tool, unasked);
    if (!app) return null;
    if (as) return unasked ? null : this.callAs(agentId, tool, app, as);
    const access = await this.accessTo(app);
    if (!access.signedIn) return access;
    const after = await this.calledApp(agentId, tool, unasked);
    if (!after) return null;
    return isAskedAt(after, access) ? access : this.appToolCall(agentId, tool, unasked);
  }

  /**
   * Where a call of `tool`, of the connected app `app`, goes for `agentId` as whoever asked, `as`: to
   * its server with the sign-in they made to it themselves, in their direct conversation with the
   * agent alone, and nowhere anywhere else. One that has ended, or that they've signed out of, has no
   * key, so that the call isn't made with Ember's in its place. The tool is looked up again once the
   * sign-in's access token is had, as `appToolCall` does, and the sign-in too, which they may have made
   * again meanwhile.
   */
  private async callAs(agentId: UserId, tool: Pick<PickedTool, "appId" | "name" | "fingerprint">, app: StoredApp, as: AskedBy): Promise<AppCallAccess | null> {
    if (!app.signedIn || !(await this.store.isBetween(as.roomId, as.askerId, agentId))) return null;
    const { key, signedInAt } = await this.signInKey(app.id, as.askerId);
    const [after, own] = await Promise.all([this.calledApp(agentId, tool, false), this.store.ownAppSignIn(app.id, as.askerId)]);
    if (!after?.signedIn) return null;
    if ((own?.signedIn?.at ?? null) !== signedInAt) return this.callAs(agentId, tool, after, as);
    return { name: after.name, url: after.url, sealedToken: null, signedIn: true, key, signedInAt, own: as.askerId };
  }

  /** The app whose `tool` a call for `agentId` goes to, or null where it goes nowhere (`appToolCall`). */
  private async calledApp(agentId: UserId, tool: Pick<PickedTool, "appId" | "name" | "fingerprint">, unasked: boolean): Promise<StoredApp | null> {
    const [account, picked, app] = await Promise.all([this.joinableAccount(), this.pickedTools(agentId), this.store.app(tool.appId)]);
    const pick = picked.find(({ appId, name, fingerprint }) => appId === tool.appId && name === tool.name && fingerprint === tool.fingerprint);
    const mayRun = pick !== undefined && (!unasked || pick.alwaysAllowed);
    return account?.assistant && app && mayRun ? app : null;
  }

  /**
   * Keeps what the server of the connected app `appId` answered when a room read its tools again,
   * `read`, as a call had found one no longer as it was picked: the tool is then set aside for every
   * agent that had it, whose pages show how its server describes it now, while it does, and no longer
   * always allowed (`picksChangedBy`). Kept only while the app is still asked where it was then, `askedAt`.
   */
  async keepAppRead(appId: AppId, read: StoredAppRead, askedAt: AskedAt): Promise<void> {
    const picks = picksChangedBy(appId, read, await this.store.everyAgentsToolPicks());
    await this.store.keepAppRead(appId, read, picks, askedAt, new Date().toISOString());
  }

  /**
   * Keeps that the server of the connected app `appId` asked for `scope`, more than Ember's sign-in to
   * it allows, with what it asked for before, which signing in again then asks for, and the app's page
   * says. Kept only while the app is still signed in to as it was when its server was asked, `askedAt`,
   * and while it's no more than Ember keeps. One at a time, as two rooms' calls may each be refused for
   * want of another scope, and each adds its own to what's kept by then. What it asked of a call that
   * went as a person, with their `own` sign-in, is kept with that one, for them to sign in again with,
   * as their profile says.
   */
  async keepAppScopeWanted(appId: AppId, scope: string, askedAt: AskedAt & Pick<AppCallAccess, "own">): Promise<void> {
    const { own } = askedAt;
    await this.oneAtATime(async () => {
      const kept = own === undefined ? await this.signInAskedAt(appId, askedAt) : ((await this.store.ownAppSignIn(appId, own))?.signedIn ?? null);
      if (!kept || kept.at !== askedAt.signedInAt) return;
      const wanted = scopesWith(kept.scopeWanted, scope);
      if (wanted === null || wanted === kept.scopeWanted || wanted.length > MAX_APP_SCOPE_LENGTH) return;
      await (own === undefined ? this.store.keepAppScopeWanted(appId, wanted, kept.at) : this.store.keepOwnAppScopeWanted(appId, own, wanted, kept.at));
    });
  }

  /** When Ember's sign-in to the connected app `appId` was made, and what its server has asked for beyond it, while the app is still asked as it was, `askedAt`: null once it isn't. */
  private async signInAskedAt(appId: AppId, askedAt: AskedAt): Promise<{ at: string; scopeWanted: string | null } | null> {
    const app = await this.store.app(appId);
    return app?.signedIn && isAskedAt(app, askedAt) ? { at: app.signedIn.at, scopeWanted: app.scopeWanted } : null;
  }

  /**
   * Who answers a call that waits to be allowed in room `roomId`, as their click finds them: by their
   * name now, and whether they're an administrator, or null once they aren't an active member of the room.
   */
  async callDecider(roomId: RoomId, clickerId: UserId): Promise<{ member: User; administrator: boolean } | null> {
    return this.store.roomMember(roomId, clickerId);
  }

  /** Whether `agentId` is one tools are picked for: @ember, whether or not it has answered yet, or an agent. */
  private async usesTools(agentId: UserId): Promise<boolean> {
    return agentId === ASSISTANT_ID || (await this.store.isAgent(agentId));
  }

  /** `token`, sealed for the app `appId` alone: under the key for apps' tokens, with the app's id, so that one app's doesn't open as another's. */
  private sealedAppToken(appId: AppId, token: string): Promise<string> {
    return seal(this.env.SESSION_SECRET, "app-token", `${appId}\n${token}`);
  }

  /** The token Ember sends `app`'s server to be let in, or null when it has none, or one that doesn't open, as after SESSION_SECRET changes. */
  private async tokenKey({ id, sealedToken }: Pick<StoredApp, "id" | "sealedToken">): Promise<Key | null> {
    const opened = sealedToken === null ? null : await unseal(this.env.SESSION_SECRET, "app-token", sealedToken);
    return opened?.startsWith(`${id}\n`) ? { token: opened.slice(id.length + 1) } : null;
  }

  /** The access token of the sign-in `holder` keeps to the app `appId`, which is asked for one at a time, as getting another may be. */
  private signInKey(appId: AppId, holder: Holder): Promise<SignInKey> {
    const signIn = signInOf(appId, holder);
    let key = this.signInKeys.get(signIn);
    if (!key) {
      key = this.currentSignInKey(appId, holder).finally(() => this.signInKeys.delete(signIn));
      this.signInKeys.set(signIn, key);
    }
    return key;
  }

  /** The sign-in `holder` keeps to the app `appId`, sealed, or null once it has ended, with where the app's server is and when it was made: null when there's none, as its app is gone, or its person has signed out. */
  private async keptSignIn(appId: AppId, holder: Holder): Promise<{ url: string; sealed: string | null; at: string | null } | null> {
    if (holder === null) {
      const app = await this.store.app(appId);
      return app && { url: app.url, sealed: app.sealedSignIn, at: app.signedIn?.at ?? null };
    }
    const own = await this.store.ownAppSignIn(appId, holder);
    return own?.signedIn ? { url: own.url, sealed: own.signedIn.sealed, at: own.signedIn.at } : null;
  }

  /**
   * The access token of the sign-in `holder` keeps to the app `appId` as it's kept now, once Ember has
   * got another with the one it keeps for that, if the last has ended, or is about to: its
   * authorization server may take each of those once, so the sign-in is read as it is before each is
   * sent, and kept with what came back before anything else asks. Null once there's no getting
   * another, which ends the sign-in. A token that couldn't be asked for now leaves the last one, for
   * the app's server to refuse. What came back for a sign-in that was made again meanwhile, or that's
   * gone, with its app or as its person signed out, isn't kept or used: the app is asked as it is by
   * then, and one that's gone has its service take back what came, as what forgot it takes back the
   * tokens that were kept, which these ended.
   */
  private async currentSignInKey(appId: AppId, holder: Holder): Promise<SignInKey> {
    const kept = await this.keptSignIn(appId, holder);
    const keyed = (token: string | null): SignInKey => ({ key: token === null ? null : { token, signedIn: true }, signedInAt: kept?.at ?? null });
    const bound = signInOf(appId, holder);
    const opened = kept?.sealed ? await this.openedSignIn(bound, kept.sealed) : null;
    const signIn = opened === null ? null : (JSON.parse(opened) as SignIn);
    if (!kept?.sealed || opened === null || !signIn?.tokens) return keyed(null);
    if (!isDue(signIn, Date.now())) return keyed(signIn.tokens.access);
    const refreshed = await appConnector(this.env).refreshSignIn(kept.url, opened);
    if (refreshed === "failed") return keyed(signIn.tokens.access);
    const sealed = refreshed === "lapsed" ? null : await this.sealedSignIn(bound, refreshed.kept);
    const saved = await (holder === null ? this.store.keepAppSignIn(appId, sealed, kept.sealed) : this.store.keepOwnAppSignIn(appId, holder, sealed, kept.sealed));
    if (saved) return keyed(refreshed === "lapsed" ? null : refreshed.token);
    if (refreshed !== "lapsed" && !(await this.keptSignIn(appId, holder))) this.revokeStrayTokens(bound, kept.url, refreshed.kept);
    return this.currentSignInKey(appId, holder);
  }

  /** The client `signIn`, a sign-in to the app `appId` as JSON, was made as, to keep beside it when an administrator gave it: its ID, and what its service knows it by, sealed for that app's client alone. */
  private async signInClientOf(appId: AppId, signIn: string): Promise<SignInClient | null> {
    const { ownClient, client } = JSON.parse(signIn) as SignIn;
    return ownClient && client ? { id: client.client_id, sealed: await this.sealedSignIn(`client ${appId}`, JSON.stringify(client)) } : null;
  }

  /** `signIn`, a sign-in as JSON, sealed for `boundTo` alone, an app's id or a sign-in under way's state: under the key for apps' sign-ins, with what it's for, so that one doesn't open as another's. */
  private sealedSignIn(boundTo: string, signIn: string): Promise<string> {
    return seal(this.env.SESSION_SECRET, "app-sign-in", `${boundTo}\n${signIn}`);
  }

  /** The sign-in `sealed` holds for `boundTo`, as JSON, or null for one that doesn't open, as after SESSION_SECRET changes, or is another's. */
  private async openedSignIn(boundTo: string, sealed: string): Promise<string | null> {
    const opened = await unseal(this.env.SESSION_SECRET, "app-sign-in", sealed);
    return opened?.startsWith(`${boundTo}\n`) ? opened.slice(boundTo.length + 1) : null;
  }

  /**
   * Whether the person `credentials` signs in can set up agents now, or else why not: "off" while Ember
   * AI is off, "forbidden" unless they're an administrator, or null without a valid session.
   */
  private async mayAdministerAgents(credentials: Credentials): Promise<true | "off" | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    if (!(await this.store.isAdministrator(user.id))) return "forbidden";
    return (await this.joinableAccount())?.assistant ? true : "off";
  }

  /**
   * Makes `change` to the agents as the person `credentials` signs in, one change at a time, if they're
   * an administrator then, while Ember AI is on, answering what it does: "off" while Ember AI is off,
   * "forbidden" for anyone else, or null without a valid session.
   */
  private async administerAgents<T>(credentials: Credentials, change: (user: User, account: JoinableAccount) => Promise<T>): Promise<T | "off" | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.oneAtATime(async () => {
      if (!(await this.store.isAdministrator(user.id))) return "forbidden";
      // First run made the account with its first administrator.
      const account = (await this.joinableAccount())!;
      return account.assistant ? change(user, account) : "off";
    });
  }

  /** Whether Ember AI, as `account` keeps it, asks AI Gateway through the account and API token `through` names. */
  private async asksThrough(account: JoinableAccount, through: AskedModel["through"]): Promise<boolean> {
    const opened = await this.openedAssistant(account);
    return opened !== null && opened.accountId === through.accountId && opened.apiToken === through.apiToken;
  }

  /** An agent as its page shows it to administrators, with its avatar's address. */
  private async shownAgentSettings({ avatar, ...agent }: StoredAgentSettings): Promise<AgentSettings> {
    const [shown] = await directoryOf([agent], this.env.SESSION_SECRET);
    return { ...shown!, avatar: avatar !== null };
  }

  /**
   * Whether someone or a bot called `name`, or someone new, for null, takes an agent's name by being
   * called `rename`, which nobody can, whether Ember AI is on or off, unless it was theirs already.
   */
  private async takesAgentsName(name: string | null, rename: string): Promise<boolean> {
    if (name !== null && sameName(name, rename)) return false;
    return (await this.store.agentEntries()).some((agent) => sameName(agent.name, rename));
  }

  /**
   * Bans `userId`, whatever their status, as the person `credentials` signs in, answering them as the
   * people directory then lists them: "forbidden" unless that's an administrator, "not found" if nobody
   * has the id, or it's @ember's or an agent's (`goesWithEmberAi`), or null without a valid session.
   * Nobody can ban themselves ("yourself"), so there's always an administrator. If any IP address
   * recorded on their sessions is one a ban can't block, it answers what's wrong with it and changes
   * nothing. Otherwise it blocks them all, all their sessions end, their sockets close for good, here at
   * once and in every room they're in through the outbox, and the outbox has every room they can have
   * written in delete their messages. Everyone's workspace sockets hear of it.
   */
  async banPerson(
    credentials: Credentials,
    userId: UserId,
  ): Promise<DirectoryUser | BanProblem | "your address" | "forbidden" | "not found" | "yourself" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.closingSockets(async () => {
      if (!(await this.store.isAdministrator(user.id))) return "forbidden";
      const person = (await this.goesWithEmberAi(userId)) ? null : await this.store.person(userId);
      if (!person) return "not found";
      if (userId === user.id) return "yourself";
      const ipAddresses = await this.store.sessionIpAddresses(userId);
      const problem = ipAddresses.map(banProblem).find((problem) => problem !== null);
      if (problem) return problem;
      // A ban can't block the address the administrator is using, which would stop them changing
      // anything, lifting the ban included.
      if (credentials.client.ip !== null && ipAddresses.includes(credentials.client.ip)) return "your address";

      const now = Date.now();
      const bannedAt = new Date(now).toISOString();
      // Only what differs is written, so someone banned stays as they are.
      const banned = person.status === "banned" ? null : { ...person, status: "banned" as const, updatedAt: bannedAt };
      // As when removing someone, until the database says it queued nothing.
      let queued = true;
      this.banChanges++;
      try {
        queued = await this.sessions.change(
          (session) => session.user.id === userId,
          () => this.store.banPerson(userId, ipAddresses, CloseCode.Revoked, CloseCode.Reconnect, now, bannedAt),
        );
      } finally {
        this.banChanges++;
        this.knownBannedAddresses = null;
        this.closeSockets(userId, CloseCode.Revoked);
        if (queued) await this.revocationsQueued(now);
      }
      const listed = await this.directoryUser(banned ?? person);
      if (banned) this.broadcast({ type: "user.updated", user: listed });
      return listed;
    });
  }

  /**
   * Lifts the ban on `userId` as the person `credentials` signs in, unblocking their IP addresses and
   * making them active, whatever their status was, removed included, in every open room, without
   * bringing back their messages, though rooms yet to delete theirs keep what they write from then on.
   * Answers them as the people directory then lists them, or why not, as `banPerson` does. Everyone's
   * workspace sockets hear of it.
   */
  async unbanPerson(credentials: Credentials, userId: UserId): Promise<DirectoryUser | "forbidden" | "not found" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.closingSockets(async () => {
      if (!(await this.store.isAdministrator(user.id))) return "forbidden";
      // As when banning, @ember and the agents go with Ember AI, which lifting a ban would otherwise
      // bring back, and an agent kept to the open rooms picked would be put in every one.
      const person = (await this.goesWithEmberAi(userId)) ? null : await this.store.person(userId);
      if (!person) return "not found";

      const now = Date.now();
      const unbannedAt = new Date(now).toISOString();
      // Someone active stays as they are, as when banning someone banned.
      const unbanned = person.status === "active" ? null : { ...person, status: "active" as const, updatedAt: unbannedAt };
      // As when banning someone, until the database says it queued nothing.
      let queued = true;
      this.banChanges++;
      try {
        queued = await this.store.unbanPerson(userId, CloseCode.Reconnect, now, unbannedAt);
        // Once saved, as the outbox could otherwise forget it and then read their purges from before.
        // Lifting it again keeps the first time, as their purges do.
        if (!this.liftedBans.has(userId)) this.liftedBans.set(userId, unbannedAt);
      } finally {
        this.banChanges++;
        this.knownBannedAddresses = null;
        if (queued) await this.revocationsQueued(now);
      }
      const listed = await this.directoryUser(unbanned ?? person);
      if (unbanned) this.broadcast({ type: "user.updated", user: listed });
      return listed;
    });
  }

  /**
   * Someone as the people directory lists them, with their avatar's address, and nothing else known of
   * them, such as their email address, whatever `person` brings.
   */
  private async directoryUser({ id, name, bio, role, status, updatedAt, agent, keptFor }: DirectoryEntry): Promise<DirectoryUser> {
    return (await directoryOf([{ id, name, bio, role, status, updatedAt, agent, keptFor }], this.env.SESSION_SECRET))[0]!;
  }

  /** The profile of the person `credentials` signs in, or null without a valid session. */
  async profile(credentials: Credentials): Promise<YourProfile | null> {
    const session = await this.session(credentials);
    if (!session) return null;
    const person = await this.store.ownProfile(session.user.id);
    return person && this.yourProfile(person, session);
  }

  /** `person`'s profile, as their own profile page shows it to their `session`. */
  private async yourProfile(person: OwnProfileEntry, session: StoredSession): Promise<YourProfile> {
    const { name, emailAddress, bio, avatar, password, membershipNeeded } = person;
    const [{ avatarUrl }, account] = await Promise.all([this.directoryUser(person), this.joinableAccount()]);
    const memberful = session.guest ? null : { membersOnly: account?.memberfulSignIn ?? false, accounts: person.accounts };
    const [apps, outsideAi] = await Promise.all([this.yourApps(person.id, session.guest, account), this.yourOutsideAi(person.id, session.guest, account)]);
    return {
      transfer: { userId: person.id, sessionId: session.id },
      profile: { name, emailAddress, bio, avatarUrl, avatar: avatar !== null, password, membershipNeeded, assistant: yourAssistantOf(account, person.picks), apps, outsideAi },
      memberful,
    };
  }

  /**
   * What a change to the profile of the person `credentials` signs in checks first, when it gives them
   * `emailAddress`, if it's given, or a new password if `newPassword`: the digest of their password, if
   * they have one and the change is to what they sign in with, which the Worker checks their current
   * password against, counting it against sign-in's limit for `ip`: "limited" past it. "memberful" for
   * a first password while Memberful signs them in, at `memberfulSite`, the site the deployment has the
   * keys to, if any (`signsInWithMemberfulAlone`). Null without a valid session. The passwords
   * themselves stay in the Worker, as at sign-in.
   */
  async profileCheck(
    credentials: Credentials,
    ip: string,
    emailAddress: string | undefined,
    newPassword: boolean,
    memberfulSite: string | null,
  ): Promise<{ passwordDigest: string | null } | "limited" | "memberful" | null> {
    const session = await this.session(credentials);
    const signIn = session && (await this.store.signInOf(session.user.id));
    if (!signIn) return null;
    if (signIn.passwordDigest === null) {
      const person = newPassword && memberfulSite !== null ? await this.store.ownProfile(session.user.id) : null;
      return person && signsInWithMemberfulAlone(person, memberfulSite) ? "memberful" : { passwordDigest: null };
    }
    if (!changesSignIn(signIn, emailAddress, newPassword)) return { passwordDigest: null };
    return this.signInAttempts.attempt(ip) ? { passwordDigest: signIn.passwordDigest } : "limited";
  }

  /**
   * Saves `changes` to the profile of the person `credentials` signs in, with `passwordDigest` as their
   * password if it isn't null, answering the profile as it is then: "email address taken" when someone
   * else has the email address, "password needed" when the change is to their email address or password
   * and they have a password whose digest isn't `checked`, the one the Worker checked their current
   * password against (`profileCheck`), "memberful" for a first password while Memberful signs them in at
   * `memberfulSite`, as `profileCheck` answers too, or null without a valid session. A blank email address or bio is
   * saved as none, so any number of people can be without one. It writes only what differs. A new
   * password ends their other sessions: their sockets close and are told to reconnect, here at once and
   * in every room they're in through the outbox, and their push subscriptions are forgotten but this
   * browser's, at `pushEndpoint`, and a password that replaces one they had unlinks the accounts
   * elsewhere they connected with it. Everyone's workspace sockets hear of a new name or bio, which the
   * people directory lists. A new name can't be @ember's ("name reserved"), or an agent's ("agent's
   * name"), unless it was theirs before.
   */
  async changeProfile(
    credentials: Credentials,
    changes: Pick<ProfileChanges, "name" | "emailAddress" | "bio">,
    passwordDigest: string | null,
    checked: string | null,
    pushEndpoint: string | null,
    memberfulSite: string | null,
  ): Promise<YourProfile | "email address taken" | "password needed" | "memberful" | "name reserved" | "agent's name" | null> {
    return this.closingSockets(async () => {
      // Checked in line, unlike most changes: a password reset ahead of it ends their sessions, and a
      // save whose session was still valid before then mustn't put back a password of its own.
      const session = await this.session(credentials);
      if (!session) return null;
      const { user } = session;
      const person = await this.store.ownProfile(user.id);
      if (!person) return null;
      const profile = {
        name: changes.name ?? person.name,
        emailAddress: changes.emailAddress === undefined ? person.emailAddress : changes.emailAddress || null,
        bio: changes.bio === undefined ? person.bio : changes.bio || null,
      };
      const listed = profile.name !== person.name || profile.bio !== person.bio;
      if (!listed && profile.emailAddress === person.emailAddress && passwordDigest === null) return this.yourProfile(person, session);
      if (takesReservedName(person.name, profile.name)) return "name reserved";
      if (await this.takesAgentsName(person.name, profile.name)) return "agent's name";
      // Read again here, since a reset ahead of this in line, or another change, can have replaced the password checked.
      if (person.password && changesSignIn(person, changes.emailAddress, passwordDigest !== null) && (await this.store.signInOf(user.id))?.passwordDigest !== checked) {
        return "password needed";
      }
      // Read again here too, since an account can be connected meanwhile.
      if (passwordDigest !== null && signsInWithMemberfulAlone(person, memberfulSite)) return "memberful";
      if (profile.emailAddress !== person.emailAddress && profile.emailAddress !== null && (await this.store.personWithEmailAddress(profile.emailAddress))) {
        return "email address taken";
      }

      const now = Date.now();
      const at = new Date(now).toISOString();
      const ended = passwordDigest === null ? null : { kept: session.id, pushEndpoint, code: CloseCode.Reconnect, dueAt: now };
      // A password replacing one unlinks the accounts elsewhere connected with it, while an email address
      // signs them in with it; a first keeps them, as does one saved without an email address.
      const unlinked = ended !== null && person.password && profile.emailAddress !== null;
      // As when a password is reset, until the database says it queued nothing.
      let queued = ended !== null;
      try {
        // Their sessions are read again, so they're signed in by the name they have now.
        queued = await this.sessions.change(
          (session) => session.user.id === user.id,
          () => this.store.changeProfile(user.id, { ...profile, passwordDigest }, at, ended),
        );
      } finally {
        // Whether or not it saved: the sockets of sessions that didn't end are let in again, and the sites
        // nobody is linked at anymore are forgotten.
        if (ended) this.closeSockets(user.id, CloseCode.Reconnect, sessionTag(session.id));
        if (queued) await this.revocationsQueued(now);
        if (unlinked) await this.forgetUnlinked();
      }
      const changed = { ...person, ...profile, password: person.password || passwordDigest !== null, accounts: unlinked ? [] : person.accounts, updatedAt: at };
      if (listed) this.broadcast({ type: "user.updated", user: await this.directoryUser(changed) });
      return this.yourProfile(changed, session);
    });
  }

  /**
   * Reserves `key` for a picture R2 is about to store, which an hour later R2 deletes unless someone has
   * been given it by then: the Worker stores a picture before the Workspace gives it to anyone, and
   * nothing else would delete it if that never happens.
   */
  async reservePicture(key: string): Promise<void> {
    const dueAt = Date.now() + PICTURE_RESERVATION_MS;
    await this.store.reservePicture(key, dueAt);
    await this.wakeAt(dueAt);
  }

  /**
   * Gives the person `credentials` signs in `avatar`, which R2 has stored under a key `reservePicture`
   * reserved, or takes theirs away with null, answering their profile then, or null without a valid
   * session. R2 deletes the avatar they had, and everyone's workspace sockets hear of the change, which
   * gives their avatar a new address.
   */
  async changeAvatar(credentials: Credentials, avatar: StoredPicture | null): Promise<YourProfile | null> {
    return this.inALaterSecond(() =>
      this.oneAtATime(async () => {
        const session = await this.session(credentials);
        if (!session) return null;
        const { user } = session;
        const person = await this.store.ownProfile(user.id);
        if (!person) return null;
        // Removing an avatar that isn't there changes nothing.
        if (avatar === null && person.avatar === null) return this.yourProfile(person, session);
        const now = Date.now();
        const tooSoon = tooSoonAfter(person.updatedAt, now);
        if (tooSoon) return tooSoon;
        const updatedAt = new Date(now).toISOString();
        const previous = person.avatar?.key ?? null;
        await this.store.changeAvatar(user.id, avatar, previous, updatedAt, now);
        if (previous) await this.wakeAt(now);
        const changed = { ...person, avatar, updatedAt };
        this.broadcast({ type: "user.updated", user: await this.directoryUser(changed) });
        return this.yourProfile(changed, session);
      }),
    );
  }

  /**
   * Room `roomId`'s settings, as the person `credentials` signs in sees them: "not found" unless they're
   * in it and it isn't a DM, or null without a valid session.
   */
  async roomSettings(credentials: Credentials, roomId: RoomId): Promise<RoomSettings | "not found" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return (await this.store.roomSettings(roomId, user.id)) ?? "not found";
  }

  /**
   * Makes `changes` to room `roomId` as the person `credentials` signs in, answering the room as it
   * is then: "not found" as for its settings, "forbidden" unless they can change it, or null without
   * a valid session. Anyone it takes out of the room is told to reconnect, and finds it gone, and it
   * leaves their sidebars. Everyone in it sees it as it is now in theirs, or, when only who's in it
   * changed, the people it puts in do.
   */
  async changeRoom(credentials: Credentials, roomId: RoomId, changes: RoomChanges): Promise<SharedRoom | "not found" | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.closingSockets(async () => {
      const found = await this.store.roomToChange(roomId, user.id);
      if (!found) return "not found";
      if (!found.canAdminister) return "forbidden";
      const changed: SharedRoom = {
        ...found.room,
        ...(changes.name && { name: changes.name }),
        ...(changes.kind && { kind: changes.kind }),
        ...(changes.icon !== undefined && { icon: changes.icon || null }),
      };
      if (!changes.name && !changes.kind && changes.icon === undefined) return changed;
      const now = Date.now();
      // As when signing out, until the database says it queued nothing.
      let queued = changes.kind === "closed";
      let saved: SavedRoomChange;
      try {
        saved = await this.store.changeRoom(roomId, changes, CloseCode.Reconnect, now, new Date(now).toISOString());
        queued = saved.removedIds.length > 0;
      } finally {
        if (queued) await this.revocationsQueued(now);
      }
      this.tell(saved.removedIds, { type: "room.gone", roomId });
      this.tell(saved.roomChanged ? saved.memberIds : saved.addedIds, { type: "room.saved", room: changed });
      // Whoever it puts in has heard nothing of a huddle going on there.
      const huddle = saved.addedIds.length > 0 ? await this.store.liveHuddle(roomId) : null;
      if (huddle) this.tell(saved.addedIds, { type: "room.huddle", roomId, huddle });
      // The shared order their sidebars have leaves out the rooms they weren't in, so they load it
      // again.
      if (saved.ranked) this.tell(saved.addedIds, { type: "rooms.reordered" });
      return changed;
    });
  }

  /**
   * Takes the person `credentials` signs in out of private room `roomId`, by their own choice: "not
   * found" as for its settings, "open" for an open room, which takes in everyone, "can change" for whoever
   * can change it, whose settings take them out, and who may be the last who can, "last" when nobody else
   * could open it then, or null without a valid session. Their sockets there are told to reconnect, and
   * find it gone, and it leaves their sidebars.
   */
  async leaveRoom(credentials: Credentials, roomId: RoomId): Promise<"left" | "not found" | "open" | "can change" | "last" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.closingSockets(async () => {
      const found = await this.store.roomToChange(roomId, user.id);
      if (!found) return "not found";
      if (found.room.kind !== "closed") return "open";
      if (found.canAdminister) return "can change";
      if (!(await this.store.anotherPersonInRoom(roomId, user.id))) return "last";
      const now = Date.now();
      try {
        await this.store.leaveRoom(roomId, user.id, CloseCode.Reconnect, now);
      } finally {
        // As when signing out: the database may have saved it, and so queued it, though its answer was lost.
        await this.revocationsQueued(now);
      }
      this.tell([user.id], { type: "room.gone", roomId });
      return "left";
    });
  }

  /**
   * Makes changes to rooms and to the workspace one at a time, each once the one before has finished.
   * Each reads who may make it before it writes, and on D1 other requests run in between: without
   * this, someone another change had just taken out of a room could still open it to everyone, a
   * change could write to a room deleted since it looked, and someone could join with a code just
   * regenerated.
   */
  private oneAtATime<T>(change: () => Promise<T>): Promise<T> {
    const result = this.lastChange.then(change);
    this.lastChange = result.catch(() => undefined);
    return result;
  }

  /**
   * Makes a change to someone's picture with `attempt`, which makes it one at a time with the other
   * changes, or answers TooSoon for one in the same second as their last change: it's attempted again in
   * the next, having waited out of line, so that the changes behind it don't wait too.
   */
  private async inALaterSecond<T>(attempt: () => Promise<T | TooSoon>): Promise<T> {
    for (;;) {
      const changed = await attempt();
      if (!(changed instanceof TooSoon)) return changed;
      await scheduler.wait(changed.ms);
    }
  }

  /**
   * Deletes room `roomId` as the person `credentials` signs in: "not found" unless they're in it,
   * "forbidden" unless they can change it, or null without a valid session. Anyone in a DM can delete
   * it. Everyone with it open is told it's gone, and its messages go with it. It leaves the sidebars of
   * the people who were in it, and nobody else hears of it.
   */
  async deleteRoom(credentials: Credentials, roomId: RoomId): Promise<"deleted" | "not found" | "forbidden" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return this.closingSockets(async () => {
      const found = await this.store.roomToDelete(roomId, user.id);
      if (!found) return "not found";
      if (found.kind !== "direct" && !found.canAdminister) return "forbidden";
      const now = Date.now();
      let memberIds: UserId[];
      try {
        memberIds = await this.store.deleteRoom(roomId, CloseCode.NotFound, now, new Date(now).toISOString());
      } finally {
        // As when signing out: the database may have saved the deletion, and so queued it, though its answer was lost.
        await this.revocationsQueued(now);
      }
      this.tell(memberIds, { type: "room.gone", roomId });
      return "deleted";
    });
  }

  /**
   * Applies the events room `roomId` sends from its log, in order, with `viewerIds`, who is viewing the
   * room as it sends them: a new message marks the room unread for its members who aren't, and someone
   * opening it clears their mark. Each event is applied once, however often it's sent. Whoever's mark
   * changes hears of it on their workspace sockets, and nobody else does. A new message in a DM moves it
   * to the top of everyone's DMs there, its author's too, and one call's messages move it once. It
   * answers the bots' webhooks each new message is delivered to, the new messages @ember is to answer
   * and, while Web Push is on, their pushes, for the room to send, none of them to a guest while
   * `EMBER_GUEST_SIGN_IN` doesn't let guests stay signed in.
   */
  async applyRoomEvents(roomId: RoomId, events: RoomEvent[], viewerIds: UserId[]): Promise<RoomEventDeliveries> {
    if (events.length === 0) return { pushes: [], webhooks: [], asks: [] };
    const { on: pushing } = await webPush(this.env);
    const { marks, active, pushes, webhooks, asks } = await this.store.applyRoomEvents(roomId, events, viewerIds, pushing, guestSignIn(this.env));
    for (const [userId, at] of marks) this.tell([userId], at === null ? { type: "room.read", roomId } : { type: "room.unread", roomId, at });
    if (active) this.tell(active.userIds, { type: "room.active", roomId, at: active.at });
    return { pushes, webhooks, asks };
  }

  /**
   * Whether push subscription `id` is still saved, for someone still active, as a room asks just before
   * sending a push that waited its turn, so that one banned, removed or suspended meanwhile gets none.
   */
  async pushable(id: number): Promise<boolean> {
    return this.store.pushable(id);
  }

  /**
   * Forgets the push subscriptions with `ids`, which a push service has said are gone, or whose keys no
   * push can be encrypted for, logging each as it does.
   */
  async forgetPushSubscriptions(ids: number[]): Promise<void> {
    for (const id of ids) console.log(`Destroying push subscription: ${id}`);
    await this.store.forgetPushSubscriptions(ids);
  }

  /**
   * What a search by the person `credentials` signs in needs, having first recorded the search whose key
   * is `recording` (@ember/protocol `searchKey`) as their newest, when it's given, or null without a valid
   * session.
   */
  async searcher(credentials: Credentials, recording: string | null): Promise<Searcher | null> {
    const user = await this.authenticate(credentials);
    return user && { userId: user.id, ...(await this.store.searcherOf(user.id, recording)) };
  }

  /** Forgets the recent searches of the person `credentials` signs in, answering false without a valid session. */
  async clearSearches(credentials: Credentials): Promise<boolean> {
    const user = await this.authenticate(credentials);
    if (user) await this.store.clearSearches(user.id);
    return user !== null;
  }

  /**
   * Saves a browser's push subscription, already checked, for the person `credentials` signs in, with
   * the browser's user agent, answering false without a valid session, or if it ends before the
   * subscription is saved, as a password reset can on D1. Given none, it only checks the session, for a
   * subscription that's refused. It replaces the subscription of theirs it names, the one the same
   * browser had at the address it moved from to Ember's custom domain.
   */
  async savePushSubscription(credentials: Credentials, subscription: PushSubscriptionSave | null): Promise<boolean> {
    const session = await this.session(credentials);
    if (!session || !subscription) return session !== null;
    const { replacing = null, ...keys } = subscription;
    return this.store.savePushSubscription(session.user.id, session.id, keys, credentials.client.userAgent, replacing, new Date().toISOString());
  }

  /** The push subscriptions of the person `credentials` signs in, or null without a valid session. */
  async pushSubscriptions(credentials: Credentials): Promise<StoredPushSubscription[] | null> {
    const user = await this.authenticate(credentials);
    return user && this.store.pushSubscriptionsOf(user.id);
  }

  /**
   * Where a test push to push subscription `id` goes, if it's the person's `credentials` signs in, with
   * their unread count as its badge: "missing" if it's someone else's, or there's no such subscription
   * or no id, and null without a valid session.
   */
  async testPushDelivery(credentials: Credentials, id: number | null): Promise<PushDelivery | "missing" | null> {
    const user = await this.authenticate(credentials);
    if (!user) return null;
    return (id !== null && (await this.store.testPushDelivery(user.id, id))) || "missing";
  }

  /**
   * Deletes push subscription `id` if it's the person's `credentials` signs in, and does nothing if it's
   * someone else's or there's no id, answering false without a valid session.
   */
  async deletePushSubscription(credentials: Credentials, id: number | null): Promise<boolean> {
    const user = await this.authenticate(credentials);
    if (user && id !== null) await this.store.deletePushSubscription(user.id, id);
    return user !== null;
  }

  /**
   * The people of `ids` who exist, whatever their status, for a room naming the people a message
   * mentions.
   */
  async mentionedPeople(ids: UserId[]): Promise<User[]> {
    return this.store.peopleWithIds(ids);
  }

  /**
   * The people of `ids` who exist, whatever their status, as the people directory lists them, for the
   * bot API's messages, which show their writers as `users/_user.json` does, and for a room finding
   * which of those who wrote what @ember read are bots.
   */
  async directoryEntries(ids: UserId[]): Promise<DirectoryEntry[]> {
    return this.store.directoryEntries(ids);
  }

  /**
   * The active bot a bot API key names by `botId` and `token`, if it's in room `roomId`, with when this
   * checked and Ember's custom domain: "not found" when it isn't, as `set_room` answers then, or null
   * unless `token` is the bot's token now, or the one its webhook's deliveries give it in that room now.
   */
  async botInRoom(botId: UserId, token: string, roomId: RoomId): Promise<BotKeyAccess | "not found" | null> {
    // Before anything is read, as `roomAccess` takes it.
    const authorizedAt = Date.now();
    const [found, account] = await Promise.all([this.store.activeBotKey(botId, roomId), this.joinableAccount()]);
    if (!found || !(isBotToken(token, found.token) || (await this.isWebhookToken(token, roomId, found)))) return null;
    return found.member ? { bot: found.bot, authorizedAt, customDomain: account?.customDomain ?? null, takesClicks: found.webhook !== null } : "not found";
  }

  /** Whether `token` is the one a delivery to the webhook of the bot `found` gives it in room `roomId`, as the webhook is now. */
  private async isWebhookToken(token: string, roomId: RoomId, { bot, token: own, webhook }: BotKey): Promise<boolean> {
    return webhook !== null && isBotToken(token, await webhookTokenOf(this.env.SESSION_SECRET, roomId, bot.id, { token: own, ...webhook }));
  }

  /**
   * The webhook of the bot `botId` in room `roomId` as a delivery to it finds it, when its turn comes and
   * again before what the bot says back is posted, with when this checked: null once it isn't an active
   * bot in the room with a webhook, so that deleting a bot, taking it out of the room or removing its
   * webhook stops what's on its way to it, and a new URL or key takes effect at once. The key it gives
   * the bot in the room's address is the webhook's own there, which stops working once the webhook
   * delivers elsewhere or goes, or the bot is given a new key, so a server Ember has stopped delivering
   * to can't go on posting as the bot, nor reading its rooms.
   */
  async botWebhook(roomId: RoomId, botId: UserId): Promise<WebhookAccess | null> {
    // Before anything is read, as `roomAccess` takes it.
    const authorizedAt = Date.now();
    const webhook = await this.store.botWebhook(roomId, botId);
    if (!webhook) return null;
    const { bot, url } = webhook;
    return { bot, url, key: botKeyOf(bot.id, await webhookTokenOf(this.env.SESSION_SECRET, roomId, bot.id, webhook)), authorizedAt };
  }

  /**
   * The webhook of the bot `botId` in room `roomId` as the delivery of a click by `clickerId` finds it, as
   * `botWebhook` finds it for a message's, with who clicked and the room's name: null as `botWebhook`
   * answers it, and once whoever clicked isn't an active member of the room, so that a click waiting its
   * turn goes nowhere once they're taken out.
   */
  async clickWebhook(roomId: RoomId, botId: UserId, clickerId: UserId): Promise<ClickAccess | null> {
    // Before anything is read, as `roomAccess` takes it.
    const authorizedAt = Date.now();
    const found = await this.store.clickWebhook(roomId, botId, clickerId);
    if (!found) return null;
    const { bot, url, clicker, roomName } = found;
    return { bot, url, key: botKeyOf(bot.id, await webhookTokenOf(this.env.SESSION_SECRET, roomId, bot.id, found)), authorizedAt, clicker, roomName };
  }

  /**
   * The bot `botId` that answers a question in room `roomId` that `askerId` asked, @ember or an AI agent,
   * as the question finds it when its turn comes and again before its answer is posted (`assistantIn`,
   * `agentIn`): null once Ember AI is off, the bot isn't in the room, or it's an agent that doesn't answer
   * them there, so that what's on its way stops.
   */
  async answererIn(roomId: RoomId, botId: UserId, askerId: UserId): Promise<AssistantAccess | null> {
    return botId === ASSISTANT_ID ? this.assistantIn(roomId, askerId) : this.agentIn(roomId, botId, askerId);
  }

  /**
   * @ember in room `roomId`, with when this checked, how it asks AI Gateway, or null while its API token
   * doesn't open (`assistantGateway`), with the model whoever asked, `askerId`, picked, while people can
   * pick it, the instructions administrators added and what Ember adds around them, the community's
   * name, what @ember may do on the web, with whichever model answers, of what its format has tools for,
   * and Ember's addresses: null once Ember AI is off or @ember isn't in the room, so that turning Ember
   * AI off, or taking @ember out of a room, stops what's on its way there.
   */
  private async assistantIn(roomId: RoomId, askerId: UserId): Promise<AssistantAccess | null> {
    // Before anything is read, as `roomAccess` takes it.
    const authorizedAt = Date.now();
    const [account, member, picks] = await Promise.all([this.joinableAccount(), this.store.isMember(roomId, ASSISTANT_ID), this.store.assistantPicks(askerId)]);
    if (!account?.assistant || !member) return null;
    const [opened, offered] = await Promise.all([this.openedAssistant(account), this.offeredForAnswers(account.assistant.accountId)]);
    if (opened) this.moveToProviderEndpoints(account.assistant, opened);
    const picked = pickedModelOf(account.assistant, picks);
    const model = picked?.id ?? account.assistant.model;
    const saved = { format: (picked ?? account.assistant).format, thinkingLevels: answeringModelOf(account.assistant, picked)?.thinkingLevels };
    const { format, thinkingLevels } = askedAs(model, saved, offered.workersAi);
    const gateway = opened && { ...opened, model, format, thinkingLevels };
    const levels = levelsOf(picks, account.assistantMost);
    const webTools = account.assistant.webTools.filter((tool) => webToolsOf(model, format, offered.file).includes(tool));
    const webSearchOn = account.assistant.webTools.includes("search");
    const bot = { id: ASSISTANT_ID, name: ASSISTANT_NAME };
    const { assistantInstructions: instructions, assistantPromptTemplate: promptTemplate } = account;
    const appTools = gateway ? await this.toolsFor(ASSISTANT_ID, roomId, askerId) : [];
    return { bot, authorizedAt, gateway, picked: picked !== null, instructions, promptTemplate, community: account.name, levels, webTools, webSearchOn, addresses: addressesOf(account), appTools };
  }

  /**
   * Agent `agentId` in room `roomId`, as `assistantIn` finds @ember: asking AI Gateway through Ember AI's
   * account and API token, with its own model, instructions, what Ember adds around them, and levels, and
   * what it may do on the web, of what its model's format has tools for: null once Ember AI is off, the
   * agent is deleted or taken out of the room, or it's kept for administrators and doesn't answer whoever
   * asked there (`ANSWERING_AGENT`).
   */
  private async agentIn(roomId: RoomId, agentId: UserId, askerId: UserId): Promise<AssistantAccess | null> {
    const authorizedAt = Date.now();
    const [account, agent] = await Promise.all([this.joinableAccount(), this.store.answeringAgent(roomId, agentId, askerId)]);
    if (!account?.assistant || !agent) return null;
    const [opened, offered] = await Promise.all([this.openedAssistant(account), this.offeredForAnswers(account.assistant.accountId)]);
    if (opened) this.moveToProviderEndpoints(account.assistant, opened);
    const { format, thinkingLevels } = askedAs(agent.model, { format: agent.format, thinkingLevels: agent.thinkingLevels ?? undefined }, offered.workersAi);
    const gateway = opened && { ...opened, model: agent.model, format, thinkingLevels };
    const webTools = agent.webTools.filter((tool) => webToolsOf(agent.model, format, offered.file).includes(tool));
    const bot = { id: agentId, name: agent.name };
    const { instructions, promptTemplate, levels } = agent;
    const appTools = gateway ? await this.toolsFor(agentId, roomId, askerId) : [];
    return { bot, authorizedAt, gateway, picked: false, instructions, promptTemplate, community: account.name, levels, webTools, webSearchOn: webTools.includes("search"), addresses: addressesOf(account), appTools };
  }

  /**
   * Has Ember AI, `assistant`, ask the models it asks through Cloudflare's REST API, the agents' too, that
   * their providers' own endpoints answer through `gateway`'s account and API token there from then on,
   * as it asks Claude and GPT there first now: once after each time it's set up, as the first
   * answer after that finds it, in the background, a few models at each answer (`providerMovesOf`).
   */
  private moveToProviderEndpoints(assistant: SavedAssistant, gateway: Gateway): void {
    if (assistant.providerEndpointsTriedAt !== null || this.movingToProviderEndpoints) return;
    const moving = this.movedToProviderEndpoints(gateway)
      .catch((error: unknown) => console.error("Moving models onto their providers' endpoints failed:", error instanceof Error ? error.message : "unknown error"))
      .finally(() => (this.movingToProviderEndpoints = null));
    this.movingToProviderEndpoints = moving;
    this.ctx.waitUntil(moving);
  }

  /**
   * Asks the models people can pick, and the agents' models, that Ember AI asks through Cloudflare's
   * REST API, the test question through their providers' endpoints (`providerMovesOf`), then, one change
   * at a time with the others, has each that answered asked there, wherever it's still where it was,
   * with the levels of thinking it took there, while Ember AI still asks through `gateway`'s account and
   * API token, which the endpoints answered, and records when unless there are more to ask at the next
   * answer. Set up again while they were asked, Ember AI keeps none of it, even with the same API token,
   * which may have been given AI Gateway Run since, and the next answer asks them again. What @ember and
   * the agents may do on the web stays as it was, since a provider's own endpoint takes the tools the
   * REST API passed on to it.
   */
  private async movedToProviderEndpoints(gateway: Gateway): Promise<void> {
    const triedAt = new Date().toISOString();
    const setups = this.assistantSetups;
    const [account, agentModels] = await Promise.all([this.joinableAccount(), this.store.agentModels()]);
    if (!account?.assistant || account.assistant.providerEndpointsTriedAt !== null) return;
    const { moves, done } = await providerMovesOf(this.env, gateway, [...account.assistant.models, ...agentModels]);
    await this.oneAtATime(async () => {
      if (this.assistantSetups !== setups) return;
      const changed = await this.joinableAccount();
      if (!changed?.assistant || !(await this.asksThrough(changed, gateway))) return;
      const assistant = { ...movedIn(changed.assistant, moves), providerEndpointsTriedAt: done ? triedAt : null };
      await this.storeAccount({ ...changed, assistant }, () => this.store.moveModels(assistant, moves));
    });
  }

  /**
   * Whether `userId` is an active administrator now, for a room deciding whether they may edit or
   * delete someone else's message. Rooms ask, since a role can change while their sockets are open.
   */
  async isAdministrator(userId: UserId): Promise<boolean> {
    return this.store.isAdministrator(userId);
  }

  /**
   * Who `credentials` signs in, with their session, whether they're in room `roomId` and whether a ban
   * blocks the IP address they come from, as of `authorizedAt`, or null without a valid session.
   */
  async roomAccess(credentials: Credentials, roomId: RoomId): Promise<RoomAccess | null> {
    // Before anything is read, so that a revocation saved while this checks counts as later than it,
    // and the room turns the socket away if it arrives after the revocation does.
    const authorizedAt = Date.now();
    const session = await this.session(credentials);
    if (!session) return null;
    // From the database rather than what `isBanned` keeps, which a ban saving now hasn't changed yet.
    const { member, banned } = await this.store.roomAccess(roomId, session.user.id, credentials.client.ip);
    return { user: session.user, sessionId: session.id, member, banned, authorizedAt };
  }

  /**
   * Whether a ban blocks the IP address `ipAddress`: that exact address, however else it could be
   * written. The Worker asks before every request that changes something, so the addresses are read once
   * and kept until a ban changes.
   */
  async isBanned(ipAddress: string): Promise<boolean> {
    return (await this.bannedAddresses()).has(ipAddress);
  }

  private async bannedAddresses(): Promise<Set<string>> {
    if (this.knownBannedAddresses) return this.knownBannedAddresses;
    const changes = this.banChanges;
    const addresses = new Set(await this.store.bannedAddresses());
    // On D1, a ban can be saved while this reads, and then what it found is older.
    if (changes === this.banChanges) this.knownBannedAddresses = addresses;
    return addresses;
  }

  /**
   * Delivers what's due in the outbox, at most `DELIVERIES_PER_RUN` rows, revocations first, then checks
   * the memberships due, and sets the alarm for whatever is due next.
   */
  override async alarm(): Promise<void> {
    const revocations = await this.deliverRevocations((now) => this.store.dueRevocations(now, DELIVERIES_PER_RUN));
    const purges = await this.deliverPurges(DELIVERIES_PER_RUN - revocations);
    const reindexes = await this.deliverReindexes(DELIVERIES_PER_RUN - revocations - purges);
    await this.deletePictures(DELIVERIES_PER_RUN - revocations - purges - reindexes);
    await this.checkMemberships();
    await this.scheduleDelivery();
  }

  /**
   * Checks the memberships due with the Memberful site's admin API, having queued everyone's if the daily
   * catch-up is due, as many as one request asks after, and goes by what it says, as a sign-in goes by
   * what it reads (`settleMembership`). A check Memberful failed to answer before is asked alone, so that
   * a member it can't answer for holds up nobody else, and one it fails to answer now is put off, as a
   * revocation is. Memberships are checked whether Memberful is on or not, since the members who joined
   * with it keep signing in with it, but while the deployment can't ask its admin API, nothing is checked,
   * and whatever was queued is forgotten.
   */
  private async checkMemberships(): Promise<void> {
    const api = await this.memberfulApi();
    const now = Date.now();
    const due = await this.store.dueMembershipChecks(api?.site ?? null, now, now + MEMBERSHIP_CATCH_UP_MS, MEMBERSHIPS_PER_CHECK);
    if (!api || due.length === 0) return;
    const checks = due[0]!.attempts > 0 ? due.slice(0, 1) : due.filter(({ attempts }) => attempts === 0);
    const subjects = checks.map(({ subject }) => subject);
    const readAt = Date.now();
    const memberships = await membershipsOf(api, subjects);
    if (memberships) await this.oneAtATime(() => this.applyMemberships(api.site, memberships, readAt));
    await this.store.settleMembershipChecks(api.site, subjects, memberships ? readAt : null, Date.now());
  }

  /**
   * Goes by what Memberful said of each membership in `memberships`, by the subject of its account at the
   * Memberful site `issuer`, as read at `readAt`, as `settleMembership` does, recording all the reads that
   * change nothing at once.
   */
  private async applyMemberships(issuer: string, memberships: Map<string, boolean>, readAt: number): Promise<void> {
    const unchanged: string[] = [];
    for (const [subject, linked] of await this.store.linkedPeople(issuer, [...memberships.keys()])) {
      // The Workspace has gone by a newer read.
      if (linked.checkedAt > readAt) continue;
      const change = membershipChange(linked, memberships.get(subject)!);
      if (change === "lapsed") await this.suspendLapsed(linked.userId, issuer, subject, readAt);
      else if (change === "renewed") await this.restoreRenewed(linked.userId, issuer, subject, readAt);
      else unchanged.push(subject);
    }
    await this.store.stampMemberships(issuer, unchanged, readAt);
  }

  /**
   * Sends rooms the revocations `read` finds, each room its own in one call, once the delivery before
   * has finished: never two at once, since each settles the rows it read by their ids, and a deleted
   * row's id can go to the next row queued (SQLite gives a new row the largest id and one), which a
   * delivery still holding the old id would then settle undelivered. Those a room doesn't take are
   * tried again later, for as long as it takes. Answers how many it read.
   */
  private deliverRevocations(read: (now: number) => Promise<PendingRevocation[]>): Promise<number> {
    const delivery = this.lastDelivery.then(() => this.sendRevocations(read));
    this.lastDelivery = delivery.catch(() => undefined);
    return delivery;
  }

  /** Delivers the revocations `read` finds now (see `deliverRevocations`). */
  private async sendRevocations(read: (now: number) => Promise<PendingRevocation[]>): Promise<number> {
    const due = await read(Date.now());
    // Read after the rows, so it's later than every change that queued them, and so later than any
    // check that saw what came before one of those changes.
    const revokedAt = Date.now();
    const delivered: number[] = [];
    const failed: number[] = [];
    await eachAtMost([...Map.groupBy(due, (revocation) => revocation.roomId)], ROOMS_AT_ONCE, async ([roomId, revocations]) => {
      const ids = revocations.map(({ id }) => id);
      try {
        await this.env.CHAT_ROOM.getByName(roomId).revoke(roomId, revocations.map(({ tag, code }) => ({ tag, code })), revokedAt);
        delivered.push(...ids);
      } catch (error) {
        console.error(`Could not close sockets in room ${roomId}; trying again later`, error);
        failed.push(...ids);
      }
    });
    await this.store.settleRevocations(delivered, failed, Date.now());
    return due.length;
  }

  /**
   * Asks rooms to delete the messages of the people banned since, up to `limit` rooms, each
   * `MESSAGES_PER_PURGE` at a time, and only those written before the ban was lifted, if it has been,
   * even while it's asking. A room that has more of theirs left is asked again at once, and one that
   * can't be reached later, as a revocation is. A room is asked only once the sockets queued to close
   * there have closed, as those delivered just before may have, so a banned person can't write through
   * one after it's done. Answers how many it read.
   */
  private async deliverPurges(limit: number): Promise<number> {
    if (limit <= 0) return 0;
    // The purges it reads know of every ban lifted before.
    this.liftedBans.clear();
    const due = await this.store.duePurges(Date.now(), limit);
    if (due.length === 0) return 0;
    const finished: number[] = [];
    const unfinished: number[] = [];
    const failed: number[] = [];
    await eachAtMost(due, ROOMS_AT_ONCE, async ({ id, roomId, userId, liftedAt }) => {
      try {
        const until = liftedAt ?? this.liftedBans.get(userId) ?? null;
        const more = await this.env.CHAT_ROOM.getByName(roomId).removeMessagesBy(roomId, userId, MESSAGES_PER_PURGE, until);
        (more ? unfinished : finished).push(id);
      } catch (error) {
        console.error(`Could not delete messages in room ${roomId}; trying again later`, error);
        failed.push(id);
      }
    });
    await this.store.settlePurges(finished, unfinished, failed, Date.now());
    return due.length;
  }

  /**
   * Asks rooms to have the search index take all their messages, up to `limit` rooms, as each room the
   * workspace had when the index was new is asked once (migrations/0022_pending_reindexes.sql). One that
   * can't be reached is asked again later, as a revocation is.
   */
  private async deliverReindexes(limit: number): Promise<number> {
    if (limit <= 0) return 0;
    const due = await this.store.dueReindexes(Date.now(), limit);
    if (due.length === 0) return 0;
    const delivered: RoomId[] = [];
    const failed: RoomId[] = [];
    await eachAtMost(due, ROOMS_AT_ONCE, async (roomId) => {
      try {
        await this.env.CHAT_ROOM.getByName(roomId).reindex(roomId);
        delivered.push(roomId);
      } catch (error) {
        console.error(`Could not have room ${roomId} index its messages; trying again later`, error);
        failed.push(roomId);
      }
    });
    await this.store.settleReindexes(delivered, failed, Date.now());
    return due.length;
  }

  /**
   * Has R2 delete the pictures due now, up to `limit` of them, with their variants, in one call: the
   * avatars and logos people replaced or removed, and those nobody was given once their reservations ran out.
   * When R2 fails, they're tried again later, as a revocation is.
   */
  private async deletePictures(limit: number): Promise<void> {
    if (limit <= 0) return;
    const due = await this.store.duePictureDeletions(Date.now(), limit);
    if (due.length === 0) return;
    try {
      if (!this.env.FILES) throw new Error("No R2 bucket is bound as FILES");
      await this.env.FILES.delete(due.flatMap(pictureObjects));
      await this.store.settlePictureDeletions(due, [], Date.now());
    } catch (error) {
      console.error("Could not delete pictures from R2; trying again later", error);
      await this.store.settlePictureDeletions([], due, Date.now());
    }
  }

  /**
   * Sets the alarm for the outbox's next delivery due, as the Workspace starts, having made the daily
   * check of memberships due at once if the deployment can ask Memberful's admin API, anyone here is
   * linked to an account at its site, and none is due, as when it has only just been given the API's
   * key.
   */
  private async resumeDeliveries(): Promise<void> {
    const api = await this.memberfulApi();
    if (api) await this.store.startMembershipCatchUp(api.site, Date.now());
    await this.scheduleDelivery();
  }

  /** Sets the alarm for the outbox's next delivery due, if any is waiting. */
  private async scheduleDelivery(): Promise<void> {
    const next = await this.store.nextDeliveryDue();
    if (next !== null) await this.wakeAt(next);
  }

  /**
   * Makes a change that may end someone's access, one at a time with the other changes (`oneAtATime`),
   * and if it queued revocations, delivers them before answering (`closeQueuedSockets`): once the next
   * change can begin, so a room that's slow to answer holds up nothing else.
   */
  private closingSockets<T>(change: () => Promise<T>): Promise<T> {
    return this.afterQueuing(() => this.oneAtATime(change));
  }

  /** Runs `change`, and if it queued revocations (`revocationsQueued`), delivers them before answering. */
  private async afterQueuing<T>(change: () => Promise<T>): Promise<T> {
    const queued = this.queuedRevocations;
    try {
      return await change();
    } finally {
      // Whether or not the change answered: on D1 it can be saved and its answer lost.
      if (this.queuedRevocations !== queued) await this.closeQueuedSockets();
    }
  }

  /**
   * Sets the alarm for the revocations a change queued at `now`, so they're delivered even if nothing
   * else here runs, and notes that it queued them, so `afterQueuing` delivers them at once.
   */
  private async revocationsQueued(now: number): Promise<void> {
    this.queuedRevocations++;
    await this.wakeAt(now);
  }

  /**
   * Delivers the revocations a change has just queued, as the alarm would a moment later: until a room
   * has them, a socket there whose access has ended can still read and write. Delivers what's queued
   * and not yet tried, the rooms queued last first and every row of each, so a backlog of older rows
   * doesn't crowd the change's out of the run, and one call closes however many sockets the change
   * ends in a room. Waits at most CLOSING_SOCKETS_MS, so a room that's slow to answer, or a delivery
   * under way, doesn't hold the change up; the alarm, set as the rows were queued, delivers whatever
   * is left later.
   */
  private async closeQueuedSockets(): Promise<void> {
    const delivery = this.deliverRevocations((now) => this.store.queuedRevocations(now, DELIVERIES_PER_RUN)).catch((error) =>
      console.error("Could not close sockets at once; the alarm will", error),
    );
    const waited = new AbortController();
    try {
      await Promise.race([delivery, scheduler.wait(CLOSING_SOCKETS_MS, { signal: waited.signal })]);
    } finally {
      // Stops the wait once the rooms have answered, rather than leaving it to run out.
      waited.abort();
    }
  }

  /**
   * Sets the alarm for `time`, unless it's already set for sooner, and for now if `time` has passed:
   * the runtime refuses an alarm at 0, the time the migrations that reindex every room queue them for.
   */
  private async wakeAt(time: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > time) await this.ctx.storage.setAlarm(Math.max(time, Date.now()));
  }

  /**
   * Registers rooms from before the Workspace kept a list as open rooms everyone is in, so their old
   * addresses keep their messages, and keeps the people who wrote or reacted in them as deactivated
   * guests. Their messages go in the search index through the outbox. Rooms already registered are
   * left alone, so this runs again harmlessly.
   */
  async registerLegacyRooms(ids: RoomId[]): Promise<void> {
    const unregistered = await this.store.unregisteredRooms(ids);
    for (const id of unregistered) {
      const authors = await this.env.CHAT_ROOM.getByName(id).authors(id);
      await this.store.registerLegacyRoom(id, authors, new Date().toISOString());
    }
    if (unregistered.length > 0) await this.wakeAt(Date.now());
  }
}

export const workspace = (env: Env) => env.WORKSPACE.getByName("workspace");
