// TEMPORARY, to come out again: every two seconds, a line of what the machine is busy with, for the
// trial of what the phone suite's shared-screens tests leave CI's WebKit doing after them.
import { readdirSync, readFileSync, writeSync } from "node:fs";
import { cpus } from "node:os";

const EVERY = 2000;
const TICK = 10; // a tick of a process's time is 10 ms
const CORES = cpus().length;
const WATCHED = /Web|WPE|MiniBrowser|workerd|apport|coredump|gst/i;

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};
const list = (path) => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

/** A process's or a thread's name, its state and the ticks it has run, from its stat file. */
function ran(stat) {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(" ");
  return { name: stat.slice(stat.indexOf("(") + 1, close), state: fields[0], ticks: Number(fields[11]) + Number(fields[12]) };
}

/** The numbers a /proc file of `name value` lines gives. */
function numbers(text) {
  return Object.fromEntries(text.split("\n").map((line) => line.split(/[:\s]+/)).map(([name, value]) => [name, Number(value)]));
}

/** The whole machine's ticks, by what they went on. */
function machine() {
  const [user, nice, system, idle, iowait, irq, softirq, steal] = read("/proc/stat").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  return { busy: user + nice + system + irq + softirq, idle, iowait, steal };
}

/** How long anything has waited on `kind`, in microseconds. */
const waited = (kind) => Number(/some .*total=(\d+)/.exec(read(`/proc/pressure/${kind}`))?.[1] ?? NaN);
const allWaited = () => Object.fromEntries(["cpu", "memory", "io"].map((kind) => [kind, waited(kind)]));

const counts = (names) => [...names].map(([name, count]) => (count > 1 ? `${name}x${count}` : name)).join(" ");

let before = { at: Date.now(), ticks: new Map(), machine: machine(), counted: numbers(read("/proc/vmstat")), waited: allWaited() };

function sample() {
  const at = Date.now();
  const elapsed = at - before.at || 1;
  const share = (ticks) => Math.round((ticks * TICK * 100) / elapsed);
  const ticks = new Map();
  const busy = [];
  const watched = new Map();
  const born = new Map();
  for (const pid of list("/proc").filter((name) => /^\d+$/.test(name))) {
    const whole = ran(read(`/proc/${pid}/stat`));
    if (!whole) continue;
    if (WATCHED.test(whole.name)) watched.set(whole.name, (watched.get(whole.name) ?? 0) + 1);
    if (before.ticks.size && !before.ticks.has(pid)) born.set(whole.name, (born.get(whole.name) ?? 0) + 1);
    ticks.set(pid, whole.ticks);
    const tasks = list(`/proc/${pid}/task`);
    const threads = [];
    for (const tid of tasks) {
      const thread = ran(read(`/proc/${pid}/task/${tid}/stat`));
      if (!thread) continue;
      const key = `${pid}/${tid}`;
      ticks.set(key, thread.ticks);
      const part = share(thread.ticks - (before.ticks.get(key) ?? thread.ticks));
      if (part >= 10) threads.push([part, `${thread.name} ${part}`]);
    }
    const used = share(whole.ticks - (before.ticks.get(pid) ?? whole.ticks));
    if (used < 15) continue;
    const megabytes = Math.round((Number(read(`/proc/${pid}/statm`).split(" ")[1]) * 4096) / 1e6);
    const hot = threads.sort((a, b) => b[0] - a[0]).slice(0, 4).map(([, text]) => text).join(", ");
    busy.push([used, `${whole.name}/${pid} ${whole.state} ${used}% ${megabytes}M ${tasks.length}t (${hot})`]);
  }
  const now = machine();
  const spent = (name) => now[name] - before.machine[name];
  const all = spent("busy") + spent("idle") + spent("iowait") + spent("steal") || 1;
  const of = (name) => Math.round((spent(name) * 100 * CORES) / all);
  const memory = numbers(read("/proc/meminfo"));
  const counted = numbers(read("/proc/vmstat"));
  const since = (name) => counted[name] - before.counted[name];
  const waits = allWaited();
  const stalled = (kind) => Math.round((waits[kind] - before.waited[kind]) / (elapsed * 10));
  const line = [
    `load ${new Date(at).toISOString().slice(11, 21)}`,
    `busy ${of("busy")}% iowait ${of("iowait")}% steal ${of("steal")}% of ${CORES * 100}`,
    `queue ${read("/proc/loadavg").split(" ")[0]}`,
    `free ${Math.round(memory.MemAvailable / 1024)}M swap ${Math.round((memory.SwapTotal - memory.SwapFree) / 1024)}M in ${since("pswpin")} out ${since("pswpout")} faults ${since("pgmajfault")}`,
    `stalled cpu ${stalled("cpu")}% memory ${stalled("memory")}% io ${stalled("io")}%`,
    `has ${counts(watched)}`,
    `new ${counts(born)}`,
    busy.sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, text]) => text).join(" | "),
  ].join(" · ");
  const first = !before.ticks.size;
  before = { at, ticks, machine: now, counted, waited: waits };
  if (!first) writeSync(1, `${line}\n`);
}

sample();
setInterval(sample, EVERY);
