import { AVATAR_BOX, isPreviewableSize, isPreviewed, isVariable, LOGO_BOXES, PREVIEW_MAX_HEIGHT, PREVIEW_MAX_WIDTH } from "@ember/protocol";

// Previews of files, which the uploader's browser makes and the app sends before a file's last part, where
// Campfire makes them on the server: a picture's thumbnail, as its `:thumb` variant resizes it to fit
// 1200×800, and a video's poster, which Campfire's ffmpeg takes from its first frame and Ember from a
// tenth of a second in, past the blank frame some browsers draw at the start. Both are still, so an
// animated picture's is its first frame. An avatar's variant is made as a picture's thumbnail is, to fit
// 512×512, as Campfire's `:square` variant resizes it, and a logo's two as PNGs within 512×512 and
// 192×192, as its logo's `:large` and `:small` variants are. None is made of a picture or video over 250
// megapixels, which isn't decoded, as Campfire makes none (`THUMBNAIL_MAX_PIXELS`). The Worker has
// Cloudflare Images make the thumbnail of a picture that came without one, where the message would
// otherwise show it as a file (apps/worker/src/files/previews.ts).

/** A picture's or video's width and height, in pixels. */
export interface Size {
  width: number;
  height: number;
}

/** How long a preview or a variant may take, after which the file goes without one. */
const PREVIEW_TIMEOUT = 5_000;

/** The quality previews are encoded at, from 0 to 1. */
const QUALITY = 0.85;

/** How far into a video its poster is taken from, in seconds, or halfway through a shorter one. */
const POSTER_TIME = 0.1;

/** The box a preview fits within, as Active Storage's `:thumb` variant. */
const PREVIEW_LIMIT: Size = { width: PREVIEW_MAX_WIDTH, height: PREVIEW_MAX_HEIGHT };

/** The box an avatar's variant fits within. */
const AVATAR_LIMIT: Size = { width: AVATAR_BOX, height: AVATAR_BOX };

/** A logo's variants, which fit within 512×512 and 192×192. */
export interface LogoVariants {
  large: Blob;
  small: Blob;
}

