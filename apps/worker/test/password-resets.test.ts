import {
  CANT_EMAIL_CODES,
  EMAIL_ADDRESS_NEEDED,
  EMAIL_ADDRESS_TOO_LONG,
  EMAILS_PER_ADDRESS,
  MAX_EMAIL_ADDRESS_LENGTH,
  MAX_PASSWORD_LENGTH,
  PASSWORD_RESET_CODE_MINUTES,
  PASSWORD_RESET_CODE_NEEDED,
  PASSWORD_RESET_CODE_TRIES,
  PASSWORD_RESET_CODE_WRONG,
  PASSWORD_RESET_LIMITED,
  PASSWORD_RESETS_LIMITED,
  PASSWORD_RESETS_PER_NETWORK,
  PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT,
  TURNSTILE_FAILED,
  type Bootstrap,
  type Me,
  type NewWorkspace,
  type PasswordResetDone,
  type ProfileChanges,
} from "@ember/protocol";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { verifyPassword } from "../src/passwords";
import { RECOVERY_PATH } from "../src/recovery";
import type { Workspace } from "../src/workspace";
import { api, apiWith, builtPages, cookieOf, freshDeploy, shown, withWorkspaceEnv, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" };

const FROM = "Ember <ember@example.com>";
/** The keys of a deployment whose members may sign in with Memberful. */
const MEMBERFUL_KEYS = { MEMBERFUL_URL: "https://example.memberful.com/", MEMBERFUL_CLIENT_ID: "ember-client-id", MEMBERFUL_CLIENT_SECRET: "ember-client-secret" };
/** Turnstile's test keys: a site key whose check always passes, and a secret key, which this suite's fake siteverify takes. */
const TURNSTILE_KEYS = { TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" };
/** The token Turnstile's test site keys give the page. */
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
/** Sign-in's limit: the passwords, and codes, an IP address may try in 3 minutes. */
const SIGN_IN_ATTEMPTS = 10;
const RECOVERY_TOKEN = "0123456789abcdef".repeat(4);

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Changes the workspace as `administrator`, as its settings save it, on a deployment whose bindings differ from this suite's by `changes`. */
async function change(administrator: Session, body: unknown, changes: Partial<Env> = {}): Promise<void> {
  const response = await apiWith(changes, "/api/account", { method: "PATCH", headers: as(administrator), body: JSON.stringify(body) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Sets Ember up with Ada as its administrator, signed in, with `emailFrom` as its From address. */
async function setUp({ emailFrom = FROM }: { emailFrom?: string | null } = {}): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  const administrator = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
  if (emailFrom !== null) await change(administrator, { emailFrom });
  return administrator;
}

/** Grace joins with the join link, setting a password of her own, signed in. */
async function joinAsGrace(): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify(grace) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

let addresses = 0;
/** An IP address of its own for each request, so that no limit is reached unless a test means it to be. */
const nextAddress = () => `198.51.100.${++addresses % 250}`;

/** Signs in with an email address and password, as the sign-in form does. */
const signInWith = (emailAddress: string, password: string, ip = nextAddress()) =>
  api("/api/session", { method: "POST", headers: { "CF-Connecting-IP": ip }, body: JSON.stringify({ emailAddress, password }) });

const bootstrap = async () => (await (await api("/api/bootstrap")).json()) as Bootstrap;

/** Asks for a code to reset the password of whoever has `emailAddress`, as the page's first form does, to a Worker whose bindings differ from this suite's by `changes`. */
const ask = (emailAddress: unknown, { ip = nextAddress(), changes = {}, turnstileToken }: { ip?: string; changes?: Partial<Env>; turnstileToken?: string } = {}) =>
  apiWith(changes, "/api/password_resets", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip },
    body: JSON.stringify({ emailAddress, ...(turnstileToken !== undefined && { turnstileToken }) }),
  });

/** Gives `code` with a new password for whoever has `emailAddress`, as the page's second form does. */
const reset = (emailAddress: unknown, code: unknown, password: unknown = "difference engine", { ip = nextAddress(), session }: { ip?: string; session?: Session } = {}) =>
  api("/api/password_resets", { method: "PUT", headers: { "CF-Connecting-IP": ip, "User-Agent": "Ada's phone", ...as(session) }, body: JSON.stringify({ emailAddress, code, password }) });

/** The answer to a code that doesn't work. */
async function expectWrong(response: Response): Promise<void> {
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: PASSWORD_RESET_CODE_WRONG, field: "code" });
}

