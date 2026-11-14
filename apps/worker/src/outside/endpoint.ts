import { DurableObject } from "cloudflare:workers";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import type { SidebarRoom, UserId } from "@ember/protocol";
import type { Env } from "../env";
import { VERSION } from "../version";
import { workspace, type OutsideAccess } from "../workspace";

// What an AI app connected to Ember can ask of it, over the Model Context Protocol, as the person who
// connected it: tools that read what that person can, and nothing else.

/** What Ember tells an app of itself, which the app's model reads. */
const INSTRUCTIONS =
  "Ember is a team's chat: rooms that are open to everyone or private, and direct messages. This server acts as the person who connected it, and sees only what they can see.";

/** A room as an app is told of it: a direct message goes by the names of the others in it. */
interface ListedRoom {
  id: string;
  kind: SidebarRoom["kind"];
  name: string;
  unread: boolean;
}

function listedRoom(room: SidebarRoom, userId: UserId): ListedRoom {
  if (room.kind !== "direct") return { id: room.id, kind: room.kind, name: room.name, unread: room.unread };
  const others = room.members.filter(({ id }) => id !== userId);
  return { id: room.id, kind: room.kind, name: (others.length > 0 ? others : room.members).map(({ name }) => name).join(", "), unread: room.unread };
}

const NO_INPUT = { type: "object" as const, properties: {}, additionalProperties: false };

/** The server an app with `access` talks to: its tools, each doing what the connection allows as its person. */
function serverFor(env: Env, access: OutsideAccess): McpServer {
  const server = new McpServer({ name: "ember", title: "Ember", version: VERSION }, { instructions: INSTRUCTIONS });
  if (!access.scopes.includes("read")) return server;
  server.registerTool(
    "list_rooms",
    {
      title: "List rooms",
      description:
        "Lists the rooms the connected person is in: each one's id, its name, its kind (open to everyone, closed, which is private, or direct, a direct message named after the others in it), and whether it has messages they haven't read.",
      inputSchema: fromJsonSchema(NO_INPUT),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const rooms = (await workspace(env).outsideRooms(access.userId)).map((room) => listedRoom(room, access.userId));
      return { content: [{ type: "text", text: JSON.stringify({ rooms }) }] };
    },
  );
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
