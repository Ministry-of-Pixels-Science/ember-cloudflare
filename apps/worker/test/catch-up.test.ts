import type { Message } from "@ember/protocol";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CHANGES_KEPT, DELETION_OF, LATEST_CHANGE, MESSAGES_CHANGED_SINCE, MESSAGES_DELETED_SINCE } from "../src/store";
import { connect, freshRoom, post, reconnect, roomSql, roomStub, signIn, type Socket } from "./support";

/** Posts a message as `client` and answers it with the change's number. */
async function posted(client: Socket, body: string): Promise<{ message: Message; seq: number }> {
  const clientMessageId = crypto.randomUUID();
  client.send({ type: "message.create", clientMessageId, body });
  for (;;) {
    const frame = await client.next("message.created");
    if (frame.message.clientMessageId === clientMessageId) return frame;
  }
}

/** Posts `count` messages as `client`, one after another. */
async function postMany(client: Socket, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await post(client, `Message ${i + 1}`);
}

/** Deletes a message as `client` and answers the change's number. */
async function deleted(client: Socket, messageId: string): Promise<number> {
  client.send({ type: "message.delete", messageId });
  return (await client.next("message.deleted")).seq;
}

const planOf = async (room: string, query: string, ...params: Array<string | number>) =>
  (await roomSql(room, `EXPLAIN QUERY PLAN ${query}`, ...params)).map((row) => (row as { detail: string }).detail).join("; ");