/**
 * Stands in for Cloudflare Email Service's binding, keeping what it's asked to send, and throwing what
 * `refusal` gives, if anything, once `held` lets it answer, if it's given.
 */
function fakeBinding(refusal: () => unknown = () => undefined, held?: Promise<void>) {
  const sent: EmailMessageBuilder[] = [];
  const binding = {
    send: async (message: EmailMessageBuilder) => {
      sent.push(message);
      if (held) await held;
      const refused = refusal();
      if (refused !== undefined) throw refused;
      return { messageId: `<${crypto.randomUUID()}@example.com>` };
    },
  } as unknown as SendEmail;
  return { binding, sent };
}

/** Waits for the codes the Workspace is emailing, which it emails once it has answered. */
const emailed = () => runInDurableObject(workspaceStub(), (instance: Workspace) => (instance as unknown as { lastResetCode: Promise<unknown> }).lastResetCode);

/** Runs `run` with the Workspace sending email through a fake binding, answering what it was asked to send once it has sent it. */
async function emailing(run: () => Promise<void>, refusal?: () => unknown): Promise<EmailMessageBuilder[]> {
  const { binding, sent } = fakeBinding(refusal);
  await withWorkspaceEnv({ EMAIL: binding }, async () => {
    await run();
    await emailed();
  });
  return sent;
}

/** Asks for a code for `emailAddress`, which has to be answered as asked, answering the emails Ember sent. */
async function asked(emailAddress: string, options: Parameters<typeof ask>[1] = {}): Promise<EmailMessageBuilder[]> {
  return emailing(async () => {
    const response = await ask(emailAddress, options);
    expect(response.status, await response.clone().text()).toBe(202);
    expect(await response.json()).toEqual({});
  });
}

/** The code in an email. */
const codeIn = (email: EmailMessageBuilder) => /Your code: (\d+)/.exec(email.text ?? "")![1]!;

/** Asks for a code for `emailAddress`, which has an account, answering the code Ember emailed. */
async function codeFor(emailAddress: string): Promise<string> {
  const [email, ...more] = await asked(emailAddress);
  expect(more).toEqual([]);
  return codeIn(email!);
}

/** A code that isn't `code`. */
const otherThan = (code: string) => (code === "00000000" ? "11111111" : "00000000");

const count = async (table: string) => ((await workspaceSql(`SELECT count(*) AS n FROM ${table}`)) as Array<{ n: number }>)[0]!.n;

/**
 * Has the Workspace's database count, from now on, each row that changes where it counts emails and keeps
 * codes, those a change leaves as they were included, answering how to read how many have.
 */
async function countChanges(): Promise<() => Promise<number>> {
  await workspaceSql("CREATE TABLE changes_made (id INTEGER PRIMARY KEY)");
  for (const table of ["email_link_requests", "password_resets"]) {
    for (const change of ["INSERT", "UPDATE", "DELETE"]) {
      await workspaceSql(`CREATE TRIGGER count_${table}_${change} AFTER ${change} ON ${table} BEGIN INSERT INTO changes_made (id) VALUES (NULL); END`);
    }
  }
  return () => count("changes_made");
}

