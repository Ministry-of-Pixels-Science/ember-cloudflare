import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { JSHandle, Page } from "@playwright/test";
import { SFU_APP, SFU_PORT } from "../../projects/workspace-settings";

// Cloudflare's Realtime SFU for the huddles spec, at the address the second test server's REALTIME_SFU_URL
// names, as Ember asks it (apps/worker/src/huddles/sfu.ts): it knows one app, `SFU_APP`, starts a session
// for it when asked with its secret, and refuses as Cloudflare does an app it doesn't know, or a secret
// that isn't the app's. Cloudflare documents that refusal's error code but not its status, so 401 here
// is a guess, and Ember reads either.
//
// Given a page, it carries what's published as well, voices and cameras alike: each session is a
// connection of the page's, which answers the offer a browser publishes with, and offers a browser the
// tracks it pulls, passing on what their publishers send it. Its descriptions name an address of its own, as the SFU's name the SFU's,
// since a browser in a huddle sends the room none of its own.

/** What Ember asked the SFU: how, where, and with which secret. */
export interface SfuAsked {
  method: string;
  path: string;
  authorization: string | undefined;
}

export interface FakeSfu {
  /** What it was asked, in order. */
  asked: SfuAsked[];
  close(): Promise<void>;
}

/** A track a browser publishes: the media section of its offer that carries it, and the name it's pulled by. */
interface Published {
  mid: string;
  trackName: string;
}

/** A track another session publishes, as a session pulls it. */
interface Pulled {
  sessionId: string;
  trackName: string;
}

/** What Ember sends with a request about a session's tracks. */
interface AskedOfTracks {
  sessionDescription?: { sdp: string };
  tracks?: Array<Partial<Published & Pulled>>;
}

/** The page's side of the SFU: its sessions' connections, by what Ember asks of them. */
type Relay = JSHandle<{
  publish(sessionId: string, offer: string, tracks: Published[]): Promise<unknown>;
  pull(sessionId: string, tracks: Pulled[]): Promise<unknown>;
  renegotiate(sessionId: string, answer: string): Promise<unknown>;
  close(sessionId: string, mids: string[]): unknown;
}>;

/** Starts the SFU, which carries what's published through `page`'s connections when it's given one. */
export async function startFakeSfu(page?: Page): Promise<FakeSfu> {
  const asked: SfuAsked[] = [];
  const relay = page && (await relayOn(page));
  const server = createServer((request, response) => {
    const { method = "", url = "" } = request;
    asked.push({ method, path: url, authorization: request.headers.authorization });
    void answer(request, relay).then(([status, body]) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body)));
  });
  await new Promise<void>((resolve) => server.listen(SFU_PORT, "127.0.0.1", resolve));
  return { asked, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function answer(request: IncomingMessage, relay: Relay | undefined): Promise<[status: number, body: unknown]> {
  const { method = "", url = "" } = request;
  const [, appId, sessionId, about] = /^\/v1\/apps\/([^/]+)\/sessions\/(?:([^/]+)\/)?(new|tracks\/new|renegotiate|tracks\/close)$/.exec(url) ?? [];
  if (appId !== SFU_APP.appId) {
    return [404, { errorCode: "not_found", errorDescription: `appId ${appId ?? ""} does not exist. If you created or modified the App recently, it may take up to 60 seconds to reflect changes globally.` }];
  }
  if (request.headers.authorization !== `Bearer ${SFU_APP.appSecret}`) return [401, { errorCode: "unauthorized", errorDescription: "The SFU App Secret was not accepted." }];
  if (sessionId === undefined) return method === "POST" ? [201, { sessionId: randomUUID().replaceAll("-", "") }] : [405, { errorCode: "method_not_allowed" }];
  if (!relay) return [404, { errorCode: "not_found", errorDescription: "This SFU carries nothing." }];

  const { sessionDescription, tracks = [] } = (await bodyOf(request)) as AskedOfTracks;
  try {
    switch (`${method} ${about}`) {
      case "POST tracks/new":
        if (sessionDescription) return [200, await relay.evaluate((relay, [id, offer, tracks]) => relay.publish(id, offer, tracks), [sessionId, sessionDescription.sdp, tracks as Published[]] as const)];
        return [200, await relay.evaluate((relay, [id, tracks]) => relay.pull(id, tracks), [sessionId, tracks as Pulled[]] as const)];
      case "PUT renegotiate":
        return [200, await relay.evaluate((relay, [id, answer]) => relay.renegotiate(id, answer), [sessionId, sessionDescription?.sdp ?? ""] as const)];
      case "PUT tracks/close":
        return [200, await relay.evaluate((relay, [id, mids]) => relay.close(id, mids), [sessionId, tracks.map(({ mid }) => mid ?? "")] as const)];
      default:
        return [405, { errorCode: "method_not_allowed" }];
    }
  } catch (error) {
    return [400, { errorCode: "invalid_request", errorDescription: String(error) }];
  }
}

/** What a request carries, read as JSON, or nothing. */
async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString());
}

