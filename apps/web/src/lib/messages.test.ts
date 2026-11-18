import type { Message } from "@ember/protocol";
import { describe, expect, it, vi } from "vitest";
import { displayBody, OPENGRAPH_EMBED_CONTENT_TYPE, previewContent } from "@ember/richtext/dom";
import { dateLabel, dateTimeLabel, huddleStartedLabel, lastReplyLabel, newestWrittenBy, replyQuote, timeLabel, timeline } from "./messages";

const at = (iso: string, creatorId = "u1"): Message => ({
  id: iso,
  clientMessageId: iso,
  roomId: "general",
  creator: { id: creatorId, name: creatorId },
  body: "",
  plainText: "",
  mentions: [],
  createdAt: iso,
  updatedAt: iso,
  editedAt: null,
  boosts: [],
});

describe("Group messages by author", () => {
  it("threads a person's messages up to five minutes apart, either way, and no further", () => {
    const items = timeline([
      at("2026-10-12T09:00:00"),
      at("2026-10-12T09:05:00"),
      at("2026-10-12T09:10:01"),
      // Before the one above it, as a page can hold a message whose clock ran behind.
      at("2026-10-12T09:07:00"),
      at("2026-10-12T09:07:30", "u2"),
      at("2026-10-12T09:08:00", "u2"),
    ]);
    expect(items.map((i) => i.threaded)).toEqual([false, true, false, true, false, true]);
  });

  it("keeps a follow-up just after midnight threaded, under its day's separator", () => {
    const items = timeline([at("2026-10-12T23:58:00"), at("2026-10-13T00:01:00")]);
    expect(items.map((i) => [i.firstOfDay, i.threaded])).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  it("groups nothing under a huddle's message, nor it under anything, as it shows its huddle where its author would be", () => {
    const huddle: Message = { ...at("2026-10-12T09:01:00"), huddle: { startedAt: "2026-10-12T09:01:00.000Z" } };
    const items = timeline([at("2026-10-12T09:00:00"), huddle, at("2026-10-12T09:02:00")]);
    expect(items.map((i) => i.threaded)).toEqual([false, false, false]);
  });
});

describe("Edit your newest message", () => {
  it("finds the newest message someone wrote, which the message of a huddle they started isn't", () => {
    const [first, theirs, second] = [at("2026-10-12T09:00:00"), at("2026-10-12T09:01:00", "u2"), at("2026-10-12T09:02:00")];
    const huddle: Message = { ...at("2026-10-12T09:03:00"), huddle: { startedAt: "2026-10-12T09:03:00.000Z" } };
    expect(newestWrittenBy([first, theirs, second, huddle], "u1")).toBe(second);
    expect(newestWrittenBy([first, theirs, second, huddle], "u2")).toBe(theirs);
    expect(newestWrittenBy([huddle], "u1")).toBeUndefined();
  });
});

describe("Threads", () => {
  it("groups nothing under a message deleted while its thread has replies, nor it under anything, as it shows no author", () => {
    const deleted: Message = { ...at("2026-10-12T09:01:00"), deleted: true };
    const items = timeline([at("2026-10-12T09:00:00"), deleted, at("2026-10-12T09:02:00")]);
    expect(items.map((i) => i.threaded)).toEqual([false, false, false]);
  });

  it("says when a thread's last reply came: today or yesterday at its time, or the day, with its year in another", () => {
    const now = new Date(2026, 9, 30, 15, 0);
    const today = new Date(2026, 9, 30, 9, 41);
    const yesterday = new Date(2026, 9, 29, 9, 41);
    expect(lastReplyLabel(today, now)).toEqual({ long: `today at ${timeLabel(today)}`, short: timeLabel(today) });
    expect(lastReplyLabel(yesterday, now)).toEqual({ long: `yesterday at ${timeLabel(yesterday)}`, short: "yesterday" });
    expect(lastReplyLabel(new Date(2026, 9, 12, 9, 41), now)).toEqual({ long: "on Oct 12", short: "on Oct 12" });
    expect(lastReplyLabel(new Date(2025, 9, 12, 9, 41), now)).toEqual({ long: "on Oct 12, 2025", short: "on Oct 12, 2025" });
    expect(lastReplyLabel(new Date(2026, 9, 31, 23, 0), new Date(2026, 10, 1, 0, 5)).short).toBe("yesterday");
  });
});

describe("The Huddles page", () => {
  it("says when a huddle started: today or yesterday at its time, or the day, with its year in another", () => {
    const now = new Date(2026, 9, 30, 15, 0);
    const today = new Date(2026, 9, 30, 9, 41);
    const yesterday = new Date(2026, 9, 29, 9, 41);
    const lastNight = new Date(2026, 9, 31, 23, 0);
    expect(huddleStartedLabel(today, now)).toBe(`Today at ${timeLabel(today)}`);
    expect(huddleStartedLabel(yesterday, now)).toBe(`Yesterday at ${timeLabel(yesterday)}`);
    expect(huddleStartedLabel(new Date(2026, 9, 12, 9, 41), now)).toBe("Oct 12");
    expect(huddleStartedLabel(new Date(2025, 9, 12, 9, 41), now)).toBe("Oct 12, 2025");
    expect(huddleStartedLabel(lastNight, new Date(2026, 10, 1, 0, 5))).toBe(`Yesterday at ${timeLabel(lastNight)}`);
  });
});

describe("Day separators", () => {
  it("starts a day at the first message and wherever the date changes in the reader's time zone", () => {
    const items = timeline([at("2026-10-11T23:59:59"), at("2026-10-12T00:00:00", "u2"), at("2026-10-12T18:00:00"), at("2026-10-14T08:00:00")]);
    expect(items.map((i) => i.firstOfDay)).toEqual([true, true, false, true]);
  });

  it("dates days and tells them apart in the zone the app opened in, even once the device's zone changes", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "UTC";
    vi.resetModules();
    const opened = await import("./messages");
    try {
      // In Los Angeles, the first would be January 1st's.
      process.env.TZ = "America/Los_Angeles";
      const items = opened.timeline([at("2026-01-02T05:00:00Z"), at("2026-01-02T09:00:00Z", "u2")]);
      expect(items.map((i) => i.firstOfDay)).toEqual([true, false]);
      expect(opened.dateLabel(new Date(items[0]!.message.createdAt))).toBe("January 2, 2026");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("writes the date out, with the date and time on hover, as local_time_controller.js does", () => {
    const date = new Date("2026-10-12T15:04:00");
    expect(dateLabel(date)).toBe("October 12, 2026");
    expect(dateTimeLabel(date)).toBe("10/12/26, 3:04 PM");
    expect(timeLabel(date)).toBe("3:04 PM");
  });
});

describe("Quote a message", () => {
  const MENTION = 'content-type="application/vnd.campfire.mention" sgid="0123456789abcdef"';
  const LINK = "https://ember.test/rooms/general/@m1";
  const CITE = `<cite>Ada <a href="${LINK}">#</a></cite><p><br></p>`;

  /** A link preview as the composer adds one. */
  function preview(details: Parameters<typeof previewContent>[0]): string {
    const attachment = document.createElement("action-text-attachment");
    attachment.setAttribute("content-type", OPENGRAPH_EMBED_CONTENT_TYPE);
    attachment.setAttribute("content", previewContent(details));
    return attachment.outerHTML;
  }

  const quote = (body: string, plainText: string) => replyQuote(displayBody(body, plainText, ""), "Ada", LINK, () => "Grace");

  it("quotes what the message shows, then cites its author with a link to it, leaving a line to write on", () => {
    const nodes = displayBody(`<p>Third time's a charm, <action-text-attachment ${MENTION}></action-text-attachment> &amp; https://example.com</p>`, "", "");
    const names: Record<string, string> = { "0123456789abcdef": "Grace <3" };
    expect(replyQuote(nodes, "Ada & co", "https://ember.test/rooms/general/@m%201", (userId) => names[userId]!)).toBe(
      "<blockquote><p>Third time's a charm, Grace &lt;3 &amp; " +
        '<a href="https://example.com">https://example.com</a></p></blockquote>' +
        '<cite>Ada &amp; co <a href="https://ember.test/rooms/general/@m%201">#</a></cite><p><br></p>',
    );
  });

  it("leaves out the message's link previews", () => {
    expect(quote(`<p>Look <action-text-attachment ${MENTION}></action-text-attachment></p>${preview({ href: "https://basecamp.com/", filename: "Basecamp" })}`, "Look @Grace")).toBe(
      `<blockquote><p>Look Grace</p></blockquote>${CITE}`,
    );
  });

  it("quotes a message of only link previews by where the first link in them goes, as the browser reads its address", () => {
    const solo = `<p><a href="https://basecamp.com">https://basecamp.com</a></p>${preview({ href: "https://basecamp.com", filename: "Basecamp" })}`;
    expect(quote(solo, "https://basecamp.com")).toBe(`<blockquote>https://basecamp.com/</blockquote>${CITE}`);
    expect(quote(preview({ filename: "Free cookies", description: "At www.example.com" }), "")).toBe(`<blockquote>http://www.example.com/</blockquote>${CITE}`);
    expect(quote(preview({ filename: "Unlinked" }), "")).toBe(`<blockquote></blockquote>${CITE}`);
  });
});
