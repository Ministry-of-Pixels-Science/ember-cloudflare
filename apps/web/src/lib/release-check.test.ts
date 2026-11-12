import { describe, expect, it } from "vitest";
import type { ReleaseCheck } from "@ember/protocol";
import { betaToTryOf, updateOf } from "./release-check";

const RELEASES = "https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag";
/** Ember `release`, or its beta, as the Worker names it, newer than this one or not. */
const named = (release: string, version: string, newer: boolean) => ({ release, version, notes: `${RELEASES}/v${version}`, newer });
/** What the Worker says of releases to an Ember on `release`, a beta or not, having heard from GitHub just now. */
const checkOf = (release: string, beta: boolean, newest: ReleaseCheck["newest"], newestBeta: ReleaseCheck["newestBeta"]): ReleaseCheck => ({
  release,
  beta,
  newest,
  checkedAt: newest && new Date().toISOString(),
  newestBeta,
  copy: null,
});

describe("What Update Ember would bring", () => {
  it("is the newest release once it's newer, a beta of it or not", () => {
    const release = named("0.5", "0.5.0", true);
    expect(updateOf(checkOf("0.4.2", false, release, null))).toBe(release);
    expect(updateOf(checkOf("0.5 beta 2", true, release, named("0.6 beta 1", "0.6.0-beta.1", true)))).toBe(release);
  });

  it("is, for a beta, the beta after it until its release is out, but nothing for a release", () => {
    const next = named("0.5 beta 2", "0.5.0-beta.2", true);
    expect(updateOf(checkOf("0.5 beta 1", true, named("0.4.2", "0.4.2", false), next))).toBe(next);
    expect(updateOf(checkOf("0.4.2", false, named("0.4.2", "0.4.2", false), next))).toBeNull();
    expect(updateOf(checkOf("0.5 beta 2", true, named("0.4.2", "0.4.2", false), { ...next, newer: false }))).toBeNull();
    expect(updateOf(checkOf("0.5 beta 1", true, null, null))).toBeNull();
  });
});

describe("The beta to try", () => {
  it("is the newest beta for a release on the newest release", () => {
    const beta = named("0.6 beta 1", "0.6.0-beta.1", true);
    expect(betaToTryOf(checkOf("0.5", false, named("0.5", "0.5.0", false), beta))).toBe(beta);
  });

  it("is none while a newer release is out to update to, for a beta, or while there's no newer beta", () => {
    const beta = named("0.6 beta 1", "0.6.0-beta.1", true);
    expect(betaToTryOf(checkOf("0.4.2", false, named("0.5", "0.5.0", true), beta))).toBeNull();
    expect(betaToTryOf(checkOf("0.6 beta 1", true, named("0.5", "0.5.0", false), { ...beta, newer: false }))).toBeNull();
    expect(betaToTryOf(checkOf("0.5 beta 3", true, named("0.4.2", "0.4.2", false), named("0.6 beta 1", "0.6.0-beta.1", true)))).toBeNull();
    expect(betaToTryOf(checkOf("0.5", false, named("0.5", "0.5.0", false), null))).toBeNull();
  });
});
