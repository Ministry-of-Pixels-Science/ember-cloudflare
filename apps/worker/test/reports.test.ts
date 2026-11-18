import type { Message, RoomId, Sidebar, UserId } from "@ember/protocol";
import {
  MAX_REPORT_NOTE_LENGTH,
  REPORT_NOTE_REFUSED,
  REPORT_REASON_REFUSED,
  REPORTS_PATH,
  type HandledReports,
  type Report,
  type ReportOutcome,
  type Reports,
} from "@ember/protocol/reports";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSE_MESSAGE_REPORTS,
  CLOSE_PERSON_REPORTS,
  HANDLED_REPORTS,
  KEEP_MESSAGE_REPORT,
  KEEP_PERSON_REPORT,
  OPEN_REPORTS,
  OPEN_REPORTS_BY_ADMINISTRATOR,
  REPORT_PUSHES,
} from "../src/reports/store";
import { OPEN_REPORTS_OF_ADMINISTRATOR } from "../src/workspace-store";
import { api, connect, createRoom, direct, freshDeploy, openWorkspaceSocket, post, pushBrowser, roomSql, signIn, workspaceSql, type PushBrowser, type Session, type WorkspaceSocket } from "./support";

// Report a message, in its More actions, or someone, on their page, which Apple asks of every app where
// people post: the workspace's administrators hear of it, see what was reported as it was then, and delete
// the message, remove or ban whoever it's of, or dismiss it. Nobody else hears of it, and an administrator
// is never shown a report of themselves, so the person reported never learns who reported them.

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Signs in as each of `names`, in turn. */
async function people<Names extends string[]>(...names: Names): Promise<{ [K in keyof Names]: Session }> {
  const sessions: Session[] = [];
  for (const name of names) sessions.push(await signIn(name));
  return sessions as { [K in keyof Names]: Session };
}

/** Makes each of `sessions`' people one of the workspace's administrators. */
async function administrators(...sessions: Session[]): Promise<void> {
  for (const { user } of sessions) await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", user.id);
}

const SPAM = { reason: "spam", note: "" };

/** Has `session`'s person report message `messageId` in room `roomId`, as Report message does. */
const reportMessage = (session: Session, roomId: RoomId, messageId: string, report: unknown = SPAM) =>
  api(`/api/rooms/${roomId}/messages/${encodeURIComponent(messageId)}/report`, { method: "POST", headers: { Cookie: session.cookie }, body: JSON.stringify(report) });

/** Has `session`'s person report whoever has `userId`, as Report on their page does. */
const reportPerson = (session: Session, userId: UserId, report: unknown = SPAM) =>
  api(`/api/users/${encodeURIComponent(userId)}/report`, { method: "POST", headers: { Cookie: session.cookie }, body: JSON.stringify(report) });

/** Expects a report to have been taken. */
async function reported(response: Promise<Response>): Promise<void> {
  const settled = await response;
  expect(settled.status, await settled.clone().text()).toBe(204);
}

/** The reports `session`'s person sees. */
async function reportsFor(session: Session): Promise<Reports> {
  const response = await api("/api/reports", { headers: { Cookie: session.cookie } });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return (await response.json()) as Reports;
}

/** Has `session`'s person handle report `reportId` as `outcome` says. */
const handle = (session: Session, reportId: string, outcome: unknown) =>
  api(`/api/reports/${encodeURIComponent(reportId)}`, { method: "POST", headers: { Cookie: session.cookie }, body: JSON.stringify({ outcome }) });

/** The reports handling one closed, by id. */
async function closedBy(response: Promise<Response>): Promise<Report[]> {
  const settled = await response;
  expect(settled.status, await settled.clone().text()).toBe(200);
  return ((await settled.json()) as HandledReports).reports.toSorted((a, b) => a.id.localeCompare(b.id));
}

/** Expects `response` to have refused, saying `error`. */
async function refused(response: Promise<Response>, status: number, error: string): Promise<void> {
  const settled = await response;
  expect(settled.status).toBe(status);
  expect(await settled.json()).toEqual({ error });
}

/** `report` as it is once `by` handles it, with `outcome`. */
const handledAs = (report: Report, by: Session, outcome: ReportOutcome): Report => ({ ...report, handled: { by: by.user.id, at: expect.stringMatching(ISO_TIME) as string, outcome } });

