import { CloseCode, FILE_TOO_LARGE, MAX_FILE_SIZE, MAX_PREVIEW_SIZE, uploadPartPath, uploadPreviewPath, type RoomId, type Upload } from "@ember/protocol";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fileSigner } from "../src/files/addresses";
import { objectKey, type UploadedPart } from "../src/files/blobs";
import { imageSize } from "../src/files/images";
import { keptAs, UPLOAD_PART_SIZE } from "../src/files/uploads";
import { heifFile, hvcC, irot, ispe } from "./heif-files";
import { storedPng } from "./png-files";
import {
  api,
  apiWith,
  connect,
  createRoom,
  freshDeploy,
  freshRoom,
  post,
  reconnect,
  recordedImage,
  roomSql,
  roomStub,
  sendPart,
  shown,
  signIn,
  startUpload,
  upload,
  type FileMessage,
  type Session,
} from "./support";

// Uploading files to a room in parts, which R2 keeps, and serving them from the addresses Ember signs.

/** An Active Storage key. */
const KEY = /^[0-9a-z]{28}$/;

/** What the room keeps of upload `id`. */
const blobOf = async (room: RoomId, id: string) => ((await roomSql(room, "SELECT * FROM blobs WHERE id = ?", id)) as Array<Record<string, unknown>>)[0];

/** `length` bytes that start with `head` and go on counting, so any range of them is told apart. */
function fileOf(length: number, head: Uint8Array = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 251;
  bytes.set(head.subarray(0, length));
  return bytes;
}

