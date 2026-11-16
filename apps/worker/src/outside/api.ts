import {
  MCP_PATH,
  OUTSIDE_ASK_REFUSED,
  OUTSIDE_CONNECTION_GONE,
  OUTSIDE_FORBIDDEN,
  OUTSIDE_FULL,
  OUTSIDE_GUEST,
  OUTSIDE_OFF,
  grantedOutsideScopes,
  OUTSIDE_SCOPES,
  outsideScopesOf,
  type OutsideAiSettings,
  type OutsideAnswered,
  type OutsideAsk,
  type OutsideAsked,
  type YourOutsideAi,
} from "@ember/protocol/outside";
import { clientOf, credentialsOf, newSessionToken, tokenDigest } from "../auth";
import { bodyUpTo, jsonBodyOf } from "../bodies";
import type { Env } from "../env";
import { notFound as pageNotFound } from "../error-pages";
import { anyOtherPage } from "../pages";
import { urlOf } from "../request-url";
import { workspace } from "../workspace";
import { outsideAi } from "./endpoint";
import {
  ACCESS_TTL_SECONDS,
  clientDocumentAt,
  isClientDocumentAddress,
  isResource,
  OUTSIDE_REGISTER_PATH,
  OUTSIDE_REVOKE_PATH,
  OUTSIDE_TOKEN_PATH,
  registrationOf,
  RESOURCE_METADATA_PATH,
  resourceAt,
  resourceMetadata,
  sendsBackTo,
  SERVER_METADATA_PATH,
  serverMetadata,
  validAsk,
  wayBack,
  type ValidAsk,
} from "./oauth";
import type { OutsideClient } from "./store";

// What the Worker answers the AI apps that connect to Ember, and the pages that have to do with them.
// An app's own requests carry no cookie: finding out how to sign in, registering, exchanging a code
// for tokens and asking `/mcp` with one. They're answered to any origin, since some apps run in a
// browser, and none of them answers while outside AI is off, nor does the page that asks a person
// whether to connect an app. What that page asks, their profile and the administrator's switch go by
// the person's session, as the rest of the API does.

const NOT_SIGNED_IN = "Not signed in";
const PRIVATE = { "Cache-Control": "no-store" };
/** Any origin may read what an app's own requests answer: they carry a token, or nothing, never a cookie. */
const ANY_ORIGIN = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "WWW-Authenticate" };
/** The longest form an app posts for tokens. */
const MAX_FORM_BYTES = 16_384;

const problem = (status: number, message: string) => Response.json({ error: message }, { status, headers: PRIVATE });
const notFound = () => Response.json({ error: "Not found" }, { status: 404, headers: { ...ANY_ORIGIN, ...PRIVATE } });

/** What a request OAuth refuses answers, as RFC 6749 has it: a code for the app, and why in words. */
const oauthError = (error: string, description: string, status = 400) =>
  Response.json({ error, error_description: description }, { status, headers: { ...ANY_ORIGIN, ...PRIVATE } });

