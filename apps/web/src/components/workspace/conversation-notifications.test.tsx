import type { Me, SidebarRoom, User } from "@ember/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleContext, type People } from "@/hooks/use-directory";
import type { DirectSidebarRoom } from "@/lib/room-list";
import { ConversationNotifications } from "./conversation-notifications";

const ada: Me = { id: "ada", name: "Ada Lovelace", administrator: false };
const [grace, linus]: User[] = [
  { id: "grace", name: "Grace Hopper" },
  { id: "linus", name: "Linus" },
];
const asAda = { id: ada.id, name: ada.name };

const room = (id: string, name: string, involvement: SidebarRoom["involvement"] = "mentions"): SidebarRoom => ({ id, name, kind: "open", icon: null, unread: false, involvement });
const direct = (id: string, members: User[], involvement: SidebarRoom["involvement"] = "everything"): DirectSidebarRoom => ({
  id,
  kind: "direct",
  members: [asAda, ...members],
  activeAt: "2026-10-16T12:00:00.000Z",
  unread: false,
  involvement,
});

function renderList(rooms: SidebarRoom[], people: People = new Map()) {
  const [answered, onFailed] = [vi.fn(), vi.fn()];
  const view = render(
    <PeopleContext value={people}>
      <ConversationNotifications me={ada} rooms={rooms} askForRoom={() => answered} onFailed={onFailed} />
    </PeopleContext>,
  );
  return { ...view, answered, onFailed };
}

const list = () => screen.getByRole("list", { name: "Conversation notifications" });
/** Each row's name and what its bell says, top to bottom, with "—" for the rule between rooms and DMs. */
const rows = () =>
  [...list().children].map((row) => (row.tagName === "HR" ? "—" : `${within(row as HTMLElement).getByRole("link").textContent}: ${within(row as HTMLElement).getByRole("checkbox").textContent}`));

afterEach(() => vi.restoreAllMocks());

describe("Levels on your profile", () => {
  it("lists your rooms by name, ignoring the case of A to Z, then a rule, then your DMs in the order they were made", () => {
    renderList([room("r1", "zebra"), direct("d2", [linus!, grace!]), room("r2", "Éclair"), room("r3", "Apple"), direct("d1", []), room("r4", "banana", "nothing")]);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Conversation notifications");
    expect(rows()).toEqual([
      "Apple: Notifying about @ mentions",
      "banana: Notifications are off",
      "zebra: Notifying about @ mentions",
      // SQLite's LOWER() leaves É as it is, after the letters A to Z.
      "Éclair: Notifying about @ mentions",
      "—",
      "Linus and Grace Hopper: Notifying about all messages",
      "Ada Lovelace: Notifying about all messages",
    ]);
  });

  it("compares names as SQLite does, by code point, so an emoji comes after a full-width letter", () => {
    renderList([room("r1", "😀 party"), room("r2", "Ａ team"), room("r3", "zebra")]);
    expect(within(list()).getAllByRole("link").map((link) => link.textContent)).toEqual(["zebra", "Ａ team", "😀 party"]);
  });

  it("orders rooms with the same name by id", () => {
    renderList([room("r2", "design"), room("r1", "Design")]);
    expect(within(list()).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/rooms/r1", "/rooms/r2"]);
  });

  it("has no rule when there are only rooms, or only DMs", () => {
    const { unmount } = renderList([room("r1", "design")]);
    expect(rows()).toEqual(["design: Notifying about @ mentions"]);
    unmount();
    renderList([direct("d1", [grace!])]);
    expect(rows()).toEqual(["Grace Hopper: Notifying about all messages"]);
  });

  it("leaves out the DM that welcomed you until a message comes in it, as the sidebar does, but lists the ones you welcomed someone in", () => {
    /** `dm`, started as `userId` joined, as it started. */
    const joined = (dm: DirectSidebarRoom, userId: string): DirectSidebarRoom => ({ ...dm, joined: { userId, at: "2026-10-16T12:00:00.000Z" } });
    const welcomed = joined(direct("d1", [grace!]), ada.id);
    const { unmount } = renderList([room("r1", "design"), welcomed, joined(direct("d2", [linus!]), linus!.id)]);
    expect(rows()).toEqual(["design: Notifying about @ mentions", "—", "Linus: Notifying about all messages"]);
    unmount();
    renderList([{ ...welcomed, activeAt: "2026-10-16T12:05:00.000Z" }]);
    expect(rows()).toEqual(["Grace Hopper: Notifying about all messages"]);
  });

  it("names a DM's people as the directory lists them now", () => {
    renderList([direct("d1", [grace!])], new Map([[grace!.id, { ...grace!, name: "Grace B. Hopper", bio: null, role: "member", status: "active", avatarUrl: "/users/grace/avatar" }]]));
    expect(rows()).toEqual(["Grace B. Hopper: Notifying about all messages"]);
  });

  it("links each to its room, in a pill whose taps reach 44px on touch screens, before a dashed line and its bell in a round button", () => {
    renderList([room("r1", "design"), direct("d1", [grace!])]);
    const [roomRow] = within(list()).getAllByRole("listitem");
    expect(within(roomRow!).getByRole("link")).toHaveAttribute("href", "/rooms/r1");
    expect(within(roomRow!).getByRole("link")).toHaveClass("rounded-full", "border", "bg-surface", "touch:after:-inset-y-2.5");
    expect(within(roomRow!).getByText("design")).toHaveClass("truncate");
    expect(roomRow!.querySelector("hr")).toHaveClass("border-dashed");
    expect(within(roomRow!).getByRole("checkbox")).toHaveClass("rounded-full", "border", "size-9");
    expect(within(roomRow!).getByRole("checkbox").parentElement).toHaveClass("text-[0.8rem]");
  });

  it("dims a room you've hidden, which it lists for you to show again", () => {
    renderList([room("r1", "design", "invisible"), room("r2", "ops")]);
    const [hidden, shown] = within(list()).getAllByRole("listitem");
    expect(hidden).toHaveClass("opacity-50");
    expect(within(hidden!).getByRole("checkbox")).toHaveAccessibleName("Notifications are off and room invisible in sidebar");
    expect(shown).not.toHaveClass("opacity-50");
  });

  it("hands on the level a bell saves, and why it couldn't", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ involvement: "nothing" }));
    const { answered, onFailed } = renderList([room("r1", "design"), direct("d1", [grace!])]);
    await userEvent.click(screen.getByRole("checkbox", { name: "Notifying about all messages" }));
    expect(vi.mocked(fetch).mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([["/api/rooms/d1/involvement", "PUT", JSON.stringify({ involvement: "nothing" })]]);
    expect(answered).toHaveBeenCalledWith({ type: "involved", roomId: "d1", involvement: "nothing" });

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Room not found or inaccessible" }, { status: 404 }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Notifying about @ mentions" }));
    expect(onFailed).toHaveBeenCalledOnce();
  });
});