/** `bytes`' SHA-256, as hex, to compare a large file by, since a failing comparison of its bytes would print them all. */
const digestOf = async (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** What the app sends to start uploading a file named `name` of `size` bytes, of the type a browser declares. */
const newUpload = (name: string, size: number, type = "") => ({ name, type, size, clientMessageId: crypto.randomUUID() });

/** Uploads a file as `upload` does, answering the file its message posts. */
const uploadFile = async (...args: Parameters<typeof upload>) => (await upload(...args)).attachment;

/** Starts uploading `bytes` to `room` as `session`, named `name` and of the type a browser declares, answering where its parts go. */
async function started(session: Session, room: RoomId, name: string, bytes: Uint8Array, type = ""): Promise<Upload> {
  const response = await startUpload(session, room, newUpload(name, bytes.length, type));
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Upload;
}

/** The bytes of part `n` of `bytes`, uploading as `upload`. */
const partOf = (bytes: Uint8Array, { partSize }: Upload, n: number) => bytes.subarray((n - 1) * partSize, n * partSize);

/** `response`'s error. */
const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;

/** GETs `path`, a file's address, without a session, as anyone who has it can. */
const fetchFile = (path: string, headers: Record<string, string> = {}, method = "GET") => api(path, { method, headers });

/** Sends `bytes` as the preview of upload `id` in `room` as `session`, with their length, as the app sends one. */
const sendPreview = (session: Session, room: RoomId, id: string, bytes: Uint8Array, headers: Record<string, string> = {}) =>
  api(uploadPreviewPath(room, id), { method: "PUT", headers: { Cookie: session.cookie, "Content-Length": String(bytes.length), ...headers }, body: bytes });

/**
 * Uploads `bytes` to `room` as `session` in one part, named `name` and of the type a browser declares,
 * sending `preview` first, as the app sends a picture's thumbnail or a video's poster, and answers the
 * message the room posts it as.
 */
async function uploadWithPreview(session: Session, room: RoomId, name: string, bytes: Uint8Array, type: string, preview: Uint8Array): Promise<FileMessage> {
  const upload = await started(session, room, name, bytes, type);
  const sent = await sendPreview(session, room, upload.id, preview);
  expect(sent.status, await sent.clone().text()).toBe(204);
  const last = await sendPart(session, room, upload.id, 1, bytes);
  expect(last.status, await last.clone().text()).toBe(201);
  return (await last.json()) as FileMessage;
}

/** A PNG's signature and header, for a picture `width` by `height`: as much of one as the Worker reads to size it. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

/**
 * Sends `bytes`, upload `upload`, in its parts as `session`, the last to a Worker whose Cloudflare Images
 * binding is `images`, answering the message the room posts it as.
 */
async function finishWith(images: ImagesBinding | undefined, session: Session, room: RoomId, upload: Upload, bytes: Uint8Array): Promise<FileMessage> {
  for (let n = 1; n < upload.parts; n++) expect((await sendPart(session, room, upload.id, n, partOf(bytes, upload, n))).status).toBe(204);
  const last = partOf(bytes, upload, upload.parts);
  const headers = { Cookie: session.cookie, "Content-Length": String(last.length) };
  const response = await apiWith({ IMAGES: images }, uploadPartPath(room, upload.id, upload.parts), { method: "PUT", headers, body: last });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as FileMessage;
}

/** Cloudflare Images as the suite binds it, with what reads each picture it's asked to make something of. */
function watchedImages() {
  const images = (env as unknown as Env).IMAGES!;
  const input = vi.fn((stream: ReadableStream<Uint8Array>) => images.input(stream));
  return { images: { input } as unknown as ImagesBinding, input };
}

/** Cloudflare Images once the account has made as many pictures as its plan has this month, when it fails with error 9422. */
const usedUpImages = {
  input: () => ({
    transform() {
      return this;
    },
    output: () => Promise.reject(Object.assign(new Error("IMAGES_TRANSFORM_ERROR 9422: usage limit reached"), { code: 9422 })),
  }),
} as unknown as ImagesBinding;

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Attach files", () => {
  it("posts a file as its uploader's message once R2 has all of it, under the app's id for it, which everyone in the room sees at once", async () => {
    const room = await freshRoom("lobby");
    const [ada, grace] = [await connect(room, "Ada"), await connect(room, "Grace")];
    const moon = recordedImage("moon-thumb.jpg");

    const message = await upload(ada.session, room, "moon.jpg", moon, "", "5s1fw6nd9fk");
    // Its text is empty, and its plain text its file's name.
    expect(message).toEqual({
      id: expect.any(String),
      clientMessageId: "5s1fw6nd9fk",
      roomId: room,
      creator: shown(ada.session.user),
      body: "",
      plainText: "moon.jpg",
      mentions: [],
      createdAt: expect.any(String),
      updatedAt: message.createdAt,
      editedAt: null,
      boosts: [],
      attachment: {
        id: expect.stringMatching(KEY),
        name: "moon.jpg",
        contentType: "image/jpeg",
        byteSize: moon.length,
        width: 640,
        height: 640,
        url: expect.stringMatching(new RegExp(`^/files/${message.attachment.id}/[\\w-]{22}/moon\\.jpg$`)),
        downloadUrl: `${message.attachment.url}?disposition=attachment`,
      },
    });
    for (const client of [ada, grace]) expect((await client.next("message.created")).message).toEqual(message);
    expect(await blobOf(room, message.attachment.id)).toMatchObject({ client_message_id: "5s1fw6nd9fk", completed_at: message.createdAt, message_id: message.id });
  });

  it("posts a file in parts once its last part arrives, and answers a part sent again with that message, until it's deleted", async () => {
    const room = await freshRoom("lobby");
    const ada = await connect(room, "Ada");
    const earth = fileOf(UPLOAD_PART_SIZE + 1_000, recordedImage("earth-thumb.png"));
    const upload = await started(ada.session, room, "earth.png", earth);

    expect((await sendPart(ada.session, room, upload.id, 1, partOf(earth, upload, 1))).status).toBe(204);
    expect(ada.pending("message.created")).toEqual([]);
    const last = await sendPart(ada.session, room, upload.id, 2, partOf(earth, upload, 2));
    expect(last.status).toBe(201);
    const message = (await last.json()) as FileMessage;
    expect(message).toMatchObject({ body: "", plainText: "earth.png", attachment: { id: upload.id, name: "earth.png", contentType: "image/png", width: 640, height: 800 } });
    expect((await ada.next("message.created")).message).toEqual(message);

    const again = await sendPart(ada.session, room, upload.id, 2, partOf(earth, upload, 2));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(message);
    expect(await roomSql(room, "SELECT id FROM messages WHERE room_id = ?", room)).toEqual([{ id: message.id }]);

    ada.send({ type: "message.delete", messageId: message.id });
    await ada.next("message.deleted");
    const afterDeletion = await sendPart(ada.session, room, upload.id, 1, partOf(earth, upload, 1));
    expect(afterDeletion.status).toBe(404);
    expect(await errorOf(afterDeletion)).toBe("Upload not found");
  });

  it("answers a first part still arriving when another posted the file with that message, keeping the file it posted", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const earth = recordedImage("earth-thumb.png");
    const page = fileOf(earth.length, new TextEncoder().encode("<!DOCTYPE html><html></html>"));
    const upload = await started(ada, room, "earth.png", earth);

    const { readable, writable } = new FixedLengthStream(page.length);
    const arriving = writable.getWriter();
    const late = api(uploadPartPath(room, upload.id, 1), { method: "PUT", headers: { Cookie: ada.cookie }, body: readable });
    await arriving.write(page.subarray(0, 100));
    const sent = await sendPart(ada, room, upload.id, 1, earth);
    expect(sent.status).toBe(201);
    const message = (await sent.json()) as FileMessage;
    await arriving.write(page.subarray(100));
    await arriving.close();

    const answered = await late;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual(message);
    const served = await fetchFile(message.attachment.url);
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(await digestOf(await served.arrayBuffer())).toBe(await digestOf(earth));
  });

  it("answers a first part still arriving when another posted a file in parts with that message too", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const earth = fileOf(UPLOAD_PART_SIZE + 1_000, recordedImage("earth-thumb.png"));
    const upload = await started(ada, room, "earth.png", earth);
    const first = partOf(earth, upload, 1);

    const { readable, writable } = new FixedLengthStream(first.length);
    const arriving = writable.getWriter();
    const late = api(uploadPartPath(room, upload.id, 1), { method: "PUT", headers: { Cookie: ada.cookie }, body: readable });
    await arriving.write(first.subarray(0, 100));
    expect((await sendPart(ada, room, upload.id, 1, first)).status).toBe(204);
    const sent = await sendPart(ada, room, upload.id, 2, partOf(earth, upload, 2));
    expect(sent.status).toBe(201);
    const message = (await sent.json()) as FileMessage;
    await arriving.write(first.subarray(100));
    await arriving.close();

    const answered = await late;
    expect(answered.status, await answered.clone().text()).toBe(200);
    expect(await answered.json()).toEqual(message);
  });

  it("posts the file in one part that a request stored but didn't live to post, over a part sent after", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const earth = recordedImage("earth-thumb.png");
    const upload = await started(ada, room, "earth.png", earth);
    await (env as unknown as Env).FILES!.put(objectKey(upload.id), earth, keptAs("image/png", "earth.png"));

    const sent = await sendPart(ada, room, upload.id, 1, fileOf(earth.length, new TextEncoder().encode("<!DOCTYPE html><html></html>")));
    expect(sent.status, await sent.clone().text()).toBe(201);
    const { attachment } = (await sent.json()) as FileMessage;
    expect(attachment).toMatchObject({ id: upload.id, name: "earth.png", contentType: "image/png", width: 640, height: 800 });
    const served = await fetchFile(attachment.url);
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(await digestOf(await served.arrayBuffer())).toBe(await digestOf(earth));
  });

  it("gives the message an id of its own when its upload started before files were messages", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const upload = await started(ada, room, "notes.txt", new Uint8Array(5));
    await roomSql(room, "UPDATE blobs SET client_message_id = NULL WHERE id = ?", upload.id);

    const last = await sendPart(ada, room, upload.id, 1, new TextEncoder().encode("hello"));
    expect(last.status).toBe(201);
    expect(await last.json()).toMatchObject({ clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/), plainText: "notes.txt" });
  });

  it("shows a file message with its file wherever the room's messages are read", async () => {
    const room = await freshRoom("lobby");
    const ada = await connect(room, "Ada");
    const message = await upload(ada.session, room, "moon.jpg", recordedImage("moon-thumb.jpg"));
    const { seq } = await ada.next("message.created");
    const later = await post(ada, "Later");

    // A tab that opens the room, one that pages back to it, and one that connects again since it.
    expect((await connect(room, ada.session)).welcome.messages).toEqual([message, later]);
    ada.send({ type: "history.before", before: later.id });
    expect((await ada.next("history")).messages).toEqual([message]);
    expect((await reconnect(room, ada.session, seq - 1)).opening).toMatchObject({ type: "resumed", messages: [message, later] });
  });
});

