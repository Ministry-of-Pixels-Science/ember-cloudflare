import {
  CUSTOM_DOMAIN_NOT_A_HOST,
  NOT_A_CUSTOM_DOMAIN,
  type Account,
  type BotAnswer,
  type CustomDomainCheck,
  type CustomDomainLookup,
  type BotSettings,
  type Bootstrap,
  type EmberAddresses,
  type NewWorkspace,
  type RoomId,
  type WorkspaceSettings,
} from "@ember/protocol";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cantGoBackTo, cantUse, NOT_THIS_ADDRESS, PROBE_ANSWER_HEADER } from "../src/custom-domain";
import type { Env } from "../src/env";
import { workspace } from "../src/workspace";
import { api, apiWith, connect, cookieOf, freshDeploy, openWorkspaceSocket, origin, post, shown, signIn, workspaceSql, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** The address an administrator gives Ember in these tests, as the Cloudflare dashboard attached it to the Worker. */
const DOMAIN = "chat.example.com";

/** Where a deploy puts Ember in these tests: the Worker named ember's workers.dev address. */
const DEPLOYED = "ember.kro.workers.dev";

/** Every Mac's user agent on the same Chrome, whose reduced user agent says no more. */
const CHROME_ON_A_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** A new workspace as pages show it, with the custom domain `customDomain`. */
const withDomain = (customDomain: string | null): Account => ({ name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true });

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** A request from the app's pages at `host`, as `api` sends one at ember.test. */
const at = (host: string, path: string, init: RequestInit<IncomingRequestCfProperties> = {}) => apiWith({}, `https://${host}${path}`, init);

/** What `PATCH /api/account` answers `session` for `body` from a page at `host`. */
const change = (session: Session | null, host: string, body: unknown) =>
  at(host, "/api/account", { method: "PATCH", headers: as(session), body: JSON.stringify(body) });

/** Makes `host` Ember's custom domain from a page there, as Use <address> does, or none, as Stop using it does. */
async function use(session: Session, host: string, customDomain: string | null = host): Promise<void> {
  const response = await change(session, host, { customDomain });
  expect(response.status, await response.clone().text()).toBe(200);
}

const storedSettings = async () => JSON.parse(((await workspaceSql("SELECT settings FROM accounts")) as Array<{ settings: string }>)[0]!.settings) as Record<string, unknown>;

const storedUpdatedAt = async () => ((await workspaceSql("SELECT updated_at FROM accounts")) as Array<{ updated_at: string }>)[0]!.updated_at;

const bootstrap = async (session?: Session) => (await (await api("/api/bootstrap", { headers: as(session) })).json()) as Bootstrap;

/** Opens a page at `host` as `session`, which asks what the app asks first there. */
async function open(host: string, session?: Session): Promise<Bootstrap> {
  const response = await at(host, "/api/bootstrap", { headers: as(session) });
  expect(response.status).toBe(200);
  return (await response.json()) as Bootstrap;
}

/** The addresses besides its own that Ember tells `session` of in workspace settings. */
const addressesFor = async (session: Session) => ((await (await api("/api/account", { headers: as(session) })).json()) as WorkspaceSettings).addresses;

/** Sets Ember up with a bot, which is in first run's general room. */
async function withBot() {
  const administrator = await setUp();
  const response = await api("/api/account/bots", { method: "POST", headers: as(administrator), body: JSON.stringify({ name: "Build Bot" }) });
  expect(response.status, await response.clone().text()).toBe(201);
  const bot: BotSettings = ((await response.json()) as BotAnswer).bot;
  const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
  return { administrator, bot, general };
}

/** Where the bot whose key is `bot.key` posts to and reads `room`. */
const messagesOf = (room: RoomId, bot: BotSettings) => `/rooms/${room}/${bot.key}/messages`;

/** As `curl -d` sends a body. */
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

/** The P-256 key of the browser subscribed at `endpoint`, each browser's its own. */
const keyOf = (endpoint: string) => `BP-${endpoint}`;

/**
 * What `session` saves at `host` to subscribe the browser at `endpoint`, as turning notifications on
 * there does, replacing the subscription `body.replacing` names.
 */
const save = (session: Session | null, host: string, endpoint: string, body: Record<string, unknown> = {}) =>
  at(host, "/api/push-subscriptions", {
    method: "POST",
    headers: { ...as(session), "User-Agent": CHROME_ON_A_MAC },
    body: JSON.stringify({ endpoint: `https://fcm.googleapis.com/fcm/send/${endpoint}`, p256dhKey: keyOf(endpoint), authKey: "BTBZMqHH6r4Tts7J_aSIgg", ...body }),
  });

/** Saves the browser at `endpoint` for `session` at `host`, replacing `session`'s subscription at `replacing`, if given. */
async function subscribe(session: Session, host: string, endpoint: string, replacing?: string): Promise<void> {
  const response = await save(session, host, endpoint, replacing === undefined ? {} : { replacing: keyOf(replacing) });
  expect(response.status, await response.clone().text()).toBe(204);
}

/** The endpoints of `session`'s person's subscriptions, oldest first. */
const subscriptionsOf = async (session: Session) =>
  ((await workspaceSql("SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY id", session.user.id)) as Array<{ endpoint: string }>).map(({ endpoint }) =>
    endpoint.slice("https://fcm.googleapis.com/fcm/send/".length),
  );

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Custom domain", () => {
  it("makes the address the page asking is open at Ember's, which every page then learns", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");

    const response = await change(administrator, DOMAIN, { customDomain: DOMAIN });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: withDomain(DOMAIN) });
    expect((await storedSettings()).custom_domain).toBe(DOMAIN);

    // Pages at the old address, signed in or out, move there as they open.
    expect((await bootstrap()).account).toEqual(withDomain(DOMAIN));
    expect((await bootstrap(member)).account).toEqual(withDomain(DOMAIN));
    const settings = (await (await api("/api/account", { headers: as(member) })).json()) as WorkspaceSettings;
    expect(settings.account).toEqual(withDomain(DOMAIN));
  });

  it("starts with none, and takes a host with its port where it isn't the scheme's own", async () => {
    const administrator = await setUp();
    expect((await bootstrap()).account?.customDomain).toBeNull();
    await use(administrator, "chat.example.com:8443");
    expect((await bootstrap()).account?.customDomain).toBe("chat.example.com:8443");
    // A port is part of the address, so the host alone is another, which must reach Ember too.
    const sent = internet({ with: () => Promise.reject(new TypeError("Network connection lost.")) });
    expect(await (await change(administrator, "chat.example.com:8443", { customDomain: DOMAIN })).json()).toEqual({ error: cantUse(DOMAIN, "nothing") });
    expect(sent.map(({ url }) => url)).toEqual([expect.stringMatching(probeAt(`https://${DOMAIN}`))]);
  });

  it("refuses a domain the request didn't come to while it doesn't reach this Ember, changing nothing", async () => {
    const administrator = await setUp();
    const answer = { with: async (_: Request) => new Response() };
    const sent = internet(answer);
    for (const [reaches, response] of [
      ["nothing", () => Promise.reject(new TypeError("Network connection lost."))],
      ["elsewhere", () => Promise.resolve(new Response("<html>Parked</html>", { headers: { "Content-Type": "text/html" } }))],
    ] as const) {
      answer.with = response;
      for (const [host, customDomain] of [
        ["ember.test", DOMAIN],
        [DOMAIN, "www.example.com"],
      ]) {
        const refused = await change(administrator, host!, { customDomain });
        expect([reaches, host, refused.status]).toEqual([reaches, host, 422]);
        expect(await refused.json()).toEqual({ error: cantUse(customDomain!, reaches) });
      }
    }
    expect(cantUse(DOMAIN, "nothing")).toBe("Nothing answers at chat.example.com yet. Cloudflare can take a minute to add it, so try again soon.");
    expect(cantUse(DOMAIN, "elsewhere")).toBe("Something else answers at chat.example.com, not Ember.");
    expect(sent).toHaveLength(4);
    // A name changed along with it isn't saved either.
    expect((await change(administrator, "ember.test", { name: "Ember Studio", customDomain: DOMAIN })).status).toBe(422);
    expect((await bootstrap()).account).toEqual(withDomain(null));
    expect((await storedSettings()).custom_domain).toBeUndefined();
  });

  it("takes where a deploy or wrangler dev puts Ember from a page there, as Go back does, and a name under localhost", async () => {
    const administrator = await setUp();
    for (const host of [DEPLOYED, "workers.dev", "localhost:8787", "localhost", "127.0.0.1:8787", "chat.localhost:8787"]) {
      await use(administrator, host);
      expect([host, (await bootstrap()).account?.customDomain]).toEqual([host, host]);
    }
  });

  it("refuses anything but a host or null", async () => {
    const administrator = await setUp();
    for (const customDomain of [`https://${DOMAIN}`, `${DOMAIN}/`, "Chat.Example.com", "", " ", "chat..example.com", ".example.com", `${"a".repeat(260)}.com`, 42, true, {}, [DOMAIN]]) {
      const response = await change(administrator, DOMAIN, { customDomain });
      expect([customDomain, response.status]).toEqual([customDomain, 422]);
      expect(await response.json()).toEqual({ error: CUSTOM_DOMAIN_NOT_A_HOST });
    }
    expect((await bootstrap()).account?.customDomain).toBeNull();
  });

  it("lets only administrators change it, telling anyone else so before checking what they sent", async () => {
    await setUp();
    const member = await signIn("Grace");
    const sent = internet({ with: (request) => exports.default.fetch(request) });
    for (const customDomain of [DOMAIN, "ember.test", 42]) {
      const response = await change(member, DOMAIN, { customDomain });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators can change the workspace" });
    }
    expect((await change(null, DOMAIN, { customDomain: DOMAIN })).status).toBe(401);
    expect((await change(null, "ember.test", { customDomain: DOMAIN })).status).toBe(401);
    expect(sent).toEqual([]);
    expect((await bootstrap()).account?.customDomain).toBeNull();
  });

  it("stops using it from any address, leaving the other settings as they are", async () => {
    const administrator = await setUp();
    expect((await api("/api/account", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ settings: { hideTranslationButtons: false } }) })).status).toBe(200);
    await use(administrator, DOMAIN);

    const response = await change(administrator, DEPLOYED, { customDomain: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: { ...withDomain(null), hideTranslationButtons: false } });
    // The domain it stops using reaches it still, until it's removed in Cloudflare.
    expect(await storedSettings()).toEqual({ restrict_room_creation_to_administrators: false, hide_translation_buttons: false, custom_domain: null, other_addresses: [DOMAIN] });

    // And uses another once more.
    await use(administrator, "ember.example.org");
    expect((await bootstrap()).account?.customDomain).toBe("ember.example.org");
  });

  it("tells every open tab, but only when it changes", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(member)];
    const long = "2026-01-01T00:00:00.000Z";
    await workspaceSql("UPDATE accounts SET updated_at = ?", long);

    await use(administrator, DOMAIN);
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "account.updated", account: withDomain(DOMAIN) });
    const usedAt = await storedUpdatedAt();
    expect(usedAt).not.toBe(long);

    // Saved again unchanged, nothing's written or said.
    await use(administrator, DOMAIN);
    expect(await storedUpdatedAt()).toBe(usedAt);
    for (const socket of sockets) expect(await socket.answers()).toBe(true);

    await use(administrator, DOMAIN, null);
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "account.updated", account: withDomain(null) });
  });

  it("names it in the bot API's links, at whichever address the bot asks", async () => {
    const { administrator, bot, general } = await withBot();
    await use(administrator, DOMAIN);
    const room = await connect(general, administrator);
    const adas = await post(room, "Ship it?");

    for (const host of ["ember.test", DOMAIN]) {
      const posted = await at(host, messagesOf(general, bot), { method: "POST", body: "Shipped", headers: FORM });
      expect(posted.status).toBe(201);
      expect(posted.headers.get("Location")).toMatch(new RegExp(`^https://chat\\.example\\.com/rooms/${general}/@`));

      const boosted = await at(host, `${messagesOf(general, bot)}/${adas.id}/boosts`, { method: "POST", body: "👀", headers: FORM });
      expect(boosted.status).toBe(201);
      const boost = (await boosted.json()) as { booster: { avatar_url: string }; message: { url: string } };
      expect(boost.message.url).toBe(`https://${DOMAIN}/rooms/${general}/@${adas.id}`);
      expect(boost.booster.avatar_url).toMatch(/^https:\/\/chat\.example\.com\/users\//);
    }

    const shipped = (await at("ember.test", messagesOf(general, bot), { method: "POST", body: "Again", headers: FORM })).headers.get("Location")!.split("/@")[1]!;
    const edited = await at("ember.test", `${messagesOf(general, bot)}/${shipped}`, { method: "PATCH", body: "Edited", headers: FORM });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { url: string }).url).toBe(`https://${DOMAIN}/rooms/${general}/@${shipped}`);

    for (let i = 0; i < 40; i++) expect((await at("ember.test", messagesOf(general, bot), { method: "POST", body: `Build ${i}`, headers: FORM })).status).toBe(201);
    const listed = await at("ember.test", messagesOf(general, bot));
    const [message] = (await listed.json()) as Array<{ url: string; creator: { avatar_url: string } }>;
    expect(message!.url).toMatch(/^https:\/\/chat\.example\.com\/rooms\//);
    expect(message!.creator.avatar_url).toMatch(/^https:\/\/chat\.example\.com\/users\//);
    expect(listed.headers.get("Link")).toMatch(new RegExp(`^<https://chat\\.example\\.com/rooms/${general}/${bot.key}/messages\\?before=`));
  });

  it("names the address each request came to again once Ember stops using it", async () => {
    const { administrator, bot, general } = await withBot();
    await use(administrator, DOMAIN);
    await use(administrator, DOMAIN, null);
    const posted = await at("ember.example.org", messagesOf(general, bot), { method: "POST", body: "Shipped", headers: { "Content-Type": "text/plain" } });
    expect(posted.headers.get("Location")).toMatch(new RegExp(`^https://ember\\.example\\.org/rooms/${general}/@`));
    expect((await api(messagesOf(general, bot), { method: "POST", body: "Shipped" })).headers.get("Location")).toMatch(new RegExp(`^${origin}/rooms/`));
  });

  it("replaces the subscription a browser had at the address its page moved from with the one it saves there, and no other", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    await subscribe(grace, "ember.test", "work-mac");
    await subscribe(grace, "ember.test", "home-mac");
    await subscribe(administrator, "ember.test", "adas-mac");
    await use(administrator, DOMAIN);

    await subscribe(grace, DOMAIN, "work-mac-there", "work-mac");
    // Her other Mac's stays, though its user agent is the same, until it moves too, and so does Ada's.
    expect(await subscriptionsOf(grace)).toEqual(["home-mac", "work-mac-there"]);
    expect(await subscriptionsOf(administrator)).toEqual(["adas-mac"]);
    await subscribe(grace, DOMAIN, "home-mac-there", "home-mac");
    expect(await subscriptionsOf(grace)).toEqual(["work-mac-there", "home-mac-there"]);

    // Saved again with the key it named, as the app saves a browser's as it opens, it stays.
    await subscribe(grace, DOMAIN, "home-mac-there", "home-mac-there");
    expect(await subscriptionsOf(grace)).toEqual(["work-mac-there", "home-mac-there"]);
  });

  it("replaces only a subscription of the person saving, and ignores a key that names none or can't be one", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    await subscribe(administrator, "ember.test", "adas-mac");
    await use(administrator, DOMAIN);

    await subscribe(grace, DOMAIN, "graces-mac", "adas-mac");
    await subscribe(grace, DOMAIN, "graces-phone", "nobodys");
    for (const replacing of ["", 42, null, ["adas-mac"], "K".repeat(257)]) {
      expect((await save(grace, DOMAIN, "graces-mac", { replacing })).status).toBe(204);
    }
    expect(await subscriptionsOf(administrator)).toEqual(["adas-mac"]);
    expect(await subscriptionsOf(grace)).toEqual(["graces-mac", "graces-phone"]);

    // Nor anything signed out.
    expect((await save(null, DOMAIN, "graces-tablet", { replacing: keyOf("graces-mac") })).status).toBe(401);
    expect(await subscriptionsOf(grace)).toEqual(["graces-mac", "graces-phone"]);
  });
});

