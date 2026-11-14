import {
  AVATAR_PATH,
  CloseCode,
  CURRENT_PASSWORD_NEEDED,
  CURRENT_PASSWORD_WRONG,
  EMAIL_DOMAIN_NEEDS_EMAIL,
  EMAIL_SIGN_UP_PATH,
  INVITATION_PATH,
  LOGO_PATH,
  LOGO_TOO_LARGE,
  MAX_EMAIL_ADDRESS_LENGTH,
  MEMBERFUL_CALLBACK_PATH,
  MEMBERFUL_CONNECTIONS_PATH,
  MEMBERFUL_DISCONNECT_PASSWORD_NEEDED,
  MEMBERFUL_DISCONNECT_WITHOUT_EMAIL,
  MEMBERFUL_DISCONNECT_WITHOUT_PASSWORD,
  MEMBERFUL_NOT_CONNECTED,
  MEMBERFUL_PASSWORD_NEEDED,
  MEMBERFUL_SIGN_IN_NEEDED,
  MEMBERFUL_SIGN_IN_PATH,
  MEMBERFUL_SIGN_IN_PROBLEMS,
  MEMBERFUL_WEBHOOK_PATH,
  NAME_RESERVED,
  NO_EMAIL_DOMAINS,
  PASSWORD_RESET_PATH,
  PASSWORD_WITH_MEMBERFUL,
  isPasswordTooLong,
  isReservedName,
  isRoomId,
  OPEN_WITH_MEMBERFUL,
  parseAccountChanges,
  parseCustomDomainCheck,
  parseCustomStyles,
  parseFavoriteOrder,
  parseInvolvementChange,
  parseMemberfulDisconnection,
  parseSharedOrder,
  parseNewDirect,
  parseNewRoom,
  parseProfileChanges,
  parseResendApiKey,
  parseRoleChange,
  parseSendingDomainCheck,
  parseRoomChanges,
  parseTurnstileKeysChange,
  PROFILE_PATH,
  SIGN_IN_LIMITED,
  SIGN_IN_REJECTED,
  signOutEndpointOf,
  SIGN_UP_PATH,
  TRANSFER_PATH,
  TURNSTILE_CHECK_PATH,
  workspacePageOf,
  type Account,
  type Bootstrap,
  type ChangedPerson,
  type CustomDomainCheck,
  type CustomDomainLookup,
  type CustomStyles,
  type Directory,
  type EmailSettings,
  type Favorites,
  type Involvement,
  type MemberfulConnection,
  type MemberfulStatus,
  type NewJoinCode,
  type NewRoomForm,
  type PersonAnswer,
  type ProfileAnswer,
  type ReleaseCheck,
  type RoomId,
  type RoomSettings,
  type SendingDomainCheck,
  type SentTestEmail,
  type Sidebar,
  type StartedDirect,
  type TurnstileSettings,
  type UserId,
  type WorkspaceSettings,
} from "@ember/protocol";
import { agentsName } from "@ember/protocol/agents";
import { OUTSIDE_AUTHORIZE_PATH } from "@ember/protocol/outside";
import { mentionPromptItem } from "@ember/richtext";
import { isAccountLogoPath, showAccountLogo, storeLogo } from "./account-logo";
import {
  clientOf,
  credentialsFor,
  credentialsOf,
  expiredSessionCookie,
  isCrossSite,
  isHttps,
  isSameOriginUpgrade,
  newSessionToken,
  sessionCookie,
  sessionToken,
  signOut,
  tokenDigest,
} from "./auth";
import { directoryOf } from "./avatar-tokens";
import {
  appPage,
  beginAppSignIn,
  beginNewAppSignIn,
  beginOwnAppSignIn,
  changeApp,
  clientDocument,
  connectApp,
  disconnectApp,
  finishAppSignIn,
  listApps,
  pickAgentTools,
  readAppTools,
  showAgentTools,
  showApp,
  signOutOfApp,
} from "./apps/api";
import { answerOutsideAsk, changeOutsideAi, describeOutsideAsk, disconnectOutside, isOutsideRegistration, outsideAction, outsideConnectPage } from "./outside/api";
import { CLIENT_DOCUMENT_PATH } from "./apps/oauth";
import { agentPage, changeAgent, createAgent, deleteAgent, listAgents, removeAgentAvatar, showAgent, tryAgent } from "./assistant/agents";
import {
  addAssistantModel,
  changeAssistantAvatar,
  changeAssistantSettings,
  changeWebSearch,
  changeYourAssistant,
  deployedAccountIdOf,
  forgetAssistant,
  listOfferedModels,
  removeAssistantAvatar,
  removeAssistantModel,
  saveAssistant,
} from "./assistant/settings";
import { avatarTokenOf, showAvatar, storeAvatar } from "./avatars";
import type { BanProblem } from "./bans";
import { BodyTooLarge, jsonBodyOf } from "./bodies";
import { botPage, changeBot, createBot, deleteBot, listBots, resetBotKey, showBot } from "./bots/accounts";
import { botAction, exception, isBotPath, withoutBotKeys } from "./bots/api";
import { ADDRESS_HEADER, AUTHORIZED_AT_HEADER, BANNED_HEADER, HUDDLE_HEADER, ROOM_HEADER, SESSION_HEADER, USER_HEADER } from "./chat-room";
import { guestSignIn, type Env } from "./env";
import { failed, notFound } from "./error-pages";
import { jsonWithETag } from "./etag";
import { fileAddressOf, serveFile } from "./files/serving";
import { pictureFormOf } from "./files/pictures";
import { NO_STORAGE, startUpload, uploadPart, uploadPreview } from "./files/uploads";
import { CSP_REPORT_PATH, cspReport } from "./csp";
import { addressRefusal, answerProbe, deployedAddressOf, lookUpDns, originFor, probeOf, reachOf } from "./custom-domain";
import { redirectToHttps, requiresHttps, withHeaders } from "./headers";
import { health, isUpPath, up } from "./health";
import { forgetHuddles, saveHuddles } from "./huddles/settings";
import { invite, lookUpEmailLink, resendInvitation, revokeInvitation } from "./invitations";
import { askForEmailLink, emailSignUpPage, invitationPage, join, joinCodeOf, joinPage, joinWithEmailLink, signUp, signUpPage } from "./join";
import { checkResendApiKey } from "./mail";
import { manifest, manifestFormatOf } from "./manifest";
import {
  finishMemberfulSignIn,
  memberfulConnectionFor,
  memberfulRefusal,
  memberfulSiteFor,
  memberfulWebhook,
  saveMemberfulKeys,
  startMemberfulSignIn,
  withDeployedMemberful,
} from "./memberful";
import { deployedMemberfulOf } from "./memberful-api";
import { anyOtherPage, formAnswer } from "./pages";
import { askForPasswordReset, passwordResetPage, resetPasswordWithCode } from "./password-resets";
import { DUMMY_DIGEST, passwordHasher } from "./passwords";
import { webPush } from "./push/keys";
import { deletePushSubscription, listPushSubscriptions, savePushSubscription, sendTestNotification } from "./push/subscriptions";
import { showQrCode } from "./qr-code";
import { RECOVERY_PATH, resetPassword } from "./recovery";
import { releaseCheck } from "./releases";
import { urlOf } from "./request-url";
import { MAX_ADDRESS_LENGTH } from "./revocations";
import { clearSearches, recordSearch, searchMessages } from "./searches";
import { isOnboardedToEmailSending } from "./sending-domain";
import { checkSetup, firstRun, isSetupPath, setupAccessOf, setupPage, setupPlaceholdersOf } from "./setup";
import { closedAtOnce } from "./sockets";
import { newTransferId, transferPage, transferSession } from "./transfers";
import { refusalOfTurnstileKeys, turnstileCheckPage, turnstileKeysOf } from "./turnstile";
import { unfurlLink } from "./unfurl";
import { isFromUnsupportedBrowser, unsupportedBrowserPage } from "./unsupported-browser";
import { platformOf } from "./user-agent";
import { versionOf } from "./version";
import { ACCOUNT_BEFORE_SETUP, CREDENTIALS_HEADER, workspace, type YourProfile } from "./workspace";

export { AppConnector } from "./apps/connector";
export { OutsideAi } from "./outside/endpoint";
export { ChatRoom } from "./chat-room";
export { PasswordHasher } from "./passwords";
export { SearchIndex } from "./search-index";
export { Unfurler } from "./unfurl";
export { Workspace } from "./workspace";

const MAX_NAME_LENGTH = 48;
/** The alert for a room someone can't open, whether it's missing or they aren't in it. */
const ROOM_NOT_FOUND = "Room not found or inaccessible";
const INVOLVEMENT_REFUSED = "Notification level must be mentions, everything, nothing or invisible";

const json = (data: unknown, init?: ResponseInit) => Response.json(data, init);
const problem = (status: number, message: string) => json({ error: message }, { status });

/** Signs in with an email address and password, or with just a name when the body gives one. */
async function signIn(request: Request, env: Env): Promise<Response> {
  // Any JSON value parses, null and numbers included, so don't assume an object.
  const body: unknown = await jsonBodyOf(request);
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return "name" in fields ? signInGuest(fields.name, request, env) : signInWithPassword(fields, request, env);
}

/**
 * The sign-in: every attempt counts against its IP address's limit before anything is checked, and an
 * unknown email address costs a password check too, so the answer's timing doesn't say who has an
 * account. While Memberful is members only, only an administrator signs in with a password. Anyone else
 * whose password checks out goes on to connect their Memberful account, as 202 says, to come back to
 * `returnTo` signed in, until they have one connected, and hears 403 once they have.
 */
