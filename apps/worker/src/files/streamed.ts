import type { Env } from "../env";
import type { Identified } from "./blobs";
import type { ImageSize } from "./images";
import { previewFromImages } from "./previews";
import { identifiedOf, keptAs, UPLOAD_PART_SIZE } from "./uploads";

// Storing a file in R2 as it arrives, where nothing says first how large it is, as a bot's form and a
// webhook's answer bring one: in one put when it all fits in one part of an upload in parts, and
// otherwise in such an upload, a part at a time, as a browser sends a file's parts (uploads.ts), so no
// more than a part is held at once.

/** A file arriving: its name, the type its sender gave it, the most bytes it may be, and what reads its next bytes, or null at its end. */
export interface ArrivingFile {
  filename: string;
  declaredType: string;
  limit: number;
  read: () => Promise<Uint8Array | null>;
}

/**
 * A file R2 has all of: how many bytes it is, what its first bytes said it is, and the size of the
 * preview Cloudflare Images made of it, if it made one.
 */
export interface StreamedFile {
  byteSize: number;
  identified: Identified;
  preview?: ImageSize;
}

/**
 * Has R2 keep `file` at `key`, as it arrives, typed as its first part, its name and its declared type
 * identify it, as a browser's upload is, and named as it's named. Answers how large it was and what it
 * was identified as, or null once it's more than its limit, when it stops reading it and R2 keeps none
 * of it. When reading or storing fails, R2 keeps none of it either, and the error is thrown.
 */
export async function storeArriving(files: R2Bucket, key: string, file: ArrivingFile): Promise<StreamedFile | null> {
  const parts = new Parts(UPLOAD_PART_SIZE);
  const uploaded: R2UploadedPart[] = [];
  let upload: R2MultipartUpload | null = null;
  let identified: Identified | null = null;
  let byteSize = 0;
  try {
    for (let chunk = await file.read(); chunk !== null; chunk = await file.read()) {
      byteSize += chunk.byteLength;
      if (byteSize > file.limit) {
        await upload?.abort().catch(() => {});
        return null;
      }
      for (const part of parts.add(chunk)) {
        if (!upload) {
          identified = identifiedOf(part, file.filename, file.declaredType);
          upload = await files.createMultipartUpload(key, keptAs(identified.contentType, file.filename));
        }
        uploaded.push(await upload.uploadPart(uploaded.length + 1, part));
      }
    }
    const rest = parts.rest();
    if (!upload) {
      identified = identifiedOf(rest, file.filename, file.declaredType);
      await files.put(key, rest, keptAs(identified.contentType, file.filename));
    } else {
      if (rest.byteLength > 0) uploaded.push(await upload.uploadPart(uploaded.length + 1, rest));
      await upload.complete(uploaded);
    }
    return { byteSize, identified: identified! };
  } catch (error) {
    // R2 aborts an upload that's left unfinished a week after it started, should this fail too.
    await upload?.abort().catch(() => {});
    throw error;
  }
}

/**
 * `stored`, the file named `filename` that R2 keeps for upload `key`, with the preview Cloudflare Images
 * makes of it, if its message would show it only by one, since nothing sends a preview of a file that
 * arrives this way (previews.ts).
 */
export async function withPreview(env: Env, files: R2Bucket, key: string, filename: string, stored: StreamedFile): Promise<StreamedFile> {
  const preview = await previewFromImages(env, files, key, { filename, byteSize: stored.byteSize, ...stored.identified });
  return preview ? { ...stored, preview } : stored;
}

/** Gathers chunks of bytes into parts of `size` bytes, as an upload in parts takes them, all but its last. */
class Parts {
  private chunks: Uint8Array[] = [];
  private length = 0;

  constructor(private readonly size: number) {}

  /** Adds `chunk`, answering the parts it completes. */
  add(chunk: Uint8Array): Uint8Array[] {
    this.chunks.push(chunk);
    this.length += chunk.byteLength;
    const full: Uint8Array[] = [];
    while (this.length >= this.size) full.push(this.take(this.size));
    return full;
  }

  /** What's gathered that doesn't make a whole part. */
  rest(): Uint8Array {
    return this.take(this.length);
  }

  /** The first `length` bytes gathered, which are taken. */
  private take(length: number): Uint8Array {
    const part = new Uint8Array(length);
    for (let filled = 0; filled < length; ) {
      const chunk = this.chunks[0]!;
      const used = Math.min(chunk.byteLength, length - filled);
      part.set(chunk.subarray(0, used), filled);
      filled += used;
      if (used === chunk.byteLength) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(used);
    }
    this.length -= length;
    return part;
  }
}
