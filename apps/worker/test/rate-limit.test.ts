import { describe, expect, it } from "vitest";
import { AddressLimit, FixedWindowLimit, networkOf } from "../src/rate-limit";

describe("Sign-in attempt limit", () => {
  it("counts each key in a fixed window that starts at its first attempt", () => {
    const limit = new FixedWindowLimit(2, 1_000);
    expect(limit.attempt("a", 0)).toBe(true);
    expect(limit.attempt("a", 500)).toBe(true);
    expect(limit.attempt("a", 999)).toBe(false);
    expect(limit.attempt("b", 999)).toBe(true);

    // a's window ends at 1,000 however many attempts it saw; b's runs to 1,999.
    expect(limit.attempt("a", 1_000)).toBe(true);
    expect(limit.attempt("b", 1_500)).toBe(true);
    expect(limit.attempt("b", 1_998)).toBe(false);
    expect(limit.attempt("b", 1_999)).toBe(true);
    expect(limit.attempt("a", 1_999)).toBe(true);
    expect(limit.attempt("a", 1_999)).toBe(false);
  });
});

describe("A limit on attempts from an address", () => {
  it.each([
    ["an IPv4 address as itself", "203.0.113.7", "203.0.113.7"],
    ["an IPv6 address as its /64", "2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["however the address is written", "2001:0DB8:0001:0002::1", "2001:db8:1:2::/64"],
    ["one with zeros in its network", "2001:db8::1", "2001:db8:0:0::/64"],
    ["the loopback address", "::1", "0:0:0:0::/64"],
    ["an IPv6 address that maps an IPv4 one as that", "::ffff:203.0.113.7", "203.0.113.7"],
    ["one written in hexadecimal too", "::ffff:cb00:7107", "203.0.113.7"],
    ["an IPv6 address with ffff elsewhere as its own /64", "2001:db8:1:2:0:ffff:a00:1", "2001:db8:1:2::/64"],
    ["what isn't an address as it's written", "unknown", "unknown"],
    ["an address with anything after it as it's written", "2001:db8::1%eth0", "2001:db8::1%eth0"],
  ])("counts %s", (_, ipAddress, network) => {
    expect(networkOf(ipAddress)).toBe(network);
  });

  it("counts the addresses of one IPv6 /64 together, and another's apart", () => {
    const limit = new AddressLimit(2, 1_000);
    expect(limit.attempt("2001:db8:1:2::1", 0)).toBe(true);
    expect(limit.attempt("2001:db8:1:2:ffff:ffff:ffff:ffff", 1)).toBe(true);
    expect(limit.attempt("2001:db8:1:2::3", 2)).toBe(false);
    expect(limit.attempt("2001:db8:1:3::1", 2)).toBe(true);
    expect(limit.attempt("203.0.113.7", 3)).toBe(true);
    expect(limit.attempt("::ffff:203.0.113.7", 4)).toBe(true);
    expect(limit.attempt("203.0.113.7", 5)).toBe(false);
    expect(limit.attempt("203.0.113.8", 5)).toBe(true);
  });
});
