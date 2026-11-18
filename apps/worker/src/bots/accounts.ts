import { NAME_RESERVED, type UserId } from "@ember/protocol";
import { agentsName } from "@ember/protocol/agents";
import { BOTS_FORBIDDEN, parseBotChanges, parseNewBot, WEBHOOK_URL_REFUSED, type BotAnswer, type Bots, type BotSettings } from "@ember/protocol/bots";
import { credentialsOf } from "../auth";
import { userFormOf, userFormPhoto } from "../avatars";
import type { Env } from "../env";
import { notFound } from "../error-pages";
import { anyOtherPage } from "../pages";
import { workspace } from "../workspace";
import { isWebhookUrl } from "./webhooks";

// Chat bots, as administrators add, change and delete them. They answer JSON for the app's pages.

const problem = (status: number, message: string) => Response.json({ error: message }, { status });

const NOT_SIGNED_IN = "Not signed in";
/** Keys are secrets, which no cache should keep. */
const PRIVATE = { "Cache-Control": "no-store" };

/** `GET /api/account/bots`: the active bots, by name, each with its key and its rooms, as Campfire's bots page lists them (`index`). */
export async function listBots(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const bots = credentials && (await workspace(env).bots(credentials));
  if (!bots) return problem(401, NOT_SIGNED_IN);
  if (bots === "forbidden") return problem(403, BOTS_FORBIDDEN);
  return Response.json({ bots } satisfies Bots, { headers: PRIVATE });
}

/**
 * A bot's settings page, `/account/bots/<id>/edit`: Campfire's 404 page for an administrator when `id`
 * isn't an active bot's, and otherwise the app's page, which sends anyone signed out to sign in, and
 * anyone else to workspace settings.
 */
export async function botPage(request: Request, env: Env, pathname: string, botId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const found = credentials && (await workspace(env).bot(credentials, botId));
  return found === "not found" ? notFound(request) : anyOtherPage(request, env, pathname);
}

/**
 * `POST /api/account/bots`, `{ name, webhookUrl, rooms }`: adds a bot, answering 201 with the bot as its
 * edit page shows it. With an avatar, it's a form whose `user` part is that JSON and whose `avatar` and
 * `variant` parts are the picture, as the setup and join forms send a photo. Someone who isn't an
 * administrator hears so before anything they sent is read.
 */
export async function createBot(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, NOT_SIGNED_IN);
  const administrator = await workspace(env).canAdminister(credentials);
  if (administrator === null) return problem(401, NOT_SIGNED_IN);
  if (!administrator) return problem(403, BOTS_FORBIDDEN);
  const sent = await userFormOf(request);
  if ("error" in sent) return problem(sent.status, sent.error);
  const bot = withWebAddress(parseNewBot(sent.fields));
  if (typeof bot === "string") return problem(422, bot);
  const avatar = await userFormPhoto(env, sent.photo);
  if (avatar && "error" in avatar) return problem(avatar.status, avatar.error);
  const created = await workspace(env).createBot(credentials, bot, avatar);
  if (!created) return problem(401, NOT_SIGNED_IN);
  if (created === "forbidden") return problem(403, BOTS_FORBIDDEN);
  if (created === "agent's name") return problem(422, agentsName(bot.name));
  return Response.json({ bot: created } satisfies BotAnswer, { status: 201, headers: PRIVATE });
}

/** `GET /api/account/bots/:id`: the active bot `id`, as its edit page shows it (`edit`). */
export async function showBot(request: Request, env: Env, botId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return botAnswer(credentials && (await workspace(env).bot(credentials, botId)));
}

/**
 * `PATCH /api/account/bots/:id`, `{ name, webhookUrl, rooms }`: changes the active bot `id`, answering it
 * as its edit page then shows it, with a new avatar as `createBot` takes one. As there, someone who isn't
 * an administrator hears so first, then a bot that isn't active isn't found, before anything that was
 * sent is read.
 */
export async function changeBot(request: Request, env: Env, botId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, NOT_SIGNED_IN);
  const found = await workspace(env).bot(credentials, botId);
  if (!found || typeof found === "string") return botAnswer(found);
  const sent = await userFormOf(request);
  if ("error" in sent) return problem(sent.status, sent.error);
  const changes = withWebAddress(parseBotChanges(sent.fields));
  if (typeof changes === "string") return problem(422, changes);
  const avatar = await userFormPhoto(env, sent.photo);
  if (avatar && "error" in avatar) return problem(avatar.status, avatar.error);
  const changed = await workspace(env).changeBot(credentials, botId, changes, avatar);
  return changed === "agent's name" ? problem(422, agentsName(changes.name!)) : botAnswer(changed);
}

/**
 * `DELETE /api/account/bots/:id`: deletes the active bot `id`, which deactivates it, answering 204.
 */
export async function deleteBot(request: Request, env: Env, botId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const deleted = credentials && (await workspace(env).deleteBot(credentials, botId));
  if (!deleted) return problem(401, NOT_SIGNED_IN);
  if (deleted === "forbidden") return problem(403, BOTS_FORBIDDEN);
  if (deleted === "not found") return problem(404, "Not found");
  return new Response(null, { status: 204 });
}

/** `PUT /api/account/bots/:id/key`: gives the active bot `id` a new key, answering the bot with it. */
export async function resetBotKey(request: Request, env: Env, botId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return botAnswer(credentials && (await workspace(env).resetBotKey(credentials, botId)));
}

function botAnswer(bot: BotSettings | "forbidden" | "not found" | "name reserved" | null): Response {
  if (!bot) return problem(401, NOT_SIGNED_IN);
  if (bot === "forbidden") return problem(403, BOTS_FORBIDDEN);
  if (bot === "not found") return problem(404, "Not found");
  if (bot === "name reserved") return problem(422, NAME_RESERVED);
  return Response.json({ bot } satisfies BotAnswer, { headers: PRIVATE });
}

/**
 * Refuses a webhook URL that a webhook may not be delivered to (`isWebhookUrl`), anything but an https
 * URL with a host or an http one on localhost.
 */
function withWebAddress<T extends { webhookUrl?: string }>(changes: T | string): T | string {
  if (typeof changes === "string" || !changes.webhookUrl) return changes;
  const url = URL.parse(changes.webhookUrl);
  return url && isWebhookUrl(url) ? changes : WEBHOOK_URL_REFUSED;
}
