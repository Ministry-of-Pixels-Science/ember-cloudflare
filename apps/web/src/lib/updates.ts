// An open tab runs the Ember it loaded for as long as it stays open, however Ember is updated meanwhile.
// So the build names the scripts and stylesheets its page loads in app-version.json (vite.config.ts), a
// static file the Worker leaves to Cloudflare to serve, and a page asks for it to tell whether Ember has
// been updated since it loaded (useUpdated).

/** Where the built app names the scripts and stylesheets its page loads. */
export const APP_VERSION_PATH = "/app-version.json";

/** What app-version.json says. */
export interface AppVersion {
  /** The scripts and stylesheets the built page loads, by path, sorted. */
  assets: string[];
}

/** Whether `path` is one of the built app's files, which the build names for what's in them. */
const isBuilt = (path: string | null): path is string => path?.startsWith("/assets/") === true;

/** The tags named `name` in `html`, each from its "<" to its ">". */
const tagsIn = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];

/** The value of `tag`'s attribute `name`, or null where it has none. */
const attributeOf = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1] ?? null;

/** The built app's scripts and stylesheets that a page's HTML loads, sorted, as app-version.json names them. */
export function assetsInHtml(html: string): string[] {
  const scripts = tagsIn(html, "script").filter((tag) => attributeOf(tag, "type") === "module");
  const stylesheets = tagsIn(html, "link").filter((tag) => attributeOf(tag, "rel") === "stylesheet");
  return [...scripts.map((tag) => attributeOf(tag, "src")), ...stylesheets.map((tag) => attributeOf(tag, "href"))].filter(isBuilt).sort();
}

/**
 * The built app's scripts and stylesheets this page has loaded: its HTML's, and the stylesheets of the
 * parts of the app it has loaded since, which Vite adds as it loads them. None under Vite's dev server,
 * which serves the app's source.
 */
export function assetsInPage(): string[] {
  const elements = document.querySelectorAll('script[type="module"][src], link[rel="stylesheet"][href]');
  return [...elements].map((element) => element.getAttribute("src") ?? element.getAttribute("href")).filter(isBuilt);
}

/**
 * Whether a page that has loaded `page` is from before the app deployed now, whose page loads
 * `deployed`: whether that loads a file this one never did, as a build names its files for what's in
 * them. A page from Vite's dev server, which loaded none, can't tell.
 */
export function isUpdated(page: string[], deployed: string[]): boolean {
  return page.length > 0 && deployed.some((path) => !page.includes(path));
}

/** The scripts and stylesheets the page deployed now loads, as its app-version.json names them, or null while it can't be read. */
export async function deployedAssets(): Promise<string[] | null> {
  try {
    // Asked afresh each time, though Cloudflare answers that it hasn't changed without sending it again.
    const response = await fetch(APP_VERSION_PATH, { cache: "no-cache" });
    if (!response.ok) return null;
    const { assets } = ((await response.json()) ?? {}) as Partial<AppVersion>;
    return Array.isArray(assets) && assets.length > 0 && assets.every((path) => typeof path === "string") ? assets : null;
  } catch {
    return null;
  }
}