const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/** Has `session`'s person write `body` in room `roomId`, answering the message. */
async function written(session: Session, roomId: RoomId, body: string): Promise<Message> {
  const client = await connect(roomId, session);
  const message = await post(client, body);
  client.close();
  return message;
}

/** The sidebar `session`'s person gets. */
const sidebarOf = async (session: Session) => (await (await api("/api/sidebar", { headers: { Cookie: session.cookie } })).json()) as Sidebar;

/** The next count of open reports `tab` hears, past whatever else it hears first. */
async function nextOpenReports(tab: WorkspaceSocket): Promise<number> {
  for (;;) {
    const frame = await tab.next();
    if (frame.type === "reports.changed") return frame.open;
  }
}

/** Expects `tab` to have heard no count of open reports by the time the Workspace answers a ping sent now. */
async function heardNoCount(tab: WorkspaceSocket): Promise<void> {
  tab.send(JSON.stringify({ type: "ping", nonce: crypto.randomUUID() }));
  for (;;) {
    const frame = await tab.next();
    expect(frame.type, JSON.stringify(frame)).not.toBe("reports.changed");
    if (frame.type === "pong") return;
  }
}

/** Moves the clock a second on, so whatever happens next happens later. */
const aSecondLater = () => vi.setSystemTime(Date.now() + 1000);

/** Chrome's push service, where `subscribe` saves each subscription. */
const PUSH_SERVICE = "https://fcm.googleapis.com/fcm/send/";

/** Saves a subscription for `session` at Chrome's push service, at `/fcm/send/<label>`, for `browser`'s keys. */
async function subscribe(session: Session, label: string, browser?: PushBrowser): Promise<void> {
  const { p256dh, auth } = browser ?? (await pushBrowser());
  const response = await api("/api/push-subscriptions", { method: "POST", headers: { Cookie: session.cookie }, body: JSON.stringify({ endpoint: `${PUSH_SERVICE}${label}`, p256dhKey: p256dh, authKey: auth }) });
  expect(response.status, await response.clone().text()).toBe(204);
}

/** Stands in for every push service, answering each push with `status`, and keeps what was pushed where, in the order it came. */
function pushServices(status: (endpoint: string) => number = () => 201) {
  const pushed: Array<{ label: string; body: Uint8Array }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const endpoint = input instanceof Request ? input.url : String(input);
    pushed.push({ label: endpoint.slice(PUSH_SERVICE.length), body: init!.body as Uint8Array });
    return new Response(null, { status: status(endpoint) });
  });
  return pushed;
}

/** How many of the rooms `session`'s person is in are marked unread for them. */
const unreadFor = async (session: Session) =>
  ((await workspaceSql("SELECT count(*) AS n FROM memberships WHERE user_id = ? AND unread_at IS NOT NULL", session.user.id)) as [{ n: number }])[0].n;

