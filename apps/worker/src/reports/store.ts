import type { Message, RoomId, RoomKind, User, UserId } from "@ember/protocol";
import {
  HANDLED_REPORTS_LISTED,
  OPEN_REPORTS_LISTED,
  type NewReport,
  type Report,
  type ReportedMessage,
  type ReportOutcome,
  type ReportReason,
  type Reports,
  type ReportSubject,
} from "@ember/protocol/reports";
import { statement, type Db } from "../db";
import { ACTIVE, ADMINISTRATOR, deliveryOf, type DeliveryRow, type PushDelivery } from "../workspace-store";

// What the Workspace keeps of reports (migrations/0073_reports.sql): who reported whom, for which of
// their messages or for themselves, why, and the message or the person as they were then, until an
// administrator handles it. Every list and count of them leaves out the reports of whoever it's for, so
// an administrator never learns who reported them. Once someone deletes their account, the reports of
// them keep nothing they wrote, nor their name or bio (`CLEAR_REPORTS_OF`), and no new one is kept.

/** A report to keep: its id, who made it, of whom, as Report asked, and when. A message's names its room and itself. */
export interface ReportToKeep extends NewReport {
  id: string;
  reporterId: UserId;
  subjectId: UserId;
  subject: ReportSubject;
  createdAt: string;
}

/** How many open reports an active administrator sees, which leave out the reports of them. */
export interface OpenReports {
  userId: UserId;
  open: number;
}

/** What keeping a report did: each active administrator's open reports then, and where its pushes go. */
export interface KeptReport {
  open: OpenReports[];
  deliveries: PushDelivery[];
}

/** What handling a report did: the reports it closed, that one among them, and each active administrator's open reports then. */
export interface ClosedReports {
  closed: Report[];
  open: OpenReports[];
}

interface ReportRow {
  id: string;
  reporter_id: UserId;
  subject: string;
  reason: ReportReason;
  note: string;
  created_at: string;
  handler_id: UserId | null;
  handled_at: string | null;
  outcome: ReportOutcome | null;
}

const COLUMNS = `id, reporter_id, subject, reason, note, created_at, handler_id, handled_at, outcome`;

const reportOf = (row: ReportRow): Report => ({
  id: row.id,
  reporterId: row.reporter_id,
  reason: row.reason,
  note: row.note,
  reportedAt: row.created_at,
  subject: JSON.parse(row.subject) as ReportSubject,
  handled: row.handled_at === null ? null : { by: row.handler_id!, at: row.handled_at, outcome: row.outcome! },
});

/** Room ?1's kind and name, if ?2 is in it, whose messages they can report. */
const ROOM_OF_MEMBER = `SELECT rooms.kind, rooms.name FROM rooms JOIN memberships ON memberships.room_id = rooms.id
  WHERE rooms.id = ?1 AND memberships.user_id = ?2`;

/**
 * Whether whoever a report would be of, ?3, still has their account: no report is kept of someone who
 * deleted theirs, as one of their messages can be reported in the minutes it takes every room to delete it.
 */
const ACCOUNT_KEPT = `NOT EXISTS (SELECT 1 FROM users WHERE id = ?3 AND deleted_at IS NOT NULL)`;

/** Keeps a report of message ?5 in room ?4, by ?3, unless whoever made it, ?2, has an open one of it already, answering it if it did. */
export const KEEP_MESSAGE_REPORT = `INSERT INTO reports (id, reporter_id, subject_id, room_id, message_id, subject, reason, note, created_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
  WHERE NOT EXISTS (SELECT 1 FROM reports WHERE message_id = ?5 AND room_id = ?4 AND reporter_id = ?2 AND handled_at IS NULL) AND ${ACCOUNT_KEPT}
  RETURNING id`;

/** Keeps a report of someone, ?3, unless whoever made it, ?2, has an open one of them already, answering it if it did. */
export const KEEP_PERSON_REPORT = `INSERT INTO reports (id, reporter_id, subject_id, subject, reason, note, created_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
  WHERE NOT EXISTS (SELECT 1 FROM reports WHERE subject_id = ?3 AND message_id IS NULL AND reporter_id = ?2 AND handled_at IS NULL) AND ${ACCOUNT_KEPT}
  RETURNING id`;

/** Whether ? has deleted their account. */
const DELETED_ACCOUNT = `SELECT 1 FROM users WHERE id = ? AND deleted_at IS NOT NULL`;

