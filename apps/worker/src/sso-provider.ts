import { isReservedName, MAX_EMAIL_ADDRESS_LENGTH, MAX_USER_NAME_LENGTH } from "@ember/protocol";
import { DEFAULT_GROUPS_CLAIM, DEFAULT_SSO_NAME, type SsoSettings } from "@ember/protocol/sso";
import type { Env } from "./env";
import { idTokenClaims, userinfo, type Claims, type Discovery, type OidcClient, type TokenSet } from "./oidc";
import { unseal } from "./sealed";
import type { SavedSso } from "./workspace-store";

// The single sign-on provider as the Worker and the Workspace go by it: its issuer and app, from the
// deployment's secrets, which take the place of any others, or as an administrator set it up on the
// Single sign-on card, and what the card says of whom it lets in; and what it says of whoever signs in,
// as the ID token and the userinfo endpoint have it.

/** The provider, with its app's secret opened, and where its issuer and app come from. */
export interface SsoProvider extends OidcClient, Omit<SsoSettings, "issuer" | "clientId"> {}

/**
 * What the Single sign-on card says of whom it lets in: whoever the provider signs in to its app,
 * `clientId`, who is in a group it lets in, if it names any, as `isAllowed` goes by.
 */
export type SignInRules = Pick<SsoProvider, "clientId" | "allowedGroups" | "groupsClaim">;

/**
 * Someone who signed in at an account elsewhere, as Memberful's member API or a single sign-on provider
 * describes them: the id of their account there, which accounts here are linked by, their name there,
 * the names someone new could be called here, the one they'd rather first, their email address, whether
 * the provider verified it, and whether that account lets them in: an active Memberful membership, or a
 * group the Single sign-on card lets in, by the card's rules as they were then, `letInBy`.
 */
export interface MemberElsewhere {
  id: string;
  fullName: string | null;
  names: string[];
  emailAddress: string | null;
  emailVerified?: boolean;
  subscribed: boolean;
  letInBy?: SignInRules;
}

/** Whether `a` and `b` let in the same people: those the same app signs in, and everyone, or those in the same groups at the same claim. */
export const sameSignInRules = (a: SignInRules, b: SignInRules) =>
  a.clientId === b.clientId &&
  ((a.allowedGroups.length === 0 && b.allowedGroups.length === 0) ||
    (a.groupsClaim === b.groupsClaim && a.allowedGroups.every((group) => b.allowedGroups.includes(group)) && b.allowedGroups.every((group) => a.allowedGroups.includes(group))));

/** The deployment's issuer and app, from `SSO_ISSUER`, `SSO_CLIENT_ID` and `SSO_CLIENT_SECRET`, or null without all three. */
export function ssoSecretsOf(env: Env): OidcClient | null {
  const [issuer, clientId, clientSecret] = [env.SSO_ISSUER?.trim(), env.SSO_CLIENT_ID?.trim(), env.SSO_CLIENT_SECRET?.trim()];
  return issuer && clientId && clientSecret ? { issuer, clientId, clientSecret } : null;
}

/**
 * The provider, from the deployment's secrets and what the card saved, or null while there's none: while
 * neither gives its issuer, app and secret, or the secret saved doesn't open under SESSION_SECRET, as
 * once that's changed, when it's as if it weren't set up until an administrator sets it up again.
 */
export async function ssoProviderOf(env: Env, saved: SavedSso | null): Promise<SsoProvider | null> {
  const secrets = ssoSecretsOf(env);
  const named = {
    name: saved?.name || DEFAULT_SSO_NAME,
    scopes: saved?.scopes ?? [],
    groupsClaim: saved?.groupsClaim || DEFAULT_GROUPS_CLAIM,
    allowedGroups: saved?.allowedGroups ?? [],
    linksVerifiedEmails: saved?.linksVerifiedEmails ?? false,
  };
  if (secrets) return { ...secrets, ...named, source: "secret" };
  if (!saved?.issuer || !saved.clientId || !saved.sealedClientSecret) return null;
  const clientSecret = await unseal(env.SESSION_SECRET, "sso-client-secret", saved.sealedClientSecret);
  if (clientSecret === null) console.error("The single sign-on client secret Ember was given doesn't open under SESSION_SECRET, so nobody signs in with it.");
  return clientSecret === null ? null : { issuer: saved.issuer, clientId: saved.clientId, clientSecret, ...named, source: "saved" };
}

/** The provider as the Single sign-on card shows it, without its secret. */
export const ssoSettingsOf = ({ source, issuer, clientId, name, scopes, groupsClaim, allowedGroups, linksVerifiedEmails }: SsoProvider): SsoSettings => ({
  source,
  issuer,
  clientId,
  name,
  scopes,
  groupsClaim,
  allowedGroups,
  linksVerifiedEmails,
});

