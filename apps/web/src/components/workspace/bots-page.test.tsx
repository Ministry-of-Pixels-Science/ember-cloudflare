import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Bot, Bots, DirectoryUser, UserId } from "@ember/protocol";
import { FlashProvider } from "@/components/flash";
import { Sheet } from "@/components/ui/sheet";
import { AccountContext } from "@/hooks/use-account";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { BotsPage } from "./bots-page";

const account: Account = { name: "Analytical Engines", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true };

const BUILD_BOT: Bot = {
  id: "0mgk3x2a9b4c5e",
  name: "Build Bot",
  bio: null,
  role: "bot",
  status: "active",
  avatarUrl: "/users/b0t/avatar?v=1",
  key: "0mgk3x2a9b4c5e-Ab3dEf5hiJ7k",
  rooms: [
    { id: "0mgk3x2a9b4c5a", name: "general" },
    { id: "0mgk3x2a9b4c5b", name: "random" },
  ],
};
const DEPLOY_BOT: Bot = { ...BUILD_BOT, id: "0mgk3x2a9b4c5f", name: "Deploy Bot", avatarUrl: "/users/d3p/avatar?v=1", key: "0mgk3x2a9b4c5f-Zy9xWv7uTs5r", rooms: [] };

/** Answers loading the bots as the server does for an administrator, or as `loaded` says. */
function serve(loaded = () => Response.json({ bots: [BUILD_BOT, DEPLOY_BOT] } satisfies Bots)) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    if (request === "GET /api/account/bots") return loaded();
    throw new Error(`Unexpected request for ${request}`);
  });
}

/** Shows the page, whose people directory `showPeople` changes. */
function showPage(shown = account) {
  const onFailed = vi.fn();
  history.replaceState(null, "", "/account/bots");
  const page = (people: People) => (
    <AccountContext value={shown}>
      <PeopleContext value={people}>
        <FlashProvider workspace>
          <Sheet>
            <BotsPage onFailed={onFailed} />
          </Sheet>
        </FlashProvider>
      </PeopleContext>
    </AccountContext>
  );
  const { rerender } = render(page(new Map()));
  return { onFailed, showPeople: (people: People) => rerender(page(people)) };
}

/** A bot as the people directory lists it. */
const listedAs = ({ id, name, bio, role, status, avatarUrl }: Bot, changes: Partial<DirectoryUser> = {}): [UserId, DirectoryUser] => [id, { id, name, bio, role, status, avatarUrl, ...changes }];

/** Each bot the page lists, once they've loaded. */
async function listed(count: number): Promise<HTMLElement[]> {
  await waitFor(() => expect(screen.queryAllByRole("listitem")).toHaveLength(count));
  return screen.getAllByRole("listitem");
}

/** Gives the browser a clipboard until the test ends. */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

