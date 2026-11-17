import {
  CANT_EMAIL_LINKS,
  EMAIL_ADDRESS_NEEDED,
  EMAIL_DOMAIN_NEEDS_EMAIL,
  EMAIL_DOMAINS_REFUSED,
  EMAIL_LINK_GONE,
  EMAIL_LINKS_LIMITED,
  EMAILS_PER_ADDRESS,
  EMAIL_LINKS_PER_NETWORK,
  INVITATION_GONE,
  JOINING_PROBLEMS,
  NO_EMAIL_DOMAINS,
  onlyAddressesAt,
  TURNSTILE_FAILED,
  type Account,
  type Bootstrap,
  type Invited,
  type Me,
  type NewWorkspace,
  type Sidebar,
  type WorkspaceSettings,
} from "@ember/protocol";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { verifyPassword } from "../src/passwords";
import type { Workspace } from "../src/workspace";
import { api, apiWith, builtPages, cookieOf, countAddressesToEmail, createRoom, freshDeploy, origin, shown, signIn, withWorkspaceEnv, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const hal = { name: "Hal", password: "heuristically" };

const FROM = "Ember <ember@example.com>";
/** The keys of a deployment whose members may sign in with Memberful. */
const MEMBERFUL_KEYS = { MEMBERFUL_URL: "https://example.memberful.com/", MEMBERFUL_CLIENT_ID: "ember-client-id", MEMBERFUL_CLIENT_SECRET: "ember-client-secret" };
/** Turnstile's test keys: a site key whose check always passes, and a secret key, which this suite's fake siteverify takes. */
const TURNSTILE_KEYS = { TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" };
/** The token Turnstile's test site keys give the page. */
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const HOUR_MS = 60 * 60 * 1000;

/** Sets Ember up with Ada as its administrator, signed in, answering its first room too. */
async function setUp(): Promise<Session & { general: NewWorkspace["room"] }> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  const { user, room } = (await response.json()) as NewWorkspace;
  return { user: shown(user), cookie: cookieOf(response), general: room };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Changes the workspace as `session`, as its settings save it, on a deployment whose bindings differ from this suite's by `changes`. */
const change = (session: Session | null, body: unknown, changes: Partial<Env> = {}) =>
  apiWith(changes, "/api/account", { method: "PATCH", headers: as(session), body: JSON.stringify(body) });

/** Changes the workspace as `administrator`, which has to work, answering the account as pages show it then. */
async function changed(administrator: Session, body: unknown, changes: Partial<Env> = {}): Promise<Account> {
  const response = await change(administrator, body, changes);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { account: Account }).account;
}

/** Sets Ember up with a From address and Email domain on, letting in `domains`, answering Ada, its administrator. */
async function setUpEmailDomain(domains: string[] = ["example.org"]): Promise<Session & { general: NewWorkspace["room"] }> {
  const administrator = await setUp();
  await changed(administrator, { emailFrom: FROM, emailDomains: domains, settings: { emailDomainSignUp: true } });
  return administrator;
}

const bootstrap = async () => (await (await api("/api/bootstrap")).json()) as Bootstrap;
const settings = async (session: Session) => (await (await api("/api/account", { headers: as(session) })).json()) as WorkspaceSettings;

/** How a test waits for the Workspace to have been told the addresses asked for, or keeps it from taking them (`countAddressesToEmail`). */
let workspace: Awaited<ReturnType<typeof countAddressesToEmail>>;
/** How many asks the test has had answered as asked, of each of which the Worker tells the Workspace the address. */
let answered = 0;

/**
 * Asks for a link to join with `emailAddress`, as `/join/email`'s form does, from a browser at `ip`, to
 * a Worker whose bindings differ from this suite's by `changes`, answering once the Workspace has been
 * told the address, if the ask was answered as asked.
 */
async function ask(
  emailAddress: unknown,
  { ip = "203.0.113.40", session, changes = {}, turnstileToken }: { ip?: string; session?: Session; changes?: Partial<Env>; turnstileToken?: string } = {},
): Promise<Response> {
  const response = await apiWith(changes, "/api/email_links", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip, ...as(session) },
    body: JSON.stringify({ emailAddress, ...(turnstileToken !== undefined && { turnstileToken }) }),
  });
  if (response.status === 202) await workspace.told(++answered);
  return response;
}

