import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOGO_PATH,
  LOGO_TOO_LARGE,
  MAX_LOGO_SIZE,
  MAX_TAGLINE_LENGTH,
  NO_EMAIL_DOMAINS,
  OPEN_WITH_MEMBERFUL,
  TRYING_BETAS,
  UPDATING_EMBER,
  type Account,
  type AccountChanges,
  type AssistantSetup,
  type CopyOnGitHub,
  type DirectoryUser,
  type EmailInvitation,
  type Invited,
  type Me,
  type ReleaseCheck,
  type RoleChange,
  type RoomId,
  type SidebarRoom,
  type WorkspaceSettings,
} from "@ember/protocol";
import { formatOf, TOP_LEVELS, modelName, type AssistantChanges, type AssistantSettings, type NewAssistantModel } from "@ember/protocol/assistant";
import type { Agent, Agents } from "@ember/protocol/agents";
import type { HuddlesSetup } from "@ember/protocol/huddles";
import { FlashProvider } from "@/components/flash";
import { Sheet } from "@/components/ui/sheet";
import { AccountContext } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { navigate, WORKSPACE_SETTINGS_PATH } from "@/hooks/use-route";
import { ApiError } from "@/lib/api";
import { timeLabel } from "@/lib/messages";
// Ember's own Update Ember workflow, which the card offers a copy without one: the copy beside the deploy
// script, which CI keeps the same as .github's, since a copy's .github keeps its own workflow, or none.
import EMBERS_WORKFLOW from "../../../../worker/scripts/update-ember.yml?raw";
// And its beta workflow, which the card offers a copy without one while a beta's out to try.
import EMBERS_BETA_WORKFLOW from "../../../../worker/scripts/update-ember-beta.yml?raw";
import {
  HOW_COPIES_TRY_BETAS,
  HOW_COPIES_UPDATE,
  HOW_THIS_COPY_TRIES_BETAS,
  HOW_THIS_COPY_UPDATES,
  HOW_TO_ADD_THE_BETA_WORKFLOW,
  HOW_TO_ADD_THE_WORKFLOW,
} from "./ember-version";
import { AGENTS_ANSWER, ASSISTANT_EXPLAINED } from "./assistant-settings";
import { CONFIRM_STOP_OUTSIDE_AI } from "./outside-ai-settings";
import { CONFIRM_REMOVE } from "./people-list";
import { workspaceSectionPath, type WorkspaceSection } from "./settings-navigation";
import { CHANGES_SAVED } from "./settings-page";
import { CONFIRM_MEMBERS_ONLY, CONFIRM_OPEN } from "./ways-to-join";
import { WorkspaceSettingsPage } from "./workspace-settings-page";

vi.mock("@/lib/previews", () => ({
  logoVariantsOf: vi.fn(async () => ({ large: new Blob(["large"], { type: "image/png" }), small: new Blob(["small"], { type: "image/png" }) })),
}));

const JOIN_CODE = "aB3d-Ef5h-iJ7k";
const NEW_JOIN_CODE = "Zy9x-Wv8u-Ts7r";
const asAdministrator: WorkspaceSettings = {
  account: { name: "Analytical Engines", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false },
  joinCode: JOIN_CODE,
  canAdminister: true,
  memberfulSite: null,
  memberfulWebhooks: false,
  turnstile: null,
  assistant: null,
  huddles: null,
  outsideAi: false,
  cloudflareAccountId: null,
  email: { provider: "cloudflare", resendKey: null, cloudflare: true, from: null },
  invitations: [],
  emailDomains: [],
  addresses: { deployed: null, others: [] },
};
const asMember: WorkspaceSettings = { ...asAdministrator, canAdminister: false };
/** As someone who signed in with just a name sees the settings: without the join link's code. */
const asGuest: WorkspaceSettings = { ...asMember, joinCode: null };

/** Someone as the people directory lists them. */
const listed = (id: string, name: string, role: DirectoryUser["role"] = "member", status: DirectoryUser["status"] = "active"): DirectoryUser => ({
  id,
  name,
  bio: null,
  role,
  status,
  avatarUrl: `/users/${id}.token/avatar?v=20261014120000`,
});

const ada = listed("u1", "Ada Lovelace", "administrator");
const grace = listed("u2", "Grace Hopper", "administrator");
// Lowercase, which the list folds, as SQLite's LOWER does.
const linus = listed("u3", "linus Torvalds");
const mallory = listed("u4", "Mallory", "member", "banned");
/** The workspace's people, in no order, with a bot and someone removed, whom the list leaves out. */
const everyone = [mallory, listed("u5", "Build Bot", "bot"), linus, listed("u6", "Charles Babbage", "member", "deactivated"), grace, ada];
const asAda: Me = { id: ada.id, name: ada.name, administrator: true };
const asLinus: Me = { id: linus.id, name: linus.name, administrator: false };

/** A room shared by name, as the sidebar lists it. */
const shared = (id: string, name: string): SidebarRoom => ({ id, name, kind: id.startsWith("secret") ? "closed" : "open", icon: null, unread: false, involvement: "mentions" });
/** Ada's rooms, in the order she joined them, as her sidebar lists them, with a DM, which isn't put in order. */
const adasRooms: SidebarRoom[] = [
  shared("general", "general"),
  shared("random", "random"),
  shared("secret", "Design"),
  { id: "dm", kind: "direct", members: [asAda, { id: grace.id, name: grace.name }], activeAt: "2026-10-16T12:00:00.000Z", unread: false, involvement: "everything" },
];

interface Answers {
  /** What saving the name or the settings answers, rather than the workspace changed as asked. */
  saved?: () => Response | Promise<Response>;
  /** What regenerating the join link answers, rather than `NEW_JOIN_CODE`. */
  regenerated?: () => Response | Promise<Response>;
  /** What changing someone's role answers, rather than them with the role sent. */
  roleChanged?: () => Response | Promise<Response>;
  /** What removing someone answers, rather than them removed. */
  removed?: () => Response | Promise<Response>;
  /** What saving the shared order answers, rather than the rooms sent. */
  ordered?: () => Response | Promise<Response>;
  /** What saving a logo answers, rather than the workspace with `LOGO`. */
  logoSaved?: () => Response | Promise<Response>;
}

/** The workspace's logo once one is uploaded. */
const LOGO = "/account/logo?v=20261017120000";

/** @ember's avatar while it's Ember's flame. */
const EMBER_FLAME = "/users/ember.abc/avatar?v=20261101120000";

/** An agent, as the AI assistant tab lists it while Ember AI is on. */
const RECAP: Agent = {
  id: "0mgk3x2a9b4c60",
  name: "Recap",
  bio: null,
  role: "bot",
  status: "active",
  avatarUrl: "/users/0mgk3x2a9b4c60/avatar?v=1",
  description: "Sums up threads into decisions and to-dos.",
  model: "anthropic/claude-sonnet-5.5",
  modelName: "Claude Sonnet 5.5",
  webTools: [],
  rooms: null,
};

/** Answers the page's requests as the server would for `settings`, or as `answers` says. */
function serve(settings: WorkspaceSettings, { saved, regenerated, roleChanged, removed, ordered, logoSaved }: Answers = {}) {
  let { account, emailDomains: keptDomains, email, turnstile, assistant, huddles, outsideAi } = settings;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    const person = request.match(/^PATCH \/api\/account\/users\/(.+)$/);
    if (person) {
      const { role } = JSON.parse(String(init?.body)) as RoleChange;
      return roleChanged ? roleChanged() : Response.json({ user: { ...everyone.find((user) => user.id === person[1]), role } });
    }
    const removing = request.match(/^DELETE \/api\/account\/users\/(.+)$/);
    if (removing) return removed ? removed() : Response.json({ user: { ...everyone.find((user) => user.id === removing[1]), status: "deactivated" } });
    switch (request) {
      case "GET /api/account":
        return Response.json({ ...settings, account, emailDomains: keptDomains, email, turnstile, assistant, huddles, outsideAi });
      case "PATCH /api/account": {
        if (saved) return saved();
        const {
          name = account.name,
          tagline = account.tagline,
          settings: changed,
          customDomain = account.customDomain,
          emailDomains = keptDomains,
          emailFrom = email.from,
        } = JSON.parse(String(init?.body)) as AccountChanges;
        email = { ...email, from: emailFrom };
        // Members only turns Memberful on with it, and turning Memberful off turns it off, as the Worker does.
        const memberfulJoin = changed?.memberfulJoin ?? (changed?.memberfulSignIn || account.memberfulJoin);
        const emailDomainSignUp = changed?.emailDomainSignUp ?? account.emailDomainSignUp;
        keptDomains = emailDomains;
        account = {
          ...account,
          name,
          tagline,
          hideTranslationButtons: changed?.hideTranslationButtons ?? account.hideTranslationButtons,
          restrictRoomCreation: changed?.restrictRoomCreation ?? account.restrictRoomCreation,
          customDomain,
          joinLink: changed?.joinLink ?? account.joinLink,
          openSignUp: changed?.openSignUp ?? account.openSignUp,
          memberfulJoin,
          memberfulSignIn: memberfulJoin && (changed?.memberfulSignIn ?? account.memberfulSignIn),
          // The workspace shows Email domain's domains only while it's on, as the Worker does.
          emailDomainSignUp,
          emailDomains: emailDomainSignUp ? keptDomains : [],
        };
        return Response.json({ account });
      }
      case `PUT ${LOGO_PATH}`:
        if (logoSaved) return logoSaved();
        account = { ...account, logo: LOGO };
        return Response.json({ account });
      case `DELETE ${LOGO_PATH}`:
        account = { ...account, logo: null };
        return Response.json({ account });
      case "POST /api/account/join_code":
        return regenerated ? regenerated() : Response.json({ joinCode: NEW_JOIN_CODE });
      case "PUT /api/account/resend_api_key":
        email = { ...email, provider: "resend", resendKey: "saved" };
        return Response.json(email);
      case "POST /api/account/test_email":
        return Response.json({ to: "ada@example.com" });
      case "PUT /api/account/turnstile_keys":
        turnstile = "saved";
        return Response.json({ turnstile });
      case "DELETE /api/account/turnstile_keys":
        turnstile = null;
        return Response.json({ turnstile });
      case "PUT /api/account/assistant": {
        const { accountId, model } = JSON.parse(String(init?.body)) as AssistantSetup;
        assistant = {
          accountId,
          model,
          models: [{ id: model, name: modelName(model), format: formatOf(model) }],
          most: assistant?.most ?? TOP_LEVELS,
          webTools: [],
          instructions: assistant?.instructions ?? "",
          promptTemplate: assistant?.promptTemplate ?? null,
          avatarUrl: assistant?.avatarUrl ?? EMBER_FLAME,
          avatar: assistant?.avatar ?? false,
        };
        return Response.json({ assistant, greeting: "Hello, team!" });
      }
      case "PATCH /api/account/assistant": {
        const { model, ...levels } = JSON.parse(String(init?.body)) as AssistantChanges;
        assistant = assistant && { ...assistant, model: model ?? assistant.model, most: { ...assistant.most, ...levels } };
        return Response.json({ assistant });
      }
      case "POST /api/account/assistant/models": {
        const { model } = JSON.parse(String(init?.body)) as NewAssistantModel;
        assistant = assistant && { ...assistant, models: [...assistant.models, { id: model, name: modelName(model), format: formatOf(model) }] };
        return Response.json({ assistant, greeting: "Hi there!" });
      }
      case "DELETE /api/account/assistant/models": {
        const { model } = JSON.parse(String(init?.body)) as { model: string };
        assistant = assistant && { ...assistant, models: assistant.models.filter(({ id }) => id !== model) };
        return Response.json({ assistant });
      }
      case "DELETE /api/account/assistant":
        assistant = null;
        return Response.json({ assistant });
      case "GET /api/account/agents":
        return Response.json({ agents: [RECAP] } satisfies Agents);
      case "GET /api/account/apps":
        return Response.json({ apps: [{ id: "0mgk3x2a9b4c70", name: "Linear", url: "https://mcp.linear.example/mcp", toolCount: 23, setAside: 0, signInEnded: false, wantsAccess: false }] });
      case "PUT /api/account/outside_ai":
        ({ on: outsideAi } = JSON.parse(String(init?.body)) as { on: boolean });
        return Response.json({ on: outsideAi });
      case "PUT /api/account/huddles":
        huddles = { appId: (JSON.parse(String(init?.body)) as HuddlesSetup).appId };
        return Response.json({ huddles });
      case "DELETE /api/account/huddles":
        huddles = null;
        return Response.json({ huddles });
      case "POST /api/invitations": {
        const { emailAddresses } = JSON.parse(String(init?.body)) as { emailAddresses: string[] };
        const outcomes = emailAddresses.map((emailAddress) => ({ emailAddress, invitation: invitationTo(emailAddress), link: `https://ember.test/join/invitation#token=${emailAddress}` }));
        return Response.json({ outcomes } satisfies Invited);
      }
      case "PUT /api/account/room_order":
        return ordered ? ordered() : Response.json({ sharedOrder: (JSON.parse(String(init?.body)) as { roomIds: RoomId[] }).roomIds });
      default:
        throw new Error(`Unexpected request for ${request}`);
    }
  });
}

/** An invitation to `emailAddress`, as the server answers one Ember couldn't email. */
function invitationTo(emailAddress: string): EmailInvitation {
  const createdAt = Date.now();
  return { id: `id-${emailAddress}`, emailAddress, invitedBy: "Ada Lovelace", createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + 7 * 86_400_000).toISOString(), delivery: null };
}

const spies = () => ({
  onAccountChanged: vi.fn(),
  onJoinCodeChanged: vi.fn(),
  reloadPeople: vi.fn(async () => {}),
  onPersonChanged: vi.fn(),
  onFailed: vi.fn(),
  onSharedOrderSaved: vi.fn(),
  onSessionChanged: vi.fn(),
  onCheckForUpdates: vi.fn(async () => {}),
});
type Callbacks = ReturnType<typeof spies>;

/** Changes someone in the people directory the page shows, as the workspace socket does. */
let socketSays: (person: DirectoryUser) => void;
/** Changes the workspace the page shows, as the workspace socket does. */
let workspaceSays: (account: Account) => void;
/** Changes the rooms the page shows, and the shared order, as the sidebar's list does. */
let sidebarSays: (rooms: SidebarRoom[] | null, sharedOrder?: RoomId[]) => void;
/** Changes what the page shows of Ember's releases, as the workspace's release check does once the Worker answers. */
let releaseSays: (check: ReleaseCheck) => void;

/**
 * The page, with the workspace, the people directory and the sidebar's rooms as the app keeps them:
 * changed as the page, the workspace socket or the sidebar says. The workspace starts as the app loaded
 * it, before the page's settings came, and the rooms as the sidebar listed them.
 */
function Page({ me, listed, rooms: listedRooms, callbacks }: { me: Me; listed: DirectoryUser[]; rooms: SidebarRoom[] | null; callbacks: Callbacks }) {
  const [people, setPeople] = useState(() => new Map(listed.map((person) => [person.id, person])));
  const [account, setAccount] = useState<Account>({ ...asAdministrator.account, name: "Ember" });
  const [sidebar, setSidebar] = useState<{ rooms: SidebarRoom[] | null; sharedOrder: RoomId[] }>({ rooms: listedRooms, sharedOrder: [] });
  const [releaseCheck, setReleaseCheck] = useState(release);
  socketSays = (person) => setPeople((people) => new Map(people).set(person.id, person));
  releaseSays = setReleaseCheck;
  workspaceSays = setAccount;
  sidebarSays = (rooms, sharedOrder = []) => setSidebar({ rooms, sharedOrder });
  const personChanged = (person: DirectoryUser) => {
    callbacks.onPersonChanged(person);
    socketSays(person);
  };
  const sharedOrderSaved = (sharedOrder: RoomId[]) => {
    callbacks.onSharedOrderSaved(sharedOrder);
    setSidebar((sidebar) => ({ ...sidebar, sharedOrder }));
  };
  // As the app's, which the page's loading waits on, it stays the same.
  const [askForAccount] = useState(() => () => (account: Account) => {
    callbacks.onAccountChanged(account);
    setAccount(account);
  });
  const { onAccountChanged: _, ...handlers } = callbacks;
  return (
    <AccountContext value={account}>
      <PeopleContext value={people}>
        <FlashProvider workspace>
          <Sheet>
            <WorkspaceSettingsPage
              me={me}
              back="/rooms/general"
              {...handlers}
              askForAccount={askForAccount}
              onPersonChanged={personChanged}
              rooms={sidebar.rooms}
              sharedOrder={sidebar.sharedOrder}
              onSharedOrderSaved={sharedOrderSaved}
              release={releaseCheck}
            />
          </Sheet>
        </FlashProvider>
      </PeopleContext>
    </AccountContext>
  );
}

/** The section the tests show, as the address's fragment names it: Community, unless their `describe` names another. */
let section: WorkspaceSection = "community-settings";
/** What the Worker said of Ember's releases, as the workspace gives the page it: nothing, unless a test says. */
let release: ReleaseCheck | null = null;
/** Shows `shown` in the tests of the `describe` that calls it. */
const showingSection = (shown: WorkspaceSection) => beforeEach(() => void (section = shown));

function showPage(me = asAda, people = everyone, callbacks = spies(), rooms: SidebarRoom[] | null = adasRooms) {
  history.replaceState(null, "", workspaceSectionPath(section));
  const { rerender } = render(<Page me={me} listed={people} rooms={rooms} callbacks={callbacks} />);
  return { ...callbacks, rerender: (me: Me) => rerender(<Page me={me} listed={people} rooms={rooms} callbacks={callbacks} />), user: userEvent.setup() };
}

const nameField = () => screen.findByRole("textbox", { name: "Community name" });
const joinLink = () => screen.findByRole("textbox", { name: "Share to invite more people" });
/** What the page last asked to save, if anything. */
const saved = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === "PATCH")
    .map(([, init]) => JSON.parse(String(init?.body)) as unknown);

beforeEach(() => {
  serve(asAdministrator);
});

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
  section = "community-settings";
  release = null;
});

