import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { MAX_USER_NAME_LENGTH, type Me, type RoomId, type SidebarRoom, type UserId } from "@ember/protocol";
import { BOTS_FORBIDDEN, MAX_WEBHOOK_URL_LENGTH, type BotChanges, type BotRoom, type BotSettings, type NewBot } from "@ember/protocol/bots";
import { AUTH_FORM } from "@/components/auth-page";
import defaultBotAvatar from "@/components/default-bot-avatar.svg";
import { FIELD_INPUT, Field, SubmitButton } from "@/components/field";
import { Camera, RefreshDouble } from "@/components/icons/iconoir";
import { Input } from "@/components/ui/input";
import { useChosenPhoto, type PhotoChoice } from "@/hooks/use-chosen-photo";
import { useMounted } from "@/hooks/use-mounted";
import { BOTS_PATH, navigate } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import { changeBot, createBot, deleteBot, fetchBot, isSignedOut, resetBotKey } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CHOICE, roomsToPick } from "./agent-page";
import { PostingCommands, useAdministratorsOnly } from "./bots-page";
import { DeleteButton, isMissing, NEGATIVE_BUTTON } from "./room-settings-page";
import { PageHeading, Panel, SettingsPage } from "./settings-page";

// The pages for adding a bot and changing one, which share the bot form and go back to the bots page
// once they've saved.

/** What Delete bot asks first, in the browser's own dialog. */
export const CONFIRM_DELETE_BOT = "Are you sure you want to permanently remove this bot from the account? This can’t be undone.";

/** What Generate a new key asks first. */
export const CONFIRM_NEW_KEY = "Are you sure you want to change the bot key? All usage of this bot must be updated.";

/** What Rooms says of the bot. */
export const ROOMS_EXPLAINED = "Where apps can post as the bot, and people can mention it. To put it in a private room, use that room's settings.";

/**
 * The bot form's fields as typed: the bot's name, where its webhook delivers, "" for nowhere, and
 * whether it's in every open room or only the ones chosen.
 */
interface Fields {
  name: string;
  webhookUrl: string;
  everyOpenRoom: boolean;
  chosenRooms: RoomId[];
}

/** A new bot's: nothing typed, in every open room, as a bot was before it could be kept to some. */
const NO_FIELDS: Fields = { name: "", webhookUrl: "", everyOpenRoom: true, chosenRooms: [] };

const fieldsOf = (bot: BotSettings): Fields => ({
  name: bot.name,
  webhookUrl: bot.webhookUrl ?? "",
  everyOpenRoom: bot.pickedRooms === null,
  chosenRooms: bot.pickedRooms?.map(({ id }) => id) ?? [],
});

/** The open rooms `fields` keep the bot to: null for every one. */
const roomsChosen = ({ everyOpenRoom, chosenRooms }: Fields) => (everyOpenRoom ? null : chosenRooms);

const sameRooms = (a: readonly RoomId[] | null, b: readonly RoomId[] | null) =>
  a === null || b === null ? a === b : a.length === b.length && b.every((id) => a.includes(id));

/** The bot `fields` add, as New chat bot sends it. */
const newBotOf = (fields: Fields): NewBot => ({ name: fields.name, webhookUrl: fields.webhookUrl, rooms: roomsChosen(fields) });

/**
 * The fields typed differently from `bot` as it loaded. Only they're sent, so a save doesn't put back
 * what another administrator has saved since.
 */
function changesOf(bot: BotSettings, typed: Fields): BotChanges {
  const loaded = fieldsOf(bot);
  const changes: BotChanges = {};
  if (typed.name !== loaded.name) changes.name = typed.name;
  if (typed.webhookUrl !== loaded.webhookUrl) changes.webhookUrl = typed.webhookUrl;
  const rooms = roomsChosen(typed);
  if (!sameRooms(rooms, roomsChosen(loaded))) changes.rooms = rooms;
  return changes;
}

/**
 * Goes back to the bots page once `request` succeeds. A request that fails says why, where it was made
 * from, unless the page has been left, which only a session that's ended is reported from.
 */
function useSending(failed: (error: unknown) => void): [boolean, (request: () => Promise<void>) => void] {
  const [sending, setSending] = useState(false);
  const mounted = useMounted();
  const send = (request: () => Promise<void>) => {
    setSending(true);
    request().then(
      () => mounted.current && navigate(BOTS_PATH),
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSending(false);
        failed(error);
      },
    );
  };
  return [sending, send];
}

