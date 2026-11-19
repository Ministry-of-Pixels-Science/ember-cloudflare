// Single sign-on, with an OpenID Connect provider such as Zitadel, Okta, Entra ID, Google Workspace,
// Keycloak or Authentik: an administrator gives Ember the provider's issuer and the keys of the app they
// registered there on the Single sign-on card of workspace settings' Membership, through
// `/api/account/sso`, or the deployment gives them as secrets, and turns it on there. People then sign in
// at the provider, which sends their browser back to `SSO_CALLBACK_PATH`, and tells Ember when someone
// signs out or is removed there, at `SSO_LOGOUT_PATH`.

import type { MemberfulAccount, MemberfulConnection, MemberfulConnectionStart, MemberfulDisconnection } from "./index.ts";

/**
 * The provider as the Single sign-on card shows it to administrators: where its issuer, app and secret
 * come from, the deployment's secrets `SSO_ISSUER`, `SSO_CLIENT_ID` and `SSO_CLIENT_SECRET`, which take
 * the place of any others, or the ones an administrator gave, and what the card sets besides.
 */
export interface SsoSettings {
  source: "secret" | "saved";
  /** The provider's issuer, as its discovery document names it, such as https://example.zitadel.cloud. */
  issuer: string;
  /** The ID of the app registered at the provider for Ember (its client ID). */
  clientId: string;
  /** What the sign-in page calls the provider: Sign in with `name`. */
  name: string;
  /** The scopes Ember asks for besides openid, profile, email and, when the provider has it, offline_access. */
  scopes: string[];
  /**
   * The claim of the ID token, or of the provider's userinfo, that lists someone's groups or roles, such
   * as `groups`, or Zitadel's `urn:zitadel:iam:org:project:roles`: a list of names, an object keyed by
   * them, or a single name.
   */
  groupsClaim: string;
  /** The groups that let someone in, or none to let in everyone the provider signs in. */
  allowedGroups: string[];
  /**
   * Whether someone who signs in for the first time is matched with the account here that has the email
   * address the provider says they've verified (`email_verified`). Off until an administrator turns it
   * on, when accounts are linked only by their owners, with their passwords.
   */
  linksVerifiedEmails: boolean;
}

/**
 * What Set up single sign-on gives `PUT /api/account/sso`. The issuer, app and secret are left out while
 * the deployment's secrets give them, and the secret when the one kept stays.
 */
export interface SsoSetup {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  name: string;
  scopes: string[];
  groupsClaim: string;
  allowedGroups: string[];
  linksVerifiedEmails: boolean;
}

/** What `PUT /api/account/sso` answers once the provider's discovery document checks out: the provider as it is then. */
export interface SsoSaved {
  sso: SsoSettings;
}

/** What `DELETE /api/account/sso` answers: the provider as the deployment's secrets give it, if they do, or none, which turns single sign-on off. */
export interface SsoForgotten {
  sso: SsoSettings | null;
}

/** A field of Set up single sign-on, which a refusal can be about. */
export type SsoField = "issuer" | "clientId" | "clientSecret" | "name" | "scopes" | "groupsClaim" | "allowedGroups";

/** The longest issuer, client ID and secret Ember keeps, far longer than any provider's. */
export const MAX_ISSUER_LENGTH = 2048;
export const MAX_CLIENT_ID_LENGTH = 255;
export const MAX_CLIENT_SECRET_LENGTH = 1024;
/** The longest name the sign-in page's button shows. */
export const MAX_SSO_NAME_LENGTH = 40;
/** The most scopes, and groups, a provider is set up with, and the longest of each. */
export const MAX_SSO_SCOPES = 20;
export const MAX_SSO_GROUPS = 50;
export const MAX_SSO_TOKEN_LENGTH = 255;

/** What the sign-in page calls a provider that hasn't been given a name. */
export const DEFAULT_SSO_NAME = "SSO";
/** The claim that lists someone's groups, unless the card names another. */
export const DEFAULT_GROUPS_CLAIM = "groups";

