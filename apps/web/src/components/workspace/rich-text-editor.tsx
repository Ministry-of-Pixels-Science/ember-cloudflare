import { configure, Extension, Lexical, type ElementNode, type LexicalEditor, type RangeSelection } from "@37signals/lexxy";
import { MENTION_CONTENT_TYPE, OPENGRAPH_EMBED_CONTENT_TYPE } from "@ember/richtext/dom";
import { useEffect, useEffectEvent, useImperativeHandle, useRef, type Ref } from "react";
import { sameFormat, type FormattingCommand, type LinkDraft, type TextFormat } from "@/lib/formatting";
import { registerQuoteLines } from "./quote-lines";
import { $applyFormatting, $formatOf, $linkDraft, $unlink, linkText, startNewBlock, type FormattedEditor } from "./text-formatting";
import "./rich-text-editor.css";

// The editor, Lexxy 0.9.24, set up as Campfire sets it up. This is a chunk of its own, loaded as the
// first editor shows (editor.ts), since it's bigger than the rest of the app.

/** Campfire's CiteNode (app/javascript/lib/rich_text/cite_node.js): the `<cite>` naming whom a reply quotes. */
class CiteNode extends Lexical.ElementNode {
  static getType() {
    return "cite";
  }

  static clone(node: CiteNode) {
    return new CiteNode(node.__key);
  }

  static importJSON(serialized: Record<string, unknown>) {
    return new CiteNode().updateFromJSON(serialized);
  }

  static importDOM() {
    return { cite: () => ({ conversion: () => ({ node: new CiteNode() }), priority: 1 }) };
  }

  exportJSON() {
    return { ...super.exportJSON(), type: "cite" };
  }

  createDOM() {
    return document.createElement("cite");
  }

  updateDOM() {
    return false;
  }

  exportDOM() {
    return { element: document.createElement("cite") };
  }
}

/**
 * Campfire's CampfireRichTextExtension (app/javascript/lib/rich_text/campfire_extension.js):
 * what Campfire's messages hold beyond what Lexxy writes, which the editor keeps rather than strips.
 */
class CampfireRichTextExtension extends Extension {
  get allowedElements() {
    return [
      "cite",
      "figure",
      "figcaption",
      "actiontext-opengraph-embed",
      { tag: "div", attributes: ["sgid"] },
      { tag: "span", attributes: ["sgid"] },
      { tag: "img", attributes: ["alt"] },
      { tag: "a", attributes: ["rel", "target"] },
    ];
  }

  get lexicalExtension() {
    return this.defineExtension({ name: "campfire/rich-text", nodes: [CiteNode], register: registerQuoteLines });
  }
}

// Campfire's settings (app/javascript/initializers/rich_text.js), which have to come before Lexxy
// defines its elements, on the tick after it loads. Mentions keep the content type Campfire has always
// given them, application/vnd.campfire.mention. The formatting row is Ember's own, Slack's
// (formatting-toolbar.tsx), in place of Lexxy's toolbar, with Slack's three sizes of heading.
configure({
  global: { attachmentContentTypeNamespace: "campfire", extensions: [CampfireRichTextExtension] },
  default: { toolbar: false, headings: ["h1", "h2", "h3"] },
});

/**
 * The @ prompt: typing @ lists the people `src` answers with as prompt items, those whose names hold
 * what follows the @, which Lexxy adds as `filter`. Lexxy opens the list under the cursor where it fits
 * the window, or else above it, or always above it with `above`.
 */
function mentionPrompt(src: string, above: boolean): HTMLElement {
  const prompt = document.createElement("lexxy-prompt");
  const attributes = { trigger: "@", name: "mention", src, "remote-filtering": "true", "empty-results": "No matches" };
  for (const [name, value] of Object.entries(attributes)) prompt.setAttribute(name, value);
  if (above) prompt.setAttribute("vertical-direction", "top");
  return prompt;
}

/** The class Lexxy gives the @ prompt's list while it shows. */
const LIST_SHOWN = "lexxy-prompt-menu--visible";

/** Marks the `lexxy:change` that has the @ prompt look again at what's typed, which changes nothing written. */
const LOOK_AGAIN = Symbol("look again");

/**
 * Has `lexxy`'s @ prompt list the people for what's typed after the @ as the list shows, when that's
 * changed since the prompt asked for the list. Lexxy (0.9.24, and still 1.0.1) hears what's typed only
 * once the list shows, so a quick "@ka" would list everyone until the next key. Lexxy reads what's typed
 * as it adds the list to the editor, and as it unpins the list (`data-anchored`) to open it again.
 */
