import { TOUCHES } from "./huddle-speaker";

// Who's speaking in a huddle, by how loud each voice is: the others', as the tab plays them, and its
// own, from its microphone. The browser's audio engine measures them (Web Audio), since what a
// connection's statistics say of a voice's level differs from browser to browser, and Safari's say
// nothing of it. Nothing plays from here: the voices are heard through the huddle's speaker.

/** How loud a voice is from when it's speech, as the root mean square of its samples, where 1 is as loud as a sample gets. */
export const SPEAKING_LEVEL = 0.01;
/** How often the voices are measured. */
export const MEASURED_EVERY_MS = 100;
/** How long someone who has gone quiet still counts as speaking, so that the gaps between their words don't end it. */
export const QUIET_FOR_MS = 600;
/** How many samples a measure takes: 171 ms of a voice at 48 kHz, more than passes between two measures, so none of it goes unmeasured. */
const SAMPLES = 8192;

/** A voice being measured: what feeds it to its analyser, and when it was last as loud as speech, or 0 before it has been. */
interface Voice {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  loudAt: number;
}

/** How loud what `analyser` hears is now. */
function levelOf(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples);
  let squares = 0;
  for (const sample of samples) squares += sample * sample;
  return Math.sqrt(squares / samples.length);
}

/** The browser's audio engine, started, or null in a browser that has none, or won't start one. */
function startedEngine(): AudioContext | null {
  try {
    return "AudioContext" in window ? new AudioContext() : null;
  } catch {
    return null;
  }
}

/** What measures a huddle's voices. */
export interface HuddleSpeaking {
  /** Measures `whose` voice from now, by its track, in place of any it measured as theirs. */
  hear(whose: string, voice: MediaStreamTrack): void;
  /** Measures `whose` voice no longer, so they aren't speaking. */
  forget(whose: string): void;
  /** Stops measuring, for good. */
  stop(): void;
}

/**
 * Has `changed` hear who's speaking, of the voices it's given, whenever that changes. In a browser
 * without an audio engine, or that won't run one, nobody ever is. It starts the engine at once, since
 * a browser lets one run that's started as its person clicks, as they do to join a huddle.
 */
export function whoSpeaks(changed: (speaking: ReadonlySet<string>) => void): HuddleSpeaking {
  const voices = new Map<string, Voice>();
  const samples = new Float32Array(SAMPLES);
  let speaking: ReadonlySet<string> = new Set();
  /** Null once it's stopped, too. */
  let engine = startedEngine();
  /** The engine's own time when it was last found not to be running. */
  let stoodAt = -Infinity;

  /**
   * Whether the analysers hold only what's heard now. An engine the browser has stopped hears nothing
   * new, and its analysers keep what they last heard: while it stands, and once it runs again until it
   * has run for as long as they hold. It's given twice that long, since a few milliseconds of old
   * speech left among the samples would still measure as speech.
   */
  const hearsNow = () => {
    if (engine?.state !== "running") {
      stoodAt = engine?.currentTime ?? stoodAt;
      return false;
    }
    return engine.currentTime - stoodAt >= (2 * SAMPLES) / engine.sampleRate;
  };
  const listen = (now: number) => {
    for (const voice of voices.values()) if (levelOf(voice.analyser, samples) >= SPEAKING_LEVEL) voice.loudAt = now;
  };

  const measure = () => {
    const now = Date.now();
    if (hearsNow()) listen(now);
    const heard = [...voices].filter(([, { loudAt }]) => loudAt > 0 && now - loudAt < QUIET_FOR_MS).map(([whose]) => whose);
    if (heard.length === speaking.size && heard.every((whose) => speaking.has(whose))) return;
    speaking = new Set(heard);
    changed(speaking);
  };
  const measuring = engine ? setInterval(measure, MEASURED_EVERY_MS) : null;
  // A browser that kept the engine from running all the same lets it run once its person has touched the page.
  const run = () => {
    if (engine && engine.state !== "running") void engine.resume().catch(() => {});
  };
  // In the capture phase, which hears a click that whatever it lands on keeps to itself.
  if (engine) for (const touch of TOUCHES) document.addEventListener(touch, run, true);
  const forget = (whose: string) => {
    voices.get(whose)?.source.disconnect();
    voices.delete(whose);
  };

  return {
    hear(whose, voice) {
      forget(whose);
      if (!engine) return;
      try {
        const source = engine.createMediaStreamSource(new MediaStream([voice]));
        const analyser = engine.createAnalyser();
        analyser.fftSize = SAMPLES;
        source.connect(analyser);
        voices.set(whose, { source, analyser, loudAt: 0 });
      } catch {
        // A voice the browser won't measure is heard all the same, and its person never shows as speaking.
      }
    },
    forget,
    stop() {
      if (measuring !== null) clearInterval(measuring);
      for (const touch of TOUCHES) document.removeEventListener(touch, run, true);
      for (const whose of [...voices.keys()]) forget(whose);
      void engine?.close().catch(() => {});
      engine = null;
    },
  };
}
