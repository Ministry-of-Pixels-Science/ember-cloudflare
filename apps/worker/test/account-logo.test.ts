import { LOGO_PATH, LOGO_TOO_LARGE, MAX_LOGO_SIZE, type Account, type Bootstrap, type NewWorkspace } from "@ember/protocol";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { api, apiWith, cookieOf, freshDeploy, openWorkspaceSocket, origin, recordedImage, shown, signIn, workspaceSql, type Session } from "./support";

// Campfire's logo controller and the logo picker in workspace settings.

const files = (env as unknown as Env).FILES!;

const CACHE_CONTROL = "max-age=300, public, stale-while-revalidate=604800";
const LONG_AGO = "2026-01-01T00:00:00.000Z";

/** The stock icons, as the built app's files have them. */
const icons: Record<string, Uint8Array> = {
  "/logos/app-icon.png": Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1),
  "/logos/app-icon-192.png": Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2),
};

/** Stands in for the built app's files, which the worker tests run without. */
const builtFiles = {
  fetch: async (input: Request | string | URL) => {
    const icon = icons[new URL(input instanceof Request ? input.url : input).pathname];
    return icon ? new Response(icon, { headers: { "Content-Type": "image/png" } }) : new Response("Not found", { status: 404 });
  },
} as unknown as Fetcher;

const logo = (path: string, init?: RequestInit<IncomingRequestCfProperties>) => apiWith({ ASSETS: builtFiles }, path, init);

const bytesOf = async (body: { arrayBuffer(): Promise<ArrayBuffer> }) => new Uint8Array(await body.arrayBuffer());

beforeEach(freshDeploy);

describe("Workspace logo", () => {
  it("serves Ember's stock app icon to anyone, and its 192-pixel one for size=small, kept five minutes and then a week while it's checked", async () => {
    const large = await logo("/account/logo");
    expect(large.status).toBe(200);
    expect(await bytesOf(large)).toEqual(icons["/logos/app-icon.png"]);
    expect(large.headers.get("Content-Type")).toBe("image/png");
    expect(large.headers.get("Content-Disposition")).toBe(`inline; filename="app-icon.png"; filename*=UTF-8''app-icon.png`);
    expect(large.headers.get("Cache-Control")).toBe(CACHE_CONTROL);

    const small = await logo("/account/logo?size=small");
    expect(await bytesOf(small)).toEqual(icons["/logos/app-icon-192.png"]);
    expect(small.headers.get("Content-Disposition")).toBe(`inline; filename="app-icon-192.png"; filename*=UTF-8''app-icon-192.png`);
    expect(small.headers.get("ETag")).not.toBe(large.headers.get("ETag"));

    // The route takes a format.
    expect(await bytesOf(await logo("/account/logo.png"))).toEqual(icons["/logos/app-icon.png"]);
  });

  it("tells a browser whose copy is current that it is, and how long to keep it, and answers HEAD without the image", async () => {
    const etag = (await logo("/account/logo")).headers.get("ETag")!;
    expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);

    const unchanged = await logo("/account/logo", { headers: { "If-None-Match": etag } });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("Cache-Control")).toBe(CACHE_CONTROL);

    const head = await logo("/account/logo", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("image/png");
    expect(await head.text()).toBe("");
  });

  it("answers 404 to anything but GET and HEAD", async () => {
    expect((await logo("/account/logo", { method: "POST" })).status).toBe(404);
    expect((await logo("/account/logo/large")).status).toBe(404);
  });
});

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const body = JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" });
  const response = await api("/api/first_run", { method: "POST", body });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

