import type { Room, RoomSettings } from "@ember/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "@/components/ui/sheet";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { leave, navigate, useRoute } from "@/hooks/use-route";
import { ApiError } from "@/lib/api";
import type { RoomAnswer } from "@/lib/room-list";
import { HuddlesContext, type Huddles } from "./huddle-button";
import { HUDDLE_ENDS, HUDDLES_ALLOWED, HUDDLES_NOT_ALLOWED } from "./room-form";
import { CONFIRM_DELETE, CONFIRM_LEAVE, RoomSettingsPage } from "./room-settings-page";

const ada = { id: "u1", name: "Ada Lovelace" };
const grace = { id: "u2", name: "Grace Hopper" };
const linus = { id: "u3", name: "Linus Torvalds" };
const design: Room = { id: "design", name: "Design", kind: "open", icon: null };
const leads: Room = { id: "leads", name: "Leads", kind: "closed", icon: "lock" };

/** Design's settings, as an administrator has them, or as someone who can't change the room does. */
const openSettings = (canAdminister = true): RoomSettings => ({
  room: design,
  canAdminister,
  canChangeHuddles: canAdminister,
  people: [ada, grace, linus].map((person) => ({ ...person, member: true })),
});
const closedSettings: RoomSettings = {
  room: leads,
  canAdminister: true,
  canChangeHuddles: true,
  people: [
    { ...ada, member: true },
    { ...grace, member: false },
    { ...linus, member: true },
  ],
};

/** Answers `settings` for the page, then `saved` (or `refusal`) for a change. */
function serve(settings: RoomSettings | { status: number; error: string }, { saved, refusal }: { saved?: Room; refusal?: { status: number; error: string } } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (init?.method === "PATCH") return refusal ? Response.json({ error: refusal.error }, { status: refusal.status }) : Response.json({ room: saved });
    expect(input).toMatch(/^\/api\/rooms\/[^/]+\/settings$/);
    return "status" in settings ? Response.json({ error: settings.error }, { status: settings.status }) : Response.json(settings);
  });
}

/** Answers `settings` for the page, and holds a change, or with `DELETE` a deletion, until the returned function answers it. */
function holdChange(settings: RoomSettings, method: "PATCH" | "DELETE" = "PATCH") {
  let answer = (_: Response) => {};
  vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
    init?.method === method ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(Response.json(settings)),
  );
  return (response: Response) => act(async () => answer(response));
}

type Callbacks = Pick<Parameters<typeof RoomSettingsPage>[0], "askForRoom" | "onMissing" | "onFailed">;

/** The page, as Ada, at the form its address names, as the workspace shows it. */
function SettingsRoute(callbacks: Callbacks) {
  const route = useRoute();
  return route.page === "room-settings" ? (
    <RoomSettingsPage key={route.roomId} roomId={route.roomId} access={route.access} me={ada} {...callbacks} />
  ) : null;
}

function showPage(room: Room, path = `/rooms/${room.kind}s/${room.id}/edit`, wrapper?: (props: { children: ReactNode }) => ReactNode) {
  const [onSaved, onLeft, onMissing, onFailed] = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  // The answers the page lists: rooms saved, and those it took Ada out of or deleted.
  const askForRoom = () => (answer: RoomAnswer) => (answer.type === "saved" ? onSaved(answer.room) : onLeft(answer.roomId));
  history.replaceState(null, "", path);
  const { unmount } = render(
    <Sheet>
      <SettingsRoute askForRoom={askForRoom} onMissing={onMissing} onFailed={onFailed} />
    </Sheet>,
    { wrapper },
  );
  return { onSaved, onLeft, onMissing, onFailed, unmount, user: userEvent.setup() };
}

