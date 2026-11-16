import { vi } from "vitest";

/** One of the page's audio engines, as a test sees it. */
interface StartedEngine {
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
 * loud as the test says, or silent while the engine isn't running. `state` is the one an engine starts
 * in: "suspended" in a browser that runs none until its person has touched the page. The page's
 * MediaStream has to say which audio tracks it holds.
 */
export function audioEngine(state: AudioContextState = "running"): TestAudioEngine {
  const levels = new Map<object, number>();
  const engines: Engine[] = [];

  class Source {
    measuredBy: Analyser | null = null;
    constructor(
      readonly engine: Engine,
      readonly track: object,
    ) {}
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
    getFloatTimeDomainData(samples: Float32Array) {
      samples.fill(this.source?.engine.state === "running" ? (levels.get(this.source.track) ?? 0) : 0);
    }
  }

  class Engine implements StartedEngine {
    state = state;
    sources: Source[] = [];
    constructor() {
      engines.push(this);
    }
    createMediaStreamSource(stream: MediaStream) {
      const source = new Source(this, stream.getAudioTracks()[0]!);
      this.sources.push(source);
      return source;
    }
    createAnalyser = () => new Analyser();
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
