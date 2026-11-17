import { MAX_FILE_SIZE, type LinkPreview, type User } from "@ember/protocol";
import { OPENGRAPH_EMBED_CONTENT_TYPE, previewContent } from "@ember/richtext/dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleContext } from "@/hooks/use-directory";
import { createRef } from "react";
import { Composer, RoomDeleted, type ComposerHandle } from "./composer";
import { editorLoaded } from "./editor";

// The editor here is test-setup.ts's stand-in for Lexxy, a text box whose lines are one paragraph,
// and every test starts before its code has loaded.
vi.mock("./editor", async (importOriginal) => ({ ...(await importOriginal<typeof import("./editor")>()), editorLoaded: vi.fn(() => false) }));

// The emoji picker, without Emojibase's data, which isn't served here: one emoji to pick.
vi.mock("./emoji-panel", () => ({
  default: ({ onPick }: { onPick: (emoji: string) => void }) => (
    <button type="button" onClick={() => onPick("🎉")}>
      🎉
    </button>
  ),
}));

async function showComposer({ typing = [] as User[], disabled = false, roomId = "r1", threadId = undefined as string | undefined, direct = false, autoFocus = true, mentionsAbove = false } = {}) {
  const onSend = vi.fn((_body: string, _alsoSend: boolean) => true);
  const onSendFiles = vi.fn((_files: File[], _alsoSend: boolean) => {});
  const onTyping = vi.fn();
  const composer = createRef<ComposerHandle>();
  const view = render(
    <Composer
      ref={composer}
      roomId={roomId}
      roomName="general"
      direct={direct}
      userId="u1"
      typing={typing}
      disabled={disabled}
      threadId={threadId}
      onSend={onSend}
      onSendFiles={onSendFiles}
      onTyping={onTyping}
      autoFocus={autoFocus}
      mentionsAbove={mentionsAbove}
    />,
  );
  // The editor loads as the first composer shows.
  const input = await within(view.container).findByRole("textbox", { name: threadId === undefined ? "Write a message" : "Write a reply" });
  return { onSend, onSendFiles, onTyping, composer, view, user: userEvent.setup(), input };
}

function touchScreen() {
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: media === "(pointer: coarse)", media, addEventListener() {}, removeEventListener() {} }));
}

const sendButton = () => screen.getByRole("button", { name: "Send Message" });
const showFormatting = () => screen.getByRole("button", { name: "Show formatting" });
const formattingRow = () => screen.queryByRole("toolbar", { name: "Formatting" });
const tool = (name: string) => within(formattingRow()!).getByRole("button", { name });
/** The file picker that Upload from your computer and Cmd or Ctrl+O open. */
const fileField = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(editorLoaded).mockReturnValue(false);
});

