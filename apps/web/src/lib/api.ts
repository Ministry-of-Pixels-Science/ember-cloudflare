import {
  AVATAR_PATH,
  LOGO_PATH,
  MEMBERFUL_CONNECTIONS_PATH,
  roomSocketQuery,
  searchQuery,
  WORKSPACE_PRELOADS,
  type Account,
  type AccountChanges,
  type AssistantChanged,
  type AssistantChanges,
  type AssistantForgotten,
  type AssistantKeys,
  type AssistantSaved,
  type AssistantSetup,
  type Bootstrap,
  type Bot,
  type BotAnswer,
  type BotChanges,
  type Bots,
  type BotSettings,
  type ChangedPerson,
  type CustomDomainCheck,
  type CustomDomainLookup,
  type CustomDomainReach,
  type CustomStyles,
  type DirectRoom,
  type Directory,
  type DirectoryUser,
  type EmailLinkFor,
  type EmailLinkKind,
  type EmailLinkRequest,
  type EmailLinkSignUp,
  type EmailSettings,
  type Favorites,
  type HuddlesForgotten,
  type HuddlesSaved,
  type HuddlesSettings,
  type HuddlesSetup,
  type InvitationOutcome,
  type Invited,
  type Involvement,
  type LinkPreview,
  type LinkSignIn,
  type Me,
  type MemberfulConnection,
  type MemberfulConnectionStart,
  type MemberfulDisconnection,
  type NewAssistantModel,
  type OfferedModels,
  type NewDirect,
  type NewJoinCode,
  type NewRoom,
  type NewRoomForm,
  type NewBot,
  type NewWorkspace,
  type OpenSignUp,
  type PasswordResetDone,
  type PasswordResetRequest,
  type PasswordResetWithCode,
  type PasswordSignIn,
  type PersonAnswer,
  type PersonRole,
  type ProfileAnswer,
  type ProfileChanges,
  type PushSubscriptionKeys,
  type PushSubscriptionSave,
  type PushSubscriptions,
  type ReleaseCheck,
  type ResentInvitation,
  type Room,
  type RoomChanges,
  type RoomId,
  type RoomSettings,
  type RoomSocketParams,
  type SavedPushSubscription,
  type Search,
  type SearchResults,
  type SearchSort,
  type SendingDomainCheck,
  type SentTestEmail,
  type SharedRoom,
  type Sidebar,
  type SignOut,
  type SignUp,
  type StartedDirect,
  type TurnstileKeysChange,
  type TurnstileSettings,
  type UserId,
  type WebSearchChanged,
  type WorkspaceSettings,
  type YourAssistantChanged,
  type YourAssistantChanges,
} from "@ember/protocol";
import type { Agent, AgentAnswer, AgentChanges, Agents, AgentSettings, AgentTrial, AgentTrialAnswer, NewAgent } from "@ember/protocol/agents";
import type {
  AgentToolPicks,
  AgentTools,
  App,
  AppAnswer,
  AppChanges,
  AppClient,
  AppId,
  AppRemoved,
  Apps,
  AppSignedIn,
  AppSignInBegun,
  AppSignInReturn,
  AppSummary,
  NewApp,
  NewAppSignIn,
  OfferedApp,
  ToolPick,
  YourAppSignedIn,
  YourAppSignedOut,
} from "@ember/protocol/apps";
import type { OutsideAiSettings, OutsideAnswer, OutsideAnswered, OutsideAsk, OutsideAsked, YourOutsideAi } from "@ember/protocol/outside";
import type { LogoVariants } from "@/lib/previews";

// The session lives in an HttpOnly cookie, which the browser sends with every request and socket,
// so nothing here handles a token.

export type { Room, Sidebar };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The form field the error is about, when it's about one. */
    readonly field?: string,
    /** The page to go to instead, when the server names one. */
    readonly redirect?: string,
    /** Whether an app's server refused for want of a sign-in, which Ember can begin. */
    readonly signIn?: boolean,
    /** Whether an app's sign-in wants a client ID that Ember can't get itself, which the app's form then asks for. */
    readonly client?: boolean,
  ) {
    super(message);
  }
}

/** Whether `error` says this browser's session has ended, which matters whatever page is showing. */
export const isSignedOut = (error: unknown) => error instanceof ApiError && error.status === 401;

