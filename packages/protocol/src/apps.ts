import type { UserId } from "./index.ts";

// Apps: the MCP servers an administrator connects, whose tools the AI agents may be given. An app is
// the address of a server that speaks the Model Context Protocol over Streamable HTTP
// (https://modelcontextprotocol.io), the token Ember sends it, if it takes one, and the tools Ember read
// from it when an administrator last looked.

/** An app's id, as its page's address names it. */
export type AppId = string;

/** The most apps a workspace connects. */
export const MAX_APPS = 10;

export const MAX_APP_NAME_LENGTH = 60;
export const MAX_APP_URL_LENGTH = 2048;
export const MAX_APP_TOKEN_LENGTH = 4096;
export const MAX_APP_CLIENT_ID_LENGTH = 512;
export const MAX_APP_CLIENT_SECRET_LENGTH = 1024;
/** The most characters of OAuth scopes Ember keeps of what an app's server asks for beyond its sign-in. */
export const MAX_APP_SCOPE_LENGTH = 1000;

/** The most tools Ember reads from an app: the rest are left out, which its page says. */
export const MAX_APP_TOOLS = 100;

/** The most characters Ember keeps of a tool's description, which rides with every question its agents are asked. */
export const MAX_TOOL_DESCRIPTION_LENGTH = 1500;

export const APPS_FORBIDDEN = "Only administrators can connect apps";
export const APPS_FULL = `Ember connects at most ${MAX_APPS} apps. Remove one first.`;
export const APP_CHANGED = "Someone else changed this app while Ember read its tools. Load the page again.";
export const APP_URL_REFUSED = "The address must be an https URL, or an http one on localhost";
export const APP_SIGNED_IN = "This app signs in to its server, so its address and token can't be changed here. Remove it and connect it again to move it.";
export const APP_SIGN_IN_ENDED = "That sign-in has ended, or isn't one you started. Start it again.";
export const APP_IS_EMBER = "That's this Ember's own address. Connected to itself, Ember would let its agents read your DMs and private rooms for anyone who asks them.";

/** A tool of an app's, as its server describes it: its name there, what it's called, if that's something else, and what it does. */
export interface AppTool {
  name: string;
  title: string | null;
  description: string;
}

/**
 * An app as its page shows it: its name, its server's address, whether Ember
 * sends a token, which it never shows again, what the server calls itself, the tools read from it, how
 * many more it has than Ember keeps, and who connected it, and when its tools were last read, and its
 * sign-in, if an administrator signed in to its server.
 */
export interface App {
  id: AppId;
  name: string;
  url: string;
  hasToken: boolean;
  serverName: string | null;
  tools: AppTool[];
  toolsLeftOut: number;
  toolsReadAt: string;
  connectedBy: { id: UserId; name: string } | null;
  setAside: SetAsideTool[];
  signIn: AppSignIn | null;
}

/**
 * An app's sign-in: who signed in to its server, if they're still known, and when, whether it has
 * `ended`, as it has once its server won't give Ember another token, so that its agents are without
 * its tools until an administrator signs in again, the client ID Ember signed in as, when an
 * administrator gave one (`AppClient`), or null when the service came to know Ember by itself, and
 * what its server has asked for since that the sign-in doesn't allow, `wantsScope`, as the OAuth
 * scopes it named, between spaces: signing in again asks for them too.
 */
export interface AppSignIn {
  by: { id: UserId; name: string } | null;
  at: string;
  ended: boolean;
  clientId: string | null;
  wantsScope: string | null;
}

/**
 * An app as the AI assistant tab lists it: its name, its server's address, how many tools Ember read
 * from it, how many of them are set aside for an agent that had them (`SetAsideTool`), whether
 * Ember's sign-in to its server has ended, so that its server isn't asked until an administrator signs
 * in again, and whether its server has asked for more than the sign-in allows, `wantsAccess`, which
 * signing in again asks for.
 */
export interface AppSummary {
  id: AppId;
  name: string;
  url: string;
  toolCount: number;
  setAside: number;
  signInEnded: boolean;
  wantsAccess: boolean;
}

/**
 * A tool picked for agents that none of them is given any more, by its name at its app, with the
 * agents that had it: its server describes it another way than when it was picked, so it waits for an
 * administrator to pick it again on each agent's page, or its server no longer has it, `gone`.
 */
export interface SetAsideTool {
  name: string;
  gone: boolean;
  agents: Array<{ id: UserId; name: string }>;
}

/** What `GET /api/account/apps` answers: the apps, by name. */
export interface Apps {
  apps: AppSummary[];
}

