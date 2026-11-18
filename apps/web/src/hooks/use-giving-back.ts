import { useEffectEvent, useLayoutEffect, type RefObject } from "react";
import type { Message } from "@ember/protocol";
import type { ComposerHandle } from "@/components/workspace/composer";
import { isToRewrite, type PendingMessage } from "@/lib/room-state";

/**
 * Gives `composer` back the message among `messages` that the room wouldn't take for what it says, as one
 * with a word Blocked words keeps out, for its writer to change, unless they've written something there
 * since, when it stays showing as not sent, as do any refused with it, the room's notice saying why.
 * `givenBack` hears which it was before the page shows the refusal, so a message given back goes from the
 * timeline as it comes back to the composer.
 */
export function useGivingBack(messages: Array<Message | PendingMessage>, composer: RefObject<ComposerHandle | null>, givenBack: (clientMessageId: string, taken: boolean) => void) {
  const refused = messages.filter(isToRewrite);
  const giveBack = useEffectEvent(() => {
    refused.forEach((m, index) => givenBack(m.clientMessageId, index === 0 && (composer.current?.giveBack(m.body, m.rewrite, m.alsoSent === true) ?? false)));
  });
  const waiting = refused.map((m) => m.clientMessageId).join(" ");
  useLayoutEffect(() => {
    if (waiting !== "") giveBack();
  }, [waiting]);
}