/** What an answer carries, or the ApiError it says why it failed with. */
async function dataOf<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; field?: string; redirect?: string; signIn?: unknown; client?: unknown };
  if (!response.ok) {
    throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`, data.field, data.redirect, data.signIn === true || undefined, data.client === true || undefined);
  }
  return data;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  // A form says its own type, with the boundary between its parts.
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  return dataOf<T>(await fetch(path, { ...init, headers }));
}

/** A photo chosen for an avatar, with the variant made of it, or null where none could be made (`avatarVariantOf`). */
export interface ChosenPhoto {
  file: File;
  variant: Blob | null;
}

/** The fields of a form that can bring a photo with them: a sign-up form's, a bot form's, or an agent's page's. */
type UserFields = SignUp | EmailLinkSignUp | NewBot | BotChanges | NewAgent | AgentChanges;

/**
 * A form bringing `photo` as its `avatar` and `variant`, as the Worker reads one, and with `fields` as
 * JSON in its `user`.
 */
function photoForm({ file, variant }: ChosenPhoto, fields?: UserFields): FormData {
  const form = new FormData();
  if (fields) form.set("user", JSON.stringify(fields));
  form.set("avatar", file);
  if (variant) form.set("variant", variant, "variant");
  return form;
}

/** What a sign-up form, a bot form or an agent's page sends: its fields as JSON, or with the photo chosen, a form. */
const userBody = (fields: UserFields, photo: ChosenPhoto | null) => (photo ? photoForm(photo, fields) : JSON.stringify(fields));

/** Whether Ember is set up yet, and who this browser is signed in as. */
export async function fetchBootstrap(): Promise<Bootstrap> {
  return request<Bootstrap>("/api/bootstrap");
}

/**
 * Takes what the page preloaded of the workspace (`WORKSPACE_PRELOADS`) and drops it, once the page
 * finds that the session its cookie named has ended, so that what was preloaded only says so. A request
 * takes a preloaded answer once, so otherwise the workspace's first, once someone signs in on this page,
 * would take those and go straight back to sign in.
 */
export function dropWorkspacePreloads(): void {
  for (const path of WORKSPACE_PRELOADS) void fetch(path).then((response) => response.body?.cancel(), () => {});
}

/**
 * The setup password, or the setup link's token, as a bearer token: percent-encoded, since a header can't
 * hold every character a password can.
 */
const setupAuthorization = (secret: string) => ({ Authorization: `Bearer ${encodeURIComponent(secret)}` });

/**
 * Checks the setup password typed into Set up Ember before the rest of its form is filled in, failing
 * with an ApiError that says why the Worker refuses it.
 */
export async function checkSetupPassword(password: string): Promise<void> {
  await request<unknown>("/api/first_run/check", { method: "POST", headers: setupAuthorization(password) });
}

/**
 * Sets up the workspace with its first administrator, with the photo they chose, if any, and signs this
 * browser in as them, with the setup password or link's token where the deployment takes one. A photo
 * that's refused fails with an ApiError for the `avatar` field.
 */
export async function setUpWorkspace(administrator: SignUp, photo: ChosenPhoto | null = null, setupSecret: string | null = null): Promise<NewWorkspace> {
  const headers = setupSecret === null ? undefined : setupAuthorization(setupSecret);
  return request<NewWorkspace>("/api/first_run", { method: "POST", headers, body: userBody(administrator, photo) });
}

/**
 * Joins the workspace with the code from its join link, as someone new, with the photo they chose, if
 * any, and signs this browser in as them. The code is the link's own path segment, which needs no
 * escaping. A photo that's refused fails with an ApiError for the `avatar` field.
 */
export async function joinWorkspace(joinCode: string, person: SignUp, photo: ChosenPhoto | null = null): Promise<Me> {
  return (await request<{ user: Me }>(`/api/join/${joinCode}`, { method: "POST", body: userBody(person, photo) })).user;
}

/**
 * Signs up while anyone may, as someone new, with the photo they chose, if any, and the token of
 * Turnstile's check while the page shows one, and signs this browser in as them. A check that didn't
 * pass fails with an ApiError for the `turnstile` field.
 */
export async function signUp(person: OpenSignUp, photo: ChosenPhoto | null = null): Promise<Me> {
  return (await request<{ user: Me }>("/api/join", { method: "POST", body: userBody(person, photo) })).user;
}

/** What the link Ember emailed whose secret is `token` is, and whom it's for, while it works. Fails with a 404 ApiError saying so once it doesn't. */
export async function lookUpEmailLink(token: string): Promise<EmailLinkFor> {
  return request<EmailLinkFor>("/api/email_links/lookup", { method: "POST", body: JSON.stringify({ token }) });
}

/** Where each kind of link Ember emails posts its join form. */
const EMAIL_LINK_JOINS: Record<EmailLinkKind, string> = { invitation: "/api/join/invitation", email_domain: "/api/join/email" };

/**
 * Joins with a link Ember emailed, of `kind`: an invitation, or one asked for with an address at the
 * workspace's email domains, as the person `person` describes, with the email address it was sent to and
 * the photo they chose, if any, and signs this browser in as them. A link that has stopped working fails
 * with a 404 ApiError, and an address with an account since with one that names the sign-in page to go
 * to.
 */
export async function joinWithEmailLink(kind: EmailLinkKind, person: EmailLinkSignUp, photo: ChosenPhoto | null = null): Promise<Me> {
  return (await request<{ user: Me }>(EMAIL_LINK_JOINS[kind], { method: "POST", body: userBody(person, photo) })).user;
}

/**
 * Asks Ember to email a link to join with an address at the workspace's email domains, with the token of
 * Turnstile's check while the page shows one. It answers the same whether or not the address has an
 * account. A check that didn't pass fails with an ApiError for the `turnstile` field, and an address
 * Ember won't email with one for `emailAddress`.
 */
export async function askForEmailLink(asked: EmailLinkRequest): Promise<void> {
  await request<unknown>("/api/email_links", { method: "POST", body: JSON.stringify(asked) });
}

/**
 * Asks Ember to email a code to reset the password of whoever has `asked.emailAddress`, with the token
 * of Turnstile's check while the page shows one. It answers the same whether or not anyone has the
 * address. A check that didn't pass fails with an ApiError for the `turnstile` field, and one while
 * Ember can't send email with a 503.
 */
export async function askForPasswordResetCode(asked: PasswordResetRequest): Promise<void> {
  await request<unknown>("/api/password_resets", { method: "POST", body: JSON.stringify(asked) });
}

/**
 * Gives whoever has `reset.emailAddress` the password `reset.password`, with the code Ember emailed
 * them, ending all their sessions, and signs this browser in as them: who they are, or null when they
 * sign in themselves, as Memberful's members do while it's members only. A code that doesn't work fails
 * with an ApiError for the `code` field.
 */
export async function resetPasswordWithCode(reset: PasswordResetWithCode): Promise<Me | null> {
  return (await request<PasswordResetDone>("/api/password_resets", { method: "PUT", body: JSON.stringify(reset) })).user;
}

/**
 * Signs in with an email address and password: who signed in, or, for a member whose password checks out
 * while Memberful is members only, until they've connected their Memberful account, where to connect it,
 * which signs them in and opens the page `credentials.returnTo` names.
 */
export async function signIn(credentials: PasswordSignIn): Promise<Me | MemberfulConnection> {
  const answer = await request<{ user: Me } | MemberfulConnection>("/api/session", { method: "POST", body: JSON.stringify(credentials) });
  return "memberfulConnection" in answer ? answer : answer.user;
}

/** Signs in with just a name, as someone new. */
export async function signInAsGuest(name: string): Promise<Me> {
  return (await request<{ user: Me }>("/api/session", { method: "POST", body: JSON.stringify({ name }) })).user;
}

/**
 * Signs in with a sign-in link's id, as whoever it was made for, replacing any session this browser has.
 * The id goes in the body, so no request's address holds it. Fails with a 400 ApiError for a link
 * that's expired, tampered with, or for someone no longer active.
 */
export async function signInWithLink(transferId: string): Promise<Me> {
  const body: LinkSignIn = { transferId };
  return (await request<{ user: Me }>("/api/session/transfers", { method: "POST", body: JSON.stringify(body) })).user;
}

/**
 * Ends this browser's session, and forgets your push subscriptions with `pushSubscriptionEndpoint`, the
 * endpoint of the one this browser just ended, if it had one.
 */
export async function signOut(pushSubscriptionEndpoint: string | null = null): Promise<void> {
  const body: SignOut = pushSubscriptionEndpoint === null ? {} : { pushSubscriptionEndpoint };
  await request("/api/session", { method: "DELETE", body: JSON.stringify(body) });
}

/**
 * Saves this browser's push subscription for you, so that pushes reach it, or records that it was saved
 * again, replacing your subscription with the P-256 key `replacing`, if given.
 */
export async function savePushSubscription(subscription: PushSubscriptionKeys, replacing: string | null = null): Promise<void> {
  const body: PushSubscriptionSave = replacing === null ? subscription : { ...subscription, replacing };
  await request("/api/push-subscriptions", { method: "POST", body: JSON.stringify(body) });
}

/** Your browsers' push subscriptions, oldest first, with the browsers that saved them. */
export async function fetchPushSubscriptions(): Promise<SavedPushSubscription[]> {
  return (await request<PushSubscriptions>("/api/push-subscriptions")).subscriptions;
}

/** Deletes your push subscription `id`, which does nothing if there's no such subscription of yours. */
export async function deletePushSubscription(id: number): Promise<void> {
  await request(`/api/push-subscriptions/${id}`, { method: "DELETE" });
}

/** Pushes "Ember Test" to your push subscription `id` at once. Fails with a 500 ApiError if the push does. */
export async function sendTestNotification(id: number): Promise<void> {
  await request(`/api/push-subscriptions/${id}/test-notifications`, { method: "POST" });
}

/** Who this browser is signed in as. Fails with a 401 ApiError when it isn't signed in. */
export async function fetchMe(): Promise<Me> {
  return (await request<{ user: Me }>("/api/me")).user;
}

/**
 * Someone, whatever their status, for their page, with their email address and a new sign-in link for
 * them if you're an administrator. Fails with a 404 ApiError when nobody has id `userId`.
 */
export async function fetchPerson(userId: UserId): Promise<PersonAnswer> {
  return request<PersonAnswer>(`/api/users/${encodeURIComponent(userId)}`);
}

/** Your profile, for the profile page: your name, email address and bio, and a new sign-in link. */
export async function fetchProfile(): Promise<ProfileAnswer> {
  return request<ProfileAnswer>("/api/users/me/profile");
}

/**
 * Starts connecting your account to an account at the Memberful site, with your password while you have
 * one: where to sign in there, which sends the browser back to your profile. Fails with a 422 ApiError
 * without your password, or with one that isn't yours, and a 409 once you've connected one.
 */
export async function connectMemberful(currentPassword?: string): Promise<MemberfulConnection> {
  const start: MemberfulConnectionStart = currentPassword === undefined ? {} : { currentPassword };
  return request<MemberfulConnection>(MEMBERFUL_CONNECTIONS_PATH, { method: "POST", body: JSON.stringify(start) });
}

/**
 * Disconnects your account from your Memberful account, with your password, ending your other sessions
 * but keeping this browser's push subscription, as a new password does, and answers your profile as it
 * is then, with a new sign-in link. Fails with a 422 ApiError without your password, or with one that
 * isn't yours, or while you have no password, and a 404 once it's disconnected.
 */
export async function disconnectMemberful(disconnection: MemberfulDisconnection): Promise<ProfileAnswer> {
  return request<ProfileAnswer>(MEMBERFUL_CONNECTIONS_PATH, { method: "DELETE", body: JSON.stringify(disconnection) });
}

/**
 * Changes your profile, answering it as it is then, with a new sign-in link. A blank password keeps the
 * one you have. Fails with a 422 ApiError for an email address someone else has.
 */
export async function changeProfile(changes: ProfileChanges): Promise<ProfileAnswer> {
  return request<ProfileAnswer>("/api/users/me/profile", { method: "PATCH", body: JSON.stringify(changes) });
}

/**
 * Makes `photo` your avatar, answering your profile as it is then, with a new sign-in link. Fails with a
 * 413 ApiError for a photo over 16 MB, and a 503 where Ember isn't set up to store files.
 */
export async function changeAvatar(photo: ChosenPhoto): Promise<ProfileAnswer> {
  return request<ProfileAnswer>(AVATAR_PATH, { method: "PUT", body: photoForm(photo) });
}

/** Takes away your avatar, so your initials show, answering your profile as it is then. */
export async function removeAvatar(): Promise<ProfileAnswer> {
  return request<ProfileAnswer>(AVATAR_PATH, { method: "DELETE" });
}

/** Workspace settings: the workspace, its join code, and whether this person can change it. */
export async function fetchWorkspaceSettings(): Promise<WorkspaceSettings> {
  return request<WorkspaceSettings>("/api/account");
}

/** Changes the workspace, answering it as it is then. Fails with a 403 ApiError for anyone but an administrator. */
export async function changeAccount(changes: AccountChanges): Promise<Account> {
  return (await request<{ account: Account }>("/api/account", { method: "PATCH", body: JSON.stringify(changes) })).account;
}

/** What `domain`, a custom domain Ember moved away from, reaches, as Check in Workspace settings asks: this Ember, something else, or nothing. */
export async function checkCustomDomain(domain: string): Promise<CustomDomainReach> {
  return (await request<CustomDomainCheck>("/api/account/custom_domain_checks", { method: "POST", body: JSON.stringify({ domain }) })).reaches;
}

/** Where the DNS of `domain` is, as Set up in Workspace settings asks for its steps: the zone it's in and who serves it, either null where DNS doesn't say. */
export async function lookUpCustomDomain(domain: string): Promise<CustomDomainLookup> {
  return request<CustomDomainLookup>("/api/account/custom_domain_lookups", { method: "POST", body: JSON.stringify({ domain }) });
}

/**
 * The release this Ember is, and the newest one GitHub names, as General settings says, null when GitHub
 * didn't name one, as GitHub last told the Worker, which asks it again every six hours. Fails with a 403
 * ApiError for anyone but an administrator.
 */
export async function checkForRelease(): Promise<ReleaseCheck> {
  return request<ReleaseCheck>("/api/account/release");
}

/** The same, once the Worker has asked GitHub again, as opening Admin has it do, unless it asked in the last minute. */
export async function checkForReleaseAfresh(): Promise<ReleaseCheck> {
  return request<ReleaseCheck>("/api/account/release_checks", { method: "POST" });
}

/** A logo chosen for the workspace, with the variants made of it, or null where none could be made (`logoVariantsOf`). */
export interface ChosenLogo {
  file: File;
  variants: LogoVariants | null;
}

/**
 * Makes `logo` the workspace's, answering the workspace as it is then. Fails with a 403 ApiError for
 * anyone but an administrator, a 413 for a logo over 16 MB, and a 503 where Ember isn't set up to store files.
 */
export async function changeLogo({ file, variants }: ChosenLogo): Promise<Account> {
  const form = new FormData();
  form.set("logo", file);
  if (variants) {
    form.set("large", variants.large, "large");
    form.set("small", variants.small, "small");
  }
  return (await request<{ account: Account }>(LOGO_PATH, { method: "PUT", body: form })).account;
}

/** Takes away the workspace's logo, so Ember's flame shows, answering the workspace as it is then. Fails as `changeLogo` does. */
export async function removeLogo(): Promise<Account> {
  return (await request<{ account: Account }>(LOGO_PATH, { method: "DELETE" })).account;
}

/** The workspace's custom CSS, for the Custom CSS page. Fails with a 403 ApiError for anyone but an administrator. */
export async function fetchCustomStyles(): Promise<string> {
  return (await request<CustomStyles>("/api/account/custom_styles")).customStyles;
}

/** Saves the workspace's custom CSS, answering the workspace as it is then. Fails with a 403 ApiError for anyone but an administrator. */
export async function changeCustomStyles(customStyles: string): Promise<Account> {
  return (await request<{ account: Account }>("/api/account/custom_styles", { method: "PATCH", body: JSON.stringify({ customStyles }) })).account;
}

/** The active bots, by name, each with its key and its rooms. Fails with a 403 ApiError for anyone but an administrator. */
export async function fetchBots(): Promise<Bot[]> {
  return (await request<Bots>("/api/account/bots")).bots;
}

/**
 * The active bot `botId`, with where its webhook delivers. Fails with a 403 ApiError for anyone but an
 * administrator, and a 404 for an id that isn't an active bot's.
 */
export async function fetchBot(botId: UserId): Promise<BotSettings> {
  return (await request<BotAnswer>(`/api/account/bots/${encodeURIComponent(botId)}`)).bot;
}

/**
 * Adds a bot, with the avatar chosen for it, if any. Fails with a 403 ApiError for anyone but an
 * administrator, and a 422 for a name or webhook URL that's refused.
 */
export async function createBot(bot: NewBot, avatar: ChosenPhoto | null = null): Promise<void> {
  await request("/api/account/bots", { method: "POST", body: userBody(bot, avatar) });
}

/**
 * Changes the bot `botId`, leaving what `changes` leaves out, and gives it the avatar chosen, if any. Fails
 * as `fetchBot` does, and as `createBot` does for what's refused.
 */
export async function changeBot(botId: UserId, changes: BotChanges, avatar: ChosenPhoto | null = null): Promise<void> {
  await request(`/api/account/bots/${encodeURIComponent(botId)}`, { method: "PATCH", body: userBody(changes, avatar) });
}

/** Deletes the bot `botId`, which takes it out of every room but its DMs. Fails as `fetchBot` does. */
export async function deleteBot(botId: UserId): Promise<void> {
  await request(`/api/account/bots/${encodeURIComponent(botId)}`, { method: "DELETE" });
}

/** Gives the bot `botId` a new key, so its old one stops working. Fails as `fetchBot` does. */
export async function resetBotKey(botId: UserId): Promise<void> {
  await request(`/api/account/bots/${encodeURIComponent(botId)}/key`, { method: "PUT" });
}

/** Gives the join link a new code, answering it. Fails with a 403 ApiError for anyone but an administrator. */
export async function regenerateJoinCode(): Promise<string> {
  return (await request<NewJoinCode>("/api/account/join_code", { method: "POST" })).joinCode;
}

/**
 * Sends you a test email from the workspace's From address, answering the address it went to. Fails
 * with an ApiError saying why it wasn't sent: 503 while Ember can't send email, 422 without a From
 * address or an email address of yours, 502 when the provider refused it, and 403 for anyone but an
 * administrator.
 */
export async function sendTestEmail(): Promise<string> {
  return (await request<SentTestEmail>("/api/account/test_email", { method: "POST" })).to;
}

/**
 * Whether `domain` is onboarded to Cloudflare Email Sending, as the records Onboard Domain adds to its
 * DNS say, or null when DNS didn't answer. Fails with a 403 ApiError for anyone but an administrator.
 */
export async function checkSendingDomain(domain: string): Promise<boolean | null> {
  return (await request<SendingDomainCheck>("/api/account/sending_domain_checks", { method: "POST", body: JSON.stringify({ domain }) })).onboarded;
}

/**
 * Gives Ember a Resend API key to send email with, answering how it sends email then. Fails with a 422
 * ApiError for a key Resend doesn't take, saying why, a 502 one when Resend can't say, and a 403 one for
 * anyone but an administrator.
 */
export async function saveResendApiKey(apiKey: string): Promise<EmailSettings> {
  return request<EmailSettings>("/api/account/resend_api_key", { method: "PUT", body: JSON.stringify({ apiKey }) });
}

/** Takes away the Resend API key Ember was given, answering how it sends email then. Fails with a 403 ApiError for anyone but an administrator. */
export async function forgetResendApiKey(): Promise<EmailSettings> {
  return request<EmailSettings>("/api/account/resend_api_key", { method: "DELETE" });
}

/**
 * Gives Ember a Turnstile widget's keys to check people with, with the token the widget's check gave Set
 * up Turnstile, answering where Ember's keys come from then. Fails with a 422 ApiError on the field a key
 * or the check is refused on, a 502 one when Ember couldn't ask Cloudflare, and a 403 one for anyone but
 * an administrator.
 */
export async function saveTurnstileKeys(keys: TurnstileKeysChange): Promise<TurnstileSettings["turnstile"]> {
  return (await request<TurnstileSettings>("/api/account/turnstile_keys", { method: "PUT", body: JSON.stringify(keys) })).turnstile;
}

/** Takes away the Turnstile widget's keys Ember was given, answering where its keys come from then. Fails with a 403 ApiError for anyone but an administrator. */
export async function forgetTurnstileKeys(): Promise<TurnstileSettings["turnstile"]> {
  return (await request<TurnstileSettings>("/api/account/turnstile_keys", { method: "DELETE" })).turnstile;
}

/**
 * Gives Ember a Realtime SFU app's ID and secret to run huddles through, answering huddles as they are
 * then. Fails with a 422 ApiError on the field Ember or Cloudflare refuses, a 502 one when Ember couldn't
 * ask Cloudflare, and a 403 one for anyone but an administrator.
 */
export async function saveHuddles(setup: HuddlesSetup): Promise<HuddlesSettings> {
  return (await request<HuddlesSaved>("/api/account/huddles", { method: "PUT", body: JSON.stringify(setup) })).huddles;
}

/** Turns huddles off, forgetting the SFU app's keys Ember was given. Fails with a 403 ApiError for anyone but an administrator. */
export async function forgetHuddles(): Promise<null> {
  return (await request<HuddlesForgotten>("/api/account/huddles", { method: "DELETE" })).huddles;
}

/**
 * The models Ember offers, as Set up Ember AI, Add a model and the agents' pages list them: those the
 * models file lists, then Workers AI's, as Cloudflare's model search lists them for the account `keys`
 * names, with its API token, as Set up Ember AI has them typed, or else Ember AI's, or why they aren't
 * listed. Fails with a 422 ApiError on a field that can't be what it's for, and a 403 one for anyone but
 * an administrator.
 */
export async function fetchOfferedModels(keys?: AssistantKeys): Promise<OfferedModels> {
  return request<OfferedModels>("/api/account/assistant/offered", { method: "POST", body: JSON.stringify(keys ?? {}) });
}

/**
 * Turns Ember AI on with `setup`, or changes it, once the model has answered a test question through AI
 * Gateway, answering Ember AI as it is then and what the model said. Fails with a 422 ApiError on the
 * field AI Gateway or the Worker refuses, or with none for the credits, a 429 one while AI Gateway turns
 * requests away, a 502 one when it didn't answer, and a 403 one for anyone but an administrator.
 */
export async function saveAssistant(setup: AssistantSetup): Promise<AssistantSaved> {
  return request<AssistantSaved>("/api/account/assistant", { method: "PUT", body: JSON.stringify(setup) });
}

/**
 * Adds `model` to the models people can pick, once it has answered a test question through Ember AI's
 * account, answering Ember AI as it is then and what the model said. Fails as `saveAssistant` does, with
 * a 422 ApiError on the model's field once people can pick as many as they can, and a 409 one while
 * Ember AI is off, or once it was set up again while the model answered.
 */
export async function addAssistantModel(model: NewAssistantModel): Promise<AssistantSaved> {
  return request<AssistantSaved>("/api/account/assistant/models", { method: "POST", body: JSON.stringify(model) });
}

/**
 * Takes the model `model` out of those people can pick, answering Ember AI as it is then. Fails with a
 * 409 ApiError for the one that answers everyone, or while Ember AI is off, and a 403 one for anyone but
 * an administrator.
 */
export async function removeAssistantModel(model: string): Promise<AssistantChanged["assistant"]> {
  return (await request<AssistantChanged>("/api/account/assistant/models", { method: "DELETE", body: JSON.stringify({ model }) })).assistant;
}

/**
 * Gives @ember the avatar `photo` is, in place of Ember's flame or the one it had, answering Ember AI as
 * it is then. Fails with a 409 ApiError while Ember AI is off, and a 403 one for anyone but an
 * administrator.
 */
export async function changeAssistantAvatar(photo: ChosenPhoto): Promise<AssistantChanged["assistant"]> {
  return (await request<AssistantChanged>("/api/account/assistant/avatar", { method: "PUT", body: photoForm(photo) })).assistant;
}

/** Takes away the avatar @ember was given, bringing back Ember's flame, answering Ember AI as it is then. Fails as `changeAssistantAvatar` does. */
export async function removeAssistantAvatar(): Promise<AssistantChanged["assistant"]> {
  return (await request<AssistantChanged>("/api/account/assistant/avatar", { method: "DELETE" })).assistant;
}

/** Turns Ember AI off, forgetting its API token. Fails with a 403 ApiError for anyone but an administrator. */
export async function forgetAssistant(): Promise<null> {
  return (await request<AssistantForgotten>("/api/account/assistant", { method: "DELETE" })).assistant;
}

/**
 * Changes the most each of @ember's dials goes to for anyone's questions, or which of the models people
 * can pick it answers everyone else with, answering Ember AI as it is then. Fails with a 409 ApiError
 * while it's off, a 422 one for a model people can't pick, and a 403 one for anyone but an administrator.
 */
export async function changeAssistantSettings(changes: AssistantChanges): Promise<AssistantChanged["assistant"]> {
  return (await request<AssistantChanged>("/api/account/assistant", { method: "PATCH", body: JSON.stringify(changes) })).assistant;
}

/**
 * Turns Search the web on, once the model Ember AI answers everyone with has searched the web for a test
 * question through AI Gateway, or off, answering Ember AI as it is then and, once it's on, what the model
 * said. Fails with a 422 ApiError when AI Gateway refused the model's tools for the web, the model
 * answered without searching or can't search, a 429 one while AI Gateway turns requests away, a 502 one
 * when it didn't answer, a 409 one while Ember AI is off, or changed while the model searched, and a 403
 * one for anyone but an administrator.
 */
export async function changeWebSearch(on: boolean): Promise<WebSearchChanged> {
  return request<WebSearchChanged>("/api/account/assistant/web_search", { method: "PUT", body: JSON.stringify({ on }) });
}

/** The agents, by name. Fails with a 409 ApiError while Ember AI is off, and a 403 one for anyone but an administrator. */
export async function fetchAgents(): Promise<Agent[]> {
  return (await request<Agents>("/api/account/agents")).agents;
}

/** Agent `agentId`, as its page shows it. Fails as `fetchAgents` does, and with a 404 ApiError for an id that isn't an agent's. */
export async function fetchAgent(agentId: UserId): Promise<AgentSettings> {
  return (await request<AgentAnswer>(`/api/account/agents/${encodeURIComponent(agentId)}`)).agent;
}

/**
 * Makes an agent, with the avatar chosen for it, if any, once its model has answered a test question
 * through Ember AI's account, and searched the web, if it's to, answering it as its page then shows it.
 * Fails with a 422 ApiError on the field AI Gateway or the Worker refuses, a 429 one while AI Gateway
 * turns requests away, a 502 one when the model didn't answer, a 409 one while Ember AI is off or once
 * there are as many agents as there can be, and a 403 one for anyone but an administrator.
 */
export async function createAgent(agent: NewAgent, avatar: ChosenPhoto | null = null): Promise<AgentSettings> {
  return (await request<AgentAnswer>("/api/account/agents", { method: "POST", body: userBody(agent, avatar) })).agent;
}

/**
 * Changes agent `agentId`, leaving what `changes` leaves out, and gives it the avatar chosen, if any,
 * answering it as its page then shows it. Fails as `fetchAgent` does, as `createAgent` does for what's
 * refused, and with a 409 ApiError when it was changed while its model answered.
 */
export async function changeAgent(agentId: UserId, changes: AgentChanges, avatar: ChosenPhoto | null = null): Promise<AgentSettings> {
  return (await request<AgentAnswer>(`/api/account/agents/${encodeURIComponent(agentId)}`, { method: "PATCH", body: userBody(changes, avatar) })).agent;
}

/** Takes away the avatar agent `agentId` was given, answering it as its page then shows it. Fails as `fetchAgent` does. */
export async function removeAgentAvatar(agentId: UserId): Promise<AgentSettings> {
  return (await request<AgentAnswer>(`/api/account/agents/${encodeURIComponent(agentId)}/avatar`, { method: "DELETE" })).agent;
}

/** Deletes agent `agentId`. Fails as `fetchAgent` does. */
export async function deleteAgent(agentId: UserId): Promise<void> {
  await request(`/api/account/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
}

