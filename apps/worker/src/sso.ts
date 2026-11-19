import { welcomePath, type AccountSettings, type UserId } from "@ember/protocol";
import {
  CLIENT_ID_REFUSED,
  CLIENT_SECRET_REFUSED,
  ISSUER_MISMATCH,
  ISSUER_REFUSED,
  ISSUER_UNREACHABLE,
  ISSUER_UNSUPPORTED,
  parseSsoSetup,
  SSO_CALLBACK_PATH,
  SSO_CONNECTED,
  SSO_FORBIDDEN,
  SSO_PROBLEM_PARAM,
  SSO_SETUP_NEEDED,
  type SsoConnection,
  type SsoField,
  type SsoForgotten,
  type SsoSaved,
  type SsoSettings,
  type SsoSetup,
  type SsoSignInProblem,
} from "@ember/protocol/sso";
import { authenticate, clientOf, credentialsOf, newSessionToken, sessionCookie, tokenDigest } from "./auth";
import { bodyUpTo, jsonBodyOf } from "./bodies";
import { originFor } from "./custom-domain";
import type { Env } from "./env";
import { notFound } from "./error-pages";
import { backTo as backToPage, backToSignIn as backToSignInWith, expiredStateCookie, keptStateOf, redirect, returnPathOf, stateCookie, type KeptState } from "./external-sign-in";
import { authorizationUrl, discover, exchangeCode, isIssuer, logoutTokenSubject, randomValue, type Discovery } from "./oidc";
import { formAnswer, home } from "./pages";
import { urlOf } from "./request-url";
import { seal } from "./sealed";
import { isToken } from "./secrets";
import { claimsOf, memberOf, ssoProviderOf, ssoSecretsOf, type SsoProvider } from "./sso-provider";
import { MEMBERFUL_ROUND_TRIP_MS, SSO_CHECK_MS, workspace } from "./workspace";
import type { SavedSso, SignInKept } from "./workspace-store";

// Signing in with the single sign-on provider, by OpenID Connect's authorization code flow with PKCE
// (openid.net/specs/openid-connect-core-1_0.html, RFC 7636): Sign in with SSO sends the browser to the
// provider's authorization endpoint with a random state, nonce and code verifier, which a cookie keeps,
// and the provider sends it back to the callback with that state and a code, which the Worker exchanges,
// with the app's secret and the verifier, for an ID token, checked against the provider's keys and the
// nonce, and a refresh token, kept sealed to ask the provider again about the account every hour. It
// works for any provider that publishes a discovery document, such as Zitadel, Keycloak, Authentik,
// Okta, Entra ID or Google. The provider signs people out with a back-channel logout
// (openid.net/specs/openid-connect-backchannel-1_0.html). While single sign-on is the only way in,
// someone who has an account here already connects theirs as with Memberful (memberful.ts).

/** The cookie that keeps a sign-in's state, the page to come back to, its nonce and its code verifier, until the provider sends the browser back. */
const STATE_COOKIE = "sso_state";
/** How long that takes at most: long enough to sign in at the provider. */
const STATE_MAX_AGE_SECONDS = MEMBERFUL_ROUND_TRIP_MS / 1000;
/** The largest back-channel logout Ember reads, far more than a logout token takes. */
const MAX_LOGOUT_BODY_BYTES = 64 * 1024;

const problem = (status: number, message: string) => Response.json({ error: message }, { status });
const NOT_SIGNED_IN = "Not signed in";

/** Sends the browser back to sign in, which says why signing in with the provider didn't work. */
const backToSignIn = (request: Request, problem: SsoSignInProblem) => backToSignInWith(request, SSO_PROBLEM_PARAM, problem);

/** Sends the browser back to `returnPath`, a page of the workspace, which says how connecting the provider went: `outcome`. */
const backTo = (request: Request, returnPath: string, outcome: SsoSignInProblem | typeof SSO_CONNECTED) => backToPage(request, returnPath, SSO_PROBLEM_PARAM, outcome);

/** Where the provider sends the browser back to at `origin`, Ember's address, which the app at the provider lists as its redirect URI. */
const redirectUriOf = (origin: string) => new URL(SSO_CALLBACK_PATH, origin).href;

/** The provider's discovery document, or null when it doesn't answer as it should. */
async function discoveryOf(provider: SsoProvider): Promise<Discovery | null> {
  const discovery = await discover(provider.issuer);
  return typeof discovery === "object" ? discovery : null;
}

/**
 * Where to sign in at the provider, for a browser at `origin` to come back to `returnPath` from, and the
 * `Set-Cookie` that keeps the state it goes with, and whether it's `connecting` an account, with a new
 * nonce and code verifier.
 */
