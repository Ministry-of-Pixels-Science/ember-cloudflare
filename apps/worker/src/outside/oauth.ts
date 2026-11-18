import {
  MAX_OUTSIDE_ADDRESS_LENGTH,
  MAX_OUTSIDE_NAME_LENGTH,
  MCP_PATH,
  OUTSIDE_AUTHORIZE_PATH,
  OUTSIDE_SCOPES,
  outsideScopesOf,
  type OutsideAsk,
} from "@ember/protocol/outside";
import { heldTo, type Held, type Send } from "../apps/mcp";
import { toBase64url } from "../encoding";
import { isLoopback } from "../loopback";
import { checkHost, resolveOverHttps } from "../unfurl/guard";
import type { OutsideClient } from "./store";

// Ember as an OAuth authorization server for the AI apps that connect to it, as the Model Context
// Protocol has one sign an app in (https://modelcontextprotocol.io/specification/draft/basic/authorization):
// what it says of itself, which apps it takes, and what a request to connect has to carry. The apps
// are public clients, with no secret, so each proves with PKCE that it's the one that began.

export const OUTSIDE_TOKEN_PATH = "/oauth/token";
export const OUTSIDE_REGISTER_PATH = "/oauth/register";
export const OUTSIDE_REVOKE_PATH = "/oauth/revoke";
/** Where Ember says what signs apps in to `/mcp` (RFC 9728), at the root and with the path of what it protects after it. */
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
/** Where Ember says how it signs apps in (RFC 8414). */
export const SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/** How long a code lasts, which an app exchanges at once. */
export const CODE_TTL_MS = 5 * 60_000;
/** How long an access token lasts, after which the app asks for the next with its refresh token. */
export const ACCESS_TTL_SECONDS = 3600;
/** How long a refresh token lasts unused: each one an app uses gives it another that lasts as long. */
export const REFRESH_TTL_MS = 90 * 24 * 3600_000;

/** The most addresses an app may have browsers sent back to, of those it gives, and the most Ember reads of a document about one. */
export const MAX_REDIRECT_URIS = 10;
export const MAX_CLIENT_DOCUMENT_BYTES = 64_000;
export const CLIENT_DOCUMENT_DEADLINE_MS = 5_000;
/** The longest `state` Ember sends back as it came. */
const MAX_STATE_LENGTH = 2048;

/** The address apps connect to at `origin`, which is what their tokens are good for. */
export const resourceAt = (origin: string) => `${origin}${MCP_PATH}`;

/** What Ember says signs apps in to `/mcp` at `origin`, for the workspace called `name`. */
export const resourceMetadata = (origin: string, name: string) => ({
  resource: resourceAt(origin),
  authorization_servers: [origin],
  scopes_supported: [...OUTSIDE_SCOPES],
  bearer_methods_supported: ["header"],
  resource_name: name,
});

