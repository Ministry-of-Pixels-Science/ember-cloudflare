import { useEffect, useEffectEvent, useRef } from "react";
import { TOUCHES } from "@/lib/huddle-speaker";
import { cn } from "@/lib/utils";
import { whenShownAgain } from "@/lib/visibility";

/** What a video says once the browser knows its picture's size, from its first frame, and when a later frame's is another. */
const SIZED = ["loadedmetadata", "resize"];

/** How long a picture has to show something of the stream it's given before it's given it again, and how often it is at most. */
const SHOWS_WITHIN_MS = 3000;
const GIVEN_AGAIN_AT_MOST = 3;

interface Props {
  stream: MediaStream;
  /** Whose camera or screen it is, for screen readers. */
  label: string;
  /** Whether it shows as a mirror would, as someone's own camera does to them. */
  mirrored?: boolean;
  /** Whether it shows whole, with space around it where its shape isn't its place's, as a shared screen does, rather than filling its place. */
  whole?: boolean;
  /** Hears the picture's shape, its width over its height, once the browser knows it and whenever it changes, as when a window that's shared is resized. */
  onShape?: (shape: number) => void;
}

/**
 * A camera's picture, or a shared screen's, live, in what it's placed in. It plays without sound, as its
 * person's voice comes through the huddle's own speaker, and so by itself, but in a browser that keeps
 * any video from that, where it plays at the person's next click or key. A phone's browser can stop it
 * while the page is hidden, so it plays again as the page shows again. It's given its stream once the
 * stream's first packets have come, as WebKit, given one before then, can show nothing of it. WebKit can
 * also show nothing of one it's given in time, or stop one it played with an error, and plays it once
 * it's given the stream again: so a picture that shows nothing for some seconds is, as is one that fails.
 */
export function HuddlePicture({ stream, label, mirrored = false, whole = false, onShape }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const shaped = useEffectEvent(() => {
    const { videoWidth = 0, videoHeight = 0 } = video.current ?? {};
    if (videoWidth > 0 && videoHeight > 0) onShape?.(videoWidth / videoHeight);
  });
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const waiting = stream.getVideoTracks().find((track) => track.muted);
    let givenAgain = 0;
    let late: ReturnType<typeof setTimeout> | undefined;
    const attach = () => {
      element.srcObject = stream;
      late = setTimeout(giveAgain, SHOWS_WITHIN_MS);
    };
    const giveAgain = () => {
      clearTimeout(late);
      if (givenAgain === GIVEN_AGAIN_AT_MOST) return;
      givenAgain += 1;
      element.srcObject = null;
      attach();
    };
    const shows = () => clearTimeout(late);
    if (waiting) waiting.addEventListener("unmute", attach, { once: true });
    else attach();
    const play = () => {
      if (element.paused) void element.play().catch(() => {});
    };
    // In the capture phase, which hears a click that whatever it lands on keeps to itself.
    for (const touch of TOUCHES) document.addEventListener(touch, play, true);
    const stopWatchingPage = whenShownAgain(play);
    for (const sized of SIZED) element.addEventListener(sized, shaped);
    element.addEventListener("loadedmetadata", shows);
    element.addEventListener("error", giveAgain);
    return () => {
      clearTimeout(late);
      waiting?.removeEventListener("unmute", attach);
      for (const touch of TOUCHES) document.removeEventListener(touch, play, true);
      stopWatchingPage();
      for (const sized of SIZED) element.removeEventListener(sized, shaped);
      element.removeEventListener("loadedmetadata", shows);
      element.removeEventListener("error", giveAgain);
      element.srcObject = null;
    };
  }, [stream]);
  return <video ref={video} aria-label={label} muted autoPlay playsInline className={cn("absolute inset-0 size-full", whole ? "object-contain" : "object-cover", mirrored && "-scale-x-100")} />;
}
