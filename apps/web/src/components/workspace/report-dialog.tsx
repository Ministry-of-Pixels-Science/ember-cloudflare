import { useContext, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { UserId } from "@ember/protocol";
import { MAX_REPORT_NOTE_LENGTH, REPORT_REASON_LABELS, REPORT_REASONS, type ReportReason } from "@ember/protocol/reports";
import { FIELD_INPUT } from "@/components/field";
import { TriangleFlag, UserXmark, Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { BlockingContext } from "@/hooks/use-blocking";
import { PeopleContext, useNameOf } from "@/hooks/use-directory";
import { useMounted } from "@/hooks/use-mounted";
import type { ReportTarget } from "@/hooks/use-reporting";
import { ApiError, isSignedOut, reportMessage, reportPerson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE, MAIN_ACTION, OTHER_ACTION } from "./unsaved-changes";

/** What Report says once the administrators have the report. */
export const REPORTED = "The administrators will take a look.";

/** What Report says when the report didn't reach Ember. */
export const NOT_REPORTED = "Your report couldn’t be sent. Please try again.";

/** What Report says when what it reports is gone by the time it's sent. */
export const GONE: Record<ReportTarget["kind"], string> = { message: "That message has been deleted.", person: "They’re no longer in this community." };

const namesOf = new Intl.ListFormat("en-US", { type: "conjunction" });

/** Who Report says looks at reports, by name, or null when nobody else does. */
export const administratorsNamed = (names: string[]) =>
  names.length === 0 ? null : `${namesOf.format(names)} ${names.length === 1 ? "is this community’s administrator" : "are this community’s administrators"}.`;

/** What Report offers once it's sent, unless they're blocked already. */
export const blockOffer = (name: string) => `You can block ${name} too: their messages collapse for you, and they can’t start a DM with you.`;

/** Why a report wasn't sent, as Report says it: the server's reason, unless it's gone or the server failed. */
function whyUnsent(error: unknown, target: ReportTarget) {
  if (!(error instanceof ApiError) || error.status >= 500) return NOT_REPORTED;
  return error.status === 404 ? GONE[target.kind] : error.message;
}

/** A reason's choice: a radio button and its label, 44px tall for fingers. */
const CHOICE = "flex min-h-9 cursor-pointer items-center gap-2.5 touch:min-h-11 has-disabled:cursor-default";

interface Props {
  target: ReportTarget;
  meId: UserId;
  /** What had focus when Report opened, which gets it back unless `returnFocus` is given. */
  opener: HTMLElement | null;
  /** Focuses what has focus once it closes, in place of `opener`. */
  returnFocus?: () => void;
  /** Called once it has closed. */
  onClose: () => void;
  /** Says the session has ended, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * Report, for someone else's message or for someone, which tells the workspace's administrators: why, as
 * a choice of Spam, Harassment or Something else, with a few words if you like. Once they have it, it
 * says so, names them, and offers to block the person too, unless you have. Nobody is told who reported
 * them. Escape, its × and Cancel close it, but not while it's sending.
 */
export function ReportDialog({ target, meId, opener, returnFocus, onClose, onFailed }: Props) {
  const [open, setOpen] = useState(true);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [reported, setReported] = useState(false);
  const [blockingNow, setBlockingNow] = useState(false);
  const people = useContext(PeopleContext);
  const blocking = useContext(BlockingContext);
  const nameOf = useNameOf();
  const mounted = useMounted();
  const firstReason = useRef<HTMLInputElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const id = useId();
  const person = target.kind === "message" ? target.message.creator : target.person;
  const name = nameOf(person);
  const blocked = blocking.blocked.has(person.id);
  const administrators = administratorsNamed([...people.values()].filter((p) => p.role === "administrator" && p.status === "active" && p.id !== meId).map((p) => p.name));

  // Done takes focus once the report is sent, as the form it replaces had it.
  useEffect(() => {
    if (reported) done.current?.focus();
  }, [reported]);

  const close = () => {
    if (!sending) setOpen(false);
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason || sending) return;
    setSending(true);
    setFailure(null);
    try {
      const report = { reason, note };
      if (target.kind === "message") await reportMessage(target.message.roomId, target.message.id, report);
      else await reportPerson(target.person.id, report);
      if (mounted.current) setReported(true);
    } catch (error) {
      if (isSignedOut(error)) onFailed(error);
      else if (mounted.current) setFailure(whyUnsent(error, target));
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  // Blocking them too closes it once it has, and leaves it open to try again when it hasn't, as the workspace's alert says.
  const block = async () => {
    if (blockingNow) return;
    setBlockingNow(true);
    const did = await blocking.setBlocked(person, true);
    if (!mounted.current) return;
    setBlockingNow(false);
    if (did) setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(open) => open || close()}>
      <DialogContent
        showCloseButton={false}
        aria-busy={sending || blockingNow || undefined}
        overlayClassName={DIALOG_BACKDROP}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          firstReason.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus) returnFocus();
          else opener?.focus({ preventScroll: true });
          onClose();
        }}
        className={DIALOG}
      >
        <button type="button" aria-label="Close" disabled={sending} onClick={close} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <div aria-hidden="true" className="mb-5 grid size-[46px] place-items-center rounded-xl border bg-surface">
          <TriangleFlag className="size-[22px]" />
        </div>
        {reported ? (
          <>
            <DialogTitle className={DIALOG_TITLE}>Reported</DialogTitle>
            <DialogDescription className="leading-[1.65]">{REPORTED}</DialogDescription>
            {administrators && <p className="mt-2 leading-[1.65]">{administrators}</p>}
            {!blocked && <p className="mt-4 leading-[1.65] text-muted-foreground">{blockOffer(name)}</p>}
            <div className="mt-[26px] flex flex-wrap justify-end gap-2.5">
              {!blocked && (
                <button type="button" disabled={blockingNow} onClick={() => void block()} className={cn(OTHER_ACTION, "min-w-0 gap-2")}>
                  <UserXmark className="size-[18px] flex-none" />
                  <span className="min-w-0 truncate">Block {name}</span>
                </button>
              )}
              <button ref={done} type="button" onClick={close} className={MAIN_ACTION}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={(event) => void send(event)}>
            <DialogTitle className={DIALOG_TITLE}>{target.kind === "message" ? "Report message" : `Report ${name}`}</DialogTitle>
            <DialogDescription className="leading-[1.65]">
              {target.kind === "message"
                ? `The administrators will see ${name}’s message as it is now. Nobody is told who reported it.`
                : "For their name, picture or bio. Nobody is told who reported them."}
            </DialogDescription>
            <fieldset disabled={sending} className="mt-4 flex flex-col">
              <legend className="mb-1 font-semibold">Why are you reporting {target.kind === "message" ? "it" : "them"}?</legend>
              {REPORT_REASONS.map((choice, index) => (
                <label key={choice} className={CHOICE}>
                  <input
                    ref={index === 0 ? firstReason : undefined}
                    type="radio"
                    name={`${id}-reason`}
                    required
                    checked={reason === choice}
                    onChange={() => setReason(choice)}
                    className="size-4 flex-none accent-foreground"
                  />
                  <span>{REPORT_REASON_LABELS[choice]}</span>
                </label>
              ))}
            </fieldset>
            <label htmlFor={`${id}-note`} className="mt-3 mb-1.5 block font-semibold">
              Details <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <textarea
              id={`${id}-note`}
              rows={3}
              maxLength={MAX_REPORT_NOTE_LENGTH}
              disabled={sending}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className={cn("w-full resize-y border placeholder:text-muted-foreground disabled:opacity-50", FIELD_INPUT)}
            />
            {failure && (
              <p role="alert" className="mt-4 text-sm leading-[1.65] text-negative">
                {failure}
              </p>
            )}
            <div className="mt-[26px] flex justify-end gap-2.5">
              <button type="button" disabled={sending} onClick={close} className={OTHER_ACTION}>
                Cancel
              </button>
              <button type="submit" disabled={sending} className={MAIN_ACTION}>
                {sending ? "Reporting…" : "Report"}
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
