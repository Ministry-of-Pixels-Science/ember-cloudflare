import { describe, expect, it } from "vitest";
import {
  BLOCKED_WORDS_NOT_A_LIST,
  blockedWordsCheck,
  blockedWordsRefusal,
  blockedWordsTyped,
  blockedWordTooLong,
  blockedWordUnmatchable,
  MAX_BLOCKED_WORD_LENGTH,
  MAX_BLOCKED_WORDS,
  parseBlockedWords,
  TOO_MANY_BLOCKED_WORDS,
  wordsOf,
} from "./blocked-words";

describe("wordsOf", () => {
  it("reads runs of letters and numbers, lowercased and without accents", () => {
    expect(wordsOf("Café crème, s'il vous plaît!")).toEqual(["cafe", "creme", "s", "il", "vous", "plait"]);
    expect(wordsOf("Việt Nam 2026 İstanbul")).toEqual(["viet", "nam", "2026", "istanbul"]);
    // As Unicode folds case: a final sigma is any sigma, and ß the "SS" capitals write.
    expect(wordsOf("ΣΟΣ σοσ σος Straße STRASSE STRAẞE")).toEqual(["σοσ", "σοσ", "σοσ", "strasse", "strasse", "strasse"]);
  });

  it("reads letters drawn another way as the letters they are, and sees past what's invisible", () => {
    expect(wordsOf("ＦＵＤＧＥ 𝐟𝐮𝐝𝐠𝐞 Ⓕⓤⓓⓖⓔ")).toEqual(["fudge", "fudge", "fudge"]);
    // Capitals with no lowercase of their own, as mathematical and squared ones are, too.
    expect(wordsOf("𝐅𝐔𝐃𝐆𝐄 f𝐔dge 🄵🅄🄳🄶🄴 ℌ")).toEqual(["fudge", "fudge", "fudge", "h"]);
    expect(wordsOf("fu​dge fu­dge")).toEqual(["fudge", "fudge"]);
  });

  it("keeps the marks that make other words, as Devanagari's vowels and the voicing of kana do", () => {
    expect(wordsOf("हिंदी भाषा")).toEqual(["हिंदी", "भाषा"]);
    expect(wordsOf("バカ")).not.toEqual(wordsOf("ハカ"));
    expect(wordsOf("ﾊﾞｶ")).toEqual(wordsOf("バカ"));
  });

  it("reads each emoji, a flag too, and each character of a script written without spaces, as a word", () => {
    expect(wordsOf("🖕🏻🖕 ❤️")).toEqual(["🖕", "🖕", "❤"]);
    // A flag is two regional indicators, read two at a time, as they're drawn; one left over is a letter in a box.
    expect(wordsOf("🇧🇧 go🇺🇸🇬🇧 🇦")).toEqual(["🇧🇧", "go", "🇺🇸", "🇬🇧", "🇦"]);
    expect(wordsOf("你是笨蛋吗")).toEqual(["你", "是", "笨", "蛋", "吗"]);
  });
});

