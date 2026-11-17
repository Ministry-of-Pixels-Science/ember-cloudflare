import { afterEach, describe, expect, it, vi } from "vitest";
import { fileText, languageOf, MAX_SHOWN_TEXT_SIZE, showsText } from "./text-preview";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Has this site answer with `response`, as `fetch()` gives it. */
function answers(response: Response) {
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** A body of `count` chunks of `size` bytes of text, which counts those read and says whether the rest were cancelled. */
function chunks(count: number, size: number) {
  const body = { read: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (body.read === count) return controller.close();
        body.read++;
        controller.enqueue(new TextEncoder().encode("x".repeat(size)));
      },
      cancel() {
        body.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, stream };
}

describe("Text files' text", () => {
  it("shows the text of text files of up to 64 KiB with something in them: text of any kind, JSON and XML of any sort, and scripts", () => {
    for (const contentType of ["text/plain", "text/markdown", "text/csv", "text/x-python", "text/html", "application/json", "application/manifest+json", "application/xml", "application/x-sh", "application/sql", "application/x-yaml"]) {
      expect(showsText({ contentType, byteSize: MAX_SHOWN_TEXT_SIZE }), contentType).toBe(true);
    }
    expect(showsText({ contentType: "text/plain", byteSize: MAX_SHOWN_TEXT_SIZE + 1 })).toBe(false);
    expect(showsText({ contentType: "text/plain", byteSize: 0 })).toBe(false);
    for (const contentType of ["application/pdf", "application/octet-stream", "application/zip", "image/svg+xml", "image/png", "video/mp4", "application/jsonp"]) {
      expect(showsText({ contentType, byteSize: 10 }), contentType).toBe(false);
    }
  });

  it("knows a file's language by its extension, for the languages a code block highlights", () => {
    expect(languageOf("deploy.sh")).toBe("bash");
    expect(languageOf("App.JSX")).toBe("javascript");
    expect(languageOf("data.json")).toBe("json");
    expect(languageOf("page.html")).toBe("xml");
    expect(languageOf("query.v2.sql")).toBe("sql");
    for (const name of ["Untitled.txt", "notes.md", "README", "sh", ".bashrc", "deploy.sh.txt"]) expect(languageOf(name), name).toBeUndefined();
  });

  it("reads a file from this site as UTF-8", async () => {
    const fetch = answers(new Response(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("#!/bin/sh\necho “deployed” ✓\n")]), { headers: { "Content-Type": "application/x-sh" } }));
    const { signal } = new AbortController();
    expect(await fileText("/files/k1/s1/deploy.sh?disposition=attachment", signal)).toBe("#!/bin/sh\necho “deployed” ✓\n");
    expect(fetch).toHaveBeenCalledWith(new URL("/files/k1/s1/deploy.sh?disposition=attachment", location.href), { signal, credentials: "same-origin" });

    // What isn't UTF-8 reads as the replacement character, as a browser shows it.
    answers(new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9])));
    expect(await fileText("/files/k1/s1/cafe.txt", signal)).toBe("caf�");

    // Up to 64 KiB.
    answers(new Response(chunks(1, MAX_SHOWN_TEXT_SIZE).stream));
    expect(await fileText("/files/k1/s1/notes.txt", signal)).toHaveLength(MAX_SHOWN_TEXT_SIZE);
  });

  it("answers null for an address on another site, without fetching it", async () => {
    const fetch = answers(new Response("hello"));
    expect(await fileText("https://elsewhere.example/notes.txt", new AbortController().signal)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers null for a file the site doesn't answer with, or that's over 64 KiB as it arrives, reading no more of it", async () => {
    const { signal } = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await fileText("/files/k1/s1/notes.txt", signal)).toBeNull();

    const missing = chunks(1, 10);
    answers(new Response(missing.stream, { status: 404 }));
    expect(await fileText("/files/k1/s1/notes.txt", signal)).toBeNull();
    expect(missing.body).toEqual({ read: 0, cancelled: true });

    // It reads 64 KiB, then stops at the next byte.
    const longer = chunks(10, MAX_SHOWN_TEXT_SIZE / 2);
    answers(new Response(longer.stream));
    expect(await fileText("/files/k1/s1/notes.txt", signal)).toBeNull();
    expect(longer.body).toEqual({ read: 3, cancelled: true });
  });

  it("answers null for a file whose bytes aren't text, as one holding a NUL isn't", async () => {
    answers(new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])));
    expect(await fileText("/files/k1/s1/notes.txt", new AbortController().signal)).toBeNull();
  });
});