async function signInAt(request: Request, provider: SsoProvider, discovery: Discovery, origin: string, returnPath: string, connecting: boolean) {
  const [state, nonce, verifier] = [newSessionToken(), randomValue(), randomValue()];
  const location = await authorizationUrl(provider, discovery, { redirectUri: redirectUriOf(origin), state, nonce, verifier, scopes: provider.scopes });
  const cookie = stateCookie(request, STATE_COOKIE, { state, returnPath, connecting, extras: [nonce, verifier] }, STATE_MAX_AGE_SECONDS);
  return { state, location, cookie };
}

/**
 * `GET /auth/sso`, Sign in with SSO: sends the browser to sign in at the provider, keeping a new state,
 * nonce and code verifier, and the page `return_to` names, in a cookie, to come back to Ember's address,
 * its custom domain if it has one, where the provider sends the browser back. Before first run it goes
 * home, and while it isn't offered (`Workspace.offersSsoSignIn`), back to sign in, which says single
 * sign-on is off, or isn't set up, or didn't work while the provider doesn't answer.
 */
export async function startSsoSignIn(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return notFound(request);
  const account = await workspace(env).account();
  if (!account) return home(request);
  const provider = await workspace(env).ssoProvider();
  if (!provider) return backToSignIn(request, "unavailable");
  if ((await workspace(env).offersSsoSignIn()) === null) return backToSignIn(request, "off");
  const url = urlOf(request);
  // The cookie is only sent back to the address that set it.
  const origin = originFor(request, account.customDomain);
  if (origin !== url.origin) return redirect(new URL(`${url.pathname}${url.search}`, origin).href);
  const discovery = await discoveryOf(provider);
  if (!discovery) return backToSignIn(request, "failed");
  const { location, cookie } = await signInAt(request, provider, discovery, origin, returnPathOf(url.searchParams.get("return_to"), origin), false);
  return redirect(location, cookie);
}

/**
 * Starts connecting the account of `userId`, whose password's digest `passwordDigest` the Worker checked
 * the password they gave against, or "" without one, to an account at the provider, to come back to the
 * page `returnTo` names: where to sign in there, and the `Set-Cookie` that keeps the state it goes with,
 * whose digest the Workspace keeps for the callback. Null unless there's a provider that answers and the
 * Workspace kept it (`startConnection`). Asked at an address Ember has moved from to its custom domain,
 * it starts nothing, and answers that page at the custom domain instead, to sign in and connect there.
 */
export async function ssoConnectionFor(
  request: Request,
  env: Env,
  userId: UserId,
  passwordDigest: string,
  returnTo: unknown,
): Promise<{ connection: SsoConnection; cookie: string | null } | null> {
  const provider = await workspace(env).ssoProvider();
  if (!provider) return null;
  const url = urlOf(request);
  const returnPath = returnPathOf(typeof returnTo === "string" ? returnTo : null, url.origin);
  // The provider sends the browser back to the custom domain, which a cookie kept here is never sent to.
  const origin = originFor(request, (await workspace(env).account())?.customDomain ?? null);
  if (origin !== url.origin) return { connection: { ssoConnection: new URL(returnPath, origin).href }, cookie: null };
  const discovery = await discoveryOf(provider);
  if (!discovery) return null;
  const { state, location, cookie } = await signInAt(request, provider, discovery, origin, returnPath, true);
  if (!(await workspace(env).startConnection("sso", userId, passwordDigest, await tokenDigest(state, env.SESSION_SECRET), provider.issuer))) return null;
  return { connection: { ssoConnection: location }, cookie };
}

/**
 * `GET /auth/sso/callback`, where the provider sends the browser back: signs it in as whoever signed in
 * there (`Workspace.signInElsewhere`), or connects their account there to the one here that the state
 * started connecting (`Workspace.connectElsewhere`), and opens the page it was started from, or else goes
 * back to sign in, or to that page when the browser is signed in, which says why not. Each state is good
 * for one try, whatever comes of it.
 */
export async function finishSsoSignIn(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return notFound(request);
  const answer = await signedInWithSso(request, env);
  answer.headers.append("Set-Cookie", expiredStateCookie(request, STATE_COOKIE));
  return answer;
}

/** The nonce and code verifier a sign-in's cookie keeps, after its state and page, or null without them. */
function secretsKept(kept: KeptState): { nonce: string; verifier: string } | null {
  const [nonce, verifier] = kept.extras;
  return nonce && verifier && kept.extras.length === 2 ? { nonce, verifier } : null;
}

/**
 * Whether the callback's `iss` is the provider's, as RFC 9207 has a client check, so that a code another
 * provider gave never goes to this one: it must be there while the provider says it sends it, and match
 * whenever it's there.
 */
const isFromProvider = (iss: string | null, discovery: Discovery) => (iss === null ? !discovery.issuerInResponse : iss === discovery.issuer);

