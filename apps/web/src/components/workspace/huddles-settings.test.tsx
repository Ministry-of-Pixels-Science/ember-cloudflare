import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSettings, WorkspaceSettings } from "@ember/protocol";
import { HUDDLES_FORBIDDEN } from "@ember/protocol/huddles";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { ApiError } from "@/lib/api";
import { CAMERAS_EXPLAINED, CONFIRM_STOP_HUDDLES, CONFIRM_STOP_RELAY, HuddleRelay, HUDDLES_EXPLAINED, HuddlesSettings, HuddleSwitches, RELAY_EXPLAINED, RELAY_TITLE, SCREENS_EXPLAINED } from "./huddles-settings";

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
    const { user, onSetUp } = showCard({ appId: APP_ID, relayKeyId: null });
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
    const { user, onStopped } = showCard({ appId: APP_ID, relayKeyId: null });
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
    const { user, onStopped, onFailed } = showCard({ appId: APP_ID, relayKeyId: null });
    await user.click(huddlesSwitch());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, HUDDLES_FORBIDDEN)));
    expect(onStopped).not.toHaveBeenCalled();
    expect(huddlesSwitch()).toBeChecked();
    expect(huddlesSwitch()).toBeEnabled();
  });
});

describe("Huddles' relay", () => {
  /** A TURN key's ID, as the card names the key the relay goes by. */
  const KEY_ID = "5b1e9a0c7d3f4e2a8b6c1d0e9f7a3b5c";
  /** Huddles as they are once the relay is taken away. */
  const unrelayed = { appId: APP_ID, relayKeyId: null };

  /** Answers taking the relay away as the server would, or as `stopped` says. */
  function serveRelay(stopped: () => Response | Promise<Response> = () => Response.json({ huddles: unrelayed })) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (`${init?.method} ${String(input)}` === "DELETE /api/account/huddles/relay") return stopped();
      throw new Error(`Unexpected request for ${init?.method} ${String(input)}`);
    });
  }

  /** The relay's card, for a workspace whose relay goes by the TURN key `relayKeyId`, if it has one. */
  function showRelay(relayKeyId: string | null) {
    const callbacks = { onSetUp: vi.fn(), onStopped: vi.fn(), onFailed: vi.fn() };
    render(<HuddleRelay relayKeyId={relayKeyId} {...callbacks} />);
    return { ...callbacks, user: userEvent.setup() };
  }

  const relayCard = () => screen.getByRole("region", { name: RELAY_TITLE });
  const relaySwitch = () => within(relayCard()).getByRole("switch", { name: RELAY_TITLE });
  const named = `People whose network blocks huddles connect through Cloudflare's TURN service, by the TURN key ${KEY_ID} in your Cloudflare account.`;

  it("says what a relay is for while its switch is off, which turning on opens Set up the relay", async () => {
    serveRelay();
    const { user, onSetUp } = showRelay(null);
    expect(RELAY_TITLE).toBe("Relay for strict networks");
    expect(relayCard()).toHaveTextContent(RELAY_EXPLAINED);
    expect(RELAY_EXPLAINED).toMatch(/^Some networks, like an office's or a hotel's, block the way huddles connect\./);
    expect(within(relayCard()).getByRole("heading", { level: 2, name: RELAY_TITLE })).toBeVisible();
    expect(relaySwitch()).not.toBeChecked();
    expect(relaySwitch()).toHaveAccessibleDescription(RELAY_EXPLAINED);
    expect(within(relayCard()).queryAllByRole("button")).toEqual([]);
    await user.click(relaySwitch());
    expect(onSetUp).toHaveBeenCalledOnce();
    // It stays off until the TURN key is given.
    expect(relaySwitch()).not.toBeChecked();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names the TURN key the relay goes by, its switch on, with Change key", async () => {
    serveRelay();
    const { user, onSetUp } = showRelay(KEY_ID);
    expect(relayCard()).toHaveTextContent(named);
    expect(relayCard()).not.toHaveTextContent(RELAY_EXPLAINED);
    expect(relaySwitch()).toBeChecked();
    expect(relaySwitch()).toBeEnabled();
    expect(relaySwitch()).toHaveAccessibleDescription(named);
    expect(within(relayCard()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Change key"]);
    await user.click(screen.getByRole("button", { name: "Change key" }));
    expect(onSetUp).toHaveBeenCalledOnce();
  });

  it("forgets the TURN key once the administrator confirms turning its switch off, and shows huddles as they are then", async () => {
    const answer = held(() => Response.json({ huddles: unrelayed }));
    const fetch = serveRelay(answer.answered);
    const sure = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user, onStopped, onSetUp } = showRelay(KEY_ID);
    await user.click(relaySwitch());
    expect(sure).toHaveBeenCalledWith(CONFIRM_STOP_RELAY);
    expect(fetch).not.toHaveBeenCalled();
    expect(relaySwitch()).toBeChecked();

    await user.click(relaySwitch());
    expect(fetch).toHaveBeenCalledWith("/api/account/huddles/relay", expect.objectContaining({ method: "DELETE" }));
    expect(relaySwitch()).not.toBeChecked();
    expect(relaySwitch()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change key" })).toBeDisabled();
    await answer.answer();
    expect(onStopped).toHaveBeenCalledExactlyOnceWith(unrelayed);
    expect(relaySwitch()).toBeEnabled();
    expect(onSetUp).not.toHaveBeenCalled();
  });

  it("shows huddles off where they were turned off while the relay was being taken away", async () => {
    serveRelay(() => Response.json({ huddles: null }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onStopped } = showRelay(KEY_ID);
    await user.click(relaySwitch());
    await waitFor(() => expect(onStopped).toHaveBeenCalledExactlyOnceWith(null));
  });

  it("leaves taking it away that failed to the page's alerts, its switch back on", async () => {
    serveRelay(() => Response.json({ error: HUDDLES_FORBIDDEN }, { status: 403 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onStopped, onFailed } = showRelay(KEY_ID);
    await user.click(relaySwitch());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, HUDDLES_FORBIDDEN)));
    expect(onStopped).not.toHaveBeenCalled();
    expect(relaySwitch()).toBeChecked();
    expect(relaySwitch()).toBeEnabled();
  });
});

