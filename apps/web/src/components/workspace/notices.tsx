import type { ReactNode } from "react";

/**
 * Where the workspace's notices sit, one under another, where its flashes show over them: 12px below the
 * header, centered on the page beside the rail and sidebar, where those show, and clear of a notch.
 */
export function Notices({ children }: { children: ReactNode }) {
  return (
    <div className="fixed top-[calc(var(--spacing-header)+12px)] left-1/2 z-20 flex w-max max-w-[calc(100dvw-24px)] -translate-x-1/2 flex-col items-center gap-3 empty:hidden max-md:top-[calc(56px+env(safe-area-inset-top)+12px)] md:left-[calc((100%+env(safe-area-inset-left)+var(--spacing-rail)+var(--spacing-sidebar))/2)] md:max-w-[calc(100dvw-env(safe-area-inset-left)-var(--spacing-rail)-var(--spacing-sidebar)-24px)]">
      {children}
    </div>
  );
}
