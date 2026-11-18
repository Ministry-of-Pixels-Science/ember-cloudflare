import {
  FILE_TOO_LARGE,
  MAX_PREVIEW_SIZE,
  parseNewUpload,
  PREVIEW_MAX_HEIGHT,
  PREVIEW_MAX_WIDTH,
  type Message,
  type RoomId,
  type Upload,
  type User,
} from "@ember/protocol";
import { credentialsOf } from "../auth";
import { jsonBodyOf } from "../bodies";
import type { Env } from "../env";
import { addressTag, sessionTag, taggedAddress } from "../revocations";
import { workspace, type Credentials } from "../workspace";
import { objectKey, previewKey, type Identified, type RoomBlob } from "./blobs";
import { sanitizedFilename } from "./filename";
import { imageSize } from "./images";
import { byMagic, identify } from "./marcel";
import { isPreviewType, keepPreview, previewFromImages } from "./previews";

// Uploading files to a room into R2, in parts, since a Worker takes at most 100 MB a request. The room
// keeps each upload (blobs.ts), and the first part says what the file is, as Active Storage identifies a
// blob, then analyzes it, once it has it all. Once R2 has all of it, the room posts it as its uploader's
// message. R2 keeps the file with its type and name, so serving it (serving.ts) needs nothing else.
// Before the last part, the uploader's browser may send the file's preview, an image's thumbnail or a
// video's poster, and the message shows it. Where it sends none of a picture the message would otherwise
// show as a file, Cloudflare Images makes one (previews.ts).

/** How much of a file each part but the last carries: more than R2's least, 5 MiB, and few enough parts for the largest file. */
export const UPLOAD_PART_SIZE = 10 * 1024 * 1024;

/** How many parts a file of `size` bytes goes in: at least one, for an empty file. */
export const uploadParts = (size: number) => Math.max(1, Math.ceil(size / UPLOAD_PART_SIZE));

/** How many bytes part `n`, from 1, of a file of `size` bytes carries. */
export const partLength = (size: number, n: number) => Math.min(UPLOAD_PART_SIZE, size - (n - 1) * UPLOAD_PART_SIZE);

/**
 * Active Storage's metadata for a file of type `contentType` whose first bytes are `bytes`, as it writes
 * it once it has identified and analyzed the file: an image's width and height, where they can be read.
 */
export const metadataOf = (bytes: Uint8Array, contentType: string) => JSON.stringify({ identified: true, ...imageSize(bytes, contentType), analyzed: true });

/**
 * What a file named `filename`, of `declaredType` as its sender says, whose first bytes are `bytes`, is,
 * as Active Storage identifies an upload, then analyzes it: its type and metadata.
 */
export function identifiedOf(bytes: Uint8Array, filename: string, declaredType: string): Identified {
  const contentType = identify(bytes, sanitizedFilename(filename), declaredType);
  return { contentType, metadata: metadataOf(bytes, contentType) };
}

/** How R2 keeps a file named `filename` of type `contentType`: with both, so serving it needs nothing else. */
export const keptAs = (contentType: string, filename: string) => ({ httpMetadata: { contentType }, customMetadata: { filename } });

const NOT_SIGNED_IN = "Not signed in";
const ROOM_NOT_FOUND = "Room not found or inaccessible";
const UPLOAD_NOT_FOUND = "Upload not found";
const ALREADY_POSTED = "The file is posted already";
/** What a request that would store a file answers without an R2 bucket bound as FILES. */
export const NO_STORAGE = "Ember isn't set up to store files";

const problem = (status: number, message: string) => Response.json({ error: message }, { status });

/** What a banned IP address's requests to change something answer, as the Worker's own check does. */
const tooManyRequests = () => new Response(null, { status: 429, headers: { "Content-Type": "text/html" } });

/**
 * Someone uploading to a room, as the room checks them: who they are, as their message names them, the
 * tags a revocation would name them by, and when the Workspace let them in.
 */
export interface Uploader {
  user: User;
  tags: string[];
  authorizedAt: number;
}