/**
 * What `DELETE /api/account/apps/<id>` answers for an app Ember was signed in to: whether its service
 * took back what the sign-in gave Ember, `revoked`, which it's asked to where it says how. Any other
 * app's removal answers 204.
 */
export interface AppRemoved {
  revoked: boolean;
}

/** What a request that makes or changes an app answers. */
export interface AppAnswer {
  app: App;
}

/** What `POST /api/account/apps` takes: the app's name, its server's address, and the token to send it, if it takes one. */
export interface NewApp {
  name: string;
  url: string;
  token?: string;
}

/**
 * What `PATCH /api/account/apps/<id>` changes: its name, its server's address, or its token, "" for
 * none. What's left out stays as it is.
 */
export interface AppChanges {
  name?: string;
  url?: string;
  token?: string;
}

/**
 * Why a field of an app's form is refused, and whether that's because its server asks for a sign-in,
 * which Ember can begin, or because its sign-in wants a client ID Ember can't get itself, `client`,
 * which the form then asks for.
 */
export interface AppRefused {
  error: string;
  field?: "name" | "url" | "token" | "clientId" | "clientSecret";
  signIn?: true;
  client?: true;
}

/**
 * Who Ember is to a service whose sign-in neither reads who a client is nor lets one register itself:
 * the client ID the service gave an administrator who registered Ember there, and its secret, if it
 * gave one. On a sign-in to a connected app, a `clientId` left out keeps the one the app signed in
 * as, with its secret when none is given, and "" has Ember go without one.
 */
export interface AppClient {
  clientId?: string;
  clientSecret?: string;
}

/** What `POST /api/account/app-sign-ins` takes: the name and server address of an app to connect by signing in to its server, and who Ember is there, if the service doesn't find out by itself. */
export type NewAppSignIn = Pick<NewApp, "name" | "url"> & AppClient;

/** What beginning a sign-in answers: where to send the administrator's browser, which comes back to `/account/apps/signed-in`. */
export interface AppSignInBegun {
  authorizationUrl: string;
}

/**
 * What `POST /api/account/app-sign-ins/finish` takes, from the address the administrator's browser came
 * back to: the `state` and `code` it carried, and who the authorization server said it is, `iss`, if
 * it said.
 */
export interface AppSignInReturn {
  state: string;
  code: string;
  iss?: string;
}

/** What finishing a sign-in answers: the app as its page then shows it, and whether it was connected already, and signed in to `again`. */
export interface AppSignedIn {
  app: App;
  again: boolean;
}

/**
 * A connected app Ember signs in to, as your profile lists it: by its name, with the sign-in you've
 * made to it yourself, if you have: when, whether it has `ended`, and whether its server has asked for
 * more than it allows, `wantsMore`, which signing in again asks for. With one, what an agent does with
 * the app in your direct conversation with it, it does as you.
 */
export interface YourApp {
  id: AppId;
  name: string;
  signedInAt: string | null;
  ended: boolean;
  wantsMore: boolean;
}

/** What finishing a sign-in you made to a connected app yourself answers: the app as your profile then lists it. */
export interface YourAppSignedIn {
  yours: YourApp;
}

/** What `DELETE /api/users/me/apps/<id>/sign-in` answers: the apps as your profile then lists them, and whether the app's service took back what your sign-in gave Ember. */
export interface YourAppSignedOut {
  apps: YourApp[];
  revoked: boolean;
}

export const YOUR_APP_GONE = "That app isn't one you can sign in to here any more.";
export const YOUR_APPS_FORBIDDEN = "Guests can't sign in to apps";

/** The longest state, code or issuer a browser comes back from a sign-in with that Ember reads. */
const MAX_RETURN_LENGTH = 4096;

/** Parses what a browser came back from a sign-in with, untrusted, or says why it's refused. */
export function parseAppSignInReturn(data: unknown): AppSignInReturn | AppRefused {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { error: "Expected a JSON object" };
  const { state, code, iss } = data as Record<string, unknown>;
  const isText = (value: unknown): value is string => typeof value === "string" && value !== "" && value.length <= MAX_RETURN_LENGTH;
  if (!isText(state) || !isText(code) || (iss !== undefined && !isText(iss))) return { error: APP_SIGN_IN_ENDED };
  return { state, code, ...(iss !== undefined && { iss }) };
}

/**
 * Parses who an administrator says Ember is to a service, untrusted, or says why it's refused: a client
 * ID and a secret are what a form's field and a header can carry, kept but for the spaces around them,
 * and a secret is some client ID's.
 */
