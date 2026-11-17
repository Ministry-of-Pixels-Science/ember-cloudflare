import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ChatRoom } from "../src/chat-room";
import type { Env } from "../src/env";
import { STORED_CLIENT_MESSAGE_IDS } from "../src/store";
import { connect, freshRoom, post, roomSql, roomStub, settle, sharedD1, signIn } from "./support";

const names = (users: { name: string }[]) => users.map((u) => u.name).sort();

describe("Presence", () => {
  it("tells newcomers who is here and tells everyone else they arrived", async () => {
    const room = await freshRoom("presence");
    const ada = await connect(room, "Ada");
    expect(names(ada.welcome.present)).toEqual(["Ada"]);

    const grace = await connect(room, "Grace");
    expect(names(grace.welcome.present)).toEqual(["Ada", "Grace"]);
    expect(await ada.next("presence.joined")).toEqual({ type: "presence.joined", user: grace.me });
  });

  it("tells everyone when someone leaves", async () => {
    const room = await freshRoom("leave");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    await ada.next("presence.joined");

    grace.close();
    expect(await ada.next("presence.left")).toEqual({ type: "presence.left", userId: grace.me.id });
  });

  it("counts someone with several tabs open once, until their last tab closes", async () => {
    const room = await freshRoom("tabs");
    const ada = await connect(room, "Ada");
    const grace = await signIn("Grace");
    const firstTab = await connect(room, grace);
    const secondTab = await connect(room, grace);
    expect(names(secondTab.welcome.present)).toEqual(["Ada", "Grace"]);

    firstTab.close();
    await tabsOpen(room, grace.user.id, 1);
    secondTab.close();
    await ada.next("presence.left");
    expect(ada.log.filter((frame) => frame.type.startsWith("presence."))).toEqual([
      { type: "presence.joined", user: grace.user },
      { type: "presence.left", userId: grace.user.id },
    ]);
    // Neither tab was typing, so closing them said nothing about typing.
    expect(ada.log.filter((frame) => frame.type === "typing")).toEqual([]);
  });

  it("has nobody in the room for a socket that shows a thread apart from its timeline, as a huddle shows its own: they aren't among who's here, and neither arrive as it opens nor leave as it closes", async () => {
    const room = await freshRoom("apart");
    const ada = await connect(room, "Ada");
    const grace = await signIn("Grace");
    const apart = await connect(room, grace, { visible: true, apart: true });
    expect(names(apart.welcome.present)).toEqual(["Ada"]);

    // Opening the room itself is her arriving, and closing it her leaving, though her other socket stays open.
    const tab = await connect(room, grace);
    expect(names(tab.welcome.present)).toEqual(["Ada", "Grace"]);
    tab.close();
    expect(await ada.next("presence.left")).toEqual({ type: "presence.left", userId: grace.user.id });

    // Whoever opens the room next finds Ada alone, and the other socket closes without a word to the room.
    const lin = await connect(room, "Lin");
    expect(names(lin.welcome.present)).toEqual(["Ada", "Lin"]);
    apart.close();
    await tabsOpen(room, grace.user.id, 0);
    await settle(ada, lin);
    expect(ada.log.filter((frame) => frame.type.startsWith("presence."))).toEqual([
      { type: "presence.joined", user: grace.user },
      { type: "presence.left", userId: grace.user.id },
      { type: "presence.joined", user: lin.me },
    ]);
    expect(lin.log.filter((frame) => frame.type.startsWith("presence."))).toEqual([]);
  });

  it("tells everyone when someone's connection drops without closing", async () => {
    const room = await freshRoom("dropped");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    await ada.next("presence.joined");

    // A connection that drops, like a phone losing signal, reaches the room as code 1006 with no
    // close frame to answer.
    await runInDurableObject((env as unknown as Env).CHAT_ROOM.getByName(room), async (instance: ChatRoom, state: DurableObjectState) => {
      const [socket] = state.getWebSockets(grace.me.id);
      await instance.webSocketClose(socket!, 1006);
    });
    expect(await ada.next("presence.left")).toEqual({ type: "presence.left", userId: grace.me.id });
  });
});

