import {
  APP_CHANGED,
  APP_SIGN_IN_ENDED,
  APP_SIGNED_IN,
  APPS_FORBIDDEN,
  APPS_FULL,
  TOOL_GONE,
  YOUR_APP_GONE,
  YOUR_APPS_FORBIDDEN,
  parseAppChanges,
  parseAppClient,
  parseAppSignInReturn,
  parseNewApp,
  parseToolPicks,
  type AgentTools,
  type App,
  type AppAnswer,
  type AppClient,
  type AppId,
  type AppRefused,
  type AppRemoved,
  type Apps,
  type AppSignedIn,
  type AppSignInBegun,
  type OfferedApp,
  type YourAppSignedIn,
  type YourAppSignedOut,
} from "@ember/protocol/apps";
import { APP_SIGNED_IN_PATH, type UserId } from "@ember/protocol";
import { ASSISTANT_OFF } from "@ember/protocol/assistant";
import { administratorOf } from "../assistant/settings";
import { credentialsOf } from "../auth";
import { jsonBodyOf } from "../bodies";
import type { Env } from "../env";
import { notFound } from "../error-pages";
import { anyOtherPage, formAnswer } from "../pages";
import { urlOf } from "../request-url";
import { workspace, type BegunAppSignIn, type Credentials } from "../workspace";
import { appConnector } from "./connector";
import type { ReadApp } from "./mcp";
import { CLIENT_DOCUMENT_PATH, clientMetadataOf } from "./oauth";
import { hasEnded, signInEnded } from "./tools";

// Apps, as administrators connect, change and disconnect them on the AI assistant tab of workspace
// settings: MCP servers, each with the tools Ember read from it, which the AI agents may be given. They
// answer JSON for the tab and each app's page. An app whose server asks for a sign-in is connected by
// one: the administrator's browser goes to its authorization server and comes back to the app with a
// code, which the app sends here to finish. Anyone but a guest can sign in to such an app themselves,
// from their profile, the same way: what an agent then does with it in their direct conversation with
// it, it does as them.

const problem = (status: number, message: string) => Response.json({ error: message }, { status });

const NOT_SIGNED_IN = "Not signed in";
/** What's said of apps is for administrators, which no cache should keep. */
const PRIVATE = { "Cache-Control": "no-store" };

/**
 * An app's page, `/account/apps/<id>/edit`: Campfire's 404 page for an administrator when `id` isn't a
 * connected app's, and otherwise the app's page, which sends anyone signed out to sign in, anyone else
 * to workspace settings, and anyone while Ember AI is off to the AI assistant tab.
 */
export async function appPage(request: Request, env: Env, pathname: string, appId: AppId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const found = credentials && (await workspace(env).connectedApp(credentials, appId));
  return found === "not found" ? notFound(request) : anyOtherPage(request, env, pathname);
}

/** `GET /api/account/apps`: the connected apps, by name, as the AI assistant tab lists them while Ember AI is on. */
export async function listApps(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const apps = credentials && (await workspace(env).connectedApps(credentials));
  if (!apps || typeof apps === "string") return refused(apps);
  return Response.json({ apps } satisfies Apps, { headers: PRIVATE });
}

/** `GET /api/account/apps/:id`: the connected app `id`, as its page shows it. */
export async function showApp(request: Request, env: Env, appId: AppId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return appAnswer(credentials && (await workspace(env).connectedApp(credentials, appId)));
}

/**
 * `POST /api/account/apps`, `{ name, url, token? }`: connects the MCP server at `url`, once Ember has
 * read its tools there, with the token, if one's given, answering 201 with the app as its page shows
 * it. Someone who isn't an administrator hears so before anything they sent is read, and Ember AI being
 * off, or as many apps as there can be, is refused before the server is asked. A field that can't be
 * what it's for, or that the server refuses, is refused on that field.
 */
export async function connectApp(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env, APPS_FORBIDDEN);
  if (credentials instanceof Response) return credentials;
  const app = parseNewApp(await jsonBodyOf(request));
  if ("error" in app) return formAnswer(app, 422);
  const ember = workspace(env);
  const slot = await ember.appSlot(credentials);
  if (slot !== true) return refused(slot);
  const read = await appConnector(env).read(app.url, app.token === undefined ? null : { token: app.token });
  if ("error" in read) return formAnswer(read, 422);
  return appAnswer(await ember.connectApp(credentials, app, read), 201);
}

/**
 * `POST /api/account/app-sign-ins`, `{ name, url, clientId?, clientSecret? }`: begins a sign-in to the
 * MCP server at `url`, to connect it by, answering where to send the browser, `{ authorizationUrl }`,
 * which comes back to `/account/apps/signed-in`. Ember signs in as the client given, if one is, for a
 * service that doesn't come to know Ember by itself. It's refused as connecting an app is, and when the
 * server has no sign-in Ember can use, on the field that's about, saying so when a client ID would do.
 */
