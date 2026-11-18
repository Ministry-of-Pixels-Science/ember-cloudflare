import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupPage } from "./setup-page";

// Set up Ember where the pages few visits need can't load, as when the connection drops once the form is
// sent: the question about huddles is among them.
vi.mock("@/components/workspace/pages", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});

const workspace = { user: { id: "u1", name: "Ada Lovelace" }, room: { id: "r1", kind: "open", name: "general", icon: null } };

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("Set up the workspace", () => {
  it("opens general without asking about huddles where the question can't load, which leaves them to community settings", async () => {
    history.replaceState(null, "", "/first_run");
    const length = history.length;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(workspace, { status: 201 }));
    const onSetUp = vi.fn();
    render(<SetupPage placeholders={{ name: "Kevin Rose", emailAddress: "kevin@kevinrose.com" }} access="open" onSetUp={onSetUp} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Email address"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onSetUp).toHaveBeenCalledExactlyOnceWith(workspace));
    expect(location.pathname).toBe("/rooms/r1");
    expect(history.length).toBe(length);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