/**
 * Who `credentials` signs in, if they may upload to room `roomId`, or what the request answers: 401
 * without a session, 404 when they aren't in the room, and 429 when a ban blocks their IP address.
 * The room tags them as it tags their sockets, so it turns them away as it would turn those away.
 */
async function uploaderIn(env: Env, credentials: Credentials, roomId: RoomId): Promise<Uploader | Response> {
  const access = await workspace(env).roomAccess(credentials, roomId);
  if (!access) return problem(401, NOT_SIGNED_IN);
  if (!access.member) return problem(404, ROOM_NOT_FOUND);
  if (access.banned) return tooManyRequests();
  const address = taggedAddress(credentials.client.ip);
  const tags = [access.user.id, sessionTag(access.sessionId), ...(address !== null ? [addressTag(address)] : [])];
  return { user: access.user, tags, authorizedAt: access.authorizedAt };
}

/**
 * `POST /api/rooms/<room>/uploads`, a `NewUpload`: starts uploading a file to the room, answering 201
 * with where its parts go. As for other changes, who's asking and whether they're in the room are
 * checked before what they sent.
 */
export async function startUpload(request: Request, env: Env, roomId: RoomId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, NOT_SIGNED_IN);
  if (!env.FILES) return problem(503, NO_STORAGE);
  const uploader = await uploaderIn(env, credentials, roomId);
  if (uploader instanceof Response) return uploader;
  const file = parseNewUpload(await jsonBodyOf(request));
  if (typeof file === "string") return problem(file === FILE_TOO_LARGE ? 413 : 422, file);
  const started = await env.CHAT_ROOM.getByName(roomId).startUpload(roomId, uploader, file);
  if (!started) return problem(404, ROOM_NOT_FOUND);
  if (typeof started === "string") return problem(422, started);
  return Response.json({ id: started.key, partSize: UPLOAD_PART_SIZE, parts: uploadParts(file.size) } satisfies Upload, { status: 201 });
}

/**
 * What a part that finishes an upload answers: 201 with the message the room posted the file as, or 200
 * with the one an earlier part did, 404 when the room turned the uploader away or the message is gone, or
 * 422 when the thread it was to go in is.
 */
function posted(finished: { message: Message; posted: boolean } | string | null): Response {
  if (typeof finished === "string") return problem(422, finished);
  return finished ? Response.json(finished.message, { status: finished.posted ? 201 : 200 }) : problem(404, UPLOAD_NOT_FOUND);
}

/**
 * Has the room post `uploader`'s `upload`, which R2 has all of now, answering as `posted` does, once
 * Cloudflare Images has made the preview its uploader's browser didn't send, if its message would show it
 * only by one. When the room no longer has the upload, as when it deleted the upload while this request
 * put the file together, has R2 delete the file and its preview, which nothing else would.
 */
async function finish(env: Env, files: R2Bucket, roomId: RoomId, uploader: Uploader, upload: RoomBlob, identified?: Identified): Promise<Response> {
  const room = env.CHAT_ROOM.getByName(roomId);
  const key = upload.id;
  if (upload.preview === null) {
    const file = { filename: upload.filename, byteSize: upload.byteSize, ...(identified ?? { contentType: upload.contentType, metadata: upload.metadata! }) };
    const preview = await previewFromImages(env, files, key, file);
    if (preview) await room.recordUploadPreview(roomId, uploader, key, preview);
  }
  const finished = await room.finishUpload(roomId, uploader, key, identified);
  if (!finished && !(await room.uploadOf(roomId, uploader.user.id, key))) await files.delete([objectKey(key), previewKey(key)]);
  return posted(finished);
}

/**
 * `PUT /api/rooms/<room>/uploads/<key>/parts/<n>`, the part's bytes, which have to be as many as the
 * part carries: stores part `n` of one of the uploader's own uploads, answering 204 while there are
 * parts to come, then 201 with the message the room posts the file as once R2 has all of it, or 200
 * with that message for a part sent after that. The first part comes first, since it says what the
 * file is.
 */
