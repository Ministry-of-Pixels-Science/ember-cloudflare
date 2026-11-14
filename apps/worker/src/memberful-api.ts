import { isReservedName, MAX_EMAIL_ADDRESS_LENGTH, MAX_USER_NAME_LENGTH } from "@ember/protocol";
import {
  MEMBERFUL_API_KEY_UNKNOWN,
  MEMBERFUL_CLIENT_UNKNOWN,
  MEMBERFUL_KEYS_UNCHECKED,
  MEMBERFUL_SITE_UNKNOWN,
  MEMBERFUL_SITE_UNREACHABLE,
  type MemberfulField,
  type MemberfulKeysChange,
} from "@ember/protocol/memberful";
import type { Env } from "./env";
import { isLoopback } from "./loopback";
import { seal, unseal } from "./sealed";

// What Ember asks the Memberful site whose members sign in, and the keys it asks with, the deployment's
// secrets or else the ones an administrator gave in Set up Memberful: its member API, with the access
// token a sign-in's code is exchanged for, says who signed in, and its admin API, with the custom app's
// API key, says whose memberships are active, which the Workspace checks when a webhook says one
// changed, and once a day. Set up Memberful's keys are tried on both before Ember keeps them. None of it
// follows a redirect, which would take a secret elsewhere, and Memberful's answers are logged by their
// status alone.

/** Ember's Memberful site, and the keys of its custom app that members sign in with. */
export interface MemberfulKeys {
  /** The site's origin, such as https://example.memberful.com, by which accounts on it are linked. */
  site: string;
  clientId: string;
  clientSecret: string;
}

/** What asking the Memberful site's admin API takes: the site, and its custom app's API key. */
export interface MemberfulApi {
  site: string;
  apiKey: string;
}

/**
 * All Ember has of its Memberful site: the keys members sign in with, and the app's API key and the
 * secret key the site signs its webhooks with, which the deployment's secrets may lack, and the keys an
 * administrator gave always have.
 */
export interface MemberfulSetup extends MemberfulKeys {
  apiKey: string | null;
  webhookSecret: string | null;
}

/** The secrets of a Memberful site that an administrator gave Ember: its custom app's OAuth secret and API key, and its webhook's secret key. */
export interface MemberfulSecrets {
  clientSecret: string;
  apiKey: string;
  webhookSecret: string;
}

/** Someone who signed in to the Memberful site, as its member API describes them. */
export interface MemberfulMember {
  /** Their member id, by which accounts here are linked to theirs. */
  id: string;
  /** Their full name at Memberful, cut to the longest name here, or null when they gave none. */
  fullName: string | null;
  /**
   * What someone new can be called here, the one they'd rather first: their full name, then their email
   * address's local part, passing over @ember's (`namesOf`). They're called the first that isn't an AI
   * agent's, else "Member", or "Member 2" and on while an agent is called that (`namelessMember`).
   */
  names: string[];
  /** Their email address, or null when they have none Ember can keep. */
  emailAddress: string | null;
  /** Whether they have an active subscription, or the all access pass (`unrestrictedAccess`). */
  subscribed: boolean;
}

/** How long Memberful has to answer each request. */
const MEMBERFUL_TIMEOUT_MS = 10_000;
/** What the member API is asked of who signed in. */
const MEMBER_QUERY = "{ currentMember { id email fullName unrestrictedAccess subscriptions { active } } }";
/** What the admin API is asked of each member whose membership is checked. */
const MEMBERSHIP_FIELDS = "{ unrestrictedAccess subscriptions { active } }";
/** What the admin API is asked to try an API key Set up Memberful was given: as little as it answers anything to. */
const API_KEY_QUERY = "{ members(first: 1) { pageInfo { hasNextPage } } }";
/** The longest member id kept: far longer than Memberful's, which are numbers. */
const MAX_SUBJECT_LENGTH = 255;

/**
 * The deployment's Memberful site and keys, which take the place of any an administrator gave, with its
 * API key and webhook's secret if it has them: null without all of `MEMBERFUL_URL`, `MEMBERFUL_CLIENT_ID`
 * and `MEMBERFUL_CLIENT_SECRET`, or with a site that isn't an https address, or an http one on this
 * computer, where the browser tests fake one. The site is the address's origin, so a path or trailing
 * slash after it changes nothing.
 */