const as = (session: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** black_hole.jpg's thumbnail, standing in for the logo as it's chosen. */
const blackHole = (name = "black_hole.jpg", type = "image/jpeg") => new File([recordedImage("black_hole-thumb.jpg")], name, { type });

/** The variants of black_hole.jpg, PNGs within 512×512 and 192×192, standing in for the ones the browser makes. */
const largeVariant = () => new File([recordedImage("black_hole-logo-large.png")], "blob", { type: "image/png" });
const smallVariant = () => new File([recordedImage("black_hole-logo-small.png")], "blob", { type: "image/png" });

/** A form with `logo` and the `large` and `small` variants made of it, as the app sends one. */
function logoForm(file: File | string | null, large?: File | string, small?: File | string): FormData {
  const form = new FormData();
  if (file !== null) form.append("logo", file);
  if (large !== undefined) form.append("large", large);
  if (small !== undefined) form.append("small", small);
  return form;
}

/** Uploads `form` as the workspace's logo as `session`, as workspace settings do once a logo is chosen. */
async function upload(session: Session | null, form: FormData, bindings: Partial<Env> = {}): Promise<Response> {
  const request = new Request(origin, { method: "POST", body: form });
  const body = await request.arrayBuffer();
  const headers = { "Content-Type": request.headers.get("Content-Type")!, "Content-Length": String(body.byteLength) };
  return apiWith(bindings, LOGO_PATH, { method: "PUT", headers: { ...as(session), ...headers }, body });
}

/** Uploads black_hole.jpg as the workspace's logo as `session`, answering the account then. */
async function uploadBlackHole(session: Session): Promise<Account> {
  const response = await upload(session, logoForm(blackHole(), largeVariant(), smallVariant()));
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { account: Account }).account;
}

const removeLogo = (session: Session | null) => api(LOGO_PATH, { method: "DELETE", headers: as(session) });

interface LogoColumns {
  logo_key: string | null;
  logo_variant: string | null;
  updated_at: string;
}

const logoColumns = async () => ((await workspaceSql("SELECT logo_key, logo_variant, updated_at FROM accounts")) as LogoColumns[])[0]!;

/** The types R2 keeps the logo at `key` as, and its variants within 512×512 and 192×192. */
const storedAt = async (key: string) =>
  Promise.all([key, `${key}/512`, `${key}/192`].map(async (object) => (await files.head(object))?.httpMetadata?.contentType ?? null));

/** Everything R2 keeps of logos. */
const storedLogos = async () => (await files.list({ prefix: "logos/" })).objects.map(({ key }) => key);

const pendingDeletions = () => workspaceSql("SELECT object_key FROM pending_picture_deletions ORDER BY object_key");

/** Waits for the Workspace to have R2 delete the pictures it has queued, and to forget them. */
const deleted = () => vi.waitFor(async () => expect(await pendingDeletions()).toEqual([]), { timeout: 5_000 });

const bootstrap = async () => (await (await api("/api/bootstrap")).json()) as Bootstrap;

/** Waits for the clock's next second, as the logo's address counts seconds. */
async function nextSecond(): Promise<void> {
  const second = Math.floor(Date.now() / 1000);
  await vi.waitFor(() => expect(Math.floor(Date.now() / 1000)).toBeGreaterThan(second), { timeout: 2_000, interval: 50 });
}

/** The logo's address, versioned by when the account last changed, as `to_fs(:number)` writes it. */
const LOGO_ADDRESS = /^\/account\/logo\?v=\d{14}$/;