async function signInWithPassword({ emailAddress, password, returnTo }: Record<string, unknown>, request: Request, env: Env): Promise<Response> {
  // A blank password is refused before any lookup, and so is one longer than the form sends, which
  // nobody can have, or an email address longer than any account's, which the Workspace would otherwise
  // be sent whole.
  const given =
    typeof emailAddress === "string" &&
    emailAddress.length <= MAX_EMAIL_ADDRESS_LENGTH &&
    typeof password === "string" &&
    password !== "" &&
    !isPasswordTooLong(password);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const found = await workspace(env).beginSignIn(ip, given ? emailAddress : null);
  if (found === "limited") return problem(429, SIGN_IN_LIMITED);
  if (!given) return problem(401, SIGN_IN_REJECTED);

  const { matches, rehash } = await passwordHasher(env).verify(password, found?.passwordDigest ?? DUMMY_DIGEST);
  const token = newSessionToken();
  const digest = await tokenDigest(token, env.SESSION_SECRET);
  const client = clientOf(request);
  let user = found && matches ? await workspace(env).startSession(found.userId, found.passwordDigest, rehash, digest, client) : null;
  // Two sign-ins with the same password can arrive together while its digest is one from before
  // scrypt: the first keeps a new digest, and the second finds the one it checked gone. Its password
  // is checked against the digest kept now, which a reset meanwhile would have left unlike it.
  if (!user && found && matches && rehash !== null && given) {
    const kept = await workspace(env).passwordKept(emailAddress);
    if (kept && (await passwordHasher(env).verify(password, kept.passwordDigest)).matches) {
      user = await workspace(env).startSession(kept.userId, kept.passwordDigest, null, digest, client);
    }
  }
  if (user === "memberful") {
    const connecting = found && (await memberfulConnectionFor(request, env, found.userId, found.passwordDigest, returnTo));
    return connecting ? connectionAnswer(connecting) : problem(403, MEMBERFUL_SIGN_IN_NEEDED);
  }
  if (!user) return problem(401, SIGN_IN_REJECTED);
  return json({ user }, { status: 201, headers: { "Set-Cookie": sessionCookie(request, token) } });
}

/**
 * Signs someone in with just a name, as someone new every time, when EMBER_GUEST_SIGN_IN allows it,
 * unless Memberful is members only, or the name is @ember's or an agent's.
 */
async function signInGuest(given: unknown, request: Request, env: Env): Promise<Response> {
  if (!guestSignIn(env)) return problem(403, "Signing in with just a name is turned off");
  const name = typeof given === "string" ? given.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) return problem(422, `Name must be 1 to ${MAX_NAME_LENGTH} characters`);
  if (isReservedName(name)) return problem(422, NAME_RESERVED);

  const token = newSessionToken();
  const user = await workspace(env).signInGuest(name, await tokenDigest(token, env.SESSION_SECRET), clientOf(request));
  if (user === "memberful") return problem(403, MEMBERFUL_SIGN_IN_NEEDED);
  if (user === "agent's name") return problem(422, agentsName(name));
  return json({ user }, { status: 201, headers: { "Set-Cookie": sessionCookie(request, token) } });
}

/**
 * What the app asks first: whether Ember is set up yet, who this browser is signed in as, the key
 * browsers subscribe to push notifications with, and the platform its notification setup help is for.
 */
async function bootstrap(request: Request, env: Env): Promise<Response> {
  const token = sessionToken(request);
  const [{ account, user, signInWithMemberful, passwordResetCodes, turnstileSiteKey }, push] = await Promise.all([
    workspace(env).bootstrap(token ? await credentialsFor(token, request, env) : null, deployedMemberfulOf(env)?.site ?? null, deployedAddressOf(request)),
    webPush(env),
  ]);
  const body: Bootstrap = {
    setup: account ? "complete" : "pending",
    setupAccess: setupAccessOf(request, env),
    setupPlaceholders: setupPlaceholdersOf(env),
    guestSignIn: guestSignIn(env) && !account?.memberfulSignIn,
    signInWithMemberful,
    // The deployment's keys take the place of any an administrator gave.
    turnstileSiteKey: turnstileKeysOf(env)?.siteKey ?? turnstileSiteKey,
    passwordResetCodes,
    account: account ?? ACCOUNT_BEFORE_SETUP,
    version: versionOf(env),
    vapidPublicKey: push.on ? push.keys.publicKey : null,
    platform: platformOf(request.headers.get("User-Agent")),
    user,
  };
  const headers = new Headers({ "Cache-Control": "no-store" });
  // The app asks every time it loads, so sending the cookie again keeps it from expiring while it's in use.
  if (user && token) headers.set("Set-Cookie", sessionCookie(request, token));
  return json(body, { headers });
}

async function me(request: Request, env: Env): Promise<Response> {
  const token = sessionToken(request);
  const user = token ? await workspace(env).me(await credentialsFor(token, request, env)) : null;
  if (!token || !user) return problem(401, "Not signed in");
  // The app asks every time it loads, so sending the cookie again keeps it from expiring while it's in use.
  return json({ user }, { headers: { "Set-Cookie": sessionCookie(request, token) } });
}

/**
 * Workspace settings, which anyone signed in may see, read-only unless they're an administrator, with
 * the Memberful site whose members can sign in, and whether Ember hears its webhooks, and where
 * Turnstile's keys come from, the deployment's keys taking the place of any an administrator gave, and,
 * for administrators, the Cloudflare account Ember is deployed to. They hold the join code, which no
 * cache should keep, as the sidebar's invitation does.
 */
async function workspaceSettings(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const settings = credentials && (await workspace(env).workspaceSettings(credentials));
  if (!settings) return problem(401, "Not signed in");
  if (settings === "not set up") return problem(404, "Ember isn't set up yet");
  const deployment = {
    turnstile: turnstileOf(env, settings.turnstile),
    cloudflareAccountId: settings.canAdminister ? deployedAccountIdOf(env) : null,
  };
  return json({ ...withDeployedMemberful(env, settings), ...deployment } satisfies WorkspaceSettings, { headers: { "Cache-Control": "no-store" } });
}

/** Where Turnstile's keys come from: the deployment's secrets, which take the place of any others, or else `saved`, as the Workspace has those an administrator gave. */
const turnstileOf = (env: Env, saved: TurnstileSettings["turnstile"]): TurnstileSettings["turnstile"] => (turnstileKeysOf(env) ? "secret" : saved);

/**
 * Gives Ember a Turnstile widget's keys to check people with, as Set up Turnstile does once the widget's
 * check has passed in its dialog, after who's asking, as changing the workspace does, and once siteverify
 * takes that check's token with the secret key, which says the keys are one widget's, and that it checks
 * people here, answering where Ember's keys come from then. A key that can't be one, or that siteverify
 * refuses, is refused on its field.
 */
async function saveTurnstileKeys(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const administrator = credentials && (await workspace(env).canAdminister(credentials));
  if (!credentials || administrator === null) return problem(401, "Not signed in");
  if (!administrator) return problem(403, "Only administrators can change the workspace");
  const keys = parseTurnstileKeysChange(await jsonBodyOf(request));
  if ("error" in keys) return formAnswer(keys, 422);
  const refusal = await refusalOfTurnstileKeys(env, keys.secretKey, keys.turnstileToken, clientOf(request).ip);
  if (refusal) return formAnswer({ error: refusal.error, ...(refusal.field && { field: refusal.field }) }, refusal.status);
  return turnstileAnswer(env, await workspace(env).changeTurnstileKeys(credentials, { siteKey: keys.siteKey, secretKey: keys.secretKey }));
}

/** Takes away the Turnstile widget's keys Ember was given, as turning off the Turnstile card's switch does, answering where Ember's keys come from then. */
async function forgetTurnstileKeys(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return turnstileAnswer(env, credentials && (await workspace(env).changeTurnstileKeys(credentials, null)));
}

