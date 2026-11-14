import { DurableObject } from "cloudflare:workers";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { VERSION } from "../version";
import type { OutsideAccess } from "../workspace";
import { registerTools } from "./tools";

// Where an AI app connected to Ember asks it, over the Model Context Protocol, as the person who
// connected it: a server with the tools its connection allows (`./tools`), and nothing else.

/** What Ember tells an app of itself, which the app's model reads. */
const INSTRUCTIONS =
  "Ember is a team's chat: rooms that are open to everyone or private, and direct messages. This server acts as the person who connected it, and sees only what they can see. list_rooms gives the ids of their rooms, read_room reads a room's messages from the newest back, read_thread reads a thread's, and search_messages finds messages by their words across them all. send_message, when it's among the tools, sends a message as them, which everyone in the room sees as theirs, so send only what they ask for.";

/** The server an app with `access` talks to, with the tools its connection allows. */
function serverFor(env: Env, access: OutsideAccess): McpServer {
  const server = new McpServer({ name: "ember", title: "Ember", version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, env, access);
  return server;
}

/**
 * Answers the AI apps connected to Ember where there's CPU time for it: reading a request and checking
 * what it carries against the protocol's schemas takes more than the 10 ms a Worker's request gets on
 * Workers Free, where a Durable Object's gets 30 seconds. It keeps nothing, so each request is answered
 * by a new object of its own, as a connected app is asked by one (`AppConnector`). The Worker has
 * checked the request's token by then: `access` is what it lets the app do.
 */
export class OutsideAi extends DurableObject<Env> {
  async answer(request: Request, access: OutsideAccess): Promise<Response> {
    // No streams stay open: each request is answered and done with, so an object lives no longer than its answer.
    const handler = createMcpHandler(() => serverFor(this.env, access), { maxSubscriptions: 0, keepAliveMs: 0, onerror: logged });
    const response = await handler.fetch(request);
    return new Response(await response.arrayBuffer(), response);
  }
}

/** Logs that answering an app failed, by the kind of failure alone, as what an app sends isn't Ember's to write down. */
function logged(error: Error): void {
  console.error(`Answering an AI app failed: ${error.name}`);
}

/** A new object to answer an AI app in. */
export const outsideAi = (env: Env) => env.OUTSIDE_AI.get(env.OUTSIDE_AI.newUniqueId());
