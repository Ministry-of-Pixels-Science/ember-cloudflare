import { afterEach, describe, expect, it, vi } from "vitest";
import {
  breaksLine,
  formattingKeys,
  formattingShortcut,
  huddleShortcut,
  muteShortcut,
  opensFind,
  opensShortcuts,
  SHORTCUTS,
  pressedAlone,
  savesEdit,
  sendsMessage,
  snippetShortcut,
  togglesHuddle,
  togglesMute,
  uploadShortcut,
  uploadsFiles,
  writesSnippet,
} from "./keyboard";

function pointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)" && coarse }));
}

const press = (key: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key, ...init });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendsMessage", () => {
  it("sends on Enter and starts a new line on Shift+Enter with a physical keyboard", () => {
    pointer(false);
    expect(sendsMessage(press("Enter"))).toBe(true);
    expect(sendsMessage(press("Enter", { shiftKey: true }))).toBe(false);
  });

  it("starts a new line on Enter with a touch keyboard", () => {
    pointer(true);
    expect(sendsMessage(press("Enter"))).toBe(false);
  });

  it("sends on Cmd+Enter or Ctrl+Enter everywhere", () => {
    pointer(true);
    expect(sendsMessage(press("Enter", { metaKey: true }))).toBe(true);
    expect(sendsMessage(press("Enter", { ctrlKey: true }))).toBe(true);
  });

  it("leaves Enter to an input method that is still composing", () => {
    pointer(false);
    expect(sendsMessage(press("Enter", { isComposing: true }))).toBe(false);
    expect(sendsMessage(press("Enter", { isComposing: true, metaKey: true }))).toBe(false);
  });

  it("ignores other keys", () => {
    pointer(false);
    expect(sendsMessage(press("a"))).toBe(false);
  });
});

describe("breaksLine", () => {
  it("is Shift+Enter with a physical keyboard", () => {
    pointer(false);
    expect(breaksLine(press("Enter", { shiftKey: true }))).toBe(true);
  });

  it("isn't Enter alone or with other keys held, on a touch keyboard, or while an input method composes", () => {
    pointer(false);
    expect(breaksLine(press("Enter"))).toBe(false);
    for (const modifier of ["ctrlKey", "metaKey", "altKey", "isComposing"]) {
      expect(breaksLine(press("Enter", { shiftKey: true, [modifier]: true })), modifier).toBe(false);
    }
    pointer(true);
    expect(breaksLine(press("Enter", { shiftKey: true }))).toBe(false);
  });
});