describe("Community settings page", () => {
  const community = () => screen.queryByRole("region", { name: "Basic community settings" });
  const rooms = () => screen.queryByRole("region", { name: "Room order and permissions" });
  const membership = () => screen.queryByRole("region", { name: "Membership" });
  const domain = () => screen.queryByRole("region", { name: "Domain settings" });
  const assistant = () => screen.queryByRole("region", { name: "AI assistant" });
  const huddles = () => screen.queryByRole("region", { name: "Huddles" });

  it("reads Basic community settings, titled Community settings, with Go Back to the last room visited", () => {
    showPage();
    expect(document.title).toBe("Community settings");
    expect(screen.getByRole("heading", { level: 1, name: "Basic community settings" })).toBeInTheDocument();
    expect(screen.getByText("Manage your community name, icon, and preferences.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/rooms/general");
  });

  it("shows one section at a time, Community unless the address's fragment names another", async () => {
    showPage();
    await nameField();
    act(() => navigate("/account/edit"));
    expect(community()).toBeInTheDocument();
    expect(rooms()).not.toBeInTheDocument();
    expect(membership()).not.toBeInTheDocument();

    act(() => navigate(workspaceSectionPath("channel-settings")));
    expect(community()).not.toBeInTheDocument();
    expect(rooms()).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Room order and permissions" })).toBeInTheDocument();

    act(() => navigate(workspaceSectionPath("membership-settings")));
    expect(rooms()).not.toBeInTheDocument();
    expect(membership()).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Membership" })).toBeInTheDocument();
    expect(screen.getByText("Invite people and manage access to your community.")).toBeInTheDocument();

    act(() => navigate(workspaceSectionPath("domain-settings")));
    expect(membership()).not.toBeInTheDocument();
    expect(domain()).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Domain settings" })).toBeInTheDocument();
    expect(screen.getByText("Choose the address people open your community at.")).toBeInTheDocument();

    act(() => navigate(workspaceSectionPath("assistant-settings")));
    expect(domain()).not.toBeInTheDocument();
    expect(assistant()).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "AI assistant" })).toBeInTheDocument();
    expect(screen.getByText("Add AI agents people can ask in the chat.")).toBeInTheDocument();

    act(() => navigate(workspaceSectionPath("huddles-settings")));
    expect(assistant()).not.toBeInTheDocument();
    expect(huddles()).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Huddles" })).toBeInTheDocument();
    expect(screen.getByText("Audio and video chat in your rooms.")).toBeInTheDocument();

    act(() => navigate("/account/edit#account_name"));
    expect(community()).toBeInTheDocument();
    expect(huddles()).not.toBeInTheDocument();
  });

  it("keeps what's typed in one section while another shows", async () => {
    const { user } = showPage();
    await user.type(await nameField(), " Ltd");
    act(() => navigate(workspaceSectionPath("membership-settings")));
    act(() => navigate(workspaceSectionPath("community-settings")));
    expect(await nameField()).toHaveValue("Analytical Engines Ltd");
    expect(saved()).toEqual([]);
  });

  it("is busy until its settings load", async () => {
    showPage();
    const panel = community()!;
    expect(panel).toHaveAttribute("aria-busy", "true");
    await nameField();
    expect(panel).toHaveAttribute("aria-busy", "false");
  });

  it("says why its settings didn't load", async () => {
    const error = new ApiError(500, "Something went wrong");
    vi.mocked(fetch).mockRejectedValue(error);
    const { onFailed } = showPage();
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(error));
  });
});

describe("Version", () => {
  /** Ember 0.2's page on GitHub, with its notes. */
  const NOTES = "https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v0.2.0";
  /** When GitHub named the newest release to the Worker, just now, and what the card says of it. */
  const CHECKED_AT = new Date().toISOString();
  const LAST_CHECKED = `Last checked today at ${timeLabel(new Date(CHECKED_AT))}.`;
  const card = () => screen.findByRole("region", { name: /^Ember \d(?!.* is out to try$)/ });
  /** The box under it that offers a beta to try, apart from it. */
  const betaBox = () => screen.queryByRole("region", { name: / is out to try$/ });
  /** What the Worker says of a copy on GitHub, as its deploy told it, while Ember 0.2 is out, if `copy` is given. */
  const newerFor = (copy: CopyOnGitHub | null = null): ReleaseCheck => ({
    release: "0.1",
    beta: false,
    newest: { release: "0.2", version: "0.2.0", notes: NOTES, newer: true },
    checkedAt: CHECKED_AT,
    newestBeta: null,
    copy,
  });
  /** The card's links, by name, which each open in a new tab. */
  function linksIn(shown: HTMLElement): Record<string, string | null> {
    const links = within(shown).getAllByRole("link");
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener");
    }
    return Object.fromEntries(links.map((link) => [link.textContent, link.getAttribute("href")]));
  }

  it.each([null, { repository: "someone/my-ember", branch: "main", workflow: true, betaWorkflow: true }])(
    "shows administrators which release this is once the Worker has said, at the end of General (copy: %j)",
    async (copy) => {
      release = { release: "0.1", beta: false, newest: { release: "0.1", version: "0.1.0", notes: NOTES, newer: false }, checkedAt: CHECKED_AT, newestBeta: null, copy };
      showPage();
      const shown = await card();
      expect(shown.textContent).toBe(`Ember 0.1This is the newest release.Check for updates${LAST_CHECKED}`);
      expect(within(shown).queryByRole("link")).not.toBeInTheDocument();
      const general = screen.getByRole("region", { name: "Basic community settings" });
      expect(general.lastElementChild).toBe(shown);
    },
  );

  it("says when a newer release is out, with its notes and how to update", async () => {
    release = newerFor();
    showPage();
    const shown = await card();
    expect(within(shown).getByRole("heading", { level: 2 })).toHaveTextContent("Ember 0.2 is available");
    expect(shown).toHaveTextContent("This is Ember 0.1.");
    expect(shown).toHaveTextContent(HOW_COPIES_UPDATE);
    expect(linksIn(shown)).toEqual({ "What's new": NOTES, "How to update": UPDATING_EMBER });
  });

  it("links a copy that has the Update Ember workflow straight to it on GitHub, to run", async () => {
    release = newerFor({ repository: "someone/my-ember", branch: "main", workflow: true, betaWorkflow: false });
    showPage();
    const shown = await card();
    expect(shown).toHaveTextContent(HOW_THIS_COPY_UPDATES);
    expect(linksIn(shown)).toEqual({ "What's new": NOTES, "Open GitHub action to update": "https://github.com/someone/my-ember/actions/workflows/update-ember.yml" });
  });

  it("links a copy without it to GitHub's editor, on the branch that deploys, with Ember's workflow filled in to commit", async () => {
    release = newerFor({ repository: "someone/my-ember", branch: "release/v1#stable", workflow: false, betaWorkflow: true });
    showPage();
    const shown = await card();
    expect(shown).toHaveTextContent(HOW_TO_ADD_THE_WORKFLOW);
    const { "Add GitHub action to update": add, ...others } = linksIn(shown);
    expect(others).toEqual({ "What's new": NOTES });
    const editor = new URL(add!);
    expect(`${editor.origin}${editor.pathname}`).toBe("https://github.com/someone/my-ember/new/release/v1%23stable");
    expect([...editor.searchParams]).toEqual([
      ["filename", ".github/workflows/update-ember.yml"],
      ["value", EMBERS_WORKFLOW],
    ]);
  });

  it("says when GitHub didn't say whether a newer release is out", async () => {
    release = { release: "0.1", beta: false, newest: null, checkedAt: null, newestBeta: null, copy: null };
    showPage();
    expect((await card()).textContent).toBe("Ember 0.1GitHub didn't say whether a newer release is out.Check for updates");
  });

  it("says a beta is one, ahead of the newest release, until its release is out", async () => {
    const releaseNotes = "https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v0.1.0";
    release = { release: "0.2 beta 1", beta: true, newest: { release: "0.1", version: "0.1.0", notes: releaseNotes, newer: false }, checkedAt: CHECKED_AT, newestBeta: null, copy: null };
    showPage();
    let shown = await card();
    expect(shown.textContent).toBe(`Ember 0.2 beta 1This is a beta, ahead of Ember 0.1, the newest release.Check for updates${LAST_CHECKED}`);
    expect(within(shown).queryByRole("link")).not.toBeInTheDocument();
    cleanup();

    release = { release: "0.2 beta 1", beta: true, newest: null, checkedAt: null, newestBeta: null, copy: null };
    showPage();
    expect((await card()).textContent).toBe("Ember 0.2 beta 1This is a beta. GitHub didn't say whether its release is out.Check for updates");
    cleanup();

    release = { ...newerFor(), release: "0.2 beta 1", beta: true };
    showPage();
    shown = await card();
    expect(within(shown).getByRole("heading", { level: 2 })).toHaveTextContent("Ember 0.2 is available");
    expect(shown).toHaveTextContent("This is Ember 0.2 beta 1.");
    expect(linksIn(shown)).toEqual({ "What's new": NOTES, "How to update": UPDATING_EMBER });
  });

  describe("Betas", () => {
    /** Ember 0.3 beta 1's page on GitHub, with its notes. */
    const BETA_NOTES = "https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v0.3.0-beta.1";
    /** What the Worker says of Ember 0.2, the newest release, while 0.3 beta 1 is out ahead of it, to a copy on GitHub if `copy` is given. */
    const betaOutFor = (copy: CopyOnGitHub | null = null): ReleaseCheck => ({
      release: "0.2",
      beta: false,
      newest: { release: "0.2", version: "0.2.0", notes: NOTES, newer: false },
      checkedAt: CHECKED_AT,
      newestBeta: { release: "0.3 beta 1", version: "0.3.0-beta.1", notes: BETA_NOTES, newer: true },
      copy,
    });
    /** The box that offers the beta, which is there. */
    const shownBetaBox = () => {
      const box = betaBox();
      expect(box).toBeInTheDocument();
      return box!;
    };

    it("offers the newest release the beta out ahead of it to try, in a red box of its own under the card, linking a copy with the beta workflow to running it", async () => {
      release = betaOutFor({ repository: "someone/my-ember", branch: "main", workflow: true, betaWorkflow: true });
      showPage();
      const shown = await card();
      expect(shown.textContent).toBe(`Ember 0.2This is the newest release.Check for updates${LAST_CHECKED}`);
      expect(within(shown).queryByRole("link")).not.toBeInTheDocument();
      const box = shownBetaBox();
      expect(shown.nextElementSibling).toBe(box);
      expect(screen.getByRole("region", { name: "Basic community settings" }).lastElementChild).toBe(box);
      // A little red, as a beta is experimental.
      expect(box).toHaveClass("border-beta-border", "bg-beta-background");
      expect(within(box).getByRole("heading", { level: 2 })).toHaveTextContent(/^Ember 0\.3 beta 1 is out to try$/);
      expect(box).toHaveTextContent(HOW_THIS_COPY_TRIES_BETAS);
      expect(linksIn(box)).toEqual({ "What's in it": BETA_NOTES, "Open GitHub action to try it": "https://github.com/someone/my-ember/actions/workflows/update-ember-beta.yml" });
    });

    it("links a copy without the beta workflow to GitHub's editor, on the branch that deploys, with Ember's filled in to commit", async () => {
      release = betaOutFor({ repository: "someone/my-ember", branch: "release/v1#stable", workflow: true, betaWorkflow: false });
      showPage();
      await card();
      const box = shownBetaBox();
      expect(box).toHaveTextContent(HOW_TO_ADD_THE_BETA_WORKFLOW);
      const { "Add GitHub action to try betas": add, ...others } = linksIn(box);
      expect(others).toEqual({ "What's in it": BETA_NOTES });
      const editor = new URL(add!);
      expect(`${editor.origin}${editor.pathname}`).toBe("https://github.com/someone/my-ember/new/release/v1%23stable");
      expect([...editor.searchParams]).toEqual([
        ["filename", ".github/workflows/update-ember-beta.yml"],
        ["value", EMBERS_BETA_WORKFLOW],
      ]);
    });

    it("tells a copy the Worker doesn't know how to try a beta, from the docs", async () => {
      release = betaOutFor();
      showPage();
      await card();
      const box = shownBetaBox();
      expect(box).toHaveTextContent(HOW_COPIES_TRY_BETAS);
      expect(linksIn(box)).toEqual({ "What's in it": BETA_NOTES, "How to try a beta": TRYING_BETAS });
    });

    it("offers no beta while a newer release is out to update to, or the beta isn't newer", async () => {
      release = { ...newerFor({ repository: "someone/my-ember", branch: "main", workflow: true, betaWorkflow: true }), newestBeta: { release: "0.3 beta 1", version: "0.3.0-beta.1", notes: BETA_NOTES, newer: true } };
      showPage();
      let shown = await card();
      expect(within(shown).getByRole("heading", { level: 2 })).toHaveTextContent("Ember 0.2 is available");
      expect(betaBox()).not.toBeInTheDocument();
      expect(Object.keys(linksIn(shown))).toEqual(["What's new", "Open GitHub action to update"]);
      cleanup();

      release = { ...betaOutFor(), release: "0.3 beta 1", beta: true, newestBeta: { release: "0.3 beta 1", version: "0.3.0-beta.1", notes: BETA_NOTES, newer: false } };
      showPage();
      shown = await card();
      // The newest beta, as no newer one is out.
      expect(shown.textContent).toBe(`Ember 0.3 beta 1This is the newest beta, ahead of Ember 0.2, the newest release.Check for updates${LAST_CHECKED}`);
      expect(within(shown).queryByRole("link")).not.toBeInTheDocument();
      expect(betaBox()).not.toBeInTheDocument();
    });

    it("tells a beta of the beta after it as of an update, which Update Ember brings", async () => {
      const nextNotes = "https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v0.3.0-beta.2";
      release = { ...betaOutFor({ repository: "someone/my-ember", branch: "main", workflow: true, betaWorkflow: true }), release: "0.3 beta 1", beta: true, newestBeta: { release: "0.3 beta 2", version: "0.3.0-beta.2", notes: nextNotes, newer: true } };
      showPage();
      const shown = await card();
      expect(within(shown).getByRole("heading", { level: 2 })).toHaveTextContent("Ember 0.3 beta 2 is available");
      expect(shown).toHaveTextContent("This is Ember 0.3 beta 1.");
      expect(shown).toHaveTextContent(HOW_THIS_COPY_UPDATES);
      expect(betaBox()).not.toBeInTheDocument();
      expect(linksIn(shown)).toEqual({ "What's new": nextNotes, "Open GitHub action to update": "https://github.com/someone/my-ember/actions/workflows/update-ember.yml" });
    });
  });

  describe("Check for updates", () => {
    /** What the Worker says once GitHub names Ember 0.2, a minute after it named 0.1. */
    const heardOfNewer = (): ReleaseCheck => ({ ...newerFor(), checkedAt: new Date(Date.parse(CHECKED_AT) + 60_000).toISOString() });

    it("asks the Worker again, saying it's checking until it has answered, then when GitHub last named the newest release", async () => {
      release = { release: "0.1", beta: false, newest: { release: "0.1", version: "0.1.0", notes: NOTES, newer: false }, checkedAt: CHECKED_AT, newestBeta: null, copy: null };
      const callbacks = spies();
      let answer = () => {};
      callbacks.onCheckForUpdates.mockImplementation(() => new Promise<void>((resolve) => (answer = resolve)));
      const { user } = showPage(asAda, everyone, callbacks);
      const shown = await card();
      const status = within(shown).getByRole("status");
      expect(status).toHaveTextContent(LAST_CHECKED);
      const check = within(shown).getByRole("button", { name: "Check for updates" });
      await user.click(check);
      expect(callbacks.onCheckForUpdates).toHaveBeenCalledOnce();
      expect(check).toBeDisabled();
      expect(status).toHaveTextContent(/^Checking for updates…$/);

      // The workspace hears of Ember 0.2 as the Worker answers, which the card says, and when.
      act(() => releaseSays(heardOfNewer()));
      expect(status).toHaveTextContent(/^Checking for updates…$/);
      await act(async () => answer());
      expect(within(shown).getByRole("heading", { level: 2 })).toHaveTextContent("Ember 0.2 is available");
      expect(Object.keys(linksIn(shown))).toEqual(["What's new", "How to update"]);
      expect(within(shown).getAllByRole("button").at(-1)).toBe(check);
      expect(check).toBeEnabled();
      expect(status).toHaveTextContent(`Last checked today at ${timeLabel(new Date(heardOfNewer().checkedAt!))}.`);
      expect(callbacks.onFailed).not.toHaveBeenCalled();
    });

    it("says why asking failed, as the workspace's alerts do, for it to be pressed again", async () => {
      release = newerFor();
      const callbacks = spies();
      const error = new ApiError(500, "Something went wrong");
      callbacks.onCheckForUpdates.mockRejectedValueOnce(error);
      const { user } = showPage(asAda, everyone, callbacks);
      const shown = await card();
      const check = within(shown).getByRole("button", { name: "Check for updates" });
      await user.click(check);
      await waitFor(() => expect(callbacks.onFailed).toHaveBeenCalledWith(error));
      expect(check).toBeEnabled();
      expect(within(shown).getByRole("status")).toHaveTextContent(LAST_CHECKED);
      await user.click(check);
      expect(callbacks.onCheckForUpdates).toHaveBeenCalledTimes(2);
    });

    it("says nothing of when while GitHub hasn't named a release", async () => {
      release = { release: "0.1", beta: false, newest: null, checkedAt: null, newestBeta: null, copy: null };
      showPage();
      const shown = await card();
      expect(within(shown).getByRole("button", { name: "Check for updates" })).toBeEnabled();
      expect(within(shown).getByRole("status")).toBeEmptyDOMElement();
    });
  });

  it("shows nothing of it before the Worker has said, nor to members", async () => {
    showPage();
    await nameField();
    expect(screen.queryByText(/^Ember \d/)).not.toBeInTheDocument();
    cleanup();
    release = newerFor();
    serve(asMember);
    showPage(asLinus);
    expect(await screen.findByRole("heading", { level: 2, name: "Analytical Engines" })).toBeInTheDocument();
    expect(screen.queryByText(/^Ember \d/)).not.toBeInTheDocument();
  });
});

describe("Rename the workspace", () => {
  it("lets an administrator rename the workspace, saying Changes saved.", async () => {
    const { onAccountChanged, user } = showPage();
    const name = await nameField();
    expect(name).toHaveValue("Analytical Engines");
    expect(onAccountChanged).toHaveBeenCalledWith(asAdministrator.account);
    await user.clear(name);
    await user.type(name, "Difference Engines");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(saved()).toEqual([{ name: "Difference Engines", tagline: "" }]);
    expect(onAccountChanged).toHaveBeenLastCalledWith({ ...asAdministrator.account, name: "Difference Engines" });
    expect(name).toHaveValue("Difference Engines");
  });

  it("saves with Enter, and says Changes saved. when the name hasn't changed", async () => {
    const { user } = showPage();
    await user.type(await nameField(), "{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(saved()).toEqual([{ name: "Analytical Engines", tagline: "" }]);
  });

  it("leaves the field unfocused, and its text where you click", async () => {
    showPage();
    const name = await nameField();
    expect(name).not.toHaveFocus();
    expect(name).toHaveAttribute("data-ember-preserve-selection");
    expect(name).toHaveAttribute("placeholder", "Name this account");
    expect(name).toHaveAttribute("autocomplete", "off");
    expect(name).toHaveAttribute("maxlength", "100");
  });

  it("can't save again until the last save is answered", async () => {
    let answer = (_: Response) => {};
    serve(asAdministrator, { saved: () => new Promise((resolve) => (answer = resolve)) });
    const { user } = showPage();
    await user.type(await nameField(), "{Enter}");
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    answer(Response.json({ account: asAdministrator.account }));
    await waitFor(() => expect(save).toBeEnabled());
  });

  it("says why a rename was refused, keeping the name typed", async () => {
    serve(asAdministrator, { saved: () => Response.json({ error: "Only administrators can change the workspace" }, { status: 403 }) });
    const { onAccountChanged, onFailed, user } = showPage();
    const name = await nameField();
    await user.type(name, " Ltd{Enter}");
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 403 })));
    expect(name).toHaveValue("Analytical Engines Ltd");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(onAccountChanged).toHaveBeenCalledTimes(1);
  });

  it("shows members the workspace's name, which they can't change", async () => {
    serve(asMember);
    showPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Analytical Engines" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Community name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("shows members a new name as soon as the workspace socket says it", async () => {
    serve(asMember);
    showPage();
    await screen.findByRole("heading", { level: 2, name: "Analytical Engines" });
    act(() => workspaceSays({ ...asMember.account, name: "Difference Engines" }));
    expect(screen.getByRole("heading", { level: 2, name: "Difference Engines" })).toBeInTheDocument();
  });
});

