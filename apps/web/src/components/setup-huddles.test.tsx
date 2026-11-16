import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_SECRET_UNKNOWN } from "@ember/protocol/huddles";
import { QUESTION, SetupHuddles } from "./setup-huddles";

/** A Realtime SFU app's keys, as an administrator copies them from Cloudflare's dashboard. */
const APP = { appId: "2a95132c15732412d22c1476fa83f27a", appSecret: "66bcf64aa8907b9f9d90ac17746a77ce394c393b92b3916633dc02846e608ad4" };
/** The Cloudflare account Ember is deployed to. */
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

type Answer = () => Response | Promise<Response>;

/** Answers as the server would to the administrator Ember was just set up by, or as `answers` say. */
function serve(answers: Record<string, Answer> = {}) {
  const served: Record<string, Answer> = {
    "GET /api/account": () => Response.json({ cloudflareAccountId: ACCOUNT_ID }),
    "PUT /api/account/huddles": () => Response.json({ huddles: { appId: APP.appId, relayKeyId: null } }),
    ...answers,
  };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const answer = served[`${init?.method ?? "GET"} ${String(input)}`];
    if (!answer) throw new Error(`Unexpected request for ${init?.method ?? "GET"} ${String(input)}`);
    return answer();
  });
}

/** What saving the keys sent, each time it was asked. */
const saved = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([input, init]) => `${init?.method} ${String(input)}` === "PUT /api/account/huddles")
    .map(([, init]) => JSON.parse(String(init!.body)));

/** A response the test lets through when it says, with `answer` letting it through. */
function held(response: () => Response) {
  let answer = () => {};
  const answered = new Promise<Response>((resolve) => (answer = () => resolve(response())));
  return { answered: () => answered, answer: () => act(async () => answer()) };
}

/** The question about huddles, as first run shows it once the workspace is made. */
function showQuestion() {
  const onOpen = vi.fn();
  render(<SetupHuddles onOpen={onOpen} />);
  return { onOpen, user: userEvent.setup() };
}

/** And Set up huddles, which it goes on to. */
async function showSteps() {
  const shown = showQuestion();
  await shown.user.click(button("Set up huddles"));
  return shown;
}

const title = (name: string) => screen.getByRole("heading", { level: 1, name });
const button = (name: string) => screen.getByRole("button", { name });
const appIdField = () => screen.getByRole("textbox", { name: "App ID" });
const appSecretField = () => screen.getByRole("textbox", { name: "App Secret" });
const dashboardButton = () => screen.getByRole("link", { name: "Open Cloudflare's dashboard" });

/** Types the app's keys and saves them. */
async function giveKeys(user: ReturnType<typeof userEvent.setup>) {
  await user.type(appIdField(), APP.appId);
  await user.type(appSecretField(), APP.appSecret);
  await user.click(button("Save and continue"));
}

afterEach(() => vi.restoreAllMocks());