const rowOf = (name: string) => screen.getByText(name).closest("li")!;
const hasCheckMark = (name: string) => rowOf(name).querySelector("svg.iconoir-check-circle") !== null;
/** The names listed, in order, not counting the avatars' initials. */
const names = () => screen.getAllByRole("listitem").map((row) => row.querySelector("strong")!.textContent);
const roomName = () => screen.findByRole("textbox", { name: "Room name" });
const accessSwitch = (person: { name: string }) => screen.getByRole("switch", { name: `Give ${person.name} access to this room` });
/** What the page asked the server to change. */
const sent = () => JSON.parse(vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body as string) as unknown;
const asking = () => screen.queryByRole("dialog", { name: "Unsaved Changes" });

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("Room settings page", () => {
  it("reads Room settings, titled for the room, with Go Back to community settings' rooms", async () => {
    serve(openSettings());
    showPage(design);
    expect(await roomName()).toHaveValue("Design");
    expect(document.title).toBe("Edit settings for Design");
    expect(screen.getByRole("heading", { level: 1, name: "Room settings" })).toBeInTheDocument();
    expect(screen.getByText("Manage the room name, access, and members.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/account/edit#channel-settings");
  });

  it("lists everyone in an open room under Everyone, which is on, each with a check mark", async () => {
    serve(openSettings());
    showPage(design);
    await roomName();
    expect(names()).toEqual(["Everyone", "Ada Lovelace", "Grace Hopper", "Linus Torvalds"]);
    expect(screen.getByRole("switch", { name: "Give only some access to this room" })).toBeChecked();
    for (const person of [ada, grace, linus]) {
      expect(hasCheckMark(person.name)).toBe(true);
      expect(within(rowOf(person.name)).queryByRole("switch")).not.toBeInTheDocument();
    }
  });

  it("lists a private room's members with their switches on, then everyone else with theirs off", async () => {
    serve(closedSettings);
    showPage(leads);
    await roomName();
    expect(names()).toEqual(["Everyone", "Ada Lovelace", "Linus Torvalds", "Grace Hopper"]);
    expect(screen.getByRole("switch", { name: "Give everyone access to this room" })).not.toBeChecked();
    // One line under Everyone, and one between the members and everyone else.
    expect(screen.getByRole("list").querySelectorAll(":scope > hr")).toHaveLength(2);
    expect([ada, grace, linus].map((person) => accessSwitch(person).getAttribute("aria-checked"))).toEqual(["true", "false", "true"]);
  });

  it("renames the room", async () => {
    const saved = { ...design, name: "Product design" };
    serve(openSettings(), { saved });
    const { onSaved, user } = showPage(design);
    await user.clear(await roomName());
    await user.type(await roomName(), "Product design{Enter}");
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    const [path, init] = vi.mocked(fetch).mock.calls.at(-1)!;
    expect(path).toBe("/api/rooms/design");
    expect(JSON.parse(init!.body as string)).toEqual({ name: "Product design", icon: "", kind: "open" });
    expect(location.pathname).toBe("/rooms/design");
  });

  it("lists a rename whose answer comes after the page was left, without taking over the page shown then", async () => {
    const saved = { ...design, name: "Product design" };
    const answer = holdChange(openSettings());
    const { onSaved, user, unmount } = showPage(design);
    await user.click(await screen.findByRole("button", { name: "Save" }));
    unmount();
    history.replaceState(null, "", "/rooms/random");
    await answer(Response.json({ room: saved }));
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(location.pathname).toBe("/rooms/random");
  });

  it("drops a failure that answers after the page was left, even for a room that's gone", async () => {
    const answer = holdChange(openSettings());
    const { onMissing, onFailed, user, unmount } = showPage(design);
    await user.click(await screen.findByRole("button", { name: "Save" }));
    unmount();
    await answer(Response.json({ error: "Room not found or inaccessible" }, { status: 404 }));
    expect(onMissing).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("still reports a session that's ended, though the page was left before the answer", async () => {
    const answer = holdChange(openSettings());
    const { onFailed, user, unmount } = showPage(design);
    await user.click(await screen.findByRole("button", { name: "Save" }));
    unmount();
    await answer(Response.json({ error: "Sign in to continue" }, { status: 401 }));
    expect(onFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401 }));
  });

  it("says why a change wasn't saved, and lets you try again", async () => {
    serve(openSettings(), { refusal: { status: 422, error: "Name must be 1 to 100 characters" } });
    const { onSaved, onFailed, user } = showPage(design);
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 422, message: "Name must be 1 to 100 characters" })));
    expect(onFailed.mock.calls[0]![0]).toBeInstanceOf(ApiError);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});

