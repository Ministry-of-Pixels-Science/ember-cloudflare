import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { inlineScriptHashes } from "../src/csp";
import type { Env } from "../src/env";
import { withHeaders } from "../src/headers";
import { api, apiWith, builtPages, cookieOf, freshRoom, origin, signIn, upgrade } from "./support";

// User agents from fixtures/user-agents.json, with whether Campfire blocks them.
/** Chrome 119, one version too old. */
const OLD_CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.199 Safari/537.36";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const INTERNET_EXPLORER = "Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko";
/** Apple Messages fetching a link's preview, which says it's Safari 9 and blocked. */
const APPLE_MESSAGES =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0";
/** Chrome 100 as Googlebot, which gets through as a bot. */
const GOOGLEBOT =
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.6099.216 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

type Init = RequestInit<IncomingRequestCfProperties>;

/** `init` from a browser that says it's `userAgent`. */
const as = (userAgent: string, init: { headers?: Record<string, string> } = {}): Init => ({ ...init, headers: { ...init.headers, "User-Agent": userAgent } });
/** The app's own page, as the built app serves it, for `path`. */
const page = (path: string, init: Init = {}) => apiWith({ ASSETS: builtPages }, path, init);
/** Over plain HTTP, to a host that isn't this machine. */
const overHttp = (path: string, init: RequestInit = {}) => exports.default.fetch(`http://ember.test${path}`, { redirect: "manual", ...init });

const RAILS_DEFAULTS = {
  "x-frame-options": "SAMEORIGIN",
  "x-xss-protection": "0",
  "x-content-type-options": "nosniff",
  "x-permitted-cross-domain-policies": "none",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function expectRailsDefaults(response: Response) {
  for (const [name, value] of Object.entries(RAILS_DEFAULTS)) expect(response.headers.get(name), name).toBe(value);
}

/** Where Cloudflare Web Analytics' beacon comes from, each version at its own address under this one. */
const WEB_ANALYTICS_BEACON = "https://static.cloudflareinsights.com/beacon.min.js/";

/** The policy every answer carries, for this suite's host, without a page's own scripts. */
const POLICY =
  `default-src 'self'; script-src 'self' ${WEB_ANALYTICS_BEACON}; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' blob:; connect-src 'self' wss://ember.test; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; report-uri /csp-report`;

/** `text`'s SHA-256 in base64, as a policy names a script. */
const sha256 = async (text: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))));
/** The upgrade page's inline scripts, as the page is drawn, which its policy must name, in order. */
const upgradePageScripts = async () => {
  const response = await page("/", as(OLD_CHROME));
  const hashes = await inlineScriptHashes(await response.text());
  expect(response.headers.get("Content-Security-Policy")).toContain(`script-src 'self' ${WEB_ANALYTICS_BEACON} ${hashes.map((hash) => `'sha256-${hash}'`).join(" ")};`);
  return hashes;
};

describe("Health check", () => {
  it("answers /up with Rails' green page", async () => {
    const response = await api("/up");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<!DOCTYPE html><html><body style="background-color: green"></body></html>');
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.has("Vary")).toBe(false);
  });

  it("answers /up.json, or /up asked for JSON, with the time to the second", async () => {
    for (const response of [await api("/up.json"), await api("/up", { headers: { Accept: "application/json" } })]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      const body = (await response.json()) as { status: string; timestamp: string };
      expect(Object.keys(body)).toEqual(["status", "timestamp"]);
      expect(body.status).toBe("up");
      expect(body.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(Math.abs(Date.parse(body.timestamp) - Date.now())).toBeLessThan(5_000);
    }
  });

  it("picks its format from Accept as Rails does, saying so with Vary", async () => {
    const formatFor = async (accept: string) => {
      const response = await api("/up", { headers: { Accept: accept } });
      return [response.status, response.headers.get("Content-Type"), response.headers.get("Vary")];
    };
    const html = [200, "text/html; charset=utf-8", "Accept"];
    const json = [200, "application/json; charset=utf-8", "Accept"];
    expect(await formatFor("text/html")).toEqual(html);
    expect(await formatFor("*/*")).toEqual(html);
    expect(await formatFor("application/json, text/html")).toEqual(json);
    expect(await formatFor("text/html;q=0.5, application/json")).toEqual(json);
    // A browser lists every type, and Rails reads that as HTML whatever comes first.
    expect(await formatFor("application/json,text/html;q=0.9,*/*;q=0.8")).toEqual([200, "text/html; charset=utf-8", null]);
    expect((await formatFor("text/plain"))[0]).toBe(406);
  });

  it("answers 406 for any other format", async () => {
    expect((await api("/up.xml")).status).toBe(406);
    expect((await api("/up.txt")).status).toBe(406);
    expect((await api("/up.html")).status).toBe(200);
  });

  it("isn't checked for old browsers, and carries Rails' headers but no version", async () => {
    const response = await apiWith({ GIT_REVISION: "abc123" }, "/up", as(OLD_CHROME));
    expect(await response.text()).toContain("background-color: green");
    expectRailsDefaults(response);
    expect(response.headers.has("X-Version")).toBe(false);
    expect(response.headers.has("X-Rev")).toBe(false);
  });
});