/** Makes `page` the SFU's connections: one a session, each made by the first request about its session. */
async function relayOn(page: Page): Promise<Relay> {
  // Chromium names a page's own addresses only for a page that may use a microphone. Any other's it
  // gives names that only its own network finds, which a test server's has nobody to answer.
  await page.context().grantPermissions(["microphone"]);
  return page.evaluateHandle(() => {
    interface Session {
      connection: RTCPeerConnection;
      /** What it publishes, by the name it's pulled by. */
      published: Map<string, MediaStreamTrack>;
      /** The media sections whose tracks have been closed. */
      closed: Set<string>;
    }
    const sessions = new Map<string, Session>();
    const playing = new Map<MediaStreamTrack, HTMLMediaElement>();

    const sessionOf = (sessionId: string): Session => {
      const session = sessions.get(sessionId) ?? { connection: new RTCPeerConnection({ bundlePolicy: "max-bundle" }), published: new Map(), closed: new Set() };
      sessions.set(sessionId, session);
      return session;
    };

    /**
     * The connection's own description, once it names an address the connection is reached at: the first
     * it finds, since Chromium can go on looking for others until the connection is made.
     */
    const described = async (connection: RTCPeerConnection, description: RTCSessionDescriptionInit) => {
      await connection.setLocalDescription(description);
      if (!connection.localDescription!.sdp.includes("a=candidate:")) {
        await new Promise((resolve) => connection.addEventListener("icecandidate", resolve, { once: true }));
      }
      return { type: description.type, sdp: connection.localDescription!.sdp };
    };

    /** Chromium takes the sound a connection receives from whatever plays it, so a track is passed on only while something does: a camera's, in a video. */
    const play = (track: MediaStreamTrack) => {
      const player = track.kind === "video" ? Object.assign(document.createElement("video"), { muted: true }) : new Audio();
      player.srcObject = new MediaStream([track]);
      playing.set(track, player);
      void player.play();
    };

    const notFound = ({ sessionId, trackName }: Pulled) => ({ sessionId, trackName, errorCode: "not_found_track_error", errorDescription: "Track not found" });

    return {
      async publish(sessionId: string, offer: string, tracks: Published[]) {
        const { connection, published } = sessionOf(sessionId);
        await connection.setRemoteDescription({ type: "offer", sdp: offer });
        const taken = tracks.map(({ mid, trackName }) => {
          const track = connection.getTransceivers().find((transceiver) => transceiver.mid === mid)?.receiver.track;
          if (!track) return { mid, trackName, errorCode: "invalid_request", errorDescription: "No such media section" };
          published.set(trackName, track);
          play(track);
          return { mid, trackName };
        });
        return { requiresImmediateRenegotiation: false, sessionDescription: await described(connection, await connection.createAnswer()), tracks: taken };
      },

      async pull(sessionId: string, tracks: Pulled[]) {
        const { connection } = sessionOf(sessionId);
        const sent = tracks.map((asked) => {
          const track = sessions.get(asked.sessionId)?.published.get(asked.trackName);
          return { asked, transceiver: track && connection.addTransceiver(track, { direction: "sendonly" }) };
        });
        if (!sent.some(({ transceiver }) => transceiver)) return { requiresImmediateRenegotiation: false, tracks: tracks.map(notFound) };
        const sessionDescription = await described(connection, await connection.createOffer());
        return {
          requiresImmediateRenegotiation: true,
          sessionDescription,
          tracks: sent.map(({ asked, transceiver }) => (transceiver ? { ...asked, mid: transceiver.mid } : notFound(asked))),
        };
      },

      async renegotiate(sessionId: string, answer: string) {
        await sessionOf(sessionId).connection.setRemoteDescription({ type: "answer", sdp: answer });
        return {};
      },

      close(sessionId: string, mids: string[]) {
        const session = sessions.get(sessionId);
        const closed = mids.map((mid) => {
          const transceiver = session?.connection.getTransceivers().find((transceiver) => transceiver.mid === mid);
          if (!session || !transceiver || session.closed.has(mid)) return { mid, errorCode: "close_track_error", errorDescription: "Track not found" };
          session.closed.add(mid);
          // What it published is no longer there to pull, and whoever pulled it is sent no more of it.
          const received = transceiver.receiver.track;
          for (const [trackName, track] of session.published) if (track === received) session.published.delete(trackName);
          for (const { connection } of sessions.values()) for (const sender of connection.getSenders()) if (sender.track === received) void sender.replaceTrack(null);
          playing.get(received)?.pause();
          playing.delete(received);
          void transceiver.sender.replaceTrack(null);
          return { mid };
        });
        return { requiresImmediateRenegotiation: false, tracks: closed };
      },
    };
  });
}