export function parseAppClient(data: unknown): AppClient | AppRefused {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { error: "Expected a JSON object" };
  const { clientId, clientSecret } = data as Record<string, unknown>;
  const client: AppClient = {};
  if (clientId !== undefined) {
    if (typeof clientId !== "string") return { error: "Client ID must be text", field: "clientId" };
    if (clientId.trim().length > MAX_APP_CLIENT_ID_LENGTH) return { error: `Client ID can't be longer than ${MAX_APP_CLIENT_ID_LENGTH} characters`, field: "clientId" };
    if (/[^\x20-\x7e]/.test(clientId.trim())) return { error: "Client ID can't have characters a header can't carry", field: "clientId" };
    client.clientId = clientId.trim();
  }
  if (clientSecret !== undefined && clientSecret !== "") {
    if (typeof clientSecret !== "string") return { error: "Client secret must be text", field: "clientSecret" };
    if (clientSecret.trim().length > MAX_APP_CLIENT_SECRET_LENGTH) return { error: `Client secret can't be longer than ${MAX_APP_CLIENT_SECRET_LENGTH} characters`, field: "clientSecret" };
    if (/[^\x20-\x7e]/.test(clientSecret.trim())) return { error: "Client secret can't have characters a header can't carry", field: "clientSecret" };
    if (!client.clientId) return { error: "A client secret goes with a client ID", field: "clientId" };
    if (clientSecret.trim() !== "") client.clientSecret = clientSecret.trim();
  }
  return client;
}

/**
 * Parses an untrusted change to an app, or says why it's refused: a name has more than spaces, an
 * address is a URL Ember may ask (`isAppUrl`), and a token is what a header can carry. The name and the
 * address are kept trimmed, and the token as it's given but for the spaces around it.
 */
export function parseAppChanges(data: unknown): AppChanges | AppRefused {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { error: "Expected a JSON object" };
  const { name, url, token } = data as Record<string, unknown>;
  const changes: AppChanges = {};
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) return { error: "Name can't be blank", field: "name" };
    if (name.trim().length > MAX_APP_NAME_LENGTH) return { error: `Name can't be longer than ${MAX_APP_NAME_LENGTH} characters`, field: "name" };
    changes.name = name.trim();
  }
  if (url !== undefined) {
    if (typeof url !== "string" || !url.trim()) return { error: "Address can't be blank", field: "url" };
    if (url.trim().length > MAX_APP_URL_LENGTH) return { error: `Address can't be longer than ${MAX_APP_URL_LENGTH} characters`, field: "url" };
    if (!isAppUrl(url.trim())) return { error: APP_URL_REFUSED, field: "url" };
    changes.url = url.trim();
  }
  if (token !== undefined) {
    if (typeof token !== "string") return { error: "Token must be text", field: "token" };
    if (token.trim().length > MAX_APP_TOKEN_LENGTH) return { error: `Token can't be longer than ${MAX_APP_TOKEN_LENGTH} characters`, field: "token" };
    // A header's value can't hold a line break or another control character.
    if (/[^\x20-\x7e]/.test(token.trim())) return { error: "Token can't have spaces between lines or characters a header can't carry", field: "token" };
    changes.token = token.trim();
  }
  return changes;
}

/** Parses an untrusted new app, as `parseAppChanges` does a change, which also needs a name and an address. */
export function parseNewApp(data: unknown): NewApp | AppRefused {
  const changes = parseAppChanges(data);
  if ("error" in changes) return changes;
  if (changes.name === undefined) return { error: "Name can't be blank", field: "name" };
  if (changes.url === undefined) return { error: "Address can't be blank", field: "url" };
  return { name: changes.name, url: changes.url, ...(changes.token && { token: changes.token }) };
}

/**
 * Whether Ember may ask an app at `address`: an https URL with a host, or an http one on this machine,
 * as a bot's webhook is, and without a name and password in it, which would be kept unsealed.
 */
export function isAppUrl(address: string): boolean {
  if (!URL.canParse(address)) return false;
  const { protocol, hostname, username, password } = new URL(address);
  if (hostname === "" || username !== "" || password !== "") return false;
  return protocol === "https:" || (protocol === "http:" && isLoopback(hostname));
}

/**
 * Whether an app at `address`, a URL Ember may ask (`isAppUrl`), would be Ember itself, at one of its
 * own `hosts`, as `location.host` writes them: at any port, as Cloudflare serves a domain at several,
 * but on this computer only at the same port, as `wrangler dev` serves Ember beside other servers.
 */
export function isAtHost(address: string, hosts: readonly string[]): boolean {
  const { host, hostname } = new URL(address);
  const name = hostname.replace(/\.$/, "");
  return hosts.some((own) => (isLoopback(name) ? own === host : own.toLowerCase().replace(/:\d+$/, "") === name));
}

