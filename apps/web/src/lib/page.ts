import { flashOnNextPage, type FlashMessage } from "./flash";

/**
 * Loads `path` as a new page in place of this one: for the pages the Worker answers itself, such as
 * setup's, which the app can't show by changing its own address, and to start afresh once a session
 * ends, keeping nothing of it in memory. Given a `flash`, the new page shows it, as a redirect carries
 * one.
 */
export function loadPage(path: string, flash?: FlashMessage): void {
  if (flash) flashOnNextPage(flash);
  location.replace(path);
}

/** Loads this page afresh, as once Ember has been updated since it loaded. */
export function reloadPage(): void {
  location.reload();
}

/** Opens `url`, a page elsewhere, such as the Memberful site's, after this one, which Back comes back to. */
export function openPage(url: string): void {
  location.assign(url);
}
