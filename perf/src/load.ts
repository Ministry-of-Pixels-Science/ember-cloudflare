import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { REACTIONS } from "@ember/protocol";
import { createRoom, RoomClient, signIn } from "./room-client.ts";
import type { Server, Usage } from "./server.ts";

// Building blocks shared by the backend scenarios.

/** A fresh open room for a scenario, made by a host of its own: everyone it signs in afterwards is in it. */
export async function newRoom(server: Server, name: string): Promise<string> {
  return createRoom(server.url, await signIn(server.url, `${name} host`), name);
}

const BODIES = [
  "Morning! Did the deploy go out?",
  "Yes, about ten minutes ago. Dashboards look calm so far.",
  "Nice. I'll keep an eye on the error rate and post here if anything moves.",
  "Can someone review the onboarding copy before lunch? It's the last thing blocking the release notes.",
];

/** A chat-sized message's text. */
export const messageText = (i: number) => `${BODIES[i % BODIES.length]} (#${i})`;

/** A chat-sized message body: its text in a paragraph, as the composer sends it. */
export const messageBody = (i: number) => `<p>${messageText(i)}</p>`;

/**
 * Signs in `count` users and joins them to `room`, `concurrency` at a time. If a join fails, no new
 * ones start, everyone who already joined leaves, and the first error is thrown.
 */
export async function joinMany(server: Server, room: string, count: number, { concurrency = 16, name = "member" } = {}) {
  const clients: RoomClient[] = [];
  const connectMs: number[] = [];
  let next = 0;
  let failure: Error | null = null;
  const worker = async () => {
    while (next < count && !failure) {
      try {
        const session = await signIn(server.url, `${name}-${next++}`);
        const { client, ms } = await RoomClient.connect(server.url, room, session);
        clients.push(client);
        connectMs.push(ms);
      } catch (error) {
        failure ??= error as Error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  if (failure) {
    closeAll(clients);
    throw failure;
  }
  return { clients, connectMs };
}

export function closeAll(clients: Array<{ close(): void }>): void {
  for (const client of clients) client.close();
}

/** Calls `fn` `count` times at `rate` per second on a fixed schedule, so a slow send doesn't lower the rate. */
export async function atRate(count: number, rate: number, fn: (i: number) => void): Promise<void> {
  const interval = 1000 / rate;
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const wait = start + i * interval - performance.now();
    if (wait > 0) await sleep(wait);
    fn(i);
  }
}

/** Resolves true once `done()` holds, or false after `timeoutMs`. */
export async function waitFor(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!done()) {
    if (performance.now() > deadline) return false;
    await sleep(5);
  }
  return true;
}

/** Waits until no client has heard anything for `quietMs`, so one phase's frames don't spill into the next. */
export async function settle(clients: RoomClient[], quietMs = 300, timeoutMs = 300_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const last = clients.reduce((latest, client) => Math.max(latest, client.lastFrameAt), 0);
    const idle = performance.now() - last;
    if (idle >= quietMs) return;
    if (performance.now() > deadline) throw new Error(`The room didn't go quiet within ${timeoutMs}ms`);
    await sleep(quietMs - idle);
  }
}

/**
 * Fills a room with `messages`, the writers taking turns so authors alternate, and two reactions on
 * every `boostEvery`th message. The first writer counts acknowledgements and keeps 32 in flight.
 */
export async function seedRoom(writers: RoomClient[], messages: number, boostEvery: number): Promise<void> {
  const IN_FLIGHT = 32;
  const counter = writers[0]!;
  const boosts = Math.floor(messages / boostEvery) * 2;
  let sent = 0;
  let acked = 0;
  const sendNext = () => {
    if (sent === messages) return;
    const i = sent++;
    writers[i % writers.length]!.send({ type: "message.create", clientMessageId: `seed-${i}`, body: messageBody(i) });
  };
  counter.onMessage = (message) => {
    acked++;
    if (acked % boostEvery === 0) {
      counter.send({ type: "boost.create", messageId: message.id, content: REACTIONS[0][0] });
      counter.send({ type: "boost.create", messageId: message.id, content: REACTIONS[1][0] });
    }
    sendNext();
  };
  for (let i = 0; i < IN_FLIGHT; i++) sendNext();
  const done = await waitFor(() => acked === messages && counter.boostsCreated === boosts, 120_000);
  counter.onMessage = null;
  if (!done) throw new Error(`Seeding stalled at ${acked}/${messages} messages and ${counter.boostsCreated}/${boosts} reactions`);
}

/** Remembers when each message was sent so every copy that arrives can be timed against it. */
export class Outbox {
  private readonly sentAt = new Map<string, number>();

  post(client: RoomClient, clientMessageId: string, body: string): void {
    this.sentAt.set(clientMessageId, performance.now());
    client.send({ type: "message.create", clientMessageId, body });
  }

  /** Milliseconds from sending `clientMessageId` to `at`, or undefined for messages sent elsewhere. */
  since(clientMessageId: string, at: number): number | undefined {
    const sent = this.sentAt.get(clientMessageId);
    return sent === undefined ? undefined : at - sent;
  }
}

export interface Window {
  ms: number;
  /** CPU used by wrangler and workerd over the window, as a percentage of one core. */
  serverCpuPercent: number | null;
  /** The same for the busiest of those processes. Near 100, the Worker's thread was the bottleneck. */
  busiestProcessCpuPercent: number | null;
  serverRssMb: number | null;
  /** The load generator's own event-loop delay. When it's high, latencies include client queueing. */
  clientLagP99Ms: number;
}

const LAG_RESOLUTION_MS = 10;

function cpuPercent(before: Usage, after: Usage, ms: number) {
  const used = [...after.cpuSeconds].map(([pid, seconds]) => seconds - (before.cpuSeconds.get(pid) ?? 0));
  const percent = (seconds: number) => Math.round((seconds / (ms / 1000)) * 100);
  return { total: percent(sum(used)), busiest: percent(Math.max(0, ...used)) };
}

/** Runs `fn` and reports how long it took and how busy the server and this process were meanwhile. */
export async function measure<T>(server: Server, fn: () => Promise<T>): Promise<{ result: T; window: Window }> {
  const lag = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
  const before = await server.usage();
  lag.enable();
  const started = performance.now();
  const result = await fn();
  const ms = performance.now() - started;
  lag.disable();
  const after = await server.usage();
  const cpu = before && after ? cpuPercent(before, after, ms) : null;

  return {
    result,
    window: {
      ms: Math.round(ms),
      serverCpuPercent: cpu?.total ?? null,
      busiestProcessCpuPercent: cpu?.busiest ?? null,
      serverRssMb: after ? Math.round(after.rssBytes / 2 ** 20) : null,
      // The histogram counts the timer's own interval, so an idle loop reads as the resolution.
      clientLagP99Ms: Math.max(0, Math.round(lag.percentile(99) / 1e6 - LAG_RESOLUTION_MS)),
    },
  };
}

export const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
