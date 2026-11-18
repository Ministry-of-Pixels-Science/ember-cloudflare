import type { DirectoryUser, Message, User } from "@ember/protocol";
import { MAX_REPORT_NOTE_LENGTH } from "@ember/protocol/reports";
import { bodyFromPlainText } from "@ember/richtext/dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockingContext, type Blocking } from "@/hooks/use-blocking";
import { PeopleContext, type People } from "@/hooks/use-directory";
import type { ReportTarget } from "@/hooks/use-reporting";
import { administratorsNamed, blockOffer, GONE, NOT_REPORTED, REPORTED, ReportDialog } from "./report-dialog";

const ada: User = { id: "ada", name: "Ada Lovelace" };
// The message names Grace as she was when she wrote it, and the directory as she is now.
const grace: User = { id: "grace", name: "Grace" };
const listed = (user: User, changes: Partial<DirectoryUser> = {}): DirectoryUser => ({ ...user, bio: null, role: "member", status: "active", avatarUrl: `/users/${user.id}/avatar`, ...changes });
const directory = (...people: DirectoryUser[]): People => new Map(people.map((person) => [person.id, person]));
const SAM = listed({ id: "sam", name: "Sam Rivera" }, { role: "administrator" });
const PRIYA = listed({ id: "priya", name: "Priya Patel" }, { role: "administrator" });
/** An administrator who was deactivated, and so looks at no reports. */
const LEO = listed({ id: "leo", name: "Leo Okafor" }, { role: "administrator", status: "deactivated" });
const PEOPLE = directory(listed(ada), listed({ ...grace, name: "Grace Hopper" }), SAM, PRIYA, LEO);

const message: Message = {
  id: "m1",
  clientMessageId: "c1",
  roomId: "general",
  creator: grace,
  body: bodyFromPlainText("Buy my course"),
  plainText: "Buy my course",
  mentions: [],
  createdAt: "2026-11-17T10:00:00.000Z",
  updatedAt: "2026-11-17T10:00:00.000Z",
  editedAt: null,
  boosts: [],
};
const OF_MESSAGE: ReportTarget = { kind: "message", message };
const OF_GRACE: ReportTarget = { kind: "person", person: grace };

interface PageProps {
  target: ReportTarget;
  people: People;
  blocking: Blocking;
  returnFocus?: () => void;
  onClose: () => void;
  onFailed: (error: unknown) => void;
}

/** The button Report opens from, which has focus back once it closes unless `returnFocus` focuses something else. */
function Page({ target, people, blocking, returnFocus, onClose, onFailed }: PageProps) {
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const close = () => {
    onClose();
    setOpener(null);
  };
  return (
    <PeopleContext value={people}>
      <BlockingContext value={blocking}>
        <button type="button" onClick={(event) => setOpener(event.currentTarget)}>
          Open Report
        </button>
        <input aria-label="Message general" />
        {opener && <ReportDialog target={target} meId="ada" opener={opener} returnFocus={returnFocus} onClose={close} onFailed={onFailed} />}
      </BlockingContext>
    </PeopleContext>
  );
}

interface Options {
  people?: People;
  /** Who Ada has blocked. */
  blocked?: string[];
  /** Whether blocking succeeds. */
  blocks?: boolean;
  returnFocus?: () => void;
}

/** Report of `target`, opened by Ada from its button. */
async function openReport(target: ReportTarget = OF_MESSAGE, { people = PEOPLE, blocked = [], blocks = true, returnFocus }: Options = {}) {
  const setBlocked = vi.fn(async (_person: User, _blocked: boolean) => blocks);
  const [onClose, onFailed] = [vi.fn(), vi.fn()];
  const user = userEvent.setup();
  render(<Page target={target} people={people} blocking={{ blocked: new Set(blocked), setBlocked }} returnFocus={returnFocus} onClose={onClose} onFailed={onFailed} />);
  await user.click(opener());
  return { setBlocked, onClose, onFailed, user };
}

/** Answers every request with `answer`, or as it does once `answer` is a function. */
const serve = (answer: () => Promise<Response>) => vi.spyOn(globalThis, "fetch").mockImplementation(answer);
const reported = () => serve(async () => new Response(null, { status: 204 }));
const refusedWith = (status: number, error: string) => serve(async () => Response.json({ error }, { status }));

const opener = () => screen.getByRole("button", { name: "Open Report", hidden: true });
const dialog = () => screen.getByRole("dialog");
const reason = (name: string) => within(dialog()).getByRole("radio", { name });
const details = () => within(dialog()).getByRole("textbox", { name: "Details (optional)" });
const reportButton = () => within(dialog()).getByRole("button", { name: /^Report/ });
const alert = () => within(dialog()).queryByRole("alert");

