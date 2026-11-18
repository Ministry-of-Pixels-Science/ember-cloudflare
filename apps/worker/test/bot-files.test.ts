import { FILE_NAME_NOT_KEPT, type BotAnswer, type BotSettings, type NewWorkspace, type RoomId } from "@ember/protocol";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { objectKey } from "../src/files/blobs";
import { imageSize } from "../src/files/images";
import { NO_STORAGE, UPLOAD_PART_SIZE } from "../src/files/uploads";
import { storedPng } from "./png-files";
import {
  api,
  apiWith,
  connect,
  cookieOf,
  createRoom,
  freshDeploy,
  objectSql,
  recordedImage,
  roomSql,
  roomStub,
  settle,
  sharedD1,
  shown,
  upload,
  workspaceSql,
  type Session,
} from "./support";

// A bot's files: a form's `attachment`, as `curl -F "attachment=@<path>"` sends it, posted as the bot's
// message, or given to one of its messages in place of its file. R2 keeps the file as it arrives, as it
// does a browser's upload.

const files = (env as unknown as Env).FILES!;

/** Sets Ember up with Ada as its administrator and a bot, which is in first run's general room. */
async function withBot(): Promise<{ administrator: Session; bot: BotSettings; general: RoomId }> {
  const setUp = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(setUp.status).toBe(201);
  const administrator = { user: shown(((await setUp.json()) as NewWorkspace).user), cookie: cookieOf(setUp) };
  const added = await api("/api/account/bots", { method: "POST", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ name: "Build Bot" }) });
  expect(added.status, await added.clone().text()).toBe(201);
  const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
  return { administrator, bot: ((await added.json()) as BotAnswer).bot, general };
}

/** A room's address for the bot whose key is `key`, and that of its message `id`. */
const botPath = (room: RoomId, key: string, id?: string) => `/rooms/${room}/${key}/messages${id ? `/${id}` : ""}`;

/** A form with `file` as its `attachment`, as `curl -F` sends one. */
function formWith(file: File | string): FormData {
  const form = new FormData();
  form.set("attachment", file);
  return form;
}

/** Sends `body` to `room` as the bot whose key is `key`, a post, or with `id` and PUT, an edit of message `id`. */
const sendAs = (key: string, room: RoomId, body: BodyInit, { id, headers }: { id?: string; headers?: Record<string, string> } = {}) =>
  api(botPath(room, key, id), { method: id ? "PUT" : "POST", body, headers });

/** Posts `file` as the bot whose key is `key`, answering the new message's id. */
async function postedFile(key: string, room: RoomId, file: File): Promise<string> {
  const response = await sendAs(key, room, formWith(file));
  expect(response.status, await response.clone().text()).toBe(201);
  return response.headers.get("Location")!.split("/@")[1]!;
}

