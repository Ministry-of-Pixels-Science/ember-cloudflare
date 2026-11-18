import { describe, expect, it } from "vitest";
import { compareResults } from "./compare.ts";
import type { Results } from "./report.ts";
import type { ConnectionsStep } from "./scenarios/connections.ts";
import type { HuddleStep } from "./scenarios/huddle.ts";
import type { Summary } from "./stats.ts";

const summary = (p50: number): Summary => ({ count: 100, mean: p50, p50, p90: p50 * 1.4, p95: p50 * 1.5, p99: p50 * 2, max: p50 * 3 });
const step = (members: number, joinP50: number) => ({ members, connect: summary(joinP50), presenceKbPerJoin: members * 2 }) as ConnectionsStep;
const huddleOf = (people: number) => ({ people, welcome: summary(8), hearsAll: summary(people), heardByAll: summary(people * 1.5), sfuRequestsForLastJoin: 2 * people + 3, reaction: summary(3), lost: 0 }) as HuddleStep;

/** A run with one of everything compare looks at, and nothing else. */
function baseline(): Results {
  return {
    environment: { profile: "quick", cpu: "test", cores: 4 } as Results["environment"],
    backend: {
      "do-sqlite": {
        latency: { ack: summary(3), delivery: summary(3.2), lost: 0 },
        throughput: { messagesPerSecond: 1000, outOfOrder: 0, errors: 0, timedOut: false },
        fanout: [{ members: 100, delivery: summary(20), lost: 0, outOfOrder: 0 }],
        connections: { maxConnectP95Ms: 2000, steps: [step(100, 50), step(200, 120)] },
        history: { welcome: summary(6), page: summary(1.7) },
        huddle: { steps: [huddleOf(10), huddleOf(25)], errors: 0 },
      },
    } as unknown as Results["backend"],
    web: {
      bundle: { code: { gzipKb: 125 } },
      lighthouse: [{ page: "room", formFactor: "mobile", score: 96, lcpMs: 1950, tbtMs: 0, cls: 0 }],
      render: [{ cpuSlowdown: 1, roomReadyMs: 250, bursts: [{ frameToPaint: summary(6), mainThreadMsPerMessage: 6.5, missing: 0 }] }],
    } as unknown as Results["web"],
  };
}

const verdicts = (before: Results, after: Results) =>
  Object.fromEntries(compareResults(before, after, 10).flatMap((row) => (row.verdict ? [[row.metric, row.verdict]] : [])));

