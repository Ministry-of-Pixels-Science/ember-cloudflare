import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { JSHandle, Page } from "@playwright/test";
import { SFU_APP, SFU_PORT, TURN_KEY, TURN_PORT } from "../../projects/workspace-settings";

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
//
// A camera sent in two sizes at once (simulcast) it takes in both, and passes on in the one a session
// asks for, or changes to: Cloudflare's `simulcast.preferredRid`, as its documentation and its API's
// description have it. Told to take one size, it answers as an SFU that takes no simulcast would, and
// told to keep to the sizes it sends, it refuses to change one.
//
// It answers for Cloudflare's TURN service as well, which Ember asks beside the SFU
// (apps/worker/src/huddles/relay.ts): asked as the one TURN key it knows, `TURN_KEY`, with the key's API
// token, it makes the servers a browser's connections go by as Cloudflare answers them, the TURN
// server's under another name each time. Their addresses are this machine's, at a port where nothing
// listens, so a browser that goes by them finds no TURN server and reaches the SFU's page as it would
// without. Cloudflare doesn't document how it refuses a key it doesn't know, or a token that isn't the
// key's, so 404 and 401 here are guesses too, and Ember reads 400 and 403 as it does them.

/** What Ember asked the SFU: how, where, with which secret, in which size it asked for each track that comes in several, and how long it asked for a TURN key's servers to last. */
export interface SfuAsked {
  method: string;
  path: string;
  authorization: string | undefined;
  sizes?: string[];
  ttl?: number;
  /** Set once the SFU has answered a request for tracks with one that its session carries from then, published or pulled. */
  carried?: true;
}

/** A server a connection goes by, as Cloudflare's TURN service answers it, and a browser takes it. */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface FakeSfu {
  /** What it was asked, in order. */
  asked: SfuAsked[];
  /** Whether it takes a track sent in several sizes in one alone, which is a test's to say. */
  oneSize: boolean;
  /** Whether it refuses to send a session a track in another size than it sends it in, which is a test's to say too. */
  fixedSizes: boolean;
  /** The servers it made each time it was asked for them as the TURN service, in order. */
  turnServers: IceServer[][];
  close(): Promise<void>;
}

/** A track a browser publishes: the media section of its offer that carries it, and the name it's pulled by. */
interface Published {
  mid: string;
  trackName: string;
}

/** A track another session publishes, as a session pulls it, in the size it names of one that comes in several. */
interface Pulled {
  sessionId: string;
  trackName: string;
  simulcast?: { preferredRid?: string };
}

/** What Ember sends with a request about a session's tracks, or for a TURN key's servers. */
interface AskedOfTracks {
  sessionDescription?: { sdp: string };
  tracks?: Array<Partial<Published & Pulled>>;
  ttl?: number;
}

/** The page's side of the SFU: its sessions' connections, by what Ember asks of them. */
type Relay = JSHandle<{
  publish(sessionId: string, offer: string, tracks: Published[], oneSize: boolean): Promise<unknown>;
  pull(sessionId: string, tracks: Pulled[]): Promise<unknown>;
  resize(sessionId: string, tracks: Array<Pulled & { mid?: string }>, fixed: boolean): Promise<unknown>;
  renegotiate(sessionId: string, answer: string): Promise<unknown>;
  close(sessionId: string, mids: string[]): unknown;
}>;

