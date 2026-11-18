import { EMBER_REPOSITORY, type NewWorkspace, type ReleaseCheck } from "@ember/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AFRESH_AFTER_MS, ANSWER_KEPT_MS, forgetNewestRelease, LIST_TAGS, NO_ANSWER_KEPT_MS } from "../src/releases";
import { isBeta, releaseNameOf, VERSION } from "../src/version";
import type { Env } from "../src/env";
import { api, apiWith, cookieOf, freshDeploy, shown, signIn, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Asks, as `session`, for the release this Ember is and the newest, as General settings does. */
const checkRelease = (session: Session | null) => api("/api/account/release", { headers: as(session) });
/** And afresh, as opening Admin does. */
const checkReleaseAfresh = (session: Session | null) => api("/api/account/release_checks", { method: "POST", headers: as(session) });

/** What `session` hears of releases, which has to answer, asked as `check` asks. */
async function releaseCheckFor(session: Session, check = checkRelease): Promise<ReleaseCheck> {
  const response = await check(session);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return response.json();
}

/** Where GitHub sends whoever asks for Ember's latest release. */
const LATEST = `${EMBER_REPOSITORY}/releases/latest`;
/** The page of Ember's release `version`, as GitHub names it. */
const pageOf = (version: string) => `${EMBER_REPOSITORY}/releases/tag/v${version}`;
/** A version after this Ember's, and one before every release. */
const NEXT = `${Number(VERSION.split(".")[0]) + 1}.0.0`;
const FIRST = "0.0.1";

/** What GitHub answers a request for a page that's moved to `location`. */
const redirectTo = (location: string, status = 302) => new Response("<html><body>You are being redirected.</body></html>", { status, headers: { Location: location } });

/** A request the fake GitHub was sent. */
interface Asked {
  url: string;
  redirect: string;
  userAgent: string | null;
}

/** Where git asks Ember's repository for its tags. */
const UPLOAD_PACK = `${EMBER_REPOSITORY}.git/git-upload-pack`;

/** What GitHub answers git's request for Ember's tags: one for each of `versions`, in git's protocol. */
function tagsOf(...versions: string[]): Response {
  const line = (text: string) => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
  const lines = versions.map((version, at) => line(`${String(at).padStart(40, "0")} refs/tags/v${version}\n`));
  return new Response(`${lines.join("")}0000`, { headers: { "Content-Type": "application/x-git-upload-pack-result" } });
}

/** A request for Ember's tags the fake GitHub was sent, read as it came, since its body can't be read after. */
interface AskedForTags {
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** The requests for Ember's tags the fake GitHub was sent, apart from those for its latest release. */
let askedForTags: AskedForTags[] = [];

/**
 * Stands in for GitHub, answering each request for Ember's latest release as `answer` does, by its
 * address, and keeping what it's asked, and each for its tags as `tags` does, which lists none unless given.
 */
function fakeGitHub(answer: (url: string) => Response | Promise<Response>, tags: () => Response | Promise<Response> = () => tagsOf()) {
  const asked: Asked[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === UPLOAD_PACK) {
      askedForTags.push({ method: request.method, headers: Object.fromEntries(request.headers), body: new TextDecoder().decode(await request.arrayBuffer()) });
      return tags();
    }
    asked.push({ url: request.url, redirect: request.redirect, userAgent: request.headers.get("User-Agent") });
    return answer(request.url);
  });
  return asked;
}

/** Stands in for GitHub with `version` as Ember's latest release. */
const latestIs = (version: string) => fakeGitHub(() => redirectTo(pageOf(version)));