describe("Workspace logo", () => {
  it("gives the workspace the logo an administrator uploads, served to anyone as the variants their browser made", async () => {
    const ada = await setUp();

    const account = await uploadBlackHole(ada);
    // Its address is versioned by when the account changed, now.
    expect(account.logo).toBe(`/account/logo?v=${(await logoColumns()).updated_at.slice(0, 19).replace(/\D/g, "")}`);
    expect((await bootstrap()).account).toEqual(account);

    const large = await api(account.logo!);
    expect(large.status).toBe(200);
    expect(large.headers.get("Content-Type")).toBe("image/png");
    expect(large.headers.get("Content-Length")).toBe(String(recordedImage("black_hole-logo-large.png").length));
    expect(large.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
    expect(large.headers.get("ETag")).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(await bytesOf(large)).toEqual(recordedImage("black_hole-logo-large.png"));
    const small = await api(`${account.logo}&size=small`);
    expect(await bytesOf(small)).toEqual(recordedImage("black_hole-logo-small.png"));
    expect(small.headers.get("ETag")).not.toBe(large.headers.get("ETag"));

    const { logo_key: key, logo_variant: variant } = await logoColumns();
    expect(key).toMatch(/^logos\/[0-9a-z]{28}$/);
    expect(variant).toBe("image/png");
    expect(await storedAt(key!)).toEqual(["image/jpeg", "image/png", "image/png"]);
    expect(await bytesOf((await files.get(key!))!)).toEqual(recordedImage("black_hole-thumb.jpg"));
    // Giving it to the workspace took its reservation, so it's kept.
    expect(await pendingDeletions()).toEqual([]);
  });

  it("answers 304 for the browser's current copy of a variant, and HEAD with its headers alone", async () => {
    const { logo: address } = await uploadBlackHole(await setUp());
    const etag = (await api(address!)).headers.get("ETag")!;

    const fresh = await api(address!, { headers: { "If-None-Match": etag } });
    expect(fresh.status).toBe(304);
    expect(fresh.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
    expect(await fresh.text()).toBe("");

    const head = await api(address!, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("image/png");
    expect(head.headers.get("ETag")).toBe(etag);
    expect(await head.text()).toBe("");
  });

  it("tells every open page of the logo's address, and names it in the manifest's icons", async () => {
    const ada = await setUp();
    const grace = await signIn("Grace Hopper");
    const socket = await openWorkspaceSocket(grace);

    const account = await uploadBlackHole(ada);
    expect(await socket.next()).toEqual({ type: "account.updated", account });
    const manifest = (await (await api("/webmanifest.json")).json()) as { icons: Array<{ src: string }> };
    expect(manifest.icons.map(({ src }) => src)).toEqual([`${account.logo}&size=small`, account.logo, account.logo]);
  });

  it("gives the logo a new address whenever the account changes, as renaming the workspace does", async () => {
    const ada = await setUp();
    const { logo: before } = await uploadBlackHole(ada);
    await nextSecond();
    const renamed = await api("/api/account", { method: "PATCH", headers: as(ada), body: JSON.stringify({ name: "Analytical Engines" }) });
    const { account } = (await renamed.json()) as { account: Account };
    expect(account.logo).toMatch(LOGO_ADDRESS);
    expect(account.logo).not.toBe(before);
    expect((await bootstrap()).account.logo).toBe(account.logo);
  });

  it("keeps any file, serving the stock icon for one Campfire doesn't resize, whatever it's named", async () => {
    const ada = await setUp();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    // An SVG named and typed as a JPEG, with the variants the browser drew of it.
    const response = await upload(ada, logoForm(new File([svg], "logo.jpg", { type: "image/jpeg" }), largeVariant(), smallVariant()));
    expect(response.status).toBe(200);
    const { account } = (await response.json()) as { account: Account };
    // It still counts as the workspace's logo, so it can be removed.
    expect(account.logo).toMatch(LOGO_ADDRESS);

    expect(await bytesOf(await logo(account.logo!))).toEqual(icons["/logos/app-icon.png"]);
    expect(await bytesOf(await logo(`${account.logo}&size=small`))).toEqual(icons["/logos/app-icon-192.png"]);
    const { logo_key: key, logo_variant: variant } = await logoColumns();
    expect(variant).toBeNull();
    expect(await storedAt(key!)).toEqual(["image/svg+xml", null, null]);
  });

  it("serves the stock icon for a logo the browser couldn't make variants of, or whose variants R2 has lost", async () => {
    const ada = await setUp();
    const undrawn = await upload(ada, logoForm(blackHole()));
    expect(undrawn.status).toBe(200);
    expect(await bytesOf(await logo("/account/logo"))).toEqual(icons["/logos/app-icon.png"]);
    expect(await storedAt((await logoColumns()).logo_key!)).toEqual(["image/jpeg", null, null]);
    // Both variants or neither, so that a logo has both sizes.
    expect((await upload(ada, logoForm(blackHole(), largeVariant()))).status).toBe(200);
    expect((await logoColumns()).logo_variant).toBeNull();

    await uploadBlackHole(ada);
    await files.delete(`${(await logoColumns()).logo_key}/192`);
    const lost = await logo("/account/logo?size=small");
    expect(lost.headers.get("Content-Disposition")).toBe(`inline; filename="app-icon-192.png"; filename*=UTF-8''app-icon-192.png`);
    expect(await bytesOf(lost)).toEqual(icons["/logos/app-icon-192.png"]);
  });

  it("serves the stock icon without a bucket, though the workspace has a logo", async () => {
    await uploadBlackHole(await setUp());
    const unbound = await apiWith({ ASSETS: builtFiles, FILES: undefined }, "/account/logo");
    expect(await bytesOf(unbound)).toEqual(icons["/logos/app-icon.png"]);
  });

  it("has R2 delete the logo a new one replaces, and the one Remove logo takes away, telling every open page", async () => {
    const ada = await setUp();
    await uploadBlackHole(ada);
    const first = (await logoColumns()).logo_key!;
    await uploadBlackHole(ada);
    const second = (await logoColumns()).logo_key!;
    expect(second).not.toBe(first);
    await deleted();
    expect((await storedLogos()).sort()).toEqual([second, `${second}/192`, `${second}/512`]);

    const socket = await openWorkspaceSocket(ada);
    const response = await removeLogo(ada);
    expect(response.status).toBe(200);
    const { account } = (await response.json()) as { account: Account };
    expect(account).toEqual({ name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true });
    expect(await socket.next()).toEqual({ type: "account.updated", account });
    expect(await bytesOf(await logo("/account/logo"))).toEqual(icons["/logos/app-icon.png"]);
    expect(await logoColumns()).toMatchObject({ logo_key: null, logo_variant: null });
    await deleted();
    expect(await storedLogos()).toEqual([]);
  });

  it("changes nothing when an administrator removes a logo the workspace hasn't got", async () => {
    const ada = await setUp();
    await workspaceSql("UPDATE accounts SET updated_at = ?", LONG_AGO);
    const response = await removeLogo(ada);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { account: Account }).account.logo).toBeNull();
    expect((await logoColumns()).updated_at).toBe(LONG_AGO);
  });

  it("refuses a logo from a member, someone signed out, or without a bucket, before storing it", async () => {
    const ada = await setUp();
    const grace = await signIn("Grace Hopper");
    const member = await upload(grace, logoForm(blackHole(), largeVariant(), smallVariant()));
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({ error: "Only administrators can change the workspace" });
    expect((await removeLogo(grace)).status).toBe(403);
    expect((await upload(null, logoForm(blackHole(), largeVariant(), smallVariant()))).status).toBe(401);
    expect((await removeLogo(null)).status).toBe(401);

    const unbound = await upload(ada, logoForm(blackHole(), largeVariant(), smallVariant()), { FILES: undefined });
    expect(unbound.status).toBe(503);
    expect(await unbound.json()).toEqual({ error: "Ember isn't set up to store files" });
    expect(await storedLogos()).toEqual([]);
    expect(await pendingDeletions()).toEqual([]);
  });

  it("refuses what isn't a logo with its variants, storing nothing", async () => {
    const ada = await setUp();
    const refusal = async (form: FormData) => {
      const response = await upload(ada, form);
      return [response.status, ((await response.json()) as { error: string }).error];
    };
    const webp = new File([recordedImage("moon-avatar.webp")], "blob", { type: "image/webp" });

    expect(await refusal(logoForm(null))).toEqual([400, "Choose a logo"]);
    expect(await refusal(logoForm("black_hole.jpg"))).toEqual([400, "Choose a logo"]);
    expect(await refusal(logoForm(blackHole(), "a variant", smallVariant()))).toEqual([400, "A variant is a picture"]);
    expect(await refusal(logoForm(blackHole(), webp, smallVariant()))).toEqual([415, "A logo's variants are PNG images"]);
    expect(await refusal(logoForm(blackHole(), largeVariant(), largeVariant()))).toEqual([422, "A variant fits within 192×192"]);
    // earth.png's own preview is 640×800.
    const tall = new File([recordedImage("earth-thumb.png")], "blob", { type: "image/png" });
    expect(await refusal(logoForm(blackHole(), tall, smallVariant()))).toEqual([422, "A variant fits within 512×512"]);
    expect(await refusal(logoForm(new File([new Uint8Array(MAX_LOGO_SIZE + 1)], "logo.png"), largeVariant(), smallVariant()))).toEqual([413, LOGO_TOO_LARGE]);

    expect(await storedLogos()).toEqual([]);
    expect(await pendingDeletions()).toEqual([]);
    expect((await logoColumns()).logo_key).toBeNull();
  });
});
