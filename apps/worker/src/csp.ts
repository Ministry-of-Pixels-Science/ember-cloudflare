import { isHttps } from "./auth";
import { bodyUpTo } from "./bodies";
import { urlOf } from "./request-url";

// A Content-Security-Policy on everything the Worker answers, which Campfire goes without: the backstop
// should markup ever get past the sanitizer, Lexxy or a dependency. Scripts run only from this origin,
// from a page's own inline scripts, named by hash, and from where Cloudflare Web Analytics' beacon comes
// from, which Cloudflare adds to the pages of a zone with Web Analytics on; styles come from this origin
// or inline, which React's style attributes, Lexxy and an administrator's custom CSS need; images from
// this origin, any HTTPS host, since a preview shows its page's image, and data and blob URLs, which SVG
// previews and photos being picked use; and sockets open to this host alone. Only the pages that show
// Turnstile's check may load its script and frame: open sign-up's and those that ask Ember to email a
// link to join or a code to reset a password, while Ember has a widget's keys, and the one Set up
// Turnstile frames to check a widget's.

/** Where browsers send what the policy blocked, which the Worker logs. */
export const CSP_REPORT_PATH = "/csp-report";

/** The most of a report that's read; a browser's is well under a kilobyte. */
const MAX_REPORT_BYTES = 8 * 1024;

/** Policies already written, by what they depend on: there are a few hosts, and one build's page at a time. */
const policies = new Map<string, string>();
/** More than a deployment has hosts and builds in use; past it, the oldest policy is forgotten. */
const MAX_POLICIES = 32;

/** Where Turnstile's script and the frame it draws its check in come from. */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Where Cloudflare Web Analytics' beacon comes from, which Cloudflare adds to every page of a zone that
 * has Web Analytics on, each version at its own address under this one, with its hash as the script's
 * `integrity`. It reports to this origin's `/cdn-cgi/rum`, which `connect-src 'self'` lets it.
 */
const WEB_ANALYTICS_BEACON = "https://static.cloudflareinsights.com/beacon.min.js/";

/**
 * The policy for an answer to `request`, letting its page run the inline scripts whose SHA-256
 * hashes, in base64, are `scriptHashes`, and, with `turnstile`, Turnstile's check. Sockets name the
 * host, since Safari reads `'self'` as the page's own scheme alone, and on plain HTTP, as `wrangler dev`
 * serves it, previews' images may load over plain HTTP too. Written once for each host, scheme, set of
 * hashes and check, since every answer gets one.
 */
export function contentSecurityPolicy(request: Request, scriptHashes: readonly string[] = [], turnstile = false): string {
  const { host } = urlOf(request);
  const https = isHttps(request);
  const key = `${https ? "https" : "http"} ${host} ${scriptHashes.join(" ")}${turnstile ? " turnstile" : ""}`;
  let policy = policies.get(key);
  if (policy === undefined) {
    policy = writePolicy(host, https, scriptHashes, turnstile);
    if (policies.size >= MAX_POLICIES) policies.delete(policies.keys().next().value!);
    policies.set(key, policy);
  }
  return policy;
}

function writePolicy(host: string, https: boolean, scriptHashes: readonly string[], turnstile: boolean): string {
  return [
    "default-src 'self'",
    ["script-src 'self'", WEB_ANALYTICS_BEACON, ...scriptHashes.map((hash) => `'sha256-${hash}'`), ...(turnstile ? [TURNSTILE_ORIGIN] : [])].join(" "),
    ...(turnstile ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' https:${https ? "" : " http:"} data: blob:`,
    "media-src 'self' blob:",
    `connect-src 'self' ${https ? "wss" : "ws"}://${host}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    `report-uri ${CSP_REPORT_PATH}`,
  ].join("; ");
}

/** A script element with its own code, rather than a `src`, and that code. */
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const encoder = new TextEncoder();

/** The SHA-256 hashes, in base64, of the inline scripts in `html`, as `script-src` names them. */
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const hashes: string[] = [];
  for (const [, script] of html.matchAll(INLINE_SCRIPT)) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(script)));
    hashes.push(btoa(String.fromCharCode(...digest)));
  }
  return hashes;
}

/** What a browser reports, in the `report-uri` format every browser still sends. */
interface Violation {
  "document-uri"?: string;
  "effective-directive"?: string;
  "violated-directive"?: string;
  "blocked-uri"?: string;
  "source-file"?: string;
  "line-number"?: number;
  "column-number"?: number;
}

/**
 * `POST /csp-report`, with what the policy blocked in a browser: logs it, so the Workers Logs show a
 * page the policy got in the way of, and answers 204. A body that isn't a browser's report answers
 * 400, one over 8 KiB, which anyone can send, answers 413 as soon as it's that long, and anything
 * but a POST answers 404, as an address with no page does.
 */
export async function cspReport(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 404 });
  const body = await bodyUpTo(request, MAX_REPORT_BYTES);
  if (body === null) return new Response(null, { status: 413 });
  const violation = violationOf(body);
  if (!violation) return new Response(null, { status: 400 });
  console.warn("Content-Security-Policy violation", {
    page: violation["document-uri"],
    directive: violation["effective-directive"] ?? violation["violated-directive"],
    blocked: violation["blocked-uri"],
    source: violation["source-file"],
    line: violation["line-number"],
    column: violation["column-number"],
  });
  return new Response(null, { status: 204 });
}

/** The report in `body`, if it's a browser's. */
function violationOf(body: string): Violation | null {
  try {
    const report = (JSON.parse(body) as { "csp-report"?: unknown })["csp-report"];
    return report !== null && typeof report === "object" ? (report as Violation) : null;
  } catch {
    return null;
  }
}
