import {
  MAX_ACCOUNT_NAME_LENGTH,
  MAX_TAGLINE_LENGTH,
  NAVIGATION_ICONS_REFUSED,
  TAGLINE_TOO_LONG,
  type Account,
  type Bootstrap,
  type EmailSettings,
  type Me,
  type NewJoinCode,
  type NewWorkspace,
  type Sidebar,
  type WorkspaceSettings,
} from "@ember/protocol";
import { TOP_LEVELS } from "@ember/protocol/assistant";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsFor } from "../src/auth";
import type { Env } from "../src/env";
import type { Workspace } from "../src/workspace";
import type { JoinableAccount, WorkspaceStore } from "../src/workspace-store";
import { api, cookieOf, freshDeploy, openWorkspaceSocket, origin, shown, signIn, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" };

/** The workspace named `name`, as pages show a new one: translation buttons hidden, no custom CSS, and rooms anyone can create. */
const named = (name: string): Account => ({ name, tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false });

/** How a new workspace sends email: with the binding wrangler.jsonc declares, from no address yet. */
const NEW_EMAIL: EmailSettings = { provider: "cloudflare", resendKey: null, cloudflare: true, from: null };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

const settings = (session?: Session) => api("/api/account", { headers: as(session) });

const change = (session: Session | null, body: unknown, headers: Record<string, string> = {}) =>
  api("/api/account", { method: "PATCH", headers: { ...as(session), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

const regenerate = (session: Session | null, headers: Record<string, string> = {}) =>
  api("/api/account/join_code", { method: "POST", headers: { ...as(session), ...headers } });

const bootstrap = async (session?: Session) => (await (await api("/api/bootstrap", { headers: as(session) })).json()) as Bootstrap;

const storedAccount = async () => ((await workspaceSql("SELECT name, updated_at FROM accounts")) as Array<{ name: string; updated_at: string }>)[0]!;

const storedSettings = async () => ((await workspaceSql("SELECT settings, updated_at FROM accounts")) as Array<{ settings: string | null; updated_at: string }>)[0]!;

const storedJoinCode = async () => ((await workspaceSql("SELECT join_code FROM accounts")) as Array<{ join_code: string }>)[0]!.join_code;

/** Grace joins with the join link, as a member, signed in. */
async function joinAsGrace(): Promise<Session> {
  const response = await api(`/api/join/${await storedJoinCode()}`, { method: "POST", body: JSON.stringify(grace) });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** A join code: 12 letters and digits, in fours. */
const JOIN_CODE = /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){2}$/;

/** What the Workspace's store would answer, from inside the Workspace. */
const storeOf = (workspace: Workspace) => (workspace as unknown as { store: WorkspaceStore }).store;

beforeEach(freshDeploy);

describe("Community settings page", () => {
  it("shows members and administrators the workspace, its join code, and whether they can change it", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const joinCode = await storedJoinCode();
    expect(await (await settings(administrator)).json()).toEqual({ account: named("Ember"), joinCode, canAdminister: true, memberfulSite: null, memberfulWebhooks: false, turnstile: null, email: NEW_EMAIL, invitations: [], emailDomains: [], addresses: { deployed: null, others: [] }, assistant: null, huddles: null, outsideAi: false, cloudflareAccountId: null } satisfies WorkspaceSettings);
    expect(await (await settings(member)).json()).toEqual({ account: named("Ember"), joinCode, canAdminister: false, memberfulSite: null, memberfulWebhooks: false, turnstile: null, email: NEW_EMAIL, invitations: [], emailDomains: [], addresses: { deployed: null, others: [] }, assistant: null, huddles: null, outsideAi: false, cloudflareAccountId: null } satisfies WorkspaceSettings);
  });

  it("gives someone who signed in with just a name no join code, which would let them stay once guests are turned away, unless they're an administrator", async () => {
    const administrator = await setUp();
    const guest = await signIn("Mallory");
    expect(await (await settings(guest)).json()).toEqual({ account: named("Ember"), joinCode: null, canAdminister: false, memberfulSite: null, memberfulWebhooks: false, turnstile: null, email: NEW_EMAIL, invitations: [], emailDomains: [], addresses: { deployed: null, others: [] }, assistant: null, huddles: null, outsideAi: false, cloudflareAccountId: null } satisfies WorkspaceSettings);

    // An administrator could make a new code anyway.
    const promoted = await api(`/api/account/users/${guest.user.id}`, { method: "PATCH", headers: as(administrator), body: JSON.stringify({ role: "administrator" }) });
    expect(promoted.status).toBe(200);
    expect(((await (await settings(guest)).json()) as WorkspaceSettings).joinCode).toBe(await storedJoinCode());
  });

  it("asks who's signed in", async () => {
    await setUp();
    expect((await settings()).status).toBe(401);
  });

  it("has nothing to show before first run", async () => {
    const response = await settings(await signIn("Grace"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Ember isn't set up yet" });
  });
});

describe("Rail", () => {
  it("tells the app whether whoever is signed in is an administrator, for the rail's Admin link", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");
    expect((await bootstrap(administrator)).user).toEqual({ ...administrator.user, administrator: true });
    expect((await bootstrap(member)).user).toEqual({ ...member.user, administrator: false });
    expect(await (await api("/api/me", { headers: as(administrator) })).json()).toEqual({ user: { ...administrator.user, administrator: true } });
    expect(await (await api("/api/me", { headers: as(member) })).json()).toEqual({ user: { ...member.user, administrator: false } });
  });
});

describe("Rename the workspace", () => {
  it("renames the workspace for an administrator, wherever its name shows", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();

    const response = await change(administrator, { name: "Ember Studio" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: named("Ember Studio") });
    expect((await storedAccount()).name).toBe("Ember Studio");

    expect(await (await settings(member)).json()).toEqual({ account: named("Ember Studio"), joinCode: await storedJoinCode(), canAdminister: false, memberfulSite: null, memberfulWebhooks: false, turnstile: null, email: NEW_EMAIL, invitations: [], emailDomains: [], addresses: { deployed: null, others: [] }, assistant: null, huddles: null, outsideAi: false, cloudflareAccountId: null } satisfies WorkspaceSettings);
    expect((await bootstrap(member)).account).toEqual(named("Ember Studio"));
    // "Sign in to <name>", and the installed app's name.
    expect((await bootstrap()).account).toEqual(named("Ember Studio"));
    expect(await (await api("/webmanifest.json")).json()).toMatchObject({ name: "Ember Studio" });
  });

  it("saves the name as typed, even blank", async () => {
    const administrator = await setUp();
    for (const name of ["  Ember Studio ", "", "x".repeat(MAX_ACCOUNT_NAME_LENGTH)]) {
      expect(await (await change(administrator, { name })).json()).toEqual({ account: named(name) });
      expect((await storedAccount()).name).toBe(name);
      expect((await bootstrap()).account).toEqual(named(name));
    }
  });

  it("records when the name changed, but not when it's saved unchanged", async () => {
    const administrator = await setUp();
    const long = "2026-01-01T00:00:00.000Z";
    await workspaceSql("UPDATE accounts SET updated_at = ?", long);

    for (const body of [{ name: "Ember" }, {}]) {
      const response = await change(administrator, body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ account: named("Ember") });
      expect(await storedAccount()).toEqual({ name: "Ember", updated_at: long });
    }

    await change(administrator, { name: "Ember Studio" });
    expect((await storedAccount()).updated_at > long).toBe(true);
  });

  it("tells everyone's workspace sockets the new name", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace)];

    // Neither a name saved unchanged nor a new join code changes what pages show.
    await change(administrator, { name: "Ember" });
    await regenerate(administrator);
    await change(administrator, { name: "Ember Studio" });
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "account.updated", account: named("Ember Studio") });
  });

  it("lets only administrators rename it, and tells anyone else so before looking at what they sent", async () => {
    await setUp();
    const member = await signIn("Grace");
    for (const body of [{ name: "Grace's place" }, "not JSON", { name: 7 }]) {
      const response = await change(member, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators can change the workspace" });
    }
    expect((await storedAccount()).name).toBe("Ember");
  });

  it("checks who's an administrator as they are when they rename it", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");
    await workspaceSql("UPDATE users SET role = 0 WHERE id = ?", administrator.user.id);
    expect((await change(administrator, { name: "Ada's place" })).status).toBe(403);

    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", member.user.id);
    expect((await change(member, { name: "Grace's place" })).status).toBe(200);
    expect((await storedAccount()).name).toBe("Grace's place");
  });

  it.each([
    ["no body", "", "Expected a JSON object"],
    ["a list", [], "Expected a JSON object"],
    ["a name that isn't text", { name: null }, `Name must be at most ${MAX_ACCOUNT_NAME_LENGTH} characters`],
    ["a name that's too long", { name: "x".repeat(MAX_ACCOUNT_NAME_LENGTH + 1) }, `Name must be at most ${MAX_ACCOUNT_NAME_LENGTH} characters`],
  ])("refuses %s, changing nothing", async (_, body, error) => {
    const administrator = await setUp();
    const response = await change(administrator, body);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error });
    expect((await storedAccount()).name).toBe("Ember");
  });

  it("asks who's signed in, and refuses a rename sent from another site", async () => {
    const administrator = await setUp();
    expect((await change(null, { name: "Anyone's" })).status).toBe(401);
    expect((await change(administrator, { name: "Phished" }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(422);
    expect((await storedAccount()).name).toBe("Ember");
  });

  it("reads the name again after a rename whose answer was lost", async () => {
    const administrator = await setUp();
    expect((await bootstrap()).account.name).toBe("Ember");
    // On D1 a write can be saved and its answer lost on the way back.
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const store = storeOf(workspace);
      const rename = store.changeAccount.bind(store);
      vi.spyOn(store, "changeAccount").mockImplementationOnce(async (...args) => {
        await rename(...args);
        throw new Error("The database's answer was lost");
      });
    });
    expect((await change(administrator, { name: "Ember Studio" })).status).toBe(500);
    expect((await bootstrap()).account.name).toBe("Ember Studio");
  });

  it("doesn't keep a name read while the workspace was being renamed", async () => {
    const administrator = await setUp();
    const credentials = await credentialsFor(administrator.cookie.split("=")[1]!, new Request(origin), env as unknown as Env);
    // Started afresh, the Workspace has to read the account again.
    await evictDurableObject(workspaceStub());
    await runInDurableObject(workspaceStub(), async (workspace: Workspace) => {
      // On D1 a read can start before the rename and finish after it, with the name from before.
      let finishReading!: (account: JoinableAccount | null) => void;
      vi.spyOn(storeOf(workspace), "account").mockReturnValueOnce(new Promise((resolve) => (finishReading = resolve)));
      const reading = workspace.bootstrap(null, null, null);
      expect(await workspace.changeAccount(credentials, { name: "Ember Studio" }, "ember.test")).toEqual(named("Ember Studio"));
      finishReading({ ...named("Ember"), joinCode: "aB3d-Ef5h-iJ7k", updatedAt: new Date().toISOString(), storedLogo: null, emailFrom: null, resendApiKey: null, deployedAddress: null, otherAddresses: [], turnstileKeys: null, assistant: null, assistantMost: TOP_LEVELS, assistantInstructions: "", assistantPromptTemplate: null, huddles: null, outsideAi: false });
      await reading;
    });
    expect((await bootstrap()).account.name).toBe("Ember Studio");
  });
});

