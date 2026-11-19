import { toBase64url, urlsafeDecode64 } from "./encoding";
import { isLoopback } from "./loopback";

// An OpenID Connect relying party, as single sign-on (sso.ts) and the Workspace's checks of the accounts
// it links need it: the provider's discovery document and signing keys, each read once an hour at most;
// the authorization code flow, with S256 PKCE and a nonce (OpenID Connect Core 1.0, RFC 7636); refreshing
// what a refresh token says of someone; and the logout tokens of back-channel logout (OpenID Connect
// Back-Channel Logout 1.0). Every token is checked against the provider's keys, whatever it came through,
// and only asymmetric algorithms are taken. Nothing follows a redirect, which would take a secret
// elsewhere, and the provider's answers are logged by their status alone.

/** The provider and the app registered there for Ember. */
export interface OidcClient {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/** What the provider's discovery document says, of what Ember uses. */
export interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string | null;
  /** Whether it gives refresh tokens for offline_access, which Ember then asks for. */
  offlineAccess: boolean;
  /** Whether the token endpoint takes the app's secret in the request's body only, rather than as HTTP Basic credentials. */
  secretInBody: boolean;
  /** Whether it always names itself in the redirect back (RFC 9207), which the callback then checks. */
  issuerInResponse: boolean;
}

/** What a token endpoint gave: the ID token, if it gave one, the access token, and the refresh token, if it gave one. */
export interface TokenSet {
  idToken: string | null;
  accessToken: string;
  refreshToken: string | null;
}

/** A token's claims, and the userinfo endpoint's. */
export type Claims = Record<string, unknown>;

/** How long the provider has to answer each request. */
const TIMEOUT_MS = 10_000;
/** How long a discovery document and a set of keys are kept, and how soon keys are read again for one they lack. */
const DISCOVERY_MS = 60 * 60 * 1000;
const KEYS_MS = 60 * 60 * 1000;
const KEYS_AGAIN_MS = 60 * 1000;
/** How far the provider's clock may be from the Worker's. */
const SKEW_S = 120;
/** How old a logout token may be. */
const LOGOUT_TOKEN_S = 10 * 60;
/** The types a logout token's header may name. */
const LOGOUT_TYPES = ["logout+jwt", "application/logout+jwt", "jwt"];
/** The event a logout token carries. */
const BACKCHANNEL_LOGOUT = "http://schemas.openid.net/event/backchannel-logout";
/** The longest token Ember reads, longer than any provider's, even one that lists many roles. */
const MAX_TOKEN_LENGTH = 64 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The discovery documents read, by issuer, with when each is read again. */
const discoveries = new Map<string, { discovery: Discovery; until: number }>();
/** The keys read, by their set's address, with when they're read again, and when they were read. */
const keySets = new Map<string, { keys: JsonWebKey[]; until: number; readAt: number }>();

/** Whether `url` is somewhere Ember sends secrets: an https address, or an http one on this computer, where the tests fake a provider. */
const isSafe = (url: URL | null): url is URL => url !== null && (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url)));

/** The address in `value`, if it's one Ember sends secrets to. */
function endpointOf(value: unknown): string | null {
  const url = typeof value === "string" ? URL.parse(value) : null;
  return isSafe(url) ? url.href : null;
}

/** Where `issuer`'s discovery document is: its address, without a trailing slash, then `/.well-known/openid-configuration`. */
export const discoveryAddress = (issuer: string) => `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;

/** Whether `issuer` is one Ember asks: an https address, or an http one on this computer. */
export const isIssuer = (issuer: string) => isSafe(URL.parse(issuer));

/** Logs that the provider's `endpoint` didn't answer as it should, with its status only, and answers null. */
async function refused(endpoint: string, response: Response): Promise<null> {
  if (!response.bodyUsed) await response.body?.cancel();
  console.error(`The single sign-on provider's ${endpoint} answered ${response.status}${response.ok ? " without what it should" : ""}`);
  return null;
}

/** Logs that asking the provider's `endpoint` failed, by the error's name only, and answers null. */
function failed(endpoint: string, error: unknown): null {
  console.error(`Asking the single sign-on provider's ${endpoint} failed:`, error instanceof Error ? error.name : "unknown error");
  return null;
}

/** `init`, sent without following a redirect, for as long as the provider has to answer. */
const sent = (init: RequestInit = {}): RequestInit => ({ ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });

/** The JSON object `response` holds, if it's a successful answer that does. */
const objectOf = async (response: Response) => (response.ok ? jsonObjectOf(response) : null);

