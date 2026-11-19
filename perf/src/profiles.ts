import type { ConnectionsOptions } from "./scenarios/connections.ts";
import type { FanoutOptions } from "./scenarios/fanout.ts";
import type { HistoryOptions } from "./scenarios/history.ts";
import type { HuddleOptions } from "./scenarios/huddle.ts";
import type { LatencyOptions } from "./scenarios/latency.ts";
import type { SearchOptions } from "./scenarios/search.ts";
import type { TabsOptions } from "./scenarios/tabs.ts";
import type { ThroughputOptions } from "./scenarios/throughput.ts";
import type { UnreadOptions } from "./scenarios/unread.ts";

// How hard each scenario pushes. `full` is what the baseline in README.md uses; `quick` is a smoke run.

export interface Profile {
  latency: LatencyOptions;
  throughput: ThroughputOptions;
  fanout: FanoutOptions;
  connections: ConnectionsOptions;
  tabs: TabsOptions;
  unread: UnreadOptions;
  history: HistoryOptions;
  search: SearchOptions;
  huddle: HuddleOptions;
  web: {
    /** Lighthouse runs per page and form factor; the median is reported. */
    lighthouseRuns: number;
    /** Messages in the room the browser opens. */
    backlog: number;
    /** Incoming messages to render, and how fast they arrive. */
    burst: { messages: number; rate: number };
    /** Timeline sizes to measure the burst at; the larger ones page in older history first. */
    timelineSizes: number[];
    /** CPU slowdowns to measure rendering at: 1 is this machine, 4 approximates a mid-range phone. */
    cpuSlowdowns: number[];
  };
}

export const PROFILES: Record<"full" | "quick", Profile> = {
  full: {
    latency: { messages: 300, rate: 20 },
    throughput: { messages: 3000, senders: 4, inFlight: 8 },
    fanout: { sizes: [10, 100, 250, 500], messages: 100, rate: 10 },
    connections: { sizes: [100, 200, 300, 400, 500, 750, 1000], concurrency: 8, maxConnectP95Ms: 2000 },
    tabs: { sizes: [250, 500, 1000], rooms: 10, concurrency: 16, maxConnectP95Ms: 2000 },
    unread: { sizes: [100, 500, 1000], messages: 100, rate: 10, concurrency: 16 },
    history: { messages: 2000, boostEvery: 10, welcomes: 30, passes: 3 },
    search: { rooms: 20, messages: 250, searches: 50, newMessages: 30 },
    huddle: { sizes: [10, 25, 50], reactions: 100, rate: 10 },
    web: { lighthouseRuns: 3, backlog: 1050, burst: { messages: 100, rate: 20 }, timelineSizes: [40, 300], cpuSlowdowns: [1, 4] },
  },
  quick: {
    latency: { messages: 100, rate: 20 },
    throughput: { messages: 500, senders: 4, inFlight: 8 },
    fanout: { sizes: [10, 100], messages: 50, rate: 10 },
    connections: { sizes: [50, 100, 200], concurrency: 8, maxConnectP95Ms: 2000 },
    tabs: { sizes: [100, 200], rooms: 4, concurrency: 16, maxConnectP95Ms: 2000 },
    unread: { sizes: [100], messages: 50, rate: 10, concurrency: 16 },
    history: { messages: 500, boostEvery: 10, welcomes: 10, passes: 1 },
    search: { rooms: 10, messages: 100, searches: 20, newMessages: 10 },
    huddle: { sizes: [10, 25], reactions: 40, rate: 10 },
    web: { lighthouseRuns: 1, backlog: 250, burst: { messages: 40, rate: 20 }, timelineSizes: [40, 200], cpuSlowdowns: [1] },
  },
};