export async function uploadPart(request: Request, env: Env, roomId: RoomId, key: string, n: number): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, NOT_SIGNED_IN);
  const files = env.FILES;
  if (!files) return problem(503, NO_STORAGE);
  let uploader = await uploaderIn(env, credentials, roomId);
  if (uploader instanceof Response) return uploader;
  const room = env.CHAT_ROOM.getByName(roomId);
  const upload = await room.uploadOf(roomId, uploader.user.id, key);
  if (!upload || n > uploadParts(upload.byteSize)) return problem(404, UPLOAD_NOT_FOUND);
  if (upload.completedAt) return posted(await room.finishUpload(roomId, uploader, key));

  const length = Number(request.headers.get("Content-Length") ?? NaN);
  if (!Number.isSafeInteger(length)) return problem(411, "A part needs its Content-Length");
  const expected = partLength(upload.byteSize, n);
  if (length < expected) return problem(400, `Part ${n} is ${expected} bytes`);
  if (length > expected) return problem(413, `Part ${n} is ${expected} bytes`);
  if (upload.metadata === null && n > 1) return problem(409, "The first part goes first");

  if (upload.metadata === null) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    // Again now the part has arrived, which can take as long as its sender likes: long enough for
    // their access to end, or for the Workspace's word to be too old for the room to take, or for
    // another request to post the file, when it answers as a part sent after the post does.
    const [arrived, unposted] = await Promise.all([uploaderIn(env, credentials, roomId), room.uploadOf(roomId, uploader.user.id, key)]);
    if (arrived instanceof Response) return arrived;
    if (!unposted) return problem(404, UPLOAD_NOT_FOUND);
    if (unposted.completedAt) return posted(await room.finishUpload(roomId, arrived, key));
    return storeFirstPart(env, files, roomId, arrived, upload, bytes);
  }

  // A part after the first, or the first again, once the first has started the upload.
  if (upload.multipartUploadId === null) return problem(409, "The first part goes first");
  const multipart = files.resumeMultipartUpload(objectKey(key), upload.multipartUploadId);
  const part = await multipart.uploadPart(n, request.body!).catch(async (error: unknown) => {
    // A request that put the parts together but didn't live to post the file left it whole, and no
    // upload to add a part to, so this posts it in its place.
    if (!(await isWhole(files, upload))) throw error;
    return null;
  });
  // Again, as for the first part.
  uploader = await uploaderIn(env, credentials, roomId);
  if (uploader instanceof Response) return uploader;
  if (!part) return finish(env, files, roomId, uploader, upload);
  const recorded = await room.recordUploadPart(roomId, uploader, key, part);
  if (!recorded) return problem(404, UPLOAD_NOT_FOUND);
  if (recorded.completedAt) return posted(await room.finishUpload(roomId, uploader, key));
  if (recorded.parts.length < uploadParts(recorded.byteSize)) return new Response(null, { status: 204 });

  try {
    await multipart.complete(recorded.parts);
  } catch (error) {
    // Another request put the parts together first.
    if (!(await isWhole(files, recorded))) throw error;
  }
  return finish(env, files, roomId, uploader, recorded);
}

/**
 * `PUT /api/rooms/<room>/uploads/<key>/preview`, a WebP, JPEG or PNG within 1200×800 and 5 MiB: stores
 * the preview of one of the uploader's own uploads, in place of any it had, answering 204. Once the room
 * posts the file, its message shows the preview, if it's an image or a video. It has to come before the
 * part that finishes the upload, since that posts the message, so it answers 409 after.
 */