export async function beginNewAppSignIn(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env, APPS_FORBIDDEN);
  if (credentials instanceof Response) return credentials;
  const body = await jsonBodyOf(request);
  const app = parseNewApp(body);
  if ("error" in app) return formAnswer(app, 422);
  const client = parseAppClient(body);
  if ("error" in client) return formAnswer(client, 422);
  const slot = await workspace(env).appSlot(credentials);
  if (slot !== true) return refused(slot);
  return begunSignIn(request, env, credentials, { appId: null, name: app.name, url: app.url }, clientGiven(client, null), null, false);
}

/**
 * `POST /api/account/apps/:id/sign-in`, with `{ clientId?, clientSecret? }` or nothing: begins a sign-in
 * to the server of the connected app `id`, in place of the one it has, or of its token, answering as
 * `beginNewAppSignIn` does, or with 422 and why its server has no sign-in Ember can use. Ember signs
 * in as the client the app last signed in as, when an administrator gave one, unless another is given,
 * or "" for none.
 */
export async function beginAppSignIn(request: Request, env: Env, appId: AppId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const target = credentials && (await workspace(env).appSignInTarget(credentials, appId));
  if (!credentials || !target) return refused(null);
  if (typeof target === "string") return refused(target);
  const client = parseAppClient((await jsonBodyOf(request)) ?? {});
  if ("error" in client) return formAnswer(client, 422);
  return begunSignIn(request, env, credentials, { appId, name: target.name, url: target.url }, clientGiven(client, target.client), target.scope, false);
}

/**
 * `POST /api/users/me/apps/:id/sign-in`: begins a sign-in you make yourself to the server of the
 * connected app `id`, one Ember signs in to, answering as `beginAppSignIn` does: as the client Ember
 * signed in as, asking for what your last sign-in to it had and what its server has asked for since.
 * A guest is refused, and so is anyone while Ember AI is off, or for an app that isn't one Ember signs
 * in to.
 */
export async function beginOwnAppSignIn(request: Request, env: Env, appId: AppId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const target = credentials && (await workspace(env).ownAppSignInTarget(credentials, appId));
  if (!credentials || !target) return refused(null);
  if (typeof target === "string") return refusedYou(target);
  return begunSignIn(request, env, credentials, { appId, name: target.name, url: target.url }, target.client, target.scope, true);
}

/**
 * `DELETE /api/users/me/apps/:id/sign-in`: forgets the sign-in you made to the connected app `id`
 * yourself, and has its service take it back, answering the apps as your profile then lists them and
 * whether the service did.
 */
export async function signOutOfApp(request: Request, env: Env, appId: AppId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const signedOut = credentials && (await workspace(env).signOutOfApp(credentials, appId));
  if (!signedOut || typeof signedOut === "string") return refusedYou(signedOut);
  return Response.json(signedOut satisfies YourAppSignedOut, { headers: PRIVATE });
}

/**
 * Who Ember signs in as, as JSON, or null to have the service come to know it by itself: the client
 * `given`, or the one `kept` from the app's last sign-in when none is given, or when the same one is
 * given without a secret, which is how the app's page sends one that hasn't been touched.
 */
function clientGiven({ clientId, clientSecret }: AppClient, kept: string | null): string | null {
  if (clientId === undefined) return kept;
  if (clientId === "") return null;
  if (kept !== null && clientSecret === undefined && (JSON.parse(kept) as { client_id: string }).client_id === clientId) return kept;
  return JSON.stringify({ client_id: clientId, ...(clientSecret !== undefined && { client_secret: clientSecret }) });
}

/** Begins the sign-in to `app`'s server, as `client` if one's given, for whoever `credentials` signs in, Ember's or their `own`, whose browser comes back to where `request` came: where to send it, or why not. */
async function begunSignIn(request: Request, env: Env, credentials: Credentials, app: Pick<BegunAppSignIn, "appId" | "name" | "url">, client: string | null, more: string | null, own: boolean): Promise<Response> {
  const { origin, protocol } = urlOf(request);
  // An authorization server reads who Ember is only from an https address.
  const begun = await appConnector(env).startSignIn(app.url, `${origin}${APP_SIGNED_IN_PATH}`, protocol === "https:" ? `${origin}${CLIENT_DOCUMENT_PATH}` : null, client, more);
  if ("error" in begun) return formAnswer(begun, 422);
  const pending = { ...app, state: begun.state, signIn: begun.kept };
  const kept = await (own ? workspace(env).beginOwnAppSignIn(credentials, pending) : workspace(env).beginAppSignIn(credentials, pending));
  if (kept !== true) return own ? refusedYou(kept) : refused(kept);
  return Response.json({ authorizationUrl: begun.authorizationUrl } satisfies AppSignInBegun, { headers: PRIVATE });
}

