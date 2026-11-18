import { createContext } from "react";
import type { User, UserId } from "@ember/protocol";

/**
 * Whom you've blocked, as your sidebar last heard, whose messages collapse for you, and what blocks
 * someone or unblocks them once `blocked` is false, settling with whether it did.
 */
export interface Blocking {
  blocked: ReadonlySet<UserId>;
  setBlocked: (person: User, blocked: boolean) => Promise<boolean>;
}

/** Nobody's blocked until the sidebar loads, and nothing blocks anyone outside the workspace. */
export const BlockingContext = createContext<Blocking>({ blocked: new Set(), setBlocked: async () => false });
