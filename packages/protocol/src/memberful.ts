// Memberful's keys, which administrators give Ember in Set up Memberful, behind Membership's Memberful
// card, through `/api/account/memberful_keys`, unless the deployment has them as secrets: the address of
// the Memberful site whose members sign in, the OAuth identifier, OAuth secret and API key of a custom app
// there, and the secret key of the webhook it sends Ember. The Worker asks Memberful about them before
// Ember keeps them, and keeps the secrets sealed, never showing them again.

import { isLoopback } from "./apps.ts";
import type { WorkspaceSettings } from "./index.ts";

/** What Set up Memberful gives `PUT /api/account/memberful_keys`, as Memberful's dashboard shows them. */
export interface MemberfulKeysChange {
  /** The Memberful site's address, such as https://example.memberful.com, which Ember keeps as its origin. */
  site: string;
  /** The custom app's OAuth identifier and secret, which members sign in with. */
  clientId: string;
  clientSecret: string;
  /** The custom app's API key, which Ember checks memberships with. */
  apiKey: string;
  /** The secret key Memberful signs the webhook's requests with. */
  webhookSecret: string;
}

/** A field of Set up Memberful, which a refusal can be about. */
export type MemberfulField = keyof MemberfulKeysChange;

/** What `PUT /api/account/memberful_keys` answers once Memberful has taken the keys: Memberful as Membership's card shows it then. */
export type MemberfulSaved = Pick<WorkspaceSettings, "memberfulSite" | "memberfulWebhooks" | "memberfulKeys" | "memberfulSiteKept">;

/** The longest address of a Memberful site Ember takes, and the longest key, which Memberful's are far shorter than. */
const MAX_SITE_LENGTH = 2048;
const MAX_KEY_LENGTH = 255;

/** Why Set up Memberful's fields are refused before Memberful is asked about them. */
export const MEMBERFUL_SITE_REFUSED = "Give your Memberful site's address, such as https://example.memberful.com.";
export const MEMBERFUL_CLIENT_ID_REFUSED = "Copy the OAuth identifier from your custom app in Memberful.";
export const MEMBERFUL_CLIENT_SECRET_REFUSED = "Copy the OAuth secret from your custom app in Memberful.";
export const MEMBERFUL_API_KEY_REFUSED = "Copy the API key from your custom app in Memberful.";
export const MEMBERFUL_WEBHOOK_SECRET_REFUSED = "Copy the secret key from your webhook in Memberful.";

/** Why they're refused once Memberful has been asked about them, or couldn't be. */
export const MEMBERFUL_SITE_UNREACHABLE = "Ember couldn't reach a site at that address. Check your Memberful site's address.";
export const MEMBERFUL_SITE_UNKNOWN = "That isn't a Memberful site's address. Give the one your members sign in at, such as https://example.memberful.com.";
export const MEMBERFUL_API_KEY_UNKNOWN = "Memberful didn't take that API key. Copy it again from your custom app.";
export const MEMBERFUL_CLIENT_UNKNOWN = "Memberful doesn't know that OAuth identifier and secret together. Copy both again from your custom app.";
export const MEMBERFUL_KEYS_UNCHECKED = "Ember couldn't check the keys with Memberful. Try again.";

/**
 * Why another site is refused once people here sign in with their accounts at `site`, which are linked
 * to them by that site and their member id there, so that another site's members would never be them.
 */
export const memberfulSiteKept = (site: string) => `People here sign in with their accounts at ${site}, so Ember keeps that site.`;

// This package is typed without a platform's library, and every platform it runs on has URL.
declare const URL: {
  new (url: string): { readonly origin: string; readonly protocol: string; readonly hostname: string; readonly username: string; readonly password: string };
  canParse(url: string): boolean;
};

/**
 * The Memberful site `text` gives, as its origin, so that a path or a slash after it changes nothing, or
 * null when it can't be one's: an https address, https being taken as read without a scheme, with a host
 * and no name and password, or an http one on this computer, where the browser tests fake a site.
 */
export function memberfulSiteOf(text: string): string | null {
  const given = text.trim();
  if (given === "" || given.length > MAX_SITE_LENGTH) return null;
  const address = /^[a-z][a-z\d+.-]*:\/\//i.test(given) ? given : `https://${given}`;
  if (!URL.canParse(address)) return null;
  const { origin, protocol, hostname, username, password } = new URL(address);
  if (hostname === "" || username !== "" || password !== "") return null;
  return protocol === "https:" || (protocol === "http:" && isLoopback(hostname)) ? origin : null;
}

/** The key `text` gives, without the spaces around it, or null when it can't be one: Memberful's are letters, digits and marks, without spaces. */
export function memberfulKeyOf(text: string): string | null {
  const key = text.trim();
  return key.length <= MAX_KEY_LENGTH && /^[\x21-\x7e]+$/.test(key) ? key : null;
}

/** Why each key is refused before Memberful is asked about it. */
const KEY_REFUSED = {
  clientId: MEMBERFUL_CLIENT_ID_REFUSED,
  clientSecret: MEMBERFUL_CLIENT_SECRET_REFUSED,
  apiKey: MEMBERFUL_API_KEY_REFUSED,
  webhookSecret: MEMBERFUL_WEBHOOK_SECRET_REFUSED,
} as const satisfies Record<Exclude<MemberfulField, "site">, string>;

/** What `PUT /api/account/memberful_keys` gives Ember, as Set up Memberful sends it, or why it can't be a site and its keys, on the field it's about. */
export function parseMemberfulKeysChange(data: unknown): MemberfulKeysChange | { error: string; field: MemberfulField } {
  const given = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const text = (field: MemberfulField) => {
    const value = given[field];
    return typeof value === "string" ? value : "";
  };
  const site = memberfulSiteOf(text("site"));
  if (site === null) return { error: MEMBERFUL_SITE_REFUSED, field: "site" };
  const keys = { clientId: "", clientSecret: "", apiKey: "", webhookSecret: "" };
  for (const field of Object.keys(KEY_REFUSED) as Array<keyof typeof KEY_REFUSED>) {
    const key = memberfulKeyOf(text(field));
    if (key === null) return { error: KEY_REFUSED[field], field };
    keys[field] = key;
  }
  return { site, ...keys };
}
