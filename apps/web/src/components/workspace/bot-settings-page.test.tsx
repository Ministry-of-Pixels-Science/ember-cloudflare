import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AVATAR_TOO_LARGE, MAX_AVATAR_SIZE, type Account, type BotAnswer, type BotSettings, type Me, type SidebarRoom } from "@ember/protocol";
import { WEBHOOK_URL_REFUSED } from "@ember/protocol/bots";
import defaultBotAvatar from "@/components/default-bot-avatar.svg";
import { FlashProvider } from "@/components/flash";
import { Sheet } from "@/components/ui/sheet";
import { AccountContext } from "@/hooks/use-account";
import { BotSettingsPage, CONFIRM_DELETE_BOT, CONFIRM_NEW_KEY, NewBotPage, ROOMS_EXPLAINED } from "./bot-settings-page";

vi.mock("@/lib/previews", () => ({ avatarVariantOf: vi.fn(async () => new Blob(["variant"], { type: "image/webp" })) }));

const account: Account = { name: "Analytical Engines", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true };
const ada: Me = { id: "0mgk3x2a9b4c5d", name: "Ada Lovelace", administrator: true };

const BOT: BotSettings = {
  id: "0mgk3x2a9b4c5e",
  name: "Build Bot",
  bio: null,
  role: "bot",
  status: "active",
  avatarUrl: "/users/b0t/avatar?v=1",
  key: "0mgk3x2a9b4c5e-Ab3dEf5hiJ7k",
  rooms: [{ id: "0mgk3x2a9b4c5a", name: "general" }],
  webhookUrl: "https://ci.example.com/hook",
  pickedRooms: null,
};

const room = (id: string, name: string, kind: "open" | "closed" = "open"): SidebarRoom => ({ id, name, kind, icon: null, unread: false, involvement: "mentions" });
const GENERAL = room("0mgk3x2a9b4c5a", "general");
const RANDOM = room("0mgk3x2a9b4c5b", "random");
/** Ada's sidebar: open rooms, and one private, which a bot is put in from its settings instead. */
const SIDEBAR: SidebarRoom[] = [RANDOM, GENERAL, room("0mgk3x2a9b4c5c", "secret plans", "closed")];

const answer = (bot: BotSettings, status = 200) => Response.json({ bot } satisfies BotAnswer, { status });
const refused = (status: number, error: string) => Response.json({ error }, { status });

interface Answers {
  /** What loading the bot answers, rather than `BOT`. */
  loaded?: () => Response | Promise<Response>;
  /** What adding, changing, deleting or rekeying the bot answers, rather than that it's done. */
  sent?: () => Response | Promise<Response>;
}

/** Answers the pages' requests as the server does for an administrator, or as `answers` says. */
function serve({ loaded = () => answer(BOT), sent }: Answers = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    if (request === `GET /api/account/bots/${BOT.id}`) return loaded();
    if (sent) return sent();
    switch (request) {
      case "POST /api/account/bots":
        return answer(BOT, 201);
      case `PATCH /api/account/bots/${BOT.id}`:
      case `PUT /api/account/bots/${BOT.id}/key`:
        return answer(BOT);
      case `DELETE /api/account/bots/${BOT.id}`:
        return new Response(null, { status: 204 });
      default:
        throw new Error(`Unexpected request for ${request}`);
    }
  });
}

/** Shows `page` at `path`, as the workspace does. */
function showAt(path: string, page: (props: { onMissing: () => void; onFailed: () => void }) => React.ReactNode, shown = account) {
  const [onMissing, onFailed] = [vi.fn(), vi.fn()];
  history.replaceState(null, "", path);
  render(
    <AccountContext value={shown}>
      <FlashProvider workspace>
        <Sheet>{page({ onMissing, onFailed })}</Sheet>
      </FlashProvider>
    </AccountContext>,
  );
  return { onMissing, onFailed, user: userEvent.setup() };
}

const showNewBot = (me = ada, shown = account) => showAt("/account/bots/new", ({ onFailed }) => <NewBotPage me={me} rooms={SIDEBAR} onFailed={onFailed} />, shown);
const showSettings = () =>
  showAt(`/account/bots/${BOT.id}/edit`, ({ onMissing, onFailed }) => <BotSettingsPage botId={BOT.id} rooms={SIDEBAR} onMissing={onMissing} onFailed={onFailed} />);