describe("Security headers and HTTPS", () => {
  it("adds Rails' default headers to the API's answers, its errors and redirects included", async () => {
    expectRailsDefaults(await api("/api/bootstrap"));
    expectRailsDefaults(await api("/api/me"));
    expectRailsDefaults(await api("/api/nope"));
    const { cookie } = await signIn("Ada");
    const redirect = await api("/join/AAAA-BBBB-CCCC", { headers: { Cookie: cookie }, redirect: "manual" });
    expect(redirect.status).toBe(302);
    expectRailsDefaults(redirect);
  });

  it("adds them to the app's page, which comes through the Worker", async () => {
    for (const path of ["/", "/rooms/general", "/session/new"]) {
      const response = await page(path);
      expect(await response.text()).toBe("page /");
      expectRailsDefaults(response);
    }
  });

  it("leaves a header an answer sets itself", () => {
    const answer = new Response(null, { headers: { "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" } });
    const sent = withHeaders(answer, new Request("https://ember.test/"), env as unknown as Env, { version: false });
    expect(sent.headers.get("X-Frame-Options")).toBe("DENY");
    expect(sent.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(sent.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets a Content-Security-Policy on every answer but a file's, opening sockets to this host alone and running Cloudflare Web Analytics' beacon", async () => {
    for (const response of [await api("/api/bootstrap"), await api("/api/nope"), await api("/up"), await page("/rooms/general")]) {
      expect(response.headers.get("Content-Security-Policy")).toBe(POLICY);
    }
    // Over plain HTTP, as `wrangler dev` serves it, sockets and previews' images are plain too.
    const local = await exports.default.fetch("http://localhost:8787/api/bootstrap");
    expect(local.headers.get("Content-Security-Policy")).toBe(POLICY.replace("https: data:", "https: http: data:").replace("wss://ember.test", "ws://localhost:8787"));
    // A room's files go without one: nothing served from there can run script, and Chrome's PDF viewer is particular about a policy.
    const file = await api(`/files/${"a".repeat(28)}/signature/picture.png`);
    expect([403, 404]).toContain(file.status);
    expect(file.headers.has("Content-Security-Policy")).toBe(false);
    expectRailsDefaults(file);
  });

  it("names the app page's inline script to its policy by hash, reading the built page once per build", async () => {
    const script = "\n      document.documentElement.classList.add('dark');\n    ";
    const html = `<!doctype html><html><head><script>${script}</script></head><body><script type="module" crossorigin src="/assets/index-abc123.js"></script></body></html>`;
    let served = 0;
    const assets = { fetch: async () => (served++, new Response(html, { headers: { "Content-Type": "text/html", ETag: '"built-1"' } })) } as unknown as Fetcher;
    const named = POLICY.replace(`${WEB_ANALYTICS_BEACON};`, `${WEB_ANALYTICS_BEACON} 'sha256-${await sha256(script)}';`);
    for (const path of ["/", "/rooms/general", "/session/new"]) {
      expect((await apiWith({ ASSETS: assets }, path)).headers.get("Content-Security-Policy"), path).toBe(named);
    }
    // Three pages, and the page read once more for its hashes.
    expect(served).toBe(4);
  });

  it("hashes each inline script's own code, as the policy names it, and none with a src", async () => {
    const html = `<script>alert(1)</script><script type="module" src="/a.js"></script><script type="text/javascript">\n x\n</script>`;
    expect(await inlineScriptHashes(html)).toEqual(["bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI=", await sha256("\n x\n")]);
  });

  it("names the upgrade page's own script to its policy: before Ember is set up, the appearance script alone", async () => {
    expect(await upgradePageScripts()).toHaveLength(1);
  });

  it("forgets a read of the app's page that failed, so the next page reads it again, and names no script meanwhile", async () => {
    const html = `<!doctype html><html><head><script>theme()</script></head><body></body></html>`;
    let calls = 0;
    const assets = {
      fetch: async () => {
        // The first page's own read answers, and its read for the hashes doesn't.
        if (++calls === 2) throw new Error("Assets are away");
        return new Response(html, { headers: { "Content-Type": "text/html", ETag: '"built-2"' } });
      },
    } as unknown as Fetcher;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await apiWith({ ASSETS: assets }, "/rooms/general");
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Security-Policy")).toBe(POLICY);
    expect(logged).toHaveBeenCalledWith("Couldn't read the app's page for its scripts' hashes", expect.any(Error));
    logged.mockRestore();
    const second = await apiWith({ ASSETS: assets }, "/rooms/general");
    expect(second.headers.get("Content-Security-Policy")).toBe(POLICY.replace(`${WEB_ANALYTICS_BEACON};`, `${WEB_ANALYTICS_BEACON} 'sha256-${await sha256("theme()")}';`));
    expect(calls).toBe(4);
  });

  it("logs what a browser reports the policy blocked, from any browser, and answers 204", async () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const violation = {
      "document-uri": "https://ember.test/rooms/general",
      "effective-directive": "img-src",
      "violated-directive": "img-src",
      "blocked-uri": "http://tracker.test/pixel.gif",
      "source-file": "https://ember.test/assets/index-abc123.js",
      "line-number": 12,
      "column-number": 3,
      "original-policy": POLICY,
    };
    // A browser sends it without the page's cookies or origin, and an old browser's page has a policy too.
    const init = { method: "POST", headers: { "Content-Type": "application/csp-report", "User-Agent": OLD_CHROME }, body: JSON.stringify({ "csp-report": violation }) };
    const response = await exports.default.fetch(`${origin}/csp-report`, init);
    expect(response.status).toBe(204);
    expect(logged).toHaveBeenCalledWith("Content-Security-Policy violation", {
      page: "https://ember.test/rooms/general",
      directive: "img-src",
      blocked: "http://tracker.test/pixel.gif",
      source: "https://ember.test/assets/index-abc123.js",
      line: 12,
      column: 3,
    });
    logged.mockRestore();
  });

  it("answers 400 to a report that isn't one, 413 to one over 8 KiB, and 404 to anything but a POST", async () => {
    expect((await api("/csp-report", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await api("/csp-report", { method: "POST", body: JSON.stringify({ hello: 1 }) })).status).toBe(400);
    expect((await api("/csp-report", { method: "POST", body: JSON.stringify({ "csp-report": { "blocked-uri": "x".repeat(9_000) } }) })).status).toBe(413);
    // Bytes, not characters, and a body sent without its length is read only as far as the limit.
    expect((await api("/csp-report", { method: "POST", body: JSON.stringify({ "csp-report": { "blocked-uri": "é".repeat(4_500) } }) })).status).toBe(413);
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1024;
        controller.enqueue(new Uint8Array(1024).fill(0x78));
      },
    });
    expect((await api("/csp-report", { method: "POST", body: endless })).status).toBe(413);
    expect(sent).toBeLessThan(16 * 1024);
    for (const method of ["GET", "PUT", "DELETE"]) expect((await api("/csp-report", { method })).status, method).toBe(404);
  });

  it("pins HTTPS with HSTS on every answer, for this host alone", async () => {
    // The includes subdomains, which on a custom domain at a domain's apex would hold every other site
    // under it to HTTPS.
    for (const response of [await api("/api/bootstrap"), await page("/"), await api("/up")]) {
      expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=63072000");
    }
  });

  it("sends plain HTTP to the same address over HTTPS, without its port", async () => {
    const response = await exports.default.fetch("http://ember.test:8080/rooms/general?x=1&y=%3C", { redirect: "manual" });
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("https://ember.test/rooms/general?x=1&y=%3C");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe('<a href="https://ember.test/rooms/general?x=1&amp;y=%3C">Moved Permanently</a>.\n\n');
    expect(response.headers.has("Strict-Transport-Security")).toBe(false);

    const head = await overHttp("/", { method: "HEAD" });
    expect([head.status, head.headers.get("Content-Type")]).toEqual([301, "text/html; charset=utf-8"]);
    // Whatever the method.
    const post = await overHttp("/api/session", { method: "POST", body: "{}" });
    expect([post.status, post.headers.get("Location"), post.headers.has("Content-Type")]).toEqual([301, "https://ember.test/api/session", false]);
    expect(await post.text()).toBe("");
  });

  it("lets plain HTTP through without HSTS on this machine, or when DISABLE_SSL is set", async () => {
    for (const host of ["localhost:8787", "127.0.0.1:8788", "[::1]", "ember.localhost"]) {
      const response = await exports.default.fetch(`http://${host}/api/bootstrap`);
      expect(response.status, host).toBe(200);
      expect(response.headers.has("Strict-Transport-Security"), host).toBe(false);
    }
    // HTTPS on this machine, as `wrangler dev --local-protocol https` serves it, carries none either.
    expect((await exports.default.fetch("https://localhost:8787/api/bootstrap")).headers.has("Strict-Transport-Security")).toBe(false);

    const disabled = await apiWith({ DISABLE_SSL: "true" }, "http://ember.test/api/bootstrap");
    expect(disabled.status).toBe(200);
    expectRailsDefaults(disabled);
    expect((await apiWith({ DISABLE_SSL: "false" }, "/api/bootstrap")).headers.has("Strict-Transport-Security")).toBe(false);
    // A blank value counts as unset.
    expect((await apiWith({ DISABLE_SSL: " " }, "http://ember.test/api/bootstrap", { redirect: "manual" })).status).toBe(301);
  });

  it("leaves a room's socket upgrade as it is", async () => {
    const room = await freshRoom("lobby");
    const { cookie } = await signIn("Ada");
    const response = await api(`/api/rooms/${room}/socket`, upgrade(cookie));
    expect(response.status).toBe(101);
    expect(response.headers.has("X-Frame-Options")).toBe(false);
    expect(response.headers.has("Content-Security-Policy")).toBe(false);
    expect(response.headers.has("X-Version")).toBe(false);
    response.webSocket!.accept();
    response.webSocket!.close();
  });
});

