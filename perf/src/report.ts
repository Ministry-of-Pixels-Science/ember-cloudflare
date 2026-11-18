import type { BackendResults } from "./backend.ts";
import type { Environment } from "./environment.ts";
import type { Storage } from "./server.ts";
import type { Summary } from "./stats.ts";
import type { WebResults } from "./web.ts";

export interface Results {
  environment: Environment;
  backend: Partial<Record<Storage, BackendResults>>;
  web: WebResults | null;
}

const STORAGE_NAMES: Record<Storage, string> = { "do-sqlite": "DO SQLite", d1: "D1" };

const num = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined || Number.isNaN(value) ? "–" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
/** Milliseconds, with a decimal only where it matters. */
const ms = (value: number | null | undefined) => num(value, value !== null && value !== undefined && value < 10 ? 1 : 0);
const pct = (value: number | null) => (value === null ? "–" : `${value}%`);
const p = (summary: Summary | null, key: "p50" | "p95" | "p99") => ms(summary?.[key]);

function table(headers: string[], rows: string[][]): string {
  const align = headers.map((_, i) => (i === 0 ? "---" : "--:"));
  return [headers, align, ...rows].map((cells) => `| ${cells.join(" | ")} |`).join("\n");
}

function backendSection(backend: Results["backend"]): string[] {
  const runs = Object.entries(backend) as Array<[Storage, BackendResults]>;
  if (runs.length === 0) return [];
  const out = ["## Backend", "", "Milliseconds from one client sending a frame to a client receiving the result, through `wrangler dev`."];

  const latency = runs.filter(([, r]) => r.latency);
  if (latency.length) {
    const { messages, rate } = latency[0]![1].latency!;
    out.push("", `### Message latency`, "", `Two members, one posting ${rate} messages a second (${messages} messages). Ack is the sender seeing its own message come back.`, "");
    out.push(
      table(
        ["Storage", "Ack p50", "p95", "p99", "Delivery p50", "p95", "p99", "Lost"],
        latency.map(([storage, { latency: r }]) => [STORAGE_NAMES[storage], p(r!.ack, "p50"), p(r!.ack, "p95"), p(r!.ack, "p99"), p(r!.delivery, "p50"), p(r!.delivery, "p95"), p(r!.delivery, "p99"), num(r!.lost)]),
      ),
    );
  }

  const throughput = runs.filter(([, r]) => r.throughput);
  if (throughput.length) {
    const { senders, inFlight, messages } = throughput[0]![1].throughput!;
    out.push("", "### Write throughput", "", `${senders} members posting as fast as the room acknowledges, ${inFlight} messages in flight each (${messages} messages).`, "");
    out.push(
      table(
        ["Storage", "Messages/s", "Ack p50", "p95", "p99", "Out of order", "Busiest process CPU"],
        throughput.map(([storage, { throughput: r }]) => [
          STORAGE_NAMES[storage],
          num(r!.messagesPerSecond),
          p(r!.ack, "p50"),
          p(r!.ack, "p95"),
          p(r!.ack, "p99"),
          num(r!.outOfOrder),
          pct(r!.window.busiestProcessCpuPercent),
        ]),
      ),
    );
  }

  const fanout = runs.filter(([, r]) => r.fanout?.length);
  if (fanout.length) {
    const { rate, messages } = fanout[0]![1].fanout![0]!;
    out.push("", "### Fan-out", "", `One member posting ${rate} messages a second (${messages} messages) to everyone else. Last member is how long until the final copy of a message lands.`, "");
    out.push(
      table(
        ["Storage", "Members", "Delivery p50", "p95", "p99", "Last member p50", "p95", "Busiest process CPU", "Lost"],
        fanout.flatMap(([storage, { fanout: rows }]) =>
          rows!.map((r) => [STORAGE_NAMES[storage], num(r.members), p(r.delivery, "p50"), p(r.delivery, "p95"), p(r.delivery, "p99"), p(r.completion, "p50"), p(r.completion, "p95"), pct(r.window.busiestProcessCpuPercent), num(r.lost)]),
        ),
      ),
    );
  }

  const connections = runs.filter(([, r]) => r.connections);
  if (connections.length) {
    const { concurrency, maxConnectP95Ms } = connections[0]![1].connections!;
    out.push(
      "",
      "### Room size",
      "",
      `One room grown step by step, ${concurrency} joins at a time, until p95 time-to-welcome passes ${num(maxConnectP95Ms)} ms. Presence per join is what the room sends to everyone already in it each time someone joins.`,
      "",
    );
    out.push(
      table(
        ["Storage", "Members", "Join p50", "p95", "Joins/s", "Presence per join", "Busiest process CPU", "Server memory"],
        connections.flatMap(([storage, { connections: r }]) =>
          r!.steps.map((step) => [
            STORAGE_NAMES[storage],
            num(step.members),
            p(step.connect, "p50"),
            p(step.connect, "p95"),
            num(step.joinsPerSecond, 1),
            `${num(step.presenceKbPerJoin)} KB`,
            pct(step.window.busiestProcessCpuPercent),
            step.window.serverRssMb === null ? "–" : `${num(step.window.serverRssMb)} MB`,
          ]),
        ),
      ),
    );
    for (const [storage, { connections: r }] of connections) if (r!.stopped) out.push("", `${STORAGE_NAMES[storage]} stopped: ${r!.stopped}.`);
  }

  const tabs = runs.filter(([, r]) => r.tabs);
  if (tabs.length) {
    const { concurrency, rooms, maxConnectP95Ms } = tabs[0]![1].tabs!;
    out.push(
      "",
      "### Tabs",
      "",
      `Tabs opened as the app opens them, ${concurrency} at a time, until p95 time to the workspace's welcome passes ${num(maxConnectP95Ms)} ms: a room's socket, spread over ${rooms} rooms, the workspace socket, and the sidebar and people directory, each loaded as the page loads and again on the welcome. Each tab is someone else signed in, so the directory grows with the tabs.`,
      "",
    );
    out.push(
      table(
        ["Storage", "Tabs", "Welcome p50", "p95", "Sidebar p50", "p95", "Directory p50", "p95", "Tabs/s", "Busiest process CPU", "Server memory"],
        tabs.flatMap(([storage, { tabs: r }]) =>
          r!.steps.map((step) => [
            STORAGE_NAMES[storage],
            num(step.tabs),
            p(step.welcome, "p50"),
            p(step.welcome, "p95"),
            p(step.sidebar, "p50"),
            p(step.sidebar, "p95"),
            p(step.directory, "p50"),
            p(step.directory, "p95"),
            num(step.tabsPerSecond, 1),
            pct(step.window.busiestProcessCpuPercent),
            step.window.serverRssMb === null ? "–" : `${num(step.window.serverRssMb)} MB`,
          ]),
        ),
      ),
    );
    for (const [storage, { tabs: r }] of tabs) if (r!.stopped) out.push("", `${STORAGE_NAMES[storage]} stopped: ${r!.stopped}.`);

    const reconnects = tabs.flatMap(([storage, { tabs: r }]) => (r!.reconnect ? [[storage, r!.reconnect] as const] : []));
    if (reconnects.length) {
      out.push(
        "",
        "Then every tab's sockets close, and each tab connects them again as the app does after a deploy: its room's a quarter of a second to two seconds later, and its workspace socket 2 to 10 seconds later, loading the sidebar and people directory on the welcome. Welcomes are timed from each socket's own try. All back is the time from the deploy to the last tab with both welcomes, its sidebar and its directory.",
        "",
      );
      out.push(
        table(
          ["Storage", "Tabs", "Welcome p50", "p95", "Room welcome p50", "p95", "Sidebar p50", "p95", "Directory p50", "p95", "All back", "Failed", "Busiest process CPU"],
          reconnects.map(([storage, r]) => [
            STORAGE_NAMES[storage],
            num(r.tabs),
            p(r.welcome, "p50"),
            p(r.welcome, "p95"),
            p(r.roomWelcome, "p50"),
            p(r.roomWelcome, "p95"),
            p(r.sidebar, "p50"),
            p(r.sidebar, "p95"),
            p(r.directory, "p50"),
            p(r.directory, "p95"),
            `${ms(r.allBackMs)} ms`,
            num(r.failures),
            pct(r.window.busiestProcessCpuPercent),
          ]),
        ),
      );
    }
  }

  const unread = runs.filter(([, r]) => r.unread?.length);
  if (unread.length) {
    const { rate, messages } = unread[0]![1].unread![0]!;
    out.push(
      "",
      "### Unread marks",
      "",
      `One member posting in a room everyone else is away from, each with only the workspace's socket open. Marked is the first message to each of them hearing the room is unread. Then ${messages} more messages, ${rate} a second, which mark nobody new: ack is the poster seeing each come back, while the Workspace applies it, and lost counts those that never did.`,
      "",
    );
    out.push(
      table(
        ["Storage", "Away", "Marked p50", "p95", "Last", "Missed", "Then ack p50", "p95", "Lost", "Server CPU", "Busiest process CPU"],
        unread.flatMap(([storage, { unread: rows }]) =>
          rows!.map((r) => [
            STORAGE_NAMES[storage],
            num(r.members),
            p(r.marked, "p50"),
            p(r.marked, "p95"),
            ms(r.marked?.max),
            num(r.missed),
            p(r.ack, "p50"),
            p(r.ack, "p95"),
            num(r.lost),
            pct(r.window.serverCpuPercent),
            pct(r.window.busiestProcessCpuPercent),
          ]),
        ),
      ),
    );
  }

  const history = runs.filter(([, r]) => r.history);
  if (history.length) {
    const { messages, welcomes } = history[0]![1].history!;
    out.push("", "### History", "", `A room with ${num(messages)} messages: ${welcomes} fresh joins (the welcome carries the newest page), then paging back to the start.`, "");
    out.push(
      table(
        ["Storage", "Welcome p50", "p95", "Page p50", "p95", "p99"],
        history.map(([storage, { history: r }]) => [STORAGE_NAMES[storage], p(r!.welcome, "p50"), p(r!.welcome, "p95"), p(r!.page, "p50"), p(r!.page, "p95"), p(r!.page, "p99")]),
      ),
    );
  }

  const search = runs.filter(([, r]) => r.search);
  if (search.length) {
    const { rooms, messages } = search[0]![1].search!;
    out.push(
      "",
      "### Search",
      "",
      `${num(messages)} messages written in each of ${rooms} rooms at once, then searched for by someone in all of them. Catch-up is the last of them being acknowledged until a search finds it. New message is a message in a quiet room being acknowledged until a search finds it, searching every 10 ms. Then each search is timed alone: common is a word in a quarter of the messages, whose newest 100 come from every room, rare a word in one message in each room, and none a word in no message.`,
      "",
    );
    out.push(
      table(
        ["Storage", "Catch-up", "New message p50", "p95", "Common p50", "p95", "Rare p50", "p95", "None p50", "p95"],
        search.map(([storage, { search: r }]) => [
          STORAGE_NAMES[storage],
          `${ms(r!.catchUpMs)} ms`,
          p(r!.newMessage, "p50"),
          p(r!.newMessage, "p95"),
          p(r!.common, "p50"),
          p(r!.common, "p95"),
          p(r!.rare, "p50"),
          p(r!.rare, "p95"),
          p(r!.none, "p50"),
          p(r!.none, "p95"),
        ]),
      ),
    );
  }

  const huddles = runs.filter(([, r]) => r.huddle);
  if (huddles.length) {
    const { reactions, rate } = huddles[0]![1].huddle!;
    out.push(
      "",
      "### Huddles",
      "",
      `One huddle grown a person at a time, each joining with their voice once the last is heard by everyone. The SFU is a stand-in on this machine that answers at once, so the times are the room's own: nothing anyone says passes through Ember. Welcome is opening the huddle's socket to the room's welcome. Hears all is from someone's welcome to the room saying that they receive everyone who was in the huddle, and heard by all to the last of those receiving them. SFU requests are what the room asked of the SFU for the last of them to join. Then ${reactions} reactions, ${rate} a second, from the people in turn: reaction is one reaching each person in the huddle.`,
      "",
    );
    out.push(
      table(
        ["Storage", "People", "Welcome p50", "p95", "Hears all p50", "p95", "Heard by all p50", "p95", "SFU requests", "Reaction p50", "p95", "Lost", "Busiest process CPU"],
        huddles.flatMap(([storage, { huddle: r }]) =>
          r!.steps.map((step) => [
            STORAGE_NAMES[storage],
            num(step.people),
            p(step.welcome, "p50"),
            p(step.welcome, "p95"),
            p(step.hearsAll, "p50"),
            p(step.hearsAll, "p95"),
            p(step.heardByAll, "p50"),
            p(step.heardByAll, "p95"),
            num(step.sfuRequestsForLastJoin),
            p(step.reaction, "p50"),
            p(step.reaction, "p95"),
            num(step.lost),
            pct(step.window.busiestProcessCpuPercent),
          ]),
        ),
      ),
    );
    for (const [storage, { huddle: r }] of huddles) {
      if (r!.stopped) out.push("", `${STORAGE_NAMES[storage]} stopped: ${r!.stopped}.`);
      if (r!.errors) out.push("", `${STORAGE_NAMES[storage]}: the room told its tabs of ${num(r!.errors)} errors.`);
    }
  }
  return out;
}

