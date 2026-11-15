import {
  auth,
  Client,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  IssuerMismatchError,
  OAuthError,
  OAuthErrorCode,
  refreshAuthorization,
  RegistrationRejectedError,
  selectClientAuthMethod,
  StreamableHTTPClientTransport,
  type AddClientAuthentication,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
  type StoredOAuthClientInformation,
} from "@modelcontextprotocol/client";
import type { AppRefused } from "@ember/protocol/apps";
import { toHex } from "../encoding";
import { isLoopback } from "../loopback";
import { checkHost, GuardError, resolveOverHttps } from "../unfurl/guard";
import { VERSION } from "../version";
import { scopesWith } from "./scopes";
import { heldTo, READ_DEADLINE_MS, MAX_READ_BYTES, saidTooMuch, tookTooLong, type Held, type Send } from "./mcp";

// Signing in to an app whose server asks for one, with OAuth as the Model Context Protocol has it
// (https://modelcontextprotocol.io/specification/draft/basic/authorization), through the protocol's own
// client. An administrator's browser goes to the app's authorization server and comes back with a code,
// which Ember exchanges for the token it then sends the server, and one to get another with when that
// ends. Ember is a public client that proves each exchange with PKCE: the authorization server reads
// who Ember is from the document Ember serves, where it reads one, or else Ember registers itself.
// Where it does neither, an administrator registers Ember there themselves, and gives Ember the client
// ID they got, with its secret, if it has one, which Ember then proves itself with as well.
// A server that refuses a call for want of a scope has that asked for at the next sign-in, with what
// the last one had, and removing an app takes its tokens back at the service, where it says how.
// Everything asked about a sign-in is asked the way an app's server is: over https, of names that
// resolve only to public addresses, without following a redirect to another host, within one deadline.

/** Where Ember serves the document that says who it is to an authorization server that reads one. */
export const CLIENT_DOCUMENT_PATH = "/oauth/client.json";

/** How long an access token is taken to last when its authorization server doesn't say, while there's a token to get another with. */
const UNSAID_LIFETIME_MS = 60 * 60_000;
/** How long before an access token ends Ember gets another, so that none ends on its way. */
const EARLY_MS = 60_000;
/** The most characters of a sign-in Ember keeps: what was found of its authorization server makes most of it. */
const MAX_SIGN_IN_LENGTH = 40_000;
/** How long taking a sign-in's tokens back may take in all, which removing its app waits for. */
const REVOKE_DEADLINE_MS = 10_000;

/**
 * A sign-in to an app, as Ember keeps it, sealed: where its authorization server sends the browser
 * back, where Ember's client document is, if it serves one there, what was found of the authorization
 * server, who Ember is to it, and whether that's a client an administrator gave, `ownClient`, the
 * resource the tokens are for, the PKCE verifier of a sign-in that's under way, with the scopes it
 * asks for, if any, and, once it's done, the tokens, with when the access token ends, if it does.
 */
export interface SignIn {
  redirectUrl: string;
  clientUrl: string | null;
  discovery?: OAuthDiscoveryState;
  client?: StoredOAuthClientInformation;
  ownClient?: true;
  resource?: string;
  codeVerifier?: string;
  scopeAsked?: string;
  tokens?: { access: string; refresh: string | null; scope: string | null };
  expiresAt?: number | null;
}

/** A sign-in that's done, with its tokens. */
export type SignedIn = SignIn & { tokens: NonNullable<SignIn["tokens"]> };

/** A sign-in that's begun: where to send the administrator's browser, the state it comes back with, and what to keep until then. */
export interface StartedSignIn {
  authorizationUrl: string;
  state: string;
  signIn: SignIn;
}

