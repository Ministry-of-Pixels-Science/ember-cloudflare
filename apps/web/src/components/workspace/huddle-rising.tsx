import type { CSSProperties } from "react";
import type { UserId } from "@ember/protocol";
import { useNameOf } from "@/hooks/use-directory";
import { useReactions } from "@/hooks/use-huddle";
import { reactInHuddle, type JoinedHuddle } from "@/lib/huddle-store";
import { cn } from "@/lib/utils";
import { UserAvatar } from "./user-avatar";

/**
 * Which of five places along the base of the people in the huddle a reaction rises from: the middle one
 * first, and each after it apart from the last, so that those that rise together aren't over each other.
 */
const PLACES = [2, 0, 4, 1, 3];
/** The place the huddle's `nth` reaction rises from, the first being its 1st. */
const placeOf = (nth: number) => PLACES[(nth - 1) % PLACES.length]!;

/**
 * Where the places are: right of the middle, as Slack's reactions are, which keeps them clear of the
 * pills. Where the people have under 672px, as beside the huddle's thread, the places are across more
 * of it, which keeps the names under the reactions apart. Under 448px, as on a phone, the pills take
 * more of so narrow a base, and the places stop short of them.
 */
const PLACED = "left-[calc(45%+var(--place)*6.25%)] @max-2xl:left-[calc(20%+var(--place)*12.5%)] @max-md:left-[calc(15%+var(--place)*11.25%)]";

/** An emoji's pill: 32px tall, and 44px for fingers. */
const PILL = "flex h-8 cursor-pointer items-center gap-1.5 rounded-full border bg-background px-2.5 text-[13px] leading-none font-medium shadow-sm hover:bg-hover touch:h-11 touch:min-w-11 touch:px-3";

/**
 * The reactions of the people in a huddle, over them, where Slack's show: each rises from the base of
 * where they are, over its sender's name, as its emoji grows and it fades, or without motion, holds
 * still there until it goes. In the corner beside them each emoji that rises has a pill, which says who
 * sent the first, "You" or their avatar, and how many have come since, and sends it again. Each reaction
 * is said as it comes, for whoever can't see it. A click goes through all but the pills, to the people
 * under.
 */
export function RisingReactions({ huddle }: { huddle: JoinedHuddle }) {
  const { rising, runs } = useReactions();
  const nameOf = useNameOf();
  const inHuddle = (userId: UserId) => huddle.people.find(({ user }) => user.id === userId)?.user;
  return (
    <div className="pointer-events-none absolute inset-0 @container overflow-hidden">
      {/* Each reaction is another element, so that the same emoji again rises anew, and is said again. */}
      {rising.map(({ nth, userId, emoji }) => {
        const user = inHuddle(userId);
        return (
          user && (
            <span key={nth} aria-hidden className={cn("absolute bottom-3 flex -translate-x-1/2 flex-col items-center gap-0.5 motion-safe:animate-reaction", PLACED)} style={{ "--place": placeOf(nth) } as CSSProperties}>
              <span className="origin-bottom text-[2.5rem] leading-none motion-safe:animate-reaction-emoji">{emoji}</span>
              <span className="max-w-28 truncate rounded-md bg-surface px-1.5 text-xs leading-5 font-medium">{nameOf(user)}</span>
            </span>
          )
        );
      })}
      <span aria-live="polite" className="sr-only">
        {rising.map(({ nth, userId, emoji }) => {
          const user = inHuddle(userId);
          return user && <span key={nth}>{`${nameOf(user)} reacted with ${emoji}`}</span>;
        })}
      </span>
      {runs.length > 0 && (
        <ul aria-label="Reactions" className="pointer-events-auto absolute right-3 bottom-3 flex flex-col items-end gap-1.5">
          {runs.map(({ emoji, first, more }) => {
            const user = inHuddle(first);
            if (!user) return null;
            const you = first === huddle.you?.id;
            const count = more > 0 ? ` + ${more}` : "";
            return (
              <li key={emoji}>
                <button type="button" title={`React with ${emoji} too`} aria-label={`${you ? "You" : nameOf(user)}${count} ${emoji}: react with ${emoji} too`} onClick={() => reactInHuddle(emoji)} className={PILL}>
                  {you ? "You" : <UserAvatar user={user} className="size-5" />}
                  {count && <span>{count.trim()}</span>}
                  <span className="text-base leading-none">{emoji}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
