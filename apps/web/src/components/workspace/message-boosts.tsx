import { useContext, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { MAX_BOOST_LENGTH, type Boost, type Me, type Message } from "@ember/protocol";
import { isAllEmoji } from "@ember/richtext/dom";
import { ArrowUp, Emoji, Minus, Xmark } from "@/components/icons/iconoir";
import { useNameOf } from "@/hooks/use-directory";
import { RefusedUnboosts, RoomConnection } from "@/hooks/use-room";
import { useScrollIntoView } from "@/hooks/use-scroll-into-view";
import { pressedAlone } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import type { MessageActions } from "./message-item";
import { AvatarLink, UserAvatar } from "./user-avatar";

/** A custom reaction starts with something other than a space. */
const CUSTOM_REACTION = String.raw`\S+.*`;

interface Props {
  message: Message;
  me: Me;
  threaded: boolean;
  /** What can be done to the message, or null where nothing can, as in a room that's gone. */
  actions: MessageActions | null;
  /** Whether the Custom reaction form shows, in place of Add a boost. */
  customizing: boolean;
  /** The Custom reaction form's field, while it shows. */
  customField?: Ref<HTMLInputElement>;
  /** Opens the message's bar with More reactions showing, from its Add a boost. */
  onAddBoost: (button: HTMLButtonElement) => void;
  /** Closes the Custom reaction form. */
  onCloseCustom: () => void;
  /** Hands focus to the message's Message options, as a reaction sent or deleted here does. */
  returnFocus: () => void;
}

/**
 * The reactions under a message (Campfire's boosts.css): a pill for each, oldest first, then Add a
 * boost, which opens the message's bar with More reactions showing, or the Custom reaction form that New
 * boost opens in its place. Add a boost shows once the message has a reaction, as messages.css shows it.
 */
export function MessageBoosts({ message, me, threaded, actions, customizing, customField, onAddBoost, onCloseCustom, returnFocus }: Props) {
  const hint = useId();
  const deletable = (boost: Boost) => actions !== null && boost.booster.id === me.id;

  // The form closes once its reaction is sent, and stays, keeping what's written, when it can't be.
  const add = (content: string) => {
    if (!actions?.boost(message.id, content)) return;
    onCloseCustom();
    returnFocus();
  };

  const cancel = () => {
    onCloseCustom();
    returnFocus();
  };

  // Focus would go with the reaction, so it goes to Message options, as it does once you react from the bar.
  const remove = (boost: Boost) => {
    const sent = actions!.unboost(boost.id);
    if (sent) returnFocus();
    return sent;
  };

  return (
    <div
      className={cn(
        // Under a grouped message's text and time, across both columns.
        "col-span-full flex w-full flex-wrap items-center gap-x-[0.4ch] text-message-ink",
        // Where Message options is 44px, the next message's rises 11px into this one, reaching 38px in from
        // its edge, so reactions, and the Custom reaction form after them, stop short of it. A grouped
        // message's body already keeps 32px of that clear.
        threaded ? "touch:pr-1.5" : "touch:pr-[38px]",
      )}
    >
      <ul aria-label="Reactions" className="flex flex-wrap gap-x-[0.4ch] empty:hidden">
        {message.boosts.map((boost) => (
          <BoostPill key={boost.id} boost={boost} hint={hint} onDelete={deletable(boost) ? () => remove(boost) : null} />
        ))}
      </ul>
      {message.boosts.some(deletable) && (
        <span id={hint} hidden>
          Press enter to delete this boost
        </span>
      )}
      {customizing ? (
        <CustomReaction me={me} fieldRef={customField} onAdd={add} onCancel={cancel} />
      ) : (
        actions &&
        message.boosts.length > 0 && (
          <button
            type="button"
            className="mt-1 grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border bg-background text-[0.66em] text-foreground touch:size-11 hover:not-active:border-muted-foreground"
            onClick={(event) => onAddBoost(event.currentTarget)}
          >
            <Emoji className="h-5 w-[1.3em]" />
            <span className="sr-only">Add a boost</span>
          </button>
        )
      )}
    </div>
  );
}

/**
 * One reaction: its booster's avatar, named "<name> boosted <content>", then the content, larger when
 * it's all emoji. Clicking your own, or pressing Enter on it, reveals Delete this boost and focuses it,
 * as boost_delete_controller.js does, and Delete shrinks it away while it goes. Other people's do
 * nothing.
 */
function BoostPill({ boost, hint, onDelete }: { boost: Boost; hint: string; onDelete: (() => boolean) | null }) {
  const nameOf = useNameOf();
  const [expanded, setExpanded] = useState(false);
  // The connection the deletion went on, and the room's refusals to delete a reaction by then. The reaction
  // comes back if the page reconnects before it goes, since the deletion may have been lost with the
  // connection it went on, or if the room refuses to delete one, since it doesn't say which.
  const connection = useContext(RoomConnection);
  const refusals = useContext(RefusedUnboosts);
  const [deletedAt, setDeletedAt] = useState<{ connection: number; refusals: number } | null>(null);
  const deleting = deletedAt?.connection === connection && deletedAt.refusals === refusals;
  const remove = useRef<HTMLButtonElement>(null);
  const content = cn("min-w-0 leading-normal", isAllEmoji(boost.content) ? "text-base" : "text-[0.8rem]");

  useLayoutEffect(() => {
    if (expanded) remove.current?.focus();
  }, [expanded]);

  const reveal = onDelete && expanded;

  return (
    <li
      className={cn(
        "relative mt-1 flex max-w-full items-center gap-x-[0.4ch] rounded-[4rem] border bg-background pt-[0.1em] pb-[0.1em] pl-[0.1em] hover:not-active:border-muted-foreground",
        // The pill keeps the gap before its Delete button while that's hidden.
        reveal ? "pr-[0.2em]" : "pr-[calc(0.2em+0.4ch)]",
        deleting && "pointer-events-none animate-scale-fade-out motion-reduce:animate-none motion-reduce:opacity-0",
      )}
    >
      {/*
       * 2.2ch of the medium weight of the avatar button, over the button that takes the rest of the
       * pill's clicks. A pill has no room for two targets a fingertip can find, so on touch screens your own
       * is all that button.
       */}
      <AvatarLink
        user={boost.booster}
        reach="dense"
        label={`${nameOf(boost.booster)} boosted ${boost.content}`}
        className={cn("z-[1] size-[2.2ch] font-medium", onDelete && "touch:pointer-events-none")}
      />
      {onDelete ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-describedby={hint}
          // The whole pill takes the click, so a fingertip can find it.
          className={cn(content, "cursor-pointer after:absolute after:-inset-px after:rounded-[4rem]")}
          onClick={() => setExpanded((shown) => !shown)}
        >
          {boost.content}
        </button>
      ) : (
        <span className={content}>{boost.content}</span>
      )}
      {reveal && (
        <button
          ref={remove}
          type="button"
          className="relative ml-auto grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border border-transparent bg-negative-button text-[0.55rem] text-white touch:size-11 hover:not-active:brightness-70"
          onClick={() => {
            if (onDelete()) setDeletedAt({ connection, refusals });
          }}
        >
          <Minus className="h-5 w-[1.3em]" />
          <span className="sr-only">Delete this boost</span>
        </button>
      )}
    </li>
  );
}