describe("First run's question about huddles", () => {
  it("asks whether to enable audio and video chat, starting at the question, with what it is, needs and costs", () => {
    serve();
    showQuestion();
    expect(QUESTION).toBe("Would you like to enable audio and video chat?");
    expect(title(QUESTION)).toHaveFocus();
    const card = screen.getByRole("region", { name: QUESTION });
    expect(card).toHaveTextContent("Huddles let people in a room talk to each other live.");
    const facts = within(card)
      .getAllByRole("term")
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    expect(facts).toEqual([
      ["What it is", "Live audio and video chat in any room, for up to 50 people in a huddle."],
      ["What it needs", "A Realtime SFU app in your Cloudflare account. Creating one takes a couple of minutes."],
      ["What it costs", "Cloudflare gives a free monthly allowance, then bills your account for what's sent past it."],
    ]);
    expect(card).toHaveTextContent("You can also turn it on later, in Admin under Huddles.");
    expect(within(card).getAllByRole("button").map((answer) => answer.textContent?.trim())).toEqual(["Not now", "Set up huddles"]);
    expect(screen.getByRole("link", { name: "Skip to main content" })).toBeInTheDocument();
  });

  it("opens Ember from Not now, giving it nothing", async () => {
    serve();
    const { user, onOpen } = showQuestion();
    await user.click(button("Not now"));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(saved()).toEqual([]);
  });

  it("goes on to Set up huddles' two steps, whose button opens Cloudflare's dashboard at the account Ember is deployed to", async () => {
    serve();
    await showSteps();
    expect(title("Set up huddles")).toHaveFocus();
    expect(screen.getByRole("region", { name: "Set up huddles" })).toHaveTextContent("Two steps: one in Cloudflare, one here.");
    const [app, keys] = within(screen.getByRole("list", { name: "Steps to set up huddles" })).getAllByRole("listitem");
    // Each a heading under the page's own.
    expect(within(app!).getByRole("heading", { level: 2, name: "Create an SFU app in Cloudflare" })).toBeVisible();
    expect(within(keys!).getByRole("heading", { level: 2, name: "Copy the app's keys here" })).toBeVisible();
    await waitFor(() => expect(dashboardButton()).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/realtime/sfu`));
    expect(dashboardButton()).toHaveAttribute("target", "_blank");
    expect(appSecretField()).toHaveAccessibleDescription("Ember keeps it encrypted.");
    // Nothing to save until both keys are typed.
    expect(button("Save and continue")).toBeDisabled();
    expect(button("Back")).toBeEnabled();
  });

  it("has the dashboard ask which account where Ember can't say which it's deployed to", async () => {
    const fetch = serve({ "GET /api/account": () => Response.json({ error: "Not signed in" }, { status: 401 }) });
    await showSteps();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(dashboardButton()).toHaveAttribute("href", "https://dash.cloudflare.com/?to=/:account/realtime/sfu");
  });

  it("goes back to the question, and starts the steps over from there", async () => {
    serve();
    const { user, onOpen } = await showSteps();
    await user.type(appIdField(), APP.appId);
    await user.type(appSecretField(), APP.appSecret);
    await user.click(button("Back"));
    expect(title(QUESTION)).toHaveFocus();
    expect(onOpen).not.toHaveBeenCalled();

    await user.click(button("Set up huddles"));
    expect(appIdField()).toHaveValue("");
    expect(appSecretField()).toHaveValue("");
    expect(button("Save and continue")).toBeDisabled();
  });

  it("saves the keys once Cloudflare has started a session with them, says huddles are on, and opens Ember from there", async () => {
    const save = held(() => Response.json({ huddles: { appId: APP.appId, relayKeyId: null } }));
    serve({ "PUT /api/account/huddles": save.answered });
    const { user, onOpen } = await showSteps();
    await giveKeys(user);

    // Until Cloudflare answers, the steps wait as they are.
    expect(button("Checking…")).toBeDisabled();
    expect(button("Back")).toBeDisabled();
    expect(appIdField()).toBeDisabled();
    expect(appSecretField()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Asking Cloudflare to start a session with the app's keys…");
    expect(saved()).toEqual([APP]);

    await save.answer();
    expect(title("Huddles are on")).toHaveFocus();
    const card = screen.getByRole("region", { name: "Huddles are on" });
    expect(card).toHaveTextContent("Cloudflare accepted the app's keys.");
    expect(card).toHaveTextContent("Start a huddle with the headphones at the top of any room.");
    expect(card.querySelector("svg.iconoir-headset")).toBeInTheDocument();
    expect(card).toHaveTextContent("You can turn huddles off, or change the app, in Admin under Huddles.");
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(button("Open Ember"));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("says why Cloudflare refused a key on its field, and saves the right one from there", async () => {
    const answers: Answer[] = [() => Response.json({ error: APP_SECRET_UNKNOWN, field: "appSecret" }, { status: 422 })];
    serve({ "PUT /api/account/huddles": () => (answers.shift() ?? (() => Response.json({ huddles: { appId: APP.appId, relayKeyId: null } })))() });
    const { user } = await showSteps();
    await giveKeys(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(APP_SECRET_UNKNOWN);
    expect(appSecretField()).toHaveAccessibleDescription(APP_SECRET_UNKNOWN);
    expect(appSecretField()).toHaveAttribute("aria-invalid", "true");
    expect(title("Set up huddles")).toBeInTheDocument();
    expect(appIdField()).toHaveValue(APP.appId);

    await user.click(button("Save and continue"));
    expect(await screen.findByRole("heading", { level: 1, name: "Huddles are on" })).toBeInTheDocument();
  });

  it("says so above the card when Ember can't be reached, and lets the keys be saved again", async () => {
    const answers: Answer[] = [() => Promise.reject(new TypeError("Failed to fetch"))];
    serve({ "PUT /api/account/huddles": () => (answers.shift() ?? (() => Response.json({ huddles: { appId: APP.appId, relayKeyId: null } })))() });
    const { user, onOpen } = await showSteps();
    await giveKeys(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't reach Ember. Check your connection and try again.");
    expect(screen.getByRole("region", { name: "Set up huddles" })).not.toContainElement(alert);
    expect(appIdField()).toHaveValue(APP.appId);
    expect(appSecretField()).toHaveValue(APP.appSecret);
    expect(onOpen).not.toHaveBeenCalled();

    await user.click(button("Save and continue"));
    expect(await screen.findByRole("heading", { level: 1, name: "Huddles are on" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says why the server wouldn't save them, when it isn't the keys' doing", async () => {
    serve({ "PUT /api/account/huddles": () => Response.json({ error: "Only administrators can set up huddles" }, { status: 403 }) });
    const { user } = await showSteps();
    await giveKeys(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Only administrators can set up huddles");
    expect(button("Save and continue")).toBeEnabled();
  });

  it("opens Ember, which asks them to sign in, for someone signed out since the workspace was made", async () => {
    serve({ "PUT /api/account/huddles": () => Response.json({ error: "Not signed in" }, { status: 401 }) });
    const { user, onOpen } = await showSteps();
    await giveKeys(user);
    await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
