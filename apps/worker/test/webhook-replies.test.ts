import { MAX_MESSAGE_HTML_LENGTH } from "@ember/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentTypeOf, replyFileOf } from "../src/bots/mime";
import { DELIVERY_DEADLINE_MS, MAX_FILE_REPLY_BYTES, postClick, postWebhook, WebhookError, type Delivered, type Keep, type Timeouts } from "../src/bots/webhooks";
import recorded from "./fixtures/webhook_cases.json";
import answers from "./fixtures/webhook_expected.json";

// What a delivery makes of a bot's answer, as Campfire's `Webhook#deliver` reads it
// (app/models/webhook.rb): the text or file the bot says back, or that it failed to respond.
// webhooks.test.ts checks what the room does with it.
//
// It replays answers recorded from Campfire (fixtures/README.md). Each is given as a Worker's `fetch`
// would give it, a gzipped body decompressed, and the delivery must come to what Campfire's did: the
// webhook's status and the bot's reply, or a failure. The request must be the one Net::HTTP sent, but
// for the headers a Worker's `fetch` decides itself. A file is kept as it arrives, where Campfire reads
// all of it first, and must come to the bytes Campfire kept. The answers are given the 7 seconds
// Campfire gave them, where Ember gives a webhook 30.

interface Case {
  name: string;
  url?: string;
  status: number;
  headers: [string, string][];
  body?: string;
  body_b64?: string;
  gzip?: boolean;
  delay?: number;
}

interface Answer {
  name: string;
  status?: number | null;
  error?: string;
  reply: { text_b64: string } | { attachment: { filename: string; content_type: string; body_b64: string } } | null;
  requests: { request_line: string; headers: [string, string][]; body: string }[];
}

const cases = recorded as Case[];

/** What the recording delivers to each webhook. */
const PAYLOAD = '{"message":"hi"}';

/** The time Campfire gives a webhook, `Webhook::ENDPOINT_TIMEOUT`, which its late answer was recorded with. */
const CAMPFIRE_TIMEOUTS: Timeouts = { endpointMs: 7_000, deadlineMs: DELIVERY_DEADLINE_MS };

/** The headers Net::HTTP sends that a Worker's `fetch` decides itself. */
const FETCH_HEADERS = ["Accept-Encoding", "Host", "Connection", "Content-Length"];

/** What Campfire raised, as Ember fails with it. A Worker's `fetch` doesn't say why it couldn't connect, as Ruby's `Errno` does. */
const FAILURES: Record<string, (recorded: Case) => WebhookError> = {
  "Mime::Type::InvalidMimeType": ({ headers }) => new WebhookError(`${JSON.stringify(headers[0]![1])} is not a valid MIME type`),
  "Errno::ECONNREFUSED": () => new WebhookError("TypeError: Network connection lost."),
};

/** A request as a webhook gets it: its request line without the version, its headers by name, in lower case, and its body. */
interface Sent {
  line: string;
  headers: string[][];
  body: string;
}

/** Stands in for `fetch`, answering as the recorded webhook did, and keeps each request that reaches it. */
function webhookAnswering(recorded: Case) {
  const requests: Sent[] = [];
  const send = (async (input: URL, init: RequestInit) => {
    // Nothing listens where the refused case delivers.
    if (recorded.url) throw new TypeError("Network connection lost.");
    requests.push({ line: `${init.method} ${input.pathname}${input.search}`, headers: [...new Headers(init.headers)].sort(), body: init.body as string });
    if (recorded.delay) await answeredAfter(recorded.delay * 1000, init.signal!);
    const headers = new Headers(recorded.headers);
    if (recorded.gzip) headers.set("Content-Encoding", "gzip");
    return new Response(bodyOf(recorded), { status: recorded.status, headers });
  }) as typeof fetch;
  return { send, requests };
}

/** Waits `ms`, unless the request is given up on first, as a webhook that answers late does. */
const answeredAfter = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/** The recorded body, as bytes, since a `Response` made with a string says it's `text/plain` when the webhook said nothing. */
const bodyOf = (recorded: Case) => (recorded.body_b64 === undefined ? new TextEncoder().encode(recorded.body ?? "") : bytesOf(recorded.body_b64));

/** The request Campfire sent, but for the headers `fetch` decides. */
const sentBy = ({ request_line, headers, body }: Answer["requests"][number]): Sent => ({
  line: request_line.replace(/ HTTP\/1\.1$/, ""),
  headers: headers.filter(([name]) => !FETCH_HEADERS.includes(name)).map(([name, value]) => [name.toLowerCase(), value]).sort(),
  body,
});

