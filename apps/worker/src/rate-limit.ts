import { mappedV4, parseIp } from "./bans";

/**
 * Counts attempts by key in fixed windows that start with each key's first attempt, as Rails'
 * `rate_limit` does on a cache that sets an entry's expiry only when it's created. The sign-in limit is
 * one. Counts live in memory, so they start over when the object holding them does.
 */
export class FixedWindowLimit {
  private readonly windows = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Counts an attempt by `key` at `now`, answering whether it's within the limit. */
  attempt(key: string, now = Date.now()): boolean {
    // A Map keeps keys in the order they were added, which is the order their windows end in, so
    // the expired ones come first and pruning stops at the first that isn't.
    for (const [other, window] of this.windows) {
      if (window.expiresAt > now) break;
      this.windows.delete(other);
    }
    const window = this.windows.get(key) ?? { count: 0, expiresAt: now + this.windowMs };
    window.count++;
    this.windows.set(key, window);
    return window.count <= this.limit;
  }
}

/**
 * What an address counts as where attempts are limited by address: an IPv6 address as its /64, since
 * whoever is given one address there is given them all, and a count kept for each would never fill; an
 * IPv6 address that maps an IPv4 one as that; and any other text, an IPv4 address among them, as itself.
 */
export function networkOf(ipAddress: string): string {
  const ip = parseIp(ipAddress);
  if (!ip?.v6) return ipAddress;
  const mapped = mappedV4(ip);
  if (mapped !== null) return [24n, 16n, 8n, 0n].map((shift) => (mapped >> shift) & 0xffn).join(".");
  const groups = [112n, 96n, 80n, 64n].map((shift) => ((ip.bits >> shift) & 0xffffn).toString(16));
  return `${groups.join(":")}::/64`;
}

/** A `FixedWindowLimit` on attempts from an address, which counts each by its network (`networkOf`). */
export class AddressLimit extends FixedWindowLimit {
  override attempt(ipAddress: string, now = Date.now()): boolean {
    return super.attempt(networkOf(ipAddress), now);
  }
}
