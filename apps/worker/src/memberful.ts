import {
  MEMBERFUL_CONNECTED,
  MEMBERFUL_PROBLEM_PARAM,
  welcomePath,
  type AccountSettings,
  type MemberfulConnection,
  type MemberfulSignInProblem,
  type UserId,
} from "@ember/protocol";
import { memberfulSiteKept, parseMemberfulKeysChange, type MemberfulSaved } from "@ember/protocol/memberful";
import { authenticate, clientOf, credentialsOf, newSessionToken, sessionCookie, tokenDigest } from "./auth";
import { bytesUpTo, jsonBodyOf, MAX_JSON_BODY_BYTES } from "./bodies";
import { originFor } from "./custom-domain";
import { fromHex } from "./encoding";
import type { Env } from "./env";
import { notFound } from "./error-pages";
import { backTo as backToPage, backToSignIn as backToSignInWith, expiredStateCookie as expiredCookie, keptStateOf as keptCookieOf, redirect, returnPathOf, stateCookie as cookieKeeping } from "./external-sign-in";
import {
  deployedMemberfulOf,
  isSubject,
  memberfulWebhooksOf,
  memberWhoSignedIn,
  refusalOfMemberfulKeys,
  type MemberfulKeys,
  type MemberfulSetup,
} from "./memberful-api";
import { formAnswer, home } from "./pages";
import { urlOf } from "./request-url";
import { isToken } from "./secrets";
import { MEMBERFUL_ROUND_TRIP_MS, workspace } from "./workspace";
import { NOTHING_KEPT } from "./workspace-store";

// Signing in with Memberful. Memberful speaks OAuth 2.0 but not OpenID Connect, so this follows its
// guide for a server-side custom app (memberful.com/docs/api-reference/sign-in-for-apps-via-oauth): Sign
// in with Memberful sends the browser to the site's `/oauth` with a random state, which a cookie keeps,
// and the site sends it back to the callback with that state and a code, which the Worker exchanges,
// with the app's client secret, for an access token to ask the member API who signed in. It works only
// while the deployment has the app's keys, and lets someone new in only while an administrator has
// Memberful on, but signs in the members who joined with it once it's off too, since they have no
// password. While it's members only, someone who has an account here already connects their Memberful
// account to it the same way, once their password has checked out, from their profile, or as they sign
// in: the Workspace keeps the state's digest for the callback, which connects the account to theirs.
//
// The keys are the deployment's secrets, `MEMBERFUL_URL` and the rest, which take the place of any
// others, or else the ones an administrator gives Ember in Set up Memberful, which the Workspace keeps
// sealed, once Memberful has taken them.

/** The cookie that keeps a sign-in's state, and the page to come back to, until Memberful sends the browser back. */
const STATE_COOKIE = "memberful_state";
/** How long that takes at most: long enough to sign in at Memberful, or sign up there. */
const STATE_MAX_AGE_SECONDS = MEMBERFUL_ROUND_TRIP_MS / 1000;
/** Where Memberful signs a webhook: the HMAC-SHA256 of its body, under the webhook's secret, in hex. */
const SIGNATURE_HEADER = "X-Memberful-Webhook-Signature";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Why Memberful can't be turned on: Ember lacks the keys of a Memberful site's custom app. */
export const MEMBERFUL_KEYS_NEEDED = "Set up Memberful first, which gives Ember your Memberful site's keys.";

/** Why `settings` can't be saved without Memberful's keys: turning Memberful, or its Members only, on takes them. Null when they can. */
export async function memberfulRefusal(settings: AccountSettings | undefined, env: Env): Promise<string | null> {
  if (!settings?.memberfulJoin && !settings?.memberfulSignIn) return null;
  return (await memberfulFor(env)) ? null : MEMBERFUL_KEYS_NEEDED;
}

/** Ember's Memberful site and keys: the deployment's, which take the place of any others, or else those an administrator gave Ember, or null without either. */
export async function memberfulFor(env: Env): Promise<MemberfulSetup | null> {
  return deployedMemberfulOf(env) ?? (await workspace(env).savedMemberful());
}

/** The Memberful site whose members sign in, as `memberfulFor` has it, or null without its keys. */
export const memberfulSiteFor = async (env: Env) => (await memberfulFor(env))?.site ?? null;

