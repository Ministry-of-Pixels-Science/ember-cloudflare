import { useSyncExternalStore } from "react";
import type { HuddlePerson } from "@ember/protocol/huddles";
import { isSpeaking, joinedHuddle, watchHuddle, watchSpeaking } from "@/lib/huddle-store";

/** The huddle this tab is in, as it changes, or null while it's in none. */
export const useHuddle = () => useSyncExternalStore(watchHuddle, joinedHuddle);

/** Whether someone in the huddle this tab is in is speaking, as that changes. Nobody muted is, whatever was heard of them as they muted. */
export const useIsSpeaking = ({ user, muted }: HuddlePerson) => useSyncExternalStore(watchSpeaking, () => isSpeaking(user.id)) && !muted;
