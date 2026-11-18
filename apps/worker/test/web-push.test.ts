import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toBase64url, urlsafeDecode64 } from "../src/encoding";
import type { Env } from "../src/env";
import { DEFAULT_VAPID_SUBJECT, sendPushes } from "../src/push/delivery";
import { webPush, type VapidKeys } from "../src/push/keys";
import { encodedPush, INVITATION_TTL_SECONDS, invitationPayload, MAX_BODY_BYTES, MAX_TITLE_BYTES, messagePayload, type PushPayload } from "../src/push/payload";
import { encryptPush, InvalidPushKeyError, PushArgumentError, vapidAuthorization } from "../src/push/web-push";
import type { InvitationPush, MessagePush } from "../src/workspace-store";
import recorded from "./fixtures/web_push_expected.json";
import { gemMessage, pushBrowser } from "./support";

// A push as the web-push gem writes, encrypts, signs and sends it, checked against what the gem recorded
// (fixtures/README.md).

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (base64: string) => urlsafeDecode64(base64)!;

/** RFC 8291's example (section 5, and its appendix A), whose keys and salt make it exact. */
const RFC_8291 = {
  serverPrivateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  browserPublicKey: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  browserPrivateKey: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** A P-256 key pair from its private key's scalar and its public key's point, both in URL-safe Base64. */
async function keyPairOf(privateKey: string, publicKey: string, usages: string[]): Promise<CryptoKeyPair> {
  const point = bytes(publicKey);
  const jwk = { kty: "EC", crv: "P-256", x: toBase64url(point.subarray(1, 33)), y: toBase64url(point.subarray(33)), ext: true };
  return {
    privateKey: await crypto.subtle.importKey("jwk", { ...jwk, d: toBase64url(bytes(privateKey)) }, ECDH, true, usages),
    publicKey: await crypto.subtle.importKey("raw", point, ECDH, true, []),
  };
}

/** The browser that the gem's recorded push is for. */
const recordedBrowser = async () =>
  pushBrowser({ privateKey: (await keyPairOf(recorded.receiver_private_key, recorded.p256dh, ["deriveBits"])).privateKey, p256dh: recorded.p256dh, auth: recorded.auth });

/** The bytes `text` takes in a JSON string, between its quotes. */
const jsonBytes = (text: string) => encoder.encode(JSON.stringify(text)).length - 2;

/** The keys this suite's Worker signs pushes with: the test keys the push was recorded with. */
async function keys(): Promise<VapidKeys> {
  const push = await webPush(env as unknown as Env);
  if (!push.on) throw new Error(`Web Push is off: ${push.reason}`);
  return push.keys;
}

/** The claims in an `Authorization` header's token, and whether the deployment's key signed it. */
async function claimsOf(authorization: string) {
  const [, token, k] = /^vapid t=([^,]+),k=(.+)$/.exec(authorization)!;
  const [header, payload, signature] = token!.split(".") as [string, string, string];
  const publicKey = await crypto.subtle.importKey("raw", bytes(k!), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, bytes(signature), encoder.encode(`${header}.${payload}`));
  return { header, payload, k, signed, claims: JSON.parse(decoder.decode(bytes(payload))) as { aud: string; exp: number; sub: string } };
}

afterEach(() => vi.restoreAllMocks());

describe("What a push says", () => {
  it("writes a push's JSON as Rails does, which the service worker shows as it is", () => {
    const payload = { title: 'Designers <&> "quotes" é 😀', body: "Kevin: line\nbreak\ttab \u2028 \u001f / \\ ", path: "/rooms/1" };
    expect(encodedPush(payload, 3)).toBe(recorded.message);
  });

  it("reads the gem's own push as the browser it's for does, a record of its ciphertext's length padded with a delimiter and a zero", async () => {
    const ciphertext = bytes(recorded.ciphertext);
    const { recordSize, ciphertextLength, plaintext } = await (await recordedBrowser()).read(ciphertext);
    expect(recordSize).toBe(ciphertextLength);
    expect(gemMessage(plaintext)).toBe(recorded.message);
  });

  it("encrypts a push for a browser's keys as the gem does, with a fresh key and salt each time", async () => {
    const receiver = await recordedBrowser();
    const [first, second] = await Promise.all([1, 2].map(() => encryptPush(encoder.encode(recorded.message), recorded.p256dh, recorded.auth)));
    const length = recorded.headers.find(([name]) => name === "Content-Length")![1];
    expect(first!.length).toBe(Number(length));
    const { recordSize, ciphertextLength, serverPublic, plaintext } = await receiver.read(first!);
    expect(recordSize).toBe(ciphertextLength);
    expect(gemMessage(plaintext)).toBe(recorded.message);
    expect(first!.subarray(0, 16)).not.toEqual(second!.subarray(0, 16));
    expect(serverPublic).not.toEqual((await receiver.read(second!)).serverPublic);
  });

  it("encrypts RFC 8291's example exactly as the RFC does, given its key and salt", async () => {
    const message = bytes(RFC_8291.message);
    const serverKeys = await keyPairOf(RFC_8291.serverPrivateKey, toBase64url(message.subarray(21, 86)), ["deriveBits"]);
    const framing = { recordSize: 4096, padding: Uint8Array.of(2), serverKeys, salt: bytes(RFC_8291.salt) };
    const encrypted = await encryptPush(bytes(RFC_8291.plaintext), RFC_8291.browserPublicKey, RFC_8291.auth, framing);
    expect(toBase64url(encrypted)).toBe(RFC_8291.message);

    const receiver = await keyPairOf(RFC_8291.browserPrivateKey, RFC_8291.browserPublicKey, ["deriveBits"]);
    const { recordSize, plaintext } = await (await pushBrowser({ privateKey: receiver.privateKey, p256dh: RFC_8291.browserPublicKey, auth: RFC_8291.auth })).read(encrypted);
    expect(recordSize).toBe(4096);
    expect(toBase64url(plaintext)).toBe(toBase64url(Uint8Array.from([...bytes(RFC_8291.plaintext), 2])));
  });

  it("fits the longest push it writes into the one record a push service takes", async () => {
    const receiver = await pushBrowser();
    const payload: PushPayload = { title: '"'.repeat(MAX_TITLE_BYTES / 2), body: "\u0001".repeat(MAX_BODY_BYTES / 6), path: `/rooms/${"r".repeat(64)}` };
    const message = encodedPush(payload, Number.MIN_SAFE_INTEGER);
    const { plaintext } = await receiver.read(await encryptPush(encoder.encode(message), receiver.p256dh, receiver.auth));
    expect(gemMessage(plaintext)).toBe(message);
  });

  it("refuses what the gem refuses: a blank push or key, a key that isn't Base64, and a push too big for a record", async () => {
    const { p256dh, auth } = await pushBrowser();
    const push = encoder.encode("{}");
    await expect(encryptPush(new Uint8Array(), p256dh, auth)).rejects.toThrow(new PushArgumentError("message cannot be blank"));
    await expect(encryptPush(push, "", auth)).rejects.toThrow(new PushArgumentError("p256dh cannot be blank"));
    await expect(encryptPush(push, p256dh, "")).rejects.toThrow(new PushArgumentError("auth cannot be blank"));
    await expect(encryptPush(push, "not base64!", auth)).rejects.toThrow(new PushArgumentError("invalid base64"));
    await expect(encryptPush(new Uint8Array(4096 - 18 + 1), p256dh, auth)).rejects.toThrow(new PushArgumentError("encrypted payload is too big"));
    await expect(encryptPush(new Uint8Array(4096 - 18), p256dh, auth)).resolves.toHaveLength(4096 + 86);
    // A key that isn't a point on the curve, can never be pushed to.
    await expect(encryptPush(push, "dGVzdF9rZXk", auth)).rejects.toBeInstanceOf(InvalidPushKeyError);
  });

  it("titles a room's push with the room's name and a DM's with its sender's, opening the room", () => {
    expect(messagePayload("designers", { kind: "open", name: "Designers" }, "David", "Hi")).toEqual({ title: "Designers", body: "David: Hi", path: "/rooms/designers" });
    expect(messagePayload("closed", { kind: "closed", name: "Board" }, "David", "")).toEqual({ title: "Board", body: "David: ", path: "/rooms/closed" });
    expect(messagePayload("dm", { kind: "direct", name: null }, "David", "Hi")).toEqual({ title: "David", body: "Hi", path: "/rooms/dm" });
  });

  it("titles an invitation's push with whoever invites, and says which room's huddle it's into unless it's a DM's, opening the room", () => {
    expect(invitationPayload("launch", { kind: "closed", name: "Launch" }, "David")).toEqual({ title: "David", body: "Invites you to a huddle in Launch", path: "/rooms/launch" });
    expect(invitationPayload("designers", { kind: "open", name: "Designers" }, "David")).toEqual({ title: "David", body: "Invites you to a huddle in Designers", path: "/rooms/designers" });
    expect(invitationPayload("dm", { kind: "direct", name: null }, "David")).toEqual({ title: "David", body: "Invites you to a huddle", path: "/rooms/dm" });
    // Cut short as a message's push is, should a name be too long for it.
    expect(invitationPayload("dm", { kind: "direct", name: null }, "x".repeat(MAX_TITLE_BYTES + 1)).title).toBe(`${"x".repeat(MAX_TITLE_BYTES - 3)}…`);
    expect(invitationPayload("launch", { kind: "closed", name: "é".repeat(2000) }, "David").body).toBe(`Invites you to a huddle in ${"é".repeat(1521)}…`);
  });

  it("cuts a long title at 256 bytes and text at 3,072, as escaped JSON, between characters, with an ellipsis that fits", () => {
    const room = (name: string) => messagePayload("designers", { kind: "open", name }, "David", "");
    // Two-byte characters, a quote that escapes to two, then one-byte ones.
    const { body } = messagePayload("designers", { kind: "open", name: "Designers" }, "David", `${"é".repeat(1000)}"${"x".repeat(2000)}`);
    expect(body).toBe(`David: ${"é".repeat(1000)}"${"x".repeat(MAX_BODY_BYTES - 7 - 2000 - 2 - 3)}…`);
    expect(jsonBytes(body)).toBe(MAX_BODY_BYTES);

    expect(room("x".repeat(MAX_TITLE_BYTES)).title).toBe("x".repeat(MAX_TITLE_BYTES));
    expect(room("x".repeat(MAX_TITLE_BYTES + 1)).title).toBe(`${"x".repeat(MAX_TITLE_BYTES - 3)}…`);
    expect(room("é".repeat(200)).title).toBe(`${"é".repeat(126)}…`);
    expect(room('"'.repeat(200)).title).toBe(`${'"'.repeat(126)}…`);
    // An emoji's two halves stay together; a half on its own is escaped, as JSON.stringify writes it.
    expect(room("😀".repeat(100)).title).toBe(`${"😀".repeat(63)}…`);
    expect(room("\ud83d".repeat(100)).title).toBe(`${"\ud83d".repeat(42)}…`);
    expect(room("\u001f".repeat(100)).title).toBe(`${"\u001f".repeat(42)}…`);
    for (const name of ["é".repeat(200), "😀".repeat(100), "\ud83d".repeat(100)]) expect(jsonBytes(room(name).title)).toBeLessThanOrEqual(MAX_TITLE_BYTES);
  });
});

describe("Web Push configuration", () => {
  it("signs a push for its push service as the gem does, with the deployment's key, for 12 hours", async () => {
    const authorization = await vapidAuthorization("https://fcm.googleapis.com", recorded.now, await keys(), recorded.vapid_subject);
    const { header, payload, k, signed, claims } = await claimsOf(authorization);
    expect([header, payload, k]).toEqual([recorded.jwt_header_segment, recorded.jwt_payload_segment, recorded.authorization_k]);
    expect(signed).toBe(true);
    expect(claims).toEqual({ aud: "https://fcm.googleapis.com", exp: recorded.now + 12 * 60 * 60, sub: recorded.vapid_subject });
  });
});

/** A push service's answer to each push, as `fetch` gives it, and what it was sent. */
function pushService(answer: (endpoint: string) => Response | Promise<Response> = () => new Response(null, { status: 201, statusText: "Created" })) {
  const send = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => answer(String(input)));
  return { send: send as unknown as typeof fetch, sent: send.mock.calls as Array<[string, RequestInit]> };
}

