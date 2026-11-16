import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { LiveHuddle, Me, SharedRoom } from "@ember/protocol";
import { CAMERAS_OFF } from "@ember/protocol/huddles";
import { Field } from "@/components/field";
import { Microphone, MicrophoneMute, VideoCamera, VideoCameraOff, Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useCamerasAllowed } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { useHuddle } from "@/hooks/use-huddle";
import { joinHuddle } from "@/lib/huddle";
import { cameraOf, closeDevice, listDevices, microphoneOf, NO_CAMERA, NO_DEVICES, openCamera, openMicrophone, rememberDevice, rememberedDevice, speakerChoices, watchDevices, withOpen } from "@/lib/huddle-devices";
import { inItNow } from "@/lib/huddle-people";
import { cn } from "@/lib/utils";
import { HuddlePicture } from "./huddle-picture";
import { SELECT } from "./model-picker";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE, MAIN_ACTION, OTHER_ACTION } from "./unsaved-changes";
import { UserAvatar } from "./user-avatar";

/** What the preview says while the browser asks whether Ember may use a microphone. */
export const ASKING_FOR_MICROPHONE = "Waiting for your browser to let Ember use your microphone…";
/** And once there's none it may use. */
export const NO_MICROPHONE = "Ember has no microphone to use, so you'll only listen. To speak, let this site use your microphone in your browser's settings, then join again.";

/**
 * The microphone the preview has open, which it asks the browser for as it opens: undefined while the
 * browser asks the person, and null once there's none to use. It closes with the preview, unless the
 * huddle took it. The devices are listed once it's open, when the browser names them.
 */
function usePreviewMicrophone() {
  const [stream, setStream] = useState<MediaStream | null>();
  const [devices, setDevices] = useState(NO_DEVICES);
  const open = useRef<MediaStream | null>(null);
  // Counts what the browser has been asked, so an answer to anything but the last is closed again.
  const asked = useRef(0);

  const ask = useCallback(async (deviceId: string | null) => {
    const asking = ++asked.current;
    closeDevice(open.current);
    open.current = null;
    setStream(undefined);
    const opened = await openMicrophone(deviceId);
    const listed = asked.current === asking ? await listDevices() : NO_DEVICES;
    if (asked.current !== asking) return closeDevice(opened);
    open.current = opened;
    setStream(opened);
    setDevices(listed);
  }, []);
  const list = useCallback(() => void listDevices().then(setDevices), []);

  useEffect(() => {
    void ask(rememberedDevice("microphone"));
    const stopWatching = watchDevices(list);
    return () => {
      asked.current++;
      stopWatching();
      closeDevice(open.current);
      open.current = null;
    };
  }, [ask, list]);

  // A microphone unplugged while it's previewed gives way to the browser's own choice.
  useEffect(() => {
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    const gone = () => void ask(null);
    track.addEventListener("ended", gone);
    return () => track.removeEventListener("ended", gone);
  }, [stream, ask]);

  /** Hands the microphone to the huddle, which closes it from then on. */
  const take = () => {
    const taken = open.current;
    open.current = null;
    return taken;
  };
  return { stream, devices, ask, list, take };
}

/** A camera the browser has been asked for and has yet to answer with, and whether the huddle took it meanwhile. */
interface OpeningCamera {
  answer: Promise<MediaStream | null>;
  taken: boolean;
}

/**
 * The camera the preview has open, which it asks the browser for only once its switch turns it on: null
 * while it's off, and `refused` once there's none to use. It closes with the preview, unless the huddle
 * took it. `opened` hears of each one, when the browser names the cameras. An administrator who turns
 * cameras off, so that they're no longer `allowed`, takes down the one that's on, which `takenDown` says.
 */
