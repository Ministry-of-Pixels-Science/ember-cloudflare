import type { HuddleSpeaker } from "./huddle-speaker";
// Each a file of its own, which the page's content policy lets it fetch, as it wouldn't a `data:` address.
import joinedUrl from "./huddle-sounds/joined.mp3?no-inline";
import leftUrl from "./huddle-sounds/left.mp3?no-inline";
import musicUrl from "./huddle-sounds/music.mp3?no-inline";

/** How long someone is the only one in a huddle before its music starts. */
export const MUSIC_AFTER_MS = 5_000;

/** The browser's own copies of the sounds' files this page has fetched, by the files' addresses. */
const copies = new Map<string, Promise<string>>();

/**
 * The address of the browser's own copy of the file at `url`, fetched whole the first time the page asks
 * for it, and again after a time it couldn't be. An `<audio>` given the file's own address asks for it a
 * part at a time, which Safari, for one, needs answered in parts, and Cloudflare answers with the whole
 * of a Worker's static file.
 */
function copyOf(url: string): Promise<string> {
  let copy = copies.get(url);
  if (!copy) {
    copy = fetchCopy(url);
    copies.set(url, copy);
    copy.catch(() => copies.delete(url));
  }
  return copy;
}

async function fetchCopy(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: "audio/mpeg" }));
}

/** One of the huddle's sounds (huddle-sounds/README.md), which the page can tell by its `<audio>`'s name. */
interface Sound {
  audio: HTMLAudioElement;
  /** Gives the `<audio>` its file, unless it has it, and resolves once it can play it. */
  load(): Promise<void>;
}

function sound(name: string, url: string): Sound {
  const audio = document.createElement("audio");
  audio.dataset.huddleSound = name;
  return {
    audio,
    async load() {
      if (audio.src) return;
      const copy = await copyOf(url);
      // Given once: giving an `<audio>` its file again would stop what it plays.
      if (!audio.src) audio.src = copy;
    },
  };
}

/**
 * A huddle's own sounds, where Slack's has them: one as someone joins, the tab's person among them,
 * another as someone leaves, and music for whoever is the only one in the huddle, which starts five
 * seconds after they find themselves alone, stops as soon as they aren't, and goes on from where it
 * stopped the next time. Each is as loud as its file is, as a phone's browser plays an `<audio>` at no
 * volume but the phone's own.
 */
export function huddleSounds(speaker: HuddleSpeaker) {
  const joined = sound("joined", joinedUrl);
  const left = sound("left", leftUrl);
  const music = sound("music", musicUrl);
  music.audio.loop = true;
  let alone = false;
  /** Whether the huddle has ended for the tab, after which it plays nothing but the sound of its ending. */
  let ended = false;
  /** Runs out once its person has been alone long enough to hear the music. */
  let musicTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Plays `sound` as soon as it has its file, unless the huddle has ended by then, which only its `last`
   * sound outlasts: a sound that came late would be heard after the huddle, or in the next. One whose
   * file can't be fetched goes unplayed.
   */
  const playOnce = ({ audio, load }: Sound, last = false) =>
    void load().then(
      () => {
        if (last || !ended) speaker.playOnce(audio);
      },
      () => {},
    );
  // Fetched as the huddle is joined, so that each is there to play the moment it's due.
  for (const each of [joined, left]) void each.load().catch(() => {});

  const setAlone = (now: boolean) => {
    if (now === alone) return;
    alone = now;
    clearTimeout(musicTimer);
    musicTimer = undefined;
    if (!alone) return speaker.stop(music.audio);
    // Fetched while they wait, and so never for a huddle nobody is alone in.
    const loading = music.load().then(() => true, () => false);
    const waited: ReturnType<typeof setTimeout> = (musicTimer = setTimeout(async () => {
      // Not once they've stopped being alone, even if they are again by now.
      if ((await loading) && musicTimer === waited) speaker.play(music.audio);
    }, MUSIC_AFTER_MS));
  };

  return {
    /** Someone joined the huddle. */
    joined: () => playOnce(joined),
    /** Someone else left it. */
    left: () => playOnce(left),
    /** Says whether the tab's person is the only one in the huddle now. */
    setAlone,
    /** The huddle has ended for the tab: its music stops, and the sound of leaving plays if the room had let the tab in. */
    end(letIn: boolean) {
      setAlone(false);
      ended = true;
      if (letIn) playOnce(left, true);
    },
  };
}