/** The JSON object `response` holds, whatever its status, if it holds one. */
async function jsonObjectOf(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * `issuer`'s discovery document, as it's kept for an hour, or read now when `fresh` says so: null when it
 * doesn't answer, or not as it should, "mismatch" when it names another issuer, and "unsupported" when it
 * doesn't offer the authorization code flow with S256 PKCE.
 */
export async function discover(issuer: string, { fresh = false } = {}): Promise<Discovery | "mismatch" | "unsupported" | null> {
  const known = discoveries.get(issuer);
  if (!fresh && known && known.until > Date.now()) return known.discovery;
  if (!isIssuer(issuer)) return null;
  let doc: Record<string, unknown> | null;
  try {
    const response = await fetch(discoveryAddress(issuer), sent({ headers: { Accept: "application/json" } }));
    doc = await objectOf(response);
    if (!doc) return refused("discovery document", response);
  } catch (error) {
    return failed("discovery document", error);
  }
  if (doc.issuer !== issuer) return "mismatch";
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null);
  const [responseTypes, challenges, scopes, authMethods] = [doc.response_types_supported, doc.code_challenge_methods_supported, doc.scopes_supported, doc.token_endpoint_auth_methods_supported].map(list);
  // A provider that doesn't list its PKCE methods may still take S256, as most do.
  if ((responseTypes && !responseTypes.includes("code")) || (challenges && !challenges.includes("S256"))) return "unsupported";
  const [authorizationEndpoint, tokenEndpoint, jwksUri] = [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri].map(endpointOf);
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) return "unsupported";
  const discovery: Discovery = {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    userinfoEndpoint: endpointOf(doc.userinfo_endpoint),
    offlineAccess: scopes?.includes("offline_access") ?? false,
    secretInBody: !!authMethods && !authMethods.includes("client_secret_basic") && authMethods.includes("client_secret_post"),
    issuerInResponse: doc.authorization_response_iss_parameter_supported === true,
  };
  discoveries.set(issuer, { discovery, until: Date.now() + DISCOVERY_MS });
  return discovery;
}

/** A random value of 32 bytes in URL-safe Base64, as a state, a nonce or a PKCE code verifier is. */
export const randomValue = () => toBase64url(crypto.getRandomValues(new Uint8Array(32)));

/** The S256 code challenge of a PKCE code verifier. */
export const codeChallengeOf = async (verifier: string) => toBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));

/** The scopes Ember asks for: openid, profile and email, offline_access while the provider gives refresh tokens for it, and `extra`. */
export const scopesFor = (discovery: Discovery, extra: string[]) =>
  [...new Set(["openid", "profile", "email", ...(discovery.offlineAccess ? ["offline_access"] : []), ...extra])].join(" ");

/** Where to sign in at the provider, which sends the browser back to `redirectUri` with `state`. */
export async function authorizationUrl(
  client: OidcClient,
  discovery: Discovery,
  { redirectUri, state, nonce, verifier, scopes }: { redirectUri: string; state: string; nonce: string; verifier: string; scopes: string[] },
): Promise<string> {
  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopesFor(discovery, scopes));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", await codeChallengeOf(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

/**
 * Asks the token endpoint for `grant`, authenticating as the app with its secret, as HTTP Basic
 * credentials unless the provider takes it only in the body: the tokens it gave, "invalid" when it says
 * the grant is no good (`invalid_grant`), as for a refresh token revoked, expired or for someone removed,
 * and null when it doesn't answer, or not as it should.
 */
async function tokens(client: OidcClient, discovery: Discovery, grant: Record<string, string>): Promise<TokenSet | "invalid" | null> {
  const body = new URLSearchParams(grant);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (discovery.secretInBody) {
    body.set("client_id", client.clientId);
    body.set("client_secret", client.clientSecret);
  } else {
    // RFC 6749 §2.3.1: each form-encoded before they're joined.
    const credentials = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
    headers.Authorization = `Basic ${btoa(credentials)}`;
  }
  try {
    const response = await fetch(discovery.tokenEndpoint, sent({ method: "POST", headers, body }));
    if (response.status === 400) {
      const error = (await jsonObjectOf(response))?.error;
      if (error === "invalid_grant") return "invalid";
      console.error(`The single sign-on provider's token endpoint answered 400${typeof error === "string" && /^[\w.-]{1,64}$/.test(error) ? ` (${error})` : ""}`);
      return null;
    }
    const answer = await objectOf(response);
    const [idToken, accessToken, refreshToken] = [answer?.id_token, answer?.access_token, answer?.refresh_token].map((value) =>
      typeof value === "string" && value !== "" && value.length <= MAX_TOKEN_LENGTH ? value : null,
    );
    if (!accessToken) return refused("token endpoint", response);
    return { idToken: idToken ?? null, accessToken, refreshToken: refreshToken ?? null };
  } catch (error) {
    return failed("token endpoint", error);
  }
}

