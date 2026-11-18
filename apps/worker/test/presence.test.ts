import type { UserId, WorkspaceServerFrame } from "@ember/protocol";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESENCE_GATHERING_MS, PRESENCE_TTL_MS } from "../src/presence";
import { freshDeploy, openWorkspaceSocket, signIn, workspaceStub, type WorkspaceSocket } from "./support";

beforeEach(freshDeploy);
afterEach(() => void vi.useRealTimers());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Says whether `tab` is in use, as the app does once it's welcomed and as that changes. */
const say = (tab: WorkspaceSocket, active: boolean) => tab.send(JSON.stringify({ type: "presence.active", active }));

/** The next `presence` frame `tab` hears, with its people sorted, since a frame lists them in no particular order. */
async function presenceHeard(tab: WorkspaceSocket): Promise<WorkspaceServerFrame> {
  for (;;) {
    const frame = await tab.next();
    if (frame.type === "presence") return { ...frame, active: frame.active.toSorted(), away: frame.away.toSorted() };
  }
}

const presence = (active: UserId[], away: UserId[] = []): WorkspaceServerFrame => ({ type: "presence", active: active.toSorted(), away: away.toSorted() });

/** Whether `tab` has heard nothing more once whatever was gathered has gone out. */
async function heardNothing(tab: WorkspaceSocket): Promise<boolean> {
  await sleep(PRESENCE_GATHERING_MS * 1.5);
  return tab.answers();
}

/** Opens a tab for `session`'s person that says it's in use, and has heard what it starts with and the change it made. */
async function listening(session: Awaited<ReturnType<typeof signIn>>): Promise<WorkspaceSocket> {
  const tab = await openWorkspaceSocket(session);
  say(tab, true);
  await presenceHeard(tab);
  await presenceHeard(tab);
  return tab;
}