describe("Composer", () => {
  it("has the formatting row over the text box, and Slack's buttons below it in Slack's order", async () => {
    const { input, view } = await showComposer();
    expect(formattingRow()).toBeInTheDocument();
    expect(input).toHaveAttribute("placeholder", "Message #general");
    const below = [...view.container.querySelectorAll("form button")].filter((button) => !button.closest("[role=toolbar]"));
    expect(below.map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Attach", "Show formatting", "Emoji", "Mention someone", "Send Message"]);
    expect(fileField()).toHaveAttribute("multiple");
    expect(fileField()).not.toBeVisible();
  });

  it("focuses the text box as the room opens", async () => {
    const { input } = await showComposer();
    expect(input).toHaveFocus();
  });

  it("waits for a tap on touch screens, whose keyboard would cover the room", async () => {
    touchScreen();
    const { input } = await showComposer();
    expect(input).not.toHaveFocus();
  });

  it("lists the people @ finds above the text on touch screens, whose keyboard is under it", async () => {
    touchScreen();
    expect((await showComposer()).input).toHaveAttribute("data-mentions-above");
  });

  it("lists them above the text with a mouse only where it's asked to, as where something under the composer would cut the list off", async () => {
    const { input, view } = await showComposer();
    expect(input).not.toHaveAttribute("data-mentions-above");
    view.unmount();
    expect((await showComposer({ mentionsAbove: true })).input).toHaveAttribute("data-mentions-above");
  });

  const room = { roomId: "r1", roomName: "general", userId: "u1", typing: [], disabled: false, onSend: () => true, onSendFiles: () => {}, onTyping: () => {} };

  it("holds the editor back while the room's first messages are on their way, which loading it would delay", async () => {
    // React has the editor's code from an earlier composer, so it would show at once if it weren't held back.
    (await showComposer()).view.unmount();
    const view = render(<Composer {...room} deferEditor />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Message #general")).toBeInTheDocument();

    view.rerender(<Composer {...room} deferEditor={false} />);
    expect(await screen.findByRole("textbox", { name: "Write a message" })).toHaveFocus();
  });

  it("shows the editor at once when it has loaded for a room before", async () => {
    vi.mocked(editorLoaded).mockReturnValue(true);
    render(<Composer {...room} deferEditor />);
    expect(await screen.findByRole("textbox", { name: "Write a message" })).toHaveFocus();
  });

  it("leaves focus where it's been put while the editor was held back", async () => {
    (await showComposer()).view.unmount();
    const page = (deferEditor: boolean) => (
      <>
        <button type="button">Elsewhere</button>
        <Composer {...room} deferEditor={deferEditor} />
      </>
    );
    const view = render(page(true));
    screen.getByRole("button", { name: "Elsewhere" }).focus();

    view.rerender(page(false));
    expect(await screen.findByRole("textbox", { name: "Write a message" })).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  });

  it("takes focus from the last room's composer, which goes as this one opens", async () => {
    const { view } = await showComposer();
    view.rerender(<Composer key="r2" {...room} roomId="r2" />);
    expect(await screen.findByRole("textbox", { name: "Write a message" })).toHaveFocus();
  });
});

describe("Group DMs and DM names", () => {
  it("asks for a message to the others in a DM by name, without the #", async () => {
    render(<Composer roomId="d1" roomName="Grace and Linus" direct userId="u1" typing={[]} disabled={false} onSend={() => true} onSendFiles={() => {}} onTyping={() => {}} />);
    expect(await screen.findByRole("textbox", { name: "Write a message" })).toHaveAttribute("placeholder", "Message Grace and Linus");
  });
});

describe("Formatting row", () => {
  it("hides the row while Show formatting is let go, keeping focus in the text, as this browser remembers", async () => {
    const { input, user, view } = await showComposer();
    const form = view.container.querySelector("form")!;
    expect(showFormatting()).toHaveAttribute("aria-pressed", "true");
    expect(form).toHaveAttribute("data-formatting");

    await user.click(showFormatting());
    expect(showFormatting()).toHaveAttribute("aria-pressed", "false");
    expect(formattingRow()).not.toBeInTheDocument();
    expect(form).not.toHaveAttribute("data-formatting");
    expect(input).toHaveFocus();

    view.unmount();
    await showComposer();
    expect(formattingRow()).not.toBeInTheDocument();
    await user.click(showFormatting());
    expect(formattingRow()).toBeInTheDocument();
  });

  it("starts hidden on touch screens, whose keyboard leaves the composer little room", async () => {
    touchScreen();
    await showComposer();
    expect(formattingRow()).not.toBeInTheDocument();
    expect(showFormatting()).toHaveAttribute("aria-pressed", "false");
  });

  it("has Slack's buttons in Slack's order, each named with its keys", async () => {
    await showComposer();
    expect(within(formattingRow()!).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Bold",
      "Italic",
      "Underline",
      "Strikethrough",
      "Paragraph",
      "Link",
      "Ordered list",
      "Bulleted list",
      "Blockquote",
      "Code",
      "Code block",
      "Divider",
    ]);
    expect(tool("Strikethrough")).toHaveAttribute("aria-keyshortcuts", "Control+Shift+X");
    expect(tool("Link")).toHaveAttribute("aria-keyshortcuts", "Control+Shift+U");
    expect(tool("Divider")).not.toHaveAttribute("aria-keyshortcuts");
  });

  it("lights a button while its formatting is on where the cursor is, keeping focus in the text", async () => {
    const { input, user } = await showComposer();
    await user.click(tool("Bold"));
    await user.click(tool("Bulleted list"));
    expect(tool("Bold")).toHaveAttribute("aria-pressed", "true");
    expect(tool("Bulleted list")).toHaveAttribute("aria-pressed", "true");
    expect(tool("Ordered list")).toHaveAttribute("aria-pressed", "false");
    expect(input).toHaveFocus();

    await user.click(tool("Ordered list"));
    expect(tool("Bulleted list")).toHaveAttribute("aria-pressed", "false");
    expect(tool("Ordered list")).toHaveAttribute("aria-pressed", "true");
  });

  it("formats from Slack's keys, with the row hidden too, leaving Cmd or Ctrl+B, I and U to the editor", async () => {
    const { input, user } = await showComposer();
    await user.type(input, "struck");
    await user.keyboard("{Control>}{Shift>}X{/Shift}{/Control}");
    expect(tool("Strikethrough")).toHaveAttribute("aria-pressed", "true");

    await user.click(showFormatting());
    await user.keyboard("{Control>}{Shift>}({/Shift}{/Control}");
    await user.click(showFormatting());
    expect(tool("Blockquote")).toHaveAttribute("aria-pressed", "true");

    await user.keyboard("{Control>}b{/Control}");
    expect(tool("Bold")).toHaveAttribute("aria-pressed", "false");
  });

  it("styles the line from the Paragraph menu, its style ticked, and puts focus back in the text", async () => {
    const { input, user } = await showComposer();
    await user.click(tool("Paragraph"));
    expect(screen.getByRole("menuitemradio", { name: "Paragraph" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Paragraph", "Big headingH1", "Medium headingH2", "Small headingH3"]);

    await user.click(screen.getByRole("menuitemradio", { name: /Medium heading/ }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());

    await user.click(tool("Paragraph"));
    expect(screen.getByRole("menuitemradio", { name: /Medium heading/ })).toHaveAttribute("aria-checked", "true");
  });

  it("greys out what a code block has no use for, and its keys", async () => {
    const { input, user } = await showComposer();
    await user.click(tool("Code block"));
    expect(tool("Code block")).toHaveAttribute("aria-pressed", "true");
    for (const name of ["Bold", "Italic", "Underline", "Strikethrough", "Link", "Code", "Divider"]) expect(tool(name), name).toBeDisabled();
    for (const name of ["Paragraph", "Ordered list", "Bulleted list", "Blockquote", "Code block"]) expect(tool(name), name).toBeEnabled();

    input.focus();
    await user.keyboard("{Control>}{Shift>}X{/Shift}{/Control}");
    await user.click(tool("Code block"));
    expect(tool("Strikethrough")).toBeEnabled();
    expect(tool("Strikethrough")).toHaveAttribute("aria-pressed", "false");
  });

  it("is one stop in the tab order, whose arrow keys move along it, and Escape goes back to the text", async () => {
    const { input, user } = await showComposer();
    await user.tab({ shift: true });
    expect(tool("Bold")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(tool("Italic")).toHaveFocus();
    await user.keyboard("{End}");
    expect(tool("Divider")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(tool("Bold")).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(tool("Code block")).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(input).toHaveFocus();
    await user.tab({ shift: true });
    expect(tool("Code block")).toHaveFocus();
  });

  it("formats from the keyboard, leaving focus on the button for the next", async () => {
    const { user } = await showComposer();
    await user.tab({ shift: true });
    await user.keyboard("{Enter}");
    expect(tool("Bold")).toHaveAttribute("aria-pressed", "true");
    expect(tool("Bold")).toHaveFocus();
    await user.keyboard("{ArrowRight} ");
    expect(tool("Italic")).toHaveAttribute("aria-pressed", "true");
    expect(tool("Italic")).toHaveFocus();
  });
});

describe("Link", () => {
  /** The composer, `text` written in it, and `selected` selected, or else the cursor after the text. */
  async function written(text: string, selected = "") {
    const shown = await showComposer();
    await shown.user.type(shown.input, text);
    if (selected) {
      const start = text.indexOf(selected);
      (shown.input as HTMLTextAreaElement).setSelectionRange(start, start + selected.length);
    }
    return shown;
  }

  it("links what's selected through Link's dialog, taking an address without a scheme as a web address", async () => {
    const { input, user } = await written("Read the docs", "the docs");
    await user.click(tool("Link"));
    const dialog = screen.getByRole("dialog", { name: "Add link" });
    expect(within(dialog).getByLabelText("Text")).toHaveValue("the docs");
    expect(within(dialog).getByLabelText("Link")).toHaveFocus();
    expect(within(dialog).queryByRole("button", { name: "Remove link" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Link"), "example.com/docs{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveAttribute("data-linked", "https://example.com/docs"));
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Read the docs");
    expect(tool("Link")).toHaveAttribute("aria-pressed", "true");
  });

  it("opens from Cmd or Ctrl+Shift+U and Cmd or Ctrl+K, with the row hidden too, starting at the text with nothing selected", async () => {
    const { input, user } = await written("See ");
    await user.click(showFormatting());
    await user.keyboard("{Control>}{Shift>}U{/Shift}{/Control}");
    const dialog = screen.getByRole("dialog", { name: "Add link" });
    expect(within(dialog).getByLabelText("Text")).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "Add link" })).toBeInTheDocument();
  });

  it("writes the address as the text when the text's left blank, and leaves the text as it was on Cancel", async () => {
    const { input, user } = await written("See ");
    await user.click(tool("Link"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue("See ");

    await user.click(tool("Link"));
    await user.type(within(screen.getByRole("dialog")).getByLabelText("Link"), "https://example.com{Enter}");
    await waitFor(() => expect(input).toHaveValue("See https://example.com"));
  });

  it("edits the link the cursor is in, or takes it off, keeping its text", async () => {
    const { input, user } = await written("Read the docs", "the docs");
    await user.click(tool("Link"));
    await user.type(within(screen.getByRole("dialog")).getByLabelText("Link"), "example.com{Enter}");
    await waitFor(() => expect(input).toHaveAttribute("data-linked"));

    await user.click(tool("Link"));
    const dialog = screen.getByRole("dialog", { name: "Edit link" });
    expect(within(dialog).getByLabelText("Link")).toHaveValue("https://example.com");
    await user.click(within(dialog).getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(input).not.toHaveAttribute("data-linked"));
    expect(input).toHaveValue("Read the docs");
    expect(tool("Link")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("Send from the keyboard", () => {
  it("sends what's written on Enter, then empties the box and keeps focus", async () => {
    const { onSend, input, user } = await showComposer();
    await user.type(input, "Hello there{Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith("<p>Hello there</p>", false);
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
  });

  it("starts a new line on Shift+Enter instead of sending", async () => {
    const { onSend, input, user } = await showComposer();
    await user.type(input, "line one{Shift>}{Enter}{/Shift}line two");
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("line one\nline two");

    await user.click(sendButton());
    expect(onSend).toHaveBeenCalledWith("<p>line one<br>line two</p>", false);
  });

  it("sends on Enter with the formatting row showing, as Slack's does, and keeps the row", async () => {
    const { onSend, input, user } = await showComposer();
    await user.type(input, "one{Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith("<p>one</p>", false);
    expect(formattingRow()).toBeInTheDocument();
  });

  it("sends only from the Send button on touch screens", async () => {
    touchScreen();
    const { onSend, input, user } = await showComposer();
    await user.type(input, "Hi{Enter}");
    expect(onSend).not.toHaveBeenCalled();

    await user.click(sendButton());
    expect(onSend).toHaveBeenCalledOnce();
    expect(input).toHaveFocus();
  });

  it("won't send a blank message, though Send stays enabled", async () => {
    const { onSend, input, user } = await showComposer();
    expect(sendButton()).toBeEnabled();
    await user.type(input, "   {Enter}");
    await user.click(sendButton());
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
  });

  it("keeps what's written when the room won't take it, as when it's too long", async () => {
    const { onSend, input, user } = await showComposer();
    onSend.mockReturnValue(false);
    await user.type(input, "Too much{Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith("<p>Too much</p>", false);
    expect(input).toHaveValue("Too much");
    expect(input).toHaveFocus();
    expect(localStorage.getItem("composer-draft-u1-r1")).toBe("<p>Too much</p>");
  });

  it("holds on to the text while the room is disconnected", async () => {
    const { onSend, input, user } = await showComposer({ disabled: true });
    await user.type(input, "Are you there?{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("Are you there?");
    expect(sendButton()).toBeDisabled();
  });
});

/** A file named `name` of `size` bytes, as the browser gives it, which says it's that size without holding them. */
function fileOf(name: string, { type = "text/plain", size = 3 } = {}) {
  const file = new File(["abc"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

/** What's pasted: `files`, and no text. */
const clipboard = (...files: File[]) => ({ files, getData: () => "" });

/** The files waiting to be sent, by their chips' names. */
const chips = () => screen.queryAllByRole("button", { name: /^Remove / }).map((chip) => chip.getAttribute("aria-label"));

/** Makes the thumbnails' addresses `blob:<name>`, answering those made and those let go. */
function thumbnails() {
  const made: string[] = [];
  const revoked: string[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((file) => {
    made.push(`blob:${(file as File).name}`);
    return made.at(-1)!;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => revoked.push(url));
  return { made, revoked };
}

describe("Attach files", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waits to send the files picked with Attach files, in order of their names, however often they're picked", async () => {
    const { user } = await showComposer();
    await user.upload(fileField(), [fileOf("b.txt"), fileOf("A.pdf"), fileOf("a.txt")]);
    expect(chips()).toEqual(["Remove A.pdf", "Remove a.txt", "Remove b.txt"]);

    await user.upload(fileField(), fileOf("a.txt"));
    expect(chips()).toEqual(["Remove A.pdf", "Remove a.txt", "Remove a.txt", "Remove b.txt"]);
    expect(fileField()).toHaveValue("");
  });

  it("shows a picture's thumbnail, and a file icon for anything else, over its name up to its last dot and its extension", async () => {
    const { made } = thumbnails();
    const { user } = await showComposer();
    await user.upload(fileField(), [fileOf("moon.jpg", { type: "image/jpeg" }), fileOf("archive.tar.gz", { type: "application/gzip" }), fileOf("README")]);

    const moon = screen.getByRole("button", { name: "Remove moon.jpg" });
    expect(made).toEqual(["blob:moon.jpg"]);
    expect(moon.querySelector("img")).toHaveAttribute("src", "blob:moon.jpg");
    const archive = screen.getByRole("button", { name: "Remove archive.tar.gz" });
    expect(archive.querySelector("img")).toBeNull();
    expect(archive.querySelector("svg")).toHaveClass("iconoir-page");
    // The name runs to an ellipsis, and the extension doesn't.
    expect(within(archive).getByText("archive.tar.")).toHaveClass("truncate");
    expect(within(archive).getByText("gz")).toHaveClass("shrink-0");
    // A name with no dot shows whole.
    expect(within(screen.getByRole("button", { name: "Remove README" })).getByText("README")).toHaveClass("truncate");
  });

  it("takes a file back out when its chip is pressed, letting go of its thumbnail", async () => {
    const { revoked } = thumbnails();
    const { user, onSendFiles } = await showComposer();
    await user.upload(fileField(), [fileOf("moon.jpg", { type: "image/jpeg" }), fileOf("notes.txt")]);
    await user.click(screen.getByRole("button", { name: "Remove moon.jpg" }));
    expect(chips()).toEqual(["Remove notes.txt"]);
    expect(revoked).toEqual(["blob:moon.jpg"]);

    await user.click(sendButton());
    expect(onSendFiles).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ name: "notes.txt" })], false);
  });

  it("sends the files, each as a message of its own, before what's written, and empties the list", async () => {
    const { onSend, onSendFiles, input, user } = await showComposer();
    const [b, a] = [fileOf("b.txt"), fileOf("a.txt")];
    await user.upload(fileField(), [b, a]);
    await user.type(input, "Here they are{Enter}");
    expect(onSendFiles).toHaveBeenCalledExactlyOnceWith([a, b], false);
    expect(onSend).toHaveBeenCalledExactlyOnceWith("<p>Here they are</p>", false);
    expect(onSendFiles.mock.invocationCallOrder[0]).toBeLessThan(onSend.mock.invocationCallOrder[0]!);
    expect(chips()).toEqual([]);
    expect(input).toHaveFocus();
  });

  it("sends the files picked before the editor shows, as its code loads, which what's written waits for", async () => {
    (await showComposer()).view.unmount();
    const onSendFiles = vi.fn();
    const user = userEvent.setup();
    render(<Composer roomId="r1" roomName="general" userId="u1" typing={[]} disabled={false} deferEditor onSend={() => true} onSendFiles={onSendFiles} onTyping={() => {}} />);
    await user.upload(fileField(), fileOf("a.txt"));
    await user.click(sendButton());
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(onSendFiles).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ name: "a.txt" })], false);
    expect(chips()).toEqual([]);
  });

  it("sends files with nothing written", async () => {
    const { onSend, onSendFiles, user } = await showComposer();
    await user.upload(fileField(), fileOf("a.txt"));
    await user.click(sendButton());
    expect(onSendFiles).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();

    // Nor anything at all with nothing picked.
    await user.click(sendButton());
    expect(onSendFiles).toHaveBeenCalledOnce();
  });

  it("holds on to the files while the room is disconnected, when files can't be picked", async () => {
    const { onSendFiles, composer, input, user } = await showComposer({ disabled: true });
    expect(fileField()).toBeDisabled();
    act(() => composer.current!.addFiles([fileOf("a.txt")]));
    await user.type(input, "{Enter}");
    expect(onSendFiles).not.toHaveBeenCalled();
    expect(chips()).toEqual(["Remove a.txt"]);
  });

  it("waits to send the files dropped on the composer, the text box included, as a copy", async () => {
    const { input, view } = await showComposer();
    const form = view.container.querySelector("form")!;
    const dataTransfer = { files: [fileOf("dropped.txt")], dropEffect: "none" };
    // Each is cancelled, so the browser doesn't open the file in place of the page.
    expect(fireEvent.dragEnter(form, { dataTransfer })).toBe(false);
    expect(fireEvent.dragOver(form, { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(fireEvent.drop(form, { dataTransfer })).toBe(false);
    expect(chips()).toEqual(["Remove dropped.txt"]);

    expect(fireEvent.drop(input, { dataTransfer: { files: [fileOf("on the text.txt")] } })).toBe(false);
    expect(chips()).toEqual(["Remove dropped.txt", "Remove on the text.txt"]);
    expect(input).toHaveValue("");
  });

  it("waits to send the files dropped on the room's messages, which the room hands over", async () => {
    const { composer } = await showComposer();
    act(() => composer.current!.addFiles([fileOf("b.txt"), fileOf("a.txt")]));
    expect(chips()).toEqual(["Remove a.txt", "Remove b.txt"]);
  });
});

describe("The buttons under the text", () => {
  afterEach(() => vi.restoreAllMocks());

  // Hidden from screen readers, as everything but the menu is, while the menu's open.
  const attach = () => screen.getByRole("button", { name: "Attach", hidden: true });

  it("greys Send out until something's written or a file's picked, as Slack's is", async () => {
    const { input, user } = await showComposer();
    expect(sendButton()).toHaveAttribute("data-empty");
    await user.type(input, "Hi");
    expect(sendButton()).not.toHaveAttribute("data-empty");

    await user.type(input, "{Enter}");
    expect(sendButton()).toHaveAttribute("data-empty");
    await user.upload(fileField(), fileOf("a.txt"));
    expect(sendButton()).not.toHaveAttribute("data-empty");
  });

  it("offers Text snippet and Upload from your computer from +, an × while they show, which opens the file picker", async () => {
    const { input, user } = await showComposer();
    const picking = vi.spyOn(fileField(), "click").mockImplementation(() => {});
    expect(attach().querySelector("svg")).toHaveClass("iconoir-plus");
    await user.click(attach());
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Text snippetCtrl+Shift+Enter", "Upload from your computerCtrl+O"]);
    expect(screen.getByRole("menuitem", { name: /Upload/ })).toHaveAttribute("aria-keyshortcuts", "Control+O");
    expect(attach().querySelector("svg")).toHaveClass("iconoir-xmark");

    await user.click(screen.getByRole("menuitem", { name: /Upload from your computer/ }));
    expect(picking).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(attach().querySelector("svg")).toHaveClass("iconoir-plus");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("opens the file picker on Cmd or Ctrl+O, and Text snippet on Cmd or Ctrl+Shift+Enter, which doesn't send", async () => {
    const { input, onSend, user } = await showComposer();
    const picking = vi.spyOn(fileField(), "click").mockImplementation(() => {});
    await user.type(input, "Hello");
    await user.keyboard("{Control>}o{/Control}");
    expect(picking).toHaveBeenCalledOnce();

    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    expect(onSend).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog", { name: "Create a text snippet" })).toBeInTheDocument();
  });

  it("adds a text snippet as a text file named after its title, to send with the next message", async () => {
    const { input, onSendFiles, user } = await showComposer();
    await user.click(attach());
    await user.click(screen.getByRole("menuitem", { name: /Text snippet/ }));
    const dialog = await screen.findByRole("dialog", { name: "Create a text snippet" });
    const create = within(dialog).getByRole("button", { name: "Create snippet" });
    await waitFor(() => expect(within(dialog).getByLabelText("Content")).toHaveFocus());
    expect(create).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Content"), "echo hi");
    await user.type(within(dialog).getByLabelText("Title (optional)"), "deploy.sh");
    await user.click(create);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(chips()).toEqual(["Remove deploy.sh"]);
    await waitFor(() => expect(input).toHaveFocus());

    await user.click(sendButton());
    const [snippet] = onSendFiles.mock.calls[0]![0];
    expect(snippet!.type).toBe("text/plain");
    expect(await snippet!.text()).toBe("echo hi");
  });

  it("names an untitled snippet Untitled.txt, and creates it on Cmd or Ctrl+Enter", async () => {
    const { user } = await showComposer();
    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Create a text snippet" });
    await user.type(within(dialog).getByLabelText("Content"), "First line{Enter}Second line{Control>}{Enter}{/Control}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(chips()).toEqual(["Remove Untitled.txt"]);
  });

  it("writes the emoji picked where the cursor is, and puts focus back in the text", async () => {
    const { input, user } = await showComposer();
    await user.type(input, "Party ");
    await user.click(screen.getByRole("button", { name: "Emoji" }));
    await user.click(await screen.findByRole("button", { name: "🎉" }));
    expect(input).toHaveValue("Party 🎉");
    expect(screen.queryByRole("dialog", { name: "Emoji" })).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("types @ for the people to mention, after a space where the cursor follows a word, keeping focus in the text", async () => {
    const { input, user } = await showComposer();
    await user.click(screen.getByRole("button", { name: "Mention someone" }));
    expect(input).toHaveValue("@");
    expect(input).toHaveFocus();

    await user.type(input, "{Backspace}Thanks");
    await user.click(screen.getByRole("button", { name: "Mention someone" }));
    expect(input).toHaveValue("Thanks @");
  });
});

describe("Pasting into the composer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waits to send pasted files rather than writing them, and leaves pasted text to the editor", async () => {
    thumbnails();
    const { input } = await showComposer();
    expect(fireEvent.paste(input, { clipboardData: clipboard(fileOf("pasted.png", { type: "image/png" })) })).toBe(false);
    expect(chips()).toEqual(["Remove pasted.png"]);
    expect(input).toHaveValue("");

    expect(fireEvent.paste(input, { clipboardData: clipboard() })).toBe(true);
    expect(chips()).toEqual(["Remove pasted.png"]);
  });
});

describe("250 MB file limit", () => {
  const tooLarge = (name: string) => `${name} is too large. Choose a file that’s 250 MB or smaller.`;

  it("leaves out files over 250 MB, saying so under the others until more are picked, dropped or pasted", async () => {
    const { input, user, view, onSendFiles } = await showComposer();
    await user.upload(fileField(), [
      fileOf("huge.mov", { size: MAX_FILE_SIZE + 1 }),
      fileOf("fits.mov", { size: MAX_FILE_SIZE }),
      fileOf("vast.iso", { size: MAX_FILE_SIZE + 1 }),
    ]);
    expect(chips()).toEqual(["Remove fits.mov"]);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(`${tooLarge("huge.mov")} ${tooLarge("vast.iso")}`, { normalizeWhitespace: false });
    expect(alert).toHaveClass("w-full", "text-negative");

    // It stays through sending and removing files.
    await user.click(sendButton());
    expect(onSendFiles).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ name: "fits.mov" })], false);
    expect(screen.getByRole("alert")).toBe(alert);

    // Picking more says only what's wrong with them.
    await user.upload(fileField(), fileOf("enormous.zip", { size: MAX_FILE_SIZE + 1 }));
    expect(screen.getByRole("alert")).toHaveTextContent(tooLarge("enormous.zip"), { normalizeWhitespace: false });
    fireEvent.drop(view.container.querySelector("form")!, { dataTransfer: { files: [fileOf("small.txt")] } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Pasting anything clears it, even text.
    await user.upload(fileField(), fileOf("enormous.zip", { size: MAX_FILE_SIZE + 1 }));
    fireEvent.paste(input, { clipboardData: clipboard() });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Keep drafts", () => {
  const draft = (roomId = "r1") => localStorage.getItem(`composer-draft-u1-${roomId}`);

  it("keeps what's written in this browser until it's sent", async () => {
    const { input, user } = await showComposer();
    await user.type(input, "Hello");
    expect(draft()).toBe("<p>Hello</p>");

    await user.keyboard("{Enter}");
    expect(draft()).toBeNull();
  });

  it("forgets it once the box is emptied", async () => {
    const { input, user } = await showComposer();
    await user.type(input, "Hello");
    await user.clear(input);
    expect(draft()).toBeNull();
  });

  it("brings it back, with the cursor at the end, when the room opens again", async () => {
    localStorage.setItem("composer-draft-u1-r1", "<p>Where was I</p>");
    const { input } = await showComposer();
    expect(input).toHaveValue("Where was I");
    expect(input).toHaveFocus();
    expect((input as HTMLTextAreaElement).selectionStart).toBe("Where was I".length);
  });

  it("keeps each room's apart", async () => {
    localStorage.setItem("composer-draft-u1-r2", "<p>For the other room</p>");
    const { input } = await showComposer({ roomId: "r1" });
    expect(input).toHaveValue("");
  });

  it("keeps each person's apart, so whoever signs in on this browser next doesn't see it", async () => {
    localStorage.setItem("composer-draft-u2-r1", "<p>Grace's own</p>");
    const { input } = await showComposer({ roomId: "r1" });
    expect(input).toHaveValue("");
  });
});

describe("Reply in a thread", () => {
  const alsoSend = () => screen.getByRole("checkbox", { name: "Also send to #general" });

  it("asks for a reply, with Also send to the room, unticked, before Send", async () => {
    const { input } = await showComposer({ threadId: "m1" });
    expect(input).toHaveAttribute("placeholder", "Reply…");
    expect(alsoSend()).not.toBeChecked();
    expect(alsoSend().compareDocumentPosition(sendButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers to send it as a direct message too in a DM", async () => {
    await showComposer({ threadId: "m1", direct: true });
    expect(screen.getByRole("checkbox", { name: "Also send as direct message" })).not.toBeChecked();
  });

  it("sends a reply to the thread alone, or to the room too while Also send is ticked, which sending unticks", async () => {
    const { onSend, input, user } = await showComposer({ threadId: "m1" });
    await user.type(input, "Just here{Enter}");
    expect(onSend).toHaveBeenLastCalledWith("<p>Just here</p>", false);

    await user.click(alsoSend());
    await user.type(input, "Everywhere{Enter}");
    expect(onSend).toHaveBeenLastCalledWith("<p>Everywhere</p>", true);
    expect(alsoSend()).not.toBeChecked();
  });

  it("sends files to the room too while Also send is ticked", async () => {
    const { onSendFiles, user } = await showComposer({ threadId: "m1" });
    await user.upload(fileField(), new File(["hi"], "notes.txt", { type: "text/plain" }));
    await user.click(alsoSend());
    await user.click(sendButton());
    expect(onSendFiles).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ name: "notes.txt" })], true);
    expect(alsoSend()).not.toBeChecked();
  });

  it("keeps a thread's draft apart from its room's", async () => {
    localStorage.setItem("composer-draft-u1-r1", "<p>For the room</p>");
    const { input, user } = await showComposer({ threadId: "m1" });
    expect(input).toHaveValue("");
    await user.type(input, "For the thread");
    expect(localStorage.getItem("composer-draft-u1-r1/threads/m1")).toBe("<p>For the thread</p>");
    expect(localStorage.getItem("composer-draft-u1-r1")).toBe("<p>For the room</p>");
  });

  it("leaves focus be as the room opens with a thread beside it, which takes it", async () => {
    const { input } = await showComposer({ autoFocus: false });
    expect(input).not.toHaveFocus();
  });
});

describe("A thread's draft, beside its room and in the room's huddle over it", () => {
  const draft = () => localStorage.getItem("composer-draft-u1-r1/threads/m1");

  /** The thread's composer beside its room, with its text box as it is now: another, once the editor has opened again. */
  async function showBeside() {
    const shown = await showComposer({ threadId: "m1" });
    const own = within(shown.view.container);
    return { ...shown, box: () => own.getByRole("textbox", { name: "Write a reply" }), send: () => own.getByRole("button", { name: "Send Message" }) };
  }

  /** The same thread's composer in its room's huddle, which opens over the one beside the room and leaves focus where it is. */
  const showInHuddle = () => showComposer({ threadId: "m1", autoFocus: false });

  it("opens the huddle's with what was begun beside the room, which shows what the huddle's left of it once that's gone, leaving focus where it is", async () => {
    const beside = await showBeside();
    await beside.user.upload(fileField(), new File(["hi"], "notes.txt", { type: "text/plain" }));
    await beside.user.click(screen.getByRole("checkbox", { name: "Also send to #general" }));
    await beside.user.type(beside.input, "Shipping on");
    const huddle = await showInHuddle();
    expect(huddle.input).toHaveValue("Shipping on");

    // Only the one in front can be written in, so the other has it once it's in front again.
    await huddle.user.type(huddle.input, " Friday");
    expect(beside.box()).toBe(beside.input);
    expect(beside.box()).toHaveValue("Shipping on");
    beside.onTyping.mockClear();
    huddle.view.unmount();
    expect(beside.box()).toHaveValue("Shipping on Friday");
    expect(beside.box()).not.toHaveFocus();
    expect(draft()).toBe("<p>Shipping on Friday</p>");
    // It wasn't typed here, so the room hears of no typing, and what waits to go with the reply still does.
    expect(beside.onTyping).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove notes.txt" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Also send to #general" })).toBeChecked();

    // A huddle's that leaves it as it found it leaves the editor as it is.
    const reopened = beside.box();
    (await showInHuddle()).view.unmount();
    expect(beside.box()).toBe(reopened);
    await beside.user.type(beside.box(), "{Enter}");
    expect(beside.onSend).toHaveBeenCalledExactlyOnceWith("<p>Shipping on Friday</p>", true);
  });

  it("has nothing left written beside the room once the reply's been sent from the huddle, so it can't be sent twice", async () => {
    const beside = await showBeside();
    await beside.user.type(beside.input, "Shipping on Friday");
    const huddle = await showInHuddle();
    await huddle.user.type(huddle.input, "{Enter}");
    expect(huddle.onSend).toHaveBeenCalledExactlyOnceWith("<p>Shipping on Friday</p>", false);
    huddle.view.unmount();

    expect(beside.box()).toHaveValue("");
    expect(beside.send()).toHaveAttribute("data-empty");
    await beside.user.type(beside.box(), "{Enter}");
    expect(beside.onSend).not.toHaveBeenCalled();
  });

  it("takes up what was begun in the huddle as a draft it opens with: Send lights, and emptying it tells the room its writer has stopped", async () => {
    const beside = await showBeside();
    const huddle = await showInHuddle();
    await huddle.user.type(huddle.input, "Hello");
    huddle.view.unmount();

    expect(beside.box()).toHaveValue("Hello");
    expect(beside.send()).not.toHaveAttribute("data-empty");
    expect(beside.onTyping).not.toHaveBeenCalled();
    await beside.user.clear(beside.box());
    expect(beside.onTyping).toHaveBeenCalledExactlyOnceWith(false);
    expect(draft()).toBeNull();
  });

  it("leaves what's written, and focus, as they are where the huddle's left the draft as it found it", async () => {
    const beside = await showBeside();
    await beside.user.type(beside.input, "Hello");
    (await showInHuddle()).view.unmount();
    expect(beside.box()).toBe(beside.input);
    expect(beside.input).toHaveValue("Hello");
    expect(beside.input).toHaveFocus();
  });

  it("leaves the huddle's as it is when the one under it goes, which was written in before it, whether the huddle's has been written in or not", async () => {
    const huddlesBox = () => within(huddle.view.container).getByRole("textbox", { name: "Write a reply" });
    const beside = await showBeside();
    await beside.user.type(beside.input, "Hello");
    const huddle = await showInHuddle();
    beside.view.unmount();
    expect(huddlesBox()).toBe(huddle.input);
    expect(huddle.input).toHaveValue("Hello");

    const besideAgain = await showBeside();
    await huddle.user.type(huddle.input, " there");
    besideAgain.view.unmount();
    expect(huddlesBox()).toBe(huddle.input);
    expect(huddle.input).toHaveValue("Hello there");
    expect(huddle.input).toHaveFocus();
  });

  it("leaves each with what's written in it where this browser keeps no drafts, so neither has the other's to show", async () => {
    const refuse = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: refuse, setItem: refuse, removeItem: refuse });
    const beside = await showBeside();
    await beside.user.type(beside.input, "Hello");
    const huddle = await showInHuddle();
    expect(huddle.input).toHaveValue("");
    await huddle.user.type(huddle.input, "Hi{Enter}");
    huddle.view.unmount();
    expect(beside.box()).toBe(beside.input);
    expect(beside.input).toHaveValue("Hello");
  });
});

describe("Reply with a quote", () => {
  it("writes a reply in place of what's written, with the cursor at its end, keeping it as the draft", async () => {
    const composer = createRef<ComposerHandle>();
    const onTyping = vi.fn();
    render(
      <Composer ref={composer} roomId="r1" roomName="general" userId="u1" typing={[]} disabled={false} onSend={() => true} onSendFiles={() => {}} onTyping={onTyping} />,
    );
    const input = await screen.findByRole("textbox", { name: "Write a message" });
    await userEvent.setup().type(input, "Unsent");
    act(() => (input as HTMLTextAreaElement).blur());

    // The stand-in holds a quote as Action Text's plain text, in quotation marks.
    act(() => composer.current!.replace("<blockquote><p>Third time's a charm.</p></blockquote><cite>Ada</cite><p><br></p>"));
    const written = "“Third time's a charm.”\n\nAda";
    expect(input).toHaveValue(written);
    expect(input).toHaveFocus();
    expect((input as HTMLTextAreaElement).selectionStart).toBe(written.length);
    expect(localStorage.getItem("composer-draft-u1-r1")).toBe("<p>“Third time's a charm.”<br><br>Ada</p>");
    expect(onTyping).toHaveBeenLastCalledWith(true);
  });

  it("opens the editor with a reply written while its code loaded, taking focus, even on touch screens", async () => {
    (await showComposer()).view.unmount();
    touchScreen();
    const composer = createRef<ComposerHandle>();
    const onTyping = vi.fn();
    const page = (deferEditor: boolean) => (
      <Composer
        ref={composer}
        roomId="r1"
        roomName="general"
        userId="u1"
        typing={[]}
        disabled={false}
        deferEditor={deferEditor}
        onSend={() => true}
        onSendFiles={() => {}}
        onTyping={onTyping}
      />
    );
    const view = render(page(true));
    const quote = "<blockquote><p>Third time's a charm.</p></blockquote><cite>Ada</cite><p><br></p>";
    act(() => composer.current!.replace(quote));
    expect(localStorage.getItem("composer-draft-u1-r1")).toBe(quote);
    expect(onTyping).toHaveBeenLastCalledWith(true);

    view.rerender(page(false));
    const input = await screen.findByRole("textbox", { name: "Write a message" });
    expect(input).toHaveValue("“Third time's a charm.”\n\nAda");
    expect(input).toHaveFocus();
  });
});

describe("Link previews while writing", () => {
  const basecamp: LinkPreview = { title: "Basecamp", url: "https://basecamp.com/", image: "https://basecamp.com/og.png", description: "Calm & organized" };

  /** Answers each ask for a link's preview with what `answer` gives for its address. */
  function previews(answer: (url: string) => Response | Promise<Response>) {
    const fetch = vi.fn(async (_path: string, init: RequestInit) => answer(JSON.parse(init.body as string).url));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  /** The link previews the composer shows. */
  const shownPreviews = (view: ReturnType<typeof render>) => view.container.querySelectorAll(`action-text-attachment[content-type="${OPENGRAPH_EMBED_CONTENT_TYPE}"]`);

  it("adds the preview of a pasted link's page below it, which goes with the message", async () => {
    const fetch = previews(() => Response.json(basecamp));
    const { onSend, user } = await showComposer();
    await user.paste("https://basecamp.com");
    expect(await screen.findByRole("link", { name: "Basecamp" })).toHaveAttribute("href", "https://basecamp.com/");
    expect(fetch).toHaveBeenCalledWith("/api/unfurl", expect.objectContaining({ method: "POST", body: JSON.stringify({ url: "https://basecamp.com" }) }));

    await user.keyboard("{Enter}");
    const sent = new DOMParser().parseFromString(onSend.mock.calls[0]![0], "text/html").body;
    expect(sent.querySelector("p")!.textContent).toBe("https://basecamp.com");
    const attachment = sent.querySelector("action-text-attachment")!;
    expect(attachment.getAttribute("content-type")).toBe(OPENGRAPH_EMBED_CONTENT_TYPE);
    expect(attachment.getAttribute("content")).toBe(
      previewContent({ href: "https://basecamp.com/", url: "https://basecamp.com/og.png", filename: "Basecamp", description: "Calm & organized" }),
    );
  });

  it("adds nothing for a page without a preview, or a preview that can't be had", async () => {
    const answers: Record<string, Response> = {
      "https://example.com/none": new Response(null, { status: 204 }),
      "https://example.com/limited": Response.json({ error: "Too many link previews. Try again in a minute." }, { status: 429 }),
      "https://example.com/untitled": Response.json({ ...basecamp, title: "" }),
    };
    const fetch = previews((url) => answers[url]!);
    const { user, view } = await showComposer();
    for (const url of Object.keys(answers)) await user.paste(url);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(shownPreviews(view)).toHaveLength(0);
  });

  it("forgets the preview of a link once another is pasted, or the composer goes", async () => {
    let answerFirst!: () => void;
    const firstAnswered = new Promise<void>((resolve) => (answerFirst = resolve));
    const fetch = previews(async (url) => {
      if (url.endsWith("first")) await firstAnswered;
      return Response.json({ ...basecamp, title: url });
    });
    const { user, view } = await showComposer();
    await user.paste("https://example.com/first");
    await user.paste("https://example.com/second");
    expect(await screen.findByRole("link", { name: "https://example.com/second" })).toBeInTheDocument();
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
    await act(async () => answerFirst());
    expect(shownPreviews(view)).toHaveLength(1);

    await user.paste("https://example.com/third");
    view.unmount();
    expect(fetch.mock.calls[2]![1].signal!.aborted).toBe(true);
  });

  it("forgets it too once the editor it was pasted in opens again, with what another composer left of its draft", async () => {
    const fetch = previews(() => new Promise<Response>(() => {}));
    const { user } = await showComposer({ threadId: "m1" });
    await user.paste("https://example.com/slow");
    const over = await showComposer({ threadId: "m1", autoFocus: false });
    await over.user.type(over.input, " is slow");
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(false);
    over.view.unmount();
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
  });
});

describe("Typing indicator", () => {
  it("reports typing while there's text, and stops when it's cleared, but not when the box loses focus", async () => {
    const { onTyping, input, user } = await showComposer();
    await user.type(input, "Hi");
    expect(onTyping).toHaveBeenLastCalledWith(true);
    await user.clear(input);
    expect(onTyping).toHaveBeenLastCalledWith(false);
    await user.type(input, "Hi");
    onTyping.mockClear();
    await user.tab();
    expect(onTyping).not.toHaveBeenCalled();
  });

  it("leaves it to the message, whose arrival stops the others showing you typing", async () => {
    const { onTyping, input, user } = await showComposer();
    await user.type(input, "Hi{Enter}");
    expect(onTyping).not.toHaveBeenCalledWith(false);
  });

  const typist = (name: string, i: number): User => ({ id: `u${i}`, name });

  it.each([
    [["Ada"], "Ada"],
    [["Grace", "Ada"], "Ada, Grace"],
    [["Linus", "Grace", "Ada", "Ken"], "Ada, Grace, Ken, Linus"],
    // Sorted by code unit, as JavaScript sorts strings, so capitals come first.
    [["ada", "Bob"], "Bob, ada"],
  ])("names whoever is typing after a spinner, sorted and comma-separated: %j", async (names, line) => {
    const { view } = await showComposer({ typing: names.map(typist) });
    const indicator = view.container.querySelector(".spinner")!;
    expect(indicator).toHaveTextContent(line, { normalizeWhitespace: false });
    expect(indicator).not.toHaveClass("hidden");
    expect(indicator.parentElement).not.toHaveClass("opacity-0");
    expect(indicator.closest("[aria-live]")).toBeNull();
  });

  it("names them as the people directory lists them now, which follows a rename since the room heard them", async () => {
    const grace = { id: "u2", name: "Grace Hopper", bio: null, role: "member", status: "active", avatarUrl: "/users/u2/avatar" } as const;
    const { container } = render(
      <PeopleContext value={new Map([[grace.id, grace]])}>
        <Composer
          roomId="r1"
          roomName="general"
          userId="u1"
          typing={[typist("Linus", 1), typist("Grace", 2)]}
          disabled={false}
          onSend={vi.fn(() => true)}
          onSendFiles={vi.fn()}
          onTyping={vi.fn()}
        />
      </PeopleContext>,
    );
    await screen.findByRole("textbox", { name: "Write a message" });
    expect(container.querySelector(".spinner")).toHaveTextContent("Grace Hopper, Linus", { normalizeWhitespace: false });
  });

  it("shows nothing while nobody is typing, and fades in when someone starts", async () => {
    const { view } = await showComposer();
    const indicator = view.container.querySelector(".spinner")!;
    expect(indicator).toHaveTextContent("");
    expect(indicator).toHaveClass("hidden");
    expect(indicator.parentElement).toHaveClass("opacity-0", "transition-opacity", "duration-300");
  });
});

describe("Only members see a room", () => {
  it("says a room that's gone was deleted, in red, shaking once where motion is welcome", () => {
    render(<RoomDeleted />);
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("This room was deleted.");
    expect(notice).toHaveClass("text-negative", "border-negative", "motion-safe:animate-shake");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