/** Exchanges a code the provider sent the browser back with, and the PKCE code verifier the sign-in started with, for tokens. */
export async function exchangeCode(client: OidcClient, discovery: Discovery, { code, verifier, redirectUri }: { code: string; verifier: string; redirectUri: string }) {
  const answer = await tokens(client, discovery, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
  return answer === "invalid" ? null : answer;
}

/** Asks for new tokens with `refreshToken`: "invalid" once the provider no longer takes it. */
export const refreshTokens = (client: OidcClient, discovery: Discovery, refreshToken: string) =>
  tokens(client, discovery, { grant_type: "refresh_token", refresh_token: refreshToken });

/** What the userinfo endpoint says of whoever `accessToken` is for, or null when it has none, or doesn't answer as it should. */
export async function userinfo(discovery: Discovery, accessToken: string): Promise<Claims | null> {
  if (!discovery.userinfoEndpoint) return null;
  try {
    const response = await fetch(discovery.userinfoEndpoint, sent({ headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }));
    return (await objectOf(response)) ?? refused("userinfo endpoint", response);
  } catch (error) {
    return failed("userinfo endpoint", error);
  }
}

/** The algorithms a token may be signed with: only asymmetric ones, whose keys the provider publishes. */
const ALGORITHMS: Record<string, { kty: string; import: SubtleCryptoImportKeyAlgorithm; verify: SubtleCryptoSignAlgorithm }> = {
  RS256: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  RS384: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  RS512: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  PS256: { kty: "RSA", import: { name: "RSA-PSS", hash: "SHA-256" }, verify: { name: "RSA-PSS", saltLength: 32 } },
  PS384: { kty: "RSA", import: { name: "RSA-PSS", hash: "SHA-384" }, verify: { name: "RSA-PSS", saltLength: 48 } },
  PS512: { kty: "RSA", import: { name: "RSA-PSS", hash: "SHA-512" }, verify: { name: "RSA-PSS", saltLength: 64 } },
  ES256: { kty: "EC", import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
  ES384: { kty: "EC", import: { name: "ECDSA", namedCurve: "P-384" }, verify: { name: "ECDSA", hash: "SHA-384" } },
  ES512: { kty: "EC", import: { name: "ECDSA", namedCurve: "P-521" }, verify: { name: "ECDSA", hash: "SHA-512" } },
  EdDSA: { kty: "OKP", import: { name: "Ed25519" }, verify: { name: "Ed25519" } },
};

/** The provider's signing keys, as read within the hour, or read again when `again` says so and they weren't just read. */
async function keysOf(discovery: Discovery, again: boolean): Promise<JsonWebKey[] | null> {
  const known = keySets.get(discovery.jwksUri);
  const now = Date.now();
  if (known && known.until > now && !(again && known.readAt < now - KEYS_AGAIN_MS)) return known.keys;
  try {
    const response = await fetch(discovery.jwksUri, sent({ headers: { Accept: "application/json" } }));
    const set = await objectOf(response);
    if (!set || !Array.isArray(set.keys)) return (await refused("keys", response)) ?? known?.keys ?? null;
    const keys = set.keys.filter((key): key is JsonWebKey & { kid?: string } => typeof key === "object" && key !== null);
    keySets.set(discovery.jwksUri, { keys, until: now + KEYS_MS, readAt: now });
    return keys;
  } catch (error) {
    return failed("keys", error) ?? known?.keys ?? null;
  }
}

/** The JSON object `part` of a token encodes, if it encodes one. */
function partOf(part: string): Record<string, unknown> | null {
  const bytes = urlsafeDecode64(part);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether `signature` signs `input` under one of the provider's keys that `header` names, reading its keys again once for a key it lacks. */
async function isSigned(discovery: Discovery, header: Record<string, unknown>, input: string, signature: Uint8Array): Promise<boolean> {
  const algorithm = typeof header.alg === "string" && Object.hasOwn(ALGORITHMS, header.alg) ? ALGORITHMS[header.alg]! : null;
  if (!algorithm || header.crit !== undefined) return false;
  const kid = typeof header.kid === "string" ? header.kid : null;
  for (const again of [false, true]) {
    const keys = await keysOf(discovery, again);
    const candidates = (keys ?? []).filter(
      (key) => key.kty === algorithm.kty && (kid === null || (key as { kid?: unknown }).kid === kid) && (key.use === undefined || key.use === "sig") && (key.alg === undefined || key.alg === header.alg),
    );
    for (const key of candidates) {
      try {
        // Only the key's own parameters, so that its alg, use and key_ops, checked above, don't trip the import.
        const { kty, n, e, crv, x, y } = key;
        const imported = await crypto.subtle.importKey("jwk", { kty, n, e, crv, x, y }, algorithm.import, false, ["verify"]);
        if (await crypto.subtle.verify(algorithm.verify, imported, signature, encoder.encode(input))) return true;
      } catch {
        // A key of another shape, or one the runtime can't use: the next may do.
      }
    }
    if (candidates.length > 0 || kid === null) return false;
  }
  return false;
}

/** The claims of `token`, if the provider signed it, or null. */
async function signedClaims(discovery: Discovery, token: string): Promise<{ header: Record<string, unknown>; claims: Claims } | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, claims, signature] = [partOf(parts[0]!), partOf(parts[1]!), urlsafeDecode64(parts[2]!)];
  if (!header || !claims || !signature) return null;
  return (await isSigned(discovery, header, `${parts[0]}.${parts[1]}`, signature)) ? { header, claims } : null;
}

/** Whether `claims` are the provider's, for the app, and in date: issued by `issuer`, to the client, not expired, and not issued in the future. */
function isForClient(client: OidcClient, claims: Claims, now: number, expires: boolean): boolean {
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== client.issuer || !audience.includes(client.clientId)) return false;
  // A token for several audiences names the one it was given to.
  if ((audience.length > 1 || claims.azp !== undefined) && claims.azp !== client.clientId) return false;
  const time = (claim: unknown) => (typeof claim === "number" && Number.isFinite(claim) ? claim : null);
  const [exp, iat, nbf] = [time(claims.exp), time(claims.iat), time(claims.nbf)];
  if (iat === null || iat > now + SKEW_S) return false;
  if (nbf !== null && nbf > now + SKEW_S) return false;
  return expires ? exp !== null && exp > now - SKEW_S : exp === null || exp > now - SKEW_S;
}

