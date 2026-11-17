import { eachAtMost, PUSHES_AT_ONCE } from "../at-once";
import type { Env } from "../env";
import type { InvitationPush, MessagePush, PushDelivery } from "../workspace-store";
import { endpointErrors } from "./endpoints";
import { webPush, type VapidKeys } from "./keys";
import { encodedPush, type PushPayload } from "./payload";
import { encryptPush, InvalidPushKeyError, PushArgumentError, vapidAuthorization } from "./web-push";

// Sending pushes: each to its subscription's push service, encrypted for its browser and signed with the
// deployment's key, a few at a time, once it's checked again that it may still go. Nothing is retried. A
// subscription whose push service says it's gone, or whose keys no push can be encrypted for, is
// forgotten, and any other failure is logged.

/** Whom push services may contact about this deployment's pushes when VAPID_SUBJECT doesn't say: the project. */
export const DEFAULT_VAPID_SUBJECT = "https://github.com/NYLLON-SOFTWARE/ember-cloudflare";

/** How long a push service keeps a message's push for a browser that's away: four weeks, as the gem's `ttl` has it. */
const TTL_SECONDS = 4 * 7 * 24 * 60 * 60;

/** How long a push may take in all, however slowly its push service answers. */
const DEADLINE_MS = 30_000;

const encoder = new TextEncoder();

/**
 * Sends `pushes`, as long as Web Push is on, and answers the subscriptions to forget: those whose push
 * service said they're gone (404 or 410), and those whose keys no push can be encrypted for. Any other
 * failure is logged. An endpoint that's no longer at a permitted push service is skipped, and so is a
 * subscription `pushable` says may no longer have pushes, or can't say about, asked just before each is
 * sent: a push can wait its turn while its person is banned. A push service keeps an invitation's push
 * as long as the invitation says, and a message's for weeks. `send` stands in for `fetch` in tests.
 */
export async function sendPushes(env: Env, pushes: Array<MessagePush | InvitationPush>, pushable: Pushable, send: typeof fetch = fetch): Promise<number[]> {
  const push = await webPush(env);
  if (!push.on) return [];
  const deliveries = pushes.flatMap((pushed) => {
    const ttl = "ttl" in pushed ? pushed.ttl : TTL_SECONDS;
    return pushed.deliveries.map((delivery) => ({ message: encodedPush(pushed.payload, delivery.badge), delivery, ttl }));
  });
  const gone: number[] = [];
  await eachAtMost(deliveries, PUSHES_AT_ONCE, async ({ message, delivery, ttl }) => {
    if (!(await mayPush(pushable, delivery.subscriptionId))) return;
    try {
      await deliver(message, delivery, ttl, push.keys, subjectOf(env), send);
    } catch (error) {
      if (!(error instanceof PushFailure)) throw error;
      if (error.gone) gone.push(delivery.subscriptionId);
      else console.error(`Error in WebPush::Pool.deliver: ${error.message}`);
    }
  });
  return gone;
}

/**
 * Sends a test push to a subscription at once, and throws if Web Push is off or the push fails, leaving
 * a subscription whose push service says it's gone. An endpoint that's no longer at a permitted push
 * service is skipped, as if it were sent.
 */
export async function sendTestPush(env: Env, payload: PushPayload, delivery: PushDelivery, send: typeof fetch = fetch): Promise<void> {
  const push = await webPush(env);
  if (!push.on) throw new Error("Web Push is off (no valid VAPID keys)");
  await deliver(encodedPush(payload, delivery.badge), delivery, TTL_SECONDS, push.keys, subjectOf(env), send);
}

const subjectOf = (env: Env) => env.VAPID_SUBJECT?.trim() || DEFAULT_VAPID_SUBJECT;

/** Whether a push subscription may still have pushes: still saved, for someone still active. */
export type Pushable = (subscriptionId: number) => Promise<boolean>;

/**
 * Whether `pushable` says subscription `id` may still have pushes, which fails closed: no when it can't
 * say, logging why.
 */
async function mayPush(pushable: Pushable, id: number): Promise<boolean> {
  try {
    return await pushable(id);
  } catch (error) {
    console.warn(`push authorization failed for subscription ${id}: ${error}`);
    return false;
  }
}

/** Why a push failed, as the gem's error class and message name it, and whether its subscription is gone for good. */
class PushFailure extends Error {
  constructor(
    detail: string,
    readonly gone: boolean,
  ) {
    super(detail);
  }
}

/**
 * Sends `message` to a subscription, as the gem's `payload_send` does, for its push service to keep
 * `ttl` seconds for a browser that's away, throwing a `PushFailure` if it fails. An endpoint that's no
 * longer at a permitted push service is skipped.
 */
async function deliver(message: string, { endpoint, p256dhKey, authKey }: PushDelivery, ttl: number, keys: VapidKeys, subject: string, send: typeof fetch): Promise<void> {
  if (endpointErrors(endpoint).length > 0) return;
  const { origin, hostname } = new URL(endpoint);
  let response: Response;
  try {
    const body = await encryptPush(encoder.encode(message), p256dhKey, authKey);
    response = await send(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        TTL: String(ttl),
        Urgency: "high",
        "Content-Encoding": "aes128gcm",
        Authorization: await vapidAuthorization(origin, Math.floor(Date.now() / 1000), keys, subject),
      },
      body,
      // A push service answers a push itself, so a redirect is an answer, as Net::HTTP takes it.
      redirect: "manual",
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    await response.body?.cancel();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof InvalidPushKeyError) throw new PushFailure(`OpenSSL::PKey::EC::Point::Error ${detail}`, true);
    throw new PushFailure(`${classOf(error)} ${detail}`, false);
  }
  const failure = failureOf(response);
  if (failure) throw new PushFailure(`${failure.kind} host: ${hostname}, status: ${response.status}`, failure.gone);
}

/** What the gem's `verify_response` raises for a push service's answer, and whether it means the subscription is gone; null for a push it took. */
function failureOf({ status, statusText }: Response): { kind: string; gone: boolean } | null {
  if (status === 410) return { kind: "WebPush::ExpiredSubscription", gone: true };
  if (status === 404) return { kind: "WebPush::InvalidSubscription", gone: true };
  if (status === 401 || status === 403 || (status === 400 && statusText === "UnauthorizedRegistration")) return { kind: "WebPush::Unauthorized", gone: false };
  if (status === 413) return { kind: "WebPush::PayloadTooLarge", gone: false };
  if (status === 429) return { kind: "WebPush::TooManyRequests", gone: false };
  if (status >= 500 && status <= 599) return { kind: "WebPush::PushServiceError", gone: false };
  if (status >= 200 && status <= 299) return null;
  return { kind: "WebPush::ResponseError", gone: false };
}

/** The Ruby error class Campfire logs for a push that couldn't be sent. */
function classOf(error: unknown): string {
  if (error instanceof PushArgumentError) return "ArgumentError";
  if (error instanceof Error && error.name === "TimeoutError") return "Net::ReadTimeout";
  return "SystemCallError";
}

