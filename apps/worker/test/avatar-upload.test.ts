import { AVATAR_PATH, AVATAR_TOO_LARGE, avatarSvg, MAX_AVATAR_SIZE, type Directory, type DirectoryUser, type NewWorkspace, type Profile, type ProfileAnswer, type UserId } from "@ember/protocol";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { MAX_PICTURE_REQUEST } from "../src/files/pictures";
import type { Workspace } from "../src/workspace";
import { api, apiWith, avatarVersionOf, cookieOf, freshDeploy, openWorkspaceSocket, origin, recordedImage, shown, signIn, stopTheClock, workspaceSql, workspaceStub, type Session } from "./support";

// Avatars people upload, setup and sign-up forms take them.

const bindings = env as unknown as Env;
const files = bindings.FILES!;

const CACHE_CONTROL = "max-age=1800, public, stale-while-revalidate=604800";
const LONG_AGO = "2026-01-01T00:00:00.000Z";

beforeEach(freshDeploy);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const as = (session: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** moon.jpg, a JPEG of 640×640. */
const moon = (name = "moon.jpg", type = "image/jpeg") => new File([recordedImage("moon-thumb.jpg")], name, { type });

/** The variant of moon.jpg, a WebP of 512×512, standing in for the one the browser makes. */
const moonVariant = () => new File([recordedImage("moon-avatar.webp")], "blob", { type: "image/webp" });

/** A form with `avatar` and the `variant` made of it, as the app sends one, with `fields` before them. */
function photoForm(avatar: File | string | null, variant?: File | string, fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  if (avatar !== null) form.append("avatar", avatar);
  if (variant !== undefined) form.append("variant", variant);
  return form;
}

/** `form` as a browser sends it, with its length. */
async function encoded(form: FormData): Promise<{ body: ArrayBuffer; headers: Record<string, string> }> {
  const request = new Request(origin, { method: "POST", body: form });
  const body = await request.arrayBuffer();
  return { body, headers: { "Content-Type": request.headers.get("Content-Type")!, "Content-Length": String(body.byteLength) } };
}

/** Uploads `form` as `session`'s avatar, as the profile does once a picture is chosen. */
async function upload(session: Session | null, form: FormData): Promise<Response> {
  const { body, headers } = await encoded(form);
  return api(AVATAR_PATH, { method: "PUT", headers: { ...as(session), ...headers }, body });
}

/** Uploads moon.jpg as `session`'s avatar, answering their profile then. */
async function uploadMoon(session: Session): Promise<ProfileAnswer> {
  const response = await upload(session, photoForm(moon(), moonVariant()));
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ProfileAnswer;
}

const removeAvatar = (session: Session | null) => api(AVATAR_PATH, { method: "DELETE", headers: as(session) });

/** Saves `bio` on the profile of the person `session` signs in. */
const saveBio = (session: Session, bio: string) => api("/api/users/me/profile", { method: "PATCH", headers: as(session), body: JSON.stringify({ bio }) });

/** Someone as the directory lists them, as `viewer` sees it. */
async function listed(viewer: Session, userId: UserId): Promise<DirectoryUser> {
  const { users } = (await (await api("/api/users", { headers: as(viewer) })).json()) as Directory;
  return users.find((user) => user.id === userId)!;
}

/** Fetches the avatar at `path` as `viewer`. */
const avatar = (path: string, viewer: Session, init: RequestInit = {}) => api(path, { ...init, headers: { ...as(viewer), ...init.headers } });

/** What R2 keeps of the picture at `key`, and of its variant. */
const storedAt = async (key: string) => [(await files.head(key))?.httpMetadata?.contentType ?? null, (await files.head(`${key}/512`))?.httpMetadata?.contentType ?? null];

/** Everything R2 keeps of avatars. */
const storedAvatars = async () => (await files.list({ prefix: "avatars/" })).objects.map(({ key }) => key);

interface AvatarColumns {
  avatar_key: string | null;
  avatar_variant: string | null;
  updated_at: string;
}

const avatarColumnsOf = async (userId: UserId) =>
  ((await workspaceSql("SELECT avatar_key, avatar_variant, updated_at FROM users WHERE id = ?", userId)) as AvatarColumns[])[0]!;

const pendingDeletions = () => workspaceSql("SELECT object_key, attempts FROM pending_picture_deletions ORDER BY object_key");

/** Waits for the Workspace to have R2 delete the pictures it has queued, and to forget them. */
const deleted = () => vi.waitFor(async () => expect(await pendingDeletions()).toEqual([]), { timeout: 5_000 });

/** Has the Workspace find R2 failing to delete anything, until what this answers is called. */
async function breakDeletes(): Promise<() => Promise<void>> {
  const failing = { delete: () => Promise.reject(new Error("R2 is unreachable")) } as unknown as R2Bucket;
  let original: Env | undefined;
  await runInDurableObject(workspaceStub(), (instance: Workspace) => {
    const object = instance as unknown as { env: Env };
    original = object.env;
    object.env = { ...original, FILES: failing };
  });
  return () => runInDurableObject(workspaceStub(), (instance: Workspace) => void ((instance as unknown as { env: Env }).env = original!));
}

describe("Upload an avatar", () => {
  it("gives you the picture you choose, served as the variant your browser made of it, keeping the picture as it came", async () => {
    const ada = await signIn("Ada Lovelace");
    await workspaceSql("UPDATE users SET updated_at = ? WHERE id = ?", LONG_AGO, ada.user.id);

    const { profile } = await uploadMoon(ada);
    const { avatarUrl } = await listed(ada, ada.user.id);
    expect(profile).toEqual({ name: "Ada Lovelace", emailAddress: null, bio: null, avatarUrl, avatar: true, password: false, membershipNeeded: true, memberful: null, assistant: null, apps: [], outsideAi: null } satisfies Profile);
    // A new picture has a new address, which browsers haven't kept.
    expect(avatarUrl).not.toMatch(/\?v=20260101000000$/);

    const response = await avatar(avatarUrl, ada);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Content-Length")).toBe(String(recordedImage("moon-avatar.webp").length));
    expect(response.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
    expect(response.headers.get("ETag")).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(recordedImage("moon-avatar.webp"));

    const { avatar_key: key, avatar_variant: variant } = await avatarColumnsOf(ada.user.id);
    expect(key).toMatch(/^avatars\/[0-9a-z]{28}$/);
    expect(variant).toBe("image/webp");
    expect(await storedAt(key!)).toEqual(["image/jpeg", "image/webp"]);
    expect(new Uint8Array(await (await files.get(key!))!.arrayBuffer())).toEqual(recordedImage("moon-thumb.jpg"));
    // Giving it to Ada took its reservation, so it's kept.
    expect(await pendingDeletions()).toEqual([]);
  });

  it("answers 304 for the browser's current copy of the picture, and HEAD with its headers alone", async () => {
    const ada = await signIn("Ada Lovelace");
    const { profile } = await uploadMoon(ada);
    const etag = (await avatar(profile.avatarUrl, ada)).headers.get("ETag")!;

    const fresh = await avatar(profile.avatarUrl, ada, { headers: { "If-None-Match": etag } });
    expect(fresh.status).toBe(304);
    expect(fresh.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
    expect(await fresh.text()).toBe("");

    const head = await avatar(profile.avatarUrl, ada, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("image/webp");
    expect(head.headers.get("ETag")).toBe(etag);
    expect(await head.text()).toBe("");
  });

  it("serves everyone the picture, telling every open page of its new address", async () => {
    const ada = await signIn("Ada Lovelace");
    const grace = await signIn("Grace Hopper");
    const socket = await openWorkspaceSocket(grace);

    await uploadMoon(ada);
    const now = await listed(grace, ada.user.id);
    expect(await socket.next()).toEqual({ type: "user.updated", user: now });
    expect(new Uint8Array(await (await avatar(now.avatarUrl, grace)).arrayBuffer())).toEqual(recordedImage("moon-avatar.webp"));
  });

  it("gives each change a later address, even one in the same second as the last, which nothing after takes back, as browsers keep the picture they have at one", async () => {
    // Joining, uploading a photo, saving the profile, replacing the photo and removing it, all at once.
    stopTheClock();
    const ada = await signIn("Ada Lovelace");
    const initials = (await listed(ada, ada.user.id)).avatarUrl;
    const { profile: first } = await uploadMoon(ada);
    const { profile: saved } = (await (await saveBio(ada, "Countess")).json()) as ProfileAnswer;
    const { profile: second } = await uploadMoon(ada);
    const { profile: removed } = (await (await removeAvatar(ada)).json()) as ProfileAnswer;

    const pictures = [initials, first.avatarUrl, second.avatarUrl, removed.avatarUrl].map(avatarVersionOf);
    expect(pictures).toEqual([...pictures].sort((a, b) => a - b));
    expect(new Set(pictures).size).toBe(4);
    // The same picture, at the address it had or a later one.
    expect(avatarVersionOf(saved.avatarUrl)).toBeGreaterThanOrEqual(avatarVersionOf(first.avatarUrl));
    expect(avatarVersionOf(saved.avatarUrl)).toBeLessThan(avatarVersionOf(second.avatarUrl));
    expect((await listed(ada, ada.user.id)).avatarUrl).toBe(removed.avatarUrl);
  });

  it("waits for the next second out of line, holding up nobody else's change", async () => {
    stopTheClock();
    const ada = await signIn("Ada Lovelace");
    const grace = await signIn("Grace Hopper");
    const initials = (await listed(ada, ada.user.id)).avatarUrl;
    // Ada's photo comes in the same second as she joined, so it waits, until the test lets it go. It
    // looks to see, as a promise the Workspace waits for can't be kept from outside it.
    let held = true;
    vi.mocked(scheduler.wait).mockImplementationOnce(async (ms) => {
      while (held) await new Promise((resolve) => setTimeout(resolve, 10));
      vi.setSystemTime(Date.now() + ms);
    });
    const uploading = uploadMoon(ada);
    await vi.waitFor(() => expect(scheduler.wait).toHaveBeenCalledTimes(1));

    expect((await saveBio(grace, "Rear admiral")).status).toBe(200);
    held = false;
    const { profile } = await uploading;
    expect(avatarVersionOf(profile.avatarUrl)).toBeGreaterThan(avatarVersionOf(initials));
  });

  it("keeps any file, serving the initials for one Campfire doesn't resize, whatever it's named", async () => {
    const ada = await signIn("Ada Lovelace");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    // An SVG named and typed as a JPEG, with a variant the browser drew of it.
    const response = await upload(ada, photoForm(new File([svg], "me.jpg", { type: "image/jpeg" }), moonVariant()));
    expect(response.status).toBe(200);
    const { profile } = (await response.json()) as ProfileAnswer;
    expect(profile.avatar).toBe(true);

    expect(await (await avatar(profile.avatarUrl, ada)).text()).toBe(avatarSvg(ada.user.id, "Ada Lovelace"));
    const { avatar_key: key, avatar_variant: variant } = await avatarColumnsOf(ada.user.id);
    expect(variant).toBeNull();
    expect(await storedAt(key!)).toEqual(["image/svg+xml", null]);
  });

  it("serves the initials for a picture the browser couldn't make a variant of, or one R2 has lost", async () => {
    const ada = await signIn("Ada Lovelace");
    const initials = avatarSvg(ada.user.id, "Ada Lovelace");
    const undrawn = await upload(ada, photoForm(moon()));
    expect(undrawn.status).toBe(200);
    const { profile } = (await undrawn.json()) as ProfileAnswer;
    expect(profile.avatar).toBe(true);
    expect(await (await avatar(profile.avatarUrl, ada)).text()).toBe(initials);
    expect(await storedAt((await avatarColumnsOf(ada.user.id)).avatar_key!)).toEqual(["image/jpeg", null]);

    const { profile: drawn } = await uploadMoon(ada);
    await files.delete(`${(await avatarColumnsOf(ada.user.id)).avatar_key}/512`);
    const lost = await avatar(drawn.avatarUrl, ada);
    expect(lost.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(await lost.text()).toBe(initials);
  });

  it("has R2 delete the picture a new one replaces, and the one Remove avatar takes away, bringing back the initials", async () => {
    const ada = await signIn("Ada Lovelace");
    await uploadMoon(ada);
    const first = (await avatarColumnsOf(ada.user.id)).avatar_key!;
    await uploadMoon(ada);
    const second = (await avatarColumnsOf(ada.user.id)).avatar_key!;
    expect(second).not.toBe(first);
    await deleted();
    expect(await storedAvatars()).toEqual([second, `${second}/512`]);

    const socket = await openWorkspaceSocket(ada);
    const response = await removeAvatar(ada);
    expect(response.status).toBe(200);
    const { profile } = (await response.json()) as ProfileAnswer;
    const now = await listed(ada, ada.user.id);
    expect(profile).toEqual({ name: "Ada Lovelace", emailAddress: null, bio: null, avatarUrl: now.avatarUrl, avatar: false, password: false, membershipNeeded: true, memberful: null, assistant: null, apps: [], outsideAi: null } satisfies Profile);
    expect(await socket.next()).toEqual({ type: "user.updated", user: now });
    expect(await (await avatar(now.avatarUrl, ada)).text()).toBe(avatarSvg(ada.user.id, "Ada Lovelace"));
    expect(await avatarColumnsOf(ada.user.id)).toMatchObject({ avatar_key: null, avatar_variant: null });
    await deleted();
    expect(await storedAvatars()).toEqual([]);
  });

  it("changes nothing when you remove an avatar you haven't got", async () => {
    const ada = await signIn("Ada Lovelace");
    await workspaceSql("UPDATE users SET updated_at = ? WHERE id = ?", LONG_AGO, ada.user.id);
    const response = await removeAvatar(ada);
    expect(response.status).toBe(200);
    expect(((await response.json()) as ProfileAnswer).profile).toMatchObject({ avatar: false, avatarUrl: (await listed(ada, ada.user.id)).avatarUrl });
    expect((await avatarColumnsOf(ada.user.id)).updated_at).toBe(LONG_AGO);
  });

  it("has R2 delete a picture nobody was given once its reservation runs out, an hour after it was stored", async () => {
    const key = `avatars/${"a".repeat(28)}`;
    const reservedAt = Date.now();
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => workspace.reservePicture(key));
    await files.put(key, recordedImage("moon-thumb.jpg"));
    await files.put(`${key}/512`, recordedImage("moon-avatar.webp"));
    const { due_at: dueAt } = ((await workspaceSql("SELECT due_at FROM pending_picture_deletions WHERE object_key = ?", key)) as Array<{ due_at: number }>)[0]!;
    expect(dueAt).toBeGreaterThanOrEqual(reservedAt + 60 * 60 * 1000);
    expect(dueAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
    const alarm = await runInDurableObject(workspaceStub(), (_workspace, state: DurableObjectState) => state.storage.getAlarm());
    expect(alarm).toBeLessThanOrEqual(dueAt);

    await workspaceSql("UPDATE pending_picture_deletions SET due_at = ?", Date.now());
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await storedAvatars()).toEqual([]);
    expect(await pendingDeletions()).toEqual([]);
  });

  it("keeps trying to delete a picture while R2 fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ada = await signIn("Ada Lovelace");
    await uploadMoon(ada);
    const replaced = (await avatarColumnsOf(ada.user.id)).avatar_key!;
    const mend = await breakDeletes();

    await uploadMoon(ada);
    await vi.waitFor(async () => expect(await pendingDeletions()).toEqual([{ object_key: replaced, attempts: 1 }]), { timeout: 5_000 });
    expect(errors).toHaveBeenCalledWith("Could not delete pictures from R2; trying again later", expect.any(Error));
    expect(await storedAt(replaced)).toEqual(["image/jpeg", "image/webp"]);

    await mend();
    await workspaceSql("UPDATE pending_picture_deletions SET due_at = ?", Date.now());
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await storedAt(replaced)).toEqual([null, null]);
    expect(await pendingDeletions()).toEqual([]);
  });

  it("refuses a picture from someone signed out, or without a bucket, before storing it", async () => {
    expect((await upload(null, photoForm(moon(), moonVariant()))).status).toBe(401);
    expect((await removeAvatar(null)).status).toBe(401);

    const ada = await signIn("Ada Lovelace");
    const { body, headers } = await encoded(photoForm(moon(), moonVariant()));
    const unbound = await apiWith({ FILES: undefined }, AVATAR_PATH, { method: "PUT", headers: { ...as(ada), ...headers }, body });
    expect(unbound.status).toBe(503);
    expect(await unbound.json()).toEqual({ error: "Ember isn't set up to store files" });
    expect(await storedAvatars()).toEqual([]);
  });

  it("refuses what isn't a picture with its variant, storing nothing", async () => {
    const ada = await signIn("Ada Lovelace");
    const refusal = async (form: FormData) => {
      const response = await upload(ada, form);
      return [response.status, ((await response.json()) as { error: string }).error];
    };
    const gif = new File([Uint8Array.from(atob("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="), (c) => c.charCodeAt(0))], "blob");
    const tall = new File([recordedImage("earth-thumb.png")], "blob", { type: "image/png" });

    expect(await refusal(photoForm(null))).toEqual([400, "Choose a picture"]);
    expect(await refusal(photoForm("moon.jpg"))).toEqual([400, "Choose a picture"]);
    expect(await refusal(photoForm(moon(), "a variant"))).toEqual([400, "A variant is a picture"]);
    expect(await refusal(photoForm(moon(), gif))).toEqual([415, "A variant is a WebP, PNG or JPEG image"]);
    expect(await refusal(photoForm(moon(), new File(["A picture of the moon"], "blob")))).toEqual([415, "A variant is a WebP, PNG or JPEG image"]);
    // earth.png's own preview is 640×800.
    expect(await refusal(photoForm(moon(), tall))).toEqual([422, "A variant fits within 512×512"]);
    expect(await refusal(photoForm(new File([new Uint8Array(MAX_AVATAR_SIZE + 1)], "earth.png"), moonVariant()))).toEqual([413, AVATAR_TOO_LARGE]);

    const length = { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(MAX_PICTURE_REQUEST + 1) };
    const tooLong = await api(AVATAR_PATH, { method: "PUT", headers: { ...as(ada), ...length }, body: new Uint8Array(MAX_PICTURE_REQUEST + 1) });
    expect([tooLong.status, ((await tooLong.json()) as { error: string }).error]).toEqual([413, AVATAR_TOO_LARGE]);
    const streamed = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("--x--"));
        controller.close();
      },
    });
    const unmeasured = await api(AVATAR_PATH, { method: "PUT", headers: { ...as(ada), "Content-Type": "multipart/form-data; boundary=x" }, body: streamed });
    expect(unmeasured.status).toBe(411);

    expect(await storedAvatars()).toEqual([]);
    expect(await pendingDeletions()).toEqual([]);
    expect(await avatarColumnsOf(ada.user.id)).toMatchObject({ avatar_key: null });
  });
});

