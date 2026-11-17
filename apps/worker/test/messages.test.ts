import { MAX_MESSAGE_HTML_LENGTH, MAX_MESSAGE_LENGTH, type NewWorkspace, type PersonRole, type UserId } from "@ember/protocol";
import { bodyFromPlainText, MENTION_CONTENT_TYPE, mentionSgid, OPENGRAPH_EMBED_CONTENT_TYPE, previewContent } from "@ember/richtext";
import { describe, expect, it } from "vitest";
import { MESSAGES_AFTER, MESSAGES_BEFORE, NEWEST_MESSAGES } from "../src/store";
import { api, connect, cookieOf, freshDeploy, freshRoom, post, roomSql, settle, shown, signIn, workspaceSql, type Session } from "./support";

/** Sets Ember up afresh, with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  await freshDeploy();
  const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Gives `userId` the role `role`, as the administrator `session`. */
async function changeRole(session: Session, userId: UserId, role: PersonRole): Promise<void> {
  const response = await api(`/api/account/users/${userId}`, { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify({ role }) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** A mention of `userId`, as Lexxy writes one. */
const mention = (userId: string) => `<action-text-attachment sgid="${mentionSgid(userId)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;

describe("Send a message", () => {
  it("delivers a message to everyone in the room, attributed to its sender", async () => {
    const room = await freshRoom("create");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");

    ada.send({ type: "message.create", clientMessageId: "c1", body: "<p>Hello, Grace</p>" });
    const { message } = await grace.next("message.created");
    expect(message).toMatchObject({
      clientMessageId: "c1",
      roomId: room,
      body: "<p>Hello, Grace</p>",
      plainText: "Hello, Grace",
      mentions: [],
      creator: ada.me,
      editedAt: null,
      boosts: [],
    });
    expect(message.updatedAt).toBe(message.createdAt);
    expect((await ada.next("message.created")).message).toEqual(message);
  });

  it("keeps messages, so people who join later see them", async () => {
    const room = await freshRoom("kept");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "Still here");
    ada.close();

    const grace = await connect(room, "Grace");
    expect(grace.welcome.messages).toEqual([message]);
  });

  it("gives later messages later ids, even when sent in a burst", async () => {
    const ada = await connect(await freshRoom("burst"), "Ada");
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await post(ada, `burst ${i}`)).id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(5);
  });

  it("keeps each room's messages to itself", async () => {
    const [first, second] = [await freshRoom("one"), await freshRoom("two")];
    const ada = await connect(first, "Ada");
    const grace = await connect(second, "Grace");
    await post(ada, "Only in the first room");
    await settle(ada, grace);

    expect(grace.pending("message.created")).toEqual([]);
    expect((await connect(second, "Linus")).welcome.messages).toEqual([]);
  });

  it(`refuses blank messages and messages over ${MAX_MESSAGE_LENGTH} characters, saying which message it refused`, async () => {
    const room = await freshRoom("refused");
    const ada = await connect(room, "Ada");
    for (const [clientMessageId, body] of [["blank", " \n "], ["empty", "<p><br></p>"], ["no text", "<p><img src='x.png'></p>"]] as const) {
      ada.send({ type: "message.create", clientMessageId, body });
      expect(await ada.next("error"), body).toEqual({ type: "error", message: "Your message is empty.", clientMessageId, failed: "message.create" });
    }
    ada.send({ type: "message.create", clientMessageId: "long", body: bodyFromPlainText("x".repeat(MAX_MESSAGE_LENGTH + 1)) });
    expect(await ada.next("error")).toMatchObject({ message: "Messages can be up to 10,000 characters.", clientMessageId: "long" });
    ada.send({ type: "message.create", clientMessageId: "huge", body: "x".repeat(MAX_MESSAGE_HTML_LENGTH + 1) });
    expect((await ada.next("error")).message).toBe("Unrecognized frame");

    // Its markup can be longer, as long as its text isn't.
    const formatted = await post(ada, `<p>${"<b>x</b>".repeat(MAX_MESSAGE_LENGTH)}</p>`);
    expect(formatted.plainText).toHaveLength(MAX_MESSAGE_LENGTH);
    const later = await connect(room, "Grace");
    expect(later.welcome.messages).toEqual([formatted]);
  });

  it("refuses a message it couldn't show, saying which", async () => {
    const ada = await connect(await freshRoom("unreadable"), "Ada");
    // A frame's worth that would parse into 95 MB: a title copied with the <b> each of 1,000 paragraphs reopens
    const copied = `<p><b title="${"x".repeat(95_000)}">a${"<p>b".repeat(1_000)}`;
    for (const body of ["<b>".repeat(401) + "deep", "<action-text-attachment></action-text-attachment>", copied]) {
      ada.send({ type: "message.create", clientMessageId: "c1", body });
      expect(await ada.next("error")).toEqual({ type: "error", message: "That message couldn't be saved.", clientMessageId: "c1", failed: "message.create" });
    }
    await settle(ada);
    expect(ada.pending("message.created")).toEqual([]);
  });

  it("answers frames it can't read with an error, and keeps the socket open", async () => {
    const ada = await connect(await freshRoom("garbage"), "Ada");
    for (const frame of ["not json", "null", JSON.stringify({ type: "message.create" }), JSON.stringify({ type: "nope" })]) {
      ada.sendRaw(frame);
      expect((await ada.next("error")).message).toBe("Unrecognized frame");
    }
    ada.sendRaw(new TextEncoder().encode("binary").buffer as ArrayBuffer);
    expect((await ada.next("error")).message).toBe("Unrecognized frame");
    await post(ada, "Still connected");
  });

  it("tells a tab running the app from before rich text to reload, and refuses its messages and edits", async () => {
    const room = await freshRoom("outdated");
    const ada = await connect(room, "Ada");
    const original = await post(ada, "<p>Mine</p>");
    const old = await connect(room, ada.session, "outdated");
    const reload = { type: "error", message: "Ember has been updated. Reload the page to keep chatting." };
    expect(await old.next("error")).toEqual(reload);

    // It sends what was typed as it was typed, which the room would read as markup.
    old.send({ type: "message.create", clientMessageId: "old", body: "<b>1</b> < 2 &amp; 3" });
    expect(await old.next("error")).toEqual({ ...reload, clientMessageId: "old", failed: "message.create" });
    old.send({ type: "message.update", messageId: original.id, body: "Changed" });
    expect(await old.next("error")).toEqual({ ...reload, failed: "message.update" });
    await settle(old, ada);
    expect(ada.pending("message.created")).toEqual([]);
    expect(ada.pending("message.updated")).toEqual([]);
    expect((await connect(room, "Grace")).welcome.messages).toEqual([original]);
  });
});

describe("Plain-text version of a message", () => {
  it("keeps each message's plain text, as Action Text writes it", async () => {
    const ada = await connect(await freshRoom("plain-text"), "Ada");
    expect((await post(ada, "<p>One</p><ul><li>Two</li><li>Three</li></ul>")).plainText).toBe("One\n\n• Two\n• Three");
  });
});

describe("How mentions look", () => {
  it("keeps whom a message mentions, named as they are now, and a mention of no one as ☒", async () => {
    const room = await freshRoom("mentions");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const nobody = "0000000000000000";
    const message = await post(ada, `<p>Hi ${mention(grace.me.id)}, ${mention(nobody)} and ${mention(grace.me.id)}</p>`);
    const stored = `<action-text-attachment content-type="${MENTION_CONTENT_TYPE}" sgid="${grace.me.id}"></action-text-attachment>`;
    expect(message).toMatchObject({ body: `<p>Hi ${stored}, ☒ and ${stored}</p>`, plainText: "Hi @Grace, ☒ and @Grace", mentions: [{ id: grace.me.id, name: "Grace" }] });
  });

  it("names the people a message mentions as they were when it was written, or not at all in a row from before", async () => {
    const room = await freshRoom("mention-names");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const message = await post(ada, `<p>Hi ${mention(grace.me.id)}</p>`);
    await workspaceSql("UPDATE users SET name = 'Grace Hopper' WHERE id = ?", grace.me.id);
    expect((await connect(room, "Linus")).welcome.messages.find(({ id }) => id === message.id)?.mentions).toEqual([{ id: grace.me.id, name: "Grace" }]);

    await roomSql(room, "UPDATE messages SET mentions = ? WHERE id = ?", JSON.stringify([grace.me.id]), message.id);
    expect((await connect(room, "Katherine")).welcome.messages.find(({ id }) => id === message.id)?.mentions).toEqual([{ id: grace.me.id, name: "" }]);
  });
});

/** `value` in an attribute, as the room writes it. */
const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

describe("Link previews in messages", () => {
  it("keeps a link preview as Lexxy writes the composer's, with the link's text, which is all of the plain text", async () => {
    const ada = await connect(await freshRoom("previews"), "Ada");
    const card = previewContent({ href: "https://basecamp.com/", url: "https://basecamp.com/og.png", filename: "Basecamp", description: "Calm & organized" });
    const link = '<p><a href="https://basecamp.com/">https://basecamp.com/</a></p>';
    const message = await post(ada, `${link}<action-text-attachment content="${attribute(card)}" content-type="${OPENGRAPH_EMBED_CONTENT_TYPE}"></action-text-attachment>`);
    const stored = `${link}<action-text-attachment content-type="${OPENGRAPH_EMBED_CONTENT_TYPE}" content="${attribute(card)}"></action-text-attachment>`;
    expect(message).toMatchObject({ body: stored, plainText: "https://basecamp.com/" });
    expect((await post(ada, stored)).body).toBe(stored);
  });

  it("refuses a preview Rails can't read, as it refuses other bodies it can't render", async () => {
    const ada = await connect(await freshRoom("unreadable-preview"), "Ada");
    ada.send({ type: "message.create", clientMessageId: "c1", body: `<action-text-attachment content-type="${OPENGRAPH_EMBED_CONTENT_TYPE}" href="mailto:nobody" filename="Mail"></action-text-attachment>` });
    expect(await ada.next("error")).toEqual({ type: "error", message: "That message couldn't be saved.", clientMessageId: "c1", failed: "message.create" });
  });
});

describe("Edit a message", () => {
  it("lets the author change a message, for everyone, and keeps the change", async () => {
    const room = await freshRoom("edit");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const original = await post(ada, "<p>Helo</p>");

    ada.send({ type: "message.update", messageId: original.id, body: "<p>Hello <em>all</em></p>" });
    const { message } = await grace.next("message.updated");
    expect(message).toMatchObject({ id: original.id, body: "<p>Hello <em>all</em></p>", plainText: "Hello all", creator: ada.me, createdAt: original.createdAt });
    expect(message.updatedAt >= original.createdAt).toBe(true);
    expect(message.editedAt).toBe(message.updatedAt);
    expect((await ada.next("message.updated")).message).toEqual(message);

    const later = await connect(room, "Linus");
    expect(later.welcome.messages).toEqual([message]);
  });

  it("leaves a message saved as it was as it was, its update time included", async () => {
    const room = await freshRoom("edit-unchanged");
    const ada = await connect(room, "Ada");
    const original = await post(ada, "<p>Same</p>");

    // Sent as the editor writes it, which isn't quite how the room keeps it.
    ada.send({ type: "message.update", messageId: original.id, body: '<p class="x">Same</p>' });
    await settle(ada);
    expect(ada.pending("message.updated")).toEqual([]);
    expect(ada.pending("error")).toEqual([]);
    expect((await connect(room, "Grace")).welcome.messages).toEqual([original]);
  });

  it("lets an administrator edit anyone's message, for everyone", async () => {
    const administrator = await setUp();
    const room = await freshRoom("edit-administrator");
    const ada = await connect(room, administrator);
    const grace = await connect(room, "Grace");
    const original = await post(grace, "<p>Helo</p>");

    ada.send({ type: "message.update", messageId: original.id, body: "<p>Hello</p>" });
    const { message } = await grace.next("message.updated");
    expect(message).toMatchObject({ id: original.id, body: "<p>Hello</p>", creator: grace.me, createdAt: original.createdAt });
    expect((await ada.next("message.updated")).message).toEqual(message);
  });

  it("refuses edits to someone else's message, telling only the person who tried", async () => {
    const room = await freshRoom("edit-other");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const original = await post(ada, "Mine");

    grace.send({ type: "message.update", messageId: original.id, body: "Hijacked" });
    expect((await grace.next("error")).message).toBe("You can only edit your own messages");
    await settle(grace, ada);
    expect(ada.pending("message.updated")).toEqual([]);
    expect(ada.pending("error")).toEqual([]);
    expect((await connect(room, "Linus")).welcome.messages[0]!.body).toBe("Mine");
  });

  it("refuses edits to messages that don't exist, and edits it wouldn't keep as a new message", async () => {
    const room = await freshRoom("edit-missing");
    const ada = await connect(room, "Ada");
    const original = await post(ada, "Here");
    ada.send({ type: "message.update", messageId: "missing", body: "Hello" });
    expect((await ada.next("error")).message).toBe("You can only edit your own messages");
    for (const [body, message] of [
      ["   ", "Your message is empty."],
      [bodyFromPlainText("x".repeat(MAX_MESSAGE_LENGTH + 1)), "Messages can be up to 10,000 characters."],
      ["<b>".repeat(401), "That message couldn't be saved."],
    ]) {
      ada.send({ type: "message.update", messageId: original.id, body });
      expect(await ada.next("error")).toEqual({ type: "error", message, failed: "message.update" });
    }
    expect((await connect(room, "Grace")).welcome.messages).toEqual([original]);
  });

  it("keeps reactions that land while a message is being edited", async () => {
    const room = await freshRoom("edit-boost");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const message = await post(ada, "First draft");

    ada.send({ type: "message.update", messageId: message.id, body: "Second draft" });
    grace.send({ type: "boost.create", messageId: message.id, content: "🎉" });
    const { message: updated } = await ada.next("message.updated");
    await ada.next("boost.created");

    // Whichever lands second must not undo the first.
    const updatedAt = ada.log.findIndex((f) => f.type === "message.updated");
    const boostedAt = ada.log.findIndex((f) => f.type === "boost.created");
    if (boostedAt < updatedAt) expect(updated.boosts.map((b) => b.content)).toEqual(["🎉"]);
    const later = await connect(room, "Linus");
    expect(later.welcome.messages[0]).toMatchObject({ body: "Second draft", boosts: [{ content: "🎉" }] });
  });
});

describe("Delete a message", () => {
  it("lets the author delete a message, with its reactions, for everyone", async () => {
    const room = await freshRoom("delete");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const doomed = await post(ada, "Oops");
    const kept = await post(ada, "Keep this");
    grace.send({ type: "boost.create", messageId: doomed.id, content: "👍" });
    await ada.next("boost.created");

    ada.send({ type: "message.delete", messageId: doomed.id });
    expect(await grace.next("message.deleted")).toEqual({ type: "message.deleted", messageId: doomed.id, seq: 4 });
    await ada.next("message.deleted");

    const later = await connect(room, "Linus");
    expect(later.welcome.messages.map((m) => m.id)).toEqual([kept.id]);
    grace.send({ type: "boost.create", messageId: doomed.id, content: "👍" });
    expect((await grace.next("error")).message).toBe("That message no longer exists");
  });

  it("keeps a message's reactions when deleting it fails", async () => {
    const room = await freshRoom("delete-fails");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "Keep my reactions");
    ada.send({ type: "boost.create", messageId: message.id, content: "👍" });
    await ada.next("boost.created");

    // Make the storage refuse to delete this room's messages.
    const trigger = `refuse_deletes_${room.replaceAll("-", "_")}`;
    await roomSql(room, `CREATE TRIGGER ${trigger} BEFORE DELETE ON messages WHEN OLD.room_id = '${room}' BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    ada.send({ type: "message.delete", messageId: message.id });
    expect(await ada.next("error")).toMatchObject({ failed: "message.delete" });
    expect(await roomSql(room, "SELECT content FROM boosts WHERE message_id = ?", message.id)).toEqual([{ content: "👍" }]);

    await roomSql(room, `DROP TRIGGER ${trigger}`);
    ada.send({ type: "message.delete", messageId: message.id });
    await ada.next("message.deleted");
    expect(await roomSql(room, "SELECT content FROM boosts WHERE message_id = ?", message.id)).toEqual([]);
  });

  it("lets an administrator delete anyone's message, until they're a member again", async () => {
    const administrator = await setUp();
    const room = await freshRoom("delete-administrator");
    const grace = await connect(room, "Grace");
    const linus = await connect(room, "Linus");
    const first = await post(grace, "First");
    const second = await post(grace, "Second");

    await changeRole(administrator, linus.me.id, "administrator");
    linus.send({ type: "message.delete", messageId: first.id });
    expect(await grace.next("message.deleted")).toEqual({ type: "message.deleted", messageId: first.id, seq: 3 });

    // Their socket stays open as their role changes, and the room goes by the role they have now.
    await changeRole(administrator, linus.me.id, "member");
    linus.send({ type: "message.delete", messageId: second.id });
    expect((await linus.next("error")).message).toBe("You can only delete your own messages");
    linus.send({ type: "message.update", messageId: second.id, body: "Changed" });
    expect((await linus.next("error")).message).toBe("You can only edit your own messages");
    await settle(linus, grace);
    expect(grace.pending("message.deleted")).toEqual([]);
    expect(grace.pending("message.updated")).toEqual([]);
    expect((await connect(room, "Margaret")).welcome.messages).toEqual([second]);
  });

  it("refuses to delete someone else's message", async () => {
    const room = await freshRoom("delete-other");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const message = await post(ada, "Mine");

    grace.send({ type: "message.delete", messageId: message.id });
    expect((await grace.next("error")).message).toBe("You can only delete your own messages");
    await settle(grace, ada);
    expect(ada.pending("message.deleted")).toEqual([]);
    expect((await connect(room, "Linus")).welcome.messages).toHaveLength(1);
  });
});

