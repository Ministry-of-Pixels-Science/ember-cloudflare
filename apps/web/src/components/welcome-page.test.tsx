import { AVATAR_PATH, USERNAME_TAKEN, type Bootstrap, type Me, type Profile, type ProfileAnswer } from "@ember/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPage } from "@/lib/page";
import { returnPath } from "@/lib/return-path";
import { CHROME_MAC } from "@/test-platforms";
import { WelcomePage } from "./welcome-page";

vi.mock("@/lib/page", () => ({ loadPage: vi.fn() }));
vi.mock("@/lib/previews", () => ({ avatarVariantOf: vi.fn(async () => new Blob(["variant"], { type: "image/webp" })) }));

const katherine: Me = { id: "u2", name: "Katherine Johnson", administrator: false };
const workspace: Omit<Bootstrap, "user"> = {
  setup: "complete",
  setupAccess: "link",
  setupPlaceholders: { name: "Kevin Rose", emailAddress: "kevin@kevinrose.com" },
  guestSignIn: false,
  signInWithMemberful: true,
  signInWithSso: null,
  turnstileSiteKey: null,
  passwordResetCodes: false,
  account: { name: "Fernwood", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: false, openSignUp: false, memberfulJoin: true, memberfulSignIn: true, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true },
  version: "0.1",
  vapidPublicKey: null,
  platform: CHROME_MAC,
};

/** Katherine's profile as Memberful's sign-up left it: her initials, and a username made from her name. */
const INITIALS = "/users/t0k3n/avatar?v=1";
const profile: Profile = {
  name: "Katherine Johnson",
  username: "katherinejohnson",
  emailAddress: "katherine@example.com",
  bio: null,
  avatarUrl: INITIALS,
  avatar: false,
  password: false,
  membershipNeeded: true,
  memberful: { membersOnly: true, connected: { name: "Katherine Johnson", emailAddress: "katherine@example.com" } },
  sso: null,
  assistant: null,
  apps: [],
  outsideAi: null,
};
const answer = (profile: Profile) => Response.json({ profile, transferId: "u2.t" } satisfies ProfileAnswer);

/**
 * Answers the page's requests as `answers` has them, by method and path, or else as the server would,
 * saving what's changed to the profile it answers, keeping what each sent.
 */
function serve(answers: Record<string, (body: unknown) => Response | Promise<Response>> = {}) {
  const sent: Array<[string, unknown]> = [];
  let saved = profile;
  const defaults: Record<string, (body: unknown) => Response> = {
    "GET /api/users/me/profile": () => answer(saved),
    "PATCH /api/users/me/profile": (changes) => answer((saved = { ...saved, ...(changes as Pick<Profile, "name" | "username">) })),
    [`PUT ${AVATAR_PATH}`]: () => answer((saved = { ...saved, avatarUrl: "/users/t0k3n/avatar?v=2", avatar: true })),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body instanceof FormData ? "photo" : undefined;
    sent.push([request, body]);
    const respond = answers[request] ?? defaults[request];
    if (!respond) throw new Error(`Unexpected request for ${request}`);
    return respond(body);
  });
  return sent;
}

/** Opens the page at `address`, as the Memberful callback sends Katherine to it. */
function open(address = "/welcome?return_to=%2Frooms%2Fgeneral%3Ftab%3Dpins") {
  history.replaceState(null, "", address);
  const onWelcomed = vi.fn();
  render(<WelcomePage me={katherine} workspace={workspace} onWelcomed={onWelcomed} />);
  return { user: userEvent.setup(), onWelcomed };
}

const nameField = () => screen.getByLabelText("Name");
const usernameField = () => screen.getByLabelText("Username");
const photo = () => screen.getByRole("img", { name: "Your profile photo" });
const keepGoing = () => screen.getByRole("button", { name: "Continue" });

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:katherine");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(loadPage).mockClear();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