/** Sends the browser back to sign in, which says why signing in with Memberful didn't work. */
const backToSignIn = (request: Request, problem: MemberfulSignInProblem) => backToSignInWith(request, MEMBERFUL_PROBLEM_PARAM, problem);

/** Sends the browser back to `returnPath`, a page of the workspace, which says how connecting Memberful went: `outcome`. */
const backTo = (request: Request, returnPath: string, outcome: MemberfulSignInProblem | typeof MEMBERFUL_CONNECTED) =>
  backToPage(request, returnPath, MEMBERFUL_PROBLEM_PARAM, outcome);

/** Where to sign in at the Memberful site, which sends the browser back to the callback with `state`. */
function authorizationOf({ site, clientId }: MemberfulKeys, state: string): string {
  const authorize = new URL("/oauth", site);
  authorize.search = new URLSearchParams({ response_type: "code", client_id: clientId, state }).toString();
  return authorize.href;
}

/**
 * The `Set-Cookie` that keeps a sign-in's `state` and the page to come back to, `returnPath`, and whether
 * it's `connecting` an account, so that the callback never takes one whose connection has gone for a
 * sign-in.
 */
const stateCookie = (request: Request, state: string, returnPath: string, connecting = false) =>
  cookieKeeping(request, STATE_COOKIE, { state, returnPath, connecting, extras: [] }, STATE_MAX_AGE_SECONDS);

/** The `Set-Cookie` that forgets it. */
const expiredStateCookie = (request: Request) => expiredCookie(request, STATE_COOKIE);

/** The state, the page to come back to, and whether it's connecting an account, that the request's cookie keeps, if it keeps any. */
const keptStateOf = (request: Request) => keptCookieOf(request, STATE_COOKIE);

/**
 * `GET /auth/memberful`, Sign in with Memberful: sends the browser to sign in at the Memberful site,
 * keeping a new state and the page `return_to` names in a cookie, to come back to Ember's address, its
 * custom domain if it has one, where Memberful sends the browser back. Before first run it goes home,
 * and while it isn't offered (`Workspace.offersMemberfulSignIn`), back to sign in, which says Memberful
 * is off, or isn't set up while it's on without Memberful's keys.
 */
export async function startMemberfulSignIn(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return notFound(request);
  const [account, keys] = await Promise.all([workspace(env).account(), memberfulFor(env)]);
  if (!account) return home(request);
  if (!keys) return backToSignIn(request, account.memberfulJoin ? "unavailable" : "off");
  if (!(await workspace(env).offersMemberfulSignIn(keys.site))) return backToSignIn(request, "off");
  const url = urlOf(request);
  // The cookie is only sent back to the address that set it.
  const origin = originFor(request, account.customDomain);
  if (origin !== url.origin) return redirect(new URL(`${url.pathname}${url.search}`, origin).href);
  const state = newSessionToken();
  return redirect(authorizationOf(keys, state), stateCookie(request, state, returnPathOf(url.searchParams.get("return_to"), origin)));
}

/**
 * Starts connecting the account of `userId`, whose password's digest `passwordDigest` the Worker checked
 * the password they gave against, or "" without one, to an account at the Memberful site, to come back
 * to the page `returnTo` names: where to sign in there, and the `Set-Cookie` that keeps the state it
 * goes with, whose digest the Workspace keeps for the callback. Null unless Ember has Memberful's keys
 * and the Workspace kept it (`startConnection`). Asked at an address Ember has moved from to its custom
 * domain, as a tab left open there is, it starts nothing, and answers that page at the custom domain
 * instead, to sign in and connect there.
 */
export async function memberfulConnectionFor(
  request: Request,
  env: Env,
  userId: UserId,
  passwordDigest: string,
  returnTo: unknown,
): Promise<{ connection: MemberfulConnection; cookie: string | null } | null> {
  const keys = await memberfulFor(env);
  if (!keys) return null;
  const url = urlOf(request);
  const returnPath = returnPathOf(typeof returnTo === "string" ? returnTo : null, url.origin);
  // Memberful sends the browser back to the custom domain, which a cookie kept here is never sent to.
  const origin = originFor(request, (await workspace(env).account())?.customDomain ?? null);
  if (origin !== url.origin) return { connection: { memberfulConnection: new URL(returnPath, origin).href }, cookie: null };
  const state = newSessionToken();
  if (!(await workspace(env).startConnection("memberful", userId, passwordDigest, await tokenDigest(state, env.SESSION_SECRET), keys.site))) return null;
  return { connection: { memberfulConnection: authorizationOf(keys, state) }, cookie: stateCookie(request, state, returnPath, true) };
}

