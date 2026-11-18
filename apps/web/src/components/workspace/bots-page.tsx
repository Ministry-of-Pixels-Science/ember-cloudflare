import { useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { botMessagesPath, botSlackPath, type Bot, type BotRoom } from "@ember/protocol/bots";
import { useFlash } from "@/components/flash";
import { Attachment, ChatBubbleEmpty, EditPencil, Internet, NavArrowRight, Plus } from "@/components/icons/iconoir";
import { PageLink } from "@/components/page-link";
import { TranslationButton } from "@/components/translation-button";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { botSettingsPath, navigate, NEW_BOT_PATH, WORKSPACE_SETTINGS_PATH } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import { ApiError, fetchBots, isSignedOut } from "@/lib/api";
import { byName } from "@/lib/people";
import { cn } from "@/lib/utils";
import { roomNames } from "./agent-list";
import { CopyButton, ROUND_BUTTON } from "./link-buttons";
import { Panel, SECTION_HEADING, SettingsPage, TITLE, TITLE_LINK } from "./settings-page";
import { AvatarLink } from "./user-avatar";

/** The command the bots page gives for posting a message as a bot to `url`. */
export const curlTextLine = (url: string) => `curl -d 'Hello!' ${url}`;

/** And for posting a file (`curl_upload_line`). */
export const curlUploadLine = (url: string) => `curl -F "attachment=@/path/to/file" ${url}`;

/** Campfire's `.input.fill-white` in a panel: 42px tall, or 44px for fingers. */
const INPUT = "min-h-[42px] w-full min-w-0 rounded-[9px] border bg-background px-[0.8em] py-[0.5em] text-base focus:border-muted-foreground touch:min-h-11";

/** What a bot's row says of a bot in no rooms, which has no commands. */
export const NO_ROOMS = "No rooms";

/** A row that opens to what's under it, as a bot's opens to its rooms and a room's to its commands. */
const DISCLOSURE = "group flex min-w-0 cursor-pointer items-center gap-x-[1ch] text-start";

/**
 * Sends anyone but an administrator to workspace settings with an alert, as the Custom CSS page does:
 * `sendAway` with why, and `failed` with an error, which goes to `onFailed` unless the server answered
 * 403.
 */
export function useAdministratorsOnly(onFailed: (error: unknown) => void) {
  const flash = useFlash();
  return useMemo(() => {
    const sendAway = (alert: string) => {
      navigate(WORKSPACE_SETTINGS_PATH, { replace: true });
      flash("alert", alert);
    };
    const failed = (error: unknown) => (error instanceof ApiError && error.status === 403 ? sendAway(error.message) : onFailed(error));
    return { sendAway, failed };
  }, [flash, onFailed]);
}

/**
 * The Chat bots page: what bots do, in short, and Add a chat bot, then a row for each active bot by name,
 * with the rooms it's in and a link to its settings. A bot's row opens to its rooms, and each room to the
 * commands that post to it as the bot, which their buttons copy, so a page of many bots stays short. Go
 * Back returns to workspace settings. A bot deleted or renamed elsewhere leaves or is renamed here as soon
 * as the people directory hears of it.
 */
export function BotsPage({ onFailed }: { onFailed: (error: unknown) => void }) {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const people = useContext(PeopleContext);
  const { failed } = useAdministratorsOnly(onFailed);
  useTitle("Chat bots");

  useEffect(() => {
    let stopped = false;
    fetchBots().then(
      (bots) => !stopped && setBots(bots),
      (error: unknown) => {
        // A page left before its bots load only reports a session that's ended, which goes to sign in.
        if (!stopped || isSignedOut(error)) failed(error);
      },
    );
    return () => void (stopped = true);
  }, [failed]);

  const listed = bots && listedNow(bots, people);
  return (
    <SettingsPage back={WORKSPACE_SETTINGS_PATH}>
      {/* `.panel--wide`: 900px. Spaced as workspace settings' sections are. */}
      <Panel aria-busy={bots === null} className="flex w-[900px] flex-col gap-6">
        {/*
          Add a chat bot ends the heading's row, as New room does in Rooms and permissions, with the
          explainer under both in lines short enough to read. On phones it follows the explainer, rather
          than wrapping in between them.
        */}
        <header className={cn(SECTION_HEADING, "grid grid-cols-[1fr_auto] items-center gap-x-3 upto-500px:grid-cols-1")}>
          {/* The globe sits beside the heading. */}
          <div className="flex items-center gap-2">
            <h1 id="chat-bots-heading" className={TITLE}>Chat bots</h1>
            <TranslationButton translations="chat_bots" />
          </div>
          <p className="col-span-full mt-1.5 max-w-prose text-muted-foreground">
            Chat bots let other apps and services post in your rooms, and reply when people talk to them.
            Each of a bot's rooms gets two addresses, one for posting text or a file and one that takes a Slack incoming webhook's payload.
            Give a bot a webhook URL, and Ember sends it every message that @mentions it or is sent to it in a DM, then posts whatever it answers within 30 seconds.
          </p>
          <PageLink
            href={NEW_BOT_PATH}
            aria-label="Add a chat bot"
            className={cn(TITLE_LINK, "col-start-2 row-start-1 upto-500px:col-start-auto upto-500px:row-start-auto upto-500px:mt-4 upto-500px:justify-self-start")}
          >
            <Plus className="size-[18px]" />
            <span>Add a chat bot</span>
          </PageLink>
        </header>
        {/* One card, as wide as the heading, with a row for each bot, as the AI assistant tab lists its agents. */}
        {listed && listed.length > 0 && (
          <menu aria-labelledby="chat-bots-heading" className="flex flex-col rounded-[10px] border bg-surface">
            {listed.map((bot) => (
              <BotItem key={bot.id} bot={bot} />
            ))}
          </menu>
        )}
      </Panel>
    </SettingsPage>
  );
}

/** `bots` as the people directory has them now: by their names now, as the server orders them, and without those it says are gone. */
const listedNow = (bots: Bot[], people: People) =>
  byName(bots.filter(({ id }) => people.get(id)?.status !== "deactivated").map((bot) => ({ ...bot, name: people.get(bot.id)?.name ?? bot.name })));

/**
 * A bot's row: its avatar, linking to its page, its name over the rooms it's in, and its edit link. The
 * name opens the bot to its rooms, unless it's in none, and shows them until it's clicked again.
 */
function BotItem({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const nameId = useId();
  const roomsNamedId = useId();
  const roomsId = useId();
  const named = (
    <span className="min-w-0">
      <strong id={nameId} className="block truncate text-[17px]">
        {bot.name}
      </strong>
      <span id={roomsNamedId} className="block truncate text-[13px] text-muted-foreground">
        {bot.rooms.length === 0 ? NO_ROOMS : roomNames(bot.rooms)}
      </span>
    </span>
  );
  return (
    <li className="flex flex-col gap-3 border-t px-[2ch] py-3 first:border-t-0 max-md:px-3">
      <div className="flex items-center gap-x-[1ch]">
        <AvatarLink user={bot} lazy className="size-[2.65em]" />
        {bot.rooms.length === 0 ? (
          <div className="min-w-0 flex-1">{named}</div>
        ) : (
          <button
            type="button"
            aria-labelledby={nameId}
            aria-describedby={roomsNamedId}
            aria-expanded={open}
            aria-controls={open ? roomsId : undefined}
            onClick={() => setOpen(!open)}
            className={cn(DISCLOSURE, "min-h-11 flex-1")}
          >
            {named}
            <Chevron />
          </button>
        )}
        <PageLink href={botSettingsPath(bot.id)} className={ROUND_BUTTON}>
          <EditPencil className="size-[1.3em]" />
          <span className="sr-only">Edit {bot.name}</span>
        </PageLink>
      </div>
      {open && (
        <ul id={roomsId} aria-label={`Rooms for ${bot.name}`} className="flex flex-col rounded-[10px] border bg-background">
          {bot.rooms.map((room) => (
            <RoomItem key={room.id} room={room} botKey={bot.key} startsOpen={bot.rooms.length === 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * One of a bot's rooms: its name, which opens to the commands that post to the room as the bot whose key
 * is `botKey`, and its Slack-compatible webhook, in a group named for the room. A bot's only room starts
 * open, as there's no other to choose.
 */
function RoomItem({ room, botKey, startsOpen }: { room: BotRoom; botKey: string; startsOpen: boolean }) {
  const [open, setOpen] = useState(startsOpen);
  const commandsId = useId();
  return (
    <li className="border-t first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? commandsId : undefined}
        onClick={() => setOpen(!open)}
        className={cn(DISCLOSURE, "min-h-10 w-full px-[1.5ch] touch:min-h-11")}
      >
        <span className="truncate font-medium">{room.name}</span>
        <Chevron />
      </button>
      {open && (
        <div id={commandsId} role="group" aria-label={room.name} className="flex min-w-0 flex-col gap-3 px-[1.5ch] pb-4">
          <PostingCommands room={room} botKey={botKey} />
        </div>
      )}
    </li>
  );
}

/** The arrow at the end of a row that opens, which turns to point down while it's open. */
function Chevron() {
  return (
    <NavArrowRight className="ms-auto size-[18px] shrink-0 text-muted-foreground transition-transform duration-150 ease-[ease] group-hover:text-foreground group-aria-expanded:rotate-90" />
  );
}

/** The commands that post to `room` as the bot whose key is `botKey`, and its Slack-compatible webhook, each with a button that copies it. */
export function PostingCommands({ room, botKey }: { room: BotRoom; botKey: string }) {
  const url = new URL(botMessagesPath(room.id, botKey), location.origin).href;
  return (
    <>
      <Command
        icon={<ChatBubbleEmpty className="size-6 flex-none" />}
        command={curlTextLine(url)}
        label="curl command for posting messages"
        copyLabel="Copy message command"
      />
      <Command
        icon={<Attachment className="size-6 flex-none" />}
        command={curlUploadLine(url)}
        label="curl command for posting attachments"
        copyLabel="Copy attachment command"
      />
      <Command
        icon={<Internet className="size-6 flex-none" />}
        command={new URL(botSlackPath(room.id, botKey), location.origin).href}
        label="Slack-compatible webhook URL"
        copyLabel="Copy Slack-compatible webhook URL"
      />
    </>
  );
}

function Command({ icon, command, label, copyLabel }: { icon: ReactNode; command: string; label: string; copyLabel: string }) {
  return (
    <div className="flex items-center gap-x-[1ch]">
      {icon}
      <div className="min-w-0 grow">
        {/* A command is there to be copied, so Enter in one doesn't send a form around it, as the bot form is. */}
        <input type="text" value={command} aria-label={label} readOnly onKeyDown={(event) => event.key === "Enter" && event.preventDefault()} className={INPUT} />
      </div>
      {/* `.txt-small`, which draws the icon smaller. */}
      <div className="text-[0.8rem]">
        <CopyButton text={command} label={copyLabel} className={ROUND_BUTTON} />
      </div>
    </div>
  );
}