function lookAgainAsListShows(lexxy: LexxyEditor): MutationObserver {
  const typed = () => lexxy.contents.textBackUntil("@");
  let asked = "";
  const observer = new MutationObserver((records) => {
    for (const { type, target, addedNodes, attributeName, oldValue } of records) {
      const list = target as Element;
      if (type === "childList") {
        const added = [...addedNodes].find((node) => node instanceof Element && node.classList.contains("lexxy-prompt-menu"));
        if (!added) continue;
        asked = typed();
        observer.observe(added, { attributeFilter: ["class", "data-anchored"], attributeOldValue: true });
      } else if (attributeName === "data-anchored") {
        if (!list.hasAttribute("data-anchored")) asked = typed();
      } else if (list.classList.contains(LIST_SHOWN) && !oldValue?.includes(LIST_SHOWN) && typed() !== asked) {
        lexxy.dispatchEvent(new CustomEvent("lexxy:change", { detail: LOOK_AGAIN }));
      }
    }
  });
  observer.observe(lexxy, { childList: true });
  return observer;
}

/** A `<lexxy-editor>`, as far as this uses it. */
type LexxyEditor = HTMLElement &
  FormattedEditor & {
    value: string;
    readonly isBlank: boolean;
    readonly hasOpenPrompt: boolean;
    /** Its contenteditable, which Lexxy names after it once it's connected. */
    readonly editorContentElement?: HTMLElement;
    /** What's written, as Lexxy reads it: `textBackUntil` is what follows the last `text` before the cursor, to the end of its word. */
    readonly contents: FormattedEditor["contents"] & { textBackUntil(text: string): string };
    readonly selection: FormattedEditor["selection"] & { placeCursorAtTheEnd(): void };
    /** Its Lexical editor. */
    readonly editor: LexicalEditor;
  };

/** Whether the cursor is in the text with nothing selected. */
function nothingSelected(lexxy: LexxyEditor): boolean {
  return lexxy.editor.getEditorState().read(() => {
    const selection = Lexical.$getSelection();
    return Lexical.$isRangeSelection(selection) && selection.isCollapsed();
  });
}

/** Whether focus is in the text, where the page's selection is the text's. */
const hasFocus = (lexxy: LexxyEditor) => lexxy.editorContentElement?.contains(document.activeElement) ?? false;

/**
 * Has the editor take what's selected on the page, where that's moved since the page last told it. The
 * page tells it a moment after the selection moves, as Shift and an arrow move it, and a key pressed in
 * that moment would otherwise format what was selected before, and put that back on the page.
 */
function catchUpWithThePage(lexxy: LexxyEditor) {
  if (hasFocus(lexxy)) lexxy.editor.update(() => $catchUpWithThePage(lexxy.editor), { discrete: true });
}

/** Has the editor's selection be what's selected on the page, where that's in the text and has moved since the page last told it. */
function $catchUpWithThePage(editor: LexicalEditor) {
  const selection = Lexical.$getSelection();
  const onPage = Lexical.$createRangeSelectionFromDom(Lexical.getDOMSelection(window), editor);
  if (!Lexical.$isRangeSelection(selection) || !onPage || (onPage.anchor.is(selection.anchor) && onPage.focus.is(selection.focus))) return;
  selection.anchor.set(onPage.anchor.key, onPage.anchor.offset, onPage.anchor.type);
  selection.focus.set(onPage.focus.key, onPage.focus.offset, onPage.focus.type);
  // What's typed next takes the format of the text the cursor's moved to, as it would once the page told the editor.
  const text = selection.anchor.getNode();
  if (selection.isCollapsed() && Lexical.$isTextNode(text)) {
    selection.setFormat(text.getFormat());
    selection.setStyle(text.getStyle());
  }
}

/**
 * Makes a change to the text from outside it, as the formatting row and Link's dialog do. Where focus is
 * elsewhere, as on a button of the row, Lexical would put the page's selection back in the text, and so
 * focus, which is left where it is: putting focus back in the text puts the selection there too.
 */
function changeText(lexxy: LexxyEditor, change: () => void, tag?: string) {
  const focused = hasFocus(lexxy);
  const tags = [...(tag ? [tag] : []), ...(focused ? [] : [Lexical.SKIP_DOM_SELECTION_TAG])];
  lexxy.editor.update(change, { tag: tags });
}