describe("Workspace tagline", () => {
  const TAGLINE = "Engines for every occasion";
  /** The new workspace, with `tagline`. */
  const tagged = (tagline: string): Account => ({ ...named("Ember"), tagline });

  it("has none until an administrator gives it one", async () => {
    expect((await bootstrap()).account.tagline).toBe("");
    const administrator = await setUp();
    expect((await bootstrap(administrator)).account.tagline).toBe("");
    expect(((await (await settings(administrator)).json()) as WorkspaceSettings).account.tagline).toBe("");
  });

  it("gives the workspace a tagline for an administrator, which every page has, keeping the other settings", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");

    const response = await change(administrator, { tagline: TAGLINE });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: tagged(TAGLINE) });
    expect(JSON.parse((await storedSettings()).settings!)).toEqual({ restrict_room_creation_to_administrators: false, tagline: TAGLINE });
    expect((await bootstrap(member)).account).toEqual(tagged(TAGLINE));
    expect(((await (await settings(member)).json()) as WorkspaceSettings).account).toEqual(tagged(TAGLINE));
    // Signing in and joining have the whole account too.
    expect((await bootstrap()).account).toEqual(tagged(TAGLINE));
  });

  it("keeps it on one line, with no space at either end, and takes it away when it's blank", async () => {
    const administrator = await setUp();
    expect(await (await change(administrator, { tagline: "  Engines\tfor\n\nevery   occasion " })).json()).toEqual({ account: tagged(TAGLINE) });
    // As long as it can be, once it's kept, though more was sent.
    const longest = "x".repeat(MAX_TAGLINE_LENGTH);
    expect(await (await change(administrator, { tagline: `  ${longest}\n` })).json()).toEqual({ account: tagged(longest) });
    expect(await (await change(administrator, { tagline: " \n " })).json()).toEqual({ account: named("Ember") });
    expect(JSON.parse((await storedSettings()).settings!)).toEqual({ restrict_room_creation_to_administrators: false, tagline: "" });
  });

  it("saves it with the name, recording when only if either changed", async () => {
    const administrator = await setUp();
    const long = "2026-01-01T00:00:00.000Z";
    await workspaceSql("UPDATE accounts SET updated_at = ?", long);

    // As workspace settings send both, with the tagline blank before there's one.
    const unchanged = await change(administrator, { name: "Ember", tagline: "" });
    expect(await unchanged.json()).toEqual({ account: named("Ember") });
    expect(await storedSettings()).toEqual({ settings: '{"restrict_room_creation_to_administrators":false}', updated_at: long });

    const changed = await change(administrator, { name: "Ember", tagline: TAGLINE });
    expect(await changed.json()).toEqual({ account: tagged(TAGLINE) });
    expect((await storedSettings()).updated_at > long).toBe(true);
  });

  it("tells everyone's workspace sockets the new tagline", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace)];

    // A tagline saved unchanged changes nothing pages show.
    await change(administrator, { tagline: "" });
    await change(administrator, { tagline: TAGLINE });
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "account.updated", account: tagged(TAGLINE) });
  });

  it("lets only administrators change it, and tells anyone else so before looking at what they sent", async () => {
    await setUp();
    const member = await signIn("Grace");
    for (const body of [{ tagline: TAGLINE }, { tagline: 7 }]) {
      const response = await change(member, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators can change the workspace" });
    }
    expect((await bootstrap()).account).toEqual(named("Ember"));
  });

  it.each([
    ["a tagline that's too long", { tagline: "x".repeat(MAX_TAGLINE_LENGTH + 1) }],
    ["one that isn't text", { tagline: null }],
    ["a good name beside a bad tagline", { name: "Ember Studio", tagline: [TAGLINE] }],
  ])("refuses %s, changing nothing", async (_, body) => {
    const administrator = await setUp();
    const response = await change(administrator, body);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: TAGLINE_TOO_LONG });
    expect((await bootstrap()).account).toEqual(named("Ember"));
  });

  it.each([
    ["one", '{"tagline":"Engines for every occasion"}', TAGLINE],
    ["none", '{"restrict_room_creation_to_administrators":false}', ""],
    ["one that isn't text", '{"tagline":7}', ""],
    ["settings that don't parse", "not JSON", ""],
  ])("reads %s from the account's settings", async (_, stored, tagline) => {
    await setUp();
    await workspaceSql("UPDATE accounts SET settings = ?", stored);
    // Started afresh, the Workspace has to read the account again.
    await evictDurableObject(workspaceStub());
    expect((await bootstrap()).account.tagline).toBe(tagline);
  });
});