/** Each active administrator, and how many open reports they see, which leave out the reports of them. */
export const OPEN_REPORTS_BY_ADMINISTRATOR = `SELECT id AS user_id, (SELECT count(*) FROM reports WHERE handled_at IS NULL AND subject_id <> users.id) AS open
  FROM users WHERE role = ${ADMINISTRATOR} AND status = ${ACTIVE}`;

/**
 * Where the push of a report made by ?1 of ?2 goes: to the subscriptions of the active administrators
 * but the two of them and anyone who has blocked whoever made it, in the order they were saved, each
 * with the count its push sets the badge to, as a message's does.
 */
export const REPORT_PUSHES = `SELECT push_subscriptions.id, push_subscriptions.endpoint, push_subscriptions.p256dh_key, push_subscriptions.auth_key,
    (SELECT count(*) FROM memberships WHERE memberships.user_id = users.id AND memberships.unread_at IS NOT NULL) AS badge
  FROM users JOIN push_subscriptions ON push_subscriptions.user_id = users.id
  WHERE users.role = ${ADMINISTRATOR} AND users.status = ${ACTIVE} AND users.id <> ?1 AND users.id <> ?2
    AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.user_id = users.id AND blocks.blocked_id = ?1)
  ORDER BY push_subscriptions.id`;

/**
 * Whether subscription ?1 may still have the push of a report made by ?2 as its turn comes: it's an
 * active administrator's still, who hasn't blocked them since.
 */
export const REPORT_PUSHABLE = `SELECT 1 FROM push_subscriptions JOIN users ON users.id = push_subscriptions.user_id
  WHERE push_subscriptions.id = ?1 AND users.role = ${ADMINISTRATOR} AND users.status = ${ACTIVE}
    AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.user_id = users.id AND blocks.blocked_id = ?2)`;

/** The newest open reports, leaving out the reports of ?. */
export const OPEN_REPORTS = `SELECT ${COLUMNS} FROM reports WHERE handled_at IS NULL AND subject_id <> ?
  ORDER BY created_at DESC, id DESC LIMIT ${OPEN_REPORTS_LISTED}`;

/** The reports handled last, leaving out the reports of ?. */
export const HANDLED_REPORTS = `SELECT ${COLUMNS} FROM reports WHERE handled_at IS NOT NULL AND subject_id <> ?
  ORDER BY handled_at DESC, id DESC LIMIT ${HANDLED_REPORTS_LISTED}`;

/** Report ?1, unless it's of ?2. */
const REPORT_FOR = `SELECT ${COLUMNS} FROM reports WHERE id = ?1 AND subject_id <> ?2`;

/** Closes report ?1, if it's open, as ?2 handled it at ?3, `dismissed`, answering it. */
const DISMISS_REPORT = `UPDATE reports SET handler_id = ?2, handled_at = ?3, outcome = 'dismissed'
  WHERE id = ?1 AND handled_at IS NULL RETURNING ${COLUMNS}`;

/** Closes every open report of message ?2 in room ?1 as ?3 handled them at ?4, deleting it, answering them. */
export const CLOSE_MESSAGE_REPORTS = `UPDATE reports SET handler_id = ?3, handled_at = ?4, outcome = 'deleted'
  WHERE message_id = ?2 AND room_id = ?1 AND handled_at IS NULL RETURNING ${COLUMNS}`;

/** Closes every open report of ?1, or of their messages, as ?2 handled them at ?3, with outcome ?4, answering them. */
export const CLOSE_PERSON_REPORTS = `UPDATE reports SET handler_id = ?2, handled_at = ?3, outcome = ?4
  WHERE subject_id = ?1 AND handled_at IS NULL RETURNING ${COLUMNS}`;

export class ReportStore {
  constructor(private readonly db: Db) {}

  /** Room `roomId`'s kind and name, if `userId` is in it, or null. */
  async roomOf(roomId: RoomId, userId: UserId): Promise<{ kind: RoomKind; name: string | null } | null> {
    const [room] = await this.db.all<{ kind: RoomKind; name: string | null }>(ROOM_OF_MEMBER, roomId, userId);
    return room ?? null;
  }