/** Posts `text` as the bot whose key is `key`, answering the new message's id. */
async function postedText(key: string, room: RoomId, text: string): Promise<string> {
  const response = await api(botPath(room, key), { method: "POST", body: text, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.headers.get("Location")!.split("/@")[1]!;
}

/** The bytes `form` sends, as a browser writes them. */
const formBody = (form: FormData) => new Request("https://ember.test/", { method: "POST", body: form }).arrayBuffer();

const moon = () => new File([recordedImage("moon-thumb.jpg")], "moon.jpg", { type: "image/jpeg" });

/** What R2 keeps of file `key`, as bytes, or null. */
const keptFile = async (key: string) => {
  const object = await files.get(objectKey(key));
  return object && new Uint8Array(await object.arrayBuffer());
};

/** The keys of the files R2 keeps, or with "previews/", of their previews. */
const storedFiles = async (prefix = "files/") => (await files.list({ prefix })).objects.map(({ key }) => key);

/** What `query` finds in room `room`'s tables, of which a room on DO SQLite has none until it's used. */
async function roomRows<T>(room: RoomId, query: string): Promise<T[]> {
  const unopened = !sharedD1() && (await objectSql(roomStub(room), "SELECT 1 FROM sqlite_master WHERE name = 'messages'")).length === 0;
  return unopened ? [] : ((await roomSql(room, query, room)) as T[]);
}

/** The messages `room` has, oldest first, with what its database holds of their files. */
const storedIn = (room: RoomId) =>
  roomRows<{ id: string; body: string; plain_text: string; file: string | null }>(
    room,
    "SELECT id, body, plain_text, json_extract(attachment, '$.id') AS file FROM messages WHERE room_id = ? ORDER BY id",
  );

/** The key of the file message `id` in `room` has. */
const fileOf = async (room: RoomId, id: string) => (await storedIn(room)).find((message) => message.id === id)!.file!;

/** The uploads `room` has, finished or not. */
const blobsIn = (room: RoomId) => roomRows(room, "SELECT id, byte_size, content_type, completed_at, message_id FROM blobs WHERE room_id = ?");

/**
 * A form, as `curl -F` writes one, with the file `bytes` as its `attachment`, that holds back its last
 * byte until `meanwhile` has run, once the Worker has read the rest.
 */
function heldBackForm(name: string, bytes: Uint8Array, meanwhile: () => Promise<unknown>) {
  const boundary = "------------------------d74496d66958873e";
  const encoder = new TextEncoder();
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const pieces = [head, bytes.subarray(0, -1), bytes.subarray(-1), tail];
  let next = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (next === 2) await meanwhile();
        if (next === pieces.length) return controller.close();
        controller.enqueue(pieces[next++]!);
      },
    },
    { highWaterMark: 0 },
  );
  return { body, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } };
}

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Bots post messages", () => {
  it("posts the file a form sends as `attachment`, as `curl -F` sends one, as the bot's message, which reaches everyone at once", async () => {
    const { administrator, bot, general } = await withBot();
    const inRoom = await connect(general, administrator);

    const response = await sendAs(bot.key, general, formWith(moon()));
    expect(response.status, await response.clone().text()).toBe(201);
    const id = response.headers.get("Location")!.split("/@")[1]!;
    expect(response.headers.get("Location")).toBe(`https://ember.test/rooms/${general}/@${id}`);
    expect(await response.text()).toBe("");

    const { message } = await inRoom.next("message.created");
    expect(message).toMatchObject({
      id,
      creator: { id: bot.id, name: "Build Bot" },
      body: "",
      plainText: "moon.jpg",
      attachment: { name: "moon.jpg", contentType: "image/jpeg", byteSize: recordedImage("moon-thumb.jpg").length, width: 640, height: 640 },
    });
    expect(await keptFile(message.attachment!.id)).toEqual(recordedImage("moon-thumb.jpg"));
    expect(await blobsIn(general)).toEqual([
      { id: message.attachment!.id, byte_size: recordedImage("moon-thumb.jpg").length, content_type: "image/jpeg", completed_at: expect.any(String), message_id: id },
    ]);
    // Served as anyone's upload is.
    const served = await api(message.attachment!.url, { headers: { Cookie: administrator.cookie } });
    expect([served.status, served.headers.get("Content-Type")]).toEqual([200, "image/jpeg"]);
    inRoom.close();
  });

  it("identifies a file by its bytes, then the type the form gives it, then its name, as a browser's upload is", async () => {
    const { administrator, bot, general } = await withBot();
    const inRoom = await connect(general, administrator);
    const typed = async (file: File) => {
      await postedFile(bot.key, general, file);
      return (await inRoom.next("message.created")).message.attachment!.contentType;
    };

    expect(await typed(new File([recordedImage("moon-thumb.jpg")], "moon.txt", { type: "text/plain" }))).toBe("image/jpeg");
    expect(await typed(new File(["{}"], "build.log", { type: "application/json" }))).toBe("application/json");
    expect(await typed(new File(["# Notes"], "notes.md"))).toBe("text/markdown");
    inRoom.close();
  });

  it("has Cloudflare Images make the preview of a picture too large to show by itself, as of a browser's upload sent without one", async () => {
    const { administrator, bot, general } = await withBot();
    const inRoom = await connect(general, administrator);

    await postedFile(bot.key, general, new File([storedPng(1600, 1200)], "screenshot.png", { type: "image/png" }));
    const { attachment } = (await inRoom.next("message.created")).message;
    expect(attachment).toMatchObject({ contentType: "image/png", width: 1600, height: 1200, previewUrl: expect.stringMatching(/^\/previews\//) });
    const preview = await api(attachment!.previewUrl!);
    expect(preview.headers.get("Content-Type")).toBe("image/webp");
    expect(imageSize(new Uint8Array(await preview.arrayBuffer()), "image/webp")).toEqual({ width: 1067, height: 800 });
    expect(await roomSql(general, "SELECT preview FROM blobs WHERE id = ?", attachment!.id)).toEqual([{ preview: JSON.stringify({ width: 1067, height: 800 }) }]);
    inRoom.close();
  });

  it("keeps a file larger than an upload's part as it arrives, a part at a time", async () => {
    const { bot, general } = await withBot();
    const bytes = Uint8Array.from({ length: UPLOAD_PART_SIZE + 3 }, (_, i) => i % 251);

    const id = await postedFile(bot.key, general, new File([bytes], "build.tar"));
    const kept = await keptFile(await fileOf(general, id));
    expect(kept?.length).toBe(bytes.length);
    expect(kept!.every((byte, i) => byte === bytes[i])).toBe(true);
  });

  it("posts the first file the form sends as `attachment`, skipping a file field left empty and the fields before it", async () => {
    const { bot, general } = await withBot();
    const form = new FormData();
    form.append("note", "Here it is");
    form.append("attachment", new File([], ""));
    form.append("attachment", new File(["Report"], "report.txt", { type: "text/plain" }));
    form.append("attachment", new File(["Other"], "other.txt", { type: "text/plain" }));

    expect((await sendAs(bot.key, general, form)).status).toBe(201);
    expect(await storedIn(general)).toMatchObject([{ body: "", plain_text: "report.txt" }]);
    expect(await storedFiles()).toHaveLength(1);
  });

  it("answers an empty 422 to a form with nothing to post, and 422 with why to text, posting nothing", async () => {
    const { bot, general } = await withBot();
    const nothing = new FormData();
    nothing.set("note", "Here it is");

    for (const form of [nothing, formWith(""), formWith(new File([], ""))]) {
      const response = await sendAs(bot.key, general, form);
      expect([response.status, await response.text()]).toEqual([422, ""]);
    }
    const text = await sendAs(bot.key, general, formWith("Report"));
    expect([text.status, await text.json()]).toEqual([422, { error: "An attachment has to be a file" }]);
    expect(await storedIn(general)).toEqual([]);
    expect(await storedFiles()).toEqual([]);
  });

  it("answers 422 to a file whose name can't be kept, storing nothing", async () => {
    const { bot, general } = await withBot();
    const response = await sendAs(bot.key, general, formWith(new File(["Report"], `${"r".repeat(252)}.txt`)));
    expect([response.status, await response.json()]).toEqual([422, { error: FILE_NAME_NOT_KEPT }]);
    expect(await blobsIn(general)).toEqual([]);
    expect(await storedFiles()).toEqual([]);
  });

  it("answers 400 to a form that can't be read, as Rack does, posting nothing", async () => {
    const { bot, general } = await withBot();
    const unread = (body: string) => sendAs(bot.key, general, body, { headers: { "Content-Type": "multipart/form-data; boundary=xyz" } });

    for (const body of ["", "No parts here", '--xyz\r\nContent-Disposition: form-data; name="attachment"; filename="cut.txt"\r\n\r\nCut sh']) {
      const response = await unread(body);
      expect([response.status, await response.json()], body).toEqual([400, { status: 400, error: "Bad Request" }]);
    }
    expect(await storedIn(general)).toEqual([]);
    expect(await storedFiles()).toEqual([]);
  });

  it("answers 400 to a body typed as a form that names no boundary to read it by, posting nothing", async () => {
    const { bot, general } = await withBot();
    const form = await formBody(formWith(new File(["Build passed"], "build.log")));

    for (const type of ["multipart/form-data", `multipart/form-data; boundary=${"x".repeat(71)}`]) {
      const response = await sendAs(bot.key, general, form, { headers: { "Content-Type": type } });
      expect([response.status, await response.json()], type).toEqual([400, { status: 400, error: "Bad Request" }]);
    }
    expect(await storedIn(general)).toEqual([]);
  });

  it("answers 503 without an R2 bucket, as a browser's upload is answered, posting nothing", async () => {
    const { bot, general } = await withBot();
    const response = await apiWith({ FILES: undefined }, botPath(general, bot.key), { method: "POST", body: formWith(moon()) });
    expect([response.status, await response.json()]).toEqual([503, { error: NO_STORAGE }]);
    expect(await storedIn(general)).toEqual([]);
  });

  it("checks the key again once the file has arrived, posting nothing for a bot given a new key meanwhile, and R2 keeps none of it", async () => {
    const { administrator, bot, general } = await withBot();
    const newKey = () => api(`/api/account/bots/${bot.id}/key`, { method: "PUT", headers: { Cookie: administrator.cookie } });
    const { body, headers } = heldBackForm("screenshot.png", storedPng(1600, 1200), newKey);

    const response = await sendAs(bot.key, general, body, { headers });
    expect([response.status, await response.json()]).toEqual([401, { error: "Unknown bot key" }]);
    expect(await storedIn(general)).toEqual([]);
    expect([await storedFiles(), await storedFiles("previews/")]).toEqual([[], []]);
  });

  it("posts nothing once the room has been deleted while the file arrives, and R2 keeps none of it", async () => {
    const { administrator, bot } = await withBot();
    const room = await createRoom("Launch", { as: administrator });
    const deleteRoom = async () => expect((await api(`/api/rooms/${room.id}`, { method: "DELETE", headers: { Cookie: administrator.cookie } })).status).toBe(204);
    const { body, headers } = heldBackForm("launch.log", new TextEncoder().encode("Launched"), deleteRoom);

    expect((await sendAs(bot.key, room.id, body, { headers })).status).toBe(404);
    await vi.waitFor(async () => expect(await storedFiles()).toEqual([]));
  });
});

describe("Bots edit and delete their messages", () => {
  it("gives the bot's own message the file a form sends with PUT or PATCH, in place of the one it had, live, answering the message as the list has it", async () => {
    const { administrator, bot, general } = await withBot();
    const id = await postedFile(bot.key, general, new File(["Build failed"], "build.log", { type: "text/plain" }));
    const replaced = await fileOf(general, id);
    const inRoom = await connect(general, administrator);

    const response = await sendAs(bot.key, general, formWith(moon()), { id });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ id, body: { plain_text: "moon.jpg", html: "" }, creator: { id: bot.id } });
    const { message } = await inRoom.next("message.updated");
    expect(message).toMatchObject({ id, plainText: "moon.jpg", attachment: { name: "moon.jpg", contentType: "image/jpeg" } });
    expect(message.editedAt).not.toBeNull();
    // R2 deletes the file it had, as it does a deleted message's.
    await vi.waitFor(async () => expect(await keptFile(replaced)).toBeNull());
    expect(await keptFile(message.attachment!.id)).toEqual(recordedImage("moon-thumb.jpg"));

    const patched = await api(botPath(general, bot.key, id), { method: "PATCH", body: formWith(new File(["Build passed"], "build.log")) });
    expect([patched.status, ((await patched.json()) as { body: { plain_text: string } }).body.plain_text]).toEqual([200, "build.log"]);
    inRoom.close();
  });

  it("gives a message of text a file, keeping its text", async () => {
    const { bot, general } = await withBot();
    const id = await postedText(bot.key, general, "Build log attached");

    const response = await sendAs(bot.key, general, formWith(new File(["Build passed"], "build.log")), { id });
    expect(response.status).toBe(200);
    expect(await storedIn(general)).toMatchObject([{ id, plain_text: "Build log attached", file: expect.any(String) }]);
  });

  it("takes a message's file away when the form's `attachment` is empty, and R2 deletes it", async () => {
    const { administrator, bot, general } = await withBot();
    const id = await postedFile(bot.key, general, moon());
    const file = await fileOf(general, id);
    const inRoom = await connect(general, administrator);

    const response = await sendAs(bot.key, general, formWith(""), { id });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, body: { plain_text: "", html: "" } });
    const { message } = await inRoom.next("message.updated");
    expect(message).toMatchObject({ id, plainText: "" });
    expect(message.attachment).toBeUndefined();
    await vi.waitFor(async () => expect(await keptFile(file)).toBeNull());

    // A message without a file stays as it was.
    expect((await sendAs(bot.key, general, formWith(""), { id })).status).toBe(200);
    await settle(inRoom);
    expect(inRoom.pending("message.updated")).toEqual([]);
    inRoom.close();
  });

  it("answers 403 to someone else's message and 404 JSON to one outside the room, R2 keeping none of the file", async () => {
    const { administrator, bot, general } = await withBot();
    const theirs = await upload(administrator, general, "moon.jpg", recordedImage("moon-thumb.jpg"));

    const forbidden = await sendAs(bot.key, general, formWith(new File(["Build passed"], "build.log")), { id: theirs.id });
    expect([forbidden.status, await forbidden.text()]).toEqual([403, ""]);
    const missing = await sendAs(bot.key, general, formWith(new File(["Build passed"], "build.log")), { id: "0nosuchmessage0" });
    expect([missing.status, await missing.json()]).toEqual([404, { status: 404, error: "Not Found" }]);
    const removing = await sendAs(bot.key, general, formWith(""), { id: theirs.id });
    expect(removing.status).toBe(403);
    expect(await storedIn(general)).toMatchObject([{ id: theirs.id, file: theirs.attachment.id }]);
    expect(await storedFiles()).toEqual([objectKey(theirs.attachment.id)]);
  });

  it("answers 400 to a body typed as a form that names no boundary, changing nothing", async () => {
    const { bot, general } = await withBot();
    const id = await postedText(bot.key, general, "Deploying...");

    const response = await sendAs(bot.key, general, await formBody(formWith(new File(["Deployed"], "deploy.log"))), { id, headers: { "Content-Type": "multipart/form-data" } });
    expect([response.status, await response.json()]).toEqual([400, { status: 400, error: "Bad Request" }]);
    expect(await storedIn(general)).toMatchObject([{ id, plain_text: "Deploying...", file: null }]);
  });

  it("answers an empty 422 to a form without `attachment`, and 422 with why to text, changing nothing", async () => {
    const { bot, general } = await withBot();
    const id = await postedText(bot.key, general, "Deploying...");
    const nothing = new FormData();
    nothing.set("note", "Deployed");

    const empty = await sendAs(bot.key, general, nothing, { id });
    expect([empty.status, await empty.text()]).toEqual([422, ""]);
    const text = await sendAs(bot.key, general, formWith("Deployed"), { id });
    expect([text.status, await text.json()]).toEqual([422, { error: "An attachment has to be a file" }]);
    expect(await storedIn(general)).toMatchObject([{ id, plain_text: "Deploying...", file: null }]);
  });
});
