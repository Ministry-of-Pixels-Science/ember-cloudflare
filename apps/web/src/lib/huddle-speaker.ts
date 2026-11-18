import { listsSpeaker, watchDevices } from "./huddle-devices";
import { whenShownAgain } from "./visibility";

/** What a browser takes for the person's touch, and lets a sound or a video play from. A tap is one at its click, and not as the finger lands. */
export const TOUCHES = ["click", "keydown"] as const;

/** Plays `audio` through the speaker `deviceId`, or the system's for none, and answers whether the browser would. Safari has no way to choose one, and plays through the system's. */
async function playThrough(audio: HTMLAudioElement, deviceId: string): Promise<boolean> {
  if (typeof audio.setSinkId !== "function") return true;
  return audio.setSinkId(deviceId).then(
    () => true,
    () => false,
  );
}

/** What a huddle plays its `<audio>`s through: the others' voices, its music and its sounds. */
export interface HuddleSpeaker {
  /** Plays `audio` from now until it's stopped, in the page, hidden. */
  play(audio: HTMLAudioElement): void;
  /** Stops `audio` where it is, and takes it out of the page. */
  stop(audio: HTMLAudioElement): void;
  /** Plays `audio` once, from its start, without the page: a sound that's over before anything could change for it. */
  playOnce(audio: HTMLAudioElement): void;
  /**
   * Plays through the speaker `deviceId` from now, or the system's when that's empty, and answers
   * whether the browser would: one it won't play through leaves the huddle on the one before. One
   * chosen while the browser takes up another waits for that one.
   */
  use(deviceId: string): Promise<boolean>;
  /** Stops all it plays until stopped, for good. What plays once plays out. */
  stopAll(): void;
}

/**
 * The speaker a huddle plays through: `speakerId`'s until its person chooses another, or the system's
 * when that's empty, and for as long as the one chosen is unplugged, when it would play nothing. What
 * plays until it's stopped is kept in the page, and a browser that won't play it until the person has
 * touched the page plays it at their next click or key. A phone's browser can stop what a page plays
 * while the page is hidden, so what it had stopped plays again as the page shows again, or at their
 * next click or key where the browser won't play it before.
 */
export function huddleSpeaker(speakerId: string): HuddleSpeaker {
  const playing = new Set<HTMLAudioElement>();
  const box = document.createElement("div");
  box.hidden = true;
  box.dataset.huddleVoices = "";
  /** The speaker its person chose, by its device's id, or empty for the system's. */
  let chosen = speakerId;
  /** The speaker they play through now: the one chosen, or the system's while that's unplugged. */
  let speaker = chosen;
  /** The change of speaker under way, if its person has asked for one, which another they choose meanwhile waits for. */
  let changing: Promise<boolean> | null = null;
  const playAllThrough = async (deviceId: string) => {
    speaker = deviceId;
    const played = await Promise.all([...playing].map((audio) => playThrough(audio, deviceId)));
    return played.every(Boolean);
  };
  /** Plays through the speaker `deviceId`, and answers whether the browser would: refused, it's back on the one before. */
  const change = async (deviceId: string) => {
    const before = { chosen, speaker };
    chosen = deviceId;
    if (await playAllThrough(deviceId)) return true;
    chosen = before.chosen;
    await playAllThrough(before.speaker);
    return false;
  };
  const followSpeaker = async () => {
    const followed = chosen;
    if (!followed) return;
    const listed = await listsSpeaker(followed);
    // Another chosen meanwhile is the one to play through.
    if (chosen === followed) void playAllThrough(listed ? followed : "");
  };
  const stopWatching = watchDevices(() => void followSpeaker());
  /**
   * Has `audio` play through the speaker of now, where it last played through another: what's played again
   * may have played last through a speaker that has been unplugged since, or plugged back in.
   */
  const through = (audio: HTMLAudioElement) => {
    if ((audio.sinkId ?? "") !== speaker) void playThrough(audio, speaker);
  };
  /** Plays what the browser refused to, or has stopped, and what it refuses now at the person's next touch. */
  const playPaused = () => {
    for (const audio of playing) if (audio.paused) void audio.play().catch(playOnceTouched);
  };
  // In the capture phase, which hears a click that whatever it lands on keeps to itself.
  const playOnceTouched = () => {
    for (const touch of TOUCHES) document.addEventListener(touch, playPaused, true);
  };
  const stopWatchingPage = whenShownAgain(playPaused);
  const stop = (audio: HTMLAudioElement) => {
    audio.pause();
    audio.remove();
    playing.delete(audio);
  };
  return {
    play(audio) {
      through(audio);
      playing.add(audio);
      if (!box.isConnected) document.body.append(box);
      box.append(audio);
      void audio.play().catch(playOnceTouched);
    },
    stop,
    playOnce(audio) {
      through(audio);
      audio.currentTime = 0;
      // Refused, it plays nothing: by the person's next touch, the moment has passed.
      void audio.play().catch(() => {});
    },
    // One change at a time, in the order they were chosen: the browser may finish the later of two
    // first, and one it refuses goes back to where the one before it left the huddle.
    use(deviceId) {
      const changed = changing ? changing.then(() => change(deviceId)) : change(deviceId);
      changing = changed;
      void changed.then(() => {
        if (changing === changed) changing = null;
      });
      return changed;
    },
    stopAll() {
      for (const audio of [...playing]) stop(audio);
      for (const touch of TOUCHES) document.removeEventListener(touch, playPaused, true);
      stopWatchingPage();
      stopWatching();
      box.remove();
    },
  };
}