  /**
   * Keeps `report`, in one transaction, unless whoever made it has an open report of the same message, or
   * person, already, or whoever it's of has deleted their account: answers null then, or else each active
   * administrator's open reports and where the report's pushes go.
   */
  async keep(report: ReportToKeep): Promise<KeptReport | null> {
    const { id, reporterId, subjectId, subject, reason, note, createdAt } = report;
    const kept =
      subject.kind === "message"
        ? statement(KEEP_MESSAGE_REPORT, id, reporterId, subjectId, subject.roomId, subject.message.id, JSON.stringify(subject), reason, note, createdAt)
        : statement(KEEP_PERSON_REPORT, id, reporterId, subjectId, JSON.stringify(subject), reason, note, createdAt);
    const [[saved], open, deliveries] = (await this.db.batch([kept, statement(OPEN_REPORTS_BY_ADMINISTRATOR), statement(REPORT_PUSHES, reporterId, subjectId)])) as [
      unknown[],
      Array<{ user_id: UserId; open: number }>,
      DeliveryRow[],
    ];
    return saved ? { open: open.map(openOf), deliveries: deliveries.map(deliveryOf) } : null;
  }

  /** Whether `userId` has deleted their account, whose reports keep nothing of them, as a new one can't be kept. */
  async isDeletedAccount(userId: UserId): Promise<boolean> {
    return (await this.db.all(DELETED_ACCOUNT, userId)).length > 0;
  }

  /** Whether subscription `id` may still have the push of a report `reporterId` made (`REPORT_PUSHABLE`). */
  async pushable(id: number, reporterId: UserId): Promise<boolean> {
    return (await this.db.all(REPORT_PUSHABLE, id, reporterId)).length > 0;
  }

  /** The reports administrator `userId` sees: the newest open ones and the ones handled last, leaving out the reports of them. */
  async list(userId: UserId): Promise<Reports> {
    const [open, handled] = (await this.db.batch([statement(OPEN_REPORTS, userId), statement(HANDLED_REPORTS, userId)])) as [ReportRow[], ReportRow[]];
    return { open: open.map(reportOf), handled: handled.map(reportOf) };
  }

  /** Report `id`, as administrator `userId` sees it, or null if there's none, or it's of them. */
  async reportFor(id: string, userId: UserId): Promise<Report | null> {
    const [row] = await this.db.all<ReportRow>(REPORT_FOR, id, userId);
    return row ? reportOf(row) : null;
  }

  /**
   * Closes `report` as `handlerId` handled it at `now`, with `outcome`, in one transaction: deleting its
   * message, which only a message's report can, closes every open report of the message, and removing or
   * banning whom it's of every open report of them or of their messages. Answers the reports it closed,
   * which leave out the one asked of only if another administrator closed it first, and each active
   * administrator's open reports then.
   */
  async close(report: Report, handlerId: UserId, outcome: ReportOutcome, now: string): Promise<ClosedReports> {
    const { subject } = report;
    const closing =
      outcome === "dismissed"
        ? statement(DISMISS_REPORT, report.id, handlerId, now)
        : outcome === "deleted" && subject.kind === "message"
          ? statement(CLOSE_MESSAGE_REPORTS, subject.roomId, subject.message.id, handlerId, now)
          : statement(CLOSE_PERSON_REPORTS, subjectOf(report), handlerId, now, outcome);
    const [closed, open] = (await this.db.batch([closing, statement(OPEN_REPORTS_BY_ADMINISTRATOR)])) as [ReportRow[], Array<{ user_id: UserId; open: number }>];
    return { closed: closed.map(reportOf), open: open.map(openOf) };
  }

  /** Each active administrator's open reports, which leave out the reports of them. */
  async openByAdministrator(): Promise<OpenReports[]> {
    return (await this.db.all<{ user_id: UserId; open: number }>(OPEN_REPORTS_BY_ADMINISTRATOR)).map(openOf);
  }
}

const openOf = ({ user_id, open }: { user_id: UserId; open: number }): OpenReports => ({ userId: user_id, open });

/** Whom a report is of: whoever wrote its message, or the person it reports. */
export const subjectOf = ({ subject }: Report): UserId => (subject.kind === "message" ? subject.message.creator.id : subject.person.id);

const userOf = ({ id, name }: User): User => ({ id, name });

/** What a report keeps of `message`: who wrote it, its text, the people it mentions, its file by name, a bot's cards, and the message it replies to. */
export function reportedMessage({ id, creator, body, plainText, mentions, createdAt, editedAt, attachment, cards, parentId }: Message): ReportedMessage {
  return {
    id,
    creator: userOf(creator),
    body,
    plainText,
    mentions: mentions.map(userOf),
    createdAt,
    editedAt,
    ...(attachment && { attachment: { name: attachment.name, contentType: attachment.contentType, byteSize: attachment.byteSize } }),
    ...(cards && { cards }),
    ...(parentId !== undefined && { parentId }),
  };
}
