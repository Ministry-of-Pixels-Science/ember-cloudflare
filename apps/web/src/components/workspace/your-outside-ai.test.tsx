import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTSIDE_CONNECTION_GONE, type OutsideConnection } from "@ember/protocol/outside";
import { FlashProvider } from "@/components/flash";
import { ApiError } from "@/lib/api";
import { dateTimeLabel } from "@/lib/messages";
import { connectionStatus, disconnectedNotice, NOTHING_CONNECTED, OUTSIDE_AI_EXPLAINED, outsideAddress, YourOutsideAi } from "./your-outside-ai";

const CONNECTED = "2026-11-14T09:00:00.000Z";
const USED = "2026-11-14T10:30:00.000Z";
const CLAUDE: OutsideConnection = { id: "0mgk3x2a9b4c70", name: "Claude", comesBackTo: "claude.example", scopes: ["read"], connectedAt: CONNECTED, usedAt: USED };
const CHATGPT: OutsideConnection = { id: "0mgk3x2a9b4c71", name: "ChatGPT", comesBackTo: "chatgpt.example", scopes: ["read"], connectedAt: CONNECTED, usedAt: null };

/** Answers disconnecting a connection as `answer` says, keeping which requests were made. */
function serve(answer: () => Response | Promise<Response>) {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    return answer();
  });
  return requests;
}

/** Shows the section with `connections`, as your profile does. */
function show(connections: OutsideConnection[]) {
  const [onChanged, onFailed] = [vi.fn(), vi.fn()];
  render(
    <FlashProvider workspace>
      <YourOutsideAi connections={connections} onChanged={onChanged} onFailed={onFailed} />
    </FlashProvider>,
  );
  return { user: userEvent.setup(), onChanged, onFailed };
}

const section = () => screen.getByRole("region", { name: "AI apps" });

afterEach(() => vi.restoreAllMocks());

describe("The AI apps section of your profile", () => {
  it("gives the address to give an AI app, and says nothing is connected while nothing is", () => {
    show([]);

    expect(within(section()).getByRole("heading", { level: 2, name: "AI apps" })).toBeVisible();
    expect(within(section()).getByText(OUTSIDE_AI_EXPLAINED)).toBeVisible();
    const address = within(section()).getByRole("textbox", { name: "The address to give an AI app" });
    expect(address).toHaveValue(`${location.origin}/mcp`);
    expect(address).toHaveAttribute("readonly");
    expect(outsideAddress()).toBe(`${location.origin}/mcp`);
    expect(within(section()).getByText(NOTHING_CONNECTED)).toBeVisible();
    expect(within(section()).queryByRole("list")).toBeNull();
  });

  it("lists each app connected as you, with where it came back to, when you connected it and when it last asked, and Disconnect", () => {
    show([CLAUDE, CHATGPT]);

    expect(within(section()).getAllByRole("listitem").map((row) => row.textContent)).toEqual([`Claude${connectionStatus(CLAUDE)}Disconnect`, `ChatGPT${connectionStatus(CHATGPT)}Disconnect`]);
    expect(connectionStatus(CLAUDE)).toBe(`From claude.example, connected ${dateTimeLabel(new Date(CONNECTED))}. It last asked Ember something ${dateTimeLabel(new Date(USED))}.`);
    expect(connectionStatus(CHATGPT)).toBe(`From chatgpt.example, connected ${dateTimeLabel(new Date(CONNECTED))}. It hasn't asked Ember anything yet.`);
    expect(screen.queryByText(NOTHING_CONNECTED)).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect Claude" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect ChatGPT" })).toBeEnabled();
  });

  it("disconnects an app, handing the profile the ones left and saying so", async () => {
    const requests = serve(() => Response.json({ connections: [CHATGPT] }));
    const { user, onChanged, onFailed } = show([CLAUDE, CHATGPT]);

    await user.click(screen.getByRole("button", { name: "Disconnect Claude" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledExactlyOnceWith([CHATGPT]));
    expect(requests).toEqual([`DELETE /api/users/me/outside/${CLAUDE.id}`]);
    expect(await screen.findByText(disconnectedNotice("Claude"))).toBeVisible();
    expect(disconnectedNotice("Claude")).toBe("Claude is disconnected. It can't read Ember as you any more.");
    expect(screen.getByRole("button", { name: "Disconnect ChatGPT" })).toBeEnabled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says why disconnecting failed, and leaves the list as it was", async () => {
    serve(() => Response.json({ error: OUTSIDE_CONNECTION_GONE }, { status: 404 }));
    const { user, onChanged, onFailed } = show([CLAUDE]);

    await user.click(screen.getByRole("button", { name: "Disconnect Claude" }));

    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    const [error] = onFailed.mock.calls[0] as [ApiError];
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(OUTSIDE_CONNECTION_GONE);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Disconnect Claude" })).toBeEnabled();
  });
});