describe("Report a message", () => {
  it("keeps someone else's message as it was when reported, with whose it is, where, who reported it, why and when, for the administrators", async () => {
    const [ada, grace, linus] = await people("Ada", "Grace", "Linus");
    await administrators(ada);
    const general = await createRoom("general");
    const graces = await connect(general.id, grace);
    const message = await post(graces, "Cheap watches, today only");

    await reported(reportMessage(linus, general.id, message.id, { reason: "spam", note: "  The third time today  " }));
    // Whatever becomes of it after, the report shows it as it was.
    graces.send({ type: "message.update", messageId: message.id, body: "Nothing to see" });
    await graces.next("message.updated");
    graces.send({ type: "message.delete", messageId: message.id });
    await graces.next("message.deleted");

    expect(await reportsFor(ada)).toEqual({
      open: [
        {
          id: expect.any(String),
          reporterId: linus.user.id,
          reason: "spam",
          note: "The third time today",
          reportedAt: expect.stringMatching(ISO_TIME),
          subject: {
            kind: "message",
            roomId: general.id,
            room: { kind: "open", name: "general" },
            message: { id: message.id, creator: { id: grace.user.id, name: "Grace" }, body: message.body, plainText: "Cheap watches, today only", mentions: [], createdAt: message.createdAt, editedAt: null },
          },
          handled: null,
        },
      ],
      handled: [],
    });
    // Nobody else sees reports.
    await refused(api("/api/reports", { headers: { Cookie: linus.cookie } }), 403, "Only administrators can see reports");
    expect((await api("/api/reports")).status).toBe(401);
  });

  it("keeps a reply's thread, and names no DM a message is reported in, nor keeps anything else of it", async () => {
    const [ada, grace, linus] = await people("Ada", "Grace", "Linus");
    await administrators(ada);
    const dm = await direct(grace, linus);
    const graces = await connect(dm.id, grace);
    const first = await post(graces, "Our first chat");
    graces.send({ type: "message.create", clientMessageId: crypto.randomUUID(), body: "You'll regret it", parentId: first.id });
    const { message: reply } = await graces.next("message.created");

    await reported(reportMessage(linus, dm.id, reply.id, { reason: "harassment" }));
    const [report] = (await reportsFor(ada)).open;
    expect(report!.subject).toEqual({ kind: "message", roomId: dm.id, room: { kind: "direct", name: null }, message: expect.objectContaining({ id: reply.id, plainText: "You'll regret it", parentId: first.id }) });
    expect(report!.note).toBe("");
    expect(JSON.stringify(await workspaceSql("SELECT * FROM reports"))).not.toContain("Our first chat");
  });

  it("refuses a report of your own message, of one deleted, never written, or in a room you aren't in, and one without a reason or with too many words", async () => {
    const [ada, grace, linus] = await people("Ada", "Grace", "Linus");
    await administrators(ada);
    const general = await createRoom("general");
    const secret = await createRoom("secret", { closedTo: [grace.user.id] });
    const graces = await connect(general.id, grace);
    const message = await post(graces, "Hello");
    const gone = await post(graces, "Oops");
    graces.send({ type: "message.delete", messageId: gone.id });
    await graces.next("message.deleted");
    const hidden = await written(grace, secret.id, "Just us");

    await refused(reportMessage(grace, general.id, message.id), 422, "You can't report your own message");
    for (const [roomId, messageId] of [[general.id, gone.id], [general.id, "nothing"], [secret.id, hidden.id], ["not-a-room", message.id]]) {
      expect((await reportMessage(linus, roomId!, messageId!)).status, `${roomId} ${messageId}`).toBe(404);
    }
    for (const [report, error] of [
      [{}, REPORT_REASON_REFUSED],
      [{ reason: "boring" }, REPORT_REASON_REFUSED],
      [{ reason: "spam", note: 5 }, REPORT_NOTE_REFUSED],
      [{ reason: "spam", note: "é".repeat(MAX_REPORT_NOTE_LENGTH + 1) }, REPORT_NOTE_REFUSED],
    ] as const) {
      await refused(reportMessage(linus, general.id, message.id, report), 422, error);
    }
    expect((await api(`/api/rooms/${general.id}/messages/${message.id}/report`, { method: "POST", body: JSON.stringify(SPAM) })).status).toBe(401);
    // The longest note is taken.
    await reported(reportMessage(linus, general.id, message.id, { reason: "other", note: "é".repeat(MAX_REPORT_NOTE_LENGTH) }));
    expect(await workspaceSql("SELECT reporter_id, reason FROM reports")).toEqual([{ reporter_id: linus.user.id, reason: "other" }]);
  });

  it("keeps one report of a message, or of someone, from each person while it's open, and a new one once it's handled", async () => {
    const [ada, grace, linus, joan] = await people("Ada", "Grace", "Linus", "Joan");
    await administrators(ada);
    const general = await createRoom("general");
    const message = await written(grace, general.id, "Cheap watches");

    await reported(reportMessage(linus, general.id, message.id, { reason: "spam" }));
    await reported(reportMessage(linus, general.id, message.id, { reason: "harassment", note: "Again" }));
    await reported(reportMessage(joan, general.id, message.id, { reason: "other", note: "Odd" }));
    await reported(reportPerson(linus, grace.user.id, { reason: "spam" }));
    await reported(reportPerson(linus, grace.user.id, { reason: "harassment" }));
    const { open } = await reportsFor(ada);
    expect(open.map(({ reporterId, reason, subject }) => [reporterId, reason, subject.kind])).toEqual([
      [linus.user.id, "spam", "person"],
      [joan.user.id, "other", "message"],
      [linus.user.id, "spam", "message"],
    ]);

    await closedBy(handle(ada, open[2]!.id, "dismissed"));
    await reported(reportMessage(linus, general.id, message.id, { reason: "harassment" }));
    expect((await reportsFor(ada)).open.map(({ reporterId, reason }) => [reporterId, reason])).toEqual([
      [linus.user.id, "harassment"],
      [linus.user.id, "spam"],
      [joan.user.id, "other"],
    ]);
  });
});

