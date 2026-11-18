import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Download, ShareAndroid, Xmark } from "@/components/icons/iconoir";
import { ShareButton } from "@/components/share-button";
import { canShare } from "@/lib/share";
import { cn } from "@/lib/utils";

// The image viewer, opened and cleared as Campfire's lightbox_controller.js does and styled by its
// lightbox.css. It keeps its buttons clear of a phone's notch, rounded corners and home indicator, which
// lightbox.css doesn't, Download saves even a file that isn't served as an attachment, such as a QR
// code, and the image can be named for screen readers.

/** A circle `.btn` in a corner: 36px, and 44px for fingers. */
const BUTTON = "grid size-9 cursor-pointer place-items-center rounded-full border bg-background [grid-area:1/1] touch:size-11";

interface LightboxProps {
  /** The image to show, or null while the viewer is closed. */
  src: string | null;
  /** What the image is, for screen readers. */
  alt?: string;
  /** Where Download and Share get its file, as a message's picture gives its file's download address: the image itself if not given. */
  downloadUrl?: string;
  /** The name Download saves it under, where the server doesn't name it. */
  filename?: string;
  /** Called when Escape or Close has closed the viewer. */
  onClose: () => void;
}

/**
 * Shows `src` over the blurred page, with its file to download and, where the browser can, to share.
 * It's rendered into the body, so it takes the page's text size wherever it's opened from.
 */
export function Lightbox({ src, alt = "", downloadUrl = src ?? undefined, filename, onClose }: LightboxProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (src && !dialog.current?.open) dialog.current?.showModal();
  }, [src]);

  return createPortal(
    <dialog
      ref={dialog}
      aria-label="Image Viewer (Press escape to close)"
      onClose={onClose}
      className="inset-0 m-auto h-dvh max-h-none w-dvw max-w-none overflow-hidden bg-lightbox pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1ch,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1ch,env(safe-area-inset-left))] backdrop:backdrop-blur-[66px] open:grid open:grid-cols-1 open:grid-rows-1 open:place-items-center"
    >
      {src && <img src={src} alt={alt} className="max-h-full max-w-full [grid-area:1/1]" />}
      <button type="button" onClick={() => dialog.current?.close()} className={cn(BUTTON, "self-start justify-self-end")}>
        <Xmark className="size-[1.3em]" />
        <span className="sr-only">Close image viewer</span>
      </button>
      <a href={downloadUrl} download={filename ?? true} className={cn(BUTTON, "self-end justify-self-end ios-pwa:hidden")}>
        <Download className="size-[1.3em]" />
        <span className="sr-only">Download file</span>
      </a>
      {canShare() && downloadUrl && (
        <ShareButton url={downloadUrl} className={cn(BUTTON, "self-start justify-self-start")}>
          <ShareAndroid className="size-[1.3em]" />
          <span className="sr-only">Share file</span>
        </ShareButton>
      )}
    </dialog>,
    document.body,
  );
}

