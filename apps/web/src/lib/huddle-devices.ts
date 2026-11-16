// The microphone, the speaker and the camera a huddle uses, which its preview lets someone choose, as
// the huddle's own menus do once they're in it, and this browser remembers for the next, and the screen
// someone shares in one, which the browser asks them for each time.

export type HuddleDevice = "microphone" | "speaker" | "camera";

const KEYS: Record<HuddleDevice, string> = { microphone: "ember:huddle-microphone", speaker: "ember:huddle-speaker", camera: "ember:huddle-camera" };

/** The device of that kind this browser's last huddle used, by its id, or null when it used the browser's own choice. */
export function rememberedDevice(kind: HuddleDevice): string | null {
  try {
    return localStorage.getItem(KEYS[kind]) || null;
  } catch {
    return null;
  }
}

/** Remembers the device chosen, or with an empty id, that the browser's own choice was. */
export function rememberDevice(kind: HuddleDevice, deviceId: string): void {
  try {
    if (deviceId) localStorage.setItem(KEYS[kind], deviceId);
    else localStorage.removeItem(KEYS[kind]);
  } catch {
    // Storage can be refused, and then the next huddle starts with the browser's own choice.
  }
}

/** Whether what failed is that the device asked for is gone, rather than that the person or the browser refused. */
function deviceGone(error: unknown): boolean {
  // Not every browser's OverconstrainedError is an Error.
  const name = (error as { name?: unknown } | null)?.name;
  return name === "OverconstrainedError" || name === "NotFoundError";
}

/**
 * Opens a microphone, which makes the browser ask the person the first time: `deviceId`'s, or the
 * browser's own choice when it has none or that one is gone. Null when there's no microphone, the person
 * or the browser refuses one, or the page isn't one a browser gives a microphone, as over plain HTTP.
 */
export async function openMicrophone(deviceId: string | null): Promise<MediaStream | null> {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (!media?.getUserMedia) return null;
  try {
    return await media.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
  } catch (error) {
    return deviceId && deviceGone(error) ? openMicrophone(null) : null;
  }
}

/** The device a microphone's stream is from, by its id, or empty where the browser doesn't say. */
export const microphoneOf = (stream: MediaStream | null) => stream?.getAudioTracks()[0]?.getSettings().deviceId ?? "";

/** What a huddle asks of a camera: a picture the size of a tile, which is as large as it shows anyone. */
const CAMERA: MediaTrackConstraints = { width: { ideal: 640 }, height: { ideal: 360 } };

/** What someone is told once there's no camera Ember may use. */
export const NO_CAMERA = "Ember has no camera to use. To show yours, let this site use your camera in your browser's settings, then turn it on again.";

/**
 * Opens a camera, which makes the browser ask the person the first time, and turns its light on:
 * `deviceId`'s, or the browser's own choice when it has none or that one is gone. Null when there's no
 * camera, the person or the browser refuses one, or the page isn't one a browser gives a camera.
 */
export async function openCamera(deviceId: string | null): Promise<MediaStream | null> {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (!media?.getUserMedia) return null;
  try {
    return await media.getUserMedia({ video: deviceId ? { ...CAMERA, deviceId: { exact: deviceId } } : CAMERA });
  } catch (error) {
    return deviceId && deviceGone(error) ? openCamera(null) : null;
  }
}

/** What someone in a huddle is told once the browser won't open the microphone, or the camera, they chose in place of theirs, or play through the speaker they chose. */
export const NO_OTHER_MICROPHONE = "Ember couldn't use that microphone. Nothing has changed.";
export const NO_OTHER_CAMERA = "Ember couldn't use that camera. Nothing has changed.";
export const NO_OTHER_SPEAKER = "Ember couldn't use that speaker. Nothing has changed.";
/** And what someone who only listens in one is told once the browser has no microphone for them still. */
export const STILL_NO_MICROPHONE = "Ember has no microphone to use. To speak, let this site use your microphone in your browser's settings, then choose it again.";

/** The device a camera's stream is from, by its id, or empty where the browser doesn't say. */
export const cameraOf = (stream: MediaStream | null) => stream?.getVideoTracks()[0]?.getSettings().deviceId ?? "";