export async function uploadPreview(request: Request, env: Env, roomId: RoomId, key: string): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, NOT_SIGNED_IN);
  const files = env.FILES;
  if (!files) return problem(503, NO_STORAGE);
  const uploader = await uploaderIn(env, credentials, roomId);
  if (uploader instanceof Response) return uploader;
  const room = env.CHAT_ROOM.getByName(roomId);
  const upload = await room.uploadOf(roomId, uploader.user.id, key);
  if (!upload) return problem(404, UPLOAD_NOT_FOUND);
  if (upload.completedAt) return problem(409, ALREADY_POSTED);

  const length = Number(request.headers.get("Content-Length") ?? NaN);
  if (!Number.isSafeInteger(length)) return problem(411, "A preview needs its Content-Length");
  if (length > MAX_PREVIEW_SIZE) return problem(413, "A preview is at most 5 MiB");
  const bytes = new Uint8Array(await request.arrayBuffer());
  const contentType = byMagic(bytes) ?? "";
  const size = isPreviewType(contentType) ? imageSize(bytes, contentType) : null;
  if (!size) return problem(415, "A preview is a WebP, JPEG or PNG image");
  if (size.width > PREVIEW_MAX_WIDTH || size.height > PREVIEW_MAX_HEIGHT) return problem(422, "A preview fits within 1200×800");

  // Again now the preview has arrived, as for a part, and whether the file was posted while it arrived, as
  // this would replace the preview its message shows. Only a post in the moment the write takes overtakes
  // this check, rather than one any time before the preview's sender chose to finish sending it.
  const [arrived, unposted] = await Promise.all([uploaderIn(env, credentials, roomId), room.uploadOf(roomId, uploader.user.id, key)]);
  if (arrived instanceof Response) return arrived;
  if (!unposted) return problem(404, UPLOAD_NOT_FOUND);
  if (unposted.completedAt) return problem(409, ALREADY_POSTED);
  await keepPreview(files, key, upload.filename, bytes, contentType);
  const recorded = await room.recordUploadPreview(roomId, arrived, key, size);
  if (!recorded) {
    // When the room has deleted the upload meanwhile, nothing else would have R2 delete this.
    if (!(await room.uploadOf(roomId, arrived.user.id, key))) await files.delete(previewKey(key));
    return problem(404, UPLOAD_NOT_FOUND);
  }
  return recorded.completedAt ? problem(409, ALREADY_POSTED) : new Response(null, { status: 204 });
}

/** Whether R2 has all of `upload`'s file, as once its parts are put together. */
const isWhole = async (files: R2Bucket, upload: RoomBlob) => (await files.head(objectKey(upload.id)))?.size === upload.byteSize;

/**
 * Stores the first part of `upload`, which says what the file is, as Active Storage identifies a blob
 * on upload and analyzes it after: its type, from its first bytes, the type the browser declared and its
 * name, and an image's size. A file in one part is then whole, and posted; a larger one starts its
 * multipart upload.
 */
async function storeFirstPart(env: Env, files: R2Bucket, roomId: RoomId, uploader: Uploader, upload: RoomBlob, bytes: Uint8Array): Promise<Response> {
  const room = env.CHAT_ROOM.getByName(roomId);
  const identified = identifiedOf(bytes, upload.filename, upload.contentType);
  const options = keptAs(identified.contentType, upload.filename);
  const key = objectKey(upload.id);

  if (uploadParts(upload.byteSize) === 1) {
    // Only the first request to store the file does, so none can replace the file a message shows.
    // Any after posts the file R2 has, in case the first didn't live to.
    if (await files.put(key, bytes, { ...options, onlyIf: new Headers({ "If-None-Match": "*" }) })) {
      return finish(env, files, roomId, uploader, upload, identified);
    }
    const stored = await files.get(key);
    if (!stored) return problem(404, UPLOAD_NOT_FOUND);
    return finish(env, files, roomId, uploader, upload, identifiedOf(new Uint8Array(await stored.arrayBuffer()), upload.filename, upload.contentType));
  }
  const multipart = await files.createMultipartUpload(key, options);
  const { partNumber, etag } = await multipart.uploadPart(1, bytes);
  const started = await room.identifyUpload(roomId, uploader, upload.id, identified, multipart.uploadId, { partNumber, etag });
  if (started?.multipartUploadId === multipart.uploadId) return new Response(null, { status: 204 });
  // The room turned the uploader away, or another request sent the first part first.
  await multipart.abort();
  return started ? problem(409, "The first part is already uploading") : problem(404, UPLOAD_NOT_FOUND);
}
