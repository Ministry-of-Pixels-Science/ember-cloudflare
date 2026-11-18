import type { DirectoryUser, Room } from "@ember/protocol";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeopleContext } from "@/hooks/use-directory";
import { INVITATION_RINGS_MS, type HuddleInvitation } from "@/lib/huddle-invitations";
import { ringForHuddle } from "@/lib/huddle-ring";
import { HuddleInvitations } from "./huddle-invitations";

/** Stops the ring that `ringForHuddle` started. */
const stopRinging = vi.fn();
vi.mock("@/lib/huddle-ring", () => ({ ringForHuddle: vi.fn(() => stopRinging) }));

const person = (id: string, name: string): DirectoryUser => ({ id, name, bio: null, role: "member", status: "active", avatarUrl: `/users/${id}/avatar` });
const PEOPLE = new Map([person("priya", "Priya Patel"), person("sam", "Sam Rivera")].map((listed) => [listed.id, listed]));
/** Ada's direct message with Priya, named there as she was when it started, and a room they're both in. */
const direct: Room = { id: "direct-1", kind: "direct", members: [{ id: "ada", name: "Ada Lovelace" }, { id: "priya", name: "Priya P." }], activeAt: "2026-11-16T09:00:00.000Z" };
const launch: Room = { id: "launch", name: "Launch", kind: "open", icon: null };
const ROOMS = [direct, launch];
/** When the tests' clock starts. */
const NOW = Date.parse("2026-11-16T09:00:00.000Z");
const from = (by: string, roomId = "direct-1", at = NOW): HuddleInvitation => ({ roomId, by, at, listed: true, live: false });

const [onJoin, onDecline, onUnanswered] = [vi.fn(), vi.fn(), vi.fn()];

function renderInvitations(invitations: HuddleInvitation[], { quiet = false, rooms = ROOMS, people = PEOPLE } = {}) {
  const page = (shown: HuddleInvitation[], silent = quiet) => (
    <PeopleContext value={people}>
      <HuddleInvitations invitations={shown} rooms={rooms} quiet={silent} onJoin={onJoin} onDecline={onDecline} onUnanswered={onUnanswered} />
    </PeopleContext>
  );
  const view = render(page(invitations));
  return { ...view, show: (shown: HuddleInvitation[], silent?: boolean) => view.rerender(page(shown, silent)) };
}

const card = (name: string) => screen.getByRole("group", { name });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("An invitation into a huddle", () => {
  it("says who invites, as the people directory names them now, over Decline and Join", () => {
    renderInvitations([from("priya")]);
    const invitation = card("Priya Patel invites you to a huddle");
    // Read out as it comes, in the words the eye reads.
    expect(within(invitation).getByRole("alert")).toHaveTextContent(/^Priya Patelinvites you to a huddle$/);
    expect(within(invitation).getAllByRole("button").map((button) => button.textContent)).toEqual(["Decline", "Join"]);
    expect(screen.getByRole("region", { name: "Huddle invitations" })).toContainElement(invitation);
    // What its person is doing keeps the focus.
    expect(document.body).toHaveFocus();
  });

  it("names the room of a shared room's huddle", () => {
    renderInvitations([from("sam", "launch")]);
    expect(card("Sam Rivera invites you to a huddle in Launch")).toBeInTheDocument();
  });

  it("names whoever invites as their direct message does until the directory lists them, and as someone where nothing knows them", () => {
    const { show } = renderInvitations([from("priya")], { people: new Map() });
    expect(card("Priya P. invites you to a huddle")).toBeInTheDocument();
    show([from("stranger", "launch")]);
    expect(card("Someone invites you to a huddle in Launch")).toBeInTheDocument();
  });

  it("says who invites into a room that isn't among this person's rooms yet, as one made while the tab wasn't connected", () => {
    renderInvitations([{ ...from("priya", "direct-9"), listed: false }]);
    const invitation = within(card("Priya Patel invites you to a huddle"));
    fireEvent.click(invitation.getByRole("button", { name: "Join" }));
    expect(onJoin).toHaveBeenCalledExactlyOnceWith("direct-9");
  });

  it("joins or declines the huddle of its room, each by its own invitation's buttons", () => {
    renderInvitations([from("priya"), from("sam", "launch")]);
    const sams = within(card("Sam Rivera invites you to a huddle in Launch"));
    fireEvent.click(sams.getByRole("button", { name: "Join" }));
    expect(onJoin).toHaveBeenCalledExactlyOnceWith("launch");
    fireEvent.click(sams.getByRole("button", { name: "Decline" }));
    expect(onDecline).toHaveBeenCalledExactlyOnceWith("launch");
    fireEvent.click(within(card("Priya Patel invites you to a huddle")).getByRole("button", { name: "Decline" }));
    expect(onDecline).toHaveBeenLastCalledWith("direct-1");
    expect(onUnanswered).not.toHaveBeenCalled();
  });

  it("gives up once it has rung for half a minute since it came, unanswered", () => {
    // One that came five seconds before the page showed it.
    renderInvitations([from("priya", "direct-1", NOW - 5_000)]);
    act(() => void vi.advanceTimersByTime(INVITATION_RINGS_MS - 5_001));
    expect(onUnanswered).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onUnanswered).toHaveBeenCalledExactlyOnceWith("direct-1");
  });

  it("is read out again, and rings its own half minute, when it takes the place of one before it for the same room", () => {
    const { show } = renderInvitations([from("priya")]);
    const earlier = card("Priya Patel invites you to a huddle");
    act(() => void vi.advanceTimersByTime(20_000));
    show([from("priya", "direct-1", NOW + 20_000)]);
    // A card of its own, which a screen reader reads out as it did the one before.
    expect(card("Priya Patel invites you to a huddle")).not.toBe(earlier);
    act(() => void vi.advanceTimersByTime(INVITATION_RINGS_MS - 1));
    expect(onUnanswered).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onUnanswered).toHaveBeenCalledExactlyOnceWith("direct-1");
  });

  it("gives up on nothing that's gone by then", () => {
    const { unmount } = renderInvitations([from("priya")]);
    unmount();
    act(() => void vi.advanceTimersByTime(INVITATION_RINGS_MS));
    expect(onUnanswered).not.toHaveBeenCalled();
  });
});

describe("The invitations' ring", () => {
  it("is one for them all, from the first to come until the last is gone", () => {
    const { show, unmount } = renderInvitations([from("priya")]);
    expect(ringForHuddle).toHaveBeenCalledTimes(1);
    show([from("priya"), from("sam", "launch")]);
    show([from("sam", "launch")]);
    expect(ringForHuddle).toHaveBeenCalledTimes(1);
    expect(stopRinging).not.toHaveBeenCalled();
    unmount();
    expect(stopRinging).toHaveBeenCalledTimes(1);
  });

  it("stays silent for someone in a huddle already, and stops once they join one", () => {
    const { show } = renderInvitations([from("priya")], { quiet: true });
    expect(ringForHuddle).not.toHaveBeenCalled();
    show([from("priya")], false);
    expect(ringForHuddle).toHaveBeenCalledTimes(1);
    show([from("priya")], true);
    expect(stopRinging).toHaveBeenCalledTimes(1);
  });
});
