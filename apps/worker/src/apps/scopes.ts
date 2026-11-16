import { MAX_APP_SCOPE_LENGTH } from "@ember/protocol/apps";

// The OAuth scopes of a sign-in to an app: what its server asks for, and what a sign-in asks its
// authorization server for, each a list of names between spaces.

/** A scope as OAuth has one (RFC 6749, 3.3): printable ASCII but a space, a quote or a backslash. */
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/**
 * The scopes `said` names, each once, between spaces, as a server's challenge or an authorization
 * server's answer has them: null for none, for any that isn't one, and for more than Ember keeps.
 */
export function scopesOf(said: string | null | undefined): string | null {
  const scopes = [...new Set((said ?? "").split(" ").filter((scope) => scope !== ""))];
  const named = scopes.join(" ");
  return scopes.length > 0 && scopes.every((scope) => SCOPE.test(scope)) && named.length <= MAX_APP_SCOPE_LENGTH ? named : null;
}

/** `scopes` with those of `more` that aren't among them, each a list between spaces, or null for none: null when that's none at all. */
export function scopesWith(scopes: string | null, more: string | null): string | null {
  const all = [...new Set([...(scopes ?? "").split(" "), ...(more ?? "").split(" ")].filter((scope) => scope !== ""))];
  return all.length > 0 ? all.join(" ") : null;
}
