import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_PATH,
  AVATAR_TOO_LARGE,
  CURRENT_PASSWORD_WRONG,
  MAX_AVATAR_SIZE,
  MEMBERFUL_CONNECTIONS_PATH,
  MEMBERFUL_DISCONNECTED_NOTICE,
  type Account,
  type DirectoryUser,
  type MemberfulDisconnection,
  type MemberfulStatus,
  type Platform,
  type Profile,
  type ProfileAnswer,
  type ProfileChanges,
  type SidebarRoom,
} from "@ember/protocol";
import { MODEL_NOT_LISTED, type YourAssistant, type YourAssistantChanged, type YourAssistantChanges } from "@ember/protocol/assistant";
import { FlashProvider } from "@/components/flash";
import { Sheet } from "@/components/ui/sheet";
import { AccountContext } from "@/hooks/use-account";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { PushContext } from "@/hooks/use-push";
import { navigate } from "@/hooks/use-route";
import { CHROME_MAC, SAFARI_MAC } from "@/test-platforms";
import { PUSH_ON } from "@/test-push";
import { DEFAULT_MODEL_EXPLAINED } from "./answer-levels";
import { AVATAR_CHANGED, ProfilePage } from "./profile-page";
import { NOTHING_CONNECTED } from "./your-outside-ai";

vi.mock("@/lib/previews", () => ({ avatarVariantOf: vi.fn(async () => new Blob(["variant"], { type: "image/webp" })) }));

const ada = { id: "u1", name: "Ada Lovelace", administrator: false };
/** Ada's avatar as the profile loads it: her initials, until she uploads one. */
const INITIALS = "/users/t0k3n/avatar?v=1";
const profile: Profile = { name: "Ada Lovelace", emailAddress: "ada@example.com", bio: "Wrote the first program", avatarUrl: INITIALS, avatar: false, password: true, membershipNeeded: true, memberful: null, assistant: null, apps: [], outsideAi: null };
/** Ada's levels of @ember's dials while Ember AI is on: where they start, up to Medium thinking, with the one model people can pick, which she leaves to administrators. */
const LEVELS: YourAssistant = {
  levels: { thinking: "low", length: "medium" },
  most: { thinking: "medium", length: "long" },
  model: null,
  defaultModel: "@cf/zai-org/glm-4.7-flash",
  models: [{ id: "@cf/zai-org/glm-4.7-flash", name: "GLM-4.7 Flash", format: "chat" }],
};
const account: Account = { name: "Analytical Engines", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false };
/** The sign-in links loading and saving the profile give. */
const [LOADED_LINK, SAVED_LINK] = ["u1.mgk3x2a9.loaded", "u1.mgk3x2b0.saved"];

interface Answers {
  /** What loading the profile answers, rather than `profile`. */
  loaded?: () => Response | Promise<Response>;
  /** What saving it answers, rather than the profile with the changes sent. */
  saved?: () => Response | Promise<Response>;
  /** What saving an avatar answers, rather than the profile with an avatar. */
  uploaded?: () => Response | Promise<Response>;
  /** What changing your model or levels of @ember's dials answers, rather than `LEVELS` with the changes sent. */
  leveled?: (changes: YourAssistantChanges) => Response | Promise<Response>;
  /** What disconnecting your Memberful account answers, rather than the profile with none connected. */
  disconnected?: () => Response | Promise<Response>;
}

/** Ada's Memberful account, as Memberful describes it, once she has connected it. */
const ADAS_ACCOUNT = { name: "Ada Lovelace", emailAddress: "ada@example.com" };
/** Where Ada stands with Memberful while it's members only: not connected, or connected to her account there. */
const NOT_CONNECTED: MemberfulStatus = { membersOnly: true, connected: null };
const CONNECTED: MemberfulStatus = { membersOnly: true, connected: ADAS_ACCOUNT };

/** Ada's avatar once she has uploaded one. */
const UPLOADED = "/users/t0k3n/avatar?v=2";

/** Answers the page's requests as the server does, or as `answers` says. */
function serve({
  loaded = () => Response.json({ profile, transferId: LOADED_LINK } satisfies ProfileAnswer),
  saved,
  uploaded = () => Response.json({ profile: { ...profile, avatarUrl: UPLOADED, avatar: true }, transferId: SAVED_LINK } satisfies ProfileAnswer),
  leveled,
  disconnected = () => Response.json({ profile: { ...profile, memberful: NOT_CONNECTED }, transferId: SAVED_LINK } satisfies ProfileAnswer),
}: Answers = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    switch (request) {
      case "GET /api/users/me/profile":
        return loaded();
      case "PATCH /api/users/me/profile": {
        const { password: _, currentPassword: _current, pushSubscriptionEndpoint: _endpoint, ...changes } = JSON.parse(String(init?.body)) as ProfileChanges;
        return saved ? saved() : Response.json({ profile: { ...profile, ...changes }, transferId: SAVED_LINK } satisfies ProfileAnswer);
      }
      case `PUT ${AVATAR_PATH}`:
        return uploaded();
      case "PATCH /api/users/me/assistant": {
        const changes = JSON.parse(String(init?.body)) as YourAssistantChanges;
        return leveled ? leveled(changes) : Response.json({ assistant: { ...LEVELS, levels: { ...LEVELS.levels, ...changes } } } satisfies YourAssistantChanged);
      }
      case `DELETE ${AVATAR_PATH}`:
        return Response.json({ profile: { ...profile, avatarUrl: "/users/t0k3n/avatar?v=3" }, transferId: SAVED_LINK } satisfies ProfileAnswer);
      case `DELETE ${MEMBERFUL_CONNECTIONS_PATH}`:
        return disconnected();
      default:
        throw new Error(`Unexpected request for ${request}`);
    }
  });
}

