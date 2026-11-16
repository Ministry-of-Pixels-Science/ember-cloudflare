import { sound } from "./huddle-sounds";
// A file of its own, as the huddle's other sounds are (huddle-sounds.ts).
import invitedUrl from "./huddle-sounds/invited.mp3?no-inline";

/** The lock a tab holds for as long as it rings, which the tabs of a browser share. */
export const RING_LOCK = "ember-huddle-ring";

/**
 * Rings for an invitation into a huddle until what it returns is called: the invitation's sound
 * (huddle-sounds/README.md), over and over, through the system's own speaker, since whoever is invited
 * may not be wearing what they huddle with. Every tab of a browser shows an invitation, and one of them
 * at a time rings for it, by a lock they share: the next takes over once that one is closed, or isn't
 * let play a sound, as a tab nobody has touched isn't. A tab that can't play it rings nothing, the
 * invitation being there to see.
 */
export function ringForHuddle(): () => void {
  const stop = new AbortController();
  const stopped = new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
  const ring = async () => {
    const { audio, load } = sound("invited", invitedUrl);
    audio.loop = true;
    await load();
    if (stop.signal.aborted) return;
    try {
      await audio.play();
      await stopped;
    } finally {
      audio.pause();
    }
  };
  // Where a browser has no locks, each of its tabs rings.
  const rung = navigator.locks ? navigator.locks.request(RING_LOCK, { signal: stop.signal }, ring) : ring();
  // Stopped before its turn, or refused its sound, it has rung nothing.
  rung.catch(() => {});
  return () => stop.abort();
}
