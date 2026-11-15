import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const MAIN_CONTENT = "main-content";

/**
 * "Skip to main content", first in the tab order and hidden until it's focused, when it shows as a
 * button below the header's left end, as Campfire's `.skip-navigation` places it (nav.css), or where
 * `className` places it. It focuses the page's main content, or what has the id `to` while that covers
 * it, and leaves the address as it is, rather than adding `#main-content`.
 */
export function SkipLink({ className, to = MAIN_CONTENT }: { className?: string; to?: string }) {
  return (
    <a
      href={`#${to}`}
      onClick={(event) => {
        event.preventDefault();
        document.getElementById(to)?.focus();
      }}
      className={cn(
        "sr-only focus:top-16 focus:left-[max(1ch,env(safe-area-inset-left))] focus:z-[21] focus:m-0 focus:h-auto focus:w-auto focus:overflow-visible focus:[clip-path:none]",
        "focus:rounded-[9px] focus:border focus:bg-background focus:px-[1.1em] focus:py-[0.5em] focus:font-medium focus:text-foreground",
        className,
      )}
    >
      Skip to main content
    </a>
  );
}

/** The page's main content, `main#main-content`, which takes focus from the skip link but not from Tab. */
export function MainContent(props: ComponentProps<"main">) {
  return <main id={MAIN_CONTENT} tabIndex={-1} {...props} />;
}

/** Scrolls the page's main content back to its top. */
export function scrollMainContentToTop(): void {
  const main = document.getElementById(MAIN_CONTENT);
  if (main) main.scrollTop = 0;
}