/** A message's push to `deliveries`, each an endpoint and the browser at it. */
function messagePush(payload: PushPayload, ...deliveries: Array<[string, { p256dh: string; auth: string }, number?]>): MessagePush {
  return {
    payload,
    deliveries: deliveries.map(([endpoint, { p256dh, auth }, badge = 0], index) => ({ subscriptionId: index + 1, endpoint, p256dhKey: p256dh, authKey: auth, badge })),
  };
}

const PAYLOAD: PushPayload = { title: "Designers", body: "David: Hi", path: "/rooms/designers" };
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
const pushEnv = (changes: Partial<Env> = {}) => ({ ...(env as unknown as Env), ...changes });

/** Says every subscription may still have pushes. */
const anyone = async () => true;

describe("Who gets a push", () => {
  it("sends each push to its subscription's push service as the gem does: encrypted for its browser, signed, urgent, kept for four weeks", async () => {
    const receiver = await pushBrowser();
    const { send, sent } = pushService();
    expect(await sendPushes(pushEnv(), [messagePush(PAYLOAD, [ENDPOINT, receiver, 4])], anyone, send)).toEqual([]);

    expect(sent).toHaveLength(1);
    const [[endpoint, init]] = sent as [[string, RequestInit]];
    expect(endpoint).toBe(ENDPOINT);
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const { Authorization: authorization, ...headers } = init.headers as Record<string, string>;
    expect(headers).toEqual({ "Content-Type": "application/octet-stream", TTL: "2419200", Urgency: "high", "Content-Encoding": "aes128gcm" });
    const { plaintext } = await receiver.read(init.body as Uint8Array);
    expect(JSON.parse(gemMessage(plaintext))).toEqual({ title: "Designers", options: { body: "David: Hi", icon: "/account/logo", data: { path: "/rooms/designers", badge: 4 } } });

    const { signed, k, claims } = await claimsOf(authorization!);
    expect(signed).toBe(true);
    expect(k).toBe((await keys()).publicKey);
    expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: DEFAULT_VAPID_SUBJECT });
    expect(claims.exp - Date.now() / 1000).toBeGreaterThan(12 * 60 * 60 - 60);
  });

  it("has a push service keep an invitation's push as long as the invitation says, a minute, beside a message's four weeks, and as urgent", async () => {
    const receiver = await pushBrowser();
    const { send, sent } = pushService();
    const invitation: InvitationPush = { ...messagePush(invitationPayload("dm", { kind: "direct", name: null }, "David"), ["https://fcm.googleapis.com/fcm/send/invitation", receiver, 2]), ttl: INVITATION_TTL_SECONDS };
    expect(await sendPushes(pushEnv(), [messagePush(PAYLOAD, ["https://fcm.googleapis.com/fcm/send/message", receiver]), invitation], anyone, send)).toEqual([]);

    const headersTo = (label: string) => {
      const { Authorization: _, ...headers } = sent.find(([endpoint]) => endpoint.endsWith(`/${label}`))![1].headers as Record<string, string>;
      return headers;
    };
    expect(headersTo("message")).toEqual({ "Content-Type": "application/octet-stream", TTL: "2419200", Urgency: "high", "Content-Encoding": "aes128gcm" });
    expect(headersTo("invitation")).toEqual({ "Content-Type": "application/octet-stream", TTL: "60", Urgency: "high", "Content-Encoding": "aes128gcm" });
    const { plaintext } = await receiver.read(sent.find(([endpoint]) => endpoint.endsWith("/invitation"))![1].body as Uint8Array);
    expect(JSON.parse(gemMessage(plaintext))).toEqual({ title: "David", options: { body: "Invites you to a huddle", icon: "/account/logo", data: { path: "/rooms/dm", badge: 2 } } });
  });

  it("names VAPID_SUBJECT as whom the push service may contact, when it's set", async () => {
    const { send, sent } = pushService();
    await sendPushes(pushEnv({ VAPID_SUBJECT: " mailto:ops@example.com " }), [messagePush(PAYLOAD, [ENDPOINT, await pushBrowser()])], anyone, send);
    const { claims } = await claimsOf((sent[0]![1].headers as Record<string, string>).Authorization!);
    expect(claims.sub).toBe("mailto:ops@example.com");
  });

  it("answers the subscriptions to forget: those their push service says are gone, and those whose keys no push can be encrypted for", async () => {
    const receiver = await pushBrowser();
    const statuses: Record<string, [number, string]> = { "/fcm/send/1": [410, "Gone"], "/fcm/send/2": [404, "Not Found"], "/fcm/send/3": [201, "Created"] };
    const { send, sent } = pushService((endpoint) => {
      const [status, statusText] = statuses[new URL(endpoint).pathname]!;
      return new Response(null, { status, statusText });
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const push = messagePush(
      PAYLOAD,
      ["https://fcm.googleapis.com/fcm/send/1", receiver],
      ["https://fcm.googleapis.com/fcm/send/2", receiver],
      ["https://fcm.googleapis.com/fcm/send/3", receiver],
      ["https://fcm.googleapis.com/fcm/send/4", { p256dh: "dGVzdF9rZXk", auth: "dGVzdF9hdXRo" }],
    );
    expect((await sendPushes(pushEnv(), [push], anyone, send)).sort()).toEqual([1, 2, 4]);
    expect(sent.map(([endpoint]) => new URL(endpoint).pathname).sort()).toEqual(["/fcm/send/1", "/fcm/send/2", "/fcm/send/3"]);
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps a subscription whose push failed otherwise, logging what Campfire logs, and tries nothing again", async () => {
    const receiver = await pushBrowser();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const answers: Array<[number, string, string]> = [
      [403, "Forbidden", "WebPush::Unauthorized"],
      [401, "Unauthorized", "WebPush::Unauthorized"],
      [400, "UnauthorizedRegistration", "WebPush::Unauthorized"],
      [400, "Bad Request", "WebPush::ResponseError"],
      [413, "Payload Too Large", "WebPush::PayloadTooLarge"],
      [429, "Too Many Requests", "WebPush::TooManyRequests"],
      [503, "Service Unavailable", "WebPush::PushServiceError"],
      [302, "Found", "WebPush::ResponseError"],
    ];
    for (const [status, statusText, kind] of answers) {
      const { send, sent } = pushService(() => new Response(null, { status, statusText }));
      expect(await sendPushes(pushEnv(), [messagePush(PAYLOAD, [ENDPOINT, receiver])], anyone, send)).toEqual([]);
      expect(sent).toHaveLength(1);
      expect(log).toHaveBeenLastCalledWith(`Error in WebPush::Pool.deliver: ${kind} host: fcm.googleapis.com, status: ${status}`);
    }

    const failing = (error: Error) => pushService(() => Promise.reject(error)).send;
    await sendPushes(pushEnv(), [messagePush(PAYLOAD, [ENDPOINT, receiver])], anyone, failing(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
    expect(log).toHaveBeenLastCalledWith("Error in WebPush::Pool.deliver: Net::ReadTimeout The operation was aborted due to timeout");
    await sendPushes(pushEnv(), [messagePush(PAYLOAD, [ENDPOINT, receiver])], anyone, failing(new TypeError("Network connection lost.")));
    expect(log).toHaveBeenLastCalledWith("Error in WebPush::Pool.deliver: SystemCallError Network connection lost.");
    const { send } = pushService();
    expect(await sendPushes(pushEnv(), [messagePush(PAYLOAD, [ENDPOINT, { p256dh: "", auth: receiver.auth }])], anyone, send)).toEqual([]);
    expect(log).toHaveBeenLastCalledWith("Error in WebPush::Pool.deliver: ArgumentError p256dh cannot be blank");
  });

  it("skips a subscription whose endpoint pushes may no longer go to", async () => {
    const { send, sent } = pushService();
    const receiver = await pushBrowser();
    const endpoints = ["https://attacker.example.com/collect", "https://fcm.googleapis.com:22/fcm/send/abc", "http://fcm.googleapis.com/fcm/send/abc", "https://evilfcm.googleapis.com.attacker.example/webhook"];
    expect(await sendPushes(pushEnv(), [messagePush(PAYLOAD, ...endpoints.map((endpoint) => [endpoint, receiver] as [string, typeof receiver]))], anyone, send)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("asks whether each subscription may still have its push as its turn comes, sending none it's told no or can't be told about, and forgetting neither", async () => {
    const receiver = await pushBrowser();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { send, sent } = pushService(async () => {
      await held;
      return new Response(null, { status: 201 });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const banned = new Set<number>();
    const asked: number[] = [];
    const pushable = async (id: number) => {
      asked.push(id);
      if (id === 8) throw new Error("The database's answer was lost");
      return !banned.has(id);
    };
    const deliveries = Array.from({ length: 8 }, (_, i): [string, typeof receiver] => [`https://fcm.googleapis.com/fcm/send/${i + 1}`, receiver]);

    const sending = sendPushes(pushEnv(), [messagePush(PAYLOAD, ...deliveries)], pushable, send);
    await vi.waitFor(() => expect(sent).toHaveLength(6));
    expect(asked).toEqual([1, 2, 3, 4, 5, 6]);
    banned.add(7);
    release();
    expect(await sending).toEqual([]);
    expect(asked).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sent.map(([endpoint]) => new URL(endpoint).pathname)).toEqual([1, 2, 3, 4, 5, 6].map((i) => `/fcm/send/${i}`));
    expect(warn).toHaveBeenCalledExactlyOnceWith("push authorization failed for subscription 8: Error: The database's answer was lost");
  });

  it("sends six pushes at a time, as many as a Worker has connections", async () => {
    const receiver = await pushBrowser();
    let sending = 0;
    let most = 0;
    const { send, sent } = pushService(async () => {
      most = Math.max(most, ++sending);
      await new Promise((resolve) => setTimeout(resolve, 5));
      sending--;
      return new Response(null, { status: 201 });
    });
    const deliveries = Array.from({ length: 15 }, (_, i): [string, typeof receiver] => [`https://fcm.googleapis.com/fcm/send/${i}`, receiver]);
    await sendPushes(pushEnv(), [messagePush(PAYLOAD, ...deliveries.slice(0, 8)), messagePush(PAYLOAD, ...deliveries.slice(8))], anyone, send);
    expect(sent).toHaveLength(15);
    expect(most).toBe(6);
  });

  it("sends nothing while Web Push is off", async () => {
    const { send, sent } = pushService();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await sendPushes(pushEnv({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined }), [messagePush(PAYLOAD, [ENDPOINT, await pushBrowser()])], anyone, send)).toEqual([]);
    expect(sent).toEqual([]);
  });
});