describe("Catch up after a reconnect", () => {
  it("numbers each change to the room's messages in the frame that announces it, and opens sockets with the latest", async () => {
    const room = await freshRoom("numbered");
    const ada = await connect(room, "Ada");
    expect(ada.welcome.seq).toBe(0);

    const { message, seq } = await posted(ada, "First");
    expect(seq).toBe(1);
    ada.send({ type: "message.update", messageId: message.id, body: "First, edited" });
    expect((await ada.next("message.updated")).seq).toBe(2);
    ada.send({ type: "boost.create", messageId: message.id, content: "👍" });
    const { boost, seq: boosted } = await ada.next("boost.created");
    expect(boosted).toBe(3);
    ada.send({ type: "boost.delete", boostId: boost.id });
    expect((await ada.next("boost.deleted")).seq).toBe(4);
    ada.send({ type: "message.delete", messageId: message.id });
    expect((await ada.next("message.deleted")).seq).toBe(5);

    expect((await connect(room, ada.session)).welcome.seq).toBe(5);
  });

  it("sends a tab that connects again what changed since the latest change it saw, deletions included, rather than the newest page", async () => {
    const room = await freshRoom("resumed");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const [first, second, third] = [await post(ada, "One"), await post(ada, "Two"), await post(ada, "Three")];
    // Grace's tab hears of all three before its connection drops.
    let seen = 0;
    for (let i = 0; i < 3; i++) seen = (await grace.next("message.created")).seq;
    grace.close();

    ada.send({ type: "message.update", messageId: first.id, body: "One, edited" });
    await ada.next("message.updated");
    ada.send({ type: "message.delete", messageId: second.id });
    await ada.next("message.deleted");
    ada.send({ type: "boost.create", messageId: third.id, content: "🎉" });
    await ada.next("boost.created");
    const fourth = await post(ada, "Four");
    const fleeting = await post(ada, "Here and gone");
    ada.send({ type: "message.delete", messageId: fleeting.id });
    await ada.next("message.deleted");

    const back = await reconnect(room, grace.session, seen);
    expect(back.opening).toEqual({
      type: "resumed",
      you: grace.me,
      messages: [
        { ...first, body: "One, edited", plainText: "One, edited", updatedAt: expect.any(String), editedAt: expect.any(String) },
        { ...third, boosts: [expect.objectContaining({ content: "🎉", booster: ada.me })] },
        fourth,
      ],
      // One made and deleted since is among the deleted alone.
      deletedIds: [second.id, fleeting.id],
      present: expect.arrayContaining([ada.me, grace.me]),
      seq: 9,
    });
  });

  it("sends nothing new to a tab that has seen the latest change", async () => {
    const room = await freshRoom("up-to-date");
    const ada = await connect(room, "Ada");
    const { seq } = await posted(ada, "Hello");
    const back = await reconnect(room, ada.session, seq);
    expect(back.opening).toEqual({ type: "resumed", you: ada.me, messages: [], deletedIds: [], present: [ada.me], seq });
  });

  it(`catches a tab up on the latest ${CHANGES_KEPT} changes, and sends one further behind, or ahead of the room, the newest page instead`, async () => {
    const room = await freshRoom("far-behind");
    const ada = await connect(room, "Ada");
    await postMany(ada, CHANGES_KEPT + 1);

    const caughtUp = await reconnect(room, ada.session, 1);
    expect(caughtUp.opening.type).toBe("resumed");
    expect(caughtUp.opening.messages).toHaveLength(CHANGES_KEPT);

    const behind = await reconnect(room, ada.session, 0);
    expect(behind.opening).toMatchObject({ type: "welcome", hasMore: true, seq: CHANGES_KEPT + 1 });
    // A number the room hasn't reached yet is one it can't vouch for.
    const ahead = await reconnect(room, ada.session, CHANGES_KEPT + 2);
    expect(ahead.opening).toMatchObject({ type: "welcome", seq: CHANGES_KEPT + 1 });
  });

  it(`keeps a deleted message's id while a tab could still ask for it, within the latest ${CHANGES_KEPT} changes`, async () => {
    const room = await freshRoom("kept");
    const ada = await connect(room, "Ada");
    const deletions = () => roomSql(room, "SELECT seq, message_id AS messageId FROM message_deletions WHERE room_id = ? ORDER BY seq", room);
    const [first, second] = [await post(ada, "First"), await post(ada, "Second")];
    expect(await deleted(ada, first.id)).toBe(3);
    await postMany(ada, CHANGES_KEPT - 2);
    expect(await deleted(ada, second.id)).toBe(CHANGES_KEPT + 2);
    expect(await deletions()).toEqual([
      { seq: 3, messageId: first.id },
      { seq: CHANGES_KEPT + 2, messageId: second.id },
    ]);

    // A tab that hasn't heard of the first deletion is now more than CHANGES_KEPT changes behind, so it goes.
    const last = await post(ada, "Last");
    await deleted(ada, last.id);
    expect(await deletions()).toEqual([
      { seq: CHANGES_KEPT + 2, messageId: second.id },
      { seq: CHANGES_KEPT + 4, messageId: last.id },
    ]);
  });

  it("goes on counting from its latest change after the room's object restarts", async () => {
    const room = await freshRoom("restarted");
    const ada = await connect(room, "Ada");
    await postMany(ada, 2);
    await evictDurableObject(roomStub(room));
    expect((await posted(ada, "After a restart")).seq).toBe(3);
  });

  it("counts each room's changes apart, and catches a tab up on its own room's alone", async () => {
    const [room, annex] = [await freshRoom("counted-apart"), await freshRoom("counted-apart-annex")];
    const ada = await signIn("Ada");
    const [inRoom, inAnnex] = [await connect(room, ada), await connect(annex, ada)];
    const { seq } = await posted(inRoom, "In the room");
    await postMany(inAnnex, 3);
    expect((await posted(inAnnex, "In the annex")).seq).toBe(4);

    expect((await reconnect(room, ada, seq)).opening).toMatchObject({ type: "resumed", messages: [], deletedIds: [], seq });
  });

  it("finds what changed through the messages' index by change and the deletions' key, however big the room", async () => {
    const room = await freshRoom("catch-up-plan");
    await connect(room, "Ada");
    const changed = await planOf(room, MESSAGES_CHANGED_SINCE, room, 0);
    expect(changed).toContain("SEARCH messages USING INDEX index_messages_on_room_id_and_change_seq (room_id=? AND change_seq>?)");
    expect(changed).not.toContain("TEMP B-TREE");
    expect(await planOf(room, MESSAGES_DELETED_SINCE, room, 0)).toMatch(/^SEARCH message_deletions USING (COVERING )?INDEX sqlite_autoindex_message_deletions_1 \(room_id=\? AND seq>\?\)$/);
    // One message's deletion is found among its room's, which are few, not among every room's.
    expect(await planOf(room, DELETION_OF, room, "a-message")).toMatch(/^SEARCH message_deletions USING (COVERING )?INDEX sqlite_autoindex_message_deletions_1 \(room_id=\?\)$/);
    const latest = await planOf(room, LATEST_CHANGE, room, room);
    expect(latest).toContain("SEARCH messages USING COVERING INDEX index_messages_on_room_id_and_change_seq (room_id=?)");
    expect(latest).toContain("SEARCH message_deletions USING COVERING INDEX sqlite_autoindex_message_deletions_1 (room_id=?)");
  });
});