const nameField = () => screen.getByRole("textbox", { name: "Bot name" });
const roomsCard = () => screen.getByRole("region", { name: "Rooms" });
const everyRoom = () => screen.getByRole("radio", { name: "Every room" });
const chosenRooms = () => screen.getByRole("radio", { name: "Only the rooms I choose" });
/** The rooms Only the rooms I choose offers, by name, with whether each is ticked. */
const roomBoxes = () => within(roomsCard()).queryAllByRole("checkbox").map((box) => [box.closest("label")!.textContent, (box as HTMLInputElement).checked]);
const incoming = () => screen.getByRole("region", { name: "Incoming" });
const outgoing = () => screen.getByRole("region", { name: "Outgoing" });
const urlField = () => screen.getByRole("textbox", { name: "Webhook URL" });
const saveButton = () => screen.getByRole("button", { name: "Save changes" });
const avatar = () => screen.getByRole("img", { name: "Bot avatar" });
const avatarField = () => screen.getByLabelText("Upload bot avatar");
const robot = () => new File(["robot"], "robot.png", { type: "image/png" });
/** The name field, once the bot has loaded into it. */
const loaded = async () => {
  await waitFor(() => expect(nameField()).toHaveValue(BOT.name));
  return nameField();
};

/** The form the page sent last, with its fields as JSON in `user`, and the avatar and its variant. */
function sentForm() {
  const form = vi.mocked(fetch).mock.lastCall![1]!.body as FormData;
  return { user: JSON.parse(String(form.get("user"))) as unknown, avatar: form.get("avatar"), variant: form.get("variant") };
}

/** The requests the page has sent, but for loading the bot, with what they sent. */
const sent = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([input, init]) => [`${init?.method ?? "GET"} ${String(input)}`, init?.body === undefined ? undefined : JSON.parse(String(init.body))] as const)
    .filter(([request]) => request !== `GET /api/account/bots/${BOT.id}`);