function usePreviewCamera(opened: () => void, allowed: boolean) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [refused, setRefused] = useState(false);
  const [takenDown, setTakenDown] = useState(false);
  const open = useRef<MediaStream | null>(null);
  // What the browser was asked last, until it answers: its answer to anything else is closed again.
  const opening = useRef<OpeningCamera | null>(null);

  const turnOff = useCallback(() => {
    opening.current = null;
    closeDevice(open.current);
    open.current = null;
    setStream(null);
  }, []);
  const turnOn = useCallback(
    async (deviceId: string | null) => {
      turnOff();
      setRefused(false);
      setTakenDown(false);
      const asking = (opening.current = { answer: openCamera(deviceId), taken: false });
      const camera = await asking.answer;
      // The huddle's now, to show once it's open.
      if (asking.taken) return;
      if (opening.current !== asking) return closeDevice(camera);
      opening.current = null;
      open.current = camera;
      setStream(camera);
      setRefused(!camera);
      if (camera) opened();
    },
    [turnOff, opened],
  );

  useEffect(
    () => () => {
      opening.current = null;
      closeDevice(open.current);
      open.current = null;
    },
    [],
  );

  // Cameras turned off take down the one that's on, or that the browser is still opening.
  useEffect(() => {
    if (allowed || (!stream && !opening.current)) return;
    turnOff();
    setTakenDown(true);
  }, [allowed, stream, turnOff]);

  // A camera unplugged while it's previewed goes off.
  useEffect(() => {
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    track.addEventListener("ended", turnOff);
    return () => track.removeEventListener("ended", turnOff);
  }, [stream, turnOff]);

  /**
   * Hands the camera to the huddle, which closes it from then on: the one that's open, or the one the
   * browser is still opening, as when Join follows the camera's switch at once.
   */
  const take = () => {
    const taken = open.current ?? opening.current?.answer ?? null;
    if (opening.current) opening.current.taken = true;
    open.current = null;
    return taken;
  };
  return { stream, refused, takenDown, turnOn, turnOff, take };
}

interface SwitchProps {
  label: string;
  /** Whether what it switches is on, which fills it. */
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

/** A round switch over the preview's picture: filled in ink while what it switches is on, as the huddle's own buttons are. */
function PreviewSwitch({ label, on, disabled, onClick, children }: SwitchProps) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-10 cursor-pointer place-items-center rounded-full border touch:size-11 disabled:cursor-default disabled:opacity-50 [&_svg]:size-5",
        on ? "border-transparent bg-foreground text-background" : "bg-background text-foreground enabled:hover:bg-hover",
      )}
    >
      {children}
    </button>
  );
}

/** Keeps a button's words on one line beside the other button, on a phone 320px wide too. */
const ON_ONE_LINE = "whitespace-nowrap upto-480px:px-4";

interface Props {
  room: SharedRoom;
  me: Me;
  /** The huddle going on in the room, as the sidebar last heard, if one is. */
  live: LiveHuddle | undefined;
  onClose: () => void;
}

/**
 * The preview a huddle starts from, as Slack shows before one starts or you join one: who's in it, your
 * picture over the switches that mute your microphone and turn your camera on, what to speak, listen
 * and be seen through, then Cancel and Start Huddle or Join Huddle. Opening it asks the browser for the
 * microphone, so the huddle starts with it open, or listening only when there's none. The camera stays
 * off, and unasked for, until its switch turns it on, when the picture is its own. It has no switch
 * while an administrator has cameras off.
 */
