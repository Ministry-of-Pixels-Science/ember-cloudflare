import { FORMATTING_NAMES, type FormattingKey } from "./formatting";

/** Phones and tablets: their on-screen keyboards have no Shift+Enter. */
export const hasTouchKeyboard = () => matchMedia("(pointer: coarse)").matches;

/** Whether the keyboard is an Apple device's, whose shortcuts take Cmd where others take Ctrl. */
export const appleKeyboard = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Whether Cmd is held and Ctrl isn't on an Apple keyboard, or Ctrl and not Cmd on any other. */
const commandHeld = (event: KeyboardEvent) => (appleKeyboard() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

/**
 * Cmd+F on a Mac, iPad or iPhone, or Ctrl+F elsewhere, which opens the search box, as it opens Slack's,
 * and the browser's own find from inside it. A Mac's Ctrl+F moves the caret on in a field, so it stays
 * the field's.
 */
export function opensFind(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== "f" || event.altKey || event.shiftKey || event.isComposing) return false;
  return commandHeld(event);
}

/**
 * Cmd+/ on a Mac, iPad or iPhone, or Ctrl+/ elsewhere, which opens the list of keyboard shortcuts,
 * from the composer too.
 */
export function opensShortcuts(event: KeyboardEvent): boolean {
  if ((event.key !== "/" && event.code !== "Slash") || event.altKey || event.shiftKey || event.isComposing) return false;
  return commandHeld(event);
}

/**
 * Cmd+Option+Shift+H on a Mac, iPad or iPhone, or Ctrl+Alt+Shift+H elsewhere, which starts or joins the
 * huddle of the room shown, or leaves the one the tab is in. Slack's app takes the keys without Option or
 * Alt, which browsers keep for their home page or their history. Option changes the letter a Mac's key
 * types, so the key counts by where it is on the keyboard too.
 */
export function togglesHuddle(event: KeyboardEvent): boolean {
  if (event.code !== "KeyH" && event.key.toLowerCase() !== "h") return false;
  return event.altKey && event.shiftKey && !event.isComposing && commandHeld(event);
}

/** Cmd+Shift+Space on a Mac, iPad or iPhone, or Ctrl+Shift+Space elsewhere, which mutes or unmutes a huddle's microphone, as Slack's do. */
export function togglesMute(event: KeyboardEvent): boolean {
  if (event.code !== "Space" && event.key !== " ") return false;
  return event.shiftKey && !event.altKey && !event.isComposing && commandHeld(event);
}

/**
 * Cmd+O on a Mac, iPad or iPhone, or Ctrl+O elsewhere, pressed in the composer's text, which picks files to
 * send, as Slack's Upload from your computer does, in place of the browser's own Open.
 */
export function uploadsFiles(event: KeyboardEvent): boolean {
  if (event.code !== "KeyO" && event.key.toLowerCase() !== "o") return false;
  return !event.shiftKey && !event.altKey && !event.isComposing && commandHeld(event);
}

/**
 * Cmd+Shift+Enter on a Mac, iPad or iPhone, or Ctrl+Shift+Enter elsewhere, pressed in the composer's text,
 * which writes a text snippet, as Slack's does, where Cmd or Ctrl+Enter alone sends.
 */
export function writesSnippet(event: KeyboardEvent): boolean {
  return event.key === "Enter" && event.shiftKey && !event.altKey && !event.isComposing && commandHeld(event);
}

/** A shortcut's keys: as a tooltip shows them, and as `aria-keyshortcuts` names them for screen readers. */
export interface Shortcut {
  keys: string[];
  aria: string;
}

/** The keys `uploadsFiles` takes on this keyboard. */
export const uploadShortcut = (apple = appleKeyboard()): Shortcut => (apple ? { keys: ["⌘", "O"], aria: "Meta+O" } : { keys: ["Ctrl", "O"], aria: "Control+O" });

/** The keys `writesSnippet` takes on this keyboard. */
export const snippetShortcut = (apple = appleKeyboard()): Shortcut =>
  apple ? { keys: ["⌘", "⇧", "Enter"], aria: "Meta+Shift+Enter" } : { keys: ["Ctrl", "Shift", "Enter"], aria: "Control+Shift+Enter" };