describe.each([
  { title: "Cameras", other: "Screen sharing", setting: "huddleCameras", explained: CAMERAS_EXPLAINED, says: "People can turn their camera on in a huddle." },
  { title: "Screen sharing", other: "Cameras", setting: "huddleScreens", explained: SCREENS_EXPLAINED, says: "People can share their screen in a huddle, from a computer." },
] as const)("$title in huddles", ({ title, other, setting, explained, says }) => {
  /** The workspace as it is where people may do that in huddles, or may not. */
  function Workspace({ on, children }: { on: boolean; children: ReactNode }) {
    return <AccountContext value={{ ...useAccount(), [setting]: on }}>{children}</AccountContext>;
  }

  /** The card of what people may do in a huddle, for a workspace where this is as `on` says, with what its switches saved and the calls that settle each save. */
  function showSwitches(on = true) {
    const settled: Array<() => void> = [];
    const saveSwitch = vi.fn((_: AccountSettings, done: () => void) => void settled.push(done));
    const card = (shown: boolean) => (
      <Workspace on={shown}>
        <HuddleSwitches saveSwitch={saveSwitch} />
      </Workspace>
    );
    const { rerender } = render(card(on));
    return { saveSwitch, settled, user: userEvent.setup(), show: (shown: boolean) => rerender(card(shown)) };
  }

  const row = () => screen.getByRole("region", { name: title });
  const itsSwitch = () => within(row()).getByRole("switch", { name: title });
  const theOther = () => screen.getByRole("switch", { name: other });

  it("says what its switch lets people do, which is on until an administrator turns it off", () => {
    showSwitches();
    expect(within(row()).getByRole("heading", { level: 2, name: title })).toBeVisible();
    expect(row()).toHaveTextContent(explained);
    expect(explained).toBe(says);
    expect(itsSwitch()).toBeChecked();
    expect(itsSwitch()).toHaveAccessibleDescription(explained);
  });

  it("saves its switch at once, staying where it was moved to until that's saved, and moved no further meanwhile, which leaves the other switch be", async () => {
    const { saveSwitch, settled, user, show } = showSwitches();
    await user.click(itsSwitch());
    expect(saveSwitch.mock.calls.map(([settings]) => settings)).toEqual([{ [setting]: false }]);
    expect(itsSwitch()).not.toBeChecked();
    expect(theOther()).toBeChecked();
    await user.click(itsSwitch());
    expect(saveSwitch).toHaveBeenCalledOnce();
    expect(itsSwitch()).not.toBeChecked();

    // Saved, it's as the workspace says, which by then says it's off.
    show(false);
    act(() => settled[0]!());
    expect(itsSwitch()).not.toBeChecked();
    await user.click(itsSwitch());
    expect(saveSwitch.mock.calls.map(([settings]) => settings)).toEqual([{ [setting]: false }, { [setting]: true }]);
    expect(itsSwitch()).toBeChecked();
    expect(theOther()).toBeChecked();
  });

  it("goes back to where it was when saving it fails", async () => {
    const { settled, user } = showSwitches();
    await user.click(itsSwitch());
    expect(itsSwitch()).not.toBeChecked();
    // The page's alerts say why, and the workspace still says it's on.
    act(() => settled[0]!());
    expect(itsSwitch()).toBeChecked();
  });
});