describe("How files are recognized", () => {
  it("uploads a file in one part, naming its type from its bytes and recording an image's size", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const moon = recordedImage("moon-thumb.jpg");

    const file = await uploadFile(ada, room, "moon.jpg", moon);
    expect(file).toEqual({
      id: expect.stringMatching(KEY),
      name: "moon.jpg",
      contentType: "image/jpeg",
      byteSize: moon.length,
      width: 640,
      height: 640,
      url: expect.stringMatching(new RegExp(`^/files/${file.id}/[\\w-]{22}/moon\\.jpg$`)),
      downloadUrl: `${file.url}?disposition=attachment`,
    });
    expect(await blobOf(room, file.id)).toMatchObject({
      room_id: room,
      uploader_id: ada.user.id,
      filename: "moon.jpg",
      content_type: "image/jpeg",
      byte_size: moon.length,
      metadata: '{"identified":true,"width":640,"height":640,"analyzed":true}',
      multipart_upload_id: null,
      parts: "[]",
      completed_at: expect.any(String),
    });
    expect(new Uint8Array(await (await fetchFile(file.url)).arrayBuffer())).toEqual(moon);
  });

  it("records a HEIC's size, turned as its boxes say", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const photo = heifFile({ brand: "heic", compatible: ["mif1", "heic"], items: [{ id: 1, type: "hvc1", properties: [hvcC, ispe(4032, 3024), irot(3)] }] });
    expect(await uploadFile(ada, room, "photo.heic", photo)).toMatchObject({ contentType: "image/heic", width: 3024, height: 4032 });
  });

  it("uploads a larger file in parts, which can come in any order after the first, and puts them back together", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const earth = fileOf(2 * UPLOAD_PART_SIZE + 1_000, recordedImage("earth-thumb.png"));
    const upload = await started(ada, room, "earth.png", earth);
    expect(upload).toEqual({ id: expect.stringMatching(KEY), partSize: UPLOAD_PART_SIZE, parts: 3 });

    expect((await sendPart(ada, room, upload.id, 1, partOf(earth, upload, 1))).status).toBe(204);
    expect((await sendPart(ada, room, upload.id, 3, partOf(earth, upload, 3))).status).toBe(204);
    // A part sent again replaces the one R2 had.
    expect((await sendPart(ada, room, upload.id, 3, partOf(earth, upload, 3))).status).toBe(204);
    const last = await sendPart(ada, room, upload.id, 2, partOf(earth, upload, 2));
    expect(last.status).toBe(201);
    const message = (await last.json()) as FileMessage;
    const file = message.attachment;
    expect(file).toMatchObject({ id: upload.id, name: "earth.png", contentType: "image/png", byteSize: earth.length, width: 640, height: 800 });
    expect(await digestOf(await (await fetchFile(file.url)).arrayBuffer())).toBe(await digestOf(earth));

    const blob = await blobOf(room, upload.id);
    expect(blob).toMatchObject({ multipart_upload_id: expect.any(String), completed_at: expect.any(String) });
    expect(JSON.parse(blob!.parts as string)).toEqual([1, 2, 3].map((partNumber) => ({ partNumber, etag: expect.any(String) })));
    // Once it's whole, a part sent again changes nothing, and answers its message.
    const again = await sendPart(ada, room, upload.id, 1, partOf(earth, upload, 1));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(message);
  });

  it("finishes an upload whose parts R2 put together for a request that didn't live to tell the room", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const earth = fileOf(UPLOAD_PART_SIZE + 1_000, recordedImage("earth-thumb.png"));
    const upload = await started(ada, room, "earth.png", earth);
    expect((await sendPart(ada, room, upload.id, 1, partOf(earth, upload, 1))).status).toBe(204);
    const blob = await blobOf(room, upload.id);
    const multipart = (env as unknown as Env).FILES!.resumeMultipartUpload(objectKey(upload.id), blob!.multipart_upload_id as string);
    const last = await multipart.uploadPart(2, partOf(earth, upload, 2));
    await multipart.complete([...(JSON.parse(blob!.parts as string) as UploadedPart[]), last]);

    // Sent again, the last part finds no upload to join, and the file whole.
    const again = await sendPart(ada, room, upload.id, 2, partOf(earth, upload, 2));
    expect(again.status, await again.clone().text()).toBe(201);
    const file = ((await again.json()) as FileMessage).attachment;
    expect(file).toMatchObject({ id: upload.id, name: "earth.png", contentType: "image/png", byteSize: earth.length });
    expect(await digestOf(await (await fetchFile(file.url)).arrayBuffer())).toBe(await digestOf(earth));
    expect(await blobOf(room, upload.id)).toMatchObject({ completed_at: expect.any(String) });
  });

  it("takes a file's type from its bytes over the type the browser declares and its name, as Marcel does", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const page = new TextEncoder().encode("<!DOCTYPE html><html></html>");
    expect(await uploadFile(ada, room, "page.txt", page, "text/plain")).toMatchObject({ contentType: "text/html" });
    // Bytes that say nothing leave it to the declared type, then the name.
    const notes = new TextEncoder().encode("hello world");
    expect(await uploadFile(ada, room, "notes.txt", notes, "text/plain")).toMatchObject({ contentType: "text/plain" });
    expect(await uploadFile(ada, room, "notes.csv", notes)).toMatchObject({ contentType: "text/csv" });
    expect(await uploadFile(ada, room, "notes", notes)).toMatchObject({ contentType: "application/octet-stream" });
    // An empty file, in one part.
    const empty = await startUpload(ada, room, newUpload(".keep", 0));
    expect(await empty.json()).toMatchObject({ parts: 1 });
    expect(await uploadFile(ada, room, ".keep", new Uint8Array())).toMatchObject({ name: ".keep", contentType: "application/octet-stream", byteSize: 0 });
  });

  it("keeps the first part that arrives when two do, and lets the other's upload go", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const key = (await started(ada, room, "earth.png", fileOf(UPLOAD_PART_SIZE + 1))).id;
    const uploader = { user: shown(ada.user), tags: [ada.user.id], authorizedAt: Date.now() };
    const identified = { contentType: "image/png", metadata: '{"identified":true,"analyzed":true}' };
    const first = await roomStub(room).identifyUpload(room, uploader, key, identified, "first", { partNumber: 1, etag: "a" });
    expect(first).toMatchObject({ multipartUploadId: "first", parts: [{ partNumber: 1, etag: "a" }] });
    const second = await roomStub(room).identifyUpload(room, uploader, key, { ...identified, contentType: "text/plain" }, "second", { partNumber: 1, etag: "b" });
    expect(second).toEqual(first);
  });
});

