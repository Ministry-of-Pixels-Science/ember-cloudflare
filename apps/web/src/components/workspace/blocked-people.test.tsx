import type { DirectoryUser, User } from "@ember/protocol";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BlockingContext } from "@/hooks/use-blocking";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { BLOCKED_PEOPLE_EXPLAINED, BlockedPeople } from "./blocked-people";

/** Someone as the people directory lists them. */
const listed = (id: string, name: string, changes: Partial<DirectoryUser> = {}): DirectoryUser => ({ id, name, bio: null, role: "member", status: "active", avatarUrl: `/users/${id}/avatar`, ...changes });

const grace = listed("u2", "Grace Hopper");
const alan = listed("u3", "alan turing");
const bender = listed("u4", "Bender", { role: "bot" });
const directory: People = new Map([grace, alan, bender].map((person) => [person.id, person]));

/** The section as someone who has blocked `blocked` sees it, with the people directory listing `people`. */
function show(blocked: string[], { people = directory, changed = async () => true }: { people?: People; changed?: () => Promise<boolean> } = {}) {
  const setBlocked = vi.fn<(person: User, blocked: boolean) => Promise<boolean>>(changed);
  const view = (blockedNow: string[], peopleNow: People) => (
    <PeopleContext value={peopleNow}>
      <BlockingContext value={{ blocked: new Set(blockedNow), setBlocked }}>
        <BlockedPeople />
      </BlockingContext>
    </PeopleContext>
  );
  const { rerender } = render(view(blocked, people));
  return { setBlocked, user: userEvent.setup(), rerender: (blockedNow: string[], peopleNow = people) => rerender(view(blockedNow, peopleNow)) };
}

const section = () => screen.queryByRole("region", { name: "Blocked people" });
const rows = () => within(section()!).getAllByRole("listitem");

describe("Blocked people on your profile", () => {
  it("lists whom you've blocked by name, as settings list people, each a link to their page with Unblock", () => {
    show([grace.id, bender.id, alan.id]);
    expect(section()).toHaveTextContent(BLOCKED_PEOPLE_EXPLAINED);
    // Compared as SQLite compares LOWER(name).
    expect(rows().map((row) => row.textContent)).toEqual(["alan turingUnblock", "BenderUnblock", "Grace HopperUnblock"]);
    expect(within(rows()[2]!).getByRole("link", { name: "Grace Hopper" })).toHaveAttribute("href", "/users/u2");
    expect(rows()[2]!.querySelector("img")).toHaveAttribute("src", grace.avatarUrl);
    expect(within(rows()[2]!).getByRole("button", { name: "Unblock Grace Hopper" })).toBeEnabled();
  });

  it("shows nothing while you've blocked nobody the people directory lists", () => {
    const { rerender } = show([]);
    expect(section()).toBeNull();
    rerender([grace.id], new Map());
    expect(section()).toBeNull();
    rerender([grace.id], directory);
    expect(rows()).toHaveLength(1);
  });

  it("unblocks someone, waiting for the answer before another click, and lists them no longer once the sidebar hears", async () => {
    let answer: (done: boolean) => void = () => {};
    const { setBlocked, user, rerender } = show([grace.id, alan.id], { changed: () => new Promise((resolve) => (answer = resolve)) });
    await user.click(screen.getByRole("button", { name: "Unblock Grace Hopper" }));
    expect(setBlocked).toHaveBeenCalledExactlyOnceWith(grace, false);
    expect(screen.getByRole("button", { name: "Unblock Grace Hopper" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unblock alan turing" })).toBeDisabled();

    rerender([alan.id]);
    await act(async () => answer(true));
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Unblock alan turing" })).toBeEnabled();
  });

  it("lets you try again once unblocking fails", async () => {
    const { setBlocked, user } = show([grace.id], { changed: async () => false });
    await user.click(screen.getByRole("button", { name: "Unblock Grace Hopper" }));
    expect(screen.getByRole("button", { name: "Unblock Grace Hopper" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Unblock Grace Hopper" }));
    expect(setBlocked).toHaveBeenCalledTimes(2);
  });
});