/**
 * Stands in for Cloudflare Email Service's binding, keeping what it's asked to send, which it takes once
 * `held` ends, if that's given, and throwing what `refusal` gives, if anything.
 */
function fakeBinding(refusal: () => unknown = () => undefined, held?: Promise<void>) {
  const sent: EmailMessageBuilder[] = [];
  const binding = {
    send: async (message: EmailMessageBuilder) => {
      sent.push(message);
      await held;
      const refused = refusal();
      if (refused !== undefined) throw refused;
      return { messageId: `<${crypto.randomUUID()}@example.com>` };
    },
  } as unknown as SendEmail;
  return { binding, sent };
}

/** The links to join with on their way to each address: how many, and the last of them, which that address's next waits for. */
type EmailsLinks = { emailingLinks: Map<string, { asked: number; last: Promise<unknown> }> };

/** Waits for the links the Workspace is emailing, which it emails once it has answered. */
const emailed = () =>
  runInDurableObject(workspaceStub(), async (instance: Workspace) => {
    await Promise.all(Array.from((instance as unknown as EmailsLinks).emailingLinks.values(), ({ last }) => last));
  });

/** Runs `run` with the Workspace sending email through a fake binding, answering what it was asked to send once it has sent it. */
async function emailing(run: () => Promise<void>, refusal?: () => unknown): Promise<EmailMessageBuilder[]> {
  const { binding, sent } = fakeBinding(refusal);
  await withWorkspaceEnv({ EMAIL: binding }, async () => {
    await run();
    await emailed();
  });
  return sent;
}

/** Asks for a link to join with `emailAddress`, which has to be answered as asked, answering the emails Ember sent. */
async function asked(emailAddress: string, options: Parameters<typeof ask>[1] = {}): Promise<EmailMessageBuilder[]> {
  return emailing(async () => {
    const response = await ask(emailAddress, options);
    expect(response.status, await response.clone().text()).toBe(202);
    expect(await response.json()).toEqual({});
  });
}

/** Asks for a link to join with `emailAddress`, answering the secret of the link Ember emailed. */
async function linkFor(emailAddress: string): Promise<string> {
  const [email] = await asked(emailAddress);
  return tokenIn(linkIn(email!));
}

/** The link in an email. */
const linkIn = (email: EmailMessageBuilder) => /(?:Join|Sign in) here: (\S+)/.exec(email.text ?? "")![1]!;

/** The secret in a link's fragment. */
function tokenIn(link: string): string {
  const hash = new URL(link).hash;
  expect(hash).toMatch(/^#token=[\w-]{43}$/);
  return hash.slice("#token=".length);
}

/** Asks whom the link with the secret `token` is for, as its page does. */
const lookUp = (token: unknown) => api("/api/email_links/lookup", { method: "POST", body: JSON.stringify({ token }) });

/** Posts the link's join form, with its secret `token`, as `person`, to `/api/join/email` unless `path` says otherwise. */
const joinWith = (token: unknown, person: Record<string, unknown> = hal, { path = "/api/join/email", session }: { path?: string; session?: Session } = {}) =>
  api(path, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.41", "User-Agent": "Hal's laptop", ...as(session) }, body: JSON.stringify({ ...person, token }) });

/** The answer to a link that doesn't work. */
async function expectGone(response: Response, error = EMAIL_LINK_GONE): Promise<void> {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error });
}

const count = async (table: string) => ((await workspaceSql(`SELECT count(*) AS n FROM ${table}`)) as Array<{ n: number }>)[0]!.n;

/** A request the fake siteverify was sent. */
interface SentToSiteverify {
  url: string;
  body: unknown;
}

/** Stands in for Turnstile's siteverify, answering `answer` to each check, and keeping what it's sent. */
function fakeSiteverify(answer: () => Response = () => Response.json({ success: true })) {
  const requests: SentToSiteverify[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, body: await request.json() });
    return answer();
  });
  return requests;
}

beforeEach(freshDeploy);
beforeEach(async () => {
  answered = 0;
  workspace = await countAddressesToEmail();
  return workspace.stop;
});
afterEach(() => vi.restoreAllMocks());