export function deployedMemberfulOf(env: Env): MemberfulSetup | null {
  const [url, clientId, clientSecret] = [env.MEMBERFUL_URL?.trim(), env.MEMBERFUL_CLIENT_ID?.trim(), env.MEMBERFUL_CLIENT_SECRET?.trim()];
  if (!url || !clientId || !clientSecret) return null;
  const site = URL.parse(url);
  if (site?.protocol === "https:" || (site?.protocol === "http:" && isLoopback(site))) {
    return { site: site.origin, clientId, clientSecret, apiKey: env.MEMBERFUL_API_KEY?.trim() || null, webhookSecret: env.MEMBERFUL_WEBHOOK_SECRET?.trim() || null };
  }
  console.error("MEMBERFUL_URL must be a Memberful site's https address, such as https://example.memberful.com, so nobody signs in with Memberful");
  return null;
}

/** What asking the Memberful site's admin API takes, or null without its keys, or without the API key among them. */
export const memberfulApiOf = (setup: MemberfulSetup | null): MemberfulApi | null => (setup?.apiKey ? { site: setup.site, apiKey: setup.apiKey } : null);

/**
 * What hearing Memberful's webhooks takes, or null without it all: the Memberful site and its custom
 * app's API key, to check what one says with, and the secret Memberful signs them with.
 */
export function memberfulWebhooksOf(setup: MemberfulSetup | null): { api: MemberfulApi; secret: string } | null {
  const api = memberfulApiOf(setup);
  return api && setup?.webhookSecret ? { api, secret: setup.webhookSecret } : null;
}

/** `secrets`, sealed together under `sessionSecret` (`seal`), as the account keeps them. */
export const sealMemberfulSecrets = (sessionSecret: string, { clientSecret, apiKey, webhookSecret }: MemberfulSecrets) =>
  seal(sessionSecret, "memberful-secrets", JSON.stringify({ client_secret: clientSecret, api_key: apiKey, webhook_secret: webhookSecret }));

/** The secrets `sealed` holds, or null when it doesn't open under `sessionSecret`, as once that's changed. */
export async function openMemberfulSecrets(sessionSecret: string, sealed: string): Promise<MemberfulSecrets | null> {
  const opened = await unseal(sessionSecret, "memberful-secrets", sealed);
  const { client_secret: clientSecret, api_key: apiKey, webhook_secret: webhookSecret } = (opened === null ? {} : JSON.parse(opened)) as Record<string, unknown>;
  return typeof clientSecret === "string" && typeof apiKey === "string" && typeof webhookSecret === "string" ? { clientSecret, apiKey, webhookSecret } : null;
}

/** Whether a subject is one Memberful could have given: a member id, which accounts here are linked by. */
export const isSubject = (subject: unknown): subject is string => typeof subject === "string" && subject !== "" && subject.length <= MAX_SUBJECT_LENGTH;

/**
 * Who signed in at the Memberful site to be given `code`, as its member API says, having exchanged the
 * code for an access token. Null when Memberful refuses the code, or doesn't answer, or not as it should,
 * which is logged without anything it sent.
 */
export async function memberWhoSignedIn({ site, clientId, clientSecret }: MemberfulKeys, code: string): Promise<MemberfulMember | null> {
  try {
    const exchanged = await fetch(new URL("/oauth/token", site), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret }),
      redirect: "manual",
      signal: AbortSignal.timeout(MEMBERFUL_TIMEOUT_MS),
    });
    const accessToken = exchanged.ok ? accessTokenOf(await exchanged.json()) : null;
    if (!accessToken) return refused("token", exchanged);
    const asked = await fetch(new URL(`/api/graphql/member?${new URLSearchParams({ query: MEMBER_QUERY })}`, site), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(MEMBERFUL_TIMEOUT_MS),
    });
    const member = asked.ok ? memberOf(await asked.json()) : null;
    return member ?? refused("member", asked);
  } catch (error) {
    console.error("Signing in with Memberful failed:", error instanceof Error ? error.name : "unknown error");
    return null;
  }
}

/**
 * Whether each of the members of the Memberful site `subjects` name has an active membership, as its
 * admin API says, asked in one request: false for one it answers null for, as GraphQL answers for a
 * member it doesn't have. Null when Memberful doesn't answer, or not as it should, as when it answers
 * with errors, which a wrong API key gets, and a member it failed to describe, and that's logged without
 * anything it sent.
 */
