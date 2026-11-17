// Which IP addresses a ban can block, as Campfire's `ip_address_is_public` decides (app/models/ban.rb):
// an address Rust's `IpAddr` parses, as Ruby's `IPAddr.new` takes it, optionally with a `/prefix` that
// masks it, or an IPv6 address in brackets, and that isn't loopback, private or link-local as Ruby's
// `IPAddr` decides.

/** An address as a number: 32 bits for IPv4, 128 for IPv6. */
interface IpAddress {
  v6: boolean;
  bits: bigint;
}

/**
 * Why a ban can't block an IP address: it isn't one, or it's loopback, private or link-local
 * ("internal", which "cannot be a private or internal IP address").
 */
export type BanProblem = "invalid" | "internal";

/** Why a ban can't block `ipAddress`, or null if it can. */
export function banProblem(ipAddress: string): BanProblem | null {
  const ip = parseIpAddress(ipAddress);
  if (!ip) return "invalid";
  return isLoopback(ip) || isPrivate(ip) || isLinkLocal(ip) ? "internal" : null;
}

/** An address as Ruby's `IPAddr.new` reads one: optionally with a `/prefix` that masks it, or an IPv6 address in brackets. */
function parseIpAddress(text: string): IpAddress | null {
  const slash = text.indexOf("/");
  const address = slash < 0 ? text : text.slice(0, slash);
  const unbracketed = address.length > 1 && address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const ip = parseIp(unbracketed);
  if (!ip || slash < 0) return ip;
  // Rust's `u32` parse, which takes a "+" too.
  const prefix = text.slice(slash + 1);
  const width = ip.v6 ? 128n : 32n;
  if (!/^\+?[0-9]+$/.test(prefix) || BigInt(prefix.replace("+", "")) > width) return null;
  const host = width - BigInt(prefix.replace("+", ""));
  return { v6: ip.v6, bits: ip.bits & (((1n << width) - 1n) ^ ((1n << host) - 1n)) };
}

/** Rust's `IpAddr` parse: IPv4 if the text starts as one, else IPv6, and nothing after. */
function parseIp(text: string): IpAddress | null {
  const v4 = readIpv4(text, 0);
  if (v4) return v4[1] === text.length ? { v6: false, bits: BigInt(v4[0]) } : null;
  const v6 = readIpv6(text, 0);
  return v6 && v6[1] === text.length ? { v6: true, bits: v6[0] } : null;
}

/** What a read gives, and where in the text it stopped, or null if it found nothing it could read. */
type Read<T> = [T, number] | null;

/**
 * Rust's `read_number`: 1 to `maxDigits` digits in `radix`, as a number below `limit`, with no leading
 * zero unless `zeroPrefix`.
 */
function readNumber(text: string, at: number, radix: 10 | 16, maxDigits: number, zeroPrefix: boolean, limit: number): Read<number> {
  const leadingZero = text[at] === "0";
  let value = 0;
  let digits = 0;
  for (let digit = parseInt(text[at] ?? "", radix); !Number.isNaN(digit); digit = parseInt(text[++at] ?? "", radix)) {
    value = value * radix + digit;
    if (value >= limit || ++digits > maxDigits) return null;
  }
  if (digits === 0 || (!zeroPrefix && leadingZero && digits > 1)) return null;
  return [value, at];
}

/** Rust's `read_separator`: what `read` reads after `separator`, which the first of a list (`index` 0) goes without. */
function separated<T>(text: string, at: number, separator: string, index: number, read: (text: string, at: number) => Read<T>): Read<T> {
  if (index === 0) return read(text, at);
  return text[at] === separator ? read(text, at + 1) : null;
}

/** Rust's `read_ipv4_addr`: four decimal octets with dots between them, none with a leading zero. */
function readIpv4(text: string, at: number): Read<number> {
  let bits = 0;
  for (let index = 0; index < 4; index++) {
    const octet = separated(text, at, ".", index, (text, at) => readNumber(text, at, 10, 3, false, 256));
    if (!octet) return null;
    bits = bits * 256 + octet[0];
    at = octet[1];
  }
  return [bits, at];
}

