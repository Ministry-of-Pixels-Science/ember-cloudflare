import { useEffect, useRef, type ReactNode } from "react";
import { MainContent, SkipLink } from "@/components/main-content";

// First run's card, which the steps of setting Ember up share: the form that makes its administrator and
// what stands in for it (setup-page.tsx), and then the question about huddles (setup-huddles.tsx).

/** The page's title, which is the card's too unless a step has its own. */
export const SETUP_TITLE = "Set up Ember";
/** A button of the card's footer, 44px tall for fingers as the app's are. */
export const STEP_BUTTON = "h-10 gap-2 rounded-[0.7rem] text-base font-medium touch:h-11";
/** basecoat's `.ui-skip-link` (theme.css): with no header to show it under, it shows at the top left, clear of a notch. */
const SKIP_LINK = "focus:top-[calc(0.5rem+env(safe-area-inset-top))] focus:left-[max(0.5rem,env(safe-area-inset-left))] focus:rounded-lg focus:border-0 focus:bg-card focus:px-4 focus:py-3 focus:outline-2 focus:outline-offset-0 focus:outline-ring";

interface Props {
  title?: string;
  subtitle: string;
  /** Why the step couldn't go on, said above the card. */
  problem?: string | null;
  /** Whether the card takes another's place, and so starts at its title, which is then read first. */
  startsAtTitle?: boolean;
  children: ReactNode;
}

/** The first-run card, with the page's skip link and the alert above it, around the form or what stands in for it. */
export function SetupCard({ title = SETUP_TITLE, subtitle, problem = null, startsAtTitle = false, children }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (startsAtTitle) heading.current?.focus();
  }, [startsAtTitle, title]);
  return (
    <>
      <SkipLink className={SKIP_LINK} />
      <MainContent
        data-ember-preserve-selection
        className="grid min-h-svh grid-cols-[minmax(0,28rem)] place-content-center justify-items-center gap-4 bg-surface pt-[calc(2.5rem+env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(2.5rem+env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] upto-380px:pt-[calc(1.25rem+env(safe-area-inset-top))] upto-380px:pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
      >
        {problem && (
          <div role="alert" aria-atomic="true" className="w-full rounded-lg border bg-card px-4 py-3.5">
            {problem}
          </div>
        )}
        <section aria-label={title} className="w-full min-w-0 overflow-hidden rounded-2xl border bg-card text-card-foreground">
          <header className="flex flex-col items-center px-5 pt-5 text-center">
            <img src="/ember-icon.png" alt="Ember" width={48} height={48} className="mb-4 block size-12 object-contain" />
            <h1
              ref={heading}
              tabIndex={startsAtTitle ? -1 : undefined}
              className="text-2xl leading-[1.3] font-[550] tracking-[-0.025em] text-balance outline-none upto-380px:text-[1.375rem]"
            >
              {title}
            </h1>
            <p className="mt-2 text-base leading-normal text-balance text-muted-foreground upto-380px:text-sm">{subtitle}</p>
          </header>
          {children}
        </section>
      </MainContent>
    </>
  );
}