/**
 * What Campfire made of the answer, as a delivery here comes to it, with a file as the bytes kept.
 * Ruby keeps the invalid UTF-8 of a text reply as it came, which no JavaScript string can hold, so it's
 * compared as a message here keeps it, with each invalid sequence replaced.
 */
function deliveredBy({ status, reply }: Answer): Delivered<Uint8Array> {
  if (reply === null) return { status: status ?? null, reply };
  if ("attachment" in reply) {
    const { filename, content_type: contentType, body_b64 } = reply.attachment;
    return { status: status ?? null, reply: { file: { filename, contentType }, kept: bytesOf(body_b64) } };
  }
  return { status: status ?? null, reply: { text: new TextDecoder().decode(bytesOf(reply.text_b64)) } };
}

/** Keeps a file as it arrives, as a room keeps one in R2, answering its bytes, or null once it's over its limit. */
const keepBytes: Keep<Uint8Array> = async ({ limit, read }) => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let chunk = await read(); chunk; chunk = await read()) {
    if ((size += chunk.length) > limit) return null;
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  chunks.reduce((at, chunk) => (bytes.set(chunk, at), at + chunk.length), 0);
  return bytes;
};

/** What a delivery to a webhook that `send` stands in for comes to, keeping a file with `keep`. */
const deliveredTo = <K = Uint8Array>(send: typeof fetch, keep: Keep<K> = keepBytes as Keep<K>) => postWebhook("https://bots.example.com/hook", "{}", keep, { send });

/**
 * Stands in for a webhook that answers text, or another `type`, a part at a time, each `everyMs` after
 * the last, for `parts` parts or for ever, until the request is given up on.
 */
const trickling = (everyMs: number, parts = Infinity, type = "text/plain") =>
  (async (_input: URL, init: RequestInit) => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await answeredAfter(everyMs, init.signal!);
        if (sent === parts) controller.close();
        else controller.enqueue(new TextEncoder().encode(`${++sent} `));
      },
    });
    return new Response(body, { headers: { "Content-Type": type } });
  }) as typeof fetch;

afterEach(() => {
  vi.useRealTimers();
});