describe("The welcome page", () => {
  it("welcomes someone new to the workspace with their picture, name and username as their profile has them", async () => {
    serve();
    open();
    expect(screen.getByRole("heading", { level: 1, name: "Welcome to Fernwood" })).toBeVisible();
    expect(screen.getByText("Choose how people here see you.")).toBeVisible();
    expect(keepGoing()).toBeDisabled();
    await waitFor(() => expect(nameField()).toHaveValue("Katherine Johnson"));
    expect(usernameField()).toHaveValue("katherinejohnson");
    expect(usernameField()).toBeRequired();
    expect(screen.getByText("People find you by typing @ and your username.")).toBeVisible();
    expect(photo()).toHaveAttribute("src", INITIALS);
    expect(keepGoing()).toBeEnabled();
    expect(document.title).toContain("Welcome to Fernwood");
  });

  it("goes on without saving anything when nothing has changed", async () => {
    const sent = serve();
    const { user, onWelcomed } = open();
    await waitFor(() => expect(keepGoing()).toBeEnabled());
    await user.click(keepGoing());
    expect(onWelcomed).toHaveBeenCalledWith(katherine);
    expect(sent.map(([request]) => request)).toEqual(["GET /api/users/me/profile"]);
  });

  it("saves the name and username changed, keeping the username in lowercase without spaces or an @, then the photo chosen, and goes on with the new name", async () => {
    const sent = serve();
    const { user, onWelcomed } = open();
    await waitFor(() => expect(keepGoing()).toBeEnabled());
    await user.clear(nameField());
    await user.type(nameField(), "Katherine G. Johnson");
    await user.clear(usernameField());
    await user.type(usernameField(), "@Kat J");
    expect(usernameField()).toHaveValue("katj");
    await user.upload(screen.getByLabelText("Upload photo"), new File(["photo"], "katherine.png", { type: "image/png" }));
    expect(photo()).toHaveAttribute("src", "blob:katherine");

    await user.click(keepGoing());
    await waitFor(() => expect(onWelcomed).toHaveBeenCalledWith({ ...katherine, name: "Katherine G. Johnson" }));
    expect(sent.slice(1)).toEqual([
      ["PATCH /api/users/me/profile", { name: "Katherine G. Johnson", username: "katj" }],
      [`PUT ${AVATAR_PATH}`, "photo"],
    ]);
  });

  it("says why a username is refused, staying to pick another", async () => {
    serve({ "PATCH /api/users/me/profile": () => Response.json({ error: USERNAME_TAKEN }, { status: 422 }) });
    const { user, onWelcomed } = open();
    await waitFor(() => expect(keepGoing()).toBeEnabled());
    await user.clear(usernameField());
    await user.type(usernameField(), "kj");
    await user.click(keepGoing());
    expect(await screen.findByRole("alert")).toHaveTextContent(USERNAME_TAKEN);
    expect(onWelcomed).not.toHaveBeenCalled();
    expect(keepGoing()).toBeEnabled();
  });

  it("keeps the name and username as Continue sent them until it's done, so it goes on with what they show", async () => {
    let refuse = () => {};
    serve({
      "PATCH /api/users/me/profile": () => new Promise((resolve) => (refuse = () => resolve(Response.json({ error: USERNAME_TAKEN }, { status: 422 })))),
    });
    const { user, onWelcomed } = open();
    await waitFor(() => expect(keepGoing()).toBeEnabled());
    await user.type(usernameField(), "2");
    await user.click(keepGoing());
    await waitFor(() => expect(usernameField()).toHaveAttribute("readonly"));
    expect(nameField()).toHaveAttribute("readonly");
    await user.type(nameField(), " Jr.");
    await user.type(usernameField(), "3");
    expect(nameField()).toHaveValue("Katherine Johnson");
    expect(usernameField()).toHaveValue("katherinejohnson2");

    refuse();
    expect(await screen.findByRole("alert")).toHaveTextContent(USERNAME_TAKEN);
    expect(onWelcomed).not.toHaveBeenCalled();
    await user.type(usernameField(), "3");
    expect(usernameField()).toHaveValue("katherinejohnson23");
  });

  it("keeps what saved when the photo is refused, which goes, saying why, so Continue goes on without it", async () => {
    const sent = serve({ [`PUT ${AVATAR_PATH}`]: () => Response.json({ error: "That photo can't be read" }, { status: 415 }) });
    const { user, onWelcomed } = open();
    await waitFor(() => expect(keepGoing()).toBeEnabled());
    await user.type(usernameField(), "2");
    await user.upload(screen.getByLabelText("Upload photo"), new File(["photo"], "katherine.png", { type: "image/png" }));
    await user.click(keepGoing());
    expect(await screen.findByRole("alert")).toHaveTextContent("That photo can't be read");
    expect(photo()).toHaveAttribute("src", INITIALS);

    await user.click(keepGoing());
    await waitFor(() => expect(onWelcomed).toHaveBeenCalled());
    expect(sent.slice(1).map(([request]) => request)).toEqual(["PATCH /api/users/me/profile", `PUT ${AVATAR_PATH}`]);
  });

  it("goes to sign in once the session has ended, coming back here after", async () => {
    serve({ "GET /api/users/me/profile": () => Response.json({ error: "Not signed in" }, { status: 401 }) });
    open();
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/session/new"));
    expect(returnPath()).toBe("/welcome?return_to=%2Frooms%2Fgeneral%3Ftab%3Dpins");
  });
});