async function signedInWithSso(request: Request, env: Env): Promise<Response> {
  const provider = await workspace(env).ssoProvider();
  if (!provider) return backToSignIn(request, "unavailable");
  const params = urlOf(request).searchParams;
  const [kept, state, code] = [keptStateOf(request, STATE_COOKIE), params.get("state"), params.get("code")];
  const secrets = kept && secretsKept(kept);
  // A state this browser didn't start with, as another site's link to the callback would bring, signs
  // nobody in and connects nothing, nor does a callback without a code, as when someone cancels there.
  if (!kept || !secrets || state === null || !(await isToken(state, kept.state)) || !code) return backToSignIn(request, "failed");
  // Each try counts against the address's sign-in limit, before the provider is asked anything.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const connection = kept.connecting ? await tokenDigest(kept.state, env.SESSION_SECRET) : null;
  const [begun, signedIn] = await Promise.all([workspace(env).beginSignInElsewhere(ip, connection), authenticate(request, env)]);
  const back = (problem: SsoSignInProblem) => (signedIn ? backTo(request, kept.returnPath, problem) : backToSignIn(request, problem));
  if (begun === "limited") return back("refused");
  if (begun === "expired") return back("failed");
  const discovery = await discoveryOf(provider);
  if (!discovery || !isFromProvider(params.get("iss"), discovery)) return back("failed");
  const redirectUri = redirectUriOf(urlOf(request).origin);
  const tokens = await exchangeCode(provider, discovery, { code, verifier: secrets.verifier, redirectUri });
  const claims = tokens && (await claimsOf(provider, discovery, tokens, secrets.nonce));
  if (!tokens || !claims) return back("failed");
  const member = memberOf(provider, claims);
  const keeping: SignInKept = {
    sid: typeof claims.sid === "string" && claims.sid !== "" && claims.sid.length <= 255 ? claims.sid : null,
    refresh: tokens.refreshToken === null ? null : { sealedToken: await seal(env.SESSION_SECRET, "sso-refresh-token", tokens.refreshToken), dueAt: Date.now() + SSO_CHECK_MS },
  };
  const token = newSessionToken();
  const digest = await tokenDigest(token, env.SESSION_SECRET);
  const { connecting, begunAt } = begun;
  // A browser signed in as whoever is connecting stays signed in as it is.
  const staying = connecting !== null && signedIn?.user.id === connecting.userId;
  const user =
    connecting === null
      ? await workspace(env).signInElsewhere("sso", provider.issuer, member, begunAt, digest, clientOf(request), keeping)
      : await workspace(env).connectElsewhere("sso", provider.issuer, member, begunAt, connecting, staying ? null : digest, clientOf(request), keeping);
  if (user === "connected") return backTo(request, kept.returnPath, SSO_CONNECTED);
  // Someone new chooses how people here see them first, as with Memberful.
  if (user === "joined") return redirect(new URL(welcomePath(kept.returnPath), request.url).href, sessionCookie(request, token));
  if (typeof user === "string") return back(user);
  return redirect(new URL(kept.returnPath, request.url).href, sessionCookie(request, token));
}

/** The answer to a back-channel logout, which no cache keeps, as the spec has it. */
const logoutAnswer = (status: number, error?: string) =>
  error === undefined ? new Response(null, { status, headers: { "Cache-Control": "no-store" } }) : Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

/**
 * `POST /auth/sso/backchannel_logout`, where the provider says someone signed out there, or was removed:
 * once the logout token it sends checks out, against its keys and the app (`logoutTokenSubject`), ends the
 * sessions that its session there, or the account it names, signed in here (`Workspace.logOutElsewhere`).
 * Answers 200 once it's done, 400 to a token that doesn't check out, 404 while there's no provider, and
 * 503 while its discovery document doesn't answer, which it can try again after.
 */
export async function ssoBackchannelLogout(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return notFound(request);
  const provider = await workspace(env).ssoProvider();
  if (!provider) return logoutAnswer(404, "invalid_request");
  const body = await bodyUpTo(request, MAX_LOGOUT_BODY_BYTES);
  const token = body === null ? null : new URLSearchParams(body).get("logout_token");
  if (!token) return logoutAnswer(400, "invalid_request");
  const discovery = await discoveryOf(provider);
  if (!discovery) return logoutAnswer(503, "temporarily_unavailable");
  const loggedOut = await logoutTokenSubject(provider, discovery, token);
  if (!loggedOut) return logoutAnswer(400, "invalid_request");
  await workspace(env).logOutElsewhere(provider.issuer, loggedOut);
  return logoutAnswer(200);
}

