import type { RoomId, RoomKind, UserId } from "./index.ts";
import { OUTSIDE_AUTHORIZE_PATH } from "./outside.ts";

// The app's pages, at Campfire's addresses where it has the page. The app's router reads a path with
// `workspacePageOf`, and the Worker serves the app only where `isAppPage` says it shows a page, so any
// other path answers 404 with Campfire's page.

/** The most characters an id can have, as a frame or an address names it. */
export const MAX_ID_LENGTH = 64;

/** Whether a room's form makes it open to everyone or private, as the form's address says. */
export type RoomAccess = Exclude<RoomKind, "direct">;

/** What a signed-in page shows. */
export type WorkspacePage =
  /** `/`: the last room visited, or a page saying there are no rooms yet. */
  | { page: "home" }
  /** `/rooms`: the room made most recently. */
  | { page: "newest-room" }
  /**
   * A room, at `/rooms/<id>`, or at one of its messages' permalinks, `/rooms/<id>/@<message id>`, which
   * opens it around that message, or with a message's thread open beside it, at
   * `/rooms/<id>/threads/<message id>`, or at a reply's permalink, `/rooms/<id>/threads/<message id>/@<reply id>`,
   * which opens the thread at the reply, or at its huddle's link, `/rooms/<id>/huddle`, which offers to
   * start its huddle, or to join the one going on.
   */
  | { page: "room"; roomId: RoomId; messageId?: string; threadId?: string; replyId?: string; huddle?: true }
  /**
   * A message at its own address, `/rooms/<id>/messages/<message id>`, which goes on to its permalink.
   */
  | { page: "message"; roomId: RoomId; messageId?: string }
  /** A room at the address for a kind of room, such as `/rooms/opens/<id>`, which goes on to the room's own. */
  | { page: "room-of-kind"; kind: RoomKind; roomId: RoomId }
  | { page: "new-room"; access: RoomAccess }
  | { page: "room-settings"; access: RoomAccess; roomId: RoomId }
  /** New direct message, at `/rooms/directs/new`, which opens over the last room visited. */
  | { page: "new-direct" }
  /** A DM's settings, at `/rooms/directs/<id>/edit`: its members, and Delete. */
  | { page: "direct-settings"; roomId: RoomId }
  | { page: "workspace-settings" }
  /** The Custom CSS page, which only administrators may open. */
  | { page: "custom-styles" }
  /** The Chat bots page, at `/account/bots`, which only administrators may open, as the next two. */
  | { page: "bots" }
  /** Add a chat bot, at `/account/bots/new`. */
  | { page: "new-bot" }
  /** A bot's settings, at `/account/bots/<id>/edit`. */
  | { page: "bot-settings"; userId: UserId }
  /** New agent, at `/account/agents/new`, which only administrators may open, as the next. */
  | { page: "new-agent" }
  /** An agent's settings, at `/account/agents/<id>/edit`, or @ember's, at its id's. */
  | { page: "agent-settings"; agentId: UserId }
  /** Connect an app, at `/account/apps/new`, which only administrators may open, as the next. */
  | { page: "new-app" }
  /** A connected app's page, at `/account/apps/<id>/edit`. */
  | { page: "app-settings"; appId: string }
  /** Where an app's authorization server sends an administrator back, at `/account/apps/signed-in`, which finishes the sign-in and goes on to the app's page. */
  | { page: "app-signed-in" }
  /** Your profile, at `/users/me/profile`, or at any other person's id in its place. */
  | { page: "profile" }
  /**
   * Your browsers' push subscriptions, at `/users/me/push_subscriptions`, or at any other person's id in
   * its place, where you can send each a test push. Nothing links to it.
   */
  | { page: "push-subscriptions" }
  /** Someone's page, at `/users/<id>`, whatever their status. */
  | { page: "person"; userId: UserId }
  /** Search, at `/searches`, whose query string holds what's searched for. */
  | { page: "search" };

/** Rails' names for each kind of room's controller. */
export const KIND_SEGMENTS = { open: "opens", closed: "closeds", direct: "directs" } as const satisfies Record<RoomKind, string>;

const SIGN_IN_PATH = "/session/new";
export const WORKSPACE_SETTINGS_PATH = "/account/edit";
export const CUSTOM_STYLES_PATH = "/account/custom_styles/edit";
export const BOTS_PATH = "/account/bots";
export const NEW_BOT_PATH = "/account/bots/new";
export const NEW_AGENT_PATH = "/account/agents/new";
export const NEW_APP_PATH = "/account/apps/new";
/** Where an app's authorization server sends an administrator's browser back, once they've signed in there. */
export const APP_SIGNED_IN_PATH = "/account/apps/signed-in";
export const NEW_DIRECT_PATH = "/rooms/directs/new";
export const PROFILE_PATH = "/users/me/profile";
export const PUSH_SUBSCRIPTIONS_PATH = "/users/me/push_subscriptions";
export const SEARCHES_PATH = "/searches";

