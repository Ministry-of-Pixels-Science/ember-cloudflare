import { Suspense, useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { MAX_FILE_SIZE, type LinkPreview } from "@ember/protocol";
import { hasPreview, linkedUrls, OPENGRAPH_EMBED_CONTENT_TYPE, previewContent, writtenBody } from "@ember/richtext/dom";
import { AtSign, Page, Send, TextSquare, XmarkCircle } from "@/components/icons/iconoir";
import { useNameOf } from "@/hooks/use-directory";
import { fetchLinkPreview, mentionPromptSrc } from "@/lib/api";
import { dropTarget } from "@/lib/drop-target";
import { breaksLine, hasTouchKeyboard, pressedAlone, sendsMessage, uploadsFiles, writesSnippet } from "@/lib/keyboard";
import type { Typist } from "@/lib/room-state";
import { tooLargeToAttach } from "@/lib/uploads";
import { cn } from "@/lib/utils";
import { AttachMenu } from "./attach-menu";
import { RichTextEditor, editorLoaded, type PastedLink, type RichTextEditorHandle } from "./editor";
import { EmojiButton } from "./emoji-button";
import { FormattingToolbar, LinkDialog, useFormatting } from "./formatting-toolbar";
import { ShortcutTooltip } from "./shortcut-tooltip";
import { SnippetDialog } from "./snippet-dialog";

/**
 * The typing indicator (Campfire's typing_tracker.js and composer.css): the names of whoever is typing,
 * sorted and comma-separated after a three-dot spinner, fading in above the composer, each followed by
 * what it's doing meanwhile, if an answerer said, as in "Ember is using Digg: digg_get_feed". It isn't a
 * live region: announced on every change, a bare list of names would mean nothing out of context. Names
 * that don't fit end in an ellipsis, rather than wrapping down over the message box.
 */
function TypingIndicator({ typists }: { typists: Typist[] }) {
  const nameOf = useNameOf();
  const names = typists
    .map(({ user, doing }) => (doing === undefined ? nameOf(user) : `${nameOf(user)} ${doing}`))
    .sort()
    .join(", ");
  return (
    <div
      className={cn(
        "absolute -top-[19px] left-0 inline-flex max-w-full items-center text-[11px] transition-opacity duration-300 motion-reduce:transition-none max-md:-top-[15px]",
        !names && "opacity-0",
      )}
    >
      <div className={cn("spinner min-w-0 ps-[1.5em] leading-none", !names && "hidden")}>
        {/* The names clip, and the spinner beside them mustn't; the padding keeps descenders. */}
        <span className="-my-[0.25em] block truncate py-[0.25em]">{names}</span>
      </div>
    </div>
  );
}

/** The composer's place below the messages, which keeps clear of a phone's home bar. */
const FOOTER = "bg-background px-[22px] pt-2.5 pb-[max(12px,env(safe-area-inset-bottom))] narrow:px-4 max-md:px-2.5 max-md:pt-2 max-md:pb-[max(10px,env(safe-area-inset-bottom))]";

/**
 * The buttons under the text, which darken on hover as Campfire's do (composer.css, buttons.css). A
 * disconnected room disables them, though only Send looks it.
 */
const BUTTON = "flex size-8 shrink-0 cursor-pointer items-center justify-center touch:size-11";

/** A button under the text but Send and Slack's +, square, and lit on hover. */
const TOOL = cn(BUTTON, "rounded-[7px] hover:not-active:brightness-85 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-hover aria-expanded:bg-hover");

/**
 * Where what someone has written in a room, or in one of its threads, and not yet sent is kept in this
 * browser, for each person apart, so whoever signs in here next doesn't see it.
 */
const draftKey = (userId: string, roomId: string, threadId?: string) => `composer-draft-${userId}-${roomId}` + (threadId === undefined ? "" : `/threads/${threadId}`);

// Storage can be unavailable, as in some private windows, which only means drafts aren't kept.
function readDraft(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Keeps `body` as the draft under `key`, or none once it's null, and answers whether it could. */
function keepDraft(key: string, body: string | null): boolean {
  try {
    if (body === null) localStorage.removeItem(key);
    else localStorage.setItem(key, body);
    return true;
  } catch {
    // Not kept, then.
    return false;
  }
}

/**
 * The composers showing each draft, by its key, as what has each look again at what's kept of it. A
 * thread's draft shows twice where its room's huddle is opened over the thread: beside the room, and in
 * the huddle, which alone can be written in while it covers the other.
 */
const showing = new Map<string, Set<() => void>>();

/**
 * Counts a composer among those showing the draft kept under `key`, until what this answers is called,
 * as the composer goes. The others then look again at what's kept, which the one that went may have
 * left other than they have it.
 */
function showDraft(key: string, lookAgain: () => void): () => void {
  const composers = showing.get(key) ?? new Set();
  showing.set(key, composers.add(lookAgain));
  return () => {
    composers.delete(lookAgain);
    if (composers.size === 0) showing.delete(key);
    for (const other of composers) other();
  };
}

/**
 * How tall the editor will be (rich-text-editor.css: 40px, or 30px below 900px wide, and the 4px under the
 * text, and under the formatting row, the 6px over it), which the composer keeps for it while it loads and
 * until it's drawn its text, so the composer doesn't move meanwhile.
 */
const editorHeight = (belowFormatting: boolean) => (belowFormatting ? "min-h-[50px] max-md:min-h-10" : "min-h-11 max-md:min-h-[34px]");

/** What the composer shows while the editor loads: its placeholder, where Lexxy draws it. */
function LoadingEditor({ placeholder, belowFormatting }: { placeholder: string; belowFormatting: boolean }) {
  return (
    <p aria-hidden="true" className={cn("text-[14px] opacity-66 touch:text-[16px]", belowFormatting && "pt-1.5")}>
      {placeholder}
    </p>
  );
}

/** Where whether the formatting row shows over the composer's text is kept in this browser. */
const FORMATTING_SHOWN = "composer-formatting";

/**
 * Whether the formatting row shows over the composer's text, as Slack's Show formatting has it: as it was
 * last left in this browser, and to begin with, everywhere but touch screens, whose keyboard leaves the
 * composer little room.
 */
function useFormattingShown(): [boolean, (shown: boolean) => void] {
  const [shown, setShown] = useState(() => {
    try {
      const kept = localStorage.getItem(FORMATTING_SHOWN);
      if (kept !== null) return kept === "shown";
    } catch {
      // Storage can be unavailable, as in some private windows, which only means it isn't kept.
    }
    return !hasTouchKeyboard();
  });
  const show = (shown: boolean) => {
    setShown(shown);
    try {
      localStorage.setItem(FORMATTING_SHOWN, shown ? "shown" : "hidden");
    } catch {
      // Not kept, then.
    }
  };
  return [shown, show];
}

/**
 * Whether the editor shows: at once if its code has loaded, or else once `deferred` is over and the
 * browser has painted what came with it, which loading the code would hold up.
 */
function useEditorShown(deferred: boolean): boolean {
  const [shown, setShown] = useState(() => !deferred || editorLoaded());
  useEffect(() => {
    if (deferred || shown) return;
    // A timeout set in the next frame runs once that frame is painted.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => (timeout = setTimeout(() => setShown(true))));
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
    };
  }, [deferred, shown]);
  return shown;
}

/** Adds the preview of a link in a message that has gone, which came after it did. */
export type AddPreview = (preview: LinkPreview) => void;

/** The preview asked for of a pasted link: the link, and how to stop asking for it. */
interface Asking {
  /** The link's address, as `linkedUrls` finds it in what's written. */
  url: string;
  request: AbortController;
  preview: Promise<LinkPreview | null>;
  /** Set once the message with the link has gone, which the preview goes after, rather than below the link. */
  sent?: boolean;
}

/** What the composer knows of the previews of what's written. */
interface DraftPreviews {
  /** The preview asked for of the link pasted last. */
  asking: Asking | null;
  /** The links whose previews it has asked for, as `linkedUrls` finds them. */
  asked: Set<string>;
  /** Whether it has added a preview, so that one taken out of what's written stays out. */
  added: boolean;
}

const noPreviews = (): DraftPreviews => ({ asking: null, asked: new Set(), added: false });

/**
 * A link pasted in the composer gets the preview of the page it goes to below its paragraph, when the
 * page has one, unless another link is pasted first, or the editor it was pasted in goes: with the
 * composer, or as the editor opens again, which `opening` counts. Previews that can't be had are left
 * out without a word. As Slack adds a link's preview a moment after its message, the preview of a pasted
 * link still on its way as the message goes is added to the message once it comes, if the link went
 * with it as pasted, or else that of its first link whose preview wasn't asked for, as one typed rather
 * than pasted, unless a preview was added to what was written, or taken out of it.
 */
function useLinkPreviews(opening: number) {
  const draft = useRef(noPreviews());
  useEffect(
    () => () => {
      draft.current.asking?.request.abort();
      draft.current = noPreviews();
    },
    [opening],
  );

  const pasted = async ({ url, insertBelowLink }: PastedLink) => {
    const previews = draft.current;
    previews.asking?.request.abort();
    const request = new AbortController();
    const asking: Asking = { url: linkedUrls(url)[0] ?? url, request, preview: fetchLinkPreview(url, request.signal).catch(() => null) };
    previews.asking = asking;
    previews.asked.add(asking.url);
    const preview = await asking.preview;
    if (!preview || request.signal.aborted || asking.sent) return;
    previews.added = true;
    const content = previewContent({ href: preview.url, url: preview.image ?? undefined, filename: preview.title, description: preview.description });
    insertBelowLink(content, { attachment: { contentType: OPENGRAPH_EMBED_CONTENT_TYPE } });
  };

  /** Has `addPreview` add the preview that's to go after the message `body`, which has just gone, once it comes. */
  const sent = (body: string, addPreview: AddPreview) => {
    const { asking, asked, added } = draft.current;
    draft.current = noPreviews();
    // Whole addresses, so that a link changed after it was pasted doesn't take the preview of the one pasted.
    const links = added || hasPreview(body) ? null : linkedUrls(writtenBody(body).plainText);
    if (asking && links?.includes(asking.url)) asking.sent = true;
    else asking?.request.abort();
    if (!links) return;
    const pastedPreview = asking?.sent ? asking.preview : Promise.resolve(null);
    void pastedPreview.then((found) => found ?? typedLinkPreview(links, asked)).then((found) => found && addPreview(found));
  };

  return { pasted, sent };
}

/** The preview of the first of a message's `links` to a web page whose preview wasn't `asked` for as it was pasted. */
async function typedLinkPreview(links: string[], asked: Set<string>): Promise<LinkPreview | null> {
  const typed = links.find((url) => /^https?:\/\//i.test(url) && !asked.has(url));
  return typed === undefined ? null : fetchLinkPreview(typed).catch(() => null);
}

/** A file picked to send, keyed, since two can share a name. */
interface PickedFile {
  key: number;
  file: File;
}

/**
 * The files picked to send with the next message: in order of their names, leaving out any over 250 MB,
 * which it says until more are picked.
 */
function usePickedFiles() {
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const lastKey = useRef(0);
  // Reads the files as they're given: a field's, a paste's or a drop's are gone once its event is over.
  const add = (picked: Iterable<File>) => {
    const fitting: PickedFile[] = [];
    const refused: string[] = [];
    for (const file of picked) {
      if (file.size > MAX_FILE_SIZE) refused.push(tooLargeToAttach(file.name));
      else fitting.push({ key: ++lastKey.current, file });
    }
    setErrors(refused);
    if (fitting.length > 0) setFiles((files) => [...files, ...fitting].sort((a, b) => a.file.name.localeCompare(b.file.name)));
  };
  const remove = (key: number) => setFiles((files) => files.filter((picked) => picked.key !== key));
  return { files, errors, add, remove, clear: () => setFiles([]) };
}

/**
 * A file's name as its chip shows it: what runs to an ellipsis, up to its last dot, and its extension,
 * which doesn't. A name with no dot shows whole.
 */
function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? [name, ""] : [name.slice(0, dot + 1), name.slice(dot + 1)];
}

/**
 * The address of a picture's thumbnail, which is let go once its chip goes.
 */
function useThumbnail(file: File): string | undefined {
  const [thumbnail, setThumbnail] = useState<string>();
  useLayoutEffect(() => {
    if (!isImage(file)) return;
    const url = URL.createObjectURL(file);
    setThumbnail(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return thumbnail;
}

const isImage = (file: File) => file.type.startsWith("image/");

/**
 * A file picked to send, styled by Campfire's composer.css: a picture's thumbnail, or a file icon, over
 * its name and a circled ×. Pressing it takes the file back out, which it says to screen readers too.
 */
function FileChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const thumbnail = useThumbnail(file);
  const [name, extension] = splitName(file.name);
  const tile = "aspect-[5/4] w-full shrink-0 rounded-[1em] border border-muted-foreground";
  return (
    <button type="button" aria-label={`Remove ${file.name}`} onClick={onRemove} className="flex w-[100px] cursor-pointer flex-col items-center rounded-[1em]">
      {isImage(file) ? (
        <img src={thumbnail} alt="" className={cn(tile, "object-cover")} />
      ) : (
        <span className={cn(tile, "flex items-center justify-center")}>
          <Page className="h-auto w-[55%]" />
        </span>
      )}
      <span className="flex max-w-full items-center px-[1ch] text-[0.8rem]">
        <span className="truncate">{name}</span>
        <span className="shrink-0">{extension}</span>
        <XmarkCircle className="ms-[0.5em] -me-[0.5em] size-[1.3em] shrink-0" />
      </span>
    </button>
  );
}

/** Whether `target` is the page itself, as when nothing has focus, rather than anything on it. */
function isPage(target: EventTarget | null): boolean {
  return target === document.body || target === document.getElementById("main-content");
}

/** Whether focus is still on `element`, or on nothing, as when what had it went away. */
function focusStayedOn(element: Element | null): boolean {
  const focused = document.activeElement;
  return !focused || focused === element || focused === document.body;
}

interface Props {
  roomId: string;
  /** The room's name as the writer reads it, which a DM's names the others in it. */
  roomName: string;
  /** Whether the room is a DM, whose name goes without a `#`. */
  direct?: boolean;
  /** Who's writing, whose drafts are their own. */
  userId: string;
  /** Who's typing here, but whoever's writing, and what each is doing meanwhile, if an answerer said. */
  typing: Typist[];
  disabled: boolean;
  /**
   * Holds back the editor's code while the room's first messages are on their way, and until they're
   * painted, since loading it then would hold them up. Once it's loaded, as for a room opened before,
   * the editor shows anyway.
   */
  deferEditor?: boolean;
  /**
   * The message whose thread the composer writes replies in, which can be sent to the room too: Also send
   * to the room is ticked for that, until they've gone.
   */
  threadId?: string;
  /**
   * Sends a message, its body markup, answering how to add the preview of a link in it that comes once
   * it has gone, or null when it didn't go: then it stays to be changed.
   */
  onSend: (body: string, alsoSend: boolean) => AddPreview | null;
  /** Sends files, each as a message of its own, before the message written with them. */
  onSendFiles: (files: File[], alsoSend: boolean) => void;
  onTyping: (active: boolean) => void;
  /** Opens the editor on your newest message, for Up Arrow. */
  onEditLastMessage?: () => void;
  /** Whether the editor takes focus as it shows, except on touch screens, as it does unless something else is to have it. */
  autoFocus?: boolean;
  /** Whether the people @ lists show above the text with a mouse too, as on touch screens: for a composer with something under it that would cut the list off. */
  mentionsAbove?: boolean;
  ref?: Ref<ComposerHandle>;
}

export interface ComposerHandle {
  focus(): void;
  /** Writes `markup` in place of what's written, as Quote does, taking focus. */
  replace(markup: string): void;
  /** Adds files to send with the next message, as dropping them on the room's messages does. */
  addFiles(files: Iterable<File>): void;
  /**
   * Writes `markup` back, a message the room wouldn't take for what it says, with `why` above the card,
   * and Also send to the room ticked again if `alsoSend`, unless something's been written since. Answers
   * whether it did.
   */
  giveBack(markup: string, why: string, alsoSend: boolean): boolean;
}

/**
 * The composer: a card with Slack's formatting row on top, then the editor, and below it Slack's buttons:
 * + (Text snippet, Upload from your computer), Show formatting, which shows or hides the row, Emoji,
 * Mention someone, and a round Send button, grey until there's something to send. @ offers the room's
 * people to mention. Files picked, pasted or dropped, and snippets, wait above the card to go with the
 * next message. What's written is kept as a draft until it's sent. A thread's has Also send to the room
 * before Send. A message the room won't take for what it says, as one with a word Blocked words keeps
 * out, comes back to be changed, saying why above the card.
 */
export function Composer({ roomId, roomName, direct = false, userId, typing, disabled, deferEditor = false, threadId, onSend, onSendFiles, onTyping, onEditLastMessage, autoFocus = true, mentionsAbove = false, ref }: Props) {
  const editor = useRef<RichTextEditorHandle>(null);
  const form = useRef<HTMLFormElement>(null);
  const formatting = useFormatting(editor);
  const [formattingShown, showFormatting] = useFormattingShown();
  const [alsoSend, setAlsoSend] = useState(false);
  const key = draftKey(userId, roomId, threadId);
  const [draft, setDraft] = useState(() => readDraft(key));
  // What's kept of the draft as far as this composer knows: what it read as it opened, or has kept since.
  const kept = useRef(draft ?? null);
  // How many times the editor has opened again, with what another composer of its draft left of it.
  const [reopened, setReopened] = useState(0);
  // Touch screens bring up their keyboard on focus, so there it waits for a tap.
  const [focusOnOpen] = useState(() => !hasTouchKeyboard());
  // Where focus was as the room opened. The editor can be ready a moment later, by when you may have put
  // focus elsewhere, where it's left.
  const [focusAtOpen] = useState(() => document.activeElement);
  const editorShown = useEditorShown(deferEditor);
  const linkPreviews = useLinkPreviews(reopened);
  const picked = usePickedFiles();
  // Whether nothing's written, which, with no files picked, leaves Send grey, as Slack's is.
  const [blank, setBlank] = useState(!draft);
  const [writingSnippet, setWritingSnippet] = useState(false);
  // Whether the editor can be written in, which Emoji and Mention someone wait for, since what they wrote before
  // would be lost.
  const [editorReady, setEditorReady] = useState(false);
  const fileField = useRef<HTMLInputElement>(null);
  // Whether the editor was blank when it last changed, so emptying it tells the room you've stopped once.
  const wasBlank = useRef(!draft);
  // Whether Quote wrote what the editor opens with, before it showed, so it takes focus as Quote has it do.
  const replied = useRef(false);
  // Why the room wouldn't take what's written here, which went back to be changed, until something's sent.
  const [refusal, setRefusal] = useState<{ key: string; why: string } | null>(null);
  const placeholder = threadId !== undefined ? "Reply…" : `Message ${direct ? "" : "#"}${roomName}`;

  const keep = (body: string | null) => {
    if (keepDraft(key, body)) kept.current = body;
  };

  // What's written changed, to `body`, or to nothing: the room hears whether you're typing, and it's kept.
  const wrote = (body: string | null) => {
    if (body !== null) onTyping(true);
    else if (!wasBlank.current) onTyping(false);
    wasBlank.current = body === null;
    setBlank(body === null);
    keep(body);
  };

  // Another composer of this draft has gone, as a thread's in its huddle goes from over the thread's own,
  // beside its room. Where it left the draft other than this one has it, what it left is what's written
  // here: the editor opens again with it, as it opened with the draft it found.
  const lookAgain = useEffectEvent(() => {
    const left = readDraft(key) ?? null;
    if (left === kept.current) return;
    kept.current = left;
    wasBlank.current = left === null;
    setBlank(left === null);
    setDraft(left ?? undefined);
    setEditorReady(false);
    setReopened((times) => times + 1);
  });
  useEffect(() => showDraft(key, () => lookAgain()), [key]);

  useImperativeHandle(ref, () => ({
    focus: () => editor.current?.focus(),
    replace: (markup) => {
      if (editor.current) return editor.current.replace(markup);
      // Before the editor shows, as its code loads, the reply is what it opens with.
      replied.current = true;
      setDraft(markup);
      wrote(markup);
    },
    addFiles: picked.add,
    giveBack: (markup, why, alsoSend) => {
      const written = editor.current;
      if (!written?.isBlank()) return false;
      written.replace(markup);
      setRefusal({ key, why });
      if (alsoSend) setAlsoSend(true);
      return true;
    },
  }));

  // Up Arrow, with nothing written, edits your newest message. It's taken only from the composer or the
  // page itself, not from other fields or the editor of another message.
  const editLastMessage = useEffectEvent((event: KeyboardEvent) => {
    if (!onEditLastMessage || event.defaultPrevented || !pressedAlone(event, "ArrowUp")) return;
    const fromText = form.current?.querySelector(".lexxy-editor__content")?.contains(event.target as Node) ?? false;
    // Before the editor shows, what's written is the draft it will show.
    const blank = editor.current ? editor.current.isBlank() : !draft;
    if (!(fromText || isPage(event.target)) || !blank) return;
    event.preventDefault();
    onEditLastMessage();
  });
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => editLastMessage(event);
    document.addEventListener("keydown", keyDown);
    return () => document.removeEventListener("keydown", keyDown);
  }, []);

  const changed = () => wrote(editor.current!.isBlank() ? null : editor.current!.value());

  // This sends nothing while the room is disconnected, and otherwise sends the files picked, then what's
  // written unless it's blank, and focuses the editor, on touch screens too. Before the editor shows, as
  // its code loads, only the files go. Also send to the room is unticked once anything's gone, as Slack
  // unticks it.
  const submit = () => {
    if (disabled) return;
    setRefusal(null);
    if (picked.files.length > 0) {
      onSendFiles(picked.files.map(({ file }) => file), alsoSend);
      picked.clear();
      setAlsoSend(false);
    }
    const written = editor.current;
    if (!written) return;
    if (!written.isBlank()) {
      const body = written.value();
      // One the room won't take, as when it's too long, stays to be cut down.
      const addPreview = onSend(body, alsoSend);
      if (!addPreview) return;
      linkPreviews.sent(body, addPreview);
      // Everyone else stops showing you as typing when your message arrives.
      wasBlank.current = true;
      written.clear();
      keep(null);
      setAlsoSend(false);
    }
    written.focus();
  };

  const keyDown = (event: KeyboardEvent) => {
    if (formatting.keyDown(event)) return;
    // Slack's keys for the + menu's two: Cmd or Ctrl+O picks files, and with Shift, Enter writes a snippet.
    if (uploadsFiles(event) || writesSnippet(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (uploadsFiles(event)) fileField.current?.click();
      else setWritingSnippet(true);
      return;
    }
    // Enter picks from an open list, such as the people to mention.
    if (editor.current?.hasOpenPrompt()) return;
    if (breaksLine(event) && editor.current?.startNewBlock()) {
      // Where Enter sends, Shift+Enter starts a list's next item, or ends the list, and ends a heading.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!sendsMessage(event)) return;
    event.preventDefault();
    event.stopPropagation();
    submit();
  };

  return (
    // A thread's panel is narrower than its room, and its composer keeps closer to its sides.
    <footer className={cn(FOOTER, threadId !== undefined && "px-4")}>
      <form
        ref={form}
        className="composer relative min-w-0 [contain:inline-size]"
        data-formatting={formattingShown || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        // Pasted files are picked rather than written, which Lexxy leaves them out of, and any paste clears
        // what was said about files too large.
        onPaste={(event) => {
          if (event.clipboardData.files.length > 0) event.preventDefault();
          picked.add(event.clipboardData.files);
        }}
        {...dropTarget(picked.add)}
      >
        <TypingIndicator typists={typing} />
        {/* The files picked, and those too large to send. */}
        <div className={cn("flex flex-wrap items-center gap-x-[1ch] gap-y-2", (picked.files.length > 0 || picked.errors.length > 0) && "pb-2")}>
          {picked.files.map(({ key, file }) => (
            <FileChip key={key} file={file} onRemove={() => picked.remove(key)} />
          ))}
          {picked.errors.length > 0 && (
            <p role="alert" className="w-full px-3 py-2.5 text-[13px] leading-normal text-negative wrap-anywhere">
              {picked.errors.join(" ")}
            </p>
          )}
        </div>
        {refusal?.key === key && (
          <p role="alert" className="px-3 pb-2 text-[13px] leading-normal text-negative wrap-anywhere">
            {refusal.why}
          </p>
        )}
        <div className="@container flex min-h-[108px] min-w-0 flex-col rounded-[12px] border bg-surface p-3 max-md:min-h-[100px] max-md:p-2.5">
          {formattingShown && (
            <FormattingToolbar
              formatting={formatting}
              // Close to the card's corner, as Slack's, and faint while the composer hasn't focus. On touch
              // screens, it scrolls rather than wrapping its fingertip-sized buttons.
              className="-mx-1.5 -mt-1.5 transition-opacity duration-150 motion-reduce:transition-none [.composer:not(:focus-within)_&]:opacity-55 touch:flex-nowrap touch:overflow-x-auto touch:[scrollbar-width:none]"
            />
          )}
          {/* The editor takes the card's padding and fills this, all the card above the buttons, and below the
              formatting row (rich-text-editor.css). */}
          <div className={cn("flex min-w-0 flex-1 flex-col", editorHeight(formattingShown))}>
            <Suspense fallback={<LoadingEditor placeholder={placeholder} belowFormatting={formattingShown} />}>
              {editorShown ? (
                <RichTextEditor
                  key={reopened}
                  ref={editor}
                  label={threadId !== undefined ? "Write a reply" : "Write a message"}
                  placeholder={placeholder}
                  rows={2}
                  initialValue={draft}
                  mentionsFrom={mentionPromptSrc(roomId)}
                  // Under the text on touch screens are the keyboard and the home indicator.
                  mentionsAbove={mentionsAbove || hasTouchKeyboard()}
                  // Opened again, it leaves focus where it is, with whatever is in front of it now.
                  autoFocus={() => reopened === 0 && (replied.current || (autoFocus && focusOnOpen && focusStayedOn(focusAtOpen)))}
                  onChange={changed}
                  onFormatChange={formatting.setFormat}
                  onKeyDown={keyDown}
                  onLinkPasted={linkPreviews.pasted}
                  onReady={() => setEditorReady(true)}
                />
              ) : (
                <LoadingEditor placeholder={placeholder} belowFormatting={formattingShown} />
              )}
            </Suspense>
          </div>
          <div className="flex flex-none items-center gap-0.5 @max-[20rem]:flex-wrap touch:@max-[28rem]:flex-wrap">
            {/* Upload from your computer's, and Cmd or Ctrl+O's, file picker. */}
            <input
              ref={fileField}
              type="file"
              multiple
              hidden
              disabled={disabled}
              onChange={(event) => {
                picked.add(event.target.files ?? []);
                // So picking the same file again is a change.
                event.target.value = "";
              }}
            />
            <AttachMenu
              disabled={disabled}
              onUpload={() => fileField.current?.click()}
              onSnippet={() => setWritingSnippet(true)}
              onClosed={() => editor.current?.focus()}
              // Slack's + sits in a circle of its own.
              className={cn(BUTTON, "rounded-full bg-hover hover:not-active:brightness-95 aria-expanded:brightness-95")}
            />
            <ShortcutTooltip label={formattingShown ? "Hide formatting" : "Show formatting"}>
              <button
                type="button"
                disabled={disabled}
                aria-label="Show formatting"
                aria-pressed={formattingShown}
                // Keep focus in the editor, so a phone's keyboard stays up, as Send does.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  showFormatting(!formattingShown);
                  editor.current?.focus();
                }}
                className={TOOL}
              >
                <TextSquare className="size-[18px] opacity-70" />
              </button>
            </ShortcutTooltip>
            <EmojiButton
              disabled={disabled || !editorReady}
              onPick={(emoji) => editor.current?.insertText(emoji)}
              onClosed={() => editor.current?.focus()}
              className={TOOL}
            />
            <ShortcutTooltip label="Mention someone">
              <button
                type="button"
                disabled={disabled || !editorReady}
                aria-label="Mention someone"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => editor.current?.startMention()}
                className={TOOL}
              >
                <AtSign className="size-[18px] opacity-70" />
              </button>
            </ShortcutTooltip>
            {/* For fingers, the box sits far enough into its label for a fingertip on it to land on the label. Where
                the buttons would leave the label too little room, it takes a line of its own above them: for
                fingers' bigger buttons that's as on a phone held upright, and otherwise as in a huddle's thread,
                which is narrower than a room's. There the box sits over the middle of +. */}
            {threadId !== undefined && (
              <label className="mr-2 ml-2.5 flex min-w-0 cursor-pointer items-center gap-[7px] text-[13px] leading-[18px] text-message-muted @max-[20rem]:order-first @max-[20rem]:mr-0 @max-[20rem]:ml-2 @max-[20rem]:min-h-7 @max-[20rem]:basis-full touch:ml-0 touch:min-h-11 touch:pl-3.5 touch:text-sm touch:@max-[28rem]:order-first touch:@max-[28rem]:mr-0 touch:@max-[28rem]:basis-full">
                <input
                  type="checkbox"
                  checked={alsoSend}
                  disabled={disabled}
                  onChange={(event) => setAlsoSend(event.target.checked)}
                  className="m-0 size-4 flex-none cursor-pointer accent-foreground"
                />
                <span className="truncate">
                  {direct ? (
                    "Also send as direct message"
                  ) : (
                    <>
                      Also send to <strong className="font-semibold text-message-ink">#{roomName}</strong>
                    </>
                  )}
                </span>
              </label>
            )}
            <ShortcutTooltip label="Send message">
              <button
                type="submit"
                disabled={disabled}
                data-empty={(blank && picked.files.length === 0) || undefined}
                // Keep focus in the editor, so a phone's keyboard stays up between messages.
                onMouseDown={(event) => event.preventDefault()}
                className={cn(
                  BUTTON,
                  "ml-auto rounded-full bg-foreground text-background hover:not-active:brightness-70",
                  // Slack's paper plane is grey, with nothing behind it, until there's something to send.
                  "data-empty:bg-transparent data-empty:text-muted-foreground data-empty:hover:not-active:brightness-100",
                  "disabled:pointer-events-none disabled:opacity-50 disabled:grayscale disabled:contrast-50",
                )}
              >
                <Send className="size-[18px]" />
                <span className="sr-only">Send Message</span>
              </button>
            </ShortcutTooltip>
          </div>
        </div>
      </form>
      {/* Outside the form, so what's typed in them is kept from the composer's own handlers. */}
      <LinkDialog formatting={formatting} />
      <SnippetDialog open={writingSnippet} onOpenChange={setWritingSnippet} onCreate={(file) => picked.add([file])} onClosed={() => editor.current?.focus()} />
    </footer>
  );
}

/**
 * What stands in the composer's place in a room that's gone: deleted, or no longer this person's. Its
 * span is inline, so its width, centering and shake don't take; this has them, as its classes mean.
 */
export function RoomDeleted() {
  return (
    <footer className={FOOTER}>
      <p role="alert" className="rounded-lg border border-negative px-[0.8em] py-[0.5em] text-center text-base text-negative motion-safe:animate-shake">
        This room was deleted.
      </p>
    </footer>
  );
}