/** The connected apps, by name. Fails with a 403 ApiError for anyone but an administrator, and a 409 while Ember AI is off. */
export async function fetchApps(): Promise<AppSummary[]> {
  return (await request<Apps>("/api/account/apps")).apps;
}

/** App `appId`, as its page shows it. Fails as `fetchApps` does, and with a 404 ApiError for an id that isn't a connected app's. */
export async function fetchApp(appId: AppId): Promise<App> {
  return (await request<AppAnswer>(`/api/account/apps/${encodeURIComponent(appId)}`)).app;
}

/**
 * Connects an app, once Ember has read its server's tools, answering it as its page shows it. Fails as
 * `fetchApps` does, with a 422 ApiError naming the field for what's refused, the address when its
 * server doesn't answer as one does, and with a 409 when as many apps are connected as can be.
 */
export async function connectApp(app: NewApp): Promise<App> {
  return (await request<AppAnswer>("/api/account/apps", { method: "POST", body: JSON.stringify(app) })).app;
}

/**
 * Begins a sign-in to the server of `app`, one to connect, answering where its authorization server
 * signs people in, to send the browser. Fails as `connectApp` does, the 422 saying why Ember can't use
 * the sign-in its server describes, if it describes one.
 */
export async function beginNewAppSignIn(app: NewAppSignIn): Promise<string> {
  return (await request<AppSignInBegun>("/api/account/app-sign-ins", { method: "POST", body: JSON.stringify(app) })).authorizationUrl;
}

