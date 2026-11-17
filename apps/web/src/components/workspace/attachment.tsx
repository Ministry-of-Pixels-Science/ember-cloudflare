import { isPreviewableSize, isWebImage, MAX_PREVIEW_SIZE, PREVIEW_MAX_HEIGHT, PREVIEW_MAX_WIDTH, type StoredFile } from "@ember/protocol";
import { useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Lightbox } from "@/components/lightbox";
import type { Size } from "@/lib/previews";
import { svgDataUrl } from "@/lib/svg-preview";
import { fileText, languageOf, showsText } from "@/lib/text-preview";
import { cn } from "@/lib/utils";
import { Code } from "./code-block";
import { FileCard } from "./file-card";

/** How much of a file's text shows before the rest folds behind Show more, as a bot's card folds its text. */
const FOLD_CHARACTERS = 700;
const FOLD_LINES = 5;

/**
 * Folded, a file's text is five lines tall within its padding and border. The line after them would show cut in
 * half through the bottom padding, so a strip of the box's background stays stuck over it, 1em down, since a
 * sticky offset counts from inside the padding.
 */
const FOLDED = "max-h-[calc(5lh+2em+2px)] overflow-y-hidden after:sticky after:-bottom-[1em] after:block after:h-[1em] after:bg-background";

/**
 * A file message's file:
 * an SVG of up to 5 MiB shows above its card, a video plays in place, a text file of up to 64 KiB, as a
 * snippet is, shows its text above its card, a picture shows its thumbnail, or without one, as a bot's has
 * none, itself if it's a picture every browser shows of up to 5 MiB and 250 megapixels, and every other
 * file shows its card.
 */
export function Attachment({ file }: { file: StoredFile }) {
  if (file.contentType === "image/svg+xml" && file.byteSize <= MAX_PREVIEW_SIZE) return <SvgPreview file={file} />;
  if (file.contentType.startsWith("video")) return <VideoPreview file={file} />;
  if (showsText(file)) return <TextPreview file={file} />;
  const picture = file.previewUrl ?? (showsItself(file) && file.byteSize <= MAX_PREVIEW_SIZE ? file.url : null);
  return picture ? <PicturePreview file={file} src={picture} /> : <FileCard file={file} />;
}

/**
 * Whether a message may show `file` itself rather than only its thumbnail: a picture every browser shows,
 * whose size is known and at most 250 megapixels, as a small file can hold a picture far too large to
 * decode.
 */
const showsItself = (file: StoredFile) => isWebImage(file.contentType) && isPreviewableSize(file);

/** The size a message shows a file at: its own, scaled down to fit 1200×800. */
function shownSize({ width, height }: StoredFile): Size | null {
  if (!width || !height) return null;
  const scale = Math.min(1, PREVIEW_MAX_WIDTH / width, PREVIEW_MAX_HEIGHT / height);
  return { width: width * scale, height: height * scale };
}

/**
 * A picture, lazily loaded, which links to its file and opens it in the image viewer, with Download and
 * Share taking the file's download address. A picture not every browser shows, such as a HEIC or TIFF,
 * opens as its thumbnail, since Chrome can't show the original, and so does one over 250 megapixels,
 * which only a message posted before Ember kept to that limit has a thumbnail of. The picture is at most
 * 480px wide and 640px or 70% of the screen tall, in a box that keeps to those limits, so the box is
 * always the picture's shape. The picture's alt text is the file's name. The viewer is only there while
 * it's open, so a timeline of pictures holds no viewer for each.
 */
function PicturePreview({ file, src }: { file: StoredFile; src: string }) {
  const [viewing, setViewing] = useState(false);
  const size = shownSize(file);
  const box: CSSProperties | undefined = size
    ? { width: `min(${size.width / 2}px, 480px, ${size.width / size.height} * 70dvh)`, aspectRatio: `${size.width} / ${size.height}` }
    : undefined;
  return (
    <>
      <a
        href={file.url}
        onClick={(event) => {
          // A click with a modifier key or another button is the browser's, opening the file elsewhere.
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          setViewing(true);
        }}
        className={cn("block max-w-full", !size && "w-fit max-w-[min(480px,100%)]")}
        style={box}
      >
        <img
          src={src}
          alt={file.name}
          loading="lazy"
          className={cn("block cursor-zoom-in rounded-[10px] border object-contain object-left-top", size ? "size-full" : "max-h-[min(640px,70dvh)] max-w-full")}
        />
      </a>
      {viewing && (
        <Lightbox src={showsItself(file) ? file.url : src} alt={file.name} downloadUrl={file.downloadUrl} onClose={() => setViewing(false)} />
      )}
    </>
  );
}

