import type { RoomId } from "@ember/protocol";
import { HuddleCloseCode, RELAY_TTL_S, type HuddlePerson } from "@ember/protocol/huddles";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { relayServers, relayServersIn } from "../src/huddles/relay";
import { giveRelay, huddlesOn, joinHuddle, OTHER_RELAY, publishMicrophone, RELAY, relayServersGiven, relayServersMade, takeRelayAway, welcomed } from "./huddle-support";
import { api, connect, freshDeploy, freshRoom, post, signIn, type Session } from "./support";

// Huddles' relay: what a room makes of the servers Cloudflare's TURN service answers, and the welcome
// it gives a tab with them, where a stand-in answers for Cloudflare (./huddle-support.ts). Setting the
// relay up is in ./huddles.test.ts.

/** Someone in a huddle as the others hear of them: unmuted, and not to be listened to yet, but for `changes`. */
const person = ({ user }: Session, changes: Partial<Omit<HuddlePerson, "user">> = {}): HuddlePerson => ({ user, muted: false, audio: false, video: false, screen: false, ...changes });

/** What a request for a tab's servers asks the TURN service, by the TURN key `keyId`. */
const forATab = (keyId = RELAY.keyId) => ({ keyId, body: { ttl: RELAY_TTL_S } });

/** Where the stand-in is asked for a relay's servers. */
const RELAY_SERVERS = /generate-ice-servers$/;

/**
 * Sets Ember up with huddles on and a relay for them. The stand-in for Cloudflare has made a relay's
 * servers once since, as the key was checked, so the next it makes are its second.
 */
async function relayOn() {
  const { ada, sfu } = await huddlesOn();
  await giveRelay(ada);
  return { ada, sfu };
}

/** Joins `room`'s huddle in `session`, and answers what the room welcomes the tab with. */
const welcomeOf = async (room: RoomId, session: Session) => (await joinHuddle(room, session)).next("huddle.welcome");

beforeEach(freshDeploy);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("The relay's servers", () => {
  const [stun, relay] = relayServersMade().iceServers as [{ urls: string[] }, { urls: string[]; username: string; credential: string }];
  const { username, credential } = relay;

  it("are the ones Cloudflare answers, without the addresses browsers won't connect to", () => {
    expect(relayServersIn(relayServersMade())).toEqual(relayServersGiven());
    // One server alone, as Cloudflare answered before it answered a list.
    expect(relayServersIn({ iceServers: relay })).toEqual([relayServersGiven()[1]]);
    // And one address alone.
    expect(relayServersIn({ iceServers: [{ urls: "turns:turn.cloudflare.com:443?transport=tcp", username, credential }] })).toEqual([{ urls: ["turns:turn.cloudflare.com:443?transport=tcp"], username, credential }]);
  });

  it("aren't a relay's without a relay's addresses, or without the name and the credential a relay is used with", () => {
    const none = [
      null,
      "<html>",
      [],
      {},
      { iceServers: null },
      { iceServers: [] },
      { iceServers: "turn:turn.cloudflare.com:3478" },
      { iceServers: [stun] },
      { iceServers: [stun, { urls: relay.urls }] },
      { iceServers: [stun, { urls: relay.urls, username }] },
      { iceServers: [stun, { ...relay, username: 7 }] },
      { iceServers: [stun, { ...relay, credential: "" }] },
      { iceServers: [stun, { ...relay, credential: "c".repeat(513) }] },
      // Only at the port browsers won't connect to.
      { iceServers: [{ ...relay, urls: ["turn:turn.cloudflare.com:53?transport=udp"] }] },
      // Further down the list than a relay's answer goes.
      { iceServers: [stun, stun, stun, stun, relay] },
    ];
    for (const said of none) expect(relayServersIn(said), JSON.stringify(said)).toBeNull();
  });

  it("carry only what a browser takes: addresses it can read, and nothing else Cloudflare might say", () => {
    const said = {
      iceServers: [
        // A relay's addresses do nothing without what it's used with, so only the STUN server's are kept.
        { urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp"], credentialType: "password" },
        {
          urls: [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "TURNS:Turn.Cloudflare.com:443?transport=tcp",
            "turn:turn.cloudflare.com",
            "https://example.com/",
            "turn:turn.cloudflare.com:3478?transport=sctp",
            "turn:turn cloudflare.com:3478",
            "turn:turn.cloudflare.com:3478?transport=udp&ttl=1",
            `turn:${"a".repeat(600)}.example.com`,
            "javascript:alert(1)",
            7,
            null,
          ],
          username,
          credential,
          credentialType: "password",
          expires: "2026-11-17T00:00:00Z",
        },
        "turn:turn.cloudflare.com:3478",
      ],
      ttl: 86_400,
    };
    expect(relayServersIn(said)).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "TURNS:Turn.Cloudflare.com:443?transport=tcp", "turn:turn.cloudflare.com"], username, credential },
    ]);
    // No more than a dozen addresses of a server.
    const many = relayServersIn({ iceServers: [{ urls: Array.from({ length: 20 }, (_, n) => `turn:turn${n}.example.com:3478`), username, credential }] });
    expect(many?.[0]?.urls).toEqual(Array.from({ length: 12 }, (_, n) => `turn:turn${n}.example.com:3478`));
  });

  it("are waited on for four seconds, after which the tab is let in without a relay, which is logged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // A request that's never answered ends when it's given up on, as fetch's does.
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")))));
    let servers: unknown = "unanswered";
    void relayServers(env as unknown as Env, RELAY).then((answered) => (servers = answered));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(servers).toBe("unanswered");
    await vi.advanceTimersByTimeAsync(1);
    expect(servers).toBeNull();
    expect(logged).toHaveBeenCalledExactlyOnceWith("Asking Cloudflare for the relay's servers failed:", "AbortError");
  });
});

