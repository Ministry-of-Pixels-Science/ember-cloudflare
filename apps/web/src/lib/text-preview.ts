import type { StoredFile } from "@ember/protocol";
import { fileUpTo } from "./file-reading";

// Text files shown in messages, as a snippet is: their bytes, read from this site as UTF-8, which a message
// shows as a code block's text, never as markup.

/** The most bytes a text file has for its message to show its text. */
export const MAX_SHOWN_TEXT_SIZE = 64 * 1024;

/** The kinds of text whose types aren't `text/*`: JSON and XML of any sort, scripts, SQL, YAML, TOML and TeX. */
const TEXT_APPLICATIONS = /^application\/(?:(?:[\w.-]+\+)?(?:json|xml)|javascript|x-sh|x-bat|sql|x-yaml|yaml|toml|x-tex|x-latex)$/;

/** Whether a message shows the text of `file`: text, of up to 64 KiB, with something in it. */
export const showsText = ({ contentType, byteSize }: Pick<StoredFile, "contentType" | "byteSize">) =>
  byteSize > 0 && byteSize <= MAX_SHOWN_TEXT_SIZE && (contentType.startsWith("text/") || TEXT_APPLICATIONS.test(contentType));

/** The languages a code block highlights, by the extensions of files written in them: highlight.js's names for them. */
const LANGUAGES = new Map([
  ["sh", "bash"],
  ["bash", "bash"],
  ["zsh", "bash"],
  ["css", "css"],
  ["diff", "diff"],
  ["patch", "diff"],
  ["go", "go"],
  ["java", "java"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["jsx", "javascript"],
  ["json", "json"],
  ["py", "python"],
  ["rb", "ruby"],
  ["rs", "rust"],
  ["sql", "sql"],
  ["html", "xml"],
  ["htm", "xml"],
  ["xml", "xml"],
]);

/** The language a file named `name` is written in, by its extension, where it's one a code block highlights. */
export function languageOf(name: string): string | undefined {
  const extension = /\.([^.]+)$/.exec(name)?.[1];
  return extension && LANGUAGES.get(extension.toLowerCase());
}

/**
 * The text of the file at `url`, of up to 64 KiB, read as UTF-8, or null for an address on another site, a file the
 * site doesn't answer with, a bigger one, or one whose bytes aren't text, as one holding a NUL isn't.
 */
export async function fileText(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const file = await fileUpTo(url, MAX_SHOWN_TEXT_SIZE, signal);
    if (!file) return null;
    const text = await file.text();
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}