/** The answer to changing Turnstile's keys: where Ember's keys come from then, or who can't. */
function turnstileAnswer(env: Env, changed: { saved: boolean } | "forbidden" | null): Response {
  if (!changed) return problem(401, "Not signed in");
  if (changed === "forbidden") return problem(403, "Only administrators can change the workspace");
  return json({ turnstile: turnstileOf(env, changed.saved ? "saved" : null) } satisfies TurnstileSettings, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Sends the administrator asking a test email, as Membership's Send me a test email does, answering the
 * address it went to, or why it wasn't sent, with the status the Workspace gives that.
 */
async function sendTestEmail(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const ember = workspace(env);
  const sent = credentials && (await ember.sendTestEmail(credentials, originFor(request, (await ember.account())?.customDomain ?? null)));
  if (!sent) return problem(401, "Not signed in");
  if (sent === "forbidden") return problem(403, "Only administrators can change the workspace");
  return "refusal" in sent ? problem(sent.status, sent.refusal) : json(sent satisfies SentTestEmail);
}

/**
 * Gives Ember a Resend API key to send email with, as Set up email's Send with Resend does, once Resend
 * takes it (`checkResendApiKey`), after who's asking, as changing the workspace does, answering how Ember
 * sends email then.
 */
async function saveResendApiKey(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const administrator = credentials && (await workspace(env).canAdminister(credentials));
  if (!credentials || administrator === null) return problem(401, "Not signed in");
  if (!administrator) return problem(403, "Only administrators can change the workspace");
  const key = parseResendApiKey(await jsonBodyOf(request));
  if (typeof key === "string") return problem(422, key);
  const refusal = await checkResendApiKey(env, key.apiKey);
  if (refusal) return problem(refusal.status, refusal.refusal);
  return emailSettingsAnswer(await workspace(env).changeResendApiKey(credentials, key.apiKey));
}

/**
 * Checks whether a domain is onboarded to Cloudflare Email Sending, as Set up email's From step asks
 * once an address is typed there, after who's asking, as changing the workspace does.
 */
async function checkSendingDomain(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const administrator = credentials && (await workspace(env).canAdminister(credentials));
  if (administrator === null) return problem(401, "Not signed in");
  if (!administrator) return problem(403, "Only administrators can change the workspace");
  const check = parseSendingDomainCheck(await jsonBodyOf(request));
  if (typeof check === "string") return problem(422, check);
  return json({ onboarded: await isOnboardedToEmailSending(check.domain) } satisfies SendingDomainCheck, { headers: { "Cache-Control": "no-store" } });
}

/** Takes away the Resend API key Ember was given, as Set up email does when Cloudflare Email Service is chosen instead, answering how Ember sends email then. */
async function forgetResendApiKey(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return emailSettingsAnswer(credentials && (await workspace(env).changeResendApiKey(credentials, null)));
}

/** The answer to changing how Ember sends email: how it does then, or who can't. */
function emailSettingsAnswer(email: EmailSettings | "forbidden" | null): Response {
  if (!email) return problem(401, "Not signed in");
  if (email === "forbidden") return problem(403, "Only administrators can change the workspace");
  return json(email satisfies EmailSettings, { headers: { "Cache-Control": "no-store" } });
}

/** Gives the join link a new code, as an administrator's Regenerate join link does, answering it. */
async function regenerateJoinCode(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const regenerated = credentials && (await workspace(env).regenerateJoinCode(credentials));
  if (!regenerated) return problem(401, "Not signed in");
  if (regenerated === "forbidden") return problem(403, "Only administrators can change the workspace");
  return json(regenerated satisfies NewJoinCode, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Changes the workspace, as its settings save it. Someone who isn't an administrator hears so before
 * anything they sent is checked. Ember's address can only be the one the request came to, or a custom
 * domain or where a deploy puts Ember while it reaches Ember (`addressRefusal`), Memberful, or its
 * Members only, can only be turned on once Ember has Memberful's keys, and Email domain only with a
 * domain to let in, while Ember can send email. Turning any of them off always works.
 */
async function changeAccount(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const changes = parseAccountChanges(await jsonBodyOf(request));
  const refusal =
    typeof changes === "string" ? changes : ((await addressRefusal(changes.customDomain, request, env, credentials)) ?? (await memberfulRefusal(changes.settings, env)));
  // Changes that are refused change nothing, but who's asking is still checked first.
  const account = await workspace(env).changeAccount(credentials, typeof changes === "string" || refusal ? {} : changes, urlOf(request).host);
  if (!account) return problem(401, "Not signed in");
  if (account === "forbidden") return problem(403, "Only administrators can change the workspace");
  if (account === "conflict") return problem(422, OPEN_WITH_MEMBERFUL);
  if (account === "no email domains") return problem(422, NO_EMAIL_DOMAINS);
  if (account === "no email") return problem(422, EMAIL_DOMAIN_NEEDS_EMAIL);
  return refusal ? problem(422, refusal) : json({ account });
}

/**
 * Checks what a domain Ember moved away from reaches, as Workspace settings' Check asks, after who's
 * asking, as changing the workspace does: this Ember, something else, or nothing yet. One that no longer
 * reaches Ember is forgotten.
 */
async function checkCustomDomain(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const ember = workspace(env);
  const administrator = credentials && (await ember.canAdminister(credentials));
  if (administrator === null) return problem(401, "Not signed in");
  if (!administrator) return problem(403, "Only administrators can change the workspace");
  const check = parseCustomDomainCheck(await jsonBodyOf(request));
  if (typeof check === "string") return problem(422, check);
  const reaches = await reachOf(request, env, check.domain);
  if (reaches !== "ember") await ember.forgetOtherAddress(check.domain);
  return json({ reaches } satisfies CustomDomainCheck, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Looks up where the DNS of a domain an administrator is making Ember's address is, as Workspace
 * settings' Set up asks for its steps, after who's asking, as checking one does.
 */
async function lookUpCustomDomain(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const administrator = credentials && (await workspace(env).canAdminister(credentials));
  if (administrator === null) return problem(401, "Not signed in");
  if (!administrator) return problem(403, "Only administrators can change the workspace");
  const lookup = parseCustomDomainCheck(await jsonBodyOf(request));
  if (typeof lookup === "string") return problem(422, lookup);
  return json((await lookUpDns(lookup.domain)) satisfies CustomDomainLookup, { headers: { "Cache-Control": "no-store" } });
}

/**
 * The release this Ember is, and the newest one GitHub names, for an administrator, as General settings
 * says, telling them when a newer one is out: as GitHub last said, or `afresh`, as opening Admin asks.
 */
async function release(request: Request, env: Env, afresh: boolean): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const administrator = credentials && (await workspace(env).canAdminister(credentials));
  if (administrator === null) return problem(401, "Not signed in");
  if (!administrator) return problem(403, "Only administrators can change the workspace");
  return json((await releaseCheck(env, afresh)) satisfies ReleaseCheck, { headers: { "Cache-Control": "no-store" } });
}

/** The workspace's custom CSS, for the Custom CSS page, which only administrators can open. */
async function customStyles(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const styles = credentials && (await workspace(env).customStyles(credentials));
  if (!styles) return problem(401, "Not signed in");
  if (styles === "forbidden") return problem(403, "Only administrators can change the workspace");
  return json(styles satisfies CustomStyles);
}

/**
 * Saves the workspace's custom CSS, as the Custom CSS page does, answering the workspace as it is then.
 * Someone who isn't an administrator hears so before anything they sent is checked.
 */
async function changeCustomStyles(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const change = parseCustomStyles(await jsonBodyOf(request));
  // A change that doesn't parse changes nothing, but who's asking is still checked first.
  const account = await workspace(env).changeCustomStyles(credentials, typeof change === "string" ? undefined : change.customStyles);
  if (!account) return problem(401, "Not signed in");
  if (account === "forbidden") return problem(403, "Only administrators can change the workspace");
  return typeof change === "string" ? problem(422, change) : json({ account });
}

/**
 * Gives the workspace the logo the form brings, answering the account then. Who's asking is checked
 * before the logo is read, and again as it's given to the workspace.
 */
async function changeLogo(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const administrator = await workspace(env).canAdminister(credentials);
  if (administrator === null) return problem(401, "Not signed in");
  if (!administrator) return problem(403, "Only administrators can change the workspace");
  if (!env.FILES) return problem(503, NO_STORAGE);
  const form = await pictureFormOf(request, LOGO_TOO_LARGE);
  if (!(form instanceof FormData)) return problem(form.status, form.error);
  const logo = await storeLogo(env, env.FILES, form);
  if ("error" in logo) return problem(logo.status, logo.error);
  return logoChanged(await workspace(env).changeLogo(credentials, logo));
}

/** Takes the workspace's logo away, answering the account then. */
async function removeLogo(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return logoChanged(credentials && (await workspace(env).changeLogo(credentials, null)));
}

/** What a change to the workspace's logo answers: the account as it is then, or why it was refused. */
function logoChanged(account: Account | "forbidden" | null): Response {
  if (!account) return problem(401, "Not signed in");
  if (account === "forbidden") return problem(403, "Only administrators can change the workspace");
  return json({ account });
}

/**
 * Makes someone an administrator or a member, as the crown on workspace settings does, answering them as
 * the people directory then lists them. Someone who isn't an administrator hears so first, then anyone
 * who isn't active isn't found, before what was sent is checked. Unlike there, nobody can change their
 * own role or a bot's.
 */
async function changeRole(request: Request, env: Env, userId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const change = parseRoleChange(await jsonBodyOf(request));
  // A change that doesn't parse changes nothing, but who's asking and whom it's for are still checked first.
  const person = await workspace(env).changeRole(credentials, userId, change?.role ?? null);
  if (!person) return problem(401, "Not signed in");
  if (person === "forbidden") return problem(403, "Only administrators can change people's roles");
  if (person === "not found") return problem(404, "Not found");
  if (!change) return problem(400, "Expected a role");
  if (person === "own role") return problem(403, "Administrators can't change their own role");
  if (person === "bot") return problem(403, "Bots' roles can't be changed");
  return json({ user: person } satisfies ChangedPerson);
}

/**
 * Removes someone from the workspace, as Delete on workspace settings does, answering them as the people
 * directory then lists them. Someone who isn't an administrator hears so first, then anyone who isn't
 * active isn't found. Unlike there, nobody can remove themselves.
 */
async function removePerson(request: Request, env: Env, userId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const person = credentials && (await workspace(env).removePerson(credentials, userId));
  if (!person) return problem(401, "Not signed in");
  if (person === "forbidden") return problem(403, "Only administrators can remove people");
  if (person === "not found") return problem(404, "Not found");
  if (person === "yourself") return problem(403, "Administrators can't remove themselves");
  return json({ user: person } satisfies ChangedPerson);
}

/**
 * What a ban that can't block an IP address someone signed in from answers, or one that would block the
 * administrator's own.
 */
const BAN_PROBLEMS: Record<BanProblem | "your address", string> = {
  invalid: "They signed in from an IP address that isn't valid, which a ban can't block",
  internal: "They signed in from a private or internal IP address, which a ban can't block",
  "your address": "They signed in from your IP address, which a ban would block for you too",
};

/**
 * Bans someone, as Ban on their page does, answering them as the people directory then lists them.
 * Someone who isn't an administrator hears so first, then an id nobody has isn't found, whatever their
 * status. Unlike there, nobody can ban themselves, or the address they're using.
 */
async function banPerson(request: Request, env: Env, userId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const person = credentials && (await workspace(env).banPerson(credentials, userId));
  if (!person) return problem(401, "Not signed in");
  if (person === "forbidden") return problem(403, "Only administrators can ban people");
  if (person === "not found") return problem(404, "Not found");
  if (person === "yourself") return problem(403, "Administrators can't ban themselves");
  if (typeof person === "string") return problem(422, BAN_PROBLEMS[person]);
  return json({ user: person } satisfies ChangedPerson);
}

/** Lifts someone's ban, as Remove ban on their page does, answering them as `banPerson` does. */
async function unbanPerson(request: Request, env: Env, userId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const person = credentials && (await workspace(env).unbanPerson(credentials, userId));
  if (!person) return problem(401, "Not signed in");
  if (person === "forbidden") return problem(403, "Only administrators can lift bans");
  if (person === "not found") return problem(404, "Not found");
  return json({ user: person } satisfies ChangedPerson);
}

/**
 * Your profile as its page shows it, with a new sign-in link for you, as each of Campfire's profile
 * pages has (users/profiles/_transfer.html.erb), and where you stand with Memberful, at `site`, the one
 * Ember has the keys of, if it has any. No cache should keep it, since it holds your email address and
 * the link.
 */
async function profileAnswer({ transfer, profile, memberful }: YourProfile, env: Env, site: string | null): Promise<Response> {
  const transferId = await newTransferId(transfer, env.SESSION_SECRET, Date.now());
  const answer = { ...profile, memberful: memberfulStatusOf(memberful, site) };
  return json({ profile: answer, transferId } satisfies ProfileAnswer, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Where you stand with Memberful, for your profile: the account you've connected at `site`, named as
 * Memberful described it, or none yet while Memberful is members only, which your profile offers to
 * connect. Null when there's nothing to show: without the site, for a guest, or while Memberful isn't
 * members only and you haven't connected one.
 */
function memberfulStatusOf(memberful: YourProfile["memberful"], site: string | null): MemberfulStatus | null {
  if (!memberful || site === null) return null;
  const { membersOnly } = memberful;
  const account = memberful.accounts.find((account) => account.issuer === site);
  if (account) return { membersOnly, connected: { name: account.name, emailAddress: account.emailAddress } };
  return membersOnly ? { membersOnly, connected: null } : null;
}

/** Your profile, for its page. */
async function profile(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const [yours, site] = await Promise.all([workspace(env).profile(credentials), memberfulSiteFor(env)]);
  return yours ? profileAnswer(yours, env, site) : problem(401, "Not signed in");
}

/**
 * Saves your profile, as its form does, answering it as it is then. Who's asking is checked before a new
 * password is hashed, and a blank one keeps the password they have, while one shorter than first run
 * takes is refused (422). An email address someone else has is refused. Changing your email address or
 * password, while you have one, takes your current password too, so that holding your session isn't
 * enough to take your account: it's checked as sign-in checks a password, counting against the same
 * limit (429), and refused (422) when it's missing or wrong. Someone without a password whom Memberful
 * signs in, as it does while Ember has the keys to the site they're linked at, is refused a
 * first one (422), for the same reason: it would be a way in that holding their session was enough to
 * make. A new password ends your other sessions, keeping this browser's push subscription at
 * `pushSubscriptionEndpoint` and forgetting the rest.
 */
async function changeProfile(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials || !(await workspace(env).authenticate(credentials))) return problem(401, "Not signed in");
  const changes = parseProfileChanges(await jsonBodyOf(request));
  if (typeof changes === "string") return problem(422, changes);
  const { password, currentPassword, pushSubscriptionEndpoint, ...rest } = changes;
  const memberfulSite = await memberfulSiteFor(env);
  const check = await workspace(env).profileCheck(credentials, request.headers.get("CF-Connecting-IP") ?? "unknown", rest.emailAddress, Boolean(password), memberfulSite);
  if (!check) return problem(401, "Not signed in");
  if (check === "limited") return problem(429, SIGN_IN_LIMITED);
  if (check === "memberful") return problem(422, PASSWORD_WITH_MEMBERFUL);
  const checked = check.passwordDigest;
  if (checked !== null) {
    if (!currentPassword) return problem(422, CURRENT_PASSWORD_NEEDED);
    // One longer than the form takes is nobody's, as at sign-in.
    if (isPasswordTooLong(currentPassword) || !(await passwordHasher(env).verify(currentPassword, checked)).matches) return problem(422, CURRENT_PASSWORD_WRONG);
  }
  const passwordDigest = password ? await passwordHasher(env).hash(password) : null;
  const yours = await workspace(env).changeProfile(credentials, rest, passwordDigest, checked, pushSubscriptionEndpoint || null, memberfulSite);
  if (!yours) return problem(401, "Not signed in");
  if (yours === "memberful") return problem(422, PASSWORD_WITH_MEMBERFUL);
  if (yours === "email address taken") return problem(422, "That email address has an account already");
  if (yours === "name reserved") return problem(422, NAME_RESERVED);
  if (yours === "agent's name") return problem(422, agentsName(rest.name!));
  if (yours === "password needed") return problem(422, currentPassword ? CURRENT_PASSWORD_WRONG : CURRENT_PASSWORD_NEEDED);
  return profileAnswer(yours, env, memberfulSite);
}

/**
 * Connect Memberful on your profile: once your password checks out, while you have one, so that holding
 * your session isn't enough to add a way into your account, as for changing your email address or
 * password, answers where to sign in at the Memberful site to connect your account there to yours, with
 * the cookie that keeps the state it goes with, to come back to your profile. 401 without a valid
 * session; 403 while Memberful isn't members only, or Ember lacks its keys, or to a guest; 409
 * once you've connected one; 422 without your password, or with one that isn't yours; and 429 past
 * sign-in's limit, which checking the password counts against.
 */
async function connectMemberful(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const site = await memberfulSiteFor(env);
  if (!site) return problem(403, MEMBERFUL_SIGN_IN_PROBLEMS.unavailable);
  const body: unknown = await jsonBodyOf(request);
  const { currentPassword } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const check = await workspace(env).memberfulConnectionCheck(credentials, request.headers.get("CF-Connecting-IP") ?? "unknown", site);
  if (!check) return problem(401, "Not signed in");
  if (check === "limited") return problem(429, SIGN_IN_LIMITED);
  if (check === "unneeded") return problem(403, MEMBERFUL_SIGN_IN_PROBLEMS.unneeded);
  if (check === "forbidden") return problem(403, "Guests can't connect Memberful");
  if (check === "connected") return problem(409, "You've connected Memberful already");
  if (check.passwordDigest !== "") {
    if (typeof currentPassword !== "string" || !currentPassword) return problem(422, MEMBERFUL_PASSWORD_NEEDED);
    // One longer than the form takes is nobody's, as at sign-in.
    if (isPasswordTooLong(currentPassword) || !(await passwordHasher(env).verify(currentPassword, check.passwordDigest)).matches) return problem(422, CURRENT_PASSWORD_WRONG);
  }
  const connecting = await memberfulConnectionFor(request, env, check.userId, check.passwordDigest, PROFILE_PATH);
  // Something changed meanwhile: their password, the setting, or what they've connected.
  return connecting ? connectionAnswer(connecting) : problem(409, "Connecting Memberful didn't start. Try again.");
}

/**
 * Disconnect Memberful on your profile: once your password checks out, so that holding your session isn't
 * enough to change how you sign in, as for connecting one, unlinks your account from the one at the
 * Memberful site, ends your other sessions and forgets their browsers' push subscriptions, as a new
 * password does, keeping this browser's at `pushSubscriptionEndpoint`, and answers your profile as it
 * is then. 401 without a valid session; 403 to a guest, or while Ember lacks Memberful's keys;
 * 404 while you haven't connected one; 422 while you have no password, or no email address, to sign in
 * with once it's disconnected, or without your password, or with one that isn't yours; 429 past
 * sign-in's limit, which checking the password counts against; and 409 when your password, email
 * address or connection changed meanwhile.
 */
async function disconnectMemberful(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const site = await memberfulSiteFor(env);
  if (!site) return problem(403, MEMBERFUL_SIGN_IN_PROBLEMS.unavailable);
  const disconnection = parseMemberfulDisconnection(await jsonBodyOf(request));
  if (typeof disconnection === "string") return problem(422, disconnection);
  const { currentPassword, pushSubscriptionEndpoint } = disconnection;
  const check = await workspace(env).memberfulDisconnectionCheck(credentials, request.headers.get("CF-Connecting-IP") ?? "unknown", site);
  if (!check) return problem(401, "Not signed in");
  if (check === "limited") return problem(429, SIGN_IN_LIMITED);
  if (check === "forbidden") return problem(403, "Guests can't disconnect Memberful");
  if (check === "not connected") return problem(404, MEMBERFUL_NOT_CONNECTED);
  if (check === "no password") return problem(422, MEMBERFUL_DISCONNECT_WITHOUT_PASSWORD);
  if (check === "no email address") return problem(422, MEMBERFUL_DISCONNECT_WITHOUT_EMAIL);
  if (!currentPassword) return problem(422, MEMBERFUL_DISCONNECT_PASSWORD_NEEDED);
  // One longer than the form takes is nobody's, as at sign-in.
  if (isPasswordTooLong(currentPassword) || !(await passwordHasher(env).verify(currentPassword, check.passwordDigest)).matches) return problem(422, CURRENT_PASSWORD_WRONG);
  const yours = await workspace(env).disconnectMemberful(credentials, site, check.passwordDigest, pushSubscriptionEndpoint || null);
  if (!yours) return problem(401, "Not signed in");
  // Something changed meanwhile: their password, or what they've connected.
  if (yours === "refused") return problem(409, "Disconnecting Memberful didn't work. Try again.");
  return profileAnswer(yours, env, site);
}

/**
 * Sends the browser on to sign in at the Memberful site to connect an account there, with the cookie that
 * keeps the state it goes with, or on to Ember's custom domain to connect from there, which no cache should keep.
 */
const connectionAnswer = ({ connection, cookie }: { connection: MemberfulConnection; cookie: string | null }) =>
  json(connection, { status: 202, headers: { ...(cookie === null ? {} : { "Set-Cookie": cookie }), "Cache-Control": "no-store" } });

/**
 * Gives you the avatar the form brings, answering your profile then. Who's asking is checked before the
 * picture is read, and again as it's given to them.
 */
async function changeAvatar(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials || !(await workspace(env).authenticate(credentials))) return problem(401, "Not signed in");
  if (!env.FILES) return problem(503, NO_STORAGE);
  const form = await pictureFormOf(request);
  if (!(form instanceof FormData)) return problem(form.status, form.error);
  const avatar = await storeAvatar(env, env.FILES, form);
  if ("error" in avatar) return problem(avatar.status, avatar.error);
  const yours = await workspace(env).changeAvatar(credentials, avatar);
  return yours ? profileAnswer(yours, env, await memberfulSiteFor(env)) : problem(401, "Not signed in");
}

/** Takes your avatar away, answering your profile then. */
async function removeAvatar(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const yours = credentials && (await workspace(env).changeAvatar(credentials, null));
  return yours ? profileAnswer(yours, env, await memberfulSiteFor(env)) : problem(401, "Not signed in");
}

/**
 * Signs this browser out. Its session's sockets close in every room its person is in, so its other tabs
 * go to sign in at once. The rooms close them once this has answered, so a room that can't be reached
 * doesn't keep anyone signed in. The app sends the endpoint of the push subscription it ended first, if
 * there was one, and the person's subscriptions with it go too.
 */
async function endSession(request: Request, env: Env): Promise<Response> {
  await signOut(request, env, signOutEndpointOf(await jsonBodyOf(request)));
  return new Response(null, { status: 204, headers: { "Set-Cookie": expiredSessionCookie(request) } });
}

/**
 * The signed-in person's sidebar: the rooms they're in, and the welcome card's invitation if they're an
 * administrator in its room who hasn't dismissed it. It can hold the join code, which no cache should
 * keep, not even the browser's, where it would outlast signing out. So the app keeps its own copy, and
 * sends its ETag to ask whether it's current.
 */
async function sidebar(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const sidebar = credentials && (await workspace(env).sidebar(credentials));
  return sidebar ? jsonWithETag(request, sidebar satisfies Sidebar, { "Cache-Control": "no-store" }) : problem(401, "Not signed in");
}

/** Dismisses the welcome card for the signed-in person, for good, as its × does, answering 204. The can't be dismissed. */
async function dismissInvitation(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const dismissed = credentials !== null && (await workspace(env).dismissInvitation(credentials));
  return dismissed ? new Response(null, { status: 204 }) : problem(401, "Not signed in");
}

/**
 * Everyone in the workspace, deactivated and banned people too, with their avatars' addresses, for
 * the app to show people by. No cache keeps it, as none keeps the sidebar, so the app keeps its own copy.
 */
async function directory(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const entries = credentials && (await workspace(env).directory(credentials));
  if (!entries) return problem(401, "Not signed in");
  return jsonWithETag(request, { users: await directoryOf(entries, env.SESSION_SECRET) } satisfies Directory, { "Cache-Control": "no-store" });
}

/** A path segment as text, or "" for malformed percent-encoding, which names nobody. */
function segmentText(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

/**
 * Someone's page: anyone, whatever their status, with their email address and a new sign-in link for
 * administrators, and what an agent's page tells everyone of it. An id nobody has is 404.
 */
async function showPerson(request: Request, env: Env, userId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const found = credentials && (await workspace(env).person(credentials, userId));
  if (!found) return problem(401, "Not signed in");
  if (found === "not found") return problem(404, "Not found");
  const [shown] = await directoryOf([found.person], env.SESSION_SECRET);
  const transferId = found.transfer ? await newTransferId(found.transfer, env.SESSION_SECRET, Date.now()) : undefined;
  return json({ person: shown!, transferId, ...(found.agent && { agent: found.agent }) } satisfies PersonAnswer, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Someone's page, `/users/<id>`: Campfire's 404 page once signed in, for an id nobody has, and otherwise
 * the app's page, which sends anyone signed out to sign in first.
 */
async function personPage(request: Request, env: Env, pathname: string, userId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const found = credentials && (await workspace(env).person(credentials, userId));
  return found === "not found" ? notFound(request) : anyOtherPage(request, env, pathname);
}

/**
 * Whom the mentions prompt offers: the first 20 by name of the active people in `room_id`, or anywhere
 * without one, whose names contain `filter` (or `query`), as `<lexxy-prompt-item>`s, with the AI agents'
 * badged, @ember's among them. A room someone isn't in is 404.
 */
async function mentionable(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const params = urlOf(request).searchParams;
  const roomId = present(params.get("room_id"));
  if (roomId !== undefined && !isRoomId(roomId)) return problem(404, ROOM_NOT_FOUND);
  const query = present(params.get("filter")) ?? present(params.get("query")) ?? "";
  const people = await workspace(env).mentionable(credentials, roomId ?? null, query);
  if (!people) return problem(401, "Not signed in");
  if (people === "not found") return problem(404, ROOM_NOT_FOUND);
  const items = (await directoryOf(people, env.SESSION_SECRET)).map((person) => mentionPromptItem(person));
  return new Response(items.join(""), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/** A parameter's value unless it's blank, as Rails' `presence` reads it. */
const present = (value: string | null) => (value === null || value.trim() === "" ? undefined : value);

/** What someone hears when "Must be admin to create new rooms" is on and they aren't one. */
const ROOM_CREATION_FORBIDDEN = "Only administrators can create rooms";

/**
 * Creates an open room, or a closed one for the people it names, as New room's forms do. Someone who may
 * not create rooms hears so before anything they sent is checked.
 */
async function createRoom(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const room = parseNewRoom(await jsonBodyOf(request));
  if (typeof room === "string") {
    const may = await workspace(env).mayCreateRooms(credentials);
    if (may === null) return problem(401, "Not signed in");
    return may ? problem(422, room) : problem(403, ROOM_CREATION_FORBIDDEN);
  }
  const created = await workspace(env).createRoom(credentials, room);
  if (!created) return problem(401, "Not signed in");
  return created === "forbidden" ? problem(403, ROOM_CREATION_FORBIDDEN) : json({ room: created }, { status: 201 });
}

/**
 * Starts a DM with the people it names, or opens the one they have, as New direct message does: 201 for
 * a new DM and 200 for one they had.
 */
async function startDirect(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const direct = parseNewDirect(await jsonBodyOf(request));
  if (typeof direct === "string") return problem(422, direct);
  const started = await workspace(env).startDirect(credentials, direct.userIds);
  return started ? json({ room: started.room } satisfies StartedDirect, { status: started.started ? 201 : 200 }) : problem(401, "Not signed in");
}

/** Who New room's forms list: everyone active, by name, for anyone who may create rooms. */
async function newRoomForm(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const form = credentials && (await workspace(env).newRoomForm(credentials));
  if (!form) return problem(401, "Not signed in");
  return form === "forbidden" ? problem(403, ROOM_CREATION_FORBIDDEN) : json(form satisfies NewRoomForm);
}

/** A room's settings page, for its members, read-only for those who can't change it. */
async function roomSettings(request: Request, env: Env, roomId: RoomId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const settings = credentials && (await workspace(env).roomSettings(credentials, roomId));
  if (!settings) return problem(401, "Not signed in");
  return settings === "not found" ? problem(404, ROOM_NOT_FOUND) : json(settings satisfies RoomSettings);
}

/**
 * Changes a room, as its settings page saves it. Someone who can't change it hears so before anything
 * they sent is checked.
 */
async function changeRoom(request: Request, env: Env, roomId: RoomId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const changes = parseRoomChanges(await jsonBodyOf(request));
  // Changes that don't parse change nothing, but the room is still checked first.
  const room = await workspace(env).changeRoom(credentials, roomId, typeof changes === "string" ? {} : changes);
  if (!room) return problem(401, "Not signed in");
  if (room === "not found") return problem(404, ROOM_NOT_FOUND);
  if (room === "forbidden") return problem(403, "Only administrators and the room's creator can change it");
  return typeof changes === "string" ? problem(422, changes) : json({ room });
}

/**
 * Deletes a room or DM, as Delete on its settings page does, answering 204. As with changing a room,
 * someone who can't change it hears so, and anyone in a DM can delete it.
 */
async function deleteRoom(request: Request, env: Env, roomId: RoomId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const deleted = credentials && (await workspace(env).deleteRoom(credentials, roomId));
  if (!deleted) return problem(401, "Not signed in");
  if (deleted === "not found") return problem(404, ROOM_NOT_FOUND);
  if (deleted === "forbidden") return problem(403, "Only administrators and the room's creator can delete it");
  return new Response(null, { status: 204 });
}

/**
 * Takes the signed-in person out of a private room, as Leave on its settings page does, answering 204: 404
 * unless they're in it, and 403 for an open room, for whoever can change the room, or when nobody else
 * could open it then.
 */
async function leaveRoom(request: Request, env: Env, roomId: RoomId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const left = credentials && (await workspace(env).leaveRoom(credentials, roomId));
  if (!left) return problem(401, "Not signed in");
  if (left === "not found") return problem(404, ROOM_NOT_FOUND);
  if (left === "open") return problem(403, "Everyone is in an open room, so nobody can leave it");
  if (left === "can change") return problem(403, "You can change this room, so take yourself out in its settings");
  if (left === "last") return problem(403, "Nobody else could open this room, so you can't leave it");
  return new Response(null, { status: 204 });
}

/**
 * Stars a room for the signed-in person, or unstars it, as its header's star does, answering their
 * stars: 400 for a room id or a `favorite` it can't read, and 403 for a room they can't star.
 */
async function setFavorite(request: Request, env: Env, roomId: string): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  if (!isRoomId(roomId)) return problem(400, "invalid room ID");
  // Any JSON value parses, null and numbers included, so don't assume an object.
  const body: unknown = await jsonBodyOf(request);
  const favorite = typeof body === "object" && body !== null ? (body as Record<string, unknown>).favorite : undefined;
  if (typeof favorite !== "boolean") return problem(400, "favorite must be true or false");
  const favorites = await workspace(env).setFavorite(credentials, roomId, favorite);
  if (!favorites) return problem(401, "Not signed in");
  if (favorites === "forbidden") return problem(403, "You can't star that room");
  return json({ favorites } satisfies { favorites: Favorites });
}

/**
 * Gives the signed-in person another notification level in a room, as its bell does, answering it: 404
 * when they aren't in the room, whatever's sent, then 422 for anything but a level.
 */
async function setInvolvement(request: Request, env: Env, roomId: RoomId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const involvement = await workspace(env).setInvolvement(credentials, roomId, parseInvolvementChange(await jsonBodyOf(request)));
  if (!involvement) return problem(401, "Not signed in");
  if (involvement === "not found") return problem(404, ROOM_NOT_FOUND);
  if (involvement === "invalid") return problem(422, INVOLVEMENT_REFUSED);
  return json({ involvement } satisfies { involvement: Involvement });
}

/**
 * Puts the signed-in person's starred rooms in the order listed, as dragging one in their sidebar does,
 * answering their stars: 400 for a list it can't read, and 403 for one that isn't exactly the rooms
 * they've starred.
 */
async function setFavoriteOrder(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const roomIds = parseFavoriteOrder(await jsonBodyOf(request));
  if (typeof roomIds === "string") return problem(400, roomIds);
  const favorites = await workspace(env).setFavoriteOrder(credentials, roomIds);
  if (!favorites) return problem(401, "Not signed in");
  if (favorites === "forbidden") return problem(403, "Those aren't the rooms you've starred");
  return json({ favorites } satisfies { favorites: Favorites });
}

/** What someone hears when they can't put rooms in the shared order. */
const SHARED_ORDER_FORBIDDEN = "Only administrators can put rooms in order for everyone, and only the rooms in their sidebar";

/**
 * Puts the rooms in the signed-in administrator's sidebar in the shared order, as saving it on workspace
 * settings does, answering the rooms they're in that it ranks: 400 for a list it can't read, and 403 for
 * anyone but an administrator, or a list naming a room outside their sidebar. An empty list clears the
 * order.
 */
async function setSharedOrder(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const roomIds = parseSharedOrder(await jsonBodyOf(request));
  // Someone who isn't an administrator hears so before the list is checked.
  if (typeof roomIds === "string") {
    const administrator = await workspace(env).canAdminister(credentials);
    if (administrator === null) return problem(401, "Not signed in");
    return administrator ? problem(400, roomIds) : problem(403, SHARED_ORDER_FORBIDDEN);
  }
  const sharedOrder = await workspace(env).setSharedOrder(credentials, roomIds);
  if (!sharedOrder) return problem(401, "Not signed in");
  return sharedOrder === "forbidden" ? problem(403, SHARED_ORDER_FORBIDDEN) : json({ sharedOrder } satisfies { sharedOrder: RoomId[] });
}

/** A tab's workspace socket, which the Workspace lets in itself, as the session the request's cookie names. */
async function connectToWorkspace(request: Request, env: Env): Promise<Response> {
  // As with a room's, the address is only there for upgrades from the app's own pages.
  if (request.headers.get("Upgrade") !== "websocket" || !isSameOriginUpgrade(request)) return problem(404, "Not found");
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Sign in first");
  const headers = new Headers(request.headers);
  headers.set(CREDENTIALS_HEADER, JSON.stringify(credentials));
  return workspace(env).fetch(new Request(request, { headers }));
}

/**
 * Connects a tab to room `roomId`, or with `huddle` to the room's huddle, which has a socket of its own
 * beside the one a tab shows the room on. Either is for the room's members. An address a ban blocks can
 * read the room, as it can the rest of Ember, but can't join its huddle, where it would be heard.
 */
async function connectToRoom(request: Request, env: Env, roomId: RoomId, huddle = false): Promise<Response> {
  // As with Action Cable, the address is only there for upgrades from the app's own pages.
  if (request.headers.get("Upgrade") !== "websocket" || !isSameOriginUpgrade(request)) return problem(404, "Not found");
  const credentials = await credentialsOf(request, env);
  const access = credentials && (await workspace(env).roomAccess(credentials, roomId));
  if (!access) return problem(401, "Sign in first");
  // Without waking the room's object, so a room nobody may open is never created. The app hears
  // that the room is gone for this person, deleted or theirs no longer, and stops connecting.
  if (!access.member || (huddle && access.banned)) return closedAtOnce(CloseCode.NotFound);

  const headers = new Headers(request.headers);
  headers.set(USER_HEADER, JSON.stringify(access.user));
  headers.set(ROOM_HEADER, roomId);
  headers.set(SESSION_HEADER, access.sessionId);
  headers.set(AUTHORIZED_AT_HEADER, String(access.authorizedAt));
  headers.set(BANNED_HEADER, String(access.banned));
  // Set either way, so that only the address a socket asks at says which it is.
  headers.set(HUDDLE_HEADER, String(huddle));
  // An address longer than any IP address isn't one a ban can hold, and would make too long a tag.
  const { ip } = clientOf(request);
  if (ip !== null && ip.length <= MAX_ADDRESS_LENGTH) headers.set(ADDRESS_HEADER, ip);
  else headers.delete(ADDRESS_HEADER);
  return env.CHAT_ROOM.getByName(roomId).fetch(new Request(request, { headers }));
}

/** What answers an API request, if one of the API's routes takes it. */
function apiAction(request: Request, env: Env, pathname: string): (() => Response | Promise<Response>) | null {
  if (pathname === "/api/bootstrap" && request.method === "GET") return () => bootstrap(request, env);
  if (pathname === "/api/first_run" && request.method === "POST") return () => firstRun(request, env);
  if (pathname === "/api/first_run/check" && request.method === "POST") return () => checkSetup(request, env);
  if (pathname === "/api/session" && request.method === "POST") return () => signIn(request, env);
  if (pathname === "/api/session" && request.method === "DELETE") return () => endSession(request, env);
  if (pathname === "/api/session/transfers" && request.method === "POST") return () => transferSession(request, env);
  if (pathname === "/api/me") return () => me(request, env);
  if (pathname === "/api/account" && request.method === "GET") return () => workspaceSettings(request, env);
  if (pathname === "/api/account" && request.method === "PATCH") return () => changeAccount(request, env);
  if (pathname === "/api/account/join_code" && request.method === "POST") return () => regenerateJoinCode(request, env);
  if (pathname === "/api/account/test_email" && request.method === "POST") return () => sendTestEmail(request, env);
  if (pathname === "/api/account/resend_api_key" && request.method === "PUT") return () => saveResendApiKey(request, env);
  if (pathname === "/api/account/resend_api_key" && request.method === "DELETE") return () => forgetResendApiKey(request, env);
  if (pathname === "/api/account/sending_domain_checks" && request.method === "POST") return () => checkSendingDomain(request, env);
  if (pathname === "/api/account/turnstile_keys" && request.method === "PUT") return () => saveTurnstileKeys(request, env);
  if (pathname === "/api/account/turnstile_keys" && request.method === "DELETE") return () => forgetTurnstileKeys(request, env);
  if (pathname === "/api/account/memberful_keys" && request.method === "PUT") return () => saveMemberfulKeys(request, env);
  if (pathname === "/api/account/assistant" && request.method === "PUT") return () => saveAssistant(request, env);
  if (pathname === "/api/account/assistant" && request.method === "DELETE") return () => forgetAssistant(request, env);
  if (pathname === "/api/account/assistant" && request.method === "PATCH") return () => changeAssistantSettings(request, env);
  if (pathname === "/api/account/assistant/offered" && request.method === "POST") return () => listOfferedModels(request, env);
  if (pathname === "/api/account/assistant/models" && request.method === "POST") return () => addAssistantModel(request, env);
  if (pathname === "/api/account/assistant/models" && request.method === "DELETE") return () => removeAssistantModel(request, env);
  if (pathname === "/api/account/assistant/web_search" && request.method === "PUT") return () => changeWebSearch(request, env);
  if (pathname === "/api/account/assistant/avatar" && request.method === "PUT") return () => changeAssistantAvatar(request, env);
  if (pathname === "/api/account/assistant/avatar" && request.method === "DELETE") return () => removeAssistantAvatar(request, env);
  if (pathname === "/api/account/agents" && request.method === "GET") return () => listAgents(request, env);
  if (pathname === "/api/account/agents" && request.method === "POST") return () => createAgent(request, env);
  if (pathname === "/api/account/agents/trials" && request.method === "POST") return () => tryAgent(request, env, null);
  // As with people and bots, agents' ids never need percent-encoding, so an encoded segment names none.
  const agent = pathname.match(/^\/api\/account\/agents\/([^/]+)$/);
  if (agent && request.method === "GET") return () => showAgent(request, env, agent[1]!);
  if (agent && request.method === "PATCH") return () => changeAgent(request, env, agent[1]!);
  if (agent && request.method === "DELETE") return () => deleteAgent(request, env, agent[1]!);
  const agentAvatar = pathname.match(/^\/api\/account\/agents\/([^/]+)\/avatar$/);
  if (agentAvatar && request.method === "DELETE") return () => removeAgentAvatar(request, env, agentAvatar[1]!);
  const agentTrials = pathname.match(/^\/api\/account\/agents\/([^/]+)\/trials$/);
  if (agentTrials && request.method === "POST") return () => tryAgent(request, env, agentTrials[1]!);
  const agentTools = pathname.match(/^\/api\/account\/agents\/([^/]+)\/tools$/);
  if (agentTools && request.method === "GET") return () => showAgentTools(request, env, agentTools[1]!);
  if (agentTools && request.method === "PUT") return () => pickAgentTools(request, env, agentTools[1]!);
  if (pathname === "/api/account/apps" && request.method === "GET") return () => listApps(request, env);
  if (pathname === "/api/account/apps" && request.method === "POST") return () => connectApp(request, env);
  const app = pathname.match(/^\/api\/account\/apps\/([^/]+)$/);
  if (app && request.method === "GET") return () => showApp(request, env, app[1]!);
  if (app && request.method === "PATCH") return () => changeApp(request, env, app[1]!);
  if (app && request.method === "DELETE") return () => disconnectApp(request, env, app[1]!);
  if (pathname === "/api/account/app-sign-ins" && request.method === "POST") return () => beginNewAppSignIn(request, env);
  if (pathname === "/api/account/app-sign-ins/finish" && request.method === "POST") return () => finishAppSignIn(request, env);
  const appSignIn = pathname.match(/^\/api\/account\/apps\/([^/]+)\/sign-in$/);
  if (appSignIn && request.method === "POST") return () => beginAppSignIn(request, env, appSignIn[1]!);
  const appTools = pathname.match(/^\/api\/account\/apps\/([^/]+)\/tools$/);
  if (appTools && request.method === "POST") return () => readAppTools(request, env, appTools[1]!);
  if (pathname === "/api/account/outside_ai" && request.method === "PUT") return () => changeOutsideAi(request, env);
  if (pathname === "/api/account/huddles" && request.method === "PUT") return () => saveHuddles(request, env);
  if (pathname === "/api/account/huddles" && request.method === "DELETE") return () => forgetHuddles(request, env);
  if (pathname === "/api/account/custom_domain_checks" && request.method === "POST") return () => checkCustomDomain(request, env);
  if (pathname === "/api/account/custom_domain_lookups" && request.method === "POST") return () => lookUpCustomDomain(request, env);
  if (pathname === LOGO_PATH && request.method === "PUT") return () => changeLogo(request, env);
  if (pathname === LOGO_PATH && request.method === "DELETE") return () => removeLogo(request, env);
  if (pathname === "/api/account/release" && request.method === "GET") return () => release(request, env, false);
  if (pathname === "/api/account/release_checks" && request.method === "POST") return () => release(request, env, true);
  if (pathname === "/api/account/custom_styles" && request.method === "GET") return () => customStyles(request, env);
  if (pathname === "/api/account/custom_styles" && request.method === "PATCH") return () => changeCustomStyles(request, env);
  if (pathname === "/api/account/room_order" && request.method === "PUT") return () => setSharedOrder(request, env);
  // The ids of people who can be active never need percent-encoding, so an encoded segment can't name one.
  const person = pathname.match(/^\/api\/account\/users\/([^/]+)$/);
  if (person && request.method === "PATCH") return () => changeRole(request, env, person[1]!);
  if (person && request.method === "DELETE") return () => removePerson(request, env, person[1]!);
  if (pathname === "/api/account/bots" && request.method === "GET") return () => listBots(request, env);
  if (pathname === "/api/account/bots" && request.method === "POST") return () => createBot(request, env);
  // As with people, bots' ids never need percent-encoding, so an encoded segment names none.
  const bot = pathname.match(/^\/api\/account\/bots\/([^/]+)$/);
  if (bot && request.method === "GET") return () => showBot(request, env, bot[1]!);
  if (bot && request.method === "PATCH") return () => changeBot(request, env, bot[1]!);
  if (bot && request.method === "DELETE") return () => deleteBot(request, env, bot[1]!);
  const botKey = pathname.match(/^\/api\/account\/bots\/([^/]+)\/key$/);
  if (botKey && request.method === "PUT") return () => resetBotKey(request, env, botKey[1]!);
  if (pathname === "/api/sidebar" && request.method === "GET") return () => sidebar(request, env);
  if (pathname === "/api/sidebar/invitation" && request.method === "DELETE") return () => dismissInvitation(request, env);
  if (pathname === "/api/users" && request.method === "GET") return () => directory(request, env);
  if (pathname === "/api/autocompletable/users" && request.method === "GET") return () => mentionable(request, env);
  if (pathname === "/api/sidebar/order" && request.method === "PUT") return () => setFavoriteOrder(request, env);
  if (pathname === "/api/users/me/profile" && request.method === "GET") return () => profile(request, env);
  if (pathname === "/api/users/me/profile" && request.method === "PATCH") return () => changeProfile(request, env);
  if (pathname === "/api/users/me/assistant" && request.method === "PATCH") return () => changeYourAssistant(request, env);
  const ownAppSignIn = pathname.match(/^\/api\/users\/me\/apps\/([^/]+)\/sign-in$/);
  if (ownAppSignIn && request.method === "POST") return () => beginOwnAppSignIn(request, env, ownAppSignIn[1]!);
  if (ownAppSignIn && request.method === "DELETE") return () => signOutOfApp(request, env, ownAppSignIn[1]!);
  const outsideConnection = pathname.match(/^\/api\/users\/me\/outside\/([^/]+)$/);
  if (outsideConnection && request.method === "DELETE") return () => disconnectOutside(request, env, outsideConnection[1]!);
  if (pathname === "/api/outside/asks" && request.method === "POST") return () => describeOutsideAsk(request, env);
  if (pathname === "/api/outside/answers" && request.method === "POST") return () => answerOutsideAsk(request, env);
  if (pathname === MEMBERFUL_CONNECTIONS_PATH && request.method === "POST") return () => connectMemberful(request, env);
  if (pathname === MEMBERFUL_CONNECTIONS_PATH && request.method === "DELETE") return () => disconnectMemberful(request, env);
  if (pathname === AVATAR_PATH && request.method === "PUT") return () => changeAvatar(request, env);
  if (pathname === AVATAR_PATH && request.method === "DELETE") return () => removeAvatar(request, env);
  const someone = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (someone && request.method === "GET") return () => showPerson(request, env, segmentText(someone[1]!));
  const ban = pathname.match(/^\/api\/users\/([^/]+)\/ban$/);
  if (ban && request.method === "POST") return () => banPerson(request, env, segmentText(ban[1]!));
  if (ban && request.method === "DELETE") return () => unbanPerson(request, env, segmentText(ban[1]!));
  if (pathname === "/api/socket") return () => connectToWorkspace(request, env);
  if (pathname === "/api/rooms" && request.method === "POST") return () => createRoom(request, env);
  if (pathname === "/api/rooms/new" && request.method === "GET") return () => newRoomForm(request, env);
  if (pathname === "/api/directs" && request.method === "POST") return () => startDirect(request, env);
  if (pathname === "/api/join" && request.method === "POST") return () => signUp(request, env);
  if (pathname === "/api/join/invitation" && request.method === "POST") return () => joinWithEmailLink(request, env, "invitation");
  if (pathname === "/api/join/email" && request.method === "POST") return () => joinWithEmailLink(request, env, "email_domain");
  if (pathname === "/api/email_links" && request.method === "POST") return () => askForEmailLink(request, env);
  if (pathname === "/api/email_links/lookup" && request.method === "POST") return () => lookUpEmailLink(request, env);
  if (pathname === "/api/password_resets" && request.method === "POST") return () => askForPasswordReset(request, env);
  if (pathname === "/api/password_resets" && request.method === "PUT") return () => resetPasswordWithCode(request, env);
  if (pathname === "/api/invitations" && request.method === "POST") return () => invite(request, env);
  // Invitations' ids are sortable ids, which never need percent-encoding, so an encoded segment names none.
  const invitation = pathname.match(/^\/api\/invitations\/([^/]+)$/);
  if (invitation && request.method === "DELETE") return () => revokeInvitation(request, env, invitation[1]!);
  const resend = pathname.match(/^\/api\/invitations\/([^/]+)\/resend$/);
  if (resend && request.method === "POST") return () => resendInvitation(request, env, resend[1]!);
  const joining = pathname.match(/^\/api\/join\/([^/]+)$/);
  if (joining && request.method === "POST") return () => join(request, env, joining[1]!);
  if (pathname === "/api/unfurl" && request.method === "POST") return () => unfurlLink(request, env);
  if (pathname === "/api/searches" && request.method === "GET") return () => searchMessages(request, env);
  if (pathname === "/api/searches" && request.method === "POST") return () => recordSearch(request, env);
  if (pathname === "/api/searches" && request.method === "DELETE") return () => clearSearches(request, env);
  if (pathname === "/api/push-subscriptions" && request.method === "GET") return () => listPushSubscriptions(request, env);
  if (pathname === "/api/push-subscriptions" && request.method === "POST") return () => savePushSubscription(request, env);
  const pushSubscription = pathname.match(/^\/api\/push-subscriptions\/([^/]+)$/);
  if (pushSubscription && request.method === "DELETE") return () => deletePushSubscription(request, env, pushSubscription[1]!);
  const testNotification = pathname.match(/^\/api\/push-subscriptions\/([^/]+)\/test-notifications$/);
  if (testNotification && request.method === "POST") return () => sendTestNotification(request, env, testNotification[1]!);

  const socket = pathname.match(/^\/api\/rooms\/([^/]+)\/socket$/);
  if (socket) {
    // Room ids never need percent-encoding, so an encoded segment can only be an unknown room.
    const roomId = socket[1]!;
    return () => (isRoomId(roomId) ? connectToRoom(request, env, roomId) : problem(404, ROOM_NOT_FOUND));
  }
  const huddle = pathname.match(/^\/api\/rooms\/([^/]+)\/huddle$/);
  if (huddle) return () => (isRoomId(huddle[1]!) ? connectToRoom(request, env, huddle[1]!, true) : problem(404, ROOM_NOT_FOUND));
  const settings = pathname.match(/^\/api\/rooms\/([^/]+)\/settings$/);
  if (settings && request.method === "GET") return () => (isRoomId(settings[1]!) ? roomSettings(request, env, settings[1]!) : problem(404, ROOM_NOT_FOUND));
  const favorite = pathname.match(/^\/api\/rooms\/([^/]+)\/favorite$/);
  if (favorite && request.method === "PUT") return () => setFavorite(request, env, favorite[1]!);
  const involvement = pathname.match(/^\/api\/rooms\/([^/]+)\/involvement$/);
  if (involvement && request.method === "PUT")
    return () => (isRoomId(involvement[1]!) ? setInvolvement(request, env, involvement[1]!) : problem(404, ROOM_NOT_FOUND));
  const membership = pathname.match(/^\/api\/rooms\/([^/]+)\/membership$/);
  if (membership && request.method === "DELETE") return () => (isRoomId(membership[1]!) ? leaveRoom(request, env, membership[1]!) : problem(404, ROOM_NOT_FOUND));
  const uploads = pathname.match(/^\/api\/rooms\/([^/]+)\/uploads$/);
  if (uploads && request.method === "POST") return () => (isRoomId(uploads[1]!) ? startUpload(request, env, uploads[1]!) : problem(404, ROOM_NOT_FOUND));
  // A file's key never needs percent-encoding either, so an encoded segment names no upload.
  const part = pathname.match(/^\/api\/rooms\/([^/]+)\/uploads\/([^/]+)\/parts\/([1-9][0-9]*)$/);
  if (part && request.method === "PUT")
    return () => (isRoomId(part[1]!) ? uploadPart(request, env, part[1]!, part[2]!, Number(part[3])) : problem(404, ROOM_NOT_FOUND));
  const preview = pathname.match(/^\/api\/rooms\/([^/]+)\/uploads\/([^/]+)\/preview$/);
  if (preview && request.method === "PUT")
    return () => (isRoomId(preview[1]!) ? uploadPreview(request, env, preview[1]!, preview[2]!) : problem(404, ROOM_NOT_FOUND));
  const room = pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (room && request.method === "PATCH") return () => (isRoomId(room[1]!) ? changeRoom(request, env, room[1]!) : problem(404, ROOM_NOT_FOUND));
  if (room && request.method === "DELETE") return () => (isRoomId(room[1]!) ? deleteRoom(request, env, room[1]!) : problem(404, ROOM_NOT_FOUND));
  return null;
}

/** Whether the request comes from an IP address a ban blocks. */
async function isFromBannedAddress(request: Request, env: Env): Promise<boolean> {
  const { ip } = clientOf(request);
  return ip !== null && (await workspace(env).isBanned(ip));
}

/** What a banned IP address's requests to change something answer. */
const tooManyRequests = () => new Response(null, { status: 429, headers: { "Content-Type": "text/html" } });

/** What the app's routes answer, before the headers every answer gets. */
async function route(request: Request, env: Env, pathname: string): Promise<Response> {
  // The deploy check isn't a browser's, any more than /up is.
  if (pathname === "/api/health") return health(request, env);
  // Nor is a custom domain check's probe, which this Worker sends.
  const probe = request.method === "GET" ? probeOf(pathname) : null;
  if (probe !== null) return answerProbe(env, probe);
  // Nor is password recovery's script, whose token another site's page can't send, since its header
  // takes a preflight nothing here answers.
  if (pathname === RECOVERY_PATH) return resetPassword(request, env);
  // A browser's report of what a page's policy blocked comes without the page's cookies or origin,
  // and from any browser the page reached.
  if (pathname === CSP_REPORT_PATH) return cspReport(request);
  // Nor is Memberful's webhook, which its servers sign with the webhook's secret.
  if (pathname === MEMBERFUL_WEBHOOK_PATH) return memberfulWebhook(request, env);
  const write = request.method !== "GET" && request.method !== "HEAD";
  // Nor is an app's authorization server, reading who Ember is.
  if (pathname === CLIENT_DOCUMENT_PATH && !write) return clientDocument(request);
  // Nor are a room's files, to whoever has the address, whatever their browser.
  // Nor are the AI apps that connect to Ember, whose requests carry a token of their own, or nothing.
  const outside = outsideAction(request, env, pathname);
  if (outside) return write && isOutsideRegistration(pathname) && (await isFromBannedAddress(request, env)) ? tooManyRequests() : outside();
  const file = fileAddressOf(pathname);
  if (file) return write ? notFound(request) : serveFile(request, env, file);
  const action = apiAction(request, env, pathname) ?? botAction(request, env, pathname);
  // First: once a route is found, so an unknown address still answers 404, a banned IP address can't
  // change anything, sign in or join.
  if (write && action && (await isFromBannedAddress(request, env))) return tooManyRequests();
  // Then: a browser too old for the app has nothing to sign in to.
  if (isFromUnsupportedBrowser(request)) return unsupportedBrowserPage(request, env);
  if (write && pathname.startsWith("/api/") && isCrossSite(request)) return problem(422, "Requests from other sites are refused");
  if (action) return action();
  if (pathname.startsWith("/api/")) return problem(404, "Not found");
  if (pathname === MEMBERFUL_SIGN_IN_PATH) return startMemberfulSignIn(request, env);
  // Signing in, which a banned IP address can't do, though it's a GET.
  if (pathname === MEMBERFUL_CALLBACK_PATH) return (await isFromBannedAddress(request, env)) ? tooManyRequests() : finishMemberfulSignIn(request, env);
  if (isSetupPath(pathname)) return setupPage(request, env);
  if (pathname === SIGN_UP_PATH) return signUpPage(request, env);
  if (pathname === INVITATION_PATH) return invitationPage(request, env);
  if (pathname === EMAIL_SIGN_UP_PATH) return emailSignUpPage(request, env);
  if (pathname === PASSWORD_RESET_PATH) return passwordResetPage(request, env);
  if (pathname === TURNSTILE_CHECK_PATH) return turnstileCheckPage(request);
  const joinCode = joinCodeOf(pathname);
  if (joinCode !== null) return joinPage(request, env, joinCode);
  if (pathname === TRANSFER_PATH) return transferPage(request, env);
  const manifestFormat = manifestFormatOf(pathname);
  if (manifestFormat !== null && !write) return manifest(env, manifestFormat);
  if (pathname.startsWith("/qr_code/")) return showQrCode(request, env);
  const avatarToken = avatarTokenOf(pathname);
  if (avatarToken !== null) return showAvatar(request, env, avatarToken);
  if (isAccountLogoPath(pathname)) return showAccountLogo(request, env);
  const page = write ? null : workspacePageOf(pathname);
  if (page?.page === "person") return personPage(request, env, pathname, page.userId);
  if (page?.page === "bot-settings") return botPage(request, env, pathname, page.userId);
  if (page?.page === "agent-settings") return agentPage(request, env, pathname, page.agentId);
  if (page?.page === "app-settings") return appPage(request, env, pathname, page.appId);
  if (pathname === OUTSIDE_AUTHORIZE_PATH && !write) return outsideConnectPage(request, env, pathname);
  return anyOtherPage(request, env, pathname);
}

/**
 * What an exception answers: JSON from the API and the bot API, and Campfire's 500 page otherwise.
 * Setup's form holds the first administrator's password, and its check the setup password, and recovery
 * its token and a new password, so there the log says only that the request failed, and a bot's key is
 * filtered out of its address, as Campfire's log filters it.
 */
function failure(request: Request, pathname: string, error: unknown): Response {
  // A JSON body over the limit is refused as too large, rather than failed on.
  if (error instanceof BodyTooLarge) return problem(413, error.message);
  const holdsSecrets = pathname === "/api/first_run" || pathname === "/api/first_run/check" || pathname === RECOVERY_PATH;
  console.error(`${request.method} ${withoutBotKeys(pathname)} failed:`, holdsSecrets ? "500 Internal Server Error" : error);
  if (pathname.startsWith("/api/")) return problem(500, "Something went wrong");
  if (isBotPath(pathname)) return exception(500);
  return failed(request);
}

export default {
  // Everything but the built app's static files comes here first (`run_worker_first`), page loads
  // included, so each answer gets the headers in headers.ts.
  async fetch(request, env): Promise<Response> {
    if (!isHttps(request) && requiresHttps(request, env)) return redirectToHttps(request);
    const { pathname } = urlOf(request);
    // /up skips Campfire's before-actions, being Rails' health check, so it's never checked and carries
    // no version, and Active Storage's files, which Campfire's controllers don't serve, carry none either.
    const isUp = isUpPath(pathname) && (request.method === "GET" || request.method === "HEAD");
    const isFile = fileAddressOf(pathname) !== null;
    const response = isUp ? up(request) : await route(request, env, pathname).catch((error: unknown) => failure(request, pathname, error));
    return withHeaders(response, request, env, { version: !isUp && !isFile, policy: !isFile });
  },
} satisfies ExportedHandler<Env>;
