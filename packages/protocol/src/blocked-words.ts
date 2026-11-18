// Blocked words, which an administrator lists in Membership, as Apple asks of every app where people
// post: a message, a reaction, a file's or a room's name, or someone's name, username or bio with one of
// them isn't saved. Words match whole, ignoring case and accents, so a short word doesn't catch longer
// ones, and a phrase matches its words in order, with anything but letters and numbers between them. The
// Worker checks them, so no client can get round them, and only administrators see the list.

/** How many words and phrases a community can block. */
export const MAX_BLOCKED_WORDS = 500;

/** The most characters each can have. */
export const MAX_BLOCKED_WORD_LENGTH = 60;

/** Why a message, a reaction, a file's or a room's name, or a name, username or bio with a blocked word isn't saved. */
export const BLOCKED_WORDS_REFUSED = "This community doesn't allow one of these words.";

export const BLOCKED_WORDS_NOT_A_LIST = "Blocked words must be a list of words and phrases.";
export const TOO_MANY_BLOCKED_WORDS = `Blocked words can list at most ${MAX_BLOCKED_WORDS} words and phrases.`;

/** Why a word or phrase can't be blocked: it's too long, or there's nothing in it to match. */
export const blockedWordTooLong = (word: string) => `“${word}” is longer than ${MAX_BLOCKED_WORD_LENGTH} characters.`;
export const blockedWordUnmatchable = (word: string) => `“${word}” has no letters, numbers or emoji to match.`;

/**
 * The marks a word is read without: accents, as Latin, Greek and Cyrillic letters take them, and the
 * selectors that pick how an emoji is drawn. Other scripts' marks, such as Devanagari's vowels or the
 * voicing of kana, make other words, so they stay.
 */
const IGNORED_MARKS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︀-️︠-︯\u{e0100}-\u{e01ef}]/gu;

/** Characters that show as nothing, such as zero-width spaces, which would split a word unseen. */
const INVISIBLE = /\p{Cf}/gu;

/**
 * What's a word on its own: an emoji, or a character of a script written without spaces between its
 * words, whose words a blocked word would otherwise never match whole.
 */
const OWN_WORD = String.raw`[\p{Extended_Pictographic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]`;

/** A word: one of those, with any marks it takes, or else a run of letters, numbers and marks. */
const WORD = new RegExp(String.raw`${OWN_WORD}\p{M}*|(?:(?!${OWN_WORD})[\p{L}\p{N}\p{M}])+`, "gu");

/**
 * The words of `text` as blocked words match them: lowercased, without accents, compatibility forms,
 * such as fullwidth or mathematical letters, read as their letters, and with nothing invisible.
 */
export function wordsOf(text: string): string[] {
  // Lowercased once read as letters, since a mathematical or squared capital has no lowercase of its own.
  const folded = text.normalize("NFKD").toLowerCase().replace(IGNORED_MARKS, "").replace(INVISIBLE, "").normalize("NFC");
  return folded.match(WORD) ?? [];
}

/** A blocked word or phrase as it's kept: trimmed, with single spaces. */
const keptWord = (word: string) => word.replace(/\s+/g, " ").trim();

/** Which word or phrase `word` blocks, as two that block the same are one. */
const blockedKey = (word: string) => wordsOf(word).join(" ");

/** The words and phrases `words` lists, each as it's kept and once, leaving out blanks. */
function blockedWordsIn(words: readonly string[]): string[] {
  const kept = new Map<string, string>();
  for (const word of words.map(keptWord)) {
    // One with nothing to match stays as it is, for `blockedWordsRefusal` to name.
    const key = blockedKey(word) || word;
    if (word !== "" && !kept.has(key)) kept.set(key, word);
  }
  return [...kept.values()];
}

/** The words and phrases a list typed in Membership gives, one a line or apart by commas, as `blockedWordsIn` keeps them. */
export const blockedWordsTyped = (typed: string) => blockedWordsIn(typed.split(/[\n,]/));

/** Why `words`, as kept, can't be the community's blocked words, naming one that can't be blocked, or null when they can. */
export function blockedWordsRefusal(words: readonly string[]): string | null {
  if (words.length > MAX_BLOCKED_WORDS) return TOO_MANY_BLOCKED_WORDS;
  const long = words.find((word) => [...word].length > MAX_BLOCKED_WORD_LENGTH);
  if (long !== undefined) return blockedWordTooLong(long);
  const unmatchable = words.find((word) => wordsOf(word).length === 0);
  return unmatchable === undefined ? null : blockedWordUnmatchable(unmatchable);
}

/**
 * The blocked words `PATCH /api/account` is given, in place of those the community had: a list of text,
 * each kept trimmed, with single spaces, and once, or why they're refused.
 */
export function parseBlockedWords(value: unknown): string[] | { error: string } {
  if (!Array.isArray(value) || !value.every((word) => typeof word === "string")) return { error: BLOCKED_WORDS_NOT_A_LIST };
  // Many more than are kept could be the same few, so the list is counted as given, too.
  if (value.length > MAX_BLOCKED_WORDS * 2) return { error: TOO_MANY_BLOCKED_WORDS };
  const words = blockedWordsIn(value);
  const refusal = blockedWordsRefusal(words);
  return refusal === null ? words : { error: refusal };
}

/** Whether a text has a blocked word or phrase in it. */
export type BlockedWordsCheck = (text: string) => boolean;

/** What checks a text for the words and phrases `blocked` lists, which it finds whole, in order, as `wordsOf` reads them. */
export function blockedWordsCheck(blocked: readonly string[]): BlockedWordsCheck {
  // The words of each, by its first.
  const byFirst = new Map<string, string[][]>();
  for (const words of blocked.map(wordsOf)) {
    if (words.length > 0) byFirst.set(words[0]!, [...(byFirst.get(words[0]!) ?? []), words]);
  }
  if (byFirst.size === 0) return () => false;
  return (text) => {
    const words = wordsOf(text);
    return words.some((first, at) => byFirst.get(first)?.some((phrase) => phrase.every((word, offset) => words[at + offset] === word)));
  };
}