describe("Join with an email domain", () => {
  describe("the setting", () => {
    it("is off with no domains until an administrator lists one and turns it on, which takes a From address", async () => {
      expect((await bootstrap()).account).toMatchObject({ emailDomainSignUp: false, emailDomains: [] });
      const administrator = await setUp();
      expect((await settings(administrator)).emailDomains).toEqual([]);

      const refused = await change(administrator, { settings: { emailDomainSignUp: true } });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ error: NO_EMAIL_DOMAINS });

      // Kept as DNS has them, once each, whatever was typed before them, and international ones in ASCII.
      expect(await changed(administrator, { emailDomains: [" @Example.ORG ", "bücher.example", "example.org"] })).toMatchObject({ emailDomainSignUp: false, emailDomains: [] });
      expect((await settings(administrator)).emailDomains).toEqual(["example.org", "xn--bcher-kva.example"]);

      const withoutFrom = await change(administrator, { settings: { emailDomainSignUp: true } });
      expect(withoutFrom.status).toBe(422);
      expect(await withoutFrom.json()).toEqual({ error: EMAIL_DOMAIN_NEEDS_EMAIL });
      expect((await bootstrap()).account.emailDomainSignUp).toBe(false);

      await changed(administrator, { emailFrom: FROM });
      expect(await changed(administrator, { settings: { emailDomainSignUp: true } })).toMatchObject({ emailDomainSignUp: true, emailDomains: ["example.org", "xn--bcher-kva.example"] });
      expect((await bootstrap()).account).toMatchObject({ emailDomainSignUp: true, emailDomains: ["example.org", "xn--bcher-kva.example"] });
    });

    it("keeps at least one domain while it's on, and the domains for administrators while it's off", async () => {
      const administrator = await setUpEmailDomain(["example.org", "example.net"]);
      const emptied = await change(administrator, { emailDomains: [] });
      expect(emptied.status).toBe(422);
      expect(await emptied.json()).toEqual({ error: NO_EMAIL_DOMAINS });
      expect((await bootstrap()).account.emailDomains).toEqual(["example.org", "example.net"]);

      expect(await changed(administrator, { emailDomains: ["example.net"] })).toMatchObject({ emailDomains: ["example.net"] });
      expect(await changed(administrator, { settings: { emailDomainSignUp: false } })).toMatchObject({ emailDomainSignUp: false, emailDomains: [] });
      expect((await bootstrap()).account.emailDomains).toEqual([]);
      const member = await signIn("Grace");
      expect((await settings(administrator)).emailDomains).toEqual(["example.net"]);
      expect((await settings(member)).emailDomains).toEqual([]);
      // Off, it can lose its last domain.
      await changed(administrator, { emailDomains: [] });
      expect((await settings(administrator)).emailDomains).toEqual([]);
    });

    it.each([
      ["a domain that isn't a list", "example.org"],
      ["an email address", ["ann@example.org"]],
      ["an address on the web", ["https://example.org/"]],
      ["an IP address", ["192.0.2.1"]],
      ["a name without a dot", ["localhost"]],
      ["a domain with a port", ["example.org:8080"]],
      ["something that isn't text", [42]],
      ["more domains than it keeps", Array.from({ length: 101 }, (_, n) => `team${n}.example`)],
    ])("refuses %s, changing nothing", async (_, emailDomains) => {
      const administrator = await setUp();
      const response = await change(administrator, { name: "Renamed", emailDomains });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: EMAIL_DOMAINS_REFUSED });
      expect((await bootstrap()).account.name).toBe("Ember");
    });

    it("is for administrators to change", async () => {
      await setUp();
      const member = await signIn("Grace");
      const response = await change(member, { emailDomains: ["example.org"] });
      expect(response.status).toBe(403);
      expect((await change(null, { emailDomains: ["example.org"] })).status).toBe(401);
    });

    it("lets nobody in while Memberful is members only, keeping its switch", async () => {
      const administrator = await setUpEmailDomain();
      await changed(administrator, { settings: { memberfulSignIn: true } }, MEMBERFUL_KEYS);
      const response = await ask("hal@example.org");
      expect(response.status).toBe(403);
      expect((await bootstrap()).account).toMatchObject({ emailDomainSignUp: true, memberfulSignIn: true });
    });
  });

  describe("the page", () => {
    /** The page as the browser asks for it, with the built app standing in, without following a redirect. */
    const page = (init: RequestInit<IncomingRequestCfProperties> = {}, changes: Partial<Env> = {}) =>
      apiWith({ ASSETS: builtPages, ...changes }, "/join/email", { redirect: "manual", ...init });

    it("is the app's, for anyone, whether it's on or not, which no cache keeps, since a redirect would carry a link's secret along", async () => {
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
      await setUpEmailDomain();
      const turnstile = "https://challenges.cloudflare.com";
      expect((await page({}, TURNSTILE_KEYS)).headers.get("Content-Security-Policy")).toContain(`; frame-src ${turnstile};`);
      expect((await page()).headers.get("Content-Security-Policy")).not.toContain(turnstile);
    });
  });

  describe("asking for a link", () => {
    it("emails an address at a listed domain a link that joins with it for an hour, from the From address", async () => {
      await setUpEmailDomain(["example.org"]);
      const sent = await asked("Hal@Example.org");
      expect(sent).toHaveLength(1);
      const [email] = sent;
      const link = linkIn(email!);
      expect(link).toMatch(new RegExp(`^${origin}/join/email#token=[\\w-]{43}$`));
      expect(email).toEqual({
        from: { name: "Ember", email: "ember@example.com" },
        to: "Hal@Example.org",
        subject: "Your link to join Ember",
        text: `Someone asked to join Ember with this email address.\n\nJoin here: ${link}\n\nThe link works once, for an hour, and joins with Hal@Example.org. If you didn't ask for it, you can ignore this email: nobody joins without the link.\n`,
        html: expect.stringContaining(`<a href="${link}">Join Ember</a>`) as unknown,
      });

      // Only the secret's digest is kept, with the address as given.
      const [row] = (await workspaceSql("SELECT kind, email_address, token_digest, invited_by, created_at, expires_at FROM email_links")) as Array<Record<string, string | null>>;
      expect(row).toMatchObject({ kind: "email_domain", email_address: "Hal@Example.org", invited_by: null });
      expect(row!.token_digest).not.toContain(tokenIn(link));
      expect(Date.parse(row!.expires_at!) - Date.parse(row!.created_at!)).toBe(HOUR_MS);
    });

    it("answers the same for an address with an account, whatever its case, emailing it where to sign in instead", async () => {
      await setUpEmailDomain(["example.com"]);
      const [email] = await asked("ADA@example.com");
      expect(email).toMatchObject({ to: "ADA@example.com", subject: "You already have an account at Ember" });
      expect(linkIn(email!)).toBe(`${origin}/session/new?email_address=ADA%40example.com`);
      expect(await count("email_links")).toBe(0);
    });

    it("replaces the link an address was sent before, so only the newest works", async () => {
      await setUpEmailDomain();
      const first = await linkFor("hal@example.org");
      const second = await linkFor("HAL@example.org");
      await expectGone(await lookUp(first));
      expect(await (await lookUp(second)).json()).toEqual({ kind: "email_domain", emailAddress: "HAL@example.org" });
      expect(await count("email_links")).toBe(1);
    });

    it("deletes the links nobody joined with once they stop working, as it saves another, keeping expired invitations", async () => {
      const administrator = await setUpEmailDomain();
      await emailing(async () => {
        const response = await api("/api/invitations", { method: "POST", headers: as(administrator), body: JSON.stringify({ emailAddresses: ["linus@example.com"] }) });
        expect(response.status).toBe(200);
      });
      const expired = await linkFor("hal@example.org");
      await linkFor("ann@example.org");
      const aMomentAgo = new Date(Date.now() - 1000).toISOString();
      await workspaceSql("UPDATE email_links SET expires_at = ? WHERE email_address IN ('hal@example.org', 'linus@example.com')", aMomentAgo);
      await expectGone(await lookUp(expired));

      await linkFor("bob@example.org");
      expect(await workspaceSql("SELECT kind, email_address FROM email_links ORDER BY email_address")).toEqual([
        { kind: "email_domain", email_address: "ann@example.org" },
        { kind: "email_domain", email_address: "bob@example.org" },
        { kind: "invitation", email_address: "linus@example.com" },
      ]);
    });

    it(`emails an address at most ${EMAILS_PER_ADDRESS} times an hour, whoever asks, answering the same once it has, and again after the hour`, async () => {
      await setUpEmailDomain();
      const sent: EmailMessageBuilder[] = [];
      for (let n = 1; n <= EMAILS_PER_ADDRESS + 2; n++) sent.push(...(await asked(n % 2 ? "hal@example.org" : "Hal@Example.org", { ip: `203.0.113.${n}` })));
      expect(sent).toHaveLength(EMAILS_PER_ADDRESS);
      // The last link it sent still works, and the asks past the limit aren't counted, so that an email
      // being sent as they came that the provider then refuses would free a place.
      expect((await lookUp(tokenIn(linkIn(sent.at(-1)!)))).status).toBe(200);
      expect(await workspaceSql("SELECT count FROM email_link_requests")).toEqual([{ count: EMAILS_PER_ADDRESS }]);

      // An hour on, the count starts again, and asking forgets the counts whose hour is over.
      const anHourAgo = new Date(Date.now() - HOUR_MS - 1000).toISOString();
      await workspaceSql("UPDATE email_link_requests SET counted_since = ?", anHourAgo);
      await workspaceSql("INSERT INTO email_link_requests (email_address, counted_since, count) VALUES ('ann@example.org', ?, 2)", anHourAgo);
      expect(await asked("hal@example.org")).toHaveLength(1);
      expect(await workspaceSql("SELECT email_address, count FROM email_link_requests")).toEqual([{ email_address: "hal@example.org", count: 1 }]);
    });

    it("counts no email the provider refuses, which leaves the link it sent before working", async () => {
      await setUpEmailDomain();
      const sent = await linkFor("hal@example.org");
      for (let n = 1; n <= EMAILS_PER_ADDRESS; n++) {
        const refused = await emailing(
          async () => expect((await ask("hal@example.org")).status).toBe(202),
          () => new Error("the provider is down"),
        );
        expect(refused).toHaveLength(1);
      }
      expect(await (await lookUp(sent)).json()).toEqual({ kind: "email_domain", emailAddress: "hal@example.org" });
      expect(await workspaceSql("SELECT count FROM email_link_requests")).toEqual([{ count: 1 }]);

      // Once the provider sends again, the address has the rest of its hour's emails, the newest link replacing the first.
      const more: EmailMessageBuilder[] = [];
      for (let n = 1; n <= EMAILS_PER_ADDRESS; n++) more.push(...(await asked("hal@example.org")));
      expect(more).toHaveLength(EMAILS_PER_ADDRESS - 1);
      await expectGone(await lookUp(sent));
      expect((await lookUp(tokenIn(linkIn(more.at(-1)!)))).status).toBe(200);
    });

    it("gives no link to join with to someone who joins while it's being emailed", async () => {
      await setUpEmailDomain();
      const first = await linkFor("hal@example.org");
      // The provider takes the second email only once Hal has joined with the first link.
      const sent: EmailMessageBuilder[] = [];
      let joined: number | undefined;
      const binding = {
        send: async (message: EmailMessageBuilder) => {
          sent.push(message);
          joined = (await joinWith(first)).status;
          return { messageId: `<${crypto.randomUUID()}@example.com>` };
        },
      } as unknown as SendEmail;
      await withWorkspaceEnv({ EMAIL: binding }, async () => {
        expect((await ask("hal@example.org")).status).toBe(202);
        await emailed();
      });
      expect(joined).toBe(201);
      await expectGone(await lookUp(tokenIn(linkIn(sent[0]!))));
      expect(await count("email_links")).toBe(0);
    });

    it("emails an international domain's address at the ASCII form it's listed in", async () => {
      await setUpEmailDomain(["bücher.example"]);
      const [email] = await asked("Hal@Bücher.example");
      expect(email!.to).toBe("Hal@xn--bcher-kva.example");
    });

    it.each([
      ["an address at a domain it doesn't list", "hal@example.com", onlyAddressesAt(["example.org", "example.net"])],
      ["an address at a domain under a listed one", "hal@mail.example.org", onlyAddressesAt(["example.org", "example.net"])],
      ["what isn't an address", "hal", EMAIL_ADDRESS_NEEDED],
      ["no address", "", EMAIL_ADDRESS_NEEDED],
      ["what isn't text", 42, EMAIL_ADDRESS_NEEDED],
    ])("refuses %s on its field, sending nothing", async (_, emailAddress, error) => {
      await setUpEmailDomain(["example.org", "example.net"]);
      const sent = await emailing(async () => {
        const response = await ask(emailAddress);
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({ error, field: "emailAddress" });
      });
      expect(sent).toEqual([]);
      expect(await count("email_link_requests")).toBe(0);
    });

    it("sends nobody a link while it's off, sending them to sign in, and someone signed in home", async () => {
      const administrator = await setUpEmailDomain();
      const signedIn = await ask("hal@example.org", { session: administrator });
      expect(signedIn.status).toBe(409);
      expect(await signedIn.json()).toEqual({ error: "You're signed in already", redirect: "/" });

      await changed(administrator, { settings: { emailDomainSignUp: false } });
      const response = await ask("hal@example.org");
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: JOINING_PROBLEMS.email_off, redirect: "/session/new?joining=email_off" });
    });

    it("answers before the Workspace is told the address, so how soon it answers says nothing of the address", async () => {
      await setUpEmailDomain();
      // The Workspace takes no address to email until the test lets it.
      let letGo!: () => void;
      workspace.holdUntil(new Promise<void>((resolve) => (letGo = resolve)));
      const { binding, sent } = fakeBinding();
      await withWorkspaceEnv({ EMAIL: binding }, async () => {
        const response = await ask("hal@example.org");
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({});
        expect(sent).toHaveLength(0);
        expect(await count("email_link_requests")).toBe(0);
        expect(await count("email_links")).toBe(0);

        letGo();
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        await emailed();
      });
      expect(await workspaceSql("SELECT email_address, count FROM email_link_requests")).toEqual([{ email_address: "hal@example.org", count: 1 }]);
      expect(await count("email_links")).toBe(1);
    });

    it("says whether a link can be asked for without the address, changing nothing it counts emails or keeps links in, whether or not one is being sent", async () => {
      await setUpEmailDomain();
      await workspaceSql("CREATE TABLE changes_made (id INTEGER PRIMARY KEY)");
      for (const table of ["email_link_requests", "email_links"]) {
        for (const change of ["INSERT", "UPDATE", "DELETE"]) {
          await workspaceSql(`CREATE TRIGGER count_${table}_${change} AFTER ${change} ON ${table} BEGIN INSERT INTO changes_made (id) VALUES (NULL); END`);
        }
      }
      // The provider keeps Hal's email until the test lets it go.
      let letGo!: () => void;
      const { binding, sent } = fakeBinding(undefined, new Promise<void>((resolve) => (letGo = resolve)));
      await withWorkspaceEnv({ EMAIL: binding }, async () => {
        for (const sending of [false, true]) {
          const before = await count("changes_made");
          expect(await workspaceStub().askForEmailLink("203.0.113.40", "example.org", true), `sending: ${sending}`).toBe("asked");
          expect(await count("changes_made"), `sending: ${sending}`).toBe(before);
          if (sending) break;
          expect((await ask("hal@example.org")).status).toBe(202);
          await vi.waitFor(() => expect(sent).toHaveLength(1));
        }
        letGo();
        await emailed();
      });
      expect(await count("email_links")).toBe(1);
    });

    it("emails an address's links in the order they were asked for, without waiting for another address's", async () => {
      await setUpEmailDomain();
      // The provider keeps Ann's first email until the test lets it go.
      let letGo!: () => void;
      const held = new Promise<void>((resolve) => (letGo = resolve));
      const sent: EmailMessageBuilder[] = [];
      const binding = {
        send: async (message: EmailMessageBuilder) => {
          sent.push(message);
          if (message.to === "ann@example.org") await held;
          return { messageId: `<${crypto.randomUUID()}@example.com>` };
        },
      } as unknown as SendEmail;
      await withWorkspaceEnv({ EMAIL: binding }, async () => {
        for (const emailAddress of ["ann@example.org", "ANN@example.org", "hal@example.org"]) expect((await ask(emailAddress)).status).toBe(202);
        // Hal's goes while the provider still has Ann's first, which her second waits for.
        await vi.waitFor(() => expect(sent.map(({ to }) => to)).toEqual(["ann@example.org", "hal@example.org"]));
        letGo();
        await emailed();
      });
      expect(sent.map(({ to }) => to)).toEqual(["ann@example.org", "hal@example.org", "ANN@example.org"]);
      // The link Ann asked for last is the one that works.
      await expectGone(await lookUp(tokenIn(linkIn(sent[0]!))));
      expect(await (await lookUp(tokenIn(linkIn(sent[2]!)))).json()).toEqual({ kind: "email_domain", emailAddress: "ANN@example.org" });
      expect(await runInDurableObject(workspaceStub(), (instance: Workspace) => (instance as unknown as EmailsLinks).emailingLinks.size)).toBe(0);
    });

    it("has no more on their way to an address at once than it's emailed in an hour, however many are asked for", async () => {
      await setUpEmailDomain();
      // The provider keeps each email until the test lets them go, then refuses it, so none counts towards the hour's.
      let letGo!: () => void;
      const { binding, sent } = fakeBinding(() => new Error("the provider is down"), new Promise<void>((resolve) => (letGo = resolve)));
      await withWorkspaceEnv({ EMAIL: binding }, async () => {
        for (let n = 1; n <= EMAILS_PER_ADDRESS + 2; n++) expect((await ask(n % 2 ? "hal@example.org" : "HAL@example.org")).status).toBe(202);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(await runInDurableObject(workspaceStub(), (instance: Workspace) => (instance as unknown as EmailsLinks).emailingLinks.get("hal@example.org")?.asked)).toBe(EMAILS_PER_ADDRESS);
        // Another address's is on its way all the same.
        expect((await ask("ann@example.org")).status).toBe(202);
        await vi.waitFor(() => expect(sent.map(({ to }) => to)).toEqual(["hal@example.org", "ann@example.org"]));
        letGo();
        await emailed();
      });
      expect(sent.filter(({ to }) => to !== "ann@example.org")).toHaveLength(EMAILS_PER_ADDRESS);
      expect(await count("email_links")).toBe(0);
      // With those gone, the address can be asked for again.
      expect(await asked("hal@example.org")).toHaveLength(1);
    });

    it("says so when Ember can't send email, and answers as asked when the provider doesn't send it, which is only logged", async () => {
      const administrator = await setUpEmailDomain();
      const refused = await emailing(
        async () => {
          const response = await ask("hal@example.org");
          expect(response.status).toBe(202);
          expect(await response.json()).toEqual({});
        },
        () => new Error("destination address is not a verified address"),
      );
      expect(refused).toHaveLength(1);
      expect(await count("email_links")).toBe(0);

      await changed(administrator, { emailFrom: null });
      const response = await ask("hal@example.org");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: CANT_EMAIL_LINKS });
    });

    it(`lets a network ask for ${EMAIL_LINKS_PER_NETWORK} links an hour until the deployment has Turnstile's keys, then asks Turnstile instead`, async () => {
      await setUpEmailDomain();
      for (let n = 1; n <= EMAIL_LINKS_PER_NETWORK; n++) await asked(`person${n}@example.org`, { ip: "203.0.113.50" });
      const limited = await ask("one.more@example.org", { ip: "203.0.113.50" });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: EMAIL_LINKS_LIMITED });
      await asked("one.more@example.org", { ip: "203.0.113.51" });
      // An IPv6 network is a /64, whichever of its addresses asks.
      for (let n = 1; n <= EMAIL_LINKS_PER_NETWORK; n++) await asked(`someone${n}@example.org`, { ip: `2001:db8:1:2::${n.toString(16)}` });
      expect((await ask("someone.more@example.org", { ip: "2001:db8:1:2:ffff::1" })).status).toBe(429);
      await asked("someone.more@example.org", { ip: "2001:db8:1:3::1" });

      const checks = fakeSiteverify();
      const unchecked = await ask("another@example.org", { ip: "203.0.113.50", changes: TURNSTILE_KEYS });
      expect(unchecked.status).toBe(422);
      expect(await unchecked.json()).toEqual({ error: TURNSTILE_FAILED, field: "turnstile" });
      await asked("another@example.org", { ip: "203.0.113.50", changes: TURNSTILE_KEYS, turnstileToken: TOKEN });
      expect(checks).toEqual([{ url: "https://challenges.cloudflare.com/turnstile/v0/siteverify", body: { secret: TURNSTILE_KEYS.TURNSTILE_SECRET_KEY, response: TOKEN, remoteip: "203.0.113.50" } }]);
    });
  });

  describe("looking up and joining with a link", () => {
    it("says whom it's for, as often as it's asked, then adds a member with that address, in every open room, signed in, spending the link", async () => {
      const administrator = await setUpEmailDomain();
      const design = await createRoom("Design", { as: administrator });
      const token = await linkFor("Hal@Example.org");
      for (let n = 0; n < 3; n++) {
        const response = await lookUp(token);
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.json()).toEqual({ kind: "email_domain", emailAddress: "Hal@Example.org" });
      }

      const response = await joinWith(token, { ...hal, emailAddress: "someone@else.example" });
      expect(response.status).toBe(201);
      const { user } = (await response.json()) as { user: Me };
      expect(user).toEqual({ id: expect.any(String), name: "Hal", administrator: false });
      const [member] = (await workspaceSql("SELECT email_address, password_digest, invited_by, role FROM users WHERE id = ?", user.id)) as Array<Record<string, unknown>>;
      expect(member).toMatchObject({ email_address: "Hal@Example.org", invited_by: null, role: 0 });
      expect(await verifyPassword(hal.password, member!.password_digest as string)).toBe(true);
      const { rooms } = (await (await api("/api/sidebar", { headers: { Cookie: cookieOf(response) } })).json()) as Sidebar;
      expect(rooms.map((room) => room.id)).toEqual(expect.arrayContaining([administrator.general.id, design.id]));

      await expectGone(await lookUp(token));
      await expectGone(await joinWith(token, { name: "Someone else", password: "another password" }));
      expect(await count("users")).toBe(2);
    });

    it("joins only while Email domain lets the address's domain in, and before the link expires", async () => {
      const administrator = await setUpEmailDomain(["example.org", "example.net"]);
      const token = await linkFor("hal@example.org");
      await changed(administrator, { settings: { emailDomainSignUp: false } });
      await expectGone(await lookUp(token));
      await expectGone(await joinWith(token));
      await changed(administrator, { settings: { emailDomainSignUp: true } });
      expect((await lookUp(token)).status).toBe(200);

      await changed(administrator, { emailDomains: ["example.net"] });
      await expectGone(await lookUp(token));
      await expectGone(await joinWith(token));
      await changed(administrator, { emailDomains: ["example.net", "example.org"] });
      expect((await lookUp(token)).status).toBe(200);

      await workspaceSql("UPDATE email_links SET expires_at = ?", new Date(Date.now() - 1000).toISOString());
      await expectGone(await lookUp(token));
      await expectGone(await joinWith(token));
      expect(await count("users")).toBe(1);
    });

    it("joins only with its own kind of link, saying each kind's gone", async () => {
      const administrator = await setUpEmailDomain();
      const token = await linkFor("hal@example.org");
      await expectGone(await joinWith(token, hal, { path: "/api/join/invitation" }), INVITATION_GONE);

      const [invitation] = await emailing(async () => {
        const response = await api("/api/invitations", { method: "POST", headers: as(administrator), body: JSON.stringify({ emailAddresses: ["linus@example.com"] }) });
        expect(((await response.json()) as Invited).outcomes).toMatchObject([{ link: null }]);
      });
      await expectGone(await joinWith(tokenIn(linkIn(invitation!))));
      expect(await count("users")).toBe(1);
    });

    it("adds one person when the same link joins twice at once", async () => {
      await setUpEmailDomain();
      const token = await linkFor("hal@example.org");
      const answers = await Promise.all([joinWith(token), joinWith(token, { name: "Hal 2", password: "heuristically" })]);
      expect(answers.map((response) => response.status).sort()).toEqual([201, 404]);
      expect(await count("users")).toBe(2);
    });

    it("sends someone whose address has an account since to sign in with it, keeping the link, and someone signed in home", async () => {
      const administrator = await setUpEmailDomain();
      const token = await linkFor("hal@example.org");
      const signedIn = await joinWith(token, hal, { session: administrator });
      expect(signedIn.status).toBe(409);
      expect(await signedIn.json()).toEqual({ error: "You're signed in already", redirect: "/" });

      await workspaceSql("UPDATE users SET email_address = 'HAL@example.org' WHERE id = ?", administrator.user.id);
      const taken = await joinWith(token);
      expect(taken.status).toBe(409);
      expect(await taken.json()).toEqual({ error: "That email address has an account already", redirect: "/session/new?email_address=hal%40example.org" });
      expect((await lookUp(token)).status).toBe(200);
    });

    it("takes the address's link away when it joins another way", async () => {
      await setUpEmailDomain();
      await linkFor("grace@example.org");
      const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
      const joined = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify({ name: "Grace Hopper", emailAddress: "Grace@Example.org", password: "compiler" }) });
      expect(joined.status).toBe(201);
      expect(await count("email_links")).toBe(0);
    });
  });
});
