import {
  MAX_TURNSTILE_TOKEN_LENGTH,
  TURNSTILE_CHECK_EXPIRED,
  TURNSTILE_CHECK_PATH,
  TURNSTILE_FAILED,
  TURNSTILE_KEYS_UNCHECKED,
  TURNSTILE_KEYS_UNMATCHED,
  TURNSTILE_SECRET_KEY_REFUSED,
  TURNSTILE_SECRET_KEY_UNKNOWN,
  TURNSTILE_SITE_KEY_REFUSED,
  type Bootstrap,
  type NewWorkspace,
  type TurnstileSettings,
  type WorkspaceSettings,
} from "@ember/protocol";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineScriptHashes } from "../src/csp";
import type { Env } from "../src/env";
import { api, apiWith, builtPages, cookieOf, freshDeploy, shown, signIn, withWorkspaceEnv, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler" };

/** A Turnstile widget's keys, as an administrator copies them from Cloudflare's dashboard. */
const KEYS = { siteKey: "0x4AAAAAAA-a-widgets-site-key", secretKey: "0x4AAAAAAA-a-widgets-secret-key" };
/** The token the widget's check gave Set up Turnstile. */
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
/** What Set up Turnstile sends once the widget's check passes. */
const CHECKED = { ...KEYS, turnstileToken: TOKEN };
/** The deployment's own keys, as its secrets hold them: Turnstile's test keys. */
const DEPLOYMENT_KEYS = { TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" };
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Where Turnstile's script and frame come from, which a page's policy names to let its check load. */
const TURNSTILE = "https://challenges.cloudflare.com";

/** Sets Ember up with Ada as its administrator, signed in, and Open on, so that the check guards signing up. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  const administrator = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
  const opened = await api("/api/account", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ settings: { openSignUp: true } }) });
  expect(opened.status, await opened.clone().text()).toBe(200);
  return administrator;
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Gives Ember a widget's keys as `session`, as Set up Turnstile does, on a deployment whose bindings differ from this suite's by `changes`. */
const giveKeys = (session: Session | null, keys: unknown, changes: Partial<Env> = {}) =>
  apiWith(changes, "/api/account/turnstile_keys", { method: "PUT", headers: { ...as(session), "CF-Connecting-IP": "203.0.113.30" }, body: JSON.stringify(keys) });

/** Gives Ember `KEYS` as `administrator`, which has to work. */
async function saveKeys(administrator: Session): Promise<void> {
  const response = await giveKeys(administrator, CHECKED);
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Takes Ember's widget's keys away as `session`, as turning off the Turnstile card's switch does. */
const forgetKeys = (session: Session | null, changes: Partial<Env> = {}) =>
  apiWith(changes, "/api/account/turnstile_keys", { method: "DELETE", headers: as(session) });

/** Where the workspace's settings say Ember's Turnstile keys come from. */
const turnstileSettings = async (session: Session, changes: Partial<Env> = {}) =>
  ((await (await apiWith(changes, "/api/account", { headers: as(session) })).json()) as WorkspaceSettings).turnstile;

const bootstrap = async (changes: Partial<Env> = {}) => (await (await apiWith(changes, "/api/bootstrap")).json()) as Bootstrap;

/** The account's settings, as the database keeps them. */
const storedSettings = async () => JSON.parse(((await workspaceSql("SELECT settings FROM accounts")) as Array<{ settings: string }>)[0]!.settings) as Record<string, unknown>;

/** Signs Grace up while anyone may, with `turnstileToken` if given. */
const signUp = (turnstileToken?: string, changes: Partial<Env> = {}) =>
  apiWith(changes, "/api/join", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.40" }, body: JSON.stringify({ ...grace, ...(turnstileToken && { turnstileToken }) }) });

/** A page as the Worker serves it to someone signed out. */
const page = (path: string) => apiWith({ ASSETS: builtPages }, path, { redirect: "manual" });

/** A request the fake siteverify was sent. */
interface SentToSiteverify {
  url: string;
  method: string;
  body: unknown;
}

/** Stands in for Turnstile's siteverify, answering `answer` to each check, and keeping what it's sent. */
function fakeSiteverify(answer: () => Response | Promise<Response> = () => Response.json({ success: true })) {
  const requests: SentToSiteverify[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, method: request.method, body: await request.json() });
    return answer();
  });
  return requests;
}

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Check that people are people with Cloudflare Turnstile", () => {
  describe("Set up Turnstile", () => {
    it("keeps a widget's keys once siteverify passes the check drawn with them, its secret key sealed", async () => {
      const administrator = await setUp();
      const checks = fakeSiteverify();
      const response = await giveKeys(administrator, { siteKey: ` ${KEYS.siteKey} `, secretKey: `${KEYS.secretKey}\n`, turnstileToken: TOKEN });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ turnstile: "saved" } satisfies TurnstileSettings);
      expect(checks).toEqual([{ url: SITEVERIFY, method: "POST", body: { secret: KEYS.secretKey, response: TOKEN, remoteip: "203.0.113.30" } }]);

      // The database holds the secret key sealed, never as it was given.
      const stored = (await storedSettings()).turnstile_keys as { site_key: string; secret_key: string };
      expect(stored).toEqual({ site_key: KEYS.siteKey, secret_key: expect.stringMatching(/^v1\.[\w-]{16}\.[\w-]+$/) as unknown });
      expect(JSON.stringify(await workspaceSql("SELECT * FROM accounts"))).not.toContain(KEYS.secretKey);
      expect(await turnstileSettings(administrator)).toBe("saved");
      expect((await bootstrap()).turnstileSiteKey).toBe(KEYS.siteKey);

      // Given again, it's sealed afresh.
      await saveKeys(administrator);
      expect(((await storedSettings()).turnstile_keys as typeof stored).secret_key).not.toBe(stored.secret_key);
    });

    it("says why a widget's keys aren't kept, on the field they're about, asking siteverify nothing of keys that can't be one", async () => {
      const administrator = await setUp();
      const unasked = fakeSiteverify();
      const refusals: Array<[unknown, string, string]> = [
        [{ ...CHECKED, siteKey: "a site key" }, "siteKey", TURNSTILE_SITE_KEY_REFUSED],
        [{ ...CHECKED, siteKey: "0x4AAAA" }, "siteKey", TURNSTILE_SITE_KEY_REFUSED],
        [{ ...CHECKED, siteKey: `0x${"A".repeat(99)}` }, "siteKey", TURNSTILE_SITE_KEY_REFUSED],
        [{ ...CHECKED, siteKey: 42 }, "siteKey", TURNSTILE_SITE_KEY_REFUSED],
        [{ secretKey: KEYS.secretKey, turnstileToken: TOKEN }, "siteKey", TURNSTILE_SITE_KEY_REFUSED],
        [{ ...CHECKED, secretKey: "sk_live_0123456789abcdef" }, "secretKey", TURNSTILE_SECRET_KEY_REFUSED],
        [{ ...CHECKED, secretKey: KEYS.siteKey }, "secretKey", TURNSTILE_SECRET_KEY_REFUSED],
        [{ siteKey: KEYS.siteKey, turnstileToken: TOKEN }, "secretKey", TURNSTILE_SECRET_KEY_REFUSED],
        [KEYS, "turnstile", TURNSTILE_FAILED],
        [{ ...KEYS, turnstileToken: "" }, "turnstile", TURNSTILE_FAILED],
        [{ ...KEYS, turnstileToken: "x".repeat(MAX_TURNSTILE_TOKEN_LENGTH + 1) }, "turnstile", TURNSTILE_FAILED],
        [null, "siteKey", TURNSTILE_SITE_KEY_REFUSED],
      ];
      for (const [given, field, error] of refusals) {
        const response = await giveKeys(administrator, given);
        expect(response.status, JSON.stringify(given)).toBe(422);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.json()).toEqual({ error, field });
      }
      expect(unasked).toEqual([]);
      expect(await storedSettings()).not.toHaveProperty("turnstile_keys");
    });

    it("says why siteverify didn't take the check, keeping no keys, and logs its error codes but never a key", async () => {
      const administrator = await setUp();
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const didntPass = (code: string) => () => Response.json({ success: false, "error-codes": [code] });
      const refusals: Array<[() => Response | Promise<Response>, number, Record<string, string>]> = [
        [didntPass("invalid-input-secret"), 422, { error: TURNSTILE_SECRET_KEY_UNKNOWN, field: "secretKey" }],
        [didntPass("invalid-input-response"), 422, { error: TURNSTILE_KEYS_UNMATCHED, field: "secretKey" }],
        [didntPass("timeout-or-duplicate"), 422, { error: TURNSTILE_CHECK_EXPIRED, field: "turnstile" }],
        [didntPass("internal-error"), 502, { error: TURNSTILE_KEYS_UNCHECKED }],
        [() => new Response("Bad gateway", { status: 502 }), 502, { error: TURNSTILE_KEYS_UNCHECKED }],
        [() => new Response("<html>"), 502, { error: TURNSTILE_KEYS_UNCHECKED }],
        [() => Promise.reject(new TypeError("Network connection lost")), 502, { error: TURNSTILE_KEYS_UNCHECKED }],
      ];
      for (const [answer, status, refusal] of refusals) {
        const checks = fakeSiteverify(answer);
        const response = await giveKeys(administrator, CHECKED);
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(refusal);
        expect(checks).toHaveLength(1);
        vi.mocked(fetch).mockRestore();
      }
      expect(await storedSettings()).not.toHaveProperty("turnstile_keys");
      expect(await turnstileSettings(administrator)).toBeNull();
      expect(warned).toHaveBeenCalledWith("Turnstile's check didn't pass:", 200, ["invalid-input-secret"]);
      expect(JSON.stringify([...warned.mock.calls, ...logged.mock.calls])).not.toContain(KEYS.secretKey);
    });

    it("lets only administrators give or take away a widget's keys, asking siteverify nothing for anyone else", async () => {
      await setUp();
      const member = await signIn("Grace");
      const checks = fakeSiteverify();
      expect((await giveKeys(member, CHECKED)).status).toBe(403);
      expect((await giveKeys(null, CHECKED)).status).toBe(401);
      expect((await giveKeys(member, { siteKey: "not a key" })).status).toBe(403);
      expect((await forgetKeys(member)).status).toBe(403);
      expect((await forgetKeys(null)).status).toBe(401);
      expect(checks).toEqual([]);
      expect(await storedSettings()).not.toHaveProperty("turnstile_keys");
    });

    it("forgets the keys, which leaves the network's limits in place of the check", async () => {
      const administrator = await setUp();
      fakeSiteverify();
      await saveKeys(administrator);
      const response = await forgetKeys(administrator);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ turnstile: null } satisfies TurnstileSettings);
      expect((await storedSettings()).turnstile_keys).toBeNull();
      expect(await turnstileSettings(administrator)).toBeNull();
      expect((await bootstrap()).turnstileSiteKey).toBeNull();
      expect((await page("/join")).headers.get("Content-Security-Policy")).not.toContain(TURNSTILE);
      expect((await signUp()).status).toBe(201);
      // Forgetting none changes nothing.
      expect(await (await forgetKeys(administrator)).json()).toEqual({ turnstile: null });
    });
  });

  describe("with the keys given", () => {
    it("checks whoever signs up, or asks Ember to email them, with them, once the Workspace starts afresh", async () => {
      const administrator = await setUp();
      const checks = fakeSiteverify();
      await saveKeys(administrator);
      await evictDurableObject(workspaceStub());

      const unchecked = await signUp();
      expect(unchecked.status).toBe(422);
      expect(await unchecked.json()).toEqual({ error: TURNSTILE_FAILED, field: "turnstile" });
      expect((await signUp(TOKEN)).status).toBe(201);
      expect(checks.at(-1)).toEqual({ url: SITEVERIFY, method: "POST", body: { secret: KEYS.secretKey, response: TOKEN, remoteip: "203.0.113.40" } });

      const asked = await api("/api/password_resets", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.41" }, body: JSON.stringify({ emailAddress: ada.emailAddress }) });
      expect(asked.status).toBe(422);
      expect(await asked.json()).toEqual({ error: TURNSTILE_FAILED, field: "turnstile" });
      expect(checks).toHaveLength(2);
    });

    it("lets Turnstile's check load on the pages that show it", async () => {
      const administrator = await setUp();
      fakeSiteverify();
      await saveKeys(administrator);
      for (const path of ["/join", "/passwords/new"]) {
        const policy = (await page(path)).headers.get("Content-Security-Policy")!;
        expect(policy, path).toMatch(new RegExp(`script-src 'self'[^;]* ${TURNSTILE};`));
        expect(policy, path).toContain(`; frame-src ${TURNSTILE};`);
      }
      expect((await page("/session/new")).headers.get("Content-Security-Policy")).not.toContain(TURNSTILE);
    });

    it("checks people with the deployment's keys rather than the ones given, while it has both", async () => {
      const administrator = await setUp();
      const checks = fakeSiteverify();
      await saveKeys(administrator);
      expect(await turnstileSettings(administrator, DEPLOYMENT_KEYS)).toBe("secret");
      expect((await bootstrap(DEPLOYMENT_KEYS)).turnstileSiteKey).toBe(DEPLOYMENT_KEYS.TURNSTILE_SITE_KEY);
      expect((await signUp(TOKEN, DEPLOYMENT_KEYS)).status).toBe(201);
      expect(checks.at(-1)!.body).toEqual({ secret: DEPLOYMENT_KEYS.TURNSTILE_SECRET_KEY, response: TOKEN, remoteip: "203.0.113.40" });

      // Keys given or taken away while it has its own say so, and wait for when it hasn't.
      expect(await (await giveKeys(administrator, CHECKED, DEPLOYMENT_KEYS)).json()).toEqual({ turnstile: "secret" });
      expect(checks.at(-1)!.body).toMatchObject({ secret: KEYS.secretKey });
      expect(await turnstileSettings(administrator)).toBe("saved");
      expect(await (await forgetKeys(administrator, DEPLOYMENT_KEYS)).json()).toEqual({ turnstile: "secret" });
      expect(await turnstileSettings(administrator)).toBeNull();
    });

    it("uses no secret key sealed under another SESSION_SECRET, which it logs", async () => {
      const administrator = await setUp();
      const checks = fakeSiteverify();
      await saveKeys(administrator);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await withWorkspaceEnv({ SESSION_SECRET: "another secret, after the key was sealed" }, async () => {
        expect(await turnstileSettings(administrator)).toBeNull();
        expect((await bootstrap()).turnstileSiteKey).toBeNull();
        expect((await signUp()).status).toBe(201);
      });
      expect(checks).toHaveLength(1);
      expect(logged).toHaveBeenCalledWith("The Turnstile secret key Ember was given doesn't open under SESSION_SECRET, so it isn't used.");
      expect(await turnstileSettings(administrator)).toBe("saved");
    });
  });

  describe("the check page", () => {
    it("draws a widget's check from a page of its own, whose policy alone lets Turnstile load, framed by Ember's pages alone", async () => {
      const response = await api(TURNSTILE_CHECK_PATH);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
      const html = await response.text();
      expect(html).toContain(`${TURNSTILE}/turnstile/v0/api.js?render=explicit`);
      const policy = response.headers.get("Content-Security-Policy")!;
      const [hash] = await inlineScriptHashes(html);
      expect(policy).toContain(`script-src 'self' https://static.cloudflareinsights.com/beacon.min.js/ 'sha256-${hash}' ${TURNSTILE};`);
      expect(policy).toContain(`; frame-src ${TURNSTILE};`);
      expect(policy).toContain("; frame-ancestors 'self';");
    });

    it("answers HEAD with nothing, and refuses other methods", async () => {
      const head = await api(TURNSTILE_CHECK_PATH, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const posted = await api(TURNSTILE_CHECK_PATH, { method: "POST" });
      expect(posted.status).toBe(405);
      expect(posted.headers.get("Allow")).toBe("GET, HEAD");
    });
  });
});