function webSection(web: WebResults): string[] {
  const out = ["## Frontend", "", `Chrome ${web.chrome}.`];

  const { code, files } = web.bundle;
  out.push("", "### Bundle", "", `JavaScript and CSS: ${num(code.kb, 1)} KB raw, ${num(code.gzipKb, 1)} KB gzip, ${num(code.brotliKb, 1)} KB brotli.`, "");
  out.push(table(["File", "Raw", "Gzip", "Brotli"], files.map((f) => [`\`${f.file}\``, `${num(f.kb, 1)} KB`, `${num(f.gzipKb, 1)} KB`, `${num(f.brotliKb, 1)} KB`])));

  const runs = web.lighthouse[0]?.runs ?? 0;
  out.push("", "### Lighthouse", "", `Cold loads, median of ${runs}. Mobile simulates slow 4G and a 4x slower CPU; desktop a fast connection. The room page loads signed in.`, "");
  out.push(
    table(
      ["Page", "Form factor", "Score", "FCP", "LCP", "TBT", "CLS", "Speed Index", "Transfer"],
      web.lighthouse.map((r) => [r.page, r.formFactor, num(r.score), ms(r.fcpMs), ms(r.lcpMs), ms(r.tbtMs), num(r.cls, 3), ms(r.speedIndexMs), `${num(r.transferKb)} KB`]),
    ),
  );

  const burst = web.render[0]?.bursts[0];
  if (burst) {
    out.push(
      "",
      "### Live rendering",
      "",
      `A signed-in browser at the bottom of a room while another member posts ${burst.rate} messages a second (${burst.messages} per burst). Frame to paint is a message.created frame reaching the page until the frame showing it is painted. Main thread is Chrome's own task time per incoming message.`,
      "",
    );
    out.push(
      table(
        ["CPU", "Timeline", "Frame to DOM p50", "p95", "Frame to paint p50", "p95", "Main thread per message", "Long tasks", "Idle main thread", "JS heap"],
        web.render.flatMap((r) =>
          r.bursts.map((b) => [
            `${r.cpuSlowdown}x`,
            num(b.timeline),
            p(b.frameToDom, "p50"),
            p(b.frameToDom, "p95"),
            p(b.frameToPaint, "p50"),
            p(b.frameToPaint, "p95"),
            `${ms(b.mainThreadMsPerMessage)} ms`,
            num(b.longTasks),
            `${ms(b.idleMainThreadMsPerSecond)} ms/s`,
            `${num(b.heapMb, 1)} MB`,
          ]),
        ),
      ),
    );
    out.push("", "Main-thread time per message by kind of work. Other is mostly paint, compositing and garbage collection.", "");
    out.push(
      table(
        ["CPU", "Timeline", "Script", "Style", "Layout", "Other"],
        web.render.flatMap((r) =>
          r.bursts.map((b) => {
            const { scriptMs, styleMs, layoutMs } = b.mainThreadBreakdown;
            const otherMs = Math.max(0, b.mainThreadMsPerMessage - scriptMs - styleMs - layoutMs);
            return [`${r.cpuSlowdown}x`, num(b.timeline), `${ms(scriptMs)} ms`, `${ms(styleMs)} ms`, `${ms(layoutMs)} ms`, `${ms(otherMs)} ms`];
          }),
        ),
      ),
    );
    out.push("", table(["CPU", "Room ready", "Load older page p50", "p95"], web.render.map((r) => [`${r.cpuSlowdown}x`, `${ms(r.roomReadyMs)} ms`, p(r.loadOlder, "p50"), p(r.loadOlder, "p95")])));
    out.push("", "Room ready is navigation start to the newest messages being in the DOM.");
  }
  return out;
}

export function markdownReport({ environment: env, backend, web }: Results): string {
  return [
    "# Ember performance report",
    "",
    `${env.date.slice(0, 16).replace("T", " ")} UTC · commit ${env.commit} · ${env.profile} profile · ${env.target}`,
    "",
    `${env.cpu}, ${env.cores} cores, ${env.memoryGb} GB · ${env.os} · Node ${env.node} · wrangler ${env.wrangler} · workerd ${env.workerd} · Lighthouse ${env.lighthouse}`,
    "",
    ...backendSection(backend),
    ...(web ? ["", ...webSection(web)] : []),
    "",
  ].join("\n");
}