describe("Webhook replies", () => {
  it("replays every recorded case", () => {
    expect(cases.map(({ name }) => name)).toEqual((answers as Answer[]).map(({ name }) => name));
    expect(cases).toHaveLength(19);
  });

  it.each((answers as Answer[]).map((answer, index) => ({ ...answer, recorded: cases[index]! })))("$name", async ({ recorded, ...answer }) => {
    // Late answers wait on the clock, which the test moves on.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const webhook = webhookAnswering(recorded);
    const delivered = postWebhook(recorded.url ?? `https://bots.example.com/${recorded.name}`, PAYLOAD, keepBytes, { send: webhook.send, timeouts: CAMPFIRE_TIMEOUTS });

    if (answer.error) {
      await expect(delivered).rejects.toThrow(FAILURES[answer.error]!(recorded));
    } else {
      if (recorded.delay) await vi.advanceTimersByTimeAsync(recorded.delay * 1000);
      // But for an answer other than a 200, which says nothing back since Campfire 1.5.2, where the
      // recorded Campfire kept its error page or text as a file.
      expect(await delivered).toEqual(answer.status && answer.status !== 200 ? { status: answer.status, reply: null } : deliveredBy(answer));
    }
    expect(webhook.requests).toEqual(answer.requests.map(sentBy));
  });

  it("names a reply's file by its type as Rails' Mime::Type.lookup does, refusing a type that isn't a media type", () => {
    const fileFor = (header: string) => replyFileOf(contentTypeOf(header)!);
    expect(fileFor("image/jpeg")).toEqual({ filename: "attachment.jpeg", contentType: "image/jpeg" });
    expect(fileFor("application/x-gzip")).toEqual({ filename: "attachment.gzip", contentType: "application/gzip" });
    expect(fileFor("IMAGE/PNG")).toEqual({ filename: "attachment.", contentType: "IMAGE/PNG" });
    expect(fileFor("text/html; charset=utf-8")).toEqual({ filename: "attachment.html", contentType: "text/html" });
    expect(fileFor("video/quicktime")).toEqual({ filename: "attachment.", contentType: "video/quicktime" });
    for (const invalid of ["image", "", "text/html, text", "a/b c"]) expect(fileFor(invalid), invalid).toBeNull();
  });

  it("reads the media type of a Content-Type header as Net::HTTP does", () => {
    const noBreakSpace = String.fromCharCode(0xa0);
    expect(contentTypeOf(null)).toBeNull();
    expect(contentTypeOf("text/plain; charset=utf-8")).toBe("text/plain");
    expect(contentTypeOf(" text / plain ;")).toBe("text/plain");
    expect(contentTypeOf("Text/Plain")).toBe("Text/Plain");
    expect(contentTypeOf("image/png/extra")).toBe("image/png");
    expect(contentTypeOf("image")).toBe("image");
    expect(contentTypeOf("")).toBe("");
    // Ruby's whitespace is ASCII's, so a no-break space stays, and the type is no media type.
    expect(contentTypeOf(`text/plain${noBreakSpace}`)).toBe(`text/plain${noBreakSpace}`);
  });

  it("reads a Content-Type header in a moment, however long a run of spaces it holds", () => {
    const spaces = " ".repeat(300_000);
    const started = Date.now();
    expect(contentTypeOf(`text/pl${spaces}ain`)).toBe(`text/pl${spaces}ain`);
    // A pattern for the spaces at a part's end would try to end each run inside it there: some 12 seconds for this.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("gives a webhook 30 seconds to send each part of its answer and a minute in all, then says it failed to respond", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const steady = deliveredTo(trickling(29_000, 1));
    await vi.advanceTimersByTimeAsync(58_000);
    expect(await steady).toEqual({ status: 200, reply: { text: "1 " } });

    const stalled = deliveredTo(trickling(31_000));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await stalled).toEqual({ status: null, reply: { text: "Failed to respond within 30 seconds" } });

    // The deadline: one that keeps sending would otherwise hold its place in the queue for ever.
    const endless = deliveredTo(trickling(29_000));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await endless).toEqual({ status: null, reply: { text: "Failed to respond within 60 seconds" } });
  });

  it("fails a text reply longer than a message's markup can be, reading no further once it's over", async () => {
    const answering = (body: BodyInit) => deliveredTo((async () => new Response(body, { headers: { "Content-Type": "text/plain" } })) as typeof fetch);
    const longest = "x".repeat(MAX_MESSAGE_HTML_LENGTH);
    expect(await answering(longest)).toEqual({ status: 200, reply: { text: longest } });
    await expect(answering(`${longest}x`)).rejects.toThrow(new WebhookError("the reply is longer than a message can be"));

    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(65_536).fill(0x78)),
      cancel() {
        cancelled = true;
      },
    });
    await expect(answering(endless)).rejects.toThrow(new WebhookError("the reply is longer than a message can be"));
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("keeps a file a part at a time as it arrives, giving the webhook 30 seconds for each part however long keeping one takes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const kept: string[] = [];
    /** Keeps each part as it comes, taking 40 seconds over each, longer than the webhook has to send one. */
    const slowly: Keep<string[]> = async ({ filename, declaredType, read }) => {
      kept.push(`${filename} (${declaredType})`);
      for (let chunk = await read(); chunk; chunk = await read()) {
        await new Promise((resolve) => setTimeout(resolve, 40_000));
        kept.push(new TextDecoder().decode(chunk));
      }
      return kept;
    };

    const steady = deliveredTo(trickling(6_000, 1, "image/png"), slowly);
    await vi.advanceTimersByTimeAsync(52_000);
    expect(await steady).toEqual({ status: 200, reply: { file: { filename: "attachment.png", contentType: "image/png" }, kept: ["attachment.png (image/png)", "1 "] } });

    const stalled = deliveredTo(trickling(31_000, Infinity, "image/png"), slowly);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await stalled).toEqual({ status: null, reply: { text: "Failed to respond within 30 seconds" } });
  });

  it("keeps an empty file", async () => {
    const answering = (body: BodyInit | null) => deliveredTo((async () => new Response(body, { headers: { "Content-Type": "application/pdf" } })) as typeof fetch);
    const empty = { status: 200, reply: { file: { filename: "attachment.pdf", contentType: "application/pdf" }, kept: new Uint8Array() } };
    expect(await answering("")).toEqual(empty);
    expect(await answering(null)).toEqual(empty);
  });

  it("says nothing back for an answer other than a 200, whatever its type, reading none of it, as Campfire 1.5.2 doesn't", async () => {
    /** Stands in for keeping a file, which no answer here brings. */
    const noFile: Keep<never> = () => expect.unreachable("The answer brings no file");
    for (const status of [204, 301, 302, 400, 403, 404, 500, 503]) {
      for (const type of ["text/plain", "image/png", "not a mime type"]) {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
          pull: (controller) => controller.enqueue(new TextEncoder().encode("payload")),
          cancel() {
            cancelled = true;
          },
        });
        // A 204 can have no body.
        const answer = new Response(status === 204 ? null : body, { status, headers: { "Content-Type": type } });
        expect(await postWebhook("https://bots.example.com/hook", "{}", noFile, { send: (async () => answer) as typeof fetch }), `${status} ${type}`).toEqual({ status, reply: null });
        if (status !== 204) expect(cancelled, `${status} ${type}`).toBe(true);
      }
    }
    // A 200 still says something back.
    const answering = (type: string) => deliveredTo((async () => new Response("payload", { headers: { "Content-Type": type } })) as typeof fetch);
    expect(await answering("text/plain")).toEqual({ status: 200, reply: { text: "payload" } });
    expect(await answering("image/png")).toEqual({ status: 200, reply: { file: { filename: "attachment.png", contentType: "image/png" }, kept: new TextEncoder().encode("payload") } });
  });

  it(`fails a file larger than ${MAX_FILE_REPLY_BYTES / 1024 / 1024} MB, reading no further once it's over`, async () => {
    let [sent, cancelled] = [0, false];
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1024 * 1024;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    /** Counts the bytes as they come, keeping none of them. */
    const counting: Keep<number> = async ({ limit, read }) => {
      let size = 0;
      for (let chunk = await read(); chunk; chunk = await read()) if ((size += chunk.length) > limit) return null;
      return size;
    };

    const delivered = deliveredTo((async () => new Response(endless, { headers: { "Content-Type": "video/mp4" } })) as typeof fetch, counting);
    await expect(delivered).rejects.toThrow(new WebhookError("the reply is larger than 100 MB"));
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(sent).toBeLessThan(MAX_FILE_REPLY_BYTES + 4 * 1024 * 1024);
  });

  it("says why a file couldn't be kept, reading no further", async () => {
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(1024)),
      cancel() {
        cancelled = true;
      },
    });
    const failing: Keep<never> = async ({ read }) => {
      await read();
      throw new WebhookError("R2 is unavailable");
    };

    await expect(deliveredTo((async () => new Response(endless, { headers: { "Content-Type": "image/gif" } })) as typeof fetch, failing)).rejects.toThrow(
      new WebhookError("R2 is unavailable"),
    );
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
});