export async function membershipsOf({ site, apiKey }: MemberfulApi, subjects: string[]): Promise<Map<string, boolean> | null> {
  // Each member by an alias of its own, its id written as GraphQL writes a string, as JSON does.
  const query = `{ ${subjects.map((subject, i) => `m${i}: member(id: ${JSON.stringify(subject)}) ${MEMBERSHIP_FIELDS}`).join(" ")} }`;
  try {
    const asked = await fetch(new URL("/api/graphql", site), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query }),
      redirect: "manual",
      signal: AbortSignal.timeout(MEMBERFUL_TIMEOUT_MS),
    });
    const data = asked.ok ? dataOf(await asked.json()) : null;
    if (!data) return refused("admin", asked);
    const memberships = new Map<string, boolean>();
    for (const [i, subject] of subjects.entries()) {
      const member = data[`m${i}`];
      if (member === null) memberships.set(subject, false);
      else if (typeof member === "object") memberships.set(subject, isSubscribed(member as Record<string, unknown>));
      else return refused("admin", asked);
    }
    return memberships;
  } catch (error) {
    console.error("Checking memberships with Memberful failed:", error instanceof Error ? error.name : "unknown error");
    return null;
  }
}

/** Why Memberful didn't take the keys Set up Memberful was given, on the field it's about, if it's about one, and the status that refuses them. */
export interface MemberfulKeysRefusal {
  error: string;
  field?: MemberfulField;
  status: 422 | 502;
}

/** Memberful couldn't be asked, or answered that it couldn't answer, which is about none of the keys. */
const UNCHECKED: MemberfulKeysRefusal = { error: MEMBERFUL_KEYS_UNCHECKED, status: 502 };
const SITE_UNREACHABLE: MemberfulKeysRefusal = { error: MEMBERFUL_SITE_UNREACHABLE, field: "site", status: 422 };
const SITE_UNKNOWN: MemberfulKeysRefusal = { error: MEMBERFUL_SITE_UNKNOWN, field: "site", status: 422 };
const API_KEY_UNKNOWN: MemberfulKeysRefusal = { error: MEMBERFUL_API_KEY_UNKNOWN, field: "apiKey", status: 422 };
const CLIENT_UNKNOWN: MemberfulKeysRefusal = { error: MEMBERFUL_CLIENT_UNKNOWN, field: "clientSecret", status: 422 };

/**
 * Why Memberful doesn't take the keys Set up Memberful was given, or null when it does. The site's admin
 * API is asked something with the API key, which only a Memberful site answers as one does, answering a
 * key it doesn't take with errors, as Memberful documents. Then its token endpoint is sent a code nobody
 * was given, with the OAuth identifier and secret, which it answers `invalid_client` to unless they're
 * one app's (RFC 6749, section 5.2), and `invalid_grant` to if they are. A webhook's secret key can't be
 * tried until a webhook comes.
 */
export async function refusalOfMemberfulKeys({ site, clientId, clientSecret, apiKey }: MemberfulKeysChange): Promise<MemberfulKeysRefusal | null> {
  return (await refusalOfApiKey(site, apiKey)) ?? (await refusalOfClient(site, clientId, clientSecret));
}

/** Why the admin API of the site at `site` doesn't take `apiKey`, or the site isn't a Memberful site, or null when it does and is. */
async function refusalOfApiKey(site: string, apiKey: string): Promise<MemberfulKeysRefusal | null> {
  let asked: Response;
  try {
    asked = await fetch(new URL("/api/graphql", site), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: API_KEY_QUERY }),
      redirect: "manual",
      signal: AbortSignal.timeout(MEMBERFUL_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    console.error("Trying an API key with Memberful failed:", typeof name === "string" ? name : "unknown error");
    // Too slow to answer is no answer, where failing to connect is no site.
    return name === "TimeoutError" ? UNCHECKED : SITE_UNREACHABLE;
  }
  // Cloudflare answers 530 for a host it can't find.
  if (asked.status === 530) return refusing(asked, "admin", SITE_UNREACHABLE);
  if (asked.status === 429 || asked.status >= 500) return refusing(asked, "admin", UNCHECKED);
  if (asked.status === 401 || asked.status === 403) return refusing(asked, "admin", API_KEY_UNKNOWN);
  const answer = (asked.ok ? await asked.json().catch(() => null) : null) as { data?: { members?: unknown } | null; errors?: unknown } | null;
  if (Array.isArray(answer?.errors) && answer.errors.length > 0) return refusing(asked, "admin", API_KEY_UNKNOWN);
  return typeof answer?.data?.members === "object" && answer.data.members !== null ? null : refusing(asked, "admin", SITE_UNKNOWN);
}

