import { memo, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { CardAction, Me, Message, User } from "@ember/protocol";
import { displayBody, isAllEmoji, type DisplayNode } from "@ember/richtext/dom";
import { NavArrowRight } from "@/components/icons/iconoir";
import { PageLink } from "@/components/page-link";
import { PeopleContext } from "@/hooks/use-directory";
import { messagePath, permalinkOf, threadPath } from "@/hooks/use-route";
import { cardsQuote, dateTimeLabel, lastReplyLabel, timeLabel } from "@/lib/messages";
import { isPending, type PendingMessage } from "@/lib/room-state";
import { cn } from "@/lib/utils";
import { AgentBadge, isAgent } from "./agent-badge";
import { Attachment } from "./attachment";
import { BotCards } from "./bot-card";
import { MessageActionsMenu, type MessageActionsHandle } from "./message-actions-menu";
import { MessageBody } from "./message-body";
import { MessageBoosts } from "./message-boosts";
import { FixedMessageEditor, MessageEditor, type MessageEditorHandle } from "./message-editor";
import { UploadCard } from "./upload-card";
import { AvatarLink, UserAvatar, userTitle } from "./user-avatar";

export interface MessageActions {
  /** Returns whether the reaction was sent. */
  boost: (messageId: string, content: string) => boolean;
  /** Returns whether the deletion was sent. */
  unboost: (boostId: string) => boolean;
  /** Returns whether the edit was sent. */
  edit: (messageId: string, body: string) => boolean;
  /** Returns whether the deletion was sent. */
  remove: (messageId: string) => boolean;
  /** Clicks a button that acts on one of a message's cards, answering whether its bot took the click, once the room says. */
  click: (messageId: string, action: CardAction) => Promise<boolean>;
}

/**
 * Opens and closes messages' editors, which the room keeps, so that Up Arrow can open one too, and
 * writes replies in its composer.
 */
export interface MessageEditors {
  /** Opens a message's editor, or focuses it where it's open already, keeping what's written in it. */
  open: (messageId: string) => void;
  /** Closes a message's editor, returning focus to the composer. */
  close: (messageId: string) => void;
  /** Returns focus to the composer, as a message deleted from its editor or More actions goes. */
  returnFocus: () => void;
  /** Keeps a message's editor while it's open, for `open` to focus; called with null as it goes. */
  attach: (messageId: string, editor: MessageEditorHandle | null) => void;
  /** Writes a reply in the composer, starting with `quote`, in place of what's written there. */
  reply: (quote: string) => void;
}

/** The room a thread's panel shows beside, as the reader reads its name, and whether it's a DM. */
export interface ThreadPlace {
  roomName: string;
  direct: boolean;
}

interface Props {
  message: Message | PendingMessage;
  me: Me;
  threaded: boolean;
  /** Whether the message's editor is open in its place. */
  editing: boolean;
  /** What can be done to the message, or null where nothing can, as in a room that's gone. */
  actions: MessageActions | null;
  editors: MessageEditors;
  /**
   * Where a message in a thread's panel is, the thread's message or a reply: there it has no summary of
   * the thread, nor Reply in thread, and a reply also sent to the room says so.
   */
  thread?: ThreadPlace;
  /** Whether the message's thread is open beside its room, which marks it there, as Slack does. */
  open?: boolean;
}

/**
 * What a stored body shows, or null when it can't be shown. `plainText` is the body's, which tells when a
 * message is only the link its preview is of, and a preview can't link to the page's own host.
 */
function shownBody(body: string, plainText: string): DisplayNode[] | null {
  try {
    return displayBody(body, plainText, location.hostname);
  } catch (error) {
    console.error("Could not show a message", error);
    return null;
  }
}

/**
 * What shows in place of a message whose text can't be shown, with no author, time, actions or
 * reactions. As `.message--failed.center` does, it centers the message, whose avatar's column stays
 * empty, and fades it, and the text wiggles in a dashed red outline.
 */
function UnrenderableMessage() {
  return (
    <article className="mx-auto grid w-fit grid-cols-[36px_minmax(0,1fr)] gap-x-2 px-5 pt-2 opacity-50 max-md:grid-cols-[30px_minmax(0,1fr)] max-md:gap-x-2.5 max-md:px-3">
      <p className="col-start-2 animate-wiggle py-1 text-center text-sm leading-normal text-message-ink outline outline-dashed outline-negative motion-reduce:animate-none">
        Failed to load message content
      </p>
    </article>
  );
}

/** How many replies a thread has, as its summary and its panel say it. */
export const repliesLabel = (count: number) => (count === 1 ? "1 reply" : `${count} replies`);

/**
 * The summary of a message's thread under it, as Slack's is: the faces of the people who replied last, how
 * many replies there are, and when the newest came, which hovering turns to View thread. It opens the thread.
 */
function ThreadSummary({ message }: { message: Message }) {
  const { count, latestAt, people } = message.thread!;
  const latest = lastReplyLabel(new Date(latestAt));
  return (
    <PageLink
      href={threadPath(message.roomId, message.id)}
      className={cn(
        "group/summary @container col-span-full mt-1 mb-0.5 -ml-[5px] flex w-[min(100%,520px)] items-center gap-2 rounded-lg border border-transparent py-1 pr-2 pl-1 text-[13px] leading-[18px] text-message-muted no-underline",
        "hover:border-message-border hover:bg-background focus-visible:border-message-border focus-visible:bg-background touch:min-h-11 touch:w-auto touch:max-w-full",
      )}
    >
      <span aria-hidden className="flex flex-none gap-1">
        {people.map((person) => (
          <UserAvatar key={person.id} user={person} square className="block size-6 rounded-[4px]" />
        ))}
      </span>
      <strong className="flex-none font-bold text-link">{repliesLabel(count)}</strong>
      <span className="min-w-0 truncate group-hover/summary:hidden group-focus-visible/summary:hidden">
        Last reply <span className="@max-[400px]:hidden">{latest.long}</span>
        <span className="hidden @max-[400px]:inline">{latest.short}</span>
      </span>
      <span className="hidden min-w-0 truncate group-hover/summary:inline group-focus-visible/summary:inline">View thread</span>
      <NavArrowRight className="ml-auto size-4 flex-none opacity-0 group-hover/summary:opacity-100 group-focus-visible/summary:opacity-100" />
    </PageLink>
  );
}

/** A line over a reply's text saying where it's from, or where else it went. */
const CONTEXT = "mb-px max-w-[min(100%,560px)] truncate text-[13px] leading-[18px] text-message-muted";
const CONTEXT_LINK = "text-message-muted no-underline hover:text-link hover:underline";

/**
 * Over a reply outside its thread's panel, as in the room or search results: the start of the message it
 * replies to, which opens the thread at the reply. In the panel, over a reply also sent to the room: that
 * it was, linking to it there.
 */
function ReplyContext({ message, thread }: { message: Message; thread?: ThreadPlace }) {
  if (thread) {
    const link = (
      <PageLink href={messagePath(message.roomId, message.id)} className={CONTEXT_LINK}>
        {thread.direct ? "direct message" : `#${thread.roomName}`}
      </PageLink>
    );
    return <p className={CONTEXT}>{thread.direct ? <>Also sent as {link}</> : <>Also sent to {link}</>}</p>;
  }
  return (
    <p className={CONTEXT}>
      replied to a thread:{" "}
      <PageLink href={threadPath(message.roomId, message.parentId!, message.id)} className={CONTEXT_LINK}>
        {message.parentText || "This message was deleted."}
      </PageLink>
    </p>
  );
}

/**
 * A message deleted while its thread has replies, which keeps its place for them: no author, time, text,
 * actions or reactions, and its thread's summary under it, outside its thread. A blank square stands in
 * for its avatar, with the space above a run's first message, so it doesn't read as the message before
 * it going on.
 */
function DeletedMessage({ message, thread, open }: { message: Message; thread?: ThreadPlace; open?: boolean }) {
  return (
    <article
      className={cn(
        "group/message relative grid grid-cols-[36px_minmax(0,1fr)] gap-x-2 px-5 pt-1 max-md:grid-cols-[30px_minmax(0,1fr)] max-md:gap-x-2.5 max-md:px-3",
        open && "bg-hover",
      )}
    >
      <div aria-hidden className="mt-2 size-9 rounded-[6px] bg-border max-md:size-[30px]" />
      <div data-body-content className="col-start-2 min-w-0 py-1">
        <p className="text-[15px] leading-[22px] text-message-muted">This message was deleted.</p>
        {!thread && message.thread && <ThreadSummary message={message} />}
      </div>
    </article>
  );
}

// The names below are the people directory's, which follow a rename, read where they're shown, so a
// change to the directory doesn't render every message again.

/**
 * The author's name as the people directory lists them now, which runs to an ellipsis rather than wrap,
 * and shows their bio on hover, then the agent badge for an AI agent.
 */
function Author({ user }: { user: User }) {
  const listed = useContext(PeopleContext).get(user.id) ?? user;
  return (
    <>
      <strong title={userTitle(listed)} className="truncate font-bold text-message-ink">
        {listed.name}
      </strong>
      {isAgent(listed) && <AgentBadge />}
    </>
  );
}

/** One message: a 36px avatar gutter, author and time, then the body. */
export const MessageItem = memo(function MessageItem({ message, me, threaded: follows, editing: editorOpen, actions, editors, thread, open }: Props) {
  const article = useRef<HTMLElement>(null);
  const menu = useRef<MessageActionsHandle>(null);
  const attachEditor = useCallback((editor: MessageEditorHandle | null) => editors.attach(message.id, editor), [editors, message.id]);
  const pending = isPending(message);
  const upload = isPending(message) ? message.upload : undefined;
  // The editor shows only while the message can still be changed.
  const editing = editorOpen && actions !== null && !pending;
  const [customizing, setCustomizing] = useState(false);
  const customField = useRef<HTMLInputElement>(null);
  // The Custom reaction form goes as the editor opens, as the editor replaces the whole message.
  if (customizing && (editing || !actions)) setCustomizing(false);
  const mine = message.creator.id === me.id;
  const created = new Date(message.createdAt);
  // Any message that mentions you, yours too, as Campfire's message_formatter.js means to mark them,
  // though it looks for an avatar address that mentions don't have, so it never does.
  const mentioned = message.mentions.some((person) => person.id === me.id);
  const shown = useMemo(() => shownBody(message.body, message.plainText), [message.body, message.plainText]);
  // Quote quotes what the message shows, or the plain text of a bot's cards where they're all it shows.
  const quoted = useMemo(
    () => (message.body === "" && message.cards ? cardsQuote(message.plainText) : (shown ?? [])),
    [message.body, message.cards, message.plainText, shown],
  );
  // A message's plain text holds its cards', which never show large.
  const allEmoji = !message.cards && isAllEmoji(message.plainText);
  // A reply says where it's from, or where else it went, under its author's name, so it never follows on
  // without one.
  const context = message.parentId !== undefined && (!thread || message.alsoSent) && <ReplyContext message={message} thread={thread} />;
  const threaded = follows && !context;
  // Edited messages are marked, as Slack marks them, so readers can tell a message changed.
  const edited = message.editedAt !== null && <span className="text-xs text-message-muted">(edited)</span>;

  // The permalink: the time, linking to the message, though not while the message is on its way to the
  // room. A follow-up's shows only on hover or focus, after its text, without moving it.
  const timeClass = cn(
    "text-xs leading-[18px] whitespace-nowrap text-message-muted",
    threaded && "col-start-2 row-start-1 mt-[3px] justify-self-start opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100",
  );
  const time = (
    <time dateTime={message.createdAt} title={dateTimeLabel(created)}>
      {timeLabel(created)}
    </time>
  );
  const permalink = pending ? (
    <span className={timeClass}>{time}</span>
  ) : (
    <PageLink href={permalinkOf(message)} className={timeClass}>
      {time}
    </PageLink>
  );

  if (message.deleted) return <DeletedMessage message={message} thread={thread} open={open} />;
  if (shown === null) return <UnrenderableMessage />;

  return (
    <article
      ref={article}
      // An upload stays busy until it's failed, so screen readers say why it failed but not every step it takes.
      aria-busy={(pending && !upload?.error) || undefined}
      className={cn(
        "group/message relative grid grid-cols-[36px_minmax(0,1fr)] gap-x-2 px-5 hover:bg-message-hover max-md:grid-cols-[30px_minmax(0,1fr)] max-md:gap-x-2.5 max-md:px-3",
        // A message that starts a run has 4px more above it, so a new author starts 12px below the
        // message before, while one person's messages stay 8px apart.
        !threaded && "pt-1",
        // Where Message options is 44px, each message is at least as tall as it, so the buttons of short
        // messages in a row don't overlap.
        "touch:min-h-11",
        pending && !upload && "opacity-60",
        open && "bg-hover",
      )}
    >
      {/* The avatar sits 8px down, level with the author's name, and 4px below where the editor starts. */}
      {!threaded && <AvatarLink user={message.creator} square className="mt-2 size-9 max-md:size-[30px]" />}

      {editing && (message.attachment || message.cards) ? (
        <FixedMessageEditor ref={attachEditor} onDelete={() => actions.remove(message.id) && editors.returnFocus()} onClose={() => editors.close(message.id)}>
          {message.attachment ? <Attachment file={message.attachment} /> : message.body !== "" && <MessageBody nodes={shown} mentions={message.mentions} />}
          {message.cards && <BotCards cards={message.cards} />}
        </FixedMessageEditor>
      ) : editing ? (
        <MessageEditor
          ref={attachEditor}
          message={message}
          onSave={(body) => actions.edit(message.id, body)}
          onDelete={() => actions.remove(message.id) && editors.returnFocus()}
          onClose={() => editors.close(message.id)}
        />
      ) : (
        // The body, which a permalink outlines. A follow-up's time takes a column of its own after the
        // text, which the text gives up its room to only as it runs long.
        <div
          data-body-content
          className={cn(
            "col-start-2 min-w-0",
            allEmoji ? "py-0" : "py-1",
            threaded && "grid grid-cols-[minmax(0,max-content)_minmax(max-content,1fr)] items-start gap-x-2.5 touch:pr-8",
            // A message that mentions you, which wiggles as it shows, as Campfire's messages.css has it.
            mentioned && "animate-wiggle border-l-2 border-mention bg-mention/10 pl-2 motion-reduce:animate-none",
          )}
        >
          {/* The heading, a 15px h3, whose letters are spaced as headings' are. A follow-up's
              holds only its time, which it leaves to the text's grid. */}
          {threaded ? (
            <h3 className="contents text-[15px]">{permalink}</h3>
          ) : (
            <h3 className="flex min-h-[22px] items-baseline gap-2 text-[15px] leading-[22px] max-md:flex-wrap max-md:gap-x-2 max-md:gap-y-0.5 max-md:pr-[22px]">
              <Author user={message.creator} />
              {permalink}
              {edited}
            </h3>
          )}
          {context}

          {/* A grouped message has no header, so its mark follows the text, or the file a bot replaced. Where
              Message options is 44px, the text stops 32px short of the row's end, clear of it. A file message
              shows its file in place of its text, and its upload's
              card until the room has it. A bot's cards follow, with no text before them where it sent none. */}
          {upload ? (
            <div className={threaded ? "col-start-1 row-start-1" : "touch:pr-8"}>
              <UploadCard upload={upload} />
            </div>
          ) : message.attachment ? (
            <div dir="auto" className={threaded ? "col-start-1 row-start-1" : "touch:pr-8"}>
              <Attachment file={message.attachment} />
              {threaded && edited}
            </div>
          ) : (
            (message.body !== "" || !message.cards) && (
              <MessageBody
                nodes={shown}
                mentions={message.mentions}
                emoji={allEmoji}
                trailing={(threaded && edited) || undefined}
                className={threaded ? "col-start-1 row-start-1" : "touch:pr-8"}
              />
            )
          )}

          {message.cards && (
            <BotCards cards={message.cards} className={threaded ? "col-start-1" : "touch:pr-8"} onAction={actions && !pending ? (action) => actions.click(message.id, action) : undefined} />
          )}

          {pending && message.failed && <p className="col-span-full text-xs text-destructive">Not sent</p>}

          {(message.boosts.length > 0 || customizing) && (
            <MessageBoosts
              message={message}
              me={me}
              threaded={threaded}
              actions={actions}
              customizing={customizing}
              customField={customField}
              onAddBoost={(button) => menu.current?.openReactions(button)}
              onCloseCustom={() => setCustomizing(false)}
              returnFocus={() => menu.current?.focus()}
            />
          )}

          {/* As Slack has it, under the reactions. */}
          {!thread && message.thread && <ThreadSummary message={message} />}
        </div>
      )}

      {actions && !pending && !editing && (
        <MessageActionsMenu
          ref={menu}
          message={message}
          nodes={quoted}
          row={article}
          threaded={threaded}
          editable={mine || me.administrator}
          // A reply shown in the room opens its own thread, which its parent's is.
          threadPath={thread ? undefined : threadPath(message.roomId, message.parentId ?? message.id)}
          onReact={(emoji) => actions.boost(message.id, emoji)}
          onQuote={editors.reply}
          onEdit={() => editors.open(message.id)}
          // As from the editor, the composer takes focus as the message goes.
          onDelete={() => {
            if (!actions.remove(message.id)) return false;
            editors.returnFocus();
            return true;
          }}
          // The form opens with its field focused, or, open already, keeps what's written in it and focuses it.
          onNewBoost={() => (customizing ? customField.current?.focus() : setCustomizing(true))}
        />
      )}
    </article>
  );
});
