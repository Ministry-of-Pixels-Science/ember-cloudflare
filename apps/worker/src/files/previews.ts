import { isPreviewableSize, isWebImage, MAX_PREVIEW_SIZE, PREVIEW_MAX_HEIGHT, PREVIEW_MAX_WIDTH } from "@ember/protocol";
import type { Env } from "../env";
import { objectKey, previewKey, type Identified } from "./blobs";
import { extname } from "./filename";
import { imageSize, type ImageSize } from "./images";
import { byMagic } from "./marcel";

// A file's preview, an image's thumbnail or a video's poster, which its message shows in its place. The
// uploader's browser makes it as it uploads the file (apps/web/src/lib/previews.ts) and sends it before
// the last part (uploads.ts). Where none came, from a browser that couldn't read the picture in time or a
// bot, a message shows a picture by itself only if every browser shows it and it's at most 5 MiB, so the
// Worker has Cloudflare Images make the preview of a picture that wouldn't show otherwise.

/**
 * The types a preview can be, by its bytes, with the extension each gives its name: the formats Active
 * Storage writes thumbnails and posters in that every browser shows (`ActiveStorage::Blob#default_variant_format`).
 */
const PREVIEW_EXTENSIONS = new Map([
  ["image/webp", "webp"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
]);

/** Whether a preview can be of `contentType`. */
export const isPreviewType = (contentType: string) => PREVIEW_EXTENSIONS.has(contentType);

/** What the preview of a file named `name` is called, as Active Storage names a variant: the file's name with its type's extension. */
const previewName = (name: string, contentType: string) => `${name.slice(0, name.length - extname(name).length)}.${PREVIEW_EXTENSIONS.get(contentType)}`;

/** Has R2 keep `bytes`, an image of `contentType`, as the preview of file `key`, which is named `filename`. */
export async function keepPreview(files: R2Bucket, key: string, filename: string, bytes: Uint8Array, contentType: string): Promise<void> {
  await files.put(previewKey(key), bytes, { httpMetadata: { contentType }, customMetadata: { filename: previewName(filename, contentType) } });
}

/**
 * The pictures Ember previews that Cloudflare Images reads (https://developers.cloudflare.com/images/get-started/limits/):
 * all but TIFF, and AVIF, which it reads only on an Enterprise plan.
 */
const READ_BY_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"]);

/** The most bytes the Images binding reads of a picture. */
const MAX_IMAGES_INPUT_SIZE = 20_000_000;

/** The most pixels a picture Cloudflare Images transforms has, and the most it has a side. */
const MAX_IMAGES_INPUT_PIXELS = 100_000_000;
const MAX_IMAGES_INPUT_SIDE = 12_000;

/** A file R2 has all of: its name, how many bytes it is, and what its first bytes said it is. */
export interface WholeFile extends Identified {
  filename: string;
  byteSize: number;
}

/**
 * Whether a message would show `file`, a picture of a size it knows, only by a preview Cloudflare Images
 * can make of it: it isn't one every browser shows, or it's larger than a message shows in its place.
 */
function wantsPreviewFromImages({ contentType, metadata, byteSize }: WholeFile): boolean {
  const { width, height } = JSON.parse(metadata) as Partial<ImageSize>;
  if (!READ_BY_IMAGES.has(contentType) || !isPreviewableSize({ width, height })) return false;
  if (isWebImage(contentType) && byteSize <= MAX_PREVIEW_SIZE) return false;
  return byteSize <= MAX_IMAGES_INPUT_SIZE && width! * height! <= MAX_IMAGES_INPUT_PIXELS && Math.max(width!, height!) <= MAX_IMAGES_INPUT_SIDE;
}

/**
 * Has Cloudflare Images make the preview of `file`, which R2 has all of at `key`, if its message would
 * show it only by one, as a WebP within 1200×800, and R2 keep it as `key`'s preview. Answers its size, or
 * null when the Worker has no Images binding, the picture is more than Images reads, or Images fails, as
 * once the account's free transformations for the month are used up.
 */
export async function previewFromImages(env: Env, files: R2Bucket, key: string, file: WholeFile): Promise<ImageSize | null> {
  const images = env.IMAGES;
  if (!images || !wantsPreviewFromImages(file)) return null;
  try {
    const picture = await files.get(objectKey(key));
    if (!picture) return null;
    const made = await images
      .input(picture.body)
      .transform({ width: PREVIEW_MAX_WIDTH, height: PREVIEW_MAX_HEIGHT, fit: "scale-down" })
      .output({ format: "image/webp", anim: false });
    const bytes = new Uint8Array(await new Response(made.image()).arrayBuffer());
    const size = byMagic(bytes) === "image/webp" ? imageSize(bytes, "image/webp") : null;
    if (!size || size.width > PREVIEW_MAX_WIDTH || size.height > PREVIEW_MAX_HEIGHT || bytes.byteLength > MAX_PREVIEW_SIZE) {
      throw new Error(`it made ${bytes.byteLength} bytes of ${made.contentType()}`);
    }
    await keepPreview(files, key, file.filename, bytes, "image/webp");
    return size;
  } catch (error) {
    console.warn(`Cloudflare Images didn't preview file ${key}:`, error instanceof Error ? error.message : error);
    return null;
  }
}
