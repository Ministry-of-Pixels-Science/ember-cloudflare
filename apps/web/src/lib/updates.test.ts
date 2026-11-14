import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION_PATH, assetsInHtml, assetsInPage, deployedAssets, isUpdated } from "./updates";

/** A page as Vite builds it: the appearance script, the app's script, its runtime and its stylesheet. */
const BUILT_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <link rel="manifest" href="/webmanifest.json" />
    <link rel="icon" type="image/png" sizes="48x48" href="/logos/app-icon-48.png" />
    <script>
      (function () { document.documentElement.classList.toggle("dark", false); })();
    </script>
    <script type="module" crossorigin src="/assets/index-BVs-iubR.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/rolldown-runtime-hePW80VL.js">
    <link rel="stylesheet" crossorigin href="/assets/index-jmMX1D1c.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

const SCRIPT = "/assets/index-BVs-iubR.js";
const STYLESHEET = "/assets/index-jmMX1D1c.css";

afterEach(() => {
  document.head.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("assetsInHtml", () => {
  it("names the app's script and stylesheets that a built page loads, sorted, and nothing else", () => {
    expect(assetsInHtml(BUILT_PAGE)).toEqual([SCRIPT, STYLESHEET]);
  });

  it("names none in the page Vite's dev server serves, which loads the app's source", () => {
    expect(assetsInHtml('<script type="module" src="/@vite/client"></script><script type="module" src="/src/main.tsx"></script>')).toEqual([]);
  });
});

describe("assetsInPage", () => {
  it("names what the page's HTML loads, as app-version.json does", () => {
    document.head.innerHTML = new DOMParser().parseFromString(BUILT_PAGE, "text/html").head.innerHTML;
    expect(assetsInPage().sort()).toEqual(assetsInHtml(BUILT_PAGE));
  });

  it("names the stylesheets of the parts of the app loaded since, which Vite adds", () => {
    document.head.innerHTML = new DOMParser().parseFromString(BUILT_PAGE, "text/html").head.innerHTML;
    const added = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/assets/pages-C1aX9.css" });
    document.head.append(added);
    expect(assetsInPage()).toContain("/assets/pages-C1aX9.css");
  });
});

describe("isUpdated", () => {
  it("is false while the page deployed loads only what this one has", () => {
    expect(isUpdated([SCRIPT, STYLESHEET], [STYLESHEET, SCRIPT])).toBe(false);
    // Whatever else this page has loaded since.
    expect(isUpdated([SCRIPT, STYLESHEET, "/assets/pages-C1aX9.css"], [STYLESHEET, SCRIPT])).toBe(false);
  });

  it("is true once the page deployed loads a file this one never did, as a build with any change names its files anew", () => {
    expect(isUpdated([SCRIPT, STYLESHEET], [STYLESHEET, "/assets/index-Dk2o9XyZ.js"])).toBe(true);
    // A change to the styles alone.
    expect(isUpdated([SCRIPT, STYLESHEET], ["/assets/index-a0Zq3Wbn.css", SCRIPT])).toBe(true);
  });

  it("is false on a page from Vite's dev server, which can't tell", () => {
    expect(isUpdated([], [STYLESHEET, SCRIPT])).toBe(false);
  });
});

describe("deployedAssets", () => {
  /** Has app-version.json answer with `status` and `body`. */
  const serve = (status: number, body: string) => {
    const fetch = vi.fn(async () => new Response(body, { status, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  it("reads what the page deployed now loads, asking afresh", async () => {
    const fetch = serve(200, JSON.stringify({ assets: [STYLESHEET, SCRIPT] }));
    expect(await deployedAssets()).toEqual([STYLESHEET, SCRIPT]);
    expect(fetch).toHaveBeenCalledWith(APP_VERSION_PATH, { cache: "no-cache" });
  });

  it("can't say where there's no such file, as under Vite's dev server, or it says nothing it can read", async () => {
    for (const [status, body] of [
      [404, "Not found"],
      [200, "<!doctype html>"],
      [200, "null"],
      [200, JSON.stringify({ assets: [] })],
      [200, JSON.stringify({ assets: [7] })],
      [200, JSON.stringify({})],
    ] as const) {
      serve(status, body);
      expect(await deployedAssets(), body).toBeNull();
    }
  });

  it("can't say while it's offline", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await deployedAssets()).toBeNull();
  });
});
