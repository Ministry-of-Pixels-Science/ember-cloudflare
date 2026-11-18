import { useState } from "react";
import { Xmark } from "@/components/icons/iconoir";
import { leave } from "@/hooks/use-route";
import { useUpdated } from "@/hooks/use-updated";
import { reloadPage } from "@/lib/page";

// A tab left open as Ember is updated goes on running the Ember it loaded, so once it can tell, it says
// so, with a button that loads the page afresh once the page's guard lets it. It sits with the
// workspace's other notices.

/** Says Ember has been updated since this page loaded, with a button that reloads it, until it's closed. */
export function UpdatedNotice() {
  const updated = useUpdated();
  const [closed, setClosed] = useState(false);
  if (!updated || closed) return null;
  const reload = () =>
    leave(async () => {
      reloadPage();
      return true;
    });
  return (
    <div role="status" className="flex items-center gap-3 rounded-[10px] border bg-background py-1 ps-4 pe-1 shadow-[0_8px_24px_#00000012]">
      <p className="min-w-0">
        Ember has been updated.{" "}
        <button type="button" onClick={reload} className="cursor-pointer font-medium whitespace-nowrap underline">
          Reload
        </button>
      </p>
      <button type="button" aria-label="Close" onClick={() => setClosed(true)} className="flex size-11 flex-none items-center justify-center rounded-lg hover:bg-hover">
        <Xmark className="size-5" />
      </button>
    </div>
  );
}
