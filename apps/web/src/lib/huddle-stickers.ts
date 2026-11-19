import type { HuddleSticker } from "@ember/protocol/huddles";

/** A sticker as a huddle draws it and names it. */
interface StickerLook {
  /** The emoji it's drawn as. */
  emoji: string;
  /** What it's called, where it's chosen and on the tile of whoever shows it, as Slack calls it. */
  name: string;
  /** What a tile that shows it says of its person, for whoever can't see it. */
  shown: string;
}

/** The stickers someone in a huddle can show: a raised hand first, as Slack lists them. */
export const STICKERS: Record<HuddleSticker, StickerLook> = {
  hand: { emoji: "✋", name: "Raise hand", shown: "Hand raised" },
  brb: { emoji: "☕", name: "Be right back", shown: "Be right back" },
  "thumbs-up": { emoji: "👍", name: "Yes", shown: "Yes" },
  "thumbs-down": { emoji: "👎", name: "No", shown: "No" },
  done: { emoji: "✅", name: "Done", shown: "Done" },
};