describe("Scroll back through history", () => {
  it("opens a room on its newest 40 messages, oldest first, and says when there are more", async () => {
    const room = await freshRoom("page");
    const ada = await connect(room, "Ada");
    for (let i = 1; i <= 42; i++) await post(ada, `message ${i}`);

    const grace = await connect(room, "Grace");
    expect(grace.welcome.messages).toHaveLength(40);
    expect(grace.welcome.messages[0]!.body).toBe("message 3");
    expect(grace.welcome.messages.at(-1)!.body).toBe("message 42");
    expect(grace.welcome).toMatchObject({ hasMore: true, hasNewer: false, around: null });
  });

  it("opens a room on its messages as they are now, whatever changed since it last opened", async () => {
    const room = await freshRoom("page-changes");
    const ada = await connect(room, "Ada");
    const first = await post(ada, "first");
    const second = await post(ada, "second");
    // Each welcome is someone new opening the room, after the change before it.
    const opened = async () => (await connect(room, `Reader ${crypto.randomUUID()}`)).welcome.messages;
    expect((await opened()).map(({ id }) => id)).toEqual([first.id, second.id]);

    const third = await post(ada, "third");
    expect((await opened()).map(({ id }) => id)).toEqual([first.id, second.id, third.id]);

    ada.send({ type: "message.update", messageId: second.id, body: "<p>second, edited</p>" });
    await ada.next("message.updated");
    expect((await opened())[1]).toMatchObject({ id: second.id, body: "<p>second, edited</p>" });

    ada.send({ type: "boost.create", messageId: first.id, content: "👍" });
    const { boost } = await ada.next("boost.created");
    expect((await opened())[0]!.boosts).toEqual([boost]);

    ada.send({ type: "boost.delete", boostId: boost.id });
    await ada.next("boost.deleted");
    expect((await opened())[0]!.boosts).toEqual([]);

    ada.send({ type: "message.delete", messageId: third.id });
    await ada.next("message.deleted");
    expect((await opened()).map(({ id }) => id)).toEqual([first.id, second.id]);
  });

  it("pages backwards from the oldest message shown until there's nothing left", async () => {
    const room = await freshRoom("back");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const posted = [];
    for (let i = 1; i <= 5; i++) posted.push(await post(ada, `message ${i}`));

    ada.send({ type: "history.before", before: posted[4]!.id, limit: 3 });
    const middle = await ada.next("history");
    expect(middle.before).toBe(posted[4]!.id);
    expect(middle.messages.map((m) => m.body)).toEqual(["message 2", "message 3", "message 4"]);
    expect(middle.hasMore).toBe(true);

    ada.send({ type: "history.before", before: middle.messages[0]!.id, limit: 3 });
    const last = await ada.next("history");
    expect(last.messages.map((m) => m.body)).toEqual(["message 1"]);
    expect(last.hasMore).toBe(false);

    await settle(ada, grace);
    expect(grace.pending("history")).toEqual([]);
  });

  it("pages forwards from the newest message shown until there's nothing newer", async () => {
    const room = await freshRoom("forward");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const posted = [];
    for (let i = 1; i <= 5; i++) posted.push(await post(ada, `message ${i}`));

    ada.send({ type: "history.after", after: posted[0]!.id, limit: 3 });
    const middle = await ada.next("history.after");
    expect(middle.after).toBe(posted[0]!.id);
    expect(middle.messages.map((m) => m.body)).toEqual(["message 2", "message 3", "message 4"]);
    expect(middle.hasNewer).toBe(true);

    ada.send({ type: "history.after", after: middle.messages.at(-1)!.id });
    const last = await ada.next("history.after");
    expect(last.messages.map((m) => m.body)).toEqual(["message 5"]);
    expect(last.hasNewer).toBe(false);

    // Past the newest message, a page is empty.
    ada.send({ type: "history.after", after: posted[4]!.id });
    expect(await ada.next("history.after")).toMatchObject({ messages: [], hasNewer: false });

    await settle(ada, grace);
    expect(grace.pending("history.after")).toEqual([]);
  });

  it("hands out the largest history page a client may ask for", async () => {
    const room = await freshRoom("long-history");
    const ada = await connect(room, "Ada");
    const bodies = Array.from({ length: 101 }, (_, i) => `long ${i}`);
    const ids: string[] = [];
    for (const body of bodies) ids.push((await post(ada, body)).id);
    for (const content of ["👍", "🎉"]) {
      ada.send({ type: "boost.create", messageId: ids[0]!, content });
      await ada.next("boost.created");
    }

    // 100 is the most parseClientFrame lets through, and both backends bind at most 100 values a
    // statement, so a page can't bind its message ids to look up their boosts.
    ada.send({ type: "history.before", before: ids[100]!, limit: 100 });
    const page = await ada.next("history");
    expect(page.messages.map((m) => m.body)).toEqual(bodies.slice(0, 100));
    expect(page.messages[0]!.boosts.map((b) => b.content)).toEqual(["👍", "🎉"]);
    expect(page.hasMore).toBe(false);
  });

  it("pages history by seeking the room's index from the cursor", async () => {
    const room = await freshRoom("paging-plan");
    await connect(room, "Ada");
    const plan = async (query: string, ...params: Array<string | number>) =>
      (await roomSql(room, `EXPLAIN QUERY PLAN ${query}`, ...params)).map((row) => (row as { detail: string }).detail).join("; ");

    const before = await plan(MESSAGES_BEFORE, room, "cursor", 41);
    const after = await plan(MESSAGES_AFTER, room, "cursor", 41);
    const newest = await plan(NEWEST_MESSAGES, room, 41);

    // Seeking (room_id=?) alone would walk the room from its newest message down to the cursor, and
    // without in_room, through every reply sent only to a thread.
    expect(before).toContain("index_messages_on_room_id_and_in_room_and_id (room_id=? AND in_room=? AND id<?)");
    expect(after).toContain("index_messages_on_room_id_and_in_room_and_id (room_id=? AND in_room=? AND id>?)");
    expect(`${before}; ${after}; ${newest}`).not.toContain("TEMP B-TREE");
  });

  it("gives someone joining mid-conversation every message exactly once, snapshot first", async () => {
    const room = await freshRoom("joining");
    const ada = await connect(room, "Ada");
    const session = await signIn("Grace");

    // Ada keeps talking while Grace's socket loads its snapshot.
    const joining = connect(room, session);
    const bodies = Array.from({ length: 10 }, (_, i) => `joining ${i}`);
    for (const [i, body] of bodies.entries()) {
      ada.send({ type: "message.create", clientMessageId: `j${i}`, body });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const grace = await joining;
    for (const _ of bodies) await ada.next("message.created");
    await settle(grace);

    const [first, ...rest] = grace.log;
    expect(first?.type).toBe("welcome");
    const live = rest.flatMap((f) => (f.type === "message.created" ? [f.message.body] : []));
    expect([...grace.welcome.messages.map((m) => m.body), ...live]).toEqual(bodies);
  });

  it("includes each message's reactions in history", async () => {
    const room = await freshRoom("history-boosts");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "React to me");
    ada.send({ type: "boost.create", messageId: message.id, content: "🎉" });
    const { boost } = await ada.next("boost.created");

    const grace = await connect(room, "Grace");
    expect(grace.welcome.messages[0]!.boosts).toEqual([boost]);
  });
});

