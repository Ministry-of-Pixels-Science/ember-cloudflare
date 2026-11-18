import { Fragment, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode, type Ref } from "react";
import { MAX_ROOM_NAME_LENGTH, type RoomIconName, type User, type UserId } from "@ember/protocol";
import { FIELD_INPUT, Field, SubmitButton } from "@/components/field";
import { CheckCircle, Community, Headset } from "@/components/icons/iconoir";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { IconPicker } from "./icon-picker";
import { ListRow, ListSeparator } from "./list-row";
import { AvatarLink } from "./user-avatar";

// The room forms, which New room and a room's settings share: the room's name and icon, who it's for,
// and Save. A room's settings have whether huddles are allowed in it too, where huddles are on.

/** How many people a form lists before it gets a filter. */
const FILTER_ABOVE = 20;
/** How long the filter waits for typing to stop, as Campfire's filter_controller.js does. */
const FILTER_DELAY_MS = 300;

/** What the Huddles row says of a room whose settings allow huddles in it, and of one whose settings don't. */
export const HUDDLES_ALLOWED = "Members can start and join huddles in this room.";
export const HUDDLES_NOT_ALLOWED = "Members can't start or join huddles in this room.";
/** What it adds for whoever is turning them off while a huddle goes on there. */
export const HUDDLE_ENDS = "Saving ends the huddle that's going on.";

interface Props<Person extends User> {
  /** Whether this person can change the room. Others see its name as a heading, and no Save. */
  canAdminister: boolean;
  name: string;
  onNameChange: (name: string) => void;
  /** The room's icon, or null for `#`, which only whoever can change the room sees, to pick another. */
  icon: RoomIconName | null;
  onIconChange: (icon: RoomIconName | null) => void;
  /** The Everyone row, on for a room open to everyone, with a switch if `onFlip` is given; null for none. */
  everyone: { on: boolean; onFlip?: () => void } | null;
  /** The people listed, by name, in groups a line divides, such as a private room's members and everyone else. */
  groups: Person[][];
  /** What follows someone's name: a check mark, a switch, or nothing. */
  mark: (person: Person) => ReactNode;
  /**
   * The Huddles row, which says whether the room's settings allow huddles in it, with a switch if
   * `onChange` is given, and that turning them off ends the room's huddle while `live` says one is going
   * on; none without it.
   */
  huddles?: { allowed: boolean; onChange?: (allowed: boolean) => void; live?: boolean } | null;
  saving: boolean;
  onSave: () => void;
  /** The form, which the unsaved-changes guard checks before saving from its dialog. */
  ref?: Ref<HTMLFormElement>;
}

export function RoomForm<Person extends User>({ canAdminister, name, onNameChange, icon, onIconChange, everyone, groups, mark, huddles, saving, onSave, ref }: Props<Person>) {
  const save = (event: FormEvent) => {
    event.preventDefault();
    onSave();
  };

  return (
    <form ref={ref} onSubmit={save}>
      {canAdminister ? (
        <Field id="room_name" label="Room name" translation="room_name">
          <Input
            id="room_name"
            required
            autoFocus
            maxLength={MAX_ROOM_NAME_LENGTH}
            placeholder="Name the room"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            className={FIELD_INPUT}
          />
        </Field>
      ) : (
        <h2 className="text-[24px] font-bold wrap-anywhere max-md:text-[22px]">{name}</h2>
      )}

      {canAdminister && <IconPicker icon={icon} onChange={onIconChange} disabled={saving} />}

      {/* Saving sends who the switches showed when Save was pressed, so they wait until it's done. */}
      <fieldset disabled={saving} className="my-4 min-w-0 rounded-[10px] border bg-surface px-[1ch]">
        <People everyone={everyone} groups={groups} mark={mark} />
      </fieldset>

      {huddles && (
        <fieldset disabled={saving} className="my-4 min-w-0 rounded-[10px] border bg-surface px-[1ch]">
          <Huddles {...huddles} />
        </fieldset>
      )}

      {canAdminister && <SubmitButton disabled={saving}>Save</SubmitButton>}
    </form>
  );
}

