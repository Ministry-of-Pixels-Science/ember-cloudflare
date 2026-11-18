// The words Blocked words keeps out, as the Workspace and each room keep them to check what they save
// against. The Workspace keeps the list with the account; a room keeps what the Workspace last gave it,
// asking again after a while, or as soon as a message it saves comes back with another version, so that
// messages don't wait on the Workspace.

import { crc32 } from "@ember/protocol";
import { blockedWordsCheck, type BlockedWordsCheck } from "@ember/protocol/blocked-words";

/** Blocked words as the Workspace gives them to a room: the list, and its version. */
export interface BlockedWords {
  version: string;
  words: string[];
}

/** The list a room keeps, checked as `check` does, from when it heard of it. */
export interface KeptBlockedWords {
  version: string;
  check: BlockedWordsCheck;
  heardAt: number;
}

/** How long a room goes by the list it keeps before asking the Workspace for it again. */
export const BLOCKED_WORDS_KEPT_MS = 60_000;

/** A list's version: the same for the same list, and all but always another for another. */
export const blockedWordsVersion = (words: readonly string[]) => `${words.length}.${crc32(JSON.stringify(words))}`;

/** No blocked words, which a room goes by while the Workspace can't be reached until it has heard of some. */
export const NO_BLOCKED_WORDS: BlockedWords = { version: blockedWordsVersion([]), words: [] };

/** Whether `kept` is still the list to go by at `now`: it's recent enough, as `BLOCKED_WORDS_KEPT_MS` has it. */
export const isFresh = (kept: KeptBlockedWords | null, now: number): kept is KeptBlockedWords => kept !== null && now - kept.heardAt < BLOCKED_WORDS_KEPT_MS;

/** What a room keeps of `given`, heard of at `now`. */
export const keptBlockedWords = ({ version, words }: BlockedWords, now: number): KeptBlockedWords => ({ version, check: blockedWordsCheck(words), heardAt: now });

/**
 * `kept`, once the room has heard it's changed: to be asked for again at the next check, as if heard of
 * long ago, but still the list to go by if the Workspace can't be reached then.
 */
export const outdated = (kept: KeptBlockedWords): KeptBlockedWords => ({ ...kept, heardAt: -Infinity });