/** The keys `togglesHuddle` takes on this keyboard. */
export const huddleShortcut = (apple = appleKeyboard()): Shortcut =>
  apple ? { keys: ["⌘", "⌥", "⇧", "H"], aria: "Meta+Alt+Shift+H" } : { keys: ["Ctrl", "Alt", "Shift", "H"], aria: "Control+Alt+Shift+H" };

/** The keys `togglesMute` takes on this keyboard. */
export const muteShortcut = (apple = appleKeyboard()): Shortcut =>
  apple ? { keys: ["⌘", "⇧", "Space"], aria: "Meta+Shift+Space" } : { keys: ["Ctrl", "Shift", "Space"], aria: "Control+Shift+Space" };

/** The keys browsers go Back by on this keyboard, as the rail's Back does: Cmd+[ on a Mac, iPad or iPhone, Alt+← elsewhere. */
export const backShortcut = (apple = appleKeyboard()): Shortcut =>
  apple ? { keys: ["⌘", "["], aria: "Meta+[" } : { keys: ["Alt", "←"], aria: "Alt+ArrowLeft" };

/** The keys browsers go Forward by on this keyboard, as the rail's Forward does. */
export const forwardShortcut = (apple = appleKeyboard()): Shortcut =>
  apple ? { keys: ["⌘", "]"], aria: "Meta+]" } : { keys: ["Alt", "→"], aria: "Alt+ArrowRight" };

/**
 * Whether a keypress in a message's editor should send it, as Campfire's composer_controller.js decides:
 * Enter sends and Shift+Enter starts a new line, except on touch screens, where Enter has to start the
 * new line and the Send button sends. Cmd/Ctrl+Enter sends everywhere. Enter sends with the formatting
 * row showing too, as Slack's does, where Campfire's started a new paragraph while its toolbar was open.
 *
 * Campfire treats any touch-capable device that way, and doesn't send on Cmd/Ctrl+Enter there either;
 * this checks the primary pointer instead, so a laptop with a touchscreen still sends on Enter.
 */
export function sendsMessage(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey) return true;
  return !event.shiftKey && !hasTouchKeyboard();
}

/**
 * Shift+Enter with nothing else held where Enter sends, as it does but on touch screens: the one way
 * there to a new line, or a list's next item.
 */
export function breaksLine(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || !event.shiftKey || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
  return !hasTouchKeyboard();
}

/**
 * Ctrl+Enter, or Cmd+Enter on a Mac, which saves a message's edit, as Campfire's edit form takes them
 * (messages/edit.html.erb, `keydown.ctrl+enter` and `keydown.meta+enter`): with no other modifier held.
 */
export function savesEdit(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !event.isComposing && event.ctrlKey !== event.metaKey && !event.altKey && !event.shiftKey;
}

