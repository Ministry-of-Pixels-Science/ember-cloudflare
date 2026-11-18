import type { DirectoryUser, Me, Person, PersonAnswer, User } from "@ember/protocol";
import type { AgentProfile } from "@ember/protocol/agents";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "@/components/ui/sheet";
import { BlockingContext } from "@/hooks/use-blocking";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { ReportingContext } from "@/hooks/use-reporting";
import { guardLeaving, navigate } from "@/hooks/use-route";
import { adminsOnlyAsk, CONFIRM_BAN, CONFIRM_UNBAN, PersonPage } from "./person-page";

const ada: Me = { id: "u1", name: "Ada Lovelace", administrator: false };
const grace: Person = { id: "u2", name: "Grace Hopper", bio: "Wrote the first compiler", role: "member", status: "active", avatarUrl: "/users/t2/avatar?v=1" };
const bender: Person = { id: "u3", name: "Bender", bio: null, role: "bot", status: "active", avatarUrl: "/users/t3/avatar?v=1" };

/** Answers the page's request for someone with `answer`, once the returned function is called if it's held. */
function serve(answer: () => Response | Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
}

const found = (person: Person) => () => Response.json({ person });

interface Shown {
  me?: Me;
  people?: People;
  /** What starting a DM settles with, rather than that it did. */
  started?: () => Promise<boolean>;
  /** Whom `me` has blocked, as the sidebar last heard. */
  blocked?: string[];
  /** What blocking or unblocking settles with, rather than that it did. */
  changedBlock?: () => Promise<boolean>;
}

/** Someone's page as `me` sees it, opened from general. */
function showPage(person: Person | string, { me = ada, people = new Map(), started = async () => true, blocked = [], changedBlock = async () => true }: Shown = {}) {
  const userId = typeof person === "string" ? person : person.id;
  const [onMissing, onFailed] = [vi.fn(), vi.fn()];
  const onStartDirect = vi.fn<(person: User) => Promise<boolean>>(started);
  const onPersonChanged = vi.fn<(person: DirectoryUser) => void>();
  const reloadPeople = vi.fn(async () => {});
  const setBlocked = vi.fn<(person: User, blocked: boolean) => Promise<boolean>>(changedBlock);
  const openReport = vi.fn();
  let shown = { me, people, blocking: { blocked: new Set(blocked), setBlocked } };
  const view = () => (
    <PeopleContext value={shown.people}>
      <BlockingContext value={shown.blocking}>
        <ReportingContext value={openReport}>
          <Sheet>
            <PersonPage
              userId={userId}
              me={shown.me}
              onStartDirect={onStartDirect}
              onPersonChanged={onPersonChanged}
              reloadPeople={reloadPeople}
              onMissing={onMissing}
              onFailed={onFailed}
            />
          </Sheet>
        </ReportingContext>
      </BlockingContext>
    </PeopleContext>
  );
  const { rerender } = render(view());
  const show = (changes: Partial<typeof shown>) => {
    shown = { ...shown, ...changes };
    rerender(view());
  };
  return {
    onStartDirect,
    onPersonChanged,
    reloadPeople,
    onMissing,
    onFailed,
    setBlocked,
    openReport,
    list: (people: People) => show({ people }),
    become: (me: Me) => show({ me }),
    block: (blockedNow: string[]) => show({ blocking: { blocked: new Set(blockedNow), setBlocked } }),
    user: userEvent.setup(),
  };
}

const heading = () => screen.findByRole("heading", { level: 1 });
const avatar = () => screen.findByRole("img", { name: "Profile avatar" });
const directButton = (name: string) => screen.queryByRole("button", { name: `Ping ${name}` });
const mailLink = () => screen.queryByRole("link", { name: /@/ });

beforeEach(() => {
  history.replaceState(null, "", "/rooms/general");
  navigate(`/users/${grace.id}`);
});

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
  document.title = "";
});

