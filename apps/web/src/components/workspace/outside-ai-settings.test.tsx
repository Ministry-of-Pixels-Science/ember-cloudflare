import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTSIDE_FORBIDDEN } from "@ember/protocol/outside";
import { ApiError } from "@/lib/api";
import { CONFIRM_STOP_OUTSIDE_AI, OUTSIDE_AI_SETTING_EXPLAINED, outsideAiAddress, OutsideAiSettings } from "./outside-ai-settings";

/** Answers changing whether AI apps may connect as Ember would, or as `changed` says, keeping what was sent. */
function serve(changed?: () => Response | Promise<Response>) {
  const sent: Array<[string, unknown]> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    if (request !== "PUT /api/account/outside_ai") throw new Error(`Unexpected request for ${request}`);
    const body = JSON.parse(String(init?.body)) as { on: boolean };
    sent.push([request, body]);
    return changed ? changed() : Response.json(body);
  });
  return sent;
}

/** The card as the AI assistant tab shows it, taking what its switch changes, with outside AI `on` to begin with. */
function Card({ on: began, onFailed }: { on: boolean; onFailed: (error: unknown) => void }) {
  const [on, setOn] = useState(began);
  return <OutsideAiSettings on={on} onChanged={setOn} onFailed={onFailed} />;
}

function showCard(on: boolean) {
  const onFailed = vi.fn();
  render(<Card on={on} onFailed={onFailed} />);
  return { user: userEvent.setup(), onFailed };
}

const card = () => screen.getByRole("region", { name: "Outside AI" });
const theSwitch = () => within(card()).getByRole("switch", { name: "Let AI apps connect to Ember" });
const ADDRESS = outsideAiAddress(`${location.origin}/mcp`);

afterEach(() => vi.restoreAllMocks());

describe("The Outside AI card", () => {
  it("says what letting AI apps connect does, with its switch off while they can't", () => {
    showCard(false);

    expect(within(card()).getByRole("heading", { level: 2, name: "Outside AI" })).toBeVisible();
    expect(theSwitch()).toBeEnabled();
    expect(theSwitch()).not.toBeChecked();
    expect(within(card()).getByText(OUTSIDE_AI_SETTING_EXPLAINED)).toBeVisible();
    expect(theSwitch()).toHaveAccessibleDescription(OUTSIDE_AI_SETTING_EXPLAINED);
    expect(screen.queryByText(ADDRESS)).toBeNull();
  });

  it("turns on without asking, and then gives the address people give an AI app", async () => {
    const sent = serve();
    const confirmed = vi.spyOn(window, "confirm");
    const { user, onFailed } = showCard(false);

    await user.click(theSwitch());

    expect(await screen.findByText(ADDRESS)).toBeVisible();
    expect(ADDRESS).toBe(`People give an AI app this address, which their profile shows them: ${location.origin}/mcp`);
    expect(theSwitch()).toBeChecked();
    expect(theSwitch()).toBeEnabled();
    expect(sent).toEqual([["PUT /api/account/outside_ai", { on: true }]]);
    expect(confirmed).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("asks before turning off, as that disconnects every app, and leaves it on when the answer is no", async () => {
    const sent = serve();
    const confirmed = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user } = showCard(true);
    expect(screen.getByText(ADDRESS)).toBeVisible();
    expect(theSwitch()).toBeChecked();

    await user.click(theSwitch());
    expect(confirmed).toHaveBeenLastCalledWith(CONFIRM_STOP_OUTSIDE_AI);
    expect(theSwitch()).toBeChecked();
    expect(sent).toEqual([]);

    await user.click(theSwitch());
    await waitFor(() => expect(screen.queryByText(ADDRESS)).toBeNull());
    expect(theSwitch()).not.toBeChecked();
    expect(sent).toEqual([["PUT /api/account/outside_ai", { on: false }]]);
  });

  it("says why a change failed, and shows the switch as it was", async () => {
    serve(() => Response.json({ error: OUTSIDE_FORBIDDEN }, { status: 403 }));
    const { user, onFailed } = showCard(false);

    await user.click(theSwitch());

    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    const [error] = onFailed.mock.calls[0] as [ApiError];
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(OUTSIDE_FORBIDDEN);
    expect(theSwitch()).not.toBeChecked();
    expect(theSwitch()).toBeEnabled();
  });
});