/**
 * Rust's `read_groups`: up to `limit` groups of up to four hex digits with colons between them, the last
 * two of which can be an IPv4 address instead, into `groups`. Answers how many it read, whether it ended
 * with an IPv4 address, and where it stopped.
 */
function readGroups(text: string, at: number, groups: number[], limit: number): [number, boolean, number] {
  for (let index = 0; index < limit; index++) {
    if (index < limit - 1) {
      const ipv4 = separated(text, at, ":", index, readIpv4);
      if (ipv4) {
        groups[index] = ipv4[0] >>> 16;
        groups[index + 1] = ipv4[0] & 0xffff;
        return [index + 2, true, ipv4[1]];
      }
    }
    const group = separated(text, at, ":", index, (text, at) => readNumber(text, at, 16, 4, true, 0x10000));
    if (!group) return [index, false, at];
    groups[index] = group[0];
    at = group[1];
  }
  return [limit, false, at];
}

/** Rust's `read_ipv6_addr`: eight groups, or fewer with a `::` standing for at least one group of zeros, with no IPv4 address before it. */
function readIpv6(text: string, at: number): Read<bigint> {
  const head = [0, 0, 0, 0, 0, 0, 0, 0];
  const [headSize, headIpv4, afterHead] = readGroups(text, at, head, 8);
  if (headSize === 8) return [bitsOf(head), afterHead];
  if (headIpv4 || text.slice(afterHead, afterHead + 2) !== "::") return null;
  const tail: number[] = [];
  const [tailSize, , afterTail] = readGroups(text, afterHead + 2, tail, 8 - (headSize + 1));
  head.splice(8 - tailSize, tailSize, ...tail.slice(0, tailSize));
  return [bitsOf(head), afterTail];
}

const bitsOf = (groups: number[]) => groups.reduce((bits, group) => (bits << 16n) | BigInt(group), 0n);

// Ruby's IPAddr predicates, except in which IPv6 addresses they take for IPv4-mapped ones. Ruby only
// checks the `ffff` bits (`@addr & 0xffff_0000_0000 == 0xffff_0000_0000`), which takes a public address
// anyone with an IPv6 prefix can sign in from, such as 2001:db8:1:2:0:ffff:a00:1, for a private one,
// and a ban that can't block one of someone's addresses doesn't ban them.

/** The IPv4 address an IPv6 one maps, which only one in ::ffff:0:0/96 does, or null. */
const mappedV4 = ({ v6, bits }: IpAddress) => (v6 && bits >> 32n === 0xffffn ? bits & 0xffff_ffffn : null);

/** Whether an IPv4 address is in 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 or 169.254.0.0/16. */
const isLoopbackV4 = (bits: bigint) => (bits & 0xff00_0000n) === 0x7f00_0000n;
const isPrivateV4 = (bits: bigint) => (bits & 0xff00_0000n) === 0x0a00_0000n || (bits & 0xfff0_0000n) === 0xac10_0000n || (bits & 0xffff_0000n) === 0xc0a8_0000n;
const isLinkLocalV4 = (bits: bigint) => (bits & 0xffff_0000n) === 0xa9fe_0000n;

/** Whether an address is `::1`, an IPv4 one in 127.0.0.0/8, or mapped from one. */
function isLoopback(ip: IpAddress): boolean {
  const mapped = mappedV4(ip);
  return ip.v6 ? ip.bits === 1n || (mapped !== null && isLoopbackV4(mapped)) : isLoopbackV4(ip.bits);
}

/** Whether an address is in fc00::/7, a private IPv4 range, or mapped from one. */
function isPrivate(ip: IpAddress): boolean {
  const mapped = mappedV4(ip);
  return ip.v6 ? ip.bits >> 121n === 0xfcn >> 1n || (mapped !== null && isPrivateV4(mapped)) : isPrivateV4(ip.bits);
}

/** Whether an address is in fe80::/10, 169.254.0.0/16, or mapped from it. */
function isLinkLocal(ip: IpAddress): boolean {
  const mapped = mappedV4(ip);
  return ip.v6 ? ip.bits >> 118n === 0xfe80n >> 6n || (mapped !== null && isLinkLocalV4(mapped)) : isLinkLocalV4(ip.bits);
}