/** What `session` hears checking `domain`, as Check in Workspace settings at ember.test asks. */
const check = (session: Session | null, domain: unknown) =>
  api("/api/account/custom_domain_checks", { method: "POST", headers: as(session), body: JSON.stringify({ domain }) });

/** What checking `domain` as `session` finds there. */
async function reachOf(session: Session, domain: string): Promise<unknown> {
  const response = await check(session, domain);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as CustomDomainCheck).reaches;
}

/** A request this Worker sent the Internet. */
interface Sent {
  url: string;
  init: RequestInit | undefined;
}

/** Stands in for the Internet, where whatever `answer` says answers each request this Worker sends, which it keeps. */
function internet(answer: { with: (request: Request) => Promise<Response> }): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, init });
    return answer.with(request);
  });
  return sent;
}

/** Matches the address of a probe the Worker sends to `origin`. */
const probeAt = (origin: string) => new RegExp(`^${origin.replace(/\./g, "\\.")}/api/custom_domain_probes/[\\w-]{32}$`);

describe("Custom domain", () => {
  it("checks that a domain reaches this Ember by asking it for a probe only this Ember waits for, once", async () => {
    const administrator = await setUp();
    // As Cloudflare sends the domain to this Worker, once its dashboard has added it.
    const sent = internet({ with: (request) => exports.default.fetch(request) });
    expect(await reachOf(administrator, DOMAIN)).toBe("ember");
    expect(sent).toHaveLength(1);
    const [{ url, init }] = sent as [Sent];
    expect(url).toMatch(probeAt(`https://${DOMAIN}`));
    // It sends nothing but the probe, follows no redirect, and waits only so long.
    expect(init).toEqual({ redirect: "manual", signal: expect.any(AbortSignal) });
    expect((await exports.default.fetch(url)).status).toBe(404);

    // By the scheme the check came by, and with the domain's port.
    expect(await reachOf(administrator, "chat.example.com:8443")).toBe("ember");
    expect(sent[1]!.url).toMatch(probeAt("https://chat.example.com:8443"));
  });

  it("says something else answers there when a site does, but not as this Ember", async () => {
    const administrator = await setUp();
    const answer = { with: async (_: Request) => new Response() };
    internet(answer);
    for (const [what, response] of [
      ["a parked page", () => new Response("<html>Parked</html>", { headers: { "Content-Type": "text/html" } })],
      ["a site that answers anything", () => new Response(null, { status: 204 })],
      // Another Ember's Workspace waits for no such probe, as another Worker's wouldn't.
      ["another Ember", () => Response.json({ error: "Not found" }, { status: 404 })],
      ["a guess at the answer", () => new Response(null, { status: 204, headers: { [PROBE_ANSWER_HEADER]: "a guess" } })],
      ["a redirect, which isn't followed", () => Response.redirect(`https://${DOMAIN}/elsewhere`, 302)],
      ["a failing site", () => new Response(null, { status: 500 })],
    ] as const) {
      answer.with = async () => response();
      expect([what, await reachOf(administrator, DOMAIN)]).toEqual([what, "elsewhere"]);
    }
  });

  it("says nothing answers there yet when nothing does, or only Cloudflare for an origin it can't reach", async () => {
    const administrator = await setUp();
    const answer = { with: async (_: Request) => new Response() };
    internet(answer);
    for (const [what, response] of [
      ["no address", () => Promise.reject(new TypeError("Network connection lost."))],
      ["no answer in time", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
      ["a domain DNS doesn't know, as Cloudflare's error 1016", () => Promise.resolve(new Response("error code: 1016", { status: 530 }))],
      ["an origin that's down", () => Promise.resolve(new Response(null, { status: 521 }))],
      ["a certificate that isn't ready", () => Promise.resolve(new Response(null, { status: 525 }))],
    ] as const) {
      answer.with = response;
      expect([what, await reachOf(administrator, DOMAIN)]).toEqual([what, "nothing"]);
    }
  });

  it("finds what answers there by the answer's head, even when the rest of it fails", async () => {
    const administrator = await setUp();
    // A body that fails, as when the connection drops after the head.
    const failing = () => new ReadableStream({ start: (controller) => controller.error(new TypeError("Network connection lost.")) });
    const answer = { with: async (request: Request) => new Response(failing(), { headers: (await exports.default.fetch(request)).headers }) };
    internet(answer);
    expect(await reachOf(administrator, DOMAIN)).toBe("ember");
    answer.with = async () => new Response(failing(), { headers: { "Content-Type": "text/html" } });
    expect(await reachOf(administrator, DOMAIN)).toBe("elsewhere");
  });

  it("lets only administrators check, telling anyone else so before checking what they sent", async () => {
    await setUp();
    const member = await signIn("Grace");
    const sent = internet({ with: (request) => exports.default.fetch(request) });
    for (const domain of [DOMAIN, "ember.kro.workers.dev", 42]) {
      const response = await check(member, domain);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators can change the workspace" });
    }
    expect((await check(null, DOMAIN)).status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("refuses a domain that can't be Ember's, sending nothing", async () => {
    const administrator = await setUp();
    const sent = internet({ with: (request) => exports.default.fetch(request) });
    for (const [domain, error] of [
      ["ember.kro.workers.dev", NOT_A_CUSTOM_DOMAIN],
      ["localhost:8787", NOT_A_CUSTOM_DOMAIN],
      [`https://${DOMAIN}`, CUSTOM_DOMAIN_NOT_A_HOST],
      [`${DOMAIN}/api/health`, CUSTOM_DOMAIN_NOT_A_HOST],
      [`${DOMAIN}:99999`, CUSTOM_DOMAIN_NOT_A_HOST],
      [42, CUSTOM_DOMAIN_NOT_A_HOST],
    ] as const) {
      const response = await check(administrator, domain);
      expect([domain, response.status]).toEqual([domain, 422]);
      expect(await response.json()).toEqual({ error });
    }
    expect(sent).toEqual([]);
  });

  it("answers a probe only while a check waits for it, and only for the latest few checks", async () => {
    const probe = (n: number) => `${String(n).padStart(2, "0")}${"p".repeat(30)}`;
    const answerTo = async (n: number) => (await exports.default.fetch(`https://${DOMAIN}/api/custom_domain_probes/${probe(n)}`)).headers.get(PROBE_ANSWER_HEADER);
    expect(await answerTo(1)).toBeNull();
    const waiting = workspace(env as unknown as Env);
    for (let n = 1; n <= 21; n++) await waiting.expectProbe(probe(n), `answer ${n}`);
    expect(await answerTo(1)).toBeNull();
    expect(await answerTo(2)).toBe("answer 2");
    expect(await answerTo(21)).toBe("answer 21");
    expect(await answerTo(21)).toBeNull();
    // Only GET asks.
    await waiting.expectProbe(probe(3), "answer 3");
    expect((await exports.default.fetch(`https://${DOMAIN}/api/custom_domain_probes/${probe(3)}`, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(404);
    expect(await answerTo(3)).toBe("answer 3");
  });
});

describe("Custom domain", () => {
  /** Ember as a deploy left it, opened at its workers.dev address, with Ada as its administrator, signed in. */
  async function deployed(): Promise<Session> {
    const administrator = await setUp();
    await open(DEPLOYED);
    return administrator;
  }

  it("remembers where a deploy puts Ember from the pages opened there, which only administrators hear of", async () => {
    const administrator = await setUp();
    const member = await signIn("Grace");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(member)];
    const long = "2026-01-01T00:00:00.000Z";
    await workspaceSql("UPDATE accounts SET updated_at = ?", long);
    // Not from a page anywhere else.
    await open(DOMAIN);
    await bootstrap();
    expect(await addressesFor(administrator)).toEqual({ deployed: null, others: [] } satisfies EmberAddresses);

    await open(DEPLOYED, member);
    expect((await storedSettings()).deployed_address).toBe(DEPLOYED);
    expect(await addressesFor(administrator)).toEqual({ deployed: DEPLOYED, others: [] } satisfies EmberAddresses);
    expect(await addressesFor(member)).toEqual({ deployed: null, others: [] } satisfies EmberAddresses);
    // It's no change to the account, which pages show as they were.
    expect(await storedUpdatedAt()).toBe(long);
    for (const socket of sockets) expect(await socket.answers()).toBe(true);
    expect((await open(DEPLOYED)).account).toEqual(withDomain(null));

    // Wherever the Worker's workers.dev address moves, as when it's renamed, or wrangler dev's.
    await open("ember-studio.kro.workers.dev");
    expect((await addressesFor(administrator)).deployed).toBe("ember-studio.kro.workers.dev");
    await open("localhost:8787");
    expect((await addressesFor(administrator)).deployed).toBe("localhost:8787");
  });

  it("remembers nothing before first run", async () => {
    expect((await open(DEPLOYED)).setup).toBe("pending");
    const administrator = await setUp();
    expect(await addressesFor(administrator)).toEqual({ deployed: null, others: [] } satisfies EmberAddresses);
  });

  it("goes back to where a deploy puts Ember from any address, once a check finds it reaches Ember there", async () => {
    const administrator = await deployed();
    await use(administrator, DOMAIN);
    // As Cloudflare sends the workers.dev address to this Worker.
    const sent = internet({ with: (request) => exports.default.fetch(request) });

    const response = await change(administrator, DOMAIN, { customDomain: DEPLOYED });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ account: withDomain(DEPLOYED) });
    expect(sent.map(({ url }) => url)).toEqual([expect.stringMatching(probeAt(`https://${DEPLOYED}`))]);
    // Pages at the domain it left move there, and the domain is remembered, as it reaches Ember until it's removed in Cloudflare.
    expect((await open(DOMAIN)).account?.customDomain).toBe(DEPLOYED);
    expect(await addressesFor(administrator)).toEqual({ deployed: DEPLOYED, others: [DOMAIN] } satisfies EmberAddresses);
    expect(await storedSettings()).toMatchObject({ custom_domain: DEPLOYED, deployed_address: DEPLOYED, other_addresses: [DOMAIN] });
  });

  it("goes back from the address a deploy puts Ember at without a check, as the request came there", async () => {
    const administrator = await deployed();
    await use(administrator, DOMAIN);
    const sent = internet({ with: (request) => exports.default.fetch(request) });
    await use(administrator, DEPLOYED);
    expect(sent).toEqual([]);
    expect(await addressesFor(administrator)).toEqual({ deployed: DEPLOYED, others: [DOMAIN] } satisfies EmberAddresses);
  });

  it("won't go back while Ember doesn't answer where a deploy put it, changing nothing", async () => {
    const administrator = await deployed();
    await use(administrator, DOMAIN);
    const answer = { with: async (_: Request) => new Response() };
    internet(answer);
    for (const [what, response] of [
      ["its workers.dev address turned off, as Cloudflare's error 1042", () => Promise.resolve(new Response("error code: 1042", { status: 404 }))],
      ["no answer in time", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
    ] as const) {
      answer.with = response;
      const refused = await change(administrator, DOMAIN, { customDomain: DEPLOYED, name: "Ember Studio" });
      expect([what, refused.status]).toEqual([what, 422]);
      expect(await refused.json()).toEqual({ error: cantGoBackTo(DEPLOYED) });
    }
    expect((await bootstrap()).account).toEqual(withDomain(DOMAIN));
    expect(await addressesFor(administrator)).toEqual({ deployed: DEPLOYED, others: [] } satisfies EmberAddresses);
  });

  it("goes back to no workers.dev or localhost address but where a deploy put Ember, sending nothing for another", async () => {
    const administrator = await setUp();
    await use(administrator, DOMAIN);
    const sent = internet({ with: (request) => exports.default.fetch(request) });
    // Before a page there has told Ember where it is.
    expect(await (await change(administrator, DOMAIN, { customDomain: DEPLOYED })).json()).toEqual({ error: NOT_THIS_ADDRESS });
    await open(DEPLOYED);
    for (const customDomain of ["ember-studio.kro.workers.dev", "localhost:8787", "127.0.0.1:8787"]) {
      expect(await (await change(administrator, DOMAIN, { customDomain })).json()).toEqual({ error: NOT_THIS_ADDRESS });
    }
    expect(sent).toEqual([]);
    expect((await bootstrap()).account?.customDomain).toBe(DOMAIN);
  });

  it("lets only administrators go back, telling anyone else so before checking anything", async () => {
    const administrator = await deployed();
    await use(administrator, DOMAIN);
    const member = await signIn("Grace");
    const sent = internet({ with: (request) => exports.default.fetch(request) });
    const response = await change(member, DOMAIN, { customDomain: DEPLOYED });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Only administrators can change the workspace" });
    expect((await change(null, DOMAIN, { customDomain: DEPLOYED })).status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("makes a custom domain Ember's from any address, as Set up's Use does, once a check finds it reaches Ember there", async () => {
    const administrator = await deployed();
    // As Cloudflare sends the domain to this Worker, once its dashboard has added it.
    const sent = internet({ with: (request) => exports.default.fetch(request) });

    const response = await change(administrator, DEPLOYED, { customDomain: DOMAIN });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ account: withDomain(DOMAIN) });
    expect(sent.map(({ url }) => url)).toEqual([expect.stringMatching(probeAt(`https://${DOMAIN}`))]);
    expect((await open(DEPLOYED)).account?.customDomain).toBe(DOMAIN);
    expect(await addressesFor(administrator)).toEqual({ deployed: DEPLOYED, others: [] } satisfies EmberAddresses);

    // And on to another the same way, remembering the one it left.
    expect((await change(administrator, DEPLOYED, { customDomain: "team.example.com" })).status).toBe(200);
    expect(await addressesFor(administrator)).toEqual({ deployed: DEPLOYED, others: [DOMAIN] } satisfies EmberAddresses);
    expect(sent).toHaveLength(2);
  });

  it("won't make a domain Ember's from another address while it doesn't reach Ember, changing nothing", async () => {
    const administrator = await deployed();
    const answer = { with: async (_: Request) => new Response() };
    internet(answer);
    for (const [reaches, response] of [
      ["nothing", () => Promise.resolve(new Response("error code: 1016", { status: 530 }))],
      // As when the domain is added to another Worker, or another Ember.
      ["elsewhere", () => Promise.resolve(Response.json({ error: "Not found" }, { status: 404 }))],
    ] as const) {
      answer.with = response;
      const refused = await change(administrator, DEPLOYED, { customDomain: DOMAIN, name: "Ember Studio" });
      expect([reaches, refused.status]).toEqual([reaches, 422]);
      expect(await refused.json()).toEqual({ error: cantUse(DOMAIN, reaches) });
    }
    expect((await bootstrap()).account).toEqual(withDomain(null));
    expect(await addressesFor(administrator)).toEqual({ deployed: DEPLOYED, others: [] } satisfies EmberAddresses);
  });

  it("remembers the custom domains it moves away from, and where each move was asked, newest first", async () => {
    const administrator = await deployed();
    await use(administrator, DOMAIN);
    await use(administrator, "team.example.com");
    expect(await addressesFor(administrator)).toEqual({ deployed: DEPLOYED, others: [DOMAIN] } satisfies EmberAddresses);
    // Gone back from a domain it left before, which reaches it too.
    internet({ with: (request) => exports.default.fetch(request) });
    expect((await change(administrator, "old.example.com", { customDomain: DEPLOYED })).status).toBe(200);
    expect((await addressesFor(administrator)).others).toEqual(["team.example.com", "old.example.com", DOMAIN]);
    // A domain it moves to again is its own once more.
    await use(administrator, DOMAIN);
    expect((await addressesFor(administrator)).others).toEqual(["team.example.com", "old.example.com"]);
  });

  it("forgets a domain it moved away from once a check finds it no longer reaches Ember, and no other", async () => {
    const administrator = await deployed();
    await use(administrator, DOMAIN);
    await use(administrator, "team.example.com");
    await use(administrator, DEPLOYED);
    expect((await addressesFor(administrator)).others).toEqual(["team.example.com", DOMAIN]);
    const updatedAt = await storedUpdatedAt();
    const answer = { with: (request: Request) => exports.default.fetch(request) };
    internet(answer);

    expect(await reachOf(administrator, DOMAIN)).toBe("ember");
    expect((await addressesFor(administrator)).others).toEqual(["team.example.com", DOMAIN]);
    // Removed from the Worker in Cloudflare.
    answer.with = async () => new Response("error code: 1016", { status: 530 });
    expect(await reachOf(administrator, DOMAIN)).toBe("nothing");
    expect(await reachOf(administrator, "www.example.com")).toBe("nothing");
    expect((await addressesFor(administrator)).others).toEqual(["team.example.com"]);
    // Something else answers there now.
    answer.with = async () => new Response("<html>Parked</html>", { headers: { "Content-Type": "text/html" } });
    expect(await reachOf(administrator, "team.example.com")).toBe("elsewhere");
    expect(await addressesFor(administrator)).toEqual({ deployed: DEPLOYED, others: [] } satisfies EmberAddresses);
    expect(await storedUpdatedAt()).toBe(updatedAt);
  });
});

/** What `session` hears looking `domain` up, as Set up in Workspace settings asks for its steps. */
const lookUp = (session: Session | null, domain: unknown) =>
  api("/api/account/custom_domain_lookups", { method: "POST", headers: as(session), body: JSON.stringify({ domain }) });

/** Where looking `domain` up as `session` finds its DNS. */
async function lookupOf(session: Session, domain: string): Promise<CustomDomainLookup> {
  const response = await lookUp(session, domain);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as CustomDomainLookup;
}

/** A record as Cloudflare's resolver writes one in its JSON answers: its name without a final dot, its data with one. */
interface DnsRecord {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

/** Cloudflare's resolver's answer to a lookup, in its JSON form. */
interface DnsAnswer {
  Status: number;
  Answer?: DnsRecord[];
  /** The SOA record of the zone that says the name has no records of the type asked for, or doesn't exist. */
  Authority?: DnsRecord[];
}

const [NOERROR, NXDOMAIN] = [0, 3];

/** `zone`'s SOA record, which the resolver gives as the answer at its apex, and as the authority for a name below it. */
const soa = (zone: string): DnsRecord => ({ name: zone, type: 6, TTL: 1800, data: `ns1.${zone}. hostmaster.${zone}. 2026102801 10800 3600 604800 3600` });

/** The NS records of `zone`, naming `nameservers` as the ones that serve it. */
const ns = (zone: string, nameservers: readonly string[]): DnsRecord[] => nameservers.map((nameserver) => ({ name: zone, type: 2, TTL: 86400, data: `${nameserver}.` }));

/** The CNAME record that makes `name` an alias of `target`. */
const cname = (name: string, target: string): DnsRecord => ({ name, type: 5, TTL: 300, data: `${target}.` });

/** What the resolver answers an SOA lookup of a name in `zone` below its apex: NOERROR when the name has records, NXDOMAIN when it has none. */
const inZone = (zone: string, status = NOERROR): DnsAnswer => ({ Status: status, Authority: [soa(zone)] });

/** What the resolver answers for `zone` itself, whose DNS `nameservers` serve. */
const zoneServedBy = (zone: string, nameservers: readonly string[]): Record<string, DnsAnswer> => ({
  [`${zone} SOA`]: { Status: NOERROR, Answer: [soa(zone)] },
  [`${zone} NS`]: { Status: NOERROR, Answer: ns(zone, nameservers) },
});

const CLOUDFLARE_NAMESERVERS = ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];

/** The address the Worker asks Cloudflare's resolver about `name`'s records of `type` at, and what it accepts. */
const asking = (name: string, type: string) => `https://cloudflare-dns.com/dns-query?name=${name}&type=${type} application/dns-json`;

/**
 * Stands in for Cloudflare's resolver, which answers each lookup as `answers` says for the name and type
 * it asks about, and any other as it does a name nobody registered: NXDOMAIN, by com's zone. It keeps
 * what's asked.
 */
function resolverWith(answers: Record<string, DnsAnswer | (() => Promise<Response>)>): string[] {
  const asked: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    asked.push(`${request.url} ${request.headers.get("Accept")}`);
    const { searchParams } = new URL(request.url);
    const answer = answers[`${searchParams.get("name")} ${searchParams.get("type")}`] ?? inZone("com", NXDOMAIN);
    return typeof answer === "function" ? answer() : Response.json(answer);
  });
  return asked;
}

describe("Custom domain", () => {
  it("looks up the zone a domain is in, and whose nameservers serve it, by asking Cloudflare's resolver two things", async () => {
    const administrator = await setUp();
    const asked = resolverWith({ [`${DOMAIN} SOA`]: inZone("example.com", NXDOMAIN), ...zoneServedBy("example.com", CLOUDFLARE_NAMESERVERS) });

    const response = await lookUp(administrator, DOMAIN);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ zone: "example.com", provider: "cloudflare" } satisfies CustomDomainLookup);
    expect(asked).toEqual([asking(DOMAIN, "SOA"), asking("example.com", "NS")]);
    // Each waits only so long.
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => init)).toEqual([{ signal: expect.any(AbortSignal) }, { signal: expect.any(AbortSignal) }]);
  });

  it("finds the zone of its apex, a name with records of its own, a name with a port, and a subdomain with a zone of its own", async () => {
    const administrator = await setUp();
    const asked = resolverWith({
      ...zoneServedBy("example.com", CLOUDFLARE_NAMESERVERS),
      "team.example.com SOA": inZone("example.com"),
      "chat.eu.example.com SOA": inZone("eu.example.com", NXDOMAIN),
      ...zoneServedBy("eu.example.com", ["ns1.hover.com", "ns2.hover.com"]),
    });
    expect(await lookupOf(administrator, "example.com")).toEqual({ zone: "example.com", provider: "cloudflare" });
    expect(await lookupOf(administrator, "team.example.com")).toEqual({ zone: "example.com", provider: "cloudflare" });
    expect(await lookupOf(administrator, "team.example.com:8443")).toEqual({ zone: "example.com", provider: "cloudflare" });
    expect(await lookupOf(administrator, "chat.eu.example.com")).toEqual({ zone: "eu.example.com", provider: "hover" });
    expect(asked.slice(4, 6)).toEqual([asking("team.example.com", "SOA"), asking("example.com", "NS")]);
  });

  it("knows the providers Set up names by their nameservers, and calls anyone else's another provider's", async () => {
    const administrator = await setUp();
    const answers: Record<string, DnsAnswer> = { [`${DOMAIN} SOA`]: inZone("example.com") };
    resolverWith(answers);
    for (const [provider, nameservers] of [
      ["cloudflare", CLOUDFLARE_NAMESERVERS],
      ["godaddy", ["ns07.domaincontrol.com", "ns08.domaincontrol.com"]],
      ["namecheap", ["dns1.registrar-servers.com", "dns2.registrar-servers.com"]],
      ["porkbun", ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com", "maceio.ns.porkbun.com", "salvador.ns.porkbun.com"]],
      ["route53", ["ns-1536.awsdns-00.co.uk", "ns-0.awsdns-00.com", "ns-1024.awsdns-00.org", "ns-512.awsdns-00.net"]],
      ["hover", ["ns1.hover.com", "ns2.hover.com"]],
      ["ionos", ["ns1045.ui-dns.de", "ns1068.ui-dns.biz", "ns1102.ui-dns.org", "ns1116.ui-dns.com"]],
      // A zone's records can name them in capitals.
      ["godaddy", ["NS07.DomainControl.com", "NS08.DomainControl.com"]],
      // Squarespace's are NS1's, which serve others' domains too, as Namecheap's FreeDNS and PremiumDNS do.
      ["other", ["dns1.p06.nsone.net", "dns2.p06.nsone.net"]],
      ["other", ["freedns1.registrar-servers.com", "freedns2.registrar-servers.com", "freedns3.registrar-servers.com"]],
      ["other", ["pdns1.registrar-servers.com", "pdns2.registrar-servers.com"]],
      ["other", ["ns1.digitalocean.com", "ns2.digitalocean.com"]],
      ["other", ["ada.ns.cloudflare.com.example.net"]],
    ] as const) {
      answers["example.com NS"] = { Status: NOERROR, Answer: ns("example.com", nameservers) };
      expect([nameservers[0], (await lookupOf(administrator, DOMAIN)).provider]).toEqual([nameservers[0], provider]);
    }
  });

  it("goes up past a name that's an alias, whose answer holds its target's zone, asking about three names at most", async () => {
    const administrator = await setUp();
    const asked = resolverWith({
      "www.example.com SOA": { Status: NOERROR, Answer: [cname("www.example.com", "example.netlify.app")], Authority: [soa("netlify.app")] },
      ...zoneServedBy("example.com", CLOUDFLARE_NAMESERVERS),
      "a.b.c.example.org SOA": { Status: NOERROR, Answer: [cname("a.b.c.example.org", "b.c.example.org")], Authority: [soa("example.org")] },
      "b.c.example.org SOA": { Status: NOERROR, Answer: [cname("b.c.example.org", "c.example.org")], Authority: [soa("example.org")] },
      "c.example.org SOA": { Status: NOERROR, Answer: [cname("c.example.org", "example.net")], Authority: [soa("example.net")] },
    });
    expect(await lookupOf(administrator, "www.example.com")).toEqual({ zone: "example.com", provider: "cloudflare" });
    expect(asked).toEqual([asking("www.example.com", "SOA"), asking("example.com", "SOA"), asking("example.com", "NS")]);

    asked.length = 0;
    expect(await lookupOf(administrator, "a.b.c.example.org")).toEqual({ zone: null, provider: null });
    expect(asked).toEqual([asking("a.b.c.example.org", "SOA"), asking("b.c.example.org", "SOA"), asking("c.example.org", "SOA")]);
  });

  it("finds nothing for a domain nobody registered, nor nameservers for a zone without any, and asks nothing for a name under localhost", async () => {
    const administrator = await setUp();
    const asked = resolverWith({ "example.com SOA": { Status: NOERROR, Answer: [soa("example.com")] }, "example.com NS": { Status: NOERROR } });
    expect(await lookupOf(administrator, "chat.nobody-registered-this.com")).toEqual({ zone: null, provider: null });
    expect(asked).toEqual([asking("chat.nobody-registered-this.com", "SOA")]);
    expect(await lookupOf(administrator, "example.com")).toEqual({ zone: "example.com", provider: null });

    asked.length = 0;
    expect(await lookupOf(administrator, "chat.localhost:8787")).toEqual({ zone: null, provider: null });
    expect(asked).toEqual([]);
  });

  it("answers what it found when Cloudflare's resolver fails, which it logs", async () => {
    const administrator = await setUp();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const answers: Record<string, DnsAnswer | (() => Promise<Response>)> = zoneServedBy("example.com", CLOUDFLARE_NAMESERVERS);
    resolverWith(answers);
    for (const [failure, error] of [
      [() => Promise.resolve(Response.json({}, { status: 503 })), "DNS over HTTPS answered 503"],
      [() => Promise.resolve(Response.json({ Status: 2 })), "DNS over HTTPS answered rcode 2"],
      [() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "The operation was aborted due to timeout"],
    ] as const) {
      answers[`${DOMAIN} SOA`] = failure;
      expect(await lookupOf(administrator, DOMAIN)).toEqual({ zone: null, provider: null });
      answers[`${DOMAIN} SOA`] = inZone("example.com");
      answers["example.com NS"] = failure;
      expect(await lookupOf(administrator, DOMAIN)).toEqual({ zone: "example.com", provider: null });
      answers["example.com NS"] = zoneServedBy("example.com", CLOUDFLARE_NAMESERVERS)["example.com NS"]!;
      expect(logged.mock.calls.splice(0)).toEqual([
        ["Looking up a custom domain's DNS failed:", error],
        ["Looking up a custom domain's DNS failed:", error],
      ]);
    }
  });

  it("lets only administrators look a domain up, telling anyone else so before checking what they sent, and asks nothing", async () => {
    await setUp();
    const member = await signIn("Grace");
    const asked = resolverWith({});
    for (const domain of [DOMAIN, "ember.kro.workers.dev", 42]) {
      const response = await lookUp(member, domain);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators can change the workspace" });
    }
    expect((await lookUp(null, DOMAIN)).status).toBe(401);
    expect(asked).toEqual([]);
  });

  it("refuses a domain that can't be Ember's, asking nothing", async () => {
    const administrator = await setUp();
    const asked = resolverWith({});
    for (const [domain, error] of [
      ["ember.kro.workers.dev", NOT_A_CUSTOM_DOMAIN],
      ["localhost:8787", NOT_A_CUSTOM_DOMAIN],
      [`https://${DOMAIN}`, CUSTOM_DOMAIN_NOT_A_HOST],
      ["Chat.Example.com", CUSTOM_DOMAIN_NOT_A_HOST],
      [42, CUSTOM_DOMAIN_NOT_A_HOST],
    ] as const) {
      const response = await lookUp(administrator, domain);
      expect([domain, response.status]).toEqual([domain, 422]);
      expect(await response.json()).toEqual({ error });
    }
    expect(asked).toEqual([]);
  });
});
