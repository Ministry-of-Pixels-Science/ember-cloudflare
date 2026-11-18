import { useContext, useEffect, useMemo, useState } from "react";
import type { UserId } from "@ember/protocol";
import { HANDLED_REPORTS_LISTED, isOfDeletedAccount, OPEN_REPORTS_LISTED, REPORT_REASON_LABELS, type Report, type ReportedMessage, type ReportOutcome, type Reports } from "@ember/protocol/reports";
import { TriangleFlag } from "@/components/icons/iconoir";
import { PageLink } from "@/components/page-link";
import { PeopleContext, useNameOf, type People } from "@/hooks/use-directory";
import { useMounted } from "@/hooks/use-mounted";
import { personPath } from "@/hooks/use-route";
import { ApiError, handleReport, isSignedOut, listReports } from "@/lib/api";
import { dateTimeLabel } from "@/lib/messages";
import { cn } from "@/lib/utils";
import { BotCards } from "./bot-card";
import { BUTTON } from "./email-settings";
import { MessageBody, shownBody } from "./message-body";
import { CONFIRM_REMOVE } from "./people-list";
import { CONFIRM_BAN } from "./person-page";

// The Reports list in Membership, for administrators: the open reports, newest first, each with what it
// reports as it was then, who reported it, why and when, and what can be done of it, then the ones handled
// last. It never shows an administrator the reports of themselves. A report of someone who has deleted
// their account keeps nothing they wrote, nor their name or bio, and can only be dismissed.

/** What Delete message asks first, as More actions' does. */
export const CONFIRM_DELETE = "Are you sure you want to delete this message?";

/** What the list shows in place of what a report kept of someone, once they've deleted their account. */
export const DELETED_WITH_ACCOUNT = { message: "Deleted with their account", person: "Name and bio deleted with their account" };

/** What the list says of a report once it's handled. */
export const HANDLED_AS: Record<ReportOutcome, string> = { deleted: "Message deleted", removed: "Removed", banned: "Banned", dismissed: "Dismissed" };

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

