import { DELETED_PERSON_NAME, type Card, type DirectoryUser, type User } from "@ember/protocol";
import { OPEN_REPORTS_LISTED, type HandledReports, type Report, type ReportedMessage, type ReportedPerson, type Reports } from "@ember/protocol/reports";
import { bodyFromPlainText } from "@ember/richtext/dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { ApiError } from "@/lib/api";
import { dateTimeLabel } from "@/lib/messages";
import { CONFIRM_REMOVE } from "./people-list";
import { CONFIRM_BAN } from "./person-page";
import { CONFIRM_DELETE, DELETED_WITH_ACCOUNT, ReportsList } from "./reports-list";

const listed = (user: User, changes: Partial<DirectoryUser> = {}): DirectoryUser => ({ ...user, bio: null, role: "member", status: "active", avatarUrl: `/users/${user.id}/avatar`, ...changes });
const directory = (...people: DirectoryUser[]): People => new Map(people.map((person) => [person.id, person]));
const ADA = listed({ id: "ada", name: "Ada Lovelace" }, { role: "administrator" });
const SAM = listed({ id: "sam", name: "Sam Rivera" }, { role: "administrator" });
const GRACE = listed({ id: "grace", name: "Grace Hopper" });
const LINUS = listed({ id: "linus", name: "Linus Torvalds" });
/** Kay, who was "Kay" when she was reported. */
const KAY = listed({ id: "kay", name: "Kay Smith" });
const HELPER = listed({ id: "helper", name: "Helper" }, { agent: true });
const JOAN = listed({ id: "joan", name: "Joan Clarke" }, { status: "deactivated" });
const MAL = listed({ id: "mal", name: "Mal Reynolds" }, { status: "banned" });
const PEOPLE = directory(ADA, SAM, GRACE, LINUS, KAY, HELPER, JOAN, MAL);

const REPORTED_AT = "2026-11-17T10:05:00.000Z";
const reportedMessage = (creator: User, changes: Partial<ReportedMessage> = {}): ReportedMessage => ({
  id: `message-of-${creator.id}`,
  creator,
  body: bodyFromPlainText("Buy my course"),
  plainText: "Buy my course",
  mentions: [],
  createdAt: "2026-11-17T10:00:00.000Z",
  editedAt: null,
  ...changes,
});
const ofMessage = (id: string, message: ReportedMessage, changes: Partial<Report> = {}, room: { kind: "open" | "direct"; name: string | null } = { kind: "open", name: "general" }): Report => ({
  id,
  reporterId: "linus",
  reason: "harassment",
  note: "",
  reportedAt: REPORTED_AT,
  subject: { kind: "message", roomId: "general", room, message },
  handled: null,
  ...changes,
});
const ofPerson = (id: string, person: ReportedPerson, changes: Partial<Report> = {}): Report => ({
  id,
  reporterId: "grace",
  reason: "spam",
  note: "",
  reportedAt: REPORTED_AT,
  subject: { kind: "person", person },
  handled: null,
  ...changes,
});
const handledAs = (report: Report, outcome: NonNullable<Report["handled"]>["outcome"], by = "ada", at = "2026-11-17T11:00:00.000Z"): Report => ({ ...report, handled: { by, at, outcome } });

const GRACES = ofMessage("r1", reportedMessage({ id: "grace", name: "Grace" }), { note: "Keeps posting this" });
const KAYS = ofPerson("r2", { id: "kay", name: "Kay", bio: "Buy followers" });
const CARDS: Card[] = [
  { source: "blocks", parts: [{ kind: "image", image: { url: "https://example.com/prize.png", alt: "A prize" } }] },
  {
    source: "blocks",
    parts: [{ kind: "buttons", buttons: [{ text: "Claim it", href: "https://example.com/claim" }, { text: "Not now", action: { id: "later" } }] }],
  },
];
const IN_A_DM = ofMessage("r3", reportedMessage(GRACE, { body: "", plainText: "", attachment: { name: "plan.pdf", contentType: "application/pdf", byteSize: 2048 }, cards: CARDS, editedAt: "2026-11-17T10:01:00.000Z" }), { reason: "spam", reporterId: "kay" }, { kind: "direct", name: null });

