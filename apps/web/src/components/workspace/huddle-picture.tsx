import { useEffect, useRef } from "react";
import { TOUCHES } from "@/lib/huddle-speaker";
import { cn } from "@/lib/utils";

interface Props {
  stream: MediaStream;
  /** Whose camera it is, for screen readers. */
  label: string;
  /** Whether it shows as a mirror would, as someone's own camera does to them. */
  mirrored?: boolean;
}

/**
 * A camera's picture, live, filling what it's placed in. It plays without sound, as its person's voice
 * comes through the huddle's own speaker, and so by itself, but in a browser that keeps any video from
 * that, where it plays at the person's next click or key.
 */
export function HuddlePicture({ stream, label, mirrored = false }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    const play = () => {
      if (element.paused) void element.play().catch(() => {});
    };
    // In the capture phase, which hears a click that whatever it lands on keeps to itself.
    for (const touch of TOUCHES) document.addEventListener(touch, play, true);
    return () => {
      for (const touch of TOUCHES) document.removeEventListener(touch, play, true);
      element.srcObject = null;
    };
  }, [stream]);
  return <video ref={video} aria-label={label} muted autoPlay playsInline className={cn("absolute inset-0 size-full object-cover", mirrored && "-scale-x-100")} />;
}
