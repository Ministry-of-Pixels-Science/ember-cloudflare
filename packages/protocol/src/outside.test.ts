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

  it("is given the scopes it names that Ember has, or the default when it names none of them that give tools", () => {
    expect(outsideScopesOf("read")).toEqual(["read"]);
    expect(outsideScopesOf("write read offline_access")).toEqual(["read", "write"]);
    expect(outsideScopesOf("private write read")).toEqual(["read", "write", "private"]);
    expect(outsideScopesOf("write")).toEqual(["write"]);
    expect(outsideScopesOf("write private")).toEqual(["write", "private"]);
    // Direct messages and private rooms are where else it reads or sends, so asking for them alone asks to read there.
    expect(outsideScopesOf("private")).toEqual(["read", "private"]);
    expect(outsideScopesOf("offline_access")).toEqual(["read"]);
    expect(outsideScopesOf("")).toEqual(["read"]);
    expect(outsideScopesOf(null)).toEqual(["read"]);
  });

  it("lets its person leave out sending, when it asks to read too", () => {
    expect(optionalOutsideScopes(["read", "write"])).toEqual(["write"]);
    expect(optionalOutsideScopes(["read"])).toEqual([]);
    expect(optionalOutsideScopes(["write"])).toEqual([]);

    expect(grantedOutsideScopes(["read", "write"], [], [])).toEqual(["read", "write"]);
    expect(grantedOutsideScopes(["read", "write"], ["write"], [])).toEqual(["read"]);
    // Reading can't be left out, nor the only thing it asks for, nor anything that isn't a scope.
    expect(grantedOutsideScopes(["read", "write"], ["read", "write", "admin", 7], [])).toEqual(["read"]);
    expect(grantedOutsideScopes(["write"], ["write"], [])).toEqual(["write"]);
    expect(grantedOutsideScopes(["read"], ["read"], [])).toEqual(["read"]);
  });

  it("gives its person's direct messages and private rooms only when they tick them, whatever else it asks", () => {
    expect(optionalOutsideScopes(["read", "write", "private"])).toEqual(["write", "private"]);
    expect(optionalOutsideScopes(["read", "private"])).toEqual(["private"]);
    expect(optionalOutsideScopes(["write", "private"])).toEqual(["private"]);

    expect(grantedOutsideScopes(["read", "write", "private"], [], [])).toEqual(["read", "write"]);
    expect(grantedOutsideScopes(["read", "write", "private"], [], ["private"])).toEqual(["read", "write", "private"]);
    expect(grantedOutsideScopes(["read", "write", "private"], ["write"], ["private"])).toEqual(["read", "private"]);
    // Leaving them out of what's left out doesn't tick them, nor does ticking what it didn't ask for.
    expect(grantedOutsideScopes(["read", "private"], ["write"], [])).toEqual(["read"]);
    expect(grantedOutsideScopes(["read", "write"], [], ["private"])).toEqual(["read", "write"]);
    expect(grantedOutsideScopes(["write", "private"], [], ["private", "write"])).toEqual(["write", "private"]);
    expect(grantedOutsideScopes(["write", "private"], ["write"], [])).toEqual(["write"]);
  });
});