describe("savesEdit", () => {
  it("is Ctrl+Enter or Cmd+Enter", () => {
    expect(savesEdit(press("Enter", { ctrlKey: true }))).toBe(true);
    expect(savesEdit(press("Enter", { metaKey: true }))).toBe(true);
  });

  it("isn't Enter on its own, with other keys held, or while an input method is composing", () => {
    expect(savesEdit(press("Enter"))).toBe(false);
    expect(savesEdit(press("Enter", { shiftKey: true }))).toBe(false);
    expect(savesEdit(press("Enter", { ctrlKey: true, metaKey: true }))).toBe(false);
    expect(savesEdit(press("Enter", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(savesEdit(press("Enter", { metaKey: true, altKey: true }))).toBe(false);
    expect(savesEdit(press("Enter", { ctrlKey: true, isComposing: true }))).toBe(false);
  });
});

describe("pressedAlone", () => {
  it("is the key with nothing held", () => {
    expect(pressedAlone(press("Escape"), "Escape")).toBe(true);
    expect(pressedAlone(press("ArrowUp"), "ArrowUp")).toBe(true);
  });

  it("isn't another key, the key with a modifier held, or one an input method is composing", () => {
    expect(pressedAlone(press("ArrowDown"), "ArrowUp")).toBe(false);
    for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey", "isComposing"]) {
      expect(pressedAlone(press("ArrowUp", { [modifier]: true }), "ArrowUp"), modifier).toBe(false);
    }
  });
});

/** The keyboard of a device whose `navigator.platform` is `platform`. */
const on = (platform: string) => vi.stubGlobal("navigator", { ...navigator, platform });

describe("opensFind", () => {
  it("takes Ctrl+F, in either case, but on Apple's devices", () => {
    on("Win32");
    expect(opensFind(press("f", { ctrlKey: true }))).toBe(true);
    expect(opensFind(press("F", { ctrlKey: true }))).toBe(true);
    expect(opensFind(press("f", { metaKey: true }))).toBe(false);
    on("Linux x86_64");
    expect(opensFind(press("f", { ctrlKey: true }))).toBe(true);
  });

  it("takes Cmd+F on a Mac, iPad or iPhone, where Ctrl+F moves the caret on in a field", () => {
    for (const platform of ["MacIntel", "iPad", "iPhone"]) {
      on(platform);
      expect(opensFind(press("f", { metaKey: true })), platform).toBe(true);
      expect(opensFind(press("f", { ctrlKey: true })), platform).toBe(false);
    }
  });

  it("leaves F with other modifiers, alone, or while an input method composes", () => {
    on("Win32");
    expect(opensFind(press("f"))).toBe(false);
    expect(opensFind(press("f", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(opensFind(press("f", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(opensFind(press("f", { ctrlKey: true, metaKey: true }))).toBe(false);
    expect(opensFind(press("f", { ctrlKey: true, isComposing: true }))).toBe(false);
    expect(opensFind(press("g", { ctrlKey: true }))).toBe(false);
  });
});

describe("formattingShortcut", () => {
  it("takes Slack's formatting keys with Cmd on Apple's devices", () => {
    on("MacIntel");
    const pressed = (key: string, code: string, init: KeyboardEventInit = {}) => formattingShortcut(press(key, { code, metaKey: true, shiftKey: true, ...init }));
    expect(pressed("X", "KeyX")).toBe("strikethrough");
    expect(pressed("U", "KeyU")).toBe("link");
    expect(pressed("k", "KeyK", { shiftKey: false })).toBe("link");
    expect(pressed("&", "Digit7")).toBe("orderedList");
    expect(pressed("*", "Digit8")).toBe("bulletedList");
    expect(pressed("(", "Digit9")).toBe("quote");
    expect(pressed("C", "KeyC")).toBe("code");
    expect(pressed("Ç", "KeyC", { altKey: true })).toBe("codeBlock");
    expect(formattingShortcut(press("X", { code: "KeyX", ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("takes them with Ctrl elsewhere, and by the letter a key types on a keyboard laid out another way", () => {
    on("Win32");
    expect(formattingShortcut(press("X", { code: "KeyX", ctrlKey: true, shiftKey: true }))).toBe("strikethrough");
    expect(formattingShortcut(press("X", { code: "KeyX", metaKey: true, shiftKey: true }))).toBeNull();
    on("Linux x86_64");
    expect(formattingShortcut(press("X", { code: "KeyB", ctrlKey: true, shiftKey: true }))).toBe("strikethrough");
  });

  it("leaves Bold, Italic and Underline to the editor, and the keys with anything else held", () => {
    on("MacIntel");
    for (const key of ["b", "i", "u"]) expect(formattingShortcut(press(key, { code: `Key${key.toUpperCase()}`, metaKey: true })), key).toBeNull();
    expect(formattingShortcut(press("x", { code: "KeyX", metaKey: true }))).toBeNull();
    expect(formattingShortcut(press("K", { code: "KeyK", metaKey: true, shiftKey: true }))).toBeNull();
    expect(formattingShortcut(press("X", { code: "KeyX", metaKey: true, shiftKey: true, altKey: true }))).toBeNull();
    expect(formattingShortcut(press("X", { code: "KeyX", metaKey: true, shiftKey: true, isComposing: true }))).toBeNull();
    expect(formattingShortcut(press("X", { code: "KeyX", shiftKey: true }))).toBeNull();
  });
});

describe("formattingKeys", () => {
  it("names a formatting button's first keys as the keyboard does, and as screen readers hear them", () => {
    on("MacIntel");
    expect(formattingKeys("link")).toEqual({ keys: ["⌘", "⇧", "U"], aria: "Meta+Shift+U" });
    expect(formattingKeys("codeBlock")).toEqual({ keys: ["⌘", "⌥", "⇧", "C"], aria: "Meta+Alt+Shift+C" });
    on("Win32");
    expect(formattingKeys("bold")).toEqual({ keys: ["Ctrl", "B"], aria: "Control+B" });
    expect(formattingKeys("codeBlock")).toEqual({ keys: ["Ctrl", "Alt", "Shift", "C"], aria: "Control+Alt+Shift+C" });
  });

  it("names none for the buttons that have none, as Slack's do", () => {
    for (const action of ["paragraph", "h1", "divider"] as const) expect(formattingKeys(action), action).toBeUndefined();
  });
});

describe("togglesHuddle", () => {
  it("takes Ctrl+Alt+Shift+H, but on Apple's devices", () => {
    on("Win32");
    expect(togglesHuddle(press("H", { code: "KeyH", ctrlKey: true, altKey: true, shiftKey: true }))).toBe(true);
    expect(togglesHuddle(press("h", { code: "KeyH", ctrlKey: true, altKey: true, shiftKey: true }))).toBe(true);
    expect(togglesHuddle(press("H", { code: "KeyH", metaKey: true, altKey: true, shiftKey: true }))).toBe(false);
  });

  it("takes Cmd+Option+Shift+H on a Mac, where Option makes the key type another letter", () => {
    on("MacIntel");
    expect(togglesHuddle(press("Ó", { code: "KeyH", metaKey: true, altKey: true, shiftKey: true }))).toBe(true);
    expect(togglesHuddle(press("Ó", { code: "KeyH", ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
  });

  it("takes the key that types H on a keyboard laid out another way", () => {
    on("Linux x86_64");
    expect(togglesHuddle(press("H", { code: "KeyJ", ctrlKey: true, altKey: true, shiftKey: true }))).toBe(true);
  });

  it("leaves the browser's own Cmd+Shift+H and Ctrl+Shift+H, and H with anything less", () => {
    on("MacIntel");
    expect(togglesHuddle(press("H", { code: "KeyH", metaKey: true, shiftKey: true }))).toBe(false);
    on("Win32");
    expect(togglesHuddle(press("H", { code: "KeyH", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(togglesHuddle(press("h", { code: "KeyH", ctrlKey: true, altKey: true }))).toBe(false);
    expect(togglesHuddle(press("H", { code: "KeyH", altKey: true, shiftKey: true }))).toBe(false);
    expect(togglesHuddle(press("H", { code: "KeyH", ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(togglesHuddle(press("H", { code: "KeyH", ctrlKey: true, altKey: true, shiftKey: true, isComposing: true }))).toBe(false);
    expect(togglesHuddle(press("G", { code: "KeyG", ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
  });

  it("names its keys as the keyboard does, and as screen readers hear them", () => {
    on("MacIntel");
    expect(huddleShortcut()).toEqual({ keys: ["⌘", "⌥", "⇧", "H"], aria: "Meta+Alt+Shift+H" });
    on("Win32");
    expect(huddleShortcut()).toEqual({ keys: ["Ctrl", "Alt", "Shift", "H"], aria: "Control+Alt+Shift+H" });
  });
});

describe("togglesMute", () => {
  it("takes Ctrl+Shift+Space, but on Apple's devices, which take Cmd+Shift+Space", () => {
    on("Win32");
    expect(togglesMute(press(" ", { code: "Space", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(togglesMute(press(" ", { code: "Space", metaKey: true, shiftKey: true }))).toBe(false);
    on("MacIntel");
    expect(togglesMute(press(" ", { code: "Space", metaKey: true, shiftKey: true }))).toBe(true);
    expect(togglesMute(press(" ", { code: "Space", ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("leaves Space alone, with anything less or more held, and other keys", () => {
    on("Win32");
    expect(togglesMute(press(" ", { code: "Space" }))).toBe(false);
    expect(togglesMute(press(" ", { code: "Space", shiftKey: true }))).toBe(false);
    expect(togglesMute(press(" ", { code: "Space", ctrlKey: true }))).toBe(false);
    expect(togglesMute(press(" ", { code: "Space", ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(togglesMute(press(" ", { code: "Space", ctrlKey: true, metaKey: true, shiftKey: true }))).toBe(false);
    expect(togglesMute(press(" ", { code: "Space", ctrlKey: true, shiftKey: true, isComposing: true }))).toBe(false);
    expect(togglesMute(press("Enter", { code: "Enter", ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("names its keys as the keyboard does, and as screen readers hear them", () => {
    on("MacIntel");
    expect(muteShortcut()).toEqual({ keys: ["⌘", "⇧", "Space"], aria: "Meta+Shift+Space" });
    on("Linux x86_64");
    expect(muteShortcut()).toEqual({ keys: ["Ctrl", "Shift", "Space"], aria: "Control+Shift+Space" });
  });
});

describe("opensShortcuts", () => {
  it("takes Ctrl+/, but on Apple's devices, which take Cmd+/", () => {
    on("Win32");
    expect(opensShortcuts(press("/", { ctrlKey: true }))).toBe(true);
    expect(opensShortcuts(press("/", { metaKey: true }))).toBe(false);
    for (const platform of ["MacIntel", "iPad", "iPhone"]) {
      on(platform);
      expect(opensShortcuts(press("/", { metaKey: true })), platform).toBe(true);
      expect(opensShortcuts(press("/", { ctrlKey: true })), platform).toBe(false);
    }
  });

  it("counts the key by where it is, for keyboards whose / is somewhere else", () => {
    on("Linux x86_64");
    expect(opensShortcuts(press("-", { code: "Slash", ctrlKey: true }))).toBe(true);
  });

  it("leaves / alone, with other modifiers, or while an input method composes", () => {
    on("Win32");
    expect(opensShortcuts(press("/"))).toBe(false);
    for (const modifier of ["altKey", "shiftKey", "metaKey", "isComposing"]) {
      expect(opensShortcuts(press("/", { ctrlKey: true, [modifier]: true })), modifier).toBe(false);
    }
    expect(opensShortcuts(press("?", { ctrlKey: true }))).toBe(false);
  });
});

describe("uploadsFiles", () => {
  it("takes Ctrl+O, but on Apple's devices, which take Cmd+O", () => {
    on("Win32");
    expect(uploadsFiles(press("o", { code: "KeyO", ctrlKey: true }))).toBe(true);
    expect(uploadsFiles(press("o", { code: "KeyO", metaKey: true }))).toBe(false);
    on("MacIntel");
    expect(uploadsFiles(press("o", { code: "KeyO", metaKey: true }))).toBe(true);
    expect(uploadsFiles(press("o", { code: "KeyO", ctrlKey: true }))).toBe(false);
  });

  it("leaves O alone, with other modifiers, or while an input method composes", () => {
    on("Win32");
    expect(uploadsFiles(press("o", { code: "KeyO" }))).toBe(false);
    for (const modifier of ["altKey", "shiftKey", "metaKey", "isComposing"]) {
      expect(uploadsFiles(press("o", { code: "KeyO", ctrlKey: true, [modifier]: true })), modifier).toBe(false);
    }
  });

  it("names its keys as the keyboard does, and as screen readers hear them", () => {
    expect(uploadShortcut(true)).toEqual({ keys: ["⌘", "O"], aria: "Meta+O" });
    expect(uploadShortcut(false)).toEqual({ keys: ["Ctrl", "O"], aria: "Control+O" });
  });
});

describe("writesSnippet", () => {
  it("takes Ctrl+Shift+Enter, but on Apple's devices, which take Cmd+Shift+Enter", () => {
    on("Linux x86_64");
    expect(writesSnippet(press("Enter", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(writesSnippet(press("Enter", { metaKey: true, shiftKey: true }))).toBe(false);
    on("MacIntel");
    expect(writesSnippet(press("Enter", { metaKey: true, shiftKey: true }))).toBe(true);
  });

  it("leaves Cmd or Ctrl+Enter to send, and Shift+Enter to break the line", () => {
    on("Win32");
    expect(writesSnippet(press("Enter", { ctrlKey: true }))).toBe(false);
    expect(writesSnippet(press("Enter", { shiftKey: true }))).toBe(false);
    expect(writesSnippet(press("Enter", { ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(writesSnippet(press("Enter", { ctrlKey: true, shiftKey: true, isComposing: true }))).toBe(false);
  });

  it("names its keys as the keyboard does, and as screen readers hear them", () => {
    expect(snippetShortcut(true)).toEqual({ keys: ["⌘", "⇧", "Enter"], aria: "Meta+Shift+Enter" });
    expect(snippetShortcut(false)).toEqual({ keys: ["Ctrl", "Shift", "Enter"], aria: "Control+Shift+Enter" });
  });
});

describe("SHORTCUTS", () => {
  it("names Cmd and Option on an Apple keyboard, and Ctrl and Alt on another", () => {
    const keys = (apple: boolean) => SHORTCUTS.flatMap(({ rows }) => rows.flatMap((row) => row.keys(apple)));
    expect(keys(true)).toContain("⌘");
    expect(keys(true)).not.toContain("Ctrl");
    expect(keys(false)).toContain("Ctrl");
    expect(keys(false)).not.toContain("⌘");
    expect(keys(false)).not.toContain("⌥");
  });

  it("lists the formatting keys as their buttons' tooltips show them", () => {
    const format = SHORTCUTS.find(({ group }) => group === "Format text")!.rows;
    expect(format.map(({ action }) => action)).toEqual(["Bold", "Italic", "Underline", "Strikethrough", "Link", "Ordered list", "Bulleted list", "Blockquote", "Code", "Code block"]);
    expect(format.find(({ action }) => action === "Link")!.keys(true)).toEqual(formattingKeys("link", true)!.keys);
    expect(format.find(({ action }) => action === "Code block")!.keys(false)).toEqual(formattingKeys("codeBlock", false)!.keys);
  });

  it("lists the + menu's keys as the menu shows them", () => {
    const writing = SHORTCUTS.find(({ group }) => group === "Write a message")!.rows;
    expect(writing.find(({ action }) => action === "Upload files")!.keys(true)).toEqual(uploadShortcut(true).keys);
    expect(writing.find(({ action }) => action === "Write a text snippet")!.keys(false)).toEqual(snippetShortcut(false).keys);
  });

  it("lists the huddle keys as their buttons' tooltips show them", () => {
    const huddles = SHORTCUTS.find(({ group }) => group === "Huddles")!.rows;
    expect(huddles.map((row) => row.keys(true))).toEqual([huddleShortcut(true).keys, muteShortcut(true).keys]);
    expect(huddles.map((row) => row.keys(false))).toEqual([huddleShortcut(false).keys, muteShortcut(false).keys]);
  });
});
