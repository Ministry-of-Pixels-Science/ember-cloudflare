import { HUDDLES_FORBIDDEN, parseHuddleRelaySetup, parseHuddlesSetup, RELAY_WITHOUT_HUDDLES, type HuddlesForgotten, type HuddlesSaved, type HuddlesSettings } from "@ember/protocol/huddles";
import { credentialsOf } from "../auth";
import { jsonBodyOf } from "../bodies";
import type { Env } from "../env";
import { formAnswer } from "../pages";
import { workspace } from "../workspace";
import { refusalOfRelay } from "./relay";
import { refusalOfApp } from "./sfu";

// Huddles' setup, as administrators turn huddles on, change the Realtime SFU app they run through and turn
// them off on the card of workspace settings' Huddles tab, or turn them on as they set Ember up, and as
// they give huddles a relay there, change the TURN key it goes by and take it away. They answer JSON for
// the cards, their dialogs and first run's steps.

const problem = (status: number, message: string) => Response.json({ error: message }, { status });

const NOT_SIGNED_IN = "Not signed in";
/** What's said of huddles' setup is for administrators, which no cache should keep. */
const PRIVATE = { "Cache-Control": "no-store" };

/**
 * `PUT /api/account/huddles`, `{ appId, appSecret }`: turns huddles on, or changes the SFU app they run
 * through, once Cloudflare's Realtime SFU has started a session with the app's keys, answering huddles as
 * they are then. Someone who isn't an administrator hears so before anything they sent is read. A key
 * that can't be one, or that the SFU refuses, is refused on its field.
 */
export async function saveHuddles(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const administrator = credentials && (await workspace(env).canAdminister(credentials));
  if (!credentials || administrator === null) return problem(401, NOT_SIGNED_IN);
  if (!administrator) return problem(403, HUDDLES_FORBIDDEN);
  const app = parseHuddlesSetup(await jsonBodyOf(request));
  if ("error" in app) return formAnswer(app, 422);
  const refusal = await refusalOfApp(env, app);
  if (refusal) return formAnswer({ error: refusal.error, ...(refusal.field && { field: refusal.field }) }, refusal.status);
  return huddlesAnswer(await workspace(env).changeHuddles(credentials, app));
}

/** `DELETE /api/account/huddles`: turns huddles off, as the Huddles card's switch does, which forgets the SFU app's keys. */
export async function forgetHuddles(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return huddlesAnswer(credentials && (await workspace(env).changeHuddles(credentials, null)));
}

/**
 * `PUT /api/account/huddles/relay`, `{ keyId, apiToken }`: gives huddles a relay, or changes the TURN key
 * it goes by, once Cloudflare has made a relay's servers with the key, answering huddles as they are
 * then. Someone who isn't an administrator hears so before anything they sent is read. A key that can't
 * be one, or that Cloudflare refuses, is refused on its field, and one given while huddles are off isn't
 * kept.
 */
export async function saveHuddleRelay(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const administrator = credentials && (await workspace(env).canAdminister(credentials));
  if (!credentials || administrator === null) return problem(401, NOT_SIGNED_IN);
  if (!administrator) return problem(403, HUDDLES_FORBIDDEN);
  const key = parseHuddleRelaySetup(await jsonBodyOf(request));
  if ("error" in key) return formAnswer(key, 422);
  const refusal = await refusalOfRelay(env, key);
  if (refusal) return formAnswer({ error: refusal.error, ...(refusal.field && { field: refusal.field }) }, refusal.status);
  return huddlesAnswer(await workspace(env).changeHuddleRelay(credentials, key));
}

/** `DELETE /api/account/huddles/relay`: takes huddles' relay away, as its card's switch does, which forgets the TURN key. */
export async function forgetHuddleRelay(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return huddlesAnswer(credentials && (await workspace(env).changeHuddleRelay(credentials, null)));
}

/** The answer to changing huddles, or their relay: huddles as they are then, or who can't change them, or that there are none to give a relay. */
function huddlesAnswer(changed: { huddles: HuddlesSettings | null } | "off" | "forbidden" | null): Response {
  if (!changed) return problem(401, NOT_SIGNED_IN);
  if (changed === "forbidden") return problem(403, HUDDLES_FORBIDDEN);
  if (changed === "off") return problem(409, RELAY_WITHOUT_HUDDLES);
  return Response.json(changed satisfies HuddlesSaved | HuddlesForgotten, { headers: PRIVATE });
}