describe("Image, video and file previews", () => {
  it("shows an image by the thumbnail its uploader's browser sent, at the image's own size, and a video by its poster, at the poster's", async () => {
    const room = await freshRoom("lobby");
    const ada = await connect(room, "Ada");
    const moon = recordedImage("moon-thumb.jpg");

    const image = await uploadWithPreview(ada.session, room, "moon.jpg", moon, "image/jpeg", recordedImage("moon-avatar.webp"));
    const [, , key, signature] = image.attachment.url.split("/") as [string, string, string, string];
    expect(image.attachment).toEqual({
      id: key,
      name: "moon.jpg",
      contentType: "image/jpeg",
      byteSize: moon.length,
      width: 640,
      height: 640,
      url: `/files/${key}/${signature}/moon.jpg`,
      downloadUrl: `/files/${key}/${signature}/moon.jpg?disposition=attachment`,
      previewUrl: `/previews/${key}/${signature}/moon.jpg`,
    });
    expect((await ada.next("message.created")).message).toEqual(image);

    // Ember can't read a video's size, but its poster has its shape.
    const video = await uploadWithPreview(ada.session, room, "alpha centuri.mp4", new Uint8Array(1_000), "video/mp4", recordedImage("alpha-centuri-poster.webp"));
    expect(video.attachment).toMatchObject({ contentType: "video/mp4", width: 320, height: 180, previewUrl: expect.stringMatching(/^\/previews\/[0-9a-z]{28}\/[\w-]{22}\/alpha%20centuri\.mp4$/) });
    expect((await ada.next("message.created")).message).toEqual(video);
    expect((await connect(room, ada.session)).welcome.messages).toEqual([image, video]);
  });

  it("shows no preview for a file that isn't an image or a video, or one sent without", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const notes = await uploadWithPreview(ada, room, "notes.txt", new TextEncoder().encode("Moon, then earth"), "text/plain", recordedImage("moon-avatar.webp"));
    expect(notes.attachment).not.toHaveProperty("previewUrl");
    expect(notes.attachment).not.toHaveProperty("width");
    const moon = await uploadFile(ada, room, "moon.jpg", recordedImage("moon-thumb.jpg"));
    expect(moon).not.toHaveProperty("previewUrl");
    expect(moon).toMatchObject({ width: 640, height: 640 });
  });

  it("keeps the last preview sent before the file is posted, and refuses one after", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const clip = new Uint8Array(1_000);
    const upload = await started(ada, room, "clip.mp4", clip, "video/mp4");
    expect((await sendPreview(ada, room, upload.id, recordedImage("alpha-centuri-poster.webp"))).status).toBe(204);
    const blackHole = recordedImage("black_hole-thumb.jpg");
    expect((await sendPreview(ada, room, upload.id, blackHole)).status).toBe(204);
    const message = (await (await sendPart(ada, room, upload.id, 1, clip)).json()) as FileMessage;
    expect(message.attachment).toMatchObject({ width: 1200, height: 675 });
    expect(new Uint8Array(await (await fetchFile(message.attachment.previewUrl!)).arrayBuffer())).toEqual(blackHole);

    const late = await sendPreview(ada, room, upload.id, recordedImage("moon-avatar.webp"));
    expect(late.status).toBe(409);
    expect(await errorOf(late)).toBe("The file is posted already");
    expect(new Uint8Array(await (await fetchFile(message.attachment.previewUrl!)).arrayBuffer())).toEqual(blackHole);
  });

  it("refuses a preview still arriving when the file was posted, keeping the one its message shows", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const clip = new Uint8Array(1_000);
    const upload = await started(ada, room, "clip.mp4", clip, "video/mp4");
    const blackHole = recordedImage("black_hole-thumb.jpg");
    expect((await sendPreview(ada, room, upload.id, blackHole)).status).toBe(204);

    const moon = recordedImage("moon-avatar.webp");
    const { readable, writable } = new FixedLengthStream(moon.length);
    const arriving = writable.getWriter();
    const late = api(uploadPreviewPath(room, upload.id), { method: "PUT", headers: { Cookie: ada.cookie }, body: readable });
    await arriving.write(moon.subarray(0, 100));
    const message = (await (await sendPart(ada, room, upload.id, 1, clip)).json()) as FileMessage;
    await arriving.write(moon.subarray(100));
    await arriving.close();
    expect((await late).status).toBe(409);
    expect(new Uint8Array(await (await fetchFile(message.attachment.previewUrl!)).arrayBuffer())).toEqual(blackHole);
  });

  it("keeps a picture's thumbnail only where its own size is known and within 250 megapixels", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const thumbnail = recordedImage("moon-avatar.webp");

    const largest = await uploadWithPreview(ada, room, "largest.png", pngHeader(25_000, 10_000), "image/png", thumbnail);
    expect(largest.attachment).toMatchObject({ width: 25_000, height: 10_000, previewUrl: expect.any(String) });
    const larger = await uploadWithPreview(ada, room, "larger.png", pngHeader(25_001, 10_000), "image/png", thumbnail);
    expect(larger.attachment).toMatchObject({ width: 25_001, height: 10_000 });
    expect(larger.attachment).not.toHaveProperty("previewUrl");
    // A PNG cut off before its size, which its thumbnail's would otherwise stand in for.
    const unsized = await uploadWithPreview(ada, room, "unsized.png", pngHeader(640, 480).subarray(0, 16), "image/png", thumbnail);
    expect(unsized.attachment).toMatchObject({ contentType: "image/png" });
    expect(unsized.attachment).not.toHaveProperty("previewUrl");
    expect(unsized.attachment).not.toHaveProperty("width");
  });

  it("takes a preview only as a WebP, JPEG or PNG of up to 5 MiB that fits within 1200×800", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const upload = await started(ada, room, "earth.png", new Uint8Array(10), "image/png");
    const refusal = async (preview: Uint8Array, headers?: Record<string, string>) => {
      const response = await sendPreview(ada, room, upload.id, preview, headers);
      return [response.status, await errorOf(response)];
    };

    expect(await refusal(new TextEncoder().encode("GIF89a\x01\0\x01\0\0\0\0"))).toEqual([415, "A preview is a WebP, JPEG or PNG image"]);
    expect(await refusal(new TextEncoder().encode("A picture of the moon"))).toEqual([415, "A preview is a WebP, JPEG or PNG image"]);
    expect(await refusal(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toEqual([415, "A preview is a WebP, JPEG or PNG image"]);
    expect(await refusal(pngHeader(1201, 800))).toEqual([422, "A preview fits within 1200×800"]);
    expect(await refusal(pngHeader(1200, 801))).toEqual([422, "A preview fits within 1200×800"]);
    expect(await refusal(new Uint8Array(MAX_PREVIEW_SIZE + 1))).toEqual([413, "A preview is at most 5 MiB"]);
    const streamed = new ReadableStream({
      start(controller) {
        controller.enqueue(pngHeader(1, 1));
        controller.close();
      },
    });
    const unmeasured = await api(uploadPreviewPath(room, upload.id), { method: "PUT", headers: { Cookie: ada.cookie }, body: streamed });
    expect(unmeasured.status).toBe(411);
    expect(await blobOf(room, upload.id)).toMatchObject({ preview: null });

    expect((await sendPreview(ada, room, upload.id, pngHeader(1200, 800))).status).toBe(204);
    expect(await blobOf(room, upload.id)).toMatchObject({ preview: JSON.stringify({ width: 1200, height: 800 }) });
  });

  it("has Cloudflare Images make the preview of a picture too large to show by itself that came without one, as a WebP within 1200×800", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const screenshot = storedPng(1600, 1200);
    expect(screenshot.length).toBeGreaterThan(MAX_PREVIEW_SIZE);

    const file = await uploadFile(ada, room, "Screenshot on 2026-11-03.png", screenshot, "image/png");
    expect(file).toMatchObject({ contentType: "image/png", width: 1600, height: 1200, previewUrl: expect.stringMatching(/^\/previews\//) });
    const preview = await fetchFile(file.previewUrl!);
    expect(Object.fromEntries(preview.headers)).toMatchObject({
      "content-type": "image/webp",
      "content-disposition": `inline; filename="Screenshot on 2026-11-03.webp"; filename*=UTF-8''Screenshot%20on%202026-11-03.webp`,
    });
    expect(imageSize(new Uint8Array(await preview.arrayBuffer()), "image/webp")).toEqual({ width: 1067, height: 800 });
    expect(await blobOf(room, file.id)).toMatchObject({ preview: JSON.stringify({ width: 1067, height: 800 }) });

    // A picture in parts has its preview made once they're put together.
    const larger = storedPng(2400, 1600);
    expect(larger.length).toBeGreaterThan(UPLOAD_PART_SIZE);
    const inParts = await uploadFile(ada, room, "larger.png", larger);
    expect(inParts).toMatchObject({ width: 2400, height: 1600, previewUrl: expect.any(String) });
    expect(imageSize(new Uint8Array(await (await fetchFile(inParts.previewUrl!)).arrayBuffer()), "image/webp")).toEqual({ width: 1200, height: 800 });
  });

  it("asks Cloudflare Images only for a picture that would otherwise show as a file, and that it reads", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const { images, input } = watchedImages();
    const finished = async (name: string, bytes: Uint8Array) => (await finishWith(images, ada, room, await started(ada, room, name, bytes), bytes)).attachment;

    // A picture every browser shows that's small enough shows by itself.
    expect(await finished("moon.jpg", recordedImage("moon-thumb.jpg"))).not.toHaveProperty("previewUrl");
    // A browser's preview stands.
    const thumbnail = recordedImage("moon-avatar.webp");
    const screenshot = storedPng(1600, 1200);
    const upload = await started(ada, room, "screenshot.png", screenshot, "image/png");
    expect((await sendPreview(ada, room, upload.id, thumbnail)).status).toBe(204);
    const previewed = (await finishWith(images, ada, room, upload, screenshot)).attachment;
    expect(new Uint8Array(await (await fetchFile(previewed.previewUrl!)).arrayBuffer())).toEqual(thumbnail);
    // Images reads at most 20 MB, 100 megapixels and 12,000 pixels a side, and Ember previews no picture of an unknown size.
    const large = (header: Uint8Array, length: number) => {
      const bytes = new Uint8Array(length);
      bytes.set(header);
      return bytes;
    };
    for (const [name, bytes] of [
      ["more than 20 MB.png", large(pngHeader(1600, 1200), 20_000_001)],
      ["more than 100 megapixels.png", large(pngHeader(10_000, 10_001), MAX_PREVIEW_SIZE + 1)],
      ["more than 12,000 pixels wide.png", large(pngHeader(12_001, 100), MAX_PREVIEW_SIZE + 1)],
      ["unsized.png", large(pngHeader(1600, 1200).subarray(0, 16), MAX_PREVIEW_SIZE + 1)],
    ] as const) {
      expect(await finished(name, bytes), name).not.toHaveProperty("previewUrl");
    }
    expect(input).not.toHaveBeenCalled();
  });

  it("posts a picture without a preview, logging why, when Cloudflare Images can't make one, or isn't bound", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const screenshot = storedPng(1600, 1200);

    const usedUp = await started(ada, room, "screenshot.png", screenshot);
    expect((await finishWith(usedUpImages, ada, room, usedUp, screenshot)).attachment).not.toHaveProperty("previewUrl");
    expect(warnings).toHaveBeenCalledWith(`Cloudflare Images didn't preview file ${usedUp.id}:`, "IMAGES_TRANSFORM_ERROR 9422: usage limit reached");
    expect(await blobOf(room, usedUp.id)).toMatchObject({ preview: null });
    // A PNG whose pixels can't be read.
    const unreadable = fileOf(MAX_PREVIEW_SIZE + 1, pngHeader(1600, 1200));
    const broken = await started(ada, room, "broken.png", unreadable);
    expect((await finishWith((env as unknown as Env).IMAGES, ada, room, broken, unreadable)).attachment).not.toHaveProperty("previewUrl");
    expect(warnings).toHaveBeenCalledWith(`Cloudflare Images didn't preview file ${broken.id}:`, expect.any(String));
    expect((await (env as unknown as Env).FILES!.list({ prefix: "previews/" })).objects).toEqual([]);

    warnings.mockClear();
    const unbound = await started(ada, room, "screenshot.png", screenshot);
    expect((await finishWith(undefined, ada, room, unbound, screenshot)).attachment).toMatchObject({ width: 1600, height: 1200 });
    expect(warnings).not.toHaveBeenCalled();
  });
});