beforeEach(async () => {
  askedForTags = [];
  await freshDeploy();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Checking for a newer release", () => {
  it("says GitHub's newest release is newer than this one, with its notes, as GitHub's latest release redirects to it", async () => {
    const administrator = await setUp();
    const asked = latestIs(NEXT);
    const response = await checkRelease(administrator);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      release: releaseNameOf(VERSION),
      beta: isBeta(VERSION),
      newest: { release: releaseNameOf(NEXT), version: NEXT, notes: pageOf(NEXT), newer: true },
      checkedAt: expect.any(String),
      newestBeta: null,
      copy: null,
    });
    expect(asked).toEqual([{ url: LATEST, redirect: "manual", userAgent: `Ember/${VERSION} (+${EMBER_REPOSITORY})` }]);
  });

  it("says this one is the newest when GitHub's is the same, or older, as when Ember is ahead of its last release", async () => {
    const administrator = await setUp();
    for (const [version, name] of [
      [VERSION, releaseNameOf(VERSION)],
      [FIRST, FIRST],
    ] as const) {
      forgetNewestRelease();
      latestIs(version);
      expect(await releaseCheckFor(administrator)).toEqual({
        release: releaseNameOf(VERSION),
        beta: isBeta(VERSION),
        newest: { release: name, version, notes: pageOf(version), newer: false },
        checkedAt: expect.any(String),
        newestBeta: null,
        copy: null,
      });
    }
  });

  it("compares versions by their numbers, not as text", async () => {
    const administrator = await setUp();
    const [major, minor, patch] = /^(\d+)\.(\d+)\.(\d+)/.exec(VERSION)!.slice(1).map(Number) as [number, number, number];
    const later = [`${major}.${minor}.${patch + 10}`, `${major}.${minor + 10}.0`, `${major + 10}.0.0`];
    const earlier = [major > 0 && `${major - 1}.99.99`, minor > 0 && `${major}.${minor - 1}.99`].filter((version): version is string => version !== false);
    for (const [version, newer] of [...later.map((version) => [version, true] as const), ...earlier.map((version) => [version, false] as const)]) {
      forgetNewestRelease();
      latestIs(version);
      expect((await releaseCheckFor(administrator)).newest?.newer, version).toBe(newer);
    }
  });

  it("names a beta for its release, as 0.5 beta 1, and a release without its trailing .0", () => {
    expect(["0.5.0-beta.1", "0.5.1-beta.12", "1.0.0", "0.10.0", "0.4.2", "0.5.10"].map(releaseNameOf)).toEqual(["0.5 beta 1", "0.5.1 beta 12", "1.0", "0.10", "0.4.2", "0.5.10"]);
    expect(["0.5.0-beta.1", "0.5.0", "0.5.0-rc.1"].map(isBeta)).toEqual([true, false, false]);
  });

  // GitHub never takes a pre-release for the latest, but this Ember is on a release only while its version is one.
  it.skipIf(isBeta(VERSION))("tells an Ember on a release nothing of a beta, should GitHub name one its latest", async () => {
    const administrator = await setUp();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const beta = `${Number(VERSION.split(".")[0]) + 1}.0.0-beta.1`;
    latestIs(beta);
    expect(await releaseCheckFor(administrator)).toEqual({ release: releaseNameOf(VERSION), beta: false, newest: null, checkedAt: null, newestBeta: null, copy: null });
    expect(logged.mock.calls).toEqual([[`GitHub didn't name Ember's newest release: GitHub's latest release is a beta, ${pageOf(beta)}`]]);
  });

  it("follows Ember's repository to where it's moved, as GitHub redirects there first", async () => {
    const administrator = await setUp();
    const moved = "https://github.com/someone-else/ember";
    const asked = fakeGitHub((url) => (url === LATEST ? redirectTo(`${moved}/releases/latest`, 301) : redirectTo(`${moved}/releases/tag/v${NEXT}`)));
    expect((await releaseCheckFor(administrator)).newest).toEqual({ release: releaseNameOf(NEXT), version: NEXT, notes: `${moved}/releases/tag/v${NEXT}`, newer: true });
    expect(asked.map(({ url }) => url)).toEqual([LATEST, `${moved}/releases/latest`]);
  });

  it("says GitHub named no release when it doesn't redirect to one, which it logs", async () => {
    const administrator = await setUp();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failures: Array<() => Response | Promise<Response>> = [
      () => new Response("<html>releases</html>"),
      () => new Response("Not Found", { status: 404 }),
      () => new Response("Too many requests", { status: 429 }),
      () => redirectTo("https://github.com/login?return_to=%2Freleases"),
      () => redirectTo("https://example.com/releases/tag/v99.0.0"),
      () => redirectTo(`${EMBER_REPOSITORY}/releases/tag/v1.2`),
      () => redirectTo(LATEST),
      () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    ];
    let failure = failures[0]!;
    fakeGitHub(() => failure());
    for (failure of failures) {
      forgetNewestRelease();
      expect(await releaseCheckFor(administrator)).toEqual({ release: releaseNameOf(VERSION), beta: isBeta(VERSION), newest: null, checkedAt: null, newestBeta: null, copy: null });
    }
    expect(logged.mock.calls).toEqual([
      ["GitHub didn't name Ember's newest release: GitHub answered 200"],
      ["GitHub didn't name Ember's newest release: GitHub answered 404"],
      ["GitHub didn't name Ember's newest release: GitHub answered 429"],
      ["GitHub didn't name Ember's newest release: GitHub redirected to https://github.com/login?return_to=%2Freleases"],
      ["GitHub didn't name Ember's newest release: GitHub redirected to https://example.com/releases/tag/v99.0.0"],
      [`GitHub didn't name Ember's newest release: GitHub redirected to ${EMBER_REPOSITORY}/releases/tag/v1.2`],
      ["GitHub didn't name Ember's newest release: GitHub redirected more than 3 times"],
      ["Asking GitHub for Ember's newest release failed:", "The operation was aborted due to timeout"],
    ]);
  });

  it("asks GitHub again only once six hours have passed since it named a release, or ten minutes since it named none", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let answer = () => new Response("Unavailable", { status: 503 });
    const asked = fakeGitHub(() => answer());
    const start = Date.now();
    // The Worker runs in this isolate, so it sees the faked clock too.
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    expect((await releaseCheckFor(administrator)).newest).toBeNull();
    answer = () => redirectTo(pageOf(NEXT));
    vi.setSystemTime(start + NO_ANSWER_KEPT_MS - 1);
    expect((await releaseCheckFor(administrator)).newest).toBeNull();
    expect(asked).toHaveLength(1);

    vi.setSystemTime(start + NO_ANSWER_KEPT_MS);
    const named = { release: releaseNameOf(NEXT), version: NEXT, notes: pageOf(NEXT), newer: true };
    expect((await releaseCheckFor(administrator)).newest).toEqual(named);
    expect(asked).toHaveLength(2);
    answer = () => redirectTo(pageOf(VERSION));
    vi.setSystemTime(start + NO_ANSWER_KEPT_MS + ANSWER_KEPT_MS - 1);
    expect((await releaseCheckFor(administrator)).newest).toEqual(named);
    expect(asked).toHaveLength(2);

    vi.setSystemTime(start + NO_ANSWER_KEPT_MS + ANSWER_KEPT_MS);
    expect((await releaseCheckFor(administrator)).newest).toEqual({ release: releaseNameOf(VERSION), version: VERSION, notes: pageOf(VERSION), newer: false });
    expect(asked).toHaveLength(3);
    // Ember's tags, for its newest beta, each time with the release.
    expect(askedForTags).toHaveLength(3);
  });

  it("keeps a release GitHub named for one request when another's check, made at the same time, fails after it", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The first request to ask GitHub hears nothing back until the second has had its answer.
    let answerFirst = false;
    const asked = fakeGitHub(async () => {
      if (asked.length > 1) return redirectTo(pageOf(NEXT));
      while (!answerFirst) await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response("Unavailable", { status: 503 });
    });
    const named = { release: releaseNameOf(NEXT), version: NEXT, notes: pageOf(NEXT), newer: true };
    const newestIn = async (response: Response) => ((await response.json()) as ReleaseCheck).newest;
    const checks = [checkRelease(administrator), checkRelease(administrator)];
    expect(await newestIn((await Promise.race(checks)).clone())).toEqual(named);
    answerFirst = true;
    expect(await Promise.all(checks.map(async (check) => newestIn(await check)))).toEqual([named, named]);
    expect((await releaseCheckFor(administrator)).newest).toEqual(named);
    expect(asked).toHaveLength(2);
  });

  it("answers only administrators, asking GitHub nothing for anyone else, or for another site", async () => {
    const administrator = await setUp();
    const asked = latestIs(NEXT);
    const member = await signIn("Grace");
    for (const check of [checkRelease, checkReleaseAfresh]) {
      expect((await check(null)).status).toBe(401);
      const refused = await check(member);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "Only administrators can change the workspace" });
    }
    const forged = await api("/api/account/release_checks", { method: "POST", headers: { ...as(administrator), "Sec-Fetch-Site": "cross-site" } });
    expect(forged.status).toBe(422);
    expect(asked).toEqual([]);
    expect(askedForTags).toEqual([]);
  });
});

