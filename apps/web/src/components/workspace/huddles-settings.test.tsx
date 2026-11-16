import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSettings, WorkspaceSettings } from "@ember/protocol";
import { HUDDLES_FORBIDDEN } from "@ember/protocol/huddles";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { ApiError } from "@/lib/api";
import { CAMERAS_EXPLAINED, CONFIRM_STOP_HUDDLES, HUDDLES_EXPLAINED, HuddleCameras, HuddlesSettings } from "./huddles-settings";

const APP_ID = "2a95132c15732412d22c1476fa83f27a";

/** Answers turning huddles off as the server would, or as `stopped` says. */
function serve(stopped: () => Response | Promise<Response> = () => Response.json({ huddles: null })) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (`${init?.method} ${String(input)}` === "DELETE /api/account/huddles") return stopped();
    throw new Error(`Unexpected request for ${init?.method} ${String(input)}`);
  });
}

/** A response the test lets through when it says, with `answer` letting it through. */
function held(response: () => Response) {
  let answer = () => {};
  const answered = new Promise<Response>((resolve) => (answer = () => resolve(response())));
  return { answered: () => answered, answer: () => act(async () => answer()) };
}

/** The card, for a workspace whose huddles are as `huddles` says. */
function showCard(huddles: WorkspaceSettings["huddles"]) {
  const callbacks = { onSetUp: vi.fn(), onStopped: vi.fn(), onFailed: vi.fn() };
  render(<HuddlesSettings huddles={huddles} {...callbacks} />);
  return { ...callbacks, user: userEvent.setup() };
}

const card = () => screen.getByRole("region", { name: "Audio and video chat" });
const huddlesSwitch = () => within(card()).getByRole("switch", { name: "Audio and video chat" });

afterEach(() => vi.restoreAllMocks());