describe("compareResults", () => {
  it("reports nothing for swings as large as two runs of the same commit show", () => {
    const before = baseline();
    before.web!.lighthouse[0]!.lcpMs = 1719;
    before.web!.lighthouse[0]!.tbtMs = 128;
    before.web!.render[0]!.bursts[0]!.mainThreadMsPerMessage = 6.09;
    const after = baseline();
    after.backend["do-sqlite"]!.throughput!.messagesPerSecond = 820;
    after.backend["do-sqlite"]!.fanout![0]!.delivery = summary(22.5);
    after.backend["do-sqlite"]!.connections!.steps[1] = step(200, 160);
    after.backend["do-sqlite"]!.history!.welcome = summary(8);
    before.backend["do-sqlite"]!.huddle!.steps = [
      { ...huddleOf(10), welcome: summary(6.96), hearsAll: summary(5.86), heardByAll: summary(10.54) },
      { ...huddleOf(25), hearsAll: summary(10.25), heardByAll: summary(31.92), reaction: { ...summary(2.95), p95: 4.26 } },
      { ...huddleOf(50), hearsAll: summary(30.79) },
    ];
    after.backend["do-sqlite"]!.huddle!.steps = [
      { ...huddleOf(10), welcome: summary(12.17), hearsAll: summary(10.42), heardByAll: summary(17.89) },
      { ...huddleOf(25), hearsAll: summary(17.42), heardByAll: summary(48.84), reaction: { ...summary(4.24), p95: 7.38 } },
      { ...huddleOf(50), hearsAll: summary(45.76) },
    ];
    after.web!.lighthouse[0]!.lcpMs = 1995;
    after.web!.lighthouse[0]!.tbtMs = 265;
    after.web!.render[0]!.bursts[0]!.mainThreadMsPerMessage = 7.07;
    expect(verdicts(before, after)).toEqual({});
  });

  it("ignores changes smaller than a metric's floor", () => {
    const after = baseline();
    after.backend["do-sqlite"]!.latency!.ack = summary(3.8);
    expect(verdicts(baseline(), after)).toEqual({});
  });

  it("ignores a few milliseconds' swing in a short delivery tail", () => {
    const before = baseline();
    before.backend["do-sqlite"]!.fanout![0]!.delivery = { ...summary(4), p95: 5.44 };
    const after = baseline();
    after.backend["do-sqlite"]!.fanout![0]!.delivery = { ...summary(4), p95: 7.92 };
    expect(verdicts(before, after)).toEqual({});
  });

  it("judges a change and its reverse alike", () => {
    const slower = baseline();
    slower.backend["do-sqlite"]!.throughput!.messagesPerSecond = 700;
    expect(verdicts(baseline(), slower)).toEqual({ "do-sqlite throughput: messages/s": "worse" });
    expect(verdicts(slower, baseline())).toEqual({ "do-sqlite throughput: messages/s": "better" });
  });

  it("counts a new delay where there was none", () => {
    const after = baseline();
    after.web!.lighthouse[0]!.tbtMs = 300;
    expect(compareResults(baseline(), after, 10)).toContainEqual({ metric: "lighthouse room mobile: TBT ms", before: 0, after: 300, change: Infinity, verdict: "worse" });
  });

  it("counts any lost message", () => {
    const after = baseline();
    after.backend["do-sqlite"]!.fanout![0]!.lost = 3;
    expect(verdicts(baseline(), after)).toEqual({ "do-sqlite fan-out 100: lost": "worse" });
  });

  it("counts one more lost message even where some were lost before", () => {
    const before = baseline();
    before.backend["do-sqlite"]!.fanout![0]!.lost = 20;
    const after = baseline();
    after.backend["do-sqlite"]!.fanout![0]!.lost = 21;
    expect(verdicts(before, after)).toEqual({ "do-sqlite fan-out 100: lost": "worse" });
  });

  it("counts one request more to the SFU for someone to join a huddle, and one fewer", () => {
    const after = baseline();
    after.backend["do-sqlite"]!.huddle!.steps[1]!.sfuRequestsForLastJoin = 54;
    expect(verdicts(baseline(), after)).toEqual({ "do-sqlite huddle of 25: SFU requests for the last to join": "worse" });
    expect(verdicts(after, baseline())).toEqual({ "do-sqlite huddle of 25: SFU requests for the last to join": "better" });
  });

  it("counts a newcomer taking twice as long to hear a huddle, though the huddle hears them as soon", () => {
    const after = baseline();
    after.backend["do-sqlite"]!.huddle!.steps[1]!.hearsAll = summary(50);
    expect(verdicts(baseline(), after)).toEqual({ "do-sqlite huddle of 25: hears all p50 ms": "worse" });
  });

  it("counts a reaction's tail that doubles in a huddle, though its median stays", () => {
    const before = baseline();
    before.backend["do-sqlite"]!.huddle!.steps[1]!.reaction = { ...summary(3), p95: 5 };
    const after = baseline();
    after.backend["do-sqlite"]!.huddle!.steps[1]!.reaction = { ...summary(3), p95: 10 };
    expect(verdicts(before, after)).toEqual({ "do-sqlite huddle of 25: reaction p95 ms": "worse" });
  });

  it("counts one more error in a huddle, and one more reaction that didn't reach someone, even where there were some before", () => {
    const before = baseline();
    before.backend["do-sqlite"]!.huddle!.errors = 20;
    before.backend["do-sqlite"]!.huddle!.steps[0]!.lost = 20;
    const after = baseline();
    after.backend["do-sqlite"]!.huddle!.errors = 21;
    after.backend["do-sqlite"]!.huddle!.steps[0]!.lost = 21;
    expect(verdicts(before, after)).toEqual({ "do-sqlite huddle of 10: lost": "worse", "do-sqlite huddle: errors": "worse" });
  });

  it("fails a run that no longer measures what the baseline did", () => {
    const after = baseline();
    after.backend["do-sqlite"]!.connections!.steps = [step(100, 50)];
    after.backend["do-sqlite"]!.fanout![0]!.delivery = null;
    after.backend["do-sqlite"]!.huddle!.steps = [huddleOf(10)];
    expect(verdicts(baseline(), after)).toEqual({
      "do-sqlite fan-out 100: delivery p50 ms": "missing",
      "do-sqlite fan-out 100: delivery p95 ms": "missing",
      "do-sqlite room size: most members with join p95 under 2000 ms": "worse",
      "do-sqlite room of 200: join p50 ms": "missing",
      "do-sqlite room of 200: presence KB per join": "missing",
      "do-sqlite huddle of 25: welcome p50 ms": "missing",
      "do-sqlite huddle of 25: hears all p50 ms": "missing",
      "do-sqlite huddle of 25: heard by all p50 ms": "missing",
      "do-sqlite huddle of 25: SFU requests for the last to join": "missing",
      "do-sqlite huddle of 25: reaction p50 ms": "missing",
      "do-sqlite huddle of 25: reaction p95 ms": "missing",
      "do-sqlite huddle of 25: lost": "missing",
    });
  });
});