describe("Navigation icons", () => {
  /** The new workspace, with `navigationIcons`. */
  const iconed = (navigationIcons: Account["navigationIcons"]): Account => ({ ...named("Ember"), navigationIcons });
  const storedIcons = async () => (JSON.parse((await storedSettings()).settings!) as { ember_navigation_icons?: unknown }).ember_navigation_icons;

  it("has none chosen until an administrator chooses some", async () => {
    expect((await bootstrap()).account.navigationIcons).toEqual({});
    const administrator = await setUp();
    expect((await bootstrap(administrator)).account.navigationIcons).toEqual({});
  });

  it("gives the rail's buttons and appearance modes the icons an administrator chooses, which every page has", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");

    const response = await change(administrator, { navigationIcons: { home: "coffee", dark: "iconoir:solid:heart" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: iconed({ home: "coffee", dark: "iconoir:solid:heart" }) });
    expect(JSON.parse((await storedSettings()).settings!)).toEqual({
      restrict_room_creation_to_administrators: false,
      ember_navigation_icons: { home: "coffee", dark: "iconoir:solid:heart" },
    });
    expect((await bootstrap(member)).account).toEqual(iconed({ home: "coffee", dark: "iconoir:solid:heart" }));
    expect((await bootstrap()).account).toEqual(iconed({ home: "coffee", dark: "iconoir:solid:heart" }));
  });

  it("changes only the slots a change names, giving back a slot's own icon for \"\" or its own name", async () => {
    const administrator = await setUp();
    await change(administrator, { navigationIcons: { home: "coffee", dms: "mail", search: "telescope" } });

    const response = await change(administrator, { navigationIcons: { home: "", dms: "iconoir:regular:multi-bubble", system: "monitor-cog" } });
    expect(await response.json()).toEqual({ account: iconed({ search: "telescope", system: "monitor-cog" }) });
    expect(await storedIcons()).toEqual({ search: "telescope", system: "monitor-cog" });
    // Evicted, the Workspace reads them as they're kept.
    await evictDurableObject(workspaceStub());
    expect((await bootstrap()).account.navigationIcons).toEqual({ search: "telescope", system: "monitor-cog" });
  });

  it("saves them with the name and the other settings, keeping the room order and favorites, and records when only if they changed", async () => {
    const administrator = await setUp();
    await workspaceSql("UPDATE accounts SET settings = ?", '{"ember_default_room_order":[3,1],"ember_favorite_channels":{"7":[3]},"tagline":"Engines"}');
    await evictDurableObject(workspaceStub());
    const long = "2026-01-01T00:00:00.000Z";
    await workspaceSql("UPDATE accounts SET updated_at = ?", long);

    // A slot given the icon it has, or its own while it has its own, changes nothing.
    await change(administrator, { name: "Ember", navigationIcons: { home: "", activity: "iconoir:regular:bell" } });
    expect((await storedSettings()).updated_at).toBe(long);

    const response = await change(administrator, { name: "Ember", tagline: "Engines", settings: { hideTranslationButtons: false }, navigationIcons: { admin: "settings" } });
    expect((await response.json()) as { account: Account }).toMatchObject({ account: { tagline: "Engines", hideTranslationButtons: false, navigationIcons: { admin: "settings" } } });
    expect(JSON.parse((await storedSettings()).settings!)).toEqual({
      ember_default_room_order: [3, 1],
      ember_favorite_channels: { "7": [3] },
      tagline: "Engines",
      hide_translation_buttons: false,
      ember_navigation_icons: { admin: "settings" },
    });
    expect((await storedSettings()).updated_at > long).toBe(true);
  });

  it("tells everyone's workspace sockets the icons", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace)];

    // Choosing the slot's own icon changes nothing pages show.
    await change(administrator, { navigationIcons: { light: "iconoir:regular:sun-light" } });
    await change(administrator, { navigationIcons: { light: "sun" } });
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "account.updated", account: iconed({ light: "sun" }) });
  });

  it("lets only administrators choose them, and tells anyone else so before looking at what they sent", async () => {
    await setUp();
    const member = await signIn("Grace");
    for (const body of [{ navigationIcons: { home: "coffee" } }, { navigationIcons: { home: "<svg></svg>" } }]) {
      const response = await change(member, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators can change the workspace" });
    }
    expect((await bootstrap()).account).toEqual(named("Ember"));
  });

  it.each([
    ["a slot it doesn't know", { navigationIcons: { profile: "coffee" } }],
    ["an icon that isn't in the catalog", { navigationIcons: { home: "iconoir:regular:../coffee-cup" } }],
    ["icons that aren't an object", { navigationIcons: ["coffee"] }],
    ["a good name beside a bad icon", { name: "Ember Studio", navigationIcons: { home: "Coffee" } }],
  ])("refuses %s, changing nothing", async (_, body) => {
    const administrator = await setUp();
    const response = await change(administrator, body);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: NAVIGATION_ICONS_REFUSED });
    expect((await bootstrap()).account).toEqual(named("Ember"));
  });

  it.each([
    ["some", '{"ember_navigation_icons":{"home":"coffee","dark":"iconoir:solid:heart"}}', { home: "coffee", dark: "iconoir:solid:heart" }],
    ["none", '{"restrict_room_creation_to_administrators":false}', {}],
    ["icons that aren't an object", '{"ember_navigation_icons":["coffee"]}', {}],
    ["an icon or a slot it doesn't know", '{"ember_navigation_icons":{"home":"no-such-icon","profile":"coffee","dms":7,"search":"telescope"}}', { search: "telescope" }],
    ["settings that don't parse", "not JSON", {}],
  ])("reads %s from the account's settings", async (_, stored, navigationIcons) => {
    await setUp();
    await workspaceSql("UPDATE accounts SET settings = ?", stored);
    await evictDurableObject(workspaceStub());
    expect((await bootstrap()).account.navigationIcons).toEqual(navigationIcons);
  });

  it.each([
    ["icons that aren't an object", '{"ember_navigation_icons":"coffee","tagline":"Engines"}', { tagline: "Engines", ember_navigation_icons: { home: "coffee" } }],
    ["settings that don't parse", "not JSON", { ember_navigation_icons: { home: "coffee" } }],
  ])("starts afresh from %s", async (_, stored, settings) => {
    const administrator = await setUp();
    await workspaceSql("UPDATE accounts SET settings = ?", stored);
    await evictDurableObject(workspaceStub());
    expect((await change(administrator, { navigationIcons: { home: "coffee" } })).status).toBe(200);
    expect(JSON.parse((await storedSettings()).settings!)).toEqual(settings);
  });
});

