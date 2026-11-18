import { MAX_PREVIEW_SIZE, type StoredFile } from "@ember/protocol";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { svgDataUrl } from "@/lib/svg-preview";
import { fileText, MAX_SHOWN_TEXT_SIZE } from "@/lib/text-preview";
import { Attachment } from "./attachment";

// jsdom decodes no SVGs, so lib/svg-preview.test.ts tests how they're loaded, and e2e/ shows real ones.
vi.mock("@/lib/svg-preview", () => ({ svgDataUrl: vi.fn() }));
// lib/text-preview.test.ts tests how text files are read.
vi.mock("@/lib/text-preview", async (original) => ({ ...(await original<typeof import("@/lib/text-preview")>()), fileText: vi.fn() }));

/** A file called `name` of `contentType`, as a message has it. */
const stored = (name: string, contentType: string, overrides: Partial<StoredFile> = {}): StoredFile => {
  const url = `/files/k1/s1/${encodeURIComponent(name)}`;
  return { id: "k1", name, contentType, byteSize: 1234, url, downloadUrl: `${url}?disposition=attachment`, ...overrides };
};

/** Whether the file's card shows, by its Download link. */
const card = (name: string) => screen.queryByRole("link", { name: `Download ${name}` });

describe("Image, video and file previews", () => {
  it("shows a picture by its thumbnail, lazily, linking to the file, in a box half its size scaled into 1200×800 and no more than 480px wide or 70% of the screen tall", () => {
    render(<Attachment file={stored("moon.jpg", "image/jpeg", { width: 2400, height: 1600, previewUrl: "/previews/k1/s1/moon.jpg" })} />);
    const picture = screen.getByRole("img", { name: "moon.jpg" });
    expect(picture).toHaveAttribute("src", "/previews/k1/s1/moon.jpg");
    expect(picture).toHaveAttribute("loading", "lazy");
    const link = screen.getByRole("link", { name: "moon.jpg" });
    expect(link).toHaveAttribute("href", "/files/k1/s1/moon.jpg");
    expect(link).toHaveAttribute("style", "width: min(600px, 480px, 1.5*70dvh); aspect-ratio: 1200 / 800;");
    expect(card("moon.jpg")).not.toBeInTheDocument();
    cleanup();

    render(<Attachment file={stored("dot.png", "image/png", { width: 40, height: 20, previewUrl: "/previews/k1/s1/dot.png" })} />);
    expect(screen.getByRole("link", { name: "dot.png" })).toHaveAttribute("style", "width: min(20px, 480px, 2*70dvh); aspect-ratio: 40 / 20;");
  });

  it("shows a picture without a thumbnail, as a bot's, as itself if every browser shows it and it's no more than 5 MiB and 250 megapixels, and as a card otherwise", () => {
    for (const file of [
      stored("earth.gif", "image/gif", { width: 640, height: 320, byteSize: MAX_PREVIEW_SIZE }),
      stored("panorama.png", "image/png", { width: 25_000, height: 10_000 }),
    ]) {
      render(<Attachment file={file} />);
      expect(screen.getByRole("img", { name: file.name })).toHaveAttribute("src", file.url);
      cleanup();
    }

    for (const file of [
      stored("earth.png", "image/png", { width: 640, height: 320, byteSize: MAX_PREVIEW_SIZE + 1 }),
      stored("earth.heic", "image/heic", { width: 640, height: 320 }),
      // A small file can hold a picture far too large to decode, and its size can't always be read.
      stored("panorama.png", "image/png", { width: 25_001, height: 10_000 }),
      stored("earth.webp", "image/webp"),
    ]) {
      render(<Attachment file={file} />);
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(card(file.name)).toBeInTheDocument();
      cleanup();
    }
  });

  it("shows a picture of unknown size by its thumbnail at the thumbnail's own size, up to 480px wide and 640px or 70% of the screen tall", () => {
    render(<Attachment file={stored("earth.webp", "image/webp", { previewUrl: "/previews/k1/s1/earth.webp" })} />);
    const link = screen.getByRole("link", { name: "earth.webp" });
    expect(link).not.toHaveAttribute("style");
    expect(link).toHaveClass("w-fit", "max-w-[min(480px,100%)]");
    expect(screen.getByRole("img", { name: "earth.webp" })).toHaveClass("max-h-[min(640px,70dvh)]", "max-w-full");
  });

  it("plays a video in place, in a box half its size, loading nothing until it's played behind its poster, or its first frame without one", () => {
    const { container } = render(<Attachment file={stored("launch.mp4", "video/mp4", { width: 1280, height: 720, previewUrl: "/previews/k1/s1/launch.mp4" })} />);
    const video = container.querySelector("video")!;
    expect(video).toHaveAttribute("src", "/files/k1/s1/launch.mp4");
    expect(video).toHaveAttribute("poster", "/previews/k1/s1/launch.mp4");
    expect(video).toHaveAttribute("preload", "none");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAccessibleName("launch.mp4");
    expect(video.parentElement).toHaveAttribute("style", "width: 600px; aspect-ratio: 1200 / 675;");
    expect(card("launch.mp4")).not.toBeInTheDocument();
    cleanup();

    // As a bot's, or one its uploader's browser couldn't play.
    const { container: unplayed } = render(<Attachment file={stored("launch.mov", "video/quicktime")} />);
    const without = unplayed.querySelector("video")!;
    expect(without).toHaveAttribute("src", "/files/k1/s1/launch.mov");
    expect(without).not.toHaveAttribute("poster");
    expect(without).toHaveAttribute("preload", "metadata");
    expect(without.parentElement).not.toHaveAttribute("style");
  });

  it("shows any other file as its card", () => {
    for (const file of [stored("Q3 report.pdf", "application/pdf"), stored("theme.mp3", "audio/mpeg")]) {
      const { container } = render(<Attachment file={file} />);
      expect(card(file.name)).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(container.querySelector("video")).not.toBeInTheDocument();
      cleanup();
    }
  });
});