describe("Set up huddles", () => {
  it("says what huddles are while its switch is off, which turning on opens Set up huddles", async () => {
    serve();
    const { user, onSetUp } = showCard(null);
    expect(card()).toHaveTextContent(HUDDLES_EXPLAINED);
    expect(HUDDLES_EXPLAINED).toMatch(/^Huddles let people in a room talk to each other live\./);
    // Named as the project's owner worded what huddles are for.
    expect(within(card()).getByRole("heading", { level: 2, name: "Audio and video chat" })).toBeVisible();
    expect(huddlesSwitch()).not.toBeChecked();
    expect(huddlesSwitch()).toHaveAccessibleDescription(HUDDLES_EXPLAINED);
    expect(within(card()).queryAllByRole("button")).toEqual([]);
    await user.click(huddlesSwitch());
    expect(onSetUp).toHaveBeenCalledOnce();
    // It stays off until the app's keys are given.
    expect(huddlesSwitch()).not.toBeChecked();
  });

  it("names the SFU app huddles run through, its switch on, with Change keys", async () => {
    serve();
    const { user, onSetUp } = showCard({ appId: APP_ID });
    const description = `Huddles run through the Realtime SFU app ${APP_ID} in your Cloudflare account.`;
    expect(card()).toHaveTextContent(description);
    expect(huddlesSwitch()).toBeChecked();
    expect(huddlesSwitch()).toBeEnabled();
    expect(huddlesSwitch()).toHaveAccessibleDescription(description);
    expect(within(card()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Change keys"]);
    await user.click(screen.getByRole("button", { name: "Change keys" }));
    expect(onSetUp).toHaveBeenCalledOnce();
  });

  it("forgets the app's keys once the administrator confirms turning its switch off", async () => {
    const answer = held(() => Response.json({ huddles: null }));
    const fetch = serve(answer.answered);
    const sure = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user, onStopped } = showCard({ appId: APP_ID });
    await user.click(huddlesSwitch());
    expect(sure).toHaveBeenCalledWith(CONFIRM_STOP_HUDDLES);
    expect(fetch).not.toHaveBeenCalled();
    expect(huddlesSwitch()).toBeChecked();

    await user.click(huddlesSwitch());
    expect(fetch).toHaveBeenCalledWith("/api/account/huddles", expect.objectContaining({ method: "DELETE" }));
    expect(huddlesSwitch()).not.toBeChecked();
    expect(huddlesSwitch()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change keys" })).toBeDisabled();
    await answer.answer();
    expect(onStopped).toHaveBeenCalledOnce();
    expect(huddlesSwitch()).toBeEnabled();
  });

  it("leaves turning it off that failed to the page's alerts, its switch back on", async () => {
    serve(() => Response.json({ error: HUDDLES_FORBIDDEN }, { status: 403 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onStopped, onFailed } = showCard({ appId: APP_ID });
    await user.click(huddlesSwitch());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, HUDDLES_FORBIDDEN)));
    expect(onStopped).not.toHaveBeenCalled();
    expect(huddlesSwitch()).toBeChecked();
    expect(huddlesSwitch()).toBeEnabled();
  });
});

describe("Cameras in huddles", () => {
  /** The workspace as it is where cameras may go on in huddles, or may not. */
  function Workspace({ cameras, children }: { cameras: boolean; children: ReactNode }) {
    return <AccountContext value={{ ...useAccount(), huddleCameras: cameras }}>{children}</AccountContext>;
  }

  /** The Cameras card, for a workspace whose cameras are as `cameras` says, with what its switch saved and the calls that settle each save. */
  function showCameras(cameras = true) {
    const settled: Array<() => void> = [];
    const saveSwitch = vi.fn((_: AccountSettings, done: () => void) => void settled.push(done));
    const card = (shown: boolean) => (
      <Workspace cameras={shown}>
        <HuddleCameras saveSwitch={saveSwitch} />
      </Workspace>
    );
    const { rerender } = render(card(cameras));
    return { saveSwitch, settled, user: userEvent.setup(), show: (shown: boolean) => rerender(card(shown)) };
  }

  const camerasCard = () => screen.getByRole("region", { name: "Cameras" });
  const camerasSwitch = () => within(camerasCard()).getByRole("switch", { name: "Cameras" });

  it("says what its switch lets people do, which is on until an administrator turns it off", () => {
    showCameras();
    expect(within(camerasCard()).getByRole("heading", { level: 2, name: "Cameras" })).toBeVisible();
    expect(camerasCard()).toHaveTextContent(CAMERAS_EXPLAINED);
    expect(CAMERAS_EXPLAINED).toBe("People can turn their camera on in a huddle.");
    expect(camerasSwitch()).toBeChecked();
    expect(camerasSwitch()).toHaveAccessibleDescription(CAMERAS_EXPLAINED);
  });

  it("saves its switch at once, staying where it was moved to until that's saved, and moved no further meanwhile", async () => {
    const { saveSwitch, settled, user, show } = showCameras();
    await user.click(camerasSwitch());
    expect(saveSwitch.mock.calls.map(([settings]) => settings)).toEqual([{ huddleCameras: false }]);
    expect(camerasSwitch()).not.toBeChecked();
    await user.click(camerasSwitch());
    expect(saveSwitch).toHaveBeenCalledOnce();
    expect(camerasSwitch()).not.toBeChecked();

    // Saved, it's as the workspace says, which by then says cameras are off.
    show(false);
    act(() => settled[0]!());
    expect(camerasSwitch()).not.toBeChecked();
    await user.click(camerasSwitch());
    expect(saveSwitch.mock.calls.map(([settings]) => settings)).toEqual([{ huddleCameras: false }, { huddleCameras: true }]);
    expect(camerasSwitch()).toBeChecked();
  });

  it("goes back to where it was when saving it fails", async () => {
    const { settled, user } = showCameras();
    await user.click(camerasSwitch());
    expect(camerasSwitch()).not.toBeChecked();
    // The page's alerts say why, and the workspace still says cameras are on.
    act(() => settled[0]!());
    expect(camerasSwitch()).toBeChecked();
  });
});