/** Who Ember says it is to an authorization server, which sends the browser back to `redirectUrl`. */
export function clientMetadataOf(redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: "Ember",
    client_uri: new URL(redirectUrl).origin,
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** Whether `signIn`'s access token has ended at `now`, or is about to, so that another is wanted first. */
export const isDue = ({ expiresAt }: SignIn, now: number) => expiresAt != null && expiresAt - EARLY_MS <= now;

/**
 * Begins a sign-in to the app at `url`, for an administrator whose browser comes back to `redirectUrl`:
 * finds the server's authorization server, has it know Ember, as `client` when an administrator gave
 * one, and otherwise by Ember's client document at `clientUrl` where it reads one, or by registering,
 * and answers where to send the browser, or why Ember can't sign in there. The sign-in asks for what
 * the server and its authorization server say to, and for the scopes of `more` besides, if there are any.
 */
export async function startSignIn(
  url: string,
  redirectUrl: string,
  clientUrl: string | null,
  client: StoredOAuthClientInformation | null = null,
  more: string | null = null,
  send: Send = fetch,
): Promise<StartedSignIn | AppRefused> {
  const address = new URL(url);
  const held: Held = { deadline: AbortSignal.timeout(READ_DEADLINE_MS), bytesLeft: MAX_READ_BYTES };
  const guard = guarded(address, held, send);
  const session = new Session({ redirectUrl, clientUrl, ...(client && { client, ownClient: true as const }) }, toHex(crypto.getRandomValues(new Uint8Array(32))));
  try {
    const { resourceMetadataUrl, scope } = await challengeOf(address, guard.send, held);
    await auth(session, { serverUrl: address, resourceMetadataUrl, scope, fetchFn: guard.send });
    const { authorizationUrl, signIn } = session;
    if (!authorizationUrl || !signIn.discovery?.authorizationServerMetadata) return noSignIn(address.host);
    // The browser is sent only where Ember itself would ask: not into whatever network the administrator is on.
    await guard.allows(authorizationUrl);
    const asksFor = scopesWith(authorizationUrl.searchParams.get("scope"), more);
    if (more !== null && asksFor !== null) authorizationUrl.searchParams.set("scope", asksFor);
    if (asksFor !== null) signIn.scopeAsked = asksFor;
    if (JSON.stringify(signIn).length > MAX_SIGN_IN_LENGTH) return { error: saidTooMuch(address.host), field: "url" };
    return { authorizationUrl: authorizationUrl.href, state: session.stateId, signIn };
  } catch (error) {
    return whyNotStarted(address, error, held, session.signIn.discovery);
  }
}

/**
 * Finishes `signIn`, a sign-in to the app at `url`, with the `code` its authorization server sent the
 * browser back with, and who it says it is, `iss`, if it says: the sign-in with its tokens, or why
 * Ember couldn't get them.
 */
export async function finishSignIn(url: string, signIn: SignIn, code: string, iss: string | undefined, send: Send = fetch): Promise<SignedIn | AppRefused> {
  const address = new URL(url);
  const held: Held = { deadline: AbortSignal.timeout(READ_DEADLINE_MS), bytesLeft: MAX_READ_BYTES };
  const { discovery, client, codeVerifier, redirectUrl, resource } = signIn;
  if (!discovery || !client || !codeVerifier) return { error: `Ember couldn't finish the sign-in at ${address.host}. Start it again.` };
  try {
    const tokens = await exchangeAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata,
      clientInformation: client,
      authorizationCode: code,
      iss,
      codeVerifier,
      redirectUri: redirectUrl,
      resource,
      addClientAuthentication: provenAs(client),
      fetchFn: guarded(address, held, send).send,
    });
    const { codeVerifier: _, scopeAsked, ...kept } = signIn;
    return signedIn(kept, tokens, address, scopeAsked);
  } catch (error) {
    return whyNotFinished(address, error, held, signIn.ownClient === true);
  }
}

/**
 * Gets `signIn`, a sign-in to the app at `url`, another access token with the one it keeps for that:
 * the sign-in with its new tokens, "lapsed" once its authorization server won't give another, so that
 * an administrator has to sign in again, or "failed" when it couldn't be asked, or didn't answer, now.
 */
export async function refreshSignIn(url: string, signIn: SignIn, send: Send = fetch): Promise<SignedIn | "lapsed" | "failed"> {
  const address = new URL(url);
  const held: Held = { deadline: AbortSignal.timeout(READ_DEADLINE_MS), bytesLeft: MAX_READ_BYTES };
  const { discovery, client, tokens, resource } = signIn;
  if (!discovery || !client || !tokens?.refresh) return "lapsed";
  try {
    const fresh = await refreshAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata,
      clientInformation: client,
      refreshToken: tokens.refresh,
      resource,
      addClientAuthentication: provenAs(client),
      fetchFn: guarded(address, held, send).send,
    });
    const refreshed = signedIn(signIn, fresh, address);
    return "error" in refreshed ? "lapsed" : refreshed;
  } catch (error) {
    logged("Refreshing the sign-in to", address, error);
    return error instanceof OAuthError && LAPSED.has(error.code) ? "lapsed" : "failed";
  }
}