describe("Workspace tagline", () => {
  const TAGLINE = "Engines for every occasion";
  const tagged: WorkspaceSettings = { ...asAdministrator, account: { ...asAdministrator.account, tagline: TAGLINE } };
  const taglineField = () => screen.findByRole("textbox", { name: "Tagline" });

  it("asks administrators for a tagline under the community name, saying where it shows and how long it can be", async () => {
    showPage();
    const tagline = await taglineField();
    expect(tagline).toHaveValue("");
    expect(tagline).toHaveAttribute("placeholder", "Sum it up in a few words");
    expect(tagline).toHaveAttribute("autocomplete", "off");
    expect(tagline).toHaveAttribute("maxlength", String(MAX_TAGLINE_LENGTH));
    expect(tagline).toHaveAccessibleDescription("Shown under the community name in the sidebar, up to 30 characters. Leave it empty for none.");
    // Right under the name, in the form Save changes sends.
    const form = screen.getByRole("textbox", { name: "Community name" }).closest("form")!;
    expect(within(form).getAllByRole("textbox")).toEqual([screen.getByRole("textbox", { name: "Community name" }), tagline]);
    expect(within(form).getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("saves the tagline with the name, saying Changes saved., and shows it as it's kept", async () => {
    // The server keeps it with no space at either end.
    serve(asAdministrator, { saved: () => Response.json({ account: tagged.account }) });
    const { onAccountChanged, user } = showPage();
    const tagline = await taglineField();
    await user.type(tagline, ` ${TAGLINE} `);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(saved()).toEqual([{ name: "Analytical Engines", tagline: ` ${TAGLINE} ` }]);
    expect(onAccountChanged).toHaveBeenLastCalledWith(tagged.account);
    expect(tagline).toHaveValue(TAGLINE);
  });

  it("keeps what's typed while a save was on its way", async () => {
    let answer = (_: Response) => {};
    serve(asAdministrator, { saved: () => new Promise((resolve) => (answer = resolve)) });
    const { user } = showPage();
    const tagline = await taglineField();
    await user.type(tagline, "Engines {Enter}");
    await user.type(tagline, "galore");
    answer(Response.json({ account: { ...asAdministrator.account, tagline: "Engines" } }));

    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(tagline).toHaveValue("Engines galore");
  });

  it("follows the name and tagline another tab saves until they're typed in, so saving one keeps what was saved in the other", async () => {
    const { user } = showPage();
    const name = await nameField();
    const tagline = await taglineField();
    act(() => workspaceSays({ ...asAdministrator.account, tagline: TAGLINE }));
    expect(tagline).toHaveValue(TAGLINE);
    await user.type(name, " Ltd{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(saved()).toEqual([{ name: "Analytical Engines Ltd", tagline: TAGLINE }]);
    // What's typed and not yet saved stays, whatever another tab saves.
    await user.type(tagline, "!");
    act(() => workspaceSays({ ...asAdministrator.account, name: "Difference Engines", tagline: "Engines, now with steam" }));
    expect(name).toHaveValue("Difference Engines");
    expect(tagline).toHaveValue(`${TAGLINE}!`);
  });

  it("takes the tagline away once it's emptied and saved", async () => {
    serve(tagged);
    const { onAccountChanged, user } = showPage();
    const tagline = await taglineField();
    await waitFor(() => expect(tagline).toHaveValue(TAGLINE));
    await user.clear(tagline);
    await user.type(tagline, "{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(saved()).toEqual([{ name: "Analytical Engines", tagline: "" }]);
    expect(onAccountChanged).toHaveBeenLastCalledWith(asAdministrator.account);
  });

  it("shows members the tagline under the workspace name, as the workspace socket last said it, and nothing while there's none", async () => {
    serve({ ...tagged, canAdminister: false });
    showPage(asLinus);
    const name = await screen.findByRole("heading", { level: 2, name: "Analytical Engines" });
    expect(name.closest("hgroup")).toHaveTextContent(`Analytical Engines${TAGLINE}`);
    expect(screen.queryByRole("textbox", { name: "Tagline" })).not.toBeInTheDocument();

    act(() => workspaceSays({ ...asMember.account, tagline: "Engines, now with steam" }));
    expect(name.closest("hgroup")).toHaveTextContent("Analytical EnginesEngines, now with steam");
    act(() => workspaceSays(asMember.account));
    expect(name.closest("hgroup")).toHaveTextContent(/^Analytical Engines$/);
  });
});

describe("Workspace logo", () => {
  const logo = () => screen.getByRole("img", { name: "Community icon" });
  const picker = () => screen.getByLabelText("Upload icon", { exact: false });
  const removeButton = () => screen.queryByRole("button", { name: "Remove icon" });
  /** What each logo saved sent, in order. */
  const uploads = () =>
    vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "PUT")
      .map(([, init]) => init?.body as FormData);
  const blackHole = () => new File(["black hole"], "black_hole.png", { type: "image/png" });
  const withLogo: WorkspaceSettings = { ...asAdministrator, account: { ...asAdministrator.account, logo: LOGO } };

  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:black-hole");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("shows administrators Ember's stock icon above the workspace's name, to change with a logo", async () => {
    showPage();
    await nameField();
    expect(logo()).toHaveAttribute("src", "/logos/app-icon.png");
    expect(picker()).toBeEnabled();
    expect(picker()).toHaveAttribute("type", "file");
    expect(picker()).toHaveAttribute("accept", "image/*");
    expect(picker()).toHaveAccessibleDescription("Choose a community icon");
    expect(picker().compareDocumentPosition(await nameField())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // Nothing to remove while there's no logo.
    expect(removeButton()).toBeNull();
  });

  it("saves a logo as soon as it's picked, showing it meanwhile, with its variants, saying Changes saved.", async () => {
    let answer = (_: Response) => {};
    serve(asAdministrator, { logoSaved: () => new Promise((resolve) => (answer = resolve)) });
    const { onAccountChanged, onFailed, user } = showPage();
    await nameField();
    await user.upload(picker(), blackHole());

    await waitFor(() => expect(uploads()).toHaveLength(1));
    expect(logo()).toHaveAttribute("src", "blob:black-hole");
    expect(picker()).toBeDisabled();
    const [sent] = uploads();
    expect(sent!.get("logo")).toMatchObject({ name: "black_hole.png", type: "image/png" });
    expect(sent!.get("large")).toMatchObject({ type: "image/png" });
    expect(sent!.get("small")).toMatchObject({ type: "image/png" });

    const account = { ...asAdministrator.account, logo: LOGO };
    await act(async () => answer(Response.json({ account })));
    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(onAccountChanged).toHaveBeenLastCalledWith(account);
    expect(logo()).toHaveAttribute("src", LOGO);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:black-hole");
    expect(picker()).toBeEnabled();
    expect(removeButton()).toBeInTheDocument();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("removes the logo with Remove icon, saying nothing", async () => {
    serve(withLogo);
    const { onAccountChanged, user } = showPage();
    await nameField();
    expect(logo()).toHaveAttribute("src", LOGO);
    await user.click(removeButton()!);

    await waitFor(() => expect(removeButton()).toBeNull());
    expect(logo()).toHaveAttribute("src", "/logos/app-icon.png");
    expect(fetch).toHaveBeenCalledWith(LOGO_PATH, expect.objectContaining({ method: "DELETE" }));
    expect(onAccountChanged).toHaveBeenLastCalledWith(asAdministrator.account);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says a logo over 16 MB is too large without sending it", async () => {
    const { user } = showPage();
    await nameField();
    const huge = blackHole();
    Object.defineProperty(huge, "size", { value: MAX_LOGO_SIZE + 1 });
    await user.upload(picker(), huge);

    expect(await screen.findByRole("alert")).toHaveTextContent(LOGO_TOO_LARGE);
    expect(uploads()).toEqual([]);
    expect(logo()).toHaveAttribute("src", "/logos/app-icon.png");
  });

  it("says why a logo couldn't be saved, showing the logo as it was", async () => {
    serve(withLogo, { logoSaved: () => Response.json({ error: "Ember isn't set up to store files" }, { status: 503 }) });
    const { onFailed, user } = showPage();
    await nameField();
    await user.upload(picker(), blackHole());

    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 503, message: "Ember isn't set up to store files" })));
    expect(logo()).toHaveAttribute("src", LOGO);
    expect(picker()).toBeEnabled();
  });

  it("shows a logo saved in another tab as soon as the workspace socket says it", async () => {
    showPage();
    await nameField();
    act(() => workspaceSays({ ...asAdministrator.account, logo: LOGO }));
    expect(logo()).toHaveAttribute("src", LOGO);
    expect(removeButton()).toBeInTheDocument();
  });

  it("shows members the workspace's logo over its name, or Ember's stock icon, with no picker", async () => {
    serve({ ...withLogo, canAdminister: false });
    showPage(asLinus);
    const name = await screen.findByRole("heading", { level: 2, name: "Analytical Engines" });
    const shown = screen.getByRole("img", { name: "Account logo" });
    expect(shown).toHaveAttribute("src", LOGO);
    expect(shown.compareDocumentPosition(name)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByLabelText("Upload icon", { exact: false })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove icon" })).toBeNull();

    act(() => workspaceSays(asMember.account));
    expect(screen.getByRole("img", { name: "Account logo" })).toHaveAttribute("src", "/logos/app-icon.png");
  });
});

describe("Translation buttons", () => {
  const hideSwitch = () => screen.findByRole("switch", { name: "Hide translation buttons" });

  it("lets an administrator show translation buttons, and hide them again, saved with the name by Save changes", async () => {
    const { onAccountChanged, user } = showPage();
    const hide = await hideSwitch();
    expect(hide).toBeChecked();
    expect(hide).toHaveAccessibleDescription("Hide language help throughout the app for everyone.");
    expect(screen.queryByText("Translate")).not.toBeInTheDocument();

    await user.click(hide);
    expect(hide).not.toBeChecked();
    expect(saved()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(onAccountChanged).toHaveBeenLastCalledWith({ ...asAdministrator.account, hideTranslationButtons: false });
    // The community name's globe.
    expect(screen.getByText("Translate")).toBeInTheDocument();

    await user.click(hide);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onAccountChanged).toHaveBeenLastCalledWith(asAdministrator.account));
    expect(saved()).toEqual([
      { name: "Analytical Engines", tagline: "", settings: { hideTranslationButtons: false } },
      { name: "Analytical Engines", tagline: "", settings: { hideTranslationButtons: true } },
    ]);
    expect(screen.queryByText("Translate")).not.toBeInTheDocument();
    expect(hide).toBeChecked();
  });

  it("follows the workspace socket, for a switch moved in another tab, until it's moved here", async () => {
    const { user } = showPage();
    const hide = await hideSwitch();
    act(() => workspaceSays({ ...asAdministrator.account, hideTranslationButtons: false }));
    expect(hide).not.toBeChecked();
    await user.click(hide);
    act(() => workspaceSays(asAdministrator.account));
    act(() => workspaceSays({ ...asAdministrator.account, hideTranslationButtons: false }));
    expect(hide).toBeChecked();
  });

  it("stays where it was moved while a save is on its way, and after one is refused, to be saved again", async () => {
    let answer = (_: Response) => {};
    serve(asAdministrator, { saved: () => new Promise((resolve) => (answer = resolve)) });
    const { onFailed, user } = showPage();
    const hide = await hideSwitch();
    await user.click(hide);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(hide).not.toBeChecked();

    answer(Response.json({ error: "Only administrators can change the workspace" }, { status: 403 }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 403 })));
    expect(hide).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("keeps a move made while a save is on its way, for the next", async () => {
    let answer = (_: Response) => {};
    serve(asAdministrator, { saved: () => new Promise((resolve) => (answer = resolve)) });
    const { user } = showPage();
    const hide = await hideSwitch();
    await user.click(hide);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await user.click(hide);
    await act(async () => answer(Response.json({ account: { ...asAdministrator.account, hideTranslationButtons: false } })));
    expect(hide).toBeChecked();
    expect(saved()).toEqual([{ name: "Analytical Engines", tagline: "", settings: { hideTranslationButtons: false } }]);
  });

  it("isn't shown to members", async () => {
    serve(asMember);
    showPage();
    await screen.findByRole("heading", { level: 2, name: "Analytical Engines" });
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});

describe("Custom domain", () => {
  const moved: WorkspaceSettings = {
    ...asAdministrator,
    account: { ...asAdministrator.account, customDomain: "chat.example.com" },
    addresses: { deployed: location.host, others: ["old.example.com"] },
  };
  showingSection("domain-settings");

  it("gives administrators a Custom domain section in Domain settings, saying Changes saved.", async () => {
    serve(moved);
    const { onAccountChanged, user } = showPage();
    const section = await screen.findByRole("region", { name: "Custom domain" });
    expect(screen.getByRole("region", { name: "Domain settings" })).toContainElement(section);
    // Not in Basic community settings, once that's shown.
    act(() => navigate(workspaceSectionPath("community-settings")));
    expect(await nameField()).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Custom domain" })).not.toBeInTheDocument();
    act(() => navigate(workspaceSectionPath("domain-settings")));
    expect(section).toHaveTextContent("Ember's address is chat.example.com.");
    expect(section).toHaveTextContent("old.example.com still forwards to chat.example.com.");

    await user.click(within(section).getByRole("button", { name: `Go back to ${location.host}` }));
    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(saved()).toEqual([{ customDomain: location.host }]);
    expect(onAccountChanged).toHaveBeenLastCalledWith({ ...asAdministrator.account, customDomain: location.host });
    expect(section).toHaveTextContent(`Ember's address is ${location.host}.`);
    // The domain it left keeps reaching it, as the page's settings now say.
    expect(within(within(section).getByRole("list", { name: "Other addresses that reach Ember" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^chat\.example\.com still forwards here/),
      expect.stringMatching(/^old\.example\.com still forwards here/),
    ]);
  });

  it("isn't shown to members, who hear who manages it", async () => {
    serve({ ...moved, canAdminister: false });
    showPage(asLinus);
    expect(await screen.findByText("Community admins manage the community's domain.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Custom domain" })).not.toBeInTheDocument();
    expect(screen.queryByText(/chat\.example\.com/)).not.toBeInTheDocument();
  });
});

describe("Sign in with Memberful", () => {
  const SITE = "https://example.memberful.com";
  const withKeys: WorkspaceSettings = { ...asAdministrator, memberfulSite: SITE };
  /** `settings` with Memberful on, and members only if `membersOnly`. */
  const withMemberful = (settings: WorkspaceSettings, membersOnly = false): WorkspaceSettings => ({
    ...settings,
    account: { ...settings.account, memberfulJoin: true, memberfulSignIn: membersOnly },
  });
  const memberfulSwitch = () => screen.findByRole("switch", { name: "Memberful" });
  const membersOnlySwitch = () => screen.queryByRole("switch", { name: "Members only" });
  showingSection("membership-settings");

  it("gives administrators a Memberful card among the ways to join, after the join link, that's only its switch and what it does while it's off", async () => {
    showPage();
    const section = await screen.findByRole("region", { name: "Memberful" });
    const following = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(following(screen.getByRole("heading", { level: 1, name: "Membership" }), section)).toBe(true);
    expect(following(await joinLink(), section)).toBe(true);
    expect(screen.getByRole("region", { name: "Who can join" })).toContainElement(section);
    const on = within(section).getByRole("switch", { name: "Memberful" });
    expect(on).not.toBeChecked();
    expect(on).toBeEnabled();
    expect(on).toHaveAccessibleDescription("Members of a Memberful site join and sign in with their Memberful account.");
    expect(within(section).queryByRole("list")).not.toBeInTheDocument();
    expect(section).not.toHaveTextContent("MEMBERFUL_URL");
  });

  it("shows the steps to get the keys when it's turned on before the deployment has them, saving nothing, and hides them when it's turned off", async () => {
    const { user } = showPage();
    const on = await memberfulSwitch();
    await user.click(on);
    expect(on).toBeChecked();
    expect(on).toHaveAccessibleDescription("Memberful can't be turned on until this deployment has your Memberful site's keys. These steps give it them.");
    const steps = screen.getByRole("list", { name: "Steps to let Memberful members sign in" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(4);
    // Memberful's custom app sends people back to Ember's address.
    expect(steps).toHaveTextContent(`OAuth redirect URL ${location.origin}/auth/memberful/callback`);
    expect(steps).toHaveTextContent("MEMBERFUL_URL");
    expect(steps).toHaveTextContent("Reload this page, and turn on Memberful again.");
    expect(within(steps).getByRole("link", { name: "Open the Cloudflare dashboard" })).toHaveAttribute("target", "_blank");
    expect(membersOnlySwitch()).not.toBeInTheDocument();

    await user.click(on);
    expect(on).not.toBeChecked();
    expect(on).toHaveAccessibleDescription("Members of a Memberful site join and sign in with their Memberful account.");
    expect(screen.queryByRole("list", { name: "Steps to let Memberful members sign in" })).not.toBeInTheDocument();
    expect(saved()).toEqual([]);
  });

  it("hides the steps to get the keys while Open sets it aside", async () => {
    serve({ ...asAdministrator, account: { ...asAdministrator.account, openSignUp: true } });
    showPage();
    const on = await memberfulSwitch();
    expect(on).toBeDisabled();
    expect(on).toHaveAccessibleDescription("Set aside while Open lets anyone join.");
    expect(screen.queryByRole("list", { name: "Steps to let Memberful members sign in" })).not.toBeInTheDocument();
  });

  it("lets an administrator turn it on once the deployment has the keys, without asking, saved at once with no notice, keeping the other ways", async () => {
    serve(withKeys);
    const confirm = vi.spyOn(window, "confirm");
    const { onAccountChanged, user } = showPage();
    const on = await memberfulSwitch();
    expect(on).not.toBeChecked();
    expect(on).toHaveAccessibleDescription(
      `Members of ${SITE} join and sign in with their Memberful account. Turned off, it lets nobody new join, but those who did keep signing in with it.`,
    );
    // What it takes waits until it's on.
    const section = screen.getByRole("region", { name: "Memberful" });
    expect(section).not.toHaveTextContent("Memberful sends people back to");
    expect(within(section).queryByRole("list")).not.toBeInTheDocument();
    expect(membersOnlySwitch()).not.toBeInTheDocument();

    await user.click(on);
    expect(confirm).not.toHaveBeenCalled();
    expect(on).toBeChecked();
    await waitFor(() => expect(onAccountChanged).toHaveBeenLastCalledWith({ ...asAdministrator.account, memberfulJoin: true }));
    expect(saved()).toEqual([{ settings: { memberfulJoin: true } }]);
    expect(section).toHaveTextContent(`Memberful sends people back to ${location.origin}/auth/memberful/callback`);
    expect(screen.queryByRole("list", { name: "Steps to let Memberful members sign in" })).not.toBeInTheDocument();
    // Everyone else keeps joining as they did.
    expect(await joinLink()).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Open" })).toBeEnabled();
    expect(membersOnlySwitch()).not.toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("makes it members only once they confirm, saved at once with no notice, which turns the join link off and greys out Open", async () => {
    serve(withMemberful(withKeys));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onAccountChanged, user } = showPage();
    expect(await memberfulSwitch()).toBeChecked();
    const membersOnly = membersOnlySwitch()!;
    expect(membersOnly).not.toBeChecked();
    expect(membersOnly).toHaveAccessibleDescription(
      "Nobody else can join but the people you invite, and only they and administrators sign in with a password. Members who have one connect their Memberful account as they next sign in.",
    );

    await user.click(membersOnly);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(CONFIRM_MEMBERS_ONLY);
    expect(membersOnly).toBeChecked();
    await waitFor(() => expect(onAccountChanged).toHaveBeenLastCalledWith({ ...asAdministrator.account, memberfulJoin: true, memberfulSignIn: true }));
    expect(saved()).toEqual([{ settings: { memberfulSignIn: true } }]);
    expect(screen.queryByRole("textbox", { name: "Share to invite more people" })).not.toBeInTheDocument();
    for (const name of ["Open", "Join link"]) {
      const way = await screen.findByRole("switch", { name });
      expect(way).toBeDisabled();
      expect(way).toHaveAccessibleDescription("Off while Memberful is members only.");
    }
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("leaves it open to everyone else unless they confirm", async () => {
    serve(withMemberful(withKeys));
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = showPage();
    await memberfulSwitch();
    const membersOnly = membersOnlySwitch()!;
    await user.click(membersOnly);
    expect(membersOnly).not.toBeChecked();
    expect(saved()).toEqual([]);
  });

  it("turns Members only off with it, without asking, giving the other ways back", async () => {
    serve(withMemberful(withKeys, true));
    const confirm = vi.spyOn(window, "confirm");
    const { onAccountChanged, user } = showPage();
    const on = await memberfulSwitch();
    expect(membersOnlySwitch()).toBeChecked();

    await user.click(on);
    expect(confirm).not.toHaveBeenCalled();
    expect(membersOnlySwitch()).not.toBeInTheDocument();
    expect(saved()).toEqual([{ settings: { memberfulJoin: false } }]);
    await waitFor(() => expect(onAccountChanged).toHaveBeenLastCalledWith(asAdministrator.account));
    expect(await joinLink()).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Open" })).toBeEnabled();
  });

  it("can't be moved again until the last move is answered, and moves back saying why it was refused", async () => {
    let answer = (_: Response) => {};
    serve(withKeys, { saved: () => new Promise((resolve) => (answer = resolve)) });
    const { onFailed, user } = showPage();
    const on = await memberfulSwitch();
    await user.click(on);
    await user.click(on);
    expect(on).toBeChecked();
    expect(saved()).toEqual([{ settings: { memberfulJoin: true } }]);

    answer(Response.json({ error: "Memberful needs MEMBERFUL_URL, MEMBERFUL_CLIENT_ID and MEMBERFUL_CLIENT_SECRET set first" }, { status: 422 }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 422 })));
    expect(on).not.toBeChecked();
  });

  it("greys out each of its two switches while the other's move is saved, since saving either changes the other", async () => {
    let answer = (_: Response) => {};
    serve(withKeys, { saved: () => new Promise((resolve) => (answer = resolve)) });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = showPage();
    const on = await memberfulSwitch();
    await user.click(on);
    const membersOnly = membersOnlySwitch()!;
    expect(membersOnly).toBeDisabled();
    await act(async () => answer(Response.json({ account: { ...withKeys.account, memberfulJoin: true } })));
    expect(membersOnly).toBeEnabled();

    // Were turning Memberful off saved before turning Members only on, Members only would turn it back on.
    await user.click(membersOnly);
    expect(membersOnly).toBeChecked();
    expect(on).toBeDisabled();
    await act(async () => answer(Response.json({ account: { ...withKeys.account, memberfulJoin: true, memberfulSignIn: true } })));
    expect(on).toBeEnabled();
    await user.click(on);
    expect(on).not.toBeChecked();
    expect(saved()).toEqual([{ settings: { memberfulJoin: true } }, { settings: { memberfulSignIn: true } }, { settings: { memberfulJoin: false } }]);
  });

  it("keeps the switch to turn it off once the deployment has lost the keys, saying nobody can sign in with Memberful", async () => {
    serve(withMemberful(asAdministrator, true));
    const { user } = showPage();
    const on = await memberfulSwitch();
    expect(on).toBeChecked();
    expect(on).toHaveAccessibleDescription("It's on, but this deployment no longer has its Memberful keys, so nobody can sign in with Memberful.");
    expect(membersOnlySwitch()).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Steps to let Memberful members sign in" })).toBeInTheDocument();

    await user.click(on);
    expect(saved()).toEqual([{ settings: { memberfulJoin: false } }]);
    await waitFor(() => expect(on).toHaveAccessibleDescription("Members of a Memberful site join and sign in with their Memberful account."));
    expect(on).not.toBeChecked();
    expect(screen.queryByRole("list", { name: "Steps to let Memberful members sign in" })).not.toBeInTheDocument();
    expect(await joinLink()).toBeInTheDocument();
  });

  it("follows the workspace socket, for a switch moved in another tab", async () => {
    serve(withKeys);
    showPage();
    const on = await memberfulSwitch();
    act(() => workspaceSays({ ...asAdministrator.account, memberfulJoin: true, memberfulSignIn: true }));
    expect(on).toBeChecked();
    expect(membersOnlySwitch()).toBeChecked();
    expect(screen.queryByRole("textbox", { name: "Share to invite more people" })).not.toBeInTheDocument();
  });

  it("isn't shown to members, who see the join link is off while Memberful is members only", async () => {
    serve({ ...withMemberful(withKeys, true), canAdminister: false });
    showPage(asLinus);
    expect(await screen.findByText(/so the join link is off/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Memberful" })).not.toBeInTheDocument();
    expect(screen.queryByText(SITE)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Share to invite more people" })).not.toBeInTheDocument();
  });

  it("tells members that the site's members join with Memberful while no other way lets anyone in", async () => {
    const memberful = withMemberful(withKeys);
    serve({ ...memberful, canAdminister: false, account: { ...memberful.account, joinLink: false } });
    showPage(asLinus);
    expect(await screen.findByText(/join by signing in with Memberful/)).toHaveTextContent(`Members of ${SITE} join by signing in with Memberful.`);
    expect(screen.queryByText("Only the people administrators invite can join.")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Memberful" })).not.toBeInTheDocument();
  });
});

describe("Ways to join", () => {
  showingSection("membership-settings");
  const SITE = "https://example.memberful.com";
  const withKeys: WorkspaceSettings = { ...asAdministrator, memberfulSite: SITE };
  const withAccount = (settings: WorkspaceSettings, changes: Partial<Account>): WorkspaceSettings => ({ ...settings, account: { ...settings.account, ...changes } });
  const way = (name: string) => screen.findByRole("switch", { name });
  const signUpLink = () => screen.queryByRole("textbox", { name: "Share so anyone can sign up" });
  const OPEN_OVERRIDES = "Set aside while Open lets anyone join.";
  const MEMBERS_ONLY_OVERRIDES = "Off while Memberful is members only.";

  it("gives administrators Who can join: Open, Join link, Email domain and Memberful, each with a switch and whom it lets in", async () => {
    serve(withKeys);
    showPage();
    const ways = await screen.findByRole("region", { name: "Who can join" });
    expect(within(ways).getByRole("heading", { level: 2, name: "Who can join" })).toBeInTheDocument();
    expect(within(ways).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Open", "Join link", "Email domain", "Memberful"]);
    const open = await way("Open");
    expect(open).not.toBeChecked();
    expect(open).toHaveAccessibleDescription("Anyone can create an account at Ember's sign-up page.");
    const link = await way("Join link");
    expect(link).toBeChecked();
    expect(link).toHaveAccessibleDescription("Anyone with the link can create an account.");
    // Ember emails its links, so until it can send email, turning it on sets that up first.
    const emailDomain = await way("Email domain");
    expect(emailDomain).not.toBeChecked();
    expect(emailDomain).toBeEnabled();
    expect(emailDomain).toHaveAccessibleDescription(
      "People with an email address at your domains join with a link Ember emails them. Ember can't send email yet, so turning this on sets that up first.",
    );
    expect(await way("Memberful")).not.toBeChecked();
    // Each shows its settings while it's on.
    expect(within(screen.getByRole("region", { name: "Join link" })).getByRole("textbox", { name: "Share to invite more people" })).toBeInTheDocument();
    expect(signUpLink()).not.toBeInTheDocument();
  });

  it("turns Open on once you confirm, saved at once with no notice, showing its address and setting the others aside", async () => {
    serve(withKeys);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onAccountChanged, user } = showPage();
    const open = await way("Open");
    await user.click(open);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(CONFIRM_OPEN);
    expect(open).toBeChecked();
    await waitFor(() => expect(onAccountChanged).toHaveBeenLastCalledWith({ ...asAdministrator.account, openSignUp: true }));
    expect(saved()).toEqual([{ settings: { openSignUp: true } }]);
    expect(signUpLink()).toHaveValue(`${location.origin}/join`);
    expect(screen.getByRole("button", { name: "Copy sign-up link" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show sign-up link QR code" })).toBeInTheDocument();

    // The join link and Memberful keep their settings, greyed out.
    for (const name of ["Join link", "Memberful"]) {
      expect(await way(name)).toBeDisabled();
      expect(await way(name)).toHaveAccessibleDescription(OPEN_OVERRIDES);
    }
    expect(await way("Join link")).toBeChecked();
    expect(screen.queryByRole("textbox", { name: "Share to invite more people" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("leaves Open off unless you confirm", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = showPage();
    const open = await way("Open");
    await user.click(open);
    expect(open).not.toBeChecked();
    expect(saved()).toEqual([]);
  });

  it("turns Open off without asking, giving the others back", async () => {
    serve(withAccount(asAdministrator, { openSignUp: true }));
    const confirm = vi.spyOn(window, "confirm");
    const { user } = showPage();
    await user.click(await way("Open"));
    expect(confirm).not.toHaveBeenCalled();
    expect(saved()).toEqual([{ settings: { openSignUp: false } }]);
    await waitFor(async () => expect(await way("Join link")).toBeEnabled());
    expect(await joinLink()).toBeInTheDocument();
    expect(signUpLink()).not.toBeInTheDocument();
  });

  it.each([
    { way: "Open", on: { openSignUp: true }, off: { openSignUp: false }, others: ["Join link", "Memberful"] },
    { way: "Members only", on: { memberfulJoin: true, memberfulSignIn: true }, off: { memberfulJoin: true, memberfulSignIn: false }, others: ["Open", "Join link"] },
  ])("keeps what $way sets aside greyed out until turning it off is saved, since the server refuses those till then", async ({ way: overriding, on, off, others }) => {
    let answer = (_: Response) => {};
    serve(withAccount(withKeys, on), { saved: () => new Promise((resolve) => (answer = resolve)) });
    const { user } = showPage();
    const overrides = await way(overriding);
    await user.click(overrides);
    expect(overrides).not.toBeChecked();
    for (const name of others) expect(await way(name)).toBeDisabled();

    answer(Response.json({ account: { ...withKeys.account, ...off } }));
    for (const name of others) await waitFor(async () => expect(await way(name)).toBeEnabled());
  });

  it("can't be moved again until the last move is answered, and moves back saying why it was refused", async () => {
    let answer = (_: Response) => {};
    serve(asAdministrator, { saved: () => new Promise((resolve) => (answer = resolve)) });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onFailed, user } = showPage();
    const open = await way("Open");
    await user.click(open);
    await user.click(open);
    expect(open).toBeChecked();
    expect(saved()).toEqual([{ settings: { openSignUp: true } }]);

    answer(Response.json({ error: OPEN_WITH_MEMBERFUL }, { status: 422 }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 422, message: OPEN_WITH_MEMBERFUL })));
    expect(open).not.toBeChecked();
  });

  it("nudges administrators to keep creating rooms to themselves while Open is on, linking to the switch", async () => {
    serve(withAccount(asAdministrator, { openSignUp: true }));
    const { user } = showPage();
    expect(await screen.findByText(/Anyone who signs up can create rooms\./)).toHaveTextContent(
      "Anyone who signs up can create rooms. To keep that to administrators, turn on Must be admin to create new rooms.",
    );
    const restrict = screen.getByRole("link", { name: "Must be admin to create new rooms" });
    expect(restrict).toHaveAttribute("href", workspaceSectionPath("channel-settings"));
    await user.click(restrict);
    expect(await screen.findByRole("switch", { name: "Must be admin to create new rooms" })).toBeVisible();

    act(() => workspaceSays({ ...asAdministrator.account, openSignUp: true, restrictRoomCreation: true }));
    expect(screen.queryByText(/Anyone who signs up can create rooms/)).not.toBeInTheDocument();
  });

  it("says what limits signing up until Ember has Turnstile's keys, and opens Set up Turnstile to lift them", async () => {
    serve(withAccount(asAdministrator, { openSignUp: true }));
    const { user } = showPage();
    const open = await screen.findByRole("region", { name: "Open" });
    expect(open).toHaveTextContent(
      "Until Cloudflare Turnstile checks that whoever signs up is a person, 5 people can sign up from a network in an hour, and signing up waits once 50 people have joined in an hour. Setting up Turnstile lifts these limits.",
    );
    await user.click(within(open).getByRole("button", { name: "Set up Turnstile" }));
    expect(await screen.findByRole("dialog", { name: "Set up Turnstile" })).toBeInTheDocument();
  });

  it("says Turnstile checks whoever signs up once Ember has a widget's keys, with no limits", async () => {
    serve({ ...withAccount(asAdministrator, { openSignUp: true }), turnstile: "saved" });
    showPage();
    const open = await screen.findByRole("region", { name: "Open" });
    expect(open).toHaveTextContent("Cloudflare Turnstile checks that whoever signs up is a person.");
    expect(open).not.toHaveTextContent("in an hour");
    expect(within(open).queryByRole("button", { name: "Set up Turnstile" })).not.toBeInTheDocument();
  });

  it("turns the join link off at once without asking, taking the link away, and back on with the same link", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { onAccountChanged, user } = showPage();
    const link = await way("Join link");
    await user.click(link);
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(onAccountChanged).toHaveBeenLastCalledWith({ ...asAdministrator.account, joinLink: false }));
    expect(screen.queryByRole("textbox", { name: "Share to invite more people" })).not.toBeInTheDocument();
    // Every way is off now, which Who can join leaves unsaid, as the project's owner asked.
    expect(screen.queryByText(/^With all of these off/)).not.toBeInTheDocument();

    await user.click(link);
    expect(await joinLink()).toHaveValue(`http://localhost:3000/join/${JOIN_CODE}`);
    expect(saved()).toEqual([{ settings: { joinLink: false } }, { settings: { joinLink: true } }]);
  });

  it("greys out Open and Join link while Memberful is members only", async () => {
    serve(withAccount(withKeys, { memberfulJoin: true, memberfulSignIn: true }));
    showPage();
    for (const name of ["Open", "Join link"]) {
      expect(await way(name)).toBeDisabled();
      expect(await way(name)).toHaveAccessibleDescription(MEMBERS_ONLY_OVERRIDES);
    }
    expect(await way("Memberful")).toBeEnabled();
    expect(await way("Members only")).toBeEnabled();
    expect(screen.queryByRole("textbox", { name: "Share to invite more people" })).not.toBeInTheDocument();
  });

  it("lets each be turned off should Open and Members only both be on", async () => {
    serve(withAccount(withKeys, { memberfulJoin: true, memberfulSignIn: true, openSignUp: true }));
    showPage();
    expect(await way("Open")).toBeEnabled();
    expect(await way("Memberful")).toBeEnabled();
    expect(await way("Members only")).toBeEnabled();
    expect(await way("Join link")).toBeDisabled();
  });

  it("keeps Memberful beside the join link and Open, set aside while Open is on", async () => {
    serve(withAccount(withKeys, { memberfulJoin: true, joinLink: false }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = showPage();
    const link = await way("Join link");
    expect(link).toBeEnabled();
    await user.click(link);
    expect(await joinLink()).toBeInTheDocument();

    const open = await way("Open");
    await user.click(open);
    await waitFor(async () => expect(await way("Memberful")).toBeDisabled());
    expect(saved()).toEqual([{ settings: { joinLink: true } }, { settings: { openSignUp: true } }]);
    const memberful = await way("Memberful");
    expect(memberful).toBeChecked();
    expect(memberful).toHaveAccessibleDescription(OPEN_OVERRIDES);
    expect(screen.queryByRole("switch", { name: "Members only" })).not.toBeInTheDocument();
  });

  it("follows the workspace socket, for a switch moved in another tab", async () => {
    showPage();
    const open = await way("Open");
    act(() => workspaceSays({ ...asAdministrator.account, openSignUp: true }));
    expect(open).toBeChecked();
    expect(signUpLink()).toBeInTheDocument();
    expect(await way("Join link")).toBeDisabled();
  });

  it("shows members open sign-up's link while it's on, and the join link while it lets people in, with no switches", async () => {
    serve(withAccount(asMember, { openSignUp: true }));
    showPage(asLinus);
    expect(await joinLink()).toBeInTheDocument();
    expect(signUpLink()).toHaveValue(`${location.origin}/join`);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Who can join" })).not.toBeInTheDocument();
  });

  it("tells members when only the people administrators invite can join", async () => {
    serve(withAccount(asMember, { joinLink: false }));
    showPage(asLinus);
    expect(await screen.findByText("Only the people administrators invite can join.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Share to invite more people" })).not.toBeInTheDocument();
    expect(signUpLink()).not.toBeInTheDocument();
  });

  it("shows guests open sign-up's link while it's on, but not the join link, whose code they aren't given", async () => {
    serve(withAccount(asGuest, { openSignUp: true }));
    showPage(asLinus);
    expect(await screen.findByRole("textbox", { name: "Share so anyone can sign up" })).toHaveValue(`${location.origin}/join`);
    expect(screen.queryByRole("textbox", { name: "Share to invite more people" })).not.toBeInTheDocument();
    expect(screen.queryByText("Only the people administrators invite can join.")).not.toBeInTheDocument();
  });
});

describe("Join with an email domain", () => {
  showingSection("membership-settings");
  const sending: WorkspaceSettings = { ...asAdministrator, email: { provider: "cloudflare", resendKey: null, cloudflare: true, from: "Ember <ember@example.com>" } };
  /** `settings` with Email domain on, letting in `domains`. */
  const letsIn = (domains: string[], settings = sending): WorkspaceSettings => ({
    ...settings,
    account: { ...settings.account, emailDomainSignUp: true, emailDomains: domains },
    emailDomains: domains,
  });
  const emailDomain = () => screen.findByRole("switch", { name: "Email domain" });
  const card = () => screen.getByRole("region", { name: "Email domain" });
  const domainField = () => within(card()).getByRole("textbox", { name: "Add a domain" });
  const domainsListed = () =>
    within(within(card()).getByRole("list", { name: "Domains that can join" }))
      .getAllByRole("button")
      .map((chip) => chip.textContent);
  const saveButton = () => within(card()).queryByRole("button", { name: /^Save/ });

  it("opens its list as it's turned on without a domain, which saving turns it on with, saying Changes saved.", async () => {
    serve(sending);
    const { onAccountChanged, user } = showPage();
    const toggle = await emailDomain();
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAccessibleDescription("People with an email address at your domains join with a link Ember emails them.");
    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(saved()).toEqual([]);
    expect(domainField()).toHaveFocus();
    expect(card()).toHaveTextContent(NO_EMAIL_DOMAINS);
    expect(saveButton()).toHaveAccessibleName("Save and turn on");
    expect(saveButton()).toBeDisabled();
    // Until it's on, it has no link to share.
    expect(within(card()).queryByRole("textbox", { name: "Share with people at your domains" })).not.toBeInTheDocument();

    await user.type(domainField(), " @Example.ORG, analytical.example{Enter}");
    expect(domainsListed()).toEqual(["example.org", "analytical.example"]);
    expect(domainField()).toHaveValue("");
    await user.click(saveButton()!);
    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(saved()).toEqual([{ emailDomains: ["example.org", "analytical.example"], settings: { emailDomainSignUp: true } }]);
    expect(onAccountChanged).toHaveBeenLastCalledWith({ ...sending.account, emailDomainSignUp: true, emailDomains: ["example.org", "analytical.example"] });
    expect(toggle).toBeChecked();
    expect(saveButton()).not.toBeInTheDocument();
    expect(within(card()).getByRole("textbox", { name: "Share with people at your domains" })).toHaveValue(`${location.origin}/join/email`);
    expect(within(card()).getByRole("button", { name: "Copy email sign-up link" })).toBeInTheDocument();
  });

  it("turns off again without saving anything while its first domains aren't saved", async () => {
    serve(sending);
    const { user } = showPage();
    const toggle = await emailDomain();
    await user.click(toggle);
    await user.type(domainField(), "example.org{Enter}");
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(within(card()).queryByRole("textbox", { name: "Add a domain" })).not.toBeInTheDocument();
    expect(saved()).toEqual([]);
  });

  it("keeps in the field what isn't a domain, saying so, and warns of domains anyone can have an address at", async () => {
    serve(letsIn(["example.org"]));
    const { user } = showPage();
    await emailDomain();
    expect(domainsListed()).toEqual(["example.org"]);
    expect(saveButton()).not.toBeInTheDocument();

    await user.type(domainField(), "gmail.com not_a_domain example.org{Enter}");
    const refusal = "not_a_domain isn't a domain, such as example.com.";
    expect(within(card()).getByRole("alert")).toHaveTextContent(refusal);
    expect(domainField()).toHaveValue("not_a_domain");
    expect(domainField()).toHaveAccessibleDescription(refusal);
    expect(domainsListed()).toEqual(["example.org", "gmail.com"]);
    expect(card()).toHaveTextContent("Anyone can get an address at gmail.com, so listing it lets almost anyone join.");

    await user.click(within(card()).getByRole("button", { name: "Save domains" }));
    expect(await screen.findByText(CHANGES_SAVED)).toBeInTheDocument();
    expect(saved()).toEqual([{ emailDomains: ["example.org", "gmail.com"] }]);
    expect(saveButton()).not.toBeInTheDocument();
  });

  it("takes a domain off with its button, keeping one while it's on, and has nothing to save once it's as kept", async () => {
    serve(letsIn(["example.org", "example.com"]));
    const { user } = showPage();
    await emailDomain();
    await user.click(within(card()).getByRole("button", { name: "Remove example.com" }));
    expect(domainsListed()).toEqual(["example.org"]);
    expect(saveButton()).toHaveAccessibleName("Save domains");
    await user.type(domainField(), "example.com{Enter}");
    expect(domainsListed()).toEqual(["example.org", "example.com"]);
    expect(saveButton()).not.toBeInTheDocument();

    for (const domain of ["example.org", "example.com"]) await user.click(within(card()).getByRole("button", { name: `Remove ${domain}` }));
    expect(card()).toHaveTextContent(NO_EMAIL_DOMAINS);
    expect(saveButton()).toBeDisabled();
    await user.type(domainField(), "example.org{Enter}");
    await user.click(saveButton()!);
    await waitFor(() => expect(saved()).toEqual([{ emailDomains: ["example.org"] }]));
  });

  it("turns on with the domains it kept, saved at once with no notice, and off again", async () => {
    serve({ ...sending, emailDomains: ["example.org"] });
    const { onAccountChanged, user } = showPage();
    const toggle = await emailDomain();
    await user.click(toggle);
    await waitFor(() => expect(onAccountChanged).toHaveBeenLastCalledWith({ ...sending.account, emailDomainSignUp: true, emailDomains: ["example.org"] }));
    expect(domainsListed()).toEqual(["example.org"]);
    await user.click(toggle);
    await waitFor(() => expect(saved()).toEqual([{ settings: { emailDomainSignUp: true } }, { settings: { emailDomainSignUp: false } }]));
    expect(toggle).not.toBeChecked();
    expect(screen.queryByText(CHANGES_SAVED)).not.toBeInTheDocument();
  });

  it("says when it's on but Ember can email nobody a link until email is set up, with Set up email, and can still be turned off", async () => {
    serve(letsIn(["example.org"], asAdministrator));
    const { user } = showPage();
    const toggle = await emailDomain();
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAccessibleDescription("It's on, but Ember can't send email, so nobody gets a link to join with until email is set up.");
    await user.click(within(card()).getByRole("button", { name: "Set up email" }));
    expect(await screen.findByRole("dialog", { name: "Set up email" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(toggle);
    await waitFor(() => expect(saved()).toEqual([{ settings: { emailDomainSignUp: false } }]));
    expect(within(card()).queryByRole("button", { name: "Set up email" })).not.toBeInTheDocument();
  });

  /** Sets up email with Resend in Set up email, from `from`, as an administrator does. */
  async function setUpResend(user: ReturnType<typeof userEvent.setup>, from = "Ember <ember@example.com>") {
    await user.click(await screen.findByRole("radio", { name: "Resend" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(await screen.findByRole("textbox", { name: "API key" }), "re_123{Enter}");
    await user.type(await screen.findByRole("textbox", { name: "From" }), `${from}{Enter}`);
    await user.click(await screen.findByRole("button", { name: "Done" }));
  }

  it("sets up email as it's turned on before Ember can send any, then opens its list", async () => {
    const { user } = showPage();
    const toggle = await emailDomain();
    await user.click(toggle);
    expect(await screen.findByRole("dialog", { name: "Set up email" })).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    await setUpResend(user);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription("People with an email address at your domains join with a link Ember emails them.");
    expect(domainField()).toBeInTheDocument();
    expect(saveButton()).toHaveAccessibleName("Save and turn on");
    expect(saved()).toEqual([{ emailFrom: "Ember <ember@example.com>" }]);
    expect(screen.getByRole("region", { name: "Email" })).toHaveTextContent("Ember sends email from Ember <ember@example.com> with Resend.");
  });

  it("turns on with the domains it kept once email is set up", async () => {
    serve({ ...asAdministrator, emailDomains: ["example.org"] });
    const { onAccountChanged, user } = showPage();
    await user.click(await emailDomain());
    await setUpResend(user);
    await waitFor(() => expect(onAccountChanged).toHaveBeenLastCalledWith({ ...asAdministrator.account, emailDomainSignUp: true, emailDomains: ["example.org"] }));
    expect(saved()).toEqual([{ emailFrom: "Ember <ember@example.com>" }, { settings: { emailDomainSignUp: true } }]);
    expect(domainsListed()).toEqual(["example.org"]);
  });

  it("stays off when Set up email closes before Ember can send email", async () => {
    const { user } = showPage();
    const toggle = await emailDomain();
    await user.click(toggle);
    await user.click(await screen.findByRole("radio", { name: "Resend" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(await screen.findByRole("textbox", { name: "API key" }), "re_123{Enter}");
    await screen.findByRole("dialog", { name: "Choose the From address" });
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    expect(within(card()).queryByRole("textbox", { name: "Add a domain" })).not.toBeInTheDocument();
    expect(saved()).toEqual([]);
  });

  it.each([
    { way: "Open", changes: { openSignUp: true }, says: "Set aside while Open lets anyone join." },
    { way: "Members only", changes: { memberfulJoin: true, memberfulSignIn: true }, says: "Off while Memberful is members only." },
  ])("greys it out while $way is on, keeping its domains for later", async ({ changes, says }) => {
    const settings = letsIn(["example.org"]);
    serve({ ...settings, memberfulSite: "https://example.memberful.com", account: { ...settings.account, ...changes } });
    showPage();
    const toggle = await emailDomain();
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription(says);
    expect(within(card()).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("says how often Ember emails an address a link, and what limits asking until Ember has Turnstile's keys, opening Set up Turnstile to lift it", async () => {
    serve(letsIn(["example.org"]));
    const { user } = showPage();
    await emailDomain();
    expect(card()).toHaveTextContent("Ember emails an address at most 3 links an hour, whoever asks, so nobody can use it to fill someone's inbox.");
    expect(card()).toHaveTextContent(
      "Until Cloudflare Turnstile checks that whoever asks is a person, 10 links can be asked for from a network in an hour. Setting up Turnstile lifts that limit.",
    );
    await user.click(within(card()).getByRole("button", { name: "Set up Turnstile" }));
    expect(await screen.findByRole("dialog", { name: "Set up Turnstile" })).toBeInTheDocument();
  });

  it("says Turnstile checks whoever asks once Ember has a widget's keys, with no limit on a network", async () => {
    serve({ ...letsIn(["example.org"]), turnstile: "saved" });
    showPage();
    await emailDomain();
    expect(card()).toHaveTextContent("Cloudflare Turnstile checks that whoever asks for a link is a person.");
    expect(card()).not.toHaveTextContent("from a network");
    expect(within(card()).queryByRole("button", { name: "Set up Turnstile" })).not.toBeInTheDocument();
  });

  it("follows the workspace socket, for domains saved in another tab", async () => {
    serve(letsIn(["example.org"]));
    showPage();
    await emailDomain();
    act(() => workspaceSays({ ...sending.account, emailDomainSignUp: true, emailDomains: ["example.org", "example.com"] }));
    expect(domainsListed()).toEqual(["example.org", "example.com"]);
  });

  it("keeps the domains another tab turned it on with once it's turned off here, turning on with them again", async () => {
    serve(sending);
    const { onAccountChanged, user } = showPage();
    const toggle = await emailDomain();
    // Another tab saves the first domain, turning it on, and the workspace socket says so.
    const changes = { emailDomains: ["example.org"], settings: { emailDomainSignUp: true } };
    const { account } = (await (await fetch("/api/account", { method: "PATCH", body: JSON.stringify(changes) })).json()) as { account: Account };
    act(() => workspaceSays(account));
    expect(domainsListed()).toEqual(["example.org"]);

    await user.click(toggle);
    await waitFor(() => expect(onAccountChanged).toHaveBeenLastCalledWith({ ...sending.account, emailDomainSignUp: false, emailDomains: [] }));
    await user.click(toggle);
    await waitFor(() => expect(saved()).toEqual([changes, { settings: { emailDomainSignUp: false } }, { settings: { emailDomainSignUp: true } }]));
    await waitFor(() => expect(onAccountChanged).toHaveBeenLastCalledWith({ ...sending.account, emailDomainSignUp: true, emailDomains: ["example.org"] }));
    expect(domainsListed()).toEqual(["example.org"]);
    expect(saveButton()).not.toBeInTheDocument();
  });

  it("shows members its link while it lets people in, naming the domains, with no switch", async () => {
    serve({ ...letsIn(["example.org", "example.com"], asMember), emailDomains: [] });
    showPage(asLinus);
    expect(await screen.findByRole("textbox", { name: "Share with people at example.org or example.com" })).toHaveValue(`${location.origin}/join/email`);
    expect(await joinLink()).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("shows members only open sign-up's link while Open lets anyone in", async () => {
    const settings = letsIn(["example.org"], asMember);
    serve({ ...settings, account: { ...settings.account, openSignUp: true }, emailDomains: [] });
    showPage(asLinus);
    expect(await screen.findByRole("textbox", { name: "Share so anyone can sign up" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /^Share with people at/ })).not.toBeInTheDocument();
  });
});

describe("Sending email", () => {
  showingSection("membership-settings");

  it("gives administrators the Email card after Who can join, whose Set up email shows what it set up", async () => {
    const { user } = showPage();
    const email = await screen.findByRole("region", { name: "Email" });
    const following = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(following(screen.getByRole("region", { name: "Who can join" }), email)).toBe(true);
    expect(email).toHaveTextContent("Ember can't send email yet, so it can't email invitations, the links people at your email domains join with, or codes to reset a forgotten password.");

    await user.click(within(email).getByRole("button", { name: "Set up email" }));
    await user.click(await screen.findByRole("radio", { name: "Cloudflare Email Service" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.type(await screen.findByRole("textbox", { name: "From" }), "Ember <ember@example.com>{Enter}");
    await user.click(await screen.findByRole("button", { name: "Done" }));
    expect(saved()).toEqual([{ emailFrom: "Ember <ember@example.com>" }]);
    expect(email).toHaveTextContent("Ember sends email from Ember <ember@example.com> with Cloudflare Email Service.");
    expect(within(email).getByRole("button", { name: "Send me a test email" })).toBeEnabled();
    // Nothing else changed, so Who can join stays as it was.
    expect(await screen.findByRole("switch", { name: "Email domain" })).not.toBeChecked();

    await user.click(within(email).getByRole("button", { name: "Change" }));
    expect(await screen.findByRole("radio", { name: "Cloudflare Email Service" })).toBeChecked();
  });

  it("stops sending email once the administrator confirms Stop sending email, as Invite by email and Email domain then say", async () => {
    serve({
      ...asAdministrator,
      account: { ...asAdministrator.account, emailDomainSignUp: true, emailDomains: ["example.org"] },
      emailDomains: ["example.org"],
      email: { provider: "cloudflare", resendKey: null, cloudflare: true, from: "Ember <ember@example.com>" },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = showPage();
    const email = await screen.findByRole("region", { name: "Email" });
    await user.click(within(email).getByRole("button", { name: "Stop sending email" }));
    expect(await within(email).findByRole("button", { name: "Set up email" })).toBeInTheDocument();
    expect(saved()).toEqual([{ emailFrom: null }]);
    expect(email).toHaveTextContent("Ember can't send email yet, so it can't email invitations, the links people at your email domains join with, or codes to reset a forgotten password.");
    expect(within(screen.getByRole("region", { name: "Invite by email" })).getByRole("button", { name: "Create invite links" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Email domain" })).toHaveAccessibleDescription(
      "It's on, but Ember can't send email, so nobody gets a link to join with until email is set up.",
    );
  });

  it("shows members no Email card", async () => {
    serve({ ...asMember, email: { provider: "cloudflare", resendKey: null, cloudflare: true, from: "Ember <ember@example.com>" } });
    showPage(asLinus);
    expect(await joinLink()).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Email" })).not.toBeInTheDocument();
  });
});

describe("Check that people are people with Cloudflare Turnstile", () => {
  showingSection("membership-settings");

  const following = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  /** Workspace settings for administrators while Open lets anyone sign up, with Turnstile's keys from `turnstile`. */
  const open = (turnstile: WorkspaceSettings["turnstile"]): WorkspaceSettings => ({ ...asAdministrator, account: { ...asAdministrator.account, openSignUp: true }, turnstile });

  it("gives administrators the Turnstile card after Email, whose switch sets up Turnstile, lifting the limits Who can join says", async () => {
    serve(open(null));
    const { user } = showPage();
    const turnstile = await screen.findByRole("region", { name: "Turnstile" });
    expect(following(screen.getByRole("region", { name: "Email" }), turnstile)).toBe(true);
    const openCard = screen.getByRole("region", { name: "Open" });
    expect(openCard).toHaveTextContent("Setting up Turnstile lifts these limits.");

    const turnstileSwitch = within(turnstile).getByRole("switch", { name: "Turnstile" });
    expect(turnstileSwitch).not.toBeChecked();
    await user.click(turnstileSwitch);
    await user.type(await screen.findByRole("textbox", { name: "Site key" }), "0x4AAAAAAA-a-widgets-site-key");
    await user.type(screen.getByRole("textbox", { name: "Secret key" }), "0x4AAAAAAA-a-widgets-secret-key");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const check = await screen.findByTitle<HTMLIFrameElement>("Turnstile's check");
    act(() => void window.dispatchEvent(new MessageEvent("message", { data: { turnstileCheck: { token: "XXXX.DUMMY.TOKEN.XXXX" } }, origin: location.origin, source: check.contentWindow })));
    await user.click(await screen.findByRole("button", { name: "Done" }));
    expect(turnstile).toHaveTextContent("Cloudflare Turnstile checks that whoever signs up, or asks Ember to email them a link to join or a code to reset a password, is a person.");
    expect(turnstileSwitch).toBeChecked();
    expect(openCard).toHaveTextContent("Cloudflare Turnstile checks that whoever signs up is a person.");
    expect(openCard).not.toHaveTextContent("in an hour");

    await user.click(within(turnstile).getByRole("button", { name: "Change keys" }));
    expect(await screen.findByText("Ember has a widget's keys already. Give another widget's to check people with it instead.")).toBeInTheDocument();
  });

  it("turns Turnstile off once the administrator confirms, as Who can join then says", async () => {
    serve(open("saved"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = showPage();
    const turnstile = await screen.findByRole("region", { name: "Turnstile" });
    await user.click(within(turnstile).getByRole("switch", { name: "Turnstile" }));
    await waitFor(() => expect(within(turnstile).queryByRole("button", { name: "Change keys" })).not.toBeInTheDocument());
    expect(within(turnstile).getByRole("switch", { name: "Turnstile" })).not.toBeChecked();
    expect(within(turnstile).getByRole("switch", { name: "Turnstile" })).toBeEnabled();
    expect(within(screen.getByRole("region", { name: "Open" })).getByRole("button", { name: "Set up Turnstile" })).toBeInTheDocument();
  });

  it("shows members no Turnstile card", async () => {
    serve({ ...asMember, turnstile: "saved" });
    showPage(asLinus);
    expect(await joinLink()).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Turnstile" })).not.toBeInTheDocument();
  });
});

describe("Ember AI", () => {
  showingSection("assistant-settings");
  /** Ember AI on Claude Haiku 5.5, the only model people can pick. */
  const ON: AssistantSettings = {
    accountId: "0123456789abcdef0123456789abcdef",
    model: "anthropic/claude-haiku-5.5",
    models: [{ id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", format: "anthropic" }],
    most: TOP_LEVELS,
    webTools: [],
    instructions: "",
    promptTemplate: null,
    avatarUrl: EMBER_FLAME,
    avatar: false,
  };

  const agentsCard = () => screen.queryByRole("region", { name: "Agents" });

  it("gives administrators the Ember AI card, whose switch sets up Ember AI, then lists the agents under it", async () => {
    const { user } = showPage();
    const card = await screen.findByRole("region", { name: "Ember AI" });
    const assistantSwitch = within(card).getByRole("switch", { name: "Ember AI" });
    expect(assistantSwitch).not.toBeChecked();
    expect(card).toHaveTextContent(ASSISTANT_EXPLAINED);
    expect(agentsCard()).not.toBeInTheDocument();
    await user.click(assistantSwitch);
    await user.type(await screen.findByRole("textbox", { name: "Account ID" }), "0123456789abcdef0123456789abcdef");
    await user.type(screen.getByRole("textbox", { name: "API token" }), "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-Ab");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.selectOptions(await screen.findByRole("combobox", { name: "Model" }), "anthropic/claude-haiku-5.5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Hello, team!")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(card).toHaveTextContent(AGENTS_ANSWER);
    expect(assistantSwitch).toBeChecked();

    // @ember, on the model it saved, then the agents.
    await waitFor(() => expect(within(agentsCard()!).getAllByRole("listitem")).toHaveLength(2));
    const [ember, recap] = within(agentsCard()!).getAllByRole("listitem");
    expect(ember).toHaveTextContent("Claude Haiku 5.5 · Every open room");
    expect(within(ember!).getByRole("link", { name: "Edit Ember" })).toHaveAttribute("href", "/account/agents/ember/edit");
    expect(within(recap!).getByRole("link", { name: "Edit Recap" })).toHaveAttribute("href", `/account/agents/${RECAP.id}/edit`);
    expect(within(agentsCard()!).getByRole("link", { name: "New agent" })).toHaveAttribute("href", "/account/agents/new");

    // Then the apps connected, under the agents.
    const appsCard = await screen.findByRole("region", { name: "Apps" });
    expect(agentsCard()!.compareDocumentPosition(appsCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await within(appsCard).findByRole("link", { name: "Edit Linear" })).toHaveAttribute("href", "/account/apps/0mgk3x2a9b4c70/edit");
    expect(within(appsCard).getByRole("link", { name: "Connect an app" })).toHaveAttribute("href", "/account/apps/new");

    await user.click(within(card).getByRole("button", { name: "Change" }));
    expect(await screen.findByRole("textbox", { name: "Account ID" })).toHaveValue("0123456789abcdef0123456789abcdef");
  });

  it("fills in the Cloudflare account Ember is deployed to when the switch sets up Ember AI", async () => {
    serve({ ...asAdministrator, cloudflareAccountId: "0123456789abcdef0123456789abcdef" });
    const { user } = showPage();
    const card = await screen.findByRole("region", { name: "Ember AI" });
    await user.click(within(card).getByRole("switch", { name: "Ember AI" }));
    const accountId = await screen.findByRole("textbox", { name: "Account ID" });
    expect(accountId).toHaveValue("0123456789abcdef0123456789abcdef");
    expect(accountId).toHaveAccessibleDescription("Ember is deployed to this account. To ask through another, paste that account's ID.");
  });

  it("turns Ember AI off once the administrator confirms, taking the agents away", async () => {
    serve({ ...asAdministrator, assistant: ON });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = showPage();
    const card = await screen.findByRole("region", { name: "Ember AI" });
    expect(card).toHaveTextContent(AGENTS_ANSWER);
    expect(agentsCard()).toBeInTheDocument();
    await user.click(within(card).getByRole("switch", { name: "Ember AI" }));
    await waitFor(() => expect(within(card).queryByRole("button", { name: "Change" })).not.toBeInTheDocument());
    expect(within(card).getByRole("switch", { name: "Ember AI" })).not.toBeChecked();
    expect(card).toHaveTextContent(ASSISTANT_EXPLAINED);
    expect(agentsCard()).not.toBeInTheDocument();
  });

  it("tells members that administrators manage it, with no card", async () => {
    serve(asMember);
    showPage(asLinus);
    expect(await screen.findByText("Community admins manage the AI assistant.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Ember AI" })).not.toBeInTheDocument();
    expect(agentsCard()).not.toBeInTheDocument();
  });
});

describe("Outside AI", () => {
  showingSection("assistant-settings");
  const card = () => screen.findByRole("region", { name: "Outside AI" });

  it("gives administrators the Outside AI card, whether or not Ember AI is on, whose switch lets AI apps connect", async () => {
    const { user } = showPage();
    const outsideSwitch = within(await card()).getByRole("switch", { name: "Let AI apps connect to Ember" });
    expect(outsideSwitch).not.toBeChecked();

    await user.click(outsideSwitch);

    await waitFor(() => expect(outsideSwitch).toBeChecked());
    expect(fetch).toHaveBeenCalledWith("/api/account/outside_ai", expect.objectContaining({ method: "PUT", body: JSON.stringify({ on: true }) }));
    expect(await card()).toHaveTextContent(`${location.origin}/mcp`);
  });

  it("shows it on once it's on, and off again once an administrator agrees to disconnect every app", async () => {
    serve({ ...asAdministrator, outsideAi: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = showPage();
    const outsideSwitch = within(await card()).getByRole("switch", { name: "Let AI apps connect to Ember" });
    expect(outsideSwitch).toBeChecked();

    await user.click(outsideSwitch);

    await waitFor(() => expect(outsideSwitch).not.toBeChecked());
    expect(confirm).toHaveBeenCalledExactlyOnceWith(CONFIRM_STOP_OUTSIDE_AI);
    expect(await card()).not.toHaveTextContent("/mcp");
  });

  it("isn't shown to members", async () => {
    serve(asMember);
    showPage(asLinus);
    expect(await screen.findByText("Community admins manage the AI assistant.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Outside AI" })).not.toBeInTheDocument();
  });
});

describe("Set up huddles", () => {
  showingSection("huddles-settings");
  /** A Realtime SFU app's keys, as an administrator copies them from Cloudflare's dashboard. */
  const APP = { appId: "2a95132c15732412d22c1476fa83f27a", appSecret: "66bcf64aa8907b9f9d90ac17746a77ce394c393b92b3916633dc02846e608ad4" };
  /** The Huddles tab's card, by its title. */
  const huddlesCard = () => within(screen.getByRole("region", { name: "Huddles" })).findByRole("region", { name: "Audio and video chat" });

  it("gives administrators the Huddles tab's card, whose switch sets up huddles with an SFU app's keys", async () => {
    const { user } = showPage();
    const card = await huddlesCard();
    expect(card).toHaveTextContent("Huddles let people in a room talk to each other live.");
    const huddlesSwitch = within(card).getByRole("switch", { name: "Audio and video chat" });
    expect(huddlesSwitch).not.toBeChecked();

    await user.click(huddlesSwitch);
    const setup = await screen.findByRole("dialog", { name: "Set up huddles" });
    expect(within(setup).getByRole("link", { name: "Open Cloudflare's dashboard" })).toHaveAttribute("href", "https://dash.cloudflare.com/?to=/:account/realtime/sfu");
    await user.type(within(setup).getByRole("textbox", { name: "App ID" }), APP.appId);
    await user.type(within(setup).getByRole("textbox", { name: "App Secret" }), APP.appSecret);
    await user.click(within(setup).getByRole("button", { name: "Save" }));
    await user.click(await screen.findByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(card).toHaveTextContent(`Huddles run through the Realtime SFU app ${APP.appId} in your Cloudflare account.`);
    expect(huddlesSwitch).toBeChecked();
    expect(fetch).toHaveBeenCalledWith("/api/account/huddles", expect.objectContaining({ method: "PUT", body: JSON.stringify(APP) }));

    await user.click(within(card).getByRole("button", { name: "Change keys" }));
    expect(await screen.findByRole("textbox", { name: "App ID" })).toHaveValue(APP.appId);
    expect(screen.getByText("Ember has an app's keys already. Give another app's to run huddles through it instead.")).toBeInTheDocument();
  });

  it("opens Cloudflare's dashboard at the account Ember is deployed to when the switch sets up huddles", async () => {
    serve({ ...asAdministrator, cloudflareAccountId: "0123456789abcdef0123456789abcdef" });
    const { user } = showPage();
    await user.click(within(await huddlesCard()).getByRole("switch", { name: "Audio and video chat" }));
    expect(await screen.findByRole("link", { name: "Open Cloudflare's dashboard" })).toHaveAttribute(
      "href",
      "https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/realtime/sfu",
    );
  });

  it("turns huddles off once the administrator confirms", async () => {
    serve({ ...asAdministrator, huddles: { appId: APP.appId } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = showPage();
    const card = await huddlesCard();
    expect(card).toHaveTextContent(`Huddles run through the Realtime SFU app ${APP.appId} in your Cloudflare account.`);
    await user.click(within(card).getByRole("switch", { name: "Audio and video chat" }));
    await waitFor(() => expect(within(card).queryByRole("button", { name: "Change keys" })).not.toBeInTheDocument());
    expect(within(card).getByRole("switch", { name: "Audio and video chat" })).not.toBeChecked();
    expect(within(card).getByRole("switch", { name: "Audio and video chat" })).toBeEnabled();
    expect(card).toHaveTextContent("Huddles let people in a room talk to each other live.");
    expect(fetch).toHaveBeenCalledWith("/api/account/huddles", expect.objectContaining({ method: "DELETE" }));
  });

  it("keeps the card out of Rooms and permissions, where it was", async () => {
    showPage();
    await huddlesCard();
    act(() => navigate(workspaceSectionPath("channel-settings")));
    const rooms = screen.getByRole("region", { name: "Room order and permissions" });
    expect(within(rooms).getByRole("list", { name: "Room order" })).toBeInTheDocument();
    expect(within(rooms).queryByRole("region", { name: "Audio and video chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Audio and video chat" })).not.toBeInTheDocument();
  });

  it("tells members that administrators manage huddles, with no card", async () => {
    serve(asMember);
    showPage(asLinus);
    expect(await screen.findByText("Community admins manage huddles.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Audio and video chat" })).not.toBeInTheDocument();
  });
});

describe("Invite people by email", () => {
  showingSection("membership-settings");

  const following = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it("gives administrators Invite by email between Who can join and Email, with the invitations waiting, which it adds to", async () => {
    serve({ ...asAdministrator, invitations: [invitationTo("ann@example.com")] });
    const { user } = showPage();
    const invite = await screen.findByRole("region", { name: "Invite by email" });
    expect(following(screen.getByRole("region", { name: "Who can join" }), invite)).toBe(true);
    expect(following(invite, screen.getByRole("region", { name: "Email" }))).toBe(true);
    expect(within(invite).getByRole("region", { name: "Pending invitations" })).toHaveTextContent("ann@example.com");

    // Without a From address, Ember can't email them.
    await user.type(within(invite).getByRole("textbox", { name: "Email addresses" }), "bob@example.com");
    await user.click(within(invite).getByRole("button", { name: "Create invite links" }));
    expect(await within(invite).findByRole("button", { name: "Copy the invite link for bob@example.com" })).toBeInTheDocument();
    expect(within(invite).getAllByRole("listitem")).toHaveLength(2);
  });

  it("emails invitations once Ember can send email and has a From address", async () => {
    serve({ ...asAdministrator, email: { provider: "resend", resendKey: "secret", cloudflare: true, from: "Ember <ember@example.com>" } });
    showPage();
    const invite = await screen.findByRole("region", { name: "Invite by email" });
    expect(within(invite).getByRole("button", { name: "Send invitations" })).toBeInTheDocument();
    expect(within(invite).queryByRole("button", { name: "Set up email" })).not.toBeInTheDocument();
  });

  it("sets up email from Invite by email, which then emails invitations", async () => {
    serve({ ...asAdministrator, email: { provider: "resend", resendKey: "secret", cloudflare: true, from: null } });
    const { user } = showPage();
    const invite = await screen.findByRole("region", { name: "Invite by email" });
    await user.click(within(invite).getByRole("button", { name: "Set up email" }));
    await user.type(await screen.findByRole("textbox", { name: "From" }), "Ember <ember@example.com>{Enter}");
    await user.click(await screen.findByRole("button", { name: "Done" }));
    expect(within(invite).getByRole("button", { name: "Send invitations" })).toBeInTheDocument();
  });

  it("shows members no Invite by email card", async () => {
    serve(asMember);
    showPage(asLinus);
    expect(await joinLink()).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Invite by email" })).not.toBeInTheDocument();
  });
});

describe("Join link", () => {
  showingSection("membership-settings");

  it("shows members the join link, and tells the welcome card its code", async () => {
    serve(asMember);
    const { onJoinCodeChanged } = showPage();
    expect(await joinLink()).toHaveValue(`http://localhost:3000/join/${JOIN_CODE}`);
    expect(onJoinCodeChanged).toHaveBeenCalledExactlyOnceWith(JOIN_CODE);
    expect(screen.getByRole("button", { name: "Copy join link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate join link" })).not.toBeInTheDocument();
  });

  it("shows guests, who aren't given its code, that only the people administrators invite can join, and tells the welcome card nothing", async () => {
    serve(asGuest);
    const { onJoinCodeChanged } = showPage(asLinus);
    expect(await screen.findByText("Only the people administrators invite can join.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Share to invite more people" })).not.toBeInTheDocument();
    expect(onJoinCodeChanged).not.toHaveBeenCalled();
  });
});

describe("Regenerate the join link", () => {
  showingSection("membership-settings");

  it("lets an administrator regenerate the link at once, with no notice", async () => {
    const { onJoinCodeChanged, user } = showPage();
    await user.click(await screen.findByRole("button", { name: "Regenerate join link" }));
    await waitFor(async () => expect(await joinLink()).toHaveValue(`http://localhost:3000/join/${NEW_JOIN_CODE}`));
    expect(fetch).toHaveBeenCalledWith("/api/account/join_code", expect.objectContaining({ method: "POST" }));
    expect(onJoinCodeChanged).toHaveBeenLastCalledWith(NEW_JOIN_CODE);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("can't regenerate it again until the last is answered", async () => {
    let answer = (_: Response) => {};
    serve(asAdministrator, { regenerated: () => new Promise((resolve) => (answer = resolve)) });
    const { user } = showPage();
    const regenerate = await screen.findByRole("button", { name: "Regenerate join link" });
    await user.click(regenerate);
    expect(regenerate).toBeDisabled();
    answer(Response.json({ joinCode: NEW_JOIN_CODE }));
    await waitFor(() => expect(regenerate).toBeEnabled());
  });

  it("says why it wasn't regenerated, keeping the link it had", async () => {
    serve(asAdministrator, { regenerated: () => Response.json({ error: "Only administrators can change the workspace" }, { status: 403 }) });
    const { onFailed, onJoinCodeChanged, user } = showPage();
    await user.click(await screen.findByRole("button", { name: "Regenerate join link" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 403 })));
    expect(await joinLink()).toHaveValue(`http://localhost:3000/join/${JOIN_CODE}`);
    expect(screen.getByRole("button", { name: "Regenerate join link" })).toBeEnabled();
    expect(onJoinCodeChanged).toHaveBeenCalledOnce();
  });
});

describe("Create an open room", () => {
  showingSection("channel-settings");

  it("has New room in Rooms and permissions, which opens the form in place", async () => {
    const { user } = showPage();
    const rooms = screen.getByRole("region", { name: "Room order and permissions" });
    const newRoom = within(rooms).getByRole("link", { name: "New room" });
    expect(newRoom).toHaveAttribute("href", "/rooms/opens/new");
    await user.click(newRoom);
    expect(location.pathname).toBe("/rooms/opens/new");
  });
});

describe("Only administrators create rooms (setting)", () => {
  const restrictSwitch = () => screen.findByRole("switch", { name: "Must be admin to create new rooms" });
  const roomsSection = () => screen.getByRole("region", { name: "Room order and permissions" });
  const ADMINS_MANAGE = "Community admins manage room order and permissions.";
  showingSection("channel-settings");

  it("gives administrators a crowned switch under New room that limits creating rooms to them, saved at once with no notice", async () => {
    const { onAccountChanged, user } = showPage();
    const restrict = await restrictSwitch();
    expect(roomsSection()).toContainElement(restrict);
    expect(restrict.parentElement).toHaveTextContent("Must be admin to create new rooms");
    expect(restrict.parentElement!.querySelector("svg")).toHaveClass("iconoir-crown");
    expect(restrict).not.toBeChecked();

    await user.click(restrict);
    expect(restrict).toBeChecked();
    await waitFor(() => expect(onAccountChanged).toHaveBeenLastCalledWith({ ...asAdministrator.account, restrictRoomCreation: true }));
    // Administrators can still create rooms.
    expect(within(roomsSection()).getByRole("link", { name: "New room" })).toBeInTheDocument();

    await user.click(restrict);
    await waitFor(() => expect(onAccountChanged).toHaveBeenLastCalledWith(asAdministrator.account));
    expect(saved()).toEqual([{ settings: { restrictRoomCreation: true } }, { settings: { restrictRoomCreation: false } }]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("follows the workspace socket, for a switch moved in another tab", async () => {
    showPage();
    const restrict = await restrictSwitch();
    act(() => workspaceSays({ ...asAdministrator.account, restrictRoomCreation: true }));
    expect(restrict).toBeChecked();
  });

  it("can't be moved again until the last move is answered, and moves back saying why it was refused", async () => {
    let answer = (_: Response) => {};
    serve(asAdministrator, { saved: () => new Promise((resolve) => (answer = resolve)) });
    const { onFailed, user } = showPage();
    const restrict = await restrictSwitch();
    await user.click(restrict);
    await user.click(restrict);
    expect(restrict).toBeChecked();
    expect(saved()).toEqual([{ settings: { restrictRoomCreation: true } }]);

    answer(Response.json({ error: "Only administrators can change the workspace" }, { status: 403 }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 403 })));
    expect(restrict).not.toBeChecked();
  });

  it("takes New room away from members while it's on, and gives it back once it's off", async () => {
    serve({ ...asMember, account: { ...asMember.account, restrictRoomCreation: true } });
    showPage(asLinus);
    expect(await screen.findByText(ADMINS_MANAGE)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New room" })).not.toBeInTheDocument();

    act(() => workspaceSays({ ...asMember.account, restrictRoomCreation: false }));
    expect(within(roomsSection()).getByRole("link", { name: "New room" })).toBeInTheDocument();
  });

  it("gives members New room while anyone can create rooms, saying admins manage the rest", async () => {
    serve(asMember);
    showPage(asLinus);
    const rooms = roomsSection();
    expect(await within(rooms).findByText(ADMINS_MANAGE)).toBeInTheDocument();
    expect(within(rooms).getByRole("link", { name: "New room" })).toBeInTheDocument();
    expect(within(rooms).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(rooms).queryByRole("list", { name: "Room order" })).not.toBeInTheDocument();
  });
});

describe("Shared room order", () => {
  const HELP = "Drag a room to reorder your community sidebar. Click a room to set its permissions.";
  const orderList = () => screen.getByRole("list", { name: "Room order" });
  const orderRows = () => within(orderList()).getAllByRole("listitem");
  /** The room a row is for, by the name its link to the room's settings has. */
  const roomOf = (row: HTMLElement) => within(row).getByRole("link").getAttribute("aria-label")!.replace("Settings for ", "");
  /** The rooms the list shows, top to bottom. */
  const ordered = () => orderRows().map(roomOf);
  const orderRow = (name: string) => orderRows().find((row) => roomOf(row) === name)!;
  const status = () => within(screen.getByRole("region", { name: "Room order and permissions" })).getByRole("status");
  showingSection("channel-settings");
  const button = (name: string) => screen.getByRole("button", { name });
  /** The orders the page has saved, as sent. */
  const sentOrders = () =>
    vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input) === "/api/account/room_order")
      .map(([, init]) => [init?.method, JSON.parse(String(init?.body))]);
  /** Moves `name`'s row with Alt and an arrow. */
  const altArrow = (name: string, key: "ArrowUp" | "ArrowDown") => fireEvent.keyDown(orderRow(name), { key, altKey: true });

  it("lists an administrator's rooms but their DMs, the ones the shared order ranks first, in its order, then the rest by name", async () => {
    showPage();
    await screen.findByRole("list", { name: "Room order" });
    expect(ordered()).toEqual(["Design", "general", "random"]);
    act(() => sidebarSays(adasRooms, ["random", "general"]));
    expect(ordered()).toEqual(["random", "general", "Design"]);

    expect(screen.getByText(HELP)).toBeInTheDocument();
    for (const row of orderRows()) {
      expect(row).toHaveAccessibleDescription(HELP);
      expect(row).toHaveAttribute("tabindex", "0");
      expect(row).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    }
    const grip = within(orderRow("random")).getByRole("button", { name: "Move random" });
    expect(grip).toHaveAttribute("title", "Drag to reorder, or press Alt + Up / Down");
    expect(grip).toHaveClass("cursor-grab", "touch-none");
    expect(button("Cancel")).toBeDisabled();
    expect(button("Save order")).toBeDisabled();
    expect(status()).toBeEmptyDOMElement();
    expect(status()).toHaveClass("sr-only");
  });

  it("moves a row past the one above or below it with Alt and an arrow, keeping it focused, and saves only with Save order", async () => {
    const { onSharedOrderSaved, user } = showPage();
    await screen.findByRole("list", { name: "Room order" });
    orderRow("random").focus();
    altArrow("random", "ArrowUp");
    expect(ordered()).toEqual(["Design", "random", "general"]);
    expect(orderRow("random")).toHaveFocus();
    expect(status()).toHaveTextContent("Unsaved room order. Save to apply it to everyone.");
    expect(status()).not.toHaveClass("sr-only");
    expect(status()).toHaveClass("text-muted-foreground");
    // Not past either end, nor with the arrow alone.
    altArrow("Design", "ArrowUp");
    fireEvent.keyDown(orderRow("general"), { key: "ArrowUp" });
    altArrow("general", "ArrowDown");
    expect(ordered()).toEqual(["Design", "random", "general"]);
    expect(sentOrders()).toEqual([]);

    await user.click(button("Save order"));
    await waitFor(() => expect(status()).toHaveTextContent("Room order saved for everyone."));
    expect(sentOrders()).toEqual([["PUT", { roomIds: ["secret", "random", "general"] }]]);
    expect(onSharedOrderSaved).toHaveBeenCalledExactlyOnceWith(["secret", "random", "general"]);
    expect(ordered()).toEqual(["Design", "random", "general"]);
    expect(button("Save order")).toBeDisabled();
    expect(button("Cancel")).toBeDisabled();
  });

  it("puts the rows back as saved with Cancel, saying nothing", async () => {
    const { user } = showPage();
    await screen.findByRole("list", { name: "Room order" });
    altArrow("general", "ArrowUp");
    await user.click(button("Cancel"));
    expect(ordered()).toEqual(["Design", "general", "random"]);
    expect(status()).toBeEmptyDOMElement();
    expect(button("Save order")).toBeDisabled();
    expect(sentOrders()).toEqual([]);
  });

  it("keeps still until a save is answered, then saves nothing more until something moves", async () => {
    let answer = (_: Response) => {};
    serve(asAdministrator, { ordered: () => new Promise((resolve) => (answer = resolve)) });
    const { user } = showPage();
    await screen.findByRole("list", { name: "Room order" });
    altArrow("general", "ArrowUp");
    await user.click(button("Save order"));
    expect(status()).toHaveTextContent("Saving room order…");
    expect(button("Save order")).toBeDisabled();
    expect(button("Cancel")).toBeDisabled();
    altArrow("random", "ArrowUp");
    expect(ordered()).toEqual(["general", "Design", "random"]);

    await act(async () => answer(Response.json({ sharedOrder: ["general", "secret", "random"] })));
    expect(status()).toHaveTextContent("Room order saved for everyone.");
    expect(sentOrders()).toHaveLength(1);
  });

  it("says on screen why an order wasn't saved, keeping it to try again", async () => {
    serve(asAdministrator, { ordered: () => Response.json({ error: "Only administrators can put rooms in order for everyone" }, { status: 403 }) });
    const { onSharedOrderSaved, onFailed, user } = showPage();
    await screen.findByRole("list", { name: "Room order" });
    altArrow("general", "ArrowUp");
    await user.click(button("Save order"));
    await waitFor(() => expect(status()).toHaveTextContent("Couldn’t save room order. Please try again."));
    expect(status()).toHaveClass("text-negative");
    expect(ordered()).toEqual(["general", "Design", "random"]);
    expect(button("Save order")).toBeEnabled();
    expect(onSharedOrderSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("goes to sign in when the session has expired", async () => {
    serve(asAdministrator, { ordered: () => Response.json({ error: "Sign in to continue" }, { status: 401 }) });
    const { onSessionChanged, user } = showPage();
    await screen.findByRole("list", { name: "Room order" });
    altArrow("general", "ArrowUp");
    await user.click(button("Save order"));
    await waitFor(() => expect(onSessionChanged).toHaveBeenCalledExactlyOnceWith(null));
  });

  it("keeps what's moved as rooms come and go, a new one last, and follows an order saved elsewhere otherwise", async () => {
    showPage();
    await screen.findByRole("list", { name: "Room order" });
    altArrow("random", "ArrowUp");
    expect(ordered()).toEqual(["Design", "random", "general"]);
    act(() => sidebarSays([...adasRooms.filter((room) => room.id !== "secret"), shared("ops", "Ops")], ["general"]));
    expect(ordered()).toEqual(["random", "general", "Ops"]);
    expect(button("Save order")).toBeEnabled();

    fireEvent.click(button("Cancel"));
    expect(ordered()).toEqual(["general", "Ops", "random"]);
    act(() => sidebarSays(adasRooms, ["random", "secret"]));
    expect(ordered()).toEqual(["random", "Design", "general"]);
  });

  it("links each room to its settings, saying who it's open to", async () => {
    const { user } = showPage();
    await screen.findByRole("list", { name: "Room order" });
    const design = within(orderRow("Design")).getByRole("link", { name: "Settings for Design" });
    expect(design).toHaveAttribute("href", "/rooms/closeds/secret/edit");
    expect(design).toHaveTextContent("Selected people");
    const general = within(orderRow("general")).getByRole("link", { name: "Settings for general" });
    expect(general).toHaveAttribute("href", "/rooms/opens/general/edit");
    expect(general).toHaveTextContent("Everyone");
    await user.click(general);
    expect(location.pathname).toBe("/rooms/opens/general/edit");
  });

  describe("left unsaved", () => {
    const asking = () => screen.queryByRole("dialog", { name: "Unsaved Changes" });
    /** Whether the browser would ask before reloading or closing the tab. */
    const unloadAsks = () => !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    const settingsLink = (name: string) => within(orderRow(name)).getByRole("link", { name: `Settings for ${name}` });

    it("asks before leaving with an order staged, by a room's own link too, as a room's form asks, but not between the page's sections", async () => {
      const { user } = showPage();
      await screen.findByRole("list", { name: "Room order" });
      expect(unloadAsks()).toBe(false);
      altArrow("general", "ArrowUp");
      expect(unloadAsks()).toBe(true);

      await user.click(settingsLink("random"));
      const dialog = await screen.findByRole("dialog", { name: "Unsaved Changes" });
      expect(dialog).toHaveAccessibleDescription("You’ve changed the room order. Save it before you leave, or discard it to keep things as they were.");
      expect(button("Save")).toHaveFocus();
      expect(location.pathname).toBe(WORKSPACE_SETTINGS_PATH);
      await user.click(button("Keep editing"));
      await waitFor(() => expect(asking()).not.toBeInTheDocument());
      expect(ordered()).toEqual(["general", "Design", "random"]);

      // Another of the page's sections keeps it staged, as does going Back from there.
      act(() => navigate(workspaceSectionPath("membership-settings")));
      act(() => history.back());
      await waitFor(() => expect(location.hash).toBe("#channel-settings"));
      expect(asking()).not.toBeInTheDocument();

      await user.click(settingsLink("random"));
      await user.click(await screen.findByRole("button", { name: "Discard" }));
      expect(location.pathname).toBe("/rooms/opens/random/edit");
      expect(sentOrders()).toEqual([]);
      expect(unloadAsks()).toBe(false);
    });

    it("saves the order staged before going on, staying, saying so, while it can't be saved", async () => {
      let answers = 0;
      serve(asAdministrator, {
        ordered: () => (answers++ === 0 ? Response.json({ error: "Something went wrong" }, { status: 500 }) : Response.json({ sharedOrder: ["general", "secret", "random"] })),
      });
      const { onSharedOrderSaved, user } = showPage();
      await screen.findByRole("list", { name: "Room order" });
      altArrow("general", "ArrowUp");
      await user.click(settingsLink("random"));
      await user.click(await screen.findByRole("button", { name: "Save" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Your changes couldn’t be saved. Please try again, or keep editing.");
      expect(location.pathname).toBe(WORKSPACE_SETTINGS_PATH);
      expect(onSharedOrderSaved).not.toHaveBeenCalled();

      await user.click(button("Save"));
      await waitFor(() => expect(location.pathname).toBe("/rooms/opens/random/edit"));
      expect(sentOrders()).toEqual([
        ["PUT", { roomIds: ["general", "secret", "random"] }],
        ["PUT", { roomIds: ["general", "secret", "random"] }],
      ]);
      expect(onSharedOrderSaved).toHaveBeenCalledExactlyOnceWith(["general", "secret", "random"]);
      await waitFor(() => expect(asking()).not.toBeInTheDocument());
    });

    it("waits for a save under way, rather than saving again", async () => {
      let answer = (_: Response) => {};
      serve(asAdministrator, { ordered: () => new Promise((resolve) => (answer = resolve)) });
      const { user } = showPage();
      await screen.findByRole("list", { name: "Room order" });
      altArrow("general", "ArrowUp");
      await user.click(button("Save order"));
      await user.click(settingsLink("random"));
      await user.click(await screen.findByRole("button", { name: "Save" }));
      expect(button("Saving…")).toBeDisabled();
      expect(location.pathname).toBe(WORKSPACE_SETTINGS_PATH);

      await act(async () => answer(Response.json({ sharedOrder: ["general", "secret", "random"] })));
      await waitFor(() => expect(location.pathname).toBe("/rooms/opens/random/edit"));
      expect(sentOrders()).toHaveLength(1);
    });

    it("closes the page's other dialogs first, which would stay above it, as another section's image viewer does", async () => {
      const { user } = showPage();
      await screen.findByRole("list", { name: "Room order" });
      altArrow("general", "ArrowUp");
      act(() => navigate(workspaceSectionPath("membership-settings")));
      await user.click(await screen.findByRole("link", { name: "Show join link QR code" }));
      const viewer = screen.getByRole("dialog", { name: "Image Viewer (Press escape to close)" });
      expect(viewer).toHaveAttribute("open");

      act(() => navigate("/rooms/opens/random/edit"));
      expect(await screen.findByRole("dialog", { name: "Unsaved Changes" })).toBeInTheDocument();
      expect(viewer).not.toHaveAttribute("open");
    });
  });

  it("waits for the sidebar's rooms, and says when there are none to arrange", async () => {
    showPage(asAda, everyone, spies(), null);
    await screen.findByRole("switch", { name: "Must be admin to create new rooms" });
    expect(screen.queryByRole("list", { name: "Room order" })).not.toBeInTheDocument();
    act(() => sidebarSays(adasRooms.filter((room) => room.kind === "direct")));
    expect(orderList()).toBeEmptyDOMElement();
    expect(screen.getByText("No rooms to arrange yet.")).toBeInTheDocument();
    act(() => sidebarSays(adasRooms));
    expect(ordered()).toEqual(["Design", "general", "random"]);
    expect(screen.queryByText("No rooms to arrange yet.")).not.toBeInTheDocument();
  });

  describe("dragged", () => {
    // jsdom lays nothing out, so each row is 52px tall, in the order the list draws them, and the list
    // is too tall for a drag to scroll it.
    function layOutRows() {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (!this.dataset.roomId) return DOMRect.fromRect({ x: 0, y: -1000, width: 600, height: 3000 });
        return DOMRect.fromRect({ x: 0, y: Array.prototype.indexOf.call(this.parentElement!.children, this) * 52, width: 600, height: 52 });
      });
    }

    /** Shows the page with its rooms in order, and the clock and layout as the drags need them. */
    async function showList() {
      const shown = showPage();
      await screen.findByRole("list", { name: "Room order" });
      vi.useFakeTimers();
      layOutRows();
      return shown;
    }

    afterEach(() => vi.useRealTimers());

    const grip = (name: string) => within(orderRow(name)).getByRole("button", { name: `Move ${name}` });
    const pressGrip = (name: string) =>
      fireEvent.pointerDown(grip(name), { pointerType: "mouse", button: 0, clientX: 20, clientY: orderRows().indexOf(orderRow(name)) * 52 + 26 });
    const dragTo = (clientY: number) => fireEvent.pointerMove(window, { pointerType: "mouse", clientX: 20, clientY });

    it("picks a row up by its grip at once, moves it past the rows whose middle it passes, and places it where it's let go", async () => {
      await showList();
      pressGrip("random");
      expect(status()).toHaveTextContent("Moving random. Release to place, or press Escape to cancel.");
      expect(orderRow("random")).toHaveClass("bg-hover", "shadow-[inset_3px_0_var(--color-foreground)]");
      expect(orderList()).toHaveClass("select-none");

      dragTo(10);
      expect(ordered()).toEqual(["random", "Design", "general"]);
      fireEvent.pointerUp(window);
      expect(orderRow("random")).not.toHaveClass("bg-hover");
      expect(orderRow("random")).toHaveFocus();
      expect(status()).toHaveTextContent("Unsaved room order. Save to apply it to everyone.");
      expect(button("Save order")).toBeEnabled();
      expect(sentOrders()).toEqual([]);
    });

    it("picks a row up only by its grip", async () => {
      await showList();
      fireEvent.pointerDown(orderRow("random").lastElementChild!, { pointerType: "mouse", button: 0, clientX: 200, clientY: 2 * 52 + 26 });
      dragTo(10);
      fireEvent.pointerUp(window);
      expect(ordered()).toEqual(["Design", "general", "random"]);
      expect(status()).toBeEmptyDOMElement();
    });

    it("puts a dragged row back on Escape, leaving nothing to save", async () => {
      await showList();
      pressGrip("random");
      dragTo(10);
      expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
      expect(ordered()).toEqual(["Design", "general", "random"]);
      expect(status()).toHaveTextContent("Room move canceled.");
      fireEvent.pointerUp(window);
      expect(button("Save order")).toBeDisabled();
    });

    it("puts a row being dragged back when Cancel or Save order is pressed, so what's put back, or saved, is what shows", async () => {
      await showList();
      altArrow("random", "ArrowUp");
      pressGrip("Design");
      dragTo(2 * 52 + 40);
      expect(ordered()).toEqual(["random", "general", "Design"]);
      fireEvent.click(button("Cancel"));
      fireEvent.pointerUp(window);
      expect(ordered()).toEqual(["Design", "general", "random"]);
      expect(button("Save order")).toBeDisabled();

      altArrow("random", "ArrowUp");
      pressGrip("Design");
      dragTo(2 * 52 + 40);
      fireEvent.click(button("Save order"));
      fireEvent.pointerUp(window);
      expect(ordered()).toEqual(["Design", "random", "general"]);
      expect(sentOrders()).toEqual([["PUT", { roomIds: ["secret", "random", "general"] }]]);
      await act(() => vi.runAllTimersAsync());
      expect(status()).toHaveTextContent("Room order saved for everyone.");
    });

    it("drags with a finger on its grip at once, the page not scrolling", async () => {
      await showList();
      fireEvent.touchStart(grip("Design"), { touches: [{ clientX: 20, clientY: 26 }] });
      expect(status()).toHaveTextContent("Moving Design.");
      expect(fireEvent.touchMove(window, { touches: [{ clientX: 20, clientY: 2 * 52 + 40 }] })).toBe(false);
      expect(ordered()).toEqual(["general", "random", "Design"]);
      fireEvent.touchEnd(window);
      expect(status()).toHaveTextContent("Unsaved room order.");
    });
  });
});

/** The names listed under `title`, Admins or Members, or null while the group is left out. */
const namesUnder = (title: "Admins" | "Members") => {
  const group = screen.queryByRole("list", { name: title });
  return group && [...group.children].map((item) => item.querySelector("strong")!.textContent);
};
/** The lists as they read, once the people show: the administrators' names, then the members'. */
const readList = async () => {
  await screen.findByRole("list", { name: "Admins" });
  return [namesUnder("Admins"), namesUnder("Members")];
};
const peopleLists = async () => {
  await screen.findByRole("list", { name: "Admins" });
  return screen.getAllByRole("list", { name: /^(Admins|Members)$/ });
};
const rowOf = async (name: string) => within(await screen.findByRole("region", { name: "Membership" })).getByText(name).closest("li")!;
const crownOf = async (name: string) => within(await rowOf(name)).getByRole("checkbox");
/** The roles the page has asked for, by whom. */
const roleChanges = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([input, init]) => init?.method === "PATCH" && String(input).startsWith("/api/account/users/"))
    .map(([input, init]) => [String(input).split("/").at(-1), (JSON.parse(String(init?.body)) as RoleChange).role]);

describe("People list", () => {
  showingSection("membership-settings");

  it("lists everyone but bots by name, administrators under Admins, then the members under Members, after the join link", async () => {
    showPage();
    expect(await readList()).toEqual([
      ["Ada Lovelace", "Grace Hopper"],
      ["linus Torvalds", "Mallory"],
    ]);
    expect(screen.getByRole("heading", { level: 2, name: "Admins" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Members" })).toBeInTheDocument();
    expect((await joinLink()).compareDocumentPosition(screen.getByRole("list", { name: "Admins" }))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("leaves out a group while nobody's in it", async () => {
    showPage(asAda, [grace, ada]);
    expect(await readList()).toEqual([["Ada Lovelace", "Grace Hopper"], null]);
    expect(screen.queryByRole("heading", { level: 2, name: "Members" })).not.toBeInTheDocument();
  });

  it("shows members the people who are active, with no controls", async () => {
    serve(asMember);
    showPage(asLinus);
    expect(await readList()).toEqual([["Ada Lovelace", "Grace Hopper"], ["linus Torvalds"]]);
    for (const list of await peopleLists()) expect(within(list).queryAllByRole("checkbox")).toEqual([]);
  });

  it("shows administrators who's banned, dimmed under a cancel mark, with no crown", async () => {
    showPage();
    const row = await rowOf("Mallory");
    expect(row.querySelector("img")!.closest("a")).toHaveClass("[&>img]:opacity-50");
    expect(row.querySelector("svg.iconoir-prohibition")).toHaveClass("pointer-events-none");
    expect(within(row).queryByRole("checkbox")).not.toBeInTheDocument();
    expect((await rowOf("linus Torvalds")).querySelector("a")).not.toHaveClass("[&>img]:opacity-50");
  });

  it("gives your own row My settings, which opens your profile, and nobody else's", async () => {
    const { user } = showPage(asLinus);
    const mine = within(await rowOf("linus Torvalds")).getByRole("link", { name: "My settings" });
    expect(within(await rowOf("Grace Hopper")).queryByRole("link", { name: "My settings" })).not.toBeInTheDocument();
    await user.click(mine);
    expect(location.pathname).toBe("/users/me/profile");
  });

  it("shows each person's avatar from the people directory, loaded as it's scrolled to", async () => {
    showPage();
    const avatar = (await rowOf("Grace Hopper")).querySelector("img");
    expect(avatar).toHaveAttribute("src", grace.avatarUrl);
    expect(avatar).toHaveAttribute("loading", "lazy");
  });

  it("loads the people directory again as it shows", async () => {
    const { reloadPeople } = showPage();
    await peopleLists();
    expect(reloadPeople).toHaveBeenCalledOnce();
  });

  it("says why the people didn't load", async () => {
    const callbacks = spies();
    const error = new TypeError("Failed to fetch");
    callbacks.reloadPeople.mockRejectedValueOnce(error);
    showPage(asAda, everyone, callbacks);
    await waitFor(() => expect(callbacks.onFailed).toHaveBeenCalledWith(error));
  });
});

describe("Make or revoke administrators", () => {
  showingSection("membership-settings");

  it("gives administrators a crown on each person's row, pressed for administrators, and their own can't be pressed", async () => {
    showPage();
    expect(await crownOf("Ada Lovelace")).toBeDisabled();
    expect(await crownOf("Ada Lovelace")).toBeChecked();
    expect(await crownOf("Grace Hopper")).toBeEnabled();
    expect(await crownOf("Grace Hopper")).toBeChecked();
    expect(await crownOf("Grace Hopper")).toHaveAccessibleName("Role: Administrator");
    expect(await crownOf("linus Torvalds")).not.toBeChecked();
    expect(await crownOf("linus Torvalds")).toHaveAccessibleName("Role: Member");
  });

  it("makes someone an administrator with their crown, at once, with no notice", async () => {
    const { onPersonChanged, user } = showPage();
    await user.click(await crownOf("linus Torvalds"));
    expect(await crownOf("linus Torvalds")).toBeChecked();
    await waitFor(() => expect(onPersonChanged).toHaveBeenCalledWith({ ...linus, role: "administrator" }));
    expect(roleChanges()).toEqual([["u3", "administrator"]]);
    // Their row joins the administrators.
    expect(await readList()).toEqual([["Ada Lovelace", "Grace Hopper", "linus Torvalds"], ["Mallory"]]);
    expect(await crownOf("linus Torvalds")).toHaveAccessibleName("Role: Administrator");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("makes an administrator a member again", async () => {
    const { onPersonChanged, user } = showPage();
    await user.click(await crownOf("Grace Hopper"));
    await waitFor(() => expect(onPersonChanged).toHaveBeenCalledWith({ ...grace, role: "member" }));
    expect(roleChanges()).toEqual([["u2", "member"]]);
    expect(await readList()).toEqual([["Ada Lovelace"], ["Grace Hopper", "linus Torvalds", "Mallory"]]);
  });

  it("can be pressed from the keyboard, keeping the focus as its row changes group", async () => {
    const { onPersonChanged, user } = showPage();
    (await crownOf("Grace Hopper")).focus();
    // Past Grace's Delete, and linus's avatar, which links to his page.
    await user.tab();
    expect(screen.getByRole("button", { name: "Delete Grace Hopper" })).toHaveFocus();
    await user.tab();
    expect(within(await rowOf("linus Torvalds")).getByRole("link")).toHaveFocus();
    await user.tab();
    expect(await crownOf("linus Torvalds")).toHaveFocus();
    await user.keyboard(" ");
    await waitFor(() => expect(onPersonChanged).toHaveBeenCalledWith({ ...linus, role: "administrator" }));
    expect(namesUnder("Admins")).toContain("linus Torvalds");
    expect(await crownOf("linus Torvalds")).toHaveFocus();

    await user.keyboard(" ");
    await waitFor(() => expect(namesUnder("Members")).toContain("linus Torvalds"));
    expect(await crownOf("linus Torvalds")).toHaveFocus();
  });

  it("can't be pressed again until the change is answered", async () => {
    let answer = (_: Response) => {};
    serve(asAdministrator, { roleChanged: () => new Promise((resolve) => (answer = resolve)) });
    const { user } = showPage();
    const crown = await crownOf("linus Torvalds");
    await user.click(crown);
    await user.click(crown);
    expect(crown).toBeChecked();
    expect(roleChanges()).toEqual([["u3", "administrator"]]);
    answer(Response.json({ user: { ...linus, role: "administrator" } }));
    await waitFor(async () => expect(await readList()).toEqual([["Ada Lovelace", "Grace Hopper", "linus Torvalds"], ["Mallory"]]));
  });

  it("leaves out an answer the workspace socket has overtaken, loading the people again to see who's right", async () => {
    let answer = (_: Response) => {};
    serve(asAdministrator, { roleChanged: () => new Promise((resolve) => (answer = resolve)) });
    const { onPersonChanged, reloadPeople, user } = showPage();
    await user.click(await crownOf("linus Torvalds"));
    // Ada's change comes by the socket before its answer does, and then Grace's, making Linus a member again.
    act(() => socketSays({ ...linus, role: "administrator" }));
    act(() => socketSays({ ...linus, role: "member" }));
    answer(Response.json({ user: { ...linus, role: "administrator" } }));
    await waitFor(async () => expect(await crownOf("linus Torvalds")).not.toBeChecked());
    expect(await readList()).toEqual([
      ["Ada Lovelace", "Grace Hopper"],
      ["linus Torvalds", "Mallory"],
    ]);
    expect(onPersonChanged).not.toHaveBeenCalled();
    expect(reloadPeople).toHaveBeenCalledTimes(2);
  });

  it("doesn't load the people again for an answer the workspace socket has already brought", async () => {
    let answer = (_: Response) => {};
    serve(asAdministrator, { roleChanged: () => new Promise((resolve) => (answer = resolve)) });
    const { onPersonChanged, reloadPeople, user } = showPage();
    await user.click(await crownOf("linus Torvalds"));
    act(() => socketSays({ ...linus, role: "administrator" }));
    answer(Response.json({ user: { ...linus, role: "administrator" } }));
    // Answered after Linus's, a change to Grace shows his answer has been heard.
    serve(asAdministrator);
    await user.click(await crownOf("Grace Hopper"));
    await waitFor(() => expect(onPersonChanged).toHaveBeenCalledWith({ ...grace, role: "member" }));
    expect(onPersonChanged).toHaveBeenCalledOnce();
    expect(reloadPeople).toHaveBeenCalledOnce();
    expect(await crownOf("linus Torvalds")).toBeChecked();
  });

  it("says why a change was refused, and puts the crown back", async () => {
    serve(asAdministrator, { roleChanged: () => Response.json({ error: "Only administrators can change people's roles" }, { status: 403 }) });
    const { onFailed, onPersonChanged, user } = showPage();
    await user.click(await crownOf("linus Torvalds"));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 403 })));
    expect(await crownOf("linus Torvalds")).not.toBeChecked();
    expect(onPersonChanged).not.toHaveBeenCalled();
  });

  it("loads the settings again once the person looking is made an administrator, or a member again", async () => {
    serve(asMember);
    const { rerender } = showPage(asLinus);
    expect(await readList()).toEqual([["Ada Lovelace", "Grace Hopper"], ["linus Torvalds"]]);

    serve(asAdministrator);
    rerender({ ...asLinus, administrator: true });
    expect(await screen.findByRole("button", { name: "Regenerate join link" })).toBeInTheDocument();
    expect(await crownOf("linus Torvalds")).toBeDisabled();
    expect((await readList()).flat()).toContain("Mallory");
  });
});

const deleteOf = async (name: string) => within(await rowOf(name)).queryByRole("button", { name: `Delete ${name}` });
/** Whom the page has asked to remove. */
const removals = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === "DELETE")
    .map(([input]) => String(input).split("/").at(-1));
const confirmed = (answer: boolean) => vi.spyOn(window, "confirm").mockReturnValue(answer);

describe("Remove someone from the workspace", () => {
  showingSection("membership-settings");

  it("gives administrators Delete on each active person's row but their own, white on red, named for them", async () => {
    showPage();
    const remove = await deleteOf("Grace Hopper");
    expect(remove).toBeEnabled();
    expect(remove!.querySelector("svg")).toHaveClass("iconoir-minus");
    expect(remove).toHaveClass("bg-negative-button", "text-white");
    expect(await deleteOf("linus Torvalds")).toBeInTheDocument();
    expect(await deleteOf("Ada Lovelace")).toBeNull();
    expect(await deleteOf("Mallory")).toBeNull();
    // After the crown.
    expect((await crownOf("linus Torvalds")).closest("label")!.nextElementSibling).toBe(await deleteOf("linus Torvalds"));
  });

  it("gives members none", async () => {
    serve(asMember);
    showPage(asLinus);
    for (const list of await peopleLists()) expect(within(list).queryAllByRole("button")).toEqual([]);
  });

  it("removes someone once you confirm, with no notice, and they leave the list", async () => {
    const confirm = confirmed(true);
    const { onPersonChanged, user } = showPage();
    await user.click((await deleteOf("linus Torvalds"))!);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(CONFIRM_REMOVE);
    await waitFor(() => expect(onPersonChanged).toHaveBeenCalledWith({ ...linus, status: "deactivated" }));
    expect(removals()).toEqual(["u3"]);
    expect(await readList()).toEqual([["Ada Lovelace", "Grace Hopper"], ["Mallory"]]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("removes nobody unless you confirm", async () => {
    confirmed(false);
    const { user } = showPage();
    await user.click((await deleteOf("linus Torvalds"))!);
    expect(removals()).toEqual([]);
    expect((await readList()).flat()).toContain("linus Torvalds");
  });

  it("can't be pressed again until the removal is answered", async () => {
    confirmed(true);
    let answer = (_: Response) => {};
    serve(asAdministrator, { removed: () => new Promise((resolve) => (answer = resolve)) });
    const { user } = showPage();
    const remove = (await deleteOf("linus Torvalds"))!;
    await user.click(remove);
    expect(remove).toBeDisabled();
    await user.click(remove);
    expect(removals()).toEqual(["u3"]);
    answer(Response.json({ user: { ...linus, status: "deactivated" } }));
    await waitFor(async () => expect((await readList()).flat()).not.toContain("linus Torvalds"));
  });

  it("needs no answer the workspace socket has already brought", async () => {
    confirmed(true);
    let answer = (_: Response) => {};
    serve(asAdministrator, { removed: () => new Promise((resolve) => (answer = resolve)) });
    const { onPersonChanged, reloadPeople, user } = showPage();
    await user.click((await deleteOf("linus Torvalds"))!);
    act(() => socketSays({ ...linus, status: "deactivated" }));
    expect((await readList()).flat()).not.toContain("linus Torvalds");
    answer(Response.json({ user: { ...linus, status: "deactivated" } }));
    // Answered after Linus's, Grace's removal shows his answer has been heard.
    serve(asAdministrator);
    await user.click((await deleteOf("Grace Hopper"))!);
    await waitFor(() => expect(onPersonChanged).toHaveBeenCalledWith({ ...grace, status: "deactivated" }));
    expect(onPersonChanged).toHaveBeenCalledOnce();
    expect(reloadPeople).toHaveBeenCalledOnce();
  });

  it("says why a removal was refused, keeping them listed, to be tried again", async () => {
    confirmed(true);
    serve(asAdministrator, { removed: () => Response.json({ error: "Only administrators can remove people" }, { status: 403 }) });
    const { onFailed, onPersonChanged, user } = showPage();
    await user.click((await deleteOf("linus Torvalds"))!);
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 403 })));
    expect(await deleteOf("linus Torvalds")).toBeEnabled();
    expect((await readList()).flat()).toContain("linus Torvalds");
    expect(onPersonChanged).not.toHaveBeenCalled();
  });
});

describe("Memberful memberships", () => {
  showingSection("membership-settings");
  const SITE = "https://example.memberful.com";
  const withKeys: WorkspaceSettings = { ...asAdministrator, memberfulSite: SITE };
  const webhookSteps = () => screen.queryByRole("list", { name: "Steps to sign out members whose membership lapses" });
  const lapsed = listed("u7", "Sam Lapsed", "member", "suspended");

  it("says how to hear Memberful's webhooks in the steps to get the keys", async () => {
    const { user } = showPage();
    await user.click(await screen.findByRole("switch", { name: "Memberful" }));
    const steps = screen.getByRole("list", { name: "Steps to let Memberful members sign in" });
    expect(steps).toHaveTextContent(`order events to ${location.origin}/webhooks/memberful.`);
    expect(steps).toHaveTextContent("the webhook's secret key as MEMBERFUL_WEBHOOK_SECRET, and the custom app's API key as MEMBERFUL_API_KEY");
    expect(webhookSteps()).not.toBeInTheDocument();
  });

  it("gives administrators the steps to hear Memberful's webhooks once it's on, until the deployment has their secrets", async () => {
    serve(withKeys);
    const { user } = showPage();
    const on = await screen.findByRole("switch", { name: "Memberful" });
    expect(on).toHaveAccessibleDescription(expect.not.stringContaining("signed out"));
    expect(webhookSteps()).not.toBeInTheDocument();
    await user.click(on);
    const steps = webhookSteps()!;
    expect(within(steps).getAllByRole("listitem")).toHaveLength(2);
    expect(steps).toHaveTextContent(`order events to ${location.origin}/webhooks/memberful.`);
    expect(steps).toHaveTextContent("Give this Worker two more secrets: the webhook's secret key as MEMBERFUL_WEBHOOK_SECRET, and the custom app's API key as MEMBERFUL_API_KEY.");
    expect(within(steps).getByRole("link", { name: "Open the Cloudflare dashboard" })).toHaveAttribute("target", "_blank");
    expect(screen.getByText(/stays signed in where they are/)).toBeInTheDocument();
  });

  it("says a member whose membership lapses is signed out once the deployment hears Memberful's webhooks, and where they come", async () => {
    serve({ ...withKeys, memberfulWebhooks: true, account: { ...withKeys.account, memberfulJoin: true } });
    showPage();
    const on = await screen.findByRole("switch", { name: "Memberful" });
    expect(on).toHaveAccessibleDescription(expect.stringMatching(/ A member whose membership lapses is signed out until it's renewed\.$/));
    expect(webhookSteps()).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Memberful" })).toHaveTextContent(
      `and its webhook to ${location.origin}/webhooks/memberful. If Ember's address changes, change both there too.`,
    );
  });

  it("shows administrators who's suspended for their membership's lapsing, dimmed and said to be so, with Delete but no crown", async () => {
    showPage(asAda, [...everyone, lapsed]);
    expect(await readList()).toEqual([
      ["Ada Lovelace", "Grace Hopper"],
      ["linus Torvalds", "Mallory", "Sam Lapsed"],
    ]);
    const row = await rowOf("Sam Lapsed");
    expect(row).toHaveTextContent("Membership lapsed");
    expect(row.querySelector("a")).toHaveClass("[&>img]:opacity-50");
    expect(row.querySelector("svg.iconoir-prohibition")).toBeNull();
    expect(within(row).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(await deleteOf("Sam Lapsed")).toBeEnabled();
  });

  it("doesn't show members who's suspended", async () => {
    serve(asMember);
    showPage(asLinus, [...everyone, lapsed]);
    expect(await readList()).toEqual([["Ada Lovelace", "Grace Hopper"], ["linus Torvalds"]]);
  });
});

describe("Avatars open people's pages", () => {
  showingSection("membership-settings");

  it("links each person's avatar to their page, titled with their name and bio, a banned person's too, and goes there in place", async () => {
    const { user } = showPage(asAda, [ada, { ...grace, bio: "Wrote the first compiler" }, mallory]);
    const link = within(await rowOf("Grace Hopper")).getByRole("link");
    expect(link).toHaveAttribute("href", "/users/u2");
    expect(link).toHaveAttribute("title", "Grace Hopper – Wrote the first compiler");
    expect(within(await rowOf("Mallory")).getByRole("link", { name: "Mallory" })).toHaveAttribute("href", "/users/u4");
    await user.click(link);
    expect(location.pathname).toBe("/users/u2");
  });
});
