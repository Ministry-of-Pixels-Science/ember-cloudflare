/**
 * How long the tab has to stay shown or hidden before the change counts, as Campfire's
 * presence_controller.js waits (`VISIBILITY_CHANGE_DELAY`), so a glance at another tab changes nothing.
 */
export const VISIBILITY_CHANGE_DELAY_MS = 5_000;

/**
 * Has `shown` run each time the tab shows again, having been hidden, as when its person comes back to
 * a phone's browser, until the function returned is called.
 */
export function whenShownAgain(shown: () => void): () => void {
  const changed = () => {
    if (document.visibilityState === "visible") shown();
  };
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
}

export interface SettledVisibility {
  /** Whether the tab counts as shown: as it was when followed, or as it has since stayed for the delay. */
  readonly visible: boolean;
  /** Stops following the tab. */
  stop(): void;
}

/**
 * Follows whether the tab is shown, counting a change once the tab has stayed that way for
 * `VISIBILITY_CHANGE_DELAY_MS`, and tells `onChange` of each change it counts.
 */
export function settledVisibility(onChange: (visible: boolean) => void): SettledVisibility {
  const shown = () => document.visibilityState === "visible";
  let visible = shown();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (shown() === visible) return;
      visible = !visible;
      onChange(visible);
    }, VISIBILITY_CHANGE_DELAY_MS);
  };
  document.addEventListener("visibilitychange", changed);

  return {
    get visible() {
      return visible;
    },
    stop() {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", changed);
    },
  };
}
