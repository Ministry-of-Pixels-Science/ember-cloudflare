import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useReducer, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ASSISTANT_ID, searchOfQuery, startingInvolvement, type Account, type DirectRoom, type Favorites, type Me, type Room, type RoomId, type SidebarRoom, type User } from "@ember/protocol";
import { CAMERAS_OFF, SCREENS_OFF } from "@ember/protocol/huddles";
import { useFlash } from "@/components/flash";
import { Xmark } from "@/components/icons/iconoir";
import { MainContent, SkipLink } from "@/components/main-content";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useAccount, useCamerasAllowed, useScreensAllowed } from "@/hooks/use-account";
import { useAppBadge } from "@/hooks/use-app-badge";
import { DirectoryLoaded, PeopleContext, useDirectory } from "@/hooks/use-directory";
import { useHuddle } from "@/hooks/use-huddle";
import { useMounted } from "@/hooks/use-mounted";
import { useReleaseCheck } from "@/hooks/use-release-check";
import { useSidebar } from "@/hooks/use-sidebar";
import { agentsToAsk } from "@/lib/agents";
import { answerHuddleInvitation, ApiError, dismissInvitation, isSignedOut, startDirect } from "@/lib/api";
import { invitationsReducer, NO_INVITATIONS } from "@/lib/huddle-invitations";
import { hasHuddles } from "@/lib/huddle-people";
import { hearHuddle, leaveHuddle, muteHuddle, OPEN_HUDDLE, openHuddle, shareHuddleScreen, showHuddleCamera } from "@/lib/huddle-store";
import { whenIdle } from "@/lib/idle";
import { opensFind, opensShortcuts, togglesHuddle, togglesMute } from "@/lib/keyboard";
import { lastRoomVisited } from "@/lib/last-room";
import { takeMemberfulFlash } from "@/lib/memberful";
import { loadPage } from "@/lib/page";
import { updateOf } from "@/lib/release-check";
import { markedUnread } from "@/lib/room-list";
import { cn } from "@/lib/utils";
import { afterNavigating, messagePath, navigate, pageMark, roomPath, routeOf, useHash, useRoute, useVisit, type Route } from "@/hooks/use-route";
import { HuddlesContext, joinsNoHuddle, NO_HUDDLES, type Huddles } from "./huddle-button";
import { MovedNotice } from "./moved-notice";
import { KeyboardShortcutsDialog } from "./keyboard-shortcuts-dialog";
import { NewDirectDialog, startedWithout } from "./new-direct-dialog";
import { Notices } from "./notices";
import { DrawerOpen, PageHeader } from "./page-header";
import { Rail, type RailPage } from "./rail";
import { RoomView, type RoomViewHandle } from "./room-view";
import { OpenSearchContext, SearchBox, type SearchBoxOptions } from "./search-box";
import { SettingsLayout, settingsSectionOf, type SettingsPlace } from "./settings-navigation";
import { Sidebar } from "./sidebar";
import { UpdatedNotice } from "./updated-notice";
import { WelcomePage } from "./welcome-page";

type RarePages = typeof import("./pages");

let rarePages: RarePages | undefined;
let loadingRarePages: Promise<RarePages> | undefined;

/** The pages few visits need (pages.ts), which load together, apart from the rest of the app. */
function loadRarePages(): Promise<RarePages> {
  loadingRarePages ??= import("./pages").then(
    (pages) => (rarePages = pages),
    (error: unknown) => {
      // The next page that needs them tries again.
      loadingRarePages = undefined;
      throw error;
    },
  );
  return loadingRarePages;
}

/** What an address shows when it's one of the pages few visits need. */
const RARE_PAGES = new Set<Route["page"]>([
  "new-room",
  "room-settings",
  "direct-settings",
  "workspace-settings",
  "custom-styles",
  "bots",
  "new-bot",
  "bot-settings",
  "new-agent",
  "agent-settings",
  "new-app",
  "app-settings",
  "app-signed-in",
  "profile",
  "push-subscriptions",
  "person",
  "search",
]);

/**
 * Starts loading the page at `pathname` when few visits need it, so that it's there by the time the workspace
 * shows, and returns what settles once it's loaded or failed to.
 */
export function loadPageAhead(pathname: string): Promise<unknown> {
  return RARE_PAGES.has(routeOf(pathname).page) ? loadRarePages().catch(() => {}) : Promise.resolve();
}

/**
 * What the rail marks on each page: the logo and Home at home, Home on a room's page and the pages that
 * go on to one, Search on search, Admin or Workspace on every page of community settings (a room's
 * forms, the bot and agent pages and the Custom CSS page among them), your avatar on your profile, and nothing on
 * a DM's settings or your push subscriptions, whose addresses none of its links have, nor on New direct
 * message's, which goes on to the last room visited at once.
 */
const RAIL_PAGES = {
  home: "home",
  "newest-room": "room",
  room: "room",
  message: "room",
  "room-of-kind": "room",
  "new-room": "workspace",
  "room-settings": "workspace",
  "new-direct": null,
  "direct-settings": null,
  "workspace-settings": "workspace",
  "custom-styles": "workspace",
  bots: "workspace",
  "new-bot": "workspace",
  "bot-settings": "workspace",
  "new-agent": "workspace",
  "agent-settings": "workspace",
  "new-app": "workspace",
  "app-settings": "workspace",
  "app-signed-in": "workspace",
  profile: "profile",
  "push-subscriptions": null,
  person: null,
  search: "search",
} as const satisfies Record<Route["page"], RailPage>;

/** Loads the page shown again, for the Worker to answer it with Campfire's 404 page, as it does for someone nobody is. */
const showNotFound = () => loadPage(location.pathname);

/** An address the app goes on from, to `path`, with an alert to show there. */
interface Redirect {
  path: string;
  alert?: string;
}

/** The rooms, stars and shared order of someone whose rooms haven't loaded yet. */
const NO_ROOMS: SidebarRoom[] = [];
const NO_FAVORITES: Favorites = { rooms: [], version: 0 };
const NO_ORDER: RoomId[] = [];

