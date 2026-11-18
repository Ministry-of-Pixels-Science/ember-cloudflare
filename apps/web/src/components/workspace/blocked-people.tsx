import { useContext, useMemo, useState } from "react";
import type { DirectoryUser, UserId } from "@ember/protocol";
import { PageLink } from "@/components/page-link";
import { BlockingContext } from "@/hooks/use-blocking";
import { PeopleContext } from "@/hooks/use-directory";
import { useMounted } from "@/hooks/use-mounted";
import { personPath } from "@/hooks/use-route";
import { byName } from "@/lib/people";
import { BUTTON } from "./email-settings";
import { UserAvatar } from "./user-avatar";

/** What the section says of blocking, which the person blocked is never told of. */
export const BLOCKED_PEOPLE_EXPLAINED =
  "Their messages are collapsed for you, they can't notify you or start a direct message with you, and they aren't told.";

/**
 * Blocked people on your profile, while the people directory lists anyone you've blocked: each by name,
 * as settings list people, a link to their page, with Unblock. Boxed as Apps is.
 */
export function BlockedPeople() {
  const { blocked, setBlocked } = useContext(BlockingContext);
  const people = useContext(PeopleContext);
  /** Whom Unblock is waiting on the server for, which a second click doesn't ask again. */
  const [unblocking, setUnblocking] = useState<UserId | null>(null);
  const mounted = useMounted();
  const listed = useMemo(() => byName([...blocked].flatMap((id) => people.get(id) ?? [])), [blocked, people]);
  if (listed.length === 0) return null;

  const unblock = (person: DirectoryUser) => {
    setUnblocking(person.id);
    void setBlocked(person, false).finally(() => mounted.current && setUnblocking(null));
  };

  return (
    <section aria-labelledby="blocked-people-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 max-md:px-3">
      <h2 id="blocked-people-heading" className="text-base font-semibold">
        Blocked people
      </h2>
      <p>{BLOCKED_PEOPLE_EXPLAINED}</p>
      <ul className="flex flex-col gap-3">
        {listed.map((person) => (
          <li key={person.id} className="flex items-center justify-between gap-x-4">
            <PageLink href={personPath(person.id)} className="flex min-w-0 items-center gap-x-[1ch] text-foreground no-underline hover:underline">
              <UserAvatar user={person} />
              <span className="truncate font-semibold">{person.name}</span>
            </PageLink>
            <button type="button" disabled={unblocking !== null} aria-label={`Unblock ${person.name}`} onClick={() => unblock(person)} className={BUTTON}>
              Unblock
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