// This package is typed without a platform's library, and every platform it runs on has URL.
declare const URL: {
  new (url: string): { readonly protocol: string; readonly host: string; readonly hostname: string; readonly username: string; readonly password: string };
  canParse(url: string): boolean;
};

/** localhost, its subdomains and the loopback addresses, where `wrangler dev` and the tests' stand-ins serve. */
const LOOPBACK_HOST = /^(?:(?:.+\.)?localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/** Whether `hostname` is this computer's, as a Memberful site the browser tests fake is too. */
export const isLoopback = (hostname: string) => LOOPBACK_HOST.test(hostname);

// The tools an agent may use. An administrator picks them, for @ember and for each agent, from the
// tools Ember read from the connected apps. Each one an agent has rides with every question it's asked,
// and whoever asked is shown each call of one before Ember makes it, unless the administrator has that
// agent's calls of it always allowed, which the room is shown as they're made.

/** The most tools of connected apps one agent may use, as each rides with every question it's asked. */
export const MAX_AGENT_TOOLS = 20;

export const AGENT_TOOLS_FULL = `An agent uses at most ${MAX_AGENT_TOOLS} tools. Pick fewer.`;
export const TOOL_GONE = "One of those tools is gone from its app, or described another way than when this page loaded. Here they are as they are now.";

/** The longest fingerprint of a tool a pick may carry. */
const MAX_FINGERPRINT_LENGTH = 128;

/**
 * A connected app's tool, picked for an agent: the app, the tool's name there, and the fingerprint of
 * the tool as the page offered it, so that a pick is of the tool as the administrator read it.
 */
export interface ToolPick {
  appId: AppId;
  name: string;
  fingerprint: string;
  /** Whether the agent's calls of it are made without asking first. */
  alwaysAllowed?: true;
}

/**
 * A connected app's tool as an agent's page offers it: the fingerprint of how its server describes it,
 * which a pick of it carries, whether the agent may use it, whether its server has described it
 * another way since it was picked, which sets it aside until it's picked again, and whether the agent's
 * calls of it are made without asking first, which only a tool it may use has.
 */
export interface OfferedTool extends AppTool {
  fingerprint: string;
  picked: boolean;
  changed: boolean;
  alwaysAllowed: boolean;
}

/** A connected app as an agent's page offers its tools. */
export interface OfferedApp {
  id: AppId;
  name: string;
  tools: OfferedTool[];
}

/** What `GET` and `PUT /api/account/agents/<id>/tools` answer: every connected app's tools, by the apps' names, and which the agent may use. */
export interface AgentTools {
  apps: OfferedApp[];
}

/** What `PUT /api/account/agents/<id>/tools` takes: every tool the agent may use from then on. */
export interface AgentToolPicks {
  tools: ToolPick[];
}

const NOT_A_PICK = "Expected each tool's app, name and fingerprint, and whether it's always allowed";

/** Parses untrusted picks of an agent's tools, each once, or says why they're refused. */
export function parseToolPicks(data: unknown): ToolPick[] | AppRefused {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { error: "Expected a JSON object" };
  const { tools } = data as Record<string, unknown>;
  if (!Array.isArray(tools)) return { error: "Expected a list of tools" };
  if (tools.length > MAX_AGENT_TOOLS) return { error: AGENT_TOOLS_FULL };
  const picks = new Map<string, ToolPick>();
  for (const tool of tools as unknown[]) {
    if (typeof tool !== "object" || tool === null) return { error: NOT_A_PICK };
    const { appId, name, fingerprint, alwaysAllowed } = tool as Record<string, unknown>;
    if (typeof appId !== "string" || typeof name !== "string" || appId === "" || name === "") return { error: NOT_A_PICK };
    if (typeof fingerprint !== "string" || fingerprint === "" || fingerprint.length > MAX_FINGERPRINT_LENGTH) return { error: NOT_A_PICK };
    if (alwaysAllowed !== undefined && typeof alwaysAllowed !== "boolean") return { error: NOT_A_PICK };
    picks.set(`${appId}\n${name}`, { appId, name, fingerprint, ...(alwaysAllowed && { alwaysAllowed }) });
  }
  return [...picks.values()];
}

/** Whether to make a call of an app's tool an agent asked to make, as the card that asks shows it: once, or not. */
export type CallDecision = "allow" | "deny";

/** The buttons of the card that asks before an agent's call of an app's tool, by the `action_id` each click names. */
export const CALL_ACTIONS: Record<CallDecision, string> = { allow: "ember.call.allow", deny: "ember.call.deny" };
