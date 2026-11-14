import { describe, expect, it } from "vitest";
import { outsideAskOf, outsideScopesOf } from "./outside";

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
    expect(outsideScopesOf("read write offline_access")).toEqual(["read"]);
    expect(outsideScopesOf("write")).toEqual(["read"]);
    expect(outsideScopesOf("")).toEqual(["read"]);
    expect(outsideScopesOf(null)).toEqual(["read"]);
  });
});
