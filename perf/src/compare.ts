import type { Results } from "./report.ts";

// Compares the headline numbers of two runs of the same profile, ideally from the same machine: a
// baseline from main and a run from a branch, say. A metric only counts as changed when it moves by
// more than its noise floor and by more than it moves between two runs of the same commit, except
// counts of lost messages and errors, and of what every run of the same commit does alike, where
// every one counts.

interface Metric {
  name: string;
  value: number;
  better: "lower" | "higher";
  /** The smallest difference worth reporting, in the metric's own unit. */
  floor: number;
  /** How far, in percent either way, the metric moves between two runs of the same commit. */
  noise: number;
  /** Counts what shouldn't happen at all, or what every run of a commit does alike, so a change of `floor` counts whatever its percentage. */
  anyChange: boolean;
}

type Tolerance = Partial<Pick<Metric, "better" | "floor" | "noise" | "anyChange">>;

// The tolerances below come from running the same commit several times on one machine, in both
// profiles. Metrics that swung too far between identical runs to say anything are left out.

/** Tails, and timings taken while one room's thread is saturated, swing this much between runs. */
const SWINGY: Tolerance = { noise: 40 };
/** Lost or missing messages and errors shouldn't happen at all, so any increase counts. */
const NEVER: Tolerance = { floor: 1, anyChange: true };
/** A paint lands on the next frame, so differences under one frame (60 Hz) are scheduling, not speed. */
const FRAME_MS = 17;