describe("Checking afresh, as opening Admin does", () => {
  it("asks GitHub again, once a minute has passed since it last asked, and keeps what it hears for six hours", async () => {
    const administrator = await setUp();
    let latest = VERSION;
    const asked = fakeGitHub(() => redirectTo(pageOf(latest)));
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const newest = { release: releaseNameOf(VERSION), version: VERSION, notes: pageOf(VERSION), newer: false };
    expect((await releaseCheckFor(administrator)).newest).toEqual(newest);
    // GitHub publishes a newer release, which an ordinary check doesn't hear of for six hours.
    latest = NEXT;
    vi.setSystemTime(start + AFRESH_AFTER_MS - 1);
    expect((await releaseCheckFor(administrator)).newest).toEqual(newest);
    expect((await releaseCheckFor(administrator, checkReleaseAfresh)).newest).toEqual(newest);
    expect(asked).toHaveLength(1);

    vi.setSystemTime(start + AFRESH_AFTER_MS);
    const next = { release: releaseNameOf(NEXT), version: NEXT, notes: pageOf(NEXT), newer: true };
    expect(await releaseCheckFor(administrator, checkReleaseAfresh)).toEqual({
      release: releaseNameOf(VERSION),
      beta: isBeta(VERSION),
      newest: next,
      checkedAt: new Date(start + AFRESH_AFTER_MS).toISOString(),
      newestBeta: null,
      copy: null,
    });
    expect(asked.map(({ url }) => url)).toEqual([LATEST, LATEST]);
    // Ordinary checks say so too, for six hours from then, and another made afresh within the minute asks nothing.
    expect((await releaseCheckFor(administrator)).newest).toEqual(next);
    vi.setSystemTime(start + 2 * AFRESH_AFTER_MS - 1);
    expect((await releaseCheckFor(administrator, checkReleaseAfresh)).newest).toEqual(next);
    vi.setSystemTime(start + AFRESH_AFTER_MS + ANSWER_KEPT_MS - 1);
    expect((await releaseCheckFor(administrator)).newest).toEqual(next);
    expect(asked).toHaveLength(2);
    vi.setSystemTime(start + AFRESH_AFTER_MS + ANSWER_KEPT_MS);
    expect((await releaseCheckFor(administrator)).newest).toEqual(next);
    expect(asked).toHaveLength(3);
  });

  it("asks GitHub for a check made afresh where it hasn't asked yet, as a new isolate hasn't", async () => {
    const administrator = await setUp();
    const asked = latestIs(NEXT);
    expect((await releaseCheckFor(administrator, checkReleaseAfresh)).newest).toEqual({ release: releaseNameOf(NEXT), version: NEXT, notes: pageOf(NEXT), newer: true });
    expect(asked).toHaveLength(1);
  });

  it("keeps the release GitHub named when a check made afresh hears none, asking again only after another minute", async () => {
    const administrator = await setUp();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    let answer = () => redirectTo(pageOf(NEXT));
    const asked = fakeGitHub(() => answer());
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const next = { release: releaseNameOf(NEXT), version: NEXT, notes: pageOf(NEXT), newer: true };
    expect((await releaseCheckFor(administrator)).newest).toEqual(next);

    answer = () => new Response("Unavailable", { status: 503 });
    vi.setSystemTime(start + AFRESH_AFTER_MS);
    expect((await releaseCheckFor(administrator, checkReleaseAfresh)).newest).toEqual(next);
    expect(logged.mock.calls).toEqual([["GitHub didn't name Ember's newest release: GitHub answered 503"]]);
    vi.setSystemTime(start + 2 * AFRESH_AFTER_MS - 1);
    expect((await releaseCheckFor(administrator, checkReleaseAfresh)).newest).toEqual(next);
    expect((await releaseCheckFor(administrator)).newest).toEqual(next);
    expect(asked).toHaveLength(2);
    vi.setSystemTime(start + 2 * AFRESH_AFTER_MS);
    expect((await releaseCheckFor(administrator, checkReleaseAfresh)).newest).toEqual(next);
    expect(asked).toHaveLength(3);
  });

  it("says when GitHub named the release, which General says it last checked, renewed by asking again but not by hearing none", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let answer = () => redirectTo(pageOf(NEXT));
    fakeGitHub(() => answer());
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const at = (time: number) => new Date(time).toISOString();
    expect((await releaseCheckFor(administrator)).checkedAt).toBe(at(start));
    // Kept with the release, as ordinary checks say it, and one made afresh within the minute.
    vi.setSystemTime(start + AFRESH_AFTER_MS - 1);
    expect((await releaseCheckFor(administrator)).checkedAt).toBe(at(start));
    expect((await releaseCheckFor(administrator, checkReleaseAfresh)).checkedAt).toBe(at(start));
    vi.setSystemTime(start + AFRESH_AFTER_MS);
    expect((await releaseCheckFor(administrator, checkReleaseAfresh)).checkedAt).toBe(at(start + AFRESH_AFTER_MS));

    // A check that hears no release says when GitHub named the one kept, and once none is, nothing of when.
    answer = () => new Response("Unavailable", { status: 503 });
    vi.setSystemTime(start + 2 * AFRESH_AFTER_MS);
    const next = { release: releaseNameOf(NEXT), version: NEXT, notes: pageOf(NEXT), newer: true };
    expect(await releaseCheckFor(administrator, checkReleaseAfresh)).toMatchObject({ newest: next, checkedAt: at(start + AFRESH_AFTER_MS) });
    vi.setSystemTime(start + AFRESH_AFTER_MS + ANSWER_KEPT_MS);
    expect(await releaseCheckFor(administrator)).toMatchObject({ newest: null, checkedAt: null });
  });

  it("says GitHub named the release when it did, though it lists the tags seconds after", async () => {
    const administrator = await setUp();
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    fakeGitHub(
      () => redirectTo(pageOf(NEXT)),
      async () => {
        // Long after the release is named, which takes no time here.
        await new Promise((resolve) => setTimeout(resolve, 50));
        vi.setSystemTime(start + 3_000);
        return tagsOf();
      },
    );
    expect((await releaseCheckFor(administrator)).checkedAt).toBe(new Date(start).toISOString());
  });
});