/**
 * Keeps the editor's selection while focus is outside the text, as on the formatting row, where the page's
 * selection moves only as the editor redraws what's under it: Bold, pressed from the keyboard, redraws
 * what's selected and leaves the page's selection collapsed before it, which the editor would take once the
 * page told it, so the row's next button would format nothing. As Tab is pressed, and as focus leaves, the
 * editor takes what's selected on the page, which the page may not have told it of yet, as when Tab comes
 * straight after Home: Safari lets go of the page's selection as Tab takes focus to a button, before the
 * text hears that focus has gone.
 */
function keepSelectionWhileAway(lexxy: LexxyEditor) {
  const { editor } = lexxy;
  // Left off the page, where it would put focus back in the text.
  const leavingThePage = () => Lexical.$addUpdateTag(Lexical.SKIP_DOM_SELECTION_TAG);
  return Lexical.mergeRegister(
    editor.registerCommand(
      Lexical.KEY_TAB_COMMAND,
      () => {
        $catchUpWithThePage(editor);
        return false;
      },
      Lexical.COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerCommand(
      Lexical.BLUR_COMMAND,
      () => {
        $catchUpWithThePage(editor);
        leavingThePage();
        return false;
      },
      Lexical.COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerCommand(
      Lexical.SELECTION_CHANGE_COMMAND,
      () => {
        const kept = Lexical.$getPreviousSelection();
        if (hasFocus(lexxy) || !Lexical.$isRangeSelection(kept) || !Lexical.$isRangeSelection(Lexical.$getSelection())) return false;
        Lexical.$setSelection(kept.clone());
        leavingThePage();
        return false;
      },
      Lexical.COMMAND_PRIORITY_CRITICAL,
    ),
    // Lexical keeps the tags of a change that moved only the selection, as formatting what's typed next does,
    // for the change after it, which would leave the page's selection, and focus, where they are as it puts
    // focus back in the text, as Escape on the row does. The tags heard here are the ones it keeps.
    editor.registerUpdateListener(({ tags }) => {
      tags.delete(Lexical.SKIP_DOM_SELECTION_TAG);
    }),
  );
}

/** Where what's written from outside the text goes: in place of what's selected, or at the cursor, or before the text has had one, at its end. */
function $writingPlace(): RangeSelection {
  const selection = Lexical.$getSelection();
  return Lexical.$isRangeSelection(selection) ? selection : Lexical.$getRoot().selectEnd();
}

/** Whether what's written at `selection` would follow a word, which an @ would then be part of rather than start a mention. */
function $followsWord(selection: RangeSelection): boolean {
  const start = selection.isBackward() ? selection.focus : selection.anchor;
  const node = start.getNode();
  if (Lexical.$isTextNode(node) && start.offset > 0) return /\S/.test(node.getTextContent().charAt(start.offset - 1));
  const before = Lexical.$isTextNode(node) ? node.getPreviousSibling() : start.offset > 0 ? (node as ElementNode).getChildAtIndex(start.offset - 1) : null;
  // A line break's text is a newline.
  return before !== null && /\S$/.test(before.getTextContent());
}

/** A link pasted in the editor, as Lexxy tells of it with `lexxy:insert-link`. */
export interface PastedLink {
  url: string;
  /** Adds an attachment of `contentType`, `html` its content, after the paragraph the link is in, if it's still there. */
  insertBelowLink(html: string, options: { attachment: { contentType: string } }): void;
}

export interface RichTextEditorHandle {
  /** What's written, as Lexxy's markup. */
  value(): string;
  /** Empties it, leaving no formatting on for what's typed next. */
  clear(): void;
  /** Whether nothing but white space is written. */
  isBlank(): boolean;
  /** Whether a list it offers, such as the people to mention, is open, which takes Enter for itself. */
  hasOpenPrompt(): boolean;
  focus(): void;
  /** Writes `markup` in place of what's written, then takes focus with the cursor at the end, as Quote does. */
  replace(markup: string): void;
  /** Formats what's selected, or what's typed next, as a button of the formatting row does. */
  apply(command: FormattingCommand): void;
  /** What Link's dialog opens with: the link the cursor is in, or what's selected to link. */
  linkDraft(): LinkDraft;
  /** Links `text` to `url`, in place of what's selected or the link the cursor is in. */
  link(draft: LinkDraft): void;
  /** Takes off the link the cursor is in, keeping its text. */
  unlink(): void;
  /** Writes `text` in place of what's selected, or at the cursor, or at the end before the text has had focus, as an emoji picked is. */
  insertText(text: string): void;
  /**
   * Types @ where the cursor is, after a space if it follows a word, and takes focus, so the people to
   * mention are listed, as Slack's Mention someone does.
   */
  startMention(): void;
  /**
   * In a list, starts its next item, or ends it on an empty one, and in a heading, starts a paragraph
   * after it, as Enter does where it doesn't send. Answers whether it did: elsewhere, it's left to the
   * editor, whose Shift+Enter breaks the line.
   */
  startNewBlock(): boolean;
  /**
   * Has it take what's selected on the page, where that's moved since the page last told it, as a key
   * pressed in the text can come first.
   */
  catchUp(): void;
}

interface Props {
  /** What screen readers call it. */
  label: string;
  placeholder?: string;
  /** How many lines it has room for while empty. */
  rows: number;
  /** What's written in it as it opens, as Lexxy's markup. */
  initialValue?: string;
  /** Where its @ prompt asks for the people it offers (`mentionPromptSrc`), as it opens. Without it, @ is just @. */
  mentionsFrom?: string;
  /** Whether the people @ lists show above the text even where there's room below it, as it opens. */
  mentionsAbove?: boolean;
  /**
   * Whether it takes focus once it's ready, with the cursor after what's written. A function is asked
   * then, since it may be ready only after you've moved on.
   */
  autoFocus?: boolean | (() => boolean);
  /** Called when what's written changes, other than as it opens. */
  onChange?: () => void;
  /** Called with the formatting where the cursor is when it changes, as it moves or as formatting goes on or off. */
  onFormatChange?: (format: TextFormat) => void;
  /** Called for each key pressed in its text before the editor sees it, which stopping the event's propagation keeps from the editor. */
  onKeyDown?: (event: KeyboardEvent) => void;
  /** Called when an address is pasted as a link. */
  onLinkPasted?: (link: PastedLink) => void;
  /** Called once it's ready to be written in, a moment after it shows. */
  onReady?: () => void;
  ref?: Ref<RichTextEditorHandle>;
}

/**
 * A `<lexxy-editor>`. React would set its attributes as properties, and some of Lexxy's can only be
 * read or throw before it's connected, so it's built here, in a `<div>` React leaves alone.
 */
export default function RichTextEditor({
  label,
  placeholder,
  rows,
  initialValue,
  mentionsFrom,
  mentionsAbove = false,
  autoFocus = false,
  onChange,
  onFormatChange,
  onKeyDown,
  onLinkPasted,
  onReady,
  ref,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<LexxyEditor>(null);

  useImperativeHandle(ref, () => ({
    value: () => editor.current?.value ?? "",
    clear: () => {
      const lexxy = editor.current;
      if (!lexxy) return;
      lexxy.value = "";
      // Lexxy keeps the format the cursor had, so a message sent all in bold would leave the next one bold
      // too.
      lexxy.editor.update(
        () => {
          const selection = Lexical.$getSelection();
          if (!Lexical.$isRangeSelection(selection)) return;
          selection.setFormat(0);
          selection.setStyle("");
        },
        { discrete: true },
      );
    },
    isBlank: () => editor.current?.isBlank ?? true,
    hasOpenPrompt: () => editor.current?.hasOpenPrompt ?? false,
    focus: () => editor.current?.focus(),
    // Campfire's composer_controller.js#replaceMessageContent, for what Quote writes.
    replace: (markup) => {
      const lexxy = editor.current;
      if (!lexxy) return;
      lexxy.value = markup;
      lexxy.focus();
      lexxy.selection.placeCursorAtTheEnd();
    },
    apply: (command) => {
      const lexxy = editor.current;
      if (!lexxy) return;
      // Code with nothing selected is for what's typed next, which Lexxy takes off again after a change it
      // doesn't take as history, as this one is tagged, as it takes off code left over from code that's
      // deleted. Lexical then puts the page's selection back, so it keeps the code, or no code, through the
      // selection change that can still be on its way from the change before, as from a new list item.
      const togglesCode = command === "code" && nothingSelected(lexxy);
      changeText(lexxy, () => $applyFormatting(lexxy, command), togglesCode ? Lexical.HISTORY_MERGE_TAG : undefined);
    },
    linkDraft: () => editor.current?.editor.getEditorState().read($linkDraft) ?? { text: "", url: "" },
    link: (draft) => {
      const lexxy = editor.current;
      if (!lexxy) return;
      linkText(lexxy, draft);
      // Lexxy links text in changes of its own, outside any other, so it's this empty change after them,
      // which Lexical draws with them as one, that leaves focus in Link's dialog until it's closed.
      changeText(lexxy, () => {});
    },
    unlink: () => {
      if (editor.current) changeText(editor.current, $unlink);
    },
    insertText: (text) => {
      if (editor.current) changeText(editor.current, () => $writingPlace().insertText(text));
    },
    startMention: () => {
      const lexxy = editor.current;
      if (!lexxy) return;
      // Lexxy lists the people as an @ is typed in the text with focus, after a space or at a line's start.
      lexxy.focus();
      changeText(lexxy, () => {
        const place = $writingPlace();
        place.insertText($followsWord(place) ? " @" : "@");
      });
    },
    startNewBlock: () => (editor.current ? startNewBlock(editor.current) : false),
    catchUp: () => {
      if (editor.current) catchUpWithThePage(editor.current);
    },
  }));

  const changed = useEffectEvent(() => onChange?.());
  const formatChanged = useEffectEvent((format: TextFormat) => onFormatChange?.(format));
  const keyPressed = useEffectEvent((event: KeyboardEvent) => onKeyDown?.(event));
  const linkPasted = useEffectEvent((link: PastedLink) => onLinkPasted?.(link));
  const ready = useEffectEvent((lexxy: LexxyEditor) => {
    onReady?.();
    if (!(typeof autoFocus === "function" ? autoFocus() : autoFocus)) return;
    lexxy.focus();
    lexxy.selection.placeCursorAtTheEnd();
  });

  /** Tells of the formatting where the cursor is as it changes, from when the editor's ready until it goes. */
  const followFormat = (lexxy: LexxyEditor) => {
    let last: TextFormat | undefined;
    return lexxy.editor.registerUpdateListener(({ editorState }) => {
      const format = editorState.read(() => $formatOf(lexxy));
      if (last && sameFormat(last, format)) return;
      last = format;
      formatChanged(format);
    });
  };

  // Built once, as it opens.
  useEffect(() => {
    const lexxy = document.createElement("lexxy-editor") as LexxyEditor;
    lexxy.className = "lexxy-content";
    lexxy.setAttribute("rows", String(rows));
    // Mentions and link previews, which only the composer adds, but every editor keeps.
    lexxy.setAttribute("permitted-attachment-types", `${MENTION_CONTENT_TYPE} ${OPENGRAPH_EMBED_CONTENT_TYPE}`);
    // Read as the editor connects, without telling anyone it changed.
    if (initialValue) lexxy.setAttribute("value", initialValue);
    lexxy.addEventListener("lexxy:change", (event) => {
      if ((event as CustomEvent).detail !== LOOK_AGAIN) changed();
    });
    let unfollow: (() => void) | undefined;
    let unkeep: (() => void) | undefined;
    lexxy.addEventListener(
      "lexxy:initialize",
      () => {
        unfollow = followFormat(lexxy);
        unkeep = keepSelectionWhileAway(lexxy);
        ready(lexxy);
      },
      { once: true },
    );
    lexxy.addEventListener("lexxy:insert-link", (event) => linkPasted((event as CustomEvent<PastedLink>).detail));
    // Before Lexical's own handlers, which are on the contenteditable inside, and only for the text's keys.
    const keyDown = (event: KeyboardEvent) => {
      if (lexxy.editorContentElement?.contains(event.target as Node)) keyPressed(event);
    };
    lexxy.addEventListener("keydown", keyDown, { capture: true });
    // Inside the editor, which finds it there as it connects.
    if (mentionsFrom) lexxy.append(mentionPrompt(mentionsFrom, mentionsAbove));
    const prompting = mentionsFrom ? lookAgainAsListShows(lexxy) : undefined;
    editor.current = lexxy;
    host.current!.append(lexxy);
    return () => {
      prompting?.disconnect();
      unfollow?.();
      unkeep?.();
      lexxy.remove();
      editor.current = null;
    };
  }, []);

  // Lexxy copies its label and placeholder to its contenteditable only as it connects.
  useEffect(() => {
    const lexxy = editor.current!;
    for (const element of [lexxy, lexxy.editorContentElement]) {
      element?.setAttribute("aria-label", label);
      if (placeholder === undefined) element?.removeAttribute("placeholder");
      else element?.setAttribute("placeholder", placeholder);
    }
  }, [label, placeholder]);

  return <div ref={host} className="contents" />;
}