/** Why `settings` can't be saved: turning single sign-on, or SSO only, on takes a provider set up first. Null when they can. */
export async function ssoRefusal(settings: AccountSettings | undefined, env: Env): Promise<string | null> {
  if (!settings?.ssoJoin && !settings?.ssoSignIn) return null;
  return (await ssoProviderOf(env, await workspace(env).savedSso())) ? null : SSO_SETUP_NEEDED;
}

/** What's said of single sign-on's setup is for administrators, which no cache should keep. */
const PRIVATE = { "Cache-Control": "no-store" };

type Refusal = { error: string; field: SsoField };

/**
 * `PUT /api/account/sso`, as Set up single sign-on saves it: sets up the provider, or changes it, once its
 * discovery document checks out, answering it as it is then. Someone who isn't an administrator hears so
 * before anything they sent is read. While the deployment's secrets give the issuer, app and secret, only
 * the rest is saved; otherwise the issuer and Client ID are needed, and the Client Secret unless the one
 * kept is for that same app. A field that can't be one, or an issuer whose discovery document doesn't
 * answer, names another issuer or doesn't offer the code flow with PKCE, is refused on its field.
 */
export async function saveSso(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const administrator = credentials && (await workspace(env).canAdminister(credentials));
  if (!credentials || administrator === null) return problem(401, NOT_SIGNED_IN);
  if (!administrator) return problem(403, SSO_FORBIDDEN);
  const setup = parseSsoSetup(await jsonBodyOf(request));
  if ("error" in setup) return formAnswer(setup, 422);
  const secrets = ssoSecretsOf(env);
  const saved = await workspace(env).savedSso();
  const sso = secrets ? besideSecrets(setup, saved) : await savedFrom(setup, saved, env);
  if ("error" in sso) return formAnswer(sso, 422);
  const refusal = discoveryRefusal(await discover(secrets?.issuer ?? sso.issuer!, { fresh: true }));
  if (refusal) return formAnswer(refusal, 422);
  return ssoAnswer(await workspace(env).changeSso(credentials, sso));
}

/** `DELETE /api/account/sso`: forgets the provider the card set up, as its switch does, which turns single sign-on off unless the deployment's secrets give one. */
export async function forgetSso(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return ssoAnswer(credentials && (await workspace(env).changeSso(credentials, null)));
}

/** What the card says of whom the provider lets in, as it's kept. */
const namedIn = ({ name, scopes, groupsClaim, allowedGroups, linksVerifiedEmails }: SsoSetup) => ({ name, scopes, groupsClaim, allowedGroups, linksVerifiedEmails });

/** What's kept beside the deployment's secrets, which give the issuer, app and secret: the rest, and whatever the card kept of its own, for once they're gone. */
const besideSecrets = (setup: SsoSetup, saved: SavedSso | null): SavedSso => ({
  issuer: saved?.issuer ?? null,
  clientId: saved?.clientId ?? null,
  sealedClientSecret: saved?.sealedClientSecret ?? null,
  ...namedIn(setup),
});

/** What's kept of a provider the card sets up itself: its issuer, app and secret, sealed, or the one kept for that same app, with the rest. */
async function savedFrom(setup: SsoSetup, saved: SavedSso | null, env: Env): Promise<SavedSso | Refusal> {
  const { issuer, clientId, clientSecret } = setup;
  if (!issuer || !isIssuer(issuer)) return { error: ISSUER_REFUSED, field: "issuer" };
  if (!clientId) return { error: CLIENT_ID_REFUSED, field: "clientId" };
  const kept = saved?.issuer === issuer && saved.clientId === clientId ? saved.sealedClientSecret : null;
  const sealedClientSecret = clientSecret ? await seal(env.SESSION_SECRET, "sso-client-secret", clientSecret) : kept;
  if (!sealedClientSecret) return { error: CLIENT_SECRET_REFUSED, field: "clientSecret" };
  return { issuer, clientId, sealedClientSecret, ...namedIn(setup) };
}

/** Why the issuer's discovery document refuses it, on the issuer's field, or null once it checks out. */
function discoveryRefusal(discovery: Awaited<ReturnType<typeof discover>>): Refusal | null {
  if (discovery === null) return { error: ISSUER_UNREACHABLE, field: "issuer" };
  if (discovery === "mismatch") return { error: ISSUER_MISMATCH, field: "issuer" };
  if (discovery === "unsupported") return { error: ISSUER_UNSUPPORTED, field: "issuer" };
  return null;
}

/** The answer to changing single sign-on: the provider as it is then, or who can't change it. */
function ssoAnswer(changed: { sso: SsoSettings | null } | "forbidden" | null): Response {
  if (!changed) return problem(401, NOT_SIGNED_IN);
  if (changed === "forbidden") return problem(403, SSO_FORBIDDEN);
  return Response.json(changed satisfies SsoSaved | SsoForgotten, { headers: PRIVATE });
}