describe("Version", () => {
  it("names the version on pages and the API's answers", async () => {
    expect((await api("/api/bootstrap")).headers.get("X-Version")).toBe("0.5 beta 3");
    expect((await page("/")).headers.get("X-Version")).toBe("0.5 beta 3");
    expect((await api("/api/nope")).headers.get("X-Version")).toBe("0.5 beta 3");
    const configured = await apiWith({ APP_VERSION: "1.2.3", GIT_REVISION: "abc123" }, "/api/me");
    expect([configured.headers.get("X-Version"), configured.headers.get("X-Rev")]).toEqual(["1.2.3", "abc123"]);
  });

  it("sends X-Rev only when GIT_REVISION is set, blank or not", async () => {
    expect((await api("/api/bootstrap")).headers.has("X-Rev")).toBe(false);
    const blank = await apiWith({ GIT_REVISION: "" }, "/api/bootstrap");
    expect([blank.headers.get("X-Version"), blank.headers.get("X-Rev")]).toEqual(["0.5 beta 3", ""]);
    expect((await apiWith({ GIT_REVISION: "abc123" }, "/api/bootstrap")).headers.get("X-Version")).toBe("abc123");
  });
});

describe("Supported browsers", () => {
  it("answers an old browser with the upgrade page, status 200, whatever it asked for", async () => {
    for (const path of ["/", "/rooms/general", "/session/new", "/join/AAAA-BBBB-CCCC", "/first_run", "/api/bootstrap", "/webmanifest.json", "/qr_code/aHR0cHM6Ly9lbWJlci50ZXN0"]) {
      const response = await page(path, as(OLD_CHROME, { headers: { Accept: "application/json" } }));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("Content-Type"), path).toBe("text/html; charset=utf-8");
      const html = await response.text();
      expect(html, path).toContain("<title>Unsupported browser</title>");
      expect(html, path).toContain("<h1>Upgrade to a supported web browser</h1>");
      expectRailsDefaults(response);
      expect(response.headers.get("X-Version")).toBe("0.5 beta 3");
    }
  });

  it("lists the browsers Ember supports, with Campfire's icons", async () => {
    const html = await (await page("/", as(INTERNET_EXPLORER))).text();
    expect(html).toContain("Ember requires a modern web browser. Please use one of the browsers listed below and make sure auto-updates are enabled.");
    const listed = [...html.matchAll(/<img src="(\/browsers\/\w+\.svg)" alt="" aria-hidden="true"><div><strong>(\w+)<\/strong><span> ([\d.]+\+)<\/span>/g)].map((match) => match.slice(1));
    expect(listed).toEqual([
      ["/browsers/safari.svg", "Safari", "17.2+"],
      ["/browsers/chrome.svg", "Chrome", "120+"],
      ["/browsers/firefox.svg", "Firefox", "121+"],
      ["/browsers/opera.svg", "Opera", "104+"],
    ]);
  });

  it('titles the page "Ember" for Apple Messages\' link previews', async () => {
    const html = await (await page("/join/AAAA-BBBB-CCCC", as(APPLE_MESSAGES))).text();
    expect(html).toContain("<title>Ember</title>");
    expect(html).toContain("Upgrade to a supported web browser");
  });

  it("lets current browsers, bots and requests without a user agent through", async () => {
    for (const userAgent of [CHROME, GOOGLEBOT, ""]) {
      expect(await (await page("/", as(userAgent))).text(), userAgent).toBe("page /");
    }
    expect(await (await page("/")).text()).toBe("page /");
  });

  it("never checks /api/health or a room's live connection", async () => {
    expect(await (await api("/api/health", as(OLD_CHROME))).json()).toMatchObject({ ok: true });
    const room = await freshRoom("lobby");
    const { cookie } = await signIn("Ada");
    const socket = await api(`/api/rooms/${room}/socket`, as(OLD_CHROME, upgrade(cookie)));
    expect(socket.status).toBe(101);
    socket.webSocket!.accept();
    socket.webSocket!.close();
  });
});

