import { MAX_CUSTOM_STYLES_LENGTH, type Account, type Bootstrap, type CustomStyles, type NewWorkspace, type WorkspaceSettings } from "@ember/protocol";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../src/workspace";
import type { WorkspaceStore } from "../src/workspace-store";
import { api, cookieOf, freshDeploy, openWorkspaceSocket, shown, signIn, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

const customStyles = (session: Session | null) => api("/api/account/custom_styles", { headers: as(session) });

const save = (session: Session | null, body: unknown, headers: Record<string, string> = {}) =>
  api("/api/account/custom_styles", {
    method: "PATCH",
    headers: { ...as(session), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const bootstrap = async (session?: Session) => (await (await api("/api/bootstrap", { headers: as(session) })).json()) as Bootstrap;

const stored = async () => ((await workspaceSql("SELECT custom_styles, updated_at FROM accounts")) as Array<{ custom_styles: string | null; updated_at: string }>)[0]!;

/** The workspace as pages show it with `customStyles`. */
const styled = (customStyles: string): Account => ({ name: "Ember", tagline: "", hideTranslationButtons: true, customStyles, restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true });

/** CSS as an administrator might type it, with what would end an unescaped `<style>`. */
const CSS = ".mb-app { --mb-ink: rebeccapurple; }\n</style><script>alert(1)</script>\n";

beforeEach(freshDeploy);

describe("Custom CSS", () => {
  it("gives administrators the workspace's CSS, which is empty until it's saved", async () => {
    const administrator = await setUp();
    const response = await customStyles(administrator);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ customStyles: "" } satisfies CustomStyles);
  });

  it("saves CSS as typed for an administrator, for every page to apply", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");

    const response = await save(administrator, { customStyles: CSS });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: styled(CSS) });
    expect((await stored()).custom_styles).toBe(CSS);
    expect(await (await customStyles(administrator)).json()).toEqual({ customStyles: CSS });
    // Signed out too, for sign-in and join.
    expect((await bootstrap()).account).toEqual(styled(CSS));
    expect((await bootstrap(grace)).account).toEqual(styled(CSS));
    expect(((await (await api("/api/account", { headers: as(grace) })).json()) as WorkspaceSettings).account).toEqual(styled(CSS));
  });

  it("saves blank CSS too, recording when only once the CSS changes", async () => {
    const administrator = await setUp();
    const long = "2026-01-01T00:00:00.000Z";
    await workspaceSql("UPDATE accounts SET updated_at = ?", long);

    for (const body of [{ customStyles: "" }, {}]) {
      const response = await save(administrator, body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ account: styled("") });
      expect(await stored()).toEqual({ custom_styles: null, updated_at: long });
    }

    await save(administrator, { customStyles: CSS });
    expect((await stored()).updated_at > long).toBe(true);
    expect(await (await save(administrator, { customStyles: "" })).json()).toEqual({ account: styled("") });
    expect((await stored()).custom_styles).toBe("");
    expect((await bootstrap()).account).toEqual(styled(""));
  });

  it("takes as much CSS as there's room for, and tells every socket all of it", async () => {
    const administrator = await setUp();
    const socket = await openWorkspaceSocket(administrator);
    const most = "é".repeat(MAX_CUSTOM_STYLES_LENGTH);
    expect((await save(administrator, { customStyles: most })).status).toBe(200);
    expect((await stored()).custom_styles).toBe(most);
    expect(await socket.next()).toEqual({ type: "account.updated", account: styled(most) });
  });

  it("tells everyone's workspace sockets once it changes", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace)];

    await save(administrator, { customStyles: "" });
    await save(administrator, { customStyles: CSS });
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "account.updated", account: styled(CSS) });
  });

  it("welcomes sockets that connect later with it, as a tab that was without one needs", async () => {
    const administrator = await setUp();
    await save(administrator, { customStyles: CSS });
    expect((await openWorkspaceSocket(await signIn("Grace"))).welcome).toEqual({
      type: "welcome",
      you: expect.objectContaining({ name: "Grace" }),
      account: styled(CSS),
    });
  });

  it("lets only administrators see or save it, and tells anyone else so before looking at what they sent", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");

    const refused = await customStyles(grace);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Only administrators can change the workspace" });
    for (const body of [{ customStyles: CSS }, "not JSON", { customStyles: 7 }]) {
      const response = await save(grace, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators can change the workspace" });
    }
    expect((await stored()).custom_styles).toBeNull();

    // As they are when they ask.
    await workspaceSql("UPDATE users SET role = 0 WHERE id = ?", administrator.user.id);
    expect((await customStyles(administrator)).status).toBe(403);
    expect((await save(administrator, { customStyles: CSS })).status).toBe(403);
    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", grace.user.id);
    expect((await customStyles(grace)).status).toBe(200);
    expect((await save(grace, { customStyles: CSS })).status).toBe(200);
  });

  it("asks who's signed in, and refuses CSS sent from another site", async () => {
    const administrator = await setUp();
    expect((await customStyles(null)).status).toBe(401);
    expect((await save(null, { customStyles: CSS })).status).toBe(401);
    expect((await save(administrator, { customStyles: CSS }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(422);
    expect((await stored()).custom_styles).toBeNull();
  });

  it.each([
    ["no body", "", "Expected a JSON object"],
    ["a list", [], "Expected a JSON object"],
    ["CSS that isn't text", { customStyles: ["body {}"] }, "Custom CSS must be at most 100,000 characters"],
    ["CSS that's too long", { customStyles: "x".repeat(MAX_CUSTOM_STYLES_LENGTH + 1) }, "Custom CSS must be at most 100,000 characters"],
  ])("refuses %s, changing nothing", async (_, body, error) => {
    const administrator = await setUp();
    const response = await save(administrator, body);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error });
    expect((await stored()).custom_styles).toBeNull();
  });

  it("answers only reading and saving it", async () => {
    const administrator = await setUp();
    for (const method of ["PUT", "POST", "DELETE"]) {
      expect((await api("/api/account/custom_styles", { method, headers: as(administrator), body: JSON.stringify({ customStyles: CSS }) })).status).toBe(404);
    }
    expect((await stored()).custom_styles).toBeNull();
  });

  it("reads the CSS again after a save whose answer was lost", async () => {
    const administrator = await setUp();
    expect((await bootstrap()).account).toEqual(styled(""));
    // On D1 a write can be saved and its answer lost on the way back.
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const change = store.changeCustomStyles.bind(store);
      vi.spyOn(store, "changeCustomStyles").mockImplementationOnce(async (...args) => {
        await change(...args);
        throw new Error("The database's answer was lost");
      });
    });
    expect((await save(administrator, { customStyles: CSS })).status).toBe(500);
    expect((await bootstrap()).account).toEqual(styled(CSS));
  });
});