/** Answers `GET /api/reports` with `reports` and a report's handling as `handle` does. */
function serve(reports: Reports, handle: (id: string, outcome: string) => Promise<Response> = async () => Response.json({ reports: [] } satisfies HandledReports)) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === "/api/reports" && !init?.method) return Response.json(reports);
    const handled = /^\/api\/reports\/([^/]+)$/.exec(path);
    if (handled && init?.method === "POST") return handle(decodeURIComponent(handled[1]!), (JSON.parse(String(init.body)) as { outcome: string }).outcome);
    throw new Error(`Unexpected ${init?.method ?? "GET"} ${path}`);
  });
}
/** How many times the list was loaded. */
const loads = (fetched: ReturnType<typeof serve>) => fetched.mock.calls.filter(([input, init]) => String(input) === "/api/reports" && !init?.method).length;

interface Shown {
  shown?: boolean;
  open?: number;
  heard?: number;
  people?: People;
}

/** The Reports list, as Ada sees it in Membership. */
function show({ shown = true, open = 1, heard = 1, people = PEOPLE }: Shown = {}) {
  const onFailed = vi.fn();
  const list = (now: Shown) => (
    <PeopleContext value={now.people ?? people}>
      <ReportsList meId="ada" shown={now.shown ?? shown} open={now.open ?? open} heard={now.heard ?? heard} onFailed={onFailed} />
    </PeopleContext>
  );
  const { rerender } = render(list({}));
  return { onFailed, user: userEvent.setup(), rerender: (now: Shown) => rerender(list(now)) };
}

const section = () => screen.getByRole("region", { name: /^Reports/ });
const openReports = () => within(section()).queryByRole("list", { name: "Open reports" });
const reportOf = (name: string) => within(openReports()!).getByRole("listitem", { name: `Report of ${name}` });
/** A report's buttons, by their names. */
const buttonsOf = (report: HTMLElement) => within(report).getAllByRole("button").map((button) => button.textContent);
const handledReports = () => within(section()).getByRole("list", { name: "Handled reports", hidden: true });
const time = (iso: string) => dateTimeLabel(new Date(iso));

afterEach(() => vi.restoreAllMocks());

