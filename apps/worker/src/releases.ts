import { EMBER_REPOSITORY, isNewer, type CopyOnGitHub, type ReleaseCheck } from "@ember/protocol";
import type { Env } from "./env";
import { isBeta, releaseNameOf, VERSION } from "./version";

// Whether a newer release of Ember is out, which General settings tells administrators, with how to
// update (docs/self-hosting.md#updating). GitHub's address for a repository's latest release redirects to
// that release's page, whose address ends in its tag, and that's all this asks of GitHub, rather than
// asking its API, whose limit of 60 requests an hour for each IP address the many Workers sharing one
// would spend. A repository that has moved redirects to its new address first. Each isolate keeps what
// GitHub said for six hours, and that it didn't say for ten minutes, before asking again, but a check
// made afresh, as opening Admin makes one, and so does its Check for updates, asks again sooner, as the
// project's owner asked (2026-11-05, 2026-11-11): once a minute has passed since the isolate last asked,
// so that going in and out of Admin, or pressing the button again and again, can't keep asking. Each
// answer says when GitHub named the release it names, which General says it last checked. GitHub's
// latest release is never a pre-release, as Ember's betas are, so it's Ember's tags that say which beta
// is newest, as git lists them, the way `git ls-remote` asks, which GitHub answers apart from its API's
// limit. General offers a release the newest beta to try, once it's ahead of the newest release, and
// tells a beta of the next, then of its release (docs/self-hosting.md#betas).

/** Where GitHub sends whoever asks for Ember's latest release. */
const LATEST_RELEASE = `${EMBER_REPOSITORY}/releases/latest`;
const GITHUB = new URL(EMBER_REPOSITORY).origin;
/** What the Worker says it is to GitHub. */
const USER_AGENT = `Ember/${VERSION} (+${EMBER_REPOSITORY})`;
/** Where git asks Ember's repository for its tags, as `git ls-remote` does. */
const UPLOAD_PACK = `${EMBER_REPOSITORY}.git/git-upload-pack`;
/** A line of git's protocol: its length, the four characters that say it among them, in hex, then the line. */
const pktLine = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
/** Git's request, in version 2 of its protocol, for Ember's tags of releases and betas, as `git ls-remote --tags` makes it. */
export const LIST_TAGS = `${pktLine("command=ls-refs\n")}0001${pktLine("ref-prefix refs/tags/v\n")}0000`;
/** What GitHub answers it with, a line for each tag. */
const TAG_LIST = "application/x-git-upload-pack-result";
/** A beta's tag in that answer, such as refs/tags/v0.5.0-beta.1. */
const BETA_TAG = /refs\/tags\/v(\d+\.\d+\.\d+-beta\.\d+)\n/g;
/** How long GitHub has to answer, its redirects and all. */
const CHECK_TIMEOUT_MS = 5_000;
/** The most redirects followed to the latest release's page. */
const MOST_REDIRECTS = 3;
/** How long an isolate keeps the newest release GitHub named, or that it named none. */
export const ANSWER_KEPT_MS = 6 * 60 * 60 * 1000;
export const NO_ANSWER_KEPT_MS = 10 * 60 * 1000;
/** How soon after an isolate last asked GitHub a check made afresh asks again: one made sooner says what GitHub said then. */
export const AFRESH_AFTER_MS = 60 * 1000;

/** The page of a repository's latest release, which redirects to that release's, and that release's, whose path ends in its tag. */
const LATEST_PAGE = /^\/[^/]+\/[^/]+\/releases\/latest$/;
const RELEASE_PAGE = /^\/[^/]+\/[^/]+\/releases\/tag\/v(\d+\.\d+\.\d+(?:-beta\.\d+)?)$/;

/** A release of Ember: its version, such as "0.2.0", and the address of its page on GitHub, which has its notes. */
interface Release {
  version: string;
  page: string;
}

/**
 * The newest release GitHub last named, or null when it named none, when it answered, and until when
 * that's kept, with the newest beta Ember's tags last named, kept through a listing that fails, or null
 * while they've named none.
 */
let heard: { release: Release | null; at: number; beta: Release | null; until: number } | undefined;
/** When this isolate last asked GitHub, or 0 before it has. */
let askedAt = 0;

/** Forgets the newest release GitHub named, and when it was asked, as an isolate starting afresh has, so that the next check asks again. */
export function forgetNewestRelease(): void {
  heard = undefined;
  askedAt = 0;
}

/**
 * What General settings says of releases: this Ember's, and the newest on GitHub, with whether it's newer
 * and when GitHub named it, or null when GitHub didn't name one, the newest beta while it's ahead of that
 * release, and the copy this is on GitHub, which it says how to update. GitHub is asked again only once
 * what it said last is no longer kept, or for a check made `afresh` a minute after this isolate last
 * asked, in a subrequest for each address it redirects to, and one for the tags. Requests that find it
 * due at the same time each ask, since a subrequest belongs to the request that made it, which can end
 * first, but one that hears no release doesn't replace a release another heard meanwhile, or one that's
 * still kept, nor one that hears no tags a beta.
 */
