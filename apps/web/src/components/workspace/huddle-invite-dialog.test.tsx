import type { DirectoryUser, DirectRoom, Room, RoomSettings, SharedRoom, User } from "@ember/protocol";
import { MAX_HUDDLE_INVITED, type HuddlePerson } from "@ember/protocol/huddles";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlashProvider } from "@/components/flash";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { OPEN_HUDDLE, showHuddle, type JoinedHuddle } from "@/lib/huddle-store";
import { HuddleInviteDialog, INVITATION_UNSENT } from "./huddle-invite-dialog";

const ada: User = { id: "ada", name: "Ada Lovelace" };
const sam: User = { id: "sam", name: "Sam Rivera" };
const priya: User = { id: "priya", name: "Priya Patel" };
const leo: User = { id: "leo", name: "Leo Okafor" };
const general: SharedRoom = { id: "general", name: "general", kind: "open", icon: null };
/** Ada's direct message with `others`. */
const directWith = (...others: User[]): DirectRoom => ({ id: "direct-1", kind: "direct", members: [ada, ...others], activeAt: "2026-11-16T09:00:00.000Z" });
const listed = (user: User, changes: Partial<DirectoryUser> = {}): DirectoryUser => ({ ...user, bio: null, role: "member", status: "active", avatarUrl: `/users/${user.id}/avatar`, ...changes });
/** A bot that posts the deploys, and someone who was deactivated, neither of whom joins a huddle. */
const DEPLOYS = listed({ id: "deploys", name: "Deploys" }, { role: "bot" });
const GRACE = listed({ id: "grace", name: "Grace Hopper" }, { status: "deactivated" });
const directory = (...people: DirectoryUser[]): People => new Map(people.map((person) => [person.id, person]));
const PEOPLE = directory(listed(ada), listed(sam), listed(priya), listed(leo), DEPLOYS, GRACE);

const inHuddle = (user: User): HuddlePerson => ({ user, muted: false, audio: true, video: false, screen: false });
/** The huddle Ada is in, with `others`. */
const huddleWith = (...others: User[]): JoinedHuddle => ({
  roomId: "general",
  connected: true,
  you: ada,
  people: [ada, ...others].map(inHuddle),
  muted: false,
  sticker: null,
  microphone: true,
  microphoneId: "",
  speakerId: "",
  camera: null,
  watched: new Map(),
  screen: null,
  screens: new Map(),
  open: true,
  thread: true,
});

/** A room's settings, as much of them as Invite people reads: who's in it, of everyone who could be. */
const settingsWith = (members: User[], others: User[] = []): RoomSettings => ({
  room: general,
  canAdminister: false,
  canChangeHuddles: false,
  people: [...members.map((person) => ({ ...person, member: true })), ...others.map((person) => ({ ...person, member: false }))],
});
/** Answers a room's settings with `settings`, or refuses them. */
const serve = (settings: RoomSettings | { status: number }) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => ("status" in settings ? Response.json({ error: "Refused" }, { status: settings.status }) : Response.json(settings)));
/** `count` people in general, "Person 01" on, with the directory that lists them. */
const crowd = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `u${index}`, name: `Person ${String(index + 1).padStart(2, "0")}` }));

interface PageProps {
  joined: JoinedHuddle;
  room: Room;
  people: People;
  onClose: () => void;
  onFailed: (error: unknown) => void;
}

/** A huddle opened, as much of one as Invite people needs: the button that opens it, and the huddle itself, which can take the focus. */
function Page({ joined, room, people, onClose, onFailed }: PageProps) {
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const close = () => {
    onClose();
    setOpener(null);
  };
  return (
    <FlashProvider>
      <PeopleContext value={people}>
        <section id={OPEN_HUDDLE} tabIndex={-1} aria-label="Huddle">
          <button type="button" onClick={(event) => setOpener(event.currentTarget)}>
            Invite people
          </button>
        </section>
        {opener && <HuddleInviteDialog huddle={joined} room={room} meId="ada" opener={opener} onClose={close} onFailed={onFailed} />}
      </PeopleContext>
    </FlashProvider>
  );
}

