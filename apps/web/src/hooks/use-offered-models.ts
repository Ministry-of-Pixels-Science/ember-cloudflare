import { useEffect, useEffectEvent, useState } from "react";
import { ASSISTANT_MODELS, SUGGESTED_MODEL, type AssistantKeys, type OfferedModels } from "@ember/protocol/assistant";
import { ApiError, fetchOfferedModels, isSignedOut } from "@/lib/api";

/** The models this Ember shipped with, as the Worker offers them before it has read the models file. */
export const SHIPPED_MODELS: OfferedModels = { models: [...ASSISTANT_MODELS], suggested: SUGGESTED_MODEL, workersAi: null };

/** Why Workers AI's models aren't listed when asking the Worker for the models it offers failed. */
export const OFFERED_UNREAD = "Workers AI's models aren't listed, as Ember couldn't list them. Try again in a moment.";

/**
 * The models Ember offers through the account `keys` names (`fetchOfferedModels`), or else, when asking
 * fails, those this Ember shipped with, saying why Workers AI's aren't among them, but for a session
 * that's ended, which fails.
 */
export async function offeredModelsThrough(keys: AssistantKeys | null): Promise<OfferedModels> {
  try {
    return await fetchOfferedModels(keys ?? undefined);
  } catch (error) {
    if (isSignedOut(error)) throw error;
    return { ...SHIPPED_MODELS, workersAi: error instanceof ApiError && error.status === 422 ? error.message : OFFERED_UNREAD };
  }
}

/**
 * The models Ember offers (`offeredModelsThrough`), which the Worker is asked for while `asking`, through
 * the account `keys` names, as Set up Ember AI has them typed, or Ember AI's without them, and again for
 * other keys: null until it answers. A session that's ended while it asks goes to `failed`.
 */
export function useOfferedModels(asking: boolean, keys: AssistantKeys | null, failed: (error: unknown) => void): OfferedModels | null {
  // What was asked for, so that an answer for other keys isn't shown for these.
  const asked = asking ? `${keys?.accountId ?? ""} ${keys?.apiToken ?? ""}` : null;
  const [answered, setAnswered] = useState<{ asked: string; offered: OfferedModels } | null>(null);
  const failedToAsk = useEffectEvent((error: unknown) => failed(error));
  useEffect(() => {
    if (asked === null) return;
    let current = true;
    offeredModelsThrough(keys).then(
      (offered) => current && setAnswered({ asked, offered }),
      (error: unknown) => failedToAsk(error),
    );
    return () => void (current = false);
    // `keys` is what `asked` says.
  }, [asked]);
  return answered?.asked === asked ? answered.offered : null;
}
