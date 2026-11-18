import type { CDPSession, Page } from "@playwright/test";
import { test as app, expect } from "../../fixtures";
import { auditScreen } from "./audits";

/** Safe-area insets in CSS px, as `env(safe-area-inset-*)` reports them. */
export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface MobileOptions {
  /** The insets this phone reports, set per project in projects/mobile.ts. */
  safeArea: SafeArea;
}

export const test = app.extend<MobileOptions & { screenIsFine: (options?: { denseTargets?: string[] }) => Promise<void> }>({
  safeArea: [{ top: 0, right: 0, bottom: 0, left: 0 }, { option: true }],

  // Chromium can't know about a notch, so tell it what env(safe-area-inset-*) should report. WebKit
  // can't be told, and reports none.
  page: async ({ page, safeArea, browserName }, use) => {
    const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : undefined;
    await cdp?.send("Emulation.setSafeAreaInsetsOverride", { insets: safeArea });
    screens.set(page, { cdp, insets: safeArea });
    await use(page);
  },

  /** Audits whatever is on screen now and records every problem, without stopping the test. */
  screenIsFine: async ({ page }, use) => {
    await use(async (options) => {
      const results = await auditScreen(page, screens.get(page)!.insets, options);
      expect.soft(results.overflow, "Nothing is cut off or pushed off the side of the screen").toEqual([]);
      expect.soft(results.touchTargets, "Every control is easy to tap").toEqual([]);
      expect.soft(results.safeArea, "Nothing sits under the notch, rounded corners or home indicator").toEqual([]);
      expect.soft(results.zoomingFields, "Text fields are at least 16px, so iOS doesn't zoom in on focus").toEqual([]);
    });
  },
});

export { expect };

/**
 * Your own reactions, which are 28.8px pills, and the avatars in everyone's sit in running content, as
 * on Slack and Discord, so they get WCAG 2.5.8's 24px floor instead of 44px; at 44px they would double
 * the height of every message with reactions.
 */
export const REACTION_PILLS = "[aria-label=Reactions] :is(button, a)";

/**
 * Switches keep Campfire's size, 42 by 24.5px at the 14px they're set to on phones, which WCAG 2.5.8's
 * 24px floor allows.
 */
export const SWITCHES = "[role=switch]";

/** True when the page uses the drawer layout. */
export function hasDrawerLayout(page: Page): boolean {
  return page.viewportSize()!.width <= 900;
}

/** Each page's DevTools session, in Chromium, and the insets it reports right now. */
const screens = new WeakMap<Page, { cdp?: CDPSession; insets: SafeArea }>();

/**
 * Simulates the on-screen keyboard opening the way Chrome on Android does with
 * `interactive-widget=resizes-content`: the page shrinks to the space above the keyboard, and the
 * keyboard covers the home indicator or gesture bar, so there's no bottom inset any more.
 */
export async function openKeyboard(page: Page): Promise<void> {
  const { width, height } = page.viewportSize()!;
  // Phone keyboards take about 40% of a portrait screen and half of a landscape one.
  const keyboard = Math.round(height * (width > height ? 0.5 : 0.4));
  const screen = screens.get(page)!;
  screen.insets = { ...screen.insets, bottom: 0 };
  await screen.cdp?.send("Emulation.setSafeAreaInsetsOverride", { insets: screen.insets });
  await page.setViewportSize({ width, height: height - keyboard });
}