/**
 * A video, which plays in place in a box half its size. Behind its poster it loads nothing until it's
 * played; without one, as when its uploader's browser couldn't play it, it loads enough to draw its first
 * frame. It's named for its file.
 */
function VideoPreview({ file }: { file: StoredFile }) {
  const size = shownSize(file);
  return (
    <div className="flex max-w-full overflow-clip" style={size ? { width: size.width / 2, aspectRatio: `${size.width} / ${size.height}` } : undefined}>
      <video
        src={file.url}
        poster={file.previewUrl}
        controls
        preload={file.previewUrl ? "none" : "metadata"}
        aria-label={file.name}
        className="size-full rounded-[10px] border"
      />
    </div>
  );
}

/**
 * An SVG, which shows above its card once it's within 200px of the timeline's view: from a data URL
 * (lib/svg-preview.ts), and only once it's decoded, so one that's too big, broken or not an SVG leaves the
 * card alone. Its alt text is the file's name.
 */
function SvgPreview({ file }: { file: StoredFile }) {
  const element = useRef<HTMLDivElement>(null);
  const src = useLoadedNearView(element, file.downloadUrl, svgDataUrl);
  return (
    <div ref={element} className="max-w-full">
      {src && <img src={src} alt={file.name} className="mb-2.5 block max-h-[400px] max-w-[min(100%,600px)] rounded-[10px] border object-contain object-left-top" />}
      <FileCard file={file} />
    </div>
  );
}

/**
 * A text file of up to 64 KiB, as a snippet is, which shows its text above its card once it's within 200px
 * of the timeline's view: as a message shows a code block, with Copy code, which copies the text as the file
 * has it, and highlighted where the file's name ends in the extension of a language a code block knows. Past 5 lines or 700 characters, the text
 * folds behind Show more, as a bot's card folds its text. A file whose bytes turn out not to be text, or to
 * be only spaces, keeps its card alone.
 */
function TextPreview({ file }: { file: StoredFile }) {
  const element = useRef<HTMLDivElement>(null);
  const text = useLoadedNearView(element, file.downloadUrl, fileText);
  const [open, setOpen] = useState(false);
  const textId = useId();
  const shown = text?.trim() ? text.replace(/\r\n?/g, "\n").replace(/\n$/, "") : null;
  const long = shown !== null && (shown.length > FOLD_CHARACTERS || shown.split("\n").length > FOLD_LINES);
  const language = languageOf(file.name);
  return (
    <div ref={element} className="max-w-full">
      {shown !== null && (
        <>
          <div className="message-content">
            <Code
              id={textId}
              code={shown}
              copied={text ?? undefined}
              language={language}
              plain={language === undefined}
              className={cn(long && (open ? "max-h-[min(640px,70dvh)] overflow-y-auto" : FOLDED))}
            >
              {shown}
            </Code>
          </div>
          {long && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={textId}
              onClick={() => {
                // Folded again, it shows its first lines, however far it was scrolled while open.
                if (open) element.current!.querySelector("pre")!.scrollTop = 0;
                setOpen(!open);
              }}
              className="block cursor-pointer text-sm font-medium text-link hover:underline touch:min-h-11"
            >
              {open ? "Show less" : "Show more"}
            </button>
          )}
        </>
      )}
      <FileCard file={file} />
    </div>
  );
}

/**
 * What `load` finds at `url`, once `element` is within 200px of the timeline's view, or null until then,
 * and where it finds nothing. It stops watching, or loading, when `element` goes.
 */
function useLoadedNearView<Found>(element: RefObject<HTMLElement | null>, url: string, load: (url: string, signal: AbortSignal) => Promise<Found | null>): Found | null {
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void load(url, abort.signal).then((loaded) => {
          if (!abort.signal.aborted) setFound(loaded);
        });
      },
      { root: scrollerOf(element.current!), rootMargin: "200px" },
    );
    observer.observe(element.current!);
    return () => {
      observer.disconnect();
      abort.abort();
    };
  }, [element, url, load]);
  return found;
}

/** The nearest of `element`'s ancestors that scrolls, as the timeline does, or null for the page. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(ancestor).overflowY)) return ancestor;
  }
  return null;
}
