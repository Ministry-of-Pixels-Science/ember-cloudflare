import avatarPlaceholder from "@/components/avatar-placeholder.svg";
import { Camera } from "@/components/icons/iconoir";
import type { PhotoChoice } from "@/hooks/use-chosen-photo";

/**
 * Upload photo: Campfire's `.btn`, holding the file field over itself, outlined while the field has
 * focus, and 44px tall for fingers.
 */
const UPLOAD_BUTTON =
  "relative inline-flex cursor-pointer items-center justify-center gap-[0.5em] rounded-[9px] border bg-background px-[1.1em] py-[0.5em] font-medium text-foreground focus-within:outline-2 focus-within:outline-offset-3 focus-within:outline-solid focus-within:outline-foreground touch:min-h-11";

interface Props {
  photo: PhotoChoice;
  disabled: boolean;
  /** What shows until a photo is chosen: the avatar someone has, or else a placeholder. */
  current?: string;
}

/**
 * The photo a join or welcome form sends, which shows as it's chosen, over Upload photo, and says why
 * one is refused in place of "Optional". It can't change while the form is sent with it.
 */
export function PhotoField({ photo, disabled, current = avatarPlaceholder }: Props) {
  return (
    <div className="mx-auto mb-0.5 flex flex-col items-center justify-center gap-2.5">
      <img src={photo.preview ?? current} alt="Your profile photo" width={80} height={80} className="aspect-square w-20 rounded-full object-cover" />
      <label className={UPLOAD_BUTTON}>
        <Camera className="h-5 w-[1.6em]" />
        <input
          ref={photo.input}
          id="user_avatar"
          type="file"
          accept="image/*"
          aria-invalid={photo.refusal ? true : undefined}
          disabled={disabled}
          onChange={photo.choose}
          className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default"
        />
        <span>Upload photo</span>
      </label>
      {photo.refusal ? (
        <span role="alert" className="text-[0.8rem] text-destructive">
          {photo.refusal}
        </span>
      ) : (
        <span className="text-[0.8rem] text-muted-foreground">Optional</span>
      )}
    </div>
  );
}