/**
 * Begins a sign-in to the server of the connected app `appId`, again or in place of its token, as
 * `beginNewAppSignIn` does, as `client` when the app's page asks who Ember is there, and otherwise as
 * the app last signed in. Fails as it and `fetchApp` do.
 */
export async function beginAppSignIn(appId: AppId, client?: AppClient): Promise<string> {
  const body = client && { body: JSON.stringify(client) };
  return (await request<AppSignInBegun>(`/api/account/apps/${encodeURIComponent(appId)}/sign-in`, { method: "POST", ...body })).authorizationUrl;
}

/**
 * Finishes the sign-in an authorization server sent the browser `back` from, answering the app, connected
 * by it or signed in to `again`, or, for a sign-in you made to a connected app yourself, the app as your
 * profile then lists it. Fails as `fetchApps` does, and with a 422 ApiError for a sign-in that has
 * ended, was begun by someone else, or that its server didn't finish.
 */
export async function finishAppSignIn(back: AppSignInReturn): Promise<AppSignedIn | YourAppSignedIn> {
  return request<AppSignedIn | YourAppSignedIn>("/api/account/app-sign-ins/finish", { method: "POST", body: JSON.stringify(back) });
}

/** Begins a sign-in you make to the connected app `appId` yourself, answering where to send the browser. Fails with an ApiError: 404 for an app that isn't one Ember signs in to, 409 while Ember AI is off, 422 when its server has no sign-in Ember can use. */
export async function beginOwnAppSignIn(appId: AppId): Promise<string> {
  return (await request<AppSignInBegun>(`/api/users/me/apps/${encodeURIComponent(appId)}/sign-in`, { method: "POST" })).authorizationUrl;
}