/** Whether `key` was pressed with no modifier held, as Stimulus's key filters such as `keydown.esc` take it. */
export function pressedAlone(event: KeyboardEvent, key: string): boolean {
  return event.key === key && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

/** A row of the keyboard shortcuts dialog: what a key does, and the keys, as an Apple keyboard or another names them. */
export interface ShortcutRow {
  action: string;
  keys: (apple: boolean) => string[];
}

/** Cmd on an Apple keyboard, Ctrl on another. */
const command = (apple: boolean) => (apple ? "⌘" : "Ctrl");
/** Option on an Apple keyboard, Alt on another. */
const option = (apple: boolean) => (apple ? "⌥" : "Alt");
/** Shift, as each keyboard names it. */
const shift = (apple: boolean) => (apple ? "⇧" : "Shift");

/** A formatting key: the letter or digit pressed with Cmd, or with Ctrl off Apple's keyboards, and with Shift or Option as given. */
interface FormattingKeys {
  key: string;
  shift?: boolean;
  option?: boolean;
}

/**
 * Slack's formatting keys, the first of each being the one its button's tooltip shows. Cmd or Ctrl+K
 * links too, as it did before the row was Slack's.
 */
const FORMATTING_KEYS: Partial<Record<FormattingKey, FormattingKeys[]>> = {
  bold: [{ key: "B" }],
  italic: [{ key: "I" }],
  underline: [{ key: "U" }],
  strikethrough: [{ key: "X", shift: true }],
  link: [{ key: "U", shift: true }, { key: "K" }],
  orderedList: [{ key: "7", shift: true }],
  bulletedList: [{ key: "8", shift: true }],
  quote: [{ key: "9", shift: true }],
  code: [{ key: "C", shift: true }],
  codeBlock: [{ key: "C", shift: true, option: true }],
};

/** Cmd or Ctrl+B, I and U, which the editor takes itself. */
const EDITORS_OWN = new Set<FormattingKey>(["bold", "italic", "underline"]);

/** Shift and Option change the character a key types, so a key counts by where it is on the keyboard too. */
const codeOf = (key: string) => (/\d/.test(key) ? `Digit${key}` : `Key${key}`);

function pressedKeys(event: KeyboardEvent, { key, shift = false, option = false }: FormattingKeys): boolean {
  if (event.shiftKey !== shift || event.altKey !== option || event.isComposing || !commandHeld(event)) return false;
  return event.key.toUpperCase() === key || event.code === codeOf(key);
}

/** The formatting a key pressed in a message's text asks for, if it's one of Slack's keys that the editor doesn't take itself. */
export function formattingShortcut(event: KeyboardEvent): FormattingKey | null {
  for (const [action, keys] of Object.entries(FORMATTING_KEYS) as [FormattingKey, FormattingKeys[]][]) {
    if (!EDITORS_OWN.has(action) && keys.some((combination) => pressedKeys(event, combination))) return action;
  }
  return null;
}

const shortcutOf = ({ key, shift: shifted, option: optioned }: FormattingKeys, apple: boolean): Shortcut => ({
  keys: [command(apple), ...(optioned ? [option(apple)] : []), ...(shifted ? [shift(apple)] : []), key],
  aria: [apple ? "Meta" : "Control", ...(optioned ? ["Alt"] : []), ...(shifted ? ["Shift"] : []), key].join("+"),
});

/** The keys of a formatting button that has them, on this keyboard, as its tooltip shows them. */
export function formattingKeys(action: FormattingKey, apple = appleKeyboard()): Shortcut | undefined {
  const keys = FORMATTING_KEYS[action]?.[0];
  return keys && shortcutOf(keys, apple);
}

/**
 * What the keyboard shortcuts dialog lists, a group at a time: each key the matchers here take, so a
 * shortcut added to them is listed beside them, and the browser's own keys for Back and Forward.
 */
export const SHORTCUTS: { group: string; rows: ShortcutRow[] }[] = [
  {
    group: "Navigate",
    rows: [
      { action: "Go back", keys: (apple) => backShortcut(apple).keys },
      { action: "Go forward", keys: (apple) => forwardShortcut(apple).keys },
      { action: "Search", keys: (apple) => [command(apple), "F"] },
      { action: "Move a starred room up or down", keys: (apple) => [option(apple), "↑ ↓"] },
      { action: "Show keyboard shortcuts", keys: (apple) => [command(apple), "/"] },
    ],
  },
  {
    group: "Huddles",
    rows: [
      { action: "Start, join or leave a huddle", keys: (apple) => huddleShortcut(apple).keys },
      { action: "Mute or unmute", keys: (apple) => muteShortcut(apple).keys },
    ],
  },
  {
    group: "Write a message",
    rows: [
      { action: "Send", keys: () => ["Enter"] },
      { action: "Send, on a touch screen too", keys: (apple) => [command(apple), "Enter"] },
      { action: "Start a new line, or a list's next item", keys: (apple) => [shift(apple), "Enter"] },
      { action: "Add a link", keys: (apple) => [command(apple), "K"] },
      { action: "Upload files", keys: (apple) => uploadShortcut(apple).keys },
      { action: "Write a text snippet", keys: (apple) => snippetShortcut(apple).keys },
      { action: "Edit your last message, with nothing written", keys: () => ["↑"] },
    ],
  },
  {
    group: "Format text",
    rows: (Object.entries(FORMATTING_KEYS) as [FormattingKey, FormattingKeys[]][]).map(([action, [keys]]) => ({
      action: FORMATTING_NAMES[action],
      keys: (apple) => shortcutOf(keys!, apple).keys,
    })),
  },
  {
    group: "Edit a message",
    rows: [
      { action: "Save", keys: (apple) => [command(apple), "Enter"] },
      { action: "Close", keys: () => ["Esc"] },
    ],
  },
];