/** The Everyone row, then a filter for a long list, then the people. */
function People<Person extends User>({ everyone, groups, mark }: Pick<Props<Person>, "everyone" | "groups" | "mark">) {
  const [filter, setFilter] = useState("");
  const listed = groups.filter((group) => group.length > 0);
  const count = listed.reduce((sum, group) => sum + group.length, 0);
  const shown = (person: Person) => person.name.toLowerCase().includes(filter);

  return (
    <menu className="m-0 flex max-h-[50vh] flex-col gap-x-[1ch] gap-y-4 overflow-y-auto px-[1ch] py-4">
      {everyone && (
        <>
          <ListRow figure={<Community className="size-[4ch] shrink-0" />} name="Everyone">
            {everyone.onFlip && (
              <Switch
                checked={everyone.on}
                onCheckedChange={everyone.onFlip}
                aria-label={everyone.on ? "Give only some access to this room" : "Give everyone access to this room"}
              />
            )}
          </ListRow>
          <ListSeparator />
        </>
      )}

      {count > FILTER_ABOVE && <Filter onFilter={setFilter} />}

      {listed.map((group, index) => (
        <Fragment key={index}>
          {index > 0 && <ListSeparator />}
          {group.filter(shown).map((person) => (
            <ListRow key={person.id} figure={<AvatarLink user={person} className="size-[4ch]" lazy />} name={person.name}>
              {mark(person)}
            </ListRow>
          ))}
        </Fragment>
      ))}
    </menu>
  );
}

/** The Huddles row, and under it what the room's settings let its members do, which describes its switch. */
function Huddles({ allowed, onChange, live }: NonNullable<Props<User>["huddles"]>) {
  return (
    <>
      <menu className="m-0 px-[1ch] pt-4">
        <ListRow figure={<Headset className="size-[4ch] shrink-0" />} name="Huddles">
          {onChange && <Switch checked={allowed} onCheckedChange={onChange} aria-label="Allow huddles in this room" aria-describedby="room_huddles_note" />}
        </ListRow>
      </menu>
      <p id="room_huddles_note" className="px-[1ch] pt-2 pb-4 text-[0.8em] text-muted-foreground max-md:text-[12px]">
        {allowed ? HUDDLES_ALLOWED : live ? `${HUDDLES_NOT_ALLOWED} ${HUDDLE_ENDS}` : HUDDLES_NOT_ALLOWED}
      </p>
    </>
  );
}

/**
 * Narrows the list to the names holding what's typed, once typing stops. Enter here doesn't save the
 * form.
 */
function Filter({ onFilter }: { onFilter: (filter: string) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const filter = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value.toLowerCase();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onFilter(text), FILTER_DELAY_MS);
  };

  return (
    <Input
      type="search"
      autoCorrect="off"
      autoComplete="off"
      data-1p-ignore
      placeholder="Filter…"
      onChange={filter}
      onKeyDown={(event) => event.key === "Enter" && event.preventDefault()}
      className={cn(FIELD_INPUT, "bg-transparent px-[0.8em] py-[0.5em]")}
    />
  );
}

/** A check, for someone a room takes in who has no switch. */
export function CheckMark() {
  return <CheckCircle className="size-5 shrink-0" />;
}

/** The people `chosen` for a private room, with `person` among them or not. */
export function withChoice(chosen: ReadonlySet<UserId>, person: User, checked: boolean): ReadonlySet<UserId> {
  const next = new Set(chosen);
  if (checked) next.add(person.id);
  else next.delete(person.id);
  return next;
}

/** The switch that gives someone access to a private room. */
export function AccessSwitch({ person, checked, onCheckedChange }: { person: User; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={`Give ${person.name} access to this room`} />;
}