describe("File links", () => {
  it("serves a preview to anyone with its address, under its file's signature, named for its type", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const thumbnail = recordedImage("moon-avatar.webp");
    const { attachment: file } = await uploadWithPreview(ada, room, "moon.jpg", recordedImage("moon-thumb.jpg"), "image/jpeg", thumbnail);

    const shown = await fetchFile(file.previewUrl!);
    expect(shown.status).toBe(200);
    expect(Object.fromEntries(shown.headers)).toMatchObject({
      "content-type": "image/webp",
      "content-disposition": `inline; filename="moon.webp"; filename*=UTF-8''moon.webp`,
      "content-length": String(thumbnail.length),
      "cache-control": "max-age=3600, public",
      "x-content-type-options": "nosniff",
    });
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(thumbnail);
    expect((await fetchFile(file.previewUrl!, { Range: "bytes=0-3" })).status).toBe(206);

    const [, , key, signature] = file.previewUrl!.split("/") as [string, string, string, string];
    const tampered = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    expect((await fetchFile(`/previews/${key}/${tampered}/moon.jpg`)).status).toBe(404);
    // A file sent without a preview has none to serve.
    const earth = await uploadFile(ada, room, "earth.png", recordedImage("earth-thumb.png"));
    expect((await fetchFile(earth.url.replace(/^\/files\//, "/previews/"))).status).toBe(404);
  });

  it("serves a file to anyone with its address, inline or as a download, for an hour of caching, without Campfire's version", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const moon = recordedImage("moon-thumb.jpg");
    const file = await uploadFile(ada, room, "moon.jpg", moon);

    const shown = await fetchFile(file.url);
    expect(shown.status).toBe(200);
    expect(Object.fromEntries(shown.headers)).toMatchObject({
      "content-type": "image/jpeg",
      "content-disposition": `inline; filename="moon.jpg"; filename*=UTF-8''moon.jpg`,
      "content-length": String(moon.length),
      "cache-control": "max-age=3600, public",
      "last-modified": expect.stringMatching(/ GMT$/),
      "x-content-type-options": "nosniff",
    });
    expect(shown.headers.has("X-Version")).toBe(false);
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(moon);

    const downloaded = await fetchFile(file.downloadUrl);
    expect(downloaded.headers.get("Content-Disposition")).toBe(`attachment; filename="moon.jpg"; filename*=UTF-8''moon.jpg`);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(moon);
    // The last disposition asked for, as Rack reads a query.
    expect((await fetchFile(`${file.downloadUrl}&disposition=inline`)).headers.get("Content-Disposition")).toMatch(/^inline;/);

    const head = await fetchFile(file.url, {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(moon.length));
    expect(head.headers.get("Last-Modified")).toBe(shown.headers.get("Last-Modified"));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("names a file as Active Storage sanitizes its name, whatever its address says", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const report = await uploadFile(ada, room, " report: Q3/Q4‮.pdf ", new TextEncoder().encode("%PDF-1.7\n"));
    expect(report).toMatchObject({ name: "report- Q3-Q4-.pdf", contentType: "application/pdf" });
    expect(report.url).toMatch(/\/report-%20Q3-Q4-\.pdf$/);
    const served = await fetchFile(report.url.replace(/[^/]+$/, "anything-else.exe"));
    expect(served.headers.get("Content-Type")).toBe("application/pdf");
    expect(served.headers.get("Content-Disposition")).toBe(`inline; filename="report- Q3-Q4-.pdf"; filename*=UTF-8''report-%20Q3-Q4-.pdf`);

    // A name a browser would take out of the address goes in it as "-".
    for (const name of [" . ", "..", "\0"]) {
      const file = await uploadFile(ada, room, name, new TextEncoder().encode("hi"));
      expect(file.url).toMatch(/\/-$/);
      const shown = await fetchFile(file.url);
      expect(shown.status, name).toBe(200);
      expect(shown.headers.get("Content-Disposition")).toBe(`attachment; filename="${file.name}"; filename*=UTF-8''${file.name}`);
    }
  });

  it("serves only images and PDFs inline, and types a page could run as binary data", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const svg = await uploadFile(ada, room, "drawing.svg", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "image/svg+xml");
    const page = await uploadFile(ada, room, "page.html", new TextEncoder().encode("<!DOCTYPE html><html></html>"));
    const notes = await uploadFile(ada, room, "notes.txt", new TextEncoder().encode("hello world"), "text/plain");
    expect([svg.contentType, page.contentType, notes.contentType]).toEqual(["image/svg+xml", "text/html", "text/plain"]);
    for (const [file, type] of [[svg, "application/octet-stream"], [page, "application/octet-stream"], [notes, "text/plain"]] as const) {
      const served = await fetchFile(file.url);
      expect(served.headers.get("Content-Type"), file.name).toBe(type);
      expect(served.headers.get("Content-Disposition"), file.name).toMatch(/^attachment;/);
    }
  });

  it("serves the byte ranges asked for, one as it is and several as multipart/byteranges", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const moon = recordedImage("moon-thumb.jpg");
    const file = await uploadFile(ada, room, "moon.jpg", moon);

    const first = await fetchFile(file.url, { Range: "bytes=0-9" });
    expect(first.status).toBe(206);
    expect(first.headers.get("Content-Range")).toBe(`bytes 0-9/${moon.length}`);
    expect(first.headers.get("Content-Length")).toBe("10");
    expect(first.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(moon.subarray(0, 10));
    const end = await fetchFile(file.url, { Range: "bytes=-5" });
    expect(end.headers.get("Content-Range")).toBe(`bytes ${moon.length - 5}-${moon.length - 1}/${moon.length}`);
    expect(new Uint8Array(await end.arrayBuffer())).toEqual(moon.subarray(-5));

    const several = await fetchFile(file.url, { Range: "bytes=0-1, 10-12" });
    expect(several.status).toBe(206);
    const boundary = several.headers.get("Content-Type")!.match(/^multipart\/byteranges; boundary=([0-9a-f]{32})$/)![1];
    const part = (start: number, end: number) =>
      `\r\n--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Range: bytes ${start}-${end}/${moon.length}\r\n\r\n${String.fromCharCode(...moon.subarray(start, end + 1))}`;
    const body = `${part(0, 1)}${part(10, 12)}\r\n--${boundary}--\r\n`;
    const sent = new Uint8Array(await several.arrayBuffer());
    expect(String.fromCharCode(...sent)).toBe(body);
    expect(several.headers.get("Content-Length")).toBe(String(sent.length));

    const head = await fetchFile(file.url, { Range: "bytes=0-9" }, "HEAD");
    expect(head.status).toBe(206);
    expect(head.headers.get("Content-Range")).toBe(`bytes 0-9/${moon.length}`);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("answers 416 for ranges the file doesn't have, and sends the whole file for a header Rack can't read or too many ranges", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const moon = recordedImage("moon-thumb.jpg");
    const file = await uploadFile(ada, room, "moon.jpg", moon);

    const unsatisfiable = await fetchFile(file.url, { Range: `bytes=${moon.length}-` });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("Content-Range")).toBe(`bytes */${moon.length}`);
    expect(unsatisfiable.headers.get("Content-Type")).toBe("image/jpeg");
    expect(unsatisfiable.headers.has("Last-Modified")).toBe(false);
    expect(await unsatisfiable.text()).toBe("Byte range unsatisfiable\n");

    for (const range of ["items=0-1", "bytes=5-1", `bytes=${"0-0,".repeat(49)}1-1`]) {
      const whole = await fetchFile(file.url, { Range: range });
      expect(whole.status, range).toBe(200);
      expect((await whole.arrayBuffer()).byteLength, range).toBe(moon.length);
    }
    // As many as Rack would send one by one, here still within a request's calls to R2.
    expect((await fetchFile(file.url, { Range: `bytes=${"0-0,".repeat(48)}1-1` })).status).toBe(206);
  });

  it("answers 304 to a browser whose copy is as new, and the file to one whose copy is older", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const file = await uploadFile(ada, room, "moon.jpg", recordedImage("moon-thumb.jpg"));
    const lastModified = (await fetchFile(file.url)).headers.get("Last-Modified")!;

    // The very time, as Rack::Files checks it.
    const same = await fetchFile(file.url, { "If-Modified-Since": lastModified });
    expect(same.status).toBe(304);
    expect(same.headers.get("Content-Type")).toBe("image/jpeg");
    expect(same.headers.get("Cache-Control")).toBe("max-age=3600, public");
    expect(same.headers.has("Last-Modified")).toBe(false);
    // Any later time, as Rack::ConditionalGet checks it, unless the browser names a version too.
    const later = new Date(Date.parse(lastModified) + 60_000).toUTCString();
    const newer = await fetchFile(file.url, { "If-Modified-Since": later });
    expect(newer.status).toBe(304);
    expect(newer.headers.has("Content-Type")).toBe(false);
    expect((await fetchFile(file.url, { "If-Modified-Since": later, "If-None-Match": '"v1"' })).status).toBe(200);
    const earlier = new Date(Date.parse(lastModified) - 60_000).toUTCString();
    expect((await fetchFile(file.url, { "If-Modified-Since": earlier })).status).toBe(200);
  });

  it("answers an empty 404 for an address Ember didn't make or a file it doesn't have, and Campfire's 404 page to anything but a read", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const file = await uploadFile(ada, room, "moon.jpg", recordedImage("moon-thumb.jpg"));
    const [, , key, signature] = file.url.split("/") as [string, string, string, string];
    const tampered = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    const other = await (await fileSigner("test-secret"))("0".repeat(28), "moon.jpg");
    for (const path of [
      `/files/${key}/${tampered}/moon.jpg`,
      `/files/${key}/${signature}x/moon.jpg`,
      `/files/${key.toUpperCase()}/${signature}/moon.jpg`,
      `/files/${"0".repeat(28)}/${signature}/moon.jpg`,
      other.url,
    ]) {
      const response = await fetchFile(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("Content-Type"), path).toBe("text/html");
      expect(await response.text(), path).toBe("");
    }
    // Another Worker's addresses, signed with another secret.
    expect((await apiWith({ SESSION_SECRET: "another-secret" }, file.url)).status).toBe(404);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await api(file.url, { method, headers: { Cookie: ada.cookie } });
      expect(response.status, method).toBe(404);
      expect(await response.text(), method).toContain("<html");
    }
  });
});

