import { hasTouchKeyboard } from "./keyboard";

// A phone's screen dims and locks by itself after a while without a touch, and its browser stops a page
// whose screen has locked: the huddle goes quiet for its person, and the room has them leave it. So a
// huddle keeps the screen of a phone or a tablet awake, for as long as its page shows. A computer's is
// left to sleep as it does, which stops nothing there.

/**
 * Keeps the screen awake on a phone or a tablet, from now until the function returned is called. The
 * browser lets the screen go whenever the page is hidden, so it's asked again each time the page shows.
 * A browser that can't keep it awake, or won't, as a phone's may not while it saves its battery, leaves
 * the screen to lock as it does.
 */
export function keepScreenAwake(): () => void {
  const wakeLock = (navigator as Partial<Pick<Navigator, "wakeLock">>).wakeLock;
  if (!wakeLock || !hasTouchKeyboard()) return () => {};
  /** What the browser last handed over for a screen it keeps awake, which says once the browser has let it go. */
  let kept: WakeLockSentinel | null = null;
  let asking = false;
  let over = false;

  const ask = async () => {
    if (asking || (kept && !kept.released) || document.visibilityState !== "visible") return;
    asking = true;
    const got = await wakeLock.request("screen").catch(() => null);
    asking = false;
    // The huddle ended while the browser was asked.
    if (over) return void got?.release();
    kept = got;
  };
  void ask();
  document.addEventListener("visibilitychange", ask);

  return () => {
    over = true;
    document.removeEventListener("visibilitychange", ask);
    void kept?.release();
  };
}