/** Whether `claims` name someone: their `sub`, a string Ember keeps. */
const namesSubject = (claims: Claims) => typeof claims.sub === "string" && claims.sub !== "" && claims.sub.length <= 255;

/**
 * The claims of an ID token the provider gave the app, once it checks out: signed by the provider,
 * issued by it, to the app, in date, naming someone, and with `nonce`, the one the sign-in started with,
 * or, from a refresh, with whatever nonce it has. Null when any of that isn't so.
 */
export async function idTokenClaims(client: OidcClient, discovery: Discovery, idToken: string, nonce: string | null): Promise<Claims | null> {
  const signed = await signedClaims(discovery, idToken);
  if (!signed || !isForClient(client, signed.claims, Date.now() / 1000, true) || !namesSubject(signed.claims)) return null;
  if (nonce !== null && signed.claims.nonce !== nonce) return null;
  return signed.claims;
}

/**
 * Who a back-channel logout token signs out, once it checks out: signed by the provider, issued by it,
 * to the app, in the last ten minutes, with the logout event, no nonce, and naming someone (`sub`) or a
 * session at the provider (`sid`), or both, and the sessions started by when, in milliseconds: by the
 * end of the second it was issued in, by the provider's clock, so that one delivered late, or again,
 * never ends a session signed in after it. The clocks' skew counts toward whether a token is taken,
 * not toward which sessions it ends. Null when any of that isn't so.
 */
export async function logoutTokenSubject(
  client: OidcClient,
  discovery: Discovery,
  logoutToken: string,
): Promise<{ subject: string | null; sid: string | null; startedBy: number } | null> {
  const signed = await signedClaims(discovery, logoutToken);
  if (!signed) return null;
  const { header, claims } = signed;
  const now = Date.now() / 1000;
  // The spec recommends logout+jwt, which RFC 7515 lets be written with application/, but takes JWT too.
  if (header.typ !== undefined && !LOGOUT_TYPES.includes(String(header.typ).toLowerCase())) return null;
  if (!isForClient(client, claims, now, false) || (claims.iat as number) < now - LOGOUT_TOKEN_S) return null;
  const events = claims.events;
  if (typeof events !== "object" || events === null || !Object.hasOwn(events, BACKCHANNEL_LOGOUT) || claims.nonce !== undefined) return null;
  const subject = namesSubject(claims) ? (claims.sub as string) : null;
  const sid = typeof claims.sid === "string" && claims.sid !== "" && claims.sid.length <= 255 ? claims.sid : null;
  // `iat` counts whole seconds, so a session started within the second it names may have come first.
  const startedBy = (Math.floor(claims.iat as number) + 1) * 1000;
  return subject === null && sid === null ? null : { subject, sid, startedBy };
}

/** Forgets every discovery document and key read, as the tests do between providers. */
export function forgetProviders(): void {
  discoveries.clear();
  keySets.clear();
}