function collect({ backend, web }: Results): Map<string, Metric> {
  const metrics = new Map<string, Metric>();
  const add = (name: string, value: number | null | undefined, { better = "lower", floor = 1, noise = 10, anyChange = false }: Tolerance = {}) => {
    if (typeof value === "number" && Number.isFinite(value)) metrics.set(name, { name, value, better, floor, noise, anyChange });
  };

  for (const [storage, r] of Object.entries(backend)) {
    if (r.latency) {
      // With 100 to 300 samples, the tail here is a handful of messages; fan-out has the tails worth comparing.
      add(`${storage} latency: ack p50 ms`, r.latency.ack?.p50);
      add(`${storage} latency: delivery p50 ms`, r.latency.delivery?.p50);
      add(`${storage} latency: lost`, r.latency.lost, NEVER);
    }
    if (r.throughput) {
      // Its acknowledgement times are queueing behind the room's saturated thread, and swing twofold.
      add(`${storage} throughput: messages/s`, r.throughput.messagesPerSecond, { better: "higher", floor: 10, noise: 25 });
      add(`${storage} throughput: out of order`, r.throughput.outOfOrder, NEVER);
      add(`${storage} throughput: errors`, r.throughput.errors, NEVER);
      add(`${storage} throughput: timed out`, Number(r.throughput.timedOut), NEVER);
    }
    for (const f of r.fanout ?? []) {
      add(`${storage} fan-out ${f.members}: delivery p50 ms`, f.delivery?.p50, { noise: 15 });
      // Runs of the same code have put a 10-member room's tail anywhere from 5.44 to 7.92 ms, so a
      // smaller move than 4 ms says nothing about the code.
      add(`${storage} fan-out ${f.members}: delivery p95 ms`, f.delivery?.p95, { floor: 4, ...SWINGY });
      add(`${storage} fan-out ${f.members}: lost`, f.lost, NEVER);
      add(`${storage} fan-out ${f.members}: out of order`, f.outOfOrder, NEVER);
    }
    if (r.connections) {
      const { steps, maxConnectP95Ms } = r.connections;
      const held = steps.filter((step) => step.connect && step.connect.p95 <= maxConnectP95Ms).map((step) => step.members);
      add(`${storage} room size: most members with join p95 under ${maxConnectP95Ms} ms`, Math.max(0, ...held), { better: "higher", noise: 0 });
      for (const step of steps) {
        add(`${storage} room of ${step.members}: join p50 ms`, step.connect?.p50, SWINGY);
        add(`${storage} room of ${step.members}: presence KB per join`, step.presenceKbPerJoin, { noise: 5 });
      }
    }
    if (r.tabs) {
      const { steps, maxConnectP95Ms, reconnect } = r.tabs;
      const held = steps.filter((step) => step.welcome && step.welcome.p95 <= maxConnectP95Ms).map((step) => step.tabs);
      add(`${storage} tabs: most with welcome p95 under ${maxConnectP95Ms} ms`, Math.max(0, ...held), { better: "higher", noise: 0 });
      for (const step of steps) {
        add(`${storage} ${step.tabs} tabs: welcome p50 ms`, step.welcome?.p50, SWINGY);
        add(`${storage} ${step.tabs} tabs: sidebar p50 ms`, step.sidebar?.p50, SWINGY);
        add(`${storage} ${step.tabs} tabs: directory p50 ms`, step.directory?.p50, SWINGY);
      }
      if (reconnect) {
        // Each socket waits a random time, up to 10 seconds, before connecting again, so the last one
        // back moves with that draw as much as with the code.
        add(`${storage} ${reconnect.tabs} tabs reconnecting: all back ms`, reconnect.allBackMs, { floor: 250, ...SWINGY });
        add(`${storage} ${reconnect.tabs} tabs reconnecting: welcome p50 ms`, reconnect.welcome?.p50, SWINGY);
        add(`${storage} ${reconnect.tabs} tabs reconnecting: failed`, reconnect.failures, NEVER);
      }
    }
    for (const u of r.unread ?? []) {
      add(`${storage} unread ${u.members} away: marked p50 ms`, u.marked?.p50, SWINGY);
      add(`${storage} unread ${u.members} away: last marked ms`, u.marked?.max, { floor: 4, ...SWINGY });
      add(`${storage} unread ${u.members} away: missed`, u.missed, NEVER);
      add(`${storage} unread ${u.members} away: then ack p50 ms`, u.ack?.p50, { noise: 15 });
      add(`${storage} unread ${u.members} away: lost`, u.lost, NEVER);
    }
    if (r.history) {
      // The quick profile times ten welcomes and nine pages, so these medians rest on few samples, and
      // runs of the same code have moved them by a third.
      add(`${storage} history: welcome p50 ms`, r.history.welcome?.p50, { floor: 2, ...SWINGY });
      add(`${storage} history: page p50 ms`, r.history.page?.p50, { floor: 2, ...SWINGY });
    }
    if (r.search) {
      // Catch-up is left out: runs of the same code have put it anywhere from 16 to 154 ms on D1, and
      // from 254 to 530 ms on DO SQLite, as it hangs on how far the index happens to be behind.
      // A new message is found by searching every 10 ms, so a smaller move says nothing.
      add(`${storage} search: new message p50 ms`, r.search.newMessage?.p50, { floor: 10, ...SWINGY });
      add(`${storage} search: common p50 ms`, r.search.common?.p50, { floor: 3, noise: 25 });
      add(`${storage} search: rare p50 ms`, r.search.rare?.p50, { floor: 3, ...SWINGY });
      add(`${storage} search: none p50 ms`, r.search.none?.p50, { floor: 2, noise: 25 });
    }
    if (r.huddle) {
      for (const step of r.huddle.steps) {
        const huddle = `${storage} huddle of ${step.people}`;
        // Ten joins make a thin median: runs of the scenario, nineteen on DO SQLite and eighteen on D1, put
        // the first ten's welcome anywhere from 6.96 to 12.17 ms on D1, and everyone hearing them from 10.54
        // to 17.89 ms on DO SQLite.
        add(`${huddle}: welcome p50 ms`, step.welcome?.p50, { floor: 6, ...SWINGY });
        // A newcomer hears everyone over one round of their own, which those runs put anywhere from 10.25 to
        // 17.42 ms in a huddle of 25, and from 30.79 to 45.76 ms in one of 50.
        add(`${huddle}: hears all p50 ms`, step.hearsAll?.p50, { floor: 10, noise: 60 });
        // Everyone hears them over a round each. A huddle of 25 keeps its room about as busy as it gets, where
        // those runs put it anywhere from 31.92 to 48.84 ms.
        add(`${huddle}: heard by all p50 ms`, step.heardByAll?.p50, { floor: 10, noise: 60 });
        // The room asks the same of the SFU for someone to join on every run, so one request more or fewer is the code's.
        add(`${huddle}: SFU requests for the last to join`, step.sfuRequestsForLastJoin, { anyChange: true });
        // A reaction takes a few milliseconds, which those runs moved by up to 1.29 ms, and its tail by up to 3.12.
        add(`${huddle}: reaction p50 ms`, step.reaction?.p50, { floor: 2, ...SWINGY });
        add(`${huddle}: reaction p95 ms`, step.reaction?.p95, { floor: 4, ...SWINGY });
        add(`${huddle}: lost`, step.lost, NEVER);
      }
      add(`${storage} huddle: errors`, r.huddle.errors, NEVER);
    }
  }

  if (web) {
    add("bundle: JS+CSS gzip KB", web.bundle.code.gzipKb);
    for (const l of web.lighthouse) {
      const page = `lighthouse ${l.page} ${l.formFactor}`;
      add(`${page}: score`, l.score, { better: "higher", floor: 3, noise: 0 });
      // Six single runs of one commit put the room page's mobile LCP anywhere from 1,719 to 1,995 ms.
      add(`${page}: LCP ms`, l.lcpMs, { floor: 100, noise: l.formFactor === "mobile" ? 20 : 10 });
      // Single Lighthouse runs of one commit put the room page's mobile TBT anywhere from 128 to
      // 265 ms, so a smaller jump than 200 ms says nothing about the code.
      add(`${page}: TBT ms`, l.tbtMs, { floor: 200, noise: 35 });
      add(`${page}: CLS`, l.cls, { floor: 0.02 });
    }
    for (const r of web.render) {
      add(`render ${r.cpuSlowdown}x: room ready ms`, r.roomReadyMs, { floor: 50, noise: r.cpuSlowdown > 1 ? 40 : 10 });
      r.bursts.forEach((b, i) => {
        // Timelines grow by whatever paging brings in, so label them by position, not exact size.
        const label = `render ${r.cpuSlowdown}x ${i === 0 ? "short" : "long"} timeline`;
        add(`${label}: frame to paint p50 ms`, b.frameToPaint?.p50, { floor: FRAME_MS });
        add(`${label}: frame to paint p95 ms`, b.frameToPaint?.p95, { floor: FRAME_MS, ...SWINGY });
        // Four runs of one build put the short timeline's anywhere from 6.09 to 7.07 ms.
        add(`${label}: main thread ms per message`, b.mainThreadMsPerMessage, { floor: 0.5, noise: 20 });
        add(`${label}: missing messages`, b.missing, NEVER);
      });
    }
  }
  return metrics;
}

