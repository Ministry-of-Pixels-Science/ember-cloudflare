import { MAX_PREVIEW_SIZE } from "@ember/protocol";
import { fileUpTo } from "./file-reading";

// SVGs shown in messages. An SVG is markup that can run script and load from anywhere, but not as an
// image, so a message shows one from a data URL in an <img>, whose origin is opaque if it's opened by
// itself. Uploaded SVGs never go into the page as markup, an <object>, an <iframe> or a blob URL, which
// is this site's own origin.

/**
 * The data URL of the SVG at `url`, of up to 5 MiB, once it has decoded as a picture, or null for an
 * address on another site, a file the site doesn't answer with, a bigger one, or one that doesn't decode.
 */
export async function svgDataUrl(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const file = await fileUpTo(url, MAX_PREVIEW_SIZE, signal);
    if (!file) return null;
    const dataUrl = await asDataUrl(new Blob([file], { type: "image/svg+xml" }));
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    return dataUrl;
  } catch {
    return null;
  }
}

const asDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