const sessionsOf = async (userId: string) => ((await workspaceSql("SELECT count(*) AS n FROM sessions WHERE user_id = ?", userId)) as Array<{ n: number }>)[0]!.n;
const passwordDigestOf = async (emailAddress: string) =>
  ((await workspaceSql("SELECT password_digest FROM users WHERE email_address = ?", emailAddress)) as Array<{ password_digest: string }>)[0]!.password_digest;

/** A request the fake siteverify was sent. */
interface SentToSiteverify {
  url: string;
  body: unknown;
}

/** Stands in for Turnstile's siteverify, passing each check, and keeping what it's sent. */
function fakeSiteverify() {
  const requests: SentToSiteverify[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, body: await request.json() });
    return Response.json({ success: true });
  });
  return requests;
}

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Reset a forgotten password with an emailed code", () => {
  it("is offered while Ember can send email, from the From address an administrator gave it", async () => {
    expect((await bootstrap()).passwordResetCodes).toBe(false);
    const administrator = await setUp({ emailFrom: null });
    expect((await bootstrap()).passwordResetCodes).toBe(false);
    await change(administrator, { emailFrom: FROM });
    expect((await bootstrap()).passwordResetCodes).toBe(true);
    // Nor without a way to send it, as without the `EMAIL` binding or a Resend API key.
    await withWorkspaceEnv({ EMAIL: undefined }, async () => expect((await bootstrap()).passwordResetCodes).toBe(false));
  });

  describe("the page", () => {
    /** The page as the browser asks for it, with the built app standing in, without following a redirect. */
    const page = (init: RequestInit<IncomingRequestCfProperties> = {}, changes: Partial<Env> = {}) =>
      apiWith({ ASSETS: builtPages, ...changes }, "/passwords/new", { redirect: "manual", ...init });

    it("is the app's, for anyone, signed in or not, which no cache keeps", async () => {
      const administrator = await setUp();
      for (const session of [null, administrator]) {
        const response = await page({ headers: as(session) });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("page /");
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
      expect((await page({ method: "HEAD" })).status).toBe(200);
      expect((await page({ method: "POST" })).status).toBe(404);
    });

    it("lets Turnstile's check load while the deployment has its keys", async () => {
      await setUp();
      const turnstile = "https://challenges.cloudflare.com";
      expect((await page({}, TURNSTILE_KEYS)).headers.get("Content-Security-Policy")).toContain(`; frame-src ${turnstile};`);
      expect((await page()).headers.get("Content-Security-Policy")).not.toContain(turnstile);
    });
  });

  describe("asking for a code", () => {
    it(`emails an address with a password a code that works for ${PASSWORD_RESET_CODE_MINUTES} minutes, from the From address, keeping only its digest`, async () => {
      const administrator = await setUp();
      const [email, ...more] = await asked("ada@example.com");
      expect(more).toEqual([]);
      const code = codeIn(email!);
      expect(code).toMatch(/^[0-9]{8}$/);
      expect(email).toEqual({
        from: { name: "Ember", email: "ember@example.com" },
        to: "ada@example.com",
        subject: "Reset your password at Ember",
        text: `Someone asked to reset the password for this email address at Ember.\n\nYour code: ${code}\n\nEnter it within ${PASSWORD_RESET_CODE_MINUTES} minutes, with a new password, where you asked for it. Don't give it to anyone.\n\nIf you didn't ask, you can ignore this email: your password stays as it is.\n`,
        html: expect.stringContaining(`>${code}</strong>`) as unknown,
      });

      const [row] = (await workspaceSql("SELECT user_id, code_digest, email_address, password_digest, created_at, expires_at, attempts FROM password_resets")) as Array<Record<string, string | number>>;
      expect(row).toMatchObject({ user_id: administrator.user.id, email_address: "ada@example.com", password_digest: await passwordDigestOf("ada@example.com"), attempts: 0 });
      expect(row!.code_digest).not.toContain(code);
      expect(Date.parse(row!.expires_at as string) - Date.parse(row!.created_at as string)).toBe(PASSWORD_RESET_CODE_MINUTES * 60 * 1000);
      expect(await workspaceSql("SELECT email_address, count FROM email_link_requests")).toEqual([{ email_address: "ada@example.com", count: 1 }]);
    });

    it("sends the code under the workspace's name while the From address has none", async () => {
      const administrator = await setUp({ emailFrom: "join@example.com" });
      await change(administrator, { name: "NYLLON" });
      const [email] = await asked("ada@example.com");
      expect(email).toMatchObject({ from: { name: "NYLLON", email: "join@example.com" }, subject: "Reset your password at NYLLON" });
    });

    it("answers the same for an address with no account that signs in with a password, emailing nothing", async () => {
      await setUp();
      await joinAsGrace();
      await workspaceSql("UPDATE users SET status = 1 WHERE email_address = ?", grace.emailAddress);
      const now = new Date().toISOString();
      await workspaceSql("INSERT INTO users (id, name, email_address, role, created_at, updated_at) VALUES ('robot', 'Build Bot', 'bot@example.com', 2, ?, ?)", now, now);
      await workspaceSql("INSERT INTO users (id, name, email_address, password_digest, created_at, updated_at) VALUES ('member', 'Linus', 'linus@example.com', '', ?, ?)", now, now);

      // Nobody, someone else's address in another case, someone deactivated, a bot, and someone without a password.
      for (const emailAddress of ["nobody@example.com", "ADA@example.com", grace.emailAddress, "bot@example.com", "linus@example.com"]) {
        expect(await asked(emailAddress), emailAddress).toEqual([]);
      }
      expect(await count("password_resets")).toBe(0);
      expect(await count("email_link_requests")).toBe(0);
    });

    it("answers before it emails the code, so how soon it answers says nothing of who has an account", async () => {
      await setUp();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const sent: EmailMessageBuilder[] = [];
      const binding = {
        send: async (message: EmailMessageBuilder) => {
          sent.push(message);
          await held;
          return { messageId: `<${crypto.randomUUID()}@example.com>` };
        },
      } as unknown as SendEmail;
      await withWorkspaceEnv({ EMAIL: binding }, async () => {
        expect((await ask("ada@example.com")).status).toBe(202);
        expect(await count("password_resets")).toBe(0);
        release();
        await emailed();
      });
      expect(sent).toHaveLength(1);
      expect(await count("password_resets")).toBe(1);
    });

    it("changes as much of what's stored before it answers, whoever has the address, leaving every count as it was", async () => {
      await setUp();
      const changes = await countChanges();
      let release!: () => void;
      const { binding, sent } = fakeBinding(undefined, new Promise<void>((resolve) => (release = resolve)));
      await withWorkspaceEnv({ EMAIL: binding }, async () => {
        // While Ada's first code is being sent, her next waits its turn, so it counts no email before it's answered.
        expect((await ask("ada@example.com")).status).toBe(202);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        const counts = await workspaceSql("SELECT email_address, counted_since, count FROM email_link_requests");
        const changed: number[] = [];
        for (const emailAddress of ["nobody@example.com", "ada@example.com"]) {
          const before = await changes();
          expect((await ask(emailAddress)).status).toBe(202);
          changed.push((await changes()) - before);
          expect(await workspaceSql("SELECT email_address, counted_since, count FROM email_link_requests"), emailAddress).toEqual(counts);
        }
        expect(changed[0]).toBeGreaterThan(0);
        expect(changed[1]).toBe(changed[0]);
        release();
        await emailed();
      });
      expect(sent).toHaveLength(2);
    });

    it("replaces the code sent before, so only the newest works", async () => {
      await setUp();
      const first = await codeFor("ada@example.com");
      const second = await codeFor("ada@example.com");
      await expectWrong(await reset("ada@example.com", first === second ? otherThan(second) : first));
      expect(await count("password_resets")).toBe(1);
      expect((await reset("ada@example.com", second)).status).toBe(201);
    });

    it(`emails an address at most ${EMAILS_PER_ADDRESS} times an hour, whoever asks, counting links to join with it`, async () => {
      const administrator = await setUp();
      // Asking to join with Ada's address at the email domains emails her where to sign in.
      await change(administrator, { emailDomains: ["example.com"], settings: { emailDomainSignUp: true } });
      const joining = await emailing(async () => {
        const response = await api("/api/email_links", { method: "POST", headers: { "CF-Connecting-IP": nextAddress() }, body: JSON.stringify({ emailAddress: "ada@example.com" }) });
        expect(response.status).toBe(202);
      });
      expect(joining).toMatchObject([{ subject: "You already have an account at Ember" }]);

      const sent: EmailMessageBuilder[] = [];
      for (let n = 1; n <= EMAILS_PER_ADDRESS; n++) sent.push(...(await asked("ada@example.com")));
      expect(sent).toHaveLength(EMAILS_PER_ADDRESS - 1);
      expect(await workspaceSql("SELECT count FROM email_link_requests")).toEqual([{ count: EMAILS_PER_ADDRESS }]);
      expect((await reset("ada@example.com", codeIn(sent.at(-1)!))).status).toBe(201);
    });

    it("counts no email the provider refuses, which keeps no code, leaving the one sent before working", async () => {
      await setUp();
      const code = await codeFor("ada@example.com");
      const refused = await emailing(
        async () => expect((await ask("ada@example.com")).status).toBe(202),
        () => new Error("the provider is down"),
      );
      expect(refused).toHaveLength(1);
      expect(await workspaceSql("SELECT count FROM email_link_requests")).toEqual([{ count: 1 }]);
      expect((await reset("ada@example.com", code)).status).toBe(201);
    });

    it.each([
      [EMAILS_PER_ADDRESS + 1, 1, EMAILS_PER_ADDRESS + 1, EMAILS_PER_ADDRESS],
      [EMAILS_PER_ADDRESS + 2, 1, EMAILS_PER_ADDRESS + 1, EMAILS_PER_ADDRESS],
      [2 * EMAILS_PER_ADDRESS, EMAILS_PER_ADDRESS, 2 * EMAILS_PER_ADDRESS, EMAILS_PER_ADDRESS],
      [2 * EMAILS_PER_ADDRESS, 2 * EMAILS_PER_ADDRESS, 2 * EMAILS_PER_ADDRESS, 0],
    ])("of %i asks waiting, the first %i of which the provider refuses, tries to email %i and counts the %i it takes", async (asks, refusals, tried, taken) => {
      await setUp();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let refused = 0;
      const { binding, sent } = fakeBinding(() => (refused++ < refusals ? new Error("the provider is down") : undefined), held);
      await withWorkspaceEnv({ EMAIL: binding }, async () => {
        // The first is being sent while the rest are asked for, so each of them is counted at its turn.
        for (let n = 1; n <= asks; n++) expect((await ask("ada@example.com")).status).toBe(202);
        release();
        await emailed();
      });
      expect(sent).toHaveLength(tried);
      expect(await workspaceSql("SELECT count FROM email_link_requests")).toEqual([{ count: taken }]);
      expect(await count("password_resets")).toBe(taken > 0 ? 1 : 0);
      if (taken > 0) expect((await reset("ada@example.com", codeIn(sent.at(-1)!))).status).toBe(201);
    });

    it(`lets a network ask ${PASSWORD_RESETS_PER_NETWORK} times an hour until the deployment has Turnstile's keys, then asks Turnstile instead`, async () => {
      await setUp();
      await emailing(async () => {
        for (let n = 1; n <= PASSWORD_RESETS_PER_NETWORK; n++) expect((await ask(`person${n}@example.com`, { ip: "203.0.113.50" })).status).toBe(202);
        const limited = await ask("ada@example.com", { ip: "203.0.113.50" });
        expect(limited.status).toBe(429);
        expect(await limited.json()).toEqual({ error: PASSWORD_RESETS_LIMITED });
        expect((await ask("ada@example.com", { ip: "203.0.113.51" })).status).toBe(202);

        const checks = fakeSiteverify();
        const unchecked = await ask("ada@example.com", { ip: "203.0.113.50", changes: TURNSTILE_KEYS });
        expect(unchecked.status).toBe(422);
        expect(await unchecked.json()).toEqual({ error: TURNSTILE_FAILED, field: "turnstile" });
        expect((await ask("ada@example.com", { ip: "203.0.113.50", changes: TURNSTILE_KEYS, turnstileToken: TOKEN })).status).toBe(202);
        expect(checks).toEqual([{ url: "https://challenges.cloudflare.com/turnstile/v0/siteverify", body: { secret: TURNSTILE_KEYS.TURNSTILE_SECRET_KEY, response: TOKEN, remoteip: "203.0.113.50" } }]);
      });
    });

    it("says so while Ember can't send email", async () => {
      const administrator = await setUp();
      await withWorkspaceEnv({ EMAIL: undefined }, async () => {
        const unsendable = await ask("ada@example.com");
        expect(unsendable.status).toBe(503);
        expect(await unsendable.json()).toEqual({ error: CANT_EMAIL_CODES });
      });

      const sent = await emailing(async () => {
        await change(administrator, { emailFrom: null });
        expect((await ask("ada@example.com")).status).toBe(503);
      });
      expect(sent).toEqual([]);
    });

    it.each([
      ["no address", "", EMAIL_ADDRESS_NEEDED],
      ["what isn't text", 42, EMAIL_ADDRESS_NEEDED],
      ["an address longer than any account's", `${"a".repeat(MAX_EMAIL_ADDRESS_LENGTH)}@example.com`, EMAIL_ADDRESS_TOO_LONG],
    ])("refuses %s on its field", async (_, emailAddress, error) => {
      await setUp();
      const response = await ask(emailAddress);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error, field: "emailAddress" });
    });
  });

  describe("choosing a new password with the code", () => {
    it("gives the account the new password, ending all its sessions, and signs this browser in as them, spending the code", async () => {
      const administrator = await setUp();
      const phone = await signInWith(ada.emailAddress, ada.password);
      expect(phone.status).toBe(201);
      const code = await codeFor("ada@example.com");

      const response = await reset("ada@example.com", code);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ user: { id: administrator.user.id, name: ada.name, administrator: true } } satisfies PasswordResetDone);
      const cookie = cookieOf(response);
      expect((await api("/api/me", { headers: { Cookie: cookie } })).status).toBe(200);
      for (const ended of [administrator.cookie, cookieOf(phone)]) expect((await api("/api/me", { headers: { Cookie: ended } })).status).toBe(401);
      expect(await sessionsOf(administrator.user.id)).toBe(1);
      expect(await verifyPassword("difference engine", await passwordDigestOf("ada@example.com"))).toBe(true);
      expect((await signInWith(ada.emailAddress, ada.password)).status).toBe(401);
      expect((await signInWith(ada.emailAddress, "difference engine")).status).toBe(201);

      expect(await count("password_resets")).toBe(0);
      await expectWrong(await reset("ada@example.com", code, "another password"));
    });

    it("keeps the code working when the new password can't be saved", async () => {
      await setUp();
      const code = await codeFor("ada@example.com");
      // Make the storage refuse to change passwords.
      await workspaceSql("CREATE TRIGGER refuse_passwords BEFORE UPDATE OF password_digest ON users BEGIN SELECT RAISE(ABORT, 'refused'); END");
      expect((await reset("ada@example.com", code)).status).toBe(500);
      expect(await count("password_resets")).toBe(1);

      await workspaceSql("DROP TRIGGER refuse_passwords");
      expect((await reset("ada@example.com", code)).status).toBe(201);
      expect((await signInWith(ada.emailAddress, "difference engine")).status).toBe(201);
    });

    it("takes a code typed in groups, or in full-width digits", async () => {
      await setUp();
      const code = await codeFor("ada@example.com");
      const fullWidth = [...code].map((digit) => String.fromCharCode(0xff10 + Number(digit))).join("");
      expect((await reset("ada@example.com", ` ${fullWidth.slice(0, 4)}-${fullWidth.slice(4)} `)).status).toBe(201);
      const next = await codeFor("ada@example.com");
      expect((await reset("ada@example.com", `${next.slice(0, 4)} ${next.slice(4)}`, "another password")).status).toBe(201);
    });

    it("says the same of a code that doesn't work whether or not anyone has the address", async () => {
      await setUp();
      await joinAsGrace();
      const code = await codeFor("ada@example.com");
      for (const [emailAddress, tried] of [
        ["nobody@example.com", code],
        [grace.emailAddress, code],
        ["ADA@example.com", code],
        ["ada@example.com", otherThan(code)],
      ]) {
        await expectWrong(await reset(emailAddress, tried));
      }
      expect((await reset("ada@example.com", code)).status).toBe(201);
    });

    it("changes what's stored before it answers, whether or not a code works for the address", async () => {
      await setUp();
      await joinAsGrace();
      const code = await codeFor("ada@example.com");
      const changes = await countChanges();
      // Nobody, someone without a code, and someone with one, which alone counts the try.
      for (const emailAddress of ["nobody@example.com", grace.emailAddress, "ada@example.com"]) {
        const before = await changes();
        await expectWrong(await reset(emailAddress, otherThan(code)));
        expect((await changes()) - before, emailAddress).toBeGreaterThan(0);
      }
      expect(await workspaceSql("SELECT attempts FROM password_resets")).toEqual([{ attempts: 1 }]);
      expect(await workspaceSql("SELECT email_address, count FROM email_link_requests")).toEqual([{ email_address: "ada@example.com", count: 1 }]);
    });

    it(`takes ${PASSWORD_RESET_CODE_TRIES} tries, the last of which can be right, then stops working`, async () => {
      await setUp();
      const code = await codeFor("ada@example.com");
      for (let n = 1; n < PASSWORD_RESET_CODE_TRIES; n++) await expectWrong(await reset("ada@example.com", otherThan(code)));
      expect((await reset("ada@example.com", code)).status).toBe(201);

      const next = await codeFor("ada@example.com");
      for (let n = 1; n <= PASSWORD_RESET_CODE_TRIES; n++) await expectWrong(await reset("ada@example.com", otherThan(next), "another password"));
      await expectWrong(await reset("ada@example.com", next, "another password"));
      expect(await workspaceSql("SELECT attempts FROM password_resets")).toEqual([{ attempts: PASSWORD_RESET_CODE_TRIES }]);
      expect((await signInWith(ada.emailAddress, "difference engine")).status).toBe(201);
    });

    it(`stops working after ${PASSWORD_RESET_CODE_MINUTES} minutes, and is forgotten once another code is kept`, async () => {
      await setUp();
      await joinAsGrace();
      const code = await codeFor("ada@example.com");
      await workspaceSql("UPDATE password_resets SET expires_at = ?", new Date(Date.now() - 1000).toISOString());
      await expectWrong(await reset("ada@example.com", code));

      await codeFor(grace.emailAddress);
      expect(await workspaceSql("SELECT email_address FROM password_resets")).toEqual([{ email_address: grace.emailAddress }]);
    });

    it("counts each try against sign-in's limit, before anything is checked", async () => {
      await setUp();
      const code = await codeFor("ada@example.com");
      const ip = "203.0.113.60";
      for (let n = 1; n <= SIGN_IN_ATTEMPTS; n++) await expectWrong(await reset("nobody@example.com", "12345678", "difference engine", { ip }));
      const limited = await reset("ada@example.com", code, "difference engine", { ip });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: PASSWORD_RESET_LIMITED });
      expect((await signInWith(ada.emailAddress, ada.password, ip)).status).toBe(429);

      // Elsewhere, the code works, untried.
      expect(await workspaceSql("SELECT attempts FROM password_resets")).toEqual([{ attempts: 0 }]);
      expect((await reset("ada@example.com", code)).status).toBe(201);
    });

    it("refuses a code that can't be one, and a password Ember won't take, on their fields, trying nothing", async () => {
      await setUp();
      const code = await codeFor("ada@example.com");
      const refusals: Array<[code: string, password: string, answer: unknown]> = [
        ["1234567", "difference engine", { error: PASSWORD_RESET_CODE_NEEDED, field: "code" }],
        ["1234567a", "difference engine", { error: PASSWORD_RESET_CODE_NEEDED, field: "code" }],
        ["123456789", "difference engine", { error: PASSWORD_RESET_CODE_NEEDED, field: "code" }],
        [code, "short", { error: PASSWORD_TOO_SHORT, field: "password" }],
        [code, "x".repeat(MAX_PASSWORD_LENGTH + 1), { error: PASSWORD_TOO_LONG, field: "password" }],
      ];
      for (const [tried, password, answer] of refusals) {
        const response = await reset("ada@example.com", tried, password);
        expect(response.status, `${tried} ${password}`).toBe(422);
        expect(await response.json()).toEqual(answer);
      }
      for (const body of ["not JSON", "[]", JSON.stringify({ emailAddress: "ada@example.com", code }), JSON.stringify({ emailAddress: 42, code, password: "difference engine" })]) {
        const response = await api("/api/password_resets", { method: "PUT", headers: { "CF-Connecting-IP": nextAddress() }, body });
        expect(response.status, body).toBe(400);
      }
      expect(await workspaceSql("SELECT attempts FROM password_resets")).toEqual([{ attempts: 0 }]);
    });

    it("stops working once the account's email address or password changes", async () => {
      const administrator = await setUp();
      /** Changes Ada's profile, which has to work. */
      const save = async (changes: ProfileChanges) =>
        expect((await api("/api/users/me/profile", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ ...changes, currentPassword: ada.password }) })).status).toBe(200);

      const beforeNewPassword = await codeFor("ada@example.com");
      await save({ password: "a password of her own" });
      await expectWrong(await reset("ada@example.com", beforeNewPassword));
      // The recovery script's reset ends a code too.
      const beforeRecovery = await codeFor("ada@example.com");
      const recovered = await apiWith({ EMBER_RECOVERY_TOKEN: RECOVERY_TOKEN }, RECOVERY_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${RECOVERY_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ emailAddress: "ada@example.com", password: ada.password }),
      });
      expect(recovered.status).toBe(200);
      expect(await count("password_resets")).toBe(0);
      await expectWrong(await reset("ada@example.com", beforeRecovery));
    });

    it("stops working once the account's email address changes, for either address", async () => {
      const administrator = await setUp();
      const code = await codeFor("ada@example.com");
      const moved = await api("/api/users/me/profile", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ emailAddress: "ada@lovelace.example", currentPassword: ada.password }) });
      expect(moved.status).toBe(200);
      await expectWrong(await reset("ada@example.com", code));
      await expectWrong(await reset("ada@lovelace.example", code));
    });

    it("signs in nobody who signs in with Memberful while it's members only, though their password changes", async () => {
      const administrator = await setUp();
      const member = await joinAsGrace();
      await change(administrator, { settings: { memberfulSignIn: true } }, MEMBERFUL_KEYS);
      const code = await codeFor(grace.emailAddress);

      const response = await reset(grace.emailAddress, code);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ user: null } satisfies PasswordResetDone);
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(await sessionsOf(member.user.id)).toBe(0);
      expect(await verifyPassword("difference engine", await passwordDigestOf(grace.emailAddress))).toBe(true);
    });
  });
});