/**
 * `POST /api/account/app-sign-ins/finish`, `{ state, code, iss? }`, as the browser came back with them:
 * finishes the sign-in whoever asks began, once. One an administrator began for Ember has the server's
 * tools read with it, and connects the app, answering 201, or is kept for the connected app it was
 * for, answering 200, with the app as its page then shows it. One anyone began for themselves is kept
 * as theirs, once the app's server answers with it, answering the app as their profile then lists it.
 * A sign-in that has ended, or that someone else began, is refused with 422, as is one the
 * authorization server or the app's server refuses, with why, and Ember's is refused anyone who
 * isn't an administrator by then.
 */
export async function finishAppSignIn(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return refused(null);
  const back = parseAppSignInReturn(await jsonBodyOf(request));
  if ("error" in back) return problem(422, back.error);
  const ember = workspace(env);
  const begun = await ember.takeAppSignIn(credentials, back.state);
  if (begun === "ended") return problem(422, APP_SIGN_IN_ENDED);
  if (begun === null || typeof begun === "string") return refused(begun);
  const { appId, name, url, own } = begun;
  // What crosses from the connector is typed as what can cross, which the tools' schemas aren't known to be.
  const signedIn = (await appConnector(env).signIn(url, begun.signIn, back.code, back.iss, appId !== null)) as (ReadApp & { kept: string }) | AppRefused;
  if ("error" in signedIn) return problem(422, signedIn.error);
  const { kept, ...read } = signedIn;
  if (own && appId !== null) return signedInAsSelf(await ember.signInToAppAsSelf(credentials, appId, url, kept));
  const app = appId === null ? await ember.connectApp(credentials, { name, url }, read, kept) : await ember.signInToApp(credentials, appId, url, kept, read);
  if (typeof app !== "object" || app === null) return refused(app);
  return Response.json({ app, again: appId !== null } satisfies AppSignedIn, { status: appId === null ? 201 : 200, headers: PRIVATE });
}

/** What finishing a sign-in someone made to an app themselves answers: the app as their profile then lists it, or why it wasn't kept. */
function signedInAsSelf(yours: Awaited<ReturnType<ReturnType<typeof workspace>["signInToAppAsSelf"]>>): Response {
  if (yours === null || typeof yours === "string") return refusedYou(yours === "changed" ? "not found" : yours);
  return Response.json({ yours } satisfies YourAppSignedIn, { headers: PRIVATE });
}

/**
 * `GET /oauth/client.json`: who Ember is to an authorization server that reads its clients from a
 * document (a Client ID Metadata Document), at the address `request` came to: a public client, which
 * sends a browser back only to its own page.
 */
export function clientDocument(request: Request): Response {
  const { origin } = urlOf(request);
  return Response.json({ client_id: `${origin}${CLIENT_DOCUMENT_PATH}`, ...clientMetadataOf(`${origin}${APP_SIGNED_IN_PATH}`) }, { headers: { "Cache-Control": "public, max-age=3600" } });
}

/**
 * `PATCH /api/account/apps/:id`, with any of `{ name, url, token }`, "" for no token: changes the
 * connected app `id`, answering it as its page then shows it. Another address or token has Ember read
 * the server's tools again first, there or with it, so that neither is saved unless the server answers.
 * As with connecting one, someone who isn't an administrator hears so first, then that Ember AI is off,
 * then that there's no such app, before anything that was sent is read. An app that's signed in to
 * keeps its address and takes no token: Ember's sign-in is to the server there, and is sent nowhere else.
 */
export async function changeApp(request: Request, env: Env, appId: AppId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const ember = workspace(env);
  const access = credentials && (await ember.appAccess(credentials, appId));
  if (!credentials || !access) return refused(null);
  if (typeof access === "string") return refused(access);
  const changes = parseAppChanges(await jsonBodyOf(request));
  if ("error" in changes) return formAnswer(changes, 422);
  const url = changes.url ?? access.url;
  if (access.signedIn) {
    if (url !== access.url || changes.token !== undefined) return formAnswer(signedInRefusal(url !== access.url), 422);
    return appAnswer(await ember.changeApp(credentials, appId, changes, null));
  }
  const token = changes.token === undefined ? (access.key?.token ?? null) : changes.token === "" ? null : changes.token;
  if (url === access.url && token === (access.key?.token ?? null)) return appAnswer(await ember.changeApp(credentials, appId, changes, null));
  const read = await appConnector(env).read(url, token === null ? null : { token });
  if ("error" in read) return formAnswer(read, 422);
  return appAnswer(await ember.changeApp(credentials, appId, changes, { read, askedAt: access }));
}