describe("Report someone", () => {
  it("keeps their name and bio as they were when reported, but not of yourself, of nobody, or of an agent you aren't told of", async () => {
    const [ada, grace, linus, agent] = await people("Ada", "Grace", "Linus", "Agent");
    await administrators(ada);
    await workspaceSql("UPDATE users SET bio = ? WHERE id = ?", "Buy my course", grace.user.id);

    await reported(reportPerson(linus, grace.user.id, { reason: "spam", note: "Her bio" }));
    await workspaceSql("UPDATE users SET name = 'Grace H', bio = NULL WHERE id = ?", grace.user.id);
    expect((await reportsFor(ada)).open).toEqual([
      {
        id: expect.any(String),
        reporterId: linus.user.id,
        reason: "spam",
        note: "Her bio",
        reportedAt: expect.stringMatching(ISO_TIME),
        subject: { kind: "person", person: { id: grace.user.id, name: "Grace", bio: "Buy my course" } },
        handled: null,
      },
    ]);

    await refused(reportPerson(linus, linus.user.id), 422, "You can't report yourself");
    expect((await reportPerson(linus, "nobody")).status).toBe(404);
    // An AI agent kept for administrators' direct messages is nobody to anyone else.
    await workspaceSql("UPDATE users SET role = 2, agent_access = 'admin-dms' WHERE id = ?", agent.user.id);
    expect((await reportPerson(linus, agent.user.id)).status).toBe(404);
    await refused(reportPerson(linus, grace.user.id, { reason: "rude" }), 422, REPORT_REASON_REFUSED);
    expect((await api(`/api/users/${grace.user.id}/report`, { method: "POST", body: JSON.stringify(SPAM) })).status).toBe(401);
    expect(await workspaceSql("SELECT count(*) AS n FROM reports")).toEqual([{ n: 1 }]);
  });
});

