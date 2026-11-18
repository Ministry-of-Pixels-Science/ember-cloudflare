import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { LOCAL_SCENARIOS, runBackend, SCENARIOS, type Scenario } from "./backend.ts";
import { compare } from "./compare.ts";
import { environment } from "./environment.ts";
import { PROFILES } from "./profiles.ts";
import { markdownReport, type Results } from "./report.ts";
import { existingServer, stateRoot, STORAGES, type Storage } from "./server.ts";
import { runWeb } from "./web.ts";

const USAGE = `Usage: pnpm perf [backend] [web] [options]
       pnpm perf compare <before.json> <after.json> [--threshold 10]

  --quick              Smaller rooms and fewer runs: a smoke test in a few minutes.
  --storage <list>     do-sqlite, d1, or both (the default). Backend only.
  --scenario <list>    ${SCENARIOS.join(", ")}. Backend only.
  --url <url>          Test a server that's already running instead of starting wrangler dev. Backend only; --storage names
                       its backend, or EMBER_RECOVERY_TOKEN in the environment lets /api/health tell it. Leaves out
                       ${LOCAL_SCENARIOS.join(", ")}, which only the wrangler dev this starts can run.
  --out <dir>          Where to write results.json and report.md (default perf/results/<time>).
  --threshold <pct>    For compare: how much worse a metric may get before it counts (default 10).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    quick: { type: "boolean", default: false },
    storage: { type: "string" },
    scenario: { type: "string" },
    url: { type: "string" },
    out: { type: "string" },
    threshold: { type: "string", default: "10" },
    help: { type: "boolean", short: "h", default: false },
  },
});

function pick<T extends string>(value: string | undefined, all: readonly T[], what: string): T[] {
  if (!value) return [...all];
  const picked = value.split(",").map((v) => v.trim()) as T[];
  const unknown = picked.filter((v) => !all.includes(v));
  if (unknown.length) throw new Error(`Unknown ${what} ${unknown.join(", ")}. Choose from ${all.join(", ")}.`);
  return picked;
}

/** The scenarios to run: those --scenario names, or all of them, which for a server that's already running is all that can run against one. */
function scenariosFor(url: string | undefined): Scenario[] {
  const scenarios = pick<Scenario>(values.scenario, SCENARIOS, "scenario");
  if (!url) return scenarios;
  const local = scenarios.filter((scenario) => LOCAL_SCENARIOS.includes(scenario));
  if (values.scenario && local.length) throw new Error(`--url can't run ${local.join(", ")}: only the wrangler dev that pnpm perf starts can.`);
  return scenarios.filter((scenario) => !local.includes(scenario));
}

/** Anything but a plain number, such as "10%", would make every comparison pass. */
function parseThreshold(value: string): number {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`--threshold takes a percentage as a plain number, such as 10, not "${value}".`);
  return Number(value);
}

const started = performance.now();
const log = (line: string) => console.log(`[perf ${((performance.now() - started) / 1000).toFixed(0).padStart(4)}s] ${line}`);

async function run(): Promise<Results> {
  const suites = pick(positionals.join(",") || undefined, ["backend", "web"] as const, "suite");
  if (values.url && suites.includes("web")) throw new Error("--url works with the backend suite only: pnpm perf backend --url <url>");

  const profileName = values.quick ? "quick" : "full";
  const profile = PROFILES[profileName];
  const target = values.url ?? `local wrangler dev, state in ${stateRoot}`;
  const results: Results = { environment: environment(profileName, target), backend: {}, web: null };

  if (suites.includes("backend")) {
    const scenarios = scenariosFor(values.url);
    // A running server has one storage backend: the one --storage names, else the one /api/health tells.
    const named = values.url && values.storage ? pick<Storage>(values.storage, STORAGES, "storage") : [];
    if (named.length > 1) throw new Error("--url tests one server, so --storage names one backend.");
    const storages = values.url ? [(await existingServer(values.url, named[0])).storage] : pick<Storage>(values.storage, STORAGES, "storage");
    for (const storage of storages) {
      results.backend[storage] = await runBackend({ storage, url: values.url }, profile, scenarios, log);
    }
  }
  if (suites.includes("web")) results.web = await runWeb(profile, log);
  return results;
}

/** pnpm runs this from perf/, so resolve paths against wherever `pnpm perf` was typed. */
const fromInvocation = (file: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), file);

async function readResults(file: string | undefined): Promise<Results> {
  if (!file) throw new Error(USAGE);
  return JSON.parse(await readFile(fromInvocation(file), "utf8")) as Results;
}

if (values.help) {
  console.log(USAGE);
} else if (positionals[0] === "compare") {
  const threshold = parseThreshold(values.threshold);
  const regressions = compare(await readResults(positionals[1]), await readResults(positionals[2]), threshold);
  process.exitCode = regressions > 0 ? 1 : 0;
} else {
  const results = await run();
  const report = markdownReport(results);
  const out = values.out ? fromInvocation(values.out) : path.resolve(import.meta.dirname, "../results", results.environment.date.replace(/[:.]/g, "-"));
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  await writeFile(path.join(out, "report.md"), report);
  console.log(`\n${report}`);
  log(`Wrote ${path.join(out, "report.md")} and results.json`);
}
