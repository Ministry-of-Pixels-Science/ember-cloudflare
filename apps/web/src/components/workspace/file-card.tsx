import type { StoredFile } from "@ember/protocol";
import { Download, Page, ShareAndroid } from "@/components/icons/iconoir";
import { ShareButton } from "@/components/share-button";
import { canShare } from "@/lib/share";
import { cn } from "@/lib/utils";

/** Campfire's `.message__action-btn`, as a 32px circle, or 44px for fingers. */
const ACTION =
  "grid size-8 flex-none cursor-pointer place-items-center rounded-full text-[0.8rem] touch:size-11 [@media(hover:hover)_and_(pointer:fine)]:hover:not-active:bg-border";

/**
 * The card for a file a message doesn't show as a picture or a video: the file's icon on a tile, its
 * name, which wraps anywhere rather than overflow, Download, which Ember added to an iPhone's or iPad's
 * home screen hides, as Campfire's `.hide-in-ios-pwa` does, since it can't download, and Share, where
 * the browser can share, which shares the file untitled.
 */
export function FileCard({ file }: { file: StoredFile }) {
  return (
    <div className="my-[5px] inline-flex w-fit max-w-full items-center gap-2.5 rounded-[10px] border px-2.5 py-2">
      <Page className="size-9 flex-none rounded-[7px] bg-surface p-[7px]" />
      <span className="min-w-0 flex-1 font-medium wrap-anywhere">{file.name}</span>
      <a href={file.downloadUrl} download className={cn(ACTION, "ios-pwa:hidden")}>
        <Download className="size-[1.3em]" />
        <span className="sr-only">Download {file.name}</span>
      </a>
      {canShare() && (
        <ShareButton url={file.downloadUrl} className={ACTION}>
          <ShareAndroid className="size-[1.3em]" />
          <span className="sr-only">Share {file.name}</span>
        </ShareButton>
      )}
    </div>
  );
}