/** Where the sign-in page's Sign in with goes, which sends the browser on to sign in at the provider, naming the page to come back to in `return_to`. */
export const SSO_SIGN_IN_PATH = "/auth/sso";
/** Where the provider sends the browser back to: the redirect URI the app registered there names. */
export const SSO_CALLBACK_PATH = "/auth/sso/callback";
/** Where the provider says that someone signed out or was removed there: the back-channel logout URI the app registered there names. */
export const SSO_LOGOUT_PATH = "/auth/sso/backchannel_logout";
/** Where Set up single sign-on saves the provider, and turning it off forgets it. */
export const SSO_SETTINGS_PATH = "/api/account/sso";
/** Where your profile's Connect goes, which answers where to sign in at the provider (`SsoConnection`) once it knows it's you. */
export const SSO_CONNECTIONS_PATH = "/api/users/me/sso_connections";

/** Signing in with the provider, coming back to `returnTo`, a page of the workspace, once signed in, or home without one. */
export const ssoSignInPath = (returnTo: string | null) => (returnTo === null ? SSO_SIGN_IN_PATH : `${SSO_SIGN_IN_PATH}?return_to=${encodeURIComponent(returnTo)}`);

/** What connecting your account to one at the provider from your profile takes: your password, while you have one. */
export type SsoConnectionStart = MemberfulConnectionStart;
/** What disconnecting it takes: your password, and this browser's push subscription, if it has one, which it keeps. */
export type SsoDisconnection = MemberfulDisconnection;
/** The account at the provider you've connected, as it described itself when you connected it or last signed in with it. */
export type SsoAccount = MemberfulAccount;

/**
 * Where you stand with single sign-on, as your profile's section for it shows it: what the provider is
 * called, the account there you've connected, which you sign in with, or null while you haven't, when the
 * section offers to connect one, and whether single sign-on is the only way in, unless you need no
 * account there (`Profile.membershipNeeded`).
 */
export interface SsoStatus {
  name: string;
  ssoOnly: boolean;
  connected: SsoAccount | null;
}

/**
 * Where to sign in at the provider, within ten minutes, to connect the account you sign in to there to
 * yours here: what connecting from your profile answers, and what signing in with a password answers
 * someone whose password checks out while single sign-on is the only way in, until they've connected
 * one. Asked at an address Ember has moved from to its custom domain, it's the page to come back to at
 * the custom domain instead.
 */
export interface SsoConnection {
  ssoConnection: string;
}

/**
 * What signing in with a password answers someone whose password checks out while they sign in only
 * elsewhere, until they've connected an account there: where to connect one at Memberful, or at the
 * provider, or at either while Members only and SSO only are both on.
 */
export type ElsewhereConnection = MemberfulConnection | SsoConnection | (MemberfulConnection & SsoConnection);

/**
 * Why signing in with the provider didn't sign anyone in, or didn't connect an account, which the
 * callback sends the browser back to sign in with, as `?sso=`, or to your profile when it's signed in as
 * you, and the page says.
 */
export const SSO_SIGN_IN_PROBLEMS = {
  /** The provider sent the browser back without a sign-in, or with one this browser didn't start, or didn't answer as it should. */
  failed: "Couldn't sign in with single sign-on. Try again.",
  /** The account at the provider isn't in any of the groups that let people in. */
  membership: "Your account doesn't have access to this workspace. Contact an administrator.",
  /** Someone here has the provider's email address for them already, and it isn't one the provider verified, or matching it is off. */
  taken: "An account with your email address already exists. Sign in with your password instead.",
  /** The account at the provider is connected to someone else here already. */
  claimed: "This account is already connected to another member.",
  /** Your account is connected to another account at the provider already. */
  another: "Your account is already connected to a different single sign-on account.",
  /** Someone new signed in while an administrator has joining with single sign-on off. */
  off: "New members can't join with single sign-on.",
  /** Someone connected their account once single sign-on stopped being the only way in, when their password signs them in. */
  unneeded: "Single sign-on is no longer required. Sign in with your password.",
  /** The person the account is linked to was removed or banned, or tried too often. */
  refused: "Too many requests or unauthorized.",
  /** No provider is set up. */
  unavailable: "Single sign-on isn't set up. Contact an administrator.",
} as const;