export async function releaseCheck(env: Env, afresh = false): Promise<ReleaseCheck> {
  if (!heard || Date.now() >= heard.until || (afresh && Date.now() >= askedAt + AFRESH_AFTER_MS)) {
    askedAt = Date.now();
    const [[release, at], beta] = await Promise.all([
      newestOnGitHub()
        .catch((error: unknown) => failed("Asking GitHub for Ember's newest release failed:", error, null))
        // When GitHub answered, which can be well before it lists the tags.
        .then((release) => [release, Date.now()] as const),
      newestBetaOnGitHub().catch((error: unknown) => failed("Asking GitHub for Ember's betas failed:", error, undefined)),
    ]);
    const kept = heard && Date.now() < heard.until ? heard : undefined;
    if (kept?.release && !release) heard = beta === undefined ? kept : { ...kept, beta };
    // A beta stays a beta once tagged, so the one heard last stands, however long ago, while the tags don't say.
    else heard = { release, at, beta: beta === undefined ? (heard?.beta ?? null) : beta, until: at + (release ? ANSWER_KEPT_MS : NO_ANSWER_KEPT_MS) };
  }
  const { release: newest, at, beta } = heard;
  return {
    release: releaseNameOf(VERSION),
    beta: isBeta(VERSION),
    newest: newest && named(newest),
    checkedAt: newest && new Date(at).toISOString(),
    newestBeta: newest && beta && isNewer(beta.version, newest.version) ? named(beta) : null,
    copy: copyOf(env),
  };
}

/** A release, or a beta, as General names it, with its version, its notes and whether it's newer than this Ember. */
const named = ({ version, page }: Release) => ({ release: releaseNameOf(version), version, notes: page, newer: isNewer(version, VERSION) });

/** That asking GitHub failed, as `what` and `error` say, which is logged, answering `instead`. */
function failed<T>(what: string, error: unknown, instead: T): T {
  console.warn(what, error instanceof Error ? error.message : "unknown error");
  return instead;
}

/** A repository's `owner/name`, in the characters GitHub allows in each. */
const REPOSITORY = /^[\w-]+\/[\w.-]+$/;

/**
 * The copy of Ember this is on GitHub, as `pnpm run deploy` told the Worker, or null where it didn't,
 * as it doesn't for Ember's own repository, nor for a deploy by any other means.
 */
function copyOf(env: Env): CopyOnGitHub | null {
  const repository = env.GITHUB_REPOSITORY?.trim() ?? "";
  const branch = env.GIT_BRANCH?.trim() ?? "";
  return REPOSITORY.test(repository) && branch ? { repository, branch, workflow: env.UPDATE_WORKFLOW === "true", betaWorkflow: env.BETA_WORKFLOW === "true" } : null;
}

/** Ember's newest release, as GitHub's page for its latest redirects to that release's, or null when it doesn't. */
async function newestOnGitHub(): Promise<Release | null> {
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  let address = LATEST_RELEASE;
  for (let redirects = 0; redirects < MOST_REDIRECTS; redirects++) {
    const answer = await fetch(address, { redirect: "manual", headers: { "User-Agent": USER_AGENT }, signal });
    await answer.body?.cancel();
    const location = answer.status >= 300 && answer.status < 400 ? answer.headers.get("Location") : null;
    if (location === null) return noRelease(`GitHub answered ${answer.status}`);
    const next = new URL(location, address);
    const version = next.origin === GITHUB ? RELEASE_PAGE.exec(next.pathname)?.[1] : undefined;
    // Never a beta, which GitHub doesn't take for the latest, but should it name one, nobody on a release hears of it.
    if (version && isBeta(version) && !isBeta(VERSION)) return noRelease(`GitHub's latest release is a beta, ${next.href}`);
    if (version) return { version, page: next.href };
    if (next.origin !== GITHUB || !LATEST_PAGE.test(next.pathname)) return noRelease(`GitHub redirected to ${next.href}`);
    address = next.href;
  }
  return noRelease(`GitHub redirected more than ${MOST_REDIRECTS} times`);
}

/** That GitHub didn't name a release, as `why` says, which is logged. */
function noRelease(why: string): null {
  console.warn(`GitHub didn't name Ember's newest release: ${why}`);
  return null;
}

/**
 * Ember's newest beta, as git lists its tags, or null when it has none, or undefined when GitHub didn't
 * say. Its notes are its release's page, as the Release workflow publishes a release for each tag.
 */
async function newestBetaOnGitHub(): Promise<Release | null | undefined> {
  const answer = await fetch(UPLOAD_PACK, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Git-Protocol": "version=2", "Content-Type": "application/x-git-upload-pack-request", Accept: TAG_LIST },
    body: LIST_TAGS,
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  const type = answer.headers.get("Content-Type") ?? "";
  if (!answer.ok || !type.startsWith(TAG_LIST)) {
    await answer.body?.cancel();
    return noBetas(answer.ok ? `GitHub answered ${type || "without a Content-Type"}` : `GitHub answered ${answer.status}`);
  }
  // Decoded rather than read as text, which workerd warns of for a type that isn't text's.
  const betas = [...new TextDecoder().decode(await answer.arrayBuffer()).matchAll(BETA_TAG)].map(([, version]) => version!);
  const newest = betas.reduce<string | undefined>((newest, version) => (newest === undefined || isNewer(version, newest) ? version : newest), undefined);
  return newest === undefined ? null : { version: newest, page: `${EMBER_REPOSITORY}/releases/tag/v${newest}` };
}

/** That GitHub didn't list Ember's tags, as `why` says, which is logged. */
function noBetas(why: string): undefined {
  console.warn(`GitHub didn't list Ember's betas: ${why}`);
  return undefined;
}