/**
 * `GET /auth/memberful/callback`, where Memberful sends the browser back: signs it in as whoever signed
 * in there (`Workspace.signInElsewhere`), or connects their account there to the one here that the
 * state started connecting (`Workspace.connectElsewhere`), and opens the page it was started from, by
 * way of the welcome page for someone new, or else goes back to sign in, or to that page when the
 * browser is signed in, which says why not. Each state is good for one try, whatever comes of it.
 */
export async function finishMemberfulSignIn(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return notFound(request);
  const answer = await signedInWithMemberful(request, env);
  answer.headers.append("Set-Cookie", expiredStateCookie(request));
  return answer;
}

async function signedInWithMemberful(request: Request, env: Env): Promise<Response> {
  const keys = await memberfulFor(env);
  if (!keys) return backToSignIn(request, "unavailable");
  const params = urlOf(request).searchParams;
  const [kept, state, code] = [keptStateOf(request), params.get("state"), params.get("code")];
  // A state this browser didn't start with, as another site's link to the callback would bring, signs
  // nobody in and connects nothing, nor does a callback without a code.
  if (!kept || state === null || !(await isToken(state, kept.state)) || !code) return backToSignIn(request, "failed");
  // Each try counts against the address's sign-in limit, before Memberful is asked anything.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const connection = kept.connecting ? await tokenDigest(kept.state, env.SESSION_SECRET) : null;
  const [begun, signedIn] = await Promise.all([workspace(env).beginSignInElsewhere(ip, connection), authenticate(request, env)]);
  const back = (problem: MemberfulSignInProblem) => (signedIn ? backTo(request, kept.returnPath, problem) : backToSignIn(request, problem));
  if (begun === "limited") return back("refused");
  if (begun === "expired") return back("failed");
  const member = await memberWhoSignedIn(keys, code);
  if (!member) return back("failed");
  const token = newSessionToken();
  const digest = await tokenDigest(token, env.SESSION_SECRET);
  const { connecting, begunAt } = begun;
  // A browser signed in as whoever is connecting stays signed in as it is.
  const staying = connecting !== null && signedIn?.user.id === connecting.userId;
  const user =
    connecting === null
      ? await workspace(env).signInElsewhere("memberful", keys.site, member, begunAt, digest, clientOf(request), NOTHING_KEPT)
      : await workspace(env).connectElsewhere("memberful", keys.site, member, begunAt, connecting, staying ? null : digest, clientOf(request), NOTHING_KEPT);
  if (user === "connected") return backTo(request, kept.returnPath, MEMBERFUL_CONNECTED);
  // Someone new chooses how people here see them first.
  if (user === "joined") return redirect(new URL(welcomePath(kept.returnPath), request.url).href, sessionCookie(request, token));
  if (typeof user === "string") return back(user);
  return redirect(new URL(kept.returnPath, request.url).href, sessionCookie(request, token));
}

/**
 * `POST /webhooks/memberful`, where the Memberful site says a member's account, subscription or order
 * changed: once its signature checks out, the Workspace queues checking that member's membership with
 * the admin API, if they're linked to someone here, rather than trusting what it says, as Memberful
 * advises, since its webhooks can come in any order (memberful.com/docs/api-reference/webhooks). So any
 * event about a member has their membership checked, whatever it's called: one that ends it, as a
 * subscription deactivated or deleted, an order refunded or suspended, or the member deleted, suspends
 * them once the check finds it ended, and one that renews it lets them back. Answers 404 without the
 * webhook's secret and the API key to check with, 401 to a signature that doesn't check out, 413 to a
 * body over the limit, and 200 to anything else, an event about nobody's membership, such as a plan's
 * or a download's, or one Ember has never heard of, too: Memberful tries again for a day whatever isn't
 * answered with a success, then deletes the webhook if it's still failing three days later.
 */
