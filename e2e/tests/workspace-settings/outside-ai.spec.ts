import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { PROFILE_PATH } from "@ember/protocol";
import { administratorSession, cookieHeader, expect, newAddress, SAME_ORIGIN, signInAsAdministrator, test, useOwnAddress } from "../../fixtures";

// Outside AI: the card on the AI assistant tab whose switch lets AI apps connect, the page that asks
// someone whether to connect one as them, what a connected app can ask Ember, and the AI apps section of
// their profile, where they disconnect it, on the second test server. The app is this spec: it finds
// how to sign in as an app does, from what Ember says of itself, and listens on this machine for the
// browser coming back. Each test leaves the workspace as a new one is, with outside AI off.

const APP_NAME = "Field notes";

/** Where the app has the browser sent back: a page of its own on this machine. */
let app: Server;
let callback: string;
test.beforeAll(async () => {
  app = createServer((_, response) => response.setHeader("Content-Type", "text/plain").end("Back at the app"));
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  callback = `http://127.0.0.1:${(app.address() as AddressInfo).port}/callback`;
});
test.afterAll(() => new Promise((resolve) => app.close(resolve)));
test.afterEach(async ({ request }) => {
  const headers = { Cookie: cookieHeader(await administratorSession(request)), ...SAME_ORIGIN };
  const off = await request.put("/api/account/outside_ai", { data: { on: false }, headers });
  expect(off.status(), await off.text()).toBe(200);
});

/** Opens the AI assistant tab as the administrator, answering its Outside AI card. */
async function openOutsideAi(page: Page) {
  await useOwnAddress(page);
  await page.goto("/account/edit#assistant-settings");
  await signInAsAdministrator(page);
  return page.getByRole("region", { name: "Outside AI" });
}

/** What an app keeps while it signs in: the secret it proves itself with, and what it expects back. */
const VERIFIER = randomBytes(32).toString("base64url");
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const STATE = "kept-by-the-app";

interface SignIn {
  clientId: string;
  /** The address the app connects to, which its tokens are for. */
  resource: string;
  /** The page that asks the person, with the app's request in its address. */
  authorize: string;
  tokenEndpoint: string;
}

