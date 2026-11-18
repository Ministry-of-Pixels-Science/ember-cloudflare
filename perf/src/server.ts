import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { experimental_readRawConfig } from "wrangler";

// Runs the real Worker under `wrangler dev`, once per storage backend, each time with fresh local state.

export type Storage = "do-sqlite" | "d1";
export const STORAGES: Storage[] = ["do-sqlite", "d1"];

const repoRoot = path.resolve(import.meta.dirname, "../..");
const workerDir = path.join(repoRoot, "apps/worker");
const wranglerBin = path.join(path.dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin/wrangler.js");

export interface Server {
  url: string;
  storage: Storage;
  /** CPU time and memory of the wrangler/workerd process tree, or null where /proc isn't available. */
  usage(): Promise<Usage | null>;
  stop(): Promise<void>;
}

export interface Usage {
  /** CPU seconds each process in the tree has used so far, by pid. */
  cpuSeconds: Map<number, number>;
  rssBytes: number;
}

/** Every wrangler we started and every scratch directory we made, so a crash or Ctrl-C leaves neither behind. */
const running = new Set<ChildProcess>();
const scratch = new Set<string>();
process.on("exit", () => {
  running.forEach((child) => child.kill("SIGTERM"));
  scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

/**
 * The root wrangler.jsonc, switched to `storage` and with its paths made absolute so the copy
 * can live in a scratch directory. D1 gets a local database that only this run uses.
 */
function configFor(storage: Storage, assetsDir: string) {
  const { rawConfig } = experimental_readRawConfig({ config: path.join(repoRoot, "wrangler.jsonc") });
  const { $schema: _, ...config } = rawConfig as typeof rawConfig & { $schema?: string };
  return {
    ...config,
    main: path.resolve(repoRoot, config.main!),
    assets: { ...config.assets, directory: assetsDir },
    vars: { ...config.vars, STORAGE_BACKEND: storage },
    d1_databases:
      storage === "d1"
        ? [{ binding: "DB", database_name: "ember-perf", database_id: "ember-perf", migrations_dir: path.join(workerDir, "migrations") }]
        : [],
  };
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  server.close();
  return port;
}

function wrangler(args: string[], cwd: string): ChildProcess {
  const child = spawn(process.execPath, [wranglerBin, ...args], {
    cwd,
    // CI=true answers wrangler's prompts (d1 migrations apply asks before applying).
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);
  child.once("exit", () => running.delete(child));
  return child;
}

/** Keeps the tail of a child's output to explain a failure. */
function captureOutput(child: ChildProcess): () => string {
  const lines: string[] = [];
  const keep = (chunk: Buffer) => {
    lines.push(...chunk.toString().split("\n").filter(Boolean));
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  return () => lines.join("\n");
}

async function run(args: string[], cwd: string): Promise<void> {
  const child = wrangler(args, cwd);
  const output = captureOutput(child);
  const [code] = (await once(child, "exit")) as [number | null];
  if (code !== 0) throw new Error(`wrangler ${args.join(" ")} failed:\n${output()}`);
}

async function waitForHealth(url: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${output()}`);
    try {
      if ((await fetch(new URL("/api/health", url))).ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  throw new Error(`wrangler dev didn't become healthy within 60s:\n${output()}`);
}

/**
 * Local storage goes in memory where Linux offers it, so the machine's disk flush speed doesn't
 * decide the write numbers. Neither a disk nor memory is what production durability costs anyway.
 */
export const stateRoot = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();

/** Starts `wrangler dev` for `storage`, serving `assetsDir` (an empty directory if omitted), with `vars` beside the Worker's own. */
export async function startServer(storage: Storage, assetsDir?: string, vars: Record<string, string> = {}): Promise<Server> {
  const dir = await mkdtemp(path.join(stateRoot, `ember-perf-${storage}-`));
  scratch.add(dir);
  const removeDir = async () => {
    await rm(dir, { recursive: true, force: true });
    scratch.delete(dir);
  };
  const state = path.join(dir, "state");
  const config = path.join(dir, "wrangler.json");
  try {
    const assets = assetsDir ?? path.join(dir, "assets");
    await mkdir(assets, { recursive: true });
    await writeFile(config, JSON.stringify(configFor(storage, assets), null, 2));
    if (storage === "d1") await run(["d1", "migrations", "apply", "DB", "--local", "--config", config, "--persist-to", state], dir);
  } catch (error) {
    // Nothing is running yet, so the scratch directory is all there is to clean up.
    await removeDir();
    throw error;
  }

  const port = await freePort();
  const given = Object.entries({ SESSION_SECRET: "perf-secret", EMBER_GUEST_SIGN_IN: "true", ...vars }).flatMap(([name, value]) => ["--var", `${name}:${value}`]);
  const child = wrangler(["dev", "--config", config, "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state, ...given, "--log-level", "warn", "--show-interactive-dev-session=false"], dir);
  const output = captureOutput(child);
  const url = `http://127.0.0.1:${port}`;

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const stubborn = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(stubborn);
    }
    await removeDir();
  };

  try {
    await waitForHealth(url, child, output);
  } catch (error) {
    await stop();
    throw error;
  }
  return { url, storage, usage: () => processTreeUsage(child.pid!), stop };
}

/**
 * Points at a server someone else started, such as `pnpm dev` or a deployed Worker, which uses
 * `storage`, or whichever /api/health says it does.
 */
export async function existingServer(url: string, storage?: Storage): Promise<Server> {
  return { url, storage: storage ?? (await storageOf(url)), usage: async () => null, stop: async () => {} };
}

/** Which storage the server at `url` uses, which /api/health tells only an administrator or whoever sends EMBER_RECOVERY_TOKEN. */
async function storageOf(url: string): Promise<Storage> {
  const token = process.env.EMBER_RECOVERY_TOKEN;
  const response = await fetch(new URL("/api/health", url), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const health = (await response.json()) as { storage?: Storage };
  if (!health.storage) {
    throw new Error("/api/health tells only an administrator, or whoever sends EMBER_RECOVERY_TOKEN, which storage the server uses: set it in the environment, or pass --storage.");
  }
  return health.storage;
}

const CLOCK_TICKS = 100; // USER_HZ, which is 100 on every Linux we'd run this on.

interface ProcStat {
  ppid: number;
  cpuSeconds: number;
  rssBytes: number;
}

async function readProcStat(pid: number): Promise<ProcStat | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The command name can contain spaces, so split after its closing parenthesis.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const [ppid, utime, stime, rssPages] = [fields[1], fields[11], fields[12], fields[21]].map(Number);
    return { ppid: ppid!, cpuSeconds: (utime! + stime!) / CLOCK_TICKS, rssBytes: rssPages! * 4096 };
  } catch {
    return null;
  }
}

/** CPU per process and total resident memory for `root` and its descendants (wrangler, workerd). Linux only. */
async function processTreeUsage(root: number): Promise<Usage | null> {
  if (process.platform !== "linux") return null;
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name)).map(Number);
  const stats = new Map<number, ProcStat>();
  await Promise.all(
    pids.map(async (pid) => {
      const stat = await readProcStat(pid);
      if (stat) stats.set(pid, stat);
    }),
  );

  const inTree = (pid: number): boolean => {
    for (let current: number | undefined = pid; current; current = stats.get(current)?.ppid) {
      if (current === root) return true;
    }
    return false;
  };
  const cpuSeconds = new Map<number, number>();
  let rssBytes = 0;
  for (const [pid, stat] of stats) {
    if (!inTree(pid)) continue;
    cpuSeconds.set(pid, stat.cpuSeconds);
    rssBytes += stat.rssBytes;
  }
  return { cpuSeconds, rssBytes };
}
