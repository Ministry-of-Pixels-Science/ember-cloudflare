import { EmojiPicker as EmojiPickerPrimitive, type EmojiPickerListCategoryHeaderProps, type EmojiPickerListEmojiProps, type EmojiPickerListRowProps } from "frimousse";
import type * as React from "react";
import { Search } from "@/components/icons/iconoir";
import { cn } from "@/lib/utils";

// frimousse's shadcn/ui emoji picker (https://frimousse.liveblocks.io/r/emoji-picker), with Iconoir's search
// icon and Ember's spinner in place of Lucide's, emoji drawn at Slack's picker's size, a footer that
// holds more than the emoji the pointer or the arrow keys are on, and a search sized for fingers on a
// touch screen, in text large enough that iOS doesn't zoom in on it.

function EmojiPicker({ className, ...props }: React.ComponentProps<typeof EmojiPickerPrimitive.Root>) {
  return (
    <EmojiPickerPrimitive.Root
      className={cn("isolate flex h-full w-fit flex-col overflow-hidden rounded-md bg-popover text-popover-foreground", className)}
      data-slot="emoji-picker"
      {...props}
    />
  );
}

function EmojiPickerSearch({ className, ...props }: React.ComponentProps<typeof EmojiPickerPrimitive.Search>) {
  return (
    <div className={cn("flex h-10 items-center gap-2 border-b px-3 touch:h-11", className)} data-slot="emoji-picker-search-wrapper">
      <Search className="size-4 shrink-0 opacity-50" />
      <EmojiPickerPrimitive.Search
        className="flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 touch:h-11 touch:text-base"
        data-slot="emoji-picker-search"
        {...props}
      />
    </div>
  );
}

function EmojiPickerRow({ children, ...props }: EmojiPickerListRowProps) {
  return (
    <div {...props} className="scroll-my-1 px-1.5" data-slot="emoji-picker-row">
      {children}
    </div>
  );
}

function EmojiPickerEmoji({ emoji, className, ...props }: EmojiPickerListEmojiProps) {
  return (
    <button
      {...props}
      className={cn("flex size-8 items-center justify-center rounded-[7px] text-[22px] leading-none data-[active]:bg-hover", className)}
      data-slot="emoji-picker-emoji"
    >
      {emoji.emoji}
    </button>
  );
}

function EmojiPickerCategoryHeader({ category, ...props }: EmojiPickerListCategoryHeaderProps) {
  return (
    <div {...props} className="bg-popover px-3 pt-3 pb-1.5 text-xs leading-none font-medium text-muted-foreground" data-slot="emoji-picker-category-header">
      {category.label}
    </div>
  );
}

function EmojiPickerContent({ className, ...props }: React.ComponentProps<typeof EmojiPickerPrimitive.Viewport>) {
  return (
    <EmojiPickerPrimitive.Viewport className={cn("relative flex-1 outline-hidden", className)} data-slot="emoji-picker-viewport" {...props}>
      <EmojiPickerPrimitive.Loading className="absolute inset-0 flex items-center justify-center text-muted-foreground" data-slot="emoji-picker-loading">
        <span className="spinner ps-[1.5em]">
          <span className="sr-only">Loading emoji…</span>
        </span>
      </EmojiPickerPrimitive.Loading>
      <EmojiPickerPrimitive.Empty className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground" data-slot="emoji-picker-empty">
        No emoji found.
      </EmojiPickerPrimitive.Empty>
      <EmojiPickerPrimitive.List
        className="pb-1 select-none"
        components={{ Row: EmojiPickerRow, Emoji: EmojiPickerEmoji, CategoryHeader: EmojiPickerCategoryHeader }}
        data-slot="emoji-picker-list"
      />
    </EmojiPickerPrimitive.Viewport>
  );
}

/** The emoji the pointer or the arrow keys are on, large, and its name, and whatever else is given. */
function EmojiPickerFooter({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex w-full max-w-(--frimousse-viewport-width) min-w-0 items-center gap-1 border-t p-2", className)} data-slot="emoji-picker-footer" {...props}>
      <EmojiPickerPrimitive.ActiveEmoji>
        {({ emoji }) =>
          emoji ? (
            <>
              <div className="flex size-8 flex-none items-center justify-center text-2xl leading-none">{emoji.emoji}</div>
              <span className="truncate text-xs text-muted-foreground">{emoji.label}</span>
            </>
          ) : (
            <span className="ml-1.5 flex h-8 items-center truncate text-xs text-muted-foreground">Pick an emoji…</span>
          )
        }
      </EmojiPickerPrimitive.ActiveEmoji>
      {children}
    </div>
  );
}

export { EmojiPicker, EmojiPickerSearch, EmojiPickerContent, EmojiPickerFooter };