/** Forgets the sign-in you made to the connected app `appId` yourself, answering the apps as your profile then lists them, and whether its service took the sign-in back. Fails as `beginOwnAppSignIn` does. */
export async function signOutOfApp(appId: AppId): Promise<YourAppSignedOut> {
  return request<YourAppSignedOut>(`/api/users/me/apps/${encodeURIComponent(appId)}/sign-in`, { method: "DELETE" });
}

/**
 * What the page says of `ask`, an AI app's request to connect to Ember as you. Fails with a 401 ApiError
 * once the session has ended, a 403 for someone who signed in with just a name, a 409 while outside AI
 * is off, and a 422 for a request Ember can't answer.
 */
export function describeOutsideAsk(ask: OutsideAsk): Promise<OutsideAsked> {
  return request<OutsideAsked>("/api/outside/asks", { method: "POST", body: JSON.stringify(ask) });
}

/** Answers `ask`, whether to connect its app as you, answering where to send the browser: back to the app. Fails as `describeOutsideAsk` does, and with a 409 when you have as many connected as one may. */
export async function answerOutsideAsk(ask: OutsideAsk, allow: boolean): Promise<string> {
  return (await request<OutsideAnswered>("/api/outside/answers", { method: "POST", body: JSON.stringify({ ask, allow } satisfies OutsideAnswer) })).redirectTo;
}