describe("Reports", () => {
  it("lists the open reports, each with what it reports as it was, who reported it, why and when", async () => {
    serve({ open: [GRACES, KAYS], handled: [] });
    show({ open: 2 });
    await waitFor(() => expect(openReports()).toBeInTheDocument());
    expect(within(section()).getByRole("heading", { name: "Reports 2 open" })).toBeInTheDocument();
    expect(within(openReports()!).getAllByRole("listitem").map((item) => item.getAttribute("aria-label"))).toEqual(["Report of Grace Hopper", "Report of Kay Smith"]);

    const graces = reportOf("Grace Hopper");
    expect(graces).toHaveTextContent(`HarassmentReported by Linus Torvalds, ${time(REPORTED_AT)}`);
    expect(graces).toHaveTextContent("“Keeps posting this”");
    // Whoever wrote it, by the name the directory has for them now, and where.
    expect(within(graces).getByRole("link", { name: "Grace Hopper" })).toHaveAttribute("href", "/users/grace");
    expect(graces).toHaveTextContent("Grace Hopper in general");
    expect(graces).toHaveTextContent(`Buy my courseWritten ${time("2026-11-17T10:00:00.000Z")}`);
    expect(graces).not.toHaveTextContent("edited");

    const kays = reportOf("Kay Smith");
    expect(kays).toHaveTextContent(`SpamReported by Grace Hopper, ${time(REPORTED_AT)}`);
    // As she was when she was reported, and as she's named now.
    expect(within(kays).getByRole("link", { name: "Kay" })).toHaveAttribute("href", "/users/kay");
    expect(kays).toHaveTextContent("Kay (now Kay Smith)");
    expect(kays).toHaveTextContent("Buy followers");
  });

  it("shows a direct message's report without naming it, with its file by name, a bot's cards, which can't act here, and that it was edited", async () => {
    serve({ open: [IN_A_DM, ofPerson("r4", { id: "grace", name: "Grace Hopper", bio: null })], handled: [] });
    show({ open: 2 });
    await waitFor(() => expect(openReports()).toBeInTheDocument());
    const [dm, person] = within(openReports()!).getAllByRole("listitem");
    expect(dm).toHaveTextContent("Grace Hopper in a direct message");
    expect(dm).toHaveTextContent("File: plan.pdf");
    expect(within(dm!).getByRole("img", { name: "A prize" })).toHaveAttribute("src", "https://example.com/prize.png");
    expect(within(dm!).getByRole("link", { name: "Claim it" })).toHaveAttribute("href", "https://example.com/claim");
    expect(within(dm!).getByRole("button", { name: "Not now" })).toBeDisabled();
    expect(dm).toHaveTextContent(`Written ${time("2026-11-17T10:00:00.000Z")}, edited before it was reported`);
    expect(person).toHaveTextContent("No bio");
    expect(person).not.toHaveTextContent("(now");
  });

  it("says so when no report is open", async () => {
    serve({ open: [], handled: [] });
    show({ open: 0 });
    expect(await within(section()).findByText("No open reports.")).toBeInTheDocument();
    expect(within(section()).getByRole("heading", { name: "Reports" })).toBeInTheDocument();
    expect(openReports()).not.toBeInTheDocument();
    expect(within(section()).queryByText(/^Handled/)).not.toBeInTheDocument();
  });

  it("loads only once Membership shows, and again whenever the count of open reports comes, changed or not", async () => {
    const fetched = serve({ open: [GRACES], handled: [] });
    const { rerender } = show({ shown: false });
    expect(section()).toHaveAttribute("aria-busy", "true");
    expect(loads(fetched)).toBe(0);
    rerender({ shown: true });
    await waitFor(() => expect(openReports()).toBeInTheDocument());
    expect(section()).not.toHaveAttribute("aria-busy");
    expect(loads(fetched)).toBe(1);
    rerender({ shown: true, open: 2, heard: 2 });
    await waitFor(() => expect(loads(fetched)).toBe(2));
    // As the sidebar loads again once the socket reconnects, though one report was made and another handled meanwhile.
    rerender({ shown: true, open: 2, heard: 3 });
    await waitFor(() => expect(loads(fetched)).toBe(3));
  });

  it("says how many are open past the newest the list holds, as the sidebar counts them", async () => {
    const newest = Array.from({ length: OPEN_REPORTS_LISTED }, (_, index) => ofPerson(`r${index}`, { id: "kay", name: "Kay", bio: null }));
    serve({ open: newest, handled: [] });
    const { rerender } = show({ open: OPEN_REPORTS_LISTED + 42 });
    await waitFor(() => expect(openReports()).toBeInTheDocument());
    expect(within(section()).getByRole("heading", { name: `Reports ${OPEN_REPORTS_LISTED + 42} open` })).toBeInTheDocument();
    expect(section()).toHaveTextContent(`Showing the newest ${OPEN_REPORTS_LISTED}. The rest come as these are handled.`);
    // Below that, the list's own count stands, though the sidebar's hasn't caught up.
    serve({ open: newest.slice(1), handled: [] });
    rerender({ open: OPEN_REPORTS_LISTED + 42, heard: 2 });
    await waitFor(() => expect(within(section()).getByRole("heading", { name: `Reports ${OPEN_REPORTS_LISTED - 1} open` })).toBeInTheDocument());
    expect(section()).not.toHaveTextContent("Showing the newest");
  });

  it("offers Delete message on a message's report alone, and Remove and Ban while whoever it reports can be", async () => {
    const helpers = ofMessage("r5", reportedMessage(HELPER));
    const joans = ofPerson("r6", JOAN);
    const mals = ofPerson("r7", MAL);
    serve({ open: [GRACES, KAYS, helpers, joans, mals], handled: [] });
    show({ open: 5 });
    await waitFor(() => expect(openReports()).toBeInTheDocument());
    expect(buttonsOf(reportOf("Grace Hopper"))).toEqual(["Delete message", "Remove Grace Hopper", "Ban Grace Hopper", "Dismiss"]);
    expect(buttonsOf(reportOf("Kay Smith"))).toEqual(["Remove Kay Smith", "Ban Kay Smith", "Dismiss"]);
    // An AI agent is neither removed nor banned, someone deactivated can still be banned, and someone banned is gone already.
    expect(buttonsOf(reportOf("Helper"))).toEqual(["Delete message", "Dismiss"]);
    expect(buttonsOf(reportOf("Joan Clarke"))).toEqual(["Ban Joan Clarke", "Dismiss"]);
    expect(buttonsOf(reportOf("Mal Reynolds"))).toEqual(["Dismiss"]);
  });

  it("names someone the directory no longer lists as Someone, with nothing to do of them but Dismiss", async () => {
    serve({ open: [ofPerson("r8", { id: "gone", name: "Gone Person", bio: null }, { reporterId: "gone-too" })], handled: [] });
    show();
    await waitFor(() => expect(openReports()).toBeInTheDocument());
    const report = reportOf("Someone");
    expect(report).toHaveTextContent("Reported by Someone");
    expect(report).toHaveTextContent("Gone Person");
    expect(buttonsOf(report)).toEqual(["Dismiss"]);
  });

  it("shows a report of someone who deleted their account without what it kept of them, with nothing to do but Dismiss", async () => {
    const deleted = { id: "gone", name: DELETED_PERSON_NAME };
    const ofTheirMessage = ofMessage("r9", reportedMessage(deleted, { body: "", plainText: "", accountDeleted: true }), { note: "Keeps posting this" });
    serve({ open: [ofTheirMessage, ofPerson("r10", { ...deleted, bio: null, accountDeleted: true })], handled: [] });
    show({ open: 2, people: directory(...PEOPLE.values(), listed(deleted, { status: "deactivated" })) });
    await waitFor(() => expect(openReports()).toBeInTheDocument());
    const [message, person] = within(openReports()!).getAllByRole("listitem");
    // Why it was reported, by whom, stays.
    expect(message).toHaveTextContent(`HarassmentReported by Linus Torvalds, ${time(REPORTED_AT)}“Keeps posting this”`);
    expect(message).toHaveTextContent(`${DELETED_PERSON_NAME} in general${DELETED_WITH_ACCOUNT.message}Written ${time("2026-11-17T10:00:00.000Z")}`);
    expect(buttonsOf(message!)).toEqual(["Dismiss"]);
    expect(person).toHaveTextContent(DELETED_WITH_ACCOUNT.person);
    expect(person).not.toHaveTextContent("No bio");
    expect(buttonsOf(person!)).toEqual(["Dismiss"]);
  });

  it("asks before deleting the message, and moves every report it closed to the handled ones", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const closed = [handledAs(GRACES, "deleted"), handledAs(ofMessage("r9", GRACES.subject.kind === "message" ? GRACES.subject.message : reportedMessage(GRACE), { reporterId: "kay" }), "deleted")];
    const fetched = serve({ open: [GRACES, KAYS], handled: [handledAs(IN_A_DM, "dismissed", "sam")] }, async () => Response.json({ reports: closed } satisfies HandledReports));
    const { user } = show({ open: 2 });
    await waitFor(() => expect(openReports()).toBeInTheDocument());

    await user.click(within(reportOf("Grace Hopper")).getByRole("button", { name: "Delete message" }));
    expect(confirm).toHaveBeenCalledExactlyOnceWith(CONFIRM_DELETE);
    expect(fetched).toHaveBeenCalledTimes(1);

    await user.click(within(reportOf("Grace Hopper")).getByRole("button", { name: "Delete message" }));
    expect(fetched).toHaveBeenCalledWith("/api/reports/r1", expect.objectContaining({ method: "POST", body: JSON.stringify({ outcome: "deleted" }) }));
    await waitFor(() => expect(within(openReports()!).getAllByRole("listitem")).toHaveLength(1));
    expect(within(openReports()!).getByRole("listitem")).toHaveAccessibleName("Report of Kay Smith");
    expect(within(section()).getByText("Handled (3)")).toBeInTheDocument();
    expect(within(handledReports()).getAllByRole("listitem", { hidden: true }).map((item) => item.firstElementChild!.textContent)).toEqual([
      `Message deleted by you, ${time("2026-11-17T11:00:00.000Z")}`,
      `Message deleted by you, ${time("2026-11-17T11:00:00.000Z")}`,
      `Dismissed by Sam Rivera, ${time("2026-11-17T11:00:00.000Z")}`,
    ]);
  });

  it("asks before removing or banning whoever it reports", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetched = serve({ open: [KAYS], handled: [] });
    const { user } = show();
    await waitFor(() => expect(openReports()).toBeInTheDocument());
    await user.click(within(reportOf("Kay Smith")).getByRole("button", { name: "Remove Kay Smith" }));
    expect(confirm).toHaveBeenLastCalledWith(CONFIRM_REMOVE);
    await user.click(within(reportOf("Kay Smith")).getByRole("button", { name: "Ban Kay Smith" }));
    expect(confirm).toHaveBeenLastCalledWith(CONFIRM_BAN);
    expect(fetched).toHaveBeenCalledTimes(1);

    confirm.mockReturnValue(true);
    await user.click(within(reportOf("Kay Smith")).getByRole("button", { name: "Ban Kay Smith" }));
    expect(fetched).toHaveBeenLastCalledWith("/api/reports/r2", expect.objectContaining({ method: "POST", body: JSON.stringify({ outcome: "banned" }) }));
  });

  it("dismisses one without asking, waiting on the server with its buttons", async () => {
    const confirm = vi.spyOn(window, "confirm");
    let answer = (_response: Response) => {};
    serve({ open: [GRACES, KAYS], handled: [] }, () => new Promise<Response>((resolve) => (answer = resolve)));
    const { user } = show({ open: 2 });
    await waitFor(() => expect(openReports()).toBeInTheDocument());
    await user.click(within(reportOf("Kay Smith")).getByRole("button", { name: "Dismiss" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(reportOf("Kay Smith")).toHaveAttribute("aria-busy", "true");
    for (const button of within(reportOf("Kay Smith")).getAllByRole("button")) expect(button).toBeDisabled();
    expect(within(reportOf("Grace Hopper")).getByRole("button", { name: "Dismiss" })).toBeEnabled();

    answer(Response.json({ reports: [handledAs(KAYS, "dismissed")] } satisfies HandledReports));
    await waitFor(() => expect(within(openReports()!).getAllByRole("listitem")).toHaveLength(1));
    expect(within(section()).getByText("Handled (1)")).toBeInTheDocument();
    expect(within(handledReports()).getByRole("listitem", { hidden: true })).toHaveTextContent(`Dismissed by you, ${time("2026-11-17T11:00:00.000Z")}`);
  });

  it("says when another administrator handled it first, and loads the list again", async () => {
    const fetched = serve({ open: [KAYS], handled: [] }, async () => Response.json({ error: "Another administrator has handled that report" }, { status: 409 }));
    const { onFailed, user } = show();
    await waitFor(() => expect(openReports()).toBeInTheDocument());
    await user.click(within(reportOf("Kay Smith")).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 409, message: "Another administrator has handled that report" })));
    await waitFor(() => expect(loads(fetched)).toBe(2));
  });

  it("says why it couldn't be handled, leaving it open to try another way", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetched = serve({ open: [KAYS], handled: [] }, async () => Response.json({ error: "They signed in from a private or internal IP address, which a ban can't block" }, { status: 422 }));
    const { onFailed, user } = show();
    await waitFor(() => expect(openReports()).toBeInTheDocument());
    await user.click(within(reportOf("Kay Smith")).getByRole("button", { name: "Ban Kay Smith" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledExactlyOnceWith(expect.any(ApiError)));
    expect(onFailed.mock.calls[0]![0]).toHaveProperty("status", 422);
    await waitFor(() => expect(within(reportOf("Kay Smith")).getByRole("button", { name: "Dismiss" })).toBeEnabled());
    expect(loads(fetched)).toBe(1);
  });

  it("hands a failure to load to the workspace's alerts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ error: "Not signed in" }, { status: 401 }));
    const { onFailed } = show();
    await waitFor(() => expect(onFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401 })));
    expect(section()).toHaveAttribute("aria-busy", "true");
  });
});
