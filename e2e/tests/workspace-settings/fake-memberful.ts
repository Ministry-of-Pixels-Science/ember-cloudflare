import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, type APIRequestContext } from "@playwright/test";
import { MEMBERFUL_CALLBACK_PATH, MEMBERFUL_WEBHOOK_PATH } from "@ember/protocol";
import { MEMBERFUL_KEYS, MEMBERFUL_SITE_PORT } from "../../projects/workspace-settings";

// A Memberful site for the Memberful specs, at the address they give Ember in Set up Memberful, with
// what Ember asks of one (apps/worker/src/memberful-api.ts): its sign-in page, which lists its members to
// sign in as and sends the browser back to Ember with a code, as Memberful's OAuth does; its token
// endpoint and member API, which say who signed in; and its admin API, which says whose subscriptions are
// active. Both refuse keys that aren't its custom app's as Memberful does, which Set up Memberful asks
// them about. Its webhooks come from the specs themselves, signed as Memberful signs them.

export interface FakeMember {
  /** Their member id, a number as Memberful's are. */
  id: string;
  fullName: string;
  email: string;
  /** Whether their subscription is active, which a spec changes to have their membership lapse or be renewed. */
  active: boolean;
}

export interface FakeMemberful {
  /** Adds a member called `fullName`, with an email address of their own unless given `email`. */
  add(fullName: string, email?: string): FakeMember;
  close(): Promise<void>;
}

/** Starts the site, which sends people back to the Ember at `ember`, an origin. */
export async function startFakeMemberful(ember: string): Promise<FakeMemberful> {
  const members = new Map<string, FakeMember>();
  const server = createServer((request, response) => {
    answer(request, response, members, ember).catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(MEMBERFUL_SITE_PORT, "127.0.0.1", resolve));
  return {
    add(fullName, email = `${crypto.randomUUID()}@example.com`) {
      const member = { id: String(crypto.getRandomValues(new Uint32Array(1))[0]), fullName, email, active: true };
      members.set(member.id, member);
      return member;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Sends Ember a webhook from the site saying `member`'s subscription changed, signed with the webhook's
 * secret, as Memberful signs one, which has Ember ask the admin API about them.
 */
export async function sendWebhook(request: APIRequestContext, member: FakeMember): Promise<void> {
  // Memberful's ids are numbers in its webhooks.
  const body = JSON.stringify({ event: "subscription.updated", subscription: { member: { id: Number(member.id) } } });
  const signature = createHmac("sha256", MEMBERFUL_KEYS.webhookSecret).update(body).digest("hex");
  const response = await request.post(MEMBERFUL_WEBHOOK_PATH, { data: body, headers: { "Content-Type": "application/json", "X-Memberful-Webhook-Signature": signature } });
  expect(response.status(), await response.text()).toBe(204);
}

async function answer(request: IncomingMessage, response: ServerResponse, members: Map<string, FakeMember>, ember: string): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const bearer = request.headers.authorization?.replace(/^Bearer /, "");
  const json = (status: number, body: unknown) => void response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const membershipOf = ({ active }: FakeMember) => ({ unrestrictedAccess: false, subscriptions: [{ active }] });

  if (request.method === "GET" && url.pathname === "/oauth") {
    const state = url.searchParams.get("state") ?? "";
    if (url.searchParams.get("client_id") !== MEMBERFUL_KEYS.clientId || url.searchParams.get("response_type") !== "code") return void response.writeHead(400).end();
    const links = [...members.values()].map((member) => {
      const callback = new URL(MEMBERFUL_CALLBACK_PATH, ember);
      callback.search = new URLSearchParams({ code: `code-${member.id}`, state }).toString();
      return `<li><a href="${escaped(callback.href)}">Sign in as ${escaped(member.fullName)}</a></li>`;
    });
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return void response.end(`<!doctype html><title>Sign in</title><h1>Sign in</h1><ul>${links.join("")}</ul>`);
  }
  if (request.method === "POST" && url.pathname === "/oauth/token") {
    const form = new URLSearchParams(await bodyOf(request));
    // An app it doesn't know, or the wrong secret for one, as OAuth says, whatever the code.
    if (form.get("client_id") !== MEMBERFUL_KEYS.clientId || form.get("client_secret") !== MEMBERFUL_KEYS.clientSecret) return json(401, { error: "invalid_client" });
    const member = members.get(form.get("code")?.replace(/^code-/, "") ?? "");
    if (form.get("grant_type") !== "authorization_code" || !member) return json(400, { error: "invalid_grant" });
    return json(200, { access_token: `token-${member.id}`, token_type: "bearer", expires_in: 899, refresh_token: `refresh-${member.id}` });
  }
  if (request.method === "GET" && url.pathname === "/api/graphql/member") {
    const member = members.get(bearer?.replace(/^token-/, "") ?? "");
    if (!member) return json(401, { error: "unauthorized" });
    return json(200, { data: { currentMember: { id: member.id, email: member.email, fullName: member.fullName, ...membershipOf(member) } } });
  }
  if (request.method === "POST" && url.pathname === "/api/graphql") {
    // Memberful's GraphQL API answers 200 whatever's wrong, saying what in its errors.
    if (bearer !== MEMBERFUL_KEYS.apiKey) return json(200, { errors: [{ message: "Invalid authentication token." }] });
    const { query } = JSON.parse(await bodyOf(request)) as { query: string };
    // The first page of members, which Set up Memberful tries the API key with.
    if (/\bmembers\(first: 1\)/.test(query)) return json(200, { data: { members: { pageInfo: { hasNextPage: members.size > 1 } } } });
    // Each member asked about by an alias of its own, as Ember asks, its id a JSON string.
    const data: Record<string, unknown> = {};
    for (const [, alias, id] of query.matchAll(/(m\d+): member\(id: ("(?:[^"\\]|\\.)*")\)/g)) {
      const member = members.get(JSON.parse(id!) as string);
      data[alias!] = member ? membershipOf(member) : null;
    }
    return json(200, { data });
  }
  response.writeHead(404).end();
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