/**
 * A message's thread, which opens beside its room, or a reply's permalink there, which opens the thread at
 * the reply.
 */
export const threadPath = (roomId: RoomId, parentId: string, replyId?: string) =>
  `/rooms/${encodeURIComponent(roomId)}/threads/${encodeURIComponent(parentId)}` + (replyId === undefined ? "" : `/@${encodeURIComponent(replyId)}`);

/** A room's huddle's link, as Copy huddle link gives it, which opens the room and offers to join its huddle. */
export const huddlePath = (roomId: RoomId) => `/rooms/${encodeURIComponent(roomId)}/huddle`;

/** A path segment as text, or null for a malformed escape, which names nothing. */
function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

const accessOf = (segment: string): RoomAccess => (segment === KIND_SEGMENTS.open ? "open" : "closed");

const kindOf = (segment: string): RoomKind => (segment === KIND_SEGMENTS.direct ? "direct" : accessOf(segment));

/** The page a signed-in path shows, or null for a path that names none. */
export function workspacePageOf(pathname: string): WorkspacePage | null {
  if (pathname === "/") return { page: "home" };
  if (pathname === NEW_DIRECT_PATH) return { page: "new-direct" };
  if (pathname === WORKSPACE_SETTINGS_PATH) return { page: "workspace-settings" };
  if (pathname === CUSTOM_STYLES_PATH) return { page: "custom-styles" };
  if (pathname === BOTS_PATH) return { page: "bots" };
  if (pathname === NEW_BOT_PATH) return { page: "new-bot" };
  const bot = pathname.match(/^\/account\/bots\/([^/]+)\/edit$/);
  const botId = bot && decoded(bot[1]!);
  if (botId) return { page: "bot-settings", userId: botId };
  if (pathname === NEW_AGENT_PATH) return { page: "new-agent" };
  const agent = pathname.match(/^\/account\/agents\/([^/]+)\/edit$/);
  const agentId = agent && decoded(agent[1]!);
  if (agentId) return { page: "agent-settings", agentId };
  if (pathname === NEW_APP_PATH) return { page: "new-app" };
  if (pathname === APP_SIGNED_IN_PATH) return { page: "app-signed-in" };
  const app = pathname.match(/^\/account\/apps\/([^/]+)\/edit$/);
  const appId = app && decoded(app[1]!);
  if (appId) return { page: "app-settings", appId };
  if (pathname === SEARCHES_PATH) return { page: "search" };
  if (/^\/users\/[^/]+\/profile$/.test(pathname)) return { page: "profile" };
  if (/^\/users\/[^/]+\/push_subscriptions$/.test(pathname)) return { page: "push-subscriptions" };
  const person = pathname.match(/^\/users\/([^/]+)$/);
  const personId = person && decoded(person[1]!);
  if (personId) return { page: "person", userId: personId };
  if (pathname === "/rooms") return { page: "newest-room" };
  const newRoom = pathname.match(/^\/rooms\/(opens|closeds)\/new$/);
  if (newRoom) return { page: "new-room", access: accessOf(newRoom[1]!) };
  const settings = pathname.match(/^\/rooms\/(opens|closeds)\/([^/]+)\/edit$/);
  const settingsRoomId = settings && decoded(settings[2]!);
  if (settingsRoomId) return { page: "room-settings", access: accessOf(settings[1]!), roomId: settingsRoomId };
  const directSettings = pathname.match(/^\/rooms\/directs\/([^/]+)\/edit$/);
  const directSettingsRoomId = directSettings && decoded(directSettings[1]!);
  if (directSettingsRoomId) return { page: "direct-settings", roomId: directSettingsRoomId };
  const thread = pathname.match(/^\/rooms\/([^/]+)\/threads\/([^/]+)(?:\/@([^/]+))?$/);
  if (thread) return threadPageOf(thread[1]!, thread[2]!, thread[3]);
  const huddle = pathname.match(/^\/rooms\/([^/]+)\/huddle$/);
  if (huddle) return huddlePageOf(huddle[1]!);
  const ofKind = pathname.match(/^\/rooms\/(opens|closeds|directs)\/([^/]+)$/);
  const ofKindRoomId = ofKind && decoded(ofKind[2]!);
  if (ofKindRoomId) return { page: "room-of-kind", kind: kindOf(ofKind[1]!), roomId: ofKindRoomId };
  // /rooms/new, one of Rails' unused resource actions, answers 404 rather than naming a room.
  const room = pathname.match(/^\/rooms\/([^/]+)(?:\/@([^/]+)|\/messages\/([^/]+))?$/);
  const roomId = room && room[1] !== "new" ? decoded(room[1]!) : null;
  if (!room || !roomId) return null;
  const page = room[3] === undefined ? "room" : "message";
  // A permalink or message address whose message id is malformed, or longer than any message's, opens
  // the room at its newest messages, as one naming a message the room doesn't have does.
  const messageId = decoded(room[2] ?? room[3] ?? "");
  return messageId && messageId.length <= MAX_ID_LENGTH ? { page, roomId, messageId } : { page, roomId };
}

