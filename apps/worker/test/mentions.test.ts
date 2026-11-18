import type { Directory } from "@ember/protocol";
import { mentionPromptItem } from "@ember/richtext";
import { beforeEach, describe, expect, it } from "vitest";
import { api, createRoom, freshDeploy, signIn, workspaceSql, type Session } from "./support";

beforeEach(freshDeploy);

/** What the mentions prompt answers `viewer`, asked with `query`. */
const prompt = (viewer: Session | null, query = "") =>
  api(`/api/autocompletable/users${query}`, { headers: viewer ? { Cookie: viewer.cookie } : {} });

/** The names of the people the mentions prompt offers `viewer`, in order. */
async function offered(viewer: Session, query = ""): Promise<string[]> {
  const response = await prompt(viewer, query);
  expect(response.status, await response.clone().text()).toBe(200);
  return [...(await response.text()).matchAll(/<lexxy-prompt-item search="([^"]*)"/g)].map((match) => match[1]!);
}

describe("@-mention people", () => {
  it("offers the room's active members whose names contain what's typed, by name, bots and you included", async () => {
    const ada = await signIn("Ada Lovelace");
    const grace = await signIn("grace Hopper");
    const alan = await signIn("Alan Turing");
    const bot = await signIn("Bender Bot");
    const katherine = await signIn("Katherine Johnson");
    await signIn("Not In The Room");
    await workspaceSql("UPDATE users SET role = 2 WHERE id = ?", bot.user.id);
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id, alan.user.id, bot.user.id, katherine.user.id], as: ada });
    await workspaceSql("UPDATE users SET status = 1 WHERE id = ?", katherine.user.id);
    const inRoom = `?room_id=${room.id}`;

    expect(await offered(ada, inRoom)).toEqual(["Ada Lovelace", "Alan Turing", "Bender Bot", "grace Hopper"]);
    expect(await offered(ada, `${inRoom}&filter=`)).toEqual(["Ada Lovelace", "Alan Turing", "Bender Bot", "grace Hopper"]);
    expect(await offered(ada, `${inRoom}&filter=AL`)).toEqual(["Alan Turing"]);
    expect(await offered(ada, `${inRoom}&filter=o`)).toEqual(["Ada Lovelace", "Bender Bot", "grace Hopper"]);
    expect(await offered(ada, `${inRoom}&filter=zz`)).toEqual([]);
    // The DM picker searches with `query`, which a blank `filter` leaves to.
    expect(await offered(ada, `${inRoom}&filter=%20&query=hop`)).toEqual(["grace Hopper"]);
    // `LIKE`: a wildcard is a wildcard.
    expect(await offered(ada, `${inRoom}&filter=a_l`)).toEqual(["Ada Lovelace"]);
  });

  it("offers people whose usernames start with what's typed too, by name", async () => {
    const ada = await signIn("Ada Lovelace");
    const grace = await signIn("Grace Hopper");
    await signIn("Zing Zhao");
    await workspaceSql("UPDATE users SET username = 'amazing.grace' WHERE id = ?", grace.user.id);
    await workspaceSql("UPDATE users SET username = 'countess' WHERE id = ?", ada.user.id);
    expect(await offered(ada, "?filter=amaz")).toEqual(["Grace Hopper"]);
    expect(await offered(ada, "?filter=COUNT")).toEqual(["Ada Lovelace"]);
    // Not the middle of one, which names more people than it finds.
    expect(await offered(ada, "?filter=zing")).toEqual(["Zing Zhao"]);
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    expect(await offered(ada, `?room_id=${room.id}&filter=amazing.`)).toEqual(["Grace Hopper"]);
  });

  it("shows each one's username in their prompt item", async () => {
    const ada = await signIn("Ada Lovelace");
    await workspaceSql("UPDATE users SET username = 'countess' WHERE id = ?", ada.user.id);
    const { users } = (await (await api("/api/users", { headers: { Cookie: ada.cookie } })).json()) as Directory;
    const listed = users.find((user) => user.id === ada.user.id)!;
    expect(listed.username).toBe("countess");
    expect(await (await prompt(ada, "?filter=countess")).text()).toBe(mentionPromptItem({ ...ada.user, username: "countess", avatarUrl: listed.avatarUrl }));
  });

  it("offers anyone active without a room, or with a blank one", async () => {
    const ada = await signIn("Ada Lovelace");
    const grace = await signIn("Grace Hopper");
    await workspaceSql("UPDATE users SET status = 2 WHERE id = ?", grace.user.id);
    await createRoom("Somewhere");
    expect(await offered(ada)).toEqual(["Ada Lovelace", "Host"]);
    expect(await offered(ada, "?room_id=%20&filter=h")).toEqual(["Host"]);
  });

  it("offers the first 20, as Lexxy asks for no more", async () => {
    const ada = await signIn("Ada");
    for (let n = 1; n <= 21; n++) await signIn(`Person ${String(n).padStart(2, "0")}`);
    const names = await offered(ada, "?filter=person");
    expect(names).toHaveLength(20);
    expect(names.at(-1)).toBe("Person 20");
  });

  it("writes each as Lexxy's prompt items, with the avatar the people directory gives", async () => {
    const ada = await signIn(`Ada "<Lovelace>"`);
    const response = await prompt(ada);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { users } = (await (await api("/api/users", { headers: { Cookie: ada.cookie } })).json()) as Directory;
    const { avatarUrl } = users.find((user) => user.id === ada.user.id)!;
    expect(await response.text()).toBe(mentionPromptItem({ ...ada.user, avatarUrl }));
  });

  it("refuses a room you aren't in, or that doesn't exist, and anyone signed out", async () => {
    const ada = await signIn("Ada");
    const grace = await signIn("Grace");
    const room = await createRoom("Leads", { closedTo: [grace.user.id], as: grace });
    for (const roomId of [room.id, "0000000000000000", "not-a-room"]) {
      const response = await prompt(ada, `?room_id=${roomId}`);
      expect(response.status, roomId).toBe(404);
      expect(await response.json()).toEqual({ error: "Room not found or inaccessible" });
    }
    expect((await prompt(null, `?room_id=${room.id}`)).status).toBe(401);
  });
});
