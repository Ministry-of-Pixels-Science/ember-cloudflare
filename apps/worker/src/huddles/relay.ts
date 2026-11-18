import { RELAY_API_TOKEN_UNKNOWN, RELAY_KEY_ID_UNKNOWN, RELAY_TTL_S, RELAY_UNCHECKED, type HuddleIceServer, type HuddleRelayField, type HuddleRelaySetup } from "@ember/protocol/huddles";
import type { Env } from "../env";
import { answerOf, isRecord, sfuApiOf } from "./sfu";

// Cloudflare's TURN service, which relays what a browser sends the Realtime SFU, and what it receives,
// where its network blocks the way there (https://developers.cloudflare.com/realtime/turn/). A browser
// uses the relay with a name and a credential that last a while, which Cloudflare makes for a TURN key,
// and answers among the servers a connection goes by, as a browser takes them (`RTCIceServer`). The
// request that asks carries the key's API token as its bearer token, so only the Worker asks, and the
// token never leaves it. What Cloudflare answers is logged by its status alone.

/** A TURN key: its ID and its API token, as Cloudflare's dashboard shows them when the key is made. */
export type RelayKey = HuddleRelaySetup;

/** How long Cloudflare has to answer with the relay's servers, which is the longest a tab waits on them to join. */
const RELAY_TIMEOUT_MS = 4_000;

/** The most servers taken from what Cloudflare answers, the most addresses of each, and the most characters of an address, a name or a credential. */
const MAX_SERVERS = 4;
const MAX_ADDRESSES = 12;
const MAX_TEXT_LENGTH = 512;

/**
 * An address a browser takes a STUN server at, and one it takes the relay at: a host, a port if it
 * names one, and for the relay how it's reached. A browser refuses a connection any of whose servers'
 * addresses it can't read, so only these are passed on.
 */
const STUN_ADDRESS = /^stun:[a-z0-9.-]+(:\d{1,5})?$/i;
const RELAY_ADDRESS = /^turns?:[a-z0-9.-]+(:\d{1,5})?(\?transport=(udp|tcp))?$/i;
/** The port the relay answers on that browsers won't connect to, where an address only makes one wait. */
const UNREACHED_PORT = /:53(\?|$)/;

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH;

/** The addresses of a server in Cloudflare's answer that a browser takes and reaches, which the answer gives as a list, or as one. */
function addressesOf(urls: unknown): string[] {
  const given = Array.isArray(urls) ? urls : [urls];
  return given.filter((url): url is string => isText(url) && (STUN_ADDRESS.test(url) || RELAY_ADDRESS.test(url)) && !UNREACHED_PORT.test(url)).slice(0, MAX_ADDRESSES);
}

/** A server in Cloudflare's answer as a tab is given it, or null when none of it is of use: the relay's needs the name and the credential it's used with. */
function serverOf(given: unknown): HuddleIceServer | null {
  if (!isRecord(given)) return null;
  const { username, credential } = given;
  const usable = isText(username) && isText(credential);
  const urls = addressesOf(given.urls).filter((url) => usable || STUN_ADDRESS.test(url));
  if (urls.length === 0) return null;
  return urls.some((url) => RELAY_ADDRESS.test(url)) && usable ? { urls, username, credential } : { urls };
}

/**
 * The servers a tab's connections go by in what Cloudflare `said`, the relay's among them, or null when
 * the relay's aren't. Cloudflare answers a list of servers, and answered one alone before.
 */
export function relayServersIn(said: unknown): HuddleIceServer[] | null {
  const given = isRecord(said) ? said.iceServers : null;
  const servers = (Array.isArray(given) ? given : [given])
    .slice(0, MAX_SERVERS)
    .map(serverOf)
    .filter((server) => server !== null);
  return servers.some(({ credential }) => credential !== undefined) ? servers : null;
}

/** What Cloudflare answers when it's asked, as `key`, for the servers a tab's connections go by: its status, and the servers, if it gave the relay's. */
async function serversAsked(env: Env, key: RelayKey): Promise<{ status: number; servers: HuddleIceServer[] | null }> {
  const { answer, said } = await answerOf(
    `${sfuApiOf(env)}/turn/keys/${key.keyId}/credentials/generate-ice-servers`,
    { method: "POST", headers: { Authorization: `Bearer ${key.apiToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ ttl: RELAY_TTL_S }) },
    RELAY_TIMEOUT_MS,
  );
  return { status: answer.status, servers: answer.ok ? relayServersIn(said) : null };
}

/**
 * The servers a tab's connections go by while huddles have a relay by `key`, with what Cloudflare made
 * for the tab to use the relay with, which lasts `RELAY_TTL_S`, or null when Cloudflare didn't give
 * them: the tab joins all the same, without a relay.
 */
export async function relayServers(env: Env, key: RelayKey): Promise<HuddleIceServer[] | null> {
  try {
    const { status, servers } = await serversAsked(env, key);
    if (!servers) console.warn("Cloudflare didn't give the relay's servers:", status);
    return servers;
  } catch (error) {
    console.error("Asking Cloudflare for the relay's servers failed:", error instanceof Error ? error.name : "unknown error");
    return null;
  }
}

/**
 * Why `key` isn't kept, as Cloudflare answers a request for the relay's servers made with it: the field
 * it's about and the status to refuse it with, or null once Cloudflare has given them, which says that
 * the key is there and that the API token is its own. What Cloudflare made for that is given to nobody.
 */
export async function refusalOfRelay(env: Env, key: RelayKey): Promise<{ error: string; field?: HuddleRelayField; status: number } | null> {
  let asked: Awaited<ReturnType<typeof serversAsked>>;
  try {
    asked = await serversAsked(env, key);
  } catch (error) {
    console.error("Asking Cloudflare for the relay's servers failed:", error instanceof Error ? error.name : "unknown error");
    return { error: RELAY_UNCHECKED, status: 502 };
  }
  if (asked.servers) return null;
  console.warn("Cloudflare didn't give the relay's servers:", asked.status);
  if (asked.status === 400 || asked.status === 404) return { error: RELAY_KEY_ID_UNKNOWN, field: "keyId", status: 422 };
  if (asked.status === 401 || asked.status === 403) return { error: RELAY_API_TOKEN_UNKNOWN, field: "apiToken", status: 422 };
  return { error: RELAY_UNCHECKED, status: 502 };
}
