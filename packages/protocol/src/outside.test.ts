import { describe, expect, it } from "vitest";
import { grantedOutsideScopes, optionalOutsideScopes, outsideAskOf, outsideScopesOf } from "./outside";

/** An address's query holding `fields`, as a page reads its own. */
const queryOf = (fields: Record<string, string>) => ({ get: (name: string) => fields[name] ?? null });

describe("An AI app's request to connect", () => {
  it("is read from the address by OAuth's names, with null for what it leaves out", () => {
    const query = queryOf({ response_type: "code", client_id: "0mgk3x2a9b4c70", redirect_uri: "https://claude.example/back", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256" });
    expect(outsideAskOf(query)).toEqual({
      responseType: "code",
      clientId: "0mgk3x2a9b4c70",
      redirectUri: "https://claude.example/back",
      state: null,
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      codeChallengeMethod: "S256",
      scope: null,
      resource: null,
    });
  });

  it("is given the scopes it names that Ember has, or the default when it names none of them", () => {
    expect(outsideScopesOf("read")).toEqual(["read"]);
    expect(outsideScopesOf("write read offline_access")).toEqual(["read", "write"]);
    expect(outsideScopesOf("write")).toEqual(["write"]);
    expect(outsideScopesOf("offline_access")).toEqual(["read"]);
    expect(outsideScopesOf("")).toEqual(["read"]);
    expect(outsideScopesOf(null)).toEqual(["read"]);
  });

  it("lets its person leave out sending, when it asks to read too", () => {
    expect(optionalOutsideScopes(["read", "write"])).toEqual(["write"]);
    expect(optionalOutsideScopes(["read"])).toEqual([]);
    expect(optionalOutsideScopes(["write"])).toEqual([]);

    expect(grantedOutsideScopes(["read", "write"], [])).toEqual(["read", "write"]);
    expect(grantedOutsideScopes(["read", "write"], ["write"])).toEqual(["read"]);
    // Reading can't be left out, nor the only thing it asks for, nor anything that isn't a scope.
    expect(grantedOutsideScopes(["read", "write"], ["read", "write", "admin", 7])).toEqual(["read"]);
    expect(grantedOutsideScopes(["write"], ["write"])).toEqual(["write"]);
    expect(grantedOutsideScopes(["read"], ["read"])).toEqual(["read"]);
  });
});