beforeEach(() => {
  serve();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:robot");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Add and edit a bot", () => {
  it("adds a bot with the bot form, titled New chat bot, with Go Back to the bots page", () => {
    showNewBot();
    expect(document.title).toBe("New chat bot");
    expect(screen.getByRole("heading", { level: 1, name: "Chat bot setup" })).toBeInTheDocument();
    expect(screen.getByText("Connect another app or service to your workspace as a bot.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/account/bots");

    expect(nameField()).toHaveFocus();
    expect(nameField()).toBeRequired();
    expect(nameField()).toHaveAttribute("placeholder", "Name the bot");
    expect(nameField()).toHaveAttribute("autocomplete", "name");
    expect(urlField()).toHaveAttribute("type", "url");
    expect(urlField()).toHaveAttribute("placeholder", "Webhook URL");
    expect(urlField()).toHaveAttribute("maxlength", "2048");
    expect(urlField()).not.toBeRequired();
  });

  it("says what comes in, the addresses each room gives the bot once it's added, and what goes out, the webhook URL, which is optional", () => {
    showNewBot();
    expect(incoming()).toHaveTextContent(
      "Apps post in a room as the bot at two addresses the room gives it, one for text or a file and one that takes a Slack incoming webhook's payload." +
        "Each room's addresses appear once you save the bot, which puts it in its rooms.",
    );
    expect(within(incoming()).queryAllByRole("textbox")).toEqual([]);
    expect(within(outgoing()).getByRole("textbox", { name: "Webhook URL" })).toBe(urlField());
    expect(urlField()).toHaveAccessibleDescription(
      "Optional. Ember sends every message that @mentions the bot or is sent to it in a DM to this webhook URL, then posts whatever it answers within 30 seconds.",
    );
    // Name, then its rooms, then in, then out, then Save changes.
    expect(nameField().compareDocumentPosition(roomsCard())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(roomsCard().compareDocumentPosition(incoming())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(incoming().compareDocumentPosition(outgoing())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(outgoing().compareDocumentPosition(saveButton())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("saves the new bot as typed, then goes to the bots page, with no notice", async () => {
    const { user } = showNewBot();
    await user.type(nameField(), "Build Bot");
    await user.type(urlField(), "https://ci.example.com/hook");
    await user.click(saveButton());
    await waitFor(() => expect(location.pathname).toBe("/account/bots"));
    expect(sent()).toEqual([["POST /api/account/bots", { name: "Build Bot", webhookUrl: "https://ci.example.com/hook", rooms: null }]]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("puts a new bot in every room, or only the open rooms chosen, of those in the sidebar", async () => {
    const { user } = showNewBot();
    expect(roomsCard()).toHaveTextContent(`Rooms${ROOMS_EXPLAINED}`);
    expect(within(roomsCard()).getByRole("group", { name: "Rooms" })).toHaveAccessibleDescription(ROOMS_EXPLAINED);
    expect(everyRoom()).toBeChecked();
    expect(roomBoxes()).toEqual([]);

    await user.click(chosenRooms());
    expect(roomBoxes()).toEqual([
      ["general", false],
      ["random", false],
    ]);
    await user.click(screen.getByRole("checkbox", { name: "random" }));
    await user.type(nameField(), "Build Bot");
    await user.click(saveButton());
    await waitFor(() => expect(location.pathname).toBe("/account/bots"));
    expect(sent()).toEqual([["POST /api/account/bots", { name: "Build Bot", webhookUrl: "", rooms: [RANDOM.id] }]]);
  });

  it("can't add the bot again until the server answers, and says why it refused, keeping what's typed", async () => {
    let refuse = () => {};
    serve({ sent: () => new Promise((resolve) => (refuse = () => resolve(refused(422, WEBHOOK_URL_REFUSED)))) });
    const { onFailed, user } = showNewBot();
    await user.type(nameField(), "Build Bot");
    await user.type(urlField(), "ftp://ci.example.com");
    await user.click(saveButton());
    expect(saveButton()).toBeDisabled();
    await user.type(nameField(), "{Enter}");
    expect(sent()).toHaveLength(1);

    refuse();
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 422, message: WEBHOOK_URL_REFUSED })));
    expect(saveButton()).toBeEnabled();
    expect(urlField()).toHaveValue("ftp://ci.example.com");
    expect(location.pathname).toBe("/account/bots/new");
  });

  it("offers Upload bot avatar, showing Campfire's bot picture until a picture is chosen, then that", async () => {
    const { user } = showNewBot();
    expect(avatar()).toHaveAttribute("src", defaultBotAvatar);
    expect(avatarField()).toMatchObject({ type: "file", accept: "image/*" });
    expect(avatarField().compareDocumentPosition(nameField())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await user.upload(avatarField(), robot());
    expect(avatar()).toHaveAttribute("src", "blob:robot");
  });

  it("sends the avatar chosen, and its variant, with the new bot's fields", async () => {
    const { user } = showNewBot();
    await user.upload(avatarField(), robot());
    await user.type(nameField(), "Build Bot");
    await user.click(saveButton());
    await waitFor(() => expect(location.pathname).toBe("/account/bots"));
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/account/bots", expect.objectContaining({ method: "POST" }));
    expect(sentForm()).toEqual({
      user: { name: "Build Bot", webhookUrl: "", rooms: null },
      avatar: expect.objectContaining({ name: "robot.png", type: "image/png" }),
      variant: expect.objectContaining({ type: "image/webp" }),
    });
  });

  it("refuses a picture over 16 MB at once, saying so", async () => {
    const { user } = showNewBot();
    const huge = robot();
    Object.defineProperty(huge, "size", { value: MAX_AVATAR_SIZE + 1 });
    await user.upload(avatarField(), huge);
    expect(screen.getByRole("alert")).toHaveTextContent(AVATAR_TOO_LARGE);
    expect(avatar()).toHaveAttribute("src", defaultBotAvatar);
  });

  it("sends anyone but an administrator to workspace settings at once, saying why", async () => {
    const { onFailed } = showNewBot({ ...ada, administrator: false });
    expect(await screen.findByRole("alert")).toHaveTextContent("Only administrators can manage bots");
    expect(location.pathname).toBe("/account/edit");
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("shows a bot's name and webhook URL to change, titled Edit bot, with Go Back to the bots page", async () => {
    showSettings();
    expect(document.title).toBe("Edit bot");
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/account/bots");
    expect(await loaded()).toHaveFocus();
    expect(urlField()).toHaveValue(BOT.webhookUrl);
  });

  it("shows the bot's avatar, and gives it the one chosen with what else has changed, keeping the picture from changing while it's sent", async () => {
    let answered = (_: Response) => {};
    serve({ sent: () => new Promise((resolve) => (answered = resolve)) });
    const { user } = showSettings();
    await loaded();
    expect(avatar()).toHaveAttribute("src", BOT.avatarUrl);

    await user.upload(avatarField(), robot());
    await user.click(saveButton());
    await waitFor(() => expect(avatarField()).toBeDisabled());
    expect(vi.mocked(fetch)).toHaveBeenLastCalledWith(`/api/account/bots/${BOT.id}`, expect.objectContaining({ method: "PATCH" }));
    expect(sentForm()).toMatchObject({ user: {}, avatar: expect.objectContaining({ name: "robot.png" }) });

    answered(answer(BOT));
    await waitFor(() => expect(location.pathname).toBe("/account/bots"));
  });

  it("gives the commands that post to the bot's rooms as it, a room at a time, as the room menu chooses, each copied with the button beside it", async () => {
    const random = { id: "0mgk3x2a9b4c5b", name: "random" };
    serve({ loaded: () => answer({ ...BOT, rooms: [...BOT.rooms, random] }) });
    const { user } = showSettings();
    await loaded();
    const menu = within(incoming()).getByRole("combobox", { name: "Room" });
    expect(within(menu).getAllByRole("option").map((option) => option.textContent)).toEqual(["general", "random"]);
    expect(menu).toHaveValue(BOT.rooms[0]!.id);

    const commandsFor = ({ id, name }: { id: string; name: string }) => {
      const room = within(incoming()).getByRole("group", { name });
      const url = `http://localhost:3000/rooms/${id}/${BOT.key}`;
      expect(within(room).getByRole("textbox", { name: "curl command for posting messages" })).toHaveValue(`curl -d 'Hello!' ${url}/messages`);
      expect(within(room).getByRole("textbox", { name: "curl command for posting attachments" })).toHaveValue(`curl -F "attachment=@/path/to/file" ${url}/messages`);
      expect(within(room).getByRole("textbox", { name: "Slack-compatible webhook URL" })).toHaveValue(`${url}/slack`);
      return room;
    };
    commandsFor(BOT.rooms[0]!);
    await user.selectOptions(menu, "random");
    const shown = commandsFor(random);
    expect(within(incoming()).queryByRole("group", { name: "general" })).not.toBeInTheDocument();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      await user.click(within(shown).getByRole("button", { name: "Copy Slack-compatible webhook URL" }));
      expect(writeText).toHaveBeenCalledWith(`http://localhost:3000/rooms/${random.id}/${BOT.key}/slack`);
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    // Neither choosing a room nor copying saves the form.
    expect(sent()).toEqual([]);
  });

  it("doesn't save the form for Enter in a command, which is there to be copied", async () => {
    const { user } = showSettings();
    await loaded();
    await user.click(within(incoming()).getByRole("textbox", { name: "curl command for posting messages" }));
    await user.keyboard("{Enter}");
    expect(sent()).toEqual([]);
    expect(location.pathname).toBe(`/account/bots/${BOT.id}/edit`);
    // Where a field's Enter does.
    await user.click(nameField());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(location.pathname).toBe("/account/bots"));
  });

  it("says a bot in no rooms has no addresses yet", async () => {
    serve({ loaded: () => answer({ ...BOT, rooms: [] }) });
    showSettings();
    await loaded();
    expect(within(incoming()).getByText("It isn't in any rooms, so it has no addresses yet.")).toBeInTheDocument();
    expect(within(incoming()).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows a bot kept to the rooms picked as it's kept, one the sidebar lacks among them, and saves just a change to them", async () => {
    const launch = { id: "0mgk3x2a9b4c5d", name: "launch" };
    serve({ loaded: () => answer({ ...BOT, pickedRooms: [{ id: GENERAL.id, name: "general" }, launch] }) });
    const { user } = showSettings();
    await loaded();
    expect(chosenRooms()).toBeChecked();
    expect(roomBoxes()).toEqual([
      ["general", true],
      ["launch", true],
      ["random", false],
    ]);

    await user.click(screen.getByRole("checkbox", { name: "general" }));
    await user.click(screen.getByRole("checkbox", { name: "random" }));
    await user.click(saveButton());
    await waitFor(() => expect(location.pathname).toBe("/account/bots"));
    expect(sent()).toEqual([[`PATCH /api/account/bots/${BOT.id}`, { rooms: [launch.id, RANDOM.id] }]]);
  });

  it("puts a bot kept to the rooms picked in every room again", async () => {
    serve({ loaded: () => answer({ ...BOT, pickedRooms: [{ id: GENERAL.id, name: "general" }] }) });
    const { user } = showSettings();
    await loaded();
    await user.click(everyRoom());
    expect(roomBoxes()).toEqual([]);
    await user.click(saveButton());
    await waitFor(() => expect(location.pathname).toBe("/account/bots"));
    expect(sent()).toEqual([[`PATCH /api/account/bots/${BOT.id}`, { rooms: null }]]);
  });

  it("shows no webhook URL for a bot without a webhook", async () => {
    serve({ loaded: () => answer({ ...BOT, webhookUrl: null }) });
    showSettings();
    await loaded();
    expect(urlField()).toHaveValue("");
  });

  it("saves only what's changed, so another administrator's change stays, then goes to the bots page with no notice", async () => {
    const { user } = showSettings();
    await user.clear(await loaded());
    await user.type(nameField(), "Deploy Bot");
    await user.click(saveButton());
    await waitFor(() => expect(location.pathname).toBe("/account/bots"));
    expect(sent()).toEqual([[`PATCH /api/account/bots/${BOT.id}`, { name: "Deploy Bot" }]]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sends a blank webhook URL, which removes the webhook", async () => {
    const { user } = showSettings();
    await loaded();
    await user.clear(urlField());
    await user.click(saveButton());
    await waitFor(() => expect(location.pathname).toBe("/account/bots"));
    expect(sent()).toEqual([[`PATCH /api/account/bots/${BOT.id}`, { webhookUrl: "" }]]);
  });

  it("answers the 404 page for anyone but an active bot", async () => {
    serve({ loaded: () => refused(404, "Not found") });
    const { onMissing, onFailed } = showSettings();
    await waitFor(() => expect(onMissing).toHaveBeenCalledOnce());
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("answers the 404 page when the bot has gone by the time it's saved", async () => {
    serve({ sent: () => refused(404, "Not found") });
    const { onMissing, user } = showSettings();
    await loaded();
    await user.click(saveButton());
    await waitFor(() => expect(onMissing).toHaveBeenCalledOnce());
  });

  it("sends anyone but an administrator to workspace settings, saying why", async () => {
    serve({ loaded: () => refused(403, "Only administrators can manage bots") });
    const { onFailed } = showSettings();
    expect(await screen.findByRole("alert")).toHaveTextContent("Only administrators can manage bots");
    expect(location.pathname).toBe("/account/edit");
    expect(onFailed).not.toHaveBeenCalled();
  });
});

describe("Delete a bot", () => {
  it("deletes the bot once it's confirmed, then goes to the bots page", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user } = showSettings();
    await loaded();
    const remove = screen.getByRole("button", { name: "Delete this chat bot" });
    expect(remove).toHaveTextContent("Delete bot");

    await user.click(remove);
    expect(confirm).toHaveBeenLastCalledWith(CONFIRM_DELETE_BOT);
    expect(sent()).toEqual([]);
    await user.click(remove);
    await waitFor(() => expect(location.pathname).toBe("/account/bots"));
    expect(sent()).toEqual([[`DELETE /api/account/bots/${BOT.id}`, undefined]]);
  });

  it("can't save, delete or rekey the bot while a deletion is on its way, and says why one failed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let fail = () => {};
    serve({ sent: () => new Promise((resolve) => (fail = () => resolve(refused(500, "Something went wrong")))) });
    const { onFailed, user } = showSettings();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Delete this chat bot" }));
    for (const name of ["Save changes", "Delete this chat bot", "Generate a new key"]) expect(screen.getByRole("button", { name })).toBeDisabled();

    fail();
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 500 })));
    for (const name of ["Save changes", "Delete this chat bot", "Generate a new key"]) expect(screen.getByRole("button", { name })).toBeEnabled();
    expect(location.pathname).toBe(`/account/bots/${BOT.id}/edit`);
  });
});

describe("Generate a new bot key", () => {
  it("gives the bot a new key once it's confirmed, then goes to the bots page", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user } = showSettings();
    await loaded();
    const newKey = screen.getByRole("button", { name: "Generate a new key" });
    expect(newKey).toHaveTextContent("Generate a new key");

    await user.click(newKey);
    expect(confirm).toHaveBeenLastCalledWith(CONFIRM_NEW_KEY);
    expect(sent()).toEqual([]);
    await user.click(newKey);
    await waitFor(() => expect(location.pathname).toBe("/account/bots"));
    expect(sent()).toEqual([[`PUT /api/account/bots/${BOT.id}/key`, undefined]]);
  });
});

describe("Translation buttons", () => {
  it("has translation buttons for the name and the webhook URL once an administrator shows them", () => {
    showNewBot(ada, { ...account, hideTranslationButtons: false });
    expect(screen.getAllByText("Translate")).toHaveLength(2);
  });
});