describe("Someone's profile page", () => {
  it("shows someone's avatar, name and bio, titled with their name, with Go Back to where it was opened from", async () => {
    serve(found(grace));
    showPage(grace, { people: new Map([[grace.id, grace]]) });
    expect(await heading()).toHaveTextContent("Grace Hopper");
    // The tab is named once the page has drawn them, which can take a moment longer.
    await waitFor(() => expect(document.title).toBe("Grace Hopper"));
    expect(screen.getByText("Wrote the first compiler")).toBeVisible();
    expect(await avatar()).toHaveAttribute("src", grace.avatarUrl);
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/rooms/general");
    expect(vi.mocked(fetch).mock.calls).toEqual([["/api/users/u2", expect.anything()]]);
    // Only your own page has the pencil, and only administrators are told an email address.
    expect(screen.queryByRole("link", { name: "Edit my profile" })).toBeNull();
    expect(mailLink()).toBeNull();
  });

  it("shows someone's @username under their name, if they have one, as the people directory lists them now", async () => {
    const amazing = { ...grace, username: "amazing.grace" };
    serve(found(amazing));
    const { list } = showPage(amazing, { people: new Map([[grace.id, amazing]]) });
    expect(await heading()).toHaveTextContent("Grace Hopper");
    expect(screen.getByText("@amazing.grace")).toBeVisible();

    list(new Map([[grace.id, { ...amazing, username: "grace" }]]));
    expect(await screen.findByText("@grace")).toBeVisible();
    // The directory leaves out a username they've taken away.
    list(new Map([[grace.id, grace]]));
    expect(await heading()).toHaveTextContent("Grace Hopper");
    expect(screen.queryByText(/^@/)).toBeNull();
  });

  it("goes back home when the app didn't open it, and asks for ids escaped", async () => {
    history.replaceState(null, "", "/users/caf%C3%A9");
    serve(found({ ...grace, id: "café" }));
    showPage("café");
    expect(await heading()).toHaveTextContent("Grace Hopper");
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/");
    expect(vi.mocked(fetch).mock.calls).toEqual([["/api/users/caf%C3%A9", expect.anything()]]);
  });

  it("is busy until they've loaded", async () => {
    let answer = (_: Response) => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    showPage(grace);
    expect(screen.getByRole("main").querySelector("section")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("heading")).toBeNull();
    await act(async () => answer(Response.json({ person: grace })));
    expect(screen.getByRole("main").querySelector("section")).toHaveAttribute("aria-busy", "false");
  });

  it("shows administrators someone's email address as a mail link, or nothing for someone with none", async () => {
    serve(found({ ...grace, emailAddress: "grace@example.com" }));
    showPage(grace, { me: { ...ada, administrator: true } });
    await heading();
    expect(mailLink()).toHaveAttribute("href", "mailto:grace@example.com");
    expect(mailLink()).toHaveTextContent("grace@example.com");
  });

  it("loads them again once you become an administrator or stop being one, for their email address", async () => {
    let administrator = false;
    serve(() => Response.json({ person: administrator ? { ...grace, emailAddress: "grace@example.com" } : grace }));
    const { become } = showPage(grace);
    await heading();
    become({ ...ada, name: "Ada King" });
    expect(fetch).toHaveBeenCalledTimes(1);

    administrator = true;
    become({ ...ada, administrator: true });
    await waitFor(() => expect(mailLink()).toHaveAttribute("href", "mailto:grace@example.com"));

    administrator = false;
    become(ada);
    await waitFor(() => expect(mailLink()).toBeNull());
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("shows no link for someone with no email address", async () => {
    serve(found({ ...grace, emailAddress: null }));
    showPage(grace, { me: { ...ada, administrator: true } });
    await heading();
    expect(screen.queryAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/rooms/general"]);
  });

  it("has a pencil to Edit my profile on your own page", async () => {
    serve(found({ ...grace, id: ada.id, name: ada.name, bio: null }));
    showPage(ada.id);
    expect(await heading()).toHaveTextContent("Ada Lovelace");
    expect(screen.getByRole("link", { name: "Edit my profile" })).toHaveAttribute("href", "/users/me/profile");
    // You can start a DM with yourself.
    expect(directButton("Ada Lovelace")).toBeVisible();
  });

  it("names them, and shows their bio and avatar, as the people directory lists them now", async () => {
    serve(found(grace));
    const { list } = showPage(grace);
    await heading();
    const renamed: DirectoryUser = { ...grace, name: "Grace Brewster Hopper", bio: "Rear admiral", avatarUrl: "/users/t2/avatar?v=2" };
    list(new Map([[grace.id, renamed]]));
    expect(await heading()).toHaveTextContent("Grace Brewster Hopper");
    await waitFor(() => expect(document.title).toBe("Grace Brewster Hopper"));
    expect(screen.getByText("Rear admiral")).toBeVisible();
    expect(await avatar()).toHaveAttribute("src", renamed.avatarUrl);
  });

  it("shows banned people's names and bios under a dimmed avatar with a cancel mark, with no DM button", async () => {
    serve(found({ ...grace, status: "banned" }));
    showPage(grace);
    expect(await heading()).toHaveTextContent("Grace Hopper");
    expect(screen.getByText("Wrote the first compiler")).toBeVisible();
    expect(await avatar()).toHaveClass("opacity-50");
    expect(document.querySelector("svg.iconoir-prohibition")).toBeInTheDocument();
    expect(directButton("Grace Hopper")).toBeNull();
  });

  it("shows removed people's names and that they're no longer on this account", async () => {
    serve(found({ ...grace, status: "deactivated" }));
    showPage(grace);
    expect(await heading()).toHaveTextContent("Grace Hopper");
    expect(screen.getByText("Grace Hopper is no longer on this account")).toBeVisible();
    expect(screen.queryByText("Wrote the first compiler")).toBeNull();
    expect(directButton("Grace Hopper")).toBeNull();
    expect(document.querySelector("svg.iconoir-prohibition")).toBeNull();
  });

  it("starts a DM with them, or opens yours, with a chat bubble, which a second click doesn't start again", async () => {
    serve(found(grace));
    let settle = (_: boolean) => {};
    const { onStartDirect, user } = showPage(grace, { started: () => new Promise((resolve) => (settle = resolve)) });
    await heading();
    const button = directButton("Grace Hopper")!;
    expect(button.querySelector("svg")).toHaveClass("iconoir-chat-lines");
    await user.click(button);
    expect(onStartDirect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: grace.id, name: grace.name }));
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    expect(onStartDirect).toHaveBeenCalledOnce();

    // It can be pressed again if that fails, as it would to try again.
    await act(async () => settle(false));
    expect(button).not.toHaveAttribute("aria-disabled");
    await user.click(button);
    expect(onStartDirect).toHaveBeenCalledTimes(2);
  });

  it("starts the DM only once the page's guard lets it leave", async () => {
    serve(found(grace));
    let proceed = () => {};
    const stopGuarding = guardLeaving((_, go) => {
      proceed = go as () => void;
      return true;
    });
    try {
      const { onStartDirect, user } = showPage(grace);
      await heading();
      await user.click(directButton("Grace Hopper")!);
      expect(onStartDirect).not.toHaveBeenCalled();
      await act(async () => proceed());
      expect(onStartDirect).toHaveBeenCalledOnce();
    } finally {
      stopGuarding();
    }
  });

  it("has nobody with the id show Campfire's 404 page", async () => {
    serve(() => Response.json({ error: "Not found" }, { status: 404 }));
    const { onMissing, onFailed } = showPage("nobody");
    await waitFor(() => expect(onMissing).toHaveBeenCalledOnce());
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says why when they can't be loaded", async () => {
    serve(() => Response.json({ error: "Something went wrong" }, { status: 500 }));
    const { onMissing, onFailed } = showPage(grace);
    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(onFailed.mock.calls[0]![0]).toMatchObject({ status: 500, message: "Something went wrong" });
    expect(onMissing).not.toHaveBeenCalled();
  });
});

describe("A bot's profile", () => {
  const administrator: Me = { ...ada, administrator: true };

  it("shows an active bot's avatar and a button that starts a DM with it, without a name, bio, email, sign-in link or ban, even to administrators", async () => {
    // All a person's page could show, of which a bot's shows none.
    serve(() => Response.json({ person: { ...bender, bio: "Bends girders", emailAddress: "bender@example.com" }, transferId: "u3.mgk3x2a9.signature" } satisfies PersonAnswer));
    const { onStartDirect, user } = showPage(bender, { me: administrator });
    expect(await avatar()).toBeVisible();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByText("Bends girders")).toBeNull();
    expect(mailLink()).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /\bban\b/i })).toBeNull();

    const button = directButton("Bender")!;
    expect(button.querySelector("svg")).toHaveClass("iconoir-chat-lines");
    await user.click(button);
    expect(onStartDirect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: bender.id, name: bender.name }));
  });

  it("badges @ember's page as an agent's under its avatar, and no other bot's", async () => {
    const ember: Person = { ...bender, id: "ember", name: "Ember" };
    serve(found(ember));
    showPage(ember);
    expect(await avatar()).toBeVisible();
    const badge = screen.getByText("Agent");
    expect(badge).toHaveAttribute("data-slot", "badge");
    expect(badge.previousElementSibling).toContainElement(await avatar());
    expect(directButton("Ember")).toBeVisible();
    cleanup();

    serve(found(bender));
    showPage(bender);
    expect(await avatar()).toBeVisible();
    expect(screen.queryByText("Agent")).toBeNull();
  });

  describe("an agent's", () => {
    const recap: Person = { ...bender, id: "u4", name: "Recap", agent: true };
    const HAIKU: AgentProfile = { description: "Sums up long threads", model: "anthropic/claude-haiku-5.5", modelName: "Claude Haiku 5.5", setUpBy: { id: grace.id, name: grace.name } };
    const showAgent = (agent: AgentProfile, shown: Shown = {}, person = recap) => {
      serve(() => Response.json({ person, agent } satisfies PersonAnswer));
      return showPage(person, shown);
    };
    const runsOn = () => screen.getByText(/^An AI agent running on /);

    it("shows its name, what it does, the model it answers with, whom that sends what's asked to, and who set it up, under the badge", async () => {
      const { onStartDirect, user } = showAgent(HAIKU);
      expect(await heading()).toHaveTextContent(/^Recap$/);
      expect(screen.getByText("Agent").previousElementSibling).toContainElement(await avatar());
      expect(screen.getByText("Sums up long threads")).toBeVisible();
      expect(runsOn()).toHaveTextContent(
        /^An AI agent running on Claude Haiku 5\.5 through Cloudflare AI Gateway, which sends the conversation you ask it in to Anthropic\. Grace Hopper set it up\.$/,
      );
      // Its instructions are only on its settings page.
      expect(screen.queryByRole("textbox")).toBeNull();
      await user.click(directButton("Recap")!);
      expect(onStartDirect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: recap.id, name: "Recap" }));
    });

    it("says a Workers AI model runs on Cloudflare, and names each other model's maker it knows", async () => {
      const models: Array<[Pick<AgentProfile, "model" | "modelName">, RegExp]> = [
        [{ model: "@cf/zai-org/glm-4.7-flash", modelName: "GLM-4.7 Flash" }, /^An AI agent running on GLM-4\.7 Flash, on Cloudflare’s Workers AI\. /],
        [{ model: "openai/gpt-6.1-sol", modelName: "GPT-6.1 Sol" }, /, which sends the conversation you ask it in to OpenAI\. /],
        [{ model: "google/gemini-4-argon", modelName: "Gemini 4 Argon" }, /, which sends the conversation you ask it in to Google\. /],
        [{ model: "moonshotai/kimi-k3", modelName: "Kimi K3" }, /, which sends the conversation you ask it in to Moonshot AI\. /],
        [{ model: "xai/grok-5", modelName: "Grok 5" }, /^An AI agent running on Grok 5 through Cloudflare AI Gateway, which sends the conversation you ask it in to the model’s maker\. /],
      ];
      for (const [model, said] of models) {
        showAgent({ ...HAIKU, ...model });
        expect(await heading()).toBeVisible();
        expect(runsOn()).toHaveTextContent(said);
        cleanup();
        vi.restoreAllMocks();
      }
    });

    it("says you set it up, if you did, and names whoever else did as the people directory lists them now", async () => {
      showAgent({ ...HAIKU, setUpBy: { id: ada.id, name: ada.name } });
      expect(await heading()).toBeVisible();
      expect(runsOn()).toHaveTextContent(/ You set it up\.$/);
      cleanup();

      const renamed: DirectoryUser = { ...grace, name: "Grace Brewster Hopper" };
      showAgent(HAIKU, { people: new Map([[renamed.id, renamed]]) });
      expect(await heading()).toBeVisible();
      expect(runsOn()).toHaveTextContent(/ Grace Brewster Hopper set it up\.$/);
    });

    it("says what it does while Ember AI is off, but that it's no longer on this account, without the DM button", async () => {
      showAgent(HAIKU, {}, { ...recap, status: "deactivated" });
      expect(await heading()).toHaveTextContent(/^Recap$/);
      expect(screen.getByText("Sums up long threads")).toBeVisible();
      expect(screen.getByText("Recap is no longer on this account")).toBeVisible();
      expect(directButton("Recap")).toBeNull();
    });

    it("says only administrators can ask one kept for them, in place of the DM button, which an administrator has", async () => {
      const kept: Person = { ...recap, adminsOnly: true };
      const { onStartDirect, become, user } = showAgent(HAIKU, {}, kept);
      expect(await heading()).toHaveTextContent(/^Recap$/);
      expect(screen.getByText(adminsOnlyAsk("Recap"))).toBeVisible();
      expect(directButton("Recap")).toBeNull();

      become(administrator);
      await waitFor(() => expect(directButton("Recap")).toBeVisible());
      expect(screen.queryByText(adminsOnlyAsk("Recap"))).toBeNull();
      await user.click(directButton("Recap")!);
      expect(onStartDirect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: recap.id }));
    });

    it("has the DM button again once the directory says anyone can ask one that was kept for administrators", async () => {
      const kept: Person = { ...recap, adminsOnly: true };
      const { list } = showAgent(HAIKU, { people: new Map([[kept.id, kept]]) }, kept);
      expect(await screen.findByText(adminsOnlyAsk("Recap"))).toBeVisible();

      // The directory's entry leaves out that it's kept, which what the page was answered mustn't put back.
      list(new Map([[recap.id, recap]]));
      await waitFor(() => expect(directButton("Recap")).toBeVisible());
      expect(screen.queryByText(adminsOnlyAsk("Recap"))).toBeNull();
    });

    it("badges an agent the people directory lists, deleted ones too, with only their avatar, as a bot's page", async () => {
      const deleted = { ...recap, status: "deactivated" as const };
      serve(found(deleted));
      showPage(deleted, { people: new Map([[deleted.id, deleted]]) });
      expect(await avatar()).toBeVisible();
      expect(screen.getByText("Agent")).toHaveAttribute("data-slot", "badge");
      expect(screen.queryByRole("heading")).toBeNull();
      expect(screen.getByText("Recap is no longer on this account")).toBeVisible();
    });
  });

  it("shows only a deleted bot's avatar and that it's no longer on this account", async () => {
    serve(found({ ...bender, status: "deactivated" }));
    showPage(bender, { me: administrator });
    expect(await avatar()).toBeVisible();
    expect(screen.getByText("Bender is no longer on this account")).toBeVisible();
    expect(directButton("Bender")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("Private sign-in link", () => {
  const administrator: Me = { ...ada, administrator: true };
  const TRANSFER_ID = "u2.mgk3x2a9.signature";
  const withLink = (person: Person) => () => Response.json({ person, transferId: TRANSFER_ID } satisfies PersonAnswer);
  const signInLink = () => screen.queryByRole("textbox");

  it("shows administrators a sign-in link for someone, after the DM button, to get them back into their account", async () => {
    serve(withLink(grace));
    showPage(grace, { me: administrator });
    await heading();
    const link = screen.getByRole("textbox", { name: "Share to get them back into their account" });
    expect(link).toHaveValue(`http://localhost:3000/session/transfers#token=${TRANSFER_ID}`);
    expect(directButton("Grace Hopper")!.compareDocumentPosition(link)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("labels an administrator's own link for screen readers only", async () => {
    serve(withLink({ ...grace, id: ada.id, name: ada.name }));
    showPage(ada.id, { me: administrator });
    await heading();
    expect(screen.getByRole("textbox", { name: "Use this link to login automatically on another device" })).toBeVisible();
  });

  it("hides the link while they're banned, and as soon as you stop being an administrator", async () => {
    serve(withLink(grace));
    const { list, become } = showPage(grace, { me: administrator });
    await heading();
    expect(signInLink()).toBeInTheDocument();
    list(new Map([[grace.id, { ...grace, status: "banned" }]]));
    expect(signInLink()).toBeNull();
    list(new Map([[grace.id, grace]]));
    expect(signInLink()).toBeInTheDocument();

    // Even before the page has loaded them again.
    become(ada);
    expect(signInLink()).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(signInLink()).toBeNull();
  });

  it("shows none when the page isn't given one", async () => {
    serve(found(grace));
    showPage(grace, { me: administrator });
    await heading();
    expect(signInLink()).toBeNull();
  });
});

describe("Ban and unban people", () => {
  const administrator: Me = { ...ada, administrator: true };
  const banned: DirectoryUser = { ...grace, status: "banned", avatarUrl: "/users/t2/avatar?v=2" };
  const active: DirectoryUser = { ...grace, avatarUrl: "/users/t2/avatar?v=3" };
  const banButton = () => screen.queryByRole("button", { name: "Ban Grace Hopper" });
  const unbanButton = () => screen.queryByRole("button", { name: "Remove ban" });

  /** Answers the page's loads with `person` as each finds them, and a ban or its lifting with `changed` once the returned function is called. */
  function serveBans(person: () => Person, changed: () => Response | Promise<Response>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      init?.method === "POST" || init?.method === "DELETE" ? changed() : Response.json({ person: person() }),
    );
  }

  it("shows administrators Ban for someone else active, below the sign-in link, with a cancel mark", async () => {
    serve(() => Response.json({ person: grace, transferId: "u2.mgk3x2a9.signature" } satisfies PersonAnswer));
    showPage(grace, { me: administrator });
    await heading();
    const button = banButton()!;
    expect(button).toHaveClass("bg-background");
    expect(button.querySelector("svg")).toHaveClass("iconoir-prohibition");
    expect(screen.getByRole("textbox").compareDocumentPosition(button)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(unbanButton()).toBeNull();
  });

  it("shows administrators a red Remove ban for someone banned", async () => {
    serve(found(banned));
    showPage(grace, { me: administrator });
    await heading();
    expect(unbanButton()).toHaveClass("bg-negative-button", "text-white");
    expect(banButton()).toBeNull();
  });

  it("shows neither to members, on your own page, or for removed people and bots", async () => {
    serve(found(grace));
    const { become } = showPage(grace);
    await heading();
    expect(banButton()).toBeNull();
    become(administrator);
    expect(banButton()).toBeVisible();
    cleanup();

    for (const [person, me] of [
      [{ ...grace, id: ada.id, name: ada.name }, administrator],
      [{ ...grace, status: "deactivated" }, administrator],
      [bender, administrator],
      [{ ...bender, status: "banned" }, administrator],
    ] as const) {
      serve(found(person));
      showPage(person, { me });
      await avatar();
      expect(screen.queryByRole("button", { name: /\bban\b/i }), JSON.stringify(person)).toBeNull();
      cleanup();
    }
  });

  it("bans them once you've said you're sure, and loads the page again, with no notice", async () => {
    let stored: Person = grace;
    const fetch = serveBans(
      () => stored,
      () => {
        stored = banned;
        return Response.json({ user: banned });
      },
    );
    const sure = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    const { onPersonChanged, onFailed, user } = showPage(grace, { me: administrator, people: new Map([[grace.id, grace]]) });
    await heading();
    await user.click(banButton()!);
    expect(sure).toHaveBeenCalledExactlyOnceWith(CONFIRM_BAN);
    expect(fetch).toHaveBeenCalledOnce();

    sure.mockReturnValueOnce(true);
    await user.click(banButton()!);
    await waitFor(() => expect(onPersonChanged).toHaveBeenCalledExactlyOnceWith(banned));
    expect(fetch).toHaveBeenCalledWith("/api/users/u2/ban", expect.objectContaining({ method: "POST" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch).toHaveBeenLastCalledWith("/api/users/u2", expect.anything());
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("lifts a ban once you've said you're sure", async () => {
    const fetch = serveBans(
      () => banned,
      () => Response.json({ user: active }),
    );
    const sure = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onPersonChanged, user } = showPage(grace, { me: administrator });
    await heading();
    await user.click(unbanButton()!);
    expect(sure).toHaveBeenCalledExactlyOnceWith(CONFIRM_UNBAN);
    await waitFor(() => expect(onPersonChanged).toHaveBeenCalledExactlyOnceWith(active));
    expect(fetch).toHaveBeenCalledWith("/api/users/u2/ban", expect.objectContaining({ method: "DELETE" }));
  });

  it("waits for the answer before another click, and says why it failed", async () => {
    let fail = () => {};
    serveBans(
      () => grace,
      () => new Promise<Response>((resolve) => (fail = () => resolve(Response.json({ error: "They signed in from a private or internal IP address, which a ban can't block" }, { status: 422 })))),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onPersonChanged, onFailed, user } = showPage(grace, { me: administrator });
    await heading();
    const button = banButton()!;
    await user.click(button);
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    expect(window.confirm).toHaveBeenCalledOnce();

    await act(async () => fail());
    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(onFailed.mock.calls[0]![0]).toMatchObject({ status: 422, message: "They signed in from a private or internal IP address, which a ban can't block" });
    expect(onPersonChanged).not.toHaveBeenCalled();
    expect(button).not.toHaveAttribute("aria-disabled");
  });

  it("leaves out an answer older than what the directory has heard since, loading the directory again unless it agrees", async () => {
    let answer = (_: DirectoryUser) => {};
    serveBans(
      () => grace,
      () => new Promise<Response>((resolve) => (answer = (user) => resolve(Response.json({ user })))),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onPersonChanged, reloadPeople, list, user } = showPage(grace, { me: administrator, people: new Map([[grace.id, grace]]) });
    await heading();
    await user.click(banButton()!);
    // The workspace socket says she's banned before the answer does, from this ban.
    list(new Map([[grace.id, banned]]));
    await act(async () => answer(banned));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(onPersonChanged).not.toHaveBeenCalled();
    expect(reloadPeople).not.toHaveBeenCalled();

    // When it disagrees, as when another administrator banned her again once this lifted it, it can't
    // tell which is newer.
    await user.click(unbanButton()!);
    list(new Map([[grace.id, { ...banned, avatarUrl: "/users/t2/avatar?v=4" }]]));
    await act(async () => answer(active));
    await waitFor(() => expect(reloadPeople).toHaveBeenCalledOnce());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
    expect(onPersonChanged).not.toHaveBeenCalled();
  });

  it("loads the directory again for an answer that comes once the page has gone, which no longer hears what it has", async () => {
    let answer = (_: DirectoryUser) => {};
    serveBans(
      () => grace,
      () => new Promise<Response>((resolve) => (answer = (user) => resolve(Response.json({ user })))),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onPersonChanged, reloadPeople, user } = showPage(grace, { me: administrator, people: new Map([[grace.id, grace]]) });
    await heading();
    await user.click(banButton()!);
    // Gone before the answer, as when you open another page, while the directory may since have heard
    // she was banned and then let back in.
    cleanup();
    await act(async () => answer(banned));
    await waitFor(() => expect(reloadPeople).toHaveBeenCalledOnce());
    expect(onPersonChanged).not.toHaveBeenCalled();
  });
});

describe("Block and unblock people", () => {
  const blockButton = (name = grace.name) => screen.queryByRole("button", { name: `Block ${name}` });
  const unblockButton = (name = grace.name) => screen.queryByRole("button", { name: `Unblock ${name}` });

  it("offers Block for anyone else active, bots too, with a person with an x, and none on your own page or for removed people", async () => {
    serve(found(grace));
    showPage(grace);
    await heading();
    const button = blockButton()!;
    expect(button).toHaveClass("bg-background");
    expect(button.querySelector("svg")).toHaveClass("iconoir-user-xmark");
    // Below Ping.
    expect(directButton(grace.name)!.compareDocumentPosition(button)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    cleanup();

    serve(found(bender));
    showPage(bender);
    await avatar();
    expect(blockButton("Bender")).toBeVisible();
    cleanup();

    for (const person of [{ ...grace, id: ada.id, name: ada.name }, { ...grace, status: "deactivated" }, { ...bender, status: "deactivated" }] as const) {
      serve(found(person));
      showPage(person);
      await avatar();
      expect(screen.queryByRole("button", { name: /block/i }), JSON.stringify(person)).toBeNull();
      cleanup();
    }
  });

  it("blocks them, waiting for the answer before another click, then offers Unblock in place of Ping", async () => {
    serve(found(grace));
    let answer: (done: boolean) => void = () => {};
    const { setBlocked, block, user } = showPage(grace, { changedBlock: () => new Promise((resolve) => (answer = resolve)) });
    await heading();
    await user.click(blockButton()!);
    expect(blockButton()).toHaveAttribute("aria-disabled", "true");
    await user.click(blockButton()!);
    expect(setBlocked).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: grace.id, name: grace.name }), true);

    // The sidebar hears of the block as the answer comes.
    block([grace.id]);
    await act(async () => answer(true));
    expect(unblockButton()).not.toHaveAttribute("aria-disabled");
    expect(directButton(grace.name)).toBeNull();

    await user.click(unblockButton()!);
    expect(setBlocked).toHaveBeenLastCalledWith(expect.objectContaining({ id: grace.id }), false);
    block([]);
    await act(async () => answer(true));
    expect(directButton(grace.name)).toBeVisible();
    expect(blockButton()).toBeVisible();
  });

  it("offers Unblock for someone removed, or a bot, that you'd blocked, and no Ping for a bot you've blocked", async () => {
    serve(found({ ...grace, status: "deactivated" }));
    showPage(grace, { blocked: [grace.id] });
    await avatar();
    expect(unblockButton()).toBeVisible();
    cleanup();

    serve(found(bender));
    showPage(bender, { blocked: [bender.id] });
    await avatar();
    expect(unblockButton("Bender")).toBeVisible();
    expect(directButton("Bender")).toBeNull();
  });
});

describe("Report people", () => {
  const reportButton = (name = grace.name) => screen.queryByRole("button", { name: `Report ${name}` });

  it("offers Report for anyone else active, bots too, with a flag, below Block, and none on your own page or for removed people", async () => {
    serve(found(grace));
    showPage(grace);
    await heading();
    const button = reportButton()!;
    expect(button).toHaveClass("bg-background");
    expect(button.querySelector("svg")).toHaveClass("iconoir-triangle-flag");
    expect(screen.getByRole("button", { name: `Block ${grace.name}` }).compareDocumentPosition(button)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    cleanup();

    serve(found(bender));
    showPage(bender);
    await avatar();
    expect(reportButton("Bender")).toBeVisible();
    cleanup();

    for (const person of [{ ...grace, id: ada.id, name: ada.name }, { ...grace, status: "deactivated" }, { ...grace, status: "banned" }, { ...grace, status: "suspended" }] as const) {
      serve(found(person));
      showPage(person);
      await avatar();
      expect(screen.queryByRole("button", { name: /^Report/ }), JSON.stringify(person)).toBeNull();
      cleanup();
    }
  });

  it("opens Report for them, someone you've blocked too", async () => {
    serve(found(grace));
    const { openReport, user } = showPage(grace, { blocked: [grace.id] });
    await heading();
    await user.click(reportButton()!);
    expect(openReport).toHaveBeenCalledExactlyOnceWith({ kind: "person", person: expect.objectContaining({ id: grace.id, name: grace.name }) });
  });
});

describe("Memberful memberships", () => {
  const suspended: Person = { ...grace, status: "suspended" };

  it("shows members someone suspended for their membership's lapsing as no longer on this account", async () => {
    serve(found(suspended));
    showPage(grace);
    expect(await heading()).toHaveTextContent("Grace Hopper");
    expect(screen.getByText("Grace Hopper is no longer on this account")).toBeVisible();
    expect(screen.queryByText("Wrote the first compiler")).toBeNull();
    expect(screen.queryByText(/membership/)).toBeNull();
    expect(directButton("Grace Hopper")).toBeNull();
  });

  it("shows administrators who they are, that they can't sign in until their membership's renewed, and Ban, with no DM button", async () => {
    serve(found({ ...suspended, emailAddress: "grace@example.com" }));
    showPage(grace, { me: { ...ada, administrator: true } });
    expect(await heading()).toHaveTextContent("Grace Hopper");
    expect(screen.getByText("Wrote the first compiler")).toBeVisible();
    expect(mailLink()).toHaveAttribute("href", "mailto:grace@example.com");
    expect(screen.getByText("Grace Hopper’s Memberful membership has lapsed, so they can’t sign in until it’s renewed.")).toBeVisible();
    expect(screen.queryByText(/no longer on this account/)).toBeNull();
    expect(directButton("Grace Hopper")).toBeNull();
    expect(screen.getByRole("button", { name: "Ban Grace Hopper" })).toBeVisible();
  });
});
