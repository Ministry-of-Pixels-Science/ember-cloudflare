import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CURRENT_PASSWORD_WRONG, type AccountDeletion } from "@ember/protocol";
import { ApiError } from "@/lib/api";
import { DeleteAccount } from "./delete-account";

/** Delete my account for Ada, with a password unless `hasPassword` says not, deleting as `onDelete` does. */
function show(hasPassword = true, onDelete = vi.fn(async (_deletion: AccountDeletion) => {})) {
  const onFailed = vi.fn();
  render(<DeleteAccount name="Ada Lovelace" hasPassword={hasPassword} onDelete={onDelete} onFailed={onFailed} />);
  return { onDelete, onFailed, user: userEvent.setup() };
}

const deleteButton = () => screen.getByRole("button", { name: "Delete my account" });
const passwordField = () => screen.queryByLabelText("Your password");

describe("Delete my account", () => {
  it("says what it deletes, and asks nothing until it's pressed", () => {
    show();
    expect(screen.getByRole("region", { name: "Delete my account" })).toHaveTextContent(
      "This deletes your messages, files and reactions in every room and DM, and your name, photo, bio and email address. It can't be undone, and it can take a few minutes to reach every room.",
    );
    expect(passwordField()).toBeNull();
  });

  it("asks once more, for your password, focused, and sends it", async () => {
    const { onDelete, user } = show();
    await user.click(deleteButton());
    expect(passwordField()).toHaveFocus();
    expect(passwordField()).toHaveAccessibleDescription(expect.stringContaining("It can't be undone"));
    await user.click(deleteButton());
    // A blank password isn't sent.
    expect(onDelete).not.toHaveBeenCalled();
    await user.type(passwordField()!, "analytical engine{Enter}");
    expect(onDelete).toHaveBeenCalledExactlyOnceWith({ currentPassword: "analytical engine" });
  });

  it("asks someone without a password to type their name instead", async () => {
    const { onDelete, user } = show(false);
    await user.click(deleteButton());
    expect(passwordField()).toBeNull();
    const name = screen.getByLabelText("Type your name, Ada Lovelace, to delete your account");
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("placeholder", "Ada Lovelace");
    await user.type(name, "Ada Lovelace");
    await user.click(deleteButton());
    expect(onDelete).toHaveBeenCalledExactlyOnceWith({ name: "Ada Lovelace" });
  });

  it("goes back to the button with Cancel", async () => {
    const { onDelete, user } = show();
    await user.click(deleteButton());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(passwordField()).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("can't be sent again while it's deleting", async () => {
    const { onDelete, user } = show(true, vi.fn(() => new Promise<void>(() => {})));
    await user.click(deleteButton());
    await user.type(passwordField()!, "analytical engine");
    await user.click(deleteButton());
    expect(deleteButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.type(passwordField()!, "{Enter}");
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("says why it wasn't deleted, emptying the field for another try", async () => {
    const refusal = new ApiError(422, CURRENT_PASSWORD_WRONG);
    const { onFailed, user } = show(true, vi.fn(async () => Promise.reject(refusal)));
    await user.click(deleteButton());
    await user.type(passwordField()!, "wrong{Enter}");
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledExactlyOnceWith(refusal));
    expect(passwordField()).toHaveValue("");
    expect(deleteButton()).toBeEnabled();
  });
});
