import { vi } from "vitest";

/** One of the page's audio engines, as a test sees it. */
interface StartedEngine {
  /** A test that sets it is the browser stopping the engine, or letting it run again. */
  state: AudioContextState;
}

/** The audio engine a test gives the page, in place of a browser's. */
export interface TestAudioEngine {
  /** Has `track` be as loud as `level` from now, where 1 is as loud as a sample gets. A track is silent until it's said to be louder. */
  setLevel(track: object, level: number): void;
  /** The tracks the page measures now, in the order it began to. */
  measured(): object[];
  /** The engines the page has started, in order. */
  engines: StartedEngine[];
}

/**
 * Gives the page a browser's audio engine (Web Audio's AudioContext), which jsdom has none of, until
 * the test's globals are unstubbed: as much of one as measures a track, each of whose samples is as
 * loud as the test says. As a browser's does, an analyser keeps what it heard as its engine stopped
 * running, and goes on holding that once the engine runs again, until it has run for as long as the
 * analyser's samples last by the test's clock. `state` is the one an engine starts in: "suspended" in
 * a browser that runs none until its person has touched the page. The page's MediaStream has to say
 * which audio tracks it holds.
 */
export function audioEngine(state: AudioContextState = "running"): TestAudioEngine {
  const levels = new Map<object, number>();
  const engines: Engine[] = [];

  class Source {
    measuredBy: Analyser | null = null;
    constructor(readonly track: object) {}
    connect(analyser: Analyser) {
      this.measuredBy = analyser;
      analyser.source = this;
    }
    disconnect() {
      if (this.measuredBy) this.measuredBy.source = null;
      this.measuredBy = null;
    }
  }

  class Analyser {
    fftSize = 2048;
    source: Source | null = null;
    /** How loud what it heard as its engine last stopped running was. */
    private held = 0;
    constructor(private readonly engine: Engine) {}
    getFloatTimeDomainData(samples: Float32Array) {
      samples.fill(this.engine.hasRunFor(this.fftSize) ? this.level() : this.held);
    }
    hold() {
      this.held = this.level();
    }
    private level() {
      return this.source ? (levels.get(this.source.track) ?? 0) : 0;
    }
  }

  class Engine implements StartedEngine {
    readonly sampleRate = 48_000;
    sources: Source[] = [];
    private analysers: Analyser[] = [];
    private current = state;
    /** How long it had run when its state last changed, in seconds, and when that was. */
    private ran = 0;
    private changedAt = Date.now();
    /** How long it had run when it was last set running. One that started running never was, and its analysers hold nothing from before. */
    private beganAt = -Infinity;
    constructor() {
      engines.push(this);
    }
    get state() {
      return this.current;
    }
    set state(next) {
      const [ran, runs] = [this.currentTime, this.current === "running"];
      if (runs && next !== "running") for (const analyser of this.analysers) analyser.hold();
      if (!runs && next === "running") this.beganAt = ran;
      [this.ran, this.changedAt, this.current] = [ran, Date.now(), next];
    }
    get currentTime() {
      return this.ran + (this.current === "running" ? (Date.now() - this.changedAt) / 1000 : 0);
    }
    /** Whether it has run for as long as `samples` samples last since it was last set running. */
    hasRunFor(samples: number) {
      return this.current === "running" && this.currentTime - this.beganAt >= samples / this.sampleRate;
    }
    createMediaStreamSource(stream: MediaStream) {
      const source = new Source(stream.getAudioTracks()[0]!);
      this.sources.push(source);
      return source;
    }
    createAnalyser() {
      const analyser = new Analyser(this);
      this.analysers.push(analyser);
      return analyser;
    }
    async resume() {
      this.state = "running";
    }
    async close() {
      this.state = "closed";
    }
  }

  vi.stubGlobal("AudioContext", Engine);
  return {
    setLevel: (track, level) => void levels.set(track, level),
    measured: () => engines.flatMap(({ sources }) => sources.flatMap(({ measuredBy, track }) => (measuredBy ? track : []))),
    engines,
  };
}
