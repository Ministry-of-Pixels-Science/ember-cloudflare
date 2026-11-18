import { describe, expect, it } from "vitest";
import { MAX_REPORT_NOTE_LENGTH, parseNewReport, parseReportHandling, REPORT_NOTE_REFUSED, REPORT_REASON_REFUSED } from "./reports";

describe("parseNewReport", () => {
  it("takes a reason Report offers, with its few words trimmed, or none", () => {
    expect(parseNewReport({ reason: "spam", note: "  Buy now!  " })).toEqual({ reason: "spam", note: "Buy now!" });
    expect(parseNewReport({ reason: "harassment" })).toEqual({ reason: "harassment", note: "" });
    expect(parseNewReport({ reason: "other", note: "" })).toEqual({ reason: "other", note: "" });
  });

  it("refuses any other reason, or none", () => {
    for (const body of [{ reason: "boring" }, { reason: "Spam" }, { note: "Rude" }, {}, null, [], "spam"]) expect(parseNewReport(body)).toEqual({ error: REPORT_REASON_REFUSED });
  });

  it("refuses words that aren't text, or more than it keeps, counting characters", () => {
    expect(parseNewReport({ reason: "spam", note: 5 })).toEqual({ error: REPORT_NOTE_REFUSED });
    expect(parseNewReport({ reason: "spam", note: null })).toEqual({ error: REPORT_NOTE_REFUSED });
    expect(parseNewReport({ reason: "spam", note: "🔥".repeat(MAX_REPORT_NOTE_LENGTH) })).toEqual({ reason: "spam", note: "🔥".repeat(MAX_REPORT_NOTE_LENGTH) });
    expect(parseNewReport({ reason: "spam", note: "a".repeat(MAX_REPORT_NOTE_LENGTH + 1) })).toEqual({ error: REPORT_NOTE_REFUSED });
  });
});

describe("parseReportHandling", () => {
  it("takes what an administrator can do of a report, and nothing else", () => {
    for (const outcome of ["deleted", "removed", "banned", "dismissed"] as const) expect(parseReportHandling({ outcome })).toEqual({ outcome });
    for (const body of [{ outcome: "delete" }, { outcome: "" }, {}, null, "dismissed"]) expect(parseReportHandling(body)).toBeNull();
  });
});
