import { useEffect, useEffectEvent, useRef } from "react";
import { TOUCHES } from "@/lib/huddle-speaker";
import { cn } from "@/lib/utils";
import { whenShownAgain } from "@/lib/visibility";

/** What a video says once the browser knows its picture's size, from its first frame, and when a later frame's is another. */
const SIZED = ["loadedmetadata", "resize"];

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
 * while the page is hidden, so it plays again as the page shows again.
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
    element.srcObject = stream;
    const play = () => {
      if (element.paused) void element.play().catch(() => {});
    };
    // In the capture phase, which hears a click that whatever it lands on keeps to itself.
    for (const touch of TOUCHES) document.addEventListener(touch, play, true);
    const stopWatchingPage = whenShownAgain(play);
    for (const sized of SIZED) element.addEventListener(sized, shaped);
    return () => {
      for (const touch of TOUCHES) document.removeEventListener(touch, play, true);
      stopWatchingPage();
      for (const sized of SIZED) element.removeEventListener(sized, shaped);
      element.srcObject = null;
    };
  }, [stream]);
  return <video ref={video} aria-label={label} muted autoPlay playsInline className={cn("absolute inset-0 size-full", whole ? "object-contain" : "object-cover", mirrored && "-scale-x-100")} />;
}