describe("Ember's newest beta", () => {
  const major = Number(VERSION.split(".")[0]);
  /** A beta of the release after this Ember's, which comes before it, and the betas of the release after that. */
  const NEXTS_BETA = `${major + 1}.0.0-beta.3`;
  const betaAfter = (beta: number) => `${major + 2}.0.0-beta.${beta}`;
  /** What the check says of `version`, as General names it, with its notes. */
  const namedAs = (version: string, newer: boolean) => ({ release: releaseNameOf(version), version, notes: pageOf(version), newer });

  it("names the newest beta among the tags git lists while it's ahead of the newest release, asking as git ls-remote does", async () => {
    const administrator = await setUp();
    const asked = fakeGitHub(() => redirectTo(pageOf(NEXT)), () => tagsOf(FIRST, NEXTS_BETA, NEXT, betaAfter(9), betaAfter(10), betaAfter(2)));
    const check = await releaseCheckFor(administrator);
    expect(check.newest).toEqual(namedAs(NEXT, true));
    // Beta 10 is after beta 9, by its number.
    expect(check.newestBeta).toEqual(namedAs(betaAfter(10), true));
    expect(asked).toHaveLength(1);
    expect(askedForTags).toHaveLength(1);
    // Git's request for the tags starting v, in lines that each start with their length.
    expect(askedForTags).toEqual([
      {
        method: "POST",
        headers: {
          "user-agent": `Ember/${VERSION} (+${EMBER_REPOSITORY})`,
          "git-protocol": "version=2",
          "content-type": "application/x-git-upload-pack-request",
          accept: "application/x-git-upload-pack-result",
        },
        body: "0014command=ls-refs\n0001001bref-prefix refs/tags/v\n0000",
      },
    ]);
    expect(LIST_TAGS).toBe(askedForTags[0]!.body);
  });

  it("names none while the newest beta is behind the newest release, or Ember has no beta", async () => {
    const administrator = await setUp();
    for (const tags of [[FIRST, NEXTS_BETA, NEXT], [FIRST, NEXT], []]) {
      forgetNewestRelease();
      fakeGitHub(() => redirectTo(pageOf(NEXT)), () => tagsOf(...tags));
      const check = await releaseCheckFor(administrator);
      expect(check.newest, tags.join()).toEqual(namedAs(NEXT, true));
      expect(check.newestBeta, tags.join()).toBeNull();
    }
  });

  it("says whether the beta is newer than this Ember", async () => {
    const administrator = await setUp();
    const older = "0.0.2-beta.1";
    fakeGitHub(() => redirectTo(pageOf(FIRST)), () => tagsOf(FIRST, older));
    expect((await releaseCheckFor(administrator)).newestBeta).toEqual(namedAs(older, false));
  });

  it("names no beta while GitHub names no release, as it can't say the beta is ahead of it", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeGitHub(() => new Response("Not Found", { status: 404 }), () => tagsOf(NEXT, betaAfter(1)));
    expect(await releaseCheckFor(administrator)).toMatchObject({ newest: null, newestBeta: null });
  });

  it("says nothing of a beta when GitHub doesn't list Ember's tags, which it logs, though it names the release", async () => {
    const administrator = await setUp();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failures: Array<() => Response | Promise<Response>> = [
      () => new Response("Unavailable", { status: 503 }),
      () => new Response("<html>ember-cloudflare</html>", { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      () => new Response(new TextEncoder().encode("0000")),
      () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    ];
    let failure = failures[0]!;
    fakeGitHub(() => redirectTo(pageOf(NEXT)), () => failure());
    for (failure of failures) {
      forgetNewestRelease();
      expect(await releaseCheckFor(administrator)).toMatchObject({ newest: namedAs(NEXT, true), newestBeta: null });
    }
    expect(logged.mock.calls).toEqual([
      ["GitHub didn't list Ember's betas: GitHub answered 503"],
      ["GitHub didn't list Ember's betas: GitHub answered text/html; charset=utf-8"],
      ["GitHub didn't list Ember's betas: GitHub answered without a Content-Type"],
      ["Asking GitHub for Ember's betas failed:", "The operation was aborted due to timeout"],
    ]);
  });

  it("keeps the beta it heard when a later ask lists no tags, however long ago it heard it, and hears a newer one while it keeps the release", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let release = () => redirectTo(pageOf(NEXT));
    let tags = () => tagsOf(NEXT, betaAfter(1));
    fakeGitHub(
      () => release(),
      () => tags(),
    );
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    expect((await releaseCheckFor(administrator)).newestBeta).toEqual(namedAs(betaAfter(1), true));

    // GitHub doesn't list the tags when Admin opens a minute later, so the beta heard first stays.
    tags = () => new Response("Unavailable", { status: 503 });
    vi.setSystemTime(start + AFRESH_AFTER_MS);
    expect((await releaseCheckFor(administrator, checkReleaseAfresh)).newestBeta).toEqual(namedAs(betaAfter(1), true));

    // Nor names the latest release a minute after that, but lists a newer beta, which it names, ahead of the release kept.
    release = () => new Response("Unavailable", { status: 503 });
    tags = () => tagsOf(NEXT, betaAfter(1), betaAfter(2));
    vi.setSystemTime(start + 2 * AFRESH_AFTER_MS);
    const check = await releaseCheckFor(administrator, checkReleaseAfresh);
    expect(check.newest).toEqual(namedAs(NEXT, true));
    expect(check.newestBeta).toEqual(namedAs(betaAfter(2), true));
    expect(askedForTags).toHaveLength(3);

    // Once the release heard a minute in is no longer kept, GitHub names it again but doesn't list the tags,
    // and the beta heard last stays.
    release = () => redirectTo(pageOf(NEXT));
    tags = () => new Response("Unavailable", { status: 503 });
    vi.setSystemTime(start + AFRESH_AFTER_MS + ANSWER_KEPT_MS);
    expect(await releaseCheckFor(administrator)).toMatchObject({ newest: namedAs(NEXT, true), newestBeta: namedAs(betaAfter(2), true) });
    expect(askedForTags).toHaveLength(4);
  });
});

