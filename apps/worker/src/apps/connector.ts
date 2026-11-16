import { DurableObject } from "cloudflare:workers";
import type { StoredOAuthClientInformation } from "@modelcontextprotocol/client";
import type { AppRefused } from "@ember/protocol/apps";
import type { Env } from "../env";
import { callApp, readApp, type CalledTool, type Key, type ReadApp, type ReadTool, type UnreadApp } from "./mcp";
import { finishSignIn, refreshSignIn, revokeSignIn, startSignIn, type SignIn } from "./oauth";

/**
 * Asks connected apps where there's CPU time for it, and subrequests of its own: reading what a server
 * with a hundred tools lists takes more than the 10 ms a Worker's request gets on Workers Free, where a
 * Durable Object's gets 30 seconds. It keeps nothing, so each ask runs in a new object of its own, as a
 * link's preview does. A sign-in to an app crosses to it and back as JSON, as the Workspace keeps it.
 */
/** A sign-in that's begun: where to send the administrator's browser, the state it comes back with, and the sign-in to keep until then, `kept`, as JSON. */
export interface BegunSignIn {
  authorizationUrl: string;
  state: string;
  kept: string;
}

export class AppConnector extends DurableObject<Env> {
  /** `readApp`: the tools of the app at `url`, asked with `key`, or why Ember couldn't read them, which having none is unless it's a connected app's read `again`. */
  read(url: string, key: Key | null, again = false): Promise<ReadApp | UnreadApp> {
    return readApp(url, key, again);
  }

  /** `callApp`: what calling `tool` of the app at `url` with `input` came to, asked with `key`. */
  call(url: string, key: Key | null, tool: Pick<ReadTool, "name" | "fingerprint">, input: Record<string, unknown>): Promise<CalledTool> {
    return callApp(url, key, tool, input);
  }

  /**
   * `startSignIn`: where to send an administrator's browser to sign in to the app at `url`, the state it
   * comes back to `redirectUrl` with, and what to keep of the sign-in until then, or why Ember can't
   * sign in there. `client` is who Ember is there, as JSON, when an administrator gave that, and `more`
   * the scopes to ask for besides those the sign-in asks for by itself, if there are any.
   */
  async startSignIn(url: string, redirectUrl: string, clientUrl: string | null, client: string | null, more: string | null): Promise<BegunSignIn | AppRefused> {
    const begun = await startSignIn(url, redirectUrl, clientUrl, client === null ? null : (JSON.parse(client) as StoredOAuthClientInformation), more);
    return "error" in begun ? begun : { authorizationUrl: begun.authorizationUrl, state: begun.state, kept: JSON.stringify(begun.signIn) };
  }

  /**
   * `finishSignIn`, then `readApp` with the token it gave: what its server lists to Ember signed in,
   * no tools among it when the app is a connected one, signed in to `again`, with the sign-in to the
   * app at `url` to keep, `kept`, with its tokens, or why either failed.
   */
  async signIn(url: string, signIn: string, code: string, iss: string | undefined, again: boolean): Promise<(ReadApp & { kept: string }) | AppRefused> {
    const signedIn = await finishSignIn(url, JSON.parse(signIn) as SignIn, code, iss);
    if ("error" in signedIn) return signedIn;
    const read = await readApp(url, { token: signedIn.tokens.access, signedIn: true }, again);
    return "error" in read ? read : { ...read, kept: JSON.stringify(signedIn) };
  }

  /**
   * `refreshSignIn`: `signIn` to the app at `url` to keep, `kept`, with another access token, `token`,
   * or "lapsed" once there's no getting one, or "failed" when that couldn't be asked now.
   */
  async refreshSignIn(url: string, signIn: string): Promise<{ kept: string; token: string } | "lapsed" | "failed"> {
    const refreshed = await refreshSignIn(url, JSON.parse(signIn) as SignIn);
    return typeof refreshed === "string" ? refreshed : { kept: JSON.stringify(refreshed), token: refreshed.tokens.access };
  }

  /** `revokeSignIn`: whether the service of the app at `url` took back what `signIn` gave Ember. */
  revokeSignIn(url: string, signIn: string): Promise<boolean> {
    return revokeSignIn(url, JSON.parse(signIn) as SignIn);
  }
}

/** A new object to ask an app in. */
export const appConnector = (env: Env) => env.APP_CONNECTOR.get(env.APP_CONNECTOR.newUniqueId());
