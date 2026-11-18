/** How many outgoing connections one invocation can have open, beyond which its calls wait their turn. */
const CONNECTIONS = 6;

/** How many rooms one invocation calls at once. */
export const ROOMS_AT_ONCE = CONNECTIONS;

/** How many pushes one invocation sends at once, so that each one's deadline runs only while it's being sent. */
export const PUSHES_AT_ONCE = CONNECTIONS;

/** Runs `work` on each of `items`, `limit` at a time. */
export async function eachAtMost<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Runs jobs `limit` at a time as they come, keeping up to `capacity` more waiting their turn and
 * dropping any beyond.
 */
export class JobQueue {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly capacity: number,
  ) {}

  /** Whether a job that came now would be turned away, as too many are waiting already. */
  get full(): boolean {
    return this.running >= this.limit && this.waiting.length >= this.capacity;
  }

  /** Runs `job` in its turn, answering whether it ran: false, at once, when too many are waiting already. */
  async run(job: () => Promise<void>): Promise<boolean> {
    if (this.running < this.limit) this.running++;
    else if (this.waiting.length < this.capacity) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else return false;
    try {
      await job();
    } finally {
      // The job's place passes to the next waiting, if there is one.
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
    return true;
  }
}
