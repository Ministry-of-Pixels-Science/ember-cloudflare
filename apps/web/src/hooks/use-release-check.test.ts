import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseCheck } from "@ember/protocol";
import { checkForRelease, checkForReleaseAfresh } from "@/lib/api";
import { useReleaseCheck } from "./use-release-check";

vi.mock("@/lib/api", () => ({ checkForRelease: vi.fn(), checkForReleaseAfresh: vi.fn() }));

/** When GitHub named a release to the Worker, minutes past 4 PM. */
const minutesPast = (minutes: number) => new Date(Date.UTC(2026, 10, 11, 16, minutes)).toISOString();

/** What the Worker says of releases while `newest` is GitHub's newest, after this Ember's 0.1, as GitHub named it `checkedAt`. */
const newestIs = (newest: string, checkedAt = minutesPast(Number(newest.split(".")[1]))): ReleaseCheck => ({
  release: "0.1",
  beta: false,
  newest: { release: newest, version: `${newest}.0`, notes: `https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v${newest}.0`, newer: true },
  checkedAt,
  newestBeta: null,
  copy: null,
});

/** And with Ember's tags naming 0.4's `beta`th beta, ahead of that release. */
const withBeta = (check: ReleaseCheck, beta: number): ReleaseCheck => ({
  ...check,
  newestBeta: { release: `0.4 beta ${beta}`, version: `0.4.0-beta.${beta}`, notes: `https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v0.4.0-beta.${beta}`, newer: true },
});

/** And while this Ember is 0.5's `release`th beta, its tags name the `newestBeta`th, and GitHub named 0.4, the newest release, `checkedAt`. */
const onBeta = (release: number, newestBeta: number, checkedAt: string): ReleaseCheck => ({
  release: `0.5 beta ${release}`,
  beta: true,
  newest: { release: "0.4", version: "0.4.0", notes: "https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v0.4.0", newer: false },
  checkedAt,
  newestBeta: {
    release: `0.5 beta ${newestBeta}`,
    version: `0.5.0-beta.${newestBeta}`,
    notes: `https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v0.5.0-beta.${newestBeta}`,
    newer: newestBeta > release,
  },
  copy: null,
});

/** The browser's idle callbacks, which run when a test says, unless they're cancelled first. */
const idle = new Map<number, () => void>();
let lastIdle = 0;

/** Runs the idle callbacks waiting. */
function becomeIdle() {
  const waiting = [...idle.values()];
  idle.clear();
  act(() => waiting.forEach((run) => run()));
}

/** How many times the Worker was asked, and how many of those afresh. */
const asked = () => [vi.mocked(checkForRelease).mock.calls.length, vi.mocked(checkForReleaseAfresh).mock.calls.length];

beforeEach(() => {
  vi.stubGlobal("requestIdleCallback", (run: () => void) => {
    idle.set(++lastIdle, run);
    return lastIdle;
  });
  vi.stubGlobal("cancelIdleCallback", (handle: number) => idle.delete(handle));
  vi.mocked(checkForRelease).mockResolvedValue(newestIs("0.2"));
  vi.mocked(checkForReleaseAfresh).mockResolvedValue(newestIs("0.3"));
});

afterEach(() => {
  // Unmounted while what it calls on the way out is still stubbed.
  cleanup();
  idle.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Checking for a newer release", () => {
  it.each([false, true])("asks once the page is ready, then afresh each time Admin opens, and never for leaving it (strict: %s)", async (strict) => {
    const { result, rerender } = renderHook(({ ready, inAdmin }) => useReleaseCheck(true, ready, inAdmin), {
      initialProps: { ready: false, inAdmin: false },
      wrapper: strict ? StrictMode : undefined,
    });
    becomeIdle();
    expect(asked()).toEqual([0, 0]);
    rerender({ ready: true, inAdmin: false });
    becomeIdle();
    await waitFor(() => expect(result.current.check).toEqual(newestIs("0.2")));

    rerender({ ready: true, inAdmin: true });
    becomeIdle();
    await waitFor(() => expect(result.current.check).toEqual(newestIs("0.3")));
    rerender({ ready: true, inAdmin: false });
    becomeIdle();
    expect(asked()).toEqual([1, 1]);
    rerender({ ready: true, inAdmin: true });
    becomeIdle();
    expect(asked()).toEqual([1, 2]);
  });

  it.each([false, true])("asks afresh alone for a page that's ready in Admin as it loads (strict: %s)", async (strict) => {
    const { result } = renderHook(() => useReleaseCheck(true, true, true), { wrapper: strict ? StrictMode : undefined });
    becomeIdle();
    await waitFor(() => expect(result.current.check).toEqual(newestIs("0.3")));
    expect(asked()).toEqual([0, 1]);
  });

  it("asks nothing for anyone but an administrator, in Admin or out", () => {
    const { result, rerender } = renderHook(({ inAdmin }) => useReleaseCheck(false, true, inAdmin), { initialProps: { inAdmin: false } });
    rerender({ inAdmin: true });
    becomeIdle();
    expect(asked()).toEqual([0, 0]);
    expect(result.current.check).toBeNull();
  });
});

