import { devices, type PlaywrightTestOptions, type PlaywrightWorkerOptions, type Project } from "@playwright/test";
import type { MobileOptions } from "../tests/mobile/fixtures";
import { featureProjects } from "./features";
import { FIRST_RUN, firstRunProjects } from "./first-run";
import { mobileProjects } from "./mobile";

// Safari's engine, WebKit, which every browser on an iPhone or iPad shows pages with, as Ember's own
// apps will. `E2E_BROWSER=webkit` runs these in place of the Chromium projects: the first visitor's
// setup and the feature-by-feature suite on a desktop Safari, and the phone suite on the narrowest
// iPhone and the most common one. They keep their Chromium names, so `pnpm test:features` and
// `pnpm test:mobile` pick them out the same way.

type WebKitProject = Project<PlaywrightTestOptions & MobileOptions, PlaywrightWorkerOptions>;

/** WebKit, without the Chromium that sandboxes point the other projects at. */
const WEBKIT = { browserName: "webkit", launchOptions: {} } as const;

/** The phones WebKit runs the phone suite on. */
const IPHONES = new Set(["mobile iPhone SE", "mobile iPhone 17"]);

const onDesktopSafari = (project: WebKitProject): WebKitProject => ({ ...project, use: { ...devices["Desktop Safari"], ...WEBKIT } });

// WebKit can't be told about a notch, as Chromium can, so these report no safe-area insets.
const onIPhone = (project: WebKitProject): WebKitProject => ({ ...project, use: { ...project.use, ...WEBKIT, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } } });

export const webkitProjects: WebKitProject[] = [
  ...firstRunProjects.map(onDesktopSafari),
  ...[...featureProjects.map(onDesktopSafari), ...mobileProjects.filter((project) => IPHONES.has(project.name!)).map(onIPhone)].map((project) => ({
    ...project,
    dependencies: [FIRST_RUN],
  })),
];