/** Invite people, opened from its button in the huddle Ada is in, with what the huddle was asked. */
async function openInvite(room: Room = general, joined: JoinedHuddle = huddleWith(sam), people: People = PEOPLE) {
  const invite = vi.fn((_userIds: string[]) => true);
  const controls = { leave: vi.fn(), setMuted: vi.fn(), setCamera: vi.fn(), setScreen: vi.fn(), setOpen: vi.fn(), setThread: vi.fn(), setDevice: vi.fn(), setSmall: vi.fn(), switchCamera: vi.fn(), invite, setSticker: vi.fn(), react: vi.fn() };
  act(() => showHuddle(joined, controls));
  const [onClose, onFailed] = [vi.fn(), vi.fn()];
  const user = userEvent.setup();
  const page = (now: JoinedHuddle) => <Page joined={now} room={room} people={people} onClose={onClose} onFailed={onFailed} />;
  const { rerender } = render(page(joined));
  await user.click(opener());
  /** Shows the huddle as it is `now`. */
  const show = (now: JoinedHuddle) => rerender(page(now));
  return { invite, onClose, onFailed, user, show };
}

const opener = () => screen.getByRole("button", { name: "Invite people", hidden: true });
const dialog = () => screen.getByRole("dialog", { name: "Invite people" });
const status = () => within(dialog()).getByRole("status");
/** The people listed, as their checkboxes name them, and those of them that are ticked. */
const boxes = () => within(dialog()).queryAllByRole("checkbox");
const names = (of: HTMLElement[] = boxes()) => of.map((box) => (box.closest("label") as HTMLElement).textContent);
const ticked = () => names(boxes().filter((box) => (box as HTMLInputElement).checked));
const box = (name: string) => within(dialog()).getByRole("checkbox", { name });
const send = () => within(dialog()).getByRole("button", { name: "Send Invite" });
/** The message flashed over the page, which is the one alert while the dialog has none of its own. */
const flashed = () => screen.getByRole("alert", { hidden: true });

afterEach(() => {
  act(() => showHuddle(null));
  vi.restoreAllMocks();
});