export async function memberfulWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return notFound(request);
  const webhooks = memberfulWebhooksOf(await memberfulFor(env));
  if (!webhooks) {
    console.error("A Memberful webhook came, but Ember lacks the webhook's secret or the custom app's API key, so it's refused");
    return new Response(null, { status: 404 });
  }
  const body = await bytesUpTo(request, MAX_JSON_BODY_BYTES);
  if (body === null) return new Response(null, { status: 413 });
  if (!(await isSignedWith(webhooks.secret, body, request.headers.get(SIGNATURE_HEADER)))) return new Response(null, { status: 401 });
  const subject = subjectOf(parsed(body));
  if (subject !== null) await workspace(env).queueMembershipCheck(webhooks.api.site, subject);
  return new Response(null, { status: 200 });
}

/** Whether `signature` is the hex HMAC-SHA256 of `body` under `secret`, compared in constant time. */
async function isSignedWith(secret: string, body: ArrayBuffer, signature: string | null): Promise<boolean> {
  const signed = signature === null ? null : fromHex(signature.trim().toLowerCase());
  if (signed?.byteLength !== 32) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signed, body);
}

/** The JSON value `body` holds, or null for none. */
function parsed(body: ArrayBuffer): unknown {
  try {
    return JSON.parse(decoder.decode(body));
  } catch {
    return null;
  }
}

/**
 * The member a webhook's payload is about, by their member id, where Memberful's WordPress plugin finds
 * it: `member.id` for a member's event, and the `member` of the subscription or order an event of theirs
 * is about. Null for anything else, such as a plan's event, whose `subscription` is the plan's price,
 * with no member, or a download's, which say nothing about anyone's membership.
 */
function subjectOf(payload: unknown): string | null {
  const { member, subscription, order } = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const about = [member, (subscription as { member?: unknown } | null)?.member, (order as { member?: unknown } | null)?.member];
  const id = about.map((someone) => (someone as { id?: unknown } | null)?.id).find((id) => id !== undefined && id !== null);
  // Memberful's ids are numbers in a webhook's JSON, and strings in its GraphQL API, as accounts are linked by them.
  const subject = typeof id === "number" && Number.isSafeInteger(id) ? String(id) : id;
  return isSubject(subject) ? subject : null;
}

/**
 * `PUT /api/account/memberful_keys`, as Set up Memberful sends a Memberful site's address and keys, after
 * who's asking, as changing the workspace does: once Memberful takes them (`refusalOfMemberfulKeys`), the
 * Workspace keeps them, answering Memberful as Membership's card shows it then, the deployment's keys
 * taking the place of them while it has its own. Keys that can't be one, or that Memberful refuses, are
 * refused on the field they're about, as another site is than the one people here sign in at.
 */
export async function saveMemberfulKeys(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const administrator = credentials && (await workspace(env).canAdminister(credentials));
  if (!credentials || administrator === null) return formAnswer({ error: "Not signed in" }, 401);
  if (!administrator) return formAnswer({ error: "Only administrators can change the workspace" }, 403);
  const keys = parseMemberfulKeysChange(await jsonBodyOf(request));
  if ("error" in keys) return formAnswer(keys, 422);
  const refusal = await refusalOfMemberfulKeys(keys);
  if (refusal) return formAnswer({ error: refusal.error, ...(refusal.field && { field: refusal.field }) }, refusal.status);
  const saved = await workspace(env).changeMemberfulKeys(credentials, keys);
  if (!saved) return formAnswer({ error: "Not signed in" }, 401);
  if (saved === "forbidden") return formAnswer({ error: "Only administrators can change the workspace" }, 403);
  if ("kept" in saved) return formAnswer({ error: memberfulSiteKept(saved.kept), field: "site" }, 422);
  return formAnswer(withDeployedMemberful(env, saved) satisfies MemberfulSaved, 200);
}

/**
 * Memberful as workspace settings show it, `settings` having it as an administrator set it up: with the
 * deployment's site and keys in place of theirs, while it has its own, which Set up Memberful doesn't
 * change, so it keeps no site then.
 */
export function withDeployedMemberful<T extends MemberfulSaved>(env: Env, settings: T): T {
  const deployed = deployedMemberfulOf(env);
  if (!deployed) return settings;
  return { ...settings, memberfulSite: deployed.site, memberfulWebhooks: memberfulWebhooksOf(deployed) !== null, memberfulKeys: "secret", memberfulSiteKept: null };
}
