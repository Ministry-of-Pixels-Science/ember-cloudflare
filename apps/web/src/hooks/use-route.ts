import { useMemo, useSyncExternalStore } from "react";
import {
  EMAIL_SIGN_UP_PATH,
  INVITATION_PATH,
  KIND_SEGMENTS,
  threadPath,
  workspacePageOf,
  type Message,
  type RoomAccess,
  type RoomId,
  type RoomKind,
  type UserId,
  type WorkspacePage,
} from "@ember/protocol";

// The app's few pages, at Campfire's addresses where it has them, which @ember/protocol lists for the
// Worker too: a small typed router over the History API rather than a library. A page with changes to
// lose can hold the app on it by guarding against leaving.

export { BOTS_PATH, CUSTOM_STYLES_PATH, huddlePath, NEW_AGENT_PATH, NEW_APP_PATH, NEW_BOT_PATH, NEW_DIRECT_PATH, PROFILE_PATH, SEARCHES_PATH, threadPath, WORKSPACE_SETTINGS_PATH } from "@ember/protocol";

/** Whether a room's form makes it open to everyone or private, as the form's address says. */
export type Access = RoomAccess;

/** What a signed-in page shows. */
export type Route = WorkspacePage;

export const roomPath = (roomId: RoomId) => `/rooms/${encodeURIComponent(roomId)}`;
/** Someone's page, as Campfire's `user_path` gives it. */
export const personPath = (userId: UserId) => `/users/${encodeURIComponent(userId)}`;
/** A message's permalink, as Campfire's `room_at_message_path` gives it, which opens its room. */
export const messagePath = (roomId: RoomId, messageId: string) => `${roomPath(roomId)}/@${encodeURIComponent(messageId)}`;
/** Where a message's time and Copy link go: its permalink, or a reply's in its thread, which opens the thread at it. */
export const permalinkOf = ({ roomId, id, parentId }: Pick<Message, "roomId" | "id" | "parentId">) =>
  parentId === undefined ? messagePath(roomId, id) : threadPath(roomId, parentId, id);
export const newRoomPath = (access: Access) => `/rooms/${KIND_SEGMENTS[access]}/new`;
/** A room's settings page, at the address for its kind. */
export const roomSettingsPath = (kind: RoomKind, roomId: RoomId) => `/rooms/${KIND_SEGMENTS[kind]}/${encodeURIComponent(roomId)}/edit`;
/** A bot's settings page, as Campfire's `edit_account_bot_path` gives it. */
export const botSettingsPath = (botId: UserId) => `/account/bots/${encodeURIComponent(botId)}/edit`;
/** An agent's settings page, or @ember's. */
export const agentSettingsPath = (agentId: UserId) => `/account/agents/${encodeURIComponent(agentId)}/edit`;
/** A connected app's page. */
export const appSettingsPath = (appId: string) => `/account/apps/${encodeURIComponent(appId)}/edit`;

/**
 * Asked before the app leaves the page shown, with the address it's going to, its path and any query
 * string, or null for leaving the app, as signing out does. It answers true to hold the app on the page, and then calls `proceed` if the
 * person decides to go after all, which for leaving the app settles with whether it left.
 */
export type LeaveGuard = (path: string | null, proceed: () => unknown) => boolean;

let guard: LeaveGuard | null = null;

/** Has `leaveGuard` asked before the app leaves the page shown, until the function returned is called. */
export function guardLeaving(leaveGuard: LeaveGuard): () => void {
  guard = leaveGuard;
  return () => {
    if (guard === leaveGuard) guard = null;
  };
}

/**
 * Leaves the page with `go` once the page's guard lets it, by a way whose address isn't known yet: out
 * of the app, as signing out goes, or to the DM New direct message starts. `go` settles with whether
 * the page was left, since either can fail and leave the page as it was.
 */
