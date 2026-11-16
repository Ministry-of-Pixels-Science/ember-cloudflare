import type { RoomId, User, UserId } from "@ember/protocol";
import type { HuddlePerson } from "@ember/protocol/huddles";
import type { HuddleDevice } from "./huddle-devices";

/**
 * The huddle this tab is in, as its room's header, the huddle's bar and the huddle itself, opened, show
 * it. A tab is in one huddle at most, and only while it's open: loading the page again leaves it.
 */
export interface JoinedHuddle {
  roomId: RoomId;
  /** Whether the room has let the tab in: not as it joins, nor while its connection to the room is down. */
  connected: boolean;
  /** This tab's person, once the room has said who they are. */
  you: User | null;
  /** Everyone in the huddle, in the order they joined, as the room last said. */
  people: HuddlePerson[];
  muted: boolean;
  /** Whether the tab has a microphone to unmute. Without one its person only listens. */
  microphone: boolean;
  /** That microphone, by its device's id: empty with none, and where the browser doesn't say which it is. */
  microphoneId: string;
  /** The speaker the tab plays the huddle through, by its device's id, or empty for the system's. */
  speakerId: string;
  /** The tab's camera while it's on, for its person to see what the others do. */
  camera: MediaStream | null;
  /** The others' cameras the tab watches, by whose each is. */
  watched: ReadonlyMap<UserId, MediaStream>;
  /** The screen the tab's person shares, for them to see what the others do. */
  screen: MediaStream | null;
  /** The screens the others share that the tab watches, by whose each is. */
  screens: ReadonlyMap<UserId, MediaStream>;
  /** Whether the tab shows the huddle opened, a tile for each person, rather than as its bar. Only then does it watch anyone's camera or screen. */
  open: boolean;
}

/** What the tab's huddle takes from outside it, which its header button, its bar, the huddle opened and the shortcuts ask of it. */
export interface HuddleControls {
  leave(): void;
  setMuted(muted: boolean): void;
  setCamera(on: boolean): void;
  setScreen(shared: boolean): void;
  setOpen(open: boolean): void;
  /** Says whether the huddle, opened, shows people in tiles small enough for the smaller of the sizes a camera is sent in, which is then the one it's sent. */
  setSmall(small: boolean): void;
  /** Speaks through the microphone `deviceId`, plays through that speaker, or shows that camera, from now. */
  setDevice(kind: HuddleDevice, deviceId: string): void;
}

/** The id the huddle opened has in the page, where Skip to main content goes while it covers the page. */
export const OPEN_HUDDLE = "huddle";

let joined: JoinedHuddle | null = null;
let controls: HuddleControls | null = null;
const listeners = new Set<() => void>();
let told: ((what: string) => void) | null = null;

/** Hears whenever the tab's huddle changes, until the function returned is called, as `useSyncExternalStore` takes it. */
export function watchHuddle(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// Who's speaking changes several times a second, so it's kept apart from the huddle, for only what
// shows it to hear of.
let speaking: ReadonlySet<UserId> = new Set();
const speakingListeners = new Set<() => void>();

/** Hears whenever who's speaking in the tab's huddle changes, until the function returned is called. */
export function watchSpeaking(listener: () => void): () => void {
  speakingListeners.add(listener);
  return () => void speakingListeners.delete(listener);
}

/** Whether `userId` is speaking in the tab's huddle now, as far as the tab can hear. */
export const isSpeaking = (userId: UserId) => speaking.has(userId);

/** Shows who's speaking in the tab's huddle. The huddle's own code calls this. */
export function showSpeaking(who: ReadonlySet<UserId>): void {
  speaking = who;
  for (const listener of speakingListeners) listener();
}

/** The huddle the tab is in, or null. */
export const joinedHuddle = () => joined;

/** Shows the tab's huddle as `huddle`, which `its` controls work, or that it's in none. The huddle's own code calls this. */
export function showHuddle(huddle: JoinedHuddle | null, its: HuddleControls | null = controls): void {
  joined = huddle;
  controls = huddle && its;
  for (const listener of listeners) listener();
}

/** Leaves the huddle the tab is in, if it's in one. */
export const leaveHuddle = () => controls?.leave();

/** Mutes the tab's microphone in its huddle, or unmutes it, if it's in one. */
export const muteHuddle = (muted: boolean) => controls?.setMuted(muted);

/** Turns the tab's camera on in its huddle, which asks the browser for one, or off, if it's in one. */
export const showHuddleCamera = (on: boolean) => controls?.setCamera(on);

/** Shares the tab's screen in its huddle, which has the browser ask its person what to share, or stops sharing it, if it's in one. */
export const shareHuddleScreen = (shared: boolean) => controls?.setScreen(shared);

/** Shows the tab's huddle opened, or as its bar again, if it's in one. */
export const openHuddle = (open: boolean) => controls?.setOpen(open);

/** Has the tab's huddle be sent the others' cameras in the smaller of their sizes, as while it shows them in small tiles, or in the larger again, if it's in one. */
export const takeCamerasSmall = (small: boolean) => controls?.setSmall(small);

/**
 * Has the tab's huddle speak through another microphone, play through another speaker, or show another
 * camera, which turns its camera on, if it's in one. For a speaker, an empty id is the system's.
 */
export const chooseHuddleDevice = (kind: HuddleDevice, deviceId: string) => controls?.setDevice(kind, deviceId);

/**
 * Has `say` told whatever the tab's huddle has to tell its person, until the function returned is
 * called: why the room ended it for them, or why their camera stays off or their screen isn't shared.
 */
export function hearHuddle(say: (what: string) => void): () => void {
  told = say;
  return () => {
    if (told === say) told = null;
  };
}

/** Tells the tab's person `what` of their huddle. The huddle's own code calls this. */
export const tellOfHuddle = (what: string) => told?.(what);

/** Shows that the room ended the tab's huddle, and says `why`. */
export function endHuddle(why: string): void {
  showHuddle(null);
  tellOfHuddle(why);
}