describe("Who hears of a report", () => {
  it("tells every tab of each active administrator how many reports are open, leaving out the reports of them, and nobody else", async () => {
    const [ada, ed, grace, linus] = await people("Ada", "Ed", "Grace", "Linus");
    await administrators(ada, ed);
    const general = await createRoom("general");
    const gracesMessage = await written(grace, general.id, "Cheap watches");
    const edsMessage = await written(ed, general.id, "Read the rules");
    const tabs = { ada: await openWorkspaceSocket(ada), adasOther: await openWorkspaceSocket(ada), ed: await openWorkspaceSocket(ed), grace: await openWorkspaceSocket(grace), linus: await openWorkspaceSocket(linus) };

    await reported(reportMessage(linus, general.id, gracesMessage.id));
    for (const tab of [tabs.ada, tabs.adasOther, tabs.ed]) expect(await nextOpenReports(tab)).toBe(1);
    await reported(reportMessage(linus, general.id, edsMessage.id));
    for (const tab of [tabs.ada, tabs.adasOther]) expect(await nextOpenReports(tab)).toBe(2);
    for (const tab of [tabs.ed, tabs.grace, tabs.linus]) await heardNoCount(tab);

    // The sidebar counts them too, for administrators alone.
    expect((await sidebarOf(ada)).openReports).toBe(2);
    expect((await sidebarOf(ed)).openReports).toBe(1);
    expect(await sidebarOf(grace)).not.toHaveProperty("openReports");
    // Nobody hears of a report kept already.
    await reported(reportMessage(linus, general.id, gracesMessage.id));
    for (const tab of [tabs.ada, tabs.ed]) await heardNoCount(tab);
  });

  it("pushes a report to every active administrator but whoever made it, whoever it's of and anyone who blocked whoever made it, opening the Reports list", async () => {
    const pushed = pushServices();
    const [ada, ed, kay, linus, grace] = await people("Ada", "Ed", "Kay", "Linus", "Grace");
    await administrators(ada, ed, kay, linus);
    const general = await createRoom("general");
    const inGeneral = await written(grace, general.id, "Cheap watches");
    const dm = await direct(grace, linus);
    const inDm = await written(grace, dm.id, "Buy now");
    expect((await api(`/api/users/${linus.user.id}/block`, { method: "POST", headers: { Cookie: ed.cookie } })).status).toBe(200);
    const browsers: Record<string, PushBrowser> = { ada: await pushBrowser(), ed: await pushBrowser(), kay: await pushBrowser(), linus: await pushBrowser() };
    for (const [label, session] of [["ada", ada], ["ed", ed], ["kay", kay], ["linus", linus]] as const) await subscribe(session, label, browsers[label]);
    // Grace's message in general is marked unread for each of them, as their badge counts.
    await vi.waitFor(async () => expect(await unreadFor(kay)).toBe(1));
    const badge = await unreadFor(ada);
    /** The reports pushed so far, where, as each browser reads it. Linus may be pushed Grace's DM too. */
    const reportsPushed = async () =>
      (await Promise.all(pushed.map(async ({ label, body }) => ({ label, push: JSON.parse(await browsers[label]!.open(body)) as { title: string; options: { body: string } } })))).filter(
        ({ push }) => push.title === "New report",
      );

    await reported(reportMessage(linus, general.id, inGeneral.id, { reason: "harassment" }));
    await vi.waitFor(async () => expect((await reportsPushed()).map(({ label }) => label)).toEqual(["ada", "kay"]));
    for (const { label, push } of await reportsPushed()) {
      expect(push).toEqual({
        title: "New report",
        options: { body: "Linus reported Grace's message in general for harassment", icon: "/account/logo", data: { path: REPORTS_PATH, badge: label === "ada" ? badge : 1 } },
      });
    }

    pushed.length = 0;
    await reported(reportMessage(linus, dm.id, inDm.id, { reason: "spam" }));
    await reported(reportPerson(linus, kay.user.id, { reason: "other", note: "Her picture" }));
    await vi.waitFor(async () => expect((await reportsPushed()).map(({ label }) => label)).toEqual(["ada", "kay", "ada"]));
    expect((await reportsPushed()).map(({ push }) => push.options.body)).toEqual([
      "Linus reported Grace's message in a direct message as spam",
      "Linus reported Grace's message in a direct message as spam",
      "Linus reported Kay",
    ]);
  });

  it("forgets a subscription its push service says is gone, failing nothing for whoever reported", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const pushed = pushServices((endpoint) => (endpoint.endsWith("/gone") ? 410 : 201));
    const [ada, grace, linus] = await people("Ada", "Grace", "Linus");
    await administrators(ada);
    await subscribe(ada, "gone");
    await subscribe(ada, "kept");
    const [{ id }] = (await workspaceSql("SELECT id FROM push_subscriptions WHERE endpoint = ?", `${PUSH_SERVICE}gone`)) as [{ id: number }];

    await reported(reportPerson(linus, grace.user.id));
    await vi.waitFor(async () => expect(await workspaceSql("SELECT endpoint FROM push_subscriptions")).toEqual([{ endpoint: `${PUSH_SERVICE}kept` }]));
    expect(pushed.map(({ label }) => label)).toEqual(["gone", "kept"]);
    expect(logs).toHaveBeenCalledWith(`Destroying push subscription: ${id}`);
  });
});

describe("The Reports list", () => {
  it("lists the open reports newest first and the handled ones last handled first, but none of whoever reads it", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const [ada, ed, grace, linus] = await people("Ada", "Ed", "Grace", "Linus");
    await administrators(ada, ed);
    for (const [by, of] of [[linus, grace], [grace, linus], [linus, ed], [grace, ada]] as const) {
      await reported(reportPerson(by, of.user.id));
      aSecondLater();
    }
    const ofWhom = ({ open, handled }: Reports) => [open, handled].map((reports) => reports.map(({ subject }) => (subject.kind === "person" ? subject.person.name : null)));

    expect(ofWhom(await reportsFor(ada))).toEqual([["Ed", "Linus", "Grace"], []]);
    expect(ofWhom(await reportsFor(ed))).toEqual([["Ada", "Linus", "Grace"], []]);

    const [, ofLinus, ofGrace] = (await reportsFor(ada)).open;
    await closedBy(handle(ada, ofGrace!.id, "dismissed"));
    aSecondLater();
    await closedBy(handle(ada, ofLinus!.id, "dismissed"));
    aSecondLater();
    const [ofAda] = (await reportsFor(ed)).open;
    await closedBy(handle(ed, ofAda!.id, "dismissed"));

    expect(ofWhom(await reportsFor(ada))).toEqual([["Ed"], ["Linus", "Grace"]]);
    expect(ofWhom(await reportsFor(ed))).toEqual([[], ["Ada", "Linus", "Grace"]]);
  });
});