describe("The copy of Ember on GitHub", () => {
  /** What the release check says of the copy, asked as `path` asks, of a Worker deployed with `vars`. */
  async function copyWith(session: Session, vars: Partial<Env>, path = "/api/account/release") {
    const response = await apiWith(vars, path, { method: path.endsWith("checks") ? "POST" : "GET", headers: as(session) });
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as ReleaseCheck).copy;
  }

  it("names the copy the deploy told the Worker of, with the branch that deploys and whether it has the Update Ember workflow and the beta workflow", async () => {
    const administrator = await setUp();
    latestIs(NEXT);
    for (const path of ["/api/account/release", "/api/account/release_checks"]) {
      expect(await copyWith(administrator, { GITHUB_REPOSITORY: "someone/my-ember", GIT_BRANCH: "main", UPDATE_WORKFLOW: "true", BETA_WORKFLOW: "true" }, path)).toEqual({
        repository: "someone/my-ember",
        branch: "main",
        workflow: true,
        betaWorkflow: true,
      });
    }
    expect(await copyWith(administrator, { GITHUB_REPOSITORY: " Some-One/my.ember_2 ", GIT_BRANCH: "release/v1#stable", UPDATE_WORKFLOW: "false", BETA_WORKFLOW: "false" })).toEqual({
      repository: "Some-One/my.ember_2",
      branch: "release/v1#stable",
      workflow: false,
      betaWorkflow: false,
    });
    expect(await copyWith(administrator, { GITHUB_REPOSITORY: "someone/my-ember", GIT_BRANCH: "main", BETA_WORKFLOW: "true" })).toEqual({
      repository: "someone/my-ember",
      branch: "main",
      workflow: false,
      betaWorkflow: true,
    });
    expect(await copyWith(administrator, { GITHUB_REPOSITORY: "someone/my-ember", GIT_BRANCH: "main" })).toEqual({ repository: "someone/my-ember", branch: "main", workflow: false, betaWorkflow: false });
  });

  it.each<Partial<Env>>([
    {},
    { GITHUB_REPOSITORY: "someone/my-ember" },
    { GITHUB_REPOSITORY: "someone/my-ember", GIT_BRANCH: " ", UPDATE_WORKFLOW: "true" },
    { GITHUB_REPOSITORY: "", GIT_BRANCH: "main" },
    { GITHUB_REPOSITORY: "someone", GIT_BRANCH: "main" },
    { GITHUB_REPOSITORY: "someone/my-ember/actions", GIT_BRANCH: "main" },
    { GITHUB_REPOSITORY: "https://github.com/someone/my-ember", GIT_BRANCH: "main" },
    { GITHUB_REPOSITORY: "some one/my-ember", GIT_BRANCH: "main" },
    { GITHUB_REPOSITORY: "../my-ember", GIT_BRANCH: "main" },
  ])("names none where the deploy told the Worker of none, or of what isn't a repository and a branch (%j)", async (vars) => {
    const administrator = await setUp();
    latestIs(NEXT);
    expect(await copyWith(administrator, vars)).toBeNull();
  });
});