/** What the page shows while its rooms, or the page itself, load. */
const LOADING = (
  <MainContent className="col-start-3 row-span-2 flex items-center justify-center bg-background text-muted-foreground max-md:col-start-1">Loading…</MainContent>
);

/** And a page of community settings, under the header and beside the links to their sections, which stay. */
const SETTINGS_LOADING = (
  <>
    <PageHeader />
    <MainContent className="flex items-center justify-center bg-background text-muted-foreground">Loading…</MainContent>
  </>
);

interface RarePageProps {
  show: (pages: RarePages) => ReactNode;
  loading: ReactNode;
  onFailed: (error: unknown) => void;
}

/**
 * What `show` makes of the pages few visits need, once they've loaded, and `loading` until then. They aren't
 * `lazy` components, each of which shows its fallback the first time it shows, however long ago its code
 * loaded, and React then keeps showing that for 300 ms.
 */
function RarePage({ show, loading, onFailed }: RarePageProps) {
  const [pages, setPages] = useState(rarePages);
  useEffect(() => {
    if (pages) return;
    let current = true;
    loadRarePages().then(
      (loaded) => current && setPages(loaded),
      (error: unknown) => current && onFailed(error),
    );
    return () => {
      current = false;
    };
  }, [pages, onFailed]);
  return pages ? show(pages) : loading;
}

/** Where someone goes from a room they can't see. */
const ROOM_NOT_FOUND: Redirect = { path: "/", alert: "Room not found or inaccessible" };

/** What an alert says about a request that failed: the server's reason, or that Ember couldn't be reached. */
const reasonFor = (error: unknown) => (error instanceof ApiError ? error.message : "Couldn't reach Ember. Check your connection and try again.");

/**
 * The room an address names that has to be one of someone's rooms, which a direct message's address
 * doesn't, since the room's own address it goes on to checks.
 */
function namedRoomId(route: Route): RoomId | null {
  if (route.page === "room-of-kind") return route.kind !== "direct" ? route.roomId : null;
  return route.page === "room" || route.page === "room-settings" || route.page === "direct-settings" ? route.roomId : null;
}

/** The DM `roomId` names among `rooms`, or null when it isn't one of them. */
function directIn(rooms: Room[], roomId: RoomId): DirectRoom | null {
  const room = rooms.find((r) => r.id === roomId);
  return room?.kind === "direct" ? room : null;
}

/**
 * Where an address goes on to once someone's rooms are known, or null when it shows a page of its own:
 * home to the last room visited, `/rooms` to the room they were put in latest, a room's address for its
 * kind to the room's own, and a DM's settings home, unless it's theirs. New direct message's goes home
 * too, under the dialog it opens, and a message's own address goes on to its permalink.
 */
function redirectOf(route: Route, rooms: SidebarRoom[]): Redirect | null {
  switch (route.page) {
    case "home": {
      const room = lastRoomVisited(rooms);
      return room && { path: roomPath(room.id) };
    }
    case "newest-room":
      // With no room to go to, home says there are none.
      return { path: rooms.length > 0 ? roomPath(rooms.at(-1)!.id) : "/" };
    case "room-of-kind": {
      // A direct message's goes on without looking, and the room's own address checks it.
      if (route.kind === "direct") return { path: roomPath(route.roomId) };
      const room = rooms.find((r) => r.id === route.roomId);
      return room && room.kind !== "direct" ? { path: roomPath(room.id) } : ROOM_NOT_FOUND;
    }
    case "room":
      return rooms.some((r) => r.id === route.roomId) ? null : ROOM_NOT_FOUND;
    case "message":
      // Without looking, as the permalink checks the room.
      return { path: route.messageId ? messagePath(route.roomId, route.messageId) : roomPath(route.roomId) };
    case "direct-settings":
      return directIn(rooms, route.roomId) ? null : ROOM_NOT_FOUND;
    case "new-direct":
      return { path: "/" };
    default:
      return null;
  }
}

/**
 * The drawer layout: `max-md`, 900px wide and below, where the rail and sidebar move into a drawer
 * opened from the header, or on a page of community settings, the rail alone.
 */
const DRAWER_LAYOUT = "(width < 56.3125rem)";

/** The signed-in layout: rail | sidebar | header over main, or the drawer layout. */
interface Props {
  me: Me;
  /** The workspace's name, which titles the rail's logo and heads the sidebar. */
  workspaceName: string;
  /**
   * Called with the workspace as the workspace socket last said it is, or as its settings last loaded or
   * saved it, when the socket has said nothing since they were asked for.
   */
  onAccountChanged: (account: Account) => void;
  /** Signs out, settling with whether it did. */
  onSignOut: () => Promise<boolean>;
  /**
   * Called when this browser's session stops signing in `me`: with null once it has expired, or with
   * whoever another tab signed in as.
   */
  onSessionChanged: (me: Me | null) => void;
}