describe("Presence", () => {
  it("tells a tab who's active once it says whether it's in use, then whoever becomes active or away, as they do", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const adas = await openWorkspaceSocket(ada);
    say(adas, true);
    // What the tabs were last told, nothing yet, then the change its connecting made, a moment later.
    expect(await presenceHeard(adas)).toEqual(presence([]));
    expect(await presenceHeard(adas)).toEqual(presence([ada.user.id]));

    // A tab counts as in use from when it connects.
    const graces = await openWorkspaceSocket(grace);
    expect(await presenceHeard(adas)).toEqual(presence([grace.user.id]));
    say(graces, false);
    expect(await presenceHeard(graces)).toEqual(presence([ada.user.id, grace.user.id]));
    expect(await presenceHeard(adas)).toEqual(presence([], [grace.user.id]));
    expect(await presenceHeard(graces)).toEqual(presence([], [grace.user.id]));

    say(graces, true);
    expect(await presenceHeard(adas)).toEqual(presence([grace.user.id]));
    graces.ws.close(1000);
    expect(await presenceHeard(adas)).toEqual(presence([], [grace.user.id]));
  });

  it("counts someone active while any tab of theirs is in use", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const adas = await listening(ada);
    const [laptop, phone] = [await openWorkspaceSocket(grace), await openWorkspaceSocket(grace)];
    expect(await presenceHeard(adas)).toEqual(presence([grace.user.id]));

    say(laptop, false);
    expect(await heardNothing(adas)).toBe(true);
    say(phone, false);
    expect(await presenceHeard(adas)).toEqual(presence([], [grace.user.id]));
  });

  it("gathers the changes of a moment into one frame, so a tab that reloads tells of nothing", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const adas = await listening(ada);

    const [graces] = await Promise.all([openWorkspaceSocket(grace), openWorkspaceSocket(linus)]);
    expect(await presenceHeard(adas)).toEqual(presence([grace.user.id, linus.user.id]));

    graces.ws.close(1000);
    await openWorkspaceSocket(grace);
    expect(await heardNothing(adas)).toBe(true);
  });

  it("tells nothing to a tab that hasn't said whether it's in use, as an app from before it did", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const quiet = await openWorkspaceSocket(ada);
    const graces = await openWorkspaceSocket(grace);
    say(graces, false);
    await presenceHeard(graces);
    expect(await presenceHeard(graces)).toEqual(presence([ada.user.id], [grace.user.id]));
    expect(await heardNothing(quiet)).toBe(true);
  });

  it("refuses a presence that isn't a yes or no, as any frame it can't read", async () => {
    const ada = await signIn("Ada");
    const tab = await openWorkspaceSocket(ada);
    tab.send(JSON.stringify({ type: "presence.active", active: "yes" }));
    expect(await tab.next()).toEqual({ type: "error", message: "Unrecognized frame" });
  });

  it("counts a tab it hasn't heard from in a minute as gone, as of the next change", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const adas = await listening(ada);
    await openWorkspaceSocket(grace);
    expect(await presenceHeard(adas)).toEqual(presence([grace.user.id]));

    // A minute on, Ada's tab says it's in use again, and Grace's has said nothing, nor pinged.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + PRESENCE_TTL_MS + 1_000 });
    say(adas, true);
    expect(await presenceHeard(adas)).toEqual(presence([], [grace.user.id]));
  });

  it("counts a tab's word that it's shown, or hidden, as hearing from it, which has its person active again", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const adas = await listening(ada);
    const graces = await openWorkspaceSocket(grace);
    expect(await presenceHeard(adas)).toEqual(presence([grace.user.id]));

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + PRESENCE_TTL_MS + 1_000 });
    say(adas, true);
    expect(await presenceHeard(adas)).toEqual(presence([], [grace.user.id]));
    graces.send(JSON.stringify({ type: "presence.visible", visible: false }));
    expect(await presenceHeard(adas)).toEqual(presence([grace.user.id]));
  });

  it("counts the runtime's answers to a tab's pings as hearing from it, which the Workspace sleeps through", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const adas = await listening(ada);
    // Grace's and Linus's tabs were let in over a minute ago, and only Grace's has pinged since.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - PRESENCE_TTL_MS - 1_000 });
    const [graces] = [await openWorkspaceSocket(grace), await openWorkspaceSocket(linus)];
    vi.useRealTimers();
    graces.send(JSON.stringify({ type: "ping" }));
    expect(await graces.next()).toEqual({ type: "pong" });
    expect(await presenceHeard(adas)).toEqual(presence([grace.user.id]));
  });

  it("goes on telling only what changes once the Workspace has been evicted, reading what the tabs were told back from their sockets", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const adas = await listening(ada);
    const graces = await openWorkspaceSocket(grace);
    expect(await presenceHeard(adas)).toEqual(presence([grace.user.id]));

    await evictDurableObject(workspaceStub());
    say(graces, false);
    expect(await presenceHeard(adas)).toEqual(presence([], [grace.user.id]));
    await openWorkspaceSocket(linus);
    expect(await presenceHeard(adas)).toEqual(presence([linus.user.id]));
    expect(await heardNothing(adas)).toBe(true);
  });

  it("tells of someone heard from again once the Workspace has been evicted, after it told the tabs they'd gone", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const adas = await listening(ada);
    const graces = await openWorkspaceSocket(grace);
    expect(await presenceHeard(adas)).toEqual(presence([grace.user.id]));
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + PRESENCE_TTL_MS + 1_000 });
    say(adas, true);
    expect(await presenceHeard(adas)).toEqual(presence([], [grace.user.id]));
    vi.useRealTimers();

    // While the Workspace sleeps, Grace's tab, still in use, pings again.
    await evictDurableObject(workspaceStub());
    graces.send(JSON.stringify({ type: "ping" }));
    expect(await graces.next()).toEqual({ type: "pong" });
    await openWorkspaceSocket(linus);
    expect(await presenceHeard(adas)).toEqual(presence([grace.user.id, linus.user.id]));
  });
});
