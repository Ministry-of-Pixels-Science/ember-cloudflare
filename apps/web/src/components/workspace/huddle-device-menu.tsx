import { useEffect, useState, type ReactNode } from "react";
import { NavArrowUp } from "@/components/icons/iconoir";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cameraOf, listDevices, NO_DEVICES, rememberedDevice, speakerChoices, watchDevices, withOpen, type DeviceChoice, type HuddleDevice, type HuddleDevices } from "@/lib/huddle-devices";
import { chooseHuddleDevice, showHuddleCamera, type JoinedHuddle } from "@/lib/huddle-store";

/**
 * A menu of the devices the browser lists. Asked for, it's open once the browser has listed them, so
 * that it opens with them in it, and it lists them again as one is plugged in or taken away. It keeps
 * the last it listed, which it still shows as it closes.
 */
function useDeviceMenu() {
  const [wanted, setWanted] = useState(false);
  const [devices, setDevices] = useState(NO_DEVICES);
  /** Whether the browser has listed them since the menu was asked for. */
  const [listed, setListed] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    let over = false;
    const list = async () => {
      const found = await listDevices();
      if (over) return;
      setDevices(found);
      setListed(true);
    };
    void list();
    const stopWatching = watchDevices(() => void list());
    return () => {
      over = true;
      stopWatching();
      setListed(false);
    };
  }, [wanted]);
  return { devices, open: wanted && listed, setOpen: setWanted };
}

interface ChoicesProps {
  kind: HuddleDevice;
  /** What the devices are called: over them, and one by one where the browser doesn't name them. */
  heading: string;
  choices: DeviceChoice[];
  /** The one the huddle uses now, by its id, which is ticked. */
  chosen: string;
}

/** The devices of one kind to choose among, which the huddle uses from when one is chosen. */
function Choices({ kind, heading, choices, chosen }: ChoicesProps) {
  return (
    <DropdownMenuRadioGroup aria-label={heading} value={chosen} onValueChange={(deviceId) => chooseHuddleDevice(kind, deviceId)}>
      {choices.map(({ deviceId, label }, index) => (
        <DropdownMenuRadioItem key={deviceId} value={deviceId}>
          {label || `${heading} ${index + 1}`}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

interface SectionProps {
  huddle: JoinedHuddle;
  devices: HuddleDevices;
}

/**
 * The microphones to speak through, the one the huddle has ticked. A browser names its microphones
 * only to a page it lets use one, so someone who only listens may have none to choose among, and then
 * it's the browser that's asked for one: the one this browser last chose, or its own choice.
 */
function Microphones({ huddle, devices }: SectionProps) {
  const microphones = huddle.microphone ? withOpen(devices.microphones, huddle.microphoneId) : devices.microphones;
  return (
    <>
      <DropdownMenuLabel>Microphone</DropdownMenuLabel>
      {microphones.length > 0 ? (
        <Choices kind="microphone" heading="Microphone" choices={microphones} chosen={huddle.microphoneId} />
      ) : (
        <DropdownMenuItem onSelect={() => chooseHuddleDevice("microphone", rememberedDevice("microphone") ?? "")}>Use your microphone</DropdownMenuItem>
      )}
    </>
  );
}

/**
 * The speakers to play the huddle through, where the browser can play through one of several, which
 * Safari can't. One that's been unplugged since it was chosen leaves the first ticked, the system's,
 * which the huddle plays through meanwhile.
 */
function Speakers({ huddle, devices }: SectionProps) {
  if (devices.speakers.length === 0) return null;
  const speakers = speakerChoices(devices.speakers);
  const chosen = speakers.find(({ deviceId }) => deviceId === huddle.speakerId) ?? speakers[0]!;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Speaker</DropdownMenuLabel>
      <Choices kind="speaker" heading="Speaker" choices={speakers} chosen={chosen.deviceId} />
    </>
  );
}

/**
 * The cameras to show, the one that's on ticked. Choosing one while the camera's off turns it on. A
 * browser names its cameras only to a page it lets use one, so until then there are none to choose
 * among, and the camera is there to turn on.
 */
function Cameras({ huddle, devices }: SectionProps) {
  const shown = cameraOf(huddle.camera);
  const cameras = huddle.camera ? withOpen(devices.cameras, shown, huddle.camera.getVideoTracks()[0]) : devices.cameras;
  return (
    <>
      <DropdownMenuLabel>Camera</DropdownMenuLabel>
      {cameras.length > 0 ? (
        <Choices kind="camera" heading="Camera" choices={cameras} chosen={shown} />
      ) : (
        <DropdownMenuItem onSelect={() => showHuddleCamera(true)}>Turn on camera</DropdownMenuItem>
      )}
    </>
  );
}

interface MenuProps {
  /** What the arrow is called, and its menu. */
  label: string;
  /** The arrow's look, which is its button's. */
  className: string;
  /** What the menu holds, of the devices the browser lists. */
  children: (devices: HuddleDevices) => ReactNode;
}

/** The arrow beside one of the huddle's buttons, and the menu it opens over the huddle's base, of the devices that button uses. */
function DeviceMenu({ label, className, children }: MenuProps) {
  const { devices, open, setOpen } = useDeviceMenu();
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger title={label} aria-label={label} className={className}>
        <NavArrowUp />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" sideOffset={8} className="max-w-[min(340px,calc(100vw-32px))] min-w-[220px]">
        {children(devices)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface Props {
  huddle: JoinedHuddle;
  className: string;
}

/** The arrow beside the huddle's microphone, whose menu chooses the microphone it speaks through and the speaker it plays through. */
export function MicrophoneMenu({ huddle, className }: Props) {
  return (
    <DeviceMenu label="Microphone and speaker" className={className}>
      {(devices) => (
        <>
          <Microphones huddle={huddle} devices={devices} />
          <Speakers huddle={huddle} devices={devices} />
        </>
      )}
    </DeviceMenu>
  );
}

/** The arrow beside the huddle's camera, whose menu chooses the camera it shows. */
export function CameraMenu({ huddle, className }: Props) {
  return <DeviceMenu label="Camera" className={className}>{(devices) => <Cameras huddle={huddle} devices={devices} />}</DeviceMenu>;
}
