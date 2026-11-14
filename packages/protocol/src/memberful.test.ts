import { describe, expect, it } from "vitest";
import {
  MEMBERFUL_API_KEY_REFUSED,
  MEMBERFUL_CLIENT_ID_REFUSED,
  MEMBERFUL_CLIENT_SECRET_REFUSED,
  MEMBERFUL_SITE_REFUSED,
  MEMBERFUL_WEBHOOK_SECRET_REFUSED,
  memberfulKeyOf,
  memberfulSiteOf,
  parseMemberfulKeysChange,
} from "./memberful";

const SITE = "https://fernwood.memberful.com";
/** A site's keys, as Memberful's dashboard shows them. */
const KEYS = {
  site: SITE,
  clientId: "5vmrRcXKRn7bLuK4uTbGqDV5",
  clientSecret: "Vfa9uQGvqQp4DXsNgcR8Lk2y",
  apiKey: "K3w9mZsQp7vLx2Nc8RfT4yHb",
  webhookSecret: "a91c6e7f0b2d4e58b3f6a1c9d0e7b2f4",
};

describe("a Memberful site's address", () => {
  it("is the origin of the address given, taking https as read without a scheme", () => {
    for (const given of [SITE, `${SITE}/`, `${SITE}/admin/settings`, ` ${SITE}?from=ember#top `, "fernwood.memberful.com", "FERNWOOD.memberful.com/account", "HTTPS://fernwood.memberful.com"]) {
      expect(memberfulSiteOf(given), given).toBe(SITE);
    }
    // A Memberful site at a domain of its own.
    expect(memberfulSiteOf("members.fernwood.example")).toBe("https://members.fernwood.example");
    expect(memberfulSiteOf("https://members.fernwood.example:8443")).toBe("https://members.fernwood.example:8443");
  });

  it("is http only on this computer, where the browser tests fake a site", () => {
    expect(memberfulSiteOf("http://127.0.0.1:8790")).toBe("http://127.0.0.1:8790");
    expect(memberfulSiteOf("http://localhost:8790/")).toBe("http://localhost:8790");
    for (const given of ["http://fernwood.memberful.com", "ftp://fernwood.memberful.com", "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd"]) {
      expect(memberfulSiteOf(given), given).toBeNull();
    }
  });

  it("refuses what can't be a site's address", () => {
    for (const given of ["", "   ", "https://", "https:// fernwood.memberful.com", "https://ada:secret@fernwood.memberful.com", "https://ada@fernwood.memberful.com", `https://${"a".repeat(2048)}.com`]) {
      expect(memberfulSiteOf(given), given.slice(0, 40)).toBeNull();
    }
  });
});

describe("a Memberful key", () => {
  it("is what's given, without the spaces around it", () => {
    expect(memberfulKeyOf(` ${KEYS.clientId}\n`)).toBe(KEYS.clientId);
    expect(memberfulKeyOf("a-b_c.d~e+f/g=")).toBe("a-b_c.d~e+f/g=");
    expect(memberfulKeyOf("k".repeat(255))).toBe("k".repeat(255));
  });

  it("refuses what can't be one: nothing, spaces within it, letters outside ASCII's, or far longer than Memberful's", () => {
    for (const given of ["", "  ", "two words", "tab\there", "clé", "k".repeat(256)]) expect(memberfulKeyOf(given), given.slice(0, 20)).toBeNull();
  });
});

describe("Set up Memberful's keys", () => {
  it("takes the site, as its origin, and its keys, without the spaces around them", () => {
    expect(
      parseMemberfulKeysChange({
        site: " fernwood.memberful.com/admin ",
        clientId: ` ${KEYS.clientId}`,
        clientSecret: `${KEYS.clientSecret}\n`,
        apiKey: KEYS.apiKey,
        webhookSecret: `\t${KEYS.webhookSecret}`,
        // Only what Ember keeps is kept.
        appId: "theirs",
      }),
    ).toEqual(KEYS);
  });

  it("refuses each field that can't be what it's for, on that field, the site first", () => {
    expect(parseMemberfulKeysChange({ ...KEYS, site: "http://fernwood.memberful.com", clientId: "" })).toEqual({ error: MEMBERFUL_SITE_REFUSED, field: "site" });
    const refusals = [
      ["clientId", MEMBERFUL_CLIENT_ID_REFUSED],
      ["clientSecret", MEMBERFUL_CLIENT_SECRET_REFUSED],
      ["apiKey", MEMBERFUL_API_KEY_REFUSED],
      ["webhookSecret", MEMBERFUL_WEBHOOK_SECRET_REFUSED],
    ] as const;
    for (const [field, error] of refusals) {
      for (const value of ["", "two words", 42, null, undefined, [KEYS[field]]]) {
        expect(parseMemberfulKeysChange({ ...KEYS, [field]: value }), `${field}: ${JSON.stringify(value)}`).toEqual({ error, field });
      }
    }
  });

  it("refuses anything that isn't an object of them, on the site's field", () => {
    for (const data of [null, undefined, "keys", [SITE, KEYS.clientId], 7]) {
      expect(parseMemberfulKeysChange(data), JSON.stringify(data)).toEqual({ error: MEMBERFUL_SITE_REFUSED, field: "site" });
    }
  });
});