describe("Answers to a click", () => {
  /** What a click's delivery to a webhook that `send` stands in for comes to. */
  const clicked = (send: typeof fetch) => postClick("https://bots.example.com/hook", "{}", keepBytes, { send });
  const answering = (body: BodyInit | null, init?: ResponseInit) => (async () => new Response(body, init)) as typeof fetch;
  const json = { headers: { "Content-Type": "application/json; charset=utf-8" } };

  it("reads a 200's JSON as a payload for the card, which a message's delivery keeps as a file", async () => {
    const payload = '{"text":"Approved"}';
    expect(await clicked(answering(payload, json))).toEqual({ status: 200, answer: { payload } });
    expect(await deliveredTo(answering(payload, json))).toEqual({ status: 200, reply: { file: { filename: "attachment.json", contentType: "application/json" }, kept: new TextEncoder().encode(payload) } });
  });

  it("reads anything else as a message's delivery does: text, a file, or nothing", async () => {
    expect(await clicked(answering("On it.", { headers: { "Content-Type": "text/plain" } }))).toEqual({ status: 200, answer: { text: "On it." } });
    expect(await clicked(answering("GIF89a", { headers: { "Content-Type": "image/gif" } }))).toEqual({
      status: 200,
      answer: { file: { filename: "attachment.gif", contentType: "image/gif" }, kept: new TextEncoder().encode("GIF89a") },
    });
    expect(await clicked(answering(null, { status: 204 }))).toEqual({ status: 204, answer: null });
    // An error's JSON is no payload.
    expect(await clicked(answering('{"text":"no"}', { status: 500, ...json }))).toEqual({ status: 500, answer: null });
  });

  it("fails a payload longer than a message's markup can be", async () => {
    await expect(clicked(answering(`{"text":"${"x".repeat(MAX_MESSAGE_HTML_LENGTH)}"}`, json))).rejects.toThrow(new WebhookError("the reply is longer than a message can be"));
  });

  it("says nothing for the bot when its webhook doesn't answer in time, where a message's delivery has it say it failed", async () => {
    vi.useFakeTimers();
    const never = (async (_input: URL, init: RequestInit) => {
      await answeredAfter(120_000, init.signal!);
      return new Response(null);
    }) as typeof fetch;
    const delivered = clicked(never);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await delivered).toEqual({ status: null, answer: null });
  });
});

