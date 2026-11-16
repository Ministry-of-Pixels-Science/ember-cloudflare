// Request bodies, read no further than a limit. Cloudflare takes a body of up to 100 MB, 200 MB on its
// Business plan, and `request.json()` holds all of it and parses it before a route checks a single
// field, so JSON bodies are read through `jsonBodyOf` instead.

/**
 * The most a JSON body may hold, more than any the app sends: the largest is custom CSS, whose 100,000
 * characters JSON writes in about 600 KB at most.
 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

/** Why a JSON body larger than `MAX_JSON_BODY_BYTES` is refused, with 413. */
export const BODY_TOO_LARGE = "A request's body can be at most 1 MiB";

/** Thrown for a JSON body larger than `MAX_JSON_BODY_BYTES`, which the Worker answers 413. */
export class BodyTooLarge extends Error {}

/**
 * The body of a request, or of a response, or null if it holds more than `max` bytes: at once when its
 * Content-Length says so, or as soon as that many have arrived, which it stops reading at.
 */
export async function bytesUpTo(request: Request | Response, max: number): Promise<ArrayBuffer | null> {
  if (Number(request.headers.get("Content-Length")) > max) return null;
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    length += read.value.byteLength;
    if (length > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(read.value);
  }
  return new Blob(chunks).arrayBuffer();
}

/** The same, as UTF-8, with invalid bytes replaced. */
export async function bodyUpTo(request: Request | Response, max: number): Promise<string | null> {
  const bytes = await bytesUpTo(request, max);
  return bytes && new TextDecoder().decode(bytes);
}

/**
 * The JSON value the request's body holds, or null if it holds none or can't be read, as
 * `request.json().catch(() => null)` has it, though only up to `MAX_JSON_BODY_BYTES`: a larger body
 * throws `BodyTooLarge`.
 */
export async function jsonBodyOf(request: Request): Promise<unknown> {
  const text = await bodyUpTo(request, MAX_JSON_BODY_BYTES).catch(() => "");
  if (text === null) throw new BodyTooLarge(BODY_TOO_LARGE);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
