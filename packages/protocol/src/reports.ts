// Reports, which anyone can make of someone else's message, or of someone for their name, picture or
// bio, as Apple asks of every app where people post. The workspace's administrators hear of each, see
// the message or the person as they were when reported, and delete the message, remove or ban whoever it
// reports, or dismiss it. The person reported is never told who reported them, so an administrator isn't
// shown the reports of themselves, and a report stays in the workspace.

import type { Card } from "./cards.ts";
import type { StoredFile } from "./files.ts";
import type { RoomId, RoomKind, User, UserId } from "./index.ts";
import { WORKSPACE_SETTINGS_PATH } from "./pages.ts";

/** Where administrators find the Reports list, which a report's push opens: the Membership tab of workspace settings. */
export const REPORTS_PATH = `${WORKSPACE_SETTINGS_PATH}#membership-settings`;

/** Why someone reports a message or a person, which Report asks as a choice. */
export const REPORT_REASONS = ["spam", "harassment", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** How Report and the Reports list name each reason. */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = { spam: "Spam", harassment: "Harassment", other: "Something else" };

/** The most characters the few words of a report can take. */
export const MAX_REPORT_NOTE_LENGTH = 500;

/**
 * What Report gives `POST /api/rooms/<id>/messages/<id>/report`, for a message, and
 * `POST /api/users/<id>/report`, for someone: why, and a few words, which can be none.
 */
export interface NewReport {
  reason: ReportReason;
  note: string;
}

/** Why a report is refused before it's kept. */
export const REPORT_REASON_REFUSED = "Choose why you're reporting it.";
export const REPORT_NOTE_REFUSED = `Say why in ${MAX_REPORT_NOTE_LENGTH} characters or fewer.`;

/** The report a request's body asks for, its words trimmed, or why it's refused. */
export function parseNewReport(data: unknown): NewReport | { error: string } {
  const given = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const reason = REPORT_REASONS.find((reason) => reason === given.reason);
  if (!reason) return { error: REPORT_REASON_REFUSED };
  if (given.note !== undefined && typeof given.note !== "string") return { error: REPORT_NOTE_REFUSED };
  const note = (given.note ?? "").trim();
  return [...note].length > MAX_REPORT_NOTE_LENGTH ? { error: REPORT_NOTE_REFUSED } : { reason, note };
}

/**
 * A message as it was when reported, which its report shows whatever becomes of it: who wrote it, its
 * text, the people it mentions, its file, by name, and a bot's cards. Once whoever wrote it deletes their
 * account, the report keeps none of those but who, named as deleted accounts are.
 */
export interface ReportedMessage {
  id: string;
  creator: User;
  body: string;
  plainText: string;
  mentions: User[];
  createdAt: string;
  editedAt: string | null;
  attachment?: Pick<StoredFile, "name" | "contentType" | "byteSize">;
  cards?: Card[];
  /** A reply's: the message it replies to in its thread. */
  parentId?: string;
  /** Set once whoever wrote it deleted their account, which took its text, mentions, file and cards from the report. */
  accountDeleted?: true;
}

/** Someone as they were when reported: their name and bio, until they delete their account, which takes both from the report. */
export interface ReportedPerson {
  id: UserId;
  name: string;
  bio: string | null;
  /** Set once they deleted their account. */
  accountDeleted?: true;
}

/**
 * What a report is of: a message, in a room, which is named unless it's a DM, and nothing else of that
 * room is shown, or someone.
 */
export type ReportSubject =
  | { kind: "message"; roomId: RoomId; room: { kind: RoomKind; name: string | null }; message: ReportedMessage }
  | { kind: "person"; person: ReportedPerson };

/**
 * What an administrator did of a report: deleted its message, removed or banned whoever wrote it, or whom
 * it reports, or dismissed it. Deleting a message closes every open report of it, and removing or banning
 * someone every open report of them or of their messages.
 */
export const REPORT_OUTCOMES = ["deleted", "removed", "banned", "dismissed"] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

/** A report, as administrators see it. */
export interface Report {
  id: string;
  reporterId: UserId;
  reason: ReportReason;
  note: string;
  reportedAt: string;
  subject: ReportSubject;
  /** Whoever handled it, when, and how, or null while it's open. */
  handled: { by: UserId; at: string; outcome: ReportOutcome } | null;
}

/** Whether whoever a report is of has deleted their account, so it keeps nothing of what they wrote, nor their name or bio. */
export const isOfDeletedAccount = ({ subject }: Report): boolean => (subject.kind === "message" ? subject.message : subject.person).accountDeleted === true;

/** How many reports `GET /api/reports` lists: the newest open ones, and the ones handled last. */
export const OPEN_REPORTS_LISTED = 100;
export const HANDLED_REPORTS_LISTED = 50;

/**
 * What `GET /api/reports` answers an administrator: the open reports, newest first, and the latest
 * reports handled, the last handled first, leaving out the reports of them.
 */
export interface Reports {
  open: Report[];
  handled: Report[];
}

/** What an administrator gives `POST /api/reports/<id>`, which handles the report as `outcome` says. */
export interface ReportHandling {
  outcome: ReportOutcome;
}

/** What a request's body asks to do of a report, or null for nothing an administrator can. */
export function parseReportHandling(data: unknown): ReportHandling | null {
  const given = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const outcome = REPORT_OUTCOMES.find((outcome) => outcome === given.outcome);
  return outcome ? { outcome } : null;
}

/** What `POST /api/reports/<id>` answers: the report as it is now, with any other it closed. */
export interface HandledReports {
  reports: Report[];
}