/** The profile, with Ada's rooms as the sidebar's list has them, or none while it loads, on `platform`. */
function showPage(shown = account, rooms: SidebarRoom[] | null = null, platform: Platform = CHROME_MAC) {
  const [onSignOut, onFailed, answered] = [vi.fn(), vi.fn(), vi.fn()];
  const page = (listed: SidebarRoom[] | null, people: People = new Map()) => (
    <AccountContext value={shown}>
      <PeopleContext value={people}>
        <PushContext value={{ ...PUSH_ON, platform }}>
          <FlashProvider workspace>
            <Sheet>
              <ProfilePage me={ada} rooms={listed} askForRoom={() => answered} onSignOut={onSignOut} onFailed={onFailed} />
            </Sheet>
          </FlashProvider>
        </PushContext>
      </PeopleContext>
    </AccountContext>
  );
  const { rerender } = render(page(rooms));
  return {
    onSignOut,
    onFailed,
    answered,
    user: userEvent.setup(),
    showRooms: (listed: SidebarRoom[]) => rerender(page(listed)),
    showPeople: (people: People) => rerender(page(rooms, people)),
  };
}

const field = (label: string) => screen.getByLabelText(label);
/** Where this browser's push subscription takes its pushes, when it has one. */
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/desk";
/** The page once your profile has loaded into it. */
const loaded = () => waitFor(() => expect(field("Name")).toBeEnabled());
const saveButton = () => screen.getByRole("button", { name: "Save changes" });
/** What each save sent, in order. */
const saved = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === "PATCH")
    .map(([, init]) => JSON.parse(String(init?.body)) as ProfileChanges);

beforeEach(() => {
  history.replaceState(null, "", "/users/me/profile");
  serve();
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "serviceWorker");
  history.replaceState(null, "", "/");
});

describe("Edit your profile", () => {
  it("reads Your profile, titled with your name, with Go Back and Log out in the top bar", () => {
    showPage();
    expect(document.title).toBe("Ada Lovelace");
    expect(screen.getByRole("heading", { level: 1, name: "Your profile" })).toBeInTheDocument();
    expect(screen.getByText("Manage how you appear to the people in your workspace.")).toBeInTheDocument();
    const topBar = screen.getByRole("navigation", { name: "Page" });
    expect(topBar).toContainElement(screen.getByRole("link", { name: "Go Back" }));
    expect(topBar).toContainElement(screen.getByRole("button", { name: "Log out" }));
  });

  it("is busy until your profile loads, then shows it to change, with nothing focused", async () => {
    showPage();
    const panel = screen.getByRole("heading", { level: 1 }).closest("section")!;
    expect(panel).toHaveAttribute("aria-busy", "true");
    for (const label of ["Name", "Email address", "New password", "Bio"]) expect(field(label)).toBeDisabled();
    expect(saveButton()).toBeDisabled();

    await loaded();
    expect(panel).toHaveAttribute("aria-busy", "false");
    expect(field("Name")).toHaveValue("Ada Lovelace");
    expect(field("Email address")).toHaveValue("ada@example.com");
    expect(field("New password")).toHaveValue("");
    expect(field("Bio")).toHaveValue("Wrote the first program");
    expect(saveButton()).toBeEnabled();
    expect(document.body).toHaveFocus();
  });

  it("shows no email address or bio as blank fields", async () => {
    serve({ loaded: () => Response.json({ profile: { ...profile, name: "Grace Hopper", emailAddress: null, bio: null } }) });
    showPage();
    await loaded();
    expect(field("Email address")).toHaveValue("");
    expect(field("Bio")).toHaveValue("");
  });

  it("asks for each field", () => {
    showPage();
    const name = field("Name");
    expect(name).toHaveAttribute("autocomplete", "name");
    expect(name).toHaveAttribute("placeholder", "Enter your name");
    expect(name).toBeRequired();
    expect(name).toHaveAttribute("data-1p-ignore");

    const email = field("Email address");
    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("autocomplete", "username");
    expect(email).toHaveAttribute("placeholder", "Enter your email address");
    expect(email).not.toBeRequired();

    const password = field("New password");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(password).toHaveAttribute("placeholder", "Change password");
    // At least as long as first run's.
    expect(password).toHaveAttribute("minlength", "8");
    expect(password).toHaveAttribute("maxlength", "72");
    expect(password).toHaveAccessibleDescription("Leave blank to keep your current password.");

    const bio = field("Bio");
    expect(bio.tagName).toBe("TEXTAREA");
    expect(bio).toHaveAttribute("rows", "3");
    expect(bio).toHaveAttribute("placeholder", "A few words about yourself…");
    expect(bio).toHaveAttribute("maxlength", "200");
  });

  it("saves what you changed with the notice ✓, and empties the new password", async () => {
    const { onFailed, user } = showPage();
    await loaded();
    await user.clear(field("Name"));
    await user.type(field("Name"), "Ada King");
    await user.clear(field("Bio"));
    await user.type(field("New password"), "difference engine");
    await user.click(saveButton());

    // The flash's check alone, read as "Changes saved".
    expect(await screen.findByRole("alert")).toHaveTextContent("Changes saved");
    expect(saved()).toEqual([{ name: "Ada King", password: "difference engine", bio: "" }]);
    expect(field("Name")).toHaveValue("Ada King");
    expect(field("Bio")).toHaveValue("");
    expect(field("New password")).toHaveValue("");
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("sends only what you changed, then shows what's saved, so it doesn't undo another tab's save", async () => {
    // Another tab saved a new name after this page loaded.
    serve({ saved: () => Response.json({ profile: { ...profile, name: "Ada King", bio: "Countess of Lovelace" } }) });
    const { user } = showPage();
    await loaded();
    await user.clear(field("Bio"));
    await user.type(field("Bio"), "Countess of Lovelace");
    await user.click(saveButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("Changes saved");
    expect(saved()).toEqual([{ bio: "Countess of Lovelace" }]);
    expect(field("Name")).toHaveValue("Ada King");
    // Nor does saving again put back the name the page loaded.
    await user.click(saveButton());
    await waitFor(() => expect(saved()).toEqual([{ bio: "Countess of Lovelace" }, {}]));
  });

  it("can't save again until the last save is answered, keeping a password typed meanwhile", async () => {
    let answer = (_: Response) => {};
    serve({ saved: () => new Promise((resolve) => (answer = resolve)) });
    const { user } = showPage();
    await loaded();
    await user.type(field("New password"), "difference engine");
    await user.type(field("Current password"), "analytical engine");
    await user.click(saveButton());
    expect(saveButton()).toBeDisabled();
    await user.type(field("New password"), "s");
    await user.type(field("Current password"), "s");
    await user.keyboard("{Enter}");
    expect(saved()).toHaveLength(1);

    await act(async () => answer(Response.json({ profile })));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(field("New password")).toHaveValue("difference engines");
    expect(field("Current password")).toHaveValue("analytical engines");
  });

  it("says why a save failed, keeping what's typed", async () => {
    serve({ saved: () => Response.json({ error: CURRENT_PASSWORD_WRONG }, { status: 422 }) });
    const { onFailed, user } = showPage();
    await loaded();
    await user.clear(field("Email address"));
    await user.type(field("Email address"), "grace@example.com");
    await user.type(field("New password"), "difference engine");
    await user.type(field("Current password"), "analytical");
    await user.click(saveButton());

    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 422, message: CURRENT_PASSWORD_WRONG })));
    expect(field("Email address")).toHaveValue("grace@example.com");
    expect(field("New password")).toHaveValue("difference engine");
    expect(field("Current password")).toHaveValue("analytical");
    expect(saveButton()).toBeEnabled();
  });

  it("asks for your current password while you have one, sending it with your changes and emptying it once they're saved", async () => {
    const { user } = showPage();
    await loaded();
    const current = field("Current password");
    expect(current).toHaveAttribute("type", "password");
    expect(current).toHaveAttribute("autocomplete", "current-password");
    expect(current).toHaveAttribute("placeholder", "Enter your password");
    expect(current).toHaveAttribute("maxlength", "72");
    expect(current).toHaveAccessibleDescription("Needed to change your email address or password.");
    expect(field("New password").compareDocumentPosition(current)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(current.compareDocumentPosition(field("Bio"))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await user.clear(field("Email address"));
    await user.type(field("Email address"), "countess@example.com");
    await user.type(current, "analytical engine");
    await user.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Changes saved");
    expect(saved()).toEqual([{ emailAddress: "countess@example.com", currentPassword: "analytical engine" }]);
    expect(current).toHaveValue("");
  });

  it("asks for no current password while you have none, until a save gives you one", async () => {
    const without = { ...profile, emailAddress: null, password: false };
    serve({
      loaded: () => Response.json({ profile: without, transferId: LOADED_LINK } satisfies ProfileAnswer),
      saved: () => Response.json({ profile: { ...without, password: true }, transferId: SAVED_LINK } satisfies ProfileAnswer),
    });
    const { user } = showPage();
    await loaded();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(field("New password")).toHaveAccessibleDescription("Leave blank to keep signing in without a password.");

    await user.type(field("New password"), "difference engine");
    await user.click(saveButton());
    expect(await screen.findByLabelText("Current password")).toHaveValue("");
    expect(saved()).toEqual([{ password: "difference engine" }]);
    expect(field("New password")).toHaveAccessibleDescription("Leave blank to keep your current password.");
  });

  it("names this browser's push subscription with a new password, which forgets your other browsers'", async () => {
    const registration = { pushManager: { getSubscription: async () => ({ endpoint: ENDPOINT }) } };
    Object.defineProperty(navigator, "serviceWorker", { value: { getRegistration: async () => registration }, configurable: true });
    const { user } = showPage();
    await loaded();
    await user.type(field("Bio"), "!");
    await user.click(saveButton());
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await user.type(field("New password"), "difference engine");
    await user.type(field("Current password"), "analytical engine");
    await user.click(saveButton());

    await waitFor(() => expect(saved()).toHaveLength(2));
    // Only the new password needed it.
    expect(saved()).toEqual([
      { bio: "Wrote the first program!" },
      { password: "difference engine", currentPassword: "analytical engine", pushSubscriptionEndpoint: ENDPOINT },
    ]);
  });

  it("says why your profile didn't load", async () => {
    serve({ loaded: () => Response.json({ error: "Something went wrong" }, { status: 500 }) });
    const { onFailed } = showPage();
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 500 })));
    expect(saveButton()).toBeDisabled();
  });

  it("goes back to the page it was opened from, or home", () => {
    showPage();
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/");
    act(() => navigate("/rooms/general"));
    act(() => navigate("/users/me/profile"));
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/rooms/general");
  });
});