describe("Check for updates", () => {
  it("asks afresh at once, without waiting for the browser to be idle, settling once the Worker has answered", async () => {
    const { result } = renderHook(() => useReleaseCheck(true, true, true));
    becomeIdle();
    await waitFor(() => expect(result.current.check).toEqual(newestIs("0.3")));

    vi.mocked(checkForReleaseAfresh).mockResolvedValue(newestIs("0.4"));
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(newestIs("0.4"));
    expect(asked()).toEqual([0, 2]);
    expect(idle.size).toBe(0);
  });

  it("keeps the later release either answer names, as another isolate's answer can arrive after it having heard before", async () => {
    // Opening Admin asks first, but its answer, which heard of 0.3 at 4:03, comes after Check for updates' of 0.4 at 4:04.
    let answerOpening: (check: ReleaseCheck) => void = () => {};
    vi.mocked(checkForReleaseAfresh).mockImplementationOnce(() => new Promise((resolve) => (answerOpening = resolve)));
    const { result } = renderHook(() => useReleaseCheck(true, true, true));
    becomeIdle();
    vi.mocked(checkForReleaseAfresh).mockResolvedValue(newestIs("0.4"));
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(newestIs("0.4"));
    await act(async () => answerOpening(newestIs("0.3")));
    expect(result.current.check).toEqual(newestIs("0.4"));

    // Nor does one that never heard from GitHub change it, but one naming 0.4 too says when GitHub last named it.
    vi.mocked(checkForReleaseAfresh).mockResolvedValue({ ...newestIs("0.6"), newest: null, checkedAt: null });
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(newestIs("0.4"));
    vi.mocked(checkForReleaseAfresh).mockResolvedValue(newestIs("0.4", minutesPast(9)));
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(newestIs("0.4", minutesPast(9)));
    vi.mocked(checkForReleaseAfresh).mockResolvedValue(newestIs("0.4", minutesPast(6)));
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(newestIs("0.4", minutesPast(9)));

    // A release once out stays out, so one naming 0.5 changes it, whenever it heard.
    vi.mocked(checkForReleaseAfresh).mockResolvedValue(newestIs("0.5", minutesPast(7)));
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(newestIs("0.5", minutesPast(7)));
  });

  it.each([1, 2])("keeps the later beta either answer names, whenever each heard from GitHub, on beta %i until it's another release", async (release) => {
    // Opening Admin's answer heard of 0.4, the newest release, at 4:10, when the tags named beta 2. Check for
    // updates' isolate lists beta 3 in the tags, but couldn't ask GitHub for the newest release, so it says it
    // heard of that at 4:05, as it did. Beta 3 is newer either way, and 4:10 is when GitHub last named 0.4.
    vi.mocked(checkForReleaseAfresh).mockResolvedValue(onBeta(release, 2, minutesPast(10)));
    const { result } = renderHook(() => useReleaseCheck(true, true, true));
    becomeIdle();
    await waitFor(() => expect(result.current.check).toEqual(onBeta(release, 2, minutesPast(10))));
    vi.mocked(checkForReleaseAfresh).mockResolvedValue(onBeta(release, 3, minutesPast(5)));
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(onBeta(release, 3, minutesPast(10)));

    // Nor does an isolate that heard of the newest release since, but couldn't list the tags, take beta 3 back.
    vi.mocked(checkForReleaseAfresh).mockResolvedValue(onBeta(release, 2, minutesPast(15)));
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(onBeta(release, 3, minutesPast(15)));

    // Once beta 3 is deployed, this Ember is it, and nothing's newer.
    vi.mocked(checkForReleaseAfresh).mockResolvedValue(onBeta(3, 3, minutesPast(20)));
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(onBeta(3, 3, minutesPast(20)));
  });

  it("keeps the later release one answer names with the later beta the other names, while the beta is ahead of it", async () => {
    // Opening Admin's isolate heard of 0.3 at 4:10, when the tags named 0.4 beta 1. Check for updates' lists 0.4
    // beta 2, but couldn't ask GitHub for the newest release, so it says 0.2, as GitHub named it at 4:05.
    vi.mocked(checkForReleaseAfresh).mockResolvedValue(withBeta(newestIs("0.3", minutesPast(10)), 1));
    const { result } = renderHook(() => useReleaseCheck(true, true, true));
    becomeIdle();
    await waitFor(() => expect(result.current.check).toEqual(withBeta(newestIs("0.3", minutesPast(10)), 1)));
    vi.mocked(checkForReleaseAfresh).mockResolvedValue(withBeta(newestIs("0.2", minutesPast(5)), 2));
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(withBeta(newestIs("0.3", minutesPast(10)), 2));

    // Once 0.4 is out, its betas are behind it, and none is named.
    vi.mocked(checkForReleaseAfresh).mockResolvedValue(newestIs("0.4", minutesPast(20)));
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(newestIs("0.4", minutesPast(20)));
  });

  it("fails as asking does, keeping what the Worker said before", async () => {
    const { result } = renderHook(() => useReleaseCheck(true, true, true));
    becomeIdle();
    await waitFor(() => expect(result.current.check).toEqual(newestIs("0.3")));
    const error = new Error("Failed to fetch");
    vi.mocked(checkForReleaseAfresh).mockRejectedValue(error);
    await act(() => expect(result.current.checkAgain()).rejects.toBe(error));
    expect(result.current.check).toEqual(newestIs("0.3"));
  });
});