describe("Image viewer", () => {
  /** The image viewer, which is only in the page while it's open. */
  const viewer = () => screen.queryByRole("dialog", { name: "Image Viewer (Press escape to close)" });

  it("opens a picture's original in the image viewer, named for its file, with Download taking the file's download address", async () => {
    const moon = stored("moon.jpg", "image/jpeg", { width: 2400, height: 1600, previewUrl: "/previews/k1/s1/moon.jpg" });
    render(<Attachment file={moon} />);
    expect(viewer()).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "moon.jpg" }));
    expect(viewer()).toHaveAttribute("open");
    expect(within(viewer()!).getByRole("img", { name: "moon.jpg" })).toHaveAttribute("src", moon.url);
    const download = within(viewer()!).getByRole("link", { name: "Download file" });
    expect(download).toHaveAttribute("href", moon.downloadUrl);
    // Downloaded, never opened, under the name the server gives it.
    expect(download).toHaveAttribute("download", "");

    await userEvent.click(screen.getByRole("button", { name: "Close image viewer" }));
    expect(viewer()).not.toBeInTheDocument();
  });

  it.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])(
    "leaves a click on a picture with %o to the browser, which opens the file somewhere else",
    (init) => {
      const moon = stored("moon.jpg", "image/jpeg", { width: 2400, height: 1600, previewUrl: "/previews/k1/s1/moon.jpg" });
      render(<Attachment file={moon} />);
      // After the picture has had the click, whether it kept the browser from following its link; then
      // this keeps jsdom, which can't, from trying.
      const leftToTheBrowser = vi.fn();
      document.addEventListener(
        "click",
        (event) => {
          leftToTheBrowser(!event.defaultPrevented);
          event.preventDefault();
        },
        { once: true },
      );
      fireEvent.click(screen.getByRole("link", { name: "moon.jpg" }), init);
      expect(leftToTheBrowser).toHaveBeenCalledWith(true);
      expect(viewer()).not.toBeInTheDocument();
    },
  );

  it("opens a picture over 250 megapixels, as an older message's can be, as its thumbnail", async () => {
    const panorama = stored("panorama.jpg", "image/jpeg", { width: 25_001, height: 10_000, previewUrl: "/previews/k1/s1/panorama.jpg" });
    render(<Attachment file={panorama} />);
    await userEvent.click(screen.getByRole("link", { name: "panorama.jpg" }));
    expect(within(viewer()!).getByRole("img", { name: "panorama.jpg" })).toHaveAttribute("src", panorama.previewUrl);
    expect(within(viewer()!).getByRole("link", { name: "Download file" })).toHaveAttribute("href", panorama.downloadUrl);
  });

  it("opens a picture not every browser shows, such as a HEIC, as its thumbnail", async () => {
    const photo = stored("photo.heic", "image/heic", { width: 4032, height: 3024, previewUrl: "/previews/k1/s1/photo.heic" });
    render(<Attachment file={photo} />);
    await userEvent.click(screen.getByRole("link", { name: "photo.heic" }));
    expect(within(viewer()!).getByRole("img", { name: "photo.heic" })).toHaveAttribute("src", photo.previewUrl);
    expect(within(viewer()!).getByRole("link", { name: "Download file" })).toHaveAttribute("href", photo.downloadUrl);
  });
});