describe("Room icon picker", () => {
  /** The icon picker's catalog, of one icon. */
  const LOCK_CATALOG = { icons: [{ name: "lock", label: "Lock", collection: "Lucide", tags: ["security"], svg: "<svg></svg>" }], roomOrder: ["lock"], navigationOrder: ["lock"] };

  it("starts with the room's icon, and saves the one chosen", async () => {
    const saved = { ...leads, icon: null };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("catalog.json")) return Response.json(LOCK_CATALOG);
      return init?.method === "PATCH" ? Response.json({ room: saved }) : Response.json(closedSettings);
    });
    const { onSaved, user } = showPage(leads);
    expect(await screen.findByRole("button", { name: "Choose room icon" })).toHaveTextContent("Lock");
    await user.click(screen.getByRole("button", { name: "Choose room icon" }));
    await user.click(await screen.findByRole("button", { name: "Use default icon" }));
    await user.click(screen.getByRole("button", { name: "Use icon" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(sent()).toEqual({ name: "Leads", icon: "", kind: "closed", memberIds: [ada.id, linus.id] });
  });

  it("counts an icon put in the form as a change until it's put back", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("catalog.json") ? Response.json(LOCK_CATALOG) : Response.json(closedSettings),
    );
    const { user } = showPage(leads);
    const pick = async (name: string) => {
      await user.click(await screen.findByRole("button", { name: "Choose room icon" }));
      await user.click(await screen.findByRole("button", { name }));
      await user.click(screen.getByRole("button", { name: "Use icon" }));
    };
    await pick("Use default icon");
    act(() => navigate("/rooms/general"));
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(asking()).not.toBeInTheDocument());

    await pick("Use Lock icon");
    act(() => navigate("/rooms/general"));
    expect(location.pathname).toBe("/rooms/general");
  });
});

describe("Switch a room between open and private", () => {
  it("makes an open room private in place, keeping the name, with everyone in it switched on", async () => {
    serve(openSettings(), { saved: { ...design, name: "Leads", kind: "closed" } });
    const { onSaved, user } = showPage(design);
    await user.clear(await roomName());
    await user.type(await roomName(), "Leads");
    const length = history.length;
    await user.click(screen.getByRole("switch", { name: "Give only some access to this room" }));
    expect(location.pathname).toBe("/rooms/closeds/design/edit");
    expect(history.length).toBe(length);
    expect(await roomName()).toHaveValue("Leads");
    for (const person of [ada, grace, linus]) expect(accessSwitch(person)).toBeChecked();

    await user.click(accessSwitch(grace));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...design, name: "Leads", kind: "closed" }));
    expect(sent()).toEqual({ name: "Leads", icon: "", kind: "closed", memberIds: [ada.id, linus.id] });
    expect(location.pathname).toBe("/rooms/design");
  });

  it("opens a private room to everyone", async () => {
    serve(closedSettings, { saved: { ...leads, kind: "open" } });
    const { onSaved, user } = showPage(leads);
    await user.click(await screen.findByRole("switch", { name: "Give everyone access to this room" }));
    expect(location.pathname).toBe("/rooms/opens/leads/edit");
    for (const person of [ada, grace, linus]) expect(hasCheckMark(person.name)).toBe(true);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...leads, kind: "open" }));
    expect(sent()).toEqual({ name: "Leads", icon: "lock", kind: "open" });
  });

  it("keeps who's chosen when Everyone goes on and off again", async () => {
    serve(closedSettings);
    const { user } = showPage(leads);
    await user.click(await screen.findByRole("switch", { name: `Give ${grace.name} access to this room` }));
    await user.click(screen.getByRole("switch", { name: "Give everyone access to this room" }));
    await user.click(screen.getByRole("switch", { name: "Give only some access to this room" }));
    expect(accessSwitch(grace)).toBeChecked();
  });

  it("moves people who can't change the room to the address for its kind, in place", async () => {
    serve(openSettings(false));
    history.replaceState(null, "", "/");
    const length = history.length;
    showPage(design, "/rooms/closeds/design/edit");
    await waitFor(() => expect(location.pathname).toBe("/rooms/opens/design/edit"));
    expect(history.length).toBe(length);
  });

  it("shows whoever can change the room the form its address names", async () => {
    serve(openSettings());
    showPage(design, "/rooms/closeds/design/edit");
    await roomName();
    expect(screen.getByRole("switch", { name: "Give everyone access to this room" })).not.toBeChecked();
    expect(location.pathname).toBe("/rooms/closeds/design/edit");
  });
});