/** Chooses `why`, with `note`, and sends the report. */
async function report(user: ReturnType<typeof userEvent.setup>, why = "Spam", note = "") {
  await user.click(reason(why));
  if (note) await user.type(details(), note);
  await user.click(reportButton());
}

afterEach(() => vi.restoreAllMocks());

describe("Report", () => {
  it("asks why someone's message is reported, naming them as the directory does now, with the first reason focused", async () => {
    await openReport();
    expect(screen.getByRole("dialog", { name: "Report message" })).toHaveAccessibleDescription("The administrators will see Grace Hopper’s message as it is now. Nobody is told who reported it.");
    expect(within(dialog()).getByRole("group", { name: "Why are you reporting it?" })).toBeInTheDocument();
    expect(within(dialog()).getAllByRole("radio").map((radio) => radio.closest("label")!.textContent)).toEqual(["Spam", "Harassment", "Something else"]);
    expect(reason("Spam")).toHaveFocus();
    expect(reason("Spam")).not.toBeChecked();
    expect(details()).toHaveAttribute("maxLength", String(MAX_REPORT_NOTE_LENGTH));
  });

  it("sends nothing until a reason is chosen", async () => {
    const fetched = reported();
    const { user } = await openReport();
    await user.type(details(), "Every day");
    await user.click(reportButton());
    expect(fetched).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Report message" })).toBeInTheDocument();
  });

  it("sends the reason and the few words, then says the administrators will look, naming them, and focuses Done", async () => {
    const fetched = reported();
    const { user } = await openReport();
    await report(user, "Harassment", "Keeps posting this");
    expect(fetched).toHaveBeenCalledExactlyOnceWith("/api/rooms/general/messages/m1/report", expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "harassment", note: "Keeps posting this" }) }));
    expect(await screen.findByRole("dialog", { name: "Reported" })).toHaveAccessibleDescription(REPORTED);
    expect(dialog()).toHaveTextContent("Sam Rivera and Priya Patel are this community’s administrators.");
    expect(dialog()).toHaveTextContent(blockOffer("Grace Hopper"));
    expect(within(dialog()).getByRole("button", { name: "Done" })).toHaveFocus();
  });

  it("reports someone for their name, picture or bio, asking why them", async () => {
    const fetched = reported();
    const { user } = await openReport(OF_GRACE);
    expect(screen.getByRole("dialog", { name: "Report Grace Hopper" })).toHaveAccessibleDescription("For their name, picture or bio. Nobody is told who reported them.");
    expect(within(dialog()).getByRole("group", { name: "Why are you reporting them?" })).toBeInTheDocument();
    await report(user, "Something else");
    expect(fetched).toHaveBeenCalledExactlyOnceWith("/api/users/grace/report", expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "other", note: "" }) }));
    expect(await screen.findByRole("dialog", { name: "Reported" })).toBeInTheDocument();
  });

  it("can't be sent again, or closed, while it's sending", async () => {
    let answer = (_response: Response) => {};
    const fetched = serve(() => new Promise<Response>((resolve) => (answer = resolve)));
    const { onClose, user } = await openReport();
    await report(user);
    expect(reportButton()).toHaveTextContent("Reporting…");
    expect(reportButton()).toBeDisabled();
    expect(within(dialog()).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(dialog()).getByRole("button", { name: "Close" })).toBeDisabled();
    expect(reason("Harassment")).toBeDisabled();
    expect(details()).toBeDisabled();
    expect(dialog()).toHaveAttribute("aria-busy", "true");
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    answer(new Response(null, { status: 204 }));
    expect(await screen.findByRole("dialog", { name: "Reported" })).not.toHaveAttribute("aria-busy");
    expect(fetched).toHaveBeenCalledOnce();
  });

  it("names an only administrator, leaving out you and anyone deactivated", async () => {
    expect(administratorsNamed([])).toBeNull();
    expect(administratorsNamed(["Sam Rivera"])).toBe("Sam Rivera is this community’s administrator.");
    expect(administratorsNamed(["Sam Rivera", "Priya Patel", "Leo Okafor"])).toBe("Sam Rivera, Priya Patel, and Leo Okafor are this community’s administrators.");

    reported();
    const { user } = await openReport(OF_MESSAGE, { people: directory(listed(ada, { role: "administrator" }), listed(grace), SAM, LEO) });
    await report(user);
    expect(await screen.findByRole("dialog", { name: "Reported" })).toHaveTextContent("Sam Rivera is this community’s administrator.");
  });

  it("names no administrators when Ada is the only one", async () => {
    reported();
    const { user } = await openReport(OF_MESSAGE, { people: directory(listed(ada, { role: "administrator" }), listed(grace), LEO) });
    await report(user);
    await screen.findByRole("dialog", { name: "Reported" });
    expect(dialog()).not.toHaveTextContent("administrator.");
    expect(dialog()).not.toHaveTextContent("administrators.");
  });

  it("blocks them too at a press, closing once they're blocked and giving focus back", async () => {
    reported();
    const { setBlocked, onClose, user } = await openReport();
    await report(user);
    const block = await screen.findByRole("button", { name: "Block Grace Hopper" });
    expect(block.querySelector("svg")).toHaveClass("iconoir-user-xmark");
    await user.click(block);
    expect(setBlocked).toHaveBeenCalledExactlyOnceWith(grace, true);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener()).toHaveFocus();
  });

  it("stays open when blocking them fails, for another try", async () => {
    reported();
    const { setBlocked, onClose, user } = await openReport(OF_MESSAGE, { blocks: false });
    await report(user);
    await user.click(await screen.findByRole("button", { name: "Block Grace Hopper" }));
    await waitFor(() => expect(within(dialog()).getByRole("button", { name: "Block Grace Hopper" })).toBeEnabled());
    expect(setBlocked).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers no Block for someone you've blocked already", async () => {
    reported();
    const { user } = await openReport(OF_MESSAGE, { blocked: ["grace"] });
    await report(user);
    await screen.findByRole("dialog", { name: "Reported" });
    expect(dialog()).not.toHaveTextContent("You can block");
    expect(within(dialog()).queryByRole("button", { name: /^Block/ })).not.toBeInTheDocument();
  });

  it("says why it wasn't sent, keeping the reason and the words for another try", async () => {
    const fetched = refusedWith(422, "Say why in 500 characters or fewer.");
    const { user } = await openReport();
    await report(user, "Harassment", "Again");
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("Say why in 500 characters or fewer.");
    expect(reason("Harassment")).toBeChecked();
    expect(details()).toHaveValue("Again");
    expect(reportButton()).toHaveTextContent("Report");
    expect(reportButton()).toBeEnabled();

    fetched.mockImplementation(async () => new Response(null, { status: 204 }));
    await user.click(reportButton());
    expect(await screen.findByRole("dialog", { name: "Reported" })).toBeInTheDocument();
  });

  it("says a message or someone is gone, and asks to try again when Ember failed", async () => {
    const fetched = refusedWith(404, "Not found");
    const { user } = await openReport();
    await report(user);
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(GONE.message);

    fetched.mockImplementation(async () => Response.json({ error: "Internal error" }, { status: 500 }));
    await user.click(reportButton());
    await waitFor(() => expect(alert()).toHaveTextContent(NOT_REPORTED));

    fetched.mockImplementation(async () => Promise.reject(new TypeError("Failed to fetch")));
    await user.click(reportButton());
    await waitFor(() => expect(reportButton()).toBeEnabled());
    expect(alert()).toHaveTextContent(NOT_REPORTED);
  });

  it("says someone reported is gone", async () => {
    refusedWith(404, "Not found");
    const { user } = await openReport(OF_GRACE);
    await report(user);
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(GONE.person);
  });

  it("hands a signed-out failure to the workspace", async () => {
    refusedWith(401, "Not signed in");
    const { onFailed, user } = await openReport();
    await report(user);
    await waitFor(() => expect(onFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401 })));
    expect(alert()).not.toBeInTheDocument();
  });

  it("closes with Cancel, Escape, its × or Done, giving focus back to what opened it", async () => {
    const fetched = reported();
    const { onClose, user } = await openReport();
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(opener()).toHaveFocus();

    await user.click(opener());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
    expect(opener()).toHaveFocus();

    await user.click(opener());
    await user.click(within(dialog()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(3));

    await user.click(opener());
    await report(user);
    await user.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(4));
    expect(opener()).toHaveFocus();
    expect(fetched).toHaveBeenCalledOnce();
  });

  it("focuses what returnFocus does once it closes, such as a message's composer", async () => {
    const returnFocus = vi.fn(() => screen.getByRole("textbox", { name: "Message general", hidden: true }).focus());
    const { onClose, user } = await openReport(OF_MESSAGE, { returnFocus });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(returnFocus).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Message general" })).toHaveFocus();
  });
});