beforeEach(() => {
  serve();
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("Chat bots page", () => {
  it("is the Chat bots page, saying what bots do, with Add a chat bot, and Go Back to workspace settings", () => {
    showPage();
    expect(document.title).toBe("Chat bots");
    expect(screen.getByRole("heading", { level: 1, name: "Chat bots" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Chat bots let other apps and services post in your rooms, and reply when people talk to them. " +
          "Each of a bot's rooms gets two addresses below, one for posting text or a file and one that takes a Slack incoming webhook's payload. " +
          "Give a bot a webhook URL, and Ember sends it every message that @mentions it or is sent to it in a DM, then posts whatever it answers within 30 seconds.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a chat bot" })).toHaveAttribute("href", "/account/bots/new");
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/account/edit");
  });

  it("lists each bot as the server does, with its avatar linking to its page, its name, and a link to its settings", async () => {
    showPage();
    const panel = screen.getByRole("heading", { level: 1 }).closest("section")!;
    expect(panel).toHaveAttribute("aria-busy", "true");
    const [build, deploy] = await listed(2);
    expect(panel).toHaveAttribute("aria-busy", "false");

    expect(within(build!).getByText("Build Bot").tagName).toBe("STRONG");
    const avatar = within(build!).getByTitle("Build Bot");
    expect(avatar).toHaveAttribute("href", `/users/${BUILD_BOT.id}`);
    // The bot's own avatar, as the people directory may not list a bot just added.
    expect(avatar.querySelector("img")).toHaveAttribute("src", BUILD_BOT.avatarUrl);
    expect(within(build!).getByRole("link", { name: "Edit Build Bot" })).toHaveAttribute("href", `/account/bots/${BUILD_BOT.id}/edit`);
    expect(within(deploy!).getByRole("link", { name: "Edit Deploy Bot" })).toHaveAttribute("href", `/account/bots/${DEPLOY_BOT.id}/edit`);
  });

  it("gives the commands that post to each of a bot's rooms as it, at the bot's address there on this host", async () => {
    showPage();
    const [build, deploy] = await listed(2);
    const rooms = within(build!).getAllByRole("group");
    expect(rooms.map((room) => room.querySelector("legend")?.textContent)).toEqual(["general", "random"]);

    for (const [room, { id }] of [
      [rooms[0]!, BUILD_BOT.rooms[0]!],
      [rooms[1]!, BUILD_BOT.rooms[1]!],
    ] as const) {
      const url = `http://localhost:3000/rooms/${id}/${BUILD_BOT.key}/messages`;
      const message = within(room).getByRole("textbox", { name: "curl command for posting messages" });
      expect(message).toHaveValue(`curl -d 'Hello!' ${url}`);
      expect(message).toHaveAttribute("readonly");
      const attachment = within(room).getByRole("textbox", { name: "curl command for posting attachments" });
      expect(attachment).toHaveValue(`curl -F "attachment=@/path/to/file" ${url}`);
      expect(attachment).toHaveAttribute("readonly");
    }
    // A bot in no rooms has nothing to post with.
    expect(within(deploy!).queryAllByRole("group")).toEqual([]);
  });

  it("copies each command with the button beside it", async () => {
    showPage();
    const [build] = await listed(2);
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const [general] = within(build!).getAllByRole("group");
    await userEvent.click(within(general!).getByRole("button", { name: "Copy message command" }));
    await userEvent.click(within(general!).getByRole("button", { name: "Copy attachment command" }));
    const url = `http://localhost:3000/rooms/${BUILD_BOT.rooms[0]!.id}/${BUILD_BOT.key}/messages`;
    expect(writeText.mock.calls).toEqual([[`curl -d 'Hello!' ${url}`], [`curl -F "attachment=@/path/to/file" ${url}`]]);
  });

  it("follows a rename elsewhere, keeping the bots in order, and drops a bot deleted elsewhere, as the people directory hears of them", async () => {
    const { showPeople } = showPage();
    await listed(2);
    const names = () => screen.getAllByRole("listitem").map((bot) => bot.querySelector("strong")?.textContent);

    showPeople(new Map([listedAs(BUILD_BOT, { name: "Zulu Bot" }), listedAs(DEPLOY_BOT)]));
    await waitFor(() => expect(names()).toEqual(["Deploy Bot", "Zulu Bot"]));

    showPeople(new Map([listedAs(BUILD_BOT, { name: "Zulu Bot" }), listedAs(DEPLOY_BOT, { status: "deactivated" })]));
    const [build] = await listed(1);
    expect(within(build!).getByText("Zulu Bot").tagName).toBe("STRONG");
    expect(within(build!).getByRole("link", { name: "Edit Zulu Bot" })).toHaveAttribute("href", `/account/bots/${BUILD_BOT.id}/edit`);
  });

  it("lists nothing while there are no bots", async () => {
    serve(() => Response.json({ bots: [] } satisfies Bots));
    showPage();
    const panel = screen.getByRole("heading", { level: 1 }).closest("section")!;
    await waitFor(() => expect(panel).toHaveAttribute("aria-busy", "false"));
    expect(screen.queryAllByRole("listitem")).toEqual([]);
  });

  it("sends anyone but an administrator to workspace settings, saying why", async () => {
    serve(() => Response.json({ error: "Only administrators can manage bots" }, { status: 403 }));
    const { onFailed } = showPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Only administrators can manage bots");
    expect(location.pathname).toBe("/account/edit");
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says why the bots didn't load", async () => {
    serve(() => Response.json({ error: "Something went wrong" }, { status: 500 }));
    const { onFailed } = showPage();
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 500 })));
    expect(location.pathname).toBe("/account/bots");
  });
});

describe("Slack-compatible webhooks", () => {
  it("gives each of a bot's rooms its Slack-compatible webhook URL, on this host, with a button that copies it", async () => {
    showPage();
    const [build] = await listed(2);
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const rooms = within(build!).getAllByRole("group");
    for (const [room, { id }] of [
      [rooms[0]!, BUILD_BOT.rooms[0]!],
      [rooms[1]!, BUILD_BOT.rooms[1]!],
    ] as const) {
      const webhook = within(room).getByRole("textbox", { name: "Slack-compatible webhook URL" });
      expect(webhook).toHaveValue(`http://localhost:3000/rooms/${id}/${BUILD_BOT.key}/slack`);
      expect(webhook).toHaveAttribute("readonly");
    }
    await userEvent.click(within(rooms[1]!).getByRole("button", { name: "Copy Slack-compatible webhook URL" }));
    expect(writeText.mock.calls).toEqual([[`http://localhost:3000/rooms/${BUILD_BOT.rooms[1]!.id}/${BUILD_BOT.key}/slack`]]);
  });
});

describe("Translation buttons", () => {
  it("has a translation button for Chat bots once an administrator shows them, giving the page's name and first sentence", () => {
    showPage({ ...account, hideTranslationButtons: false });
    expect(screen.getByText("Translate")).toBeInTheDocument();
    expect(screen.getByText("Chat bots. Chat bots let other apps and services post in your rooms, and reply when people talk to them.")).toBeInTheDocument();
  });

  it("has none while they're hidden", () => {
    showPage();
    expect(screen.queryByText("Translate")).not.toBeInTheDocument();
  });
});
