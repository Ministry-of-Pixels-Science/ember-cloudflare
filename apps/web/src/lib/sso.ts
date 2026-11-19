import { SSO_CONNECTED, SSO_CONNECTED_NOTICE, SSO_PROBLEM_PARAM, SSO_SIGN_IN_PROBLEMS, ssoProblemOf, type SsoSignInProblem } from "@ember/protocol/sso";
import type { FlashMessage } from "./flash";

// What signing in with single sign-on, or connecting an account at the provider, came to, as the
// Worker's callback names it in the address it sends the browser back to (`?sso=`), as Memberful's
// does (`lib/memberful.ts`): the sign-in page says what went wrong, and a page of the workspace flashes
// it, or that your account is connected.

/** What a single sign-on sign-in or connection that came back to this page came to, as its address names it, if it does. */
export function ssoOutcomeOnArrival(): SsoSignInProblem | typeof SSO_CONNECTED | null {
  const value = new URLSearchParams(location.search).get(SSO_PROBLEM_PARAM);
  return value === SSO_CONNECTED ? value : ssoProblemOf(value);
}

/** Takes it out of this page's address, so that it's said once, not again on reload. */
export function forgetSsoOutcome(): void {
  const params = new URLSearchParams(location.search);
  if (!params.has(SSO_PROBLEM_PARAM)) return;
  params.delete(SSO_PROBLEM_PARAM);
  const search = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
}

/** What a page of the workspace flashes for what this page's address says a single sign-on connection came to, taking it out of the address. */
export function takeSsoFlash(): FlashMessage | null {
  const outcome = ssoOutcomeOnArrival();
  forgetSsoOutcome();
  if (outcome === null) return null;
  return outcome === SSO_CONNECTED ? { kind: "notice", text: SSO_CONNECTED_NOTICE } : { kind: "alert", text: SSO_SIGN_IN_PROBLEMS[outcome] };
}