/**
 * What the provider says of whoever `tokens` are for: the ID token's claims, once it checks out
 * (`idTokenClaims`) with `nonce`, or any nonce for a refresh's, with the userinfo endpoint's over them,
 * as long as it names the same person, and with whether the email address was verified as the answer
 * that gave the address says. A refresh may give no ID token, when the userinfo endpoint's are all there
 * is, if it names someone. Null when neither checks out, or when the endpoint doesn't answer and the
 * answer depends on it (`needsUserinfo`).
 */
export async function claimsOf(provider: SsoProvider, discovery: Discovery, tokens: TokenSet, nonce: string | null): Promise<Claims | null> {
  const fromToken = tokens.idToken === null ? null : await idTokenClaims(provider, discovery, tokens.idToken, nonce);
  // A sign-in's ID token is what ties it to the browser that started it, by its nonce.
  if (nonce !== null && fromToken === null) return null;
  if (tokens.idToken !== null && fromToken === null) return null;
  const info = await userinfo(discovery, tokens.accessToken);
  // An endpoint that didn't answer leaves the answer half told, when it alone could give the groups.
  if (discovery.userinfoEndpoint !== null && info === null && needsUserinfo(provider, fromToken)) return null;
  const subject = fromToken?.sub ?? info?.sub;
  if (typeof subject !== "string" || subject === "" || subject.length > 255) return null;
  // One that names someone else answers for nobody (OpenID Connect Core §5.3.2).
  if (info && info.sub !== subject) return null;
  const claims: Claims = { ...(fromToken ?? {}), ...(info ?? {}), sub: subject };
  // Whether an email address was verified is the word of whichever answer gave that address, lest the
  // ID token's verifying one address vouch for another the userinfo endpoint gives.
  if (info && "email" in info && info.email !== fromToken?.email) claims.email_verified = info.email_verified;
  return claims;
}

/**
 * Whether what the provider says of someone depends on the userinfo endpoint: there's no ID token, or the
 * card lets in only some groups and the ID token doesn't list any.
 */
const needsUserinfo = (provider: SsoProvider, fromToken: Claims | null) =>
  fromToken === null || (provider.allowedGroups.length > 0 && fromToken[provider.groupsClaim] === undefined);

/**
 * Whether the claims `claimsOf` gathered by the card `asked` say as much of someone's groups as the card
 * `current` needs: it lets everyone in, or `asked` let in only some groups too, by the same claim, so
 * the userinfo endpoint had to answer for them alike (`needsUserinfo`). Otherwise an ID token without
 * them may be all that answered.
 */
export const toldAlike = (asked: SsoProvider, current: SsoProvider) =>
  current.allowedGroups.length === 0 || (asked.allowedGroups.length > 0 && asked.groupsClaim === current.groupsClaim);

/** The groups the claim `claim` lists: a list of names, an object keyed by them, as Zitadel's roles are, or a single name. */
export function groupsOf(claims: Claims, claim: string): string[] {
  const value = claims[claim];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((group): group is string => typeof group === "string");
  if (typeof value === "object" && value !== null) return Object.keys(value);
  return [];
}

/** Whether the provider's word lets someone in: they're in one of the groups the card lets in, or it lets everyone in. */
export const isAllowed = (provider: Pick<SsoProvider, "allowedGroups" | "groupsClaim">, claims: Claims) =>
  provider.allowedGroups.length === 0 || groupsOf(claims, provider.groupsClaim).some((group) => provider.allowedGroups.includes(group));

/** `name` without the spaces around it, cut to the longest name, without half of a character cut in two. */
const cutName = (name: string) =>
  name
    .trim()
    .slice(0, MAX_USER_NAME_LENGTH)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd();

/** The claim `name` as text, or "" without it. */
const text = (claims: Claims, name: string) => (typeof claims[name] === "string" ? (claims[name] as string) : "");

/**
 * Whoever `claims` describe, as signing in with an account elsewhere takes them: their subject, their
 * name, or else their given and family names together, the names someone new could be called here, their
 * name, then their preferred username and their email address's local part, passing over blank ones and
 * @ember's, their email address, if it's one Ember keeps, whether the provider verified it, and whether
 * the provider lets them in (`isAllowed`), by the card's rules for it.
 */
export function memberOf(provider: SsoProvider, claims: Claims): MemberElsewhere {
  const given = text(claims, "email").trim();
  const emailAddress = given !== "" && given.length <= MAX_EMAIL_ADDRESS_LENGTH && given.includes("@") ? given : null;
  const fullName = cutName(text(claims, "name") || `${text(claims, "given_name")} ${text(claims, "family_name")}`) || null;
  const names = [fullName ?? "", text(claims, "preferred_username"), emailAddress?.split("@")[0] ?? ""].map(cutName);
  return {
    id: claims.sub as string,
    fullName,
    names: [...new Set(names.filter((name) => name && !isReservedName(name)))],
    emailAddress,
    // Some providers send it as text.
    emailVerified: emailAddress !== null && (claims.email_verified === true || claims.email_verified === "true"),
    subscribed: isAllowed(provider, claims),
    letInBy: { clientId: provider.clientId, allowedGroups: provider.allowedGroups, groupsClaim: provider.groupsClaim },
  };
}