describe("Add and remove private room members", () => {
  it("saves a private room with the people whose switches are on", async () => {
    serve(closedSettings, { saved: leads });
    const { onSaved, user } = showPage(leads);
    await user.click(await screen.findByRole("switch", { name: `Give ${grace.name} access to this room` }));
    await user.click(accessSwitch(linus));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(leads));
    expect(sent()).toEqual({ name: "Leads", icon: "lock", kind: "closed", memberIds: [ada.id, grace.id] });
  });

  it("goes home when you save the room without yourself, taking it out of the sidebar", async () => {
    serve(closedSettings, { saved: leads });
    const { onSaved, onLeft, onMissing, user } = showPage(leads);
    await user.click(await screen.findByRole("switch", { name: `Give ${ada.name} access to this room` }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onLeft).toHaveBeenCalledWith(leads.id));
    expect(sent()).toEqual({ name: "Leads", icon: "lock", kind: "closed", memberIds: [linus.id] });
    expect(onMissing).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("holds the switches as they were sent until the change is saved", async () => {
    const answer = holdChange(closedSettings);
    const { onSaved, user } = showPage(leads);
    await user.click(await screen.findByRole("switch", { name: `Give ${grace.name} access to this room` }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(accessSwitch(linus));
    await user.click(screen.getByRole("switch", { name: "Give everyone access to this room" }));
    expect(accessSwitch(linus)).toBeChecked();
    expect(location.pathname).toBe("/rooms/closeds/leads/edit");

    await answer(Response.json({ room: leads }));
    expect(sent()).toEqual({ name: "Leads", icon: "lock", kind: "closed", memberIds: [ada.id, linus.id, grace.id] });
    expect(onSaved).toHaveBeenCalledWith(leads);
  });

  it("takes a room left out of the sidebar when the answer comes after the page was left, staying where you are", async () => {
    const answer = holdChange(closedSettings);
    const { onLeft, onMissing, user, unmount } = showPage(leads);
    await user.click(await screen.findByRole("switch", { name: `Give ${ada.name} access to this room` }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    unmount();
    await answer(Response.json({ room: leads }));
    expect(onLeft).toHaveBeenCalledWith(leads.id);
    expect(onMissing).not.toHaveBeenCalled();
  });
});

describe("Who can change a room", () => {
  it("shows people who can't change the room its name and people, and nothing to change them with", async () => {
    serve(openSettings(false));
    showPage(design);
    expect(await screen.findByRole("heading", { level: 2, name: "Design" })).toBeInTheDocument();
    expect(names()).toEqual(["Everyone", "Ada Lovelace", "Grace Hopper", "Linus Torvalds"]);
    expect([ada, grace, linus].map((person) => hasCheckMark(person.name))).toEqual([false, false, false]);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("shows them a private room's members, then everyone else, with no Everyone row or switches", async () => {
    serve({ ...closedSettings, canAdminister: false, canChangeHuddles: false });
    showPage(leads);
    expect(await screen.findByRole("heading", { level: 2, name: "Leads" })).toBeInTheDocument();
    expect(names()).toEqual(["Ada Lovelace", "Linus Torvalds", "Grace Hopper"]);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("goes home for a room that isn't there, or that the person isn't in", async () => {
    serve({ status: 404, error: "Room not found or inaccessible" });
    const { onMissing, onFailed } = showPage(design);
    await waitFor(() => expect(onMissing).toHaveBeenCalledOnce());
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("goes home when a room has gone by the time it's saved", async () => {
    serve(openSettings(), { refusal: { status: 404, error: "Room not found or inaccessible" } });
    const { onMissing, onFailed, user } = showPage(design);
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(onMissing).toHaveBeenCalledOnce());
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says why it couldn't load the settings", async () => {
    serve({ status: 503, error: "Service unavailable" });
    const { onMissing, onFailed } = showPage(design);
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 503 })));
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("reports only a session that's ended when the settings answer after the page was left", async () => {
    const answers: ((response: Response) => void)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const first = showPage(design);
    first.unmount();
    const second = showPage(design);
    second.unmount();
    await act(async () => answers[0]!(Response.json({ error: "Room not found or inaccessible" }, { status: 404 })));
    expect(first.onMissing).not.toHaveBeenCalled();
    expect(first.onFailed).not.toHaveBeenCalled();
    await act(async () => answers[1]!(Response.json({ error: "Sign in to continue" }, { status: 401 })));
    expect(second.onFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401 }));
    expect(second.onMissing).not.toHaveBeenCalled();
  });
});

describe("Allow huddles in a room", () => {
  /** Gives what's inside it a workspace where huddles are on, with the huddles going on in it. */
  const huddlesOn = (live: Huddles["live"] = {}) =>
    function HuddlesOn({ children }: { children: ReactNode }) {
      return (
        <AccountContext value={{ ...useAccount(), huddles: true }}>
          <HuddlesContext value={{ live, preview: vi.fn() }}>{children}</HuddlesContext>
        </AccountContext>
      );
    };
  /** The page where huddles are on. */
  const showWithHuddles = (room: Room, live?: Huddles["live"]) => showPage(room, undefined, huddlesOn(live));
  const withoutHuddles = (settings: RoomSettings): RoomSettings => ({ ...settings, room: { ...settings.room, huddles: false } });
  /** The settings of whoever made the room and isn't an administrator: theirs to change, but for its huddles. */
  const asCreator = (settings: RoomSettings): RoomSettings => ({ ...settings, canChangeHuddles: false });
  const huddlesSwitch = () => screen.findByRole("switch", { name: "Allow huddles in this room" });
  const huddle = { startedAt: "2026-11-17T09:00:00.000Z", userIds: [grace.id] };

  it("has no Huddles row until huddles are on, and saves a room without a word of them", async () => {
    serve(withoutHuddles(openSettings()), { saved: { ...design, name: "Design team", huddles: false } });
    const { onSaved, user } = showPage(design);
    await user.type(await roomName(), " team");
    expect(names()).toEqual(["Everyone", "Ada Lovelace", "Grace Hopper", "Linus Torvalds"]);
    expect(screen.queryByRole("switch", { name: "Allow huddles in this room" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(sent()).toEqual({ name: "Design team", icon: "", kind: "open" });
  });

  it("has the Huddles switch under the people once they are, on for a room that allows them and off for one that doesn't", async () => {
    serve(openSettings());
    const allowed = showWithHuddles(design);
    expect(await huddlesSwitch()).toBeChecked();
    expect(await huddlesSwitch()).toHaveAccessibleDescription(HUDDLES_ALLOWED);
    expect(names()).toEqual(["Everyone", "Ada Lovelace", "Grace Hopper", "Linus Torvalds", "Huddles"]);
    allowed.unmount();

    vi.restoreAllMocks();
    serve(withoutHuddles(closedSettings));
    showWithHuddles(leads);
    expect(await huddlesSwitch()).not.toBeChecked();
    expect(await huddlesSwitch()).toHaveAccessibleDescription(HUDDLES_NOT_ALLOWED);
  });

  it("turns huddles off in a room, and on again, with Save", async () => {
    const saved: Room = { ...design, huddles: false };
    serve(openSettings(), { saved });
    const off = showWithHuddles(design);
    await off.user.click(await huddlesSwitch());
    expect(await huddlesSwitch()).not.toBeChecked();
    await off.user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(off.onSaved).toHaveBeenCalledWith(saved));
    expect(sent()).toEqual({ name: "Design", icon: "", huddles: false, kind: "open" });
    expect(location.pathname).toBe("/rooms/design");
    off.unmount();

    vi.restoreAllMocks();
    serve(withoutHuddles(closedSettings), { saved: leads });
    const on = showWithHuddles(leads);
    await on.user.click(await huddlesSwitch());
    await on.user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(on.onSaved).toHaveBeenCalledWith(leads));
    expect(sent()).toEqual({ name: "Leads", icon: "lock", huddles: true, kind: "closed", memberIds: [ada.id, linus.id] });
  });

  it("saves the switch as it stands with any other change", async () => {
    serve(withoutHuddles(openSettings()), { saved: { ...design, name: "Design team", huddles: false } });
    const { onSaved, user } = showWithHuddles(design);
    await user.type(await roomName(), " team{Enter}");
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(sent()).toEqual({ name: "Design team", icon: "", huddles: false, kind: "open" });
  });

  it("says that saving ends the huddle going on in the room, once its switch is off", async () => {
    serve(openSettings());
    const here = showWithHuddles(design, { design: huddle });
    expect(await huddlesSwitch()).toHaveAccessibleDescription(HUDDLES_ALLOWED);
    await here.user.click(await huddlesSwitch());
    expect(await huddlesSwitch()).toHaveAccessibleDescription(`${HUDDLES_NOT_ALLOWED} ${HUDDLE_ENDS}`);
    here.unmount();

    // A huddle in another room isn't this one's to end.
    const elsewhere = showWithHuddles(design, { leads: huddle });
    await elsewhere.user.click(await huddlesSwitch());
    expect(await huddlesSwitch()).toHaveAccessibleDescription(HUDDLES_NOT_ALLOWED);
  });

  it("counts the switch as a change to ask about before leaving, and not once it's flipped back", async () => {
    serve(openSettings());
    const { user } = showWithHuddles(design);
    await user.click(await huddlesSwitch());
    act(() => navigate("/rooms/general"));
    expect(await screen.findByRole("dialog", { name: "Unsaved Changes" })).toBeInTheDocument();
    expect(location.pathname).toBe("/rooms/opens/design/edit");

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(asking()).not.toBeInTheDocument());
    await user.click(await huddlesSwitch());
    act(() => navigate("/rooms/general"));
    expect(location.pathname).toBe("/rooms/general");
    expect(asking()).not.toBeInTheDocument();
  });

  it("has no Huddles switch for the room's creator, who isn't an administrator, and saves their changes without a word of huddles", async () => {
    serve(asCreator(openSettings()), { saved: { ...design, name: "Design team" } });
    const { onSaved, user } = showWithHuddles(design);
    await user.type(await roomName(), " team");
    expect(names()).toEqual(["Everyone", "Ada Lovelace", "Grace Hopper", "Linus Torvalds"]);
    expect(screen.queryByRole("switch", { name: "Allow huddles in this room" })).not.toBeInTheDocument();
    expect(screen.queryByText(HUDDLES_ALLOWED)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(sent()).toEqual({ name: "Design team", icon: "", kind: "open" });
  });

  it("tells the room's creator that it has no huddles, as it tells everyone else, and leaves that as it is when they save", async () => {
    serve(asCreator(withoutHuddles(openSettings())), { saved: { ...design, name: "Design team", huddles: false } });
    const { onSaved, user } = showWithHuddles(design, { design: huddle });
    expect(await screen.findByText(HUDDLES_NOT_ALLOWED)).toBeInTheDocument();
    expect(names()).toEqual(["Everyone", "Ada Lovelace", "Grace Hopper", "Linus Torvalds", "Huddles"]);
    expect(screen.queryByRole("switch", { name: "Allow huddles in this room" })).not.toBeInTheDocument();
    await user.type(await roomName(), " team{Enter}");
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(sent()).toEqual({ name: "Design team", icon: "", kind: "open" });
  });

  it("only tells people who can't change the room that it has no huddles, and nothing of a room that has them", async () => {
    serve(withoutHuddles(openSettings(false)));
    const none = showWithHuddles(design);
    expect(await screen.findByText(HUDDLES_NOT_ALLOWED)).toBeInTheDocument();
    expect(names()).toEqual(["Everyone", "Ada Lovelace", "Grace Hopper", "Linus Torvalds", "Huddles"]);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    none.unmount();

    vi.restoreAllMocks();
    serve(openSettings(false));
    showWithHuddles(design);
    expect(await screen.findByRole("heading", { level: 2, name: "Design" })).toBeInTheDocument();
    expect(names()).toEqual(["Everyone", "Ada Lovelace", "Grace Hopper", "Linus Torvalds"]);
    expect(screen.queryByText(HUDDLES_ALLOWED)).not.toBeInTheDocument();
  });
});

describe("Delete a room", () => {
  const deleteButton = () => screen.findByRole("button", { name: "Delete Design" });
  const confirmed = (answer: boolean) => vi.spyOn(window, "confirm").mockReturnValue(answer);
  const deleted = () => new Response(null, { status: 204 });

  it("offers Delete under the settings, with the trash can and the room's name", async () => {
    serve(openSettings());
    showPage(design);
    const button = await deleteButton();
    expect(button).toHaveTextContent(/^Design$/);
    expect(button.querySelector("svg")).toHaveClass("iconoir-trash");
    expect(button.closest("section")).not.toBe((await roomName()).closest("section"));
  });

  it("deletes the room once you confirm, taking it out of the sidebar and going home", async () => {
    const confirm = confirmed(true);
    const answer = holdChange(openSettings(), "DELETE");
    const { onLeft, onMissing, user } = showPage(design);
    await user.click(await deleteButton());
    expect(confirm).toHaveBeenCalledExactlyOnceWith(CONFIRM_DELETE);
    expect(vi.mocked(fetch).mock.calls.at(-1)).toEqual(["/api/rooms/design", expect.objectContaining({ method: "DELETE" })]);
    // Neither button can be pressed again until it answers.
    expect(await deleteButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await answer(deleted());
    expect(onLeft).toHaveBeenCalledExactlyOnceWith(design.id);
    expect(location.pathname).toBe("/");
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("deletes nothing unless you confirm", async () => {
    confirmed(false);
    serve(openSettings());
    const { onLeft, user } = showPage(design);
    await user.click(await deleteButton());
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(onLeft).not.toHaveBeenCalled();
    expect(await deleteButton()).toBeEnabled();
  });

  it("offers Delete only to whoever can change the room", async () => {
    serve(openSettings(false));
    showPage(design);
    await screen.findByRole("heading", { level: 2, name: "Design" });
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
  });

  it("goes home with the alert when the room's already gone", async () => {
    confirmed(true);
    const answer = holdChange(openSettings(), "DELETE");
    const { onLeft, onMissing, user } = showPage(design);
    await user.click(await deleteButton());
    await answer(Response.json({ error: "Room not found or inaccessible" }, { status: 404 }));
    expect(onMissing).toHaveBeenCalledOnce();
    expect(onLeft).not.toHaveBeenCalled();
  });

  it("says why the room wasn't deleted, and lets you try again", async () => {
    confirmed(true);
    const answer = holdChange(openSettings(), "DELETE");
    const { onFailed, onLeft, user } = showPage(design);
    await user.click(await deleteButton());
    await answer(Response.json({ error: "Only administrators and the room's creator can delete it" }, { status: 403 }));
    expect(onFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 403 }));
    expect(onLeft).not.toHaveBeenCalled();
    expect(await deleteButton()).toBeEnabled();
    expect(location.pathname).toBe("/rooms/opens/design/edit");
  });

  it("takes the room out of the sidebar when the answer comes after the page was left, staying where you are", async () => {
    confirmed(true);
    const answer = holdChange(openSettings(), "DELETE");
    const { onLeft, user, unmount } = showPage(design);
    await user.click(await deleteButton());
    unmount();
    history.replaceState(null, "", "/rooms/random");
    await answer(deleted());
    expect(onLeft).toHaveBeenCalledWith(design.id);
    expect(location.pathname).toBe("/rooms/random");
  });
});

describe("Leave a private room", () => {
  const leaveButton = () => screen.findByRole("button", { name: "Leave Leads" });
  const confirmed = (answer: boolean) => vi.spyOn(window, "confirm").mockReturnValue(answer);
  const asMember: RoomSettings = { ...closedSettings, canAdminister: false, canChangeHuddles: false };

  it("offers Leave to someone in a private room they can't change, in its own panel", async () => {
    serve(asMember);
    showPage(leads);
    const button = await leaveButton();
    expect(button.querySelector("svg")).toHaveClass("iconoir-log-out");
    expect(button.closest("section")).not.toBe(screen.getByRole("heading", { level: 2, name: "Leads" }).closest("section"));
  });

  it("leaves once you confirm, taking the room out of the sidebar and going home", async () => {
    const confirm = confirmed(true);
    const answer = holdChange(asMember, "DELETE");
    const { onLeft, onMissing, user } = showPage(leads);
    await user.click(await leaveButton());
    expect(confirm).toHaveBeenCalledExactlyOnceWith(CONFIRM_LEAVE);
    expect(vi.mocked(fetch).mock.calls.at(-1)).toEqual(["/api/rooms/leads/membership", expect.objectContaining({ method: "DELETE" })]);
    expect(await leaveButton()).toBeDisabled();

    await answer(new Response(null, { status: 204 }));
    expect(onLeft).toHaveBeenCalledExactlyOnceWith(leads.id);
    expect(location.pathname).toBe("/");
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("leaves nothing unless you confirm", async () => {
    confirmed(false);
    serve(asMember);
    const { onLeft, user } = showPage(leads);
    await user.click(await leaveButton());
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(onLeft).not.toHaveBeenCalled();
    expect(await leaveButton()).toBeEnabled();
  });

  it("says why the room wasn't left, and lets you try again", async () => {
    confirmed(true);
    const answer = holdChange(asMember, "DELETE");
    const { onLeft, onFailed, user } = showPage(leads);
    await user.click(await leaveButton());
    await answer(Response.json({ error: "Nobody else could open this room, so you can't leave it" }, { status: 403 }));
    expect(onFailed).toHaveBeenCalledOnce();
    expect(onLeft).not.toHaveBeenCalled();
    expect(await leaveButton()).toBeEnabled();
  });

  it("offers no Leave to whoever can change the room, whose switches take them out", async () => {
    serve(closedSettings);
    showPage(leads);
    await screen.findByRole("button", { name: "Delete Leads" });
    expect(screen.queryByRole("button", { name: /^Leave/ })).not.toBeInTheDocument();
  });

  it("offers no Leave in an open room", async () => {
    serve(openSettings(false));
    showPage(design);
    await screen.findByRole("heading", { level: 2, name: "Design" });
    expect(screen.queryByRole("button", { name: /^Leave/ })).not.toBeInTheDocument();
  });

  it("offers Leave when it lists nobody else in the room, leaving it to the server to count someone suspended", async () => {
    serve({ ...asMember, people: asMember.people.map((person) => ({ ...person, member: person.id === ada.id })) });
    showPage(leads);
    expect(await leaveButton()).toBeEnabled();
  });
});

describe("Unsaved changes guard", () => {
  it("asks before leaving a change, and not once it's undone", async () => {
    serve(openSettings());
    const { user } = showPage(design);
    await user.type(await roomName(), " team");
    act(() => navigate("/rooms/general"));
    expect(await screen.findByRole("dialog", { name: "Unsaved Changes" })).toBeInTheDocument();
    expect(location.pathname).toBe("/rooms/opens/design/edit");

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(asking()).not.toBeInTheDocument());
    await user.clear(await roomName());
    await user.type(await roomName(), "Design");
    act(() => navigate("/rooms/general"));
    expect(location.pathname).toBe("/rooms/general");
    expect(asking()).not.toBeInTheDocument();
  });

  it("counts a private room's people as changes, and the Everyone switch, which moves to the other form without asking", async () => {
    serve(closedSettings);
    const { user } = showPage(leads);
    await user.click(await screen.findByRole("switch", { name: `Give ${grace.name} access to this room` }));
    act(() => navigate("/rooms/general"));
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    await user.click(accessSwitch(grace));

    await user.click(screen.getByRole("switch", { name: "Give everyone access to this room" }));
    expect(location.pathname).toBe("/rooms/opens/leads/edit");
    expect(asking()).not.toBeInTheDocument();
    act(() => navigate("/rooms/general"));
    expect(await screen.findByRole("dialog", { name: "Unsaved Changes" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));

    await user.click(screen.getByRole("switch", { name: "Give only some access to this room" }));
    act(() => navigate("/rooms/general"));
    expect(location.pathname).toBe("/rooms/general");
  });

  it("takes the form the address names as the form opened", async () => {
    serve(openSettings());
    showPage(design, "/rooms/closeds/design/edit");
    await roomName();
    act(() => navigate("/rooms/general"));
    expect(location.pathname).toBe("/rooms/general");
    expect(asking()).not.toBeInTheDocument();
  });

  it("saves the changes from the dialog, then goes where you were going", async () => {
    const saved = { ...design, name: "Design team" };
    serve(openSettings(), { saved });
    const { onSaved, user } = showPage(design);
    await user.type(await roomName(), " team");
    act(() => navigate("/account/edit"));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(location.pathname).toBe("/account/edit"));
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(saved);
    expect(sent()).toEqual({ name: "Design team", icon: "", kind: "open" });
  });

  it("takes a room saved from the dialog without you out of the sidebar, going where you were going", async () => {
    serve(closedSettings, { saved: leads });
    const { onLeft, onMissing, onSaved, user } = showPage(leads);
    await user.click(await screen.findByRole("switch", { name: `Give ${ada.name} access to this room` }));
    act(() => navigate("/rooms/general"));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(location.pathname).toBe("/rooms/general"));
    expect(onLeft).toHaveBeenCalledExactlyOnceWith(leads.id);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("compares the form with what the dialog saved, should the page stay, as it does when signing out fails", async () => {
    const saved: Room = { ...leads, kind: "open", name: "Leads team" };
    serve(closedSettings, { saved });
    const { user } = showPage(leads);
    await user.type(await roomName(), " team");
    await user.click(screen.getByRole("switch", { name: "Give everyone access to this room" }));
    const signOut = vi.fn(async () => false);
    act(() => leave(signOut));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    expect(sent()).toEqual({ name: "Leads team", icon: "lock", kind: "open" });

    act(() => leave(signOut));
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(asking()).not.toBeInTheDocument();
    await user.type(await roomName(), "s");
    act(() => navigate("/rooms/general"));
    expect(await screen.findByRole("dialog", { name: "Unsaved Changes" })).toBeInTheDocument();
    expect(location.pathname).toBe("/rooms/opens/leads/edit");
  });

  it("says when the dialog couldn't save the changes, staying on the page", async () => {
    serve(openSettings(), { refusal: { status: 422, error: "Name must be 1 to 100 characters" } });
    const { onFailed, user } = showPage(design);
    await user.type(await roomName(), " team");
    act(() => navigate("/rooms/general"));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your changes couldn’t be saved.");
    expect(location.pathname).toBe("/rooms/opens/design/edit");
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("doesn't ask when the room's deleted, which Delete asks about itself", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const answer = holdChange(openSettings(), "DELETE");
    const { user } = showPage(design);
    await user.type(await roomName(), " team");
    await user.click(screen.getByRole("button", { name: "Delete Design" }));
    await answer(new Response(null, { status: 204 }));
    expect(location.pathname).toBe("/");
    expect(asking()).not.toBeInTheDocument();
  });
});
