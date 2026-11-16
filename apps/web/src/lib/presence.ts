import type { UserId, WorkspaceServerFrame } from "@ember/protocol";

/** How long a tab goes unused before it stops counting as in use, as Slack counts someone away after ten minutes. */
export const AWAY_AFTER_MS = 10 * 60 * 1000;

/** What someone does with a tab that shows they're using it, besides showing it. */
const USES = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

/**
 * Watches whether someone is using the tab: it's in use as it starts, and from whenever it's used or
 * shown again, until it has gone `awayAfterMs` without either. `onChange` hears each change.
 */
export function watchUse(onChange: (inUse: boolean) => void, awayAfterMs = AWAY_AFTER_MS): { inUse: () => boolean; stop: () => void } {
  let inUse = true;
  let usedAt = Date.now();
  let timer: ReturnType<typeof setTimeout>;
  // Each use only notes the time, which the timer reads once it's due, so moving the mouse costs nothing.
  const check = () => {
    const unused = Date.now() - usedAt;
    if (unused < awayAfterMs) return void (timer = setTimeout(check, awayAfterMs - unused));
    inUse = false;
    onChange(false);
  };
  const used = () => {
    usedAt = Date.now();
    if (inUse) return;
    inUse = true;
    timer = setTimeout(check, awayAfterMs);
    onChange(true);
  };
  const shown = () => document.visibilityState === "visible" && used();
  timer = setTimeout(check, awayAfterMs);
  for (const type of USES) window.addEventListener(type, used, { capture: true, passive: true });
  window.addEventListener("focus", used);
  document.addEventListener("visibilitychange", shown);
  return {
    inUse: () => inUse,
    stop() {
      clearTimeout(timer);
      for (const type of USES) window.removeEventListener(type, used, { capture: true });
      window.removeEventListener("focus", used);
      document.removeEventListener("visibilitychange", shown);
    },
  };
}

/** A `presence` frame from the workspace socket. */
type PresenceFrame = Extract<WorkspaceServerFrame, { type: "presence" }>;

/**
 * Who's active after `frame`: everyone it says is, when it's the first since the socket connected, which
 * says who's active then, or else `active` with the changes it tells of.
 */
export function activeAfter(active: ReadonlySet<UserId> | null, frame: PresenceFrame, first: boolean): ReadonlySet<UserId> {
  const after = new Set(first || active === null ? [] : active);
  for (const userId of frame.away) after.delete(userId);
  for (const userId of frame.active) after.add(userId);
  return after;
}

/** Who's active in the workspace, as an `activeStore` keeps it. */
export interface ActiveStore {
  /** Everyone active, or null until the workspace socket has said. */
  current(): ReadonlySet<UserId> | null;
  /** Calls `onChange` whenever that changes, until the function it answers is called. */
  watch(onChange: () => void): () => void;
}

/** Nobody's presence, as before a workspace socket has said who's active. */
export const NOT_HEARD: ActiveStore = { current: () => null, watch: () => () => {} };

/**
 * Keeps who's active in the workspace as the workspace socket's `presence` frames say (`activeAfter`),
 * apart from the page's state, so that a change redraws only what shows someone's presence.
 */
export function activeStore(): ActiveStore & { hear(frame: PresenceFrame, first: boolean): void } {
  let active: ReadonlySet<UserId> | null = null;
  const watchers = new Set<() => void>();
  return {
    current: () => active,
    watch(onChange) {
      watchers.add(onChange);
      return () => void watchers.delete(onChange);
    },
    hear(frame, first) {
      active = activeAfter(active, frame, first);
      for (const onChange of watchers) onChange();
    },
  };
}