/**
 * `POST /api/account/apps/:id/tools`: reads the connected app `id`'s tools from its server again,
 * answering it as its page then shows it, with no tools if its server has none Ember can use any more,
 * or why Ember couldn't read them, and whether signing in to it might do, which leaves the app as it
 * was, as a sign-in to it that has ended does.
 */
export async function readAppTools(request: Request, env: Env, appId: AppId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const ember = workspace(env);
  const access = credentials && (await ember.appAccess(credentials, appId));
  if (!credentials || !access) return refused(null);
  if (typeof access === "string") return refused(access);
  if (hasEnded(access)) return problem(422, signInEnded(access.name));
  const read = await appConnector(env).read(access.url, access.key, true);
  if ("error" in read) {
    // What its server asked for beyond the sign-in is kept, for signing in again to ask for.
    if (read.scope !== undefined) await ember.keepAppScopeWanted(appId, read.scope, access);
    return Response.json({ error: read.error, ...(read.signIn && { signIn: true }) } satisfies AppRefused, { status: 422 });
  }
  return appAnswer(await ember.changeApp(credentials, appId, {}, { read, askedAt: access }));
}

/** `DELETE /api/account/apps/:id`: disconnects the app `id`, answering 204, or, for one Ember was signed in to, whether its service took the sign-in back. */
export async function disconnectApp(request: Request, env: Env, appId: AppId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const disconnected = credentials && (await workspace(env).disconnectApp(credentials, appId));
  if (disconnected === "revoked" || disconnected === "unrevoked") return Response.json({ revoked: disconnected === "revoked" } satisfies AppRemoved);
  if (!disconnected || disconnected !== "disconnected") return refused(disconnected);
  return new Response(null, { status: 204 });
}

/** `GET /api/account/agents/:id/tools`: every connected app's tools, and which of them `id`, @ember or an agent, may use. */
export async function showAgentTools(request: Request, env: Env, agentId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return agentToolsAnswer(credentials && (await workspace(env).agentTools(credentials, agentId)));
}

/**
 * `PUT /api/account/agents/:id/tools`, `{ tools: [{ appId, name, fingerprint }] }`: has those be every
 * tool `id`, @ember or an agent, may use, answering what its page then offers. More than an agent uses
 * is refused, and so is one that isn't a connected app's any more, or that its server describes another
 * way than the fingerprint the page offered it with says, with 409.
 */
export async function pickAgentTools(request: Request, env: Env, agentId: UserId): Promise<Response> {
  const credentials = await administratorOf(request, env, APPS_FORBIDDEN);
  if (credentials instanceof Response) return credentials;
  const picks = parseToolPicks(await jsonBodyOf(request));
  if ("error" in picks) return problem(422, picks.error);
  return agentToolsAnswer(await workspace(env).pickAgentTools(credentials, agentId, picks));
}

function agentToolsAnswer(apps: OfferedApp[] | Refusal): Response {
  return Array.isArray(apps) ? Response.json({ apps } satisfies AgentTools, { headers: PRIVATE }) : refused(apps);
}

/** Why a request about apps isn't done: there's no such app, agent or tool, or the person asking can't, or not now. */
type Refusal = "off" | "full" | "changed" | "signed in" | "gone" | "not found" | "forbidden" | null;

/** Why an app that's signed in to keeps its address, or else takes no token, said on that field. */
const signedInRefusal = (moved: boolean): AppRefused => ({ error: APP_SIGNED_IN, field: moved ? "url" : "token" });

/** What a request about an app answers: the app as its page then shows it, with `status`, or why it was refused. */
function appAnswer(app: App | Refusal, status = 200): Response {
  return typeof app === "object" && app !== null ? Response.json({ app } satisfies AppAnswer, { status, headers: PRIVATE }) : refused(app);
}

/** Why a request about the sign-in someone makes to an app themselves isn't done: they're signed out, or a guest, Ember AI is off, or the app isn't one Ember signs in to any more. */
function refusedYou(why: "off" | "forbidden" | "not found" | null): Response {
  if (why === null) return problem(401, NOT_SIGNED_IN);
  if (why === "forbidden") return problem(403, YOUR_APPS_FORBIDDEN);
  return why === "off" ? problem(409, ASSISTANT_OFF) : problem(404, YOUR_APP_GONE);
}

function refused(why: Refusal): Response {
  if (why === null) return problem(401, NOT_SIGNED_IN);
  if (why === "forbidden") return problem(403, APPS_FORBIDDEN);
  if (why === "not found") return problem(404, "Not found");
  if (why === "signed in") return formAnswer(signedInRefusal(true), 422);
  return problem(409, why === "off" ? ASSISTANT_OFF : why === "changed" ? APP_CHANGED : why === "gone" ? TOOL_GONE : APPS_FULL);
}
