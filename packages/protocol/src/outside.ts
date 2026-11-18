// Outside AI: the AI apps, such as Claude and ChatGPT, that people connect to Ember over the Model
// Context Protocol (https://modelcontextprotocol.io), to read it as them and, where they let it, to
// send messages as them, in the rooms open to everyone, and in their direct messages and private rooms
// only where they let it into those too. An app is given Ember's
// address, `/mcp`, and signs in with OAuth, where Ember is the authorization server: it sends the
// person's browser to a page of Ember's that asks them, and what they allow is a connection, which
// they can end on their profile. An administrator turns it on, and until one does, none of it answers.

/** Where an AI app connects, which is what a person gives it. */
export const MCP_PATH = "/mcp";

/** The page an AI app sends a person's browser to, which asks them whether to connect it as them. */
export const OUTSIDE_AUTHORIZE_PATH = "/oauth/authorize";

/**
 * What a connection can be allowed to do: read as its person, and send messages as them, in the rooms
 * open to everyone that they're in, and with "private", in their direct messages and private rooms too.
 * "private" gives no tools of its own, so a connection always has reading or sending besides.
 */
export const OUTSIDE_SCOPES = ["read", "write", "private"] as const;
export type OutsideScope = (typeof OUTSIDE_SCOPES)[number];

/** What an app that asks for nothing by name is given: reading alone. */
export const DEFAULT_OUTSIDE_SCOPES: readonly OutsideScope[] = ["read"];

/** The scopes the page leaves unticked, which a connection has only when its person ticks them: their direct messages and private rooms. */
export const UNTICKED_OUTSIDE_SCOPES: readonly OutsideScope[] = ["private"];

/** What the page says each scope lets an app do, after "It will be able to". */
export const OUTSIDE_SCOPE_EXPLAINED: Record<OutsideScope, string> = {
  read: "See the open rooms you're in, read their messages and search them, as you can",
  write: "Send messages as you, in the open rooms you're in",
  private: "Do the same in your direct messages and private rooms",
};

/** The scopes among `asked` that the page lets a person leave out: their direct messages and private rooms, and sending, when the app asks to read too. */
export const optionalOutsideScopes = (asked: readonly OutsideScope[]): OutsideScope[] =>
  asked.filter((scope) => UNTICKED_OUTSIDE_SCOPES.includes(scope) || (scope !== "read" && asked.includes("read")));

/**
 * What a connection is given of the scopes its app `asked` for, when its person leaves out `without` of
 * those the page ticks and ticks `ticked` of those it doesn't (`UNTICKED_OUTSIDE_SCOPES`): every one they
 * may not leave out, and of the rest, those they kept or ticked. So an answer that names none of them
 * gives what the page ticks, and never their direct messages and private rooms.
 */
export function grantedOutsideScopes(asked: readonly OutsideScope[], without: readonly unknown[], ticked: readonly unknown[]): OutsideScope[] {
  const optional = optionalOutsideScopes(asked);
  const chosen = (scope: OutsideScope) => (UNTICKED_OUTSIDE_SCOPES.includes(scope) ? ticked.includes(scope) : !without.includes(scope));
  return asked.filter((scope) => !optional.includes(scope) || chosen(scope));
}

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

/**
 * A person's answer to a request: whether to connect the app as them, which of what it asks that the
 * page ticks they leave out, if any, and which of what it leaves unticked they tick, if any
 * (`grantedOutsideScopes`).
 */
export interface OutsideAnswer {
  ask: OutsideAsk;
  allow: boolean;
  without?: OutsideScope[];
  with?: OutsideScope[];
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

/** The scopes `asked` names that Ember gives, with the ones it gives by default when it names none that give tools. */
export function outsideScopesOf(asked: string | null): OutsideScope[] {
  const named = new Set((asked ?? "").split(" "));
  const given = OUTSIDE_SCOPES.filter((scope) => named.has(scope));
  return given.some((scope) => scope !== "private") ? given : OUTSIDE_SCOPES.filter((scope) => DEFAULT_OUTSIDE_SCOPES.includes(scope) || given.includes(scope));
}
