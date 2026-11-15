import { useEffect, useState } from "react";
import { assetsInPage, deployedAssets, isUpdated } from "@/lib/updates";

/**
 * How often a page that's shown asks whether Ember has been updated. app-version.json is a static file,
 * which Cloudflare serves without running the Worker, so asking costs the Worker nothing.
 */
export const CHECK_EVERY_MS = 60_000;

/**
 * Whether Ember has been updated since this page loaded, which it asks as it's shown again, and every
 * minute while it's shown, until it has been. An update's deploy leaves the sockets of a page from before
 * it connected, so a page can't wait to hear of it there. A page from Vite's dev server never asks.
 */
export function useUpdated(): boolean {
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    if (updated || assetsInPage().length === 0) return;
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const deployed = await deployedAssets();
      if (!stopped && deployed !== null && isUpdated(assetsInPage(), deployed)) setUpdated(true);
    };
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    const shown = () => void check();
    document.addEventListener("visibilitychange", shown);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [updated]);

  return updated;
}