describe("blockedWordsCheck", () => {
  const blocks = blockedWordsCheck(["fudge", "Darn it", "🖕", "笨蛋", "s.h.i.p"]);

  it("finds a word whole, whatever its case or accents, and nowhere inside a longer one", () => {
    for (const text of ["fudge", "Oh FUDGE!", "fúdgé", "(fudge)", "ＦＵＤＧＥ", "fu​dge"]) expect(blocks(text)).toBe(true);
    for (const text of ["fudgesicle", "refudge", "fudg e", "", "nothing here"]) expect(blocks(text)).toBe(false);
  });

  it("finds a phrase's words in order, with anything but letters and numbers between them", () => {
    for (const text of ["darn it", "Darn, it.", "darn-it", "darn\nit", "well DARN   it all"]) expect(blocks(text)).toBe(true);
    for (const text of ["darn", "it darn", "darnit", "darn that it"]) expect(blocks(text)).toBe(false);
    expect(blocks("s h i p")).toBe(true);
    expect(blocks("ship")).toBe(false);
  });

  it("finds a phrase's words with emoji between them, and a phrase with an emoji in it as it's written", () => {
    for (const text of ["darn 🖕 it", "darn🔥🔥it", "Darn ©️ it!", "darn 🇺🇸 it"]) expect(blocks(text)).toBe(true);
    const emojiPhrases = blockedWordsCheck(["🖕 you", "go 🔥"]);
    for (const text of ["🖕 you", "🖕🏻you", "let's go 🔥🔥"]) expect(emojiPhrases(text)).toBe(true);
    for (const text of ["🖕 😀 you", "go 😀 🔥", "go away 🔥"]) expect(emojiPhrases(text)).toBe(false);
  });

  it("finds a flag as it's drawn, and a phrase with one in it as it's written", () => {
    const flags = blockedWordsCheck(["🇧🇧", "go 🇺🇸"]);
    for (const text of ["Barbados 🇧🇧!", "🇬🇧🇧🇧", "let's go 🇺🇸🇺🇸"]) expect(flags(text)).toBe(true);
    // 🇦🇧🇧🇩 draws A and B in boxes, then Bangladesh's flag, not Barbados's.
    for (const text of ["🇦🇧🇧🇩", "let's go", "go 🇬🇧"]) expect(flags(text)).toBe(false);
  });

  it("finds an emoji, whatever its skin tone, and a word of a script written without spaces inside a sentence", () => {
    expect(blocks("ok 🖕🏽")).toBe(true);
    expect(blocks("你是笨蛋吗")).toBe(true);
    expect(blocks("笨")).toBe(false);
  });

  it("finds nothing with nothing blocked", () => {
    expect(blockedWordsCheck([])("fudge")).toBe(false);
  });
});

describe("blockedWordsTyped", () => {
  it("reads one a line or apart by commas, trimmed, with single spaces, once each, leaving out blanks", () => {
    expect(blockedWordsTyped("fudge\n  darn   it ,heck\n\n,,Fudge\nfúdge\n")).toEqual(["fudge", "darn it", "heck"]);
    expect(blockedWordsTyped("  \n , ")).toEqual([]);
  });
});

describe("blockedWordsRefusal", () => {
  it("names a word too long, or with nothing to match, and takes the rest", () => {
    expect(blockedWordsRefusal(["fudge", "🔥".repeat(MAX_BLOCKED_WORD_LENGTH)])).toBeNull();
    expect(blockedWordsRefusal(["fudge", "x".repeat(MAX_BLOCKED_WORD_LENGTH + 1)])).toBe(blockedWordTooLong("x".repeat(MAX_BLOCKED_WORD_LENGTH + 1)));
    expect(blockedWordsRefusal(["fudge", "!!!"])).toBe(blockedWordUnmatchable("!!!"));
  });

  it("takes as many as can be blocked, and no more", () => {
    const words = Array.from({ length: MAX_BLOCKED_WORDS + 1 }, (_, index) => `word${index}`);
    expect(blockedWordsRefusal(words.slice(1))).toBeNull();
    expect(blockedWordsRefusal(words)).toBe(TOO_MANY_BLOCKED_WORDS);
  });
});

describe("parseBlockedWords", () => {
  it("keeps a list of text as Blocked words keeps it", () => {
    expect(parseBlockedWords([" fudge ", "darn  it", "FUDGE", ""])).toEqual(["fudge", "darn it"]);
    expect(parseBlockedWords(["🇧🇧", "go", "go 🇧🇧"])).toEqual(["🇧🇧", "go", "go 🇧🇧"]);
    expect(parseBlockedWords([])).toEqual([]);
  });

  it("refuses anything but a list of text, and what it can't block", () => {
    for (const value of ["fudge", null, {}, [1], ["fudge", null]]) expect(parseBlockedWords(value)).toEqual({ error: BLOCKED_WORDS_NOT_A_LIST });
    expect(parseBlockedWords(["?!"])).toEqual({ error: blockedWordUnmatchable("?!") });
    expect(parseBlockedWords(Array.from({ length: MAX_BLOCKED_WORDS * 2 + 1 }, () => "fudge"))).toEqual({ error: TOO_MANY_BLOCKED_WORDS });
  });
});
