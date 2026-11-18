import { useEffect, useRef, useState } from "react";
import type { HuddlesSettings } from "@ember/protocol";
import { Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Actions } from "./assistant-setup";
import { HuddlesSteps, useHuddlesKeys } from "./huddles-steps";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE } from "./unsaved-changes";

// Set up huddles, for administrators: the dialog that the Huddles section's switch opens, around the two
// steps that give Ember the keys of a Realtime SFU app (`HuddlesSteps`), which huddles run through, and
// then that huddles are on. Styled as Set up Turnstile is.

/** What the dialog says first, of what huddles run through and who pays for it. */
export const SETUP_EXPLAINED = "Huddles run through Cloudflare's Realtime SFU. It's free up to a monthly allowance, then billed to your Cloudflare account.";

/** And once the keys are kept. */
export const HUDDLES_ON = "Cloudflare started a session with the app's keys, so huddles can run through it. Anyone can start one with the headphones at the top of a room.";

interface Props {
  huddles: HuddlesSettings | null;
  /** The Cloudflare account Ember is deployed to, whose SFU apps the dashboard opens at, if the deploy gave it. */
  deployedAccountId: string | null;
  /** Shows huddles as they're saved. */
  onSaved: (huddles: HuddlesSettings) => void;
  onClose: () => void;
  /** Says why saving failed, when it isn't the keys' or Cloudflare's doing, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Set up huddles: an SFU app's ID and secret, which are saved once Cloudflare has started a session with them. */
export function HuddlesSetup({ huddles, deployedAccountId, onSaved, onClose, onFailed }: Props) {
  const [done, setDone] = useState(false);
  const keys = useHuddlesKeys({
    huddles,
    onSaved: (saved) => {
      onSaved(saved);
      setDone(true);
    },
    onFailed,
  });
  // Checking the keys with Cloudflare holds the dialog open until it's answered.
  const { saving } = keys;
  const title = useRef<HTMLHeadingElement>(null);

  // What it says once the keys are kept starts at its title, so that it's read first.
  useEffect(() => {
    if (done) title.current?.focus();
  }, [done]);

  return (
    <Dialog open onOpenChange={(open) => open || saving || onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-busy={saving || undefined}
        overlayClassName={DIALOG_BACKDROP}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        // The keys typed aren't lost to a click beside it.
        onInteractOutside={(event) => event.preventDefault()}
        className={cn(DIALOG, "w-[480px]")}
      >
        <button type="button" aria-label="Close" disabled={saving} onClick={onClose} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle ref={title} tabIndex={-1} className={cn(DIALOG_TITLE, "pe-10 outline-none")}>
          {done ? "Huddles are on" : "Set up huddles"}
        </DialogTitle>
        {done ? (
          <>
            <DialogDescription className="mb-4 leading-[1.65]">{HUDDLES_ON}</DialogDescription>
            <Actions back={null} next={onClose} nextLabel="Done" />
          </>
        ) : (
          <form onSubmit={keys.save}>
            <DialogDescription className="mb-6 leading-[1.65]">{SETUP_EXPLAINED}</DialogDescription>
            <HuddlesSteps keys={keys} deployedAccountId={deployedAccountId} changing={huddles !== null} />
            <Actions back={onClose} backLabel="Cancel" next={null} nextLabel={saving ? "Checking…" : "Save"} disabled={!keys.typed} saving={saving} />
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