/** Ends the connection `id` of yours, answering the ones you have left. Fails with a 401 ApiError once the session has ended, a 409 while outside AI is off, and a 404 once the connection has ended. */
export function disconnectOutside(id: string): Promise<YourOutsideAi> {
  return request<YourOutsideAi>(`/api/users/me/outside/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Lets AI apps connect to Ember, or stops them, which ends every connection, answering which. Fails with a 401 ApiError once the session has ended, and a 403 unless you're an administrator. */
export function changeOutsideAi(on: boolean): Promise<OutsideAiSettings> {
  return request<OutsideAiSettings>("/api/account/outside_ai", { method: "PUT", body: JSON.stringify({ on }) });
}

/** Changes app `appId`, leaving what `changes` leaves out, answering it as its page then shows it. Fails as `fetchApp` and `connectApp` do. */
export async function changeApp(appId: AppId, changes: AppChanges): Promise<App> {
  return (await request<AppAnswer>(`/api/account/apps/${encodeURIComponent(appId)}`, { method: "PATCH", body: JSON.stringify(changes) })).app;
}

/** Reads app `appId`'s tools from its server again, answering it as its page then shows it. Fails as `fetchApp` does, and with a 422 ApiError when its server doesn't answer as one does. */
export async function readAppTools(appId: AppId): Promise<App> {
  return (await request<AppAnswer>(`/api/account/apps/${encodeURIComponent(appId)}/tools`, { method: "POST" })).app;
}

/**
 * Every connected app's tools as the page of `agentId`, @ember or an agent, offers them, with which it
 * may use. Fails as `fetchApps` does, and with a 404 ApiError for an id that isn't @ember's or an agent's.
 */
export async function fetchAgentTools(agentId: UserId): Promise<OfferedApp[]> {
  return (await request<AgentTools>(`/api/account/agents/${encodeURIComponent(agentId)}/tools`)).apps;
}

/**
 * Has `tools` be every tool `agentId` may use from then on, answering what its page then offers. Fails
 * as `fetchAgentTools` does, with a 422 ApiError for more than an agent uses, and with a 409 for a tool
 * that isn't a connected app's any more, or that its app describes another way than when it was offered.
 */
export async function pickAgentTools(agentId: UserId, tools: ToolPick[]): Promise<OfferedApp[]> {
  const picks: AgentToolPicks = { tools };
  return (await request<AgentTools>(`/api/account/agents/${encodeURIComponent(agentId)}/tools`, { method: "PUT", body: JSON.stringify(picks) })).apps;
}

/** Disconnects app `appId`, answering whether its service took back Ember's sign-in to it, if Ember was signed in to it. Fails as `fetchApp` does. */
export function disconnectApp(appId: AppId): Promise<Partial<AppRemoved>> {
  return request<Partial<AppRemoved>>(`/api/account/apps/${encodeURIComponent(appId)}`, { method: "DELETE" });
}

/**
 * Asks the agent as `trial` sets it up, saved as `agentId` or not yet, its question, answering what it
 * said and how long its model took. Nothing is saved. Fails as `createAgent` does.
 */
export async function tryAgent(trial: AgentTrial, agentId: UserId | null): Promise<AgentTrialAnswer> {
  const path = agentId === null ? "/api/account/agents/trials" : `/api/account/agents/${encodeURIComponent(agentId)}/trials`;
  return request<AgentTrialAnswer>(path, { method: "POST", body: JSON.stringify(trial) });
}

/**
 * Changes how much @ember thinks and how long it answers you, or the model it answers you with, answering
 * yours as they are then, or null while Ember AI is off. Fails with a 422 ApiError for a model people
 * can't pick.
 */
export async function changeYourAssistant(changes: YourAssistantChanges): Promise<YourAssistantChanged["assistant"]> {
  return (await request<YourAssistantChanged>("/api/users/me/assistant", { method: "PATCH", body: JSON.stringify(changes) })).assistant;
}

/**
 * Invites each of `emailAddresses`, no more than `INVITATIONS_AT_ONCE`, by email, answering what came of
 * each, in order. Fails with a 422 ApiError for a list it doesn't take, and a 403 one for anyone but an
 * administrator.
 */
export async function inviteByEmail(emailAddresses: string[]): Promise<InvitationOutcome[]> {
  return (await request<Invited>("/api/invitations", { method: "POST", body: JSON.stringify({ emailAddresses }) })).outcomes;
}

/** Gives the invitation `id` a new link in place of its old one, emailed as inviting does, answering it. Fails with a 404 ApiError once it's been accepted or revoked. */
export async function resendInvitation(id: string): Promise<ResentInvitation> {
  return request<ResentInvitation>(`/api/invitations/${encodeURIComponent(id)}/resend`, { method: "POST" });
}

/** Revokes the invitation `id`, so that its link joins no one. Fails with a 404 ApiError once it's been accepted or revoked. */
export async function revokeInvitation(id: string): Promise<void> {
  await request(`/api/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Makes someone an administrator or a member, answering them as the people directory then lists them.
 * Fails with a 403 ApiError for anyone but an administrator, and for their own role or a bot's.
 */
export async function changeRole(userId: UserId, role: PersonRole): Promise<DirectoryUser> {
  return (await request<ChangedPerson>(`/api/account/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify({ role }) })).user;
}

/**
 * Removes someone from the workspace, answering them as the people directory then lists them. Fails
 * with a 403 ApiError for anyone but an administrator, and for themselves, and a 404 unless they're active.
 */
export async function removePerson(userId: UserId): Promise<DirectoryUser> {
  return (await request<ChangedPerson>(`/api/account/users/${encodeURIComponent(userId)}`, { method: "DELETE" })).user;
}

/**
 * Bans someone, blocking the IP addresses they've signed in from, ending their sessions and deleting
 * their messages, and answers them as the people directory then lists them. Fails with a 403 ApiError
 * for anyone but an administrator, and for themselves, a 404 when nobody has id `userId`, and a 422 when
 * they've signed in from an address a ban can't block.
 */
export async function banPerson(userId: UserId): Promise<DirectoryUser> {
  return (await request<ChangedPerson>(`/api/users/${encodeURIComponent(userId)}/ban`, { method: "POST" })).user;
}

/** Lifts someone's ban, making them active, and answers them as `banPerson` does. */
export async function unbanPerson(userId: UserId): Promise<DirectoryUser> {
  return (await request<ChangedPerson>(`/api/users/${encodeURIComponent(userId)}/ban`, { method: "DELETE" })).user;
}

/** A copy of someone's sidebar, and the ETag the server sent it with. */
export interface SidebarCopy {
  sidebar: Sidebar;
  etag: string | null;
}

/**
 * This person's sidebar, or `copy` while it's still current. The server keeps the sidebar out of the
 * browser's cache, since it can hold the join code, so the app keeps its own copy, and says which it has
 * with the copy's ETag.
 */
export async function fetchSidebar(copy: SidebarCopy | null): Promise<SidebarCopy> {
  const response = await fetch("/api/sidebar", copy?.etag ? { headers: { "If-None-Match": copy.etag } } : {});
  if (copy && response.status === 304) return copy;
  return { sidebar: await dataOf<Sidebar>(response), etag: response.headers.get("ETag") };
}

/** Dismisses the welcome card for this person, for good: their sidebar, on any device, has no invitation from then on. */
export async function dismissInvitation(): Promise<void> {
  await request("/api/sidebar/invitation", { method: "DELETE" });
}

/** A copy of the people directory, and the ETag the server sent it with. */
export interface DirectoryCopy {
  directory: Directory;
  etag: string | null;
}

/** Everyone in the workspace, or `copy` while it's still current, kept out of the browser's cache as the sidebar is. */
export async function fetchDirectory(copy: DirectoryCopy | null): Promise<DirectoryCopy> {
  const response = await fetch("/api/users", copy?.etag ? { headers: { "If-None-Match": copy.etag } } : {});
  if (copy && response.status === 304) return copy;
  return { directory: await dataOf<Directory>(response), etag: response.headers.get("ETag") };
}

/** Who the New room forms list: everyone active, by name. */
export async function fetchNewRoomForm(): Promise<NewRoomForm> {
  return request<NewRoomForm>("/api/rooms/new");
}

/** Creates a room, answering it. */
export async function createRoom(room: NewRoom): Promise<SharedRoom> {
  return (await request<{ room: SharedRoom }>("/api/rooms", { method: "POST", body: JSON.stringify(room) })).room;
}

/** Opens the DM between this person and the people `userIds` names, starting it if the group has none, and answers it. */
export async function startDirect(userIds: UserId[]): Promise<DirectRoom> {
  return (await request<StartedDirect>("/api/directs", { method: "POST", body: JSON.stringify({ userIds } satisfies NewDirect) })).room;
}

/** A room's settings. Fails with a 404 ApiError for a room this person isn't in, or a DM. */
export async function fetchRoomSettings(roomId: RoomId): Promise<RoomSettings> {
  return request<RoomSettings>(`/api/rooms/${encodeURIComponent(roomId)}/settings`);
}

/** Changes a room, answering it as it is then. */
export async function changeRoom(roomId: RoomId, changes: RoomChanges): Promise<SharedRoom> {
  return (await request<{ room: SharedRoom }>(`/api/rooms/${encodeURIComponent(roomId)}`, { method: "PATCH", body: JSON.stringify(changes) })).room;
}

/**
 * Stars a room for this person, or unstars it, answering their stars as they are then. Fails with a
 * 403 ApiError for a room they can't star: a DM, or one they've hidden or aren't in.
 */
export async function setFavorite(roomId: RoomId, favorite: boolean): Promise<Favorites> {
  return (await request<{ favorites: Favorites }>(`/api/rooms/${encodeURIComponent(roomId)}/favorite`, { method: "PUT", body: JSON.stringify({ favorite }) })).favorites;
}

/**
 * Gives this person level `involvement` in a room, answering it. Fails with a 404 ApiError for a room
 * they aren't in.
 */
export async function setInvolvement(roomId: RoomId, involvement: Involvement): Promise<Involvement> {
  return (await request<{ involvement: Involvement }>(`/api/rooms/${encodeURIComponent(roomId)}/involvement`, { method: "PUT", body: JSON.stringify({ involvement }) }))
    .involvement;
}

/**
 * Puts this person's starred rooms in the order `roomIds` lists them, answering their stars as they are
 * then. Fails with a 403 ApiError unless it lists exactly the rooms they've starred.
 */
export async function setFavoriteOrder(roomIds: RoomId[]): Promise<Favorites> {
  return (await request<{ favorites: Favorites }>("/api/sidebar/order", { method: "PUT", body: JSON.stringify({ roomIds }) })).favorites;
}

/**
 * Puts the rooms in this administrator's sidebar in the shared order, in the order `roomIds` lists them,
 * answering the rooms they're in that it ranks, in its order. Fails with a 403 ApiError for anyone but
 * an administrator, and for a room outside their sidebar.
 */
export async function setSharedOrder(roomIds: RoomId[]): Promise<RoomId[]> {
  return (await request<{ sharedOrder: RoomId[] }>("/api/account/room_order", { method: "PUT", body: JSON.stringify({ roomIds }) })).sharedOrder;
}

/** Deletes a room, with its messages. */
export async function deleteRoom(roomId: RoomId): Promise<void> {
  await request(`/api/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" });
}

/** Takes this person out of a private room they can't change, as Leave on its settings page does. */
export async function leaveRoom(roomId: RoomId): Promise<void> {
  await request(`/api/rooms/${encodeURIComponent(roomId)}/membership`, { method: "DELETE" });
}

/**
 * The preview of the page `url` goes to, for a link pasted in the composer, or null when it has none, as
 * Campfire's unfurl_controller.js asks for it. The page has none when it answers 204.
 */
export async function fetchLinkPreview(url: string, signal: AbortSignal): Promise<LinkPreview | null> {
  const preview = await request<Partial<LinkPreview>>("/api/unfurl", { method: "POST", body: JSON.stringify({ url }), signal });
  return preview.title && preview.url ? (preview as LinkPreview) : null;
}

/**
 * A page of what `search` finds, sorted by `sort`, from `cursor` on, as the results page asks for it, with
 * your recent searches, which are all a search with no words or filters has.
 */
export async function fetchSearch(search: Search, sort: SearchSort = "newest", cursor?: number): Promise<SearchResults> {
  return request<SearchResults>(`/api/searches?${searchQuery(search, sort, cursor)}`);
}

/** Searches for `search`, recording it as your newest recent search, as the search box does, and answers its first page, sorted by `sort`. */
export async function recordSearch(search: Search, sort: SearchSort = "newest"): Promise<SearchResults> {
  return request<SearchResults>("/api/searches", { method: "POST", body: JSON.stringify({ ...search, sort }) });
}

/** Forgets your recent searches. */
export async function clearSearches(): Promise<void> {
  await request("/api/searches", { method: "DELETE" });
}

/**
 * Where a room's @ prompt asks for the people it offers: Lexxy adds what's typed after the @ as
 * `filter`, and the answer is its prompt items.
 */
export const mentionPromptSrc = (roomId: RoomId) => `/api/autocompletable/users?room_id=${encodeURIComponent(roomId)}`;

/** The address of a socket at `path` on this page's host, over wss on https pages. */
export function socketUrl(path: string): string {
  const url = new URL(path, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** The address of a room's socket, which tells the room what `params` says about the tab. */
export const roomSocketUrl = (roomId: string, params: RoomSocketParams) => socketUrl(`/api/rooms/${encodeURIComponent(roomId)}/socket${roomSocketQuery(params)}`);

/** The address of a tab's workspace socket, which carries what changes outside the room it shows. */
export const workspaceSocketUrl = () => socketUrl("/api/socket");

/** Forgets the session earlier versions of the app kept in localStorage, which nothing reads now. */
export function forgetStoredSession(): void {
  try {
    localStorage.removeItem("ember:session");
  } catch {
    // Private windows can refuse storage, and then there's nothing to forget.
  }
}
