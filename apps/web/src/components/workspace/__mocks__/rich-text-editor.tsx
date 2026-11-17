import { bodyFromPlainText, writtenBody } from "@ember/richtext/dom";
import { createElement, useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { PLAIN_TEXT, type FormattingCommand, type TextFormat } from "@/lib/formatting";
import type Editor from "../rich-text-editor";

/** What Lexxy holds while nothing's written. */
const EMPTY = "<p><br></p>";

/** What Lexxy takes for an address, pasted alone. */
const ADDRESS = /^(?:[a-z0-9]+:\/\/|www\.)\S+$/i;

/** An attachment added below a pasted link, which Lexxy shows with its content and writes after the text. */
interface Attachment {
  contentType: string;
  html: string;
}

/** The formatting a command leaves, as Lexxy would leave it where the cursor is. */
function formatAfter(format: TextFormat, command: FormattingCommand): TextFormat {
  switch (command) {
    case "paragraph":
      return { ...format, heading: null };
    case "h1":
    case "h2":
    case "h3":
      return { ...format, heading: command };
    case "orderedList":
      return { ...format, list: format.list === "ordered" ? null : "ordered" };
    case "bulletedList":
      return { ...format, list: format.list === "bulleted" ? null : "bulleted" };
    case "divider":
      return format;
    default:
      return { ...format, [command]: !format[command] };
  }
}

const attachmentMarkup = ({ contentType, html }: Attachment) =>
  `<action-text-attachment content="${html.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}" content-type="${contentType}"></action-text-attachment>`;

/**
 * Lexxy's stand-in in unit tests, which test-setup.ts swaps in because Lexxy doesn't keep what's
 * written under jsdom: a text box whose lines are one paragraph of Lexxy's markup, which tells of
 * changes and keys as the editor does, and of addresses pasted in it, below which it shows what's
 * added. Formatting changes only the formatting it tells of, and a link only the text, which it
 * marks `data-linked` with the address. It lists nobody for an @, and is marked `data-mentions-above`
 * where the list is to show above the text. The browser tests in e2e/ write in Lexxy itself.
 */
export default function RichTextEditor({ label, placeholder, rows, initialValue, mentionsAbove, autoFocus, onChange, onFormatChange, onKeyDown, onLinkPasted, onReady, ref }: ComponentProps<typeof Editor>) {
  const box = useRef<HTMLTextAreaElement>(null);
  // Read as soon as they change, as Lexxy's are, and shown once React renders them.
  const attachments = useRef<Attachment[]>([]);
  const [shown, show] = useState<Attachment[]>([]);
  const attach = (added: Attachment[]) => {
    attachments.current = added;
    show(added);
  };
  const format = useRef(PLAIN_TEXT);
  const formatted = (next: TextFormat) => {
    format.current = next;
    onFormatChange?.(next);
  };

  useImperativeHandle(ref, () => ({
    value: () => (box.current?.value ? bodyFromPlainText(box.current.value) : EMPTY) + attachments.current.map(attachmentMarkup).join(""),
    clear: () => {
      if (!box.current?.value && attachments.current.length === 0) return;
      box.current!.value = "";
      attach([]);
      onChange?.();
    },
    isBlank: () => !box.current?.value.trim(),
    hasOpenPrompt: () => false,
    focus: () => box.current?.focus(),
    replace: (markup) => {
      const text = box.current!;
      text.value = writtenBody(markup).plainText;
      attach([]);
      onChange?.();
      text.focus();
      text.setSelectionRange(text.value.length, text.value.length);
    },
    apply: (command) => formatted(formatAfter(format.current, command)),
    linkDraft: () => {
      const text = box.current!;
      return { text: text.value.slice(text.selectionStart, text.selectionEnd), url: text.dataset.linked ?? "" };
    },
    link: ({ text, url }) => {
      box.current!.setRangeText(text, box.current!.selectionStart, box.current!.selectionEnd, "end");
      box.current!.dataset.linked = url;
      formatted({ ...format.current, link: true });
      onChange?.();
    },
    unlink: () => {
      delete box.current!.dataset.linked;
      formatted({ ...format.current, link: false });
    },
    insertText: (inserted) => {
      box.current!.setRangeText(inserted, box.current!.selectionStart, box.current!.selectionEnd, "end");
      onChange?.();
    },
    startMention: () => {
      const text = box.current!;
      text.focus();
      const before = text.value.slice(0, text.selectionStart);
      text.setRangeText(/\S$/.test(before) ? " @" : "@", text.selectionStart, text.selectionEnd, "end");
      onChange?.();
    },
    startNewBlock: () => false,
    catchUp: () => {},
  }));

  const keyPressed = useEffectEvent((event: KeyboardEvent) => onKeyDown?.(event));

  useEffect(() => {
    const text = box.current!;
    const listener = (event: KeyboardEvent) => keyPressed(event);
    text.addEventListener("keydown", listener, { capture: true });
    return () => text.removeEventListener("keydown", listener, { capture: true });
  }, []);

  // As it shows, rather than once React gets round to effects, so a test finds it ready, and focused, when it finds it.
  useLayoutEffect(() => {
    onReady?.();
    if (!(typeof autoFocus === "function" ? autoFocus() : autoFocus)) return;
    const text = box.current!;
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
  }, []);

  const pasted = (text: string) => {
    const url = text.trim();
    if (!ADDRESS.test(url)) return;
    onLinkPasted?.({
      url,
      insertBelowLink: (html, { attachment }) => {
        attach([...attachments.current, { contentType: attachment.contentType, html }]);
        onChange?.();
      },
    });
  };

  return (
    <>
      <textarea
        ref={box}
        aria-label={label}
        placeholder={placeholder}
        rows={rows}
        data-mentions-above={mentionsAbove || undefined}
        defaultValue={initialValue && writtenBody(initialValue).plainText}
        onChange={() => onChange?.()}
        onPaste={(event) => pasted(event.clipboardData.getData("text/plain"))}
      />
      {shown.map(({ contentType, html }, index) =>
        createElement("action-text-attachment", { key: index, "content-type": contentType, dangerouslySetInnerHTML: { __html: html } }),
      )}
    </>
  );
}