export function leave(go: () => Promise<boolean>): void {
  if (!guard?.(null, go)) void go();
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// How many times the app has gone to a page, the page it shows included, as a link to the page Turbo
// shows renders it afresh, so following a permalink again goes to its message again.
let visits = 0;

const notify = () => {
  visits++;
  listeners.forEach((listener) => listener());
};

/**
 * A mark of the page the app shows, which changes whenever the app goes to a page: work that takes a
 * while compares it with the mark from when it began, to tell whether the person has gone elsewhere since.
 */
export const pageMark = () => visits;

/** The number the app gave a history entry, or null for one it didn't number. */
function positionOf(state: unknown): number | null {
  const position = (state as { position?: unknown } | null)?.position;
  return typeof position === "number" ? position : null;
}

/**
 * The address of the page the app opened a history entry from, as a browser keeps the page a link was
 * followed from as the referrer, or null for an entry the app didn't open, such as the first one. It
 * keeps the fragment, which a referrer leaves out, so Go Back returns to the section of community
 * settings it was opened from.
 */
function openedFrom(state: unknown): string | null {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === "string" ? from : null;
}

// Each entry the app adds to this tab's history is numbered one past the entry it follows, so the
// distance Back or Forward went is known, and the guard can go back by it. The browser keeps the numbers
// through a reload.
let position = positionOf(history.state) ?? 0;
history.replaceState({ ...history.state, position }, "");

/** The address the browser shows, but for any fragment: its path and query string, which together name a page. */
const currentAddress = () => location.pathname + location.search;

// While the guard turns Back or Forward around, the address briefly names where the person was going,
// and the app goes on showing the page it was on.
let turningBack = false;
let shown = currentAddress();

/** The address of the page the app shows: its path, and its query string, if it has one. */
function shownAddress(): string {
  if (!turningBack) shown = currentAddress();
  return shown;
}

/** The path of the page the app shows, without its query string, which starts at the first "?". */
const shownPath = () => shownAddress().split("?", 1)[0]!;

/** The query string of the page the app shows, from its "?", or nothing. */
const shownQuery = () => shownAddress().slice(shownPath().length);

// Each page asked for is numbered, so what's to follow the last one asked for runs only if the app goes
// there: not while the page's guard holds it, nor if the person stays or another page is asked for.
let asked = 0;
let gone = 0;
let followUp: (() => void) | null = null;

// The guard's own trips through the history: back to the page it holds, which changes nothing the app
// shows, and on again once the person decides to go.
let returning = false;
let proceeding = false;

window.addEventListener("popstate", (event) => {
  if (returning) {
    returning = false;
    turningBack = false;
    return;
  }
  const next = positionOf(event.state);
  const distance = next === null ? 0 : next - position;
  const proceed = () => {
    proceeding = true;
    history.go(distance);
  };
  if (!proceeding && distance !== 0 && guard?.(currentAddress(), proceed)) {
    turningBack = true;
    returning = true;
    history.go(-distance);
    return;
  }
  proceeding = false;
  if (next !== null) position = next;
  followUp = null;
  notify();
});

/**
 * Shows `path`, which can have a query string and a fragment, as a new entry in the browser's history
 * unless `replace` says to take the current one's place, once the page's guard lets it. A fragment alone
 * changes no page, so going from one of a page's sections to another doesn't ask its guard, as a
 * browser follows a link to a fragment without leaving the page.
 */
export function navigate(path: string, { replace = false } = {}): void {
  const navigation = ++asked;
  followUp = null;
  if (shownAddress() + location.hash === path) {
    gone = navigation;
    notify();
    return;
  }
  const go = () => {
    // A page that takes another's place was opened from where that one was, as a redirect keeps the referrer.
    if (replace) history.replaceState({ position, from: openedFrom(history.state) }, "", path);
    else history.pushState({ position: ++position, from: shownAddress() + location.hash }, "", path);
    gone = navigation;
    if (navigation === asked) {
      followUp?.();
      followUp = null;
    }
    notify();
  };
  if (shownAddress() === path.split("#", 1)[0] || !guard?.(path, go)) go();
}

/**
 * Calls `then` once the app shows the page `navigate` was last asked for: now, if it does already, or
 * when the page's guard lets it go there, but never if the person stays or another page is asked for.
 */
export function afterNavigating(then: () => void): void {
  if (gone === asked) then();
  else followUp = then;
}

/** The room id in a /rooms/:id path, or null. */
export function roomIdFromPath(pathname: string): string | null {
  const route = workspacePageOf(pathname);
  return route?.page === "room" ? route.roomId : null;
}

/**
 * The page a signed-in path shows. The Worker answers 404 for a path that names none, so home stands
 * in only at the join and setup pages, which someone signed in leaves for home, and under Vite's dev
 * server, which serves the app at every path.
 */
export const routeOf = (pathname: string): Route => workspacePageOf(pathname) ?? { page: "home" };

/**
 * Where Go Back goes on a page that returns to the one it was opened from, as Campfire's `link_back`
 * goes to the referrer: that page, or home when it's this one or the app didn't open it.
 */
export function useBackPath(): string {
  const from = useSyncExternalStore(subscribe, () => openedFrom(history.state));
  const here = useSyncExternalStore(subscribe, shownAddress);
  return from !== null && from.split("#", 1)[0] !== here ? from : "/";
}

/** How many times the app has gone to a page, re-rendering each time, even when it's the page shown. */
export function useVisit(): number {
  return useSyncExternalStore(subscribe, pageMark);
}

/** The page the address shows, re-rendering when it changes. */
export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, shownPath);
  return useMemo(() => routeOf(pathname), [pathname]);
}

/** The address's fragment, from its "#", or nothing, re-rendering when it changes. */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => location.hash);
}

/** The query string of the page shown, from its "?", or nothing, re-rendering when it changes. */
export function useQuery(): string {
  return useSyncExternalStore(subscribe, shownQuery);
}

/**
 * The join code in a join link's path, `/join/<code>`, or null. It's the path's own segment, as the
 * Worker matched it before serving the page: codes are letters, digits and dashes, which nothing escapes.
 */
export function joinCodeFromPath(pathname: string): string | null {
  // An invitation's link and Email domain's have pages of their own there, and no join code is ever
  // "invitation" or "email".
  if (pathname === INVITATION_PATH || pathname === EMAIL_SIGN_UP_PATH) return null;
  return pathname.match(/^\/join\/([^/]+)$/)?.[1] ?? null;
}

export function useJoinRoute(): string | null {
  return joinCodeFromPath(useSyncExternalStore(subscribe, shownPath));
}

/** Whether the address is `path`, re-rendering only when that changes. */
export function useIsAt(path: string): boolean {
  return useSyncExternalStore(subscribe, () => shownPath() === path);
}
