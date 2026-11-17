// Files a message reads from this site to show what's in them, as an SVG's picture or a text file's text.

/**
 * The file at `url`, of up to `max` bytes, or null for an address on another site, a file the site doesn't
 * answer with, or a bigger one, which it stops reading at the byte past `max`.
 */
export async function fileUpTo(url: string, max: number, signal: AbortSignal): Promise<Blob | null> {
  const address = new URL(url, location.href);
  if (address.origin !== location.origin) return null;
  const response = await fetch(address, { signal, credentials: "same-origin" });
  if (!response.ok || !response.body || Number(response.headers.get("Content-Length")) > max) {
    await response.body?.cancel();
    return null;
  }
  const chunks = await readUpTo(response.body, max);
  return chunks && new Blob(chunks);
}

/** What `body` has, or null if it has more than `max` bytes, when it stops reading. */
async function readUpTo(body: ReadableStream<Uint8Array<ArrayBuffer>>, max: number): Promise<Uint8Array<ArrayBuffer>[] | null> {
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      length += read.value.byteLength;
      if (length > max) return null;
      chunks.push(read.value);
    }
    return chunks;
  } finally {
    await reader.cancel();
  }
}