describe("250 MB file limit", () => {
  it("refuses a file over 250 MB before any of it arrives, and takes one of exactly 250 MB in 24 parts", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const tooLarge = await startUpload(ada, room, newUpload("earth.png", MAX_FILE_SIZE + 1, "image/png"));
    expect(tooLarge.status).toBe(413);
    expect(await errorOf(tooLarge)).toBe(FILE_TOO_LARGE);
    const largest = await startUpload(ada, room, newUpload("earth.png", MAX_FILE_SIZE, "image/png"));
    expect(largest.status).toBe(201);
    const { id, ...parts } = (await largest.json()) as Upload;
    expect(parts).toEqual({ partSize: UPLOAD_PART_SIZE, parts: 24 });
    // The room keeps only the file it took.
    expect(await roomSql(room, "SELECT id FROM blobs")).toEqual([{ id }]);
  });

  it("takes each part only at its length, the first before the others", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const earth = fileOf(UPLOAD_PART_SIZE + 10);
    const upload = await started(ada, room, "earth.png", earth);

    const short = await sendPart(ada, room, upload.id, 1, earth.subarray(0, 100));
    expect(short.status).toBe(400);
    expect(await errorOf(short)).toBe(`Part 1 is ${UPLOAD_PART_SIZE} bytes`);
    const long = await sendPart(ada, room, upload.id, 2, earth.subarray(UPLOAD_PART_SIZE - 1));
    expect(long.status).toBe(413);
    expect(await errorOf(long)).toBe("Part 2 is 10 bytes");
    const early = await sendPart(ada, room, upload.id, 2, partOf(earth, upload, 2));
    expect(early.status).toBe(409);
    expect(await errorOf(early)).toBe("The first part goes first");
    const streamed = new ReadableStream({
      start(controller) {
        controller.enqueue(partOf(earth, upload, 2));
        controller.close();
      },
    });
    const unmeasured = await api(uploadPartPath(room, upload.id, 2), { method: "PUT", headers: { Cookie: ada.cookie }, body: streamed });
    expect(unmeasured.status).toBe(411);
    // Parts the file doesn't have.
    expect((await sendPart(ada, room, upload.id, 3, earth.subarray(0, 1))).status).toBe(404);
    expect((await sendPart(ada, room, upload.id, 0, earth.subarray(0, 1))).status).toBe(404);

    expect((await sendPart(ada, room, upload.id, 1, partOf(earth, upload, 1))).status).toBe(204);
    expect((await sendPart(ada, room, upload.id, 2, partOf(earth, upload, 2))).status).toBe(201);
  });
});