export type SsoSignInProblem = keyof typeof SSO_SIGN_IN_PROBLEMS;

/** The query parameter that names a sign-in's problem, or says that your profile connected your account. */
export const SSO_PROBLEM_PARAM = "sso";
/** What that parameter says once your account at the provider is connected, and what your profile then says. */
export const SSO_CONNECTED = "connected";
export const SSO_CONNECTED_NOTICE = "Single sign-on connected.";
export const SSO_DISCONNECTED_NOTICE = "Single sign-on disconnected.";

/** The sign-in problem `value` names, if it names one. */
export const ssoProblemOf = (value: string | null): SsoSignInProblem | null =>
  value !== null && Object.hasOwn(SSO_SIGN_IN_PROBLEMS, value) ? (value as SsoSignInProblem) : null;

/** Why signing in with a password, joining with the join link, or signing in with just a name is refused while single sign-on is the only way in. */
export const SSO_SIGN_IN_NEEDED = "This workspace uses single sign-on. Only administrators and invited people can sign in with a password.";
/** The same, while Memberful's Members only and SSO only are both on, so that either signs people in. */
export const MEMBERFUL_OR_SSO_SIGN_IN_NEEDED =
  "Members sign in with Memberful or single sign-on. Only administrators and invited people can sign in with a password.";
/** Why connecting from your profile is refused without your password, while you have one. */
export const SSO_PASSWORD_NEEDED = "Enter your password to connect single sign-on.";
/**
 * Why disconnecting is refused without your password, without one, which you'd have nothing to sign in
 * with without, and which single sign-on signing you in gives you none of, without an email address, or
 * while you aren't connected.
 */
export const SSO_DISCONNECT_PASSWORD_NEEDED = "Enter your password to disconnect single sign-on.";
export const SSO_DISCONNECT_WITHOUT_PASSWORD = "You sign in with single sign-on alone, so it can't be disconnected.";
export const SSO_DISCONNECT_WITHOUT_EMAIL = "Add an email address before you disconnect, so you can still sign in.";
export const SSO_NOT_CONNECTED = "Single sign-on isn't connected.";
/**
 * Why a first password is refused to someone single sign-on signs in, while it does: it's their way in,
 * and a password that whoever holds their session could set would be another, as with Memberful.
 */
export const PASSWORD_WITH_SSO = "You sign in with single sign-on, so there's no password to set.";
/**
 * Why connecting one account elsewhere is refused to someone without a password whom the other signs
 * in: holding their session is all there'd be to check, which isn't enough to add a way in, as with a
 * first password.
 */
export const SSO_WITH_MEMBERFUL = "You sign in with Memberful, so single sign-on can't be connected too.";
export const MEMBERFUL_WITH_SSO = "You sign in with single sign-on, so Memberful can't be connected too.";

/** Why single sign-on can't be turned on yet, nor SSO only. */
export const SSO_SETUP_NEEDED = "Set up single sign-on first.";
/** Why turning on Open, or SSO only, is refused while the other is on. */
export const OPEN_WITH_SSO = "Open and SSO only can't be on at the same time.";
/** What the Single sign-on card tells anyone but an administrator. */
export const SSO_FORBIDDEN = "Only administrators can set up single sign-on";

/** Why Set up single sign-on's fields are refused before the provider is asked about them. */
export const ISSUER_REFUSED = "Enter your provider's issuer URL, like https://auth.example.com.";
export const CLIENT_ID_REFUSED = "Enter the Client ID from your provider.";
export const CLIENT_SECRET_REFUSED = "Enter the Client Secret from your provider.";
export const SSO_NAME_REFUSED = `Use ${MAX_SSO_NAME_LENGTH} characters or fewer.`;
export const SCOPES_REFUSED = `Enter up to ${MAX_SSO_SCOPES} scopes, separated by spaces.`;
export const GROUPS_CLAIM_REFUSED = "Enter a claim name without spaces, like groups.";
export const GROUPS_REFUSED = `Enter up to ${MAX_SSO_GROUPS} groups, one per line.`;

