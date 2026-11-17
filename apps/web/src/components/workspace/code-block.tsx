import { createElement, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { DisplayElement } from "@ember/richtext/dom";
import { Copy } from "@/components/icons/iconoir";
import { copyWithSuccess } from "@/lib/clipboard";
import type { Token } from "@/lib/highlight";
import { marked, SearchMarks } from "./search-marks";

type Highlighter = typeof import("@/lib/highlight");

let highlighter: Highlighter | undefined;
let loading: Promise<Highlighter> | undefined;

/** highlight.js and its languages, loaded the first time a message has code to highlight. */
function loadHighlighter(): Promise<Highlighter> {
  loading ??= import("@/lib/highlight").then(
    (module) => (highlighter = module),
    (error: unknown) => {
      // The next code block tries again.
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

/** The highlighter once it's loaded, which it loads when `wanted`. */
function useHighlighter(wanted: boolean): Highlighter | undefined {
  const [loaded, setLoaded] = useState(highlighter);
  useEffect(() => {
    if (!wanted || loaded) return;
    let current = true;
    loadHighlighter().then(
      (module) => current && setLoaded(module),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [wanted, loaded]);
  return loaded;
}

/** A code block's code when it holds only text, its `<br>`s read as newlines; null when it holds anything else. */
function codeOf(block: DisplayElement): string | null {
  let code = "";
  for (const child of block.children) {
    if (child.kind === "text") code += child.value;
    else if (child.kind === "element" && child.name === "br") code += "\n";
    else return null;
  }
  return code;
}

/** The elements a message can hold that start a line of their own, as a bot's `<div>` lines in a code block do. */
const BLOCKS = new Set(["ADDRESS", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "OL", "P", "PRE", "TABLE", "TR", "UL"]);

/**
 * `node`'s text as it reads, its `<br>`s and the lines its blocks start as newlines, which `textContent`
 * would drop, and none of what the page hides, as it does an empty `<p>`.
 */
function textOf(node: Node): string {
  if (node.nodeName === "BR") return "\n";
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  let text = "";
  // Whether what comes next starts a line, as a block and whatever follows one do.
  let broken = false;
  for (const child of node.childNodes) {
    if (child instanceof Element && getComputedStyle(child).display === "none") continue;
    const block = BLOCKS.has(child.nodeName);
    if (block) broken = true;
    const part = textOf(child);
    if (part === "") continue;
    if (broken && text !== "" && !text.endsWith("\n")) text += "\n";
    text += part;
    broken = block;
  }
  return text;
}

/** `token` as React draws it, with what `marks` matches in its text marked. */
const tokenNode = (token: Token, marks: RegExp | null): ReactNode =>
  typeof token === "string"
    ? marked(token, marks)
    : createElement("span", { className: token.className }, ...token.children.map((child) => tokenNode(child, marks)));

/** A code block's Copy code, which the bar over a message rises above rather than cover. */
export const COPY_CODE = "[data-copy-code]";

/**
 * A message's code block, highlighted once highlight.js has loaded, as Campfire's `MessageFormatter`
 * highlights one (app/javascript/models/message_formatter.js): only when it holds nothing but text, so
 * not when an address in it is linked. What a search's results mark in it stays marked.
 */
export function CodeBlock({ block, children, ...props }: ComponentProps<"pre"> & { block: DisplayElement }) {
  return (
    <Code code={codeOf(block)} language={block.attrs["data-language"]} {...props}>
      {children}
    </Code>
  );
}

/**
 * Code shown as a code block, with Copy code: `code`, its text, highlighted once highlight.js has loaded, in
 * `language` or the one it reads as, unless it's `plain`, and `children` where it holds more than text, as
 * `code` null says it does. Copy code copies `copied` where it's given, as a file's text is copied as the
 * file has it, its line ends and last newline kept, and otherwise what it shows.
 */
export function Code({ code, copied, language, plain = false, children, ...props }: ComponentProps<"pre"> & { code: string | null; copied?: string; language?: string; plain?: boolean }) {
  const pre = useRef<HTMLPreElement>(null);
  const highlighter = useHighlighter(code !== null && !plain);
  const marks = useContext(SearchMarks);
  const tokens = useMemo(() => (highlighter && code !== null && !plain ? highlighter.highlight(code, language) : null), [highlighter, code, language, plain]);
  return createElement(
    "div",
    { className: "code-block group/code relative" },
    createElement("pre", { ...props, ref: pre }, ...(tokens ? tokens.map((token) => tokenNode(token, marks)) : [children])),
    <button
      type="button"
      aria-label="Copy code"
      data-copy-code
      className="absolute top-1.5 right-1.5 flex size-8 cursor-pointer items-center justify-center rounded-[6px] bg-background text-muted-foreground opacity-0 hover:bg-hover group-hover/code:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground touch:size-11 touch:opacity-100 [&_svg]:size-4"
      onClick={(event) => void copyWithSuccess(event.currentTarget, copied ?? code ?? (pre.current ? textOf(pre.current) : ""))}
    >
      <Copy />
    </button>,
  );
}