/**
 * What a huddle asks of a shared screen: no larger than 1080p, which a larger display is scaled down
 * to, and no more than 15 pictures a second, which leaves what its connection carries to keeping text
 * sharp. No sound, as a huddle's connections for screens carry pictures only.
 */
const SCREEN: DisplayMediaStreamOptions = { video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 15 } }, audio: false };

/** What someone is told once their browser couldn't share what they chose. */
export const NO_SCREEN = "Ember couldn't share your screen. To share it, let your browser record the screen in your computer's privacy settings, then share it again.";

/** Whether this browser can share a screen, which a phone's can't. */
export const sharesScreens = () => typeof (navigator.mediaDevices as MediaDevices | undefined)?.getDisplayMedia === "function";

/**
 * Whether what failed is that the person chose nothing to share, rather than that the browser couldn't
 * share what they chose. Both refuse the page, but Chrome says so of a computer that keeps it from
 * recording the screen.
 */
function choseNothing(error: unknown): boolean {
  const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
  return name === "NotAllowedError" && !(typeof message === "string" && message.includes("system"));
}

/**
 * Opens what the person chooses to share, a screen, a window or a tab, which the browser asks them each
 * time, and has it keep text sharp where it can't keep that and smooth movement both. Null when they
 * choose nothing. It rejects when the browser can't share one.
 */
export async function openScreen(): Promise<MediaStream | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(SCREEN);
    for (const track of stream.getVideoTracks()) track.contentHint = "detail";
    return stream;
  } catch (error) {
    if (choseNothing(error)) return null;
    throw error;
  }
}

/** Stops a microphone's stream, a camera's or a shared screen's, which lets go of the device, puts a camera's light out and ends the browser's sharing. */
export function closeDevice(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export interface HuddleDevices {
  microphones: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
}

export const NO_DEVICES: HuddleDevices = { microphones: [], speakers: [], cameras: [] };

/** Whether this browser can play a huddle through a speaker other than the system's, which Safari can't. */
const choosesSpeaker = () => typeof HTMLMediaElement.prototype.setSinkId === "function";

/**
 * The microphones, speakers and cameras the browser lists, which it does by name only once a microphone
 * is open, and for cameras, a camera. It lists no speakers where the huddle couldn't play through one of
 * them.
 */
export async function listDevices(): Promise<HuddleDevices> {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.deviceId !== "");
    return {
      microphones: devices.filter((device) => device.kind === "audioinput"),
      speakers: choosesSpeaker() ? devices.filter((device) => device.kind === "audiooutput") : [],
      cameras: devices.filter((device) => device.kind === "videoinput"),
    };
  } catch {
    return NO_DEVICES;
  }
}

/**
 * Whether the browser still lists the speaker `deviceId`, which it stops doing once that's unplugged. One
 * a browser can't say of counts as there.
 */
export async function listsSpeaker(deviceId: string): Promise<boolean> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).some((device) => device.kind === "audiooutput" && device.deviceId === deviceId);
  } catch {
    return true;
  }
}

/** A device to choose: its id, and what the browser calls it, which is nothing where it doesn't say. */
export type DeviceChoice = Pick<MediaDeviceInfo, "deviceId" | "label">;

/** The devices to choose among, led by the one that's open where the browser's list leaves it out. */
export function withOpen(listed: MediaDeviceInfo[], deviceId: string, open?: MediaStreamTrack): DeviceChoice[] {
  return listed.some((device) => device.deviceId === deviceId) ? listed : [{ deviceId, label: open?.label ?? "" }, ...listed];
}

/** The speakers to choose among: a browser that lists its own choice has it first, and the others get one to choose. */
export function speakerChoices(listed: MediaDeviceInfo[]): DeviceChoice[] {
  return listed.some(({ deviceId }) => deviceId === "default") ? listed : [{ deviceId: "", label: "System default" }, ...listed];
}

/** Has `changed` hear whenever a device is plugged in or taken away, until the function returned is called. */
export function watchDevices(changed: () => void): () => void {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  media?.addEventListener?.("devicechange", changed);
  return () => media?.removeEventListener?.("devicechange", changed);
}