/** Watches for a file's preview coming near the view, as the browser's observers do, but only says so when told to. */
class FakeIntersectionObserver {
  static made: FakeIntersectionObserver[] = [];
  watched: Element[] = [];
  disconnected = false;

  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.made.push(this);
  }

  observe(element: Element) {
    this.watched.push(element);
  }

  disconnect() {
    this.disconnected = true;
  }

  /** Says what it watches has come within its margin of the view. */
  near() {
    const entries = this.watched.map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry);
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

describe("Safe SVG previews", () => {
  const DATA_URL = "data:image/svg+xml;base64,PHN2Zy8+";

  beforeEach(() => {
    FakeIntersectionObserver.made = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.mocked(svgDataUrl).mockResolvedValue(DATA_URL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(svgDataUrl).mockReset();
  });

  it("shows an SVG of up to 5 MiB above its card once it's within 200px of the timeline's view, from the data URL its download makes", async () => {
    const logo = stored("logo.svg", "image/svg+xml", { byteSize: MAX_PREVIEW_SIZE });
    const { container } = render(
      <div style={{ overflowY: "auto" }}>
        <Attachment file={logo} />
      </div>,
    );
    const [observer] = FakeIntersectionObserver.made;
    expect(observer!.options).toEqual({ root: container.firstChild, rootMargin: "200px" });
    expect(svgDataUrl).not.toHaveBeenCalled();
    expect(card("logo.svg")).toBeInTheDocument();

    observer!.near();
    expect(observer!.disconnected).toBe(true);
    expect(svgDataUrl).toHaveBeenCalledWith(logo.downloadUrl, expect.any(AbortSignal));
    const image = await screen.findByRole("img", { name: "logo.svg" });
    expect(image).toHaveAttribute("src", DATA_URL);
    expect(image.compareDocumentPosition(card("logo.svg")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("shows only the card of a bigger SVG, and of one that doesn't load or decode", async () => {
    render(<Attachment file={stored("poster.svg", "image/svg+xml", { byteSize: MAX_PREVIEW_SIZE + 1 })} />);
    expect(FakeIntersectionObserver.made).toEqual([]);
    expect(card("poster.svg")).toBeInTheDocument();
    cleanup();

    vi.mocked(svgDataUrl).mockResolvedValue(null);
    render(<Attachment file={stored("broken.svg", "image/svg+xml")} />);
    const [observer] = FakeIntersectionObserver.made;
    // Outside a timeline, it watches the screen.
    expect(observer!.options.root).toBeNull();
    await act(async () => observer!.near());
    expect(svgDataUrl).toHaveBeenCalledOnce();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(card("broken.svg")).toBeInTheDocument();
  });

  it("stops watching for an SVG, or loading it, when its message goes", () => {
    let loading!: AbortSignal;
    vi.mocked(svgDataUrl).mockImplementation((_url, signal) => {
      loading = signal;
      return new Promise(() => {});
    });
    const watching = render(<Attachment file={stored("logo.svg", "image/svg+xml")} />);
    watching.unmount();
    expect(FakeIntersectionObserver.made[0]!.disconnected).toBe(true);

    const loaded = render(<Attachment file={stored("logo.svg", "image/svg+xml")} />);
    FakeIntersectionObserver.made[1]!.near();
    expect(loading.aborted).toBe(false);
    loaded.unmount();
    expect(loading.aborted).toBe(true);
  });
});

describe("Text files' text", () => {
  beforeEach(() => {
    FakeIntersectionObserver.made = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(fileText).mockReset();
  });

  /** Shows `file`, near the view, once its text has loaded, answering where it's shown and its text's code block. */
  async function shownNear(file: StoredFile) {
    const { container } = render(<Attachment file={file} />);
    await act(async () => FakeIntersectionObserver.made.at(-1)!.near());
    return { container, code: () => container.querySelector("pre") };
  }

  it("shows a snippet's text above its card once it's within 200px of the timeline's view, with Copy code", async () => {
    const user = userEvent.setup();
    vi.mocked(fileText).mockResolvedValue("#!/bin/sh\r\necho deployed\r\n");
    const snippet = stored("deploy.sh", "application/x-sh", { byteSize: 26 });
    const { container } = render(
      <div style={{ overflowY: "auto" }}>
        <Attachment file={snippet} />
      </div>,
    );
    const [observer] = FakeIntersectionObserver.made;
    expect(observer!.options).toEqual({ root: container.firstChild, rootMargin: "200px" });
    expect(fileText).not.toHaveBeenCalled();
    expect(card("deploy.sh")).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();

    await act(async () => observer!.near());
    expect(observer!.disconnected).toBe(true);
    expect(fileText).toHaveBeenCalledWith(snippet.downloadUrl, expect.any(AbortSignal));
    const code = container.querySelector("pre")!;
    // Its lines, as the page reads them, without the last one's end.
    expect(code.textContent).toBe("#!/bin/sh\necho deployed");
    expect(code.compareDocumentPosition(card("deploy.sh")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    // What it copies is the file's text as the file has it.
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("#!/bin/sh\r\necho deployed\r\n");
  });

  it("highlights the text where the file's extension names a language a code block knows, and leaves the rest plain", async () => {
    vi.mocked(fileText).mockResolvedValue("#!/bin/sh\necho deployed");
    const script = await shownNear(stored("deploy.sh", "application/x-sh"));
    await vi.waitFor(() => expect(script.code()!.querySelector(".hljs-built_in")).toHaveTextContent("echo"));

    // With highlight.js loaded, as it now is.
    const notes = await shownNear(stored("notes.txt", "text/plain"));
    expect(notes.code()!.innerHTML).toBe("#!/bin/sh\necho deployed");
  });

  it("folds text past 5 lines or 700 characters behind Show more", async () => {
    const user = userEvent.setup();
    for (const text of ["1\n2\n3\n4\n5\n6", "x".repeat(701)]) {
      vi.mocked(fileText).mockResolvedValue(text);
      const { code } = await shownNear(stored("notes.txt", "text/plain"));
      expect(code()).toHaveClass("overflow-y-hidden");
      const showMore = screen.getByRole("button", { name: "Show more", expanded: false });
      // It names the text it opens.
      expect(code()!.id).not.toBe("");
      expect(showMore).toHaveAttribute("aria-controls", code()!.id);
      await user.click(showMore);
      expect(code()).not.toHaveClass("overflow-y-hidden");
      // Scrolled down while open, it folds back to its first lines.
      Object.defineProperty(code(), "scrollTop", { value: 120, writable: true });
      await user.click(screen.getByRole("button", { name: "Show less", expanded: true }));
      expect(code()).toHaveClass("overflow-y-hidden");
      expect(code()!.scrollTop).toBe(0);
      cleanup();
    }

    for (const text of ["1\n2\n3\n4\n5\n", "x".repeat(700)]) {
      vi.mocked(fileText).mockResolvedValue(text);
      const { code } = await shownNear(stored("notes.txt", "text/plain"));
      expect(code()).not.toHaveClass("overflow-y-hidden");
      expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("shows only the card of a bigger text file, and of one that doesn't load, isn't text, or is only spaces", async () => {
    render(<Attachment file={stored("server.log", "text/plain", { byteSize: MAX_SHOWN_TEXT_SIZE + 1 })} />);
    expect(FakeIntersectionObserver.made).toEqual([]);
    expect(card("server.log")).toBeInTheDocument();
    cleanup();

    for (const text of [null, " \n\t\n"]) {
      vi.mocked(fileText).mockResolvedValue(text);
      const { code } = await shownNear(stored("notes.txt", "text/plain"));
      expect(fileText).toHaveBeenCalledOnce();
      expect(card("notes.txt")).toBeInTheDocument();
      expect(code()).toBeNull();
      cleanup();
      vi.mocked(fileText).mockClear();
    }
  });
});
