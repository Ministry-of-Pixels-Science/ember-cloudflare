import { listsSpeaker, watchDevices } from "./huddle-devices";

/** What a browser takes for the person's touch, and lets a sound or a video play from. A tap is one at its click, and not as the finger lands. */
export const TOUCHES = ["click", "keydown"] as const;

/** Plays `audio` through the speaker `deviceId`, or the system's for none. Safari has no way to choose one, and plays through the system's. */
function playThrough(audio: HTMLAudioElement, deviceId: string): void {
  if (typeof audio.setSinkId === "function") void audio.setSinkId(deviceId).catch(() => {});
}

/** What a huddle plays its `<audio>`s through: the others' voices, its music and its sounds. */
export interface HuddleSpeaker {
  /** Plays `audio` from now until it's stopped, in the page, hidden. */
  play(audio: HTMLAudioElement): void;
  /** Stops `audio` where it is, and takes it out of the page. */
  stop(audio: HTMLAudioElement): void;
  /** Plays `audio` once, from its start, without the page: a sound that's over before anything could change for it. */
  playOnce(audio: HTMLAudioElement): void;
  /** Stops all it plays until stopped, for good. What plays once plays out. */
  stopAll(): void;
}

/**
 * The speaker a huddle plays through: `speakerId`'s, or the system's when that's empty, and for as long
 * as that speaker is unplugged, when it would play nothing. What plays until it's stopped is kept in
 * the page, and a browser that won't play it until the person has touched the page plays it at their
 * next click or key.
 */
export function huddleSpeaker(speakerId: string): HuddleSpeaker {
  const playing = new Set<HTMLAudioElement>();
  const box = document.createElement("div");
  box.hidden = true;
  box.dataset.huddleVoices = "";
  /** The speaker they play through now, by its device's id, or empty for the system's. */
  let speaker = speakerId;
  const followSpeaker = async () => {
    if (!speakerId) return;
    speaker = (await listsSpeaker(speakerId)) ? speakerId : "";
    for (const audio of playing) playThrough(audio, speaker);
  };
  const stopWatching = watchDevices(() => void followSpeaker());
  /**
   * Has `audio` play through the speaker of now, where it last played through another: what's played again
   * may have played last through a speaker that has been unplugged since, or plugged back in.
   */
  const through = (audio: HTMLAudioElement) => {
    if ((audio.sinkId ?? "") !== speaker) playThrough(audio, speaker);
  };
  const playRefused = () => {
    for (const audio of playing) if (audio.paused) void audio.play().catch(() => {});
  };
  // In the capture phase, which hears a click that whatever it lands on keeps to itself.
  const playOnceTouched = () => {
    for (const touch of TOUCHES) document.addEventListener(touch, playRefused, true);
  };
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
    stopAll() {
      for (const audio of [...playing]) stop(audio);
      for (const touch of TOUCHES) document.removeEventListener(touch, playRefused, true);
      stopWatching();
      box.remove();
    },
  };
}
