import { createContext, useCallback, useContext, useState } from "react";
import type { DirectoryUser, User, UserId } from "@ember/protocol";
import { fetchDirectory, type DirectoryCopy } from "@/lib/api";
import { oneAtATime } from "./use-sidebar";

/** Everyone in the workspace by id, as the people directory last listed them. */
export type People = ReadonlyMap<UserId, DirectoryUser>;

/** The people directory, for avatars to find their images in. Empty until it loads. */
export const PeopleContext = createContext<People>(new Map());

/**
 * Whether the people directory has loaded, and so lists everyone. Until then it lists no one, or only
 * those the workspace socket said had changed.
 */
export const DirectoryLoaded = createContext(false);

/**
 * Someone's name as the people directory lists them now, which follows a rename since their name was
 * copied into a message, a boost or a room's frame, or the copy's until the directory lists them.
 */
export function useNameOf(): (user: User) => string {
  const people = useContext(PeopleContext);
  return useCallback((user: User) => people.get(user.id)?.name ?? user.name, [people]);
}

/**
 * Someone a message mentions: as the people directory lists them now, or as the message named them
 * (`mentions`) until the directory lists them, or no one, where neither knows them. A message from
 * before messages named the people they mention knows them by id alone, with no name.
 */
export function mentionedPerson(people: People, mentions: User[], userId: UserId): User | undefined {
  return people.get(userId) ?? mentions.find((person) => person.id === userId && person.name !== "");
}

/** What's become of someone: how they are now, or their id, once this person is no longer told of them. */
type Change = DirectoryUser | UserId;

/** `people` after each of `changes`, in the order they came. */
function withChanges(people: People, changes: Change[]): People {
  const next = new Map(people);
  for (const change of changes) {
    if (typeof change === "string") next.delete(change);
    else next.set(change.id, change);
  }
  return next;
}

/**
 * The people directory, which `reload` loads again, one load at a time, settling once a load asked for
 * since has come or failed, `update` changes someone in, as the workspace socket or a change made
 * here says they are now, and `remove` takes someone out of, once the socket says this person is no
 * longer told of them. The people stay as they were when a load fails or the server says they haven't
 * changed. It has `loaded` once a load has come.
 */
export function useDirectory(): { people: People; loaded: boolean; reload: () => Promise<void>; update: (user: DirectoryUser) => void; remove: (userId: UserId) => void } {
  const [people, setPeople] = useState<People>(() => new Map());
  const [loaded, setLoaded] = useState(false);
  const [directory] = useState(() => {
    // The last directory the server sent, which it says is still current rather than send again.
    let copy: DirectoryCopy | null = null;
    // What became of people while a load was on its way, which may have read them before it did.
    let changedSince: Change[] | null = null;
    const load = oneAtATime(async () => {
      const changed: Change[] = (changedSince = []);
      try {
        const loaded = await fetchDirectory(copy);
        if (loaded === copy) return;
        copy = loaded;
        setPeople(withChanges(new Map(loaded.directory.users.map((user) => [user.id, user])), changed));
        setLoaded(true);
      } finally {
        changedSince = null;
      }
    });
    const make = (change: Change) => {
      changedSince?.push(change);
      setPeople((people) => withChanges(people, [change]));
    };
    return { reload: load, update: (user: DirectoryUser) => make(user), remove: (userId: UserId) => make(userId) };
  });
  return { people, loaded, ...directory };
}
