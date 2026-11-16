import { sound } from "./huddle-sounds";
// A file of its own, as the huddle's other sounds are (huddle-sounds.ts).
import invitedUrl from "./huddle-sounds/invited.mp3?no-inline";

/** The lock a tab holds for as long as it rings, which the tabs of a browser share. */
export const RING_LOCK = "ember-huddle-ring";

/**
 * How long a tab is given to start the ring before it gives its turn up: Chrome starts no sound in a
 * tab that's hidden and has played none yet, until the tab is shown, and says nothing of it meanwhile.
 */
export const RING_STARTS_WITHIN_MS = 1_000;

/**
 * Rings for an invitation into a huddle until what it returns is called: the invitation's sound
 * (huddle-sounds/README.md), over and over, through the system's own speaker, since whoever is invited
 * may not be wearing what they huddle with. Every tab of a browser shows an invitation, and one of them
 * at a time rings for it, by a lock they share, which a tab asks for once it has the sound's file. The
 * next takes over once the one ringing is closed, or isn't let play a sound, as a tab nobody has touched
 * isn't, or hasn't started it in time, as a hidden tab may not: that one takes another turn after the
 * others, so it rings once it's shown if nothing else does. A tab that isn't let play it rings nothing,
 * the invitation being there to see.
 */
export function ringForHuddle(): () => void {
  const stop = new AbortController();
  const stopped = new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
  const { audio, load } = sound("invited", invitedUrl);
  audio.loop = true;
  /** A turn at ringing: until the ring is stopped, or, when the sound doesn't start, for as long as it's given to. */
  const takeTurn = async () => {
    let givenUp: ReturnType<typeof setTimeout> | undefined;
    const tooLong = new Promise<void>((resolve) => (givenUp = setTimeout(resolve, RING_STARTS_WITHIN_MS)));
    try {
      const started = await Promise.race([audio.play().then(() => true), Promise.race([stopped, tooLong]).then(() => false)]).finally(() => clearTimeout(givenUp));
      if (started) await stopped;
    } finally {
      // Which takes back a sound still to start, too: it would start once the tab is shown, after its turn.
      audio.pause();
    }
  };
  const ring = async () => {
    await load();
    // Where a browser has no locks, each of its tabs rings.
    while (!stop.signal.aborted) await (navigator.locks ? navigator.locks.request(RING_LOCK, { signal: stop.signal }, takeTurn) : takeTurn());
  };
  // Stopped before its turn, or refused its sound or its file, it has rung nothing.
  ring().catch(() => {});
  return () => stop.abort();
}
