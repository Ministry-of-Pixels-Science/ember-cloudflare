import { useState, type MouseEvent } from "react";
import { Xmark } from "@/components/icons/iconoir";
import { useAccount } from "@/hooks/use-account";
import { useVisit } from "@/hooks/use-route";
import { moveTo, staysAtAnyAddress, thisPageAt } from "@/lib/custom-domain";

// A tab left open at another address as Ember is given a custom domain, which a page opened afresh would
// move to, says so, with a link to the page it shows there. It sits with the workspace's other notices.

/** Says Ember has moved to its custom domain, until it's closed, on any page that would move there. */
export function MovedNotice() {
  const { customDomain } = useAccount();
  // Each page has its own address there.
  useVisit();
  // The custom domain it was closed for, which a new one shows it again for.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const there = thisPageAt(customDomain);
  if (there === null || staysAtAnyAddress(location.pathname) || closedFor === customDomain) return null;
  // As a page moving as it opens does, unless it's opened somewhere else: with a modifier key, say.
  const goThere = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void moveTo(customDomain);
  };
  return (
    <div role="status" className="flex items-center gap-3 rounded-[10px] border bg-background py-1 ps-4 pe-1 shadow-[0_8px_24px_#00000012]">
      <p className="min-w-0">
        Ember has moved to <strong className="wrap-anywhere">{customDomain}</strong>.{" "}
        <a href={there} onClick={goThere} className="font-medium whitespace-nowrap underline">
          Go there
        </a>
      </p>
      <button type="button" aria-label="Close" onClick={() => setClosedFor(customDomain)} className="flex size-11 flex-none items-center justify-center rounded-lg hover:bg-hover">
        <Xmark className="size-5" />
      </button>
    </div>
  );
}
