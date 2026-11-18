import { signInReturnPathIn } from "@ember/protocol";
import { cookieValues, hostCookie, hostCookieName } from "./auth";
import { toBase64url, urlsafeDecode64 } from "./encoding";
import { withCookies } from "./pages";
import { urlOf } from "./request-url";

// What signing in with an account elsewhere shares, whether at a Memberful site (memberful.ts) or at a
// single sign-on provider (sso.ts): the browser goes there with a random state, which a cookie keeps with
// the page to come back to, and whatever else the way back needs, and comes back to a callback, which
// takes the state only from the browser that started with it, and answers with a redirect.

/** The longest page to come back to that the cookie keeps. Any longer, and signing in goes home. */
const MAX_RETURN_PATH_LENGTH = 1024;
/** What the state cookie of a connection says, after the page to come back to. */
const CONNECTING = "connecting";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * What a sign-in's cookie keeps until the browser comes back: its state, the page to come back to,
 * whether it's connecting an account, so that the callback never takes one whose connection has gone for
 * a sign-in, and what else the way back needs, each without a dot.
 */
export interface KeptState {
  state: string;
  returnPath: string;
  connecting: boolean;
  extras: string[];
}

/** A redirect to `location`, which no cache keeps, since it signs someone in, or starts to. */
export const redirect = (location: string, ...cookies: string[]) =>
  withCookies(new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } }), ...cookies);

/** Sends the browser back to sign in, which says why signing in elsewhere didn't work: `problem`, as the query parameter `param`. */
export const backToSignIn = (request: Request, param: string, problem: string) =>
  redirect(new URL(`/session/new?${new URLSearchParams({ [param]: problem })}`, request.url).href);

/** Sends the browser back to `returnPath`, a page of the workspace, which says how connecting an account went: `outcome`, as `param`. */
export function backTo(request: Request, returnPath: string, param: string, outcome: string): Response {
  const url = new URL(returnPath, request.url);
  url.searchParams.set(param, outcome);
  return redirect(url.href);
}

/**
 * The page of the workspace, or the welcome page, at `origin` that `returnTo` names, its query and
 * fragment included (`signInReturnPathIn`), or "/" for anything else, so that signing in only ever opens
 * a page here, or for one too long to keep, as its address writes it, with every character that isn't
 * ASCII escaped.
 */
export function returnPathOf(returnTo: string | null, origin: string): string {
  const path = signInReturnPathIn(returnTo, origin);
  return path.length <= MAX_RETURN_PATH_LENGTH ? path : "/";
}

/**
 * The `Set-Cookie` that keeps `kept` as the cookie `name` for `maxAge` seconds: its state, the page to
 * come back to in URL-safe Base64, "connecting" or nothing, and its extras, apart by dots. Without extras,
 * a sign-in's is just the state and the page, as Memberful's cookies have always been.
 */
export function stateCookie(request: Request, name: string, { state, returnPath, connecting, extras }: KeptState, maxAge: number): string {
  const parts = [state, toBase64url(encoder.encode(returnPath)), ...(connecting || extras.length > 0 ? [connecting ? CONNECTING : ""] : []), ...extras];
  return hostCookie(request, name, parts.join("."), maxAge);
}

/** The `Set-Cookie` that forgets the cookie `name`. */
export const expiredStateCookie = (request: Request, name: string) => hostCookie(request, name, "", 0);

/** What the request's cookie `name` keeps, if it keeps a state, with the page to come back to as `returnPathOf` reads it. */
export function keptStateOf(request: Request, name: string): KeptState | null {
  const [kept] = cookieValues(request, hostCookieName(request, name));
  const [state, encoded, connecting, ...extras] = kept?.split(".") ?? [];
  const bytes = encoded === undefined ? null : urlsafeDecode64(encoded);
  if (!state || !bytes) return null;
  try {
    return { state, returnPath: returnPathOf(decoder.decode(bytes), urlOf(request).origin), connecting: connecting === CONNECTING, extras };
  } catch {
    return null;
  }
}