/** What a browser's question before a request from another origin answers: that `methods` are taken, with the headers it asks to send. */
const preflight = (request: Request, methods: string) =>
  new Response(null, {
    status: 204,
    headers: {
      ...ANY_ORIGIN,
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") ?? "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });

/** `respond`, for a request made with `method`, or what any other method answers. */
function taking(request: Request, method: "GET" | "POST", respond: () => Promise<Response>): Promise<Response> {
  if (request.method === "OPTIONS") return Promise.resolve(preflight(request, method));
  if (request.method === method || (method === "GET" && request.method === "HEAD")) return respond();
  return Promise.resolve(new Response(null, { status: 405, headers: { ...ANY_ORIGIN, Allow: `${method}, OPTIONS` } }));
}

/**
 * What answers an AI app's own request at `pathname`, if that's one of the addresses apps ask: `/mcp`,
 * the two documents that say how to sign in to it, and registering, tokens and revoking. While outside
 * AI is off, each answers 404, whatever it's asked and however.
 */
export function outsideAction(request: Request, env: Env, pathname: string): (() => Promise<Response>) | null {
  const action = appAction(request, env, pathname);
  return action && (async () => ((await workspace(env).outsideAi()) ? action() : notFound()));
}

function appAction(request: Request, env: Env, pathname: string): (() => Promise<Response>) | null {
  if (pathname === MCP_PATH) return () => answerApp(request, env);
  if (pathname === RESOURCE_METADATA_PATH || pathname === `${RESOURCE_METADATA_PATH}${MCP_PATH}`)
    return () => taking(request, "GET", () => described(request, env, resourceMetadata));
  if (pathname === SERVER_METADATA_PATH) return () => taking(request, "GET", () => described(request, env, serverMetadata));
  if (pathname === OUTSIDE_REGISTER_PATH) return () => taking(request, "POST", () => registerApp(request, env));
  if (pathname === OUTSIDE_TOKEN_PATH) return () => taking(request, "POST", () => giveTokens(request, env));
  if (pathname === OUTSIDE_REVOKE_PATH) return () => taking(request, "POST", () => revokeToken(request, env));
  return null;
}

/** `GET /oauth/authorize`: the app's page that asks a person whether to connect an AI app, which isn't there while outside AI is off. */
export async function outsideConnectPage(request: Request, env: Env, pathname: string): Promise<Response> {
  return (await workspace(env).outsideAi()) ? anyOtherPage(request, env, pathname) : pageNotFound(request);
}

/** Whether `pathname` is where AI apps register themselves, which a banned IP address can't. */
export const isOutsideRegistration = (pathname: string) => pathname === OUTSIDE_REGISTER_PATH;

/** One of the documents that say how to sign in to this Ember, at the address it was asked at. */
async function described(request: Request, env: Env, document: (origin: string, name: string) => unknown): Promise<Response> {
  const on = await workspace(env).outsideAi();
  return on ? Response.json(document(urlOf(request).origin, on.name), { headers: { ...ANY_ORIGIN, ...PRIVATE } }) : notFound();
}

/** `POST /oauth/register`: keeps an app that registers itself (RFC 7591), answering the id it's given. */
async function registerApp(request: Request, env: Env): Promise<Response> {
  const registration = registrationOf(await jsonBodyOf(request));
  if ("error" in registration) return oauthError(registration.error, registration.error_description);
  const registered = await workspace(env).registerOutsideClient(registration, clientOf(request).ip);
  if (registered === "off") return notFound();
  if (registered === "limited") return oauthError("too_many_requests", "Too many apps have registered from this address. Try again in an hour.", 429);
  if (registered === "full") return oauthError("temporarily_unavailable", "Ember has as many apps registered as it keeps. Try again later.", 503);
  const client = {
    client_id: registered.id,
    client_name: registered.name,
    redirect_uris: registered.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
  return Response.json(client, { status: 201, headers: { ...ANY_ORIGIN, ...PRIVATE } });
}

/** The fields of the form an app posts, or null for a body that's too long. */
async function formOf(request: Request): Promise<URLSearchParams | null> {
  const body = await bodyUpTo(request, MAX_FORM_BYTES).catch(() => "");
  return body === null ? null : new URLSearchParams(body);
}

/** Tokens Ember is about to give an app, with the digests it keeps of them. */
async function newTokens(env: Env): Promise<{ access: string; refresh: string; next: { accessDigest: string; refreshDigest: string } }> {
  const [access, refresh] = [newSessionToken(), newSessionToken()];
  const [accessDigest, refreshDigest] = await Promise.all([tokenDigest(access, env.SESSION_SECRET), tokenDigest(refresh, env.SESSION_SECRET)]);
  return { access, refresh, next: { accessDigest, refreshDigest } };
}

/** `POST /oauth/token`: gives an app its tokens for the code it was sent back with, or its next ones for its refresh token, which that replaces. */
async function giveTokens(request: Request, env: Env): Promise<Response> {
  const form = await formOf(request);
  const [grant, clientId] = [form?.get("grant_type"), form?.get("client_id")];
  if (!form || !clientId) return oauthError("invalid_request", "The request must be a form with a client_id.");
  if (grant !== "authorization_code" && grant !== "refresh_token") return oauthError("unsupported_grant_type", "Ember gives tokens for an authorization_code or a refresh_token.");
  const presented = form.get(grant === "authorization_code" ? "code" : "refresh_token");
  const verifier = form.get("code_verifier");
  if (!presented || (grant === "authorization_code" && !verifier)) return oauthError("invalid_request", "The request is missing what its grant_type takes.");
  const resource = form.get("resource");
  if (resource !== null && !isResource(resource)) return oauthError("invalid_target", "The resource must be the address the app connects to Ember at.");
  const [digest, tokens] = await Promise.all([tokenDigest(presented, env.SESSION_SECRET), newTokens(env)]);
  const given =
    grant === "authorization_code"
      ? await workspace(env).exchangeOutsideCode(digest, { clientId, redirectUri: form.get("redirect_uri"), verifier: verifier!, resource }, tokens.next)
      : await workspace(env).refreshOutside(digest, clientId, tokens.next);
  if (given === "off") return notFound();
  if (!given) return oauthError("invalid_grant", grant === "authorization_code" ? "The code is no good. Start connecting again." : "The refresh token is no good. Connect again.");
  const answer = { access_token: tokens.access, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: tokens.refresh, scope: given.scope };
  return Response.json(answer, { headers: { ...ANY_ORIGIN, ...PRIVATE, Pragma: "no-cache" } });
}

/** `POST /oauth/revoke`: ends the connection a token is of (RFC 7009), answering 200 whether there was one or not. */
async function revokeToken(request: Request, env: Env): Promise<Response> {
  const form = await formOf(request);
  const [token, clientId] = [form?.get("token"), form?.get("client_id")];
  if (!token || !clientId) return oauthError("invalid_request", "The request must be a form with a token and a client_id.");
  await workspace(env).revokeOutside(await tokenDigest(token, env.SESSION_SECRET), clientId);
  return new Response(null, { status: 200, headers: { ...ANY_ORIGIN, ...PRIVATE } });
}

/** The token a request's Authorization header carries as a bearer's, or null. */
function bearerOf(request: Request): string | null {
  const [scheme, token, ...rest] = (request.headers.get("Authorization") ?? "").trim().split(/\s+/);
  return scheme?.toLowerCase() === "bearer" && token && rest.length === 0 ? token : null;
}

/** What a request to `/mcp` without a good token answers: where to find out how to sign in, and what to ask for (RFC 9728). */
function unauthorized(request: Request, presented: boolean): Response {
  const { origin } = urlOf(request);
  const challenge = [
    `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}${MCP_PATH}"`,
    `scope="${OUTSIDE_SCOPES.join(" ")}"`,
    ...(presented ? [`error="invalid_token"`, `error_description="The token is no good. Connect again."`] : []),
  ].join(", ");
  return Response.json({ error: "Connect to Ember to ask it." }, { status: 401, headers: { ...ANY_ORIGIN, ...PRIVATE, "WWW-Authenticate": challenge } });
}

/** `/mcp`: what a connected AI app asks Ember, over the Model Context Protocol, with its access token. */
async function answerApp(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return preflight(request, "GET, POST, DELETE");
  const token = bearerOf(request);
  const access = token === null ? null : await workspace(env).outsideAccess(await tokenDigest(token, env.SESSION_SECRET));
  if (access === "off") return notFound();
  // A token is good only where its app said it would use it.
  if (!access || (access.resource !== null && access.resource !== resourceAt(urlOf(request).origin))) return unauthorized(request, token !== null);
  const answer = await outsideAi(env).answer(request, access);
  const response = new Response(answer.body, answer);
  for (const [name, value] of Object.entries({ ...ANY_ORIGIN, ...PRIVATE })) response.headers.set(name, value);
  return response;
}

/** The app that makes `ask`, if Ember knows it and it may have a browser sent back where `ask` says: one that registered, or one whose id is the address of a document about it. */
async function appAsking(ask: ValidAsk, here: URL, env: Env): Promise<OutsideClient | "off" | null> {
  const client = isClientDocumentAddress(ask.clientId, here) ? await clientDocumentAt(ask.clientId) : await workspace(env).outsideClient(ask.clientId);
  if (!client || client === "off") return client;
  return sendsBackTo(client.redirectUris, ask.redirectUri) ? client : null;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const textOrNull = (value: unknown) => (typeof value === "string" ? value : null);

/** The request to connect `body` carries, as the page read it from its address, each field text or null. */
function askOf(body: unknown): OutsideAsk | null {
  if (!isObject(body)) return null;
  return {
    responseType: textOrNull(body.responseType),
    clientId: textOrNull(body.clientId),
    redirectUri: textOrNull(body.redirectUri),
    state: textOrNull(body.state),
    codeChallenge: textOrNull(body.codeChallenge),
    codeChallengeMethod: textOrNull(body.codeChallengeMethod),
    scope: textOrNull(body.scope),
    resource: textOrNull(body.resource),
  };
}

/** The answer `body` carries to a request to connect, with what of the request it leaves out, or null when it carries none. */
function answerOf(body: unknown): { ask: OutsideAsk | null; allow: boolean; without: unknown[] } | null {
  if (!isObject(body) || typeof body.allow !== "boolean") return null;
  return { ask: askOf(body.ask), allow: body.allow, without: Array.isArray(body.without) ? body.without : [] };
}

/** Why a request about connecting an AI app isn't done, for the person asking. */
function refused(why: "off" | "forbidden" | null): Response {
  if (why === null) return problem(401, NOT_SIGNED_IN);
  return why === "off" ? problem(409, OUTSIDE_OFF) : problem(403, OUTSIDE_GUEST);
}

/** `ask` as Ember takes it, with the app that makes it, or what refuses it. */
async function asked(request: Request, env: Env, ask: OutsideAsk | null): Promise<{ ask: ValidAsk; client: OutsideClient } | Response> {
  const valid = ask && validAsk(ask);
  const client = valid && (await appAsking(valid, urlOf(request), env));
  if (client === "off") return refused("off");
  return valid && client ? { ask: valid, client } : problem(422, OUTSIDE_ASK_REFUSED);
}

/** `POST /api/outside/asks`: what the page says of a request to connect an AI app as you, before you answer it. */
export async function describeOutsideAsk(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const asker = credentials && (await workspace(env).outsideAsker(credentials));
  if (!asker || typeof asker === "string") return refused(asker);
  const made = await asked(request, env, askOf(await jsonBodyOf(request)));
  if (made instanceof Response) return made;
  const described: OutsideAsked = { name: made.client.name, comesBackTo: new URL(made.ask.redirectUri).host, workspace: asker.workspace, scopes: outsideScopesOf(made.ask.scope) };
  return Response.json(described, { headers: PRIVATE });
}

/**
 * `POST /api/outside/answers`: your answer to a request to connect an AI app as you, answering where
 * the page sends your browser: back to the app, with a code it exchanges for its tokens when you
 * allowed it, or saying you didn't.
 */
export async function answerOutsideAsk(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return refused(null);
  const asker = await workspace(env).outsideAsker(credentials);
  if (!asker || typeof asker === "string") return refused(asker);
  const answer = answerOf(await jsonBodyOf(request));
  const made = await asked(request, env, answer?.ask ?? null);
  if (made instanceof Response) return made;
  const { ask, client } = made;
  // Who sends the browser back is this Ember, at the address its documents gave the app (RFC 9207), whatever the request says it's for.
  const issuer = urlOf(request).origin;
  if (!answer?.allow) return Response.json({ redirectTo: wayBack(ask, { error: "access_denied" }, issuer) } satisfies OutsideAnswered, { headers: PRIVATE });
  const code = newSessionToken();
  const scope = grantedOutsideScopes(outsideScopesOf(ask.scope), answer.without).join(" ");
  const begun = { clientId: client.id, clientName: client.name, redirectUri: ask.redirectUri, scope, resource: ask.resource, codeDigest: await tokenDigest(code, env.SESSION_SECRET), codeChallenge: ask.codeChallenge };
  const connected = await workspace(env).connectOutside(credentials, begun);
  if (connected === "full") return problem(409, OUTSIDE_FULL);
  if (connected !== true) return refused(connected);
  return Response.json({ redirectTo: wayBack(ask, { code }, issuer) } satisfies OutsideAnswered, { headers: PRIVATE });
}


/** `DELETE /api/users/me/outside/:id`: ends the connection `id` of yours, answering the ones you have left. */
export async function disconnectOutside(request: Request, env: Env, id: string): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const connections = credentials && (await workspace(env).disconnectOutside(credentials, id));
  if (connections === "not found") return problem(404, OUTSIDE_CONNECTION_GONE);
  return connections && typeof connections !== "string" ? Response.json({ connections } satisfies YourOutsideAi, { headers: PRIVATE }) : refused(connections);
}

/** `PUT /api/account/outside_ai`: lets AI apps connect, or stops them, which ends every connection, for administrators. */
export async function changeOutsideAi(request: Request, env: Env): Promise<Response> {
  const body = await jsonBodyOf(request);
  if (!isObject(body) || typeof body.on !== "boolean") return problem(422, "Say whether AI apps may connect");
  const credentials = await credentialsOf(request, env);
  const settings = credentials && (await workspace(env).changeOutsideAi(credentials, body.on));
  if (settings === null) return problem(401, NOT_SIGNED_IN);
  return settings === "forbidden" ? problem(403, OUTSIDE_FORBIDDEN) : Response.json(settings satisfies OutsideAiSettings, { headers: PRIVATE });
}