describe("Link to a message", () => {
  it("opens a socket at a permalink on the page around its message: up to 40 before it, it, and up to 40 after", async () => {
    const room = await freshRoom("around");
    const ada = await connect(room, "Ada");
    const posted = [];
    for (let i = 1; i <= 90; i++) posted.push(await post(ada, `message ${i}`));

    const grace = await connect(room, "Grace", { visible: true, around: posted[44]!.id });
    expect(grace.welcome.messages.map((m) => m.body)).toEqual(posted.slice(4, 85).map((m) => m.body));
    expect(grace.welcome).toMatchObject({ around: posted[44]!.id, hasMore: true, hasNewer: true });
  });

  it("ends the page where the room's messages do", async () => {
    const room = await freshRoom("around-ends");
    const ada = await connect(room, "Ada");
    const posted = [];
    for (let i = 1; i <= 5; i++) posted.push(await post(ada, `message ${i}`));

    for (const message of [posted[0]!, posted[4]!]) {
      const grace = await connect(room, "Grace", { visible: true, around: message.id });
      expect(grace.welcome).toMatchObject({ around: message.id, hasMore: false, hasNewer: false });
      expect(grace.welcome.messages.map((m) => m.body)).toEqual(posted.map((m) => m.body));
    }
  });

  it("opens on the newest page for a message the room doesn't have", async () => {
    const room = await freshRoom("around-missing");
    const ada = await connect(room, "Ada");
    const elsewhere = await post(await connect(await freshRoom("around-elsewhere"), ada.session), "Not in this room");
    await post(ada, "Here");

    for (const around of [elsewhere.id, "no-such-message"]) {
      const grace = await connect(room, "Grace", { visible: true, around });
      expect(grace.welcome).toMatchObject({ around: null, hasMore: false, hasNewer: false });
      expect(grace.welcome.messages.map((m) => m.body)).toEqual(["Here"]);
    }
  });

  it("answers history.around with the page around a message, or the newest page when it names none", async () => {
    const room = await freshRoom("around-frame");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const posted = [];
    for (let i = 1; i <= 45; i++) posted.push(await post(ada, `message ${i}`));

    ada.send({ type: "history.around", messageId: posted[1]!.id });
    const around = await ada.next("history.around");
    expect(around).toMatchObject({ around: posted[1]!.id, hasMore: false, hasNewer: true });
    expect(around.messages.map((m) => m.body)).toEqual(posted.slice(0, 42).map((m) => m.body));

    ada.send({ type: "history.around" });
    const newest = await ada.next("history.around");
    expect(newest).toMatchObject({ around: null, hasMore: true, hasNewer: false });
    expect(newest.messages.map((m) => m.body)).toEqual(posted.slice(5).map((m) => m.body));

    await settle(ada, grace);
    expect(grace.pending("history.around")).toEqual([]);
  });
});