describe("Typing indicator", () => {
  it("tells everyone else when someone starts and stops typing", async () => {
    const room = await freshRoom("typing");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");

    ada.send({ type: "typing.start" });
    expect(await grace.next("typing")).toEqual({ type: "typing", user: ada.me, typing: true });
    ada.send({ type: "typing.stop" });
    expect(await grace.next("typing")).toEqual({ type: "typing", user: ada.me, typing: false });

    await settle(ada);
    expect(ada.pending("typing")).toEqual([]);
  });

  it("lets someone's message say they've stopped typing, without a frame of its own", async () => {
    const room = await freshRoom("typing-sent");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    ada.send({ type: "typing.start" });
    await grace.next("typing");

    const message = await post(ada, "Done typing");
    expect((await grace.next("message.created")).message).toEqual(message);
    await settle(grace);
    expect(grace.pending("typing")).toEqual([]);
  });

  it("stops someone's typing when the tab doing it closes, and not when another of their tabs does", async () => {
    const room = await freshRoom("typing-tabs");
    const ada = await connect(room, "Ada");
    const grace = await signIn("Grace");
    const typing = await connect(room, grace);
    const idle = await connect(room, grace);
    await connect(room, grace);
    typing.send({ type: "typing.start" });
    expect(await ada.next("typing")).toEqual({ type: "typing", user: grace.user, typing: true });

    idle.close();
    await tabsOpen(room, grace.user.id, 2);
    typing.close();
    expect(await ada.next("typing")).toEqual({ type: "typing", user: grace.user, typing: false });
    await settle(ada);
    expect(ada.pending("typing")).toEqual([]);
  });

  it("lets someone's leaving say they've stopped typing, without a frame of its own", async () => {
    const room = await freshRoom("typing-left");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    ada.send({ type: "typing.start" });
    await grace.next("typing");

    ada.close();
    expect(await grace.next("presence.left")).toEqual({ type: "presence.left", userId: ada.me.id });
    await settle(grace);
    expect(grace.pending("typing")).toEqual([]);
  });
});

describe("Catch up after a reconnect", () => {
  it("answers heartbeats, so clients can tell a dead connection from a quiet room", async () => {
    const ada = await connect(await freshRoom("heartbeat"), "Ada");
    ada.sendRaw('{"type":"ping"}');
    expect(await ada.next("pong")).toEqual({ type: "pong" });
    ada.send({ type: "ping", extra: true });
    expect(await ada.next("pong")).toEqual({ type: "pong" });
  });

  it("catches a reconnecting client up on what it missed", async () => {
    const room = await freshRoom("missed");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    grace.close();
    const missed = await post(ada, "While you were away");

    const back = await connect(room, grace.session);
    expect(back.welcome.messages).toContainEqual(missed);
    expect(back.me).toEqual(grace.me);
  });

  it("tells a sender which of their messages it stored", async () => {
    const room = await freshRoom("checking");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    await post(ada, "stored", "a1");
    await post(grace, "not Ada's", "g1");

    ada.send({ type: "message.check", clientMessageIds: ["a1", "g1", "lost"] });
    expect(await ada.next("message.checked")).toEqual({ type: "message.checked", stored: ["a1"], missing: ["g1", "lost"] });

    // On D1 every room's messages share one table, so the lookup has to stay in its own room.
    const elsewhere = await connect(await freshRoom("checking-elsewhere"), ada.session);
    elsewhere.send({ type: "message.check", clientMessageIds: ["a1"] });
    expect(await elsewhere.next("message.checked")).toEqual({ type: "message.checked", stored: [], missing: ["a1"] });
  });

  it("checks a sender's messages through the room's index", async () => {
    const room = await freshRoom("checking-plan");
    const ada = await connect(room, "Ada");
    const plan = await roomSql(room, `EXPLAIN QUERY PLAN ${STORED_CLIENT_MESSAGE_IDS}`, room, ada.me.id, '["c1"]');
    // Without it, a check reads every message in the room.
    expect(plan.map((row) => (row as { detail: string }).detail).join("; ")).toContain(
      "index_messages_on_room_id_and_creator_id_and_client_message_id (room_id=? AND creator_id=? AND client_message_id=?)",
    );
  });

  it("names the messages it couldn't check", async () => {
    // Only a Durable Object's storage can be broken for one room without breaking the tests beside it.
    if (sharedD1()) return;
    const room = await freshRoom("check-fails");
    const ada = await connect(room, "Ada");
    await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => {
      state.storage.sql.exec("ALTER TABLE messages RENAME TO messages_gone");
    });
    ada.send({ type: "message.check", clientMessageIds: ["a1", "a2"] });
    expect(await ada.next("error")).toMatchObject({ failed: "message.check", clientMessageIds: ["a1", "a2"] });
  });
});

describe("Hibernating rooms", () => {
  it("keeps sockets, presence and who-said-what when the room hibernates", async () => {
    const room = await freshRoom("hibernate");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    await ada.next("presence.joined");

    await evictDurableObject((env as unknown as Env).CHAT_ROOM.getByName(room));

    const message = await post(ada, "After a nap");
    expect(message.creator).toEqual(ada.me);
    expect((await grace.next("message.created")).message).toEqual(message);
    grace.close();
    expect(await ada.next("presence.left")).toEqual({ type: "presence.left", userId: grace.me.id });
  });
});

/** Resolves once the room has `count` of `userId`'s sockets open, having handled the rest closing. */
const tabsOpen = (room: string, userId: string, count: number) =>
  vi.waitFor(() =>
    runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => {
      expect(state.getWebSockets(userId)).toHaveLength(count);
    }),
  );
