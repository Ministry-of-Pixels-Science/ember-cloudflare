import { EmojiPicker as EmojiPickerPrimitive, useSkinTone, type SkinTone } from "frimousse";
import { useEffect, useState } from "react";
import { EmojiPicker, EmojiPickerContent, EmojiPickerFooter, EmojiPickerSearch } from "@/components/ui/emoji-picker";

// The emoji picker, the composer's and a huddle's reactions', a chunk of its own that loads as either first opens it.

/**
 * Where Emojibase's emoji data is served from Ember itself (vite.config.ts), rather than from a CDN, which
 * the page's Content-Security-Policy wouldn't let it ask, and which would hear from everyone who opens it.
 */
export const EMOJIBASE_URL = "/emojibase";

/** Where the skin tone last picked is kept in this browser. */
const SKIN_TONE = "emoji-skin-tone";

const SKIN_TONES: readonly SkinTone[] = ["none", "light", "medium-light", "medium", "medium-dark", "dark"];

function keptSkinTone(): SkinTone {
  try {
    const kept = localStorage.getItem(SKIN_TONE);
    return SKIN_TONES.find((tone) => tone === kept) ?? "none";
  } catch {
    // Storage can be unavailable, as in some private windows, which only means it isn't kept.
    return "none";
  }
}

/** Keeps the skin tone picked, for the picker to open with. */
function KeepSkinTone() {
  const [skinTone] = useSkinTone();
  useEffect(() => {
    try {
      localStorage.setItem(SKIN_TONE, skinTone);
    } catch {
      // Not kept, then.
    }
  }, [skinTone]);
  return null;
}

interface Props {
  onPick: (emoji: string) => void;
  /** Whether its search has the focus as it shows, to type in at once, as it does unless told otherwise. */
  autoFocus?: boolean;
}

/**
 * Slack's emoji picker: a search of every emoji by name, the emoji by category, the one the pointer or the
 * arrow keys are on, named, and the skin tone, which this browser remembers. Enter picks the emoji the
 * arrow keys are on.
 */
export default function EmojiPanel({ onPick, autoFocus = true }: Props) {
  const [skinTone] = useState(keptSkinTone);
  return (
    <EmojiPicker className="h-[min(380px,60dvh)]" columns={9} skinTone={skinTone} emojibaseUrl={EMOJIBASE_URL} onEmojiSelect={({ emoji }) => onPick(emoji)}>
      <EmojiPickerSearch placeholder="Search all emoji" aria-label="Search all emoji" autoFocus={autoFocus} />
      <EmojiPickerContent />
      <EmojiPickerFooter>
        <EmojiPickerPrimitive.SkinToneSelector className="ms-auto flex size-8 flex-none cursor-pointer items-center justify-center rounded-[7px] text-xl leading-none hover:bg-hover touch:size-11" />
      </EmojiPickerFooter>
      <KeepSkinTone />
    </EmojiPicker>
  );
}