describe("Join link", () => {
  it("keeps settings, which hold the join code, out of every cache", async () => {
    const response = await settings(await setUp());
    expect((await response.json()) as WorkspaceSettings).toMatchObject({ joinCode: expect.stringMatching(JOIN_CODE) });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("Translation buttons", () => {
  const shown = { ...named("Ember"), hideTranslationButtons: false };

  it("hides them until an administrator shows them, before first run too", async () => {
    expect((await bootstrap()).account.hideTranslationButtons).toBe(true);
    const administrator = await setUp();
    expect((await bootstrap()).account.hideTranslationButtons).toBe(true);
    expect((await bootstrap(administrator)).account.hideTranslationButtons).toBe(true);
  });

  it("shows or hides them for everyone as an administrator switches them, keeping the other settings", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");

    const response = await change(administrator, { settings: { hideTranslationButtons: false } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: shown });
    expect(JSON.parse((await storedSettings()).settings!)).toEqual({ restrict_room_creation_to_administrators: false, hide_translation_buttons: false });
    // Sign-in and join show them too.
    expect((await bootstrap()).account).toEqual(shown);
    expect(((await (await settings(grace)).json()) as WorkspaceSettings).account).toEqual(shown);

    await change(administrator, { settings: { hideTranslationButtons: true } });
    expect(JSON.parse((await storedSettings()).settings!)).toEqual({ restrict_room_creation_to_administrators: false, hide_translation_buttons: true });
    expect((await bootstrap(grace)).account).toEqual(named("Ember"));
  });

  it.each([
    ["no setting", '{"restrict_room_creation_to_administrators":false}', true],
    ["true", '{"hide_translation_buttons":true}', true],
    ["false", '{"hide_translation_buttons":false}', false],
    ["null", '{"hide_translation_buttons":null}', false],
    ["blank text", '{"hide_translation_buttons":" "}', false],
    ["other text", '{"hide_translation_buttons":"no"}', true],
    ["a number", '{"hide_translation_buttons":0}', true],
    ["an empty list", '{"hide_translation_buttons":[]}', false],
    ["settings that aren't an object", "[]", true],
    ["settings that don't parse", "not JSON", true],
  ])("reads %s", async (_, stored, hidden) => {
    await setUp();
    await workspaceSql("UPDATE accounts SET settings = ?", stored);
    // Started afresh, the Workspace has to read the account again.
    await evictDurableObject(workspaceStub());
    expect((await bootstrap()).account.hideTranslationButtons).toBe(hidden);
  });

  it("hides them while there are no settings at all", async () => {
    await setUp();
    await workspaceSql("UPDATE accounts SET settings = NULL");
    await evictDurableObject(workspaceStub());
    expect((await bootstrap()).account.hideTranslationButtons).toBe(true);
  });

  it("saves the setting with the name, recording when only if either changed", async () => {
    const administrator = await setUp();
    const long = "2026-01-01T00:00:00.000Z";
    await workspaceSql("UPDATE accounts SET updated_at = ?", long);

    const unchanged = await change(administrator, { name: "Ember", settings: { hideTranslationButtons: true } });
    expect(await unchanged.json()).toEqual({ account: named("Ember") });
    expect(await storedSettings()).toEqual({ settings: '{"restrict_room_creation_to_administrators":false}', updated_at: long });

    const changed = await change(administrator, { name: "Ember Studio", settings: { hideTranslationButtons: false } });
    expect(await changed.json()).toEqual({ account: { ...shown, name: "Ember Studio" } });
    expect((await storedAccount()).name).toBe("Ember Studio");
    expect((await storedSettings()).updated_at > long).toBe(true);
  });

  it("starts the settings afresh when they don't parse", async () => {
    const administrator = await setUp();
    await workspaceSql("UPDATE accounts SET settings = ?", "not JSON");
    await evictDurableObject(workspaceStub());
    expect((await change(administrator, { settings: { hideTranslationButtons: false } })).status).toBe(200);
    expect(JSON.parse((await storedSettings()).settings!)).toEqual({ hide_translation_buttons: false });
  });

  it("tells everyone's workspace sockets once it changes", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace)];

    await change(administrator, { settings: { hideTranslationButtons: true } });
    await change(administrator, { settings: { hideTranslationButtons: false } });
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "account.updated", account: shown });
  });

  it("lets only administrators switch them, and tells anyone else so before looking at what they sent", async () => {
    await setUp();
    const grace = await signIn("Grace");
    for (const body of [{ settings: { hideTranslationButtons: false } }, { settings: { logo: "earth.png" } }]) {
      const response = await change(grace, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators can change the workspace" });
    }
    expect((await bootstrap()).account).toEqual(named("Ember"));
  });

  it.each([
    ["a setting it doesn't know", { settings: { restrictRoomCreationToAdministrators: true } }, "Unknown setting: restrictRoomCreationToAdministrators"],
    ["a setting that isn't true or false", { settings: { hideTranslationButtons: "false" } }, "Hide translation buttons must be true or false"],
    ["settings that aren't an object", { settings: "hide" }, "Settings must be a JSON object"],
    ["a good change beside a bad one", { name: "Ember Studio", settings: { hideTranslationButtons: false, logo: "earth.png" } }, "Unknown setting: logo"],
  ])("refuses %s, changing nothing", async (_, body, error) => {
    const administrator = await setUp();
    const response = await change(administrator, body);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error });
    expect((await bootstrap()).account).toEqual(named("Ember"));
  });
});