interface Props {
  meId: UserId;
  /** Whether Membership is shown, which the list loads while it is. */
  shown: boolean;
  /** How many reports are open, as the sidebar last heard, which the heading says once there are more than the list holds. */
  open: number;
  /** How many times the sidebar has heard that count, which loads the list again each time. */
  heard: number;
  /** Says why loading or handling failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Someone by the name the people directory has for them now, or "Someone" once it has none. */
const nameIn = (people: People, userId: UserId) => people.get(userId)?.name ?? "Someone";

/** The reports listed, and whether the open ones filled the list when it loaded, as it holds only the newest. */
type Listed = Reports & { full: boolean };

const listed = (reports: Reports): Listed => ({ ...reports, full: reports.open.length >= OPEN_REPORTS_LISTED });

/** `reports` once handling one closed `closed`: out of the open ones and first among the handled. */
function withClosed(reports: Listed, closed: Report[]): Listed {
  const ids = new Set(closed.map((report) => report.id));
  const left = (list: Report[]) => list.filter((report) => !ids.has(report.id));
  return { ...reports, open: left(reports.open), handled: [...closed, ...left(reports.handled)].slice(0, HANDLED_REPORTS_LISTED) };
}

/** Whether whoever a report is of can be removed, or banned, as the people directory lists them now: not an AI agent, and not removed or banned already. */
function handlingsFor(people: People, userId: UserId): { remove: boolean; ban: boolean } {
  const person = people.get(userId);
  if (!person || person.agent) return { remove: false, ban: false };
  return { remove: person.status === "active" || person.status === "suspended", ban: person.status !== "banned" };
}

/** Whom a report is of. */
const subjectId = ({ subject }: Report) => (subject.kind === "message" ? subject.message.creator.id : subject.person.id);

export function ReportsList({ meId, shown, open, heard, onFailed }: Props) {
  const people = useContext(PeopleContext);
  const [reports, setReports] = useState<Listed | null>(null);
  // How many times a handling another administrator got to first has loaded the list again.
  const [reloads, setReloads] = useState(0);
  // The reports being handled, whose buttons wait for the server.
  const [handling, setHandling] = useState<ReadonlySet<string>>(new Set());
  const mounted = useMounted();

  // Once Membership shows, and again whenever the count comes, as reports are made or handled in any tab
  // and as the sidebar loads again, having maybe missed some.
  useEffect(() => {
    if (!shown) return;
    let stopped = false;
    listReports().then(
      (loaded) => !stopped && setReports(listed(loaded)),
      (error: unknown) => {
        if (!stopped || isSignedOut(error)) onFailed(error);
      },
    );
    return () => void (stopped = true);
  }, [shown, heard, reloads, onFailed]);

  const handle = (report: Report, outcome: ReportOutcome) => {
    if (handling.has(report.id)) return;
    if (outcome === "deleted" && !confirm(CONFIRM_DELETE)) return;
    if (outcome === "removed" && !confirm(CONFIRM_REMOVE)) return;
    if (outcome === "banned" && !confirm(CONFIRM_BAN)) return;
    setHandling((handling) => new Set(handling).add(report.id));
    handleReport(report.id, outcome)
      .then(
        (closed) => mounted.current && setReports((reports) => reports && withClosed(reports, closed)),
        (error: unknown) => {
          if (!mounted.current && !isSignedOut(error)) return;
          onFailed(error);
          if (error instanceof ApiError && error.status === 409) setReloads((reloads) => reloads + 1);
        },
      )
      .finally(
        () =>
          mounted.current &&
          setHandling((handling) => {
            const left = new Set(handling);
            left.delete(report.id);
            return left;
          }),
      );
  };

  // Once the newest open reports fill the list, the sidebar's count says how many there are.
  const openCount = reports === null ? 0 : reports.full ? Math.max(open, reports.open.length) : reports.open.length;
  return (
    <section aria-labelledby="reports-heading" aria-busy={reports === null || undefined} className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div>
        <h2 id="reports-heading" className="flex items-center gap-2 text-base font-semibold">
          <TriangleFlag className="size-[18px] shrink-0" />
          Reports{" "}
          {openCount > 0 && <span className="font-normal text-muted-foreground">{openCount} open</span>}
        </h2>
        <p className={NOTE}>Anyone can report someone else’s message, from its More actions, or someone, from their page. Nobody is told who reported them.</p>
      </div>
      {reports &&
        (reports.open.length === 0 ? (
          <p>No open reports.</p>
        ) : (
          <>
            <ul aria-label="Open reports" className="flex flex-col gap-3">
              {reports.open.map((report) => (
                <OpenReport key={report.id} report={report} people={people} busy={handling.has(report.id)} onHandle={(outcome) => handle(report, outcome)} />
              ))}
            </ul>
            {openCount > reports.open.length && <p className={NOTE}>Showing the newest {reports.open.length}. The rest come as these are handled.</p>}
          </>
        ))}
      {reports && reports.handled.length > 0 && (
        <details>
          <summary className="cursor-pointer font-medium touch:-my-3 touch:py-3">Handled ({reports.handled.length})</summary>
          <ul aria-label="Handled reports" className="mt-3 flex flex-col gap-3">
            {reports.handled.map((report) => (
              <HandledReport key={report.id} report={report} people={people} meId={meId} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** An open report: what it's of, who reported it, why and when, with Delete message for a message's, Remove and Ban while they can be, and Dismiss. */
function OpenReport({ report, people, busy, onHandle }: { report: Report; people: People; busy: boolean; onHandle: (outcome: ReportOutcome) => void }) {
  const ofWhom = subjectId(report);
  const name = nameIn(people, ofWhom);
  // Their message went with their account, and nothing brings a deleted account back to remove or ban.
  const accountDeleted = isOfDeletedAccount(report);
  const { remove, ban } = accountDeleted ? { remove: false, ban: false } : handlingsFor(people, ofWhom);
  return (
    <li aria-label={`Report of ${name}`} aria-busy={busy || undefined} className="flex flex-col gap-2.5 rounded-[10px] border bg-background px-[2ch] py-3 max-md:px-3">
      <ReportedBy report={report} people={people} />
      <Subject report={report} />
      <div className="flex flex-wrap gap-2">
        {report.subject.kind === "message" && !accountDeleted && (
          <button type="button" disabled={busy} onClick={() => onHandle("deleted")} className={cn(BUTTON, "text-negative")}>
            Delete message
          </button>
        )}
        {remove && (
          <button type="button" disabled={busy} onClick={() => onHandle("removed")} className={BUTTON}>
            Remove {name}
          </button>
        )}
        {ban && (
          <button type="button" disabled={busy} onClick={() => onHandle("banned")} className={BUTTON}>
            Ban {name}
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => onHandle("dismissed")} className={BUTTON}>
          Dismiss
        </button>
      </div>
    </li>
  );
}

/** A handled report: what it was of, and who handled it, how and when. */
function HandledReport({ report, people, meId }: { report: Report; people: People; meId: UserId }) {
  const { by, at, outcome } = report.handled!;
  return (
    <li className="flex flex-col gap-2 rounded-[10px] border bg-background px-[2ch] py-3 max-md:px-3">
      <p className="text-[0.9em] font-medium">
        {HANDLED_AS[outcome]} by {by === meId ? "you" : nameIn(people, by)}, <time dateTime={at}>{dateTimeLabel(new Date(at))}</time>
      </p>
      <ReportedBy report={report} people={people} />
      <Subject report={report} />
    </li>
  );
}

/** Why it was reported, by whom and when, with the few words they gave. */
function ReportedBy({ report, people }: { report: Report; people: People }) {
  return (
    <div className="flex flex-col gap-1">
      <p className={cn(NOTE, "flex flex-wrap items-center gap-x-[1ch]")}>
        <span className="rounded-full border px-2 font-semibold text-foreground">{REPORT_REASON_LABELS[report.reason]}</span>
        <span>
          Reported by {nameIn(people, report.reporterId)}, <time dateTime={report.reportedAt}>{dateTimeLabel(new Date(report.reportedAt))}</time>
        </span>
      </p>
      {report.note && <p className="wrap-anywhere whitespace-pre-wrap">“{report.note}”</p>}
    </div>
  );
}

/**
 * What a report is of, as it was when reported: the message, by whom, as the people directory names them
 * now, and where, or the person, by the name and bio they had, and the name they have now if it's another.
 */
function Subject({ report }: { report: Report }) {
  const nameOf = useNameOf();
  const { subject } = report;
  if (subject.kind === "person") {
    const { person } = subject;
    const now = nameOf(person);
    return (
      <div className="flex flex-col gap-1 border-s-2 ps-3">
        <p>
          <PageLink href={personPath(person.id)} className="font-semibold hover:underline">
            {person.name}
          </PageLink>
          {now !== person.name && <span className="text-muted-foreground"> (now {now})</span>}
        </p>
        {person.accountDeleted ? (
          <p className={NOTE}>{DELETED_WITH_ACCOUNT.person}</p>
        ) : person.bio ? (
          <p className="wrap-anywhere whitespace-pre-wrap">{person.bio}</p>
        ) : (
          <p className={NOTE}>No bio</p>
        )}
      </div>
    );
  }
  const { message, room } = subject;
  return (
    <div className="flex flex-col gap-1 border-s-2 ps-3">
      <p>
        <PageLink href={personPath(message.creator.id)} className="font-semibold hover:underline">
          {nameOf(message.creator)}
        </PageLink>{" "}
        <span className="text-muted-foreground">{room.kind === "direct" ? "in a direct message" : `in ${room.name ?? "a room"}`}</span>
      </p>
      <MessageText message={message} />
    </div>
  );
}

/**
 * A reported message as it was, as its room showed it, with its file by name, and a bot's cards, whose
 * buttons that act are disabled here, or what's left of it once whoever wrote it deleted their account.
 */
function MessageText({ message }: { message: ReportedMessage }) {
  const shown = useMemo(() => shownBody(message.body, message.plainText), [message.body, message.plainText]);
  return (
    <>
      {message.accountDeleted && <p className={NOTE}>{DELETED_WITH_ACCOUNT.message}</p>}
      {message.body !== "" && (shown ? <MessageBody nodes={shown} mentions={message.mentions} /> : <p className="wrap-anywhere whitespace-pre-wrap">{message.plainText}</p>)}
      {message.attachment && <p className={NOTE}>File: {message.attachment.name}</p>}
      {message.cards && <BotCards cards={message.cards} />}
      <p className={NOTE}>
        Written <time dateTime={message.createdAt}>{dateTimeLabel(new Date(message.createdAt))}</time>
        {message.editedAt && ", edited before it was reported"}
      </p>
    </>
  );
}
