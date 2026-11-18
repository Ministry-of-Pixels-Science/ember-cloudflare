import { useCallback, useEffect, useState } from "react";
import { isNewer, type ReleaseCheck } from "@ember/protocol";
import { checkForRelease, checkForReleaseAfresh } from "@/lib/api";
import { whenIdle } from "@/lib/idle";
import type { NamedRelease } from "@/lib/release-check";

/** What the Worker says of Ember's releases, and Check for updates, which asks it afresh. */
export interface ReleaseChecking {
  /** The release this Ember is and the newest one GitHub names, or null until the Worker answers, and for anyone but an administrator. */
  check: ReleaseCheck | null;
  /** Has the Worker ask GitHub again, as Check for updates does, settling once it's answered, or failing as asking failed. */
  checkAgain: () => Promise<void>;
}

/**
 * For an administrator, the release this Ember is and the newest one GitHub names, which the Worker is
 * asked for once the page is `ready` and the browser is idle, and again for someone made an
 * administrator. Each time they open Admin (`inAdmin` on every page of community settings) it's asked
 * afresh, having the Worker ask GitHub again, as the project's owner asked (2026-11-05), though going on
 * to another of its pages, or leaving it, asks nothing. Check for updates, which he asked for too
 * (2026-11-11), asks afresh at once. Null until it answers, and for anyone else, or when asking fails,
 * which nothing but Check for updates waits on.
 */
export function useReleaseCheck(administrator: boolean, ready: boolean, inAdmin: boolean): ReleaseChecking {
  const [check, setCheck] = useState<ReleaseCheck | null>(null);
  // How many times Admin has opened since the page loaded.
  const [admin, setAdmin] = useState({ open: inAdmin, openings: 0 });
  if (admin.open !== inAdmin) setAdmin({ open: inAdmin, openings: admin.openings + (inAdmin ? 1 : 0) });
  const asking = administrator && ready;
  // Each of the Worker's isolates keeps what GitHub told it, so answers can disagree, and opening Admin's
  // can answer after Check for updates', so each is put together with what was heard before.
  const heard = useCallback((answer: ReleaseCheck) => setCheck((kept) => (kept ? together(kept, answer) : answer)), []);
  // Not run for `inAdmin` itself, so that leaving Admin doesn't ask, but whenever this runs in Admin, it's
  // for opening it, or for the page becoming ready, or someone made an administrator, there.
  useEffect(() => {
    if (!asking) return;
    let current = true;
    const ask = inAdmin ? checkForReleaseAfresh : checkForRelease;
    const cancel = whenIdle(
      () =>
        void ask().then(
          (answer) => current && heard(answer),
          () => {},
        ),
    );
    return () => {
      current = false;
      cancel();
    };
  }, [asking, admin.openings]);
  const checkAgain = useCallback(() => checkForReleaseAfresh().then(heard), [heard]);
  return { check: administrator ? check : null, checkAgain };
}

/**
 * What the answers `kept` and `answer` say together. An isolate asks GitHub for the newest release apart
 * from listing the tags for the newest beta, and says what it heard of either before when asking for it
 * fails, so either answer can know the later release, and either the later beta, whenever each heard. A
 * release or a beta once out stays out, so together they name the later release either names, with when
 * GitHub last named it, and the later beta either names, while it's ahead of that release. An answer from
 * this Ember as another release, once one is deployed, replaces what was heard before.
 */
function together(kept: ReleaseCheck, answer: ReleaseCheck): ReleaseCheck {
  if (answer.release !== kept.release) return answer;
  const release = namesLaterRelease(kept, answer) ? kept : answer;
  const beta = laterOf(kept.newestBeta, answer.newestBeta);
  const ahead = beta && release.newest && isNewer(beta.version, release.newest.version);
  return { ...release, newestBeta: ahead ? beta : null };
}

/** Whether `kept` names a later release than `answer` does, or the same one, heard from GitHub after it. */
function namesLaterRelease(kept: ReleaseCheck, answer: ReleaseCheck): boolean {
  const [ours, theirs] = [kept.newest, answer.newest];
  if (ours && theirs && ours.version !== theirs.version) return isNewer(ours.version, theirs.version);
  return (answer.checkedAt ?? "") < (kept.checkedAt ?? "");
}

/** The later of two betas, where an answer may name none. */
const laterOf = (one: NamedRelease | null, other: NamedRelease | null) => (one && other && isNewer(other.version, one.version) ? other : (one ?? other));