/**
 * Takes back what `signIn`, a sign-in to the app at `url`, gave Ember, at its authorization server,
 * as RFC 7009 has it: the token to get another with, which ends the sign-in there, and the access
 * token. Answers whether the service took each back, which it can't where it doesn't say how.
 */
export async function revokeSignIn(url: string, signIn: SignIn, send: Send = fetch): Promise<boolean> {
  const address = new URL(url);
  const held: Held = { deadline: AbortSignal.timeout(REVOKE_DEADLINE_MS), bytesLeft: MAX_READ_BYTES };
  const { discovery, client, tokens } = signIn;
  const metadata: Revocation | undefined = discovery?.authorizationServerMetadata;
  const endpoint = metadata?.revocation_endpoint;
  if (!metadata || !endpoint || !client || !tokens) return false;
  const guard = guarded(address, held, send);
  const methods = metadata.revocation_endpoint_auth_methods_supported ?? metadata.token_endpoint_auth_methods_supported ?? [];
  const revoke = async (token: string, hint: "refresh_token" | "access_token") => {
    const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" });
    const form = new URLSearchParams({ token, token_type_hint: hint });
    asClient(client, selectClientAuthMethod(client, methods), headers, form);
    const answer = await guard.send(endpoint, { method: "POST", headers, body: form, signal: held.deadline });
    await answer.body?.cancel();
    return answer.ok;
  };
  try {
    const revoked = tokens.refresh === null || (await revoke(tokens.refresh, "refresh_token"));
    return (await revoke(tokens.access, "access_token")) && revoked;
  } catch (error) {
    logged("Taking back the sign-in to", address, error);
    return false;
  }
}

/** What an authorization server's description says of taking tokens back, where it says: OpenID's own, as the protocol's client reads it, never does. */
interface Revocation {
  revocation_endpoint?: string;
  revocation_endpoint_auth_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

/**
 * Has a request to an authorization server say it's from `client`, by `method`: its secret in a header
 * or the form, or its ID alone. In the header, the ID and the secret are each percent-encoded first, as
 * RFC 6749 (2.3.1) has it, so that the service reads a `:`, `+` or `%` in either as it is, while the
 * letters, digits and `-_.~` most are made of go as they are.
 */
function asClient(client: StoredOAuthClientInformation, method: ReturnType<typeof selectClientAuthMethod>, headers: Headers, form: URLSearchParams): void {
  if (method === "client_secret_basic" && client.client_secret !== undefined) {
    return headers.set("Authorization", `Basic ${btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`)}`);
  }
  form.set("client_id", client.client_id);
  if (method === "client_secret_post" && client.client_secret !== undefined) form.set("client_secret", client.client_secret);
}

/**
 * What has the protocol's client say a request for tokens is from `client` as Ember's requests to take
 * them back do (`asClient`), by the method it would pick itself, of those the authorization server's
 * description lists.
 */
function provenAs(client: StoredOAuthClientInformation): AddClientAuthentication {
  return (headers, form, _url, metadata) => asClient(client, selectClientAuthMethod(client, metadata?.token_endpoint_auth_methods_supported ?? []), headers, form);
}

/** What an authorization server answers once a sign-in is over: the token to get another with is no good, or Ember isn't its client any more. */
const LAPSED: ReadonlySet<string> = new Set([OAuthErrorCode.InvalidGrant, OAuthErrorCode.InvalidClient, OAuthErrorCode.UnauthorizedClient]);

/**
 * `signIn` with the `tokens` its authorization server gave, or why Ember can't use them: it sends a
 * token only as a bearer's. An authorization server that doesn't say which scopes its tokens allow
 * has given what was asked for (RFC 6749, 5.1): `asked`, of a sign-in, or what the last tokens had.
 */
function signedIn(signIn: SignIn, tokens: OAuthTokens, address: URL, asked?: string): SignedIn | AppRefused {
  if (tokens.token_type.toLowerCase() !== "bearer") return { error: `${address.host} signs in with a kind of token Ember can't send.` };
  const refresh = tokens.refresh_token ?? null;
  const lasts = tokens.expires_in === undefined ? (refresh === null ? null : UNSAID_LIFETIME_MS) : tokens.expires_in * 1000;
  const kept: SignedIn = {
    ...signIn,
    tokens: { access: tokens.access_token, refresh, scope: tokens.scope ?? asked ?? signIn.tokens?.scope ?? null },
    expiresAt: lasts === null ? null : Date.now() + lasts,
  };
  return JSON.stringify(kept).length > MAX_SIGN_IN_LENGTH ? { error: saidTooMuch(address.host) } : kept;
}

/**
 * A sign-in under way, as the protocol's client asks for it and keeps it: nothing is kept but in
 * `signIn`, and the browser is sent nowhere, only where it would go is kept, `authorizationUrl`.
 */
class Session implements OAuthClientProvider {
  authorizationUrl: URL | null = null;