/** Starts the SFU, which carries what's published through `page`'s connections when it's given one. */
export async function startFakeSfu(page?: Page): Promise<FakeSfu> {
  const relay = page && (await relayOn(page));
  const sfu: FakeSfu = { asked: [], oneSize: false, fixedSizes: false, turnServers: [], close: () => new Promise((resolve) => server.close(() => resolve())) };
  const server = createServer((request, response) => {
    void bodyOf(request).then(async (asked) => {
      const { method = "", url = "" } = request;
      const sizes = (asked.tracks ?? []).flatMap(({ simulcast }) => simulcast?.preferredRid ?? []);
      const asking: SfuAsked = { method, path: url, authorization: request.headers.authorization, ...(sizes.length > 0 && { sizes }), ...(asked.ttl !== undefined && { ttl: asked.ttl }) };
      sfu.asked.push(asking);
      const [, keyId] = TURN_SERVERS.exec(url) ?? [];
      const [status, body] = keyId === undefined ? await answer(request, asked, relay, sfu) : turnServersFor(request, keyId, sfu.turnServers);
      if (givesTrack(method, url, body)) asking.carried = true;
      response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(SFU_PORT, "127.0.0.1", resolve));
  return sfu;
}

async function answer(
  request: IncomingMessage,
  { sessionDescription, tracks = [] }: AskedOfTracks,
  relay: Relay | undefined,
  { oneSize, fixedSizes }: Pick<FakeSfu, "oneSize" | "fixedSizes">,
): Promise<[status: number, body: unknown]> {
  const { method = "", url = "" } = request;
  const [, appId, sessionId, about] = /^\/v1\/apps\/([^/]+)\/sessions\/(?:([^/]+)\/)?(new|tracks\/new|tracks\/update|renegotiate|tracks\/close)$/.exec(url) ?? [];
  if (appId !== SFU_APP.appId) {
    return [404, { errorCode: "not_found", errorDescription: `appId ${appId ?? ""} does not exist. If you created or modified the App recently, it may take up to 60 seconds to reflect changes globally.` }];
  }
  if (request.headers.authorization !== `Bearer ${SFU_APP.appSecret}`) return [401, { errorCode: "unauthorized", errorDescription: "The SFU App Secret was not accepted." }];
  if (sessionId === undefined) return method === "POST" ? [201, { sessionId: randomUUID().replaceAll("-", "") }] : [405, { errorCode: "method_not_allowed" }];
  if (!relay) return [404, { errorCode: "not_found", errorDescription: "This SFU carries nothing." }];

  try {
    switch (`${method} ${about}`) {
      case "POST tracks/new":
        if (sessionDescription) {
          return [200, await relay.evaluate((relay, [id, offer, tracks, oneSize]) => relay.publish(id, offer, tracks, oneSize), [sessionId, sessionDescription.sdp, tracks as Published[], oneSize] as const)];
        }
        return [200, await relay.evaluate((relay, [id, tracks]) => relay.pull(id, tracks), [sessionId, tracks as Pulled[]] as const)];
      case "PUT tracks/update":
        return [200, await relay.evaluate((relay, [id, tracks, fixed]) => relay.resize(id, tracks, fixed), [sessionId, tracks as Array<Pulled & { mid?: string }>, fixedSizes] as const)];
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

/**
 * Whether the SFU's answer to a request gives its session a track: an answer about new tracks that names
 * no error for one of them. Asked only for what nobody publishes any more, a session is given none.
 */
const givesTrack = (method: string, url: string, body: unknown) =>
  method === "POST" && url.endsWith("/tracks/new") && ((body as { tracks?: Array<{ errorCode?: string }> }).tracks ?? []).some(({ errorCode }) => errorCode === undefined);

/** Where the TURN service is asked for the servers a connection goes by, as the TURN key the address names. */
const TURN_SERVERS = /^\/v1\/turn\/keys\/([^/]+)\/credentials\/generate-ice-servers$/;

/**
 * What the TURN service answers a request for servers made as the TURN key `keyId`: the servers, which
 * it adds to `made`, or why it makes none. Among the TURN server's addresses is one at the port
 * browsers won't connect to, as among Cloudflare's, which Ember is to leave out.
 */
function turnServersFor(request: IncomingMessage, keyId: string, made: IceServer[][]): [status: number, body: unknown] {
  if (request.method !== "POST") return [405, { errorCode: "method_not_allowed" }];
  if (keyId !== TURN_KEY.keyId) return [404, { errorCode: "not_found", errorDescription: "The TURN key was not found." }];
  if (request.headers.authorization !== `Bearer ${TURN_KEY.apiToken}`) return [401, { errorCode: "unauthorized", errorDescription: "The TURN key's API token was not accepted." }];
  const at = `127.0.0.1:${TURN_PORT}`;
  const iceServers: IceServer[] = [
    { urls: [`stun:${at}`] },
    { urls: [`turn:${at}?transport=udp`, `turn:${at}?transport=tcp`, "turn:127.0.0.1:53?transport=udp"], username: `e2e-turn-${made.length + 1}`, credential: "e2e-only-not-a-credential" },
  ];
  made.push(iceServers);
  return [201, { iceServers }];
}

/** What a request carries, read as JSON, or nothing. */
async function bodyOf(request: IncomingMessage): Promise<AskedOfTracks> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString()) as AskedOfTracks);
}

/** Makes `page` the SFU's connections: one a session, each made by the first request about its session. */
async function relayOn(page: Page): Promise<Relay> {
  // Chromium names a page's own addresses only for a page that may use a microphone. Any other's it
  // gives names that only its own network finds, which a test server's has nobody to answer.
  await page.context().grantPermissions(["microphone"]);
  return page.evaluateHandle(() => {
    /** A track a session publishes: the media section the browser's offer has it on, and what the connection receives of it, by the name of each size it's sent in, or under no name where it's sent in one. */
    interface Publication {
      mid: string;
      sizes: Map<string, MediaStreamTrack>;
    }
    interface Session {
      connection: RTCPeerConnection;
      /** What it publishes, by the name it's pulled by. */
      published: Map<string, Publication>;
      /** What it's sent, by the media section that carries it. */
      pulled: Map<string, Pulled>;
      /** The media sections whose tracks have been closed. */
      closed: Set<string>;
    }
    /** The sizes an offer sends its track in at once, by name, and the media section that carries them. */
    interface Sizes {
      mid: string;
      rids: string[];
    }
    const sessions = new Map<string, Session>();
    const playing = new Map<MediaStreamTrack, HTMLMediaElement>();

    const sessionOf = (sessionId: string): Session => {
      const session = sessions.get(sessionId) ?? { connection: new RTCPeerConnection({ bundlePolicy: "max-bundle" }), published: new Map(), pulled: new Map(), closed: new Set() };
      sessions.set(sessionId, session);
      return session;
    };

    /** What a packet says of itself, by the extension that carries it: its media section's name, its size's, and the size it repairs. */
    const SECTION = "urn:ietf:params:rtp-hdrext:sdes:mid";
    const SIZE = "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id";
    const REPAIRED = "urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id";
    const carries = (line: string, ...extensions: string[]) => line.startsWith("a=extmap:") && extensions.some((extension) => line.endsWith(extension));

    /** A description's lines: its session's, and each media section's. */
    const linesOf = (sdp: string) => {
      const lines = sdp.split("\r\n").filter(Boolean);
      const first = lines.findIndex((line) => line.startsWith("m="));
      const sections: string[][] = [];
      for (const line of lines.slice(first)) {
        if (line.startsWith("m=")) sections.push([]);
        sections.at(-1)!.push(line);
      }
      return { session: lines.slice(0, first), sections };
    };
    /** The description of those lines, whose connection carries the media sections `mids` together. */
    const describing = (session: string[], mids: string[], sections: string[][]) =>
      [...session.map((line) => (line.startsWith("a=group:BUNDLE") ? `a=group:BUNDLE ${mids.join(" ")}` : line)), ...sections.flat()].join("\r\n") + "\r\n";

    /** The sizes an offer of one media section sends its track in, where it sends several at once. */
    const sizesIn = (offer: string): Sizes | null => {
      const { sections } = linesOf(offer);
      const mid = sections[0]?.find((line) => line.startsWith("a=mid:"))?.slice("a=mid:".length);
      const sent = sections[0]?.find((line) => line.startsWith("a=simulcast:send "))?.slice("a=simulcast:send ".length);
      return sections.length === 1 && mid !== undefined && sent ? { mid, rids: sent.split(";") } : null;
    };

    /**
     * Chromium receives a track in one size. So an offer that sends one in several is given to the
     * connection as an offer of a media section for each size, named after it, whose packets say their
     * size's name where they would say their section's: each size arrives as a track of its own.
     */
    const layered = (offer: string, { rids }: Sizes) => {
      const { session, sections } = linesOf(offer);
      const sent = sections[0]!;
      const named = sent.find((line) => carries(line, SIZE))!.split(" ")[0]!;
      const each = rids.map((rid) =>
        sent
          .filter((line) => !line.startsWith("a=rid:") && !line.startsWith("a=simulcast:") && !carries(line, SECTION, SIZE, REPAIRED))
          .flatMap((line) => (line.startsWith("a=mid:") ? [`a=mid:${rid}`, `${named} ${SECTION}`] : line.startsWith("a=msid:") ? [`${line}-${rid}`] : [line])),
      );
      return describing(session, rids, each);
    };

    /** The connection's answer to such an offer, as an answer to the offer the browser made: its one media section, which takes every size. */
    const unlayered = (answer: string, { mid, rids }: Sizes, offer: string) => {
      const { session, sections } = linesOf(answer);
      const extensions = linesOf(offer).sections[0]!.filter((line) => carries(line, SECTION, SIZE, REPAIRED));
      const section = sections[0]!.filter((line) => !carries(line, SECTION)).flatMap((line) => (line.startsWith("a=mid:") ? [`a=mid:${mid}`, ...extensions] : [line]));
      return describing(session, [mid], [[...section, ...rids.map((rid) => `a=rid:${rid} recv`), `a=simulcast:recv ${rids.join(";")}`]]);
    };

    /** What a publication has of the size `rid`, or where it has none of that name, of the first of its sizes by the alphabet, which is how Ember has the SFU fall back. */
    const inSize = ({ sizes }: Publication, rid = "") => sizes.get(rid) ?? sizes.get([...sizes.keys()].sort()[0]!)!;

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
      async publish(sessionId: string, offer: string, tracks: Published[], oneSize: boolean) {
        const { connection, published } = sessionOf(sessionId);
        const sizes = oneSize ? null : sizesIn(offer);
        await connection.setRemoteDescription({ type: "offer", sdp: sizes ? layered(offer, sizes) : offer });
        const receivedOn = (mid: string) => connection.getTransceivers().find((transceiver) => transceiver.mid === mid)?.receiver.track;
        const taken = tracks.map(({ mid, trackName }) => {
          const received = new Map((sizes?.mid === mid ? sizes.rids : [""]).map((rid) => [rid, receivedOn(rid || mid)]));
          if ([...received.values()].some((track) => !track)) return { mid, trackName, errorCode: "invalid_request", errorDescription: "No such media section" };
          published.set(trackName, { mid, sizes: received as Map<string, MediaStreamTrack> });
          for (const track of received.values()) play(track!);
          return { mid, trackName };
        });
        const answer = await described(connection, await connection.createAnswer());
        return { requiresImmediateRenegotiation: false, sessionDescription: sizes ? { ...answer, sdp: unlayered(answer.sdp, sizes, offer) } : answer, tracks: taken };
      },

      async pull(sessionId: string, tracks: Pulled[]) {
        const { connection, pulled } = sessionOf(sessionId);
        const sent = tracks.map((asked) => {
          const publication = sessions.get(asked.sessionId)?.published.get(asked.trackName);
          return { asked, transceiver: publication && connection.addTransceiver(inSize(publication, asked.simulcast?.preferredRid), { direction: "sendonly" }) };
        });
        if (!sent.some(({ transceiver }) => transceiver)) return { requiresImmediateRenegotiation: false, tracks: tracks.map(notFound) };
        const sessionDescription = await described(connection, await connection.createOffer());
        for (const { asked, transceiver } of sent) if (transceiver?.mid) pulled.set(transceiver.mid, asked);
        return {
          requiresImmediateRenegotiation: true,
          sessionDescription,
          tracks: sent.map(({ asked, transceiver }) => (transceiver ? { sessionId: asked.sessionId, trackName: asked.trackName, mid: transceiver.mid } : notFound(asked))),
        };
      },

      /** Sends a session what it pulls in another of its sizes, unless its sizes are `fixed`. Cloudflare documents no error for a track it can't change, so this one's code is a guess, which Ember reads as it does any. */
      async resize(sessionId: string, tracks: Array<Pulled & { mid?: string }>, fixed: boolean) {
        const session = sessions.get(sessionId);
        const resized = tracks.map(async ({ mid = "", sessionId: from, trackName, simulcast }) => {
          const transceiver = session?.connection.getTransceivers().find((transceiver) => transceiver.mid === mid);
          const sent = session?.pulled.get(mid);
          const publication = sessions.get(from)?.published.get(trackName);
          if (fixed || !session || !transceiver || !publication || session.closed.has(mid) || sent?.sessionId !== from || sent.trackName !== trackName) {
            return { mid, sessionId: from, trackName, errorCode: "invalid_params", errorDescription: "Track not found" };
          }
          await transceiver.sender.replaceTrack(inSize(publication, simulcast?.preferredRid));
          return { mid, sessionId: from, trackName };
        });
        return { requiresImmediateRenegotiation: false, tracks: await Promise.all(resized) };
      },

      async renegotiate(sessionId: string, answer: string) {
        await sessionOf(sessionId).connection.setRemoteDescription({ type: "answer", sdp: answer });
        return {};
      },

      close(sessionId: string, mids: string[]) {
        const session = sessions.get(sessionId);
        const closed = mids.map((mid) => {
          // A track that came in several sizes is on a media section for each, which the one the browser's offer had it on stands for.
          const [trackName, publication] = [...(session?.published ?? [])].find(([, publication]) => publication.mid === mid) ?? [];
          const carrying = publication ? [...publication.sizes.keys()].map((rid) => rid || mid) : [mid];
          const transceivers = carrying.flatMap((mid) => session?.connection.getTransceivers().find((transceiver) => transceiver.mid === mid) ?? []);
          if (!session || transceivers.length === 0 || session.closed.has(mid)) return { mid, errorCode: "close_track_error", errorDescription: "Track not found" };
          session.closed.add(mid);
          // What it published is no longer there to pull, and whoever pulled it is sent no more of it.
          if (trackName !== undefined) session.published.delete(trackName);
          for (const transceiver of transceivers) {
            const received = transceiver.receiver.track;
            for (const { connection } of sessions.values()) for (const sender of connection.getSenders()) if (sender.track === received) void sender.replaceTrack(null);
            playing.get(received)?.pause();
            playing.delete(received);
            void transceiver.sender.replaceTrack(null);
          }
          return { mid };
        });
        return { requiresImmediateRenegotiation: false, tracks: closed };
      },
    };
  });
}