describe("A huddle's relay", () => {
  it("welcomes each tab with the servers Cloudflare made for it as it joined, the relay's among them", async () => {
    const { ada, sfu } = await relayOn();
    const room = await freshRoom("relayed");
    const grace = await signIn("Grace");

    const adas = await joinHuddle(room, ada);
    expect(await adas.next("huddle.welcome")).toEqual({ type: "huddle.welcome", you: ada.user, people: [person(ada)], startedAt: expect.any(String) as string, messageId: expect.any(String) as string, iceServers: relayServersGiven(2) });
    expect((await welcomeOf(room, grace)).iceServers).toEqual(relayServersGiven(3));
    // Each tab's were made for it, to last a day, by the TURN key huddles were given.
    expect(sfu.relayAsked).toEqual([forATab(), forATab(), forATab()]);
    // Nobody else hears of them, and the SFU is asked nothing.
    expect(await adas.next("huddle.joined")).toEqual({ type: "huddle.joined", person: person(grace) });
    expect(sfu.asked).toEqual([]);

    // Someone who moves to another tab is given that tab's own.
    expect((await welcomeOf(room, ada)).iceServers).toEqual(relayServersGiven(4));
  });

  it("gives the next tab the relay once huddles have one, by the key they have then, and none once it's taken away", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("relayed");
    const [grace, linus, edsger] = [await signIn("Grace"), await signIn("Linus"), await signIn("Edsger")];
    expect(await welcomeOf(room, ada)).not.toHaveProperty("iceServers");
    expect(sfu.relayAsked).toEqual([]);

    // The room heard what huddles run through a moment ago, and asks again as each tab joins.
    await giveRelay(ada);
    expect((await welcomeOf(room, grace)).iceServers).toEqual(relayServersGiven(2));
    await giveRelay(ada, OTHER_RELAY);
    expect((await welcomeOf(room, linus)).iceServers).toEqual(relayServersGiven(4));
    expect(sfu.relayAsked.at(-1)).toEqual(forATab(OTHER_RELAY.keyId));
    await takeRelayAway(ada);
    expect(await welcomeOf(room, edsger)).not.toHaveProperty("iceServers");
    expect(sfu.relayAsked).toHaveLength(4);
  });

  it("has Cloudflare make no servers for a tab that joins in a room whose settings don't allow huddles", async () => {
    const { ada, sfu } = await relayOn();
    const room = await freshRoom("not-here");
    expect((await api(`/api/rooms/${room}`, { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ huddles: false }) })).status).toBe(200);
    const made = sfu.relayAsked.length;

    expect(await (await joinHuddle(room, ada)).closed).toMatchObject({ code: HuddleCloseCode.Off });
    expect(sfu.relayAsked).toHaveLength(made);
  });

  it("lets a tab in without a relay when Cloudflare doesn't make its servers, logging its status and never the key", async () => {
    const { ada, sfu } = await relayOn();
    const room = await freshRoom("unrelayed");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const answers: Array<() => Response | Promise<Response>> = [
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 401 }),
      () => new Response("<html>", { status: 201 }),
      // Servers with no relay's among them.
      () => Response.json({ iceServers: [relayServersMade().iceServers[0]] }, { status: 201 }),
      () => Promise.reject(new TypeError("Network connection lost")),
    ];
    for (const answer of answers) {
      sfu.answerInstead(RELAY_SERVERS, answer);
      expect(await welcomeOf(room, ada)).toEqual({ type: "huddle.welcome", you: ada.user, people: [person(ada)], startedAt: expect.any(String) as string, messageId: expect.any(String) as string });
    }
    expect(warned.mock.calls).toEqual([500, 401, 201, 201].map((status) => ["Cloudflare didn't give the relay's servers:", status]));
    expect(logged.mock.calls).toEqual([["Asking Cloudflare for the relay's servers failed:", "TypeError"]]);
    const said = JSON.stringify([...warned.mock.calls, ...logged.mock.calls]);
    expect(said).not.toContain(RELAY.apiToken);
    expect(said).not.toContain(RELAY.keyId);

    // The next tab is asked for again.
    expect((await welcomeOf(room, ada)).iceServers).toEqual(relayServersGiven(2));
  });

  it("goes on with everything else while Cloudflare makes a tab's servers", async () => {
    const { ada, sfu } = await relayOn();
    const room = await freshRoom("held");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const adaInRoom = await connect(room, ada);
    const release = sfu.hold(RELAY_SERVERS);
    const joining = joinHuddle(room, grace);
    await vi.waitFor(() => expect(sfu.relayAsked).toHaveLength(3));

    // Meanwhile the room lets Linus in, takes what Ada writes, and publishes her microphone.
    const linusInRoom = await connect(room, linus);
    const message = await post(adaInRoom, "<p>Grace is on her way</p>");
    expect((await linusInRoom.next("message.created")).message.id).toBe(message.id);
    await publishMicrophone(adas);

    release();
    const graces = await joining;
    expect(await graces.next("huddle.welcome")).toMatchObject({ people: [person(ada, { audio: true }), person(grace)], iceServers: relayServersGiven(3) });
  });
});