/**
 * New boost's form, a pill in Add a boost's place: your avatar and a field for up to 16 characters that
 * can't start with a space, as wide as what's written, then Add reaction once something is, and an X that
 * cancels, as Escape does. How many characters are left shows once five or fewer are. It scrolls itself
 * into view, as its scroll-into-view controller does.
 */
function CustomReaction({ me, fieldRef, onAdd, onCancel }: { me: Me; fieldRef?: Ref<HTMLInputElement>; onAdd: (content: string) => void; onCancel: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const hint = useId();
  const [content, setContent] = useState("");
  const left = MAX_BOOST_LENGTH - content.length;

  useImperativeHandle(fieldRef, () => field.current!);
  useScrollIntoView(form);
  // The field takes focus once the form's laid out, without the browser scrolling to it, since the form scrolls
  // itself into view: Safari's focus on a field it has yet to lay out, or that scrolls to it, stops that scroll.
  useLayoutEffect(() => {
    form.current!.getBoundingClientRect();
    field.current!.focus({ preventScroll: true });
  }, []);

  return (
    <form
      ref={form}
      className="mt-1 flex h-8 max-w-full min-w-0 items-center gap-[0.4ch] rounded-[4rem] border bg-background pr-0.5 transition-shadow duration-150 focus-within:ring-2 focus-within:ring-selected-dark touch:h-11 touch:pr-0"
      onSubmit={(event) => {
        event.preventDefault();
        onAdd(content);
      }}
      onKeyDown={(event) => {
        if (!pressedAlone(event.nativeEvent, "Escape")) return;
        event.preventDefault();
        onCancel();
      }}
    >
      {/* Your avatar, and the pill's height round the field, take the field's taps too. */}
      <label className="flex min-w-0 cursor-text items-center gap-[0.4ch] self-stretch pl-[0.2em] touch:-my-px touch:pl-1.5">
        <UserAvatar user={me} className="size-[22px] touch:size-7" />
        <input
          ref={field}
          name="content"
          type="text"
          aria-label="Custom reaction"
          aria-describedby={hint}
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="send"
          maxLength={MAX_BOOST_LENGTH}
          required
          pattern={CUSTOM_REACTION}
          // The field is as wide as what's written, which its placeholder would keep it wider than.
          placeholder={content === "" ? "Emoji or a word" : ""}
          value={content}
          onChange={(event) => setContent(event.currentTarget.value)}
          className="block min-w-[5ch] field-sizing-content bg-transparent text-[0.8rem] text-foreground outline-none placeholder:text-muted-foreground touch:text-base"
        />
      </label>
      <span id={hint} hidden>
        Up to 16 characters.
      </span>
      {left <= 5 && (
        <span className={cn("shrink-0 text-[11px] leading-none whitespace-nowrap text-muted-foreground tabular-nums", left === 0 && "text-negative")}>{left} left</span>
      )}
      {content.trim() !== "" && (
        <button type="submit" className="group/add grid size-6 shrink-0 cursor-pointer place-items-center touch:size-11">
          <span className="grid size-6 place-items-center rounded-full bg-foreground text-background group-hover/add:brightness-70 touch:size-7">
            <ArrowUp className="size-3.5" />
          </span>
          <span className="sr-only">Add reaction</span>
        </button>
      )}
      <button
        type="button"
        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-hover hover:text-foreground touch:size-11"
        onClick={onCancel}
      >
        <Xmark className="size-4" />
        <span className="sr-only">Cancel</span>
      </button>
    </form>
  );
}