/** How Ember says it signs apps in, at `origin`. */
export const serverMetadata = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}${OUTSIDE_AUTHORIZE_PATH}`,
  token_endpoint: `${origin}${OUTSIDE_TOKEN_PATH}`,
  registration_endpoint: `${origin}${OUTSIDE_REGISTER_PATH}`,
  revocation_endpoint: `${origin}${OUTSIDE_REVOKE_PATH}`,
  scopes_supported: [...OUTSIDE_SCOPES],
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  authorization_response_iss_parameter_supported: true,
  client_id_metadata_document_supported: true,
});

/**
 * Whether an app may have a browser sent back to `address`: over https, or over http to this computer,
 * where an app that runs on it listens. Nothing else, so that what the page sends a browser to is
 * never a script.
 */
export function isRedirectAllowed(address: string): boolean {
  if (address.length > MAX_OUTSIDE_ADDRESS_LENGTH || address.includes("#")) return false;
  const url = URL.parse(address);
  if (!url || url.username !== "" || url.password !== "") return false;
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url));
}

const isLocal = (url: URL | null): url is URL => url !== null && url.protocol === "http:" && isLoopback(url);
const withoutPort = (url: URL) => `${url.hostname}${url.pathname}${url.search}`;

/** Whether `kept` is `url`, an address on this computer, at whatever port. */
function isSameButPort(kept: string, url: URL): boolean {
  const other = URL.parse(kept);
  return isLocal(other) && withoutPort(other) === withoutPort(url);
}

/**
 * Whether an app that may have browsers sent back to `registered` may to `asked`: one of them exactly,
 * or, on this computer, at any port, since an app there listens on whichever is free (RFC 8252).
 */
export function sendsBackTo(registered: readonly string[], asked: string): boolean {
  if (!isRedirectAllowed(asked)) return false;
  if (registered.includes(asked)) return true;
  const url = URL.parse(asked);
  return isLocal(url) && registered.some((kept) => isSameButPort(kept, url));
}

/** Whether `challenge` is a PKCE challenge made with S256: a SHA-256 digest, in base64url. */
const isChallenge = (challenge: string) => /^[A-Za-z0-9_-]{43}$/.test(challenge);

/** Whether `verifier` is what `challenge` was made from, which only the app that began has. */
export async function provesChallenge(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64url(new Uint8Array(digest)).replace(/=+$/, "") === challenge;
}

/** Whether `resource` could be where an app connects to an Ember: an address ending in `/mcp`. Whether it's this one is checked where its token is used. */
export function isResource(resource: string): boolean {
  if (resource.length > MAX_OUTSIDE_ADDRESS_LENGTH) return false;
  const url = URL.parse(resource);
  return url !== null && url.pathname === MCP_PATH && url.search === "" && !resource.includes("#") && (url.protocol === "https:" || isLocal(url));
}

/** A request to connect that's made the way Ember takes them, with what it asks for. */
export interface ValidAsk {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  resource: string | null;
}

/** `ask` as Ember takes it, or null for one it doesn't: without a code to ask for, an app, somewhere to go back to, or an S256 challenge. */
export function validAsk(ask: OutsideAsk): ValidAsk | null {
  const { responseType, clientId, redirectUri, state, codeChallenge, codeChallengeMethod, scope, resource } = ask;
  if (responseType !== "code" || !clientId || clientId.length > MAX_OUTSIDE_ADDRESS_LENGTH) return null;
  if (!redirectUri || !isRedirectAllowed(redirectUri)) return null;
  if (!codeChallenge || !isChallenge(codeChallenge) || codeChallengeMethod !== "S256") return null;
  if (state !== null && state.length > MAX_STATE_LENGTH) return null;
  if (resource !== null && !isResource(resource)) return null;
  return { clientId, redirectUri, state, codeChallenge, scope: outsideScopesOf(scope).join(" "), resource };
}

/** Where the page sends the browser back for `ask`, with `answer`: a code, or why there's none, and the state it came with, from the Ember at `issuer`. */
export function wayBack(ask: Pick<ValidAsk, "redirectUri" | "state">, answer: { code: string } | { error: string }, issuer: string): string {
  const back = new URL(ask.redirectUri);
  for (const [name, value] of Object.entries(answer)) back.searchParams.set(name, value);
  if (ask.state !== null) back.searchParams.set("state", ask.state);
  back.searchParams.set("iss", issuer);
  return back.href;
}

/** A registration Ember refuses, as RFC 7591 says why. */
export interface RegistrationRefused {
  error: "invalid_redirect_uri" | "invalid_client_metadata";
  error_description: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The name an app gives itself, cut to what Ember keeps, or the host it has browsers sent back to when it gives none. */
function nameOf(given: unknown, redirectUris: readonly string[]): string {
  const name = typeof given === "string" ? given.trim().slice(0, MAX_OUTSIDE_NAME_LENGTH).trim() : "";
  return name || new URL(redirectUris[0]!).host;
}

/** The app `body` registers, as an app's own registration gives it (RFC 7591), or why Ember won't take it. */
export function registrationOf(body: unknown): Omit<OutsideClient, "id"> | RegistrationRefused {
  if (!isObject(body)) return { error: "invalid_client_metadata", error_description: "The registration must be a JSON object." };
  const { redirect_uris: redirectUris, client_name: name } = body;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS)
    return { error: "invalid_redirect_uri", error_description: `Give between 1 and ${MAX_REDIRECT_URIS} redirect_uris.` };
  if (!redirectUris.every((address): address is string => typeof address === "string" && isRedirectAllowed(address)))
    return { error: "invalid_redirect_uri", error_description: "Each of redirect_uris must be an https address, or an http one on localhost, without a fragment." };
  return { name: nameOf(name, redirectUris), redirectUris };
}

/** Whether `clientId` is the address of a document about an app, rather than an id Ember gave: an https address with a path, or one on this computer, by http too, only when Ember is `here` on it as well. */
export function isClientDocumentAddress(clientId: string, here: URL): boolean {
  const url = URL.parse(clientId);
  if (!url || url.pathname === "/" || url.username !== "" || url.password !== "" || clientId.includes("#")) return false;
  // `clientDocumentAt` reads an address on this computer without checking where it leads, which only an Ember on it may.
  if (isLoopback(url)) return isLoopback(here) && (url.protocol === "https:" || url.protocol === "http:");
  return url.protocol === "https:";
}

/**
 * The app the document at `address` is about, which is its id (a Client ID Metadata Document), or null
 * when Ember can't read one there: the document has to say it's at that address, and where the app
 * has browsers sent back. It's read from a public address alone, within a deadline and a size.
 */
export async function clientDocumentAt(address: string, send: Send = fetch): Promise<OutsideClient | null> {
  const url = new URL(address);
  const held: Held = { deadline: AbortSignal.timeout(CLIENT_DOCUMENT_DEADLINE_MS), bytesLeft: MAX_CLIENT_DOCUMENT_BYTES };
  const within = heldTo(held, send);
  try {
    if (!isLoopback(url)) await checkHost(url.hostname, (host) => resolveOverHttps(host, (request) => within(request)));
    const response = await within(url, { redirect: "manual", headers: { Accept: "application/json" } });
    if (response.status !== 200) return null;
    const document: unknown = JSON.parse(await response.text());
    if (!isObject(document) || document.client_id !== address || !Array.isArray(document.redirect_uris)) return null;
    const redirectUris = document.redirect_uris.filter((kept): kept is string => typeof kept === "string" && isRedirectAllowed(kept));
    return redirectUris.length === 0 ? null : { id: address, name: nameOf(document.client_name, redirectUris), redirectUris };
  } catch {
    return null;
  }
}
