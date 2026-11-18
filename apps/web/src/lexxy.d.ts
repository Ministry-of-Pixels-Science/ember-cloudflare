// Lexxy ships no types. These are the parts of @37signals/lexxy 0.9.24 that rich-text-editor.tsx and its modules use.
declare module "@37signals/lexxy" {
  /** Settings for every editor (`global`) and for each preset of them (`default`). */
  export function configure(settings: { global?: Record<string, unknown>; default?: Record<string, unknown> }): void;

  /** The parts of Lexical's LexicalNode that the composer uses. */
  export class LexicalNode {
    getKey(): string;
    getType(): string;
    is(node: LexicalNode | null | undefined): boolean;
    getParent(): ElementNode | null;
    /** The node, or its ancestor, that's a child of the root. */
    getTopLevelElement(): LexicalNode | null;
    getIndexWithinParent(): number;
    getNextSiblings(): LexicalNode[];
    getPreviousSibling(): LexicalNode | null;
    getTextContent(): string;
    isAttached(): boolean;
    insertAfter(node: LexicalNode): LexicalNode;
    insertBefore(node: LexicalNode): LexicalNode;
    remove(): void;
  }

  /** The parts of Lexical's ElementNode that Campfire's node and the composer use. */
  export class ElementNode extends LexicalNode {
    constructor(key?: string);
    readonly __key: string;
    exportJSON(): Record<string, unknown>;
    updateFromJSON(serialized: Record<string, unknown>): this;
    getChildren(): LexicalNode[];
    getChildrenSize(): number;
    getFirstChild(): LexicalNode | null;
    getLastChild(): LexicalNode | null;
    getChildAtIndex(index: number): LexicalNode | null;
    append(...nodes: LexicalNode[]): this;
    /** Puts the cursor at its end, answering the selection. */
    selectEnd(): RangeSelection;
    select(anchorOffset?: number, focusOffset?: number): unknown;
    selectNext(anchorOffset?: number, focusOffset?: number): unknown;
  }

  /** Lexical's ParagraphNode. */
  export class ParagraphNode extends ElementNode {}

  /** The parts of Lexical's TextNode that the composer uses. */
  export class TextNode extends LexicalNode {
    select(anchorOffset?: number, focusOffset?: number): unknown;
    getTextContentSize(): number;
    setTextContent(text: string): this;
    /** Its formats, as bits, as a selection's are. */
    getFormat(): number;
    getStyle(): string;
  }

  /** A place in the editor: in a text node, at an offset, or in an element, before its child at an offset. */
  interface Point {
    key: string;
    type: "text" | "element";
    offset: number;
    getNode(): LexicalNode;
    set(key: string, offset: number, type: "text" | "element"): void;
    /** Whether it's the same place as `point`. */
    is(point: Point): boolean;
  }

  /** The parts of Lexical's RangeSelection that the composer uses. */
  interface RangeSelection {
    anchor: Point;
    focus: Point;
    isCollapsed(): boolean;
    /** Whether the focus comes before the anchor, as when the selection was made leftward. */
    isBackward(): boolean;
    /** Writes `text` in place of what's selected, or at the cursor. */
    insertText(text: string): void;
    /** Whether all that's selected has the format, or what's typed next will, with nothing selected. */
    hasFormat(format: string): boolean;
    /** Turns the format on across what's selected, or off where all of it has it already, or for what's typed next. */
    formatText(format: string): void;
    getTextContent(): string;
    setFormat(format: number): void;
    setStyle(style: string): void;
    clone(): RangeSelection;
  }

  /** The parts of Lexical's EditorState that the composer uses. */
  interface EditorState {
    read<Value>(read: () => Value): Value;
  }

  /** A command an editor carries out, as a key that it hears. */
  interface LexicalCommand<Payload> {
    readonly type?: string;
    readonly __payload?: Payload;
  }

  /** The parts of Lexical's LexicalEditor that the composer uses. */
  export interface LexicalEditor {
    registerCommand<Payload>(command: LexicalCommand<Payload>, listener: (payload: Payload) => boolean, priority: number): () => void;
    /** Calls `listener` after each change to the editor's state, the selection's included. */
    registerUpdateListener(listener: (update: { editorState: EditorState; tags: Set<string> }) => void): () => void;
    getEditorState(): EditorState;
    update(change: () => void, options?: { discrete?: boolean; tag?: string | string[] }): void;
    /** Lexxy's commands go by name, as its toolbar's buttons send them. */
    dispatchCommand(command: string, payload?: unknown): boolean;
    dispatchCommand<Payload>(command: LexicalCommand<Payload>, payload: Payload): boolean;
  }

  /** The Lexical Lexxy is built on, whose nodes an extension's must extend. */
  export const Lexical: {
    ElementNode: typeof ElementNode;
    $getSelection(): unknown;
    $setSelection(selection: RangeSelection | null): void;
    /** The selection as it was before the change being made. */
    $getPreviousSelection(): unknown;
    /** Tags the change being made, as an update's `tag` does. */
    $addUpdateTag(tag: string): void;
    $getRoot(): ElementNode;
    $isRangeSelection(selection: unknown): selection is RangeSelection;
    /** The selection the page's `selection` is in the editor's text, if it's in it. */
    $createRangeSelectionFromDom(selection: Selection | null, editor: LexicalEditor): RangeSelection | null;
    /** The page's selection in `window`. */
    getDOMSelection(window: Window | null): Selection | null;
    $copyNode<Node extends LexicalNode>(node: Node): Node;
    $createParagraphNode(): ParagraphNode;
    $createTextNode(text: string): TextNode;
    /** The nearest of `node` and its ancestors that `matches`. */
    $findMatchingParent(node: LexicalNode, matches: (node: LexicalNode) => boolean): LexicalNode | null;
    $getNodeByKey(key: string): LexicalNode | null;
    $isLineBreakNode(node: LexicalNode | null | undefined): node is LexicalNode;
    $isParagraphNode(node: LexicalNode | null | undefined): node is ParagraphNode;
    $isTextNode(node: LexicalNode | null | undefined): node is TextNode;
    /** Heard as the text loses focus. */
    BLUR_COMMAND: LexicalCommand<FocusEvent>;
    COMMAND_PRIORITY_CRITICAL: number;
    COMMAND_PRIORITY_HIGH: number;
    INSERT_PARAGRAPH_COMMAND: LexicalCommand<undefined>;
    KEY_BACKSPACE_COMMAND: LexicalCommand<KeyboardEvent | null>;
    KEY_SPACE_COMMAND: LexicalCommand<KeyboardEvent>;
    /** Heard as Tab, or Shift and Tab, is pressed in the text, before focus moves. */
    KEY_TAB_COMMAND: LexicalCommand<KeyboardEvent>;
    /** Heard as the page tells the editor its selection moved. */
    SELECTION_CHANGE_COMMAND: LexicalCommand<undefined>;
    /** Tags a change after which the page's selection is left where it is, rather than put where the editor's is. */
    SKIP_DOM_SELECTION_TAG: string;
    /** Tags a change that undo takes back with the one before it. */
    HISTORY_MERGE_TAG: string;
    /** Calls each of `unregister` in one. */
    mergeRegister(...unregister: Array<() => void>): () => void;
  };

  /** What an editor allows and holds beyond Lexxy's own. */
  export class Extension {
    constructor(editorElement: HTMLElement);
    get allowedElements(): Array<string | { tag: string; attributes: string[] }>;
    get lexicalExtension(): unknown;
    defineExtension(extension: { name: string; nodes: unknown[]; register?: (editor: LexicalEditor) => () => void }): unknown;
  }
}
