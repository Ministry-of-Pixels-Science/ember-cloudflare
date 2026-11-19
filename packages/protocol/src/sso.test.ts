import { describe, expect, it } from "vitest";
import {
  CLIENT_ID_REFUSED,
  DEFAULT_GROUPS_CLAIM,
  DEFAULT_SSO_NAME,
  GROUPS_REFUSED,
  ISSUER_REFUSED,
  MAX_SSO_GROUPS,
  parseSsoSetup,
  SCOPES_REFUSED,
  SSO_NAME_REFUSED,
  ssoProblemOf,
  ssoSignInPath,
} from "./sso.ts";

describe("parseSsoSetup", () => {
  it("takes a provider as Set up single sign-on sends it, trimmed, with scopes apart by spaces and groups a line each", () => {
    expect(
      parseSsoSetup({
        issuer: " https://example.zitadel.cloud ",
        clientId: "123@ember",
        clientSecret: "s3cret",
        name: "Acme",
        scopes: "urn:zitadel:iam:org:projects:roles  extra extra",
        groupsClaim: "urn:zitadel:iam:org:project:roles",
        allowedGroups: "chat\n\n staff \nchat",
        linksVerifiedEmails: true,
      }),
    ).toEqual({
      issuer: "https://example.zitadel.cloud",
      clientId: "123@ember",
      clientSecret: "s3cret",
      name: "Acme",
      scopes: ["urn:zitadel:iam:org:projects:roles", "extra"],
      groupsClaim: "urn:zitadel:iam:org:project:roles",
      allowedGroups: ["chat", "staff"],
      linksVerifiedEmails: true,
    });
  });

  it("fills in what's left out, and leaves out the issuer, app and secret the deployment's secrets give", () => {
    expect(parseSsoSetup({})).toEqual({ name: DEFAULT_SSO_NAME, scopes: [], groupsClaim: DEFAULT_GROUPS_CLAIM, allowedGroups: [], linksVerifiedEmails: false });
    expect(parseSsoSetup({ scopes: ["a", "b"], allowedGroups: ["x"] })).toMatchObject({ scopes: ["a", "b"], allowedGroups: ["x"] });
  });

  it("refuses each field that can't be a provider's, on that field", () => {
    expect(parseSsoSetup({ issuer: "example.com" })).toEqual({ error: ISSUER_REFUSED, field: "issuer" });
    expect(parseSsoSetup({ issuer: "https://example.com/?x" })).toEqual({ error: ISSUER_REFUSED, field: "issuer" });
    expect(parseSsoSetup({ clientId: " " })).toEqual({ error: CLIENT_ID_REFUSED, field: "clientId" });
    expect(parseSsoSetup({ name: "x".repeat(41) })).toEqual({ error: SSO_NAME_REFUSED, field: "name" });
    expect(parseSsoSetup({ scopes: "bad\u0001scope" })).toEqual({ error: SCOPES_REFUSED, field: "scopes" });
    expect(parseSsoSetup({ allowedGroups: Array.from({ length: MAX_SSO_GROUPS + 1 }, (_, i) => `g${i}`) })).toEqual({ error: GROUPS_REFUSED, field: "allowedGroups" });
    expect(parseSsoSetup({ allowedGroups: [1] })).toEqual({ error: GROUPS_REFUSED, field: "allowedGroups" });
  });
});

describe("sign-in addresses and problems", () => {
  it("names the page to come back to, and reads only the problems it knows", () => {
    expect(ssoSignInPath(null)).toBe("/auth/sso");
    expect(ssoSignInPath("/rooms/abc?x=1")).toBe("/auth/sso?return_to=%2Frooms%2Fabc%3Fx%3D1");
    expect(ssoProblemOf("membership")).toBe("membership");
    expect(ssoProblemOf("toString")).toBeNull();
    expect(ssoProblemOf(null)).toBeNull();
  });
});