describe("Set up the workspace", () => {
  const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

  /** Posts the Set up Ember form with `form`'s photo, answering the response. */
  async function firstRun(form: FormData): Promise<Response> {
    const { body, headers } = await encoded(form);
    return api("/api/first_run", { method: "POST", headers, body });
  }

  it("gives the first administrator the photo chosen with the form", async () => {
    const response = await firstRun(photoForm(moon(), moonVariant(), { user: JSON.stringify(ada) }));
    expect(response.status).toBe(201);
    const session = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };

    const { avatarUrl } = await listed(session, session.user.id);
    expect(new Uint8Array(await (await avatar(avatarUrl, session)).arrayBuffer())).toEqual(recordedImage("moon-avatar.webp"));
    expect(await pendingDeletions()).toEqual([]);
  });

  it("refuses a short password before storing the photo, and a photo too large, naming the field", async () => {
    const short = await firstRun(photoForm(moon(), moonVariant(), { user: JSON.stringify({ ...ada, password: "short" }) }));
    expect(short.status).toBe(422);
    expect(await short.json()).toMatchObject({ field: "password" });

    const large = await firstRun(photoForm(new File([new Uint8Array(MAX_AVATAR_SIZE + 1)], "earth.png"), undefined, { user: JSON.stringify(ada) }));
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ error: AVATAR_TOO_LARGE, field: "avatar" });

    expect(await storedAvatars()).toEqual([]);
    expect(await workspaceSql("SELECT id FROM users")).toEqual([]);
  });

  it("takes the form as JSON without a photo, as before", async () => {
    const response = await firstRun(photoForm(null, undefined, { user: JSON.stringify(ada) }));
    expect(response.status).toBe(201);
    const { user } = (await response.json()) as NewWorkspace;
    expect(await avatarColumnsOf(user.id)).toMatchObject({ avatar_key: null, avatar_variant: null });
  });
});