/**
 * Add a chat bot, which only administrators may open: anyone else is sent to workspace settings at once.
 * Its Rooms are picked from the sidebar's `rooms`, null until they're loaded.
 */
export function NewBotPage({ me, rooms, onFailed }: { me: Me; rooms: SidebarRoom[] | null; onFailed: (error: unknown) => void }) {
  const [fields, setFields] = useState(NO_FIELDS);
  const photo = useChosenPhoto();
  const { sendAway, failed } = useAdministratorsOnly(onFailed);
  const [saving, send] = useSending(failed);
  useTitle("New chat bot");

  // Before the form paints, so anyone else never sees it.
  useLayoutEffect(() => {
    if (!me.administrator) sendAway(BOTS_FORBIDDEN);
  }, [me.administrator, sendAway]);

  return (
    <SettingsPage back={BOTS_PATH}>
      <Panel>
        <BotForm
          avatar={defaultBotAvatar}
          saved={null}
          rooms={rooms}
          photo={photo}
          fields={fields}
          onChange={setFields}
          saving={saving}
          onSave={() => send(async () => createBot(newBotOf(fields), await photo.photo()))}
        />
      </Panel>
    </SettingsPage>
  );
}

interface SettingsProps {
  botId: UserId;
  /** The sidebar's rooms, which Rooms picks from, or null until they're loaded. */
  rooms: SidebarRoom[] | null;
  /** For an id that isn't an active bot's, which gets the 404 page. */
  onMissing: () => void;
  /** Says why something else failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * A bot's settings, which only administrators may open: the bot form, then Delete bot, which takes the
 * bot out of every room but its DMs, and Generate a new key, which stops its old key working. Each asks
 * first.
 */
export function BotSettingsPage({ botId, rooms, onMissing, onFailed }: SettingsProps) {
  const [bot, setBot] = useState<BotSettings | null>(null);
  const [fields, setFields] = useState(NO_FIELDS);
  const photo = useChosenPhoto();
  const administratorsOnly = useAdministratorsOnly(onFailed);
  const failed = (error: unknown) => (isMissing(error) ? onMissing() : administratorsOnly.failed(error));
  const [busy, send] = useSending(failed);
  useTitle("Edit bot");

  useEffect(() => {
    let stopped = false;
    fetchBot(botId).then(
      (bot) => {
        if (stopped) return;
        setBot(bot);
        setFields(fieldsOf(bot));
      },
      (error: unknown) => {
        // A page left before its bot loads only reports a session that's ended, which goes to sign in.
        if (stopped && !isSignedOut(error)) return;
        if (isMissing(error)) onMissing();
        else administratorsOnly.failed(error);
      },
    );
    return () => void (stopped = true);
  }, [botId, onMissing, administratorsOnly]);

  const remove = () => {
    if (confirm(CONFIRM_DELETE_BOT)) send(() => deleteBot(botId));
  };
  const newKey = () => {
    if (confirm(CONFIRM_NEW_KEY)) send(() => resetBotKey(botId));
  };
  return (
    <SettingsPage back={BOTS_PATH}>
      <Panel aria-busy={bot === null}>
        {bot && (
          <>
            <BotForm
              avatar={bot.avatarUrl}
              saved={bot}
              rooms={rooms}
              photo={photo}
              fields={fields}
              onChange={setFields}
              saving={busy}
              onSave={() => send(async () => changeBot(botId, changesOf(bot, fields), await photo.photo()))}
            />
            <hr className="my-8 w-full" />
            <div className="flex flex-wrap items-center justify-between gap-x-[1ch] gap-y-4">
              <DeleteButton label="Delete this chat bot" text="Delete bot" disabled={busy} onClick={remove} />
              <button type="button" aria-label="Generate a new key" disabled={busy} onClick={newKey} className={NEGATIVE_BUTTON}>
                <RefreshDouble className="size-[1.3em] shrink-0" />
                <span className="truncate">Generate a new key</span>
              </button>
            </div>
          </>
        )}
      </Panel>
    </SettingsPage>
  );
}

interface FormProps {
  /** The bot's avatar as it is: its own, or Campfire's default bot picture, which the Worker serves for a bot without one. */
  avatar: string;
  /**
   * The bot as it's saved, whose key and rooms make the addresses it posts at, with the open rooms it's
   * kept to, or null for one not yet added.
   */
  saved: Pick<BotSettings, "key" | "rooms" | "pickedRooms"> | null;
  /** The sidebar's rooms, which Rooms picks from, or null until they're loaded. */
  rooms: SidebarRoom[] | null;
  /** The picture chosen to be its avatar, which saves with the form. */
  photo: PhotoChoice;
  fields: Fields;
  onChange: (fields: Fields) => void;
  /** Whether the form or one of the page's buttons is on its way to the server, which Save changes waits for. */
  saving: boolean;
  onSave: () => void;
}

/** A note in one of the form's cards, as the workspace settings' cards have them. */
const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** One of the form's cards, Incoming and Outgoing, as the workspace settings' cards are. */
const CARD = "flex min-w-0 flex-col gap-4 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3";

/** A menu in a field, as the workspace settings' menus are. */
const SELECT = cn("w-full min-w-0 border outline-none dark:bg-input/30", FIELD_INPUT);

/**
 * The bot form: Chat bot setup, the bot's avatar and name, its Rooms, then the bot's two ways of talking,
 * Incoming, the addresses its rooms give it to post at, and Outgoing, the webhook URL Ember sends what
 * people say to it, and Save changes, which saves a picture chosen for its avatar too. The name and the
 * webhook URL have translation buttons.
 */
function BotForm({ avatar, saved, rooms, photo, fields, onChange, saving, onSave }: FormProps) {
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!saving) onSave();
  };

  return (
    <form onSubmit={save} className={AUTH_FORM}>
      <PageHeading title="Chat bot setup">Connect another app or service to your workspace as a bot.</PageHeading>
      <AvatarField src={avatar} photo={photo} disabled={saving} />
      <Field id="user_name" label="Bot name" translation="bot_name">
        <Input
          id="user_name"
          autoComplete="name"
          placeholder="Name the bot"
          maxLength={MAX_USER_NAME_LENGTH}
          autoFocus
          required
          data-1p-ignore
          value={fields.name}
          onChange={(event) => onChange({ ...fields, name: event.target.value })}
          className={FIELD_INPUT}
        />
      </Field>
      <Rooms rooms={roomsToPick(rooms, saved?.pickedRooms ?? [])} fields={fields} onChange={onChange} disabled={saving} />
      <Incoming saved={saved} />
      <section aria-labelledby="bot-outgoing-heading" className={CARD}>
        <div>
          <h2 id="bot-outgoing-heading" className="text-base font-semibold">
            Outgoing
          </h2>
          <p id="bot-outgoing-description" className={NOTE}>
            Optional. Ember sends every message that @mentions the bot or is sent to it in a DM to this webhook URL, then posts whatever it answers within 30 seconds.
          </p>
        </div>
        <Field id="user_webhook_url" label="Webhook URL" translation="webhook_url">
          <Input
            id="user_webhook_url"
            type="url"
            placeholder="Webhook URL"
            maxLength={MAX_WEBHOOK_URL_LENGTH}
            aria-describedby="bot-outgoing-description"
            value={fields.webhookUrl}
            onChange={(event) => onChange({ ...fields, webhookUrl: event.target.value })}
            className={FIELD_INPUT}
          />
        </Field>
      </section>
      <SubmitButton disabled={saving}>Save changes</SubmitButton>
    </form>
  );
}