  constructor(
    readonly signIn: SignIn,
    readonly stateId: string,
  ) {}

  get redirectUrl() {
    return this.signIn.redirectUrl;
  }
  get clientMetadataUrl() {
    return this.signIn.clientUrl ?? undefined;
  }
  get clientMetadata() {
    return clientMetadataOf(this.signIn.redirectUrl);
  }
  state = () => this.stateId;
  // A client an administrator just gave is taken to be the authorization server's that was found for it, which the protocol's client then holds it to.
  clientInformation = () => {
    const { client, ownClient, discovery } = this.signIn;
    const issuer = discovery?.authorizationServerMetadata?.issuer ?? discovery?.authorizationServerUrl;
    if (client && ownClient && client.issuer === undefined && issuer !== undefined) this.signIn.client = { ...client, issuer: String(issuer) };
    return this.signIn.client;
  };
  // The client an administrator gave comes back as it is, marked with who it's known to. Any other is one Ember got itself, as it does once the one given turns out to be another service's.
  saveClientInformation = (client: StoredOAuthClientInformation) => {
    if (client.client_id !== this.signIn.client?.client_id) delete this.signIn.ownClient;
    this.signIn.client = client;
  };
  tokens = () => undefined;
  saveTokens = () => {};
  redirectToAuthorization = (authorizationUrl: URL) => void (this.authorizationUrl = authorizationUrl);
  saveCodeVerifier = (codeVerifier: string) => void (this.signIn.codeVerifier = codeVerifier);
  codeVerifier = () => this.signIn.codeVerifier ?? "";
  saveResourceUrl = (resource: string) => void (this.signIn.resource = resource);
  saveDiscoveryState = (discovery: OAuthDiscoveryState) => void (this.signIn.discovery = discovery);
  discoveryState = () => this.signIn.discovery;
}

/** The answer that stops asking a server once it has said what it asks of a sign-in. */
class Challenged extends Error {}

/**
 * What the server at `address` says of signing in when it's asked without one, in its 401's
 * WWW-Authenticate: where its sign-in is described, and the scope to ask for, each if it says.
 */
async function challengeOf(address: URL, send: Send, held: Held): Promise<ReturnType<typeof extractWWWAuthenticateParams>> {
  let challenge: ReturnType<typeof extractWWWAuthenticateParams> = {};
  const onUnauthorized = async ({ response }: { response: Response }) => {
    challenge = extractWWWAuthenticateParams(response);
    throw new Challenged();
  };
  const transport = new StreamableHTTPClientTransport(address, { fetch: send, requestInit: { redirect: "manual" }, authProvider: { token: async () => undefined, onUnauthorized } });
  const client = new Client({ name: "Ember", version: VERSION });
  try {
    await client.connect(transport, { signal: held.deadline });
  } catch (error) {
    if (!(error instanceof Challenged) && (held.deadline.aborted || held.bytesLeft < 0 || error instanceof GuardError)) throw error;
  } finally {
    await client.close().catch(() => {});
  }
  return challenge;
}

/** Whether Ember may ask `url` about a sign-in to the app at `address`: over https, or on this machine when the app is. */
const mayAsk = (url: URL, address: URL) => (isLoopback(url) ? isLoopback(address) && /^https?:$/.test(url.protocol) : url.protocol === "https:");

/** What asks about a sign-in: `send`, guarded, and `allows`, which throws a GuardError for an address a sign-in mustn't go to. */
interface Guard {
  send: Send;
  allows(url: URL): Promise<void>;
}

/**
 * `send`, held, for asking about a sign-in to the app at `address`, whose server names where: each
 * request goes only where Ember may ask (`mayAsk`), a name that resolves only to public addresses, and
 * a redirect comes back as it is. The protocol's client follows one that stays at its host, through this.
 */
function guarded(address: URL, held: Held, send: Send): Guard {
  const within = heldTo(held, send);
  const checked = new Map<string, Promise<void>>();
  const check = (host: string) => checkHost(host, (name) => resolveOverHttps(name, (request) => within(request)));
  const allows = async (url: URL) => {
    if (!mayAsk(url, address)) throw new GuardError(`A sign-in at ${url.protocol}//${url.host}`);
    if (isLoopback(url)) return;
    if (!checked.has(url.hostname)) checked.set(url.hostname, check(url.hostname));
    await checked.get(url.hostname);
  };
  return {
    allows,
    send: async (input, init) => {
      await allows(new URL(input instanceof Request ? input.url : input));
      return within(input, { ...init, redirect: "manual" });
    },
  };
}

/** Logs that doing `what` with the app at `address` failed, by the kind of failure alone: an authorization server writes what its answers say, which the client quotes in its errors. */
function logged(what: string, address: URL, error: unknown): void {
  const kind = error instanceof OAuthError ? `OAuthError ${error.code}` : error instanceof Error ? error.name : typeof error;
  console.error(`${what} the app at ${address.host} failed: ${kind}`);
}

/** Why Ember can't ask about a sign-in to the app at `address` any further, from what went wrong within what asking was held to, if that's why. */
function heldUp(address: URL, error: unknown, held: Held): AppRefused | null {
  const { host } = address;
  if (held.bytesLeft < 0) return { error: saidTooMuch(host), field: "url" };
  if (held.deadline.aborted) return { error: tookTooLong(host), field: "url" };
  if (error instanceof GuardError) return { error: `${host} sends its sign-in somewhere Ember doesn't ask: an address that isn't public, or isn't https.`, field: "url" };
  if (error instanceof IssuerMismatchError) return { error: `The sign-in ${host} names says it's another service's, so Ember won't use it.`, field: "url" };
  return null;
}

const noSignIn = (host: string): AppRefused => ({ error: `${host} doesn't say how to sign in to it. Give a token for it, if it has one.`, field: "token" });

/** Why Ember couldn't begin a sign-in to the app at `address`, from what went wrong, and what was `found` of its authorization server by then, if anything was. */
function whyNotStarted(address: URL, error: unknown, held: Held, found: OAuthDiscoveryState | undefined): AppRefused {
  const { host } = address;
  logged("Starting a sign-in to", address, error);
  const stopped = heldUp(address, error, held);
  if (stopped) return stopped;
  if (found && !found.authorizationServerMetadata) return noSignIn(host);
  const said = error instanceof Error ? error.message : "";
  if (said.includes("does not match expected")) return { error: `The sign-in ${host} describes is for another address than its own, so Ember won't use it.`, field: "url" };
  if (error instanceof RegistrationRejectedError || said.includes("dynamic client registration")) {
    return { error: `${host} has a sign-in, but doesn't let Ember register itself for it. Register Ember there yourself and give its client ID, or give a token, if it has one.`, field: "token", client: true };
  }
  return { error: `Ember couldn't start a sign-in at ${host}. Give a token for it, if it has one.`, field: "token" };
}

/** Why Ember couldn't finish a sign-in to the app at `address`, from what went wrong, which is the client it signed in as when an administrator gave it, `ownClient`, and the service won't have it. */
function whyNotFinished(address: URL, error: unknown, held: Held, ownClient: boolean): AppRefused {
  logged("Finishing a sign-in to", address, error);
  const stopped = heldUp(address, error, held);
  if (stopped) return stopped;
  if (ownClient && error instanceof OAuthError && error.code === OAuthErrorCode.InvalidClient) {
    return { error: `${address.host} didn't take the client ID or secret Ember signed in with. Check both, and start the sign-in again.` };
  }
  return { error: `${address.host} didn't finish the sign-in. Start it again.` };
}
