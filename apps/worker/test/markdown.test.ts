import { MAX_MESSAGE_HTML_LENGTH, MAX_MESSAGE_LENGTH } from "@ember/protocol";
import { describe, expect, it } from "vitest";
import { markdownHtml, markdownTooLong } from "../src/bots/markdown";

describe("Block Kit markdown", () => {
  describe("markdownTooLong", () => {
    it("weighs a reused address before the markup is built", () => {
      // One long address, named 2,000 times in ~15,000 characters of Markdown, reads as millions of characters of markup.
      const amplified = `[r]: https://example.com/${"a".repeat(1_000)}\n\n${"[x][r] ".repeat(2_000)}`;
      expect(amplified.length).toBeLessThan(MAX_MESSAGE_HTML_LENGTH);
      expect(markdownTooLong(amplified, MAX_MESSAGE_HTML_LENGTH)).toBe(true);
      // A smaller spread shows the growth without building much: 50 names of a 500-character address.
      const small = `[r]: https://example.com/${"a".repeat(500)}\n\n${"[x][r] ".repeat(50)}`;
      expect(markdownHtml(small).length).toBeGreaterThan(small.length * 10);
    });

    it("passes a message as long as one can be, and turns away the markup that outgrows the limit", () => {
      expect(markdownTooLong("w".repeat(MAX_MESSAGE_LENGTH), MAX_MESSAGE_HTML_LENGTH)).toBe(false);
      // The same `&` a message's text-length test sends: 25,000 of them read as 125,000 characters of markup.
      expect(markdownTooLong("&".repeat(MAX_MESSAGE_HTML_LENGTH / 4), MAX_MESSAGE_HTML_LENGTH)).toBe(true);
    });
  });
});
