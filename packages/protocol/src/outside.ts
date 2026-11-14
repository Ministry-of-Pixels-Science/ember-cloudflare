// Outside AI: the AI apps, such as Claude and ChatGPT, that people connect to Ember over the Model
// Context Protocol (https://modelcontextprotocol.io), to read it as them. An app is given Ember's
// address, `/mcp`, and signs in with OAuth, where Ember is the authorization server: it sends the
// person's browser to a page of Ember's that asks them, and what they allow is a connection, which
// they can end on their profile. An administrator turns it on, and until one does, none of it answers.

/** Where an AI app connects, which is what a person gives it. */
export const MCP_PATH = "/mcp";

/** The page an AI app sends a person's browser to, which asks them whether to connect it as them. */
export const OUTSIDE_AUTHORIZE_PATH = "/oauth/authorize";

/** What a connection can be allowed to do. */
export const OUTSIDE_SCOPES = ["read"] as const;
export type OutsideScope = (typeof OUTSIDE_SCOPES)[number];

/** What the page says each scope lets an app do, after "It will be able to". */
export const OUTSIDE_SCOPE_EXPLAINED: Record<OutsideScope, string> = {
  read: "See the rooms you're in, read their messages and search them, as you can",
};

/** The most connections a person has: past it, they disconnect one first. */
export const MAX_OUTSIDE_CONNECTIONS = 20;

/** The longest name Ember keeps of an AI app, and the longest address of one's it takes. */
export const MAX_OUTSIDE_NAME_LENGTH = 100;
export const MAX_OUTSIDE_ADDRESS_LENGTH = 2048;

export const OUTSIDE_OFF = "Connecting AI apps to Ember is turned off";
export const OUTSIDE_FORBIDDEN = "Only administrators can change whether AI apps connect";
export const OUTSIDE_GUEST = "Someone who signed in with just a name can't connect an AI app";
export const OUTSIDE_FULL = `You have ${MAX_OUTSIDE_CONNECTIONS} AI apps connected already. Disconnect one on your profile first.`;
export const OUTSIDE_CONNECTION_GONE = "That connection has ended already";
/** What the page says of a request it can't ask about: one whose app Ember doesn't know, or that isn't made the way Ember takes them. */
export const OUTSIDE_ASK_REFUSED = "This isn't a request Ember can answer. Start connecting again from the AI app.";

/** What an AI app's request to connect carries, in the address of the page that asks: OAuth's parameters, by Ember's names. */
export interface OutsideAsk {
  /** `response_type`, which Ember takes only as "code". */
  responseType: string | null;
  /** `client_id`: the id Ember gave the app when it registered, or the address of a document about it. */
  clientId: string | null;
  /** `redirect_uri`: where the app has the browser sent back. */
  redirectUri: string | null;
  /** `state`, which goes back to the app as it came. */
  state: string | null;
  /** `code_challenge` and its method, which Ember takes only as "S256". */
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  /** `scope`: what the app asks to do, by scopes' names with spaces between, or null for what Ember gives by default. */
  scope: string | null;
  /** `resource`: the address the app connects to, which what it's given is good for. */
  resource: string | null;
}

/** The request an address's `query` carries: the page's, as its `URLSearchParams`. */
export function outsideAskOf(query: { get(name: string): string | null }): OutsideAsk {
  return {
    responseType: query.get("response_type"),
    clientId: query.get("client_id"),
    redirectUri: query.get("redirect_uri"),
    state: query.get("state"),
    codeChallenge: query.get("code_challenge"),
    codeChallengeMethod: query.get("code_challenge_method"),
    scope: query.get("scope"),
    resource: query.get("resource"),
  };
}

/**
 * What the page says of a request: the name the app gives itself, which nothing vouches for, the host
 * the browser goes back to, which is what tells whose it is, the workspace, and what it would be
 * allowed.
 */
export interface OutsideAsked {
  name: string;
  comesBackTo: string;
  workspace: string;
  scopes: OutsideScope[];
}

/** A person's answer to a request: whether to connect the app as them. */
export interface OutsideAnswer {
  ask: OutsideAsk;
  allow: boolean;
}

/** Where the page sends the browser once the person has answered: back to the app, with what it takes from there. */
export interface OutsideAnswered {
  redirectTo: string;
}

/** An AI app connected as you, as your profile lists it: its name, where it came back to, when you connected it, and when it last asked Ember anything, if it has. */
export interface OutsideConnection {
  id: string;
  name: string;
  comesBackTo: string;
  scopes: OutsideScope[];
  connectedAt: string;
  usedAt: string | null;
}

/** What `DELETE /api/users/me/outside/<id>` answers: the AI apps still connected as you, newest first, as your profile then lists them. */
export interface YourOutsideAi {
  connections: OutsideConnection[];
}

/** Whether AI apps may connect, as the AI assistant tab's card shows administrators. */
export interface OutsideAiSettings {
  on: boolean;
}

/** The scopes `asked` names that Ember gives, or the ones it gives by default when it names none. */
export function outsideScopesOf(asked: string | null): OutsideScope[] {
  const named = new Set((asked ?? "").split(" "));
  const given = OUTSIDE_SCOPES.filter((scope) => named.has(scope));
  return given.length > 0 ? given : [...OUTSIDE_SCOPES];
}