describe("Translation buttons", () => {
  const upgradePage = async () => (await page("/", as(OLD_CHROME))).text();
  /** The flags and translations the upgrade page's globe lists. */
  const listedIn = (html: string) => [...html.matchAll(/<dt>(.+?)<\/dt><dd>(.+?)<\/dd>/g)].map((match) => match.slice(1));

  it("puts a globe by the upgrade page's message once an administrator shows them", async () => {
    expect(await upgradePage()).not.toContain("Translate");
    const setUp = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
    const show = (shown: boolean) =>
      api("/api/account", { method: "PATCH", headers: { Cookie: cookieOf(setUp) }, body: JSON.stringify({ settings: { hideTranslationButtons: !shown } }) });
    expect(await upgradePage()).not.toContain("Translate");

    expect((await show(true)).status).toBe(200);
    const html = await upgradePage();
    expect(html).toContain('<summary tabindex="-1"><img src="/globe.svg" alt="" aria-hidden="true"><span class="for-screen-reader">Translate</span></summary>');
    // The globe brings a script of its own, which the policy names beside the appearance one.
    expect(await upgradePageScripts()).toHaveLength(2);
    const listed = listedIn(html);
    expect(listed.map(([flag]) => flag)).toEqual(["🇺🇸", "🇪🇸", "🇫🇷", "🇮🇳", "🇩🇪", "🇧🇷", "🇯🇵"]);
    expect(listed[0]![1]).toBe("Upgrade to a supported web browser. Ember requires a modern web browser. Please use one of the browsers listed below and make sure auto-updates are enabled.");
    // Escaped.
    expect(listed[2]![1]).toContain("Veuillez utiliser l&#39;un des navigateurs");

    await show(false);
    expect(await upgradePage()).not.toContain("Translate");
  });
});