describe("Sign up with the join link", () => {
  const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "first compiler" };

  const joinCode = async () => ((await workspaceSql("SELECT join_code FROM accounts")) as Array<{ join_code: string }>)[0]!.join_code;

  async function join(form: FormData): Promise<Response> {
    const { body, headers } = await encoded(form);
    return api(`/api/join/${await joinCode()}`, { method: "POST", headers, body });
  }

  beforeEach(async () => {
    const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
    expect(response.status).toBe(201);
  });

  it("gives whoever signs up the photo chosen with the form", async () => {
    const response = await join(photoForm(moon(), moonVariant(), { user: JSON.stringify(grace) }));
    expect(response.status).toBe(201);
    const session = { user: shown(((await response.json()) as { user: Session["user"] }).user), cookie: cookieOf(response) };

    const { avatarUrl } = await listed(session, session.user.id);
    expect(new Uint8Array(await (await avatar(avatarUrl, session)).arrayBuffer())).toEqual(recordedImage("moon-avatar.webp"));
    expect(await pendingDeletions()).toEqual([]);
  });

  it("leaves the photo to be deleted when the email address has an account already", async () => {
    const response = await join(photoForm(moon(), moonVariant(), { user: JSON.stringify({ ...grace, emailAddress: "ada@example.com" }) }));
    expect(response.status).toBe(409);
    // Stored before the address was found taken, and reserved for an hour, after which R2 deletes it.
    const [reserved] = (await pendingDeletions()) as Array<{ object_key: string }>;
    expect(await storedAvatars()).toEqual([reserved!.object_key, `${reserved!.object_key}/512`]);
  });
});
