import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION_PATH } from "@/lib/updates";
import { CHECK_EVERY_MS, useUpdated } from "./use-updated";

const SCRIPT = "/assets/index-BVs-iubR.js";
const STYLESHEET = "/assets/index-jmMX1D1c.css";
/** The app's script once Ember has been updated. */
const NEWER_SCRIPT = "/assets/index-Dk2o9XyZ.js";

/** What the page deployed now loads, as app-version.json names it. */
let deployed: string[] = [];

/** Has the page load `assets`, as a built page's HTML does. */
function loadPage(assets: string[]) {
  for (const path of assets) {
    const element = path.endsWith(".js") ? Object.assign(document.createElement("script"), { type: "module", src: path }) : Object.assign(document.createElement("link"), { rel: "stylesheet", href: path });
    document.head.append(element);
  }
}

/** How many times the page has asked what's deployed. */
const asked = () => vi.mocked(fetch).mock.calls.filter(([input]) => input === APP_VERSION_PATH).length;
/** Lets what's asked be answered, and what it changes render. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const visibility = (state: DocumentVisibilityState) =>
  act(() => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
    document.dispatchEvent(new Event("visibilitychange"));
  });

beforeEach(() => {
  deployed = [STYLESHEET, SCRIPT];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ assets: deployed })),
  );
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.useFakeTimers();
});

afterEach(() => {
  document.head.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useUpdated", () => {
  it("asks every minute while the page is shown, until Ember has been updated", async () => {
    loadPage([SCRIPT, STYLESHEET]);
    const { result } = renderHook(() => useUpdated());
    await settle();
    // The page has only just loaded.
    expect(asked()).toBe(0);

    await wait(CHECK_EVERY_MS);
    expect(asked()).toBe(1);
    expect(result.current).toBe(false);

    deployed = [STYLESHEET, NEWER_SCRIPT];
    await wait(CHECK_EVERY_MS);
    expect(asked()).toBe(2);
    expect(result.current).toBe(true);

    // Once it knows, it stops asking.
    await wait(CHECK_EVERY_MS * 3);
    await visibility("visible");
    expect(asked()).toBe(2);
  });

  it("asks as the page is shown again, and not while it's hidden", async () => {
    loadPage([SCRIPT, STYLESHEET]);
    const { result } = renderHook(() => useUpdated());
    await visibility("hidden");
    deployed = [STYLESHEET, NEWER_SCRIPT];
    await wait(CHECK_EVERY_MS * 5);
    expect(asked()).toBe(0);

    await visibility("visible");
    await settle();
    expect(asked()).toBe(1);
    expect(result.current).toBe(true);
  });

  it("stays false while what's deployed can't be read", async () => {
    loadPage([SCRIPT, STYLESHEET]);
    vi.mocked(fetch).mockImplementation(async () => new Response("Not found", { status: 404 }));
    const { result } = renderHook(() => useUpdated());
    await wait(CHECK_EVERY_MS);
    expect(asked()).toBe(1);
    expect(result.current).toBe(false);
  });

  it("never asks from Vite's dev server, whose page loads the app's source", async () => {
    const source = Object.assign(document.createElement("script"), { type: "module", src: "/src/main.tsx" });
    document.head.append(source);
    const { result } = renderHook(() => useUpdated());
    await wait(CHECK_EVERY_MS * 2);
    await visibility("visible");
    expect(asked()).toBe(0);
    expect(result.current).toBe(false);
  });

  it("stops asking once the page is gone", async () => {
    loadPage([SCRIPT, STYLESHEET]);
    const { unmount } = renderHook(() => useUpdated());
    unmount();
    await wait(CHECK_EVERY_MS * 2);
    await visibility("visible");
    expect(asked()).toBe(0);
  });
});
