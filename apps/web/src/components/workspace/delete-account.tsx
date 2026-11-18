import { useRef, useState, type FormEvent } from "react";
import { MAX_PASSWORD_LENGTH, MAX_USER_NAME_LENGTH, type AccountDeletion } from "@ember/protocol";
import { AUTH_FORM } from "@/components/auth-page";
import { FIELD_INPUT, Field } from "@/components/field";
import { Trash } from "@/components/icons/iconoir";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { isSignedOut } from "@/lib/api";
import { NEGATIVE_BUTTON } from "./room-settings-page";

// Delete my account, at the bottom of your profile, as Apple asks of every app with accounts: a button
// that asks once more, for your password while you have one, or else for your name, typed as your
// profile has it, and then deletes your account, with your messages, files and reactions in every room,
// which can take a few minutes, and signs this browser out. Boxed as the Memberful section is.

/** What the sign-in page says once your account is deleted. */
export const ACCOUNT_DELETED = "Your account is deleted. It can take a few minutes for your messages to leave every room.";

/** A plain button beside the negative one, as tall. */
const CANCEL_BUTTON =
  "inline-flex min-h-9 cursor-pointer items-center justify-center rounded-[9px] border bg-background px-[1.1em] py-[0.5em] font-medium touch:min-h-11 hover:not-active:brightness-90 disabled:pointer-events-none disabled:opacity-50";

interface Props {
  /** Your name, as your profile has it, which someone without a password types. */
  name: string;
  /** Whether you have a password, which it asks for then. */
  hasPassword: boolean;
  /** Deletes your account, saying you mean it with `deletion`, settling once it's deleted, or failing with why not. */
  onDelete: (deletion: AccountDeletion) => Promise<void>;
  /** Says why your account wasn't deleted, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Delete my account, which shows what it deletes, and once pressed, the field that says you mean it. */
export function DeleteAccount({ name, hasPassword, onDelete, onFailed }: Props) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useMounted();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const typed = input.current?.value ?? "";
    // Once it's deleted, the page goes to sign in.
    onDelete(hasPassword ? { currentPassword: typed } : { name: typed }).catch((error: unknown) => {
      if (!mounted.current && !isSignedOut(error)) return;
      setBusy(false);
      if (input.current) input.current.value = "";
      onFailed(error);
    });
  };

  const deleteButton = (type: "button" | "submit", onClick?: () => void) => (
    <button type={type} disabled={busy} onClick={onClick} className={NEGATIVE_BUTTON}>
      <Trash className="size-[1.3em] shrink-0" />
      <span>Delete my account</span>
    </button>
  );

  return (
    <section aria-labelledby="delete-account-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 max-md:px-3">
      <h2 id="delete-account-heading" className="text-base font-semibold">
        Delete my account
      </h2>
      <p id="delete-account-help">
        This deletes your messages, files and reactions in every room and DM, and your name, photo, bio and email address. It can&apos;t be undone, and
        it can take a few minutes to reach every room.
      </p>
      {asking ? (
        <form onSubmit={submit} className={AUTH_FORM}>
          {hasPassword ? (
            <Field id="delete_account_password" label="Your password" translation="password">
              {/* Uncontrolled, as the profile's password fields are. */}
              <Input
                ref={input}
                id="delete_account_password"
                type="password"
                required
                autoFocus
                autoComplete="current-password"
                placeholder="Enter your password"
                maxLength={MAX_PASSWORD_LENGTH}
                aria-describedby="delete-account-help"
                className={FIELD_INPUT}
              />
            </Field>
          ) : (
            <Field id="delete_account_name" label={`Type your name, ${name}, to delete your account`}>
              <Input
                ref={input}
                id="delete_account_name"
                required
                autoFocus
                autoComplete="off"
                data-1p-ignore
                placeholder={name}
                maxLength={MAX_USER_NAME_LENGTH}
                aria-describedby="delete-account-help"
                className={FIELD_INPUT}
              />
            </Field>
          )}
          <div className="flex flex-wrap gap-2">
            {deleteButton("submit")}
            <button type="button" disabled={busy} onClick={() => setAsking(false)} className={CANCEL_BUTTON}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div>{deleteButton("button", () => setAsking(true))}</div>
      )}
    </section>
  );
}