describe("Sign out", () => {
  it("logs out from the top bar", async () => {
    const { onSignOut, user } = showPage();
    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});

describe("Translation buttons", () => {
  it("has a translation button by each field once an administrator shows them", async () => {
    showPage({ ...account, hideTranslationButtons: false });
    expect(screen.getAllByText("Translate")).toHaveLength(4);
    // And your current password's, which sign-in's translates, once your profile says you have one.
    await loaded();
    expect(screen.getAllByText("Translate")).toHaveLength(5);
  });

  it("has none while they're hidden", () => {
    showPage();
    expect(screen.queryByText("Translate")).not.toBeInTheDocument();
  });
});

describe("Private sign-in link", () => {
  const signInLink = () => screen.queryByRole("textbox", { name: "Use this link to login automatically on another device" });

  it("ends with a sign-in link for you once your profile loads", async () => {
    showPage();
    expect(signInLink()).toBeNull();
    await loaded();
    expect(signInLink()).toHaveValue(`http://localhost:3000/session/transfers#token=${LOADED_LINK}`);
    expect(saveButton().compareDocumentPosition(signInLink()!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("shows a new one each time it saves", async () => {
    const { user } = showPage();
    await loaded();
    await user.type(field("Bio"), "!");
    await user.click(saveButton());
    await waitFor(() => expect(signInLink()).toHaveValue(`http://localhost:3000/session/transfers#token=${SAVED_LINK}`));
  });
});

describe("Levels on your profile", () => {
  const design: SidebarRoom = { id: "design", name: "Design", kind: "open", icon: null, unread: false, involvement: "mentions" };
  const notifications = () => screen.queryByRole("list", { name: "Conversation notifications" });

  it("lists your level in each of your rooms between the form and your sign-in link, once your rooms have loaded", async () => {
    const { showRooms } = showPage();
    await loaded();
    expect(notifications()).toBeNull();

    showRooms([design]);
    expect(notifications()).toHaveTextContent("Design");
    const signInLink = screen.getByRole("textbox", { name: "Use this link to login automatically on another device" });
    expect(saveButton().compareDocumentPosition(notifications()!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(notifications()!.compareDocumentPosition(signInLink)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("says why a bell couldn't save a level", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === "/api/rooms/design/involvement"
        ? Response.json({ error: "Something went wrong" }, { status: 500 })
        : Response.json({ profile, transferId: LOADED_LINK } satisfies ProfileAnswer),
    );
    const { answered, onFailed, user } = showPage(account, [design]);
    await loaded();
    await user.click(screen.getByRole("checkbox", { name: "Notifying about @ mentions" }));
    expect(onFailed).toHaveBeenCalledOnce();
    expect(answered).not.toHaveBeenCalled();
  });
});

describe("Connect Memberful", () => {
  const memberful = () => screen.queryByRole("region", { name: "Memberful" });
  const passwordHelp = () => screen.getByText(/Leave blank to keep/);
  /** What each disconnection sent, in order. */
  const disconnections = () =>
    vi
      .mocked(fetch)
      .mock.calls.filter(([input, init]) => String(input) === MEMBERFUL_CONNECTIONS_PATH && init?.method === "DELETE")
      .map(([, init]) => JSON.parse(String(init?.body)) as MemberfulDisconnection);

  it("has a Memberful section between the form and your rooms' levels while members sign in with Memberful", async () => {
    serve({ loaded: () => Response.json({ profile: { ...profile, memberful: NOT_CONNECTED }, transferId: LOADED_LINK } satisfies ProfileAnswer) });
    const { showRooms } = showPage();
    await loaded();
    showRooms([{ id: "design", name: "Design", kind: "open", icon: null, unread: false, involvement: "mentions" }]);
    expect(memberful()).toHaveTextContent("Connect your Memberful account to keep signing in as yourself.");
    // Its own password field, as you have a password.
    expect(within(memberful()!).getByLabelText("Password")).toBeInTheDocument();
    expect(saveButton().compareDocumentPosition(memberful()!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(memberful()!.compareDocumentPosition(screen.getByRole("list", { name: "Conversation notifications" }))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(passwordHelp()).toHaveTextContent("Leave blank to keep your current password.");
    expect(passwordHelp()).not.toHaveTextContent("disconnects");
  });

  it("names the account once you've connected one, and says that a new password disconnects it", async () => {
    serve({ loaded: () => Response.json({ profile: { ...profile, memberful: CONNECTED }, transferId: LOADED_LINK } satisfies ProfileAnswer) });
    showPage();
    await loaded();
    expect(memberful()).toHaveTextContent("Connected to Memberful as Ada Lovelace (ada@example.com), so you sign in with it.");
    expect(within(memberful()!).getByRole("button", { name: "Disconnect Memberful" })).toBeEnabled();
    expect(passwordHelp()).toHaveTextContent("Leave blank to keep your current password. A new one disconnects your Memberful account.");
  });

  it("offers no password to someone without one whom Memberful signs in, whose way in it is, and saves the rest without one", async () => {
    const theirs = { ...profile, password: false, memberful: CONNECTED };
    serve({
      loaded: () => Response.json({ profile: theirs, transferId: LOADED_LINK } satisfies ProfileAnswer),
      saved: () => Response.json({ profile: { ...theirs, emailAddress: "countess@example.com" }, transferId: SAVED_LINK } satisfies ProfileAnswer),
    });
    const { user } = showPage();
    await loaded();
    expect(memberful()).toHaveTextContent("Connected to Memberful as Ada Lovelace (ada@example.com), so you sign in with it.");
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(within(memberful()!).queryByRole("button", { name: "Disconnect Memberful" })).not.toBeInTheDocument();

    await user.clear(field("Email address"));
    await user.type(field("Email address"), "countess@example.com");
    await user.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Changes saved");
    expect(saved()).toEqual([{ emailAddress: "countess@example.com" }]);
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("offers a first password to someone without one once Memberful doesn't sign them in, as at a deployment without its keys", async () => {
    serve({ loaded: () => Response.json({ profile: { ...profile, password: false, memberful: null }, transferId: LOADED_LINK } satisfies ProfileAnswer) });
    showPage();
    await loaded();
    expect(memberful()).toBeNull();
    expect(passwordHelp()).toHaveTextContent("Leave blank to keep signing in without a password.");
    expect(passwordHelp()).not.toHaveTextContent("disconnects");
  });

  it("asks someone with a password but no email address to add one first, and warns of a new password disconnecting it only once one is typed", async () => {
    serve({ loaded: () => Response.json({ profile: { ...profile, emailAddress: null, memberful: CONNECTED }, transferId: LOADED_LINK } satisfies ProfileAnswer) });
    const { user } = showPage();
    await loaded();
    expect(memberful()).toHaveTextContent("Add your email address above to disconnect it, so that you can still sign in with your password.");
    expect(within(memberful()!).queryByRole("button", { name: "Disconnect Memberful" })).not.toBeInTheDocument();
    expect(passwordHelp()).toHaveTextContent("Leave blank to keep your current password.");
    expect(passwordHelp()).not.toHaveTextContent("disconnects");
    // Saved with an email address, a new password would disconnect it.
    await user.type(screen.getByLabelText("Email address"), "ada@example.com");
    expect(passwordHelp()).toHaveTextContent("Leave blank to keep your current password. A new one disconnects your Memberful account.");
  });

  it("disconnects it with your password, offering to connect one again, with the notice", async () => {
    serve({ loaded: () => Response.json({ profile: { ...profile, memberful: CONNECTED }, transferId: LOADED_LINK } satisfies ProfileAnswer) });
    const { user, onFailed } = showPage();
    await loaded();
    await user.type(within(memberful()!).getByLabelText("Password"), "analytical engine");
    await user.click(within(memberful()!).getByRole("button", { name: "Disconnect Memberful" }));
    await waitFor(() => expect(memberful()).toHaveTextContent("Connect your Memberful account to keep signing in as yourself."));
    expect(disconnections()).toEqual([{ currentPassword: "analytical engine" }]);
    expect(await screen.findByRole("alert")).toHaveTextContent(MEMBERFUL_DISCONNECTED_NOTICE);
    expect(passwordHelp()).toHaveTextContent("Leave blank to keep your current password.");
    expect(passwordHelp()).not.toHaveTextContent("disconnects");
    // With a new sign-in link, as each answer brings.
    expect(screen.getByRole("textbox", { name: "Use this link to login automatically on another device" })).toHaveValue(`http://localhost:3000/session/transfers#token=${SAVED_LINK}`);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("keeps showing it disconnected when a save answers late with the account still connected, since only a reload connects one", async () => {
    // A save, or a photo, sent before Disconnect can answer after it, as the profile was before.
    serve({
      loaded: () => Response.json({ profile: { ...profile, memberful: CONNECTED }, transferId: LOADED_LINK } satisfies ProfileAnswer),
      saved: () => Response.json({ profile: { ...profile, name: "Ada King", memberful: CONNECTED }, transferId: SAVED_LINK } satisfies ProfileAnswer),
    });
    const { user } = showPage();
    await loaded();
    await user.type(within(memberful()!).getByLabelText("Password"), "analytical engine");
    await user.click(within(memberful()!).getByRole("button", { name: "Disconnect Memberful" }));
    await waitFor(() => expect(memberful()).toHaveTextContent("Connect your Memberful account to keep signing in as yourself."));
    await user.type(field("Name"), " King");
    await user.click(saveButton());
    await waitFor(() => expect(field("Name")).toHaveValue("Ada King"));
    expect(memberful()).toHaveTextContent("Connect your Memberful account to keep signing in as yourself.");
    expect(within(memberful()!).queryByRole("button", { name: "Disconnect Memberful" })).not.toBeInTheDocument();
    expect(passwordHelp()).not.toHaveTextContent("disconnects");
  });

  it("keeps offering Disconnect when a photo's answer arrives late without the email address saved since, which only the profile's own answers change", async () => {
    // A photo picked before an email address is saved can answer after it, as the profile was before.
    serve({
      loaded: () => Response.json({ profile: { ...profile, memberful: CONNECTED }, transferId: LOADED_LINK } satisfies ProfileAnswer),
      uploaded: () =>
        Response.json({ profile: { ...profile, emailAddress: null, avatarUrl: UPLOADED, avatar: true, memberful: CONNECTED }, transferId: SAVED_LINK } satisfies ProfileAnswer),
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:moon");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { user } = showPage();
    await loaded();
    await user.upload(screen.getByLabelText("Upload avatar", { exact: false }), new File(["moon"], "moon.jpg", { type: "image/jpeg" }));
    await waitFor(() => expect(screen.getByRole("img", { name: "Your avatar" })).toHaveAttribute("src", UPLOADED));
    expect(within(memberful()!).getByRole("button", { name: "Disconnect Memberful" })).toBeEnabled();
    expect(memberful()).not.toHaveTextContent("Add your email address");
  });

  it("takes the section away once it's disconnected while Memberful isn't members only, since your password signs you in", async () => {
    serve({
      loaded: () => Response.json({ profile: { ...profile, memberful: { membersOnly: false, connected: ADAS_ACCOUNT } }, transferId: LOADED_LINK } satisfies ProfileAnswer),
      disconnected: () => Response.json({ profile: { ...profile, memberful: null }, transferId: SAVED_LINK } satisfies ProfileAnswer),
    });
    const { user } = showPage();
    await loaded();
    expect(memberful()).toHaveTextContent("Connected to Memberful as Ada Lovelace (ada@example.com), so you can sign in with it too.");
    await user.type(within(memberful()!).getByLabelText("Password"), "analytical engine");
    await user.click(within(memberful()!).getByRole("button", { name: "Disconnect Memberful" }));
    await waitFor(() => expect(memberful()).not.toBeInTheDocument());
    expect(await screen.findByRole("alert")).toHaveTextContent(MEMBERFUL_DISCONNECTED_NOTICE);
  });

  it("says why it didn't disconnect", async () => {
    serve({
      loaded: () => Response.json({ profile: { ...profile, memberful: CONNECTED }, transferId: LOADED_LINK } satisfies ProfileAnswer),
      disconnected: () => Response.json({ error: CURRENT_PASSWORD_WRONG }, { status: 422 }),
    });
    const { user, onFailed } = showPage();
    await loaded();
    await user.type(within(memberful()!).getByLabelText("Password"), "wrong");
    await user.click(within(memberful()!).getByRole("button", { name: "Disconnect Memberful" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 422, message: CURRENT_PASSWORD_WRONG })));
    expect(memberful()).toHaveTextContent("Connected to Memberful as Ada Lovelace (ada@example.com), so you sign in with it.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("tells someone who needs no membership, as an administrator or someone they invited, that they can sign in with it too", async () => {
    serve({ loaded: () => Response.json({ profile: { ...profile, membershipNeeded: false, memberful: NOT_CONNECTED }, transferId: LOADED_LINK } satisfies ProfileAnswer) });
    showPage();
    await loaded();
    expect(memberful()).toHaveTextContent("Connect your Memberful account to sign in with it too.");
  });

  it("has none while members don't sign in with Memberful", async () => {
    showPage();
    await loaded();
    expect(memberful()).not.toBeInTheDocument();
  });
});

describe("Ember AI on your profile", () => {
  const section = () => screen.queryByRole("region", { name: "Ember AI" });
  const dial = (name: string) => within(section()!).getByRole("group", { name });
  const level = (dialName: string, name: string) => within(dial(dialName)).getByRole("radio", { name });
  const withLevels = () => serve({ loaded: () => Response.json({ profile: { ...profile, assistant: LEVELS }, transferId: LOADED_LINK } satisfies ProfileAnswer) });

  it("has your levels of @ember's dials while Ember AI is on, between the form and your rooms' levels, none above the most allowed", async () => {
    withLevels();
    const { showRooms } = showPage();
    await loaded();
    showRooms([{ id: "design", name: "Design", kind: "open", icon: null, unread: false, involvement: "mentions" }]);
    expect(section()).toHaveTextContent("How much @ember thinks before it answers you, and how long its answers are, up to the most an administrator allows.");
    expect(level("Thinking", "Low")).toBeChecked();
    expect(dial("Thinking")).toHaveAccessibleDescription("Thinks a little first, up to about 4,000 tokens.");
    for (const name of ["Off", "Low", "Medium"]) expect(level("Thinking", name)).toBeEnabled();
    expect(level("Thinking", "High")).toBeDisabled();
    expect(level("Answer length", "Medium")).toBeChecked();
    expect(dial("Answer length")).toHaveAccessibleDescription("About 400 words.");
    expect(level("Answer length", "Long")).toBeEnabled();
    expect(saveButton().compareDocumentPosition(section()!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(section()!.compareDocumentPosition(screen.getByRole("list", { name: "Conversation notifications" }))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("saves a level as soon as it's chosen, showing it meanwhile", async () => {
    withLevels();
    const { user } = showPage();
    await loaded();
    await user.click(level("Thinking", "Medium"));
    expect(level("Thinking", "Medium")).toBeChecked();
    await waitFor(() => expect(level("Thinking", "Off")).toBeEnabled());
    expect(level("Thinking", "Medium")).toBeChecked();
    expect(dial("Thinking")).toHaveAccessibleDescription("Thinks more first, up to about 16,000 tokens.");
    await user.click(level("Answer length", "Long"));
    await waitFor(() => expect(level("Answer length", "Long")).toBeChecked());
    const sent = vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/users/me/assistant").map(([, init]) => [init?.method, JSON.parse(String(init?.body))]);
    expect(sent).toEqual([["PATCH", { thinking: "medium" }], ["PATCH", { length: "long" }]]);
  });

  it("says why a level wasn't saved, showing it as it was", async () => {
    serve({
      loaded: () => Response.json({ profile: { ...profile, assistant: LEVELS }, transferId: LOADED_LINK } satisfies ProfileAnswer),
      leveled: () => Response.json({ error: "Choose a level the dial has." }, { status: 422 }),
    });
    const { user, onFailed } = showPage();
    await loaded();
    await user.click(level("Thinking", "Off"));
    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(level("Thinking", "Low")).toBeChecked();
    expect(level("Thinking", "Off")).toBeEnabled();
  });

  it("keeps the levels a dial saved when a save of the profile answers after it, with your levels from before", async () => {
    let answer = (_: Response) => {};
    serve({
      loaded: () => Response.json({ profile: { ...profile, assistant: LEVELS }, transferId: LOADED_LINK } satisfies ProfileAnswer),
      saved: () => new Promise((resolve) => (answer = resolve)),
    });
    const { user } = showPage();
    await loaded();
    await user.type(field("Name"), " King");
    await user.click(saveButton());
    await user.click(level("Thinking", "Medium"));
    await waitFor(() => expect(level("Thinking", "Off")).toBeEnabled());

    await act(async () => answer(Response.json({ profile: { ...profile, name: "Ada Lovelace King", assistant: LEVELS }, transferId: SAVED_LINK } satisfies ProfileAnswer)));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(level("Thinking", "Medium")).toBeChecked();
  });

  it("has none once Ember AI is turned off, as a save says", async () => {
    serve({
      loaded: () => Response.json({ profile: { ...profile, assistant: LEVELS }, transferId: LOADED_LINK } satisfies ProfileAnswer),
      leveled: () => Response.json({ assistant: null } satisfies YourAssistantChanged),
    });
    const { user } = showPage();
    await loaded();
    await user.click(level("Answer length", "Short"));
    await waitFor(() => expect(section()).not.toBeInTheDocument());
  });

  it("has none while Ember AI is off", async () => {
    showPage();
    await loaded();
    expect(section()).not.toBeInTheDocument();
  });

  it("has no Model menu while people can pick only the one model", async () => {
    withLevels();
    showPage();
    await loaded();
    expect(within(section()!).queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("Your model on your profile", () => {
  const section = () => screen.getByRole("region", { name: "Ember AI" });
  const menu = () => within(section()).getByRole("combobox", { name: "Model" });
  /** Ada's model and levels while administrators let people pick from three models, Claude Sonnet 5.5 hers. */
  const PICKING: YourAssistant = {
    ...LEVELS,
    model: "anthropic/claude-sonnet-5.5",
    models: [
      { id: "@cf/zai-org/glm-4.7-flash", name: "GLM-4.7 Flash", format: "chat" },
      { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", format: "messages" },
      { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", format: "responses" },
    ],
  };
  const picking = (leveled?: Answers["leveled"]) =>
    serve({
      loaded: () => Response.json({ profile: { ...profile, assistant: PICKING }, transferId: LOADED_LINK } satisfies ProfileAnswer),
      leveled:
        leveled ?? (({ model, ...levels }) => Response.json({ assistant: { ...PICKING, model: model === undefined ? PICKING.model : model, levels: { ...PICKING.levels, ...levels } } })),
    });

  it("has a Model menu of Default, naming the administrators' choice, then the models they let people pick, set at yours", async () => {
    picking();
    showPage();
    await loaded();
    expect(section()).toHaveTextContent(
      "Which model @ember answers you with, how much it thinks first, and how long its answers are, up to the most an administrator allows.",
    );
    expect(within(menu()).getAllByRole("option").map((option) => option.textContent)).toEqual(["Default (GLM-4.7 Flash)", "GLM-4.7 Flash", "Claude Sonnet 5.5", "GPT-6.1 Sol"]);
    expect(menu()).toHaveValue("anthropic/claude-sonnet-5.5");
    expect(menu()).toHaveAccessibleDescription(DEFAULT_MODEL_EXPLAINED);
    expect(menu().compareDocumentPosition(within(section()).getByRole("group", { name: "Thinking" }))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("is set at Default while you leave your model to administrators", async () => {
    serve({ loaded: () => Response.json({ profile: { ...profile, assistant: { ...PICKING, model: null } }, transferId: LOADED_LINK } satisfies ProfileAnswer) });
    showPage();
    await loaded();
    expect(menu()).toHaveValue("");
    expect(within(menu()).getByRole("option", { selected: true })).toHaveTextContent("Default (GLM-4.7 Flash)");
  });

  it("saves a model as soon as it's picked, Default as following the administrators' choice, and their model picked by name as yours", async () => {
    picking();
    const { user } = showPage();
    await loaded();
    await user.selectOptions(menu(), "GPT-6.1 Sol");
    expect(menu()).toHaveValue("openai/gpt-6.1-sol");
    await waitFor(() => expect(menu()).toBeEnabled());
    await user.selectOptions(menu(), "Default (GLM-4.7 Flash)");
    expect(menu()).toHaveValue("");
    await waitFor(() => expect(menu()).toBeEnabled());
    // The model administrators chose, picked by name, stays yours once they choose another.
    await user.selectOptions(menu(), "GLM-4.7 Flash");
    await waitFor(() => expect(menu()).toBeEnabled());
    expect(menu()).toHaveValue("@cf/zai-org/glm-4.7-flash");
    const sent = vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/users/me/assistant").map(([, init]) => JSON.parse(String(init?.body)));
    expect(sent).toEqual([{ model: "openai/gpt-6.1-sol" }, { model: null }, { model: "@cf/zai-org/glm-4.7-flash" }]);
  });

  it("offers only the levels of thinking your model took when it was added, saying which it can't be set to, and each for one that took none, which decides itself", async () => {
    let yours: YourAssistant = {
      ...PICKING,
      model: "openai/gpt-6.1-sol",
      levels: { thinking: "off", length: "medium" },
      models: [
        { id: "@cf/zai-org/glm-4.7-flash", name: "GLM-4.7 Flash", format: "chat" },
        { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", format: "responses", thinkingLevels: ["low", "medium", "high"] },
        { id: "xai/grok-4.20-0309-reasoning", name: "Grok 4.20 Reasoning", format: "chat", thinkingLevels: [] },
      ],
    };
    serve({
      loaded: () => Response.json({ profile: { ...profile, assistant: yours }, transferId: LOADED_LINK } satisfies ProfileAnswer),
      leveled: ({ model, ...levels }) => {
        yours = { ...yours, model: model === undefined ? yours.model : model, levels: { ...yours.levels, ...levels } };
        return Response.json({ assistant: yours } satisfies YourAssistantChanged);
      },
    });
    const { user } = showPage();
    await loaded();
    const thinking = () => within(section()).getByRole("group", { name: "Thinking" });
    const level = (name: string) => within(thinking()).getByRole("radio", { name });

    expect(level("Off")).toBeChecked();
    expect(level("Off")).toBeDisabled();
    for (const name of ["Low", "Medium"]) expect(level(name)).toBeEnabled();
    expect(level("High")).toBeDisabled();
    expect(thinking()).toHaveAccessibleDescription("GPT-6.1 Sol can't be set to Off, so it thinks at Low instead.");
    await user.click(level("Low"));
    await waitFor(() => expect(menu()).toBeEnabled());
    expect(thinking()).toHaveAccessibleDescription("Thinks a little first, up to about 4,000 tokens. GPT-6.1 Sol can't be set to Off.");

    await user.selectOptions(menu(), "Grok 4.20 Reasoning");
    await waitFor(() => expect(menu()).toBeEnabled());
    for (const name of ["Off", "Low", "Medium"]) expect(level(name)).toBeEnabled();
    expect(thinking()).toHaveAccessibleDescription("Grok 4.20 Reasoning can't be told how much to think, so it decides for itself, up to about 4,000 tokens.");

    // A model added before Ember asked models at each level is offered at every one.
    await user.selectOptions(menu(), "Default (GLM-4.7 Flash)");
    await waitFor(() => expect(menu()).toBeEnabled());
    for (const name of ["Off", "Low", "Medium"]) expect(level(name)).toBeEnabled();
    expect(thinking()).toHaveAccessibleDescription("Thinks a little first, up to about 4,000 tokens.");
  });

  it("says why a model wasn't saved, showing yours as it was", async () => {
    picking(() => Response.json({ error: MODEL_NOT_LISTED }, { status: 422 }));
    const { user, onFailed } = showPage();
    await loaded();
    await user.selectOptions(menu(), "GPT-6.1 Sol");
    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(menu()).toHaveValue("anthropic/claude-sonnet-5.5");
    expect(menu()).toBeEnabled();
  });
});

describe("Install as an app", () => {
  const install = () => screen.queryByText("Install Ember as a web app.")?.closest("details");

  it("says how to install Ember under the page's heading, closed, to a browser that gets install steps", async () => {
    showPage(account, null, SAFARI_MAC);
    await loaded();
    expect(install()).not.toHaveAttribute("open");
    expect(screen.getByRole("heading", { level: 1, name: "Your profile" }).compareDocumentPosition(install()!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(install()!.compareDocumentPosition(field("Name"))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("says nothing of it to Chrome", async () => {
    showPage(account, null, CHROME_MAC);
    await loaded();
    expect(install()).toBeUndefined();
  });
});

describe("Upload an avatar", () => {
  const avatar = () => screen.getByRole("img", { name: "Your avatar" });
  const picker = () => screen.getByLabelText("Upload avatar", { exact: false });
  const removeButton = () => screen.queryByRole("button", { name: "Remove avatar" });
  /** What each avatar saved sent, in order. */
  const uploads = () =>
    vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "PUT")
      .map(([, init]) => init?.body as FormData);
  const moon = () => new File(["moon"], "moon.jpg", { type: "image/jpeg" });

  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:moon");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("shows your avatar above the form, to change with a photo", async () => {
    showPage();
    expect(picker()).toBeDisabled();
    await loaded();
    expect(avatar()).toHaveAttribute("src", INITIALS);
    expect(picker()).toBeEnabled();
    expect(picker()).toHaveAttribute("type", "file");
    expect(picker()).toHaveAttribute("accept", "image/*");
    expect(picker()).toHaveAccessibleDescription("Choose a profile photo");
    expect(picker().compareDocumentPosition(field("Name"))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // Nothing to remove while your initials show.
    expect(removeButton()).toBeNull();
  });

  it("saves a photo as soon as it's picked, showing it meanwhile, with its variant and a notice", async () => {
    let answer = (_: Response) => {};
    serve({ uploaded: () => new Promise((resolve) => (answer = resolve)) });
    const { onFailed, user } = showPage();
    await loaded();
    const photo = moon();
    await user.upload(picker(), photo);

    await waitFor(() => expect(uploads()).toHaveLength(1));
    expect(avatar()).toHaveAttribute("src", "blob:moon");
    expect(picker()).toBeDisabled();
    const [sent] = uploads();
    expect(sent!.get("avatar")).toMatchObject({ name: "moon.jpg", type: "image/jpeg" });
    expect(sent!.get("variant")).toMatchObject({ type: "image/webp" });

    await act(async () => answer(Response.json({ profile: { ...profile, avatarUrl: UPLOADED, avatar: true }, transferId: SAVED_LINK })));
    expect(await screen.findByRole("alert")).toHaveTextContent(AVATAR_CHANGED);
    expect(avatar()).toHaveAttribute("src", UPLOADED);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:moon");
    expect(picker()).toBeEnabled();
    expect(removeButton()).toBeInTheDocument();
    // A new sign-in link.
    expect(screen.getByRole("textbox", { name: "Use this link to login automatically on another device" })).toHaveValue(
      `http://localhost:3000/session/transfers#token=${SAVED_LINK}`,
    );
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("removes your avatar with Remove avatar, saying nothing", async () => {
    serve({ loaded: () => Response.json({ profile: { ...profile, avatarUrl: UPLOADED, avatar: true }, transferId: LOADED_LINK }) });
    const { user } = showPage();
    await loaded();
    await user.click(removeButton()!);

    await waitFor(() => expect(removeButton()).toBeNull());
    expect(avatar()).toHaveAttribute("src", "/users/t0k3n/avatar?v=3");
    expect(fetch).toHaveBeenCalledWith(AVATAR_PATH, expect.objectContaining({ method: "DELETE" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a photo saved meanwhile when a profile's save is answered after it", async () => {
    let answerSave = (_: Response) => {};
    serve({ saved: () => new Promise((resolve) => (answerSave = resolve)) });
    const { user } = showPage();
    await loaded();
    await user.type(field("Bio"), "!");
    await user.click(saveButton());
    await user.upload(picker(), moon());
    await waitFor(() => expect(avatar()).toHaveAttribute("src", UPLOADED));

    // The save was made before the photo was, so its answer has the avatar from before.
    await act(async () => answerSave(Response.json({ profile: { ...profile, bio: "Wrote the first program!" }, transferId: SAVED_LINK })));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(avatar()).toHaveAttribute("src", UPLOADED);
    expect(removeButton()).toBeInTheDocument();
  });

  it("shows your avatar as another tab changes it, once the people directory hears", async () => {
    const { showPeople } = showPage();
    await loaded();
    const listed = (avatarUrl: string): People => new Map([[ada.id, { id: ada.id, name: ada.name, bio: null, role: "member", status: "active", avatarUrl } satisfies DirectoryUser]]);
    // The directory can list an avatar from before the profile loaded.
    showPeople(listed("/users/t0k3n/avatar?v=0"));
    expect(avatar()).toHaveAttribute("src", INITIALS);
    showPeople(listed(UPLOADED));
    expect(avatar()).toHaveAttribute("src", UPLOADED);
  });

  it("says a photo over 16 MB is too large without sending it", async () => {
    const { user } = showPage();
    await loaded();
    const huge = moon();
    Object.defineProperty(huge, "size", { value: MAX_AVATAR_SIZE + 1 });
    await user.upload(picker(), huge);

    expect(await screen.findByRole("alert")).toHaveTextContent(AVATAR_TOO_LARGE);
    expect(uploads()).toEqual([]);
    expect(avatar()).toHaveAttribute("src", INITIALS);
  });

  it("says why a photo couldn't be saved, showing your avatar as it was", async () => {
    serve({ uploaded: () => Response.json({ error: "Ember isn't set up to store files" }, { status: 503 }) });
    const { onFailed, user } = showPage();
    await loaded();
    await user.upload(picker(), moon());

    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 503, message: "Ember isn't set up to store files" })));
    expect(avatar()).toHaveAttribute("src", INITIALS);
    expect(picker()).toBeEnabled();
  });
});

describe("Custom CSS", () => {
  it("keeps the passwords typed out of their fields' value attributes, where custom CSS could read them", async () => {
    const { user } = showPage();
    await loaded();
    for (const label of ["New password", "Current password"]) {
      await user.type(field(label), "difference engine");
      expect(field(label)).toHaveValue("difference engine");
      expect(field(label)).not.toHaveAttribute("value");
    }
  });
});

describe("AI apps on your profile", () => {
  const CLAUDE = { id: "0mgk3x2a9b4c70", name: "Claude", comesBackTo: "claude.example", scopes: ["read" as const], connectedAt: "2026-11-14T09:00:00.000Z", usedAt: null };

  it("aren't shown while AI apps can't connect as you", async () => {
    serve();
    showPage();
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Ada Lovelace"));
    expect(screen.queryByRole("heading", { level: 2, name: "AI apps" })).not.toBeInTheDocument();
  });

  it("lists the AI apps connected as you, as the profile loads them, and as disconnecting one leaves them", async () => {
    const fetch = serve({ loaded: () => Response.json({ profile: { ...profile, outsideAi: [CLAUDE] }, transferId: LOADED_LINK } satisfies ProfileAnswer) });
    const { user } = showPage();

    expect(await screen.findByRole("heading", { level: 2, name: "AI apps" })).toBeVisible();
    fetch.mockImplementationOnce(async () => Response.json({ connections: [] }));
    await user.click(screen.getByRole("button", { name: "Disconnect Claude" }));
    expect(await screen.findByText(NOTHING_CONNECTED)).toBeVisible();
    expect(fetch).toHaveBeenLastCalledWith(`/api/users/me/outside/${CLAUDE.id}`, expect.objectContaining({ method: "DELETE" }));
    expect(screen.getByRole("heading", { level: 2, name: "AI apps" })).toBeVisible();
  });
});

describe("Apps on your profile", () => {
  const LINEAR = { id: "0mgk3x2a9b4c70", name: "Linear", signedInAt: "2026-11-14T09:00:00.000Z", ended: false, wantsMore: false };

  it("aren't shown while there's no app to sign in to yourself", async () => {
    serve();
    showPage();
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Ada Lovelace"));
    expect(screen.queryByRole("heading", { level: 2, name: "Apps" })).not.toBeInTheDocument();
  });

  it("lists the apps you can sign in to yourself, as the profile loads them, and as signing out of one leaves them", async () => {
    const fetch = serve({ loaded: () => Response.json({ profile: { ...profile, apps: [LINEAR] }, transferId: LOADED_LINK } satisfies ProfileAnswer) });
    const signedOut = { apps: [{ ...LINEAR, signedInAt: null }], revoked: true };
    const { user } = showPage();

    expect(await screen.findByRole("heading", { level: 2, name: "Apps" })).toBeVisible();
    fetch.mockImplementationOnce(async () => Response.json(signedOut));
    await user.click(screen.getByRole("button", { name: "Sign out of Linear" }));
    expect(await screen.findByRole("button", { name: "Sign in to Linear" })).toBeVisible();
    expect(fetch).toHaveBeenLastCalledWith(`/api/users/me/apps/${LINEAR.id}/sign-in`, expect.objectContaining({ method: "DELETE" }));
  });
});
