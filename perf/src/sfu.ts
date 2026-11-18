import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

// Cloudflare's Realtime SFU for the huddle scenario, as far as a huddle of voices asks it
// (apps/worker/src/huddles/sfu.ts): a server on this machine, which the scenario's `wrangler dev` is
// told of as REALTIME_SFU_URL, that starts sessions for the one app it knows, takes the voice a
// session publishes, offers a session the voices it pulls, takes its answer, and closes tracks.
//
// Nothing is heard through it. What people say goes between their browsers and the SFU, and never
// through Ember, so the scenario times what a huddle has the room do, and this counts what the room
// asks of the SFU for it. It answers at once, so those timings are the room's own: Cloudflare's SFU
// adds however long it takes to answer.

/** The SFU app it knows, by its ID and its secret, which the scenario gives Ember. Neither is real. */
export const SFU_APP = { appId: "perf".repeat(8), appSecret: "perf".repeat(16) };

/** What the SFU says of a track nobody publishes. */
const NOT_PUBLISHED = "not_found_track_error";

export interface StandInSfu {
  /** Where it listens, which the Worker's REALTIME_SFU_URL names. */
  url: string;
  /** How many requests it has answered. */
  readonly requests: number;
  close(): Promise<void>;
}

/** A session description's lines for one voice, about as long as a browser's or the SFU's for it. */
const voiceLines = (mid: number) => [
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:perf",
  "a=ice-pwd:perfperfperfperfperfperf",
  "a=ice-options:trickle",
  `a=fingerprint:sha-256 ${Array.from({ length: 32 }, () => "5F").join(":")}`,
  "a=setup:actpass",
  `a=mid:${mid}`,
  "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
  "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
  "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
  "a=sendrecv",
  `a=msid:perf voice-${mid}`,
  "a=rtcp-mux",
  "a=rtpmap:111 opus/48000/2",
  "a=rtcp-fb:111 transport-cc",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  `a=ssrc:${1000 + mid} cname:perf`,
];

/**
 * A session description for `voices` of them: its opening lines, and a media section for each. Nobody
 * here reads one, so only its length counts, which is what the room carries between a tab and the SFU.
 */
export function sessionDescription(voices: number): string {
  const mids = Array.from({ length: voices }, (_, mid) => mid);
  const opening = ["v=0", "o=- 4611731400430051336 2 IN IP4 127.0.0.1", "s=-", "t=0 0", `a=group:BUNDLE ${mids.join(" ")}`, "a=msid-semantic: WMS"];
  return [...opening, ...mids.flatMap(voiceLines), ""].join("\r\n");
}

/** A connection of a tab's, as the SFU keeps it. */
interface Session {
  /** The tracks it publishes, by the media sections that carry them: each one's name, which the others pull it by. */
  published: Map<string, string>;
  /** How many media sections it has been offered, each of which carries a track it pulls. */
  offered: number;
}

/** A track as a request names it: one a session publishes, by its media section, or one it pulls, by the session that publishes it. */
type Track = Record<string, unknown>;

interface Answer {
  status: number;
  said: unknown;
}

const said = (said: unknown, status = 200): Answer => ({ status, said });
const refused = (status: number, errorCode: string): Answer => said({ errorCode, errorDescription: `The stand-in SFU's ${errorCode}` }, status);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What a request sent, read as JSON, or null when it sent nothing that is. */
async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } catch {
    return null;
  }
}

/** Starts a stand-in for the Realtime SFU at a port of its own on this machine. */
export async function standInSfu(): Promise<StandInSfu> {
  const sessions = new Map<string, Session>();
  let requests = 0;

  /** Takes the tracks a session publishes with its offer, and answers the offer. */
  function publish(session: Session, tracks: Track[]): Answer {
    for (const { mid, trackName } of tracks) session.published.set(String(mid), String(trackName));
    return said({
      requiresImmediateRenegotiation: false,
      sessionDescription: { type: "answer", sdp: sessionDescription(tracks.length) },
      tracks: tracks.map(({ mid, trackName }) => ({ mid, trackName })),
    });
  }

  /** Offers a session the tracks it pulls that their sessions publish, each in a media section of its own, beside those it carries already. */
  function pull(session: Session, tracks: Track[]): Answer {
    const results = tracks.map(({ sessionId, trackName }) => {
      const published = [...(sessions.get(String(sessionId))?.published.values() ?? [])].includes(String(trackName));
      return published ? { sessionId, trackName, mid: String(session.offered++) } : { sessionId, trackName, errorCode: NOT_PUBLISHED, errorDescription: "Track not found" };
    });
    if (results.every((result) => "errorCode" in result)) return said({ requiresImmediateRenegotiation: false, tracks: results });
    return said({ requiresImmediateRenegotiation: true, sessionDescription: { type: "offer", sdp: sessionDescription(session.offered) }, tracks: results });
  }

  /** Closes the tracks a session carries in the media sections named: those it publishes are nobody's to pull from then. */
  function close(session: Session, tracks: Track[]): Answer {
    for (const { mid } of tracks) session.published.delete(String(mid));
    return said({ requiresImmediateRenegotiation: false, tracks: tracks.map(({ mid }) => ({ mid })) });
  }

  function answer(method: string, path: string, authorization: string | undefined, body: unknown): Answer {
    const [, appId, asked] = /^\/v1\/apps\/([^/]+)(\/.*)$/.exec(path) ?? [];
    if (appId !== SFU_APP.appId || asked === undefined) return refused(404, "not_found");
    if (authorization !== `Bearer ${SFU_APP.appSecret}`) return refused(401, "unauthorized");
    if (method === "POST" && asked === "/sessions/new") {
      const sessionId = randomUUID().replaceAll("-", "");
      sessions.set(sessionId, { published: new Map(), offered: 0 });
      return said({ sessionId }, 201);
    }
    const [, sessionId = "", what] = /^\/sessions\/([^/]+)(\/.*)$/.exec(asked) ?? [];
    const session = sessions.get(sessionId);
    if (!session) return refused(410, "session_error");
    // The answer a tab makes to an offer: the session then carries what the offer added.
    if (method === "PUT" && what === "/renegotiate") return said({});
    const tracks = isRecord(body) && Array.isArray(body.tracks) ? body.tracks.filter(isRecord) : [];
    if (method === "POST" && what === "/tracks/new") return isRecord(body) && isRecord(body.sessionDescription) ? publish(session, tracks) : pull(session, tracks);
    if (method === "PUT" && what === "/tracks/close") return close(session, tracks);
    return refused(404, "not_found");
  }

  const server = createServer((request, response) => {
    void bodyOf(request).then((body) => {
      const { status, said } = answer(request.method ?? "", request.url ?? "", request.headers.authorization, body);
      requests++;
      response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(said));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get requests() {
      return requests;
    },
    async close() {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
  };
}
