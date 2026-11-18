import { createContext } from "react";
import type { Message, User } from "@ember/protocol";

/** What Report tells the administrators of: someone's message, or someone, for their name, picture or bio. */
export type ReportTarget = { kind: "message"; message: Message } | { kind: "person"; person: User };

/**
 * Opens Report for `target`. Once it closes, `returnFocus` focuses what should have focus then, or focus
 * goes back to what had it.
 */
export type OpenReport = (target: ReportTarget, returnFocus?: () => void) => void;

/** Nothing opens Report outside the workspace. */
export const ReportingContext = createContext<OpenReport>(() => {});