describe("Regenerate the join link", () => {
  it("gives the join link a new code for an administrator, wherever the link shows", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const old = await storedJoinCode();
    const long = "2026-01-01T00:00:00.000Z";
    await workspaceSql("UPDATE accounts SET updated_at = ?", long);

    const response = await regenerate(administrator);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { joinCode } = (await response.json()) as NewJoinCode;
    expect(joinCode).toMatch(JOIN_CODE);
    expect(joinCode).not.toBe(old);
    expect(await storedJoinCode()).toBe(joinCode);
    // As Campfire's `reset_join_code` does, which changes the logo's address too.
    expect((await storedAccount()).updated_at > long).toBe(true);

    expect(((await (await settings(member)).json()) as WorkspaceSettings).joinCode).toBe(joinCode);
    const sidebar = (await (await api("/api/sidebar", { headers: as(administrator) })).json()) as Sidebar;
    expect(sidebar.invitation?.joinCode).toBe(joinCode);
  });

  it("lets only administrators regenerate it, as they are when they do", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");
    const old = await storedJoinCode();
    const refused = await regenerate(member);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Only administrators can change the workspace" });

    await workspaceSql("UPDATE users SET role = 0 WHERE id = ?", administrator.user.id);
    expect((await regenerate(administrator)).status).toBe(403);
    expect(await storedJoinCode()).toBe(old);

    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", member.user.id);
    expect((await regenerate(member)).status).toBe(200);
    expect(await storedJoinCode()).not.toBe(old);
  });

  it("asks who's signed in, and refuses a request from another site", async () => {
    const administrator = await setUp();
    const old = await storedJoinCode();
    expect((await regenerate(null)).status).toBe(401);
    expect((await regenerate(administrator, { "Sec-Fetch-Site": "cross-site" })).status).toBe(422);
    expect(await storedJoinCode()).toBe(old);
  });

  it("reads the code again after a change whose answer was lost", async () => {
    const administrator = await setUp();
    expect(((await (await settings(administrator)).json()) as WorkspaceSettings).joinCode).toBe(await storedJoinCode());
    // On D1 a write can be saved and its answer lost on the way back.
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const store = storeOf(workspace);
      const change = store.changeJoinCode.bind(store);
      vi.spyOn(store, "changeJoinCode").mockImplementationOnce(async (...args) => {
        await change(...args);
        throw new Error("The database's answer was lost");
      });
    });
    expect((await regenerate(administrator)).status).toBe(500);
    expect(((await (await settings(administrator)).json()) as WorkspaceSettings).joinCode).toBe(await storedJoinCode());
  });

  it("doesn't keep a code read while it was being regenerated", async () => {
    const administrator = await setUp();
    const old = await storedJoinCode();
    const credentials = await credentialsFor(administrator.cookie.split("=")[1]!, new Request(origin), env as unknown as Env);
    // Started afresh, the Workspace has to read the account again.
    await evictDurableObject(workspaceStub());
    const regenerated = await runInDurableObject(workspaceStub(), async (workspace: Workspace) => {
      // On D1 a read can start before the change and finish after it, with the code from before.
      let finishReading!: (account: JoinableAccount | null) => void;
      vi.spyOn(storeOf(workspace), "account").mockReturnValueOnce(new Promise((resolve) => (finishReading = resolve)));
      const reading = workspace.bootstrap(null, null, null);
      const regenerated = await workspace.regenerateJoinCode(credentials);
      finishReading({ ...named("Ember"), joinCode: old, updatedAt: new Date().toISOString(), storedLogo: null, emailFrom: null, resendApiKey: null, deployedAddress: null, otherAddresses: [], turnstileKeys: null, assistant: null, assistantMost: TOP_LEVELS, assistantInstructions: "", assistantPromptTemplate: null, huddles: null, outsideAi: false });
      await reading;
      return regenerated;
    });
    expect(regenerated).toEqual({ joinCode: await storedJoinCode() });
    expect(((await (await settings(administrator)).json()) as WorkspaceSettings).joinCode).toBe(await storedJoinCode());
  });
});