/** Percent change, where anything from zero counts as infinitely large. */
function percentChange(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : Infinity;
  return ((after - before) / before) * 100;
}

/** How far apart two values are as a percentage of the smaller, so 100 to 80 and 80 to 100 count the same. */
function spread(before: number, after: number): number {
  const [low, high] = before < after ? [before, after] : [after, before];
  if (low === high) return 0;
  return low === 0 ? Infinity : ((high - low) / low) * 100;
}

export interface Row {
  metric: string;
  before: number;
  /** Null when the second run didn't measure it. */
  after: number | null;
  /** Percent change from before; Infinity when before was zero. */
  change: number | null;
  verdict: "better" | "worse" | "missing" | "";
}

/**
 * How each metric in `before` moved in `after`. A metric is better or worse once it moves by more
 * than its floor, `threshold` percent, and its own run-to-run noise; a count of what shouldn't happen
 * at all, such as lost messages, as soon as it changes. A metric `after` didn't measure, such as a
 * room size it no longer reaches or a summary left with no samples, is missing, which counts as a
 * failure.
 */
export function compareResults(before: Results, after: Results, threshold: number): Row[] {
  const now = collect(after);
  return [...collect(before).values()].map((previous): Row => {
    const metric = now.get(previous.name);
    if (!metric) return { metric: previous.name, before: previous.value, after: null, change: null, verdict: "missing" };
    const moved = Math.abs(metric.value - previous.value) >= metric.floor;
    const significant = moved && (metric.anyChange || spread(previous.value, metric.value) >= Math.max(threshold, metric.noise));
    const improved = metric.better === "lower" ? metric.value < previous.value : metric.value > previous.value;
    return {
      metric: metric.name,
      before: previous.value,
      after: metric.value,
      change: percentChange(previous.value, metric.value),
      verdict: !significant ? "" : improved ? "better" : "worse",
    };
  });
}

const formatChange = (change: number | null) =>
  change === null ? "" : Number.isFinite(change) ? `${change > 0 ? "+" : ""}${change.toFixed(1)}%` : "from 0";

/** Prints how `after` moved against `before`, and returns how many metrics got worse or went missing. */
export function compare(before: Results, after: Results, threshold: number): number {
  const rows = compareResults(before, after, threshold);
  const worse = rows.filter((row) => row.verdict === "worse").length;
  const missing = rows.filter((row) => row.verdict === "missing").length;

  console.log(`Before: ${before.environment.commit} (${before.environment.date}, ${before.environment.profile} profile)`);
  console.log(`After:  ${after.environment.commit} (${after.environment.date}, ${after.environment.profile} profile)`);
  if (before.environment.profile !== after.environment.profile) {
    console.log("\nThese runs used different profiles, so their rooms and bursts differ in size. Compare runs of the same profile.");
  }
  if (before.environment.cpu !== after.environment.cpu || before.environment.cores !== after.environment.cores) {
    console.log("\nThese runs come from different machines, so differences say as much about the hardware as the code.");
  }
  const lines = rows.map((row) => `| ${row.metric} | ${row.before} | ${row.after ?? "–"} | ${formatChange(row.change)} | ${row.verdict} |`);
  console.log(["", "| Metric | Before | After | Change | |", "| --- | --: | --: | --: | --- |", ...lines].join("\n"));
  console.log(
    `\n${worse} metric${worse === 1 ? "" : "s"} worse${missing ? ` and ${missing} missing from the second run` : ""}. ` +
      `A metric counts as changed once it moves by more than ${threshold}% and its usual run-to-run noise; lost messages, errors and requests to the SFU count from the first.`,
  );
  return worse + missing;
}