describe("Only members see a room", () => {
  it("lets only the room's members upload to it, each to their own uploads, once signed in", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const design = await createRoom("design", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const file = newUpload("moon.jpg", 1);

    const outsider = await startUpload(linus, design.id, file);
    expect(outsider.status).toBe(404);
    expect(await errorOf(outsider)).toBe("Room not found or inaccessible");
    expect((await api(`/api/rooms/${design.id}/uploads`, { method: "POST", body: JSON.stringify(file) })).status).toBe(401);
    expect((await startUpload(ada, "nowhere" as RoomId, file)).status).toBe(404);
    expect((await startUpload(ada, "no%20room" as RoomId, file)).status).toBe(404);

    const upload = await started(ada, design.id, "moon.jpg", new Uint8Array(1));
    const notTheirs = await sendPart(grace, design.id, upload.id, 1, new Uint8Array(1));
    expect(notTheirs.status).toBe(404);
    expect(await errorOf(notTheirs)).toBe("Upload not found");
    expect((await sendPart(linus, design.id, upload.id, 1, new Uint8Array(1))).status).toBe(404);
    expect((await api(uploadPartPath(design.id, upload.id, 1), { method: "PUT", body: new Uint8Array(1) })).status).toBe(401);
    expect(await blobOf(design.id, upload.id)).toMatchObject({ metadata: null, completed_at: null });
  });

  it("stops an upload once its uploader leaves the room, and refuses uploads to a deleted room", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const design = await createRoom("design", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const earth = fileOf(UPLOAD_PART_SIZE + 10);
    const upload = await started(grace, design.id, "earth.png", earth);
    expect((await sendPart(grace, design.id, upload.id, 1, partOf(earth, upload, 1))).status).toBe(204);

    const change = await api(`/api/rooms/${design.id}`, { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ kind: "closed", memberIds: [ada.user.id] }) });
    expect(change.status).toBe(200);
    const after = await sendPart(grace, design.id, upload.id, 2, partOf(earth, upload, 2));
    expect(after.status).toBe(404);
    expect(await errorOf(after)).toBe("Room not found or inaccessible");
    expect(await blobOf(design.id, upload.id)).toMatchObject({ completed_at: null });

    expect((await api(`/api/rooms/${design.id}`, { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(204);
    expect((await startUpload(ada, design.id, newUpload("moon.jpg", 1))).status).toBe(404);
  });

  it("refuses an upload once the room hears the uploader's access ended after the Workspace let them in", async () => {
    const grace = await signIn("Grace");
    const room = await freshRoom("lobby");
    const file = newUpload("moon.jpg", 1);
    const authorizedAt = Date.now();
    const uploader = (at: number) => ({ user: shown(grace.user), tags: [grace.user.id], authorizedAt: at });
    await roomStub(room).revoke(room, [{ tag: grace.user.id, code: CloseCode.NotFound }], authorizedAt);

    expect(await roomStub(room).startUpload(room, uploader(authorizedAt), file)).toBeNull();
    const { key } = (await roomStub(room).startUpload(room, uploader(authorizedAt + 1), file)) as { key: string };
    expect(key).toMatch(KEY);
    const identified = { contentType: "image/jpeg", metadata: '{"identified":true,"analyzed":true}' };
    expect(await roomStub(room).identifyUpload(room, uploader(authorizedAt), key, identified, "multipart", { partNumber: 1, etag: "a" })).toBeNull();
    expect(await roomStub(room).recordUploadPart(room, uploader(authorizedAt), key, { partNumber: 2, etag: "a" })).toBeNull();
    expect(await roomStub(room).finishUpload(room, uploader(authorizedAt), key, identified)).toBeNull();
    expect(await blobOf(room, key)).toMatchObject({ metadata: null, completed_at: null, message_id: null });
    expect(await roomSql(room, "SELECT id FROM messages WHERE room_id = ?", room)).toEqual([]);
  });

  it("lets only an upload's uploader send its preview, while they're in the room", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const design = await createRoom("design", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const upload = await started(ada, design.id, "moon.jpg", new Uint8Array(1), "image/jpeg");
    const preview = recordedImage("moon-avatar.webp");

    const notTheirs = await sendPreview(grace, design.id, upload.id, preview);
    expect(notTheirs.status).toBe(404);
    expect(await errorOf(notTheirs)).toBe("Upload not found");
    const outsider = await sendPreview(linus, design.id, upload.id, preview);
    expect(outsider.status).toBe(404);
    expect(await errorOf(outsider)).toBe("Room not found or inaccessible");
    expect((await api(uploadPreviewPath(design.id, upload.id), { method: "PUT", body: preview })).status).toBe(401);
    expect(await blobOf(design.id, upload.id)).toMatchObject({ preview: null });

    // As the room hears that Ada's access ended after the Workspace let her in.
    const authorizedAt = Date.now();
    await roomStub(design.id).revoke(design.id, [{ tag: ada.user.id, code: CloseCode.NotFound }], authorizedAt);
    const uploader = { user: shown(ada.user), tags: [ada.user.id], authorizedAt };
    expect(await roomStub(design.id).recordUploadPreview(design.id, uploader, upload.id, { width: 1, height: 1 })).toBeNull();
    expect(await blobOf(design.id, upload.id)).toMatchObject({ preview: null });
  });
});

describe("Health check", () => {
  it("answers 503 to an upload, and 404 at a file's address, when no bucket is bound", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const file = await uploadFile(ada, room, "moon.jpg", recordedImage("moon-thumb.jpg"));
    const unbound = { FILES: undefined } satisfies Partial<Env>;

    const response = await apiWith(unbound, `/api/rooms/${room}/uploads`, { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify(newUpload("moon.jpg", 1)) });
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toBe("Ember isn't set up to store files");
    expect((await apiWith(unbound, file.url)).status).toBe(404);
    const upload = await started(ada, room, "moon.jpg", new Uint8Array(1));
    const preview = recordedImage("moon-avatar.webp");
    const headers = { Cookie: ada.cookie, "Content-Length": String(preview.length) };
    expect((await apiWith(unbound, uploadPreviewPath(room, upload.id), { method: "PUT", headers, body: preview })).status).toBe(503);
  });
});