/** Why the token endpoint of the Memberful site at `site` doesn't take the app with `clientId` and `clientSecret`, or doesn't say whether it does, or null once it says it does. */
async function refusalOfClient(site: string, clientId: string, clientSecret: string): Promise<MemberfulKeysRefusal | null> {
  let exchanged: Response;
  try {
    exchanged = await fetch(new URL("/oauth/token", site), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: crypto.randomUUID(), client_id: clientId, client_secret: clientSecret }),
      redirect: "manual",
      signal: AbortSignal.timeout(MEMBERFUL_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    console.error("Trying an app's OAuth keys with Memberful failed:", typeof name === "string" ? name : "unknown error");
    return UNCHECKED;
  }
  if (exchanged.status === 429 || exchanged.status >= 500) return refusing(exchanged, "token", UNCHECKED);
  const answer = (await exchanged.json().catch(() => null)) as { error?: unknown } | null;
  if (answer?.error === "invalid_client") return refusing(exchanged, "token", CLIENT_UNKNOWN);
  // A code is checked only once the app's keys are, so only `invalid_grant` says Memberful took them:
  // any other answer, as `invalid_request` is to a request it finds wanting, can come before that.
  return answer?.error === "invalid_grant" ? null : refusing(exchanged, "token", UNCHECKED);
}

/** Logs what Memberful's `endpoint` answered keys Set up Memberful was given, by its status alone, and answers `refusal`. */
async function refusing(response: Response, endpoint: "token" | "admin", refusal: MemberfulKeysRefusal): Promise<MemberfulKeysRefusal> {
  if (!response.bodyUsed) await response.body?.cancel();
  console.error(`Memberful's ${endpoint} endpoint answered ${response.status} to the keys Set up Memberful was given`);
  return refusal;
}

/** Logs that Memberful's `endpoint` didn't answer as it should, with its status only, and answers null. */
async function refused(endpoint: "token" | "member" | "admin", response: Response): Promise<null> {
  if (!response.bodyUsed) await response.body?.cancel();
  console.error(`Memberful's ${endpoint} endpoint answered ${response.status}${response.ok ? " without what it should" : ""}`);
  return null;
}

/** The access token in the token endpoint's answer, if it has one. */
function accessTokenOf(answer: unknown): string | null {
  const token = (answer as { access_token?: unknown } | null)?.access_token;
  return typeof token === "string" && token !== "" ? token : null;
}

/**
 * The `data` of a GraphQL answer, or null for an answer with errors, or without it, which an error that
 * stopped the whole query gives. A field that failed is null in `data`, which would read as a member
 * without a membership, so an answer with any errors is no answer.
 */
function dataOf(answer: unknown): Record<string, unknown> | null {
  const { data, errors } = (answer ?? {}) as { data?: unknown; errors?: unknown };
  if (Array.isArray(errors) && errors.length > 0) return null;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

/** The member the member API's answer describes, or null when it describes none. */
function memberOf(answer: unknown): MemberfulMember | null {
  const member = dataOf(answer)?.currentMember;
  if (typeof member !== "object" || member === null) return null;
  const { id, email, fullName } = member as Record<string, unknown>;
  if (!isSubject(id)) return null;
  const given = typeof email === "string" ? email.trim() : "";
  const emailAddress = given !== "" && given.length <= MAX_EMAIL_ADDRESS_LENGTH ? given : null;
  return {
    id,
    fullName: typeof fullName === "string" ? cutName(fullName) || null : null,
    names: namesOf(fullName, emailAddress),
    emailAddress,
    subscribed: isSubscribed(member as Record<string, unknown>),
  };
}

/** Whether a member Memberful describes has the all access pass (`unrestrictedAccess`), or else an active subscription. */
function isSubscribed({ unrestrictedAccess, subscriptions }: Record<string, unknown>): boolean {
  const active = Array.isArray(subscriptions) && subscriptions.some((subscription) => (subscription as { active?: unknown } | null)?.active === true);
  return unrestrictedAccess === true || active;
}

/** What someone new is called here when Memberful gives no name they can have. */
const NAMELESS_MEMBER = "Member";

/**
 * What someone new is called when none of their names is free, as `free` says: "Member", or else
 * "Member 2", "Member 3" and on, while AI agents are called those. There are only so many agents.
 */
export function namelessMember(free: (name: string) => boolean): string {
  let name = NAMELESS_MEMBER;
  for (let n = 2; !free(name); n++) name = `${NAMELESS_MEMBER} ${n}`;
  return name;
}

/**
 * What someone new can be called here: `fullName`, then their email address's local part, cut to the
 * longest name, passing over either when it's blank or @ember's (`isReservedName`).
 */
function namesOf(fullName: unknown, emailAddress: string | null): string[] {
  const names = [typeof fullName === "string" ? fullName : "", emailAddress?.split("@")[0] ?? ""].map(cutName);
  return names.filter((name) => name && !isReservedName(name));
}

/** `name` without the spaces around it, cut to the longest name, without half of a character cut in two. */
const cutName = (name: string) =>
  name
    .trim()
    .slice(0, MAX_USER_NAME_LENGTH)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd();