/** `width` by `height` scaled down, never up, to fit `limit`, 1200×800 unless it's given, as `resize_to_limit` scales a picture. */
export function fitted({ width, height }: Size, limit = PREVIEW_LIMIT): Size {
  const scale = Math.min(1, limit.width / width, limit.height / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The preview of `file` that the app sends with it: a picture's thumbnail or a video's poster within
 * 1200×800, or null for any other file, and where this browser can't decode it, as Chrome can't decode
 * HEIC or TIFF, or doesn't within five seconds, when it stops making it.
 */
export async function previewOf(file: File): Promise<Blob | null> {
  if (!isPreviewed(file.type)) return null;
  return madeOf(file, (url, signal) =>
    file.type.startsWith("video") ? posterOf(url, signal) : thumbnailOf(url, file.type !== "image/jpeg", PREVIEW_LIMIT, signal),
  );
}

/**
 * The variant of `file` that the app sends with it as someone's avatar: the picture within 512×512, or
 * null for a file Campfire doesn't resize, and where this browser can't decode it or doesn't within five
 * seconds, as for a preview.
 */
export async function avatarVariantOf(file: File): Promise<Blob | null> {
  if (!isVariable(file.type)) return null;
  return madeOf(file, (url, signal) => thumbnailOf(url, file.type !== "image/jpeg", AVATAR_LIMIT, signal));
}

/**
 * The variants of `file` that the app sends with it as the workspace's logo, PNGs within 512×512 and
 * 192×192, or null as for an avatar's variant.
 */
export async function logoVariantsOf(file: File): Promise<LogoVariants | null> {
  if (!isVariable(file.type)) return null;
  return madeOf(file, async (url, signal) => {
    const picture = await pictureAt(url, signal);
    const pngWithin = (box: number) => pngOf(picture, fitted(sizeOf(picture), { width: box, height: box }));
    const [large, small] = await Promise.all([pngWithin(LOGO_BOXES.large), pngWithin(LOGO_BOXES.small)]);
    return large && small && { large, small };
  });
}

/**
 * What `make` makes of `file` from its address, or null if it fails, or doesn't within five seconds, when
 * `signal` aborts so it stops. The address is let go of either way.
 */
async function madeOf<T>(file: File, make: (url: string, signal: AbortSignal) => Promise<T | null>): Promise<T | null> {
  const url = URL.createObjectURL(file);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), PREVIEW_TIMEOUT);
  try {
    // Encoding can't be stopped, so it's given up on while it's under way too.
    return await Promise.race([make(url, timeout.signal), abortOf(timeout.signal)]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
  }
}

/**
 * The picture at `url` scaled to fit `limit`, which may be see-through unless it's a JPEG, unless
 * `signal` aborts before it decodes.
 */
async function thumbnailOf(url: string, seeThrough: boolean, limit: Size, signal: AbortSignal): Promise<Blob | null> {
  const picture = await pictureAt(url, signal);
  return encoded(picture, fitted(sizeOf(picture), limit), seeThrough);
}

/** The picture at `url`, once it has decoded, unless `signal` aborts first, or it's over 250 megapixels, when it isn't decoded. */
async function pictureAt(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  const picture = new Image();
  const loaded = nextEvent(picture, "load", signal);
  picture.src = url;
  // Its size is known once it has loaded, before it's decoded.
  await loaded;
  if (!isPreviewableSize(sizeOf(picture))) throw new RangeError("The picture is over 250 megapixels");
  await Promise.race([picture.decode(), abortOf(signal)]);
  return picture;
}

const sizeOf = (picture: HTMLImageElement): Size => ({ width: picture.naturalWidth, height: picture.naturalHeight });

/**
 * The poster of the video at `url`, or null for one with no picture, such as a recording of sound alone,
 * or one over 250 megapixels, which it seeks no frame of, unless `signal` aborts before it has loaded and
 * sought, when it lets go of the video at once.
 */
async function posterOf(url: string, signal: AbortSignal): Promise<Blob | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    video.src = url;
    await nextEvent(video, "loadedmetadata", signal);
    const size = { width: video.videoWidth, height: video.videoHeight };
    if (!isPreviewableSize(size)) return null;
    video.currentTime = Number.isFinite(video.duration) ? Math.min(POSTER_TIME, video.duration / 2) : POSTER_TIME;
    await nextEvent(video, "seeked", signal);
    return await encoded(video, fitted(size), false);
  } finally {
    // Lets go of the decoder.
    video.removeAttribute("src");
    video.load();
  }
}

/** Resolves on `element`'s next `type` event, or rejects on its next error, or once `signal` aborts. */
const nextEvent = (element: HTMLMediaElement | HTMLImageElement, type: string, signal: AbortSignal) =>
  Promise.race([
    new Promise<void>((resolve, reject) => {
      element.addEventListener(type, () => resolve(), { once: true, signal });
      element.addEventListener("error", (event) => reject(event), { once: true, signal });
    }),
    abortOf(signal),
  ]);

/** Rejects once `signal` aborts, or at once if it has. */
const abortOf = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/**
 * `source` drawn `width` by `height` and encoded as WebP, or where this browser can't encode WebP, as
 * Safari can't, as a PNG if it may be see-through, which a JPEG can't be, and a JPEG if not.
 */
async function encoded(source: CanvasImageSource, size: Size, seeThrough: boolean): Promise<Blob | null> {
  const canvas = drawn(source, size);
  if (!canvas) return null;
  // A browser that can't encode a type encodes a PNG instead.
  const webp = await blobOf(canvas, "image/webp");
  return webp?.type === "image/webp" || seeThrough ? webp : blobOf(canvas, "image/jpeg");
}

/** `source` drawn at `size` and encoded as a PNG. */
async function pngOf(source: CanvasImageSource, size: Size): Promise<Blob | null> {
  const canvas = drawn(source, size);
  return canvas && blobOf(canvas, "image/png");
}

/** A canvas with `source` drawn on it `width` by `height`, or null where this browser can't draw. */
function drawn(source: CanvasImageSource, { width, height }: Size): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

const blobOf = (canvas: HTMLCanvasElement, type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, QUALITY));