/** Why they're refused once the provider has been asked, or couldn't be. */
export const ISSUER_UNREACHABLE = "Couldn't reach your provider. Check the issuer URL and try again.";
export const ISSUER_MISMATCH = "This issuer URL doesn't match your provider's. Enter it exactly as your provider shows it.";
export const CLIENT_UNCHECKED = "Enter a Client ID and Client Secret first.";
export const ISSUER_UNSUPPORTED = "This provider doesn't support the authorization code flow with PKCE (S256).";

/** A scope, a group or a claim: some text without spaces or control characters, as long as Ember keeps. */
const isToken = (text: string) => text.length > 0 && text.length <= MAX_SSO_TOKEN_LENGTH && !/[\s\u0000-\u001f\u007f]/.test(text);

/** The words of `text`, apart by spaces, or the list as given, without blanks or repeats. */
function wordsOf(value: unknown, split: RegExp): string[] | null {
  const items = typeof value === "string" ? value.split(split) : Array.isArray(value) ? value : null;
  if (items === null || !items.every((item): item is string => typeof item === "string")) return null;
  return [...new Set(items.map((item) => item.trim()).filter((item) => item !== ""))];
}

/** The text `value` gives, trimmed, or undefined for none, or null when it isn't text. */
function textOf(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value.trim() : null;
}

/**
 * What `PUT /api/account/sso` gives Ember, as Set up single sign-on sends it, or why it can't be a
 * provider's, on the field it's about. Whether the issuer, app and secret may be left out, and whether the
 * issuer is one Ember can reach, the Worker says.
 */
export function parseSsoSetup(data: unknown): SsoSetup | { error: string; field: SsoField } {
  const fields = (typeof data === "object" && data !== null && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  const [issuer, clientId, clientSecret, name, groupsClaim] = [fields.issuer, fields.clientId, fields.clientSecret, fields.name, fields.groupsClaim].map(textOf);
  if (issuer === null || (issuer !== undefined && (issuer.length > MAX_ISSUER_LENGTH || !/^https?:\/\/[^\s/?#]+[^\s?#]*$/i.test(issuer)))) {
    return { error: ISSUER_REFUSED, field: "issuer" };
  }
  if (clientId === null || clientId === "" || (clientId !== undefined && clientId.length > MAX_CLIENT_ID_LENGTH)) return { error: CLIENT_ID_REFUSED, field: "clientId" };
  if (clientSecret === null || (clientSecret !== undefined && clientSecret.length > MAX_CLIENT_SECRET_LENGTH)) return { error: CLIENT_SECRET_REFUSED, field: "clientSecret" };
  if (name === null || (name !== undefined && name.length > MAX_SSO_NAME_LENGTH)) return { error: SSO_NAME_REFUSED, field: "name" };
  if (groupsClaim === null || (groupsClaim !== undefined && groupsClaim !== "" && !isToken(groupsClaim))) return { error: GROUPS_CLAIM_REFUSED, field: "groupsClaim" };
  const scopes = fields.scopes === undefined ? [] : wordsOf(fields.scopes, /\s+/);
  if (scopes === null || scopes.length > MAX_SSO_SCOPES || !scopes.every(isToken)) return { error: SCOPES_REFUSED, field: "scopes" };
  const allowedGroups = fields.allowedGroups === undefined ? [] : wordsOf(fields.allowedGroups, /\n/);
  if (allowedGroups === null || allowedGroups.length > MAX_SSO_GROUPS || !allowedGroups.every((group) => group.length <= MAX_SSO_TOKEN_LENGTH)) {
    return { error: GROUPS_REFUSED, field: "allowedGroups" };
  }
  return {
    ...(issuer ? { issuer } : {}),
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    name: name || DEFAULT_SSO_NAME,
    scopes,
    groupsClaim: groupsClaim || DEFAULT_GROUPS_CLAIM,
    allowedGroups,
    linksVerifiedEmails: fields.linksVerifiedEmails === true,
  };
}