describe("Invite people", () => {
  it("lists the people in the huddle's room who aren't in the huddle and could join it, by name, with nobody ticked", async () => {
    // Zoe isn't in the room, Sam is in the huddle, and neither a bot nor someone deactivated joins one.
    const fetched = serve(settingsWith([sam, priya, DEPLOYS, leo, ada, GRACE], [{ id: "zoe", name: "Zoe Quinn" }]));
    await openInvite();
    await waitFor(() => expect(names()).toEqual(["Leo Okafor", "Priya Patel"]));
    expect(fetched).toHaveBeenCalledExactlyOnceWith("/api/rooms/general/settings", expect.anything());
    expect(ticked()).toEqual([]);
    expect(status()).toHaveTextContent("Choose one or more people.");
    expect(dialog()).toHaveAccessibleDescription("People in general who aren’t in the huddle. Ember rings whoever you invite, unless they’ve turned the room’s notifications off.");
    expect(within(dialog()).getByRole("list", { name: "People" })).toBeInTheDocument();
    // So few need no search.
    expect(within(dialog()).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("names people as the directory has them now, and orders them by those names", async () => {
    serve(settingsWith([ada, { ...priya, name: "Was Priya" }, { ...leo, name: "Was Leo" }]));
    await openInvite(general, huddleWith(), directory(listed(ada), listed(priya), listed({ ...leo, name: "Zed Okafor" })));
    await waitFor(() => expect(names()).toEqual(["Priya Patel", "Zed Okafor"]));
  });

  it("has the room ring whoever is ticked, says who's invited, and closes", async () => {
    serve(settingsWith([ada, sam, priya, leo]));
    const { invite, onClose, user } = await openInvite();
    await user.click(await screen.findByRole("checkbox", { name: "Priya Patel" }));
    expect(status()).toHaveTextContent("1 person selected.");
    await user.click(box("Leo Okafor"));
    expect(status()).toHaveTextContent("2 people selected.");
    expect(ticked()).toEqual(["Leo Okafor", "Priya Patel"]);

    await user.click(send());
    expect(invite).toHaveBeenCalledExactlyOnceWith(["leo", "priya"]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(flashed()).toHaveTextContent("Leo and Priya are invited.");
  });

  it("has Send Invite to press only while someone is ticked", async () => {
    serve(settingsWith([ada, priya, leo]));
    const { invite, user } = await openInvite();
    await screen.findByRole("checkbox", { name: "Priya Patel" });
    expect(send()).toBeDisabled();
    await user.click(box("Priya Patel"));
    expect(send()).toBeEnabled();
    await user.click(box("Priya Patel"));
    expect(send()).toBeDisabled();
    expect(status()).toHaveTextContent("Choose one or more people.");
    expect(invite).not.toHaveBeenCalled();
  });

  it("lists a direct message's others at once, without asking for them, and ticks one who's the only one to invite", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    const { invite, user } = await openInvite(directWith(sam), huddleWith());
    expect(names()).toEqual(["Sam Rivera"]);
    expect(ticked()).toEqual(["Sam Rivera"]);
    expect(status()).toHaveTextContent("1 person selected.");
    expect(dialog()).toHaveAccessibleDescription("People in this conversation who aren’t in the huddle. Ember rings whoever you invite, unless they’ve turned its notifications off.");
    expect(fetched).not.toHaveBeenCalled();

    await user.click(send());
    expect(invite).toHaveBeenCalledExactlyOnceWith(["sam"]);
    expect(flashed()).toHaveTextContent("Sam is invited.");
  });

  it("unticks the only one to invite at a click, and ticks them again at another", async () => {
    const { user } = await openInvite(directWith(sam), huddleWith());
    await user.click(box("Sam Rivera"));
    expect(ticked()).toEqual([]);
    expect(send()).toBeDisabled();
    await user.click(box("Sam Rivera"));
    expect(ticked()).toEqual(["Sam Rivera"]);
  });

  it("ticks none of a group's direct message, who are several", async () => {
    await openInvite(directWith(sam, priya, leo), huddleWith(sam));
    expect(names()).toEqual(["Leo Okafor", "Priya Patel"]);
    expect(ticked()).toEqual([]);
  });

  it("says so when the room has nobody else to invite", async () => {
    await openInvite(directWith(sam, DEPLOYS), huddleWith(sam));
    expect(status()).toHaveTextContent("There’s nobody else in this conversation to invite.");
    expect(boxes()).toEqual([]);
    expect(within(dialog()).queryByRole("list")).not.toBeInTheDocument();
    expect(send()).toBeDisabled();
  });

  it("says so of a shared room by its name", async () => {
    serve(settingsWith([ada, sam]));
    await openInvite();
    await waitFor(() => expect(status()).toHaveTextContent("There’s nobody else in general to invite."));
  });

  it("says that it's loading until the room's people come, and has you try again when they don't", async () => {
    const answers: ((response: Response) => void)[] = [];
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const { onFailed, user } = await openInvite();
    expect(status()).toHaveTextContent("Loading people…");
    expect(within(dialog()).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(send()).toBeDisabled();

    await act(async () => answers[0]!(Response.json({ error: "Something went wrong" }, { status: 500 })));
    expect(status()).toHaveTextContent("Couldn’t load people. Please try again.");
    expect(onFailed).not.toHaveBeenCalled();

    await user.click(within(dialog()).getByRole("button", { name: "Try again" }));
    expect(status()).toHaveTextContent("Loading people…");
    expect(fetched).toHaveBeenCalledTimes(2);
    await act(async () => answers[1]!(Response.json(settingsWith([ada, priya]))));
    expect(names()).toEqual(["Priya Patel"]);
    expect(within(dialog()).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("reports a session that's ended, when that's why the room's people didn't come", async () => {
    serve({ status: 401 });
    const { onFailed } = await openInvite();
    await waitFor(() => expect(onFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401 })));
    expect(status()).toHaveTextContent("Loading people…");
  });

  it("lists 20 at a time past 20, under a search by name", async () => {
    const people = crowd(45);
    serve(settingsWith([ada, ...people]));
    const { user } = await openInvite(general, huddleWith(), directory(listed(ada), ...people.map((person) => listed(person))));
    await waitFor(() => expect(boxes()).toHaveLength(20));
    expect(names().at(-1)).toBe("Person 20");
    const search = within(dialog()).getByRole("textbox", { name: "Search people" });

    await user.click(within(dialog()).getByRole("button", { name: "Show more people" }));
    expect(boxes()).toHaveLength(40);
    expect(within(dialog()).getByRole("button", { name: "Show more people" })).toHaveFocus();
    await user.click(within(dialog()).getByRole("button", { name: "Show more people" }));
    expect(boxes()).toHaveLength(45);
    // The button goes once everyone's shown, and the focus goes to the first person it added.
    expect(within(dialog()).queryByRole("button", { name: "Show more people" })).not.toBeInTheDocument();
    expect(box("Person 41")).toHaveFocus();

    await user.type(search, "  @PERSON 4");
    expect(names()).toEqual(["Person 40", "Person 41", "Person 42", "Person 43", "Person 44", "Person 45"]);
    await user.type(search, "x");
    expect(boxes()).toEqual([]);
    expect(status()).toHaveTextContent("No people found. Try another name.");
    // Each search starts from its first 20, at the top of the list.
    const list = status().parentElement!;
    list.scrollTop = 300;
    await user.clear(search);
    expect(boxes()).toHaveLength(20);
    expect(list.scrollTop).toBe(0);
  });

  it("keeps its search once it has one, however few are left to invite, so that it isn't taken from under whoever is typing in it", async () => {
    const people = crowd(21);
    serve(settingsWith([ada, ...people]));
    const { user, show } = await openInvite(general, huddleWith(), directory(listed(ada), ...people.map((person) => listed(person))));
    await waitFor(() => expect(boxes()).toHaveLength(20));
    const search = within(dialog()).getByRole("textbox", { name: "Search people" });
    await user.type(search, "person 2");
    expect(names()).toEqual(["Person 20", "Person 21"]);

    // One of them joins, which leaves 20 to invite, as many as the list shows at once.
    show(huddleWith(people[20]!));
    expect(names()).toEqual(["Person 20"]);
    expect(search).toHaveValue("person 2");
    expect(search).toHaveFocus();
    await user.clear(search);
    expect(boxes()).toHaveLength(20);
    expect(search).toHaveFocus();
  });

  it("keeps whoever is ticked while a search shows others, and invites them too", async () => {
    const people = crowd(25);
    serve(settingsWith([ada, ...people]));
    const { invite, user } = await openInvite(general, huddleWith(), directory(listed(ada), ...people.map((person) => listed(person))));
    await user.click(await screen.findByRole("checkbox", { name: "Person 02" }));
    const search = within(dialog()).getByRole("textbox", { name: "Search people" });
    await user.type(search, "person 25");
    expect(names()).toEqual(["Person 25"]);
    expect(status()).toHaveTextContent("1 person selected.");
    await user.click(box("Person 25"));
    await user.clear(search);
    // The first 20 show again, and the 25th is ticked still.
    expect(ticked()).toEqual(["Person 02"]);
    expect(status()).toHaveTextContent("2 people selected.");

    await user.click(send());
    expect(invite).toHaveBeenCalledExactlyOnceWith(["u1", "u24"]);
  });

  it("names no more people than one invitation takes, so the rest can't be ticked once that many are", async () => {
    const people = crowd(MAX_HUDDLE_INVITED + 2);
    serve(settingsWith([ada, ...people]));
    const { invite } = await openInvite(general, huddleWith(), directory(listed(ada), ...people.map((person) => listed(person))));
    await waitFor(() => expect(boxes()).toHaveLength(20));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Show more people" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Show more people" }));
    expect(boxes()).toHaveLength(MAX_HUDDLE_INVITED + 2);
    for (const each of boxes().slice(0, MAX_HUDDLE_INVITED - 1)) fireEvent.click(each);
    expect(status()).toHaveTextContent(`${MAX_HUDDLE_INVITED - 1} people selected.`);
    expect(boxes().every((each) => !(each as HTMLInputElement).disabled)).toBe(true);

    fireEvent.click(boxes()[MAX_HUDDLE_INVITED - 1]!);
    expect(status()).toHaveTextContent(`${MAX_HUDDLE_INVITED} people selected, the most one invitation takes.`);
    expect(boxes().filter((each) => (each as HTMLInputElement).disabled)).toHaveLength(2);
    // Whoever is ticked can still be unticked, which frees the rest.
    fireEvent.click(boxes()[0]!);
    expect(boxes().every((each) => !(each as HTMLInputElement).disabled)).toBe(true);
    fireEvent.click(boxes()[0]!);

    fireEvent.click(send());
    expect(invite.mock.calls[0]![0]).toHaveLength(MAX_HUDDLE_INVITED);
  });

  it("says so, and stays open, when the huddle can't ask its room, as while it reconnects", async () => {
    const { invite, onClose, user } = await openInvite(directWith(sam, priya), huddleWith());
    invite.mockReturnValue(false);
    await user.click(box("Sam Rivera"));
    await user.click(send());
    expect(within(dialog()).getByRole("alert")).toHaveTextContent(INVITATION_UNSENT);
    expect(onClose).not.toHaveBeenCalled();
    expect(ticked()).toEqual(["Sam Rivera"]);
    // Ticking anyone takes the place of what it said.
    await user.click(box("Priya Patel"));
    expect(within(dialog()).queryByRole("alert")).not.toBeInTheDocument();

    invite.mockReturnValue(true);
    await user.click(send());
    expect(invite).toHaveBeenLastCalledWith(["priya", "sam"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves out whoever joins the huddle while it's open, ticked or not", async () => {
    const { invite, user, show } = await openInvite(directWith(sam, priya, leo), huddleWith());
    await user.click(box("Priya Patel"));
    await user.click(box("Sam Rivera"));
    show(huddleWith(priya));
    expect(names()).toEqual(["Leo Okafor", "Sam Rivera"]);
    expect(status()).toHaveTextContent("1 person selected.");
    await user.click(send());
    expect(invite).toHaveBeenCalledExactlyOnceWith(["sam"]);
  });

  it("takes the focus on its title as it opens, and gives it back to the button that opened it as it closes", async () => {
    const { user } = await openInvite(directWith(sam), huddleWith());
    expect(within(dialog()).getByRole("heading", { name: "Invite people" })).toHaveFocus();
    await user.click(within(dialog()).getAllByRole("button", { name: "Cancel" })[1]!);
    await waitFor(() => expect(opener()).toHaveFocus());
  });

  it("gives the focus to the huddle itself when the button that opened it can't take it, as one the window no longer has room for", async () => {
    const { user } = await openInvite(directWith(sam), huddleWith());
    // jsdom would focus a button that isn't shown, where a browser doesn't.
    const button = opener();
    button.style.display = "none";
    button.focus = () => {};
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("region", { name: "Huddle" })).toHaveFocus());
  });

  it("closes on Cancel, on the button in its corner, and on Escape, inviting nobody", async () => {
    const { invite, onClose, user } = await openInvite(directWith(sam), huddleWith());
    // The corner's is first, and the one beside Send Invite second.
    await user.click(within(dialog()).getAllByRole("button", { name: "Cancel" })[1]!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(opener());
    await user.click(within(dialog()).getAllByRole("button", { name: "Cancel" })[0]!);
    expect(onClose).toHaveBeenCalledTimes(2);

    await user.click(opener());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(invite).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert", { hidden: true })).not.toBeInTheDocument();
  });
});