export function Workspace({ me, workspaceName, onAccountChanged, onSignOut, onSessionChanged }: Props) {
  // How many times the workspace socket has said what the account is. A page's answer from the server
  // shows only if no more has been said since it was asked for, since it may have been read before.
  const accountsHeard = useRef(0);
  const accountHeard = useCallback(
    (account: Account) => {
      accountsHeard.current++;
      onAccountChanged(account);
    },
    [onAccountChanged],
  );
  const askForAccount = useCallback(() => {
    const heard = accountsHeard.current;
    return (account: Account) => {
      if (accountsHeard.current === heard) onAccountChanged(account);
    };
  }, [onAccountChanged]);
  // The people directory loads again whenever the sidebar does by itself, and follows whoever the
  // workspace socket says has changed.
  const directory = useDirectory();
  // The invitations into huddles that ring in this tab, as the workspace socket brings them and says they're answered.
  const [invitations, changeInvitations] = useReducer(invitationsReducer, NO_INVITATIONS);
  const { list, answered, change: changeRooms, refresh, askForRoom } = useSidebar(me, onSessionChanged, directory, accountHeard, shownRoomGone, changeInvitations);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // New direct message, while it's open, with the link that opened it, which gets focus back, or null
  // when its address did.
  const [newDirect, setNewDirect] = useState<{ opener: HTMLElement | null } | null>(null);
  // Activity's filter, which lives as long as the page: other pages keep it on, and loading the page
  // again starts with it off.
  const [unreadOnly, setUnreadOnly] = useState(false);
  const closeDrawerButton = useRef<HTMLButtonElement>(null);
  const drawerRail = useRef<HTMLDivElement>(null);
  const roomView = useRef<RoomViewHandle>(null);
  const route = useRoute();
  const hash = useHash();
  // On a page of community settings, the links to their sections take the conversations' place.
  const section = settingsSectionOf(route, hash);
  const administrator = me.administrator;
  const settings = useMemo<SettingsPlace | null>(() => section && { section, administrator }, [section, administrator]);

  const rooms = list?.rooms ?? null;
  const invitation = list?.invitation ?? null;
  const favorites = list?.favorites ?? NO_FAVORITES;
  const sharedOrder = list?.sharedOrder ?? NO_ORDER;
  const starred = useMemo(() => new Set(favorites.rooms), [favorites]);

  // Crossing 900px, as a big phone does on its side, closes the drawer.
  // The wider layout has no drawer, and one left open would be hidden but still dim the page.
  useEffect(() => {
    const drawerLayout = matchMedia(DRAWER_LAYOUT);
    const close = () => setDrawerOpen(false);
    drawerLayout.addEventListener("change", close);
    return () => drawerLayout.removeEventListener("change", close);
  }, []);

  // Another page starts with the drawer closed, but the one Activity goes to from the drawer on a page
  // of community settings, which keeps it open on the conversations it filters.
  const keepDrawer = useRef(false);
  useEffect(() => {
    if (!keepDrawer.current) setDrawerOpen(false);
  }, [route]);

  // The pages few visits need load once the rooms have, while the browser is idle, so that going to one
  // doesn't wait for them. If they fail to, the first page that needs them tries again.
  const listed = rooms !== null;
  useEffect(() => (listed ? whenIdle(() => void loadRarePages().catch(() => {})) : undefined), [listed]);
  // And for an administrator, whether a newer release of Ember is out, or for a beta the beta after it,
  // which the rail's Admin marks, asked afresh each time Admin opens, and by General's Check for updates.
  const { check: release, checkAgain: checkForUpdates } = useReleaseCheck(administrator, listed, settings !== null);
  const newRelease = (release && updateOf(release)?.release) ?? null;

  // On a phone, the drawer closes as New direct message opens.
  const openNewDirect = (opener: HTMLElement | null) => {
    setDrawerOpen(false);
    setNewDirect({ opener });
  };
  useLayoutEffect(() => {
    if (route.page === "new-direct") openNewDirect(null);
  }, [route]);

  // Available Agents, while it's open, with the sidebar's row that opened it, which gets focus back, and
  // how many of them the row says there are, once the people directory lists everyone. On a phone, the
  // drawer closes as it opens.
  const [agentsList, setAgentsList] = useState<{ opener: HTMLElement } | null>(null);
  const openAgents = (opener: HTMLElement) => {
    setDrawerOpen(false);
    setAgentsList({ opener });
  };
  const agents = useMemo(() => (directory.loaded ? agentsToAsk(directory.people.values(), me) : 0), [directory.loaded, directory.people, me]);

  // The search box, while it's open, with what it opened with. On a phone, the drawer closes as it opens.
  const [searchBox, setSearchBox] = useState<SearchBoxOptions | null>(null);
  const openSearch = useCallback((options: SearchBoxOptions) => {
    setDrawerOpen(false);
    setSearchBox(options);
  }, []);

  // The huddle this tab is in, and the preview one is started or joined from, while it's open, by its room.
  const huddle = useHuddle();
  const huddleRoom = (huddle && rooms?.find((r) => r.id === huddle.roomId)) ?? null;
  const huddlesOn = useAccount().huddles;
  const camerasAllowed = useCamerasAllowed();
  const screensAllowed = useScreensAllowed();
  const [huddlePreview, setHuddlePreview] = useState<RoomId | null>(null);
  // Whether the keyboard shortcuts dialog is open.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const closeHuddlePreview = useCallback(() => setHuddlePreview(null), []);
  const liveHuddles = list?.huddles ?? NO_HUDDLES;
  const huddles = useMemo<Huddles>(() => ({ live: liveHuddles, preview: setHuddlePreview }), [liveHuddles]);
  // Whether a room has huddles, once they're on: any shared room, and a direct message with someone to huddle with.
  const offersHuddle = (r: Room) => huddlesOn && hasHuddles(r, me.id, (user) => joinsNoHuddle(user, directory.people.get(user.id)));
  // Only a room that's still this person's, and only while it has huddles, has a preview to show.
  const previewedRoom = huddlePreview !== null ? rooms?.find((r) => r.id === huddlePreview) : undefined;
  const previewed = previewedRoom && offersHuddle(previewedRoom) ? previewedRoom : undefined;
  useEffect(() => {
    if (huddlePreview !== null && rooms !== null && !previewed) setHuddlePreview(null);
  }, [huddlePreview, rooms, previewed]);
  // An invitation rings until this tab sees it has no more reason to: huddles are off, its room is no
  // longer this person's, they're in its huddle, here or elsewhere, or the huddle is over.
  const roomIds = useMemo(() => (rooms ? new Set(rooms.map(({ id }) => id)) : null), [rooms]);
  const joinedRoomId = huddle?.roomId ?? null;
  useEffect(() => {
    changeInvitations({ type: "seen", on: huddlesOn, meId: me.id, roomIds, live: liveHuddles, joinedRoomId });
  }, [invitations, huddlesOn, me.id, roomIds, liveHuddles, joinedRoomId]);
  // Someone in a huddle already, in this tab or anywhere else, is shown an invitation without its ring.
  const inAHuddle = huddle !== null || Object.values(liveHuddles).some(({ userIds }) => userIds.includes(me.id));

  const flash = useFlash();
  const mounted = useMounted();
  // What this tab's huddle has to say: why the room ended it, or why its camera stays off or its screen
  // isn't shared. Whoever's signed in next starts in none.
  useEffect(() => hearHuddle((what) => flash("alert", what)), [flash]);
  useEffect(() => leaveHuddle, []);
  // An administrator who turns cameras off takes down the one this tab shows, and its person is told
  // why, and so with the screen it shares once screen sharing is off. The room takes down whichever
  // are on still at its next check.
  const showsCameraUnallowed = !camerasAllowed && huddle?.camera != null;
  useEffect(() => {
    if (!showsCameraUnallowed) return;
    showHuddleCamera(false);
    flash("alert", CAMERAS_OFF);
  }, [showsCameraUnallowed, flash]);
  const sharesScreenUnallowed = !screensAllowed && huddle?.screen != null;
  useEffect(() => {
    if (!sharesScreenUnallowed) return;
    shareHuddleScreen(false);
    flash("alert", SCREENS_OFF);
  }, [sharesScreenUnallowed, flash]);
  // The huddle opened covers the page, so going to a page, the one shown included, minimizes it to its
  // bar: all but the visit its own link ends in, which opens it.
  const visit = useVisit();
  const opensHuddle = useRef(-1);
  useEffect(() => {
    openHuddle(opensHuddle.current === visit);
  }, [visit]);
  // What connecting a Memberful account came to, as the address Memberful sent this browser back to says.
  useEffect(() => {
    const message = takeMemberfulFlash();
    if (message) flash(message.kind, message.text);
  }, [flash]);
  // A session that's ended goes to sign in; anything else is an alert. Once another person's workspace
  // has taken this one's place, as another tab signing in makes it, what this one's pages hear is
  // about a session already replaced.
  const failed = useCallback(
    (error: unknown) => {
      if (!mounted.current) return;
      if (isSignedOut(error)) return onSessionChanged(null);
      flash("alert", reasonFor(error));
    },
    [flash, onSessionChanged, mounted],
  );
  const redirect = useCallback(
    ({ path, alert }: Redirect) => {
      navigate(path, { replace: true });
      if (alert) flash("alert", alert);
    },
    [flash],
  );
  const missing = useCallback(() => redirect(ROOM_NOT_FOUND), [redirect]);
  const huddlePreviewFailed = useCallback(
    (error: unknown) => {
      setHuddlePreview(null);
      failed(error);
    },
    [failed],
  );
  const invitationOver = useCallback((roomId: RoomId) => changeInvitations({ type: "over", roomId }), []);
  // An invitation answered stops ringing here at once, and in this person's other tabs once the Workspace
  // has heard, where one it never hears of rings on until it gives up.
  const answerInvitation = useCallback(
    (roomId: RoomId) => {
      invitationOver(roomId);
      answerHuddleInvitation(roomId).catch((error: unknown) => isSignedOut(error) && failed(error));
    },
    [invitationOver, failed],
  );
  // Joining goes by the huddle's preview, as it does from the room, so a click on an invitation that
  // has just come opens no microphone. A room the list doesn't have, as one made while this tab wasn't
  // connected, has its preview once the list asked for again has come.
  const joinInvited = useCallback(
    (roomId: RoomId) => {
      answerInvitation(roomId);
      if (roomIds?.has(roomId) ?? true) return setHuddlePreview(roomId);
      refresh().then(() => mounted.current && setHuddlePreview(roomId), failed);
    },
    [answerInvitation, roomIds, refresh, failed, mounted],
  );
  const agentsListFailed = useCallback(
    (error: unknown) => {
      setAgentsList(null);
      failed(error);
    },
    [failed],
  );
  // A room just saved takes its place in the list, and one that's gone leaves it.
  const listRoom = useCallback((room: Room) => changeRooms({ type: "saved", room }), []);
  const unlistRoom = useCallback((roomId: RoomId) => changeRooms({ type: "gone", roomId }), []);
  // And the welcome card shows the join link as workspace settings last loaded or regenerated it.
  const joinCodeChanged = useCallback((joinCode: string) => changeRooms({ type: "join code", joinCode }), []);
  // Its × takes it away once the server has saved that, here, and in this person's other tabs as the
  // workspace socket tells them. One the server didn't save leaves it, saying why.
  const dismissCard = useCallback(async () => {
    try {
      await dismissInvitation();
      changeRooms({ type: "invitation dismissed" });
    } catch (error) {
      failed(error);
    }
  }, [failed]);
  const starredRooms = useCallback((favorites: Favorites) => changeRooms({ type: "starred", favorites }), []);
  // A save's answer can come after a newer order has loaded, so the rooms load again once it's taken.
  const reorderedRooms = useCallback(
    (sharedOrder: RoomId[]) => {
      changeRooms({ type: "reordered", sharedOrder });
      void refresh().catch((error) => mounted.current && isSignedOut(error) && onSessionChanged(null));
    },
    [refresh, onSessionChanged, mounted],
  );

  // A room found gone while it's shown stays on screen to say so until another page shows, whether its
  // own socket finds it gone or the workspace socket, which can hear first, says so. A DM's settings
  // stay too, which go home once their own deletion answers, as the workspace socket can tell of it first.
  const [gone, setGone] = useState<{ room: Room; route: Route } | null>(null);
  const roomGone = (room: Room) => {
    setGone({ room, route });
    unlistRoom(room.id);
  };
  const goneRoom = gone?.route === route ? gone.room : null;
  // A room shown as gone that's listed again, as when someone is put back in it, shows as it is on a page
  // started afresh, since its own socket may have stopped. `returns` counts the rooms that came back so.
  const [returns, setReturns] = useState(0);
  const listedAgain = goneRoom !== null && rooms !== null && rooms.some((r) => r.id === goneRoom.id);
  useLayoutEffect(() => {
    if (!listedAgain) return;
    setGone(null);
    setReturns((returns) => returns + 1);
  }, [listedAgain]);

  // A room the list doesn't have may be one made, or opened to this person, since it came: the list is
  // asked for again, once each time an address naming it is visited, before a room's address counts as
  // naming a room they can't see, and so its settings, once saved, leave it where it was made rather
  // than last, as a room just made goes. The sidebar has one list on its way at a time, so an older one
  // can't take the place of a newer one, which has changes made here since, and this waits for one asked
  // for after the address was visited.
  const [askedAgain, setAskedAgain] = useState<{ route: Route; answered: boolean } | null>(null);
  // A room's address the list couldn't be asked for again for, which stays rather than going home as if
  // the room weren't theirs, and says why in the page, until it's left or Try again asks again.
  const [unanswered, setUnanswered] = useState<{ route: Route; reason: string } | null>(null);
  const namedId = namedRoomId(route);
  const unlisted = rooms !== null && !goneRoom && namedId !== null && !rooms.some((r) => r.id === namedId);
  const askAgain = unlisted && askedAgain?.route !== route;
  const askingAgain = askAgain || (askedAgain?.route === route && !askedAgain.answered);
  useEffect(() => {
    if (!askAgain) return;
    setAskedAgain({ route, answered: false });
    const answered = () => setAskedAgain((asked) => (asked?.route === route ? { route, answered: true } : asked));
    refresh().then(answered, (error) => {
      // As with `failed`, a session already replaced hears nothing.
      if (!mounted.current) return;
      if (isSignedOut(error)) return onSessionChanged(null);
      answered();
      // A room's settings ask the server about the room themselves.
      if (route.page !== "room-settings") setUnanswered({ route, reason: reasonFor(error) });
    });
  }, [askAgain, route, refresh, onSessionChanged, mounted]);
  const tryAgain = () => {
    setUnanswered(null);
    setAskedAgain(null);
  };
  const unansweredHere = unanswered?.route === route ? unanswered : null;

  // Where the address goes on to, once the list it goes by has come.
  const goingOn = useMemo(
    () => (rooms && !askingAgain && !goneRoom && !unansweredHere ? redirectOf(route, rooms) : null),
    [rooms, askingAgain, goneRoom, unansweredHere, route],
  );
  // Before the page paints, so a page that only goes on to another doesn't show.
  useLayoutEffect(() => {
    if (goingOn) redirect(goingOn);
  }, [goingOn, redirect]);
  // The page Activity keeps the drawer open for is the one home goes on to, if it goes on.
  useEffect(() => {
    if (!goingOn) keepDrawer.current = false;
  }, [route, goingOn]);

  const room = route.page !== "room" || goingOn ? null : (goneRoom ?? rooms?.find((r) => r.id === route.roomId) ?? null);
  // When the room shown was marked unread as of as it opened, for its timeline's New line, kept while it
  // stays open, though opening it reads it. Coming back to it with nothing new draws none.
  const [opened, setOpened] = useState<{ roomId: RoomId | null; newSince: string | null }>({ roomId: null, newSince: null });
  if (opened.roomId !== (room?.id ?? null)) {
    const listed = room && rooms?.find((r) => r.id === room.id);
    setOpened({ roomId: room?.id ?? null, newSince: (listed?.unread && listed.unreadSince) || null });
  }
  const direct = route.page !== "direct-settings" || goingOn || !rooms ? null : directIn(goneRoom ? [goneRoom] : rooms, route.roomId);
  // The workspace socket's news that a room is gone takes it out of the list, and the room or the DM's
  // settings shown stay. Declared as a function, so that `useSidebar` above can take it.
  function shownRoomGone(roomId: RoomId) {
    const shown = room ?? direct;
    if (shown?.id === roomId) setGone({ room: shown, route });
  }
  // Go Back on the settings pages returns to the last room visited, or home when there's none.
  const lastRoom = rooms && lastRoomVisited(rooms);
  const back = lastRoom ? roomPath(lastRoom.id) : "/";
  const select = (roomId: string) => navigate(roomPath(roomId));
  // The button on someone's page starts the DM with its person, or opens the one they have, and goes
  // there, listing it as the server answers.
  const startDirectWith = async (person: User) => {
    const answered = askForRoom();
    const mark = pageMark();
    try {
      const room = await startDirect([person.id]);
      answered({ type: "saved", room });
      // A page the person has gone to meanwhile stays.
      if (!mounted.current || pageMark() !== mark) return false;
      navigate(roomPath(room.id));
      return true;
    } catch (error) {
      failed(error);
      return false;
    }
  };
  // Following a link in the drawer closes it: one to another page once that page shows, which unsaved
  // changes hold off while they're asked about, and one to the page shown at once. One the browser opens
  // somewhere else, such as in a new tab, leaves this page as it was, so the drawer stays open.
  const closeForLinkHere = (event: MouseEvent) => {
    // A link followed in place has kept the browser from following it.
    if (!event.defaultPrevented) return;
    const link = (event.target as Element).closest("a[href]");
    if (link instanceof HTMLAnchorElement && link.pathname === location.pathname) setDrawerOpen(false);
  };
  // Following a link in the rail or the sidebar turns Activity off once the app goes there, so keeping
  // unsaved changes, which holds it here, keeps Activity on. One the browser opens somewhere else leaves
  // this page as it was, as it leaves the drawer.
  const showAllForLink = (event: MouseEvent) => {
    if (event.defaultPrevented && (event.target as Element).closest("a[href]")) afterNavigating(() => setUnreadOnly(false));
  };
  const currentRoomId = room?.id ?? null;
  const activity = {
    on: unreadOnly,
    unread: (rooms ?? NO_ROOMS).filter((r) => markedUnread(r, currentRoomId)).length,
    onToggle: () => {
      // A page of community settings has no conversations to show, so Activity goes home to them, once
      // unsaved changes let it. Pressed in the drawer, it keeps the drawer open, as it is when
      // Activity's pressed on any other page.
      if (!settings) return setUnreadOnly((on) => !on);
      const inDrawer = drawerOpen;
      navigate("/");
      afterNavigating(() => {
        setUnreadOnly((on) => !on);
        keepDrawer.current = inDrawer;
      });
    },
  };
  // Cmd+F or Ctrl+F opens the search box, as it opens Slack's: in the room shown, or with the search the
  // results page shows, or for everything. In a dialog, the search box among them, the key is the browser's.
  const findPressed = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || !opensFind(event)) return;
    if (event.target instanceof Element && event.target.closest("[role=dialog]")) return;
    event.preventDefault();
    // Before the sidebar has listed the rooms, the room the address names.
    if (route.page !== "search") return openSearch({ opener: null, roomId: currentRoomId ?? (rooms === null && route.page === "room" ? route.roomId : null) });
    const { search, sort } = searchOfQuery(new URLSearchParams(location.search));
    openSearch({ opener: null, search, sort });
  });
  // Slack's huddle keys: one mutes or unmutes the huddle the tab is in, wherever it's pressed, and the
  // other leaves it, or else starts or joins the huddle of the room shown, as the header's button does,
  // unless it's pressed in a dialog.
  const huddleKeyPressed = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    // Held down, the keys repeat, which counts as the one press: they'd mute and unmute by turns
    // otherwise, and leaving would go on to offer the room's huddle.
    const pressed = (act: () => void) => {
      event.preventDefault();
      if (!event.repeat) act();
    };
    if (togglesMute(event) && huddle) return pressed(() => muteHuddle(!huddle.muted));
    if (!togglesHuddle(event) || (event.target instanceof Element && event.target.closest("[role=dialog]"))) return;
    if (huddle) return pressed(leaveHuddle);
    if (!room || !offersHuddle(room) || goneRoom) return;
    pressed(() => setHuddlePreview(room.id));
  });
  // Cmd+/ or Ctrl+/ opens the keyboard shortcuts: from the composer too, which has no
  // key of its own there, but not over another dialog, a native <dialog> like Notification setup included.
  const shortcutsPressed = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || !opensShortcuts(event)) return;
    if (event.target instanceof Element && event.target.closest("dialog, [role=dialog]")) return;
    event.preventDefault();
    setShortcutsOpen(true);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      findPressed(event);
      huddleKeyPressed(event);
      shortcutsPressed(event);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  // A huddle's link shows its room and offers the huddle, or opens it once the tab is in it. The address
  // becomes the room's, so that loading the page again, or coming back to it, doesn't offer it again.
  const followHuddleLink = useEffectEvent((room: Room) => {
    if (!huddlesOn) flash("alert", "Huddles are turned off.");
    else if (offersHuddle(room) && huddle?.roomId !== room.id) setHuddlePreview(room.id);
    navigate(roomPath(room.id), { replace: true });
    if (huddle?.roomId === room.id) opensHuddle.current = pageMark();
  });
  const huddleLinked = route.page === "room" && route.huddle === true && !goneRoom ? room : null;
  useLayoutEffect(() => {
    if (huddleLinked) followHuddleLink(huddleLinked);
  }, [huddleLinked]);

  // The app's badge counts what Activity does, as badge_dot_controller.js counts the sidebar's unread rows,
  // once the server's list has come: the empty one a failed first load leaves knows nothing of what's unread.
  useAppBadge(answered ? activity.unread : null);
  const rail = (
    <Rail me={me} workspaceName={workspaceName} current={RAIL_PAGES[route.page]} activity={activity} newRelease={newRelease} onNewDirect={openNewDirect} />
  );
  const sidebar = (
    <Sidebar
      workspaceName={workspaceName}
      meId={me.id}
      rooms={rooms ?? NO_ROOMS}
      loaded={rooms !== null}
      favorites={favorites}
      sharedOrder={sharedOrder}
      huddles={huddlesOn ? liveHuddles : NO_HUDDLES}
      currentRoomId={currentRoomId}
      unreadOnly={unreadOnly}
      agents={agents}
      agentsOpen={agentsList !== null}
      onSelect={select}
      onNewDirect={openNewDirect}
      onOpenAgents={openAgents}
      onStarred={starredRooms}
      onSessionChanged={onSessionChanged}
    />
  );

  /**
   * One of the pages few visits need, as `show` makes it once they've loaded. Keyed by the page, so that going on
   * from one that couldn't load them to another tries again.
   */
  const rarePage = (show: (pages: RarePages) => ReactNode) => (
    <RarePage key={route.page} show={show} loading={settings ? SETTINGS_LOADING : LOADING} onFailed={failed} />
  );
  const page = () => {
    switch (route.page) {
      case "new-room":
        // Not keyed, so flipping Everyone, which changes the address, keeps what's filled in.
        return rarePage(({ NewRoomPage }) => <NewRoomPage access={route.access} me={me} onCreated={listRoom} onFailed={failed} />);
      case "room-settings":
        return rarePage(({ RoomSettingsPage }) => (
          <RoomSettingsPage
            key={route.roomId}
            roomId={route.roomId}
            access={route.access}
            me={me}
            askForRoom={askForRoom}
            onMissing={missing}
            onFailed={failed}
          />
        ));
      case "workspace-settings":
        return rarePage(({ WorkspaceSettingsPage }) => (
          <WorkspaceSettingsPage
            me={me}
            back={back}
            askForAccount={askForAccount}
            onJoinCodeChanged={joinCodeChanged}
            reloadPeople={directory.reload}
            onPersonChanged={directory.update}
            onFailed={failed}
            rooms={rooms}
            sharedOrder={sharedOrder}
            onSharedOrderSaved={reorderedRooms}
            onSessionChanged={onSessionChanged}
            release={release}
            onCheckForUpdates={checkForUpdates}
          />
        ));
      case "custom-styles":
        return rarePage(({ CustomStylesPage }) => <CustomStylesPage askForAccount={askForAccount} onFailed={failed} />);
      case "bots":
        return rarePage(({ BotsPage }) => <BotsPage onFailed={failed} />);
      case "new-bot":
        return rarePage(({ NewBotPage }) => <NewBotPage me={me} onFailed={failed} />);
      case "bot-settings":
        return rarePage(({ BotSettingsPage }) => (
          <BotSettingsPage key={route.userId} botId={route.userId} onMissing={showNotFound} onFailed={failed} />
        ));
      case "new-agent":
        return rarePage(({ NewAgentPage }) => <NewAgentPage me={me} rooms={rooms} onFailed={failed} />);
      case "agent-settings":
        // @ember's page is its own, with what the Ember AI card held before there were agents.
        if (route.agentId === ASSISTANT_ID) return rarePage(({ EmberPage }) => <EmberPage me={me} onFailed={failed} />);
        return rarePage(({ AgentSettingsPage }) => (
          <AgentSettingsPage key={route.agentId} agentId={route.agentId} me={me} rooms={rooms} onMissing={showNotFound} onFailed={failed} />
        ));
      case "new-app":
        return rarePage(({ NewAppPage }) => <NewAppPage me={me} onFailed={failed} />);
      case "app-settings":
        return rarePage(({ AppSettingsPage }) => <AppSettingsPage key={route.appId} appId={route.appId} me={me} onMissing={showNotFound} onFailed={failed} />);
      case "app-signed-in":
        return rarePage(({ AppSignedInPage }) => <AppSignedInPage me={me} onFailed={failed} />);
      case "profile":
        return rarePage(({ ProfilePage }) => <ProfilePage me={me} rooms={rooms} askForRoom={askForRoom} onSignOut={onSignOut} onFailed={failed} />);
      case "push-subscriptions":
        return rarePage(({ PushSubscriptionsPage }) => <PushSubscriptionsPage back={back} onFailed={failed} />);
      case "search":
        return rarePage(({ SearchPage }) => <SearchPage me={me} rooms={rooms ?? NO_ROOMS} back={back} onFailed={failed} />);
      case "person":
        return rarePage(({ PersonPage }) => (
          <PersonPage
            key={route.userId}
            userId={route.userId}
            me={me}
            onStartDirect={startDirectWith}
            onPersonChanged={directory.update}
            reloadPeople={directory.reload}
            onMissing={showNotFound}
            onFailed={failed}
          />
        ));
      default:
        if (direct)
          return rarePage(({ DirectSettingsPage }) => (
            <DirectSettingsPage key={direct.id} room={direct} me={me} back={back} askForRoom={askForRoom} onMissing={missing} onFailed={failed} />
          ));
        if (room)
          return (
            <RoomView
              key={`${room.id}/${returns}`}
              ref={roomView}
              room={room}
              messageId={route.page === "room" ? route.messageId : undefined}
              threadId={route.page === "room" ? route.threadId : undefined}
              replyId={route.page === "room" ? route.replyId : undefined}
              invitation={invitation?.roomId === room.id ? invitation : null}
              onDismissInvitation={dismissCard}
              me={me}
              favorite={starred.has(room.id)}
              gone={goneRoom !== null}
              onStarred={starredRooms}
              // As the list has it, or as it starts once the room has gone from the list.
              involvement={rooms?.find((r) => r.id === room.id)?.involvement ?? startingInvolvement(room)}
              newSince={opened.roomId === room.id ? opened.newSince : null}
              askForRoom={askForRoom}
              onSessionChanged={onSessionChanged}
              onFailed={failed}
              onGone={roomGone}
            />
          );
        if (route.page === "home" && rooms && !goingOn) return <WelcomePage me={me} />;
        // Why the room can't show, kept where it would show rather than in an alert that fades, as a
        // browser's own page says when a server can't be reached. The header keeps the way to the other
        // rooms on a phone.
        if (unansweredHere)
          return (
            <>
              <PageHeader />
              <MainContent className="flex min-h-0 min-w-0 flex-col bg-background pr-[env(safe-area-inset-right)] max-md:pl-[env(safe-area-inset-left)]">
                <div className="grid flex-1 place-content-center justify-items-center gap-4 p-6 text-center">
                  <p role="alert" className="text-muted-foreground">
                    {unansweredHere.reason}
                  </p>
                  <Button type="button" variant="outline" className="touch:h-11" onClick={tryAgain}>
                    Try again
                  </Button>
                </div>
              </MainContent>
            </>
          );
        // While the rooms load, or before the page goes on to another, which it does before this paints.
        return LOADING;
    }
  };

  // The Sheet wraps the whole layout so the header's menu button can be its trigger, which gives it
  // aria-expanded and gets focus back to it when the drawer closes. The skip link comes first, and the
  // rail and conversations are landmarks in either layout. On a page of community settings, the header
  // spans the column beside the rail, 244px wide there, and the links to their sections, which it
  // brings, fill that column under it, or at 900px and below, a row of their own. The layout contains
  // and clips whatever is placed absolutely inside it, such as text for screen readers only, and can't
  // scroll itself. Otherwise that text, far down a long page, would reach past it and make the document
  // scrollable, so that a mouse wheel over the header, or a change of the address's fragment, would
  // scroll the whole layout up.
  const layout = (
    <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
      <DrawerOpen value={drawerOpen}>
        <div
          className={cn(
            "relative grid h-dvh grid-cols-[calc(var(--spacing-rail)+env(safe-area-inset-left))_var(--spacing-sidebar)_minmax(0,1fr)] grid-rows-[var(--spacing-header)_minmax(0,1fr)] overflow-clip bg-surface max-md:grid-cols-[minmax(0,1fr)] max-md:grid-rows-[calc(56px+env(safe-area-inset-top))_minmax(0,1fr)]",
            settings && "[--spacing-sidebar:244px] max-md:grid-rows-[calc(56px+env(safe-area-inset-top))_auto_minmax(0,1fr)]",
            // A thread open beside its room, from 1180px wide, which takes 420px of the room's width.
            "min-[1180px]:has-[[data-thread]]:grid-cols-[calc(var(--spacing-rail)+env(safe-area-inset-left))_var(--spacing-sidebar)_minmax(0,1fr)_420px]",
          )}
        >
          <SkipLink to={huddle?.open ? OPEN_HUDDLE : undefined} />
          <div className="contents max-md:hidden [&>*]:row-span-2" onClick={showAllForLink}>
            {rail}
            {!settings && (
              <aside aria-label="Conversations" className="min-h-0 overflow-hidden border-r">
                {sidebar}
              </aside>
            )}
          </div>

          <SheetContent
            side="left"
            showCloseButton={false}
            // Opening it focuses its close button, or with the rail alone, its first link.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              (settings ? drawerRail.current?.querySelector<HTMLElement>("a[href]") : closeDrawerButton.current)?.focus();
            }}
            // Closing gives focus back to the menu button once the drawer has slid away, but only if focus went
            // with it: by then New direct message's search, or whatever was tapped as it slid, can have it.
            onCloseAutoFocus={(event) => {
              const focused = document.activeElement;
              if (focused && focused !== document.body) event.preventDefault();
            }}
            onClick={(event) => {
              closeForLinkHere(event);
              showAllForLink(event);
            }}
            className="flex w-auto max-w-[calc(100dvw-16px)] flex-row gap-0 border-0 bg-surface p-0 shadow-none sm:max-w-[calc(100dvw-16px)] md:hidden"
          >
            <SheetTitle className="sr-only">{settings ? "Navigation" : "Conversations"}</SheetTitle>
            <SheetDescription className="sr-only">{settings ? "Ember’s pages" : "Rooms and direct messages"}</SheetDescription>
            <div ref={drawerRail} className="pt-[env(safe-area-inset-top)]">
              {rail}
            </div>
            {/* The drawer leaves at least 16px of the room showing. */}
            {!settings && (
              <aside aria-label="Conversations" className="relative w-sidebar min-w-0 overflow-hidden border-r pt-[env(safe-area-inset-top)]">
                {/* A 44px button clear of the status bar, first in the sidebar's tab order, with Iconoir's xmark. */}
                <SheetClose
                  ref={closeDrawerButton}
                  aria-label="Close conversations"
                  className="absolute top-[max(7px,env(safe-area-inset-top))] right-1 z-[2] flex size-11 items-center justify-center rounded-lg bg-surface hover:bg-hover"
                >
                  <Xmark className="size-5" />
                </SheetClose>
                {sidebar}
              </aside>
            )}
          </SheetContent>

          {/* The page, placed in the grid as if it were its own, with nothing of it to reach while the huddle opened covers it. */}
          <div className="contents" inert={huddle?.open === true}>
            {page()}
          </div>
          {huddle?.open && (
            <RarePage show={({ HuddleView }) => <HuddleView huddle={huddle} room={huddleRoom} meId={me.id} />} loading={null} onFailed={failed} />
          )}
          <Notices>
            <MovedNotice />
            <UpdatedNotice />
          </Notices>
          {huddlesOn && invitations.length > 0 && (
            <RarePage
              show={({ HuddleInvitations }) => (
                <HuddleInvitations
                  invitations={invitations}
                  rooms={rooms ?? NO_ROOMS}
                  quiet={inAHuddle}
                  onJoin={joinInvited}
                  onDecline={answerInvitation}
                  onUnanswered={invitationOver}
                />
              )}
              loading={null}
              onFailed={failed}
            />
          )}
          {newDirect && (
            <NewDirectDialog
              opener={newDirect.opener}
              me={me}
              reloadPeople={directory.reload}
              askForRoom={askForRoom}
              onClose={(startedShown) => {
                setNewDirect(null);
                // The DM shown stays as it is when it's the one started, so its composer takes focus, as
                // opening it would.
                if (startedShown) roomView.current?.focusComposer();
              }}
              onLeftOut={(people) => flash("alert", startedWithout(people.map((person) => person.name)))}
              onFailed={failed}
            />
          )}
          {agentsList && (
            <RarePage
              show={({ AvailableAgentsDialog }) => (
                <AvailableAgentsDialog
                  me={me}
                  rooms={rooms ?? NO_ROOMS}
                  opener={agentsList.opener}
                  onClose={(started) => {
                    setAgentsList(null);
                    // The dialog kept focus while the page went to the DM it started, whose composer takes it
                    // now, as opening the DM would give it.
                    if (started) roomView.current?.focusComposer();
                  }}
                  onStartDirect={startDirectWith}
                  onFailed={agentsListFailed}
                />
              )}
              loading={null}
              onFailed={agentsListFailed}
            />
          )}
          <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
          {searchBox && <SearchBox {...searchBox} me={me} rooms={rooms ?? NO_ROOMS} onClose={() => setSearchBox(null)} onFailed={failed} />}
          {previewed && (
            <RarePage
              show={({ HuddlePreview }) => <HuddlePreview key={previewed.id} room={previewed} me={me} live={liveHuddles[previewed.id]} onClose={closeHuddlePreview} />}
              loading={null}
              onFailed={huddlePreviewFailed}
            />
          )}
          {huddle && !huddle.open && (
            <RarePage show={({ HuddleBar }) => <HuddleBar huddle={huddle} room={huddleRoom} meId={me.id} />} loading={null} onFailed={failed} />
          )}
        </div>
      </DrawerOpen>
    </Sheet>
  );
  return (
    <PeopleContext value={directory.people}>
      <DirectoryLoaded value={directory.loaded}>
        <SettingsLayout value={settings}>
          <OpenSearchContext value={openSearch}>
            <HuddlesContext value={huddles}>{layout}</HuddlesContext>
          </OpenSearchContext>
        </SettingsLayout>
      </DirectoryLoaded>
    </PeopleContext>
  );
}