/**
 * The form's Rooms card, as an agent's page has it: Every room, which puts the bot in every open room, new
 * ones too, or Only the rooms I choose, with a box for each open room there is, `rooms`, which keeps it to
 * those ticked. Private rooms put it in themselves, in their settings.
 */
function Rooms({ rooms, fields, onChange, disabled }: { rooms: BotRoom[]; fields: Fields; onChange: (fields: Fields) => void; disabled: boolean }) {
  const choose = (room: RoomId, chosen: boolean) =>
    onChange({ ...fields, chosenRooms: chosen ? [...fields.chosenRooms, room] : fields.chosenRooms.filter((id) => id !== room) });
  return (
    <section aria-labelledby="bot-rooms-heading" className={CARD}>
      <div>
        <h2 id="bot-rooms-heading" className="text-base font-semibold">
          Rooms
        </h2>
        <p id="bot-rooms-description" className={NOTE}>
          {ROOMS_EXPLAINED}
        </p>
      </div>
      <fieldset aria-labelledby="bot-rooms-heading" aria-describedby="bot-rooms-description" disabled={disabled} className="flex flex-col gap-1">
        <label className={CHOICE}>
          <input
            type="radio"
            name="bot-rooms"
            checked={fields.everyOpenRoom}
            onChange={() => onChange({ ...fields, everyOpenRoom: true })}
            className="size-4 flex-none accent-foreground"
          />
          <span>Every room</span>
        </label>
        <label className={CHOICE}>
          <input
            type="radio"
            name="bot-rooms"
            checked={!fields.everyOpenRoom}
            onChange={() => onChange({ ...fields, everyOpenRoom: false })}
            className="size-4 flex-none accent-foreground"
          />
          <span>Only the rooms I choose</span>
        </label>
        {!fields.everyOpenRoom && (
          <div className="ms-6 grid grid-cols-2 gap-x-[2ch] gap-y-1 upto-500px:grid-cols-1">
            {rooms.map((room) => (
              <label key={room.id} className={CHOICE}>
                <input
                  type="checkbox"
                  checked={fields.chosenRooms.includes(room.id)}
                  onChange={(event) => choose(room.id, event.target.checked)}
                  className="size-4 flex-none accent-foreground"
                />
                <span className="truncate">{room.name}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </section>
  );
}

/**
 * The form's Incoming card: a menu of the bot's rooms, and the commands that post to the one chosen as the
 * bot, as the bots page gives them for each, or in their place, that they come once the bot is added, or
 * that a bot in no rooms has none. The menu keeps a bot in many rooms from pushing Outgoing out of sight.
 */
function Incoming({ saved }: { saved: FormProps["saved"] }) {
  const [chosen, choose] = useState<RoomId | null>(null);
  const room = saved?.rooms.find(({ id }) => id === chosen) ?? saved?.rooms[0];
  return (
    <section aria-labelledby="bot-incoming-heading" className={CARD}>
      <div>
        <h2 id="bot-incoming-heading" className="text-base font-semibold">
          Incoming
        </h2>
        <p className={NOTE}>Apps post in a room as the bot at two addresses the room gives it, one for text or a file and one that takes a Slack incoming webhook's payload.</p>
      </div>
      {saved && room ? (
        <>
          <div className="max-w-[20em]">
            <Field id="bot_room" label="Room">
              <select id="bot_room" value={room.id} onChange={(event) => choose(event.target.value as RoomId)} className={SELECT}>
                {saved.rooms.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div role="group" aria-label={room.name} className="flex min-w-0 flex-col gap-4">
            <PostingCommands room={room} botKey={saved.key} />
          </div>
        </>
      ) : (
        <p className={cn(NOTE, "rounded-[10px] border border-dashed border-muted-foreground px-[1ch] py-4 text-center")}>
          {saved ? "It isn't in any rooms, so it has no addresses yet." : "Each room's addresses appear once you save the bot, which puts it in its rooms."}
        </p>
      )}
    </section>
  );
}

/**
 * The bot's avatar field, styled by Campfire's avatars.css and inputs.css: Upload bot avatar, a circle
 * `.btn` the file field fills, unseen, beside the bot's avatar, which shows a picture as it's chosen, as
 * Campfire's upload_preview_controller.js shows it. They're the middle columns of three, the last empty and
 * as wide as the first, so the avatar is centered over the form, and both are 36px, or 44px for fingers.
 * Pressing any of it picks a picture, as it's all one label, but not while the form is sent with it. Ember
 * says why a picture over 16 MB isn't kept.
 */
function AvatarField({ src, photo, disabled }: { src: string; photo: PhotoChoice; disabled: boolean }) {
  return (
    <div className="mb-3 grid justify-items-center gap-2">
      <label className="grid cursor-pointer grid-cols-[1fr_auto_1fr] items-center gap-x-[1ch] has-[input:disabled]:cursor-default">
        <span className="relative grid size-9 place-items-center rounded-full border bg-background touch:size-11 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-solid has-[input:focus-visible]:outline-foreground">
          <Camera className="h-5 w-[1.6em]" />
          <input
            ref={photo.input}
            id="user_avatar"
            type="file"
            accept="image/*"
            aria-invalid={photo.refusal ? true : undefined}
            disabled={disabled}
            onChange={photo.choose}
            className="absolute inset-0 size-full cursor-pointer rounded-full opacity-0 disabled:cursor-default"
          />
          <span className="sr-only">Upload bot avatar</span>
        </span>
        <img src={photo.preview ?? src} alt="Bot avatar" width={48} height={48} className="aspect-square size-9 rounded-full object-cover touch:size-11" />
      </label>
      {photo.refusal && (
        <p role="alert" className="text-[0.8rem] text-destructive">
          {photo.refusal}
        </p>
      )}
    </div>
  );
}