describe("Handling a report", () => {
  it("dismisses a report alone, marking it done by whoever handled it, and tells every administrator how many are left open", async () => {
    const [ada, ed, grace, linus, joan] = await people("Ada", "Ed", "Grace", "Linus", "Joan");
    await administrators(ada, ed);
    const general = await createRoom("general");
    const message = await written(grace, general.id, "Cheap watches");
    await reported(reportMessage(linus, general.id, message.id));
    await reported(reportMessage(joan, general.id, message.id, { reason: "other", note: "Odd" }));
    const [joans, linuss] = (await reportsFor(ada)).open;
    const edsTab = await openWorkspaceSocket(ed);

    const closed = await closedBy(handle(ada, linuss!.id, "dismissed"));
    expect(closed).toEqual([handledAs(linuss!, ada, "dismissed")]);
    expect(await nextOpenReports(edsTab)).toBe(1);
    expect(await reportsFor(ed)).toEqual({ open: [joans], handled: closed });
    expect(await roomSql(general.id, "SELECT deleted FROM messages WHERE id = ?", message.id)).toEqual([{ deleted: 0 }]);

    await refused(handle(ed, linuss!.id, "deleted"), 409, "Another administrator has handled that report");
    expect((await reportsFor(ed)).handled).toEqual(closed);
  });

  it("deletes a reported message for everyone, closing every open report of it and no other", async () => {
    const [ada, grace, linus, joan] = await people("Ada", "Grace", "Linus", "Joan");
    await administrators(ada);
    const general = await createRoom("general");
    const reportedTwice = await written(grace, general.id, "Cheap watches");
    const reportedOnce = await written(grace, general.id, "Cheap rings");
    await reported(reportMessage(linus, general.id, reportedTwice.id));
    await reported(reportMessage(joan, general.id, reportedTwice.id));
    await reported(reportMessage(linus, general.id, reportedOnce.id));
    await reported(reportPerson(linus, grace.user.id));
    const [ofGrace, ofTheOther, ...ofTheMessage] = (await reportsFor(ada)).open;
    const joans = await connect(general.id, joan);

    expect(await closedBy(handle(ada, ofTheMessage[1]!.id, "deleted"))).toEqual(ofTheMessage.toSorted((a, b) => a.id.localeCompare(b.id)).map((report) => handledAs(report, ada, "deleted")));
    expect((await joans.next("message.deleted")).messageId).toBe(reportedTwice.id);
    expect((await reportsFor(ada)).open).toEqual([ofGrace, ofTheOther]);
  });

  it("removes or bans whoever a report is of, closing every open report of them and of their messages", async () => {
    const [ada, grace, linus, joan] = await people("Ada", "Grace", "Linus", "Joan");
    await administrators(ada);
    const general = await createRoom("general");
    const graces = await written(grace, general.id, "Cheap watches");
    const linuss = await written(linus, general.id, "Cheap rings");
    await reported(reportMessage(linus, general.id, graces.id));
    await reported(reportPerson(joan, grace.user.id));
    await reported(reportMessage(joan, general.id, linuss.id));
    await reported(reportPerson(joan, linus.user.id));
    const [ofLinus, ofLinussMessage, ofGrace, ofGracesMessage] = (await reportsFor(ada)).open;

    expect(await closedBy(handle(ada, ofGracesMessage!.id, "removed"))).toEqual([ofGracesMessage!, ofGrace!].toSorted((a, b) => a.id.localeCompare(b.id)).map((report) => handledAs(report, ada, "removed")));
    expect(await workspaceSql("SELECT status FROM users WHERE id = ?", grace.user.id)).toEqual([{ status: 1 }]);
    expect((await reportsFor(ada)).open).toEqual([ofLinus, ofLinussMessage]);

    // A ban answers as Ban does when it can't block where they signed in from, closing nothing.
    await workspaceSql("UPDATE sessions SET ip_address = '10.0.0.1' WHERE user_id = ?", linus.user.id);
    await refused(handle(ada, ofLinus!.id, "banned"), 422, "They signed in from a private or internal IP address, which a ban can't block");
    expect((await reportsFor(ada)).open).toEqual([ofLinus, ofLinussMessage]);
    await workspaceSql("UPDATE sessions SET ip_address = '203.0.113.7' WHERE user_id = ?", linus.user.id);
    expect(await closedBy(handle(ada, ofLinus!.id, "banned"))).toEqual([ofLinus!, ofLinussMessage!].toSorted((a, b) => a.id.localeCompare(b.id)).map((report) => handledAs(report, ada, "banned")));
    expect(await workspaceSql("SELECT status FROM users WHERE id = ?", linus.user.id)).toEqual([{ status: 2 }]);
    expect(await workspaceSql("SELECT ip_address FROM bans WHERE user_id = ?", linus.user.id)).toEqual([{ ip_address: "203.0.113.7" }]);
  });

  it("lets only an administrator handle a report, delete only a message's, and remove or ban only someone Remove or Ban can", async () => {
    const [ada, ed, grace, linus] = await people("Ada", "Ed", "Grace", "Linus");
    await administrators(ada, ed);
    await reported(reportPerson(linus, grace.user.id));
    await reported(reportPerson(grace, ada.user.id));
    const [ofAda, ofGrace] = (await reportsFor(ed)).open;

    await refused(handle(grace, ofGrace!.id, "dismissed"), 403, "Only administrators can handle reports");
    expect((await api(`/api/reports/${ofGrace!.id}`, { method: "POST", body: JSON.stringify({ outcome: "dismissed" }) })).status).toBe(401);
    await refused(handle(ada, ofGrace!.id, "ignored"), 422, "Delete the message, remove or ban whoever it reports, or dismiss the report");
    await refused(handle(ada, ofGrace!.id, "deleted"), 422, "Only a message's report can delete it");
    expect((await handle(ada, "nothing", "dismissed")).status).toBe(404);
    // Nor is an administrator shown a report of themselves, which another can handle.
    expect((await handle(ada, ofAda!.id, "dismissed")).status).toBe(404);
    expect(await closedBy(handle(ed, ofAda!.id, "dismissed"))).toEqual([handledAs(ofAda!, ed, "dismissed")]);

    await workspaceSql("UPDATE users SET status = 1 WHERE id = ?", grace.user.id);
    await refused(handle(ada, ofGrace!.id, "removed"), 422, "They can't be removed");
    expect((await reportsFor(ada)).open).toEqual([ofGrace]);
  });

  it("reads reports through their indexes", async () => {
    const plans = await Promise.all(
      (
        [
          [KEEP_MESSAGE_REPORT, "r", "a", "b", "room", "m", "{}", "spam", "", "now"],
          [KEEP_PERSON_REPORT, "r", "a", "b", "{}", "spam", "", "now"],
          [OPEN_REPORTS_BY_ADMINISTRATOR],
          [OPEN_REPORTS_OF_ADMINISTRATOR, "a"],
          [REPORT_PUSHES, "a", "b"],
          [OPEN_REPORTS, "a"],
          [HANDLED_REPORTS, "a"],
          [CLOSE_MESSAGE_REPORTS, "room", "m", "a", "now"],
          [CLOSE_PERSON_REPORTS, "b", "a", "now", "removed"],
        ] as const
      ).map(async ([query, ...params]) => ((await workspaceSql(`EXPLAIN QUERY PLAN ${query}`, ...params)) as Array<{ detail: string }>).map(({ detail }) => detail).join("; ")),
    );
    for (const plan of plans) expect(plan).not.toMatch(/SCAN reports\b/);
    expect(plans[0]).toContain("index_reports_on_message_id (message_id=?)");
    expect(plans[1]).toContain("index_reports_on_subject_id (subject_id=?)");
    for (const plan of [plans[2], plans[3], plans[5]]) expect(plan).toContain("index_reports_on_handled_at_and_created_at (handled_at=?)");
    expect(plans[6]).toContain("index_reports_on_handled_at_and_created_at (handled_at>?)");
    expect(plans[7]).toContain("index_reports_on_message_id (message_id=?)");
    expect(plans[8]).toContain("index_reports_on_subject_id (subject_id=?)");
  });
});