export function HuddlePreview({ room, me, live, onClose }: Props) {
  const people = useContext(PeopleContext);
  const joined = useHuddle();
  const { stream, devices, ask, list, take } = usePreviewMicrophone();
  const camerasAllowed = useCamerasAllowed();
  const camera = usePreviewCamera(list, camerasAllowed);
  const [muted, setMuted] = useState(false);
  const [speakerId, setSpeakerId] = useState(() => rememberedDevice("speaker") ?? "");
  const title = useRef<HTMLHeadingElement>(null);

  const inIt = live?.userIds ?? [];
  const others = inIt.filter((userId) => userId !== me.id);
  const going = inIt.length > 0;
  const description = [
    others.length > 0 ? inItNow(others.flatMap((userId) => people.get(userId)?.name ?? []), others.length) : !going && `Everyone in ${room.name} can join once it starts.`,
    inIt.length > others.length && "You're in it in another tab or on another device, and joining here leaves it there.",
    joined && `${going ? "Joining" : "Starting"} it leaves the huddle you're in now.`,
  ];

  const microphone = microphoneOf(stream ?? null);
  const microphones = withOpen(devices.microphones, microphone, stream?.getAudioTracks()[0]);
  const shown = cameraOf(camera.stream);
  const cameras = withOpen(devices.cameras, shown, camera.stream?.getVideoTracks()[0]);
  const speakers = speakerChoices(devices.speakers);
  const speaker = speakers.find(({ deviceId }) => deviceId === speakerId)?.deviceId ?? speakers[0]!.deviceId;
  const silent = muted || !stream;
  // Why the camera is off though its switch was turned on: the browser has none to give, or an administrator turned cameras off meanwhile.
  const cameraNote = camerasAllowed ? camera.refused && NO_CAMERA : camera.takenDown && CAMERAS_OFF;

  const chooseMicrophone = (deviceId: string) => {
    rememberDevice("microphone", deviceId);
    void ask(deviceId);
  };
  const chooseSpeaker = (deviceId: string) => {
    rememberDevice("speaker", deviceId);
    setSpeakerId(deviceId);
  };
  const chooseCamera = (deviceId: string) => {
    rememberDevice("camera", deviceId);
    void camera.turnOn(deviceId);
  };
  const join = () => {
    joinHuddle({ roomId: room.id, muted, microphone: take(), camera: camera.take(), speakerId: speaker });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => open || onClose()}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={DIALOG_BACKDROP}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        className={cn(DIALOG, "w-[460px]")}
      >
        <button type="button" aria-label="Cancel" onClick={onClose} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle ref={title} tabIndex={-1} className={cn(DIALOG_TITLE, "pe-10 wrap-anywhere outline-none")}>
          {going ? `Join the huddle in ${room.name}` : `Start a huddle in ${room.name}`}
        </DialogTitle>
        <DialogDescription className="leading-[1.65] text-muted-foreground">{description.filter(Boolean).join(" ")}</DialogDescription>

        {/* As wide as a camera's picture, which fills it while the camera's on, and taller where a narrow phone's wouldn't hold the avatar and the switches. */}
        <div className={cn("relative mt-5 grid aspect-[16/9] justify-center justify-items-center gap-3.5 overflow-hidden rounded-xl border bg-surface py-4", camera.stream ? "content-end" : "content-center")}>
          {camera.stream ? <HuddlePicture stream={camera.stream} label="Your camera" mirrored /> : <UserAvatar user={me} square className="size-[88px] rounded-2xl upto-480px:size-[72px]" />}
          <div className="relative flex gap-2.5">
            <PreviewSwitch label={silent ? "Unmute microphone" : "Mute microphone"} on={!silent} disabled={!stream} onClick={() => setMuted(!muted)}>
              {silent ? <MicrophoneMute /> : <Microphone />}
            </PreviewSwitch>
            {camerasAllowed && (
              <PreviewSwitch
                label={camera.stream ? "Turn off camera" : "Turn on camera"}
                on={camera.stream !== null}
                onClick={() => (camera.stream ? camera.turnOff() : void camera.turnOn(rememberedDevice("camera")))}
              >
                {camera.stream ? <VideoCamera /> : <VideoCameraOff />}
              </PreviewSwitch>
            )}
          </div>
        </div>

        {(stream || camera.stream) && (
          <div className="mt-5 grid gap-3.5">
            {stream && (
              <Field id="huddle_microphone" label="Microphone">
                <select id="huddle_microphone" value={microphone} onChange={(event) => chooseMicrophone(event.target.value)} className={SELECT}>
                  {microphones.map(({ deviceId, label }, index) => (
                    <option key={deviceId} value={deviceId}>
                      {label || `Microphone ${index + 1}`}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {stream && devices.speakers.length > 0 && (
              <Field id="huddle_speaker" label="Speaker">
                <select id="huddle_speaker" value={speaker} onChange={(event) => chooseSpeaker(event.target.value)} className={SELECT}>
                  {speakers.map(({ deviceId, label }, index) => (
                    <option key={deviceId} value={deviceId}>
                      {label || `Speaker ${index + 1}`}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {camera.stream && (
              <Field id="huddle_camera" label="Camera">
                <select id="huddle_camera" value={shown} onChange={(event) => chooseCamera(event.target.value)} className={SELECT}>
                  {cameras.map(({ deviceId, label }, index) => (
                    <option key={deviceId} value={deviceId}>
                      {label || `Camera ${index + 1}`}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
        )}
        <p role="status" className="mt-5 leading-[1.65] text-muted-foreground empty:mt-0">
          {stream === undefined ? ASKING_FOR_MICROPHONE : stream === null ? NO_MICROPHONE : null}
        </p>
        {cameraNote && (
          <p role="alert" className={cn("leading-[1.65] text-muted-foreground", stream ? "mt-5" : "mt-2.5")}>
            {cameraNote}
          </p>
        )}

        <div className="mt-[26px] flex justify-end gap-2.5">
          <button type="button" onClick={onClose} className={cn(OTHER_ACTION, ON_ONE_LINE)}>
            Cancel
          </button>
          <button type="button" disabled={stream === undefined} onClick={join} className={cn(MAIN_ACTION, ON_ONE_LINE)}>
            {going ? "Join Huddle" : "Start Huddle"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