/** Finds how to sign in to the Ember at `address` as an app does, from a refused request on, and registers there. */
async function beginSignIn(request: APIRequestContext, address: string): Promise<SignIn> {
  const refused = await ask(request, address, null, "tools/list");
  expect(refused.status()).toBe(401);
  const [, described] = /resource_metadata="([^"]+)"/.exec(refused.headers()["www-authenticate"] ?? "") ?? [];
  const { resource, authorization_servers: [issuer] } = (await (await request.get(described!)).json()) as { resource: string; authorization_servers: string[] };
  const server = (await (await request.get(`${issuer}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
  expect(server.issuer).toBe(issuer);

  const registered = await request.post(server.registration_endpoint!, { data: { client_name: APP_NAME, redirect_uris: [callback] }, headers: { "CF-Connecting-IP": newAddress() } });
  expect(registered.status(), await registered.text()).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: callback, state: STATE, code_challenge: CHALLENGE, code_challenge_method: "S256", scope: "read", resource });
  return { clientId, resource, authorize: `${server.authorization_endpoint}?${query}`, tokenEndpoint: server.token_endpoint! };
}

/** Waits for the browser to come back to the app, answering what it came back with. */
async function cameBack(page: Page): Promise<URLSearchParams> {
  await page.waitForURL((url) => url.href.startsWith(callback));
  await expect(page.getByText("Back at the app")).toBeVisible();
  return new URL(page.url()).searchParams;
}

/** Asks the Ember at `address` `method` over the protocol, as an app with `token`, or with none. */
function ask(request: APIRequestContext, address: string, token: string | null, method: string, params: Record<string, unknown> = {}): Promise<APIResponse> {
  return request.post(address, {
    headers: { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...(token !== null && { Authorization: `Bearer ${token}` }) },
    data: { jsonrpc: "2.0", id: 1, method, params },
  });
}

/** The rooms Ember lists for the app that asks with `token`. */
async function roomsFor(request: APIRequestContext, address: string, token: string): Promise<Array<{ kind: string; name: string }>> {
  const response = await ask(request, address, token, "tools/call", { name: "list_rooms", arguments: {} });
  expect(response.status(), await response.text()).toBe(200);
  const text = await response.text();
  const sent = response.headers()["content-type"]?.includes("event-stream") ? text.split("\n").find((line) => line.startsWith("data: "))!.slice(6) : text;
  const { result } = JSON.parse(sent) as { result: { content: [{ text: string }] } };
  return (JSON.parse(result.content[0].text) as { rooms: Array<{ kind: string; name: string }> }).rooms;
}

test.describe("Outside AI", () => {
  test("an administrator lets AI apps connect, someone allows one, which lists their rooms until they disconnect it on their profile", async ({ page, request, baseURL }) => {
    const address = `${baseURL}/mcp`;
    // Until an administrator turns it on, nothing answers an app.
    expect((await ask(request, address, null, "tools/list")).status()).toBe(404);

    const card = await openOutsideAi(page);
    const outsideSwitch = card.getByRole("switch", { name: "Let AI apps connect to Ember" });
    await expect(outsideSwitch).not.toBeChecked();
    await outsideSwitch.click();
    await expect(outsideSwitch).toBeChecked();
    await expect(card).toContainText(address);

    const signIn = await beginSignIn(request, address);
    expect(signIn.resource).toBe(address);
    await page.goto(signIn.authorize);
    await expect(page).toHaveTitle(/Connect an AI app/);
    await expect(page.getByRole("heading", { level: 1, name: new RegExp(`^Connect ${APP_NAME} to .+\\?$`) })).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveText(["See the rooms you're in, read their messages and search them, as you can"]);
    await expect(page.getByText(`You'll go back to ${new URL(callback).host}.`)).toBeVisible();
    await page.getByRole("button", { name: "Allow", exact: true }).click();

    const back = await cameBack(page);
    expect(back.get("state")).toBe(STATE);
    expect(back.get("iss")).toBe(baseURL);
    const exchanged = await request.post(signIn.tokenEndpoint, {
      form: { grant_type: "authorization_code", client_id: signIn.clientId, code: back.get("code")!, code_verifier: VERIFIER, redirect_uri: callback, resource: signIn.resource },
    });
    expect(exchanged.status(), await exchanged.text()).toBe(200);
    const { access_token: token } = (await exchanged.json()) as { access_token: string };

    // The app sees the rooms the person who allowed it is in, which their sidebar lists.
    const rooms = await roomsFor(request, address, token);
    const listed = rooms.find(({ kind }) => kind !== "direct")!;
    await page.goto("/");
    await expect(page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: listed.name }).first()).toBeVisible();

    // Their profile lists it, and Disconnect ends what it was given.
    await page.goto(PROFILE_PATH);
    const apps = page.getByRole("region", { name: "AI apps" });
    await expect(apps.getByRole("textbox", { name: "The address to give an AI app" })).toHaveValue(address);
    await expect(apps.getByRole("listitem")).toContainText([APP_NAME]);
    await expect(apps.getByRole("listitem")).toContainText([`From ${new URL(callback).host}`]);
    await apps.getByRole("button", { name: `Disconnect ${APP_NAME}` }).click();
    await expect(page.getByText(`${APP_NAME} is disconnected. It can't read Ember as you any more.`)).toBeVisible();
    await expect(apps).toContainText("No AI app is connected as you.");
    expect((await ask(request, address, token, "tools/list")).status()).toBe(401);

    // Turning it off asks first, and then nothing answers an app again.
    await page.goto("/account/edit#assistant-settings");
    page.once("dialog", (dialog) => void dialog.accept());
    await outsideSwitch.click();
    await expect(outsideSwitch).not.toBeChecked();
    await expect(card).not.toContainText(address);
    expect((await ask(request, address, null, "tools/list")).status()).toBe(404);
    await page.goto(PROFILE_PATH);
    await expect(page.getByLabel("Name", { exact: true })).toBeEnabled();
    await expect(page.getByRole("region", { name: "AI apps" })).toHaveCount(0);
  });

  test("someone signed out signs in first and comes back to the app's request, and Don't allow goes back to the app with nothing", async ({ page, request, baseURL }) => {
    const headers = { Cookie: cookieHeader(await administratorSession(request)), ...SAME_ORIGIN };
    expect((await request.put("/api/account/outside_ai", { data: { on: true }, headers })).status()).toBe(200);
    const signIn = await beginSignIn(request, `${baseURL}/mcp`);

    await useOwnAddress(page);
    await page.goto(signIn.authorize);
    await expect(page).toHaveURL(/\/session\/new$/);
    await signInAsAdministrator(page);
    await expect(page.getByRole("heading", { level: 1, name: new RegExp(`^Connect ${APP_NAME} to .+\\?$`) })).toBeVisible();
    await page.getByRole("button", { name: "Don't allow" }).click();

    const back = await cameBack(page);
    expect(back.get("error")).toBe("access_denied");
    expect(back.get("code")).toBeNull();
    expect(back.get("state")).toBe(STATE);
    await page.goto(PROFILE_PATH);
    await expect(page.getByRole("region", { name: "AI apps" })).toContainText("No AI app is connected as you.");
  });
});