/**
 * A thread's page, from its address's segments: its room, with the thread open, and at the reply the third
 * names. A thread or reply whose id is malformed, or longer than any message's, is left out, as a
 * permalink's message is, so the room opens without the thread, or the thread at its newest replies.
 */
function threadPageOf(roomSegment: string, threadSegment: string, replySegment: string | undefined): WorkspacePage | null {
  const roomId = roomSegment === "new" ? null : decoded(roomSegment);
  if (!roomId) return null;
  const isMessageId = (id: string | null): id is string => id !== null && id !== "" && id.length <= MAX_ID_LENGTH;
  const threadId = decoded(threadSegment);
  if (!isMessageId(threadId)) return { page: "room", roomId };
  const replyId = replySegment === undefined ? null : decoded(replySegment);
  return isMessageId(replyId) ? { page: "room", roomId, threadId, replyId } : { page: "room", roomId, threadId };
}

/** A room's page at its huddle's link, from the address's room segment. */
function huddlePageOf(roomSegment: string): WorkspacePage | null {
  const roomId = roomSegment === "new" ? null : decoded(roomSegment);
  return roomId ? { page: "room", roomId, huddle: true } : null;
}

/**
 * Whether the app shows a page at `pathname`: sign-in, the page that asks whether to connect an AI
 * app, or one of the workspace's. The Worker answers setup's, the join link's and open sign-up's
 * addresses itself.
 */
export const isAppPage = (pathname: string) => pathname === SIGN_IN_PATH || pathname === OUTSIDE_AUTHORIZE_PATH || workspacePageOf(pathname) !== null;

/**
 * What the Worker has the browser fetch with a workspace page, for a browser with a session cookie,
 * beside who's signed in: the sidebar and the people directory, which the app's first requests for
 * them take.
 */
export const WORKSPACE_PRELOADS = ["/api/sidebar", "/api/users"] as const;

/** The page a sign-in link opens, which signs whoever opens it in as the person the link was made for, until it expires. */
export const TRANSFER_PATH = "/session/transfers";

/** Where anyone may create an account while an administrator lets them (`Account.openSignUp`), which the Worker answers itself. */
export const SIGN_UP_PATH = "/join";

/** The page an invitation's link opens, to join with the address it was sent to, which the Worker answers itself. */
export const INVITATION_PATH = "/join/invitation";

/**
 * An invitation's link: its page, with the link's secret as the fragment's `token`, as a sign-in link
 * keeps its id, so no request, Referer or log holds it. Secrets are base64url, which nothing escapes.
 */
export const invitationLink = (token: string) => `${INVITATION_PATH}#token=${token}`;

/**
 * The page where someone with an email address at the workspace's email domains asks for a link to join
 * with it, which the link opens too, and which the Worker answers itself.
 */
export const EMAIL_SIGN_UP_PATH = "/join/email";

/** A link someone asked for to join with their email address: its page, with the link's secret as the fragment's `token`, as an invitation's link keeps it. */
export const emailSignUpLink = (token: string) => `${EMAIL_SIGN_UP_PATH}#token=${token}`;

/**
 * The page where someone who forgot their password asks Ember to email them a code, then gives the code
 * with a new password, at the address Rails' authentication generator gives its own, and which the
 * Worker answers itself.
 */
export const PASSWORD_RESET_PATH = "/passwords/new";

/**
 * The page Set up Turnstile draws a widget's check in, in a frame of its own: the Worker answers it
 * itself, with a policy that lets Turnstile's script load there, where the app's pages let it load only
 * where people sign up or ask Ember to email them. The fragment names the site key.
 */
export const TURNSTILE_CHECK_PATH = "/account/turnstile_check";

/**
 * `path`, the sign-in page's or the Reset your password page's, with `emailAddress` filled in, as each
 * reads it from `?email_address=`, or just `path` without one.
 */
export const withEmailAddress = (path: string, emailAddress: string) => (emailAddress ? `${path}?email_address=${encodeURIComponent(emailAddress)}` : path);

/**
 * A sign-in link's address: its page, with the link's id as the fragment's `token`. Browsers never send
 * a fragment, so no request holds the id, nor any log of one, as the setup link keeps its token. Ids are
 * letters, digits, dots, dashes and underscores, which nothing escapes.
 */
export const transferLink = (transferId: string) => `${TRANSFER_PATH}#token=${transferId}`;
